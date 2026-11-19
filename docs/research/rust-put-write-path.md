# The page write path on a Rust brain: every statement one `put` runs

Research map, pinned to `rust-engine/persistence-slice1` at `b398907206`. It lists every SQL statement that one
`gbrain put` of a new page runs on a PGLite brain, with the typed member that can serve it on a Rust brain, the
owner of that member, a size, and whether a Rust brain can answer with no stored state. On a Rust brain
`executeRaw` is not implemented (capability `raw_sql`), so every statement below refuses with
`engine_capability_missing` until a typed member replaces it.

The work plan in [RUST_ENGINE_INTERFACES.md](../designs/RUST_ENGINE_INTERFACES.md) splits work by family. This map
gives the same split for the page write path, so the statements can go to several people at once.

## Counts

| Item | Count | Meaning |
|---|---:|---|
| Engine calls | 309 | Every `BrainEngine` call the run makes, typed members included, from connect to disconnect. |
| Raw SQL calls | 177 | 176 `executeRaw` and 1 `executeRawDirect`. |
| Distinct statements | 112 | Distinct pairs of call site and SQL text. 109 distinct SQL texts: three texts run from two sites each. |
| Call sites | 108 | After the real caller replaces the helper frame (see "Method"). |
| Served now | 3 | The persistence brain row (slice 1) and the page snapshot (inside the served `readPageSnapshot`). |
| Existing typed member | 17 | A member on this branch returns the same rows; the call site switches with no new store code. |
| No stored state needed | 36 | Empty lists, `false`, `null`, a no-op setting or a no-op lock: a Rust brain is never managed today, and one store write has one writer. |
| New member with real records | 56 | Real reads and writes of journal, page, link and projection records. |

An earlier count of 118 statements came from a trace without call sites (196 raw SQL calls). This trace runs on a
newer branch with the slice 1 changes, which moved some reads to typed members. Use the numbers above.

Typed members the run calls that a Rust brain does not serve yet, besides the raw SQL:

| Member | Calls | Capability | Owner |
|---|---:|---|---|
| `transaction` | 17 | `transactions` | persistence |
| `transactionDirect` | 9 | `transactions` | persistence |
| `lockPageKeys` | 6 | `transactions` | persistence |
| `applyTransactionSettings` | 1 | `transactions` | persistence (trust hook) |
| `lockPersistenceCounters` | 5 | `persistence_journal` | persistence |
| `readWriteRequest` | 2 | `persistence_journal` | persistence |
| `readLedgerSource` | 2 | `persistence_journal` | persistence |
| `insertWriteRequest`, `stampWriteClaim`, `completeWriteRow` | 1 each | `persistence_journal` | persistence |
| `replaceDerivedAliases` | 1 | `pages` | aliases |
| `moveChunkIndexes` | 1 | `chunks` | core |
| `holdsDatastoreLock` | 3 | none: a PGLite method that `effect-journal.ts:295` reads off the engine root | persistence (answers false) |

## Method

- Fixture: a fresh PGLite brain with one source, then `gbrain put notes/a` with a short body. The run exits 0.
- A scratch patch to `src/core/engine-construct.ts` (never committed) wraps every PGLite engine method and logs the
  transaction depth, the member name, the first stack frame outside the engine and the SQL helpers, and the first
  600 characters of the SQL.
- `page-state/transactions.ts:81` (`pipelined`) runs a list of calls one after another on PGLite, and
  `page-state/transactions.ts:66` (`transactionMemo`) caches a read for one transaction. Their stack frame hides the
  real caller, so the table names the real caller where it is known (for example `persistence/journal.ts:830` for
  the claim select).
- "In tx" means the statement runs inside a `transaction` or `transactionDirect` callback. "Outside" means it runs
  on the root engine.

## Limits

- Only the create path is traced. A second `put` of the same page without an expected revision stops at
  `revision_required` (83 calls), so the update path, the delete path and a put with embeddings are not traced.
  An update adds the version snapshot, a lower trust tier on a content change and the old chunk delete. Expect a
  few more statements in the projection and page families.
- The fixture brain is unmanaged and has no guest sources, no shared skill packs, no access members and no memory
  proposals, so branches that need them are not traced.
- Sizes are judgments from the size of the PGLite code each member reproduces, not measurements:
  S is less than half a day, M is half a day to a day and a half, L is two days or more.
- Line numbers are on this branch. They move when the files change.
- The CLI members branch (`rust-engine/cli-members` at `488df92b39`) moves the config reads at `persistence/limits.ts`
  and `persistence/capacity-forecast.ts:92` to typed config reads. The tables mark them "existing".

## Phases of one put

