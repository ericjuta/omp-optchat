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
