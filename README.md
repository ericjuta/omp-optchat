# OMP OptChat

An OMP extension implementing [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one durable chat, a binary tree of contextual summaries, and a fresh model context for each user turn. Original text remains retrievable with `zoom`; summaries are navigation, not a replacement for the log.

## Requirements and start

- OMP **18.6.1 or newer**, Bun, and Linux.
- An authenticated model for the main chat and an authenticated compressor model. Compression uses OMP's `@smol` role by default; choose a competent inexpensive model explicitly if that role is unsuitable.

Install the tagged release:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-optchat.git#v0.3.0'
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

Subagents do not open the main chat. Run just one enabled session per chat directory. To select a different memory or compressor:

```sh
PI_OPENAI_STATEFUL=0 omp -e . --optchat-dir /path/to/private/chat --optchat-model anthropic/claude-sonnet-4-6
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
  view.json               # {version,length,parts:[[l,i],...],compacting}
```

Records are appended and fsynced before publication; replay also fsyncs recovered files before admitting them. Daily filenames use the local day of writing, while each record retains its original timestamp, including imported historical dates. IDs are permanent. Malformed/torn lines are reported; missing IDs or conflicting records are not silently renumbered. The tree can be rebuilt conceptually, but existing summaries are retained to avoid paying twice.

The main view is atomically replaced and fsynced before a new tiling is published. Its versioned envelope preserves an unfinished compaction batch as well as the ordered node coordinates. Restarts load that exact tiling instead of reconstructing it. After a crash, durable messages beyond the saved view are appended to its existing prefix. A pre-0.2.0 chat without `view.json` is migrated once; malformed or inconsistent snapshots fail closed rather than silently rebuilding a different view.

The summary target is 512 UTF-8 bytes. The main view grows by appending leaves until its summary text exceeds 128,000 bytes, then merges a batch down to 64,000 bytes. Merge priority measures age from the sibling pair's **last** message, with oldest-first ties. Only built parents can be used; an unfinished batch remains active across subsequent node completions, messages, and restarts. The view never splits.

The compressor has its own 16,000–32,000-byte sawtooth view, coarsened from the main view and refreshed when the main view merges. It contains only built, addressed summary lines before the target message, or through the end of a target merge—never later messages. Compression instructions use a 512-dash ruler rather than example content. Sizes govern summary text, not token estimates or provider-envelope overhead.

Short records and child pairs that already fit are free nodes. Longer records are summarized whole. OMP retains eight concurrent compaction jobs, five shortening attempts, fixed ten-second retries, and serial leaf construction with concurrent ready merges; this release does not replace that scheduler with upstream's newer ready queues.

A model turn waits for summaries rather than seeing partial source text. Compression failures are reported and retried. Cancel a wait if the provider is unavailable; history already accepted by the plugin is retained. Reasoning/thinking is not written to the OptChat log. Ordinary tool-result text is head-and-tail capped at 30,000 characters; full `zoom` retrieval is exempt so original messages remain accessible.

## OMP-specific boundaries

- OMP caps extension context handlers at 30 seconds. OptChat therefore cancels a turn if memory has not settled within 25 seconds, before the host could ignore a timed-out hook. The unanswered user message stays in the log, and compression continues; send the request again after memory is ready. It never substitutes raw old history or half a summary.
- The extension preserves OMP's system instructions, tool policy, display, and in-turn reasoning rather than replacing the harness. It does not change your delegation policy or create its own subagent system.
- Activation does not change host settings or replace the Sharpshooter memory backend. OptChat vetoes normal automatic/manual compaction and experimental rollover, but this is not a blanket maintenance disable: OMP can still check raw-history thresholds, and automatic shake pruning can bypass that hook. This release does not change those host maintenance settings.
- The storage format is textual. Do not treat it as an archive of image/audio binary attachments.
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

The smoke harness links the plugin into an isolated fresh host environment, then exercises automatic discovery and activation without `--optchat` or an explicit plugin extension path. It uses the actual OMP host with a local deterministic model endpoint, captures inference requests, and checks fresh turns, shared main/compactor prompt and tools, the dash ruler, lossless retrieval, saved-view stability, and restart persistence. Separate opt-out processes prove ordinary history remains intact, no memory store or tools are created, and no compressor requests occur, including both positive/negative flag orders. Set `OPTCHAT_SMOKE_OMP` to a compiled OMP executable and `OPTCHAT_SMOKE_PLUGIN` to an installed plugin directory to verify that artifact rather than the checkout. It is not a measurement of summary quality or real-provider cache hit rates.

The 0.2.0 release was exercised with compiled OMP 18.8.9 against the synthetic provider. A separate real-filesystem run ingested 300 synthetic messages, observed the 128,000-to-64,000-byte main batch and 32,000-to-16,000-byte compactor cycle, and checked byte-identical saved views on restart plus migration from a log without a snapshot.

The initial release was also exercised with the compiled OMP 18.6.1 binary and an authenticated `@smol` model: a long synthetic note was compressed to 185 bytes and its canary name/color were recalled correctly in a new process. Fresh-process discovery after `omp plugin link .` was verified without an explicit extension path. The HTML export was checked in Chromium at desktop and 375-pixel mobile widths, including navigation and escaped script text. These checks do not establish real-provider cache hit rates.

## Attribution

Design and compression prompt: Victor Taelin, [UniiChat / OptChat — how to replicate my setup](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), revised October 8 and retrieved October 11, 2026. This project is an independent OMP adaptation, not an official upstream release.