| Phase | Trace lines | What runs |
|---|---|---|
| connect | 1-13 | Persistence probes at connect: brain row, graduation, deactivations, managed root bindings. |
| admit | 14-36 | Request identity, source and writer authority, the shared-skills knowledge guard, the page snapshot, the worktree binding, the journal limits. |
| request | 37-48 | `transaction` around `insertWriteRequest` (`retryWriteAdmission`). |
| claim | 49-68 | `claimNextWrite` and `claimPersistenceEffect`: a `transactionDirect` with nested `transaction` calls, depth up to 4. |
| prepare | 69-113 | Config reads, link preparation, source reads, `compareFileTarget`, `renewWriteClaim`. |
| recovery | 114-117 | `prepareRecovery`: a short transaction that records the recovery bytes. |
| publish | 118-187 | `publicationTransaction`: the page write, the origin guard, the fact, timeline, take and link projections, the seal, the write context, `queuePublicationEffects`, `completeWriteRow`. |
| clear | 188-191 | `clearResolvedRecovery`. |
| after | 192-273 | The effect consumer and housekeeping after the write. |
| disconnect | 274-309 | Housekeeping at disconnect. |

## Proposed split

Counts are statements from the tables below: new member, existing member, no stored state.

| Owner | New | Existing | No state | Size |
|---|---:|---:|---:|---|
| persistence: transactions (`transaction`, `transactionDirect`, `lockPageKeys`, `readTransactionSettings`, `applyTransactionSettings`) | typed members only | | | L, about 3 days |
| persistence: trust hook (`setWriteContext`, the `trust::stamp` calls) | 1 | 0 | 0 | M, about 1 day |
| persistence: write journal (the 7 typed journal members above, plus these statements) | 10 | 3 | 3 | L, about 4 days |
| persistence: effect journal | 8 | 0 | 2 | L, about 2.5 days |
| persistence: managed-only state | 0 | 0 | 17 | S to M (decision A) |
| persistence: housekeeping (receipts, compaction, capacity, checkpoints, projection jobs) | 13 | 3 | 2 | L, about 3 days (decision B) |
| core: page write guard, origin guard, ingest stamp, seal | 7 | 2 | 4 | M, about 1.5 days |
| link_queries | 5 | 1 | 0 | M, about 1.5 days |
| timeline_queries | 2 | 0 | 0 | S |
| takes | 2 | 0 | 0 | S |
| facts | 1 | 0 | 0 | S |
| trust (fence rows with `trust_tier`) | 1 | 0 | 0 | S |
| page_body (segment storage probe) | 1 | 0 | 0 | S |
| sources (members from the CLI members branch) | 0 | 7 | 0 | S |
| jobs (connect gate) | 0 | 0 | 6 | S to M, about 1 day |
| unassigned: shared skills, memory proposals, access, chronicle | 5 | 1 | 2 | M, about 1.5 days |

The total is about 25 days. The transactions, trust hook and write journal rows are on the critical path for `put`:
nothing past the request phase runs on a Rust brain without them. The other rows can start now and land in any
order; each one removes refusals from a later phase.

### Decisions

- **A. Managed-only state.** 17 statements read worktree bindings, refresh gates, Git effects, mirror gates and
  recoveries. A Rust brain is never managed, so each one answers empty. Two ways to serve them:
  (1) one typed member per read, each answering empty on Rust (about 13 small members, about 2 days); or
  (2) one engine capability, `managed_persistence`, that is false on Rust, and the TypeScript callers skip the reads
  when it is false (about half a day, and a later managed Rust brain turns the capability on). Recommendation: (2).
- **B. Capacity forecast.** `persistence/capacity-forecast.ts` runs five reads after the write to forecast journal
  growth. It is advisory. Serve it (about 1 day), or skip it on a Rust brain until the journal grows on Rust.
  Recommendation: skip it now; it is not on the critical path.
- **C. Row locks.** 12 statements take `FOR SHARE` or `FOR UPDATE` row locks, one takes an advisory lock, and the
  page write guard inserts a guard row only to take a lock. Inside one Rust store write there is one writer, so these
  locks are no-ops. The proposed members read the same rows without a lock. This holds only if every statement of
  `publicationTransaction` runs inside one store write (see "Transactions").

## Transactions

- One store write transaction stays open across several napi calls from one TypeScript callback. `transaction` and
  `transactionDirect` open it, hand the callback an engine bound to it, commit when the callback returns and roll
  back when it throws, then rethrow the same error.
- A nested `transaction` joins the outer one: an outer throw rolls back the inner writes too. The trace reaches
  depth 4 in the claim phase.
- `lockPageKeys` holds its keys until the store write ends. Keys are taken in sorted order, like the Postgres
  advisory locks.
- A store bound to an open transaction has its own vector cache (`bound_to` in the design notes).
- `readTransactionSettings` and `applyTransactionSettings` read and set a settings map that belongs to the open store
  write and ends with it. Only the `gbrain.*` names the TypeScript code uses are accepted; any other name refuses.

## Trust hook

PGLite stamps `trust_tier` and `write_origin` in the trigger `gbrain_stamp_trust_tier` (`src/core/trust/schema.ts`),
on `pages`, `facts`, `takes` and `timeline_entries`. The trigger reads transaction-local settings that
`persistence/context.ts` sets: the tier and origin (`gbrain.write_trust_tier`, `gbrain.write_origin`), the promotion
ceiling, the backfill flag and the keep list. On a Rust brain the `set_config` calls refuse, so every Rust row reads
`unknown`.

