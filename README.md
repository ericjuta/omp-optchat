# OMP OptChat

An OMP extension based on [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). It provides one durable chat, a binary tree of contextual summaries, and a fresh model context for each user turn. Use `zoom` to retrieve original text. Summaries help the model navigate the log. They do not replace it.

## At a glance

- **One continuous chat.** OptChat appends every user message, reply, tool call, tool result, and subagent report to a local, fsynced log. Each git worktree has one store under OMP's agent directory. OptChat never deletes or rewrites these records.
- **A view instead of a transcript.** Each turn, the model sees a fixed-size view of the whole history. The view contains one-line summaries, oldest first. Older lines cover more messages. Between turns, this view replaces the old inference history. A long chat therefore does not keep expanding the context.
- **Access to original records.** Memory tools let the model navigate the view. `zoom` opens a line into its halves, or several levels at once, down to the original message. `chat_search` finds exact words in original messages. `chat_evidence` returns exact passages that relate to a question. `date` retrieves timestamps, and `work` retrieves captured subagent reports.
- **System One gates, on by default.** Four small judgments use OMP's `judge` role. They retain standing rules across turns, prefetch relevant history, guide the compressor, and support `chat_recall`. Recall starts with exact-word matches in original messages. It then scans messages under its top lines for an answer. Each gate has an opt-out flag.
- **Plain OMP remains available.** `omp --no-optchat` runs an ordinary session without OptChat memory tools, logging, compression, or context changes.

This shortened example shows what the model sees at the start of a turn:

```text
<chat>
0+64|user: set up the Bun repo and CI; talk: added ci.yml with typecheck, tests, smoke; echo: CI green on 18.9.1 …
64+32|user: "never push to main without asking"; tool: git push origin feat/x; echo: rejected, non-fast-forward …
96+2|user: why did the staging deploy fail?; talk: missing DATABASE_URL in the staging env …
98+1|user: ok, fix it and redeploy
</chat>
```

Each `id+n|text` line summarizes the `n` messages starting at `id`. To check the exact error from message 97, the model calls `zoom(96, 2)`, then `zoom(97, 1)` for the original text. If no line still mentions the error, `chat_search("DATABASE_URL")` finds it by its words. Alternatively, `chat_recall("why did the staging deploy fail?")` asks the judge to score the top lines and the messages under them.

OptChat costs one compressor call per stored message and per merge. The default gates add one rules request per user message. On turns whose view merged, they also add one prefetch request per chunk of up to 64 view lines.

When history still fits the model's context, OptChat costs more than plain OMP for the same answers. Its value is recall beyond the context window (see "0.5.0 measurements"). Each compressor call also adds a counts-only record to `metrics.jsonl` in the store directory. These records never contain message content. `/optchat status` sums them (see **Compressor cost record** below).

## Requirements and start

- OMP **18.10.3 or newer**, Bun, and Linux. CI checks every push and runs a weekly check against the latest published OMP SDK.
- An authenticated model for the main chat and an authenticated compressor model. Compression uses OMP's `@smol` role by default. Choose a competent, inexpensive model explicitly if that role is unsuitable.

