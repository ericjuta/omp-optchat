/**
 * OptChat's real metric hooks on a fake host and loopback compressor. The active store's metrics.jsonl records
 * compressor usage, host cuts, context refusals, and rules triage. Only compressor rows contribute to spend;
 * a call without a reported cost is unknown, never $0.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULTS, fallbackStoreDirectory, globalStoreDirectory } from "../src/config.ts";
import { createOptChat } from "../src/index.ts";
import { hostCompactionSummaryInTurn } from "../src/prompts.ts";
import { appendMetric, METRICS_FILE, readCompressorSpend, type CompressorUsage } from "../src/metrics.ts";
import { startCompressorServer, type CompressorServer } from "./helpers/compressor-server.ts";
import { fakeJudge, noul } from "./helpers/fake-judge.ts";
import { openFakeHost, type FakeHost, type HostMessage } from "./helpers/fake-host.ts";
import { branchOf, compact } from "./helpers/host-compaction.ts";
import { ALL_GATES_OFF, anthropicModel, Harness, hasNotice, RULE_ADDED, RULE_TEXT, SEED_TEXTS, SMALL_NODES, talk, until } from "./helpers/system1-chat.ts";

const roots: string[] = [];
const hosts: FakeHost[] = [];
const servers: CompressorServer[] = [];
const harness = new Harness();
let savedOverride: string | undefined;

beforeEach(() => {
  savedOverride = process.env.OPTCHAT_METRICS_FILE;
  delete process.env.OPTCHAT_METRICS_FILE;
});

afterEach(async () => {
  if (savedOverride === undefined) delete process.env.OPTCHAT_METRICS_FILE;
  else process.env.OPTCHAT_METRICS_FILE = savedOverride;
  for (const host of hosts.splice(0).reverse()) await host.close();
  await harness.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const { version: pluginVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const USAGE: CompressorUsage = {
  type: "compressor",
  at: "2026-10-21T00:00:00.000Z",
  model: "fake/compressor",
  input: 8,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  node: "leaf",
  attempt: 1,
  retry: null,
  waitMs: 0,
  latencyMs: 5,
  costUsd: null,
  stopReason: "stop",
  error: null,
};

interface ChatOptions {
  /** What the loopback compressor answers its first requests with, in arrival order; later ones get a short summary. */
  replies?: readonly string[];
  /** Runs before every compressor provider attempt; the attempt is sent when it settles true. */
  admit?: (model: string) => boolean | Promise<boolean>;
}

async function openChat(options: ChatOptions = {}): Promise<{ host: FakeHost; metrics: string; seen: CompressorUsage[]; compressor: CompressorServer }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "optchat-metrics-")));
  roots.push(root);
  const compressor = await startCompressorServer(options.replies);
  servers.push(compressor);
  const seen: CompressorUsage[] = [];
  const host = await openFakeHost(createOptChat({ onCompressorUsage: (usage) => seen.push(usage), admitCompressorCall: options.admit }), {
    directory: join(root, "chat"),
    flags: { ...ALL_GATES_OFF, ...SMALL_NODES },
    model: compressor.model,
    mainModel: anthropicModel(),
    apiKey: "fixture-key",
  });
  hosts.push(host);
  return { host, metrics: join(host.directory, METRICS_FILE), seen, compressor };
}

async function seed(host: FakeHost): Promise<void> {
  let transcript: HostMessage[] = [];
  for (const text of SEED_TEXTS) {
    const messages = [...transcript, host.user(text)];
    await host.context(messages);
    transcript = [...messages, host.assistant("noted")];
    await host.fire("agent_end", { messages: transcript, willContinue: false });
  }
  await settle(host);
}

async function settle(host: FakeHost): Promise<void> {
  await until(async () => (await statusOf(host)).includes("compressor jobs running: 0"), "the compressor to settle");
}

async function statusOf(host: FakeHost): Promise<string> {
  return (await host.command("status")).at(-1)?.message ?? "";
}