- **`setWriteContext`**: a typed member in the `transactions` capability. It holds the attribution (request id,
  principal kind and id, source list) and the trust declaration for the open store write. It replaces the
  `executeRaw` calls at `persistence/context.ts:73` (`withCoordinatedWrite`), `:115` (`setMemberAttribution`) and
  `:133` (`currentWriteTrust`). The promotion, backfill, keep and open-facts scopes already go through
  `applyTransactionSettings`, so they reach the same map.
- **`trust::stamp`**: `write_page` and the facts insert call
  `trust::stamp(ctx: &WriteTrust, table: TrustTable, row: StampRow) -> Result<Stamped>` with a `WriteTrust` built from
  the settings map. The function is in `gbrain-store/src/trust/stamp.rs` on the trust family's branch (`caa958bbd3`).
  A refused raise is a store error with code `trust_raise_refused`, the same code
  `persistence/publication-failure.ts` gives the PGLite trigger refusal.
- A page version snapshot copies the page's tier and origin (`gbrain_snapshot_version_trust` on PGLite), so
  `pages.rs` `snapshot_in` copies them too.
- Takes and timeline rows are stamped by the takes and timeline families when they write those rows.
- Size: M, about 1 day.

## Statements by family

Each table lists the distinct statements in first-run order (`#`). "Calls" counts calls in the traced run.
"Existing" means a member on this branch already returns the rows. "No state" says whether a Rust brain can answer
without stored records.

### Connect gate (6)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 1 | `persistence/filesystem-guard.ts:18` | 1 | connect | read, outside | `SELECT to_regclass('persistence_brain') IS NOT NULL AS present…` | `hasPersistenceTables` (or a capability) | jobs (connect gate) | S | Yes: true, the Rust store always has the journal |
| 2 | `persistence/managed-mode.ts:92` | 4 | connect, after, disconnect | read, outside | `SELECT brain_id,enabled,to_jsonb(persistence_brain)->>'mode_epoch' AS …` | served: `readPersistenceBrain` Rust branch | persistence (slice 1) | done | Yes: fresh-brain row from the brain id |
| 3 | `persistence/filesystem-guard.ts:30` | 3 | connect, after, disconnect | read, outside | `SELECT h.local_path,s.source_id,s.source_incarnation,s.worktree_id,s.t…` | `listManagedRootBindings` | jobs (connect gate) | S | Yes: empty, a Rust brain is never managed |
| 4 | `persistence/graduation-schema.ts:134` | 1 | connect | read, outside | `SELECT role, run_id::text AS run_id, state, source_data_dir FROM persi…` | `readGraduationRow` | jobs (connect gate) | S | Yes: no row |
| 5 | `persistence/deactivation.ts:362` | 1 | connect | read, outside | `SELECT to_regclass('persistence_topology_changes') IS NOT NULL AS pres…` | `hasPersistenceTables` | jobs (connect gate) | S | Yes: true |
| 6 | `persistence/deactivation.ts:331` | 1 | connect | read, outside | `SELECT outcome FROM persistence_topology_changes WHERE operation='writ…` | `listRetiredDeactivations` | jobs (connect gate) | S | Yes: empty |

### Write admission (9)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 8 | `persistence/page-mutations.ts:419` | 1 | admit | read, outside | `SELECT s.incarnation,s.archived,s.local_path,s.config->>'kind' AS kind…` | existing: `readSourceIncarnation` + `readGuestSourceRow` | sources (CLI members) | S | No: real source row |
| 9 | `persistence/authority.ts:204` | 1 | admit | read, outside | `SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WH…` | existing: `readLocalWriterRow` | persistence | S | No: real writer row |
| 10 | `shared-skills/knowledge-guard.ts:87` | 1 | admit | read, outside | `SELECT to_regclass('shared_skill_packs') IS NOT NULL AS present…` | `hasSharedSkillPacks` | unassigned (shared skills) | S | Yes: false until packs land on Rust |
| 11 | `shared-skills/knowledge-guard.ts:91` | 4 | admit, claim, prepare, publish | read, in tx | `SELECT p.source_id,p.source_incarnation,s.local_path AS source_root, h…` | `listKnowledgePackBindings` | unassigned (shared skills) | S | Yes: empty |
| 12 | `shared-skills/knowledge-guard.ts:122` | 4 | admit, claim, prepare, publish | read, in tx | `SELECT local_path FROM sources WHERE id=$1 AND incarnation=$2::uuid…` | existing: `getSource` (local_path) | unassigned (shared skills) | S | No: real source row |
| 13 | `shared-skills/knowledge-guard.ts:126` | 4 | admit, prepare, publish | read, in tx | `SELECT source_path,source_uri FROM pages WHERE source_id=$1 AND slug=$…` | `readPageOrigin` (source_path, source_uri) | core | S | No: real page row |
| 23 | `persistence/schema-admission.ts:44` | 1 | request | read, in tx | `SELECT value FROM config WHERE key='version'…` | existing: `getConfig('version')` | persistence | S | No: real config value |
| 30 | `sources-load.ts:266` | 1 | prepare | read, outside | `SELECT id, name, local_path, last_commit, last_sync_at, config, create…` | existing: `listSourceRecords` / `getSource` | sources (CLI members) | S | No: real source row |
| 31 | `persistence/mirror-read-only.ts:26` | 3 | prepare, publish, after | read, in tx | `SELECT COALESCE(config->>'mirror_read_only','false')='true' AS read_on…` | existing: `getSource` (config) | sources (CLI members) | S | No: real source config |

