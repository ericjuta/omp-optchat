import { lstat, readFile } from "node:fs/promises";
import type { WorkCompleteness, WorkMetadata, WorkSource } from "./archive.js";
import { isRecord } from "./type-guards.js";

export type { WorkCompleteness, WorkMetadata, WorkSource } from "./archive.js";

/** Largest artifact read whole. The SDK refuses the same size for full materialization. */
export const MAX_ARTIFACT_READ_BYTES = 8 * 1024 * 1024;

const MAX_IDENTIFIER_BYTES = 256;
const SOURCES: Record<WorkSource, true> = { task: true, "async-result": true, "launch-completion": true };
const NUMERIC_ARTIFACT_ID = /^\d+$/;
/** The nested task preview tag: the only marker that makes hydrated text unusable as a full report. */
const NESTED_TASK_PREVIEW = '<preview full-output="agent://';
/**
 * The host renders job output inline when it fits (12,000 characters in OMP 18.9.0) and otherwise
 * always appends one of these notices. A task's nested preview is marked by its opening tag; the host
 * sends that form beneath the async cutoff with no notice. Job output can forge them, which only downgrades the
 * report to incomplete; an elided body cannot omit them.
 */
const HOST_PREVIEW_MARKERS = ["[Output truncated. Showing first", "\nFull output: artifact://", NESTED_TASK_PREVIEW] as const;
const DAEMON_STATES: Record<string, true> = {
  starting: true, running: true, ready: true, restarting: true, stopping: true, exited: true, failed: true,
};
const STRUCTURED_FIELDS = ["source", "mode", "status", "data", "error"] as const;
const DAEMON_FIELDS = [
  "name", "id", "state", "pid", "createdAt", "startedAt", "readyAt", "exitedAt", "exitCode", "exitReason",
  "restartCount", "outputBytes", "owner", "readyMatch", "readyPending", "persist", "detached",
] as const;

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The admitted, numeric-only artifact lookup exposed as `ctx.sessionManager`. */
export interface ArtifactPathSource {
  getArtifactPath(id: string): Promise<string | null>;
}

export interface WorkReportInput {
  readonly source: WorkSource;
  /** Message details exactly as delivered. Only the admitted fields are read. */
  readonly details: unknown;
  /** Delivered public text, the envelope the model saw. Retained verbatim. */
  readonly text: string;
  /** Source message timestamp in finite UTC milliseconds, applied to every report. */
  readonly timestamp: number;
  readonly sessionManager?: ArtifactPathSource;
}

/** Delivered facts about one batch member. Absent fields were not delivered. */
export interface ReportProvenance {
  readonly type?: string;
  readonly status?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

export interface CapturedWorkReport {
  readonly work: WorkMetadata;
  readonly provenance: ReportProvenance;
  readonly timestamp: number;
  /** The exact delivered text of the whole message, shared by every member of a batch. */
  readonly envelope: string;
  /** The envelope, then this member's full structured data and public output. */
  readonly body: string;
  readonly reason?: string;
}

export interface WorkReportCapture {
  readonly completeness: WorkCompleteness;
  readonly reason?: string;
  /** One report per batch member, in delivered order. Never collapsed. */
  readonly reports: readonly CapturedWorkReport[];
}

/** Typed `OutputMeta` may recover a preview through an admitted numeric artifact reference only. */
type Hydration = { readonly meta: unknown; readonly absent: string };

interface Member {
  readonly work: { readonly id?: string; readonly name?: string; readonly agentId?: string };
  readonly provenance: ReportProvenance;
  /** Serialized structured data, present whenever the host delivered it. */
  readonly structured?: string;
  /** Public output text, present whenever the host delivered it. */
  readonly output?: string;
  readonly complete: boolean;
  readonly reason?: string;
  /** Consulted only when the member is not already complete. */
  readonly hydrate?: Hydration;
}

type Structured =
  | { readonly outcome: "none"; readonly json?: string | undefined }
  | { readonly outcome: "complete"; readonly json: string }
  | { readonly outcome: "incomplete"; readonly reason: string; readonly json?: string | undefined };

type Reference = { readonly id: string } | { readonly reason: string };

type Resolved = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

const EMPTY_PROVENANCE: ReportProvenance = Object.freeze({});

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return encoder.encode(value).byteLength <= MAX_IDENTIFIER_BYTES ? value : undefined;
}