/** Every line of a metric sink, parsed; none when the sink does not exist yet. */
function rowsOf(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rowsOfType(path: string, type: string): Array<Record<string, unknown>> {
  return rowsOf(path).filter((row) => row.type === type);
}

/** An ISO-8601 UTC timestamp that round-trips through Date. */
function isIso(value: unknown): boolean {
  return typeof value === "string" && new Date(value).toISOString() === value;
}

describe("compressor metric sink", () => {
  test("appends every completed compressor call to the store directory by default, counts only", async () => {
    const { host, metrics, seen } = await openChat();
    expect(existsSync(metrics)).toBe(false);
    await seed(host);

    expect(seen.length).toBeGreaterThan(0);
    const lines = readFileSync(metrics, "utf8").split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(seen.length);
    expect(lines.map((line) => JSON.parse(line))).toEqual(seen.map((row) => ({ ...row, pluginVersion })));
    expect(await statusOf(host)).toContain(`version: ${pluginVersion}`);
    for (const text of SEED_TEXTS) expect(readFileSync(metrics, "utf8")).not.toContain(text);
    expect(statSync(metrics).mode & 0o777).toBe(0o600);
    expect(await statusOf(host)).toContain(`compressor spend (this store): ${seen.length} calls, $0.0000 reported`);
  });

  test("an idle status carries no spend line", async () => {
    const { host } = await openChat();
    expect(await statusOf(host)).not.toContain("compressor spend");
  });

  test("status shows a call with no reported cost as unknown, never as $0", async () => {
    const { host, metrics } = await openChat();
    appendMetric(metrics, { ...USAGE, costUsd: 0.25 });
    appendMetric(metrics, { ...USAGE, costUsd: null });
    appendMetric(metrics, { ...USAGE, costUsd: null });
    let status = await statusOf(host);
    expect(status).toContain("compressor spend (this store): 3 calls, $0.2500 reported for 1; cost unknown for 2");

    const unpriced = await openChat();
    appendMetric(unpriced.metrics, USAGE);
    status = await statusOf(unpriced.host);
    expect(status).toContain("compressor spend (this store): 1 calls, cost unknown (the host reported none)");
    expect(status).not.toContain("$0.0000");
  });

  test("OPTCHAT_METRICS_FILE redirects the sink away from the store", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "optchat-metrics-env-")));
    roots.push(root);
    const redirected = join(root, "elsewhere.jsonl");
    process.env.OPTCHAT_METRICS_FILE = redirected;
    const { host, metrics, seen } = await openChat();
    await seed(host);
    expect(seen.length).toBeGreaterThan(0);
    expect(rowsOf(redirected) as unknown[]).toEqual(seen.map((row) => ({ ...row, pluginVersion })));
    expect(existsSync(metrics)).toBe(false);
  });
});

describe("the metric sink follows the store's inode", () => {
  test("rows go to the directory the session holds, not to whatever now sits at its old path", async () => {
    const { host, metrics, seen } = await openChat();
    const moved = `${host.directory}-moved`;
    await rename(host.directory, moved);
    // Another store's directory now sits at the old path.
    await mkdir(host.directory, { mode: 0o700 });
    await seed(host);

    expect(seen.length).toBeGreaterThan(0);
    expect(existsSync(metrics)).toBe(false);
    expect(readFileSync(join(moved, METRICS_FILE), "utf8").split("\n").filter((line) => line.length > 0)).toHaveLength(seen.length);
    expect(hasNotice(host, "OptChat metrics")).toBe(false);
  });
});

