import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Memory } from "../src/memory.ts";
import { Store } from "../src/store.ts";
import { IMPORT_TEXTS, PREFIX, pngFixture, type Scenario, type Stage } from "./helpers/crash-child.ts";

const childPath = fileURLToPath(new URL("./helpers/crash-child.ts", import.meta.url));
// Liveness deadlines for a real child process: fake timers cannot drive an out-of-process SIGKILL.
const deadlineMs = 15_000;
const PREFIX_TEXTS = PREFIX.map((p) => p.text);
const digestName = /^[0-9a-f]{64}$/;
const imageTempName = /^\.image-[0-9a-f-]{36}\.tmp$/;
const viewTempName = /^\.view-[0-9a-f-]{36}\.tmp$/;
const hitLine = /^hit (.+) (\d+) main=(\d+) tree=(\d+)$/;
const fixtureBase64 = new Map([1, 2, 3, 4, 5].map((seed) => {
  const fixture = pngFixture(seed);
  return [fixture.descriptor.sha256, fixture.base64] as const;
}));

interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  readonly stage: Stage;
  readonly nth: number;
  /** Tree node key that must be committed before counting begins. */
  readonly after?: string;
  /** Acknowledged records printed before the kill (setup prefix included). */
  readonly acked: number;
  /** Complete durable records present before reopen, unacknowledged ones included. */
  readonly recovered: number;
  readonly torn?: boolean;
  readonly imageFiles: number;
  readonly imageTemps: number;
  readonly viewTemps: number;
  readonly viewLength: number;
  readonly treeNodes?: number;
}

interface Ack {
  readonly i: number;
  readonly kind: string;
  readonly text: string;
  readonly size: number;
  readonly date: string;
  readonly metadata?: unknown;
}

interface Raw {
  readonly mainLines: number;
  readonly torn: boolean;
  readonly treeNodes: string[];
  readonly imageFiles: string[];
  readonly imageTemps: string[];
  readonly viewTemps: string[];
  readonly viewLength: number;
}

// Each case names the exact stage hit, the acknowledged prefix, and the disk state the kill must leave.
// Appends fsync the record before the view commit, so view stages already hold the new record.
// Import pre-saves both image blobs (A, C) before any append; C stays unreferenced when killed earlier.
const appendBase = { scenario: "append", acked: 2 } as const;
const importBase = { scenario: "import" } as const;
const summaryBase = { scenario: "summary", acked: 2, recovered: 2, imageFiles: 2, imageTemps: 0, viewTemps: 0, viewLength: 2 } as const;

