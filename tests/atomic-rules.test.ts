import { afterEach, describe, expect, test } from "bun:test";
import type { Answer } from "@oh-my-pi/pi-ai";
import { join } from "node:path";
import { createOptChat } from "../src/index.ts";
import { LEDGER_FILE, RuleLedger, type Rule } from "../src/system1/ledger.ts";
import {
  decideTriage,
  NEWEST_RULE_TARGETS,
  offeredRules,
  RELEVANT_RULE_TARGETS,
  ruleSentences,
  triageQuestions,
  triageTargets,
} from "../src/system1/rules.ts";
import { choice, fakeJudge, noul } from "./helpers/fake-judge.ts";
import { openFakeHost, type FakeHost } from "./helpers/fake-host.ts";

const hosts: FakeHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

const RULES_ONLY = {
  "optchat-rules": true,
  "no-optchat-prefetch": true,
  "no-optchat-value-score": true,
  "no-optchat-recall": true,
};

/** One macrotask turn, with no wall-clock duration: lets queued I/O and timers already due run. */
async function macrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

/** Polls a condition at macrotask pace, bounded by a round count rather than a duration. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let round = 0; round < 2_000; round++) {
    if (condition()) return;
    await macrotask();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function activeRules(directory: string): Array<{ id: string; text: string }> {
  const ledger = RuleLedger.open(() => join(directory, LEDGER_FILE));
  const active = ledger.active().map(({ id, text }) => ({ id, text }));
  ledger.close();
  return active;
}

const rule = (n: number, text: string): Rule => ({ id: `r${n}`, text, source: n, at: n });
/** `count` filler rules r<from>.. that share no word with the sentences below. */
const fillers = (from: number, count: number): Rule[] =>
  Array.from({ length: count }, (_, index) => rule(from + index, `Keep note ${from + index} short.`));

describe("atomic rule decisions", () => {
  const message = "Use British English. Always ask before deploying.";
  const sentences = ruleSentences(message);

  test("each standing sentence becomes its own add, in source order", () => {
    expect(sentences).toEqual(["Use British English.", "Always ask before deploying."]);
    const answers = { rule: noul(0.95), withdraw: noul(0), s0: noul(0.9), s1: noul(0.85) };
    expect(decideTriage("human", answers, [], 0.8, message, sentences)).toEqual([
      { kind: "add", text: "Use British English." },
      { kind: "add", text: "Always ask before deploying." },
    ]);
    // The whole-message rule question still gates every sentence.
    expect(decideTriage("human", { ...answers, rule: noul(0.79) }, [], 0.8, message, sentences)).toEqual([]);
  });

  test("a sentence keeps its exception clause, because the rule text is the whole sentence", () => {
    const text = "Always run the tests before committing, unless the change only touches docs. Reply briefly.";
    const split = ruleSentences(text);
    expect(split[0]).toBe("Always run the tests before committing, unless the change only touches docs.");
    expect(decideTriage("human", { rule: noul(1), withdraw: noul(0), s0: noul(0.9), s1: noul(0.1) }, [], 0.8, text, split)).toEqual([
      { kind: "add", text: split[0] },
    ]);
  });

  test("each sentence replaces only the rule its own choice names, and a rule is replaced at most once", () => {
    const offered = triageTargets([rule(1, "Answer in American English.")], message, sentences);
    expect(decideTriage("human", {
      rule: noul(1), withdraw: noul(0), s0: noul(0.9), s1: noul(0.9),
      r0: choice("r1", { r1: 0.9, none: 0.1 }), r1: choice("none", { none: 1 }),
    }, offered, 0.8, message, sentences)).toEqual([
      { kind: "replace", replaces: "r1", text: "Use British English." },
      { kind: "add", text: "Always ask before deploying." },
    ]);
    expect(decideTriage("human", {
      rule: noul(1), withdraw: noul(0), s0: noul(0.9), s1: noul(0.9),
      r0: choice("r1", { r1: 0.9 }), r1: choice("r1", { r1: 0.9 }),
    }, offered, 0.8, message, sentences)).toEqual([
      { kind: "replace", replaces: "r1", text: "Use British English." },
      { kind: "add", text: "Always ask before deploying." },
    ]);
  });

  test("a withdrawing message removes each sentence's own target once and adds nothing", () => {
    const text = "Stop using British English. Forget the deploy rule too.";
    const split = ruleSentences(text);
    const offered = triageTargets([rule(1, "Use British English."), rule(2, "Always ask before deploying.")], text, split);
    const answers = {
      rule: noul(1), withdraw: noul(0.9), s0: noul(1), s1: noul(1),
      x0: choice("r1", { r1: 0.9 }), x1: choice("r2", { r2: 0.6 }),
    };
    expect(decideTriage("human", answers, offered, 0.8, text, split)).toEqual([
      { kind: "remove", removes: "r1" },
      { kind: "remove", removes: "r2" },
    ]);
    expect(decideTriage("human", { ...answers, x1: choice("r1", { r1: 1 }) }, offered, 0.8, text, split)).toEqual([
      { kind: "remove", removes: "r1" },
    ]);
    expect(decideTriage("non-human", answers, offered, 0.8, text, split)).toEqual([]);
  });

  test("several sentences get their own rule, replacement and withdrawal questions over their own targets", () => {
    const active = [rule(1, "Answer in American English.")];
    const questions = triageQuestions(triageTargets(active, message, sentences), sentences);
    expect(Object.keys(questions)).toEqual(["rule", "withdraw", "s0", "s1", "r0", "x0", "r1", "x1"]);
    expect(questions.r1).toMatchObject({ type: "choice", criteria: { r1: "Answer in American English." } });
    expect(JSON.stringify(questions.x1)).toContain("sentences[1]");
    expect(Object.keys(triageQuestions(triageTargets(active, "Use tabs.", ["Use tabs."]), ["Use tabs."]))).toEqual([
      "rule", "withdraw", "supersedes", "withdraws",
    ]);
  });
});

