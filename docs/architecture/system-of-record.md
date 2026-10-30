# System of record

**Canonical Markdown and frontmatter are the system of record for file-backed
knowledge. Their database indexes can be rebuilt from those files. DB-only
knowledge and operational state still need a separate backup.**

This document is the canonical reference for that contract. Every code
path that writes user-knowledge state should match the pattern
described here. The CI gate at `scripts/check-system-of-record.sh`
enforces it programmatically.

## Why this matters

Much of the DB is a derived index over the markdown content. It exists to make
search fast, to dedup embedding-similar claims, to materialize the
cross-page graph. `gbrain sync && gbrain extract all` rebuilds the indexes
represented by intact Markdown; it does not recover DB-only knowledge,
credentials, page revision history, durable receipts, or the authoritative
withdrawal ledger. Preserve those records in a database backup.

This means:

- **Disaster recovery is a short, boring sequence.** If your DB volume
  corrupts, if Postgres eats itself, if PGLite's WASM lock wedges — you
  first verify your backups and which state exists only in the database.
  After preserving that state, you can wipe derived tables (on PGLite,
  `gbrain reinit-pglite` wipes the whole embedded DB), re-import from
  your brain repo with `gbrain sync`, and `gbrain extract all`
  regenerates the derived state. See "Disaster recovery" below for the
  exact commands.
- **Multi-machine sync is git.** Your brain is a repo. Push from one
  machine, pull from another, and the second machine's DB rebuilds on
  its next sync. This does not transfer DB-only state or gitignored files.
- **Privacy is in your hands.** Sensitive entity pages can be
  gitignored (via `gbrain.yml` `db_only` paths or per-page) and they
  stay on disk but not in git. The fence respects whatever git
  tracking choice you make at the page level.
- **Cross-agent collaboration is coordinated.** Multiple authenticated servers
  can accept writes against shared Postgres. Each canonical worktree has one
  designated publishing host; revision checks prevent stale replacements and
  durable receipts let callers inspect or replay accepted requests. Git still
  carries files between independent brains.

## The three categories

Use these categories to distinguish reconstructible file-backed records
from state that needs a database backup. A table can contain both: the
facts table, for example, also holds unresolved facts without a fence.

### FS-canonical (markdown is the source of truth)

For knowledge preserved in canonical files, the DB row is a derived index
over the Markdown. Reconciliation rebuilds the represented fields; it does
not promise identical database rows or recover records absent from the files.
The CI gate constrains direct DB writes to the documented paths.

| Category | How it's stored in markdown | Derived DB table | Reconciler |
|---|---|---|---|
| **Takes** (incl. hunches, bets) | `## Takes` fenced table between `<!--- gbrain:takes:begin -->` / `:end -->` markers | `takes` | `extract takes` |
| **Facts** | `## Facts` fenced table between `<!--- gbrain:facts:begin -->` / `:end -->` markers | `facts` | `extract_facts` cycle phase |
| **Links** | Inline `[text](slug)` / `[[slug]]` in markdown body + frontmatter `direction: incoming` | `links` | `extract links` |
| **Timeline** | Dated markers anywhere in the page body — compiled truth AND the `## Timeline` section: `- **YYYY-MM-DD** \| Source — Summary` bullets, `### YYYY-MM-DD — Title` headers (FS extract), and inline `[Source: <text>, YYYY-MM-DD]` citations (one row per citation, dated by the citation, summary = the bullet/paragraph it sits in). The `<!-- timeline -->` sentinel only splits compiled_truth from timeline for storage; it does not scope extraction | `timeline_entries` | `extract timeline` + canonical page publication (independent of `auto_timeline`) |
| **Tags** | Frontmatter `tags:` YAML array | `tags` | `importFromFile` (reconciles per-page on import) |
| **emotional_weight** | Recomputed from takes + tags | `pages.emotional_weight` (signal column) | `recompute_emotional_weight` cycle phase |
| **synthesis_evidence** | FK into `takes` rows (`slug#N`) inside synthesis pages | `synthesis_evidence` | `extract takes` (transitively) |

### Derived from FS but not user-authored

These hold derived state that's automatically reconstructible from the
markdown but not directly authored as markdown by the user. The
chunker + embedder rebuild these on import.

| Table | Source | Notes |
|---|---|---|
| `pages` | The markdown file as a whole | One row per file; `compiled_truth` + `frontmatter` come from parse |
| `content_chunks` | `pages.compiled_truth` after chunker strip | Re-chunked on content_hash change; embedded via configured model |
| `page_versions` | Each `pages` UPDATE | Audit history; rebuildable in principle but not in practice |

### DB-only by design (named exceptions)

These hold runtime or infrastructure state intentionally kept outside the
repo. This list does not cover every DB-only record: pages and facts can
also contain knowledge absent from canonical files and must be backed up.

