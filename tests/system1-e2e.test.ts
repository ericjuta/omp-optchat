import { afterEach, describe, expect, test } from "bun:test";
import type { HostMessage } from "./helpers/fake-host.ts";
import { choice, fakeJudge, noul, type FakeJudge } from "./helpers/fake-judge.ts";
import {
  Harness,
  FIRST_MERGED_LINE,
  RULE_ADDED,
  RULE_TEXT,
  SEED_TEXTS,
  SMALL_NODES,
  encodeMainRequest,
  hasNotice,
  messagesOf,
  routedJudge,
  talk,
  viewContent,
  until,
} from "./helpers/system1-chat.ts";

let harness: Harness;

afterEach(async () => {
  await harness?.close();
});

const isPrefetchJudgment = (questions: string[]): boolean => questions.some((key) => /^\d+\+\d+$/.test(key));

describe("prefetch through OptChat", () => {
  test("a merged line the judge picks reaches the provider request after the view and the rules, with its children", async () => {
    harness = new Harness();
    const { host, judge } = await harness.open({
      flags: SMALL_NODES,
      routes: { ruleWhen: "French", prefetch: [FIRST_MERGED_LINE] },
    });
    let transcript = await talk(host, [], RULE_TEXT);
    await until(() => hasNotice(host, RULE_ADDED), "rule r1");
    for (const text of SEED_TEXTS) transcript = await talk(host, transcript, text);

    const request = await encodeMainRequest(host, transcript, "book the table for two");
    const body = JSON.stringify(request.messages);
    const view = body.indexOf("<chat>");
    const rules = body.indexOf("<rules>");
    const prefetch = body.indexOf("<prefetch>");

    // Preconditions: the line was actually merged and judged, so the block is not vacuous.
    // Prefetch runs on every turn with a merged line, so the last judgment of that line is this turn's.
    const judged = judge.requests.filter((r) => Object.keys(r.questions).includes(FIRST_MERGED_LINE));
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.at(-1)!.state).toMatchObject({ message: "book the table for two" });

    expect(view).toBeGreaterThanOrEqual(0);
    expect(rules).toBeGreaterThan(view);
    expect(prefetch).toBeGreaterThan(rules);
    // The block sits between the view and the message it was zoomed for, never after that message.
    expect(prefetch).toBeLessThan(body.indexOf("book the table for two"));
    // The picked line 0+2 zooms to its two children, one per message; another merged line is not zoomed.
    const block = body.slice(prefetch, body.indexOf("</prefetch>", prefetch));
    expect(block).toContain("0+1|user: From now on always reply in French.");
    expect(block).toContain("1+1|talk: noted");
    expect(block).not.toContain("morning coffee for two");
  });

  test("with no merged view line the judge is never asked for prefetch and no block is sent", async () => {
    harness = new Harness();
    const { host, judge } = await harness.open({ routes: { prefetch: [FIRST_MERGED_LINE] } });
    let transcript = await talk(host, [], "morning coffee for two");
    transcript = await talk(host, transcript, "tea for the team");

    const request = await encodeMainRequest(host, transcript, "book a room");
    expect(JSON.stringify(request.messages)).not.toContain("<prefetch>");
    const prefetchJudgments = judge.requests.filter((r) => isPrefetchJudgment(Object.keys(r.questions)));
    expect(prefetchJudgments).toHaveLength(0);
  });
});

describe("value hint composition through OptChat", () => {
  // A decision whose text is long enough that every message is compacted, so each leaf asks for a hint.
  const LONG = (n: number): string => `decision ${n}: keep Postgres for the ledger. ${"the reason is durability. ".repeat(24)}`;
  const LONG_MESSAGES = [LONG(1), LONG(2), LONG(3)];

  async function longChat(flags: Record<string, string | boolean>) {
    harness = new Harness();
    const { host, judge, compressor } = await harness.open({
      flags,
      routes: { value: { label: "decision", importance: 1.8 } },
    });
    let transcript: HostMessage[] = [];
    for (const text of LONG_MESSAGES) transcript = await talk(host, transcript, text);
    const next = messagesOf(await host.context([...transcript, host.user("next")]));
    // The gate line in status differs by design between the runs; the tree line must not.
    const treeLine = (await host.command("status")).flatMap((n) => n.message.split("\n")).find((line) => line.includes("tree nodes"));
    return { view: viewContent(next), status: treeLine, judge, compressor };
  }

  test("the hint reaches the compressor input, and the built nodes match a run without the hint", async () => {
    const withHint = await longChat({});
    const withoutHint = await longChat({ "no-optchat-value-score": true });

    const hint = "This record is a decision; keep the choice and its reason. Its importance is high.";
    expect(withHint.judge.requests.some((r) => Object.keys(r.questions).includes("label"))).toBe(true);
    expect(JSON.stringify(withHint.compressor.bodies)).toContain(hint);

    // The hint never changes what is built or when: same view structure, same status, same compressor calls.
    expect(JSON.stringify(withoutHint.compressor.bodies)).not.toContain("Its importance");
    expect(withHint.compressor.bodies).toHaveLength(withoutHint.compressor.bodies.length);
    expect(withHint.view).toBe(withoutHint.view);
    expect(withHint.status).toBe(withoutHint.status);
    expect(withHint.status).toMatch(/tree nodes: [1-9]/);
  });
});

