import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectEvidence, PROJECT_EVIDENCE_LIMITS, PROJECT_EVIDENCE_MARK, registerProjectEvidenceTool, type ProjectEvidenceRegistration } from "../src/project-evidence.ts";
import { Store, StoreLeaseConflictError, type Kind } from "../src/store.ts";
import { openFakeHost } from "./helpers/fake-host.ts";

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "project evidence cleanup");
});

const DATE = "2026-11-07T12:00:00.000Z";
function row(i: number, text: string, kind: Kind = "user", metadata?: unknown): string {
  return JSON.stringify({ i, kind, text, size: kind.length + 2 + Buffer.byteLength(text), date: DATE,
    ...(metadata === undefined ? {} : { metadata }) });
}
async function fixture(lines: readonly string[] = []) {
  // /var on macOS is a symlink: select the actual temp root, not an alias.
  const parent = await realpath(await mkdtemp(join(tmpdir(), "optchat-project-evidence-")));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const path = join(parent, "selected");
  await mkdir(join(path, "main"), { recursive: true });
  const log = join(path, "main", "2026-11-07.jsonl");
  await writeFile(log, lines.map((line) => `${line}\n`).join(""));
  return { parent, path, log };
}
function open(allowlist: Readonly<Record<string, string>>, limits = {}) {
  const evidence = ProjectEvidence.open(allowlist, limits);
  cleanups.push(() => evidence.close());
  return evidence;
}

test("unsupported platforms refuse before reading any selected path", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const opening = spyOn(fs, "openSync");
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    expect(() => ProjectEvidence.open({ selected: "/must-not-be-read" })).toThrow();
    expect(opening).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", platform);
    opening.mockRestore();
  }
});