describe("compressor rows: what each call was", () => {
  test("a retried merge carries its node, its true attempt, the retry cause, a timestamp and the wait apart from provider time", async () => {
    // The first request is a merge (the seeded messages are shorter than a node, so they stay verbatim): its reply is
    // over the 64-byte node limit, so the same merge is asked again.
    const started = Date.now();
    // The reply varies word to word: the provider SDK re-sends a request whose reply is one word repeated, which would hide the length retry.
    const { host, metrics, seen } = await openChat({ replies: [Array.from({ length: 30 }, (_, index) => `item${index}`).join(" ")] });
    await seed(host);
    const finished = Date.now();

    const retried = seen.filter((row) => row.retry !== null);
    expect(retried).toHaveLength(1);
    const row = retried[0]!;
    expect(row).toMatchObject({ type: "compressor", node: "merge", attempt: 2, retry: "length", stopReason: "stop", error: null });
    expect(isIso(row.at)).toBe(true);
    expect(Date.parse(row.at)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(row.at)).toBeLessThanOrEqual(finished);
    expect(Number.isInteger(row.waitMs) && row.waitMs >= 0).toBe(true);
    expect(Number.isInteger(row.latencyMs) && row.latencyMs >= 0).toBe(true);
    expect("purpose" in row).toBe(false);

    // A first attempt is attempt 1 with no cause; every retry names one.
    for (const each of seen) expect(each.attempt === 1).toBe(each.retry === null);
    expect(seen.some((each) => each.attempt === 1)).toBe(true);
    expect(rowsOf(metrics) as unknown[]).toEqual(seen.map((row) => ({ ...row, pluginVersion })));
  });

  test("a long message's own call is a leaf, on its first attempt with no retry cause", async () => {
    const { host, seen } = await openChat();
    await talk(host, [], "a long question about the quarterly report ".repeat(8));
    await until(() => seen.some((row) => row.node === "leaf"), "the leaf call");
    await settle(host);
    const leaves = seen.filter((row) => row.node === "leaf");
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ type: "compressor", attempt: 1, retry: null });
  });

  test("the time spent waiting for admission is waitMs, not provider latency", async () => {
    // A fixed clock that only the admission hook advances, so the wait is exactly what the clock moved during it.
    let clock = 1_000;
    const now = spyOn(performance, "now").mockImplementation(() => clock);
    try {
      let admissions = 0;
      const { host, seen } = await openChat({
        admit: () => {
          if (admissions++ === 0) clock += 500;
          return true;
        },
      });
      await seed(host);
      const waited = seen.filter((row) => row.waitMs === 500);
      expect(waited).toHaveLength(1);
      expect(waited[0]!.latencyMs).toBe(0);
    } finally {
      now.mockRestore();
    }
  });
});

