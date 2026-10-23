---
name: verify-store-lease
description: Check OptChat's store writer lease (one writer per store directory, every write made under it) with a TLA+ model and real-process tests against src/store.ts. Use when a change touches the lease, Store.open/close/archive, Store.sidecarPath, /optchat new, or how the rules ledger and metrics are written, or when asked whether the single-writer lock holds.
---

## What it verifies

**Promise.** Cooperating `Store` writers sharing the lease namespace cannot both hold the same directory inode's lease. Store recovery and content writes start only after acquisition; a conflicting opener gets `StoreLeaseConflictError("Store is already open by another writer")` without changing the held store's contents. This is not a promise of zero filesystem effects before acquisition: `openRoot` may create ancestors/root and fsync the parent. The lease is not an access-control barrier against external writers. `/optchat new` holds the lease through its checked rename; an external pathname replacement between the identity check and rename remains outside the guarantee.

**Harm if it breaks.** Two sessions append to one history and give out the same message ids (replay refuses duplicate ids, `tests/store.test.ts:358-368` "identical duplicate message", so the chat then fails to open), or one session's rules, metrics or archive land in another session's chat.

The lease is a kernel object bound to the directory's inode: an abstract Unix socket named `omp-optchat-sha256(dev:ino)` on Linux (`acquireLease`, `src/store.ts:402-440`), a `flock` on the root descriptor on macOS (406). Death of the process frees it; there is no lock file, pid, or timeout.

## Run it

```sh
bun run verify:lease                 # model, then real code: about 15 s (model 13 s, real code 2 s)
bun run verify:lease --traces        # also print each counterexample
bun run verify:lease --real-only     # real code only, 2 s
bun run verify:lease --model-only    # TLC only
bun run verify:lease --model-only --deep  # also the five guarantees with three sessions: about 5.5 minutes, 6 GB per TLC
bun run verify:lease --strict        # exit 2 while a finding is still open
```

Exit 0: every guarantee holds, every break is caught, every recorded finding still reproduces. Exit 1: a guarantee broke, a break went uncaught, a check could not run, or a recorded finding stopped reproducing. Run from the repository root; it writes only under `.verify/` (gitignored) and `$TMPDIR`.

Toolchain, all found by `scripts/verify-store-lease/model.ts`: Java from `$JAVA` (path to the binary), else `mise where java@temurin-21.0.12+8.0.LTS`, else `java` on PATH. TLA+ tools v1.7.4 (TLC 2.19) from `$TLA2TOOLS_JAR`, else `~/.local/share/tlaplus/1.7.4/tla2tools.jar`; when the jar is missing it is fetched from `https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar` and checked against sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. A jar with another hash is refused.

## Reading the output

Each line has a role and a status.

| Role | Meaning | ok means | Otherwise |
|---|---|---|---|
| `guarantee` | holds on the current code | it held | `FAIL`: a bug in the code, or drift (below) |
| `broken` | a deliberately broken model variant, or a copy of `src/store.ts` with one edit | the check caught it | `FAIL`: the check is blind to that break |
| `fixed` | the model of a proposed fix | the property holds | `FAIL`: the fix does not fix it |
| `finding` | a property the current code violates | `FINDING`: it reproduced, as recorded | `GONE`: the code was fixed, so update this skill |

There are no `finding` or `fixed` rows in the recorded suite (the harness keeps both roles for the next one). Historical result at the sync commit below: 32 ok, 0 open findings, 0 failed, and `--strict` exited 0. For this documentation audit, the parent separately reports strict job `bg39` PASS: 32 ok, 0 open findings, 0 failed, 16.7 s, including model invariants, real-process guarantees and mutants. This task did not execute or rerun that check; the parent-supplied run is not yet bound to a product commit. It does not refresh the historical deep or scratch-break evidence.

What each guarantee says, in the order the output lists them:

