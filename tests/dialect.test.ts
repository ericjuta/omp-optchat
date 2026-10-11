import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { dialectKey, sharedToolsAllowed } from "../src/dialect.ts";

function toolCapableBundledModel(): Model {
  const model = getBundledModels("openai").find((candidate) => candidate.supportsTools !== false);
  expect(model).toBeDefined();
  if (!model) throw new Error("Missing tool-capable bundled OpenAI model");
  return model;
}

describe("sharedToolsAllowed", () => {
  const reasoningPolicyCases: {
    name: string;
    policy?: boolean | undefined;
    whenThinking?: { disableReasoningWithTools?: boolean | undefined } | undefined;
    omitCompat?: boolean;
    expected: boolean;
  }[] = [
    { name: "allows matching models with undefined compat", omitCompat: true, expected: true },
    { name: "allows matching models without disableReasoningWithTools", expected: true },
    { name: "allows matching models with disableReasoningWithTools false", policy: false, expected: true },
    { name: "allows matching models with explicit undefined disableReasoningWithTools", policy: undefined, expected: true },
    { name: "allows matching models with explicit undefined whenThinking", whenThinking: undefined, expected: true },
    { name: "allows matching models without nested disableReasoningWithTools", whenThinking: {}, expected: true },
    { name: "allows matching models with nested disableReasoningWithTools false", whenThinking: { disableReasoningWithTools: false }, expected: true },
    { name: "allows matching models with explicit undefined nested disableReasoningWithTools", whenThinking: { disableReasoningWithTools: undefined }, expected: true },
    { name: "rejects matching models with nested disableReasoningWithTools true", whenThinking: { disableReasoningWithTools: true }, expected: false },
    { name: "rejects matching models with disableReasoningWithTools true", policy: true, expected: false },
    { name: "rejects base disableReasoningWithTools false with whenThinking true", policy: false, whenThinking: { disableReasoningWithTools: true }, expected: false },
    { name: "rejects base disableReasoningWithTools true despite whenThinking false", policy: true, whenThinking: { disableReasoningWithTools: false }, expected: false },
  ];

  test.each(reasoningPolicyCases)("$name", (testCase) => {
    const { policy, whenThinking, omitCompat, expected } = testCase;
    const model = getBundledModels("fireworks").find(
      (candidate): candidate is Model<"openai-completions"> =>
        candidate.api === "openai-completions" && candidate.supportsTools !== false,
    );
    if (!model) throw new Error("Missing tool-capable bundled Fireworks completions model");

    const compat: Model<"openai-completions">["compat"] = { ...model.compat };
    delete compat.disableReasoningWithTools;
    delete compat.whenThinking;
    if (Object.hasOwn(testCase, "policy")) compat.disableReasoningWithTools = policy;
    if (Object.hasOwn(testCase, "whenThinking")) {
      if (whenThinking === undefined) {
        compat.whenThinking = undefined;
      } else {
        const nestedCompat = { ...compat };
        delete nestedCompat.disableReasoningWithTools;
        if (Object.hasOwn(whenThinking, "disableReasoningWithTools")) {
          nestedCompat.disableReasoningWithTools = whenThinking.disableReasoningWithTools;
        }
        compat.whenThinking = nestedCompat;
      }
    }
    const source: Model = { ...model, compat: omitCompat ? undefined : compat };
    const target: Model = { ...source };

    expect(source).not.toBe(target);
    expect(dialectKey(source)).toBe(dialectKey(target));
    expect(sharedToolsAllowed(source, target)).toBe(expected);
    expect(sharedToolsAllowed(target, source)).toBe(expected);
  });

  test("allows a tool-capable bundled model to share tools with itself", () => {
    const model = toolCapableBundledModel();

    expect(model.supportsTools).not.toBe(false);
    expect(sharedToolsAllowed(model, model)).toBe(true);
  });

  test("rejects bundled OpenAI freeform apply_patch tools for a target without apply_patch", () => {
    const models = getBundledModels("openai");
    const namedSource = models.find((model) => model.id === "gpt-5");
    const namedTarget = models.find((model) => model.id === "o3-mini");
    let pair: [Model, Model] | undefined;

    if (namedSource && namedTarget) {
      pair = [namedSource, namedTarget];
    } else {
      // Only missing named models permit fallback; capability drift must fail below.
      for (const source of models) {
        if (source.supportsTools === false || source.applyPatchToolType !== "freeform") continue;
        const target = models.find((candidate) =>
          candidate.supportsTools !== false &&
          candidate.applyPatchToolType === undefined &&
          dialectKey(candidate) === dialectKey(source)
        );
        if (target) {
          pair = [source, target];
          break;
        }
      }
    }

    expect(pair).toBeDefined();
    if (!pair) throw new Error("Missing bundled OpenAI apply_patch capability pair with equal dialects");
    const [source, target] = pair;
    expect(dialectKey(source)).toBe(dialectKey(target));
    expect(source.supportsTools).not.toBe(false);
    expect(target.supportsTools).not.toBe(false);
    expect(source.applyPatchToolType).toBe("freeform");
    expect(target.applyPatchToolType).toBeUndefined();
    expect(sharedToolsAllowed(source, target)).toBe(false);
  });

  test("rejects bundled Fireworks tools when the target does not support tools", () => {
    const models = getBundledModels("fireworks");
    const namedSource = models.find((model) => model.id.includes("gpt-oss-120b"));
    const namedTarget = models.find((model) => model.id.includes("gpt-oss-20b"));
    let pair: [Model, Model] | undefined;

    if (namedSource && namedTarget) {
      pair = [namedSource, namedTarget];
    } else {
      // Preserve the named regression pair whenever both models remain bundled.
      for (const source of models) {
        if (source.supportsTools === false) continue;
        const target = models.find((candidate) =>
          candidate.supportsTools === false && dialectKey(candidate) === dialectKey(source)
        );
        if (target) {
          pair = [source, target];
          break;
        }
      }
    }

    expect(pair).toBeDefined();
    if (!pair) throw new Error("Missing bundled Fireworks tool-support capability pair with equal dialects");
    const [source, target] = pair;
    expect(dialectKey(source)).toBe(dialectKey(target));
    expect(source.supportsTools).not.toBe(false);
    expect(target.supportsTools).toBe(false);
    expect(sharedToolsAllowed(source, target)).toBe(false);
  });

  test("rejects an otherwise identical target with tool support disabled", () => {
    const source = toolCapableBundledModel();
    const target: Model = { ...source, supportsTools: false };

    expect(dialectKey(source)).toBe(dialectKey(target));
    expect(source.supportsTools).not.toBe(false);
    expect(target.supportsTools).toBe(false);
    expect(sharedToolsAllowed(source, target)).toBe(false);
  });

  test("rejects otherwise identical models with different computer-use support", () => {
    const source: Model = { ...toolCapableBundledModel(), supportsComputerUse: false };
    const target: Model = { ...source, supportsComputerUse: true };

    expect(dialectKey(source)).toBe(dialectKey(target));
    expect(source.supportsTools).not.toBe(false);
    expect(target.supportsTools).not.toBe(false);
    expect(source.supportsComputerUse).toBe(false);
    expect(target.supportsComputerUse).toBe(true);
    expect(sharedToolsAllowed(source, target)).toBe(false);
  });

  test("rejects otherwise identical models with different base URLs", () => {
    const source = toolCapableBundledModel();
    const target: Model = { ...source, baseUrl: `${source.baseUrl}/dialect-test` };

    expect(source.supportsTools).not.toBe(false);
    expect(target.supportsTools).not.toBe(false);
    expect(source.baseUrl).not.toBe(target.baseUrl);
    expect(dialectKey(source)).not.toBe(dialectKey(target));
    expect(sharedToolsAllowed(source, target)).toBe(false);
  });
});
