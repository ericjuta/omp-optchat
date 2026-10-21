---
name: verify-store-lease
description: Check OptChat's store writer lease (one writer per store directory, every write made under it) with a TLA+ model and real-process tests against src/store.ts. Use when a change touches the lease, Store.open/close/archive, Store.sidecarPath, /optchat new, or how the rules ledger and metrics are written, or when asked whether the single-writer lock holds.
---

## What it verifies

**Promise.** One OMP session at a time has a store directory open, and everything written into that directory is written by the session that holds its lease. A second opener gets `StoreLeaseConflictError("Store is already open by another writer")` and changes nothing. `/optchat new` never moves a directory another session has open.

**Harm if it breaks.** Two sessions append to one history and give out the same message ids (replay refuses duplicate ids, `tests/store.test.ts` "identical duplicate message", so the chat then fails to open), or one session's rules, metrics or archive land in another session's chat.

The lease is a kernel object bound to the directory's inode: an abstract Unix socket named `omp-optchat-sha256(dev:ino)` on Linux (`acquireLease`, `src/store.ts:388-426`), a `flock` on the root descriptor on macOS (392). Death of the process frees it; there is no lock file, pid, or timeout.

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

There are no `finding` or `fixed` rows now (the harness keeps both roles for the next one). Current result: 32 ok, 0 open findings, 0 failed, and `--strict` exits 0.

What each guarantee says, in the order the output lists them:

- `ExclusiveOpen` / `race-one-winner`: two sessions never both have the same directory open. The harness races six processes, 20 rounds, through the path and through a symlink to it.
- `StoreWritesUnderLease` / `rejected-opener-changes-nothing`: nothing is written without the lease. The harness leaves a torn log tail, an orphan temp file and an unreferenced blob in a held directory; three rejected opens change none of them, and the successful open afterwards does (the control that proves the check can see a change).
- `NoOrphanLease` / `sigkill-frees-lease`, `failed-open-releases-lease`, `close-releases-and-fences`: a dead, failed or closed session never blocks the next opener, and a closed `Store` refuses writes.
- `ArchiveOnlyClosed` / `archive-holds-the-lease`, `archive-refuses-a-displaced-path` (F1, fixed): `/optchat new` never renames a store directory another session has open. At the rename itself a second process's `Store.open` gets the conflict error (a hook on `renameSync` runs the opener); afterwards a fresh store opens at the path, the archive reopens with the old message, and no descriptor into the archive stays open. When the path was displaced (a user `mv`, then another session opens a store at the old path), the archive renames nothing, the other store keeps writing, and the archiving session's lease is released.
- `SidecarWritesUnderLease` / `sidecar-writes-follow-the-inode`, `closed-store-has-no-sidecar` (F2, fixed): the rules ledger and the metrics file land in the directory their writer holds the lease of, also after that directory is moved and another store sits at the old path. A closed store gives out no sidecar path, even when another store in its process holds its old descriptor number.

## Fixed findings

Both were found by this check at `687d0f9` (its first run) and are fixed in `ff05706`; the old behavior stays as broken variants (`ArchiveAfterRelease`, `SidecarByPath`) that must still be caught.

**F1: `/optchat new` could rename a store another session had open.** At 687d0f9, `shutdown()` closed the store and released the lease, then `archiveStoreDirectory(directory)` renamed the path holding nothing; a session that opened the directory in between lost its live store to the archive. Now `Store.archive` (`store.ts:1113-1153`) keeps rootFd and the lease through the rename, renames only while `statSync(this.directory)` and `fstatSync(rootFd)` give the same dev:ino (1128-1137), and releases both once, on success or failure. `OptChat.shutdown(archiveAt)` (`index.ts:1619-1644`) calls it for `/optchat new` (1665). Residual: a user `mv` between the stat and the rename (rename takes a pathname) is not prevented; the doc comment says so.

