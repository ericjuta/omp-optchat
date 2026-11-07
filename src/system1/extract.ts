import type { EvidencePassage } from "./evidence.js";

/** OpenRouter's extractions route (alpha; the shape may change). AGENTS.md permits this one plugin-side provider call. */
export const EXTRACT_URL = "https://openrouter.ai/api/alpha/extractions";
export const EXTRACT_MODEL = "cloudflare/clairic";
/** Milliseconds one extraction may take, request and response, before `chat_evidence` returns without it. */
export const EXTRACT_MS = 10_000;
/** The most response bytes read; a larger body is refused unread. */
const RESPONSE_BYTES = 262_144;

/** What the extractor returned, or why it did not. Never carries the key. */
export type Extraction =
  | { readonly kind: "off"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string }
  | {
      readonly kind: "answer";
      /** The answer's value, or null when its null probability crossed the field threshold. */
      readonly value: string | null;
      readonly guess: string | null;
      /** Probability that the passages hold no answer, or null when the model gave none. */
      readonly pNull: number | null;
      /** `[start, end)` in Unicode code points of the sent state, or null. */
      readonly span: readonly [number, number] | null;
      /** The text the span indexes, as the provider echoed it; null when not returned. */
      readonly stateText: string | null;
      readonly truncated: boolean;
      /** USD as reported; null is unknown, never zero. */
      readonly cost: number | null;
      readonly provider: string | null;
    };

/** One request: the state text and the question. Tests inject their own. */
export type Extractor = (state: string, question: string, signal: AbortSignal) => Promise<Extraction>;

/**
 * The OpenRouter extractor. `key` resolves the `openrouter` key through the host at call time (OMP's credential
 * store or, by its own cascade, an environment variable; Eric, 2026-11-08); undefined turns
 * the extractor off. Errors are reduced to a status line so neither the key nor response bodies reach the tool text.
 */
export function openRouterExtractor(key: () => Promise<string | undefined>, request: typeof fetch = fetch): Extractor {
  return async (state, question, signal) => {
    let apiKey: string | undefined;
    try {
      apiKey = await key();
    } catch {
      return { kind: "off", reason: "OMP could not resolve an openrouter key" };
    }
    signal.throwIfAborted();
    if (!apiKey) return { kind: "off", reason: "no openrouter key resolved" };
    const body = JSON.stringify({
      model: EXTRACT_MODEL,
      state,
      fields: {
        answer: {
          type: "text",
          instructions: `The exact words in the text that answer this question; null if the text does not answer it: ${question}`,
        },
      },
      provider: { options: { cloudflare: { return_state_text: true } } },
    });
    let response: Response;
    try {
      response = await request(EXTRACT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(EXTRACT_MS)]),
      });
    } catch (error) {
      signal.throwIfAborted();
      return { kind: "failed", reason: error instanceof Error && error.name === "TimeoutError" ? "timed out" : "request failed" };
    }
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > RESPONSE_BYTES) return { kind: "failed", reason: "response too large" };
    let parsed: unknown;
    try {
      const text = await boundedText(response, RESPONSE_BYTES);
      if (text === null) return { kind: "failed", reason: "response too large" };
      parsed = JSON.parse(text);
    } catch {
      signal.throwIfAborted();
      return { kind: "failed", reason: "unreadable response" };
    }
    return parseExtraction(parsed);
  };
}

