Type: research
Status: open
Blocked by: 02

# Jev through the OMP host

## Question (re-scoped 2026-10-11)

The original question asked for transport options, request and response shapes, and limits from primary sources. Part of it is now answered from this host: `docs/research/omp-capabilities.md` §1.2 covers the judge role, `resolveJudge` and its fallback chain, the typed question shapes, the five-minute cooldown after an account rejection, and the shared answer cache. §3 covers omp-jevify's observations, including the 32,000-token ceiling and the tokenizer's rate of at most one token per byte. Vendor claims (price, latency, the 255-option cap, the 64k context) remain unverified.

Still open, to be measured from this host with the OMP eval kernel (ticket 02 gives access):

1. Maximum questions per request. With a fixed state, find the largest number of `bool` and `choice` questions one `judge` call answers without error, and record the first failure class.
2. Latency from this host: p50 and p95 over about 20 calls, for one question and for a 24,000-byte state with 64 questions.
3. The context ceiling as observed: whether a state near 32,000 Jev tokens succeeds and whether one near 33,000 fails.

Write the findings to `docs/research/jev-api.md`, with a citation or an "observed on this host" label for each claim, and list anything that needs a key or account limit to confirm. Keep unverified vendor claims labelled as such.

Starting points: `docs/design/optchat-jev.md` §3.1 and its Sources; `docs/research/omp-capabilities.md` §1.2 and §3.

## Comments

Blocked by 02: the measurements need an account that answers.
## Answer

Measured 2026-10-13 from this host through the eval kernel's `judge` and `judge_batch` globals. Calls were served by `openrouter/typesafe/jev-1.13-20260917`. Direct TypeSafe returned HTTP 402 `billing_error` and entered the 5-minute cooldown, so the direct route is unverified. Full table, labels and method: `docs/research/jev-api.md`. Spend about $0.045 of the $2 cap, across about 110 calls. Failed calls cost nothing.

1. **Questions per request (observed on this host).** `bool` questions passed up to 3,712 over a 15 KB state. The first failure was HTTP 400 `max_tokens_exceeded` at 3,840. The limit is the shared token budget, not a question count. `choice` passed at 255 questions per request, and labels passed up to 255 per question. 256 labels failed with HTTP 400 "too many choices" (the 402 from direct TypeSafe also appeared in that failure).
2. **Latency (observed on this host, n=20 each, nonce states).** One question: p50 0.24 s, p95 0.91 s. 24,000-byte state (23,805 actual, 5,811 Jev tokens) with 64 questions: p50 0.31 s, p95 0.46 s. Four in flight (5 waves of 4): p50 0.31 s and p95 0.55 s per call, with no errors.
3. **Context ceiling (observed on this host).** Largest state judged: 32,683 Jev tokens. Smallest rejected: 32,741 Jev tokens, HTTP 400 `max_tokens_exceeded`. A state near 32,000 succeeds and one near 33,000 fails. The limit is measured in tokens, not bytes; at a 0.75 tokens-per-byte ratio that is about 43,500 bytes of random ASCII, and about 72,000 bytes of wordy text. The 64k vendor claim does not hold on this route.

**Chunker constants.**
- `PREFETCH_STATE_BYTES = 24_000` (`src/system1/prefetch.ts:8`): **holds.** Worst case is 24,000 bytes of high-entropy text (18,025 Jev tokens), plus 64 questions (about 1,900 tokens). That is about 20k tokens, under the observed 32.7k ceiling with margin.
- `PREFETCH_QUESTIONS = 64` (`prefetch.ts:10`): **holds, conservative.** The host accepted 255 questions per request. 64 is a policy choice, not a measured limit.
- `PREFETCH_IN_FLIGHT = 4` (`prefetch.ts:12`): **holds on this host.** No rate-limit error class at 4 concurrent calls, and per-call latency matched sequential calls. Concurrency above 4 was not probed.
- `RECALL_STEP_MS = 5_000` (`src/system1/recall.ts:17`): **holds with margin on observed latency** (max 1.49 s, p95 0.91 s for one question). Two caveats. The bound aborts a call that runs over, so a slow call is lost rather than retried. And the fallback path timing is not measured here, because direct TypeSafe is in cooldown on this account.

**Still unverified** (needs a funded direct TypeSafe route or more spend): direct `/v1/systemone` behaviour, rate limits above 4 concurrent calls, `choice` and `score` requests above 255 questions, latency under sustained load or from other hosts.
