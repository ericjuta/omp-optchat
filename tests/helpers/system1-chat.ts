/**
 * Shared harness for System One tests through the real `createOptChat` path: a fake host, a judge that
 * answers by the questions it is asked, a loopback compressor, and an encoder that captures the provider
 * payload the way the host does. Nothing here touches a provider or a network beyond 127.0.0.1.
 */
import { completeSimple, type Answer, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { createOptChat, SYSTEM_BLOCK } from "../../src/index.ts";
import { isRecord } from "../../src/type-guards.ts";
import { choice, fakeJudge, noul, score, type FakeJudge } from "./fake-judge.ts";
import { startCompressorServer, type CompressorServer } from "./compressor-server.ts";
import { openFakeHost, type FakeHost, type HostMessage } from "./fake-host.ts";

export const RULE_TEXT = "From now on always reply in French.";
export const RULE_ADDED = "OptChat rule r1 added";
/** Eight short user messages: with a 64-byte view, the first merged line is 0+2 once its parent is built. */
export const SEED_TEXTS = ["morning coffee for two", "tea for the team", "book a room", "send the invoice", "weather in Lisbon", "ship the release", "lunch on friday", "review the draft"];
/** The prefetch key of the first merged line in a `SEED_TEXTS` chat. */
export const FIRST_MERGED_LINE = "0+2";

export interface Routes {
  /** Prefetch: these line keys are relevant (0.9); every other judged line is not (0). */
  prefetch?: string[];
  /** Rule triage: a user message whose text contains this states a rule. */
  ruleWhen?: string;
  /** Tool gate: the danger of a judged call. */
  danger?: "safe" | "destructive";
  /** Value hint: the label and importance of a leaf. */
  value?: { label: "decision" | "preference" | "finding" | "noise"; importance: number };
}

const PREFETCH_KEY = /^\d+\+\d+$/;

const harmless = {
  risk: choice("safe", { safe: 1, risky: 0, destructive: 0 }),
  deletes: noul(0.1),
  remote: noul(0),
  shared: noul(0),
};
const destructive = {
  risk: choice("destructive", { safe: 0, risky: 0, destructive: 1 }),
  deletes: noul(0.9),
  remote: noul(0),
  shared: noul(0),
};

/** A judge that answers each question set by its keys, and throws on any set it does not know. */
export function routedJudge(routes: Routes = {}): FakeJudge {
  return fakeJudge((request) => {
    const keys = Object.keys(request.questions);
    if (keys.some((key) => PREFETCH_KEY.test(key))) {
      const relevant = new Set(routes.prefetch ?? []);
      return Object.fromEntries(keys.map((key): [string, Answer] => [key, noul(relevant.has(key) ? 0.9 : 0)]));
    }
    if (keys.includes("rule")) {
      const states = routes.ruleWhen !== undefined && JSON.stringify(request.state).includes(routes.ruleWhen);
      const answers: Record<string, Answer> = { rule: noul(states ? 0.95 : 0) };
      if (keys.includes("supersedes")) answers.supersedes = choice("none", { none: 1 });
      return answers;
    }
    if (keys.includes("risk")) return routes.danger === "destructive" ? destructive : harmless;
    if (keys.includes("label")) {
      const value = routes.value ?? { label: "noise", importance: 0 };
      const probabilities = { decision: 0, preference: 0, finding: 0, noise: 0, [value.label]: 1 };
      return { label: choice(value.label, probabilities), importance: score(value.importance) };
    }
    throw new Error(`unrouted judgment: ${keys.join(", ")}`);
  });
}

export interface OpenOptions {
  flags?: Record<string, string | boolean>;
  routes?: Routes;
  /** A custom judge; default is `routedJudge(routes)`. */
  judge?: FakeJudge;
  hasUI?: boolean;
  confirm?: (title: string, message: string) => boolean;
  /** Use this compressor server; the default starts one for this harness. */
  compressor?: CompressorServer;
}

/** Owns every host and loopback server a test opens, and closes them in order. */
export class Harness {
  readonly hosts: FakeHost[] = [];
  readonly servers: CompressorServer[] = [];

  async open(options: OpenOptions = {}): Promise<{ host: FakeHost; judge: FakeJudge; compressor: CompressorServer }> {
    const judge = options.judge ?? routedJudge(options.routes);
    const compressor = options.compressor ?? (await startCompressorServer());
    if (!options.compressor) this.servers.push(compressor);
    const host = await openFakeHost(createOptChat({ judge: () => judge }), {
      flags: options.flags ?? {},
      hasUI: options.hasUI,
      confirm: options.confirm,
      model: compressor.model,
      mainModel: anthropicModel(),
      apiKey: "fixture-key",
    });
    this.hosts.push(host);
    return { host, judge, compressor };
  }

  async close(): Promise<void> {
    for (const host of this.hosts.splice(0).reverse()) await host.close();
    for (const server of this.servers.splice(0)) await server.stop();
  }
}

/** The text of the view message a context result starts with: its content, never its timestamp. */
export function viewContent(messages: readonly unknown[]): string {
  const [first] = messages;
  if (!isRecord(first)) throw new Error("the context result starts with no message object");
  return JSON.stringify(first.content);
}

export const hasNotice = (host: FakeHost, prefix: string): boolean =>
  host.notices.some((notice) => notice.message.startsWith(prefix));

/** Polls at macrotask pace, bounded by a round count. */
export async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let round = 0; round < 2_000; round++) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** One complete user turn; returns the transcript a host would hold after it. */
export async function talk(host: FakeHost, transcript: readonly HostMessage[], text: string): Promise<HostMessage[]> {
  const messages = [...transcript, host.user(text)];
  await host.context(messages);
  const done = [...messages, host.assistant("noted")];
  await host.fire("agent_end", { messages: done, willContinue: false });
  return done;
}