- `ExclusiveOpen` / `race-one-winner`: two sessions never both have the same directory open. The harness races six processes, 20 rounds, through the path and through a symlink to it.
- `StoreWritesUnderLease` / `rejected-opener-changes-nothing`: store contents are not repaired or written before acquisition (root/ancestor preparation precedes it). The harness leaves a torn log tail, an orphan temp file and an unreferenced blob in a held directory; three rejected opens change none of them, and the successful open afterwards does (the control that proves the check can see a change).
- `NoOrphanLease` / `sigkill-frees-lease`, `failed-open-releases-lease`, `close-releases-and-fences`: a dead, failed or closed session never blocks the next opener, and a closed `Store` refuses writes.
- `ArchiveOnlyClosed` / `archive-holds-the-lease`, `archive-refuses-a-displaced-path` (F1, fixed): `/optchat new` retains ownership through rename and refuses a pathname already displaced at the identity check (the external check-to-rename race is not covered). At the rename itself a second process's `Store.open` gets the conflict error (a hook on `renameSync` runs the opener); afterwards a fresh store opens at the path, the archive reopens with the old message, and no descriptor into the archive stays open. When the path was displaced (a user `mv`, then another session opens a store at the old path), the archive renames nothing, the other store keeps writing, and the archiving session's lease is released.
- `SidecarWritesUnderLease` / `sidecar-writes-follow-the-inode`, `closed-store-has-no-sidecar` (F2, fixed): on the exercised Linux path, the rules ledger and default metrics file land in the directory their writer holds the lease of, also after that directory is moved and another store sits at the old path. A closed store gives out no sidecar path, even when another store in its process holds its old descriptor number.

## Fixed findings

Both were found by this check at `687d0f9` (its first run) and are fixed in `ff05706`; the old behavior stays as broken variants (`ArchiveAfterRelease`, `SidecarByPath`) that must still be caught.

**F1: `/optchat new` could rename a store another session had open.** At 687d0f9, `shutdown()` closed the store and released the lease, then `archiveStoreDirectory(directory)` renamed the path holding nothing; a session that opened the directory in between lost its live store to the archive. Now `Store.archive` (`store.ts:1133-1179`) keeps rootFd and the lease through the rename, renames only while `statSync(this.directory)` and `fstatSync(rootFd)` give the same dev:ino (1148-1157), and releases both once (1163), on success or failure. Since `b37c5da` a descriptor or lease close error after a successful rename is a warning naming the archive, and the archive path is still returned (1171-1178); `release` still runs once and still closes the descriptors before the lease (464-473), so the lease steps are unchanged. `OptChat.shutdown(archiveAt)` (`index.ts:1760-1786`) calls it for `/optchat new` (1807). Residual: a user `mv` between the stat and the rename (rename takes a pathname) is not prevented; the doc comment says so.

**F2: the rules ledger and the metrics file were written by pathname.** At 687d0f9, `RuleLedger.write` opened `join(store.directory, "ledger.jsonl")` and `appendMetric` `join(store.directory, "metrics.jsonl")` on every write, so after the directory was displaced they wrote into whichever store was at that path. Now `Store.sidecarPath(name)` (`store.ts:1116-1122`) runs `assertWritable` and returns `at(rootFd, name)`; `RuleLedger.open(() => store.sidecarPath(LEDGER_FILE))` (`index.ts:764`; `system1/ledger.ts:66-71, 114-121, 149-164`) and `metricsFile(store)` (`index.ts:979-992, 2234-2236`) resolve per write. The default sink is omitted without a resolver warning when the store is absent or refuses `sidecarPath`; observation still runs, including the compressor usage callback (`index.ts:979-992, 2237-2244`). A truthy `OPTCHAT_METRICS_FILE`, captured at factory setup, bypasses `sidecarPath` and is outside this store-directory lease guarantee. Returned sidecar paths are valid only for immediate synchronous use, not storage across an await or close.

## What the model is, and how it maps to code

`scripts/verify-store-lease/StoreLease.tla` (TLA+, checked by TLC). Actions abstract acquisition, recovery, writes and release; not every action is one syscall. Recovery and cleanup group synchronous operations, and the archive identity check plus rename are explicitly abstracted despite their external-move race. Action comments supply explanatory citations for counterexamples, but model-internal citations are outside this documentation-only refresh; use the current mappings below when reading them.