Install the current release, **0.16.0**:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-optchat.git#v0.16.0'
PI_OPENAI_STATEFUL=0 omp
```

Restart existing OMP sessions after an upgrade. They retain the previously loaded plugin.

Version 0.16.0 passed these checks:

- CI with the pinned and latest SDKs.
- Linux and macOS lease checks.
- 2,599 unit tests and 56 host tests.
- An installed-plugin smoke check with the real OMP host and a synthetic model.

These are software checks, not proof of live-model answer accuracy.

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

Installing or linking the enabled plugin activates OptChat automatically in new main-agent sessions. This default applies to fresh installations and upgrades. There is no first-install marker. `--optchat` remains an optional explicit enable flag.

Use `omp --no-optchat` for an ordinary session without OptChat memory tools, logging, compression, or context changes. The `/optchat` command remains registered. The opt-out wins when both flags are present, in either order. Do not use `--optchat=false`: OMP's boolean CLI parser treats that as enabled.

Subagents never open or write the main chat. Run only one enabled session per chat directory. To select a different memory or compressor:

```sh
PI_OPENAI_STATEFUL=0 omp -e . --optchat-dir /path/to/private/chat --optchat-model anthropic/claude-sonnet-4-6
```

### Memory directories

Memory is per git worktree. Inside a git checkout, the default store is under `optchat-worktrees/`, beside the global store in OMP's agent directory. Its name combines the worktree's basename with a hash of its real path. Each worktree has its own memory, and a new worktree starts empty. Subdirectories and symlinks to the same root share that worktree's memory.

Outside git, the default is the global `optchat/` store. If another session holds it, the session uses a store for its working directory under `optchat-dirs/` instead. Like worktree stores, this store's name uses the cwd's real path. The session reports the fallback in one notice. This fallback applies only without `--optchat-dir`.

To share memory across worktrees, pass the same `--optchat-dir` to each session. Only one of those sessions can be active at a time. Stores for deleted worktrees remain under `optchat-worktrees/` until you remove them manually. Changing directories within a worktree or restarting OMP does not start a new memory. The extension does not automatically import existing OMP sessions.

Each memory directory has exactly one writer. Another live session might already hold the directory, for example through the same `--optchat-dir` in another terminal. In that case, OptChat becomes inactive instead of refusing prompts. It shows one warning and runs as if started with `--no-optchat`: no memory tools, logging, compression, or context changes.

`/optchat status` reports the reason and directory. The session log also stores a custom `optchat-inactive` entry with `reason` and `directory` in its data. This lets you identify sessions that ran without memory. The warning does not identify the holder. The kernel holds the lock, which has no owner record.

If the store cannot open for another reason, such as corruption, the session still refuses every prompt until restart. Subagents never open the store and do not conflict.

Advanced overrides are `--optchat-node-bytes`, `--optchat-view-bytes`, `--optchat-jobs`, `--optchat-tries`, and `--optchat-tool-cap`. Their defaults appear below. Version 0.4.0 removed `--optchat-retry-ms` because failed summaries now retry on the next message. Keep the defaults unless measurements justify a change.

An enabled session refuses inference if `zoom`, `date`, `work`, or `chat_search` is unavailable. This includes host modes that prohibit late tool registration.

## Using memory

The model receives the settled historical summary view before your new message. It then keeps its ordinary tool loop until the turn ends. Between turns, the view replaces old inference history. OMP's display transcript and normal tools remain available.

### Summary and source tools

`zoom(id, n)` opens an aligned power-of-two summary range into its children.

- `zoom(id, n, depth)` opens `depth` levels at once. The range is 1 to 4, with a maximum of `log2(n)`.
- The result contains the `2^depth` lines at that depth. Each line covers `n / 2^depth` messages.
- The default `depth` is 1, which is the same as `zoom(id, n)`.
- `zoom(id, 1, offset)` returns one 16 KB page of the original record, cut on a UTF-8 boundary, plus its stored images.
- Follow `details.next` until it is `null`. Together, the pages reproduce the record byte for byte.

`chat_search(text, kind, limit, before)` searches original messages, not summaries. It finds messages that contain every whitespace-separated word of `text`, without regard to case, newest first. This can recover names, paths, numbers, and errors that a summary dropped.

- `text` accepts at most 200 characters and 8 words.
- `kind` restricts hits to `user`, `talk`, `tool`, `echo`, `note`, or `work`.
- `limit` accepts 1 to 50 hits. The default is 10.
- `before` accepts 1 or more and returns only messages with an id below it.
- Each hit shows its id, kind, and a snippet of about 240 bytes. Open it with `zoom(id, 1)`.
- If older hits remain, the last line gives `before=<id>` for the next call.
- Memory tool calls and search, recall, or evidence results never appear as hits.

A search with two or more distinct words can return no hits. In that case, it also reports how many messages contain each word. This helps the model choose a word to omit. The result also names `chat_recall` when that tool is registered.

A `zoom(id, 1)` page of a tool call shows `[result: message N]` only when capture recorded an explicit link to that call. If a result spans several records, the pointer names the first record. Every result record retains the same call link. Older or unmatched records have no inferred pointer.

`work(name, offset)` pages a captured subagent or background report by job ID, agent ID, or name. The newest match wins.

`date(id)` returns the original message's local date and time. New records keep the host's event timestamp, not the time of writing.

### Local evidence

`chat_evidence(question)` searches a bounded local chunk index that can be rebuilt. It does not use a top-50 shortlist of whole messages. It returns at most 8 non-overlapping passages. Each passage contains at most 2,048 UTF-8 bytes, with a total limit of 16,384 passage bytes. Exact message and byte citations let `zoom` reopen the passages.

The index updates incrementally in memory. It is not a second durable source of truth. Its limits are:

- 64 MiB of accounted retained data.
- 32,768 chunks and 65,536 messages.
- 32 MiB of source reads per call.
- A 10-second retrieval deadline, after which the tool returns partial results.

The trailer distinguishes indexed coverage, searched chunks, omitted ranges, missing words, partial reports, and output limits. An incomplete scan cannot establish absence. No judge is used.

`--no-optchat-evidence` removes `chat_evidence` and `chat_explain`. It does not disable the independent features below. Optional extraction has separate provider transmission and timing limits.

#### Optional extraction

When OMP resolves an `openrouter` key, the extractor sends selected passages to OpenRouter/Cloudflare Clairic. OMP can resolve the key from its credential store or its accepted environment fallback. The result is an **unverified candidate occurrence, not a verified answer**.

Code checks the null threshold, exact value/span equality, unchanged source echo, Unicode offsets, and exact identifiers in the question. It withholds truncated or invalid results. These checks do not prove truth, relevance, current authority, or agreement between passages.

Extraction has a separate 10-second bound and a 262,144-byte streamed response cap. Missing keys add nothing. Failures preserve the local evidence. Cost without a credible positive report is unknown. `--no-optchat-extract` prevents this transmission.

`chat_explain()` or `/optchat explain` shows the last query's snapshot, index usage, coverage, selected matches, and omissions. It does not repeat the original passages. `/optchat index` shows the same current index/query accounting. This state stays in memory and resets with the chat.

### Decisions and report discovery

`chat_decisions(question, mode)` provides a source-linked `timeline` or `project-state`. The default mode is `project-state`. It distinguishes proposals, human decisions, replacements, withdrawals, reported completion, and host-observed tool completion. It makes no model call and writes no instructions.

Conservative explicit forms can establish state. Examples are `Use port 5432 for staging.`, `Change staging to 6543.`, and `Revert it to 5432.` Quoted, conditional, or ambiguous prose stays unresolved. A later historical mention is not a new decision.

The scan is limited to 256 messages, 256 KiB, 4 KiB per source, 64 events, and one second. Incomplete coverage cannot establish current state. `--no-optchat-decisions` removes this tool.

`chat_work({question?, name?, limit?, before?})` discovers captured reports and calls explicitly associated with them. Reused names remain separate captures. Missing host call, run, or report identifiers stay unknown. The tool does not infer them from prose.

Each result includes completeness, capture time, and exact `zoom` citations. `work(name)` still selects the newest name match. Discovery scans at most 2,048 records/256 KiB and returns at most 20 captures. `--no-optchat-work-discovery` removes this tool.

### Evidence from other stores

`chat_project_evidence` is Linux-only. It exists only with an explicit allowlist such as `--optchat-project-stores '{"branch":"/absolute/canonical/store"}'`, with at most 8 stores.

- `mode: "search"` searches selected aliases.
- `mode: "read"` reopens a returned opaque store key, message id, and byte offset.
- External ids are **not local zoom ids**.

The first request pins read-only file descriptors, complete-record cutoffs, and SHA-256 digests. Later appends are excluded. Retrieval makes no secondary provider call, acquires no writer lease, mutates no store, and imports no rules. Returned evidence still enters the requesting main-model conversation.

Other platforms fail closed because their pathname APIs do not establish Linux-style opened-link identity. Symlink paths are refused. Configure canonical roots. `/optchat new` and host session changes revoke these snapshots. Search again for fresh keys.

Aggregate admission is limited to 128 MiB, 256 daily files, and 100,000 records. Returned passage text keeps the eight-passage/16 KiB limit. Diagnostic id lists are bounded and include explicit omission counts.

### Commands

- `/optchat status` reports the loaded plugin version, current session identity, memory state, and background compression state. It also reports the last observed main/compressor cache modes. A mode describes the encoder path, not a cache hit or savings. Before a request, the mode is unknown. Once the store records compressor calls, status reports their count and the host-reported cost.
- `/optchat view` shows the current view.
- `/optchat export /path/to/history.html` creates a self-contained, navigable HTML history. Treat it as private.
- `/optchat import /path/to/history.txt` imports plain text as a note. JSONL accepts stored kinds and strict metadata. All records and images undergo validation before append.
- `/optchat new` starts a fresh, empty chat. This session's memory must be open, and the agent must be idle. The command asks first when the UI can.

Imports explicitly downgrade tool-success/error claims to historical imported outcomes. Those claims cannot become host-observed completion. A live host `isError: false` proves only that the linked tool invocation returned without a host tool error. It does not prove process exit, passing tests, or project completion. Reopening new `toolOutcome` metadata requires version 0.16.0 or newer. Older stores without it remain readable.

`/optchat new` moves the current store unchanged to a sibling archive named `<dir>.<UTC stamp>`. For example, it can create `chat.20261013T081500Z`, with a numeric suffix if that name is taken. An empty store then opens at the original path. Reopen the old chat with `--optchat-dir <archive>`. OMP's own `/new` deliberately keeps the same OptChat memory. Use `/optchat new` to reset it.

### Continuation checks

Run `bun run evals:evidence:continuation --baseline /path/to/v0.15.2-checkout` for the continuation comparison. It is a frozen software comparison with zero provider calls and injected extraction outcomes. It is **not** a measurement of live Clairic quality.

`bun run smoke:evidence` uses a synthetic host. It exercises the exported plugin lifecycle, tool registration, citations, source scopes, child packs, and reset/shutdown fences.

### Subagents

OMP subagents are ordinary sessions. They never open the Store or write to the chat. Their task, async, and launch reports become `work` records in the parent's log. Capture occurs before the ordinary tool-result cap.

Reports recovered with `wait` use the same capture path. Each finished task job gets one `work` record under its job ID, agent ID, and name, so `work(name)` finds it. A job that OMP already delivered automatically keeps its first record. Other jobs listed by `wait`, such as bash jobs or still-running jobs, remain an ordinary tool result.

Each record carries provenance: source, job ID, agent ID, name, and completeness. It also carries full structured data and typed artifact output when the host supplies it. If OMP supplies only a preview without a trusted full-output reference, the record starts with `[incomplete: reason]`. Its metadata has `completeness: "pointer-only"`. OptChat never follows URIs found in report text.

#### Unreleased host capabilities

An **unpublished, source-only OMP host patch** was developed to retain cumulative public report publications in an immutable artifact of up to 4 MiB. This artifact is independent of the final structured answer. The upstream submission was abandoned. The patch is not part of the released plugin or a required setup step.

Its typed descriptor binds the run, byte count, and SHA-256 digest. OptChat verifies the artifact body and copies it into its own log before paging it. Later artifact replacement or a short final acknowledgement therefore cannot replace the archived report. Missing, mismatched, or partial artifacts remain explicitly incomplete. The plugin does not install this host capability. This description makes no claim about the currently installed stock host.

Typed inter-agent delivery also requires that source-only host patch. The host authenticates sender and recipient generations and emits an agent-attributed `collab:agent-message`. OptChat stores the full bounded body as a `note`, with sender/recipient provenance, never as a human instruction. Invalid attribution or metadata is rejected.

Terminal paste-and-Enter is not a typed transport. It cannot establish agent provenance and must not serve as a fallback. This work changes no running host, launcher, or configuration.

The sender's atomic commit authorizes delivery. Closing or rotating the sender blocks new commits, but already committed messages may still finish. The receiver checks its own current generation immediately before admission and deduplicates the request. Shutdown waits a bounded time for acknowledgements. Unresolved deliveries report `revocation_incomplete`, not successful revocation. The timeout is source-local, not a cross-process clock or message-expiry guarantee.

#### Child views and packs

The child view is on by default since 0.11.0. Each subagent receives a frozen, read-only snapshot of the parent's view and these tools:

- `zoom`, `date`, `work`, and `chat_search`.
- `chat_evidence` while the parent's `--optchat-evidence` is on.

The snapshot covers only messages that existed when it was taken. A child's `chat_search` and `chat_evidence` cannot see later messages. Every read and prompt injection checks that the parent's publication remains live. It also checks that the child remains in the session that adopted the snapshot.

The snapshot is revoked when the parent switches sessions, fails durable logging, or shuts down. It is refused if the child resumes, forks, or branches into another session. `--no-optchat-child-view` disables it for a session. OMP boolean flags are presence flags, so `--optchat-child-view=false` does not disable it. Without the snapshot, include the facts a child needs in its task.

A child that reads the snapshot pays for that reading. In the 0.5.0 child experiment below, children cost $0.20 with the view and $0.09 without it.

Task-focused child packs are also on by default. Each task receives up to 4,096 UTF-8 bytes of quoted relevant evidence from its frozen parent snapshot, with citations. Pack construction uses deterministic retrieval only, never Clairic or the judge. It checks session and revocation state before and after the asynchronous read.

A pack adds a per-turn message, not variable tool definitions or system-guide text. `--no-optchat-child-pack` disables only this supplement. `--no-optchat-child-view` disables the entire parent handoff. Preparing and consuming a pack is not a measured cost-saving claim.

## Storage and compression

```text
chat/
  main/YYYY-MM-DD.jsonl   # {i,kind,text,size,date}
  tree/YYYY-MM-DD.jsonl   # {l,i,text,size}
  view.json               # {version:2,length,parts,compacting,compactor:{length,parts,compacting}}
  ledger.jsonl            # standing rules, appended per event; absent with --no-optchat-rules
  images/                 # content-addressed image blobs referenced by message metadata
