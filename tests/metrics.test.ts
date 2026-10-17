/**
 * The compressor metric sink. By default every completed compressor call is appended, counts only, to `metrics.jsonl`
 * in the active store directory, and `/optchat status` sums it: a call without a reported cost is unknown, never $0.
 * Runs the real OptChat hooks on the fake host against the loopback compressor.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOptChat } from "../src/index.ts";
import { appendMetric, METRICS_FILE, readCompressorSpend, type CompressorUsage } from "../src/metrics.ts";
import { startCompressorServer, type CompressorServer } from "./helpers/compressor-server.ts";
import { openFakeHost, type FakeHost, type HostMessage } from "./helpers/fake-host.ts";
import { ALL_GATES_OFF, anthropicModel, SEED_TEXTS, SMALL_NODES, until } from "./helpers/system1-chat.ts";

const roots: string[] = [];
const hosts: FakeHost[] = [];
const servers: CompressorServer[] = [];
let savedOverride: string | undefined;

beforeEach(() => {
  savedOverride = process.env.OPTCHAT_METRICS_FILE;
  delete process.env.OPTCHAT_METRICS_FILE;
});

afterEach(async () => {
  if (savedOverride === undefined) delete process.env.OPTCHAT_METRICS_FILE;
  else process.env.OPTCHAT_METRICS_FILE = savedOverride;
  for (const host of hosts.splice(0).reverse()) await host.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const USAGE: CompressorUsage = {
  model: "fake/compressor",
  input: 8,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  attempt: 1,
  purpose: "leaf",
  latencyMs: 5,
  costUsd: null,
  stopReason: "stop",
  error: null,
};

async function openChat(): Promise<{ host: FakeHost; metrics: string; seen: CompressorUsage[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "optchat-metrics-")));
  roots.push(root);
  const compressor = await startCompressorServer();
  servers.push(compressor);
  const seen: CompressorUsage[] = [];
  const host = await openFakeHost(createOptChat({ onCompressorUsage: (usage) => seen.push(usage) }), {
    directory: join(root, "chat"),
    flags: { ...ALL_GATES_OFF, ...SMALL_NODES },
    model: compressor.model,
    mainModel: anthropicModel(),
    apiKey: "fixture-key",
  });
  hosts.push(host);
  return { host, metrics: join(host.directory, METRICS_FILE), seen };
}

async function seed(host: FakeHost): Promise<void> {
  let transcript: HostMessage[] = [];
  for (const text of SEED_TEXTS) {
    const messages = [...transcript, host.user(text)];
    await host.context(messages);
    transcript = [...messages, host.assistant("noted")];
    await host.fire("agent_end", { messages: transcript, willContinue: false });
  }
  await until(async () => (await statusOf(host)).includes("compressor jobs running: 0"), "the compressor to settle");
}

async function statusOf(host: FakeHost): Promise<string> {
  return (await host.command("status")).at(-1)?.message ?? "";
}

describe("compressor metric sink", () => {
  test("appends every completed compressor call to the store directory by default, counts only", async () => {
    const { host, metrics, seen } = await openChat();
    expect(existsSync(metrics)).toBe(false);
    await seed(host);

    expect(seen.length).toBeGreaterThan(0);
    const lines = readFileSync(metrics, "utf8").split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(seen.length);
    expect(lines.map((line) => JSON.parse(line))).toEqual(seen);
    expect(Object.keys(JSON.parse(lines[0]!) as object).sort()).toEqual(Object.keys(USAGE).sort());
    for (const text of SEED_TEXTS) expect(readFileSync(metrics, "utf8")).not.toContain(text);
    expect(statSync(metrics).mode & 0o777).toBe(0o600);
    expect(await statusOf(host)).toContain(`compressor spend (this store): ${seen.length} calls, $0.0000 reported`);
  });

  test("an idle status carries no spend line", async () => {
    const { host } = await openChat();
    expect(await statusOf(host)).not.toContain("compressor spend");
  });

  test("status shows a call with no reported cost as unknown, never as $0", async () => {
    const { host, metrics } = await openChat();
    appendMetric(metrics, { ...USAGE, costUsd: 0.25 });
    appendMetric(metrics, { ...USAGE, costUsd: null });
    appendMetric(metrics, { ...USAGE, costUsd: null });
    let status = await statusOf(host);
    expect(status).toContain("compressor spend (this store): 3 calls, $0.2500 reported for 1; cost unknown for 2");

    const unpriced = await openChat();
    appendMetric(unpriced.metrics, USAGE);
    status = await statusOf(unpriced.host);
    expect(status).toContain("compressor spend (this store): 1 calls, cost unknown (the host reported none)");
    expect(status).not.toContain("$0.0000");
  });

  test("OPTCHAT_METRICS_FILE redirects the sink away from the store", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "optchat-metrics-env-")));
    roots.push(root);
    const redirected = join(root, "elsewhere.jsonl");
    process.env.OPTCHAT_METRICS_FILE = redirected;
    const { host, metrics, seen } = await openChat();
    await seed(host);
    expect(seen.length).toBeGreaterThan(0);
    expect(readFileSync(redirected, "utf8").split("\n").filter((line) => line.length > 0)).toHaveLength(seen.length);
    expect(existsSync(metrics)).toBe(false);
  });
});

describe("readCompressorSpend", () => {
  test("a missing file is zero calls; torn or unpriced lines are calls with unknown cost", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "optchat-spend-")));
    roots.push(root);
    const path = join(root, METRICS_FILE);
    expect(readCompressorSpend(path)).toEqual({ calls: 0, reportedUsd: 0, unknownCost: 0 });
    appendMetric(path, { ...USAGE, costUsd: 0.5 });
    appendMetric(path, USAGE);
    await Bun.write(path, `${readFileSync(path, "utf8")}{"model":"torn`);
    expect(readCompressorSpend(path)).toEqual({ calls: 3, reportedUsd: 0.5, unknownCost: 2 });
  });
});