### Transaction settings (4)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 16 | `persistence/protocol.ts:41` | 4 | request, recovery, publish, clear | setting, in tx | `SELECT set_config('gbrain.persistence_protocol','2',true),set_config('…` | `declareDurableWrite` | persistence | S | Yes: no-op; the store commits durably and runs one writer |
| 17 | `persistence/graduation-custody.ts:366` | 1 | request | read, in tx | `SELECT role, run_id::text AS run_id, state, source_data_dir, NULLIF(cu…` | `readGraduationRow` | jobs (connect gate) | S | Yes: no row |
| 26 | `persistence/protocol.ts:25` | 12 | claim, after | setting, in tx | `SELECT set_config('gbrain.persistence_protocol','2',true),(SELECT brai…` | `declarePersistenceProtocol` | persistence | S | Partly: answers the brain id, the setting is a no-op |
| 43 | `persistence/context.ts:73` | 1 | publish | setting, in tx | `SELECT b.brain_id,prev.*, CASE WHEN b.brain_id IS NOT NULL THEN concat…` | `setWriteContext` (attribution and trust) | persistence (trust hook) | M | No: holds the context for the open store write; `trust::stamp` reads it |

### Write journal (14)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 7 | `persistence/journal.ts:326` | 1 | admit | read, outside | `SELECT id FROM persistence_topology_changes WHERE principal_id=$1::uui…` | `findTopologyChangeByRequest` | persistence | S | Yes: none |
| 20 | `persistence/journal.ts:318` | 1 | request | read, row lock, in tx | `SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE…` | existing: `readSourceIncarnation` | sources (CLI members) | S | No: real source row; FOR SHARE is a no-op inside one store write |
| 21 | `page-state/transactions.ts:66` | 2 | request, publish | read, row lock, in tx | `SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WH…` | existing: `readLocalWriterRow` | persistence | S | No: real row; FOR SHARE is a no-op |
| 22 | `persistence/journal.ts:326` | 1 | request | read, in tx | `SELECT id FROM persistence_topology_changes WHERE principal_id=$1::uui…` | `findTopologyChangeByRequest` | persistence | S | Yes: none |
| 27 | `persistence/journal.ts:830` | 3 | claim, after | read, in tx | `WITH waiting AS MATERIALIZED (SELECT f.worktree_id, max(f.sequence) AS…` | `selectClaimableWrite` | persistence | M | No: real queue read |
| 32 | `persistence/page-prepare.ts:530` | 1 | prepare | read, outside | `SELECT r.deferred_import_from FROM persistence_requests r JOIN sources…` | `readDeferredImport` | persistence | S | No: real request rows |
| 33 | `persistence/journal.ts:897` | 2 | prepare | write, sets protocol, outside | `UPDATE persistence_requests SET claim_expires_at=now()+($3::double pre…` | `renewWriteClaim` | persistence | S | No: real claim write |
| 35 | `persistence/journal.ts:934` | 1 | recovery | write, in tx | `WITH recorded AS (UPDATE persistence_requests SET recovery=$3::text::j…` | `recordWriteRecovery` | persistence | S | No: real write |
| 37 | `page-state/transactions.ts:66` | 1 | publish | read, row lock, in tx | `SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE…` | existing: `readSourceIncarnation` | sources (CLI members) | S | No: real row; FOR SHARE is a no-op |
| 38 | `persistence/coordinator.ts:619` | 1 | publish | write, in tx | `UPDATE persistence_requests SET publication_started=true WHERE id=$1::…` | `markPublicationStarted` | persistence | S | No: real write |
| 68 | `persistence/journal.ts:1091` | 1 | clear | write, in tx | `WITH locked AS (SELECT id,recovery_bytes FROM persistence_requests WHE…` | `clearWriteRecovery` | persistence | S | No: real write |
| 72 | `persistence/journal.ts:770` | 2 | after, disconnect | read, outside | `SELECT EXISTS (SELECT 1 FROM persistence_requests r LEFT JOIN persiste…` | `hasClaimableWrite` | persistence | S | No: real queue read |
| 76 | `persistence/effect-journal.ts:317` | 1 | after | write, sets protocol, outside | `UPDATE persistence_requests r SET state='queued',execution_token=NULL,…` | `releaseAbandonedWriteClaims` | persistence | S | No: real write |
| 80 | `persistence/consumer.ts:960` | 2 | after, disconnect | write, sets protocol, outside | `WITH expired AS ( SELECT r.id FROM persistence_requests r WHERE r.stat…` | `expireStaleWriteClaims` | persistence | S | No: real write |