```

Messages can carry an optional strict `metadata` field with:

- Work provenance.
- Ordered image references: digest, MIME type, and byte count.
- Explicit `resultFor` links to earlier tool calls.
- Typed `coordination` provenance on agent notes.

Older five-field records remain readable unchanged. Older plugin versions reject unfamiliar metadata fields. Do not reopen a store containing these new fields with an older binary.

OptChat appends and fsyncs records before publication. Replay also fsyncs recovered files before admitting them. Daily filenames use the local day of writing. Each record retains its original timestamp, including imported historical dates. IDs are permanent.

OptChat reports malformed or torn lines. It does not silently renumber missing IDs or conflicting records. In principle, the tree can be rebuilt. Existing summaries remain in place to avoid paying twice.

### Saved views

OptChat atomically replaces and fsyncs the main view before publishing a new tiling. A tiling is the set of summary ranges that make up a view. The versioned envelope stores both main and compactor tilings, plus their unfinished batch latches, in one transaction. Restarts load those exact tilings instead of reconstructing them. This preserves the compactor's cache prefix across restarts.

OptChat migrates a v0.3.0 snapshot once. It keeps the main tiling exactly and initializes the compactor tiling from it. After a crash, durable messages beyond the saved view append to its existing prefix. A pre-0.2.0 chat without `view.json` also migrates once. Malformed or inconsistent snapshots fail closed instead of silently producing a different view.

The summary target is 512 UTF-8 bytes. The main view appends leaves until its summary text exceeds 128,000 bytes. It then merges a batch down to 64,000 bytes. Merge priority measures age from the sibling pair's **last** message, with oldest-first ties. Only built parents can be used. An unfinished batch stays active across later node completions, messages, and restarts. The view never splits.

The compressor has its own view, which cycles between 16,000 and 32,000 bytes. It combines main-view ranges into coarser summaries and refreshes when the main view merges. It contains only built, addressed summary lines before the target message, or through the end of a target merge. It never contains later messages.

The compressor measures age against its own available endpoint, not the main chat's queued tail. Compression instructions use a 512-dash ruler instead of example content. Sizes apply to summary text, not token estimates or provider-envelope overhead.

### Summary integrity and scheduling

Compressor replies cannot attribute a span to `user:` if the span contains no user record. The check recognizes nested speaker labels and presentational wrappers while preserving genuinely quoted text. Invalid candidates are retried and cannot become fallback summaries. If no safe candidate remains, the existing marked source excerpt lets the tree continue. Historical summaries are not rewritten.

New tool-result records use optional strict `metadata.resultFor`, which points to an earlier tool record. Indexed JSONL imports remap these links into the destination store. Unindexed imports that contain links are rejected. Older logs remain readable without invented associations. Older plugin binaries that do not recognize the new metadata cannot reopen stores containing it.

Short records and child pairs that already fit are free nodes. Longer records use bounded UTF-8 pages. The compressor summarizes each page, then reduces those summaries in bounded groups to one leaf. It skips no source byte and adds no permanent ID. Page summaries are not persisted. After a restart, an unfinished long leaf is recomputed.

Work uses dependency-ready queues, as the upstream specification requires. The tree is never scanned for work. A message's leaf is admitted while fewer than eight earlier leaves remain unbuilt. A merge becomes ready when both halves exist, in any order. At most eight calls run at once.

Each summary gets five shortening attempts with bounded feedback. OptChat keeps the shortest whole reply. If no attempt fits a 16 KB safety ceiling, the summary fails instead of being cut. A failed call releases its slot immediately and retries on the next appended message. There are no idle retry timers.

### Refusals

A compressor refusal is a provider reply with `stopReason: "error"` whose message starts with `Refusal`. This is how pi-ai reports Anthropic's `stop_reason: refusal`.

OptChat retries that compaction once with the session's main model, under the same admission, cache, and token rules. Its metric line names the model that answered. This fallback has a 30-second wall deadline covering admission, authentication, and the whole provider response. If it exceeds the deadline, OptChat cancels it and treats it as a refusal.

If the main model also refuses, or is the compressor itself, OptChat commits a deterministic excerpt of the node's source. The excerpt starts with `[unsummarized: compressor refused]` and fits the node's byte budget. This stand-in helps navigation but is not a model summary. `zoom` returns the originals. The tree continues so later prompts are not refused.

Other provider errors retain retry-on-next-message behavior: transport, HTTP, rate limit, aborts, and length errors. Each fallback is reported once. `/optchat status` counts main-model retries and stand-ins.

A model turn waits for summaries instead of seeing partial source text. OptChat reports compression failures. Cancel a wait if the provider is unavailable. History that the plugin already accepted remains stored.

OptChat does not write reasoning/thinking to its log. Ordinary tool-result text has a 30,000-character cap that retains the head and tail. Registered memory tools enforce their own bounds and are exempt from this cap. Their citations and JSON envelopes therefore remain intact.

## System One gates (Jev)

Four gates send text to the host's `judge` model role. All four are on by default. Use the corresponding opt-out flag to disable a gate for a session:

- `--no-optchat-rules`
- `--no-optchat-prefetch`
- `--no-optchat-value-score`
- `--no-optchat-recall`

An opt-out takes precedence over the gate's own flag, which remains available for explicit launches. OMP boolean flags are presence flags. For example, `--optchat-rules=false` does not disable the rules gate.

With all four gates disabled, OptChat resolves no judge, registers no `chat_recall` tool, and sends no gate messages. Its context and `/optchat status` use the memory-only behavior from 0.5.0, with later memory features. These include `chat_search` and `zoom` depth from 0.7.0, plus `chat_evidence`.

`chat_evidence` is not one of the four gates and never resolves a judge. It remains registered when every gate is disabled. Use `--no-optchat-evidence` to remove it. Subagents never run the gates.

Version 0.8.0 removed the tool gate, which screened tool calls before execution. OMP's own tool approval handles risky-call confirmation through `tools.approval` in OMP's settings.

### Choosing the judge

The gates use the model that OMP's `judge` role resolves to. Set it under `modelRoles` in OMP's `config.yml`, not `models.yml`. Alternatively, assign it in `/models`:

```yaml
modelRoles:
  judge: openrouter/~typesafe/jev-latest
