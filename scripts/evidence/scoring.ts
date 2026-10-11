import type { Question } from "./corpus.ts";

/** One retrieved record exactly as the memory tools returned its original text. Summaries never qualify. */
export interface RetrievedPage {
	readonly recordId: number;
	readonly text: string;
}

export interface Citation {
	readonly recordId: number;
	readonly quote: string;
}

/** One entry of the strict final answer: `{answers:[{id,value,uncertain,citations}]}`. */
export interface StructuredAnswer {
	readonly id: string;
	readonly value: string | null;
	readonly uncertain: boolean;
	readonly citations: readonly Citation[];
}

export type ParsedAnswers = { readonly ok: true; readonly answers: ReadonlyMap<string, StructuredAnswer> } | { readonly ok: false; readonly errors: readonly string[] };

/**
 * `correct`: the answer is right and grounded. `abstained`: the answer is marked uncertain on a
 * question with one definite answer, which earns no credit but is not an assertion. `incorrect`:
 * a missing, ungrounded, or incomplete answer. `hallucinated`: an asserted wrong, forbidden, invented,
 * or fabricated value.
 */
export type Outcome = "correct" | "abstained" | "incorrect" | "hallucinated";

export type Failure =
	| "schema"
	| "no-answer"
	| "ungrounded"
	| "wrong-value"
	| "forbidden-value"
	| "fabricated-id"
	| "fabricated-citation"
	| "ambiguous-confident"
	| "ambiguous-incomplete"
	| "unanswerable-asserted";

export interface Judgement {
	readonly questionId: string;
	readonly outcome: Outcome;
	readonly failure: Failure | null;
	/** The value is right, independent of its citations: the value rules passed. An abstention is a value only on an unanswerable question. */
	readonly valueCorrect: boolean;
	/** Answer marked uncertain by the model; reported separately from correctness. */
	readonly uncertain: boolean;
	/** Counted as abstained: the `abstained` outcome, or a correct abstention on an unanswerable question (which also counts as correct). */
	readonly abstained: boolean;
	/** Ambiguous questions: every source was cited with supporting original text. Otherwise: at least one source was. */
	readonly grounded: boolean;
	readonly assertedForbidden: readonly string[];
	/** Citations whose quote is in neither the retrieved original page of the cited record nor the saved view. */
	readonly fabricatedCitations: number;
	readonly fabricatedIds: readonly string[];
}

export interface ScoreInput {
	readonly questions: readonly Question[];
	/** Raw final assistant text; must contain exactly one fenced json block holding the object described by `answerInstruction`. */
	readonly raw: string;
	readonly pages: readonly RetrievedPage[];
	readonly knownIds: ReadonlySet<string>;
	/** Saved view text: a quote found only here is real memory text, though not a retrieved original. On arm only. */
	readonly viewText?: string;
	/** Which arm produced the answer. `on` (default) grounds quotes in retrieved originals; `off` grounds them in the seeded history. */
	readonly arm?: "on" | "off";
	/** Off arm only, required there: recordId (as a string) → exact text of that record as seeded into the history. */
	readonly seededRecords?: ReadonlyMap<string, string>;
}

export interface AnswerSetScore {
	readonly schemaValid: boolean;
	readonly schemaErrors: readonly string[];
	readonly judgements: readonly Judgement[];
	readonly totals: {
		readonly questions: number;
		readonly correct: number;
		readonly abstained: number;
		readonly incorrect: number;
		readonly hallucinated: number;
	};
}

export interface ArmTotals {
	readonly judged: number;
	readonly correct: number;
	readonly valueCorrect: number;
	readonly grounded: number;
	readonly abstained: number;
	readonly hallucinated: number;
	readonly incorrectSchema: number;
}

