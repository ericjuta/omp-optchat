# OMP OptChat

An OMP extension implementing [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one durable chat, a binary tree of contextual summaries, and a fresh model context for each user turn. Original text remains retrievable with `zoom`; summaries are navigation, not a replacement for the log.

## At a glance

- **One chat that never ends.** Every user message, reply, tool call, tool result and subagent report is appended to a local, fsynced log under OMP's agent directory, one store per git worktree. Nothing is ever deleted or rewritten.
- **A view instead of a transcript.** Each turn the model sees a fixed-size view of the whole history: one-line summaries, oldest first, where older lines cover more messages. The view replaces the old inference history between turns, so a long chat stops growing the context.
- **Nothing is lost.** The model navigates the view with memory tools: `zoom` opens a line into its halves (or several levels at once) down to the original message, `chat_search` finds exact words in the original messages, `date` and `work` fetch timestamps and captured subagent reports.
- **System One gates, on by default.** Four small judgments through OMP's `judge` role keep standing rules across turns, prefetch relevant history before a turn, hint the compressor about what matters, and power `chat_recall`, which seeds candidates from exact-word matches in the original messages and scans the messages under its top lines for the one that answers a question. Each has its own opt-out flag.
- **Plain OMP is one flag away.** `omp --no-optchat` runs an ordinary session with no memory tools, logging, compression or context changes.

What the model sees at the start of a turn (illustrative, shortened):

```text
<chat>
0+64|user: set up the Bun repo and CI; talk: added ci.yml with typecheck, tests, smoke; echo: CI green on 18.9.1 …
64+32|user: "never push to main without asking"; tool: git push origin feat/x; echo: rejected, non-fast-forward …
96+2|user: why did the staging deploy fail?; talk: missing DATABASE_URL in the staging env …
98+1|user: ok, fix it and redeploy
</chat>
```

Each `id+n|text` line summarizes the `n` messages starting at `id`. To check the exact error from message 97, the model calls `zoom(96, 2)`, then `zoom(97, 1)` for the original text; if no line mentions it any more, `chat_search("DATABASE_URL")` finds it by its words, and `chat_recall("why did the staging deploy fail?")` has the judge score the top lines and the messages under them instead.

What it costs: a compressor call per stored message and per merge, plus judge calls with the default gates: one rules request per user message, and on a turn whose view merged, one prefetch request per chunk of up to 64 view lines. When the history still fits the model's context, OptChat costs more than plain OMP for the same answers; its value is recall past the context window (see "0.5.0 measurements"). Every compressor call is also recorded, counts only and never content, in `metrics.jsonl` in the store directory, and `/optchat status` sums it (see **Cost.** below).

## Requirements and start

- OMP **18.10.3 or newer**, Bun, and Linux. CI checks every push and runs a weekly check against the latest published OMP SDK.
- An authenticated model for the main chat and an authenticated compressor model. Compression uses OMP's `@smol` role by default; choose a competent inexpensive model explicitly if that role is unsuitable.

Install the tagged release:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-optchat.git#v0.7.0'
PI_OPENAI_STATEFUL=0 omp
```

From a local checkout:

```sh
bun install --frozen-lockfile
PI_OPENAI_STATEFUL=0 omp -e .
```

Or install the local plugin once:

```sh
omp plugin link .
PI_OPENAI_STATEFUL=0 omp
```

Installing or linking the enabled plugin activates OptChat automatically in new main-agent sessions. This default applies to both fresh installations and upgrades; no first-install marker is used. `--optchat` remains an optional explicit enable flag. Use `omp --no-optchat` for an ordinary session with no OptChat memory tools, logging, compression, or context changes; `/optchat` remains registered. The opt-out wins even when both flags are present, in either order. Do not use `--optchat=false`: OMP's boolean CLI parser treats that as enabled.

Subagents never open or write the main chat. Run just one enabled session per chat directory. To select a different memory or compressor:

```sh
PI_OPENAI_STATEFUL=0 omp -e . --optchat-dir /path/to/private/chat --optchat-model anthropic/claude-sonnet-4-6
```

Memory is per git worktree. A session inside a git checkout defaults to a directory under `optchat-worktrees/` beside the global store in OMP's agent directory, named from the worktree's basename and a hash of its real path. Each worktree therefore has its own memory, and a new worktree starts empty. Subdirectories and symlinks to the same root share their worktree's memory. Outside git, the default is the global `optchat/` store; if another session already holds it, the session instead uses its working directory's own store under `optchat-dirs/` (named like the worktree stores, from the real path of the cwd) and says so in one notice. That fallback applies only without `--optchat-dir`. To keep one memory across worktrees, pass the same `--optchat-dir` to each, at the cost of only one active session at a time. Stores of deleted worktrees remain under `optchat-worktrees/` until you remove them manually. Working-directory changes within a worktree and OMP session restarts do not start a new memory. The extension does not import existing OMP sessions automatically.

Each memory directory has exactly one writer. If another live session already holds the directory (for example, the same `--optchat-dir` in another terminal), this session becomes inactive instead of refusing prompts: it shows one warning and runs as if started with `--no-optchat`, with no memory tools, logging, compression, or context changes. `/optchat status` reports the reason and directory, and the reason is also stored in the session log as a custom `optchat-inactive` entry (its data holds `reason` and `directory`), so a session that ran without memory can be told apart afterwards. The holder of the directory is not identified: the lock is held by the kernel and carries no owner record. A store that cannot be opened for another reason, such as corruption, still refuses every prompt until restart. Subagents never open the store and do not conflict.

Advanced overrides are `--optchat-node-bytes`, `--optchat-view-bytes`, `--optchat-jobs`, `--optchat-tries`, and `--optchat-tool-cap`; their defaults are described below. `--optchat-retry-ms` was removed in 0.4.0, because failed summaries now retry on the next message. Keep the defaults unless you have measured a reason to change them. An enabled session refuses inference if `zoom`, `date`, `work` or `chat_search` is unavailable, including host modes that prohibit late tool registration.

## Using memory

The model receives the settled historical summary view before your new message, then retains its ordinary tool loop until the turn ends. Between turns, old inference history is replaced by the view. OMP's display transcript and normal tools remain available.

- `zoom(id, n)` opens an aligned power-of-two summary range into its children. `zoom(id, n, depth)` opens `depth` levels at once (1 to 4, at most `log2(n)`): the `2^depth` lines `depth` levels under the range, each covering `n / 2^depth` messages. The default `depth` is 1, the same as `zoom(id, n)`. `zoom(id, 1, offset)` returns one 16 KB page of the original record, cut on a UTF-8 boundary, plus its stored images. Follow `details.next` until it is `null`; together the pages reproduce the record byte for byte.
- `chat_search(text, kind, limit, before)` finds stored messages that contain every whitespace-separated word of `text`, case-insensitively, newest first. It searches the original messages, not the summaries, so it finds names, paths, numbers and errors that a summary dropped. `kind` restricts hits to one of `user`, `talk`, `tool`, `echo`, `note` or `work`; `limit` returns 1 to 50 hits (default 10); `before` (1 or more) returns only messages with an id below it. A search of two or more distinct words that has no hit also lists how many messages contain each word, so a word can be dropped, and names `chat_recall` when that tool is registered. A `zoom(id, 1)` page of a tool call also gives `[result: message N]`, the record that stores the call's result, once it is logged (calls issued together pair with their results in order). Each hit prints its id, kind and a snippet of about 240 bytes. Open a hit with `zoom(id, 1)`. When older hits remain, the last line gives `before=<id>` for the next call. Memory tool calls and search or recall results are never hits. `text` is at most 200 characters and 8 words.
- `work(name, offset)` pages a captured subagent or background report by job ID, agent ID, or name; the newest match wins.
- `date(id)` returns the original message's local date and time. New records keep the host's event timestamp, not the time of writing.
- `/optchat status` reports memory and background compression state, and, once the store has recorded compressor calls, their number and the cost the host reported for them.
- `/optchat view` displays the current view.
- `/optchat export /path/to/history.html` creates a self-contained, navigable HTML history (treat it as private).
- `/optchat import /path/to/history.txt` imports plain text as a note. JSONL accepts `{ "kind": "note", "text": "…", "date": "2026-10-05T00:00:00.000Z" }`; kinds are `user`, `talk`, `tool`, `echo`, `work`, and `note`, with optional strict `metadata`. All records and images are validated before anything is appended. Import is append-only, not an OMP transcript converter.
- `/optchat new` starts a fresh, empty chat. It needs this session's memory open and the agent idle, and asks first when the UI can. The current store moves unchanged to a sibling archive `<dir>.<UTC stamp>` (for example `chat.20261013T081500Z`, with a numeric suffix if taken), and an empty store opens at the original path. Reopen the old chat with `--optchat-dir <archive>`. OMP's own `/new` keeps the same OptChat memory by design; use `/optchat new` to reset it.

### Subagents

OMP subagents are ordinary sessions. They never open the Store or write to the chat. Their task, async, and launch reports become `work` records in the parent's log, captured before the ordinary tool-result cap. A report the agent recovers with `wait` is captured the same way, as one `work` record per finished task job under its job ID, agent ID and name, so `work(name)` finds it; a job OMP already delivered by itself keeps its first record, and the other jobs a `wait` result lists (bash, still running) stay an ordinary tool result. Each record carries provenance (source, job ID, agent ID, name, completeness), full structured data, and the typed artifact output where the host supplies one. When OMP delivered only a preview and no trusted full-output reference, the record says so: it starts with `[incomplete: reason]` and has `completeness: "pointer-only"`. URIs found in report text are never followed.

The child view, on by default since 0.11.0, gives each subagent a frozen, read-only snapshot of the parent's view and `zoom`/`date`/`work`/`chat_search` over messages up to that point. A child's `chat_search` only sees messages that existed when the snapshot was taken. Every read and every prompt injection checks that the parent's publication is still live and that the child is still in the session that adopted it. The snapshot is revoked when the parent switches sessions or shuts down, and is refused if the child resumes, forks, or branches into another session. `--no-optchat-child-view` turns it off for a session (OMP boolean flags are presence flags, so `--optchat-child-view=false` does not); then include the facts a child needs in its task. A child that uses the snapshot pays for reading it: in the 0.5.0 child experiment below, children cost $0.20 with the view and $0.09 without.

## Storage and compression

```text
chat/
  main/YYYY-MM-DD.jsonl   # {i,kind,text,size,date}
  tree/YYYY-MM-DD.jsonl   # {l,i,text,size}
  view.json               # {version:2,length,parts,compacting,compactor:{length,parts,compacting}}
  ledger.jsonl            # standing rules, appended per event; absent with --no-optchat-rules
  images/                 # content-addressed image blobs referenced by message metadata
```

Messages may carry an optional strict `metadata` field with work provenance and ordered image references (digest, MIME type, byte count). Older five-field records are read unchanged.

Records are appended and fsynced before publication; replay also fsyncs recovered files before admitting them. Daily filenames use the local day of writing, while each record retains its original timestamp, including imported historical dates. IDs are permanent. Malformed/torn lines are reported; missing IDs or conflicting records are not silently renumbered. The tree can be rebuilt conceptually, but existing summaries are retained to avoid paying twice.

The main view is atomically replaced and fsynced before a new tiling is published. Its versioned envelope stores both the main and compactor tilings and their unfinished batch latches in a single transaction. Restarts load those exact tilings instead of reconstructing them, so the compactor's cache prefix survives a restart. A v0.3.0 snapshot is migrated once: its main tiling is kept exactly, and the compactor tiling is initialized from it. After a crash, durable messages beyond the saved view are appended to its existing prefix. A pre-0.2.0 chat without `view.json` is migrated once; malformed or inconsistent snapshots fail closed rather than silently rebuilding a different view.

The summary target is 512 UTF-8 bytes. The main view grows by appending leaves until its summary text exceeds 128,000 bytes, then merges a batch down to 64,000 bytes. Merge priority measures age from the sibling pair's **last** message, with oldest-first ties. Only built parents can be used; an unfinished batch remains active across subsequent node completions, messages, and restarts. The view never splits.

The compressor has its own 16,000–32,000-byte sawtooth view, coarsened from the main view and refreshed when the main view merges. It contains only built, addressed summary lines before the target message, or through the end of a target merge—never later messages. Compression instructions use a 512-dash ruler rather than example content. Sizes govern summary text, not token estimates or provider-envelope overhead.

Short records and child pairs that already fit are free nodes. Longer records are read in bounded UTF-8 pages. Each page is summarized, and the page summaries are reduced in bounded groups to one leaf. No source byte is skipped, and no permanent ID is added. Page summaries are not persisted; after a restart, an unfinished long leaf is recomputed.

Work sits in dependency-ready queues, as upstream specifies; the tree is never scanned for work. A message's leaf is admitted while fewer than eight earlier leaves are unbuilt, and a merge becomes ready as soon as both halves exist, in any order. At most eight calls run at once. Each summary gets five shortening attempts with bounded feedback, and the shortest whole reply is kept. If no attempt fits a 16 KB safety ceiling, the summary fails rather than being cut. A failed call releases its slot immediately and is retried on the next appended message; there are no idle retry timers.

**Refusals.** A compressor refusal is a provider reply with `stopReason: "error"` whose message starts with `Refusal` (how pi-ai reports Anthropic `stop_reason: refusal`). That compaction is retried once with the session's main model, under the same admission, cache, and token rules, and its metric line names the model that answered. The fallback has a 30-second wall deadline covering admission, auth, and the whole provider response; a fallback that exceeds it is cancelled and treated as a refusal. If the main model also refuses, or is the compressor itself, OptChat commits a deterministic excerpt of the node's source, prefixed `[unsummarized: compressor refused]`, within the node's byte budget. A stand-in is navigation, not a model summary: `zoom` returns the originals, and the tree keeps progressing so later prompts are not refused. Other provider errors (transport, HTTP, rate limit, aborts, length) keep the retry-on-next-message behavior. Each fallback is reported once, and `/optchat status` counts main-model retries and stand-ins.

A model turn waits for summaries rather than seeing partial source text. Compression failures are reported. Cancel a wait if the provider is unavailable; history already accepted by the plugin is retained. Reasoning/thinking is not written to the OptChat log. Ordinary tool-result text is head-and-tail capped at 30,000 characters; full `zoom` retrieval is exempt so original messages remain accessible.

## System One gates (Jev)

Four gates send text to the host's `judge` model role. All four are on by default. Turn one off for a session with its opt-out flag (`--no-optchat-rules`, `--no-optchat-prefetch`, `--no-optchat-value-score`, `--no-optchat-recall`); an opt-out takes precedence over the gate's own flag, which is kept for explicit launches. OMP boolean flags are presence flags, so `--optchat-rules=false` does not turn a gate off. With all four opted out, OptChat resolves no judge, registers no `chat_recall` tool, and sends no gate messages: its context and `/optchat status` are the memory-only ones (0.5.0's, plus `chat_search` and `zoom` depth since 0.7.0). Subagents never run the gates.

The tool gate, which screened tool calls before they ran, was removed in 0.8.0. Risky-call confirmation is OMP's own tool approval (`tools.approval` in OMP's settings).

### Choosing the judge

The gates use whatever model OMP's `judge` role resolves to. Set it under `modelRoles` in OMP's `config.yml` (not `models.yml`), or assign it in `/models`:

```yaml
modelRoles:
  judge: openrouter/~typesafe/jev-latest
```

Jev (TypeSafe's typed decision model, directly or through OpenRouter) answers natively. The role also accepts tiny and ordinary chat models, which answer through OMP's prompted judge. Credentials stay in OMP's credential store; the plugin has no API-key variable or provider client of its own. If no candidate is credentialed, the gates simply do not run and `/optchat status` says so.

When the `judge` role has no candidate at all but the session has a model, OMP answers with the session model. OptChat then runs no gate on that model: rules, prefetch, value-score and recall are inactive, and `/optchat status` says why. `chat_recall` stays registered, so tool definitions do not change; it answers that it is inactive. No judged text is sent to the session model's provider.

### Turning gates off

```sh
omp --no-optchat-prefetch --no-optchat-value-score
omp --no-optchat-recall                          # no chat_recall tool; chat_search and zoom stay
omp --no-optchat-rules --no-optchat-prefetch --no-optchat-value-score --no-optchat-recall   # memory only
omp --no-optchat                                 # plain OMP: no memory, no gates
```

### What you will see

`/optchat status` gains a gate section while any gate is on:

```text
System One gates: rules on, prefetch on, value-score on, recall on
judge: openrouter/~typesafe/jev-latest
standing rules: 1 active
last System One failure: none
rules counts: 3 judge calls, 0 failures, 1 added, 0 replaced
prefetch counts: 3 judge calls, 0 failures, 2 blocks, 1480 bytes
value-score counts: 0 judge calls, 0 failures, 0 hints
recall counts: 0 judge calls, 0 failures, 0 answered, 0 none, 0 failed
```

The judge-call counters count judgments, including answers served from the shared judgment cache, so OMP's billed `model_usage` rows can be fewer.

On the session-model fallback, the gate section reads instead:

```text
judge: openrouter/anthropic/claude-sonnet (session model fallback: the judge role has no native candidate; no gate runs)
rules inactive: no native judge model (judge role resolves to session model)
prefetch inactive: no native judge model (judge role resolves to session model)
value-score inactive: no native judge model (judge role resolves to session model)
recall inactive: no native judge model (judge role resolves to session model)
```

The counts above are an illustrative sample, not a measurement. They are in memory for this session only. Judge calls count every judgment a gate makes; failures count the failures recorded in the last-failure line. Outcomes: rules `added` and `replaced`; prefetch `blocks` built and their `bytes`; value-score `hints` added to a compaction instruction; recall `answered`, `none` and `failed`. A block is counted for each request that carries one. The counts never enter the system prompt, the view or a provider request. With every gate off, status has no gate lines.

Active standing rules follow the view as their own message, with the id, the source message id and the user's words, for example:

```text
<rules>
r1 [42] From now on, always answer in British English spelling.
</rules>
```

A prefetch block, when the judge finds relevant lines, follows as `<prefetch>` with the opened lines and a header marking them as data, not instructions. A screened tool call above the danger threshold opens a confirm dialog in an interactive session; in print or JSON mode it is blocked and the model is told why, for example "danger 0.96, no UI to confirm".

A `chat_recall` call returns the scanned view line that covers the message it chose (if any) and then the message itself, for example:

```text
[optchat recall] why did the staging deploy fail?
64+32|user: deploy to staging; echo: deploy failed … (p=0.91)
97+1|echo: Error: DATABASE_URL is not set … (p=0.97)
message 97:
Error: DATABASE_URL is not set in environment "staging" …
[end of 1840 bytes]
```

### Gates and thresholds

| Flag | Gate | What it does | Judged per |
| --- | --- | --- | --- |
| `--optchat-rules` | Standing rules | Judges each user message for a standing instruction, then adds it to `ledger.jsonl` or replaces the active rule it overrides. Active rules appear in a `<rules>` block after the view. | user message |
| `--optchat-prefetch` | Prefetch | Judges merged view lines against the new user message and zooms the relevant ones into a `<prefetch>` block. Bounded to 5 s, and to the settle deadline's remaining time. | user message |
| `--optchat-value-score` | Value hint | Judges each long leaf's label and importance, and adds one fixed sentence to its compaction instruction. The sentence never contains record text or ids. | compacted leaf |
| `--optchat-recall` | Recall | Registers the `chat_recall(question)` tool. Candidates are the view lines plus up to `--optchat-recall-seeds` (default `8`, integer 0–32) raw-log matches: the word search's widest pool re-ranked locally with BM25-style length normalization (no model call), so a short message that states the answer beats a long dump, and the top seeds become single-message lines. All candidates are scored against the question in the same relevance requests, and if no line reaches `--optchat-recall-min` the call says so. Otherwise the top `max(--optchat-recall-k, 4)` multi-message lines at or above `--optchat-recall-min` are scanned: every built message under them is scored in one more round, at most 256 messages (a line that would pass the cap is skipped whole). The messages that reached `--optchat-recall-min` or lie under a scanned line compete: those within 0.1 of the best score (at most 8) are shown side by side in one choice question, and the likeliest is returned with its path (the scanned line covering it, then the message) and first 8 KB. With `--optchat-recall-k` above 1 it also lists the next messages by rank and any scanned line that failed. About ⌈(lines+seeds)/64⌉ scoring requests, plus 1–4 scan requests, plus at most 1 pick; bounded to 20 s overall and 5 s per call. A failed pick keeps the score ranking; a failure or timeout returns an explicit "recall failed" result, never a guessed answer. | tool call |

Thresholds: `--optchat-rule-add` (default `0.8`), `--optchat-prefetch-k` (default `8`, integer 1–32), `--optchat-prefetch-min` (default `0.5`), `--optchat-recall-min` (default `0.5`), `--optchat-recall-k` (default `1`, integer 1–8; widens the recall scan beyond the top 4 lines and, above 1, lists the losing candidates), `--optchat-recall-seeds` (default `8`, integer 0–32). Probabilities are plain decimals in (0, 1]. A malformed value fails the session's configuration closed.

Behavior:

- **Judge.** The judge is the host's `judge` role, resolved per call. If the role has no credentialed candidate, or resolving it throws, that gate does not run. `/optchat status` says so. OptChat keeps working. With no role candidate and a session model, the session model is the fallback judge, and every gate is inactive on it (see above).
- **Failures.** A judge failure, a timeout, or a missing judge changes no rule and adds no prefetch block. `/optchat status` shows the last failure, cut to 200 characters.
- **Privacy.** An enabled gate sends the text it judges to the judge role's provider: user messages, view lines, tool names and inputs, and record text for the value hint. On the session-model fallback no gate runs, so nothing is sent. With every gate opted out, nothing is sent.
- **Cost.** With the defaults, each user message costs one rules request, plus, on a turn whose view merged, one prefetch request per packed chunk of view lines (at most 64 lines or 24,000 bytes each; the live run saw 3 per such turn), and each long compacted leaf costs one. A `chat_recall` call costs one scoring request per 64 candidate lines (view lines and `--optchat-recall-seeds` raw-log matches) plus 1–4 scan requests for the messages under the top lines and at most one choice question among the near-tied messages, and only when the model calls it.
- **Compressor cost record.** Each completed compressor call appends one line to `metrics.jsonl` in the store directory (append-only, mode 0600, best effort: a failed write is reported as a warning and never stops the chat). A line has `type: "compressor"` and holds the completion time (`at`, ISO-8601 UTC), the model, input, output, cache-read and cache-write token counts as the host reports them, `node` (`leaf` for a message or one page of a long one, `merge` for two lines), the 1-based `attempt` within one compaction and the `retry` cause of that attempt (`null` on the first; otherwise `head`, `length`, `marker` or `user`), `waitMs` (time spent in admission and waiting for the cache lease before the request was sent), `latencyMs` (provider time only, without `waitMs`), the host's reported cost in USD (`null` when the host reports none), the stop reason and a bounded error text, never message content. The same file also holds two other row types, counts only: `host-compaction` (`at`, `outcome` `marker`, `cut-moved` or `cancelled`, a closed `reason` when cancelled, and `tokensBefore`) for each host compaction OptChat answered, and `rules` (`at`, the judge's P(rule) for the message and the highest per-sentence P(rule), the sentence count, the `--optchat-rule-add` cutoff and whether a rule was written) for each triage, which never stores the message or a rule's text. Only compressor rows count as calls; a line without a `type`, written before rows were typed, is a compressor row. `/optchat status` shows the store's calls and the sum of the reported costs; a call without a reported cost is counted and shown as unknown, never as $0. `/optchat new` archives the file with the old chat. The evidence runner sets `OPTCHAT_METRICS_FILE` to a per-host path outside the store copy, because it must count only that host's calls; the variable redirects the sink and is not needed otherwise.
- **Measured compressor cost (one cold, parallel build; not typical).** On 2026-10-17, OMP 18.11.3 with `@smol` = `anthropic/claude-sonnet-5-5` ran a fresh store over 64 consecutive real messages (61,601 text bytes, `--optchat-view-bytes 8192`, default 8 jobs). The 8 leaf calls started at once on a cold cache, so none could read another's cache; the run was stopped after 7 returned. Those n=7 leaf calls each had 4 input tokens, 0 cache-read tokens, 66,022 to 68,491 cache-write tokens, 158 to 218 output tokens, and a host-reported cost of $0.1666 to $0.1733 ($1.1799 in all). Each compressor call carries the host's system prompt as its shared prefix (176,452 bytes in a host started with the same flags); how much of the cache write that prefix accounts for was not separated. No merge call ran, and no call read the cache, so the warm cost of a leaf or a merge, and any cost per stored message, are unmeasured here. `metrics.jsonl` and `/optchat status` now record them in live use.
- **Rules.** A rule's text is the user's own words. When a message has several sentences, the judge rates each one, and the rule keeps only the sentences that reach `--optchat-rule-add`, so "From now on, answer in British English. Also run the tests." stores only the first sentence. Rule IDs (`r1`, `r2`, …) are never reused. `/optchat rules` lists active rules, and `/optchat rules remove ID` removes one. A triage that is still running at shutdown is abandoned and writes nothing.
- **Where standing instructions live.** Each store holds different things by scope. The rules ledger (`ledger.jsonl`, per store and so per worktree by default) holds instructions you state in this chat. OMP TTSR rule files hold enforced guardrails that apply to every session. Sharpshooter holds cross-session project decisions learned from friction. An item in one is not copied into the others.
- **Shutdown.** A print or JSON run exits right after its reply. On `session_shutdown`, OptChat waits up to 1.5 s for queued rule triage, then abandons whatever is still running. The bound stays under the host's 2 s session-shutdown cap, so the wait is shorter than the 5 s the design allowed.
- **Frozen per turn.** The rules and prefetch blocks are decided when a turn starts, and every request in that turn carries the same blocks, including tool loops. A rule stated mid-turn applies from the next turn.

Verified in this repository: the unit and integration tests in `tests/system1.test.ts`, `tests/system1-e2e.test.ts` and `tests/memory.test.ts`; a cache test (`tests/cache.test.ts`) showing that the system prompt, tools and view text in an encoded Anthropic request are unchanged when the rules and prefetch messages follow the view; a one-off comparison in which a 12-turn conversation produced byte-identical context and status with every gate opted out, against 0.5.0; and live print-mode runs with the real judge on OMP 18.9.1, where the tool gate (removed in 0.8.0) blocked `rm -rf build` with no UI and a two-sentence message stored only its rule sentence. Not verified: the judge's accuracy beyond those runs, prefetch on a live merged view, and the confirm dialog in an interactive session.

## OMP-specific boundaries

- OMP caps extension context handlers at 30 seconds. OptChat therefore cancels a turn if memory has not settled within 25 seconds, before the host could ignore a timed-out hook. The unanswered user message stays in the log, and compression continues; send the request again after memory is ready. It never substitutes raw old history or half a summary.
- The extension preserves OMP's system instructions, tool policy, display, and in-turn reasoning rather than replacing the harness. It does not change your delegation policy or create its own subagent system.
- Activation does not change host settings or replace the Sharpshooter memory backend. When OMP compacts the chat (automatically, with `/compact`, or by the experimental rollover), OptChat answers with one fixed marker summary and makes no model call. The host then keeps only recent messages, while the full history stays in OptChat's log and tree, and the model reads it through the OptChat view. A compaction never cuts the open turn: the cut moves to the turn's first message, or OptChat cancels the compaction when nothing older can go. OMP shows the marker in place of the older transcript, as it does for any compaction. Automatic shake pruning still bypasses the hook. Activation changes none of OMP's maintenance settings. Because a marker compaction costs no model call, set `compaction.thresholdTokens` to about 200,000–300,000 in OMP's config: OMP's own side requests (skill capture, away recaps) send the raw session history, and with the default threshold on a 1M-token model they failed 12 times with "prompt is too long" in sessions before 0.12.0.
- Images that reach OMP as `ImageContent` (user, assistant, tool-result, and report messages) are validated as PNG, JPEG, or WebP and stored by digest. Audio, video, and original files are not archived, because OMP 18.9.0 exposes no ingress for them. Unreferenced image blobs and abandoned image/view staging files are garbage-collected after successful writer replay and snapshot validation; referenced blobs remain verified on read, and cleanup failures warn without blocking the store.
- OMP side turns, such as idle recaps and `/btw`, pass through untouched. They are recognized as host-authored, agent-attributed messages that are absent from the session branch, and they never open, reuse, or poison a main turn. OMP 18.9.0 has no typed request purpose, so another future host-authored side-turn shape could need a matching update.
- Permanent storage uses fsync, not automatic Git commits. Backups remain the operator's responsibility.

### Provider caching

For native official Anthropic requests to image-capable models, the view is split into blocks of **four summary lines**, with a cache mark on the last whole block and another at the request end. Other routes, including text-only Anthropic-compatible models whose encoder joins text blocks with newlines, keep the original fixed-offset blocks, so the view's wire bytes never change. Existing markers are bounded to four total, using five-minute entries. Concurrent compressor requests sharing a marked prefix, or the same anchored tools and system head, wait for its writer's response to start; failed or canceled writers release their waiters. Main requests never wait on a head alone. Before 0.10.3, concurrent cold compressor calls each wrote the whole system prefix and none read it, because each call's last mark is its own task line; in a live check after the change (n = 3, no same-session control), the first call wrote 65,171 tokens and the next two each read 61,980 at about a tenth of its cost ($0.1646, $0.0163, $0.0158). Coordination follows Anthropic's 20-block prefix lookup window and is limited to this enabled session. It does not send renewal requests.

Official OpenAI Responses models with the host's explicit-breakpoint capability retain their supported view markers; supported official Codex requests retain reasoning across turns of an active tool loop using `all_turns`. The new writer coordination is Anthropic-only.

Gateways and unsupported transports (including OpenRouter, Azure, Bedrock, Vertex, Foundry, custom endpoints, and pi-native) keep the host's existing cache behavior. Wire-level marker and coordination checks are not proof of real-provider cache hits, account sharing, or savings.

Turns and compactions share the effective host system prompt plus one stable OptChat guide. After a compatible host request exposes an encoded prefix, compactions can reuse its system prefix and passive callable-tool schemas; they never execute tools and reject tool-call responses. Reuse requires the encoded system content to match the compressor's own effective prompt, so side requests cannot replace its guide. Tool schemas also require matching request dialect, tool support, freeform `apply_patch` grammar, and computer-use capability; models that disable reasoning when tools are present stay tool-free. Before the first compatible request, compression is tool-free. This avoids exposing tools hidden by the host: OMP's public tool inventory is not the final model-visible catalog. Hosted-native tool schemas are not replayed, and a model requiring native tool execution cannot be selected as the compressor.

OMP's public provider hooks carry no request identity: side requests share them, and provider retries or advisors can report a response without a matching request event. The plugin therefore tracks only compressor requests as in-flight cache writers; main requests can wait for those writers, but are not tracked themselves. Main requests still use the provider's normal cache. Compressor callbacks are directly correlated, and an abandoned tracked writer has a 20-second fail-open bound. Other extensions that change payloads after this plugin's hook are outside its prefix-sharing guarantee.

**Use `PI_OPENAI_STATEFUL=0` as shown above for the specification's stateless `store:false` OpenAI requests.** OMP otherwise defaults to stateful official OpenAI Responses. A plugin cannot change the host's main-request options; deleting a response ID or changing retention mid-chain would lose context. With stateful mode left enabled, fresh turns still replace the prefix, but in-turn continuation requests keep the host's chain and receive no extra view markers. The compressor is already stateless. An explicit host caching-off setting is respected where exposed (`PI_CACHE_RETENTION=none` for OpenAI).

## Privacy and operation

**This is permanent local history, not a secret scrubber.** User text, public assistant replies, tool arguments, and tool-result text may contain secrets. The compressor receives historical content through your configured provider. Do not use it for material you cannot retain or send there. OMP may independently persist its own sessions and diagnostics; `--no-session` controls OMP session files, not the OptChat log.

Keep the memory directory private and back it up. The extension never commits or publishes it. HTML exports contain the original log. No telemetry or external storage service is added. Stop the enabled session before restoring backups or copying a consistent set of log, tree, and view files.

On Linux, the single-writer lock uses an OS-owned abstract Unix socket keyed by the directory's filesystem identity; filesystem operations stay anchored to held directory descriptors through `/proc/self/fd`, even if a path is renamed. A second writer in the same network namespace fails; containers in different network namespaces must not share a writable chat. Linux procfs is required. On macOS, the single-writer lock uses an exclusive non-blocking `flock` on the held root directory descriptor; filesystem operations resolve held descriptor paths via `F_GETPATH`. Both locks avoid PID-age guesses and stale-file unlink races, and process death releases the lock. A local fsync-capable POSIX filesystem is required.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:host
bun run smoke
```

`bun run test` covers the unit and fake-host suites. `bun run test:host` covers `tests/host/`: real OMP host launches (the real-host integration suite and the paired evidence run). CI runs this sequence with the pinned SDK cohort and with the latest published cohort, on every push and pull request, weekly, and on demand.

`bun run verify:lease` checks the store writer lease, about 12 seconds: a TLA+ model under TLC (needs Java 21, found through `$JAVA`, `mise` or PATH; it fetches the pinned `tla2tools.jar` when missing) and real-process tests against `src/store.ts`. CI runs it as two jobs: `verify-lease` on Linux runs everything (`bun run verify:lease --strict`, the model and the real-process phase), and `verify-lease-macos` runs the real-process phase only (`--real-only --strict`) plus the store suites (`tests/store.test.ts`, `tests/store-directory.test.ts`, `tests/crash.test.ts`, `tests/new-chat.test.ts`), because macOS takes the `flock` path of `acquireLease` and `F_GETPATH` descriptor paths that Linux never runs. The model is platform-independent, so it stays on Linux. On macOS the harness lists descriptors through `/dev/fd` and the store's own `fdPath`, and the breaks of the lease itself (`lease-name-per-process`, `failed-open-keeps-lease`, `gc-before-lease`, `close-keeps-lease`) are written against the flock code, under the same ids and probes. Run it after changing the lease, `Store.open`/`close`, `/optchat new`, or how the rules ledger and metrics are written; `.omp/skills/verify-store-lease/SKILL.md` says how to read it. `--deep` adds the five guarantees with three sessions (about 4.1 million states each, about 6 minutes and up to 24 GB of RAM in total, so neither the default run nor CI includes it). It reports no open findings: F1 (`/optchat new` renaming a store another session had open) and F2 (the rules ledger and `metrics.jsonl` written by pathname) are fixed (CHANGELOG, 0.13.1) and now checked as guarantees; `--strict` exits 0.

`bun run evidence:recall` is an opt-in recall and usage experiment against real models with a synthetic corpus. Without `--confirm-live-provider-calls` it checks prerequisites and prints its plan. It runs the host with private HOME and agent directories that hold only the selected credentials, so no global context files reach a provider. Call count, compressor output, and wall time are capped. The artifact separates main, compressor, and auxiliary usage and records unobserved fields as `null`, never zero. Auxiliary usage is the session's `model_usage` entries for side phases: exact SDK costs, or unobserved. Maintenance (native compaction) has its own summary: a compaction count and an estimated low/high cost interval, priced from the captured compaction frames (tokens before compaction at the cache-read and input rates, and the summary's UTF-8 bytes divided by four at the output rate). A frame that cannot be priced leaves the interval null, and zero compactions is an exact zero. A frame whose summary is OptChat's fixed marker made no model call, so it counts as a compaction and costs exactly zero. A run's total cost sums the exact main, compressor, and auxiliary costs with the maintenance interval; it is null, with a reason, when any part is unobserved. Cache-read share is reported for each role and over all roles; the all-role share is null whenever maintenance is estimated or unobserved. The per-question steady-state main share sums cache reads and prompt tokens over each phase's turns after the first, and is null in batch mode. A paired delta is the off-minus-on interval difference (off low minus on high, and off high minus on low) plus the steady-state difference, present only when both arms are observed. It never reports savings it did not measure. `OPTCHAT_METRICS_FILE=/path` appends one content-free JSON line per compressor call.

