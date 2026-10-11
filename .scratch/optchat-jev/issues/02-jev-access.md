Type: task
Status: open
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