const ANSWER_KEYS = ["id", "value", "uncertain", "citations"] as const;
/** Explicit abstention values for unanswerable questions, matched against the normalized value by prefix. */
const ABSTENTION_VALUES = ["not stated", "not specified", "unknown", "not in the records", "no record"] as const;
const CITATION_KEYS = ["recordId", "quote"] as const;
const ID_TOKEN = /\bZX-\d{4}-[A-Z]\b/g;
/** A negation or supersession cue directly before a value (within two words). */
const NEG_BEFORE = /(?:\b(?:not|never|formerly|previously|former|superseded|replaced|from|rather than|instead of|no longer)|n't)\s+(?:[A-Za-z]+\s+){0,2}$/i;
/** A negation or supersession cue directly after a value. */
const NEG_AFTER = /^\s+(?:(?:is|was|has|had|been|being)\s+)*(?:no longer|superseded|replaced|not|former)\b/i;
const CLAUSE_BREAK = /[.;,!?\n]|\bbut\b|\bhowever\b/i;

export function isRecord(node: unknown): node is Record<string, unknown> {
	return typeof node === "object" && node !== null && !Array.isArray(node);
}

function hasExactKeys(node: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(node).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Value match on token boundaries, so "Ben" does not match "Benjamin" and "ZX-1234-B" does not match "ZX-1234-BX". */
function valueRegex(value: string, flags: string): RegExp {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, flags);
}

function mentions(text: string, value: string): boolean {
	return valueRegex(value, "").test(text);
}

/** True when some occurrence of `value` in the clause is not marked as rejected or superseded. */
function assertsValue(clause: string, value: string): boolean {
	for (const match of clause.matchAll(valueRegex(value, "g"))) {
		const index = match.index ?? 0;
		const before = clause.slice(0, index);
		const after = clause.slice(index + match[0].length);
		if (!NEG_BEFORE.test(before) && !NEG_AFTER.test(after)) return true;
	}
	return false;
}

/**
 * Forbidden values an answer asserts. The answer is split into clauses at punctuation and contrast
 * words, so "Ben owns Lumen, not Ada" rejects Ada while "Ada owns Lumen" asserts it.
 */
export function assertedForbidden(answer: string, forbidden: readonly string[]): string[] {
	const clauses = answer.split(CLAUSE_BREAK);
	return forbidden.filter((value) => clauses.some((clause) => assertsValue(clause, value)));
}

/**
 * The body of the reply's one fenced JSON block, wherever it sits among prose. Zero blocks or two or more
 * is null: that reply is a schema failure, never repaired.
 */
export function extractAnswerBlock(raw: string): string | null {
	const blocks = [...raw.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/g)];
	return blocks.length === 1 ? blocks[0]![1]! : null;
}

/** Strict parse of the final answer. Any deviation from the schema is an error; the only accepted wrapper is one fenced block. */
export function parseAnswerSet(raw: string, questionIds: readonly string[]): ParsedAnswers {
	let parsed: unknown;
	const block = extractAnswerBlock(raw);
	if (block === null) return { ok: false, errors: ["final reply must contain exactly one fenced json block"] };
	try {
		parsed = JSON.parse(block);
	} catch {
		return { ok: false, errors: ["answer is not valid JSON"] };
	}
	if (!isRecord(parsed) || !hasExactKeys(parsed, ["answers"])) return { ok: false, errors: ["top level must be exactly {answers}"] };
	const list = parsed.answers;
	if (!Array.isArray(list)) return { ok: false, errors: ["answers must be an array"] };

	const selected = new Set(questionIds);
	const answers = new Map<string, StructuredAnswer>();
	const errors: string[] = [];
	list.forEach((entry: unknown, index: number) => {
		const at = `answers[${index}]`;
		if (!isRecord(entry) || !hasExactKeys(entry, ANSWER_KEYS)) {
			errors.push(`${at} must have exactly id, value, uncertain, citations`);
			return;
		}
		const { id, value, uncertain, citations } = entry;
		if (typeof id !== "string" || !selected.has(id)) {
			errors.push(`${at}.id is not a selected question`);
			return;
		}
		if (answers.has(id)) {
			errors.push(`${at}.id ${id} is duplicated`);
			return;
		}
		if (value !== null && typeof value !== "string") errors.push(`${at}.value must be a string or null`);
		if (typeof uncertain !== "boolean") errors.push(`${at}.uncertain must be a boolean`);
		if (!Array.isArray(citations)) {
			errors.push(`${at}.citations must be an array`);
			return;
		}
		const cited: Citation[] = [];
		citations.forEach((citation: unknown, position: number) => {
			const where = `${at}.citations[${position}]`;
			if (!isRecord(citation) || !hasExactKeys(citation, CITATION_KEYS)) {
				errors.push(`${where} must have exactly recordId, quote`);
				return;
			}
			const { recordId, quote } = citation;
			if (typeof recordId !== "number" || !Number.isSafeInteger(recordId) || recordId < 0) {
				errors.push(`${where}.recordId must be a non-negative integer`);
				return;
			}
			if (typeof quote !== "string" || quote.length === 0) {
				errors.push(`${where}.quote must be a non-empty string`);
				return;
			}
			cited.push({ recordId, quote });
		});
		answers.set(id, { id, value: typeof value === "string" ? value : null, uncertain: uncertain === true, citations: cited });
	});
	for (const id of questionIds) if (!answers.has(id)) errors.push(`missing answer for ${id}`);
	return errors.length > 0 ? { ok: false, errors } : { ok: true, answers };
}