### Managed-only state (17)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 15 | `persistence/ownership.ts:86` | 7 | admit, prepare, publish, after | read, in tx | `SELECT s.source_id,s.source_incarnation,s.worktree_id,s.relative_path,…` | `readWorktreeBinding` | persistence | S | Yes: null |
| 18 | `persistence/journal.ts:611` | 1 | request | read, row lock, in tx | `SELECT state,owner_epoch::text AS owner_epoch FROM persistence_worktre…` | `readWorktreeState` | persistence | S | Yes: unreachable with no binding |
| 19 | `persistence/journal.ts:613` | 1 | request | read, in tx | `SELECT (SELECT row_to_json(f) FROM (SELECT id,state,source_ids FROM pe…` | `readWorktreeRefreshGate` | persistence | S | Yes: none |
| 24 | `persistence/segmented-mirror-gate.ts:89` | 1 | claim | read, outside | `SELECT DISTINCT r.id::text AS id,r.source_id,r.request_id::text AS req…` | `listGatedMirrorRequests` | persistence | S | Yes: empty |
| 25 | `persistence/effect-recovery-scan.ts:13` | 2 | claim, after | read, in tx | `SELECT e.* FROM persistence_effects e JOIN persistence_worktrees w ON …` | `listEffectRecoveries` | persistence | S | Yes: empty, recoveries need a worktree |
| 34 | `persistence/coordinator.ts:534` | 1 | prepare | read, outside | `SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND id<>…` | `hasWorktreeRecovery` | persistence | S | Yes: false |
| 36 | `persistence/ownership.ts:279` | 1 | publish | read, row lock, in tx | `SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHER…` | `readWorktreeOwner` | persistence | S | Yes: unreachable with no binding |
| 65 | `persistence/effect-journal.ts:46` | 1 | publish | read, in tx | `SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_…` | `readOwnedHostPath` | persistence | S | Yes: none |
| 78 | `persistence/consumer.ts:960` | 2 | after, disconnect | read, in tx | `SELECT r.* FROM persistence_requests r JOIN persistence_worktrees w ON…` | `listWorktreeRecoveries` | persistence | S | Yes: empty |
| 81 | `persistence/refresh-barrier.ts:145` | 2 | after, disconnect | read, in tx | `SELECT COALESCE((SELECT CASE WHEN value ~ '^[1-9][0-9]{0,14}$' THEN va…` | `listDeferredWrites` | persistence | S | Yes: empty, deferral needs a worktree refresh |
| 82 | `persistence/effect-journal.ts:265` | 1 | after | read, in tx | `WITH ready AS (SELECT e.id,gen_random_uuid() AS token FROM persistence…` | `claimCoalescedGitEffects` | persistence | S | Yes: empty, Git effects need a worktree |
| 83 | `persistence/refresh-barrier.ts:147` | 2 | after, disconnect | read, in tx | `SELECT r.* FROM persistence_requests r JOIN persistence_worktrees w ON…` | `listDeferredWrites` | persistence | S | Yes: empty, deferral needs a worktree refresh |
| 84 | `persistence/refresh-barrier.ts:160` | 2 | after, disconnect | read, in tx | `SELECT r.* FROM persistence_requests r JOIN persistence_worktrees w ON…` | `listDeferredWrites` | persistence | S | Yes: empty, deferral needs a worktree refresh |
| 86 | `persistence/effect-recovery.ts:39` | 2 | after | read, row lock, in tx | `SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uui…` | `readWorktreeOwner` | persistence | S | Yes: none |
| 91 | `persistence/effects.ts:1042` | 1 | after | read, in tx | `SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND rec…` | `hasWorktreeRecovery` | persistence | S | Yes: false |
| 101 | `persistence/worktree-refresh.ts:1224` | 1 | disconnect | read, outside | `SELECT f.*,f.updated_at<now()-($2::double precision*interval '1 millis…` | `listWorktreeRefreshes` | persistence | S | Yes: empty |
| 102 | `persistence/topology-recovery.ts:224` | 2 | disconnect | read, outside | `SELECT c.* FROM persistence_topology_changes c JOIN persistence_worktr…` | `listTopologyRecoveries` | persistence | S | Yes: empty |

