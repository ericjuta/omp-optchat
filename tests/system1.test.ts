import { afterEach, describe, expect, test } from "bun:test";
import type { Answer } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, readConfig, toolGateRequested } from "../src/config.ts";
import { createOptChat } from "../src/index.ts";
import { hostJudge } from "../src/system1/judge.ts";
import { LEDGER_FILE, RULE_TEXT_BYTES, RuleLedger, clipRule, renderRules } from "../src/system1/ledger.ts";
import { PREFETCH_HEADER, PREFETCH_QUESTIONS, PREFETCH_STATE_BYTES, prefetchBlock, type PrefetchMemory } from "../src/system1/prefetch.ts";
import {
  decideTriage,
  offeredRules,
  RULE_SENTENCE_LIMIT,
  ruleSentences,
  TRIAGE_MESSAGE_BYTES,
  triageQuestions,
  triageState,
} from "../src/system1/rules.ts";
import { EXEMPT_TOOLS, dangerOf, gateToolCall } from "../src/system1/tool-gate.ts";
import { valueHint } from "../src/system1/value.ts";
import { choice, fakeJudge, noul, score, type FakeJudge } from "./helpers/fake-judge.ts";
import { openFakeHost, type FakeHost, type FakeHostOptions, type HostMessage } from "./helpers/fake-host.ts";

const dirs: string[] = [];
const hosts: FakeHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "optchat-s1-"));
  dirs.push(dir);
  return dir;
}

/** A flag reader for readConfig and toolGateRequested. */
function flagsOf(flags: Record<string, string | boolean>): ExtensionAPI {
  return { getFlag: (name: string) => flags[name] } as unknown as ExtensionAPI;
}

/** One macrotask turn, with no wall-clock duration: lets queued I/O and timers already due run. */
async function macrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

