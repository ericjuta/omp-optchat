import { afterEach, describe, expect, test } from "bun:test";
import type { Answer } from "@oh-my-pi/pi-ai";
import { Settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, readConfig } from "../src/config.ts";
import { createOptChat } from "../src/index.ts";
import { hostJudge, sessionFallbackOf } from "../src/system1/judge.ts";
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
  type TriageDecision,
} from "../src/system1/rules.ts";
import { valueHint } from "../src/system1/value.ts";
import { choice, fakeJudge, noul, score, sessionFallbackJudge, type FakeJudge } from "./helpers/fake-judge.ts";
import { openFakeHost, type FakeHost, type FakeHostOptions, type HostMessage } from "./helpers/fake-host.ts";
import { holdTimers } from "./helpers/held-timer.ts";
import { Harness, SEED_TEXTS, SMALL_NODES, talk } from "./helpers/system1-chat.ts";

const dirs: string[] = [];
const hosts: FakeHost[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const harness of harnesses.splice(0)) await harness.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "optchat-s1-"));
  dirs.push(dir);
  return dir;
}

/** A flag reader for readConfig. */
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
const RULES_ONLY = {
  "optchat-rules": true,
  "no-optchat-prefetch": true,
  "no-optchat-value-score": true,
  "no-optchat-recall": true,
};

describe("System One config", () => {
  test("every gate is on by default, with the documented thresholds", () => {
    const config = readConfig(flagsOf({}), "/tmp/unused");
    expect(config.gates).toEqual({
      rules: true,
      prefetch: true,
      valueScore: true,
      recall: true,
      ruleAdd: 0.8,
      prefetchK: 8,
      prefetchMin: 0.5,
      recallMin: 0.5,
      recallK: 1,
      recallSeeds: 8,
    });
    expect(DEFAULTS.ruleAdd).toBe(0.8);
  });

  test("recall is on by default; --no-optchat-recall wins over --optchat-recall", () => {
    expect(readConfig(flagsOf({}), "/tmp/unused").gates.recall).toBe(true);
    expect(readConfig(flagsOf({ "optchat-recall": true }), "/tmp/unused").gates.recall).toBe(true);
    expect(readConfig(flagsOf({ "optchat-recall": true, "no-optchat-recall": true }), "/tmp/unused").gates.recall).toBe(false);
    expect(readConfig(flagsOf({ "no-optchat-recall": "true" }), "/tmp/unused").gates.recall).toBe(false);
  });

  test("recall-min parses a probability in (0, 1] and defaults to 0.5", () => {
    expect(readConfig(flagsOf({}), "/tmp/unused").gates.recallMin).toBe(0.5);
    expect(readConfig(flagsOf({ "optchat-recall-min": "0.7" }), "/tmp/unused").gates.recallMin).toBe(0.7);
    expect(readConfig(flagsOf({ "optchat-recall-min": "1" }), "/tmp/unused").gates.recallMin).toBe(1);
  });

  test("each opt-out turns its gate off, even when the gate flag is present", () => {
    const config = readConfig(
      flagsOf({ "optchat-rules": true, "no-optchat-rules": true, "no-optchat-value-score": true }),
      "/tmp/unused",
    );
    expect(config.gates).toMatchObject({ rules: false, prefetch: true, valueScore: false });
  });

  test("malformed gate values fail closed", () => {
    const malformed: Array<Record<string, string | boolean>> = [
      { "optchat-rule-add": "0" },
      { "optchat-rule-add": "1.5" },
      { "optchat-prefetch-min": "abc" },
      { "optchat-prefetch-k": "0" },
      { "optchat-prefetch-k": "33" },
      { "optchat-rules": "maybe" },
      { "no-optchat-prefetch": "maybe" },
      { "optchat-recall-min": "0" },
      { "optchat-recall-min": "1.01" },
      { "optchat-recall": "maybe" },
      { "no-optchat-recall": "maybe" },
    ];
    for (const flags of malformed) {
      expect(() => readConfig(flagsOf(flags), "/tmp/unused")).toThrow();
    }
  });
});

