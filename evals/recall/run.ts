#!/usr/bin/env bun
/**
 * chat_recall eval runner. Calls the production `recall()` (src/system1/recall.ts) over each case's store, judged by
 * OMP's `judge` role, and grades the outcome with grade.ts. Writes, under --out:
 *
 *   results.jsonl   one line per (case, rep) that produced a scorable outcome
 *   errors.jsonl    attempts that produced none: judge/transport error, timeout, budget, unbuilt store, induced
 *   traces/         transcripts for TRAIN ids only (needs --state with train_ids; test traces are never written)
 *   run.json        the run's settings and totals
 *
 *   bun evals/recall/run.ts --variant baseline --out <dir> [--state <flow>/_state.json]
 *     [--reps 2] [--concurrency 4] [--max-judge-calls 3000] [--k 1..8] [--only id,id] [--cases <file.jsonl>]...
 *     [--mode live|oracle|null] [--induce-error <case id>]
 *
 * Real cases copy their snapshot into a fresh temp dir for every attempt (read-only originals). Synthetic cases share one
 * seeded tree per store config; recall only reads a Memory, so the shared tree is unchanged between trials.
 */
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS } from "../../src/config.ts";
import { Memory, type Summarize } from "../../src/memory.ts";
import { Store } from "../../src/store.ts";
import { RECALL_K_MAX, recall, renderRecall, type RecallMemory, type RecallOutcome } from "../../src/system1/recall.ts";
import { buildTree, type SyntheticTree } from "../../scripts/retrieval/synthetic.ts";
import { CASES_DIR, type CaseRecord, SNAPSHOT_ROOT } from "./build-cases.ts";
import { grade } from "./grade.ts";
import { type HostJudge, JudgeBudget, type Meter, metered, newMeter, openHostJudge } from "./judge.ts";

/** `coverage` is a diagnostic (no judge): is each gold message under a view line, and does that line keep the fact? */
type Mode = "live" | "oracle" | "null" | "coverage";

interface Options {
  variant: string;
  out: string;
  state?: string;
  reps: number;
  concurrency: number;
  maxJudgeCalls: number;
  /** View lines each recall descends from, 1 to RECALL_K_MAX. */
  k: number;
  only?: ReadonlySet<string>;
  cases: string[];
  mode: Mode;
  induce?: string;
}

/** One attempt ends in an outcome (scorable) or a failure class (error row). */
interface Attempt {
  readonly outcome?: RecallOutcome;
  readonly cls?: string;
  readonly message?: string;
  readonly meter: Meter;
  readonly latency: number;
}

interface Context {
  readonly options: Options;
  readonly judge?: HostJudge;
  readonly budget: JudgeBudget;
  readonly trainIds: ReadonlySet<string>;
  readonly trees: Map<string, Promise<SyntheticTree>>;
  readonly results: string;
  readonly errors: string;
  readonly traces: string;
  readonly coverage: string;
}

/** Wall ceiling for one recall attempt; recall's own bound (RECALL_MS) is shorter and normally fires first. */
const CEILING_MS = 60_000;
/** The production gate threshold, so the eval measures the shipped default. */
const RECALL_MIN = DEFAULTS.recallMin;
const MAX_RETRIES = 2;
const BACKOFF_MS = 250;
/** Failure classes worth a retry. Budget, unbuilt store and missing judge calls are not transient. */
const RETRYABLE: Record<string, true> = { judge_error: true, timeout: true, induced: true };
const ERROR_CHARS = 300;

function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, ERROR_CHARS);
}

