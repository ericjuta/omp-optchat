#!/usr/bin/env bun
/**
 * Frozen synthetic cases for the evidence eval (Milestone 4 of plans/evidence-layer.md). Seeded and deterministic: the
 * same seed writes byte-identical cases. No real chat text. Each case is one short chat plus a question; answerable
 * cases name the message ids that hold the answer and the exact answer words, and abstain cases (absent, ambiguous,
 * cut-off report) expect no answer.
 *
 *   bun evals/evidence/build-cases.ts [--seed 20261107] [--out evals/evidence/cases/synthetic-20261107.jsonl]
 */
import { writeFile } from "node:fs/promises";
import type { Kind } from "../../src/store.ts";
import { prng } from "../../scripts/retrieval/synthetic.ts";

export type Category = "deep" | "unicode" | "superseded" | "absent" | "ambiguous" | "incomplete";

export interface EvidenceCase {
  readonly id: string;
  readonly category: Category;
  readonly messages: ReadonlyArray<{ readonly kind: Kind; readonly text: string }>;
  readonly question: string;
  /** Null: the chat does not settle the question, and the right behaviour is to say so. */
  readonly gold: { readonly ids: readonly number[]; readonly answer: string } | null;
}

const QUALIFIERS = ["staging", "production", "backup", "billing", "search", "mobile", "analytics", "legacy"];
const SUBJECTS = ["database", "cache", "queue", "gateway", "scheduler", "proxy", "bucket", "cluster"];
const ATTRIBUTES = ["port", "timeout", "region", "release tag", "owner", "shard key"];
const FILLER = [
  (w: string) => `We spent a while on the ${w} again and agreed to keep things simple for now.`,
  (w: string) => `Someone asked whether the ${w} work could wait until after the next planning meeting.`,
  (w: string) => `The ${w} thread drifted into a long tangent about naming and folder layout.`,
  (w: string) => `Reminder to write down the ${w} decision somewhere the whole team can find it.`,
  (w: string) => `Nobody objected to the ${w} proposal, though a few people wanted more examples first.`,
];
const WORDS = ["lunch", "standup", "parser", "onboarding", "invoice", "hiring", "refactor", "docs", "retro", "roadmap", "linting", "fonts"];
const KINDS: readonly Kind[] = ["user", "talk", "tool", "echo"];
const UNICODE_PREFIXES = ["✅ café rollout 🚀 naïve check passed —", "🎉 déjà vu: résumé of the Zürich run 🔥", "⚠️ 東京 mirror lag noted 📦", "🧪 coöperative test über pass ✨"];

function generate(seed: number): EvidenceCase[] {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const value = (attribute: string): string => {
    const n = 1000 + Math.floor(random() * 9000);
    if (attribute === "port") return String(n);
    if (attribute === "timeout") return `${n} ms`;
    if (attribute === "region") return pick(["eu-west-3", "ap-south-2", "us-east-7", "sa-east-4"]) + `-${n % 97}`;
    if (attribute === "release tag") return `v${n % 9}.${n % 13}.${n % 7}-rc${n % 5}`;
    if (attribute === "owner") return pick(["Ines Okafor", "Tomasz Rey", "Priya Lund", "Mateo Sato"]);
    return `tenant_${n}_${n % 31}`;
  };
  const filler = (count: number): string => Array.from({ length: count }, () => pick(FILLER)(pick(WORDS))).join(" ");
  const chat = (length: number): Array<{ kind: Kind; text: string }> =>
    Array.from({ length }, (_, i) => ({ kind: KINDS[i % KINDS.length]!, text: filler(2 + Math.floor(random() * 3)) }));
  const used = new Set<string>();
  const topic = (): { topic: string; attribute: string } => {
    for (;;) {
      const attribute = pick(ATTRIBUTES);
      const t = `${pick(QUALIFIERS)} ${pick(SUBJECTS)} ${attribute}`;
      if (!used.has(t)) {
        used.add(t);
        return { topic: t, attribute };
      }
    }
  };
  const cases: EvidenceCase[] = [];
  const add = (category: Category, n: number, build: (i: number) => Omit<EvidenceCase, "id" | "category">) => {
    for (let i = 0; i < n; i++) cases.push({ id: `${category}-${String(i + 1).padStart(2, "0")}`, category, ...build(i) });
  };

  add("deep", 8, () => {
    const { topic: t, attribute } = topic();
    const answer = value(attribute);
    const messages = chat(10);
    const at = 3 + Math.floor(random() * 6);
    const before = filler(60 + Math.floor(random() * 120));
    messages[at] = { kind: "echo", text: `${before}\nAfter checking the config: the ${t} is ${answer}.\n${filler(30)}` };
    return { messages, question: `What is the ${t}?`, gold: { ids: [at], answer } };
  });
  add("unicode", 8, (i) => {
    const { topic: t, attribute } = topic();
    const answer = value(attribute);
    const messages = chat(10);
    const at = 2 + Math.floor(random() * 7);
    messages[at] = { kind: "talk", text: `${UNICODE_PREFIXES[i % UNICODE_PREFIXES.length]} ${filler(3)} ${"🙂".repeat(1 + (i % 5))} the ${t} is ${answer}. ${filler(2)}` };
    return { messages, question: `What is the ${t}?`, gold: { ids: [at], answer } };
  });
  add("superseded", 8, () => {
    const { topic: t, attribute } = topic();
    const old = value(attribute);
    let answer = value(attribute);
    while (answer === old) answer = value(attribute);
    const messages = chat(12);
    const first = 1 + Math.floor(random() * 4);
    const second = 7 + Math.floor(random() * 4);
    messages[first] = { kind: "talk", text: `${filler(2)} For now the ${t} is ${old}. ${filler(1)}` };
    messages[second] = { kind: "user", text: `Correction, this replaces the earlier value: the ${t} is now ${answer}. ${filler(1)}` };
    return { messages, question: `What is the current ${t}, after any correction?`, gold: { ids: [second], answer } };
  });
  add("absent", 8, () => {
    const { topic: t } = topic();
    const messages = chat(10);
    const at = 2 + Math.floor(random() * 7);
    messages[at] = { kind: "user", text: `${filler(2)} We still have to choose the ${t}; nobody has decided it yet. ${filler(1)}` };
    return { messages, question: `What is the ${t}?`, gold: null };
  });
  add("ambiguous", 4, () => {
    const { topic: t, attribute } = topic();
    const a = value(attribute);
    let b = value(attribute);
    while (b === a) b = value(attribute);
    const messages = chat(10);
    messages[3] = { kind: "talk", text: `${filler(1)} One proposal says the ${t} should be ${a}. ${filler(1)}` };
    messages[6] = { kind: "talk", text: `${filler(1)} Another proposal says the ${t} should be ${b}; it was left undecided. ${filler(1)}` };
    return { messages, question: `Which ${t} was decided?`, gold: null };
  });
  add("incomplete", 4, () => {
    const { topic: t } = topic();
    const messages = chat(10);
    const at = 2 + Math.floor(random() * 7);
    messages[at] = { kind: "work", text: `[incomplete: report capture stopped early]\n${filler(4)} Checked the ${t}. The final value of the ${t} is` };
    return { messages, question: `What is the final value of the ${t}?`, gold: null };
  });
  return cases;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? fallback : args[at + 1]!;
  };
  const seed = Number(flag("seed", "20261107"));
  const out = flag("out", `evals/evidence/cases/synthetic-${seed}.jsonl`);
  const cases = generate(seed);
  await writeFile(out, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`${cases.length} cases -> ${out}`);
}

export { generate };
