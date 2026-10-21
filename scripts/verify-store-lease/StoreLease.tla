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
    Variant        \* "Current", or a named broken or fixed variant (Variants)

\* Current            the code as it is.
\* NoLease            broken: a failed bind (EADDRINUSE) is treated as acquired.
\* PathKey            broken: the lease is keyed by the path spelling, not dev:ino.
\* WriteBeforeLease   broken: the open-time writes run before the lease is taken.
\* NoCrashRelease     broken: a dead process keeps its lease (a lock file design).
\* LeakOnFailedOpen   broken: an open that fails after the lease does not release it.
\* LedgerAtInode      fixed design: ledger and metrics are written relative to rootFd.
\* ArchiveUnderLease  fixed design: `/optchat new` renames while still holding the
\*                    lease, and only if store.directory still names the leased inode.
Variants == {"Current", "NoLease", "PathKey", "WriteBeforeLease", "NoCrashRelease",
             "LeakOnFailedOpen", "LedgerAtInode", "ArchiveUnderLease"}

ASSUME Variant \in Variants /\ "D" \in Spellings /\ ExternalMove \in BOOLEAN

\* "D" names the configured directory. A directory moved away from D, by `mv` or by
\* `/optchat new`, keeps a name of its own; the model names it by its inode.
Names == {"D"} \cup Inodes
Keys  == Inodes \cup Spellings

VARIABLES
    pc,       \* each session's place in the code
    spell,    \* the path spelling the session passes to Store.open (config.directory)
    root,     \* inode behind the session's rootFd (store.ts:781, 346-355)
    canon,    \* store.directory: the name fdPath read at store.ts:785
    ledger,   \* the session's RuleLedger is open (index.ts:677)
    newChat,  \* this shutdown is `/optchat new` (index.ts:1653-1665)
    owner,    \* the kernel lease table: abstract socket names (Linux), flocks (macOS)
    atD,      \* the inode the configured path D names now, or None
    used,     \* inodes created so far
    wrote,    \* ghost: the write the last step made, a set of 0 or 1 records
    renamed,  \* ghost: the directory `/optchat new` moved to its archive in the last step
    last      \* ghost: the last step in the code's words; not part of a state's identity

vars == <<pc, spell, root, canon, ledger, newChat, owner, atD, used, wrote, renamed, last>>
View == <<pc, spell, root, canon, ledger, newChat, owner, atD, used, wrote, renamed>>

Phases == {"idle", "mkdir", "openroot", "fdpath", "acquire", "recover", "ledger",
           "open", "closing", "archive", "dead"}
\* Between taking the lease and releasing it: the session has the store open.
OpenPhases == {"recover", "ledger", "open", "closing"}
HoldPhases == OpenPhases \cup (IF Variant = "ArchiveUnderLease" THEN {"archive"} ELSE {})

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

\* index.ts:662 (session_start) or a reopen calls Store.open(config.directory); store.ts:771.
Start(p) ==
    /\ pc[p] = "idle"
    /\ \E s \in Spellings:
         /\ spell' = Set(spell, p, s)
         /\ last' = SayAt(p, "Store.open(config.directory) starts (index.ts:662, store.ts:771-781)", s)
    /\ pc' = Set(pc, p, "mkdir")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<root, canon, ledger, newChat, owner, atD, used>>

\* openRoot: makeDirectory(parent, basename(path)), EEXIST ignored (store.ts:350, 316-321).
\* A symlink spelling names an entry already (a dangling link too), so mkdir through it creates
\* nothing. Bound: once every inode is used, mkdir creates nothing and the next openat fails.
Mkdir(p) ==
    /\ pc[p] = "mkdir"
    /\ IF atD = None /\ spell[p] = "D" /\ used # Inodes
         THEN \E i \in Inodes \ used:
                /\ atD' = i
                /\ used' = used \cup {i}
                /\ last' = SayAt(p, "mkdir creates the store directory at D (store.ts:350, 318)", i)
         ELSE /\ UNCHANGED <<atD, used>>
              /\ last' = Say(p, "mkdir finds the entry present (EEXIST, store.ts:318-320), or the inode bound is reached")
    /\ pc' = Set(pc, p, "openroot")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, ledger, newChat, owner>>

