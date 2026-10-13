# Jev through the OMP host: measured limits

Measured on 2026-10-13 for map ticket 01 (`.scratch/optchat-jev/issues/01-jev-api-and-limits.md`). Every claim is tagged with one of these labels:

- **[observed on this host]**: measured from this workstation through the OMP eval kernel.
- **[source-read]**: read from a cited file.
- **[vendor, unverified]**: a vendor or press claim this run did not check.
- **[INFERENCE]**: a conclusion drawn from the observations, not measured directly.

Only error classes are recorded (HTTP status and `error_type` identifiers), never provider message text.

## Method

- **Route.** Calls went through the eval kernel's `judge` and `judge_batch` globals, so they used the host's judge role chain (`docs/research/omp-capabilities.md` §1.2). Every successful call was served by `openrouter/typesafe/jev-1.13-20260917` (the `model` field in batch status) [observed on this host].
- **No cache hits.** Every state carried a fresh random nonce, so the shared answer cache never answered [observed on this host].
- **Size and cost probes.** These ran as single-item `judge_batch` calls (`retries=0`, `concurrency=1`) so the batch status could report cost. The cost figure is the host's estimate, not an invoice.
- **Latency.** Latency was timed around direct `await judge(...)` calls, run sequentially (20 per shape), and then as 5 waves of 4 concurrent calls.
- **Token counts.** Token counts come from `omp toks <file> --json`, `jev` encoding (the offline Jev tokenizer the host ships).
- **States.** Two kinds of text were used:
  - "Wordy" text: random words with numbers, about 0.45 Jev tokens per byte.
  - "Entropy" text: random printable ASCII, about 0.75 Jev tokens per byte [observed on this host].

## Measurements

### 1. Questions per request

| Shape | Sizes tried | Result | First failure class |
|---|---|---|---|
| `bool`, 15,244-byte JSON state | 1, 8, 32, 64, 128, 255, 256, 512, 1024, 2048 | all answered, every answer present | — |
| `bool`, same state, bisected | 3072, 3584, 3712 ok; 3840 fail | ceiling between 3712 and 3840 | HTTP 400 `max_tokens_exceeded` |
| `bool`, tiny state, 1-word instruction | 4096 ok; 8192 fail | — | HTTP 400 `max_tokens_exceeded` |
| `choice` (2 labels), 15,244-byte state | 1, 8, 32, 64, 128, 255 | all answered | — (not pushed further) |
| One `choice`, label count | 2, 64, 255 ok; 256, 512 fail | at most 255 labels | HTTP 400 "too many choices" class |

All rows: [observed on this host].

- No per-request cap on the number of questions appeared up to 4096. The first failure is always the token ceiling: questions are counted together with the state.
- The 255-option cap is per `choice` question (labels), not per request. This confirms the vendor claim for labels [observed on this host].

### 2. Latency (wall time in the eval kernel, nonce states, no cache hits)

| Shape | n | p50 | p95 | max | Errors |
|---|---|---|---|---|---|
| 1 `bool`, 46-token state | 20 sequential | 0.240 s | 0.909 s | 1.429 s | 0 |
| 23,805-byte JSON state (116 lines, 5,811 Jev tokens) + 64 `bool` | 20 sequential | 0.305 s | 0.457 s | 1.174 s | 0 |
| Same 24 KB / 64-question shape, 4 in flight | 5 waves × 4 | 0.309 s per call | 0.545 s per call | 1.494 s per wave | 0 |
| Question-count and context probes (single-item batches, 1–4096 questions, 18k–33k tokens) | ~60 | 0.2–0.5 s typical; 0.74 s at 2,048 questions; 1.14 s at 4,096 tiny-state questions | — | 1.14 s | 0 (token-ceiling rejections returned in 0.2–0.8 s) |

All rows: [observed on this host].

- The vendor's 70–500 ms latency claim matches the p50s. The p95 for one question (0.91 s) exceeds it [observed on this host].
- 4 concurrent requests triggered no rate-limit class [observed on this host]. Higher concurrency was not probed.

### 3. Context ceiling (one short `bool` question, plain-string state)

