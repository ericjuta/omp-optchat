#!/usr/bin/env bun
/**
 * NEW real-store evaluation, independent of the old synthetic runner and graders.
 *
 * bun evals/evidence/real-run.ts --manifest <private-manifest.json> --out <NEW-private-dir> --mode preflight
 * bun evals/evidence/real-run.ts --manifest <private-manifest.json> --out <NEW-private-dir> --mode B
 * bun evals/evidence/real-run.ts --manifest <private-manifest.json> --out <NEW-private-dir> --mode live --approve-manifest-sha256 <exact-SHA>
 *
 * preflight uses a deterministic logical clock for retrieval mechanics ONLY. B is a real,
 * auth-free production-clock evaluation (two repetitions). Live requires exact approval,
 * frozen implementation/labels, privacy clearance AND an exact frozen budgetPolicy.
 * The approved policy admits best-effort local request/allocation limits, not a hard provider
 * spending cap. Receipts distinguish allocations from reported charges; unknown charges stay
 * unknown. No JSON policy, price estimate or approval string proves provider enforcement.
 * Older manifests without budgetPolicy remain valid for offline modes, but cannot admit live calls.
 *
 * Output directories are never resumed/overwritten. Give reviewers only the blind packet
 * files, not results.jsonl, blind-mapping.json or the run directory (they reveal arm identities).
 * Exact production rendering stays in private output files. Reviewer rendering removes only
 * diagnostic model/cost identity, not source text or candidate/withholding semantics; production
 * shape can still reveal an arm. The private mapping binds both file hashes. No scoring occurs here.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../../src/config.ts";
import { gatherEvidence, renderEvidence } from "../../src/system1/evidence.ts";
import { extractionState, mapSpan, renderExtraction, EXTRACT_MODEL, type Extraction } from "../../src/system1/extract.ts";
import { recall, renderRecall, type RecallOutcome } from "../../src/system1/recall.ts";
import { digest, makeBestEffortAuthority, MISSING_BUDGET_PREREQUISITE, SerialBudget, type KnownCost, type RealArm } from "./real-budget.ts";
import { PrivateRun } from "./real-files.ts";
import { loadCorpus } from "./real-input.ts";
import { openPaidRuntime, type JudgeTrace, type PaidRuntime } from "./real-live.ts";
import { PRIVACY_SCREEN, secretFlags } from "./real-privacy.ts";
import { implementationProvenance } from "./real-provenance.ts";
import { loadFrozenSnapshot, type Citation } from "./real-snapshot.ts";

export interface RealRunOptions {
  readonly manifest: string;
  readonly out: string;
  readonly mode: "preflight" | "B" | "live";
  readonly approveManifestSha256?: string;
}
export interface RealRow {
  readonly schemaVersion: 1;
  readonly rowId: string;
  readonly caseId: string;
  readonly category: string;
  readonly split: "calibration" | "heldout";
  readonly repetition: 0 | 1;
  readonly arm: RealArm;
  readonly manifestSha256: string;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly questionSha256: string;
  readonly status: "ok" | "failed" | "blocked";
  readonly elapsedMs: number;
  readonly cost: KnownCost;
  readonly calls: SerialBudget["receipts"];
  readonly outputFile: string;
  readonly outputSha256: string;
  readonly blindPacketId: string;
  readonly blindPacketFile: string;
  readonly blindPacketSha256: string;
  readonly provenance: object;
}
const FREE: KnownCost = { status: "known", usd: 0, basis: "No paid operation attempted" };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repetitions = [0, 1] as const;

/** Strip only the production extraction header's model and its diagnostic cost suffix.
 * Never scrub the whole packet: source passages and candidate quotes may themselves name costs/models.
 */
function reviewerExtraction(rendered: string, extraction: Exclude<Extraction, { kind: "off" }>): string {
  const prefix = `[extraction ${EXTRACT_MODEL}`;
  if (!rendered.startsWith(prefix)) throw new Error("Unknown production extraction rendering");
  const anonymous = `[extraction${rendered.slice(prefix.length)}`;
  if (extraction.kind !== "answer") return anonymous;
  const truncated = extraction.truncated ? ", input truncated" : "";
  const suffix = `, ${extraction.cost === null ? "cost unknown" : `cost $${extraction.cost.toFixed(6)}`}${truncated})]`;
  if (!anonymous.endsWith(suffix)) throw new Error("Unknown production extraction cost suffix");
  return `${anonymous.slice(0, -suffix.length)}${truncated})]`;
}