**F2: the rules ledger and the metrics file were written by pathname.** At 687d0f9, `RuleLedger.write` opened `join(store.directory, "ledger.jsonl")` and `appendMetric` `join(store.directory, "metrics.jsonl")` on every write, so after the directory was displaced they wrote into whichever store was at that path. Now `Store.sidecarPath(name)` (`store.ts:1098-1104`) runs `assertWritable` and returns `at(rootFd, name)`; `RuleLedger.open(() => store.sidecarPath(LEDGER_FILE))` (`index.ts:677`; `system1/ledger.ts:61-70, 108-111, 143-147`) and `metricsFile(store)` (`index.ts:892-896, 2079`) resolve per write. A metric row for a store that is closed or failed is dropped without a warning; `OPTCHAT_METRICS_FILE` still wins.

## What the model is, and how it maps to code

`scripts/verify-store-lease/StoreLease.tla` (TLA+, checked by TLC). Each action is one indivisible step of the code: one kernel bind or flock, one `openat`, one rename, one synchronous write. Every action's comment cites the lines it stands for, and TLC prints a counterexample as those sentences.

| Action | Code | Atomic because |
|---|---|---|
| `Mkdir`, `OpenRootFd`, `FdPath` | `openRoot` 347-356, `makeDirectory` 317-324, `fdPath` 286, `Store.open` 787-791 | one syscall each; a symlink spelling resolves once, at `openat` |
| `Acquire` | `acquireLease` 388-426 | one kernel `bind` (`server.listen`, 423) or `flock` (392) |
| `Recover`, `StoreWrite` | `openStream` 793-803, `replay` torn-line repair 910-915, `collectGarbage` 708-745, `assertWritable` 818-826, appends | synchronous fd-relative writes after the lease |
| `LedgerOpen`, `SidecarWrite` | `index.ts:677`, `system1/ledger.ts:143-147`, `index.ts:892-896`, `metrics.ts:138-147`, `Store.sidecarPath` 1098-1104 | one `open` per event, descriptor-relative, only while the store is open |
| `OpenFails` | `Store.open` catch 808-815, `index.ts:683-686` | `release` closes descriptors, then the lease |
| `Shutdown`, `Release` | `index.ts:1619-1644`, `store.ts:1159-1164, 450-459` | `close()` is synchronous up to `release` |
| `ArchiveHeld`, `ReleaseArchived` | `Store.archive` 1113-1153, `moveToArchive` 651-679 | the dev:ino check and the rename are two syscalls (residual race, not modelled); the final release is one step |
| `Crash`, `Restart` | `store.ts:421-422`, the module doc 749-751 | the kernel frees sockets and descriptors on death |
| `MoveRoot` | doc comment 752-755, `tests/store.test.ts:1032-1043, 1253-1254` | a user `mv` of an open store directory |

Variants of `Variant`: `Current`; broken: `NoLease`, `PathKey`, `WriteBeforeLease`, `NoCrashRelease`, `LeakOnFailedOpen`, `ArchiveAfterRelease` (the pre-fix F1 order), `ArchiveNoInodeCheck`, `SidecarByPath` (the pre-fix F2). Each broken variant must violate exactly the property it names, and `model.ts` lists the pairs.

The model does not read the code. A change to `src/store.ts` is caught by the real-process harness; the model only changes when someone updates it. That is why the update procedure below is not optional.

## Bounds and assumptions

- Default run: two sessions (`Procs = {p1, p2}`), three directory inodes (`Inodes`), two spellings of the path (`"D"` and a symlink `"L"`), user `mv` on. The five `current/*` guarantees each explore 70,553 distinct states in 4-5 s; the largest run is `broken-ArchiveNoInodeCheck` at 17,461.
- `--deep`: the same five guarantees with three sessions (`Procs = {p1, p2, p3}`, same inodes, spellings, `ExternalMove = TRUE`), ids `current3/<Invariant>`. Measured on the 8-core, 61 GB workstation with Temurin 21.0.12, TLC 2.19, one TLC worker per case: each case explores 4,098,579 distinct states (34,603,933 generated, depth 41) and takes 146-201 s when four run at once (148 s alone), 334 s wall for the five at `CONCURRENCY` 4 (two waves). A lone case peaked at 5.8 GB resident (the JVM takes up to a quarter of RAM as heap; a smaller host makes TLC spill to disk and slow down), so four at once want about 24 GB. That is over the three-minute budget of the default run, so three sessions are checked only with `--deep`. All five hold: no three-session violation (2026-10-21, at the sync commit below). `--deep` needs the model, so it cannot be combined with `--real-only`.
- Run `--deep` when you change `StoreLease.tla` or what an action does, or before a release that touches the lease; it is not in CI.
- One store path. Two different directories never interact in the code, so they are not modelled.
- Linux and macOS leases are the same action (`Acquire`). The model cannot tell them apart; only the Linux lease runs here. All writers must share a network namespace (`store.ts:422`).
- The real-process harness runs only against this machine's platform and filesystem (local, private POSIX permissions); the archive probe reads `/proc/self/fd`.