`bun run evidence:retrieval` is an offline, deterministic comparison of the retrieval strategies (zoom one level at a time, zoom with depth, `chat_search`, prefetch, `chat_recall`, and a scripted beam descent) on the same probes. It builds a real memory in a temporary directory over a synthetic 256-message chat with 12 planted facts, a rule-based summariser that drops values and, with depth, topics, and a fake judge that scores word overlap. It reports per strategy the probes found, agent steps, judge calls, zoom calls and bytes returned, plus a per-fact table by age; `--seed` and `--out` select the seed and write a JSON artifact. It makes no provider calls and measures navigation mechanics only, not real summaries or Jev. The 0.7.0 results are in `.scratch/optchat-jev/issues/10-codemode-retrieval.md`: every summary-navigating strategy found only the facts whose topic survived in the view (3/12 and 5/12 over two seeds), `chat_search` found 12/12, and `chat_recall` reached the surviving facts in one agent step instead of about 200 zoom calls.

`--arms on,off` pairs the OptChat arm with a plain-OMP arm over the same corpus and questions. The off arm resumes a seeded session with OptChat disabled: it is offered no memory tools, its prompt never mentions them, and native compaction may run inside that session. Off-arm maintenance is estimated the same way as on-arm maintenance, from its captured compaction frames. A paired delta is computed only when both arms completed every requested scenario and both totals are observed, and the artifact claims no savings.

