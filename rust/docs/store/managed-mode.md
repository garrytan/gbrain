# Managed mode on the Rust store

A managed brain keeps its pages as files in a Git checkout; every write goes to the database and to
that checkout. A single-host Rust store reports the `managed_persistence` capability
(`src/core/rust-engine/store-capabilities.ts`), and the members below serve managed mode; the
`test/engine-parity/managed-*-on-rust.test.ts` files compare them with PGLite and Postgres on all three arms.

A multi-user store serves it too (lane LM slice 3; `MULTIUSER_WITHHELD` is empty). Managed mode there is a
double guard, not a file lock alone: every worktree, topology and refresh lock is an I-5 lease
(`managed:topology:<brain_id>`, `managed:worktree:<worktree_id>`, `managed:refresh:<worktree_id>`; 60 s, renewed every
10 s while held) with the owner host's native file lock beneath it, taken lease first and released native first
(`src/core/persistence/managed-lock.ts`). PGLite, Postgres and a single-host Rust store take the native lock alone, exactly
as before. The store itself holds no file lock, no process mutex and no busy error.

- The lease fences store writes across hosts and processes. The native lock stays, because a lease cannot stop a paused
  process from touching files it already holds a path to: a paused writer blocks a same-host successor's file work until it
  exits. A checkout lives on its owner host and is not replicated.
- The holder of a lease is the process's own host registration (`process:<host>:<pid>:<nonce>`,
  `managed-registration.ts`), taken before the first managed lock or the consumer's first claim and released when the
  engine disconnects. Without one a lock or a protected write refuses `lease_lost` / `fence_missing`. A second process that
  reaches the brain over the owner socket holds no store, takes no lease and refuses when the switch is on.
- An operation's handle holds its host fence and its managed tokens, immutable. Every protected write transaction of the
  process asserts those exact tokens inside the writing transaction (`managed-operations.ts`, called from
  `store-members/transactions.ts`), on every run of the callback. A renewal that finds a lease lost marks the handle
  lost for good; the process's protected writes then refuse `lease_lost` until the holder releases. A host registration that
  was replaced while old work was suspended cannot be borrowed: the old operation's captured fence is the old epoch.
- Claims carry epochs in `~L 0x05` side records: write claims (group followers and group completion included), effect
  claims (coalesced Git effects included), job, drain-lease and cycle-lock claims, refresh rows (`CLAIM_REFRESH = 0x06`,
  the refresh row id) and managed sync checkpoints (`CLAIM_SYNC_CHECKPOINT = 0x07`, `<op>\0<fingerprint>`). Each runs
  `fence::begin` in its own write transaction, checks `claim_held` on every mutation and clears the record when the claim
  ends; a new holder adopts abandoned work only by taking a new claim. A refused call writes no row and no counter
  (`persistence/claim_fence_tests.rs`, `test/rust-managed-claim-fences.test.ts`).
- Lock order is the order the code already took its native locks in: refresh, then topology, then worktrees by id. A wait
  polls `acquire` within the caller's own deadline and ends with the caller's own busy answer (`write_pending`,
  `writer_lock_unavailable`). The same-host waiter marker protocol (`worktree-lease.ts`) orders background writers and
  keeps working beneath the lease; parallel lane leases stay unreachable on Rust (bulk lanes are Postgres-only,
  `sync-group.ts`). There is no waiter order across hosts.
- Raw native-lock calls that remain take no managed lock: liveness probes (`probeNativeLock`), the activation and admin
  probes, the link-backlog drain's host-local dedupe lock and host identity files (`test/managed-lock-callers.test.ts`).

Expiry window, as written in `docs/designs/rust-engine/multi-user-server.md`: the store checks a lease's expiry when
`assert` runs inside the writing transaction, not at commit. A writer that asserted a live lease can still commit after the
lease's expiry time while nobody has taken the lease over. A takeover that commits between the assert and the commit puts
the lease row in the transaction's read set and refuses the commit (`write_conflict`; the retry refuses `lease_lost`), and
the single-writer store and an explicit transaction hold the writer from assert to commit, so no takeover lands in
between. That late commit is safe: no other holder exists, and the owner host's native lock still excludes a same-host
successor from the checkout files. Takeover fencing is provided; expiry at commit is not.

