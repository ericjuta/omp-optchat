import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseMetadata, type ImageAttachment } from "../src/archive.ts";
import { createOptChat } from "../src/index.ts";
import type { Message } from "../src/store.ts";
import { isRecord } from "../src/type-guards.ts";
import { openFakeHost, type FakeHost, type HostMessage } from "./helpers/fake-host.ts";
import { ALL_GATES_OFF, Harness } from "./helpers/system1-chat.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const IMAGE = { type: "image" as const, data: PNG, mimeType: "image/png" };
const FLAGS = { ...ALL_GATES_OFF, "optchat-tool-cap": "128" };
const harness = new Harness();

afterEach(async () => {
  await harness.close();
});

async function open(): Promise<FakeHost> {
  return (await harness.open({ flags: FLAGS })).host;
}

/** Read the writer's actual durable rows without opening a competing Store lease. */
async function rows(host: FakeHost): Promise<Message[]> {
  const directory = join(host.directory, "main");
  const messages: Message[] = [];
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".jsonl"))) {
    const text = await readFile(join(directory, name), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.trimEnd().split("\n")) {
      const row: unknown = JSON.parse(line);
      if (!isRecord(row) || typeof row.i !== "number" || typeof row.text !== "string" ||
        typeof row.size !== "number" || typeof row.date !== "string" ||
        (row.kind !== "user" && row.kind !== "talk" && row.kind !== "tool" &&
          row.kind !== "echo" && row.kind !== "work" && row.kind !== "note")) {
        throw new Error(`Invalid durable message in ${name}`);
      }
      messages.push({ i: row.i, kind: row.kind, text: row.text, size: row.size, date: row.date,
        ...(row.metadata === undefined ? {} : { metadata: parseMetadata(row.metadata) }) });
    }
  }
  return messages.sort((a, b) => a.i - b.i);
}

function only(messages: readonly Message[], predicate: (message: Message) => boolean): Message {
  const matches = messages.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function call(messages: readonly Message[], name: string, args: Record<string, unknown> = {}): Message {
  return only(messages, (row) => row.kind === "tool" && row.text === `${name} ${JSON.stringify(args)}`);
}

function echo(messages: readonly Message[], text: string): Message {
  return only(messages, (row) => row.kind === "echo" && row.text === text);
}

/** Every row is checked, including the ones that must NOT acquire an association. */
function associations(messages: readonly Message[], links: readonly (readonly [Message, Message])[]): void {
  const expected = new Map(links.map(([result, source]) => [result.i, source.i]));
  expect(messages.map((row) => [row.i, row.metadata?.resultFor]))
    .toEqual(messages.map((row) => [row.i, expected.get(row.i)]));
}

async function zoom(host: FakeHost, source: Message, result?: Message): Promise<void> {
  const tool = host.tools.get("zoom");
  if (!tool) throw new Error("zoom was not registered");
  const reply = await tool.execute("inspect-result", { id: source.i, n: 1 }, undefined, undefined, host.ctx);
  expect(reply.content[0]?.text).toContain(source.text);
  const text = reply.content.map((part) => part.text ?? "").join("\n");
  if (result) {
    expect(reply).toHaveProperty("details.result", result.i);
    expect(text).toContain(`[result: message ${result.i}]`);
  } else {
    expect(reply).not.toHaveProperty("details.result");
    expect(text).not.toContain("[result: message ");
  }
}

/** The same hook sequence used by the fake-host integration tests; agent_end drains durable appends. */
async function record(host: FakeHost, messages: HostMessage[]): Promise<Message[]> {
  await host.context(messages);
  await host.fire("agent_end", { messages, willContinue: false });
  return rows(host);
}

type Result = Extract<HostMessage, { role: "toolResult" }>;

function result(host: FakeHost, id: string, name: string, text: string, extra: Partial<Result> = {}): Result {
  const message = host.toolResult(id, name, text);
  if (message.role !== "toolResult") throw new Error("fake host returned no toolResult");
  return { ...message, ...extra };
}

interface WaitJob {
  id: string;
  type: "task" | "bash";
  status: "completed";
  label: string;
  agentUrlId?: string;
  resultText: string;
}

/** Render the host's real wait headings and typed job snapshots, not an association mock. */
function waitDelivery(rest: boolean): { text: string; details: Record<string, unknown> } {
  const jobs: WaitJob[] = [
    { id: "bg_alpha", type: "task", status: "completed", label: "Alpha", agentUrlId: "agent-alpha", resultText: "ALPHA-FINDING" },
    { id: "bg_beta", type: "task", status: "completed", label: "Beta", agentUrlId: "agent-beta", resultText: "BETA-FINDING" },
    ...(rest ? [{ id: "bg_build", type: "bash" as const, status: "completed" as const, label: "Build", resultText: "BUILD-REST" }] : []),
  ];
  const sections = jobs.map((job) => `### ${job.id} [${job.type}] — ${job.status}\nLabel: ${job.label}\nDelivery: not auto-delivered; recovered by this snapshot.\n\`\`\`\n${job.resultText}\n\`\`\``);
  return { text: `## Completed (${jobs.length})\n\n${sections.join("\n\n")}`, details: { op: "wait", jobs } };
}

function imageMetadata(order: number): ImageAttachment {
  const bytes = Buffer.from(PNG, "base64");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, order };
}