`--compressors a/b,c/d` runs one on-arm unit per compressor, and the paired comparison is reported per compressor. `--turn-mode per-question` sends one question per prompt and records each turn's latency and usage; the default `batch` sends all questions in one prompt. `--experiments child` runs the child-memory experiment: the parent delegates each question to a `task` child, once with the saved view and once blind. Grading uses only the child's delegated output.

Spend has two ceilings. `--max-cost-usd` (above 0, at most 30) is a worst-case dollar ceiling: every prompt and compressor call is admitted against its model's worst-case bound before it is dispatched, and a model with unknown rates or context window blocks rather than passes. `--max-calls` (default 80, at most 2000) caps total provider calls; when it or the deadline is reached, remaining work is refused and reported as a refusal, not silently dropped. Without `--max-cost-usd`, only the call and deadline limits apply.

The dollar bound prices input by UTF-8 bytes, not tokens: a prompt's tokens never exceed its bytes, so no tokenizer is assumed. A main prompt's bytes are the measured effective system prompt, the OptChat block, a 32 KiB tool-schema allowance, the view (on arm) or the seeded history (off arm) plus prior turns, four 16 KiB zoom pages, and the question. Tokens are clamped to the context window and priced at the dearest input-side rate. Output is priced at the pinned cap `--max-main-output` (default 4096, at most 32000): the runner writes that cap as `maxTokens` for each main model into the isolated agent directory's `models.yml`, never the source's. The bound is multiplied by the prompt's four worst-case calls, not by the number of prompts. Each on-arm compressor host reserves `--compressor-share` (default 0.5) of the uncommitted cap as its allowance, and a main prompt is admitted only if observed spend, live host allowances, and its bound together stay within the cap. When a host stops, its allowance is replaced by its observed compressor spend. An off-arm prompt also adds a native-compaction bound over the seeded history, prior turns, and the question, at the pinned cap. Compressor calls are bounded by the compactor's prompt bytes and the compressor output cap. An unknown rate, context window, or unmeasured system prompt refuses. The run prints the per-prompt main bound, the compressor per-call bound, and the host allowance in its plan. After each prompt, observed spend is charged once: exact auxiliary costs and maintenance's high bound, so bounds that were never observed are not charged. `limits.spentUsd` is that running high-bound total. A dispatched child task with no observable child cost leaves spend unobserved and blocks further live work; refused, incomplete, and not-delegated children add no child cost.

