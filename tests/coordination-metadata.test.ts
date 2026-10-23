import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetadata, validateImage, type MessageMetadata, type WorkMetadata } from "../src/archive.js";
import { exportJsonl, importHistory } from "../src/history.js";
import { Memory } from "../src/memory.js";
import { Store, type Kind, type Message } from "../src/store.js";

const DATE = "2026-01-02T03:04:05.000Z";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const WORK: WorkMetadata = { source: "task", completeness: "full", id: "job-1", name: "scout", agentId: "agent-1" };
const NON_NOTES: Exclude<Kind, "note">[] = ["user", "talk", "tool", "echo", "work"];

function coordination() {
  return {
    version: 1 as const,
    requestId: "request:0001",
    sender: { instanceId: "sender-0001", generation: 1, sessionId: "sender-session" },
    recipient: { instanceId: "recipient-0001", generation: 2, sessionId: "recipient-session" },
    admission: "idle" as "idle" | "busy",
    admittedAt: 1_767_323_045_000,
  };
}

function record(i: number, kind: Kind, text: string, metadata?: unknown) {
  return {
    i, kind, text, size: Buffer.byteLength(`${kind}: ${text}`, "utf8"), date: DATE,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function jsonl(records: readonly unknown[]): string {
  return records.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "optchat-coordination-"));
  const directory = join(root, "chat");
  const stores: Store[] = [];
  const memories: Memory[] = [];
  return {
    directory,
    async open() {
      const store = await Store.open(directory);
      stores.push(store);
      const memory = new Memory(store, async () => {
        throw new Error("unexpected coordination test compaction");
      });
      memories.push(memory);
      return { store, memory };
    },
    async close() {
      try {
        for (const memory of memories) await memory.close();
      } finally {
        try {
          for (const store of stores) await store.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
  };
}

async function files(directory: string) {
  return Promise.all(["main", "images"].map(async (stream) => {
    const path = join(directory, stream);
    const names = (await readdir(path)).sort();
    return {
      stream,
      files: await Promise.all(names.map(async (name) => ({ name, bytes: await readFile(join(path, name)) }))),
    };
  }));
}

const malformed: [string, unknown][] = [
  ["null coordination", null],
  ["array coordination", []],
  ["string coordination", "agent"],
  ["unknown coordination field", { ...coordination(), authority: "human" }],
];
for (const key of Object.keys(coordination())) {
  malformed.push([`missing ${key}`, Object.fromEntries(Object.entries(coordination()).filter(([name]) => name !== key))]);
}
for (const [field, values] of Object.entries({
  version: [0, 2, "1", null],
  requestId: ["", "a".repeat(7), "a".repeat(129), "request with spaces", 12345678],
  admission: ["queued", "IDLE", null],
  admittedAt: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "123", null],
})) {
  for (const value of values) malformed.push([`${field}=${JSON.stringify(value)}`, { ...coordination(), [field]: value }]);
}
for (const role of ["sender", "recipient"] as const) {
  for (const value of [null, [], "agent"]) {
    malformed.push([`${role}=${JSON.stringify(value)}`, { ...coordination(), [role]: value }]);
  }
  const identity = coordination()[role];
  malformed.push([`${role} unknown field`, { ...coordination(), [role]: { ...identity, authority: true } }]);
  for (const key of Object.keys(identity)) {
    malformed.push([`${role} missing ${key}`, {
      ...coordination(), [role]: Object.fromEntries(Object.entries(identity).filter(([name]) => name !== key)),
    }]);
  }
  for (const [field, values] of Object.entries({
    instanceId: ["a".repeat(7), "a".repeat(65), "UPPER-0001", "under_score", 12345678],
    generation: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null],
    sessionId: ["", "s".repeat(1025), 1, null],
  })) {
    for (const value of values) {
      malformed.push([`${role}.${field}=${JSON.stringify(value)}`, { ...coordination(), [role]: { ...identity, [field]: value } }]);
    }
  }
}

async function rejectedImport(last: unknown, reason: RegExp) {
  const f = await fixture();
  try {
    const { store, memory } = await f.open();
    memory.append("tool", "seed", new Date(DATE));
    memory.append("echo", "seed result", new Date(DATE), { resultFor: 0 });
    const attachment = { ...validateImage(PNG, "image/png").descriptor, order: 0 };
    expect(await readdir(join(f.directory, "images"))).toEqual([]);
    const before = await files(f.directory);
    const messages = structuredClone(store.messages);
    const append = spyOn(memory, "append");
    const saveImage = spyOn(store, "saveImage");
    try {
      const first = {
        ...record(0, "note", "valid coordination prefix", { coordination: coordination(), images: [attachment] }),
        images: [{ ...attachment, data: PNG }],
      };
      expect(() => importHistory(memory, jsonl([first, last]))).toThrow(reason);
      expect(append).not.toHaveBeenCalled();
      expect(saveImage).not.toHaveBeenCalled();
      expect(store.messages).toEqual(messages);
      expect(await files(f.directory)).toEqual(before);
    } finally {
      append.mockRestore();
      saveImage.mockRestore();
    }
    expect(memory.append("note", "still writable", new Date(DATE), { coordination: coordination() }).i).toBe(2);
  } finally {
    await f.close();
  }
}

async function rejectedReplay(last: unknown, reason: RegExp) {
  const f = await fixture();
  try {
    const { store, memory } = await f.open();
    const seed = memory.append("user", "seed", new Date(DATE));
    await memory.close();
    await store.close();
    const names = await readdir(join(f.directory, "main"));
    expect(names).toHaveLength(1);
    const path = join(f.directory, "main", names[0]!);
    await writeFile(path, jsonl([seed, last]));
    const before = await files(f.directory);
    await expect(f.open()).rejects.toThrow(reason);
    expect(await files(f.directory)).toEqual(before);
    // A failed replay must release its writer lease as well as rejecting the record.
    await writeFile(path, jsonl([seed]));
    const reopened = await f.open();
    expect(reopened.store.messages).toEqual([seed]);
    expect(reopened.memory.append("note", "recovered", new Date(DATE), { coordination: coordination() }).i).toBe(1);
  } finally {
    await f.close();
  }
}

describe("coordination metadata", () => {
  test.each(["idle", "busy"] as const)("snapshots and freezes %s coordination through append and reopen", async (admission) => {
    const f = await fixture();
    try {
      const { store, memory } = await f.open();
      const input = { ...coordination(), admission };
      const expected = structuredClone(input);
      const metadata = { coordination: input };
      const note = store.append("note", "agent note 🦊", new Date(DATE), metadata);
      expect(note.metadata).toEqual({ coordination: expected });
      expect(note.metadata).not.toBe(metadata);
      expect(note.metadata?.coordination).not.toBe(input);
      expect(note.metadata?.coordination?.sender).not.toBe(input.sender);
      expect(note.metadata?.coordination?.recipient).not.toBe(input.recipient);
      for (const value of [note.metadata, note.metadata?.coordination, note.metadata?.coordination?.sender, note.metadata?.coordination?.recipient]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
      input.requestId = "request:changed";
      input.sender.generation = 7;
      input.recipient.sessionId = "changed-session";
      expect(note.metadata).toEqual({ coordination: expected });
      await memory.close();
      await store.close();
      const reopened = await f.open();
      expect(reopened.store.messages).toEqual([note]);
      const replayed = reopened.store.messages[0]!.metadata;
      for (const value of [replayed, replayed?.coordination, replayed?.coordination?.sender, replayed?.coordination?.recipient]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
    } finally {
      await f.close();
    }
  });

  test("accepts inclusive identity and request bounds with character-counted Unicode sessions", () => {
    const value = coordination();
    value.requestId = "A._:-012";
    value.sender = { instanceId: "a".repeat(8), generation: 1, sessionId: "é".repeat(1024) };
    value.recipient = { instanceId: "z".repeat(64), generation: Number.MAX_SAFE_INTEGER, sessionId: "s" };
    value.admittedAt = Number.MAX_SAFE_INTEGER;
    expect(parseMetadata({ coordination: value })).toEqual({ coordination: value });
    value.requestId = "A".repeat(128);
    expect(parseMetadata({ coordination: value })).toEqual({ coordination: value });
  });

  test.each(NON_NOTES)("Store.append rejects coordination on %s without writes and stays usable", async (kind) => {
    const f = await fixture();
    try {
      const { store } = await f.open();
      store.append("user", "seed", new Date(DATE));
      const before = await files(f.directory);
      const messages = structuredClone(store.messages);
      const metadata: MessageMetadata = { coordination: coordination(), ...(kind === "work" ? { work: WORK } : {}) };
      expect(() => store.append(kind, "wrong kind", new Date(DATE), metadata)).toThrow(/coordination requires note kind/);
      expect(store.messages).toEqual(messages);
      expect(await files(f.directory)).toEqual(before);
      expect(store.append("note", "still writable", new Date(DATE), { coordination: coordination() }).i).toBe(1);
    } finally {
      await f.close();
    }
  });

  test.each(NON_NOTES)("JSONL import rejects coordination on %s atomically before saving inline PNG", async (kind) => {
    await rejectedImport(record(1, kind, "wrong kind", {
      coordination: coordination(), ...(kind === "work" ? { work: WORK } : {}),
    }), /coordination is only allowed on note records/);
  });

  test.each(NON_NOTES)("Store.open rejects replayed coordination on %s", async (kind) => {
    await rejectedReplay(record(1, kind, "wrong kind", {
      coordination: coordination(), ...(kind === "work" ? { work: WORK } : {}),
    }), /coordination requires note kind/);
  });

  test.each(malformed)("parseMetadata strictly rejects malformed %s", (_name, value) => {
    expect(() => parseMetadata({ coordination: value })).toThrow(/coordination/);
  });

  test.each(malformed)("JSONL import rejects malformed %s atomically before saving inline PNG", async (_name, value) => {
    await rejectedImport(record(1, "note", "invalid metadata", { coordination: value }), /Invalid history import on line 2:.*coordination/);
  });

  test.each(malformed)("Store.open rejects replayed malformed %s", async (_name, value) => {
    await rejectedReplay(record(1, "note", "invalid metadata", { coordination: value }), /coordination/);
  });

  test("legacy inline images reconstruct metadata refs without losing coordination on import and reopen", async () => {
    const f = await fixture();
    try {
      const { store, memory } = await f.open();
      const attachment = { ...validateImage(PNG, "image/png").descriptor, order: 3 };
      const input = {
        ...record(0, "note", "legacy inline image", { coordination: coordination() }),
        images: [{ ...attachment, data: PNG }],
      };
      expect(importHistory(memory, jsonl([input]))).toBe(1);
      const expected = {
        ...record(0, "note", "legacy inline image"),
        metadata: { coordination: coordination(), images: [attachment] },
      };
      expect(store.messages).toEqual([expected]);
      expect(store.readMessageImages(0)[0]?.data).toBe(PNG);
      const exported = exportJsonl(memory);
      const exportedRecord: unknown = JSON.parse(exported);
      expect(exportedRecord).toEqual({ ...expected, images: input.images });
      await memory.close();
      await store.close();
      const reopened = await f.open();
      expect(reopened.store.messages).toEqual([expected]);
      expect(reopened.store.readMessageImages(0)[0]?.data).toBe(PNG);
      expect(exportJsonl(reopened.memory)).toBe(exported);
    } finally {
      await f.close();
    }
  });

  test("mixed five-field legacy and coordination logs preserve work and resultFor across reopen and rebased export/import", async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const opened = await source.open();
      opened.memory.append("user", "legacy user", new Date(DATE));
      await opened.memory.close();
      await opened.store.close();
      const names = await readdir(join(source.directory, "main"));
      expect(names).toHaveLength(1);
      const records = [
        record(0, "user", "legacy user"),
        record(1, "note", "legacy note"),
        record(2, "tool", "task invocation"),
        record(3, "echo", "task result", { resultFor: 2 }),
        record(4, "work", "task report", { work: WORK, resultFor: 2 }),
        record(5, "note", "coordination note", { coordination: coordination() }),
      ];
      await writeFile(join(source.directory, "main", names[0]!), jsonl(records));
      const { store, memory } = await source.open();
      expect(records).toEqual(store.messages);
      for (const message of store.messages.slice(0, 3)) {
        expect(Object.keys(message).sort()).toEqual(["date", "i", "kind", "size", "text"]);
        expect(message.metadata).toBeUndefined();
      }
      const image = { ...store.saveImage(PNG, "image/png"), order: 0 };
      memory.append("note", "coordination with image", new Date(DATE), {
        coordination: { ...coordination(), admission: "busy" }, images: [image],
      });
      const expected = structuredClone(store.messages);
      const exported = exportJsonl(memory);
      const target = await destination.open();
      expect(importHistory(target.memory, exported)).toBe(7);
      expect(target.store.messages).toEqual(expected);
      expect(exportJsonl(target.memory)).toBe(exported);
      expect(target.store.readMessageImages(6)[0]?.data).toBe(PNG);
      // A second import rebases only IDs and result links, not agent identities.
      expect(importHistory(target.memory, exported)).toBe(7);
      const rebased: Message[] = expected.map((message) => ({
        ...message,
        i: message.i + 7,
        ...(message.metadata?.resultFor === undefined ? {} : {
          metadata: { ...message.metadata, resultFor: message.metadata.resultFor + 7 },
        }),
      }));
      expect(target.store.messages).toEqual([...expected, ...rebased]);
      expect(target.store.messages[11]!.metadata).toEqual({ work: WORK, resultFor: 9 });
      expect(target.store.messages[12]!.metadata).toEqual({ coordination: coordination() });
      expect(target.store.readMessageImages(13)[0]?.data).toBe(PNG);
      await target.memory.close();
      await target.store.close();
      const reopened = await destination.open();
      expect(reopened.store.messages).toEqual([...expected, ...rebased]);
    } finally {
      try {
        await source.close();
      } finally {
        await destination.close();
      }
    }
  });
});
