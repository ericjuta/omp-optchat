Type: grilling
Status: resolved
Blocked by:

# Runtime and model stack

## Question

Confirm or replace the defaults in the ExecPlan's Decision Log: the runtime, the model API for the agent and the compactor, the concrete model ids, and the compactor's effort setting.

## Answer

Resolved 2026-10-11 by the user's direction and the audit in `docs/research/omp-capabilities.md`.

- **Implementation home: an OMP extension in omp-optchat.** The gates are flags in the omp-optchat plugin (v0.5.0), written in TypeScript on Bun. They are tested with `bun test tests`, typechecked with `bun run typecheck`, and smoke-tested against the installed `omp` with `bun run smoke` (research §2; omp-optchat `package.json` scripts). The standalone application first assumed in the original design is dropped.
- **Model roles come from OMP, not from a provider SDK.** The agent uses the session model. The compactor uses `--optchat-model`, which defaults to `@smol` (`src/config.ts:8`; flag registered at `:73-76`; resolved at `:205`). Jev is reached through the host `judge` role (`~/.omp/agent/config.yml:6`). The plugin has no Anthropic Messages client and no model SDK.
- **Effort and concrete model ids** are whatever the chosen role resolves to. Changing one is a flag or a config line, not a code change. No environment variable holds a model id.
- **Prompt caching** is provider-specific and owned by `src/cache.ts`. Ticket 05 checks the current rules.

Consequences for the ExecPlan: Milestone 0 builds in a worktree from HEAD, and the sibling draft in the main checkout is reviewed before anything is adopted. The plan's Decision Log records this.
