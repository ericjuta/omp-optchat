---
name: verify-store-lease
description: Check OptChat's store writer lease (one writer per store directory, every write made under it) with a TLA+ model and real-process tests against src/store.ts. Use when a change touches the lease, Store.open/close, /optchat new, or how the rules ledger and metrics are written, or when asked whether the single-writer lock holds.
---

## What it verifies

**Promise.** One OMP session at a time has a store directory open, and everything written into that directory is written by the session that holds its lease. A second opener gets `StoreLeaseConflictError("Store is already open by another writer")` and changes nothing.

**Harm if it breaks.** Two sessions append to one history and give out the same message ids (replay refuses duplicate ids, `tests/store.test.ts` "identical duplicate message", so the chat then fails to open), or one session's rules, metrics or archive land in another session's chat.

The lease is a kernel object bound to the directory's inode: an abstract Unix socket named `omp-optchat-sha256(dev:ino)` on Linux (`acquireLease`, `src/store.ts:387-425`), a `flock` on the root descriptor on macOS (391). Death of the process frees it; there is no lock file, pid, or timeout.

## Run it

```sh
bun run verify:lease                 # model, then real code: about 12 s (model 10 s, real code 1.5 s)
bun run verify:lease --traces        # also print each open finding's counterexample
bun run verify:lease --real-only     # real code only, 1.5 s
bun run verify:lease --model-only    # TLC only
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

What each guarantee says, in the order the output lists them:

- `ExclusiveOpen` / `race-one-winner`: two sessions never both have the same directory open. The harness races six processes, 20 rounds, through the path and through a symlink to it.
- `StoreWritesUnderLease` / `rejected-opener-changes-nothing`: nothing is written without the lease. The harness leaves a torn log tail, an orphan temp file and an unreferenced blob in a held directory; three rejected opens change none of them, and the successful open afterwards does (the control that proves the check can see a change).
- `NoOrphanLease` / `sigkill-frees-lease`, `failed-open-releases-lease`, `close-releases-and-fences`: a dead, failed or closed session never blocks the next opener, and a closed `Store` refuses writes.

## Open findings

Both are real code paths, reproduced by the real-process harness (`real/archive-renames-open-store`, `real/sidecar-writes-follow-the-inode`) and found by TLC without any user action beyond two OMP sessions on one directory. Nothing in the product code was changed.

**F1: `/optchat new` can rename a store another session has open.** `ArchiveOnlyClosed`. Steps, in the code's words:

1. Session p1 runs `/optchat new`: `shutdown()` closes the rules ledger and `store.close()` (`index.ts:1619, 1631`); `release` frees the lease (`store.ts:449-450`).
2. Session p2 starts and calls `Store.open(config.directory)` (`index.ts:662`): `openRoot` opens the same directory, `acquireLease` binds its lease: p2 holds the store.
3. p1 calls `archiveStoreDirectory(store.directory)` (`index.ts:1654`): it claims the archive name with `mkdir` and `renameSync(directory, archive)` (`store.ts:649, 655`). It renames by path and holds no lease, so p2's live store moves to the archive.
4. p1 reopens `config.directory` (`index.ts:1665`): a fresh empty store, its own lease, so it succeeds.

Harm: p2 keeps writing into the directory the user was told is a closed archive, while p1's new chat sits at the old path; while p2 lives, `--optchat-dir <archive>` fails with the conflict error. The window is the time between `closeLease` (`store.ts:434`) and `renameSync` (`store.ts:655`): narrow, but real. Fix direction, modeled as `ArchiveUnderLease` and verified: keep the lease through the rename, and rename only if `store.directory` still names the leased inode.

**F2: the rules ledger and the metrics file are written by path, not through the store's root descriptor.** `SidecarWritesUnderLease`. The store follows its inode after a move (`store.ts:746-749`), but `RuleLedger.write` opens `join(store.directory, "ledger.jsonl")` on every event (`system1/ledger.ts:60, 145`) and `appendMetric` opens `join(store.directory, "metrics.jsonl")` (`index.ts:2066, 895`; `metrics.ts:140`). After the directory is displaced (a user `mv`, or F1), session B's ledger and metrics writes land in whichever store is now at that path, held by another session. This contradicts `ledger.ts:50` ("Only the leased session writes it"). Harness replay: B opens D and its ledger; D is renamed away; C opens a fresh store at D; B's `rule` and `metric` land in C's directory, B's `append` goes to the moved directory. Fix direction, modeled as `LedgerAtInode` and verified: open the ledger and metrics files relative to the root descriptor.

Do not weaken either property to make the check pass. When one is fixed, the finding row turns `GONE` and the exit code is 1; follow the update procedure to make it a guarantee.

## What the model is, and how it maps to code

`scripts/verify-store-lease/StoreLease.tla` (TLA+, checked by TLC). Each action is one indivisible step of the code: one kernel bind or flock, one `openat`, one rename, one synchronous write. Every action's comment cites the lines it stands for, and TLC prints a counterexample as those sentences.

| Action | Code | Atomic because |
|---|---|---|
| `Mkdir`, `OpenRootFd`, `FdPath` | `openRoot` 346-355, `makeDirectory` 316-323, `fdPath` 285, `Store.open` 781-785 | one syscall each; a symlink spelling resolves once, at `openat` |
| `Acquire` | `acquireLease` 387-425 | one kernel `bind` (`server.listen`, 422) or `flock` (391) |
| `Recover`, `StoreWrite` | `openStream` 787-797, `replay` torn-line repair, `collectGarbage` 702-739, `assertWritable` 812-820, appends | synchronous fd-relative writes after the lease |
| `LedgerOpen`, `SidecarWrite` | `index.ts:677`, `system1/ledger.ts:141-156`, `index.ts:892-899`, `metrics.ts:137-146` | one `open` by pathname per event |
| `OpenFails` | `Store.open` catch 802-809, `index.ts:683-686` | `release` closes descriptors, then the lease |
| `Shutdown`, `Release`, `Archive` | `index.ts:1611-1632, 1638-1673`, `store.ts:1086-1091, 438-453, 645-672` | `close()` is synchronous up to `release`; the rename is one syscall |
| `Crash`, `Restart` | `store.ts:420-421`, the module doc 743-745 | the kernel frees sockets and descriptors on death |
| `MoveRoot` | doc comment 746-749, `tests/store.test.ts:1032-1043, 1253-1254` | a user `mv` of an open store directory |

Variants of `Variant`: `Current`; broken: `NoLease`, `PathKey`, `WriteBeforeLease`, `NoCrashRelease`, `LeakOnFailedOpen`; fixed: `ArchiveUnderLease`, `LedgerAtInode`. Each broken variant must violate exactly the property it names, and `model.ts` lists the pairs.

The model does not read the code. A change to `src/store.ts` is caught by the real-process harness; the model only changes when someone updates it. That is why the update procedure below is not optional.

## Bounds and assumptions

- Two sessions (`Procs`), three directory inodes (`Inodes`), two spellings of the path (`"D"` and a symlink `"L"`). About 71,000 states for the largest run. A third session is not checked.
- One store path. Two different directories never interact in the code, so they are not modelled.
- Linux and macOS leases are the same action (`Acquire`). The model cannot tell them apart; only the Linux lease runs here. All writers must share a network namespace (`store.ts:421`).
- The real-process harness runs only against this machine's platform and filesystem (local, private POSIX permissions).

## Not covered

- macOS `flock` (391-398), run only by reading the code.
- Lease loss while open (`assertWritable`, 812-820, checks `server.listening`): the model has no event that closes a server under a live store.
- Network namespaces, NFS and filesystems without fsync or with unstable inode numbers (the lease key is `dev:ino`).
- Content of the logs, replay, compression, the view: only the lease and who writes under it.
- A hostile process that connects to the abstract socket name (`createServer((socket) => socket.destroy())` answers and closes it; only existence matters).
- Interleavings of three or more sessions.

## Real bug or model drift?

The real harness runs the real code. A `FAIL` there on a guarantee is a bug in the code, unless its message begins `fixture stopped proving its claim` (a fixture needs updating) or `harness error`.

A `FAIL` or `GONE` from TLC on a `current/*` check: replay the counterexample step by step against the code (the sentences cite lines).

- A step cannot happen in the code, or it does not go as the model says: **model drift**. Fix the model from the code, not from the result, then rerun.
- Every step can happen: **a bug**. Run the matching real check (`--real-only`); it should fail or reproduce the same way. Report it with the counterexample, the harm, and the commit that introduced it, and do not weaken the property.
- The model and the harness disagree (the model says `FINDING`, the harness says `GONE`, or the reverse): one is stale; read the code the finding names and decide.
- `TLC did not finish cleanly`: a toolchain problem; read the quoted TLC error.
- `its anchor now matches N places in src/store.ts`: the break check's one-line edit no longer applies because the lease code moved. Update the anchor in `real.ts`, then confirm the break is still caught.

## Coverage record

Sync commit: `8d8b9964e09b79c2caf8dd5d615ed40f51e4d5d6` (the verification was confirmed against the code at this commit; the last commit that changed a covered file is `a4094a0`, v0.13.0).

| File | Covered |
|---|---|
| `src/store.ts` | `StoreLeaseConflictError` 86, `fdPath` 285, `makeDirectory` 316-323, `openRoot` 346-355, `openStream`/`openExistingStream` 357-373, `acquireLease` 387-425, `closeLease` 427-436, `release` 438-453, `archiveStoreDirectory` 645-672, `collectGarbage` 702-739, `Store.open` 771-810, `assertWritable` 812-820, `replay` repair 904-909, `close` 1086-1091 |
| `src/index.ts` | `open` 649-706, `record` 892-899, `shutdown` 1611-1632, `startNewChat` 1638-1673, `reopen` 1688-1697, `metricsFile` 2066 |
| `src/system1/ledger.ts` | `RuleLedger.open` 64-68, `write` 141-156, the doc comment 50 |
| `src/metrics.ts` | `appendMetric` 137-146 |

Files of the verification: `scripts/verify-store-lease/` (`run.ts` the command, `model.ts` TLC, `StoreLease.tla`, `real.ts` and `child.ts` the real-process harness, `check.ts` result types), `package.json` script `verify:lease`, `.gitignore` entry `.verify/`.

## Update procedure

Use this when a change touches covered code, and for `/maintain-formal-verification-skill`.

1. Does the change touch covered code? `git diff --stat 8d8b996 -- src/store.ts src/index.ts src/system1/ledger.ts src/metrics.ts` (use the sync commit above; after you move it, use the new one). Also look for code that moved, and for new code that opens a file in the store directory, or acquires or releases a lease.
2. Run `bun run verify:lease` before you edit anything and keep the output.
3. Read each change. If it alters a step the model describes (a step now two, a check moved, a new path writes into the store directory), update `StoreLease.tla`, `real.ts` or `child.ts` from the code, not from the result. If the promise changed on purpose, change the property and write the old wording, the new wording and the evidence (doc comment, tests, changelog) in the commit message.
4. Rerun. New or edited covered code needs a proof that the check can still fail: add a model variant or a `MUTANTS` entry in `real.ts` for the new guard, and see it caught.
5. When a finding is fixed: move its property from the `finding` rows to `guarantee` in `model.ts`, turn its `real.ts` probe from `FINDINGS` into `GUARANTEES` (flip the assertion), and keep the fixed variant as a broken one.
6. Update this skill's line numbers and coverage record, and move the sync commit to the commit you checked only after the verification describes the code at that commit. Put verification changes in their own commit, apart from any product fix.

## Prove it can fail: the scratch break

`bun run verify:lease` already breaks four copies of `store.ts` (`MUTANTS` in `real.ts`) and requires each to be caught. To check the check on the real file, edit `src/store.ts` in place and run it:

- In `acquireLease`, make `EADDRINUSE` resolve the lease: replace `ready.reject(hasCode(error, "EADDRINUSE")` ... with `ready.resolve()`. Expect `FAIL guarantee real/race-one-winner`: all six processes open the directory.
- In `Store.open`, delete the `await release(rootFd, streams, lease);` in the catch. Expect `FAIL real/failed-open-releases-lease`.

The `broken` lines copy `src/store.ts` too, so a break in the file can make some of them fail on their own (a copy that never conflicts cannot show a leak). Read the `guarantee` lines first. Then `git checkout src/store.ts` and rerun: 19 ok, 6 open findings, 0 failed. Never commit the break.