| Action | Code | Abstraction / ordering |
|---|---|---|
| `Mkdir`, `OpenRootFd`, `FdPath` | `openRoot` 361-370, `makeDirectory` 331-338, `fdPath` 300-302, `Store.open` 801-806 | root preparation includes mkdir/fsync before acquisition; Linux descriptor-relative resolution anchors subsequent operations, not a literal Node `openat` call |
| `Acquire` | `acquireLease` 402-440 | one kernel `bind` (`server.listen`, 437) or `flock` (406) |
| `Recover`, `StoreWrite` | `Store.open` stream setup 807-820, `replay` torn-line repair 927-932, `collectGarbage` 722-759, `assertWritable` 832-840, appends | synchronous fd-relative writes after the lease |
| `LedgerOpen`, `SidecarWrite` | `index.ts:764`, `system1/ledger.ts:149-164`, `index.ts:979-992`, `metrics.ts:138-147`, `Store.sidecarPath` 1116-1122 | immediate synchronous resolver/open/write sequence for default sinks; metrics may use multiple writes and need not have a rules ledger open |
| `OpenFails` | `Store.open` catch 822-829, `index.ts:770-773` | `release` closes descriptors, then the lease |
| `Shutdown`, `Release` | `index.ts:1760-1786`, `store.ts:1185-1190, 464-473` | shutdown drains queued work and closes the ledger before store teardown; `Store.close()` fences writes synchronously, closes descriptors, then awaits socket closure |
| `ArchiveHeld`, `ReleaseArchived` | `Store.archive`/`archiveHeld` 1133-1179 (release 1163), `moveToArchive` 665-693 | the dev:ino check and the rename are two syscalls (residual race, not modelled); the final release is one step whether or not a close error follows the rename (a post-rename cleanup error warns but still returns the archive, 1171-1178) |
| `Crash`, `Restart` | `store.ts:435-436`, the module doc 763-765 | the kernel frees sockets and descriptors on death |
| `MoveRoot` | doc comment 766-769, `tests/store.test.ts:1255-1266, 1528-1529` | a user `mv` of an open store directory |

Variants of `Variant`: `Current`; broken: `NoLease`, `PathKey`, `WriteBeforeLease`, `NoCrashRelease`, `LeakOnFailedOpen`, `ArchiveAfterRelease` (the pre-fix F1 order), `ArchiveNoInodeCheck`, `SidecarByPath` (the pre-fix F2). Each broken variant must violate exactly the property it names, and `model.ts` lists the pairs.

The model does not read the code. The real-process harness exercises selected behaviors and deliberately broken copies of `src/store.ts`; it does not detect every possible source change. The model only changes when someone updates it. That is why the update procedure below is not optional.

## Bounds and assumptions

- Default run: two sessions (`Procs = {p1, p2}`), three directory inodes (`Inodes`), two spellings of the path (`"D"` and a symlink `"L"`), user `mv` on. The five `current/*` guarantees each explore 70,553 distinct states in 4-5 s; the largest run is `broken-ArchiveNoInodeCheck` at 17,461.
- `--deep`: the same five guarantees with three sessions (`Procs = {p1, p2, p3}`, same inodes, spellings, `ExternalMove = TRUE`), ids `current3/<Invariant>`. Measured on the 8-core, 61 GB workstation with Temurin 21.0.12, TLC 2.19, one TLC worker per case: each case explores 4,098,579 distinct states (34,603,933 generated, depth 41) and takes 146-201 s when four run at once (148 s alone), 334 s wall for the five at `CONCURRENCY` 4 (two waves). A lone case peaked at 5.8 GB resident (the JVM takes up to a quarter of RAM as heap; a smaller host makes TLC spill to disk and slow down), so four at once want about 24 GB. That is over the three-minute budget of the default run, so three sessions are checked only with `--deep`. All five hold: no three-session violation (2026-10-21, at the sync commit below). `--deep` needs the model, so it cannot be combined with `--real-only`.
- Run `--deep` when you change `StoreLease.tla` or what an action does, or before a release that touches the lease; it is not in CI.
- One store path. Distinct directory inodes have independent leases; shared external metric overrides and cross-directory behavior are not modelled. This includes the fallback in `OptChat.open` (`index.ts:735-757`, since `b37c5da`): a non-git session without `--optchat-dir` whose `Store.open` of the global store gets `StoreLeaseConflictError` (737) opens `optchat-dirs/<name>-<sha16>` of its cwd instead (750), a different directory with its own `dev:ino` lease. At the global store that session is a rejected opener (`OpenFails` before any write); at the fallback directory it is an ordinary opener of another store path.
- Linux and macOS leases are the same action (`Acquire`). The model cannot tell them apart; only the Linux lease runs here. Linux writers must share a network namespace (`store.ts:436`).
- The real-process harness runs only against this machine's platform and filesystem (local, private POSIX permissions); the archive probe reads `/proc/self/fd` on Linux, or `/dev/fd` plus `fdPath` on macOS (`scripts/verify-store-lease/child.ts:82-90`); that portability branch is not macOS execution evidence.

