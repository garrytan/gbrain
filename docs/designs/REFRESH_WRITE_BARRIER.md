# Refresh write barrier, commit ledger and foreign-writer alarm (PR B)

Status: reviewed (one eng-review round, two voices, fixes applied; see the review record at the end).
Lane L4 of the convergence program.
Placeholders only: "source D", "the main source", "a busy agent". Counts are synthetic.

## Why

Two problems keep a shared brain checkout from converging:

1. **Writes that meet a refresh are refused.** `gbrain sources refresh` fast-forwards a managed
   worktree. While its row is active, every page write to that worktree is refused
   `worktree_refreshing` before it is journaled (journal.ts `assertWorktreeNotRefreshing`). A tick
   runs minutes, so a producer that does not read the JSON code loses the write. Production saw
   several such refusals reported as exit 0 by the harness that launched them.
2. **Nobody can see who else commits.** Crons and scripts commit to brain checkouts with plain git.
   Their commits bypass the writer lock and leave files with no import record, which later become
   drift holds. doctor's writer checks skip managed worktrees ("their owner is the only writer"),
   which is the assumption that failed.

PR B turns (1) into a deferred write that commits after the refresh, and makes (2) visible with an
append-only ledger of every commit gbrain makes plus a doctor check that names every other commit.
It also lets the owner install the commit guard on a managed worktree, adds a per-path base check
to `gbrain git commit-push`, and folds three small bugs (#8615, #8617, #8662); #8616 is left out
(below).

Out of scope: who routes the box's writers (lane L2), when the flag is turned on (an operations
decision with stated preconditions, below), and the soak cell (lane L5).

## Part 1: the refresh write barrier

### Today

- `fenceDraining` inserts the refresh row `draining` while holding the worktree row FOR UPDATE.
- Admission (`assertWorktreeAdmission`) holds the worktree row FOR SHARE and reads the active
  refresh in the same pipelined statement pair, so an admission either commits before the fence
  (and is drained) or sees it and is refused. During `syncing` any
  `managed_sync_*` job is admitted.
- Claims skip a worktree whose refresh is `fenced`, `merged` or `recovery_required`
  (`refreshFenceClear`); `draining` and `syncing` keep claiming so queued work drains.
- `fenceAndMerge` refuses `refresh_source_changed` when any request, checkout effect or recovery
  record reached the worktree after the drain check.

### The barrier sequence

When the flag is on and an admission sees an active refresh in `draining`, `fenced`, `merged` or
`syncing`, a **page write** (target `page`, one of the page write operations) that is not a
`managed_sync_*` job is **admitted as a deferred request** instead of refused:

1. It is journaled with **state `deferred`** (a new request state) and
   `deferred_refresh_id = <refresh id>`. Its counters are reserved exactly as for a queued row.
2. The caller gets a pending receipt at once (no wait on the owner): CLI exit 10
   (`write_pending`, unchanged registry entry); MCP `isError: false` with
   `{ status: "pending", request_id, receipt, deferred: { refresh_id, refresh_state }, next }`.
   `next` is `get_write_request` / `gbrain write-request <id>` after `retry_after_ms`.
3. A deferred row is **unclaimable until its refresh is released.** A refresh is released when its
   row reaches `completed` or `aborted` (`released_at` is set in the same statement).
4. After release, the new claim moves deferred rows **straight from `deferred` to `running`** in
   sequence order (they never pass through `queued`), and each one gets the refresh-change check
   (below) before it publishes.

Not deferred, refused as today: `recovery_required` (`refresh_recovery_required`: HEAD is
unverified and may stay so until a person runs `--resume`), `submit_job` writes, and
`skill_bundle` targets (protocol 2, whose own activation contract this PR does not touch).

Repo-less brains and unmanaged sources have no worktree, no refresh row and no fence; admission never
reaches the deferred branch there, and a test pins it.

**Why a state and not a flag on a queued row.** Every selector in the write path names its states
explicitly: claims (`r.state='queued'`), `EARLIER_HEAD`, `FOREGROUND_WAITING_ON`, the lane-head
claim's earlier-row check, follower claims, `drainCounts` and the protocol-activation guard. A row
in `deferred` is invisible to all of them in every binary, old or new. So:

- the refresh's own managed-sync rows are never held behind deferred foreground rows (otherwise the
  refresh could not complete, every deferred row would wait for it, and it would wait for them);
- the refresh's drain never counts them, so the set it waits for is closed when the fence row is
  inserted;
- an older consumer never selects, waits on or claims them, so it cannot apply one without the
  refresh-change check, and cannot wedge on one either.

A build-time audit test lists every SQL fragment that filters `persistence_requests.state` and fails
when a new one appears without a decision about `deferred`.

### Migration (both engines, one migration)

