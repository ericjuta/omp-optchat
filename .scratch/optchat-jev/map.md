# Wayfinder map: OptChat + Jev

## Destination

`plans/optchat-jev.md` has no open decisions left: every default in its Decision Log is confirmed or replaced, Jev's limits as seen from this OMP host are measured, and the gate set, eval scope and demo are chosen. An agent can then implement the plan milestone by milestone without asking anything.

## Notes

- Domain: an endless-chat agent (OptChat, the omp-optchat plugin) with a summary tree plus fast typed decision gates (Jev, reached through OMP's `judge` role). Read `GLOSSARY.md`, `docs/design/optchat-jev.md` and `docs/research/omp-capabilities.md` before working any ticket.
- Skills to consult: `/skill:grilling` and `/skill:domain-modeling` for decisions, `/skill:research` for facts, `/skill:prototype` for logic questions. Research tickets can run as OMP `task` subagents in parallel.
- Tracker: local markdown, per `docs/agents/issue-tracker.md`. A ticket with `Status: open` is unclaimed. Set `Status: claimed` before any work.
- Time-boxed. If a ticket isn't resolved in time, the default already written in the ExecPlan's Decision Log stands; record that as its answer.
- When a ticket resolves, fold the answer into `plans/optchat-jev.md` (Decision Log, plus any section it changes), not just here.
- The proposal is a starting position, not a decision. Nothing below counts as decided until it appears under Decisions so far.

## Decisions so far

<!-- one line per resolved ticket or settled direction: [title](issues/NN-slug.md): gist -->

- [Implementation home is omp-optchat](issues/03-runtime-and-model-stack.md): the gates are flags in the omp-optchat OMP extension (TypeScript on Bun), not a standalone app; model roles come from OMP. Closes ticket 03.
- [Jev through the host judge role](issues/01-jev-api-and-limits.md): the plugin reaches Jev only through `resolveJudge` (the `judge` role), with no provider client. Narrows ticket 01; its remaining items are listed there.
- [View fold tested in omp-optchat](issues/04-view-fold-prototype.md): omp-optchat's fold and its named tests answer the prototype question; the untested cases move into the plan. Closes ticket 04.
- Skills live under `.omp/skills/` (wayfinder, grilling, domain-modeling, research, prototype, execplan). Set by the user's direction; no ticket.
- The eval harness and the automated research loop are out of scope for the current build. Set by the user's direction; narrows ticket 07 to the current build, and their reference documents remain in `docs/evals/`.

## Not yet specified

- Search over the raw log (text or embeddings) alongside zoom; whether it belongs in the first build.
- Where replayed real sessions come from for cost and cache metrics, and how private content is kept out of shared datasets.
- Subagents: omp-optchat already logs `work` reports and offers opt-in child views (design §4). Still open: whether the demo needs subagents, and whether the tool gate should screen subagent calls, which run in yolo mode.
- Whether Jev can pre-filter tool noise before the compactor, beyond giving it a hint.
- Rules ledger edge cases: rules with a scope ("for this project only"), and rules that expire.
- Rules ledger against other rule mechanisms on this host: OMP's judged TTSR rules (a rule file with `question:` frontmatter) and Sharpshooter memory. Which one owns standing instructions?
- Tool gate against the host's own approval settings (`tools.approval`): does the gate sit beside them, replace them, or defer to them?

## Out of scope

Proposed for this effort; edit freely.

- Computer use and desktop control.
- More than one user per chat.
- Importing chat history from other tools.
