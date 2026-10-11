import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MESSAGE_KINDS, type SearchOptions, type SearchResult } from "./memory.js";

/** Stored image bytes and their MIME type; never a path. */
export interface PageImage {
	readonly data: string;
	readonly mimeType: string;
}

/** One bounded page of stored text. `next` is the byte offset of the following page, or null at the end. */
export interface PageEnvelope {
	readonly text: string;
	readonly next: number | null;
	readonly totalBytes: number;
	readonly offset: number;
	/** The message's stored images in source order; supplied on a first page only. */
	readonly images?: readonly PageImage[];
}

/** One page of a captured report, with the message id and its recorded provenance. */
export interface WorkEnvelope {
	readonly page: PageEnvelope;
	readonly messageId: number;
	readonly source: string;
	readonly completeness: string;
}

/** Read-only memory access: the main chat's memory and a child's frozen snapshot both satisfy it. */
export interface MemoryReader {
	zoom(id: number, n: number, offset: number, depth: number): PageEnvelope;
	date(id: number): string;
	work(name: string, offset: number): WorkEnvelope;
	search(query: string, options: SearchOptions): SearchResult;
}

/** A child's frozen snapshot: a detached render and reads bounded to the upper bound. It has no writer. */
export interface ChildView extends MemoryReader {
	readonly render: string;
	/** Messages with id below this bound existed when the snapshot was taken. */
	readonly upperBound: number;
}

/** A parent's published view, bound to the session that owns it. */
export interface ChildSource {
	readonly owner: string;
	snapshot(): ChildView;
}

/** A published view as a child adopts it: its owner, a snapshot, and whether the publication still stands. */
export interface AdoptedChildSource {
	readonly owner: string;
	/** False once the owner revokes the publication; a revoked view is never read or injected again. */
	isLive(): boolean;
	snapshot(): ChildView;
}

/**
 * Decides one tool read from the session context live at that moment, or throws. Tools and listeners
 * outlive a child's session switch, so admission can never be decided once at attachment.
 */
export type Admission = (current: ExtensionContext | undefined) => void;

/** For a chat's own memory, which adopts no parent view and so has nothing to re-check. */
export const UNGUARDED: Admission = () => {};

interface Publication {
	readonly source: ChildSource;
	readonly token: { live: boolean };
}

/**
 * Keyed by the parent session's artifact manager, which child sessions adopt. Module-scoped because
 * the host does not share the extension event bus with child sessions. Roots have distinct managers,
 * so one root's view is never adopted by another.
 */
const publications = new WeakMap<object, Publication>();

/** Publish the owner's view; the returned function revokes it, and every snapshot already taken with it. */
export function publishChildSource(manager: object, source: ChildSource): () => void {
	if (publications.has(manager)) throw new Error("a read-only chat view is already published for this session");
	const token = { live: true };
	publications.set(manager, { source, token });
	return () => {
		token.live = false;
		if (publications.get(manager)?.token === token) publications.delete(manager);
	};
}

/** The view published for this manager, if any. Adoption never reads a store or a writer. */
export function adoptChildSource(manager: object): AdoptedChildSource | undefined {
	const publication = publications.get(manager);
	if (!publication) return undefined;
	const { source, token } = publication;
	return {
		owner: source.owner,
		isLive: () => token.live,
		snapshot: () => {
			if (!token.live) throw new Error("the parent chat view was revoked");
			return guarded(source.snapshot(), token);
		},
	};
}

/** Every read from a revoked publication fails; the snapshot's contents never change. */
function guarded(view: ChildView, token: { live: boolean }): ChildView {
	const check = (): void => {
		if (!token.live) throw new Error("the parent chat view was revoked");
	};
	return {
		render: view.render,
		upperBound: view.upperBound,
		zoom: (id, n, offset, depth) => {
			check();
			return view.zoom(id, n, offset, depth);
		},
		date: (id) => {
			check();
			return view.date(id);
		},
		work: (name, offset) => {
			check();
			return view.work(name, offset);
		},
		search: (query, options) => {
			check();
			return view.search(query, options);
		},
	};
}