/** Polls a condition at macrotask pace, bounded by a round count rather than a duration. */
async function waitFor(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let round = 0; round < 2_000; round++) {
    if (await condition()) return;
    await macrotask();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function start(
  flags: Record<string, string | boolean>,
  judge?: FakeJudge,
  options: FakeHostOptions = {},
): Promise<FakeHost> {
  const host = await openFakeHost(createOptChat(judge ? { judge: () => judge } : {}), { ...options, flags });
  hosts.push(host);
  return host;
}

async function contextTexts(host: FakeHost, messages: HostMessage[]): Promise<string[]> {
  const result = (await host.context(messages)) as { messages: Array<{ content: unknown }> };
  return result.messages.map((message) => JSON.stringify(message.content));
}

async function ledgerText(directory: string): Promise<string> {
  return readFile(join(directory, LEDGER_FILE), "utf8").catch(() => "");
}

/** Ends the host's agent run, as the host does between turns: the next request opens a fresh turn. */
async function endRun(host: FakeHost, messages: HostMessage[]): Promise<void> {
  await host.fire("agent_end", { messages, willContinue: false });
}

const RULE_TEXT = "From now on always reply in French.";
const RULE_ADDED = "OptChat rule r1 added";

/** The answers of a call judged as destructive. */
function destructiveAnswers(): Record<string, Answer> {
  return {
    risk: choice("destructive", { safe: 0, risky: 0, destructive: 1 }),
    deletes: noul(0.9),
    remote: noul(0),
    shared: noul(0),
  };
}

describe("System One config", () => {
  test("every gate is on by default, with the documented thresholds", () => {
    const config = readConfig(flagsOf({}), "/tmp/unused");
    expect(config.gates).toEqual({
      rules: true,
      prefetch: true,
      valueScore: true,
      toolGate: true,
      ruleAdd: 0.8,
      prefetchK: 8,
      prefetchMin: 0.5,
      toolAsk: 0.3,
    });
    expect(DEFAULTS.ruleAdd).toBe(0.8);
  });

  test("each opt-out turns its gate off, even when the gate flag is present", () => {
    const config = readConfig(
      flagsOf({ "optchat-rules": true, "no-optchat-rules": true, "no-optchat-value-score": true }),
      "/tmp/unused",
    );
    expect(config.gates).toMatchObject({ rules: false, prefetch: true, valueScore: false, toolGate: true });
  });

  test("malformed gate values fail closed", () => {
    const malformed: Array<Record<string, string | boolean>> = [
      { "optchat-rule-add": "0" },
      { "optchat-rule-add": "1.5" },
      { "optchat-tool-ask": "-0.1" },
      { "optchat-prefetch-min": "abc" },
      { "optchat-prefetch-k": "0" },
      { "optchat-prefetch-k": "33" },
      { "optchat-rules": "maybe" },
      { "no-optchat-prefetch": "maybe" },
    ];
    for (const flags of malformed) {
      expect(() => readConfig(flagsOf(flags), "/tmp/unused")).toThrow();
    }
  });

  test("a malformed tool-gate flag still registers the gate, so it blocks instead of running unscreened", () => {
    expect(toolGateRequested(flagsOf({}))).toBe(true);
    expect(toolGateRequested(flagsOf({ "no-optchat-tool-gate": true, "optchat-tool-gate": true }))).toBe(false);
    expect(toolGateRequested(flagsOf({ "optchat-tool-gate": "maybe" }))).toBe(true);
    expect(toolGateRequested(flagsOf({ "no-optchat-tool-gate": "maybe" }))).toBe(true);
  });
});

describe("rules ledger", () => {
  test("adds, replaces and removes rules, and replays the same state", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(dir);
    const first = ledger.add(3, "reply in French", 1);
    ledger.add(5, "use tabs", 2);
    const replaced = ledger.replace(first.id, 7, "reply in German", 3);
    expect(ledger.active().map((rule) => rule.id)).toEqual(["r2", "r3"]);
    expect(replaced.text).toBe("reply in German");
    expect(ledger.remove("r2", 4)).toBe(true);
    expect(ledger.remove("r2", 5)).toBe(false);
    ledger.close();

    const replayed = RuleLedger.open(dir);
    expect(replayed.active()).toEqual([{ id: "r3", text: "reply in German", source: 7, at: 3 }]);
  });

  test("an id is never reused, even after the newest rule is removed", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(dir);
    ledger.add(1, "first", 1);
    ledger.remove("r1", 2);
    ledger.close();
    const reopened = RuleLedger.open(dir);
    expect(reopened.add(2, "second", 3).id).toBe("r2");
  });

  test("a torn last line is skipped, and the next append starts on a fresh line", async () => {
    const dir = await tempDir();
    const good = JSON.stringify({ op: "add", id: "r1", text: "kept", source: 1, at: 1 });
    await writeFile(join(dir, LEDGER_FILE), `${good}\n{"op":"add","id":"r2"`);
    const ledger = RuleLedger.open(dir);
    expect(ledger.active().map((rule) => rule.id)).toEqual(["r1"]);
    ledger.add(2, "after the tear", 2);
    ledger.close();
    expect(RuleLedger.open(dir).active().map((rule) => rule.text)).toEqual(["kept", "after the tear"]);
  });

  test("malformed lines are skipped, not fatal", async () => {
    const dir = await tempDir();
    const good = JSON.stringify({ op: "add", id: "r1", text: "kept", source: 1, at: 1 });
    await writeFile(join(dir, LEDGER_FILE), `not json\n[1,2]\n${good}\n`);
    expect(RuleLedger.open(dir).active().map((rule) => rule.id)).toEqual(["r1"]);
  });

  test("a closed ledger refuses writes, and replace needs an active rule", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(dir);
    expect(() => ledger.replace("r9", 1, "x", 1)).toThrow("no active rule r9");
    ledger.close();
    expect(() => ledger.add(1, "late", 1)).toThrow("closed");
  });

  test("clipRule flattens lines and cuts long text at a UTF-8 boundary with a pointer", () => {
    expect(clipRule("a\r\nb\nc", 4)).toBe("a b c");
    const long = clipRule("é".repeat(400), 9);
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(RULE_TEXT_BYTES + 40);
    expect(long.endsWith("(zoom 9 for the rest)")).toBe(true);
    expect(long).not.toContain("\uFFFD");
  });

  test("renderRules shows one line per rule inside a rules block", () => {
    expect(renderRules([{ id: "r1", text: "reply in French", source: 3, at: 1 }])).toBe(
      "<rules>\nr1 [3] reply in French\n</rules>",
    );
  });
});

