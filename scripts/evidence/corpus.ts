import { createHash } from "node:crypto";

/** Synthetic-only corpus. Every value is generated from the seed; no private data is read. */
export const CORPUS_VERSION = "optchat-evidence-corpus/3";
export const MIN_PROJECTS = 2;
export const MAX_PROJECTS = 40;
export const MIN_SOURCES = 16;
export const MAX_SOURCES = 512;
export const MIN_SOURCE_BYTES = 512;
export const MAX_SOURCE_BYTES = 32_768;
/**
 * Padding appends whole sentences (6..11 words of at most 10 bytes, space-separated, plus a period) until the floor is met.
 * Each appended sentence is preceded by one space, so a record never exceeds its floor by more than this minus one.
 */
export const MAX_OVERSHOOT_BYTES = 121;

export type QuestionKind =
	| "merge-depth"
	| "correction"
	| "multi-step-correction"
	| "reverted-correction"
	| "negation"
	| "late-distractor"
	| "exact-id"
	| "minor-fact"
	| "attribution"
	| "ambiguity"
	| "near-duplicate"
	| "unanswerable"
	| "work-reference";

/** Every kind, in a fixed order. */
export const QUESTION_KINDS: readonly QuestionKind[] = [
	"merge-depth",
	"correction",
	"multi-step-correction",
	"reverted-correction",
	"negation",
	"late-distractor",
	"exact-id",
	"minor-fact",
	"attribution",
	"ambiguity",
	"near-duplicate",
	"unanswerable",
	"work-reference",
];

/** Kinds that stress recall with superseded, rejected, near-duplicate, or unstated facts. */
export const ADVERSARIAL_KINDS: readonly QuestionKind[] = [
	"multi-step-correction",
	"reverted-correction",
	"late-distractor",
	"near-duplicate",
	"unanswerable",
];

/** `conversation` records are seeded into memory as chat history; `work` records are host-captured work results. */
export type SourceKind = "conversation" | "work";

export interface WorkMetadata {
	readonly source: "task";
	readonly completeness: "full";
	readonly id: string;
	readonly name: string;
}

export interface Provenance {
	/** `memory-seed`: seeded by the runner. `host-work`: produced by a host work tool. */
	readonly channel: "memory-seed" | "host-work";
	/** Synthetic author or reporter named by the record; null when the record has no attribution. */
	readonly attribution: string | null;
	/** Report reference named by the record; null when none. */
	readonly reportId: string | null;
	/** Entity the record concerns; null for filler and background work. */
	readonly subject: string | null;
	/** Work metadata for host-work records (`{source, completeness, id, name}`, id and name equal the REF); null otherwise. */
	readonly work: WorkMetadata | null;
}

export interface SourceRecord {
	/** 0-based memory record id (0..N-1). Citations MUST use this value. */
	readonly recordId: number;
	/** REF token embedded verbatim in `text`. */
	readonly ref: string;
	readonly kind: SourceKind;
	readonly provenance: Provenance;
	/** Complete original text, seeded verbatim. Its UTF-8 length is at least the corpus `minSourceBytes`. */
	readonly text: string;
}

export interface QuestionSource {
	readonly recordId: number;
	/** Value the record establishes. A citation supports this source only when its quote contains the value. */
	readonly value: string;
}

export interface Question {
	readonly id: string;
	readonly kind: QuestionKind;
	readonly prompt: string;
	/** Answerable, non-ambiguous questions: every value must appear in a correct answer. Otherwise empty. */
	readonly expect: readonly string[];
	/** Values asserted (not explicitly rejected) by an answer make it a hallucination. */
	readonly forbid: readonly string[];
	readonly ambiguous: boolean;
	/** `false` only for questions about facts the corpus never states; a correct answer abstains. */
	readonly answerable: boolean;
	/** Ambiguous questions only: a correct answer is uncertain and names every candidate. */
	readonly candidates: readonly string[];
	/**
	 * Answerable, non-ambiguous: the records that establish the value. Any one of them cited with the value grounds it.
	 * Ambiguous: one per candidate, and every one must be cited. Unanswerable: empty.
	 */
	readonly sources: readonly QuestionSource[];
	/** Kind of record that holds the answer. */
	readonly sourceKind: SourceKind;
}

