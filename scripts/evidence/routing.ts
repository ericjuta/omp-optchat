import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSONC, YAML } from "bun";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copied credentials cannot preserve operator routing. Inspect every default-discovered sibling
 * (models.yml, models.yaml, models.json) even when a higher-precedence file shadows it: this is
 * deliberately broader than SDK precedence. Check only shallow own keys of providers; a selected
 * key blocks regardless of value. Unresolved merge keys block absence inference. Bun parsing
 * determines duplicate and complex-key semantics; this guard cannot recover keys a parser discards.
 */
export async function routingBlockers(sourceAgentDir: string, providers: readonly string[]): Promise<string[]> {
	const blockers: string[] = [];
	for (const filename of ["models.yml", "models.yaml", "models.json"]) {
		let text: string;
		try {
			text = await readFile(join(sourceAgentDir, filename), "utf8");
		} catch (error: unknown) {
			if (isRecord(error) && Object.hasOwn(error, "code") && error.code === "ENOENT") continue;
			blockers.push(`source ${filename} could not be read; routing cannot be determined, so the run is blocked`);
			continue;
		}
		let config: unknown;
		try {
			config = filename.endsWith(".yml") || filename.endsWith(".yaml") ? YAML.parse(text.trim()) : JSONC.parse(text.trim());
		} catch {
			blockers.push(`source ${filename} could not be parsed; routing cannot be determined, so the run is blocked`);
			continue;
		}
		if (!isRecord(config) || (Object.hasOwn(config, "providers") && !isRecord(config.providers))) {
			blockers.push(`source ${filename} has an invalid root or providers shape; routing cannot be determined, so the run is blocked`);
			continue;
		}
		const configured = Object.hasOwn(config, "providers") && isRecord(config.providers) ? config.providers : undefined;
		if (Object.hasOwn(config, "<<") || (configured && Object.hasOwn(configured, "<<"))) {
			blockers.push(`source ${filename} has an unresolved merge key; routing cannot be determined, so the run is blocked`);
			continue;
		}
		for (const provider of providers) {
			if (configured && Object.hasOwn(configured, provider)) {
				blockers.push(`source ${filename} names provider ${provider}; its routing cannot be transferred with the copied credential, so the run is blocked`);
			}
		}
	}
	return blockers;
}
