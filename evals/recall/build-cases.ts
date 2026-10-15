#!/usr/bin/env bun
/**
 * Builds the chat_recall eval's cases. Nothing here calls a model.
 *
 *   bun evals/recall/build-cases.ts synthetic           # cases/synthetic.jsonl from the seeded retrieval generator
 *   bun evals/recall/build-cases.ts mine [--limit N]    # drafting aid: distinctive single-occurrence tokens in real snapshots
 *   bun evals/recall/build-cases.ts real                # checks real-spec.json entries, writes cases/real.jsonl
 *
 * Synthetic gold is the planted message index. Real gold is a message index in a read-only snapshot under
 * SNAPSHOT_ROOT; every real entry must hold a token that occurs in exactly one message of its store (chat_search-style
 * whole-word match), must not appear in its question, and its gold message must be free of secret-like text. An
 * optional `also` lists other messages of the same store that answer the question as well, and they also count as correct;
 * `no` lists messages judged blind not to answer. Every real entry also carries an answer `key`, which grades an unjudged
 * answer by the first page recall returns and must match the gold and every `also` message but no `no` message.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildCorpus, MAX_KEEP } from "../../scripts/retrieval/synthetic.ts";
import { utf8Prefix } from "../../src/memory.ts";
import { RECALL_PAGE_BYTES } from "../../src/system1/recall.ts";
import { type AnswerKey, keyMatches } from "./grade.ts";

export const SNAPSHOT_ROOT = join(homedir(), ".cache", "omp-optchat-evals", "recall", "stores");
const HERE = dirname(new URL(import.meta.url).pathname);
export const CASES_DIR = join(HERE, "cases");

/** Synthetic generator settings: seeds 1..3 with 10 facts each, 256 messages. Keep in step with the case file. */
export const SYNTHETIC = { seeds: [1, 2, 3], n: 256, facts: 10 } as const;

/** Text that must never reach a case: keys, tokens, private-key blocks, seed phrases, emails, long hex. */
export const SECRET_LIKE =
  /(api[_-]?key|secret|token|passw|bearer|private[ _-]?key|seed phrase|mnemonic|-----BEGIN|sk-[A-Za-z0-9]|ghp_|github_pat|xox[bp]-|AKIA[0-9A-Z]{8}|@[A-Za-z0-9.-]+\.[a-z]{2,}|0x[0-9a-fA-F]{40}|[A-Za-z0-9+/_-]{40,}|\b[0-9a-fA-F]{32,}\b)/i;

export interface StoredMessage {
  readonly i: number;
  readonly kind: string;
  readonly text: string;
}

export interface SnapshotStore {
  readonly name: string;
  readonly messages: readonly StoredMessage[];
}

export interface CaseRecord {
  readonly id: string;
  readonly tags: readonly string[];
  readonly question: string;
  readonly gold: number;
  readonly store: Record<string, unknown>;
  readonly source: string;
  /** Build-time audit only; the runner never sends it to the judge. */
  readonly fact?: string;
  /** Other message indexes that also count as correct answers; real cases only. */
  readonly also?: readonly number[];
  /** Messages of the same store judged blind NOT to answer, partial answers included; real cases only. */
  readonly no?: readonly number[];
  /** Answer key grading an unjudged answer by the first page recall returns; real cases only. */
  readonly key?: AnswerKey;
}

/** Loads a snapshot's message log in store order, verifying the addresses are the contiguous 0..n-1. */
export async function loadSnapshot(name: string): Promise<SnapshotStore> {
  const main = join(SNAPSHOT_ROOT, name, "main");
  const messages: StoredMessage[] = [];
  for (const file of (await readdir(main)).sort()) {
    const text = await readFile(join(main, file), "utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const value = JSON.parse(line) as StoredMessage;
      if (value.i !== messages.length) throw new Error(`${name}: message ${value.i} is out of order at ${file}`);
      messages.push(value);
    }
  }
  return { name, messages };
}

const WHOLE = (term: string): RegExp => new RegExp(`(?<![A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![A-Za-z0-9])`, "i");

