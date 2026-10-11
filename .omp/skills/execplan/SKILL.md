---
name: execplan
description: Write, resume, revise or execute an ExecPlan (a self-contained living build plan per .agent/PLANS.md). Use when starting or continuing implementation from plans/, or when a resolved Wayfinder ticket needs folding into the plan.
---

An ExecPlan is the single document a fresh agent needs to build something: it must work with no other context. The rules live in `.agent/PLANS.md`; this skill is how to apply them in this repo. The plan itself is in `plans/`. The plan's `Progress` section is the durable record of where work stands; the OMP `todo` tool is only the working view of the current milestone.

## Before anything

Read `.agent/PLANS.md` in full, every time. Then read the plan in `plans/`.

## Resuming

1. Read `Progress`, `Surprises & Discoveries` and `Decision Log` first; they say where the last session stopped and why.
2. Take the first unchecked `Progress` item. Don't ask the user what's next.
3. Mirror that milestone's steps into the `todo` tool (`init` with one phase per milestone and one item per step). Keep the `Progress` section as the record; `todo` is a view of it, not a replacement.
4. Delegate independent slices with `task` subagents. Give each one the plan path (`plans/<name>.md`), the milestone it serves, and its slice. Give each shared file one owner: no two subagents edit the same file. Sequence only true dependencies.
5. Work in small, testable steps. Before checking an item off, run the plan's validation commands exactly as written and compare the output with the plan's expected output.
6. At every stopping point, update `Progress` (split a half-done item into done and remaining, with a UTC timestamp), add surprises with evidence, and record decisions with their rationale. The plan must always let someone else restart from it alone.

## Folding in Wayfinder decisions

When a Wayfinder ticket (`.scratch/<effort>/issues/NN-<slug>.md`, or the equivalent on another tracker) is resolved:

1. Copy its answer into the plan's `Decision Log`: the decision, the rationale, the date (UTC), and the ticket path.
2. Update every section the decision changes: Context, the milestones, the validation commands, Interfaces, and any Progress item that assumed the old answer.
3. Add a revision note at the bottom of the plan saying what changed and why.

Don't fold a ticket that is still open or still a grilling in progress; wait for its `## Answer` section.

## Writing a new plan

Start from the skeleton in `.agent/PLANS.md`. Define every term of art in plain words. Name exact files, commands and expected output. Make each milestone independently verifiable. Prose first; checklists only in `Progress`.

## When the plan and reality disagree

Reality wins. Record the evidence in `Surprises & Discoveries`, the new direction in `Decision Log`, and fix the affected sections. Don't silently drift from the plan.
