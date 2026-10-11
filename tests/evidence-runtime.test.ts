import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../scripts/evidence/options.ts";
import { childEnvironment, copySelectedAuth, createIsolatedDirs } from "../scripts/evidence/isolation.ts";
import { findPrivateContextMarkers, parseParentSubstrings } from "../scripts/evidence/preflight.ts";
import { isOriginalPage, observeTurn, readAdmissionDispatched, readTreeStructure, treeLevels, type Frame } from "../scripts/evidence/host.ts";

const BASE = ["--main", "openrouter/main-model", "--compressor", "openrouter/compressor-model"];

async function withDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "evidence-runtime-"));
	try {
		return await action(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function assistantCall(callId: string, args: Frame, name = "zoom", extra: Frame = {}): Frame {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], ...extra },
	};
}

function toolResult(callId: string, text: string, extra: Frame = {}): Frame {
	return {
		type: "message_end",
		message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }, { type: "text", text: "envelope" }], ...extra },
	};
}

describe("saved tree structure", () => {
	test("levels are the stored part levels, not logarithms of part lengths", async () => {
		await withDirectory(async (directory) => {
			// Length 24 = 16 + 8: part [level, index] spans [index * 2^level, (index + 1) * 2^level).
			const view = { version: 2, length: 24, parts: [[4, 0], [3, 2]], compacting: false, compactor: { length: 24, parts: [[4, 0], [3, 2]], compacting: false } };
			await writeFile(join(directory, "view.json"), JSON.stringify(view));
			const structure = await readTreeStructure(directory);
			expect(structure?.levels).toEqual([3, 4]);
			expect(structure?.mainParts).toBe(2);
			expect(structure?.compactorLength).toBe(24);
		});
	});

	test("level-zero leaves are not tree-node levels and a v1 snapshot is not read", async () => {
		expect(treeLevels([[0, 0], [0, 1], [1, 0]])).toEqual([1]);
		expect(treeLevels([[2, 0], [2, 1]])).toEqual([2]);
		await withDirectory(async (directory) => {
			await writeFile(join(directory, "view.json"), JSON.stringify({ version: 1, length: 2, parts: [[0, 0], [0, 1]], compacting: false }));
			expect(await readTreeStructure(directory)).toBeNull();
		});
	});

	test("no saved view yields null, not an empty tree", async () => {
		await withDirectory(async (directory) => {
			expect(await readTreeStructure(directory)).toBeNull();
		});
	});
});

describe("original retrieval pages", () => {
	test("only n=1 zoom and non-error work results qualify as original pages", () => {
		expect(isOriginalPage("zoom", { id: 3, n: 1 }, {})).toBe(true);
		expect(isOriginalPage("zoom", { id: 3, n: 2 }, {})).toBe(false);
		expect(isOriginalPage("zoom", { id: 3, n: 1 }, { isError: true })).toBe(false);
		expect(isOriginalPage("work", { name: "W" }, {})).toBe(true);
		expect(isOriginalPage("work", { name: "W" }, { isError: true })).toBe(false);
		expect(isOriginalPage("read", {}, {})).toBe(false);
	});

	test("an observed turn keeps original pages and drops summaries and errors", () => {
		const events: Frame[] = [
			assistantCall("c1", { id: 3, n: 1 }),
			toolResult("c1", "REF-1-3 original sentence"),
			assistantCall("c2", { id: 4, n: 2 }),
			toolResult("c2", "a child summary"),
			assistantCall("c3", { id: 5, n: 1 }),
			toolResult("c3", "error text", { isError: true }),
			assistantCall("c4", { name: "W" }, "work"),
			toolResult("c4", "W-1 result", { details: { messageId: 7 } }),
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{\"answers\":[]}" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
		];
		const observed = observeTurn(events, null);
		expect(observed.pages).toEqual([
			{ recordId: 3, text: "REF-1-3 original sentence" },
			{ recordId: 7, text: "W-1 result" },
		]);
		expect(observed.zoomCalls.map((call) => call.n)).toEqual([1, 2, 1]);
		expect(observed.assistantMessages).toBe(5);
		expect(observed.answer).toBe("{\"answers\":[]}");
	});
});

describe("usage cost provenance", () => {
	const message = (usage: Frame): Frame => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], usage } });
	const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };

	test("an SDK-reported total is sdk-reported, never a provider invoice", () => {
		const [record] = observeTurn([message({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } })], price).usage;
		expect(record?.costSource).toBe("sdk-reported");
		expect(record?.costUsd).toBe(0.5);
	});

	test("a missing SDK cost with a catalog price is a catalog estimate; without a price it is unavailable", () => {
		const [estimated] = observeTurn([message({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })], price).usage;
		expect(estimated?.costSource).toBe("catalog-estimate");
		expect(estimated?.costUsd).toBe(1);
		const [unknown] = observeTurn([message({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })], null).usage;
		expect(unknown?.costSource).toBe("unavailable");
		expect(unknown?.costUsd).toBeNull();
		expect(unknown?.latencyMs).toBeNull();
	});
});

