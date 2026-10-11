# OMP OptChat

An OMP extension implementing [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one durable chat, a binary tree of contextual summaries, and a fresh model context for each user turn. Original text remains retrievable with `zoom`; summaries are navigation, not a replacement for the log.

## At a glance

- **One chat that never ends.** Every user message, reply, tool call, tool result and subagent report is appended to a local, fsynced log under OMP's agent directory, one store per git worktree. Nothing is ever deleted or rewritten.
- **A view instead of a transcript.** Each turn the model sees a fixed-size view of the whole history: one-line summaries, oldest first, where older lines cover more messages. The view replaces the old inference history between turns, so a long chat stops growing the context.
- **Nothing is lost.** The model navigates the view with memory tools: `zoom` opens a line into its halves (or several levels at once) down to the original message, `chat_search` finds exact words in the original messages, `date` and `work` fetch timestamps and captured subagent reports.
- **System One gates, on by default.** Five small judgments through OMP's `judge` role keep standing rules across turns, prefetch relevant history before a turn, hint the compressor about what matters, screen risky tool calls, and power `chat_recall`, which walks the summary tree to the message that answers a question. Each has its own opt-out flag.
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

Each `id+n|text` line summarizes the `n` messages starting at `id`. To check the exact error from message 97, the model calls `zoom(96, 2)`, then `zoom(97, 1)` for the original text; if no line mentions it any more, `chat_search("DATABASE_URL")` finds it by its words, and `chat_recall("why did the staging deploy fail?")` lets the judge pick the branch at each level instead.

What it costs: a compressor call per stored message and per merge, plus up to two judge calls per user message and one per screened tool call with the default gates. When the history still fits the model's context, OptChat costs more than plain OMP for the same answers; its value is recall past the context window (see "0.5.0 measurements").

## Requirements and start

- OMP **18.9.0 or newer**, Bun, and Linux. CI checks every push and runs a weekly check against the latest published OMP SDK.
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

Memory is per git worktree. A session inside a git checkout defaults to a directory under `optchat-worktrees/` beside the global store in OMP's agent directory, named from the worktree's basename and a hash of its real path. Each worktree therefore has its own memory, and a new worktree starts empty. Subdirectories and symlinks to the same root share their worktree's memory. Outside git, the default is the global `optchat/` store. To keep one memory across worktrees, pass the same `--optchat-dir` to each, at the cost of only one active session at a time. Stores of deleted worktrees remain under `optchat-worktrees/` until you remove them manually. Working-directory changes within a worktree and OMP session restarts do not start a new memory. The extension does not import existing OMP sessions automatically.

Each memory directory has exactly one writer. If another live session already holds the directory (for example, the same `--optchat-dir` in another terminal), this session becomes inactive instead of refusing prompts: it shows one warning and runs as if started with `--no-optchat`, with no memory tools, logging, compression, or context changes. `/optchat status` reports the reason and directory. A store that cannot be opened for another reason, such as corruption, still refuses every prompt until restart. Subagents never open the store and do not conflict.

Advanced overrides are `--optchat-node-bytes`, `--optchat-view-bytes`, `--optchat-jobs`, `--optchat-tries`, and `--optchat-tool-cap`; their defaults are described below. `--optchat-retry-ms` was removed in 0.4.0, because failed summaries now retry on the next message. Keep the defaults unless you have measured a reason to change them. An enabled session refuses inference if `zoom`, `date`, `work` or `chat_search` is unavailable, including host modes that prohibit late tool registration.

## Using memory

The model receives the settled historical summary view before your new message, then retains its ordinary tool loop until the turn ends. Between turns, old inference history is replaced by the view. OMP's display transcript and normal tools remain available.

- `zoom(id, n)` opens an aligned power-of-two summary range into its children. `zoom(id, n, depth)` opens `depth` levels at once (1 to 4, at most `log2(n)`): the `2^depth` lines `depth` levels under the range, each covering `n / 2^depth` messages. The default `depth` is 1, the same as `zoom(id, n)`. `zoom(id, 1, offset)` returns one 16 KB page of the original record, cut on a UTF-8 boundary, plus its stored images. Follow `details.next` until it is `null`; together the pages reproduce the record byte for byte.
- `chat_search(text, kind, limit, before)` finds stored messages that contain every whitespace-separated word of `text`, case-insensitively, newest first. It searches the original messages, not the summaries, so it finds names, paths, numbers and errors that a summary dropped. `kind` restricts hits to one of `user`, `talk`, `tool`, `echo`, `note` or `work`; `limit` returns 1 to 50 hits (default 10); `before` returns only messages with an id below it. Each hit prints its id, kind and a snippet of about 240 bytes. Open a hit with `zoom(id, 1)`. When older hits remain, the last line gives `before=<id>` for the next call. Memory tool calls and search or recall results are never hits. `text` is at most 200 characters and 8 words.
- `work(name, offset)` pages a captured subagent or background report by job ID, agent ID, or name; the newest match wins.
- `date(id)` returns the original message's local date and time. New records keep the host's event timestamp, not the time of writing.
- `/optchat status` reports memory and background compression state.
- `/optchat view` displays the current view.
- `/optchat export /path/to/history.html` creates a self-contained, navigable HTML history (treat it as private).
- `/optchat import /path/to/history.txt` imports plain text as a note. JSONL accepts `{ "kind": "note", "text": "…", "date": "2026-10-05T00:00:00.000Z" }`; kinds are `user`, `talk`, `tool`, `echo`, `work`, and `note`, with optional strict `metadata`. All records and images are validated before anything is appended. Import is append-only, not an OMP transcript converter.

### Subagents

OMP subagents are ordinary sessions. They never open the Store or write to the chat. Their task, async, and launch reports become `work` records in the parent's log, captured before the ordinary tool-result cap. Each record carries provenance (source, job ID, agent ID, name, completeness), full structured data, and the typed artifact output where the host supplies one. When OMP delivered only a preview and no trusted full-output reference, the record says so: it starts with `[incomplete: reason]` and has `completeness: "pointer-only"`. URIs found in report text are never followed.

`--optchat-child-view` (off by default) gives each subagent a frozen, read-only snapshot of the parent's view and `zoom`/`date`/`work`/`chat_search` over messages up to that point. A child's `chat_search` only sees messages that existed when the snapshot was taken. Every read and every prompt injection checks that the parent's publication is still live and that the child is still in the session that adopted it. The snapshot is revoked when the parent switches sessions or shuts down, and is refused if the child resumes, forks, or branches into another session. Without the flag, include the facts a child needs in its task, as before.

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

Five gates send text to the host's `judge` model role. All five are on by default. Turn one off for a session with its opt-out flag (`--no-optchat-rules`, `--no-optchat-prefetch`, `--no-optchat-value-score`, `--no-optchat-tool-gate`, `--no-optchat-recall`); an opt-out takes precedence over the gate's own flag, which is kept for explicit launches. OMP boolean flags are presence flags, so `--optchat-rules=false` does not turn a gate off. With all five opted out, OptChat resolves no judge, registers no tool hook and no `chat_recall` tool, and sends no gate messages: its context and `/optchat status` are the memory-only ones (0.5.0's, plus `chat_search` and `zoom` depth since 0.7.0). Subagents never run the gates.

### Choosing the judge

The gates use whatever model OMP's `judge` role resolves to. Set it under `modelRoles` in OMP's `config.yml` (not `models.yml`), or assign it in `/models`:

```yaml
modelRoles:
  judge: openrouter/~typesafe/jev-latest
```

Jev (TypeSafe's typed decision model, directly or through OpenRouter) answers natively. The role also accepts tiny and ordinary chat models, which answer through OMP's prompted judge. Credentials stay in OMP's credential store; the plugin has no API-key variable or provider client of its own. If no candidate is credentialed, the gates simply do not run and `/optchat status` says so.

### Turning gates off

```sh
omp --no-optchat-tool-gate                       # keep memory and the other gates, skip tool screening
omp --no-optchat-prefetch --no-optchat-value-score
omp --no-optchat-recall                          # no chat_recall tool; chat_search and zoom stay
omp --no-optchat-rules --no-optchat-prefetch --no-optchat-value-score --no-optchat-tool-gate --no-optchat-recall   # memory only
omp --no-optchat                                 # plain OMP: no memory, no gates
```

### What you will see

`/optchat status` gains a gate section while any gate is on:

```text
System One gates: rules on, prefetch on, value-score on, tool-gate on, recall on
judge: openrouter/~typesafe/jev-latest
standing rules: 1 active
last System One failure: none
```

Active standing rules follow the view as their own message, with the id, the source message id and the user's words, for example:

```text
<rules>
r1 [42] From now on, always answer in British English spelling.
</rules>
```

A prefetch block, when the judge finds relevant lines, follows as `<prefetch>` with the opened lines and a header marking them as data, not instructions. A screened tool call above the danger threshold opens a confirm dialog in an interactive session; in print or JSON mode it is blocked and the model is told why, for example "danger 0.96, no UI to confirm".

A `chat_recall` call returns the descent it took and the message it reached, for example:

```text
[optchat recall] why did the staging deploy fail?
64+32|user: deploy to staging; echo: deploy failed … (p=0.91)
80+16|… (p=0.84)
…
97+1|echo: Error: DATABASE_URL is not set … (p=0.77)
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
| `--optchat-tool-gate` | Tool gate | Judges each tool call except read-only and OptChat's own tools (`zoom`, `date`, `work`, `chat_search`, `chat_recall`, `read`, `grep`, `glob`, `find`, `todo`, `ask`, `think`, `web_search`). Danger at or above `--optchat-tool-ask` asks the user, or blocks when no UI is available. Bounded to 8 s. | tool call |
| `--optchat-recall` | Recall | Registers the `chat_recall(question)` tool. Scores the view lines against the question (single-message lines are returned directly), takes the best one at or above `--optchat-recall-min`, then asks one two-way choice per level (which half more likely holds the answer) down to a single message, and returns the path with that message's first 8 KB. At most ⌈lines/64⌉ + log₂ n judge calls; bounded to 20 s, 5 s per call. A failure or timeout returns an explicit "recall failed" result, never a guessed answer. | tool call |

Thresholds: `--optchat-rule-add` (default `0.8`), `--optchat-prefetch-k` (default `8`, integer 1–32), `--optchat-prefetch-min` (default `0.5`), `--optchat-tool-ask` (default `0.3`), `--optchat-recall-min` (default `0.5`). Probabilities are plain decimals in (0, 1]. A malformed value fails the session's configuration closed.

Behavior:

- **Judge.** The judge is the host's `judge` role, resolved per call. If the role has no credentialed candidate, or resolving it throws, that gate does not run. `/optchat status` says so. OptChat keeps working.
- **Failures.** A judge failure, a timeout, or a missing judge changes no rule and adds no prefetch block. The tool gate fails closed: it asks with a UI and blocks without one. `/optchat status` shows the last failure, cut to 200 characters.
- **Privacy.** An enabled gate sends the text it judges to the judge role's provider: user messages, view lines, tool names and inputs, and record text for the value hint. With every gate opted out, nothing is sent.
- **Cost.** With the defaults, each user message costs up to two judge requests (rules, then prefetch on a merged view), each long compacted leaf one, and each screened tool call one, before the call runs. A `chat_recall` call costs one scoring request per 64 view lines plus one choice per tree level, and only when the model calls it.
- **Rules.** A rule's text is the user's own words. When a message has several sentences, the judge rates each one, and the rule keeps only the sentences that reach `--optchat-rule-add`, so "From now on, answer in British English. Also run the tests." stores only the first sentence. Rule IDs (`r1`, `r2`, …) are never reused. `/optchat rules` lists active rules, and `/optchat rules remove ID` removes one. A triage that is still running at shutdown is abandoned and writes nothing.
- **Shutdown.** A print or JSON run exits right after its reply. On `session_shutdown`, OptChat waits up to 1.5 s for queued rule triage, then abandons whatever is still running. The bound stays under the host's 2 s session-shutdown cap, so the wait is shorter than the 5 s the design allowed.
- **Frozen per turn.** The rules and prefetch blocks are decided when a turn starts, and every request in that turn carries the same blocks, including tool loops. A rule stated mid-turn applies from the next turn.

Verified in this repository: the unit and integration tests in `tests/system1.test.ts`, `tests/system1-e2e.test.ts` and `tests/memory.test.ts`; a cache test (`tests/cache.test.ts`) showing that the system prompt, tools and view text in an encoded Anthropic request are unchanged when the rules and prefetch messages follow the view; a one-off comparison in which a 12-turn conversation produced byte-identical context and status with every gate opted out, against 0.5.0; and live print-mode runs with the real judge on OMP 18.9.1, where the tool gate blocked `rm -rf build` with no UI and a two-sentence message stored only its rule sentence. Not verified: the judge's accuracy beyond those runs, prefetch on a live merged view, and the confirm dialog in an interactive session.

## OMP-specific boundaries

- OMP caps extension context handlers at 30 seconds. OptChat therefore cancels a turn if memory has not settled within 25 seconds, before the host could ignore a timed-out hook. The unanswered user message stays in the log, and compression continues; send the request again after memory is ready. It never substitutes raw old history or half a summary.
- The extension preserves OMP's system instructions, tool policy, display, and in-turn reasoning rather than replacing the harness. It does not change your delegation policy or create its own subagent system.
- Activation does not change host settings or replace the Sharpshooter memory backend. OptChat vetoes normal automatic/manual compaction and experimental rollover, but this is not a blanket maintenance disable: OMP can still check raw-history thresholds, and automatic shake pruning can bypass that hook. This release does not change those host maintenance settings.
- Images that reach OMP as `ImageContent` (user, assistant, tool-result, and report messages) are validated as PNG, JPEG, or WebP and stored by digest. Audio, video, and original files are not archived, because OMP 18.9.0 exposes no ingress for them. Unreferenced image blobs and abandoned image/view staging files are garbage-collected after successful writer replay and snapshot validation; referenced blobs remain verified on read, and cleanup failures warn without blocking the store.
- OMP side turns, such as idle recaps and `/btw`, pass through untouched. They are recognized as host-authored, agent-attributed messages that are absent from the session branch, and they never open, reuse, or poison a main turn. OMP 18.9.0 has no typed request purpose, so another future host-authored side-turn shape could need a matching update.
- Permanent storage uses fsync, not automatic Git commits. Backups remain the operator's responsibility.

### Provider caching

For native official Anthropic requests to image-capable models, the view is split into blocks of **four summary lines**, with a cache mark on the last whole block and another at the request end. Other routes, including text-only Anthropic-compatible models whose encoder joins text blocks with newlines, keep the original fixed-offset blocks, so the view's wire bytes never change. Existing markers are bounded to four total, using five-minute entries. Concurrent compressor requests sharing a marked prefix wait for its writer's response to start; failed or canceled writers release their waiters. Coordination follows Anthropic's 20-block prefix lookup window and is limited to this enabled session. It does not send renewal requests.

Official OpenAI Responses models with the host's explicit-breakpoint capability retain their supported view markers; supported official Codex requests retain reasoning across turns of an active tool loop using `all_turns`. The new writer coordination is Anthropic-only.

Gateways and unsupported transports (including OpenRouter, Azure, Bedrock, Vertex, Foundry, custom endpoints, and pi-native) keep the host's existing cache behavior. Wire-level marker and coordination checks are not proof of real-provider cache hits, account sharing, or savings.

Turns and compactions share the effective host system prompt plus one stable OptChat guide. After a compatible host request exposes an encoded prefix, compactions can reuse its system prefix and passive callable-tool schemas; they never execute tools and reject tool-call responses. Reuse requires the encoded system content to match the compressor's own effective prompt, so side requests cannot replace its guide. Tool schemas also require matching request dialect, tool support, freeform `apply_patch` grammar, and computer-use capability; models that disable reasoning when tools are present stay tool-free. Before the first compatible request, compression is tool-free. This avoids exposing tools hidden by the host: OMP's public tool inventory is not the final model-visible catalog. Hosted-native tool schemas are not replayed, and a model requiring native tool execution cannot be selected as the compressor.

OMP's public provider hooks carry no request identity: side requests share them, and provider retries or advisors can report a response without a matching request event. The plugin therefore tracks only compressor requests as in-flight cache writers; main requests can wait for those writers, but are not tracked themselves. Main requests still use the provider's normal cache. Compressor callbacks are directly correlated, and an abandoned tracked writer has a 20-second fail-open bound. Other extensions that change payloads after this plugin's hook are outside its prefix-sharing guarantee.

**Use `PI_OPENAI_STATEFUL=0` as shown above for the specification's stateless `store:false` OpenAI requests.** OMP otherwise defaults to stateful official OpenAI Responses. A plugin cannot change the host's main-request options; deleting a response ID or changing retention mid-chain would lose context. With stateful mode left enabled, fresh turns still replace the prefix, but in-turn continuation requests keep the host's chain and receive no extra view markers. The compressor is already stateless. An explicit host caching-off setting is respected where exposed (`PI_CACHE_RETENTION=none` for OpenAI).

## Privacy and operation

**This is permanent local history, not a secret scrubber.** User text, public assistant replies, tool arguments, and tool-result text may contain secrets. The compressor receives historical content through your configured provider. Do not use it for material you cannot retain or send there. OMP may independently persist its own sessions and diagnostics; `--no-session` controls OMP session files, not the OptChat log.

Keep the memory directory private and back it up. The extension never commits or publishes it. HTML exports contain the original log. No telemetry or external storage service is added. Stop the enabled session before restoring backups or copying a consistent set of log, tree, and view files.

The Linux lock uses an OS-owned abstract Unix socket keyed by the directory's filesystem identity, avoiding PID-age guesses and stale-file unlink races. A second writer in the same network namespace fails; process death releases the lock. Filesystem operations stay anchored to held directory descriptors through `/proc/self/fd`, even if a path is renamed. Linux procfs and a local fsync-capable filesystem are required; containers in different network namespaces must not share a writable chat. Other operating systems are not supported by this release.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run smoke
```

CI runs this sequence with the pinned SDK cohort and with the latest published cohort, on every push and pull request, weekly, and on demand.

`bun run evidence:recall` is an opt-in recall and usage experiment against real models with a synthetic corpus. Without `--confirm-live-provider-calls` it checks prerequisites and prints its plan. It runs the host with private HOME and agent directories that hold only the selected credentials, so no global context files reach a provider. Call count, compressor output, and wall time are capped. The artifact separates main, compressor, and auxiliary usage and records unobserved fields as `null`, never zero. Auxiliary usage is the session's `model_usage` entries for side phases: exact SDK costs, or unobserved. Maintenance (native compaction) has its own summary: a compaction count and an estimated low/high cost interval, priced from the captured compaction frames (tokens before compaction at the cache-read and input rates, and the summary's UTF-8 bytes divided by four at the output rate). A frame that cannot be priced leaves the interval null, and zero compactions is an exact zero. A run's total cost sums the exact main, compressor, and auxiliary costs with the maintenance interval; it is null, with a reason, when any part is unobserved. Cache-read share is reported for each role and over all roles; the all-role share is null whenever maintenance is estimated or unobserved. The per-question steady-state main share sums cache reads and prompt tokens over each phase's turns after the first, and is null in batch mode. A paired delta is the off-minus-on interval difference (off low minus on high, and off high minus on low) plus the steady-state difference, present only when both arms are observed. It never reports savings it did not measure. `OPTCHAT_METRICS_FILE=/path` appends one content-free JSON line per compressor call.

`bun run evidence:retrieval` is an offline, deterministic comparison of the retrieval strategies (zoom one level at a time, zoom with depth, `chat_search`, prefetch, `chat_recall`, and a scripted beam descent) on the same probes. It builds a real memory in a temporary directory over a synthetic 256-message chat with 12 planted facts, a rule-based summariser that drops values and, with depth, topics, and a fake judge that scores word overlap. It reports per strategy the probes found, agent steps, judge calls, zoom calls and bytes returned, plus a per-fact table by age; `--seed` and `--out` select the seed and write a JSON artifact. It makes no provider calls and measures navigation mechanics only, not real summaries or Jev. The 0.7.0 results are in `.scratch/optchat-jev/issues/10-codemode-retrieval.md`: every summary-navigating strategy found only the facts whose topic survived in the view (3/12 and 5/12 over two seeds), `chat_search` found 12/12, and `chat_recall` reached the surviving facts in one agent step instead of about 200 zoom calls.

`--arms on,off` pairs the OptChat arm with a plain-OMP arm over the same corpus and questions. The off arm resumes a seeded session with OptChat disabled: it is offered no memory tools, its prompt never mentions them, and native compaction may run inside that session. Off-arm maintenance is estimated the same way as on-arm maintenance, from its captured compaction frames. A paired delta is computed only when both arms completed every requested scenario and both totals are observed, and the artifact claims no savings.

`--compressors a/b,c/d` runs one on-arm unit per compressor, and the paired comparison is reported per compressor. `--turn-mode per-question` sends one question per prompt and records each turn's latency and usage; the default `batch` sends all questions in one prompt. `--experiments child` runs the child-memory experiment: the parent delegates each question to a `task` child, once with the saved view and once blind. Grading uses only the child's delegated output.

Spend has two ceilings. `--max-cost-usd` (above 0, at most 30) is a worst-case dollar ceiling: every prompt and compressor call is admitted against its model's worst-case bound before it is dispatched, and a model with unknown rates or context window blocks rather than passes. `--max-calls` (default 80, at most 2000) caps total provider calls; when it or the deadline is reached, remaining work is refused and reported as a refusal, not silently dropped. Without `--max-cost-usd`, only the call and deadline limits apply.

The dollar bound prices input by UTF-8 bytes, not tokens: a prompt's tokens never exceed its bytes, so no tokenizer is assumed. A main prompt's bytes are the measured effective system prompt, the OptChat block, a 32 KiB tool-schema allowance, the view (on arm) or the seeded history (off arm) plus prior turns, four 16 KiB zoom pages, and the question. Tokens are clamped to the context window and priced at the dearest input-side rate. Output is priced at the pinned cap `--max-main-output` (default 4096, at most 32000): the runner writes that cap as `maxTokens` for each main model into the isolated agent directory's `models.yml`, never the source's. The bound is multiplied by the prompt's four worst-case calls, not by the number of prompts. Each on-arm compressor host reserves `--compressor-share` (default 0.5) of the uncommitted cap as its allowance, and a main prompt is admitted only if observed spend, live host allowances, and its bound together stay within the cap. When a host stops, its allowance is replaced by its observed compressor spend. An off-arm prompt also adds a native-compaction bound over the seeded history, prior turns, and the question, at the pinned cap. Compressor calls are bounded by the compactor's prompt bytes and the compressor output cap. An unknown rate, context window, or unmeasured system prompt refuses. The run prints the per-prompt main bound, the compressor per-call bound, and the host allowance in its plan. After each prompt, observed spend is charged once: exact auxiliary costs and maintenance's high bound, so bounds that were never observed are not charged. `limits.spentUsd` is that running high-bound total. A dispatched child task with no observable child cost leaves spend unobserved and blocks further live work; refused, incomplete, and not-delegated children add no child cost.

`--main-context-window` accepts an integer from 32000 up to the main model's catalog context window (the runner rejects larger values) and overrides only the main model's `contextWindow` in the isolated agent directory's `models.yml`, leaving source configuration and other models unchanged. When omitted, the requested override is `null` and the main model inherits its catalog context window. The artifact records the requested override in `models.mainContextWindow` and the effective main-model context window used by the run alongside it.

Limits of this bound: the four-call prompt limit is not an enforced tool-loop cap, and the output cap is trusted from the pinned `models.yml` entry (verified for built-in catalog models through `omp models --json`; the offline fixture provider ignores it). On-arm native compaction of the main session is observed but not bounded in advance.

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