\* openRoot: openDirectory(at(parent, basename(path)), follow) opens rootFd (store.ts:351, 304).
\* A symlink spelling resolves here, once.
OpenRootFd(p) ==
    /\ pc[p] = "openroot"
    /\ IF atD = None
         THEN /\ pc' = Set(pc, p, "idle")
              /\ UNCHANGED root
              /\ last' = Say(p, "openat finds no directory at D: Store.open throws ENOENT before any lease (store.ts:351)")
         ELSE /\ pc' = Set(pc, p, "fdpath")
              /\ root' = Set(root, p, atD)
              /\ last' = SayAt(p, "openat opens the directory at D as rootFd (store.ts:351, 304)", atD)
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, canon, ledger, newChat, owner, atD, used>>

\* canonical = fdPath(rootFd): the directory's current name, kept as store.directory (store.ts:785).
FdPath(p) ==
    /\ pc[p] = "fdpath"
    /\ canon' = Set(canon, p, NameOf(root[p]))
    /\ pc' = Set(pc, p, IF Variant = "WriteBeforeLease" THEN "recover" ELSE "acquire")
    /\ last' = SayAt(p, "fdPath(rootFd) names the directory; this becomes store.directory (store.ts:785)", NameOf(root[p]))
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, ledger, newChat, owner, atD, used>>

\* acquireLease (store.ts:387-425): one kernel step. Linux: listen on the abstract socket
\* omp-optchat-sha256(dev:ino) of rootFd (401-402, 422); macOS: flock(rootFd, LOCK_EX|LOCK_NB) (391).
\* A taken name fails EADDRINUSE / EWOULDBLOCK: StoreLeaseConflictError (395, 410-411), and
\* Store.open's catch closes rootFd only (804, 438-452).
Acquire(p) ==
    /\ pc[p] = "acquire"
    /\ IF owner[Key(p)] = None
         THEN /\ owner' = [owner EXCEPT ![Key(p)] = p]
              /\ pc' = Set(pc, p, IF Variant = "WriteBeforeLease" THEN "ledger" ELSE "recover")
              /\ UNCHANGED <<root, canon>>
              /\ last' = SayAt(p, "acquireLease binds the lease of its root inode (store.ts:401-422; macOS flock 391)", root[p])
         ELSE IF Variant = "NoLease"
         THEN /\ owner' = owner
              /\ pc' = Set(pc, p, "recover")
              /\ UNCHANGED <<root, canon>>
              /\ last' = SayAt(p, "bind fails EADDRINUSE and the open goes on anyway (broken variant NoLease)", root[p])
         ELSE /\ owner' = owner
              /\ pc' = Set(pc, p, "idle")
              /\ root' = Set(root, p, None)
              /\ canon' = Set(canon, p, None)
              /\ last' = SayAt(p, "bind fails EADDRINUSE: StoreLeaseConflictError, rootFd closed, nothing written (store.ts:410-411, 804)", root[p])
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, ledger, newChat, atD, used>>

\* Store.open after the lease: openStream mkdirs (787-790, 797), replay's torn-line repair
\* (904-909), collectGarbage unlinks (734-735, 717). All fd-relative to rootFd, no
\* assertWritable; the lease taken just before is their only guard.
Recover(p) ==
    /\ pc[p] = "recover"
    /\ wrote' = {StoreRec(p, root[p])}
    /\ pc' = Set(pc, p, IF Variant = "WriteBeforeLease" THEN "acquire" ELSE "ledger")
    /\ last' = SayAt(p, "open-time writes: mkdir main/tree/images, torn-line repair, garbage collection (store.ts:787-800)", root[p])
    /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, ledger, newChat, owner, atD, used>>

