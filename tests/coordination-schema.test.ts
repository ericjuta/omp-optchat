import { describe, expect, test } from "bun:test";
import { parseCoordination, parseMetadata } from "../src/archive.ts";

function coordination() {
  return {
    version: 1 as const,
    requestId: "0123456789abcdef0123456789abcdef",
    sender: { instanceId: "sender-01", generation: 1, sessionId: "sender-session" },
    recipient: { instanceId: "recipient-01", generation: 2, sessionId: "recipient-session" },
    admission: "idle" as "idle" | "busy",
    admittedAt: 1,
  };
}

const image = {
  sha256: "a".repeat(64), mimeType: "image/png" as const, bytes: 10, width: 1, height: 1, order: 0,
};
const work = { source: "task" as const, completeness: "full" as const, id: "work-1" };
const optionalShapes = [
  ["alone", {}],
  ["with images", { images: [image] }],
  ["with work", { work }],
  ["with resultFor", { resultFor: 0 }],
  ["with images and work", { images: [image], work }],
  ["with images and resultFor", { images: [image], resultFor: 0 }],
  ["with work and resultFor", { work, resultFor: 0 }],
  ["with all optional fields", { images: [image], work, resultFor: 0 }],
] as const;
const levels = ["coordination", "sender", "recipient"] as const;
type Level = typeof levels[number];
const identityFields = ["instanceId", "generation", "sessionId"];
const rootFields = ["version", "requestId", "sender", "recipient", "admission", "admittedAt"];
const requiredFields = levels.flatMap((level) =>
  (level === "coordination" ? rootFields : identityFields).map((field) => [level, field] as const),
);

function recordAt(input: ReturnType<typeof coordination>, level: Level): Record<string, unknown> {
  return level === "coordination" ? input : input[level];
}

function expectRejected(input: unknown): void {
  expect(parseCoordination(input)).toBeUndefined();
  // Other valid metadata must not mask an invalid coordination field.
  for (const [, fields] of optionalShapes) {
    expect(() => parseMetadata({ ...fields, coordination: input })).toThrow();
  }
}

const nonRecords = [
  ["null", null], ["undefined", undefined], ["array", []], ["string", "record"],
  ["number", 1], ["boolean", true], ["bigint", 1n], ["symbol", Symbol("record")],
  ["function", () => undefined],
] as const;

function hostileDescriptor(kind: string, value: unknown, called: () => void): PropertyDescriptor {
  if (kind === "getter") return { enumerable: true, configurable: true, get: () => { called(); return value; } };
  if (kind === "setter") return { enumerable: true, configurable: true, set: () => { called(); } };
  return { enumerable: false, configurable: true, writable: true, value };
}

const descriptorKinds = ["getter", "setter", "non-enumerable"] as const;