// Only fixture files are created/altered; the implementation gets no writer APIs.
describe.skipIf(process.platform !== "linux")("selected external evidence snapshots", () => {
  test("preserves store identity, original ids and digests; reopens exact deep UTF-8 passages", async () => {
    const text = `${"é😀漢 routine status\n".repeat(1600)}migration command: bun run migrate --target=shard-7\n${"ok\n".repeat(1000)}`;
    const original = row(0, text);
    const first = await fixture([original]);
    const second = await fixture([row(0, "migration uses a different command in the other project")]);
    const evidence = open({ alpha: first.path, beta: second.path });
    const result = await evidence.search("migration command shard");
    expect(result.stores.map((item) => item.snapshot.recordCount)).toEqual([1, 1]);
    expect(new Set(result.stores.map((item) => item.snapshot.identity)).size).toBe(2);
    const passage = result.passages.find((item) => item.storeName === "alpha" && item.text.includes("--target=shard-7"))!;
    expect(passage).toBeDefined();
    expect(passage.start).toBeGreaterThan(16_384);
    expect(passage.id).toBe(0);
    expect(passage.date).toBe(DATE);
    expect(passage.digest).toBe(createHash("sha256").update(original).digest("hex"));
    const page = evidence.read(passage.store, passage.id, passage.start, passage.end - passage.start);
    expect(page.text).toBe(passage.text);
    expect(page.text).toBe(Buffer.from(text).subarray(passage.start, passage.end).toString("utf8"));
    expect(page.text).not.toContain("\uFFFD");
    expect(() => evidence.read("alpha", 0)).toThrow("Unknown project evidence source");
    expect(() => evidence.read(passage.store, 1)).toThrow("outside its snapshot");
    expect(() => evidence.read(passage.store, 0, 1)).toThrow("UTF-8");
    await expect(evidence.search("migration", ["../unselected"])).rejects.toThrow("allowlisted");
    expect((await evidence.search("migration", ["beta"])).passages.every((item) => item.storeName === "beta")).toBe(true);
  });

  test("snapshots bytes and counts per store, excluding appends, new files and active partial tails without repair", async () => {
    const first = await fixture([row(0, "old selected needle")]);
    const second = await fixture([row(0, "other needle"), row(1, "other second needle")]);
    const partial = row(1, "later needle").slice(0, -4);
    await appendFile(first.log, partial);
    const before = await readFile(first.log);
    const evidence = open({ first: first.path, second: second.path });
    expect(await readFile(first.log)).toEqual(before);
    const snapshot = evidence.snapshots[0]!;
    expect(snapshot.recordCount).toBe(1);
    expect(snapshot.logBytes).toBe(before.length);
    expect(snapshot.partialTrailingBytes).toBe(Buffer.byteLength(partial));
    expect(snapshot.files[0]!.sha256).toBe(createHash("sha256").update(before).digest("hex"));
    await appendFile(first.log, `${row(1, "later needle").slice(-4)}\n`);
    await writeFile(join(first.path, "main", "2026-11-08.jsonl"), `${row(2, "new daily needle")}\n`);
    await appendFile(second.log, `${row(2, "other append needle")}\n`);
    const result = await evidence.search("needle");
    expect(result.stores.map((store) => store.snapshot.recordCount)).toEqual([1, 2]);
    expect(result.complete).toBe(false);
    expect(result.stores[0]!.complete).toBe(false);
    expect(result.passages.some((item) => /later|daily|append/.test(item.text))).toBe(false);
    expect(() => evidence.read(snapshot.store, 1)).toThrow("outside its snapshot");
    const reopened = open({ first: first.path });
    expect(reopened.snapshots[0]!.recordCount).toBe(3);
    expect(reopened.snapshots[0]!.store).not.toBe(snapshot.store);
  });

  test("even syntactically complete JSON without a newline is an uncommitted trailing record", async () => {
    const { path, log } = await fixture([row(0, "committed needle")]);
    const tail = row(1, "unfinished needle");
    await appendFile(log, tail);
    const evidence = open({ selected: path });
    expect(evidence.snapshots[0]!.recordCount).toBe(1);
    expect(evidence.snapshots[0]!.partialTrailingBytes).toBe(Buffer.byteLength(tail));
    expect((await readFile(log, "utf8")).endsWith(tail)).toBe(true);
  });

  test("works beside a held writer, never acquires its lease or mutates tree, images, ledger or metrics", async () => {
    const { path, log } = await fixture([]);
    const writer = await Store.open(path);
    cleanups.push(() => writer.close());
    writer.append("user", "selected live needle");
    await writeFile(join(path, "ledger.jsonl"), "private standing instruction banana\n");
    await writeFile(join(path, "metrics.jsonl"), "metrics private banana\n");
    const before = await readFile(log);
    const rootFiles = await readdir(path);
    const evidence = open({ live: path });
    expect(await readFile(log)).toEqual(before);
    expect(await readdir(path)).toEqual(rootFiles);
    await expect(Store.open(path)).rejects.toBeInstanceOf(StoreLeaseConflictError);
    writer.append("talk", "writer continues after read-only snapshot");
    expect(evidence.snapshots[0]!.recordCount).toBe(1);
    expect((await evidence.search("banana")).passages).toHaveLength(0);
    evidence.close();
    writer.append("talk", "writer still owns its lease after snapshot close");
    expect(writer.messages).toHaveLength(3);
    expect(await readFile(join(path, "ledger.jsonl"), "utf8")).toBe("private standing instruction banana\n");
  });

  test("validates the original record digest again for reads and search results", async () => {
    const { path, log } = await fixture([row(0, "needle original")]);
    const evidence = open({ selected: path });
    const key = evidence.snapshots[0]!.store;
    await writeFile(log, `${row(0, "needle tampered")}\n`);
    expect(() => evidence.read(key, 0)).toThrow("changed selected");
    await expect(evidence.search("needle")).rejects.toThrow("changed selected");
  });

  test("truncation is refused, and replacing the public root cannot redirect held descriptors", async () => {
    const first = await fixture([row(0, "needle original")]);
    const evidence = open({ selected: first.path });
    const key = evidence.snapshots[0]!.store;
    const moved = join(first.parent, "moved");
    await rename(first.path, moved);
    await mkdir(join(first.path, "main"), { recursive: true });
    await writeFile(first.log, `${row(0, "needle unrelated replacement")}\n`);
    expect(evidence.read(key, 0).text).toBe("needle original");
    await writeFile(join(moved, "main", "2026-11-07.jsonl"), "");
    expect(() => evidence.read(key, 0)).toThrow("changed selected");
  });

  test("global result budgets and partial-report provenance survive multi-store retrieval", async () => {
    const lines = Array.from({ length: 12 }, (_, id) => row(id, `needle evidence ${id} ${"text ".repeat(500)}`));
    const first = await fixture(lines);
    const second = await fixture([row(0, "needle partial report", "work", { work: { source: "task", completeness: "pointer-only", id: "report-a" } })]);
    const evidence = open({ one: first.path, two: second.path });
    const result = await evidence.search("needle");
    expect(result.passages.length).toBeLessThanOrEqual(8);
    expect(result.passages.reduce((n, item) => n + Buffer.byteLength(item.text), 0)).toBeLessThanOrEqual(16_384);
    expect(result.passages.some((item) => item.storeName === "two")).toBe(true);
    expect(result.stores[1]!.incomplete).toEqual([0]);
    const stop = new AbortController();
    stop.abort(new Error("cancel selected search"));
    await expect(evidence.search("needle", undefined, stop.signal)).rejects.toThrow("cancel selected search");
    evidence.close();
    evidence.close();
    await expect(evidence.search("needle")).rejects.toThrow("closed");
  });
});

