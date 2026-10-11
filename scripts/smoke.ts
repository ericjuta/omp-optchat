#!/usr/bin/env bun
/** Synthetic model responses, real installed OMP CLI, extension discovery and tools. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ASYNC_BODY, ASYNC_ID, ASYNC_SCHEMA, CHILD_REPORT, CHILD_TASK, SIDE_PROMPT, SIDE_REPLY, smokePng } from "./smoke-fixtures.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Capture = { sequence: number; body: ObjectValue };
type DiskMessage = { i: number; kind: string; text: string; date: string; metadata?: ObjectValue };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = resolve(process.env.OPTCHAT_SMOKE_PLUGIN ?? ROOT);
const STEP_MS = 25_000;
const TOTAL_MS = 240_000;
const FIRST_USER = "OPTCHAT_SMOKE_OLD_USER: Remember the public archive, then finish.";
const SECOND_USER = "OPTCHAT_SMOKE_CURRENT_USER: Retrieve the entire previous reply and its date.";
const RESTART_USER = "OPTCHAT_SMOKE_RESTART_USER: Report that the public archive is restored.";
const INACTIVE_USER = "OPTCHAT_SMOKE_INACTIVE_USER: Return the public archive without memory.";
const INACTIVE_NEXT_USER = "OPTCHAT_SMOKE_INACTIVE_NEXT_USER: Finish this ordinary conversation.";
const INACTIVE_FINISHED = "OPTCHAT_SMOKE_INACTIVE_FINISHED";
const FIRST_THINKING = "OPTCHAT_SMOKE_PRIVATE_OLD_REASONING";
const TOOL_THINKING = "OPTCHAT_SMOKE_PRIVATE_ACTIVE_TOOL_REASONING";
const SUMMARY = "SYNTHETIC_SUMMARY_OLDEST_PUBLIC_FACT";
const FINISHED = "OPTCHAT_SMOKE_TOOLS_FINISHED";
const RESTORED = "OPTCHAT_SMOKE_RESTORED";
const AFTER_SIDE = "OPTCHAT_SMOKE_AFTER_SIDE: answer normally after the completed side turn.";
const AFTER_SIDE_DONE = "OPTCHAT_SMOKE_AFTER_SIDE_DONE";
const WORK_READY = "OPTCHAT_SMOKE_WORK_READY: acknowledge the delivered synthetic background report.";
const WORK_USER = "OPTCHAT_SMOKE_WORK_READ: recover the complete named background report.";
const WORK_DONE = "OPTCHAT_SMOKE_WORK_RECOVERED";
const IMAGE_USER = "OPTCHAT_SMOKE_IMAGE_SOURCE: preserve these two synthetic image bytes in order.";
const IMAGE_READ = "OPTCHAT_SMOKE_IMAGE_READ: retrieve the original image-bearing source.";
const IMAGE_DONE = "OPTCHAT_SMOKE_IMAGE_RETRIEVED";
const CHILD_USER = "OPTCHAT_SMOKE_CHILD_DISPATCH: delegate the archive retrieval to the fixture child.";
const CHILD_DONE = "OPTCHAT_SMOKE_CHILD_DONE";
const IMAGE_DATA = [smokePng(255, 0, 0), smokePng(0, 255, 0)];
/** The images as the host delivered them to the provider, in order: the archive stores exactly these. */
let seenImages: Array<{ data: string; mimeType: string }> = [];
const LONG_REPLY = `OPTCHAT_SMOKE_RAW_BEGIN\n${"Public archive line; deterministic fixture only.\n".repeat(800)}OPTCHAT_SMOKE_RAW_END`;
const captures: Capture[] = [];
const hosts: Host[] = [];
let targetRecord: DiskMessage | undefined;
let retrievalSnapshot: string | undefined;
let retrievedPages = 0;
let workRecord: DiskMessage | undefined;
let imageRecord: DiskMessage | undefined;
let childRetrieved = false;
let childFrozenView: string | undefined;
let serverFailure: Error | undefined;
let currentPhase = "setup";
let hostWorkspace: string | undefined;
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
  assert(names.includes("work"), "named work retrieval must be registered");
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
  const requestMessages = messages(body);
  if (model === "optchat-smoke-child") {
    assertToolNames(body);
    assert(targetRecord, "child fixture needs the durable original");
    const snapshot = view(body);
    assert(snapshot.includes(SUMMARY), "actual task child must inherit the frozen parent summary");
    const results = requestMessages.filter((message) => message.role === "tool" && message.tool_call_id === "smoke-child-zoom");
    if (results.length === 0) {
      assert(requestMessages.some((message) => content(message).includes(CHILD_TASK)), "host child must receive its actual task");
      childFrozenView = snapshot;
      return sse(model, capture.sequence, undefined, undefined, [
        { index: 0, id: "smoke-child-zoom", type: "function", function: { name: "zoom", arguments: JSON.stringify({ id: targetRecord.i, n: 1 }) } },
      ]);
    }
    assert(content(results[0]!).includes("OPTCHAT_SMOKE_RAW_BEGIN"), "child zoom must reach actual parent source bytes");
    assert.equal(snapshot, childFrozenView, "child retrieval must retain the same frozen view");
    childRetrieved = true;
    return sse(model, capture.sequence, undefined, undefined, [
      { index: 0, id: "smoke-child-yield", type: "function", function: { name: "yield", arguments: JSON.stringify({ data: { report: CHILD_REPORT } }) } },
    ]);
  }
  assert.equal(model, "optchat-smoke-chat", "unexpected model reached fixture");
  if (requestMessages.some((message) => message.role === "user" && content(message).includes(SIDE_PROMPT))) {
    return sse(model, capture.sequence, SIDE_REPLY);
  }
  const current = requestMessages.filter((message) => message.role === "user").at(-1);
  assert(current, "current user required");
  // Support the host's separate snapshot message as well as prepended user-content blocks.
  const candidates = requestMessages.filter((message) => message.role === "user").map((message) => content(message).replace(/<chat>[\s\S]*?<\/chat>/g, "").trim());
  // Tool-returned images may be encoded in a new trailing user message. The original fixture
  // request remains the last user text with an exact known runtime marker.
  const runtimePrompts = [AFTER_SIDE, WORK_READY, WORK_USER, IMAGE_USER, IMAGE_READ, CHILD_USER];
  const prompt = candidates.findLast((text) => runtimePrompts.includes(text)) ?? content(current).replace(/<chat>[\s\S]*?<\/chat>/g, "").trim();
  if (currentPhase.startsWith("inactive ")) {
    // The real host prepends its date/cwd reminder as a separate text part.
    // Admit only that exact envelope, never arbitrary prefixes around the marker.
    const ordinaryUsers = requestMessages.filter((message) => message.role === "user").map((message) => {
      if (typeof message.content === "string") return message.content;
      assert(Array.isArray(message.content) && (message.content.length === 1 || message.content.length === 2), "ordinary user must contain one marker plus an optional host reminder");
      const texts = message.content.map((part) => {
        const entry = object(part, "ordinary user text");
        assert(typeof entry.text === "string", "ordinary user text required");
        assert.deepEqual(entry, { type: "text", text: entry.text }, "ordinary user must contain only text parts");
        return entry.text;
      });
      if (texts.length === 2) {
        const reminder = /^<system-reminder>\nToday: (\d{4}-\d{2}-\d{2}); current working directory: '([^'\n]+)'\. Do not repeat this information in your reply\.\n<\/system-reminder>$/.exec(texts[0]!);
        assert(reminder, "only the observed date/cwd reminder may precede an ordinary user marker");
        assert.equal(reminder[2], hostWorkspace, "host reminder must identify the isolated workspace");
      }
      return texts.at(-1)!;
    });
    const ordinaryPrompt = ordinaryUsers.at(-1);
    assert(ordinaryPrompt === INACTIVE_USER || ordinaryPrompt === INACTIVE_NEXT_USER, "inactive request must end with the exact expected user marker");
    assert.deepEqual(ordinaryUsers, ordinaryPrompt === INACTIVE_USER ? [INACTIVE_USER] : [INACTIVE_USER, INACTIVE_NEXT_USER], "ordinary user markers must each occur once, in order, with no extra content");
    const wire = JSON.stringify(body);
    for (const marker of ordinaryUsers) assert.equal(wire.split(marker).length - 1, 1, "each ordinary user marker must occur exactly once on the wire");
    assert(!wire.includes("# OptChat memory"), "disabled plugin must not inject its system protocol");
    assert(!wire.includes("<chat>") && !wire.includes("</chat>"), "disabled plugin must not inject a memory view");
    assert(body.tools === undefined || Array.isArray(body.tools), "tools must be absent or an array");
    const names = (body.tools ?? []).map((value) => object(object(value, "tool").function, "tool function").name);
    assert(!names.includes("zoom") && !names.includes("date"), "disabled plugin must not inject memory tools");
    if (ordinaryPrompt === INACTIVE_NEXT_USER) {
      assert.equal(requestMessages.filter((message) => message.role === "assistant" && content(message) === LONG_REPLY).length, 1, "disabled plugin must preserve the oversized ordinary assistant history exactly once");
    }
    return sse(model, capture.sequence, ordinaryPrompt === INACTIVE_USER ? LONG_REPLY : INACTIVE_FINISHED);
  }
  assertToolNames(body);
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
        { index: 0, id: "smoke-zoom-0", type: "function", function: { name: "zoom", arguments: JSON.stringify({ id: targetRecord.i, n: 1, offset: 0 }) } },
        { index: 1, id: "smoke-date", type: "function", function: { name: "date", arguments: JSON.stringify({ id: targetRecord.i }) } },
      ]);
    }
    const date = results.find((message) => message.tool_call_id === "smoke-date");
    assert(targetRecord, "date requires the original durable record");
    assert.equal(date && content(date).trim(), new Date(targetRecord.date).toLocaleString(), "date must return the original record's local display date");
    // Walk bounded zoom pages by the cursor the host reports; never guess offsets.
    const zooms = results.filter((message) => String(message.tool_call_id).startsWith("smoke-zoom-"));
    const pages = zooms.map((message) => content(message).replace(/\n?\[(?:bytes \d+-\d+ of \d+; next offset \d+|end of \d+ bytes)\]$/, ""));
    const cursor = /next offset (\d+)\]$/.exec(content(zooms.at(-1)!));
    if (cursor) {
      assert.equal(Number(cursor[1]), pages.reduce((total, page) => total + Buffer.byteLength(page), 0), "next cursor must equal the bytes already returned");
      return sse(model, capture.sequence, undefined, undefined, [
        { index: 0, id: `smoke-zoom-${zooms.length}`, type: "function", function: { name: "zoom", arguments: JSON.stringify({ id: targetRecord.i, n: 1, offset: Number(cursor[1]) }) } },
      ]);
    }
    assert(zooms.length >= 2, "oversized record must need more than one bounded zoom page");
    assert.equal(pages.join(""), LONG_REPLY, "paged zoom must reassemble the complete original record");
    retrievedPages = zooms.length;
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
  if (prompt === AFTER_SIDE) {
    assertSnapshot(body, AFTER_SIDE, [FIRST_USER, LONG_REPLY]);
    assert(!JSON.stringify(body).includes(SIDE_PROMPT) && !JSON.stringify(body).includes(SIDE_REPLY), "ephemeral content must not enter the next ordinary request");
    return sse(model, capture.sequence, AFTER_SIDE_DONE);
  }
  if (prompt === IMAGE_USER) {
    // OMP normalizes attached images (18.9.0 re-encodes them to WebP) before the provider sees them.
    seenImages = [...JSON.stringify(body).matchAll(/data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)/g)]
      .map((match) => ({ mimeType: match[1]!, data: match[2]! }));
    assert.equal(seenImages.length, IMAGE_DATA.length, "both RPC images must reach the image-capable provider");
    return sse(model, capture.sequence, "OPTCHAT_SMOKE_IMAGES_STORED");
  }
  if (prompt === IMAGE_READ) {
    assert(imageRecord, "image read needs its durable source id");
    const result = requestMessages.find((message) => message.role === "tool" && message.tool_call_id === "smoke-image-zoom");
    if (!result) return sse(model, capture.sequence, undefined, undefined, [
      { index: 0, id: "smoke-image-zoom", type: "function", function: { name: "zoom", arguments: JSON.stringify({ id: imageRecord.i, n: 1 }) } },
    ]);
    assert(content(result).includes(IMAGE_USER), "image zoom must return its source text");
    const wire = JSON.stringify(body);
    const wireImages = [...wire.matchAll(/data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]{0,16})/g)].map((match) => `${match[1]}:${match[2]}`);
    for (const { data } of seenImages) assert(wire.includes(data), `zoom must deliver durable image bytes on the real provider wire (stored ${JSON.stringify(seenImages.map((image) => `${image.mimeType}:${image.data.slice(0, 16)}`))}, wire ${JSON.stringify(wireImages)})`);
    assert(wire.indexOf(seenImages[0]!.data) < wire.indexOf(seenImages[1]!.data), "retrieved image order must match source order");
    return sse(model, capture.sequence, IMAGE_DONE);
  }
  if (prompt === WORK_READY) return sse(model, capture.sequence, "OPTCHAT_SMOKE_WORK_READY_ACK");
  if (prompt === WORK_USER) {
    assert(workRecord, "work read needs its durable captured report");
    const results = requestMessages.filter((message) => message.role === "tool" && String(message.tool_call_id).startsWith("smoke-work-"));
    if (results.length === 0) return sse(model, capture.sequence, undefined, undefined, [
      { index: 0, id: "smoke-work-0", type: "function", function: { name: "work", arguments: JSON.stringify({ name: ASYNC_ID, offset: 0 }) } },
    ]);
    const pages = results.map((result) => content(result).replace(/\n?\[(?:bytes \d+-\d+ of \d+; next offset \d+|end of \d+ bytes)\]$/, ""));
    const next = /next offset (\d+)\]$/.exec(content(results.at(-1)!));
    if (next) return sse(model, capture.sequence, undefined, undefined, [
      { index: 0, id: `smoke-work-${results.length}`, type: "function", function: { name: "work", arguments: JSON.stringify({ name: ASYNC_ID, offset: Number(next[1]) }) } },
    ]);
    assert(results.length > 1, "large structured report requires bounded pages");
    assert.equal(pages.join(""), workRecord.text, "named work must recover the entire captured structured report");
    return sse(model, capture.sequence, WORK_DONE);
  }
  if (prompt === CHILD_USER) {
    const result = requestMessages.find((message) => message.role === "tool" && message.tool_call_id === "smoke-task");
    if (!result) return sse(model, capture.sequence, undefined, undefined, [
      { index: 0, id: "smoke-task", type: "function", function: { name: "task", arguments: JSON.stringify({ context: "Use only the frozen synthetic parent archive.", tasks: [{ name: "SmokeChild", task: CHILD_TASK, solutionSpace: "Fixed synthetic archive retrieval; no design choices.", agent: "optchat-smoke-reader" }] }) } },
    ]);
    assert(childRetrieved, "the real task child must perform its own memory retrieval");
    assert(content(result).includes(CHILD_REPORT), "parent task result must contain the child's public report");
    const workResult = requestMessages.find((message) => message.role === "tool" && message.tool_call_id === "smoke-child-work");
    if (!workResult) return sse(model, capture.sequence, undefined, undefined, [
      { index: 0, id: "smoke-child-work", type: "function", function: { name: "work", arguments: JSON.stringify({ name: "optchat-smoke-reader" }) } },
    ]);
    assert(content(workResult).includes(CHILD_REPORT), "parent must retrieve the actual completed child's durable report by name");
    return sse(model, capture.sequence, CHILD_DONE);
  }
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

  async prompt(message: string, images: ObjectValue[] = []): Promise<void> {
    await this.until("RPC ready", () => this.events.some((event) => event.type === "ready"));
    const result = await this.command("prompt", { message, ...(images.length ? { images } : {}) });
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
        const metadata = value.metadata === undefined ? undefined : object(value.metadata, "message metadata");
        result.push({ i: value.i, kind: value.kind, text: value.text, date: value.date, ...(metadata ? { metadata } : {}) });
      }
    }
  }
  return result.sort((a, b) => a.i - b.i);
}

