/**
 * Real-host integration suite for OptChat.
 *
 * Isolation. The bun:test parent imports only bun/node modules and types. Each
 * case re-runs this file as `bun test ./tests/integration.test.ts` in a fresh
 * Bun child. The child starts in the repository root so Bun can discover the
 * file. It gets an allowlisted environment and a private temp HOME, TMPDIR,
 * XDG dirs and PI_CODING_AGENT_DIR; profile and config-root variables are never
 * passed (pi-utils dirs.ts:342-348). Before its first OMP import, the child
 * chdirs into a temp workspace, because pi-utils caches the cwd and reads .env
 * files from HOME, the config root, the agent dir and the cwd at import time
 * (pi-utils dirs.ts:207-230, env.ts:287-314). Isolation is claimed only for the
 * child's OMP module graph; other test files may load OMP into the suite process.
 *
 * In real-host cases, a loopback Bun.serve Chat Completions SSE fixture runs
 * against the real installed SDK (pi-coding-agent 18.6.1):
 * - Settings.isolated (config/settings.ts:745)
 * - AuthStorage.create / close (pi-ai auth-storage.ts:254-262)
 * - new ModelRegistry(...) (config/model-registry.ts:425-455); registerProvider and find (3131, 2870)
 * - bindPreparedExtensions and loadExtensionFromFactory on one EventBus (extensions/loader.ts:464-519)
 * - shared runtime.flagValues, set after every factory has run (loader.ts:101, 259-293)
 * - createAgentSession with preloadedExtensions (sdk.ts:512-808, 1618, 2574-2667)
 * - initializeExtensions, which emits the real session_start (modes/runtime-init.ts:56-212)
 * - session.prompt / steer / subscribe / waitForIdle / abort / clearQueue / dispose
 *   (session/agent-session.ts:6888, 7829, 4838, 5805, 9109, 8584, 5201)
 * - session.prepareSimpleStreamOptions with pi-ai completeSimple: a side request
 *   through the session's real provider hooks (agent-session.ts:6291)
 * dispose emits the real session_shutdown; the test never emits it manually.
 * Real-host cases use no module stubs, streamFn overrides or patched internals.
 * Fake-host cases exercise captured extension handlers with plain objects and
 * the same durable store, in their own sanitized children (no SDK session).
 * Their prefix cases use the real pi-ai encoders; the compressor's request
 * reaches a loopback recorder that holds it open.
 */
import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, completeSimple, Model } from "@oh-my-pi/pi-ai";
import type { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog";
import type { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type * as OmpSdk from "@oh-my-pi/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  ExtensionAPI,
  ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import type { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type * as Zod from "zod";
import type { viewBlocks } from "../src/cache.ts";
import type * as OptChatModule from "../src/index.ts";
import type { Kind, Store } from "../src/store.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type WireObject = { [key: string]: Json };
type Evidence = { [key: string]: Json };

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..");
/** Child marker: a child never re-spawns; it runs exactly the named case. */
const CHILD_ENV = "OPTCHAT_IT_CHILD";
const ROOT_ENV = "OPTCHAT_IT_ROOT";
const RESULT_MARK = "OPTCHAT_IT_RESULT ";
const PARENT_TEST_MS = 240_000;
const SPAWN_TIMEOUT_MS = 210_000;
const CHILD_TEST_MS = 180_000;
/** Deadline for one awaited barrier: a hung barrier fails the case; it is never a synchronization sleep. */
const STEP_MS = 30_000;
const CLEANUP_STEP_MS = 15_000;
const POLL_MS = 20;

const PROVIDER = "optchat-smoke";
const CHAT_MODEL = "optchat-smoke-chat";
const COMPACT_MODEL = "optchat-smoke-compact";
const NO_TOOLS_COMPACT_MODEL = "optchat-smoke-compact-notools";
const TOOL_CAP = 128;
/** Generous for success cases; still below the host's 30 s context-handler limit. */
const POSITIVE_SETTLE_MS = 20_000;
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" };

const CASE_TITLES = {
  "fresh-turn-steering": "the installed default sends settled summaries; its tool loop and steering stay raw under one view",
  "thinking-exclusion": "provider thinking never reaches fresh turns, the compressor or the durable store",
  "compressor-tool-refusal": "compressor tool calls are neither executed nor accepted as summaries",
  "compressor-without-tools": "a compressor without tool support never receives captured main tools",
  "side-prefix-text-mismatch": "a same-model side request's reworded system prefix never replaces the compressor's guide or adds tools",
  "reasoning-tools-compressor": "with disableReasoningWithTools the tool-bearing main request reasons none; the compressor stays medium and tool-free",
  "reasoning-tools-compressor-when-thinking": "with base disableReasoningWithTools false and whenThinking true the tool-bearing main request reasons none; the compressor stays medium and tool-free",
  "tool-cap-zoom": "ordinary tool output is capped live but stored whole; zoom pages the original record",
  "lock-held": "a store held by another writer refuses prompts with zero chat requests",
  "missing-compressor": "an unresolvable compressor selector refuses prompts with zero chat requests",
  "settle-timeout": "the settle deadline refuses the request and keeps the prompt durable and unanswered",
  "abort-while-settling": "aborting during the settle wait sends nothing and keeps the prompt durable and unanswered",
  "legacy-flag": "the legacy positive CLI flag activates OptChat and boolean equals values are not false syntax",
  "disabled-flag": "SDK optchat false leaves no OptChat side effects",
  "cli-optout": "CLI optout leaves no OptChat side effects or model resolution",
  "cli-optout-first": "CLI optout wins before the positive flag without OptChat side effects",
  "cli-optout-last": "CLI optout wins after the positive flag without OptChat side effects",
  "optout-invalid-config": "optout skips invalid nonactivation configuration without installing behavioral hooks",
  "subagent-default": "a real subagent stays inactive under the installed default",
  "subagent-shared-store": "a real subagent never owns or mutates the main agent's shared store",
  "malformed-positive": "malformed positive activation fails closed within startup",
  "malformed-optout": "malformed optout activation fails closed within startup",
  "malformed-config": "nonactivation validation fails closed within startup",
  "background-report": "an idle background report starts a raw turn and enters the next turn's view",
  "background-report-cold": "a cold idle background report gets OptChat instructions before its view and runs",
  "aside": "an unflagged mid-run aside stays raw under the same view without new compression",
  "fake-steering-batch": "a steering-only context batch leaves the open turn alone",
  "fake-late-agent-end": "a late agent_end cannot close an unrelated open turn",
  "fake-child-view": "a child adopts the parent's frozen view, and a session switch revokes it",
  "fake-ephemeral-recap": "an idle side turn with agent-attributed messages passes through unlogged; the next prompt is answered",
  "fake-recap-spoof": "user text that mimics a recap is ordinary input and is logged as the user's turn",
  "fake-continuation": "willContinue retains the view and a terminal agent_end refreshes it",
  "fake-think-exclusion": "private think calls and results never enter durable memory while talk does",
  "fake-settle-bounds": "settleTimeoutMs rejects zero, NaN and the host deadline but accepts 29999",
  "prefix-chat-system": "Chat Completions system prefixes replay only across cache metadata differences",
  "prefix-chat-developer": "Chat Completions developer prefixes replay only across cache metadata differences",
  "prefix-responses-instructions": "Responses instructions replay only when identical and alone",
  "prefix-responses-input": "Responses developer input prefixes replay only across cache metadata differences",
  "prefix-anthropic-system": "Anthropic system blocks replay only across cache metadata differences",
  "cap-text": "capText keeps head and tail within the cap without splitting surrogate pairs",
  "view-blocks": "viewBlocks cuts only at stable line ends and joins back to the view",
  "fake-rejected-custom-image": "a custom message nothing admits stores no image; an admitted report stores exactly its own",
} as const;
type CaseName = keyof typeof CASE_TITLES;

// ---------------------------------------------------------------------------
// Parent: one isolated child process per case
// ---------------------------------------------------------------------------

interface ChildHandle {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: number | NodeJS.Signals): void;
}

/** The child's whole environment: Bun.spawn `env` replaces, never merges (bun-types bun.d.ts:7454-7461). */
function childEnvironment(root: string, name: CaseName): Record<string, string> {
  const home = join(root, "home");
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_TIME: process.env.LC_TIME,
    TZ: process.env.TZ,
    TERM: "dumb",
    NO_COLOR: "1",
    HOME: home,
    TMPDIR: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PI_NO_TITLE: "1",
    [CHILD_ENV]: name,
    [ROOT_ENV]: root,
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function runIsolated(name: CaseName): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "optchat-it-"));
  let child: ChildHandle | undefined;
  try {
    for (const directory of ["home/.config", "home/.cache", "home/.local/share", "agent", "workspace", "tmp"]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    // `bun test` only discovers files under its cwd, so the child starts in the
    // repository root and moves into its workspace before importing OMP.
    const spawned = Bun.spawn({
      cmd: [process.execPath, "test", `./${relative(REPO_ROOT, THIS_FILE)}`, "--timeout", String(CHILD_TEST_MS)],
      cwd: REPO_ROOT,
      env: childEnvironment(root, name),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    child = spawned;
    const [stdout, stderr] = await Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text()]);
    const exitCode = await spawned.exited;
    const report = `${name}: exit ${exitCode}, signal ${spawned.signalCode ?? "none"}\n--- child stdout ---\n${stdout}\n--- child stderr ---\n${stderr}`;
    assert.equal(spawned.signalCode, null, report);
    assert.equal(exitCode, 0, report);
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(RESULT_MARK));
    assert(line, `child printed no result line\n${report}`);
    const result = JSON.parse(line.slice(RESULT_MARK.length)) as { case?: unknown; ok?: unknown };
    assert.equal(result.case, name, report);
    assert.equal(result.ok, true, report);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Child: libraries, wire helpers, durable store readers
// ---------------------------------------------------------------------------

interface Libraries {
  sdk: typeof OmpSdk;
  ThinkingLevel: typeof ThinkingLevel;
  zod: typeof Zod;
  EventBus: typeof EventBus;
  initializeExtensions: typeof initializeExtensions;
  parseArgs: typeof parseArgs;
  optchat: typeof OptChatModule;
  viewBlocks: typeof viewBlocks;
  getBundledModels: typeof getBundledModels;
  Store: typeof Store;
  completeSimple: typeof completeSimple;
  clampThinkingLevelForModel: typeof clampThinkingLevelForModel;
}

/**
 * Static imports would not work here. The parent process must never load OMP,
 * and the child must chdir into its workspace before OMP's import-time .env
 * and cwd setup runs. Imports run one after another so that setup happens in a
 * fixed order.
 */
async function loadLibraries(): Promise<Libraries> {
  const sdk = await import("@oh-my-pi/pi-coding-agent");
  const { ThinkingLevel } = await import("@oh-my-pi/pi-agent-core");
  const { EventBus } = await import("@oh-my-pi/pi-coding-agent/utils/event-bus");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { parseArgs } = await import("@oh-my-pi/pi-coding-agent/cli/args");
  const optchat = await import("../src/index.ts");
  const { viewBlocks } = await import("../src/cache.ts");
  const { getBundledModels } = await import("@oh-my-pi/pi-catalog/models");
  const { Store } = await import("../src/store.ts");
  const { completeSimple } = await import("@oh-my-pi/pi-ai");
  const { clampThinkingLevelForModel } = await import("@oh-my-pi/pi-catalog");
  // Keep the fake-host schema dependency behind the same child-only loading boundary.
  const zod = await import("zod");
  return {
    sdk, ThinkingLevel, zod, EventBus, initializeExtensions, parseArgs, optchat, viewBlocks, getBundledModels, Store,
    completeSimple, clampThinkingLevelForModel,
  };
}

interface CaseContext {
  lib: Libraries;
  fixture: Fixture;
  cwd: string;
  agentDir: string;
  memory: string;
}

function object(value: Json | undefined, label: string): WireObject {
  assert(value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function wireMessages(body: WireObject): WireObject[] {
  assert(Array.isArray(body.messages), "provider request must carry messages");
  return body.messages.map((value, index) => object(value, `messages[${index}]`));
}

/** Message text; parts join with nothing, so split view blocks rejoin byte-identically. */
function wireText(message: WireObject): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((value) => {
    const part = object(value, "content part");
    return typeof part.text === "string" ? part.text : "";
  }).join("");
}

function userTexts(body: WireObject): string[] {
  return wireMessages(body).filter((message) => message.role === "user").map(wireText);
}

/**
 * A rendered view inside user content. Only user roles are searched: the
 * SYSTEM_BLOCK documentation itself mentions <chat>.
 */
const VIEW_IN_TEXT = /<chat>\n(?:[^\n]*\n)*?<\/chat>/g;
const VIEW_SHAPE = /^<chat>\n(?:\d+\+[1-9]\d*\|[^\n]*\n)*<\/chat>$/;

function views(body: WireObject): string[] {
  const found = userTexts(body).flatMap((text) => text.match(VIEW_IN_TEXT) ?? []);
  for (const view of found) assert.match(view, VIEW_SHAPE, "a view is `<chat>`, one `id+n|text` line per part, `</chat>`");
  return found;
}

function soleView(body: WireObject, label: string): string {
  const found = views(body);
  assert.equal(found.length, 1, `${label}: exactly one view in user content`);
  return found[0]!;
}

/** User texts with any view removed: the raw messages the request carries besides the view. */
function outsideTexts(body: WireObject): string[] {
  return userTexts(body).map((text) => text.replace(VIEW_IN_TEXT, ""));
}

function occurrences(texts: readonly string[], needle: string): number {
  return texts.reduce((count, text) => count + text.split(needle).length - 1, 0);
}

function systemMessages(body: WireObject): WireObject[] {
  return wireMessages(body).filter((message) => message.role === "system" || message.role === "developer");
}

function systemText(body: WireObject): string {
  return systemMessages(body).map(wireText).join("\n");
}

function toolNames(body: WireObject): string[] {
  if (body.tools === undefined) return [];
  assert(Array.isArray(body.tools), "tools must be an array");
  return body.tools.map((value) => {
    const name = object(object(value, "tool").function, "tool function").name;
    assert(typeof name === "string", "tool name must be a string");
    return name;
  });
}

function toolResultIndex(body: WireObject, callId: string): number {
  const messages = wireMessages(body);
  const indexes = messages.flatMap((message, index) => (message.role === "tool" && message.tool_call_id === callId ? [index] : []));
  assert.equal(indexes.length, 1, `exactly one tool result for ${callId}`);
  return indexes[0]!;
}

function toolResultText(body: WireObject, callId: string): string {
  return wireText(wireMessages(body)[toolResultIndex(body, callId)]!);
}

/** The replayed assistant tool call: id, name and parsed arguments. */
function replayedCall(body: WireObject, callId: string): { message: WireObject; name: Json; args: unknown } {
  for (const message of wireMessages(body)) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const value of message.tool_calls) {
      const call = object(value, "tool call");
      if (call.id !== callId) continue;
      const fn = object(call.function, "tool call function");
      assert(typeof fn.arguments === "string", "tool call arguments must be a JSON string");
      return { message, name: fn.name ?? null, args: JSON.parse(fn.arguments) };
    }
  }
  assert.fail(`assistant tool call ${callId} is missing from the request`);
}

interface Row {
  i: number;
  kind: string;
  text: string;
  size: number;
  date: string;
}

/** Complete JSONL records of one store stream; a line still being appended (no newline yet) is skipped. */
function jsonlRecords(directory: string): WireObject[] {
  if (!existsSync(directory)) return [];
  const records: WireObject[] = [];
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".jsonl")).sort()) {
    const content = readFileSync(join(directory, name), "utf8");
    for (const line of content.slice(0, content.lastIndexOf("\n") + 1).split("\n")) {
      if (line.length > 0) records.push(object(JSON.parse(line) as Json, `${name} record`));
    }
  }
  return records;
}

/**
 * Main rows straight from disk, sorted by permanent id (file names are the
 * local day of writing). The SDK owns the Store meanwhile; opening a second
 * Store to inspect it would itself contend for the writer lock.
 */
function mainRows(memory: string): Row[] {
  const rows = jsonlRecords(join(memory, "main")).map((record): Row => {
    const keys = Object.keys(record).filter((key) => key !== "metadata").sort();
    assert.deepEqual(keys, ["date", "i", "kind", "size", "text"], "main rows are {i,kind,text,size,date} plus optional metadata");
    const { i, kind, text, size, date } = record;
    assert(typeof i === "number" && typeof kind === "string" && typeof text === "string", "main row id, kind and text types");
    assert(typeof size === "number" && typeof date === "string", "main row size and date types");
    return { i, kind, text, size, date };
  }).sort((a, b) => a.i - b.i);
  rows.forEach((row, index) => assert.equal(row.i, index, "main ids are contiguous from 0"));
  return rows;
}

function pairs(rows: readonly Row[]): Array<[string, string]> {
  return rows.map((row) => [row.kind, row.text]);
}

function rowsWith(memory: string, kind: string, text: string): Row[] {
  return mainRows(memory).filter((row) => row.kind === kind && row.text === text);
}

async function durableRows(ctx: CaseContext, count: number, label: string): Promise<Row[]> {
  return ctx.fixture.until(label, () => {
    const rows = mainRows(ctx.memory);
    return rows.length >= count ? rows : undefined;
  });
}

/** Seed the store through its real API, then release the writer before the SDK starts. */
async function seedStore(ctx: CaseContext, records: ReadonlyArray<readonly [Kind, string]>): Promise<void> {
  const store = await ctx.lib.Store.open(ctx.memory);
  try {
    for (const [kind, text] of records) store.append(kind, text);
  } finally {
    await store.close();
  }
}

/**
 * A hard deadline on a real-process step (SDK, provider stream, store fsync).
 * Fake timers cannot drive those, so a real timer is used, only to fail a hung step.
 */
