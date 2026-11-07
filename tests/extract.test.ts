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

  test("low null probability cannot answer a release question from another release", () => {
    const built = extractionState([passage(4, 0, "Runtime 2.3.0 runs application 7.1.0.")]);
    const result = renderExtraction(built.state, built.placed,
      answer({ value: "2.3.0", pNull: 0.001, span: pointSpan(built.state, "2.3.0"), stateText: built.state }),
      0.5, "Which runtime does application 7.2.0 require?");
    expect(result).toContain("withheld");
    expect(result).not.toContain('candidate occurrence "2.3.0"');
  });

  test("mismatched values, truncated input and impossible probabilities never produce candidates", () => {
    const base = { value: "deploy", span: pointSpan(state, "deploy"), stateText: state };
    for (const over of [{ value: "stop" }, { truncated: true }, { pNull: -0.1 }, { pNull: 1.1 }]) {
      expect(renderExtraction(state, placed, answer({ ...base, ...over }), 0.5)).not.toContain("candidate occurrence");
    }
  });

  test("a located occurrence retains its unverified status even with near-zero null probability", () => {
    const rendered = renderExtraction(state, placed,
      answer({ value: "deploy", pNull: 0, span: pointSpan(state, "deploy"), stateText: state }), 0.5);
    expect(rendered).toContain('candidate occurrence "deploy"');
    expect(rendered).toContain("not a verified answer");
  });

  test("quoted occurrences preserve whitespace-sensitive original bytes", () => {
    const built = extractionState([passage(9, 0, "a  b\n")]);
    const rendered = renderExtraction(built.state, built.placed,
      answer({ value: "a  b\n", span: pointSpan(built.state, "a  b\n"), stateText: built.state }), 0.5);
    expect(rendered).toContain('"a  b\\n" at message 9 bytes 0-5');
  });

  test("unknown cost reads as unknown, never as zero", () => {
    expect(renderExtraction(state, placed, answer({ value: null, cost: null }), 0.5)).toContain("cost unknown");
  });
});

describe("parseExtraction", () => {
  test("a reported zero cost is unknown: the route reports 0 for a priced model", () => {
    const parsed = parseExtraction({ answers: { answer: { value: "a" } }, usage: { cost: 0 } });
    expect(parsed.kind === "answer" && parsed.cost).toBe(null);
  });

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

  test("cancellation interrupts a stalled credential lookup before transport", async () => {
    let requests = 0;
    const controller = new AbortController();
    const extractor = openRouterExtractor(() => new Promise(() => {}), (async () => {
      requests++;
      return new Response("{}");
    }));
    const pending = extractor("source", "question", controller.signal);
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow("caller cancelled");
    expect(requests).toBe(0);
  });

  test("stalled credentials expire without a network request", async () => {
    let requests = 0;
    const extractor = openRouterExtractor(() => new Promise(() => {}), (async () => {
      requests++;
      return new Response("{}");
    }));
    expect(await extractor("source", "question", new AbortController().signal)).toEqual({ kind: "failed", reason: "timed out" });
    expect(requests).toBe(0);
  }, 15000);

  test("posts one clairic text field with the state echo requested and the key only as a bearer header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const extractor = openRouterExtractor(
      async () => "sk-or-secret",
      (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(ok));
      }),
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

  test("an endless body without content-length is refused once it passes the byte bound, and its stream cancelled", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(65_536).fill(0x20);
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(chunk),
      cancel: () => { cancelled = true; },
    });
    const extractor = openRouterExtractor(async () => "k", (async () => new Response(endless)));
    expect(await extractor("s", "q", new AbortController().signal)).toEqual({ kind: "failed", reason: "response too large" });
    expect(cancelled).toBe(true);
  });

  test("no key makes no request; HTTP errors report the status without the body or key", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response("upstream says sk-or-secret is bad", { status: 401 });
    });
    expect(await openRouterExtractor(async () => undefined, fetcher)("s", "q", new AbortController().signal)).toEqual({
      kind: "off",
      reason: "no openrouter key resolved",
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
    });
    const pending = openRouterExtractor(async () => "k", fetcher)("s", "q", controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });
});