describe("host compaction rows", () => {
  const COMPACTION_KEYS = ["at", "cut", "outcome", "pluginVersion", "reason", "tokensBefore", "type"];
  const NO_ANCHOR = {
    anchor: null, droppedAnchorIndex: null, hasRecoveryPointer: false, olderBytes: null, openTurnBytes: null,
  };
  const size = (messages: HostMessage[]): number => messages.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0);

  test("the marker kept at the host's cut: one row with the host's token count, no message text", async () => {
    const { host, metrics } = await openChat();
    await compact(host, { dropped: [], firstKeptEntryId: "e1", tokensBefore: 55 }, []);
    const rows = rowsOfType(metrics, "host-compaction");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "host-compaction", pluginVersion, outcome: "marker", reason: null, tokensBefore: 55 });
    expect(rows[0]!.cut).toEqual({ ...NO_ANCHOR, decision: "no-anchor", messagesToSummarize: 0, turnPrefixMessages: 0 });
    expect(isIso(rows[0]!.at)).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual(COMPACTION_KEYS);
  });

  test("a cut moved to the open turn's first message is cut-moved", async () => {
    const { host, metrics } = await openChat();
    const history = await talk(host, await talk(host, [], "first question"), "second question");
    const prompt = host.user("third question 🗃️");
    await host.context([...history, prompt]);
    const reply = host.assistant("reading the file", { id: "t1", name: "read", arguments: {} });
    const result = host.toolResult("t1", "read", "file text");
    const all = [...history, prompt, reply, result, host.assistant("done reading")];
    await compact(host, { dropped: history, prefix: [prompt, reply, result], firstKeptEntryId: "e8", tokensBefore: 777 }, branchOf(all));
    expect(rowsOfType(metrics, "host-compaction")).toEqual([
      { type: "host-compaction", at: expect.any(String), pluginVersion, outcome: "cut-moved", reason: null, tokensBefore: 777,
        cut: { decision: "anchor-cut-point", messagesToSummarize: 4, turnPrefixMessages: 3, anchor: "first", droppedAnchorIndex: 4,
          hasRecoveryPointer: true, olderBytes: size(history), openTurnBytes: size([prompt, reply, result]) } },
    ]);
  });

  test("a first and repeated in-turn cut each record a distinct decision, never the recovery summary", async () => {
    const { host, metrics } = await openChat();
    const prompt = host.user("only question");
    await host.context([prompt]);
    const reply = host.assistant("reading", { id: "t1", name: "read", arguments: {} });
    const result = host.toolResult("t1", "read", "file text");
    const all = [prompt, reply, result, host.assistant("done")];
    await compact(host, { dropped: [], prefix: [prompt, reply, result], firstKeptEntryId: "e4" }, branchOf(all));
    const recoverySummary = hostCompactionSummaryInTurn(0);
    const summary = { role: "compactionSummary", summary: recoverySummary, timestamp: Date.now() } as HostMessage;
    await host.context([summary, all[3]!]);
    await compact(host, { dropped: [summary], prefix: [all[3]!], firstKeptEntryId: "private-cut-id" }, branchOf(all));
    expect(host.aborts).toBe(0);
    expect(rowsOf(metrics)).toEqual([
      { type: "host-compaction", at: expect.any(String), pluginVersion, outcome: "cut-in-turn", reason: null, tokensBefore: 1000,
        cut: { ...NO_ANCHOR, decision: "no-older-history", messagesToSummarize: 0, turnPrefixMessages: 3,
          anchor: "first", droppedAnchorIndex: 0, hasRecoveryPointer: true } },
      { type: "host-compaction", at: expect.any(String), pluginVersion, outcome: "cut-in-turn", reason: null, tokensBefore: 1000,
        cut: { ...NO_ANCHOR, decision: "prior-in-turn-cut", messagesToSummarize: 1, turnPrefixMessages: 1,
          anchor: "first", hasRecoveryPointer: true } },
    ]);
    const raw = readFileSync(metrics, "utf8");
    for (const privateText of [recoverySummary, "private-cut-id", "only question", "file text"]) expect(raw).not.toContain(privateText);
  });

  test("an open turn larger than the older history is cut inside, not moved back", async () => {
    const { host, metrics } = await openChat();
    const history = await talk(host, [], "hi");
    const prompt = host.user("read the big file");
    await host.context([...history, prompt]);
    const reply = host.assistant("reading", { id: "t1", name: "read", arguments: {} });
    const result = host.toolResult("t1", "read", "x".repeat(20_000));
    const all = [...history, prompt, reply, result, host.assistant("done")];
    await compact(host, { dropped: history, prefix: [prompt, reply, result], firstKeptEntryId: "e6", tokensBefore: 9 }, branchOf(all));
    expect(rowsOfType(metrics, "host-compaction")).toEqual([
      { type: "host-compaction", at: expect.any(String), pluginVersion, outcome: "cut-in-turn", reason: null, tokensBefore: 9,
        cut: { decision: "open-turn-larger", messagesToSummarize: 2, turnPrefixMessages: 3, anchor: "first", droppedAnchorIndex: 2,
          hasRecoveryPointer: true, olderBytes: size(history), openTurnBytes: size([prompt, reply, result]) } },
    ]);
  });

  test("an anchor the host cannot cut at cancels with the reason anchor-not-cut-point", async () => {
    const { host, metrics } = await openChat();
    const prompt = host.user("read the file");
    const reply = host.assistant("reading", { id: "t1", name: "read", arguments: {} });
    const result = host.toolResult("t1", "read", "file text");
    const messages = [prompt, reply, result];
    await host.context(messages);
    await host.fire("agent_end", { messages, willContinue: false });
    // The next turn opens with no new message, after the tool result.
    await host.context(messages);
    await compact(host, { dropped: messages, firstKeptEntryId: "e4" }, branchOf([...messages, host.assistant("later")]));
    const rows = rowsOfType(metrics, "host-compaction");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "cancelled", reason: "anchor-not-cut-point" });
    expect(Object.keys(rows[0]!).sort()).toEqual(COMPACTION_KEYS);
  });

  test("nothing older and no durable pointer: the same drop position is cancelled, not cut in turn", async () => {
    const { host, metrics } = await openChat();
    const notice = {
      role: "custom", customType: "private-notice-kind", content: "private notice text", display: false,
      attribution: "agent", timestamp: Date.now() + 1,
    } as HostMessage;
    await host.context([notice]);
    const outcome = await compact(host, { dropped: [], prefix: [notice], firstKeptEntryId: "private-cut-id" }, branchOf([notice]));
    expect(outcome).toEqual({ cancel: true });
    expect(rowsOf(metrics)).toEqual([
      { type: "host-compaction", at: expect.any(String), pluginVersion, outcome: "cancelled", reason: "nothing-older", tokensBefore: 1000,
        cut: { ...NO_ANCHOR, decision: "no-older-history", messagesToSummarize: 0, turnPrefixMessages: 1,
          anchor: "first", droppedAnchorIndex: 0 } },
    ]);
    const raw = readFileSync(metrics, "utf8");
    for (const privateText of ["private-notice-kind", "private notice text", "private-cut-id"]) expect(raw).not.toContain(privateText);
  });

  test("a compaction row is not a compressor call: status and spend count only the compressor rows", async () => {
    const { host, metrics, seen } = await openChat();
    await seed(host);
    await compact(host, { dropped: [], firstKeptEntryId: "e1", tokensBefore: 55 }, []);
    expect(rowsOfType(metrics, "host-compaction")).toHaveLength(1);
    expect(rowsOf(metrics)).toHaveLength(seen.length + 1);
    expect(readCompressorSpend(metrics).calls).toBe(seen.length);
    expect(await statusOf(host)).toContain(`compressor spend (this store): ${seen.length} calls, $0.0000 reported`);
  });
});

