/**
 * Host compaction through the real `createOptChat` hooks on the fake host. OptChat answers a host compaction with a
 * fixed marker summary and never cuts its open turn; a compaction summary the host leaves in its message list is
 * never chat input. Nothing here calls a model.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { HOST_COMPACTION_SUMMARY, hostCompactionSummaryInTurn } from "../src/prompts.ts";
import type { FakeHost, HostMessage } from "./helpers/fake-host.ts";
import { branchOf, compact, messageEntry, stampOf } from "./helpers/host-compaction.ts";
import { ALL_GATES_OFF, Harness, messagesOf, SMALL_NODES, talk, viewContent } from "./helpers/system1-chat.ts";

const FLAGS = { ...SMALL_NODES, ...ALL_GATES_OFF };

const harness = new Harness();

afterEach(async () => {
  await harness.close();
});

async function open(): Promise<FakeHost> {
  return (await harness.open({ flags: FLAGS })).host;
}

function marker(firstKeptEntryId: string, tokensBefore = 1000): unknown {
  return { compaction: { summary: HOST_COMPACTION_SUMMARY, firstKeptEntryId, tokensBefore } };
}

/** What the host leaves at the head of its message list after a compaction. */
function compactionSummary(host: FakeHost): HostMessage {
  return {
    role: "compactionSummary",
    summary: HOST_COMPACTION_SUMMARY,
    tokensBefore: 10,
    timestamp: stampOf(host.user("compaction clock")),
  } as unknown as HostMessage;
}

async function messageCount(host: FakeHost): Promise<number> {
  const status = (await host.command("status")).at(-1)?.message ?? "";
  const match = /messages: (\d+);/.exec(status);
  if (!match) throw new Error(`no message count in: ${status}`);
  return Number(match[1]);
}

describe("host compaction: the marker summary", () => {
  test("no open turn: the marker compaction keeps the host's cut and token count, with no model call", async () => {
    const host = await open();
    const history = await talk(host, await talk(host, [], "first question"), "second question");
    const result = await compact(host, { dropped: history.slice(0, 2), firstKeptEntryId: "e3", tokensBefore: 4321 }, branchOf(history));
    expect(result).toEqual(marker("e3", 4321));
  });

  test("an open turn the host keeps whole: the host's cut stands", async () => {
    const host = await open();
    const history = await talk(host, await talk(host, [], "first question"), "second question");
    const prompt = host.user("third question");
    await host.context([...history, prompt]);
    const result = await compact(host, { dropped: history.slice(0, 2), firstKeptEntryId: "e3" }, branchOf([...history, prompt]));
    expect(result).toEqual(marker("e3"));
  });
});

