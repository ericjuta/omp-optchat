import { dirname, resolve } from "node:path";
import { digest, validateBestEffortPolicy, type BestEffortPolicy } from "./real-budget.ts";
import { childPath, decode, integer, readBytes, record, sha, text, within } from "./real-files.ts";
import type { FrozenFile, FrozenSnapshot, SnapshotInput } from "./real-snapshot.ts";

/** Private wrapper; its exact bytes are what --approve-manifest-sha256 authorizes. */
export interface RealManifest {
  readonly version: 1;
  readonly sources: { readonly path: string; readonly sha256: string };
  readonly cases: { readonly path: string; readonly sha256: string };
  readonly reviews: { readonly path: string; readonly sha256: string } | null;
  readonly implementationSha256: string | null;
  /** Exact best-effort local limits authorized by the manifest bytes; never a provider cap. */
  readonly budgetPolicy?: BestEffortPolicy;
}
export interface RealCase {
  readonly id: string;
  readonly snapshotId: string;
  readonly question: string;
  readonly category: string;
  readonly split: "calibration" | "heldout";
}

export function loadCorpus(manifestPath: string) {
  const root = dirname(resolve(manifestPath));
  const manifestBytes = readBytes(manifestPath, 1_048_576);
  const manifestSha256 = digest(manifestBytes);
  const manifest = record(JSON.parse(decode(manifestBytes)), "real corpus manifest");
  if (manifest.version !== 1 || Object.keys(manifest).some((key) => !["version", "sources", "cases", "reviews", "implementationSha256", "budgetPolicy"].includes(key))) throw new Error("Unsupported real manifest contract");
  // Absence preserves offline manifests. A supplied policy must match the exact frozen contract.
  const budgetPolicy = manifest.budgetPolicy === undefined ? undefined : validateBestEffortPolicy(manifest.budgetPolicy);
  const pinnedFiles: { path: string; sha256: string }[] = [{ path: resolve(manifestPath), sha256: manifestSha256 }];
  const artifact = (value: unknown, label: string) => {
    const ref = record(value, `${label} reference`);
    const path = childPath(root, text(ref.path, `${label} relative path`));
    const hash = sha(ref.sha256, `${label} digest`);
    const bytes = readBytes(path, 32 * 1024 * 1024, hash);
    pinnedFiles.push({ path, sha256: hash });
    return record(JSON.parse(decode(bytes)), label);
  };
  const sources = artifact(manifest.sources, "sources");
  const candidates = artifact(manifest.cases, "cases");
  const reviews = manifest.reviews === null ? undefined : artifact(manifest.reviews, "reviews");
  // Review evidence is private input too: pin it now and recheck it with the corpus at run end.
  const reviewArtifactsPinned = reviews ? ["reviewers", "reconciliations"].map((name) => {
    const refs = reviews[name];
    if (refs === undefined) return false;
    if (!Array.isArray(refs)) throw new Error("Invalid review artifact references");
    for (const ref of refs) artifact(ref, `review ${name} artifact`);
    return refs.length > 0;
  }).every(Boolean) : false;
  if (sources.version !== 1 || !Array.isArray(sources.sources) || sources.sources.length < 1 || sources.sources.length > 8) throw new Error("Invalid source inventory");
  const snapshots: SnapshotInput[] = sources.sources.map((value: unknown) => {
    const source = record(value, "source");
    const id = text(source.id, "source ID");
    const originalStoreId = text(source.originalStoreId, "original snapshot ID");
    const original = resolve(text(source.originalPath, "original snapshot path"));
    const snapshotRoot = childPath(root, text(source.snapshotPath, "copied snapshot path"));
    if (within(original, snapshotRoot) || within(snapshotRoot, original)) throw new Error("Runner requires an independent frozen copy, never an original/live source path");
    if (!Array.isArray(source.files) || !source.files.length || source.files.length > 512) throw new Error("Invalid frozen file inventory");
    const files: FrozenFile[] = source.files.map((value: unknown) => {
      const file = record(value, "frozen file");
      const path = text(file.path, "frozen file path");
      childPath(snapshotRoot, path);
      return { path, bytes: integer(file.bytes, "frozen file bytes", 0, 512 * 1024 * 1024), sha256: sha(file.sha256, "frozen file digest") };
    });
    // RealCorpus contract: SHA-256 of sorted `${file.sha256}  ${file.path}\n` UTF-8 lines.
    const sourceDigest = digest([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map((file) => `${file.sha256}  ${file.path}\n`).join(""));
    if (sourceDigest !== sha(source.sha256, "snapshot digest")) throw new Error("Snapshot aggregate digest differs from its file inventory");
    for (const file of files) pinnedFiles.push({ path: childPath(snapshotRoot, file.path), sha256: file.sha256 });
    return { id, originalStoreId, expectedMessageCount: integer(source.messageCount, "snapshot message count", 1),
      root: snapshotRoot, sha256: sha(source.sha256, "snapshot digest"), files };
  });
  if (new Set(snapshots.map((source) => source.id)).size !== snapshots.length) throw new Error("Duplicate frozen source ID");
  if (snapshots.reduce((sum, source) => sum + source.files.reduce((bytes, file) => bytes + file.bytes, 0), 0) > 512 * 1024 * 1024) throw new Error("Corpus exceeds the 512 MiB admission bound");
  if (candidates.version !== 1 || !Array.isArray(candidates.cases) || candidates.cases.length !== 40) throw new Error("Protocol requires exactly 40 frozen cases");
  const rawCases = candidates.cases.map((value: unknown) => record(value, "case"));
  const cases: RealCase[] = rawCases.map((item) => {
    const id = text(item.id, "case ID");
    const snapshotId = text(item.sourceId, "case source ID");
    const snapshot = snapshots.find((source) => source.id === snapshotId);
    if (!snapshot || item.sourceSnapshotSha256 !== snapshot.sha256) throw new Error("Case is not bound to its frozen source");
    const question = text(item.question, "question");
    if (question.length > 1000 || !question.trim()) throw new Error("Question outside production bounds");
    const category = text(item.category, "category");
    if (item.split !== "calibration" && item.split !== "heldout") throw new Error("Unfrozen case split");
    const answer = record(item.answer, "source answer label");
    if (answer.status !== "supported" && answer.status !== "missing") throw new Error("Unknown source-answer status");
    if (!Array.isArray(item.citations) || (answer.status === "supported" && item.citations.length === 0)) throw new Error("Source support requires citations");
    if (answer.status === "missing" && !item.missingAnswerJustification) throw new Error("Missing-answer label requires explicit source-review justification");
    return { id, snapshotId, question, category, split: item.split };
  });
  if (new Set(cases.map((item) => item.id)).size !== 40) throw new Error("Duplicate case ID");
  const categories = [...new Set(cases.map((item) => item.category))];
  if (categories.length !== 5 || categories.some((category) => {
    const members = cases.filter((item) => item.category === category);
    return members.length !== 8 || members.filter((item) => item.split === "calibration").length !== 2;
  })) throw new Error("Protocol requires five categories of eight, each split two calibration/six heldout");
  const caseIds = cases.map((item) => item.id).sort();
  const reviewedIds = reviews && Array.isArray(reviews.caseIds) && reviews.caseIds.every((id) => typeof id === "string") ? [...reviews.caseIds].sort() : [];
  const labelsReviewed = reviews?.version === 1 && reviews.status === "approved" && reviewArtifactsPinned &&
    reviews.casesSha256 === record(manifest.cases, "cases reference").sha256 &&
    reviews.sourcesSha256 === record(manifest.sources, "sources reference").sha256 &&
    JSON.stringify(reviewedIds) === JSON.stringify(caseIds) && rawCases.every((item) => item.reviewStatus === "approved");
  const implementationSha256 = manifest.implementationSha256 === null ? null : sha(manifest.implementationSha256, "implementation digest");
  return {
    root, manifestSha256, implementationSha256, budgetPolicy, snapshots, cases, labelsReviewed,
    binding: { manifestSha256, manifest, budgetPolicy: budgetPolicy ?? null,
      sourceIdentities: snapshots.map(({ id, originalStoreId, sha256 }) => ({ id, originalStoreId, sha256 })),
      files: pinnedFiles.map((file) => ({ ...file })) },
    revalidate() { for (const file of pinnedFiles) readBytes(file.path, 512 * 1024 * 1024, file.sha256); },
    validateCitations(loaded: ReadonlyMap<string, FrozenSnapshot>) {
      const originalFiles = new Map<string, Buffer>();
      const validateCitation = (value: unknown): void => {
        const row = record(value, "source citation");
        const sourceId = text(row.sourceId, "citation source");
        const snapshot = loaded.get(sourceId);
        if (!snapshot) throw new Error("Citation references an unfrozen source");
        const id = integer(row.messageId, "citation message ID", 0, snapshot.messages.length - 1);
        const original = snapshot.messages[id]!;
        const start = integer(row.byteStart, "citation byteStart");
        const end = integer(row.byteEnd, "citation byteEnd", start);
        snapshot.citation(id, start, end, text(row.quote, "citation quote"));
        if (text(row.kind, "citation kind") !== original.kind || sha(row.messageTextSha256, "cited message hash") !== digest(original.text)) throw new Error("Citation message metadata/hash differs");
        text(row.role, "citation role");
        const fileName = text(row.file, "citation file");
        const line = integer(row.line, "citation line", 1);
        const file = snapshot.input.files.find((file) => file.path === fileName);
        if (!file || !file.path.startsWith("main/")) throw new Error("Citation file is not an original message log");
        const path = childPath(snapshot.input.root, file.path);
        let bytes = originalFiles.get(path);
        if (!bytes) { bytes = readBytes(path, 512 * 1024 * 1024, file.sha256); originalFiles.set(path, bytes); }
        const recordStart = integer(row.recordByteStart, "record start", 0, bytes.length);
        const recordEnd = integer(row.recordByteEnd, "record end", recordStart, bytes.length);
        const newline = bytes.indexOf(10, recordStart);
        if ((recordStart > 0 && bytes[recordStart - 1] !== 10) || (recordEnd !== newline && recordEnd !== newline + 1)) throw new Error("Citation record range is not a complete original log line");
        let actualLine = 1;
        for (let offset = 0; offset < recordStart; offset++) if (bytes[offset] === 10) actualLine++;
        if (line !== actualLine) throw new Error("Citation line differs from its original record location");
        const stored = record(JSON.parse(decode(bytes.subarray(recordStart, recordEnd))), "cited original record");
        if (stored.i !== id || stored.kind !== original.kind || stored.text !== original.text) throw new Error("Citation record location does not reopen original message");
      };
      // A citation is declared by its container, not by whichever mandatory fields survived parsing.
      // Walk nested wrong-candidate collections too; an empty object or missing quote must fail closed.
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== "object") return;
        for (const [name, child] of Object.entries(record(value, "citation container"))) {
          if (name === "citations") {
            if (!Array.isArray(child)) throw new Error("Invalid source citation collection");
            child.forEach(validateCitation);
          } else if (name === "citation") validateCitation(child);
          visit(child);
        }
      };
      rawCases.forEach(visit);
    },
  };
}