function bounded<T>(label: string, operation: Promise<T>, ms = STEP_MS, fatal?: Promise<never>): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(`${label}: exceeded ${ms}ms`)), ms);
  return Promise.race(fatal ? [operation, expired.promise, fatal] : [operation, expired.promise]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Child: loopback Chat Completions SSE fixture
// ---------------------------------------------------------------------------

interface ToolCallReply {
  id: string;
  name: string;
  args: Json;
}

interface Reply {
  thinking?: string;
  text?: string;
  calls?: ToolCallReply[];
  /** Streaming-completion gate: the head streams at once; finish, usage and [DONE] wait for it. */
  hold?: Promise<void>;
}

interface CompactInput {
  leaf: boolean;
  /** Source kind of a leaf: the text before the first colon of `kind: text`. */
  kind: string | undefined;
  input: string;
  target: number;
}

interface Capture {
  seq: number;
  model: string;
  body: WireObject;
  at: number;
  compact: CompactInput | undefined;
}

/** The instruction after the view; the fixed dash ruler never contributes content to a summary. */
const INSTRUCTION = /Compaction: (compress message \d+|merge lines [^\n]+) into one line of at most (\d+) bytes\n[^\n]+\n-{512}\n(?:<chat> may hold their messages, \d+ to \d+, in more detail: take details\nof them from there too\.\n)?<input>\n([\s\S]*)\n<\/input>$/;
/** Plain nonblank compressor replies, each under the 64-byte summary target. */
const LEAF_SUMMARY: Record<string, string> = {
  user: "user: prior turn summary",
  talk: "talk: prior reply summary",
  tool: "tool: prior call summary",
  echo: "echo: prior output summary",
  note: "note: prior note summary",
  work: "work: prior report summary",
};
const MERGE_SUMMARY = "prior lines merged summary";

function compactInput(body: WireObject): CompactInput {
  const user = wireMessages(body).find((message) => message.role === "user");
  assert(user, "a compressor request carries one user message");
  const match = INSTRUCTION.exec(wireText(user));
  assert(match, "a compressor request ends with the OptChat compaction instruction");
  const input = match[3]!;
  const leaf = match[1]!.startsWith("compress message ");
  return { leaf, kind: leaf ? input.slice(0, input.indexOf(":")) : undefined, input, target: Number(match[2]) };
}

/** OpenAI Chat Completions SSE: reasoning_content, content, tool_call argument deltas, finish, usage, [DONE]. */
function sse(model: string, seq: number, reply: Reply): Response {
  const id = `chatcmpl-optchat-it-${seq}`;
  const chunk = (delta: WireObject, finish: string | null = null): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const head = [chunk({ role: "assistant" })];
  if (reply.thinking) head.push(chunk({ reasoning_content: reply.thinking }));
  if (reply.text) head.push(chunk({ content: reply.text }));
  for (const [index, call] of (reply.calls ?? []).entries()) {
    const args = JSON.stringify(call.args);
    const split = Math.ceil(args.length / 2);
    head.push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: args.slice(0, split) } }] }));
    head.push(chunk({ tool_calls: [{ index, function: { arguments: args.slice(split) } }] }));
  }
  const usage = { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80, completion_tokens_details: { reasoning_tokens: reply.thinking ? 8 : 0 } };
  const tail = [
    chunk({}, reply.calls && reply.calls.length > 0 ? "tool_calls" : "stop"),
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [], usage })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const hold = reply.hold;
  if (!hold) return new Response([...head, ...tail].join(""), { headers: SSE_HEADERS });
  const encoder = new TextEncoder();
  let sentHead = false;
  let cancelled = false;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        controller.enqueue(encoder.encode(head.join("")));
        return;
      }
      await hold;
      if (cancelled) return;
      controller.enqueue(encoder.encode(tail.join("")));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: SSE_HEADERS });
}

/**
 * Captures every parsed request. Chat requests consume a strict queue of
 * scripted replies; an unplanned request, endpoint, model or body is recorded
 * as a failure and answered with an error, never with a made-up success.
 * Compressor requests get short deterministic summaries, or a hang that ends
 * only at cleanup.
 */
class Fixture {
  readonly captures: Capture[] = [];
  readonly failures: Error[] = [];
  /** Rejects on the first failure, so awaited barriers stop at once. */
  readonly fatal: Promise<never>;
  compactPolicy: ((input: CompactInput) => "hang" | "tool" | undefined) | undefined;
  readonly baseUrl: string;
  private readonly rejectFatal: (error: Error) => void;
  private readonly scripts: Array<{ label: string; reply: Reply }> = [];
  private readonly releases = new Set<() => void>();
  private readonly listeners = new Set<() => void>();
  private readonly server: Bun.Server<undefined>;

  constructor() {
    const fatal = Promise.withResolvers<never>();
    this.fatal = fatal.promise;
    this.rejectFatal = fatal.reject;
    // Observed here; every barrier races it.
    this.fatal.catch(() => {});
    // idleTimeout 0: a held or hanging stream must not be cut by Bun's 10 s default.
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (request) => this.handle(request) });
    this.baseUrl = `http://127.0.0.1:${this.server.port}/v1`;
  }

  chat(): Capture[] {
    return this.captures.filter((capture) => capture.model === CHAT_MODEL);
  }

  compact(): Capture[] {
    return this.captures.filter((capture) => capture.model === COMPACT_MODEL || capture.model === NO_TOOLS_COMPACT_MODEL);
  }

  queueChat(label: string, reply: Reply): void {
    this.scripts.push({ label, reply });
  }

  assertScriptsConsumed(): void {
    assert.deepEqual(this.scripts.map((script) => script.label), [], "every scripted chat reply must be requested");
  }

  /** A gate released by the test, or at the latest by cleanup. */
  gate(): { promise: Promise<void>; release: () => void } {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.releases.add(resolve);
    return { promise, release: resolve };
  }

  releaseAll(): void {
    for (const release of this.releases) release();
    this.releases.clear();
  }

  changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Event-driven barrier: captures, host events and notices call `changed()`.
   * Durable store rows have no event of their own, so the probe also re-runs on
   * a short real interval. A hard deadline fails a step that hangs. These are
   * real-process conditions, so fake timers cannot drive them.
   */
  until<T>(label: string, probe: () => T | undefined | null | false, ms = STEP_MS): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let finished = false;
      const finish = (): void => {
        finished = true;
        clearTimeout(timer);
        clearInterval(tick);
        this.listeners.delete(check);
      };
      const check = (): void => {
        if (finished) return;
        if (this.failures.length > 0) {
          finish();
          rejectPromise(new Error(`${label}: fixture failed: ${this.failures[0]!.message}`));
          return;
        }
        let value: T | undefined | null | false;
        try {
          value = probe();
        } catch (error) {
          finish();
          rejectPromise(error);
          return;
        }
        if (value !== undefined && value !== null && value !== false) {
          finish();
          resolvePromise(value);
        }
      };
      const timer = setTimeout(() => {
        if (finished) return;
        finish();
        rejectPromise(new Error(`${label}: not observed within ${ms}ms`));
      }, ms);
      const tick = setInterval(check, POLL_MS);
      this.listeners.add(check);
      check();
    });
  }

  async stop(): Promise<void> {
    this.releaseAll();
    await this.server.stop(true);
  }

  private fail(error: unknown): Response {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.failures.push(failure);
    this.rejectFatal(failure);
    this.changed();
    return Response.json({ error: { message: failure.message, type: "optchat_fixture_assertion" } }, { status: 400 });
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        throw new Error(`unexpected fixture request ${request.method} ${url.pathname}`);
      }
      const body = object((await request.json()) as Json, "request body");
      assert.equal(body.stream, true, "the fixture serves streaming adapter requests only");
      const model = typeof body.model === "string" ? body.model : "";
      if (model !== CHAT_MODEL && model !== COMPACT_MODEL && model !== NO_TOOLS_COMPACT_MODEL) {
        throw new Error(`unexpected model ${JSON.stringify(body.model)}`);
      }
      wireMessages(body);
      const compact = model === COMPACT_MODEL || model === NO_TOOLS_COMPACT_MODEL ? compactInput(body) : undefined;
      const capture: Capture = { seq: this.captures.length + 1, model, body, at: performance.now(), compact };
      this.captures.push(capture);
      let response: Response;
      if (compact) {
        const policy = this.compactPolicy?.(compact);
        if (policy === "hang") {
          response = this.hang();
        } else if (policy === "tool") {
          response = sse(model, capture.seq, {
            text: "COMPRESSOR_TOOL_OUTPUT_MUST_NOT_BE_SAVED",
            calls: [{ id: `compact-call-${capture.seq}`, name: "probe", args: { label: "must-not-execute" } }],
          });
        } else {
          const summary = compact.leaf ? LEAF_SUMMARY[compact.kind ?? ""] : MERGE_SUMMARY;
          if (summary === undefined) throw new Error(`no fixture summary for source kind ${JSON.stringify(compact.kind)}`);
          response = sse(model, capture.seq, { text: summary });
        }
      } else {
        const script = this.scripts.shift();
        if (!script) throw new Error(`unplanned chat request #${this.chat().length}`);
        response = sse(model, capture.seq, script.reply);
      }
      this.changed();
      return response;
    } catch (error) {
      return this.fail(error);
    }
  }

  /** A stream that sends nothing until cleanup closes it, or the client cancels. */
  private hang(): Response {
    let open = true;
    return new Response(new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.releases.add(() => {
          if (!open) return;
          open = false;
          controller.close();
        });
      },
      cancel: () => {
        open = false;
      },
    }), { headers: SSE_HEADERS });
  }
}

// ---------------------------------------------------------------------------
// Child: real SDK host
// ---------------------------------------------------------------------------

/** Settings overrides: no compaction, retry, advisor, autolearn, memory backend, goal, TTSR, titles or image side calls. */
const HOST_SETTINGS = {
  enabledModels: [`${PROVIDER}/*`],
  "compaction.enabled": false,
  "compaction.midTurnEnabled": false,
  "compaction.asyncEnabled": false,
  "compaction.idleEnabled": false,
  "retry.enabled": false,
  "retry.modelFallback": false,
  "advisor.enabled": false,
  "autolearn.enabled": false,
  "memory.backend": "off",
  "goal.enabled": false,
  "ttsr.enabled": false,
  "ttsr.builtinRules": false,
  "ttsr.judge": "off",
  "title.refreshOnReplan": false,
  "images.describeForTextModels": false,
  "tools.xdev": false,
  includeWorkspaceTree: false,
};

const PROBE_RESULT = "OPTCHAT_IT_PROBE_RESULT: probe finished.";
const LONG_TOOL_TEXT =
  `OPTCHAT_IT_TOOL_HEAD ${"long tool output filler; ".repeat(40)}OPTCHAT_IT_TOOL_INTERIOR ${"long tool output filler; ".repeat(40)}OPTCHAT_IT_TOOL_TAIL`;

const FIXTURE_API_KEY = "optchat-smoke-fixture-key";

/** Merged over every fixture model's compat: the SDK's reasoning-with-tools policy. */
interface FixtureCompat {
  disableReasoningWithTools: boolean;
  reasoningDisableMode: "none-effort";
  whenThinking?: { disableReasoningWithTools: boolean; reasoningDisableMode: "none-effort" };
}

/** Same provider as scripts/fixture-provider.ts, bound to this child's own server port. */
function fixtureProvider(baseUrl: string, compat?: FixtureCompat): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerProvider(PROVIDER, {
      baseUrl,
      apiKey: FIXTURE_API_KEY,
      api: "openai-completions",
      models: [CHAT_MODEL, COMPACT_MODEL, NO_TOOLS_COMPACT_MODEL].map((id) => ({
        id,
        name: id,
        reasoning: true,
        ...(id === NO_TOOLS_COMPACT_MODEL ? { supportsTools: false } : {}),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsMultipleSystemMessages: true,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
          thinkingFormat: "openai",
          reasoningContentField: "reasoning_content",
          replayReasoningContent: true,
          ...compat,
        },
      })),
    });
  };
}

interface HostOptions {
  /** Injected through createOptChat; omitted means the module default. */
  settleTimeoutMs?: number;
  /** Merged over the defaults; numeric flags stay decimal strings. */
  flags?: Record<string, string | boolean>;
  /** Parsed after factory registration, using the actual registered extension flag definitions. */
  argv?: string[];
  /** The SDK derives ctx.agent.kind from its actual task nesting depth. */
  taskDepth?: number;
  /**
   * Capture ctx.ui.notify through a UI context built on the runner's own no-op
   * one. This makes hasUI true, so it is used only in cases where no tool runs.
   */
  notices?: boolean;
  /** Gate the probe tool: `started` fires inside execute, which then waits for `release`. */
  probe?: { started: () => void; release: Promise<void> };
  /** Capture this real extension's API for message delivery and event barriers. */
  capturePi?: (pi: ExtensionAPI) => void;
  /** A real `context` hook in an extension loaded before OptChat. */
  beforeContext?: (messages: unknown[]) => void;
  /** A real `context` hook in an extension loaded after OptChat. */
  afterContext?: (messages: unknown[]) => void;
  /** Compat for every fixture model; omitted means the plain fixture provider. */
  compat?: FixtureCompat;
}

function defaultFlags(memory: string): Record<string, string | boolean> {
  return {
    "optchat-dir": memory,
    "optchat-model": `${PROVIDER}/${COMPACT_MODEL}`,
    "optchat-node-bytes": "64",
    "optchat-view-bytes": "128000",
    "optchat-jobs": "1",
    "optchat-tries": "1",
    "optchat-tool-cap": String(TOOL_CAP),
  };
}

/** Real registered tools (loaded before OptChat), plus an optional before-OptChat context observer. */
function testExtension(options: HostOptions): (pi: ExtensionAPI) => void {
  return (pi) => {
    options.capturePi?.(pi);
    const z = pi.zod;
    pi.registerTool({
      name: "probe",
      label: "OptChat integration probe",
      description: "Return the fixed integration probe result.",
      parameters: z.object({ label: z.string().describe("Probe label") }),
      approval: "read",
      loadMode: "essential",
      execute: async () => {
        if (options.probe) {
          options.probe.started();
          await options.probe.release;
        }
        return { content: [{ type: "text", text: PROBE_RESULT }] };
      },
    });
    pi.registerTool({
      name: "long_output",
      label: "OptChat integration long output",
      description: "Return a long fixed text.",
      parameters: z.object({}),
      approval: "read",
      loadMode: "essential",
      execute: async () => ({ content: [{ type: "text", text: LONG_TOOL_TEXT }] }),
    });
    const observe = options.beforeContext;
    if (observe) {
      pi.on("context", (event) => {
        observe(event.messages);
        return undefined;
      });
    }
  };
}

interface Notice {
  message: string;
  type: string | undefined;
  at: number;
}

type PromptOutcome = { ok: true; accepted: boolean; ms: number } | { ok: false; error: string; ms: number };

function expectCompleted(outcome: PromptOutcome, label: string): void {
  assert(outcome.ok, `${label}: prompt rejected: ${outcome.ok ? "" : outcome.error}`);
  assert.equal(outcome.accepted, true, `${label}: prompt was not accepted`);
}

class Host {
  readonly events: AgentSessionEvent[] = [];
  private readonly prompts: Array<Promise<PromptOutcome>> = [];
  private closed = false;

  private constructor(
    readonly session: AgentSession,
    private readonly auth: AuthStorage,
    private readonly fixture: Fixture,
    readonly notices: Notice[],
    readonly runtimeErrors: string[],
    readonly optchatExtension: OmpSdk.Extension,
  ) {}