On an owner-IPC client the store members that answer an object of functions refuse by name (`owner-ipc/routes.ts`):
managed mode runs in the owner process. A member gate (`store-members/managed-hold.ts`) still refuses each managed store
member by name on an engine whose store does not report `managed_persistence`.

Each family is one BrainEngine store member whose SQL lives unchanged in `src/core/engine-sql/`, and
on this engine one tagged read call and one tagged write call (`{ kind, ...args }`).

| BrainEngine member | SQL | Rust | Calls |
| --- | --- | --- | --- |
| `gitDurabilityStore()` | `engine-sql/git-durability.ts` | `persistence/git_durability.rs` | `gitDurabilityRows`, `gitDurabilityWrite` |
| `gitEffectStore()` | `engine-sql/git-effects.ts` | `persistence/git_effects.rs` | `gitEffectRows`, `gitEffectWrite` |
| `topologyStore()` | `engine-sql/topology-store.ts` | `persistence/topology_store.rs` | `topologyRows`, `topologyWrite` |
| `refreshStore()` | `engine-sql/refresh-store.ts` | `persistence/refresh_store.rs` | `refreshRows`, `refreshWrite` |
| `groupPublishStore()` | `engine-sql/group-publish-store.ts` | `persistence/group_publish_store.rs` | `groupRows`, `groupWrite` |
| `manualLinkStore()` | `engine-sql/manual-links.ts` | `link_queries/manual_links.rs` | `manualLinkRows`, `manualLinkWrite` |
| `claimCoalescedGitEffects(input)` | `engine-sql/persistence-effect-worker.ts` | `persistence/effect_worker.rs` | `claimCoalescedGitEffects` |

## Locks become stated guarantees

The SQL takes row locks (`FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`) and sets transaction bounds
(`lock_timeout`, `statement_timeout`, `synchronous_commit`, `gbrain.topology_change`). The Rust store
takes none of them and adds no lock of its own (no file lock, no process-wide mutex, no busy error):

- An explicit transaction is Serialized: it holds the store's writer, so no other commit interleaves
  with what it read. The callers' compare-and-set checks on owner epoch, topology generation,
  incarnation and state stay as they are.
- Under optimistic transactions (`GBRAIN_RUST_MULTIUSER=1`, lane L1) every record these members read
  is in the transaction's read set, so a racing change aborts the commit with `write_conflict`
  instead of being missed.
- The coalesced Git claim stamps each effect it read in the same write, so two claimers never both
  claim one effect.
- The checkout-level native locks of `withTopologyLocks` (`GBRAIN_HOME/locks`) are the same on every
  engine: they guard the checkout's files on this host, not the store.

## What each family answers

- Git durability: the newest skipped Git effect per file of a worktree's current incarnation (the
  catch-up plan), its re-queue under the plan's predicates (`data.durability_catch_up` + 1), and the
  host binding's `git_durability` (null when no binding matches; another value is the CHECK's
  `constraint_violation`). The parked-push retry reads the requests of a worktree whose failed,
  unsettled Git effect is held on a push code (its own, or a parked target's under `targets_parked`;
  byte order of source, request id and journal id) and the aggregate over a source's holds on a former
  worktree (count, lowest code in byte order, worktrees, five request ids), and re-queues a failed
  effect still failed on its code, unclaimed and with no recovery.
- Git effects: whether a worktree has a queued or running request, the `bool_and` over its requests
  that hold a recovery record (null when none does), whether any request holds one, the yield of a
  claimed group to queued publications (`publication_pending`, due after the delay), and the plain
  outcome of a group with no durability (`targets_parked` when targets parked). Every write names
  each effect by id and claim token.
- Topology: the worktree rows in id order, the active refresh other than the caller's, member
  sources, host bindings, the canonical stamp (md5 of `page id:knowledge revision:incarnation` in
  page id order, soft-deleted pages included), unsettled requests in sequence order, the blocking
  effect, the receipt counters (a missing counter row changes nothing; one below zero is
  `constraint_violation`), retire admissions, the lifecycle's source writes (archive keeps an
  earlier archive time and sets a 72-hour window), the incarnation delete with its scrub
  (`sources/archive.rs` `delete_source_incarnation_in`), page batches in page id order, and the
  moved-checkout reads. The managed clone and its recovery add the worktree manifest and its owner,
  the recovering changes of a worktree, the change by id, the recovering worktree insert and state
  writes, the clone's source binding (no relative path, generation 1), a change's recovery record,
  its close (`COALESCE(outcome,'{}')||outcome`, recovery cleared) and commit (a null outcome stays
  null), and the source's sync reset. The owner facts (`ownerActivity`) are the heartbeat, the newest
  committed non-sync request and the newest managed-sync completion of each source's current
  incarnation; this engine keeps no consumer row, so `live` is false (as on PGLite).