/** A compressor-free chat of messages short enough to stay verbatim (nodes of 64 bytes). */
export const SMALL_NODES = { "optchat-node-bytes": "64", "optchat-view-bytes": "64" } as const;

export const ALL_GATES_OFF = {
  "no-optchat-rules": true,
  "no-optchat-prefetch": true,
  "no-optchat-value-score": true,
  "no-optchat-tool-gate": true,
  "no-optchat-recall": true,
} as const;

export function anthropicModel(): Model<"anthropic-messages"> {
  const found = getBundledModels("anthropic").find(
    (candidate): candidate is Model<"anthropic-messages"> => candidate.api === "anthropic-messages" && candidate.kind === undefined,
  );
  if (!found) throw new Error("Installed catalog lacks an anthropic/anthropic-messages chat model");
  const { transport: _transport, ...model } = found;
  return { ...model, provider: "anthropic", baseUrl: "https://api.anthropic.com", compat: { ...found.compat, officialEndpoint: true } };
}

export const TOOLS = [
  {
    name: "zoom",
    description: "Opens one view line back to its source.",
    parameters: { type: "object", properties: { id: { type: "number" }, n: { type: "number" } }, required: ["id", "n"] },
  },
];

export interface EncodedRequest {
  /** The provider payload after OptChat's before_provider_request hook, as the host would send it. */
  payload: Record<string, unknown>;
  /** The host system prompt after before_agent_start. */
  system: unknown;
  /** The tool definitions the request declares. */
  tools: unknown;
  /** The messages OptChat returned from its context hook. */
  messages: unknown[];
}

/**
 * Encodes the main request for `text` the way the host does: the context hook's messages through the real
 * pi-ai Anthropic encoder, aborted inside onPayload so nothing is sent, then OptChat's payload hook.
 */
export async function encodeMainRequest(host: FakeHost, transcript: HostMessage[], text: string): Promise<EncodedRequest> {
  const model = anthropicModel();
  const messages = messagesOf(await host.context([...transcript, host.user(text)]));
  const [started] = await host.fire("before_agent_start", { systemPrompt: ["Host prompt for the test."] });
  const system = systemOf(started);
  if (!system.includes(SYSTEM_BLOCK)) throw new Error("before_agent_start did not add the OptChat system block");
  let captured: Record<string, unknown> | undefined;
  const stop = new AbortController();
  const reply = await completeSimple(
    model,
    // The context messages are the host's own LLM messages; pi-ai's typed encoder is the only validator, so the cast stays here.
    { systemPrompt: system, messages: messages as never, tools: TOOLS as never },
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
  const [encoded] = await host.fire("before_provider_request", { payload: captured });
  if (!isRecord(encoded)) throw new Error("OptChat returned no provider payload");
  return { payload: encoded, system: encoded.system, tools: encoded.tools, messages: messagesOf(encoded) };
}

/** The `messages` of a context result or a provider payload; throws on any other shape. */
export function messagesOf(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.messages)) return value.messages;
  throw new Error("expected an object with a messages array");
}

function systemOf(value: unknown): string[] {
  if (isRecord(value) && Array.isArray(value.systemPrompt) && value.systemPrompt.every((part) => typeof part === "string")) {
    return value.systemPrompt;
  }
  throw new Error("before_agent_start did not return a system prompt");
}
