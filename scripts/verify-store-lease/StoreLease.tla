----------------------------- MODULE StoreLease -----------------------------
(***************************************************************************)
(* The writer lease of an OptChat store directory, and every writer that   *)
(* relies on it. Each action names the code it stands for, and one action  *)
(* is one indivisible step of that code: one kernel bind or flock, one     *)
(* openat, one rename, one synchronous write. How to run, read and update  *)
(* this model: .omp/skills/verify-store-lease/SKILL.md.                    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS
    Procs,         \* OMP main sessions: separate processes that open the same store path
    Inodes,        \* directory inodes that mkdir can create at the store path (the bound)
    None,          \* no value
    Spellings,     \* spellings of the configured path: "D", and "L", a symlink to D
    ExternalMove,  \* TRUE: a user may `mv` an open store directory away from D
    Variant        \* "Current", or a named broken variant (Variants)

\* Current            the code as it is.
\* NoLease            broken: a failed bind (EADDRINUSE) is treated as acquired.
\* PathKey            broken: the lease is keyed by the path spelling, not dev:ino.
\* WriteBeforeLease   broken: the open-time writes run before the lease is taken.
\* NoCrashRelease     broken: a dead process keeps its lease (a lock file design).
\* LeakOnFailedOpen   broken: an open that fails after the lease does not release it.
\* ArchiveAfterRelease broken: `/optchat new` closes the store, releasing the lease, and then
\*                    renames the directory its path names (the code before the F1 fix).
\* ArchiveNoInodeCheck broken: Store.archive keeps the lease through the rename but renames
\*                    whatever store.directory names now, without the dev:ino check.
\* SidecarByPath      broken: the rules ledger and metrics are opened by join(store.directory,
\*                    file) on every write (the code before the F2 fix).
Variants == {"Current", "NoLease", "PathKey", "WriteBeforeLease", "NoCrashRelease",
             "LeakOnFailedOpen", "ArchiveAfterRelease", "ArchiveNoInodeCheck", "SidecarByPath"}

ASSUME Variant \in Variants /\ "D" \in Spellings /\ ExternalMove \in BOOLEAN

\* "D" names the configured directory. A directory moved away from D, by `mv` or by
\* `/optchat new`, keeps a name of its own; the model names it by its inode.
Names == {"D"} \cup Inodes
Keys  == Inodes \cup Spellings

VARIABLES
    pc,       \* each session's place in the code
    spell,    \* the path spelling the session passes to Store.open (config.directory)
    root,     \* inode behind the session's rootFd (store.ts:787, 347-356)
    canon,    \* store.directory: the name fdPath read at store.ts:791
    ledger,   \* the session's RuleLedger is open (index.ts:693)
    newChat,  \* this shutdown is `/optchat new` (index.ts:1681)
    owner,    \* the kernel lease table: abstract socket names (Linux), flocks (macOS)
    atD,      \* the inode the configured path D names now, or None
    used,     \* inodes created so far
    wrote,    \* ghost: the write the last step made, a set of 0 or 1 records
    renamed,  \* ghost: the directory `/optchat new` moved to its archive in the last step
    last      \* ghost: the last step in the code's words; not part of a state's identity

vars == <<pc, spell, root, canon, ledger, newChat, owner, atD, used, wrote, renamed, last>>
View == <<pc, spell, root, canon, ledger, newChat, owner, atD, used, wrote, renamed>>

Phases == {"idle", "mkdir", "openroot", "fdpath", "acquire", "recover", "ledger",
           "open", "closing", "archived", "archive", "dead"}
\* Between taking the lease and releasing it: the session has the store open. "archived" is
\* Store.archive after its rename (or refusal): closed, but rootFd and the lease still held.
\* "archive" exists only in ArchiveAfterRelease: lease already released, rename still to come.
OpenPhases == {"recover", "ledger", "open", "closing", "archived"}

Key(p) == IF Variant = "PathKey" THEN spell[p] ELSE root[p]
Resolve(n) == IF n = "D" THEN atD ELSE n
NameOf(i) == IF atD = i THEN "D" ELSE i
Free(p) == [k \in Keys |-> IF owner[k] = p THEN None ELSE owner[k]]
Set(f, p, v) == [f EXCEPT ![p] = v]
StoreRec(p, i) == [by |-> p, ino |-> i, via |-> "store"]

\* Narration of a step, in the code's words: "p1: text" or "p1: text [name]".
Show(x) == IF x \in Spellings THEN x ELSE ToString(x)
Say(p, text) == (IF p = "user" THEN p ELSE ToString(p)) \o ": " \o text
SayAt(p, text, x) == Say(p, text) \o " [" \o Show(x) \o "]"

Init ==
    /\ pc = [p \in Procs |-> "idle"]
    /\ spell = [p \in Procs |-> "D"]
    /\ root = [p \in Procs |-> None]
    /\ canon = [p \in Procs |-> None]
    /\ ledger = [p \in Procs |-> FALSE]
    /\ newChat = [p \in Procs |-> FALSE]
    /\ owner = [k \in Keys |-> None]
    /\ atD = None
    /\ used = {}
    /\ wrote = {}
    /\ renamed = {}
    /\ last = "init"

\* index.ts:666 (session_start) or a reopen calls Store.open(config.directory); store.ts:777. When a non-git
\* session finds the global store held, index.ts:679 opens a different directory (the per-directory fallback);
\* two directories never interact, so that second open is another Start at another path, not modelled.
Start(p) ==
    /\ pc[p] = "idle"
    /\ \E s \in Spellings:
         /\ spell' = Set(spell, p, s)
         /\ last' = SayAt(p, "Store.open(config.directory) starts (index.ts:666, store.ts:777-787)", s)
    /\ pc' = Set(pc, p, "mkdir")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<root, canon, ledger, newChat, owner, atD, used>>

\* openRoot: makeDirectory(parent, basename(path)), EEXIST ignored (store.ts:351, 317-322).
\* A symlink spelling names an entry already (a dangling link too), so mkdir through it creates
\* nothing. Bound: once every inode is used, mkdir creates nothing and the next openat fails.
Mkdir(p) ==
    /\ pc[p] = "mkdir"
    /\ IF atD = None /\ spell[p] = "D" /\ used # Inodes
         THEN \E i \in Inodes \ used:
                /\ atD' = i
                /\ used' = used \cup {i}
                /\ last' = SayAt(p, "mkdir creates the store directory at D (store.ts:351, 319)", i)
         ELSE /\ UNCHANGED <<atD, used>>
              /\ last' = Say(p, "mkdir finds the entry present (EEXIST, store.ts:319-321), or the inode bound is reached")
    /\ pc' = Set(pc, p, "openroot")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, ledger, newChat, owner>>

\* openRoot: openDirectory(at(parent, basename(path)), follow) opens rootFd (store.ts:352, 305).
\* A symlink spelling resolves here, once.
OpenRootFd(p) ==
    /\ pc[p] = "openroot"
    /\ IF atD = None
         THEN /\ pc' = Set(pc, p, "idle")
              /\ UNCHANGED root
              /\ last' = Say(p, "openat finds no directory at D: Store.open throws ENOENT before any lease (store.ts:352)")
         ELSE /\ pc' = Set(pc, p, "fdpath")
              /\ root' = Set(root, p, atD)
              /\ last' = SayAt(p, "openat opens the directory at D as rootFd (store.ts:352, 305)", atD)
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, canon, ledger, newChat, owner, atD, used>>

\* canonical = fdPath(rootFd): the directory's current name, kept as store.directory (store.ts:791).
FdPath(p) ==
    /\ pc[p] = "fdpath"
    /\ canon' = Set(canon, p, NameOf(root[p]))
    /\ pc' = Set(pc, p, IF Variant = "WriteBeforeLease" THEN "recover" ELSE "acquire")
    /\ last' = SayAt(p, "fdPath(rootFd) names the directory; this becomes store.directory (store.ts:791)", NameOf(root[p]))
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, ledger, newChat, owner, atD, used>>

\* acquireLease (store.ts:388-426): one kernel step. Linux: listen on the abstract socket
\* omp-optchat-sha256(dev:ino) of rootFd (402-403, 423); macOS: flock(rootFd, LOCK_EX|LOCK_NB) (392).
\* A taken name fails EADDRINUSE / EWOULDBLOCK: StoreLeaseConflictError (396, 411-412), and
\* Store.open's catch closes rootFd only (810, 450-459).
Acquire(p) ==
    /\ pc[p] = "acquire"
    /\ IF owner[Key(p)] = None
         THEN /\ owner' = [owner EXCEPT ![Key(p)] = p]
              /\ pc' = Set(pc, p, IF Variant = "WriteBeforeLease" THEN "ledger" ELSE "recover")
              /\ UNCHANGED <<root, canon>>
              /\ last' = SayAt(p, "acquireLease binds the lease of its root inode (store.ts:402-423; macOS flock 392)", root[p])
         ELSE IF Variant = "NoLease"
         THEN /\ owner' = owner
              /\ pc' = Set(pc, p, "recover")
              /\ UNCHANGED <<root, canon>>
              /\ last' = SayAt(p, "bind fails EADDRINUSE and the open goes on anyway (broken variant NoLease)", root[p])
         ELSE /\ owner' = owner
              /\ pc' = Set(pc, p, "idle")
              /\ root' = Set(root, p, None)
              /\ canon' = Set(canon, p, None)
              /\ last' = SayAt(p, "bind fails EADDRINUSE: StoreLeaseConflictError, rootFd closed, nothing written (store.ts:411-412, 810)", root[p])
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, ledger, newChat, atD, used>>

\* Store.open after the lease: openStream mkdirs (793-796, 803), replay's torn-line repair
\* (910-915), collectGarbage unlinks (740-741, 723). All fd-relative to rootFd, no
\* assertWritable; the lease taken just before is their only guard.
Recover(p) ==
    /\ pc[p] = "recover"
    /\ wrote' = {StoreRec(p, root[p])}
    /\ pc' = Set(pc, p, IF Variant = "WriteBeforeLease" THEN "acquire" ELSE "ledger")
    /\ last' = SayAt(p, "open-time writes: mkdir main/tree/images, torn-line repair, garbage collection (store.ts:793-806)", root[p])
    /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, ledger, newChat, owner, atD, used>>

\* Store.open returns; OptChat opens RuleLedger.open(() => store.sidecarPath(LEDGER_FILE))
\* (index.ts:666, 693; system1/ledger.ts:61-70). Replay reads through the resolver (ledger.ts:108-111).
LedgerOpen(p) ==
    /\ pc[p] = "ledger"
    /\ ledger' = Set(ledger, p, TRUE)
    /\ pc' = Set(pc, p, "open")
    /\ last' = SayAt(p, "Store.open returns; RuleLedger.open(() => store.sidecarPath(LEDGER_FILE)) (index.ts:666, 693)", canon[p])
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, newChat, owner, atD, used>>

\* Store.open fails after the lease (a stream open or replay throws): the catch releases the
\* descriptors and the lease (store.ts:808-815); or RuleLedger.open throws and OptChat closes
\* the store (index.ts:699-702). Either way the session ends with no store and no lease.
OpenFails(p) ==
    /\ pc[p] \in {"recover", "ledger"}
    /\ owner' = IF Variant = "LeakOnFailedOpen" THEN owner ELSE Free(p)
    /\ pc' = Set(pc, p, "idle")
    /\ root' = Set(root, p, None)
    /\ canon' = Set(canon, p, None)
    /\ last' = IF Variant = "LeakOnFailedOpen"
               THEN Say(p, "the open fails after the lease and the lease stays held (broken variant LeakOnFailedOpen)")
               ELSE Say(p, "the open fails after the lease: the catch releases descriptors and lease (store.ts:808-815; index.ts:699-702)")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, ledger, newChat, atD, used>>

\* append / saveNode / saveImage / saveView: assertWritable (store.ts:818-826: not closed,
\* lease still bound), then one synchronous fd-relative write (921-942, 986-998, 1080-1090).
StoreWrite(p) ==
    /\ pc[p] = "open"
    /\ owner[Key(p)] = p
    /\ wrote' = {StoreRec(p, root[p])}
    /\ last' = SayAt(p, "append/saveNode/saveImage/saveView: assertWritable, then a synchronous fd-relative write (store.ts:818-826, 921-942)", root[p])
    /\ renamed' = {}
    /\ UNCHANGED <<pc, spell, root, canon, ledger, newChat, owner, atD, used>>

\* RuleLedger.write resolves its file with this.file() for every event (system1/ledger.ts:143-147),
\* which is store.sidecarPath(LEDGER_FILE) (index.ts:693); OptChat.record resolves
\* metricsFile(store) = store.sidecarPath(METRICS_FILE) and appends to it (index.ts:908-912, 2095;
\* metrics.ts:138-147). sidecarPath runs assertWritable (store.ts:1102, 818-826), then returns
\* at(rootFd, name) (1103, 299-301): the leased inode, whatever D names now. A closed or failed
\* store refuses the path, so a write needs pc = "open". SidecarByPath is the code before the fix.
SidecarWrite(p) ==
    /\ pc[p] = "open"
    /\ ledger[p]
    /\ LET target == IF Variant = "SidecarByPath" THEN Resolve(canon[p]) ELSE root[p]
       IN /\ wrote' = IF target = None THEN {} ELSE {[by |-> p, ino |-> target, via |-> "sidecar"]}
          /\ last' = IF Variant = "SidecarByPath"
                     THEN SayAt(p, "rules ledger and metrics appends open(join(store.directory, file), O_APPEND|O_CREAT) by path (broken variant SidecarByPath): they land in the directory D names now", target)
                     ELSE SayAt(p, "rules ledger and metrics appends open(store.sidecarPath(file)) relative to rootFd (system1/ledger.ts:147, metrics.ts:140, store.ts:1103): they land in the leased inode", target)
    /\ renamed' = {}
    /\ UNCHANGED <<pc, spell, root, canon, ledger, newChat, owner, atD, used>>

\* OptChat.shutdown(archiveAt) (index.ts:1635-1660): rules.close() (1643), store = undefined, then
\* store.close() (1656) or, for `/optchat new`, store.archive(now) (1659, 1681). Both set closed
\* with no await before the writes stop (store.ts:1118, 1170) and close the stream descriptors
\* synchronously (1126, 443-448); close() goes on to release rootFd and the lease (1171), archive()
\* keeps them.
Shutdown(p) ==
    /\ pc[p] = "open"
    /\ \E nc \in BOOLEAN:
         /\ newChat' = Set(newChat, p, nc)
         /\ last' = IF nc
                    THEN Say(p, "/optchat new: shutdown closes the rules ledger, then Store.archive sets closed and closes its stream descriptors, keeping rootFd and the lease (index.ts:1681, 1659; store.ts:1118, 1126)")
                    ELSE Say(p, "session ends: shutdown closes the rules ledger, then store.close sets closed and closes its descriptors (index.ts:1656; store.ts:1170, 443-448)")
    /\ ledger' = Set(ledger, p, FALSE)
    /\ pc' = Set(pc, p, "closing")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, owner, atD, used>>

\* release, last step of close(): close(rootFd), then closeLease -> server.close frees the socket
\* name (store.ts:1171, 450-459, 428-437); on macOS close(rootFd) drops the flock. Both follow the
\* stream closes above. In ArchiveAfterRelease `/optchat new` released here too, then archived.
Release(p) ==
    /\ pc[p] = "closing"
    /\ (~newChat[p] \/ Variant = "ArchiveAfterRelease")
    /\ owner' = Free(p)
    /\ pc' = Set(pc, p, IF newChat[p] THEN "archive" ELSE "idle")
    /\ root' = Set(root, p, None)
    /\ canon' = IF newChat[p] THEN canon ELSE Set(canon, p, None)
    /\ last' = Say(p, "closeLease frees the lease (store.ts:1171, 450-459; macOS close(rootFd) drops the flock): nothing holds the directory from here")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, ledger, newChat, atD, used>>

\* Store.archive, rename step, lease and rootFd still held (store.ts:1124-1161): fstat(rootFd) and
\* stat(this.directory) must give the same dev:ino (1130-1139), else it throws and renames nothing;
\* then moveToArchive claims the archive name with mkdir and renames the path (1140; 651-679, 661).
\* The stat and the rename are two syscalls: a user `mv` between them is the residual race the doc
\* comment names (1107-1114), not modelled. ArchiveNoInodeCheck skips the dev:ino check.
ArchiveHeld(p) ==
    /\ pc[p] = "closing"
    /\ newChat[p]
    /\ Variant # "ArchiveAfterRelease"
    /\ LET target  == Resolve(canon[p])
           allowed == Variant = "ArchiveNoInodeCheck" \/ target = root[p]
           moves   == target # None /\ allowed
       IN /\ renamed' = IF moves THEN {[by |-> p, ino |-> target]} ELSE {}
          /\ atD' = IF moves /\ canon[p] = "D" THEN None ELSE atD
          /\ last' = IF moves
                     THEN SayAt(p, "Store.archive: the path still names the leased inode, so moveToArchive renames it with the lease held (store.ts:1130-1140)", target)
                     ELSE Say(p, "Store.archive: the path no longer names the leased inode (or names nothing): it throws and renames nothing (store.ts:1130-1139); startNewChat reopens D (index.ts:1684-1687)")
    /\ pc' = Set(pc, p, "archived")
    /\ wrote' = {}
    /\ UNCHANGED <<spell, root, canon, ledger, newChat, owner, used>>

\* Store.archive, last step, on success and on failure alike: release(rootFd, [], lease) closes
\* rootFd and frees the lease (store.ts:1145, 450-459); then startNewChat reopens the configured
\* path (index.ts:1681, 1717-1722). A descriptor or lease close error after a successful rename (since
\* b37c5da) is reported as a warning and the archive path is still returned (store.ts:1153-1160): the
\* release step and its effect on the lease are the same, so this action covers that case too.
ReleaseArchived(p) ==
    /\ pc[p] = "archived"
    /\ owner' = Free(p)
    /\ pc' = Set(pc, p, "mkdir")
    /\ root' = Set(root, p, None)
    /\ canon' = Set(canon, p, None)
    /\ newChat' = Set(newChat, p, FALSE)
    /\ last' = Say(p, "Store.archive releases rootFd and the lease (store.ts:1145); the chat reopens D (index.ts:1681)")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, ledger, atD, used>>

\* ArchiveAfterRelease only, the code before the F1 fix: archiveStoreDirectory(directory) renamed by
\* pathname whatever that path names now, holding no lease (index.ts:1654 at 687d0f9; store.ts:645-673
\* at 687d0f9), then the chat reopened the configured path.
Archive(p) ==
    /\ pc[p] = "archive"
    /\ Variant = "ArchiveAfterRelease"
    /\ LET target == Resolve(canon[p])
           moves  == target # None
       IN /\ renamed' = IF moves THEN {[by |-> p, ino |-> target]} ELSE {}
          /\ atD' = IF moves /\ canon[p] = "D" THEN None ELSE atD
          /\ last' = IF moves
                     THEN SayAt(p, "archiveStoreDirectory(store.directory) renames the directory that path names now to the archive, with no lease held (broken variant ArchiveAfterRelease); then the chat reopens D", target)
                     ELSE Say(p, "no archive rename happens (no directory there); the chat reopens D")
    /\ pc' = Set(pc, p, "mkdir")
    /\ root' = Set(root, p, None)
    /\ canon' = Set(canon, p, None)
    /\ newChat' = Set(newChat, p, FALSE)
    /\ wrote' = {}
    /\ UNCHANGED <<spell, ledger, owner, used>>

\* Process death anywhere: the kernel closes the socket and every descriptor, so the lease
\* goes with it (store.ts:421-422, 749-751). No further step of this process happens.
Crash(p) ==
    /\ pc[p] \notin {"idle", "dead"}
    /\ owner' = IF Variant = "NoCrashRelease" THEN owner ELSE Free(p)
    /\ pc' = Set(pc, p, "dead")
    /\ root' = Set(root, p, None)
    /\ canon' = Set(canon, p, None)
    /\ ledger' = Set(ledger, p, FALSE)
    /\ newChat' = Set(newChat, p, FALSE)
    /\ last' = IF Variant = "NoCrashRelease"
               THEN Say(p, "the process dies and its lease stays held (broken variant NoCrashRelease)")
               ELSE Say(p, "the process dies; the kernel frees its socket name and descriptors (store.ts:421-422)")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, atD, used>>

Restart(p) ==
    /\ pc[p] = "dead"
    /\ pc' = Set(pc, p, "idle")
    /\ last' = Say(p, "a new OMP session starts")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, ledger, newChat, owner, atD, used>>

\* A user moves the open store directory; the Store follows its inode (store.ts:343-346, 289-301,
\* 752-755; tests/store.test.ts:1032-1043, 1253-1254, and the new tests after 1372).
MoveRoot ==
    /\ ExternalMove
    /\ atD # None
    /\ atD' = None
    /\ last' = SayAt("user", "mv moves the store directory away from D", atD)
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<pc, spell, root, canon, ledger, newChat, owner, used>>

Next ==
    \/ \E p \in Procs:
         \/ Start(p) \/ Mkdir(p) \/ OpenRootFd(p) \/ FdPath(p) \/ Acquire(p)
         \/ Recover(p) \/ LedgerOpen(p) \/ OpenFails(p) \/ StoreWrite(p) \/ SidecarWrite(p)
         \/ Shutdown(p) \/ Release(p) \/ ArchiveHeld(p) \/ ReleaseArchived(p) \/ Archive(p)
         \/ Crash(p) \/ Restart(p)
    \/ MoveRoot

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
    /\ pc \in [Procs -> Phases]
    /\ spell \in [Procs -> Spellings]
    /\ root \in [Procs -> Inodes \cup {None}]
    /\ canon \in [Procs -> Names \cup {None}]
    /\ ledger \in [Procs -> BOOLEAN]
    /\ newChat \in [Procs -> BOOLEAN]
    /\ owner \in [Keys -> Procs \cup {None}]
    /\ atD \in Inodes \cup {None}
    /\ used \subseteq Inodes

\* Session q has the store in directory inode i open: past its lease, before releasing it.
Opened(q, i) == pc[q] \in OpenPhases /\ root[q] = i
Holds(p, i) == root[p] = i /\ owner[Key(p)] = p
\* A write into inode i is safe when its writer holds i's lease and no other session has i open.
WriteOK(w) == Holds(w.by, w.ino) /\ \A q \in Procs \ {w.by} : ~Opened(q, w.ino)

\* Two sessions never have the same store directory open at once.
ExclusiveOpen ==
    \A p, q \in Procs : (p # q /\ root[p] # None) => ~(Opened(p, root[p]) /\ Opened(q, root[p]))

\* Every Store write (logs, tree, images, view, open-time repair and GC) is made under the lease.
StoreWritesUnderLease == \A w \in wrote : w.via = "store" => WriteOK(w)

\* Every rules-ledger and metrics write lands in the directory its writer holds the lease of.
SidecarWritesUnderLease == \A w \in wrote : w.via = "sidecar" => WriteOK(w)

\* `/optchat new` never moves a store directory another session has open.
ArchiveOnlyClosed == \A r \in renamed : \A q \in Procs \ {r.by} : ~Opened(q, r.ino)

\* A lease belongs only to a live session that has that directory open: a dead or closed
\* session never blocks the next opener.
NoOrphanLease ==
    \A k \in Keys : owner[k] # None =>
        /\ pc[owner[k]] \in OpenPhases
        /\ Key(owner[k]) = k
=============================================================================
