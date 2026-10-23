import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createOptChat } from "../src/index.ts";
import { isRecord } from "../src/type-guards.ts";
import { openFakeHost, type FakeHost, type FakeHostOptions } from "./helpers/fake-host.ts";
import {
  ALL_GATES_OFF,
  anthropicModel,
  encodeMainRequest,
  Harness,
  SMALL_NODES,
  talk,
  until,
} from "./helpers/system1-chat.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const MAIN = "cache mutation (last encoded main-hook request, including side requests): ";
const COMPRESSOR = "cache mutation (last encoded compressor request): ";
const hosts: FakeHost[] = [];
const harness = new Harness();
const ENV_KEYS = ["PI_CACHE_RETENTION", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY"];
let savedEnv: Array<[string, string | undefined]> = [];

beforeEach(() => {
  savedEnv = ENV_KEYS.map((key): [string, string | undefined] => [key, process.env[key]]);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  try {
    for (const host of hosts.splice(0).reverse()) await host.close();
    await harness.close();
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

async function encodeCachedMainRequest(...args: Parameters<typeof encodeMainRequest>) {
  const [host] = args;
  const [started]: unknown[] = await host.fire("before_agent_start", { systemPrompt: ["Host prompt for the test."] });
  if (!isRecord(started) || !Array.isArray(started.systemPrompt) || !started.systemPrompt.every((part) => typeof part === "string")) {
    throw new Error("before_agent_start did not return a system prompt");
  }
  const prompt = started.systemPrompt;
  host.ctx.getSystemPrompt = () => prompt;
  return encodeMainRequest(...args);
}

async function open(options: FakeHostOptions = {}): Promise<FakeHost> {
  const host = await openFakeHost(createOptChat(), {
    ...options,
    mainModel: options.mainModel ?? anthropicModel(),
    flags: { ...ALL_GATES_OFF, ...options.flags },
  });
  hosts.push(host);
  return host;
}

async function statusOf(host: FakeHost, command = "status"): Promise<string> {
  const notices = await host.command(command);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.type).toBe("info");
  return notices[0]!.message;
}

function expectModes(status: string, main: string, compressor = "unknown"): void {
  const lines = status.split("\n");
  expect(lines).toContain(`${MAIN}${main}`);
  expect(lines).toContain(`${COMPRESSOR}${compressor}`);
}

describe("/optchat status identity", () => {
  test("reports the actual package version and the current command context identity", async () => {
    const host = await open();
    const initial = await statusOf(host);
    expect(initial.split("\n")).toContain(`version: ${version}`);
    expect(initial.split("\n")).toContain("session: optchat-system1-session");

    // A new command context without a lifecycle event must not read the context retained at startup.
    host.ctx = {
      ...host.ctx,
      sessionManager: { ...host.ctx.sessionManager, getSessionId: () => "current.Session_42-abc" },
    };
    const current = await statusOf(host);
    expect(current.split("\n")).toContain("session: current.Session_42-abc");
    expect(current).not.toContain("session: optchat-system1-session");
  });

  test.each([
    ["empty", ""],
    ["whitespace", "private session"],
    ["path", "/private/sessions/session.jsonl"],
    ["newline", "private\nsession"],
    ["trailing LF", "private-session\n"],
    ["trailing CR", "private-session\r"],
    ["terminal escape", "\u001b[31mprivate"],
    ["overlong", "x".repeat(129)],
    ["non-string", 123],
    ["absent value", undefined],
  ])("an %s identity is unknown, without a session-file fallback", async (_name, identity) => {
    const host = await open();
    const pathFallback = mock(() => "/private/session-file-fallback.jsonl");
    Object.defineProperties(host.ctx.sessionManager, {
      getSessionId: { configurable: true, value: () => identity },
      getSessionFile: { configurable: true, value: pathFallback },
    });
    const status = await statusOf(host);
    expect(status.split("\n")).toContain("session: unknown");
    expect(status).not.toContain("/private/");
    expect(status).not.toContain("\u001b");
    expect(pathFallback).not.toHaveBeenCalled();
  });

  test.each(["missing", "throwing"])("a %s identity accessor stays unknown without leaking its error or falling back", async (kind) => {
    const host = await open();
    const pathFallback = mock(() => "/private/session-file-fallback.jsonl");
    Object.defineProperties(host.ctx.sessionManager, {
      getSessionId: {
        configurable: true,
        value: kind === "missing" ? undefined : () => { throw new Error("private identity failure"); },
      },
      getSessionFile: { configurable: true, value: pathFallback },
    });
    const status = await statusOf(host);
    expect(status.split("\n")).toContain("session: unknown");
    expect(status).not.toContain("private");
    expect(pathFallback).not.toHaveBeenCalled();
  });

  test.each(["", "status"])("an opted-out session still reports diagnostics for command %j", async (command) => {
    const host = await open({ flags: { "no-optchat": true } });
    host.ctx.sessionManager.getSessionId = () => "disabled-session";
    const status = await statusOf(host, command);
    expect(status.split("\n")).toContain(`version: ${version}`);
    expect(status.split("\n")).toContain("session: disabled-session");
    expectModes(status, "unknown");
    expect(host.handlers.has("before_provider_request")).toBe(false);
  });

  test("a child session reports diagnostics without inheriting main request observations", async () => {
    const host = await open({ agentKind: "sub" });
    host.ctx.sessionManager.getSessionId = () => "child-session";
    const status = await statusOf(host);
    expect(status.split("\n")).toContain(`version: ${version}`);
    expect(status.split("\n")).toContain("session: child-session");
    expectModes(status, "unknown");
  });
});

describe("/optchat status cache observations", () => {
  test("both modes start unknown despite a supported selected main model", async () => {
    const host = await open();
    expect(host.ctx.model?.api).toBe("anthropic-messages");
    expectModes(await statusOf(host), "unknown");
  });

  test("an actually transformed Anthropic request records only the main mode", async () => {
    const host = await open();
    const request = await encodeCachedMainRequest(host, [], "Keep this request short.");
    expect(request.payload.messages).toBe(request.messages);
    expect(request.messages[0]).toMatchObject({
      role: "user",
      content: { 0: { type: "text", text: expect.stringMatching(/^<chat>\n/) } },
    });
    expect(request.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.arrayContaining([
        expect.objectContaining({ cache_control: { type: "ephemeral", ttl: "5m" } }),
      ]),
    });
    expectModes(await statusOf(host), "anthropic-breakpoints");
  });

  test.each(["unsupported model", "missing view"])("a subsequent %s request records unchanged rather than a selected-model capability", async (kind) => {
    const host = await open();
    const request = await encodeCachedMainRequest(host, [], "First encoded request.");
    expectModes(await statusOf(host), "anthropic-breakpoints");
    if (kind === "unsupported model") {
      host.ctx.model = { ...anthropicModel(), provider: "unsupported-provider" };
    }
    const payload = kind === "missing view"
      ? { messages: [{ role: "user", content: [{ type: "text", text: "No OptChat view here." }] }] }
      : request.payload;
    const [encoded] = await host.fire("before_provider_request", { payload });
    expect(encoded).toBe(payload);
    expectModes(await statusOf(host), "unchanged");
  });

  test("a request without a model resets a previously observed main mode to unknown", async () => {
    const host = await open();
    const request = await encodeCachedMainRequest(host, [], "First encoded request.");
    expectModes(await statusOf(host), "anthropic-breakpoints");
    host.ctx.model = undefined;
    expect(await host.fire("before_provider_request", { payload: request.payload })).toEqual([undefined]);
    expectModes(await statusOf(host), "unknown");
  });

  test("loopback compression and pass-through main requests are observed separately, then cleared on session switch", async () => {
    const { host, compressor } = await harness.open({ flags: { ...ALL_GATES_OFF, ...SMALL_NODES } });
    expectModes(await statusOf(host), "unknown");
    const transcript = await talk(host, [], "Keep the durable decision. ".repeat(40));
    await host.context([...transcript, host.user("next")]);
    await until(async () => compressor.bodies.length > 0 && (await statusOf(host)).includes("compressor jobs running: 0"), "loopback compression to settle");
    expect(compressor.bodies.length).toBeGreaterThan(0);
    expectModes(await statusOf(host), "unknown", "unchanged");

    // This case proves observation scope/reset, not cache mutation (covered above).
    // A request without an OptChat view must pass through unchanged on this model.
    const payload = { messages: [{ role: "user", content: [{ type: "text", text: "A side request without a memory view." }] }] };
    const [encoded] = await host.fire("before_provider_request", { payload });
    expect(encoded).toBe(payload);
    expectModes(await statusOf(host), "unchanged", "unchanged");
    host.ctx.model = undefined;
    await host.fire("before_provider_request", { payload: {} });
    expectModes(await statusOf(host), "unknown", "unchanged");

    host.ctx.model = anthropicModel();
    const [restored] = await host.fire("before_provider_request", { payload });
    expect(restored).toBe(payload);
    expectModes(await statusOf(host), "unchanged", "unchanged");
    host.ctx.sessionManager.getSessionId = () => "switched-session";
    await host.fire("session_switch");
    const switched = await statusOf(host);
    expect(switched.split("\n")).toContain("session: switched-session");
    expectModes(switched, "unknown");
  });
});
