import { describe, expect, test } from "bun:test";
import { readConfig } from "../src/config.js";

const config = (flags: Record<string, string | boolean> = {}) => readConfig({ getFlag: (name: string) => flags[name] }, "/tmp/optchat-config");

describe("external memory scope configuration", () => {
  test("external stores require explicit aliases and absolute paths", () => {
    expect(config().projectStores).toEqual({});
    expect(config({ "optchat-project-stores": '{"branch":"/tmp/branch-memory"}' }).projectStores).toEqual({ branch: "/tmp/branch-memory" });
    for (const value of ['null', '[]', '{"branch":"relative"}', '{"../branch":"/tmp/memory"}', '{"__proto__":"/tmp/memory"}', '{"branch":4}', '{"branch":"/tmp/\\u0000memory"}', '{']) {
      expect(() => config({ "optchat-project-stores": value })).toThrow("optchat-project-stores");
    }
  });
  test("store count and configuration length are bounded", () => {
    const roots = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`store${i}`, `/tmp/store${i}`]));
    expect(() => config({ "optchat-project-stores": JSON.stringify(roots) })).toThrow("optchat-project-stores");
    expect(() => config({ "optchat-project-stores": JSON.stringify({ branch: `/${"x".repeat(8192)}` }) })).toThrow("optchat-project-stores");
  });
  test("opt-outs take precedence over enables", () => {
    for (const [flag, key] of [["child-pack", "childPack"], ["decisions", "decisions"], ["work-discovery", "workDiscovery"]] as const) {
      expect(config({ [`optchat-${flag}`]: true, [`no-optchat-${flag}`]: true })[key]).toBe(false);
      expect(() => config({ [`optchat-${flag}`]: "invalid" })).toThrow();
    }
  });
});