### Page write guards and origin (14)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 29 | `persistence/links-preparation.ts:131` | 1 | prepare | read, outside | `WITH own AS ( SELECT slug, source_id, type, knowledge_revision FROM pa…` | `listOwnPagesForLinks` | link_queries | S | No: real page rows |
| 39 | `page-state/guards.ts:43` | 1 | publish | read, row lock, in tx | `SELECT incarnation FROM sources WHERE id=$1 FOR SHARE…` | existing: `readSourceIncarnation` | core | S | No: real row; FOR SHARE is a no-op |
| 40 | `page-state/guards.ts:46` | 1 | publish | write, in tx | `INSERT INTO page_write_guards(source_incarnation,slug) SELECT incarnat…` | `lockPageWriteGuard` | core | S | Yes inside a store write: one writer, so the guard row is a no-op |
| 41 | `page-state/guards.ts:47` | 1 | publish | read, row lock, in tx | `SELECT g.slug FROM page_write_guards g JOIN sources s ON s.incarnation…` | `lockPageWriteGuard` | core | S | Yes inside a store write |
| 42 | `page-state/guards.ts:49` | 1 | publish | read, row lock, in tx | `SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE…` | `lockPageWriteGuard` | core | S | Yes inside a store write |
| 44 | `persistence/origin-guard.ts:121` | 2 | publish | read, in tx | `SELECT id, slug, source_path, deleted_at FROM pages WHERE source_id=$1…` | `readPageOrigin` | core | S | No: real page row |
| 45 | `persistence/origin-guard.ts:81` | 1 | publish | read, in tx | `SELECT local_path, config->>'slug_root_mode' AS mode FROM sources WHER…` | existing: `getSource` (local_path, slug_root_mode) | sources (CLI members) | S | No: real source row |
| 46 | `persistence/origin-guard.ts:131` | 1 | publish | lock, in tx | `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))…` | none: advisory lock | core | S | Yes inside a store write: one writer |
| 47 | `persistence/origin-guard.ts:134` | 1 | publish | read, in tx | `SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at …` | `listOriginClaims` | core | S | No: real page rows |
| 48 | `persistence/origin-guard.ts:151` | 1 | publish | write, in tx | `UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2 AND sou…` | `bindPageOrigin` | core | S | No: real write |
| 49 | `persistence/origin-guard.ts:153` | 1 | publish | write, in tx | `UPDATE pages SET database_only_reason=NULL WHERE source_id=$1 AND slug…` | `bindPageOrigin` | core | S | No: real write |
| 50 | `persistence/page-prepare.ts:1278` | 1 | publish | write, in tx | `UPDATE pages SET source_kind=$3,ingested_via=$4,ingested_at=$5::timest…` | `stampPageIngest` | core | S | No: real write |
| 63 | `page-state/projections.ts:44` | 1 | publish | write, in tx | `UPDATE pages SET chunker_version=$5, text_projection_revision=CASE WHE…` | `sealImportedPage` | core | S | No: real write |
| 64 | `persistence/valid-time-advisory.ts:25` | 1 | publish | read, in tx | `SELECT frontmatter, compiled_truth, timeline, body_storage, content_ha…` | existing: `readPageSnapshot` | core | S | No: real page row |

### Projections inside the write (12)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 51 | `generations/adapters/fact-rows.ts:72` | 1 | publish | read, in tx | `SELECT jsonb_build_object('id', f.id, 'row_num', f.row_num, 'fact', f.…` | `listFenceFactRows` | facts | S | No: real fact rows |
| 52 | `trust/fence-guard.ts:73` | 1 | publish | read, in tx | `SELECT f.id, f.row_num, f.fact, f.visibility, f.trust_tier, (CASE f.tr…` | `listFenceFactRows` (with trust_tier) | trust | S | No: real fact rows with trust_tier |
| 53 | `persistence/canonical-projections.ts:796` | 1 | publish | write, in tx | `DELETE FROM timeline_entries t USING jsonb_to_recordset($2::text::json…` | `removeTimelineRows` | timeline_queries | S | No: real write |
| 54 | `persistence/canonical-projections.ts:801` | 1 | publish | write, in tx | `UPDATE timeline_entries t SET detail=r.next FROM jsonb_to_recordset($2…` | `updateTimelineDetails` | timeline_queries | S | No: real write |
| 55 | `persistence/canonical-projections.ts:708` | 1 | publish | read, in tx | `SELECT k.row_num FROM takes k JOIN jsonb_to_recordset($2::text::jsonb)…` | `matchTakeRows` | takes | S | No: real rows |
| 56 | `persistence/canonical-projections.ts:769` | 1 | publish | write, in tx | `DELETE FROM takes WHERE page_id=$1 AND row_num=ANY($2::integer[])…` | `deleteTakeRows` | takes | S | No: real write |
| 58 | `derived-links.ts:167` | 1 | publish | read, row lock, in tx | `SELECT value FROM config WHERE key = $1 FOR SHARE…` | existing: `getConfig` | link_queries | S | No: real config; FOR SHARE is a no-op |
| 59 | `link-temporal-apply.ts:46` | 2 | publish | read, in tx | `SELECT from_page_id, to_page_id, link_type FROM links WHERE (origin_pa…` | `listRelationshipKeys` | link_queries | S | No: real link rows |
| 60 | `sql-query.ts:142` | 1 | publish | read, in tx | `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_slug t…` | `missingLinkEndpoints` | link_queries | S | No: real page rows |
| 61 | `derived-links.ts:281` | 1 | publish | read, in tx | `SELECT l.id, f.slug from_slug, t.slug to_slug, f.source_id from_source…` | `listOriginLinks` | link_queries | S | No: real link rows |
| 62 | `link-temporal-apply.ts:106` | 1 | publish | write, in tx | `DELETE FROM link_transitions WHERE origin_page_id = $1 AND producer = …` | `deleteLinkTransitions` | link_queries | S | No: real write |
| 66 | `chronicle/ledger.ts:157` | 1 | publish | read, in tx | `SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 A…` | `hasExtractedEvents` | unassigned (chronicle) | S | No: real state (empty on a new page) |