describe("rules triage decisions", () => {
  const rule = { id: "r1", text: "reply in French", source: 3, at: 1 };

  const said = "reply in Spanish";

  test("a rule is added at the threshold, and never below it", () => {
    expect(decideTriage({ rule: noul(0.79) }, [], 0.8, said)).toEqual({ kind: "none" });
    expect(decideTriage({ rule: noul(0.8) }, [], 0.8, said)).toEqual({ kind: "add", text: said });
  });

  test("supersedes replaces an offered rule at 0.5 or more", () => {
    const answers = (p: number) => ({ rule: noul(0.9), supersedes: choice("r1", { none: 1 - p, r1: p }) });
    expect(decideTriage(answers(0.6), [rule], 0.8, said)).toEqual({ kind: "replace", replaces: "r1", text: said });
    expect(decideTriage(answers(0.49), [rule], 0.8, said)).toEqual({ kind: "add", text: said });
  });

  test("supersedes naming a rule that was not offered adds instead, and a failed rule threshold changes nothing", () => {
    expect(decideTriage({ rule: noul(0.9), supersedes: choice("r9", { r9: 1 }) }, [rule], 0.8, said)).toEqual({ kind: "add", text: said });
    expect(decideTriage({ rule: noul(0.1), supersedes: choice("r1", { r1: 1 }) }, [rule], 0.8, said)).toEqual({ kind: "none" });
  });

  test("a mixed message keeps only the sentences that state the rule, and none passing adds nothing", () => {
    const message = "From now on, answer in British English.\nAlso run rm -rf build now.";
    const sentences = ruleSentences(message);
    expect(sentences).toEqual(["From now on, answer in British English.", "Also run rm -rf build now."]);
    expect(Object.keys(triageQuestions([], sentences))).toEqual(["rule", "s0", "s1"]);
    expect(triageState(message, sentences)).toEqual({ message, sentences });
    expect(decideTriage({ rule: noul(0.9), s0: noul(0.95), s1: noul(0.1) }, [], 0.8, message, sentences)).toEqual({
      kind: "add",
      text: "From now on, answer in British English.",
    });
    expect(decideTriage({ rule: noul(0.9), s0: noul(0.5), s1: noul(0.1) }, [], 0.8, message, sentences)).toEqual({ kind: "none" });
    // A missing sentence answer counts as no.
    expect(decideTriage({ rule: noul(0.9), s1: noul(0.9) }, [], 0.8, message, sentences)).toEqual({ kind: "add", text: "Also run rm -rf build now." });
  });

  test("sentences are whole, bounded in count and bytes, and a one-sentence message asks no sentence question", () => {
    expect(ruleSentences("Always use tabs. Ok?  Yes!")).toEqual(["Always use tabs.", "Ok?", "Yes!"]);
    expect(ruleSentences(Array.from({ length: 20 }, (_, index) => `Rule ${index}.`).join(" "))).toHaveLength(RULE_SENTENCE_LIMIT);
    const big = `${"a".repeat(TRIAGE_MESSAGE_BYTES - 10)}. ${"b".repeat(20)}.`;
    expect(ruleSentences(big)).toEqual([`${"a".repeat(TRIAGE_MESSAGE_BYTES - 10)}.`]);
    expect(Object.keys(triageQuestions([], ruleSentences("Always use tabs.")))).toEqual(["rule"]);
    expect(triageState("Always use tabs.", ["Always use tabs."])).toEqual({ message: "Always use tabs." });
  });

  test("supersedes is asked only when rules exist, and offers the newest 32", () => {
    expect(Object.keys(triageQuestions([]))).toEqual(["rule"]);
    expect(Object.keys(triageQuestions([rule]))).toEqual(["rule", "supersedes"]);
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `r${index + 1}`, text: "x", source: 1, at: 1 }));
    expect(offeredRules(many).map((entry) => entry.id)[0]).toBe("r9");
    expect(offeredRules(many)).toHaveLength(32);
  });
});