## Not covered

- macOS `flock` (`src/store.ts:403-415`) was inspected statically, not exercised here. macOS `descriptorPath` uses `F_GETPATH` pathname resolution (`src/store.ts:309-315`), not Linux procfs inode magic links; an external move between resolution and use is not excluded by this Linux proof.
- Lease loss while open (`assertWritable`, 832-840, checks `server.listening`): the model has no event that closes a server under a live store.
- A user `mv` between `Store.archive`'s dev:ino check and its rename (`store.ts:1148-1158`): two syscalls, a pathname rename; named in the doc comment, not prevented and not modelled.
- Close errors in `release`: neither the model nor the harness injects one. That a close error after a successful rename returns the archive with a warning (`store.ts:1171-1178`) is checked by `tests/store.test.ts:1487-1522` ("a close failure after a successful rename still returns the archive, warns, and frees the path").
- Which directory `OptChat.open` picks (the per-directory fallback, `index.ts:735-757`): checked by `tests/metrics.test.ts:429-486` (held-global fallback and explicit override cases), not by `verify:lease`.
- Which file `index.ts` hands `RuleLedger.open` and `metricsFile`, and how `record` drops a row for a closed store: `verify:lease` drives `store.ts`, `system1/ledger.ts` and `metrics.ts` from a child, not `index.ts`. Related assertions are in `tests/metrics.test.ts:169-183` (default metric routing after a move to an empty replacement directory), `tests/new-chat.test.ts:313-331` (archive refusal with another session at the old path) and `tests/store.test.ts:1382-1562` (archive/sidecar fencing). These are source mappings, not newly executed tests, and do not establish direct integration coverage of late-row suppression.
- Network namespaces, NFS and filesystems without fsync or with unstable inode numbers (the lease key is `dev:ino`).
- Automatic rule withdrawal (`src/index.ts:2105-2116`) calls the existing `RuleLedger.remove`/write path (`src/system1/ledger.ts:99-103, 149-164`); it introduces no separate file writer. Human-authority admission and asynchronous triage/shutdown integration are not proved by the lease harness.
- Content of the logs, replay, compression, the view: only the lease and who writes under it.
- A hostile process that connects to the abstract socket name (`createServer((socket) => socket.destroy())` answers and closes it; only existence matters).
- Interleavings of four or more sessions. Three sessions are checked only by `--deep`; the default run checks two.

## Real bug or model drift?

The real harness runs the real code. A `FAIL` there on a guarantee is a bug in the code, unless its message begins `fixture stopped proving its claim` (a fixture needs updating) or `harness error`.

A `FAIL` or `GONE` from TLC on a `current/*` check: replay the counterexample step by step against the code (the sentences cite lines).

- A step cannot happen in the code, or it does not go as the model says: **model drift**. Fix the model from the code, not from the result, then rerun.
- Every step can happen: **a bug**. Run the matching real check (`--real-only`); it should fail or reproduce the same way. Report it with the counterexample, the harm, and the commit that introduced it, and do not weaken the property.
- The model and the harness disagree (the model says `FINDING`, the harness says `GONE`, or the reverse): one is stale; read the code the finding names and decide.
- `TLC did not finish cleanly`: a toolchain problem; read the quoted TLC error.
- `its anchor now matches N places in src/store.ts`: the break check's one-line edit no longer applies because the lease code moved. Update the anchor in `real.ts`, then confirm the break is still caught.

## Coverage record

Sync commit: `f03d2340d26b82733e90965f53e645592be931a2` (memory provenance, recorded result association, typed coordination and human rule withdrawal; lease transitions unchanged).

