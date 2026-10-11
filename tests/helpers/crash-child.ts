// Test-only child process for tests/crash.test.ts. Fault hooks live here, never in src/.
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { ImageDescriptor } from "../../src/archive.ts";
import { importHistory } from "../../src/history.ts";
import { Memory, type Summarize } from "../../src/memory.ts";
import { Store, type Message } from "../../src/store.ts";

export const STAGES = [
  "image temp write",
  "image temp fsync",
  "image rename",
  "images directory fsync",
  "main write",
  "main torn write",
  "main fsync",
  "view temp write",
  "view rename",
  "root directory fsync",
  "tree node write",
] as const;
export type Stage = (typeof STAGES)[number];
export type Scenario = "append" | "summary" | "import";

export interface Plan {
  readonly directory: string;
  readonly scenario: Scenario;
  readonly stage: Stage;
  /** One-based count of matching operations after arming (and after `after`, if set). */
  readonly nth: number;
  /** Count matches only once this tree node key (`l:i`) is committed. */
  readonly after?: string;
}

/** Acknowledged setup prefix: two image-bearing messages. */
export const PREFIX = [
  { kind: "user", text: "prefix zero", seed: 1, date: "2026-10-10T09:00:00.000Z" },
  { kind: "talk", text: "prefix one", seed: 2, date: "2026-10-10T09:01:00.000Z" },
] as const;

export const ARMED_APPEND = { kind: "user", text: "armed append", seed: 3, date: "2026-10-10T09:02:00.000Z" } as const;

const IMAGE_TEMP = /\/\.image-[0-9a-f-]{36}\.tmp$/;
const VIEW_TEMP = /\/\.view-[0-9a-f-]{36}\.tmp$/;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(crc32(body), body.length + 4);
  return frame;
}

/** A genuine 2x2 truecolor PNG, distinct per seed, so each seed gets its own content address. */
export function pngFixture(seed: number): { readonly base64: string; readonly descriptor: ImageDescriptor } {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines: number[] = [];
  for (let y = 0; y < 2; y++) {
    scanlines.push(0);
    for (let x = 0; x < 2; x++) scanlines.push((seed * 61 + x * 90) & 0xff, (seed * 17 + y * 120) & 0xff, (seed + x + y) & 0xff);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from(scanlines))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return {
    base64: png.toString("base64"),
    descriptor: { sha256: createHash("sha256").update(png).digest("hex"), mimeType: "image/png", bytes: png.length, width: 2, height: 2 },
  };
}

const importImage = (seed: number) => {
  const fixture = pngFixture(seed);
  return {
    sha256: fixture.descriptor.sha256, mimeType: "image/png", bytes: fixture.descriptor.bytes,
    width: 2, height: 2, order: 0, data: fixture.base64,
  };
};

/** Records A (image seed 4), B (text), C (image seed 5). Each blob is pre-saved before any append. */
export const IMPORT_TEXTS = ["import A", "import B", "import C"] as const;
export const IMPORT_INPUT = [
  JSON.stringify({ kind: "user", text: "import A", date: "2026-10-10T10:00:00.000Z", images: [importImage(4)] }),
  JSON.stringify({ kind: "talk", text: "import B", date: "2026-10-10T10:01:00.000Z" }),
  JSON.stringify({ kind: "user", text: "import C", date: "2026-10-10T10:02:00.000Z", images: [importImage(5)] }),
].join("\n");