/** The body as text, read chunk by chunk; null (and the stream cancelled) once it passes `limit` bytes. */
async function boundedText(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const positive = (value: number | null): number | null => (value !== null && value > 0 ? value : null);

/** The response body as an Extraction; anything off-shape fails closed. */
export function parseExtraction(body: unknown): Extraction {
  const root = record(body);
  const answer = record(record(root?.answers)?.answer);
  if (!root || !answer) return { kind: "failed", reason: "response has no answer" };
  const raw = answer.span;
  const span =
    Array.isArray(raw) && raw.length === 2 && raw.every((n) => Number.isSafeInteger(n) && n >= 0) && raw[0] <= raw[1]
      ? ([raw[0], raw[1]] as const)
      : null;
  return {
    kind: "answer",
    value: text(answer.value),
    guess: text(answer.guess),
    pNull: finite(answer.p_null),
    span,
    stateText: text(root.state_text),
    truncated: root.truncated === true,
    // Clairic is listed at $0.10/M input, yet the route reports 0: a zero is not evidence of no cost, so it is unknown.
    cost: positive(finite(record(root.usage)?.cost)),
    provider: text(root.provider),
  };
}

/** Where each passage's text sits in the state, in code points. */
interface Placed {
  readonly passage: EvidencePassage;
  /** Code point offset of the passage's first character in the state. */
  readonly at: number;
  readonly points: readonly string[];
}

/** The state sent to the extractor: each passage under a header naming its message, so the model sees provenance. */
export function extractionState(passages: readonly EvidencePassage[]): { state: string; placed: readonly Placed[] } {
  let state = "";
  let at = 0;
  const placed: Placed[] = [];
  for (const passage of passages) {
    const header = `${state === "" ? "" : "\n\n"}[message ${passage.id}, ${passage.kind}]\n`;
    state += header;
    at += [...header].length;
    const points = [...passage.text];
    placed.push({ passage, at, points });
    state += passage.text;
    at += points.length;
  }
  return { state, placed };
}

/** A span mapped back to one passage's message bytes, or null when it leaves a passage or the echo disagrees. */
export function mapSpan(
  state: string,
  placed: readonly Placed[],
  extraction: Extract<Extraction, { kind: "answer" }>,
): { id: number; start: number; end: number; text: string } | null {
  if (!extraction.span || extraction.stateText !== state) return null;
  const [start, end] = extraction.span;
  for (const { passage, at, points } of placed) {
    if (start < at || end > at + points.length) continue;
    const before = Buffer.byteLength(points.slice(0, start - at).join(""));
    const quoted = points.slice(start - at, end - at).join("");
    return { id: passage.id, start: passage.start + before, end: passage.start + before + Buffer.byteLength(quoted), text: quoted };
  }
  return null;
}

const quote = (value: string): string => JSON.stringify(value.replace(/\s+/g, " ").trim());
const cost = (value: number | null): string => (value === null ? "cost unknown" : `cost $${value.toFixed(6)}`);

/**
 * The extraction line `chat_evidence` appends after its trailer. An answer is shown only when its null probability is
 * below `maxNull` (a code-owned threshold) and its span maps inside one passage; otherwise the line says why not.
 */
export function renderExtraction(state: string, placed: readonly Placed[], extraction: Extraction, maxNull: number): string {
  const head = `[extraction ${EXTRACT_MODEL}`;
  if (extraction.kind === "off") return `${head} off: ${extraction.reason}]`;
  if (extraction.kind === "failed") return `${head} failed: ${extraction.reason}; the passages above stand alone]`;
  const pNull = extraction.pNull === null ? "p_null unknown" : `p_null ${extraction.pNull.toFixed(3)}`;
  const tail = `${pNull}, ${cost(extraction.cost)}${extraction.truncated ? ", input truncated" : ""}`;
  if (extraction.value === null || extraction.pNull === null || extraction.pNull >= maxNull) {
    return `${head}: the passages do not settle it (${tail})]`;
  }
  const mapped = mapSpan(state, placed, extraction);
  if (!mapped) return `${head}: answer ${quote(extraction.value)} has no verifiable span in the passages; treat it as unconfirmed (${tail})]`;
  return `${head}: ${quote(mapped.text)} at message ${mapped.id} bytes ${mapped.start}-${mapped.end}; zoom(${mapped.id}, 1, ${mapped.start}) reopens it (${tail})]`;
}
