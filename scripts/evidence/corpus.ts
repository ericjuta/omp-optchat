import { createHash } from "node:crypto";

/** Synthetic-only corpus. Every value is generated from the seed; no private data is read. */
export const CORPUS_VERSION = "optchat-evidence-corpus/2";
export const MIN_SOURCES = 16;
export const MAX_SOURCES = 24;
export const MIN_SOURCE_BYTES = 512;
export const MAX_SOURCE_BYTES = 16_384;

export type QuestionKind =
	| "merge-depth"
	| "correction"
	| "negation"
	| "exact-id"
	| "minor-fact"
	| "attribution"
	| "ambiguity"
	| "work-reference";

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
	/** Non-ambiguous questions: every value must appear in a correct answer. Ambiguous questions: empty. */
	readonly expect: readonly string[];
	/** Values asserted (not explicitly rejected) by an answer make it a hallucination. */
	readonly forbid: readonly string[];
	readonly ambiguous: boolean;
	/** Ambiguous questions only: a correct answer is uncertain and names every candidate. */
	readonly candidates: readonly string[];
	/** Non-ambiguous: one source. Ambiguous: one per candidate, and every one must be cited. */
	readonly sources: readonly QuestionSource[];
	/** Kind of record that holds the answer. */
	readonly sourceKind: SourceKind;
}