export async function runChild(plan: Plan): Promise<void> {
  const nativeWrite = fs.writeSync;
  const nativeFsync = fs.fsyncSync;
  const nativeRename = fs.renameSync;
  const emit = (line: string): void => {
    const bytes = Buffer.from(`${line}\n`);
    for (let offset = 0; offset < bytes.length; ) {
      try {
        offset += nativeWrite(1, bytes, offset, bytes.length - offset);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
      }
    }
  };

  const store = await Store.open(plan.directory, () => {});
  const gate = Promise.withResolvers<void>();
  // Leaves stay unsummarized until the armed phase opens the gate, so no tree write precedes arming.
  const summarize: Summarize = async () => {
    await gate.promise;
    return "summary";
  };
  // Summary coarsening needs view bytes over budget: a built parent merges [0,0]+[0,1] into [1,0] only then.
  const memory = new Memory(store, summarize, {
    report: () => {},
    ...(plan.scenario === "summary" ? { viewBytes: 8 } : {}),
  });
  const ack = (message: Message): void => emit(`ack ${JSON.stringify(message)}`);

  for (const p of PREFIX) {
    const image = store.saveImage(pngFixture(p.seed).base64, "image/png");
    ack(memory.append(p.kind, p.text, new Date(p.date), { images: [{ ...image, order: 0 }] }));
  }
  emit("ready");

  const tally = { main: 0, tree: 0 };
  const arm = (): void => {
    const root = store.directory;
    const mainDir = `${join(root, "main")}/`;
    const treeDir = `${join(root, "tree")}/`;
    const images = join(root, "images");
    let seen = 0;
    const hit = (name: Stage): boolean => {
      if (name !== plan.stage || (plan.after !== undefined && !store.nodes.has(plan.after))) return false;
      return ++seen === plan.nth;
    };
    const die = (partial?: () => void): never => {
      partial?.();
      emit(`hit ${plan.stage} ${plan.nth} main=${tally.main} tree=${tally.tree}`);
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL did not terminate the crash child");
    };
    const pathOf = (fd: number): string => fs.readlinkSync(`/proc/self/fd/${fd}`);

    spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Uint8Array, ...rest: unknown[]) => {
      const target = pathOf(fd);
      const isMain = target.startsWith(mainDir);
      const isTree = target.startsWith(treeDir);
      if (isMain) {
        if (hit("main write")) die();
        if (hit("main torn write")) die(() => { nativeWrite(fd, buffer.subarray(0, Math.floor(buffer.length / 2))); });
      } else if (isTree) {
        if (hit("tree node write")) die();
      } else if (IMAGE_TEMP.test(target)) {
        if (hit("image temp write")) die();
      } else if (VIEW_TEMP.test(target)) {
        if (hit("view temp write")) die();
      }
      const written = Reflect.apply(nativeWrite, fs, [fd, buffer, ...rest]) as number;
      if (isMain) tally.main++;
      if (isTree) tally.tree++;
      return written;
    }) as typeof fs.writeSync);

    spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      const target = pathOf(fd);
      if (IMAGE_TEMP.test(target) && hit("image temp fsync")) die();
      if (target === images && hit("images directory fsync")) die();
      if (target.startsWith(mainDir) && target.endsWith(".jsonl") && hit("main fsync")) die();
      if (target === root && hit("root directory fsync")) die();
      nativeFsync(fd);
    }) as typeof fs.fsyncSync);

    spyOn(fs, "renameSync").mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
      const from = String(source);
      if (IMAGE_TEMP.test(from) && hit("image rename")) die();
      if (VIEW_TEMP.test(from) && String(destination).endsWith("/view.json") && hit("view rename")) die();
      return nativeRename(source, destination);
    }) as typeof fs.renameSync);
  };
  arm();

  switch (plan.scenario) {
    case "append": {
      const image = store.saveImage(pngFixture(ARMED_APPEND.seed).base64, "image/png");
      ack(memory.append(ARMED_APPEND.kind, ARMED_APPEND.text, new Date(ARMED_APPEND.date), { images: [{ ...image, order: 0 }] }));
      break;
    }
    case "summary": {
      gate.resolve();
      if (!(await memory.settle())) throw new Error("summary settle failed");
      break;
    }
    case "import": {
      const append = memory.append.bind(memory);
      memory.append = (...args: Parameters<Memory["append"]>) => {
        const message = append(...args);
        ack(message);
        return message;
      };
      importHistory(memory, IMPORT_INPUT);
      break;
    }
  }
  emit("completed");
  process.exit(0);
}

if (import.meta.main) {
  runChild(JSON.parse(process.argv[2]!) as Plan).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