/** Extra proofs all use the actual compiled CLI and its event/tool paths, never a fake ExtensionAPI. */
async function runtimeCases(executable: string, baseArgs: string[], workspace: string, env: NodeJS.ProcessEnv, memory: string): Promise<ObjectValue> {
  const before = captures.length;
  const live = new Host(executable, [...baseArgs, "--optchat-dir", memory], workspace, env);
  await live.until("runtime host ready", () => live.events.some((event) => event.type === "ready"));
  currentPhase = "idle ephemeral then ordinary turn";
  const beforeSide = await diskMessages(memory);
  const beforeSideCalls = captures.length;
  const side = await live.command("btw", { question: SIDE_PROMPT });
  assert.equal(side.success, true, "native RPC BTW must admit the side turn");
  const sideRecord = object(object(side.data, "BTW response").record, "BTW record");
  await live.until("native BTW completion", () => live.events.some((event) => {
    if (event.type !== "btw_record") return false;
    const record = object(event.record, "BTW event record");
    return record.id === sideRecord.id && record.status !== "running";
  }));
  const sideHistory = await live.command("get_btw_history");
  assert.equal(sideHistory.success, true, "BTW history checkpoint must settle");
  const sideRecords = object(sideHistory.data, "BTW history").records;
  assert(Array.isArray(sideRecords), "BTW history must have records");
  const sideDone = sideRecords.map((record) => object(record, "BTW record")).find((record) => record.id === sideRecord.id);
  assert(sideDone && sideDone.status === "complete" && JSON.stringify(sideDone).includes(SIDE_REPLY), "native side turn must complete with fixture answer");
  assert(captures.slice(beforeSideCalls).some((entry) => JSON.stringify(entry.body).includes(SIDE_PROMPT)), "actual side-turn provider request must be observed");
  assert.deepEqual(await diskMessages(memory), beforeSide, "ephemeral request and response must not be durably archived");
  await live.prompt(AFTER_SIDE);
  assert((await diskMessages(memory)).some((record) => record.text === AFTER_SIDE_DONE), "ordinary turn after side turn must finish and persist");

  currentPhase = "structured async report capture";
  await live.prompt("/optchat-smoke-report");
  await live.prompt(WORK_READY);
  workRecord = (await diskMessages(memory)).find((record) => record.kind === "work" && record.metadata?.work !== undefined && object(record.metadata.work, "work metadata").id === ASYNC_ID);
  assert(workRecord, "full synthetic async-result must reach the actual durable work capture path");
  const workMetadata = object(workRecord.metadata?.work, "captured work metadata");
  assert.equal(workMetadata.source, "async-result");
  assert.equal(workMetadata.completeness, "full");
  assert(workRecord.text.includes(JSON.stringify(ASYNC_SCHEMA)), "structured report must survive capture completely, not just its host preview");
  assert(Buffer.byteLength(workRecord.text) > 32_768 && ASYNC_BODY.length > 30_000, "fixture must exceed both source page and live cap budgets");
  await live.prompt(WORK_USER);
  assert(live.events.some((event) => JSON.stringify(event).includes(WORK_DONE)), "paged named work retrieval must finish");
  const workDetails = object(publicToolResult(live, "smoke-work-0").details, "work tool details");
  assert.equal(workDetails.messageId, workRecord.i);
  assert.equal(workDetails.source, "async-result");
  assert.equal(workDetails.completeness, "full");
  assert.equal(workDetails.totalBytes, Buffer.byteLength(workRecord.text));
  assert(typeof workDetails.next === "number" && workDetails.next <= 16_384, "first work page must expose a bounded next cursor");

  currentPhase = "image archive ingress";
  await live.prompt(IMAGE_USER, IMAGE_DATA.map((data) => ({ type: "image", data, mimeType: "image/png" })));
  imageRecord = (await diskMessages(memory)).find((record) => record.kind === "user" && record.text.includes(IMAGE_USER));
  assert(imageRecord, "image-bearing original user record must be durable");
  const refs = imageRecord.metadata?.images;
  assert(Array.isArray(refs) && refs.length === IMAGE_DATA.length, "all original image references must be retained in source order");
  for (let index = 0; index < refs.length; index++) {
    const image = object(refs[index], "stored image descriptor");
    assert(typeof image.sha256 === "string" && /^[0-9a-f]{64}$/.test(image.sha256), "image ref must be content-addressed");
    const bytes = await readFile(join(memory, "images", image.sha256));
    assert.equal(bytes.toString("base64"), seenImages[index]!.data, "durable image bytes must exactly match the delivered images, in order");
  }
  await live.prompt(IMAGE_READ);
  const imageResult = publicToolResult(live, "smoke-image-zoom");
  assert(Array.isArray(imageResult.content), "image retrieval has multimodal content");
  const returnedImages = imageResult.content.map((part) => object(part, "tool content")).filter((part) => part.type === "image");
  assert.deepEqual(returnedImages.map((part) => ({ data: part.data, mimeType: part.mimeType })), seenImages, "actual zoom tool must return both stored ImageContent parts exactly");
  await bounded("runtime host shutdown", live.stop());

  currentPhase = "image and work retrieval after restart";
  const restored = new Host(executable, [...baseArgs, "--optchat-dir", memory], workspace, env);
  await restored.prompt(IMAGE_READ);
  await restored.prompt(WORK_USER);
  await bounded("media restoration host shutdown", restored.stop());

  currentPhase = "real task child memory handoff";
  const childArgs = baseArgs.filter((arg) => arg !== "--no-tools");
  const parent = new Host(executable, [...childArgs, "--tools", "task", "--optchat-child-view", "--optchat-dir", memory], workspace, env);
  await parent.prompt(CHILD_USER);
  assert(childRetrieved, "actual task child must execute zoom over frozen parent memory");
  const finalRecords = await diskMessages(memory);
  assert(finalRecords.some((record) => record.kind === "work" && record.text.includes(CHILD_REPORT) && object(record.metadata?.work, "child work metadata").source === "task"), "actual child report must be durably captured as task work");
  assert(!finalRecords.some((record) => record.kind === "talk" && record.text === CHILD_REPORT), "child must not write its own talk record to the parent's store");
  assert(!finalRecords.some((record) => record.kind === "user" && record.text.includes(CHILD_TASK)), "child task must not become an independent parent user turn");
  await bounded("task parent shutdown", parent.stop());
  return { sideTurnThenOrdinary: true, structuredAsyncReportBytes: Buffer.byteLength(workRecord.text), storedImages: IMAGE_DATA.length, mediaRestart: true, workRestart: true, actualTaskChild: true, childReadOnly: true, requests: captures.length - before };
}

