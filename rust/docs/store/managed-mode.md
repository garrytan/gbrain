# Managed mode on the Rust store

A managed brain keeps its pages as files in a Git checkout; every write goes to the database and to
that checkout. The Rust engine holds the `managed_persistence` capability back
(`src/core/rust-engine/store-capabilities.ts` `HELD_FOR_CALLERS`), so a user's Rust brain refuses
managed mode by name. The members below serve managed mode behind that hold; a test lifts the hold
on one engine instance (`test/engine-parity/rust-managed.ts`) and
`test/engine-parity/managed-on-rust.test.ts` compares them with PGLite and Postgres.

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
- Where it stops: statements the pass reaches only for a held cursor of an older release (`sync-run.ts` cursor saves, the legacy
  waivers), `sync status`, `sync-pass-fold.ts`' refused-checkpoint read and the Postgres planner statistics still refuse on Rust
  naming `executeRaw`. The managed hold stays: the member refuses while `managed_persistence` is held, as `executeRaw` did.
