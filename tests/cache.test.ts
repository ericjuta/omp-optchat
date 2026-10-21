import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { applyOptChatCache, OptChatCacheCoordinator, viewBlocks, viewPartition } from "../src/cache.ts";
import { SYSTEM_BLOCK } from "../src/index.ts";
import {
  ALL_GATES_OFF,
  encodeMainRequest,
  FIRST_MERGED_LINE,
  hasNotice,
  Harness,
  RULE_ADDED,
  RULE_TEXT,
  SEED_TEXTS,
  SMALL_NODES,
  talk,
  until,
} from "./helpers/system1-chat.ts";

type WireObject = Record<string, unknown>;
type WireMessage = WireObject & { role: string; content: WireObject[] };
type NativePayload = WireObject & { tools: WireObject[]; system: WireObject[]; messages: WireMessage[] };
type ResponsesPayload = WireObject & { input: WireObject[] };
type CacheKey = "cache_control" | "prompt_cache_breakpoint";

/** Every `labeledView`/`unlabeledView` row is exactly this many UTF-16 units, its newline included. */
const ROW_UNITS = 1_000;
/** OpenAI's stable cuts for fixed-row views over 100,000 units: line ends at or before 50k, 80k and 100k. */
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

/** Main-chat view: indexed rows. OpenAI gives 0/1/2/3 cuts at 40/60/90/110 rows; native groups every four rows. */
function labeledView(rows: number): string {
  return fixedRowView(rows, (row) => `${row}+1|`);
}

/** malformed: rows without id labels */
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

const COMPACTOR_CONTEXT = labeledView(110);
const COMPACTOR_INSTRUCTION = "For scale, this line is exactly 512 bytes:\nscale\n\nCompress this message into one line, in at most 512 bytes:\nuser: keep 🦊 e\u0301 漢字";

// ---- wire fixtures ----------------------------------------------------------

function hostMarker(): WireObject {
  return { type: "ephemeral", ttl: "1h" };
}

function nativeViewBlocks(view: string): WireObject[] {
  return viewBlocks(view, anthropicModel()).map((block): WireObject => ({ type: block.type, text: block.text }));
}

function inputViewBlocks(view: string, model: Model): WireObject[] {
  return viewBlocks(view, model).map((block): WireObject => ({ type: "input_text", text: block.text }));
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
function responsesPayload(view = labeledView(110), model: Model = openaiModel()): ResponsesPayload {
  return {
    model: "gpt-fixture",
    instructions: "Host instructions.",
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "optchat-session",
    input: [
      { role: "user", content: inputViewBlocks(view, model) },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Earlier answer.", annotations: [] }] },
      { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "Private summary." }], encrypted_content: "opaque+/==\r\n🔒" },
      { role: "user", content: [{ type: "input_text", text: "Current request." }] },
    ],
  };
}

