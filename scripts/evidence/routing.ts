import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Operator routing that copied credentials would lose. The SDK's provider routing (custom baseUrl,
 * gateway) lives in `models.yml` under the agent directory (model-registry.ts:507). The runner copies
 * only bearer credentials, so a selected provider that the operator routes elsewhere would send its
 * copied key to the bundled default endpoint. Fail closed: a source file that names the provider at
 * all blocks it before any credential is copied or any host discovery runs.
 */
export async function routingBlockers(sourceAgentDir: string, providers: readonly string[]): Promise<string[]> {
	const text = await readFile(join(sourceAgentDir, "models.yml"), "utf8").catch(() => null);
	if (text === null) return [];
	return providers
		.filter((provider) => text.includes(provider))
		.map((provider) => `source models.yml names provider ${provider}; its routing cannot be transferred with the copied credential, so the run is blocked`);
}