**Verification boundary (2026-10-23).** Current source/test references below were mapped by targeted actual-source reads and read-only diffs from the previous sync commit `b37c5da5937ba22f44c476b635238c4036eb9203`. Static inspection found no changed lease acquisition/release, inode-check, or default sidecar-routing transition. The parent ran `bun run verify:lease --strict` on the product sources now committed as `f03d2340d26b82733e90965f53e645592be931a2`: 32 ok, 0 open findings, 0 failed in 16.7 seconds, including model invariants and real-process mutations. Historical deep and scratch-break results remain historical; no new deep run was needed because lease semantics did not change. Model comments and trace strings retain old citations; the current mapping tables below resolve that citation drift. This documentation synchronization is committed separately from the product change.

| File | Diff classification versus previous sync SHA |
|---|---|
| `src/store.ts` | Result/coordination admission and association validation added before replay repair and append; lease transitions unchanged, citations shifted. |
| `src/index.ts` | Diagnostics/cache status, coordination/result capture, human-rule withdrawal and compaction behavior changed; shutdown resets capture maps, while ledger-close/store-close/archive ordering and default sink resolution remain intact. |
| `src/system1/ledger.ts` | Human-authority documentation and `has(id)` added; resolver, write and close protocol unchanged. |
| `src/metrics.ts` | `cut-in-turn` outcome added; `appendMetric` unchanged. |
| `tests/store.test.ts` | Result-association regressions added; cited lease/archive/sidecar assertions unchanged by this diff. |
| `tests/metrics.test.ts` | Compaction cases and withdrawal judge fixtures changed; cited lease-routing/fallback cases unchanged. |
| `tests/new-chat.test.ts` | No diff. |
| `scripts/verify-store-lease/StoreLease.tla` | Comments/trace text updated; no transition or invariant change in the diff. |
| `scripts/verify-store-lease/real.ts` | Citation-comment changes only. |
| `scripts/verify-store-lease/child.ts` | Citation-comment changes only. |
| `scripts/verify-store-lease/model.ts`, `run.ts`, `check.ts` | No diff. |
| `package.json` | Version 0.13.1 → 0.14.0; `verify:lease` command unchanged (line 25). |
| `.gitignore` | Recall-run ignore added; `.verify/` retained (line 5). |

| File | Covered |
|---|---|
| `src/store.ts` | `StoreLeaseConflictError` 87, `fdPath` 300-302, `descriptorPath`/`at` 309-315, `makeDirectory` 331-338, `openRoot` 361-370, `openStream`/`openExistingStream` 372-388, `acquireLease` 402-440, `closeLease` 442-451, `closeDescriptor`/`closeStreams`/`release` 453-473, `moveToArchive` 665-693, `collectGarbage` 722-759, `Store.open` 791-830, `assertWritable` 832-840, `replay` repair 927-932, `sidecarPath` 1116-1122, `archive`/`archiveHeld` 1124-1179, `close` 1185-1190 |
| `src/index.ts` | `open` 722-793 (lease-conflict fallback 735-757), `record` 979-992, `shutdown` 1760-1786, `startNewChat` 1792-1828, `reopen` 1843-1852, `metricsFile` 2234-2236, `session_shutdown` 2287-2289 |
| `src/system1/ledger.ts` | `RuleLedger.open` 66-71, `replay` 114-121, `write` 149-164, the doc comment 47-54 |
| `src/metrics.ts` | `appendMetric` 138-147 |

Files of the verification: `scripts/verify-store-lease/` (`run.ts` the command, `model.ts` TLC, `StoreLease.tla`, `real.ts` and `child.ts` the real-process harness, `check.ts` result types), `package.json` script `verify:lease`, `.gitignore` entry `.verify/`.

## Update procedure

Use this when a change touches covered code, and for `/maintain-formal-verification-skill`.