```

Jev is TypeSafe's typed decision model, available directly or through OpenRouter. It answers natively. The role also accepts tiny and ordinary chat models, which answer through OMP's prompted judge.

OMP resolves judge credentials. The separate Clairic adapter described above is the sole approved plugin-side provider client. It reads no environment variable itself. If no candidate has credentials, the gates do not run. `/optchat status` reports this condition.

If the `judge` role has no candidate at all but the session has a model, OMP returns the session model. OptChat runs no gate on that model. Rules, prefetch, value-score, and recall become inactive, and `/optchat status` explains why. `chat_recall` stays registered so tool definitions do not change, but it reports that it is inactive. No judged text goes to the session model's provider.

### Turning gates off

```sh
omp --no-optchat-prefetch --no-optchat-value-score
omp --no-optchat-recall                          # no chat_recall tool; chat_search and zoom stay
omp --no-optchat-rules --no-optchat-prefetch --no-optchat-value-score --no-optchat-recall   # judge gates off; Clairic remains on
omp --no-optchat-evidence                        # no chat_evidence tool; it never used a judge
omp --no-optchat-extract                         # chat_evidence never calls the Clairic extractor
omp --no-optchat                                 # plain OMP: no memory, no gates
```

### What you will see

`/optchat status` adds a gate section while any gate is on:

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

Judge-call counters include answers served from the shared judgment cache. OMP's billed `model_usage` rows can therefore be fewer.

With the session-model fallback, the gate section reads:

```text
judge: openrouter/anthropic/claude-sonnet (session model fallback: the judge role has no native candidate; no gate runs)
rules inactive: no native judge model (judge role resolves to session model)
prefetch inactive: no native judge model (judge role resolves to session model)
value-score inactive: no native judge model (judge role resolves to session model)
recall inactive: no native judge model (judge role resolves to session model)
```

These counts are an illustrative sample, not a measurement. They stay in memory for this session only. Judge calls count every judgment a gate makes. Failures count those recorded in the last-failure line.

The outcome counters are:

- Rules: `added`, `replaced`, and `removed`.
- Prefetch: `blocks` built and their `bytes`. Each request that carries a block counts that block.
- Value-score: `hints` added to a compaction instruction.
- Recall: `answered`, `none`, and `failed`.

These counts never enter the system prompt, view, or provider request. With every gate off, status has no gate lines.

Active standing rules follow the view in their own message. Each rule includes its id, source message id, and the user's words:

```text
<rules>
r1 [42] From now on, always answer in British English spelling.
</rules>
```

When the judge finds relevant lines, a `<prefetch>` block follows with the opened lines. Its header marks them as data, not instructions. OptChat does not screen or approve ordinary tool calls.

A `chat_recall` result shows the scanned view line that covers the chosen message, if any, followed by the message itself:

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
| `--optchat-rules` | Standing rules | Judges human user messages for standing instructions, replacements, or explicit withdrawals. Accepted changes append to `ledger.jsonl`. Active rules appear in a `<rules>` block after the view. Agent messages cannot change this ledger. | human user message |
| `--optchat-prefetch` | Prefetch | Judges merged view lines against the new user message. It zooms relevant lines into a `<prefetch>` block. It is bounded to 5 s and to the settle deadline's remaining time. | user message |
| `--optchat-value-score` | Value hint | Judges each long leaf's label and importance. It adds one fixed sentence to the compaction instruction. That sentence never contains record text or ids. | compacted leaf |
| `--optchat-recall` | Recall | Registers `chat_recall(question)`. It scores candidates, scans messages under the top lines, and selects a likely answer as described below. | tool call |

Recall follows these steps:

1. Collect the view lines and up to `--optchat-recall-seeds` raw-log matches. The default is `8`, with an integer range of 0–32. The word search's widest pool is re-ranked locally with BM25-style length normalization, without a model call. This lets a short message that states the answer beat a long dump. The top seeds become single-message lines.
2. Score all candidates against the question in the same relevance requests. If no line reaches `--optchat-recall-min`, report that result.
3. Otherwise, scan the top `max(--optchat-recall-k, 4)` multi-message lines at or above `--optchat-recall-min`. Score every built message under those lines in one more round, up to 256 messages. Skip a whole line if it would exceed the cap.
4. Compare messages that reached `--optchat-recall-min` or lie under a scanned line. Show those within 0.1 of the best score, at most 8, side by side in one choice question.
5. Return the likeliest message, its path, and its first 8 KB. The path shows the scanned line that covers it, then the message. With `--optchat-recall-k` above 1, also list the next messages by rank and any scanned line that failed.

Recall uses about ⌈(lines+seeds)/64⌉ scoring requests, plus 1–4 scan requests and at most one pick. The overall bound is 20 s, with 5 s per call. A failed pick keeps the score ranking. A failure or timeout returns an explicit "recall failed" result, never a guessed answer.

Thresholds and selection limits:

| Flag | Default | Range or effect |
| --- | --- | --- |
| `--optchat-rule-add` | `0.8` | Probability cutoff |
| `--optchat-prefetch-k` | `8` | Integer 1–32 |
| `--optchat-prefetch-min` | `0.5` | Probability cutoff |
| `--optchat-recall-min` | `0.5` | Probability cutoff |
| `--optchat-recall-k` | `1` | Integer 1–8. Widens the recall scan beyond the top 4 lines. Above 1, also lists losing candidates. |
| `--optchat-recall-seeds` | `8` | Integer 0–32 |

Probabilities are plain decimals in (0, 1]. A malformed value causes the session's configuration to fail closed.

### Gate behavior and privacy

The host resolves the `judge` role for each call. If it has no credentialed candidate, or resolution throws, that gate does not run. `/optchat status` reports the condition, and OptChat keeps working. If the role has no candidate but a session model exists, OMP uses that model as the fallback judge. Every gate remains inactive on it.

A judge failure, timeout, or missing judge changes no rule and adds no prefetch block. `/optchat status` shows the last failure, cut to 200 characters.

An enabled gate sends the text it judges to the judge role's provider. This includes user messages, view lines, tool names and inputs, and record text for the value hint. With the session-model fallback, no gate runs and no gate text is sent. The same is true when every gate is disabled.

### Cost

With default settings:

- Each user message costs one rules request.
- A turn whose view merged adds one prefetch request per packed chunk of view lines. Each chunk holds at most 64 lines or 24,000 bytes. The live run observed 3 requests per such turn.
- Each long compacted leaf costs one value-hint request.
- `chat_recall` costs one scoring request per 64 candidate lines, including view lines and `--optchat-recall-seeds` raw-log matches. It adds 1–4 scan requests for messages under the top lines and at most one choice question among near-tied messages. This cost occurs only when the model calls the tool.

#### Compressor cost record

Each completed compressor call appends one line to `metrics.jsonl` in the store directory. The file is append-only with mode 0600. Writes are best effort: a failed write produces a warning but never stops the chat. Records contain counts and diagnostics, never message content.

A compressor row has `type: "compressor"` and these fields:

- `at`: completion time in ISO-8601 UTC.
- The model and host-reported input, output, cache-read, and cache-write token counts.
- `node`: `leaf` for a message or one page of a long message, or `merge` for two lines.
- `attempt`: the 1-based attempt within one compaction.
- `retry`: `null` on the first attempt, otherwise `head`, `length`, `marker`, or `user`.
- `waitMs`: time in admission and waiting for the cache lease before sending the request.
- `latencyMs`: provider time only, excluding `waitMs`.
- The host-reported USD cost, or `null` if the host reports none.
- The stop reason and bounded error text.

The same file holds two other counts-only row types:

- `host-compaction`: one row for each host compaction OptChat answered. Fields are `at`, `outcome`, a closed `reason` when cancelled, and `tokensBefore`. Outcomes are `marker`, `cut-moved`, `cut-in-turn`, or `cancelled`.
- `rules`: one row per triage. Fields include `at`, the judge's P(rule) for the message, the highest per-sentence P(rule), and the sentence count. It also records the `--optchat-rule-add` cutoff and whether any rule was written. It never stores message or rule text.

Only compressor rows count as calls. A line without a `type`, written before rows had types, is a compressor row. `/optchat status` shows the store's call count and sum of reported costs. A call without a reported cost still counts and appears as unknown, never as $0. `/optchat new` archives the file with the old chat.

The evidence runner sets `OPTCHAT_METRICS_FILE` to a per-host path outside the store copy. This lets it count only that host's calls. The variable redirects the output file and is not needed otherwise.

#### Measured compressor cost

This was one cold, parallel build, **not a typical cost measurement**. On 2026-10-17, OMP 18.11.3 used `@smol` = `anthropic/claude-sonnet-5-5` with a fresh store. The input was 64 consecutive real messages with 61,601 text bytes. Settings were `--optchat-view-bytes 8192` and the default 8 jobs.

Eight leaf calls started at once on a cold cache, so none could read another's cache. The run stopped after 7 returned. Each of those n=7 calls had:

- 4 input tokens and 0 cache-read tokens.
- 66,022 to 68,491 cache-write tokens.
- 158 to 218 output tokens.
- A host-reported cost of $0.1666 to $0.1733, totaling $1.1799.

Each compressor call carries the host's system prompt as its shared prefix. That prompt was 176,452 bytes in a host started with the same flags. The measurement did not isolate the prefix's share of the cache write.

No merge call ran, and no call read the cache. This run therefore did not measure warm leaf cost, warm merge cost, or cost per stored message. `metrics.jsonl` and `/optchat status` now record these in live use.

### Standing rules

A rule uses the user's own words. For a message with several sentences, the judge rates each sentence separately. Every sentence that reaches `--optchat-rule-add` becomes its own rule. The full sentence remains intact, including any "unless…" clause.

For example, "Use British English. Always ask before deploying." stores two rules. "From now on, answer in British English. Also run the tests." stores only the first sentence. Each sentence also selects its own replacement or withdrawal target. Rule IDs (`r1`, `r2`, …) are never reused.

`/optchat rules` lists active rules. `/optchat rules remove ID` removes one. A human message can also explicitly withdraw a rule or declare that its scope ended. The judge assesses withdrawal separately from adding a standing rule. OptChat then checks the withdrawal against an offered active ID before durable removal.

Automatic targets for each sentence include the newest 16 active rules and up to 16 older rules whose words best match that sentence. The command can remove any rule. Unknown, stale, or ambiguous targets do nothing. Duplicate withdrawals never resurrect a rule. OptChat infers no time-based expiry. A triage still running at shutdown is abandoned and writes nothing.

Standing instructions have different scopes:

- The rules ledger (`ledger.jsonl`) holds instructions you state in this chat. It is per store, and therefore per worktree by default.
- OMP TTSR rule files hold enforced guardrails for every session.
- Sharpshooter holds cross-session project decisions learned from friction.

An item in one location is not copied to the others.

A print or JSON run exits immediately after its reply. On `session_shutdown`, OptChat waits up to 1.5 s for queued rule triage, then abandons any remaining work. This stays below the host's 2 s shutdown cap. The wait is shorter than the 5 s allowed by the design.

Rule additions and prefetch freeze when a turn starts. A new rule or replacement successor applies from the next turn. Retirement is the exception: retired IDs disappear from later context assemblies. This includes tool loops and an assembly waiting for prefetch. Already assembled or transmitted requests are not rewritten.

### Verification scope

Repository verification includes:

- Unit and integration tests in `tests/system1.test.ts`, `tests/system1-e2e.test.ts`, and `tests/memory.test.ts`.
- A cache test in `tests/cache.test.ts`. It shows unchanged system prompt, tools, and view text in an encoded Anthropic request when rules and prefetch messages follow the view.
- A one-off, 12-turn comparison against 0.5.0. With every gate disabled, context and status were byte-identical.
- Live print-mode runs with the real judge on OMP 18.9.1. The tool gate, removed in 0.8.0, blocked `rm -rf build` without a UI. A two-sentence message stored only its rule sentence.

These checks did not verify judge accuracy beyond those runs, prefetch on a live merged view, or the confirm dialog in an interactive session.

## OMP-specific boundaries

### Turn settlement and compaction

OMP caps extension context handlers at 30 seconds. OptChat cancels a turn if memory does not settle within 25 seconds, before the host could ignore a timed-out hook. The unanswered user message stays in the log, and compression continues. Send the request again after memory is ready. OptChat never substitutes raw old history or a partial summary.

The extension preserves OMP's system instructions, tool policy, display, and in-turn reasoning. It does not replace the harness, change your delegation policy, or create its own subagent system. Activation does not change host settings or replace the Sharpshooter memory backend.

When OMP compacts the chat, OptChat answers with one fixed marker summary and makes no model call. This applies to automatic compaction, `/compact`, and experimental rollover. The host then keeps only recent messages. Full history remains in OptChat's log and tree, and the model reads it through the OptChat view.

A compaction cut can otherwise drop part of the open turn. OptChat moves that cut to the turn's first message when older history is at least as large as the turn's dropped part. If the turn is most of what the host would drop, or the cut cannot move there, the cut stays inside the turn. The marker then names the turn's first message so the model can reread it with `zoom(id, 1)`. Earlier steps of the turn are also in the log.

OMP shows the marker in place of the older transcript, as with any compaction. Automatic shake pruning still bypasses the hook. Activation changes none of OMP's maintenance settings.

A marker compaction costs no model call. Set `compaction.thresholdTokens` to about 200,000–300,000 in OMP's config. OMP's own side requests, such as skill capture and away recaps, send raw session history. With the default threshold on a 1M-token model, these requests failed 12 times with "prompt is too long" in sessions before 0.12.0.

### Other host boundaries

Images that reach OMP as `ImageContent` undergo PNG, JPEG, or WebP validation and are stored by digest. This includes user, assistant, tool-result, and report messages. Audio, video, and original files are not archived because OMP 18.9.0 exposes no ingress for them.

After successful writer replay and snapshot validation, OptChat garbage-collects unreferenced image blobs and abandoned image/view staging files. Referenced blobs remain verified on read. Cleanup failures produce warnings without blocking the store.

OMP side turns, such as idle recaps and `/btw`, pass through unchanged. OptChat recognizes them as host-authored, agent-attributed messages absent from the session branch. They never open, reuse, or corrupt a main turn. OMP 18.9.0 has no typed request purpose. A future host-authored side-turn shape could therefore require a matching update.

Permanent storage uses fsync, not automatic Git commits. Backups remain the operator's responsibility.

### Provider caching

For native official Anthropic requests to image-capable models, OptChat splits the view into blocks of **four summary lines**. It places a cache mark on the last whole block and another at the request end.

Other routes keep the original fixed-offset blocks, so the view's wire bytes never change. This includes text-only Anthropic-compatible models whose encoders join text blocks with newlines. Existing markers are bounded to four total and use five-minute entries.

Concurrent compressor requests can share a marked prefix, or the same anchored tools and system head. Those requests wait for the writer's response to start. Failed or cancelled writers release their waiters. Main requests never wait on a head alone.

Before 0.10.3, concurrent cold compressor calls each wrote the whole system prefix and none read it. Each call's last mark was its own task line. A live check after the change used n = 3 calls, with no same-session control. The first call wrote 65,171 tokens. The next two each read 61,980 tokens at about a tenth of its cost: $0.1646, $0.0163, and $0.0158.

Coordination follows Anthropic's 20-block prefix lookup window and applies only within this enabled session. It sends no renewal requests.

Official OpenAI Responses models retain supported view markers when the host provides explicit-breakpoint capability. Supported official Codex requests retain reasoning across turns of an active tool loop through `all_turns`. The new writer coordination applies only to Anthropic.

Gateways and unsupported transports keep the host's existing cache behavior. These include OpenRouter, Azure, Bedrock, Vertex, Foundry, custom endpoints, and pi-native. Wire-level marker and coordination checks do not prove real-provider cache hits, account sharing, or savings.

#### Shared prefixes and tool schemas

Turns and compactions share the effective host system prompt plus one stable OptChat guide. After a compatible host request exposes an encoded prefix, compactions can reuse its system prefix and passive callable-tool schemas. Compactions never execute tools and reject tool-call responses.

Reuse requires the encoded system content to match the compressor's own effective prompt. Side requests therefore cannot replace its guide. Tool schemas also require matching request dialect, tool support, freeform `apply_patch` grammar, and computer-use capability. Models that disable reasoning when tools are present stay tool-free. Before the first compatible request, compression is tool-free.

This avoids exposing tools that the host hides. OMP's public tool inventory is not the final model-visible catalog. Hosted-native tool schemas are not replayed. A model that requires native tool execution cannot be the compressor.

OMP's public provider hooks carry no request identity, and side requests share them. Provider retries or advisors can report a response without a matching request event. The plugin therefore tracks only compressor requests as in-flight cache writers. Main requests can wait for those writers but are not tracked themselves. They still use the provider's normal cache.

Compressor callbacks are directly correlated. An abandoned tracked writer has a 20-second fail-open bound. Other extensions that change payloads after this plugin's hook are outside its prefix-sharing guarantee.

#### Stateless OpenAI requests

**Use `PI_OPENAI_STATEFUL=0` as shown above for the specification's stateless `store:false` OpenAI requests.** OMP otherwise defaults to stateful official OpenAI Responses. A plugin cannot change the host's main-request options. Deleting a response ID or changing retention mid-chain would lose context.

If stateful mode stays enabled, fresh turns still replace the prefix. In-turn continuation requests keep the host's chain and receive no extra view markers. The compressor is already stateless. OptChat respects explicit host caching-off settings where exposed, including `PI_CACHE_RETENTION=none` for OpenAI.

## Privacy and operation

**This is permanent local history, not a secret scrubber.** User text, public assistant replies, tool arguments, and tool-result text may contain secrets. The compressor receives historical content through your configured provider. Do not use OptChat for material you cannot retain or send there. OMP may independently persist its own sessions and diagnostics. `--no-session` controls OMP session files, not the OptChat log.

Keep the memory directory private and back it up. The extension never commits or publishes it. HTML exports contain the original log. OptChat adds no telemetry or external storage service. Stop the enabled session before restoring backups or copying a consistent set of log, tree, and view files.

On Linux, the single-writer lock uses an OS-owned abstract Unix socket keyed by the directory's filesystem identity. Filesystem operations stay anchored to held directory descriptors through `/proc/self/fd`, even if a path is renamed. A second writer in the same network namespace fails. Containers in different network namespaces must not share a writable chat. Linux procfs is required.

On macOS, the lock uses an exclusive non-blocking `flock` on the held root directory descriptor. Filesystem operations resolve held descriptor paths through `F_GETPATH`. Both locks avoid PID-age guesses and stale-file unlink races. Process death releases the lock. A local fsync-capable POSIX filesystem is required.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:host
bun run smoke
```