function pageResult(page: PageEnvelope, details: Record<string, unknown> = {}) {
	const envelope =
		page.next === null
			? `[end of ${page.totalBytes} bytes]`
			: `[bytes ${page.offset}-${page.next} of ${page.totalBytes}; next offset ${page.next}]`;
	return {
		content: [
			{ type: "text" as const, text: page.text },
			{ type: "text" as const, text: envelope },
			...(page.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
		],
		details: { offset: page.offset, next: page.next, totalBytes: page.totalBytes, ...details },
	};
}

/** Register the zoom, date, work and chat_search tools over any memory reader; each call is admitted before it reads. */
export function registerMemoryTools(pi: ExtensionAPI, reader: MemoryReader, admit: Admission): void {
	const z = pi.zod;
	const zoomParams = z.object({
		id: z.number().int().min(0).describe("First message id of the line"),
		n: z.number().int().min(1).describe("Messages the line covers (a power of 2)"),
		offset: z.number().int().min(0).optional().describe("UTF-8 byte offset of the page (n = 1 only; default 0)"),
		depth: z.number().int().min(1).optional().describe("Levels to open at once (n > 1; default 1, at most 4)"),
	});
	pi.registerTool<typeof zoomParams>({
		name: "zoom",
		label: "OptChat zoom",
		description:
			"Open the line id+n of the view into the two lines of n/2 under it; with depth d, open the 2^d lines d levels under it at once. With n = 1, return one page of message id's stored text from offset; follow details.next until it is null.",
		parameters: zoomParams,
		approval: "read",
		loadMode: "essential",
		execute: async (_id, params, _signal, _update, current) => {
			admit(current);
			const offset = params.offset ?? 0;
			if (params.n > 1 && offset !== 0) throw new Error("offset applies only to zoom with n = 1");
			return pageResult(reader.zoom(params.id, params.n, offset, params.depth ?? 1));
		},
	});
	const dateParams = z.object({ id: z.number().int().min(0).describe("Message id") });
	pi.registerTool<typeof dateParams>({
		name: "date",
		label: "OptChat date",
		description: "The date and time of message id.",
		parameters: dateParams,
		approval: "read",
		loadMode: "essential",
		execute: async (_id, params, _signal, _update, current) => {
			admit(current);
			return { content: [{ type: "text", text: reader.date(params.id) }] };
		},
	});
	const searchParams = z.object({
		text: z.string().min(1).max(200).describe("Words that must all appear in the message, case-insensitive"),
		kind: z.enum(MESSAGE_KINDS).optional().describe("Only messages of this kind"),
		limit: z.number().int().min(1).max(50).optional().describe("Hits to return (default 10)"),
		before: z.number().int().min(0).optional().describe("Only messages with id below this; pass details.next for older hits"),
	});
	pi.registerTool<typeof searchParams>({
		name: "chat_search",
		label: "OptChat search",
		description:
			"Search the stored chat's original messages for words a summary may have dropped; returns message ids with snippets, newest first. Open a hit with zoom(id, 1).",
		parameters: searchParams,
		approval: "read",
		loadMode: "essential",
		execute: async (_id, params, _signal, _update, current) => {
			admit(current);
			const result = reader.search(params.text, { kind: params.kind, limit: params.limit, before: params.before });
			const header = `[optchat search] ${result.hits.length} hits for "${params.text.replace(/\s+/g, " ").trim()}" (newest first)`;
			const footer = result.next === null ? "[no older hits]" : `[older hits: before=${result.next}]`;
			const lines = [header, ...result.hits.map((hit) => `${hit.id}|${hit.kind}|${hit.snippet}`), footer];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { hits: result.hits.map((hit) => hit.id), next: result.next },
			};
		},
	});
	const workParams = z.object({
		name: z.string().min(1).max(256).describe("Recorded work id, agent id or name of a captured report"),
		offset: z.number().int().min(0).optional().describe("UTF-8 byte offset of the page (default 0)"),
	});
	pi.registerTool<typeof workParams>({
		name: "work",
		label: "OptChat work",
		description:
			"Read one page of a captured subagent or background report, by its recorded id, agent id or name. Follow details.next until it is null.",
		parameters: workParams,
		approval: "read",
		loadMode: "essential",
		execute: async (_id, params, _signal, _update, current) => {
			admit(current);
			const found = reader.work(params.name, params.offset ?? 0);
			return pageResult(found.page, {
				messageId: found.messageId,
				source: found.source,
				completeness: found.completeness,
			});
		},
	});
}

/**
 * A child session with an adoptable parent view gets read-only tools and the frozen view in its system
 * prompt. Without one, nothing is registered: no writer or Store is ever opened here.
 *
 * A child keeps its tools and prompt hook across session switches and parent revocation, so both are
 * admitted per use: the publication must still be live, and both the adopting session ID and artifact
 * manager must still match. Session switches can retain the same artifact manager.
 */
export function attachChildView(pi: ExtensionAPI, ctx: ExtensionContext, guide: string): void {
	const manager = ctx.sessionManager.getArtifactManager();
	if (!manager) return;
	const source = adoptChildSource(manager);
	if (!source) return;
	const sessionId = ctx.sessionManager.getSessionId();
	let view: ChildView;
	try {
		view = source.snapshot();
	} catch (error) {
		ctx.ui.notify(`OptChat child view is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return;
	}
	const attached = (current: ExtensionContext | undefined): boolean =>
		source.isLive() &&
		current !== undefined &&
		current.sessionManager.getArtifactManager() === manager &&
		current.sessionManager.getSessionId() === sessionId;
	registerMemoryTools(pi, view, (current) => {
		if (!attached(current)) throw new Error("the parent chat view is not attached to this session");
	});
	const block = `${guide}\n\n# Parent chat snapshot (read-only; zoom, date, work and chat_search only)\n\n${view.render}`;
	pi.on("before_agent_start", (event, current) =>
		attached(current) ? { systemPrompt: [...event.systemPrompt, block] } : undefined,
	);
}
