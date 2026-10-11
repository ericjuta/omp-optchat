/**
 * A narrow in-process host for OptChat: only the ExtensionAPI and context members the plugin touches.
 * No SDK session, registry, credentials or provider transport; the compressor model is never called
 * unless a test appends a message longer than the node budget.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type HostMessage = ContextEvent["messages"][number];
export type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

export interface Notice {
  message: string;
  type: string | undefined;
}

export interface Confirm {
  title: string;
  message: string;
  timeout: number | undefined;
}

export interface FakeHostOptions {
  /** Extra or overriding flags; the memory directory flag is always set. */
  flags?: Record<string, string | boolean>;
  /** Reuse a directory (seeded or from an earlier host); otherwise a fresh temporary one. */
  directory?: string;
  hasUI?: boolean;
  /** Answer of ctx.ui.confirm; default decline. */
  confirm?: (title: string, message: string) => boolean | Promise<boolean>;
  agentKind?: "main" | "sub";
  /** The compressor model `ctx.models.resolve` returns; default FAKE_MODEL, which has no transport. */
  model?: object;
  /** Answer of `ctx.modelRegistry.resolver`; without it the registry is empty and no compressor call can authenticate. */
  apiKey?: string;
  /** The session's main model (`ctx.model`); default undefined, which makes the cache hook a pass-through. */
  mainModel?: object;
}

export interface FakeHost {
  directory: string;
  notices: Notice[];
  confirms: Confirm[];
  handlers: Map<string, Handler[]>;
  commands: Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  ctx: ExtensionContext;
  aborts: number;
  fire(type: string, event?: Record<string, unknown>): Promise<unknown[]>;
  context(messages: HostMessage[]): Promise<unknown>;
  command(args: string): Promise<Notice[]>;
  user(text: string): HostMessage;
  assistant(text: string, tool?: { id: string; name: string; arguments: Record<string, unknown> }): AssistantMessage;
  toolResult(id: string, name: string, text: string): HostMessage;
  shutdown(): Promise<void>;
  /** Shutdown, then remove the directory unless it was supplied. */
  close(): Promise<void>;
}

/** Every zod builder call returns the same chain: schemas are recorded, never validated here. */
function zodStub(): unknown {
  const chain: unknown = new Proxy(function stub() {}, {
    get: () => () => chain,
    apply: () => chain,
  });
  return chain;
}

export const FAKE_MODEL = {
  provider: "fake", id: "fake", name: "Fake", api: "openai-completions",
  reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1_024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export async function openFakeHost(
  extension: (pi: ExtensionAPI) => void,
  options: FakeHostOptions = {},
): Promise<FakeHost> {
  const owned = options.directory === undefined;
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "optchat-system1-")));
  const flags: Record<string, string | boolean> = {
    "optchat-dir": directory,
    "optchat-model": "fake/fake",
    ...options.flags,
  };
  const handlers = new Map<string, Handler[]>();
  const commands: FakeHost["commands"] = new Map();
  const notices: Notice[] = [];
  const confirms: Confirm[] = [];
  let lastTimestamp = Date.now();
  const timestamp = (): number => (lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));
  const pi = {
    registerFlag() {},
    registerCommand(name: string, command: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, command);
    },
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    getFlag: (name: string) => flags[name],
    getAllTools: () => [],
    getActiveTools: () => ["zoom", "date", "work"],
    registerTool() {},
    zod: zodStub(),
    pi: { getAgentDir: () => directory },
  } as unknown as ExtensionAPI;
  const host: FakeHost = {
    directory,
    notices,
    confirms,
    handlers,
    commands,
    aborts: 0,
    ctx: undefined as unknown as ExtensionContext,
    async fire(type, event = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(type) ?? []) results.push(await handler({ type, ...event }, host.ctx));
      return results;
    },
    async context(messages) {
      const results = await host.fire("context", { messages });
      if (results.length !== 1) throw new Error(`expected one context handler, got ${results.length}`);
      return results[0];
    },
    async command(args) {
      const start = notices.length;
      await commands.get("optchat")!.handler(args, host.ctx);
      return notices.slice(start);
    },
    user: (text) => ({ role: "user", content: text, timestamp: timestamp() }) as HostMessage,
    assistant: (text, tool) => ({
      role: "assistant",
      content: [
        { type: "text", text },
        ...(tool ? [{ type: "toolCall" as const, id: tool.id, name: tool.name, arguments: tool.arguments }] : []),
      ],
      api: "openai-completions", provider: "fake", model: "fake",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: tool ? "toolUse" : "stop",
      timestamp: timestamp(),
    }) as AssistantMessage,
    toolResult: (id, name, text) => ({
      role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: timestamp(),
    }) as HostMessage,
    async shutdown() {
      await host.fire("session_shutdown");
    },
    async close() {
      try {
        await host.shutdown();
      } finally {
        if (owned) await rm(directory, { recursive: true, force: true });
      }
    },
  };
  host.ctx = {
    cwd: directory,
    hasUI: options.hasUI ?? true,
    getSystemPrompt: () => [],
    isIdle: () => false,
    abort: () => { host.aborts++; },
    ui: {
      notify: (message: string, type?: string) => { notices.push({ message, type }); },
      confirm: async (title: string, message: string, dialog?: { timeout?: number }) => {
        confirms.push({ title, message, timeout: dialog?.timeout });
        return options.confirm ? options.confirm(title, message) : false;
      },
    },
    models: { resolve: () => options.model ?? FAKE_MODEL },
    agent: { kind: options.agentKind ?? "main" },
    sessionManager: {
      getSessionId: () => "optchat-system1-session",
      getArtifactManager: () => undefined,
      getBranch: () => [],
    },
    modelRegistry: options.apiKey === undefined ? {} : { resolver: () => options.apiKey },
    model: options.mainModel,
  } as unknown as ExtensionContext;
  extension(pi);
  await host.fire("session_start");
  // Strictly after start's Date.now cutoff.
  lastTimestamp = Date.now();
  return host;
}
