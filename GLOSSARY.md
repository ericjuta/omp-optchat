# OptChat + Jev

An endless-chat AI agent whose memory is its own chat history, compressed into a summary tree, with fast typed decisions gating the slow model calls.

## Memory

**Message**:
One entry in the chat history, with a permanent integer id and a kind: user, talk, tool, echo, note or work.
_Avoid_: turn (a turn is one model call), event, entry

**Log**:
The append-only record of every message, verbatim, forever.
_Avoid_: history file, transcript

**Node**:
One summary line in the tree, covering a power-of-two run of consecutive messages.
_Avoid_: chunk, block, summary (when the specific line is meant)

**Tree**:
The binary hierarchy of nodes: level 0 summarises one message, each higher level merges its two children.
_Avoid_: index, hierarchy

**Address**:
A node's name, `id+n`: its first message id and how many messages it covers.
_Avoid_: node id, coordinates

**Free node**:
A node whose source already fits the size target, so it is stored verbatim with no model call.

**Compactor**:
The background worker that builds nodes with a cheap model, in dependency order. omp-optchat's code calls it the compressor; the design's older wording was "strict order".
_Avoid_: summariser (that is the model call it makes)

**View**:
The ordered list of nodes covering the whole chat that the agent sees every turn. omp-optchat keeps it under an upper budget (128,000 bytes) and merges it down to a target (64,000 bytes).
_Avoid_: context, window, memory dump

**Part**:
One node as it sits in the view.

**Fit**:
Merging adjacent view parts until the view is under its upper budget. omp-optchat merges the adjacent pair whose last message is oldest (the design's start-based rule is superseded).
_Avoid_: compaction (that word means wholesale summarise-and-replace, which this design avoids)

**Settle**:
Waiting until every part of the view is a built node before any model sees it.

**Zoom**:
Opening a node into the two nodes it was made from, or into the original message at the bottom. Returned in pages of at most 16 KB.
_Avoid_: expand, drill down

**Turn**:
One fresh model call answering the user's latest message, with nothing carried over except the view and the per-turn blocks.
_Avoid_: session, round

**Unknown cost**:
A usage row that has no price or no token count. It is reported as unknown, never as zero.
_Avoid_: free, zero-cost

## System One

**System One model**:
A model that returns typed decisions (choices, scores, probabilities) in one fast pass and never writes text. Jev is the one we use. In OMP it is reached through the host's `judge` role.
_Avoid_: classifier (too narrow), small model

**Gate**:
One place in the flow where the System One model is asked typed questions and code acts on the answers under thresholds. Each gate has its own flag.
_Avoid_: filter, guardrail (a gate can add context, not only block)

**Rule**:
A standing instruction or preference the user has given that should hold until changed.
_Avoid_: preference (too narrow), setting

**Rules ledger**:
The durable list of current rules, with ids `r1`, `r2`, and so on. Shown to the agent as a message after the view each turn. Changed by a visible announcement and `/optchat rules remove <id>`.
_Avoid_: memory, AGENTS file

**Prefetch**:
Zooming the view lines the System One model scored as most relevant before the agent starts, and showing the result after the ledger.

**Codemode retrieval**:
An eval-kernel script that reads memory through `tool.zoom`, `tool.date` and `tool.work` and scores lines with `judge_batch`, to find what it needs in one step.
_Avoid_: self-managed memory (writes stay fixed)

**Value score**:
A System One label and importance for a message, passed to the compactor as a closed-template hint.

## Subagents

**Subagent**:
A separate agent started by OMP's `task` tool for one task. It runs with approval set to yolo, and it does not change the parent's memory. Its view of the parent is opt-in (child views).
_Avoid_: worker, child agent

**Report**:
A subagent's or background job's final output, logged as a `work` message. Reports are not user words, so they never create rules.
_Avoid_: result, handoff

## Evaluation

**Probe**:
A question with a known answer, asked at a set point in a replayed chat.

**Hard gate**:
An eval check whose failure rejects a candidate outright, whatever its other scores.
_Avoid_: gate (reserved for System One gates)

**Ablation**:
An eval run with one System One gate switched on or off, to measure what that gate is worth.
