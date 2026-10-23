#!/usr/bin/env bun
/**
 * Rules-triage eval runner. For each case's user message it runs the production triage path, in the order the rules
 * gate runs it (src/index.ts `triage`): ruleSentences, triageState, triageQuestions, judgeWithin, decideTriage at the
 * configured threshold. The judge is OMP's `judge` role, through the recall eval's wrapper (evals/recall/judge.ts).
 * grade.ts scores each decision. Writes, under --out:
 *
 *   results.jsonl   one line per (case, rep) with a scorable decision; `grade.score` is 0 or 1
 *   errors.jsonl    attempts with no scorable decision: judge error, timeout, budget, induced; never a zero row
 *   traces/         transcripts for TRAIN cases only (test cases never write a trace)
 *   run.json        settings, budget, and metrics for the all, train and test sets
 *
 *   bun evals/rules/run.ts --variant baseline --out <dir> [--reps 2] [--concurrency 4]
 *     [--max-judge-calls 400] [--max-cost-usd 3] [--rule-add 0.8] [--only id,id] [--cases <file.jsonl>]...
 *     [--mode live|oracle|null] [--induce-error <case id>]
 *
 * Modes: `live` calls the judge role. `oracle` answers from the gold labels, so it must score ~100%. `null` gives the
 * judge nothing to answer, so the gate decides `none` on every case. A null scores the non-rule share, not zero:
 * a message that is not a rule passes by making no change. Read precision, recall and F1 next to `score`.
 *
 * Costs: every live call's cost comes from the host's usage. A call with no usage records `unknown`, never zero.
 * The cost ceiling is checked before each attempt, so concurrent attempts can overshoot it by a few calls.
 */
import type { Answer } from "@oh-my-pi/pi-ai";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULTS } from "../../src/config.ts";
import type { Rule } from "../../src/system1/ledger.ts";
import { judgeWithin } from "../../src/system1/judge.ts";
import {
  decideTriage,
  offeredRules,
  ruleSentences,
  type TriageAnswers,
  type TriageDecision,
  triageQuestions,
  triageState,
} from "../../src/system1/rules.ts";
import { type HostJudge, JudgeBudget, type Meter, metered, newMeter, openHostJudge } from "../recall/judge.ts";
import { CASES_DIR, type RuleCase } from "./build-cases.ts";
import { grade, type Row, summarize, type Summary } from "./grade.ts";

type Mode = "live" | "oracle" | "null";

interface Options {
  variant: string;
  out: string;
  reps: number;
  concurrency: number;
  maxJudgeCalls: number;
  maxCostUsd: number;
  ruleAdd: number;
  only?: ReadonlySet<string>;
  cases: string[];
  mode: Mode;
  induce?: string;
  /** A ratchet flow's `_state.json`: when given, its `train_ids` (not the case file's split) decide which cases get traces. */
  state?: string;
}

interface Attempt {
  readonly decision?: TriageDecision;
  readonly answers?: TriageAnswers;
  readonly sentences: readonly string[];
  readonly cls?: string;
  readonly message?: string;
  readonly meter: Meter;
  readonly latency: number;
}

interface Context {
  readonly options: Options;
  readonly judge?: HostJudge;
  readonly budget: JudgeBudget;
  /** Cost of every live call so far, in USD. Shared across concurrent trials. */
  readonly spend: { usd: number };
  readonly results: string;
  readonly errors: string;
  readonly traces: string;
  /** Train ids from `--state`; undefined means the case file's split decides. */
  readonly trainIds?: ReadonlySet<string>;
}

/** The `train_ids` of a ratchet flow's `_state.json`. */
async function loadTrainIds(file: string): Promise<ReadonlySet<string>> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  const ids = parsed !== null && typeof parsed === "object" && "train_ids" in parsed ? parsed.train_ids : undefined;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Error(`${file} has no train_ids string array`);
  return new Set(ids);
}

/** The production bound on one rules triage judgment (src/index.ts TRIAGE_MS). */
const TRIAGE_MS = 20_000;
const MAX_RETRIES = 2;
const BACKOFF_MS = 250;
/** Failure classes worth a retry. Budget and cost ceilings are not transient. */
const RETRYABLE: Record<string, true> = { judge_error: true, timeout: true, induced: true };
const ERROR_CHARS = 300;

function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, ERROR_CHARS);
}