`--main-context-window` accepts an integer from 32000 up to the main model's catalog context window (the runner rejects larger values) and overrides only the main model's `contextWindow` in the isolated agent directory's `models.yml`, leaving source configuration and other models unchanged. When omitted, the requested override is `null` and the main model inherits its catalog context window. The artifact records the requested override in `models.mainContextWindow` and the effective main-model context window used by the run alongside it.

Limits of this bound: the four-call prompt limit is not an enforced tool-loop cap, and the output cap is trusted from the pinned `models.yml` entry (verified for built-in catalog models through `omp models --json`; the offline fixture provider ignores it). On-arm compaction of the main session is observed but not bounded in advance; OptChat's marker compactions make no model call.

The runner waits for memory to settle before each prompt for as long as compressor calls, dispatches, or tree growth keep progressing, within the run deadline (`--deadline-ms`, at most 30 minutes). It reports a stall after 120 s without progress. A completed compressor call holds its observed cost against the host's dollar allowance; only calls still in flight hold their worst case. Admissions refused by either ceiling are counted and reported, because a refused admission fails that summary and OptChat then refuses the next turn.

`--fixture-provider` swaps in the loopback `optchat-smoke/*` models, which are priced at zero. The whole pipeline, including both arms, the compressors, and the child experiment, then runs without provider calls or credentials. It is for testing the runner, requires `optchat-smoke/*` selectors, and is mutually exclusive with `--confirm-live-provider-calls`. `tests/evidence-benchmark.test.ts` drives it end to end and skips when no `omp` executable is found (set `OPTCHAT_EVIDENCE_OMP` to choose one).

