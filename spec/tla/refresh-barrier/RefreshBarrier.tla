---------------------------- MODULE RefreshBarrier ----------------------------
(***************************************************************************)
(* The refresh write barrier and its deferred-write queue.                 *)
(*                                                                         *)
(* Code (docs/designs/REFRESH_WRITE_BARRIER.md):                           *)
(*   admission   src/core/persistence/journal.ts assertWorktreeAdmission,  *)
(*               assertWorktreeNotRefreshing, admitWrite                   *)
(*   claim       journal.ts claimNextWrite, claimableWriteSql,             *)
(*               EARLIER_HEAD / EARLIER_DEFERRED, RELEASED_DEFERRED        *)
(*               (worktree-refresh-schema.ts), the v292 guard trigger      *)
(*   replay      refresh-barrier.ts deferredReplayRefusal, then            *)
(*               coordinator.ts publishMutation                            *)
(*   refresh     worktree-refresh.ts fenceDraining, fenceAndMerge,         *)
(*               bookkeeping, syncMembers, resumeOrAbandon, transition     *)
(*   expiry      refresh-barrier.ts expireDeferredWrites                   *)
(*   restore     shared-skills/restore.ts quarantineSharedSkillRestore     *)
(* and, behind constants, the stacked follow-ups: ImportHolds and          *)
(* RecoveryDefers (import-deferral.ts holdForImport, the import expiry),   *)
(* AdoptLocalEdits (local-edit-adoption.ts adoptLocalEdit).                *)
(*                                                                         *)
(* One managed worktree holding one page P whose canonical file is F. The *)
(* writes are single-page writes to P. Database row locks are modelled per *)
(* transaction with Postgres's four row-lock modes; a transaction holds    *)
(* its locks until it commits. A waits-for cycle is a deadlock: Postgres   *)
(* aborts one side (40P01), so NoDeadlock is a safety property.            *)
(* Rows: the persistence_brain singleton, the worktree row, the source row *)
(* (sources), the counter rows (one lock: lockCounters takes them in key   *)
(* order), each refresh row and each request row.                          *)
(*                                                                         *)
(* A transaction's writes are applied at its commit step. Reads of rows it *)
(* holds locked are taken there too (nothing else can change them); a read *)
(* of an unlocked row is taken at the step that issues it, as READ         *)
(* COMMITTED does.                                                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  NW,               \* single-page writes 1..NW, in the order producers may submit them
  Blind,            \* the writes that are blind put_page; the rest carry expected_revision
  MaxRefreshes,     \* refreshes, one at a time
  MaxForeign,       \* commits to F by another agent with plain git (a pending import until sync imports them)
  MaxLocalEdits,    \* uncommitted edits to F in the worktree
  ImportHolds,      \* #8705: a claimed write refused pending_import is moved back to deferred until the import lands
  HeldImportBlocks, \* a write held for an import blocks later writes of its worktree (the claim's FIFO rule); FALSE as coded
  ImportExpiryLocksSource, \* the import expiry re-checks last_commit under a lock on the source row; FALSE as coded
  RecoveryDefers,   \* #8705: admission defers behind a refresh in recovery_required instead of refusing
  AdoptLocalEdits,  \* #8708: a drift refusal on a one-sided local edit adopts the edit and prepares the write again
  MayRestore,       \* a shared-skill restore may run once
  MayRevoke         \* the writers' credential may be revoked once

Writes == 1..NW
Refs   == 1..MaxRefreshes
None   == 0
MaxHead == 1 + 2 * NW + MaxForeign + MaxRefreshes

\* Lockable rows. Every id is a pair so TLC compares like with like.
BRAIN == <<"brain", 0>>
WT    == <<"wt", 0>>
SRC   == <<"src", 0>>
CTR   == <<"ctr", 0>>
REF(i) == <<"ref", i>>
REQ(w) == <<"req", w>>
Rows == {BRAIN, WT, SRC, CTR} \cup {REF(i) : i \in Refs} \cup {REQ(w) : w \in Writes}

\* Processes. One admission per write (its producer), one owner consumer, the refresher, the owner's housekeeping
\* (expiry) and managed sync.
ADM(w) == <<"adm", w>>
CONS  == <<"cons", 0>>
RFR   == <<"ref", 0>>
EXP   == <<"exp", 0>>
SYN   == <<"sync", 0>>
Procs == {ADM(w) : w \in Writes} \cup {CONS, RFR, EXP, SYN}

\* Postgres row-lock modes: FOR KEY SHARE, FOR SHARE, FOR NO KEY UPDATE (also any UPDATE that writes no key), FOR UPDATE.
Modes == {"-", "KS", "S", "NKU", "U"}
Conflict(a, b) ==
  IF a = "-" \/ b = "-" THEN FALSE
  ELSE IF a = "U" \/ b = "U" THEN TRUE
  ELSE IF a = "KS" \/ b = "KS" THEN FALSE
  ELSE ~(a = "S" /\ b = "S")
Rank(m) == CASE m = "-" -> 0 [] m = "KS" -> 1 [] m = "S" -> 2 [] m = "NKU" -> 3 [] m = "U" -> 4
Stronger(a, b) == IF Rank(a) >= Rank(b) THEN a ELSE b

Terminal == {"committed", "conflict", "failed", "cancelled"}
Open     == {"queued", "deferred", "running"}
RefActive == {"draining", "fenced", "merged", "syncing", "recovery"}

VARIABLES
  \* requests (persistence_requests)
  st,          \* "new" (not submitted) | "refused" (never journaled) | queued | deferred | running | a terminal state
  code,        \* the receipt's outcome code once terminal
  seq, nseq,   \* admission sequence
  dref,        \* deferred_refresh_id (None = NULL)
  dimp,        \* deferred_import_from: the last imported commit a held write waits past (None = NULL)
  applied,     \* times the write was applied to the page
  cpos, ncommit, \* commit order
  expRev,      \* the revision an expected_revision write read before submitting
  overdue,     \* created_at is past persistence.refresh_barrier_max_wait_ms
  adopted,     \* the write already adopted a local edit (its adoption request id is derived from it)
  \* refreshes (persistence_worktree_refreshes)
  rstate,      \* "none" | draining | fenced | merged | syncing | recovery (recovery_required) | completed | aborted
  rel,         \* released_at IS NOT NULL
  rchg,        \* the refresh's fast-forward changes F
  rhead,       \* old_head
  rmoved,      \* the refresh changed F in the checkout (git diff old_head target_head names F)
  cur,         \* the active refresh (None when none)
  nref,
  \* git and the page
  head, verAt, \* HEAD's commit index; the version of F each commit holds
  fileV,       \* F as committed at HEAD
  dbV,         \* the page's current revision (as a version of F)
  hist,        \* every version that was ever a revision of the page (page history)
  lastCommit,  \* sources.last_commit: the commit managed sync last imported
  local,       \* an uncommitted edit of F in the worktree (None = clean)
  nver, nforeign, nlocal,
  \* environment
  restored, revoked, preRestore,
  \* ghosts for safety properties that talk about a moment
  hidden,      \* a write replaced a committed version of F the page never had
  badExpiry,   \* a write ended *_expired although it no longer waited
  badRelease,  \* a deferred write committed before its refresh was released
  badDefer,    \* a write was deferred to a refresh that was already released
  badRevoke,   \* a write committed after its credential was revoked
  \* locks
  held, want,
  \* process locals
  pc, cw, cprep, cfin, ew, aref, aread, passHead

reqv   == <<st, code, seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, overdue, adopted>>
refv   == <<rstate, rel, rchg, rhead, rmoved, cur, nref>>
gitv   == <<head, verAt, fileV, dbV, hist, lastCommit, local, nver, nforeign, nlocal>>
envv   == <<restored, revoked, preRestore>>
ghostv == <<hidden, badExpiry, badRelease, badDefer, badRevoke>>
lockv  == <<held, want>>
procv  == <<pc, cw, cprep, cfin, ew, aref, aread, passHead>>
vars   == <<reqv, refv, gitv, envv, ghostv, lockv, procv>>

NoLocks == [r \in Rows |-> "-"]
\* TLC splits a disjunction inside an action into branches, so a guard on cur is written as a conjunction.
RefIs(S) == cur # None /\ rstate[cur] \in S
Worktree == IF local # None THEN local ELSE fileV
Free(p, r, m) == \A q \in Procs \ {p} : ~Conflict(m, held[q][r])
L(r, m) == <<r, m>>

\* ---------------------------------------------------------------------------
\* Guards. Each mutant in mutants.json replaces one of these definitions.
\* ---------------------------------------------------------------------------

\* drainCounts (worktree-refresh.ts): queued, running and recovering rows, and released deferred rows.
DrainCounts(w) == st[w] \in {"queued", "running"}
\* RELEASED_DEFERRED: a deferred row whose holds are all released is waiting work like a queued row.
Released(w) == /\ st[w] = "deferred"
               /\ (dref[w] # None \/ dimp[w] # None)
               /\ IF dref[w] = None THEN TRUE ELSE rel[dref[w]]
               /\ IF dimp[w] = None THEN TRUE ELSE lastCommit # dimp[w]
\* refreshFenceClear: nothing on a worktree is claimed while its refresh holds the fence or awaits recovery.
FenceClear == ~RefIs({"fenced", "merged", "recovery"})
\* claimableWriteSql: queued, or deferred with every hold released.
ClaimState(w) == st[w] = "queued" \/ Released(w)
\* EARLIER_HEAD (queued, running, recovering) and EARLIER_DEFERRED (released deferred): a write never passes an earlier one.
Blocks(e) == st[e] \in {"queued", "running"} \/ Released(e) \/ (HeldImportBlocks /\ st[e] = "deferred" /\ dimp[e] # None)
\* The v292 trigger: a deferred row moves to running only when its refresh (and, since v291, its import) is released.
TriggerAllows(w) == st[w] # "deferred" \/ Released(w)
\* deferredReplayRefusal: a refresh that changed the write's file ends it revision_conflict.
ReplayDiff(i) == rmoved[i]
\* deferredReplayRefusal re-runs authorizeWrite; publication's authorizeStoredRequest re-runs it as well.
ReplayAuth == TRUE
PublishAuth == TRUE
\* compareFileTarget (page-prepare.ts): a file that differs from the page refuses (pending_import, local edit, drift).
PrepRefusesDrift == TRUE
\* Admission locks the active refresh row FOR NO KEY UPDATE right after the worktree row.
AdmRefLock(i) == <<L(REF(i), "NKU")>>
\* Claims declare the protocol (the brain row FOR SHARE) before they read and claim.
ClaimLocks == <<L(BRAIN, "S")>>
\* fenceAndMerge re-counts the drain under its locks.
FenceRecount == TRUE
\* expireDeferredWrites: the protocol declaration (brain FOR SHARE), then the refresh row, then completeWrite's counters and request.
ExpiryLocks(i, w) == <<L(BRAIN, "S"), L(REF(i), "NKU"), L(CTR, "U"), L(REQ(w), "U")>>
\* ... and the refresh row is re-read under its lock: released_at IS NULL.
ExpiryRecheck(i) == ~rel[i]
\* With ImportExpiryLocksSource: the protocol declaration (brain FOR SHARE), then the source row FOR SHARE, before the recheck.
ImportExpiryLocks == <<L(BRAIN, "S"), L(SRC, "S")>>
\* The import expiry's recheck that the row is still held for an import that has not landed.
ImportExpiryRecheck(w) == st[w] = "deferred" /\ lastCommit = dimp[w]
\* The v292 release trigger stamps released_at on every move into completed or aborted.
ReleaseOn(s) == s \in {"completed", "aborted"}
\* quarantineSharedSkillRestore cancels every open request.
RestoreCancels == {"queued", "deferred", "running"}
\* adoptionIntent: only a one-sided edit (HEAD still holds the page's copy) is adopted.
AdoptOneSided == fileV = dbV

\* ---------------------------------------------------------------------------

Claimable(w) == /\ ClaimState(w)
                /\ FenceClear
                /\ ~\E e \in Writes : seq[e] # 0 /\ seq[e] < seq[w] /\ Blocks(e)
DrainZero == /\ \A w \in Writes : ~DrainCounts(w) /\ ~Released(w)
             /\ pc[SYN] = "idle"   \* a sync pass in flight is queued work too

TypeOK ==
  /\ st \in [Writes -> {"new", "refused"} \cup Open \cup Terminal]
  /\ dref \in [Writes -> 0..MaxRefreshes]
  /\ rstate \in [Refs -> {"none", "completed", "aborted"} \cup RefActive]
  /\ held \in [Procs -> [Rows -> Modes]]
  /\ head \in 1..MaxHead

Init ==
  /\ st = [w \in Writes |-> "new"]
  /\ code = [w \in Writes |-> "none"]
  /\ seq = [w \in Writes |-> 0]
  /\ nseq = 0
  /\ dref = [w \in Writes |-> None]
  /\ dimp = [w \in Writes |-> None]
  /\ applied = [w \in Writes |-> 0]
  /\ cpos = [w \in Writes |-> 0]
  /\ ncommit = 0
  /\ expRev = [w \in Writes |-> 0]
  /\ overdue = [w \in Writes |-> FALSE]
  /\ adopted = [w \in Writes |-> FALSE]
  /\ rstate = [i \in Refs |-> "none"]
  /\ rel = [i \in Refs |-> FALSE]
  /\ rchg = [i \in Refs |-> FALSE]
  /\ rhead = [i \in Refs |-> 0]
  /\ rmoved = [i \in Refs |-> FALSE]
  /\ cur = None
  /\ nref = 0
  /\ head = 1
  /\ verAt = [c \in 1..MaxHead |-> IF c = 1 THEN 1 ELSE 0]
  /\ fileV = 1
  /\ dbV = 1
  /\ hist = {1}
  /\ lastCommit = 1
  /\ local = None
  /\ nver = 1
  /\ nforeign = 0
  /\ nlocal = 0
  /\ restored = FALSE
  /\ revoked = FALSE
  /\ preRestore = {}
  /\ hidden = FALSE
  /\ badExpiry = FALSE
  /\ badRelease = FALSE
  /\ badDefer = FALSE
  /\ badRevoke = FALSE
  /\ held = [p \in Procs |-> NoLocks]
  /\ want = [p \in Procs |-> <<>>]
  /\ pc = [p \in Procs |-> "idle"]
  /\ cw = 0
  /\ cprep = [o |-> "none", db |-> 0, wt |-> 0, lc |-> 0]
  /\ cfin = <<"none", "none">>
  /\ ew = 0
  /\ aref = [w \in Writes |-> None]
  /\ aread = [w \in Writes |-> "none"]
  /\ passHead = 0

\* A step that only acquires the next lock a process waits for.
Acquire(p) ==
  /\ want[p] # <<>>
  /\ LET r == Head(want[p])[1]
         m == Head(want[p])[2]
     IN /\ Free(p, r, m)
        /\ held' = [held EXCEPT ![p][r] = Stronger(@, m)]
        /\ want' = [want EXCEPT ![p] = Tail(@)]
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, procv>>

Ready(p, s) == pc[p] = s /\ want[p] = <<>>
\* A consumer back at idle forgets what it read, so equal states compare equal.
ConsIdle == /\ pc' = [pc EXCEPT ![CONS] = "idle"] /\ cw' = 0
            /\ cprep' = [o |-> "none", db |-> 0, wt |-> 0, lc |-> 0] /\ cfin' = <<"none", "none">>
Commit(p) == held' = [held EXCEPT ![p] = NoLocks]
Go(p, s) == pc' = [pc EXCEPT ![p] = s]
Need(p, ls) == want' = [want EXCEPT ![p] = ls]
NewCommit(v) == /\ head' = head + 1
                /\ verAt' = [verAt EXCEPT ![head + 1] = v]
                /\ fileV' = v

\* ------------------------------- admission -------------------------------
\* admitWrite: declarePersistenceProtocol (brain FOR SHARE), the worktree FOR SHARE, the active refresh row, the
\* source FOR SHARE, lockCounters, then the INSERT (state queued or deferred, deferred_refresh_id).
AdmBegin(w) ==
  /\ pc[ADM(w)] = "idle" /\ st[w] = "new"
  /\ expRev' = [expRev EXCEPT ![w] = IF w \in Blind THEN 0 ELSE dbV]
  /\ Need(ADM(w), <<L(BRAIN, "S"), L(WT, "S")>>)
  /\ Go(ADM(w), "a_ref")
  /\ UNCHANGED <<st, code, seq, nseq, dref, dimp, applied, cpos, ncommit, overdue, adopted, refv, gitv, envv, ghostv, held,
                 cw, cprep, cfin, ew, aref, aread, passHead>>

AdmRef(w) ==
  /\ Ready(ADM(w), "a_ref")
  /\ aref' = [aref EXCEPT ![w] = cur]
  /\ Need(ADM(w), IF cur # None THEN AdmRefLock(cur) ELSE <<>>)
  /\ Go(ADM(w), "a_read")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, ew, aread, passHead>>

\* The SELECT ... FOR NO KEY UPDATE reads the refresh row once it holds it (an EvalPlanQual recheck drops a row that
\* went terminal meanwhile).
AdmRead(w) ==
  /\ Ready(ADM(w), "a_read")
  /\ aread' = [aread EXCEPT ![w] = IF aref[w] # None /\ rstate[aref[w]] \in RefActive THEN rstate[aref[w]] ELSE "none"]
  /\ Need(ADM(w), <<L(SRC, "S"), L(CTR, "U")>>)
  /\ Go(ADM(w), "a_commit")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, ew, aref, passHead>>

AdmCommit(w) ==
  /\ Ready(ADM(w), "a_commit")
  /\ LET s == aread[w]
         i == aref[w]
         \* the syncing completion: every member's last_commit reached the target
         completes == s = "syncing" /\ lastCommit = head
         defer == ~revoked /\ s \in RefActive /\ ~completes /\ (s # "recovery" \/ RecoveryDefers)
         admit == ~revoked /\ (s = "none" \/ completes \/ defer)
     IN /\ st' = [st EXCEPT ![w] = IF ~admit THEN "refused" ELSE IF defer THEN "deferred" ELSE "queued"]
        /\ dref' = [dref EXCEPT ![w] = IF defer THEN i ELSE None]
        /\ seq' = [seq EXCEPT ![w] = IF admit THEN nseq + 1 ELSE 0]
        /\ nseq' = IF admit THEN nseq + 1 ELSE nseq
        /\ badDefer' = (badDefer \/ (defer /\ rel[i]))
        /\ IF completes /\ rstate[i] = "syncing"
           THEN /\ rstate' = [rstate EXCEPT ![i] = "completed"]
                /\ rel' = [rel EXCEPT ![i] = ReleaseOn("completed")]
                /\ cur' = None
           ELSE UNCHANGED <<rstate, rel, cur>>
  /\ Commit(ADM(w)) /\ Go(ADM(w), "idle") /\ Need(ADM(w), <<>>)
  /\ aref' = [aref EXCEPT ![w] = None] /\ aread' = [aread EXCEPT ![w] = "none"]
  /\ UNCHANGED <<code, dimp, applied, cpos, ncommit, expRev, overdue, adopted, rchg, rhead, rmoved, nref, gitv, envv,
                 hidden, badExpiry, badRelease, badRevoke, cw, cprep, cfin, ew, passHead>>

\* -------------------------------- consumer --------------------------------
\* claimNextWrite: the protocol declaration and the head read, SELECT ... ORDER BY sequence LIMIT 1 FOR UPDATE SKIP
\* LOCKED, then the UPDATE to running (the v292 trigger checks a deferred row's release).
ConsBegin ==
  /\ pc[CONS] = "idle" /\ \E w \in Writes : Claimable(w)
  /\ Need(CONS, ClaimLocks) /\ Go(CONS, "c_select")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, ew, aref, aread, passHead>>

ConsSelect ==
  /\ Ready(CONS, "c_select")
  /\ LET cands == {w \in Writes : Claimable(w) /\ Free(CONS, REQ(w), "U")}
     IN IF cands = {}
        THEN /\ Commit(CONS) /\ Go(CONS, "idle") /\ UNCHANGED cw
        ELSE \E w \in cands :
               /\ \A o \in cands : seq[w] <= seq[o]
               /\ cw' = w
               /\ held' = [held EXCEPT ![CONS][REQ(w)] = "U"]
               /\ Go(CONS, "c_claim")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, want, cprep, cfin, ew, aref, aread, passHead>>

ConsClaim ==
  /\ Ready(CONS, "c_claim")
  /\ IF TriggerAllows(cw)
     THEN /\ st' = [st EXCEPT ![cw] = "running"] /\ Go(CONS, "c_prep")
     ELSE /\ UNCHANGED st /\ Go(CONS, "idle")   \* the trigger raises and the claim rolls back
  /\ Commit(CONS)
  /\ cw' = IF TriggerAllows(cw) THEN cw ELSE 0
  /\ UNCHANGED <<code, seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, overdue, adopted, refv, gitv, envv, ghostv,
                 want, cprep, cfin, ew, aref, aread, passHead>>

\* Preparation reads the page and the file (no database lock), then the deferred replay check.
Outcome(w) ==
  LET drift   == Worktree # dbV
      pending == drift /\ local = None /\ fileV # verAt[lastCommit]
  IN IF drift /\ PrepRefusesDrift THEN (IF pending THEN "pending" ELSE IF local # None THEN "local" ELSE "drift")
     ELSE IF w \notin Blind /\ dbV # expRev[w] THEN "conflict"
     ELSE IF dref[w] # None /\ ReplayDiff(dref[w]) THEN "conflict"
     ELSE IF dref[w] # None /\ revoked /\ ReplayAuth THEN "denied"
     ELSE "ok"

Finish(s, c) == /\ cfin' = <<s, c>>
                /\ Need(CONS, <<L(BRAIN, "S"), L(CTR, "U"), L(REQ(cw), "U")>>)
                /\ Go(CONS, "c_done")

ConsPrep ==
  /\ Ready(CONS, "c_prep")
  /\ LET o == Outcome(cw)
     IN /\ cprep' = [o |-> o, db |-> dbV, wt |-> Worktree, lc |-> lastCommit]
        /\ CASE o = "ok" ->
                  /\ Need(CONS, <<L(BRAIN, "S"), L(WT, "S"), L(SRC, "S"), L(CTR, "U"), L(REQ(cw), "U")>>)
                  /\ Go(CONS, "c_pub") /\ UNCHANGED cfin
             [] o = "pending" /\ ImportHolds ->
                  /\ Need(CONS, <<L(REQ(cw), "U")>>) /\ Go(CONS, "c_hold") /\ UNCHANGED cfin
             [] o = "pending" -> Finish("failed", "pending_import")
             [] o = "local" /\ AdoptLocalEdits /\ ~adopted[cw] /\ cur = None /\ AdoptOneSided ->
                  /\ Go(CONS, "c_adopt") /\ UNCHANGED <<want, cfin>>
             [] o \in {"local", "drift"} -> Finish("failed", "source_changed")
             [] o = "conflict" -> Finish("conflict", "revision_conflict")
             [] o = "denied" -> Finish("failed", "permission_denied")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, ew, aref, aread, passHead>>

\* publishMutation's transaction: declarePublication, guardOwnership, authorizeStoredRequest (the source FOR SHARE),
\* lockCounters, the request FOR UPDATE (claim and state rechecked), the page revision and file rechecked.
ConsPub ==
  /\ Ready(CONS, "c_pub")
  /\ LET mine == st[cw] = "running"
         denied == revoked /\ PublishAuth
         moved == dbV # cprep.db \/ Worktree # cprep.wt
         v == nver + 1
     IN IF mine /\ ~denied /\ ~moved
        THEN /\ hidden' = (hidden \/ fileV \notin hist)
             /\ NewCommit(v) /\ nver' = v /\ dbV' = v /\ hist' = hist \cup {v} /\ local' = None
             /\ applied' = [applied EXCEPT ![cw] = @ + 1]
             /\ st' = [st EXCEPT ![cw] = "committed"] /\ code' = [code EXCEPT ![cw] = "committed"]
             /\ ncommit' = ncommit + 1 /\ cpos' = [cpos EXCEPT ![cw] = ncommit + 1]
             /\ badRelease' = (badRelease \/ (dref[cw] # None /\ ~rel[dref[cw]]))
             /\ badRevoke' = (badRevoke \/ revoked)
        ELSE /\ st' = [st EXCEPT ![cw] = IF ~mine THEN @ ELSE IF denied THEN "failed" ELSE "queued"]
             /\ code' = [code EXCEPT ![cw] = IF mine /\ denied THEN "permission_denied" ELSE @]
             /\ UNCHANGED <<head, verAt, fileV, nver, dbV, hist, local, applied, ncommit, cpos, hidden, badRelease, badRevoke>>
  /\ Commit(CONS) /\ ConsIdle
  /\ UNCHANGED <<seq, nseq, dref, dimp, expRev, overdue, adopted, refv, lastCommit, nforeign, nlocal, envv, badExpiry, badDefer,
                 want, ew, aref, aread, passHead>>

\* holdForImport: UPDATE ... SET state='deferred', deferred_import_from=<last_commit read before the check>
\* WHERE execution_token=<ours> AND state='running' AND publication_started=false.
ConsHold ==
  /\ Ready(CONS, "c_hold")
  /\ IF st[cw] = "running"
     THEN /\ st' = [st EXCEPT ![cw] = "deferred"] /\ dimp' = [dimp EXCEPT ![cw] = cprep.lc]
     ELSE UNCHANGED <<st, dimp>>
  /\ Commit(CONS) /\ ConsIdle
  /\ UNCHANGED <<code, seq, nseq, dref, applied, cpos, ncommit, expRev, overdue, adopted, refv, gitv, envv, ghostv,
                 want, ew, aref, aread, passHead>>

\* adoptLocalEdit: the owner publishes the edit as its own managed_file_repair write (one commit of the file), then
\* releases the caller's claim so it is prepared again.
ConsAdopt ==
  /\ pc[CONS] = "c_adopt"
  /\ hidden' = (hidden \/ fileV \notin hist)
  /\ NewCommit(local) /\ dbV' = local /\ hist' = hist \cup {local} /\ local' = None
  /\ adopted' = [adopted EXCEPT ![cw] = TRUE]
  /\ Need(CONS, <<L(REQ(cw), "U")>>) /\ Go(CONS, "c_release")
  /\ UNCHANGED <<st, code, seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, overdue, refv, lastCommit, nver, nforeign,
                 nlocal, envv, badExpiry, badRelease, badDefer, badRevoke, held, cw, cprep, cfin, ew, aref, aread, passHead>>

\* releaseUnpublishedClaim: back to queued, prepared again by the next claim.
ConsRelease ==
  /\ Ready(CONS, "c_release")
  /\ st' = [st EXCEPT ![cw] = IF @ = "running" THEN "queued" ELSE @]
  /\ Commit(CONS) /\ ConsIdle
  /\ UNCHANGED <<code, seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, overdue, adopted, refv, gitv, envv, ghostv,
                 want, ew, aref, aread, passHead>>

\* completeWrite of a refusal: declarePersistenceProtocol, lockCounters, the request FOR UPDATE.
ConsDone ==
  /\ Ready(CONS, "c_done")
  /\ st' = [st EXCEPT ![cw] = IF @ = "running" THEN cfin[1] ELSE @]
  /\ code' = [code EXCEPT ![cw] = IF st[cw] = "running" THEN cfin[2] ELSE @]
  /\ Commit(CONS) /\ ConsIdle
  /\ UNCHANGED <<seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, overdue, adopted, refv, gitv, envv, ghostv,
                 want, ew, aref, aread, passHead>>

\* -------------------------------- refresher --------------------------------
\* fenceDraining: lockTopologyRows (brain FOR UPDATE, worktree FOR UPDATE, sources FOR UPDATE), INSERT draining.
RefBegin ==
  /\ pc[RFR] = "idle" /\ cur = None /\ nref < MaxRefreshes
  /\ Need(RFR, <<L(BRAIN, "U"), L(WT, "U"), L(SRC, "U")>>) /\ Go(RFR, "r_fd")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, ew, aref, aread, passHead>>

FdCommit ==
  /\ Ready(RFR, "r_fd")
  /\ \E c \in BOOLEAN :
       /\ local # None => ~c          \* the precheck refuses a fast-forward over a dirty file it changes
       /\ rchg' = [rchg EXCEPT ![nref + 1] = c]
  /\ rstate' = [rstate EXCEPT ![nref + 1] = "draining"]
  /\ rhead' = [rhead EXCEPT ![nref + 1] = head]
  /\ cur' = nref + 1 /\ nref' = nref + 1
  /\ Commit(RFR) /\ Go(RFR, "r_drain")
  /\ UNCHANGED <<reqv, rel, rmoved, gitv, envv, ghostv, want, cw, cprep, cfin, ew, aref, aread, passHead>>

\* The drain poll (no locks), then fenceAndMerge's transaction: lockTopologyRows, drainCounts, transition to fenced.
RefDrained ==
  /\ pc[RFR] = "r_drain" /\ want[RFR] = <<>> /\ DrainZero
  /\ Need(RFR, <<L(BRAIN, "U"), L(WT, "U"), L(SRC, "U"), L(REF(nref), "NKU")>>) /\ Go(RFR, "r_fm")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, ew, aref, aread, passHead>>

\* --wait-drain ran out: transition draining -> aborted.
RefDrainTimeout ==
  /\ pc[RFR] = "r_drain" /\ ~DrainZero
  /\ Need(RFR, <<L(REF(nref), "NKU")>>) /\ Go(RFR, "r_abort")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, ew, aref, aread, passHead>>

FmCommit ==
  /\ Ready(RFR, "r_fm")
  /\ IF ~FenceRecount \/ DrainZero
     THEN /\ rstate' = [rstate EXCEPT ![nref] = "fenced"] /\ Go(RFR, "r_merge") /\ Need(RFR, <<>>)
     ELSE /\ UNCHANGED rstate /\ Go(RFR, "r_abort") /\ Need(RFR, <<L(REF(nref), "NKU")>>)  \* refresh_source_changed
  /\ Commit(RFR)
  /\ UNCHANGED <<reqv, rel, rchg, rhead, rmoved, cur, nref, gitv, envv, ghostv, cw, cprep, cfin, ew, aref, aread, passHead>>

\* transition(..., 'aborted'): the release trigger stamps released_at.
AbortCommit ==
  /\ Ready(RFR, "r_abort")
  /\ IF rstate[nref] \in RefActive
     THEN /\ rstate' = [rstate EXCEPT ![nref] = "aborted"] /\ rel' = [rel EXCEPT ![nref] = ReleaseOn("aborted")]
     ELSE UNCHANGED <<rstate, rel>>
  /\ cur' = None
  /\ Commit(RFR) /\ Go(RFR, "idle")
  /\ UNCHANGED <<reqv, rchg, rhead, rmoved, nref, gitv, envv, ghostv, want, cw, cprep, cfin, ew, aref, aread, passHead>>

\* Under the commit lock: HEAD must still be old_head (another agent's plain-git commit is not), then the ff-only merge.
RefMerge ==
  /\ Ready(RFR, "r_merge")
  /\ IF head # rhead[nref]
     THEN /\ Need(RFR, <<L(REF(nref), "NKU")>>) /\ Go(RFR, "r_mark") /\ UNCHANGED <<head, verAt, fileV, nver, rmoved>>
     ELSE /\ IF rchg[nref]
             THEN NewCommit(nver + 1) /\ nver' = nver + 1 /\ rmoved' = [rmoved EXCEPT ![nref] = TRUE]
             ELSE NewCommit(fileV) /\ UNCHANGED <<nver, rmoved>>
          /\ Need(RFR, <<L(REF(nref), "NKU"), L(SRC, "NKU")>>) /\ Go(RFR, "r_bk")
  /\ UNCHANGED <<reqv, rstate, rel, rchg, rhead, cur, nref, dbV, hist, lastCommit, local, nforeign, nlocal, envv, ghostv,
                 held, cw, cprep, cfin, ew, aref, aread, passHead>>

MarkCommit ==
  /\ Ready(RFR, "r_mark")
  /\ rstate' = [rstate EXCEPT ![nref] = "recovery"]
  /\ Commit(RFR) /\ Go(RFR, "r_recovery")
  /\ UNCHANGED <<reqv, rel, rchg, rhead, rmoved, cur, nref, gitv, envv, ghostv, want, cw, cprep, cfin, ew, aref, aread, passHead>>

\* A person resolves recovery_required: reset to old_head and --abandon, or reset to the target and --resume.
PersonAbandon ==
  /\ pc[RFR] = "r_recovery"
  /\ head' = rhead[nref] /\ fileV' = verAt[rhead[nref]] /\ local' = None
  /\ Need(RFR, <<L(REF(nref), "NKU")>>) /\ Go(RFR, "r_abort")
  /\ UNCHANGED <<reqv, refv, verAt, dbV, hist, lastCommit, nver, nforeign, nlocal, envv, ghostv, held,
                 cw, cprep, cfin, ew, aref, aread, passHead>>

PersonResume ==
  /\ pc[RFR] = "r_recovery"
  /\ LET base == rhead[nref]
         v == IF rchg[nref] THEN nver + 1 ELSE verAt[base]
     IN /\ head' = base + 1 /\ verAt' = [verAt EXCEPT ![base + 1] = v] /\ fileV' = v
        /\ nver' = IF rchg[nref] THEN nver + 1 ELSE nver
        /\ rmoved' = [rmoved EXCEPT ![nref] = rchg[nref]]
  /\ local' = None
  /\ Need(RFR, <<L(REF(nref), "NKU"), L(SRC, "NKU")>>) /\ Go(RFR, "r_bk")
  /\ UNCHANGED <<reqv, rstate, rel, rchg, rhead, cur, nref, dbV, hist, lastCommit, nforeign, nlocal, envv, ghostv, held,
                 cw, cprep, cfin, ew, aref, aread, passHead>>

\* bookkeeping: transition to merged (the refresh row), the sources' upstream observation, then syncing.
BkCommit ==
  /\ Ready(RFR, "r_bk")
  /\ rstate' = [rstate EXCEPT ![nref] = IF @ \in {"fenced", "merged", "recovery"} THEN "syncing" ELSE @]
  /\ Commit(RFR) /\ Go(RFR, "r_syncing")
  /\ UNCHANGED <<reqv, rel, rchg, rhead, rmoved, cur, nref, gitv, envv, ghostv, want, cw, cprep, cfin, ew, aref, aread, passHead>>

\* syncMembers ends: completed once members reach the target, or (#8072) when a member's sync is blocked or deferred.
RefComplete ==
  /\ pc[RFR] = "r_syncing"
  /\ Need(RFR, <<L(REF(nref), "NKU")>>) /\ Go(RFR, "r_complete")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, ew, aref, aread, passHead>>

CompleteCommit ==
  /\ Ready(RFR, "r_complete")
  /\ IF rstate[nref] = "syncing"
     THEN /\ rstate' = [rstate EXCEPT ![nref] = "completed"] /\ rel' = [rel EXCEPT ![nref] = ReleaseOn("completed")]
          /\ cur' = None
     ELSE UNCHANGED <<rstate, rel, cur>>
  /\ Commit(RFR) /\ Go(RFR, "idle")
  /\ UNCHANGED <<reqv, rchg, rhead, rmoved, nref, gitv, envv, ghostv, want, cw, cprep, cfin, ew, aref, aread, passHead>>

\* --------------------------------- expiry ---------------------------------
\* The candidate query reads without locks; then one transaction per row.
ExpRefBegin(w) ==
  /\ pc[EXP] = "idle" /\ st[w] = "deferred" /\ dref[w] # None /\ ~rel[dref[w]] /\ overdue[w]
  /\ ew' = w /\ Need(EXP, ExpiryLocks(dref[w], w)) /\ Go(EXP, "e_ref")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, aref, aread, passHead>>

\* completeWrite: a terminal row stays as it is; a row someone claimed (a live execution token) is write_claim_lost.
ExpRefCommit ==
  /\ Ready(EXP, "e_ref")
  /\ LET fire == ExpiryRecheck(dref[ew]) /\ st[ew] \notin Terminal /\ st[ew] # "running"
     IN /\ st' = [st EXCEPT ![ew] = IF fire THEN "failed" ELSE @]
        /\ code' = [code EXCEPT ![ew] = IF fire THEN "refresh_barrier_expired" ELSE @]
        /\ badExpiry' = (badExpiry \/ (fire /\ ~(st[ew] = "deferred" /\ ~rel[dref[ew]])))
  /\ Commit(EXP) /\ Go(EXP, "idle") /\ ew' = 0
  /\ UNCHANGED <<seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, overdue, adopted, refv, gitv, envv,
                 hidden, badRelease, badDefer, badRevoke, want, cw, cprep, cfin, aref, aread, passHead>>

\* #8705: a write held for an import that has not landed past the limit ends pending_import_expired.
ExpImpBegin(w) ==
  /\ ImportHolds
  /\ pc[EXP] = "idle" /\ st[w] = "deferred" /\ dimp[w] # None /\ lastCommit = dimp[w]
  /\ IF dref[w] = None THEN TRUE ELSE rel[dref[w]]
  /\ overdue[w]
  /\ ew' = w /\ Go(EXP, "e_recheck")
  /\ Need(EXP, IF ImportExpiryLocksSource THEN ImportExpiryLocks ELSE <<>>)
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, aref, aread, passHead>>

ExpImpRecheck ==
  /\ Ready(EXP, "e_recheck")
  /\ IF ImportExpiryRecheck(ew)
     THEN Need(EXP, <<L(BRAIN, "S"), L(CTR, "U"), L(REQ(ew), "U")>>) /\ Go(EXP, "e_imp")
     ELSE UNCHANGED want /\ Go(EXP, "idle")
  /\ held' = IF ImportExpiryRecheck(ew) THEN held ELSE [held EXCEPT ![EXP] = NoLocks]
  /\ ew' = IF ImportExpiryRecheck(ew) THEN ew ELSE 0
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, cw, cprep, cfin, aref, aread, passHead>>

ExpImpCommit ==
  /\ Ready(EXP, "e_imp")
  /\ LET fire == st[ew] \notin Terminal /\ st[ew] # "running"
     IN /\ st' = [st EXCEPT ![ew] = IF fire THEN "failed" ELSE @]
        /\ code' = [code EXCEPT ![ew] = IF fire THEN "pending_import_expired" ELSE @]
        /\ badExpiry' = (badExpiry \/ (fire /\ ~(st[ew] = "deferred" /\ dimp[ew] # None /\ lastCommit = dimp[ew])))
  /\ Commit(EXP) /\ Go(EXP, "idle") /\ ew' = 0
  /\ UNCHANGED <<seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, overdue, adopted, refv, gitv, envv,
                 hidden, badRelease, badDefer, badRevoke, want, cw, cprep, cfin, aref, aread, passHead>>

\* ------------------------------ managed sync ------------------------------
\* A pass starts only with no refresh, or as the refresh's own member sync (assertManagedSyncAllowed). It imports F's
\* committed version into the page, then the pass stamp moves last_commit (UPDATE sources).
SyncBegin ==
  /\ pc[SYN] = "idle" /\ (cur = None \/ RefIs({"syncing"})) /\ lastCommit # head
  /\ passHead' = head
  /\ Need(SYN, <<L(BRAIN, "S")>>) /\ Go(SYN, "s_import")
  /\ UNCHANGED <<reqv, refv, gitv, envv, ghostv, held, cw, cprep, cfin, ew, aref, aread>>

SyncImport ==
  /\ Ready(SYN, "s_import")
  /\ IF local = None /\ fileV = verAt[passHead] /\ fileV # dbV
     THEN dbV' = fileV /\ hist' = hist \cup {fileV}
     ELSE UNCHANGED <<dbV, hist>>   \* nothing to import, or a dirty file sync holds
  /\ Commit(SYN)
  /\ Need(SYN, <<L(BRAIN, "S"), L(SRC, "NKU")>>) /\ Go(SYN, "s_stamp")
  /\ UNCHANGED <<reqv, refv, head, verAt, fileV, lastCommit, local, nver, nforeign, nlocal, envv, ghostv,
                 cw, cprep, cfin, ew, aref, aread, passHead>>

SyncStamp ==
  /\ Ready(SYN, "s_stamp")
  /\ lastCommit' = passHead
  /\ Commit(SYN) /\ Go(SYN, "idle") /\ passHead' = 0
  /\ UNCHANGED <<reqv, refv, head, verAt, fileV, dbV, hist, local, nver, nforeign, nlocal, envv, ghostv,
                 want, cw, cprep, cfin, ew, aref, aread>>

\* ------------------------------- environment -------------------------------
Foreign ==
  /\ nforeign < MaxForeign /\ local = None
  /\ NewCommit(nver + 1) /\ nver' = nver + 1 /\ nforeign' = nforeign + 1
  /\ UNCHANGED <<reqv, refv, dbV, hist, lastCommit, local, nlocal, envv, ghostv, lockv, procv>>

LocalEdit ==
  /\ nlocal < MaxLocalEdits /\ local = None /\ cur = None
  /\ local' = nver + 1 /\ nver' = nver + 1 /\ nlocal' = nlocal + 1
  /\ UNCHANGED <<reqv, refv, head, verAt, fileV, dbV, hist, lastCommit, nforeign, envv, ghostv, lockv, procv>>

\* created_at passes the limit; only a deferred row's age is ever read.
Age(w) ==
  /\ st[w] = "deferred" /\ ~overdue[w]
  /\ overdue' = [overdue EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<st, code, seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, adopted, refv, gitv, envv, ghostv, lockv, procv>>

Revoke ==
  /\ MayRevoke /\ ~revoked
  /\ revoked' = TRUE
  /\ UNCHANGED <<reqv, refv, gitv, restored, preRestore, ghostv, lockv, procv>>

\* A backup restore runs on the restored PGLite copy alone (no worker runs there), in one transaction.
Restore ==
  /\ MayRestore /\ ~restored
  /\ \A p \in Procs : held[p] = NoLocks /\ want[p] = <<>>
  /\ preRestore' = {w \in Writes : st[w] \notin {"new", "refused"}}
  /\ st' = [w \in Writes |-> IF st[w] \in RestoreCancels THEN "cancelled" ELSE st[w]]
  /\ code' = [w \in Writes |-> IF st[w] \in RestoreCancels THEN "restore_new_brain" ELSE code[w]]
  /\ restored' = TRUE
  /\ UNCHANGED <<seq, nseq, dref, dimp, applied, cpos, ncommit, expRev, overdue, adopted, refv, gitv, revoked, ghostv, lockv, procv>>

\* ---------------------------------------------------------------------------

ConsStep == ConsBegin \/ ConsSelect \/ ConsClaim \/ ConsPrep \/ ConsPub \/ ConsHold \/ ConsAdopt \/ ConsRelease \/ ConsDone
RefStep  == FdCommit \/ RefDrained \/ RefDrainTimeout \/ FmCommit \/ AbortCommit \/ RefMerge \/ MarkCommit
            \/ BkCommit \/ RefComplete \/ CompleteCommit
ExpStep  == (\E w \in Writes : ExpRefBegin(w) \/ ExpImpBegin(w)) \/ ExpRefCommit \/ ExpImpRecheck \/ ExpImpCommit
SyncStep == SyncBegin \/ SyncImport \/ SyncStamp
AdmStep(w) == AdmRef(w) \/ AdmRead(w) \/ AdmCommit(w)

Next ==
  \/ \E p \in Procs : Acquire(p)
  \/ \E w \in Writes : AdmBegin(w) \/ AdmStep(w) \/ Age(w)
  \/ ConsStep \/ RefBegin \/ RefStep \/ PersonAbandon \/ PersonResume \/ ExpStep \/ SyncStep
  \/ Foreign \/ LocalEdit \/ Revoke \/ Restore

\* Every process that has started runs; a waiting lock request is eventually granted once it can be (Postgres queues
\* lock waiters); a person eventually resolves recovery_required; time passes. Producers, other agents' commits,
\* local edits, refreshes starting, revocation and restore are never forced.
Fairness ==
  /\ \A p \in Procs : SF_vars(Acquire(p))
  /\ \A w \in Writes : WF_vars(AdmStep(w)) /\ WF_vars(Age(w))
  /\ WF_vars(ConsStep) /\ WF_vars(RefStep) /\ WF_vars(PersonAbandon \/ PersonResume)
  /\ WF_vars(ExpStep) /\ WF_vars(SyncStep)

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

\* -------------------------------- properties --------------------------------

\* Every open row's transaction waits for a lock another one holds: a cycle is a deadlock.
WaitsFor(p, q) == p # q /\ want[p] # <<>> /\ Conflict(Head(want[p])[2], held[q][Head(want[p])[1]])
RECURSIVE Reach(_, _)
Reach(S, n) == IF n = 0 THEN S ELSE Reach(S \cup {q \in Procs : \E s \in S : WaitsFor(s, q)}, n - 1)
NoDeadlock == \A p \in Procs : p \notin Reach({q \in Procs : WaitsFor(p, q)}, Cardinality(Procs))

\* No write is applied twice, and a receipt says committed exactly when the write was applied.
AppliedAtMostOnce == \A w \in Writes : applied[w] <= 1
ReceiptMatchesApply == \A w \in Writes : (st[w] = "committed") = (applied[w] = 1)
\* Nothing is dropped silently: every write that ends, ends with a named outcome.
EveryEndNamed == \A w \in Writes : st[w] \in Terminal => code[w] # "none"
\* A write never replaces a committed version of F the page never had (it would vanish from page history).
ImportedRevisionNeverHidden == ~hidden
\* The fence never comes up, and the checkout never moves, while a write is claimed (mid-prepare or publishing).
FenceNeverMidPrepare == \A i \in Refs : rstate[i] \in {"fenced", "merged", "recovery"} => \A w \in Writes : st[w] # "running"
\* A deferred write commits only after its refresh is released, and never over a file that refresh changed.
DeferredWaitsForRelease == ~badRelease
RefreshChangeNeverOverwritten == \A w \in Writes : st[w] = "committed" /\ dref[w] # None => ~rmoved[dref[w]]
NoDeferToReleased == ~badDefer
ReleasedWhenEnded == \A i \in Refs : rstate[i] \in {"completed", "aborted"} => rel[i]
\* An expiry ends only a write that still waits (its refresh unreleased, or its import not landed).
ExpiryOnlyWhileWaiting == ~badExpiry
\* A restore leaves no write admitted before it open.
RestoreLeavesNoOpenWrite == restored => \A w \in preRestore : st[w] \in Terminal
\* No write commits after its credential was revoked.
NoApplyAfterRevoke == ~badRevoke
\* Writes to one page commit in admission order: a write never lands on top of a later one.
CommitsInAdmissionOrder == \A a, b \in Writes :
  (st[a] = "committed" /\ st[b] = "committed" /\ seq[a] < seq[b]) => cpos[a] < cpos[b]

\* Liveness, under Fairness.
DeferredLeaves == \A w \in Writes : st[w] = "deferred" ~> st[w] # "deferred"
EveryWriteEnds == \A w \in Writes : st[w] \in Open ~> st[w] \in Terminal
=============================================================================
