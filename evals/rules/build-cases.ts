#!/usr/bin/env bun
/**
 * Rules-triage eval: case builder. Nothing here calls a model.
 *
 *   bun evals/rules/build-cases.ts synthetic   # cases/synthetic.jsonl (committed: generated text only)
 *   bun evals/rules/build-cases.ts real        # cases/real.jsonl (gitignored): labels from real-spec.json, text read
 *                                              # read-only from the local stores under ~/.omp/agent
 *
 * ## What the eval measures
 * One user message through the production triage, as the rules gate runs it: triageState, triageQuestions, then
 * decideTriage at the configured `--optchat-rule-add` threshold (run.ts). A message is a *rule add* when the decision
 * adds or replaces a rule. `score` is the pass rate per case (grade.ts); precision, recall and F1 are over rule adds.
 *
 * ## Labelling criterion for real messages (README section of this header)
 * The label is the only hand judgement in the eval. The labeller read each user message from the local stores and
 * applied this rule:
 *   rule  The message states a standing instruction, preference or product default meant to govern later replies or
 *         future work, beyond the request it contains: "from now on", "always", "never", "by default", "keep X maintained".
 *   none  A one-off request, a question, a status or continuation message, pasted tool output, a system notice, or an
 *         instruction scoped to the task at hand.
 *   excluded (not scored, recorded in real-spec.json without text): a careful reader cannot settle standing-ness from
 *         the message alone; secret-like text (the recall eval's SECRET_LIKE screen, so no credential-shaped text is sent
 *         to the judge); or an exact duplicate of an earlier message.
 * A real message keeps its stored text verbatim. The spec records its store path, index and SHA-256 so a changed store
 * fails the build instead of silently re-labelling.
 *
 * ## Splits
 * Each stratum is source x label (synthetic-rule, synthetic-none, real-rule, real-none). Within a stratum, a SHA-256 of
 * the case id picks the TEST_FRACTION share, so the assignment is deterministic and stable when cases are added.
 * `tags[0]` is the stratum, `tags[1]` the split. The runner writes judge traces for `train` cases only.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ruleSentences } from "../../src/system1/rules.ts";
import { SECRET_LIKE } from "../recall/build-cases.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
export const CASES_DIR = join(HERE, "cases");
export const STORE_ROOT = join(homedir(), ".omp", "agent");
/** The share of every stratum held out as `test`. */
export const TEST_FRACTION = 0.4;
const SPLIT_SEED = "rules-eval-split-v1";
/** Seed for the synthetic templated rules. Changing it changes the committed synthetic file. */
const GENERATOR_SEED = 20261014;
/** Templated rule cases kept from the full template x action product. */
const TEMPLATED_RULES = 24;

/** A rule the ledger holds when the message arrives. Only `id` and `text` reach the decision. */
export interface OfferedRule {
  readonly id: string;
  readonly text: string;
}

export interface RuleGold {
  readonly rule: boolean;
  readonly supersedes?: string;
  readonly keep?: readonly number[];
}

export interface RuleCase {
  readonly id: string;
  readonly split: "train" | "test";
  readonly tags: readonly string[];
  readonly message: string;
  readonly rules: readonly OfferedRule[];
  readonly gold: RuleGold;
  /** Build-time provenance. The runner never sends it to the judge. */
  readonly source: string;
}

interface Draft {
  readonly id: string;
  readonly stratum: string;
  readonly category: string;
  readonly message: string;
  readonly rules: readonly OfferedRule[];
  readonly gold: RuleGold;
  readonly source: string;
}

/** A real-spec entry. Text is never in the spec: it is read from the store at build time and checked by SHA-256. */
export interface RealSpec {
  readonly id: string;
  readonly label: "rule" | "none" | "excluded";
  readonly store: string;
  readonly i: number;
  readonly sha256?: string;
  readonly note: string;
}