describe("request refusal rows", () => {
  test("a lost turn aborts once, but a steering batch does not; record only its fixed reason and shape", async () => {
    const { host, metrics } = await openChat();
    await host.context([host.user("private original prompt")]);
    expect(await host.context([host.user("private steering batch")])).toBeUndefined();
    expect(rowsOf(metrics)).toEqual([]);
    expect(await host.context([host.assistant("private displaced reply")])).toEqual({ messages: [] });
    expect(host.aborts).toBe(1);
    expect(rowsOf(metrics)).toEqual([
      { type: "request-refusal", at: expect.any(String), pluginVersion, reason: "turn-missing", hostMessages: 1,
        openTurn: true, hasRecoveryPointer: true, priorInTurnCut: false },
    ]);
    expect(readFileSync(metrics, "utf8")).not.toContain("private");
    expect(readCompressorSpend(metrics)).toEqual({ calls: 0, reportedUsd: 0, unknownCost: 0 });
    expect(await statusOf(host)).toContain("last OptChat request refusal: turn-missing");
    await host.fire("session_switch");
    expect(await statusOf(host)).not.toContain("last OptChat request refusal");
  });

  test("a closed store is not written; status still shows the fixed refusal reason", async () => {
    const { host, metrics } = await openChat();
    await host.shutdown();
    expect(await host.context([host.user("private prompt")])).toEqual({ messages: [] });
    expect(host.aborts).toBe(1);
    expect(existsSync(metrics)).toBe(false);
    const status = await statusOf(host);
    expect(status).toContain("last OptChat request refusal: memory-closed");
    expect(status).toContain(`version: ${pluginVersion}`);
    expect(status).not.toContain("private prompt");
  });

  test("unexpected error details stay in the UI, not in the diagnostic", async () => {
    const { host, metrics } = await openChat();
    const getSystemPrompt = spyOn(host.ctx, "getSystemPrompt").mockImplementation(() => { throw new Error("private exception text"); });
    try {
      expect(await host.context([host.user("private prompt")])).toEqual({ messages: [] });
    } finally {
      getSystemPrompt.mockRestore();
    }
    expect(host.aborts).toBe(1);
    expect(host.notices.some((notice) => notice.type === "error" && notice.message.includes("private exception text"))).toBe(true);
    expect(rowsOf(metrics)).toEqual([
      { type: "request-refusal", at: expect.any(String), pluginVersion, reason: "unexpected-error", hostMessages: 1,
        openTurn: true, hasRecoveryPointer: true, priorInTurnCut: false },
    ]);
    expect(readFileSync(metrics, "utf8")).not.toContain("private");
  });
});

