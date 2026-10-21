import { describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	adoptChildSource,
	attachChildView,
	publishChildSource,
	registerMemoryTools,
	UNGUARDED,
	type ChildView,
	type MemoryReader,
} from "../src/handoff.ts";
import type { SearchResult } from "../src/memory.ts";

// Tool registration builds schemas through pi.zod; these tests call each tool's execute directly.
const schemaStub: unknown = new Proxy(() => schemaStub, { get: () => schemaStub, apply: () => schemaStub });

interface ToolResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
}

interface Tool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: undefined,
		update?: undefined,
		current?: ExtensionContext,
	) => Promise<ToolResult>;
}

function harness() {
	const tools = new Map<string, Tool>();
	type Hook = (
		event: { systemPrompt: string[] },
		current: ExtensionContext | undefined,
	) => { systemPrompt: string[] } | undefined;
	const hooks: Hook[] = [];
	const pi = {
		zod: schemaStub,
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		on: (_name: string, handler: Hook) => hooks.push(handler),
	};
	return { pi: pi as unknown as ExtensionAPI, tools, hooks };
}

function context(
	manager: object | null,
	notices: string[] = [],
	getSessionId: () => string = () => "test-session",
): ExtensionContext {
	return {
		sessionManager: { getArtifactManager: () => manager, getSessionId },
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;
}

const SOURCE = "0123456789";
const IMAGE = { data: "aGVsbG8=", mimeType: "image/png" };

/** Pages of four bytes; the message's image rides with its first page only. */
const reader: MemoryReader = {
	zoom: (_id, _n, offset) => ({
		text: SOURCE.slice(offset, offset + 4),
		next: offset + 4 < SOURCE.length ? offset + 4 : null,
		totalBytes: SOURCE.length,
		offset,
		...(offset === 0 ? { images: [IMAGE] } : {}),
	}),
	date: () => "2026-10-11 00:00",
	work: (name, offset) => ({
		page: { text: `report ${name}`, next: null, totalBytes: 13, offset },
		messageId: 7,
		source: "task",
		completeness: "full",
	}),
	search: () => ({ hits: [], next: null }),
};

const view = (render: string): ChildView => ({ ...reader, render, upperBound: 2 });

describe("paged memory tools", () => {
	test("zoom pages reassemble the source exactly, following the cursor", async () => {
		const { pi, tools } = harness();
		registerMemoryTools(pi, reader, UNGUARDED);
		const zoom = tools.get("zoom")!;
		let offset = 0;
		let assembled = "";
		for (let pages = 0; pages < 10; pages++) {
			const result = await zoom.execute("call", { id: 0, n: 1, offset });
			assembled += result.content[0]!.text;
			const details = result.details as { next: number | null };
			if (details.next === null) break;
			offset = details.next;
		}
		expect(assembled).toBe(SOURCE);
	});

	test("the cursor envelope is a separate content part, not part of the page bytes", async () => {
		const { pi, tools } = harness();
		registerMemoryTools(pi, reader, UNGUARDED);
		const first = await tools.get("zoom")!.execute("call", { id: 0, n: 1, offset: 0 });
		expect(first.content[0]!.text).toBe("0123");
		expect(first.content[1]!.text).toBe("[bytes 0-4 of 10; next offset 4]");
		const last = await tools.get("zoom")!.execute("call", { id: 0, n: 1, offset: 8 });
		expect(last.content[0]!.text).toBe("89");
		expect(last.content[1]!.text).toBe("[end of 10 bytes]");
	});

	test("a stored image is returned as an image part with the first page only", async () => {
		const { pi, tools } = harness();
		registerMemoryTools(pi, reader, UNGUARDED);
		const first = await tools.get("zoom")!.execute("call", { id: 0, n: 1, offset: 0 });
		expect(first.content.filter((part) => part.type === "image")).toEqual([
			{ type: "image", data: IMAGE.data, mimeType: IMAGE.mimeType },
		]);
		const later = await tools.get("zoom")!.execute("call", { id: 0, n: 1, offset: 4 });
		expect(later.content.some((part) => part.type === "image")).toBe(false);
	});

	test("a tool call's page ends with a pointer to its result, while the page bytes stay exact", async () => {
		const call: MemoryReader = {
			...reader,
			zoom: (id, _n, offset) => ({ text: SOURCE.slice(offset, offset + 4), next: offset + 4 < SOURCE.length ? offset + 4 : null, totalBytes: SOURCE.length, offset, ...(id === 11 ? { result: 12 } : {}) }),
		};
		const { pi, tools } = harness();
		registerMemoryTools(pi, call, UNGUARDED);
		const result = await tools.get("zoom")!.execute("call", { id: 11, n: 1, offset: 8 });
		expect(result.content[0]!.text).toBe("89");
		expect(result.content.map((part) => part.text)).toContain("[result: message 12]");
		expect((result.details as { result?: number }).result).toBe(12);
		const plain = await tools.get("zoom")!.execute("call", { id: 0, n: 1, offset: 8 });
		expect(plain.content.some((part) => part.text?.includes("[result:"))).toBe(false);
	});

	test("a summary zoom with n above 1 refuses any byte offset", async () => {
		const { pi, tools } = harness();
		registerMemoryTools(pi, reader, UNGUARDED);
		await expect(tools.get("zoom")!.execute("call", { id: 0, n: 2, offset: 4 })).rejects.toThrow(/offset applies only/);
	});

	test("work returns a named report's page with its messageId and provenance", async () => {
		const { pi, tools } = harness();
		registerMemoryTools(pi, reader, UNGUARDED);
		const result = await tools.get("work")!.execute("call", { name: "agent-a" });
		expect(result.content[0]!.text).toBe("report agent-a");
		expect(result.details).toMatchObject({ messageId: 7, source: "task", completeness: "full" });
	});
});

describe("search tool", () => {
	const searching = (answer: SearchResult, seen: Array<[string, unknown]>): MemoryReader => ({
		...reader,
		search: (query, options) => {
			seen.push([query, options]);
			return answer;
		},
	});

	test("renders the header, one line per hit and the older-hits cursor, with ids and next in details", async () => {
		const seen: Array<[string, unknown]> = [];
		const { pi, tools } = harness();
		registerMemoryTools(pi, searching({ hits: [{ id: 9, kind: "talk", date: "d", snippet: "the path /tmp/a" }], next: 9 }, seen), UNGUARDED);
		const result = await tools.get("chat_search")!.execute("call", { text: " path\n /tmp/a ", kind: "talk", before: 12 });
		expect(seen).toEqual([[" path\n /tmp/a ", { kind: "talk", before: 12 }]]);
		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: '[optchat search] 1 hits for "path /tmp/a" (newest first)\n9|talk|the path /tmp/a\n[older hits: before=9]',
				},
			],
			details: { hits: [9], next: 9 },
		});
	});

	test("zero hits still return the header and a final no-older-hits line", async () => {
		const seen: Array<[string, unknown]> = [];
		const { pi, tools } = harness();
		registerMemoryTools(pi, searching({ hits: [], next: null }, seen), UNGUARDED);
		const result = await tools.get("chat_search")!.execute("call", { text: "nothing" });
		expect(result).toEqual({
			content: [{ type: "text", text: '[optchat search] 0 hits for "nothing" (newest first)\n[no older hits]' }],
			details: { hits: [], next: null },
		});
	});

	test("a zero-hit multi-word search lists how many messages hold each word, in the result and its details", async () => {
		const termCounts = [
			{ term: "staging", messages: 12 },
			{ term: "vault", messages: 0 },
		];
		const { pi, tools } = harness();
		registerMemoryTools(pi, searching({ hits: [], next: null, termCounts }, []), UNGUARDED);
		const result = await tools.get("chat_search")!.execute("call", { text: "staging vault" });
		const text = result.content[0]!.text!;
		expect(text).toContain('"staging" 12');
		expect(text).toContain('"vault" 0');
		expect(text).not.toContain("chat_recall");
		expect(result.details).toEqual({ hits: [], next: null, termCounts });
	});

	test("the zero-hit result suggests chat_recall only while the session has that tool", async () => {
		const answer: SearchResult = { hits: [], next: null, termCounts: [{ term: "a", messages: 1 }, { term: "b", messages: 2 }] };
		let registered = false;
		const { pi, tools } = harness();
		registerMemoryTools(pi, searching(answer, []), UNGUARDED, () => registered);
		const search = tools.get("chat_search")!;
		expect((await search.execute("call", { text: "a b" })).content[0]!.text).not.toContain("chat_recall");
		registered = true;
		expect((await search.execute("call", { text: "a b" })).content[0]!.text).toContain("chat_recall");
	});

	test("a result with hits carries no word counts", async () => {
		const { pi, tools } = harness();
		registerMemoryTools(pi, searching({ hits: [{ id: 3, kind: "talk", date: "d", snippet: "a b" }], next: null }, []), UNGUARDED, () => true);
		const result = await tools.get("chat_search")!.execute("call", { text: "a b" });
		expect(result.content[0]!.text).not.toContain("containing each word");
		expect(result.details).toEqual({ hits: [3], next: null });
	});

	test("the schema refuses before = 0, which can never match, and accepts 1", () => {
		const real = { zod, registerTool: (tool: Tool) => void realTools.set(tool.name, tool), on: () => {} };
		const realTools = new Map<string, Tool>();
		registerMemoryTools(real as unknown as ExtensionAPI, reader, UNGUARDED);
		const parameters = (realTools.get("chat_search") as unknown as {
			parameters: { safeParse(value: unknown): { success: boolean } };
		}).parameters;
		expect(parameters.safeParse({ text: "x", before: 0 }).success).toBe(false);
		expect(parameters.safeParse({ text: "x", before: 1 }).success).toBe(true);
		expect(parameters.safeParse({ text: "x" }).success).toBe(true);
	});

	test("an admission failure stops the search before it reads", async () => {
		const seen: Array<[string, unknown]> = [];
		const { pi, tools } = harness();
		registerMemoryTools(pi, searching({ hits: [], next: null }, seen), () => {
			throw new Error("denied");
		});
		await expect(tools.get("chat_search")!.execute("call", { text: "x" })).rejects.toThrow(/denied/);
		expect(seen).toEqual([]);
	});
});

