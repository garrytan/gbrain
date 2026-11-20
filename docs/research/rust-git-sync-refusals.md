# executeRaw calls on the git sync path, and what a Rust brain needs

Research map, pinned to `rust-engine/purge-stale-checkpoints` at `08a0c5dae8` (on master `aca965d45a`). It lists
each `executeRaw` call that a plain git sync makes on a PGLite brain, and the smallest typed `BrainEngine` member
that can replace it on a Rust brain. On a Rust brain `executeRaw` is not implemented (capability `raw_sql`), so each
call below refuses with `engine_capability_missing` unless a guard in its caller skips it.

## Update after the lane 11 merge (`ad4a53cac3`)

The branch merged lane 11 at `ad4a53cac3` and the four-step trace ran again on a Rust brain. The counts and tables
below are still the first trace at `08a0c5dae8`; this section says what changed since.

Switched to typed members on this branch (PGLite and Postgres run the same SQL; parity tests in
`test/engine-parity/sync-route.test.ts` pass on PGLite, Postgres and Rust):

| Site at `08a0c5dae8` | Now calls |
|---|---|
| `sync-anchor.ts:271` (`UPDATE sources SET last_commit ...`) | `advanceSourceCommit` (new) |
| `sync-anchor.ts:298` (`UPDATE sources SET local_path ...`) | `attachSourcePath` |
| `sync.ts:951` | `readSourceRow('default')` |
| `sync-upstream.ts:67` | `getSource` |
| `commands/sync/full.ts:124` | `countSourcePages` |
| `commands/sync/full.ts:460` | `listSourcePathPages` (new) |
| `sync-rename-identity.ts:304` (both texts) | `readRenameIdentityRows` and `readLiveIdentityHolders` (new) |
| `page-embedding-budget.ts:453` `readPageSizeStates` | `readPageSizeRows` (new) |

Lane 11 typed `sync-dispatch-read.ts:51`, `sync-authority.ts:50`, `sync/perform.ts:43` and the applied-watermark
reads. Lane 11 also owns `access/policy.ts` (`ad821f6e06` types all of it); this branch does not touch it.

The trace below ran with a scratch stub in place of `access/policy.ts`, because without it a Rust step 1 and step 2
stop first at `policy.ts:92` and then `:139`, which wait on lane 11.

| Step | Rust exit | First fatal refusal |
|---|---:|---|
| 1. first `sync` | 0 | none |
| 2. incremental `sync` | 1 | `reason-trailers.ts:151` `scanSyncReasons` (`SELECT commit_sha, path FROM reason_purge_tombstones`) |
| 3. `sync status` | 1 | `sync-status.ts:361` |
| 4. `sources status` | 1 | `source-health.ts:384` |

Hidden refusals that step 1 still makes on Rust (the caller catches each one and goes on, so the step exits 0):
`notifier/store.ts:277` and `:146` (from `sync-anchor.ts:270`), `backup/coverage.ts:128` and `:112`, and the
applied-watermark callers `sync-holds.ts:573` (from `applied-watermark.ts:110`) and `sync-pass-row.ts:185` (from
`applied-watermark.ts:112`). `sync-upstream.ts:72` is also caught.

`reason-trailers.ts:151` has a twin with `ORDER BY` at `repair/purged-change-reasons.ts:66`, and the same table is
read when a version is written (`page-state/versions.ts:28`). The Rust store has no `reason_purge_tombstones` keys,
and the tombstone writer (`facts/purge-reasons.ts:63`) is raw SQL that refuses on Rust, so a typed read can answer
from an empty key range. Until the hold store is typed, step 2 on Rust would write no hold for the bad file.

## Update after the lane 13 merge and the purged-reason reads (`a061e8bed5` and the next commit)

The branch merged the notifier work and lane 13 (`86fb7ef5db`, `a061e8bed5`), and the trace ran again with no stub in
place of `access/policy.ts`. Neither `policy.ts:92` nor `:139` refuses now. The notifier and backup-coverage refusals
of step 1 are gone too.