`bun run test` covers unit and fake-host suites. `bun run test:host` covers `tests/host/`, which launches real OMP hosts for the integration suite and paired evidence run. CI runs this sequence with both the pinned SDK cohort and the latest published cohort. It runs on every push and pull request, weekly, and on demand.

### Writer lease verification

`bun run verify:lease` checks the store writer lease in about 12 seconds. It runs a TLA+ model under TLC and real-process tests against `src/store.ts`. Java 21 is required and located through `$JAVA`, `mise`, or PATH. The command fetches the pinned `tla2tools.jar` if it is missing.

CI splits verification into two jobs:

- `verify-lease` on Linux runs everything with `bun run verify:lease --strict`: the model and real-process phase.
- `verify-lease-macos` runs the real-process phase with `--real-only --strict`. It also runs `tests/store.test.ts`, `tests/store-directory.test.ts`, `tests/crash.test.ts`, and `tests/new-chat.test.ts`.

macOS exercises the `flock` path of `acquireLease` and `F_GETPATH` descriptor paths, which Linux never runs. The model is platform-independent and stays on Linux. On macOS, the harness lists descriptors through `/dev/fd` and the store's own `fdPath`. Lease-breaking variants target the flock code under the same ids and probes: `lease-name-per-process`, `failed-open-keeps-lease`, `gc-before-lease`, and `close-keeps-lease`.

