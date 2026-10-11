import { MIN_MAIN_CONTEXT_WINDOW } from "./options.ts";

/** Refuses an invalid window or a window larger than the unmodified catalog permits, before writing the override. */
export function mainContextWindowBlocker(selector: string, requested: number, catalogWindow: number | null): string | null {
	if (!Number.isSafeInteger(requested) || requested < MIN_MAIN_CONTEXT_WINDOW) return `--main-context-window must be an integer of at least ${MIN_MAIN_CONTEXT_WINDOW}`;
	if (catalogWindow === null || !Number.isSafeInteger(catalogWindow) || catalogWindow <= 0) return `cannot bound --main-context-window: catalog window is unknown for ${selector}`;
	return requested > catalogWindow ? `--main-context-window ${requested} exceeds the catalog window ${catalogWindow} for ${selector}` : null;
}

/**
 * Markers of private ambient context that must never reach an evidence run's effective system
 * prompt: instruction files from the workspace or home, and user-memory blocks. A marker check is a
 * tripwire, not a proof that the prompt is the known base; reports carry labels, never matched text.
 */
export const PRIVATE_CONTEXT_MARKERS: readonly string[] = [
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	"<user-memory",
	"<user_memory",
	"Memories database",
	"Notion Memory",
];

/**
 * Labels of every private-context marker present in the effective prompt blocks. Fixed markers are
 * reported by name; the runner's own host paths (passed as `parentSubstrings`) by position only, so
 * a failure never echoes a path or any prompt text.
 */
export function findPrivateContextMarkers(blocks: readonly string[], parentSubstrings: readonly string[]): string[] {
	const text = blocks.join("\n");
	const labels = PRIVATE_CONTEXT_MARKERS.filter((marker) => text.includes(marker));
	parentSubstrings.forEach((value, index) => {
		if (value.length > 0 && text.includes(value)) labels.push(`parent-path-${index + 1}`);
	});
	return labels;
}

/** Strict parse of the runner-supplied list of parent paths. Anything but a JSON string array fails closed. */
export function parseParentSubstrings(raw: string | undefined): string[] {
	if (raw === undefined || raw === "") return [];
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new Error("parent path list must be a JSON string array");
	}
	return value;
}