describe("chat_recall through OptChat", () => {
  // Short enough that its pair (`user: … talk: noted`) fits a 64-byte view line, so the pair is a merged line.
  const PLANTED = "staging db password: vault item 7731";
  const QUESTION = "which vault item holds the staging db password";
  // Eight 64-byte nodes: the planted message's pair is a merged line, so the descent has two levels.
  const TEXTS = ["morning coffee for two", "tea for the team", PLANTED, "send the invoice", "weather in Lisbon", "ship the release", "lunch on friday", "review the draft"];

  /**
   * Scores the merged line holding the planted message high and descends into the half holding it. Other judgments
   * (rules, value) go to the routed judge. With `failure`, every recall scoring call throws that message.
   */
  function recallJudge(failure?: string): FakeJudge {
    const base = routedJudge();
    return fakeJudge(async (request, signal) => {
      const state = request.state as { question?: string; first?: string; lines?: Record<string, string> };
      const keys = Object.keys(request.questions);
      if (state.question !== undefined && state.first !== undefined) {
        const side = state.first.includes(PLANTED) ? "first" : "second";
        return { side: choice(side, { first: side === "first" ? 1 : 0, second: side === "second" ? 1 : 0 }) };
      }
      if (state.question !== undefined && state.lines !== undefined) {
        if (failure !== undefined) throw new Error(failure);
        const lines = state.lines;
        return Object.fromEntries(keys.map((key) => [key, noul(lines[key]!.includes(PLANTED) ? 0.9 : 0)]));
      }
      return (await base.judge(request, { signal })).answers;
    });
  }

  test("chat_recall returns the planted message's id, as chat_search finds it, and its original text", async () => {
    harness = new Harness();
    const { host, judge } = await harness.open({ flags: SMALL_NODES, judge: recallJudge() });
    let transcript: HostMessage[] = [];
    for (const text of TEXTS) transcript = await talk(host, transcript, text);

    const search = await host.callTool("chat_search", { text: "vault item" });
    const ids = [...search.matchAll(/^(\d+)\|/gm)].map((match) => Number(match[1]));
    expect(ids).toHaveLength(1);
    const [planted] = ids;

    const answer = await host.callTool("chat_recall", { question: QUESTION });
    expect(answer).not.toContain("recall failed");
    expect(answer).toContain(`message ${planted}:`);
    expect(answer).toContain(PLANTED);
    // The last step of the path is the planted message itself, a single-message line.
    expect(answer).toContain(`${planted}+1|user: ${PLANTED}`);
    // The judge was asked to score merged lines, then to choose at each level.
    expect(judge.requests.some((r) => "first" in (r.state as object))).toBe(true);
  });

  test("chat_recall is registered by default, and not under no-optchat-recall; chat_search is registered either way", async () => {
    harness = new Harness();
    const on = await harness.open({ flags: SMALL_NODES });
    expect([...on.host.tools.keys()]).toEqual(expect.arrayContaining(["chat_recall", "chat_search"]));

    const off = await harness.open({ flags: { ...SMALL_NODES, "no-optchat-recall": true } });
    expect(off.host.tools.has("chat_recall")).toBe(false);
    expect(off.host.tools.has("chat_search")).toBe(true);
  });

  test("a judge failure during chat_recall yields the recall-failed text and is the last System One failure in status", async () => {
    harness = new Harness();
    const { host } = await harness.open({ flags: SMALL_NODES, judge: recallJudge("recall judge offline") });
    let transcript: HostMessage[] = [];
    for (const text of TEXTS) transcript = await talk(host, transcript, text);

    const answer = await host.callTool("chat_recall", { question: QUESTION });
    expect(answer).toContain("[optchat recall] recall failed (");
    expect(answer).toContain("recall judge offline");
    expect(answer).not.toContain(PLANTED);

    const status = (await host.command("status")).map((notice) => notice.message).join("\n");
    expect(status).toContain("last System One failure: recall: recall judge offline");
  });
});

describe("tool gate with a UI", () => {
  test("a risky call the user declines is blocked, and the user was asked once by title", async () => {
    harness = new Harness();
    const { host } = await harness.open({ hasUI: true, confirm: () => false, routes: { danger: "destructive" } });
    const result = (await host.fire("tool_call", { toolName: "bash", input: { command: "rm -rf build" } }))[0];
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("declined") });
    expect(host.confirms.map((confirm) => confirm.title)).toEqual(["OptChat tool gate: bash"]);
  });

  test("a safe call runs without asking the user, and an exempt tool is never screened even with a UI", async () => {
    harness = new Harness();
    const { host, judge } = await harness.open({ hasUI: true, confirm: () => false, routes: { danger: "safe" } });
    expect((await host.fire("tool_call", { toolName: "bash", input: { command: "ls" } }))[0]).toBeUndefined();
    expect(host.confirms).toHaveLength(0);
    expect(judge.requests).toHaveLength(1);

    const exempt = (await host.fire("tool_call", { toolName: "read", input: { path: "notes.txt" } }))[0];
    expect(exempt).toBeUndefined();
    expect(judge.requests).toHaveLength(1);
    expect(host.confirms).toHaveLength(0);
  });
});