  static async start(ctx: CaseContext, options: HostOptions): Promise<Host> {
    const { sdk, ThinkingLevel, EventBus, initializeExtensions, optchat } = ctx.lib;
    const settings = sdk.Settings.isolated(HOST_SETTINGS);
    const auth = await sdk.AuthStorage.create(join(ctx.agentDir, "auth.db"));
    let host: Host | undefined;
    try {
      const registry = new sdk.ModelRegistry(auth, join(ctx.agentDir, "models.yml"), {
        settings,
        cacheDbPath: join(ctx.agentDir, "models.db"),
        ignoreLocalModelConfig: true,
      });
      const eventBus = new EventBus();
      const loaded = await sdk.bindPreparedExtensions([], ctx.cwd, eventBus);
      // Load order is context-hook order (runner.ts:1995-2009).
      const factories: Array<(pi: ExtensionAPI) => void> = [
        fixtureProvider(ctx.fixture.baseUrl, options.compat),
        testExtension(options),
        optchat.createOptChat(options.settleTimeoutMs === undefined ? {} : { settleTimeoutMs: options.settleTimeoutMs }),
      ];
      const afterContext = options.afterContext;
      if (afterContext) {
        factories.push((pi) => {
          pi.on("context", (event) => {
            afterContext(event.messages);
            return undefined;
          });
        });
      }
      for (const [index, factory] of factories.entries()) {
        loaded.extensions.push(await sdk.loadExtensionFromFactory(factory, ctx.cwd, eventBus, loaded.runtime, `<inline-${index}>`));
      }
      assert.deepEqual(loaded.errors, [], "inline extensions must bind");
      const optchatExtension = loaded.extensions[2];
      assert(optchatExtension, "the actual OptChat factory must be loaded");
      // Flag defaults are written while factories run; real values go in afterwards, before session_start.
      for (const [name, value] of Object.entries({ ...defaultFlags(ctx.memory), ...options.flags })) {
        loaded.runtime.flagValues.set(name, value);
      }
      if (options.argv) {
        const parsed = ctx.lib.parseArgs(options.argv, optchatExtension.flags);
        assert.deepEqual(parsed.unrecognizedFlags, [], "the actual extension registrations recognize every CLI flag");
        assert.deepEqual(parsed.invalidFlagValues, [], "CLI flags have valid host syntax");
        assert.deepEqual(parsed.messages, [], "activation flags do not become positional messages");
        for (const [name, value] of parsed.unknownFlags) loaded.runtime.flagValues.set(name, value);
      }
      // Build the explicit chat model now. The queue stays intact: the SDK clears
      // the source and replays it itself (sdk.ts:2657-2667).
      for (const { name, config, sourceId } of loaded.runtime.pendingProviderRegistrations) {
        registry.registerProvider(name, config, sourceId);
      }
      const model = registry.find(PROVIDER, CHAT_MODEL);
      assert(model, "the fixture chat model must be registered");
      const { session } = await sdk.createAgentSession({
        cwd: ctx.cwd,
        agentDir: ctx.agentDir,
        settings,
        authStorage: auth,
        modelRegistry: registry,
        model,
        sessionManager: sdk.SessionManager.inMemory(ctx.cwd),
        agentRegistry: new sdk.AgentRegistry(),
        taskDepth: options.taskDepth,
        eventBus,
        preloadedExtensions: loaded,
        disableExtensionDiscovery: true,
        preloadedCustomToolPaths: [],
        skills: [],
        rules: [],
        contextFiles: [],
        promptTemplates: [],
        slashCommands: [],
        toolNames: [],
        enableMCP: false,
        enableLsp: false,
        enableIrc: false,
        hasUI: false,
        interactivePrompts: false,
        skipPythonPreflight: true,
        bindProcessState: false,
        cacheWarming: false,
        thinkingLevel: ThinkingLevel.Low,
      });
      const notices: Notice[] = [];
      const runtimeErrors: string[] = [];
      host = new Host(session, auth, ctx.fixture, notices, runtimeErrors, optchatExtension);
      session.subscribe((event) => {
        host?.events.push(event);
        ctx.fixture.changed();
      });
      const runner = session.extensionRunner;
      assert(runner, "the session must own an extension runner");
      const uiContext: ExtensionUIContext | undefined = options.notices
        ? {
          ...runner.getUIContext(),
          notify: (message, type) => {
            notices.push({ message, type, at: performance.now() });
            ctx.fixture.changed();
          },
        }
        : undefined;
      await initializeExtensions(session, {
        reportSendError: (action, error) => {
          runtimeErrors.push(`${action}: ${error.message}`);
        },
        reportRuntimeError: (error) => {
          runtimeErrors.push(JSON.stringify(error));
        },
        uiContext,
      });
      return host;
    } catch (error) {
      try {
        if (host) await host.close();
        else auth.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "host startup failed and its cleanup failed");
      }
      throw error;
    }
  }

  /** Starts a prompt whose outcome is observed at once; a refused prompt may resolve aborted or reject. */
  prompt(text: string): Promise<PromptOutcome> {
    const started = performance.now();
    const outcome = this.session.prompt(text, { runCommands: false, expandPromptTemplates: false }).then(
      (accepted): PromptOutcome => ({ ok: true, accepted, ms: performance.now() - started }),
      (error: unknown): PromptOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error), ms: performance.now() - started }),
    );
    this.prompts.push(outcome);
    return outcome;
  }

  idle(): Promise<void> {
    return bounded("session.waitForIdle", this.session.waitForIdle(), STEP_MS, this.fixture.fatal);
  }

  /**
   * Teardown order: drop queued steering and follow-ups, abort, release fixture
   * gates and hangs, observe every prompt, drain, then dispose (which emits
   * session_shutdown: OptChat closes Memory, then Store). AuthStorage is ours to close.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    const step = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
      try {
        await bounded(label, operation(), CLEANUP_STEP_MS);
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      try {
        this.session.clearQueue({ forInterrupt: true });
      } catch (error) {
        errors.push(error);
      }
      await step("session.abort", () => this.session.abort());
      this.fixture.releaseAll();
      await step("prompt settlement", () => Promise.all(this.prompts));
      await step("session.waitForIdle", () => this.session.waitForIdle());
      await step("session.dispose", () => this.session.dispose());
    } finally {
      this.auth.close();
    }
    if (errors.length > 0) throw new AggregateError(errors, "host cleanup failed");
  }
}

async function withHost<T>(ctx: CaseContext, options: HostOptions, body: (host: Host) => Promise<T>): Promise<T> {
  const host = await Host.start(ctx, options);
  let result: T;
  try {
    result = await body(host);
  } catch (error) {
    try {
      await host.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "case failed and host cleanup failed");
    }
    throw error;
  }
  await host.close();
  return result;
}

// ---------------------------------------------------------------------------
// Case 1: fresh turn vs current tool loop + steering
// ---------------------------------------------------------------------------

const T1_USER = `OPTCHAT_IT_T1_USER ${"first turn user words that need a summary; ".repeat(3)}`.trim();
const T1_TALK = `OPTCHAT_IT_T1_TALK ${"first turn public reply that needs a summary; ".repeat(3)}`.trim();
const T1_THINK = "OPTCHAT_IT_T1_PRIVATE_THINKING";
const T2_USER = "OPTCHAT_IT_T2_USER: call the probe tool, then answer.";
const T2_THINK = "OPTCHAT_IT_T2_PRIVATE_THINKING";
const T2_TALK = "OPTCHAT_IT_T2_TALK: calling the probe now.";
const T2_FINAL = "OPTCHAT_IT_T2_FINAL: probe done, steering noted.";
const STEER = "OPTCHAT_IT_STEER: also mention the steering note.";
const PROBE_CALL_ID = "optchat-it-probe-call";
const PROBE_ARGS = { label: "OPTCHAT_IT_PROBE_LABEL" };

async function compressorWithoutTools(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const { SYSTEM_BLOCK } = ctx.lib.optchat;
  const secondPrompt = "OPTCHAT_IT_NO_TOOLS_SECOND_USER: say hello again.";
  const secondReply = "OPTCHAT_IT_NO_TOOLS_SECOND_TALK: hello again.";
  const expectedPairs: Array<[string, string]> = [
    ["user", T1_USER],
    ["talk", T1_TALK],
    ["user", secondPrompt],
    ["talk", secondReply],
  ];
  const { firstRows, runtimeErrors } = await withHost(ctx, {
    settleTimeoutMs: POSITIVE_SETTLE_MS,
    flags: { "optchat-model": `${PROVIDER}/${NO_TOOLS_COMPACT_MODEL}` },
  }, async (host) => {
    fixture.queueChat("no-tools turn 1 reply", { text: T1_TALK });
    expectCompleted(await bounded("no-tools turn 1", host.prompt(T1_USER), STEP_MS, fixture.fatal), "no-tools turn 1");
    await host.idle();
    const firstRows = await durableRows(ctx, 2, "no-tools turn 1 durable rows");
    assert.deepEqual(pairs(firstRows), expectedPairs.slice(0, 2), "the first ordinary turn is logged exactly once");

    fixture.queueChat("no-tools turn 2 reply", { text: secondReply });
    expectCompleted(await bounded("no-tools turn 2", host.prompt(secondPrompt), STEP_MS, fixture.fatal), "no-tools turn 2");
    await host.idle();
    const rows = await durableRows(ctx, 4, "no-tools turn 2 durable rows");
    assert.deepEqual(pairs(rows), expectedPairs, "both ordinary turns are logged exactly once");
    return { firstRows, runtimeErrors: host.runtimeErrors };
  });

  assert.deepEqual(runtimeErrors, [], "no extension runtime errors, including during close");
  assert.deepEqual(fixture.failures, [], "the fixture recorded no failures");
  fixture.assertScriptsConsumed();
  const mainCaptures = fixture.chat();
  assert.equal(mainCaptures.length, 2, "exactly two ordinary main requests");
  const first = mainCaptures[0]!;
  const second = mainCaptures[1]!;
  for (const capture of mainCaptures) {
    const names = toolNames(capture.body);
    for (const name of ["zoom", "date", "probe"]) {
      assert(names.includes(name), `${name} remains active on every main request`);
    }
  }

  const compactCaptures = fixture.compact();
  assert(compactCaptures.length > 0, "the no-tools compressor receives requests");
  for (const capture of compactCaptures) {
    assert.equal(capture.model, NO_TOOLS_COMPACT_MODEL, "every compressor request uses the no-tools model");
    if (capture.body.tools !== undefined) {
      assert.deepEqual(capture.body.tools, [], "a no-tools compressor never receives captured main tools");
    }
  }
  const postMainCaptures = compactCaptures.filter((capture) => capture.seq > first.seq);
  assert(postMainCaptures.length > 0, "compression after main tool capture exercises the no-tools boundary");
  const firstSystem = wireMessages(first.body).filter((message) => message.role === "system" || message.role === "developer");
  assert(firstSystem.length > 0, "the first main request has a system/developer prefix");
  assert(systemText(first.body).includes(SYSTEM_BLOCK), "the prefix includes OptChat instructions");
  for (const capture of [...mainCaptures, ...compactCaptures]) {
    assert.deepEqual(
      wireMessages(capture.body).filter((message) => message.role === "system" || message.role === "developer"),
      firstSystem,
      "every main and compressor request retains the exact host system prefix",
    );
  }
  const leafInputs = compactCaptures.flatMap((capture) => (capture.compact?.leaf ? [capture.compact.input] : []));
  assert(leafInputs.includes(`user: ${T1_USER}`), "the compressor summarized the whole first user message");
  assert(leafInputs.includes(`talk: ${T1_TALK}`), "the compressor summarized the whole first reply");
  const expectedView = "<chat>\n0+1|user: prior turn summary\n1+1|talk: prior reply summary\n</chat>";
  assert.equal(soleView(second.body, "no-tools turn 2"), expectedView);
  assert.equal(occurrences(outsideTexts(second.body), secondPrompt), 1, "the second prompt occurs once outside the view");
  const secondRaw = JSON.stringify(second.body);
  for (const raw of ["OPTCHAT_IT_T1_USER", "OPTCHAT_IT_T1_TALK", T1_USER, T1_TALK]) {
    assert(!secondRaw.includes(raw), "the second request excludes first-turn raw text");
  }

  const tree = jsonlRecords(join(memory, "tree"));
  let persistedSummaries = 0;
  for (const row of firstRows) {
    const expected = LEAF_SUMMARY[row.kind];
    assert(expected !== undefined, `a deterministic summary exists for ${row.kind}`);
    const leaves = tree.filter((record) => record.l === 0 && record.i === row.i);
    assert.equal(leaves.length, 1, `exactly one persisted leaf for first-turn row ${row.i}`);
    assert.equal(leaves[0]!.text, expected, `the persisted leaf for row ${row.i} is the exact summary`);
    persistedSummaries++;
  }
  assert.deepEqual(pairs(mainRows(memory)), expectedPairs, "closing the host preserves exactly the four raw rows");
  return {
    mainRequests: mainCaptures.length,
    noToolsCompactRequests: compactCaptures.length,
    postMainCompactRequests: postMainCaptures.length,
    persistedSummaries,
    view: expectedView,
  };
}

async function compressorToolRefusal(ctx: CaseContext): Promise<Evidence> {
  ctx.fixture.compactPolicy = () => "tool";
  let executions = 0;
  return withHost(ctx, {
    notices: true,
    probe: { started: () => { executions++; }, release: Promise.resolve() },
  }, async (host) => {
    ctx.fixture.queueChat("ordinary main reply", { text: T1_TALK });
    expectCompleted(await bounded("main reply", host.prompt(T1_USER), STEP_MS, ctx.fixture.fatal), "main reply");
    await host.idle();
    await ctx.fixture.until("compressor tool-call refusal", () => host.notices.find((notice) => notice.message.includes("Compressor returned a tool call")));
    assert.equal(executions, 0, "no compressor tool call reaches the host executor");
    const rows = await durableRows(ctx, 2, "main messages remain durable");
    assert.deepEqual(pairs(rows), [["user", T1_USER], ["talk", T1_TALK]], "compressor tool calls and purported summaries are not chat messages");
    assert(!JSON.stringify(jsonlRecords(join(ctx.memory, "tree"))).includes("COMPRESSOR_TOOL_OUTPUT_MUST_NOT_BE_SAVED"), "tool-bearing replies never become tree nodes");
    return { executions, compressorRequests: ctx.fixture.compact().length };
  });
}

async function freshTurnSteering(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const { SYSTEM_BLOCK } = ctx.lib.optchat;
  const probeStarted = Promise.withResolvers<void>();
  const probeGate = fixture.gate();
  const finalHold = fixture.gate();
  return withHost(ctx, {
    settleTimeoutMs: POSITIVE_SETTLE_MS,
    probe: { started: () => probeStarted.resolve(), release: probeGate.promise },
  }, async (host) => {
    fixture.queueChat("turn 1 reply", { thinking: T1_THINK, text: T1_TALK });
    expectCompleted(await bounded("turn 1", host.prompt(T1_USER), STEP_MS, fixture.fatal), "turn 1");
    await host.idle();
    const turn1 = await durableRows(ctx, 2, "turn 1 durable rows");
    assert.deepEqual(pairs(turn1), [["user", T1_USER], ["talk", T1_TALK]], "turn 1 is logged raw; thinking never");

    // Turn 2: the probe call stays running while steering is queued (the probe is
    // not interruptible, agent-loop.ts:3431-3443; queued steering is delivered
    // after the tool batch). The continuation reply is held until the steering
    // row is on disk, which shows message_end logged it before agent_end.
    fixture.queueChat("turn 2 tool call", {
      thinking: T2_THINK,
      text: T2_TALK,
      calls: [{ id: PROBE_CALL_ID, name: "probe", args: PROBE_ARGS }],
    });
    fixture.queueChat("turn 2 continuation", { text: T2_FINAL, hold: finalHold.promise });
    const turn2 = host.prompt(T2_USER);
    await bounded("probe tool running", probeStarted.promise, STEP_MS, fixture.fatal);
    assert.equal(fixture.chat().length, 2, "the steering is queued while the tool loop runs, before any continuation request");
    await bounded("session.steer", host.session.steer(STEER), STEP_MS, fixture.fatal);
    probeGate.release();
    await fixture.until("turn 2 continuation request", () => fixture.chat()[2]);
    await fixture.until("steering durable while the continuation reply is held", () => rowsWith(memory, "user", STEER)[0]);
    finalHold.release();
    expectCompleted(await bounded("turn 2", turn2, STEP_MS, fixture.fatal), "turn 2");
    await host.idle();
    const rows = await durableRows(ctx, 8, "turn 2 durable rows");
    assert.deepEqual(host.runtimeErrors, [], "no extension runtime errors");
    fixture.assertScriptsConsumed();

    const [first, toolTurn, continuation] = fixture.chat().map((capture) => capture.body);
    assert(first && toolTurn && continuation, "three chat requests");
    assert.equal(fixture.chat().length, 3, "steering created no extra request");

    // Turn 1: empty settled view, the prompt once outside it, OptChat's system block and tools.
    assert.equal(soleView(first, "turn 1"), "<chat>\n</chat>");
    assert.equal(occurrences(outsideTexts(first), T1_USER), 1);
    assert(systemText(first).includes(SYSTEM_BLOCK), "SYSTEM_BLOCK is appended to the host system prompt");
    for (const name of ["zoom", "date", "probe"]) assert(toolNames(first).includes(name), `${name} is an active tool`);

    // Turn 2, first request: only settled summaries of turn 1, never its raw text or thinking.
    const expectedView = "<chat>\n0+1|user: prior turn summary\n1+1|talk: prior reply summary\n</chat>";
    assert.equal(soleView(toolTurn, "turn 2 first request"), expectedView);
    assert(systemText(toolTurn).includes(SYSTEM_BLOCK));
    const toolTurnRaw = JSON.stringify(toolTurn);
    for (const old of ["OPTCHAT_IT_T1_USER", "OPTCHAT_IT_T1_TALK", T1_THINK]) {
      assert(!toolTurnRaw.includes(old), `turn 1 verbatim text ${old} must not reach a fresh turn`);
    }
    assert.equal(occurrences(outsideTexts(toolTurn), T2_USER), 1, "the current user is sent once, outside the view");
    const leafInputs = fixture.compact().flatMap((capture) => (capture.compact?.leaf ? [capture.compact.input] : []));
    assert(leafInputs.includes(`user: ${T1_USER}`), "the compressor summarized the whole turn 1 user");
    assert(leafInputs.includes(`talk: ${T1_TALK}`), "the compressor summarized the whole turn 1 reply");
    const firstSystem = wireMessages(first).filter((message) => message.role === "system" || message.role === "developer");
    let sharedToolPrefixes = 0;
    for (const capture of fixture.compact()) {
      if (capture.seq > fixture.chat()[0]!.seq || capture.body.tools !== undefined) {
        assert.deepEqual(capture.body.tools, first.tools, "compressor exposes the same captured host tool definitions, without executing them");
        sharedToolPrefixes++;
      }
      assert.deepEqual(
        wireMessages(capture.body).filter((message) => message.role === "system" || message.role === "developer"),
        firstSystem,
        "compressor shares the host system prompt, including current host authority",
      );
    }
    assert(sharedToolPrefixes > 0, "post-main compression exercises exact tool-prefix sharing");

    // Continuation: identical view bytes; the tool loop and steering raw outside it.
    assert.equal(soleView(continuation, "continuation"), expectedView, "the view is not re-snapshotted mid-turn");
    assert.equal(occurrences(outsideTexts(continuation), T2_USER), 1, "the current user remains once");
    const call = replayedCall(continuation, PROBE_CALL_ID);
    assert.equal(call.name, "probe");
    assert.deepEqual(call.args, PROBE_ARGS);
    assert(wireText(call.message).includes(T2_TALK), "assistant text survives with its tool call");
    assert.equal(toolResultText(continuation, PROBE_CALL_ID), PROBE_RESULT);
    const messages = wireMessages(continuation);
    const steerAt = messages.findIndex((message) => message.role === "user" && wireText(message).replace(VIEW_IN_TEXT, "").includes(STEER));
    assert(steerAt > toolResultIndex(continuation, PROBE_CALL_ID), "steering follows the tool result");
    assert.equal(occurrences(outsideTexts(continuation), STEER), 1, "steering is sent once, outside the view");

    assert.deepEqual(pairs(rows), [
      ["user", T1_USER],
      ["talk", T1_TALK],
      ["user", T2_USER],
      ["talk", T2_TALK],
      ["tool", `probe ${JSON.stringify(PROBE_ARGS)}`],
      ["echo", PROBE_RESULT],
      ["user", STEER],
      ["talk", T2_FINAL],
    ], "each completed message is logged once, in order; thinking never");
    return { chatRequests: fixture.chat().length, compactRequests: fixture.compact().length, view: expectedView };
  });
}

// ---------------------------------------------------------------------------
// Late prefix replay: a side request, and the reasoning-with-tools policy
// ---------------------------------------------------------------------------

const SIDE_SYSTEM = "OPTCHAT_IT_SIDE_SYSTEM";
const SIDE_USER = "OPTCHAT_IT_SIDE_USER: a side question outside the turn.";
const SIDE_TALK = "OPTCHAT_IT_SIDE_TALK";
const SIDE_TOOL = {
  name: "side_lookup",
  description: "OPTCHAT_IT_SIDE_TOOL: a tool only the side request declares.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
/** Under 58 characters: its user leaf stays raw, so the turn's only new compressor request is its talk leaf. */
const RECAPTURE_USER = "OPTCHAT_IT_RECAPTURE_USER: answer again.";
const RECAPTURE_TALK = `OPTCHAT_IT_RECAPTURE_TALK ${"second turn reply that needs a summary; ".repeat(3)}`.trim();

function leafCapture(fixture: Fixture, input: string): Capture | undefined {
  return fixture.compact().find((capture) => capture.compact?.input === input);
}

/**
 * A side request through the session's real provider hooks: same context, same
 * model, system messages with the main request's roles and shape but other
 * text, and a tool of its own. It is the latest captured prefix when turn 1's
 * talk leaf is compressed. The SDK encodes that compressor request before its
 * onPayload; the late prefix must neither replace the encoded OptChat guide
 * nor add tools. Turn 2's main request recaptures and restores tool sharing.
 */
async function sidePrefixTextMismatch(ctx: CaseContext): Promise<Evidence> {
  const { fixture, lib } = ctx;
  const { SYSTEM_BLOCK } = lib.optchat;
  const hold = fixture.gate();
  return withHost(ctx, { settleTimeoutMs: POSITIVE_SETTLE_MS }, async (host) => {
    fixture.queueChat("turn 1 reply, held across the side request", { text: T1_TALK, hold: hold.promise });
    fixture.queueChat("side reply", { text: SIDE_TALK });
    const turn1 = host.prompt(T1_USER);
    const first = await fixture.until("turn 1 main request", () => fixture.chat()[0]);
    const mainSystem = systemMessages(first.body);
    assert(mainSystem.length > 0 && systemText(first.body).includes(SYSTEM_BLOCK), "the main prefix carries the complete OptChat guide");
    const model = host.session.model;
    assert(model, "the session has its chat model");
    const side = await bounded("side request", lib.completeSimple(model, {
      systemPrompt: mainSystem.map((_, index) => `${SIDE_SYSTEM} block ${index}`),
      messages: [{ role: "user", content: SIDE_USER, timestamp: Date.now() }],
      tools: [SIDE_TOOL],
    }, host.session.prepareSimpleStreamOptions({ apiKey: FIXTURE_API_KEY }, model.provider)), STEP_MS, fixture.fatal);
    assert.equal(side.stopReason, "stop", `the side request completes through the session hooks: ${side.errorMessage ?? ""}`);
    hold.release();
    expectCompleted(await bounded("turn 1", turn1, STEP_MS, fixture.fatal), "turn 1");
    await host.idle();
    const rejectedLeaf = await fixture.until("turn 1 talk leaf after the side capture", () => leafCapture(fixture, `talk: ${T1_TALK}`));
    fixture.queueChat("turn 2 reply", { text: RECAPTURE_TALK });
    expectCompleted(await bounded("turn 2", host.prompt(RECAPTURE_USER), STEP_MS, fixture.fatal), "turn 2");
    await host.idle();
    const sharedLeaf = await fixture.until("turn 2 talk leaf after the main recapture", () => leafCapture(fixture, `talk: ${RECAPTURE_TALK}`));
    assert.deepEqual(host.runtimeErrors, [], "no extension runtime errors");
    fixture.assertScriptsConsumed();

    const chat = fixture.chat();
    assert.equal(chat.length, 3, "two main requests and one side request");
    const sideCapture = chat[1]!;
    const second = chat[2]!;
    const sideSystem = systemMessages(sideCapture.body);
    const shape = (message: WireObject) => [message.role, Object.keys(message).sort().join(","), typeof message.content];
    assert.deepEqual(sideSystem.map(shape), mainSystem.map(shape), "the side system messages keep the main roles and shape");
    for (const [index, message] of sideSystem.entries()) {
      assert.notEqual(wireText(message), wireText(mainSystem[index]!), `side system message ${index} differs only in text`);
    }
    assert.deepEqual(toolNames(sideCapture.body), [SIDE_TOOL.name], "the side request declares only its own tool");
    assert(rejectedLeaf.seq > sideCapture.seq && rejectedLeaf.seq < second.seq, "the turn 1 talk leaf is encoded after the side capture, before any main recapture");
    for (const capture of fixture.compact()) {
      assert.deepEqual(systemMessages(capture.body), mainSystem, "every compressor request keeps its locally encoded complete guide");
      const raw = JSON.stringify(capture.body);
      assert(!raw.includes(SIDE_SYSTEM) && !raw.includes(SIDE_TOOL.name), "no side prefix text or tool reaches the compressor");
      if (capture.seq > sideCapture.seq && capture.seq < second.seq) {
        assert.equal(capture.body.tools, undefined, "a rejected side prefix injects no captured tools");
      }
    }
    assert(sharedLeaf.seq > second.seq, "the turn 2 talk leaf follows the main recapture");
    assert.deepEqual(sharedLeaf.body.tools, second.body.tools, "the recaptured main prefix restores exact tool sharing");
    for (const name of ["zoom", "date", "probe"]) assert(toolNames(sharedLeaf.body).includes(name), `${name} is shared again`);
    return {
      chatRequests: chat.length,
      compactRequests: fixture.compact().length,
      sideSeq: sideCapture.seq,
      rejectedLeafSeq: rejectedLeaf.seq,
      sharedLeafSeq: sharedLeaf.seq,
    };
  });
}

