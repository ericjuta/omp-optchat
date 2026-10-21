import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, type ImageDescriptor, type ImageMimeType } from "../src/archive.ts";
import { appendMetric, METRICS_FILE } from "../src/metrics.ts";
import { Store, StoreLeaseConflictError, fdPath, nodeKey, type Kind, type Message, type TreeNode } from "../src/store.ts";
import { LEDGER_FILE, RuleLedger } from "../src/system1/ledger.ts";

const storeModule = fileURLToPath(new URL("../src/store.ts", import.meta.url));
const livenessTimeoutMs = 5_000;

// These deadlines bound hung test processes, never the lifetime of a storage lock.
async function withDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  // Cancellable timer, so a settled operation never leaves a pending deadline behind.
  const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${description}`)), livenessTimeoutMs);
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function spawnStoreProcess(directory: string, body: string): StoreProcess {
  const code = `import { Store } from ${JSON.stringify(storeModule)};\nconst directory = ${JSON.stringify(directory)};\n${body}`;
  return Bun.spawn([process.execPath, "-e", code], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

type StoreProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

async function waitForReady(child: StoreProcess): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let ready = false;
  try {
    await withDeadline((async () => {
      let output = "";
      while (!output.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Holder exited before readiness: ${output}`);
        output += decoder.decode(chunk.value, { stream: true });
      }
      expect(output.split("\n")[0]).toBe("ready");
      ready = true;
    })(), "holder readiness");
  } finally {
    if (!ready) await reader.cancel();
    reader.releaseLock();
  }
}

async function processResult(child: StoreProcess) {
  const [code, stdout, stderr] = await withDeadline(Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]), "storage subprocess exit");
  return { code, stdout, stderr };
}

interface Fixture {
  root: string;
  directory: string;
  open: (report?: (message: string) => void, directory?: string) => Promise<Store>;
  spawn: (body: string, directory?: string) => StoreProcess;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "optchat-store-"));
  const directory = join(root, "chat");
  const stores: Store[] = [];
  const children: StoreProcess[] = [];
  try {
    await run({
      root,
      directory,
      async open(report, target = directory) {
        const store = await Store.open(target, report);
        stores.push(store);
        return store;
      },
      spawn(body, target = directory) {
        const child = spawnStoreProcess(target, body);
        children.push(child);
        return child;
      },
    });
  } finally {
    // Settle all child writers and close handles before removing their real files.
    try {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode === null) child.kill("SIGKILL");
        await withDeadline(child.exited, "child cleanup");
      }));
    } finally {
      try {
        await Promise.all(stores.map((store) => store.close()));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

// Fakes only Date's wall clock (the Store's write-day source) for synchronous work.
function atClock<T>(clock: Date, run: () => T): T {
  setSystemTime(clock);
  try {
    return run();
  } finally {
    setSystemTime();
  }
}

function day(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function message(i: number, text = `message ${i}`, kind: Kind = "user", date = new Date("2026-01-10T12:00:00.000Z")): Message {
  return { i, kind, text, size: Buffer.byteLength(`${kind}: ${text}`, "utf8"), date: date.toISOString() };
}

function node(l: number, i: number, text = `summary ${l}:${i}`): TreeNode {
  return { l, i, text, size: Buffer.byteLength(text, "utf8") };
}

async function seed(directory: string, stream: "main" | "tree", filename: string, records: readonly unknown[], suffix = ""): Promise<string> {
  const parent = join(directory, stream);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, filename);
  await writeFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join("") + suffix, { mode: 0o600 });
  return path;
}

async function streamContents(directory: string, stream: "main" | "tree"): Promise<string> {
  const parent = join(directory, stream);
  const files = (await readdir(parent)).sort();
  return (await Promise.all(files.map((file) => readFile(join(parent, file), "utf8")))).join("");
}

describe("Store real-filesystem persistence", () => {
  test("durable append is visible before close; restart preserves UTF-8, kinds, IDs and timestamps", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const date = new Date(2026, 0, 10, 23, 58, 57, 123);
      const text = "é 漢字 👩🏽‍💻\nsecond line\t\"quoted\"";
      const kinds: Kind[] = ["user", "talk", "tool", "echo", "note"];
      const expected = kinds.map((kind, i) => message(i, text, kind, date));
      for (const record of expected) {
        expect(store.append(record.kind, record.text, date)).toEqual(record);
      }
      const leaf = node(0, 0, "résumé 🌳");
      store.saveNode(leaf);
      expect(store.messages).toEqual(expected);
      expect(store.nodes.get(nodeKey(0, 0))).toEqual(leaf);
      expect(await streamContents(fixture.directory, "main"))
        .toBe(expected.map((record) => `${JSON.stringify(record)}\n`).join(""));
      expect(await streamContents(fixture.directory, "tree")).toBe(`${JSON.stringify(leaf)}\n`);
      await store.close();

      const restarted = await fixture.open();
      expect(restarted.messages).toEqual(expected);
      expect([...restarted.nodes.values()]).toEqual([leaf]);
      expect(restarted.append("user", "after restart", date).i).toBe(5);
      await restarted.close();
      expect((await fixture.open()).messages.map((record) => record.i)).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });

  test("default timestamp falls between the append's wall-clock observations", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const before = Date.now();
      const record = store.append("user", "clock");
      const after = Date.now();
      expect(Date.parse(record.date)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(record.date)).toBeLessThanOrEqual(after);
      expect(record.date).toBe(new Date(record.date).toISOString());
    });
  });

  test("daily files use the local write day and replay by permanent ID despite a backdated clock", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const clocks = [new Date(2026, 2, 3, 12), new Date(2026, 2, 1, 12), new Date(2026, 2, 2, 12)];
      const historical = new Date("1999-12-31T23:59:59.999Z");
      const expected = clocks.map((clock, i) => atClock(clock, () => store.append("note", `day ${i}`, historical)));
      expect(expected.map((record) => record.date)).toEqual(clocks.map(() => historical.toISOString()));
      expect((await readdir(join(fixture.directory, "main"))).sort())
        .toEqual(clocks.map((clock) => `${day(clock)}.jsonl`).sort());
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.messages).toEqual(expected);
      expect(restarted.append("talk", "fourth", historical).i).toBe(3);
      await restarted.close();
      expect((await fixture.open()).messages.map((record) => record.i)).toEqual([0, 1, 2, 3]);
    });
  });

  test("historical and expanded-year message dates are preserved in the write-day file", async () => {
    await withFixture(async (fixture) => {
      const clock = new Date(2026, 6, 4, 9);
      const dates = [
        new Date("1999-06-15T10:00:00.000Z"),
        new Date("+020000-01-01T00:00:00.000Z"),
        new Date("-000001-07-01T00:00:00.000Z"),
      ];
      const store = await fixture.open();
      const appended = atClock(clock, () => dates.map((date, i) => store.append("note", `era ${i}`, date)));
      expect(appended.map((record) => record.date)).toEqual(dates.map((date) => date.toISOString()));
      expect(await readdir(join(fixture.directory, "main"))).toEqual([`${day(clock)}.jsonl`]);
      await store.close();
      expect((await fixture.open()).messages).toEqual(appended);
    });
  });

  test("tree replay gathers child nodes across daily files before validating parents", async () => {
    await withFixture(async (fixture) => {
      await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0), message(1)]);
      const parent = node(1, 0);
      const left = node(0, 0);
      const right = node(0, 1);
      await seed(fixture.directory, "tree", "2026-01-01.jsonl", [parent]);
      await seed(fixture.directory, "tree", "2026-01-02.jsonl", [right]);
      await seed(fixture.directory, "tree", "2026-01-03.jsonl", [left]);
      const store = await fixture.open();
      expect(store.nodes.size).toBe(3);
      for (const value of [parent, left, right]) expect(store.nodes.get(nodeKey(value.l, value.i))).toEqual(value);
    });
  });

  test("reports torn lines, restores newline boundaries, and keeps appending across restarts", async () => {
    await withFixture(async (fixture) => {
      const date = new Date(2026, 4, 6, 12);
      const filename = `${day(date)}.jsonl`;
      const first = message(0, "before tear", "user", date);
      const leaf = node(0, 0);
      const mainPath = await seed(fixture.directory, "main", filename, [first], '{"i":1,"text":');
      const treePath = await seed(fixture.directory, "tree", filename, [], '{"l":0,"i":');
      const reports: string[] = [];
      const store = await fixture.open((report) => reports.push(report));
      for (const path of [mainPath, treePath]) {
        expect(reports.some((report) => report.includes(path) && /malformed|torn|invalid/i.test(report))).toBe(true);
      }
      expect(store.messages).toEqual([first]);
      expect(store.nodes.size).toBe(0);
      expect((await readFile(mainPath, "utf8")).endsWith("\n")).toBe(true);
      expect((await readFile(treePath, "utf8")).endsWith("\n")).toBe(true);
      const second = atClock(date, () => store.append("talk", "after tear", date));
      atClock(date, () => store.saveNode(leaf));
      expect(second.i).toBe(1);
      expect(await readFile(mainPath, "utf8")).toBe(`${JSON.stringify(first)}\n{"i":1,"text":\n${JSON.stringify(second)}\n`);
      expect(await streamContents(fixture.directory, "tree")).toContain(`${JSON.stringify(leaf)}\n`);
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.messages).toEqual([first, second]);
      expect(restarted.nodes.get(nodeKey(0, 0))).toEqual(leaf);
      expect(restarted.append("note", "third", date).i).toBe(2);
      await restarted.close();
      expect((await fixture.open()).messages.map((record) => record.i)).toEqual([0, 1, 2]);
    });
  });

  test("a valid final JSON record without newline is retained and separated from the next append", async () => {
    await withFixture(async (fixture) => {
      const date = new Date(2026, 4, 6, 12);
      const first = message(0, "complete without newline", "user", date);
      const path = await seed(fixture.directory, "main", `${day(date)}.jsonl`, [], JSON.stringify(first));
      const store = await fixture.open();
      expect(store.messages).toEqual([first]);
      const second = atClock(date, () => store.append("talk", "next", date));
      expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
      await store.close();
      expect((await fixture.open()).messages).toEqual([first, second]);
    });
  });

  test("replay syncs every admitted file before open returns and rejects recovery when that sync fails", async () => {
    await withFixture(async (fixture) => {
      // Complete, newline-terminated records a killed writer never fsynced look
      // identical to durable ones, so replay must sync them before publishing.
      const files = [
        await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0)]),
        await seed(fixture.directory, "main", "2026-01-02.jsonl", [message(1)]),
        await seed(fixture.directory, "tree", "2026-01-02.jsonl", [node(0, 0)]),
      ];
      const targets = await Promise.all(files.map((path) => realpath(path)));
      const fsync = fs.fsyncSync;
      const synced: string[] = [];
      const spy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
        synced.push(fdPath(fd));
        fsync(fd);
      });
      try {
        const store = await fixture.open();
        expect(targets.filter((target) => !synced.includes(target))).toEqual([]);
        await store.close();
        spy.mockImplementation((fd: number) => {
          if (fdPath(fd) === targets[1]) {
            throw Object.assign(new Error("injected replay fsync failure"), { code: "EIO" });
          }
          fsync(fd);
        });
        await expect(fixture.open()).rejects.toThrow("injected replay fsync failure");
      } finally {
        spy.mockRestore();
      }
      // The failed recovery published nothing and released its lease immediately.
      expect((await fixture.open()).messages).toEqual([message(0), message(1)]);
    });
  });

  test("a torn line cannot hide a permanent ID gap in later valid history", async () => {
    await withFixture(async (fixture) => {
      const path = await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0)], '{"i":1,\n');
      await appendFile(path, `${JSON.stringify(message(2))}\n`);
      const reports: string[] = [];
      await expect(fixture.open((report) => reports.push(report))).rejects.toThrow();
      expect(reports.some((report) => report.includes(path))).toBe(true);
    });
  });

  test("invalid UTF-8 bytes are reported and skipped while neighboring IDs stay contiguous", async () => {
    await withFixture(async (fixture) => {
      const path = await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0)]);
      await appendFile(path, Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
      await appendFile(path, `${JSON.stringify(message(1))}\n`);
      const reports: string[] = [];
      const store = await fixture.open((report) => reports.push(report));
      expect(reports.some((report) => report.includes(path))).toBe(true);
      expect(store.messages).toEqual([message(0), message(1)]);
      expect(store.append("talk", "after invalid bytes").i).toBe(2);
    });
  });

  test("malformed JSON inside a file is reported without discarding later valid IDs", async () => {
    await withFixture(async (fixture) => {
      const path = await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0)], "not-json\n");
      await appendFile(path, `${JSON.stringify(message(1))}\n`);
      const reports: string[] = [];
      const store = await fixture.open((report) => reports.push(report));
      expect(reports.length).toBeGreaterThan(0);
      expect(store.messages).toEqual([message(0), message(1)]);
    });
  });
});