```sql
ALTER TABLE persistence_worktree_refreshes
  ADD COLUMN IF NOT EXISTS barrier_sequence bigint,   -- requests' sequence high-water when the fence row was inserted (diagnostic)
  ADD COLUMN IF NOT EXISTS released_at timestamptz;   -- set exactly once, on completed/aborted
ALTER TABLE persistence_requests
  ADD COLUMN IF NOT EXISTS deferred_refresh_id uuid REFERENCES persistence_worktree_refreshes(id);
-- the state CHECK gains 'deferred': drop the old constraint, ADD the new one NOT VALID, then VALIDATE
-- in a separate statement (no long ACCESS EXCLUSIVE scan; #7636's no-table-lock rule)
-- every open-state predicate gains 'deferred', so one index covers all four open states: a receipt poll
-- (state IN ('queued','deferred','running','recovering')) stays index-served on a permanent receipt history
CREATE INDEX IF NOT EXISTS persistence_requests_open
  ON persistence_requests(worktree_id, sequence) WHERE state IN ('queued','deferred','running','recovering');
ALTER TABLE persistence_consumers ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}';
```

plus two triggers:

- **Release trigger** (BEFORE UPDATE on persistence_worktree_refreshes): when `NEW.state` enters
  `completed` or `aborted` from an active state, `NEW.released_at := now()`. This covers every
  writer of that column: `transition()`, admission's direct syncing-completion update (journal.ts),
  orphan adoption, `--resume`/`--abandon`, and an older binary's transitions in a mixed-version
  window.
- **Deferred-row guard** (BEFORE UPDATE on persistence_requests, a new function and trigger; the
  shipped request protocol guard bodies are untouched): a row may leave `deferred` only to
  `running` (and only when its refresh is released and the session declares
  `gbrain.refresh_barrier = '1'`, which only a new claim statement sets), or to `conflict` /
  `failed` / `cancelled` (a topology change, expiry, cancel). Nothing moves a row into `deferred` except its insert. This is a
  backstop; no older code path selects the state.

No request protocol version changes. Deferred rows keep `protocol_version = 1`, so replay identity
(`prior.protocol_version` versus the replay's) and every renewal, finish and charge that declares
protocol 2 work unchanged.

### Admission and lock order

The global lock order (protocol.ts) gains the refresh row **right after the worktree row**: brain,
worktrees, the worktree's active refresh row, sources, counters, requests, page keys.
`bookkeeping` already updates the refresh row before `sources`, and `fenceDraining` inserts it
while holding the worktree FOR UPDATE, so the refresh side already follows this order.

With the flag on, admission's first pipelined round becomes: the worktree row FOR SHARE, then
`SELECT id, state FROM persistence_worktree_refreshes WHERE worktree_id=$1 AND state IN
('draining','fenced','merged','syncing','recovery_required') FOR NO KEY UPDATE`. Then it branches:
no row (none active, or it already went terminal and so is released) → normal admission;
`recovery_required` → refuse; `syncing` whose members all reached the target → complete it (the
existing update, now without a share-to-update upgrade, so two admissions cannot deadlock on it) and
admit normally; any other active state → deferred admission. Taking the refresh row exclusively costs
nothing extra: admissions already serialize on the `brain` counter row. With the flag off,
admission's statements are unchanged.

Every refresh state change updates that row, so an admission and a transition serialize on it:
either the terminal transition commits first (the admission sees no active row and is normal), or the
deferred admission commits first (its refresh is not yet released, and the release that follows makes
it claimable). No row can be deferred to an already released refresh, and no row can slip in as a
normal admission while a refresh is in `recovery_required`.

The capability check and the capacity checks run in the same transaction after these locks.

### Release, the refresh-change check, and the drain bound

**Release** is the terminal transition (trigger above). The new claim selects
`state='deferred' AND <its refresh is released>` together with the ordinary queued candidates, in
sequence order, honouring the usual per-worktree head rules, so FIFO order per worktree holds after
release.

**The refresh-change check** replaces a database revision base, because `completed` does not mean
imported: a refresh completes even when a member's sync is blocked or deferred, so git can hold the
refreshed bytes while the page's revision has not moved. The check uses git, which the refresh knows
exactly. After preparation, when the publication's target paths are known (a rename's two paths, a
forget's companion pages, a fence row another page retires, every file of a multi-file publication),
and before publication, the consumer asks whether refresh R changed any of them:
`git diff --name-only -z <old_head> <target_head> -- <paths>` on the owner's checkout (the refresh
row stores both heads). An aborted refresh moved nothing and skips the check.

- No target path changed in R: the write publishes normally. Its own `expected_revision` and the
  existing file guards still apply, so two deferred writes to one page, or a pre-fence write and a
  deferred write, behave exactly as two ordinary queued writes do (no false conflict).
- GST-1623: a write to the same page accepted after the deferred one has already committed (an
  older consumer, whose claim lacks the deferred-row head rule, took it first): the row finishes
  `conflict` / `revision_conflict` naming that request, so the earlier write never lands on top of
  the later one. Managed sync's own rows and appends (`remember`, `add_timeline_entry`) do not count.
  The same check runs for a write held for an import. Paths compare case-folded when the checkout's
  `core.ignorecase` is true.
