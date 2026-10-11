import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateImage, type ImageAttachment } from "../src/archive.js";
import { exportHtml, exportJsonl, importHistory } from "../src/history.js";
import { Memory } from "../src/memory.js";
import { Store, type Kind, type Message, type TreeNode } from "../src/store.js";

const DEFAULT_DATE = "2026-01-02T03:04:05.000Z";
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
const messageSize = (kind: string, text: string): number => bytes(`${kind}: ${text}`);
const jsonl = (records: readonly unknown[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n");

interface Fixture {
  messages?: readonly Message[];
  nodes?: readonly TreeNode[];
  view?: ReadonlyArray<{ l: number; i: number }>;
}

// Exercise the helpers without a host, compressor, filesystem, lock, clock, or session.
// Image-bearing paths use a real Store; the fixture has no image methods and fails loudly if reached.
function fixture({ messages: initial = [], nodes: initialNodes = [], view = [] }: Fixture = {}) {
  const messages = initial.map((message) => ({ ...message }));
  const nodes = new Map<string, TreeNode>(initialNodes.map((node) => [`${node.l}:${node.i}`, { ...node }] as const));
  const appends: Array<{ kind: Kind; text: string; date?: Date }> = [];
  const noImages = (): never => {
    throw new Error("fixture has no image store");
  };
  const memory = {
    store: {
      messages,
      nodes,
      readMessageImages: (): never[] => [],
      readImage: noImages,
      saveImage: noImages,
    },
    append(kind: Kind, text: string, date?: Date): Message {
      appends.push({ kind, text, date });
      const message: Message = {
        i: messages.length,
        kind,
        text,
        size: messageSize(kind, text),
        date: date ? date.toISOString() : DEFAULT_DATE,
      };
      messages.push(message);
      return message;
    },
    viewParts: () => view,
  };
  return { memory: memory as unknown as Memory, messages, nodes, appends };
}

async function withRealMemory(run: (memory: Memory) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "optchat-history-"));
  try {
    const store = await Store.open(join(root, "chat"));
    try {
      // These tiny records fit below the default compaction threshold.
      const memory = new Memory(store, async () => {
        throw new Error("unexpected history test compaction");
      });
      try {
        await run(memory);
      } finally {
        await memory.close();
      }
    } finally {
      await store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mainState(store: Store) {
  const directory = join(store.directory, "main");
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async (name) => ({ name, contents: await readFile(join(directory, name)) })));
}

function localMainFile(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}.jsonl`;
}

function message(i: number, kind: Kind, text: string, date = DEFAULT_DATE): Message {
  return { i, kind, text, size: messageSize(kind, text), date };
}

function expectRejectedWithoutAppend(input: string, initial: readonly Message[] = []) {
  const state = fixture({ messages: initial });
  const before = state.messages.map((entry) => ({ ...entry }));
  expect(() => importHistory(state.memory, input)).toThrow();
  expect(state.appends).toEqual([]);
  expect(state.messages).toEqual(before);
}

describe("importHistory", () => {
  test("preserves plain text verbatim as one note, including whitespace and markup", () => {
    const state = fixture();
    const text = "  Imported notes\n\n你好 & <script>alert('data')</script>\n  {not json}\n";
    expect(importHistory(state.memory, text)).toBe(1);
    expect(state.appends).toEqual([{ kind: "note", text, date: undefined }]);
    expect(state.messages[0]).toMatchObject({ i: 0, kind: "note", text });
  });

  test.each(["", " \t\r\n \n"])("empty input %j does not append", (input) => {
    const existing = message(0, "user", "Already stored");
    const state = fixture({ messages: [existing] });
    expect(importHistory(state.memory, input)).toBe(0);
    expect(state.appends).toEqual([]);
    expect(state.messages).toEqual([existing]);
  });

  test("imports unindexed JSONL after existing history with every kind, dates, sizes, and blank lines", () => {
    const state = fixture({ messages: [message(0, "user", "Already stored")] });
    const kinds: Kind[] = ["user", "talk", "tool", "echo", "note"];
    const records = kinds.map((kind, index) => {
      const text = `${kind}: 你好\nline ${index}`;
      return { kind, text, date: `2025-12-0${index + 1}T12:34:56.789Z`, size: messageSize(kind, text) };
    });
    const input = `\n  ${JSON.stringify(records[0])}\n\n${jsonl(records.slice(1))}\n\r\n`;
    expect(importHistory(state.memory, input)).toBe(records.length);
    expect(state.messages.slice(1)).toEqual(records.map((record, index) => ({ ...record, i: index + 1 })));
    expect(state.appends.map((call) => call.date?.toISOString())).toEqual(records.map((record) => record.date));
  });

  test("accepts any Date.parse-able date string and omits absent dates", () => {
    const state = fixture();
    const date = "2024-02-29T23:59:59+02:00";
    expect(importHistory(state.memory, jsonl([{ kind: "note", text: "dated", date }, { kind: "talk", text: "undated" }]))).toBe(2);
    expect(state.appends[0]!.date?.getTime()).toBe(Date.parse(date));
    expect(state.appends[1]!.date).toBeUndefined();
  });

  test.each([
    ["+010000-06-15T12:34:56.789+02:30", "+010000-06-15T10:04:56.789Z"],
    ["-000001-06-15T12:34:56.789-03:30", "-000001-06-15T16:04:56.789Z"],
  ])("persists historical and expanded date %s on the local write day", async (date, canonicalDate) => {
    await withRealMemory(async (memory) => {
      const input = jsonl([
        { kind: "user", text: "past", date: "1999-06-15T12:34:56.789+02:30" },
        { kind: "note", text: "era", date },
      ]);
      const expected = [
        message(0, "user", "past", "1999-06-15T10:04:56.789Z"),
        message(1, "note", "era", canonicalDate),
      ];
      const before = new Date();
      const count = importHistory(memory, input);
      const after = new Date();
      expect(count).toBe(2);
      expect(memory.store.messages).toEqual(expected);

      const files = await mainState(memory.store);
      expect(files.length).toBeGreaterThan(0);
      const writeDays = [localMainFile(before), localMainFile(after)];
      for (const { name } of files) expect(writeDays).toContain(name);
      const persisted = files.flatMap(({ contents }) =>
        contents.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line)),
      );
      expect(persisted).toEqual(expected);
    });
  });

  test.each([
    [0, false], [1, false], [0, true], [1, true],
  ] as const)("invalid date at index %i leaves real main storage unchanged (seeded: %s)", async (index, seeded) => {
    await withRealMemory(async (memory) => {
      if (seeded) memory.append("user", "seed");
      const records = [
        { kind: "note", text: "valid", date: "1999-06-15T12:34:56.789+02:30" },
        { kind: "note", text: "invalid", date: "not-a-date" },
      ];
      if (index === 0) records.reverse();
      const input = jsonl(records);
      const messagesBefore = memory.store.messages.map((entry) => ({ ...entry }));
      const mainBefore = await mainState(memory.store);
      if (seeded) {
        expect(messagesBefore).toHaveLength(1);
        expect(mainBefore.length).toBeGreaterThan(0);
      } else {
        expect(messagesBefore).toEqual([]);
        expect(mainBefore).toEqual([]);
      }

      expect(() => importHistory(memory, input)).toThrow();
      expect(memory.store.messages).toEqual(messagesBefore);
      expect(await mainState(memory.store)).toEqual(mainBefore);
    });
  });

  test("imports the full indexed main-log schema into empty history without changing IDs", () => {
    const state = fixture();
    const records: Message[] = [
      message(0, "user", "你好", "2024-02-29T23:59:59.123Z"),
      message(1, "talk", "A\nB", "2024-03-01T00:00:00.001Z"),
      message(2, "note", "", "2024-03-01T01:02:03.004Z"),
    ];
    expect(records[0]!.size).toBe(12);
    expect(importHistory(state.memory, jsonl(records))).toBe(3);
    expect(state.messages).toEqual(records);
  });

  test("accepts consecutive indexed records without optional size and date", () => {
    const state = fixture();
    expect(importHistory(state.memory, jsonl([
      { i: 0, kind: "note", text: "first" },
      { i: 1, kind: "user", text: "second" },
    ]))).toBe(2);
    expect(state.messages.map(({ i, kind, text }) => ({ i, kind, text }))).toEqual([
      { i: 0, kind: "note", text: "first" },
      { i: 1, kind: "user", text: "second" },
    ]);
  });

  test("refuses indexed import into nonempty history even when the next ID would match", () => {
    for (const i of [0, 1]) {
      expectRejectedWithoutAppend(jsonl([{ i, kind: "note", text: "must not renumber" }]), [message(0, "user", "Already stored")]);
    }
  });

  test.each([
    [1, 2], [0, 0], [0, 2], [1, 0], [0, -1], [0, 1.5], [0, "1"], [0, null],
  ])("rejects invalid index sequence %p, %p atomically", (first, second) => {
    expectRejectedWithoutAppend(jsonl([
      { i: first, kind: "note", text: "first" },
      { i: second, kind: "note", text: "second" },
    ]));
  });

  test("rejects mixed indexed and unindexed records in either order", () => {
    const indexed = { i: 0, kind: "note", text: "indexed" };
    const unindexed = { kind: "note", text: "unindexed" };
    expectRejectedWithoutAppend(jsonl([indexed, unindexed]));
    expectRejectedWithoutAppend(jsonl([unindexed, indexed]));
    expectRejectedWithoutAppend(jsonl([{ i: 0, kind: "note", text: "a" }, unindexed, { i: 2, kind: "note", text: "c" }]));
  });

  test("parses every JSONL line before appending any record", () => {
    expectRejectedWithoutAppend(`${jsonl([{ kind: "note", text: "valid first" }])}\n{"kind":"note","text":`);
    expectRejectedWithoutAppend(`${jsonl([{ kind: "note", text: "valid first" }])}\nplain text after JSON`);
  });

  test("rejects top-level JSON arrays rather than treating them as batches", () => {
    expectRejectedWithoutAppend(JSON.stringify([{ kind: "note", text: "array item" }]));
  });

  test.each([
    { kind: "assistant", text: "not an OptChat kind" },
    { kind: "thought", text: "must never ingest hidden reasoning" },
    { kind: "transcript", text: "not an OptChat kind" },
    { text: "missing kind" },
    { kind: "note" },
    { kind: "note", text: "unknown field", role: "user" },
    { kind: "note", text: "bad date", date: "not-a-date" },
    { kind: "note", text: "bad date type", date: 1720000000000 },
    { kind: "note", text: "null date", date: null },
    { kind: "note", text: "你好", size: bytes("你好") },
    { kind: "note", text: "你好", size: 2 },
    { kind: "note", text: "x", size: -1 },
    { kind: "note", text: "x", size: 1.5 },
    { kind: "note", text: "x", size: "7" },
    { kind: "note", text: 123 },
    null,
    ["note", "not a record"],
  ])("rejects a later invalid record without appending the valid prefix: %j", (invalid) => {
    expectRejectedWithoutAppend(jsonl([{ kind: "user", text: "valid first" }, invalid]), [message(0, "user", "Already stored")]);
  });

  test("rejects arbitrary OMP transcript JSON instead of importing messages or thoughts", () => {
    const transcript = [
      { type: "session", version: 3, id: "unrelated-session", timestamp: DEFAULT_DATE },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } },
      { type: "message", message: { role: "user", content: "hello" } },
    ];
    expectRejectedWithoutAppend(jsonl(transcript));
    expectRejectedWithoutAppend(JSON.stringify({ messages: transcript }));
    expectRejectedWithoutAppend(jsonl([{ kind: "note", text: "valid first" }, transcript[1]]));
  });
});

// Real markup tags only: escaped history text cannot contain a literal "<".
function tags(html: string): Array<{ name: string; attributes: string }> {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)].map((match) => ({
    name: match[1]!.toLowerCase(),
    attributes: match[2]!,
  }));
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((match) => match[1]!);
}

function decode(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Elements carrying fragment IDs are articles or sections; neither nests itself.
function element(html: string, id: string): string {
  const open = html.match(new RegExp(`<(article|section)\\b[^>]*\\sid="${id}"[^>]*>`));
  expect(open).not.toBeNull();
  const start = open!.index!;
  const end = html.indexOf(`</${open![1]}>`, start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

const hrefs = (html: string): string[] => attributeValues(html, "href");

const XSS_TEXT = `</pre><script>alert("text")</script><img src=x onerror=alert('img')> & "quoted"`;
const XSS_DATE = `2026-01-01T00:00:00.000Z"><script>alert('date')</script><a href="https://evil.example/`;
const NODE_TEXT = "摘要 é <b>bold</b>";

function historyFixture(view: ReadonlyArray<{ l: number; i: number }>) {
  const messages = [
    message(0, "user", XSS_TEXT, "2026-01-01T00:00:00.000Z"),
    message(1, "talk", "reply 你好", XSS_DATE),
    message(2, "tool", "tool output", "2026-01-01T00:02:00.000Z"),
    message(3, "echo", "echo output", "2026-01-01T00:03:00.000Z"),
  ];
  const nodes: TreeNode[] = [
    { l: 0, i: 0, text: `user: ${XSS_TEXT}`, size: messageSize("user", XSS_TEXT) },
    { l: 0, i: 1, text: "talk: reply 你好", size: bytes("talk: reply 你好") },
    { l: 0, i: 2, text: "tool: tool output", size: bytes("tool: tool output") },
    { l: 1, i: 0, text: NODE_TEXT, size: bytes(NODE_TEXT) },
    { l: 1, i: 1, text: "tool and echo", size: bytes("tool and echo") },
    { l: 2, i: 0, text: `everything ${XSS_TEXT}`, size: bytes(`everything ${XSS_TEXT}`) },
  ];
  return fixture({ messages, nodes, view });
}

describe("exportHtml", () => {
  const view = [{ l: 1, i: 0 }, { l: 0, i: 2 }, { l: 0, i: 3 }];

  test("is a static document whose only markup comes from the exporter", () => {
    const html = exportHtml(historyFixture(view).memory);
    const names = tags(html).map((tag) => tag.name);
    expect(names).toContain("html");
    for (const forbidden of ["script", "iframe", "img", "object", "embed", "link", "form", "base"]) {
      expect(names).not.toContain(forbidden);
    }
    for (const { attributes } of tags(html)) {
      // Every attribute is a bare name or a double-quoted value that never broke out of its quotes.
      expect(attributes).toMatch(/^(?:\s+[a-zA-Z-]+(?:="[^"<>]*")?)*\s*\/?$/);
      expect(attributes).not.toMatch(/\son[a-z]+=/i);
      expect(attributes).not.toMatch(/\s(?:src|http-equiv)=/i);
    }
    // History text may mention URLs; only stylesheet or link-driven fetches matter.
    expect(html).not.toMatch(/url\(|@import/i);
    for (const href of hrefs(html)) expect(href.startsWith("#")).toBe(true);
  });

  test("escapes malicious message text and preserves it as readable data", () => {
    const html = exportHtml(historyFixture(view).memory);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("</pre><script");
    expect(decode(element(html, "raw-0"))).toContain(XSS_TEXT);
    expect(decode(element(html, "node-0-0"))).toContain(XSS_TEXT);
    expect(decode(element(html, "node-2-0"))).toContain(`everything ${XSS_TEXT}`);
    expect(decode(element(html, "view-1-0"))).toContain(NODE_TEXT);
  });

  test("escapes a malicious stored date in text and attributes", () => {
    const html = exportHtml(historyFixture(view).memory);
    expect(html).not.toContain(`"><script`);
    expect(attributeValues(html, "datetime").map(decode)).toContain(XSS_DATE);
    expect(decode(element(html, "raw-1"))).toContain(XSS_DATE);
    expect(decode(element(html, "view-1-0"))).toContain(XSS_DATE);
  });

  test("escapes hostile work provenance fields and never emits them as markup", () => {
    const hostileId = `"><script>alert('id')</script>`;
    const hostileAgent = `</p><img src=x onerror=alert('agent')>`;
    const work = message(0, "work", "report body", "2026-01-01T00:00:00.000Z");
    const state = fixture({
      messages: [{ ...work, metadata: { work: { source: "task", completeness: "full", id: hostileId, agentId: hostileAgent } } }],
    });
    const html = exportHtml(state.memory);
    expect(html).not.toContain("<script>alert('id')");
    expect(html).not.toContain("<img src=x onerror=alert('agent')");
    expect(decode(element(html, "raw-0"))).toContain(`id ${hostileId}`);
    expect(decode(element(html, "raw-0"))).toContain(`agent ${hostileAgent}`);
  });

  test("includes the current view, ROOT records, and every stored tree level", () => {
    const html = exportHtml(historyFixture(view).memory);
    const ids = new Set(attributeValues(html, "id"));
    for (const id of [
      "view", "root", "level-0", "level-1", "level-2",
      "raw-0", "raw-1", "raw-2", "raw-3",
      "node-0-0", "node-0-1", "node-0-2", "node-1-0", "node-1-1", "node-2-0",
      "view-1-0", "view-0-2", "view-0-3",
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has("node-0-3")).toBe(false);
    expect(ids.has("level-3")).toBe(false);

    const currentView = element(html, "view");
    const viewOrder = ["view-1-0", "view-0-2", "view-0-3"].map((id) => currentView.indexOf(`id="${id}"`));
    expect(viewOrder.every((index) => index >= 0)).toBe(true);
    expect([...viewOrder].sort((a, b) => a - b)).toEqual(viewOrder);

    const root = element(html, "root");
    const rootOrder = [0, 1, 2, 3].map((i) => root.indexOf(`id="raw-${i}"`));
    expect(rootOrder.every((index) => index >= 0)).toBe(true);
    expect([...rootOrder].sort((a, b) => a - b)).toEqual(rootOrder);
    expect(decode(root)).toContain("echo output");

    const level1 = attributeValues(element(html, "level-1"), "id");
    expect(level1).toContain("node-1-0");
    expect(level1).toContain("node-1-1");
    expect(level1).not.toContain("node-0-0");
    expect(attributeValues(element(html, "level-2"), "id")).toContain("node-2-0");
  });

  test("every fragment link resolves to an element in the document", () => {
    const html = exportHtml(historyFixture(view).memory);
    const ids = new Set(attributeValues(html, "id"));
    const links = hrefs(html);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(ids.has(href.slice(1))).toBe(true);
    const header = html.slice(0, html.indexOf('id="view"'));
    for (const target of ["#view", "#root", "#level-0", "#level-1", "#level-2"]) expect(hrefs(header)).toContain(target);
  });

  test("view nodes link canonical tree nodes, children, and raw range endpoints", () => {
    const html = exportHtml(historyFixture(view).memory);
    const parent = hrefs(element(html, "view-1-0"));
    for (const target of ["#node-1-0", "#node-0-0", "#node-0-1", "#raw-0", "#raw-1"]) expect(parent).toContain(target);

    const leaf = hrefs(element(html, "view-0-2"));
    expect(leaf).toContain("#node-0-2");
    expect(leaf).toContain("#raw-2");

    const canonical = hrefs(element(html, "node-2-0"));
    for (const target of ["#node-1-0", "#node-1-1", "#raw-0", "#raw-3"]) expect(canonical).toContain(target);
  });

  test("an unsummarized view node is labelled pending and still links its raw message", () => {
    const html = exportHtml(historyFixture(view).memory);
    const pending = element(html, "view-0-3");
    expect(decode(pending).toLowerCase()).toContain("pending");
    expect(hrefs(pending)).toContain("#raw-3");
    expect(hrefs(pending)).not.toContain("#node-0-3");
  });

  test("node and raw metadata include range, time span, and UTF-8 byte size", () => {
    const html = exportHtml(historyFixture(view).memory);
    const parent = decode(element(html, "view-1-0"));
    expect(parent).toContain("0+2");
    expect(parent).toContain("2026-01-01T00:00:00.000Z");
    expect(parent).toContain(XSS_DATE);
    expect(parent).toMatch(new RegExp(`\\b${bytes(NODE_TEXT)} UTF-8 bytes`));
    expect(bytes(NODE_TEXT)).not.toBe(NODE_TEXT.length);

    const root = decode(element(html, "node-2-0"));
    expect(root).toContain("0+4");
    expect(root).toContain("2026-01-01T00:00:00.000Z");
    expect(root).toContain("2026-01-01T00:03:00.000Z");

    const raw = decode(element(html, "raw-1"));
    expect(raw).toContain("1+1");
    expect(raw).toMatch(new RegExp(`\\b${messageSize("talk", "reply 你好")} UTF-8 bytes`));
    expect(raw).toContain("talk");
  });

  test("renders empty memory without view, records, or tree levels", () => {
    const html = exportHtml(fixture().memory);
    const ids = attributeValues(html, "id");
    expect(ids).toContain("view");
    expect(ids).toContain("root");
    expect(ids.some((id) => /^(raw|node|level|view)-/.test(id))).toBe(false);
    for (const href of hrefs(html)) expect(ids).toContain(href.slice(1));
  });
});

// Genuine 8-bit RGB PNGs: zlib-deflated scanlines with correct chunk CRCs, decodable by any PNG reader.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png(width: number, height: number, shade: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3, shade);
  row[0] = 0; // filter: none
  const scanlines = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_A = png(2, 3, 40).toString("base64");
const PNG_B = png(1, 4, 200).toString("base64");
const PNG_A_DESCRIPTOR = validateImage(PNG_A, "image/png").descriptor;

// Metadata refs and inline payloads, built from genuine bytes.
function refOf(data: string, order: number): ImageAttachment {
  return { ...validateImage(data, "image/png").descriptor, order };
}

function inlineOf(data: string, order: number): Record<string, unknown> {
  return { ...refOf(data, order), data };
}

// Rejections must leave no message, no main-log byte, and no image file behind.
async function expectRejectedWithoutWrites(input: string): Promise<void> {
  await withRealMemory(async (memory) => {
    const mainBefore = await mainState(memory.store);
    expect(() => importHistory(memory, input)).toThrow();
    expect(memory.store.messages).toEqual([]);
    expect(await mainState(memory.store)).toEqual(mainBefore);
    expect(await readdir(join(memory.store.directory, "images"))).toEqual([]);
  });
}

describe("archive JSONL and provenance with a real Store", () => {
  test("export then import reproduces metadata, IDs, dates, and image bytes exactly", async () => {
    let exported = "";
    let sourceMessages: Message[] = [];
    await withRealMemory(async (memory) => {
      memory.append("work", "report <b>body</b>", new Date(DEFAULT_DATE), {
        work: { source: "task", completeness: "pointer-only", id: "job-1", name: "scout", agentId: "a<1>" },
        images: [
          { ...memory.store.saveImage(PNG_A, "image/png"), order: 0 },
          { ...memory.store.saveImage(PNG_B, "image/png"), order: 3 },
        ],
      });
      memory.append("user", "plain");
      exported = exportJsonl(memory);
      sourceMessages = memory.store.messages.map((entry) => ({ ...entry }));
    });
    await withRealMemory(async (memory) => {
      expect(importHistory(memory, exported)).toBe(2);
      expect(memory.store.messages).toEqual(sourceMessages);
      expect(memory.store.messages[1]!.metadata).toBeUndefined();
      expect(memory.store.readMessageImages(0).map(({ attachment, data }) => ({ sha256: attachment.sha256, order: attachment.order, data })))
        .toEqual([
          { sha256: validateImage(PNG_A, "image/png").descriptor.sha256, order: 0, data: PNG_A },
          { sha256: validateImage(PNG_B, "image/png").descriptor.sha256, order: 3, data: PNG_B },
        ]);
      expect(exportJsonl(memory)).toBe(exported);
    });
  });

  test("exports one strict record shape: metadata refs plus one inline payload per ref", async () => {
    await withRealMemory(async (memory) => {
      memory.append("work", "text", new Date(DEFAULT_DATE), {
        work: { source: "task", completeness: "full" },
        images: [{ ...memory.store.saveImage(PNG_A, "image/png"), order: 1 }],
      });
      const [record] = exportJsonl(memory).trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(Object.keys(record)).toEqual(["i", "kind", "text", "date", "size", "metadata", "images"]);
      expect(Object.keys(record.metadata)).toEqual(["work", "images"]);
      expect(record.metadata.images).toEqual([{ ...PNG_A_DESCRIPTOR, order: 1 }]);
      expect(record.images).toEqual([{ ...PNG_A_DESCRIPTOR, order: 1, data: PNG_A }]);
    });
  });

  test("a legacy payload-only record without metadata refs imports with its payloads as refs", async () => {
    await withRealMemory(async (memory) => {
      const input = jsonl([{
        kind: "work", text: "legacy", date: DEFAULT_DATE,
        metadata: { work: { source: "task", completeness: "full" } },
        images: [inlineOf(PNG_A, 2)],
      }]);
      expect(importHistory(memory, input)).toBe(1);
      expect(memory.store.messages[0]!.metadata).toEqual({
        work: { source: "task", completeness: "full" },
        images: [{ ...PNG_A_DESCRIPTOR, order: 2 }],
      });
      expect(memory.store.readMessageImages(0)[0]!.data).toBe(PNG_A);
    });
  });

  test("raw persisted metadata-only refs import when the image is already durable", async () => {
    await withRealMemory(async (memory) => {
      memory.store.saveImage(PNG_A, "image/png");
      const raw = jsonl([{
        i: 0, kind: "work", text: "raw", date: DEFAULT_DATE, size: messageSize("work", "raw"),
        metadata: { work: { source: "task", completeness: "full" }, images: [{ ...PNG_A_DESCRIPTOR, order: 0 }] },
      }]);
      expect(importHistory(memory, raw)).toBe(1);
      expect(memory.store.readMessageImages(0)[0]!.data).toBe(PNG_A);
    });
  });

  test("raw metadata-only refs are rejected without writes when the image is absent", async () => {
    await expectRejectedWithoutWrites(jsonl([{
      kind: "note", text: "raw", metadata: { images: [{ ...PNG_A_DESCRIPTOR, order: 0 }] },
    }]));
  });

  test("a metadata-only ref is satisfied by identical bytes supplied in the same import", async () => {
    await withRealMemory(async (memory) => {
      const input = jsonl([
        { kind: "note", text: "refers", metadata: { images: [refOf(PNG_A, 0)] } },
        { kind: "note", text: "supplies", metadata: { images: [refOf(PNG_A, 1)] }, images: [inlineOf(PNG_A, 1)] },
      ]);
      expect(importHistory(memory, input)).toBe(2);
      expect(memory.store.readMessageImages(0)[0]!.data).toBe(PNG_A);
      expect(memory.store.readMessageImages(1)[0]!.data).toBe(PNG_A);
    });
  });

  test("a metadata-only ref whose descriptor disagrees with the supplied bytes is rejected", async () => {
    await expectRejectedWithoutWrites(jsonl([
      { kind: "note", text: "refers", metadata: { images: [{ ...refOf(PNG_A, 0), width: 9 }] } },
      { kind: "note", text: "supplies", metadata: { images: [refOf(PNG_A, 1)] }, images: [inlineOf(PNG_A, 1)] },
    ]));
  });

  test.each([
    ["fewer payloads than refs", [refOf(PNG_A, 0), refOf(PNG_B, 3)], [inlineOf(PNG_A, 0)]],
    ["payloads out of order", [refOf(PNG_A, 0), refOf(PNG_B, 3)], [inlineOf(PNG_B, 3), inlineOf(PNG_A, 0)]],
    ["payload bytes differ from ref", [refOf(PNG_A, 0)], [inlineOf(PNG_B, 0)]],
    ["payload order differs from ref", [refOf(PNG_A, 0)], [inlineOf(PNG_A, 1)]],
    ["extra payload beyond refs", [refOf(PNG_A, 0)], [inlineOf(PNG_A, 0), inlineOf(PNG_B, 1)]],
  ] as const)("inline images must match metadata refs one-to-one: %s", async (_name, refs, payloads) => {
    await expectRejectedWithoutWrites(jsonl([{
      kind: "work", text: "mismatch",
      metadata: { work: { source: "task", completeness: "full" }, images: refs },
      images: payloads,
    }]));
  });

  test("an inline payload whose claimed digest or size lies is rejected before any write", async () => {
    const lying = { ...inlineOf(PNG_A, 0), bytes: PNG_A_DESCRIPTOR.bytes + 1 };
    await expectRejectedWithoutWrites(jsonl([{ kind: "note", text: "lying", images: [lying] }]));
  });

  test("zero-length image arrays are invalid whether top-level or in metadata", () => {
    expectRejectedWithoutAppend(jsonl([{ kind: "note", text: "empty inline", images: [] }]));
    expectRejectedWithoutAppend(jsonl([{ kind: "note", text: "empty refs", metadata: { images: [] } }]));
  });

  test("an oversized inline image array is rejected before any entry is inspected", () => {
    const thirtyThree = Array.from({ length: 33 }, () => ({}));
    expectRejectedWithoutAppend(jsonl([{ kind: "note", text: "too many", images: thirtyThree }]));
  });

  test("unknown fields are rejected in records, metadata, and inline payloads", () => {
    expectRejectedWithoutAppend(jsonl([{
      kind: "note", text: "record field", images: [{ ...inlineOf(PNG_A, 0), role: "user" }],
    }]));
    expectRejectedWithoutAppend(jsonl([{
      kind: "work", text: "metadata field", metadata: { work: { source: "task", completeness: "full", extra: 1 } },
    }]));
    expectRejectedWithoutAppend(jsonl([{
      kind: "note", text: "metadata ref field", metadata: { images: [{ ...refOf(PNG_A, 0), extra: true }] },
    }]));
  });

  test("work kind must carry work metadata even when images are present", () => {
    expectRejectedWithoutAppend(jsonl([{
      kind: "work", text: "no provenance", images: [inlineOf(PNG_A, 0)],
    }]));
  });

  test("a bad image in any record stops the whole import before any append or image write", async () => {
    const lying = { ...PNG_A_DESCRIPTOR, width: PNG_A_DESCRIPTOR.width + 1 };
    const input = jsonl([
      { kind: "note", text: "valid first", images: [inlineOf(PNG_A, 0)] },
      { kind: "note", text: "lying dimensions", images: [{ ...lying, order: 0, data: PNG_A }] },
    ]);
    await expectRejectedWithoutWrites(input);
  });

  test("a valid genuine image followed by an invalid raw tail writes neither image nor record", async () => {
    await expectRejectedWithoutWrites(jsonl([
      { kind: "note", text: "valid first", images: [inlineOf(PNG_B, 0)] },
      { kind: "note", text: "tail", metadata: { images: [{ ...PNG_A_DESCRIPTOR, order: 0 }] } },
    ]));
  });

  test("a corrupt durable image fails export and metadata-only import without repair", async () => {
    await withRealMemory(async (memory) => {
      const descriptor = memory.store.saveImage(PNG_A, "image/png");
      memory.append("work", "report", new Date(DEFAULT_DATE), {
        work: { source: "task", completeness: "full" },
        images: [{ ...descriptor, order: 0 }],
      });
      const path = join(memory.store.directory, "images", descriptor.sha256);
      const corrupted = Buffer.from(await readFile(path));
      corrupted[corrupted.length - 1]! ^= 0xff;
      await rm(path);
      await writeFile(path, corrupted);

      expect(() => exportJsonl(memory)).toThrow();
      const before = memory.store.messages.length;
      expect(() => importHistory(memory, jsonl([{
        kind: "note", text: "raw", metadata: { images: [{ ...descriptor, order: 0 }] },
      }]))).toThrow();
      expect(memory.store.messages).toHaveLength(before);
    });
  });

  test("HTML export escapes provenance and shows images only as validated data URIs", async () => {
    let html = "";
    await withRealMemory(async (memory) => {
      memory.append("work", "text", new Date(DEFAULT_DATE), {
        work: { source: "task", completeness: "full", name: `<img src=x onerror="alert(1)">` },
        images: [{ ...memory.store.saveImage(PNG_A, "image/png"), order: 0 }],
      });
      html = exportHtml(memory);
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain(`src="data:image/png;base64,${PNG_A}"`);
  });
});
