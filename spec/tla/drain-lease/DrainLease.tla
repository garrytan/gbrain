---------------------------- MODULE DrainLease ----------------------------
(***************************************************************************)
(* The managed-sync drain lease: one drainer per source at a time.         *)
(*                                                                         *)
(* Code: src/core/persistence/sync-lease.ts (withDrainLease,               *)
(* assertDrainLease, inFencedSlices) over src/core/db-lock.ts              *)
(* (tryAcquireDbLock, withRefreshingLock). The lease is one row of         *)
(* gbrain_cycle_locks; its acquisition_token is the fencing token.         *)
(* Postgres only: PGLite is one connection and renews in-process.          *)
(*                                                                         *)
(* Time is a discrete clock of TickMs. Every duration is derived from the  *)
(* code's millisecond constants, which the .cfg files carry and            *)
(* test/spec-drain-lease-constants.test.ts checks against the code.        *)
(*                                                                         *)
(* An awake holder owes its timers: the clock does not pass a renewal that *)
(* is due, a renewal that can land, a renewal timeout, its local lease     *)
(* deadline, or a fenced transaction at its bound (MaxTxMs). A holder that *)
(* sleeps (machine asleep, event loop blocked) owes nothing. That makes    *)
(* "a live holder keeps its lease" an invariant (NoSpuriousLapse), the     *)
(* property #7415 broke, conditional on the stated timing assumptions.     *)
(* The fence takes the row FOR KEY SHARE (#7442): that holds off the       *)
(* takeover upsert and DELETEs, which write the key, but not the renewal.  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Procs,            \* drainer processes, all on one host (the worst case for the pid probe)
  Lanes,            \* fenced transactions one holder may have open at once
  TickMs,           \* one clock tick
  TtlMs,            \* DRAIN_LEASE_TTL_MINUTES * 60000
  RefreshMs,        \* DRAIN_LEASE_REFRESH_MS
  RenewTimeoutMs,   \* withRefreshingLock: min(30000, ttl / 3)
  StealGraceMs,     \* resolveStealGraceSeconds(ttl) * 1000
  TakeoverGraceMs,  \* HOLDER_TAKEOVER_GRACE_MS
  MaxTxMs,          \* the longest a fenced transaction stays open; since #7442 a bound the renewal does not depend on
  CancelMs,         \* assumption: the longest a timed-out renewal takes to settle once cancelled (the database answers the cancel)
  RenewalWinsGap,   \* a waiting renewal gets the row before the holder's next fenced transaction begins (FALSE drops it)
  UnsafeSteals,     \* a pid probe that calls a live holder dead (pid namespaces sharing a hostname), or --force-break-lock
  Stamps,           \* model the pass stamp's fence: a coordinator transaction that takes the row FOR KEY SHARE by a stamped token
  MaxTime, MaxTokens, MaxCursor, MaxSleeps, MaxCrashes

CeilDiv(a, b) == (a + b - 1) \div b
\* Rounded so the model is never kinder to the code than the code is.
TTL      == TtlMs \div TickMs
Refresh  == CeilDiv(RefreshMs, TickMs)
RenewTO  == CeilDiv(RenewTimeoutMs, TickMs)
Grace    == StealGraceMs \div TickMs
PidGrace == TakeoverGraceMs \div TickMs
MaxTx    == CeilDiv(MaxTxMs, TickMs)
Cancel   == CeilDiv(CancelMs, TickMs)
LaneIds  == 1..Lanes
None     == 0

VARIABLES
  now,                          \* database clock (ticks)
  rowTok, rowExp, rowRef, rowAcq, \* the lock row: token (None = no row), ttl_expires_at, last_refreshed_at, acquired_at
  cursor,                       \* the sync checkpoint each fenced commit advances
  nextTok,                      \* next acquisition token
  pc,                           \* "idle" | "holding" | "asleep"
  tok,                          \* the token this process holds
  aborted,                      \* its lease AbortSignal fired (LockStolenError)
  deadline,                     \* local lease deadline: the confirmed renewal's request start + TTL
  nextRenew,                    \* next refresh interval tick
  renewAt,                      \* start of the in-flight renewal (None = none); its statement's now()
  cancelling,                   \* the in-flight renewal timed out: cancelled, not yet settled
  txAt,                         \* [p][lane] start tick + 1 of an open fenced transaction; None = closed
  txRead,                       \* [p][lane] the cursor it read under the fence
  disturbed,                    \* ghost: this process slept while holding its current lease
  stampTok, stampAt,            \* the coordinator's open pass-stamp transaction: the token it fenced on (None = none), start + 1
  sleeps, crashes

vars == <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, pc, tok, aborted, deadline, nextRenew,
          renewAt, cancelling, txAt, txRead, disturbed, stampTok, stampAt, sleeps, crashes>>
local == <<pc, tok, aborted, deadline, nextRenew, renewAt, cancelling, txAt, txRead, disturbed>>

Closed == [l \in LaneIds |-> None]
OpenTx(p) == {l \in LaneIds : txAt[p][l] # None}
Renewing(p) == renewAt[p] # None
\* Processes holding the lock row FOR KEY SHARE.
Sharers == {p \in Procs : OpenTx(p) # {}}
\* The coordinator's pass-stamp transaction holds it FOR KEY SHARE.
StampSharing == stampTok # None
\* Anything holds the row FOR KEY SHARE: a DELETE, or an UPDATE that writes the key (the takeover upsert), waits.
RowShared == Sharers # {} \/ StampSharing

TypeOK ==
  /\ now \in 0..MaxTime /\ rowTok \in 0..MaxTokens /\ cursor \in 0..MaxCursor
  /\ pc \in [Procs -> {"idle", "holding", "asleep"}] /\ tok \in [Procs -> 0..MaxTokens]
  /\ aborted \in [Procs -> BOOLEAN] /\ disturbed \in [Procs -> BOOLEAN]

Init ==
  /\ now = 0 /\ rowTok = None /\ rowExp = 0 /\ rowRef = 0 /\ rowAcq = 0 /\ cursor = 0 /\ nextTok = 1
  /\ pc = [p \in Procs |-> "idle"] /\ tok = [p \in Procs |-> None] /\ aborted = [p \in Procs |-> FALSE]
  /\ deadline = [p \in Procs |-> 0] /\ nextRenew = [p \in Procs |-> 0] /\ renewAt = [p \in Procs |-> None]
  /\ cancelling = [p \in Procs |-> FALSE]
  /\ txAt = [p \in Procs |-> Closed] /\ txRead = [p \in Procs |-> Closed]
  /\ disturbed = [p \in Procs |-> FALSE] /\ stampTok = None /\ stampAt = None /\ sleeps = 0 /\ crashes = 0

(* A process's state once it no longer holds anything. *)
Reset(p) ==
  /\ pc' = [pc EXCEPT ![p] = "idle"] /\ tok' = [tok EXCEPT ![p] = None]
  /\ aborted' = [aborted EXCEPT ![p] = FALSE] /\ disturbed' = [disturbed EXCEPT ![p] = FALSE]
  /\ deadline' = [deadline EXCEPT ![p] = 0] /\ nextRenew' = [nextRenew EXCEPT ![p] = 0]
  /\ renewAt' = [renewAt EXCEPT ![p] = None] /\ cancelling' = [cancelling EXCEPT ![p] = FALSE]
  /\ txAt' = [txAt EXCEPT ![p] = Closed] /\ txRead' = [txRead EXCEPT ![p] = Closed]

(***************************************************************************)
(* tryAcquireDbLock. The upsert inserts, or takes over a row whose TTL     *)
(* expired and whose last refresh is older than the steal grace; the       *)
(* takeover's upsert writes the key (SET id = EXCLUDED.id), so it waits   *)
(* for every FOR KEY SHARE.                                                *)
(***************************************************************************)
Expired == rowExp < now
TakeoverAllowed == Expired /\ rowRef + Grace < now

Grant(p) ==
  /\ rowTok' = nextTok /\ rowExp' = now + TTL /\ rowRef' = now /\ rowAcq' = now /\ nextTok' = nextTok + 1
  /\ pc' = [pc EXCEPT ![p] = "holding"] /\ tok' = [tok EXCEPT ![p] = nextTok]
  /\ deadline' = [deadline EXCEPT ![p] = now + TTL] /\ nextRenew' = [nextRenew EXCEPT ![p] = now + Refresh]
  /\ UNCHANGED <<now, cursor, aborted, renewAt, cancelling, txAt, txRead, disturbed, stampTok, stampAt, sleeps, crashes>>

Acquire(p) ==
  /\ pc[p] = "idle" /\ nextTok <= MaxTokens
  /\ rowTok = None \/ (~RowShared /\ TakeoverAllowed)
  /\ Grant(p)

(***************************************************************************)
(* tryAcquireDbLock's second path (#1780), and --break-lock's safe path: a *)
(* row that has not expired, whose same-host pid the probe calls dead and  *)
(* that is older than the takeover grace, is DELETEd by pid and token      *)
(* (waiting for every FOR KEY SHARE) and the upsert retried. An honest     *)
(* probe calls dead only a holder that is gone.                            *)
(***************************************************************************)
RowOwnerLive == \E q \in Procs : pc[q] # "idle" /\ tok[q] = rowTok

DeadPidTakeover(p) ==
  /\ pc[p] = "idle" /\ nextTok <= MaxTokens
  /\ rowTok # None /\ ~Expired /\ ~RowShared /\ now >= rowAcq + PidGrace
  /\ UnsafeSteals \/ ~RowOwnerLive
  /\ Grant(p)

(***************************************************************************)
(* withRefreshingLock's interval: one renewal in flight; a tick that finds *)
(* one in flight skips it. Nothing is renewed after loss.                  *)
(***************************************************************************)
RenewDue(p) == pc[p] = "holding" /\ ~aborted[p] /\ now >= nextRenew[p]

StartRenew(p) ==
  /\ RenewDue(p)
  /\ renewAt' = IF Renewing(p) THEN renewAt ELSE [renewAt EXCEPT ![p] = now]
  /\ nextRenew' = [nextRenew EXCEPT ![p] = now + Refresh]
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, pc, tok, aborted, deadline,
                 cancelling, txAt, txRead, disturbed, stampTok, stampAt, sleeps, crashes>>

(* UPDATE ... WHERE id AND holder_pid AND acquisition_token writes no key    *)
(* column, so FOR KEY SHARE does not block it (#7442): the renewal lands     *)
(* while fenced transactions and the pass stamp hold the row.                *)
RenewCanLand(p) == pc[p] = "holding" /\ Renewing(p)
RenewMatches(p) == rowTok = tok[p]

(* The UPDATE lands once the row is free. Its now() is the statement's start, so the row's expiry and   *)
(* last refresh count from the request, not from the moment it got the row. A renewal that timed out   *)
(* and lands anyway extends the row but never the holder's local authority.                            *)
RenewLand(p) ==
  /\ RenewCanLand(p)
  /\ renewAt' = [renewAt EXCEPT ![p] = None] /\ cancelling' = [cancelling EXCEPT ![p] = FALSE]
  /\ IF RenewMatches(p)
       THEN /\ rowExp' = renewAt[p] + TTL /\ rowRef' = renewAt[p]
            /\ deadline' = [deadline EXCEPT ![p] = IF aborted[p] \/ cancelling[p] THEN @ ELSE renewAt[p] + TTL]
            /\ UNCHANGED aborted
       ELSE /\ aborted' = [aborted EXCEPT ![p] = IF cancelling[p] THEN @ ELSE TRUE]
            /\ UNCHANGED <<rowExp, rowRef, deadline>>
  /\ UNCHANGED <<now, rowTok, rowAcq, cursor, nextTok, pc, tok, nextRenew, txAt, txRead, disturbed, stampTok, stampAt, sleeps, crashes>>

(* withRefreshingLock's timeout aborts a renewal still waiting on the row; the cancellation settles     *)
(* later (CancelSettle, within CancelMs), the clock keeps running meanwhile, and no new renewal starts  *)
(* until it has.                                                                                       *)
RenewTimeoutDue(p) == pc[p] = "holding" /\ Renewing(p) /\ ~cancelling[p] /\ RowShared /\ now >= renewAt[p] + RenewTO

RenewTimeout(p) ==
  /\ RenewTimeoutDue(p)
  /\ cancelling' = [cancelling EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, pc, tok, aborted, deadline, nextRenew,
                 renewAt, txAt, txRead, disturbed, stampTok, stampAt, sleeps, crashes>>

(* The cancelled statement ends having changed nothing (it never got the row). It is owed only once    *)
(* CancelMs has passed since the cancel.                                                                *)
CancelDue(p) == pc[p] = "holding" /\ Renewing(p) /\ cancelling[p] /\ now >= renewAt[p] + RenewTO + Cancel

CancelSettle(p) ==
  /\ pc[p] = "holding" /\ Renewing(p) /\ cancelling[p]
  /\ renewAt' = [renewAt EXCEPT ![p] = None] /\ cancelling' = [cancelling EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, pc, tok, aborted, deadline, nextRenew,
                 txAt, txRead, disturbed, stampTok, stampAt, sleeps, crashes>>

(* The expiry timer: the TTL passed with no confirmed renewal. *)
DeadlineDue(p) == pc[p] = "holding" /\ ~aborted[p] /\ now >= deadline[p]

LocalDeadline(p) ==
  /\ DeadlineDue(p)
  /\ aborted' = [aborted EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, pc, tok, deadline, nextRenew, renewAt, cancelling,
                 txAt, txRead, disturbed, stampTok, stampAt, sleeps, crashes>>

(***************************************************************************)
(* assertDrainLease, in each transaction that admits work or swaps the     *)
(* cursor: refuse when the signal aborted, else SELECT the row WHERE token *)
(* matches AND ttl_expires_at > now() FOR KEY SHARE (fenceLockRow).       *)
(***************************************************************************)
FenceSignal(p) == ~aborted[p]
FenceToken(p)  == rowTok = tok[p]
FenceExpiry    == rowExp > now
FencePasses(p) == FenceSignal(p) /\ FenceToken(p) /\ FenceExpiry
\* Under FOR SHARE (before #7442) a waiting renewal landed between serial fenced transactions but could starve under
\* overlapping ones; RenewalWinsGap = TRUE models that queue. With FOR KEY SHARE the renewal does not wait on the fence,
\* and DrainLease.cfg sets RenewalWinsGap = FALSE.
FenceQueue(p)  == RenewalWinsGap => (~Renewing(p) \/ RowShared)

BeginFenced(p, l) ==
  /\ pc[p] = "holding" /\ txAt[p][l] = None /\ cursor < MaxCursor
  /\ FencePasses(p) /\ FenceQueue(p)
  /\ txAt' = [txAt EXCEPT ![p][l] = now + 1]
  /\ txRead' = [txRead EXCEPT ![p][l] = cursor]
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, pc, tok, aborted, deadline, nextRenew,
                 renewAt, cancelling, disturbed, stampTok, stampAt, sleeps, crashes>>

TxDue(p) == pc[p] = "holding" /\ \E l \in OpenTx(p) : now + 1 >= txAt[p][l] + MaxTx

(* The transaction commits. Lane 1 is the pass's cursor transaction: the cursor advances from the  *)
(* value it read under the fence. Other lanes admit work and leave the cursor to lane 1.           *)
Commit(p, l) ==
  /\ pc[p] = "holding" /\ txAt[p][l] # None
  /\ cursor' = IF l = 1 THEN txRead[p][l] + 1 ELSE cursor
  /\ txAt' = [txAt EXCEPT ![p][l] = None] /\ txRead' = [txRead EXCEPT ![p][l] = None]
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, nextTok, pc, tok, aborted, deadline, nextRenew, renewAt, cancelling,
                 disturbed, stampTok, stampAt, sleeps, crashes>>

Rollback(p, l) ==
  /\ pc[p] = "holding" /\ txAt[p][l] # None
  /\ txAt' = [txAt EXCEPT ![p][l] = None] /\ txRead' = [txRead EXCEPT ![p][l] = None]
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, pc, tok, aborted, deadline, nextRenew,
                 renewAt, cancelling, disturbed, stampTok, stampAt, sleeps, crashes>>

(***************************************************************************)
(* The pass stamp's fence (provenStamp, applyPassCheckpoint): the write    *)
(* coordinator, possibly another process, SELECTs the row WHERE the token  *)
(* stamped on the request matches AND ttl_expires_at > now() FOR KEY SHARE *)
(* with no lease signal to check. The token may be any issued one (a stale *)
(* request). A holder's crash does not end it.                             *)
(***************************************************************************)
StampToken(t)  == rowTok = t
StampQueue     == RenewalWinsGap => (\A q \in Procs : Renewing(q) => RowShared)

StampBegin(t) ==
  /\ Stamps /\ stampTok = None
  /\ StampToken(t) /\ FenceExpiry /\ StampQueue
  /\ stampTok' = t /\ stampAt' = now + 1
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, sleeps, crashes>> /\ UNCHANGED local

StampEnd ==
  /\ stampTok # None
  /\ stampTok' = None /\ stampAt' = None
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, sleeps, crashes>> /\ UNCHANGED local

StampDue == stampTok # None /\ now + 1 >= stampAt + MaxTx

(***************************************************************************)
(* The pass ends, done or refused (a failed fence throws LockStolenError): *)
(* withRefreshingLock's finally waits for the in-flight renewal, then      *)
(* DELETEs WHERE holder_pid AND token, which needs the row exclusively.    *)
(***************************************************************************)
ReleaseMatches(p) == rowTok = tok[p]

Release(p) ==
  /\ pc[p] = "holding" /\ OpenTx(p) = {} /\ ~Renewing(p) /\ ~RowShared
  /\ rowTok' = IF ReleaseMatches(p) THEN None ELSE rowTok
  /\ Reset(p)
  /\ UNCHANGED <<now, rowExp, rowRef, rowAcq, cursor, nextTok, stampTok, stampAt, sleeps, crashes>>

(***************************************************************************)
(* Environment: a holder sleeps (machine asleep, event loop blocked), with *)
(* or without a transaction open (the server keeps it open and its FOR    *)
(* SHARE held), and later wakes; a process crashes, rolling back its open *)
(* transactions and leaving its row to expire.                            *)
(***************************************************************************)
Sleep(p) ==
  /\ pc[p] = "holding" /\ sleeps < MaxSleeps
  /\ pc' = [pc EXCEPT ![p] = "asleep"] /\ disturbed' = [disturbed EXCEPT ![p] = TRUE] /\ sleeps' = sleeps + 1
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, tok, aborted, deadline, nextRenew,
                 renewAt, cancelling, txAt, txRead, stampTok, stampAt, crashes>>

Wake(p) ==
  /\ pc[p] = "asleep"
  /\ pc' = [pc EXCEPT ![p] = "holding"]
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, tok, aborted, deadline, nextRenew,
                 renewAt, cancelling, txAt, txRead, disturbed, stampTok, stampAt, sleeps, crashes>>

Crash(p) ==
  /\ pc[p] # "idle" /\ crashes < MaxCrashes
  /\ Reset(p) /\ crashes' = crashes + 1
  /\ UNCHANGED <<now, rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, stampTok, stampAt, sleeps>>

(* What an awake holder owes before the clock moves. *)
Owes(p) == RenewDue(p) \/ RenewCanLand(p) \/ RenewTimeoutDue(p) \/ CancelDue(p) \/ DeadlineDue(p) \/ TxDue(p)

Tick ==
  /\ now < MaxTime /\ \A p \in Procs : ~Owes(p) /\ ~StampDue
  /\ now' = now + 1
  /\ UNCHANGED <<rowTok, rowExp, rowRef, rowAcq, cursor, nextTok, stampTok, stampAt, sleeps, crashes>> /\ UNCHANGED local

(* The exploration bound: at MaxTime the behavior may stop. A state before it with no step is a deadlock. *)
Done == now = MaxTime /\ UNCHANGED vars

Next ==
  \/ Tick
  \/ Done
  \/ StampEnd
  \/ \E t \in 1..MaxTokens : StampBegin(t)
  \/ \E p \in Procs :
       \/ Acquire(p) \/ DeadPidTakeover(p) \/ StartRenew(p) \/ RenewLand(p) \/ RenewTimeout(p)
       \/ CancelSettle(p) \/ LocalDeadline(p) \/ Release(p) \/ Sleep(p) \/ Wake(p) \/ Crash(p)
       \/ \E l \in LaneIds : BeginFenced(p, l) \/ Commit(p, l) \/ Rollback(p, l)

Spec == Init /\ [][Next]_vars

Symm == Permutations(Procs)

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
\* Every open fenced transaction belongs to the row's current holder, so every commit is made under the live lease.
FencedTxnsMatchRow ==
  /\ \A p \in Procs : OpenTx(p) # {} => rowTok = tok[p]
  /\ stampTok # None => rowTok = stampTok

\* At most one process has fenced work open.
OneDrainer == Cardinality(Sharers) <= 1

\* A live holder (one that has not slept while holding) never loses its lease.
NoSpuriousLapse == \A p \in Procs : aborted[p] => disturbed[p]

\* The sync cursor never moves backward.
CursorMonotone == [][cursor' >= cursor]_vars
=============================================================================
