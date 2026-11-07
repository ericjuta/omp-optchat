#!/usr/bin/env bun
/**
 * Provider-free continuation regression harness; the preregistration is also the frozen corpus.
 *
 *   bun evals/evidence/continuation.ts
 *   bun evals/evidence/continuation.ts --baseline /path/to/pristine/v0.15.2
 *   bun evals/evidence/continuation.ts --baseline /path/to/v0.15.2/src/system1/evidence.ts
 *
 * No auth discovery, live extractor, judge, old grader, or live-chat data is imported. Two repetitions
 * exercise each arm's public gatherEvidence/renderEvidence and renderExtraction on real Memory/Store
 * instances. JSON stdout reports separate availability, retrieval, and authored support labels.
 * Exit 1 means a candidate behavior, pairing, setup, or identity failure; baseline defects are context.
 * Parent must run the private real-chat acceptance separately. See the manifest for gates/instructions.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Memory } from "../../src/memory.ts";
import type * as MemoryApi from "../../src/memory.ts";
import type { Kind, Store } from "../../src/store.ts";
import type * as StoreApi from "../../src/store.ts";
import type { EvidenceMemory, EvidencePassage, EvidenceResult } from "../../src/system1/evidence.ts";
import type * as EvidenceApi from "../../src/system1/evidence.ts";
import type { Extraction } from "../../src/system1/extract.ts";
import type * as ExtractionApi from "../../src/system1/extract.ts";
import type * as SourcePageApi from "../../src/source-page.ts";

type Evidence = Pick<typeof EvidenceApi, "gatherEvidence" | "renderEvidence">;
type Renderer = Pick<typeof ExtractionApi, "extractionState" | "renderExtraction">;
type MemoryModule = typeof MemoryApi;
type StoreModule = typeof StoreApi;
type Expected = "occurrence" | "withhold";
type Change = "none" | "wrong-value" | "echo" | "cross-passage" | "empty-span" | "missing-span" |
  "truncated" | "high-null" | "threshold-null" | "unknown-null" | "negative-null" | "above-one-null" |
  "null-value" | "failed" | "off";
interface Probe {
  id: string;
  source: number;
  quote: string;
  pNull?: number;
  support: "supported" | "wrong-version" | "partial" | "contradicted" | "superseded";
  expect: Expected;
}
interface Case {
  id: string;
  category: string;
  question: string;
  answerable: boolean;
  availableInSnapshot: boolean;
  mustRetrieve: boolean;
  messages: Array<{ kind: Kind; copies?: number; completeness?: "full" | "pointer-only"; parts: Array<{ text: string; repeat?: number }> }>;
  ground: Array<{ id: number; quote: string }>;
  probes: Probe[];
  upperBound?: number;
  timeoutMs?: number;
  expectNoPassages?: boolean;
  expectIncomplete?: boolean;
  forbidden?: number[];
  missing?: string[];
  incomplete?: number[];
}
interface Manifest {
  schema: number;
  id: string;
  budget: { usd: number; providerCalls: number; judgeCalls: number; extractorCalls: number };
  privateAcceptance: string;
  protocol: { repetitions: number; nodeBytes: number; viewBytes: number; maxNull: number; limits: { maxPassages: number; maxBytes: number; timeoutMs: number } };
  cases: Case[];
  rendererMutations: Array<{ id: string; change: Change; expect: Expected }>;
}
interface Message { kind: Kind; text: string; completeness?: "full" | "pointer-only" }
interface Ground { id: number; quote: string; start: number; end: number }
interface Corpus { spec: Case; messages: Message[]; ground: Ground[]; upperBound: number }
interface Arm {
  label: "candidate" | "baseline";
  evidence: Evidence;
  extraction: Renderer;
  Memory: MemoryModule["Memory"];
  Store: StoreModule["Store"];
  sourcePage?: typeof SourcePageApi.readSourcePage;
  provenance: { root: string; version: string; head: string | null; tag: string | null; dirty: boolean | null; identity: string; modules: Record<string, string> };
}
interface Check { name: string; pass: boolean }
interface Rendering {
  id: string;
  mode: "retrieved" | "control";
  support: Probe["support"];
  expected: Expected;
  available: boolean;
  shown: boolean;
  text: string | null;
  checks: Check[];
}
interface Row {
  arm: Arm["label"];
  case: string;
  category: string;
  rep: number;
  availability: { answerable: boolean; inStore: boolean; inSnapshot: boolean; groundQuotes: number };
  retrieval: { availableQuotes: number; retrievedQuotes: number; covered: boolean[]; fullCoverage: boolean; answerSupported: boolean };
  passages: EvidenceResult["passages"];
  trailer: { searched: readonly number[]; missing: readonly string[]; incomplete: readonly number[]; complete: boolean; unsearched: readonly number[] };
  rendering: Rendering[];
  checks: Check[];
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = join(root, "evals/evidence/prereg/continuation-20261107.json");
// Frozen before the first runner invocation. A new corpus needs a new preregistration, not a softer gate.
const MANIFEST_SHA256 = "5c6c1f6333e648b0ae355c85b19e5f45b57e3165efa485fe47358e911aad91ed";
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const requireThat = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const git = (cwd: string, args: string[]): string | null => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return null; }
};

function options(): { candidate: string; baseline?: string } {
  const out: { candidate: string; baseline?: string } = { candidate: root };
  const seen = new Set<string>();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    requireThat((key === "--candidate" || key === "--baseline") && value && !value.startsWith("--") && !seen.has(key!), "Usage: bun evals/evidence/continuation.ts [--candidate checkout-or-module] [--baseline v0.15.2-checkout-or-module]");
    seen.add(key!);
    if (key === "--candidate") out.candidate = value!;
    else out.baseline = value!;
  }
  return out;
}

/** Load an arm's own ranking and paging implementations; never compare two rankings through candidate Memory. */
async function loadArm(label: Arm["label"], path: string): Promise<Arm> {
  const target = await realpath(resolve(path));
  const directory = (await stat(target)).isDirectory();
  const checkout = directory ? target : resolve(dirname(target), "../..");
  const evidencePath = directory ? join(checkout, "src/system1/evidence.ts") : target;
  const paths = { evidence: evidencePath, extraction: join(checkout, "src/system1/extract.ts"), memory: join(checkout, "src/memory.ts"), store: join(checkout, "src/store.ts") };
  const pkg = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as { name: string; version: string };
  requireThat(pkg.name === "@ericjuta/omp-optchat", `${label}: not an omp-optchat checkout`);
  const head = git(checkout, ["rev-parse", "HEAD"]);
  const tag = git(checkout, ["rev-parse", "--verify", "refs/tags/v0.15.2^{commit}"]);
  const status = git(checkout, ["status", "--porcelain", "--untracked-files=no"]);
  const dirty = status === null ? null : status.length > 0;
  if (label === "baseline") {
    requireThat(pkg.version === "0.15.2" && head !== null && dirty === false, "baseline must be a pristine Git checkout with package version 0.15.2");
    requireThat(tag === null || head === tag, "baseline HEAD differs from local v0.15.2 tag");
  }
  const modules: Record<string, string> = {};
  for (const [name, source] of Object.entries(paths)) modules[name] = hash(await readFile(source));
  try { modules.evidenceIndex = hash(await readFile(join(checkout, "src/evidence-index.ts"))); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    modules.evidenceIndex = "absent-in-this-arm";
  }
  let sourcePage: typeof SourcePageApi.readSourcePage | undefined;
  const sourcePagePath = join(checkout, "src/source-page.ts");
  try {
    modules.sourcePage = hash(await readFile(sourcePagePath));
    const source: typeof SourcePageApi = await import(pathToFileURL(sourcePagePath).href);
    requireThat(typeof source.readSourcePage === "function", `${label}: missing bounded source paging API`);
    sourcePage = source.readSourcePage;
  } catch (error) {
    if (label !== "baseline" || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    modules.sourcePage = "absent-in-this-arm";
  }
  const evidence: Evidence = await import(pathToFileURL(paths.evidence).href);
  const extraction: Renderer = await import(pathToFileURL(paths.extraction).href);
  const { Memory }: MemoryModule = await import(pathToFileURL(paths.memory).href);
  const { Store }: StoreModule = await import(pathToFileURL(paths.store).href);
  requireThat([evidence.gatherEvidence, evidence.renderEvidence, extraction.renderExtraction, extraction.extractionState, Memory, Store].every((fn) => typeof fn === "function"), `${label}: missing public API`);
  return { label, evidence, extraction, Memory, Store, sourcePage, provenance: { root: checkout, version: pkg.version, head, tag, dirty, identity: tag && head === tag ? "tag-commit-and-module-hashes" : "package-version-only-and-module-hashes", modules } };
}

/** Only authored source text determines gold offsets; no candidate result or score is consulted. */
function locate(messages: Message[], id: number, quote: string): Ground {
  const text = messages[id]?.text;
  requireThat(text !== undefined && quote.length > 0, `invalid source ${id}`);
  const at = text!.indexOf(quote);
  requireThat(at >= 0 && text!.indexOf(quote, at + 1) === -1, `source ${id}: quote must occur exactly once: ${quote}`);
  const start = Buffer.byteLength(text!.slice(0, at));
  return { id, quote, start, end: start + Buffer.byteLength(quote) };
}

function expand(spec: Case): Corpus {
  const messages: Message[] = [];
  for (const recipe of spec.messages) {
    const copies = recipe.copies ?? 1;
    requireThat(Number.isSafeInteger(copies) && copies >= 1 && copies <= 100, `${spec.id}: invalid copies`);
    const text = recipe.parts.map(({ text, repeat = 1 }) => {
      requireThat(Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= 2000, `${spec.id}: invalid repeat`);
      return text.repeat(repeat);
    }).join("");
    for (let i = 0; i < copies; i++) messages.push({ kind: recipe.kind, text, completeness: recipe.completeness });
  }
  const upperBound = spec.upperBound ?? messages.length;
  requireThat(Number.isSafeInteger(upperBound) && upperBound >= 0 && upperBound <= messages.length, `${spec.id}: invalid snapshot`);
  const ground = spec.ground.map(({ id, quote }) => locate(messages, id, quote));
  for (const probe of spec.probes) locate(messages, probe.source, probe.quote);
  const available = ground.length > 0 && ground.every(({ id }) => id < upperBound);
  requireThat(available === spec.availableInSnapshot, `${spec.id}: authored availability disagrees with source`);
  requireThat(!spec.mustRetrieve || available, `${spec.id}: retrieval gate requires available evidence`);
  return { spec, messages, ground, upperBound };
}

/** Independent, bounded source windows for renderer controls, not credited as retrieval. */
function controls(corpus: Corpus): EvidencePassage[] {
  const ranges = new Map<number, { start: number; end: number }>();
  for (const ref of [...corpus.ground, ...corpus.spec.probes.map((p) => locate(corpus.messages, p.source, p.quote))]) {
    const previous = ranges.get(ref.id);
    ranges.set(ref.id, { start: Math.min(previous?.start ?? ref.start, ref.start), end: Math.max(previous?.end ?? ref.end, ref.end) });
  }
  return [...ranges].map(([id, range]) => {
    const message = corpus.messages[id]!;
    const bytes = Buffer.from(message.text);
    // Pad with complete code points, independent of candidate's paging/index implementation.
    const before = [...bytes.subarray(0, range.start).toString("utf8")].slice(-32).join("");
    const after = [...bytes.subarray(range.end).toString("utf8")].slice(0, 32).join("");
    const start = range.start - Buffer.byteLength(before);
    const end = range.end + Buffer.byteLength(after);
    const text = bytes.subarray(start, end).toString("utf8");
    requireThat(end - start <= 2048, `${corpus.spec.id}: renderer control is not bounded`);
    return { id, kind: message.kind, start, end, totalBytes: bytes.length, text, complete: start === 0 && end === bytes.length };
  });
}

function mutate(base: Extract<Extraction, { kind: "answer" }>, change: Change, state: string, maxNull: number): Extraction {
  switch (change) {
    case "none": return base;
    case "wrong-value": return { ...base, value: "invented-wrong-value", pNull: 1e-9 };
    case "echo": return { ...base, stateText: state + " altered echo" };
    case "cross-passage": {
      // Start in the first body, not the gold body's position: ranking may put gold last.
      const firstBody = state.indexOf("\n") + 1;
      const span = [[...state.slice(0, firstBody)].length, [...state].length] as const;
      return { ...base, span, value: [...state].slice(span[0], span[1]).join("") };
    }
    case "empty-span": return { ...base, span: [base.span![0], base.span![0]], value: "" };
    case "missing-span": return { ...base, span: null };
    case "truncated": return { ...base, truncated: true };
    case "high-null": return { ...base, pNull: 0.99 };
    case "threshold-null": return { ...base, pNull: maxNull };
    case "unknown-null": return { ...base, pNull: null };
    case "negative-null": return { ...base, pNull: -0.01 };
    case "above-one-null": return { ...base, pNull: 1.01 };
    case "null-value": return { ...base, value: null, guess: base.value, pNull: 1e-9 };
    case "failed": return { kind: "failed", reason: "synthetic failure injection" };
    case "off": return { kind: "off", reason: "synthetic disabled injection" };
    default: throw new Error(`Unknown frozen mutation: ${String(change)}`);
  }
}

function renderProbe(arm: Arm, corpus: Corpus, passages: readonly EvidencePassage[], probe: Probe, mode: Rendering["mode"], maxNull: number, change: Change = "none"): Rendering {
  const { state, placed } = arm.extraction.extractionState(passages);
  const source = locate(corpus.messages, probe.source, probe.quote);
  const slot = placed.find(({ passage }) => passage.id === source.id && passage.start <= source.start && passage.end >= source.end && passage.text.includes(probe.quote));
  const available = slot !== undefined && (change !== "cross-passage" || placed.length >= 2);
  const row: Rendering = { id: probe.id, mode, support: probe.support, expected: probe.expect, available, shown: false, text: null, checks: [] };
  if (!slot || !available) {
    if (mode === "control") row.checks.push({ name: "control-span-available", pass: false });
    return row;
  }
  const at = slot.at + [...slot.passage.text.slice(0, slot.passage.text.indexOf(probe.quote))].length;
  const base: Extract<Extraction, { kind: "answer" }> = {
    kind: "answer", value: probe.quote, guess: null, pNull: probe.pNull ?? 0.01,
    span: [at, at + [...probe.quote].length], stateText: state, truncated: false, cost: null, provider: "synthetic-injection-not-live",
  };
  const extraction = mutate(base, change, state, maxNull);
  const text = arm.extraction.renderExtraction(state, placed, extraction, maxNull, corpus.spec.question);
  row.text = text;
  // Recognize legacy naked-value rendering too, so relabeling unsupported values cannot hide a failure.
  const occurrence = /("(?:[^"\\]|\\.)*") at message (\d+) bytes (\d+)-(\d+)/u.exec(text);
  row.shown = occurrence !== null || text.includes("candidate occurrence ");
  const check = (name: string, pass: boolean) => row.checks.push({ name, pass });
  check("nonempty-public-render", text.startsWith("[extraction "));
  check("expected-display", row.shown === (probe.expect === "occurrence"));
  if (row.shown) {
    check("candidate-label", text.includes("candidate occurrence "));
    check("not-verified-warning", text.includes("not a verified answer"));
    check("source-provenance", occurrence !== null && Number(occurrence[2]) === source.id && Number(occurrence[3]) === source.start && Number(occurrence[4]) === source.end);
    check("exact-source-quote", occurrence !== null && JSON.parse(occurrence[1]!) === probe.quote);
    check("reopen-location", text.includes(`zoom(${source.id}, 1, ${source.start})`));
  } else {
    check("explicit-withholding", /withheld|do not settle|off:|failed:/u.test(text));
  }
  return row;
}