The next commit types the purged change-reason record and the embedding hold:

| Site | Now calls |
|---|---|
| `reason-trailers.ts:151` `scanSyncReasons` | `readReasonPurgeTombstones` (new) |
| `repair/purged-change-reasons.ts:66` `findLeakedChangeReasons` | `readReasonPurgeTombstones` |
| `page-state/versions.ts:28` `stampableReason` | `readReasonPurgeTombstones` with a (commit, path) pair |
| `facts/purge-reasons.ts:63` `recordReasonTombstones` | `writeReasonPurgeTombstones` (new) |
| `page-embedding-budget.ts:141` `holdPageEmbedding` | `holdPageEmbedding` (new); Rust `readPageSizeRows` reports the hold |

`purged-change-reasons.ts:52` `checkoutRoot` (`SELECT local_path FROM sources`) is still raw SQL, so
`gbrain repair purged-change-reasons` still stops on Rust after the typed tombstone read.

Trace with these changes:

| Step | Rust exit | First stop |
|---|---:|---|
| 1. first `sync` | 0 | none |
| 2. incremental `sync` | 1 | the sync ends `blocked_by_failures`: three files fail (below) |
| 3. `sync status` | 1 | `sync-status.ts:361` |
| 4. `sources status` | 1 | `source-health.ts:384` |

Step 2 now reads past the reason scan. The three failed files of step 2:

- the renamed file: `sync/rename-reconcile.ts:46` (`SELECT slug, source_path FROM pages WHERE source_path = ANY($1)`)
  refuses and the rename is not reconciled;
- the file with broken frontmatter: `sync/holds.ts:203` (the page read of `recordLegacyHold`) refuses, so no hold is
  written (the hold store is the next step);
- the changed file: `createVersion` with a change reason refuses with capability `page_versions`, because the Rust
  store does not keep a version's change reason (TODOS.md `rust-version-change-reason`).

Hidden refusals that step 1 still makes (caught by the caller): `sync-holds.ts:573` (from
`applied-watermark.ts:110`) and `sync-pass-row.ts:185` (from `applied-watermark.ts:112`).

## Update after the hold store (step 2b)

The next commit types the hold store and the managed sync pass row, plus three page and source reads. PGLite and Postgres run the same SQL; `test/engine-parity/git-holds.test.ts` passes on PGLite, Postgres and
Rust. The Rust engine keeps hold, summary and pass rows as whole checkpoint rows (`rust/docs/store/persistence.md`).

| Site | Now calls |
|---|---|
| `sync-holds.ts` `lockSummary`, `adjustSummary`, `readRow`, `writeRow`, `replaceRow`, `deleteRow` | `lockGitHoldSummary`, `adjustGitHoldSummary`, `readGitHoldRow`, `writeGitHoldRow`, `replaceGitHoldRow`, `deleteGitHoldRow` (new) |
| `sync-holds.ts:573` `countGitHolds` | `countGitHolds` (new) |
| `sync-pass-row.ts:185` and the other pass-row reads and writes | `readSyncPassRow`, `readLiveSyncPassRows`, `writeSyncPassRow` (new) |
| `sync/rename-reconcile.ts:46` | `readRenameIdentityRows` |
| `sync/holds.ts:203` `recordLegacyHold` page read | `readRenameIdentityRows` and `getPage` |
| `repair/purged-change-reasons.ts:52` `checkoutRoot` | `getSource` |
| `persistence/applied-watermark.ts:110` held files | `heldFileCount`: a failed count reads as 0 on PGLite and Postgres; a Rust brain rethrows it |

The Rust engine also answers `readHeldPageRows`, `readHeldCoverageRows`, `readGitHoldRecords`,
`readGitHoldRetryRequest` and `readGitHoldReportInputs` from the stored rows now, not empty.