1. Does the change touch covered code? `git diff b37c5da5937ba22f44c476b635238c4036eb9203 -- src/store.ts src/index.ts src/system1/ledger.ts src/metrics.ts tests/store.test.ts tests/metrics.test.ts tests/new-chat.test.ts scripts/verify-store-lease package.json .gitignore` (use the sync commit above; after you move it, use the new one). Also look for code that moved, and for new code that opens a file in the store directory, or acquires or releases a lease.
2. For an authorized verification run, run `bun run verify:lease` before edits and retain its output. A documentation-only/no-checks assignment instead records static evidence and any separately supplied run attribution; it must not run checks or advance the sync SHA as though it had.
3. Read each change. If it alters a step the model describes (a step now two, a check moved, a new path writes into the store directory), update `StoreLease.tla`, `real.ts` or `child.ts` from the code, not from the result. If the promise changed on purpose, change the property and write the old wording, the new wording and the evidence (doc comment, tests, changelog) in the commit message.
4. Rerun. New or edited covered code needs a proof that the check can still fail: add a model variant or a `MUTANTS` entry in `real.ts` for the new guard, and see it caught.
5. When a finding is fixed: move its property from the `finding` rows to `guarantee` in `model.ts`, turn its `real.ts` probe from `FINDINGS` into `GUARANTEES` (flip the assertion), and keep the old behavior as a broken variant or mutant. (F1 and F2 were closed this way.)
6. Update this skill's line numbers and coverage record, and move the sync commit to the commit you checked only after the verification describes the code at that commit. Put verification changes in their own commit, apart from any product fix.

## Prove it can fail: the scratch break

`bun run verify:lease` already breaks ten copies of `store.ts` (`MUTANTS` in `real.ts`) and requires each to be caught: the four lease breaks (`lease-name-per-process`, `failed-open-keeps-lease`, `gc-before-lease`, `close-keeps-lease`) and six for `Store.archive` and `sidecarPath` (`archive-releases-before-rename`, `archive-leaves-stream-descriptors-open`, `archive-skips-inode-check`, `refused-archive-keeps-lease`, `sidecar-path-by-pathname`, `sidecar-path-without-writable-check`). To check the check on the real file, edit `src/store.ts` in place and run `bun run verify:lease --real-only`:

- In `acquireLease`, make `EADDRINUSE` resolve the lease: replace `ready.reject(hasCode(error, "EADDRINUSE")` ... with `ready.resolve()`. Expect `FAIL guarantee real/race-one-winner`: all six processes open the directory.
- In `Store.open`, delete the `await release(rootFd, streams, lease);` in the catch. Expect `FAIL real/failed-open-releases-lease`.
- In `archiveHeld`, put `await release(this.rootFd, [], this.lease);` before `moveToArchive`. Expect `FAIL real/archive-holds-the-lease`.
- In `archiveHeld`, turn the dev:ino test into `if (false) {`. Expect `FAIL real/archive-refuses-a-displaced-path`.
- In `sidecarPath`, return `join(this.directory, name)`. Expect `FAIL real/sidecar-writes-follow-the-inode`; delete `this.assertWritable();` there instead and expect `FAIL real/closed-store-has-no-sidecar`.
- In `archiveHeld`, delete `closeStreams(this.openStreams(), errors);`. Expect `FAIL real/archive-holds-the-lease` (descriptors still point into the archive).
- In `archiveHeld`, release only when `archive !== undefined`. Expect `FAIL real/archive-refuses-a-displaced-path` (the refused store keeps its lease).
- In `archiveHeld`, delete the `try { await release(this.rootFd, [], this.lease); } catch (error) { errors.push(error); }` block after the rename. Expect `FAIL real/archive-holds-the-lease` and `real/archive-refuses-a-displaced-path` (no path frees the lease). This guards the release that the close-error change at `b37c5da` kept; the warning itself (1171-1178) is not seen by the harness, only by `tests/store.test.ts`.

The `broken` lines copy `src/store.ts` too, so a break in the file can make some of them fail on their own (a copy that never conflicts cannot show a leak; a break whose anchor an earlier break removed reports `its anchor now matches 0 places`). Read the `guarantee` lines first. Restore only your deliberate scratch edits without discarding unrelated work, then rerun. Never commit the break. Historical restored result: 32 ok, 0 open findings, 0 failed. Done at `b37c5da`: the two lease breaks, the six `archiveHeld`/`sidecarPath` breaks and the delete-the-release break each failed the expected guarantee (`--real-only`), and `src/store.ts` was restored byte for byte.