Before copying credentials or starting host discovery, the runner parses the source agent directory's `models.yml`, `models.yaml`, and legacy `models.json` (JSONC). Any selected provider entry blocks the run: copying its credential without its routing could send it to a different endpoint. Read failures, parse errors, and invalid root or provider-map shapes also block, without exposing config contents in diagnostics. This check deliberately includes shadowed files rather than following OMP's first-file precedence; unrelated provider entries are allowed. Source configuration is never migrated, evaluated, or copied.

The smoke harness links the plugin into an isolated fresh host environment, then exercises automatic discovery and activation without `--optchat` or an explicit plugin extension path. It uses the actual OMP host with a local deterministic model endpoint, captures inference requests, and checks fresh turns, shared main/compactor prompt and tools, the dash ruler, lossless retrieval, saved-view stability, and restart persistence. Separate opt-out processes prove ordinary history remains intact, no memory store or tools are created, and no compressor requests occur, including both positive/negative flag orders. Set `OPTCHAT_SMOKE_OMP` to a compiled OMP executable and `OPTCHAT_SMOKE_PLUGIN` to an installed plugin directory to verify that artifact rather than the checkout. It is not a measurement of summary quality or real-provider cache hit rates.

The 0.4.0 release was exercised on compiled OMP 18.9.0. Beyond the checks above, the smoke drives a `/btw` side turn followed by an ordinary prompt, a 54 KB structured async report, two images retrieved after a restart, `work` retrieval after a restart, and a real `task` child that reads the parent view without writing. A deterministic restart probe confirmed that reopening a fully built 200-message chat makes no compressor calls and leaves all 397 nodes unchanged, and that one new message costs one call.