Trace with these changes:

| Step | Rust exit | First stop |
|---|---:|---|
| 1. first `sync` | 0 | none; `sync-holds.ts:573` and `sync-pass-row.ts:185` no longer refuse; `sync-upstream.ts:72` (caught) is lane 11's `writeSourceUpstreamObservation` |
| 2. incremental `sync` | 1 | 0 `executeRaw` refusals; two changed files fail on `createVersion` with a change reason (capability `page_versions`) |
| 3. `sync status` | 1 | `sync-status.ts:361` |
| 4. `sources status` | 1 | `source-health.ts:384` |

In step 2 the broken file is held on Rust now (`Held held-bad.md: invalid_frontmatter`, one hold outstanding). The
rename read no longer refuses, but the two files that fail on `createVersion` are the renamed file and the changed
file. Because they fail before their later steps, some step 2 paths (for
example the later hold reads in `sync/holds.ts`) did not run in this trace. Trace again after `createVersion` keeps
a change reason on Rust.

## Counts

| Class | Sites | Meaning |
|---|---:|---|
| refuses on Rust | 64 | No guard skips the call on a Rust brain. A typed member is needed, or the caller must switch to one. |
| of which: an existing member fits | 9 | A member that Rust serves today returns the same rows or does the same write. The call site can switch with no new engine code. |
| of which: a new member is needed | 55 | No member returns these rows. |
| skipped on Rust already | 11 | A guard (`isRustBrain`, `lacksRawSql` or `engine.kind`) in the caller takes another path on Rust. Excluded from the tables. |
| traced sites | 75 | 75 distinct (site, SQL text) pairs. |

Typed members only: every typed member that the sync path calls on PGLite is a Rust store member. `executeRaw` is
the only refused member.

## What a Rust brain does today

| Step | PGLite exit | Rust exit | Refusals that the Rust run hit, in order |
|---|---:|---:|---|
| 1. `sync --repo <repo> --no-embed --json` | 0 | 1 | `sync-dispatch-read.ts:51` (caught), `sync/perform.ts:43` (caught), `sync-authority.ts:50` (fatal) |
| 2. incremental `sync` after a change, a delete, a rename and one bad-frontmatter file | 0 | 1 | the same three |
| 3. `sync status --source default --json` | 0 | 1 | `sync-status.ts:361` (fatal) |
| 4. `sources status default --json` | 0 | 1 | `source-health.ts:384` (fatal) |

On PGLite, step 2 writes one hold (`invalid_frontmatter`) for the bad file. On Rust, no step gets past its first
fatal refusal, so no page is written and no hold is written.

`sync-dispatch-read.ts:51` is a hidden refusal: the caller catches it and falls back. Then `sync-authority.ts:50`
runs only because the routing row is null. A typed routing read at `:51` therefore also removes `:50` from the
path.

## Method

- Fixture: the 20-page brain in `test/fixtures/rust-cli-parity-brain/`, copied into a fresh git repository with one
  commit. The brain is a fresh PGLite brain (`engine: pglite`), or a fresh Rust brain for the control run.
- Steps, in order: the four commands in the table above. Before step 2, a script appends text to one file, deletes
  one file, renames one file and adds `held-bad.md` with an unclosed `[` in its frontmatter, then commits.
- A scratch preload (never committed) wraps the PGLite engine. It records the outermost engine member call with the
  SQL text and the JavaScript stack. `transaction` and `withReservedConnection` pass through, so a call inside a
  transaction is recorded as its own call. The Rust run uses the census trace preload in
  `scripts/rust-census/trace-preload.ts`.
- A site is the first stack frame outside the engine. A member refuses on Rust when it is not in
  `STORE_MEMBERS` (`src/core/rust-engine/store-members/index.ts`).