Run lease verification after changes to the lease, `Store.open`/`close`, `/optchat new`, or rules-ledger and metrics writes. See `.omp/skills/verify-store-lease/SKILL.md` for how to interpret it.

`--deep` adds the five guarantees with three sessions. Each guarantee has about 4.1 million states. The full deep run takes about 6 minutes and up to 24 GB of RAM. Neither the default run nor CI includes it.

Verification reports no open findings. F1 concerned `/optchat new` renaming a store that another session had open. F2 concerned pathname writes to the rules ledger and `metrics.jsonl`. Both are fixed (CHANGELOG, 0.13.1) and checked as guarantees. `--strict` exits 0.

### Live recall and usage experiment

`bun run evidence:recall` is an opt-in experiment against real models with a synthetic corpus. Without `--confirm-live-provider-calls`, it checks prerequisites and prints its plan. It runs the host with private HOME and agent directories containing only selected credentials. No global context files reach a provider. Call count, compressor output, and wall time are capped.

The artifact separates main, compressor, and auxiliary usage. Unobserved fields are `null`, never zero. Auxiliary usage comes from the session's `model_usage` entries for side phases. These are exact SDK costs or unobserved values.

Maintenance, meaning native compaction, has its own summary: a compaction count and estimated low/high cost interval. Pricing uses captured compaction frames:

