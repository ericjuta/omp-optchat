import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { DEFAULTS, readConfig, readEnabled, registerFlags } from "../src/config.ts";

/** Host OMP 18.6.1 `getFlag` value union; the typed Pick doubles below prove it stays compatible. */
type FlagValue = boolean | string | undefined;

type FlagName =
  | "optchat"
  | "no-optchat"
  | "optchat-dir"
  | "optchat-model"
  | "optchat-node-bytes"
  | "optchat-view-bytes"
  | "optchat-jobs"
  | "optchat-tries"
  | "optchat-tool-cap"
  | "optchat-child-view"
  | "no-optchat-child-view";
type Flags = Partial<Record<FlagName, FlagValue>>;

const MAX = Number.MAX_SAFE_INTEGER;

/**
 * Numeric flags with their inclusive bounds. `context` supplies the companion flags a bound needs
 * (viewBytes must be at least nodeBytes), and `sample` is an arbitrary in-range explicit value.
 */
const NUMERIC_FLAGS = [
  { flag: "optchat-node-bytes", key: "nodeBytes", minimum: 64, maximum: MAX, sample: "100", context: { "optchat-view-bytes": String(MAX) } },
  { flag: "optchat-view-bytes", key: "viewBytes", minimum: 64, maximum: MAX, sample: "1000", context: { "optchat-node-bytes": "64" } },
  { flag: "optchat-jobs", key: "jobs", minimum: 1, maximum: 64, sample: "7", context: {} },
  { flag: "optchat-tries", key: "tries", minimum: 1, maximum: 100, sample: "7", context: {} },
  { flag: "optchat-tool-cap", key: "toolCap", minimum: 128, maximum: MAX, sample: "1000", context: {} },
] satisfies Array<{
  flag: FlagName;
  key: keyof typeof DEFAULTS;
  minimum: number;
  maximum: number;
  sample: string;
  context: Flags;
}>;

const DEFAULT_DIRECTORY = "/srv/agent/optchat";
const MODEL = "anthropic/claude-sonnet-4-6";

/** Minimal getFlag double returning the supplied flag values. */
function host(values: Flags): Pick<ExtensionAPI, "getFlag"> {
  return {
    getFlag(name: string): FlagValue {
      return Object.hasOwn(values, name) ? values[name as FlagName] : undefined;
    },
  };
}

function read(values: Flags, defaultDirectory = DEFAULT_DIRECTORY) {
  return readConfig(host(values), defaultDirectory);
}

/**
 * Wording is free, but the message must name the offending flag. A bare flag name is matched so
 * `--optchat` is not satisfied by `--optchat-dir` and vice versa.
 */
