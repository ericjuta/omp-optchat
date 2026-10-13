import { afterAll, describe, expect, test } from "bun:test";
import { type Report, renderMarkdown, runComparison } from "../scripts/retrieval/report.ts";
import { type Outcome, STEP_BUDGET } from "../scripts/retrieval/strategies.ts";
import { buildTree, type SyntheticTree } from "../scripts/retrieval/synthetic.ts";

/** Small enough to run in seconds; big enough that some fact topics are dropped from the view. */
const CONFIG = { seed: 1, n: 96, facts: 6 };
const SLOW_MS = 60_000;

/** Built once on first use: the cases below only read the comparison report or the tree, and each build is the slow part. */
let sharedReport: Promise<Report> | undefined;
let sharedTree: Promise<SyntheticTree> | undefined;
const sharedComparison = (): Promise<Report> => (sharedReport ??= runComparison(CONFIG));
const sharedSyntheticTree = (): Promise<SyntheticTree> => (sharedTree ??= buildTree(CONFIG));
afterAll(async () => {
  if (sharedTree) await (await sharedTree).close();
});

/** Strategies that never call the judge, and whose every zoom is an agent step. */
const NO_JUDGE = ["zoom-only", "zoom-depth", "chat_search"] as const;
const JUDGED = ["prefetch", "chat_recall", "beam"] as const;

describe("synthetic retrieval comparison", () => {
  test("the same seed gives the same report", async () => {
    const first = await sharedComparison();
    const second = await runComparison(CONFIG);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(renderMarkdown(second)).toBe(renderMarkdown(first));
  }, SLOW_MS);

  test("per-strategy counts equal the sum of their probe outcomes, within the rules", async () => {
    const report = await sharedComparison();
    expect(report.probes).toHaveLength(CONFIG.facts);
    for (const summary of report.strategies) {
      const rows: Outcome[] = report.probes.map((probe) => probe.outcomes[summary.name]);
      const total = (pick: (row: Outcome) => number): number => rows.reduce((sum, row) => sum + pick(row), 0);
      expect(summary.probes).toBe(CONFIG.facts);
      expect(summary.found).toBe(rows.filter((row) => row.found).length);
      expect(summary.steps).toBe(total((row) => row.steps));
      expect(summary.judgeCalls).toBe(total((row) => row.judgeCalls));
      expect(summary.zooms).toBe(total((row) => row.zooms));
      expect(summary.bytes).toBe(total((row) => row.bytes));
    }
    for (const probe of report.probes) {
      for (const name of NO_JUDGE) {
        const row = probe.outcomes[name];
        expect(row.judgeCalls).toBe(0);
        expect(row.zooms).toBeLessThanOrEqual(row.steps);
      }
      for (const name of JUDGED) expect(probe.outcomes[name].judgeCalls).toBeGreaterThan(0);
      for (const row of Object.values(probe.outcomes)) {
        expect(row.steps).toBeLessThanOrEqual(STEP_BUDGET);
        expect(row.bytes).toBeGreaterThanOrEqual(0);
        if (row.found) expect(row.bytes).toBeGreaterThan(0);
      }
      expect(probe.outcomes["chat_recall"].steps).toBe(1);
      expect(probe.outcomes.beam.steps).toBe(1);
    }
  }, SLOW_MS);

  test("the summariser keeps no value, while the raw log keeps every planted fact", async () => {
    const tree = await sharedSyntheticTree();
    for (const line of tree.memory.viewLines(true)) expect(line.text).not.toMatch(/\d/);
    for (const fact of tree.corpus.facts) {
      expect(tree.memory.search(fact.topic).hits.map((hit) => hit.id)).toContain(fact.index);
      expect(tree.memory.zoom(fact.index, 1).text).toContain(fact.value);
    }
  }, SLOW_MS);

  test("chat_search finds a planted fact whose topic the summaries dropped", async () => {
    const report = await sharedComparison();
    const dropped = report.probes.filter((probe) => !probe.inView);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.some((probe) => probe.outcomes.chat_search.found)).toBe(true);
  }, SLOW_MS);
});