describe("coordination schema strict admission", () => {
  test.each(["idle", "busy"] as const)("accepts version 1 and admission %s with exact fields", (admission) => {
    const input = { ...coordination(), admission };
    const parsed = parseCoordination(input)!;
    expect(parsed).toEqual(input);
    expect(Reflect.ownKeys(parsed).sort()).toEqual([...rootFields].sort());
    for (const identity of [parsed.sender, parsed.recipient]) {
      expect(Reflect.ownKeys(identity).sort()).toEqual([...identityFields].sort());
    }
  });

  test.each(optionalShapes)("accepts coordination metadata %s", (_name, fields) => {
    const input = { ...fields, coordination: coordination() };
    expect(parseMetadata(input)).toEqual(input);
  });

  test("coordination is optional when other valid metadata is present", () => {
    for (const [, fields] of optionalShapes.slice(1)) expect(parseMetadata(fields)).toEqual(fields);
    expect(() => parseMetadata({})).toThrow();
  });

  test.each([0, 2, -1, 1.5, "1", true, NaN, Infinity])("rejects unsupported version %s", (version) => {
    expectRejected({ ...coordination(), version });
  });

  test.each(["", "IDLE", "Busy", "queued", " idle", "busy ", 0, true, {}, []].map((admission) => [admission]))(
    "rejects unsupported admission %s", (admission) => {
      expectRejected({ ...coordination(), admission });
    },
  );

  test("accepts requestId grammar and inclusive length boundaries", () => {
    for (const requestId of ["Aa0._:-9", "x".repeat(128), ":".repeat(8)]) {
      const input = { ...coordination(), requestId };
      expect(parseCoordination(input)).toEqual(input);
      expect(parseMetadata({ coordination: input })).toEqual({ coordination: input });
    }
  });

  test("rejects invalid requestId length, characters and nonstrings", () => {
    for (const requestId of [
      "", "x".repeat(7), "x".repeat(129), "request id", "request/id", "request+id",
      "request@id", "request#id", "request=id", "request\nid", "request-id\n",
      "request\tid", "request\0id", "é".repeat(8), 12345678, true, {}, [],
    ]) {
      expectRejected({ ...coordination(), requestId });
    }
  });

  test.each(requiredFields)("rejects missing, null, undefined and inherited-only %s.%s", (level, field) => {
    for (const kind of ["missing", "null", "undefined", "inherited"] as const) {
      const input = coordination();
      const record = recordAt(input, level);
      const value = record[field];
      if (kind === "null") record[field] = null;
      else if (kind === "undefined") record[field] = undefined;
      else {
        delete record[field];
        if (kind === "inherited") Object.setPrototypeOf(record, { [field]: value });
      }
      expectRejected(input);
    }
  });

  test.each(requiredFields)("rejects accessor and hidden %s.%s without invoking accessors", (level, field) => {
    for (const kind of descriptorKinds) {
      const input = coordination();
      const record = recordAt(input, level);
      let calls = 0;
      Object.defineProperty(record, field, hostileDescriptor(kind, record[field], () => { calls++; }));
      expectRejected(input);
      expect(calls).toBe(0);
    }
  });

  test.each([...levels])("rejects unknown, content, authority and symbol fields at %s", (level) => {
    for (const field of ["unknown", "content", "authority", Symbol("unknown")]) {
      for (const kind of ["data", ...descriptorKinds]) {
        const input = coordination();
        let calls = 0;
        Object.defineProperty(recordAt(input, level), field, kind === "data"
          ? { enumerable: true, value: "not provenance" }
          : hostileDescriptor(kind, "not provenance", () => { calls++; }));
        expectRejected(input);
        expect(calls).toBe(0);
      }
    }
  });

  test.each(nonRecords)("rejects %s as coordination, either identity, or metadata record", (_name, value) => {
    expectRejected(value);
    for (const level of ["sender", "recipient"] as const) {
      expectRejected({ ...coordination(), [level]: value });
    }
    expect(() => parseMetadata(value)).toThrow();
  });

  test.each([...levels])("rejects inherited-only %s records without reading prototype getters", (level) => {
    const input = coordination();
    let calls = 0;
    const prototype = Object.fromEntries(Object.entries(recordAt(input, level)));
    for (const field of Object.keys(prototype)) {
      Object.defineProperty(prototype, field, { get: () => { calls++; return "unexpected"; } });
    }
    const inherited = Object.create(prototype);
    expectRejected(level === "coordination" ? inherited : { ...input, [level]: inherited });
    expect(calls).toBe(0);
  });

  test.each(["sender", "recipient"] as const)("accepts positive safe %s generations", (level) => {
    for (const generation of [1, Number.MAX_SAFE_INTEGER]) {
      const input = coordination();
      input[level].generation = generation;
      expect(parseCoordination(input)).toEqual(input);
      expect(parseMetadata({ coordination: input })).toEqual({ coordination: input });
    }
  });

  test.each(["sender", "recipient"] as const)("rejects invalid %s generations", (level) => {
    for (const generation of [0, -0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "1", true, {}, []]) {
      const input = coordination();
      expectRejected({ ...input, [level]: { ...input[level], generation } });
    }
  });

  test("accepts positive safe admittedAt boundaries", () => {
    for (const admittedAt of [1, Number.MAX_SAFE_INTEGER]) {
      const input = { ...coordination(), admittedAt };
      expect(parseCoordination(input)).toEqual(input);
      expect(parseMetadata({ coordination: input })).toEqual({ coordination: input });
    }
  });

  test("rejects non-positive, fractional, unsafe and nonnumeric admittedAt", () => {
    for (const admittedAt of [0, -0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "1", true, {}, []]) {
      expectRejected({ ...coordination(), admittedAt });
    }
  });

  test.each(["sender", "recipient"] as const)("accepts host instanceId boundaries for %s", (level) => {
    for (const instanceId of ["a0-b1-c2", "a".repeat(64), "-".repeat(8)]) {
      const input = coordination();
      input[level].instanceId = instanceId;
      expect(parseCoordination(input)).toEqual(input);
      expect(parseMetadata({ coordination: input })).toEqual({ coordination: input });
    }
  });

  test.each(["sender", "recipient"] as const)("rejects invalid instanceId grammar for %s", (level) => {
    for (const instanceId of ["", "a".repeat(7), "a".repeat(65), "SENDER-01", "sender_01", "sender.01", "sender 01", "sender-01\n", "é".repeat(8), 12345678, true, {}, []]) {
      const input = coordination();
      expectRejected({ ...input, [level]: { ...input[level], instanceId } });
    }
  });

  test.each(["sender", "recipient"] as const)("uses UTF-16 length, not UTF-8 bytes, for %s sessionId", (level) => {
    for (const sessionId of ["s", "s".repeat(1024), "é".repeat(1024), "😀".repeat(512)]) {
      const input = coordination();
      input[level].sessionId = sessionId;
      expect(parseCoordination(input)).toEqual(input);
      expect(parseMetadata({ coordination: input })).toEqual({ coordination: input });
    }
    for (const sessionId of ["", "s".repeat(1025), "é".repeat(1025), `${"😀".repeat(512)}a`, 1, true, {}, []]) {
      const input = coordination();
      expectRejected({ ...input, [level]: { ...input[level], sessionId } });
    }
  });
});

