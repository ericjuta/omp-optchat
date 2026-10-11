/**
 * Evidence-only extension: wraps the real OptChat factory with the host's supported in-process
 * options and checks each turn's effective system prompt before any provider call. The runner
 * launches each host with its own counter file and allowance, so admission is a synchronous
 * read-increment-write in one process.
 *
 * Environment (all required when loaded; absence fails closed):
 *   OPTCHAT_EVIDENCE_ADMISSION_FILE  per-host JSON counter file
 *   OPTCHAT_EVIDENCE_ALLOWANCE       integer compressor calls this host may dispatch
 *   OPTCHAT_EVIDENCE_COMPRESSOR_MAX_TOKENS  integer 1..512 output cap per compressor call
 *   OPTCHAT_EVIDENCE_PARENT_PATHS    optional JSON string array of runner host paths that must not appear in the prompt
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createOptChat } from "../src/index.ts";
import { findPrivateContextMarkers, parseParentSubstrings } from "./evidence/preflight.ts";

const MAX_OUTPUT = 512;

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`${name} is required for evidence runs`);
	return value;
}

function positiveInteger(name: string, max: number): number {
	const raw = required(name);
	if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
	const value = Number(raw);
	if (value < 1 || value > max) throw new Error(`${name} must be from 1 to ${max}`);
	return value;
}

export default function evidenceExtension(pi: ExtensionAPI): void {
	const file = required("OPTCHAT_EVIDENCE_ADMISSION_FILE");
	const allowance = Number(process.env.OPTCHAT_EVIDENCE_ALLOWANCE ?? "");
	if (!Number.isInteger(allowance) || allowance < 0) throw new Error("OPTCHAT_EVIDENCE_ALLOWANCE must be a nonnegative integer");
	const maxTokens = positiveInteger("OPTCHAT_EVIDENCE_COMPRESSOR_MAX_TOKENS", MAX_OUTPUT);
	const parentPaths = parseParentSubstrings(process.env.OPTCHAT_EVIDENCE_PARENT_PATHS);
	const read = (): number => {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { dispatched?: unknown };
		if (typeof parsed.dispatched !== "number" || !Number.isInteger(parsed.dispatched) || parsed.dispatched < 0) {
			throw new Error("admission file is malformed");
		}
		return parsed.dispatched;
	};
	// Every turn: the effective system prompt must carry no private ambient context, before any call.
	pi.on("before_agent_start", (event) => {
		const found = findPrivateContextMarkers(event.systemPrompt, parentPaths);
		if (found.length > 0) throw new Error(`effective system prompt carries private context: ${found.join(", ")}`);
	});
	createOptChat({
		compressorMaxTokens: maxTokens,
		admitCompressorCall: () => {
			const dispatched = read();
			if (dispatched >= allowance) return false;
			// Written before the request is sent: a crash after this point over-counts, never under-counts.
			writeFileSync(file, JSON.stringify({ dispatched: dispatched + 1 }));
			return true;
		},
	})(pi);
}
