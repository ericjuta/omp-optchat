/**
 * A loopback OpenAI Chat Completions server for the compressor. Every request is recorded and answered with
 * the same short summary, so built nodes depend only on the tree shape, never on the request text. The
 * pi-ai transport is real: the compressor's model points here and nothing leaves the machine.
 */
import type { Model } from "@oh-my-pi/pi-ai";

export const SUMMARY = "summary";

export interface CompressorServer {
  /** Model to pass as the compressor (`ctx.models.resolve`). */
  readonly model: Model<"openai-completions">;
  /** Every compaction request body, in arrival order. */
  readonly bodies: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

const SSE_HEADERS = { "content-type": "text/event-stream" };

function reply(model: string): Response {
  const id = "chatcmpl-optchat-compressor";
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
  const body = [
    chunk({ role: "assistant" }),
    chunk({ content: SUMMARY }),
    chunk({}, "stop"),
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [], usage })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: SSE_HEADERS });
}

export async function startCompressorServer(): Promise<CompressorServer> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("unexpected request", { status: 404 });
      }
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      return reply(String(body.model));
    },
  });
  const model: Model<"openai-completions"> = {
    id: "compressor",
    name: "Compressor",
    api: "openai-completions",
    provider: "fake",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 1_024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<"openai-completions">;
  return {
    model,
    bodies,
    async stop() {
      await server.stop(true);
    },
  };
}