describe("prefetch", () => {
  const line = (id: number, text: string) => ({ id, n: 2, text });

  /** A view whose zoom echoes the line so the block's content is checkable. */
  function viewOf(lines: Array<{ id: number; n: number; text: string }>): PrefetchMemory {
    return {
      viewLines: () => lines,
      zoom: (id, n) => {
        const found = lines.find((entry) => entry.id === id && entry.n === n);
        if (!found) throw new Error(`no line ${id}+${n}`);
        return { text: `<line id="${id}">${found.text}</line>` };
      },
    };
  }

  test("the top lines at or above the minimum are zoomed in id order, under the header", async () => {
    const memory = viewOf([line(1, "hotel booking"), line(2, "deploy notes"), line(3, "weather"), line(4, "stale")]);
    const judge = fakeJudge((request) => {
      const probabilities: Record<string, number> = { "1+2": 0.9, "2+2": 0.2, "3+2": 0.7, "4+2": 0.6 };
      return Object.fromEntries(Object.keys(request.questions).map((key) => [key, noul(probabilities[key] ?? 0)]));
    });
    const block = await prefetchBlock(memory, { judge, message: "book the hotel", k: 2, min: 0.5 });
    expect(block).toBe(
      ["<prefetch>", PREFETCH_HEADER, '<line id="1">hotel booking</line>', '<line id="3">weather</line>', "</prefetch>"].join("\n"),
    );
    expect(judge.requests[0]!.state).toMatchObject({ message: "book the hotel" });
  });

  test("no view lines means no judge call and no block", async () => {
    const judge = fakeJudge(() => ({}));
    expect(await prefetchBlock(viewOf([]), { judge, message: "hi", k: 8, min: 0.5 })).toBeUndefined();
    expect(judge.requests).toHaveLength(0);
  });

  test("a judge that fails leaves nothing prefetched", async () => {
    const judge = fakeJudge(() => {
      throw new Error("provider down");
    });
    expect(await prefetchBlock(viewOf([line(1, "x")]), { judge, message: "hi", k: 8, min: 0.5 })).toBeUndefined();
  });

  // Real timer on purpose: the bound is a wall-clock constant of prefetchBlock, and the test asserts it holds.
  test("a judge that never answers is abandoned at the bound", async () => {
    const hung = { label: "hung", judge: () => Promise.withResolvers<never>().promise };
    const started = Date.now();
    const block = await prefetchBlock(viewOf([line(1, "x")]), { judge: hung, message: "hi", k: 8, min: 0.5, timeoutMs: 50 });
    expect(block).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the judged lines are packed into requests within the state and question bounds", async () => {
    const big = "x".repeat(1_000);
    const lines = Array.from({ length: 100 }, (_, index) => line(index + 1, big));
    const judge = fakeJudge(() => ({}));
    await prefetchBlock(viewOf(lines), { judge, message: "hi", k: 8, min: 0.5 });
    expect(judge.requests.length).toBeGreaterThan(1);
    for (const request of judge.requests) {
      expect(JSON.stringify(request.state).length).toBeLessThanOrEqual(PREFETCH_STATE_BYTES);
      expect(Object.keys(request.questions).length).toBeLessThanOrEqual(PREFETCH_QUESTIONS);
    }
  });
});