| Category | Why it's OK to be DB-only |
|---|---|
| `raw_data` | Webhook/transcript sidecars; not user-authored knowledge. |
| `subagent_messages` / `subagent_tool_executions` / `subagent_rate_leases` | Runtime job state. Replay-only, not persistent knowledge. |
| `oauth_clients` / `oauth_tokens` / `access_tokens` | Credentials. Not in source control by definition. |
| `mcp_request_log` | Audit trail. Volatile by design. |
| `minion_jobs` / `minion_inbox` / `minion_attachments` | Job queue. Restarts re-enqueue or drop. |
| `eval_candidates` / `eval_capture_failures` | Contributor-mode dev loop; opt-in capture. |
| `dream_verdicts` | Scored triage cache (salience score, quotes, entities, judging model + prompt version). Rows carry a 30-day `expires_at` TTL: reads treat expired rows as misses and the synthesize phase sweeps them, so nothing lives forever. Rebuildable via `gbrain dream retriage --force`. |
| `gbrain_cycle_locks` / migration ledger | Infrastructure. |
| `op_checkpoint_paths` | Sync-resume checkpoint. Append-only progress banking; a completed sync makes it irrelevant. |
| `config` (some keys) | Site-local routing config (e.g. `sync.repo_path`). |
| Withdrawal ledger and page overlays | Authoritative withdrawal decisions must survive stale imports and owner downtime. Markdown mirrors can lag. |
| Mutation journal, receipts, outbox, ownership and local registrations | Durable replay identity, publication recovery and authorization cannot be rebuilt from Markdown. |
| Belief ledger (`belief_events`, `belief_page_lifetimes`, `belief_commit_marks`, `belief_redactions`, `belief_retier_manifest`) | What the brain had recorded, and when. Markdown holds only the current state, so the history cannot be rebuilt from it; a rebuild from Markdown starts a new, empty history. See [BELIEF_LEDGER.md](../designs/BELIEF_LEDGER.md). |

A new derived table that holds user-knowledge MUST land FS-first.
If you're tempted to add one as "DB-only for now," the structural
question is: does it belong in this DB-only-by-design list? If not,
it's FS-canonical and needs a fence (or frontmatter field) plus a
reconciler.

## Page-write persistence boundary

Page mutations first admit a durable request scoped to the authenticated
principal. Existing-page replacements require the caller's observed revision
or explicit `force`; omitting both permits creation only when absent. Repeating
the same UUID and intent returns the stored outcome without executing terminal
work again. Preconditions are checked before no-op detection.

The designated owner prepares outside publication locks, reserves recovery
space, then takes the native worktree lock and rechecks authority, identity,
revision and file bytes. It records recovery data before flushing and atomically
replacing the file. Canonical projections, tags, aliases, complete version
history, the terminal receipt and postpublication effects commit together in
the database. An ordinary rejected file write rolls that transaction back.