### 0.5.0 measurements

Paired runs on OMP 18.9.1 used Claude Sonnet 5.5 as the main model and Claude Haiku 5.5 as the compressor, with per-question turns and adversarial questions: multi-step and reverted corrections, late distractors, near-duplicate names, and an unanswerable fact. Each run asked 8 questions. "On" is OptChat; "off" is plain OMP resuming a session that holds the same records as ordinary messages. Costs are provider-reported; compressor cost includes building the memory. These are small samples (n = 3 per setting), not savings claims.

**History that fits the context window** (48 records of 4 KB, about 74k tokens, 64 KB view; seeds 1–3):

| Arm | Correct | Grounded | Main cost | Compressor cost | Main prompt tokens | Main cache-read share |
|---|---|---|---|---|---|---|
| On | 24/24 | 24/24 | $0.41–0.43 | $0.04–0.09 | ~218k | 56–57% |
| Off | 24/24 | 24/24 | $0.32 | — | ~539k | 88% |

When everything fits, OptChat costs more: about $0.13–0.20 per run. The main model reads 60% fewer prompt tokens, but each turn's fresh view is written to the cache instead of read from it, and zooming adds a round trip per question.

**History past the context window** (160 records of 4 KB, about 650 KB; main model pinned to a 200k window with `--main-context-window`; 128 KB view; plain OMP compacted once in every off run):

