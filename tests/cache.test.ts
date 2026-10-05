import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { applyOptChatCache, viewBlocks, type OptChatCacheKind } from "../src/cache.ts";

type WireObject = Record<string, unknown>;
type WireMessage = WireObject & { role: string; content: WireObject[] };
type NativePayload = WireObject & { tools: WireObject[]; system: WireObject[]; messages: WireMessage[] };
type ResponsesPayload = WireObject & { input: WireObject[] };
type CacheKey = "cache_control" | "prompt_cache_breakpoint";

/** Every `labeledView`/`unlabeledView` row is exactly this many UTF-16 units, its newline included. */
const ROW_UNITS = 1_000;
/** Stable cuts of a fixed-row view longer than 100,000 units: the line end at or before 50k, 80k and 100k. */
const CUTS = [49_007, 79_007, 99_007];
const HOST_LONG: WireObject = { type: "ephemeral", ttl: "1h" };
const FIVE_MINUTES: WireObject = { type: "ephemeral", ttl: "5m" };
const EXPLICIT: WireObject = { mode: "explicit" };
const ENV_KEYS = ["PI_CACHE_RETENTION", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY"];

// pi-utils fills missing variables from dotenv files at import time, so every
// test starts from the known-active default and restores the outer values.
let savedEnv: Array<[string, string | undefined]> = [];

beforeEach(() => {
  savedEnv = ENV_KEYS.map((key): [string, string | undefined] => [key, process.env[key]]);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---- models -----------------------------------------------------------------

function anthropicModel(): Model<"anthropic-messages"> {
  const found = getBundledModels("anthropic").find(
    (candidate): candidate is Model<"anthropic-messages"> => candidate.api === "anthropic-messages" && candidate.kind === undefined,
  );
  if (!found) throw new Error("Installed catalog lacks an anthropic/anthropic-messages chat model");
  const { transport: _transport, ...model } = found;
  return { ...model, provider: "anthropic", baseUrl: "https://api.anthropic.com", compat: { ...found.compat, officialEndpoint: true } };
}

function openaiModel(): Model<"openai-responses"> {
  const found = getBundledModels("openai").find(
    (candidate): candidate is Model<"openai-responses"> => candidate.api === "openai-responses" && candidate.kind === undefined,
  );
  if (!found) throw new Error("Installed catalog lacks an openai/openai-responses chat model");
  const { transport: _transport, ...model } = found;
  return {
    ...model,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    compat: { ...found.compat, officialEndpoint: true, supportsPromptCacheBreakpoints: true, promptCacheBreakpointTtl: "30m" },
  };
}

function codexModel(): Model<"openai-codex-responses"> {
  const found = getBundledModels("openai-codex").find(
    (candidate): candidate is Model<"openai-codex-responses"> => candidate.api === "openai-codex-responses" && candidate.kind === undefined,
  );
  if (!found) throw new Error("Installed catalog lacks an openai-codex/openai-codex-responses chat model");
  const { transport: _transport, ...model } = found;
  return {
    ...model,
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    compat: { ...found.compat, supportsAllTurnsReasoningContext: true },
  };
}

/** Delete one field at runtime: a resolved record that lacks a field its type requires. */
function without<T extends object>(value: T, field: string): T {
  Reflect.deleteProperty(value, field);
  return value;
}

// ---- views ------------------------------------------------------------------

function fixedRowView(rows: number, head: (row: number) => string): string {
  let body = "";
  for (let row = 0; row < rows; row++) {
    const start = head(row);
    body += `${start}${"m".repeat(ROW_UNITS - 1 - start.length)}\n`;
  }
  return `<chat>\n${body}</chat>`;
}

/** Main-chat view: indexed rows. 40/60/90/110 rows give 0/1/2/3 stable cuts. */
function labeledView(rows: number): string {
  return fixedRowView(rows, (row) => `${row}+1|`);
}

/** Compressor context: the same `<chat>` frame without id labels. */
function unlabeledView(rows: number): string {
  return fixedRowView(rows, () => "summary line ");
}

/** Indexed view of astral, combining and CJK text, long enough for three stable cuts. */
function unicodeView(): string {
  let body = "";
  for (let row = 0; row < 1_400; row++) body += `${row}+1|${"memory 🦊 e\u0301 漢字 ".repeat(6)}\n`;
  return `<chat>\n${body}</chat>`;
}

function crlf(view: string): string {
  return view.replaceAll("\n", "\r\n");
}

const COMPACTOR_CONTEXT = unlabeledView(110);
const COMPACTOR_INSTRUCTION = "For scale, this line is exactly 512 bytes:\nscale\n\nCompress this message into one line, in at most 512 bytes:\nuser: keep 🦊 e\u0301 漢字";

// ---- wire fixtures ----------------------------------------------------------

function hostMarker(): WireObject {
  return { type: "ephemeral", ttl: "1h" };
}

function nativeViewBlocks(view: string): WireObject[] {
  return viewBlocks(view).map((block): WireObject => ({ type: block.type, text: block.text }));
}

function inputViewBlocks(view: string): WireObject[] {
  return viewBlocks(view).map((block): WireObject => ({ type: "input_text", text: block.text }));
}

/**
 * Anthropic Messages as the host encodes it with long retention: breakpoints on
 * the tool, both system blocks and the latest user message's end, and the view
 * message already split by `viewBlocks`. A `marker` returning undefined is
 * caching off.
 */
function nativePayload(view = labeledView(110), marker: () => WireObject | undefined = hostMarker): NativePayload {
  const marked = (block: WireObject): WireObject => {
    const cacheControl = marker();
    return cacheControl ? { ...block, cache_control: cacheControl } : block;
  };
  return {
    model: "claude-fixture",
    max_tokens: 8_192,
    stream: true,
    tools: [marked({ name: "zoom", description: "Read a memory node", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } })],
    system: [marked({ type: "text", text: "Host system prompt." }), marked({ type: "text", text: "Project instructions." })],
    messages: [
      { role: "user", content: nativeViewBlocks(view) },
      { role: "assistant", content: [{ type: "text", text: "Earlier answer." }] },
      { role: "user", content: [marked({ type: "text", text: "Current turn." })] },
    ],
  };
}

/** A fresh (unchained) OpenAI Responses request: view, prior answer, encrypted reasoning, current turn. */
function responsesPayload(view = labeledView(110)): ResponsesPayload {
  return {
    model: "gpt-fixture",
    instructions: "Host instructions.",
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "optchat-session",
    input: [
      { role: "user", content: inputViewBlocks(view) },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Earlier answer.", annotations: [] }] },
      { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "Private summary." }], encrypted_content: "opaque+/==\r\n🔒" },
      { role: "user", content: [{ type: "input_text", text: "Current request." }] },
    ],
  };
}

