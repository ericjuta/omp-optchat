# Issue tracker

This repo tracks work in two places, depending on the effort.

- **Wayfinder maps on GitHub Issues.** Maps for this repo are issues in `ericjuta/omp-optchat` labelled `wayfinder:map`: [#2](https://github.com/ericjuta/omp-optchat/issues/2) and [#9](https://github.com/ericjuta/omp-optchat/issues/9). Both were CLOSED when checked on 2026-10-11. Child tickets follow the GitHub variant below and carry the labels `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or `wayfinder:task`.
- **Local markdown for the System One map.** The System One map, `.scratch/optchat-jev/map.md`, is a local-markdown draft until it is charted on GitHub. Its operations are the local ones below.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations (local)

Used by the wayfinder skill (`/skill:wayfinder`) for the local System One map. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## GitHub variant

Used for maps #2 and #9, and for any map charted on GitHub later. Do not mix local ticket files into a GitHub map.

- **Map**: an issue labelled `wayfinder:map`, body as in the wayfinder skill.
- **Child ticket**: a sub-issue of the map (`gh issue edit <map> --add-sub-issue <child>`), labelled `wayfinder:research|prototype|grilling|task`. Without sub-issues, put a task-list entry in the map body and `Part of #<map>` at the top of the child.
- **Blocking**: GitHub's native issue dependencies (`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, using the numeric database id, not the `#number`). A ticket is unblocked when every blocker is closed. Where dependencies are unavailable, use a `Blocked by: #<n>` line at the top of the child body.
- **Frontier**: open child issues with no open blocker and no assignee, first in map order.
- **Claim**: `gh issue edit <n> --add-assignee @me` before any work.
- **Resolve**: post the answer as a comment, close the issue, and append a context pointer to the map's Decisions-so-far.

The full GitHub procedure is kept in `vendor/mattpocock-skills/setup-matt-pocock-skills/issue-tracker-github.md`.