describe("value hint", () => {
  test("a label and an importance level become one fixed sentence", async () => {
    const judge = fakeJudge(() => ({
      label: choice("decision", { decision: 0.9, preference: 0.05, finding: 0.03, noise: 0.02 }),
      importance: score(1.8),
    }));
    const hint = await valueHint(judge, { kind: "user", text: "we chose postgres" }, new AbortController().signal);
    expect(hint).toBe("This record is a decision; keep the choice and its reason. Its importance is high.");
  });

  test("the hint never carries the record's words", async () => {
    const judge = fakeJudge(() => ({
      label: choice("preference", { decision: 0, preference: 1, finding: 0, noise: 0 }),
      importance: score(0.2),
    }));
    const hint = await valueHint(judge, { kind: "user", text: "SECRET-ACCOUNT-7731 wants lunch" }, new AbortController().signal);
    expect(hint).toBeDefined();
    expect(hint).not.toContain("SECRET");
    expect(hint).not.toContain("7731");
  });

  test("a label outside the vocabulary, or a failed judge, yields no hint", async () => {
    const outside = fakeJudge(() => ({ label: choice("greeting", { greeting: 1 }), importance: score(1) }));
    expect(await valueHint(outside, { kind: "user", text: "x" }, new AbortController().signal)).toBeUndefined();
    const failing = fakeJudge(() => {
      throw new Error("boom");
    });
    expect(await valueHint(failing, { kind: "user", text: "x" }, new AbortController().signal)).toBeUndefined();
  });
});

describe("tool gate", () => {
  const harmless = {
    risk: choice("safe", { safe: 1, risky: 0, destructive: 0 }),
    deletes: noul(0.1),
    remote: noul(0),
    shared: noul(0),
  };
  const call = { toolName: "bash", input: { command: "rm -rf build" }, cwd: "/tmp" };
  const noUi = { hasUI: false, confirm: async () => false };

  test("exempt tools never reach the judge", async () => {
    const judge = fakeJudge(() => destructiveAnswers());
    expect(EXEMPT_TOOLS.read).toBe(true);
    const result = await gateToolCall({ toolName: "read", input: {}, cwd: "/tmp" }, { judge, toolAsk: 0.3, ui: noUi });
    expect(result).toBeUndefined();
    expect(judge.requests).toHaveLength(0);
  });

  test("a call below the threshold runs; at or above it is blocked when there is no UI", async () => {
    expect(await gateToolCall(call, { judge: fakeJudge(() => harmless), toolAsk: 0.3, ui: noUi })).toBeUndefined();
    const blocked = await gateToolCall(call, { judge: fakeJudge(() => destructiveAnswers()), toolAsk: 0.3, ui: noUi });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("no UI to confirm");
  });

  test("with a UI, the user decides: approval runs the call, decline blocks it", async () => {
    const asked: string[] = [];
    const approve = {
      hasUI: true,
      confirm: async (title: string) => {
        asked.push(title);
        return true;
      },
    };
    expect(await gateToolCall(call, { judge: fakeJudge(() => destructiveAnswers()), toolAsk: 0.3, ui: approve })).toBeUndefined();
    expect(asked).toEqual(["OptChat tool gate: bash"]);
    const decline = { hasUI: true, confirm: async () => false };
    const declined = await gateToolCall(call, { judge: fakeJudge(() => destructiveAnswers()), toolAsk: 0.3, ui: decline });
    expect(declined?.block).toBe(true);
    expect(declined?.reason).toContain("declined");
  });

  test("a judge failure fails closed and is reported with a bounded reason", async () => {
    const reports: string[] = [];
    const judge = fakeJudge(() => {
      throw new Error("provider down");
    });
    const result = await gateToolCall(call, { judge, toolAsk: 0.3, ui: noUi, report: (failure) => reports.push(failure) });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("the judge failed");
    expect(reports).toEqual(["provider down"]);
  });

  test("no judge candidate fails closed", async () => {
    const result = await gateToolCall(call, { judge: undefined, toolAsk: 0.3, ui: noUi });
    expect(result?.block).toBe(true);
  });

  test("an input that cannot be serialized is a judge failure, never a throw", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const judge = fakeJudge(() => harmless);
    const result = await gateToolCall({ toolName: "bash", input: cyclic, cwd: "/tmp" }, { judge, toolAsk: 0.3, ui: noUi });
    expect(result?.block).toBe(true);
    expect(judge.requests).toHaveLength(0);
  });

  test("danger is the largest of destructive, deletes, remote and shared", () => {
    expect(dangerOf(choice("risky", { safe: 0.2, risky: 0.5, destructive: 0.3 }), noul(0.1), noul(0.4), noul(0.2))).toBe(0.4);
  });
});

