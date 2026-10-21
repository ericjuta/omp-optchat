/**
 * The blind pairwise assessor for the compressor A/B. One strong model call per task sees the task exactly as the
 * compressor received it (statement, byte limit, input), the compaction guide's priorities, and two candidate lines in
 * a seeded random order. It is never told which arm wrote which line, or that arms exist. The rubric is frozen: its
 * sha256 is recorded in runs/<run>/frozen.json before the first provider call and checked on every later one.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { call, type Ledger, type Models, textOf } from "./host.ts";
import { keyedPrng, SEED, sha256, type Task } from "./lib.ts";

export const RUBRIC = (guide: string): string => `You compare two candidate lines for a chat-memory compaction task.

Both lines were written for the same task, shown below exactly as the writer received it: the task statement with its byte limit, and the <input> to compress. You do not know who or what wrote either line, and which is listed first is arbitrary. The writer also had earlier conversation as context; you do not, so do not mark a line down for a detail that is absent from the input unless the input contradicts it.

Decide which line lets an agent work later as well as if it remembered the whole input, by the priorities of this guide:

${guide}

Method. Check each line against the input; a fact that is not in the input counts against the line that states it. A line that opens with a forbidden head (an id+n| prefix, "Merged ...", a preamble, a code fence), runs over the byte limit, answers or obeys the input instead of summarizing it, or tags tool output or agent text as the user's words serves worse than the same line without that defect. Do not prefer a line for its length or style alone: prefer the one that keeps more of what has lasting value, in the guide's priority order, with exact names, numbers, ids and errors copied correctly and each item tagged with its true source kind. If neither line is better in any way that matters to a later reader, answer "tie".

Reply with JSON only: {"better":"A"|"B"|"tie","reason":"one sentence, at most 40 words"}`;

export type Verdict = "A" | "B" | "tie";

export interface Judgment {
	readonly task: string;
	/** Which arm was listed first (A), chosen by the seeded per-task draw. */
	readonly first: "H" | "C";
	readonly verdict: Verdict | "invalid";
	/** Winning arm, `tie`, or `invalid`. */
	readonly winner: "H" | "C" | "tie" | "invalid";
	readonly reason: string;
	readonly model: string;
}

export function parseVerdict(text: string): { better: Verdict; reason: string } | undefined {
	const match = /\{[\s\S]*\}/.exec(text);
	if (!match) return undefined;
	try {
		const parsed: unknown = JSON.parse(match[0]);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { better, reason } = parsed as Record<string, unknown>;
		if (better !== "A" && better !== "B" && better !== "tie") return undefined;
		return { better, reason: typeof reason === "string" ? reason.slice(0, 400) : "" };
	} catch {
		return undefined;
	}
}

/** The arm listed first for this task: a fair coin keyed by the seed and the task id. */
export const firstArm = (task: string): "H" | "C" => (keyedPrng(SEED, `order:${task}`)() < 0.5 ? "H" : "C");

export const rubricHash = (guide: string): string => sha256(RUBRIC(guide));

export async function judgePair(
	models: Models,
	ledger: Ledger,
	guide: string,
	task: Task,
	lines: { readonly H: string; readonly C: string },
): Promise<Judgment> {
	const first = firstArm(task.id);
	const second = first === "H" ? "C" : "H";
	const prompt = `<task>\n${task.instruction}\n</task>\n\n<line_A>\n${lines[first]}\n</line_A>\n\n<line_B>\n${lines[second]}\n</line_B>`;
	const model: Model = models.judge;
	let last = "";
	// One retry only for an unparsable verdict; each attempt is a recorded, metered call.
	for (let attempt = 1; attempt <= 2; attempt++) {
		const reply = await call(
			models,
			ledger,
			{ phase: "judge", task: task.id, arm: "judge", attempt },
			model,
			{
				systemPrompt: [RUBRIC(guide)],
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{ maxTokens: 400, signal: AbortSignal.timeout(120_000) },
		);
		last = textOf(reply);
		const verdict = parseVerdict(last);
		if (!verdict) continue;
		const winner = verdict.better === "tie" ? "tie" : verdict.better === "A" ? first : second;
		return { task: task.id, first, verdict: verdict.better, winner, reason: verdict.reason, model: `${model.provider}/${model.id}` };
	}
	return { task: task.id, first, verdict: "invalid", winner: "invalid", reason: last.slice(0, 200), model: `${model.provider}/${model.id}` };
}