function parse(argv: readonly string[]): Options {
  const opts: Options = { variant: "", out: "", reps: 2, concurrency: 4, maxJudgeCalls: 1000, k: 1, cases: [], mode: "live" };
  const cases: string[] = [];
  let flagK: number | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--variant") opts.variant = value;
    else if (flag === "--out") opts.out = value;
    else if (flag === "--state") opts.state = value;
    else if (flag === "--reps") opts.reps = Number(value);
    else if (flag === "--concurrency") opts.concurrency = Number(value);
    else if (flag === "--max-judge-calls") opts.maxJudgeCalls = Number(value);
    else if (flag === "--only") opts.only = new Set(value.split(",").filter((id) => id.length > 0));
    else if (flag === "--cases") cases.push(value);
    else if (flag === "--mode" && (value === "live" || value === "oracle" || value === "null" || value === "coverage")) opts.mode = value;
    else if (flag === "--k") flagK = Number(value);
    else if (flag === "--induce-error") opts.induce = value;
    else throw new Error(`unknown or invalid argument ${flag}`);
  }
  // A topk-k<N> variant names its k; --k may repeat it but never disagree. Other variants default to the single descent.
  const variantK = /^topk-k([1-8])$/.exec(opts.variant);
  if (!variantK && !/^(baseline|v[1-9][0-9]*)$/.test(opts.variant)) {
    throw new Error('--variant must be "baseline", v<N> or topk-k<1..8>');
  }
  if (variantK && flagK !== undefined && flagK !== Number(variantK[1])) throw new Error("--k disagrees with the k in --variant");
  opts.k = variantK ? Number(variantK[1]) : (flagK ?? 1);
  if (!Number.isSafeInteger(opts.k) || opts.k < 1 || opts.k > RECALL_K_MAX) {
    throw new Error(`--k must be an integer from 1 to ${RECALL_K_MAX}`);
  }
  if (opts.out.length === 0) throw new Error("--out is required");
  for (const [flag, n] of [["--reps", opts.reps], ["--concurrency", opts.concurrency], ["--max-judge-calls", opts.maxJudgeCalls]] as const) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  }
  opts.cases = cases.length > 0 ? cases : [join(CASES_DIR, "synthetic.jsonl"), join(CASES_DIR, "real.jsonl")];
  return opts;
}

async function loadCases(options: Options): Promise<CaseRecord[]> {
  const rows: CaseRecord[] = [];
  for (const file of options.cases) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (line.trim().length > 0) rows.push(JSON.parse(line) as CaseRecord);
    }
  }
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error("duplicate case ids across the case files");
  return options.only ? rows.filter((row) => options.only!.has(row.id)) : rows;
}

async function loadTrainIds(state: string | undefined): Promise<ReadonlySet<string>> {
  if (state === undefined) return new Set();
  const parsed = JSON.parse(await readFile(state, "utf8")) as { train_ids?: string[] };
  return new Set(parsed.train_ids ?? []);
}

/** Result slots already recorded: a (case, rep) with a result row is never re-run. Errored slots are re-run. */
async function recordedSlots(file: string): Promise<Set<string>> {
  const slots = new Set<string>();
  const text = await readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { prompt_id: string; rep: number };
    slots.add(`${row.prompt_id}#${row.rep}`);
  }
  return slots;
}

interface Handle {
  readonly memory: Memory;
  close(): Promise<void>;
}

/** Fails closed unless every file of the named snapshots matches MANIFEST.sha256 (written when they were copied). */
async function verifySnapshots(names: ReadonlySet<string>): Promise<void> {
  const expected = new Map<string, string>();
  for (const line of (await readFile(join(SNAPSHOT_ROOT, "MANIFEST.sha256"), "utf8")).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
    if (match && names.has(match[2]!.split("/")[0]!)) expected.set(match[2]!, match[1]!);
  }
  for (const name of names) {
    for (const rel of await readdir(join(SNAPSHOT_ROOT, name), { recursive: true })) {
      const full = join(SNAPSHOT_ROOT, name, rel);
      if (!(await stat(full)).isFile()) continue;
      const key = `${name}/${rel}`;
      const want = expected.get(key);
      if (want === undefined) throw new Error(`snapshot file ${key} is not in MANIFEST.sha256`);
      if (createHash("sha256").update(await readFile(full)).digest("hex") !== want) {
        throw new Error(`snapshot file ${key} changed since the manifest was written`);
      }
      expected.delete(key);
    }
    const missing = [...expected.keys()].filter((key) => key.startsWith(`${name}/`));
    if (missing.length > 0) throw new Error(`snapshot ${name} is missing ${missing.length} manifest files`);
  }
}

/** The production bridge to Memory, as index.ts builds it for the chat_recall tool. */
function recallView(memory: Memory): RecallMemory {
  return {
    viewLines: () => memory.viewLines(true),
    lineAt: (id, n) => memory.lineAt(id, n),
    page: (id) => memory.zoom(id, 1, 0),
  };
}

