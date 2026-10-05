#!/usr/bin/env bun
/** Synthetic model responses, real installed OMP CLI, extension discovery and tools. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Capture = { sequence: number; body: ObjectValue };
type DiskMessage = { i: number; kind: string; text: string; date: string };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEP_MS = 25_000;
const TOTAL_MS = 120_000;
const FIRST_USER = "OPTCHAT_SMOKE_OLD_USER: Remember the public archive, then finish.";
const SECOND_USER = "OPTCHAT_SMOKE_CURRENT_USER: Retrieve the entire previous reply and its date.";
const RESTART_USER = "OPTCHAT_SMOKE_RESTART_USER: Report that the public archive is restored.";
const LOCK_USER = "OPTCHAT_SMOKE_REJECTED_WRITER: This must never reach a model.";
const FIRST_THINKING = "OPTCHAT_SMOKE_PRIVATE_OLD_REASONING";
const TOOL_THINKING = "OPTCHAT_SMOKE_PRIVATE_ACTIVE_TOOL_REASONING";
const SUMMARY = "SYNTHETIC_SUMMARY_OLDEST_PUBLIC_FACT";
const FINISHED = "OPTCHAT_SMOKE_TOOLS_FINISHED";
const RESTORED = "OPTCHAT_SMOKE_RESTORED";
const LONG_REPLY = `OPTCHAT_SMOKE_RAW_BEGIN\n${"Public archive line; deterministic fixture only.\n".repeat(800)}OPTCHAT_SMOKE_RAW_END`;
const captures: Capture[] = [];
const hosts: Host[] = [];
let targetRecord: DiskMessage | undefined;
let retrievalSnapshot: string | undefined;
let serverFailure: Error | undefined;
let currentPhase = "setup";
const fatal = Promise.withResolvers<never>();
// Keep early server/process failures observed until the next guarded operation.
void fatal.promise.catch(() => {});

function object(value: Json | undefined, label: string): ObjectValue {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}
function messages(body: ObjectValue): ObjectValue[] {
  assert(Array.isArray(body.messages), "provider request must contain messages");
  return body.messages.map((value) => object(value, "message"));
}
function content(message: ObjectValue): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((value) => {
    const part = object(value, "content part");
    return typeof part.text === "string" ? part.text : "";
  }).join("\n");
}
function view(body: ObjectValue): string {
  const found = messages(body).flatMap((message) => [...content(message).matchAll(/<chat>([\s\S]*?)<\/chat>/g)]);
  assert.equal(found.length, 1, "request must contain exactly one settled <chat> snapshot");
  return found[0]![1]!;
}
function assertSnapshot(body: ObjectValue, current: string, previous: readonly string[]): void {
  const snapshot = view(body);
  assert(!snapshot.includes(current), "snapshot must be taken before the current user is appended");
  const requestMessages = messages(body);
  const outside: ObjectValue[] = requestMessages.map((message) => ({ ...message, content: content(message).replace(/<chat>[\s\S]*?<\/chat>/g, "").trim() }));
  assert.equal(outside.filter((message) => message.role === "user" && message.content === current).length, 1, "current user must appear exactly once");
  const snapshotIndex = requestMessages.findIndex((message) => /<chat>[\s\S]*?<\/chat>/.test(content(message)));
  const currentIndex = outside.findIndex((message) => message.role === "user" && message.content === current);
  assert(snapshotIndex <= currentIndex, "snapshot must precede the current user on the provider wire");
  if (snapshotIndex === currentIndex) {
    const text = content(requestMessages[currentIndex]!);
    assert(text.indexOf("<chat>") < text.indexOf(current), "inline snapshot must precede current user text");
  }
  for (const old of previous) assert(!JSON.stringify(outside).includes(old), "old-turn text escaped the summarized view");
  assert(!JSON.stringify(body).includes(FIRST_THINKING), "finished reasoning leaked into a new turn");
}
function assertToolNames(body: ObjectValue): void {
  assert(Array.isArray(body.tools), "host must expose actual registered tools");
  const names = body.tools.map((value) => object(object(value, "tool").function, "tool function").name);
  assert(names.includes("zoom"), "real zoom tool must be registered");
  assert(names.includes("date"), "real date tool must be registered");
}
function sse(model: string, sequence: number, text?: string, thinking?: string, calls?: Json[]): Response {
  const chunk = (delta: ObjectValue, finish: string | null = null) => `data: ${JSON.stringify({
    id: `chatcmpl-optchat-smoke-${sequence}`, object: "chat.completion.chunk", created: 1,
    model, choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  const data = [chunk({ role: "assistant" })];
  if (thinking) data.push(chunk({ reasoning_content: thinking }));
  if (text) data.push(chunk({ content: text }));
  if (calls) data.push(chunk({ tool_calls: calls }));
  data.push(chunk({}, calls ? "tool_calls" : "stop"));
  data.push(`data: ${JSON.stringify({ id: `chatcmpl-optchat-smoke-${sequence}`, object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 128, completion_tokens: 128, total_tokens: 256, completion_tokens_details: { reasoning_tokens: thinking ? 8 : 0 } } })}\n\n`);
  data.push("data: [DONE]\n\n");
  return new Response(data.join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
function answer(body: ObjectValue): Response {
  const capture = { sequence: captures.length + 1, body };
  captures.push(capture);
  assert.equal(body.stream, true, "fixture expects actual streaming adapter requests");
  const model = body.model;
  assert(typeof model === "string", "model ID required");
  if (model === "optchat-smoke-compact") {
    return sse(model, capture.sequence, SUMMARY);
  }
  assert.equal(model, "optchat-smoke-chat", "unexpected model reached fixture");
  assertToolNames(body);
  const requestMessages = messages(body);
  const current = requestMessages.filter((message) => message.role === "user").at(-1);
  assert(current, "current user required");
  // Support the host's separate snapshot message as well as prepended user-content blocks.
  const prompt = content(current).replace(/<chat>[\s\S]*?<\/chat>/g, "").trim();
  assert(requestMessages.some((message) => message.role === "system" && content(message).includes("# OptChat memory")), "plugin must append its memory protocol without replacing the host system prompt");
  if (prompt === FIRST_USER) {
    assertSnapshot(body, FIRST_USER, []);
    assert.equal(view(body).trim(), "", "fresh memory must have an empty snapshot");
    return sse(model, capture.sequence, LONG_REPLY, FIRST_THINKING);
  }
  if (prompt === SECOND_USER) {
    const results = requestMessages.filter((message) => message.role === "tool");
    if (results.length === 0) {
      assertSnapshot(body, SECOND_USER, [FIRST_USER, LONG_REPLY]);
      retrievalSnapshot = view(body);
      assert(retrievalSnapshot.includes(SUMMARY), "oversized old turn must be summarized");
      assert(!JSON.stringify(body).includes("OPTCHAT_SMOKE_RAW_BEGIN"), "raw oversized history must not be sent on the next turn");
      assert(targetRecord, "durable previous assistant record required for zoom");
      return sse(model, capture.sequence, undefined, TOOL_THINKING, [
        { index: 0, id: "smoke-zoom", type: "function", function: { name: "zoom", arguments: JSON.stringify({ id: targetRecord.i, n: 1 }) } },
        { index: 1, id: "smoke-date", type: "function", function: { name: "date", arguments: JSON.stringify({ id: targetRecord.i }) } },
      ]);
    }
    assert.equal(results.length, 2, "both real tools must return in the active loop");
    const zoom = results.find((message) => message.tool_call_id === "smoke-zoom");
    const date = results.find((message) => message.tool_call_id === "smoke-date");
    assert(zoom && content(zoom).includes(LONG_REPLY), "zoom must return the complete original record beyond the normal tool-output cap");
    assert(targetRecord, "date requires the original durable record");
    assert.equal(date && content(date).trim(), new Date(targetRecord.date).toLocaleString(), "date must return the original record's local display date");
    const toolCall = requestMessages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    assert(toolCall && Array.isArray(toolCall.tool_calls) && toolCall.tool_calls.length === 2, "active assistant tool calls must survive context replacement");
    assert.equal(toolCall.reasoning_content, TOOL_THINKING, "supported active-turn thinking must survive the tool loop");
    assert.equal(view(body), retrievalSnapshot, "tool continuation must reuse the exact pre-user snapshot bytes");
    return sse(model, capture.sequence, FINISHED);
  }
  if (prompt === RESTART_USER) {
    assertSnapshot(body, RESTART_USER, [FIRST_USER, LONG_REPLY, SECOND_USER, FINISHED]);
    assert(view(body).includes(SUMMARY), "new process must restore durable summary memory");
    assert(view(body).includes(FINISHED), "new process must restore the finished prior turn");
    assert(!JSON.stringify(body).includes(TOOL_THINKING), "active reasoning must not persist into restored history");
    return sse(model, capture.sequence, RESTORED);
  }
  assert.notEqual(prompt, LOCK_USER, "second writer reached model instead of rejecting its memory lock");
  throw new Error("Unexpected synthetic fixture prompt");
}

async function bounded<T>(label: string, operation: Promise<T>, ms = STEP_MS): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(`${label} exceeded ${ms}ms deadline`)), ms);
  try { return await Promise.race([operation, fatal.promise, expired.promise]); }
  finally { clearTimeout(timer); }
}

class Host {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly events: ObjectValue[] = [];
  diagnostics = "";
  private serial = 0;
  private pending = new Map<string, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }>();
  private listeners = new Set<() => void>();

  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.process = spawn(executable, args, { cwd, env, stdio: "pipe", detached: true });
    hosts.push(this);
    const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    this.exited = exit.promise;
    this.process.once("error", exit.reject);
    this.process.once("exit", (code, signal) => {
      for (const waiter of this.pending.values()) waiter.reject(new Error(`OMP exited before RPC response (${code ?? signal})`));
      this.pending.clear();
      exit.resolve({ code, signal });
      for (const notify of this.listeners) notify();
    });
    void this.exited.catch(fatal.reject);
    this.process.stderr.on("data", (chunk: Buffer) => { this.diagnostics = (this.diagnostics + chunk.toString()).slice(-8000); });
    this.process.stdin.on("error", (error: Error) => {
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      let event: ObjectValue;
      try { event = object(JSON.parse(line) as Json, "RPC event"); }
      catch { this.diagnostics = (this.diagnostics + line + "\n").slice(-8000); return; }
      this.events.push(event);
      if (event.type === "response" && typeof event.id === "string") {
        const waiter = this.pending.get(event.id);
        this.pending.delete(event.id);
        waiter?.resolve(event);
      }
      for (const notify of this.listeners) notify();
    });
  }

  async command(type: string, fields: ObjectValue = {}): Promise<ObjectValue> {
    const id = `smoke-${++this.serial}`;
    const response = Promise.withResolvers<ObjectValue>();
    this.pending.set(id, response);
    this.process.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return bounded(`RPC ${type}`, response.promise);
  }

  async until(label: string, predicate: () => boolean): Promise<void> {
    if (predicate()) return;
    const ready = Promise.withResolvers<void>();
    const listener = () => {
      if (predicate()) ready.resolve();
      else if (this.process.exitCode !== null || this.process.signalCode !== null) ready.reject(new Error(`${label}: OMP exited early`));
    };
    this.listeners.add(listener);
    listener();
    try { await bounded(label, ready.promise); }
    finally { this.listeners.delete(listener); }
  }

  async finishPrompt(id: Json | undefined): Promise<ObjectValue> {
    assert(typeof id === "string", "RPC prompt response must preserve its request ID");
    await this.until("prompt result", () => this.events.some((event) => event.type === "prompt_result" && event.id === id));
    const index = this.events.findIndex((event) => event.type === "prompt_result" && event.id === id);
    const result = this.events[index]!;
    if (result.sessionSettled !== true) {
      await this.until("session settled", () => this.events.slice(index + 1).some((event) => event.type === "session_settled"));
    }
    return result;
  }

  async prompt(message: string): Promise<void> {
    await this.until("RPC ready", () => this.events.some((event) => event.type === "ready"));
    const result = await this.command("prompt", { message });
    assert.equal(result.success, true, `RPC prompt rejected: ${JSON.stringify(result)}`);
    const completed = await this.finishPrompt(result.id);
    assert.equal(completed.status, "completed", `host prompt did not complete: ${JSON.stringify(completed)}`);
    const errors = this.events.filter((event) => event.type === "error" || event.type === "extension_error");
    assert.equal(errors.length, 0, `host emitted error: ${JSON.stringify(errors)}`);
  }

  async stop(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.stdin.end();
    const pid = this.process.pid;
    const signal = (value: NodeJS.Signals) => {
      try { if (pid) process.kill(-pid, value); else this.process.kill(value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    const term = setTimeout(() => signal("SIGTERM"), 1000);
    const kill = setTimeout(() => signal("SIGKILL"), 3000);
    try { await this.exited; }
    finally { clearTimeout(term); clearTimeout(kill); }
  }
}

async function diskMessages(directory: string): Promise<DiskMessage[]> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
    }
  }
  await walk(directory);
  const result: DiskMessage[] = [];
  for (const file of files.sort()) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      assert(!line.includes(FIRST_THINKING) && !line.includes(TOOL_THINKING), "durable message/summary files must exclude reasoning");
      const value = object(JSON.parse(line) as Json, "durable JSONL record");
      if (typeof value.i === "number" && typeof value.kind === "string" && typeof value.text === "string" && typeof value.date === "string") {
        result.push({ i: value.i, kind: value.kind, text: value.text, date: value.date });
      }
    }
  }
  return result.sort((a, b) => a.i - b.i);
}

// Installed-host CLI and isolated configuration are supplied by the integration contract below.
async function main(): Promise<void> {
  const executable = Bun.which(process.env.OPTCHAT_SMOKE_OMP ?? "omp");
  assert(executable, "Installed omp executable required (or set OPTCHAT_SMOKE_OMP)");
  const temporary = await mkdtemp(join(tmpdir(), "omp-optchat-smoke-"));
  const memory = join(temporary, "memory");
  const workspace = join(temporary, "workspace");
  const home = join(temporary, "home");
  const agentDirectory = join(temporary, "agent");
  const deadline = setTimeout(() => fatal.reject(new Error(`smoke exceeded ${TOTAL_MS}ms hard deadline during ${currentPhase}`)), TOTAL_MS);
  let server: Bun.Server<undefined> | undefined;
  try {
    await Promise.all([mkdir(memory), mkdir(workspace), mkdir(home), mkdir(agentDirectory)]);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      try {
        assert.equal(new URL(request.url).pathname, "/v1/chat/completions", "unexpected fixture API path");
        assert.equal(request.method, "POST", "fixture only accepts inference POST");
        return answer(object(await request.json() as Json, "request"));
      } catch (error) {
        serverFailure = error instanceof Error ? error : new Error(String(error));
        fatal.reject(serverFailure);
        return Response.json({ error: { message: serverFailure.message, type: "smoke_assertion" } }, { status: 400 });
      }
    } });
    // No inherited credentials, agent context, model aliases, proxies, or user configuration.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_TIME: process.env.LC_TIME,
      TZ: process.env.TZ,
      TERM: "dumb",
      NO_COLOR: "1",
      HOME: home,
      TMPDIR: temporary,
      PI_CODING_AGENT_DIR: agentDirectory,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      OPTCHAT_SMOKE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    };
    // --no-extensions disables ambient discovery, while explicit -e paths still load.
    // Passing the package root exercises its real omp.extensions manifest.
    const args = [
      "--mode", "rpc", "--no-ui", "--no-title", "--no-tools", "--no-extensions", "--no-skills", "--no-rules",
      "--session-dir", join(temporary, "sessions"),
      "-e", ROOT,
      "-e", join(ROOT, "scripts", "fixture-provider.ts"),
      "--model", "optchat-smoke/optchat-smoke-chat",
      "--optchat", "--optchat-dir", memory,
      "--optchat-model", "optchat-smoke/optchat-smoke-compact",
    ];
    currentPhase = "same-process first turn";
    const first = new Host(executable, args, workspace, env);
    await first.prompt(FIRST_USER);
    const initial = await diskMessages(memory);
    targetRecord = initial.find((record) => record.kind === "talk" && record.text === LONG_REPLY);
    assert(targetRecord, "finished assistant reply must be durable before the next prompt");
    assert(initial.some((record) => record.kind === "user" && record.text === FIRST_USER), "first user must be durable");

    currentPhase = "same-process retrieval turn";
    await first.prompt(SECOND_USER);
    const completed = await diskMessages(memory);
    assert(completed.some((record) => record.kind === "talk" && record.text === FINISHED), "tool-loop final answer must be durable");
    assert(completed.some((record) => record.kind === "echo" && record.text.includes(LONG_REPLY)), "full zoom retrieval must remain lossless in durable memory");
    assert(!JSON.stringify(completed).includes(FIRST_THINKING) && !JSON.stringify(completed).includes(TOOL_THINKING), "durable history must exclude reasoning");
    const compactions = captures.filter((capture) => capture.body.model === "optchat-smoke-compact");
    const oldRecordCompaction = compactions.find((capture) => JSON.stringify(capture.body).includes("OPTCHAT_SMOKE_RAW_BEGIN"));
    assert(oldRecordCompaction, "oversized past record must invoke the real compressor adapter");
    const compactText = JSON.stringify(oldRecordCompaction.body);
    assert(compactText.includes(FIRST_USER), "compactor must receive prior contextual prefix");
    assert(compactText.indexOf(FIRST_USER) < compactText.indexOf("OPTCHAT_SMOKE_RAW_BEGIN"), "compactor context must precede its target record");
    assert(!compactText.includes(SECOND_USER), "current user must not leak into past-record compaction context");

    currentPhase = "second-writer rejection";
    const beforeContender = captures.filter((capture) => capture.body.model === "optchat-smoke-chat").length;
    const contender = new Host(executable, args, workspace, env);
    await contender.until("contender RPC ready", () => contender.events.some((event) => event.type === "ready"));
    const rejected = await contender.command("prompt", { message: LOCK_USER });
    if (rejected.success === true) await contender.finishPrompt(rejected.id);
    // The integration reports a UI warning and aborts rather than dispatching without memory.
    assert.match(JSON.stringify(contender.events) + contender.diagnostics, /lock|active writer|another writer|already.*open/i, "rejection must identify the held memory lock");
    assert.equal(captures.filter((capture) => capture.body.model === "optchat-smoke-chat").length, beforeContender, "rejected writer must not dispatch an inference request");
    assert.deepEqual(await diskMessages(memory), completed, "rejected writer must not append durable history");
    await bounded("contender host shutdown", contender.stop());

    currentPhase = "graceful process shutdown";
    await bounded("first host shutdown", first.stop());
    assert.equal((await first.exited).code, 0, "first host must finish graceful session_shutdown");
    currentPhase = "restoration in new process";
    const restarted = new Host(executable, args, workspace, env);
    await restarted.prompt(RESTART_USER);
    const restored = await diskMessages(memory);
    assert(restored.some((record) => record.kind === "talk" && record.text === RESTORED), "restored session final answer must be durable");
    assert.equal(new Set(restored.map((record) => record.i)).size, restored.length, "restart must not duplicate durable IDs");
    assert.equal(restored.filter((record) => record.kind === "user" && record.text === FIRST_USER).length, 1, "restart must not reappend old user turns");
    assert.equal(restored.filter((record) => record.kind === "talk" && record.text === LONG_REPLY).length, 1, "restart must not reappend old assistant turns");
    await bounded("restored host shutdown", restarted.stop());
    assert.equal((await restarted.exited).code, 0, "restored host must finish graceful session_shutdown");
    assert(!serverFailure, serverFailure?.message ?? "smoke fixture server must not fail");
    for (const capture of captures.filter((entry) => entry.body.model === "optchat-smoke-compact")) {
      const request = JSON.stringify(capture.body);
      assert(!request.includes(FIRST_THINKING) && !request.includes(TOOL_THINKING), "reasoning must never reach the compressor");
    }
    const chatRequests = captures.filter((capture) => capture.body.model === "optchat-smoke-chat");
    assert.equal(chatRequests.length, 4, "expected first turn, tool request, tool continuation, restored turn");
    console.log(JSON.stringify({
      ok: true, evidence: "synthetic-model/real-installed-omp-host", executable,
      hostProcesses: hosts.length, chatRequests: chatRequests.length,
      compactorRequests: captures.length - chatRequests.length,
      durableMessages: restored.length, retrievedBytes: Buffer.byteLength(LONG_REPLY),
      checks: ["same-process history replacement", "pre-user settled snapshot", "contextual past-record compaction", "active reasoning and tool-loop retention", "real zoom/date tools", "lossless oversized retrieval", "durable history excludes reasoning", "second-writer rejection", "new-process restoration"],
    }, null, 2));
  } finally {
    clearTimeout(deadline);
    await Promise.allSettled(hosts.map((host) => host.stop()));
    server?.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, evidence: "synthetic-model/real-installed-omp-host", phase: currentPhase, error: error instanceof Error ? error.message : String(error), hostDiagnostics: hosts.map((host) => host.diagnostics).filter(Boolean) }, null, 2));
  process.exitCode = 1;
}
