import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Driver-owned Chat Completions SSE endpoint; no server or SDK runtime here.
 * Set OPTCHAT_SMOKE_BASE_URL=http://127.0.0.1:<port>/v1 and load with
 * --extension ./scripts/fixture-provider.ts --provider optchat-smoke
 * --model optchat-smoke-chat (or optchat-smoke-compact).
 * Send delta.reasoning_content for thinking, delta.content for text, then
 * finish_reason:"stop", usage, and [DONE]. Both models use the same transport.
 */
export default function fixtureProvider(pi: ExtensionAPI): void {
	const configuredUrl = process.env.OPTCHAT_SMOKE_BASE_URL;
	if (!configuredUrl) {
		throw new Error("Set OPTCHAT_SMOKE_BASE_URL to the driver-owned loopback /v1 endpoint.");
	}
	const baseUrl = new URL(configuredUrl);
	if (
		baseUrl.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname) ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.search ||
		baseUrl.hash ||
		baseUrl.pathname.replace(/\/$/, "") !== "/v1"
	) {
		throw new Error("OPTCHAT_SMOKE_BASE_URL must be an HTTP loopback /v1 URL without credentials, query, or fragment.");
	}

	pi.registerProvider("optchat-smoke", {
		baseUrl: baseUrl.href.replace(/\/$/, ""),
		apiKey: "optchat-smoke-fixture-key",
		api: "openai-completions",
		models: ["optchat-smoke-chat", "optchat-smoke-compact"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsMultipleSystemMessages: true,
				supportsReasoningEffort: true,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "openai",
				reasoningContentField: "reasoning_content",
				replayReasoningContent: true,
			},
		})),
	});
}
