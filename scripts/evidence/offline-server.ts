import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-process loopback Chat Completions endpoint for fixture mode. Every request is recorded. Only
 * fixture models (`optchat-smoke-*` wire ids or `optchat-smoke/*`) reach the injected reply hook;
 * anything else, from any non-loopback peer, or on any other route is refused with HTTP 500 and
 * recorded as a violation. Nothing is served except what `reply` scripts.
 */

export interface FixtureRequest {
	readonly sequence: number;
	readonly method: string;
	readonly path: string;
	readonly model: string | null;
	readonly body: Record<string, unknown> | null;
}

export interface FixtureReply {
	readonly text?: string;
	readonly thinking?: string;
	/** Complete OpenAI tool_calls entries, including `index`, `id`, `type`, and `function`. */
	readonly toolCalls?: readonly Record<string, unknown>[];
}

export interface OfflineServerOptions {
	readonly reply: (request: FixtureRequest) => FixtureReply | Promise<FixtureReply>;
}

export interface OfflineServer {
	readonly baseUrl: string;
	readonly requests: readonly FixtureRequest[];
	readonly violations: readonly string[];
	close(): Promise<void>;
}

const FIXTURE_MODEL = /^optchat-smoke[-/]/;
const CHAT_PATH = "/v1/chat/completions";
const LOOPBACK: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };

export async function startOfflineServer(options: OfflineServerOptions): Promise<OfflineServer> {
	const requests: FixtureRequest[] = [];
	const violations: string[] = [];
	const server = createServer((request, response) => {
		void handle(request, response, options.reply, requests, violations).catch((error: unknown) => {
			if (response.headersSent) response.destroy();
			else refuse(response, violations, `handler failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		violations,
		close() {
			const closed = Promise.withResolvers<void>();
			server.close((error) => (error ? closed.reject(error) : closed.resolve()));
			server.closeAllConnections();
			return closed.promise;
		},
	};
}

async function handle(
	request: IncomingMessage,
	response: ServerResponse,
	reply: OfflineServerOptions["reply"],
	requests: FixtureRequest[],
	violations: string[],
): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const path = request.url ?? "";
	const sequence = requests.length + 1;
	const remote = request.socket.remoteAddress ?? "";
	const body = parseBody(chunks);
	const model = typeof body?.model === "string" ? body.model : null;
	const record: FixtureRequest = { sequence, method: request.method ?? "", path, model, body };
	requests.push(record);
	if (LOOPBACK[remote] !== true) return refuse(response, violations, `non-loopback peer ${remote}`);
	if (request.method !== "POST" || path !== CHAT_PATH) return refuse(response, violations, `unscripted route ${request.method} ${path}`, 404);
	if (model === null || !FIXTURE_MODEL.test(model)) return refuse(response, violations, `non-fixture model ${model ?? "<none>"}`);
	let scripted: FixtureReply;
	try {
		scripted = await reply(record);
	} catch (error) {
		return refuse(response, violations, `reply hook failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	response.end(sseBody(model, sequence, scripted));
}

function parseBody(chunks: readonly Buffer[]): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function refuse(response: ServerResponse, violations: string[], reason: string, status = 500): void {
	violations.push(reason);
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { message: "optchat fixture refused request", type: "fixture_refused" } }));
}

function sseBody(model: string, sequence: number, reply: FixtureReply): string {
	const id = `chatcmpl-optchat-offline-${sequence}`;
	const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const calls = reply.toolCalls ?? [];
	const data = [chunk({ role: "assistant" })];
	if (reply.thinking) data.push(chunk({ reasoning_content: reply.thinking }));
	if (reply.text) data.push(chunk({ content: reply.text }));
	if (calls.length > 0) data.push(chunk({ tool_calls: calls }));
	data.push(chunk({}, calls.length > 0 ? "tool_calls" : "stop"));
	data.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 128, completion_tokens: 128, total_tokens: 256, completion_tokens_details: { reasoning_tokens: reply.thinking ? 8 : 0 } } })}\n\n`);
	data.push("data: [DONE]\n\n");
	return data.join("");
}