| Text | Bytes | Jev tokens | Result |
|---|---|---|---|
| entropy | 24,000 / 32,000 / 32,768 / 34,000 / 36,000 / 40,000 | 18,023 / 24,028 / 24,604 / 25,540 / 27,026 / 30,032 | ok |
| entropy | 42,500 / 43,500 | 31,905 / 32,658 | ok |
| entropy | 44,200 / 45,000 | 33,198 / 33,800 | HTTP 400 `max_tokens_exceeded` |
| wordy | 32,000 / 48,000 / 64,000 / 72,000 | 14,545 / 21,801 / 29,057 / 32,683 | ok |
| wordy | 72,125 / 72,250 / 72,500 / 73,000 / 74,000 / 76,000 | 32,741 / 32,790 / 32,907 / 33,127 / 33,566 / 34,490 | HTTP 400 `max_tokens_exceeded` |

All rows: [observed on this host].

- **Where it fails.** The largest state judged was 32,683 Jev tokens and the smallest rejected was 32,741 [observed on this host]. A state near 32,000 tokens succeeds; one near 33,000 fails. This agrees with omp-jevify's record (32,086 and 32,595 ok; 33,101 failed; `docs/research/omp-capabilities.md` §3).
- **The limit is about tokens, not bytes.** A 43,500-byte state succeeded and a 72,000-byte state succeeded [observed on this host].
- **Likely total limit.** The request limit is probably 32,768 tokens in total, counting state, questions and a fixed template overhead of a few tens of tokens [INFERENCE: the measured state-only boundary sits 27–85 tokens below 32,768].
- **No 64k context.** The vendor's "64k per request" claim does not hold on this route: requests fail above about 32.7k [observed on this host].
- **Questions count too.** In §1, 3712 short questions over a 15 KB state passed and 3840 failed. Question text spends the same token budget as the state [observed on this host].

### 4. Cost (host batch-status estimates)

| Item | Cost | Label |
|---|---|---|
| Marginal rate | $0.0424–0.0428 per million Jev tokens across 10 states of 14.5k–32.7k tokens | [observed on this host]; matches the vendor's $0.042/M input [vendor claim now consistent] |
| One tiny 1-question call | $1.32e-5 | [observed on this host] |
| Per-request fixed cost | $1.3e-5 for a 46-token state; about 0.3k tokens at the marginal rate, but the gap is not explained by the rate | [INFERENCE] |
| One extra `bool` question | about $6.5e-7 (2048 questions: $0.00163; 1 question: $0.000305, same state) | [observed on this host] |
| One 24 KB / 64-question request | $0.000316 | [observed on this host] |

## Spend

| Block | Calls | Spend |
|---|---|---|
| Smoke | 2 | $0.00003 |
| Questions sweep and label cap (incl. bisection) | 27 | $0.0185 |
| Latency (direct `judge`, estimated at the per-shape batch cost) | 60 | $0.0129 |
| Context ceiling (approximate) | ~25 | ~$0.0136 |
| **Total** | **~114** | **≈ $0.045** (cap $2) |

Failed requests reported zero cost.

## Route behaviour seen on this account

- **Fallback on 400.** A HTTP 400 from the OpenRouter candidate fell through to the next native candidate, direct TypeSafe `jev-latest` [observed on this host: 256-label `choice`]. It did not propagate straight away.
- **Direct TypeSafe has no credits.** The direct route answered HTTP 402 `billing_error`, so that candidate went into the 5-minute account-rejection cooldown described in `docs/research/omp-capabilities.md` §1.2 [observed on this host]. Until then, every request this run answered successfully went through OpenRouter.
- **Wasted fallback.** A malformed request (more than 255 labels, or over the token ceiling) can therefore cost one extra failed round trip and park the direct candidate [INFERENCE].

## Still unverified (needs a key, credits or more spend)

- Behaviour of the direct TypeSafe `/v1/systemone` route. This account has no TypeSafe credits (HTTP 402 above).
- Rate limits and throughput above 4 concurrent requests. Per-account request or token quotas.
- `choice` and `score` questions above 255 per request. Only `bool` was pushed to the token ceiling; `choice` passed at 255.
- Latency under sustained load, or from other hosts. All figures come from one session on 2026-10-13.
- Vendor claims not checked here: release date, synthetic training data, the "no explanations" property (consistent with the typed answers seen, but not tested).