describe("Store record validation", () => {
  test.each([
    { name: "missing ID zero", records: [message(1)] },
    { name: "interior gap", records: [message(0), message(2)] },
    { name: "identical duplicate message", records: [message(0), message(0)] },
    { name: "conflicting duplicate message", records: [message(0), message(0, "different")] },
  ])("rejects $name rather than reassigning permanent IDs", async ({ records }) => {
    await withFixture(async (fixture) => {
      await seed(fixture.directory, "main", "2026-01-01.jsonl", records);
      await expect(fixture.open()).rejects.toThrow();
    });
  });

  test("duplicate IDs across daily files are rejected", async () => {
    await withFixture(async (fixture) => {
      await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0)]);
      await seed(fixture.directory, "main", "2026-01-02.jsonl", [message(0)]);
      await expect(fixture.open()).rejects.toThrow();
    });
  });

  test.each([
    { name: "UTF-8 size mismatch", value: { ...message(0, "é"), size: 7 } },
    { name: "fractional ID", value: { ...message(0), i: 0.5 } },
    { name: "negative ID", value: { ...message(0), i: -1 } },
    { name: "unknown kind", value: { ...message(0), kind: "thought" } },
    { name: "non-string text", value: { ...message(0), text: 17 } },
    { name: "invalid timestamp", value: { ...message(0), date: "not-a-date" } },
    { name: "missing timestamp", value: { i: 0, kind: "user", text: "x", size: 7 } },
    { name: "noncanonical timestamp", value: { ...message(0), date: "2026-01-10T12:00:00+00:00" } },
    { name: "unknown field", value: { ...message(0), reasoning: "not admitted" } },
    { name: "unsafe ID", value: { ...message(0), i: Number.MAX_SAFE_INTEGER + 1 } },
    { name: "null record", value: null },
    { name: "array record", value: [] },
  ])("rejects invalid message schema: $name", async ({ value }) => {
    await withFixture(async (fixture) => {
      await seed(fixture.directory, "main", "2026-01-01.jsonl", [value]);
      await expect(fixture.open()).rejects.toThrow();
    });
  });

  test("a failed open releases the lock so repaired history opens immediately", async () => {
    await withFixture(async (fixture) => {
      const path = await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0), message(2)]);
      await expect(fixture.open()).rejects.toThrow();
      await writeFile(path, `${JSON.stringify(message(0))}\n${JSON.stringify(message(1))}\n`);
      expect((await fixture.open()).messages).toEqual([message(0), message(1)]);
    });
  });

  test("published messages and nodes are frozen snapshots of caller input", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const appended = store.append("user", "source");
      const input = node(0, 0, "original");
      store.saveNode(input);
      input.text = "mutated by caller";
      const saved = store.nodes.get(nodeKey(0, 0))!;
      expect(saved).toEqual(node(0, 0, "original"));
      expect(Object.isFrozen(appended)).toBe(true);
      expect(Object.isFrozen(store.messages[0])).toBe(true);
      expect(Object.isFrozen(saved)).toBe(true);
      expect(() => { (appended as { text: string }).text = "rewritten"; }).toThrow();
      expect(() => { (saved as { text: string }).text = "rewritten"; }).toThrow();
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.messages[0]!.text).toBe("source");
      expect(restarted.nodes.get(nodeKey(0, 0))!.text).toBe("original");
    });
  });

  test("invalid append inputs do not consume an ID or publish a record", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      expect(() => store.append("thought" as Kind, "hidden")).toThrow();
      expect(() => store.append("user", 123 as unknown as string)).toThrow();
      expect(() => store.append("user", "bad date", new Date(NaN))).toThrow();
      expect(store.messages).toEqual([]);
      expect(store.append("user", "valid").i).toBe(0);
      await store.close();
      expect((await fixture.open()).messages.map((record) => record.text)).toEqual(["valid"]);
    });
  });

  test("identical node saves are idempotent and conflicts never change memory or disk", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "source");
      const leaf = node(0, 0, "résumé");
      store.saveNode(leaf);
      const bytes = await streamContents(fixture.directory, "tree");
      store.saveNode({ ...leaf });
      expect(await streamContents(fixture.directory, "tree")).toBe(bytes);
      expect(() => store.saveNode(node(0, 0, "conflict"))).toThrow();
      expect(store.nodes.get(nodeKey(0, 0))).toEqual(leaf);
      expect(await streamContents(fixture.directory, "tree")).toBe(bytes);
      await store.close();
      const restarted = await fixture.open();
      restarted.saveNode({ ...leaf });
      expect(await streamContents(fixture.directory, "tree")).toBe(bytes);
      expect(() => restarted.saveNode(node(0, 0, "still conflicting"))).toThrow();
    });
  });

  test("replay accepts identical cached nodes but rejects conflicts", async () => {
    await withFixture(async (fixture) => {
      await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0)]);
      const leaf = node(0, 0);
      await seed(fixture.directory, "tree", "2026-01-01.jsonl", [leaf, { ...leaf }]);
      const store = await fixture.open();
      expect(store.nodes.size).toBe(1);
      await store.close();
      await seed(fixture.directory, "tree", "2026-01-02.jsonl", [node(0, 0, "conflicting")]);
      await expect(fixture.open()).rejects.toThrow();
    });
  });

  test.each([
    { name: "leaf beyond history", value: node(0, 2) },
    { name: "parent beyond history", value: node(2, 0) },
    { name: "negative level", value: node(-1, 0) },
    { name: "fractional level", value: node(0.5, 0) },
    { name: "negative index", value: node(0, -1) },
    { name: "fractional index", value: node(0, 0.5) },
    { name: "unsupported level", value: node(53, 0) },
    { name: "unsafe endpoint", value: node(1, Number.MAX_SAFE_INTEGER) },
    { name: "incorrect UTF-8 size", value: { ...node(0, 0, "é"), size: 1 } },
    { name: "empty summary", value: node(0, 0, "") },
    { name: "non-string summary", value: { ...node(0, 0), text: 123 } as unknown as TreeNode },
    { name: "missing size", value: { l: 0, i: 0, text: "summary" } as TreeNode },
    { name: "unknown field", value: { ...node(0, 0), extra: true } },
    { name: "missing children", value: node(1, 0) },
  ])("rejects invalid node on save and replay: $name", async ({ value }) => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "first");
      store.append("talk", "second");
      expect(() => store.saveNode(value)).toThrow();
      expect(store.nodes.size).toBe(0);
      await store.close();
      await seed(fixture.directory, "tree", "2026-01-01.jsonl", [value]);
      await expect(fixture.open()).rejects.toThrow();
    });
  });

  test("parent requires both child nodes and persists once the complete range exists", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      expect(() => store.saveNode(node(0, 0))).toThrow();
      store.append("user", "first");
      store.append("talk", "second");
      store.saveNode(node(0, 0));
      expect(() => store.saveNode(node(1, 0))).toThrow();
      store.saveNode(node(0, 1));
      store.saveNode(node(1, 0));
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.nodes.size).toBe(3);
      expect(restarted.nodes.get(nodeKey(1, 0))).toEqual(node(1, 0));
    });
  });
});

type ViewSnapshot = Parameters<Store["saveView"]>[0];

function snapshotOf(length: number, parts: ReadonlyArray<readonly [number, number]>, compacting: boolean): ViewSnapshot {
  return { version: 2, length, parts, compacting, compactor: { length: 0, parts: [], compacting: false } };
}

function rawView(length: number, compacting = false): ViewSnapshot {
  return snapshotOf(length, Array.from({ length }, (_, i) => [0, i] as const), compacting);
}

describe("Store v2 snapshot admission", () => {
  test("a v1 disk snapshot loads once, then migrates to v2 without changing the main tiling", async () => {
    await withFixture(async (fixture) => {
      await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0), message(1), message(2), message(3)]);
      await seed(fixture.directory, "tree", "2026-01-01.jsonl", [node(0, 0), node(0, 1), node(1, 0)]);
      const parts: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 2], [0, 3]];
      await writeFile(join(fixture.directory, "view.json"), `${JSON.stringify({ version: 1, length: 4, parts, compacting: true })}\n`, { mode: 0o600 });
      const store = await fixture.open();
      expect(store.viewSnapshot).toEqual({ version: 1, length: 4, parts, compacting: true });
      store.saveView(snapshotOf(4, parts, true));
      expect(store.viewSnapshot).toEqual(snapshotOf(4, parts, true));
      await store.close();
      const migrated = await fixture.open();
      expect(migrated.viewSnapshot).toEqual(snapshotOf(4, parts, true));
      expect(JSON.parse(await readFile(join(fixture.directory, "view.json"), "utf8")).version).toBe(2);
      await migrated.close();
    });
  });

  test("a v2 compactor restores exactly after restart, frozen and independent of the main latch", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      for (let i = 0; i < 4; i++) store.append("user", `source ${i}`);
      store.saveNode(node(0, 0));
      store.saveNode(node(0, 1));
      store.saveNode(node(1, 0));
      const snapshot: ViewSnapshot = {
        version: 2, length: 4, parts: [[1, 0], [0, 2], [0, 3]], compacting: false,
        compactor: { length: 2, parts: [[1, 0]], compacting: true },
      };
      store.saveView(snapshot);
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.viewSnapshot).toEqual(snapshot);
      expectFrozenView(restarted.viewSnapshot!);
      expect(Object.isFrozen((restarted.viewSnapshot as ViewSnapshot).compactor)).toBe(true);
      await restarted.close();
    });
  });

  test("a compactor must tile built nodes within the main length; invalid or v1 writes change nothing", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      for (let i = 0; i < 4; i++) store.append("user", `source ${i}`);
      store.saveNode(node(0, 0));
      store.saveNode(node(0, 1));
      store.saveNode(node(1, 0));
      store.saveView(snapshotOf(0, [], false));
      const published = store.viewSnapshot;
      const main: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 2], [0, 3]];
      const rejected: unknown[] = [
        { ...snapshotOf(4, main, false), compactor: { length: 3, parts: [[1, 0], [0, 2]], compacting: false } },
        { ...snapshotOf(4, main, false), compactor: { length: 5, parts: [[1, 0], [0, 2], [0, 3], [0, 4]], compacting: false } },
        { ...snapshotOf(4, main, false), compactor: { length: 2, parts: [[0, 1]], compacting: false } },
        { ...snapshotOf(4, main, false), compactor: { length: 2, parts: [[0, 0]], compacting: false } },
        { version: 1, length: 0, parts: [], compacting: false },
      ];
      for (const bad of rejected) expect(() => store.saveView(bad as ViewSnapshot)).toThrow();
      expect(store.viewSnapshot).toBe(published);
      await store.close();
      expect((await fixture.open()).viewSnapshot).toEqual(snapshotOf(0, [], false));
    });
  });

});

function expectFrozenView(view: { readonly parts: readonly (readonly [number, number])[]; readonly compacting: boolean; readonly compactor?: ViewSnapshot["compactor"] }): void {
  if (view.compactor) expectFrozenView(view.compactor);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.parts)).toBe(true);
  expect(Reflect.set(view, "compacting", !view.compacting)).toBe(false);
  expect(() => Reflect.apply(Array.prototype.push, view.parts, [[0, 99]])).toThrow();
  for (const part of view.parts) {
    expect(Object.isFrozen(part)).toBe(true);
    expect(Reflect.set(part, "1", 99)).toBe(false);
  }
}