/** Prompt text describing the exact final answer schema for the selected question ids. */
export function answerInstruction(questionIds: readonly string[]): string {
	return [
		'Reply with exactly one fenced ```json code block containing one JSON object, and nothing outside that block: {"answers":[{"id":string,"value":string|null,"uncertain":boolean,"citations":[{"recordId":number,"quote":string}]}]}.',
		`Give exactly one entry for each id: ${questionIds.join(", ")}. Each quote must be copied exactly from the original record text you retrieved, and recordId must be that record's id. Set uncertain to true only when the sources are ambiguous or missing the answer; if they are missing the answer, set value to "not stated".`,
	].join("\n");
}

/** What citations are checked against. `on`: retrieved originals and the saved view. `off`: the seeded history only. */
interface Evidence {
	readonly arm: "on" | "off";
	readonly pages: readonly RetrievedPage[];
	readonly viewText: string;
	readonly seededRecords: ReadonlyMap<string, string>;
	readonly knownIds: ReadonlySet<string>;
}

/**
 * Citation quotes. A quote in the cited record's original text (retrieved page on the on arm, seeded text on the
 * off arm) is original. On the on arm, a quote only in the saved view is real memory text but unretrieved, so it is
 * ungrounded. A quote in no memory text the arm can see is fabricated.
 */
function citationSupport(question: Question, citations: readonly Citation[], evidence: Evidence): { readonly supported: Set<number>; readonly fabricated: number } {
	const supported = new Set<number>();
	let fabricated = 0;
	for (const citation of citations) {
		const original =
			evidence.arm === "on"
				? evidence.pages.some((page) => page.recordId === citation.recordId && page.text.includes(citation.quote))
				: (evidence.seededRecords.get(String(citation.recordId))?.includes(citation.quote) ?? false);
		if (original) {
			const source = question.sources.find((entry) => entry.recordId === citation.recordId);
			if (source && citation.quote.includes(source.value)) supported.add(source.recordId);
			continue;
		}
		const memory = evidence.arm === "on" ? [evidence.viewText] : [...evidence.seededRecords.values()];
		if (memory.some((text) => text.includes(citation.quote))) continue;
		fabricated += 1;
	}
	return { supported, fabricated };
}