describe("host compaction: the open turn is never cut", () => {
  test("an open turn the host would drop, with older messages before it: the cut moves to its first message", async () => {
    const host = await open();
    const history = await talk(host, await talk(host, [], "first question"), "second question");
    const prompt = host.user("third question");
    await host.context([...history, prompt]);
    const reply = host.assistant("reading the file", { id: "t1", name: "read", arguments: {} });
    const result = host.toolResult("t1", "read", "file text");
    const next = host.assistant("done reading");
    const all = [...history, prompt, reply, result, next];
    const outcome = await compact(
      host,
      { dropped: history, prefix: [prompt, reply, result], firstKeptEntryId: "e8", tokensBefore: 777 },
      branchOf(all),
    );
    expect(outcome).toEqual(marker("e5", 777));
  });

  test("an open turn that began on a custom message: the cut moves to its custom_message entry", async () => {
    const host = await open();
    const history = await talk(host, [], "first question");
    const custom = {
      role: "custom",
      customType: "plain-note",
      content: "a host note",
      display: true,
      attribution: "agent",
      timestamp: stampOf(host.user("custom clock")),
    } as unknown as HostMessage;
    await host.context([...history, custom]);
    const reply = host.assistant("noted the note");
    const entries: SessionEntry[] = [
      ...branchOf(history),
      {
        type: "custom_message",
        id: "c3",
        parentId: null,
        timestamp: new Date(stampOf(custom)).toISOString(),
        customType: "plain-note",
        content: "a host note",
        display: true,
        attribution: "agent",
      },
      messageEntry("e4", reply),
    ];
    const outcome = await compact(host, { dropped: history, prefix: [custom], firstKeptEntryId: "e4" }, entries);
    expect(outcome).toEqual(marker("c3"));
  });

  test("an open turn that began with no new message: the cut moves to the last message before it", async () => {
    const host = await open();
    const history = await talk(host, await talk(host, [], "first question"), "second question");
    // Every message is already logged: the turn opens with nothing new, after the last one.
    await host.context(history);
    const outcome = await compact(host, { dropped: history, firstKeptEntryId: "e5" }, branchOf([...history, host.assistant("later")]));
    expect(outcome).toEqual(marker("e4"));
  });

  test("an anchor the host cannot cut at (a tool result): cancel", async () => {
    const host = await open();
    const prompt = host.user("read the file");
    const reply = host.assistant("reading", { id: "t1", name: "read", arguments: {} });
    const result = host.toolResult("t1", "read", "file text");
    const messages = [prompt, reply, result];
    await host.context(messages);
    await host.fire("agent_end", { messages, willContinue: false });
    // The next turn opens with no new message, after the tool result.
    await host.context(messages);
    const outcome = await compact(host, { dropped: messages, firstKeptEntryId: "e4" }, branchOf([...messages, host.assistant("later")]));
    expect(outcome).toEqual({ cancel: true });
  });

  test("an open turn that is the first dropped message: the host's cut stands and the summary points at the turn's first message", async () => {
    const host = await open();
    const prompt = host.user("only question");
    await host.context([prompt]);
    const reply = host.assistant("reading", { id: "t1", name: "read", arguments: {} });
    const result = host.toolResult("t1", "read", "file text");
    const all = [prompt, reply, result, host.assistant("done")];
    const outcome = await compact(host, { dropped: [], prefix: [prompt, reply, result], firstKeptEntryId: "e4" }, branchOf(all));
    expect(outcome).toEqual({ compaction: { summary: hostCompactionSummaryInTurn(0), firstKeptEntryId: "e4", tokensBefore: 1000 } });
  });

  test("an anchor that is itself a compaction summary: cancel", async () => {
    const host = await open();
    const history = await talk(host, [], "first question");
    const summary = compactionSummary(host);
    // Nothing follows the summary, so the turn opens after it.
    await host.context([summary]);
    const outcome = await compact(host, { dropped: [history[0]!, summary], firstKeptEntryId: "e9" }, branchOf([...history, host.assistant("later")]));
    expect(outcome).toEqual({ cancel: true });
  });

  test("an OptChat that is not ready cancels", async () => {
    const host = await open();
    const history = await talk(host, [], "first question");
    await host.shutdown();
    const outcome = await compact(host, { dropped: history, firstKeptEntryId: "e3" }, branchOf(history));
    expect(outcome).toEqual({ cancel: true });
  });
});

describe("host compaction: a leftover summary is never chat input", () => {
  test("[summary, new prompt]: the model gets the view and the new turn without the summary, and no entry is logged for it", async () => {
    const host = await open();
    const history = await talk(host, [], "first question");
    const before = await messageCount(host);
    expect(before).toBe(history.length);
    const summary = compactionSummary(host);
    const prompt = host.user("second question");
    const sent = messagesOf(await host.context([summary, prompt]));
    expect(sent).toHaveLength(2);
    expect(viewContent(sent)).not.toContain(HOST_COMPACTION_SUMMARY);
    expect(sent[1]).toBe(prompt);
    expect(JSON.stringify(sent)).not.toContain(HOST_COMPACTION_SUMMARY);
    // The same turn's next request, with a tool loop under way.
    const reply = host.assistant("reading", { id: "t1", name: "read", arguments: {} });
    const result = host.toolResult("t1", "read", "file text");
    const loop = messagesOf(await host.context([summary, prompt, reply, result]));
    expect(loop).toEqual([sent[0], prompt, reply, result]);
    const answer = host.assistant("done");
    await host.fire("agent_end", { messages: [summary, prompt, reply, result, answer], willContinue: false });
    // The prompt, the reply (its text and its tool call are two entries), the tool result and the answer are logged;
    // the summary is not.
    expect(await messageCount(host)).toBe(before + 5);
    expect(await host.callTool("chat_search", { text: "OptChat keeps this session" })).not.toContain("OptChat keeps this session's earlier");
  });

  test("[summary, kept messages, new prompt]: the kept messages are in the view, not sent again", async () => {
    const host = await open();
    const history = await talk(host, await talk(host, [], "first question"), "second question");
    const summary = compactionSummary(host);
    const prompt = host.user("third question");
    const sent = messagesOf(await host.context([summary, ...history.slice(2), prompt]));
    expect(sent).toHaveLength(2);
    expect(viewContent(sent)).toContain("second question");
    expect(sent[1]).toBe(prompt);
    expect(JSON.stringify(sent)).not.toContain(HOST_COMPACTION_SUMMARY);
  });
});