/** A Codex Responses request: the same input with a reasoning object that has no context yet. */
function codexPayload(view = labeledView(110)): ResponsesPayload {
  return {
    ...responsesPayload(view, codexModel()),
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

function apply(payload: WireObject, model: Model): WireObject {
  const result = applyOptChatCache(payload, model);
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

/** Owner paths of OpenAI's three fixed-offset view cuts; native marks only its latest full group. */
function viewCutPaths(field: "input", message = 0): string[] {
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
function expectPassthrough(payload: WireObject, model: Model): void {
  const before = structuredClone(payload);
  freezeDeep(payload);
  expect(applyOptChatCache(payload, model)).toBe(payload);
  expect(payload).toEqual(before);
}

/** Positive control: the enabled adapter really changes this payload. */
function expectChanged(payload: WireObject, model: Model): WireObject {
  const result = apply(payload, model);
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

  // Literal cuts are an independent oracle: seven opening-tag units plus 1,000 per row.
  const BOUNDARIES: Array<{ rows: number; cuts: number[] }> = [
    { rows: 0, cuts: [] },
    { rows: 1, cuts: [] },
    { rows: 3, cuts: [] },
    { rows: 4, cuts: [4_007] },
    { rows: 5, cuts: [4_007] },
    { rows: 7, cuts: [4_007] },
    { rows: 8, cuts: [4_007, 8_007] },
    { rows: 9, cuts: [4_007, 8_007] },
  ];

  {
    const name = "indexed chat";
    const view = labeledView;
    test.each(BOUNDARIES)(`${name}: $rows rows split every four lines and mark only the latest complete group`, ({ rows, cuts }) => {
      const text = view(rows);
      const input = nativePayload(text);
      const texts = blockTexts(input.messages[0].content);
      const boundaries = [0, ...cuts, text.length];
      expect(texts).toEqual(boundaries.slice(1).map((end, index) => text.slice(boundaries[index], end)));
      expect(texts).toHaveLength(cuts.length + 1);
      expect(texts.join("")).toBe(text);
      if (rows > 0 && rows % 4 === 0) expect(texts.at(-1)).toBe("</chat>");
      const result = apply(input, anthropicModel());
      const head = cuts.length === 0 ? ["$.tools.0", "$.system.0", "$.system.1"] : ["$.tools.0", "$.system.1"];
      const viewPath = cuts.length === 0 ? [] : [`$.messages.0.content.${cuts.length - 1}`];
      const markers = markersAt(result, "cache_control");
      expect(markers).toEqual(expectedMarkers(FIVE_MINUTES, ...head, ...viewPath, "$.messages.2.content.0"));
      expect(Object.keys(markers)).toHaveLength(4);
      for (const marker of Object.values(markers)) expect(marker).toEqual(FIVE_MINUTES);
      expect(markedPrefixes(at(result, "messages", 0, "content"), "cache_control")).toEqual(cuts.slice(-1).map((cut) => text.slice(0, cut)));
      expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
    });

    test.each([
      { rows: 110, blocks: 28, last: 26, cut: 108_007 },
      { rows: 4_096, blocks: 1_025, last: 1_023, cut: 4_096_007 },
      { rows: 4_097, blocks: 1_025, last: 1_023, cut: 4_096_007 },
    ])(`${name}: large $rows-row views keep four-line blocks but at most four 5m markers`, ({ rows, blocks, last, cut }) => {
      const text = view(rows);
      const input = nativePayload(text);
      expect(input.messages[0].content).toHaveLength(blocks);
      const result = apply(input, anthropicModel());
      const texts = blockTexts(at(result, "messages", 0, "content"));
      expect(texts[0]).toBe(text.slice(0, 4_007));
      for (let block = 1; block < blocks - 1; block++) {
        expect(texts[block]).toBe(text.slice(7 + block * 4_000, 7 + (block + 1) * 4_000));
      }
      expect(texts.at(-1)).toBe(text.slice(cut));
      expect(Buffer.from(texts.join("")).equals(Buffer.from(text))).toBe(true);
      expect(markedPrefixes(at(result, "messages", 0, "content"), "cache_control")).toEqual([text.slice(0, cut)]);
      const markers = markersAt(result, "cache_control");
      expect(markers).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", `$.messages.0.content.${last}`, "$.messages.2.content.0"));
      expect(Object.keys(markers)).toHaveLength(4);
      for (const marker of Object.values(markers)) expect(marker).toEqual(FIVE_MINUTES);
    });
  }

  test("four summary lines form a full group regardless of their length or encoded original-message counts", () => {
    const body = "0+7|a\n7+1|🦊\n8+9|e\u0301\n17+2|漢字\n";
    const view = `<chat>\n${body}</chat>`;
    const input = nativePayload(view);
    expect(blockTexts(input.messages[0].content)).toEqual([`<chat>\n${body}`, "</chat>"]);
    const result = apply(input, anthropicModel());
    expect(markedPrefixes(at(result, "messages", 0, "content"), "cache_control")).toEqual([`<chat>\n${body}`]);
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", "$.messages.0.content.0", "$.messages.2.content.0"));
  });

  test("one tool, one system, the latest full group and request end all retain a 5m marker", () => {
    const input = nativePayload(labeledView(8));
    input.system = [{ type: "text", text: "Only system anchor.", cache_control: hostMarker() }];
    const result = apply(input, anthropicModel());
    const markers = markersAt(result, "cache_control");
    expect(markers).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.0", "$.messages.0.content.1", "$.messages.2.content.0"));
    expect(Object.keys(markers)).toHaveLength(4);
    for (const marker of Object.values(markers)) expect(marker).toEqual(FIVE_MINUTES);
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("multiple tool and system anchors retain the latest of each family within the four-marker budget", () => {
    const input = nativePayload(labeledView(9));
    input.tools.push({ name: "another_tool", input_schema: { type: "object" }, cache_control: hostMarker() });
    input.system.push({ type: "text", text: "Latest system anchor.", cache_control: hostMarker() });
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.1", "$.system.2", "$.messages.0.content.1", "$.messages.2.content.0"));
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test.each(["short", "long"])("host %s retention is normalized to four 5m markers, never 1h", (retention) => {
    process.env.PI_CACHE_RETENTION = retention;
    const input = nativePayload(labeledView(9), () => retention === "long" ? hostMarker() : { type: "ephemeral" });
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", "$.messages.0.content.1", "$.messages.2.content.0"));
  });

  test("host retention none supplies no breakpoints and remains untouched", () => {
    process.env.PI_CACHE_RETENTION = "none";
    const input = nativePayload(labeledView(9), () => undefined);
    expectPassthrough(input, anthropicModel());
    expect(markersAt(input, "cache_control")).toEqual({});
  });

  test("host root and stale block breakpoints are replaced, never accumulated", () => {
    const input = nativePayload();
    input.cache_control = { type: "ephemeral" };
    const view = input.messages[0].content;
    view[0] = { ...view[0], cache_control: hostMarker() };
    view[27] = { ...view[27], cache_control: hostMarker() };
    input.messages[1].content[0] = { ...input.messages[1].content[0], cache_control: hostMarker() };
    const result = apply(input, anthropicModel());
    expect(result).not.toHaveProperty("cache_control");
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", "$.messages.0.content.26", "$.messages.2.content.0"));
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("a root-only host breakpoint keeps caching on: only the latest full group is marked and no end is invented", () => {
    const input = nativePayload(labeledView(110), () => undefined);
    input.cache_control = { type: "ephemeral" };
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.messages.0.content.26"));
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("a coincident view and host-end anchor uses one slot and retains all three head anchors", () => {
    const input = nativePayload(labeledView(8));
    input.messages = [input.messages[0]];
    input.messages[0].content[1] = { ...input.messages[0].content[1], cache_control: hostMarker() };
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.0", "$.system.1", "$.messages.0.content.1"));
    expect(at(result, "messages", 0, "content", 2)).toEqual({ type: "text", text: "</chat>" });
  });

  test("head anchors without a host message end spend the spare slot on an earlier system anchor", () => {
    const input = nativePayload(labeledView(9));
    input.messages[2].content[0] = { type: "text", text: "Unmarked current turn." };
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.0", "$.system.1", "$.messages.0.content.1"));
    expect(at(result, "messages", 2)).toBe(input.messages[2]);
  });

  test("without tool anchors the two latest system anchors fill the available head slots", () => {
    const input = nativePayload(labeledView(9));
    input.tools = [];
    input.system.push({ type: "text", text: "Latest system anchor.", cache_control: hostMarker() });
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.system.1", "$.system.2", "$.messages.0.content.1", "$.messages.2.content.0"));
  });

  test("without any host breakpoint caching is off and the payload is returned by reference", () => {
    expectChanged(nativePayload(), anthropicModel());
    const input = nativePayload(labeledView(110), () => undefined);
    expect(markersAt(input, "cache_control")).toEqual({});
    expectPassthrough(input, anthropicModel());
  });

  test("a main request anchors OptChat's trailing system block behind the host's stable system anchor within four markers", () => {
    const input = nativePayload(labeledView(9));
    // The host anchors before its volatile project context; OptChat's block comes last and is unmarked.
    input.system = [
      { type: "text", text: "Host system prompt.", cache_control: hostMarker() },
      { type: "text", text: "<project-context>\nworking directory</project-context>" },
      { type: "text", text: SYSTEM_BLOCK },
    ];
    const result = apply(input, anthropicModel());
    const markers = markersAt(result, "cache_control");
    expect(markers).toEqual(expectedMarkers(FIVE_MINUTES, "$.system.0", "$.system.2", "$.messages.0.content.1", "$.messages.2.content.0"));
    expect(Object.keys(markers)).toHaveLength(4);
    expect(at(result, "system", 1)).toBe(input.system[1]);
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("a trailing system block that is not text never receives a marker", () => {
    const input = nativePayload(labeledView(9));
    input.system = [
      { type: "text", text: "Host system prompt.", cache_control: hostMarker() },
      { type: "thinking", text: SYSTEM_BLOCK },
    ];
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.0", "$.messages.0.content.1", "$.messages.2.content.0"));
  });

  test("the latest existing host breakpoint stays the request end when unmarked continuation messages follow", () => {
    const input = nativePayload();
    input.messages.push(
      { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    );
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", "$.messages.0.content.26", "$.messages.2.content.0"));
    expect(at(result, "messages", 3)).toBe(input.messages[3]);
    expect(at(result, "messages", 4)).toBe(input.messages[4]);
  });
});

// ---- OpenAI Responses --------------------------------------------------------

describe("OpenAI Responses", () => {
  test.each([
    { rows: 40, cuts: [] },
    { rows: 60, cuts: [49_007] },
    { rows: 90, cuts: [49_007, 79_007] },
    { rows: 110, cuts: [49_007, 79_007, 99_007] },
  ])("$rows rows retain the original 0/1/2/3 fixed-offset view cuts plus the user end", ({ rows, cuts }) => {
    const view = labeledView(rows);
    const input = responsesPayload(view);
    const texts = blockTexts(at(input, "input", 0, "content"));
    const boundaries = [0, ...cuts, view.length];
    expect(texts).toEqual(boundaries.slice(1).map((end, index) => view.slice(boundaries[index], end)));
    expect(texts).toHaveLength(cuts.length + 1);
    const result = apply(input, openaiModel());
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...cuts.map((_, block) => `$.input.0.content.${block}`), "$.input.3.content.0"));
    expect(markedPrefixes(at(result, "input", 0, "content"), "prompt_cache_breakpoint")).toEqual(cuts.map((cut) => view.slice(0, cut)));
    expect(stripKey(withoutField(result, "prompt_cache_options"), "prompt_cache_breakpoint")).toEqual(input);
  });
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
    const view = inputViewBlocks(labeledView(110), model);
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

// ---- partition gates ---------------------------------------------------------

describe("view partition gates", () => {
  test("official image-capable Anthropic uses four-line blocks without changing bytes", () => {
    const model = anthropicModel();
    expect(model.api).toBe("anthropic-messages");
    expect(model.provider).toBe("anthropic");
    expect(model.baseUrl).toBe("https://api.anthropic.com");
    expect(model.compat.officialEndpoint).toBe(true);
    expect(model.input).toContain("image");
    expect(viewPartition(model)).toBe("anthropic");
    const view = labeledView(8);
    const texts = viewBlocks(view, model).map((block) => block.text);
    expect(texts).toEqual([view.slice(0, 4_007), view.slice(4_007, 8_007), "</chat>"]);
    expect(texts.join("")).toBe(view);
  });

  const FIXED_MODELS: Array<{ name: string; model: () => Model }> = [
    { name: "text-only official Anthropic", model: () => ({ ...anthropicModel(), input: ["text"] }) },
    { name: "Anthropic gateway", model: () => ({ ...anthropicModel(), baseUrl: "https://gateway.example/anthropic" }) },
    { name: "pi-native Anthropic", model: () => ({ ...anthropicModel(), transport: "pi-native" }) },
    { name: "OpenAI Responses", model: openaiModel },
    { name: "Codex Responses", model: codexModel },
  ];

  test.each(FIXED_MODELS)("$name uses fixed blocks without changing bytes", ({ model }) => {
    const candidate = model();
    expect(viewPartition(candidate)).toBe("fixed");
    const view = labeledView(110);
    const texts = viewBlocks(view, candidate).map((block) => block.text);
    expect(texts).toEqual([view.slice(0, CUTS[0]), view.slice(CUTS[0], CUTS[1]), view.slice(CUTS[1], CUTS[2]), view.slice(CUTS[2])]);
    expect(texts.join("")).toBe(view);
  });

  test("undefined model uses fixed blocks without changing bytes", () => {
    expect(viewPartition(undefined)).toBe("fixed");
    const view = labeledView(110);
    const texts = viewBlocks(view, undefined).map((block) => block.text);
    expect(texts).toEqual([view.slice(0, CUTS[0]), view.slice(CUTS[0], CUTS[1]), view.slice(CUTS[1], CUTS[2]), view.slice(CUTS[2])]);
    expect(texts.join("")).toBe(view);
  });

  test("bundled text-only MiniMax keeps a sub-50k view in one block even with the host newline join", () => {
    const models = getBundledModels("minimax");
    const model = models.find((candidate) => candidate.id === "MiniMax-M2.5") ??
      models.find((candidate) => candidate.api === "anthropic-messages" && !candidate.input.includes("image"));
    if (!model) throw new Error("Installed catalog lacks a text-only MiniMax anthropic-messages model");
    expect(model.api).toBe("anthropic-messages");
    expect(model.input).not.toContain("image");
    expect(viewPartition(model)).toBe("fixed");
    const view = labeledView(8);
    expect(view.length).toBeLessThan(50_000);
    const texts = viewBlocks(view, model).map((block) => block.text);
    expect(texts).toEqual([view]);
    expect(texts.join("")).toBe(view);
    expect(texts.join("\n")).toBe(view);
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

  {
    const name = "indexed chat";
    const view = labeledView;
    test.each([4, 8, 9, 110])(`native ${name}: an unsplit %s-row encoded view cannot invent a full-group cut`, (rows) => {
      const text = view(rows);
      const input = nativePayload(text);
      input.messages[0].content = [{ type: "text", text }];
      const result = apply(input, anthropicModel());
      expect(at(result, "messages", 0)).toBe(input.messages[0]);
      expect(at(result, "messages", 0, "content")).toHaveLength(1);
      expect(blockTexts(at(result, "messages", 0, "content"))).toEqual([text]);
      expect(markedPrefixes(at(result, "messages", 0, "content"), "cache_control")).toEqual([]);
      expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.0", "$.system.1", "$.messages.2.content.0"));
      expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
    });
  }

  test("Responses: an unsplit long encoded view cannot invent fixed-offset cuts", () => {
    const view = labeledView(110);
    const input = responsesPayload(view);
    input.input[0] = { role: "user", content: [{ type: "input_text", text: view }] };
    const result = apply(input, openaiModel());
    expect(at(result, "input", 0)).toBe(input.input[0]);
    expect(blockTexts(at(result, "input", 0, "content"))).toEqual([view]);
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, "$.input.3.content.0"));
    expect(stripKey(withoutField(result, "prompt_cache_options"), "prompt_cache_breakpoint")).toEqual(input);
  });

  test("Codex: an unsplit long encoded view stays untouched while reasoning context is enabled", () => {
    const view = labeledView(110);
    const input = codexPayload(view);
    input.input[0] = { role: "user", content: [{ type: "input_text", text: view }] };
    const result = apply(input, codexModel());
    expect(result.input).toBe(input.input);
    expect(blockTexts(at(result, "input", 0, "content"))).toEqual([view]);
    expect(result.reasoning).toEqual({ effort: "high", summary: "auto", context: "all_turns" });
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual({});
    expect(markersAt(result, "cache_control")).toEqual({});
  });

  test("native: a later pasted view gets no prefix breakpoints, only the host's request end", () => {
    const input = nativePayload();
    const pasted = nativeViewBlocks(labeledView(110));
    expect(pasted).toHaveLength(28);
    pasted[27] = { ...pasted[27], cache_control: hostMarker() };
    input.messages[2] = { role: "user", content: pasted };
    const result = apply(input, anthropicModel());
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", "$.messages.0.content.26", "$.messages.2.content.27"));
    expect(blockTexts(at(result, "messages", 2, "content"))).toEqual(blockTexts(pasted));
  });

  test("Responses: a later pasted view gets no prefix breakpoints, only the request end", () => {
    const input = responsesPayload();
    const pasted = inputViewBlocks(labeledView(110), openaiModel());
    expect(pasted).toHaveLength(4);
    input.input[3] = { role: "user", content: pasted };
    const result = apply(input, openaiModel());
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.3.content.3"));
    expect(blockTexts(at(result, "input", 3, "content"))).toEqual(blockTexts(pasted));
  });

  test("Codex: a later pasted view leaves the input untouched", () => {
    const input = codexPayload();
    input.input[3] = { role: "user", content: inputViewBlocks(labeledView(110), codexModel()) };
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
  // The compressor sends one user message: `viewBlocks(context, model)` plus a separate instruction block.
  test.each([
    { rows: 0, viewCount: 1, last: undefined, cut: undefined },
    { rows: 1, viewCount: 1, last: undefined, cut: undefined },
    { rows: 3, viewCount: 1, last: undefined, cut: undefined },
    { rows: 4, viewCount: 2, last: 0, cut: 4_007 },
    { rows: 5, viewCount: 2, last: 0, cut: 4_007 },
    { rows: 7, viewCount: 2, last: 0, cut: 4_007 },
    { rows: 8, viewCount: 3, last: 1, cut: 8_007 },
    { rows: 9, viewCount: 3, last: 1, cut: 8_007 },
  ])("native: $rows rows keep the closing tail separate from the marked compactor instruction", ({ rows, viewCount, last, cut }) => {
    const context = labeledView(rows);
    const input = nativePayload(context);
    input.tools = [];
    input.system = [{ type: "text", text: "Compressor prompt.", cache_control: hostMarker() }];
    input.messages = [{
      role: "user",
      content: [...nativeViewBlocks(context), { type: "text", text: COMPACTOR_INSTRUCTION, cache_control: hostMarker() }],
    }];
    const result = apply(input, anthropicModel());
    const texts = blockTexts(at(result, "messages", 0, "content"));
    expect(texts).toHaveLength(viewCount + 1);
    expect(texts.slice(0, viewCount).join("")).toBe(context);
    expect(texts[viewCount]).toBe(COMPACTOR_INSTRUCTION);
    if (rows > 0 && rows % 4 === 0) expect(texts[viewCount - 1]).toBe("</chat>");
    const viewPath = last === undefined ? [] : [`$.messages.0.content.${last}`];
    const prefixes = cut === undefined ? [] : [context.slice(0, cut)];
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.system.0", ...viewPath, `$.messages.0.content.${viewCount}`));
    expect(markedPrefixes(at(result, "messages", 0, "content"), "cache_control")).toEqual([...prefixes, context + COMPACTOR_INSTRUCTION]);
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("native: a compressor request anchors OptChat's trailing system block independently of the view", () => {
    const input: NativePayload = {
      model: "claude-fixture",
      max_tokens: 8_192,
      stream: true,
      tools: [],
      system: [
        { type: "text", text: "Compressor prompt.", cache_control: hostMarker() },
        { type: "text", text: "<project-context>\nworking directory</project-context>" },
        { type: "text", text: SYSTEM_BLOCK },
      ],
      messages: [{
        role: "user",
        content: [...nativeViewBlocks(COMPACTOR_CONTEXT), { type: "text", text: COMPACTOR_INSTRUCTION, cache_control: hostMarker() }],
      }],
    };
    const result = apply(input, anthropicModel());
    const markers = markersAt(result, "cache_control");
    expect(markers).toEqual(expectedMarkers(FIVE_MINUTES, "$.system.0", "$.system.2", "$.messages.0.content.26", "$.messages.0.content.28"));
    expect(Object.keys(markers)).toHaveLength(4);
    expect(stripKey(result, "cache_control")).toEqual(stripKey(input, "cache_control"));
  });

  test("native: the compressor context keeps its bytes; the latest full group, system and host end are marked", () => {
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
    const result = apply(input, anthropicModel());
    const content = at(result, "messages", 0, "content");
    const texts = blockTexts(content);
    expect(texts).toHaveLength(29);
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.system.0", "$.messages.0.content.26", "$.messages.0.content.28"));
    expect(Buffer.from(texts.slice(0, 28).join("")).equals(Buffer.from(COMPACTOR_CONTEXT))).toBe(true);
    expect(texts[28]).toBe(COMPACTOR_INSTRUCTION);
    expect(markedPrefixes(content, "cache_control")).toEqual([COMPACTOR_CONTEXT.slice(0, 108_007), COMPACTOR_CONTEXT + COMPACTOR_INSTRUCTION]);
    for (let block = 0; block < 28; block++) {
      if (block !== 26) expect(at(result, "messages", 0, "content", block)).toBe(input.messages[0].content[block]);
    }
  });

  test("Responses: the compressor context keeps its bytes; cuts and the final instruction block are marked", () => {
    const input: ResponsesPayload = {
      model: "gpt-fixture",
      instructions: "Compressor prompt.",
      stream: true,
      input: [{ role: "user", content: [...inputViewBlocks(COMPACTOR_CONTEXT, openaiModel()), { type: "input_text", text: COMPACTOR_INSTRUCTION }] }],
    };
    const result = apply(input, openaiModel());
    const texts = blockTexts(at(result, "input", 0, "content"));
    expect(texts).toHaveLength(5);
    expect(result.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(markersAt(result, "prompt_cache_breakpoint")).toEqual(expectedMarkers(EXPLICIT, ...viewCutPaths("input"), "$.input.0.content.4"));
    expect(Buffer.from(texts.slice(0, 4).join("")).equals(Buffer.from(COMPACTOR_CONTEXT))).toBe(true);
    expect(texts[4]).toBe(COMPACTOR_INSTRUCTION);
  });

  test("Codex: the compressor context admits the reasoning-context request with the input shared by reference", () => {
    const input: ResponsesPayload = {
      model: "gpt-codex-fixture",
      instructions: "Compressor prompt.",
      store: false,
      stream: true,
      reasoning: { effort: "medium", summary: "auto" },
      input: [{ role: "user", content: [...inputViewBlocks(COMPACTOR_CONTEXT, codexModel()), { type: "input_text", text: COMPACTOR_INSTRUCTION }] }],
    };
    const result = apply(input, codexModel());
    expect(result.input).toBe(input.input);
    expect(result.reasoning).toEqual({ effort: "medium", summary: "auto", context: "all_turns" });
  });
});

// ---- stable prefixes ---------------------------------------------------------

describe("stable cache prefixes", () => {
  {
    const name = "indexed chat";
    const view = labeledView;
    test.each([4, 8, 108])(`native ${name}: a complete %s-row prefix stays marked while appending one, two or three rows`, (rows) => {
      const original = view(rows);
      const cut = 7 + rows * ROW_UNITS;
      const before = apply(nativePayload(original), anthropicModel());
      const beforeTexts = blockTexts(at(before, "messages", 0, "content"));
      expect(beforeTexts).toHaveLength(rows / 4 + 1);
      expect(beforeTexts.at(-1)).toBe("</chat>");
      expect(markedPrefixes(at(before, "messages", 0, "content"), "cache_control")).toEqual([original.slice(0, cut)]);
      for (const extra of [1, 2, 3]) {
        const appended = view(rows + extra);
        const after = apply(nativePayload(appended), anthropicModel());
        const afterTexts = blockTexts(at(after, "messages", 0, "content"));
        expect(afterTexts).toHaveLength(rows / 4 + 1);
        expect(afterTexts.slice(0, -1)).toEqual(beforeTexts.slice(0, -1));
        expect(afterTexts.at(-1)).toBe(appended.slice(cut));
        expect(markedPrefixes(at(after, "messages", 0, "content"), "cache_control")).toEqual([original.slice(0, cut)]);
        expect(Buffer.from(afterTexts.join("")).equals(Buffer.from(appended))).toBe(true);
      }
    });

    test.each([
      { rows: 4, groups: 1, cut: 4_007 },
      { rows: 5, groups: 1, cut: 4_007 },
      { rows: 7, groups: 1, cut: 4_007 },
      { rows: 8, groups: 2, cut: 8_007 },
      { rows: 9, groups: 2, cut: 8_007 },
      { rows: 110, groups: 27, cut: 108_007 },
    ])(`native ${name}: adding a full group to $rows rows preserves existing growth blocks and advances only the latest marker`, ({ rows, groups, cut }) => {
      const original = view(rows);
      const appended = view(rows + 4);
      const before = apply(nativePayload(original), anthropicModel());
      const after = apply(nativePayload(appended), anthropicModel());
      const beforeTexts = blockTexts(at(before, "messages", 0, "content"));
      const afterTexts = blockTexts(at(after, "messages", 0, "content"));
      expect(beforeTexts).toHaveLength(groups + 1);
      expect(afterTexts).toHaveLength(groups + 2);
      expect(afterTexts.slice(0, groups)).toEqual(beforeTexts.slice(0, groups));
      expect(afterTexts[groups]).toBe(appended.slice(cut, cut + 4_000));
      expect(afterTexts.at(-1)).toBe(appended.slice(cut + 4_000));
      expect(markedPrefixes(at(before, "messages", 0, "content"), "cache_control")).toEqual([original.slice(0, cut)]);
      expect(markedPrefixes(at(after, "messages", 0, "content"), "cache_control")).toEqual([appended.slice(0, cut + 4_000)]);
      expect(markersAt(after, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", `$.messages.0.content.${groups}`, "$.messages.2.content.0"));
      expect(Buffer.from(afterTexts.join("")).equals(Buffer.from(appended))).toBe(true);
    });
  }
  const PREFIX_CASES: Array<{ name: string; key: CacheKey; field: "messages" | "input"; model: () => Model; payload: (view: string) => WireObject }> = [
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
  const SPLIT_MODELS: Array<{ name: string; model: () => Model; unicodeBlocks: number; crlfBlocks: number }> = [
    { name: "native Anthropic", model: anthropicModel, unicodeBlocks: 351, crlfBlocks: 28 },
    { name: "OpenAI Responses", model: openaiModel, unicodeBlocks: 4, crlfBlocks: 4 },
    { name: "Codex Responses", model: codexModel, unicodeBlocks: 4, crlfBlocks: 4 },
    { name: "pi-native Anthropic", model: () => ({ ...anthropicModel(), transport: "pi-native" }), unicodeBlocks: 4, crlfBlocks: 4 },
  ];

  test.each(SPLIT_MODELS)("$name splits astral, combining and CJK text losslessly with its own block count", ({ model, unicodeBlocks }) => {
    const view = unicodeView();
    const parts = viewBlocks(view, model());
    expect(parts).toHaveLength(unicodeBlocks);
    for (const part of parts.slice(0, -1)) expect(part.text.endsWith("\n")).toBe(true);
    if (unicodeBlocks === 351) {
      // 1,400 rows / four per block, followed by a closing-tag-only block.
      expect(parts[0].text).toBe(view.slice(0, 411));
      for (const part of parts.slice(1, -1)) expect(part.text.split("\n")).toHaveLength(5);
      expect(parts.at(-1)?.text).toBe("</chat>");
    } else {
      // Row lengths are 101/102/103/104 UTF-16 units for 1/2/3/4-digit ids.
      expect(parts.map((part) => part.text)).toEqual([
        view.slice(0, 49_955), view.slice(49_955, 79_928), view.slice(79_928, 99_910), view.slice(99_910),
      ]);
    }
    expect(Buffer.from(parts.map((part) => part.text).join("")).equals(Buffer.from(view))).toBe(true);
  });

  test.each(SPLIT_MODELS)("$name keeps CRLF lossless with its own block count and never separates CR from LF", ({ model, crlfBlocks }) => {
    const view = crlf(labeledView(110));
    const parts = viewBlocks(view, model());
    expect(parts).toHaveLength(crlfBlocks);
    for (const part of parts.slice(0, -1)) expect(part.text.endsWith("\r\n")).toBe(true);
    if (crlfBlocks === 28) {
      expect(parts[0].text).toBe(view.slice(0, 4_012));
      for (const part of parts.slice(1, -1)) {
        expect(part.text).toHaveLength(4_004);
        expect(part.text.split("\r\n")).toHaveLength(5);
      }
      expect(parts.at(-1)?.text).toBe(view.slice(108_116));
    } else {
      expect(parts.map((part) => part.text)).toEqual([
        view.slice(0, 49_057), view.slice(49_057, 79_087), view.slice(79_087, 99_107), view.slice(99_107),
      ]);
    }
    expect(Buffer.compare(Buffer.from(parts.map((part) => part.text).join("")), Buffer.from(view))).toBe(0);
  });

  {
    const name = "indexed chat";
    const view = labeledView;
    test.each([{ rows: 4, blocks: 2 }, { rows: 8, blocks: 3 }])(`native ${name}: exactly $rows CRLF rows leave a closing-tag-only block without losing bytes`, ({ rows, blocks }) => {
      const text = crlf(view(rows));
      const parts = viewBlocks(text, anthropicModel());
      expect(parts).toHaveLength(blocks);
      expect(parts[0].text).toBe(text.slice(0, 4_012));
      expect(parts.at(-1)?.text).toBe("</chat>");
      for (const part of parts.slice(0, -1)) expect(part.text.endsWith("\r\n")).toBe(true);
      expect(Buffer.from(parts.map((part) => part.text).join("")).equals(Buffer.from(text))).toBe(true);
    });
  }

  test("native: Unicode view blocks and a separate trailing text block keep their exact UTF-8 bytes", () => {
    const view = unicodeView();
    const trailing: WireObject = { type: "text", text: "Trailing note 🦊 e\u0301 漢字\r\n" };
    const input = nativePayload(view);
    input.messages[0] = { role: "user", content: [...nativeViewBlocks(view), trailing] };
    const result = apply(input, anthropicModel());
    const texts = blockTexts(at(result, "messages", 0, "content"));
    expect(texts).toHaveLength(352);
    expect(texts[350]).toBe("</chat>");
    expect(Buffer.from(texts.slice(0, 351).join("")).equals(Buffer.from(view))).toBe(true);
    expect(Buffer.compare(Buffer.from(texts.join("")), Buffer.from(`${view}Trailing note 🦊 e\u0301 漢字\r\n`))).toBe(0);
    expect(at(result, "messages", 0, "content", 350)).toBe(input.messages[0].content[350]);
    expect(at(result, "messages", 0, "content", 351)).toBe(trailing);
    expect(markedPrefixes(at(result, "messages", 0, "content"), "cache_control")).toEqual([view.slice(0, -7)]);
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", "$.messages.0.content.349", "$.messages.2.content.0"));
  });

  test("Responses: Unicode view blocks and a separate trailing text block keep their exact UTF-8 bytes", () => {
    const view = unicodeView();
    const trailing: WireObject = { type: "input_text", text: "Trailing note 🦊 e\u0301 漢字\r\n" };
    const input = responsesPayload(view);
    input.input[0] = { role: "user", content: [...inputViewBlocks(view, openaiModel()), trailing] };
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
    expect(markersAt(result, "cache_control")).toEqual(expectedMarkers(FIVE_MINUTES, "$.tools.0", "$.system.1", "$.messages.0.content.26", "$.messages.2.content.0"));
    expect(result.messages).not.toBe(input.messages);
    expect(at(result, "messages", 0)).not.toBe(input.messages[0]);
    expect(at(result, "messages", 0, "content")).not.toBe(input.messages[0].content);
    expect(input.messages[0].content).toHaveLength(28);
    for (let block = 0; block < 28; block++) {
      if (block === 26) expect(at(result, "messages", 0, "content", block)).not.toBe(input.messages[0].content[block]);
      else expect(at(result, "messages", 0, "content", block)).toBe(input.messages[0].content[block]);
    }
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

// ---- concurrent cache-prefix writers ----------------------------------------

describe("cache-prefix writer coordination", () => {
  const coordinators = new Set<OptChatCacheCoordinator>();
  const coordinator = (failSafeMs?: number): OptChatCacheCoordinator => {
    const result = new OptChatCacheCoordinator(failSafeMs);
    coordinators.add(result);
    return result;
  };
  const encoded = (rows = 8): WireObject => apply(nativePayload(labeledView(rows)), anthropicModel());
  /**
   * A compressor request as the host encodes it: the effective system prompt with its host anchor, then one user
   * message holding the view and the task, which carries the host's request-end anchor. The default view is the
   * context of concurrent leaves in a fresh store: no built line yet, so no four-line view block to mark.
   */
  const compressorPayload = (task: string, view = "<chat>\n</chat>", system = "Host system prompt."): WireObject => apply({
    model: "claude-fixture",
    max_tokens: 8_192,
    stream: true,
    system: [{ type: "text", text: system, cache_control: hostMarker() }],
    messages: [{ role: "user", content: [...nativeViewBlocks(view), { type: "text", text: task, cache_control: hostMarker() }] }],
  }, anthropicModel());
  /** Drain the microtask queue: every continuation of an unblocked acquire or wait has run. */
  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 16; turn++) await Promise.resolve();
  };

  afterEach(() => {
    for (const gate of coordinators) gate.clear();
    coordinators.clear();
  });

  test.each([
    { name: "string continuation", content: "Continue." },
    { name: "unknown null continuation", content: null },
  ])("a marked view preceding a $name still coordinates writers", async ({ content }) => {
    const gate = coordinator();
    const model = anthropicModel();
    const input = nativePayload(labeledView(8));
    input.messages = [input.messages[0]];
    const marked = apply(input, model);
    expect(markedPrefixes(at(marked, "messages", 0, "content"), "cache_control")).toEqual([labeledView(8).slice(0, 8_007)]);
    const payload: WireObject = {
      ...marked,
      messages: [
        at(marked, "messages", 0),
        { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
        { role: "user", content },
      ],
    };
    const first = await gate.acquire(payload, model);
    let settled = false;
    const second = gate.acquire(structuredClone(payload), model).then((release) => { settled = true; return release; });
    await Promise.resolve();
    expect(settled).toBe(false);
    first(true);
    (await second)();
    expect(settled).toBe(true);
  });

  test("wait without a writer resolves immediately and claims no writer", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    await gate.wait(payload, model);
    const first = await gate.acquire(payload, model);
    let settled = false;
    const second = gate.acquire(payload, model).then((release) => { settled = true; return release; });
    await Promise.resolve();
    expect(settled).toBe(false);
    first(true);
    (await second)();
    expect(settled).toBe(true);
  });

  test.each([true, false])("wait stays pending until the held writer releases with responseStarted=%s", async (responseStarted) => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const release = await gate.acquire(payload, model);
    let settled = false;
    const waiting = gate.wait(payload, model).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(responseStarted);
    await waiting;
    expect(settled).toBe(true);
  });

  test("a pending wait never claims a writer or blocks later acquires", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const first = await gate.acquire(payload, model);
    let settled = false;
    const waiting = gate.wait(payload, model).then(() => { settled = true; });
    const disjointInput = nativePayload(labeledView(8).replace("0+1|", "0+1|different "));
    disjointInput.system[0].text = "A different system prompt";
    const disjoint = await gate.acquire(apply(disjointInput, model), model);
    expect(settled).toBe(false);
    disjoint();
    const next = gate.acquire(payload, model);
    first(false);
    await waiting;
    const releaseNext = await next;
    expect(settled).toBe(true);
    let thirdSettled = false;
    const third = gate.acquire(payload, model).then((release) => { thirdSettled = true; return release; });
    await Promise.resolve();
    expect(thirdSettled).toBe(false);
    releaseNext(true);
    (await third)();
    expect(thirdSettled).toBe(true);
  });

  test("wait with an already-aborted signal rejects with the exact reason", async () => {
    const gate = coordinator();
    const controller = new AbortController();
    const reason = new Error("wait already cancelled");
    controller.abort(reason);
    const rejected = gate.wait(encoded(), anthropicModel(), { signal: controller.signal })
      .then(() => undefined, (error: unknown) => error);
    expect(await rejected).toBe(reason);
  });

  test.each(["unsupported model", "unsupported payload"])("wait resolves immediately for an %s even while a supported writer is held", async (unsupported) => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const release = await gate.acquire(payload, model);
    if (unsupported === "unsupported model") {
      await gate.wait(payload, { ...model, provider: "gateway" });
    } else {
      await gate.wait({ messages: null }, model);
    }
    release();
  });

  test("identical encoded prefixes wait until response start, then all queued readers proceed", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const first = await gate.acquire(payload, model);
    let started = 0;
    const second = gate.acquire(structuredClone(payload), model).then((release) => { started++; return release; });
    const third = gate.acquire(structuredClone(payload), model).then((release) => { started++; return release; });
    await Promise.resolve();
    expect(started).toBe(0);
    first(true);
    const releases = await Promise.all([second, third]);
    expect(started).toBe(2);
    for (const release of releases) release(true);
    first(); // Idempotent after a successful release.
  });

  test("an error releases the writer but does not pretend its prefix is cache-ready", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const first = await gate.acquire(payload, model);
    const second = gate.acquire(payload, model);
    let thirdStarted = false;
    const third = gate.acquire(payload, model).then((release) => { thirdStarted = true; return release; });
    first();
    const releaseSecond = await second;
    expect(thirdStarted).toBe(false);
    releaseSecond(true);
    (await third)();
    expect(thirdStarted).toBe(true);
  });

  test("distinct marked views that share tools and system: a compressor waits for the head writer, a main wait does not", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(encoded(), model);
    const different = apply(nativePayload(labeledView(8).replace("0+1|", "0+1|different ")), model);
    await gate.wait(different, model);
    let started = false;
    const second = gate.acquire(different, model).then((release) => { started = true; return release; });
    await flush();
    expect(started).toBe(false);
    first(true);
    (await second)();
    expect(started).toBe(true);
  });

  test("a growing view waits for an earlier marked whole block despite different marker positions", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(encoded(4), model);
    let started = false;
    const pending = gate.acquire(encoded(8), model).then((release) => { started = true; return release; });
    await Promise.resolve();
    expect(started).toBe(false);
    first(true);
    (await pending)(true);
    expect(started).toBe(true);
  });

  test("the growing-prefix lookup never assumes entries beyond Anthropic's twenty-block window", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(encoded(4), model);
    // A main wait keys only message marks, so the head both requests share does not hold it.
    await gate.wait(encoded(88), model);
    first();
  });

  test("different suffix tasks share the marked context and proceed together after its response", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(encoded(), model);
    const task = (text: string): WireObject => {
      const input = nativePayload(labeledView(8));
      input.messages[2].content[0].text = text;
      return apply(input, model);
    };
    let started = 0;
    const second = gate.acquire(task("Compress node A"), model).then((release) => { started++; return release; });
    const third = gate.acquire(task("Compress node B"), model).then((release) => { started++; return release; });
    await Promise.resolve();
    expect(started).toBe(0);
    first(true);
    const releases = await Promise.all([second, third]);
    expect(started).toBe(2);
    for (const release of releases) release();
  });

  test.each(["tools", "system", "wire model"])("the actual encoded %s contributes to prefix identity", async (field) => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(encoded(), model);
    const different = nativePayload(labeledView(8));
    if (field === "tools") different.tools[0].description = "A different tool description";
    else if (field === "system") different.system[0].text = "A different system prompt";
    else different.model = "claude-other-wire-model";
    const second = await gate.acquire(apply(different, model), model);
    second();
    first();
  });

  test("the encoded thinking setting keys the view marks, not the shared head", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(encoded(), model);
    const different = nativePayload(labeledView(8));
    different.thinking = { type: "enabled", budget_tokens: 2_048 };
    const payload = apply(different, model);
    await gate.wait(payload, model);
    let started = false;
    const second = gate.acquire(payload, model).then((release) => { started = true; return release; });
    await flush();
    expect(started).toBe(false);
    first(true);
    (await second)();
  });

  test("the encoded message envelope keys the view marks, not the shared head", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(encoded(), model);
    const different = nativePayload(labeledView(8));
    different.messages[0].name = "another-user";
    const payload = apply(different, model);
    await gate.wait(payload, model);
    let started = false;
    const second = gate.acquire(payload, model).then((release) => { started = true; return release; });
    await flush();
    expect(started).toBe(false);
    first(true);
    (await second)();
  });

  test("a fresh-store compressor request shares only the host's system anchor with its concurrent siblings", () => {
    expect(markersAt(compressorPayload("compress message 0"), "cache_control"))
      .toEqual(expectedMarkers(FIVE_MINUTES, "$.system.0", "$.messages.0.content.1"));
  });

  test("concurrent compressor calls sharing only the system anchor wait for the first writer's response start", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(compressorPayload("compress message 0"), model);
    const started: number[] = [];
    const rest = [1, 2, 3].map((n) =>
      gate.acquire(compressorPayload(`compress message ${n}`), model).then((release) => { started.push(n); return release; }));
    await flush();
    expect(started).toEqual([]);
    first(true);
    const releases = await Promise.all(rest);
    expect(started.toSorted()).toEqual([1, 2, 3]);
    for (const release of releases) release(true);
  });

  test("a failed head writer hands the shared system prefix to one waiting compressor, not all", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(compressorPayload("compress message 0"), model);
    const started: number[] = [];
    const rest = [1, 2].map((n) =>
      gate.acquire(compressorPayload(`compress message ${n}`), model).then((release) => ({ n, release })));
    for (const pending of rest) void pending.then(({ n }) => started.push(n));
    first();
    await flush();
    expect(started).toEqual([1]);
    (await rest[0]!).release(true);
    (await rest[1]!).release();
    expect(started).toEqual([1, 2]);
  });

  test("compressor calls with a different system prefix never wait for each other", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(compressorPayload("compress message 0"), model);
    let started = false;
    const second = gate.acquire(compressorPayload("compress message 1", undefined, "Another system prompt."), model)
      .then((release) => { started = true; return release; });
    await flush();
    expect(started).toBe(true);
    (await second)();
    first();
  });

  test("a main wait never waits for compressor writers that share only its system anchor", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const writers = await Promise.all([gate.acquire(compressorPayload("compress message 0"), model)]);
    const queued = [1, 2].map((n) => gate.acquire(compressorPayload(`compress message ${n}`), model));
    let settled = false;
    const waiting = gate.wait(compressorPayload("Current turn.", labeledView(8)), model).then(() => { settled = true; });
    await flush();
    expect(settled).toBe(true);
    await waiting;
    writers[0]!(true);
    for (const release of await Promise.all(queued)) release();
  });

  test("an abandoned head writer still fails open for waiting compressors", async () => {
    // The coordinator's own fail-safe timer fires; the test awaits the lease and never sleeps.
    const gate = coordinator(10);
    const model = anthropicModel();
    const first = await gate.acquire(compressorPayload("compress message 0"), model);
    let started = false;
    const second = gate.acquire(compressorPayload("compress message 1"), model).then((release) => { started = true; return release; });
    await flush();
    expect(started).toBe(false);
    (await second)();
    expect(started).toBe(true);
    first();
  });

  test("model, endpoint and coordinator-instance fences remain independent", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const first = await gate.acquire(payload, model);
    const otherModel = await gate.acquire(payload, { ...model, id: `${model.id}-other` });
    const otherEndpoint = await gate.acquire(payload, { ...model, baseUrl: "https://api.anthropic.com/other" });
    const otherSession = await coordinator().acquire(payload, model);
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com/override";
    const effectiveEndpoint = await gate.acquire(payload, model);
    effectiveEndpoint();
    otherSession();
    otherEndpoint();
    otherModel();
    first();
  });

  test("unsupported, native, non-view, unmarked and stateful requests never become writers", async () => {
    const model = anthropicModel();
    const payload = encoded();
    const cases: Array<{ payload: WireObject; model: Model }> = [
      { payload, model: { ...model, transport: "pi-native" } },
      { payload, model: { ...model, provider: "gateway" } },
      { payload, model: { ...model, baseUrl: "https://gateway.example/anthropic" } },
      { payload, model: { ...model, compat: { ...model.compat, officialEndpoint: false } } },
      { payload, model: { ...model, baseUrl: "https://api.anthropic.com/?api_key=never-hash-this" } },
      { payload: { ...payload, previous_response_id: "stateful" }, model },
      { payload: nativePayload("ordinary user text"), model },
      { payload: nativePayload(labeledView(8), () => undefined), model },
      { payload: apply(responsesPayload(), openaiModel()), model: openaiModel() },
      { payload: apply(codexPayload(), codexModel()), model: codexModel() },
    ];
    for (const candidate of cases) {
      const gate = coordinator();
      const first = await gate.acquire(candidate.payload, candidate.model);
      const second = await gate.acquire(candidate.payload, candidate.model);
      second();
      first();
    }
  });

  test("a canceled waiter rejects promptly and does not acquire after the writer responds", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const first = await gate.acquire(payload, model);
    const controller = new AbortController();
    const reason = new Error("queued request cancelled");
    const pending = gate.acquire(payload, model, { signal: controller.signal });
    const rejected = pending.then(() => undefined, (error: unknown) => error);
    controller.abort(reason);
    expect(await rejected).toBe(reason);
    first(true);
    const next = await gate.acquire(payload, model);
    next();
  });

  test("canceling the active writer releases its lease even if the provider never responds", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const controller = new AbortController();
    const first = await gate.acquire(payload, model, { signal: controller.signal });
    const pending = gate.acquire(payload, model);
    controller.abort();
    const second = await pending;
    second(true);
    first();
  });

  test("one cancellation shared by the writer and waiters cannot recursively re-acquire", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const controller = new AbortController();
    const reason = new Error("session cancelled");
    const first = await gate.acquire(payload, model, { signal: controller.signal });
    const pending = gate.acquire(payload, model, { signal: controller.signal });
    const rejected = pending.then(() => undefined, (error: unknown) => error);
    controller.abort(reason);
    expect(await rejected).toBe(reason);
    first();
    (await gate.acquire(payload, model))();
  });

  test("an already-aborted request never acquires a writer", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    await expect(gate.acquire(encoded(), model, { signal: controller.signal })).rejects.toBe(reason);
    (await gate.acquire(encoded(), model))();
  });

  test("response-release racing waiter cancellation cleans up the just-granted lease", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const first = await gate.acquire(encoded(4), model);
    const controller = new AbortController();
    const reason = new Error("cancel in release tick");
    const pending = gate.acquire(encoded(8), model, { signal: controller.signal });
    const rejected = pending.then(() => undefined, (error: unknown) => error);
    first(true);
    controller.abort(reason);
    expect(await rejected).toBe(reason);
    (await gate.acquire(encoded(8), model))();
  });

  test("clearing a fence resolves pending waits and stale releases cannot unlock a new writer", async () => {
    const gate = coordinator();
    const model = anthropicModel();
    const payload = encoded();
    const first = await gate.acquire(payload, model);
    const waiting = gate.acquire(payload, model);
    gate.clear();
    (await waiting)();
    const current = await gate.acquire(payload, model);
    first(true);
    let started = false;
    const next = gate.acquire(payload, model).then((release) => { started = true; return release; });
    await Promise.resolve();
    expect(started).toBe(false);
    current(true);
    (await next)();
  });

  test("the timeout is only an abandoned-writer fail-safe, never a provider-start delay", async () => {
    const gate = coordinator(10);
    const model = anthropicModel();
    const payload = encoded();
    const first = await gate.acquire(payload, model);
    // No response or cancellation: the abandoned lease must not hang another call.
    const second = await gate.acquire(payload, model);
    second();
    first();
    // A new independent request acquires immediately without waiting for that timer.
    const fresh = await gate.acquire(payload, model);
    fresh();
  });
});

describe("System One messages through OptChat", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = new Harness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** A message as the wire carries it, minus the cache marks that OptChat adds as metadata. */
  function withoutMarks(message: unknown): unknown {
    return JSON.parse(JSON.stringify(message, (key, value: unknown) => (key === "cache_control" ? undefined : value)));
  }

  /** One chat with a stated rule and a merged view line, sent with the gates on or all opted out. */
  async function chatRequest(gates: boolean) {
    const { host, judge } = await harness.open({
      flags: gates ? SMALL_NODES : { ...SMALL_NODES, ...ALL_GATES_OFF },
      routes: { ruleWhen: "French", prefetch: [FIRST_MERGED_LINE] },
    });
    let transcript = await talk(host, [], RULE_TEXT);
    if (gates) await until(() => hasNotice(host, RULE_ADDED), "rule r1");
    for (const text of SEED_TEXTS) transcript = await talk(host, transcript, text);
    return { request: await encodeMainRequest(host, transcript, "book the table for two"), judge };
  }

  test("rules and prefetch follow the view: system, tools and view bytes match a run with every gate opted out", async () => {
    const on = await chatRequest(true);
    const off = await chatRequest(false);

    // Preconditions: the gates-on run carried a merged line judged for prefetch, and the gates-off run judged nothing.
    expect(on.judge.requests.some((r) => Object.keys(r.questions).includes(FIRST_MERGED_LINE))).toBe(true);
    expect(off.judge.requests).toHaveLength(0);

    expect(on.request.system).toEqual(off.request.system);
    expect(on.request.tools).toEqual(off.request.tools);
    // The view's text, block split and order are byte-identical. Cache marks are metadata: a view-end mark may
    // appear once System One messages follow it, so the marks are bounded separately below.
    expect(withoutMarks(on.request.messages[0])).toEqual(withoutMarks(off.request.messages[0]));
    // Anthropic accepts at most four breakpoints per request; the extra messages must not push past it.
    expect(JSON.stringify(on.request.payload).split('"cache_control"').length - 1).toBeLessThanOrEqual(4);

    const body = JSON.stringify(on.request.messages);
    const view = body.indexOf("<chat>");
    expect(body.indexOf("<rules>")).toBeGreaterThan(view);
    expect(body.indexOf("<prefetch>")).toBeGreaterThan(body.indexOf("<rules>"));
    expect(JSON.stringify(off.request.messages)).not.toMatch(/<rules>|<prefetch>/);
    // The user's own message stays last in both requests.
    expect(on.request.messages.at(-1)).toEqual(off.request.messages.at(-1));
  });
});