describe("rule targets", () => {
  test("every rule is offered while there are at most the newest-rule count", () => {
    const few = fillers(1, NEWEST_RULE_TARGETS);
    expect(offeredRules(few, "anything at all")).toEqual(few);
  });

  test("an old rule outside the newest 16 is still a withdraw target when the sentence's words match it", () => {
    const active = [rule(1, "Always answer in British English spelling."), ...fillers(2, 39)];
    const withdrawal = "Stop using British English spelling.";
    const offered = triageTargets(active, withdrawal, ruleSentences(withdrawal));
    expect(offered).toHaveLength(1);
    expect(offered[0]!.map((entry) => entry.id)).toEqual(["r1", ...active.slice(-NEWEST_RULE_TARGETS).map((entry) => entry.id)]);
    expect(triageQuestions(offered, ruleSentences(withdrawal)).withdraws).toMatchObject({ criteria: { r1: "Always answer in British English spelling." } });
    expect(decideTriage("human", { rule: noul(0), withdraw: noul(1), withdraws: choice("r1", { r1: 1 }) }, offered, 0.8, withdrawal)).toEqual([
      { kind: "remove", removes: "r1" },
    ]);
    // Without a matching word only the newest rules are offered, so the old rule cannot be targeted.
    expect(offeredRules(active, "Stop that.").map((entry) => entry.id)).toEqual(active.slice(-NEWEST_RULE_TARGETS).map((entry) => entry.id));
  });

  test("at most 16 relevant older rules join the newest 16, the newer winning ties, in ledger order", () => {
    const active = [
      ...Array.from({ length: 18 }, (_, index) => rule(index + 1, `Deploy to staging ${index + 1} first.`)),
      ...fillers(19, 22),
    ];
    const offered = offeredRules(active, "Never deploy to staging on Fridays.").map((entry) => entry.id);
    expect(offered).toHaveLength(NEWEST_RULE_TARGETS + RELEVANT_RULE_TARGETS);
    expect(offered.slice(0, RELEVANT_RULE_TARGETS)).toEqual(Array.from({ length: 16 }, (_, index) => `r${index + 3}`));
    expect(offered.slice(RELEVANT_RULE_TARGETS)).toEqual(active.slice(-NEWEST_RULE_TARGETS).map((entry) => entry.id));
  });
});

describe("atomic standing rules through OptChat", () => {
  test("two standing sentences in one message become two rules, and withdrawing one leaves the other active", async () => {
    const stated = "Use British English. Always ask before deploying.";
    const withdrawal = "Stop using British English.";
    const judge = fakeJudge((request): Record<string, Answer> => {
      const state = JSON.stringify(request.state);
      if (state.includes(withdrawal)) return { rule: noul(0), withdraw: noul(1), withdraws: choice("r1", { r1: 1 }) };
      return { rule: noul(0.95), withdraw: noul(0), s0: noul(0.95), s1: noul(0.95) };
    });
    const host = await openFakeHost(createOptChat({ judge: () => judge }), { flags: RULES_ONLY });
    hosts.push(host);

    const first = host.user(stated);
    await host.context([first]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith("OptChat rule r1 added")), "the first rule");
    expect(activeRules(host.directory)).toEqual([
      { id: "r1", text: "Use British English." },
      { id: "r2", text: "Always ask before deploying." },
    ]);

    const reply = host.assistant("Understood.");
    await host.fire("agent_end", { messages: [first, reply], willContinue: false });
    await host.context([first, reply, host.user(withdrawal)]);
    await waitFor(() => host.notices.some((notice) => notice.message.startsWith("OptChat rule r1 withdrawn")), "the withdrawal");
    expect(activeRules(host.directory)).toEqual([{ id: "r2", text: "Always ask before deploying." }]);
  });
});
