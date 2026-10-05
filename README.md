# OMP OptChat

An OMP extension implementing [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one durable chat, a binary tree of contextual summaries, and a fresh model context for each user turn. Original text remains retrievable with `zoom`; summaries are navigation, not a replacement for the log.

## Requirements and start

- OMP **18.6.1 or newer**, Bun, and Linux.
- An authenticated model for the main chat and an authenticated compressor model. Compression uses OMP's `@smol` role by default; choose a competent inexpensive model explicitly if that role is unsuitable.

Install the tagged release:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-optchat.git#v0.1.0'
PI_OPENAI_STATEFUL=0 omp --optchat
```

From this checkout:

```sh
bun install --frozen-lockfile
PI_OPENAI_STATEFUL=0 omp -e . --optchat
```

Or install the local plugin once:

```sh
omp plugin link .
PI_OPENAI_STATEFUL=0 omp --optchat
```

Discovery alone does **not** enable OptChat. Only `--optchat` activates it: ordinary sessions gain the flags and `/optchat` command, but no memory tools, logging, or context changes. Subagents do not open the main chat. Run just one enabled session per chat directory. To select a different memory or compressor:

```sh
PI_OPENAI_STATEFUL=0 omp -e . --optchat --optchat-dir /path/to/private/chat --optchat-model anthropic/claude-sonnet-4-6
```

The default chat lives in `optchat/` under OMP's active agent directory. Working-directory changes and OMP session restarts do not start a new memory; a different `--optchat-dir` does. The extension does not import existing OMP sessions automatically.

Advanced overrides are `--optchat-node-bytes`, `--optchat-view-bytes`, `--optchat-jobs`, `--optchat-tries`, `--optchat-retry-ms`, and `--optchat-tool-cap`; their defaults are described below. Keep the defaults unless you have measured a reason to change them. An enabled session refuses inference if `zoom` or `date` is unavailable, including host modes that prohibit late tool registration.

## Using memory

The model receives the settled historical summary view before your new message, then retains its ordinary tool loop until the turn ends. Between turns, old inference history is replaced by the view. OMP's display transcript and normal tools remain available.

- `zoom(id, n)` opens an aligned power-of-two summary range into its children. `zoom(id, 1)` returns the original record in full.
- `date(id)` returns the original message's local date and time.
- `/optchat status` reports memory and background compression state.
- `/optchat view` displays the current view.
- `/optchat export /path/to/history.html` creates a self-contained, navigable HTML history (treat it as private).
- `/optchat import /path/to/history.txt` imports plain text as a note. JSONL accepts `{ "kind": "note", "text": "…", "date": "2026-10-05T00:00:00.000Z" }`; kinds are `user`, `talk`, `tool`, `echo`, and `note`. Import is append-only, not an OMP transcript converter.

## Storage and compression

```text
chat/
  main/YYYY-MM-DD.jsonl   # {i,kind,text,size,date}
  tree/YYYY-MM-DD.jsonl   # {l,i,text,size}
```

Records are appended and fsynced before publication; replay also fsyncs recovered files before admitting them. Daily filenames use the local day of writing, while each record retains its original timestamp, including imported historical dates. IDs are permanent. Malformed/torn lines are reported; missing IDs or conflicting records are not silently renumbered. The tree can be rebuilt conceptually, but existing summaries are retained to avoid paying twice.

Defaults follow the specification: 512-byte summary target, 128,000-byte view budget, eight compaction jobs, five shortening attempts, and fixed ten-second retries. Short records and child pairs that already fit are free nodes. Longer records are summarized whole, with the preceding summarized context. Leaf summaries are built in order; ready merges run alongside. The incremental view only appends and merges the most-due available sibling pair, never splits. UTF-8 sizes—not token estimates—govern compression.

A model turn waits for summaries rather than seeing partial source text. Compression failures are reported and retried. Cancel a wait if the provider is unavailable; history already accepted by the plugin is retained. Reasoning/thinking is not written to the OptChat log. Ordinary tool-result text is head-and-tail capped at 30,000 characters; full `zoom` retrieval is exempt so original messages remain accessible.

## OMP-specific boundaries

- OMP caps extension context handlers at 30 seconds. OptChat therefore cancels a turn if memory has not settled within 25 seconds, before the host could ignore a timed-out hook. The unanswered user message stays in the log, and compression continues; send the request again after memory is ready. It never substitutes raw old history or half a summary.
- The extension preserves OMP's system instructions, tool policy, display, and in-turn reasoning rather than replacing the harness. It does not change your delegation policy or create its own subagent system.
- The storage format is textual. Do not treat it as an archive of image/audio binary attachments.
- Permanent storage uses fsync, not automatic Git commits. Backups remain the operator's responsibility.

### Provider caching

For native official Anthropic requests, the plugin places up to three stable view breakpoints at line ends before 50k/80k/100k characters and retains a request-end marker, with at most four five-minute cache markers total. Official OpenAI Responses models with the host's explicit-breakpoint capability receive their native view markers. Supported official Codex requests retain reasoning across turns of an active tool loop using `all_turns`.

Gateways and unsupported transports (including OpenRouter, Azure, Bedrock, Vertex, Foundry, custom endpoints, and pi-native) keep the host's existing cache behavior. No renewal requests are sent. Wire-level marker tests are not proof of cache hits or savings on a real provider.

**Use `PI_OPENAI_STATEFUL=0` as shown above for the specification's stateless `store:false` OpenAI requests.** OMP otherwise defaults to stateful official OpenAI Responses. A plugin cannot change the host's main-request options; deleting a response ID or changing retention mid-chain would lose context. With stateful mode left enabled, fresh turns still replace the prefix, but in-turn continuation requests keep the host's chain and receive no extra view markers. The compressor is already stateless. An explicit host caching-off setting is respected where exposed (`PI_CACHE_RETENTION=none` for OpenAI).

## Privacy and operation

**This is permanent local history, not a secret scrubber.** User text, public assistant replies, tool arguments, and tool-result text may contain secrets. The compressor receives historical content through your configured provider. Do not use it for material you cannot retain or send there. OMP may independently persist its own sessions and diagnostics; `--no-session` controls OMP session files, not the OptChat log.

Keep the memory directory private and back it up. The extension never commits or publishes it. HTML exports contain the original log. No telemetry or external storage service is added. Stop the enabled session before restoring backups or copying a consistent pair of log/tree streams.

The Linux lock uses an OS-owned abstract Unix socket keyed by the directory's filesystem identity, avoiding PID-age guesses and stale-file unlink races. A second writer in the same network namespace fails; process death releases the lock. Filesystem operations stay anchored to held directory descriptors through `/proc/self/fd`, even if a path is renamed. Linux procfs and a local fsync-capable filesystem are required; containers in different network namespaces must not share a writable chat. Other operating systems are not supported by this release.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run smoke
```

The smoke harness exercises the actual OMP host with a local deterministic model endpoint, captures inference requests, and checks fresh turns, tool retrieval, compression, and restart persistence. It is not a measurement of summary quality or real-provider cache hit rates.

The initial release was also exercised with the compiled OMP 18.6.1 binary and an authenticated `@smol` model: a long synthetic note was compressed to 185 bytes and its canary name/color were recalled correctly in a new process. Fresh-process discovery after `omp plugin link .` was verified without an explicit extension path. The HTML export was checked in Chromium at desktop and 375-pixel mobile widths, including navigation and escaped script text. These checks do not establish real-provider cache hit rates.

## Attribution

Design and compression prompt: Victor Taelin, [OptChat — how to replicate my setup](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), retrieved October 5, 2026. This project is an independent OMP adaptation, not an official OptChat release.