A committed receipt identifies durable canonical state. Lock contention or
owner downtime leaves accepted work queued; after the synchronous wait (5 s for
agents, 30 s for the CLI, `--wait <seconds>` to change it), `write_pending`
includes the UUID and one-second retry guidance, and the CLI exits 10
([exit status](../protocol/MEMORY_VERBS_v1.md#cli-exit-status-for-writes)). An
uncertain publication stays `recovering` and blocks its worktree until resolved.
Recovery restores prior bytes only when the file still matches the recorded
attempt. Unexpected bytes require explicit repair. Direct filesystem readers
can observe the file/database publication interval.

Page reads return content, tags, withdrawal overlays and revision from one
database snapshot. A read begun after commitment observes that revision or a
later one. Embeddings and Git completion have separate, retryable effect states;
embedding installation checks the captured page/chunk/text/indexing context and
cannot invalidate a committed page. Search excludes unsealed text projections
until a worker rebuilds them. See [concurrent writes](../guides/concurrent-writes.md)
for receipts, capacity, activation and transfer commands.

The rebuild contract above applies only to knowledge actually preserved in
canonical files. DB-only pages, unresolved facts not written to a fence, audit
history, and site-local credentials are not recoverable from Markdown alone.
Keep an appropriate database backup before any destructive recovery, and do
not delete historical unmatched facts or generate empty pages to make them
appear file-backed.

## Write attribution

GBrain records write attribution: who wrote each page revision, page version,
fact, take and timeline row, and who last changed each fact, take and timeline
row. BEFORE ROW triggers copy three transaction-local settings into the row
(`persistence/attribution-schema.ts`). `withCoordinatedWrite` sets them for
journaled requests and coordinated maintenance, and `withWriteAttribution`
(through `maintenanceTransaction`) sets them for unmanaged legacy transactions. A row written outside both
scopes keeps `NULL` attribution, which reads as "unrecorded".

The stamps live in the database only (Markdown never carries them):

| Table | Columns | Meaning |
| --- | --- | --- |
| `pages` | `revision_write_request_id`, `revision_principal_kind`, `revision_principal_id` | Who wrote the live revision. |
| `page_versions` | `write_*` and `archived_*` | Who wrote the snapshotted revision, and whose write archived it. |
| `facts`, `takes`, `timeline_entries` | `write_*` and `last_write_*`, `last_written_at` | Who created the row, and who last changed its content. |

Only the request id (`persistence_requests.id`) and the principal (kind, id)
are stored. Names, operations and times are joined at read time by
`get_write_attribution` (`gbrain attribution`), an `admin` operation; see
[write attribution](../mcp/ADMIN.md#write-attribution). `get_versions` returns
attribution only to trusted local and `admin` callers. A NULL request with a
principal is a maintenance write; all NULL is `unrecorded`: written before
attribution existed (older releases also left `gbrain extract` timeline walks,
meeting timeline extraction and enrichment unattributed). Attribution names the creator and the last writer; it is not an audit
log of every write in between.

Nothing is inferred for older rows. `gbrain repair attribution-backfill` fills
only rows the write journal proves exactly (the page write whose recorded
result is that revision, the `remember` that inserted that fact) and leaves the
rest `unrecorded`. Attribution is not file-backed: rebuilding from Markdown
loses it. Graduation (`gbrain migrate --to postgres` on a PGLite brain) copies
every attributed row verbatim, version history included. The legacy copier
(`gbrain migrate --to pglite`, or graduation turned off) copies it verbatim only
for facts (pages, takes and timeline rows are re-created on the target and
start `unrecorded`; version history is not copied).

- **Managed brains:** creation attribution is complete. The writer guard
  refuses a canonical write outside `withCoordinatedWrite`, so a direct writer
  below either enters a coordinated path or fails before it writes.
- **Unmanaged brains:** journaled page, memory, take and timeline operations
  carry their request. Every other direct writer in the "attributed" list runs
  in `maintenanceTransaction` and carries the local maintenance principal with
  `write_request_id` NULL: imports, legacy sync renames and soft deletes,
  timeline extraction, the legacy facts and takes helpers, cycle phases,
  schema-pack conversions, repairs and the remaining maintenance writers.
  Batch writers commit one bounded transaction per batch (for example 100 rows
  per `gbrain extract timeline --source db` batch), never one transaction for a
  whole run. A row such a writer changes keeps its creator and moves its last
  writer. The maintenance principal is the local CLI registration
  (`local_cli`), else this host's identity (`application`, `host:<id>`), else
  `host:unregistered`: attribution never creates an identity file. No direct
  writer is left unattributed.
- **Belief ledger on unmanaged brains:** three of these writers record their
  belief changes as `unmanaged` events when their source has the ledger on
  (`src/core/belief/projection-point.ts`): the legacy import, the cycle's
  `extract_facts` fence reconcile and the takes reextract, plus the derived
  link writers (extract, the remote auto-links effect and attendance repair)
  on any brain. Every other writer above changes beliefs unrecorded, so an
  unmanaged source's history is never certified; the drift check in
  `gbrain doctor` and the cycle's extract phase find those changes and append
  `reconcile` events.

Agents: treat `NULL` attribution on an unmanaged brain as "written before
attribution existed, or before `gbrain extract`, meeting timeline extraction
and enrichment were attributed (#5575)", not as evidence of tampering. When you add a direct writer, run it in
`maintenanceTransaction(engine, fn)` (`persistence/attribution.ts`) or route it
through the coordinator, then update these lists with the count
`test/write-attribution-legacy.test.ts` reports. The test compares both lists
with a grep of `src` for direct page, version, fact, take and timeline writers
outside the engine and schema layers. The number in parentheses is that grep's
count for the file.

Attributed (inside a request, a coordinated scope or `maintenanceTransaction`,
or a physical projection that leaves attribution untouched):

<!-- write-attribution-covered:start -->
- `src/commands/extract-timeline-db.ts` (2): `gbrain extract timeline --source db` commits one `maintenanceTransaction` per 100-row batch on unmanaged brains; managed brains publish per page through a maintenance request.
- `src/commands/migrate-engine.ts` (5): engine copy keeps the source rows' attribution values verbatim.
- `src/commands/sync/holds.ts` (1): a full sync's move of a held rename (`updateSlug` and its `source_path`) runs in one `maintenanceTransaction`; managed sources publish renames through the sync request preparer.
- `src/commands/sync/rename-collision.ts` (2): the legacy sync rename (`updateSlug`, and the tombstone re-key when the destination slug is a soft-deleted row, #5431) runs with its `source_path` repair in one `maintenanceTransaction`; managed sources publish renames through the sync request preparer.
- `src/core/calibration/undo-wave.ts` (1): the calibration wave undo of take resolutions runs in `maintenanceTransaction`.
- `src/core/chronicle/publish.ts` (1): the retired stamp (and timeline row removal) of a `managed_maintenance_chronicle_retire` request an earlier release journaled, inside that request's coordinated write; every other chronicle event write moved to `generations/adapters/chronicle-events.ts` (GBRA-161 PR 3).
- `src/core/company-brain/profile.ts` (1): legacy sync soft deletes (`softDeleteSyncPages`) run in `maintenanceTransaction`, inside the company-brain source check when one is active.
- `src/core/cycle/dream-provenance.ts` (1): the dream provenance frontmatter stamp runs per page in `maintenanceTransaction`, or `derivedMaintenanceTransaction` at the child's derived tier when the ref carries its taint (unmanaged brains only; managed synthesis publishes through maintenance requests).
- `src/core/cycle/extract-facts.ts` (6): the unmanaged page reconcile and the expiry of fence facts whose page was soft-deleted run in `maintenanceTransaction`; managed brains publish `managed_maintenance_fence_facts` and `managed_maintenance_deleted_page_facts_expire` requests whose preparers write inside the coordinator publication. Both reconcile paths write at the page's tier and gate new rows.
- `src/core/cycle/extract-takes.ts` (1): one projected-takes writer stamps each page's tier and runs the write gate: inside a receipted `managed_maintenance_takes_reextract` request per changed page on managed brains, one `maintenanceTransaction` per page tier for the unmanaged batch upsert.
- `src/core/enrichment-service.ts` (2): the enrichment stub fallback write and its auto-timeline entry run in `maintenanceTransaction` at the source page's derived tier (the stub import is lowered to it afterwards).
- `src/core/extract-timeline-from-meetings.ts` (2): on an unmanaged brain each meeting timeline batch runs in `maintenanceTransaction`, one meeting tier per batch; a managed brain publishes receipted `managed_maintenance_meeting_timeline` requests instead, whose preparer (`prepareMeetingTimeline`) inserts the rows inside the coordinated publication (#6273).
- `src/core/cycle/grade-takes.ts` (1): unmanaged take auto-resolution runs in `maintenanceTransaction`; managed brains publish a `takes_resolve` request.
- `src/core/cycle/phantom-redirect.ts` (2): the unmanaged phantom fact move and phantom soft delete run in `maintenanceTransaction` (the canonical body refresh goes through `facts/file-body-guard.ts`); the managed redirect moves facts inside its coordinated write.
- `src/core/cycle/phases/consolidate.ts` (4): unmanaged consolidation's take insert or re-promotion, consolidation marks and valid_until writeback run in one `derivedMaintenanceTransaction` per cluster at the cluster's derived tier; managed brains submit a maintenance consolidation request.
- `src/core/embed-facts.ts` (1): embedding columns only (physical projection).
- `src/core/embedding-dim-check.ts` (1): embedding columns only (physical projection).
- `src/core/extract/receipt-writer.ts` (1): the extraction receipt page runs in `maintenanceTransaction`.
- `src/core/facts/backstop.ts` (1): the facts backstop's DB-only fallbacks insert each fact through one helper, in `maintenanceTransaction` at the extraction's derived tier; managed brains publish through the facts request preparer.
- `src/core/facts/conversation-publication.ts` (6): the managed conversation-facts preparer clears each member page's prior rows and inserts its frozen entry (or a blocked outcome row) inside the coordinator publication of its admitted batch request, clearing only for a complete replacement (#7013); the unmanaged writer runs the same publication in `maintenanceTransaction`. Its page clear also expires the rows `gbrain facts relink --conversation` linked (after deleting the previous clear's expired copies), inside the same transaction (#6764). The segmented incremental run, unmanaged only, re-anchors moved windows' facts and stamps fresh rows' windows (`source_window`) in the same `maintenanceTransaction`.
- `src/core/facts/conversation-relink.ts` (1): `gbrain facts relink --conversation`: a `managed_maintenance_conversation_relink` request on managed brains; the unmanaged relink runs in `writeDerivedFacts` (`maintenanceTransaction`).
- `src/core/facts/derivation-inputs.ts` (3): `hideDerivedRows` expires derived facts, deactivates derived takes and soft-deletes derived pages inside the purge's coordinated transaction, attributed to the purge request.
- `src/core/facts/fence-fact-append.ts` (1): `prepareFenceFactAppend` inserts the facts row of a fence row the request's page file holds, in its caller's coordinated publication after the page row (remember and its callers).
- `src/core/facts/fence-write.ts` (1): the markdown-first fence reconcile insert runs in `maintenanceTransaction` (its page body mirror goes through `facts/file-body-guard.ts`).
- `src/core/facts/file-body-guard.ts` (2): the #6982 checked body mirror (`replaceStoredBody`: the page_versions row and the body refresh, under the page row lock) runs in its caller's `maintenanceTransaction` (fence write, unfenced-facts fence, phantom redirect, forget, proposal supersede).
- `src/core/facts/forget.ts` (4): the legacy fence expiry, withdrawal and strike-through each run in `maintenanceTransaction` (nested inside a caller's coordinated write, they keep its actor).
- `src/core/facts/ontology-rekey.ts` (1): B-10's duplicate-observation drop runs in its caller's transaction immediately before the caller's re-key: the rename's `maintenanceTransaction`, the `relink_facts` publication, the phantom redirect's fact move and `repair facts-rehome`'s move; every caller is attributed.
- `src/core/facts/proposal-supersede.ts` (4): unmanaged `decide` proposal accept and undo run in one `maintenanceTransaction` each; managed brains publish a `decide_proposal` request.
- `src/core/facts/purge.ts` (2): `purge_fact` rewrites purged pages' bodies and redacts their versions inside `withCoordinatedWrite` with the purge request's attribution.
- `src/core/facts/relink-publish.ts` (2): `relink_facts` request preparer.
- `src/core/facts/unfenced-facts.ts` (1): the cycle and v0.32.2 fence of `row_num`-NULL facts: a maintenance request on managed brains; the unmanaged row-number stamp runs in `maintenanceTransaction` (the body mirror goes through `facts/file-body-guard.ts`).
- `src/core/facts/withdrawal.ts` (1): runs inside the `forget` request's coordinated write.
- `src/core/persistence/twin-merge.ts` (5): the #6948 twin merge runs in the `managed_maintenance_resolve_origin_twin` preparer's coordinated transaction on managed brains and in one `maintenanceTransaction` on unmanaged brains (`gbrain repair origin-twins` and the post-sync heal); `gbrain repair legacy-twins` calls it from a receipted `managed_maintenance_merge_legacy_twin` request on managed brains and from one `maintenanceTransaction` under both page locks on unmanaged brains.
- `src/core/trust/timeline-projection.ts` (2): `gbrain extract` timeline walks (file, incremental, stale) and the per-entry fallback write through it: one `maintenanceTransaction` per page tier.
- `src/core/facts/write-single.ts` (2): the legacy single-fact insert and its supersession link each run in `maintenanceTransaction`; managed brains publish through the fact request.
- `src/core/generations/adapters/atoms.ts` (1): the unmanaged atom completion stamp (`source_hash`) runs inside the generation activation's `maintenanceTransaction` (`publish.ts`, GBRA-161).
- `src/core/generations/adapters/chronicle-events.ts` (3): Life Chronicle event writes, their timeline projection rows and the retirement of dropped events run inside the generation activation's `maintenanceTransaction` (`publish.ts`) on unmanaged brains and inside the coordinated `managed_generation_activate` / `managed_generation_restore` requests on managed brains (GBRA-161 PR 3); a restore runs in the restore runner's (`repair.ts`).
- `src/core/generations/adapters/single-page.ts` (3): the unmanaged dream summary, saved `think` page and drift report (the page, its tags, and the page_versions copy of the live page it replaces) run inside the generation activation's `maintenanceTransaction` (`publish.ts`), attributed at the derivation's tier when the writer declares one (GBRA-161 PR 5); managed brains publish them through a maintenance request.
- `src/core/generations/managed-retire.ts` (1): the retirement stamp (`retired_by`, `retired_at`) of one synthesis output a managed generation retires runs inside its `managed_generation_retire` request's coordinated write, after the versioned page delete (GBRA-161 PR 4).
- `src/core/generations/adapters/extracted-facts.ts` (2): the extracted-facts generation's row inserts and retirements (`publishExtractedFacts`, GBRA-161 PR 2) run inside the generation activation's `maintenanceTransaction` (`publish.ts`); its restore runs in the restore runner's (`repair.ts`).
- `src/core/generations/adapters/fact-rows.ts` (1): putting a fact's recorded before-state back (`restoreFactRow`) runs only inside a generation restore's `maintenanceTransaction` (`repair.ts`, GBRA-161 PR 2).
- `src/core/import-file.ts` (12): direct markdown, code and image imports, the moved-file rename (`updateSlug`) and the #3694 legacy-hash re-stamp run in `maintenanceTransaction`; managed imports go through the page request preparer.
- `src/core/minions/handlers/ingest-capture.ts` (1): the capture ingest tombstone soft delete runs in `maintenanceTransaction`.
- `src/core/ops/extraction.ts` (2): extraction review promote (frontmatter) and reject (soft delete) each run in `maintenanceTransaction`.
- `src/core/output/writer.ts` (4): `BrainWriter.transaction` is a `maintenanceTransaction`, so its pages and timeline rows carry the maintenance principal.
- `src/core/page-body/segment-rewrite.ts` (2): a segmented page's fence rewrite (the soft-delete `deleted_at` restore after its generation flip, and the purged version's `page_versions` hash redaction) runs in its caller's transaction: `forget`'s `maintenanceTransaction`, the withdrawal inside the `forget` request's coordinated write, and `purge_fact`'s `withCoordinatedWrite`.
- `src/core/page-body/streamed-import.ts` (1): the streamed segmented import's pre-replace version snapshot runs in its `maintenanceTransaction`.
- `src/core/page-state/materialize.ts` (1): coordinated maintenance.
- `src/core/page-state/rename-alias.ts` (5): the fact slug rewrite runs inside its caller's `updateSlug` transaction, and `movePageIdReferences` (#5431: page_versions, timeline_entries and links moved to the row that materialized under a fallback rename) runs inside `carryRenameIdentity`'s `maintenanceTransaction`; every caller is attributed.
- `src/core/page-state/versions.ts` (2): `createVersion` itself and its segmented-page twin; the caller's scope supplies the actor.
- `src/core/persistence/atom-maintenance.ts` (1): request preparer.
- `src/core/persistence/canonical-projections.ts` (8): fence projection inside the request's publication.
- `src/core/persistence/connector-google-receipts.ts` (2): request preparer.
- `src/core/persistence/connector-sync.ts` (2): connector publication inside `withCoordinatedWrite`.
- `src/core/persistence/derived-facts.ts` (1): the gated conversation fact insert (`insertDerivedFacts`) on unmanaged brains, in `writeDerivedFacts`' `maintenanceTransaction` at the page's derived tier.
- `src/core/persistence/derived-retirement-hold.ts` (3): `retireDerivedPages` versions, soft-deletes and stamps retired derived pages (unmanaged extract_atoms stale atoms) in 500-page `maintenanceTransaction` chunks.
- `src/core/persistence/facts-prepare.ts` (3): managed `extract_facts` request preparer.
- `src/core/persistence/file-repair.ts` (2): `managed_file_repair` request preparer (#5988).
- `src/core/persistence/links-maintenance.ts` (1): coordinated maintenance.
- `src/core/persistence/loop-fact-retirement.ts` (1): request preparer.
- `src/core/persistence/memory-mutations.ts` (1): `forget` inside its request's coordinated write.
- `src/core/persistence/memory-prepare.ts` (2): `remember` request preparer; the fence row and its facts row go through `prepareFenceFactAppend`.
- `src/core/persistence/page-append.ts` (1): segmented `append_page` / `edit_page` request preparer; the splice versions the page inside its request's publication.
- `src/core/persistence/page-prepare.ts` (12): page request preparer (including the restore of a segmented page over 24 MiB, which flips `deleted_at` without re-serializing, and the tag flip of a segmented page, which versions it and changes its tag rows and `content_hash` without re-serializing).
- `src/core/persistence/prepared-maintenance.ts` (4): managed maintenance request preparer (consolidation closes an unfenced fact in the database and a fenced one from its published fence cell).
- `src/core/persistence/semantic-pages.ts` (1): `add_timeline_entry` request preparer.
- `src/core/persistence/sync-image.ts` (2): managed sync image request preparer; a Git rename retires the old page inside the same publication.
- `src/core/persistence/sync-prepare.ts` (4): managed sync request preparer.
- `src/core/persistence/sync-streamed.ts` (1): the streamed sync of a file over the single-string ceiling moves a renamed page (`updateSlug`) in its request's apply, inside the coordinated publication.
- `src/core/persistence/takes-prepare.ts` (3): takes request preparer.
- `src/core/repair/atoms-restore.ts` (3): the unmanaged `gbrain repair atoms-restore` apply archives the retired atom's version, restores it and drops its `retired_by`/`retired_at` stamp in one `maintenanceTransaction`; managed brains publish a `managed_maintenance_restore_reextract_atom` request instead.
- `src/core/repair/captured-facts.ts` (1): a request on managed brains; the unmanaged captured-facts expiry runs in `maintenanceTransaction`.
- `src/core/repair/consolidate-ties.ts` (1): `gbrain repair consolidate-ties` reopens facts inside `coordinatedDatabaseWrite` on managed brains (the `relink_facts` operation) and in one `maintenanceTransaction` per fact on unmanaged brains.
- `src/core/repair/duplicate-facts.ts` (2): `gbrain repair duplicate-facts` supersedes duplicate fact copies inside `coordinatedDatabaseWrite` on managed brains (the `relink_facts` operation) and in one `maintenanceTransaction` per group on unmanaged brains; a fenced copy is struck through a revision-bound `put_page` first.
- `src/core/repair/conversation-labels.ts` (4): a request on managed brains; the unmanaged label retirement runs in `maintenanceTransaction`.
- `src/core/repair/extractor-facts.ts` (1): a request on managed brains; the unmanaged extractor-facts restore runs in `maintenanceTransaction`.
- `src/core/repair/fact-claim-dates.ts` (1): `gbrain repair fact-claim-dates` updates database-only facts' `valid_from` in one `maintenanceTransaction` on unmanaged brains only; fence rows move through revision-bound `put_page`, and a managed brain never takes the direct update.
- `src/core/repair/facts-rehome.ts` (1): `gbrain repair facts-rehome` moves facts inside `coordinatedDatabaseWrite` on managed brains (the `relink_facts` operation) and in one `maintenanceTransaction` per slug on unmanaged brains.
- `src/core/repair/frontmatter.ts` (1): a `managed_file_repair` request on managed sources; the unmanaged rename runs in `maintenanceTransaction`.
- `src/core/repair/ghost-pages.ts` (2): `gbrain repair ghost-pages` retirement: a receipted `managed_maintenance_retire_ghost_page` request (a prepared `delete_page` with no file bytes) on managed brains; the unmanaged version and soft delete run in `maintenanceTransaction` after the same recheck.
- `src/core/repair/ontology-facts.ts` (1): a coordinated database-only write (`coordinatedDatabaseWrite`, the `ontology_propose` path) on managed brains; the unmanaged ontology-facts restore runs in `maintenanceTransaction`.
- `src/core/repair/redacted-facts.ts` (1): a `managed_maintenance_restore_redacted_facts` request on managed brains; the unmanaged restore of database-only fact text runs in `maintenanceTransaction`.
- `src/core/repair/rename-identity.ts` (5): `gbrain repair rename-identity` carry, unmanaged brains only (a managed brain refuses `managed_remedy_unavailable` before writing); the fence-row merge, the provisional page's retirement, the slug move and the import run in one `maintenanceTransaction` under both page locks after the plan-hash recheck.
- `src/core/repair/stale-atoms.ts` (1): the retirement stamp. On managed brains it runs in the `managed_maintenance_retire_stale_atoms` request's apply; on unmanaged brains the retirement is an approved atom generation (`publishGeneration`, one `maintenanceTransaction`) and the stamp runs in its `onRetired` callback inside that transaction.
- `src/core/repair/take-supersession.ts` (1): `gbrain repair take-supersession` reprojection: a receipted `managed_maintenance_take_reproject` request on managed brains, `maintenanceTransaction` on unmanaged ones; fence edits go through a revision-bound `put_page`.
- `src/core/repair/timeline-comments.ts` (1): `gbrain repair timeline-comments` row cleanup: `withCoordinatedWrite` under the page key on managed brains, `maintenanceTransaction` otherwise.
- `src/core/repair/url-clone-fences.ts` (2): `gbrain repair url-clone-fences` (#6946), unmanaged brains only (a managed brain previews nothing); keeping the appended fence rows database-only (clearing `row_num`, inserting a row the database lost) runs in one `maintenanceTransaction` under the page lock after the preview recheck; HEAD's bytes then import through `importFromContent` (a HEAD that asks for private in a spelling page privacy does not read is held: not imported, and the apply reports `held`, #7897).
- `src/core/repair/visibility.ts` (1): `gbrain repair visibility --apply` tightening of database-only world facts from a private source: a receipted `managed_maintenance_tighten_fact_visibility` request on managed brains, `maintenanceTransaction` on unmanaged ones; fenced rows change through a revision-bound `put_page`.
- `src/core/schema-pack/page-to-alias.ts` (1): the page-to-alias conversion soft-deletes each converted page in `maintenanceTransaction`.
- `src/core/schema-pack/page-to-link.ts` (1): the page-to-link conversion soft-deletes each converted page in `maintenanceTransaction`.
- `src/core/schema-pack/retype.ts` (1): each bounded retype batch runs in `maintenanceTransaction`.
- `src/core/schema-pack/sync.ts` (1): each bounded pack type sync batch runs in `maintenanceTransaction`.
- `src/core/sweep.ts` (1): the maintenance sweep's bounded timeline batch runs in `maintenanceTransaction`.
- `src/core/takes-write.ts` (7): the takes file helpers' DB mirror (add, append, update, supersede, resolve and its self-heal) runs in `maintenanceTransaction`; managed brains publish through the takes request preparer.
- `src/core/timeline-dedup-repair.ts` (1): runs only from schema migration v139, before migration v193 adds the attribution columns, so it has no actor to record.
- `src/core/timeline-write-through.ts` (2): the timeline write-through's page row splice and entry insert run in one `maintenanceTransaction`.
- `src/core/trust/fence-guard.ts` (2): the guarded fence re-projection detaches or moves higher-tier fact rows inside the page's coordinated publication.
- `src/core/trust/held-removals.ts` (1): an owner accept of a held take or timeline removal re-projects the row as the page says in a coordinated (managed) or attributed (unmanaged) transaction under the page key.
- `src/core/trust/owner-actions.ts` (1): an owner release inserts the held fact database-only at user_confirmed in an attributed transaction (unmanaged) or, on a managed brain, in a coordinated one only for a hold with no entity slug or whose page is missing; every other managed fact release is a journaled `trust_release` publication (`src/core/trust/release-publish.ts`) that writes the fence row to the file first; an index-existing release binds the cell's previewed fields and refuses `preview_changed` when the cell moved, and the database-only release re-checks the approval on the locked hold.
- `src/core/trust/supersede-handlers.ts` (3): owner accept/undo of a trust proposal re-tiers the new fact (or take) inside the checked supersede's (or takes publication's) transaction.
<!-- write-attribution-covered:end -->

Unattributed (on unmanaged brains these would write with `NULL` attribution).
The list is empty: `gbrain extract` timeline walks, enrichment and meeting
timeline extraction run as tiered derivers since #5575 (I2). A new writer
that cannot be attributed yet is declared here:

<!-- write-attribution-unattributed:start -->
<!-- write-attribution-unattributed:end -->

## The privacy boundary

Private knowledge in a fence still lives in the markdown file. If the
user commits the page to git, the private data lands in git too. This
is the existing operational model — we don't infer git policy.

For untrusted readers (remote MCP, subagent), gbrain applies a 3-layer
strip:

1. **Layer A (chunker):** `src/core/chunkers/recursive.ts` calls
   `stripFactsFence({keepVisibility: ['world']})` + `stripTakesFence`
   before chunking. Private fact text never reaches
   `content_chunks.chunk_text`, embeddings, or search results.
2. **Layer B (get_page):** when `ctx.remote === true`, the response
   body has both fences stripped (private rows from facts; entire
   takes fence). Local CLI (`ctx.remote === false`) sees the full
   fence.
3. **Layer C (git tracking):** the user decides whether to commit the
   entity page. `gbrain.yml` `db_only` paths are gitignored
   automatically; per-page choices via the user's normal git workflow.

For universally-private entities (a friend's name, an investor's
internal notes), mark the entity page's directory as `db_only` in
`gbrain.yml`. The file stays on disk but never lands in git.

## The forget contract

`gbrain forget <id>` and the MCP `forget_fact` operation commit withdrawal to
the authoritative database ledger first. The transaction expires matching facts,
adds claim-fingerprint overlays, advances affected page revisions and invalidates
their retrieval projections. No filesystem owner is required. Stale imports and
delayed embedding work cannot undo the withdrawal.

The owner later mirrors the current logical snapshot into Markdown, retaining
strikethrough, withdrawal dates and context for historical rows. Mirroring does
not advance the logical revision again. A failed or uncertain mirror never
reverses withdrawal; direct page snapshots apply the ledger while it is pending.

Strikethrough has two semantics distinguished by context:

- `~~claim~~` + `context: "superseded by #N"` → row was replaced by
  a newer row in the same fence
- `~~claim~~` + `context: "forgotten: <reason>"` → row was retracted
  via the forget op

Both encodings retain history in Markdown. Withdrawal removes a fact from active
memory; history, source material and private backups may remain. Editing a fence
does not erase the withdrawal ledger or promise physical erasure.

## Disaster recovery

The belief ledger is DB-only (see the exceptions above). The rebuild below
keeps it, but every fact, take and link it deletes and re-derives is recorded
as a change by the next `gbrain doctor --fix` or cycle (`reconcile` events,
and the slugs stay uncertified for that interval), and dropping the database
loses the history for good. After a database backup restore, replay the
purges made after the backup (`gbrain doctor --only belief_ledger_coverage`
names any restore whose replay was partial, unavailable or unverified).

This example is only for a database whose affected facts, takes, links and
timeline entries have been verified to exist in canonical files. Before running
the destructive commands, stop writers and verify a restorable database backup
plus source-file backups. Do not use this recipe on unresolved DB-only facts or
assume a repository backup covers gitignored files. Preserve the authoritative
withdrawal ledger and all accepted request identities. On an activated managed
brain, use the documented drained recovery procedure; direct SQL or an older
writer cannot safely replace the coordinator.

```bash
# File-backed state only: verify restorable DB + source backups before proceeding.
# Record counts for comparison; this is not a backup.
gbrain stats > /tmp/before.txt

# Wipe and rebuild — delete the derived tables (pages + content_chunks
# survive the CASCADE-safe design), then re-derive from the repo.
# On PGLite, `gbrain reinit-pglite` wipes the whole embedded DB instead.
psql -c 'DELETE FROM facts; DELETE FROM takes; DELETE FROM links; DELETE FROM timeline_entries;'
gbrain sync
gbrain extract all

# Compare file-backed counts and investigate differences; full DB parity is not promised.
gbrain stats > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

The invariant E2E test at `test/e2e/system-of-record-invariant.test.ts`
proves reconstruction of its file-backed facts/takes fixture. It does not prove
recovery of DB-only knowledge, operational state, or every production database.

## Rule for new code

When you add a new user-knowledge category:

1. **Define the markdown shape.** Fence (`<!--- gbrain:NAME:begin
   --> ... :end -->` table) or frontmatter field.
2. **Build a parser** that produces structured data from markdown.
   See `src/core/fence-shared.ts` for the shared primitives.
3. **Build a writer** that round-trips: parse + edit + render produces
   byte-identical markdown for identical input.
4. **Add the engine method** that takes parsed data and stamps a
   derived table. The method gets an entry in the CI gate's
   banned-direct-call list.
5. **Add a reconciler:** a cycle phase that walks pages, parses the
   fence, and rebuilds the derived table from scratch. The reconciler
   is the only legitimate call site for the engine method;
   `// gbrain-allow-direct-insert: <reason>` annotates it explicitly.
6. **Add a round-trip test** in `test/e2e/system-of-record-invariant.test.ts`
   that proves DELETE + reconcile rebuilds the table byte-identically.

The CI gate at `scripts/check-system-of-record.sh` fails any PR that
adds a new direct call to a derived-table writer outside the
reconciler / migration layer without the explicit allow-list comment.

## Related

- `skills/migrations/v0.32.2.md` — the agent-facing migration guide
- `CHANGELOG.md` — release history
- `scripts/check-system-of-record.sh` — the CI gate that enforces
  the rule