describe.skipIf(process.platform !== "linux")("external store confinement and admission", () => {
  test.skipIf(process.getuid?.() === 0)("traverses search-only ancestors and root without requiring directory listing permission", async () => {
    const { path, parent } = await fixture([row(0, "needle under a search-only ancestor")]);
    try {
      await chmod(parent, 0o111);
      await chmod(path, 0o111);
      // These prove the fixture withholds listing; only main and its logs are readable.
      await expect(readdir(parent)).rejects.toThrow();
      await expect(readdir(path)).rejects.toThrow();
      const evidence = open({ selected: path });
      const result = await evidence.search("needle");
      expect(result.passages[0]!.text).toBe("needle under a search-only ancestor");
      expect(evidence.read(result.passages[0]!.store, 0).text).toBe(result.passages[0]!.text);
    } finally {
      await chmod(parent, 0o700);
      await chmod(path, 0o700);
    }
  });

  test("tool outcomes require echo kind and valid earlier tool links, matching Store replay", async () => {
    const { path, log } = await fixture([]);
    for (const toolOutcome of ["success", "error", "imported-success", "imported-error"] as const) {
      const tool = row(0, "invoke a tool", "tool");
      await writeFile(log, `${tool}\n${row(1, "needle outcome", "echo", { resultFor: 0, toolOutcome })}\n`);
      const evidence = open({ selected: path });
      expect(evidence.read(evidence.snapshots[0]!.store, 1).kind).toBe("echo");
      evidence.close();
      await writeFile(log, `${tool}\n${row(1, "invalid work outcome", "work", {
        resultFor: 0, toolOutcome, work: { source: "task", completeness: "full" },
      })}\n`);
      expect(() => ProjectEvidence.open({ selected: path })).toThrow("Invalid");
      await writeFile(log, `${tool}\n${row(1, "invalid unlinked outcome", "echo", { toolOutcome })}\n`);
      expect(() => ProjectEvidence.open({ selected: path })).toThrow("Invalid");
    }
  });

  test("root, ancestor, main and log symlinks, plus hardlinks, cannot escape selected roots", async () => {
    const outside = await fixture([row(0, "secret outside selected root")]);
    const inside = await fixture([]);
    const alias = join(inside.parent, "alias");
    await symlink(outside.path, alias);
    expect(() => ProjectEvidence.open({ bad: alias })).toThrow();
    const ancestor = join(inside.parent, "ancestor");
    await symlink(outside.parent, ancestor);
    expect(() => ProjectEvidence.open({ bad: join(ancestor, "selected") })).toThrow();
    await rename(join(inside.path, "main"), join(inside.path, "old-main"));
    await symlink(join(outside.path, "main"), join(inside.path, "main"));
    expect(() => ProjectEvidence.open({ bad: inside.path })).toThrow();
    const logCase = await fixture([]);
    await rm(logCase.log);
    await symlink(outside.log, logCase.log);
    expect(() => ProjectEvidence.open({ bad: logCase.path })).toThrow();
    await rm(logCase.log);
    await link(outside.log, logCase.log);
    expect(() => ProjectEvidence.open({ bad: logCase.path })).toThrow();
  });

  for (const recreate of [false, true]) {
    test(`rejects open-to-unlink hardlink race before reading bytes (recreate=${recreate})`, async () => {
      const outside = await fixture([row(0, "private unselected content")]);
      const inside = await fixture([]);
      await rm(inside.log);
      await link(outside.log, inside.log);
      const foreign = fs.statSync(outside.log, { bigint: true });
      const originalFstat = fs.fstatSync;
      let raced = false;
      let observedLinks: number | undefined;
      function racingFstat(fd: number, options?: fs.StatOptions & { bigint?: false }): fs.Stats;
      function racingFstat(fd: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
      function racingFstat(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
      function racingFstat(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
        const value = originalFstat(fd, options);
        if (!raced && value.ino.toString() === foreign.ino.toString() && value.dev.toString() === foreign.dev.toString()) {
          raced = true;
          // Native openat already pinned the foreign inode. Hide the second link
          // before the admission fstat sees it; optionally recreate the same name
          // after that observation to exercise name/inode ABA as well.
          fs.unlinkSync(inside.log);
          const single = originalFstat(fd, options);
          observedLinks = Number(single.nlink);
          if (recreate) fs.linkSync(outside.log, inside.log);
          return single;
        }
        return value;
      }
      const race = spyOn(fs, "fstatSync").mockImplementation(racingFstat);
      const reads = spyOn(fs, "readSync");
      try {
        expect(() => ProjectEvidence.open({ selected: inside.path })).toThrow("Invalid");
        expect(raced).toBe(true);
        expect(observedLinks).toBe(1);
        expect(reads).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
        race.mockRestore();
      }
      // Keep an ordinary successful admission as the control, not a blanket ban.
      if (recreate) await rm(inside.log);
      await writeFile(inside.log, `${row(0, "selected control")}\n`);
      const evidence = open({ selected: inside.path });
      expect(evidence.read(evidence.snapshots[0]!.store, 0).text).toBe("selected control");
    });
  }

  test("metadata is data, never a filesystem locator; malformed path metadata is rejected", async () => {
    const { path, parent, log } = await fixture([row(0, "needle work pointer", "work", {
      work: { source: "task", completeness: "pointer-only", id: "../../outside", name: "/etc/passwd" },
    })]);
    await writeFile(join(parent, "outside"), "private outside banana");
    const evidence = open({ selected: path });
    expect((await evidence.search("banana")).passages).toHaveLength(0);
    expect((await evidence.search("needle")).stores[0]!.incomplete).toEqual([0]);
    await writeFile(log, `${row(0, "needle", "user", { path: "../../outside" })}\n`);
    expect(() => ProjectEvidence.open({ selected: path })).toThrow("Invalid");
    await writeFile(log, `${row(0, "needle", "user", { images: [{ sha256: "../../outside", mimeType: "image/png", bytes: 1, width: 1, height: 1, order: 0 }] })}\n`);
    expect(() => ProjectEvidence.open({ selected: path })).toThrow("Invalid");
  });

  test("rejects malformed committed records, invalid identity, gaps, duplicates and bad links", async () => {
    const { path, log } = await fixture([]);
    const invalid = [
      "not json\n", `${row(1, "gap")}\n`, `${row(0, "one")}\n${row(0, "duplicate")}\n`,
      `${JSON.stringify({ i: 0, kind: "user", text: "x", size: 999, date: DATE })}\n`,
      `${row(0, "work without metadata", "work")}\n`,
      `${row(0, "result with invalid target", "echo", { resultFor: 99 })}\n`,
    ];
    for (const bytes of invalid) {
      await writeFile(log, bytes);
      expect(() => ProjectEvidence.open({ selected: path })).toThrow("Invalid");
    }
    await writeFile(log, Buffer.from([0xff, 0x0a]));
    expect(() => ProjectEvidence.open({ selected: path })).toThrow("Invalid");
  });

  test("IDs, not daily filenames, define record order", async () => {
    const { path } = await fixture([row(1, "needle second")]);
    await writeFile(join(path, "main", "2026-11-08.jsonl"), `${row(0, "needle first")}\n`);
    const evidence = open({ selected: path });
    expect(evidence.read(evidence.snapshots[0]!.store, 0).text).toBe("needle first");
  });

  test("bounds total stores, file entries, log bytes, complete and partial record bytes, and record counts", async () => {
    const { path, log } = await fixture([row(0, "needle"), row(1, "needle")]);
    const size = (await readFile(log)).length;
    expect(() => ProjectEvidence.open({ selected: path }, { maxBytes: size - 1 })).toThrow("byte limit");
    expect(() => ProjectEvidence.open({ selected: path }, { maxRecords: 1 })).toThrow("record limit");
    expect(() => ProjectEvidence.open({ selected: path }, { maxRecordBytes: 2 })).toThrow("record byte limit");
    expect(() => ProjectEvidence.open({ one: path, two: path }, { maxStores: 1 })).toThrow("Too many");
    expect(() => ProjectEvidence.open({ one: path, two: path })).toThrow("Invalid");
    expect(() => ProjectEvidence.open({ selected: path }, { maxBytes: PROJECT_EVIDENCE_LIMITS.maxBytes + 1 })).toThrow("Invalid");
    await writeFile(join(path, "main", "2026-11-08.jsonl"), "");
    expect(() => ProjectEvidence.open({ selected: path }, { maxFiles: 1 })).toThrow("file limit");
    await writeFile(log, "unfinished".repeat(10));
    expect(() => ProjectEvidence.open({ selected: path }, { maxRecordBytes: 2 })).toThrow("record byte limit");
    expect(() => ProjectEvidence.open({ selected: "relative/path" })).toThrow("Invalid");
    expect(() => ProjectEvidence.open({ "../bad": path })).toThrow("Invalid");
    const denied = join(path, "main", "arbitrary.txt");
    await writeFile(denied, "unselected");
    expect(() => ProjectEvidence.open({ selected: path })).toThrow("Invalid");
  });
});

describe.skipIf(process.platform !== "linux")("chat_project_evidence registration", () => {
  test("large matching and partial-report inventories cannot inflate the public trailer without bound", async () => {
    const selected = await fixture(Array.from({ length: 10_000 }, (_, id) => row(id, "orchid", "work", { work: { source: "task", completeness: "pointer-only" } })));
    let registration: ProjectEvidenceRegistration | undefined;
    const host = await openFakeHost((pi) => { registration = registerProjectEvidenceTool(pi, { selected: selected.path }); });
    cleanups.push(() => host.close(), () => registration?.close());
    const text = await host.callTool("chat_project_evidence", { mode: "search", question: "orchid" });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65_536);
    expect(text).toContain("ids omitted");
  });
  test("no configured stores means no tool or automatic discovery", async () => {
    const host = await openFakeHost((pi) => expect(registerProjectEvidenceTool(pi, {})).toBeUndefined());
    cleanups.push(() => host.close());
    expect(host.tools.has("chat_project_evidence")).toBe(false);
  });

  test("reset refreshes cutoffs without registering again; close is permanent", async () => {
    const { path, log } = await fixture([row(0, "first needle")]);
    let owner: ProjectEvidenceRegistration | undefined;
    const host = await openFakeHost((pi) => { owner = registerProjectEvidenceTool(pi, { selected: path }); });
    cleanups.push(() => host.close());
    cleanups.push(() => owner?.close());
    const tool = host.tools.get("chat_project_evidence");
    const first = await host.callTool("chat_project_evidence", { mode: "search", question: "needle" });
    const locator = JSON.parse(first.match(/reopen: chat_project_evidence\(([^\n]+)\)/)![1]!);
    owner!.reset();
    await expect(host.callTool("chat_project_evidence", locator)).rejects.toThrow("search again before reading");
    const fresh = await host.callTool("chat_project_evidence", { mode: "search", question: "needle" });
    const freshLocator = JSON.parse(fresh.match(/reopen: chat_project_evidence\(([^\n]+)\)/)![1]!);
    expect(freshLocator.store).not.toBe(locator.store);
    await expect(host.callTool("chat_project_evidence", locator)).rejects.toThrow("Unknown project evidence source");
    await appendFile(log, `${row(1, "new banana")}\n`);
    expect(await host.callTool("chat_project_evidence", { mode: "search", question: "banana" })).not.toContain("new banana");
    owner!.reset();
    expect(host.tools.get("chat_project_evidence")).toBe(tool);
    expect(await host.callTool("chat_project_evidence", { mode: "search", question: "banana" })).toContain("new banana");
    await expect(host.callTool("chat_project_evidence", locator)).rejects.toThrow("Unknown project evidence source");
    owner!.close();
    owner!.reset();
    await expect(host.callTool("chat_project_evidence", { mode: "search", question: "needle" })).rejects.toThrow("closed");
  });

  test("per-call admission runs before first open and before reading an existing snapshot", async () => {
    const { path, log } = await fixture([row(0, "needle evidence")]);
    const absent = join(path, "created-only-after-admission");
    let admitted = false;
    let calls = 0;
    let owner: ProjectEvidenceRegistration | undefined;
    const host = await openFakeHost((pi) => {
      owner = registerProjectEvidenceTool(pi, { selected: absent }, {}, (current) => {
        calls++;
        if (!admitted || current?.agent?.kind !== "main") throw new Error("not admitted by local host");
      });
    });
    cleanups.push(() => host.close());
    cleanups.push(() => owner?.close());
    expect(calls).toBe(0);
    await expect(host.callTool("chat_project_evidence", { mode: "search", question: "needle" })).rejects.toThrow("not admitted by local host");
    await mkdir(join(absent, "main"), { recursive: true });
    const externalLog = join(absent, "main", "2026-11-07.jsonl");
    await writeFile(externalLog, await readFile(log));
    admitted = true;
    const result = await host.callTool("chat_project_evidence", { mode: "search", question: "needle" });
    const locator = JSON.parse(result.match(/reopen: chat_project_evidence\(([^\n]+)\)/)![1]!);
    admitted = false;
    await writeFile(externalLog, "changed source\n");
    await expect(host.callTool("chat_project_evidence", locator)).rejects.toThrow("not admitted by local host");
    expect(calls).toBe(4);
  });

  test("rechecks host admission before publication and fences a reset during that awaited check", async () => {
    const { path } = await fixture([row(0, "needle evidence")]);
    const publishing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    let revoked = true;
    let owner: ProjectEvidenceRegistration | undefined;
    const host = await openFakeHost((pi) => {
      owner = registerProjectEvidenceTool(pi, { selected: path }, {}, () => {
        calls++;
        if (calls === 2 && revoked) throw new Error("local host admission revoked");
        if (calls === 4) { publishing.resolve(); return release.promise; }
      });
    });
    cleanups.push(() => host.close());
    cleanups.push(() => owner?.close());
    await expect(host.callTool("chat_project_evidence", { mode: "search", question: "needle" })).rejects.toThrow("local host admission revoked");
    revoked = false;
    const pending = host.callTool("chat_project_evidence", { mode: "search", question: "needle" });
    await publishing.promise;
    owner!.reset();
    release.resolve();
    await expect(pending).rejects.toThrow("reset during the request");
  });

  test("reset during admission prevents opening; reset during search rejects its in-flight result", async () => {
    const { path } = await fixture([row(0, "needle evidence")]);
    const gate = Promise.withResolvers<void>();
    let wait: Promise<void> | undefined = gate.promise;
    let owner: ProjectEvidenceRegistration | undefined;
    const host = await openFakeHost((pi) => {
      owner = registerProjectEvidenceTool(pi, { selected: path }, {}, () => wait);
    });
    cleanups.push(() => host.close());
    cleanups.push(() => owner?.close());
    const admitting = host.callTool("chat_project_evidence", { mode: "search", question: "needle" });
    owner!.reset();
    gate.resolve();
    await expect(admitting).rejects.toThrow("reset during the request");
    wait = undefined;
    const searching = host.callTool("chat_project_evidence", { mode: "search", question: "needle" });
    // Let admission finish and search enter its await before invalidating its reader.
    await Promise.resolve();
    owner!.reset();
    await expect(searching).rejects.toThrow();
    expect(await host.callTool("chat_project_evidence", { mode: "search", question: "needle" })).toContain("needle evidence");
  });

  test("close while read admission is pending rejects the request without publishing its passage", async () => {
    const { path } = await fixture([row(0, "needle evidence")]);
    let wait: Promise<void> | undefined;
    let owner: ProjectEvidenceRegistration | undefined;
    const host = await openFakeHost((pi) => {
      owner = registerProjectEvidenceTool(pi, { selected: path }, {}, () => wait);
    });
    cleanups.push(() => host.close());
    cleanups.push(() => owner?.close());
    const result = await host.callTool("chat_project_evidence", { mode: "search", question: "needle" });
    const locator = JSON.parse(result.match(/reopen: chat_project_evidence\(([^\n]+)\)/)![1]!);
    const gate = Promise.withResolvers<void>();
    wait = gate.promise;
    const reading = host.callTool("chat_project_evidence", locator);
    owner!.close();
    gate.resolve();
    await expect(reading).rejects.toThrow("closed");
  });

  test("registration is lazy, paths cannot be supplied by the model, and exact reopening never uses local zoom", async () => {
    const { path, log } = await fixture([row(0, "first needle")]);
    const unopened = join(path, "not-yet-existing");
    const denyFetch = Object.assign((): never => { throw new Error("external content sent to provider"); }, { preconnect: globalThis.fetch.preconnect });
    const fetch = spyOn(globalThis, "fetch").mockImplementation(denyFetch);
    cleanups.push(() => fetch.mockRestore());
    let owner: { close(): void } | undefined;
    const host = await openFakeHost((pi) => { owner = registerProjectEvidenceTool(pi, { selected: unopened }); });
    cleanups.push(() => host.close());
    cleanups.push(() => owner?.close());
    expect(host.tools.has("chat_project_evidence")).toBe(true);
    // Registration succeeded before the root existed. The first valid request fixes it.
    await expect(host.callTool("chat_project_evidence", { mode: "search", question: "needle", stores: ["arbitrary/path"] })).rejects.toThrow("allowlisted");
    await mkdir(join(unopened, "main"), { recursive: true });
    await writeFile(join(unopened, "main", "2026-11-07.jsonl"), await readFile(log));
    const output = await host.callTool("chat_project_evidence", { mode: "search", question: "needle" });
    expect(output).toStartWith(PROJECT_EVIDENCE_MARK);
    expect(output).not.toContain("zoom(");
    const locator = output.match(/reopen: chat_project_evidence\(([^\n]+)\)/);
    expect(locator).not.toBeNull();
    const page = await host.callTool("chat_project_evidence", JSON.parse(locator![1]!));
    expect(page).toContain("first needle");
    expect(page).toContain("sha256");
    await appendFile(join(unopened, "main", "2026-11-07.jsonl"), `${row(1, "later only banana")}\n`);
    expect(await host.callTool("chat_project_evidence", { mode: "search", question: "banana" })).not.toContain("later only");
    await expect(host.callTool("chat_project_evidence", { mode: "read", store: path, id: 0 })).rejects.toThrow("Unknown project evidence source");
    expect(fetch).not.toHaveBeenCalled();
    expect(host.entries).toHaveLength(0);
    owner!.close();
    await expect(host.callTool("chat_project_evidence", { mode: "search", question: "needle" })).rejects.toThrow("closed");
  });
});