/** Inspect the host's completed public tool result, not a fabricated provider usage response. */
function publicToolResult(host: Host, id: string): ObjectValue {
  for (const event of host.events.toReversed()) {
    if (event.type === "tool_execution_end" && event.toolCallId === id) return object(event.result, "tool execution result");
    if (event.type !== "message_end" || !event.message || typeof event.message !== "object" || Array.isArray(event.message)) continue;
    if (event.message.role === "toolResult" && event.message.toolCallId === id) return event.message;
  }
  throw new Error(`Host did not emit a completed public result for ${id}`);
}

// Installed-host CLI and isolated configuration are supplied by the integration contract below.
async function main(): Promise<void> {
  const executable = Bun.which(process.env.OPTCHAT_SMOKE_OMP ?? "omp");
  assert(executable, "Installed omp executable required (or set OPTCHAT_SMOKE_OMP)");
  const temporary = await mkdtemp(join(tmpdir(), "omp-optchat-smoke-"));
  const memory = join(temporary, "memory");
  const workspace = join(temporary, "workspace");
  hostWorkspace = workspace;
  const home = join(temporary, "home");
  const agentDirectory = join(temporary, "agent");
  const deadline = setTimeout(() => fatal.reject(new Error(`smoke exceeded ${TOTAL_MS}ms hard deadline during ${currentPhase}`)), TOTAL_MS);
  let server: Bun.Server<undefined> | undefined;
  try {
    await Promise.all([mkdir(memory), mkdir(workspace), mkdir(home), mkdir(agentDirectory)]);
    const fixtureConfig = join(temporary, "fixture.yml");
    await writeFile(fixtureConfig, "task:\n  batch: true\nasync:\n  enabled: true\ntools:\n  intentTracing: false\nautolearn:\n  enabled: false\n");
    const agents = join(workspace, ".omp", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "optchat-smoke-reader.md"), [
      "---", "name: optchat-smoke-reader", "description: Synthetic OptChat child-view fixture",
      "model: optchat-smoke/optchat-smoke-child", "thinking: off", "tools: []", "blocking: true", "---",
      "Use only the frozen synthetic parent archive. Execute the assigned zoom, then yield the requested public report.", "",
    ].join("\n"));
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
    // Link only inside this fresh synthetic HOME. The subsequent CLI launches must
    // discover the installed package; only the synthetic provider uses explicit -e.
    currentPhase = "isolated plugin link";
    const link = new Host(executable, ["plugin", "link", PLUGIN, "--json"], workspace, env);
    link.process.stdin.end();
    const linked = await bounded("isolated plugin link", link.exited);
    assert.equal(linked.code, 0, `isolated plugin link failed: ${link.diagnostics}`);
    const baseArgs = [
      "--mode", "rpc", "--no-ui", "--no-title", "--no-tools", "--no-skills", "--no-rules",
      "--config", fixtureConfig,
      "--session-dir", join(temporary, "sessions"),
      "-e", join(ROOT, "scripts", "fixture-provider.ts"),
      "--model", "optchat-smoke/optchat-smoke-chat",
      "--optchat-model", "optchat-smoke/optchat-smoke-compact",
      // The loopback scripts every request: System One gates (on by default) would send judge calls to it.
      "--no-optchat-rules", "--no-optchat-prefetch", "--no-optchat-value-score", "--no-optchat-tool-gate",
    ];
    // No enable flag: the full active lifecycle below proves default activation.
    const args = [...baseArgs, "--optchat-dir", memory];
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
    const firstZoom = publicToolResult(first, "smoke-zoom-0");
    const firstZoomDetails = object(firstZoom.details, "zoom details");
    assert.equal(firstZoomDetails.offset, 0);
    assert.equal(firstZoomDetails.totalBytes, Buffer.byteLength(LONG_REPLY));
    assert(typeof firstZoomDetails.next === "number" && firstZoomDetails.next <= 16_384, "zoom must expose the first bounded byte cursor");
    assert(completed.some((record) => record.kind === "talk" && record.text === LONG_REPLY), "the complete original record must remain durable and addressable");
    assert(!JSON.stringify(completed).includes(FIRST_THINKING) && !JSON.stringify(completed).includes(TOOL_THINKING), "durable history must exclude reasoning");
    const compactions = captures.filter((capture) => capture.body.model === "optchat-smoke-compact");
    const oldRecordCompaction = compactions.find((capture) => JSON.stringify(capture.body).includes("OPTCHAT_SMOKE_RAW_BEGIN"));
    assert(oldRecordCompaction, "oversized past record must invoke the real compressor adapter");
    const compactText = JSON.stringify(oldRecordCompaction.body);
    assert(compactText.includes(FIRST_USER), "compactor must receive prior contextual prefix");
    assert(compactText.indexOf(FIRST_USER) < compactText.indexOf("OPTCHAT_SMOKE_RAW_BEGIN"), "compactor context must precede its target record");
    assert(!compactText.includes(SECOND_USER), "current user must not leak into past-record compaction context");
    const firstRequest = captures.find((capture) => capture.body.model === "optchat-smoke-chat")!;
    assert.deepEqual(oldRecordCompaction.body.tools, firstRequest.body.tools, "compactor must share the active main-turn tool schemas without executing tools");
    const system = (body: ObjectValue) => messages(body).filter((message) => message.role === "system");
    assert.deepEqual(system(oldRecordCompaction.body), system(firstRequest.body), "compactor must share the stable main-turn system prefix");
    assert.match(compactText, /-{512}/, "compaction must use the dash ruler rather than example content");

    // The "inactive " phase prefix selects the inactive fixture branch: this writer is an ordinary turn without memory.
    const contenderStart = captures.length;
    currentPhase = "inactive second writer";
    const beforeContender = captures.filter((capture) => capture.body.model === "optchat-smoke-chat").length;
    const contender = new Host(executable, args, workspace, env);
    await contender.until("contender RPC ready", () => contender.events.some((event) => event.type === "ready"));
    const accepted = await contender.command("prompt", { message: INACTIVE_USER });
    assert.equal(accepted.success, true, "an inactive second writer accepts ordinary prompts");
    await contender.finishPrompt(accepted.id);
    const contenderEnd = captures.length;
    assert.equal(captures.filter((capture) => capture.body.model === "optchat-smoke-chat").length, beforeContender + 1, "the inactive writer sends exactly one ordinary request");
    assert.deepEqual(await diskMessages(memory), completed, "the inactive writer must not append durable history");
    await bounded("contender host shutdown", contender.stop());

    currentPhase = "graceful process shutdown";
    await bounded("first host shutdown", first.stop());
    assert.equal((await first.exited).code, 0, "first host must finish graceful session_shutdown");
    const persistedView = await readFile(join(memory, "view.json"), "utf8");
    currentPhase = "restoration in new process";
    const restarted = new Host(executable, args, workspace, env);
    await restarted.until("restored RPC ready", () => restarted.events.some((event) => event.type === "ready"));
    assert.equal(await readFile(join(memory, "view.json"), "utf8"), persistedView, "restarting must preserve the persisted main view instead of rebuilding it");
    await restarted.prompt(RESTART_USER);
    const restored = await diskMessages(memory);
    assert(restored.some((record) => record.kind === "talk" && record.text === RESTORED), "restored session final answer must be durable");
    assert.equal(new Set(restored.map((record) => record.i)).size, restored.length, "restart must not duplicate durable IDs");
    assert.equal(restored.filter((record) => record.kind === "user" && record.text === FIRST_USER).length, 1, "restart must not reappend old user turns");
    assert.equal(restored.filter((record) => record.kind === "talk" && record.text === LONG_REPLY).length, 1, "restart must not reappend old assistant turns");
    await bounded("restored host shutdown", restarted.stop());
    assert.equal((await restarted.exited).code, 0, "restored host must finish graceful session_shutdown");
    // The inactive writer's single ordinary request is excluded from the active-session count below.
    const activeCaptures = [...captures.slice(0, contenderStart), ...captures.slice(contenderEnd)];
    const inactiveEvidence: { flags: string[]; chatRequests: number; compactorRequests: number; storeCreated: boolean }[] = [];
    for (const flags of [["--no-optchat"], ["--optchat", "--no-optchat"], ["--no-optchat", "--optchat"]]) {
      currentPhase = `inactive ${flags.join(" ")}`;
      // Never pre-create the disabled store: absence is part of the proof.
      const inactiveMemory = join(temporary, `inactive-memory-${inactiveEvidence.length}`);
      const assertNoStore = async () => {
        await assert.rejects(lstat(inactiveMemory), { code: "ENOENT" }, "disabled plugin must not create its configured store");
        await assert.rejects(lstat(join(agentDirectory, "optchat")), { code: "ENOENT" }, "disabled plugin must not create a fallback store");
      };
      await assertNoStore();
      const before = captures.length;
      const inactive: Host = new Host(executable, [...baseArgs, "--optchat-dir", inactiveMemory, ...flags], workspace, env);
      await inactive.until("inactive RPC ready", () => inactive.events.some((event) => event.type === "ready"));
      await assertNoStore();
      // An oversized reply followed by another turn would trigger compaction if
      // activation slipped through; completion alone would not prove inactivity.
      await inactive.prompt(INACTIVE_USER);
      await assertNoStore();
      await inactive.prompt(INACTIVE_NEXT_USER);
      assert(JSON.stringify(inactive.events).includes(INACTIVE_FINISHED), "ordinary inactive response must reach the RPC client");
      await assertNoStore();
      await bounded("inactive host shutdown", inactive.stop());
      assert.equal((await inactive.exited).code, 0, "inactive host must shut down gracefully");
      await assertNoStore();
      const requests = captures.slice(before);
      const chatRequests = requests.filter((capture) => capture.body.model === "optchat-smoke-chat").length;
      const compactorRequests = requests.filter((capture) => capture.body.model === "optchat-smoke-compact").length;
      assert.equal(chatRequests, 2, "inactive process must complete both ordinary turns");
      assert.equal(compactorRequests, 0, "inactive process must never dispatch a compactor request");
      inactiveEvidence.push({ flags, chatRequests, compactorRequests, storeCreated: false });
    }
    const runtimeEvidence = await runtimeCases(executable, baseArgs, workspace, env, memory);
    assert(!serverFailure, serverFailure?.message ?? "smoke fixture server must not fail");
    for (const capture of captures.filter((entry) => entry.body.model === "optchat-smoke-compact")) {
      const request = JSON.stringify(capture.body);
      assert(!request.includes(FIRST_THINKING) && !request.includes(TOOL_THINKING), "reasoning must never reach the compressor");
    }
    const chatRequests = captures.filter((capture) => capture.body.model === "optchat-smoke-chat");
    const activeChatRequests = activeCaptures.filter((capture) => capture.body.model === "optchat-smoke-chat");
    // first turn + (pages + 1) retrieval-loop requests + restored turn.
    assert.equal(activeChatRequests.length, retrievedPages + 3, "expected first turn, pages+1 retrieval-loop requests, and restored turn");
    console.log(JSON.stringify({
      ok: true, evidence: "synthetic-model/real-installed-omp-host", executable, plugin: PLUGIN,
      discovery: "fresh isolated plugin link; automatic package discovery; explicit fixture provider only",
      defaultActivation: "full active lifecycle without --optchat",
      setupProcesses: 1, hostProcesses: hosts.length - 1, chatRequests: chatRequests.length,
      activeChatRequests: activeChatRequests.length, inactiveEvidence, runtimeEvidence,
      childRequests: captures.filter((entry) => entry.body.model === "optchat-smoke-child").length,
      compactorRequests: captures.filter((entry) => entry.body.model === "optchat-smoke-compact").length,
      durableMessages: restored.length, retrievedBytes: Buffer.byteLength(LONG_REPLY),
      checks: ["automatic installed package discovery", "default activation without enable flag", "explicit opt-out and both flag-order precedences", "inactive store absence through shutdown", "inactive ordinary history without memory system/view/tools", "zero inactive compactor requests", "same-process history replacement", "pre-user settled snapshot", "contextual past-record compaction", "shared main/compactor prompt and tools", "dash compression ruler", "active reasoning and tool-loop retention", "real zoom/date tools", "cursor-walked paged oversized retrieval", "durable history excludes reasoning", "second-writer inactive ordinary turn", "persisted view stability", "new-process restoration"],
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