## Not covered

- macOS `flock` (392-399), run only by reading the code.
- Lease loss while open (`assertWritable`, 818-826, checks `server.listening`): the model has no event that closes a server under a live store.
- A user `mv` between `Store.archive`'s dev:ino check and its rename (`store.ts:1128-1138`): two syscalls, a pathname rename; named in the doc comment, not prevented and not modelled.
- Which file `index.ts` hands `RuleLedger.open` and `metricsFile`, and how `record` drops a row for a closed store: `verify:lease` drives `store.ts`, `system1/ledger.ts` and `metrics.ts` from a child, not `index.ts`. Those are checked by `tests/metrics.test.ts` ("the metric sink follows the store's inode"), `tests/new-chat.test.ts` ("refuses to archive a path that now names another session's store") and `tests/store.test.ts` ("Store archive and sidecar files").
- Network namespaces, NFS and filesystems without fsync or with unstable inode numbers (the lease key is `dev:ino`).
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

Sync commit: `ff05706d1cb7ba9617c6951f60dbf8432ce1be92` (the product fix for F1 and F2; the verification was updated against the code at this commit, the next commit).

| File | Covered |
|---|---|
| `src/store.ts` | `StoreLeaseConflictError` 87, `fdPath` 286, `descriptorPath`/`at` 295-301, `makeDirectory` 317-324, `openRoot` 347-356, `openStream`/`openExistingStream` 358-374, `acquireLease` 388-426, `closeLease` 428-437, `closeDescriptor`/`closeStreams`/`release` 439-459, `moveToArchive` 651-679, `collectGarbage` 708-745, `Store.open` 777-816, `assertWritable` 818-826, `replay` repair 910-915, `sidecarPath` 1098-1104, `archive`/`archiveHeld` 1113-1153, `close` 1159-1164 |
| `src/index.ts` | `open` 649-706, `record` 892-905, `shutdown` 1619-1644, `startNewChat` 1650-1685, `reopen` 1701-1710, `session_shutdown` 2127, `metricsFile` 2079 |
| `src/system1/ledger.ts` | `RuleLedger.open` 61-70, `replay` 108-111, `write` 143-147, the doc comment 47-53 |
| `src/metrics.ts` | `appendMetric` 138-147 |

Files of the verification: `scripts/verify-store-lease/` (`run.ts` the command, `model.ts` TLC, `StoreLease.tla`, `real.ts` and `child.ts` the real-process harness, `check.ts` result types), `package.json` script `verify:lease`, `.gitignore` entry `.verify/`.

## Update procedure

Use this when a change touches covered code, and for `/maintain-formal-verification-skill`.

1. Does the change touch covered code? `git diff --stat ff05706 -- src/store.ts src/index.ts src/system1/ledger.ts src/metrics.ts` (use the sync commit above; after you move it, use the new one). Also look for code that moved, and for new code that opens a file in the store directory, or acquires or releases a lease.
2. Run `bun run verify:lease` before you edit anything and keep the output.
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

The `broken` lines copy `src/store.ts` too, so a break in the file can make some of them fail on their own (a copy that never conflicts cannot show a leak; a break whose anchor an earlier break removed reports `its anchor now matches 0 places`). Read the `guarantee` lines first. Then `git checkout src/store.ts` and rerun: 32 ok, 0 open findings, 0 failed. Never commit the break. Done at this commit: the two lease breaks and the six `archiveHeld`/`sidecarPath` breaks each failed the expected guarantee, and `src/store.ts` was restored byte for byte.