describe("Store view snapshot persistence", () => {
  test.each(["empty store", "legacy history"] as const)("missing snapshot remains absent for %s", async (history) => {
    await withFixture(async (fixture) => {
      if (history === "legacy history") {
        await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0), message(1)]);
        await seed(fixture.directory, "tree", "2026-01-01.jsonl", [node(0, 0), node(0, 1), node(1, 0)]);
      }
      const store = await fixture.open();
      expect(store.viewSnapshot).toBeUndefined();
      expect(store.messages).toEqual(history === "legacy history" ? [message(0), message(1)] : []);
      expect(store.nodes.size).toBe(history === "legacy history" ? 3 : 0);
      expect((await readdir(fixture.directory)).sort()).toEqual(["images", "main", "tree"]);
      await store.close();
      expect((await fixture.open()).viewSnapshot).toBeUndefined();
    });
  });

  test("snapshot replacements persist before close and round-trip raw, compacting, summary and empty views", async () => {
    await withFixture(async (fixture) => {
      let store = await fixture.open();
      for (let i = 0; i < 4; i++) store.append("user", `source ${i}`);
      for (let i = 0; i < 4; i++) store.saveNode(node(0, i));
      store.saveNode(node(1, 0));
      store.saveNode(node(1, 1));
      store.saveNode(node(2, 0));
      const messages = [...store.messages];
      const nodes = [...store.nodes];
      const mainBytes = await streamContents(fixture.directory, "main");
      const treeBytes = await streamContents(fixture.directory, "tree");
      const views: ViewSnapshot[] = [
        rawView(4),
        snapshotOf(4, [[1, 0], [0, 2], [0, 3]], true),
        snapshotOf(4, [[2, 0]], false),
        rawView(0),
      ];
      for (const view of views) {
        store.saveView(view);
        expect(store.viewSnapshot).toEqual(view);
        expect(JSON.parse(await readFile(join(fixture.directory, "view.json"), "utf8"))).toEqual(view);
        expect(await streamContents(fixture.directory, "main")).toBe(mainBytes);
        expect(await streamContents(fixture.directory, "tree")).toBe(treeBytes);
        await store.close();
        store = await fixture.open();
        expect(store.viewSnapshot).toEqual(view);
        expectFrozenView(store.viewSnapshot!);
        expect(store.messages).toEqual(messages);
        expect([...store.nodes]).toEqual(nodes);
      }
    });
  });

  test("a saved prefix survives trailing durable raw logs without silently extending its view", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "first");
      store.append("talk", "second");
      for (const summary of [node(0, 0), node(0, 1), node(1, 0)]) store.saveNode(summary);
      const prefix: ViewSnapshot = snapshotOf(2, [[1, 0]], true);
      store.saveView(prefix);
      const published = store.viewSnapshot;
      const bytes = await readFile(join(fixture.directory, "view.json"));
      store.append("tool", "durable suffix one");
      store.append("note", "durable suffix two");
      store.saveNode(node(0, 2));
      expect(store.viewSnapshot).toBe(published);
      expect(await readFile(join(fixture.directory, "view.json"))).toEqual(bytes);
      // Explicitly resaving a stale prefix must also be legal; the view owner,
      // not the store, decides when the durable suffix joins its tiling.
      store.saveView(prefix);
      await store.close();
      const recovered = await fixture.open();
      expect(recovered.viewSnapshot).toEqual(prefix);
      expect(recovered.messages.map((record) => record.text))
        .toEqual(["first", "second", "durable suffix one", "durable suffix two"]);
      expect(recovered.nodes.get(nodeKey(0, 2))).toEqual(node(0, 2));
      expect(recovered.append("echo", "next durable raw message").i).toBe(4);
      expect(recovered.viewSnapshot).toEqual(prefix);
      expect(await readFile(join(fixture.directory, "view.json"))).toEqual(bytes);
    });
  });

  test("save and load deeply copy and freeze snapshots without freezing callers or changing old snapshots", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      for (let i = 0; i < 3; i++) store.append("user", `source ${i}`);
      for (const summary of [node(0, 0), node(0, 1), node(1, 0)]) store.saveNode(summary);
      const input: {
        version: 2; length: number; parts: [number, number][]; compacting: boolean;
        compactor: { length: number; parts: [number, number][]; compacting: boolean };
      } = {
        version: 2, length: 3, parts: [[1, 0], [0, 2]], compacting: true,
        compactor: { length: 2, parts: [[1, 0]], compacting: false },
      };
      const expected: ViewSnapshot = { ...snapshotOf(3, [[1, 0], [0, 2]], true),
        compactor: { length: 2, parts: [[1, 0]], compacting: false } };
      store.saveView(input);
      const saved = store.viewSnapshot!;
      const bytes = await readFile(join(fixture.directory, "view.json"));
      expect(saved).not.toBe(input);
      expect(saved.parts).not.toBe(input.parts);
      for (let i = 0; i < saved.parts.length; i++) expect(saved.parts[i]).not.toBe(input.parts[i]);
      expectFrozenView(saved);
      expect(Object.isFrozen(input)).toBe(false);
      expect(Object.isFrozen(input.parts)).toBe(false);
      expect(Object.isFrozen(input.parts[0])).toBe(false);
      expect(saved.version).toBe(2);
      if (saved.version !== 2) throw new Error("Expected v2 snapshot");
      expect(saved.compactor).not.toBe(input.compactor);
      expect(saved.compactor.parts).not.toBe(input.compactor.parts);
      expect(saved.compactor.parts[0]).not.toBe(input.compactor.parts[0]);
      expect(Object.isFrozen(input.compactor)).toBe(false);
      expect(Object.isFrozen(input.compactor.parts)).toBe(false);
      expect(Object.isFrozen(input.compactor.parts[0])).toBe(false);
      input.compactor.length = 99;
      input.compactor.compacting = true;
      input.compactor.parts[0]![1] = 99;
      input.compactor.parts.push([0, 99]);
      input.length = 99;
      input.compacting = false;
      input.parts[0]![0] = 52;
      input.parts[1]![1] = 99;
      input.parts.push([0, 99]);
      expect(saved).toEqual(expected);
      expect(store.viewSnapshot).toBe(saved);
      expect(await readFile(join(fixture.directory, "view.json"))).toEqual(bytes);
      await store.close();

      const recovered = await fixture.open();
      const loaded = recovered.viewSnapshot!;
      expect(loaded).toEqual(expected);
      expect(loaded).not.toBe(saved);
      expect(loaded.parts).not.toBe(saved.parts);
      for (let i = 0; i < loaded.parts.length; i++) expect(loaded.parts[i]).not.toBe(saved.parts[i]);
      expectFrozenView(loaded);
      expect(await readFile(join(fixture.directory, "view.json"))).toEqual(bytes);
      recovered.saveView(rawView(3));
      expect(recovered.viewSnapshot).not.toBe(loaded);
      expect(recovered.viewSnapshot).toEqual(rawView(3));
      expect(saved).toEqual(expected);
      expect(loaded).toEqual(expected);
      expectFrozenView(saved);
      expectFrozenView(loaded);
      expect(JSON.parse(await readFile(join(fixture.directory, "view.json"), "utf8"))).toEqual(rawView(3));
    });
  });

  test("reopen reclaims only canonical stale view temporaries; malformed names and symlinks stay inert", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "source");
      store.saveView(rawView(1, true));
      await store.close();

      const canonical = "6f1d2c3b-4a5e-4b7c-9d8e-0f1a2b3c4d5e";
      const stale = `.view-${randomUUID()}.tmp`;
      const malformedNames = [
        `.view-${canonical.toUpperCase()}.tmp`,
        `.view-${canonical.replace("-4b7c", "-1b7c")}.tmp`,
        `.view-${canonical.replace("-9d8e", "-0d8e")}.tmp`,
        `.view-${canonical.replace("-9d8e", "-cd8e")}.tmp`,
        `.view-${canonical}.tmp.bak`,
        `view-${canonical}.tmp`,
        `.view-${canonical}.tmp\n`,
        `.view-${canonical}.tm`,
        ".view-00000000-0000-0000-0000-000000000000.tmp",
      ];
      const malformed = new Map(malformedNames.map((name) => [name, Buffer.from([0x7b, 0x22, 0xff, 0xfe, ...Buffer.from(name)])] as const));
      for (const [name, bytes] of malformed) await writeFile(join(fixture.directory, name), bytes, { mode: 0o600 });

      const linkName = `.view-${randomUUID()}.tmp`;
      const target = join(fixture.root, "view-target");
      const targetBytes = Buffer.from("symlink target bytes\n");
      await writeFile(target, targetBytes, { mode: 0o600 });
      await symlink(target, join(fixture.directory, linkName));
      await writeFile(join(fixture.directory, stale), Buffer.from("{}"), { mode: 0o600 });

      const viewNames = async () => (await readdir(fixture.directory)).filter((name) => name.includes("view-")).sort();
      const expectedNames = [...malformedNames, linkName].sort();
      expect(await viewNames()).toEqual([...expectedNames, stale].sort());

      const recovered = await fixture.open();
      expect(recovered.viewSnapshot).toEqual(rawView(1, true));
      expect(await viewNames()).toEqual(expectedNames);
      for (const [name, bytes] of malformed) expect(await readFile(join(fixture.directory, name))).toEqual(bytes);
      const entries = await readdir(fixture.directory, { withFileTypes: true });
      expect(entries.find((entry) => entry.name === linkName)?.isSymbolicLink()).toBe(true);
      expect(await readFile(join(fixture.directory, linkName))).toEqual(targetBytes);
      expect(await readFile(target)).toEqual(targetBytes);

      recovered.saveView(rawView(0));
      expect(recovered.viewSnapshot).toEqual(rawView(0));
      expect(await viewNames()).toEqual(expectedNames);
      await recovered.close();

      const reopened = await fixture.open();
      expect(reopened.viewSnapshot).toEqual(rawView(0));
      expect(await viewNames()).toEqual(expectedNames);
      for (const [name, bytes] of malformed) expect(await readFile(join(fixture.directory, name))).toEqual(bytes);
      expect(await readFile(join(fixture.directory, linkName))).toEqual(targetBytes);
      expect(await readFile(target)).toEqual(targetBytes);
    });
  });
});

describe("Store view snapshot durability faults", () => {
  for (const [initial, change] of [["missing snapshot", "main and compactor"], ["committed snapshot", "main and compactor"], ["committed snapshot", "compactor only"]] as const) {
    test.each(["file fsync", "root fsync", "partial write", "rename"] as const)(
      `${initial}, ${change}: %s failure withholds publication, poisons writes and recovers the committed disk state`,
      async (fault) => {
        await withFixture(async (fixture) => {
          const store = await fixture.open();
          for (let i = 0; i < 3; i++) store.append("user", `source ${i}`);
          for (const summary of [node(0, 0), node(0, 1), node(1, 0)]) store.saveNode(summary);
          const oldView: ViewSnapshot = { ...rawView(3),
            compactor: { length: 1, parts: [[0, 0]], compacting: true } };
          const nextView: ViewSnapshot = change === "compactor only"
            ? { ...oldView, compactor: { length: 2, parts: [[1, 0]], compacting: false } }
            : { ...snapshotOf(3, [[1, 0], [0, 2]], true), compactor: { length: 2, parts: [[1, 0]], compacting: false } };
          const path = join(fixture.directory, "view.json");
          if (initial === "committed snapshot") store.saveView(oldView);
          const published = store.viewSnapshot;
          const oldBytes = initial === "committed snapshot" ? await readFile(path) : undefined;
          const messages = [...store.messages];
          const nodes = [...store.nodes];
          const mainBytes = await streamContents(fixture.directory, "main");
          const treeBytes = await streamContents(fixture.directory, "tree");
          const root = store.directory;
          const isTemporary = (path: string) => path.startsWith(`${root}/.view-`) && path.endsWith(".tmp");
          const fsync = fs.fsyncSync;
          const write = fs.writeSync;
          const renameFile = fs.renameSync;
          const failure = Object.assign(new Error(`injected snapshot ${fault} failure`), { code: "EIO" });
          let hits = 0;
          let partialBytes = 0;
          let temporarySize = 0;
          let fullSize = 0;
          const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
            const target = fdPath(fd);
            if ((fault === "file fsync" && isTemporary(target)) || (fault === "root fsync" && target === root)) {
              hits++;
              throw failure;
            }
            fsync(fd);
          });
          const writeSpy = spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, ...args: unknown[]) => {
            if (fault === "partial write" && isTemporary(fdPath(fd))) {
              hits++;
              fullSize = bytes.length;
              // Write actual bytes to the actual file, not a fabricated count.
              partialBytes = write(fd, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
              temporarySize = fs.fstatSync(fd).size;
              return partialBytes;
            }
            return Reflect.apply(write, fs, [fd, bytes, ...args]);
          }) as typeof fs.writeSync);
          const renameSpy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
            if (fault === "rename" && isTemporary(fs.realpathSync(source)) && String(destination).endsWith("/view.json")) {
              hits++;
              throw failure;
            }
            renameFile(source, destination);
          });
          try {
            expect(() => store.saveView(nextView)).toThrow();
            expect(hits).toBe(1);
            if (fault === "partial write") {
              expect(partialBytes).toBeGreaterThan(0);
              expect(partialBytes).toBeLessThan(fullSize);
              expect(temporarySize).toBe(partialBytes);
            }
            expect(store.viewSnapshot).toBe(published);
            expect(() => store.append("talk", "must not publish")).toThrow();
            expect(() => store.saveNode(node(0, 2))).toThrow();
            expect(() => store.saveView(oldView)).toThrow();
            expect(hits).toBe(1);
            expect(store.viewSnapshot).toBe(published);
            expect(store.messages).toEqual(messages);
            expect([...store.nodes]).toEqual(nodes);
            expect(await streamContents(fixture.directory, "main")).toBe(mainBytes);
            expect(await streamContents(fixture.directory, "tree")).toBe(treeBytes);
            if (fault === "root fsync") {
              expect(JSON.parse(await readFile(path, "utf8"))).toEqual(nextView);
            } else if (oldBytes) {
              expect(await readFile(path)).toEqual(oldBytes);
            } else {
              await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
            }
            expect((await readdir(fixture.directory)).filter((name) => name.startsWith(".view-") && name.endsWith(".tmp")))
              .toEqual([]);
          } finally {
            renameSpy.mockRestore();
            writeSpy.mockRestore();
            fsyncSpy.mockRestore();
          }
          await store.close();
          const recovered = await fixture.open();
          expect(recovered.viewSnapshot).toEqual(fault === "root fsync" ? nextView : published);
          expect(recovered.messages).toEqual(messages);
          expect([...recovered.nodes]).toEqual(nodes);
          expect(recovered.append("talk", "writer resumed").i).toBe(3);
          recovered.saveNode(node(0, 2));
          recovered.saveView(rawView(4));
          await recovered.close();
          const restarted = await fixture.open();
          expect(restarted.viewSnapshot).toEqual(rawView(4));
          expect(restarted.messages.map((record) => record.text)).toEqual(["source 0", "source 1", "source 2", "writer resumed"]);
          expect(restarted.nodes.get(nodeKey(0, 2))).toEqual(node(0, 2));
        });
      },
    );
  }

  test.each(["file", "root"] as const)("snapshot load %s fsync failure releases the lease for immediate reopen", async (fault) => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "durable source");
      store.saveView(rawView(1, true));
      const path = join(fixture.directory, "view.json");
      const bytes = await readFile(path);
      const root = store.directory;
      await store.close();
      const fsync = fs.fsyncSync;
      let snapshotSynced = false;
      let hits = 0;
      const spy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
        const target = fdPath(fd);
        if (target === join(root, "view.json")) {
          if (fault === "file") {
            hits++;
            throw new Error("injected snapshot load fsync failure");
          }
          fsync(fd);
          snapshotSynced = true;
          return;
        }
        // Do not intercept root fsyncs used to admit the main/tree directories.
        if (fault === "root" && snapshotSynced && target === root) {
          hits++;
          throw new Error("injected snapshot load fsync failure");
        }
        fsync(fd);
      });
      try {
        await expect(fixture.open()).rejects.toThrow("injected snapshot load fsync failure");
        expect(hits).toBe(1);
        expect(await readFile(path)).toEqual(bytes);
      } finally {
        spy.mockRestore();
      }
      const recovered = await fixture.open();
      expect(recovered.viewSnapshot).toEqual(rawView(1, true));
      expect(recovered.append("talk", "recovered writer").i).toBe(1);
      recovered.saveNode(node(0, 0));
      recovered.saveView(rawView(2));
      await recovered.close();
      expect((await fixture.open()).viewSnapshot).toEqual(rawView(2));
    });
  });
});