/** Distinctive-token candidates: digits, or an internal `-`, `_` or `.`. Long tokens are excluded as likely credentials. */
const TOKEN = /[A-Za-z0-9][A-Za-z0-9_.-]{4,39}/g;
const STRUCTURED = /\d|[A-Za-z][-_.][A-Za-z]/;

function tokensOf(text: string): string[] {
  return [...new Set(text.match(TOKEN) ?? [])].filter((token) => STRUCTURED.test(token) && !/[._-]$/.test(token));
}

/** Number of messages containing each token (whole word, case-insensitive), across every message kind. */
export function occurrences(store: SnapshotStore): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of store.messages) {
    for (const token of tokensOf(message.text)) {
      const key = token.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

async function mine(limit: number): Promise<void> {
  const names = (await readdir(SNAPSHOT_ROOT)).filter((name) => name !== "MANIFEST.sha256").sort();
  for (const name of names) {
    const store = await loadSnapshot(name);
    const counts = occurrences(store);
    let shown = 0;
    for (const message of store.messages) {
      if (shown >= limit) break;
      if (message.kind !== "user" && message.kind !== "talk") continue;
      if (SECRET_LIKE.test(message.text)) continue;
      for (const token of tokensOf(message.text)) {
        if (counts.get(token.toLowerCase()) !== 1) continue;
        const at = message.text.indexOf(token);
        const from = Math.max(0, at - 90);
        const snippet = message.text.slice(from, at + token.length + 90).replace(/\s+/g, " ");
        console.log(`${name} i=${message.i} ${message.kind} token=${token} | ${snippet}`);
        shown++;
        break;
      }
    }
  }
}

function syntheticCases(): CaseRecord[] {
  const cases: CaseRecord[] = [];
  for (const seed of SYNTHETIC.seeds) {
    const corpus = buildCorpus({ seed, n: SYNTHETIC.n, facts: SYNTHETIC.facts });
    for (const [k, fact] of corpus.facts.entries()) {
      const stratum = fact.age < 64 ? "recent" : "old";
      cases.push({
        id: `syn-s${seed}-${String(k).padStart(2, "0")}`,
        tags: ["synthetic", stratum],
        question: `What is the ${fact.topic}?`,
        gold: fact.index,
        store: { kind: "synthetic", seed, n: SYNTHETIC.n, facts: SYNTHETIC.facts },
        source: `retrieval generator seed ${seed}: planted fact at message ${fact.index} (age ${fact.age}, keep ${fact.keep}/${MAX_KEEP})`,
      });
    }
  }
  return cases;
}

interface RealSpec {
  readonly id: string;
  readonly store: string;
  readonly gold: number;
  readonly fact: string;
  readonly question: string;
  readonly difficulty: "easy" | "hard";
  /** The leaf summary paraphrases the fact, so only a semantic match can reach it (see the coverage diagnostic). */
  readonly paraphrase?: boolean;
  /** Other messages in the same store that answer the question as well as the gold, from a blind assessment of pooled candidates. */
  readonly also?: readonly number[];
  /** Messages in the same store judged blind NOT to answer the question, partial answers included. */
  readonly no?: readonly number[];
  /** Answer alternatives; an alternative matches when all its phrases occur in the page recall returned, ignoring case and whitespace. */
  readonly key: AnswerKey;
  readonly note: string;
}

/** The text recall returns for a message: the first RECALL_PAGE_BYTES UTF-8 bytes of its original text (`memory.page(id)` adds no envelope to `text`). */
export function firstPage(text: string): string {
  return utf8Prefix(text, RECALL_PAGE_BYTES);
}

/** Validates each spec entry against its snapshot and returns the case record. Throws on the first violation. */
export async function realCases(specs: readonly RealSpec[]): Promise<CaseRecord[]> {
  const stores = new Map<string, SnapshotStore>();
  const cases: CaseRecord[] = [];
  for (const spec of specs) {
    const store = stores.get(spec.store) ?? (await loadSnapshot(spec.store));
    stores.set(spec.store, store);
    const at = store.messages[spec.gold];
    if (!at) throw new Error(`${spec.id}: no message ${spec.gold} in ${spec.store}`);
    if (SECRET_LIKE.test(at.text) || SECRET_LIKE.test(spec.question)) throw new Error(`${spec.id}: secret-like text`);
    if (!WHOLE(spec.fact).test(at.text)) throw new Error(`${spec.id}: fact "${spec.fact}" is not in message ${spec.gold}`);
    const holders = store.messages.filter((message) => WHOLE(spec.fact).test(message.text)).length;
    if (holders !== 1) throw new Error(`${spec.id}: fact "${spec.fact}" appears in ${holders} messages, need exactly 1`);
    if (spec.question.toLowerCase().includes(spec.fact.toLowerCase())) throw new Error(`${spec.id}: question contains the fact`);
    const also = [...(spec.also ?? [])];
    for (const id of also) {
      if (!Number.isSafeInteger(id) || !store.messages[id]) throw new Error(`${spec.id}: also ${id} is not a message in ${spec.store}`);
      if (id === spec.gold) throw new Error(`${spec.id}: also contains the gold ${id}`);
    }
    if (new Set(also).size !== also.length) throw new Error(`${spec.id}: also has duplicates`);
    also.sort((a, b) => a - b);
    const no = [...(spec.no ?? [])];
    for (const id of no) {
      if (!Number.isSafeInteger(id) || !store.messages[id]) throw new Error(`${spec.id}: no ${id} is not a message in ${spec.store}`);
      if (id === spec.gold) throw new Error(`${spec.id}: no contains the gold ${id}`);
      if (also.includes(id)) throw new Error(`${spec.id}: no ${id} is also in also`);
    }
    if (new Set(no).size !== no.length) throw new Error(`${spec.id}: no has duplicates`);
    no.sort((a, b) => a - b);
    const key = spec.key;
    if (!Array.isArray(key) || key.length === 0) throw new Error(`${spec.id}: key must be a non-empty array of alternatives`);
    for (const alternative of key) {
      if (!Array.isArray(alternative) || alternative.length === 0) throw new Error(`${spec.id}: key alternative must be a non-empty array of phrases`);
      for (const phrase of alternative) {
        if (typeof phrase !== "string" || phrase.trim().length < 3 || /^[\d\s.,:/-]*$/.test(phrase.trim())) {
          throw new Error(`${spec.id}: key phrase ${JSON.stringify(phrase)} must be at least 3 characters and not only digits and punctuation`);
        }
      }
    }
    for (const id of [spec.gold, ...also]) {
      if (!keyMatches(firstPage(store.messages[id]!.text), key)) throw new Error(`${spec.id}: key does not match message ${id}`);
    }
    for (const id of no) {
      if (keyMatches(firstPage(store.messages[id]!.text), key)) throw new Error(`${spec.id}: key matches no message ${id}`);
    }
    cases.push({
      id: spec.id,
      tags: ["real", spec.difficulty, ...(spec.paraphrase === true ? ["paraphrase"] : [])],
      question: spec.question,
      gold: spec.gold,
      store: { kind: "snapshot", name: spec.store },
      source: spec.note,
      fact: spec.fact,
      ...(also.length > 0 ? { also } : {}),
      ...(no.length > 0 ? { no } : {}),
      key,
    });
  }
  return cases;
}

async function writeJsonl(file: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "synthetic") {
    const cases = syntheticCases();
    await writeJsonl(join(CASES_DIR, "synthetic.jsonl"), cases);
    console.log(`wrote ${cases.length} synthetic cases`);
  } else if (command === "mine") {
    const flag = rest.indexOf("--limit");
    await mine(flag >= 0 ? Number(rest[flag + 1]) : 15);
  } else if (command === "real") {
    const specs = JSON.parse(await readFile(join(HERE, "real-spec.json"), "utf8")) as RealSpec[];
    const cases = await realCases(specs);
    await writeJsonl(join(CASES_DIR, "real.jsonl"), cases);
    console.log(`wrote ${cases.length} real cases`);
  } else {
    throw new Error("usage: build-cases.ts synthetic | mine [--limit N] | real");
  }
}

if (import.meta.main) await main(process.argv.slice(2));
