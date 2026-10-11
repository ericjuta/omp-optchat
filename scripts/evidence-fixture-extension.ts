import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import evidenceExtension from "./evidence-extension.ts";
import fixtureProvider from "./fixture-provider.ts";

/**
 * Fixture-mode host entry: the evidence extension (admission, prompt guard) and the loopback fixture
 * provider in one `-e` slot, so a fixture host has the same guards as a live host and the scripted models.
 */
export default function evidenceFixtureExtension(pi: ExtensionAPI): void {
	evidenceExtension(pi);
	fixtureProvider(pi);
}