describe("child bridge admission", () => {
	test("a child session ID change denies reads and prompt hooks while retaining its artifact manager", async () => {
		const manager = {};
		let sessionId = "test-session";
		const current = context(manager, [], () => sessionId);
		const calls = { zoom: 0, date: 0, work: 0 };
		const counted: MemoryReader = {
			zoom: (id, n, offset) => {
				calls.zoom++;
				return reader.zoom(id, n, offset, 1);
			},
			date: (id) => {
				calls.date++;
				return reader.date(id);
			},
			work: (name, offset) => {
				calls.work++;
				return reader.work(name, offset);
			},
			search: (query, options) => reader.search(query, options),
		};
		const retained: ChildView = {
			...counted,
			render: "<chat>\n0+1|user: distinctive retained parent snapshot\n</chat>",
			upperBound: 2,
		};
		const { pi, tools, hooks } = harness();
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => retained });
		try {
			attachChildView(pi, current, "guide");
			expect(await tools.get("zoom")!.execute("call", { id: 0, n: 1, offset: 0 }, undefined, undefined, current)).toEqual({
				content: [
					{ type: "text", text: "0123" },
					{ type: "text", text: "[bytes 0-4 of 10; next offset 4]" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				details: { offset: 0, next: 4, totalBytes: 10 },
			});
			expect(await tools.get("date")!.execute("call", { id: 0 }, undefined, undefined, current)).toEqual({
				content: [{ type: "text", text: "2026-10-11 00:00" }],
			});
			expect(await tools.get("work")!.execute("call", { name: "agent-a" }, undefined, undefined, current)).toEqual({
				content: [
					{ type: "text", text: "report agent-a" },
					{ type: "text", text: "[end of 13 bytes]" },
				],
				details: { offset: 0, next: null, totalBytes: 13, messageId: 7, source: "task", completeness: "full" },
			});
			expect(hooks.length).toBeGreaterThan(0);
			for (const hook of hooks) {
				expect(hook({ systemPrompt: ["base"] }, current)).toEqual({
					systemPrompt: [
						"base",
						"guide\n\n# Parent chat snapshot (read-only; zoom, date, work and chat_search only)\n\n<chat>\n0+1|user: distinctive retained parent snapshot\n</chat>",
					],
				});
			}
			expect(calls).toEqual({ zoom: 1, date: 1, work: 1 });
			sessionId = "child-switched";
			await expect(
				tools.get("zoom")!.execute("call", { id: 0, n: 1, offset: 0 }, undefined, undefined, current),
			).rejects.toThrow(/not attached/);
			await expect(tools.get("date")!.execute("call", { id: 0 }, undefined, undefined, current)).rejects.toThrow(/not attached/);
			await expect(tools.get("work")!.execute("call", { name: "agent-a" }, undefined, undefined, current)).rejects.toThrow(
				/not attached/,
			);
			for (const hook of hooks) {
				expect(hook({ systemPrompt: ["base"] }, current)).toBeUndefined();
			}
			expect(calls).toEqual({ zoom: 1, date: 1, work: 1 });
		} finally {
			revoke();
		}
	});

	test("a child that switches to its own session loses the parent view for reads and prompt turns", async () => {
		const manager = {};
		const other = {};
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => view("<chat>\n0+1|user: hi\n</chat>") });
		const { pi, tools, hooks } = harness();
		attachChildView(pi, context(manager), "guide");
		const zoom = tools.get("zoom")!;
		const before = await zoom.execute("call", { id: 0, n: 1, offset: 0 }, undefined, undefined, context(manager));
		expect(before.content[0]!.text).toBe("0123");
		// The switch keeps this child's tools and prompt hook, but the child now adopts a different manager.
		const switched = context(other);
		await expect(zoom.execute("call", { id: 0, n: 1, offset: 0 }, undefined, undefined, switched)).rejects.toThrow(/not attached/);
		expect(hooks[0]!({ systemPrompt: ["base"] }, switched)).toBeUndefined();
		revoke();
	});

	test("a revoked parent view ends prompt injection on later child turns, not only at attachment", () => {
		const manager = {};
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => view("<chat/>") });
		const { pi, hooks } = harness();
		attachChildView(pi, context(manager), "guide");
		expect(hooks[0]!({ systemPrompt: ["base"] }, context(manager))?.systemPrompt.join("\n")).toContain("guide");
		revoke();
		expect(hooks[0]!({ systemPrompt: ["base"] }, context(manager))).toBeUndefined();
	});

	test("a revoked parent view ends tool reads on later child turns", async () => {
		const manager = {};
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => view("<chat/>") });
		const { pi, tools } = harness();
		attachChildView(pi, context(manager), "guide");
		revoke();
		await expect(
			tools.get("zoom")!.execute("call", { id: 0, n: 1, offset: 0 }, undefined, undefined, context(manager)),
		).rejects.toThrow(/revoked|not attached/);
	});

	test("a tool read without the calling session's context is refused", async () => {
		const manager = {};
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => view("<chat/>") });
		const { pi, tools } = harness();
		attachChildView(pi, context(manager), "guide");
		await expect(tools.get("date")!.execute("call", { id: 0 })).rejects.toThrow(/not attached/);
		revoke();
	});
});