export interface CorpusOptions {
	readonly seed: number;
	/** Synthetic projects, MIN_PROJECTS to MAX_PROJECTS. See `factRecordCount` for the record plan each project implies. */
	readonly projects: number;
	/**
	 * Total source records, MIN_SOURCES to MAX_SOURCES. Must be at least `factRecordCount(projects)`; the remainder is filler.
	 */
	readonly sourceCount: number;
	/** Every record's UTF-8 length is at least this, and at most `MAX_OVERSHOOT_BYTES - 1` above it. */
	readonly minSourceBytes: number;
}

export interface Corpus {
	readonly version: typeof CORPUS_VERSION;
	readonly seed: number;
	readonly minSourceBytes: number;
	readonly sources: readonly SourceRecord[];
	readonly questions: readonly Question[];
	/** Sorted ZX ticket IDs in the corpus; any other ID-shaped token in an answer is fabricated. */
	readonly knownIds: readonly string[];
	readonly digest: string;
}

/** Deterministic 32-bit PRNG; the seed fully determines the corpus. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

export const CODENAMES = [
	"Lumen", "Basalt", "Harbor", "Quill", "Cinder", "Orchid", "Meridian", "Tundra", "Velvet", "Anchor",
	"Bramble", "Cobalt", "Dune", "Ember", "Fjord", "Garnet", "Hollow", "Indigo", "Juniper", "Kestrel",
	"Lantern", "Mosaic", "Nectar", "Onyx", "Prism", "Quarry", "Ridge", "Sable", "Thistle", "Umber",
	"Vortex", "Willow", "Xenon", "Yarrow", "Zephyr", "Alder", "Birch", "Cedar", "Dahlia", "Fathom",
] as const;
/** Entity never present in the corpus; questions about it are unanswerable. */
export const UNSTATED_SUBJECT = "Obsidian";
const OWNERS = ["Ada", "Ben", "Cara", "Dev", "Eli", "Fay", "Gus", "Hana", "Iris", "Jon"] as const;
const VENDORS = ["Corvid", "Pellet", "Stratus", "Nimbly", "Ferrox", "Glyph"] as const;
const REPORTERS = ["Mika", "Osei", "Priya", "Rafael", "Sun", "Tove"] as const;
/** Lowercase neutral words for detail padding: no names, numbers, IDs, or fact vocabulary. */
const PAD_WORDS = ["routine", "checkpoint", "buffer", "cursor", "ledger", "segment", "snapshot", "interval", "replica", "queue", "vector", "frame", "lattice", "shard", "margin", "cache", "probe", "drift"] as const;

/**
 * Project history shape, by `index % 4`. Each family adds late correction records after the filler:
 * plain (none), single correction (1), chain A→B→C (2), reverted correction A→B then "B was wrong, A stands" (2).
 */
const FAMILIES = ["plain", "single", "chain", "revert"] as const;
type Family = (typeof FAMILIES)[number];
const LATE_RECORDS: readonly number[] = [0, 1, 2, 2];
/** Fact records every project contributes in the fact layers, distractor layer included. */
const BASE_RECORDS_PER_PROJECT = 6;
/** Global fact records: two Atlas entities and one work record. */
const GLOBAL_RECORDS = 3;

/** Late correction records a project contributes; family is `index % 4`. */
export function lateRecordCount(projects: number): number {
	let total = 0;
	for (let index = 0; index < projects; index++) total += LATE_RECORDS[index % LATE_RECORDS.length]!;
	return total;
}

/**
 * Records that carry facts (everything except filler) for a project count:
 * `6P + Σ_{i<P} late(i mod 4) + 3`, closed form `6P + 5·⌊P/4⌋ + [0,0,1,3][P mod 4] + 3`.
 * P=2 → 16, P=3 → 24, P=40 → 293. `sourceCount` must be at least this value.
 */
export function factRecordCount(projects: number): number {
	return projects * BASE_RECORDS_PER_PROJECT + lateRecordCount(projects) + GLOBAL_RECORDS;
}

/** Questions a corpus of this project count yields: one per project per owner/vendor/ticket/reporter/window/late-distractor, plus four global. */
export function questionCount(projects: number): number {
	return projects * 6 + 4;
}

/** Smallest valid source count and total question count for a project count, without building a corpus. */
export function estimateCorpusSize(projects: number): { readonly minSources: number; readonly questions: number } {
	if (!Number.isInteger(projects) || projects < MIN_PROJECTS || projects > MAX_PROJECTS) {
		throw new Error(`projects must be an integer from ${MIN_PROJECTS} to ${MAX_PROJECTS}`);
	}
	return { minSources: Math.max(MIN_SOURCES, factRecordCount(projects)), questions: questionCount(projects) };
}

