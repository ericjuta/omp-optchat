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
	| "ambiguous-incomplete";

export interface Judgement {
	readonly questionId: string;
	readonly outcome: Outcome;
	readonly failure: Failure | null;
	/** The value is right, independent of its citations: the value rules passed, and abstention is never a value. */
	readonly valueCorrect: boolean;
	/** Answer marked uncertain by the model; reported separately from correctness. */
	readonly uncertain: boolean;
	/** Ambiguous questions: every source was cited with supporting original text. Otherwise: at least one source was. */
	readonly grounded: boolean;
	readonly assertedForbidden: readonly string[];
	/** Citations whose quote is in neither the retrieved original page of the cited record nor the saved view. */
	readonly fabricatedCitations: number;
	readonly fabricatedIds: readonly string[];
}

export interface ScoreInput {
	readonly questions: readonly Question[];
	/** Raw final assistant text; must be exactly the JSON object described by `answerInstruction`. */
	readonly raw: string;
	readonly pages: readonly RetrievedPage[];
	readonly knownIds: ReadonlySet<string>;
	/** Saved view text: a quote found only here is real memory text, though not a retrieved original. */
	readonly viewText?: string;
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

const ANSWER_KEYS = ["id", "value", "uncertain", "citations"] as const;
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
		'Reply with one JSON object and nothing else: {"answers":[{"id":string,"value":string|null,"uncertain":boolean,"citations":[{"recordId":number,"quote":string}]}]}.',
		`Give exactly one entry for each id: ${questionIds.join(", ")}. Each quote must be copied exactly from the original record text you retrieved, and recordId must be that record's id. Set uncertain to true only when the sources are ambiguous or missing the answer.`,
	].join("\n");
}

/**
 * Citation quotes: one in the cited record's retrieved original page supports it; one only in the saved view
 * is real memory text but unretrieved, so it is ungrounded; one in neither is fabricated.
 */
function citationSupport(question: Question, citations: readonly Citation[], pages: readonly RetrievedPage[], viewText: string): { readonly supported: Set<number>; readonly fabricated: number } {
	const supported = new Set<number>();
	let fabricated = 0;
	for (const citation of citations) {
		const original = pages.some((page) => page.recordId === citation.recordId && page.text.includes(citation.quote));
		if (original) {
			const source = question.sources.find((entry) => entry.recordId === citation.recordId);
			if (source && citation.quote.includes(source.value)) supported.add(source.recordId);
			continue;
		}
		if (!viewText.includes(citation.quote)) fabricated += 1;
	}
	return { supported, fabricated };
}

/** The value decides first; citations only grade a value that is already right. */
function judgeOne(question: Question, entry: StructuredAnswer, pages: readonly RetrievedPage[], knownIds: ReadonlySet<string>, viewText: string): Judgement {
	const value = entry.value ?? "";
	const support = citationSupport(question, entry.citations, pages, viewText);
	const grounded = question.ambiguous
		? question.sources.every((source) => support.supported.has(source.recordId))
		: question.sources.some((source) => support.supported.has(source.recordId));
	const asserted = assertedForbidden(value, question.forbid);
	const fabricatedIds = [...value.matchAll(ID_TOKEN)].map((match) => match[0]).filter((id) => !knownIds.has(id));
	const verdict = (outcome: Outcome, failure: Failure | null, valueCorrect: boolean): Judgement => ({
		questionId: question.id,
		outcome,
		failure,
		valueCorrect,
		uncertain: entry.uncertain,
		grounded,
		assertedForbidden: asserted,
		fabricatedCitations: support.fabricated,
		fabricatedIds,
	});

	if (fabricatedIds.length > 0) return verdict("hallucinated", "fabricated-id", false);
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
	const parsed = parseAnswerSet(
		input.raw,
		input.questions.map((question) => question.id),
	);
	const judgements: Judgement[] = parsed.ok
		? input.questions.map((question) => judgeOne(question, parsed.answers.get(question.id)!, input.pages, input.knownIds, input.viewText ?? ""))
		: input.questions.map((question): Judgement => ({
				questionId: question.id,
				outcome: "incorrect",
				failure: "schema",
				valueCorrect: false,
				uncertain: false,
				grounded: false,
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
			abstained: count("abstained"),
			incorrect: count("incorrect"),
			hallucinated: count("hallucinated"),
		},
	};
}