### Effect journal (11)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 28 | `persistence/effect-journal.ts:157` | 5 | claim, after | read, in tx | `SELECT e.* FROM persistence_effects e LEFT JOIN persistence_worktrees …` | `selectClaimableEffect` | persistence | M | No: real queue read |
| 67 | `persistence/effect-journal.ts:69` | 1 | publish | write, in tx | `INSERT INTO persistence_effects (request_id,kind,revision,data,source_…` | `queueEffects` | persistence | M | No: real write |
| 73 | `persistence/effect-journal.ts:314` | 1 | after | write, sets protocol, outside | `UPDATE persistence_effects SET state='queued',execution_token=NULL,cla…` | `releaseAbandonedEffectClaims` | persistence | S | No: real write |
| 79 | `persistence/effect-journal.ts:170` | 2 | after | write, in tx | `UPDATE persistence_effects SET state='running',execution_token=$2::uui…` | `claimEffect` | persistence | S | No: real write |
| 85 | `persistence/effect-recovery.ts:37` | 2 | after | read, row lock, in tx | `SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE…` | none: FOR SHARE on the brain row | persistence | S | Yes inside a store write |
| 87 | `persistence/effect-recovery.ts:44` | 2 | after | read, row lock, in tx | `SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE…` | existing: `readSourceIncarnation` | sources (CLI members) | S | No: real row |
| 88 | `persistence/effects.ts:898` | 1 | after | read, in tx | `SELECT bool_and(state='running' AND claim_expires_at>now() OR state IN…` | `requestsStillPublishing` | persistence | S | No: real rows |
| 89 | `persistence/effect-journal.ts:202` | 2 | after | read, outside | `SELECT request_id::text AS request_id,state,data FROM persistence_effe…` | `listMirrorGates` | persistence | S | Yes: empty, mirrors need a worktree |
| 90 | `persistence/effect-journal.ts:373` | 1 | after | write, sets protocol, outside | `UPDATE persistence_effects SET state=CASE WHEN jsonb_array_length(COAL…` | `completeEffect` | persistence | S | No: real write |
| 92 | `persistence/effects.ts:1056` | 1 | after | write, outside | `UPDATE persistence_effects e SET state=CASE WHEN jsonb_array_length(CO…` | `completeEffects` | persistence | S | No: real write |
| 93 | `persistence/effect-journal.ts:231` | 1 | after | read, outside | `SELECT 1 FROM persistence_effects e WHERE e.request_id=ANY($1::uuid[])…` | `hasRearmableEffects` | persistence | S | No: real rows |