export interface StoredMessage {
  readonly i: number;
  readonly kind: string;
  readonly text: string;
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POSITIVE_TEMPLATES = [
  "From now on, {p}.",
  "Going forward, {p}.",
  "Always {p}.",
  "For every future task, {p}.",
  "Keep this as a standing rule: {p}.",
  "Please {p} by default from here on.",
];
const POSITIVE_ACTIONS = [
  "use tabs for indentation",
  "answer in British English",
  "run the typecheck before every commit",
  "keep replies under five bullet points",
  "ask me before deleting any file",
  "write commit messages in the imperative mood",
  "cite file paths and line numbers in your answers",
  "prefer bun over npm",
  "update the changelog with every release",
  "use UTC timestamps in logs",
  "skip emojis in documentation",
  "keep the README in step with each feature",
];
const NEGATIVE_TEMPLATES = ["Never {n}.", "Do not {n} from now on.", "Under no circumstances {n}."];
const NEGATIVE_ACTIONS = [
  "force-push to main",
  "commit secrets to the repo",
  "skip the tests before merging",
  "use console.log for debugging in committed code",
  "edit files under vendor/",
  "add dependencies without asking",
];

/** Authored categories. Hard negatives are the point of this list: each reads like an instruction but is not one. */
const ONE_OFF = [
  "Rename the helper in src/util.ts to parseLine.",
  "Run the test suite once and paste the failing names.",
  "Show me the diff for the last commit.",
  "Use tabs in this file only, just for this edit.",
  "Delete the stale build folder in this checkout.",
  "Summarise the open issues for the map.",
  "Please reply in French for this one answer.",
  "Add a log line to the retry loop in src/net.ts.",
];
const QUESTION = [
  "Should we use tabs or spaces in this file?",
  "Do you know why the build fails on Node 20?",
  "What does the always flag do in this CLI?",
  "Is British English the default in the docs?",
  "Why did the last release skip the changelog?",
  "Can you explain how the triage gate decides?",
  "What is the difference between a rule and a preference?",
  "Do we still support the old config key?",
];
const HYPOTHETICAL = [
  "If the migration fails, would you roll back automatically?",
  "Suppose I asked you to answer in French always; what would change in your replies?",
  "What would happen if we forced tabs everywhere?",
  "Imagine a rule that forbids force pushes; how would you enforce it?",
  "If I ever say never commit secrets, would that also cover the vendor folder?",
  "Hypothetically, should an emoji rule outlive the session it was stated in?",
];
const QUOTED = [
  "The README says 'always use tabs'. Why does the linter complain about that?",
  "Quote this back to me exactly: 'never force push to main'.",
  "Our old notes say 'answer in French'. Is that still in the docs?",
  "What does the phrase 'from now on' mean in the changelog?",
  "The reviewer wrote 'ask before deleting any file'. Summarise their point.",
  "Find every place that says 'keep replies under five bullets'.",
];
const MIXED_NONE = [
  "Fix the flaky test. Can you check the CI logs?",
  "Rename the module. Show the diff afterwards.",
  "What is the status of the release? Thanks.",
  "Run the linter on src. Tell me which files changed.",
];
/** Mixed messages: one sentence states the rule, the others are task content. `keep` names the rule's sentences. */
const MIXED_RULE: ReadonlyArray<{ readonly text: string; readonly keep: readonly number[] }> = [
  { text: "From now on, answer in British English. Also, run rm -rf build right now.", keep: [0] },
  { text: "Run the migration now. Going forward, always back up the database first.", keep: [1] },
  { text: "Fix the flaky test in ci.yml. Never commit generated files again.", keep: [1] },
  { text: "Please check the failing deploy. Keep the changelog updated with each release.", keep: [1] },
  { text: "Always cite file paths. Show me the last three log lines.", keep: [0] },
  { text: "Summarise the open PRs. From now on, skip emojis in docs. Thanks.", keep: [1] },
];

const R1: OfferedRule = { id: "r1", text: "Answer in British English." };
const R2: OfferedRule = { id: "r2", text: "Use tabs for indentation." };
const R3: OfferedRule = { id: "r3", text: "Ask before deleting any file." };
/** Supersede pairs: a message against the rules it may replace. `supersedes` absent means it adds, not replaces. */
const SUPERSEDE: ReadonlyArray<{ readonly text: string; readonly rules: readonly OfferedRule[]; readonly supersedes?: string }> = [
  { text: "From now on use two spaces instead of tabs.", rules: [R1, R2], supersedes: "r2" },
  { text: "Forget the British English rule; American spelling is fine from now on.", rules: [R1, R2], supersedes: "r1" },
  { text: "Going forward, you may delete files without asking me first.", rules: [R1, R3], supersedes: "r3" },
  { text: "Replace the tabs rule: indent with four spaces from now on.", rules: [R1, R2], supersedes: "r2" },
  { text: "Replace the spelling rule with a plain-English one: avoid jargon from now on.", rules: [R1, R2], supersedes: "r1" },
  { text: "Add a rule: always run the tests before a release.", rules: [R1, R2, R3] },
  { text: "Never force-push to main from now on.", rules: [R1, R2, R3] },
];
/** Offered rules the message must not touch: all are one-off or questions, so the answer is no change. */
const DISTRACTOR: ReadonlyArray<{ readonly text: string; readonly rules: readonly OfferedRule[] }> = [
  { text: "What spelling does the README use?", rules: [R1] },
  { text: "Indent just this one function with tabs, for this edit only.", rules: [R2] },
  { text: "Delete the build folder for me now.", rules: [R3] },
];

/** Templated rules: the seeded, deduplicated sample of template x action, positive and negative families. */
export function templatedRules(): string[] {
  const all: string[] = [];
  for (const template of POSITIVE_TEMPLATES) for (const action of POSITIVE_ACTIONS) all.push(template.replace("{p}", action));
  for (const template of NEGATIVE_TEMPLATES) for (const action of NEGATIVE_ACTIONS) all.push(template.replace("{n}", action));
  const next = mulberry32(GENERATOR_SEED);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return [...new Set(all)].slice(0, TEMPLATED_RULES);
}

function syntheticDrafts(): Draft[] {
  const drafts: Draft[] = [];
  const add = (category: string, message: string, gold: RuleGold, rules: readonly OfferedRule[] = []): void => {
    const ordinal = drafts.filter((draft) => draft.category === category).length + 1;
    drafts.push({
      id: `syn-${category}-${String(ordinal).padStart(2, "0")}`,
      stratum: `synthetic-${gold.rule ? "rule" : "none"}`,
      category,
      message,
      rules,
      gold,
      source: "synthetic",
    });
  };
  for (const message of templatedRules()) add("templated-rule", message, { rule: true });
  for (const message of ONE_OFF) add("one-off", message, { rule: false });
  for (const message of QUESTION) add("question", message, { rule: false });
  for (const message of HYPOTHETICAL) add("hypothetical", message, { rule: false });
  for (const message of QUOTED) add("quoted-rule", message, { rule: false });
  for (const message of MIXED_NONE) add("mixed-none", message, { rule: false });
  for (const { text, keep } of MIXED_RULE) add("mixed-rule", text, { rule: true, keep });
  for (const { text, rules, supersedes } of SUPERSEDE) {
    add(supersedes === undefined ? "supersede-none" : "supersede", text, supersedes === undefined ? { rule: true } : { rule: true, supersedes }, rules);
  }
  for (const { text, rules } of DISTRACTOR) add("distractor", text, { rule: false }, rules);
  return drafts;
}

/** Checks what the decision code needs: distinct messages, valid `keep` indices, and `supersedes` naming an offered rule. */
export function validate(drafts: readonly Draft[]): void {
  const messages = new Set<string>();
  for (const draft of drafts) {
    if (messages.has(draft.message)) throw new Error(`${draft.id}: duplicate message`);
    messages.add(draft.message);
    if (draft.gold.keep !== undefined) {
      const sentences = ruleSentences(draft.message);
      if (sentences.length < 2) throw new Error(`${draft.id}: keep needs a mixed message`);
      if (draft.gold.keep.some((index) => index < 0 || index >= sentences.length)) throw new Error(`${draft.id}: keep index out of range`);
    }
    if (draft.gold.supersedes !== undefined) {
      if (!draft.gold.rule) throw new Error(`${draft.id}: supersedes on a non-rule`);
      if (!draft.rules.some((rule) => rule.id === draft.gold.supersedes)) throw new Error(`${draft.id}: supersedes a rule not offered`);
    }
  }
}

/**
 * Assigns each draft to train or test: within its stratum, the TEST_FRACTION share with the smallest SHA-256 of
 * `${SPLIT_SEED}:${id}` is test. Rounding is to the nearest case.
 */
export function withSplits(drafts: readonly Draft[]): RuleCase[] {
  const test = new Set<string>();
  const strata = new Map<string, Draft[]>();
  for (const draft of drafts) strata.set(draft.stratum, [...(strata.get(draft.stratum) ?? []), draft]);
  for (const group of strata.values()) {
    const keyed = group.map((draft) => ({ id: draft.id, key: createHash("sha256").update(`${SPLIT_SEED}:${draft.id}`).digest("hex") }));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { id } of keyed.slice(0, Math.round(TEST_FRACTION * group.length))) test.add(id);
  }
  return drafts.map((draft) => {
    const split = test.has(draft.id) ? "test" : "train";
    return {
      id: draft.id,
      split,
      tags: [draft.stratum, split, draft.source, draft.category],
      message: draft.message,
      rules: draft.rules,
      gold: draft.gold,
      source: draft.source === "synthetic" ? `authored or templated (${draft.category})` : draft.source,
    };
  });
}