function parse(argv: readonly string[]): Options {
  const opts: Options = {
    variant: "",
    out: "",
    reps: 2,
    concurrency: 4,
    maxJudgeCalls: 400,
    maxCostUsd: 3,
    ruleAdd: DEFAULTS.ruleAdd,
    cases: [],
    mode: "live",
  };
  const cases: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--variant") opts.variant = value;
    else if (flag === "--out") opts.out = value;
    else if (flag === "--reps") opts.reps = Number(value);
    else if (flag === "--concurrency") opts.concurrency = Number(value);
    else if (flag === "--max-judge-calls") opts.maxJudgeCalls = Number(value);
    else if (flag === "--max-cost-usd") opts.maxCostUsd = Number(value);
    else if (flag === "--rule-add") opts.ruleAdd = Number(value);
    else if (flag === "--only") opts.only = new Set(value.split(",").filter((id) => id.length > 0));
    else if (flag === "--cases") cases.push(value);
    else if (flag === "--mode" && (value === "live" || value === "oracle" || value === "null")) opts.mode = value;
    else if (flag === "--induce-error") opts.induce = value;
    else if (flag === "--state") opts.state = value;
    else throw new Error(`unknown or invalid argument ${flag}`);
  }
  if (!/^(baseline|v[1-9][0-9]*)$/.test(opts.variant)) throw new Error('--variant must be "baseline" or v<N>');
  if (opts.out.length === 0) throw new Error("--out is required");
  for (const [flag, n] of [["--reps", opts.reps], ["--concurrency", opts.concurrency], ["--max-judge-calls", opts.maxJudgeCalls]] as const) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  }
  if (!(opts.maxCostUsd > 0)) throw new Error("--max-cost-usd must be positive");
  if (!(opts.ruleAdd > 0 && opts.ruleAdd <= 1)) throw new Error("--rule-add must be in (0, 1]");
  opts.cases = cases.length > 0 ? cases : [join(CASES_DIR, "synthetic.jsonl"), join(CASES_DIR, "real.jsonl")];
  return opts;
}

async function loadCases(options: Options): Promise<RuleCase[]> {
  const rows: RuleCase[] = [];
  for (const file of options.cases) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (line.trim().length > 0) rows.push(JSON.parse(line) as RuleCase);
    }
  }
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error("duplicate case ids across the case files");
  return options.only ? rows.filter((row) => options.only!.has(row.id)) : rows;
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

/** The rules the decision may replace, as the gate offers them: the newest 32 of the ledger's active rules. */
function offeredOf(c: RuleCase): Rule[] {
  return offeredRules(c.rules.map((rule) => ({ id: rule.id, text: rule.text, source: 0, at: 0 })));
}

/** The oracle answers the gold label: a rule at 0.95, a non-rule at 0.05, a named replacement at 0.9. */
export function oracleAnswers(c: RuleCase, sentences: readonly string[]): TriageAnswers {
  const answers: Record<string, Answer> = {
    rule: { type: "noul", noul: c.gold.rule ? 0.95 : 0.05 },
    withdraw: { type: "noul", noul: 0 },
  };
  if (c.rules.length > 0) {
    const target = c.gold.supersedes ?? "none";
    answers.supersedes = { type: "choice", choice: target, probabilities: { [target]: 0.9 }, confidence: 1 };
  }
  if (sentences.length > 1) {
    for (let k = 0; k < sentences.length; k++) {
      const kept = c.gold.rule && (c.gold.keep === undefined || c.gold.keep.includes(k));
      answers[`s${k}`] = { type: "noul", noul: kept ? 0.95 : 0.05 };
    }
  }
  return answers;
}

async function attempt(c: RuleCase, ctx: Context, induced: boolean): Promise<Attempt> {
  const meter = newMeter();
  const started = performance.now();
  const latency = () => (performance.now() - started) / 1000;
  const sentences = ruleSentences(c.message);
  if (ctx.budget.used >= ctx.budget.limit) return { sentences, cls: "budget", message: "judge-call budget spent", meter, latency: latency() };
  if (ctx.spend.usd >= ctx.options.maxCostUsd) return { sentences, cls: "budget", message: "cost ceiling reached", meter, latency: latency() };
  const offered = offeredOf(c);
  const judge = metered(ctx.judge!.judge, meter, ctx.budget, induced);
  try {
    const result = await judgeWithin(judge, { state: triageState(c.message, sentences), questions: triageQuestions(offered, sentences) }, TRIAGE_MS);
    const decision = decideTriage("human", result.answers, offered, ctx.options.ruleAdd, c.message, sentences);
    return { sentences, decision, answers: result.answers, meter, latency: latency() };
  } catch (error) {
    const text = errorText(error);
    const cls = induced
      ? "induced"
      : meter.budgetExhausted
        ? "budget"
        : /exceeded \d+ ms/.test(text)
          ? "timeout"
          : "judge_error";
    return { sentences, cls, message: text, meter, latency: latency() };
  } finally {
    ctx.spend.usd += meter.usage?.cost.total ?? 0;
  }
}

