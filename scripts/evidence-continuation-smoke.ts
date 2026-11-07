#!/usr/bin/env bun
/**
 * Offline continuation smoke: real createOptChat lifecycle and registered tool execution through
 * the existing fake ExtensionAPI host. No CLI install, model transport, credentials or live stores.
 *
 * Run: bun scripts/evidence-continuation-smoke.ts
 * Expected: one JSON object with ok:true, evidence:"synthetic/fake-host/plugin-lifecycle",
 * providerAttempts:0 and named checks; exit 0. Assertions/cleanup failures print ok:false and exit 1.
 * This does not attest installed-host discovery, SDK input-schema validation, or model quality.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createOptChat } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { isRecord } from "../src/type-guards.ts";
import { openFakeHost, type FakeHost, type FakeHostOptions, type HostMessage } from "../tests/helpers/fake-host.ts";
// Unlike ALL_GATES_OFF (the legacy memory-only harness), leave the new deterministic read gates on.
const MODEL_GATES_OFF = {
  "no-optchat-rules": true,
  "no-optchat-prefetch": true,
  "no-optchat-value-score": true,
  "no-optchat-recall": true,
  "no-optchat-extract": true,
};

const EVIDENCE = "synthetic/fake-host/plugin-lifecycle";
const FIXTURE_DATE = new Date("2026-01-02T03:04:05.000Z");
const DECISIONS = [
  "Use port 5432 for staging.",
  "Change staging to 6543.",
  "Revert it to 5432.",
  "Yesterday's failed attempt used 6543.",
];
const REPORT = `Amber café migration: checksum ae17.\n${"Synthetic archived finding: the old connection was closed.\n".repeat(24)}AMBER-REPORT-END`;
const EXTERNAL = "Alpine café release 23.4.3 uses socket port 7123; external fixture only.";
const UNLISTED = "Alpine café UNLISTED-STORE-MUST-NOT-APPEAR uses port 9999.";
const LATER_EXTERNAL = "Alpine café AFTER-EXTERNAL-SNAPSHOT uses socket port 8123.";
const LATER_PARENT = "Amber AFTER-CHILD-SNAPSHOT was recorded only after delegation.";
const checks: string[] = [];
let phase = "setup";
let providerAttempts = 0;
let toolCalls = 0;

function object(value: unknown, label: string): Record<string, unknown> {
  assert(isRecord(value), `${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
}

function integer(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative integer`);
  return value;
}

function text(value: unknown, label: string): string {
  assert(typeof value === "string", `${label} must be text`);
  return value;
}

function forbidProvider(): never {
  providerAttempts++;
  throw new Error("Continuation smoke must not invoke a compressor, judge or extractor");
}

/** Enforce the real host's duplicate-registration rule; expose the actual registered active tools. */
function extension(): (pi: ExtensionAPI) => void {
  const install = createOptChat({ admitCompressorCall: forbidProvider, judge: forbidProvider, extractor: forbidProvider });
  return (pi) => {
    const registered = new Set<string>();
    install(new Proxy(pi, {
      get(target, key) {
        if (key === "registerTool") return (tool: { name: string }) => {
          assert(!registered.has(tool.name), `duplicate tool registration: ${tool.name}`);
          registered.add(tool.name);
          return Reflect.apply(target.registerTool, target, [tool]);
        };
        if (key === "getAllTools") return () => [...target.getAllTools(), ...[...registered].map((name) => ({ name }))];
        if (key === "getActiveTools") return () => [...registered];
        return Reflect.get(target, key);
      },
    }));
  };
}

async function invoke(host: FakeHost, name: string, input: Record<string, unknown>): Promise<string> {
  const tool = host.tools.get(name);
  assert(tool, `${name} must be registered by the plugin's session_start`);
  const result = await tool.execute(`continuation-${++toolCalls}`, input, undefined, undefined, host.ctx);
  return result.content.map((part) => part.text ?? "").join("\n");
}