describe("Store view snapshot privacy and lifecycle", () => {
  for (const linkType of ["symbolic", "hard"] as const) {
    test.each(["load", "save after open"] as const)(`rejects ${linkType}-linked view.json on %s without modifying target bytes or mode`, async (operation) => {
      await withFixture(async (fixture) => {
        const store = await fixture.open();
        store.append("user", "source");
        store.saveView(rawView(1));
        const published = store.viewSnapshot;
        const path = join(fixture.directory, "view.json");
        const safeBytes = await readFile(path);
        if (operation === "load") await store.close();
        const outside = join(fixture.root, "outside-view.json");
        const externalBytes = Buffer.from(`${JSON.stringify(rawView(1, true))}\n`);
        await writeFile(outside, externalBytes, { mode: 0o644 });
        await chmod(outside, 0o644);
        await rm(path);
        if (linkType === "symbolic") await symlink(outside, path);
        else await link(outside, path);
        if (operation === "load") {
          await expect(fixture.open()).rejects.toThrow();
        } else {
          expect(() => store.saveView(rawView(0))).toThrow();
          expect(store.viewSnapshot).toBe(published);
        }
        expect(await readFile(outside)).toEqual(externalBytes);
        expect((await stat(outside)).mode & 0o777).toBe(0o644);
        expect((await readdir(fixture.directory)).filter((name) => name.startsWith(".view-"))).toEqual([]);
        // Unlink only the planted name; never repair through the external inode.
        await rm(path);
        await writeFile(path, safeBytes, { mode: 0o600 });
        if (operation === "save after open") await store.close();
        const recovered = await fixture.open();
        expect(recovered.viewSnapshot).toEqual(rawView(1));
        expect(recovered.append("talk", "after link repair").i).toBe(1);
        recovered.saveView(rawView(2));
        expect(await readFile(outside)).toEqual(externalBytes);
        expect((await stat(outside)).mode & 0o777).toBe(0o644);
      });
    });
  }

  test("snapshot creation is 0600 and load/save tighten loose modes while load preserves exact content", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "source");
      const path = join(fixture.directory, "view.json");
      store.saveView(rawView(1));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await store.close();
      // Whitespace is intentional: loading must not rewrite canonical JSON.
      const bytes = Buffer.from(`\n  ${JSON.stringify(rawView(1), null, 2)}  \n`);
      await writeFile(path, bytes);
      await chmod(path, 0o644);
      const recovered = await fixture.open();
      expect(recovered.viewSnapshot).toEqual(rawView(1));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path)).toEqual(bytes);
      await chmod(path, 0o644);
      recovered.saveView(rawView(1, true));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(rawView(1, true));
      await recovered.close();
      expect((await fixture.open()).viewSnapshot).toEqual(rawView(1, true));
    });
  });

  test.each(["a fresh directory", "a symlink to another leased store"] as const)(
    "snapshot saves remain anchored to the moved root when its old path becomes %s",
    async (replacement) => {
      await withFixture(async (fixture) => {
        const store = await fixture.open();
        store.append("user", "original owner");
        store.saveView(rawView(1));
        const directory = store.directory;
        const moved = join(fixture.root, "moved-view-owner");
        await rename(fixture.directory, moved);
        const otherPath = join(fixture.root, "other-view-owner");
        const other = replacement === "a symlink to another leased store" ? await fixture.open(undefined, otherPath) : undefined;
        if (other) {
          other.append("user", "other owner");
          other.saveView(rawView(1));
          await symlink(otherPath, fixture.directory);
        } else {
          await mkdir(fixture.directory, { mode: 0o700 });
          await writeFile(join(fixture.directory, "view.json"), "fresh directory sentinel\n", { mode: 0o644 });
        }
        const replacementBytes = await readFile(join(fixture.directory, "view.json"));
        const replacementMode = (await stat(join(fixture.directory, "view.json"))).mode & 0o777;
        const otherPublished = other?.viewSnapshot;
        const mainBytes = await streamContents(moved, "main");
        const treeBytes = await streamContents(moved, "tree");
        const otherMain = other ? await streamContents(otherPath, "main") : "";
        const otherTree = other ? await streamContents(otherPath, "tree") : "";
        store.saveView(rawView(1, true));
        expect(store.directory).toBe(directory);
        expect(store.viewSnapshot).toEqual(rawView(1, true));
        expect(JSON.parse(await readFile(join(moved, "view.json"), "utf8"))).toEqual(rawView(1, true));
        expect(await readFile(join(fixture.directory, "view.json"))).toEqual(replacementBytes);
        expect((await stat(join(fixture.directory, "view.json"))).mode & 0o777).toBe(replacementMode);
        expect(await streamContents(moved, "main")).toBe(mainBytes);
        expect(await streamContents(moved, "tree")).toBe(treeBytes);
        expect((await readdir(moved)).sort()).toEqual(["images", "main", "tree", "view.json"]);
        if (other) {
          expect(other.viewSnapshot).toBe(otherPublished);
          expect(await streamContents(otherPath, "main")).toBe(otherMain);
          expect(await streamContents(otherPath, "tree")).toBe(otherTree);
          expect(other.append("talk", "other still owns its writer").i).toBe(1);
          other.saveView(rawView(2));
        } else {
          expect(await readdir(fixture.directory)).toEqual(["view.json"]);
        }
        await store.close();
        const recovered = await fixture.open(undefined, moved);
        expect(recovered.viewSnapshot).toEqual(rawView(1, true));
        expect(recovered.messages.map((record) => record.text)).toEqual(["original owner"]);
        expect(recovered.append("note", "moved writer resumed").i).toBe(1);
        recovered.saveView(rawView(2));
        expect(JSON.parse(await readFile(join(moved, "view.json"), "utf8"))).toEqual(rawView(2));
      });
    },
  );

  test("saveView rejects immediately when close starts and retains the last committed snapshot", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "kept");
      store.saveView(rawView(1, true));
      const published = store.viewSnapshot;
      const bytes = await readFile(join(fixture.directory, "view.json"));
      const closing = store.close();
      expect(() => store.saveView(rawView(0))).toThrow();
      expect(store.viewSnapshot).toBe(published);
      await Promise.all([closing, store.close()]);
      expect(() => store.saveView(rawView(1))).toThrow();
      expect(store.viewSnapshot).toBe(published);
      expect(await readFile(join(fixture.directory, "view.json"))).toEqual(bytes);
      const recovered = await fixture.open();
      expect(recovered.viewSnapshot).toEqual(rawView(1, true));
      recovered.saveView(rawView(0));
      expect(store.viewSnapshot).toBe(published);
      expect(store.viewSnapshot).toEqual(rawView(1, true));
    });
  });

  test("a committed snapshot survives SIGKILL and rejects a competing process until its holder exits", async () => {
    await withFixture(async (fixture) => {
      const holder = fixture.spawn(`
        import { createServer } from "node:net";
        const store = await Store.open(directory);
        store.append("user", "snapshot source zero");
        store.append("talk", "snapshot source one");
        for (const [l, i] of [[0, 0], [0, 1], [1, 0]]) {
          const text = "summary " + l + ":" + i;
          store.saveNode({ l, i, text, size: Buffer.byteLength(text, "utf8") });
        }
        store.saveView({ version: 2, length: 2, parts: [[1, 0]], compacting: true,
          compactor: { length: 2, parts: [[1, 0]], compacting: false } });
        // A referenced socket, not a timer or sleep, holds this real process
        // alive so the parent can exercise OS lease exclusion and SIGKILL.
        const keepAlive = createServer();
        const listening = Promise.withResolvers();
        keepAlive.once("error", listening.reject);
        keepAlive.listen(0, "127.0.0.1", listening.resolve);
        await listening.promise;
        console.log("ready");
      `);
      await waitForReady(holder);
      const snapshot: ViewSnapshot = { ...snapshotOf(2, [[1, 0]], true),
        compactor: { length: 2, parts: [[1, 0]], compacting: false } };
      expect(JSON.parse(await readFile(join(fixture.directory, "view.json"), "utf8"))).toEqual(snapshot);
      const contender = fixture.spawn(`
        let store;
        try { store = await Store.open(directory); }
        catch { console.log("rejected"); process.exit(0); }
        await store.close();
        console.error("competing snapshot writer unexpectedly acquired lock");
        process.exit(1);
      `);
      expect(await processResult(contender)).toEqual({ code: 0, stdout: "rejected\n", stderr: "" });
      expect(holder.exitCode).toBeNull();
      holder.kill("SIGKILL");
      await withDeadline(holder.exited, "snapshot holder SIGKILL exit");
      const recovered = await fixture.open();
      expect(recovered.viewSnapshot).toEqual(snapshot);
      expectFrozenView(recovered.viewSnapshot!);
      expect(recovered.messages.map((record) => record.text)).toEqual(["snapshot source zero", "snapshot source one"]);
      expect(recovered.nodes.get(nodeKey(1, 0))).toEqual(node(1, 0));
      expect((await readdir(fixture.directory)).sort()).toEqual(["images", "main", "tree", "view.json"]);
      expect(recovered.append("note", "after killed holder").i).toBe(2);
      recovered.saveNode(node(0, 2));
      const resumed: ViewSnapshot = snapshotOf(3, [[1, 0], [0, 2]], false);
      recovered.saveView(resumed);
      await recovered.close();
      const restarted = await fixture.open();
      expect(restarted.viewSnapshot).toEqual(resumed);
      expect(restarted.messages[2]!.text).toBe("after killed holder");
    });
  }, 20_000);
});

describe("Store privacy and lifecycle", () => {
  test("new directories and logs are private", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const date = new Date();
      store.append("user", "private", date);
      store.saveNode(node(0, 0));
      for (const directory of [fixture.directory, join(fixture.directory, "main"), join(fixture.directory, "tree"), join(fixture.directory, "images")]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
      for (const stream of ["main", "tree"] as const) {
        for (const filename of await readdir(join(fixture.directory, stream))) {
          expect((await stat(join(fixture.directory, stream, filename))).mode & 0o777).toBe(0o600);
        }
      }
    });
  });

  test("reopening tightens existing directory and log permissions without altering history", async () => {
    await withFixture(async (fixture) => {
      const mainPath = await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0)]);
      const treePath = await seed(fixture.directory, "tree", "2026-01-01.jsonl", [node(0, 0)]);
      const directories = [fixture.directory, join(fixture.directory, "main"), join(fixture.directory, "tree")];
      for (const directory of directories) await chmod(directory, 0o755);
      for (const path of [mainPath, treePath]) await chmod(path, 0o644);
      const store = await fixture.open();
      for (const directory of directories) expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const path of [mainPath, treePath]) expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(store.messages).toEqual([message(0)]);
      expect(store.nodes.get(nodeKey(0, 0))).toEqual(node(0, 0));
    });
  });

  test.each(["main", "tree"] as const)("rejects symlinked %s subdirectories without touching the target", async (stream) => {
    await withFixture(async (fixture) => {
      const outside = join(fixture.root, "outside");
      await mkdir(outside, { mode: 0o700 });
      await mkdir(fixture.directory, { mode: 0o700 });
      await writeFile(join(outside, "sentinel"), "untouched", { mode: 0o600 });
      await symlink(outside, join(fixture.directory, stream));
      await expect(fixture.open()).rejects.toThrow();
      expect(await readdir(outside)).toEqual(["sentinel"]);
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("untouched");
    });
  });

  for (const linkType of ["symbolic", "hard"] as const) {
    test.each(["main", "tree"] as const)(`rejects ${linkType}-linked %s log files without changing the target`, async (stream) => {
      await withFixture(async (fixture) => {
        const outside = join(fixture.root, "outside.jsonl");
        const content = `${JSON.stringify(stream === "main" ? message(0) : node(0, 0))}\n`;
        await writeFile(outside, content, { mode: 0o600 });
        await mkdir(join(fixture.directory, stream), { recursive: true, mode: 0o700 });
        if (stream === "tree") await seed(fixture.directory, "main", "2026-01-01.jsonl", [message(0)]);
        const target = join(fixture.directory, stream, "2026-01-01.jsonl");
        if (linkType === "symbolic") await symlink(outside, target);
        else await link(outside, target);
        await expect(fixture.open()).rejects.toThrow();
        expect(await readFile(outside, "utf8")).toBe(content);
      });
    });
  }

  for (const linkType of ["symbolic", "hard"] as const) {
    test.each(["main", "tree"] as const)(`rejects a ${linkType}-linked %s writer path introduced after opening`, async (stream) => {
      await withFixture(async (fixture) => {
        const store = await fixture.open();
        if (stream === "tree") store.append("user", "source");
        const outside = join(fixture.root, "outside.jsonl");
        await writeFile(outside, "private external bytes\n", { mode: 0o600 });
        // Both streams name files by the wall-clock write day, pinned here.
        const clock = new Date(2026, 8, 9, 12);
        const target = join(fixture.directory, stream, `${day(clock)}.jsonl`);
        if (linkType === "symbolic") await symlink(outside, target);
        else await link(outside, target);
        if (stream === "main") {
          expect(() => atClock(clock, () => store.append("user", "must not leak"))).toThrow();
          expect(store.messages).toEqual([]);
        } else {
          expect(() => atClock(clock, () => store.saveNode(node(0, 0)))).toThrow();
          expect(store.nodes.size).toBe(0);
        }
        expect(await readFile(outside, "utf8")).toBe("private external bytes\n");
      });
    });
  }

  test.each(["a symlink to another leased store", "a fresh directory"] as const)(
    "a leased root keeps writing to its own inode after rename and replacement by %s, across day rollover",
    async (replacement) => {
      await withFixture(async (fixture) => {
        const first = new Date(2026, 5, 1, 12);
        const second = new Date(2026, 5, 2, 12);
        const store = await fixture.open();
        const reported = store.directory;
        expect(reported).toBe(await realpath(fixture.directory));
        expect(atClock(first, () => store.append("user", "before rename")).i).toBe(0);
        const moved = join(fixture.root, "moved");
        await rename(fixture.directory, moved);
        const otherPath = join(fixture.root, "other");
        const other = replacement === "a fresh directory" ? undefined : await fixture.open(undefined, otherPath);
        other?.append("user", "other owner");
        if (other) await symlink(otherPath, fixture.directory);
        else await mkdir(fixture.directory, { mode: 0o700 });
        const otherMain = other ? await streamContents(otherPath, "main") : "";

        expect(atClock(first, () => store.append("talk", "same day after rename")).i).toBe(1);
        expect(atClock(second, () => store.append("note", "rollover after rename")).i).toBe(2);
        atClock(second, () => store.saveNode(node(0, 0)));

        expect(store.directory).toBe(reported);
        expect((await readdir(join(moved, "main"))).sort()).toEqual([`${day(first)}.jsonl`, `${day(second)}.jsonl`]);
        expect(await readdir(join(moved, "tree"))).toEqual([`${day(second)}.jsonl`]);
        if (other) {
          expect(await streamContents(otherPath, "main")).toBe(otherMain);
          expect(await readdir(join(otherPath, "tree"))).toEqual([]);
          expect(other.append("talk", "other still owns its IDs").i).toBe(1);
        } else {
          expect(await readdir(fixture.directory)).toEqual([]);
        }
        await store.close();
        const recovered = await fixture.open(undefined, moved);
        expect(recovered.messages.map((record) => record.text))
          .toEqual(["before rename", "same day after rename", "rollover after rename"]);
        expect(recovered.nodes.get(nodeKey(0, 0))).toEqual(node(0, 0));
      });
    },
  );

  test("renamed stream directories keep receiving their writer's records across day rollover", async () => {
    await withFixture(async (fixture) => {
      const first = new Date(2026, 5, 1, 12);
      const second = new Date(2026, 5, 2, 12);
      const store = await fixture.open();
      atClock(first, () => store.append("user", "before rename"));
      atClock(first, () => store.saveNode(node(0, 0)));
      const otherPath = join(fixture.root, "other");
      const other = await fixture.open(undefined, otherPath);
      other.append("user", "other owner");
      for (const stream of ["main", "tree"] as const) {
        await rename(join(fixture.directory, stream), join(fixture.directory, `${stream}-held`));
        await symlink(join(otherPath, stream), join(fixture.directory, stream));
      }
      const otherMain = await streamContents(otherPath, "main");

      atClock(second, () => store.append("talk", "rollover after rename"));
      atClock(second, () => store.saveNode(node(0, 1)));

      for (const stream of ["main", "tree"] as const) {
        expect((await readdir(join(fixture.directory, `${stream}-held`))).sort())
          .toEqual([`${day(first)}.jsonl`, `${day(second)}.jsonl`]);
      }
      expect(await streamContents(otherPath, "main")).toBe(otherMain);
      expect(await readdir(join(otherPath, "tree"))).toEqual([]);
      expect(other.messages.map((record) => record.text)).toEqual(["other owner"]);
      expect(store.messages.map((record) => record.i)).toEqual([0, 1]);
      expect(store.nodes.size).toBe(2);
    });
  });

  test("close rejects new writes immediately, settles concurrently, and is idempotent", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "kept");
      store.saveNode(node(0, 0));
      const closing = store.close();
      expect(() => store.append("talk", "too late")).toThrow();
      expect(() => store.saveNode(node(0, 0))).toThrow();
      await Promise.all([closing, store.close(), store.close()]);
      await store.close();
      expect(() => store.append("talk", "also too late")).toThrow();
      expect(() => store.saveNode(node(0, 0))).toThrow();
      const restarted = await fixture.open();
      expect(restarted.messages.map((record) => record.text)).toEqual(["kept"]);
      expect(restarted.nodes.size).toBe(1);
      expect(restarted.append("talk", "new owner").i).toBe(1);
    });
  });

  test("concurrent same-process opens admit exactly one writer", async () => {
    await withFixture(async (fixture) => {
      const results = await Promise.allSettled([fixture.open(), fixture.open(), fixture.open()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    });
  });

  test("rejects a same-process second writer and its canonical symlink alias", async () => {
    await withFixture(async (fixture) => {
      const first = await fixture.open();
      first.append("user", "owner");
      const alias = join(fixture.root, "alias");
      await symlink(fixture.directory, alias);
      await expect(fixture.open()).rejects.toThrow();
      await expect(fixture.open(undefined, alias)).rejects.toThrow();
      expect(first.append("talk", "still owner").i).toBe(1);
      await first.close();
      const aliasOwner = await fixture.open(undefined, alias);
      expect(aliasOwner.messages.map((record) => record.i)).toEqual([0, 1]);
      await expect(fixture.open()).rejects.toThrow();
      await aliasOwner.close();
      expect((await fixture.open()).messages.length).toBe(2);
    });
  });
});