\* Store.open returns; OptChat opens RuleLedger at join(store.directory, "ledger.jsonl")
\* (index.ts:662, 677; system1/ledger.ts:59-61, 64-68). Replay only reads (ledger.ts:106-128).
LedgerOpen(p) ==
    /\ pc[p] = "ledger"
    /\ ledger' = Set(ledger, p, TRUE)
    /\ pc' = Set(pc, p, "open")
    /\ last' = SayAt(p, "Store.open returns; RuleLedger.open(store.directory) (index.ts:662, 677)", canon[p])
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, newChat, owner, atD, used>>

\* Store.open fails after the lease (a stream open or replay throws): the catch releases the
\* descriptors and the lease (store.ts:802-809); or RuleLedger.open throws and OptChat closes
\* the store (index.ts:683-686). Either way the session ends with no store and no lease.
OpenFails(p) ==
    /\ pc[p] \in {"recover", "ledger"}
    /\ owner' = IF Variant = "LeakOnFailedOpen" THEN owner ELSE Free(p)
    /\ pc' = Set(pc, p, "idle")
    /\ root' = Set(root, p, None)
    /\ canon' = Set(canon, p, None)
    /\ last' = IF Variant = "LeakOnFailedOpen"
               THEN Say(p, "the open fails after the lease and the lease stays held (broken variant LeakOnFailedOpen)")
               ELSE Say(p, "the open fails after the lease: the catch releases descriptors and lease (store.ts:802-809; index.ts:683-686)")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, ledger, newChat, atD, used>>

\* append / saveNode / saveImage / saveView: assertWritable (store.ts:812-820: not closed,
\* lease still bound), then one synchronous fd-relative write (915-936, 980-992, 1074-1084).
StoreWrite(p) ==
    /\ pc[p] = "open"
    /\ owner[Key(p)] = p
    /\ wrote' = {StoreRec(p, root[p])}
    /\ last' = SayAt(p, "append/saveNode/saveImage/saveView: assertWritable, then a synchronous fd-relative write (store.ts:812-820, 915-936)", root[p])
    /\ renamed' = {}
    /\ UNCHANGED <<pc, spell, root, canon, ledger, newChat, owner, atD, used>>

\* RuleLedger.write opens join(store.directory, "ledger.jsonl") by path for every event
\* (system1/ledger.ts:60, 141-156); OptChat.record appends to join(store.directory,
\* "metrics.jsonl") by path (index.ts:892-895, 2066; metrics.ts:137-146). Both resolve the
\* name anew each time; neither goes through rootFd.
SidecarWrite(p) ==
    /\ pc[p] = "open"
    /\ ledger[p]
    /\ LET target == IF Variant = "LedgerAtInode" THEN root[p] ELSE Resolve(canon[p])
       IN /\ wrote' = IF target = None THEN {} ELSE {[by |-> p, ino |-> target, via |-> "sidecar"]}
          /\ last' = IF Variant = "LedgerAtInode"
                     THEN SayAt(p, "ledger/metrics append relative to rootFd (fixed design LedgerAtInode)", target)
                     ELSE SayAt(p, "rules ledger and metrics appends open(join(store.directory, file), O_APPEND|O_CREAT) by path (system1/ledger.ts:145, metrics.ts:140): they land in the directory D names now", target)
    /\ renamed' = {}
    /\ UNCHANGED <<pc, spell, root, canon, ledger, newChat, owner, atD, used>>

\* OptChat.shutdown (index.ts:1611-1631): rules.close() (1619), store = undefined, then
\* store.close(): closed = true and every descriptor closed, synchronously (store.ts:1089-1090,
\* 443-447). For `/optchat new` (index.ts:1653) the archive follows.
Shutdown(p) ==
    /\ pc[p] = "open"
    /\ \E nc \in BOOLEAN:
         /\ newChat' = Set(newChat, p, nc)
         /\ last' = IF nc
                    THEN Say(p, "/optchat new: shutdown closes the rules ledger, then store.close sets closed and closes its descriptors (index.ts:1653, 1619, 1631; store.ts:1089, 443-447)")
                    ELSE Say(p, "session ends: shutdown closes the rules ledger, then store.close sets closed and closes its descriptors (index.ts:1619, 1631; store.ts:1089, 443-447)")
    /\ ledger' = Set(ledger, p, FALSE)
    /\ pc' = Set(pc, p, "closing")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, owner, atD, used>>