/** The value decides first; citations only grade a value that is already right. */
function judgeOne(question: Question, entry: StructuredAnswer, evidence: Evidence): Judgement {
	const value = entry.value ?? "";
	const unanswerable = question.answerable === false;
	const support = citationSupport(question, entry.citations, evidence);
	const grounded = question.ambiguous
		? question.sources.every((source) => support.supported.has(source.recordId))
		: question.sources.some((source) => support.supported.has(source.recordId));
	const asserted = unanswerable ? [] : assertedForbidden(value, question.forbid);
	const fabricatedIds = [...value.matchAll(ID_TOKEN)].map((match) => match[0]).filter((id) => !evidence.knownIds.has(id));
	const verdict = (outcome: Outcome, failure: Failure | null, valueCorrect: boolean, isGrounded = grounded): Judgement => ({
		questionId: question.id,
		outcome,
		failure,
		valueCorrect,
		uncertain: entry.uncertain,
		grounded: isGrounded,
		abstained: outcome === "abstained" || (unanswerable && outcome === "correct"),
		assertedForbidden: asserted,
		fabricatedCitations: support.fabricated,
		fabricatedIds,
	});

	if (fabricatedIds.length > 0) return verdict("hallucinated", "fabricated-id", false);
	if (unanswerable) {
		// Abstaining is the only right answer. A definite value or any citation asserts one. An uncertain reply abstains
		// without credit when its value is empty, is correct when its value is an explicit abstention, and otherwise asserts.
		if (!entry.uncertain || entry.citations.length > 0) return verdict("hallucinated", "unanswerable-asserted", false);
		if (value.trim() === "") return verdict("abstained", null, false, false);
		const phrase = value.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.+$/, "");
		if (ABSTENTION_VALUES.some((token) => phrase.startsWith(token))) return verdict("correct", null, true, true);
		return verdict("hallucinated", "unanswerable-asserted", false);
	}
	if (asserted.length > 0) return verdict("hallucinated", "forbidden-value", false);
	if (question.ambiguous) {
		if (!entry.uncertain) return verdict("hallucinated", "ambiguous-confident", false);
		const namesAll = question.candidates.every((candidate) => mentions(value, candidate));
		if (!namesAll) return verdict("incorrect", "ambiguous-incomplete", false);
	} else {
		if (entry.uncertain) return verdict("abstained", null, false);
		if (entry.value === null) return verdict("incorrect", "no-answer", false);
		if (!question.expect.every((expected) => mentions(value, expected))) return verdict("hallucinated", "wrong-value", false);
	}
	// The value is right. A citation in neither a retrieved page nor the view is fabricated; otherwise grounding decides.
	if (support.fabricated > 0) return verdict("hallucinated", "fabricated-citation", true);
	return grounded ? verdict("correct", null, true) : verdict("incorrect", "ungrounded", true);
}

/** Scores one final answer set. An invalid set fails every selected question with `schema`; nothing is partially credited. */
export function scoreAnswers(input: ScoreInput): AnswerSetScore {
	const arm = input.arm ?? "on";
	if (arm === "off" && input.seededRecords === undefined) throw new Error("scoreAnswers: the off arm needs seededRecords to ground citations");
	const evidence: Evidence = {
		arm,
		pages: input.pages,
		viewText: input.viewText ?? "",
		seededRecords: input.seededRecords ?? new Map(),
		knownIds: input.knownIds,
	};
	const parsed = parseAnswerSet(
		input.raw,
		input.questions.map((question) => question.id),
	);
	const judgements: Judgement[] = parsed.ok
		? input.questions.map((question) => judgeOne(question, parsed.answers.get(question.id)!, evidence))
		: input.questions.map((question): Judgement => ({
				questionId: question.id,
				outcome: "incorrect",
				failure: "schema",
				valueCorrect: false,
				uncertain: false,
				grounded: false,
				abstained: false,
				assertedForbidden: [],
				fabricatedCitations: 0,
				fabricatedIds: [],
			}));
	const count = (outcome: Outcome): number => judgements.filter((judgement) => judgement.outcome === outcome).length;
	return {
		schemaValid: parsed.ok,
		schemaErrors: parsed.ok ? [] : parsed.errors,
		judgements,
		totals: {
			questions: judgements.length,
			correct: count("correct"),
			abstained: judgements.filter((judgement) => judgement.abstained).length,
			incorrect: count("incorrect"),
			hallucinated: count("hallucinated"),
		},
	};
}

/** Per-arm counts over one run's judgements. A correct abstention on an unanswerable question counts as correct and abstained. */
export function armTotals(judgements: readonly Judgement[]): ArmTotals {
	const count = (test: (judgement: Judgement) => boolean): number => judgements.filter(test).length;
	return {
		judged: judgements.length,
		correct: count((judgement) => judgement.outcome === "correct"),
		valueCorrect: count((judgement) => judgement.valueCorrect),
		grounded: count((judgement) => judgement.grounded),
		abstained: count((judgement) => judgement.abstained),
		hallucinated: count((judgement) => judgement.outcome === "hallucinated"),
		incorrectSchema: count((judgement) => judgement.failure === "schema"),
	};
}
