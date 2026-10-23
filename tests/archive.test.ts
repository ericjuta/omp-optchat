import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PAGE_BYTES, MAX_IMAGE_BYTES, MAX_PAGE_BYTES, parseMetadata, readTextPage, validateImage,
} from "../src/archive.ts";
import { Store } from "../src/store.ts";

const encoder = new TextEncoder();

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A structurally real PNG generated with valid CRCs and compressed scanlines.
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Structural JPEG: SOF0 frame, SOS scan header, two entropy-coded bytes, EOI. Not an
// encoder output and not decoded; it exercises the scan-presence admission rule.
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00, 0x00,
    0xff, 0xd9,
  ]);
}

// Simple lossy WebP with one VP8 chunk.
function webp(width: number, height: number): Buffer {
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + 8 + 10, 4);
  header.write("WEBP", 8, "ascii");
  header.write("VP8 ", 12, "ascii");
  header.writeUInt32LE(10, 16);
  const frame = Buffer.alloc(10);
  frame[3] = 0x9d;
  frame[4] = 0x01;
  frame[5] = 0x2a;
  frame.writeUInt16LE(width, 6);
  frame.writeUInt16LE(height, 8);
  return Buffer.concat([header, frame]);
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "optchat-archive-"));
  try {
    await run(join(root, "store"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("readTextPage exact UTF-8 paging", () => {
  test("pages reconstruct the original text through every boundary and report exact totals", () => {
    const text = `a😀${"é".repeat(5000)}b`;
    const total = encoder.encode(text).length;
    let offset = 0;
    let rebuilt = "";
    let pages = 0;
    while (true) {
      const page = readTextPage(text, offset, 7);
      rebuilt += page.text;
      expect(page.totalBytes).toBe(total);
      expect(page.offset).toBe(offset);
      pages++;
      if (page.next === null) break;
      offset = page.next;
    }
    expect(rebuilt).toBe(text);
    expect(pages).toBeGreaterThan(1);
  });

  test("a page never splits a code point; it ends before the code point that does not fit", () => {
    const text = "a😀b";
    expect(readTextPage(text, 0, 2)).toEqual({ text: "a", offset: 0, next: 1, totalBytes: 6 });
    expect(readTextPage(text, 1, 4)).toEqual({ text: "😀", offset: 1, next: 5, totalBytes: 6 });
    expect(readTextPage(text, 5, 4)).toEqual({ text: "b", offset: 5, next: null, totalBytes: 6 });
  });

  test("offsets inside a code point, out-of-range offsets, and unusable limits are rejected", () => {
    expect(() => readTextPage("😀", 1, 4)).toThrow();
    expect(() => readTextPage("😀", 5, 4)).toThrow();
    expect(() => readTextPage("😀", -1, 4)).toThrow();
    expect(() => readTextPage("😀", 0, 1)).toThrow();
    expect(() => readTextPage("abc", 0, 0)).toThrow();
    expect(() => readTextPage("abc", 0, MAX_PAGE_BYTES + 1)).toThrow();
    expect(() => readTextPage("abc", 0, 1.5)).toThrow();
    expect(readTextPage("abc", 3)).toEqual({ text: "", offset: 3, next: null, totalBytes: 3 });
  });

  test("default and hard page limits are the contract's constants", () => {
    expect(DEFAULT_PAGE_BYTES).toBe(16_384);
    expect(MAX_PAGE_BYTES).toBe(32_768);
    const page = readTextPage("x".repeat(40_000));
    expect(page.text.length).toBe(DEFAULT_PAGE_BYTES);
    expect(page.next).toBe(DEFAULT_PAGE_BYTES);
  });
});

describe("parseMetadata strict admission", () => {
  const image = {
    sha256: "a".repeat(64), mimeType: "image/png" as const, bytes: 10, width: 1, height: 1,
  };

  test("accepts a bounded work and image record and returns a detached frozen copy", () => {
    const input = { work: { source: "task", completeness: "full", id: "w1" }, images: [{ ...image, order: 0 }] };
    const parsed = parseMetadata(input);
    input.work.id = "mutated";
    expect(parsed.work?.id).toBe("w1");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.images![0])).toBe(true);
  });

  const work = { source: "task" as const, completeness: "full" as const, id: "w1" };
  const shapes = [
    ["only", {}],
    ["with work", { work }],
    ["with images", { images: [{ ...image, order: 0 }] }],
    ["with work and images", { work, images: [{ ...image, order: 0 }] }],
  ] as const;

  test.each(shapes.flatMap(([name, fields]) =>
    [0, Number.MAX_SAFE_INTEGER].map((resultFor) => [name, resultFor, fields] as const),
  ))("accepts resultFor %s at %s", (_name, resultFor, fields) => {
    expect(parseMetadata({ ...fields, resultFor })).toEqual({ ...fields, resultFor });
  });

  test("resultFor, work, and images form a detached deeply frozen snapshot", () => {
    const input = { resultFor: 0, work: { ...work }, images: [{ ...image, order: 0 }] };
    const expected = { resultFor: 0, work: { ...work }, images: [{ ...image, order: 0 }] };
    const parsed = parseMetadata(input);
    expect(parsed).not.toBe(input);
    expect(parsed.work).not.toBe(input.work);
    expect(parsed.images).not.toBe(input.images);
    expect(parsed.images![0]).not.toBe(input.images[0]);
    for (const value of [parsed, parsed.work, parsed.images, parsed.images![0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    input.resultFor = 7;
    input.work.id = "changed";
    input.images[0]!.width = 9;
    input.images[0]!.sha256 = "b".repeat(64);
    input.images.push({ ...image, order: 1 });
    input.images[0] = { ...image, order: 0, height: 8 };
    expect(parsed).toEqual(expected);
    expect(Reflect.set(parsed, "resultFor", 1)).toBe(false);
    expect(Reflect.deleteProperty(parsed, "resultFor")).toBe(false);
    expect(Reflect.set(parsed.work!, "id", "changed")).toBe(false);
    expect(Reflect.deleteProperty(parsed.work!, "id")).toBe(false);
    for (const field of ["sha256", "mimeType", "bytes", "width", "height", "order"]) {
      expect(Reflect.set(parsed.images![0]!, field, "changed")).toBe(false);
      expect(Reflect.deleteProperty(parsed.images![0]!, field)).toBe(false);
    }
    expect(Reflect.set(parsed.images!, "0", { ...image, order: 0 })).toBe(false);
    expect(Reflect.set(parsed.images!, "1", { ...image, order: 1 })).toBe(false);
    expect(Reflect.set(parsed.images!, "length", 0)).toBe(false);
    expect(Reflect.deleteProperty(parsed.images!, "0")).toBe(false);
    expect(() => Object.defineProperty(parsed, "resultFor", { value: 2 })).toThrow();
    expect(parsed).toEqual(expected);
  });

  test.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["NaN", NaN],
    ["positive infinity", Infinity],
    ["negative infinity", -Infinity],
    ["string", "0"],
    ["null", null],
    ["boolean", false],
    ["undefined", undefined],
  ])("rejects malformed resultFor %s in every shape", (_name, resultFor) => {
    for (const [, fields] of shapes) {
      expect(() => parseMetadata({ ...fields, resultFor })).toThrow();
    }
  });

  test.each(["getter", "setter", "non-enumerable"] as const)(
    "rejects resultFor %s descriptors without invoking accessors in every shape",
    (kind) => {
      for (const [, fields] of shapes) {
        let gets = 0;
        let sets = 0;
        const descriptor: PropertyDescriptor = kind === "getter"
          ? { enumerable: true, get: () => { gets++; return 0; } }
          : kind === "setter"
            ? { enumerable: true, set: () => { sets++; } }
            : { enumerable: false, value: 0 };
        const input = Object.defineProperty({ ...fields }, "resultFor", descriptor);
        expect(() => parseMetadata(input)).toThrow();
        expect(gets).toBe(0);
        expect(sets).toBe(0);
      }
    },
  );

  test.each([
    ["string", "unknown"],
    ["symbol", Symbol("unknown")],
  ])("rejects unknown root %s keys alongside resultFor", (_name, key) => {
    expect(() => parseMetadata({ resultFor: 0, [key]: true })).toThrow();
  });

  test.each([
    ["an empty record", {}],
    ["an unknown provenance field", { work: { source: "task", completeness: "full", text: "private" } }],
    ["an unsupported source", { work: { source: "shell", completeness: "full" } }],
    ["an overlong identifier", { work: { source: "task", completeness: "full", id: "x".repeat(257) } }],
    ["an out-of-order image", { images: [{ ...image, order: 1 }, { ...image, order: 0 }] }],
    ["an uppercase digest", { images: [{ ...image, sha256: "A".repeat(64), order: 0 }] }],
    ["an oversized image", { images: [{ ...image, bytes: MAX_IMAGE_BYTES + 1, order: 0 }] }],
    ["too many images", { images: Array.from({ length: 33 }, (_, order) => ({ ...image, order })) }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseMetadata(value)).toThrow();
    if (Object.keys(value).length > 0) {
      expect(() => parseMetadata({ ...value, resultFor: 0 })).toThrow();
    }
  });
});

describe("image validation", () => {
  test("accepts real PNG, JPEG, and WebP content with its digest and dimensions", () => {
    const bytes = png(3, 2);
    const accepted = validateImage(bytes.toString("base64"), "image/png");
    expect(accepted.descriptor).toEqual({ sha256: sha256(bytes), mimeType: "image/png", bytes: bytes.length, width: 3, height: 2 });
    expect(validateImage(jpeg(7, 5).toString("base64"), "image/jpeg").descriptor).toMatchObject({ width: 7, height: 5 });
    expect(validateImage(webp(9, 4).toString("base64"), "image/webp").descriptor).toMatchObject({ width: 9, height: 4 });
  });

  test("a declared mime type must match the content", () => {
    expect(() => validateImage(png(1, 1).toString("base64"), "image/jpeg")).toThrow();
    expect(() => validateImage(jpeg(1, 1).toString("base64"), "image/png")).toThrow();
  });

  test("any corrupted PNG chunk fails its CRC, and bytes after IEND are refused", () => {
    const bytes = png(2, 2);
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 14] ^= 0xff;
    expect(() => validateImage(corrupted.toString("base64"), "image/png")).toThrow();
    expect(() => validateImage(Buffer.concat([bytes, Buffer.from([0])]).toString("base64"), "image/png")).toThrow();
  });

  test("encodings must be canonical base64 and bounded before decoding", () => {
    const data = png(1, 1).toString("base64");
    expect(() => validateImage(`${data.slice(0, 8)}\n${data.slice(8)}`, "image/png")).toThrow();
    expect(() => validateImage(data.slice(0, -1), "image/png")).toThrow();
    expect(() => validateImage(`${data}==`, "image/png")).toThrow();
    expect(() => validateImage("A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4), "image/png")).toThrow();
  });

  test("dimensions beyond the pixel budget are refused even when the header is well formed", () => {
    expect(() => validateImage(webp(16_383, 16_383).toString("base64"), "image/webp")).toThrow();
    expect(validateImage(webp(10_000, 4_000).toString("base64"), "image/webp").descriptor.width).toBe(10_000);
  });
});

describe("Store archive metadata, images, and paging", () => {
  test("work metadata with images survives restart and reads back the exact bytes", async () => {
    await withDirectory(async (directory) => {
      const store = await Store.open(directory);
      const data = png(2, 2).toString("base64");
      const descriptor = store.saveImage(data, "image/png");
      const work = store.append("work", "background report", new Date("2026-10-11T00:00:00.000Z"), {
        work: { source: "async-result", completeness: "pointer-only", id: "job-1", agentId: "agent-9" },
        images: [{ ...descriptor, order: 0 }],
      });
      await store.close();

      const restarted = await Store.open(directory);
      expect(restarted.messages).toEqual([work]);
      expect(restarted.readMessageImages(0)).toEqual([{ attachment: { ...descriptor, order: 0 }, data }]);
      await restarted.close();
    });
  });

  test("the work kind and work metadata must accompany each other, and failures write nothing", async () => {
    await withDirectory(async (directory) => {
      const store = await Store.open(directory);
      expect(() => store.append("work", "no provenance")).toThrow();
      expect(() => store.append("user", "stray", undefined, { work: { source: "task", completeness: "full" } })).toThrow();
      expect(store.messages).toHaveLength(0);
      await store.close();
      expect((await Store.open(directory)).messages).toHaveLength(0);
    });
  });

  test("an append naming an image that was never stored is refused before any record is written", async () => {
    await withDirectory(async (directory) => {
      const store = await Store.open(directory);
      const { descriptor } = validateImage(png(1, 1).toString("base64"), "image/png");
      expect(() => store.append("user", "unstored", undefined, { images: [{ ...descriptor, order: 0 }] })).toThrow();
      expect(store.messages).toHaveLength(0);
      await store.close();
    });
  });

  test("a stored image whose bytes change on disk is refused on read and on append", async () => {
    await withDirectory(async (directory) => {
      const store = await Store.open(directory);
      const data = png(2, 2);
      const descriptor = store.saveImage(data.toString("base64"), "image/png");
      const stored = join(directory, "images", descriptor.sha256);
      const tampered = Buffer.from(data);
      tampered[tampered.length - 14] ^= 0xff;
      await writeFile(stored, tampered);
      expect(() => store.readImage(descriptor)).toThrow();
      expect(() => store.append("user", "tampered", undefined, { images: [{ ...descriptor, order: 0 }] })).toThrow();
      expect(store.messages).toHaveLength(0);
      await store.close();
    });
  });

  test("a planted symlink at an image name is refused and its target is left untouched", async () => {
    await withDirectory(async (directory) => {
      const store = await Store.open(directory);
      const data = png(2, 2);
      const descriptor = store.saveImage(data.toString("base64"), "image/png");
      const outside = join(directory, "..", "outside.png");
      await writeFile(outside, data, { mode: 0o600 });
      const stored = join(directory, "images", descriptor.sha256);
      await rm(stored);
      await symlink(outside, stored);
      expect(() => store.readImage(descriptor)).toThrow();
      expect(() => store.saveImage(data.toString("base64"), "image/png")).toThrow();
      expect((await readFile(outside)).toString("base64")).toBe(data.toString("base64"));
      await store.close();
    });
  });

  test("message pages reconstruct multibyte text across restart and refuse invalid limits", async () => {
    await withDirectory(async (directory) => {
      const text = `${"é".repeat(10_000)}${"😀".repeat(3_000)}`;
      const store = await Store.open(directory);
      store.append("user", text);
      await store.close();

      const restarted = await Store.open(directory);
      const first = restarted.readMessagePage(0);
      expect(first.next).toBe(DEFAULT_PAGE_BYTES);
      expect(first.totalBytes).toBe(encoder.encode(text).length);
      expect(first.i).toBe(0);
      expect(first.kind).toBe("user");

      let offset = 0;
      let rebuilt = "";
      while (true) {
        const page = restarted.readMessagePage(0, offset, MAX_PAGE_BYTES);
        rebuilt += page.text;
        if (page.next === null) break;
        offset = page.next;
      }
      expect(rebuilt).toBe(text);
      expect(() => restarted.readMessagePage(0, 0, MAX_PAGE_BYTES + 1)).toThrow();
      expect(() => restarted.readMessagePage(1)).toThrow();
      await restarted.close();
    });
  });
});