describe("rules rows", () => {
  const FLAGS = { ...SMALL_NODES, "no-optchat-prefetch": true, "no-optchat-value-score": true, "no-optchat-recall": true } as const;

  test("each triage writes one counts-only row: P(rule), the cutoff, and whether a rule was written", async () => {
    const { host } = await harness.open({ flags: FLAGS, routes: { ruleWhen: RULE_TEXT } });
    const metrics = join(host.directory, METRICS_FILE);
    const rule = host.user(RULE_TEXT);
    await host.context([rule]);
    await until(() => hasNotice(host, RULE_ADDED), "the rule to be added");

    const reply = host.assistant("Understood.");
    await host.fire("agent_end", { messages: [rule, reply], willContinue: false });
    await host.context([rule, reply, host.user("What time is it?")]);
    await until(() => rowsOfType(metrics, "rules").length === 2, "the second triage");

    const rows = rowsOfType(metrics, "rules");
    expect(rows).toEqual([
      { type: "rules", at: expect.any(String), pluginVersion, pRule: 0.95, pSentenceMax: null, sentences: 1, cutoff: DEFAULTS.ruleAdd, added: true },
      { type: "rules", at: expect.any(String), pluginVersion, pRule: 0, pSentenceMax: null, sentences: 1, cutoff: DEFAULTS.ruleAdd, added: false },
    ]);
    for (const row of rows) expect(isIso(row.at)).toBe(true);
    // Counts only: neither the message nor the rule's text reaches the sink.
    const raw = readFileSync(metrics, "utf8");
    expect(raw).not.toContain("French");
    expect(raw).not.toContain("What time");
  });

  test("a message judged sentence by sentence records its highest sentence probability and count", async () => {
    const judge = fakeJudge(() => ({ rule: noul(0.95), withdraw: noul(0), s0: noul(0.9), s1: noul(0.1) }));
    const { host } = await harness.open({ flags: FLAGS, judge });
    const metrics = join(host.directory, METRICS_FILE);
    await host.context([host.user("From now on always reply in French. Also run the tests.")]);
    await until(() => rowsOfType(metrics, "rules").length === 1, "the triage");
    expect(rowsOfType(metrics, "rules")[0]).toMatchObject({ pRule: 0.95, pSentenceMax: 0.9, sentences: 2, cutoff: DEFAULTS.ruleAdd, added: true });
  });

  test("a near miss below the cutoff is recorded with its probability and adds no rule", async () => {
    const judge = fakeJudge(() => ({ rule: noul(0.75), withdraw: noul(0) }));
    const { host } = await harness.open({ flags: FLAGS, judge });
    const metrics = join(host.directory, METRICS_FILE);
    await host.context([host.user(RULE_TEXT)]);
    await until(() => rowsOfType(metrics, "rules").length === 1, "the triage");
    expect(rowsOfType(metrics, "rules")[0]).toMatchObject({ pRule: 0.75, cutoff: DEFAULTS.ruleAdd, added: false });
    expect(hasNotice(host, "OptChat rule")).toBe(false);
  });

  test("a rules row is not a compressor call", async () => {
    const { host, metrics } = await openChat();
    appendMetric(metrics, { type: "rules", at: USAGE.at, pRule: 0.9, pSentenceMax: null, sentences: 1, cutoff: 0.8, added: true });
    expect(readCompressorSpend(metrics)).toEqual({ calls: 0, reportedUsd: 0, unknownCost: 0 });
    expect(await statusOf(host)).not.toContain("compressor spend");
  });
});

describe("readCompressorSpend", () => {
  test("a missing file is zero calls; torn or unpriced lines are calls with unknown cost", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "optchat-spend-")));
    roots.push(root);
    const path = join(root, METRICS_FILE);
    expect(readCompressorSpend(path)).toEqual({ calls: 0, reportedUsd: 0, unknownCost: 0 });
    appendMetric(path, { ...USAGE, costUsd: 0.5 });
    appendMetric(path, USAGE);
    await Bun.write(path, `${readFileSync(path, "utf8")}{"model":"torn`);
    expect(readCompressorSpend(path)).toEqual({ calls: 3, reportedUsd: 0.5, unknownCost: 2 });
  });

  test("untyped and unstamped compressor rows count alongside stamped rows; other row types do not", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "optchat-spend-")));
    roots.push(root);
    const path = join(root, METRICS_FILE);
    await Bun.write(path, `${JSON.stringify({ model: "fake/compressor", purpose: "leaf", costUsd: 0.5 })}\n${JSON.stringify({ ...USAGE, costUsd: 1 })}\n`);
    appendMetric(path, { type: "request-refusal", at: USAGE.at, reason: "memory-failed", hostMessages: 1,
      openTurn: false, hasRecoveryPointer: false, priorInTurnCut: false });
    appendMetric(path, { type: "rules", at: USAGE.at, pRule: 0.9, pSentenceMax: null, sentences: 1, cutoff: 0.8, added: true });
    appendMetric(path, { ...USAGE, costUsd: 0.25 });
    expect(readCompressorSpend(path)).toEqual({ calls: 3, reportedUsd: 1.75, unknownCost: 0 });
  });
});