// Opens `directory` in a fresh process and reports "opened" or the error's name, without blocking on a lease holder.
function openFromAnotherProcess(directory: string): string {
  const code = `import { Store } from ${JSON.stringify(storeModule)};
try { const store = await Store.open(${JSON.stringify(directory)}); await store.close(); console.log("opened"); }
catch (error) { console.log(error.name); }`;
  return Bun.spawnSync([process.execPath, "-e", code], { stdin: "ignore" }).stdout.toString().trim();
}

describe("Store archive and sidecar files", () => {
  const archiveTime = new Date("2026-10-21T12:00:00.000Z");
  const metricRow = { type: "rules", at: "2026-10-21T12:00:00.000Z", pRule: null, pSentenceMax: null, sentences: 0, cutoff: 0.5, added: false } as const;

  test("archive refuses, renaming nothing, when its directory path now names another store", async () => {
    await withFixture(async (fixture) => {
      const first = await fixture.open();
      first.append("user", "first chat");
      const moved = join(fixture.root, "moved");
      await rename(fixture.directory, moved);
      const second = await fixture.open();
      second.append("user", "second chat");
      const secondMain = await streamContents(fixture.directory, "main");

      await expect(first.archive(archiveTime)).rejects.toThrow("no longer names the store this session holds");
      expect((await readdir(fixture.root)).sort()).toEqual(["chat", "moved"]);
      expect(await streamContents(fixture.directory, "main")).toBe(secondMain);
      expect(second.append("talk", "second still writes").i).toBe(1);

      // The refused archive still released its lease exactly once, and close() afterwards is a no-op.
      await first.close();
      const reopened = await fixture.open(undefined, moved);
      expect(reopened.messages.map((record) => record.text)).toEqual(["first chat"]);
    });
  });

  test("archive refuses when the directory path no longer exists", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "kept");
      const moved = join(fixture.root, "moved");
      await rename(fixture.directory, moved);
      await expect(store.archive(archiveTime)).rejects.toThrow("no longer names the store this session holds");
      expect(await readdir(fixture.root)).toEqual(["moved"]);
      expect((await fixture.open(undefined, moved)).messages.map((record) => record.text)).toEqual(["kept"]);
    });
  });

  test("archive holds the lease through the rename, then frees it: a fresh store opens at the path and the archive reopens", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "old chat");
      store.saveNode(node(0, 0));
      await expect(fixture.open()).rejects.toBeInstanceOf(StoreLeaseConflictError);
      const archivePath = `${store.directory}.20261021T120000Z`;

      // At the rename itself another process still cannot open the directory.
      const nativeRename = fs.renameSync;
      let during: string | undefined;
      const renameSpy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (String(destination) === archivePath) during = openFromAnotherProcess(store.directory);
        nativeRename(source, destination);
      });
      let archive: string;
      try {
        archive = await store.archive(archiveTime);
      } finally {
        renameSpy.mockRestore();
      }
      expect(during).toBe("StoreLeaseConflictError");
      expect(archive).toBe(archivePath);

      expect(() => store.append("talk", "too late")).toThrow();
      await store.close();
      const fresh = await fixture.open();
      expect(fresh.messages).toEqual([]);
      const old = await fixture.open(undefined, archive);
      expect(old.messages.map((record) => record.text)).toEqual(["old chat"]);
      expect(old.nodes.get(nodeKey(0, 0))).toEqual(node(0, 0));
    });
  });

  test("archive on a closed or archived store is refused", async () => {
    await withFixture(async (fixture) => {
      const closed = await fixture.open();
      await closed.close();
      await expect(closed.archive(archiveTime)).rejects.toThrow("closed");
      const store = await fixture.open();
      await store.archive(archiveTime);
      await expect(store.archive(archiveTime)).rejects.toThrow("closed");
      await store.close();
    });
  });

  test("a failed archive claim leaves the directory, releases the lease, and a later close is clean", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "kept");
      const claimed = `${store.directory}.20261021T120000Z`;
      const nativeRename = fs.renameSync;
      const renameSpy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (String(destination) === claimed) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
        nativeRename(source, destination);
      });
      try {
        await expect(store.archive(archiveTime)).rejects.toThrow("injected rename failure");
      } finally {
        renameSpy.mockRestore();
      }
      expect(await readdir(fixture.root)).toEqual(["chat"]);
      await store.close();
      expect((await fixture.open()).messages.map((record) => record.text)).toEqual(["kept"]);
    });
  });

  test("ledger and metrics writes follow the leased inode after the directory is displaced", async () => {
    await withFixture(async (fixture) => {
      const first = await fixture.open();
      const ledger = RuleLedger.open(() => first.sidecarPath(LEDGER_FILE));
      const moved = join(fixture.root, "moved");
      await rename(fixture.directory, moved);
      const second = await fixture.open();
      const secondFiles = (await readdir(fixture.directory)).sort();

      ledger.add(1, "rule of the first chat", 1);
      appendMetric(first.sidecarPath(METRICS_FILE), metricRow);

      expect(await readFile(join(moved, LEDGER_FILE), "utf8")).toContain("rule of the first chat");
      expect(await readFile(join(moved, METRICS_FILE), "utf8")).toContain('"type":"rules"');
      expect((await readdir(fixture.directory)).sort()).toEqual(secondFiles);
      expect(secondFiles).not.toContain(LEDGER_FILE);
      expect(secondFiles).not.toContain(METRICS_FILE);
      expect(second.messages).toEqual([]);
    });
  });

  test("sidecarPath refuses a closed or archived store and any name that is not a single plain file name", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      expect(store.sidecarPath("x.jsonl").endsWith("/x.jsonl")).toBe(true);
      for (const name of ["", ".", "..", "a/b", "/etc/passwd", "../x", "a\0b"]) {
        expect(() => store.sidecarPath(name)).toThrow("single plain file name");
      }
      const closing = store.close();
      expect(() => store.sidecarPath("x.jsonl")).toThrow("closed");
      await closing;
      expect(() => store.sidecarPath("x.jsonl")).toThrow("closed");

      const archived = await fixture.open();
      await archived.archive(archiveTime);
      expect(() => archived.sidecarPath("x.jsonl")).toThrow("closed");
    });
  });
});

describe("Store process-lifetime lock", () => {
  test("a real competing process rejects while the holder lives; SIGKILL releases ownership immediately", async () => {
    await withFixture(async (fixture) => {
      const holder = fixture.spawn(`
        const store = await Store.open(directory);
        store.append("user", "durable before SIGKILL");
        console.log("ready");
        // Only keeps this fixture process alive until the parent sends SIGKILL.
        setInterval(() => {}, 60_000);
      `);
      await waitForReady(holder);
      const contender = fixture.spawn(`
        let store;
        try { store = await Store.open(directory); }
        catch { console.log("rejected"); process.exit(0); }
        await store.close();
        console.error("competing writer unexpectedly acquired lock");
        process.exit(1);
      `);
      expect(await processResult(contender)).toEqual({ code: 0, stdout: "rejected\n", stderr: "" });
      expect(holder.exitCode).toBeNull();
      holder.kill("SIGKILL");
      await withDeadline(holder.exited, "SIGKILL holder exit");

      // No sleeps, lock-file deletion, PID checks, or acquisition retry policy.
      const recovered = await fixture.open();
      expect(recovered.messages.map((record) => record.text)).toEqual(["durable before SIGKILL"]);
      expect((await readdir(fixture.directory)).sort()).toEqual(["images", "main", "tree"]);
      expect(recovered.append("talk", "recovered").i).toBe(1);
      await recovered.close();
      expect((await fixture.open()).messages.map((record) => record.text))
        .toEqual(["durable before SIGKILL", "recovered"]);
    });
  }, 20_000);
});

