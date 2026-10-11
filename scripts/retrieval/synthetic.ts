/**
 * The synthetic long chat behind the retrieval comparison (ticket 10). A seeded generator writes filler with planted
 * facts at known ages, and a deterministic fake summariser builds them into a real Memory over a real Store in a temp
 * directory. Nothing here calls a provider: the tree measures navigation mechanics, not real-summary quality.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, utf8Bytes, type Summarize } from "../../src/memory.ts";
import { type Kind, Store } from "../../src/store.ts";

/** Node budget: every synthetic message is longer, so every leaf is summarised. */
export const NODE_BYTES = 256;
/** View budget: small enough that a few hundred messages coarsen into a short view. */
export const VIEW_BYTES = 4_096;
/** Summaries are padded to this size, so two siblings plus their newline always exceed NODE_BYTES. */
export const SUMMARY_MIN_BYTES = NODE_BYTES / 2 + 4;
/** A fact's topic survives merges up to a level drawn from 1..MAX_KEEP. */
export const MAX_KEEP = 5;
/** Themes a merged summary keeps. */
const THEMES = 3;
const BASE_TIME = Date.UTC(2026, 0, 1);
const MINUTE_MS = 60_000;

export const QUALIFIERS = ["staging", "production", "backup", "legacy", "analytics", "billing", "search", "mobile"] as const;
export const SUBJECTS = ["database", "cache", "queue", "gateway", "cluster", "bucket", "scheduler", "proxy"] as const;
export const ATTRIBUTES = ["port", "timeout", "quota", "version", "shard", "limit"] as const;
const GENERIC = [
  "lunch", "standup", "parser", "onboarding", "invoice", "hiring", "refactor", "docs",
  "retro", "roadmap", "linting", "budget", "offsite", "fonts", "sprint",
] as const;
const VOCABULARY: ReadonlySet<string> = new Set<string>([...QUALIFIERS, ...SUBJECTS, ...ATTRIBUTES, ...GENERIC]);

const GENERIC_SENTENCES: ReadonlyArray<(word: string) => string> = [
  (word) => `We spent a while on the ${word} again and agreed to keep things simple for now.`,
  (word) => `Someone asked whether the ${word} work could wait until after the next planning meeting.`,
  (word) => `The ${word} thread drifted into a long tangent about naming and folder layout.`,
  (word) => `Reminder to write down the ${word} decision somewhere the whole team can find it.`,
  (word) => `Nobody objected to the ${word} proposal, though a few people wanted more examples first.`,
];
/** Filler that mentions a fact's words without its value: a decoy for overlap scoring and for search. */
const NOISE_SENTENCES: ReadonlyArray<(q: string, s: string, a: string) => string> = [
  (q, s, a) => `We mentioned the ${q} ${s} ${a} only in passing and wrote nothing down.`,
  (q, s) => `The ${q} ${s} rollout came up, but nobody had fresh numbers to share.`,
  (_q, s, a) => `A question about the ${s} ${a} went unanswered until someone checks the runbook.`,
];

/** The policy, as the report prints it. Keep in step with `fakeSummarizer`. */
export const SUMMARIZER_POLICY: readonly string[] = [
  `Node budget ${NODE_BYTES} bytes; view budget ${VIEW_BYTES} bytes; every leaf and every merge goes through the summariser.`,
  "A summary is one line `topics: <phrases> | themes: <words> |`, padded with dots to " +
    `${SUMMARY_MIN_BYTES} bytes. It never contains a digit, so no value survives any level.`,
  "A leaf (one message) keeps the topic phrase it states, whatever its value.",
  "A merged line covering 2^L messages keeps a child's topic only while L <= that fact's keep (seeded, 1..5). " +
    "Old facts under coarse view lines are dropped from the view, and only zoom or chat_search can reach them.",
  `Over the node budget, a merge drops its earliest-listed topics first. Themes: the first ${THEMES} vocabulary words, interleaved.`,
];