describe("durable tool-result association through createOptChat", () => {
  for (const rest of [false, true]) {
    test(`same-assistant wait then read links every wait row ${rest ? "with" : "without"} rest and the actual later-read echo`, async () => {
      const host = await open();
      const request = host.assistant("", { id: "wait-call", name: "wait", arguments: {} });
      request.content.push({ type: "toolCall", id: "read-call", name: "read", arguments: { path: "later.txt" } });
      const delivery = waitDelivery(rest);
      const messages = await record(host, [
        host.user("wait for both reports, then read the file"), request,
        result(host, "wait-call", "wait", delivery.text, { details: delivery.details,
          content: [{ type: "text", text: delivery.text }, IMAGE] }),
        result(host, "read-call", "read", "ACTUAL-LATER-READ"),
      ]);
      const waitCall = call(messages, "wait");
      const readCall = call(messages, "read", { path: "later.txt" });
      const reports = messages.filter((row) => row.kind === "work");
      expect(reports.map((row) => row.metadata?.work)).toEqual([
        { source: "async-result", completeness: "full", id: "bg_alpha", name: "Alpha", agentId: "agent-alpha" },
        { source: "async-result", completeness: "full", id: "bg_beta", name: "Beta", agentId: "agent-beta" },
      ]);
      expect(reports[0]!.text).toContain("ALPHA-FINDING");
      expect(reports[0]!.text).not.toContain("BETA-FINDING");
      expect(reports[1]!.text).toContain("BETA-FINDING");
      const waitEchoes = messages.filter((row) => row.kind === "echo" && row.text !== "ACTUAL-LATER-READ");
      expect(waitEchoes).toHaveLength(rest ? 1 : 0);
      if (rest) {
        expect(waitEchoes[0]!.text).toContain("BUILD-REST");
        expect(waitEchoes[0]!.text).toContain("[report recorded as work bg_alpha]");
        expect(waitEchoes[0]!.text).not.toContain("ALPHA-FINDING");
      }
      const waitRows = [...waitEchoes, ...reports];
      expect(waitRows[0]!.metadata?.images).toEqual([imageMetadata(1)]);
      for (const row of waitRows.slice(1)) expect(row.metadata?.images).toBeUndefined();
      const later = echo(messages, "ACTUAL-LATER-READ");
      associations(messages, [...waitRows.map((row) => [row, waitCall] as const), [later, readCall]]);
      await zoom(host, waitCall, waitRows[0]);
      await zoom(host, readCall, later);
      for (const row of waitRows) await zoom(host, row);
      expect(await host.callTool("work", { name: "Alpha" })).toContain("ALPHA-FINDING");
      expect(await host.callTool("work", { name: "Beta" })).toContain("BETA-FINDING");
    });
  }

  for (const isError of [false, true]) {
    test(`an ordinary ${isError ? "error" : "success"} result keeps its pre-cap full output and images linked`, async () => {
      const host = await open();
      const user = host.user("read the complete result");
      await host.context([user]);
      const source = host.assistant("", { id: "full-call", name: "read", arguments: {} });
      await host.fire("message_end", { message: source });
      const full = `FULL-BEGIN ${"retained evidence ".repeat(50)} ARCHIVED-MIDDLE ${"retained evidence ".repeat(50)} FULL-END`;
      const [capped] = await host.fire("tool_result", {
        toolCallId: "full-call", toolName: "read", input: {}, isError,
        content: [{ type: "text", text: full }, IMAGE],
      });
      if (!isRecord(capped) || !Array.isArray(capped.content)) throw new Error("tool_result did not cap the fixture");
      expect(JSON.stringify(capped.content)).not.toContain("ARCHIVED-MIDDLE");
      expect(capped.content).toContainEqual(IMAGE);
      const delivered = result(host, "full-call", "read", "", { content: capped.content, isError });
      await host.fire("message_end", { message: delivered });
      await host.fire("agent_end", { messages: [user, source, delivered], willContinue: false });
      const messages = await rows(host);
      const sourceRow = call(messages, "read");
      const output = only(messages, (row) => row.kind === "echo");
      expect(output.text).toContain(`${isError ? "[error] " : ""}${full}`);
      expect(output.metadata?.images).toEqual([imageMetadata(1)]);
      associations(messages, [[output, sourceRow]]);
      await zoom(host, sourceRow, output);
      const reply = await host.tools.get("zoom")!.execute("inspect-image", { id: output.i, n: 1 }, undefined, undefined, host.ctx);
      expect(reply.content).toContainEqual(IMAGE);
      expect(reply.content[0]?.text).toContain("FULL-END");
    });
  }

  test("a task batch links every member without changing captured work or image placement", async () => {
    const host = await open();
    const messages = await record(host, [host.user("collect both tasks"),
      host.assistant("", { id: "task-call", name: "task", arguments: {} }),
      result(host, "task-call", "task", "two task reports", {
        content: [{ type: "text", text: "two task reports" }, IMAGE],
        details: { results: [
          { id: "agent-one", agent: "reviewer", output: "FIRST-TASK", exitCode: 0, durationMs: 10, truncated: false },
          { id: "agent-two", agent: "scout", output: "SECOND-TASK", exitCode: 0, durationMs: 20, truncated: false },
        ] },
      }),
    ]);
    const source = call(messages, "task");
    const reports = messages.filter((row) => row.kind === "work");
    expect(reports).toHaveLength(2);
    expect(reports.map((row) => row.metadata?.work)).toEqual([
      { source: "task", completeness: "full", agentId: "agent-one", name: "reviewer" },
      { source: "task", completeness: "full", agentId: "agent-two", name: "scout" },
    ]);
    expect(reports[0]!.text).toContain("FIRST-TASK");
    expect(reports[0]!.text).not.toContain("SECOND-TASK");
    expect(reports[1]!.text).toContain("SECOND-TASK");
    expect(reports[0]!.metadata?.images).toEqual([imageMetadata(1)]);
    expect(reports[1]!.metadata?.images).toBeUndefined();
    associations(messages, reports.map((row) => [row, source] as const));
    await zoom(host, source, reports[0]);
  });

  for (const deliveredName of ["Read", "functions.read", "grep"]) {
    test(`matching host ID but exact-name mismatch ${deliveredName} stays unlinked and consumes the candidate`, async () => {
      const host = await open();
      const messages = await record(host, [host.user("read the file"),
        host.assistant("", { id: "name-call", name: "read", arguments: {} }),
        result(host, "name-call", deliveredName, "MISMATCHED-NAME"),
        result(host, "name-call", "read", "LATE-CORRECT-NAME"),
      ]);
      expect(messages.filter((row) => row.kind === "echo")).toHaveLength(2);
      associations(messages, []);
      await zoom(host, call(messages, "read"));
    });
  }

  for (const completedFirst of [false, true]) {
    test(`duplicate source IDs ${completedFirst ? "after a completed delivery" : "before delivery"} never select the later call`, async () => {
      const host = await open();
      const source = host.assistant("", { id: "duplicate", name: "read", arguments: { path: "first" } });
      const second = host.assistant("", { id: "duplicate", name: "read", arguments: { path: "second" } });
      const messages = await record(host, [host.user("read both files"), source,
        ...(completedFirst ? [result(host, "duplicate", "read", "FIRST-DELIVERY")] : []),
        second, result(host, "duplicate", "read", "AMBIGUOUS-DELIVERY"),
      ]);
      const firstCall = call(messages, "read", { path: "first" });
      const secondCall = call(messages, "read", { path: "second" });
      const firstResult = completedFirst ? echo(messages, "FIRST-DELIVERY") : undefined;
      associations(messages, firstResult ? [[firstResult, firstCall]] : []);
      await zoom(host, firstCall, firstResult);
      await zoom(host, secondCall);
    });
  }

  test("a replay is deduplicated and a second result delivery cannot relink the consumed source", async () => {
    const host = await open();
    const first = result(host, "once", "read", "FIRST-RESULT");
    const messages = await record(host, [host.user("read once"),
      host.assistant("", { id: "once", name: "read", arguments: {} }), first, first,
      result(host, "once", "read", "DUPLICATE-DELIVERY"),
    ]);
    const source = call(messages, "read");
    const firstResult = echo(messages, "FIRST-RESULT");
    expect(messages.filter((row) => row.kind === "echo")).toHaveLength(2);
    associations(messages, [[firstResult, source]]);
    await zoom(host, source, firstResult);
    await zoom(host, echo(messages, "DUPLICATE-DELIVERY"));
  });

  test("source absence is not inferred from adjacent text, another ID, an aborted call, an empty ID or a future call", async () => {
    const host = await open();
    const aborted = host.assistant("", { id: "aborted", name: "read", arguments: { path: "aborted" } });
    aborted.stopReason = "aborted";
    const messages = await record(host, [host.user('read {} is text, not a call'),
      host.assistant("read {}"), result(host, "absent", "read", "NO-SOURCE"),
      host.assistant("", { id: "different-id", name: "read", arguments: { path: "different" } }),
      result(host, "absent-again", "read", "ADJACENT-WRONG-ID"), aborted,
      result(host, "aborted", "read", "ABORTED-SOURCE"),
      host.assistant("", { id: "", name: "read", arguments: { path: "empty" } }),
      result(host, "", "read", "EMPTY-ID"),
      result(host, "future", "read", "BEFORE-SOURCE"),
      host.assistant("", { id: "future", name: "read", arguments: { path: "future" } }),
    ]);
    expect(messages.filter((row) => row.kind === "echo")).toHaveLength(5);
    expect(messages.filter((row) => row.kind === "tool")).toHaveLength(3);
    associations(messages, []);
    for (const source of messages.filter((row) => row.kind === "tool")) await zoom(host, source);
  });

  test("session change forgets old pending IDs but allows the same ID for a newly captured call", async () => {
    const host = await open();
    await record(host, [host.user("old session"),
      host.assistant("", { id: "reused", name: "read", arguments: { path: "old" } }),
    ]);
    await host.fire("session_switch");
    const messages = await record(host, [host.user("new session"),
      result(host, "reused", "read", "NO-NEW-SOURCE"),
      host.assistant("", { id: "reused", name: "read", arguments: { path: "new" } }),
      result(host, "reused", "read", "NEW-SESSION-RESULT"),
    ]);
    const oldCall = call(messages, "read", { path: "old" });
    const newCall = call(messages, "read", { path: "new" });
    const output = echo(messages, "NEW-SESSION-RESULT");
    associations(messages, [[output, newCall]]);
    await zoom(host, oldCall);
    await zoom(host, newCall, output);
  });

  test("unsolicited async work remains unlinked even when its job ID and nearby call match", async () => {
    const host = await open();
    const delivery: HostMessage = { role: "custom", customType: "async-result", display: true,
      timestamp: Date.now() + 100,
      content: [{ type: "text", text: "ASYNC-FINDING" }, IMAGE],
      details: { jobs: [{ jobId: "async-id", agentId: "async-agent", label: "Async", type: "task", status: "completed" }] },
    };
    const messages = await record(host, [host.user("wait for a background job"),
      host.assistant("", { id: "async-id", name: "wait", arguments: {} }), delivery,
    ]);
    const report = only(messages, (row) => row.kind === "work");
    expect(report.text).toContain("ASYNC-FINDING");
    expect(report.metadata?.work).toEqual({ source: "async-result", completeness: "full", id: "async-id", agentId: "async-agent", name: "Async" });
    expect(report.metadata?.images).toEqual([imageMetadata(1)]);
    associations(messages, []);
    await zoom(host, call(messages, "wait"));
    await zoom(host, report);
  });

  test("delayed queued old work retains its epoch without consuming a reused new-session ID or pre-cap output", async () => {
    const host = await open();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const path = join(host.directory, "delayed-artifact.txt");
    await writeFile(path, "HYDRATED-OLD-WORK");
    const lookups: string[] = [];
    Object.assign(host.ctx.sessionManager, {
      async getArtifactPath(id: string): Promise<string | null> {
        lookups.push(id);
        entered.resolve();
        await release.promise;
        return id === "17" ? path : null;
      },
    });
    try {
      const oldUser = host.user("old session queued work");
      await host.context([oldUser]);
      const delayed: HostMessage = { role: "custom", customType: "async-result", display: true,
        timestamp: Date.now(), content: "old artifact preview",
        details: { jobs: [{ jobId: "bg_delayed", label: "Delayed", type: "bash", status: "completed",
          meta: { truncation: { artifactId: "17" } } }] },
      };
      await host.fire("message_end", { message: delayed });
      await entered.promise;
      const oldCall = host.assistant("", { id: "queued-reused", name: "read", arguments: { path: "old-queued" } });
      const oldResult = result(host, "queued-reused", "read", "OLD-QUEUED-RESULT");
      await host.fire("message_end", { message: oldCall });
      await host.fire("message_end", { message: oldResult });
      await host.fire("session_switch");
      const newUser = host.user("new session while the artifact is held");
      await host.context([newUser]);
      const newCall = host.assistant("", { id: "queued-reused", name: "read", arguments: { path: "new-queued" } });
      await host.fire("message_end", { message: newCall });
      const full = `NEW-FULL-BEGIN ${"new epoch evidence ".repeat(50)} NEW-ARCHIVED-MIDDLE ${"new epoch evidence ".repeat(50)} NEW-FULL-END`;
      const [capped] = await host.fire("tool_result", {
        toolCallId: "queued-reused", toolName: "read", input: {}, isError: false,
        content: [{ type: "text", text: full }],
      });
      if (!isRecord(capped) || !Array.isArray(capped.content)) throw new Error("tool_result did not cap the new result");
      expect(JSON.stringify(capped.content)).not.toContain("NEW-ARCHIVED-MIDDLE");
      release.resolve();
      // The old result's cleanup runs before this new result is queued; the new full capture must survive.
      await host.fire("agent_end", { messages: [newUser, newCall], willContinue: true });
      const newResult = result(host, "queued-reused", "read", "", { content: capped.content });
      await host.fire("message_end", { message: newResult });
      await host.fire("agent_end", { messages: [newUser, newCall, newResult], willContinue: false });
      const messages = await rows(host);
      const oldSource = call(messages, "read", { path: "old-queued" });
      const newSource = call(messages, "read", { path: "new-queued" });
      const oldOutput = echo(messages, "OLD-QUEUED-RESULT");
      const newOutput = echo(messages, full);
      const work = only(messages, (row) => row.kind === "work");
      expect(work.text).toContain("HYDRATED-OLD-WORK");
      expect(work.metadata?.work).toEqual({ source: "async-result", completeness: "full", id: "bg_delayed", name: "Delayed" });
      expect(lookups).toEqual(["17"]);
      associations(messages, [[oldOutput, oldSource], [newOutput, newSource]]);
      await zoom(host, oldSource, oldOutput);
      await zoom(host, newSource, newOutput);
      await zoom(host, work);
    } finally {
      release.resolve();
    }
  });

  test("reopening retains durable multi-row proof and the first-result pointer without a live host-ID map", async () => {
    const { host, compressor } = await harness.open({ flags: FLAGS });
    const delivery = waitDelivery(true);
    const before = await record(host, [host.user("collect reports"),
      host.assistant("", { id: "persisted-wait", name: "wait", arguments: {} }),
      result(host, "persisted-wait", "wait", delivery.text, { details: delivery.details }),
    ]);
    const source = call(before, "wait");
    const outputs = before.filter((row) => row.kind === "echo" || row.kind === "work");
    expect(outputs).toHaveLength(3);
    associations(before, outputs.map((row) => [row, source] as const));
    await host.shutdown();
    const reopened = await openFakeHost(createOptChat(), { directory: host.directory, flags: FLAGS,
      model: compressor.model, apiKey: "fixture-key" });
    harness.hosts.push(reopened);
    expect(await rows(reopened)).toEqual(before);
    await zoom(reopened, source, outputs[0]);
    expect(await reopened.callTool("work", { name: "Alpha" })).toContain("ALPHA-FINDING");
    const after = await record(reopened, [reopened.user("the host ID alone cannot recreate the source"),
      result(reopened, "persisted-wait", "wait", "AFTER-REOPEN-ORPHAN"),
    ]);
    associations(after, outputs.map((row) => [row, source] as const));
    await zoom(reopened, source, outputs[0]);
  });
});
