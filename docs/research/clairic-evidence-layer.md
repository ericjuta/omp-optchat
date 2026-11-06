# Clairic evidence layer: fact check (2026-11-06)

This note checks the claims in `docs/references/chatgpt-repository-feature-review.md` (a ChatGPT review of v0.14.0, b309c7e). Each claim is tagged **source-read** (code, docs or vendor pages read), **runtime-observed** (we ran something), or **[INFERENCE]**. We ran nothing for this note.

## Cloudflare Clairic and Clef

- Clairic exists as `@cf/cloudflare/clairic`, an extraction model in preview. Its context window is 65,536 tokens. Fields that do not fit beside the input in one 8,192-token pass are split into parallel passes, and each pass sees the whole input. It costs $0.10 per million input tokens and charges nothing for output. Source-read: https://developers.cloudflare.com/workers-ai/models/clairic/ and https://blog.cloudflare.com/clairic-extraction-model/.
- The request takes `state` (text), `fields` (a map of name to typed spec: text, number, date, time, datetime, duration, list, estimate or forecast, each with optional `instructions`), `images` (at most 4), `reference_date` and `options`. Source-read, same pages.
- The response is `{answers, truncated, usage{input_tokens, passes, ...}}`. A scalar answer is `{value, guess, p_null, confidence}`. A text answer adds `span: [start, end]` in **character** offsets; a list answer has `spans`. `value` is null when the input does not settle the answer, while `guess` still shows what the model would have picked. Source-read, same pages.
- You call it through a Workers AI binding (`env.AI.run`) or REST (`POST /client/v4/accounts/{id}/ai/run/@cf/cloudflare/clairic`) with a Cloudflare API token. Neither page documents an OpenAI-compatible endpoint. Source-read.
- Clef (`@cf/cloudflare/clef`, 27B, $0.24/M input) is a decision model with noul, choice and score questions. It plays the same role as OptChat's existing judge. Source-read: https://developers.cloudflare.com/workers-ai/models/clef/.

## Repository claims (v0.14.0)

| Claim in the review | Verdict | Evidence |
|---|---|---|
| `chat_recall` returns one winning message, its first 8,000 bytes; `k` only exposes alternate ids and scores | True | source-read `src/system1/recall.ts:11-13,209-243` |
| Scoring sees leaf summaries and raw openings | True with a caveat: raw seed lines are cut to 4,000 bytes, and leaves are summaries unless the message fits in one node | `recall.ts:175-181,254-261` |
| `decideTriage` joins several standing sentences into one rule | True: `kept.join(" ")` produces one add or replace decision | `src/system1/rules.ts:150-168`; one ledger id per decision is [INFERENCE] |
| Automatic replace or withdraw targets only the newest 32 active rules | True | `rules.ts:8-12`, `README.md:224` |
| The judge exposes no extraction interface | True for both plugin and host: the host has a `workers-ai-systemone` judgment wire, which answers finite questions only | `src/system1/judge.ts`; `node_modules/@oh-my-pi/pi-ai/src/judgment/native.ts:49`, `openai-decisions.ts:26-29` (host 18.10.3 vendored) |
| The recall grader needs a gold id and grades `none` as a failure | Partly true: judged `also` ids and answer keys also pass | `evals/recall/grade.ts:90-120` |
| README still shows v0.7.0; CHANGELOG contradicts the plan on host regressions | True. CHANGELOG:11 says repair is "pending"; plan lines 22 and 292 record the repair, and lines 93 and 702 are stale | `README.md:36`, `CHANGELOG.md:11`, `plans/optchat-jev.md` |
| The child view is a frozen snapshot; stores are per worktree | True | `src/index.ts:849-901`, `README.md:225` |

## Consequences for the design

- Clairic cannot reach OptChat through the host `judge` role. AGENTS.md forbids adding a provider client, SDK or API key to the plugin. So we need a host-side extraction interface first, like the source-only host patch pattern. [INFERENCE]
- Clairic spans are character offsets, and OptChat measures in UTF-8 bytes. Mapping between them needs tests with non-ASCII text and repeated text. [INFERENCE]
- Clairic's null semantics (`value` null, `guess` present) mean that confidence alone must never admit an extraction. Code-owned validation decides (AGENTS.md: "never let a Jev answer act without" a threshold). [INFERENCE]
- The rule-joining defect can be fixed without Clairic, by splitting the decision per sentence. [INFERENCE]
