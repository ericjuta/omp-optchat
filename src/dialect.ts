import type { Model } from "@oh-my-pi/pi-ai";

/** The request dialect: these select the host's system-prefix and tool encoders and their policy. */
export function dialectKey(model: Model): string {
	return JSON.stringify([model.provider, model.api, model.baseUrl, model.transport, model.compat]);
}

/** Top-level capabilities the host's tool encoders read outside compat (tool support, freeform apply_patch, computer use). */
function toolKey(model: Model): string {
	return JSON.stringify([model.supportsTools !== false, model.applyPatchToolType ?? null, model.supportsComputerUse === true]);
}

/**
 * Whether tool declarations the host encoded for `source` are exactly what its
 * encoder would emit for `target`. A model without tool support gets none.
 */
export function sharedToolsAllowed(source: Model, target: Model): boolean {
	// The SDK applies base and enabled-thinking effective policies before onPayload:
	// late tools cannot safely reuse tool-free encoding if either disables reasoning with tools.
	const compat = target.compat;
	if (
		compat &&
		(("disableReasoningWithTools" in compat && compat.disableReasoningWithTools === true) ||
			("whenThinking" in compat && compat.whenThinking?.disableReasoningWithTools === true))
	) return false;
	return target.supportsTools !== false && dialectKey(source) === dialectKey(target) && toolKey(source) === toolKey(target);
}