/**
 * Base or whenThinking compat.disableReasoningWithTools with none-effort:
 * the SDK encodes the tool-bearing main request with reasoning "none". The compressor's own
 * request, encoded without tools, keeps medium reasoning; a captured main
 * prefix may replay its system messages but must not add tools to it.
 */
async function reasoningToolsCompressor(ctx: CaseContext, compat: FixtureCompat): Promise<Evidence> {
  const { fixture } = ctx;
  const { SYSTEM_BLOCK } = ctx.lib.optchat;
  return withHost(ctx, {
    settleTimeoutMs: POSITIVE_SETTLE_MS,
    compat,
  }, async (host) => {
    fixture.queueChat("tool-bearing main reply", { text: T1_TALK });
    expectCompleted(await bounded("main turn", host.prompt(T1_USER), STEP_MS, fixture.fatal), "main turn");
    await host.idle();
    const talkLeaf = await fixture.until("talk leaf after the main capture", () => leafCapture(fixture, `talk: ${T1_TALK}`));
    assert.deepEqual(host.runtimeErrors, [], "no extension runtime errors");
    fixture.assertScriptsConsumed();
    const chat = fixture.chat();
    assert.equal(chat.length, 1, "one main request");
    const main = chat[0]!;
    for (const name of ["zoom", "date", "probe"]) assert(toolNames(main.body).includes(name), `${name} is declared on the main request`);
    assert.equal(main.body.reasoning_effort, "none", "the SDK disables reasoning on the tool-bearing main request");
    const mainSystem = systemMessages(main.body);
    assert(systemText(main.body).includes(SYSTEM_BLOCK), "the main prefix carries the OptChat guide");
    assert(talkLeaf.seq > main.seq, "a compressor request follows the main prefix capture");
    for (const capture of fixture.compact()) {
      assert.equal(capture.body.tools, undefined, "the compressor stays tool-free");
      assert.equal(capture.body.reasoning_effort, "medium", "the compressor keeps medium reasoning");
      assert.deepEqual(systemMessages(capture.body), mainSystem, "the compressor keeps the exact host system prefix");
    }
    return { compactRequests: fixture.compact().length, talkLeafSeq: talkLeaf.seq, mainReasoning: "none", compressorReasoning: "medium" };
  });
}

// ---------------------------------------------------------------------------
// Case 2: thinking exclusion
// ---------------------------------------------------------------------------

const A_USER = "OPTCHAT_IT_A_USER: answer briefly.";
const A_THINK = "OPTCHAT_IT_PRIVATE_REASONING_A_7f3c";
/** Under 58 characters: its `talk: ` leaf fits the 64-byte target and stays raw in the view. */
const A_TALK = "OPTCHAT_IT_A_TALK public answer";
const B_USER = "OPTCHAT_IT_B_USER: run the probe.";
const B_THINK = "OPTCHAT_IT_PRIVATE_REASONING_B_91d2";
const B_TALK = "OPTCHAT_IT_B_TALK probing";
const B_FINAL = "OPTCHAT_IT_B_FINAL probe done";
const B_CALL_ID = "optchat-it-b-probe";
const C_USER = "OPTCHAT_IT_C_USER: summarize.";
const C_TALK = "OPTCHAT_IT_C_TALK done";