\* release, last step: closeLease -> server.close frees the socket name (store.ts:449-450,
\* 432-434); on macOS close(rootFd) at 447 drops the flock. Both follow the closes above.
Release(p) ==
    /\ pc[p] = "closing"
    /\ ~(newChat[p] /\ Variant = "ArchiveUnderLease")
    /\ owner' = Free(p)
    /\ pc' = Set(pc, p, IF newChat[p] THEN "archive" ELSE "idle")
    /\ root' = Set(root, p, None)
    /\ canon' = IF newChat[p] THEN canon ELSE Set(canon, p, None)
    /\ last' = Say(p, "closeLease frees the lease (store.ts:449-450, 432-434; macOS close(rootFd) 447): nothing holds the directory from here")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, ledger, newChat, atD, used>>

\* Fixed design ArchiveUnderLease only: keep the lease until the archive rename is done.
HoldForArchive(p) ==
    /\ Variant = "ArchiveUnderLease"
    /\ pc[p] = "closing"
    /\ newChat[p]
    /\ pc' = Set(pc, p, "archive")
    /\ last' = Say(p, "fixed design: keep the lease until the archive rename is done")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, ledger, newChat, owner, atD, used>>

\* startNewChat: archiveStoreDirectory(directory) claims the archive name with mkdir and renames
\* the directory that path names now (index.ts:1639, 1654; store.ts:645-672); then reopens the
\* configured path (index.ts:1665, 1688-1692). A failed rename reopens too (index.ts:1656).
Archive(p) ==
    /\ pc[p] = "archive"
    /\ LET target  == Resolve(canon[p])
           allowed == Variant # "ArchiveUnderLease" \/ target = root[p]
           moves   == target # None /\ allowed
       IN /\ renamed' = IF moves THEN {[by |-> p, ino |-> target]} ELSE {}
          /\ atD' = IF moves /\ canon[p] = "D" THEN None ELSE atD
          /\ last' = IF moves
                     THEN SayAt(p, "archiveStoreDirectory(store.directory) renames the directory that path names now to the archive (index.ts:1654; store.ts:649, 655); then the chat reopens D (index.ts:1665)", target)
                     ELSE Say(p, "no archive rename happens (no directory there, or the fixed design refuses); the chat reopens D (index.ts:1656)")
    /\ owner' = IF Variant = "ArchiveUnderLease" THEN Free(p) ELSE owner
    /\ pc' = Set(pc, p, "mkdir")
    /\ root' = Set(root, p, None)
    /\ canon' = Set(canon, p, None)
    /\ newChat' = Set(newChat, p, FALSE)
    /\ wrote' = {}
    /\ UNCHANGED <<spell, ledger, used>>

\* Process death anywhere: the kernel closes the socket and every descriptor, so the lease
\* goes with it (store.ts:420-421, 743-745). No further step of this process happens.
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
               ELSE Say(p, "the process dies; the kernel frees its socket name and descriptors (store.ts:420-421)")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, atD, used>>

Restart(p) ==
    /\ pc[p] = "dead"
    /\ pc' = Set(pc, p, "idle")
    /\ last' = Say(p, "a new OMP session starts")
    /\ wrote' = {} /\ renamed' = {}
    /\ UNCHANGED <<spell, root, canon, ledger, newChat, owner, atD, used>>

\* A user moves the open store directory; the Store follows its inode (store.ts:343-345,
\* 494-496, 747-748; tests/store.test.ts:1032-1043, 1253-1254).
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
         \/ Shutdown(p) \/ Release(p) \/ HoldForArchive(p) \/ Archive(p)
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
        /\ pc[owner[k]] \in HoldPhases
        /\ Key(owner[k]) = k
=============================================================================