| Seed | On: correct / grounded | On: total cost | Off: correct value / grounded | Off: total cost |
|---|---|---|---|---|
| 1 | 8/8, 8/8 | $1.13 | 1/8, 1/8 (7 abstained) | $0.05–0.55 |
| 2 | 8/8, 8/8 | $1.10 | 7/8, 7/8 | $0.06–0.56 |
| 3 | 8/8, 8/8 | $1.18 | 8/8, 2/8 | $0.05–0.55 |

Seed 3's on arm comes from a separate on-only run (`long-s3-on`), after the runner's settle wait was fixed; its paired run stopped while the build was still progressing. Off-arm cost is an interval because OMP 18.9.1 reported `tokensBefore: 0` for its compactions: the high bound bills the whole 200k window at the input rate. After compaction, plain OMP sometimes still names the right value but can no longer quote the original record. In one of three seeds it abstained on most questions. OptChat answered every question correctly with an exact quote, at roughly twice the cost of the worst off-arm case.

**Compressors** (48-record build, seed 4): Haiku 5.5 needed 103 calls (17 shortening retries), $0.034, and 211 s of summed call time, and the run then answered 8/8. Haiku 4.5 needed 303 calls (230 shortening retries, because it overshoots the byte limit), $0.76, and 961 s, and had not settled when the run stopped.