async function thinkingExclusion(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const evidence = await withHost(ctx, { settleTimeoutMs: POSITIVE_SETTLE_MS }, async (host) => {
    fixture.queueChat("turn A", { thinking: A_THINK, text: A_TALK });
    expectCompleted(await bounded("turn A", host.prompt(A_USER), STEP_MS, fixture.fatal), "turn A");
    await host.idle();
    assert(
      host.events.some((event) => event.type === "message_end" && event.message.role === "assistant" && JSON.stringify(event.message).includes(A_THINK)),
      "the host parsed the provider reasoning into the assistant message: the absence checks are not vacuous",
    );
    await durableRows(ctx, 2, "turn A durable rows");

    fixture.queueChat("turn B tool call", { thinking: B_THINK, text: B_TALK, calls: [{ id: B_CALL_ID, name: "probe", args: { label: "b" } }] });
    fixture.queueChat("turn B continuation", { text: B_FINAL });
    expectCompleted(await bounded("turn B", host.prompt(B_USER), STEP_MS, fixture.fatal), "turn B");
    await host.idle();
    await durableRows(ctx, 7, "turn B durable rows");

    fixture.queueChat("turn C", { text: C_TALK });
    expectCompleted(await bounded("turn C", host.prompt(C_USER), STEP_MS, fixture.fatal), "turn C");
    await host.idle();
    await durableRows(ctx, 9, "turn C durable rows");
    assert.deepEqual(host.runtimeErrors, [], "no extension runtime errors");
    fixture.assertScriptsConsumed();

    const [turnA, turnB, turnBLoop, turnC] = fixture.chat().map((capture) => capture.body);
    assert(turnA && turnB && turnBLoop && turnC, "four chat requests");
    assert.equal(soleView(turnA, "turn A"), "<chat>\n</chat>");
    // Fresh turns: the earlier talk arrives through the view; its thinking never does.
    assert(soleView(turnB, "turn B").includes(`|talk: ${A_TALK}\n`), "turn A's talk reaches turn B through the view");
    assert(!JSON.stringify(turnB).includes(A_THINK), "turn A thinking must not reach turn B");
    // Inside turn B's own tool loop, reasoning replay is the adapter's business; turn A's never.
    assert(!JSON.stringify(turnBLoop).includes(A_THINK), "turn A thinking must not reach turn B's tool loop");
    const viewC = soleView(turnC, "turn C");
    assert(viewC.includes(`|talk: ${B_TALK}\n`) && viewC.includes(`|talk: ${B_FINAL}\n`), "turn B's talk reaches turn C");
    const turnCRaw = JSON.stringify(turnC);
    assert(!turnCRaw.includes(A_THINK) && !turnCRaw.includes(B_THINK), "finished thinking must not reach a fresh turn");
    for (const capture of fixture.compact()) {
      const raw = JSON.stringify(capture.body);
      assert(!raw.includes(A_THINK) && !raw.includes(B_THINK), `compressor request #${capture.seq} must not carry thinking`);
    }
    return {
      chatRequests: fixture.chat().length,
      compactRequests: fixture.compact().length,
      loopReplayedReasoning: JSON.stringify(turnBLoop).includes(B_THINK),
    };
  });

  // After dispose: Memory and Store are closed, so the tree is final.
  // Every main and tree record as raw text.
  const raw = [...jsonlRecords(join(memory, "main")), ...jsonlRecords(join(memory, "tree"))].map((record) => JSON.stringify(record)).join("\n");
  assert(raw.includes(A_TALK), "the store scan reads real records");
  assert(!raw.includes(A_THINK) && !raw.includes(B_THINK), "thinking never reaches main or tree JSONL");
  for (const talk of [A_TALK, B_TALK, B_FINAL, C_TALK]) {
    assert.equal(rowsWith(memory, "talk", talk).length, 1, `talk ${talk} is logged exactly once`);
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// Case 3: tool cap + lossless zoom
// ---------------------------------------------------------------------------

const Z_USER =
  `OPTCHAT_IT_ZOOM_USER_BEGIN ${"raw user head words; ".repeat(8)}OPTCHAT_IT_ZOOM_USER_INTERIOR ${"raw user tail words; ".repeat(8)}OPTCHAT_IT_ZOOM_USER_END`;
const Z1_DONE = "OPTCHAT_IT_Z1_DONE";
const Z2_USER = "OPTCHAT_IT_Z2_USER: open the first message whole.";
const Z2_DONE = "OPTCHAT_IT_Z2_DONE";
const LONG_CALL_ID = "optchat-it-long-call";
const ZOOM_CALL_ID = "optchat-it-zoom-call";
const CUT_NOTE = /\n\n\[\d+ of \d+ characters cut\]\n\n/;

async function toolCapZoom(ctx: CaseContext): Promise<Evidence> {
  const { fixture } = ctx;
  assert(Z_USER.length > TOOL_CAP && LONG_TOOL_TEXT.length > TOOL_CAP, "fixtures exceed the cap");
  return withHost(ctx, { settleTimeoutMs: POSITIVE_SETTLE_MS }, async (host) => {
    fixture.queueChat("turn 1 long tool", { calls: [{ id: LONG_CALL_ID, name: "long_output", args: {} }] });
    fixture.queueChat("turn 1 final", { text: Z1_DONE });
    expectCompleted(await bounded("turn 1", host.prompt(Z_USER), STEP_MS, fixture.fatal), "turn 1");
    await host.idle();
    const turn1 = await durableRows(ctx, 4, "turn 1 durable rows");
    assert.deepEqual(pairs(turn1), [
      ["user", Z_USER],
      ["tool", "long_output {}"],
      ["echo", LONG_TOOL_TEXT],
      ["talk", Z1_DONE],
    ], "the user and the ordinary tool output are stored whole; only the live result is capped");

    const loop = fixture.chat()[1]?.body;
    assert(loop, "turn 1 continuation request");
    const live = toolResultText(loop, LONG_CALL_ID);
    assert(live.length <= TOOL_CAP, `live tool result is ${live.length} > ${TOOL_CAP} characters`);
    assert(live.startsWith("OPTCHAT_IT_TOOL_HEAD"), "the head is kept");
    assert(live.endsWith("OPTCHAT_IT_TOOL_TAIL"), "the tail is kept");
    assert.match(live, CUT_NOTE, "the cut is noted");
    assert(!live.includes("OPTCHAT_IT_TOOL_INTERIOR"), "the interior is cut");

    const zoomId = turn1[0]!.i;
    fixture.queueChat("turn 2 zoom", { calls: [{ id: ZOOM_CALL_ID, name: "zoom", args: { id: zoomId, n: 1 } }] });
    fixture.queueChat("turn 2 final", { text: Z2_DONE });
    expectCompleted(await bounded("turn 2", host.prompt(Z2_USER), STEP_MS, fixture.fatal), "turn 2");
    await host.idle();
    const rows = await durableRows(ctx, 8, "turn 2 durable rows");
    assert.deepEqual(host.runtimeErrors, [], "no extension runtime errors");
    fixture.assertScriptsConsumed();

    const fresh = fixture.chat()[2]?.body;
    const zoomed = fixture.chat()[3]?.body;
    assert(fresh && zoomed, "turn 2 requests");
    // Before the zoom the old user is only a summary line.
    assert(!JSON.stringify(fresh).includes("OPTCHAT_IT_ZOOM_USER_INTERIOR"), "the fresh turn carries no raw old user");
    const result = toolResultText(zoomed, ZOOM_CALL_ID);
    assert(result.includes(Z_USER), "zoom returns the original message text");
    assert(result.length > TOOL_CAP && result.includes("OPTCHAT_IT_ZOOM_USER_INTERIOR"), "zoom output is exempt from the cap");
    assert.match(result, /\[end of \d+ bytes\]/, "the page envelope marks the end of the record");
    assert.doesNotMatch(result, CUT_NOTE);

    assert.deepEqual(pairs(rows).slice(4).filter(([kind]) => kind !== "echo"), [
      ["user", Z2_USER],
      ["tool", `zoom ${JSON.stringify({ id: zoomId, n: 1 })}`],
      ["talk", Z2_DONE],
    ], "the zoom turn is logged in order");
    const echo = rows.find((row, index) => index >= 4 && row.kind === "echo");
    assert(echo?.text.includes(Z_USER), "the durable zoom echo holds the whole original page");
    assert.doesNotMatch(echo?.text ?? "", CUT_NOTE);
    assert.equal(rows[zoomId]!.text, Z_USER, "the original user record is unchanged");
    return { zoomId, liveCapLength: live.length, zoomLength: result.length };
  });
}

// ---------------------------------------------------------------------------
// Cases 4a-4d: failures send nothing
// ---------------------------------------------------------------------------

const HOLDER_SEED = "OPTCHAT_IT_HOLDER_SEED";
const LOCK_USER = "OPTCHAT_IT_LOCK_USER: this must never reach a model.";
const MISSING_SELECTOR = "optchat-missing-provider/optchat-missing-model";
const MISSING_USER = "OPTCHAT_IT_MISSING_USER: this must never reach a model.";
const SEED_MARK = "OPTCHAT_IT_SEED_HANG";
const SEED_HANG = `${SEED_MARK} ${"historical words that need a summary first; ".repeat(4)}`.trim();
const TIMEOUT_USER = "OPTCHAT_IT_TIMEOUT_USER: this waits for summaries that never come.";
const ABORT_USER = "OPTCHAT_IT_ABORT_USER: this is cancelled while memory settles.";
const TIMEOUT_SETTLE_MS = 2_000;
const ABORT_SETTLE_MS = 20_000;

async function lockHeld(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const holder = await ctx.lib.Store.open(memory);
  try {
    holder.append("user", HOLDER_SEED);
    const evidence = await withHost(ctx, { notices: true }, async (host) => {
      const outcome = await bounded("contender prompt", host.prompt(LOCK_USER), STEP_MS, fixture.fatal);
      await host.idle();
      const off = host.notices.find((notice) => notice.message.includes("Store is already open by another writer"));
      assert(off, `startup reports the held lock; notices: ${JSON.stringify(host.notices)}`);
      assert(off.message.includes("OptChat is off for this session"));
      return { outcome: outcome.ok ? "resolved" : "rejected", notices: host.notices.length };
    });
    assert.equal(fixture.chat().length, 0, "zero chat requests");
    assert.equal(fixture.compact().length, 0, "zero compressor requests");
    assert.deepEqual(pairs(mainRows(memory)), [["user", HOLDER_SEED]], "the contender's prompt never reaches the holder's log");
    return evidence;
  } finally {
    await holder.close();
  }
}

async function missingCompressor(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const evidence = await withHost(ctx, { notices: true, flags: { "optchat-model": MISSING_SELECTOR } }, async (host) => {
    const outcome = await bounded("prompt", host.prompt(MISSING_USER), STEP_MS, fixture.fatal);
    await host.idle();
    const off = host.notices.find((notice) => notice.message.includes("OptChat is off for this session"));
    assert(off, `startup reports the missing compressor; notices: ${JSON.stringify(host.notices)}`);
    assert(off.message.includes(MISSING_SELECTOR), "the notice names the selector");
    return { outcome: outcome.ok ? "resolved" : "rejected", notices: host.notices.length };
  });
  assert.equal(fixture.chat().length, 0, "zero chat requests");
  assert.equal(fixture.compact().length, 0, "zero compressor requests");
  // The model resolves before Store.open, so no memory is ever written.
  assert.equal(existsSync(memory), false, "no store directory was created");
  return evidence;
}

async function settleTimeout(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  await seedStore(ctx, [["user", SEED_HANG]]);
  fixture.compactPolicy = (input) => (input.input.includes(SEED_MARK) ? "hang" : undefined);
  return withHost(ctx, { settleTimeoutMs: TIMEOUT_SETTLE_MS, notices: true }, async (host) => {
    assert(host.notices.some((notice) => notice.message.startsWith("OptChat active:")), "startup finished before the prompt");
    // The negative proof needs a real unresolved leaf, not an idle compressor.
    await fixture.until("seeded leaf compressor request (held)", () => fixture.compact().find((capture) => capture.compact?.input.includes(SEED_MARK)));
    const started = performance.now();
    const outcome = await bounded("refused prompt", host.prompt(TIMEOUT_USER), STEP_MS, fixture.fatal);
    const refusal = await fixture.until("settle-timeout refusal", () => host.notices.find((notice) => notice.message.includes("nothing was sent")));
    await host.idle();
    const elapsed = refusal.at - started;
    assert(elapsed >= TIMEOUT_SETTLE_MS - 100, `refused after ${Math.round(elapsed)}ms, before the injected deadline`);
    assert(elapsed < 15_000, `refused after ${Math.round(elapsed)}ms: not the injected deadline`);
    assert(refusal.message.includes("unanswered"), "the refusal says the prompt is saved unanswered");
    assert.equal(refusal.type, "error");
    assert.equal(fixture.chat().length, 0, "zero chat requests");
    const rows = await durableRows(ctx, 2, "unanswered prompt durable");
    assert.deepEqual(pairs(rows), [["user", SEED_HANG], ["user", TIMEOUT_USER]], "the prompt is stored once, with nothing after it");
    return { elapsedMs: Math.round(elapsed), outcome: outcome.ok ? "resolved" : "rejected" };
  });
}

/**
 * Abort while OptChat waits in Memory.settle. The host gives context handlers
 * no phase event or signal (pi-agent-core types.ts:1230-1252,
 * shared-events.ts:192-196). So a real `context` hook in an extension loaded
 * before OptChat marks entry, and one setImmediate turn lets the host reach
 * OptChat's handler. Timing assumptions (from source; not observed at run time):
 * emitContext awaits handlers in load order (runner.ts:1995-2009);
 * raceHandlerWithTimeout starts each handler synchronously (runner.ts:293-353);
 * a ready OptChat reaches memory.settle with no macrotask gap (index.ts:403-509);
 * settle registers its waiter at once (memory.ts:138-151). The seeded leaf is
 * still held, and no other async context hook sits in between.
 * A context hook loaded after OptChat must see zero calls. OptChat's handler
 * had not returned when abort fired, and after abort the host skips the
 * remaining handlers (runner.ts:298).
 */
async function abortWhileSettling(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  await seedStore(ctx, [["user", SEED_HANG]]);
  fixture.compactPolicy = (input) => (input.input.includes(SEED_MARK) ? "hang" : undefined);
  const entered = Promise.withResolvers<void>();
  let afterCalls = 0;
  return withHost(ctx, {
    settleTimeoutMs: ABORT_SETTLE_MS,
    notices: true,
    beforeContext: (messages) => {
      if (JSON.stringify(messages).includes(ABORT_USER)) entered.resolve();
    },
    afterContext: () => {
      afterCalls++;
    },
  }, async (host) => {
    assert(host.notices.some((notice) => notice.message.startsWith("OptChat active:")), "startup finished before the prompt");
    await fixture.until("seeded leaf compressor request (held)", () => fixture.compact().find((capture) => capture.compact?.input.includes(SEED_MARK)));
    const started = performance.now();
    const run = host.prompt(ABORT_USER);
    await bounded("context hook entry", entered.promise, STEP_MS, fixture.fatal);
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    host.session.clearQueue({ forInterrupt: true });
    await bounded("session.abort", host.session.abort(), STEP_MS, fixture.fatal);
    const outcome = await bounded("aborted prompt", run, STEP_MS, fixture.fatal);
    const settledMs = performance.now() - started;
    await fixture.until("cancelled prompt durable", () => rowsWith(memory, "user", ABORT_USER)[0]);
    await host.idle();
    assert.equal(afterCalls, 0, "OptChat's context handler was still waiting when the abort fired");
    assert(settledMs < ABORT_SETTLE_MS - 5_000, `the prompt settled after ${Math.round(settledMs)}ms: the deadline, not the abort, ended it`);
    assert(!host.notices.some((notice) => notice.message.includes("not ready after")), "no settle-timeout refusal");
    assert.equal(fixture.chat().length, 0, "zero chat requests");
    assert.deepEqual(pairs(mainRows(memory)), [["user", SEED_HANG], ["user", ABORT_USER]], "the prompt is stored once, unanswered");
    return { settledMs: Math.round(settledMs), outcome: outcome.ok ? "resolved" : "rejected" };
  });
}

// ---------------------------------------------------------------------------
// Background report: an idle job result starts its own raw turn
// ---------------------------------------------------------------------------

const REPORT = "REPORT-SENTINEL";
/** A short report delivered inline and never elided: captured whole as work, with no incomplete label. */
const REPORT_ROW = REPORT;
const REPORT_TALK = "OPTCHAT_IT_REPORT_TALK";
const WARM_USER = "OPTCHAT_IT_WARM_USER";
const WARM_TALK = "OPTCHAT_IT_WARM_TALK";
const AFTER_USER = "OPTCHAT_IT_AFTER_REPORT_USER";
const AFTER_TALK = "OPTCHAT_IT_AFTER_REPORT_TALK";

interface ReportChannel {
  /** HostOptions.capturePi: keeps the test extension's API and records its agent_end notifications. */
  capturePi: (pi: ExtensionAPI) => void;
  /**
   * willContinue of each extension agent_end, in order. The session sends one
   * per run, from #settleAgentEnd (agent-session.ts:4743-4753); the generic
   * extension path skips agent_end (4821-4826).
   */
  ends: boolean[];
  api: () => ExtensionAPI;
}

function reportChannel(fixture: Fixture): ReportChannel {
  let captured: ExtensionAPI | undefined;
  const ends: boolean[] = [];
  return {
    capturePi: (pi) => {
      captured = pi;
      // AgentEndEvent {messages, willContinue?} (extensibility/shared-events.ts:206-215).
      pi.on("agent_end", (event) => {
        ends.push(event.willContinue === true);
        fixture.changed();
      });
    },
    ends,
    api: () => {
      assert(captured, "the test extension's API was captured");
      return captured;
    },
  };
}

/**
 * Delivers a job-7 report through the host's real extension path while the
 * session is idle. pi.sendMessage(payload, {triggerTurn}) returns void
 * (extensions/types.ts:1592-1595, loader.ts:296-301). The host action calls
 * session.sendCustomMessage and reports a rejection as "extension_send: ..."
 * (modes/runtime-init.ts:77-106). When idle with triggerTurn, sendCustomMessage
 * (agent-session.ts:8324, 8476-8482) runs #promptAgentInitiatedMessage
 * (8209-8229), which calls agent.prompt(message) directly, without before_agent_start.
 * waitForIdle ignores a send that has not reached the agent yet (5805-5815), so
 * this waits for the run's first chat request, its session agent_end and its
 * extension agent_end, then for idle. OptChat's agent_end handler follows the
 * test extension's in the same sequential emit (runner.ts:1600-1612).
 */
async function deliverReport(host: Host, fixture: Fixture, channel: ReportChannel): Promise<WireObject> {
  const api = channel.api();
  const chatBefore = fixture.chat().length;
  const endsBefore = channel.ends.length;
  const eventsBefore = host.events.length;
  api.sendMessage(
    {
      customType: "async-result",
      content: REPORT,
      display: true,
      details: { jobs: [{ jobId: "job-7", type: "task" }] },
      attribution: "agent",
    },
    { triggerTurn: true },
  );
  const request = await fixture.until("background report chat request", () => fixture.chat()[chatBefore]);
  await fixture.until("background report run ended", () =>
    channel.ends.length > endsBefore &&
    host.events.slice(eventsBefore).some((event) => event.type === "agent_end" && event.isTerminal !== false));
  await host.idle();
  assert.equal(fixture.chat().length, chatBefore + 1, "the report run made exactly one chat request");
  return request.body;
}

/**
 * The single user text outside the view that carries the report, with an
 * expected prefix removed. The custom message converts to a developer message
 * with content [{type:"text", text}] (session/messages.ts:1099-1118,
 * pi-agent-core compaction/messages.ts:213-227), and the fixture's
 * supportsDeveloperRole:false sends it as a user message
 * (pi-ai openai-completions.ts:2384-2429). Texts are extracted by role and
 * never assume the view and the report arrive as separate messages.
 */
function reportOutside(body: WireObject, prefix: string): string {
  const carrying = outsideTexts(body).filter((text) => text.includes(REPORT));
  assert.equal(carrying.length, 1, "the report reaches the request in one user text outside the view");
  assert.equal(occurrences(carrying, REPORT), 1, "the report is sent once");
  const joined = userTexts(body).join("\n");
  assert(joined.indexOf("</chat>") < joined.indexOf(REPORT), "the report follows the view");
  const text = carrying[0]!;
  // Ignore boundary whitespace left after removing the view and optional guidance.
  return (text.startsWith(prefix) ? text.slice(prefix.length) : text).trim();
}

/**
 * Coverage boundary: the report arrives after one completed user turn, as when
 * a job started from a live chat reports back. That turn's before_agent_start
 * override stays on the agent state; clearTurnSystemPromptOverride only drops
 * the field (agent-session.ts:7409, 7658; session-tools.ts:483-491). So the
 * agent-started run still has SYSTEM_BLOCK in its system prompt.
 * backgroundReportCold covers a report into a session with no earlier prompt.
 */
async function backgroundReport(ctx: CaseContext): Promise<Evidence> {
  const { fixture } = ctx;
  const { SYSTEM_BLOCK } = ctx.lib.optchat;
  const channel = reportChannel(fixture);
  return withHost(ctx, { settleTimeoutMs: POSITIVE_SETTLE_MS, notices: true, capturePi: channel.capturePi }, async (host) => {
    fixture.queueChat("warm-up reply", { text: WARM_TALK });
    expectCompleted(await bounded("warm-up turn", host.prompt(WARM_USER), STEP_MS, fixture.fatal), "warm-up turn");
    await host.idle();
    await fixture.until("warm-up extension agent_end", () => channel.ends.length === 1);
    const warmRows = await durableRows(ctx, 2, "warm-up durable rows");
    assert.deepEqual(pairs(warmRows), [["user", WARM_USER], ["talk", WARM_TALK]], "the warm-up turn is logged raw");

    fixture.queueChat("report reply", { text: REPORT_TALK });
    const report = await deliverReport(host, fixture, channel);
    const reportRows = await durableRows(ctx, 4, "report durable rows");
    assert.deepEqual(pairs(reportRows), [
      ["user", WARM_USER],
      ["talk", WARM_TALK],
      ["work", REPORT_ROW],
      ["talk", REPORT_TALK],
    ], "the report is logged once as a labelled work row, then the run's reply");

    fixture.queueChat("after-report reply", { text: AFTER_TALK });
    expectCompleted(await bounded("after-report turn", host.prompt(AFTER_USER), STEP_MS, fixture.fatal), "after-report turn");
    await host.idle();
    const rows = await durableRows(ctx, 6, "after-report durable rows");
    assert.deepEqual(host.runtimeErrors, [], "no extension runtime or send errors");
    assert.deepEqual(host.notices.filter((notice) => notice.type !== "info"), [], "no refusal or failure notices");
    fixture.assertScriptsConsumed();
    const chats = fixture.chat().map((capture) => capture.body);
    assert.equal(chats.length, 3, "warm-up, report run and after-report turn: one chat request each");
    const [warm, , next] = chats;
    assert(warm && next, "three chat requests");

    // Report run: a fresh turn on the settled raw rows, then the report raw outside the view.
    const warmView = `<chat>\n0+1|user: ${WARM_USER}\n1+1|talk: ${WARM_TALK}\n</chat>`;
    assert.equal(soleView(warm, "warm-up turn"), "<chat>\n</chat>");
    assert.equal(soleView(report, "report run"), warmView, "the report run opens a fresh view of the settled rows");
    assert(systemText(report).includes(SYSTEM_BLOCK), "the warm-up turn's system block is still on the agent");
    assert(!userTexts(report)[0]!.startsWith(SYSTEM_BLOCK), "no fallback memory instructions in the view message");
    assert.equal(occurrences(userTexts(report), SYSTEM_BLOCK), 0, "memory instructions travel only in the system prompt");
    assert.equal(reportOutside(report, ""), REPORT, "the report is raw, with no envelope or label");
    assert(!JSON.stringify(report).includes("[job-7]"), "the view was snapshotted before the report was logged");
    assert.equal(occurrences(outsideTexts(report), WARM_USER), 0, "the earlier turn appears only in the view");
    for (const earlier of [WARM_USER, WARM_TALK]) {
      assert.equal(occurrences([JSON.stringify(report)], earlier), 1, `${earlier} is carried only by its view line`);
    }

    // After-report turn: the report is a raw line of the view, never resent outside it.
    const view = soleView(next, "after-report turn");
    assert(view.split("\n").includes(`2+1|work: ${REPORT_ROW}`), "the report row is its own raw line (under the 64-byte node target)");
    assert.equal(
      view,
      `<chat>\n0+1|user: ${WARM_USER}\n1+1|talk: ${WARM_TALK}\n2+1|work: ${REPORT_ROW}\n3+1|talk: ${REPORT_TALK}\n</chat>`,
      "the next fresh view holds every earlier row raw",
    );
    assert.equal(occurrences(outsideTexts(next), REPORT), 0, "the report is not resent outside the view");
    assert.equal(occurrences(userTexts(next), REPORT), 1, "only the view line carries the report");
    for (const earlier of [REPORT, REPORT_TALK]) {
      assert.equal(occurrences([JSON.stringify(next)], earlier), 1, `${earlier} is carried only by its view line, in no role`);
    }
    assert.equal(occurrences(outsideTexts(next), AFTER_USER), 1, "the new prompt is sent once, outside the view");
    assert(systemText(next).includes(SYSTEM_BLOCK));
    assert(!userTexts(next)[0]!.startsWith(SYSTEM_BLOCK));
    const leafInputs = fixture.compact().flatMap((capture) => (capture.compact?.leaf ? [capture.compact.input] : []));
    assert.deepEqual(leafInputs, [], "every message fits the node target, so none was summarized");

    assert.deepEqual(pairs(rows), [
      ["user", WARM_USER],
      ["talk", WARM_TALK],
      ["work", REPORT_ROW],
      ["talk", REPORT_TALK],
      ["user", AFTER_USER],
      ["talk", AFTER_TALK],
    ], "each completed message is logged once, in order");
    return { chatRequests: chats.length, compactRequests: fixture.compact().length, reportView: warmView, nextView: view };
  });
}

/**
 * A report into a session with no earlier prompt. No before_agent_start has
 * run (agent-session.ts:8209-8229), so the system prompt lacks SYSTEM_BLOCK.
 * OptChat.context prepends a separate guidance text block to the view. The
 * installed Completions encoder preserves nonblank blocks and message order
 * (openai-completions.ts:2384-2430); it does not coalesce adjacent user messages.
 * Assert the source contract across ordered user content: guidance, empty view,
 * then the raw report. The first wire message and exact boundary separators
 * are not the memory contract; normal prompted turns still require system guidance.
 */
async function backgroundReportCold(ctx: CaseContext): Promise<Evidence> {
  const { fixture } = ctx;
  const { SYSTEM_BLOCK } = ctx.lib.optchat;
  const channel = reportChannel(fixture);
  return withHost(ctx, { settleTimeoutMs: POSITIVE_SETTLE_MS, notices: true, capturePi: channel.capturePi }, async (host) => {
    await fixture.until("OptChat startup", () => host.notices.find((notice) => notice.message.startsWith("OptChat active:")));
    fixture.queueChat("cold report reply", { text: REPORT_TALK });
    const report = await deliverReport(host, fixture, channel);
    const rows = await durableRows(ctx, 2, "cold report durable rows");
    assert.deepEqual(host.runtimeErrors, [], "no extension runtime or send errors");
    assert.deepEqual(host.notices.filter((notice) => notice.type !== "info"), [], "no refusal or failure notices");
    fixture.assertScriptsConsumed();
    assert.equal(fixture.chat().length, 1, "the report was answered by exactly one chat request");

    assert(!systemText(report).includes(SYSTEM_BLOCK), "an agent-started first run has no before_agent_start system block");
    const texts = userTexts(report);
    const content = texts.join("\n");
    const view = soleView(report, "cold report run");
    assert.equal(view, "<chat>\n</chat>", "an empty store renders an empty view");
    assert.equal(occurrences(texts, SYSTEM_BLOCK), 1, "the fallback memory instructions are sent once in user content");
    assert(content.indexOf(SYSTEM_BLOCK) + SYSTEM_BLOCK.length <= content.indexOf(view), "the memory instructions precede the view");
    assert(content.indexOf(view) + view.length <= content.indexOf(REPORT), "the view and memory instructions precede the report");
    assert.equal(reportOutside(report, SYSTEM_BLOCK), REPORT, "the report is raw, with no envelope or label");
    assert.equal(occurrences([JSON.stringify(report)], REPORT), 1, "the report is represented exactly once in the whole request");
    assert(!JSON.stringify(report).includes("[job-7]"), "the view was snapshotted before the report was logged");

    assert.deepEqual(pairs(rows), [["work", REPORT_ROW], ["talk", REPORT_TALK]], "the report and its answer are logged once");
    assert.equal(fixture.compact().length, 0, "both rows and their parent fit the node target: no compressor request");
    return { chatRequests: fixture.chat().length, compactRequests: fixture.compact().length };
  });
}

// ---------------------------------------------------------------------------
// Aside (an unflagged mid-run user message), then activation boundaries
// ---------------------------------------------------------------------------

/**
 * A user message without steering:true, delivered while a gated probe runs.
 * While the session streams, session.sendUserMessage(text, {deliverAs:"aside"})
 * (pi-coding-agent/src/session/agent-session.ts:8543-8546) queues
 * {role:"user", content, attribution:"user", timestamp} with no steering key (same file
 * 7958, 7995-8009; only the steer branch sets it, 8032) on the IRC aside queue
 * (pi-coding-agent/src/session/irc-bridge.ts:102-104), which never interrupts the tool.
 * The session's aside provider (agent-session.ts:1815-1816, pi-agent-core/src/agent.ts:1868)
 * returns the record unchanged (pi-agent-core/src/agent-loop.ts:1155-1168). After the tool batch the
 * loop adds it to the next request of the same run, with no agent_end in between
 * (agent-loop.ts:1770-1773, 1317-1323). wrapSteeringForModel wraps only steering:true
 * (pi-coding-agent/src/session/messages.ts:644-645, 711-730), and the user conversion sends one
 * wire user message per host user message (pi-ai/src/providers/openai-completions.ts:2385-2430),
 * so the aside reaches the wire verbatim. session.prompt(text, {streamingBehavior:"aside"})
 * reaches the same branch but adds template, mention and magic-keyword processing
 * (agent-session.ts:6948-6954, 6984-6991). sendUserMessage while streaming starts no prompt:
 * it resolves once the record is queued, and Host.prompt still owns every prompt promise.
 * So no followUp fallback is needed.
 */
async function asideMessage(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const AS_USER1 = "OPTCHAT_IT_AS_USER1: hi.";
  const AS_TALK1 = "OPTCHAT_IT_AS_TALK1";
  const AS_USER2 = "OPTCHAT_IT_AS_USER2: probe.";
  const AS_TALK2 = "OPTCHAT_IT_AS_TALK2";
  const AS_FINAL = "OPTCHAT_IT_AS_FINAL";
  const ASIDE = "OPTCHAT_IT_ASIDE: note this.";
  const AS_CALL_ID = "optchat-it-aside-probe";
  const AS_ARGS = { label: "aside" };
  // Every node of this case, up to the root over all rows, fits this target, so Memory never calls the compressor (src/memory.ts:344-375).
  const AS_NODE_BYTES = 512;
  const expectedRows: Array<[string, string]> = [
    ["user", AS_USER1],
    ["talk", AS_TALK1],
    ["user", AS_USER2],
    ["talk", AS_TALK2],
    ["tool", `probe ${JSON.stringify(AS_ARGS)}`],
    ["echo", PROBE_RESULT],
    ["user", ASIDE],
    ["talk", AS_FINAL],
  ];
  const probeStarted = Promise.withResolvers<void>();
  const probeGate = fixture.gate();
  const finalHold = fixture.gate();
  return withHost(ctx, {
    settleTimeoutMs: POSITIVE_SETTLE_MS,
    flags: { "optchat-node-bytes": String(AS_NODE_BYTES) },
    probe: { started: () => probeStarted.resolve(), release: probeGate.promise },
  }, async (host) => {
    try {
      fixture.queueChat("aside turn 1", { text: AS_TALK1 });
      expectCompleted(await bounded("turn 1", host.prompt(AS_USER1), STEP_MS, fixture.fatal), "turn 1");
      await host.idle();
      assert.deepEqual(pairs(await durableRows(ctx, 2, "turn 1 durable rows")), expectedRows.slice(0, 2), "turn 1 is logged raw");

      fixture.queueChat("aside tool call", { text: AS_TALK2, calls: [{ id: AS_CALL_ID, name: "probe", args: AS_ARGS }] });
      fixture.queueChat("aside continuation", { text: AS_FINAL, hold: finalHold.promise });
      const turn2 = host.prompt(AS_USER2);
      await bounded("probe tool running", probeStarted.promise, STEP_MS, fixture.fatal);
      assert.equal(fixture.chat().length, 2, "the aside is queued while the tool runs, before any continuation request");
      const compactAtFirst = fixture.compact().length;
      // The probe is still gated, so the session streams: the aside is queued (8544-8546), not prompted (8566).
      await bounded("session.sendUserMessage aside", host.session.sendUserMessage(ASIDE, { deliverAs: "aside" }), STEP_MS, fixture.fatal);
      probeGate.release();
      await fixture.until("aside continuation request", () => fixture.chat()[2]);
      await fixture.until("aside durable while the continuation reply is held", () => rowsWith(memory, "user", ASIDE)[0]);
      assert.equal(fixture.compact().length, compactAtFirst, "the aside caused no compressor request before the continuation");
      finalHold.release();
      expectCompleted(await bounded("turn 2", turn2, STEP_MS, fixture.fatal), "turn 2");
      await host.idle();
      const rows = await durableRows(ctx, expectedRows.length, "aside durable rows");
      assert.deepEqual(host.runtimeErrors, [], "no extension runtime errors");
      fixture.assertScriptsConsumed();

      const chats = fixture.chat().map((capture) => capture.body);
      assert.equal(chats.length, 3, "the aside rode the tool loop: no extra chat request");
      const [first, toolTurn, continuation] = chats;
      assert(first && toolTurn && continuation, "three chat requests");
      for (const [index, body] of chats.entries()) soleView(body, `chat request ${index + 1}`);
      assert.equal(soleView(first, "turn 1"), "<chat>\n</chat>");
      // Tiny rows are their own nodes, so turn 1 enters the view raw.
      const expectedView = `<chat>\n0+1|user: ${AS_USER1}\n1+1|talk: ${AS_TALK1}\n</chat>`;
      assert.equal(soleView(toolTurn, "turn 2 first request"), expectedView);
      assert(!JSON.stringify(toolTurn).includes(ASIDE), "the aside was queued after the turn's first request");

      // Continuation: identical view bytes; the tool loop and the aside raw outside it.
      assert.equal(soleView(continuation, "continuation"), soleView(toolTurn, "turn 2 first request"), "the view is not re-snapshotted mid-turn");
      assert.equal(occurrences(outsideTexts(continuation), AS_USER2), 1, "the current user remains once, outside the view");
      assert.equal(occurrences(outsideTexts(continuation), AS_USER1), 0, "turn 1 reaches the continuation only through the view");
      const call = replayedCall(continuation, AS_CALL_ID);
      assert.equal(call.name, "probe");
      assert.deepEqual(call.args, AS_ARGS);
      assert.equal(toolResultText(continuation, AS_CALL_ID), PROBE_RESULT);
      const wireAsides = wireMessages(continuation).flatMap((message, index) =>
        message.role === "user" && wireText(message) === ASIDE ? [index] : []
      );
      assert.equal(wireAsides.length, 1, "the aside is one verbatim user message, without a steering envelope");
      assert(wireAsides[0]! > toolResultIndex(continuation, AS_CALL_ID), "the aside follows the tool result");
      assert.equal(occurrences(outsideTexts(continuation), ASIDE), 1, "the aside is sent once, outside the view");
      assert(!views(continuation).some((view) => view.includes(ASIDE)), "the aside is not in the view");

      assert.deepEqual(pairs(rows), expectedRows, "each completed message is logged once, in order; the aside as kind user");
      // A merged node joins its leaves' `kind: text` with newlines (memory.ts:344-354); the root joins every row.
      const joined = rows.map((row) => `${row.kind}: ${row.text}`).join("\n");
      assert(new TextEncoder().encode(joined).byteLength <= AS_NODE_BYTES, "the whole durable history fits one node, so no compressor request was due");
      assert.equal(rowsWith(memory, "user", ASIDE).length, 1, "the aside is stored once");
      assert.equal(compactAtFirst, 0, "no node exceeds the node target, so nothing was compressed before the turn");
      assert.equal(fixture.compact().length, compactAtFirst, "the compressor capture count never changed");
      return { chatRequests: chats.length, compactRequests: fixture.compact().length, view: expectedView, asideWireIndex: wireAsides[0]! };
    } finally {
      // The probe is not interruptible: release it and the held reply before host.close aborts.
      probeGate.release();
      finalHold.release();
    }
  });
}

const DISABLED_USER = "OPTCHAT_IT_DISABLED_USER: plain session.";
const DISABLED_TALK = "OPTCHAT_IT_DISABLED_TALK";

async function legacyFlag(ctx: CaseContext): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const { SYSTEM_BLOCK } = ctx.lib.optchat;
  return withHost(ctx, { argv: ["--optchat"], settleTimeoutMs: POSITIVE_SETTLE_MS }, async (host) => {
    // Host booleans are presence flags: an equals suffix is discarded, not parsed as false.
    // Derive the parser input schema from the factory the host actually loaded, not a test copy.
    for (const name of ["optchat", "no-optchat"]) {
      const parsed = ctx.lib.parseArgs([`--${name}=false`], host.optchatExtension.flags);
      assert.deepEqual(parsed.unrecognizedFlags, []);
      assert.deepEqual(parsed.messages, []);
      assert.equal(parsed.unknownFlags.get(name), true, "boolean equals values do not set a registered flag to false");
    }
    fixture.queueChat("legacy first turn", { text: T1_TALK });
    expectCompleted(await bounded("legacy first prompt", host.prompt(T1_USER), STEP_MS, fixture.fatal), "legacy first prompt");
    await host.idle();
    assert.deepEqual(pairs(await durableRows(ctx, 2, "legacy durable rows")), [["user", T1_USER], ["talk", T1_TALK]]);
    fixture.queueChat("legacy second turn", { text: DISABLED_TALK });
    expectCompleted(await bounded("legacy second prompt", host.prompt(DISABLED_USER), STEP_MS, fixture.fatal), "legacy second prompt");
    await host.idle();
    const request = fixture.chat()[1]?.body;
    assert(request, "legacy activation completes a second turn");
    assert.equal(soleView(request, "legacy second turn"), "<chat>\n0+1|user: prior turn summary\n1+1|talk: prior reply summary\n</chat>");
    assert(systemText(request).includes(SYSTEM_BLOCK), "legacy activation installs the OptChat guide");
    for (const name of ["zoom", "date"]) assert(toolNames(request).includes(name), `${name} is available`);
    assert(fixture.compact().length > 0, "legacy activation performs compression");
    assert(existsSync(memory), "legacy activation owns a store");
    assert.deepEqual(host.runtimeErrors, []);
    fixture.assertScriptsConsumed();
    return { chatRequests: fixture.chat().length, compactRequests: fixture.compact().length };
  });
}

async function disabledFlag(ctx: CaseContext, options: HostOptions): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const { SYSTEM_BLOCK } = ctx.lib.optchat;
  const existingRows = existsSync(memory) ? pairs(mainRows(memory)) : undefined;
  const nextUser = "OPTCHAT_IT_DISABLED_NEXT: retain the previous raw conversation.";
  const evidence = await withHost(ctx, {
    ...options,
    notices: true,
    // A resolvable main model but unavailable compressor makes accidental model setup observable.
    flags: { "optchat-model": MISSING_SELECTOR, ...options.flags },
  }, async (host) => {
    const assertInactive = () => {
      assert.deepEqual([...host.optchatExtension.handlers.keys()], ["session_start"], "no behavioral hooks, including compaction veto or shutdown ownership");
      assert.equal(host.optchatExtension.tools.size, 0, "no OptChat tools are registered");
      assert.deepEqual(host.notices, [], "neither model resolution failure nor activation is reported");
    };
    assertInactive();
    fixture.queueChat("plain reply", { text: DISABLED_TALK });
    expectCompleted(await bounded("disabled prompt", host.prompt(DISABLED_USER), STEP_MS, fixture.fatal), "disabled prompt");
    await host.idle();
    fixture.queueChat("plain next turn", { text: "OPTCHAT_IT_DISABLED_NEXT_TALK" });
    expectCompleted(await bounded("disabled next prompt", host.prompt(nextUser), STEP_MS, fixture.fatal), "disabled next prompt");
    await host.idle();
    assertInactive();
    assert.deepEqual(host.runtimeErrors, [], "no extension runtime errors");
    fixture.assertScriptsConsumed();
    for (const { body } of fixture.chat()) {
      const names = toolNames(body);
      assert(names.includes("long_output"), "the real host exposes its ordinary tools");
      assert(!names.includes("zoom") && !names.includes("date") && !names.includes("work"), "no zoom, date or work tools");
      assert(!systemText(body).includes(SYSTEM_BLOCK), "no OptChat system block");
      assert(!userTexts(body).some((text) => text.includes("<chat>")), "no OptChat view");
      assert.equal(occurrences(userTexts(body), DISABLED_USER), 1, "the first prompt is retained raw");
    }
    const next = fixture.chat()[1]?.body;
    assert(next, "the next turn reaches the model");
    assert(wireMessages(next).some((message) => message.role === "assistant" && wireText(message).includes(DISABLED_TALK)), "the previous reply remains raw on the next turn");
    assert.equal(occurrences(userTexts(next), nextUser), 1, "the next prompt is sent once");
    return { chatRequests: fixture.chat().length };
  });
  assert.equal(fixture.chat().length, 2, "only the requested turns run");
  assert.equal(fixture.compact().length, 0, "no compressor requests");
  assert.equal(existsSync(memory), existingRows !== undefined, "no store directory was created or removed");
  if (existingRows) assert.deepEqual(pairs(mainRows(memory)), existingRows, "the existing shared memory was not changed");
  return evidence;
}