function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function project(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

function workIds(fields: { id?: unknown; name?: unknown; agentId?: unknown }): Member["work"] {
  const out: { id?: string; name?: string; agentId?: string } = {};
  const id = identifier(fields.id);
  const name = identifier(fields.name);
  const agentId = identifier(fields.agentId);
  if (id !== undefined) out.id = id;
  if (name !== undefined) out.name = name;
  if (agentId !== undefined) out.agentId = agentId;
  return out;
}

function provenance(fields: { type?: unknown; status?: unknown; exitCode?: unknown; durationMs?: unknown }): ReportProvenance {
  const out: { type?: string; status?: string; exitCode?: number; durationMs?: number } = {};
  const type = identifier(fields.type);
  const status = identifier(fields.status);
  const exitCode = typeof fields.exitCode === "number" && Number.isFinite(fields.exitCode) ? fields.exitCode : undefined;
  const durationMs = typeof fields.durationMs === "number" && Number.isFinite(fields.durationMs) ? fields.durationMs : undefined;
  if (type !== undefined) out.type = type;
  if (status !== undefined) out.status = status;
  if (exitCode !== undefined) out.exitCode = exitCode;
  if (durationMs !== undefined) out.durationMs = durationMs;
  return Object.freeze(out);
}

/**
 * Structured data is complete only when the host validated it. Invalid, unrecognized,
 * or unserializable payloads are retained as evidence but never claimed as full.
 */
function structuredOf(value: unknown): Structured {
  if (value === undefined || value === null) return { outcome: "none" };
  if (!isRecord(value)) return { outcome: "incomplete", reason: "structured output is malformed" };
  const json = serialize(project(value, STRUCTURED_FIELDS));
  if (value.status === "unavailable") return { outcome: "none", json };
  if (value.status === "invalid") return { outcome: "incomplete", reason: "structured output failed validation", json };
  if (value.status !== "valid") return { outcome: "incomplete", reason: "structured output status is unrecognized", json };
  if (value.data === undefined) return { outcome: "incomplete", reason: "validated structured output carries no data", json };
  if (json === undefined) return { outcome: "incomplete", reason: "structured data is not serializable" };
  return { outcome: "complete", json };
}

function unitMember(reason: string, hydrate?: Hydration): Member {
  return hydrate === undefined
    ? { work: {}, provenance: EMPTY_PROVENANCE, complete: false, reason }
    : { work: {}, provenance: EMPTY_PROVENANCE, complete: false, hydrate };
}

/**
 * A task result's public text is its finalized `output`, which the executor builds from assistant
 * text blocks only. Only the admitted fields are read; native thinking and other keys are never copied.
 */
function taskMember(result: unknown): Member {
  if (!isRecord(result)) return unitMember("task result is malformed");
  const structured = structuredOf(result.structuredOutput);
  const output = typeof result.output === "string" ? result.output : undefined;
  const base = {
    work: workIds({ name: result.agent, agentId: result.id }),
    provenance: provenance({ exitCode: result.exitCode, durationMs: result.durationMs }),
    structured: structured.json,
    output,
  };
  if (structured.outcome === "complete") return { ...base, complete: true };
  if (structured.outcome === "incomplete") return { ...base, complete: false, reason: structured.reason };
  if (result.aborted === true) return { ...base, complete: false, reason: "run was aborted; output is partial" };
  if (result.exitCode !== 0) return { ...base, complete: false, reason: "task did not exit successfully" };
  if (typeof result.error === "string") return { ...base, complete: false, reason: "task reported an error" };
  if (output === undefined) return { ...base, complete: false, reason: "no public output was delivered" };
  if (result.truncated === true) {
    return {
      ...base,
      complete: false,
      hydrate: { meta: result.meta, absent: "task output was truncated and no artifact reference was delivered" },
    };
  }
  return { ...base, complete: true };
}

function hasElision(meta: unknown): boolean {
  if (!isRecord(meta)) return false;
  const limits = meta.limits;
  return meta.artifactError !== undefined || isRecord(meta.truncation) || (isRecord(limits) && isRecord(limits.columnTruncated));
}

function asyncJobMember(job: unknown, meta: unknown, previewed: boolean): Member {
  if (!isRecord(job)) return unitMember("async job is malformed");
  const base = {
    work: workIds({ id: job.jobId, agentId: job.agentId, name: job.label }),
    provenance: provenance({ type: job.type, status: job.status, durationMs: job.durationMs }),
  };
  if (job.status === "running") return { ...base, complete: false, reason: "job is still running" };
  if (job.status === "cancelled") return { ...base, complete: false, reason: "job was cancelled; output may be partial" };
  const structured = structuredOf(job.schema);
  if (structured.outcome === "complete") return { ...base, structured: structured.json, complete: true };
  if (structured.outcome === "incomplete") {
    return { ...base, structured: structured.json, complete: false, reason: structured.reason };
  }
  // Delivered inline and never elided: the envelope already carries the whole output.
  if (!previewed && !hasElision(meta)) return { ...base, structured: structured.json, complete: true };
  // Agent ids are reusable: their output files may belong to a previous run, not this delivered job.
  // Only typed numeric artifact metadata can hydrate this preview; body URIs are never followed.
  const absent = "the host delivered a preview; the full output is referenced only in text";
  const hydrate: Hydration = { meta, absent };
  return { ...base, structured: structured.json, complete: false, hydrate };
}

function daemonMember(snapshot: unknown): Member {
  if (!isRecord(snapshot)) return unitMember("daemon snapshot is malformed");
  const state = typeof snapshot.state === "string" && Object.hasOwn(DAEMON_STATES, snapshot.state) ? snapshot.state : undefined;
  const json = serialize(project(snapshot, DAEMON_FIELDS));
  const base = {
    work: workIds({ id: snapshot.id, name: snapshot.name }),
    provenance: provenance({ status: state, exitCode: snapshot.exitCode }),
    structured: json,
  };
  if (state === undefined) return { ...base, complete: false, reason: "daemon state is unrecognized" };
  if (json === undefined) return { ...base, complete: false, reason: "daemon snapshot is not serializable" };
  return { ...base, complete: true };
}

function membersOf(source: WorkSource, details: unknown, text: string): readonly Member[] {
  const record = isRecord(details) ? details : {};
  if (source === "task") {
    const results: unknown[] = Array.isArray(record.results) ? record.results : [];
    if (results.length === 0) return [unitMember("task result carried no per-agent details")];
    const running = isRecord(record.async) && record.async.state === "running";
    return results.map((result) => {
      const member = taskMember(result);
      return running && member.complete ? { ...member, complete: false, reason: "task is still running" } : member;
    });
  }
  if (source === "async-result") {
    const jobs: unknown[] = Array.isArray(record.jobs) ? record.jobs : [];
    const aggregate = record.meta;
    const hydrate: Hydration = { meta: aggregate, absent: "delivered text only; the host did not supply job details" };
    if (jobs.length === 0) return [unitMember(hydrate.absent, hydrate)];
    // A preview notice cannot be attributed to one member of a batch, so it downgrades every member.
    const previewed = HOST_PREVIEW_MARKERS.some((marker) => text.includes(marker));
    // Aggregate metadata describes the whole rendered message, so it only applies to a single job.
    return jobs.map((job) => {
      const jobMeta = isRecord(job) && job.meta !== undefined ? job.meta : jobs.length === 1 ? aggregate : undefined;
      return asyncJobMember(job, jobMeta, previewed);
    });
  }
  const daemons: unknown[] = Array.isArray(record.daemons) ? record.daemons : [];
  if (daemons.length === 0) return [unitMember("launch completion carried no daemon snapshot")];
  return daemons.map(daemonMember);
}

/**
 * Derives the artifact to read from typed metadata only. Missing or unsafe references stay pointer-only.
 */
function artifactReference(meta: unknown, absent: string): Reference {
  if (!isRecord(meta)) return { reason: absent };
  const limits = meta.limits;
  const records = [meta.truncation, isRecord(limits) ? limits.columnTruncated : undefined].filter(isRecord);
  if (meta.artifactError !== undefined || records.some((record) => record.artifactError !== undefined)) {
    return { reason: "artifact capture did not finish; the saved output is incomplete" };
  }
  if (records.length === 0) return { reason: absent };
  const ids = new Set<string>();
  for (const record of records) {
    if (typeof record.artifactId !== "string" || record.artifactId.length === 0) {
      return { reason: "output was truncated without an artifact reference" };
    }
    ids.add(record.artifactId);
  }
  const [only] = ids;
  if (ids.size !== 1 || only === undefined) return { reason: "output references conflicting artifacts" };
  if (records.some((record) => typeof record.artifactElidedBytes === "number" && record.artifactElidedBytes > 0)) {
    return { reason: "artifact holds a head and tail sample, not the full output" };
  }
  return { id: only };
}

const failed = (reason: string): Resolved => ({ ok: false, reason });

/**
 * Reads the full artifact through the admitted lookup only. Public reasons never include paths.
 */
async function resolveArtifact(meta: unknown, absent: string, reader: ArtifactPathSource | undefined): Promise<Resolved> {
  const reference = artifactReference(meta, absent);
  if (!("id" in reference)) return failed(reference.reason);
  if (!NUMERIC_ARTIFACT_ID.test(reference.id)) return failed("artifact reference is not admitted");
  if (reader === undefined) return failed("no artifact source is available");
  let path: string | null;
  try {
    path = await reader.getArtifactPath(reference.id);
  } catch {
    return failed("artifact lookup failed");
  }
  if (typeof path !== "string") return failed("artifact is unavailable");
  return readRegularArtifact(path);
}

/** Reads one file only when it is a regular, bounded, strictly UTF-8 file: a symlink never qualifies. */
async function readRegularArtifact(path: string): Promise<Resolved> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return failed("artifact is not a regular file");
    if (info.size > MAX_ARTIFACT_READ_BYTES) return failed("artifact exceeds the read limit");
    const text = strictUtf8.decode(await readFile(path));
    // A numeric artifact can itself contain a nested preview. Do not traverse its URIs or replace the delivered preview.
    if (text.includes(NESTED_TASK_PREVIEW)) {
      return failed("artifact contains a nested preview, not the full output");
    }
    return { ok: true, text };
  } catch {
    return failed("artifact is unreadable or not UTF-8");
  }
}