/** The per-call cost for one trial: a number from the host's usage, `unknown` when a call lacks it, 0 when no call ran. */
function costOf(meter: Meter): number | "unknown" {
  if (meter.calls.length === 0) return 0;
  return meter.usage === undefined ? "unknown" : meter.usage.cost.total;
}

async function writeTrace(c: RuleCase, rep: number, ctx: Context, meter: Meter, decision?: TriageDecision, cls?: string): Promise<void> {
  if (!(ctx.trainIds?.has(c.id) ?? c.split === "train")) return;
  const transcript: Array<{ role: string; content: string; name?: string }> = [{ role: "user", content: c.message }];
  for (const call of meter.calls) {
    transcript.push({ role: "tool_call", name: "judge", content: JSON.stringify({ state: call.state, questions: call.questions }) });
    transcript.push({
      role: "tool_result",
      name: "judge",
      content: call.error !== undefined ? `error: ${call.error}` : JSON.stringify(call.answers),
    });
  }
  const outcome = decision === undefined
    ? `error: ${cls ?? "unknown"}`
    : decision.kind === "none"
      ? "decision: none"
      : `decision: ${decision.kind}${decision.kind === "replace" ? ` ${decision.replaces}` : ""}`;
  transcript.push({ role: "assistant", content: outcome });
  await mkdir(ctx.traces, { recursive: true });
  await writeFile(join(ctx.traces, `${c.id}_rep${rep}.json`), JSON.stringify(transcript, null, 2));
}

async function writeError(c: RuleCase, rep: number, ctx: Context, result: Attempt, retries: number): Promise<void> {
  const row = {
    prompt_id: c.id,
    rep,
    tags: c.tags,
    split: c.split,
    status: "error",
    class: result.cls,
    error: result.message?.slice(0, ERROR_CHARS),
    retries,
    judge_calls: result.meter.calls.length,
    latency_s: result.latency,
  };
  await appendFile(ctx.errors, `${JSON.stringify(row)}\n`);
  await writeTrace(c, rep, ctx, result.meter, undefined, result.cls);
}

async function writeResult(c: RuleCase, rep: number, ctx: Context, result: Attempt, retries: number): Promise<void> {
  const decision = result.decision!;
  const verdict = grade(decision, c.gold, result.sentences);
  const meter = result.meter;
  const models = [...meter.models].filter((model) => model.length > 0);
  const cost = costOf(meter);
  const row: Record<string, unknown> = {
    prompt_id: c.id,
    rep,
    tags: c.tags,
    split: c.split,
    label: c.gold.rule ? "rule" : "none",
    grade: { score: verdict.pass ? 1 : 0 },
    explanation: verdict.explanation,
    status: "ok",
    decision: decision.kind,
    latency_s: result.latency,
    judge_calls: meter.calls.length,
    judge_bytes: meter.bytes,
    internal_judge_errors: meter.errors,
    retries,
    tp: verdict.tp,
    fp: verdict.fp,
    fn: verdict.fn,
    tn: verdict.tn,
    cost_usd: cost,
  };
  if (verdict.replaceCorrect !== undefined) row.replace_correct = verdict.replaceCorrect;
  if (models.length > 0) row.model = models[0];
  if (meter.usage) row.usage = meter.usage;
  await appendFile(ctx.results, `${JSON.stringify(row)}\n`);
  await writeTrace(c, rep, ctx, meter, decision);
}

