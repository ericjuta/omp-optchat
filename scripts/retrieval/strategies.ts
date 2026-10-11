/**
 * Retrieval strategies run over one synthetic tree (ticket 10). Each sees only what an agent or gate would have: the
 * view, zoom, chat_search, the prefetch gate, chat_recall, and a judge. Probe words are the topic words, never the value.
 *
 * Counting rules, shared by every strategy:
 * - steps: agent tool calls (zoom, chat_search, chat_recall). A beam descent is one script run, so one step.
 *   The prefetch gate runs before the agent and adds no step.
 * - judgeCalls: calls to the judge, whichever component makes them.
 * - zooms: every memory.zoom call, including gate and script zooms.
 * - bytes: UTF-8 bytes the agent receives: tool results, the prefetch block, or the script's printed output.
 *   The view is already in the agent's prompt and is not counted.
 * - found: the received bytes contain the fact's value.
 *
 * Every judge here is the lexical fake in `overlapJudge`, so the strategies differ in navigation, not in judgement.
 */
import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, NoulAnswer, Questions, Usage } from "@oh-my-pi/pi-ai";
import { type Memory, type SearchResult, utf8Bytes } from "../../src/memory.ts";
import { prefetchBlock, type PrefetchMemory } from "../../src/system1/prefetch.ts";
import { recall, renderRecall, type RecallMemory } from "../../src/system1/recall.ts";
import type { SyntheticTree } from "./synthetic.ts";

/** Agent calls one probe may spend (zoom, search or recall), shared by every strategy. */
export const STEP_BUDGET = 24;
/** Lines the prefetch gate keeps, and the beam's width. */
export const PREFETCH_K = 8;
export const BEAM_WIDTH = 2;
/** Minimum probability for a line to qualify, for the gate, recall and the beam. */
export const MIN_P = 0.5;
/** Deepest one-call zoom in the depth strategy. */
export const ZOOM_DEPTH = 4;

export interface Line {
  readonly id: number;
  readonly n: number;
  readonly text: string;
}

export interface Probe {
  readonly topic: string;
  readonly value: string;
  readonly question: string;
  readonly words: readonly string[];
}

export interface Counts {
  steps: number;
  judgeCalls: number;
  zooms: number;
  bytes: number;
}

export interface Outcome extends Counts {
  readonly found: boolean;
}

export type Run = (tree: SyntheticTree, probe: Probe) => Promise<Outcome>;

export interface StrategyDef {
  readonly name: StrategyName;
  readonly policy: string;
  readonly run: Run;
}

const ROW = /^(\d+)\+(\d+)\|(.*)$/;

/** The `id+n|text` rows of a zoom or prefetch text; any other line (headers, envelopes) is skipped. */
export function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const row of text.split("\n")) {
    const match = ROW.exec(row);
    if (match) lines.push({ id: Number(match[1]), n: Number(match[2]), text: match[3]! });
  }
  return lines;
}

/** How many distinct probe words the text contains: the lexical overlap every fake scorer uses. */
export function overlap(text: string, words: readonly string[]): number {
  const seen = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
  return words.filter((word) => seen.has(word)).length;
}

const USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * The fake judge. A noul is P = share of the probe words in the line. A choice gives the side with more probe words
 * probability share, and a tie gives both sides 0.5, which recall's rule resolves to the second side.
 */
export function overlapJudge(words: readonly string[]): Judge {
  return {
    label: "fake/overlap",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>, _options?: JudgeOptions): Promise<JudgmentResult<Q>> {
      const state = request.state as Record<string, unknown>;
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === "noul") {
          const lines = state.lines as Record<string, string>;
          answers[key] = { type: "noul", noul: overlap(lines[key]!, words) / words.length };
        } else if (question.type === "choice") {
          const first = overlap(String(state.first), words);
          const second = overlap(String(state.second), words);
          const pFirst = first + second === 0 ? 0.5 : first / (first + second);
          answers[key] = {
            type: "choice",
            choice: pFirst > 0.5 ? "first" : "second",
            probabilities: { first: pFirst, second: 1 - pFirst },
            confidence: 1,
          };
        } else {
          throw new Error(`fake judge: unsupported question type ${question.type}`);
        }
      }
      return { api: "fake", provider: "fake", model: "overlap", answers, usage: USAGE } as unknown as JudgmentResult<Q>;
    },
  };
}

/** Counts every judge call against `counts`. */
export function metered(judge: Judge, counts: Counts): Judge {
  return {
    label: judge.label,
    judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
      counts.judgeCalls++;
      return judge.judge(request, options);
    },
  };
}