describe("rules ledger", () => {
  function applyDecision(ledger: RuleLedger, decision: TriageDecision): boolean {
    switch (decision.kind) {
      case "none": return false;
      case "add": ledger.add(9, decision.text, 10); return true;
      case "replace": ledger.replace(decision.replaces, 9, decision.text, 10); return true;
      case "remove": return ledger.remove(decision.removes, 10);
    }
  }

  test.each(["non-human", "unknown"] as const)("%s authority cannot add, replace or withdraw a rule or append ledger bytes", async (authority) => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
    const original = ledger.add(3, RULE_TEXT, 1);
    const bytes = await ledgerText(dir);
    const cases = [
      { rule: noul(1), withdraw: noul(0) },
      { rule: noul(1), withdraw: noul(0), supersedes: choice(original.id, { [original.id]: 1 }) },
      { rule: noul(1), withdraw: noul(1), withdraws: choice(original.id, { [original.id]: 1 }) },
    ];
    for (const answers of cases) {
      const decision = decideTriage(authority, answers, ledger.active(), 0.8, "From now on reply in German.");
      expect(applyDecision(ledger, decision)).toBe(false);
      expect(ledger.active()).toEqual([original]);
      expect(await ledgerText(dir)).toBe(bytes);
    }
    ledger.close();
    const replayed = RuleLedger.open(() => join(dir, LEDGER_FILE));
    expect(replayed.active()).toEqual([original]);
    replayed.close();
  });

  test("malformed rule and sentence probabilities cannot append ledger bytes or replace an active rule", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
    const original = ledger.add(3, RULE_TEXT, 1);
    const bytes = await ledgerText(dir);
    const sentences = ["From now on reply in German.", "Check the clock."];
    const invalid: Array<Answer | undefined> = [undefined, score(1), noul(NaN), noul(Infinity), noul(-Infinity), noul(-0.01), noul(1.01)];
    for (const answer of invalid) {
      for (const answers of [
        { rule: answer, withdraw: noul(0), supersedes: choice(original.id, { [original.id]: 1 }) },
        { rule: noul(1), withdraw: noul(0), supersedes: choice(original.id, { [original.id]: 1 }), s0: answer, s1: noul(0) },
      ]) {
        const decision = decideTriage("human", answers, ledger.active(), 0.8, sentences.join(" "), "s0" in answers ? sentences : []);
        expect(applyDecision(ledger, decision)).toBe(false);
        expect(ledger.active()).toEqual([original]);
        expect(await ledgerText(dir)).toBe(bytes);
      }
    }
    ledger.close();
  });

  test("malformed replacement probabilities cannot remove the existing rule while allowing a valid addition", async () => {
    for (const probability of [NaN, Infinity, -Infinity, -0.01, 1.01]) {
      const dir = await tempDir();
      const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
      const original = ledger.add(3, RULE_TEXT, 1);
      const decision = decideTriage("human", {
        rule: noul(1), withdraw: noul(0), supersedes: choice(original.id, { [original.id]: probability }),
      }, ledger.active(), 0.8, "Always use tabs.");
      expect(decision).toEqual({ kind: "add", text: "Always use tabs." });
      expect(applyDecision(ledger, decision)).toBe(true);
      expect(ledger.active()).toEqual([original, { id: "r2", source: 9, at: 10, text: "Always use tabs." }]);
      ledger.close();
      const replayed = RuleLedger.open(() => join(dir, LEDGER_FILE));
      expect(replayed.active()).toEqual([original, { id: "r2", source: 9, at: 10, text: "Always use tabs." }]);
      replayed.close();
    }
  });

  test("duplicate and unknown withdrawals neither append ledger bytes nor add a rule", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
    const original = ledger.add(3, RULE_TEXT, 1);
    const retained = ledger.add(4, "Always use tabs.", 2);
    const offered = ledger.active();
    const answers = (id: string) => ({ rule: noul(1), withdraw: noul(1), withdraws: choice(id, { [id]: 1 }) });
    expect(applyDecision(ledger, decideTriage("human", answers(original.id), offered, 0.8, "Stop replying in French."))).toBe(true);
    const bytes = await ledgerText(dir);
    // A stale offered snapshot may still decide to remove r1; the ledger must not append a second removal.
    expect(applyDecision(ledger, decideTriage("human", answers(original.id), offered, 0.8, "Stop replying in French."))).toBe(false);
    expect(applyDecision(ledger, decideTriage("human", answers("r99"), ledger.active(), 0.8, "Forget that other rule."))).toBe(false);
    expect(ledger.active()).toEqual([retained]);
    expect(await ledgerText(dir)).toBe(bytes);
    ledger.close();
    const replayed = RuleLedger.open(() => join(dir, LEDGER_FILE));
    expect(replayed.active()).toEqual([retained]);
    replayed.close();
  });

  test("a withdrawal judged against a replaced rule cannot remove or revive its replacement", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
    const original = ledger.add(3, RULE_TEXT, 1);
    const offered = ledger.active();
    const held = Promise.withResolvers<Record<string, Answer>>();
    const judge = fakeJudge(() => held.promise);
    const message = "Stop replying in French.";
    const pending = judge.judge({ state: triageState(message, []), questions: triageQuestions(offered) });
    expect(judge.requests).toHaveLength(1);
    const replacement = ledger.replace(original.id, 4, "From now on reply in German.", 2);
    const bytes = await ledgerText(dir);
    held.resolve({ rule: noul(1), withdraw: noul(1), withdraws: choice(original.id, { [original.id]: 1 }) });
    const decision = decideTriage("human", (await pending).answers, offered, 0.8, message);
    expect(decision).toEqual({ kind: "remove", removes: original.id });
    expect(applyDecision(ledger, decision)).toBe(false);
    expect(ledger.active()).toEqual([replacement]);
    expect(await ledgerText(dir)).toBe(bytes);
    ledger.close();
    const replayed = RuleLedger.open(() => join(dir, LEDGER_FILE));
    expect(replayed.active()).toEqual([replacement]);
    replayed.close();
  });

  test("adds, replaces and removes rules, and replays the same state", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
    const first = ledger.add(3, "reply in French", 1);
    ledger.add(5, "use tabs", 2);
    const replaced = ledger.replace(first.id, 7, "reply in German", 3);
    expect(ledger.active().map((rule) => rule.id)).toEqual(["r2", "r3"]);
    expect(replaced.text).toBe("reply in German");
    expect(ledger.remove("r2", 4)).toBe(true);
    expect(ledger.remove("r2", 5)).toBe(false);
    ledger.close();

    const replayed = RuleLedger.open(() => join(dir, LEDGER_FILE));
    expect(replayed.active()).toEqual([{ id: "r3", text: "reply in German", source: 7, at: 3 }]);
  });

  test("an id is never reused, even after the newest rule is removed", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
    ledger.add(1, "first", 1);
    ledger.remove("r1", 2);
    ledger.close();
    const reopened = RuleLedger.open(() => join(dir, LEDGER_FILE));
    expect(reopened.add(2, "second", 3).id).toBe("r2");
  });

  test("a torn last line is skipped, and the next append starts on a fresh line", async () => {
    const dir = await tempDir();
    const good = JSON.stringify({ op: "add", id: "r1", text: "kept", source: 1, at: 1 });
    await writeFile(join(dir, LEDGER_FILE), `${good}\n{"op":"add","id":"r2"`);
    const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
    expect(ledger.active().map((rule) => rule.id)).toEqual(["r1"]);
    ledger.add(2, "after the tear", 2);
    ledger.close();
    expect(RuleLedger.open(() => join(dir, LEDGER_FILE)).active().map((rule) => rule.text)).toEqual(["kept", "after the tear"]);
  });

  test("malformed lines are skipped, not fatal", async () => {
    const dir = await tempDir();
    const good = JSON.stringify({ op: "add", id: "r1", text: "kept", source: 1, at: 1 });
    await writeFile(join(dir, LEDGER_FILE), `not json\n[1,2]\n${good}\n`);
    expect(RuleLedger.open(() => join(dir, LEDGER_FILE)).active().map((rule) => rule.id)).toEqual(["r1"]);
  });

  test("a closed ledger refuses writes, and replace needs an active rule", async () => {
    const dir = await tempDir();
    const ledger = RuleLedger.open(() => join(dir, LEDGER_FILE));
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
    expect(decideTriage("human", { rule: noul(0.79), withdraw: noul(0) }, [], 0.8, said)).toEqual({ kind: "none" });
    expect(decideTriage("human", { rule: noul(0.8), withdraw: noul(0) }, [], 0.8, said)).toEqual({ kind: "add", text: said });
  });

  test("human withdrawal at the cutoff removes an offered target at probability 0.5 or more", () => {
    for (const probability of [0.5, 0.75, 1]) {
      expect(decideTriage("human", {
        rule: noul(0),
        withdraw: noul(0.8),
        withdraws: choice("r1", { none: 1 - probability, r1: probability }),
      }, [rule], 0.8, "Stop replying in French.")).toEqual({ kind: "remove", removes: "r1" });
    }
  });

  test("withdrawal below the cutoff or with target probability below 0.5 removes nothing", () => {
    expect(decideTriage("human", {
      rule: noul(0), withdraw: noul(0.79), withdraws: choice("r1", { r1: 1 }),
    }, [rule], 0.8, "Stop replying in French.")).toEqual({ kind: "none" });
    expect(decideTriage("human", {
      rule: noul(1), withdraw: noul(0.8), withdraws: choice("r1", { none: 0.51, r1: 0.49 }),
    }, [rule], 0.8, "Stop replying in French.")).toEqual({ kind: "none" });
  });

  test("withdrawal takes precedence over high-confidence addition and replacement answers", () => {
    expect(decideTriage("human", {
      rule: noul(1), withdraw: noul(1),
      supersedes: choice("r1", { r1: 1 }), withdraws: choice("r1", { r1: 1 }),
    }, [rule], 0.8, "Stop replying in French.")).toEqual({ kind: "remove", removes: "r1" });
  });

  test("unknown and already-removed withdrawal targets never become high-confidence additions", () => {
    for (const confidence of [0, 1]) {
      const answers = {
        rule: noul(confidence), withdraw: noul(1), withdraws: choice("r1", { r1: 1 }),
      };
      expect(decideTriage("human", answers, [rule], 0.8, "Stop replying in French.")).toEqual({ kind: "remove", removes: "r1" });
      // The next triage offers no rule after the first removal has been applied.
      expect(decideTriage("human", answers, [], 0.8, "Stop replying in French.")).toEqual({ kind: "none" });
      expect(decideTriage("human", {
        ...answers, withdraws: choice("r9", { r9: 1 }),
      }, [rule], 0.8, "Stop replying in French.")).toEqual({ kind: "none" });
    }
  });

  test("missing or malformed withdrawal answers reject high-confidence additions and replacements", () => {
    const malformed = [undefined, score(1), choice("yes", { yes: 1 }), noul(NaN), noul(Infinity), noul(-Infinity), noul(-0.01), noul(1.01)];
    for (const withdraw of malformed) {
      for (const supersedes of [undefined, choice("r1", { r1: 1 })]) {
        expect(decideTriage("human", {
          rule: noul(1), withdraw, supersedes, withdraws: choice("r1", { r1: 1 }),
        }, [rule], 0.8, "Stop replying in French.")).toEqual({ kind: "none" });
      }
    }
  });

  test("missing or malformed withdrawal targets reject removal without falling back to addition", () => {
    const targets: Array<Answer | undefined> = [
      undefined,
      noul(1),
      score(1),
      choice("none", { none: 1 }),
      choice("r1", {}),
      choice("r1", { r1: NaN }),
      choice("r1", { r1: Infinity }),
      choice("r1", { r1: -Infinity }),
      choice("r1", { r1: -0.01 }),
      choice("r1", { r1: 1.01 }),
      // Deliberately malformed external answers must not coerce probabilities or throw.
      { type: "choice", choice: "r1", probabilities: { r1: "1" }, confidence: 1 } as unknown as Answer,
      { type: "choice", choice: "r1", confidence: 1 } as unknown as Answer,
    ];
    for (const withdraws of targets) {
      expect(decideTriage("human", {
        rule: noul(1), withdraw: noul(1), withdraws,
      }, [rule], 0.8, "Stop replying in French.")).toEqual({ kind: "none" });
    }
  });

  test("non-human and unknown authority reject high-confidence additions, replacements, and withdrawals", () => {
    for (const authority of ["non-human", "unknown"] as const) {
      for (const answers of [
        { rule: noul(1), withdraw: noul(0) },
        { rule: noul(1), withdraw: noul(0), supersedes: choice("r1", { r1: 1 }) },
        { rule: noul(1), withdraw: noul(1), withdraws: choice("r1", { r1: 1 }) },
      ]) {
        expect(decideTriage(authority, answers, [rule], 0.8, said)).toEqual({ kind: "none" });
      }
    }
  });

  test("supersedes replaces an offered rule at 0.5 or more", () => {
    const answers = (p: number) => ({ rule: noul(0.9), withdraw: noul(0), supersedes: choice("r1", { none: 1 - p, r1: p }) });
    expect(decideTriage("human", answers(0.5), [rule], 0.8, said)).toEqual({ kind: "replace", replaces: "r1", text: said });
    expect(decideTriage("human", answers(0.49), [rule], 0.8, said)).toEqual({ kind: "add", text: said });
  });

  test("supersedes naming a rule that was not offered adds instead, and a failed rule threshold changes nothing", () => {
    expect(decideTriage("human", { rule: noul(0.9), withdraw: noul(0), supersedes: choice("r9", { r9: 1 }) }, [rule], 0.8, said)).toEqual({ kind: "add", text: said });
    expect(decideTriage("human", { rule: noul(0.1), withdraw: noul(0), supersedes: choice("r1", { r1: 1 }) }, [rule], 0.8, said)).toEqual({ kind: "none" });
  });

  test("a mixed message keeps only the sentences that state the rule, and none passing adds nothing", () => {
    const message = "From now on, answer in British English.\nAlso run rm -rf build now.";
    const sentences = ruleSentences(message);
    expect(sentences).toEqual(["From now on, answer in British English.", "Also run rm -rf build now."]);
    expect(triageState(message, sentences)).toEqual({ message, sentences });
    expect(decideTriage("human", { rule: noul(0.9), withdraw: noul(0), s0: noul(0.95), s1: noul(0.1) }, [], 0.8, message, sentences)).toEqual({
      kind: "add",
      text: "From now on, answer in British English.",
    });
    expect(decideTriage("human", { rule: noul(0.9), withdraw: noul(0), s0: noul(0.5), s1: noul(0.1) }, [], 0.8, message, sentences)).toEqual({ kind: "none" });
    // A missing sentence answer counts as no.
    expect(decideTriage("human", { rule: noul(0.9), withdraw: noul(0), s1: noul(0.9) }, [], 0.8, message, sentences)).toEqual({ kind: "add", text: "Also run rm -rf build now." });
  });

  test("sentences are whole and bounded in count and bytes, with single-sentence state kept whole", () => {
    expect(ruleSentences("Always use tabs. Ok?  Yes!")).toEqual(["Always use tabs.", "Ok?", "Yes!"]);
    expect(ruleSentences(Array.from({ length: 20 }, (_, index) => `Rule ${index}.`).join(" "))).toHaveLength(RULE_SENTENCE_LIMIT);
    const big = `${"a".repeat(TRIAGE_MESSAGE_BYTES - 10)}. ${"b".repeat(20)}.`;
    expect(ruleSentences(big)).toEqual([`${"a".repeat(TRIAGE_MESSAGE_BYTES - 10)}.`]);
    expect(triageState("Always use tabs.", ["Always use tabs."])).toEqual({ message: "Always use tabs." });
  });

  test("offeredRules keeps the newest 32 rules", () => {
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

  test("a judge that never answers is abandoned at the bound", async () => {
    // The bound's timers are held, then fired by the test: the bound passing is an event, not elapsed time.
    const BOUND_MS = 7_773;
    const timers = holdTimers(BOUND_MS);
    try {
      let judgeSignal: AbortSignal | undefined;
      const hung = {
        label: "hung",
        judge: (_request: unknown, options?: { signal?: AbortSignal }) => {
          judgeSignal = options?.signal;
          return Promise.withResolvers<never>().promise;
        },
      };
      const pending = prefetchBlock(viewOf([line(1, "x")]), { judge: hung, message: "hi", k: 8, min: 0.5, timeoutMs: BOUND_MS });
      await waitFor(() => judgeSignal !== undefined, "the hung judge to be called");
      expect(judgeSignal!.aborted).toBe(false);

      expect(timers.fire()).toBeGreaterThan(0);
      expect(await pending).toBeUndefined();
      expect(judgeSignal!.aborted).toBe(true);
    } finally {
      timers.restore();
    }
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
          "no-optchat-recall": true,
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
    const judge = fakeJudge(() => ({ rule: noul(0.95), withdraw: noul(0) }));
    const host = await start({ "optchat-rules": true }, judge);
    const first = host.user(RULE_TEXT);
    await contextTexts(host, [first]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith(RULE_ADDED)), "rule r1");
    expect(await ledgerText(host.directory)).toContain(RULE_TEXT);

    // The first turn froze its System One messages before the rule existed; the next turn must carry it.
    const reply = host.assistant("Understood.");
    await endRun(host, [first, reply]);
    const texts = await contextTexts(host, [first, reply, host.user("What time is it?")]);
    expect(texts.some((text) => text.includes("<rules>") && text.includes(RULE_TEXT))).toBe(true);
  });

  test("an accepted human withdrawal removes the frozen rule from the next tool-loop context and a reopened host", async () => {
    const dir = await tempDir();
    const held = Promise.withResolvers<Record<string, Answer>>();
    let calls = 0;
    const judge = fakeJudge(() => ++calls === 1 ? { rule: noul(1), withdraw: noul(0) } : held.promise);
    const host = await start(RULES_ONLY, judge, { directory: dir });
    const first = host.user(RULE_TEXT);
    await contextTexts(host, [first]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith(RULE_ADDED)), "the human rule addition");
    const reply = host.assistant("Understood.");
    await endRun(host, [first, reply]);

    const withdrawal = host.user("Stop replying in French.");
    const messages = [first, reply, withdrawal];
    const before = await contextTexts(host, messages);
    await waitFor(() => judge.requests.length === 2, "the human withdrawal judgment");
    expect(before.some((text) => text.includes("<rules>") && text.includes(RULE_TEXT))).toBe(true);

    const firstCall = host.assistant("checking", { id: "before-withdrawal", name: "bash", arguments: { command: "pwd" } });
    messages.push(firstCall, host.toolResult("before-withdrawal", "bash", "/tmp"));
    const beforeAccepted = await contextTexts(host, messages);
    expect(beforeAccepted.some((text) => text.includes("<rules>") && text.includes(RULE_TEXT))).toBe(true);

    held.resolve({ rule: noul(1), withdraw: noul(1), withdraws: choice("r1", { r1: 1 }) });
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith("OptChat rule r1 withdrawn")), "the accepted human withdrawal");
    // Already-returned assemblies retain their contents; the next tool-loop request must omit the withdrawn rule.
    expect((await host.command("rules")).at(-1)?.message).toBe("OptChat has no standing rules.");
    const status = (await host.command("status")).map((notice) => notice.message).join("\n");
    expect(status).toContain("rules counts: 2 judge calls, 0 failures, 1 added, 0 replaced, 1 removed");

    const call = host.assistant("checking", { id: "withdrawal-tool", name: "bash", arguments: { command: "pwd" } });
    const loop = await contextTexts(host, [...messages, call, host.toolResult("withdrawal-tool", "bash", "/tmp")]);
    expect(loop.some((text) => text.includes("<rules>"))).toBe(false);
    await host.shutdown();
    const bytes = await ledgerText(dir);
    const replayed = RuleLedger.open(() => join(dir, LEDGER_FILE));
    expect(replayed.active()).toEqual([]);
    replayed.close();

    const reopened = await start(RULES_ONLY, fakeJudge(() => ({ rule: noul(0), withdraw: noul(0) })), { directory: dir });
    expect((await reopened.command("rules")).at(-1)?.message).toBe("OptChat has no standing rules.");
    const later = await contextTexts(reopened, [reopened.user("What language should this answer use?")]);
    expect(later.some((text) => text.includes("<rules>"))).toBe(false);
    await reopened.shutdown();
    expect(await ledgerText(dir)).toBe(bytes);
  });

  test.each(["What time is it?", "Thanks, that was helpful."])("unrelated or no-op text preserves exact ledger bytes and the active rule: %s", async (message) => {
    let calls = 0;
    const judge = fakeJudge(() => ({ rule: noul(++calls === 1 ? 1 : 0), withdraw: noul(0) }));
    const host = await start(RULES_ONLY, judge);
    const first = host.user(RULE_TEXT);
    await contextTexts(host, [first]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith(RULE_ADDED)), "the human rule addition");
    const bytes = await ledgerText(host.directory);
    const before = RuleLedger.open(() => join(host.directory, LEDGER_FILE));
    const active = before.active();
    before.close();
    const reply = host.assistant("Understood.");
    await endRun(host, [first, reply]);
    const texts = await contextTexts(host, [first, reply, host.user(message)]);
    expect(texts.some((text) => text.includes("<rules>") && text.includes(RULE_TEXT))).toBe(true);
    // Shutdown settles triage before comparing bytes, so a late no-op cannot escape this assertion.
    await host.shutdown();
    expect(judge.requests).toHaveLength(2);
    expect(await ledgerText(host.directory)).toBe(bytes);
    const replayed = RuleLedger.open(() => join(host.directory, LEDGER_FILE));
    expect(replayed.active()).toEqual(active);
    replayed.close();
  });

  test("a tool-loop withdrawal preserves unrelated frozen rules and the exact frozen prefetch", async () => {
    const retained = "Always use tabs.";
    const withdrawal = "Stop replying in French.";
    const held = Promise.withResolvers<Record<string, Answer>>();
    let prefetchCalls = 0;
    let withdrawalStarted = false;
    const judge = fakeJudge((request) => {
      const keys = Object.keys(request.questions);
      if (keys.some((key) => /^\d+\+\d+$/.test(key))) {
        prefetchCalls++;
        return Object.fromEntries(keys.map((key) => [key, noul(0.9)]));
      }
      if (keys.includes("rule")) {
        const state = JSON.stringify(request.state);
        if (state.includes(withdrawal)) {
          withdrawalStarted = true;
          return held.promise;
        }
        return { rule: noul(state.includes(RULE_TEXT) || state.includes(retained) ? 1 : 0), withdraw: noul(0) };
      }
      throw new Error(`unrouted judgment: ${keys.join(", ")}`);
    });
    const harness = new Harness();
    harnesses.push(harness);
    const { host } = await harness.open({
      flags: { ...SMALL_NODES, "no-optchat-value-score": true, "no-optchat-recall": true },
      judge,
    });
    let transcript: HostMessage[] = [];
    for (const text of [RULE_TEXT, retained, ...SEED_TEXTS]) transcript = await talk(host, transcript, text);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith("OptChat rule r2 added")), "both standing rules");

    const messages = [...transcript, host.user(withdrawal)];
    const before = await contextTexts(host, messages);
    await waitFor(() => withdrawalStarted, "the held withdrawal judgment");
    const beforeRules = before.filter((text) => text.includes("<rules>"));
    expect(beforeRules).toHaveLength(1);
    expect(beforeRules[0]).toContain(RULE_TEXT);
    expect(beforeRules[0]).toContain(retained);
    const frozenPrefetch = before.filter((text) => text.includes("<prefetch>"));
    expect(frozenPrefetch).toHaveLength(1);
    expect(frozenPrefetch[0]).toMatch(/\d+\+\d+\|/);
    const frozenCalls = prefetchCalls;
    expect(frozenCalls).toBeGreaterThan(0);

    held.resolve({ rule: noul(0), withdraw: noul(1), withdraws: choice("r1", { r1: 1 }) });
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith("OptChat rule r1 withdrawn")), "the accepted withdrawal");
    const call = host.assistant("checking", { id: "frozen-prefetch", name: "bash", arguments: { command: "pwd" } });
    const after = await contextTexts(host, [...messages, call, host.toolResult("frozen-prefetch", "bash", "/tmp")]);
    const afterRules = after.filter((text) => text.includes("<rules>"));
    expect(afterRules).toHaveLength(1);
    expect(afterRules[0]).toContain(retained);
    expect(afterRules[0]).toContain("r2 [");
    expect(afterRules[0]).not.toContain(RULE_TEXT);
    expect(afterRules[0]).not.toContain("r1 [");
    expect(after.filter((text) => text.includes("<prefetch>"))).toEqual(frozenPrefetch);
    expect(prefetchCalls).toBe(frozenCalls);
  });

  test("removal during pending prefetch affects its first returned context while a mid-turn addition stays deferred", async () => {
    const retained = "Always use tabs.";
    const added = "From now on use metric units.";
    const prefetch = Promise.withResolvers<Record<string, Answer>>();
    const addition = Promise.withResolvers<Record<string, Answer>>();
    let prefetchAnswers: Record<string, Answer> = {};
    let additionStarted = false;
    const judge = fakeJudge((request) => {
      const keys = Object.keys(request.questions);
      const state = JSON.stringify(request.state);
      if (keys.some((key) => /^\d+\+\d+$/.test(key))) {
        const answers = Object.fromEntries(keys.map((key) => [key, noul(0.9)]));
        if (state.includes(added)) {
          prefetchAnswers = answers;
          return prefetch.promise;
        }
        return answers;
      }
      if (keys.includes("rule")) {
        if (state.includes(added)) {
          additionStarted = true;
          return addition.promise;
        }
        return { rule: noul(state.includes(RULE_TEXT) || state.includes(retained) ? 1 : 0), withdraw: noul(0) };
      }
      throw new Error(`unrouted judgment: ${keys.join(", ")}`);
    });
    const harness = new Harness();
    harnesses.push(harness);
    const { host } = await harness.open({
      flags: { ...SMALL_NODES, "no-optchat-value-score": true, "no-optchat-recall": true },
      judge,
    });
    let transcript: HostMessage[] = [];
    for (const text of [RULE_TEXT, retained, ...SEED_TEXTS]) transcript = await talk(host, transcript, text);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith("OptChat rule r2 added")), "both standing rules");

    const messages = [...transcript, host.user(added)];
    let assembled = false;
    const pending = contextTexts(host, messages).then((texts) => {
      assembled = true;
      return texts;
    });
    await waitFor(() => Object.keys(prefetchAnswers).length > 0 && additionStarted, "pending prefetch and rule addition");
    expect((await host.command("rules remove r1")).at(-1)?.message).toBe("OptChat rule r1 removed.");
    addition.resolve({ rule: noul(1), withdraw: noul(0) });
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith("OptChat rule r3 added")), "the accepted mid-turn addition");
    expect(assembled).toBe(false);

    prefetch.resolve(prefetchAnswers);
    // This is the first assembly returned after the prefetch wait, not a corrective second request.
    const first = await pending;
    const frozenRules = first.filter((text) => text.includes("<rules>"));
    expect(frozenRules).toHaveLength(1);
    expect(frozenRules[0]).toContain(retained);
    expect(frozenRules[0]).toContain("r2 [");
    expect(frozenRules[0]).not.toContain(RULE_TEXT);
    expect(frozenRules[0]).not.toContain("r1 [");
    expect(frozenRules[0]).not.toContain(added);
    expect(frozenRules[0]).not.toContain("r3 [");
    const frozenPrefetch = first.filter((text) => text.includes("<prefetch>"));
    expect(frozenPrefetch).toHaveLength(1);
    expect(frozenPrefetch[0]).toMatch(/\d+\+\d+\|/);

    const call = host.assistant("checking", { id: "after-prefetch", name: "bash", arguments: { command: "pwd" } });
    messages.push(call, host.toolResult("after-prefetch", "bash", "/tmp"));
    const loop = await contextTexts(host, messages);
    expect(loop.filter((text) => text.includes("<rules>"))).toEqual(frozenRules);
    expect(loop.filter((text) => text.includes("<prefetch>"))).toEqual(frozenPrefetch);
    messages.push(host.assistant("Understood."));
    await endRun(host, messages);
    const later = await contextTexts(host, [...messages, host.user("What time is it?")]);
    const laterRules = later.filter((text) => text.includes("<rules>"));
    expect(laterRules).toHaveLength(1);
    expect(laterRules[0]).toContain(retained);
    expect(laterRules[0]).toContain(added);
    expect(laterRules[0]).not.toContain(RULE_TEXT);
  });

  test("a withdrawal target removed while the judge is pending cannot be revived by its late answer", async () => {
    const dir = await tempDir();
    const seed = RuleLedger.open(() => join(dir, LEDGER_FILE));
    seed.add(3, RULE_TEXT, 1);
    seed.close();
    const held = Promise.withResolvers<Record<string, Answer>>();
    const judge = fakeJudge(() => held.promise);
    const host = await start(RULES_ONLY, judge, { directory: dir });
    const messages = [host.user("Stop replying in French.")];
    const before = await contextTexts(host, messages);
    await waitFor(() => judge.requests.length === 1, "the pending withdrawal judgment");
    expect(before.some((text) => text.includes("<rules>") && text.includes(RULE_TEXT))).toBe(true);
    expect((await host.command("rules remove r1")).at(-1)?.message).toBe("OptChat rule r1 removed.");
    const bytes = await ledgerText(dir);
    held.resolve({
      rule: noul(1), withdraw: noul(1),
      withdraws: choice("r1", { r1: 1 }), supersedes: choice("r1", { r1: 1 }),
    });
    const call = host.assistant("checking", { id: "stale-withdrawal", name: "bash", arguments: { command: "pwd" } });
    const texts = await contextTexts(host, [...messages, call, host.toolResult("stale-withdrawal", "bash", "/tmp")]);
    expect(texts.some((text) => text.includes("<rules>"))).toBe(false);
    await host.shutdown();
    expect(await ledgerText(dir)).toBe(bytes);
    expect(host.notices.some((notice) => notice.message.startsWith(RULE_ADDED))).toBe(false);
    const replayed = RuleLedger.open(() => join(dir, LEDGER_FILE));
    expect(replayed.active()).toEqual([]);
    replayed.close();
  });

  test("a rule accepted mid-turn stays absent from the tool loop until the next turn", async () => {
    const held = Promise.withResolvers<Record<string, Answer>>();
    let calls = 0;
    const judge = fakeJudge(() => ++calls === 1 ? held.promise : { rule: noul(0), withdraw: noul(0) });
    const host = await start(RULES_ONLY, judge);
    const first = host.user(RULE_TEXT);
    const before = await contextTexts(host, [first]);
    await waitFor(() => judge.requests.length === 1, "the pending rule addition");
    expect(before.some((text) => text.includes("<rules>"))).toBe(false);
    held.resolve({ rule: noul(0.95), withdraw: noul(0) });
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith(RULE_ADDED)), "rule r1");

    // A tool call and its result inside the same turn: the request carries the frozen view, not the new rule.
    const call = host.assistant("checking", { id: "t1", name: "bash", arguments: { command: "pwd" } });
    const messages = [first, call, host.toolResult("t1", "bash", "/tmp")];
    const texts = await contextTexts(host, messages);
    expect(texts.some((text) => text.includes("<rules>"))).toBe(false);
    const reply = host.assistant("Understood.");
    messages.push(reply);
    await endRun(host, messages);
    const later = await contextTexts(host, [...messages, host.user("What time is it?")]);
    expect(later.some((text) => text.includes("<rules>") && text.includes(RULE_TEXT))).toBe(true);
  });

  test("rules remove ID removes the rule, and the list is empty afterwards", async () => {
    const judge = fakeJudge(() => ({ rule: noul(0.95), withdraw: noul(0) }));
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
    expect(status.some((notice) => notice.message.includes("System One gates: rules on, prefetch on, value-score on, recall on"))).toBe(true);
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
    held.resolve({ rule: noul(0.95), withdraw: noul(0) });
    await closing;
    expect(await ledgerText(host.directory)).toContain(RULE_TEXT);
    expect(host.notices.some((notice) => notice.message.startsWith(RULE_ADDED))).toBe(true);
  });

  test("a hung judge is abandoned at the shutdown bound, and its late answer writes nothing", async () => {
    const never = Promise.withResolvers<Record<string, Answer>>();
    const judge = fakeJudge(() => never.promise);
    const host = await start({ "optchat-rules": true }, judge);
    await contextTexts(host, [host.user(RULE_TEXT)]);
    await waitFor(() => judge.requests.length === 1, "the triage judgment to start");

    // SHUTDOWN_TRIAGE_MS (1.5 s) is held, then fired by the test: the bound passing is an event, not elapsed time.
    const timers = holdTimers(1_500);
    try {
      let closed = false;
      const closing = host.shutdown().then(() => {
        closed = true;
      });
      await waitFor(() => timers.armed === 1, "shutdown to arm its triage bound");
      // Shutdown waits on the hung triage until the bound passes.
      await macrotask();
      expect(closed).toBe(false);

      expect(timers.fire()).toBe(1);
      await closing;
    } finally {
      timers.restore();
    }

    never.resolve({ rule: noul(0.95), withdraw: noul(0) });
    await macrotask();
    expect(await ledgerText(host.directory)).not.toContain(RULE_TEXT);
    expect(host.notices.some((notice) => notice.message.startsWith("OptChat rule"))).toBe(false);
  });

  test("status lists every gate's state", async () => {
    const host = await start({ "no-optchat-prefetch": true, "no-optchat-value-score": true }, fakeJudge(() => ({})));
    const status = await host.command("status");
    expect(status.some((notice) => notice.message.includes("System One gates: rules on, prefetch off, value-score off, recall on"))).toBe(true);
  });

  test("the host marks the session model as the judge only when the judge role has no candidate", async () => {
    // The host resolves the judge role through its settings singleton: in memory, so no user config is read or written.
    await Settings.init({ inMemory: true });
    const sessionModel = { provider: "fake", id: "session", api: "openai-completions" };
    const ctx = (model: unknown) =>
      ({ modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, model }) as unknown as ExtensionContext;
    expect(hostJudge(ctx(undefined), "optchat-rules")).toBeUndefined();
    const fallback = hostJudge(ctx(sessionModel), "optchat-rules");
    expect(fallback).toBeDefined();
    expect(sessionFallbackOf(fallback!)).toBe(true);
  });

  test("session-model fallback: no gate runs; rules, prefetch, value-score and recall are inactive, and status says why", async () => {
    const judge = sessionFallbackJudge(() => ({}));
    const host = await start({ "optchat-rules": true, "optchat-prefetch": true }, judge);
    // A rule-stating message would be judged by the rules gate on a native judge; on the fallback it is not.
    await contextTexts(host, [host.user(RULE_TEXT)]);
    expect(judge.requests).toHaveLength(0);
    expect(await ledgerText(host.directory)).not.toContain(RULE_TEXT);

    const status = (await host.command("status")).map((notice) => notice.message).join("\n");
    expect(status).toContain("judge: fake/session (session model fallback");
    expect(status).toContain("rules inactive: no native judge model (judge role resolves to session model)");
    expect(status).toContain("prefetch inactive: no native judge model (judge role resolves to session model)");
    expect(status).toContain("value-score inactive: no native judge model");
    expect(status).toContain("recall inactive: no native judge model");
    expect(status).not.toContain("tool gate");
  });

  test("session-model fallback: chat_recall stays registered and answers with the inactive text; tool definitions match a native judge", async () => {
    const native = await start({}, fakeJudge(() => ({})));
    const fallback = await start({}, sessionFallbackJudge(() => ({})));
    // The fake host keeps each tool whole; the definition members are read here, the execute function is not compared.
    const definition = (name: string) => {
      const tool = native.tools.get(name) as unknown as Record<string, unknown>;
      return { label: tool.label, description: tool.description, approval: tool.approval, loadMode: tool.loadMode };
    };
    const fallbackTool = fallback.tools.get("chat_recall") as unknown as Record<string, unknown>;
    expect({ label: fallbackTool.label, description: fallbackTool.description, approval: fallbackTool.approval, loadMode: fallbackTool.loadMode }).toEqual(definition("chat_recall"));
    const answer = await fallback.callTool("chat_recall", { question: "anything" });
    expect(answer).toBe("[optchat recall] inactive: no native judge model (judge role resolves to session model); use chat_search or zoom");
  });

  test("gate counters: judge calls and outcomes per gate, in status, when a gate is on", async () => {
    const judge = fakeJudge(() => ({ rule: noul(0.95), withdraw: noul(0) }));
    const host = await start({ "optchat-rules": true }, judge);
    await contextTexts(host, [host.user(RULE_TEXT)]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith(RULE_ADDED)), "rule r1");

    const status = (await host.command("status")).map((notice) => notice.message).join("\n");
    expect(status).toContain("rules counts: 1 judge calls, 0 failures, 1 added, 0 replaced, 0 removed");
    expect(status).toContain("prefetch counts:");
    expect(status).not.toContain("tool gate");
  });

  test("all gates off: status has no gate, counter or fallback lines", async () => {
    const host = await openFakeHost(createOptChat({ judge: () => sessionFallbackJudge(() => ({})) }), {
      flags: {
        "no-optchat-rules": true,
        "no-optchat-prefetch": true,
        "no-optchat-value-score": true,
        "no-optchat-recall": true,
      },
    });
    hosts.push(host);
    const status = (await host.command("status")).map((notice) => notice.message).join("\n");
    expect(status).not.toContain("System One");
    expect(status).not.toContain("counts:");
    expect(status).not.toContain("inactive");
    expect(status).not.toContain("judge:");
  });
});