/** A real snapshot copied into a temp dir. The compressor is unavailable: a store that needs building is an error. */
async function openSnapshot(name: string): Promise<Handle> {
  const dir = await mkdtemp(join(tmpdir(), "optchat-recall-eval-"));
  let store: Store | undefined;
  try {
    await cp(join(SNAPSHOT_ROOT, name), join(dir, "store"), { recursive: true });
    store = await Store.open(join(dir, "store"));
    const reports: string[] = [];
    const unavailable: Summarize = async () => {
      throw new Error("compressor unavailable in the recall eval: the snapshot is not fully built");
    };
    const memory = new Memory(store, unavailable, { tries: 1, report: (message) => reports.push(message) });
    const built = await memory.settle();
    if (!built || reports.length > 0 || memory.status().pending > 0) {
      throw new StoreUnbuiltError(`snapshot ${name} is not fully built (${reports.join("; ") || "pending nodes"})`);
    }
    const close = async (): Promise<void> => {
      try {
        await memory.close();
        await store!.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
    return { memory, close };
  } catch (error) {
    await store?.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

class StoreUnbuiltError extends Error {
  override name = "StoreUnbuiltError";
}

function treeFor(trees: Map<string, Promise<SyntheticTree>>, c: CaseRecord): Promise<SyntheticTree> {
  const store = c.store as { seed: number; n: number; facts: number };
  const key = `${store.seed}:${store.n}:${store.facts}`;
  if (!trees.has(key)) trees.set(key, buildTree({ seed: store.seed, n: store.n, facts: store.facts }));
  return trees.get(key)!;
}

async function openStore(c: CaseRecord, trees: Map<string, Promise<SyntheticTree>>): Promise<Handle> {
  if (c.store.kind === "synthetic") {
    const tree = await treeFor(trees, c);
    if (!tree.corpus.facts.some((fact) => fact.index === c.gold)) throw new Error(`${c.id}: gold is not a planted fact`);
    return { memory: tree.memory, close: async () => {} };
  }
  const handle = await openSnapshot(String(c.store.name));
  if (handle.memory.store.messages.length <= c.gold) {
    await handle.close();
    throw new Error(`${c.id}: gold ${c.gold} is past the end of ${String(c.store.name)}`);
  }
  return handle;
}

/** Failure class of one recall outcome, or undefined when it is scorable. */
function classify(outcome: RecallOutcome, meter: Meter, induced: boolean): string | undefined {
  if (meter.budgetExhausted) return "budget";
  if (outcome.kind === "failed") {
    if (/bound passed/.test(outcome.reason)) return "timeout";
    if (/cancel/.test(outcome.reason)) return "cancelled";
    return induced ? "induced" : "judge_error";
  }
  if (meter.errors > 0) return induced ? "induced" : "judge_error";
  if (meter.calls.length === 0) return "no_judge_call";
  return undefined;
}

async function attempt(c: CaseRecord, ctx: Context, induced: boolean): Promise<Attempt> {
  const meter = newMeter();
  const started = performance.now();
  const latency = () => (performance.now() - started) / 1000;
  if (ctx.budget.used >= ctx.budget.limit) return { cls: "budget", message: "judge-call budget spent", meter, latency: latency() };
  let handle: Handle;
  try {
    handle = await openStore(c, ctx.trees);
  } catch (error) {
    const cls = error instanceof StoreUnbuiltError ? "store_unbuilt" : "store";
    return { cls, message: errorText(error), meter, latency: latency() };
  }
  try {
    const judge = metered(ctx.judge!.judge, meter, ctx.budget, induced);
    const ceiling = new AbortController();
    let ceilingFired = false;
    const timer = setTimeout(() => {
      ceilingFired = true;
      ceiling.abort();
    }, CEILING_MS);
    let outcome: RecallOutcome;
    try {
      outcome = await recall(recallView(handle.memory), {
        judge,
        question: c.question,
        min: RECALL_MIN,
        k: ctx.options.k,
        signal: ceiling.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const cls = ceilingFired ? "timeout" : classify(outcome, meter, induced);
    const message = outcome.kind === "failed" ? outcome.reason : undefined;
    return { outcome, cls, message, meter, latency: latency() };
  } catch (error) {
    return { cls: induced ? "induced" : "judge_error", message: errorText(error), meter, latency: latency() };
  } finally {
    await handle.close();
  }
}

/** Oracle and null references exercise the grader without a model: the oracle answers gold, the null answers nothing. */
function referenceOutcome(c: CaseRecord, mode: Mode): RecallOutcome {
  if (mode === "oracle") {
    return { kind: "found", question: c.question, path: [], others: [], message: { id: c.gold, text: "", shownBytes: 0, totalBytes: 0 } };
  }
  return { kind: "none", min: RECALL_MIN };
}

async function writeTrace(c: CaseRecord, rep: number, ctx: Context, meter: Meter, outcome?: RecallOutcome, cls?: string): Promise<void> {
  if (!ctx.trainIds.has(c.id)) return;
  const transcript: Array<{ role: string; content: string; name?: string }> = [
    { role: "user", content: c.question },
  ];
  for (const call of meter.calls) {
    transcript.push({ role: "tool_call", name: "judge", content: JSON.stringify({ state: call.state, questions: call.questions }) });
    transcript.push({
      role: "tool_result",
      name: "judge",
      content: call.error !== undefined ? `error: ${call.error}` : JSON.stringify(call.answers),
    });
  }
  transcript.push({ role: "assistant", content: outcome ? renderRecall(outcome) : `error: ${cls ?? "unknown"}` });
  await mkdir(ctx.traces, { recursive: true });
  await writeFile(join(ctx.traces, `${c.id}_rep${rep}.json`), JSON.stringify(transcript, null, 2));
}

async function writeError(c: CaseRecord, rep: number, ctx: Context, attemptResult: Attempt, retries: number): Promise<void> {
  const row = {
    prompt_id: c.id,
    rep,
    tags: c.tags,
    status: "error",
    class: attemptResult.cls,
    error: attemptResult.message?.slice(0, ERROR_CHARS),
    retries,
    judge_calls: attemptResult.meter.calls.length,
    latency_s: attemptResult.latency,
  };
  await appendFile(ctx.errors, `${JSON.stringify(row)}\n`);
  await writeTrace(c, rep, ctx, attemptResult.meter, undefined, attemptResult.cls);
}

async function writeResult(c: CaseRecord, rep: number, ctx: Context, attemptResult: Attempt, retries: number): Promise<void> {
  const outcome = attemptResult.outcome!;
  const meter = attemptResult.meter;
  let verdict;
  try {
    verdict = grade(outcome, c.gold);
  } catch (error) {
    await writeError(c, rep, ctx, { ...attemptResult, cls: "grader_crash", message: errorText(error) }, retries);
    return;
  }
  // Strict scoring: a pass that needed a retry counts as a fail.
  const pass = verdict.pass && retries === 0;
  const explanation =
    verdict.pass && retries > 0 ? `pass-on-retry scored as fail (strict; ${retries} retries)` : verdict.explanation;
  const models = [...meter.models].filter((model) => model.length > 0);
  const row: Record<string, unknown> = {
    prompt_id: c.id,
    rep,
    prompt: c.question,
    tags: c.tags,
    grade: pass,
    explanation,
    status: "ok",
    latency_s: attemptResult.latency,
    judge_calls: meter.calls.length,
    judge_bytes: meter.bytes,
    retries,
    store: c.store.kind,
    found: verdict.found,
    depth: verdict.depth,
  };
  if (models.length > 0) row.model = models[0];
  if (meter.usage) row.usage = meter.usage;
  if (meter.usage && meter.usage.cost.total > 0) row.cost_usd = meter.usage.cost.total;
  await appendFile(ctx.results, `${JSON.stringify(row)}\n`);
  await writeTrace(c, rep, ctx, meter, outcome);
}

/** The fact a case plants: the audit field for real cases, the planted topic for synthetic ones. */
async function factOf(c: CaseRecord, trees: Map<string, Promise<SyntheticTree>>): Promise<string | undefined> {
  if (c.store.kind !== "synthetic") return c.fact;
  const tree = await treeFor(trees, c);
  return tree.corpus.facts.find((fact) => fact.index === c.gold)?.topic;
}

async function coverageRow(c: CaseRecord, ctx: Context): Promise<void> {
  const handle = await openStore(c, ctx.trees);
  try {
    const covering = handle.memory.viewLines(true).find((line) => line.id <= c.gold && c.gold < line.id + line.n);
    const fact = await factOf(c, ctx.trees);
    // Descent ends at the gold's leaf: its built summary (or verbatim text, when it fits a node) is what the judge sees last.
    const leaf = handle.memory.lineAt(c.gold, 1);
    const needle = fact?.toLowerCase();
    const row = {
      prompt_id: c.id,
      covered: covering !== undefined,
      covering: covering ? { id: covering.id, n: covering.n } : null,
      leaf_built: leaf !== undefined,
      fact,
      fact_in_covering: needle && covering ? covering.text.toLowerCase().includes(needle) : null,
      fact_in_leaf: needle && leaf ? leaf.text.toLowerCase().includes(needle) : null,
    };
    await appendFile(ctx.coverage, `${JSON.stringify(row)}\n`);
  } finally {
    await handle.close();
  }
}

async function runTrial(c: CaseRecord, rep: number, ctx: Context): Promise<"result" | "error"> {
  if (ctx.options.mode === "coverage") {
    await coverageRow(c, ctx);
    return "result";
  }
  if (ctx.options.mode !== "live") {
    const meter = newMeter();
    await writeResult(c, rep, ctx, { outcome: referenceOutcome(c, ctx.options.mode), meter, latency: 0 }, 0);
    return "result";
  }
  let retries = 0;
  for (;;) {
    const result = await attempt(c, ctx, ctx.options.induce === c.id);
    if (result.cls === undefined && result.outcome !== undefined && [...result.meter.models].every((model) => model.length === 0)) {
      await writeError(c, rep, ctx, { ...result, cls: "served_model_missing", message: "no judge response named a model" }, retries);
      return "error";
    }
    if (result.cls !== undefined && RETRYABLE[result.cls] === true && retries < MAX_RETRIES) {
      retries++;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, BACKOFF_MS * 2 ** (retries - 1) + Math.random() * BACKOFF_MS);
      await promise;
      continue;
    }
    if (result.cls !== undefined || result.outcome === undefined) {
      await writeError(c, rep, ctx, result, retries);
      return "error";
    }
    await writeResult(c, rep, ctx, result, retries);
    return "result";
  }
}

async function pool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parse(argv);
  const out = resolve(options.out);
  const cases = await loadCases(options);
  const trainIds = await loadTrainIds(options.state);
  if (options.mode === "live" || options.mode === "coverage") {
    await verifySnapshots(new Set(cases.filter((c) => c.store.kind === "snapshot").map((c) => String(c.store.name))));
  }
  await mkdir(out, { recursive: true });
  const results = join(out, "results.jsonl");
  const errors = join(out, "errors.jsonl");
  const recorded = await recordedSlots(results);
  // Errors from an earlier run are stale for every slot that is about to run again: rewrite the file from scratch.
  await writeFile(errors, "");
  await appendFile(results, "");
  await appendFile(join(out, "coverage.jsonl"), "");

  const budget = new JudgeBudget(options.maxJudgeCalls);
  const judge = options.mode === "live" ? await openHostJudge(process.cwd(), "recall-eval") : undefined;
  const ctx: Context = {
    options,
    judge,
    budget,
    trainIds,
    trees: new Map(),
    results,
    errors,
    traces: join(out, "traces"),
    coverage: join(out, "coverage.jsonl"),
  };
  const started = new Date().toISOString();
  const trials: Array<{ c: CaseRecord; rep: number }> = [];
  for (const c of cases) {
    for (let rep = 0; rep < options.reps; rep++) {
      if (!recorded.has(`${c.id}#${rep}`)) trials.push({ c, rep });
    }
  }
  const counts = { result: 0, error: 0 };
  try {
    await pool(trials, options.concurrency, async ({ c, rep }) => {
      counts[await runTrial(c, rep, ctx)]++;
    });
  } finally {
    judge?.close();
    for (const pending of ctx.trees.values()) await pending.then((tree) => tree.close(), () => undefined);
  }
  const summary = {
    variant: options.variant,
    k: options.k,
    mode: options.mode,
    cases: cases.length,
    reps: options.reps,
    planned: trials.length,
    skipped_recorded: cases.length * options.reps - trials.length,
    results: counts.result,
    errors: counts.error,
    judge_calls: budget.used,
    max_judge_calls: options.maxJudgeCalls,
    started,
    finished: new Date().toISOString(),
    train_traces_enabled: options.state !== undefined,
  };
  await writeFile(join(out, "run.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`${options.variant}: results ${counts.result}, errors ${counts.error}, judge calls ${budget.used}/${options.maxJudgeCalls} -> ${out}`);
}

if (import.meta.main) await main(process.argv.slice(2));