describe("Store view snapshot validation", () => {
  // Four messages with cached leaves 0:0..0:3 and parent 1:0; 1:1 and 2:0 are unbuilt.
  const history = [0, 1, 2, 3].map((i) => message(i));
  const summaries = [node(0, 0), node(0, 1), node(0, 2), node(0, 3), node(1, 0)];
  const valid: ViewSnapshot = { ...snapshotOf(4, [[1, 0], [0, 2], [0, 3]], false),
    compactor: { length: 2, parts: [[1, 0]], compacting: true } };
  const encoded = JSON.stringify(valid);
  const viewPath = (directory: string) => join(directory, "view.json");
  const withField = (field: string, value: unknown) => ({ ...valid, [field]: value });
  const withoutField = (field: string) => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
  const withParts = (parts: unknown, length = valid.length) => ({ ...valid, length, parts });
  const withCompactor = (compactor: unknown) => ({ ...valid, compactor });
  const withCompactorField = (field: string, value: unknown) => withCompactor({ ...valid.compactor, [field]: value });
  const compactorParts = (parts: unknown, length = valid.compactor.length) => withCompactor({ ...valid.compactor, length, parts });

  // JSON-representable, so each case is exercised identically on save and replay.
  const invalidViews: { name: string; value: unknown }[] = [
    { name: "null snapshot", value: null },
    { name: "array snapshot", value: [] },
    { name: "string snapshot", value: "view" },
    ...["version", "length", "parts", "compacting", "compactor"].map((field) => ({ name: `missing ${field}`, value: withoutField(field) })),
    { name: "unknown text field", value: withField("text", "summary text") },
    { name: "unsupported version", value: withField("version", 3) },
    { name: "string version", value: withField("version", "1") },
    { name: "string length", value: withField("length", "4") },
    { name: "negative length", value: withField("length", -1) },
    { name: "fractional length", value: withField("length", 3.5) },
    { name: "unsafe length", value: withField("length", Number.MAX_SAFE_INTEGER + 1) },
    { name: "numeric compacting", value: withField("compacting", 0) },
    { name: "string compacting", value: withField("compacting", "false") },
    { name: "null compacting", value: withField("compacting", null) },
    { name: "null parts", value: withField("parts", null) },
    { name: "array-like parts object", value: withField("parts", { 0: [1, 0], 1: [0, 2], 2: [0, 3], length: 3 }) },
    { name: "scalar part", value: withParts([[1, 0], 2, [0, 3]]) },
    { name: "object part", value: withParts([[1, 0], { l: 0, i: 2 }, [0, 3]]) },
    { name: "empty part", value: withParts([[1, 0], [], [0, 2], [0, 3]]) },
    { name: "one-element part", value: withParts([[1, 0], [0], [0, 3]]) },
    { name: "three-element part", value: withParts([[1, 0], [0, 2, 3], [0, 3]]) },
    { name: "string level", value: withParts([["1", 0], [0, 2], [0, 3]]) },
    { name: "string index", value: withParts([[1, "0"], [0, 2], [0, 3]]) },
    { name: "boolean level", value: withParts([[true, 0], [0, 1], [0, 2], [0, 3]]) },
    { name: "null index", value: withParts([[1, null], [0, 2], [0, 3]]) },
    { name: "negative level", value: withParts([[-1, 0], [0, 1], [0, 2], [0, 3]]) },
    { name: "fractional level", value: withParts([[0.5, 0], [0, 1], [0, 2], [0, 3]]) },
    { name: "negative index", value: withParts([[1, 0], [0, -1], [0, 3]]) },
    { name: "fractional index", value: withParts([[1, 0], [0, 2.5], [0, 3]]) },
    { name: "unsupported level", value: withParts([[53, 0]]) },
    { name: "unsafe index", value: withParts([[0, Number.MAX_SAFE_INTEGER + 1]]) },
    { name: "unsafe endpoint", value: withParts([[1, Number.MAX_SAFE_INTEGER]]) },
    { name: "unsafe endpoint at maximum level", value: withParts([[52, 1]]) },
    { name: "maximum level beyond length", value: withParts([[52, 0]]) },
    { name: "gap before first part", value: withParts([[0, 1], [0, 2], [0, 3]]) },
    { name: "interior gap", value: withParts([[1, 0], [0, 3]]) },
    { name: "overlapping parts", value: withParts([[1, 0], [0, 1], [0, 2], [0, 3]]) },
    { name: "duplicate part", value: withParts([[1, 0], [0, 2], [0, 2], [0, 3]]) },
    { name: "out-of-order parts", value: withParts([[0, 2], [0, 3], [1, 0]]) },
    { name: "parts end before length", value: withParts([[1, 0], [0, 2]]) },
    { name: "no parts for nonzero length", value: withParts([]) },
    { name: "part beyond declared length", value: withParts([[1, 0], [0, 2], [0, 3]], 3) },
    { name: "parts for zero length", value: withParts([[0, 0]], 0) },
    { name: "length beyond history", value: withParts([[1, 0], [0, 2], [0, 3], [0, 4]], 5) },
    { name: "missing level-1 summary over cached leaves", value: withParts([[1, 0], [1, 1]]) },
    { name: "missing level-2 summary", value: withParts([[2, 0]]) },
    { name: "v1 snapshot carrying a compactor", value: { version: 1, length: valid.length, parts: valid.parts, compacting: valid.compacting, compactor: valid.compactor } },
    { name: "null compactor", value: withCompactor(null) },
    { name: "array compactor", value: withCompactor([]) },
    { name: "string compactor", value: withCompactor("compactor") },
    ...["length", "parts", "compacting"].map((field) => ({ name: `compactor missing ${field}`, value: withCompactor(Object.fromEntries(Object.entries(valid.compactor).filter(([key]) => key !== field))) })),
    { name: "compactor unknown text field", value: withCompactor({ ...valid.compactor, text: "summary text" }) },
    { name: "compactor carries version", value: withCompactor({ ...valid.compactor, version: 2 }) },
    { name: "compactor string length", value: withCompactorField("length", "2") },
    { name: "compactor negative length", value: withCompactorField("length", -1) },
    { name: "compactor fractional length", value: withCompactorField("length", 1.5) },
    { name: "compactor unsafe length", value: withCompactorField("length", Number.MAX_SAFE_INTEGER + 1) },
    { name: "compactor length beyond main length", value: compactorParts([[1, 0], [0, 2], [0, 3], [0, 4]], 5) },
    { name: "compactor numeric compacting", value: withCompactorField("compacting", 0) },
    { name: "compactor string compacting", value: withCompactorField("compacting", "true") },
    { name: "compactor null compacting", value: withCompactorField("compacting", null) },
    { name: "compactor null parts", value: withCompactorField("parts", null) },
    { name: "compactor array-like parts", value: withCompactorField("parts", { 0: [1, 0], length: 1 }) },
    { name: "compactor scalar part", value: compactorParts([2]) },
    { name: "compactor one-element part", value: compactorParts([[1]]) },
    { name: "compactor three-element part", value: compactorParts([[1, 0, 0]]) },
    { name: "compactor string level", value: compactorParts([["1", 0]]) },
    { name: "compactor negative index", value: compactorParts([[1, -1]]) },
    { name: "compactor fractional index", value: compactorParts([[1, 0.5]]) },
    { name: "compactor unsupported level", value: compactorParts([[53, 0]]) },
    { name: "compactor unsafe endpoint", value: compactorParts([[1, Number.MAX_SAFE_INTEGER]]) },
    { name: "compactor gap before first part", value: compactorParts([[0, 1]], 2) },
    { name: "compactor interior gap", value: compactorParts([[1, 0], [0, 3]], 4) },
    { name: "compactor overlapping parts", value: compactorParts([[1, 0], [0, 1], [0, 2]], 3) },
    { name: "compactor parts end before its length", value: compactorParts([[1, 0]], 4) },
    { name: "compactor part overruns its length", value: compactorParts([[1, 0], [0, 2]], 2) },
    { name: "compactor no parts for nonzero length", value: compactorParts([], 2) },
    { name: "compactor parts for zero length", value: compactorParts([[0, 0]], 0) },
    { name: "compactor names unbuilt level-1 summary", value: compactorParts([[0, 0], [0, 1], [1, 1]], 4) },
    { name: "compactor names unbuilt level-2 summary", value: compactorParts([[2, 0]], 4) },
  ];

  // Values JSON cannot carry, so only a caller can pass them to saveView.
  const nonJsonViews: { name: string; value: unknown }[] = [
    { name: "NaN length", value: withField("length", Number.NaN) },
    { name: "infinite length", value: withField("length", Number.POSITIVE_INFINITY) },
    { name: "bigint length", value: withField("length", BigInt(4)) },
    { name: "undefined compacting", value: withField("compacting", undefined) },
    { name: "infinite index", value: withParts([[1, 0], [0, 2], [0, Number.POSITIVE_INFINITY]]) },
    { name: "hole in part", value: withParts([[1, 0], Object.assign(new Array<unknown>(2), { 1: 2 }), [0, 3]]) },
    { name: "NaN compactor length", value: withCompactorField("length", Number.NaN) },
    { name: "infinite compactor length", value: withCompactorField("length", Number.POSITIVE_INFINITY) },
    { name: "undefined compactor compacting", value: withCompactorField("compacting", undefined) },
    { name: "hole in compactor parts", value: compactorParts(new Array<unknown>(1), 2) },
  ];

  const malformedJson = [
    { name: "empty file", bytes: "" },
    { name: "whitespace only", bytes: " \n" },
    { name: "truncated document", bytes: encoded.slice(0, -1) },
    { name: "trailing comma", bytes: `${encoded.slice(0, -1)},}\n` },
    { name: "concatenated documents", bytes: `${encoded}\n${encoded}\n` },
    { name: "non-JSON number literal", bytes: `${encoded.replace('"length":4', '"length":NaN')}\n` },
    { name: "single-quoted strings", bytes: `${encoded.replaceAll('"', "'")}\n` },
  ];

  const malformedUtf8 = [
    { name: "invalid byte 0xFF", sequence: [0xff] },
    { name: "lone continuation byte", sequence: [0x80] },
    { name: "overlong encoding", sequence: [0xc0, 0xaf] },
    { name: "truncated multibyte sequence", sequence: [0xe2, 0x82] },
    { name: "encoded UTF-16 surrogate", sequence: [0xed, 0xa0, 0x80] },
  ];

  // The bytes sit inside a string a later duplicate key overwrites, so lossy
  // decoding parses to exactly `valid`; only strict UTF-8 decoding rejects it.
  const shadowed = (sequence: number[]) => Buffer.concat([
    Buffer.from('{"version":"'),
    Buffer.from(sequence),
    Buffer.from(`",${encoded.slice(1)}\n`),
  ]);

  async function seedHistory(directory: string): Promise<void> {
    await seed(directory, "main", "2026-01-01.jsonl", history);
    await seed(directory, "tree", "2026-01-01.jsonl", summaries);
  }

  async function diskState(directory: string) {
    const entries = (await readdir(directory)).sort();
    return {
      entries,
      view: entries.includes("view.json") ? await readFile(viewPath(directory)) : undefined,
      main: await streamContents(directory, "main"),
      tree: await streamContents(directory, "tree"),
    };
  }

  async function expectRejectedSave(store: Store, directory: string, value: unknown): Promise<void> {
    const published = store.viewSnapshot;
    const messages = [...store.messages];
    const nodes = [...store.nodes];
    const before = await diskState(directory);
    expect(() => store.saveView(value as ViewSnapshot)).toThrow();
    expect(store.viewSnapshot).toBe(published);
    expect(store.messages).toEqual(messages);
    expect([...store.nodes]).toEqual(nodes);
    expect(await diskState(directory)).toEqual(before);
  }

  async function expectSaveRejection(value: unknown): Promise<void> {
    await withFixture(async (fixture) => {
      await seedHistory(fixture.directory);
      const store = await fixture.open();
      await expectRejectedSave(store, fixture.directory, value);
      expect(store.viewSnapshot).toBeUndefined();
      store.saveView(valid);
      await expectRejectedSave(store, fixture.directory, value);
      expect(store.viewSnapshot).toEqual(valid);
      // The rejection does not poison later writes; 1:1 was the missing summary.
      const appended = store.append("talk", "after rejected view");
      expect(appended.i).toBe(4);
      store.saveNode(node(1, 1));
      const next: ViewSnapshot = snapshotOf(5, [[1, 0], [1, 1], [0, 4]], true);
      store.saveView(next);
      expect(store.viewSnapshot).toEqual(next);
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.messages).toEqual([...history, appended]);
      expect(restarted.nodes.get(nodeKey(1, 1))).toEqual(node(1, 1));
      expect(restarted.viewSnapshot).toEqual(next);
    });
  }

  async function expectReplayRejection(bytes: string | Uint8Array): Promise<void> {
    await withFixture(async (fixture) => {
      await seedHistory(fixture.directory);
      await writeFile(viewPath(fixture.directory), bytes, { mode: 0o600 });
      const before = await diskState(fixture.directory);
      await expect(fixture.open()).rejects.toThrow();
      expect(await diskState(fixture.directory)).toEqual(before);
      await writeFile(viewPath(fixture.directory), `${encoded}\n`);
      // Reopening at once proves the rejected open released its lease.
      const store = await fixture.open();
      expect(store.viewSnapshot).toEqual(valid);
      expect(store.messages).toEqual(history);
      expect([...store.nodes.values()]).toEqual(summaries);
    });
  }

  test.each(invalidViews)("rejects on save without publication, disk change, or poisoning: $name", async ({ value }) => {
    await expectSaveRejection(value);
  });

  test.each(nonJsonViews)("rejects non-JSON value on save without publication, disk change, or poisoning: $name", async ({ value }) => {
    await expectSaveRejection(value);
  });

  // Version 1 is replay-only; a write of it must never reach disk.
  const legacyWrites: { name: string; value: unknown }[] = [
    { name: "legacy version 1 write", value: { version: 1, length: valid.length, parts: valid.parts, compacting: valid.compacting } },
  ];

  test.each(legacyWrites)("rejects a legacy version 1 write on save without publication, disk change, or poisoning: $name", async ({ value }) => {
    await expectSaveRejection(value);
  });

  test.each(invalidViews)("rejects on replay, then reopens immediately once repaired: $name", async ({ value }) => {
    await expectReplayRejection(`${JSON.stringify(value)}\n`);
  });

  test.each(malformedJson)("rejects malformed JSON on replay, then reopens immediately once repaired: $name", async ({ bytes }) => {
    await expectReplayRejection(bytes);
  });

  test.each(malformedUtf8)("rejects malformed UTF-8 that lossy decoding would admit, then reopens once repaired: $name", async ({ sequence }) => {
    const bytes = shadowed(sequence);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(valid);
    await expectReplayRejection(bytes);
  });

  test("a compactor leaf absent from the saved tree is rejected on save and replay, while the same unbuilt main leaves stay legal", async () => {
    await withFixture(async (fixture) => {
      await seed(fixture.directory, "main", "2026-01-01.jsonl", history);
      // Leaves 0:2 and 0:3 are unbuilt: legal for the main tiling, never for the compactor.
      await seed(fixture.directory, "tree", "2026-01-01.jsonl", [node(0, 0), node(0, 1), node(1, 0)]);
      const store = await fixture.open();
      const mainOnly: ViewSnapshot = snapshotOf(4, [[1, 0], [0, 2], [0, 3]], false);
      const unbuilt: ViewSnapshot = { ...mainOnly, compactor: { length: 4, parts: [[1, 0], [0, 2], [0, 3]], compacting: false } };
      expect(() => store.saveView(unbuilt)).toThrow();
      expect(store.viewSnapshot).toBeUndefined();
      store.saveView(mainOnly);
      await store.close();
      const path = join(fixture.directory, "view.json");
      await writeFile(path, `${JSON.stringify(unbuilt)}\n`);
      await expect(fixture.open()).rejects.toThrow();
      await writeFile(path, `${JSON.stringify(mainOnly)}\n`);
      const reopened = await fixture.open();
      expect(reopened.viewSnapshot).toEqual(mainOnly);
      await reopened.close();
    });
  });
});

