import { describe, expect, test } from "bun:test";
import type { EvidencePassage } from "../src/system1/evidence.js";
import { EXTRACT_MODEL, EXTRACT_URL, extractionState, openRouterExtractor, parseExtraction, renderExtraction, type Extraction } from "../src/system1/extract.js";

const passage = (id: number, start: number, text: string): EvidencePassage => ({
  id,
  kind: "echo",
  start,
  end: start + Buffer.byteLength(text),
  totalBytes: start + Buffer.byteLength(text) + 10,
  text,
  complete: false,
});

const answer = (over: Partial<Extract<Extraction, { kind: "answer" }>>): Extraction => ({
  kind: "answer",
  value: "x",
  guess: "x",
  pNull: 0.01,
  span: null,
  stateText: null,
  truncated: false,
  cost: 0.00002,
  provider: "Cloudflare",
  ...over,
});

/** Code-point span of `needle`'s `nth` occurrence in `state`, as Clairic reports spans. */
function pointSpan(state: string, needle: string, nth = 0): [number, number] {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = state.indexOf(needle, at + 1);
  const start = [...state.slice(0, at)].length;
  return [start, start + [...needle].length];
}

describe("extraction span mapping", () => {
  // Emoji (4 UTF-8 bytes, 2 UTF-16 units, 1 code point) and accents before the answer, in the second passage.
  const passages = [passage(3, 0, "nothing here 🚀"), passage(7, 4096, "café ✅ 🎉 then run: deploy --to=prod-2 and stop")];
  const { state, placed } = extractionState(passages);

  test("a code-point span after non-ASCII text maps to the passage's exact message bytes", () => {
    const line = renderExtraction(state, placed, answer({ value: "deploy --to=prod-2", span: pointSpan(state, "deploy --to=prod-2"), stateText: state }), 0.5);
    const bytes = 4096 + Buffer.byteLength("café ✅ 🎉 then run: ");
    expect(line).toContain(`"deploy --to=prod-2" at message 7 bytes ${bytes}-${bytes + 18}; zoom(7, 1, ${bytes})`);
    // The byte range really holds the text in the message.
    const message = Buffer.from(passages[1]!.text);
    expect(message.subarray(bytes - 4096, bytes - 4096 + 18).toString()).toBe("deploy --to=prod-2");
  });

  test("repeated text maps to the occurrence the span names, not the first", () => {
    const twice = [passage(1, 0, "id ab12"), passage(2, 100, "id ab12")];
    const built = extractionState(twice);
    const line = renderExtraction(built.state, built.placed, answer({ value: "ab12", span: pointSpan(built.state, "ab12", 1), stateText: built.state }), 0.5);
    expect(line).toContain("at message 2 bytes 103-107");
  });

  test("a span over a header or across passages, or an echo that differs, is never shown as located", () => {
    const header = pointSpan(state, "[message 7");
    for (const extraction of [
      answer({ value: "m", span: header, stateText: state }),
      answer({ value: "m", span: [0, [...state].length], stateText: state }),
      answer({ value: "deploy", span: pointSpan(state, "deploy"), stateText: `${state} ` }),
      answer({ value: "deploy", span: null, stateText: state }),
    ]) {
      expect(renderExtraction(state, placed, extraction, 0.5)).toContain("has no verifiable span");
    }
  });

  test("the code-owned null threshold withholds an answer at or above it", () => {
    const at = answer({ value: "deploy", pNull: 0.5, span: pointSpan(state, "deploy"), stateText: state });
    expect(renderExtraction(state, placed, at, 0.5)).toContain("do not settle it (p_null 0.500");
    expect(renderExtraction(state, placed, answer({ value: "deploy", pNull: null }), 0.5)).toContain("p_null unknown");
    expect(renderExtraction(state, placed, answer({ value: null, pNull: 0.9 }), 0.5)).toContain("do not settle it");
  });

  test("unknown cost reads as unknown, never as zero", () => {
    expect(renderExtraction(state, placed, answer({ value: null, cost: null }), 0.5)).toContain("cost unknown");
  });
});

describe("parseExtraction", () => {
  test("off-shape bodies and spans fail closed", () => {
    expect(parseExtraction({ answers: {} }).kind).toBe("failed");
    expect(parseExtraction(null).kind).toBe("failed");
    const bad = parseExtraction({ answers: { answer: { value: "a", span: [5, 2] } } });
    expect(bad.kind === "answer" && bad.span).toBe(null);
  });
});

describe("openRouterExtractor", () => {
  const ok = {
    provider: "Cloudflare",
    answers: { answer: { type: "text", value: "v", span: [0, 1], p_null: 0.1 } },
    state_text: "v",
    truncated: false,
    usage: { cost: 0.0000123 },
  };

  test("posts one clairic text field with the state echo requested and the key only as a bearer header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const extractor = openRouterExtractor(
      async () => "sk-or-secret",
      (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(ok));
      }) as typeof fetch,
    );
    const result = await extractor("v", "what?", new AbortController().signal);
    expect(result).toMatchObject({ kind: "answer", value: "v", span: [0, 1], cost: 0.0000123 });
    expect(seen[0]!.url).toBe(EXTRACT_URL);
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.model).toBe(EXTRACT_MODEL);
    expect(body.fields.answer.type).toBe("text");
    expect(body.provider.options.cloudflare.return_state_text).toBe(true);
    expect(String(seen[0]!.init.body)).not.toContain("sk-or-secret");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-secret");
  });

  test("no key makes no request; HTTP errors report the status without the body or key", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response("upstream says sk-or-secret is bad", { status: 401 });
    }) as unknown as typeof fetch;
    expect(await openRouterExtractor(async () => undefined, fetcher)("s", "q", new AbortController().signal)).toEqual({
      kind: "off",
      reason: "no openrouter key in the OMP credential store",
    });
    expect(calls).toBe(0);
    const failed = await openRouterExtractor(async () => "sk-or-secret", fetcher)("s", "q", new AbortController().signal);
    expect(failed).toEqual({ kind: "failed", reason: "HTTP 401" });
    expect(calls).toBe(1);
  });

  test("a caller's cancel propagates instead of reading as a failure", async () => {
    const controller = new AbortController();
    const fetcher = ((_url: string, init: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      return promise;
    }) as unknown as typeof fetch;
    const pending = openRouterExtractor(async () => "k", fetcher)("s", "q", controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });
});
