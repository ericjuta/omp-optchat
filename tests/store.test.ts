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