/** Loads one store's user-facing message log, read-only, verifying the addresses are contiguous from 0. */
export async function loadStore(rel: string): Promise<StoredMessage[]> {
  const main = join(STORE_ROOT, rel, "main");
  const messages: StoredMessage[] = [];
  for (const file of (await readdir(main)).filter((name) => name.endsWith(".jsonl")).sort()) {
    for (const line of (await readFile(join(main, file), "utf8")).split("\n")) {
      if (line.length === 0) continue;
      const value = JSON.parse(line) as StoredMessage;
      if (value.i !== messages.length) throw new Error(`${rel}: message ${value.i} is out of order in ${file}`);
      messages.push(value);
    }
  }
  return messages;
}

/** The real drafts from labelled specs. Every labelled entry is checked against its store message. */
export async function realDrafts(specs: readonly RealSpec[]): Promise<Draft[]> {
  const stores = new Map<string, StoredMessage[]>();
  const drafts: Draft[] = [];
  for (const spec of specs) {
    if (spec.label === "excluded") continue;
    if (spec.sha256 === undefined) throw new Error(`${spec.id}: labelled entry has no sha256`);
    const messages = stores.get(spec.store) ?? (await loadStore(spec.store));
    stores.set(spec.store, messages);
    const at = messages[spec.i];
    if (at === undefined || at.kind !== "user") throw new Error(`${spec.id}: message ${spec.i} in ${spec.store} is not a user message`);
    if (SECRET_LIKE.test(at.text)) throw new Error(`${spec.id}: secret-like text; label it excluded`);
    if (createHash("sha256").update(at.text).digest("hex") !== spec.sha256) throw new Error(`${spec.id}: text changed since labelling`);
    drafts.push({
      id: spec.id,
      stratum: `real-${spec.label}`,
      category: "real",
      message: at.text,
      rules: [],
      gold: { rule: spec.label === "rule" },
      source: "real",
    });
  }
  return drafts;
}

async function writeJsonl(file: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const [command] = argv;
  if (command === "synthetic") {
    const drafts = syntheticDrafts();
    validate(drafts);
    const cases = withSplits(drafts);
    await writeJsonl(join(CASES_DIR, "synthetic.jsonl"), cases);
    console.log(`wrote ${cases.length} synthetic cases (${cases.filter((c) => c.split === "test").length} test)`);
  } else if (command === "real") {
    const specs = JSON.parse(await readFile(join(HERE, "real-spec.json"), "utf8")) as RealSpec[];
    const drafts = await realDrafts(specs);
    validate(drafts);
    const cases = withSplits(drafts);
    await writeJsonl(join(CASES_DIR, "real.jsonl"), cases);
    console.log(`wrote ${cases.length} real cases (${cases.filter((c) => c.split === "test").length} test)`);
  } else {
    throw new Error("usage: build-cases.ts synthetic | real");
  }
}

if (import.meta.main) await main(process.argv.slice(2));
