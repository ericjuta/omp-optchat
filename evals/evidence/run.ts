#!/usr/bin/env bun
/**
 * Evidence eval runner (Milestone 4 of plans/evidence-layer.md). Three arms on the same frozen stores:
 *
 *   A  chat_recall: production `recall()` judged by the host `judge` role
 *   B  chat_evidence: production `gatherEvidence()`, no model
 *   C  B plus the production Clairic extractor (`openRouterExtractor`), keyed from the OMP `openrouter` credential
 *
 * Each case's chat is written into a real Store and built into a real Memory with a deterministic head summariser
 * (the first bytes of each input), so A navigates a real tree without a compressor call. Writes under --out:
 * results.jsonl (one row per case, rep and arm), errors.jsonl, run.json (settings, spend, per-arm scores, span probe).
 *
 *   bun evals/evidence/run.ts --out <dir> [--arms A,B,C] [--reps 2] [--concurrency 4] [--mode live|oracle]
 *     [--cases evals/evidence/cases/synthetic-20261107.jsonl] [--max-judge-calls 1500] [--max-extract-calls 120]
 *     [--max-usd-a 1] [--max-usd-c 1]
 *
 * `oracle` makes no provider call: A is skipped and C's extractor answers with the gold span (or nothing on abstain
 * cases), which must score C at 1.0 and proves the grader and span mapping before any paid run.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { DEFAULTS } from "../../src/config.ts";
import { Memory, type Summarize } from "../../src/memory.ts";
import { Store } from "../../src/store.ts";
import { gatherEvidence, type EvidenceMemory } from "../../src/system1/evidence.ts";
import { type Extraction, type Extractor, extractionState, mapSpan, openRouterExtractor } from "../../src/system1/extract.ts";
import { recall } from "../../src/system1/recall.ts";
import type { EvidenceCase } from "./build-cases.ts";
import { type ArmScores, gradeA, gradeB, gradeC, type Row, score, type Verdict } from "./grade.ts";
import { JudgeBudget, metered, newMeter, openHostJudge } from "../recall/judge.ts";

type Arm = "A" | "B" | "C";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
};
const out = flag("out");
if (!out) throw new Error("--out is required");
const arms = (flag("arms", "A,B,C")!.split(",") as Arm[]).filter((a) => ["A", "B", "C"].includes(a));
const reps = Number(flag("reps", "2"));
const concurrency = Number(flag("concurrency", "4"));
const mode = flag("mode", "live") as "live" | "oracle";
const casesPath = flag("cases", "evals/evidence/cases/synthetic-20261107.jsonl")!;
const maxJudgeCalls = Number(flag("max-judge-calls", "1500"));
const maxExtractCalls = Number(flag("max-extract-calls", "120"));
const maxUsd = { A: Number(flag("max-usd-a", "1")), C: Number(flag("max-usd-c", "1")) };
const NODE_BYTES = 512;
const VIEW_BYTES = 8_192;
const BASE_TIME = Date.UTC(2026, 0, 1);

/** Deterministic head summariser: the first bytes of the input, whitespace collapsed, cut on a code point. */
const headSummarizer: Summarize = async (request) => {
  const start = request.instruction.indexOf("<input>\n");
  const end = request.instruction.indexOf("\n</input>", start);
  const input = start < 0 || end < 0 ? "" : request.instruction.slice(start + 8, end);
  let line = "";
  for (const point of input.replace(/\s+/g, " ").trim()) {
    if (Buffer.byteLength(line + point) > 360) break;
    line += point;
  }
  return line || "empty";
};

interface Built {
  readonly memory: Memory;
  readonly store: Store;
  close(): Promise<void>;
}