/** A Codex Responses request: the same input with a reasoning object that has no context yet. */
function codexPayload(view = labeledView(110)): ResponsesPayload {
  return {
    ...responsesPayload(view),
    model: "gpt-codex-fixture",
    store: false,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "high", summary: "auto" },
  };
}

// ---- wire access and assertions ---------------------------------------------

function isWireObject(value: unknown): value is WireObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a wire array");
  return value;
}

/** Walk a wire value by field names and array indexes, failing on any missing step. */
function at(value: unknown, ...path: Array<string | number>): unknown {
  let node = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(node) || key < 0 || key >= node.length) throw new Error(`No wire element at ${path.join(".")}`);
      node = node[key];
    } else {
      if (!isWireObject(node) || !Object.hasOwn(node, key)) throw new Error(`No wire field at ${path.join(".")}`);
      node = node[key];
    }
  }
  return node;
}

function blockTexts(content: unknown): string[] {
  return list(content).map((block) => {
    const text = isWireObject(block) ? block.text : undefined;
    if (typeof text !== "string") throw new Error("Expected a text content block");
    return text;
  });
}

function apply(payload: WireObject, model: Model, kind?: OptChatCacheKind): WireObject {
  const result = applyOptChatCache(payload, model, kind);
  if (!isWireObject(result)) throw new Error("applyOptChatCache returned a non-object payload");
  return result;
}

