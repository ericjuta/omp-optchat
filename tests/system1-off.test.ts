/**
 * Golden pin of the main model's bytes with every System One gate opted out (the 0.13.0 memory-only path).
 *
 * `tests/fixtures/system1-off.golden.json` is the spec: the system prompt OptChat hands the host, the encoded
 * Anthropic request (system, tool definitions, messages) after OptChat's payload hook, the context hook's
 * messages for a scripted chat, and the `/optchat status` lines. Any byte drift fails with a structural diff.
 *
 * Regenerate only for an intended change: `OPTCHAT_UPDATE_GOLDEN=1 bun test tests/system1-off.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { completeSimple, type Tool } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createOptChat, SYSTEM_BLOCK } from "../src/index.ts";
import { isRecord } from "../src/type-guards.ts";
import { startCompressorServer, type CompressorServer } from "./helpers/compressor-server.ts";
import { fakeJudge } from "./helpers/fake-judge.ts";
import { openFakeHost, type FakeHost, type HostMessage } from "./helpers/fake-host.ts";
import { ALL_GATES_OFF, anthropicModel, messagesOf, SEED_TEXTS, talk } from "./helpers/system1-chat.ts";

const GOLDEN = join(import.meta.dir, "fixtures", "system1-off.golden.json");
/** Fixed clock: message timestamps and memory times are then deterministic. */
const CLOCK = new Date("2026-10-12T09:00:00.000Z");
const HOST_PROMPT = "Host prompt for the test.";
const LAST_MESSAGE = "book the table for two";
/** A host tool ahead of OptChat's, as a real session lists them: OptChat's request must keep it in place. */
const HOST_TOOL = {
  name: "read",
  description: "Read a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
/** OptChat's tools in the order it registers them. `chat_recall` is absent: its gate is off. */
const OPTCHAT_TOOLS = ["zoom", "date", "work", "chat_search"] as const;

interface Golden {
  systemPrompt: string[];
  request: { system: unknown; tools: unknown; messages: unknown };
  context: unknown[];
  status: string[];
}

/** Hands OptChat the host's real `pi.zod` (omptype), so tool schemas are the ones a real session encodes. */
function withRealZod(extension: (pi: ExtensionAPI) => void): (pi: ExtensionAPI) => void {
  return (pi) => extension(new Proxy(pi, { get: (target, key) => (key === "zod" ? zod : Reflect.get(target, key)) }));
}

/** The request's tool definitions: the host tool, then OptChat's registered tools in order. */
function requestTools(host: FakeHost): Tool[] {
  const optchat = OPTCHAT_TOOLS.map((name) => {
    const tool = host.tools.get(name);
    if (!tool) throw new Error(`OptChat did not register ${name}`);
    return { name, description: (tool as unknown as Tool).description, parameters: (tool as unknown as Tool).parameters };
  });
  return [HOST_TOOL as unknown as Tool, ...optchat];
}

/** Encodes the main request the way the host does: real Anthropic encoder, aborted in onPayload, then OptChat's payload hook. */
async function encodeMainRequest(host: FakeHost, transcript: HostMessage[], text: string) {
  const context = messagesOf(await host.context([...transcript, host.user(text)]));
  const [started] = await host.fire("before_agent_start", { systemPrompt: [HOST_PROMPT] });
  if (!isRecord(started) || !Array.isArray(started.systemPrompt)) throw new Error("before_agent_start returned no system prompt");
  const systemPrompt = started.systemPrompt as string[];
  let captured: Record<string, unknown> | undefined;
  const stop = new AbortController();
  const reply = await completeSimple(
    anthropicModel(),
    // pi-ai's typed encoder is the only validator of these host messages, so the cast stays here.
    { systemPrompt, messages: context as never, tools: requestTools(host) },
    {
      apiKey: "fixture-key",
      statefulResponses: false,
      signal: stop.signal,
      onPayload: async (payload) => {
        captured = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
        stop.abort();
        return undefined;
      },
    },
  );
  if (reply.stopReason !== "aborted" || captured === undefined) {
    throw new Error(`the main request was not encoded: ${reply.stopReason} ${reply.errorMessage ?? ""}`);
  }
  const [payload] = await host.fire("before_provider_request", { payload: captured });
  if (!isRecord(payload)) throw new Error("OptChat returned no provider payload");
  return { systemPrompt, context: JSON.parse(JSON.stringify(context)) as unknown[], payload };
}

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("every System One gate opted out", () => {
  let host: FakeHost | undefined;
  let compressor: CompressorServer | undefined;
  let statefulBefore: string | undefined;

  beforeEach(() => {
    setSystemTime(CLOCK);
    statefulBefore = process.env.PI_OPENAI_STATEFUL;
    delete process.env.PI_OPENAI_STATEFUL;
  });

  afterEach(async () => {
    await host?.close();
    await compressor?.stop();
    host = undefined;
    compressor = undefined;
    setSystemTime();
    if (statefulBefore === undefined) delete process.env.PI_OPENAI_STATEFUL;
    else process.env.PI_OPENAI_STATEFUL = statefulBefore;
  });

  test("the main model receives the pinned 0.13.0 bytes; no judge is resolved and no tool_call hook is registered", async () => {
    let judgeResolutions = 0;
    const judge = fakeJudge(() => {
      throw new Error("no judgment is expected with every gate off");
    });
    compressor = await startCompressorServer();
    const opened = await openFakeHost(
      withRealZod(
        createOptChat({
          judge: () => {
            judgeResolutions++;
            return judge;
          },
        }),
      ),
      {
        flags: { ...ALL_GATES_OFF },
        model: compressor.model,
        mainModel: anthropicModel(),
        apiKey: "fixture-key",
      },
    );
    host = opened;

    let transcript: HostMessage[] = [];
    for (const text of SEED_TEXTS) transcript = await talk(opened, transcript, text);
    const { systemPrompt, context, payload } = await encodeMainRequest(opened, transcript, LAST_MESSAGE);
    const [notice] = await opened.command("status");
    if (!notice) throw new Error("/optchat status notified nothing");
    const status = notice.message.split("\n").map((line) => line.replaceAll(opened.directory, "<optchat-dir>"));

    expect(systemPrompt).toEqual([HOST_PROMPT, SYSTEM_BLOCK]);
    // Off means off: no judge resolved, nothing judged, no tool_call hook, no recall tool, no gate status line.
    // Short messages stay verbatim under the default budgets, so no summary is ever requested: the view is settled by construction.
    expect(compressor.bodies).toHaveLength(0);
    expect(judgeResolutions).toBe(0);
    expect(judge.requests).toHaveLength(0);
    expect(opened.handlers.has("tool_call")).toBe(false);
    expect([...opened.tools.keys()]).not.toContain("chat_recall");
    expect(status.some((line) => line.startsWith("System One gates"))).toBe(false);

    const actual: Golden = {
      systemPrompt,
      request: { system: payload.system, tools: payload.tools, messages: payload.messages },
      context,
      status,
    };
    const text = serialize(actual);
    if (process.env.OPTCHAT_UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, text);
    const expected = readFileSync(GOLDEN, "utf8");
    // The structural comparison reports the first differing field; the byte digest pins key order and whitespace too.
    expect(actual).toEqual(JSON.parse(expected) as Golden);
    expect({ bytes: Buffer.byteLength(text), sha256: sha256(text) }).toEqual({
      bytes: Buffer.byteLength(expected),
      sha256: sha256(expected),
    });
  });
});