async function build(c: EvidenceCase): Promise<Built> {
  const root = await mkdtemp(join(tmpdir(), "optchat-evidence-eval-"));
  const store = await Store.open(join(root, "chat"));
  const reports: string[] = [];
  const memory = new Memory(store, headSummarizer, { nodeBytes: NODE_BYTES, viewBytes: VIEW_BYTES, report: (m) => void reports.push(m) });
  const close = async () => {
    await memory.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  };
  for (const [i, m] of c.messages.entries()) {
    const metadata = m.kind === "work" ? { work: { source: "task" as const, completeness: "full" as const, name: "Reporter" } } : undefined;
    memory.append(m.kind, m.text, new Date(BASE_TIME + i * 60_000), metadata);
    if (!(await memory.settle())) {
      await close();
      throw new Error(`${c.id}: tree stalled at ${i}: ${reports.join("; ")}`);
    }
  }
  return { memory, store, close };
}

const evidenceReader = (b: Built): EvidenceMemory => ({
  rank: (text, limit, before) => b.memory.rankMessages(text, { limit, before, idf: "smoothed" }),
  page: (id, offset, maxBytes) => b.store.readMessagePage(id, offset, maxBytes),
});

/** The oracle extractor: the gold answer's code-point span in the state, or a null answer on abstain cases. */
const oracle = (c: EvidenceCase): Extractor => async (state) => {
  const at = c.gold ? state.indexOf(c.gold.answer) : -1;
  const start = at < 0 ? 0 : [...state.slice(0, at)].length;
  const span = at < 0 ? null : ([start, start + [...c.gold!.answer].length] as const);
  return { kind: "answer", value: at < 0 ? null : c.gold!.answer, guess: null, pNull: at < 0 ? 0.99 : 0.01, span, stateText: state, truncated: false, cost: 0, provider: "oracle" };
};

