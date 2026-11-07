import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readConfig } from "../src/config.ts";
import { adoptChildSource, attachChildView, publishChildSource, type ChildView } from "../src/handoff.ts";
import { createOptChat } from "../src/index.ts";
import { Memory, type Summarize } from "../src/memory.ts";
import { Store } from "../src/store.ts";
import { readSourcePage } from "../src/source-page.ts";
import {
  EVIDENCE_BYTES,
  EVIDENCE_PASSAGE_BYTES,
  EVIDENCE_PASSAGES,
  gatherEvidence,
  renderEvidence,
  type EvidenceMemory,
  type EvidenceResult,
} from "../src/system1/evidence.ts";
import { startCompressorServer } from "./helpers/compressor-server.ts";
import { fakeJudge } from "./helpers/fake-judge.ts";
import { openFakeHost, type FakeHost, type HostMessage } from "./helpers/fake-host.ts";
import { ALL_GATES_OFF, anthropicModel, Harness, talk } from "./helpers/system1-chat.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  // LIFO: every Memory closes before its Store, and Stores close before rm.
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "evidence test cleanup failed");
});

/** Summaries that always fail: these tests read the raw log, never the tree. */
const noCompactor: Summarize = async () => {
  throw new Error("no compactor in this test");
};

async function open(): Promise<{ store: Store; memory: Memory }> {
  const root = await mkdtemp(join(tmpdir(), "optchat-evidence-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await Store.open(join(root, "chat"));
  cleanups.push(() => store.close());
  const memory = new Memory(store, noCompactor, { report: () => {} });
  cleanups.push(() => memory.close());
  return { store, memory };
}

/** The live-memory identity and exact-page adapter; `onPage` sees every source read, including index construction. */
function reader(store: Store, memory: Memory, onPage: (id: number) => void = () => {}): EvidenceMemory {
  return {
    sourceIdentity: memory,
    page: (id, offset, maxBytes, maxTraversalBytes) => {
      onPage(id);
      const source = store.messages[id]!;
      return { ...readSourcePage(source, offset, maxBytes, maxTraversalBytes), kind: source.kind, metadata: source.metadata };
    },
  };
}

/** Messages that share no ranking word with the questions below, so a question word stays rare. */
function fillers(store: Store, count: number): void {
  for (let i = 0; i < count; i++) store.append("talk", `general chatter about lunch plans number ${i}`);
}

const WORK = { work: { source: "task" as const, completeness: "full" as const, name: "Reporter" } };
const bytesOf = (passages: EvidenceResult["passages"]): number => passages.reduce((sum, passage) => sum + passage.end - passage.start, 0);

describe("gatherEvidence", () => {
  test("finds a passage deep inside a long report, and zoom(id, 1, start) reopens exactly its text", async () => {
    const { store, memory } = await open();
    fillers(store, 5);
    const lines = (from: number, count: number): string =>
      Array.from({ length: count }, (_, i) => `status line ${String(from + i).padStart(4, "0")} ok`).join("\n");
    const fact = "bun run db:migrate --env staging was the command the migration job ran";
    const report = store.append("work", `${lines(0, 1200)}\n${fact}\n${lines(1200, 200)}`, new Date(), WORK).i;

    const result = await gatherEvidence(reader(store, memory), "what exact command did the migration job run", { upperBound: store.messages.length });

    expect(result.complete).toBe(true);
    expect(result.searched).toEqual([report]);
    const [passage] = result.passages;
    expect(passage).toBeDefined();
    expect(passage!.id).toBe(report);
    expect(passage!.kind).toBe("work");
    expect(passage!.text).toContain(fact);
    // Deep: past the first 16 KB page that zoom(id, 1) returns.
    expect(passage!.start).toBeGreaterThan(16_384);
    expect(passage!.complete).toBe(false);
    expect(Buffer.byteLength(passage!.text)).toBe(passage!.end - passage!.start);
    const page = memory.zoom(report, 1, passage!.start);
    expect(Buffer.from(page.text).subarray(0, passage!.end - passage!.start).toString("utf8")).toBe(passage!.text);
  });

  test("in a short chat whose current question shares the report's words, the report still yields the passage", async () => {
    // Live failure 2026-11-07: report, "stored", then the question. Every word the report shares with the question
    // has df 2 of 3, whose BM25 weight clamps to 0, so only the question itself ranked and no report was searched.
    const { store, memory } = await open();
    const filler = "Migration job log line: copied shard without incident.\n".repeat(300);
    const fact = "The exact command the migration job ran was: bun run db:migrate --target=shard-7";
    const report = store.append("user", `${filler}${fact}\n${filler}`).i;
    store.append("talk", "stored");
    store.append("user", "Call chat_evidence with 'what exact command did the migration job run'.");

    const result = await gatherEvidence(reader(store, memory), "what exact command did the migration job run", { upperBound: store.messages.length });

    expect(result.searched).toContain(report);
    expect(result.passages.some((passage) => passage.id === report && passage.text.includes(fact))).toBe(true);
  });

  test("passages never split a UTF-8 sequence, and their byte offsets match the source bytes", async () => {
    const { store, memory } = await open();
    fillers(store, 4);
    const text = `needle ${"é😀漢".repeat(150)}\n`.repeat(8);
    const id = store.append("user", text).i;
    const source = Buffer.from(text);
    // A raw 2,048-byte cut would split a character here, so the test exercises the hazard.
    expect(source.subarray(0, EVIDENCE_PASSAGE_BYTES).toString("utf8").endsWith("\uFFFD")).toBe(true);

    const result = await gatherEvidence(reader(store, memory), "needle", { upperBound: store.messages.length });

    expect(result.passages.length).toBeGreaterThan(1);
    for (const passage of result.passages) {
      expect(passage.id).toBe(id);
      expect(passage.end - passage.start).toBeLessThanOrEqual(EVIDENCE_PASSAGE_BYTES);
      expect(passage.text).not.toContain("\uFFFD");
      expect(source.subarray(passage.start, passage.end).toString("utf8")).toBe(passage.text);
      expect(memory.zoom(id, 1, passage.start).text.startsWith(passage.text)).toBe(true);
    }
  });

  test("results stay within the passage count and byte caps", async () => {
    const { store, memory } = await open();
    fillers(store, 20);
    for (let i = 0; i < 12; i++) store.append("echo", `orchid ${"x".repeat(1_000)}\n`.repeat(5));
    const bound = { upperBound: store.messages.length };

    const full = await gatherEvidence(reader(store, memory), "orchid", bound);
    expect(full.passages).toHaveLength(EVIDENCE_PASSAGES);
    expect(bytesOf(full.passages)).toBeLessThanOrEqual(EVIDENCE_BYTES);
    for (const passage of full.passages) expect(passage.end - passage.start).toBeLessThanOrEqual(EVIDENCE_PASSAGE_BYTES);

    expect((await gatherEvidence(reader(store, memory), "orchid", { ...bound, maxPassages: 3 })).passages).toHaveLength(3);
    const small = await gatherEvidence(reader(store, memory), "orchid", { ...bound, maxBytes: 5_000 });
    expect(small.passages).toHaveLength(2);
    expect(bytesOf(small.passages)).toBeLessThanOrEqual(5_000);
    // Passages from one message never overlap.
    for (const a of full.passages) {
      for (const b of full.passages) {
        if (a !== b && a.id === b.id) expect(a.start < b.end && b.start < a.end).toBe(false);
      }
    }
  });

  test("question words no searched message contains are reported", async () => {
    const { store, memory } = await open();
    fillers(store, 5);
    store.append("user", "the orchid greenhouse code is 4417");

    const result = await gatherEvidence(reader(store, memory), "orchid zanzibar", { upperBound: store.messages.length });

    expect(result.passages).toHaveLength(1);
    expect(result.missing).toEqual(["zanzibar"]);
    expect(renderEvidence("orchid zanzibar", result)).toContain('[question words in no searched message: "zanzibar"]');
  });

  test("partial captured reports are listed and marked: [incomplete: ...] text and pointer-only metadata", async () => {
    const { store, memory } = await open();
    fillers(store, 8);
    const cut = store.append("work", "[incomplete: agent timed out] orchid count was 12", new Date(), WORK).i;
    const pointer = store.append("work", "orchid report pointer", new Date(), {
      work: { source: "task", completeness: "pointer-only", name: "Pointer" },
    }).i;
    const whole = store.append("work", "orchid report, complete", new Date(), WORK).i;

    const result = await gatherEvidence(reader(store, memory), "orchid", { upperBound: store.messages.length });

    expect(result.searched).toEqual([cut, pointer, whole]);
    expect(result.incomplete).toEqual([cut, pointer]);
    const text = renderEvidence("orchid", result);
    expect(text).toContain(`message ${cut} (work, partial report)`);
    expect(text).toContain(`message ${pointer} (work, partial report)`);
    expect(text).toContain(`message ${whole} (work), bytes`);
    expect(text).toContain(`[incomplete or partial reports among them: ${cut}, ${pointer}]`);
  });

  test("the upper bound excludes later messages from candidates, passages and the trailer", async () => {
    const { store, memory } = await open();
    fillers(store, 3);
    const early = store.append("user", "orchid seeds were ordered").i;
    fillers(store, 3);
    const later = store.append("user", "orchid greenhouse code is 4417").i;

    const bounded = await gatherEvidence(reader(store, memory), "orchid greenhouse code", { upperBound: later });
    expect(bounded.searched).toEqual([early]);
    expect(bounded.passages.map((passage) => passage.id)).toEqual([early]);
    expect(bounded.missing).toEqual(["greenhouse", "code"]);

    const all = await gatherEvidence(reader(store, memory), "orchid greenhouse code", { upperBound: later + 1 });
    expect(all.searched).toEqual([early, later]);
    expect(all.passages[0]!.id).toBe(later);
  });

  test("a question with no ranking word, a cancel, and malformed limits", async () => {
    const { store, memory } = await open();
    fillers(store, 3);
    const empty = await gatherEvidence(reader(store, memory), "a b ?", { upperBound: store.messages.length });
    expect(empty.passages).toEqual([]);
    expect(empty.explanation.omissions).toContain("no-query-terms");

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(gatherEvidence(reader(store, memory), "lunch", { upperBound: 3, signal: controller.signal })).rejects.toThrow("cancelled");
    await expect(gatherEvidence(reader(store, memory), "lunch", { upperBound: -1 })).rejects.toThrow(RangeError);
    await expect(gatherEvidence(reader(store, memory), "lunch", { upperBound: 3, maxPassages: 0 })).rejects.toThrow(RangeError);
    await expect(gatherEvidence(reader(store, memory), "lunch", { upperBound: 3, maxBytes: 1.5 })).rejects.toThrow(RangeError);
  });
});

describe("--optchat-evidence", () => {
  const flags = (values: Record<string, string | boolean>) =>
    readConfig({ getFlag: (name: string) => values[name] } as Pick<ExtensionAPI, "getFlag">, "/srv/agent/optchat");

  test("is on by default, the opt-out wins, and malformed values fail closed", () => {
    expect(flags({}).evidence).toBe(true);
    expect(flags({ "optchat-evidence": true }).evidence).toBe(true);
    expect(flags({ "optchat-evidence": "false" }).evidence).toBe(false);
    expect(flags({ "no-optchat-evidence": true }).evidence).toBe(false);
    expect(flags({ "optchat-evidence": true, "no-optchat-evidence": true }).evidence).toBe(false);
    expect(() => flags({ "optchat-evidence": "yes" })).toThrow(/--optchat-evidence(?![-\w])/);
    expect(() => flags({ "no-optchat-evidence": "yes" })).toThrow(/--no-optchat-evidence(?![-\w])/);
  });
});

describe("chat_evidence through OptChat", () => {
  const harness = new Harness();
  afterEach(() => harness.close());

  test("registered by default and with every System One gate off; it resolves no judge", async () => {
    const judge = fakeJudge(() => {
      throw new Error("chat_evidence never asks the judge");
    });
    const { host } = await harness.open({ flags: { ...ALL_GATES_OFF }, judge });
    let transcript: HostMessage[] = [];
    for (const text of ["morning coffee for two", "weather in Lisbon", "send the invoice"]) transcript = await talk(host, transcript, text);
    expect(host.tools.has("chat_recall")).toBe(false);

    const answer = await host.callTool("chat_evidence", { question: "lisbon weather" });

    expect(answer).toStartWith("[optchat evidence] lisbon weather\npassage 1: message 2 (user), bytes 0-17 of 17;");
    expect(answer).toContain("\nweather in Lisbon\n");
    expect(judge.requests).toHaveLength(0);
    expect((await harness.open()).host.tools.has("chat_evidence")).toBe(true);
  });

  test("not registered under --no-optchat-evidence, even beside --optchat-evidence", async () => {
    const cases: Array<Record<string, boolean>> = [{ "no-optchat-evidence": true }, { "optchat-evidence": true, "no-optchat-evidence": true }];
    for (const flags of cases) {
      const { host } = await harness.open({ flags });
      expect(host.tools.has("chat_evidence")).toBe(false);
      expect(host.tools.has("chat_search")).toBe(true);
    }
  });

  test("a child's snapshot reads passages only from messages it holds", async () => {
    const manager = {};
    const compressor = await startCompressorServer();
    cleanups.push(() => compressor.stop());
    const host: FakeHost = await openFakeHost(createOptChat({ judge: () => fakeJudge(() => ({})) }), {
      flags: { ...ALL_GATES_OFF },
      model: compressor.model,
      mainModel: anthropicModel(),
      apiKey: "fixture-key",
      artifactManager: manager,
    });
    cleanups.push(() => host.close());
    let transcript: HostMessage[] = [];
    for (const text of ["morning coffee for two", "orchid seeds were ordered", "send the invoice"]) transcript = await talk(host, transcript, text);
    const snapshot = adoptChildSource(manager)!.snapshot();
    transcript = await talk(host, transcript, "orchid greenhouse code is 4417");

    const child = await snapshot.evidence!("orchid greenhouse code", undefined);
    expect(child).toContain("orchid seeds were ordered");
    expect(child).not.toContain("4417");
    expect(child).toContain(`[searched messages: 2]`);
    expect(child).toContain('[question words in no searched message: "greenhouse", "code"]');

    const parent = await host.callTool("chat_evidence", { question: "orchid greenhouse code" });
    expect(parent).toContain("orchid greenhouse code is 4417");
  });

  test("extraction opens the provider by default; opt-out wins", async () => {
    const states: string[] = [];
    let opened = 0;
    const extractor = () => {
      opened++;
      return async (state: string) => {
        states.push(state);
        const at = state.indexOf("Lisbon");
        const start = [...state.slice(0, at)].length;
        return { kind: "answer", value: "Lisbon", guess: "Lisbon", pNull: 0.02, span: [start, start + 6], stateText: state, truncated: false, cost: null, provider: "Cloudflare" } as const;
      };
    };
    const { "no-optchat-extract": _optOut, ...gatesOff } = ALL_GATES_OFF;
    for (const { extract, flags } of [
      { extract: true, flags: gatesOff },
      { extract: false, flags: { ...gatesOff, "no-optchat-extract": true } },
      { extract: true, flags: { ...gatesOff, "optchat-extract": true } },
      { extract: false, flags: { ...gatesOff, "optchat-extract": true, "no-optchat-extract": true } },
    ]) {
      states.length = 0;
      opened = 0;
      const compressor = await startCompressorServer();
      cleanups.push(() => compressor.stop());
      const host: FakeHost = await openFakeHost(createOptChat({ judge: () => fakeJudge(() => ({})), extractor }), {
        flags,
        model: compressor.model,
        mainModel: anthropicModel(),
        apiKey: "fixture-key",
      });
      cleanups.push(() => host.close());
      let transcript: HostMessage[] = [];
      for (const text of ["morning coffee for two", "weather in Lisbon"]) transcript = await talk(host, transcript, text);
      const answer = await host.callTool("chat_evidence", { question: "lisbon weather" });
      if (!extract) {
        expect(opened).toBe(0);
        expect(states).toHaveLength(0);
        expect(answer).not.toContain("[extraction");
        continue;
      }
      expect(opened).toBe(1);
      expect(states).toHaveLength(1);
      expect(answer).toContain('"Lisbon" at message 2 bytes 11-17; zoom(2, 1, 11)');
      expect(answer).toContain("not a verified answer");
      expect(answer).toContain("cost unknown");
    }
  });

  test("with no openrouter key the extractor adds nothing, and malformed extract flags fail closed", async () => {
    const { "no-optchat-extract": _optOut, ...gatesOff } = ALL_GATES_OFF;
    const compressor = await startCompressorServer();
    cleanups.push(() => compressor.stop());
    const host: FakeHost = await openFakeHost(
      createOptChat({ judge: () => fakeJudge(() => ({})), extractor: () => async () => ({ kind: "off", reason: "no openrouter key resolved" }) }),
      { flags: { ...gatesOff, "optchat-extract": true }, model: compressor.model, mainModel: anthropicModel(), apiKey: "fixture-key" },
    );
    cleanups.push(() => host.close());
    let transcript: HostMessage[] = [];
    for (const text of ["morning coffee for two", "weather in Lisbon"]) transcript = await talk(host, transcript, text);
    expect(await host.callTool("chat_evidence", { question: "lisbon weather" })).not.toContain("[extraction");
    const read = (values: Record<string, string | boolean>) =>
      readConfig({ getFlag: (name: string) => values[name] } as Pick<ExtensionAPI, "getFlag">, "/srv/agent/optchat");
    expect(read({ "optchat-extract": true, "no-optchat-extract": true }).extract).toBe(false);
    expect(() => read({ "optchat-extract-null": "0" })).toThrow(/--optchat-extract-null/);
    expect(() => read({ "optchat-extract": "yes" })).toThrow(/--optchat-extract(?![-\w])/);
  });
});

describe("child bridge", () => {
  const SNAPSHOT = "<chat>\n0+1|user: hi\n</chat>";

  function bridge() {
    const tools = new Map<string, { execute: (id: string, input: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ content: Array<{ text: string }> }> }>();
    const hooks: Array<(event: { systemPrompt: string[] }, ctx: ExtensionContext) => { systemPrompt: string[] } | undefined> = [];
    const stub: unknown = new Proxy(() => stub, { get: () => stub, apply: () => stub });
    const pi = {
      zod: stub,
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
      on: (name: string, hook: never) => { if (name === "before_agent_start") hooks.push(hook); },
    };
    const ctx = (manager: object) =>
      ({ sessionManager: { getArtifactManager: () => manager, getSessionId: () => "child" }, ui: { notify: () => {} } }) as unknown as ExtensionContext;
    return { pi: pi as unknown as ExtensionAPI, tools, hooks, ctx };
  }

  const base: Omit<ChildView, "evidence"> = {
    render: SNAPSHOT,
    upperBound: 1,
    zoom: () => ({ text: "hi", next: null, totalBytes: 2, offset: 0 }),
    date: () => "",
    work: () => {
      throw new Error("none");
    },
    search: () => ({ hits: [], next: null }),
  };

  test("a snapshot with evidence registers chat_evidence and names it; one without registers and names nothing new", async () => {
    const asked: string[] = [];
    const withEvidence = {};
    const revoke = publishChildSource(withEvidence, {
      owner: "parent",
      snapshot: () => ({ ...base, evidence: async (question) => (asked.push(question), "[optchat evidence] answered") }),
    });
    const { pi, tools, hooks, ctx } = bridge();
    attachChildView(pi, ctx(withEvidence), "guide");
    expect([...tools.keys()].sort()).toEqual(["chat_evidence", "chat_search", "date", "work", "zoom"]);
    expect(hooks[0]!({ systemPrompt: [] }, ctx(withEvidence))!.systemPrompt[0]).toContain(
      "# Parent chat snapshot (read-only; zoom, date, work, chat_search and chat_evidence only)",
    );
    const result = await tools.get("chat_evidence")!.execute("call", { question: "where" }, undefined, undefined, ctx(withEvidence));
    expect(result.content[0]!.text).toBe("[optchat evidence] answered");
    expect(asked).toEqual(["where"]);
    // Another session is refused before the parent is read; a revoked publication is refused too.
    await expect(tools.get("chat_evidence")!.execute("call", { question: "where" }, undefined, undefined, ctx({}))).rejects.toThrow(/not attached/);
    revoke();
    await expect(tools.get("chat_evidence")!.execute("call", { question: "where" }, undefined, undefined, ctx(withEvidence))).rejects.toThrow();
    expect(asked).toEqual(["where"]);

    const without = {};
    const revokeWithout = publishChildSource(without, { owner: "parent", snapshot: () => ({ ...base }) });
    const plain = bridge();
    attachChildView(plain.pi, plain.ctx(without), "guide");
    expect(plain.tools.has("chat_evidence")).toBe(false);
    expect(plain.hooks[0]!({ systemPrompt: [] }, plain.ctx(without))!.systemPrompt[0]).toContain(
      "# Parent chat snapshot (read-only; zoom, date, work and chat_search only)",
    );
    revokeWithout();
  });
});