- Any target path changed in R: the row finishes with receipt state `conflict`, code
  `revision_conflict`, detail naming the refresh and the changed paths. Nothing is applied, so a page
  the refresh changed is never overwritten. This applies to every page operation, appends included;
  the producer re-reads and recomputes (lane L2's revision-bound read-modify-write). The diff is
  computed once per refresh and cached for the drain.

**Livelock bound.** A refresh only waits for rows admitted before its fence; writes admitted during
it are deferred to it, so a steady stream cannot keep a drain from reaching zero. A previous refresh's
released rows are claimed normally during the next refresh's `draining` and counted by its drain
(the claim moves them to `running`), within the existing `--wait-drain` budget.

**Capacity.** Deferred rows reserve the existing outstanding and intent-byte counters, which bound
them like queued rows. GST-1623: a managed sync job (and a bulk sync group made only of them) is
admitted as if deferred rows held no slot and no intent bytes, since they cannot settle before the
import does; the held rows are read only when the plain check would refuse, so the importer can pass
a cap by at most what they hold. Only rows still held for the sync's own source count (#8759): rows
held for another source, and released rows about to settle, keep their slots. Every other write still
counts them, and the local CLI fair share counts deferred rows toward their source's share. GST-1582 removed the per-refresh cap (`persistence.refresh_barrier_max_deferred`):
a write past it queued as deferred instead of being refused, because a refusal there bounced exactly
the writes the barrier exists to keep. The setting is no longer read.

**Age bound.** A deferred row whose refresh is still unreleased after
`persistence.refresh_barrier_max_wait_ms` (default 15 minutes; a tick runs a few minutes) is finished
`failed` with `refresh_barrier_expired` by the owner consumer's housekeeping turn (its idle probe
counts an overdue deferred row as work, so an otherwise idle owner still runs it), in one statement
that rechecks `released_at IS NULL` and releases its counters. Nothing is applied; the producer
resubmits with a new request id. If the owner host is down, nothing claims or expires rows; receipts
stay pending and readable, as for any queued row on that host.

### Writes that wait for an import

GST-1582: a write must never bounce because a sync is running. Three refusals bounced writes the
barrier exists to keep, and with the flag on each now waits instead (with it off, each is unchanged):

- **A refresh in `recovery_required`.** Admission defers behind it like behind any active refresh.
  The row is released when the refresh is resumed or abandoned (both end it `completed` or
  `aborted`), takes the refresh-change check, and is bound by the same age limit.
- **The per-refresh cap.** Removed (see Capacity).
- **`pending_import`.** A `put_page`, `capture`, `remember` or `add_timeline_entry` whose page file holds a change
  committed through Git that managed sync has not imported yet was refused at preparation
  (`source_changed`, reason `pending_import`), after admission. The refusal now carries the last
  imported commit the check compared against (read before the check, so a commit the check saw
  imported is never awaited), and the consumer moves its own claim back to `deferred` with
  `deferred_import_from` set to that commit (`''` when the source had never imported). The row is
  released when `sources.last_commit` differs from it (and any refresh it also names is released),
  then claimed and prepared from scratch, as if it had queued behind the import: a `remember` or
  `add_timeline_entry` applies on top; a `put_page` with `expected_revision` meets the moved page and ends
  `revision_conflict`; a blind (`force`) `put_page` or a `capture` lands over it. An import that lands without covering
  the file only re-arms the hold at the new commit. A later request to the same page waits behind the
  held one (it is held too); an effect or a maintenance read of the file (Git and withdrawal-mirror
  effects, lint, drift checks) is never refused by a hold (GST-1623). A write deferred behind a refresh
  that meets `pending_import` takes the refresh-change check on that file first: a refresh that changed
  it ends the write `revision_conflict` there, and otherwise the hold clears the released
  `deferred_refresh_id`, so a consumer from before v294 never claims a row whose import is pending. The receipt reads `queued` with
  `deferred: { pending_import: true }`, and the caller's wait returns pending at once.