/**
 * Byte and token bounds for a corpus shape, computed without building it. Every record lies in
 * `[minSourceBytes, minSourceBytes + MAX_OVERSHOOT_BYTES - 1]`. Tokens use a bytes/4 heuristic, not a provider tokenizer.
 */
export function describeCorpusSize(options: CorpusOptions): {
	readonly sources: number;
	readonly questions: number;
	readonly minBytes: number;
	readonly maxBytes: number;
	readonly approxTokens: { readonly min: number; readonly max: number };
} {
	validateCorpusOptions(options);
	const minBytes = options.sourceCount * options.minSourceBytes;
	const maxBytes = options.sourceCount * (options.minSourceBytes + MAX_OVERSHOOT_BYTES - 1);
	return {
		sources: options.sourceCount,
		questions: questionCount(options.projects),
		minBytes,
		maxBytes,
		approxTokens: { min: Math.ceil(minBytes / 4), max: Math.ceil(maxBytes / 4) },
	};
}

export function validateCorpusOptions(options: CorpusOptions): void {
	if (!Number.isSafeInteger(options.seed) || options.seed < 0) throw new Error("seed must be a non-negative safe integer");
	if (!Number.isInteger(options.projects) || options.projects < MIN_PROJECTS || options.projects > MAX_PROJECTS) {
		throw new Error(`projects must be an integer from ${MIN_PROJECTS} to ${MAX_PROJECTS}`);
	}
	if (!Number.isInteger(options.sourceCount) || options.sourceCount < MIN_SOURCES || options.sourceCount > MAX_SOURCES) {
		throw new Error(`sourceCount must be an integer from ${MIN_SOURCES} to ${MAX_SOURCES}`);
	}
	const needed = factRecordCount(options.projects);
	if (options.sourceCount < needed) {
		throw new Error(`projects ${options.projects} need ${needed} fact records; sourceCount must be at least ${needed}`);
	}
	if (!Number.isInteger(options.minSourceBytes) || options.minSourceBytes < MIN_SOURCE_BYTES || options.minSourceBytes > MAX_SOURCE_BYTES) {
		throw new Error(`minSourceBytes must be an integer from ${MIN_SOURCE_BYTES} to ${MAX_SOURCE_BYTES}`);
	}
}

function single(id: string, kind: QuestionKind, prompt: string, recordId: number, value: string, forbid: readonly string[], sourceKind: SourceKind): Question {
	return { id, kind, prompt, expect: [value], forbid, ambiguous: false, answerable: true, candidates: [], sources: [{ recordId, value }], sourceKind };
}

interface Placement {
	owner: number;
	vendor: number;
	ticket: number;
	report: number;
	window: number;
	distractor: number;
	/** Late correction records in the order they were written. */
	late: number[];
}

