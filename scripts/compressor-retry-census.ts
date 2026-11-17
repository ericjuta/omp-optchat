/** Read-only census of the v0.16.6 compressor metric schema. See docs/compressor-retry-census.md. */
import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { METRICS_FILE, type CompressorUsage } from "../src/metrics.ts";

const causes = ["head", "length", "marker", "user"] as const satisfies readonly NonNullable<CompressorUsage["retry"]>[];
const nodes = ["leaf", "merge"] as const satisfies readonly CompressorUsage["node"][];

function utc(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  const canonical = value.includes(".") ? value : `${value.slice(0, -1)}.000Z`;
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : NaN;
}

interface Group {
  model: string;
  node: CompressorUsage["node"];
  calls: number;
  retries: number;
  attempts: Record<number, Partial<Record<"initial" | (typeof causes)[number], number>>>;
}

export async function census(paths: readonly string[], since: string, until: string, version: string) {
  const start = utc(since);
  const end = utc(until);
  if (!(start < end) || !paths.length || !/^(?:unversioned|\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)$/.test(version)) throw new Error("Expected explicit metric inputs and an increasing UTC interval");
  const inputs = new Set<string>();
  for (const path of paths) inputs.add(await realpath((await stat(path)).isDirectory() ? join(path, METRICS_FILE) : path));
  const skipped = { malformed: 0, otherType: 0, outsideWindow: 0, otherVersion: 0, incompatible: 0 };
  const groups = new Map<string, Group>();
  for (const input of inputs) {
    if (!(await stat(input)).isFile()) throw new Error("Metric input is not a regular file");
    const stream = createReadStream(input);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row: Partial<CompressorUsage> & { pluginVersion?: unknown };
        try {
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
          row = value;
        } catch {
          skipped.malformed++;
          continue;
        }
        if (row.type !== undefined && row.type !== "compressor") { skipped.otherType++; continue; }
        const at = utc(row.at);
        if (at < start || at >= end) { skipped.outsideWindow++; continue; }
        if (row.pluginVersion !== (version === "unversioned" ? undefined : version)) { skipped.otherVersion++; continue; }
        const { model, node, attempt, retry } = row;
        if (!Number.isFinite(at) || typeof model !== "string" || !model.trim() || !node || !nodes.includes(node) ||
            typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1 ||
            (attempt === 1 ? retry !== null : !retry || !causes.includes(retry))) {
          skipped.incompatible++;
          continue;
        }
        const key = JSON.stringify([model, node]);
        let group = groups.get(key);
        if (!group) groups.set(key, group = { model, node, calls: 0, retries: 0, attempts: {} });
        group.calls++;
        if (attempt > 1) group.retries++;
        const counts = group.attempts[attempt] ??= {};
        const cause = retry ?? "initial";
        counts[cause] = (counts[cause] ?? 0) + 1;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return {
    schema: "0.16.6", version, since, until, files: inputs.size, skipped,
    groups: [...groups.values()].sort((a, b) => a.model.localeCompare(b.model) || a.node.localeCompare(b.node))
      .map(group => ({ ...group, retryShare: group.retries / group.calls })),
  };
}

if (import.meta.main) {
  const [version, since, until, ...paths] = Bun.argv.slice(2);
  try {
    console.log(JSON.stringify(await census(paths, since, until, version), null, 2));
  } catch {
    console.error("Census failed. Usage: bun scripts/compressor-retry-census.ts VERSION_OR_unversioned SINCE_UTC UNTIL_UTC METRICS_FILE_OR_STORE [...]; inputs must be readable regular files or store directories containing metrics.jsonl.");
    process.exitCode = 1;
  }
}