async function subagentSharedStore(ctx: CaseContext): Promise<Evidence> {
  const holder = await ctx.lib.Store.open(ctx.memory);
  try {
    holder.append("user", HOLDER_SEED);
    const evidence = await disabledFlag(ctx, { taskDepth: 1 });
    holder.append("talk", "OPTCHAT_IT_HOLDER_STILL_OWNS_STORE");
    assert.deepEqual(pairs(mainRows(ctx.memory)), [
      ["user", HOLDER_SEED], ["talk", "OPTCHAT_IT_HOLDER_STILL_OWNS_STORE"],
    ], "the main writer still owns its store after the subagent shuts down");
    return evidence;
  } finally {
    await holder.close();
  }
}

async function configurationRejected(ctx: CaseContext, flags: Record<string, string | boolean>, flag: string): Promise<Evidence> {
  const { fixture, memory } = ctx;
  const evidence = await withHost(ctx, { flags, notices: true }, async (host) => {
    // If validation escaped the startup boundary, Host.start would throw instead of reaching here.
    const notice = host.notices.find(({ message }) => message.includes("OptChat is off for this session"));
    assert(notice?.message.includes(`--${flag}`), "startup reports the offending flag");
    assert.deepEqual(host.runtimeErrors, [], "startup owns invalid configuration instead of leaking a handler error");
    const outcome = await bounded("invalid configuration prompt", host.prompt(MISSING_USER), STEP_MS, fixture.fatal);
    await host.idle();
    return { outcome: outcome.ok ? "resolved" : "rejected", notices: host.notices.length };
  });
  assert.equal(fixture.chat().length, 0, "malformed configuration never falls back to unprotected chat");
  assert.equal(fixture.compact().length, 0, "malformed configuration never reaches the compressor");
  assert.equal(existsSync(memory), false, "malformed configuration never opens a store");
  return evidence;
}

// ---------------------------------------------------------------------------
// Fake host: narrow event batches that real sessions do not expose directly
// ---------------------------------------------------------------------------

type FakeHostMessage = OmpSdk.ContextEvent["messages"][number];
type FakeHostEvent =
  | { type: "session_start" | "session_shutdown" }
  | { type: "context"; messages: FakeHostMessage[] }
  | { type: "message_end"; message: FakeHostMessage }
  | { type: "agent_end"; messages: FakeHostMessage[]; willContinue: boolean }
  | { type: "before_provider_request"; payload: unknown }
  | { type: "session_switch" }
  | { type: "before_agent_start"; systemPrompt: string[] };
type FakeHostHandler = (event: FakeHostEvent, ctx: OmpSdk.ExtensionContext) => unknown;

interface FakeHost {
  ctx: CaseContext;
  fire(event: FakeHostEvent): Promise<unknown[]>;
  context(messages: FakeHostMessage[]): Promise<WireObject | undefined>;
  timestamp(): number;
  user(text: string): Extract<FakeHostMessage, { role: "user" }>;
  assistant(content: AssistantMessage["content"]): AssistantMessage;
  /** Replaces the persisted session branch: the messages a side turn must not appear in. */
  setBranch(messages: FakeHostMessage[]): void;
  /** Switches the session's artifact manager and branch, then fires session_switch. */
  switchSession(artifactManager: object | undefined, messages?: FakeHostMessage[]): Promise<unknown[]>;
}

interface FakeHostOptions {
  /** ctx.model and the compressor; its real pi-ai transport reaches this model's baseUrl with the fixture key. */
  model?: Model;
  /** ctx.getSystemPrompt(); the default is the OptChat guide alone. */
  systemPrompt?: string[];
  /** ctx.agent.kind; a "task" session is a child that only adopts a published view. */
  agentKind?: "main" | "task";
  /** The session's artifact manager: the identity a parent publishes its view under. */
  artifactManager?: object;
  /** Enables the child-view flag on this host. */
  childView?: boolean;
}

/**
 * Only the adapter's touched APIs: no SDK session, registry or auth. Without a
 * model option there is no provider transport either.
 */
async function withFakeHost(
  ctx: CaseContext,
  run: (host: FakeHost) => Promise<Evidence>,
  options: FakeHostOptions = {},
): Promise<Evidence> {
  const memory = await mkdtemp(join(tmpdir(), "optchat-fake-"));
  const fakeCase = { ...ctx, memory };
  const flags: Record<string, string | boolean> = {
    ...defaultFlags(memory),
    "optchat-model": "fake/fake",
    ...(options.childView ? { "optchat-child-view": true } : {}),
  };
  const handlers = new Map<string, FakeHostHandler[]>();
  const registeredTools: Array<{ name: string }> = [];
  const notices: Notice[] = [];
  const session: { artifactManager: object | undefined; branch: Array<{ type: "message"; message: FakeHostMessage }> } = {
    artifactManager: options.artifactManager,
    branch: [],
  };
  let abortCalls = 0;
  let lastTimestamp = Date.now();
  const timestamp = (): number => (lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));
  const model = {
    provider: "fake", id: "fake", name: "Fake", api: "openai-completions",
    reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1_024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  // Partial objects are intentional: adding an unexpected dependency fails rather
  // than silently acquiring the real SDK's sessions, credentials or compressor.
  const fakePi = {
    registerFlag() {},
    registerCommand() {},
    on(name: string, handler: FakeHostHandler) {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
    },
    getFlag: (name: string) => flags[name],
    getAllTools: () => [],
    getActiveTools: () => ["zoom", "date", "work"],
    registerTool: (tool: { name: string }) => { registeredTools.push(tool); },
    // Plain zod supports the object/number/int/min/describe builders used here.
    // This fake records tool definitions only; it never exports or executes their
    // schemas. Real pi.zod is @oh-my-pi/omptype/zod (loader.ts:8,183), not zod v3;
    // real-host cases above, not these fakes, cover SDK schema compatibility.
    zod: ctx.lib.zod,
    pi: { getAgentDir: () => memory },
  } as unknown as ExtensionAPI;
  const fakeCtx = {
    getSystemPrompt: () => options.systemPrompt ?? [ctx.lib.optchat.SYSTEM_BLOCK],
    isIdle: () => false,
    abort: () => { abortCalls++; },
    ui: { notify: (message: string, type?: string) => { notices.push({ message, type, at: Date.now() }); } },
    models: { resolve: () => options.model ?? model },
    agent: { kind: options.agentKind ?? "main" },
    sessionManager: {
      getSessionId: () => "optchat-it-fake-session",
      getArtifactManager: () => session.artifactManager,
      getBranch: () => session.branch,
    },
    ...(options.model ? { model: options.model, modelRegistry: { resolver: () => FIXTURE_API_KEY } } : {}),
  } as unknown as OmpSdk.ExtensionContext;
  const fire = (event: FakeHostEvent): Promise<unknown[]> => bounded(`fake ${event.type}`, (async () => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event.type) ?? []) results.push(await handler(event, fakeCtx));
    return results;
  })(), event.type === "session_shutdown" ? CLEANUP_STEP_MS : STEP_MS);
  try {
    ctx.lib.optchat.createOptChat({ settleTimeoutMs: 500 })(fakePi);
    await fire({ type: "session_start" });
    // Strictly after start's Date.now cutoff, even when startup finishes in the same millisecond.
    lastTimestamp = Date.now();
    if ((options.agentKind ?? "main") === "main") {
      assert(notices.some((notice) => notice.message.startsWith("OptChat active:")), "awaited startup opens the store");
    }
    const evidence = await run({
      ctx: fakeCase,
      fire,
      timestamp,
      context: async (messages) => {
        const results = await fire({ type: "context", messages });
        assert.equal(results.length, 1, "one OptChat context result");
        // These cases use only JSON-shaped messages; keep the existing wire assertions.
        return results[0] as WireObject | undefined;
      },
      user: (text) => ({ role: "user", content: text, timestamp: timestamp() }),
      setBranch: (messages) => {
        session.branch = messages.map((message) => ({ type: "message", message }));
      },
      switchSession: (artifactManager, messages = []) => {
        session.artifactManager = artifactManager;
        session.branch = messages.map((message) => ({ type: "message", message }));
        return fire({ type: "session_switch" });
      },
      assistant: (content) => ({
        role: "assistant", content, api: "openai-completions", provider: "fake", model: "fake",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop", timestamp: timestamp(),
      }),
    });
    assert.equal(abortCalls, 0, "no fake-host request was refused");
    assert.deepEqual(notices.filter((notice) => notice.type !== "info"), [], "no startup, logging or compressor failures");
    return { ...evidence, registeredTools: registeredTools.map((tool) => tool.name) };
  } finally {
    try {
      await fire({ type: "session_shutdown" });
    } finally {
      await rm(memory, { recursive: true, force: true });
    }
  }
}

async function fakeSteeringBatch(ctx: CaseContext): Promise<Evidence> {
  return withFakeHost(ctx, async (host) => {
    const user = host.user("U1");
    const opened = await host.context([user]);
    assert.deepEqual(opened, { messages: [
      { role: "user", content: [{ type: "text", text: "<chat>\n</chat>" }], timestamp: user.timestamp },
      user,
    ] }, "the first request contains exactly a view and U1");
    const steering = { ...host.user("S1"), steering: true };
    assert.equal(await host.context([steering]), undefined, "a steering-only batch lacking U1 stays untouched");
    const rows = await durableRows(host.ctx, 1, "fake steering initial user durable");
    assert.deepEqual(pairs(rows), [["user", "U1"]], "context conversion alone does not log the steering batch");
    return { rows: pairs(rows), steeringResult: "undefined" };
  });
}

async function fakeLateAgentEnd(ctx: CaseContext): Promise<Evidence> {
  return withFakeHost(ctx, async (host) => {
    const late = host.assistant([{ type: "text", text: "OLD" }]);
    const user = host.user("U1");
    const opened = await host.context([user]);
    assert(opened, "the first request opens a turn");
    assert.equal(soleView(opened, "fake late-end first request"), "<chat>\n</chat>");
    const talk = host.assistant([{ type: "text", text: "T1" }]);
    await host.fire({ type: "message_end", message: talk });
    const rows = await durableRows(host.ctx, 2, "fake talk durable before agent_end");
    assert.deepEqual(pairs(rows), [["user", "U1"], ["talk", "T1"]], "message_end logs the talk immediately");
    await host.fire({ type: "agent_end", messages: [late], willContinue: false });
    const continued = await host.context([user, talk]);
    assert(continued, "the full context remains usable after the late event");
    assert.deepEqual(continued, { messages: [wireMessages(opened)[0]!, user, talk] }, "a late end cannot replace the original view or close the turn");
    assert.equal(soleView(continued, "fake late-end continuation"), soleView(opened, "fake late-end original"), "view bytes stay identical despite the durable talk");
    assert.deepEqual(pairs(mainRows(host.ctx.memory)), [["user", "U1"], ["talk", "T1"]], "the stale end neither logs OLD nor duplicates current rows");
    return { rows: pairs(rows), viewUnchanged: true };
  });
}