async function runTrial(c: RuleCase, rep: number, ctx: Context): Promise<"result" | "error"> {
  if (ctx.options.mode !== "live") {
    const sentences = ruleSentences(c.message);
    const answers = ctx.options.mode === "oracle" ? oracleAnswers(c, sentences) : {};
    const decision = decideTriage("human", answers, offeredOf(c), ctx.options.ruleAdd, c.message, sentences);
    await writeResult(c, rep, ctx, { decision, answers, sentences, meter: newMeter(), latency: 0 }, 0);
    return "result";
  }
  let retries = 0;
  for (;;) {
    const result = await attempt(c, ctx, ctx.options.induce === c.id);
    if (result.cls === undefined && result.decision !== undefined && [...result.meter.models].every((model) => model.length === 0)) {
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
    if (result.cls !== undefined || result.decision === undefined) {
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

/** One line of results.jsonl, as writeResult wrote it. */
interface StoredRow {
  readonly split: string;
  readonly grade: { readonly score: number };
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly replace_correct?: boolean;
  readonly cost_usd: number | "unknown";
}

async function storedRows(results: string): Promise<StoredRow[]> {
  const lines = (await readFile(results, "utf8").catch(() => "")).split("\n");
  return lines.filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as StoredRow);
}

/** Metrics for the all, train and test sets, computed from the rows on disk so a resumed run reports every row. */
async function metricsOf(rows: readonly StoredRow[]): Promise<Record<"all" | "train" | "test", Summary>> {
  const graded: Array<Row & { split: string }> = rows.map((row) => ({
    split: row.split,
    pass: row.grade.score === 1,
    tp: row.tp,
    fp: row.fp,
    fn: row.fn,
    tn: row.tn,
    replaceCorrect: row.replace_correct,
  }));
  return {
    all: summarize(graded),
    train: summarize(graded.filter((row) => row.split === "train")),
    test: summarize(graded.filter((row) => row.split === "test")),
  };
}

/** Total cost of the rows on disk: known costs summed, unknown costs counted separately, never added as zero. */
function costOfRows(rows: readonly StoredRow[]): { usd: number; unknown: number } {
  let usd = 0;
  let unknown = 0;
  for (const row of rows) {
    if (row.cost_usd === "unknown") unknown++;
    else usd += row.cost_usd;
  }
  return { usd, unknown };
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parse(argv);
  const out = resolve(options.out);
  const cases = await loadCases(options);
  await mkdir(out, { recursive: true });
  const results = join(out, "results.jsonl");
  const errors = join(out, "errors.jsonl");
  const recorded = await recordedSlots(results);
  // Errors from an earlier run are stale for every slot that is about to run again: rewrite the file from scratch.
  await writeFile(errors, "");
  await appendFile(results, "");
  await rm(join(out, "traces"), { recursive: true, force: true });

  const budget = new JudgeBudget(options.maxJudgeCalls);
  const judge = options.mode === "live" ? await openHostJudge(process.cwd(), "rules-eval") : undefined;
  const trainIds = options.state === undefined ? undefined : await loadTrainIds(options.state);
  const ctx: Context = { options, judge, budget, spend: { usd: 0 }, results, errors, traces: join(out, "traces"), trainIds };
  const started = new Date().toISOString();
  const trials: Array<{ c: RuleCase; rep: number }> = [];
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
  }
  const rows = await storedRows(results);
  const metrics = await metricsOf(rows);
  const cost = costOfRows(rows);
  const summary = {
    variant: options.variant,
    mode: options.mode,
    rule_add: options.ruleAdd,
    cases: cases.length,
    reps: options.reps,
    planned: trials.length,
    skipped_recorded: cases.length * options.reps - trials.length,
    results: counts.result,
    errors: counts.error,
    judge_calls: budget.used,
    max_judge_calls: options.maxJudgeCalls,
    cost_usd: cost.usd,
    cost_unknown_rows: cost.unknown,
    max_cost_usd: options.maxCostUsd,
    metrics,
    started,
    finished: new Date().toISOString(),
  };
  await writeFile(join(out, "run.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const t = metrics.test;
  console.log(
    `${options.variant} (${options.mode}): results ${counts.result}, errors ${counts.error}, judge calls ${budget.used}/${options.maxJudgeCalls}, ` +
      `cost $${cost.usd.toFixed(6)}${cost.unknown > 0 ? ` + ${cost.unknown} unknown` : ""} (cap $${options.maxCostUsd}); ` +
      `test score ${t.score.toFixed(3)} P ${t.precision.toFixed(3)} R ${t.recall.toFixed(3)} F1 ${t.f1.toFixed(3)} -> ${out}`,
  );
}

if (import.meta.main) await main(process.argv.slice(2));
