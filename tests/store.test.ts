import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, nodeKey, type Kind, type Message, type TreeNode } from "../src/store.ts";

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
        synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`));
        fsync(fd);
      });
      try {
        const store = await fixture.open();
        expect(targets.filter((target) => !synced.includes(target))).toEqual([]);
        await store.close();
        spy.mockImplementation((fd: number) => {
          if (fs.readlinkSync(`/proc/self/fd/${fd}`) === targets[1]) {
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

function rawView(length: number, compacting = false): ViewSnapshot {
  return { version: 1, length, parts: Array.from({ length }, (_, i) => [0, i] as const), compacting };
}

function expectFrozenView(view: ViewSnapshot): void {
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
      expect((await readdir(fixture.directory)).sort()).toEqual(["main", "tree"]);
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
        { version: 1, length: 4, parts: [[1, 0], [0, 2], [0, 3]], compacting: true },
        { version: 1, length: 4, parts: [[2, 0]], compacting: false },
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
      const prefix: ViewSnapshot = { version: 1, length: 2, parts: [[1, 0]], compacting: true };
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
      const input: { version: 1; length: number; parts: [number, number][]; compacting: boolean } = {
        version: 1, length: 3, parts: [[1, 0], [0, 2]], compacting: true,
      };
      const expected: ViewSnapshot = { version: 1, length: 3, parts: [[1, 0], [0, 2]], compacting: true };
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

  test("an abandoned malformed snapshot temporary stays inert and is not owned by later saves", async () => {
    await withFixture(async (fixture) => {
      const store = await fixture.open();
      store.append("user", "source");
      store.saveView(rawView(1, true));
      const abandoned = join(fixture.directory, ".view-00000000-0000-0000-0000-000000000000.tmp");
      const malformed = Buffer.from([0x7b, 0x22, 0xff, 0xfe]);
      await writeFile(abandoned, malformed, { mode: 0o600 });
      await store.close();
      const recovered = await fixture.open();
      expect(recovered.viewSnapshot).toEqual(rawView(1, true));
      expect(await readFile(abandoned)).toEqual(malformed);
      recovered.saveView(rawView(0));
      expect(await readFile(abandoned)).toEqual(malformed);
      expect((await readdir(fixture.directory)).filter((name) => name.startsWith(".view-")))
        .toEqual([".view-00000000-0000-0000-0000-000000000000.tmp"]);
      await recovered.close();
      expect((await fixture.open()).viewSnapshot).toEqual(rawView(0));
      expect(await readFile(abandoned)).toEqual(malformed);
    });
  });
});

describe("Store view snapshot durability faults", () => {
  for (const initial of ["missing snapshot", "committed snapshot"] as const) {
    test.each(["file fsync", "root fsync", "partial write", "rename"] as const)(
      `${initial}: %s failure withholds publication, poisons writes and recovers the committed disk state`,
      async (fault) => {
        await withFixture(async (fixture) => {
          const store = await fixture.open();
          for (let i = 0; i < 3; i++) store.append("user", `source ${i}`);
          for (const summary of [node(0, 0), node(0, 1), node(1, 0)]) store.saveNode(summary);
          const oldView = rawView(3);
          const nextView: ViewSnapshot = { version: 1, length: 3, parts: [[1, 0], [0, 2]], compacting: true };
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
            const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
            if ((fault === "file fsync" && isTemporary(target)) || (fault === "root fsync" && target === root)) {
              hits++;
              throw failure;
            }
            fsync(fd);
          });
          const writeSpy = spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, ...args: unknown[]) => {
            if (fault === "partial write" && isTemporary(fs.readlinkSync(`/proc/self/fd/${fd}`))) {
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
        const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
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
        expect((await readdir(moved)).sort()).toEqual(["main", "tree", "view.json"]);
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
        store.saveView({ version: 1, length: 2, parts: [[1, 0]], compacting: true });
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
      const snapshot: ViewSnapshot = { version: 1, length: 2, parts: [[1, 0]], compacting: true };
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
      expect((await readdir(fixture.directory)).sort()).toEqual(["main", "tree", "view.json"]);
      expect(recovered.append("note", "after killed holder").i).toBe(2);
      recovered.saveNode(node(0, 2));
      const resumed: ViewSnapshot = { version: 1, length: 3, parts: [[1, 0], [0, 2]], compacting: false };
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
      for (const directory of [fixture.directory, join(fixture.directory, "main"), join(fixture.directory, "tree")]) {
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
      expect((await readdir(fixture.directory)).sort()).toEqual(["main", "tree"]);
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
  const valid: ViewSnapshot = { version: 1, length: 4, parts: [[1, 0], [0, 2], [0, 3]], compacting: false };
  const encoded = JSON.stringify(valid);
  const viewPath = (directory: string) => join(directory, "view.json");
  const withField = (field: string, value: unknown) => ({ ...valid, [field]: value });
  const withoutField = (field: string) => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
  const withParts = (parts: unknown, length = valid.length) => ({ ...valid, length, parts });

  // JSON-representable, so each case is exercised identically on save and replay.
  const invalidViews: { name: string; value: unknown }[] = [
    { name: "null snapshot", value: null },
    { name: "array snapshot", value: [] },
    { name: "string snapshot", value: "view" },
    ...["version", "length", "parts", "compacting"].map((field) => ({ name: `missing ${field}`, value: withoutField(field) })),
    { name: "unknown text field", value: withField("text", "summary text") },
    { name: "unsupported version", value: withField("version", 2) },
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
  ];

  // Values JSON cannot carry, so only a caller can pass them to saveView.
  const nonJsonViews: { name: string; value: unknown }[] = [
    { name: "NaN length", value: withField("length", Number.NaN) },
    { name: "infinite length", value: withField("length", Number.POSITIVE_INFINITY) },
    { name: "bigint length", value: withField("length", BigInt(4)) },
    { name: "undefined compacting", value: withField("compacting", undefined) },
    { name: "infinite index", value: withParts([[1, 0], [0, 2], [0, Number.POSITIVE_INFINITY]]) },
    { name: "hole in part", value: withParts([[1, 0], Object.assign(new Array<unknown>(2), { 1: 2 }), [0, 3]]) },
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
      const next: ViewSnapshot = { version: 1, length: 5, parts: [[1, 0], [1, 1], [0, 4]], compacting: true };
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
});