describe("strict command-line parsing", () => {
	test("the default corpus is self-consistent: three projects with twenty-four sources", () => {
		const options = parseOptions(BASE);
		expect(options.projects).toBe(3);
		expect(options.sourceCount).toBe(24);
		expect(options.scenarios).toEqual(["cold"]);
		expect(options.allowEnv).toEqual([]);
	});

	test("four projects need twenty-five fact records and cannot fit the twenty-four source maximum", () => {
		expect(() => parseOptions([...BASE, "--projects", "4"])).toThrow("needs 25 fact records");
		expect(() => parseOptions([...BASE, "--projects", "4", "--sources", "24"])).toThrow("needs 25 fact records");
		expect(() => parseOptions([...BASE, "--sources", "25"])).toThrow("from 16 to 24");
	});

	test("unknown, duplicate, and valueless flags fail before any side effect", () => {
		expect(() => parseOptions([...BASE, "--no-such-flag", "1"])).toThrow("unknown flag");
		expect(() => parseOptions([...BASE, "--seed", "1", "--seed", "2"])).toThrow("duplicate flag");
		expect(() => parseOptions([...BASE, "--seed"])).toThrow("requires a value");
		expect(() => parseOptions([...BASE, "--force", "--force"])).toThrow("duplicate flag");
	});

	test("scenario options must match their scenario", () => {
		expect(() => parseOptions([...BASE, "--scenarios", "expiry"])).toThrow("--expiry-wait-ms is required");
		expect(() => parseOptions([...BASE, "--expiry-wait-ms", "1000"])).toThrow("rejected without it");
		expect(() => parseOptions([...BASE, "--scenarios", "model-change"])).toThrow("--model-change is required");
		expect(() => parseOptions([...BASE, "--model-change", "openrouter/other"])).toThrow("rejected without it");
	});

	test("allowed environment names are explicit provider variables, never isolation or wildcard names", () => {
		expect(parseOptions([...BASE, "--allow-env", "OPENROUTER_API_KEY"]).allowEnv).toEqual(["OPENROUTER_API_KEY"]);
		expect(() => parseOptions([...BASE, "--allow-env", "HOME"])).toThrow("rejects");
		expect(() => parseOptions([...BASE, "--allow-env", "PI_CODING_AGENT_DIR"])).toThrow("rejects");
		expect(() => parseOptions([...BASE, "--allow-env", "*_API_KEY"])).toThrow("rejects");
	});

	test("model selectors must be provider/model", () => {
		expect(() => parseOptions(["--main", "@smol", "--compressor", "openrouter/b"])).toThrow("provider/model");
	});
});

describe("child environment isolation", () => {
	test("a rogue parent secret is absent while essentials and the explicit allowance remain", () => {
		return withDirectory(async (directory) => {
			const dirs = await createIsolatedDirs(join(directory, "run"));
			const parent: Record<string, string> = {
				PATH: "/usr/bin",
				LANG: "C.UTF-8",
				ROGUE_PROVIDER_SECRET: "rogue-secret-value",
				OPENAI_API_KEY: "should-not-pass",
				ALLOWED_PROVIDER_KEY: "explicit-allowance",
				HOME: "/home/operator",
				PI_CODING_AGENT_DIR: "/home/operator/.omp/agent",
			};
			const env = childEnvironment(parent, dirs, ["ALLOWED_PROVIDER_KEY"]);
			expect(env.PATH).toBe("/usr/bin");
			expect(env.LANG).toBe("C.UTF-8");
			expect(env.ALLOWED_PROVIDER_KEY).toBe("explicit-allowance");
			expect(env.ROGUE_PROVIDER_SECRET).toBeUndefined();
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.HOME).toBe(dirs.home);
			expect(env.PI_CODING_AGENT_DIR).toBe(dirs.agentDir);
			expect(env.XDG_CONFIG_HOME).toBe(dirs.xdgConfig);
			expect(Object.values(env).join("\n")).not.toContain("/home/operator");
		});
	});

	test("an allowed variable that the runner does not have fails closed", () => {
		return withDirectory(async (directory) => {
			const dirs = await createIsolatedDirs(join(directory, "run"));
			expect(() => childEnvironment({ PATH: "/usr/bin" }, dirs, ["MISSING_KEY"])).toThrow("is not set");
		});
	});

	test("an absent source store copies nothing and reports every selected provider as missing", async () => {
		await withDirectory(async (directory) => {
			const target = join(directory, "target");
			const copied = await copySelectedAuth(join(directory, "no-such-agent"), target, ["openrouter", "openrouter"]);
			expect(copied).toEqual({ copied: [], missing: ["openrouter"] });
			expect(existsSync(join(target, "agent.db"))).toBe(false);
		});
	});
});

describe("effective prompt preflight", () => {
	test("instruction files and memory blocks are reported by label, never by matched text", () => {
		expect(findPrivateContextMarkers(["base prompt", "AGENTS.md says do X"], [])).toEqual(["AGENTS.md"]);
		expect(findPrivateContextMarkers(["<user-memory>secret fact</user-memory>"], [])).toEqual(["<user-memory"]);
		const found = findPrivateContextMarkers(["cwd /home/operator/project"], ["/home/operator"]);
		expect(found).toEqual(["parent-path-1"]);
		expect(found.join(" ")).not.toContain("operator");
	});

	test("a clean prompt passes and parent paths must be a JSON string array", () => {
		expect(findPrivateContextMarkers(["You are a careful assistant.", "Synthetic history only."], ["/home/operator"])).toEqual([]);
		expect(parseParentSubstrings(undefined)).toEqual([]);
		expect(parseParentSubstrings("[\"/a\",\"/b\"]")).toEqual(["/a", "/b"]);
		expect(() => parseParentSubstrings("{\"path\":\"/a\"}")).toThrow("JSON string array");
		expect(() => parseParentSubstrings("not json")).toThrow();
	});
});

describe("admission counter", () => {
	test("a well-formed counter reads back exactly; a malformed one fails closed", async () => {
		await withDirectory(async (directory) => {
			const file = join(directory, "admission.json");
			await writeFile(file, JSON.stringify({ dispatched: 3 }));
			expect(await readAdmissionDispatched(file)).toBe(3);
			await writeFile(file, JSON.stringify({ dispatched: -1 }));
			await expect(readAdmissionDispatched(file)).rejects.toThrow("malformed");
			await writeFile(file, "not json");
			await expect(readAdmissionDispatched(file)).rejects.toThrow();
		});
	});
});