- A site is "skipped on Rust already" when a stack frame above it has a guard that takes another path on a Rust
  brain. The 11 such sites: `managed-mode.ts:71` and `:92` (`isRustBrain`, typed `readManagedModeRows`),
  `writer-versions.ts:128` (`lacksRawSql`), and the 8 planner and projection-statistics sites under
  `refreshProjectionStatistics` (`lacksRawSql` at `projection-statistics.ts:296`).
- "Caught" means the call sits in a `try` or has a `.catch` in its own function. Fatal or caught is known for
  certain only for the 5 sites the Rust run reached.

## Limits

- One fixture and one run per step. Branches the fixture does not take are not traced: managed persistence, a
  read-only mirror, a connector source, fence repair, an access-policy source, a remote with `git pull`, a sync
  that runs out of time, image files.
- The Rust run stops at the first fatal refusal of each step. The rows after it come from the PGLite trace, so they
  show what Rust reaches next only if each earlier site is typed with the same result.
- "An existing member fits" is a reading of the SQL and the member contract. No call site was switched and no
  parity test ran for this map.
- Step 3 and step 4 read rows that step 2 writes (holds, pass rows, notifier rows). On Rust those rows do not exist
  until the writers are typed, so typed readers return empty answers until then.

## Sites that an existing member can replace

| Step | Site | SQL (prefix) | Member to switch to |
|---|---|---|---|
| 1 | `src/commands/sync/perform.ts:43` `syncStartedAt` | `SELECT clock_timestamp()::text` | `readDatabaseClock` (UTC ISO with microseconds; the caller compares it with `updated_at`) |
| 1 | `src/commands/sync/full.ts:124` `performFullSync` | `SELECT EXISTS (SELECT 1 FROM pages WHERE source_id = $1)` | `countSourcePages(sourceId) > 0` |
| 1 | `src/core/access/policy.ts:92` `readAccessStore` | `SELECT config->>'access_store' FROM sources WHERE id = $1` | `readSourceRow` (`config`) |
| 1 | `src/core/sync.ts:951` | `SELECT local_path FROM sources WHERE id = 'default'` | `readSourceRow('default')` |
| 1 | `src/core/sync-anchor.ts:298` | `UPDATE sources SET local_path = $1 WHERE id = $2` | `attachSourcePath(sourceId, localPath)` with no options |
| 1 | `src/core/sync-upstream.ts:67` | `SELECT local_path,last_commit FROM sources WHERE id=$1` | `getSource` (`local_path`, `last_commit`) |
| 1 | `src/core/persistence/sync-holds.ts:1455` `buildHoldReport` | `SELECT config->>'mirror_read_only' FROM sources WHERE id=$1` | `readSourceRow` (`config`) |
| 4 | `src/core/shared-skills/setup-source-policy.ts:16` | `SELECT config FROM sources WHERE id=$1 AND NOT archived` | `readSourceRow` (`config`, `archived`) |
| 4 | `src/core/shared-skills/source-opt-out.ts:48` | `SELECT config,incarnation FROM sources WHERE id=$1 AND NOT archived` | `readSourceState` (`config`, `incarnation`, `archived`) |

`src/commands/sync/plain-directory.ts:36` (`local_path,last_commit,config ... AND NOT archived`) is close:
`getSource` has no `archived`, and `readSourceRow` has no `last_commit`. One extra field on `readSourceRow` covers it.

## Sites that need a new member

Each group lists the sites, then the smallest typed member that serves them. Lines are lines at `08a0c5dae8`.

### Hold store (ops `sync-hold` and `sync-hold-summary`): 12 sites