export interface CorpusOptions {
	readonly seed: number;
	/** Synthetic projects, 2 to 10. Five fact records per project, plus a correction for every third project. */
	readonly projects: number;
	/** Total source records, MIN_SOURCES to MAX_SOURCES. Must cover the fact records; the remainder is filler. */
	readonly sourceCount: number;
	/** Every record's UTF-8 length is at least this. Callers pass a value above the host's node size. */
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

export const CODENAMES = ["Lumen", "Basalt", "Harbor", "Quill", "Cinder", "Orchid", "Meridian", "Tundra", "Velvet", "Anchor"] as const;
const OWNERS = ["Ada", "Ben", "Cara", "Dev", "Eli", "Fay", "Gus", "Hana", "Iris", "Jon"] as const;
const VENDORS = ["Corvid", "Pellet", "Stratus", "Nimbly", "Ferrox", "Glyph"] as const;
const REPORTERS = ["Mika", "Osei", "Priya", "Rafael", "Sun", "Tove"] as const;
/** Lowercase neutral words for detail padding: no names, numbers, IDs, or fact vocabulary. */
const PAD_WORDS = ["routine", "checkpoint", "buffer", "cursor", "ledger", "segment", "snapshot", "interval", "replica", "queue", "vector", "frame", "lattice", "shard", "margin", "cache", "probe", "drift"] as const;

const CORRECTION_PERIOD = 3;
const FACTS_PER_PROJECT = 5;
const ATLAS_RECORDS = 2;
const WORK_RECORDS = 1;

/** Records that carry facts (everything except filler) for a given project count; one place defines the formula. */
export function factRecordCount(projects: number): number {
	return projects * FACTS_PER_PROJECT + Math.ceil(projects / CORRECTION_PERIOD) + ATLAS_RECORDS + WORK_RECORDS;
}

function single(id: string, kind: QuestionKind, prompt: string, recordId: number, value: string, forbid: readonly string[], sourceKind: SourceKind): Question {
	return { id, kind, prompt, expect: [value], forbid, ambiguous: false, candidates: [], sources: [{ recordId, value }], sourceKind };
}

export function buildCorpus(options: CorpusOptions): Corpus {
	if (!Number.isSafeInteger(options.seed) || options.seed < 0) throw new Error("seed must be a non-negative safe integer");
	if (!Number.isInteger(options.projects) || options.projects < 2 || options.projects > CODENAMES.length) {
		throw new Error(`projects must be an integer from 2 to ${CODENAMES.length}`);
	}
	if (!Number.isInteger(options.sourceCount) || options.sourceCount < MIN_SOURCES || options.sourceCount > MAX_SOURCES) {
		throw new Error(`sourceCount must be an integer from ${MIN_SOURCES} to ${MAX_SOURCES}`);
	}
	if (!Number.isInteger(options.minSourceBytes) || options.minSourceBytes < MIN_SOURCE_BYTES || options.minSourceBytes > MAX_SOURCE_BYTES) {
		throw new Error(`minSourceBytes must be an integer from ${MIN_SOURCE_BYTES} to ${MAX_SOURCE_BYTES}`);
	}

	const random = seededRandom(options.seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
	const detailSentence = (): string => {
		const count = 6 + Math.floor(random() * 6);
		return `${Array.from({ length: count }, () => pick(PAD_WORDS)).join(" ")}.`;
	};

	const projects = Array.from({ length: options.projects }, (_, index) => {
		const name = CODENAMES[index]!;
		const owner = OWNERS[(index * 3 + options.seed) % OWNERS.length]!;
		const newOwner = OWNERS[(index * 3 + options.seed + 1) % OWNERS.length]!;
		const vendor = pick(VENDORS);
		const wrongVendor = VENDORS[(VENDORS.indexOf(vendor) + 1) % VENDORS.length]!;
		const ticket = `ZX-${String(1000 + Math.floor(random() * 9000)).padStart(4, "0")}-${String.fromCharCode(65 + Math.floor(random() * 26))}`;
		const reporter = pick(REPORTERS);
		const minutes = 5 + Math.floor(random() * 90);
		return { index, name, owner, newOwner, vendor, wrongVendor, ticket, reporter, minutes };
	});
	const correctedProjects = projects.filter((entry) => entry.index % CORRECTION_PERIOD === 0);
	const factRecords = factRecordCount(options.projects);
	if (factRecords !== projects.length * FACTS_PER_PROJECT + correctedProjects.length + ATLAS_RECORDS + WORK_RECORDS) {
		throw new Error("fact-record formula disagrees with the generated records");
	}
	if (factRecords > options.sourceCount) {
		throw new Error(`projects ${options.projects} need ${factRecords} fact records; sourceCount must be at least ${factRecords}`);
	}

	interface Draft {
		readonly kind: SourceKind;
		readonly provenance: Provenance;
		readonly fact: string;
	}
	const drafts: Draft[] = [];
	/** Appends a draft and returns its 1-based record id. */
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

	// Early facts sit at the bottom of the merge tree, so answering them requires zooming.
	const knownIds: string[] = [];
	const records = new Map<string, { owner: number; vendor: number; ticket: number; report: number; window: number }>();
	for (const project of projects) {
		const reportId = `RPT-${options.seed}-${project.index + 1}`;
		const owner = add(`Project ${project.name} owner is ${project.owner}.`, "conversation", memory(project.name));
		const vendor = add(
			`Project ${project.name} uses vendor ${project.vendor}; it does not use vendor ${project.wrongVendor}.`,
			"conversation",
			memory(project.name),
		);
		const ticket = add(`Ticket for project ${project.name} is ${project.ticket}.`, "conversation", memory(project.name));
		const report = add(
			`Project ${project.name} was reported by ${project.reporter} in report ${reportId}.`,
			"conversation",
			memory(project.name, project.reporter, reportId),
		);
		const window = add(`Rollback window for project ${project.name} is ${project.minutes} minutes.`, "conversation", memory(project.name));
		records.set(project.name, { owner, vendor, ticket, report, window });
		knownIds.push(project.ticket);
	}

	// Filler fills the record count so the merge tree grows to several levels; it carries no facts.
	for (let filler = 1; filler <= options.sourceCount - factRecords; filler++) {
		add(`Filler ${filler}: routine status line with no project facts.`, "conversation", memory(null));
	}

	// Late corrections supersede earlier owners; the question must return the newer owner.
	const corrections = new Map<string, number>();
	for (const project of correctedProjects) {
		corrections.set(project.name, add(`Correction for project ${project.name}: owner is ${project.newOwner}, not ${project.owner}.`, "conversation", memory(project.name)));
	}

	// Two same-named entities make a bare question ambiguous; the model must not pick one silently.
	const northOwner = OWNERS[(options.seed + 4) % OWNERS.length]!;
	const southOwner = OWNERS[(options.seed + 7) % OWNERS.length]!;
	const north = add(`Atlas north owner is ${northOwner}.`, "conversation", memory("Atlas north"));
	const south = add(`Atlas south owner is ${southOwner}.`, "conversation", memory("Atlas south"));

	const checksum = Array.from({ length: 8 }, () => Math.floor(random() * 16).toString(16)).join("");
	const work = add(`Background report W-${options.seed}: checksum ${checksum}.`, "work", {
		channel: "host-work",
		attribution: "host-work",
		reportId: `W-${options.seed}`,
		subject: null,
		work: null,
	});

	const questions: Question[] = [];
	for (const project of projects) {
		const record = records.get(project.name)!;
		const correction = corrections.get(project.name);
		questions.push(
			correction === undefined
				? single(`owner-${project.name}`, "merge-depth", `Who owns project ${project.name}?`, record.owner, project.owner, [], "conversation")
				: single(`owner-${project.name}`, "correction", `Who owns project ${project.name} now?`, correction, project.newOwner, [project.owner], "conversation"),
		);
		questions.push(
			single(`vendor-${project.name}`, "negation", `Which vendor does project ${project.name} use?`, record.vendor, project.vendor, [project.wrongVendor], "conversation"),
		);
		questions.push(single(`ticket-${project.name}`, "exact-id", `What is the ticket ID for project ${project.name}?`, record.ticket, project.ticket, [], "conversation"));
		questions.push(single(`reporter-${project.name}`, "attribution", `Who reported project ${project.name}?`, record.report, project.reporter, [], "conversation"));
		questions.push(
			single(`window-${project.name}`, "minor-fact", `What is the rollback window for project ${project.name}?`, record.window, `${project.minutes} minutes`, [], "conversation"),
		);
	}
	questions.push({
		id: "atlas-ambiguous",
		kind: "ambiguity",
		prompt: "Who owns Atlas?",
		expect: [],
		forbid: [],
		ambiguous: true,
		candidates: [northOwner, southOwner],
		sources: [
			{ recordId: north, value: northOwner },
			{ recordId: south, value: southOwner },
		],
		sourceKind: "conversation",
	});
	questions.push(single("work-checksum", "work-reference", `What checksum did background report W-${options.seed} produce?`, work, checksum, [], "work"));

	const sources: SourceRecord[] = drafts.map((draft, index) => {
		const recordId = index;
		const ref = `REF-${options.seed}-${recordId}`;
		let text = `${draft.fact} [${ref}] Detail:`;
		while (new TextEncoder().encode(text).byteLength < options.minSourceBytes) text += ` ${detailSentence()}`;
		const workMeta: WorkMetadata | null = draft.kind === "work" ? { source: "task", completeness: "full", id: ref, name: ref } : null;
		return { recordId, ref, kind: draft.kind, provenance: { ...draft.provenance, work: workMeta }, text };
	});

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
