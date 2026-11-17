import { readFileSync } from "node:fs";

/** Read once from this plugin's package, never from the host or a session directory. */
export const PLUGIN_VERSION = (() => {
	try {
		const metadata: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		if (metadata === null || typeof metadata !== "object" || !("version" in metadata)) return "unknown";
		const version = metadata.version;
		return typeof version === "string" && version.length <= 128
			&& !/[^0-9A-Za-z.+-]/.test(version)
			&& /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
			? version : "unknown";
	} catch {
		return "unknown";
	}
})();