### Housekeeping after the write (23)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 69 | `access/serves.ts:29` | 1 | after | read, outside | `SELECT id FROM access_members WHERE disabled_at IS NULL AND tombstoned…` | `listActiveAccessMembers` | unassigned (access) | S | No: real rows (empty on most brains) |
| 70 | `persistence/housekeeping-turn.ts:34` | 1 | after | write, outside | `WITH claim AS ( INSERT INTO op_checkpoints (op, fingerprint, completed…` | `claimHousekeepingTurn` / `completeHousekeepingTurn` | persistence (checkpoints) | S | No: real lease row |
| 71 | `persistence/limits.ts:83` | 1 | after | read, outside | `SELECT value FROM config WHERE key=$1…` | existing: `getConfig` | persistence | S | No: real config |
| 74 | `persistence/journal.ts:1209` | 1 | after | read, outside | `SELECT * FROM persistence_requests r WHERE state IN ('committed','conf…` | `listCompactableReceipts` | persistence | M | No: real rows |
| 75 | `page-body/projection.ts:235` | 2 | after, disconnect | read, outside | `SELECT s.id AS source_id, j.source_incarnation::text AS source_incarna…` | `listPendingSegmentedProjections` | persistence (projection jobs) | S | No: real rows |
| 77 | `page-state/projections.ts:668` | 2 | after, disconnect | read, in tx | `WITH mark AS (SELECT COALESCE($3::text::timestamptz,(SELECT max(update…` | `selectProjectionWindowJobs` | persistence (projection jobs) | M | No: real rows |
| 94 | `persistence/receipt-true-up.ts:35` | 1 | after | read, outside | `SELECT r.id,r.intent,r.authority,r.outcome,r.error_message,r.error_det…` | `listTrueUpRequests` | persistence | S | No: real rows |
| 95 | `persistence/receipt-true-up.ts:51` | 1 | after | write, in tx | `WITH t AS (SELECT * FROM unnest($1::uuid[],$2::bigint[],$3::bigint[],$…` | `applyReceiptTrueUp` | persistence | M | No: real write |
| 96 | `persistence/capacity-forecast.ts:92` | 1 | after | read, outside | `SELECT key,value FROM config WHERE key = ANY($1::text[])…` | existing: `getConfigValues` | persistence | S | No: real config |
| 97 | `persistence/capacity-forecast.ts:149` | 1 | after | read, outside | `SELECT key,lifetime_ids::text,terminal_bytes::text FROM persistence_co…` | `readCapacityForecast` | persistence | M | Decision: serve, or skip the advisory forecast on Rust |
| 98 | `persistence/capacity-forecast.ts:152` | 1 | after | read, outside | `SELECT 'principal:local_cli:'\|\|principal_id::text AS scope,to_char(cre…` | `readCapacityForecast` | persistence | M | Decision: serve, or skip the advisory forecast on Rust |
| 99 | `persistence/capacity-forecast.ts:158` | 1 | after | read, outside | `SELECT (SELECT EXTRACT(EPOCH FROM now()-created_at)/86400 FROM persist…` | `readCapacityForecast` | persistence | M | Decision: serve, or skip the advisory forecast on Rust |
| 100 | `persistence/capacity-forecast.ts:119` | 1 | after | read, outside | `WITH RECURSIVE walk(lo,oldest,n) AS ( SELECT min(sequence),min(created…` | `readCapacityForecast` | persistence | M | Decision: serve, or skip the advisory forecast on Rust |
| 103 | `persistence/limits.ts:22` | 1 | disconnect | read, outside | `SELECT value FROM config WHERE key=$1…` | existing: `getConfig` | persistence | S | No: real config |
| 104 | `persistence/compaction-pass.ts:77` | 1 | disconnect | read, outside | `SELECT (SELECT value FROM config WHERE key=$1) AS retention,(SELECT te…` | `readReceiptBudget` | persistence | S | No: real counters |
| 105 | `persistence/receipt-true-up.ts:83` | 1 | disconnect | read, outside | `SELECT id,sequence::text AS sequence,compacted FROM persistence_reques…` | `listReservationsAfter` | persistence | S | No: real rows |
| 106 | `persistence/journal.ts:1158` | 1 | disconnect | read, outside | `SELECT EXISTS (SELECT 1 FROM page_body_stagings) OR EXISTS (SELECT 1 F…` | `hasSegmentStorage` | page_body | S | No: real rows |
| 107 | `persistence/memory-proposals.ts:193` | 1 | disconnect | write, outside | `UPDATE memory_proposals SET state='expired', reason=$1, decided_by='gb…` | `expireMemoryProposals` / `listMemoryProposals` / `purgeMemoryProposals` | unassigned (memory proposals) | M | No: real rows |
| 108 | `persistence/memory-proposals.ts:201` | 1 | disconnect | read, outside | `SELECT * FROM memory_proposals WHERE state='awaiting_owner' ORDER BY c…` | `expireMemoryProposals` / `listMemoryProposals` / `purgeMemoryProposals` | unassigned (memory proposals) | M | No: real rows |
| 109 | `persistence/memory-proposals.ts:214` | 1 | disconnect | write, outside | `DELETE FROM memory_proposals WHERE state<>'awaiting_owner' AND COALESC…` | `expireMemoryProposals` / `listMemoryProposals` / `purgeMemoryProposals` | unassigned (memory proposals) | M | No: real rows |
| 110 | `persistence/journal.ts:1136` | 1 | disconnect | read, outside | `SELECT c.relname FROM pg_class c WHERE c.relname = ANY($1::text[]) AND…` | none: Postgres vacuum | persistence | S | Yes: no-op, the store has no vacuum |
| 111 | `persistence/journal.ts:1144` | 1 | disconnect | read, outside | `SELECT GREATEST(reltuples,0)::float8 AS rows FROM pg_class WHERE oid='…` | none: Postgres planner statistics | persistence | S | Yes: no-op |
| 112 | `persistence/housekeeping-turn.ts:47` | 1 | disconnect | write, outside | `UPDATE op_checkpoints SET completed_keys='["done"]'::jsonb, updated_at…` | `claimHousekeepingTurn` / `completeHousekeepingTurn` | persistence (checkpoints) | S | No: real lease row |

### Inside a served member (2)

| # | Call site | Calls | Phase | Kind | Statement | Proposed member | Owner | Size | Rust can answer with no state? |
|---:|---|---:|---|---|---|---|---|---|---|
| 14 | `page-state/snapshot.ts:100` | 5 | admit, prepare, publish, after | read, in tx | `WITH chosen AS ( SELECT p.* FROM pages p WHERE p.slug=$1 AND p.source_…` | served: runs inside PGLite `readPageSnapshot` | core | done | n/a: Rust serves the member |
| 57 | `page-state/snapshot.ts:100` | 1 | publish | read, in tx | `WITH chosen AS ( SELECT p.* FROM pages p WHERE p.slug=$1 AND p.source_…` | served: runs inside PGLite `readPageSnapshot` | core | done | n/a: Rust serves the member |