async function finish(
  member: Member,
  source: WorkSource,
  timestamp: number,
  envelope: string,
  reader: ArtifactPathSource | undefined,
): Promise<CapturedWorkReport> {
  let complete = member.complete;
  let reason = member.reason;
  let output = member.output;
  if (member.hydrate !== undefined) {
    const hydrate = member.hydrate;
    const resolved = await resolveArtifact(hydrate.meta, hydrate.absent, reader);
    if (resolved.ok) {
      complete = true;
      reason = undefined;
      output = resolved.text;
    } else {
      reason = resolved.reason;
    }
  }
  if (!complete && reason === undefined) reason = "output is incomplete";
  const parts = [envelope, member.structured, output];
  const body = parts.filter((part): part is string => part !== undefined && part.length > 0).join("\n\n");
  const work: { source: WorkSource; completeness: WorkCompleteness; id?: string; name?: string; agentId?: string } = {
    source,
    completeness: complete ? "full" : "pointer-only",
    ...member.work,
  };
  return Object.freeze({
    work: Object.freeze(work),
    provenance: member.provenance,
    timestamp,
    envelope,
    body,
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * Captures every member of a delivered work message as its own report, including each member's
 * full structured data and public output. Each member is complete only when its own evidence is
 * complete. The aggregate is complete only when every member is. Artifacts are read solely through
 * `sessionManager.getArtifactPath` for numeric typed references. Body URIs are never followed.
 */
export async function captureWorkReports(input: WorkReportInput): Promise<WorkReportCapture> {
  if (!Object.hasOwn(SOURCES, input.source)) throw new TypeError("Unsupported work source");
  if (!Number.isFinite(input.timestamp)) throw new TypeError("Work timestamp must be finite milliseconds");
  const envelope = typeof input.text === "string" ? input.text : "";
  const reports: CapturedWorkReport[] = [];
  for (const member of membersOf(input.source, input.details, envelope)) {
    reports.push(await finish(member, input.source, input.timestamp, envelope, input.sessionManager));
  }
  const pointer = reports.find((report) => report.work.completeness !== "full");
  const capture: WorkReportCapture = {
    completeness: pointer === undefined ? "full" : "pointer-only",
    ...(pointer?.reason === undefined ? {} : { reason: pointer.reason }),
    reports,
  };
  return Object.freeze(capture);
}