/** Lines ordered as best-first wants them: more probe words, then newer, then shorter. */
function better(a: Line, b: Line, words: readonly string[]): boolean {
  const scoreA = overlap(a.text, words);
  const scoreB = overlap(b.text, words);
  if (scoreA !== scoreB) return scoreA > scoreB;
  if (a.id !== b.id) return a.id > b.id;
  return a.n < b.n;
}

/**
 * Greedy best-first with backtracking: the best unopened line goes next, whichever branch it came from. A line of
 * n >= 2 is opened in one zoom call, `maxDepth` levels at once at most. A leaf (n = 1) is read exactly. Returns true
 * once a returned text contains the value. Every zoom is one agent step.
 */
function bestFirst(memory: Memory, counts: Counts, seeds: readonly Line[], probe: Probe, maxDepth: number): boolean {
  const frontier: Line[] = [...seeds];
  const seen = new Set(seeds.map((line) => `${line.id}+${line.n}`));
  while (counts.steps < STEP_BUDGET && frontier.length > 0) {
    let best = 0;
    for (let k = 1; k < frontier.length; k++) {
      if (better(frontier[k]!, frontier[best]!, probe.words)) best = k;
    }
    const line = frontier.splice(best, 1)[0]!;
    const depth = line.n === 1 ? 1 : Math.min(maxDepth, Math.log2(line.n));
    counts.steps++;
    counts.zooms++;
    const text = memory.zoom(line.id, line.n, 0, depth).text;
    counts.bytes += utf8Bytes(text);
    if (text.includes(probe.value)) return true;
    for (const child of parseLines(text)) {
      const key = `${child.id}+${child.n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frontier.push(child);
    }
  }
  return false;
}

/** The lines of `probe` the judge scores at P >= MIN_P, best BEAM_WIDTH first (ties: newer). One judge call. */
async function rank(judge: Judge, candidates: readonly Line[], probe: Probe): Promise<Line[]> {
  if (candidates.length === 0) return [];
  const lines: Record<string, string> = {};
  const questions: Questions = {};
  for (const line of candidates) {
    const key = `${line.id}+${line.n}`;
    lines[key] = line.text;
    questions[key] = { type: "noul", instructions: `Line ${key} holds information needed to answer ${probe.question}` };
  }
  const result = await judge.judge({ state: { question: probe.question, lines }, questions });
  return candidates
    .map((line) => ({ line, p: (result.answers[`${line.id}+${line.n}`] as NoulAnswer).noul }))
    .filter((entry) => entry.p >= MIN_P)
    .sort((a, b) => b.p - a.p || b.line.id - a.line.id)
    .slice(0, BEAM_WIDTH)
    .map((entry) => entry.line);
}

/** chat_search's result text, as the tool renders it. */
function renderSearch(query: string, result: SearchResult): string {
  const header = `[optchat search] ${result.hits.length} hits for "${query}" (newest first)`;
  const footer = result.next === null ? "[no older hits]" : `[older hits: before=${result.next}]`;
  return [header, ...result.hits.map((hit) => `${hit.id}|${hit.kind}|${hit.snippet}`), footer].join("\n");
}

const zoomOnly: Run = async (tree, probe) => {
  const counts: Counts = { steps: 0, judgeCalls: 0, zooms: 0, bytes: 0 };
  const found = bestFirst(tree.memory, counts, tree.memory.viewLines(true), probe, 1);
  return { found, ...counts };
};

const zoomDepth: Run = async (tree, probe) => {
  const counts: Counts = { steps: 0, judgeCalls: 0, zooms: 0, bytes: 0 };
  const found = bestFirst(tree.memory, counts, tree.memory.viewLines(true), probe, ZOOM_DEPTH);
  return { found, ...counts };
};

const viaSearch: Run = async (tree, probe) => {
  const counts: Counts = { steps: 0, judgeCalls: 0, zooms: 0, bytes: 0 };
  let before: number | undefined;
  for (;;) {
    if (counts.steps >= STEP_BUDGET) return { found: false, ...counts };
    counts.steps++;
    const result = tree.memory.search(probe.topic, { before });
    counts.bytes += utf8Bytes(renderSearch(probe.topic, result));
    // Hits open newest first: the top hit is zoomed first, then the rest in order while the budget lasts.
    for (const hit of result.hits) {
      if (counts.steps >= STEP_BUDGET) break;
      counts.steps++;
      counts.zooms++;
      const page = tree.memory.zoom(hit.id, 1, 0, 1).text;
      counts.bytes += utf8Bytes(page);
      if (page.includes(probe.value)) return { found: true, ...counts };
    }
    if (result.next === null) return { found: false, ...counts };
    before = result.next;
  }
};

const viaPrefetch: Run = async (tree, probe) => {
  const counts: Counts = { steps: 0, judgeCalls: 0, zooms: 0, bytes: 0 };
  const { memory } = tree;
  const gate: PrefetchMemory = {
    viewLines: () => memory.viewLines(false),
    zoom: (id, n) => {
      counts.zooms++;
      return memory.zoom(id, n);
    },
  };
  const block = await prefetchBlock(gate, {
    judge: metered(overlapJudge(probe.words), counts),
    message: probe.question,
    k: PREFETCH_K,
    min: MIN_P,
  });
  const rows = parseLines(block ?? "");
  if (block !== undefined) {
    counts.bytes += utf8Bytes(block);
    if (block.includes(probe.value)) return { found: true, ...counts };
  }
  // A block row is a child of the gate's parent: the aligned line of width 2n that the gate opened.
  const opened = new Set(rows.map((row) => `${Math.floor(row.id / (2 * row.n)) * 2 * row.n}+${2 * row.n}`));
  const seeds = [...memory.viewLines(true).filter((line) => !opened.has(`${line.id}+${line.n}`)), ...rows];
  return { found: bestFirst(memory, counts, seeds, probe, 1), ...counts };
};

const viaRecall: Run = async (tree, probe) => {
  const counts: Counts = { steps: 1, judgeCalls: 0, zooms: 0, bytes: 0 };
  const { memory } = tree;
  const adapter: RecallMemory = {
    viewLines: () => memory.viewLines(true),
    lineAt: (id, n) => memory.lineAt(id, n),
    page: (id) => {
      counts.zooms++;
      return memory.zoom(id, 1, 0);
    },
  };
  const outcome = await recall(adapter, {
    judge: metered(overlapJudge(probe.words), counts),
    question: probe.question,
    min: MIN_P,
  });
  const text = renderRecall(outcome);
  counts.bytes = utf8Bytes(text);
  return { found: text.includes(probe.value), ...counts };
};

const beam: Run = async (tree, probe) => {
  const counts: Counts = { steps: 1, judgeCalls: 0, zooms: 0, bytes: 0 };
  const { memory } = tree;
  const judge = metered(overlapJudge(probe.words), counts);
  let kept = await rank(judge, memory.viewLines(true), probe);
  // Expansions stay inside the script: only the final leaves reach the agent. The budget caps expansions.
  while (kept.some((line) => line.n > 1) && counts.zooms < STEP_BUDGET) {
    const expanded: Line[] = [];
    for (const line of kept) {
      if (line.n === 1 || counts.zooms >= STEP_BUDGET) {
        expanded.push(line);
        continue;
      }
      counts.zooms++;
      expanded.push(...parseLines(memory.zoom(line.id, line.n, 0, 1).text));
    }
    kept = await rank(judge, expanded, probe);
  }
  const printed: string[] = [];
  for (const line of kept) {
    if (line.n !== 1) continue;
    counts.zooms++;
    printed.push(memory.zoom(line.id, 1, 0, 1).text);
  }
  const output = printed.join("\n");
  counts.bytes = utf8Bytes(output);
  return { found: output.includes(probe.value), ...counts };
};

export const STRATEGY_NAMES = ["zoom-only", "zoom-depth", "chat_search", "prefetch", "chat_recall", "beam"] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

/** Each strategy's name, policy text (printed in the report), and runner. */
export const STRATEGIES: readonly StrategyDef[] = [
  {
    name: "zoom-only",
    policy: "Agent zoom(id,n) one level per call; best-first over view lines and opened children by probe-word overlap, newest on ties; leaves read with zoom(id,1); budget 24 calls.",
    run: zoomOnly,
  },
  {
    name: "zoom-depth",
    policy: `Same best-first policy, but each call opens up to ${ZOOM_DEPTH} levels at once (zoom depth d = min(${ZOOM_DEPTH}, log2 n)).`,
    run: zoomDepth,
  },
  {
    name: "chat_search",
    policy: "chat_search(topic words), newest hits first, following next paging; zoom(id,1) each hit in order until the value appears; budget 24 calls.",
    run: viaSearch,
  },
  {
    name: "prefetch",
    policy: `prefetchBlock gate (judge = overlap, k=${PREFETCH_K}, min=${MIN_P}, one-level zoom, no agent step), then the agent's best-first zooms over the block rows and unopened view lines within budget 24.`,
    run: viaPrefetch,
  },
  {
    name: "chat_recall",
    policy: `recall() with the overlap judge (min=${MIN_P}, viewLines(true) so single messages are candidates); one chat_recall call, no follow-up.`,
    run: viaRecall,
  },
  {
    name: "beam",
    policy: `Codemode beam script (B=${BEAM_WIDTH}, min P=${MIN_P}): judge the view, keep B, zoom each one level, judge children, keep B, repeat to leaves; print the kept leaves. One script step; expansions do not reach the agent.`,
    run: beam,
  },
];