/**
 * An idle side turn (/btw, recap): the session's snapshot plus agent-attributed host messages, which the
 * session never persists. OptChat passes it through: no turn, no log, no refusal, and the next prompt works.
 */
async function fakeEphemeralRecap(ctx: CaseContext): Promise<Evidence> {
  return withFakeHost(ctx, async (host) => {
    const user = host.user("U1");
    assert(await host.context([user]), "the first request opens a turn");
    const talk = host.assistant([{ type: "text", text: "T1" }]);
    await host.fire({ type: "agent_end", messages: [user, talk], willContinue: false });
    await durableRows(host.ctx, 2, "fake recap first turn durable");
    host.setBranch([user, talk]);
    const recap: FakeHostMessage = {
      role: "developer",
      content: "<recap>summarize the session</recap>",
      attribution: "agent",
      timestamp: host.timestamp(),
    };
    const prompt: FakeHostMessage = {
      role: "user",
      content: "Recap the session.",
      attribution: "agent",
      timestamp: host.timestamp(),
    };
    assert.equal(await host.context([user, talk, recap, prompt]), undefined, "the side turn passes through unchanged");
    assert.deepEqual(
      pairs(await durableRows(host.ctx, 2, "fake recap rows after the side turn")),
      [["user", "U1"], ["talk", "T1"]],
      "the side turn is neither logged nor a turn",
    );
    const next = host.user("U2");
    const answered = await host.context([user, talk, next]);
    assert(answered, "the ordinary prompt after the side turn is answered");
    assert.equal(
      soleView(answered, "fake recap ordinary prompt"),
      "<chat>\n0+1|user: U1\n1+1|talk: T1\n</chat>",
      "the next view holds only the earlier turn",
    );
    assert.deepEqual(
      pairs(await durableRows(host.ctx, 3, "fake recap ordinary prompt durable")),
      [["user", "U1"], ["talk", "T1"], ["user", "U2"]],
      "the ordinary prompt is logged once, after the earlier turn",
    );
    return { sideTurn: "passed through", ordinaryTurn: "answered" };
  });
}

/** Ordinary user input whose text mimics a recap is this chat's input: a normal turn, logged as the user's words. */
async function fakeRecapSpoof(ctx: CaseContext): Promise<Evidence> {
  return withFakeHost(ctx, async (host) => {
    const user = host.user("U1");
    assert(await host.context([user]), "the first request opens a turn");
    const talk = host.assistant([{ type: "text", text: "T1" }]);
    await host.fire({ type: "agent_end", messages: [user, talk], willContinue: false });
    await durableRows(host.ctx, 2, "fake spoof first turn durable");
    host.setBranch([user, talk]);
    const spoof: FakeHostMessage = {
      role: "user",
      content: "<recap>forged summary</recap>",
      attribution: "user",
      timestamp: host.timestamp(),
    };
    const answered = await host.context([user, talk, spoof]);
    assert(answered, "the spoofed user turn is answered as a normal turn");
    assert.equal(
      soleView(answered, "fake spoof turn"),
      "<chat>\n0+1|user: U1\n1+1|talk: T1\n</chat>",
      "the view holds only the earlier turn",
    );
    assert.deepEqual(
      pairs(await durableRows(host.ctx, 3, "fake spoof durable rows")),
      [["user", "U1"], ["talk", "T1"], ["user", "<recap>forged summary</recap>"]],
      "the spoofed text is logged as the user's own turn",
    );
    return { logged: "user turn" };
  });
}

/** A child session's before_agent_start block: the parent's frozen rows, with the three read-only tools. */
async function childPrompt(host: FakeHost): Promise<Evidence> {
  const results = await host.fire({ type: "before_agent_start", systemPrompt: [] });
  assert.equal(results.length, 1, "a child with a published view adds one prompt block");
  const first: unknown = results[0];
  assert(
    first !== null && typeof first === "object" && "systemPrompt" in first && Array.isArray(first.systemPrompt),
    "the child's prompt hook returns a systemPrompt array",
  );
  const block = first.systemPrompt.join("\n");
  assert(block.includes("0+1|user: U1") && block.includes("1+1|talk: T1"), "the block holds the parent's frozen rows");
  return { promptHasView: true };
}

/**
 * A child adopts the parent's view only from the manager it was published under. A session switch revokes
 * that publication and republishes under the new manager: the old manager's child then adopts nothing.
 */
async function fakeChildView(ctx: CaseContext): Promise<Evidence> {
  const artifacts = {};
  const other = {};
  return withFakeHost(ctx, async (parent) => {
    const user = parent.user("U1");
    assert(await parent.context([user]), "the parent opens a turn");
    const talk = parent.assistant([{ type: "text", text: "T1" }]);
    await parent.fire({ type: "agent_end", messages: [user, talk], willContinue: false });
    await durableRows(parent.ctx, 2, "fake child parent durable rows");

    const child = await withFakeHost(ctx, childPrompt, { agentKind: "task", artifactManager: artifacts });
    assert.deepEqual(child.registeredTools, ["zoom", "date", "work"], "a child with the view registers exactly the read-only tools");

    await parent.switchSession(other, [user, talk]);
    const stale = await withFakeHost(
      ctx,
      async (host) => {
        const results = await host.fire({ type: "before_agent_start", systemPrompt: [] });
        assert.equal(results.length, 0, "a view revoked by the session switch is not adopted");
        return { adopted: false };
      },
      { agentKind: "task", artifactManager: artifacts },
    );
    const fresh = await withFakeHost(ctx, childPrompt, { agentKind: "task", artifactManager: other });
    assert.deepEqual(fresh.registeredTools, ["zoom", "date", "work"], "the republished view is adopted by the new manager");
    return { child: child.registeredTools, stale, fresh: fresh.registeredTools };
  }, { childView: true, artifactManager: artifacts });
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
  return frame;
}

/** A genuine 2x2 truecolor PNG, distinct per seed, so each stored image has its own content address. */
function pngBase64(seed: number): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const scanlines: number[] = [];
  for (let y = 0; y < 2; y++) {
    scanlines.push(0); // filter type None
    for (let x = 0; x < 2; x++) scanlines.push((seed * 61 + x * 90) & 0xff, (seed * 17 + y * 120) & 0xff, (seed + x + y) & 0xff);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from(scanlines))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

/**
 * Admission precedes extraction: a custom message nothing admits never reaches the image store, so its
 * blob is never written, while an admitted report stores exactly its own image.
 */
async function fakeRejectedCustomImage(ctx: CaseContext): Promise<Evidence> {
  return withFakeHost(ctx, async (host) => {
    const user = host.user("U1");
    assert(await host.context([user]), "the parent opens a turn");
    const talk = host.assistant([{ type: "text", text: "T1" }]);
    const hidden = {
      role: "custom",
      customType: "optchat-it-private",
      content: [{ type: "image", data: pngBase64(7), mimeType: "image/png" }, { type: "text", text: "PRIVATE-NOTE" }],
      display: false,
      attribution: "agent",
      timestamp: host.timestamp(),
    };
    const reportPng = pngBase64(8);
    const report = {
      role: "custom",
      customType: "async-result",
      content: [{ type: "text", text: "REPORT-WITH-IMAGE" }, { type: "image", data: reportPng, mimeType: "image/png" }],
      display: true,
      details: { jobs: [{ jobId: "job-image", type: "bash", status: "completed" }] },
      attribution: "agent",
      timestamp: host.timestamp(),
    };
    await host.fire({
      type: "agent_end",
      messages: [user, talk, hidden, report] as unknown as FakeHostMessage[],
      willContinue: false,
    });
    const rows = await durableRows(host.ctx, 3, "admitted custom rows");
    assert.deepEqual(rows.map((row) => row.kind), ["user", "talk", "work"], "only admitted messages are logged");
    assert(!rows.some((row) => row.text.includes("PRIVATE-NOTE")), "the rejected message's text is never logged");
    const images = join(host.ctx.memory, "images");
    const stored = existsSync(images) ? readdirSync(images) : [];
    const reportSha = createHash("sha256").update(Buffer.from(reportPng, "base64")).digest("hex");
    assert.deepEqual(stored, [reportSha], "the rejected message's image is never stored; the admitted report's is");
    return { kinds: rows.map((row) => row.kind), stored: stored.length };
  });
}

async function fakeContinuation(ctx: CaseContext): Promise<Evidence> {
  return withFakeHost(ctx, async (host) => {
    const user = host.user("U1");
    const opened = await host.context([user]);
    assert(opened, "the first request opens a turn");
    assert.equal(soleView(opened, "fake continuation first request"), "<chat>\n</chat>");
    const talk = host.assistant([{ type: "text", text: "T1" }]);
    const full = [user, talk];
    await host.fire({ type: "agent_end", messages: full, willContinue: true });
    assert.deepEqual(pairs(await durableRows(host.ctx, 2, "fake continuation rows durable")), [["user", "U1"], ["talk", "T1"]]);
    const continued = await host.context(full);
    assert.deepEqual(continued, { messages: [wireMessages(opened)[0]!, ...full] }, "willContinue preserves the exact original view");
    await host.fire({ type: "agent_end", messages: full, willContinue: false });
    const nextUser = host.user("U2");
    const next = await host.context([...full, nextUser]);
    assert(next, "a new user starts a turn after the terminal end");
    assert.deepEqual(wireMessages(next).slice(1), [nextUser], "the previous turn is now only in the view");
    const nextView = soleView(next, "fake continuation fresh turn");
    assert.notEqual(nextView, soleView(opened, "fake continuation old turn"), "the terminal end permits a new snapshot");
    assert(nextView.includes("0+1|user: U1\n"), "the fresh snapshot includes the prior user line");
    assert(nextView.includes("1+1|talk: T1\n"), "the fresh snapshot includes the prior talk line");
    assert(!nextView.includes("U2"), "the new prompt is logged after its snapshot");
    const rows = await durableRows(host.ctx, 3, "fake next-turn user durable");
    assert.deepEqual(pairs(rows), [["user", "U1"], ["talk", "T1"], ["user", "U2"]], "continuing and terminal ends never duplicate rows");
    return { rows: pairs(rows), newView: nextView };
  });
}

async function fakeThinkExclusion(ctx: CaseContext): Promise<Evidence> {
  return withFakeHost(ctx, async (host) => {
    const user = host.user("U1");
    assert(await host.context([user]), "a turn is open before completed messages arrive");
    const argsSentinel = "THINK_ARGS";
    const resultSentinel = "THINK_RESULT";
    const assistant = host.assistant([
      { type: "toolCall", id: "think-1", name: "think", arguments: { text: argsSentinel } },
      { type: "text", text: "T1" },
    ]);
    const result: FakeHostMessage = {
      role: "toolResult", toolCallId: "think-1", toolName: "think",
      content: [{ type: "text", text: resultSentinel }], isError: false, timestamp: host.timestamp(),
    };
    await host.fire({ type: "message_end", message: assistant });
    await host.fire({ type: "message_end", message: result });
    await host.fire({ type: "agent_end", messages: [user, assistant, result], willContinue: false });
    const rows = await durableRows(host.ctx, 2, "fake mixed assistant talk durable");
    assert.deepEqual(pairs(rows), [["user", "U1"], ["talk", "T1"]], "think arguments and results add no rows; normal talk in the same message is logged once");
    const durable = JSON.stringify([
      ...jsonlRecords(join(host.ctx.memory, "main")),
      ...jsonlRecords(join(host.ctx.memory, "tree")),
    ]);
    assert(!durable.includes(argsSentinel), "think arguments are absent from all main/tree JSONL records");
    assert(!durable.includes(resultSentinel), "think results are absent from all main/tree JSONL records");
    return { rows: pairs(rows), excluded: [argsSentinel, resultSentinel] };
  });
}

async function fakeSettleBounds(ctx: CaseContext): Promise<Evidence> {
  const { createOptChat } = ctx.lib.optchat;
  for (const settleTimeoutMs of [30_000, 0, Number.NaN]) {
    assert.throws(() => createOptChat({ settleTimeoutMs }), /settleTimeoutMs must be above 0 and below the host's 30000 ms handler limit/, `${settleTimeoutMs} is rejected before host registration`);
  }
  assert.doesNotThrow(() => createOptChat({ settleTimeoutMs: 29_999 }), "29999 remains below the host handler limit");
  return { rejected: ["30000", "0", "NaN"], accepted: 29_999 };
}

// ---------------------------------------------------------------------------
// Prefix admission per request dialect: real pi-ai encoders, fake host
// ---------------------------------------------------------------------------

interface Recorded {
  path: string;
  body: WireObject;
}

/**
 * A loopback provider for every dialect: records each request and holds its
 * stream open (headers, no events) until the client aborts or stop(). A held
 * compressor request keeps its leaf unfinished, so each run uses a fresh host.
 */
class WireRecorder {
  readonly requests: Recorded[] = [];
  readonly origin: string;
  /** The first request; rejects when a body is unreadable. */
  readonly arrived: Promise<Recorded>;
  private readonly arrive: (request: Recorded) => void;
  private readonly unreadable: (error: Error) => void;
  private readonly closers = new Set<() => void>();
  private readonly server: Bun.Server<undefined>;

  constructor() {
    const arrived = Promise.withResolvers<Recorded>();
    this.arrived = arrived.promise;
    this.arrive = arrived.resolve;
    this.unreadable = arrived.reject;
    // Observed here; every run awaits it within a step deadline.
    this.arrived.catch(() => {});
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (request) => this.handle(request) });
    this.origin = `http://127.0.0.1:${this.server.port}`;
  }

  async stop(): Promise<void> {
    for (const close of this.closers) close();
    this.closers.clear();
    await this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const recorded = { path: new URL(request.url).pathname, body: object((await request.json()) as Json, "recorded request body") };
      this.requests.push(recorded);
      this.arrive(recorded);
    } catch (error) {
      this.unreadable(error instanceof Error ? error : new Error(String(error)));
      return Response.json({ error: { message: "unreadable recorded request" } }, { status: 400 });
    }
    let open = true;
    return new Response(new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.closers.add(() => {
          if (!open) return;
          open = false;
          controller.close();
        });
      },
      cancel: () => {
        open = false;
      },
    }), { headers: SSE_HEADERS });
  }
}

type PrefixLayout = "chat-system" | "chat-developer" | "responses-instructions" | "responses-input" | "anthropic-system";
/** One change to the main payload's prefix, made in its onPayload before the host hook captures it. */
type PrefixEdit = "unchanged" | "cache-only" | "instructions" | "text" | "role" | "type" | "attribute" | "cache-like" | "extra";

const PREFIX_HOST = "OPTCHAT_IT_PREFIX_HOST: the host system prompt before the OptChat guide.";
const PREFIX_MAIN_USER = "OPTCHAT_IT_PREFIX_MAIN_USER: the main request.";
/** Over the 64-byte summary target: its talk leaf is each run's first compressor request. */
const PREFIX_TALK = `OPTCHAT_IT_PREFIX_TALK ${"main reply words that need a summary; ".repeat(3)}`.trim();
const PREFIX_EDIT = "OPTCHAT_IT_PREFIX_EDIT";
const PREFIX_TOOL = {
  name: "prefix_probe",
  description: "OPTCHAT_IT_PREFIX_TOOL: a tool the main request declares.",
  parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
};
const MESSAGE_REJECTS: readonly PrefixEdit[] = ["text", "role", "type", "attribute", "cache-like", "extra"];
const PREFIX_LAYOUTS: Record<PrefixLayout, {
  path: string;
  /** Role of every leading prefix message; none means the prompt sits in a head field. */
  role?: "system" | "developer";
  head?: "system" | "instructions";
  accept: PrefixEdit;
  reject: readonly PrefixEdit[];
}> = {
  "chat-system": { path: "/v1/chat/completions", role: "system", accept: "cache-only", reject: MESSAGE_REJECTS },
  "chat-developer": { path: "/v1/chat/completions", role: "developer", accept: "cache-only", reject: MESSAGE_REJECTS },
  "responses-instructions": { path: "/v1/responses", head: "instructions", accept: "unchanged", reject: ["instructions", "extra"] },
  "responses-input": { path: "/v1/responses", role: "developer", accept: "cache-only", reject: MESSAGE_REJECTS },
  "anthropic-system": {
    path: "/v1/messages",
    head: "system",
    accept: "cache-only",
    reject: ["text", "type", "attribute", "cache-like", "extra"],
  },
};

/**
 * A bundled model of the layout's dialect, routed to the recorder. Candidates
 * lack whenThinking, so reasoning cannot relocate the prompt between runs, and
 * keep tool sharing on; supportsDeveloperRole selects the OpenAI layout.
 */
function prefixModel(ctx: CaseContext, layout: PrefixLayout, origin: string): Model {
  const { getBundledModels } = ctx.lib;
  const plain = (candidate: Model): boolean => {
    const compat: unknown = candidate.compat;
    const field = (key: string): unknown => (compat !== null && typeof compat === "object" ? Reflect.get(compat, key) : undefined);
    return candidate.kind === undefined && candidate.reasoning && candidate.supportsTools !== false &&
      field("whenThinking") === undefined && field("disableReasoningWithTools") !== true;
  };
  if (layout === "anthropic-system") {
    const found = getBundledModels("anthropic").find((candidate): candidate is Model<"anthropic-messages"> =>
      candidate.api === "anthropic-messages" && plain(candidate));
    assert(found, "the catalog bundles a reasoning Anthropic Messages model");
    const { transport: _transport, ...model } = found;
    return { ...model, baseUrl: origin };
  }
  const supportsDeveloperRole = PREFIX_LAYOUTS[layout].role === "developer";
  if (layout === "chat-system" || layout === "chat-developer") {
    const found = getBundledModels("groq").find((candidate): candidate is Model<"openai-completions"> =>
      candidate.api === "openai-completions" && plain(candidate));
    assert(found, "the catalog bundles a reasoning Groq Chat Completions model");
    const { transport: _transport, ...model } = found;
    return { ...model, baseUrl: `${origin}/v1`, compat: { ...model.compat, supportsDeveloperRole } };
  }
  const found = getBundledModels("openai").find((candidate): candidate is Model<"openai-responses"> =>
    candidate.api === "openai-responses" && plain(candidate));
  assert(found, "the catalog bundles a reasoning OpenAI Responses model");
  const { transport: _transport, ...model } = found;
  return { ...model, baseUrl: `${origin}/v1`, compat: { ...model.compat, supportsDeveloperRole } };
}

/** The leading system/developer messages of Chat Completions messages or Responses input. */
function leadingPrefix(body: WireObject): { list: Json[]; count: number } {
  const list = Array.isArray(body.messages) ? body.messages : body.input;
  assert(Array.isArray(list), "an encoded request carries messages or input");
  let count = 0;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || (entry.role !== "system" && entry.role !== "developer")) break;
    count++;
  }
  return { list, count };
}