export function buildCorpus(options: CorpusOptions): Corpus {
	validateCorpusOptions(options);

	const random = seededRandom(options.seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
	const detailSentence = (): string => {
		const count = 6 + Math.floor(random() * 6);
		return `${Array.from({ length: count }, () => pick(PAD_WORDS)).join(" ")}.`;
	};

	const usedTickets = new Set<string>();
	const projects = Array.from({ length: options.projects }, (_, index) => {
		const base = index * 3 + options.seed;
		const vendor = pick(VENDORS);
		let ticket: string;
		do {
			ticket = `ZX-${String(1000 + Math.floor(random() * 9000)).padStart(4, "0")}-${String.fromCharCode(65 + Math.floor(random() * 26))}`;
		} while (usedTickets.has(ticket));
		usedTickets.add(ticket);
		return {
			index,
			name: CODENAMES[index]!,
			family: FAMILIES[index % FAMILIES.length]! as Family,
			owner: OWNERS[base % OWNERS.length]!,
			firstNew: OWNERS[(base + 1) % OWNERS.length]!,
			secondNew: OWNERS[(base + 2) % OWNERS.length]!,
			vendor,
			wrongVendor: VENDORS[(VENDORS.indexOf(vendor) + 1) % VENDORS.length]!,
			ticket,
			reporter: pick(REPORTERS),
			reportId: `RPT-${options.seed}-${index + 1}`,
			minutes: 5 + Math.floor(random() * 90),
		};
	});

	interface Draft {
		readonly kind: SourceKind;
		readonly provenance: Provenance;
		readonly fact: string;
	}
	const drafts: Draft[] = [];
	/** Appends a draft and returns its 0-based record id. */
	const add = (fact: string, kind: SourceKind, provenance: Provenance): number => {
		drafts.push({ kind, provenance, fact });
		return drafts.length - 1;
	};
	const memory = (subject: string | null, attribution: string | null = null, reportId: string | null = null): Provenance => ({
		channel: "memory-seed",
		attribution,
		reportId,
		subject,
		work: null,
	});

	const placed: Placement[] = projects.map(() => ({ owner: -1, vendor: -1, ticket: -1, report: -1, window: -1, distractor: -1, late: [] }));

	// Layer 1, early: fact layers grouped by type, so one project's facts sit a whole project-block apart.
	for (const project of projects) {
		placed[project.index]!.owner = add(`Project ${project.name} owner is ${project.owner}.`, "conversation", memory(project.name));
	}
	for (const project of projects) {
		placed[project.index]!.vendor = add(
			`Project ${project.name} uses vendor ${project.vendor}; it does not use vendor ${project.wrongVendor}.`,
			"conversation",
			memory(project.name),
		);
	}
	for (const project of projects) {
		placed[project.index]!.ticket = add(`Ticket for project ${project.name} is ${project.ticket}.`, "conversation", memory(project.name));
	}
	for (const project of projects) {
		placed[project.index]!.report = add(
			`Project ${project.name} was reported by ${project.reporter} in report ${project.reportId}.`,
			"conversation",
			memory(project.name, project.reporter, project.reportId),
		);
	}
	for (const project of projects) {
		placed[project.index]!.window = add(`Rollback window for project ${project.name} is ${project.minutes} minutes.`, "conversation", memory(project.name));
	}

	// Layer 2, middle: a late review repeats each rejected vendor prominently, long after the vendor fact.
	for (const project of projects) {
		placed[project.index]!.distractor = add(
			`Late review for project ${project.name}: vendor ${project.wrongVendor} was pitched, reviewed again, and rejected.`,
			"conversation",
			memory(project.name),
		);
	}

	// Layer 3, filler: pushes the late corrections far from the facts they supersede.
	const fillerCount = options.sourceCount - factRecordCount(options.projects);
	for (let filler = 1; filler <= fillerCount; filler++) {
		add(`Filler ${filler}: routine status line with no project facts.`, "conversation", memory(null));
	}

	// Layer 4, late: corrections, chains, and reverts supersede the early owner facts.
	const correction = (name: string, to: string, from: string): string => `Correction for project ${name}: owner is ${to}, not ${from}.`;
	for (const project of projects) {
		const slot = placed[project.index]!;
		const memorySubject = memory(project.name);
		switch (project.family) {
			case "plain":
				break;
			case "single":
				slot.late.push(add(correction(project.name, project.firstNew, project.owner), "conversation", memorySubject));
				break;
			case "chain":
				slot.late.push(add(correction(project.name, project.firstNew, project.owner), "conversation", memorySubject));
				slot.late.push(add(correction(project.name, project.secondNew, project.firstNew), "conversation", memorySubject));
				break;
			case "revert":
				slot.late.push(add(correction(project.name, project.firstNew, project.owner), "conversation", memorySubject));
				slot.late.push(add(`Revert for project ${project.name}: ${project.firstNew} was wrong, ${project.owner} stands.`, "conversation", memorySubject));
				break;
		}
	}

	// Two same-subject-looking entities: a definite question on one, and a bare-name question that cannot pick one silently.
	const atlasNorthOwner = OWNERS[(options.seed + 4) % OWNERS.length]!;
	const atlasTwoOwner = OWNERS[(options.seed + 7) % OWNERS.length]!;
	const atlasNorth = add(`Atlas-North owner is ${atlasNorthOwner}.`, "conversation", memory("Atlas-North"));
	const atlasTwo = add(`Atlas North-2 owner is ${atlasTwoOwner}.`, "conversation", memory("Atlas North-2"));

	const checksum = Array.from({ length: 8 }, () => Math.floor(random() * 16).toString(16)).join("");
	const work = add(`Background report W-${options.seed}: checksum ${checksum}.`, "work", {
		channel: "host-work",
		attribution: "host-work",
		reportId: `W-${options.seed}`,
		subject: null,
		work: null,
	});

	if (drafts.length !== options.sourceCount) throw new Error("record plan disagrees with sourceCount");

	const questions: Question[] = [];
	for (const project of projects) {
		const slot = placed[project.index]!;
		const name = project.name;
		switch (project.family) {
			case "plain":
				questions.push(single(`owner-${name}`, "merge-depth", `Who owns project ${name}?`, slot.owner, project.owner, [], "conversation"));
				break;
			case "single":
				questions.push(
					single(`owner-${name}`, "correction", `Who owns project ${name} now?`, slot.late[0]!, project.firstNew, [project.owner], "conversation"),
				);
				break;
			case "chain":
				questions.push(
					single(
						`owner-${name}`,
						"multi-step-correction",
						`Who owns project ${name} now?`,
						slot.late[1]!,
						project.secondNew,
						[project.owner, project.firstNew],
						"conversation",
					),
				);
				break;
			case "revert":
				questions.push({
					id: `owner-${name}`,
					kind: "reverted-correction",
					prompt: `Who owns project ${name} now?`,
					expect: [project.owner],
					forbid: [project.firstNew],
					ambiguous: false,
					answerable: true,
					candidates: [],
					sources: [
						{ recordId: slot.owner, value: project.owner },
						{ recordId: slot.late[1]!, value: project.owner },
					],
					sourceKind: "conversation",
				});
				break;
		}
		questions.push(single(`vendor-${name}`, "negation", `Which vendor does project ${name} use?`, slot.vendor, project.vendor, [project.wrongVendor], "conversation"));
		questions.push(
			single(
				`distractor-${name}`,
				"late-distractor",
				`After the late review, which vendor does project ${name} use?`,
				slot.vendor,
				project.vendor,
				[project.wrongVendor],
				"conversation",
			),
		);
		questions.push(single(`ticket-${name}`, "exact-id", `What is the ticket ID for project ${name}?`, slot.ticket, project.ticket, [], "conversation"));
		questions.push(single(`reporter-${name}`, "attribution", `Who reported project ${name}?`, slot.report, project.reporter, [], "conversation"));
		questions.push(single(`window-${name}`, "minor-fact", `What is the rollback window for project ${name}?`, slot.window, `${project.minutes} minutes`, [], "conversation"));
	}
	questions.push({
		id: "atlas-north-definite",
		kind: "near-duplicate",
		prompt: "Who owns Atlas-North?",
		expect: [atlasNorthOwner],
		forbid: [atlasTwoOwner],
		ambiguous: false,
		answerable: true,
		candidates: [],
		sources: [{ recordId: atlasNorth, value: atlasNorthOwner }],
		sourceKind: "conversation",
	});
	questions.push({
		id: "atlas-ambiguous",
		kind: "ambiguity",
		prompt: "Who owns Atlas North?",
		expect: [],
		forbid: [],
		ambiguous: true,
		answerable: true,
		candidates: [atlasNorthOwner, atlasTwoOwner],
		sources: [
			{ recordId: atlasNorth, value: atlasNorthOwner },
			{ recordId: atlasTwo, value: atlasTwoOwner },
		],
		sourceKind: "conversation",
	});
	questions.push({
		id: "obsidian-unstated",
		kind: "unanswerable",
		prompt: `Who owns project ${UNSTATED_SUBJECT}?`,
		expect: [],
		forbid: [],
		ambiguous: false,
		answerable: false,
		candidates: [],
		sources: [],
		sourceKind: "conversation",
	});
	questions.push(single("work-checksum", "work-reference", `What checksum did background report W-${options.seed} produce?`, work, checksum, [], "work"));

	const encoder = new TextEncoder();
	const sources: SourceRecord[] = drafts.map((draft, index) => {
		const recordId = index;
		const ref = `REF-${options.seed}-${recordId}`;
		let text = `${draft.fact} [${ref}] Detail:`;
		let bytes = encoder.encode(text).byteLength;
		while (bytes < options.minSourceBytes) {
			const sentence = ` ${detailSentence()}`;
			text += sentence;
			bytes += encoder.encode(sentence).byteLength;
		}
		const workMeta: WorkMetadata | null = draft.kind === "work" ? { source: "task", completeness: "full", id: ref, name: ref } : null;
		return { recordId, ref, kind: draft.kind, provenance: { ...draft.provenance, work: workMeta }, text };
	});

	const knownIds = projects.map((project) => project.ticket);
	const digest = createHash("sha256").update(JSON.stringify({ sources, questions })).digest("hex");
	return {
		version: CORPUS_VERSION,
		seed: options.seed,
		minSourceBytes: options.minSourceBytes,
		sources,
		questions,
		knownIds: [...knownIds].sort(),
		digest,
	};
}