/** Same context -> message_end -> agent_end path as the existing fake-host integration tests. */
async function turn(host: FakeHost, prior: HostMessage[], prompt: string, reply = "noted"): Promise<HostMessage[]> {
  await host.fire("before_agent_start", { systemPrompt: ["Synthetic smoke host."], prompt });
  const messages = [...prior, host.user(prompt)];
  await host.context(messages);
  const response = host.assistant(reply);
  await host.fire("message_end", { message: response });
  const done = [...messages, response];
  await host.fire("agent_end", { messages: done, willContinue: false });
  assert.equal(host.aborts, 0, "the plugin must not refuse a synthetic fixture turn");
  return done;
}

/** Read committed rows without opening a competing writer lease on the active chat. */
async function rows(directory: string): Promise<Map<number, { kind: string; text: string; digest: string }>> {
  const result = new Map<number, { kind: string; text: string; digest: string }>();
  for (const name of (await readdir(join(directory, "main"))).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const contents = await readFile(join(directory, "main", name), "utf8");
    assert(contents.endsWith("\n"), "fixture messages must be durably newline-terminated");
    for (const line of contents.trimEnd().split("\n")) {
      if (!line) continue;
      const row = object(JSON.parse(line), "durable row");
      const id = integer(row.i, "durable id");
      assert(!result.has(id), "durable ids must not repeat");
      result.set(id, {
        kind: text(row.kind, "durable kind"), text: text(row.text, "durable text"),
        digest: createHash("sha256").update(line).digest("hex"),
      });
    }
  }
  return result;
}

async function assertLocalCitation(host: FakeHost, id: number, offset: number, end: number, excerpt: string): Promise<void> {
  const row = (await rows(host.directory)).get(id);
  assert(row, `cited local message ${id} must exist`);
  const bytes = Buffer.from(row.text);
  assert(offset <= end && end <= bytes.length, "citation must stay inside its original message");
  assert.equal(bytes.subarray(offset, end).toString("utf8"), excerpt, "citation must reproduce exact UTF-8 source bytes");
  const reopened = await invoke(host, "zoom", { id, n: 1, offset });
  assert(reopened.startsWith(excerpt), "registered zoom must reopen the cited passage");
}

async function assertDecisionCitations(host: FakeHost, result: string): Promise<number> {
  const pattern = /source (\w+), bytes (\d+)-(\d+) of (\d+); zoom\((\d+), 1, (\d+)\) reopens it\n/g;
  let count = 0;
  const originals = await rows(host.directory);
  for (const match of result.matchAll(pattern)) {
    const [kind, start, end, total, id, offset] = match.slice(1);
    assert.equal(start, offset, "decision reopening offset must match its byte citation");
    const row = originals.get(Number(id));
    assert(row, "decision citation must name an original row");
    assert.equal(row.kind, kind, "decision authority must preserve the stored source kind");
    assert.equal(Buffer.byteLength(row.text), Number(total));
    const excerpt = Buffer.from(row.text).subarray(Number(start), Number(end)).toString("utf8");
    assert(result.slice(match.index! + match[0].length).startsWith(excerpt), "rendered decision evidence must equal source bytes");
    await assertLocalCitation(host, Number(id), Number(start), Number(end), excerpt);
    count++;
  }
  assert(count >= 4, "decision timeline must cite the decisions, correction and historical mention");
  return count;
}

/** Fixture setup only. Retrieval itself always runs a plugin-registered tool, never a helper. */
async function appendFixture(directory: string, value: string): Promise<void> {
  const store = await Store.open(directory);
  try { store.append("user", value, FIXTURE_DATE); }
  finally { await store.close(); }
}

async function fileDigests(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) { result[`${key}/`] = "directory"; await visit(join(path, entry.name), `${key}/`); }
      else {
        assert(entry.isFile(), "smoke fixture trees contain no links or special files");
        result[key] = createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex");
      }
    }
  }
  await visit(directory, "");
  return result;
}