describe("System One through OptChat", () => {
  test("every gate opted out: the judge is never resolved, no tool handler is registered, and context has no System One messages", async () => {
    let resolved = 0;
    const host = await openFakeHost(
      createOptChat({
        judge: () => {
          resolved++;
          return fakeJudge(() => ({}));
        },
      }),
      {
        flags: {
          "no-optchat-rules": true,
          "no-optchat-prefetch": true,
          "no-optchat-value-score": true,
          "no-optchat-tool-gate": true,
        },
      },
    );
    hosts.push(host);
    const texts = await contextTexts(host, [host.user(RULE_TEXT)]);
    expect(texts).toHaveLength(2);
    expect(texts.some((text) => text.includes("<rules>") || text.includes("<prefetch>"))).toBe(false);
    expect(host.handlers.get("tool_call")).toBeUndefined();
    expect(resolved).toBe(0);
  });

  test("rules: a stated rule is judged, written, announced, and shown to later requests", async () => {
    const judge = fakeJudge(() => ({ rule: noul(0.95) }));
    const host = await start({ "optchat-rules": true }, judge);
    const first = host.user(RULE_TEXT);
    await contextTexts(host, [first]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith(RULE_ADDED)), "rule r1");
    expect(await ledgerText(host.directory)).toContain(RULE_TEXT);
    expect(judge.requests[0]!.questions).toHaveProperty("rule");

    // The first turn froze its System One messages before the rule existed; the next turn must carry it.
    const reply = host.assistant("Understood.");
    await endRun(host, [first, reply]);
    const texts = await contextTexts(host, [first, reply, host.user("What time is it?")]);
    expect(texts.some((text) => text.includes("<rules>") && text.includes(RULE_TEXT))).toBe(true);
  });

  test("a rule written mid-turn does not change the System One messages of that turn's tool loop", async () => {
    const judge = fakeJudge(() => ({ rule: noul(0.95) }));
    const host = await start({ "optchat-rules": true }, judge);
    const first = host.user(RULE_TEXT);
    await contextTexts(host, [first]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith(RULE_ADDED)), "rule r1");

    // A tool call and its result inside the same turn: the request carries the frozen view, not the new rule.
    const call = host.assistant("checking", { id: "t1", name: "bash", arguments: { command: "pwd" } });
    const texts = await contextTexts(host, [first, call, host.toolResult("t1", "bash", "/tmp")]);
    expect(texts.some((text) => text.includes("<rules>"))).toBe(false);
  });

  test("rules remove ID removes the rule, and the list is empty afterwards", async () => {
    const judge = fakeJudge(() => ({ rule: noul(0.95) }));
    const host = await start({ "optchat-rules": true }, judge);
    await contextTexts(host, [host.user(RULE_TEXT)]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith(RULE_ADDED)), "rule r1");
    const removed = await host.command("rules remove r1");
    expect(removed.at(-1)?.message).toBe("OptChat rule r1 removed.");
    const listed = await host.command("rules");
    expect(listed.at(-1)?.message).toBe("OptChat has no standing rules.");
  });

  test("a judge failure is recorded for status and does not stop the session", async () => {
    const judge = fakeJudge(() => {
      throw new Error("provider down");
    });
    const host = await start({ "optchat-rules": true }, judge);
    const first = host.user(RULE_TEXT);
    await contextTexts(host, [first]);
    await waitFor(async () => {
      const status = await host.command("status");
      return status.some((notice) => notice.message.includes("last System One failure: rules: provider down"));
    }, "the recorded failure");
    await endRun(host, [first]);
    // A new turn after the failure still gets its view and the new message: the session keeps working.
    const texts = await contextTexts(host, [first, host.user("still working")]);
    expect(texts).toHaveLength(2);
  });

  test("no judge candidate: the session still runs, and status says why", async () => {
    const host = await start({ "optchat-rules": true, "optchat-prefetch": true });
    const status = await host.command("status");
    expect(status.some((notice) => notice.message.includes("System One gates: rules on, prefetch on, value-score on, tool-gate on"))).toBe(true);
    expect(status.some((notice) => notice.message.includes("judge: none"))).toBe(true);
    const texts = await contextTexts(host, [host.user("hello")]);
    expect(texts).toHaveLength(2);
  });

  test("the host judge factory never throws, even when the host registry is unusable", () => {
    const broken = { modelRegistry: {}, sessionManager: undefined, model: undefined } as unknown as ExtensionContext;
    expect(hostJudge(broken, "optchat-rules")).toBeUndefined();
  });

  test("shutdown waits for a pending triage write before the store closes", async () => {
    const held = Promise.withResolvers<Record<string, Answer>>();
    const judge = fakeJudge(() => held.promise);
    const host = await start({ "optchat-rules": true }, judge);
    await contextTexts(host, [host.user(RULE_TEXT)]);
    await waitFor(() => judge.requests.length === 1, "the triage judgment to start");

    const closing = host.shutdown();
    await macrotask();
    // Shutdown is now waiting on the triage: the judge answers after the close began, and the write must still land.
    held.resolve({ rule: noul(0.95) });
    await closing;
    expect(await ledgerText(host.directory)).toContain(RULE_TEXT);
    expect(host.notices.some((notice) => notice.message.startsWith(RULE_ADDED))).toBe(true);
  });

  // Real timer on purpose: the shutdown bound is a wall-clock constant (1.5 s), and the test asserts it holds.
  test("a hung judge is abandoned at the shutdown bound, and its late answer writes nothing", async () => {
    const never = Promise.withResolvers<Record<string, Answer>>();
    const judge = fakeJudge(() => never.promise);
    const host = await start({ "optchat-rules": true }, judge);
    await contextTexts(host, [host.user(RULE_TEXT)]);
    await waitFor(() => judge.requests.length === 1, "the triage judgment to start");

    const started = Date.now();
    await host.shutdown();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(2_000);

    never.resolve({ rule: noul(0.95) });
    await macrotask();
    expect(await ledgerText(host.directory)).not.toContain(RULE_TEXT);
    expect(host.notices.some((notice) => notice.message.startsWith("OptChat rule"))).toBe(false);
  });

  test("the tool gate blocks a risky call without a UI, asks with one, and never judges exempt tools", async () => {
    const judge = fakeJudge(() => destructiveAnswers());
    const host = await start({ "optchat-tool-gate": true }, judge, { hasUI: false });
    const blocked = (await host.fire("tool_call", { toolName: "bash", input: { command: "rm -rf build" } }))[0] as
      | { block?: boolean }
      | undefined;
    expect(blocked?.block).toBe(true);

    const exempt = (await host.fire("tool_call", { toolName: "read", input: { path: "x" } }))[0];
    expect(exempt).toBeUndefined();
    expect(judge.requests).toHaveLength(1);

    const asked = await start({ "optchat-tool-gate": true }, judge, { hasUI: true, confirm: () => true });
    const approved = (await asked.fire("tool_call", { toolName: "bash", input: { command: "rm -rf build" } }))[0];
    expect(approved).toBeUndefined();
    expect(asked.confirms).toHaveLength(1);
  });

  test("status lists every gate's state", async () => {
    const host = await start({ "no-optchat-prefetch": true, "no-optchat-value-score": true }, fakeJudge(() => ({})));
    const status = await host.command("status");
    expect(status.some((notice) => notice.message.includes("System One gates: rules on, prefetch off, value-score off, tool-gate on"))).toBe(true);
  });
});