async function trial(arm: Arm, corpus: Corpus, manifest: Manifest, rep: number): Promise<Row> {
  const directory = await mkdtemp(join(tmpdir(), "optchat-continuation-"));
  let store: Store | undefined;
  let memory: Memory | undefined;
  try {
    store = await arm.Store.open(join(directory, "chat"));
    for (const [i, message] of corpus.messages.entries()) {
      const metadata = message.kind === "work" ? { work: { source: "task" as const, completeness: message.completeness ?? "full", name: "SyntheticReporter" } } : undefined;
      store.append(message.kind, message.text, new Date(Date.UTC(2026, 0, 1) + i * 60000), metadata);
    }
    const reports: string[] = [];
    memory = new arm.Memory(store, async () => "Synthetic archive summary.", { nodeBytes: manifest.protocol.nodeBytes, viewBytes: manifest.protocol.viewBytes, report: (message) => { reports.push(message); } });
    requireThat(await memory.settle(AbortSignal.timeout(30000)), `${arm.label}/${corpus.spec.id}: synthetic Memory did not settle: ${reports.join("; ")}`);
    const checks: Check[] = [];
    const check = (name: string, pass: boolean) => checks.push({ name, pass });
    const opened: number[] = [];
    const activeStore = store;
    const activeMemory = memory;
    const reader: EvidenceMemory = {
      sourceIdentity: activeMemory,
      page: (id: number, offset: number, maxBytes: number, maxTraversalBytes?: number) => {
        requireThat(id >= 0 && id < corpus.upperBound, `${arm.label}/${corpus.spec.id}: read outside snapshot: ${id}`);
        opened.push(id);
        if (!arm.sourcePage) return activeStore.readMessagePage(id, offset, maxBytes);
        const source = activeStore.messages[id]!;
        return { ...arm.sourcePage(source, offset, maxBytes, maxTraversalBytes), kind: source.kind, metadata: source.metadata };
      },
    };
    const limits = { ...manifest.protocol.limits, upperBound: corpus.upperBound, timeoutMs: corpus.spec.timeoutMs ?? manifest.protocol.limits.timeoutMs, clock: () => 0 };
    // Only the historical baseline receives its removed ranking hook; candidate exercises the new public API.
    const input = arm.label === "baseline" ? {
      ...reader,
      rank: (question: string, limit: number, before: number) => activeMemory.rankMessages(question, { limit, before, idf: "smoothed" }),
    } : reader;
    const result = await arm.evidence.gatherEvidence(input, corpus.spec.question, limits);
    check("passage-budget", result.passages.length <= limits.maxPassages);
    check("byte-budget", result.passages.reduce((sum, passage) => sum + Buffer.byteLength(passage.text), 0) <= limits.maxBytes);
    for (const [i, passage] of result.passages.entries()) {
      const source = corpus.messages[passage.id];
      const bytes = Buffer.from(source?.text ?? "");
      const range = Number.isSafeInteger(passage.start) && Number.isSafeInteger(passage.end) && passage.start >= 0 && passage.end > passage.start && passage.end <= bytes.length;
      check(`passage-${i}-source`, !!source && passage.id < corpus.upperBound && passage.kind === source.kind && passage.totalBytes === bytes.length);
      check(`passage-${i}-bytes`, range && bytes.subarray(passage.start, passage.end).equals(Buffer.from(passage.text)) && Buffer.byteLength(passage.text) <= 2048);
      check(`passage-${i}-whole-flag`, passage.complete === (passage.start === 0 && passage.end === bytes.length));
      check(`passage-${i}-nonoverlap`, !result.passages.slice(0, i).some((other) => other.id === passage.id && other.start < passage.end && passage.start < other.end));
    }
    const allIds = [...result.searched, ...result.unsearched, ...result.incomplete];
    check("trailer-ids-within-snapshot", allIds.every((id) => Number.isSafeInteger(id) && id >= 0 && id < corpus.upperBound));
    check("searched-unique-and-read", new Set(result.searched).size === result.searched.length && result.searched.every((id) => opened.includes(id)));
    check("searched-not-unsearched", !result.searched.some((id) => result.unsearched.includes(id)));
    check("completion-truth", corpus.spec.expectIncomplete ? !result.complete && result.unsearched.length > 0 : result.complete && result.unsearched.length === 0);
    check("partial-report-truth", (corpus.spec.incomplete ?? []).every((id) => result.incomplete.includes(id)) && result.incomplete.every((id) => (corpus.spec.incomplete ?? []).includes(id)));
    check("missing-term-truth", (corpus.spec.missing ?? []).every((term) => result.missing.includes(term)));
    check("snapshot-exclusions", (corpus.spec.forbidden ?? []).every((id) => !opened.includes(id) && !result.passages.some((p) => p.id === id)));
    if (corpus.spec.expectNoPassages) check("expected-empty", result.passages.length === 0);
    const rendered = arm.evidence.renderEvidence(corpus.spec.question, result);
    check("mandatory-trailer", rendered.includes("[searched messages:") && rendered.includes("[question words in no searched message:") && rendered.includes("[incomplete or partial reports among them:"));
    check("rendered-completion", result.complete ? /\[search complete(?:\]| within this snapshot;)/u.test(rendered) : rendered.includes("[search incomplete:"));
    const covered = corpus.ground.map((gold) => result.passages.some((p) => p.id === gold.id && p.start <= gold.start && p.end >= gold.end && p.text.includes(gold.quote)));
    const fullCoverage = covered.length > 0 && covered.every(Boolean);
    if (corpus.spec.mustRetrieve) check("all-authored-support-retrieved", fullCoverage);
    const rendering: Rendering[] = [];
    const sourceControls = controls(corpus);
    for (const probe of corpus.spec.probes) {
      rendering.push(renderProbe(arm, corpus, result.passages, probe, "retrieved", manifest.protocol.maxNull));
      rendering.push(renderProbe(arm, corpus, sourceControls, probe, "control", manifest.protocol.maxNull));
    }
    // The version fixture has multiple passages, a clean positive, and an independent wrong-version negative.
    if (corpus.spec.id === "version-confusion") {
      const positive = corpus.spec.probes[0]!;
      for (const mutation of manifest.rendererMutations) {
        const probe = { ...positive, id: mutation.id, expect: mutation.expect };
        for (const [mode, passages] of [["retrieved", result.passages], ["control", sourceControls]] as const) {
          rendering.push(renderProbe(arm, corpus, passages, probe, mode, manifest.protocol.maxNull, mutation.change));
        }
      }
    }
    return {
      arm: arm.label, case: corpus.spec.id, category: corpus.spec.category, rep,
      availability: { answerable: corpus.spec.answerable, inStore: corpus.ground.length > 0, inSnapshot: corpus.spec.availableInSnapshot, groundQuotes: corpus.ground.length },
      retrieval: { availableQuotes: corpus.ground.filter((g) => g.id < corpus.upperBound).length, retrievedQuotes: covered.filter(Boolean).length, covered, fullCoverage, answerSupported: corpus.spec.answerable && corpus.spec.availableInSnapshot && fullCoverage },
      passages: result.passages, trailer: { searched: result.searched, missing: result.missing, incomplete: result.incomplete, complete: result.complete, unsearched: result.unsearched }, rendering, checks,
    };
  } finally {
    try { await memory?.close(); }
    finally {
      try { await store?.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}

const failed = (row: Row): string[] => [
  ...row.checks.filter((check) => !check.pass).map((check) => check.name),
  ...row.rendering.flatMap((r) => r.checks.filter((check) => !check.pass).map((check) => `${r.mode}/${r.id}/${check.name}`)),
];
const counts = (rows: Row[]) => ({
  trials: rows.length,
  availableInStore: rows.filter((r) => r.availability.inStore).length,
  availableInSnapshot: rows.filter((r) => r.availability.inSnapshot).length,
  availableQuotes: rows.reduce((n, r) => n + r.retrieval.availableQuotes, 0),
  retrievedQuotes: rows.reduce((n, r) => n + r.retrieval.retrievedQuotes, 0),
  fullCoverage: rows.filter((r) => r.retrieval.fullCoverage).length,
  answerSupported: rows.filter((r) => r.retrieval.answerSupported).length,
  injectedProbes: rows.reduce((n, r) => n + r.rendering.length, 0),
  unavailableRetrievedProbes: rows.flatMap((r) => r.rendering).filter((r) => r.mode === "retrieved" && !r.available).length,
  rendererControlPasses: rows.flatMap((r) => r.rendering).filter((r) => r.mode === "control" && r.available && r.checks.every((c) => c.pass)).length,
  unsupportedOccurrencesShown: rows.flatMap((r) => r.rendering).filter((r) => r.support !== "supported" && r.shown).length,
  failedChecks: rows.reduce((n, row) => n + failed(row).length, 0),
  failingTrials: rows.filter((r) => failed(r).length > 0).length,
});

async function main(): Promise<void> {
  const failures: string[] = [];
  const rows: Row[] = [];
  const arms: Arm[] = [];
  let manifestSha256: string | null = null;
  let privateAcceptance: string | null = null;
  let caseCount = 0;
  let networkAttempts = 0;
  const request = globalThis.fetch;
  // Installed before dynamic production imports; even an accidental extractor call cannot spend money.
  globalThis.fetch = Object.assign(async () => { networkAttempts++; throw new Error("Provider/network calls forbidden: continuation budget is $0"); }, { preconnect: request.preconnect }) as typeof fetch;
  try {
    const args = options();
    const raw = await readFile(manifestPath, "utf8");
    manifestSha256 = hash(raw);
    requireThat(manifestSha256 === MANIFEST_SHA256, "frozen manifest digest changed; preregister a new suite instead");
    const manifest = JSON.parse(raw) as Manifest;
    requireThat(manifest.schema === 1 && manifest.id === "continuation-20261107", "unsupported preregistration");
    requireThat(Object.values(manifest.budget).every((value) => value === 0), "nonzero budget refused");
    requireThat(manifest.protocol.repetitions === 2 && manifest.cases.length === 13 && manifest.rendererMutations.length === 15, "frozen corpus shape changed; preregister a new suite instead");
    requireThat(new Set(manifest.cases.map((c) => c.id)).size === manifest.cases.length, "duplicate case IDs");
    privateAcceptance = manifest.privateAcceptance;
    const corpus = manifest.cases.map(expand);
    caseCount = corpus.length;
    arms.push(await loadArm("candidate", args.candidate));
    if (args.baseline) arms.push(await loadArm("baseline", args.baseline));
    for (const arm of arms) {
      for (const entry of corpus) {
        const repetitions: Row[] = [];
        for (let rep = 0; rep < manifest.protocol.repetitions; rep++) {
          const row = await trial(arm, entry, manifest, rep);
          rows.push(row);
          repetitions.push(row);
          if (arm.label === "candidate") failures.push(...failed(row).map((f) => `${row.case}/rep-${rep}/${f}`));
        }
        const stable = (row: Row) => JSON.stringify({ ...row, rep: 0 });
        if (repetitions.some((row) => stable(row) !== stable(repetitions[0]!))) failures.push(`${arm.label}/${entry.spec.id}/nondeterministic-repetitions`);
      }
    }
    const baseline = rows.filter((r) => r.arm === "baseline");
    for (const old of baseline) {
      const candidate = rows.find((r) => r.arm === "candidate" && r.case === old.case && r.rep === old.rep)!;
      if (old.retrieval.covered.some((covered, i) => covered && !candidate.retrieval.covered[i])) failures.push(`${old.case}/rep-${old.rep}/paired-support-regression`);
      const passing = (row: Row) => row.rendering.filter((r) => r.mode === "control" && r.available && r.checks.every((check) => check.pass)).length;
      if (passing(candidate) < passing(old)) failures.push(`${old.case}/rep-${old.rep}/paired-renderer-regression`);
    }
  } catch (error) {
    failures.push(`setup-or-execution: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    globalThis.fetch = request;
  }
  if (networkAttempts > 0) failures.push(`forbidden-network-attempts: ${networkAttempts}`);
  const candidate = counts(rows.filter((r) => r.arm === "candidate"));
  const baselineRows = rows.filter((r) => r.arm === "baseline");
  const baseline = baselineRows.length ? counts(baselineRows) : null;
  const paired = baseline !== null && candidate.trials === baseline.trials && candidate.trials === caseCount * 2;
  const report = {
    schema: 1, id: "continuation-20261107", manifestSha256, runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    status: failures.length ? "fail" : "pass", comparison: paired ? "paired" : "unpaired-no-improvement-claim",
    budgetUsd: 0, spendUsd: 0, providerCalls: 0, judgeCalls: 0, extractorCalls: 0, forbiddenNetworkAttempts: networkAttempts,
    cases: caseCount, repetitions: 2, provenance: Object.fromEntries(arms.map((a) => [a.label, a.provenance])),
    counts: { candidate, baseline },
    pairedDelta: paired ? { retrievedQuotes: candidate.retrievedQuotes - baseline!.retrievedQuotes, fullCoverage: candidate.fullCoverage - baseline!.fullCoverage, answerSupported: candidate.answerSupported - baseline!.answerSupported, rendererControlPasses: candidate.rendererControlPasses - baseline!.rendererControlPasses } : null,
    claimBoundary: "Deterministic synthetic software behavior and injected extractor outcomes only; no live-model quality measurement. Unsupported unverified occurrences are counted, not relabeled as answers.",
    privateAcceptance: { status: "not-checked-by-this-harness", instruction: privateAcceptance },
    failures, rows,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
}

await main();
