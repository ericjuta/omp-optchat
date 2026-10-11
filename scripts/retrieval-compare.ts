#!/usr/bin/env bun
/**
 * Synthetic retrieval comparison (ticket 10): zoom-only, zoom-depth, chat_search, prefetch, chat_recall and a beam
 * script, run over one seeded tree with a fake summariser and a fake judge. No provider is called.
 *
 *   bun run evidence:retrieval                      # defaults: 256 messages, 12 facts, seed 1; Markdown to stdout
 *   bun run evidence:retrieval -- --seed 2 --out out/retrieval-seed2.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type CompareConfig, renderMarkdown, runComparison } from "./retrieval/report.ts";

const USAGE = "usage: bun run evidence:retrieval [--n <messages>] [--facts <count>] [--seed <int>] [--out <file.json>]";

function integer(flag: string, value: string | undefined, min: number, max: number): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${flag} must be an integer from ${min} to ${max}\n${USAGE}`);
  }
  return parsed;
}

function parse(argv: readonly string[]): { config: CompareConfig; out: string | undefined } {
  const config = { seed: 1, n: 256, facts: 12 };
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--seed") config.seed = integer(flag, value, 0, 2 ** 31 - 1);
    else if (flag === "--n") config.n = integer(flag, value, 2, 100_000);
    else if (flag === "--facts") config.facts = integer(flag, value, 1, 64);
    else if (flag === "--out" && value !== undefined) out = value;
    else throw new Error(`unknown or incomplete argument ${flag ?? "(none)"}\n${USAGE}`);
  }
  if (config.n < 2 * config.facts) throw new RangeError(`--n must be at least 2 * --facts (${2 * config.facts})`);
  return { config, out };
}

const { config, out } = parse(process.argv.slice(2));
const report = await runComparison(config);
console.log(renderMarkdown(report));
if (out !== undefined) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`wrote ${out}`);
}