**Subagent memory** (`--experiments child`, 24 records, 4 delegated tasks per arm): with `--optchat-child-view`, children answered 4/4 correctly after 2–4 `zoom` calls each (child cost $0.20 in total); without it, children answered 0/4, saying the facts were not available to them (child cost $0.09).

**Refusals:** Claude 5.x models sometimes reject benign summarization requests with `Refusal (bio)`. An early corpus padded with word lists (words such as replica, vector, probe, drift) triggered it on most long prompts; natural prose padding reduced it to about 1 in 100 compressor calls. The refusal fallback above keeps memory settling when it happens.

### 0.4.0 measurements

A bounded `evidence:recall` run used real models: Claude Sonnet 4.6 for the main chat, Claude Haiku 4.5 as the compressor, and a synthetic 24-source corpus. It ran a cold phase and a fresh-process restart phase; the deepest summary level was 5 in the cold phase and 6 after restart. Results:

| Phase | Correct | Grounded in a zoomed original | Hallucinated | Main cache-read share | Compressor cache-read share | Cost (USD) |
|---|---|---|---|---|---|---|
| Cold | 8/8 | 8/8 | 0 | 76% | 46% | 0.30 |
| Restart | 7/8 | 8/8 | 0 | 86% | 53% | 0.46 |

The one miss named only part of an ambiguous answer. "Cache-read share" is cache-read tokens divided by all prompt tokens, as the provider reported them. This short run starts cold and writes most prefixes for the first time, so it is far from the specification's steady-state 96–98% model. It is a sample, not a savings measurement.

The 0.2.0 release was exercised with compiled OMP 18.8.9 against the synthetic provider. A separate real-filesystem run ingested 300 synthetic messages, observed the 128,000-to-64,000-byte main batch and 32,000-to-16,000-byte compactor cycle, and checked byte-identical saved views on restart plus migration from a log without a snapshot.

The initial release was also exercised with the compiled OMP 18.6.1 binary and an authenticated `@smol` model: a long synthetic note was compressed to 185 bytes and its canary name/color were recalled correctly in a new process. Fresh-process discovery after `omp plugin link .` was verified without an explicit extension path. The HTML export was checked in Chromium at desktop and 375-pixel mobile widths, including navigation and escaped script text. These checks do not establish real-provider cache hit rates.

## Planning and specs

The System One plan lives in the repository. Start with `AGENTS.md` for how to work here and the verification commands. The living ExecPlan is `plans/optchat-jev.md`, with progress, decisions and open items. The design is `docs/design/optchat-jev.md`. Project skills (Wayfinder, ExecPlan, grilling and others) load from `.omp/skills/`.

## Attribution

Design and compression prompt: Victor Taelin, [UniiChat / OptChat — how to replicate my setup](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), revised October 8 and retrieved October 11, 2026. This project is an independent OMP adaptation, not an official upstream release.