| Step | Site | SQL (prefix) |
|---|---|---|
| 2 | `persistence/sync-holds.ts:325` `lockSummary` | `INSERT INTO op_checkpoints ... ON CONFLICT DO UPDATE ... RETURNING count` |
| 2 | `persistence/sync-holds.ts:343` `adjustSummary` | `UPDATE op_checkpoints SET completed_keys=jsonb_build_array(... counters)` |
| 2 | `persistence/sync-holds.ts:359` `readRow` | `SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2` |
| 2 | `persistence/sync-holds.ts:386` `writeGitHold` | `INSERT INTO op_checkpoints ... VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO UPDATE` |
| 2 | `commands/sync/holds.ts:203` `recordLegacyHold` | `SELECT id, slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND ...` |
| 1 | `persistence/sync-holds.ts:575` `readGitSourceHolds` | `SELECT CASE WHEN mirror_read_only ... FROM op_checkpoints h JOIN sources s` |
| 1 | `persistence/sync-holds.ts:1184` `readGitHoldRetryPaths` | `SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2` |
| 1 | `persistence/sync-holds.ts:564` `countGitHolds` | `SELECT COALESCE((completed_keys->0->>'count')::int,0) ...` |
| 1 | `persistence/sync-holds.ts:1449` `buildHoldReport` | `SELECT count, stale, ... FROM op_checkpoints` |
| 4 | `persistence/sync-holds.ts:595` `readGitHoldListing` | `SELECT s.id, s.incarnation, ... FROM sources s LEFT JOIN op_checkpoints` |
| 4 | `persistence/sync-holds.ts:1165` `readSyncConversions` | `SELECT s.id, c.completed_keys->0->'conversions' ...` |
| 4 | `fence-repair/uncommitted.ts:67` | `SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints WHERE ...` |

Smallest members: `writeGitHoldRow(sourceId, incarnation, path, record, summaryDelta)` (one call does
`lockSummary`, `readRow`, the upsert and `adjustSummary`, and returns inserted, updated or skipped),
`readGitHoldRow(sourceId, incarnation, path)`, `readGitHoldSummary(sourceId, incarnation)` and
`listGitHolds(sourceId, incarnation)`. The existing `writeOpCheckpointKeys` cannot carry a hold: it stores string
keys only, and a hold record is a JSON object. When the hold rows are real, the Rust stubs `readHeldPageRows` and
`readHeldCoverageRows` (they return `[]` today) must read them too.

### Source routing, authority and anchor: 7 sites

| Step | Site | SQL (prefix) | Smallest member |
|---|---|---|---|
| 1 | `sync-dispatch-read.ts:51` (caught) | `SELECT s.id, s.archived, s.config, s.incarnation, s.local_path, EXISTS(bindings)` | `readSyncDispatchRow(sourceId)` |
| 1 | `persistence/sync-authority.ts:50` (fatal) | `SELECT EXISTS(SELECT 1 FROM persistence_source_bindings ...) AS claimed` | gone from the path once `:51` is typed; else `readSourceClaimed(sourceId)` |
| 1 | `commands/sync/plain-directory.ts:36` | `SELECT local_path,last_commit,config FROM sources WHERE id=$1 AND NOT archived` | `readSourceRow` plus `last_commit` |
| 1 | `sync-anchor.ts:271` | `UPDATE sources SET last_commit = $1, last_sync_at = now(), newest_content_at = $3` | `setSourceSyncAnchor(sourceId, commit, newestContentAt)` |
| 1 | `notifier/store.ts:277` `recordSyncerHost` | `INSERT INTO sync_notifier_sources ...` | `recordSyncerHost(sourceIds, hostId)` |
| 1 | `notifier/store.ts:146` `pruneSatisfiedMarkers` | `DELETE FROM sync_wanted_markers m USING sources s ...` | `pruneSatisfiedWantedMarkers(sourceIds)` |
| 1 | `access/policy.ts:136` `coverageRows` | `SELECT prefix, reason, revision, detail FROM access_pending_coverage` | `listAccessPendingCoverage(sourceId)` (empty on Rust: no access store) |

### Page reads during sync: 14 sites

