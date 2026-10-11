import { describe, expect, test } from "bun:test";
import { launchArgs, type HostLaunch } from "../scripts/evidence/host.ts";
import { startOfflineServer, type FixtureReply } from "../scripts/evidence/offline-server.ts";

const EXTENSION = "/ext/evidence-extension.ts";

const LAUNCH: HostLaunch = {
	omp: "omp",
	plugin: "/plugin",
	memory: "/memory",
	sessionDir: "/sessions",
	cwd: "/cwd",
	main: "openrouter/main-model",
	compressor: "openrouter/compressor-model",
	metricsFile: "/metrics.jsonl",
	admissionFile: "/admission.json",
	allowance: 80,
	usdAllowance: 1,
	usdPerCall: 0.01,
	compressorMaxTokens: 512,
	viewBytes: 4096,
	env: {},
	optchat: true,
	extraArgs: [],
	tools: null,
};

const DEFAULT_ARGS = [
	"--mode", "rpc", "--no-ui", "--no-title", "--no-tools", "--no-skills", "--no-rules", "--no-extensions",
	"-e", EXTENSION,
	"--session-dir", "/sessions",
	"--model", "openrouter/main-model",
	"--optchat-model", "openrouter/compressor-model",
	"--optchat-dir", "/memory",
	"--optchat-view-bytes", "4096",
];

describe("host launch contract", () => {
	test("defaults keep the existing argv exactly", () => {
		expect(launchArgs(LAUNCH, EXTENSION)).toEqual(DEFAULT_ARGS);
	});

	test("optchat:false adds --no-optchat and keeps the extension", () => {
		const args = launchArgs({ ...LAUNCH, optchat: false }, EXTENSION);
		expect(args).toContain("--no-optchat");
		expect(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2)).toEqual(["-e", EXTENSION]);
		expect(args).toEqual([...DEFAULT_ARGS, "--no-optchat"]);
	});

	test("a tool list replaces --no-tools in place with --tools <csv>", () => {
		const args = launchArgs({ ...LAUNCH, tools: ["task", "work"] }, EXTENSION);
		expect(args).not.toContain("--no-tools");
		const at = args.indexOf("--tools");
		expect(at).toBe(4);
		expect(args[at + 1]).toBe("task,work");
		expect(args.slice(0, 4)).toEqual(["--mode", "rpc", "--no-ui", "--no-title"]);
		expect(args.slice(6)).toEqual(DEFAULT_ARGS.slice(5));
	});

	test("an empty tool list is rejected rather than launching with --tools \"\"", () => {
		expect(() => launchArgs({ ...LAUNCH, tools: [] }, EXTENSION)).toThrow(RangeError);
	});

	test("extraArgs are appended after the standard arguments", () => {
		const args = launchArgs({ ...LAUNCH, extraArgs: ["--optchat-child-view"] }, EXTENSION);
		expect(args).toEqual([...DEFAULT_ARGS, "--optchat-child-view"]);
	});
});

async function post(baseUrl: string, body: unknown): Promise<Response> {
	return fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("offline fixture server", () => {
	test("serves scripted SSE to a fixture model and records the request", async () => {
		const seen: string[] = [];
		const reply = (request: { model: string | null }): FixtureReply => {
			seen.push(request.model ?? "");
			return { text: "scripted answer" };
		};
		const server = await startOfflineServer({ reply });
		try {
			expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
			const response = await post(server.baseUrl, { model: "optchat-smoke-chat", stream: true, messages: [] });
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			const text = await response.text();
			expect(text).toContain("scripted answer");
			expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
			expect(seen).toEqual(["optchat-smoke-chat"]);
			expect(server.requests.length).toBe(1);
			expect(server.violations).toEqual([]);
		} finally {
			await server.close();
		}
	});

	test("accepts the optchat-smoke/<model> namespace", async () => {
		const server = await startOfflineServer({ reply: () => ({ text: "ok" }) });
		try {
			const response = await post(server.baseUrl, { model: "optchat-smoke/optchat-smoke-compact", stream: true });
			expect(response.status).toBe(200);
			expect(server.violations).toEqual([]);
		} finally {
			await server.close();
		}
	});

	test("refuses a non-fixture model with HTTP 500 before the reply hook runs", async () => {
		let calls = 0;
		const server = await startOfflineServer({
			reply: () => {
				calls += 1;
				return { text: "must not be served" };
			},
		});
		try {
			const response = await post(server.baseUrl, { model: "openrouter/main-model", stream: true });
			expect(response.status).toBe(500);
			expect(await response.text()).not.toContain("must not be served");
			expect(calls).toBe(0);
			expect(server.requests.map((request) => request.model)).toEqual(["openrouter/main-model"]);
			expect(server.violations).toEqual(["non-fixture model openrouter/main-model"]);
		} finally {
			await server.close();
		}
	});

	test("refuses an unscripted route", async () => {
		const server = await startOfflineServer({ reply: () => ({ text: "x" }) });
		try {
			const response = await fetch(`${server.baseUrl.replace("/v1", "")}/v1/models`);
			expect(response.status).toBe(404);
			expect(server.violations.length).toBe(1);
		} finally {
			await server.close();
		}
	});

	test("a throwing reply hook is refused and recorded with its reason", async () => {
		const server = await startOfflineServer({
			reply: () => {
				throw new Error("script exhausted");
			},
		});
		try {
			const response = await post(server.baseUrl, { model: "optchat-smoke-child", stream: true });
			expect(response.status).toBe(500);
			expect(server.violations).toEqual(["reply hook failed: script exhausted"]);
		} finally {
			await server.close();
		}
	});

	test("close resolves and the port stops accepting connections", async () => {
		const server = await startOfflineServer({ reply: () => ({ text: "x" }) });
		const url = server.baseUrl;
		await server.close();
		await expect(post(url, { model: "optchat-smoke-chat" })).rejects.toThrow();
	});
});
