/**
 * Model access and spend accounting for the compressor A/B. Models resolve through OMP's registry and role settings and
 * credentials come from OMP's own store, exactly as the host resolves them for the plugin: no key, no model id in an
 * environment variable. Every provider call is appended to runs/<run>/spend.jsonl with its usage, so the $5 cap is
 * enforced from what the provider reported, never from an estimate.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	completeSimple,
	type Context,
	type Message as LlmMessage,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { BUDGET_USD, ROOT } from "./lib.ts";

/** One provider call as the ledger records it. Cost fields are `null` when the provider usage gave none. */
export interface SpendRow {
	readonly phase: "compress" | "judge";
	readonly task: string;
	readonly arm: "H" | "C" | "judge";
	readonly model: string;
	readonly attempt: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** input + cacheRead + cacheWrite cost, USD. */
	readonly promptCostUsd: number | null;
	readonly outputCostUsd: number | null;
	readonly costUsd: number | null;
	readonly stopReason: string;
	readonly ms: number;
}

/** Usage with a cost is `known`: a model without pricing reports 0 for every field, which is not a cost of $0. */
export function costOf(reply: AssistantMessage): Pick<SpendRow, "promptCostUsd" | "outputCostUsd" | "costUsd"> {
	const { usage } = reply;
	const cost = usage.cost;
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const priced = cost !== undefined && (cost.total > 0 || tokens === 0);
	if (!priced) return { promptCostUsd: null, outputCostUsd: null, costUsd: null };
	return {
		promptCostUsd: cost.input + cost.cacheRead + cost.cacheWrite,
		outputCostUsd: cost.output,
		costUsd: cost.total,
	};
}

export class Ledger {
	private readonly file: string;
	constructor(directory: string, readonly cap = BUDGET_USD) {
		this.file = join(directory, "spend.jsonl");
	}

	rows(): SpendRow[] {
		if (!existsSync(this.file)) return [];
		return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as SpendRow);
	}

	record(row: SpendRow): void {
		appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
	}

	/** Sum of known costs, and how many calls reported none. */
	total(): { usd: number; unknown: number } {
		let usd = 0;
		let unknown = 0;
		for (const row of this.rows()) {
			if (row.costUsd === null) unknown++;
			else usd += row.costUsd;
		}
		return { usd, unknown };
	}
}

export interface Models {
	readonly registry: ModelRegistry;
	readonly compressor: Model;
	readonly main: Model;
	readonly judge: Model;
	readonly sessionId: string;
	close(): void;
}

/** Judge selectors admit native runners; compressor/main retain the host's chat-only resolution. */
function resolveOne(registry: ModelRegistry, settings: Settings, selector: string, judge = false): Model {
	const standingJudge = judge && selector === "@judge";
	// An unset standing role must block rather than expand the host's built-in chat fallbacks.
	const value = (standingJudge ? settings.getModelRole("judge") : selector)?.trim();
	if (!value) {
		const error = new Error(`model "${selector}" is not available in this OMP configuration`);
		error.name = "ModelUnavailableError";
		throw error;
	}
	const available = standingJudge
		? roleCandidatePool("judge", settings, registry)
		: judge ? registry.getAvailable("all") : registry.getAvailable();
	// Guard clear canonical identities; leave lists, thinking suffixes, routing, and roles to the host grammar.
	// API validation is the runner's job.
	const exactJudge = judge && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._~/-]+$/.test(value);
	const model = exactJudge
		? available.find((candidate) => `${candidate.provider}/${candidate.id}` === value)
		: resolveModelRoleValue(value, available, { settings }).model;
	if (!model) {
		const error = new Error(`model "${selector}" is not available in this OMP configuration`);
		error.name = "ModelUnavailableError";
		throw error;
	}
	return model;
}

export async function openModels(options: { judge: string; main: string }): Promise<Models> {
	const settings = await Settings.init({ cwd: ROOT });
	const auth = await discoverAuthStorage(undefined, { settings });
	try {
		const registry = new ModelRegistry(auth);
		await registry.hydrateCredentialScopedModelCaches();
		return {
			registry,
			// The plugin's default compressor selector (src/config.ts `model`).
			compressor: resolveOne(registry, settings, "@smol"),
			main: resolveOne(registry, settings, options.main),
			judge: resolveOne(registry, settings, options.judge, true),
			sessionId: "optchat-compressor-ab",
			close: () => auth.close(),
		};
	} catch (error) {
		auth.close();
		throw error;
	}
}

export const selectorOf = (model: Model): string => `${model.provider}/${model.id}`;

/** A completed provider call: the reply plus its ledger row. Provider errors and aborts throw. */
export async function call(
	models: Models,
	ledger: Ledger,
	meta: Pick<SpendRow, "phase" | "task" | "arm" | "attempt">,
	model: Model,
	context: Context,
	options: Omit<SimpleStreamOptions, "apiKey" | "statefulResponses">,
): Promise<AssistantMessage> {
	const started = performance.now();
	const reply = await completeSimple(model, context, {
		...options,
		apiKey: models.registry.resolver(model, models.sessionId),
		// Full independent context, as the production compressor sends it.
		statefulResponses: false,
	});
	ledger.record({
		...meta,
		model: selectorOf(model),
		input: reply.usage.input,
		output: reply.usage.output,
		cacheRead: reply.usage.cacheRead,
		cacheWrite: reply.usage.cacheWrite,
		...costOf(reply),
		stopReason: reply.stopReason,
		ms: Math.round(performance.now() - started),
	});
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		throw new Error(`${selectorOf(model)} request ${reply.stopReason}${reply.errorMessage ? `: ${reply.errorMessage.slice(0, 300)}` : ""}`);
	}
	if (reply.stopReason === "toolUse" || reply.content.some((part) => part.type === "toolCall")) {
		throw new Error("the model returned a tool call instead of text");
	}
	return reply;
}

export const textOf = (reply: AssistantMessage): string =>
	reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** The assistant turn `Memory`'s feedback replays, shaped like the plugin's own `assistantReply`. */
export function assistantTurn(model: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export type { LlmMessage };