describe("read-only child bridge", () => {
	test("a view is adopted only from the manager that published it: another root sees nothing", () => {
		const parentRoot = {};
		const otherRoot = {};
		const revoke = publishChildSource(parentRoot, { owner: "parent-session", snapshot: () => view("<chat/>") });
		expect(adoptChildSource(otherRoot)).toBeUndefined();
		expect(adoptChildSource(parentRoot)?.owner).toBe("parent-session");
		revoke();
	});

	test("a second publication on the same manager is refused", () => {
		const manager = {};
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => view("") });
		expect(() => publishChildSource(manager, { owner: "parent", snapshot: () => view("") })).toThrow(/already published/);
		revoke();
	});

	test("revocation ends snapshots already taken: their next read throws and their contents stay fixed", () => {
		const manager = {};
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => view("frozen") });
		const snapshot = adoptChildSource(manager)!.snapshot();
		expect(snapshot.render).toBe("frozen");
		expect(snapshot.zoom(0, 1, 0, 1).text).toBe("0123");
		revoke();
		expect(() => snapshot.zoom(0, 1, 0, 1)).toThrow(/revoked/);
		expect(() => snapshot.date(0)).toThrow(/revoked/);
		expect(() => snapshot.work("agent-a", 0)).toThrow(/revoked/);
		expect(adoptChildSource(manager)).toBeUndefined();
	});

	test("a revoked publication cannot remove its successor", () => {
		const manager = {};
		const first = publishChildSource(manager, { owner: "first", snapshot: () => view("1") });
		first();
		const second = publishChildSource(manager, { owner: "second", snapshot: () => view("2") });
		first();
		expect(adoptChildSource(manager)?.owner).toBe("second");
		second();
	});

	test("a child without a published view registers no tools and no prompt", () => {
		const { pi, tools, hooks } = harness();
		attachChildView(pi, context({}), "guide");
		expect(tools.size).toBe(0);
		expect(hooks).toHaveLength(0);
	});

	test("a child with the view registers exactly the read-only tools and the frozen prompt", () => {
		const { pi, tools, hooks } = harness();
		const manager = {};
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => view("<chat>\n0+1|user: hi\n</chat>") });
		attachChildView(pi, context(manager), "guide");
		expect([...tools.keys()].sort()).toEqual(["chat_search", "date", "work", "zoom"]);
		const prompt = (hooks[0]!({ systemPrompt: ["base"] }, context(manager))?.systemPrompt ?? []).join("\n");
		expect(prompt).toContain("base");
		expect(prompt).toContain("guide");
		expect(prompt).toContain("0+1|user: hi");
		revoke();
	});

	test("a grandchild on the same adopted manager gets the same read-only surface", () => {
		const manager = {};
		const revoke = publishChildSource(manager, { owner: "parent", snapshot: () => view("") });
		const child = harness();
		const grandchild = harness();
		attachChildView(child.pi, context(manager), "guide");
		attachChildView(grandchild.pi, context(manager), "guide");
		expect([...grandchild.tools.keys()].sort()).toEqual([...child.tools.keys()].sort());
		revoke();
	});

	test("a snapshot that cannot be taken is reported and registers nothing", () => {
		const { pi, tools, hooks } = harness();
		const manager = {};
		const revoke = publishChildSource(manager, {
			owner: "parent",
			snapshot: () => {
				throw new Error("the parent chat is closed");
			},
		});
		const notices: string[] = [];
		attachChildView(pi, context(manager, notices), "guide");
		expect(tools.size).toBe(0);
		expect(hooks).toHaveLength(0);
		expect(notices[0]).toContain("the parent chat is closed");
		revoke();
	});
});