export async function runRealEvaluation(options: RealRunOptions) {
  const corpus = loadCorpus(options.manifest);
  if (options.mode === "live" && options.approveManifestSha256 !== corpus.manifestSha256) {
    throw new Error("Live invocation requires --approve-manifest-sha256 matching the exact frozen manifest bytes");
  }
  // Only live execution with exact-byte approval can construct a local admission authority.
  const authority = options.mode === "live" && corpus.budgetPolicy !== undefined
    ? makeBestEffortAuthority(corpus.manifestSha256, corpus.budgetPolicy) : undefined;
  const implementation = implementationProvenance(ROOT);
  const snapshots = new Map(corpus.snapshots.map((input) => [input.id, loadFrozenSnapshot(input)]));
  corpus.validateCitations(snapshots);
  const flags = [
    ...[...snapshots.values()].flatMap((snapshot) => snapshot.privacyFlags.map((flag) => ({ snapshotId: snapshot.input.id, ...flag }))),
    ...corpus.cases.flatMap((item) => secretFlags(item.question).map((flag) => ({ caseId: item.id, ...flag }))),
  ];
  const blockers: string[] = [];
  if (!corpus.labelsReviewed) blockers.push("Independent source labels are not frozen as reviewed");
  if (corpus.implementationSha256 !== implementation.sha256) blockers.push("Manifest implementationSha256 is absent or differs from current runner/production sources");
  if ([...snapshots.values()].some((snapshot) => snapshot.viewSource !== "saved-view")) blockers.push("A requires an actual saved view.json; no generated navigation surface is substituted");
  if (flags.length) blockers.push("Credential-format review flags exist in frozen text; no paid source transmission allowed");
  if (corpus.budgetPolicy === undefined) blockers.push(MISSING_BUDGET_PREREQUISITE);
  const run = new PrivateRun(options.out, [corpus.root, ...corpus.snapshots.map((snapshot) => snapshot.root)]);
  const budget = new SerialBudget(corpus.manifestSha256, authority, (event) => run.append("budget", event));
  let runtime: PaidRuntime | undefined;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let rows = 0;
  let failed = 0;
  let state: "complete" | "blocked" | "failed" = "failed";
  const blindPackets: { packetId: string; path: string; sha256: string }[] = [];
  const blindMapping: Pick<RealRow, "rowId" | "caseId" | "repetition" | "arm" | "outputFile" | "outputSha256" |
    "blindPacketId" | "blindPacketFile" | "blindPacketSha256">[] = [];
  try {
    run.save("implementation.json", implementation);
    run.save("inputs.json", corpus.binding);
    run.save("preflight.json", {
      schemaVersion: 1, manifestSha256: corpus.manifestSha256, implementationSha256: implementation.sha256,
      cases: corpus.cases.length, repetitions: 2, sourceCitations: "reopened against original UTF-8 bytes",
      snapshots: [...snapshots.values()].map((snapshot) => ({ id: snapshot.input.id, sha256: snapshot.input.sha256,
        messages: snapshot.messages.length, summaries: snapshot.nodeCount, viewSource: snapshot.viewSource })),
      privacy: { policy: PRIVACY_SCREEN, flags, limitations: "Format screening is not a guarantee that arbitrary secrets or personal data are absent" },
      liveBlockers: blockers,
    });
    if ((options.mode === "live" && blockers.length) || (options.mode === "B" && (!corpus.labelsReviewed || corpus.implementationSha256 !== implementation.sha256))) {
      state = "blocked";
      return { status: state, manifestSha256: corpus.manifestSha256, rows,
        blockers: options.mode === "B" ? ["Freeze independent source labels and current implementation hash before producing actual B evaluation outputs"] : blockers };
    }
    if (options.mode === "live") {
      budget.assertAvailable();
      runtime = await openPaidRuntime(budget, ROOT, ["A", "C"]);
    }
    for (const repetition of repetitions) {
      for (const item of corpus.cases) {
        const snapshot = snapshots.get(item.snapshotId)!;
        const retrievalStarted = performance.now();
        const evidence = await gatherEvidence(snapshot.evidence(), item.question, {
          upperBound: snapshot.messages.length,
          ...(options.mode === "preflight" ? { clock: () => 0 } : {}),
        });
        const retrievalMs = performance.now() - retrievalStarted;
        const citations = evidence.passages.map((passage) => snapshot.citation(passage.id, passage.start, passage.end, passage.text));
        // B and C share this exact retrieval and rendering, including coverage and omission diagnostics.
        const evidenceRendered = renderEvidence(item.question, evidence);
        if (options.mode === "preflight") {
          run.save(`mechanics-${repetition}-${String(corpus.cases.indexOf(item)).padStart(3, "0")}.json`, {
            caseId: item.id, repetition, snapshotId: snapshot.input.id, clock: "constant logical clock; NOT evaluation latency or timeout evidence",
            rendered: evidenceRendered, evidence, citations,
          });
          continue;
        }
        const arms: readonly RealArm[] = options.mode === "B" ? ["B"] : ["A", "B", "C"];
        for (const arm of arms) {
          const receiptStart = budget.receipts.length;
          const rowStart = performance.now();
          let status: RealRow["status"] = "ok";
          let rendered = "";
          let rowCitations: readonly Citation[] = citations;
          let outcome: RecallOutcome | undefined;
          let extraction: Extraction | undefined;
          let extractionRendered: string | undefined;
          const traces: JudgeTrace[] = [];
          let extractorState: string | undefined;
          let mapped: ReturnType<typeof mapSpan> = null;
          let failure: string | undefined;
          try {
            if (arm === "A") {
              if (!runtime) throw new Error("Paid runtime unavailable");
              budget.assertAvailable();
              outcome = await recall(snapshot.recall, {
                judge: runtime.judge({ caseId: item.id, repetition, arm }, traces), question: item.question,
                min: DEFAULTS.recallMin, k: DEFAULTS.recallK, seeds: DEFAULTS.recallSeeds,
              });
              // recall can return on a timeout before its underlying judge settles. No next row until queue drained.
              await budget.drain();
              rendered = renderRecall(outcome);
              rowCitations = outcome.kind === "found"
                ? [snapshot.citation(outcome.message.id, 0, outcome.message.shownBytes, outcome.message.text)] : [];
              if (outcome.kind === "failed" || traces.some((trace) => trace.outcome !== "returned")) status = "failed";
            } else {
              rendered = evidenceRendered;
              // Mirror evidenceText's early return: no passages means no extraction or appended line.
              if (arm === "C" && evidence.passages.length > 0) {
                if (!runtime) throw new Error("Paid runtime unavailable");
                const { state: sent, placed } = extractionState(evidence.passages);
                extractorState = sent;
                extraction = await runtime.extract({ caseId: item.id, repetition, arm }, sent, item.question, AbortSignal.timeout(30_000));
                // Production omits off results; keep the reason privately without presenting a synthetic line.
                if (extraction.kind !== "off") {
                  // Never reproduce the old runner's weaker pNull-only shown check.
                  extractionRendered = renderExtraction(sent, placed, extraction, DEFAULTS.extractNull, item.question);
                  rendered += `\n${extractionRendered}`;
                }
                if (extraction.kind === "answer") mapped = mapSpan(sent, placed, extraction);
                if (extraction.kind === "failed" || extraction.kind === "off") status = "failed";
              }
            }
          } catch {
            status = budget.status.halted || !runtime ? "blocked" : "failed";
            failure = "Arm did not complete; consult private budget receipts and bounded trace metadata";
            rendered = `[evaluation ${status}: no completed arm output]`;
            extractionRendered = undefined;
            rowCitations = [];
          }
          await budget.drain();
          // Production recall may absorb a judge failure; a halted paid operation still blocks this row.
          if (arm !== "B" && budget.status.halted) {
            status = "blocked";
            failure = "Budget halted; consult private budget receipts and bounded trace metadata";
          }
          const elapsedMs = performance.now() - rowStart + (arm === "A" ? 0 : retrievalMs);
          const calls = budget.receipts.slice(receiptStart);
          const cost: KnownCost = calls.length === 0 ? FREE : calls.some((call) => call.cost.status === "unknown")
            ? { status: "unknown", reason: "At least one paid operation has unknown cost; best-effort allocations remain reserved, not reported spend" }
            : { status: "known", usd: calls.reduce((sum, call) => sum + (call.cost.status === "known" ? call.cost.usd : 0), 0), basis: "Sum of reported call costs; not independently reconciled billing" };
          const rowId = randomUUID();
          const output = run.save(`output-${rowId}.json`, {
            schemaVersion: 1, rendered, citations: rowCitations, outcome: outcome ?? null,
            evidence: arm === "A" ? null : evidence, extraction: extraction ?? null, extractorState: extractorState ?? null,
            mappedOccurrence: mapped, judgeTraces: traces, failure: failure ?? null,
          });
          const blindPacketId = randomUUID();
          const reviewerRendered = extractionRendered !== undefined && extraction && extraction.kind !== "off"
            ? `${evidenceRendered}\n${reviewerExtraction(extractionRendered, extraction)}` : rendered;
          const packet = run.save(`blind-${blindPacketId}.json`, {
            schemaVersion: 1, packetId: blindPacketId, question: item.question, rendered: reviewerRendered, citations: rowCitations,
          });
          blindPackets.push({ packetId: blindPacketId, path: packet.path, sha256: packet.sha256 });
          const row: RealRow = {
            schemaVersion: 1, rowId, caseId: item.id, category: item.category, split: item.split, repetition, arm,
            manifestSha256: corpus.manifestSha256, snapshotId: snapshot.input.id, snapshotSha256: snapshot.input.sha256,
            questionSha256: digest(item.question), status, elapsedMs, cost, calls,
            outputFile: output.path, outputSha256: output.sha256, blindPacketId,
            blindPacketFile: packet.path, blindPacketSha256: packet.sha256,
            provenance: { implementationSha256: implementation.sha256, originalStoreId: snapshot.input.originalStoreId,
              clock: "production performance.now", index: "fresh per case/repetition",
              evidenceSharedWithPairedArm: arm !== "A", retrievalMs: arm === "A" ? null : retrievalMs,
              model: arm === "B" ? "none" : arm === "C" ? EXTRACT_MODEL : traces.map((trace) => trace.model),
              provider: extraction?.kind === "answer" ? extraction.provider ?? "unknown" : arm === "B" ? "none" : "unknown",
              primaryJudge: arm === "A" ? runtime?.primaryJudge ?? "unknown" : null, privacyScreen: PRIVACY_SCREEN },
          };
          run.append("results", row);
          blindMapping.push({ rowId, caseId: item.id, repetition, arm,
            outputFile: output.path, outputSha256: output.sha256,
            blindPacketId, blindPacketFile: packet.path, blindPacketSha256: packet.sha256 });
          rows++;
          if (status !== "ok") failed++;
        }
      }
    }
    corpus.revalidate();
    if (implementationProvenance(ROOT).sha256 !== implementation.sha256) throw new Error("Implementation changed during run; comparison invalid");
    run.save("blind-index.json", { schemaVersion: 1, packets: blindPackets.sort((a, b) => a.packetId.localeCompare(b.packetId)) });
    run.save("blind-mapping.json", { schemaVersion: 1, manifestSha256: corpus.manifestSha256,
      implementationSha256: implementation.sha256,
      rows: blindMapping.sort((a, b) => a.blindPacketId.localeCompare(b.blindPacketId)) });
    state = budget.status.halted ? "blocked" : failed ? "failed" : "complete";
  } finally {
    await budget.drain();
    if (budget.status.halted) state = "blocked";
    try { runtime?.close(); }
    finally {
      run.seal({ schemaVersion: 1, status: state, mode: options.mode, startedAt, elapsedMs: performance.now() - start,
        manifestSha256: corpus.manifestSha256, implementationSha256: implementation.sha256,
        rows, failed, repetitions: 2, budget: budget.status, liveBlockers: blockers,
        retryPolicy: "No runner retries; host-internal attempts may be unobserved. Best-effort allocations are not provider-enforced spending caps",
        clock: options.mode === "preflight" ? "deterministic mechanics only" : "production performance.now" });
    }
  }
  // Return only after the final drain so a late halt cannot leave a successful terminal result.
  return { status: state, manifestSha256: corpus.manifestSha256, rows, failed, blockers };
}

function cli(args: string[]): RealRunOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    const value = args[i + 1];
    if (!["--manifest", "--out", "--mode", "--approve-manifest-sha256"].includes(name) || !value || value.startsWith("--") || flags.has(name)) throw new Error("Invalid, repeated or missing command-line option");
    flags.set(name, value);
  }
  const manifest = flags.get("--manifest");
  const out = flags.get("--out");
  const mode = flags.get("--mode");
  if (!manifest || !out || (mode !== "preflight" && mode !== "B" && mode !== "live")) throw new Error("Required: --manifest PATH --out NEW_DIRECTORY --mode preflight|B|live");
  return { manifest, out, mode, approveManifestSha256: flags.get("--approve-manifest-sha256") };
}
if (import.meta.main) {
  try {
    const result = await runRealEvaluation(cli(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (result.status !== "complete") process.exitCode = 2;
  } catch {
    // Parser/provider errors can contain private source text or filesystem names. Never echo them to shared logs.
    console.error("Real evidence evaluation refused or failed. No source text is printed; preserve the private output directory if created.");
    process.exitCode = 1;
  }
}
