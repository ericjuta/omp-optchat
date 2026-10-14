Type: task
Status: resolved
Blocked by:

# Confirm Jev access on this OMP account

## Question

This host's `judge` role already maps to `openrouter/~typesafe/jev-latest` (`~/.omp/agent/config.yml:6`). Jev is still waitlisted at TypeSafe. Confirm that a judgment works from the OMP eval kernel on this host, and record what happened:

1. Run one tiny judgment in the eval kernel through the `judge` role: `judge(state, questions)` with one `bool` question and one `choice` question. The kernel spells the yes/no type `bool` (`docs/research/omp-capabilities.md` §1.3).
2. Record which candidate answered (native or fallback, from the usage row or `ChainJudge` if visible), the model id, the usage fields returned, and any error class. Record error classes, never provider text that could carry a key.
3. Record any account limit visible in errors, such as the 401, 403 or 402 cases that start the five-minute cooldown.
4. Record only variable names, if the route needs any, in `.env` terms. Never write the key itself.

Human step: none if the account already answers. If it does not, the agent prepares a checklist (TypeSafe early access at typesafe.ai, or an OpenRouter key with access to `~typesafe/jev-latest`) and the human signs up.

Write the result as an `## Answer` section, then update the map's Decisions so far.

## Comments

Ticket 01's measurements depend on this ticket.

## Answer

2026-10-12, OMP eval kernel on this host, `judge` role = `openrouter/~typesafe/jev-latest`.

- One `bool` + one `choice` judgment answered natively in 0.33 s: danger P(yes)=0.97, choice `file_op` p=1.
- Candidate: native Jev, model `openrouter/typesafe/jev-1.13-20260917` (from `judge_batch` status); cost $1.14e-05 per one-question state. No error class, no account-limit errors.
- Route: OpenRouter credential already in OMP's credential store; no new variable names. Jev is not on an OAuth subscription; only proposer and runner roles (`default`, `task`, `smol`, all `anthropic/*`) bill to OAuth.
- Without a native judge the decided fallback applies: every gate is inactive (the tool gate was removed in 0.8.0).
- 2026-10-13: the direct TypeSafe credential answered HTTP 402 (no billing) and was removed through the host's RPC `logout` (marked "deleted by user"), by Eric's decision. Jev is reached through OpenRouter only; a check judgment afterwards answered in 0.43 s from `openrouter/typesafe/jev-1.13-20260917`.