/** mulberry32: a small seeded PRNG in [0, 1). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

export interface TreeConfig {
  readonly seed: number;
  /** Messages; at least 2 * facts. */
  readonly n: number;
  /** Planted facts, 1..64. */
  readonly facts: number;
}

/** One planted fact: its message index, its age in messages before the newest, its topic, value, and keep level. */
export interface Fact {
  readonly index: number;
  readonly age: number;
  readonly topic: string;
  readonly value: string;
  readonly keep: number;
}

export interface Corpus {
  readonly messages: ReadonlyArray<{ readonly kind: Kind; readonly text: string }>;
  readonly facts: readonly Fact[];
}

/** The sentence that states a fact in the raw log. */
export const statement = (topic: string, value: string): string => `the ${topic} is ${value}`;

function generic(random: () => number): string {
  return pick(random, GENERIC_SENTENCES)(pick(random, GENERIC));
}

/** Pads `sentences` with generic sentences until the message exceeds NODE_BYTES by a seeded margin. */
function padded(random: () => number, sentences: string[]): string {
  const target = NODE_BYTES + 32 + Math.floor(random() * 96);
  while (utf8Bytes(sentences.join(" ")) < target) sentences.push(generic(random));
  return sentences.join(" ");
}

/** Seeded filler with `facts` planted facts, one per equal slice of the history at a seeded position. */
export function buildCorpus(config: TreeConfig): Corpus {
  const { seed, n, facts: count } = config;
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new RangeError("facts must be 1..64");
  if (!Number.isSafeInteger(n) || n < 2 * count) throw new RangeError("n must be at least 2 * facts");
  const random = prng(seed);
  const topics = new Set<string>();
  const values = new Set<string>();
  const planted = new Map<number, Fact>();
  const slice = n / count;
  for (let j = 0; j < count; j++) {
    let topic: string;
    do topic = `${pick(random, QUALIFIERS)} ${pick(random, SUBJECTS)} ${pick(random, ATTRIBUTES)}`;
    while (topics.has(topic));
    topics.add(topic);
    let value: string;
    do value = String(10_000 + Math.floor(random() * 90_000));
    while (values.has(value));
    values.add(value);
    const index = Math.min(n - 1, Math.floor(j * slice + random() * slice));
    const keep = 1 + Math.floor(random() * MAX_KEEP);
    planted.set(index, { index, age: n - 1 - index, topic, value, keep });
  }
  const messages: Array<{ kind: Kind; text: string }> = [];
  for (let i = 0; i < n; i++) {
    const fact = planted.get(i);
    if (fact) {
      const sentences = [generic(random)];
      sentences.splice(Math.floor(random() * 2), 0, `Noting for later: ${statement(fact.topic, fact.value)}.`);
      messages.push({ kind: "user", text: padded(random, sentences) });
      continue;
    }
    const sentences = [generic(random)];
    if (random() < 0.5) {
      sentences.push(pick(random, NOISE_SENTENCES)(pick(random, QUALIFIERS), pick(random, SUBJECTS), pick(random, ATTRIBUTES)));
    }
    messages.push({ kind: i % 2 === 0 ? "user" : "talk", text: padded(random, sentences) });
  }
  return { messages, facts: [...planted.values()].sort((a, b) => a.index - b.index) };
}

/** The text between the first `open` and the following `close`, or "" when either is missing. */
function segment(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  if (start < 0) return "";
  const end = text.indexOf(close, start + open.length);
  return end < 0 ? "" : text.slice(start + open.length, end);
}

