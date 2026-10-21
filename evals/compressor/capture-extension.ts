/**
 * Loaded into a real `omp` by evals/compressor/capture.ts. Points the `anthropic` provider at the driver's loopback
 * endpoint (the host keeps its own request encoder, credential and OAuth handling) and, on the first main request,
 * writes the host's system prompt blocks and the request's encoded system and tool list to OPTCHAT_CAPTURE_FILE.
 * The loopback endpoint never answers, so no turn completes and nothing reaches the provider; the driver then
 * kills OMP. OPTCHAT_CAPTURE_BASE_URL is the driver's `http://127.0.0.1:<port>` endpoint; it holds no model id and no
 * credential.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function captureExtension(pi: ExtensionAPI): void {
	const file = process.env.OPTCHAT_CAPTURE_FILE;
	const baseUrl = process.env.OPTCHAT_CAPTURE_BASE_URL;
	if (!file || !baseUrl) {
		throw new Error("Set OPTCHAT_CAPTURE_FILE and OPTCHAT_CAPTURE_BASE_URL (run evals/compressor/capture.ts).");
	}
	const url = new URL(baseUrl);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) {
		throw new Error("OPTCHAT_CAPTURE_BASE_URL must be an http://127.0.0.1 loopback URL without credentials, query or fragment.");
	}
	pi.registerProvider("anthropic", { baseUrl: url.href.replace(/\/$/, "") });
	let captured = false;
	pi.on("before_provider_request", (event, ctx) => {
		if (captured || ctx.model?.provider !== "anthropic") return undefined;
		const payload = event.payload as Record<string, unknown>;
		if (!Array.isArray(payload.tools) || payload.tools.length === 0) return undefined;
		captured = true;
		writeFileSync(file, JSON.stringify({
			model: `${ctx.model.provider}/${ctx.model.id}`,
			systemPrompt: ctx.getSystemPrompt(),
			system: payload.system,
			tools: payload.tools,
		}), { mode: 0o600 });
		return undefined;
	});
}