**After a refresh that did not complete.** While a refresh runs, its fence refuses the managed sync that would import
another writer's commit, and only the refresh's own member sync imports in its place. A refresh that ends `aborted`
(in its own run, by `--abandon`, or rolled back by `--resume` or the owner's scan after its process died) never runs
it, so a write released from it and then held for that import would wait for some later sync or refresh, indefinitely
while the checkout stays diverged. GST-1853: while the worktree's newest refresh is `aborted`, every refresh run on the
owner host (a tick, `--resume`, `--abandon`, even one its precheck refuses `refresh_diverged`) ends, after its own
locks are released, by running the managed `--no-pull` sync of each member whose `last_commit` is not the checkout
HEAD and that the run did not already sync, within `sources.refresh_sync_budget_ms` (`syncAfterUnfinishedRefresh`;
the run lists them in `synced` once each, and a refusal's message names them). A refusal of the run's own arguments,
`refresh_in_progress` and an unexpected failure skip it. The held writes are then prepared again against the checkout as it is, as above: an
`expected_revision` put ends `revision_conflict`, a blind put or capture lands and names what it replaced, an append
applies on top. Releasing them this way, instead of refusing them, gives the caller an answer within the run, and a
refusal would only be held again on retry while the import stays pending. A member this sync cannot bring to HEAD (its
drain blocked or out of budget) is named with `gbrain sync --source <id> --no-pull` in `next` (a blocked one also in
`sync_blocked`) or the refusal's message, and waits for the next run or sync; its held writes stay bound by the wait
limit below.

**What a blind write replaced.** A held `put_page` or `capture` that replaces content an import brought in names
it in three places, so the replacement is auditable and recoverable without digging: the receipt's
`supersedes` (`slug`, `path`, the replaced `revision`, the imported `commit`: the newest commit
after the held-at commit that touched the file; a capture whose captured bytes are that commit's file
replaced nothing and names none, #8759), a `gbrain-supersedes: <path>: revision <id> from
<commit>` trailer on its commit, and a `supersedes` list on that commit's ledger line (effect and
door commits). The replaced revision stays in `page_versions` and the imported commit stays in
Git, an ancestor of the write's commit.

**Age bound and schema.** A row held for an import that has not landed within
`persistence.refresh_barrier_max_wait_ms` of its hold (measured from the hold, not from admission), or
whose admission is older than four wait limits (at least four hours) however often it was held again
(GST-1623), ends `failed` with `pending_import_expired` in the owner's housekeeping turn, which rechecks under the
request lock that the row is still unclaimed and its import still pending. A `remember` ends as its
`pending_import` refusal did instead (conflict `source_changed`, origin `pending_import`), so the
first sync that imports the file replays the fact; one that named no entity is not replayed, and its
message sends a person to `gbrain repair failed-writes`. A source row is removed only through writer
administration, which ends its deferred rows `source_changed`, so no held row outlives its source. Migration v294 adds the nullable `persistence_requests.deferred_import_from` and
widens `gbrain_guard_deferred_request`: a running row may move to `deferred` only under the barrier's
session declaration and only naming the import it waits for, and a deferred row moves to `running`
only once every hold it names is released. Only the write owner's consumer holds a row for an
import, and only when every live consumer of the owner host advertises `refresh_barrier_import_1`
(a barrier consumer from before v294 would stall on the held row); otherwise the write keeps the
`pending_import` refusal.

### Idempotency

The request id is the idempotency key. A replay of a deferred request id finds the prior row (same
target, same protocol 1) and returns its receipt: pending while `deferred`, then whatever it
became. A request id first refused `worktree_refreshing` (nothing recorded) is admitted on retry,
deferred or not. A replay whose intent digest differs is `idempotency_conflict`, unchanged.
Tests cover replay during the refresh, after release, after the flag is turned off, and two
concurrent admissions of one request id.

### Authorization re-check at commit

A deferred row can wait minutes. At claim, a deferred row re-runs
`authorizeWrite(authority, operation, slug)` against current grants (scope, member binding,
readable_by of the target). A revoked or narrowed credential finishes the row `permission_denied`
(terminal, nothing applied). The source binding and incarnation are rechecked by the existing claim
path (`source_changed`).

### Crash recovery

Deferred rows are durable rows; nothing about them lives in process memory.

- Admitting process dies after commit: the receipt exists; the caller replays the request id.
- Refresh process dies: its row stays active; orphan adoption or `sources refresh --resume`
  completes or aborts it, and the trigger releases it. `--abandon` aborts, which also releases.
  The row records `outcome.merge_started` (false when it is fenced, true just before
  `git merge --ff-only`), so recovery tells a merge that never ran from one that ran:
  - Killed while `fenced`, before the merge started, with HEAD moved past `old_head` on its own line
    (writes that landed while it drained, or a commit gbrain did not make): recovery aborts the row,
    as the live tick would, and its deferred writes commit (GBEV-44, GST-1674).
  - Killed after the merge started but before HEAD reached the target (a commit landed on `old_head`
    right before the merge, so git refused the fast-forward): the row also records
    `outcome.merge_started_at`, and when the reflogs of HEAD and its branch show no move to the target
    since then, recovery aborts the row the same way and keeps that commit (GST-1674). It reads the
    last 1 MiB of each reflog file and needs an unbroken old-to-new chain from HEAD back past the merge
    start (or to the log's first entry). Without a readable reflog, with a gap in the chain, with a
    tail that ends inside that window, or on a row an older version wrote, it stays `recovery_required`.
    A reflog read git cannot finish leaves the row `fenced` for the next scan. Refresh git calls
    drop `GIT_COMMITTER_DATE`, so the merge's reflog entry carries the clock recovery compares with.
  - Killed after the merge, with HEAD at the target or a commit on top of it and no member synced off
    it: recovery records the merge and the next refresh finishes the member syncs, with no `--resume`.
  - A merge that ran and a HEAD that no longer holds the target (a reset and an unrelated commit)
    stays `recovery_required` for the operator.
  - The merge runs only when the update that records `merge_started` matched the `fenced` row; a row
    recovery moved meanwhile ends the refresh `refresh_source_changed` with nothing merged (GST-1623).
- Consumer dies after claiming: the row is `running` with a lease; ordinary expiry and reclaim.
- Release and the deferred-to-running claim are single statements.

### Mixed-version contract

- **What an older consumer cannot claim:** rows in state `deferred`. No older selector names the
  state, and the deferred-row guard refuses the transition without the new session declaration.
- **What an older admitter does:** it never defers (it refuses `worktree_refreshing` as today),
  which is safe.
- **When a new admitter defers:** only when the flag is on and every live consumer of the worktree's
  owner host (`persistence_consumers`, renewed within `CONSUMER_LIVE_MS`) advertises
  `refresh_barrier_1` in `capabilities`; otherwise it refuses as today. A consumer started later by
  an older binary still cannot claim a deferred row; what it could do is claim a queued row of the
  same worktree ahead of a released deferred one, which is why the upgrade order below requires
  quiescence of older binaries before the flag goes on. A doctor check that reports a live consumer
  without the capability on a brain with the flag on, and a gate on older refreshers, are follow-ups
  (#8688); until they land the upgrade order below is the only guard.
- **Upgrade order:** apply the migration (harmless with the flag off) → upgrade every binary on the
  owner host → restart resident consumers so their heartbeats carry the capability (quiescence) →
  watch a clean deploy → turn the flag on per brain.
- **Turning the flag on** (`gbrain config set persistence.refresh_barrier true`, env
  `GBRAIN_REFRESH_BARRIER`, a `WRITE_SWITCHES` entry with `defaultOn: false`) is gated
  operationally on a clean deploy watch and on every routed producer of that brain having its three
  proofs (pending to committed, pending to conflict, restart), reported by the box lane. Turning it
  off stops new deferrals; existing deferred rows still drain.
- **Downgrade order:** turn the flag off → wait until every write admitted deferred has finished → downgrade.
  `gbrain upgrade --check-downgrade` (read-only, new) exits 0 when none remains (a released row that
  a consumer claimed counts until it commits or fails, because an older consumer that recovers it
  skips the refresh-change check) and exits
  3 with `downgrade_blocked_deferred_writes` (count, oldest age) otherwise; the box's automatic
  binary restore calls it and refuses to restore an older binary on exit 3. Safety does not rest on
  that gate (an older binary cannot claim the rows); liveness does: after a downgrade they would wait
  for the next upgrade.

### Surfaces

- CLI write verbs: deferred → exit 10 with the receipt (`state: deferred`, `deferred`), `--json`
  carries `outcome: pending`. This holds on every CLI route: the owner socket asks dispatch for the
  `write_pending` error (`pendingAsError`), and a thin client turns a `status: "pending"` success
  into the same pending error. `gbrain write-request <id>` shows the deferral until it drains; it
  only reads the receipt. A released row publishes when a process runs the write consumer on the
  owner host (`gbrain serve`, `gbrain jobs work`, any write or sync import there). Its receipt health
  counts a released deferred row as an earlier write, and every write on a worktree whose refresh
  awaits recovery (a deferred one included) reports `recovery_required` (GST-1623).
- A replay of an accepted request id reconciles to its receipt before any deferral, so it is never
  deferred again behind a refresh awaiting recovery.
- The `worktree_refreshing` retry hint reads the worktree's newest completed refreshes through
  `persistence_worktree_refreshes_completed` (`(worktree_id, completed_at DESC) WHERE state='completed'`,
  migration v295), and a managed sync drain never sleeps a hint past its own refresh budget.
- MCP: deferred → `isError: false`, `status: "pending"`; `requestLogStatusForResult` classifies a
  pending non-error result as `accepted_pending` (today it only reads pending from error results).
  Other `write_pending` results (an acknowledgement lost to the owner) are unchanged.
- With the flag off nothing changes, and two refusals are pinned non-zero on both surfaces by tests:
  `worktree_refreshing` and the held-file refusal (`source_changed` with the held-file diagnostic,
  verb-errors.ts). CLI exit is non-zero; MCP is `isError: true`.
- `gbrain sources writer status --json` gains `deferred: { count, oldest_age_ms, refresh_id }`, and
  receipts render state `deferred` as pending.

## Part 2: per-path base check on commit-push

`gbrain git commit-push --base <path>=<blob> [--base ...] -m <msg> -- <paths>`: after taking the
commit lock and before staging, each named path's blob at HEAD (`git rev-parse --verify -q
HEAD:<path>`) must equal `<blob>` (full object id), or be absent when `<blob>` is `absent`. Any
mismatch refuses `commit_base_moved` naming the path, the base and HEAD's blob; nothing is staged
or committed and the index is unchanged. The fix tells the writer to re-read the file at HEAD,
recompute and retry with the new base. A `--base` path must also be one of the committed paths.
This is the commit-push half of soak mode (m).

## Part 3: commit ledger

### Where and what

One file per repository: `<git common dir>/gbrain/commit-ledger.jsonl` (inside `.git`, so never
tracked, shared by every worktree of the repository, readable without a database). Appended with
`O_APPEND`, one JSON line under 1 KiB per record, so concurrent appends never interleave.

```json
{"v":1,"e":"commit","t":"<iso>","sha":"<full>","writer":"door","request_id":"<uuid|null>",
 "worktree":"<abs root>","worktree_id":"<uuid|null>","ref":"refs/heads/main","pid":123,"host":"<host id|null>"}
```

Writer kinds: `commit_push` (commitPaths), `door` (commitThroughDoor), `merge` (in-memory merge
commit), `replay` (integrate's commit-tree replay), `effect` (effect worker), `sync_init`
(sync-git auto-init), `workspace_push`, `bootstrap`, `hosted_repo`.

### Sites

One helper, `src/core/git/commit-ledger.ts` (`recordCommit(root, entry)` sync and async). Plumbing sites
ledger the sha right after `commit-tree` returns and before the ref moves, so a commit can never be
reachable without its line. Porcelain sites (`git commit`) write an intent line first and the commit
line after:

| Site | How the sha is known |
|---|---|
| commit-push.ts commitPaths (`git commit --only`) | `rev-parse HEAD` under the commit lock |
| commit-push.ts integrate replay (`commit-tree`, ~711) | commit-tree output |
| commit-push.ts buildMerge (`commit-tree`, ~817) | commit-tree output |
| git-door.ts commitThroughDoor (`commit-tree` + `update-ref`) | commit-tree output, ledgered before update-ref |
| effect-git.ts commitGitTargets (~372) | `rev-parse HEAD` in the same session; request ids of the group |
| sync-git.ts auto-init commit (~611) | `rev-parse HEAD` |
| workspace-push.ts (~1077) | `rev-parse HEAD` |
| bootstrap/repo.ts (~481) | `rev-parse HEAD` |
| persistence/hosted-repo.ts (~199) | commit-tree output |

A shared git runner was considered and rejected: the sites use four different runners (commit-push's
sync `git`, effect-git's session, git-door's session, bootstrap's injected runner), and two of the
commits are plumbing whose ref move happens later, so the line belongs where the sha is known.

### Boundaries, retention, crash reconciliation

- **One ledger lock.** Ledger files live in the common dir, while commit locks are per checkout and
  the door and effect worker hold the native writer lock instead. So the ledger has its own flock,
  `<git common dir>/gbrain/commit-ledger.lock`, taken for the start line, every append and rotation.
  It is held for microseconds and never while git runs.
- **Start boundary.** The first append writes `{"e":"start","t":...}`. Reflog entries older than the
  ledger's start are reported as uncovered, never as foreign.
- **Retention.** At 4 MiB the file rotates to `commit-ledger.1.jsonl` (one previous file kept), under
  the ledger lock. doctor reads both. The covered window is
  `max(ledger start or oldest retained line, oldest reflog entry)` to now, and doctor prints it.
- **Crash reconciliation (porcelain sites only).** The intent line records `head_before`, the commit
  message's sha256 and the writer. A crash between `git commit` and the commit line leaves an open
  intent. doctor lists an unledgered commit under `unconfirmed` only when its parent is the
  intent's `head_before`, its message digest matches and it was created within 60 s of the intent;
  that is a `warn`, never a `fail`, and it is **never written back into the ledger** automatically,
  so an ambiguous outcome cannot certify a foreign commit. A failed ledger append never fails the
  commit (logged once); doctor then reports that commit as foreign, the safe direction for an alarm.

## Part 4: doctor `foreign_writers`

Scope: every registered source checkout on this host, **managed worktrees included**, deduplicated by
git common dir. A brain with no checkout (repo-less) reports `not_applicable`.

**Locally created commits.** It reads the reflogs that record local ref moves: `logs/HEAD` and
`logs/refs/heads/*` in the common dir and `worktrees/*/logs/HEAD` (per-worktree HEAD logs), parsing
commit metadata with `git log --no-walk --format='%H %P %ct'` (not `cat-file --batch-check`, whose
format has no parent atom).

- **Porcelain creations**, whose new sha was created locally by definition: `commit:`,
  `commit (amend):`, `commit (initial):`, `cherry-pick:`, `revert:`, `rebase (pick|reword|edit|squash|fixup)`,
  `pull --rebase (pick)` and `am:`. Each new sha is looked up in the ledger.
- **Other ref moves** (a custom or empty message, i.e. `update-ref` after `commit-tree`): every
  commit in `old..new` (the whole history of `new` for a root move) whose committer time falls
  within 10 minutes of the entry is a candidate; older commits were fetched, not made here.
  Candidates not in the ledger are flagged `plumbing`; a move whose range cannot be read is
  reported `unknown` (warn), never silently dropped.
- **Excluded:** `commit (merge)` and any multi-parent commit, `merge ...` (fast-forwards and
  merges), `pull:` fast-forwards and merges, `reset:`, `checkout:`, `branch:`, `clone:`, and
  push/fetch tracking-ref updates.

Each flagged sha is classified `plain`, `amend`, `rewrite` (cherry-pick, revert, rebase, am) or
`plumbing`; a plain commit made while the enforce guard is installed is labelled
`plain (guard bypassed)`. Reads are bounded: the newest 5,000 entries per log, every git call
time-bounded, and the check stops at doctor's budget and labels its result partial.

**Dirty page files.** `git status --porcelain=v2 -z --untracked-files=all` scoped to the checkout's
source roots lists untracked and unstaged page files. Paths with a pending git effect
(`persistence_effects`, kind `git`, state `queued` or `running`, whose targets name the path) and
paths in the write-through pending ledger are left out: gbrain is about to commit them. Each listed
file carries its age since first seen, read as its mtime (no new state file; a file touched again
reads younger, which errs toward under-alarming, never toward a false alarm). At most 20 are listed
with the total count.

**Verdict.** Any foreign commit in the window: status `fail` with `act`, and a one-line fix naming
the newest foreign commit (`Commit <sha12> (<kind>, "<subject>", <time>) in <checkout> was not made
by gbrain; route that writer through gbrain git commit-push or a page write`). Dirty files older than
30 minutes with no foreign commit: `warn`. The JSON carries the window, every foreign commit (sha,
kind, ref, time, subject, committer identity as recorded), the unconfirmed ones and the dirty list.
The check is read-only.

## Part 5: owner-path guard install

`gbrain git guard --install` refuses a managed worktree today (`assertManagedFilesystemWrite`). New:
`gbrain sources guard <source> --install|--uninstall|--status [--mode enforce]`, CLI-only and
trusted-local. It installs the `prepare-commit-msg` guard on the source's managed worktree only from
its owner host, under the worktree's native writer lock (the owner check `sources refresh` uses).

- **Worktree-local only.** The existing installer resolves the repository's shared hooks directory
  (and honours a global `core.hooksPath`), so installing there would also guard a person's own
  linked checkout. The owner path installs into a hooks directory private to that worktree
  (`<worktree git dir>/gbrain-hooks`) and points that worktree's `core.hooksPath` at it with
  `git config --worktree`, enabling `extensions.worktreeConfig` first so the setting never lands in the
  shared config; the enforce hook also lets through any worktree whose git dir is not its own, so a
  worktree that inherits the hooks path is not guarded. It refuses, changing nothing, when another tool's hook already lives at the effective
  path, and `--status` reports the effective hooks path.
- **Enforce mode** refuses plain commits, `--amend`, `--no-verify` commits, and, unlike the opt-in
  guard, also cherry-pick, revert, rebase and sequencer commits: in a managed worktree only the owner
  commits.
- **Owner commits pass** without changes: the effect worker commits with an empty hooks directory,
  the door and the in-memory merge and replay are plumbing (no commit hooks), sync's auto-init runs
  with `core.hooksPath=/dev/null`, `commit-push` sets `GBRAIN_COMMIT_VIA` under the commit lock, and
  a refresh fast-forward (`merge --ff-only`) runs no commit hook. workspace-push and bootstrap commit
  plainly with hooks on, so the build confirms neither runs in a managed worktree; if either can, it
  takes the commit lock and sets `GBRAIN_COMMIT_VIA` like commit-push.
- A writer that disables hooks itself is not stopped by any hook; the ledger names it. No audit hook
  is added.

## Part 6: bug folds

- **#8615** (repair file-drift `--held`/`--side` without `--prefer` silently surveyed a different
  set): any `--held`, `--side`, `--state`, `--cursor` or `--provenance` call goes through option
  validation. Rewritten on master from contributor PR #8626 with credit and a `Supersedes #8626`
  line; the outside branch is read as text only. The file belongs to PR A's planned set, so the hunk
  is agreed with that lane first.
- **#8616** (an impossible calendar date such as 2026-09-31 aborted a whole preview window with
  `internal_error` from a `::date` cast): left out of this PR. It does not reproduce on current master,
  where the timeline date guard from #8049 already refuses the bad date; nothing changed here.
- **#8617** (`refresh_source_changed` lost a whole tick): exactly one same-tick retry when the cause
  is HEAD moving or work arriving after the drain check, after waiting (bounded by the commit-lock
  wait) for the committing writer to finish. Ownership or membership changes are not retried. A
  second refusal is returned as today.
- **#8662** (commit-push resolved a wrapper's cwd to another repository): when a brain is configured
  and has registered source checkouts on this host, a resolved root that is none of them and carries
  no `gbrain.sourceRoot` marker is refused `checkout_not_a_source`, naming the resolved path and
  the registered checkouts, with `--path <brain checkout>` as the fix. With no brain configured,
  commit-push stays DB-free and behaves as today.

## Tests (red first; PGLite and Postgres where a database is involved)

- **Ledger and foreign_writers fixture**, one repository with seven commit kinds: door, commit-push,
  in-memory merge, plain `git commit`, `--amend`, plumbing `commit-tree` + `update-ref`, and a
  bypass (`git -c core.hooksPath=/dev/null commit` under the enforce guard; plain `--no-verify` is
  refused by the guard and asserted so). Must-not-flag: effect-worker, replay, bootstrap and
  sync auto-init commits, an upstream fast-forward and an in-memory merge. Only plain, amend/bypass
  and plumbing are flagged. Plus: the start boundary, rotation, an open intent reconciled as
  unconfirmed, per-worktree HEAD logs.
- **Dirty files:** untracked and unstaged page files listed by age; a path with a pending git effect
  and a write-through pending path are left out; repo-less `not_applicable`.
- **Owner guard:** non-owner host refused; enforce refuses a plain commit; effect, door and
  commit-push commits and a refresh fast-forward pass.
- **Barrier:** pending to committed across a real refresh, with lanes on and off (the managed sync
  is never held behind deferred rows); a refresh that completes with a blocked member sync (the git
  check still conflicts a changed page); the livelock bound (a write stream during
  draining does not stop the drain); `revision_conflict` when the refresh changed the page;
  kill-and-resume of the refresh process with deferred rows; idempotent retry of a deferred request
  id; an older consumer never selects a deferred row and keeps serving another worktree's queued work, and
  its forced transition is refused by the guard; admission against `recovery_required` refuses and
  admission racing each terminal transition is either normal or deferred, never stranded;
  multi-target operations (rename, forget companions);
  capacity and age bounds; flag off unchanged; repo-less never defers; MCP `isError: false` pending;
  the two refusals non-zero on both surfaces; `--check-downgrade` exit 3 while rows remain.
- **Base check:** a moved blob refuses `commit_base_moved` and leaves the index untouched; `absent`.
- **Bug folds:** one red-first test each (#8615, #8617, #8662).

## Docs and skills

docs/guides/shared-checkout-git.md (ledger, foreign_writers, owner-path guard, `--base`),
docs/guides/sync-unblock-runbook.md (deferred writes in status, `refresh_barrier_expired`),
docs/guides/write-refusals.md (`commit_base_moved`, `checkout_not_a_source`,
`refresh_barrier_expired`, the deferred pending receipt), the error registry entries, and any skill
that names the guard or `worktree_refreshing`. Behaviour-change rows for each user-visible change.

## Review record

One eng-review round (gstack /plan-eng-review method), two voices: Opus 5.5 and GPT-6.1 Sol. Both
verdicts: approve with the listed fixes. Every finding was applied above:

- The barrier is a request **state** (`deferred`), not protocol 3. This fixes the refresh's own sync
  being held behind deferred rows (`FOREGROUND_WAITING_ON`, lane-head and follower checks), an older
  consumer wedging on one row across all worktrees, protocol-2 renewals and finishes failing on
  protocol-3 rows, replay identity conflicts, and the table-locking CHECK widening on
  `protocol_version`.
- Admission locks the refresh row by worktree, with `recovery_required` in the filter, FOR NO KEY
  UPDATE right after the worktree row (new rank in the lock order). This fixes a deadlock with
  `bookkeeping`, a lock-upgrade deadlock in the syncing-completion update, and a normal admission
  slipping in during `recovery_required`.
- The base check is "did refresh R change any of this publication's target paths" from git, after
  preparation. This fixes false conflicts between two deferred writes, a `completed` refresh whose
  member sync was blocked, and multi-target operations. `submit_job` and `skill_bundle` keep
  today's refusal.
- The ledger has its own lock; plumbing sites ledger before the ref moves; reconciliation never
  writes back and needs a message-digest match; rewrite kinds and empty-message ref moves are
  detected; plumbing detection works on ranges; metadata comes from `git log`, not `cat-file`.
- The guard installs worktree-locally, enforce mode drops the rewrite exemptions, and the bypass
  fixture uses a hooks-path override.
- MCP request-log classification reads pending from non-error results; expiry rechecks
  `released_at` and releases counters.

Defaults kept: mtime as the dirty file's first-seen age (no new state file written by doctor), 1000
deferred rows per refresh, and 15 minutes maximum wait.