function expectRejected(values: Flags, flag: FlagName | RegExp, defaultDirectory = DEFAULT_DIRECTORY): Error {
  let rejected: unknown;
  try {
    read(values, defaultDirectory);
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(Error);
  const error = rejected as Error;
  expect(error.message).toMatch(typeof flag === "string" ? new RegExp(`--${flag}(?![-\\w])`) : flag);
  return error;
}

/** Each explicit invalid value must fail across default-enabled and SDK/legacy activation values. */
const ACTIVATIONS: Array<{ name: string; flags: Flags }> = [
  { name: "absent (default-enabled)", flags: {} },
  { name: "legacy optchat SDK boolean false", flags: { optchat: false } },
  { name: "legacy optchat SDK string false", flags: { optchat: "false" } },
  { name: "legacy optchat SDK boolean true", flags: { optchat: true } },
  { name: "legacy optchat SDK string true with explicit model", flags: { optchat: "true", "optchat-model": MODEL } },
  { name: "no-optchat SDK boolean true", flags: { "no-optchat": true } },
  { name: "no-optchat SDK string true", flags: { "no-optchat": "true" } },
  { name: "no-optchat SDK boolean false", flags: { "no-optchat": false } },
  { name: "no-optchat SDK string false", flags: { "no-optchat": "false" } },
  { name: "no-optchat SDK boolean true overrides legacy boolean true", flags: { optchat: true, "no-optchat": true } },
  { name: "no-optchat SDK string true overrides legacy string true", flags: { optchat: "true", "no-optchat": "true" } },
];

const SDK_ACTIVATION_VALUES = [undefined, true, "true", false, "false"] as const;

describe("readConfig defaults", () => {
  test("absent activation flags default to enabled", () => {
    expect(read({}).enabled).toBe(true);
  });

  test("absent directory resolves the supplied default to an absolute path", () => {
    const config = read({}, "relative/agent/optchat");
    expect(isAbsolute(config.directory)).toBe(true);
    expect(config.directory).toBe(resolve(process.cwd(), "relative/agent/optchat"));
  });

  test.each(["", "   ", "agent\u0000optchat", "agent\ud800optchat"])("invalid default directory %p is rejected", (directory) => {
    for (const { flags } of ACTIVATIONS) {
      expect(() => read(flags, directory)).toThrow();
    }
  });
});

describe("activation and compressor model", () => {
  for (const { positive, expected } of [
    { positive: undefined, expected: [true, false, false, true, true] },
    { positive: true, expected: [true, false, false, true, true] },
    { positive: "true", expected: [true, false, false, true, true] },
    { positive: false, expected: [false, false, false, false, false] },
    { positive: "false", expected: [false, false, false, false, false] },
  ] as const) {
    SDK_ACTIVATION_VALUES.forEach((negative, index) => {
      test(`SDK optchat ${typeof positive} ${JSON.stringify(positive)}, no-optchat ${typeof negative} ${JSON.stringify(negative)} enables ${expected[index]}`, () => {
        expect(read({ optchat: positive, "no-optchat": negative }).enabled).toBe(expected[index]);
        expect(readEnabled(host({ optchat: positive, "no-optchat": negative }))).toBe(expected[index]);
      });
    });
  }

  test.each([true, false])("explicit model overrides the default (enabled=%p)", (enabled) => {
    expect(read({ optchat: enabled, "optchat-model": MODEL }).model).toBe(MODEL);
    expect(read({ optchat: enabled, "optchat-model": "@slow" }).model).toBe("@slow");
  });

  test.each([
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-4o-mini",
    "openrouter/meta-llama/llama-3.1-8b-instruct",
    "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0",
    "provider/vendor/family/model",
    "cloudflare-ai-gateway/workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
    "openai//gpt-4o",
    "openai/gpt-4o/",
    "@smol",
    "@slow",
  ])("accepts model selector %p", (model) => {
    expect(read({ optchat: true, "optchat-model": model }).model).toBe(model);
  });

  test.each([
    "",
    " ",
    "gpt-4o",
    "openai",
    "openai/",
    "/gpt-4o",
    " openai/gpt-4o",
    "openai/gpt-4o ",
    "openai/gpt 4o",
    "openai /gpt-4o",
    "openai/gpt\u00a04o",
    "openai/gpt-4o\n",
    "provider/model\n",
    "provider/model\r\n",
    "openai/gpt-4o\t",
    "openai/gpt\u0000-4o",
    "openai/gpt\u007f-4o",
    "openai/gpt\u001b-4o",
    "@",
    "@ smol",
    "@smol role",
    "@smol\n",
    "smol@",
    "openai\\gpt-4o",
  ])("rejects malformed model %p even when disabled", (model) => {
    for (const { flags } of ACTIVATIONS) {
      expectRejected({ ...flags, "optchat-model": model }, "optchat-model");
    }
  });

  test.each([true, false])("rejects boolean model value %p", (model) => {
    for (const { flags } of ACTIVATIONS) {
      expectRejected({ ...flags, "optchat-model": model }, "optchat-model");
    }
  });

  test.each([
    "",
    "1",
    "0",
    "yes",
    "no",
    "on",
    "TRUE",
    "False",
    " true",
    "true ",
    "true\n",
    "t",
    "enabled",
  ])("validates malformed SDK activation %p with optout precedence", (value) => {
    for (const negative of [undefined, false, "false"] as const) {
      const flags = { optchat: value, "no-optchat": negative };
      expectRejected(flags, "optchat");
      expect(() => readEnabled(host(flags))).toThrow(/--optchat(?![-\w])/);
    }
    expectRejected({ optchat: value, "optchat-model": MODEL }, "optchat");
    for (const negative of [true, "true"] as const) {
      const flags = { optchat: value, "no-optchat": negative };
      expect(read(flags).enabled).toBe(false);
      expect(readEnabled(host(flags))).toBe(false);
    }
    for (const positive of [...SDK_ACTIVATION_VALUES, value]) {
      const flags = { optchat: positive, "no-optchat": value };
      expectRejected(flags, "no-optchat");
      expect(() => readEnabled(host(flags))).toThrow(/--no-optchat(?![-\w])/);
    }
  });
});

describe("directory", () => {
  test.each([
    "relative/chat",
    "./chat",
    "../chat",
    "chat dir with spaces",
    "/tmp/opt chat",
    "/tmp/聊天/記憶",
    "/tmp/emoji-😀",
    "/",
    "~/literal-tilde",
    "/tmp/~cache",
  ])("accepts %p and returns the literally resolved absolute path", (directory) => {
    for (const { flags } of ACTIVATIONS) {
      const config = read({ ...flags, "optchat-dir": directory });
      expect(isAbsolute(config.directory)).toBe(true);
      expect(config.directory).toBe(resolve(directory));
    }
  });

  test.each([
    "",
    " ",
    "   \t ",
    "\t",
    "\n",
    "chat\u0000dir",
    "\u0000",
    "chat\u007fdir",
    "chat\ndir",
    "chat\rdir",
    "chat\tdir",
    "chat\u001bdir",
    "chat\ud800dir",
    "chat\udc00dir",
    "\ud83d",
  ])("rejects invalid path %p even when disabled", (directory) => {
    for (const { flags } of ACTIVATIONS) {
      expectRejected({ ...flags, "optchat-dir": directory }, "optchat-dir");
    }
  });

  test.each([true, false])("rejects boolean directory value %p", (directory) => {
    for (const { flags } of ACTIVATIONS) {
      expectRejected({ ...flags, "optchat-dir": directory }, "optchat-dir");
    }
  });
});

describe("numeric flags", () => {
  test.each(NUMERIC_FLAGS)(
    "$flag accepts decimal values from $minimum to $maximum",
    ({ flag, key, minimum, maximum, context }) => {
      for (const { flags } of ACTIVATIONS) {
        for (const value of [minimum, minimum + 1, maximum - 1, maximum]) {
          expect(read({ ...flags, ...context, [flag]: String(value) })[key]).toBe(value);
        }
      }
    },
  );

  test.each(NUMERIC_FLAGS)("$flag rejects values just outside its bounds", ({ flag, minimum, maximum, context }) => {
    for (const { flags } of ACTIVATIONS) {
      expectRejected({ ...flags, ...context, [flag]: String(minimum - 1) }, flag);
      expectRejected({ ...flags, ...context, [flag]: "0" }, flag);
      expectRejected({ ...flags, ...context, [flag]: maximum === MAX ? "9007199254740992" : String(maximum + 1) }, flag);
      expectRejected({ ...flags, ...context, [flag]: "99999999999999999999999" }, flag);
    }
  });

  test("the retired retry-delay flag is no longer registered", () => {
    const registered: string[] = [];
    registerFlags({ registerFlag: (name: string) => void registered.push(name) } as unknown as Pick<ExtensionAPI, "registerFlag">);
    expect(registered).toContain("optchat-tool-cap");
    expect(registered).not.toContain("optchat-retry-ms");
  });

  test("child view is on by default, the opt-out wins, and both flags are boolean-valued", () => {
    expect(read({}).childView).toBe(true);
    expect(read({ "optchat-child-view": "false" }).childView).toBe(false);
    expect(read({ "no-optchat-child-view": true }).childView).toBe(false);
    expect(read({ "optchat-child-view": true, "no-optchat-child-view": true }).childView).toBe(false);
    expectRejected({ "optchat-child-view": "yes" }, "optchat-child-view");
    expectRejected({ "no-optchat-child-view": "yes" }, "no-optchat-child-view");
  });

  test("accepts leading zeros as decimal digits", () => {
    const config = read({ "optchat-jobs": "0008", "optchat-tool-cap": "0128", "optchat-node-bytes": "000128" });
    expect(config).toMatchObject({ jobs: 8, toolCap: 128, nodeBytes: 128 });
    expectRejected({ "optchat-jobs": "00" }, "optchat-jobs");
  });

  describe("view budget must cover the summary target", () => {
    const pair = /--optchat-(?:view|node)-bytes(?![-\w])/;

    test("equal node and view sizes are accepted", () => {
      expect(read({ "optchat-node-bytes": "1000", "optchat-view-bytes": "1000" })).toMatchObject({
        nodeBytes: 1000,
        viewBytes: 1000,
      });
    });

    test("upper node bound is valid when the view uses the same maximum", () => {
      expect(read({ "optchat-node-bytes": String(MAX), "optchat-view-bytes": String(MAX) })).toMatchObject({
        nodeBytes: MAX,
        viewBytes: MAX,
      });
    });

    test.each(ACTIVATIONS)("a view below the node target is rejected ($name)", ({ flags }) => {
      expectRejected({ ...flags, "optchat-node-bytes": "1000", "optchat-view-bytes": "999" }, pair);
      expectRejected({ ...flags, "optchat-view-bytes": String(DEFAULTS.nodeBytes - 1) }, pair);
    });

    test.each(ACTIVATIONS)("an absent view default is not inflated to fit a larger node ($name)", ({ flags }) => {
      expectRejected({ ...flags, "optchat-node-bytes": String(DEFAULTS.viewBytes + 1) }, pair);
    });
  });

  const MALFORMED: readonly FlagValue[] = [
    "",
    " ",
    "abc",
    "8abc",
    "abc8",
    "0x10",
    "0X10",
    "0b101",
    "0o17",
    "1e3",
    "1E3",
    "1e+3",
    " 8",
    "8 ",
    "8\n",
    "512\n",
    "512\r\n",
    "\n512",
    "\t8",
    "8 0",
    "1.0",
    "1.5",
    ".5",
    "5.",
    "+8",
    "-8",
    "-0",
    "1_000",
    "1,000",
    "Infinity",
    "NaN",
    "true",
    "false",
    "٨",
    "８",
    true,
    false,
  ];

  test.each(NUMERIC_FLAGS)("$flag rejects malformed values even when disabled", ({ flag, context }) => {
    for (const value of MALFORMED) {
      for (const { flags } of ACTIVATIONS) expectRejected({ ...flags, ...context, [flag]: value }, flag);
    }
  });
});

describe("diagnostics", () => {
  const SECRET = "sk-live-DO-NOT-ECHO-7f3a9c";
  const cases: Array<{ flag: FlagName; value: string; context: Flags }> = [
    { flag: "optchat", value: SECRET, context: {} },
    { flag: "no-optchat", value: SECRET, context: {} },
    { flag: "optchat-dir", value: `/tmp/${SECRET}\u0000`, context: {} },
    { flag: "optchat-dir", value: `/tmp/${SECRET}\ud800`, context: {} },
    { flag: "optchat-model", value: SECRET, context: {} },
    { flag: "optchat-model", value: `openai/${SECRET} extra`, context: {} },
    { flag: "optchat-model", value: `@${SECRET}\n`, context: {} },
    ...NUMERIC_FLAGS.map(({ flag, context }) => ({ flag, value: `12${SECRET}`, context })),
    ...NUMERIC_FLAGS.map(({ flag, context }) => ({ flag, value: `0x${SECRET}`, context })),
  ];

  test.each(cases)("invalid $flag diagnostics never echo the supplied value", ({ flag, value, context }) => {
    for (const { flags } of ACTIVATIONS) {
      if (flag === "optchat" && (flags["no-optchat"] === true || flags["no-optchat"] === "true")) continue;
      const error = expectRejected({ ...flags, ...context, [flag]: value }, flag);
      expect(error.message).not.toContain(value);
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain("DO-NOT-ECHO");
      expect(error.stack ?? "").not.toContain(SECRET);
    }
  });

  test("diagnostics for one flag do not leak other supplied values", () => {
    const error = expectRejected(
      { optchat: true, "optchat-dir": `/tmp/${SECRET}`, "optchat-model": `openai/${SECRET}`, "optchat-jobs": "65" },
      "optchat-jobs",
    );
    expect(error.message).not.toContain(SECRET);
  });
});
