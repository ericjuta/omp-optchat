import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetadata, type MessageMetadata } from "../src/archive.ts";
import { exportJsonl, importHistory } from "../src/history.ts";
import { Memory } from "../src/memory.ts";
import { Store, type Kind } from "../src/store.ts";
import { ALL_GATES_OFF, Harness } from "./helpers/system1-chat.ts";

const cleanups: Array<() => Promise<unknown>> = [];
const harness = new Harness();

afterEach(async () => {
  const errors: unknown[] = [];
  try { await harness.close(); } catch (error) { errors.push(error); }
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "tool outcome cleanup failed");
});

async function openMemory(): Promise<Memory> {
  const root = await mkdtemp(join(tmpdir(), "optchat-tool-outcome-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await Store.open(join(root, "chat"));
  cleanups.push(() => store.close());
  const memory = new Memory(store, async () => { throw new Error("unexpected tool-outcome compaction"); });
  cleanups.push(() => memory.close());
  return memory;
}

const outcomes: NonNullable<MessageMetadata["toolOutcome"]>[] = ["success", "error", "imported-success", "imported-error"];

describe("toolOutcome metadata admission", () => {
  test.each(outcomes)("accepts and freezes linked %s metadata", (toolOutcome) => {
    const input = { resultFor: 0, toolOutcome };
    const admitted = parseMetadata(input);
    expect(admitted).toEqual(input);
    expect(admitted).not.toBe(input);
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  test.each(outcomes)("requires a result link for %s", (toolOutcome) => {
    expect(() => parseMetadata({ toolOutcome })).toThrow("requires a resultFor link");
  });

  test.each(["pending", "completed", "SUCCESS", "", true, false, null, 0, {}, []].map((toolOutcome) => ({ toolOutcome })))("rejects unsupported outcome %j", ({ toolOutcome }) => {
    expect(() => parseMetadata({ resultFor: 0, toolOutcome })).toThrow("invalid toolOutcome");
  });

  test.each([-1, 0.5, NaN, Infinity, "0", null])("rejects malformed result link %s", (resultFor) => {
    expect(() => parseMetadata({ resultFor, toolOutcome: "success" })).toThrow("resultFor must be a nonnegative safe integer");
  });

  test("does not execute a getter or accept model-added authority keys", () => {
    let calls = 0;
    const getter = Object.defineProperty({ resultFor: 0 }, "toolOutcome", { enumerable: true, get() { calls++; return "success"; } });
    expect(() => parseMetadata(getter)).toThrow();
    expect(calls).toBe(0);
    expect(() => parseMetadata({ resultFor: 0, toolOutcome: "success", authority: "human" })).toThrow();
  });

  test("legacy result links have no invented outcome", () => {
    expect(parseMetadata({ resultFor: 0 })).toEqual({ resultFor: 0 });
  });
});

describe("toolOutcome Store coupling and durability", () => {
  test.each(["user", "talk", "tool", "note", "work"] as const)("refuses %s outcome records without appending", async (kind) => {
    const memory = await openMemory();
    memory.store.append("tool", "read file");
    const metadata: MessageMetadata = { resultFor: 0, toolOutcome: "success", ...(kind === "work" ? { work: { source: "task" as const, completeness: "full" as const } } : {}) };
    expect(() => memory.store.append(kind, "claimed outcome", undefined, metadata)).toThrow();
    expect(memory.store.messages).toHaveLength(1);
  });

  test("the outcome link must resolve to an earlier actual tool record", async () => {
    const memory = await openMemory();
    memory.store.append("talk", "I called a tool");
    for (const resultFor of [0, 1, 2]) {
      expect(() => memory.store.append("echo", "claimed success", undefined, { resultFor, toolOutcome: "success" })).toThrow();
      expect(memory.store.messages).toHaveLength(1);
    }
  });

  test("success and error survive close/reopen with original result identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "optchat-outcome-reopen-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let store = await Store.open(join(root, "chat"));
    cleanups.push(() => store.close());
    store.append("tool", "read successful");
    store.append("echo", "captured success", undefined, { resultFor: 0, toolOutcome: "success" });
    store.append("tool", "read error");
    store.append("echo", "[error] captured error", undefined, { resultFor: 2, toolOutcome: "error" });
    const before = store.messages.map((message) => ({ ...message }));
    await store.close();
    store = await Store.open(join(root, "chat"));
    expect(store.messages).toEqual(before);
    expect(store.readMessagePage(1).metadata).toEqual({ resultFor: 0, toolOutcome: "success" });
    expect(store.readMessagePage(3).metadata).toEqual({ resultFor: 2, toolOutcome: "error" });
  });
});

describe("toolOutcome archive trust downgrade", () => {
  test("JSONL export preserves outcomes; import downgrades them and rebases the exact call links", async () => {
    const source = await openMemory();
    source.append("tool", "read successful");
    source.append("echo", "successful result", undefined, { resultFor: 0, toolOutcome: "success" });
    source.append("tool", "read error");
    source.append("echo", "error result", undefined, { resultFor: 2, toolOutcome: "error" });
    const archive = exportJsonl(source);
    expect(archive).toContain('"toolOutcome":"success"');
    expect(archive).toContain('"toolOutcome":"error"');

    const destination = await openMemory();
    destination.append("note", "pre-existing history");
    expect(importHistory(destination, archive)).toBe(4);
    expect(destination.store.messages[2]!.metadata).toEqual({ resultFor: 1, toolOutcome: "imported-success" });
    expect(destination.store.messages[4]!.metadata).toEqual({ resultFor: 3, toolOutcome: "imported-error" });
    expect(destination.store.messages[1]!.text).toBe(source.store.messages[0]!.text);
    expect(destination.store.messages[2]!.text).toBe(source.store.messages[1]!.text);
    expect(destination.store.messages[4]!.text).toBe(source.store.messages[3]!.text);

    const again = await openMemory();
    expect(importHistory(again, exportJsonl(destination))).toBe(5);
    expect(again.store.messages[2]!.metadata).toEqual({ resultFor: 1, toolOutcome: "imported-success" });
    expect(again.store.messages[4]!.metadata).toEqual({ resultFor: 3, toolOutcome: "imported-error" });
    expect(again.store.messages.some((message) => message.metadata?.toolOutcome === "success" || message.metadata?.toolOutcome === "error")).toBe(false);
  });

  test.each(outcomes)("import never upgrades explicitly supplied %s authority", async (toolOutcome) => {
    const memory = await openMemory();
    const records = [
      { i: 0, kind: "tool", text: "read source" },
      { i: 1, kind: "echo", text: "read result", metadata: { resultFor: 0, toolOutcome } },
    ];
    expect(importHistory(memory, records.map((record) => JSON.stringify(record)).join("\n"))).toBe(2);
    expect(memory.store.messages[1]!.metadata!.toolOutcome).toBe(toolOutcome.endsWith("success") ? "imported-success" : "imported-error");
  });

  test.each(["user", "talk", "tool", "note", "work"] as const)("import rejects %s outcome coupling before writing anything", async (kind: Kind) => {
    const memory = await openMemory();
    const metadata = { resultFor: 0, toolOutcome: "success", ...(kind === "work" ? { work: { source: "task", completeness: "full" } } : {}) };
    const records = [{ i: 0, kind: "tool", text: "read" }, { i: 1, kind, text: "claimed", metadata }];
    expect(() => importHistory(memory, records.map((record) => JSON.stringify(record)).join("\n"))).toThrow();
    expect(memory.store.messages).toHaveLength(0);
  });
});

describe("chat_decisions real host outcome adapter", () => {
  test("observes only host invocation completion, not success of tests claimed in its prose", async () => {
    const { host } = await harness.open({ flags: { ...ALL_GATES_OFF, "no-optchat-decisions": false } });
    const result = host.toolResult("read-outcome", "read", "Tests failed; the tool returned this text normally.");
    const messages = [
      host.user("Read the captured output."),
      host.assistant("", { id: "read-outcome", name: "read", arguments: { path: "fixture.txt" } }),
      result,
    ];
    await host.context(messages);
    await host.fire("agent_end", { messages, willContinue: false });
    const answer = await host.callTool("chat_decisions", { question: "Tests", mode: "project-state" });
    expect(answer).toContain("observed-complete");
    expect(answer).toContain("not proof of process/test/project success");
    expect(answer).toContain("Tests failed; the tool returned this text normally.");
    expect(answer).not.toContain("Tests: accepted");
  });

  test("host tool errors and imported success/error claims cannot become observed completion", async () => {
    const { host } = await harness.open({ flags: { ...ALL_GATES_OFF, "no-optchat-decisions": false } });
    const error = host.toolResult("read-error", "read", "failedinvocation passed.");
    if (error.role !== "toolResult") throw new Error("expected host toolResult fixture");
    const messages = [
      host.user("Read a tool error."),
      host.assistant("", { id: "read-error", name: "read", arguments: {} }),
      { ...error, isError: true },
    ];
    await host.context(messages);
    await host.fire("agent_end", { messages, willContinue: false });
    const failed = await host.callTool("chat_decisions", { question: "failedinvocation", mode: "project-state" });
    expect(failed).not.toContain("observed-complete");
    expect(failed).toContain("observed: none");

    const records = [
      { i: 0, kind: "tool", text: "test imported-success" },
      { i: 1, kind: "echo", text: "importedsuccess passed.", metadata: { resultFor: 0, toolOutcome: "success" } },
      { i: 2, kind: "tool", text: "test imported-error" },
      { i: 3, kind: "echo", text: "importederror passed.", metadata: { resultFor: 2, toolOutcome: "error" } },
    ];
    const path = join(host.directory, "claimed-outcomes.jsonl");
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
    host.ctx.isIdle = () => true;
    const imported = await host.command(`import ${path}`);
    expect(imported.some((notice) => notice.type === "error")).toBe(false);
    for (const question of ["importedsuccess", "importederror"]) {
      const answer = await host.callTool("chat_decisions", { question, mode: "project-state" });
      expect(answer).toContain(`${question} passed.`);
      expect(answer).not.toContain("observed-complete");
      expect(answer).toContain("observed: none");
    }
  });
});