const cases: EvidenceCase[] = (await readFile(casesPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
await mkdir(out, { recursive: true });
const results = join(out, "results.jsonl");
const errors = join(out, "errors.jsonl");
await writeFile(results, "");
await writeFile(errors, "");

let extractor: (c: EvidenceCase) => Extractor = oracle;
let closeAuth = () => {};
if (mode === "live" && arms.includes("C")) {
  const settings = await Settings.init({ cwd: process.cwd() });
  const auth = await discoverAuthStorage(undefined, { settings });
  const registry = new ModelRegistry(auth);
  const live = openRouterExtractor(() => registry.getApiKeyForProvider("openrouter"));
  extractor = () => live;
  closeAuth = () => auth.close();
}
const host = mode === "live" && arms.includes("A") ? await openHostJudge(process.cwd(), "recall") : undefined;
const budget = new JudgeBudget(maxJudgeCalls);
const spend = { A: 0, C: 0 };
let extractCalls = 0;
const servedA = new Map<string, number>();
const probe = { answers: 0, withSpan: 0, echoMatches: 0, spanEqualsValue: 0 };

async function trial(c: EvidenceCase, b: Built, rep: number, arm: Arm): Promise<void> {
  const upperBound = c.messages.length;
  const abstain = c.gold === null;
  const write = (verdict: Verdict, ms: number, costUsd: number | null, detail: object) =>
    appendFile(results, JSON.stringify({ case: c.id, category: c.category, rep, arm, abstain, verdict, ms, costUsd, ...detail }) + "\n");
  const fail = (cls: string, message: string) => appendFile(errors, JSON.stringify({ case: c.id, rep, arm, cls, message }) + "\n");
  const started = performance.now();
  if (arm === "B") {
    const result = await gatherEvidence(evidenceReader(b), c.question, { upperBound });
    const passages = result.passages.map((p) => ({ id: p.id, text: p.text }));
    return write(gradeB(c.gold, passages), performance.now() - started, 0, { passages: result.passages.map((p) => [p.id, p.start, p.end]) });
  }
  if (arm === "C") {
    const result = await gatherEvidence(evidenceReader(b), c.question, { upperBound });
    if (result.passages.length === 0) return write(gradeC(c.gold, false, null), performance.now() - started, 0, { extraction: "no passages" });
    if (mode === "live") {
      if (extractCalls >= maxExtractCalls || spend.C >= maxUsd.C) return fail("budget", "extract budget spent");
      extractCalls++;
    }
    const { state, placed } = extractionState(result.passages);
    const extraction: Extraction = await extractor(c)(state, c.question, AbortSignal.timeout(30_000));
    if (extraction.kind !== "answer") return fail(extraction.kind, extraction.reason);
    if (extraction.cost !== null) spend.C += extraction.cost;
    const shown = extraction.value !== null && extraction.pNull !== null && extraction.pNull < DEFAULTS.extractNull;
    const located = shown ? mapSpan(state, placed, extraction) : null;
    probe.answers++;
    if (extraction.span) {
      probe.withSpan++;
      if (extraction.stateText === state) probe.echoMatches++;
      const mapped = mapSpan(state, placed, extraction);
      if (mapped && extraction.value !== null && mapped.text === extraction.value) probe.spanEqualsValue++;
    }
    return write(gradeC(c.gold, shown, located), performance.now() - started, extraction.cost, {
      value: extraction.value,
      pNull: extraction.pNull,
      span: extraction.span,
      echo: extraction.stateText === state,
      located,
      provider: extraction.provider,
      truncated: extraction.truncated,
    });
  }
  if (!host) return;
  if (spend.A >= maxUsd.A) return fail("budget", "judge spend cap reached");
  const meter = newMeter();
  const outcome = await recall(
    {
      viewLines: () => b.memory.viewLines(true),
      lineAt: (id, n) => b.memory.lineAt(id, n),
      page: (id) => b.memory.zoom(id, 1, 0),
      rank: (text, limit) => b.memory.rankMessages(text, { limit }),
    },
    { judge: metered(host.judge, meter, budget), question: c.question, min: DEFAULTS.recallMin, k: DEFAULTS.recallK, seeds: DEFAULTS.recallSeeds },
  );
  const cost = meter.usage ? meter.usage.cost.total : meter.calls.length === 0 ? 0 : null;
  if (cost !== null) spend.A += cost;
  for (const model of meter.models) servedA.set(model, (servedA.get(model) ?? 0) + 1);
  if (outcome.kind === "failed") return fail(meter.budgetExhausted ? "budget" : "failed", outcome.reason);
  const found = outcome.kind === "found" ? { id: outcome.message.id, full: c.messages[outcome.message.id]!.text } : null;
  return write(gradeA(c.gold, found), performance.now() - started, cost, { found: found?.id ?? null, calls: meter.calls.length, models: [...meter.models] });
}

const jobs: Array<() => Promise<void>> = [];
const built = new Map<string, Built>();
for (const c of cases) built.set(c.id, await build(c));
for (let rep = 0; rep < reps; rep++)
  for (const c of cases) for (const arm of arms) if (!(arm === "A" && mode === "oracle")) jobs.push(() => trial(c, built.get(c.id)!, rep, arm));
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      await job().catch((error: unknown) => appendFile(errors, JSON.stringify({ cls: "exception", message: String(error) }) + "\n"));
    }
  }),
);
for (const b of built.values()) await b.close();
host?.close();
closeAuth();

const rows: Array<Row & { case: string }> = (await readFile(results, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const errorRows = (await readFile(errors, "utf8")).trim().split("\n").filter(Boolean).length;
const scores: Partial<Record<Arm, ArmScores>> = {};
for (const arm of arms) scores[arm] = score(rows.filter((r) => r.arm === arm));
const run = {
  casesPath,
  cases: cases.length,
  reps,
  mode,
  arms,
  errors: errorRows,
  spendUsd: spend,
  judgeCalls: budget.used,
  extractCalls,
  servedA: Object.fromEntries(servedA),
  probe,
  scores,
};
await writeFile(join(out, "run.json"), JSON.stringify(run, null, 2) + "\n");
console.log(JSON.stringify({ errors: errorRows, spendUsd: spend, judgeCalls: budget.used, extractCalls, servedA: run.servedA, probe, scores }, null, 2));