| Step | Site | SQL (prefix) |
|---|---|---|
| 1 | `commands/sync/full.ts:460` | `SELECT slug, source_path FROM pages WHERE source_id = $1 AND source_path ...` |
| 1 | `page-embedding-budget.ts:453` `readPageSizeStates` | `SELECT p.slug, (CASE WHEN p.body_storage = 'segmented' ...` |
| 1 | `backup/coverage.ts:128` `countLivePages` (caught) | `SELECT COUNT(*)::int FROM pages WHERE deleted_at IS NULL` |
| 1 | `backup/coverage.ts:112` `brainMaturity` (caught) | `SELECT pages, facts, LEAST(MIN(created_at)) ...` |
| 2 | `sync-rename-identity.ts:304` (2 SQL texts, caught) | `SELECT slug, source_path, [frontmatter->>'id'], title FROM pages WHERE source_id = $1 ...` |
| 2 | `commands/sync/rename-reconcile.ts:46` | `SELECT slug, source_path FROM pages WHERE source_path = ANY($1::text[])` |
| 2 | `reason-trailers.ts:151` `scanSyncReasons` | `SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1` |
| 2 | `commands/extract.ts:497` `loadSlugAliasTargets` (caught) | `SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id = $1` |
| 2 | `quarantine.ts:116` `quarantinedSlugs` | `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND ...` |
| 2 | `link-reconciliation.ts:220` `fileLinkOwnership` | `SELECT slug, source_id, type, title, frontmatter->'aliases' FROM pages` |
| 2 | `link-reconciliation.ts:229` `resolve` | `SELECT DISTINCT o.slug FROM links l JOIN pages o ...` |
| 2 | `trust/timeline-projection.ts:22` `pageInputs` | `SELECT p.id,p.source_id,p.slug,p.trust_tier FROM pages p JOIN jsonb_to_recordset(...)` |
| 2 | `trust/timeline-projection.ts:59` | `SELECT p.source_id,p.slug FROM pages p JOIN jsonb_to_recordset(...)` |

Smallest members: `listSourcePagePaths(sourceId, paths?)` covers `full.ts:460`, `rename-reconcile.ts:46` and both
`sync-rename-identity.ts:304` texts (slug, source_path, title, frontmatter id). `countLivePages` and
`brainMaturity` fit one `readBrainMaturity()`. The others need one member each, named after the function.
`readPageAliasRows` and `readPageTrustRows` are close to `loadSlugAliasTargets` and `pageInputs` but take
different keys; check them before adding a member.

### Applied watermark and pass rows: 5 sites

| Step | Site | SQL (prefix) |
|---|---|---|
| 1 | `persistence/applied-watermark.ts:88` `readWriteWatermark` | `SELECT s.last_commit, s.last_sync_at, p.pending_min, p.pending_count ...` |
| 1 | `persistence/applied-watermark.ts:92` `readWriteWatermark` | `SELECT max(sequence) FROM persistence_requests` |
| 1 | `persistence/applied-watermark.ts:104` `readCheckoutRoot` | `SELECT s.incarnation, COALESCE((SELECT h.local_path ...` |
| 1 | `persistence/applied-watermark.ts:132` `readAppliedWatermark` | `WITH w AS (SELECT DISTINCT p.id, p.updated_at FROM content_chunks cc JOIN ...` |
| 1 | `persistence/sync-pass-row.ts:185` `readLivePassRows` | `SELECT s.id, c.completed_keys->0 AS value, c.updated_at ...` |

Smallest members: `readSyncWatermark(sourceId)` (the three `applied-watermark.ts` reads in one result) and
`readLivePassRows(sourceIds)`.

### `sync status`: 12 sites