- Tokens before compaction at cache-read and input rates.
- The summary's UTF-8 bytes divided by four at the output rate.

If a frame cannot be priced, the interval stays null. Zero compactions is an exact zero. A frame with OptChat's fixed marker made no model call. It counts as a compaction but costs exactly zero.

A run's total cost combines exact main, compressor, and auxiliary costs with the maintenance interval. If any part is unobserved, total cost is null with a reason. Cache-read share appears for each role and across all roles. The all-role share is null whenever maintenance is estimated or unobserved.

The per-question steady-state main share sums cache reads and prompt tokens over each phase's turns after the first. It is null in batch mode. A paired delta is the off-minus-on interval difference: off low minus on high, and off high minus on low. It also includes the steady-state difference and appears only when both arms are observed. The runner never reports unmeasured savings. `OPTCHAT_METRICS_FILE=/path` appends one content-free JSON line per compressor call.

### Offline retrieval comparison

`bun run evidence:retrieval` compares retrieval strategies deterministically and offline on the same probes:

- One-level `zoom`.
- `zoom` with depth.
- `chat_search`.
- Prefetch.
- `chat_recall`.
- Scripted beam descent.

It builds a real memory in a temporary directory over a synthetic 256-message chat with 12 planted facts. A rule-based summariser drops values and, at greater depth, topics. A fake judge scores word overlap.

For each strategy, the report shows probes found, agent steps, judge calls, zoom calls, and bytes returned. It also includes a per-fact table by age. `--seed` selects the seed, and `--out` writes a JSON artifact. The comparison makes no provider calls. It measures navigation mechanics, not real summaries or Jev.

The 0.7.0 results are in `.scratch/optchat-jev/issues/10-codemode-retrieval.md`. Every summary-navigating strategy found only facts whose topics survived in the view: 3/12 and 5/12 over two seeds. `chat_search` found 12/12. `chat_recall` reached surviving facts in one agent step instead of about 200 zoom calls.

### Experiment options

`--arms on,off` pairs OptChat with plain OMP over the same corpus and questions. The off arm resumes a seeded session with OptChat disabled. It receives no memory tools, and its prompt never mentions them. Native compaction may run inside that session.

Off-arm maintenance uses the same estimate as on-arm maintenance, based on captured compaction frames. A paired delta requires both arms to complete every requested scenario and both totals to be observed. The artifact claims no savings.

`--compressors a/b,c/d` runs one on-arm unit per compressor. The report compares the paired arms separately for each compressor.

`--turn-mode per-question` sends one question per prompt and records each turn's latency and usage. The default, `batch`, sends all questions in one prompt.

`--experiments child` runs the child-memory experiment. The parent delegates each question to a `task` child, once with the saved view and once without it. Grading uses only the child's delegated output.

### Spend limits

Spend has two ceilings:

- `--max-cost-usd` accepts values above 0 and at most 30. It sets a worst-case dollar ceiling. Each prompt and compressor call must fit its model's worst-case bound before dispatch. Unknown model rates or context windows block admission.
- `--max-calls` defaults to 80 and accepts at most 2000. It caps total provider calls. At the cap or deadline, remaining work is refused and reported, not silently dropped.

Without `--max-cost-usd`, only call and deadline limits apply.

The dollar bound prices input by UTF-8 bytes, not tokens. A prompt's tokens never exceed its bytes, so the runner needs no tokenizer. A main prompt's byte count includes:

- The measured effective system prompt and OptChat block.
- A 32 KiB tool-schema allowance.
- The view for the on arm, or seeded history for the off arm, plus prior turns.
- Four 16 KiB zoom pages and the question.

The runner clamps tokens to the context window and prices them at the highest input-side rate. Output uses the pinned `--max-main-output` cap, default 4096 and at most 32000. The runner writes this cap as `maxTokens` for each main model into the isolated agent directory's `models.yml`. It never writes the source configuration. It multiplies the bound by the prompt's four worst-case calls, not by the number of prompts.

Each on-arm compressor host reserves `--compressor-share` of the uncommitted cap as its allowance. The default share is 0.5. A main prompt is admitted only if observed spend, live host allowances, and the prompt bound together stay within the cap. When a host stops, its observed compressor spend replaces its allowance.

An off-arm prompt also adds a native-compaction bound over seeded history, prior turns, and the question, at the pinned cap. Compressor calls use the compactor's prompt bytes and compressor output cap. An unknown rate, unknown context window, or unmeasured system prompt causes refusal. The plan prints the per-prompt main bound, compressor per-call bound, and host allowance.

After each prompt, the runner charges observed spend once: exact auxiliary costs and maintenance's high bound. It does not charge unobserved bounds. `limits.spentUsd` is this running high-bound total.

A dispatched child task with no observable child cost leaves spend unobserved and blocks further live work. Refused, incomplete, and not-delegated children add no child cost.

`--main-context-window` accepts an integer from 32000 through the main model's catalog context window. The runner rejects larger values. It overrides only that model's `contextWindow` in the isolated agent directory's `models.yml`. Source configuration and other models remain unchanged.

Without this option, the requested override is `null`, and the main model inherits its catalog context window. The artifact records the requested override in `models.mainContextWindow`. It also records the effective main-model context window used by the run.

The bound has these limits:

- The four-call prompt limit is not an enforced tool-loop cap.
- The output cap relies on the pinned `models.yml` entry. Built-in catalog models were checked through `omp models --json`. The offline fixture provider ignores this cap.
- On-arm compaction of the main session is observed but not bounded in advance. OptChat's marker compactions make no model call.

Before each prompt, the runner waits for memory to settle while compressor calls, dispatches, or tree growth continue to progress. The run deadline still applies: `--deadline-ms`, at most 30 minutes. The runner reports a stall after 120 s without progress.

A completed compressor call holds its observed cost against the host's dollar allowance. Only in-flight calls hold their worst-case cost. Admissions refused by either ceiling are counted and reported. A refused admission fails that summary, after which OptChat refuses the next turn.

### Fixture provider and credential isolation

`--fixture-provider` selects the loopback `optchat-smoke/*` models, priced at zero. The whole pipeline then runs without provider calls or credentials, including both arms, compressors, and the child experiment. This option tests the runner and requires `optchat-smoke/*` selectors. It is mutually exclusive with `--confirm-live-provider-calls`.