- Manual links: the page's fenced edges by target slug, type and source in byte order, its manual
  dated statements, the relationship's database-only and fenced edges (a null link source is
  database-only only when no producer is managed), the fence projection's link and transition
  writes (an existing fenced edge keeps its id; a transition with the same identity is not
  inserted again). The link-transition identity always carries the link source here.
- Refresh: the refresh row (every column of `persistence_worktree_refreshes`, state transitions that stamp
  `completed_at` and, on the first move into `completed` or `aborted`, `released_at`, as the release trigger
  does), the one active refresh per worktree (a second insert answers the `23505` violation), the drain counts
  (requests including released deferred ones, checkout effects, recovery records), the publication and topology
  recovery probe, unfinished managed-sync cursors, the held-for-import move of a running claim, the later-write and
  backlog reads of the barrier, the owner-activity evidence (no consumer row exists, so no consumer is live), and the
  active, resumable and stuck refresh lists. `sources.last_commit` is stored: `completeSyncedRefresh` and the import
  hold's landing compare it. `hasDeferralRoom` stays true while no consumer row exists. The claim stamp's
  `passed_sync` is true when an earlier queued sync row of the worktree exists.
- Group publication: the claim of a group's followers (the group key of each request, the prefix that ends at a
  non-member, a recovering, backed-off or charged member), claim renewal and dispatch marks by token, the group's
  recovery check, the publication mark, the completion applied member by member in the caller's transaction (it stops
  at the first member that does not fit and the caller rolls the group back), and the import path check's source
  roots and pending-import checkpoints.

## Managed sync (`runSyncStatement`)

`gbrain sync` of a managed source sends its reads and writes as named statements (`src/core/engine-sql/managed-sync-store.ts`
holds the text PGLite and Postgres run; `rust/crates/gbrain-store/src/persistence/managed_sync_store.rs` answers each name on
Rust). One tagged read call (`syncStoreRows`) and one tagged write call (`syncStoreWrite`) carry them.

- What it answers: the same columns, filters and row choice as the SQL (`DISTINCT ON`, `LIMIT`, `ORDER BY`), from the source,
  page, request, effect, config and `op_checkpoints` records. A column the SQL casts to `text` is a string; a `bigint` is a number.
- Row locks (`FOR UPDATE`, `FOR SHARE`, `FOR KEY SHARE`) are stated guarantees, not reads: an explicit transaction is Serialized
  (it holds the store's writer), and under optimistic transactions the rows read are in the read set, so a racing change aborts
  the commit with `write_conflict`. Session settings (`set_config`, `SET TRANSACTION ISOLATION LEVEL`) change nothing.
- No transaction ids: the proof-carrying confirm round (`sync-pass-confirm.ts`) reads `xmin`, `age` and the `txid_*` snapshot
  functions, so a Rust brain takes the whole read each round (`proveConfirm` answers `no_xids`; the pass skips the mark).
- Page faults, status and freshness (`managed_sync_status.rs`): the page-fault proofs (`pageChangeProof`, `idempotentDeletionProof`), the older
  cursor's manifest read and checkpoint publication, `gbrain sync status` (the failure's clock, the live cursors, the knock-on receipts, the
  landing gaps), the dry run's writer state, the recorded stop, the hold sweep's soak counters and needs-human stamp, and the freshness
  aggregate (commit to searchable and to embedded, from the visible chunks of each sampled page). The knock-on predicate's strings
  (`sync-knock-on.ts`) go in as the statement's last parameter, as the doctor terminal reads send theirs.
- Where it stops: the Postgres-only bulk admission (`sync-run.ts` `admitAndSave` and its reads, `sync-drain.ts` warm-up) is
  unreachable on Rust (`resolveGrouping` enables bulk only on Postgres), and the Postgres planner statistics refuse naming
  `executeRaw`. On an engine that withholds `managed_persistence` the member refuses as `executeRaw` did.