| Site | SQL (prefix) |
|---|---|
| `persistence/sync-status.ts:361` (fatal) | `SELECT s.incarnation, s.last_commit, s.last_sync_at, EXISTS (gbrain_cycle_locks) ...` |
| `persistence/sync-status.ts:296` | `SELECT completed_keys->0 AS header, fingerprint FROM op_checkpoints WHERE op='managed-sync'` |
| `persistence/sync-status.ts:304` | `SELECT to_char(updated_at ...) AS first_seen FROM op_checkpoints WHERE op='managed-sync'` |
| `persistence/sync-status.ts:380` | `SELECT count(*), EXISTS (persistence_effects ... kind='git') ...` |
| `persistence/sync-status.ts:588` (caught) | `SELECT (SELECT count(*) FROM persistence_requests WHERE recovery IS NOT NULL) ...` |
| `persistence/sync-failures.ts:171` | `SELECT c.fingerprint AS cursor_key, jsonb_build_object(...) ...` |
| `persistence/sync-failures.ts:202` | `SELECT f.completed_keys->0 AS failure FROM op_checkpoints f JOIN sources s ...` |
| `persistence/sync-drain.ts:805` `reclaimableHere` | `SELECT h.state AS head_state, h.id AS head_request_id, ...` |
| `sync-identity-downgrades.ts:113` | `SELECT dg.completed_keys->0 AS record, np.slugs FROM op_checkpoints dg JOIN pages p ...` |
| `persistence/sync-freshness.ts:105` | `SELECT b.source_id, b.worktree_id, b.source_incarnation, COALESCE(h.local_path, s.local_path) ...` |
| `notifier/status.ts:73` | `SELECT s.id, s.last_commit, n.state, n.reason, n.first_due_at, ...` |
| `notifier/status.ts:143` (caught) | `SELECT intent, wanted_head, first_due_at, requested_by FROM sync_wanted_markers` |

The first fatal site is `sync-status.ts:361`, so a typed `readSyncStatusSource(sourceId)` is the first member
`sync status` needs. A plain (unmanaged) Rust brain has no persistence requests, effects, bindings or managed-sync
rows, so most of the rest can answer empty on Rust the way `readHeldPageRows` does today. Which of them may answer
empty is a decision for the owner of `sync status`, not this map.

### `sources status`: 5 sites

| Site | SQL (prefix) |
|---|---|
| `source-health.ts:384` (fatal) | `SELECT source_id, COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL GROUP BY ...` |
| `source-health.ts:403` | `SELECT p.source_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE c."...` |
| `sync-pending.ts:106` (caught) | `SELECT s.id, n.observed_head, LEAST(CASE WHEN n.state <> ...` |
| `persistence/sync-drain.ts:1252` `readManagedSyncBacklog` | `SELECT completed_keys->0 AS header FROM op_checkpoints WHERE op='managed-sync'` |
| `persistence/sync-movement.ts:141` | `SELECT b.source_id, b.worktree_id, b.source_incarnation, ...` |

`source-health.ts:384` counts live pages per source. `countSourcePages` answers one source at a time, so it fits
only if a loop over sources is acceptable to the caller. The hold reads of
`sources status` (`sync-holds.ts:595`, `:1165`, `fence-repair/uncommitted.ts:67`) are in the hold store group, and
the two shared-skills reads are in the existing-member table.

## Recommendation

Type the hold store first: `writeGitHold` with `lockSummary`, `readRow` and `adjustSummary`
(`sync-holds.ts:325`, `:343`, `:359`, `:386`), the hold readers, and real `readHeldPageRows` and
`readHeldCoverageRows` on Rust. A hold is the only sync write that protects user data (it keeps a page whose file
is broken), and the hold readers are on all three status paths.

This is a decision, because sync order points the other way. The first refusal of `sync` is
`sync-dispatch-read.ts:51`, then `sync-authority.ts:50`. Typing the hold store does not make a Rust `sync` get
further: the run still stops at `sync-authority.ts:50`, so the hold rows stay unreachable from the CLI and can be
proved only by parity tests on the store members. To make a Rust `sync` exit 0 first, type the routing read and the
existing-member switches before the hold store.