function render(topics: readonly string[], themes: readonly string[]): string {
  // Over the node budget, the earliest-listed topics go first; the themes are short and always fit.
  let kept = topics;
  let line = `topics: ${kept.join("; ") || "none"} | themes: ${themes.join(" ")} |`;
  while (utf8Bytes(line) > NODE_BYTES && kept.length > 0) {
    kept = kept.slice(1);
    line = `topics: ${kept.join("; ") || "none"} | themes: ${themes.join(" ")} |`;
  }
  const pad = SUMMARY_MIN_BYTES - utf8Bytes(line) - 1;
  return pad > 0 ? `${line} ${".".repeat(pad)}` : line;
}

/** The deterministic fake summariser described in SUMMARIZER_POLICY. */
export function fakeSummarizer(facts: readonly Fact[]): Summarize {
  const keepOf = new Map(facts.map((fact) => [fact.topic, fact.keep]));
  return async (request) => {
    const input = segment(request.instruction, "<input>\n", "\n</input>");
    if (/^Compaction: compress message \d+ /.test(request.instruction)) {
      let source = input;
      const topics: string[] = [];
      for (const fact of facts) {
        const stated = statement(fact.topic, fact.value);
        if (!source.includes(stated)) continue;
        topics.push(fact.topic);
        source = source.replace(stated, "");
      }
      const words = source.toLowerCase().match(/[a-z]+/g) ?? [];
      const themes = [...new Set(words.filter((word) => VOCABULARY.has(word)))].slice(0, THEMES);
      return render(topics, themes);
    }
    const merge = /^Compaction: merge lines \d+\+(\d+) and /.exec(request.instruction);
    if (!merge) throw new Error("synthetic summariser: unexpected compaction request");
    // The merged line covers twice the child width: level L = log2 of that width.
    const level = Math.log2(Number(merge[1])) + 1;
    const topics: string[] = [];
    const themeLists: string[][] = [];
    for (const child of input.split("\n")) {
      for (const topic of segment(child, "topics: ", " | themes:").split("; ")) {
        if ((keepOf.get(topic) ?? 0) >= level && !topics.includes(topic)) topics.push(topic);
      }
      themeLists.push(segment(child, "themes: ", " |").split(" ").filter((word) => word.length > 0));
    }
    const themes: string[] = [];
    for (let k = 0; themes.length < THEMES && themeLists.some((list) => k < list.length); k++) {
      for (const list of themeLists) {
        const word = list[k];
        if (word !== undefined && !themes.includes(word) && themes.length < THEMES) themes.push(word);
      }
    }
    return render(topics, themes);
  };
}

export interface SyntheticTree {
  readonly memory: Memory;
  readonly corpus: Corpus;
  close(): Promise<void>;
}

/**
 * A real Memory over a real Store in a fresh temp directory, fed one message at a time and settled after each, then
 * drained until no compaction is in flight. Throws when any node fails to build.
 */
export async function buildTree(config: TreeConfig): Promise<SyntheticTree> {
  const corpus = buildCorpus(config);
  const root = await mkdtemp(join(tmpdir(), "optchat-retrieval-"));
  let store: Store | undefined;
  let memory: Memory | undefined;
  const close = async (): Promise<void> => {
    try {
      await memory?.close();
      await store?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    store = await Store.open(join(root, "chat"));
    const reports: string[] = [];
    const built = new Memory(store, fakeSummarizer(corpus.facts), {
      nodeBytes: NODE_BYTES,
      viewBytes: VIEW_BYTES,
      report: (message) => {
        reports.push(message);
      },
    });
    memory = built;
    for (const [i, message] of corpus.messages.entries()) {
      built.append(message.kind, message.text, new Date(BASE_TIME + i * MINUTE_MS));
      if (!(await built.settle())) throw new Error(`synthetic tree stalled at message ${i}: ${reports.join("; ")}`);
    }
    while (built.status().pending > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    }
    if (reports.length > 0) throw new Error(`synthetic tree reported failures: ${reports.join("; ")}`);
    if (built.render().includes("(not summarized yet")) throw new Error("synthetic tree left unbuilt nodes");
    return { memory: built, corpus, close };
  } catch (error) {
    await close();
    throw error;
  }
}