function externalReopen(result: string): Record<string, unknown> {
  const calls = [...result.matchAll(/^reopen: chat_project_evidence\((\{[^\n]+\})\)$/gm)];
  assert.equal(calls.length, 1, "the selected external fixture must have exactly one cited passage");
  return object(JSON.parse(calls[0]![1]!), "external reopening call");
}

async function main(): Promise<Record<string, unknown>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "optchat-evidence-continuation-")));
  const hosts: FakeHost[] = [];
  const priorMetrics = process.env.OPTCHAT_METRICS_FILE;
  // A developer's inherited metrics override must never redirect even fixture writes to a live file.
  process.env.OPTCHAT_METRICS_FILE = join(root, "metrics.jsonl");
  async function open(name: string, options: FakeHostOptions = {}): Promise<FakeHost> {
    const host = await openFakeHost(extension(), {
      ...options,
      directory: join(root, name),
      flags: { ...MODEL_GATES_OFF, "optchat-node-bytes": "65536", "optchat-view-bytes": "1048576", ...options.flags },
    });
    hosts.push(host);
    return host;
  }
  try {
    phase = "default registration and opt-outs";
    const defaultHost = await open("default");
    for (const name of ["chat_decisions", "chat_work"]) assert(defaultHost.tools.has(name), `${name} is enabled by default`);
    assert(!defaultHost.tools.has("chat_project_evidence"), "no external stores are exposed without an explicit allowlist");
    await assert.rejects(invoke(defaultHost, "chat_project_evidence", { question: "alpine" }), /must be registered/);
    await defaultHost.shutdown();
    const optedOut = await open("opted-out", { flags: {
      "optchat-decisions": true, "no-optchat-decisions": true,
      "optchat-work-discovery": true, "no-optchat-work-discovery": true,
    } });
    assert(!optedOut.tools.has("chat_decisions") && !optedOut.tools.has("chat_work"), "explicit opt-outs win over enabling flags");
    assert(optedOut.tools.has("zoom") && optedOut.tools.has("chat_evidence"), "opt-outs preserve the ordinary read tools");
    await optedOut.shutdown();
    checks.push("default registration, explicit opt-outs, no ambient external discovery");

    const external = join(root, "external-allowlisted");
    const unlisted = join(root, "external-unlisted");
    await appendFixture(external, EXTERNAL);
    await appendFixture(unlisted, UNLISTED);
    const unlistedBefore = await fileDigests(unlisted);
    let externalBefore = await fileDigests(external);
    const manager = {};
    const host = await open("main", {
      artifactManager: manager,
      confirm: () => true,
      flags: { "optchat-project-stores": JSON.stringify({ archive: external }) },
    });
    for (const name of ["chat_decisions", "chat_work", "chat_project_evidence"]) {
      const registration = object(host.tools.get(name), `${name} registration`);
      assert.equal(registration.approval, "read", `${name} must register as read-only`);
      assert.equal(registration.loadMode, "essential", `${name} must be discoverable without deferred loading`);
    }

    phase = "decision history and exact citations";
    let transcript: HostMessage[] = [];
    for (const [index, prompt] of DECISIONS.entries()) {
      transcript = await turn(host, transcript, prompt, index === DECISIONS.length - 1 ? "Reported complete staging: tests-green" : "noted");
    }
    const decisionState = await invoke(host, "chat_decisions", { question: "staging", mode: "project-state" });
    assert.match(decisionState, /staging: accepted "5432"/);
    assert.match(decisionState, /message 0: superseded/);
    assert.match(decisionState, /message 2: superseded/);
    assert.match(decisionState, /message 4: accepted/);
    assert.match(decisionState, /message 7: reported-complete/);
    assert.match(decisionState, /observed: none/);
    assert.match(decisionState, /\[scan complete:/);
    const citationCount = await assertDecisionCitations(host, decisionState);
    const timeline = await invoke(host, "chat_decisions", { question: "staging", mode: "timeline" });
    assert(timeline.startsWith("[optchat decisions] timeline:"));
    assert(timeline.indexOf("message 0:") < timeline.indexOf("message 4:"), "timeline preserves correction order");
    checks.push("decision supersession/revert, reported versus observed completion, exact zoom citations");

    phase = "captured task report discovery";
    const user = host.user("Collect both synthetic migration reports.");
    await host.context([...transcript, user]);
    const call = host.assistant("", { id: "capture-task", name: "task", arguments: { task: "Review migration" } });
    const delivery = {
      ...host.toolResult("capture-task", "task", "two synthetic reports"),
      details: { results: [
        { id: "amber-agent", agent: "SmokeReporter", output: REPORT, exitCode: 0, durationMs: 1, truncated: false },
        { id: "blue-agent", agent: "SmokeReporter", output: "Blue migration report: pending review.", exitCode: 0, durationMs: 1, truncated: false },
      ] },
    };
    await host.fire("message_end", { message: call });
    await host.fire("message_end", { message: delivery });
    transcript = [...transcript, user, call, delivery, host.assistant("Reports captured.")];
    await host.fire("agent_end", { messages: transcript, willContinue: false });
    const discovery = await invoke(host, "chat_work", { question: "amber café", name: "amber-agent" });
    assert(discovery.startsWith("[optchat work]\n"));
    const found = object(JSON.parse(discovery.slice(discovery.indexOf("\n") + 1)), "work discovery");
    const captures = array(found.captures, "work captures");
    assert.equal(captures.length, 1, "exact agent identity selects one report even when names repeat");
    const capture = object(captures[0], "captured work");
    assert.equal(capture.completeness, "full");
    const identities = object(capture.identities, "work identities");
    assert.equal(identities.agentId, "amber-agent");
    assert.equal(identities.name, "SmokeReporter");
    for (const field of ["callId", "runId", "reportId"]) assert.equal(identities[field], null, `${field} must not be invented from report prose`);
    const report = object(capture.report, "report passage");
    await assertLocalCitation(host, integer(report.messageId, "report id"), integer(report.offset, "report offset"), integer(report.end, "report end"), text(report.text, "report excerpt"));
    const sourceCall = object(capture.call, "associated task invocation");
    assert.equal(sourceCall.tool, "task");
    assert.equal(capture.originalTaskOrCommand, sourceCall.messageId);
    await assertLocalCitation(host, integer(sourceCall.messageId, "call id"), integer(sourceCall.offset, "call offset"), integer(sourceCall.end, "call end"), text(sourceCall.text, "call excerpt"));
    const fullReport = await invoke(host, "work", { name: text(identities.agentId, "recorded agent id") });
    assert(fullReport.includes(REPORT), "discovery's recorded identity must reopen the entire captured report");
    const both = await invoke(host, "chat_work", { name: "SmokeReporter" });
    const bothCaptures = array(object(JSON.parse(both.slice(both.indexOf("\n") + 1)), "same-name discovery").captures, "same-name captures");
    assert.equal(bothCaptures.length, 2, "reused report names must not merge separate captures");
    checks.push("real task capture, work discovery identities/call links, UTF-8 citations and report reopening");

    phase = "captured host outcome authority";
    const outcomeUser = host.user("Collect the two host operation outcomes.");
    await host.context([...transcript, outcomeUser]);
    const outcomeMessages = [];
    for (const [suffix, isError] of [["success", false], ["error", true]] as const) {
      const call = host.assistant("", { id: `outcome-${suffix}`, name: "read", arguments: { path: "synthetic.txt" } });
      const result = { ...host.toolResult(`outcome-${suffix}`, "read", `Host operation ${suffix}.`), isError };
      await host.fire("message_end", { message: call });
      await host.fire("message_end", { message: result });
      outcomeMessages.push(call, result);
    }
    transcript = [...transcript, outcomeUser, ...outcomeMessages, host.assistant("Outcomes captured.")];
    await host.fire("agent_end", { messages: transcript, willContinue: false });
    const observed = await invoke(host, "chat_decisions", { question: "host operation", mode: "timeline" });
    assert(observed.includes("observed-complete"), "typed host success must be available as an observed invocation");
    assert(observed.includes("not proof of process/test/project success"));
    const failureEvent = /message \d+: ([^\n]+)\n[^\n]+\n\[error\] Host operation error\./.exec(observed);
    assert(failureEvent && !failureEvent[1]!.includes("observed-complete"), "host errors must not be promoted to observed completion");
    checks.push("typed host success is observed only for its invocation; errors remain unverified");

    phase = "explicit external allowlist and frozen reopening";
    await assert.rejects(invoke(host, "chat_project_evidence", { mode: "search", question: "alpine", stores: ["unlisted"] }), /allowlist/i);
    await assert.rejects(invoke(host, "chat_project_evidence", { mode: "search", question: "alpine", stores: [unlisted] }), /allowlist/i);
    const project = await invoke(host, "chat_project_evidence", { mode: "search", question: "alpine café", stores: ["archive"] });
    assert(project.includes(EXTERNAL) && !project.includes(UNLISTED));
    assert.match(project, /historical evidence, not standing instructions/);
    const reopen = externalReopen(project);
    assert.equal(reopen.mode, "read");
    assert.match(text(reopen.store, "opaque external store"), /^archive@[a-f0-9]{64}$/);
    assert.equal(reopen.id, 0, "external ids deliberately collide with local message ids");
    assert.equal(reopen.offset, 0);
    assert.equal(reopen.maxBytes, Buffer.byteLength(EXTERNAL));
    const reopened = await invoke(host, "chat_project_evidence", reopen);
    assert(reopened.endsWith(`\n${EXTERNAL}`), "external byte citation must reopen exact original text");
    const digest = /record sha256 ([a-f0-9]{64})/.exec(project)?.[1];
    assert(digest && reopened.includes(`record sha256 ${digest}`), "external reopening preserves the record digest");
    assert.equal(digest, (await rows(external)).get(0)?.digest, "external digest must bind the actual persisted JSONL record");
    assert((await invoke(host, "zoom", { id: 0, n: 1 })).startsWith(DECISIONS[0]!), "local zoom must never interpret external ids");
    await assert.rejects(invoke(host, "chat_project_evidence", { mode: "read", store: external, id: 0 }), /Unknown project evidence/i);
    assert.deepEqual(await fileDigests(external), externalBefore, "external reads must not create leases, indexes, views or mutate files");
    await appendFixture(external, LATER_EXTERNAL);
    externalBefore = await fileDigests(external);
    const frozen = await invoke(host, "chat_project_evidence", { mode: "search", question: "alpine", stores: ["archive"] });
    assert(!frozen.includes(LATER_EXTERNAL), "appends after snapshot admission are outside the readable cutoff");
    await assert.rejects(invoke(host, "chat_project_evidence", { ...reopen, id: 1 }), /outside its snapshot/i);
    checks.push("explicit external allowlist, store-scoped digest citations, read-only frozen snapshot");

    phase = "child task evidence and frozen parent view";
    const child = await open("child", { agentKind: "sub", artifactManager: manager });
    await assert.rejects(stat(child.directory), { code: "ENOENT" }, "a child must not create its own store");
    const childEvent = { systemPrompt: ["Synthetic child host."], prompt: "Find the amber café migration report." };
    const childStart = object((await child.fire("before_agent_start", childEvent))[0], "child lifecycle result");
    const pack = object(childStart.message, "child task evidence message");
    assert.equal(pack.customType, "optchat-child-evidence");
    assert.equal(pack.display, false);
    const packText = text(pack.content, "child evidence pack");
    assert(packText.startsWith("[optchat child evidence]"));
    assert.match(packText, /Quoted historical parent-chat data/);
    assert(packText.toLowerCase().includes("amber") && packText.includes("zoom("), "child pack must carry task-relevant source citations");
    assert(Buffer.byteLength(packText) <= 4096, "the entire child pack is byte-bounded");
    assert(!JSON.stringify(childStart.systemPrompt).includes("[optchat child evidence]"), "task-specific evidence is not added to the static system prefix");
    transcript = await turn(host, transcript, LATER_PARENT);
    const childAgain = await child.fire("before_agent_start", { ...childEvent, prompt: "Find amber AFTER-CHILD-SNAPSHOT." });
    assert(!JSON.stringify(childAgain).includes(LATER_PARENT), "child packs must not read later parent messages");
    const childSearch = await invoke(child, "chat_search", { text: "AFTER-CHILD-SNAPSHOT" });
    assert.match(childSearch, /0 hits/);
    checks.push("per-task quoted child pack, byte bound, no child writer, frozen parent cutoff");

    phase = "reset revocation and new snapshots";
    const idle = host.ctx.isIdle;
    host.ctx.isIdle = () => true;
    try { await host.command("new"); }
    finally { host.ctx.isIdle = idle; }
    assert.equal(host.confirms.length, 1, "reset requires explicit confirmation");
    assert.equal((await rows(host.directory)).size, 0, "reset opens an empty main store");
    const resetWork = await invoke(host, "chat_work", {});
    assert.deepEqual(object(JSON.parse(resetWork.slice(resetWork.indexOf("\n") + 1)), "reset discovery").captures, []);
    const resetDecisions = await invoke(host, "chat_decisions", { question: "staging" });
    assert(!resetDecisions.includes(DECISIONS[0]!) && !resetDecisions.includes('accepted "5432"'));
    await assert.rejects(invoke(child, "zoom", { id: 0, n: 1 }), /attached|revoked|closed/i);
    assert.deepEqual(await child.fire("before_agent_start", childEvent), [undefined], "reset revokes both the old child tools and automatic pack");
    await assert.rejects(invoke(host, "chat_project_evidence", reopen));
    const freshProject = await invoke(host, "chat_project_evidence", { mode: "search", question: "AFTER-EXTERNAL-SNAPSHOT", stores: ["archive"] });
    assert(freshProject.includes(LATER_EXTERNAL), "reset must rebind external reads to a new snapshot");
    checks.push("confirmed reset, local tools rebound without duplicate registration, stale child/external revocation");

    phase = "shutdown safety and cleanup";
    await host.shutdown();
    for (const [name, input] of [
      ["chat_decisions", { question: "staging" }],
      ["chat_work", {}],
      ["chat_project_evidence", { mode: "search", question: "alpine" }],
    ] as const) await assert.rejects(invoke(host, name, input), `${name} must not read after session_shutdown`);
    const released = await Store.open(host.directory);
    await released.close();
    assert.deepEqual(await fileDigests(external), externalBefore, "external reads/reset/shutdown must leave fixture bytes unchanged");
    assert.deepEqual(await fileDigests(unlisted), unlistedBefore, "unallowlisted sibling store must remain untouched");
    assert.equal(providerAttempts, 0, "all paths are deterministic; no injected provider guard may be reached");
    checks.push("closed tool rejection, released main writer lease, unchanged external/unlisted files");
    // Print success only after every host and temporary file has been cleaned up below.
    return { ok: true, evidence: EVIDENCE, providerAttempts, toolCalls, decisionCitations: citationCount, checks };
  } finally {
    const closed = await Promise.allSettled(hosts.reverse().map((host) => host.close()));
    try { await rm(root, { recursive: true, force: true }); }
    finally {
      if (priorMetrics === undefined) delete process.env.OPTCHAT_METRICS_FILE;
      else process.env.OPTCHAT_METRICS_FILE = priorMetrics;
    }
    const failures = closed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "smoke host cleanup failed");
  }
}

try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, evidence: EVIDENCE, phase, providerAttempts, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