describe("coordination property at metadata root", () => {
  test.each([...descriptorKinds])("rejects %s coordination without invoking accessors", (kind) => {
    for (const [, fields] of optionalShapes) {
      let calls = 0;
      const input = Object.defineProperty({ ...fields }, "coordination", hostileDescriptor(kind, coordination(), () => { calls++; }));
      expect(() => parseMetadata(input)).toThrow();
      expect(calls).toBe(0);
    }
  });

  test("rejects null and present-undefined coordination rather than treating them as absent", () => {
    expectRejected(null);
    expectRejected(undefined);
  });

  test("inherited-only coordination does not supply metadata, even through a getter", () => {
    expect(() => parseMetadata(Object.create({ coordination: coordination() }))).toThrow();
    let calls = 0;
    const prototype = Object.defineProperty({}, "coordination", { get: () => { calls++; return coordination(); } });
    expect(() => parseMetadata(Object.create(prototype))).toThrow();
    expect(calls).toBe(0);
  });

  test("rejects unknown, content, authority and symbol metadata properties without reading them", () => {
    for (const field of ["unknown", "content", "authority", Symbol("unknown")]) {
      for (const kind of ["data", ...descriptorKinds]) {
        let calls = 0;
        const input = Object.defineProperty({ coordination: coordination() }, field, kind === "data"
          ? { enumerable: true, value: "not provenance" }
          : hostileDescriptor(kind, "not provenance", () => { calls++; }));
        expect(() => parseMetadata(input)).toThrow();
        expect(calls).toBe(0);
      }
    }
  });
});

describe("coordination immutable detached snapshots", () => {
  test.each(["parseCoordination", "parseMetadata"] as const)("%s detaches and freezes both identities and every field", (parser) => {
    const input = coordination();
    const expected = coordination();
    const metadata = parser === "parseMetadata" ? parseMetadata({ coordination: input }) : undefined;
    const parsed = metadata === undefined ? parseCoordination(input)! : metadata.coordination!;
    expect(parsed).toEqual(expected);
    expect(parsed).not.toBe(input);
    expect(parsed.sender).not.toBe(input.sender);
    expect(parsed.recipient).not.toBe(input.recipient);
    expect(parsed.sender).not.toBe(parsed.recipient);
    for (const value of [parsed, parsed.sender, parsed.recipient]) {
      expect(Object.isFrozen(value)).toBe(true);
      for (const field of Reflect.ownKeys(value)) {
        expect(Reflect.set(value, field, "changed")).toBe(false);
        expect(Reflect.deleteProperty(value, field)).toBe(false);
        expect(() => Object.defineProperty(value, field, { value: "changed" })).toThrow();
      }
      expect(Reflect.set(value, "authority", "human")).toBe(false);
    }
    if (metadata !== undefined) {
      expect(Object.isFrozen(metadata)).toBe(true);
      expect(Reflect.set(metadata, "coordination", coordination())).toBe(false);
      expect(Reflect.deleteProperty(metadata, "coordination")).toBe(false);
    }
    for (const identity of [input.sender, input.recipient]) {
      identity.instanceId = "changed-01";
      identity.generation = 99;
      identity.sessionId = "changed-session";
    }
    Reflect.set(input, "version", 2);
    input.requestId = "changed";
    input.admission = "busy";
    input.admittedAt = 99;
    input.sender = { instanceId: "replaced-01", generation: 7, sessionId: "replacement" };
    input.recipient = { instanceId: "replaced-02", generation: 8, sessionId: "replacement" };
    expect(parsed).toEqual(expected);
    if (metadata !== undefined) expect(metadata).toEqual({ coordination: expected });
  });

  test("coordination and images coexist in one detached deeply frozen metadata snapshot", () => {
    const input = { coordination: coordination(), images: [{ ...image }] };
    const expected = { coordination: coordination(), images: [{ ...image }] };
    const parsed = parseMetadata(input);
    expect(parsed).not.toBe(input);
    expect(parsed.images).not.toBe(input.images);
    expect(parsed.images![0]).not.toBe(input.images[0]);
    for (const value of [parsed, parsed.coordination, parsed.coordination!.sender, parsed.coordination!.recipient, parsed.images, parsed.images![0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    input.coordination.sender.sessionId = "mutated-sender";
    input.coordination.recipient.sessionId = "mutated-recipient";
    input.images[0]!.width = 9;
    input.images.push({ ...image, order: 1 });
    input.coordination = coordination();
    input.coordination.admission = "busy";
    expect(Reflect.set(parsed.images![0]!, "width", 9)).toBe(false);
    expect(Reflect.deleteProperty(parsed.images![0]!, "width")).toBe(false);
    expect(Reflect.set(parsed.images!, "length", 0)).toBe(false);
    expect(Reflect.deleteProperty(parsed.images!, "0")).toBe(false);
    expect(parsed).toEqual(expected);
  });
});