const cases: readonly Case[] = [
  // Memory.append of a new image-bearing message: blob saved, then record, then view.
  { ...appendBase, name: "append: image temp write", stage: "image temp write", nth: 1, recovered: 2, imageFiles: 2, imageTemps: 1, viewTemps: 0, viewLength: 2 },
  { ...appendBase, name: "append: image temp fsync", stage: "image temp fsync", nth: 1, recovered: 2, imageFiles: 2, imageTemps: 1, viewTemps: 0, viewLength: 2 },
  { ...appendBase, name: "append: image rename", stage: "image rename", nth: 1, recovered: 2, imageFiles: 2, imageTemps: 1, viewTemps: 0, viewLength: 2 },
  { ...appendBase, name: "append: images directory fsync", stage: "images directory fsync", nth: 1, recovered: 2, imageFiles: 3, imageTemps: 0, viewTemps: 0, viewLength: 2 },
  { ...appendBase, name: "append: main write", stage: "main write", nth: 1, recovered: 2, imageFiles: 3, imageTemps: 0, viewTemps: 0, viewLength: 2 },
  { ...appendBase, name: "append: torn main write", stage: "main torn write", nth: 1, recovered: 2, torn: true, imageFiles: 3, imageTemps: 0, viewTemps: 0, viewLength: 2 },
  { ...appendBase, name: "append: main fsync", stage: "main fsync", nth: 1, recovered: 3, imageFiles: 3, imageTemps: 0, viewTemps: 0, viewLength: 2 },
  { ...appendBase, name: "append: view temp write", stage: "view temp write", nth: 1, recovered: 3, imageFiles: 3, imageTemps: 0, viewTemps: 1, viewLength: 2 },
  { ...appendBase, name: "append: view rename", stage: "view rename", nth: 1, recovered: 3, imageFiles: 3, imageTemps: 0, viewTemps: 1, viewLength: 2 },
  { ...appendBase, name: "append: root directory fsync", stage: "root directory fsync", nth: 1, recovered: 3, imageFiles: 3, imageTemps: 0, viewTemps: 0, viewLength: 3 },

  // A real level-1 summary commit: leaves 0:0 and 0:1 are saved first, then 1:0.
  { ...summaryBase, name: "summary: first leaf tree write", stage: "tree node write", nth: 1, treeNodes: 0 },
  { ...summaryBase, name: "summary: parent node tree write", stage: "tree node write", nth: 3, treeNodes: 2 },
  { ...summaryBase, name: "summary: view temp write after parent", stage: "view temp write", nth: 1, after: "1:0", treeNodes: 3, viewTemps: 1 },
  { ...summaryBase, name: "summary: view rename after parent", stage: "view rename", nth: 1, after: "1:0", treeNodes: 3, viewTemps: 1 },
  { ...summaryBase, name: "summary: root directory fsync after parent", stage: "root directory fsync", nth: 1, after: "1:0", treeNodes: 3, viewTemps: 0 },

  // history.importHistory: blobs A and C are saved first, then one actual Memory.append per record.
  { ...importBase, name: "import: image temp write of A", stage: "image temp write", nth: 1, acked: 2, recovered: 2, imageFiles: 2, imageTemps: 1, viewTemps: 0, viewLength: 2 },
  { ...importBase, name: "import: image temp write of C (A saved)", stage: "image temp write", nth: 2, acked: 2, recovered: 2, imageFiles: 3, imageTemps: 1, viewTemps: 0, viewLength: 2 },
  { ...importBase, name: "import: image temp fsync of A", stage: "image temp fsync", nth: 1, acked: 2, recovered: 2, imageFiles: 2, imageTemps: 1, viewTemps: 0, viewLength: 2 },
  { ...importBase, name: "import: image rename of C (A saved)", stage: "image rename", nth: 2, acked: 2, recovered: 2, imageFiles: 3, imageTemps: 1, viewTemps: 0, viewLength: 2 },
  { ...importBase, name: "import: images directory fsync of A", stage: "images directory fsync", nth: 1, acked: 2, recovered: 2, imageFiles: 3, imageTemps: 0, viewTemps: 0, viewLength: 2 },
  { ...importBase, name: "import: main write of B (C unreferenced)", stage: "main write", nth: 2, acked: 3, recovered: 3, imageFiles: 4, imageTemps: 0, viewTemps: 0, viewLength: 3 },
  { ...importBase, name: "import: torn main write of B", stage: "main torn write", nth: 2, acked: 3, recovered: 3, torn: true, imageFiles: 4, imageTemps: 0, viewTemps: 0, viewLength: 3 },
  { ...importBase, name: "import: main fsync of B (unacknowledged)", stage: "main fsync", nth: 2, acked: 3, recovered: 4, imageFiles: 4, imageTemps: 0, viewTemps: 0, viewLength: 3 },
  { ...importBase, name: "import: main write of A", stage: "main write", nth: 1, acked: 2, recovered: 2, imageFiles: 4, imageTemps: 0, viewTemps: 0, viewLength: 2 },
  { ...importBase, name: "import: view temp write after B record", stage: "view temp write", nth: 2, acked: 3, recovered: 4, imageFiles: 4, imageTemps: 0, viewTemps: 1, viewLength: 3 },
  { ...importBase, name: "import: view rename after A record", stage: "view rename", nth: 1, acked: 2, recovered: 3, imageFiles: 4, imageTemps: 0, viewTemps: 1, viewLength: 2 },
  { ...importBase, name: "import: root directory fsync after A record", stage: "root directory fsync", nth: 1, acked: 2, recovered: 3, imageFiles: 4, imageTemps: 0, viewTemps: 0, viewLength: 3 },
];