// CRC-32 (IEEE) over each PNG chunk; the fixtures below are real, decodable images.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(crc32(body), body.length + 4);
  return frame;
}

// A genuine 2x2 truecolor PNG: signature, IHDR, zlib-compressed scanlines, IEND.
function pngFixture(seed: number): { readonly png: Buffer; readonly base64: string; readonly descriptor: ImageDescriptor } {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB; remaining header bytes are the standard zero values
  const scanlines: number[] = [];
  for (let y = 0; y < 2; y++) {
    scanlines.push(0); // filter type None
    for (let x = 0; x < 2; x++) scanlines.push((seed * 61 + x * 90) & 0xff, (seed * 17 + y * 120) & 0xff, (seed + x + y) & 0xff);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from(scanlines))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return {
    png,
    base64: png.toString("base64"),
    descriptor: { sha256: createHash("sha256").update(png).digest("hex"), mimeType: "image/png", bytes: png.length, width: 2, height: 2 },
  };
}

describe("Store image storage and message attachments", () => {
  const imagesOf = (store: Store) => join(store.directory, "images");

  test("saveImage content-addresses genuine PNG bytes privately, deduplicates them, and reads verified bytes after restart", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const image = pngFixture(1);
      const descriptor = store.saveImage(image.base64, "image/png");
      expect(descriptor).toEqual(image.descriptor);
      expect(store.saveImage(image.base64, "image/png")).toEqual(image.descriptor);
      const images = imagesOf(store);
      expect(await readdir(images)).toEqual([image.descriptor.sha256]);
      expect((await stat(images)).mode & 0o777).toBe(0o700);
      const path = join(images, image.descriptor.sha256);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await readFile(path)).toString("base64")).toBe(image.base64);
      expect(store.readImage(descriptor)).toEqual({ descriptor, data: image.base64 });
      store.append("user", "keeps image", undefined, { images: [{ ...descriptor, order: 0 }] });
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.readImage(descriptor)).toEqual({ descriptor, data: image.base64 });
      await restarted.close();
    });
  });

  test("fake headers, MIME mismatches, and non-canonical base64 are rejected before any file exists or the writer is poisoned", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const genuine = pngFixture(2);
      const pngHeaderOnly = genuine.png.subarray(0, 33); // signature and IHDR, no IDAT or IEND
      const jpegSofOnly = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
      const webpHeaderOnly = Buffer.concat([Buffer.from("RIFF"), Buffer.from([12, 0, 0, 0]), Buffer.from("WEBPVP8L"), Buffer.from([0, 0, 0, 0])]);
      const rejected: [string, ImageMimeType][] = [
        [pngHeaderOnly.toString("base64"), "image/png"],
        [jpegSofOnly.toString("base64"), "image/jpeg"],
        [webpHeaderOnly.toString("base64"), "image/webp"],
        [genuine.base64, "image/jpeg"],
        [`${genuine.base64.slice(0, 8)}\n${genuine.base64.slice(8)}`, "image/png"],
        [`data:image/png;base64,${genuine.base64}`, "image/png"],
      ];
      for (const [data, mimeType] of rejected) expect(() => store.saveImage(data, mimeType)).toThrow();
      expect(await readdir(imagesOf(store))).toEqual([]);
      expect(store.append("user", "still writable").i).toBe(0);
      await store.close();
    });
  });

  test.each(["temporary fsync", "short write", "rename", "directory fsync after publish"] as const)(
    "saveImage %s failure is uncertain: it throws, poisons writes, and reopen reclaims unreferenced published bytes",
    async (fault) => {
      await withFixture(async (fixture) => {
        const store = await fixture.open();
        const image = pngFixture(12);
        const images = imagesOf(store);
        const isTemporary = (path: string) => path.startsWith(`${images}/.image-`) && path.endsWith(".tmp");
        const failure = Object.assign(new Error(`injected image ${fault} failure`), { code: "EIO" });
        const nativeFsync = fs.fsyncSync;
        const nativeWrite = fs.writeSync;
        const nativeRename = fs.renameSync;
        let hits = 0;
        const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
          const target = fdPath(fd);
          if ((fault === "temporary fsync" && isTemporary(target)) || (fault === "directory fsync after publish" && target === images)) {
            hits++;
            throw failure;
          }
          nativeFsync(fd);
        });
        const writeSpy = spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, ...args: unknown[]) => {
          if (fault === "short write" && isTemporary(fdPath(fd))) {
            hits++;
            return nativeWrite(fd, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
          }
          return Reflect.apply(nativeWrite, fs, [fd, bytes, ...args]);
        }) as typeof fs.writeSync);
        const renameSpy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
          if (fault === "rename" && isTemporary(fs.realpathSync(source)) && String(destination).endsWith(`/${image.descriptor.sha256}`)) {
            hits++;
            throw failure;
          }
          nativeRename(source, destination);
        });
        try {
          expect(() => store.saveImage(image.base64, "image/png")).toThrow();
        } finally {
          renameSpy.mockRestore();
          writeSpy.mockRestore();
          fsyncSpy.mockRestore();
        }
        expect(hits).toBe(1);
        const published = fault === "directory fsync after publish";
        expect(await readdir(images)).toEqual(published ? [image.descriptor.sha256] : []);
        expect(() => store.append("user", "must not publish")).toThrow();
        expect(() => store.saveImage(image.base64, "image/png")).toThrow();
        await store.close();

        const recovered = await fixture.open();
        expect(recovered.messages).toEqual([]);
        // A published image with no message reference is an orphan: reopen reclaims it.
        expect(() => recovered.readImage(image.descriptor)).toThrow();
        expect(await readdir(images)).toEqual([]);
        expect(recovered.saveImage(image.base64, "image/png")).toEqual(image.descriptor);
        expect(recovered.readImage(image.descriptor).data).toBe(image.base64);
        expect(await readdir(images)).toEqual([image.descriptor.sha256]);
        expect(recovered.append("user", "after recovery", undefined, { images: [{ ...image.descriptor, order: 0 }] }).i).toBe(0);
        await recovered.close();
        expect((await fixture.open()).readMessageImages(0)).toEqual([{ attachment: { ...image.descriptor, order: 0 }, data: image.base64 }]);
      });
    },
  );

  test("reads and appends refuse descriptors that claim other bytes, dimensions, paths, or absent entries", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const genuine = pngFixture(3);
      const descriptor = store.saveImage(genuine.base64, "image/png");
      const claims: ImageDescriptor[] = [
        { ...descriptor, bytes: descriptor.bytes + 1 },
        { ...descriptor, width: descriptor.width + 1 },
        { ...descriptor, height: descriptor.height + 1 },
        { ...descriptor, mimeType: "image/webp" },
        { ...descriptor, sha256: descriptor.sha256.toUpperCase() },
        { ...descriptor, sha256: `../${descriptor.sha256.slice(3)}` },
        { ...descriptor, sha256: "0".repeat(64) },
      ];
      for (const claim of claims) expect(() => store.readImage(claim)).toThrow();
      expect(() => store.append("user", "dangling", undefined, { images: [{ ...descriptor, sha256: "0".repeat(64), order: 0 }] })).toThrow();
      expect(store.messages).toEqual([]);
      expect(store.append("user", "ok").i).toBe(0);
      expect(store.readImage(descriptor).data).toBe(genuine.base64);
      await store.close();
    });
  });

  test("work records and work metadata must accompany each other, and legacy records keep exactly five fields", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const work = { source: "task" as const, completeness: "full" as const, id: "task-1" };
      expect(() => store.append("work", "uncoupled")).toThrow();
      expect(() => store.append("user", "carries work", undefined, { work })).toThrow();
      expect(store.messages).toEqual([]);
      const record = store.append("work", "coupled", undefined, { work });
      const plain = store.append("user", "legacy");
      expect([record.i, plain.i]).toEqual([0, 1]);
      expect(plain.metadata).toBeUndefined();
      await store.close();
      const lines = (await streamContents(fixture.directory, "main")).trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(Object.keys(lines[1]).sort()).toEqual(["date", "i", "kind", "size", "text"]);
      expect((await fixture.open()).messages).toEqual([record, plain]);
    });
  });

  test("attachments keep their recorded order, verified bytes, and frozen work metadata across restart", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const first = pngFixture(5);
      const second = pngFixture(6);
      const firstDescriptor = store.saveImage(first.base64, "image/png");
      const secondDescriptor = store.saveImage(second.base64, "image/png");
      const record = store.append("work", "task result", new Date("2026-01-10T12:00:00.000Z"), {
        work: { source: "task", completeness: "full", id: "task-1", name: "Researcher", agentId: "agent-1" },
        images: [{ ...secondDescriptor, order: 0 }, { ...firstDescriptor, order: 2 }],
      });
      expect(Object.isFrozen(record.metadata)).toBe(true);
      const expected = [
        { attachment: { ...secondDescriptor, order: 0 }, data: second.base64 },
        { attachment: { ...firstDescriptor, order: 2 }, data: first.base64 },
      ];
      expect(store.readMessageImages(0)).toEqual(expected);
      expect(store.readMessagePage(0).metadata).toEqual(record.metadata);
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.messages).toEqual([record]);
      expect(restarted.readMessageImages(0)).toEqual(expected);
      expect(restarted.readImage(firstDescriptor)).toEqual({ descriptor: firstDescriptor, data: first.base64 });
      await restarted.close();
    });
  });

  test.each(["missing", "truncated", "grown", "same-size corrupt"] as const)(
    "reopen rejects a %s referenced attachment before repairing a torn log, then accepts once the bytes are restored",
    async (damage) => {
      await withFixture(async (fixture) => {
        const store = await fixture.open();
        const image = pngFixture(4);
        const descriptor = store.saveImage(image.base64, "image/png");
        store.append("user", "with attachment", undefined, { images: [{ ...descriptor, order: 0 }] });
        await store.close();
        const logPath = join(fixture.directory, "main", (await readdir(join(fixture.directory, "main")))[0]!);
        await appendFile(logPath, '{"i":1,"text":');
        const logBefore = await readFile(logPath);
        const path = join(fixture.directory, "images", descriptor.sha256);
        if (damage === "missing") await rm(path);
        else if (damage === "truncated") await writeFile(path, image.png.subarray(0, image.png.length - 1), { mode: 0o600 });
        else if (damage === "grown") await appendFile(path, Buffer.from([0]));
        else {
          const flipped = Buffer.from(image.png);
          flipped[45] = flipped[45]! ^ 0xff;
          await writeFile(path, flipped, { mode: 0o600 });
        }
        await expect(fixture.open()).rejects.toThrow();
        expect(await readFile(logPath)).toEqual(logBefore);
        await writeFile(path, image.png, { mode: 0o600 });
        const recovered = await fixture.open();
        expect(recovered.messages.map((record) => record.text)).toEqual(["with attachment"]);
        expect(recovered.readMessageImages(0)[0]!.data).toBe(image.base64);
        await recovered.close();
        expect((await readFile(logPath, "utf8")).endsWith("\n")).toBe(true);
      });
    },
  );

  test.each(["root", "images directory"] as const)("a renamed %s cannot redirect image writes or reads away from the leased store", async (target) => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const first = pngFixture(8);
      const second = pngFixture(9);
      const held = store.saveImage(first.base64, "image/png");
      if (target === "root") {
        const moved = join(fixture.root, "moved-chat");
        await rename(fixture.directory, moved);
        await mkdir(join(fixture.directory, "images"), { recursive: true, mode: 0o700 });
        await writeFile(join(fixture.directory, "sentinel"), "fresh", { mode: 0o600 });
        const added = store.saveImage(second.base64, "image/png");
        expect((await readdir(join(moved, "images"))).sort()).toEqual([held.sha256, added.sha256].sort());
        expect(await readdir(join(fixture.directory, "images"))).toEqual([]);
        expect(await readFile(join(fixture.directory, "sentinel"), "utf8")).toBe("fresh");
        expect(store.readImage(held).data).toBe(first.base64);
        store.append("user", "held", undefined, { images: [{ ...held, order: 0 }] });
        store.append("user", "added", undefined, { images: [{ ...added, order: 0 }] });
        await store.close();
        const recovered = await fixture.open(undefined, moved);
        expect(recovered.readImage(added).data).toBe(second.base64);
        await recovered.close();
      } else {
        const heldDirectory = join(fixture.directory, "images-held");
        await rename(join(fixture.directory, "images"), heldDirectory);
        const outside = join(fixture.root, "outside-images");
        await mkdir(outside, { mode: 0o700 });
        await symlink(outside, join(fixture.directory, "images"));
        const added = store.saveImage(second.base64, "image/png");
        expect(await readdir(outside)).toEqual([]);
        expect((await readdir(heldDirectory)).sort()).toEqual([held.sha256, added.sha256].sort());
        expect(store.readImage(held).data).toBe(first.base64);
        store.append("user", "held", undefined, { images: [{ ...held, order: 0 }] });
        store.append("user", "added", undefined, { images: [{ ...added, order: 0 }] });
        await store.close();
        await rm(join(fixture.directory, "images"));
        await rename(heldDirectory, join(fixture.directory, "images"));
        const recovered = await fixture.open();
        expect(recovered.readImage(added).data).toBe(second.base64);
        await recovered.close();
      }
    });
  });

  for (const linkType of ["symbolic", "hard"] as const) {
    test(`a ${linkType}-linked image entry is refused on read and write, leaving its target untouched`, async () => {
      await withFixture(async (fixture) => {
        const image = pngFixture(11);
        const store = await fixture.open();
        const descriptor = store.saveImage(image.base64, "image/png");
        store.append("user", "keeps image", undefined, { images: [{ ...descriptor, order: 0 }] });
        await store.close();
        const attacked = await fixture.open();
        const entry = join(fixture.directory, "images", descriptor.sha256);
        const outside = join(fixture.root, "outside.png");
        await writeFile(outside, image.png, { mode: 0o644 });
        await chmod(outside, 0o644);
        await rm(entry);
        if (linkType === "symbolic") await symlink(outside, entry);
        else await link(outside, entry);
        expect(() => attacked.readImage(descriptor)).toThrow();
        expect(() => attacked.saveImage(image.base64, "image/png")).toThrow();
        expect((await readFile(outside)).toString("base64")).toBe(image.base64);
        expect((await stat(outside)).mode & 0o777).toBe(0o644);
        await attacked.close();
        await expect(fixture.open()).rejects.toThrow();
      });
    });
  }

  test("image and page reads reject after close, while a restarted writer still verifies the same attachment", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const image = pngFixture(10);
      const descriptor = store.saveImage(image.base64, "image/png");
      store.append("user", "closing attachment", undefined, { images: [{ ...descriptor, order: 0 }] });
      await store.close();
      expect(() => store.readImage(descriptor)).toThrow();
      expect(() => store.readMessageImages(0)).toThrow();
      const restarted = await fixture.open();
      expect(restarted.readMessageImages(0)).toEqual([{ attachment: { ...descriptor, order: 0 }, data: image.base64 }]);
      await restarted.close();
    });
  });

  test("message page reads are UTF-8 bounded with exact default and hard limits", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const text = "é".repeat(10_000); // 20,000 UTF-8 bytes
      const record = store.append("user", text);
      const first = store.readMessagePage(record.i);
      expect(first).toMatchObject({ i: 0, kind: "user", date: record.date, size: record.size, offset: 0, totalBytes: 20_000, next: DEFAULT_PAGE_BYTES });
      expect(Buffer.byteLength(first.text, "utf8")).toBe(DEFAULT_PAGE_BYTES);
      const rest = store.readMessagePage(0, DEFAULT_PAGE_BYTES);
      expect(rest.text).toBe("é".repeat(1808));
      expect(rest.next).toBeNull();
      const whole = store.readMessagePage(0, 0, MAX_PAGE_BYTES);
      expect(whole.text).toBe(text);
      expect(whole.next).toBeNull();
      expect(() => store.readMessagePage(0, 16_383)).toThrow();
      expect(() => store.readMessagePage(0, 0, MAX_PAGE_BYTES + 1)).toThrow();
      expect(() => store.readMessagePage(0, 0, 0)).toThrow();
      expect(() => store.readMessagePage(1)).toThrow();
      await store.close();
    });
  });

  const hexName = (seed: string) => createHash("sha256").update(seed).digest("hex");
  // Replaces one character of a fresh UUID to build version and variant negatives.
  const uuidWith = (index: number, character: string) => {
    const id = randomUUID();
    return `${id.slice(0, index)}${character}${id.slice(index + 1)}`;
  };
  // Counts only root and images directory fsyncs; startup GC is the delta over an idle open.
  async function openCountingDirectorySyncs(open: () => Promise<Store>, root: string, images: string) {
    const counts = { root: 0, images: 0 };
    const nativeFsync = fs.fsyncSync;
    const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
      const target = fdPath(fd);
      if (target === root) counts.root++;
      else if (target === images) counts.images++;
      nativeFsync(fd);
    });
    try {
      return { store: await open(), counts };
    } finally {
      fsyncSpy.mockRestore();
    }
  }

  test("startup GC keeps a digest referenced twice and a digest referenced only by an older day", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const shared = pngFixture(50);
      const older = pngFixture(51);
      const sharedDescriptor = store.saveImage(shared.base64, "image/png");
      const olderDescriptor = store.saveImage(older.base64, "image/png");
      atClock(new Date(2026, 0, 10, 12), () => {
        store.append("user", "older only", undefined, { images: [{ ...olderDescriptor, order: 0 }] });
        store.append("user", "shared first", undefined, { images: [{ ...sharedDescriptor, order: 0 }] });
      });
      atClock(new Date(2026, 0, 12, 12), () => {
        store.append("talk", "shared second", undefined, { images: [{ ...sharedDescriptor, order: 0 }] });
        store.append("note", "text only");
      });
      await store.close();
      const restarted = await fixture.open();
      expect(restarted.messages.map((record) => record.text))
        .toEqual(["older only", "shared first", "shared second", "text only"]);
      expect((await readdir(imagesOf(restarted))).sort()).toEqual([sharedDescriptor.sha256, olderDescriptor.sha256].sort());
      expect(restarted.readMessageImages(0)).toEqual([{ attachment: { ...olderDescriptor, order: 0 }, data: older.base64 }]);
      expect(restarted.readImage(sharedDescriptor).data).toBe(shared.base64);
      await restarted.close();
    });
  });

  test("startup GC removes unreferenced digests and valid stale temporaries while retaining referenced bytes", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const kept = pngFixture(52);
      const orphan = pngFixture(53);
      const keptDescriptor = store.saveImage(kept.base64, "image/png");
      const orphanDescriptor = store.saveImage(orphan.base64, "image/png");
      store.append("user", "keeps image", undefined, { images: [{ ...keptDescriptor, order: 0 }] });
      const images = imagesOf(store);
      await store.close();
      await writeFile(join(images, `.image-${randomUUID()}.tmp`), "partial image", { mode: 0o600 });
      await writeFile(join(fixture.directory, `.view-${randomUUID()}.tmp`), "partial view", { mode: 0o600 });
      const restarted = await fixture.open();
      expect(await readdir(images)).toEqual([keptDescriptor.sha256]);
      expect((await readdir(fixture.directory)).filter((name) => name.startsWith(".view-"))).toEqual([]);
      expect(() => restarted.readImage(orphanDescriptor)).toThrow();
      expect(restarted.readMessageImages(0)).toEqual([{ attachment: { ...keptDescriptor, order: 0 }, data: kept.base64 }]);
      await restarted.close();
    });
  });

  test("startup GC removes only exact unreferenced digest files and canonical stale temporaries, ignoring all other names", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const images = imagesOf(store);
      await store.close();
      const outside = join(fixture.root, "outside.bin");
      await writeFile(outside, "outside bytes", { mode: 0o600 });
      const candidate = hexName("candidate");
      const directory = hexName("directory");
      const link = hexName("link");
      const linkTemporary = `.image-${randomUUID()}.tmp`;
      const ignoredFiles = [
        hexName("uppercase").toUpperCase(),
        candidate.slice(1),
        `${candidate}\n`,
        `.image-${randomUUID().toUpperCase()}.tmp`,
        `.image-${uuidWith(14, "1")}.tmp`,
        `.image-${uuidWith(19, "7")}.tmp`,
        `.image-${randomUUID()}.tmp.bak`,
        `x.image-${randomUUID()}.tmp`,
        `.image-${randomUUID()}.tmp\n`,
      ];
      await writeFile(join(images, "notes.txt"), "unrelated", { mode: 0o600 });
      await mkdir(join(images, directory));
      await symlink(outside, join(images, link));
      await symlink(outside, join(images, linkTemporary));
      for (const name of ignoredFiles) await writeFile(join(images, name), "ignored", { mode: 0o600 });
      await writeFile(join(images, candidate), "unreferenced", { mode: 0o600 });
      const reports: string[] = [];
      const restarted = await fixture.open((report) => reports.push(report));
      expect(reports).toEqual(["Store garbage collection: collected 1 file(s)"]);
      expect((await readdir(images)).sort()).toEqual(["notes.txt", directory, link, linkTemporary, ...ignoredFiles].sort());
      const entries = await readdir(images, { withFileTypes: true });
      expect(entries.find((entry) => entry.name === link)?.isSymbolicLink()).toBe(true);
      expect(entries.find((entry) => entry.name === linkTemporary)?.isSymbolicLink()).toBe(true);
      expect(entries.find((entry) => entry.name === directory)?.isDirectory()).toBe(true);
      expect(await readFile(outside, "utf8")).toBe("outside bytes");
      await restarted.close();
    });
  });

  test("an unlink failure keeps other collections, reports one warning, and leaves the store writable", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "live");
      const images = imagesOf(store);
      await store.close();
      const failingName = `.image-${randomUUID()}.tmp`;
      await writeFile(join(images, failingName), "stuck", { mode: 0o600 });
      await writeFile(join(images, hexName("orphan")), "orphan", { mode: 0o600 });
      await writeFile(join(fixture.directory, `.view-${randomUUID()}.tmp`), "view", { mode: 0o600 });
      const failure = Object.assign(new Error("injected unlink failure"), { code: "EIO" });
      const nativeUnlink = fs.unlinkSync;
      const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
        if (String(path).endsWith(`/${failingName}`)) throw failure;
        nativeUnlink(path);
      });
      const reports: string[] = [];
      let restarted: Store;
      try {
        restarted = await fixture.open((report) => reports.push(report));
      } finally {
        unlinkSpy.mockRestore();
      }
      expect(reports).toEqual(["Store garbage collection: collected 2 file(s); warning: 1 cleanup operation(s) failed"]);
      expect(await readdir(images)).toEqual([failingName]);
      expect((await readdir(fixture.directory)).filter((name) => name.startsWith(".view-"))).toEqual([]);
      expect(restarted.messages.map((record) => record.text)).toEqual(["live"]);
      expect(restarted.append("talk", "still writable").i).toBe(1);
      await restarted.close();
      const next: string[] = [];
      const retried = await fixture.open((report) => next.push(report));
      expect(next).toEqual(["Store garbage collection: collected 1 file(s)"]);
      expect(await readdir(images)).toEqual([]);
      await retried.close();
    });
  });

  test("startup GC fsyncs each changed directory once and stays silent when nothing is collected", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      const kept = store.saveImage(pngFixture(60).base64, "image/png");
      store.append("user", "kept", undefined, { images: [{ ...kept, order: 0 }] });
      await store.close();
      const root = await realpath(fixture.directory);
      const images = join(root, "images");
      const idleReports: string[] = [];
      const idle = await openCountingDirectorySyncs(() => fixture.open((report) => idleReports.push(report)), root, images);
      await idle.store.close();
      expect(idleReports).toEqual([]);
      await writeFile(join(images, hexName("orphan-a")), "a", { mode: 0o600 });
      await writeFile(join(images, hexName("orphan-b")), "b", { mode: 0o600 });
      await writeFile(join(images, `.image-${randomUUID()}.tmp`), "c", { mode: 0o600 });
      await writeFile(join(root, `.view-${randomUUID()}.tmp`), "d", { mode: 0o600 });
      await writeFile(join(root, `.view-${randomUUID()}.tmp`), "e", { mode: 0o600 });
      const collectingReports: string[] = [];
      const collecting = await openCountingDirectorySyncs(() => fixture.open((report) => collectingReports.push(report)), root, images);
      expect(collectingReports).toEqual(["Store garbage collection: collected 5 file(s)"]);
      expect(collecting.counts).toEqual({ root: idle.counts.root + 1, images: idle.counts.images + 1 });
      await collecting.store.close();
      const quietReports: string[] = [];
      const quiet = await openCountingDirectorySyncs(() => fixture.open((report) => quietReports.push(report)), root, images);
      expect(quietReports).toEqual([]);
      expect(quiet.counts).toEqual(idle.counts);
      await quiet.store.close();
    });
  });

  test.each(["replay", "image", "snapshot"] as const)(
    "startup GC does not run when %s validation rejects the open, and runs after repair",
    async (damage) => {
      await withFixture(async (fixture) => {
        const store = await fixture.open();
        const referenced = pngFixture(70);
        const descriptor = store.saveImage(referenced.base64, "image/png");
        store.append("user", "needs image", undefined, { images: [{ ...descriptor, order: 0 }] });
        store.saveView(rawView(1));
        const images = imagesOf(store);
        await store.close();
        const mainPath = join(fixture.directory, "main", (await readdir(join(fixture.directory, "main")))[0]!);
        const viewPath = join(fixture.directory, "view.json");
        const imagePath = join(images, descriptor.sha256);
        const originals = { main: await readFile(mainPath), view: await readFile(viewPath) };
        const candidates = [
          join(images, hexName("garbage")),
          join(images, `.image-${randomUUID()}.tmp`),
          join(fixture.directory, `.view-${randomUUID()}.tmp`),
        ];
        for (const path of candidates) await writeFile(path, "garbage", { mode: 0o600 });
        if (damage === "replay") await appendFile(mainPath, `${JSON.stringify(message(2))}\n`);
        if (damage === "image") await rm(imagePath);
        if (damage === "snapshot") await writeFile(viewPath, "{");
        const rejectedReports: string[] = [];
        await expect(fixture.open((report) => rejectedReports.push(report))).rejects.toThrow();
        expect(rejectedReports).toEqual([]);
        for (const path of candidates) expect((await stat(path)).isFile()).toBe(true);
        if (damage === "replay") await writeFile(mainPath, originals.main);
        if (damage === "image") await writeFile(imagePath, referenced.png, { mode: 0o600 });
        if (damage === "snapshot") await writeFile(viewPath, originals.view);
        const repairedReports: string[] = [];
        const recovered = await fixture.open((report) => repairedReports.push(report));
        expect(repairedReports).toEqual(["Store garbage collection: collected 3 file(s)"]);
        for (const path of candidates) await expect(stat(path)).rejects.toThrow();
        expect(await readdir(images)).toEqual([descriptor.sha256]);
        expect(recovered.readMessageImages(0)).toEqual([{ attachment: { ...descriptor, order: 0 }, data: referenced.base64 }]);
        await recovered.close();
      });
    },
  );
});
