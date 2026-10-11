/**
 * Runs every retrieval strategy on one synthetic tree and renders the comparison: a summary table, a per-probe matrix
 * by fact age, and a JSON artifact. Everything is deterministic for a seed; nothing reads the clock or the environment.
 */
import { buildTree, SUMMARIZER_POLICY, type Fact } from "./synthetic.ts";
import { type Counts, type Outcome, type Probe, STEP_BUDGET, STRATEGIES, type StrategyName } from "./strategies.ts";

export interface CompareConfig {
  readonly seed: number;
  /** Messages in the synthetic history. */
  readonly n: number;
  /** Planted facts, one probe each. */
  readonly facts: number;
}

export interface ProbeRow {
  readonly index: number;
  readonly age: number;
  readonly topic: string;
  readonly keep: number;
  /** Whether any view line, as the agent sees it, still names the fact's topic. */
  readonly inView: boolean;
  readonly outcomes: Record<StrategyName, Outcome>;
}

export interface StrategySummary extends Counts {
  readonly name: StrategyName;
  readonly policy: string;
  readonly found: number;
  readonly probes: number;
}

export interface Report {
  readonly synthetic: true;
  readonly disclaimer: string;
  readonly config: CompareConfig;
  readonly viewLines: number;
  readonly viewLinesWithTopic: number;
  readonly summarizerPolicy: readonly string[];
  readonly countingRules: readonly string[];
  readonly strategies: readonly StrategySummary[];
  /** Probes, oldest fact first. */
  readonly probes: readonly ProbeRow[];
}

const DISCLAIMER =
  "SYNTHETIC: a fake summariser and a fake lexical judge. Measures navigation mechanics on a planted tree, not Jev, real summary quality, or real judgement.";

const COUNTING_RULES = [
  `Agent steps: zoom, chat_search, chat_recall calls, budget ${STEP_BUDGET} per probe. A beam is one script step. The prefetch gate adds no step.`,
  "Judge calls: every call to the judge, by any component. Zoom calls: every memory.zoom call, gate and script included.",
  "Bytes: UTF-8 bytes the agent receives (tool results, the prefetch block, the script's printed output). The view is already in the prompt and is not counted.",
  "Found: the bytes received contain the fact's value. Probe question: names the topic, never the value.",
];

function probeFor(fact: Fact): Probe {
  return {
    topic: fact.topic,
    value: fact.value,
    question: `What is the ${fact.topic}?`,
    words: fact.topic.split(" "),
  };
}

/** Builds one tree, runs every strategy on every probe, and closes the tree. */
export async function runComparison(config: CompareConfig): Promise<Report> {
  const tree = await buildTree({ seed: config.seed, n: config.n, facts: config.facts });
  try {
    const { corpus } = tree;
    const lines = tree.memory.viewLines(true);
    const inView = (topic: string): boolean => lines.some((line) => line.text.includes(topic));
    const probes: ProbeRow[] = [];
    for (const fact of [...corpus.facts].sort((a, b) => b.age - a.age)) {
      const probe = probeFor(fact);
      const outcomes = {} as Record<StrategyName, Outcome>;
      for (const strategy of STRATEGIES) {
        outcomes[strategy.name] = await strategy.run(tree, probe);
      }
      probes.push({ index: fact.index, age: fact.age, topic: fact.topic, keep: fact.keep, inView: inView(fact.topic), outcomes });
    }
    const strategies = STRATEGIES.map((strategy): StrategySummary => {
      const rows = probes.map((row) => row.outcomes[strategy.name]);
      const sum = (pick: (outcome: Outcome) => number): number => rows.reduce((total, outcome) => total + pick(outcome), 0);
      return {
        name: strategy.name,
        policy: strategy.policy,
        found: rows.filter((outcome) => outcome.found).length,
        probes: rows.length,
        steps: sum((outcome) => outcome.steps),
        judgeCalls: sum((outcome) => outcome.judgeCalls),
        zooms: sum((outcome) => outcome.zooms),
        bytes: sum((outcome) => outcome.bytes),
      };
    });
    return {
      synthetic: true,
      disclaimer: DISCLAIMER,
      config,
      viewLines: lines.length,
      viewLinesWithTopic: corpus.facts.filter((fact) => inView(fact.topic)).length,
      summarizerPolicy: SUMMARIZER_POLICY,
      countingRules: COUNTING_RULES,
      strategies,
      probes,
    };
  } finally {
    await tree.close();
  }
}

/** The report as Markdown: summary table, per-probe matrix by age, then the policies. */
export function renderMarkdown(report: Report): string {
  const { config } = report;
  const lines: string[] = [];
  lines.push("## Retrieval comparison (SYNTHETIC)", "", report.disclaimer, "");
  lines.push(
    `seed ${config.seed}, messages ${config.n}, facts ${config.facts}, budget ${STEP_BUDGET} agent calls per probe; ` +
      `${report.viewLines} view lines, ${report.viewLinesWithTopic} of ${config.facts} fact topics still named in the view`,
    "",
    "| Strategy | Found | Agent steps | Judge calls | Zoom calls | Bytes returned |",
    "|---|---|---|---|---|---|",
  );
  for (const row of report.strategies) {
    lines.push(`| ${row.name} | ${row.found}/${row.probes} | ${row.steps} | ${row.judgeCalls} | ${row.zooms} | ${row.bytes} |`);
  }
  const names = report.strategies.map((row) => row.name);
  lines.push("", "### Per-probe found, by fact age (oldest first)", "");
  lines.push(`| age | topic | keep | in view | ${names.join(" | ")} |`);
  lines.push(`|---|---|---|---|${names.map(() => "---").join("|")}|`);
  for (const probe of report.probes) {
    const cells = names.map((name) => (probe.outcomes[name].found ? "found" : "miss"));
    lines.push(`| ${probe.age} | ${probe.topic} | ${probe.keep} | ${probe.inView ? "yes" : "no"} | ${cells.join(" | ")} |`);
  }
  lines.push("", "### Summariser policy", "", ...report.summarizerPolicy.map((rule) => `- ${rule}`));
  lines.push("", "### Counting", "", ...report.countingRules.map((rule) => `- ${rule}`));
  lines.push("", "### Strategies", "", ...report.strategies.map((row) => `- ${row.name}: ${row.policy}`));
  return lines.join("\n");
}