/** Every object carrying `key`, by owner path (`$` is the payload root), mapped to its marker. */
function markersAt(value: unknown, key: CacheKey): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${path}.${index}`));
      return;
    }
    if (!isWireObject(node)) return;
    for (const [name, child] of Object.entries(node)) {
      if (name === key) found[path] = child;
      else visit(child, `${path}.${name}`);
    }
  };
  visit(value, "$");
  return found;
}

function expectedMarkers(marker: WireObject, ...paths: string[]): Record<string, unknown> {
  return Object.fromEntries(paths.map((path) => [path, marker]));
}

/** Owner paths of the three view blocks that end at a stable cut. */
function viewCutPaths(field: "messages" | "input", message = 0): string[] {
  return [0, 1, 2].map((block) => `$.${field}.${message}.content.${block}`);
}

/** The joined text up to and including each block that carries `key`. */
function markedPrefixes(content: unknown, key: CacheKey): string[] {
  let prefix = "";
  const marked: string[] = [];
  for (const block of list(content)) {
    if (!isWireObject(block)) throw new Error("Expected a content block object");
    if (typeof block.text === "string") prefix += block.text;
    if (Object.hasOwn(block, key)) marked.push(prefix);
  }
  return marked;
}

/** Deep copy without any `key` field, to compare everything except cache metadata. */
function stripKey(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripKey(entry, key));
  if (!isWireObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key).map(([name, entry]) => [name, stripKey(entry, key)]));
}

function withoutField(value: WireObject, field: string): WireObject {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** The payload comes back as the same, unmodified reference. */
function expectPassthrough(payload: WireObject, model: Model, kind?: OptChatCacheKind): void {
  const before = structuredClone(payload);
  freezeDeep(payload);
  expect(applyOptChatCache(payload, model, kind)).toBe(payload);
  expect(payload).toEqual(before);
}

/** Positive control: the enabled adapter really changes this payload. */
function expectChanged(payload: WireObject, model: Model, kind?: OptChatCacheKind): WireObject {
  const result = apply(payload, model, kind);
  expect(result).not.toBe(payload);
  return result;
}

interface Adapter {
  name: string;
  list: "messages" | "input";
  textType: "text" | "input_text";
  model: () => Model;
  payload: (view?: string) => WireObject;
}

const ADAPTERS: Adapter[] = [
  { name: "native Anthropic", list: "messages", textType: "text", model: anthropicModel, payload: (view) => nativePayload(view) },
  { name: "OpenAI Responses", list: "input", textType: "input_text", model: openaiModel, payload: (view) => responsesPayload(view) },
  { name: "Codex Responses", list: "input", textType: "input_text", model: codexModel, payload: (view) => codexPayload(view) },
];

interface ModelCase {
  name: string;
  model: () => Model;
}

// ---- native Anthropic --------------------------------------------------------

describe("native Anthropic Messages", () => {
  test("a short view keeps the host's three head breakpoints and request end, each as a 5m marker", () => {
    const input = nativePayload("<chat>\n0+1|short memory\n</chat>");
    const host = ["$.tools.0", "$.system.0", "$.system.1", "$.messages.2.content.0"];
    expect(markersAt(input, "cache_control")).toEqual(expectedMarkers(HOST_LONG, ...host));
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...host));
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual({});
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  const BUDGET: Array<{ rows: number; cuts: number[]; head: string[] }> = [
    { rows: 40, cuts: [], head: ["$.tools.0", "$.system.0", "$.system.1"] },
    { rows: 60, cuts: [49_007], head: ["$.system.0", "$.system.1"] },
    { rows: 90, cuts: [49_007, 79_007], head: ["$.system.1"] },
    { rows: 110, cuts: [49_007, 79_007, 99_007], head: [] },
  ];

  test.each(BUDGET)("$rows rows: view cuts plus the end spend four markers, reducing host head breakpoints latest first", ({ rows, cuts, head }) => {
    const input = nativePayload(labeledView(rows));
    expect(input.messages[0].content).toHaveLength(cuts.length + 1);
    const result = apply(input, anthropicModel());
    const cutPaths = cuts.map((_, block) => `$.messages.0.content.${block}`);
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...head, ...cutPaths, "$.messages.2.content.0"));
    expect(markedPrefixes(at(result, "messages", 0, "content"), "cache_control").map((prefix) => prefix.length)).toEqual(cuts);
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("host root and stale block breakpoints are replaced, never accumulated", () => {
    const input = nativePayload();
    input.cache_control = { type: "ephemeral" };
    const view = input.messages[0].content;
    view[0] = { ...view[0], cache_control: hostMarker() };
    view[3] = { ...view[3], cache_control: hostMarker() };
    input.messages[1].content[0] = { ...input.messages[1].content[0], cache_control: hostMarker() };
    const result = apply(input, anthropicModel());
    expect(result).not.toHaveProperty("cache_control");
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...viewCutPaths("messages"), "$.messages.2.content.0"));
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("a root-only host breakpoint keeps caching on: the root is replaced by the view cuts and no end is invented", () => {
    const input = nativePayload(labeledView(110), () => undefined);
    input.cache_control = { type: "ephemeral" };
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...viewCutPaths("messages")));
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("without any host breakpoint caching is off and the payload is returned by reference", () => {
    expectChanged(nativePayload(), anthropicModel());
    const input = nativePayload(labeledView(110), () => undefined);
    expect(markersAt(input, "cache_control")).toEqual({});
    expectPassthrough(input, anthropicModel());
  });

  test("the latest existing host breakpoint stays the request end when unmarked continuation messages follow", () => {
    const input = nativePayload();
    input.messages.push(
      { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    );
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...viewCutPaths("messages"), "$.messages.2.content.0"));
    expect(at(result, "messages", 3)).toBe(input.messages[3]);
    expect(at(result, "messages", 4)).toBe(input.messages[4]);
  });
});

// ---- OpenAI Responses --------------------------------------------------------

describe("OpenAI Responses", () => {
  test.each([
    { name: "with", ttl: true, options: { mode: "explicit", ttl: "30m" } },
    { name: "without", ttl: false, options: { mode: "explicit" } },
  ])("explicit options $name a TTL: three view cuts plus the latest user end", ({ ttl, options }) => {
    const model = openaiModel();
    if (!ttl) without(model.compat, "promptCacheBreakpointTtl");
    const input = freezeDeep(responsesPayload());
    const result = apply(input, model);
    expect(result.prompt_cache_options).toEqual(options);
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.3.content.0"));
    expect(markedPrefixes(at(result, "input", 0, "content"), "prompt_cache_breakpoint").map((prefix) => prefix.length)).toEqual(CUTS);
    expect(markersAt(result, "cache_control")).toEqual({});
    expect(stripKey(withoutField(result, "prompt_cache_options"), "prompt_cache_breakpoint")).toEqual(input);
    expect(at(result, "input", 1)).toBe(input.input[1]);
    expect(at(result, "input", 2)).toBe(input.input[2]);
    expect(at(result, "input", 2, "encrypted_content")).toBe("opaque+/==\r\n🔒");
  });

  test("stale host breakpoints and cache options are replaced by the current view cuts and end", () => {
    const model = openaiModel();
    without(model.compat, "promptCacheBreakpointTtl");
    const input = responsesPayload();
    input.prompt_cache_options = { mode: "explicit", ttl: "30m" };
    const view = inputViewBlocks(labeledView(110));
    view[1] = { ...view[1], prompt_cache_breakpoint: { mode: "explicit" } };
    view[3] = { ...view[3], prompt_cache_breakpoint: { mode: "explicit" } };
    input.input[0] = { role: "user", content: view };
    input.input.splice(1, 0, { role: "user", content: [{ type: "input_text", text: "Earlier question.", prompt_cache_breakpoint: { mode: "explicit" } }] });
    input.input[4] = { role: "user", content: [{ type: "input_text", text: "Current request.", prompt_cache_breakpoint: { mode: "explicit" } }] };
    const result = apply(input, model);
    expect(result.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.4.content.0"));
    expect(at(result, "input", 1, "content", 0)).toEqual({ type: "input_text", text: "Earlier question." });
    expect(stripKey(withoutField(result, "prompt_cache_options"), "prompt_cache_breakpoint")).toEqual(stripKey(withoutField(input, "prompt_cache_options"), "prompt_cache_breakpoint"));
  });

  const FINAL_BLOCKS: Array<{ name: string; block: WireObject }> = [
    { name: "text", block: { type: "input_text", text: "Final text 🦊" } },
    { name: "image", block: { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=", detail: "auto" } },
    { name: "file", block: { type: "input_file", filename: "notes.txt", file_data: "data:text/plain;base64,bm90ZXM=" } },
  ];

  test.each(FINAL_BLOCKS)("the request end is the latest user message's final $name block despite later assistant and reasoning items", ({ block }) => {
    const input = responsesPayload();
    input.input[3] = { role: "user", content: [{ type: "input_text", text: "Compare these:" }, block] };
    input.input.push(
      { type: "reasoning", id: "rs_later", summary: [], encrypted_content: "opaque-later" },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Answer after the latest user turn.", annotations: [] }] },
    );
    const result = apply(input, openaiModel());
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.3.content.1"));
    expect(at(result, "input", 3, "content", 1)).toEqual({ ...block, prompt_cache_breakpoint: EXPLICIT });
    expect(at(result, "input", 4)).toBe(input.input[4]);
    expect(at(result, "input", 5)).toBe(input.input[5]);
  });

  test("a continuation and PI_CACHE_RETENTION=none are returned by reference; short and long retention stay active", () => {
    const chained = responsesPayload();
    expectChanged(chained, openaiModel());
    chained.previous_response_id = "resp_previous";
    expectPassthrough(chained, openaiModel());
    for (const retention of ["short", "long"]) {
      process.env.PI_CACHE_RETENTION = retention;
      expectChanged(responsesPayload(), openaiModel());
    }
    process.env.PI_CACHE_RETENTION = "none";
    expectPassthrough(responsesPayload(), openaiModel());
  });

  test.each([
    { name: "store true with a 24h retention", fields: { store: true, prompt_cache_retention: "24h" } },
    { name: "store false with in-memory retention", fields: { store: false, prompt_cache_retention: "in_memory" } },
    { name: "neither field", fields: {} },
  ])("$name: store and prompt_cache_retention pass through as raw wire values", ({ fields }) => {
    const input: WireObject = freezeDeep({ ...responsesPayload(), ...fields });
    const result = expectChanged(input, openaiModel());
    expect(Object.keys(markersAt(result, "prompt_cache_breakpoint"))).toHaveLength(4);
    for (const field of ["store", "prompt_cache_retention"]) {
      expect(Object.hasOwn(result, field)).toBe(Object.hasOwn(input, field));
      expect(result[field]).toBe(input[field]);
    }
  });
});

// ---- Codex Responses ---------------------------------------------------------

describe("Codex Responses", () => {
  test("asks for all_turns reasoning and shares every other field and the input by reference", () => {
    const input = codexPayload();
    const result = expectChanged(input, codexModel());
    expect(result.reasoning).toEqual({ effort: "high", summary: "auto", context: "all_turns" });
    expect(result.reasoning).not.toBe(input.reasoning);
    expect(input.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(Object.keys(result)).toEqual(Object.keys(input));
    for (const [field, value] of Object.entries(input)) {
      if (field !== "reasoning") expect(result[field]).toBe(value);
    }
    expect(result.input).toBe(input.input);
    expect(at(result, "input", 2)).toBe(input.input[2]);
    expect(at(result, "input", 2, "summary")).toBe(at(input, "input", 2, "summary"));
    expect(at(result, "input", 2, "encrypted_content")).toBe("opaque+/==\r\n🔒");
    expect(result).not.toHaveProperty("prompt_cache_options");
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual({});
    expect(markersAt(result, "cache_control")).toEqual({});
  });

  test.each([
    { name: "all_turns", context: "all_turns" },
    { name: "another host value", context: "current_turn" },
    { name: "null", context: null },
  ])("an existing reasoning.context ($name) is left to the host", ({ context }) => {
    const input = codexPayload();
    expectChanged(input, codexModel());
    input.reasoning = { effort: "high", summary: "auto", context };
    expectPassthrough(input, codexModel());
  });

  test.each([
    { name: "absent", set: (payload: WireObject) => without(payload, "reasoning") },
    { name: "null", set: (payload: WireObject) => Object.assign(payload, { reasoning: null }) },
    { name: "a string", set: (payload: WireObject) => Object.assign(payload, { reasoning: "high" }) },
    { name: "an array", set: (payload: WireObject) => Object.assign(payload, { reasoning: [{ effort: "high" }] }) },
  ])("a reasoning field that is $name is left to the host", ({ set }) => {
    const input = codexPayload();
    expectChanged(input, codexModel());
    set(input);
    expectPassthrough(input, codexModel());
  });

  test("a continuation and non-view inputs are returned by reference", () => {
    const chained = codexPayload();
    expectChanged(chained, codexModel());
    chained.previous_response_id = "resp_previous";
    expectPassthrough(chained, codexModel());
    expectPassthrough(codexPayload(unlabeledView(110)), codexModel());
    expectPassthrough(codexPayload(crlf(labeledView(110))), codexModel());
  });

  test("PI_CACHE_RETENTION=none does not disable the reasoning-context request", () => {
    process.env.PI_CACHE_RETENTION = "none";
    const result = expectChanged(codexPayload(), codexModel());
    expect(result.reasoning).toEqual({ effort: "high", summary: "auto", context: "all_turns" });
  });
});

// ---- provider gates ----------------------------------------------------------

describe("provider gates", () => {
  const NATIVE_REJECTED: ModelCase[] = [
    { name: "a third-party provider on the official URL", model: () => ({ ...anthropicModel(), provider: "openrouter" }) },
    { name: "a gateway base URL", model: () => ({ ...anthropicModel(), baseUrl: "https://gateway.example/anthropic" }) },
    { name: "a hostname lookalike", model: () => ({ ...anthropicModel(), baseUrl: "https://api.anthropic.com.evil.example" }) },
    { name: "a userinfo lookalike", model: () => ({ ...anthropicModel(), baseUrl: "https://api.anthropic.com@evil.example" }) },
    { name: "an insecure origin", model: () => ({ ...anthropicModel(), baseUrl: "http://api.anthropic.com" }) },
    { name: "an invalid URL", model: () => ({ ...anthropicModel(), baseUrl: "not a url" }) },
    { name: "the pi-native transport", model: () => ({ ...anthropicModel(), transport: "pi-native" }) },
    {
      name: "officialEndpoint false",
      model: () => {
        const model = anthropicModel();
        return { ...model, compat: { ...model.compat, officialEndpoint: false } };
      },
    },
    {
      name: "a missing officialEndpoint",
      model: () => {
        const model = anthropicModel();
        without(model.compat, "officialEndpoint");
        return model;
      },
    },
    { name: "missing compat", model: () => without(anthropicModel(), "compat") },
  ];

  test.each(NATIVE_REJECTED)("native Anthropic leaves $name to the host", ({ model }) => {
    const payload = nativePayload();
    expectChanged(payload, anthropicModel());
    expectPassthrough(payload, model());
  });

  test.each([
    { name: "the bare official origin", baseUrl: "https://api.anthropic.com" },
    { name: "an official path", baseUrl: "https://api.anthropic.com/v1" },
    { name: "the empty catalog default", baseUrl: "" },
  ])("native Anthropic caches $name", ({ baseUrl }) => {
    expectChanged(nativePayload(), { ...anthropicModel(), baseUrl });
  });

  test.each([
    { name: "an ANTHROPIC_BASE_URL proxy", key: "ANTHROPIC_BASE_URL", value: "https://proxy.example/anthropic" },
    { name: "an insecure ANTHROPIC_BASE_URL", key: "ANTHROPIC_BASE_URL", value: "http://api.anthropic.com" },
    { name: "Foundry 1", key: "CLAUDE_CODE_USE_FOUNDRY", value: "1" },
    { name: "Foundry true", key: "CLAUDE_CODE_USE_FOUNDRY", value: "true" },
    { name: "Foundry YES", key: "CLAUDE_CODE_USE_FOUNDRY", value: "YES" },
    { name: "Foundry padded on", key: "CLAUDE_CODE_USE_FOUNDRY", value: " on " },
  ])("native Anthropic leaves an effective-endpoint redirect ($name) to the host", ({ key, value }) => {
    const payload = nativePayload();
    expectChanged(payload, anthropicModel());
    process.env[key] = value;
    expectPassthrough(payload, anthropicModel());
  });

  test.each([
    { name: "an official ANTHROPIC_BASE_URL", key: "ANTHROPIC_BASE_URL", value: "https://api.anthropic.com/" },
    { name: "a blank ANTHROPIC_BASE_URL", key: "ANTHROPIC_BASE_URL", value: "   " },
    { name: "Foundry 0", key: "CLAUDE_CODE_USE_FOUNDRY", value: "0" },
    { name: "Foundry false", key: "CLAUDE_CODE_USE_FOUNDRY", value: "false" },
    { name: "Foundry empty", key: "CLAUDE_CODE_USE_FOUNDRY", value: "" },
  ])("native Anthropic still caches with $name", ({ key, value }) => {
    process.env[key] = value;
    expectChanged(nativePayload(), anthropicModel());
  });

  const RESPONSES_REJECTED: ModelCase[] = [
    { name: "a third-party provider on the official URL", model: () => ({ ...openaiModel(), provider: "openrouter" }) },
    { name: "a gateway base URL", model: () => ({ ...openaiModel(), baseUrl: "https://gateway.example/openai/v1" }) },
    { name: "a hostname lookalike", model: () => ({ ...openaiModel(), baseUrl: "https://api.openai.com.evil.example/v1" }) },
    { name: "a userinfo lookalike", model: () => ({ ...openaiModel(), baseUrl: "https://api.openai.com@evil.example/v1" }) },
    { name: "an insecure origin", model: () => ({ ...openaiModel(), baseUrl: "http://api.openai.com/v1" }) },
    { name: "an invalid URL", model: () => ({ ...openaiModel(), baseUrl: "api.openai.com/v1" }) },
    { name: "an empty base URL", model: () => ({ ...openaiModel(), baseUrl: "" }) },
    { name: "the pi-native transport", model: () => ({ ...openaiModel(), transport: "pi-native" }) },
    {
      name: "supportsPromptCacheBreakpoints false",
      model: () => {
        const model = openaiModel();
        return { ...model, compat: { ...model.compat, supportsPromptCacheBreakpoints: false } };
      },
    },
    {
      name: "a missing supportsPromptCacheBreakpoints",
      model: () => {
        const model = openaiModel();
        without(model.compat, "supportsPromptCacheBreakpoints");
        return model;
      },
    },
    { name: "missing compat", model: () => without(openaiModel(), "compat") },
    { name: "the Chat Completions API", model: () => ({ ...openaiModel(), api: "openai-completions" }) },
    { name: "the Azure Responses API", model: () => ({ ...openaiModel(), api: "azure-openai-responses" }) },
  ];

  test.each(RESPONSES_REJECTED)("OpenAI Responses leaves $name to the host", ({ model }) => {
    const payload = responsesPayload();
    expectChanged(payload, openaiModel());
    expectPassthrough(payload, model());
  });

  test.each([
    { name: "the /v1 base URL", baseUrl: "https://api.openai.com/v1" },
    { name: "the bare official origin", baseUrl: "https://api.openai.com" },
  ])("OpenAI Responses caches $name", ({ baseUrl }) => {
    expectChanged(responsesPayload(), { ...openaiModel(), baseUrl });
  });

  test("OpenAI Responses supports explicit caching even when officialEndpoint is false", () => {
    const model = openaiModel();
    model.compat.officialEndpoint = false;
    const result = expectChanged(responsesPayload(), model);
    expect(result.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.3.content.0"));
  });

  const CODEX_REJECTED: ModelCase[] = [
    { name: "a non-Codex provider on the official URL", model: () => ({ ...codexModel(), provider: "openai" }) },
    { name: "the OpenAI API origin", model: () => ({ ...codexModel(), baseUrl: "https://api.openai.com/v1" }) },
    { name: "the bare chatgpt.com origin", model: () => ({ ...codexModel(), baseUrl: "https://chatgpt.com" }) },
    { name: "a path-prefix lookalike", model: () => ({ ...codexModel(), baseUrl: "https://chatgpt.com/backend-api-evil" }) },
    { name: "a hostname lookalike", model: () => ({ ...codexModel(), baseUrl: "https://chatgpt.com.evil.example/backend-api" }) },
    { name: "a userinfo lookalike", model: () => ({ ...codexModel(), baseUrl: "https://chatgpt.com@evil.example/backend-api" }) },
    { name: "an insecure origin", model: () => ({ ...codexModel(), baseUrl: "http://chatgpt.com/backend-api" }) },
    { name: "an invalid URL", model: () => ({ ...codexModel(), baseUrl: "not a url" }) },
    { name: "the pi-native transport", model: () => ({ ...codexModel(), transport: "pi-native" }) },
    {
      name: "supportsAllTurnsReasoningContext false",
      model: () => {
        const model = codexModel();
        return { ...model, compat: { ...model.compat, supportsAllTurnsReasoningContext: false } };
      },
    },
    {
      name: "a missing supportsAllTurnsReasoningContext",
      model: () => {
        const model = codexModel();
        without(model.compat, "supportsAllTurnsReasoningContext");
        return model;
      },
    },
    { name: "missing compat", model: () => without(codexModel(), "compat") },
  ];

  test.each(CODEX_REJECTED)("Codex Responses leaves $name to the host", ({ model }) => {
    const payload = codexPayload();
    expectChanged(payload, codexModel());
    expectPassthrough(payload, model());
  });

  test.each([
    { name: "the official base URL", baseUrl: "https://chatgpt.com/backend-api" },
    { name: "a trailing slash", baseUrl: "https://chatgpt.com/backend-api/" },
    { name: "a descendant path", baseUrl: "https://chatgpt.com/backend-api/codex" },
    { name: "the empty catalog default", baseUrl: "" },
  ])("Codex Responses caches $name", ({ baseUrl }) => {
    expectChanged(codexPayload(), { ...codexModel(), baseUrl });
  });
});

// ---- view admission ----------------------------------------------------------

describe("view admission", () => {
  test.each(ADAPTERS)("$name rejects unlabeled and CRLF chat views by reference", (adapter) => {
    expectChanged(adapter.payload(labeledView(110)), adapter.model());
    expectPassthrough(adapter.payload(unlabeledView(110)), adapter.model());
    expectPassthrough(adapter.payload(crlf(labeledView(110))), adapter.model());
  });

  test.each(ADAPTERS)("$name ignores a view in a later message or after a leading block", (adapter) => {
    expectChanged(adapter.payload(), adapter.model());
    const laterMessage = adapter.payload();
    list(laterMessage[adapter.list]).unshift({ role: "user", content: [{ type: adapter.textType, text: "Actual user content before the pasted view." }] });
    expectPassthrough(laterMessage, adapter.model());
    const laterBlock = adapter.payload();
    list(at(laterBlock, adapter.list, 0, "content")).unshift({ type: adapter.textType, text: "A quoted transcript follows:\n" });
    expectPassthrough(laterBlock, adapter.model());
  });

  test("native: a later pasted view gets no prefix breakpoints, only the host's request end", () => {
    const input = nativePayload();
    const pasted = nativeViewBlocks(labeledView(110));
    expect(pasted).toHaveLength(4);
    pasted[3] = { ...pasted[3], cache_control: hostMarker() };
    input.messages[2] = { role: "user", content: pasted };
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...viewCutPaths("messages"), "$.messages.2.content.3"));
    expect(blockTexts(at(result, "messages", 2, "content"))).toEqual(blockTexts(pasted));
  });

  test("Responses: a later pasted view gets no prefix breakpoints, only the request end", () => {
    const input = responsesPayload();
    const pasted = inputViewBlocks(labeledView(110));
    expect(pasted).toHaveLength(4);
    input.input[3] = { role: "user", content: pasted };
    const result = apply(input, openaiModel());
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.3.content.3"));
    expect(blockTexts(at(result, "input", 3, "content"))).toEqual(blockTexts(pasted));
  });

  test("Codex: a later pasted view leaves the input untouched", () => {
    const input = codexPayload();
    input.input[3] = { role: "user", content: inputViewBlocks(labeledView(110)) };
    const result = apply(input, codexModel());
    expect(result.input).toBe(input.input);
    expect(result.reasoning).toEqual({ effort: "high", summary: "auto", context: "all_turns" });
  });

  test("Responses and Codex accept system and developer preambles before the view and keep them by reference", () => {
    const preamble = (): WireObject[] => [
      { role: "system", content: [{ type: "input_text", text: "System bytes\r\n" }] },
      { role: "developer", content: [{ type: "input_text", text: "Developer bytes 🦊" }] },
    ];
    const responses = responsesPayload();
    responses.input.unshift(...preamble());
    const result = apply(responses, openaiModel());
    expect(at(result, "input", 0)).toBe(responses.input[0]);
    expect(at(result, "input", 1)).toBe(responses.input[1]);
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input", 2), "$.input.5.content.0"));
    const codex = codexPayload();
    codex.input.unshift(...preamble());
    const codexResult = apply(codex, codexModel());
    expect(codexResult.input).toBe(codex.input);
    expect(codexResult.reasoning).toEqual({ effort: "high", summary: "auto", context: "all_turns" });
  });
});

// ---- compactor views ---------------------------------------------------------

describe("compactor views", () => {
  // The compressor sends one user message: `viewBlocks(context)` plus a separate instruction block.
  test("native: the unlabeled context and its separate instruction keep their bytes; cuts and the host end are marked", () => {
    const input: NativePayload = {
      model: "claude-fixture",
      max_tokens: 8_192,
      stream: true,
      tools: [],
      system: [{ type: "text", text: "Compressor prompt.", cache_control: hostMarker() }],
      messages: [{
        role: "user",
        content: [...nativeViewBlocks(COMPACTOR_CONTEXT), { type: "text", text: COMPACTOR_INSTRUCTION, cache_control: hostMarker() }],
      }],
    };
    expectPassthrough(input, anthropicModel());
    const result = apply(input, anthropicModel(), "compactor");
    const content = at(result, "messages", 0, "content");
    const texts = blockTexts(content);
    expect(texts).toHaveLength(5);
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...viewCutPaths("messages"), "$.messages.0.content.4"));
    expect(Buffer.from(texts.slice(0, 4).join("")).equals(Buffer.from(COMPACTOR_CONTEXT))).toBe(true);
    expect(texts[4]).toBe(COMPACTOR_INSTRUCTION);
    expect(markedPrefixes(content, "cache_control").map((prefix) => prefix.length)).toEqual([...CUTS, COMPACTOR_CONTEXT.length + COMPACTOR_INSTRUCTION.length]);
    expect(at(result, "messages", 0, "content", 3)).toBe(input.messages[0].content[3]);
  });

  test("Responses: the unlabeled context keeps its bytes; cuts and the final instruction block are marked", () => {
    const input: ResponsesPayload = {
      model: "gpt-fixture",
      instructions: "Compressor prompt.",
      stream: true,
      input: [{ role: "user", content: [...inputViewBlocks(COMPACTOR_CONTEXT), { type: "input_text", text: COMPACTOR_INSTRUCTION }] }],
    };
    expectPassthrough(input, openaiModel());
    const result = apply(input, openaiModel(), "compactor");
    const texts = blockTexts(at(result, "input", 0, "content"));
    expect(texts).toHaveLength(5);
    expect(result.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.0.content.4"));
    expect(Buffer.from(texts.slice(0, 4).join("")).equals(Buffer.from(COMPACTOR_CONTEXT))).toBe(true);
    expect(texts[4]).toBe(COMPACTOR_INSTRUCTION);
  });

  test("Codex: the unlabeled context admits the reasoning-context request with the input shared by reference", () => {
    const input: ResponsesPayload = {
      model: "gpt-codex-fixture",
      instructions: "Compressor prompt.",
      store: false,
      stream: true,
      reasoning: { effort: "medium", summary: "auto" },
      input: [{ role: "user", content: [...inputViewBlocks(COMPACTOR_CONTEXT), { type: "input_text", text: COMPACTOR_INSTRUCTION }] }],
    };
    expectPassthrough(input, codexModel());
    const result = apply(input, codexModel(), "compactor");
    expect(result.input).toBe(input.input);
    expect(result.reasoning).toEqual({ effort: "medium", summary: "auto", context: "all_turns" });
  });
});

// ---- stable prefixes ---------------------------------------------------------

describe("stable cache prefixes", () => {
  const PREFIX_CASES: Array<{ name: string; key: CacheKey; field: "messages" | "input"; model: () => Model; payload: (view: string) => WireObject }> = [
    { name: "native Anthropic", key: "cache_control", field: "messages", model: anthropicModel, payload: (view) => nativePayload(view) },
    { name: "OpenAI Responses", key: "prompt_cache_breakpoint", field: "input", model: openaiModel, payload: (view) => responsesPayload(view) },
  ];

  test.each(PREFIX_CASES)("$name keeps all three marked view prefixes byte-identical when memory is appended", ({ key, field, model, payload }) => {
    const original = labeledView(110);
    const appended = labeledView(140);
    expect(appended.startsWith(original.slice(0, -"</chat>".length))).toBe(true);
    const before = markedPrefixes(at(apply(payload(original), model()), field, 0, "content"), key);
    const after = markedPrefixes(at(apply(payload(appended), model()), field, 0, "content"), key);
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(3);
    expect(before.map((prefix) => prefix.length)).toEqual(CUTS);
    expect(after.map((prefix) => prefix.length)).toEqual(CUTS);
    expect(before).toEqual(CUTS.map((cut) => original.slice(0, cut)));
    expect(after).toEqual(before);
  });
});

// ---- byte fidelity -----------------------------------------------------------

describe("byte fidelity", () => {
  test("viewBlocks splits astral, combining and CJK text only after line ends and joins to identical UTF-8 bytes", () => {
    const view = unicodeView();
    const parts = viewBlocks(view);
    expect(parts).toHaveLength(4);
    for (const part of parts.slice(0, -1)) expect(part.text.endsWith("\n")).toBe(true);
    expect(Buffer.from(parts.map((part) => part.text).join("")).equals(Buffer.from(view))).toBe(true);
  });

  test("viewBlocks keeps a CRLF view lossless and never separates a CR from its LF", () => {
    const view = crlf(labeledView(110));
    const parts = viewBlocks(view);
    expect(parts).toHaveLength(4);
    for (const part of parts.slice(0, -1)) expect(part.text.endsWith("\r\n")).toBe(true);
    expect(Buffer.compare(Buffer.from(parts.map((part) => part.text).join("")), Buffer.from(view))).toBe(0);
  });

  test("native: Unicode view blocks and a separate trailing text block keep their exact UTF-8 bytes", () => {
    const view = unicodeView();
    const trailing: WireObject = { type: "text", text: "Trailing note 🦊 e\u0301 漢字\r\n" };
    const input = nativePayload(view);
    input.messages[0] = { role: "user", content: [...nativeViewBlocks(view), trailing] };
    const result = apply(input, anthropicModel());
    const texts = blockTexts(at(result, "messages", 0, "content"));
    expect(texts).toHaveLength(5);
    expect(Buffer.from(texts.slice(0, 4).join("")).equals(Buffer.from(view))).toBe(true);
    expect(Buffer.compare(Buffer.from(texts.join("")), Buffer.from(`${view}Trailing note 🦊 e\u0301 漢字\r\n`))).toBe(0);
    expect(at(result, "messages", 0, "content", 4)).toBe(trailing);
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...viewCutPaths("messages"), "$.messages.2.content.0"));
  });

  test("Responses: Unicode view blocks and a separate trailing text block keep their exact UTF-8 bytes", () => {
    const view = unicodeView();
    const trailing: WireObject = { type: "input_text", text: "Trailing note 🦊 e\u0301 漢字\r\n" };
    const input = responsesPayload(view);
    input.input[0] = { role: "user", content: [...inputViewBlocks(view), trailing] };
    const result = apply(input, openaiModel());
    const texts = blockTexts(at(result, "input", 0, "content"));
    expect(texts).toHaveLength(5);
    expect(Buffer.from(texts.slice(0, 4).join("")).equals(Buffer.from(view))).toBe(true);
    expect(Buffer.compare(Buffer.from(texts.join("")), Buffer.from(`${view}Trailing note 🦊 e\u0301 漢字\r\n`))).toBe(0);
    expect(at(result, "input", 0, "content", 4)).toBe(trailing);
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.3.content.0"));
  });
});

// ---- frozen inputs -----------------------------------------------------------

describe("frozen inputs", () => {
  test("native: a deep-frozen active payload is copied on write and untouched objects stay shared", () => {
    const input = freezeDeep(nativePayload());
    const before = structuredClone(input);
    const result = apply(input, anthropicModel());
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(markersAt(input, "cache_control")).toEqual(expectedMarkers(HOST_LONG, "$.tools.0", "$.system.0", "$.system.1", "$.messages.2.content.0"));
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, ...viewCutPaths("messages"), "$.messages.2.content.0"));
    expect(at(result, "messages", 0)).not.toBe(input.messages[0]);
    expect(at(result, "messages", 0, "content", 3)).toBe(input.messages[0].content[3]);
    expect(at(result, "messages", 1)).toBe(input.messages[1]);
    expect(at(result, "tools", 0, "input_schema")).toBe(at(input, "tools", 0, "input_schema"));
  });

  test("Responses: a deep-frozen active payload is copied on write and reasoning stays shared", () => {
    const input = freezeDeep(responsesPayload());
    const before = structuredClone(input);
    const result = apply(input, openaiModel());
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(input).not.toHaveProperty("prompt_cache_options");
    expect(result.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(markersAt(input, "prompt_cache_breakpoint")).toEqual({});
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.3.content.0"));
    expect(at(result, "input", 0, "content", 3)).toBe(at(input, "input", 0, "content", 3));
    expect(at(result, "input", 1)).toBe(input.input[1]);
    expect(at(result, "input", 2)).toBe(input.input[2]);
    expect(result.include).toBe(input.include);
  });

  test("Codex: a deep-frozen active payload gets a new reasoning container and keeps its input", () => {
    const input = freezeDeep(codexPayload());
    const before = structuredClone(input);
    const result = apply(input, codexModel());
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(input.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(result.reasoning).toEqual({ effort: "high", summary: "auto", context: "all_turns" });
    expect(result.reasoning).not.toBe(input.reasoning);
    expect(result.input).toBe(input.input);
    expect(at(result, "input", 2)).toBe(input.input[2]);
    expect(at(result, "input", 2, "summary")).toBe(at(input, "input", 2, "summary"));
    expect(at(result, "input", 2, "encrypted_content")).toBe("opaque+/==\r\n🔒");
  });
});