`tests/evidence-benchmark.test.ts` exercises the fixture pipeline end to end. It skips if no `omp` executable is found. Set `OPTCHAT_EVIDENCE_OMP` to select one.

Before copying credentials or starting host discovery, the runner parses the source agent directory's `models.yml`, `models.yaml`, and legacy `models.json` (JSONC). Any selected provider entry blocks the run. Copying its credential without its routing could send the credential to a different endpoint.

Read failures, parse errors, and invalid root or provider-map shapes also block the run. Diagnostics do not expose configuration contents. This check deliberately includes shadowed files rather than following OMP's first-file precedence. Unrelated provider entries are allowed. Source configuration is never migrated, evaluated, or copied.

### Smoke harness

The smoke harness links the plugin into a fresh, isolated host environment. It exercises automatic discovery and activation without `--optchat` or an explicit plugin extension path. It uses the actual OMP host with a local deterministic model endpoint and captures inference requests.

The harness checks:

- Fresh turns.
- Shared main/compactor prompt and tools.
- The dash ruler and lossless retrieval.
- Saved-view stability and restart persistence.

Separate opt-out processes check that ordinary history stays intact, no memory store or tools appear, and no compressor requests occur. They include both orders of the positive and negative flags.

Set `OPTCHAT_SMOKE_OMP` to a compiled OMP executable and `OPTCHAT_SMOKE_PLUGIN` to an installed plugin directory to check that artifact instead of the checkout. This is not a measurement of summary quality or real-provider cache hit rates.

The 0.4.0 release was exercised on compiled OMP 18.9.0. Beyond the checks above, the smoke covered:

- A `/btw` side turn followed by an ordinary prompt.
- A 54 KB structured async report.
- Two images retrieved after restart.
- `work` retrieval after restart.
- A real `task` child that reads the parent view without writing.

A deterministic restart probe reopened a fully built 200-message chat. It made no compressor calls and left all 397 nodes unchanged. One new message cost one call.

### 0.5.0 measurements

Paired runs on OMP 18.9.1 used Claude Sonnet 5.5 as the main model and Claude Haiku 5.5 as the compressor. They used per-question turns and adversarial questions: multi-step and reverted corrections, late distractors, near-duplicate names, and an unanswerable fact. Each run asked 8 questions.

"On" means OptChat. "Off" means plain OMP resuming a session with the same records as ordinary messages. Costs are provider-reported. Compressor cost includes building the memory. These are small samples, n = 3 per setting, not savings claims.

**History that fits the context window**: 48 records of 4 KB, about 74k tokens, a 64 KB view, and seeds 1–3.

| Arm | Correct | Grounded | Main cost | Compressor cost | Main prompt tokens | Main cache-read share |
|---|---|---|---|---|---|---|
| On | 24/24 | 24/24 | $0.41–0.43 | $0.04–0.09 | ~218k | 56–57% |
| Off | 24/24 | 24/24 | $0.32 | — | ~539k | 88% |

When everything fits, OptChat costs about $0.13–0.20 more per run. The main model reads 60% fewer prompt tokens. However, each turn's fresh view is written to the cache instead of read from it. Zooming also adds a round trip per question.

**History past the context window** used these settings:

- 160 records of 4 KB, about 650 KB.
- A main model pinned to a 200k window with `--main-context-window`.
- A 128 KB view.
- One plain-OMP compaction in every off run.

| Seed | On: correct / grounded | On: total cost | Off: correct value / grounded | Off: total cost |
|---|---|---|---|---|
| 1 | 8/8, 8/8 | $1.13 | 1/8, 1/8 (7 abstained) | $0.05–0.55 |
| 2 | 8/8, 8/8 | $1.10 | 7/8, 7/8 | $0.06–0.56 |
| 3 | 8/8, 8/8 | $1.18 | 8/8, 2/8 | $0.05–0.55 |

Seed 3's on arm comes from a separate on-only run, `long-s3-on`, after the runner's settle wait was fixed. Its paired run stopped while the build still progressed.

Off-arm cost is an interval because OMP 18.9.1 reported `tokensBefore: 0` for compactions. The high bound bills the whole 200k window at the input rate. After compaction, plain OMP sometimes names the right value but can no longer quote the original record. In one of three seeds, it abstained on most questions. OptChat answered every question correctly with an exact quote, at roughly twice the cost of the worst off-arm case.

**Compressors**, using a 48-record build and seed 4:

- Haiku 5.5 needed 103 calls, including 17 shortening retries. It cost $0.034 and 211 s of summed call time. The run then answered 8/8.
- Haiku 4.5 needed 303 calls, including 230 shortening retries because it overshoots the byte limit. It cost $0.76 and 961 s. It had not settled when the run stopped.

**Subagent memory** used `--experiments child`, 24 records, and 4 delegated tasks per arm. With `--optchat-child-view`, children answered 4/4 correctly after 2–4 `zoom` calls each, for $0.20 total child cost. Without it, children answered 0/4 and said the facts were unavailable to them. Child cost was $0.09.

**Refusals:** Claude 5.x models sometimes reject benign summarization requests with `Refusal (bio)`. An early corpus used word-list padding, including replica, vector, probe, and drift. It triggered refusals on most long prompts. Natural-prose padding reduced this to about 1 in 100 compressor calls. The refusal fallback described above lets memory settle when this occurs.

### 0.4.0 measurements

A bounded `evidence:recall` run used real models and a synthetic 24-source corpus. Claude Sonnet 4.6 handled the main chat, and Claude Haiku 4.5 handled compression. The run included a cold phase and a fresh-process restart phase. The deepest summary level was 5 in the cold phase and 6 after restart.

| Phase | Correct | Grounded in a zoomed original | Hallucinated | Main cache-read share | Compressor cache-read share | Cost (USD) |
|---|---|---|---|---|---|---|
| Cold | 8/8 | 8/8 | 0 | 76% | 46% | 0.30 |
| Restart | 7/8 | 8/8 | 0 | 86% | 53% | 0.46 |

The one miss named only part of an ambiguous answer. "Cache-read share" is cache-read tokens divided by all prompt tokens, as reported by the provider. This short run starts cold and writes most prefixes for the first time. It is therefore far from the specification's steady-state 96–98% model. It is a sample, not a savings measurement.

The 0.2.0 release was exercised with compiled OMP 18.8.9 against the synthetic provider. A separate real-filesystem run ingested 300 synthetic messages. It observed the 128,000-to-64,000-byte main batch and 32,000-to-16,000-byte compactor cycle. It also checked byte-identical saved views on restart and migration from a log without a snapshot.

The initial release was exercised with compiled OMP 18.6.1 and an authenticated `@smol` model. A long synthetic note compressed to 185 bytes. A new process correctly recalled its canary name/color. Fresh-process discovery after `omp plugin link .` was verified without an explicit extension path.

The HTML export was checked in Chromium at desktop and 375-pixel mobile widths. Checks included navigation and escaped script text. These checks do not establish real-provider cache hit rates.

## Planning and specs

The System One plan is in this repository. Start with `AGENTS.md` for working instructions and verification commands. The living ExecPlan, `plans/optchat-jev.md`, records progress, decisions, and open items. The design is in `docs/design/optchat-jev.md`. Project skills, including Wayfinder, ExecPlan, and grilling, load from `.omp/skills/`.

## Attribution

Design and compression prompt: Victor Taelin, [UniiChat / OptChat — how to replicate my setup](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). The source was revised October 8 and retrieved October 11, 2026. This project is an independent OMP adaptation, not an official upstream release.