describe("an inactive session", () => {
  test("the reason is stored in the session log and shown by status; the holder's log has none", async () => {
    const { host: holder, compressor } = await openChat();
    const directory = holder.directory;
    const other = await openFakeHost(createOptChat(), {
      directory,
      flags: { ...ALL_GATES_OFF, ...SMALL_NODES },
      model: compressor.model,
      mainModel: anthropicModel(),
      apiKey: "fixture-key",
    });
    hosts.push(other);

    const reason = `${directory} is in use by another session`;
    expect(hasNotice(other, "OptChat is inactive")).toBe(true);
    expect(other.entries).toEqual([{ customType: "optchat-inactive", data: { reason, directory } }]);
    expect(holder.entries).toEqual([]);
    const status = await statusOf(other);
    expect(status).toContain(`OptChat: inactive: ${reason}`);
    expect(status).toContain(`directory: ${directory}`);
    // The inactive session writes nothing to the holder's store.
    expect(existsSync(join(directory, METRICS_FILE))).toBe(false);
  });
});

describe("a held global store", () => {
  // Outside git with no --optchat-dir: the agent directory's `optchat` store is the default (cwd is the agent directory).
  async function openDefault(agent: string, compressor: CompressorServer): Promise<FakeHost> {
    const host = await openFakeHost(createOptChat(), {
      directory: agent,
      flags: { ...ALL_GATES_OFF, ...SMALL_NODES, "optchat-dir": undefined },
      model: compressor.model,
      mainModel: anthropicModel(),
      apiKey: "fixture-key",
    });
    hosts.push(host);
    return host;
  }

  test("a second session falls back to its working directory's own store instead of going inactive", async () => {
    const agent = await realpath(await mkdtemp(join(tmpdir(), "optchat-agent-")));
    roots.push(agent);
    const compressor = await startCompressorServer();
    servers.push(compressor);
    const global = globalStoreDirectory(agent);
    const fallback = fallbackStoreDirectory(agent, agent);
    const first = await openDefault(agent, compressor);
    expect(await statusOf(first)).toContain(`directory: ${global}`);

    const second = await openDefault(agent, compressor);
    expect(hasNotice(second, "OptChat is inactive")).toBe(false);
    expect(hasNotice(second, `OptChat: ${global} is in use by another session, so this session uses ${fallback}.`)).toBe(true);
    expect(second.entries).toEqual([]);
    const status = await statusOf(second);
    expect(status).toContain("OptChat: ready");
    expect(status).toContain(`directory: ${fallback}`);
    expect(dirname(fallback)).toBe(join(agent, "optchat-dirs"));

    // Both stores held: the third session runs without memory and names both.
    const third = await openDefault(agent, compressor);
    const reason = `${global} and ${fallback} are in use by other sessions`;
    expect(third.entries).toEqual([{ customType: "optchat-inactive", data: { reason, directory: fallback } }]);
  });

  test("an explicit --optchat-dir naming the global store does not fall back", async () => {
    const agent = await realpath(await mkdtemp(join(tmpdir(), "optchat-agent-")));
    roots.push(agent);
    const compressor = await startCompressorServer();
    servers.push(compressor);
    const global = globalStoreDirectory(agent);
    await openDefault(agent, compressor);
    const explicit = await openFakeHost(createOptChat(), {
      directory: agent,
      flags: { ...ALL_GATES_OFF, ...SMALL_NODES, "optchat-dir": global },
      model: compressor.model,
      mainModel: anthropicModel(),
      apiKey: "fixture-key",
    });
    hosts.push(explicit);
    const reason = `${global} is in use by another session`;
    expect(explicit.entries).toEqual([{ customType: "optchat-inactive", data: { reason, directory: global } }]);
    expect(existsSync(join(agent, "optchat-dirs"))).toBe(false);
  });
});