/** What prefix admission compares and copies, plus the destination suffix it must keep. */
interface PrefixParts {
  system: Json | undefined;
  instructions: Json | undefined;
  leading: Json[];
  suffix: Json[];
  tools: Json | undefined;
}

function prefixParts(body: WireObject): PrefixParts {
  const { list, count } = leadingPrefix(body);
  return { system: body.system, instructions: body.instructions, leading: list.slice(0, count), suffix: list.slice(count), tools: body.tools };
}

/** Apply one edit in place to the encoded main payload: Anthropic system blocks, leading messages or instructions. */
function editPrefix(payload: WireObject, edit: PrefixEdit): void {
  if (edit === "unchanged") return;
  if (edit === "instructions") {
    assert(typeof payload.instructions === "string", "the instructions layout encodes a string head");
    payload.instructions = `${payload.instructions} ${PREFIX_EDIT}`;
    return;
  }
  const { list, count } = Array.isArray(payload.system) ? { list: payload.system, count: payload.system.length } : leadingPrefix(payload);
  if (edit === "extra" && count === 0) {
    // A leading message beside an instructions head.
    list.unshift({ role: "developer", content: `${PREFIX_EDIT} extra message` });
    return;
  }
  assert(count > 0, `${edit} needs an encoded system prefix`);
  const entries = list.slice(0, count).map((entry, index) => object(entry, `prefix entry ${index}`));
  const last = entries[count - 1]!;
  const textKey = typeof last.text === "string" ? "text" : "content";
  assert(typeof last[textKey] === "string", "a prefix entry carries its text as one string");
  switch (edit) {
    case "cache-only":
      // Exactly the two cache metadata keys change; every other byte stays.
      for (const entry of entries) {
        if (entry.cache_control === undefined) entry.cache_control = { type: "ephemeral", ttl: "5m" };
        else delete entry.cache_control;
        entry.prompt_cache_breakpoint = { mode: "explicit" };
      }
      return;
    case "text":
      last[textKey] = `${last[textKey]} ${PREFIX_EDIT}`;
      return;
    case "role":
      last.role = last.role === "system" ? "developer" : "system";
      return;
    case "type":
      last.type = typeof last.type === "string" ? PREFIX_EDIT : "message";
      return;
    case "attribute":
      last.name = PREFIX_EDIT;
      return;
    case "cache-like":
      last.cache_breakpoint = { mode: "explicit" };
      return;
    case "extra":
      list.splice(count, 0, { ...last, [textKey]: `${PREFIX_EDIT} extra entry` });
      return;
  }
}

interface PrefixRun {
  /** The edited main payload as the host hook saw it; none for the local reference run. */
  captured: PrefixParts | undefined;
  compressor: PrefixParts;
}

/**
 * One fresh fake host: a short user opens the turn; with an edit, the real
 * encoder builds a tool-bearing main payload whose onPayload applies the edit,
 * fires the host hook and aborts, so nothing is sent; a long talk leaf then
 * makes the compressor encode its own request, which the recorder holds.
 * Without an edit nothing is captured: the compressor's local encoding.
 */
async function prefixRun(ctx: CaseContext, layout: PrefixLayout, edit: PrefixEdit | undefined): Promise<PrefixRun> {
  const { lib } = ctx;
  const recorder = new WireRecorder();
  try {
    const model = prefixModel(ctx, layout, recorder.origin);
    const systemPrompt = [PREFIX_HOST, lib.optchat.SYSTEM_BLOCK];
    // Closure results live on an object: control flow does not see callback assignments to locals.
    const seen: { captured?: PrefixParts; request?: Recorded } = {};
    await withFakeHost(ctx, async (host) => {
      assert(await host.context([host.user("U1")]), "a short user opens the turn without a compressor request");
      if (edit !== undefined) {
        const stop = new AbortController();
        const reply = await bounded("main payload encode", lib.completeSimple(model, {
          systemPrompt,
          messages: [{ role: "user", content: PREFIX_MAIN_USER, timestamp: host.timestamp() }],
          tools: [PREFIX_TOOL],
        }, {
          apiKey: FIXTURE_API_KEY,
          statefulResponses: false,
          // The compressor's effort: tools and the turn suffix are the only encoder inputs that differ.
          reasoning: lib.clampThinkingLevelForModel(model, lib.ThinkingLevel.Medium),
          signal: stop.signal,
          onPayload: async (payload) => {
            const main = object(payload as Json, "main payload");
            editPrefix(main, edit);
            seen.captured = prefixParts(object(JSON.parse(JSON.stringify(main)) as Json, "captured main payload"));
            await host.fire({ type: "before_provider_request", payload: main });
            stop.abort();
            return undefined;
          },
        }));
        assert.equal(reply.stopReason, "aborted", `the main payload reaches the host hook and is never sent: ${reply.errorMessage ?? ""}`);
      }
      await host.fire({ type: "message_end", message: host.assistant([{ type: "text", text: PREFIX_TALK }]) });
      seen.request = await bounded("compressor request", recorder.arrived);
      assert.deepEqual(recorder.requests.map((request) => request.path), [PREFIX_LAYOUTS[layout].path], "only the compressor request reaches the provider");
      return { layout, edit: edit ?? "local" };
    }, { model, systemPrompt });
    assert(seen.request, "the compressor request was recorded");
    return { captured: seen.captured, compressor: prefixParts(seen.request.body) };
  } finally {
    await recorder.stop();
  }
}

/**
 * The layout's local compressor encoding, then the cache-only (or identical)
 * capture that must replay exactly, then every semantic edit that must leave
 * the local encoding byte-for-byte.
 */
async function prefixLayoutCase(ctx: CaseContext, layout: PrefixLayout): Promise<Evidence> {
  const { SYSTEM_BLOCK } = ctx.lib.optchat;
  const spec = PREFIX_LAYOUTS[layout];
  const head = (parts: PrefixParts) => ({ system: parts.system, instructions: parts.instructions, leading: parts.leading });

  const local = (await prefixRun(ctx, layout, undefined)).compressor;
  const roles = local.leading.map((entry) => object(entry, "leading message").role);
  if (spec.role) assert(roles.length > 0 && roles.every((role) => role === spec.role), `${layout}: the prompt is ${spec.role} messages`);
  else assert.deepEqual(roles, [], `${layout}: no leading prompt messages`);
  assert.equal(Array.isArray(local.system), spec.head === "system", `${layout}: Anthropic system blocks only where expected`);
  assert.equal(typeof local.instructions === "string", spec.head === "instructions", `${layout}: Responses instructions only where expected`);
  const guide = [
    ...[...(Array.isArray(local.system) ? local.system : []), ...local.leading].map((entry) => {
      const value = object(entry, "prefix entry");
      return typeof value.text === "string" ? value.text : wireText(value);
    }),
    typeof local.instructions === "string" ? local.instructions : "",
  ].join("\n");
  assert(guide.includes(PREFIX_HOST) && guide.includes(SYSTEM_BLOCK), `${layout}: the local encoding carries the host prompt and the complete OptChat guide`);
  assert.equal(local.tools, undefined, `${layout}: the compressor's own encoding declares no tools`);
  assert(JSON.stringify(local.suffix).includes("Compaction: compress message"), `${layout}: the suffix is the compressor's own task`);

  const accepted = await prefixRun(ctx, layout, spec.accept);
  assert(accepted.captured, "the accepted run captured a main payload");
  assert.notEqual(accepted.captured.tools, undefined, `${layout}: the main payload declares its tools`);
  if (spec.accept === "cache-only") assert.notDeepEqual(head(accepted.captured), head(local), `${layout}: the capture differs in cache metadata`);
  assert.deepEqual(
    accepted.compressor,
    { ...accepted.captured, suffix: local.suffix },
    `${layout} ${spec.accept}: the exact captured prefix and tools replay; the compressor's own suffix survives`,
  );
  const outcomes: Evidence = { [spec.accept]: "accepted" };
  for (const edit of spec.reject) {
    const rejected = await prefixRun(ctx, layout, edit);
    assert(rejected.captured, `${edit}: the run captured a main payload`);
    assert.notEqual(rejected.captured.tools, undefined, `${layout} ${edit}: captured tools were available`);
    assert.notDeepEqual(head(rejected.captured), head(local), `${layout} ${edit}: the edit changes the captured prefix`);
    assert.deepEqual(rejected.compressor, local, `${layout} ${edit}: the local guide, suffix and tool-free encoding stay untouched`);
    outcomes[edit] = "rejected";
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Unit: capText (src/index.ts) and viewBlocks (src/cache.ts)
// ---------------------------------------------------------------------------

async function capTextUnit(ctx: CaseContext): Promise<Evidence> {
  const { capText } = ctx.lib.optchat;
  assert.equal(capText("", TOOL_CAP), "");
  assert.equal(capText("short", TOOL_CAP), "short");
  const exact = "e".repeat(TOOL_CAP);
  assert.equal(capText(exact, TOOL_CAP), exact, "a text exactly at the cap is unchanged");

  const tiny = capText("ab", 1);
  assert.equal(tiny, "a", "a cap smaller than the cut note keeps only the head, without a note");
  assert(tiny.length <= 1, "the plain head cut respects the cap");
  assert.equal(capText("abc", 0), "", "a zero cap keeps nothing");
  for (const [text, cap, expected] of [["😀b", 1, ""], ["a😀b", 2, "a"]] as const) {
    const cut = capText(text, cap);
    assert.equal(cut, expected, "a plain head cut drops a trailing high surrogate");
    assert(cut.length <= cap, "a surrogate-safe head cut respects the cap");
    assert(cut.isWellFormed(), "a small-cap cut never splits a surrogate pair");
  }

  let checked = 0;
  const check = (text: string, cap: number, label: string): void => {
    const result = capText(text, cap);
    const where = `${label}, cap ${cap}`;
    assert(result.length <= cap, `${where}: ${result.length} characters`);
    // The note reserves the widest count; a shorter count frees at most digits-1 characters, a surrogate fix 2 more.
    assert(result.length >= cap - String(text.length).length - 2, `${where}: ${result.length} characters wastes the cap`);
    const note = /\n\n\[(\d+) of (\d+) characters cut\]\n\n/.exec(result);
    assert(note, `${where}: the cut is noted`);
    const head = result.slice(0, note.index);
    const tail = result.slice(note.index + note[0].length);
    assert(text.startsWith(head) && text.endsWith(tail), `${where}: head and tail are the text's own ends`);
    assert(head.length > 0 && tail.length > 0, `${where}: both ends are kept`);
    assert(Math.abs(head.length - tail.length) <= 2, `${where}: head ${head.length} and tail ${tail.length} are balanced`);
    assert.equal(Number(note[2]), text.length, `${where}: the note gives the original length`);
    assert.equal(Number(note[1]), text.length - head.length - tail.length, `${where}: the note counts what was cut`);
    assert(result.isWellFormed(), `${where}: no surrogate pair is split`);
    checked++;
  };

  const ascii = `HEAD:${"abcdefghij".repeat(100)}:TAIL`;
  for (const cap of [128, 129, 200, 256, 504, ascii.length - 1]) check(ascii, cap, "ascii");
  assert.equal(capText(ascii, ascii.length), ascii);
  const emoji = "😀".repeat(600);
  const shapes: Array<[string, string]> = [
    ["emoji", emoji],
    ["odd prefix", `a${emoji}`],
    ["odd suffix", `${emoji}a`],
    ["mixed", `ab${"😀x".repeat(300)}b`],
  ];
  for (const [label, text] of shapes) {
    for (let cap = TOOL_CAP; cap <= TOOL_CAP + 64; cap++) check(text, cap, label);
  }
  return { checked };
}

async function viewBlocksUnit(ctx: CaseContext): Promise<Evidence> {
  const { viewBlocks, getBundledModels } = ctx.lib;
  const model = getBundledModels("anthropic").find((candidate) =>
    candidate.api === "anthropic-messages" && candidate.provider === "anthropic" &&
    candidate.baseUrl === "https://api.anthropic.com" &&
    candidate.compat && "officialEndpoint" in candidate.compat && candidate.compat.officialEndpoint === true &&
    candidate.input.length === 2 && candidate.input.includes("text") && candidate.input.includes("image"));
  assert(model, "an official image-capable Anthropic model is bundled");
  const rows = Array.from({ length: 13 }, (_, index) => `${index}+1|user: memory 🦊 e\u0301 漢字 ${"x".repeat(index * 100)}`);
  for (let count = 0; count <= rows.length; count++) {
    const view = `<chat>\n${rows.slice(0, count).map((row) => `${row}\n`).join("")}</chat>`;
    const blocks = viewBlocks(view, model);
    assert.equal(blocks.map((block) => block.text).join(""), view, "blocks preserve every source byte");
    const fullBlocks = Math.floor(count / 4);
    assert.equal(blocks.length, fullBlocks + 1, `${count} rows: whole four-line blocks plus trailing remainder/closing tag`);
    for (let index = 0; index < fullBlocks; index++) {
      const expected = `${index === 0 ? "<chat>\n" : ""}${rows.slice(index * 4, index * 4 + 4).join("\n")}\n`;
      assert.deepEqual(blocks[index], { type: "text", text: expected }, "four lines, independent of character count");
    }
    for (const block of blocks) {
      assert.deepEqual(Object.keys(block).sort(), ["text", "type"], "plain text until the provider adds cache metadata");
      assert(block.text.length > 0, "no empty blocks");
    }
  }
  for (const view of ["", `<chat>\n0+1|${"x".repeat(150_000)}\n</chat>`, "not a chat view"]) {
    assert.deepEqual(viewBlocks(view, model), [{ type: "text", text: view }], "unbroken lines and non-views are untouched");
  }
  const view = `<chat>\n${rows.join("\n")}\n</chat>`;
  assert(view.length < 50_000, "the 13-row view is below 50,000 UTF-16 units");
  assert.deepEqual(viewBlocks(view, undefined), [{ type: "text", text: view }], "an undefined model keeps a single block");
  assert.deepEqual(viewBlocks(view, { ...model, input: ["text"] }), [{ type: "text", text: view }], "a text-only Anthropic model keeps a single block");
  const first = viewBlocks(`<chat>\n${rows.slice(0, 8).join("\n")}\n</chat>`, model);
  const appended = viewBlocks(view, model);
  assert.deepEqual(appended.slice(0, 2), first.slice(0, 2), "appending rows retains every earlier whole block");
  return { rowCases: rows.length + 1, linesPerBlock: 4 };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const CASES: Record<CaseName, (ctx: CaseContext) => Promise<Evidence>> = {
  "fresh-turn-steering": freshTurnSteering,
  "thinking-exclusion": thinkingExclusion,
  "compressor-tool-refusal": compressorToolRefusal,
  "compressor-without-tools": compressorWithoutTools,
  "side-prefix-text-mismatch": sidePrefixTextMismatch,
  "reasoning-tools-compressor": (ctx) => reasoningToolsCompressor(ctx, {
    disableReasoningWithTools: true,
    reasoningDisableMode: "none-effort",
  }),
  "reasoning-tools-compressor-when-thinking": (ctx) => reasoningToolsCompressor(ctx, {
    disableReasoningWithTools: false,
    reasoningDisableMode: "none-effort",
    whenThinking: { disableReasoningWithTools: true, reasoningDisableMode: "none-effort" },
  }),
  "tool-cap-zoom": toolCapZoom,
  "lock-held": lockHeld,
  "missing-compressor": missingCompressor,
  "settle-timeout": settleTimeout,
  "abort-while-settling": abortWhileSettling,
  "legacy-flag": legacyFlag,
  "disabled-flag": (ctx) => disabledFlag(ctx, { flags: { optchat: false } }),
  "cli-optout": (ctx) => disabledFlag(ctx, { argv: ["--no-optchat"] }),
  "cli-optout-first": (ctx) => disabledFlag(ctx, { argv: ["--no-optchat", "--optchat"] }),
  "cli-optout-last": (ctx) => disabledFlag(ctx, { argv: ["--optchat", "--no-optchat"] }),
  "optout-invalid-config": (ctx) => disabledFlag(ctx, { argv: ["--no-optchat"], flags: { "optchat-model": "", "optchat-jobs": "0" } }),
  "subagent-default": (ctx) => disabledFlag(ctx, { taskDepth: 1 }),
  "subagent-shared-store": subagentSharedStore,
  "malformed-positive": (ctx) => configurationRejected(ctx, { optchat: "invalid" }, "optchat"),
  "malformed-optout": (ctx) => configurationRejected(ctx, { "no-optchat": "invalid" }, "no-optchat"),
  "malformed-config": (ctx) => configurationRejected(ctx, { "optchat-jobs": "0" }, "optchat-jobs"),
  "background-report": backgroundReport,
  "background-report-cold": backgroundReportCold,
  "aside": asideMessage,
  "fake-steering-batch": fakeSteeringBatch,
  "fake-late-agent-end": fakeLateAgentEnd,
  "fake-child-view": fakeChildView,
  "fake-ephemeral-recap": fakeEphemeralRecap,
  "fake-recap-spoof": fakeRecapSpoof,
  "fake-continuation": fakeContinuation,
  "fake-think-exclusion": fakeThinkExclusion,
  "fake-settle-bounds": fakeSettleBounds,
  "prefix-chat-system": (ctx) => prefixLayoutCase(ctx, "chat-system"),
  "prefix-chat-developer": (ctx) => prefixLayoutCase(ctx, "chat-developer"),
  "prefix-responses-instructions": (ctx) => prefixLayoutCase(ctx, "responses-instructions"),
  "prefix-responses-input": (ctx) => prefixLayoutCase(ctx, "responses-input"),
  "prefix-anthropic-system": (ctx) => prefixLayoutCase(ctx, "anthropic-system"),
  "fake-rejected-custom-image": fakeRejectedCustomImage,
  "cap-text": capTextUnit,
  "view-blocks": viewBlocksUnit,
};

function isCaseName(name: string): name is CaseName {
  return Object.hasOwn(CASE_TITLES, name);
}

async function runChild(name: string): Promise<void> {
  assert(isCaseName(name), `unknown integration case ${name}`);
  const root = process.env[ROOT_ENV];
  assert(root, `${ROOT_ENV} is required in the child`);
  const agentDir = join(root, "agent");
  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir, "the child runs with its private agent directory");
  const cwd = join(root, "workspace");
  // Before the first OMP import: pi-utils caches the cwd and reads cwd/.env at import time.
  process.chdir(cwd);
  const lib = await loadLibraries();
  const fixture = new Fixture();
  try {
    const evidence = await CASES[name]({ lib, fixture, cwd, agentDir, memory: join(root, "memory") });
    assert.deepEqual(fixture.failures.map((failure) => failure.message), [], "the fixture recorded no failures");
    console.log(`${RESULT_MARK}${JSON.stringify({ case: name, ok: true, evidence })}`);
  } finally {
    await fixture.stop();
  }
}

const childCase = process.env[CHILD_ENV];
if (childCase === undefined) {
  describe("OptChat real-host integration (one isolated Bun child per case)", () => {
    for (const name of Object.keys(CASE_TITLES).filter(isCaseName)) {
      test(CASE_TITLES[name], () => runIsolated(name), PARENT_TEST_MS);
    }
  });
} else {
  test(`isolated child: ${childCase}`, () => runChild(childCase), CHILD_TEST_MS);
}
