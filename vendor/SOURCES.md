# Sources

Ported into omp-optchat on 2026-10-11 from the planning kit at `omp-jevify/docs/references/optchat-jev-kit` (that copy is the reference snapshot). Adapted skills now live in `.omp/skills/`; this directory keeps the upstream originals and licences. Fetched 2026-10-11. Upstream originals are kept byte-identical under `vendor/`. Active OMP skills under `.omp/skills/` are adapted copies; each adapted file is listed below with what changed. Files written for the planning kit are listed at the end.

## OpenAI cookbook (MIT)

- Repo: https://github.com/openai/openai-cookbook, commit `5bd6cb4`
- `articles/codex_exec_plans.md` → `vendor/openai-cookbook/codex_exec_plans.md` (whole article, unmodified)
- The fenced `PLANS.md` inside that article → `.agent/PLANS.md` (verbatim, fence removed), licence at `.agent/PLANS.LICENSE`
- The one-line `AGENTS.md` ExecPlans rule from the article is reused in this repo's `AGENTS.md`
- Article: https://github.com/openai/openai-cookbook/blob/main/articles/codex_exec_plans.md

## OpenAI skills (Apache-2.0)

- Repo: https://github.com/openai/skills
- `skills/.experimental/create-plan/` at commit `a511969` (parent of `ea6b206`, "Remove experimental skills except wrapped", which deleted it)
- Unmodified original → `vendor/openai-skills/create-plan/` (`SKILL.md`, `LICENSE.txt`). Not active; see [Dropped upstream skills](#dropped-upstream-skills).

## Matt Pocock's skills (MIT)

- Repo: https://github.com/mattpocock/skills, commit `49dd158`
- Unmodified originals (byte-identical, including each `agents/openai.yaml` Codex metadata file and each skill's `LICENSE`):
  - `skills/engineering/wayfinder/` → `vendor/mattpocock-skills/wayfinder/`
  - `skills/productivity/grilling/` → `vendor/mattpocock-skills/grilling/`
  - `skills/engineering/domain-modeling/` → `vendor/mattpocock-skills/domain-modeling/`
  - `skills/engineering/research/` → `vendor/mattpocock-skills/research/`
  - `skills/engineering/prototype/` → `vendor/mattpocock-skills/prototype/`
  - `skills/productivity/handoff/` → `vendor/mattpocock-skills/handoff/`
  - `skills/engineering/setup-matt-pocock-skills/` (whole) → `vendor/mattpocock-skills/setup-matt-pocock-skills/`, for switching to a GitHub or GitLab tracker later (`issue-tracker-github.md`, `issue-tracker-gitlab.md`, `issue-tracker-local.md`, `triage-labels.md`, `domain.md`)
  - `docs/engineering/wayfinder.md` → `vendor/mattpocock-skills/wayfinder-docs.md`
  - Repo `LICENSE` → `vendor/mattpocock-skills/LICENSE`
- Copies in `docs/agents/` (kept as the active per-repo config, edited for OMP; see below): `setup-matt-pocock-skills/issue-tracker-local.md` → `docs/agents/issue-tracker.md`, `setup-matt-pocock-skills/domain.md` → `docs/agents/domain.md`. The unmodified originals stay in `vendor/mattpocock-skills/setup-matt-pocock-skills/`.

Wayfinder calls the grilling, domain-modeling, research and prototype skills by name, and reads the tracker doc; that's why they're included.

## Active OMP skills (`.omp/skills/`)

Each adapted skill folder that came from Matt Pocock carries the upstream `LICENSE` (MIT, © 2026 Matt Pocock).

| Active file | Upstream source | Unchanged? | What changed and why |
|---|---|---|---|
| `.omp/skills/domain-modeling/SKILL.md` | `vendor/mattpocock-skills/domain-modeling/SKILL.md` | Yes (byte-identical) | Copied as-is. `ADR-FORMAT.md`, `GLOSSARY-FORMAT.md`, `LICENSE` copied as-is. `agents/openai.yaml` not copied (Codex metadata). |
| `.omp/skills/prototype/LOGIC.md`, `UI.md`, `LICENSE` | `vendor/mattpocock-skills/prototype/` | Yes (byte-identical) | Copied as-is. |
| `.omp/skills/prototype/SKILL.md` | `vendor/mattpocock-skills/prototype/SKILL.md` | No | Body unchanged. Added the "OMP notes" section: a logic question with no UI can be answered by a throwaway `eval` cell (Python or JS) that prints the full state after each step; an HTML logic prototype can be checked with the eval `browser` helper; dev servers start with `bash` `ready`. Why: OMP has an eval kernel and a browser helper, so the Codex/Claude "open a file in a browser" step is not the only way to test. Frontmatter kept. No `agents/openai.yaml`. |
| `.omp/skills/wayfinder/SKILL.md` | `vendor/mattpocock-skills/wayfinder/SKILL.md` | No | Host and invocation: "call the Skill tool with X" → "read and follow `skill://X`"; `/wayfinder` → `/skill:wayfinder <map path or issue>` (and `/skill:wayfinder <idea>` to chart); the `disable-model-invocation: true` frontmatter is kept. Research subagents → one `task` batch (`scout` for read-only lookups, default `task` agent when a findings file must be written; `isolated: true` only on GitHub). Why: those are the OMP primitives. Sizing: "100K token agent session" → "one OMP session … if it would need compaction or `/handoff`, split it". Removed `/setup-matt-pocock-skills`; the skill now points to `docs/agents/issue-tracker.md` and, for switching trackers, to `vendor/mattpocock-skills/setup-matt-pocock-skills/`. Added: research claims tagged runtime-observed / source-read / [INFERENCE]; HITL grilling is never hand-resolved by the agent (kept and made explicit). HITL/AFK rules, one-ticket-per-session, fog and out-of-scope rules kept. Wayfinder map/ticket layout is the tracker doc's, not hard-coded. |
| `.omp/skills/grilling/SKILL.md` | `vendor/mattpocock-skills/grilling/SKILL.md` | No | Frontier and round logic kept. Multiple-choice frontier questions (2-5 options, `recommended` set) may go in one `ask` tool call; open questions stay numbered markdown rounds with a recommended answer. Facts → `task` subagents (`scout`/default), non-blocking, results auto-deliver; the agent tags their findings runtime-observed / source-read / [INFERENCE]. Decisions → the user, never answered by the agent. Why: `ask` is OMP's native batched question tool; the rule "facts are yours, decisions are the user's" needs an explicit OMP mechanism. |
| `.omp/skills/research/SKILL.md` | `vendor/mattpocock-skills/research/SKILL.md` | No | "Background agent" → one background `task` subagent (default agent, since it writes a file); the parent keeps working. Added: primary sources via `web_search` and `read` of URLs and source; each claim tagged runtime-observed / source-read / [INFERENCE]; output path `docs/research/<slug>.md` in this kit; no code or tracker edits. Why: makes the claim-tagging rule and output location concrete for OMP. |
| `.omp/skills/execplan/SKILL.md` | none (kit-written) | n/a | Rewritten from the kit's Claude-era `execplan` to be OMP-native: rules in `.agent/PLANS.md` (read in full each time), resume from Progress / Surprises / Decision Log, mirror the milestone into the `todo` tool, delegate slices with `task` (one owner per file), verify with the plan's own commands, fold Wayfinder answers into the Decision Log with the ticket path plus a revision note. |

## Dropped upstream skills

Not active in `.omp/skills/`. The originals stay in `vendor/` (except the Claude-only autoresearch skill, which was kit-written and is deleted).

- `handoff` (Matt Pocock, `vendor/mattpocock-skills/handoff/`) → host `/handoff` (summarize the session into a handoff document).
- `create-plan` (OpenAI, `vendor/openai-skills/create-plan/`) → plan mode (`/plan`, which writes `local://<slug>-plan.md`; `plan.enabled` is currently `false` on this host) or the `todo` tool.
- `autoresearch` (kit-written, deleted with `.claude/`) → host `/ratchet` (trusted-eval hill-climb; `ratchet(flow)` in eval; state under `.omp/ratchet/<flow>`).
- `setup-matt-pocock-skills` (Matt Pocock, `vendor/mattpocock-skills/setup-matt-pocock-skills/`) → not shipped as a skill. Its per-repo output is `docs/agents/issue-tracker.md` and `docs/agents/domain.md`; its tracker variants stay in vendor for switching.
- Codex `agents/openai.yaml` metadata (all upstream skills) → dropped from active copies, kept in vendor. Codex and Claude plugin packaging do not apply under OMP.

## Edited copies in `docs/agents/`

These started as Matt Pocock's setup outputs. The unmodified originals are in `vendor/mattpocock-skills/setup-matt-pocock-skills/`.

- `docs/agents/issue-tracker.md`: `/wayfinder` → the wayfinder skill (`/skill:wayfinder`). Local-markdown tracker kept as the default. Added a "GitHub variant" section (labels `wayfinder:map|research|grilling|prototype|task`, child sub-issues, native blocked-by dependencies, claim by assignment) pointing to `vendor/mattpocock-skills/setup-matt-pocock-skills/issue-tracker-github.md`. Why: the kit does not ship `/wayfinder`, and the map is on GitHub in sibling repos.
- `docs/agents/domain.md`: `/domain-modeling`, `/grill-with-docs` and `/improve-codebase-architecture` → the shipped `domain-modeling` skill (`skill://domain-modeling`). Why: the kit ships only `domain-modeling`; the other two are not in the kit.

## Design sources (linked, not copied)

- OptChat spec, Victor Taelin: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449
- Jev on OpenRouter: https://openrouter.ai/%7Etypesafe/jev-latest
- Other Jev sources are listed at the end of `docs/design/optchat-jev.md`.

## Written for this kit

- `README.md`, `AGENTS.md` (apart from the ExecPlans rule), `GLOSSARY.md`
- `plans/optchat-jev.md`
- `docs/design/`, `docs/evals/`, `docs/research/`
- `.scratch/optchat-jev/`
- `.omp/skills/execplan/SKILL.md`
- This file, `vendor/SOURCES.md`

Removed: `CLAUDE.md` (the agents-md host loads `AGENTS.md`; a `CLAUDE.md` beside it is shadowed and redundant), `.claude/` (including the kit's `autoresearch` skill and the Codex `agents/openai.yaml` metadata).