async function withDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${description}`)), deadlineMs);
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Accumulates all stdout so ack lines are never lost, and signals the first readiness line. */
function observeStdout(stream: ReadableStream<Uint8Array>) {
  const ready = Promise.withResolvers<void>();
  const output = (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (/^ready$/m.test(text)) ready.resolve();
    }
    text += decoder.decode();
    ready.reject(new Error(`Crash child exited before readiness: ${text}`));
    return text;
  })();
  return { ready: ready.promise, output };
}

async function entries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readRaw(directory: string): Promise<Raw> {
  let mainLines = 0;
  let torn = false;
  for (const name of await entries(join(directory, "main"))) {
    const bytes = await readFile(join(directory, "main", name));
    for (const byte of bytes) if (byte === 10) mainLines++;
    if (bytes.length > 0 && bytes.at(-1) !== 10) torn = true;
  }
  const treeNodes: string[] = [];
  for (const name of await entries(join(directory, "tree"))) {
    for (const line of (await readFile(join(directory, "tree", name), "utf8")).split("\n")) {
      if (line.length === 0) continue;
      const node: { l: number; i: number } = JSON.parse(line);
      treeNodes.push(`${node.l}:${node.i}`);
    }
  }
  const imageEntries = await entries(join(directory, "images"));
  const imageFiles = imageEntries.filter((name) => digestName.test(name));
  const imageTemps = imageEntries.filter((name) => imageTempName.test(name));
  expect(imageFiles.length + imageTemps.length).toBe(imageEntries.length);
  const root = await entries(directory);
  const viewTemps = root.filter((name) => viewTempName.test(name));
  expect(root.filter((name) => !["main", "tree", "images", "view.json"].includes(name) && !viewTempName.test(name))).toEqual([]);
  const view: { length: number } = JSON.parse(await readFile(join(directory, "view.json"), "utf8"));
  return { mainLines, torn, treeNodes, imageFiles, imageTemps, viewTemps, viewLength: view.length };
}

async function runCrash(c: Case): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "omp-optchat-crash-"));
  const directory = join(base, "store");
  let memory: Memory | undefined;
  let store: Store | undefined;
  try {
    // ---- Kill the child at the armed stage (setup acknowledged, then armed) ----
    const child = Bun.spawn(
      [process.execPath, childPath, JSON.stringify({ directory, scenario: c.scenario, stage: c.stage, nth: c.nth, after: c.after })],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const stdout = observeStdout(child.stdout);
    await withDeadline(stdout.ready, `crash child readiness for ${c.name}`);
    const [output, errors] = await withDeadline(
      Promise.all([stdout.output, new Response(child.stderr).text(), child.exited]).then(([out, err]) => [out, err] as const),
      `crash child exit for ${c.name}`,
    );
    if (child.signalCode !== "SIGKILL" || child.exitCode !== null) {
      throw new Error(`expected SIGKILL, got signal=${child.signalCode} code=${child.exitCode}: ${errors}`);
    }
    const lines = output.split("\n").filter((line) => line.length > 0);
    const hit = hitLine.exec(lines.at(-1) ?? "");
    if (hit === null) throw new Error(`stage was not hit; last line: ${lines.at(-1)}`);
    expect(hit[1]).toBe(c.stage);
    expect(Number(hit[2])).toBe(c.nth);
    const hitMain = Number(hit[3]);
    const hitTree = Number(hit[4]);

    // Acknowledgements are exact, contiguous IDs in script order.
    const acks: Ack[] = lines.filter((line) => line.startsWith("ack ")).map((line) => JSON.parse(line.slice(4)));
    const script = c.scenario === "import" ? [...PREFIX_TEXTS, ...IMPORT_TEXTS] : PREFIX_TEXTS;
    expect(acks.length).toBe(c.acked);
    expect(acks.map((ack) => ack.i)).toEqual(Array.from({ length: c.acked }, (_, i) => i));
    expect(acks.map((ack) => ack.text)).toEqual(script.slice(0, c.acked));

    // ---- Disk state before recovery: every stage-specific expectation ----
    const raw = await readRaw(directory);
    expect(raw.mainLines).toBe(PREFIX.length + hitMain);
    expect(raw.mainLines).toBe(c.recovered);
    expect(raw.torn).toBe(c.torn ?? false);
    expect(raw.treeNodes.length).toBe(hitTree);
    expect(raw.treeNodes.length).toBe(c.treeNodes ?? 0);
    expect(raw.imageFiles.length).toBe(c.imageFiles);
    expect(raw.imageTemps.length).toBe(c.imageTemps);
    expect(raw.viewTemps.length).toBe(c.viewTemps);
    expect(raw.viewLength).toBe(c.viewLength);

    // ---- Reopen: replay, repair, and orphan GC run at open ----
    const reports: string[] = [];
    store = await Store.open(directory, (message) => reports.push(message));
    expect(store.messages.length).toBe(c.recovered);
    expect(store.messages.map((message) => message.i)).toEqual(Array.from({ length: c.recovered }, (_, i) => i));
    expect(store.viewSnapshot?.length ?? 0).toBeLessThanOrEqual(store.messages.length);
    if (c.torn) {
      expect(reports.some((message) => message.startsWith("Recovered missing final newline at "))).toBe(true);
      expect(reports.some((message) => message.startsWith("Skipping malformed JSON"))).toBe(true);
    }
    // Acknowledged records match exactly; the normalized JSON form covers text, date, size, and metadata.
    for (const ack of acks) expect(JSON.parse(JSON.stringify(store.messages[ack.i]))).toEqual(ack);
    for (const message of store.messages) {
      const images = store.readMessageImages(message.i);
      expect(images.map((image) => image.data)).toEqual((message.metadata?.images ?? []).map((image) => fixtureBase64.get(image.sha256)!));
    }

    // Orphan GC: only referenced blobs remain; no temp files; main log is newline-terminated.
    const referenced = [...new Set(store.messages.flatMap((message) => (message.metadata?.images ?? []).map((image) => image.sha256)))].sort();
    const afterOpen = await readRaw(directory);
    expect(afterOpen.imageFiles).toEqual(referenced);
    expect(afterOpen.imageTemps).toEqual([]);
    expect(afterOpen.viewTemps).toEqual([]);
    expect(afterOpen.torn).toBe(false);

    memory = new Memory(store, async () => "summary", { report: (message) => reports.push(message) });
    expect(await memory.settle()).toBe(true);
    if (c.scenario === "summary") {
      expect([...store.nodes.keys()].sort()).toEqual(["0:0", "0:1", "1:0"]);
    }
    const parts = memory.viewParts();
    let covered = 0;
    for (const part of parts) {
      expect(part.i * 2 ** part.l).toBe(covered);
      covered += 2 ** part.l;
    }
    expect(covered).toBe(store.messages.length);

    // ---- Post-recovery append gets a fresh ID and persists across another reopen ----
    const next = memory.append("talk", "after recovery", new Date("2026-10-11T12:00:00.000Z"));
    expect(next.i).toBe(c.recovered);
    expect(acks.some((ack) => ack.i === next.i)).toBe(false);
    expect(await memory.settle()).toBe(true);
    await memory.close();
    memory = undefined;
    await store.close();
    store = undefined;

    const reopened = await Store.open(directory);
    try {
      expect(reopened.messages.length).toBe(c.recovered + 1);
      expect(reopened.messages.at(-1)?.text).toBe("after recovery");
      for (const ack of acks) expect(JSON.parse(JSON.stringify(reopened.messages[ack.i]))).toEqual(ack);
    } finally {
      await reopened.close();
    }
  } finally {
    await memory?.close();
    await store?.close();
    await rm(base, { recursive: true, force: true });
  }
}

describe("crash recovery matrix (real SIGKILL at syscall stages)", () => {
  for (const c of cases) {
    test(c.name, () => runCrash(c), 30_000);
  }
});
