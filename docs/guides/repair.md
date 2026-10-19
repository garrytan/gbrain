# Repair residual damage with `gbrain repair`

`gbrain doctor` finds some damage that it cannot fix on its own: timeline
history that exists only in the database, derived pages without an explicit
visibility, pages indexed before the safe-chunk fence, pages imported
without a contextual retrieval mode, connector checkpoint rows no source
can load, and Google source files other local users can read. `gbrain repair`
fixes those and the other kinds listed in
[What each kind fixes](#what-each-kind-fixes). Every run is a preview unless
you pass `--apply`.
The explicit-only kinds, among them `google-file-modes`, `stale-atoms`, `atoms-restore`, `extractor-facts`,
`captured-facts`, `loop-facts`, `ontology-facts`, `orphan-children`, `failed-writes`, `frontmatter`, `managed-sync-orphans`, `content-receipt-root`, `stuck-recovery`, `aliases` and `rename-identity`, run only when you name them (see [Explicit-only repair kinds](#explicit-only-repair-kinds)).
`gbrain doctor --remediation-plan` lists the same kinds as repair steps, and
`gbrain doctor --remediate --yes --include-repairs --expect <plan_hash>` runs them under a budget
(see [Run repairs through doctor](#run-repairs-through-doctor)).

**Say to your agent:** *"Doctor says some timeline history is only in the
database. Show me what `gbrain repair` would change, then apply it."* The
agent runs `gbrain repair` to preview and, after you agree,
`gbrain repair <kind> --apply` on the brain host.

## Preview first

```bash
gbrain repair                    # preview every automatic kind
gbrain repair timeline           # preview one kind
gbrain repair --json             # machine-readable preview
```

The preview names the brain and sources it will touch, then prints one block
per kind:

```text
Scope: brain <brain id>; sources default
timeline: 12 item(s) to repair
  e.g. default:people/alice-example, default:companies/acme-example
  materializable_rows=31, kept_unrenderable_rows=2
  cost: 12 request ID(s), 196608 receipt bytes, 12 page(s) to re-embed
  capacity brain lifetime_ids: 4100 of 1000000 (stops at 900000)
  ...
  apply: gbrain repair timeline --apply
```

- **Items** are pages. The sample lists at most 10 of them as `source:slug`.
- **Residuals** are named counters: some count what the repair will do
  (`materializable_rows`, `atoms_origin_gone_to_private`), others count rows
  it leaves alone (see [What each kind fixes](#what-each-kind-fixes)).
- **Cost** is what an apply of the pending items would consume: one permanent
  request ID and 16 KiB of reserved receipt space per page for `timeline` and
  `visibility`, and nothing for `safe-chunks` or `contextual-mode`. When an embedding model is
  configured and priced, the line adds an estimated embedding cost in dollars.
- **Capacity** shows the write-journal counters the run draws on and the 90%
  line where it stops (see [Capacity stop](#capacity-stop)).
- **apply** is the command that applies this kind with the same `--source`
  (and `--no-embed`). It does not repeat `--limit`; add it yourself if you
  previewed a limited batch.

## Apply

```bash
gbrain repair timeline --apply
gbrain repair visibility --apply
gbrain repair safe-chunks --apply
gbrain repair safe-chunks --apply --no-embed   # re-seal text now, embed later
gbrain repair contextual-mode --apply
gbrain repair request-indexes --apply
gbrain repair google-file-modes --apply             # explicit-only: runs only when named
gbrain repair --all --apply                    # every automatic kind in order
```

`--apply` writes without a prompt, so review the preview first. With
`--apply` you must name a kind or pass `--all`; `--yes` is refused, and so is
any other option the table below does not list, including `--max-usd`: a
refused run changes nothing. To cap paid embedding work, run the repairs
through `gbrain doctor --remediate --yes --include-repairs --expect <plan_hash> --max-usd <n>`
(`<plan_hash>` comes from `gbrain doctor --remediation-plan --json`). `--all`
runs `timeline`, then `visibility`, then `safe-chunks`, then `contextual-mode`, then `connector-checkpoints`, then `request-indexes`, then `connector-fences`, then `take-supersession`, then `orphan-bindings`, then `embedding-effects`, then `attribution-backfill`, then `planner-stats`, and stops at the
first kind that stops.
The explicit-only kinds never run under
`--all`; it lists each with its preview command and still exits 0 when they
are the only findings left. `gbrain repair` with no kind does the same for a
preview. With `--json` the list is `explicit_kinds[]` (`kind`, `code:
"explicit_kind_required"`, `preview_command`, `docs`).

Each item is re-checked against the page's current state just before it is
written, and the write is bound to the revision it just read, so an edit made
after planning is kept and repaired too. An item that no longer needs the
repair, or whose page changes during the write, is counted as `skipped` and
left for the next run. An item the write refuses for its own reasons (its slug
is one the grammar no longer accepts, `invalid_params`; its file and database
copy disagree and neither is overwritten, `source_changed`) is listed in
`failed[]` with its reason and left exactly as it was, and the run goes on to
the next item. A failed item is not retried by a resumed run (a later success
moves the cursor past it); it is retried by the next full scan, which is the
printed `apply_command` once the run has completed. No kind deletes data except `stale-atoms`, which
soft-deletes the atoms it retires, and `managed-sync-orphans`, which deletes
only sync bookkeeping rows nothing current can resume ([Managed sync
orphans](#managed-sync-orphans)). Retired atoms stay recoverable through the
`restore_page` operation for 72 hours, and a later extraction that produces
a retired atom again restores it. See [Stale atoms](#stale-atoms).
`extractor-facts` only restores previewed facts (it clears `expired_at` and
gives each a fresh row number); it never deletes or rewrites a page.

| Option | Effect |
| --- | --- |
| `--apply` | Write the repair. Without it, only preview. |
| `--source <id>` | Limit the run to one active source. The default is every active (non-archived) source. An unknown or archived id is refused. |
| `--limit <n>` | Repair at most `n` items per kind in this run (a positive integer; with `--all`, up to `n` for each kind). Rerun the same command to continue. |
| `--no-embed` | `safe-chunks` and `contextual-mode`: skip the embedding provider. Run `gbrain embed --stale` later. `timeline` and `visibility` pages are re-embedded by their publication either way. |
| `--all` | Run every automatic kind in order. Explicit-only kinds are listed with their preview command, never run. |
| `--expect <hash>` | Explicit-only kinds: apply exactly the set the preview printed under this hash. Required with `--apply` for `stale-atoms`, `atoms-restore`, `extractor-facts`, `captured-facts`, `loop-facts`, `failed-writes`, `frontmatter`, `managed-sync-orphans` and `content-receipt-root`. |
| `--include-ambiguous` | `extractor-facts` and `captured-facts`: widen the hashed set to `ambiguous` facts. `frontmatter`: add interpretive file changes. Pass it to both the preview and the apply. See [Extractor facts](#extractor-facts), [Captured facts](#captured-facts) and [Frontmatter](#frontmatter). |
| `--only <path>`, `--skip <path>` | `frontmatter` only: select source-relative files (repeatable). The hash covers the selection, so pass the same flags to the apply. |
| `--diff` | `frontmatter` only: print every per-file diff instead of one sample per class (`--json` always carries all of them). |
| `--yes` | `frontmatter --apply` only: the user agreed to the previewed file changes (destructive consent). Without it a terminal asks, and a run without a terminal exits 3 with the consent payload. |
| `--json` | Print `{ scope, mode, results[], paid_kinds }`, one result per kind with `paid`, `affected`, `sample`, `residuals`, `cost`, `capacity`, `resumed_from`, `applied`, `skipped`, `failed[]` (`item`, `source_id`, `slug`, `reason`, `message`, `retry: "next_full_scan"`), `complete`, `stopped` and `apply_command`, plus `explicit_kinds[]` when the run skipped explicit-only kinds. |

The command exits 1 when a run stops early (capacity, a pending write, or a
held writer) and when any item failed (`failed[]` is not empty; `complete`
still means every pending item was attempted). A `--limit` batch that leaves
work behind exits 0, so scripts should also check `results[].complete`.
`gbrain doctor --remediate` reports a repair step with failed items as
`failed`, never `completed`.

## What each kind fixes

| Kind | Doctor check that points here | What it does | Left alone and counted |
| --- | --- | --- | --- |
| `timeline` | `timeline_history` | Re-saves each page with its current body through a revision-bound `put_page`. The save writes each database-only timeline entry back into the page as a bullet preceded by `<!-- gbrain:materialized v1 <hash> -->`. | `kept_unrenderable_rows`: entries that would change if written as a bullet (for example an empty source). They stay in the database. |
| `visibility` | `derived_visibility` | Stamps an explicit `visibility` on extracted atoms and synthesized concepts. An atom takes its origin page's visibility; transcript atoms and atoms whose origin is gone become `private`; a concept takes the strictest visibility of its input atoms. A concept input found only through an atom's `concepts:` list counts as private. Atoms are repaired before concepts. It never loosens an explicit value: `private` stays `private`, and `world` can only become `private`. A missing value is stamped with the origin's value, which is `world` when the origin page is public. | `concepts_without_lineage`: concepts whose inputs cannot be found. They stay as they are, and remote readers already treat a missing visibility as private. `atoms_origin_gone_to_private` counts atoms made private because their origin page no longer exists. |
| `request-indexes` | `persistence_request_indexes` | Creates a missing request-table index (the managed sync checkpoint pair, the purge slug index, the dream postprocess request-id index), or drops an INVALID one (left by an interrupted concurrent build) and rebuilds it, on a brain whose schema version is already current. Postgres builds each index `CONCURRENTLY`, one at a time, so writes continue; PGLite builds inline. It changes no user data, takes no journal admission and runs brain-wide (`--source` does not narrow it). See [managed sync request indexes](#request-indexes). | `building`: an index another session is still building; it is never dropped. |
| `connector-fences` | none (a `connector_fence_below_timeline` refusal names it) | Moves a facts or takes fence that sits below the timeline sentinel of a Google or GitHub page into the page body through a revision-bound `put_page`, so the connector's next re-render carries the fence instead of refusing. Then re-attempt the held item with `gbrain sources retry-held <source>`. | `kept_ambiguous_pages`: pages whose fences are duplicated, unbalanced or unparseable. Move the fence by hand: read the page, place the fence above the `<!-- timeline -->` line, and save it with the current `expected_revision`. |
| `take-supersession` | none | Rebuilds `takes.superseded_by` for supersession chains written before the pointer moved onto the old fence row (#5886). Each struck take is linked to the row that replaced it only from evidence: a committed `takes_supersede` receipt, a stored `superseded_by`, or a row carrying the old `superseded by #<own row>` pointer with exactly one possible predecessor. The pointer is written onto the old row (`<source>; superseded by #N`) and stale self-pointers are dropped through a revision-bound `put_page`; a page whose fence is already right but whose stored pointers differ is reprojected without a page write. See [take supersession](#take-supersession). | `ambiguous_pages` / `ambiguous_rows`: pages where a new row has two or more possible predecessors, or where evidence conflicts. The preview lists each with its candidates and the manual edit; nothing on them changes. `unparsed_pages`: pages whose takes fence does not parse cleanly. |
| `accepted-takes` | none | Explicit-only, preview-bound. Restores takes that accepting a held strike-through or kind change removed on v0.60.253.0 (`gbrain trust confirm tp<id>` ran a `takes_remove` instead of applying the change). It restores only what the records prove: the accepted proposal, the `takes_remove` receipt bound to it, the page version that receipt archived (the row the accept should have applied) and the reservation row still holding its number. `--apply --expect <hash>` republishes each page with that row through a revision-bound `put_page`. See [accepted takes](#accepted-takes). | `version_missing` (the archived version was pruned), `row_number_in_use` (the number holds a take again), `page_missing`, `fence_unreadable`. A grade or resolution the database alone held is not in any record and is not restored. |
| `connector-checkpoints` | `connector_checkpoints` | Deletes managed connector checkpoint rows and retry pointers that no registered connector source can load and that are older than 7 days. They accumulate after a content setting such as `g_history_days` changes, or when a connector host older than v0.60.11.0 runs during an upgrade. Cleanup only: it never copies or re-keys a checkpoint, takes no journal admission and runs brain-wide (`--source` does not narrow it). | Rows a queued or running connector write, or a connector's recorded pending set, still references. |
| `orphan-bindings` | `orphan_persistence_bindings` | Deletes persistence source bindings whose source was removed, or that belong to an earlier incarnation of a source re-added under the same id. `gbrain sources remove` and `gbrain sources purge` delete the binding; one an older gbrain left behind makes the re-added source read as claimed, so every `gbrain sync --source <id>` fails with `writer_coordinator_required`. Bookkeeping only: no journal admission, no page or file changes, and it runs brain-wide (`--source` does not narrow it). See [orphan bindings](#orphan-bindings). | A binding that a queued, running or recovering write request of the same source incarnation still references. |
| `managed-sync-orphans` | `sync_failures` | Explicit-only, preview-bound. Retires managed sync bookkeeping nothing current can resume or clear: a `managed-sync-failure` row whose cursor key has no cursor, and an unfinished `managed-sync` cursor recorded by a principal that is no longer an active local writer (or a pre-options cursor a later run superseded) whose pending request is terminal, or (#6834) a cursor whose checkpoint can never publish because the source's `last_commit` moved elsewhere (`checkpoint_moved`). `op_checkpoints` rows only; no journal admission, no page or file changes. The preview prints a hash; `--apply --expect <hash>` retires exactly that set. See [managed sync orphans](#managed-sync-orphans). | An unfinished cursor whose pending request is still queued, running or recovering, or one the live writer can resume with its recorded options (doctor prints that sync command). |
| `content-receipt-root` | `sync_freshness` (`content_receipt_stale`) | Explicit-only, preview-bound, owner host. Rebinds a gbrain-owned content source's shared-skills content receipt that still names an old root after a writer transfer or relocation, when the owner's tree still hashes to the recorded worktree manifest. The receipt row only; the previous value is kept under `<key>.backup`. See [content receipt root](#content-receipt-root). | A receipt whose source path, owner host or tree does not match: listed with its class and the step to run first. |
| `stuck-recovery` | none (`gbrain sources writer status` shows the request `recovering`, or the withdrawal-mirror effect, with `unexpected_file_bytes`) | Explicit-only, preview-bound, destructive consent. Resolves a live page or shared-skill bundle publication recovery whose file matches neither its recorded prior nor its published bytes, and a withdrawal-mirror effect recovery whose file was edited while it was mirroring; each stops every write on its worktree. The preview lists each blocked file with both fingerprints and writes a private diff; `--apply --expect <hash> --keep prior\|disk --yes` backs up both versions, then restores the prior (the write publishes again) or keeps the edit and abandons the write (every file of a bundle one way); an effect's only choice, `--keep withdrawn`, backs up the edit and writes the withdrawn version. A file over 24 MiB resolves the same way, read in pieces, with a bounded diff summary. See [stuck recovery](#stuck-recovery). | A terminal request with its recovery still set (listed as refused, `recovery_choice_refused`), an effect or bundle record that cannot be resolved (listed as refused, `recovery_effect_unsupported` or `recovery_bundle_unsupported`, with an ask_user fix), `--keep prior` on a large-file recovery whose staged prior copy is missing or damaged (`recovery_prior_stage_unavailable`; `--keep disk` still resolves it), a recovery blocked on staging bytes, and a recovery whose file already matches a recorded version (the resident writer finishes those). |
| `frontmatter-keys` | `stale_frontmatter_keys` | Explicit-only, preview-bound. Strips the parser's reserved top-level keys (`type`, `title`, `tags`, `slug`) that an older import stored inside `pages.frontmatter`. Since v0.60.176.0 those keys are not file/database drift and never render (#6454), so this is hygiene: database rows only, in source-scoped coordinated batches of up to 1,000 pages, no file, body or embedding change. Each swept page advances its `knowledge_revision` once, so a client holding an older revision of a swept page gets one `revision_conflict` and re-reads. See [frontmatter keys](#frontmatter-keys). | A page whose keys were cleared by a write between preview and apply (`already_clean`). |
| `embedding-effects` | `stale_embedding_effects` | Settles stale queued and failed embedding effects of committed writes, which block receipt compaction and activation: `reconciled` when current vectors pass the effect verifier, `superseded` when the page was deleted or a newer revision owns its own effect, `retry_queued` for the owner (paid; a used-up retry allowance gets one new bounded cycle per explicit apply). See [stale queued embedding effects](#stale-queued-embedding-effects). | `blocked` effects, counted by reason (`owner_unavailable`, `embedding_disabled`, `embedding_unconfigured`, `projection_pending`, `no_replacement_obligation`). |
| `attribution-backfill` | none | Fills write attribution (who wrote it) on pages, page versions and facts written before attribution was recorded, only where exactly one committed request in the write journal proves the writer: the page write whose recorded result is the row's revision, or the `remember` that inserted the fact. Fills NULLs only, in committed batches of 1,000 that resume after an interruption; no content, revision, page file or request ID changes. See [write attribution](../mcp/ADMIN.md#write-attribution). | `unrecorded_pages`, `unrecorded_page_versions`, `unrecorded_facts`: rows the journal cannot prove. They stay `unrecorded`; nothing is inferred. |
| `safe-chunks` | `safe_index_pending` (also `contextual_retrieval_coverage`, `details.unsealed_pages`) | Rebuilds the chunks of markdown and code pages indexed before the safe-chunk fence, which remote and MCP search withhold. It rebuilds projections only: no page write, no new page version and no request ID. Vectors whose embedding input did not change are kept; the rest are embedded unless you pass `--no-embed` or no embedding model is configured. | `code_without_source_path`: code pages with no recorded file to re-chunk. `unsupported_page_kind`: other page kinds, such as images. Their importer re-seals them. |
| `orphan-children` | `child_table_orphans` (also a `storage_corrupt` error) | Explicit-only. Deletes rows of page child tables (chunks, versions, tags, takes, raw data, timeline, links) whose page row no longer exists, and clears dangling `links.origin_page_id` and `files.page_id` references, each in one statement that rechecks the orphan condition. See [orphan children](#orphan-children). | `torn_pages`: page rows whose stored body cannot be read (torn TOAST). The preview names them; the repair never changes them. |
| `planner-stats` | `planner_stats_stale` | Runs `ANALYZE` on the hot tables (pages, links, facts, takes, content_chunks, timeline_entries) whose planner statistics are stale, so search and graph reads stop planning as slow nested loops. PGLite also resets each table's pending row count; Postgres runs each `ANALYZE` with a 60 s statement timeout and a 2 s lock timeout. No journal admission, no user data changes, brain-wide. | none |
| `contextual-mode` | `contextual_retrieval_coverage` (pages with no recorded mode) | Stamps the contextual retrieval mode on markdown pages imported without one (for example by a large `--no-embed` sync, or by a connector source on an older gbrain), exactly as a fresh import of the page would: the page, source and brain settings decide, and the per-chunk synopsis tier lands at the free title tier. It rebuilds projections only: no page write, no new page version and no request ID. A page whose stored vectors already match the stamped convention keeps them and queues no re-embedding; a page whose embedding input changes has only those vectors cleared and is re-embedded once, unless you pass `--no-embed`. | `unsealed_projection`: pages whose chunks lag their text; `gbrain embed --stale` or `safe-chunks` seals them first, and the next run stamps them. `embed_skip`: pages marked to skip embedding keep their stored vectors and are not stamped. |
| `file-drift` | `maintenance_write_drift` | Explicit-only, preview-bound. Resolves pages whose canonical file differs from the database copy (`source_changed` / `file_database_drift`) through canonical reconciliation, preferring the file or the database copy within reconcile's protections. `--all-drifted` refuses mixed drift classes unless `--class` keeps one; `--only`/`--skip` narrow by canonical file path glob. Opt-in `storage.keep_db` lets the owner host's resident consumer resolve drift under declared prefixes with the database copy. A page whose file is gone from the last commit: `--prefer database` recreates the file, `--prefer file` soft-deletes the page ([deleted canonical files](#deleted-canonical-files)). See [file drift](#file-drift). | Protected metadata, the tag union and protected takes or private fact rows, listed per page as `exceptions`; pages changed after the preview (`changed_since_preview`). |
| `ghost-pages` | `ghost_pages` | Explicit-only, preview-bound, destructive consent. Soft-deletes live pages whose canonical file is missing on the owner host (ghost pages: every write refuses `canonical_file_missing` and no sync can import a file that is not there), through `delete_page` bound to the previewed owner, path and revision. `--apply --expect <hash> --yes`. See [ghost pages](#ghost-pages). | Declared db_only and never-filed derived pages (never listed); a page whose file came back before the apply (`file_restored`); pages changed after the preview (`changed_since_preview`). |
| `receipt-compaction` | `persistence_capacity` (terminal bytes) | Explicit-only, preview-bound, destructive consent. Compacts terminal write receipts now instead of on the idle maintenance tick (#6696): the intent and error message are dropped, the outcome, error code and detail stay, and the unused reservation returns to the receipt-bytes counters. `--older-than <72h\|30d>` is floored at the configured retention unless `--force`; committed receipts only unless `--include-failures`. No admission, so it runs at a full cap. See [receipt compaction](#receipt-compaction). | `failures_kept`: failed, conflict and cancelled receipts left without `--include-failures`. Receipts of a run whose sync cursor is still open, and the newest sync receipt of each worktree, are never listed. |
| `aliases` | `dangling_aliases` (orphaned rows) | Explicit-only. Deletes free-text page aliases and slug redirects whose target page has no row at all (a page purged before purge removed its aliases, #6619, or a hard-deleted page), each target rechecked under its page lock; a coordinated maintenance write on a managed brain. A redirect from an old name of a page that still exists is never touched. See [aliases](#aliases). | `soft_deleted_target`: aliases of a soft-deleted page, kept for `gbrain restore` and removed when the page is purged. |
| `rename-identity` | `rename_identity_downgrades` | Explicit-only, preview-bound, destructive consent. For an inexact Git rename that sync split into a delete plus an add (#6729): carries the old page's identity (id, version history, timeline, links, facts, aliases) onto the new slug, imports the new file onto it as an edit and retires the provisional page; or, with `--close`, settles the pair and moves nothing. `--slug <new-slug>` (and `--from <old-slug>`) names one pair; `--apply --expect <hash> --yes`. See [rename identity](#rename-identity). | `fact_rows_collide` (a fence row of the old page the new file does not keep with the same claim); `managed_remedy_unavailable` (a carry on a managed source; `--close` is the remedy there); pages changed after the preview (`changed_since_preview`). |
| `overwritten-edits` | `sync_overwritten_db_edits` | Explicit-only, preview-bound. Restores database edits that an incremental managed sync replaced with a committed file edit and no `file_drift` hold (#6712, fixed by #6887). It restores only what the records prove: a database-only revision (its receipt published no file) archived by a managed-sync import that wrote different content, with no later revision holding the edit again. The preview diffs the live page against the edit; `--apply --expect <hash>` reverts each page to that version through a revision-bound, database-only `revert_version` and holds the committed file `file_drift` when it differs. See [overwritten edits](#overwritten-edits). | `unknown_*` findings (no persistence outcome on the writer's receipt, the import's content no longer readable, a segmented version), listed but not restored; pages that moved after the preview (`changed_since_preview`). |
| `missing-tables` | `schema_missing_tables` | Explicit-only, preview-bound. Recreates, empty, a rebuildable cache table (`query_cache`, `code_traversal_cache`) that the applied migrations created but the brain no longer has, on a brain whose schema version already covers its creating migration, so `apply-migrations` never recreates it (#6911). DDL only (`IF NOT EXISTS`), no journal admission, brain-wide. See [missing tables](#missing-tables). | `user_data_tables`: a missing table that holds user data; this repair never recreates it, so restore its rows from a backup first. `other_tables`: a missing table that holds no user data; `gbrain init --migrate-only` recreates it if the base schema defines it. |
| `url-clone-fences` | none (`gbrain sync --source <id>` stops at the pull with `pull_blocked_local_changes`) | Explicit-only, preview-bound, destructive consent. Clears the `## Facts` fence rows an older gbrain appended to files of a clone it owns (`gbrain sources add --url`), which block every `git pull --ff-only` that touches those files (#6946). The preview proves each changed file differs from HEAD only by appended fence rows; `--apply --expect <hash> --yes` backs each file up, keeps its rows database-only and restores the file from HEAD. Unmanaged brains only. See [URL clone fences](#url-clone-fences). | `non_fence_edit`, `unparsed_fence`, `staged_change`, `deleted`, `not_in_head`, `unreadable_checkout`: a file with any other difference from HEAD, named with why; files that changed after the preview (`changed_since_preview`). |

Timeline rows that an earlier version of a page produced and its current text
no longer has are removals, not history, so `timeline` neither counts nor
restores them. Doctor reports those as `timeline_orphans`; preview their
removal with `gbrain extract timeline --prune-orphans --dry-run`, then run it
without `--dry-run`.

A timeline repair can make pages gain marked bullets. That is the fix: the
history is now visible in the page and survives later edits. Deleting a marked
bullet in a save that passes the current `expected_revision` deletes its entry.

<a id="connector-checkpoints"></a>
### Connector checkpoints and the upgrade to v0.60.11.0

Managed Google and GitHub connector checkpoints are keyed on the parsed
connector settings minus credential-delivery fields, so the per-cycle
`last_source_cycle_at` stamp does not make a run start over. On an upgrade
across v0.60.11.0, the migration copies each connector source's newest
committed checkpoint to the current key. A source whose newest checkpoint receipt was
compacted re-walks its window once; unchanged pages are not admitted again.

**Say to your agent:** *"Did my Gmail connector stop re-importing everything
every hour?"* The agent runs `gbrain sources status --json` and reads the
connector block below.

`gbrain sources status --json` adds a `connector` object to each Google or
GitHub source:

```json
"connector": {
  "upgrade_recovery": "resumed",
  "resumed_from": "2026-09-28 17:04:11.52+00",
  "account_pinned": true,
  "continuity_unverified": true,
  "pending": 0,
  "last_run": { "page_admissions": 0, "skipped_unchanged": 412, "pending": 0, "checkpoint_admissions": 1,
                "stopped_on_wait_budget": false, "dropped_upstream": 0, "finished_at": "2026-09-29T21:00:03.114Z" }
}
```

- `upgrade_recovery`: `resumed` (the migration copied a pre-upgrade checkpoint
  from `resumed_from`), `rewalking_once` (until the first post-upgrade run
  finishes) or `none`. Content selection since `resumed_from` is unverified;
  if you changed a content setting since then, re-walk once with
  `gbrain sync --source <id> --reset-checkpoint`.
- `account_pinned` / `continuity_unverified`: the account the credential
  resolved to is pinned on the first run. A migrated source is pinned on its
  first post-upgrade run, so continuity before the upgrade is unverified. The
  account itself is never printed here.
- `last_run`: page admissions, unchanged pages skipped without an admission,
  writes still pending, checkpoint admissions, whether the 30-second wait
  budget stopped the run, and items dropped because they were deleted
  upstream. A quiet source shows `page_admissions: 0`; a provider whose
  cursor changes every run (Calendar sync token, Gmail history id) shows one
  checkpoint admission per run.

`gbrain sync --source <id> --reset-checkpoint` discards that connector
source's checkpoint, including Google backfill state, after resolving its
pending writes, and re-walks the configured window once. Existing pages stay,
unchanged ones take no admission, and the account pin is kept. It refuses on a
Git-backed source and while the account differs
([`connector_account_changed`](write-refusals.md#connector-account-changed)).

<a id="request-indexes"></a>
### Request-table indexes

A managed sync checkpoint checks that every page receipt of its run
committed. Two indexes serve that check, `persistence_requests_sync_run_open`
and `persistence_requests_sync_run_committed`, so it stays inside the
coordinator's 5-second statement timeout on a large `persistence_requests`
table. On Postgres, migration 179
builds them `CONCURRENTLY` after the upgrade; while it runs it prints
`building <index> on ~N rows; this can take minutes; it is safe to leave
running`. If the check still times out, the checkpoint fails with
[`checkpoint_validation_timeout`](write-refusals.md#checkpoint-validation-timeout)
and is not retried ahead of other writes.

**Say to your agent:** *"My sync says checkpoint_validation_timeout. What do I run?"*

`gbrain doctor` reports `persistence_request_indexes`: ok when every request-table
index is valid, a warning with progress while one is still building (leave it
running), and a warning naming `gbrain repair request-indexes --apply` when one
is missing or INVALID. After the rebuild, run the retry the refusal printed
(`gbrain sync --source <source> --no-pull` plus the saved
processing flags).

The same command builds `persistence_requests_slug_intent` (the page purge's
lookup) and `persistence_requests_request_id`, which dream synthesis uses to
find each child's committed page. When that lookup, or a postprocess request
read, still hits the statement timeout, the synthesis pass is deferred rather
than failed: the phase warns `postprocessing deferred`, the pages stay
unstamped, and the next pass finishes them without another synthesis call. After
three deferred passes in a row the doctor check names the source, the read, how
long it ran and the pending outputs. It names the rebuild only when an index is
missing or INVALID; otherwise compare the elapsed time with
`persistence_session_timeouts`.

**Say to your agent:** *"Dream keeps saying postprocessing deferred. What's wrong?"*

<a id="missing-tables"></a>
### Missing tables

The schema version records which migrations ran, not which tables still
exist. A table dropped after its migration ran stays missing:
`gbrain apply-migrations` sees nothing to do and `gbrain db-repair` checks the
connection, not the tables. How the #6911 brain lost its `query_cache` is not
known; a manual drop, a restore that skipped the table, or a pooler that
swallowed the DDL are possibilities. When that table is `query_cache`, every
coordinated page purge used to fail with `42P01`, so the dream cycle's purge
phase failed every night with `managed_purge_failed` (#6911).

The page purge now skips a missing rebuildable cache (`query_cache`,
`code_traversal_cache`): there is nothing in it a rebuild cannot regenerate.
The purge receipt lists it under `purge.missing_caches`, and the store report
shows `query_cache` as `not_present` with reason `table_missing`. The fact
purge skips it the same way. A missing table that holds user data (facts,
takes, notices and the like) still fails the purge, because the purge cannot
honestly say it removed rows from it.

`gbrain doctor` reports `schema_missing_tables`. At head it checks every table
a fully migrated brain has on this engine; below head it checks the rebuildable
caches whose creating migration already ran, because a pending migration that
alters a missing cache fails with `42P01` and `apply-migrations` cannot finish.
A missing rebuildable cache warns with the repair below. A missing table that
holds user data fails. Any other missing table (locks, leases, operational
state) warns: `gbrain init --migrate-only` recreates the ones the base schema
defines.

**Say to your agent:** *"Doctor says query_cache is missing. Fix it."*

```bash
gbrain repair missing-tables                        # read-only: the tables it would recreate empty, and a hash
gbrain repair missing-tables --apply --expect <preview-hash>
```

The apply recreates each previewed cache table empty, in the shape a fully
migrated brain has, in one transaction per table, then checks it exists. Every
statement is `IF NOT EXISTS` and waits for locks only as long as a migration
does. A table that exists by the time the apply reaches it is left alone
(`already_present`). The approval is used once: the last table retires it, so
a later drop needs a fresh preview. The cache refills as searches run. If the
database role gbrain connects as may not create tables (an owner/app role
split), the apply refuses with `schema_owner_required`, creates nothing and
keeps the approval: run the same apply command connected as the role that owns
the schema. If the brain schema is newer than this gbrain client, upgrade
gbrain first; the repair refuses rather than build an older table shape.

Purges that failed on the missing cache before this fix may have been parked
after five failures, and the nightly purge skips parked pages. After the
upgrade, preview them with `gbrain pages purge-deleted --retry-parked
--dry-run` and run it without `--dry-run` after the user agrees; doctor
`purge_parked_pages` lists them.

A missing table that holds user data is listed under `user_data_tables`; this
repair never recreates it, because an empty table would hide that its rows are
gone. Restore its rows from your own database backup (a `pg_dump` of the brain,
or your host's point-in-time recovery) **before** you run `gbrain upgrade`,
`gbrain apply-migrations` or `gbrain init --migrate-only`: those replay the base
schema, recreate a base-schema table empty and clear this check while the rows
stay lost. `gbrain backup restore` restores a whole brain into a new root, not
one table.

The repair runs only when named and never on upgrade, `apply-migrations`,
`db-repair` or the maintenance cycle.

<a id="request-growth"></a>
### Request-table growth

`gbrain doctor` reports `persistence_request_growth`: the number of rows in
`persistence_requests` (an estimate on Postgres), each writer's admission rate
over the last 7 days, its lifetime request IDs against
`persistence.limits.*`, and the date admission would refuse at that rate. It
warns when that date is less than 90 days away and prints the exact
`gbrain config set persistence.limits.<limit> <value>` line (sized for about
one more year, the same value `persistence_capacity` prints) and the check to
re-run. Request IDs are permanent, so raising the limit is the intervention;
nothing is evicted.

<a id="receipt-compaction"></a>
### Receipt compaction

A brain whose receipt-bytes cap is close (doctor `persistence_capacity`, a
`write_quota_exhausted` refusal with reason `terminal_bytes`) gets bytes back
by compacting terminal receipts, which the resident consumer otherwise does
on idle ticks once a receipt is older than `persistence.receipt_retention_days`
(default 30). The repair runs the same per-receipt compaction on demand:

```bash
gbrain repair receipt-compaction --json                     # preview at the retention floor
gbrain repair receipt-compaction --apply --expect <hash> --yes
```

- `--older-than <72h|30d>` sets the age; it may not be younger than the
  configured retention unless `--force` (a younger receipt is how a caller
  replays its request id in full). With retention 90 days, `--older-than 30d`
  is refused and the refusal's fix is the preview at `90d`.
- Committed receipts only, unless `--include-failures` (a failed receipt's
  error message is what `gbrain write-request` shows; the code and detail stay).
- A receipt of a run whose managed-sync cursor is still open, and the newest
  committed sync receipt of each worktree, are never compacted: a resumed run
  finds what it committed through them.
- The preview binds an absolute cutoff and the newest request it saw; the apply
  compacts only receipts of that set, each in its own short transaction
  (counters locked first, `lock_timeout` 2 s, `statement_timeout` 15 s), and a
  rerun of the same apply resumes after an interruption.
- No admission and no receipt of its own, so it runs at a full cap and its
  preview charges nothing. Brain-wide.

Verify with `gbrain doctor --only persistence_capacity --json`: the
`terminal_bytes` row drops by the bytes the apply freed.

<a id="projection-drain"></a>
### Drain queued text projections

After an upgrade that re-queues text projections (for example the 0.51
protocol activation, which also queued every image page), search and code
results stay incomplete until every queued page is sealed. Every queued row
falls in exactly one class, and doctor `text_projection_readiness` counts each
one (counts only, never page names):

| Class | What it is | What seals it |
| --- | --- | --- |
| `pending` | Markdown and code pages (segmented pages included); `failed` counts those whose last rebuild failed | the resident owner, or `gbrain projections drain` |
| `sealable` | image pages the importer already attested: written at or after the safe-chunk fence, one image chunk whose text is the page's own, revision unchanged since (`sealable_with_visual` have a visual vector) | only `gbrain projections drain`: keyless, no provider call, no file read, no re-embedding |
| `reimport` | every other image page (pre-fence, several chunks, edited since); `ocr_required` counts the ones whose OCR once held protected content, which the importer seals only after a successful fresh OCR pass (`GBRAIN_EMBEDDING_IMAGE_OCR=true`) | the importer: `gbrain embed --stale --images` (paid: OCR and one multimodal embedding per image) |
| `protected` | image pages whose text holds a protected fence | nothing: unsealed and out of search by design |
| `archived` | pages of an archived source | restoring the source |

Doctor warns while `pending`, `sealable` or `reimport` is above 0, and its fix
asks the user before a drain that seals images (`gbrain projections drain
--limit <n>`, `<n>` sized to finish well inside an agent's tool limit) or
before the paid importer sweep. With only `protected` and `archived` rows left
it reports ok (info), and search marks its results `projection_by_design`
instead of `projection_pending`.

The resident owner (`gbrain serve` or autopilot) drains `pending` rows on
its own: each pass rebuilds up to 100 pages and starts no new page after
250 ms, and takes 2 pages while writes are waiting. A page whose rebuild fails
is retried after 30 seconds. Each pass reads at most 500 queue rows: the 100
newest (so a fresh edit behind a large image queue is reached at once) and 400
from a cursor that walks the queue in key order and wraps, so every row is
reached within one lap. The resident never seals images.

Pages stored in segments are drained first, one build each; a page another
gbrain process is building (its claim renewed within the last 60 seconds) is
left to that process. This is how a brain with no resident (CLI only, or
driven by cron) makes a large new page searchable after its post-commit build
died.

To drain now:

```bash
gbrain projections drain            # until every page queued at the start was tried once
gbrain projections drain --limit 5000
gbrain projections drain --json     # {rebuilt, superseded, failed: [{source_id, slug, reason}], remaining, limited, sealed, sealed_with_visual, sealed_text_only, statistics_refreshed, remaining_by_class}
gbrain projections drain --dry-run  # change nothing: every class count and the rows a drain takes, oldest first
```

`--dry-run` is the preview: it reads the queue only, prints every class count
and the rows a drain with the same `--limit` (default 50) would take, oldest
first, each with its queue reason (`rebuild_failed` for a row whose last
rebuild failed); `--json` gives the class counts and `rows`. The drain
rebuilds the `pending` rows first, then seals the `sealable` images in place:
it rechecks each page's class under its page lock, writes no chunk and leaves
the visual vector as it is, so image search ranks the page again at once. A
`sealed_text_only` page (imported with `--no-embed`) gets its visual vector
from `gbrain embed --stale --images`. `reimport`, `protected` and `archived`
rows stay queued; the summary lists them with their next step and never says
the backlog is empty while any remain. After a drain that sealed images, the
planner statistics of the projection columns are refreshed
(`statistics_refreshed`).

<a id="embed-backfill-stalled"></a>
**An automatic embed-backfill that keeps failing the same way.** A page whose
projection cannot be rebuilt (`rebuild_failed`) leaves its chunks
unembeddable, so every automatic `embed-backfill` for that source ends
`incomplete; N chunks remain and M projections are blocked` with nothing
embedded. After the first such failure the next automatic submission waits
twice the cooldown (20, then 40 minutes); after three identical failures
automatic submission stops for that source, and a retry inside one job that
finds the same blockers dead-letters instead of running again. Doctor
`embed_backfill_stalled` names the blocked pages, their page kind and queue
reason. Preview with `gbrain projections drain --dry-run`, then run
`gbrain projections drain`: it retries each queued Markdown or code page in the
foreground and prints why a page still fails and its next step, and seals the
`sealable` image pages. Other image pages are rebuilt only by their importer
(`gbrain embed --stale --images --dry-run --source <id>` previews them, then
the paid run; `gbrain sync --full --source <id>` also works). Embedding
recovery never queues or re-stamps image rows, so an image row keeps its queue
reason. Automatic backfill resumes by
itself once the blocked pages or the stale chunks change, or a run embeds
anything; `gbrain embed --stale --source <id>` and
`gbrain jobs submit embed-backfill` are never held back.

| Exit | Meaning |
| --- | --- |
| 0 | Nothing tried failed. "The projection backlog is empty." appears only when `remaining` is 0. |
| 1 | Some pages failed. Each prints `failed: <source>/<slug>: <reason>` and a `next:` action; the pages stay queued. |
| 2 | Did not run: bad usage (`invalid_params`), or [`projection_owner_resident`](#projection-owner-resident). |

On Postgres the drain is safe while `gbrain serve` runs: each page is rebuilt
under its page lock with a revision recheck, so a page is rebuilt once whichever
process gets there first. On PGLite a resident process holds the datastore, so
the drain refuses before opening it (also for a mounted PGLite brain selected
with `--brain`).

A queue row that no longer matches its live page (a legacy or hand-edited
row, or a page recreated under a new source incarnation) is healed under the
page lock instead of being counted again: a stale-revision row is re-keyed to
the page's current revision and rebuilt in the same pass, a row for a page
that is already projected or for a dead incarnation is deleted (`superseded`
in the summary), and only the exact row the drain listed is touched, so a
newer row the page trigger queued meanwhile survives. A page whose content
changes while it is being rebuilt is listed once under `failed` with a
`revision_conflict:` reason, stays queued at its new revision, and is
rebuilt on the next run. The drain continues while a pass rebuilt, removed,
failed or deferred a row and stops on a pass that did nothing.

Verify: `gbrain doctor --only text_projection_readiness --json` shows
`pending`, `sealable` and `reimport` at 0 (status ok).

<a id="embedding-key-source"></a>
### Provider key source

An exported provider key (for example `OPENAI_API_KEY`) wins over the matching
config key (`openai_api_key` in `~/.gbrain/config.json`). When both are
set and differ, every gbrain command except `gbrain hook` prints one warning
per process naming the variable, the config key and which one is in effect.
No key or part of one is ever printed.

- To use the config key: remove the variable from the environment of the
  process that printed the warning (shell profile, `~/.gbrain/.env`, or for a
  daemon its service definition) and restart that process.
- If the environment key is intended: `gbrain config unset openai_api_key`
  (or the matching key), which also stops the warning.

Doctor `embedding_key_source` reports the same plus where the embedding key in
effect comes from. It sees only the environment `gbrain doctor` runs in: a
daemon has its own and reports a mismatch in its log, with the startup warning
or `embedding_auth_failed` on the first rejected embedding
([write refusals](write-refusals.md#embedding_auth_failed)). After fixing a
rejected key, `gbrain embed --stale` embeds what was saved meanwhile.

<a id="connector-held-items"></a>
### Connector held items

The doctor check `connector_held_items` counts Google and GitHub items held
after three consecutive failed syncs. It is not a repair kind: fix the cause
the item's error code names, then re-attempt. See
[held items](google-connect.md#held-items) for the rules.

<a id="repair-connector-symptoms"></a>

**Who acts** and **Consent** follow the [troubleshooting legend](troubleshooting.md#symptom-table): Preview and Verify are read-only; run Apply only once the named actor has it and the user agreed to the listed effects.

| Symptom | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- |
| `connector_held_items` warns, or `gbrain waiting` says coverage is partial | `gbrain sources status <source>` | `gbrain sources retry-held <source>`, then `gbrain sync --source <source>` | `gbrain sources status <source>` (a recovered item leaves the list) | agent, after the user agrees | `egress` (fetches from the provider again) |
| A sync fails with `connector_holds_exhausted` | `gbrain sources status <source> --json` | Fix the cause, then `gbrain sources retry-held <source>` and `gbrain sync --source <source>` | `gbrain doctor` | agent, after the user agrees | `egress` |
| A sync refuses with `connector_fence_below_timeline` | `gbrain repair connector-fences --source <source>` | `gbrain repair connector-fences --source <source> --apply`, then `gbrain sources retry-held <source>` | `gbrain sync --source <source>` succeeds | brain host, after the user agrees | `egress` |

<a id="take-supersession"></a>
### Take supersession

**Say to your agent:** *"My superseded takes don't point at the take that
replaced them. Repair the supersession chains."*

Takes superseded before the pointer moved onto the old fence row have
`superseded_by` empty: the old row was struck without a pointer, and the new
row often cites itself (`superseded by #<its own row>`). Preview, then apply
after you agree:

```bash
gbrain repair take-supersession            # per page: each link, its evidence, ambiguous pages
gbrain repair take-supersession --json     # details.pages[] and details.ambiguous[]
gbrain repair take-supersession --apply    # writes the pointers; a second apply changes nothing
```

The repair links a struck row to its replacement only from evidence, in this
order: a committed `takes_supersede` receipt for the page, a stored
`superseded_by`, then a self-pointer row that has exactly one struck, unlinked
row above it (resolved hop by hop, so a chain of supersessions resolves). It
never guesses. When a new row has two or more possible predecessors, the page
is listed under `ambiguous` with the candidates and left unchanged. Fix it by
hand: read the page (`gbrain get --source <source> -- <slug>`), append
`; superseded by #<new row>` to the source cell of the row each new row
replaced, save it with the current `expected_revision`, then run the repair
again; it drops the leftover self-pointers and stores the pointers.

<a id="accepted-takes"></a>
### Accepted takes

**Say to your agent:** *"I accepted held take changes on v0.60.253.0. Check whether any take was removed and restore it."*

On v0.60.253.0, accepting a held change to a take you had confirmed
(`gbrain trust confirm tp<id>`, or `gbrain trust review --accept-all`) removed
the take when the change kept its claim: an agent struck it through
(`~~claim~~`) or changed its kind or holder. The take left the page's takes
fence and the takes index; the accept should have applied the change instead.
A later sync or publish cannot bring it back, because the page no longer
carries the row. A take with a grade in its fence was safe: the removal
refused it.

Preview, then apply after you agree:

```bash
gbrain repair accepted-takes                     # each removed take, its proposal and the page version it comes from
gbrain repair accepted-takes --json              # listing[] and residuals
gbrain repair accepted-takes --apply --expect <preview-hash>
```

A take is listed only when every record agrees: the accepted proposal (a strike
or same-claim change, filed by a page publish or reconcile), the committed
`takes_remove` receipt bound to it, the page version that removal archived
(whose fence holds the row at that number) and the reservation row the removal
left in the live fence. The apply puts that fence row back in place of the
reservation through a revision-bound `put_page`, at the tier of the write you
accepted, which is what a correct accept leaves. Not restored, because no
record holds it: a grade or resolution stored only in the database, the take's
id (the row gets a new one) and its embedding (re-embedded). A second preview
lists nothing.

<a id="overwritten-edits"></a>
### Overwritten database edits

**Say to your agent:** *"Check whether sync overwrote any of my database edits and show me what it would restore."*

Before #6887, an ordinary incremental `gbrain sync` on a managed
brain could publish a committed file edit over a page that was also edited in
the database since its last import (for example a `put_page` with
`sync.write_through` off). It wrote no `file_drift` hold and no backup. The database edit is still in
the page's history: the import archived it as a page version. Doctor
`sync_overwritten_db_edits` counts the pages per source and names the first ones.

Preview, show the user both versions, then apply after they agree:

```bash
gbrain repair overwritten-edits --source <id>                  # each page, the edit's version, who wrote it, the import that replaced it, a diff
gbrain repair overwritten-edits --source <id> --slug notes/a   # one page
gbrain repair overwritten-edits --source <id> --apply --expect <preview-hash>
```

A page is listed only when the records prove it: the archived revision's writer
is a committed request whose receipt published no file (`persistence.mode`
`database`, no Git effect for that revision, not a read-only mirror write), the
request that archived it is a managed-sync import (also after receipt
compaction, from its operation and outcome), the import wrote different content,
and no later revision of the page holds the edit again. Findings the records
cannot prove are listed `unknown` with the reason and never restored: the
writer's receipt has no `persistence` outcome, the import's own content is no
longer readable, or a version is segmented. A revision with no recorded writer
(written before write attribution, by a classic sync, or by unattributed
maintenance) is not reported, because it looks exactly like ordinary sync
history.

The apply reverts each page to the archived version through `revert_version`,
bound to the page revision the preview saw, so a page that moved since is
`changed_since_preview` and nothing is written. An apply interrupted after a
restore committed replays that restore's request on the next run and then
writes the hold, instead of reporting the page as moved. The restore
publishes to the database only and never rewrites the committed file.

Only the host that owns the source's checkout compares that file with the
restored page. There, a file that differs is held `file_drift` (outcome
`restored_file_held`), so no later sync publishes it over the edit; pick the
winner with [`gbrain repair file-drift`](#file-drift). On any other host the
restore still applies, but the file is neither compared nor held: the outcome
is `restored_file_unheld` (`why=checkout_not_on_this_host`; the same outcome
with `why=file_over_read_bound` means the owner host could not read a file
that large). A later sync that imports a change to that file can then publish
it over the restored edit again. No command writes only the hold afterward,
and the restored page is not listed again, so run the apply on the owner host.
After a restore on another host, resolve the page on the owner host so the
file holds the restored edit:

```bash
gbrain repair file-drift --source <id> --slug <slug> --prefer database                          # preview
gbrain repair file-drift --source <id> --slug <slug> --prefer database --apply --expect <preview-hash>
```

A restored page is not listed again.

<a id="orphan-bindings"></a>
### Orphan persistence bindings

**Say to your agent:** *"I removed a source and added it back, and now sync
says it needs a coordinator. Fix it."*

Removing a source also removes that source's persistence binding, and the
claim check counts only a binding of the source's current incarnation. A
binding left behind by an older gbrain is reported by doctor's
`orphan_persistence_bindings` check. Preview, then apply after you agree:

```bash
gbrain repair orphan-bindings            # lists each binding and why it is orphaned
gbrain repair orphan-bindings --apply    # deletes them
gbrain doctor                            # orphan_persistence_bindings is ok
```

Do not delete binding rows by hand: the repair rechecks, in the same
statement, that the binding is still orphaned and that no pending write
request uses it.

### Managed sync orphans

<a id="managed-sync-orphans"></a>

**Say to your agent:** *"doctor has reported the same two sync failures for a
week, every sync ends up to date, and rerunning the sync changes nothing."*

A managed sync run keeps its cursor under a key derived from the source
incarnation, the writer principal and the sync options. A cursor written under
an older key, by a writer identity that no longer exists (a `legacy_token`
principal before the local-CLI cutover, a revoked local writer), can never be
resumed: the live writer reads only its own key. Doctor still reads every
unfinished cursor, so `sync_failures` reports `sync_incomplete` forever, and a
`managed-sync-failure` row whose key has no cursor at all is only cleared by a
success under that same key, which never comes. A plain sync follows the
live cursor; `--skip-failed` is refused on a managed source. Nothing an
operator can run clears either.

`gbrain repair managed-sync-orphans` is the sanctioned exit. It is
explicit-only and preview-bound: the preview classifies every candidate and
prints a hash, and the apply retires exactly that set.

```bash
gbrain repair managed-sync-orphans --source default                       # preview: lists each orphan with its class
gbrain repair managed-sync-orphans --source default --apply --expect <hash>
gbrain doctor --only sync_failures                                        # the orphaned rows are gone
```

Classes in the preview:

| Class | What it is | Why nothing current can clear it |
|---|---|---|
| `no_cursor` | a `managed-sync-failure` row with no `managed-sync` cursor under its key | cleared only by a success under the same key |
| `principal_unadoptable` | an unfinished cursor recorded by a principal that is not an active local writer | the live writer never reads that key, and the pending request is invisible to it |
| `superseded` | an unfinished cursor from before sync options were recorded, with a later completed run for the same source and incarnation | its exact options are unknown, so no command resumes it |
| `incarnation_retired` | an unfinished cursor, or a failure row, recorded under a source incarnation the source no longer has (it was re-pointed at a new checkout, or removed and added again) | the cursor key digests the incarnation, so no current sync selects it, and every incarnation-joined reader (doctor's durable read, the sync retry, `--acknowledge-managed`) drops it; only the local ledger mirror still shows it. `gbrain sync status` reports it as `cursor: null` with `last_error.code: cursor_incarnation_retired` |
| `checkpoint_moved` | an unfinished cursor whose pages all committed and whose checkpoint was refused `revision_conflict` "The source checkpoint changed during this sync." because `sources.last_commit` moved to a commit that is neither the run's start nor its target (another run, or an older gbrain sharing the database, checkpointed the source elsewhere) | the checkpoint's compare-and-swap can never succeed, so every plain sync resumes the cursor into the same refusal; its slug `__managed_sync_checkpoint__` is bookkeeping, not a page, so there is nothing to read. After the apply the next sync discovers from the commit the source records. No sync retries it, because rediscovering a path-sliced run would move `last_commit` backward; the orphan repair is the only exit. A cursor whose source already stands at its target is not listed: the next plain sync finishes it. The apply keeps the cursor when the rule no longer holds |
| `slug_mode_refused` | an unfinished cursor whose checkpoint was refused `slug_root_mode_mismatch` (a source in a subdirectory of its repository pins one `slug_root_mode`, the run used the other) while the source keeps the other pin | the two modes give different slugs, so the checkpoint can never publish under the kept pin. Preview, then `--apply --expect <hash>`: the apply retires the cursor and the next sync discovers the source again under the kept pin. Setting the pin back to the run's mode instead lets the next plain sync retry the checkpoint by itself. No sync retries this one without a person's choice |
| `mirror_only` | a row of the local ledger (`~/.gbrain/sync-failures.jsonl`) carrying a `managed_cursor_key` with no durable failure row under that key in any incarnation | the mirror is pruned only after a durable delete, so one whose durable row is already gone keeps `gbrain doctor --fast` warning. The apply removes the ledger row after reading the durable rows again; a successful sync of the source prunes its own mirror-only rows too |

Kept and counted, never retired: a cursor whose pending request is still
queued, running or recovering (`pending_request_live`), and a cursor the live
writer can still resume with its recorded options (`resumable`; doctor prints
the exact `gbrain sync ...` command). An `incarnation_retired`
cursor is retired even when its recording principal is the live local writer
with recorded options: that veto is for a cursor the writer could still
resume, which no retired key can be. Rows on an archived source are never
listed, and an apply that finds the source archived meanwhile keeps them.
Retiring an old incarnation's bookkeeping says nothing about whether the
current source's files are imported; `gbrain sync status --source <id> --json`
does. Without a database connection, `gbrain doctor --fast` reports the mirror
rows it cannot verify as `warn` ("could not be verified"), never `fail`: a
better fast score there is less certainty, not recovery; `gbrain doctor --only
sync_failures` with the brain reachable is the authoritative check.
The apply rechecks every
predicate in the deleting statement and removes the cursor, its same-key
failure row and its manifest (when no other cursor shares the run) in one
transaction, so a cursor the writer picked up meanwhile is left alone. Do not
delete `op_checkpoints` rows by hand.

### Content receipt root

<a id="content-receipt-root"></a>

**Say to your agent:** *"after moving the brain's content directory to another
machine, doctor fails sync_freshness and the sync it suggests refuses with
sync_not_applicable."*

A gbrain-owned content directory (created by `gbrain init` or the 0.53.0
shared-skills migration) never syncs from Git; doctor exempts it because its
content receipt (config `shared_skills.content.v1.<source>.<incarnation>`)
names the source's root and that root's device and inode. A writer transfer
accept and `gbrain sources set-path` rebind the receipt of every moved source
(nested sources by their relative path) in their own transaction, and report it
as `content_receipts`. A receipt an older release left on the old root makes
doctor report `content_receipt_stale` with this repair as its fix.

```bash
gbrain repair content-receipt-root --source default                       # preview, on the owner host
gbrain repair content-receipt-root --source default --apply --expect <hash>
gbrain doctor --only sync_freshness                                       # the source is writer-owned again
```

Classes in the preview:

| Class | What it means | Next |
|---|---|---|
| `rebind` | The owner binding's root is the source's `local_path` and the owner's tree hashes to the worktree manifest the last transfer or rebind verified. | The apply rewrites the receipt's `root` and `root_identity`. |
| `source_path_mismatch` | The source's `local_path` still names the old root (a transfer was accepted, `set-path` not yet run). | `gbrain sources set-path <source> <owner root>`, which also rebinds the receipt. |
| `tree_mismatch` | The owner's tree no longer hashes to the recorded manifest (pages were written since), so it is not proven to be the transferred content; the detail prints both digests. | A self-transfer on the owner host (`gbrain sources writer transfer prepare <source> --self-transfer ...`, then the accept it prints) re-verifies the tree and rebinds the receipt. |
| `not_owner_host`, `root_missing` | This host does not own the checkout, or the owner's root cannot be read. | `gbrain sources writer status --source <source> --json`. |

The apply recomputes the preview and refuses `preview_changed` unless it is
unchanged, skips a receipt that changed since the preview, and keeps the
previous value under `<receipt key>.backup` (`gbrain config get <key>.backup`
prints it; restoring is `gbrain config set <key> '<previous>'`). Do not edit
the receipt by hand.

### Stuck recovery

<a id="stuck-recovery"></a>

**Say to your agent:** *"Every write to my notes source has been pending for an
hour and writer status says a request is recovering with unexpected_file_bytes.
Show me what changed and let me pick which version to keep."*

The same applies to a shared-skill bundle publication (several skill files
published together) and to a withdrawal-mirror effect (gbrain rewriting a page
file after `forget`) whose file was edited while it was being written.

A page write records its file's prior bytes before it publishes. If the
process dies mid-publication, the owner's recovery pass restores the prior
bytes or finishes the write. When the file matches neither the recorded prior
nor the published bytes (usually a hand edit made while the write was
publishing), recovery refuses to overwrite it: the request stays `recovering`
with `unexpected_file_bytes`, no write on that worktree is claimed, and the
resident writer re-checks it every 30 seconds without progress. A sync queued
behind it stops at once with
[`drain_stalled`, `cause: head_blocked`](write-refusals.md#head-blocked),
naming the file and this command. Do not delete the file to unblock it.

`gbrain repair stuck-recovery` is the sanctioned exit. Run it on the host that
owns the source.

```bash
gbrain repair stuck-recovery --source notes                    # preview: each blocked file, its diff, the choices
gbrain repair stuck-recovery --source notes --request-id <uuid>   # only one request
gbrain repair stuck-recovery --source notes --keep prior --apply --expect <hash> --yes
gbrain repair stuck-recovery --source notes --keep disk --apply --expect <hash> --yes
gbrain repair stuck-recovery --source notes --request-id <uuid> --keep withdrawn --apply --expect <hash> --yes   # a withdrawal-mirror effect
```

The preview starts from the blocker of the source's queued head and lists
every recovery record on the worktree, and every withdrawal-mirror effect
recovery whose file matches neither recorded version. For each file it prints the prior
(hash, size, mode, or `absent: prior was a create`), the bytes on disk (or
`deleted on disk`), what recovery sees, and a private diff written under
`~/.gbrain/backups/stuck-recovery/<request>/` with the exact `diff -u`
command that reproduces it. It prints only the choices available for every
listed record. The hash binds each record's identity, each file's disk bytes
and the page's database revision, so an edit or a page write after the
preview refuses the apply with `preview_changed`.

A file over the 24 MiB single-string ceiling (normal with segmented page
storage, up to `pages.max_bytes`) resolves the same way, in bounded memory.
Its write kept the prior file as a hidden staged copy beside it
(`.<sha256>.tmp.before-<uuid>`) instead of inside the recovery record. The
preview hashes the file and that copy in pieces and prints the copy's state
after the prior fingerprint: `staged copy verified`, `missing` or `does not
match its recorded SHA-256`. Both versions are backed up by copy, each
checked against its fingerprint, and the diff file is a summary instead of a
full diff (both hashes and sizes, the first byte where they differ, and a
window of at most 1 KiB around it), marked `(summary: ...)` in the preview;
its `reproduce` line is a `cmp` of the two backups. `--keep prior` renames
the verified staged copy back over the file, as the writer's own recovery
does, and the write publishes again. A missing or damaged staged copy can't
restore the prior, so the preview offers only `--keep disk`, and `--keep
prior` refuses with
[`recovery_prior_stage_unavailable`](#recovery-prior-stage-unavailable).
`--keep disk` keeps a damaged copy in the backup directory (`0.prior-stage`)
and removes it from the checkout.

The choice is the user's: there is no default `--keep`, the kind never runs
from `--all`, `gbrain doctor --remediate` or a remediation step, and a
non-interactive apply without `--yes` exits 3 with the consent payload and
changes nothing. The backups never authorize an apply by themselves.

What a choice does depends on the request's state:

| Request state | `--keep prior` | `--keep disk` (#6640's `drop`) |
|---|---|---|
| Live (`recovering`), no recorded failure: the publication was interrupted and its database transaction never committed | Backs up both versions, writes the recorded prior bytes back through the writer's own durable, confined publication (staged at the record's reserved restoration path; an absent prior unlinks the file); recovery then requeues the request and the accepted write publishes again on the next pass. | Backs up both versions and ends the request `conflict` with `source_changed` instead of requeueing a write that would conflict again; recovery then only cleans its staging and clears the record, releasing the recovery bytes it reserved. The record itself is never rewritten. |
| Live with a recorded failure (`publication_failed`) | Prior bytes back; the request ends `failed` or `conflict` with that failure. | Disk bytes kept; the request ends with that failure. |
| Terminal (`committed`, `failed`, `conflict`, `cancelled`) with its recovery record still set | Refused (`recovery_choice_refused`): recovery never restores a terminal request's file, so this would roll back committed bytes. | Refused (`recovery_choice_refused`): a terminal outcome is immutable and there is no publication to abandon. |

A shared-skill bundle record is listed with every file of the bundle, each
with both fingerprints, and either choice applies to the whole bundle: every
file is backed up first, then `--keep prior` writes the prior bytes of the
edited files back and recovery restores the rest (the publication requeues, or
ends with its recorded failure), and `--keep disk` keeps every file as it is on
disk and abandons the publication. After `--keep disk` the shared-skill records
keep the version from before the publication; publish the skill again if the
files on disk should become its new version.

A withdrawal-mirror effect has one choice, `--keep withdrawn`. The withdrawal
is already committed, so keeping the edited file (or the bytes from before the
withdrawal) would leave the forgotten fact on disk, and the next sync would
import it again; `--keep disk` and `--keep prior` are refused
(`recovery_choice_refused`) before anything runs. The preview lists the file,
its bytes from before the withdrawal, the withdrawn bytes the mirror recorded
and the bytes on disk, with a diff of the withdrawn and disk bytes. The apply
backs the edited file up (`0.disk` beside `0.withdrawn` and the diff), writes
the withdrawn bytes through the mirror's own staged publication, and finishes
the effect forward, so the writes queued behind it resume. Commit the file
before the next sync, and make any other change from the edit again from the
backup, leaving the forgotten fact out. A record without usable withdrawn
bytes is listed as refused ([`recovery_effect_unsupported`](#recovery-effect-unsupported)).

The preview lists a terminal request as `refused` with the reason and offers
no choice for it. After `--keep disk` the database page still holds the
content from before the write, so the page shows as file/database drift until
you reconcile it: `gbrain sources reconcile <source> <slug> --brain host
--preview`. The command never reports the page as repaired.

The apply runs under the worktree lock, so the resident recovery pass cannot
interleave. Each step is journaled (`op_checkpoints`, op
`stuck-recovery-resolution`): a run killed at any point resumes with the same
command, and a resident writer of any version can finish a resolution this
command started, because the recovery rule it uses is unchanged. Running the
same apply again after it finished replays the recorded result; the same hash
with the other `--keep` refuses `idempotency_conflict`. The finished journal
row is the resolution's audit entry and does not expire; the request's own
receipt is never rewritten by this command (`--keep disk` completes the live
request; it never changes a terminal one). A bundle record this binary cannot
read is listed as refused with
[`recovery_bundle_unsupported`](#recovery-bundle-unsupported), and an effect
record without usable withdrawn bytes with
[`recovery_effect_unsupported`](#recovery-effect-unsupported). The apply waits
at most 10 seconds for the worktree lock, then refuses `writer_lock_unavailable`
with nothing changed; `--keep prior` on a record that predates reserved staging
first reserves it and refuses `queue_capacity` when the recovery budget is full,
also with nothing changed.
#6640's `drop` (abandon the blocked publication and keep the disk bytes) is
`--keep disk` on a live request; there is no separate flag.

### Frontmatter keys

<a id="frontmatter-keys"></a>

**Say to your agent:** *"doctor reports `stale_frontmatter_keys` on tens of
thousands of pages. Is anything broken, and what does the sweep change?"*

Imports before mid-2026 could store the parser's four reserved keys (`type`,
`title`, `tags`, `slug`) inside `pages.frontmatter`. A file never carries them
there (the parser lifts them into page columns), so for those rows the
canonical file and the database copy never compared equal, and every
coordinated write was refused `source_changed` (#6454). Since v0.60.176.0 the
comparison and the render skip those four top-level keys on both sides, so
the refusals stop on their own and the stored keys are inert: nothing is
broken. Refused writes whose receipt is retained replay with
[`gbrain repair failed-writes`](#failed-writes).

`gbrain repair frontmatter-keys` removes the inert keys from the rows. It is
explicit-only and preview-bound; the preview says how many pages carry which
keys and prints a hash, and the apply sweeps exactly that set in source-scoped
batches of up to 1,000 pages, each a coordinated maintenance write under the
pages' key locks (a bare `UPDATE pages` is refused by the managed writer
guard). Database rows only: no file, body, tag or embedding change, no journal
admission. The one visible effect is the revision: the database advances
`knowledge_revision` on any frontmatter change, so every swept page gets a
new revision once and a client that saved an older `expected_revision` gets
one `revision_conflict` on its next write and re-reads.

```bash
gbrain doctor --only stale_frontmatter_keys                   # count per source
gbrain repair frontmatter-keys --source default               # preview: pages and keys, prints the hash
gbrain repair frontmatter-keys --source default --apply --expect <hash>
gbrain doctor --only stale_frontmatter_keys                   # ok
```

A page whose keys a write cleared between preview and apply is counted
`already_clean`. Nested user keys with the same names (`metadata.title`) are
never touched; only the four top-level keys are.

### Aliases

<a id="aliases"></a>
Doctor `dangling_aliases` counts alias rows whose target page is gone. Two
kinds are reported apart:

- **Orphaned:** the target slug has no page row at all, usually a page purged
  before purge removed its aliases (#6619). A free-text alias can still resolve
  a name to that missing page. Preview per source, then apply:

  ```bash
  gbrain repair aliases --source <id>
  gbrain repair aliases --source <id> --apply
  ```

  The apply deletes `page_aliases` rows whose `slug` is the missing page and
  `slug_aliases` rows whose `canonical_slug` is the missing page. A redirect
  whose old name happens to be the missing slug but points at a live page (a
  rename) is kept.
- **Soft-deleted target:** the page is in its restore window. Its aliases are
  kept so `gbrain restore` brings them back; purging the page removes them.
  Nothing needs running.

Both alias tables carry the managed writer guard, so deleting rows with raw SQL
fails on a managed brain; use the repair.

### Orphan children

**Say to your agent:** *"gbrain fails with `unexpected chunk number` or
`tuple concurrently deleted`, or doctor warns `child_table_orphans`. Fix it."*

These errors (SQLSTATE XX000) mean stored data is damaged, usually after a
crash or a full disk. Child rows can outlive their page row, and a page body
can be torn, so every command that reads it fails. Preview first; it changes
nothing:

```bash
gbrain repair orphan-children            # orphan child rows per table, plus torn_pages
gbrain repair orphan-children --apply    # deletes the orphan rows, clears dangling references
gbrain doctor                            # child_table_orphans is ok
```

The preview also reads every page body and lists the rows it cannot read
(`torn_pages`, with page id, source and slug). The repair never changes those
rows. Recover them from a backup, or create a fresh brain and sync it again
from its source files. Until then, a write that names the revision of a page
the upgrade could not backfill is refused with `revision_backfill_pending`;
doctor's `revision_backfill` check names those pages, and
`gbrain apply-migrations --force-schema` resumes the backfill for the rest and
prints its progress.

<a id="timeline-comments"></a>
### Timeline comments

Earlier releases filed an HTML comment next to a `[Source: ..., YYYY-MM-DD]`
citation (such as `<!-- AUTO:slack END -->`) as a timeline row and wrote it
back into the page. The parser now skips comments, and a row still carrying
`<!--` or `-->` is never written back (`timeline_comment_markup`). This
explicit-only kind cleans what is already stored.

**Say to your agent:** *"Preview the timeline comment cleanup, tell me how many
rows and pages it touches, then apply after I agree."*

```bash
gbrain repair timeline-comments --source <id>          # preview: comment_only_rows, comment_bearing_rows, pages_with_comment_bullets
gbrain repair timeline-comments --source <id> --apply  # clean them
```

It drops generated bullets that carry markup (yours are left alone), deletes
markup-only rows and strips the rest, under the page lock. A second apply finds
nothing, and a timeline-only rewrite queues no facts extraction.

### Timeline history scan coverage

Doctor's `timeline_history` check classifies at most 2,000 pages or 10
seconds of work per run. On a larger brain each run continues where the last
one stopped (the cursor is kept in the config row
`doctor.timeline_history.scan:<sources>`), so a few consecutive `gbrain doctor`
runs finish a full pass and report exact counts. While the next pass is in
progress, a clean finished pass keeps the check `ok` until a newer timeline row
is written. A run that has neither says `scan incomplete` and is a lower bound;
`gbrain repair timeline` (preview) counts the whole brain in one go.

<a id="ghost-pages"></a>
### Ghost pages

A ghost page is a live page whose canonical file is gone on the source's owner
host: the file was moved or deleted outside gbrain and the deletion was never
imported. Every write to it refuses `source_changed` with reason
`canonical_file_missing` ([write refusals](write-refusals.md#canonical_file_missing)),
and no sync can import a file that is not there, so retrying never clears it.
Doctor `ghost_pages` counts them on the owner host (off it, or on a brain with
no source checkout, the check is `ok` and not applicable); `gbrain pages ghosts
--source <id> [--json]` lists them, read-only. A person decides, per page,
which is right:

- **Keep the page**: restore its file at the recorded canonical path on the
  owner host (from Git or a backup), then run `gbrain sync --source <id>`. Do
  not apply the repair. When the deletion is already committed (the file is
  gone from HEAD), `gbrain repair file-drift --prefer database` recreates the
  file from the page instead ([deleted canonical files](#deleted-canonical-files)).
- **Remove the page**: preview, then apply after the user agrees.

```bash
gbrain repair ghost-pages --source default        # preview: each ghost, its recorded path and revision, and a hash
gbrain repair ghost-pages --source default --apply --expect <hash> --yes
```

The preview writes nothing and prints the apply command with its hash. The
apply needs the user's consent: without `--yes` a terminal asks, and a
non-interactive run exits 3 (`ask_user`) with the consent payload and changes
nothing. It soft-deletes exactly the previewed set through `delete_page`, bound
to the canonical owner the preview ran under (host, worktree, owner epoch,
source incarnation), each page's revision and its recorded path. Each page is
checked again before its request, again in preparation, and its file at
filesystem publication: a page whose file came back is kept (`file_restored`)
and the result asks for a new preview; anything else that moved is
`changed_since_preview`. Soft-deleted pages are purged for good by the
autopilot purge phase 72 h after deletion; until then `gbrain restore <slug>
--force` undoes one page (per slug; it writes the file back).

It refuses:

- off the source's canonical owner host, [`not_owner_host`](error-codes.md#not_owner_host);
- when the checkout is missing or cannot be read reliably (a stat error, an
  invalid gbrain.yml, an inconclusive page check),
  [`ghost_storage_unknown`](error-codes.md#ghost_storage_unknown): a page is
  never removed while its file may only be unreadable;
- when the ghosts are more than half of a source's file-backed pages (on a
  source with more than 20 of them),
  [`ghost_mass_delete_refused`](error-codes.md#ghost_mass_delete_refused):
  that almost always means the wrong or an unmounted checkout. Check it first;
  if the removal is genuinely intended, ask the user and rerun the apply with
  `GBRAIN_ALLOW_MASS_RECONCILE=1`.

Declared `storage.db_only` pages, never-filed derive-phase pages, read-only
mirror pages and pages written while their source was unbound publish to the
database only and are never ghosts. Doctor `undeclared_db_only_pages` is a
separate audit. A preview lists at most 1,000 ghosts; apply them, then preview
again for the rest. Sync never removes ghost pages by itself.

<a id="ghost-pages-skill-paths"></a>
**Ghosts under the shared skillpack.** When a source has an adopted shared
skillpack, its reserved paths (`skills/` and `skillpack.json`) belong to the
shared skill publisher, and knowledge writes there refuse
`skill_bundle_required`. Two kinds of ghost can sit on those paths:

- A legacy knowledge page that no live pack skill owns (imported before the
  pack was adopted, say, under a `skills/<name>/` directory the pack does not
  publish). It is an ordinary ghost: the preview lists it with the others and
  the apply retires it as a database-only soft delete. Its file is already
  gone and filesystem publication refuses one that reappears, so no pack file
  changes.
- A page on a path the pack owns: `skillpack.json`, a file of a live skill's
  current revision, or anything under a live skill's `skills/<name>/`
  directory. Its missing file is the pack's own, so the repair never removes
  the page. The preview lists it apart with code `ghost_skill_pack_member`
  (`residuals.skill_paths`, and `details.skill_paths` with the first slugs,
  `owned_by: shared_skill_publisher` and one `restore` command per page) and
  leaves it out of the hash. To clear it, restore the file on the owner host:
  `git -C <source root> checkout -- <path>` when the file is committed, or
  republish the skill with `put_skill` and its catalog `expected_revision` so
  the publisher writes it again. The page then stops being a ghost.

Doctor `ghost_pages` and `gbrain pages ghosts` count pack-member ghosts apart
(`skill_paths`, with the same restore step), never as ghosts waiting for this
repair; on their own they leave the check `ok`.

**`refused`.** A page of the approved set that a per-page guard still refuses
during the apply (a refusal of class `caller`, such as `skill_bundle_required`
on a page an older preview approved) is recorded with outcome `refused` and its
code in `outcome_items`; nothing is written for it, and the apply goes on with
the rest of the set. Read the code (`gbrain errors <code>`) before retrying
that page. Any other error, such as a storage fault, an unavailable owner or
contention, still stops the apply; rerun the same apply command once it clears.

<a id="rename-identity"></a>
<a id="origin-twins"></a>
### Origin twins

`gbrain repair origin-twins --source <id>` (#6948) resolves duplicate-origin twins: several live pages of one source
recording the same file as their origin, which managed sync holds [`origin_conflict`](write-refusals.md#origin_conflict)
while the rest of the source syncs. It is explicit-only, preview-bound and destructive, runs only on the source's
canonical owner host (`not_owner_host` elsewhere), and refuses a remote caller.

The preview lists each group with its pages, ids, revisions and verdict, using the same rule as sync:

- **Verified duplicates** (no reason): exactly one page is the page the path names, every page holds the same inline
  body, the file is readable, no two explicit frontmatter `id`s differ, the pages share one visibility and one trust
  tier, no other page has slug-keyed fact withdrawals or purges or a file at its own slug path, and no other page holds a
  manual link, relationship date, timeline entry or raw payload that differs from the canonical page's. The apply
  merges each other page into the canonical one. Links in every role, link transitions, timeline rows, raw data,
  attachments, user-added tags, free-text aliases and facts other pages assert move to it; an exact duplicate, or a link
  re-derived from the shared body, is dropped. The twin's slug becomes an alias. The twin forgets the file, is marked
  `origin_twin` and is soft-deleted (the file is untouched), and the 72 h retention purge removes it database-only.
  Its receipt (`origin_twin_resolved`) lists every frontmatter key of the twin the canonical page lacks or holds
  differently, with the twin's value, plus the restore command. The canonical page's frontmatter comes from the file,
  so add any key you want to keep to the file.
- **A decision** (a reason): listed with the commands to decide it, never resolved by a plain apply. With
  `--slug <kept-slug>` the preview offers only to *detach* the other pages: they forget the file, are marked
  `origin_twin` and stay live as database-only pages. Nothing is deleted.

A page marked `origin_twin` never writes or removes a file again: `gbrain restore` brings back its own text as a
database-only page, an edit publishes database-only, and an owner `--purge` is refused because its content is the
canonical page's (the retention purge still removes it). A later file at its own slug path, imported by sync, clears the
marker.

The apply refuses [`origin_twin_mass_merge_refused`](error-codes.md#origin_twin_mass_merge_refused) when its merges
would soft-delete more than half of the source's file-backed pages, unless `GBRAIN_ALLOW_MASS_RECONCILE=1`.

**Sync-time heal.** After each successful managed sync, held files whose pages are still verified duplicates are merged
the same way, at most 200 files per run and 1,000 twin pages per source per 24 h, and never on a dry run, under a remote
job, with an unfinished sync cursor, or above the mass valve. `gbrain sync --json` reports it as
`origin_twins_resolved`. Opt out with `gbrain config set sync.origin_twins.auto_resolve false` (default on, like
`sync.slug_conflicts.auto_remove`).

**The index.** Migration v257 builds the partial unique index `pages_live_origin_key` (one live page per recorded
origin; `CREATE UNIQUE INDEX CONCURRENTLY` on Postgres) only when the brain has no twins. With twins the migration
changes nothing and succeeds, and doctor's `origin_twins` check reports "Index pending". Once the last group is
resolved, the repair's apply builds the index.

### Rename identity

When sync cannot confirm an inexact Git rename (#6729), it imports the pair as a
delete plus an add: the new file starts a fresh page and the old page keeps its
history, facts, links and aliases on its soft-deleted slug. The sync report,
`gbrain sync status --source <id> --json` (`identity_downgrades`) and doctor
`rename_identity_downgrades` name each open pair with its remedy, and the purge
leaves the old page alone until the pair is settled or the old page is restored
or purged. A person picks one of three routes per pair:

- **Carry the identity** (a deferred true rename): the old page id takes the
  new slug with its version history, timeline, links, facts and aliases; the
  new file is imported onto it as an edit; the provisional page is retired
  (soft-deleted under a purged slug, its history and edges moved onto the
  carried page) and the old slug redirects to the new one.
- **Close the pair**: nothing moves; the old page is purged with the next purge
  after its soft-delete window.
- **Keep both pages**: `gbrain restore <old-slug> --source-id <id> --force`.

```bash
gbrain repair rename-identity --source default                     # lists the open pairs, each with its preview command
gbrain repair rename-identity --source default --slug notes/roadmap # preview one pair (add --from <old-slug> when two pairs share it, --close to close)
gbrain repair rename-identity --source default --slug notes/roadmap --apply --expect <hash> --yes
```

The preview writes nothing; it binds both page ids, both revisions and the
disposition into its hash. The apply needs the user's consent (destructive):
without `--yes` a non-interactive run exits 3 with the consent payload and
changes nothing. It re-reads both pages under their page locks and refuses
`changed_since_preview` when anything moved, and it settles the pair
(`remedied` or `closed`) in the same transaction. A rerun finds no open pair
and writes nothing.

A carry keeps the facts of both pages or refuses. Every row of the old page's
`## Facts` fence must be in the new file's fence at the same row number with
the same claim; the old row (its id, `created_at` and `valid_from`) survives
with the new row's fence fields. Anything else refuses
[`fact_rows_collide`](error-codes.md#fact_rows_collide) before writing, naming
the rows: give each old claim its own row in the new file, commit, sync and
preview again, or take another route.

A carry runs on classic sources only. On a managed source page tables change
only through coordinated publications, so carrying is unavailable there
([`managed_remedy_unavailable`](error-codes.md#managed_remedy_unavailable)):
the preview says so and writes nothing, an apply refuses with that code, and
the sync report, `sync status` and doctor name `--close` (its preview and
its apply with consent) as the pair's remedy. `--close` releases the purge
hold without carrying identity, on both kinds of source; restoring the old page
also works on both.

Explicit-only: `gbrain repair --all`, the maintenance cycle and the doctor
remediation plan never run it.

### Stale atoms

`gbrain repair stale-atoms` (explicit-only) retires atoms that drifted from
their source page and that managed re-extraction never retired (atoms left
by an older gbrain). It lists live atoms bound
to a source page (`source_slug`) in two classes:

- `origin_gone`: the source page is missing or deleted;
- `origin_changed`: the source page was edited, and its current text has
  already been extracted (a managed brain records a completed extraction at
  the page's current hash; an unmanaged brain has an atom carrying it). Atoms
  of an edited page that was not extracted again yet are the extract_atoms
  backlog, not stale, and are not listed.

It never lists an atom with `imported_from` or a transcript (file-bound)
atom.

```bash
gbrain repair stale-atoms --source <id>          # preview: every atom with its class, and a hash
gbrain repair stale-atoms --source <id> --apply --expect <hash>
```

The apply retires exactly the previewed set. Each atom is checked again first;
one whose revision, class, source page or completion evidence changed since
the preview reports `changed_since_preview` and is kept. Retiring is a soft
delete stamped with `retired_by: stale-atoms`: on a managed brain each atom is
one coordinated request (its file is removed through the page deletion path),
on an unmanaged brain a direct soft delete. Retiring also marks the source
page for extraction again, so restoring a deleted page and running
`extract_atoms` brings its atoms back. `--apply` without `--expect` refuses
with the preview and apply commands; a stale hash refuses with
[`preview_changed`](#preview-changed). An apply under a different `--source`
than the preview also refuses with `preview_changed`. Doctor
`atom_provenance_drift` names this command when drift crosses its warn
threshold.

### Atoms restore

A managed atom re-extraction whose model returned no atoms for a page or
transcript (#7013) retired every earlier atom of that origin: each one was
soft-deleted and stamped `retired_by: managed-reextract`, and the purge then
removed it for good. `gbrain repair atoms-restore` brings them back. It is
explicit-only and preview-bound, and nothing runs on upgrade.

```bash
gbrain repair atoms-restore --source <id> --json    # preview: each atom with its origin, hash and retirement time, and a hash
gbrain repair atoms-restore --source <id> --apply --expect <hash>
```

The preview lists a retired atom only when all of these hold:

- it is not imported (`imported_from`) and carries `retired_by: managed-reextract`
  (a `stale-atoms` retirement is never listed);
- its origin is still there: a live page of the same source (`source_slug`), or
  a transcript (`source_path`);
- no live atom of the same origin carries a different source hash, so no later
  extraction replaced it;
- it belongs to the origin's most recently retired generation (its source hash
  is the hash of the origin's latest `managed-reextract` retirement), so an older
  generation that a later non-empty extraction replaced is never revived.

The residuals count what it keeps: `origin_gone`, `replaced` and
`older_generation`, next to `restorable` and the number of `origins`.

The apply restores exactly the previewed set and checks each atom again first;
one whose revision or rule match changed since the preview (for example a new
extraction replaced it) reports `changed_since_preview` and stays deleted. On a
managed brain each atom is one coordinated request bound to the deleted atom's
revision: it reverts the atom to the live version its retirement archived
(same source hash, no `retired_by`/`retired_at`), writes its canonical file
back, keeps the derived trust tier an extraction gives it, and the outcome names
the request id (`gbrain write-request -- <id>` reads its receipt). An atom with
no such version reports `no_version` and stays deleted. A file that differs from the database at the atom's path reports
`file_conflict` and is left as it is. On an unmanaged brain the atom is
versioned, restored and has the two keys removed in one transaction. Neither
changes the origin's extraction state. `--apply` without `--expect` refuses with
the preview and apply commands; a stale hash or another `--source` refuses with
[`preview_changed`](#preview-changed).

The batch purge (the maintenance cycle, `gbrain pages purge-deleted` and the
unmanaged bulk delete) holds every atom the preview would list for 30 days
after its deletion instead of the usual 72 hours, so an operator who upgrades
late can still restore it. An explicit `gbrain delete <slug> --purge` is not
held. Doctor `atom_retirements_restorable` warns while such atoms exist, with
their count, origins, oldest and newest retirement and the date the first hold
ends; its fix is the read-only preview. Show the user the preview before
running the apply.

### Extractor facts

A managed write by a gbrain older than v0.60.11.0 to a conversation page
without a Facts fence expires all of that page's conversation-extractor facts
(`expired_at` set, `row_num` cleared), so recall stops returning them.
`gbrain repair extractor-facts` restores them. It is explicit-only and
preview-bound.

```bash
gbrain doctor                                   # extractor_facts_expired
gbrain repair extractor-facts                   # preview: every candidate with its class
gbrain repair extractor-facts --apply --expect <hash>
gbrain doctor
```

Each candidate gets one class:

| Class | Meaning | Restored |
| --- | --- | --- |
| `evidenced` | A committed write of the page completed in the same transaction that expired the fact (`completed_at = expired_at`), and its consumer was older than v0.60.11.0 (no version stamp, or an older one). | By `--apply --expect <hash>` |
| `ambiguous` | Unmanaged brain (no receipts); no committed write at the exact expiry instant; the expiring write came from a fixed consumer (a fence row may legitimately have taken the fact's position); or the page has carried fence facts. | Only with `--include-ambiguous` and that preview's hash |
| `excluded:<reason>` | Page missing or deleted, superseded (`superseded_by`), withdrawn (`forget`), an active fact with the same text and entity already on the page, or an earlier candidate with the same text and entity. | Never |

Ambiguous rows are restored as the hashed set; `--limit` is the only
narrowing. Run `gbrain repair extractor-facts --include-ambiguous`, review
the list, then `gbrain repair extractor-facts --include-ambiguous --apply
--expect <hash>`.

The apply restores exactly the previewed set. A fact that changed since the
preview (edited, withdrawn, superseded, its page deleted or recreated)
reports `changed_since_preview` and stays expired; `preview_changed` means
the hash names no saved preview, the preview is older than 7 days, or the
apply's `--source` / `--include-ambiguous` differs from the preview's.
Restored facts get a fresh row number above the page's rows. Nothing is
written to any page or file. On a managed brain each page publishes one
database-only `managed_maintenance_restore_extractor_facts` request; a
rerun after a crash replays it and restores no new candidate.

Receipts are retained (compaction keeps `completed_at`), so a history older
than the 30-day receipt retention is still evidenced. Not recoverable
automatically: facts whose extractor batch was since replaced by a
re-extraction (the old rows are gone), and facts on unmanaged brains without
`--include-ambiguous`. On PGLite the same-transaction rule holds only to the
millisecond (PGLite's clock resolution).

The preview warns, naming the host, when a consumer older than v0.60.11.0
published writes after `writer_version_cutoff`: an old consumer expires
restored facts again. Upgrade and restart it first.

<a id="conversation-labels"></a>
### Conversation labels

Before v0.60.69 the conversation parser read meeting-note labels such as
`**Date:**`, `**Attendees:**` and `**Summary:**` as speakers, so
`gbrain extract-conversation-facts` stored facts like "Date said the review is
on Monday", dated at 1970-01-01 when the page had no date. The parser is
fixed, but those pages stay marked complete, so an upgrade never re-extracts
them. `gbrain repair conversation-labels` retires those facts. It is
explicit-only, preview-bound and destructive (it needs the user's consent),
and it makes no model calls.

**Say to your agent:** *"Doctor says some conversation facts came from
meeting-note labels. Show me which ones before removing anything."* The agent
runs the preview, shows you the list and, after you agree, runs the printed
apply command with `--yes`.

```bash
gbrain doctor                                          # conversation_label_facts
gbrain repair conversation-labels                      # preview: every candidate, per-page outcome, hash
gbrain repair conversation-labels --apply --expect <hash> --yes
gbrain extract-conversation-facts --source-id <id> --slugs <pages> --dry-run      # printed by the preview
gbrain extract-conversation-facts --source-id <id> --slugs <pages> --max-cost-usd <n>
gbrain doctor
```

Candidates are active conversation-extractor facts on pages that carry a bold
metadata label line. Each gets one class:

| Class | Meaning | Retired |
| --- | --- | --- |
| `evidenced` | Its context names a `segment 1970-01-01` window, which only the pre-fix parser wrote (the fixed one records an undated page as not extractable). | By `--apply --expect <hash> --yes` |
| `ambiguous` | Any other fact of a label page: a post-fix transcript with a `**Date:**` header, a model-written context, a fact that legitimately mentions a label. Nothing on the row proves the misattribution. | Only with `--include-ambiguous` and that preview's hash |
| `excluded:<reason>` | `current_extractor` (the page's outcome carries `extractor_version`, so the fixed parser extracted it), `withdrawn`, `superseded`, `superseded_by_reference` (another fact names it), `open_loop_reference` (an open loop points at it). | Never |

The preview also gives each page its outcome:

| Outcome | What the apply does | Cost |
| --- | --- | --- |
| `non_extractable` | Retires the facts, expires the completion marker and records the page as not extractable (prose notes, an undated page, a single email), as the fixed parser would. | $0 |
| `awaiting_reextraction` | Retires the facts and expires the completion marker; the page re-enters the ordinary extraction backlog. | The next extraction, under its own cap |
| `cleaned` | Retires the facts; the page had no completion marker. | $0 |

A per-fact apply outcome of `changed_since_preview` means the fact changed (it
was edited, withdrawn, superseded or already expired); it stays as it is.

There is no `--reextract` or `--max-usd` here: `gbrain repair` never spends.
The preview prints the hand-off, one dry run and one capped run per 50 pages
waiting for extraction:
`gbrain extract-conversation-facts --source-id <id> --slugs <a,b,…> --dry-run`,
then the same command with `--max-cost-usd <n>` (default $5 when omitted; the
opt-in `cycle.conversation_facts_backfill` also picks them up at $1 per run and
$5 in total). Nothing re-extracts automatically.

Retired facts are expired, not deleted: each keeps its id and gains
`retired: conversation-labels <hash>` in its context, recall stops returning
it, and a later extraction, its orphan cleanup and `gbrain repair
extractor-facts` leave it alone. To bring a page's facts back, re-extract the
page with the commands above. Pages apply in batches of up to 25: on a
managed brain each batch publishes one database-only
`managed_maintenance_conversation_label_retire` request (one receipt for the
batch, each page rechecked on its own), and a rerun after a crash skips
batches whose request already committed. A non-interactive
apply without `--yes` exits 3 with the consent payload and changes nothing;
`preview_changed` means the hash names no saved preview, the preview is older
than 7 days, or the apply's `--source` or `--include-ambiguous` differs from
the preview's. Under a live `gbrain serve` on PGLite the command is refused at
once: stop the serve, run the repair, then restart the serve (the refusal's
`fix` names the steps).

Conversation outcomes now record the parser version (`extractor_version=<n>`
in the outcome row). Doctor `conversation_outcomes_stale` counts outcomes a
later parser version would reconsider; they are never reopened automatically.

<a id="captured-facts"></a>
### Captured facts

Automatic capture (the writeback hook, the compaction harvest and the corpus
sweep) skips gbrain's own claude-cli model sessions and text you paste into a
conversation. Facts a gbrain older than v0.60.30.0 captured from them stay
active, so recall and hot memory keep returning them. `gbrain repair captured-facts` expires them. It is
explicit-only and preview-bound, and it runs on the brain host (it reads the
Claude Code session directory and the session corpus there).

**Say to your agent:** *"Doctor says some facts were captured from gbrain's own
sessions or from pasted text. Show me which ones before removing anything."*
The agent runs `gbrain repair captured-facts`, shows you the list and, after
you agree, runs the printed apply command.

```bash
gbrain doctor                                   # captured_facts_active
gbrain repair captured-facts                    # preview: every candidate with its class
gbrain repair captured-facts --apply --expect <hash>
gbrain doctor
```

| Class | Meaning | Expired |
| --- | --- | --- |
| `evidenced` | The fact's session is one of gbrain's own claude-cli sessions: a harness transcript in a gbrain scratch project, or a corpus file `gbrain doctor` (`self_capture`) quarantined. | By `--apply --expect <hash>` |
| `ambiguous` | A paste candidate: at least 60% of the fact's content words appear in the session's retained corpus file only inside pasted blocks. A heuristic, so it is listed in every preview but expired only on request. | Only with `--include-ambiguous` and that preview's hash |
| `excluded:legitimate_duplicate` | The same claim and entity also has an active fact from another lane or an unsuspected session, so the claim is legitimate. | Never |

Sessions that cannot be classified on this host (the harness transcript was
pruned, the corpus file is gone, or a corpus file or directory it could not
read) are counted as `unclassifiable` and kept. Each unreadable corpus file or
directory is listed as `unreadable_corpus_file` and counted in the
`unreadable_corpus_files` residual; fix its permissions and preview again.
`captured_facts_active` counts facts; the `self_capture` check counts corpus
files. Clear both: quarantine the files with the commands `self_capture`
prints, then expire the facts here.

The apply expires exactly the previewed set. A fact that changed since the
preview reports `changed_since_preview` and stays active. A fact with a row in
its entity page's `## Facts` fence is struck in the page (one revision-bound
`put_page` per page, which re-embeds the page), so a later write of the page
cannot reactivate it; a fact with no fence row expires database-only (one
maintenance request per page on a managed brain). Nothing is withdrawn, so
`gbrain remember` can save the same claim again.

<a id="loop-facts"></a>
### Loop facts

Closing a commitment loop (`gbrain loops done`, `gbrain loops drop`, or the
`loops_close` tool) retires its commitment fact.
A loop closed by a gbrain older than v0.60.32.0 while that retirement could
not commit (for example on a managed brain, where the write was refused but
the close still reported `fact_expired: true`) leaves the fact active, so
entity cards and recall keep the finished promise. `gbrain repair
loop-facts` retires those facts. It is explicit-only and preview-bound.

**Say to your agent:** *"Doctor says some closed loops still have an active
commitment. Preview retiring those facts, then apply after I agree."* The agent
runs `gbrain repair loop-facts` and, after you agree, the printed apply command.

```bash
gbrain doctor                                   # loop_facts_drift
gbrain repair loop-facts                        # preview: closed_loop_facts=N
gbrain repair loop-facts --apply --expect <hash>
gbrain doctor
```

Each candidate is a `done` or `dropped` loop whose commitment fact is active
and lives in the loop's own source. A fact that another open loop still
references is skipped (`shared_with_open_loop`); it is retired when the last
loop that uses it closes. The apply expires the fact and strikes its fence row
in one coordinated write, exactly for the previewed set; a loop or fact that
changed since the preview reports `changed_since_preview` and is kept. No
withdrawal is recorded, so the same promise made again is stored normally.

<a id="ontology-facts"></a>
### Ontology facts

From v0.60.53.0 until v0.60.104.0 the facts step of the maintenance run (the
`gbrain serve` sweep and the dream cycle) moved ontology observations
(`ontology_propose`) onto their entity page's `## Facts` table: each took the
page as its source, and the next rewrite of the page that did not list it
retired it, so `ontology_get` stopped returning it (#6264). `gbrain repair
ontology-facts` restores them. It is explicit-only and preview-bound.

**Say to your agent:** *"Doctor says some ontology observations were moved onto
page tables. Preview restoring them, then apply after I agree."* The agent runs
`gbrain repair ontology-facts` and, after you agree, the printed apply command.

```bash
gbrain doctor --only ontology_facts_fenced      # fenced=N retired=N
gbrain repair ontology-facts                    # preview: one line per observation
gbrain repair ontology-facts --apply --expect <hash>
gbrain doctor --only ontology_facts_fenced
```

A candidate is an ontology row with a fence row number, or whose
`source_markdown_slug` differs from its `source`; ontology writes produce
neither. The preview classes each one `fenced` (still on the table) or
`retired` (a page write retired it), or excludes it: `withdrawn` (its claim
was forgotten), `consolidated`, or `duplicate` (the same observation was
proposed again after it went missing, so restoring it would make a second
copy). The apply gives each restorable row its own source back, takes it off
the table and clears its expiry, exactly for the previewed set; validity dates
and supersession links stay as they are. A row that changed since the preview
reports `changed_since_preview` and is kept. It writes the database only:
the line the old step added to the page's Facts table stays in the page as an
ordinary page fact. An observation whose source was already the page's own
slug and that a page write detached carries no trace of the move, so it is not
found.

<a id="facts-rehome"></a>
### Facts on an entity slug with no page

Before the B-7 resolver fix, an extractor that named an organization under
`companies/acme-example` missed the page `orgs/acme-example`, even when that
page listed `acme example` as an alias, and managed writes kept the invented
slug as the fact's entity (#6925). Those facts sit on an `entity_slug` no page
answers for, so entity recall and trajectories never find them. `gbrain repair
facts-rehome` moves them to the page they name. It is explicit-only and
preview-bound, and it never runs on upgrade.

**Say to your agent:** *"Some facts sit on entity slugs that have no page.
Preview moving them to their pages, then apply after I agree."* The agent runs
`gbrain repair facts-rehome` and, after you agree, the printed apply command.

```bash
gbrain repair facts-rehome                      # preview: one line per page-less slug
gbrain repair facts-rehome --apply --expect <hash>
```

The preview lists every page-less `entity_slug` with its class. `rehome`: the
strict resolver reaches one live entity page by identity evidence (the exact
page, the same name under another organization directory, or a unique alias),
and the slug's database-only facts move there. `ambiguous` (more than one page
answers), `unverified` (only a bare-name guess answers), `unresolved` (no page
answers) and `fence_owned` (every fact is a row of a page's Facts table) are
listed and never moved. The apply moves exactly the previewed facts; a slug that
gained a page, lost its target or whose facts changed since the preview reports
`changed_since_preview` and is kept. A duplicate ontology observation already on
the target is merged rather than copied. It writes the database only; no page is
rewritten.

<a id="failed-writes"></a>
### Failed writes

Two kinds of refusal leave a caller's write with a receipt but nothing landed.
On a managed brain whose `tags`, `timeline_entries` or `takes` table has a
`source_id` column gbrain does not create, the managed writer guard of a
gbrain older than v0.60.38.0 refuses writes it should allow. And a write ends
`conflict` with `source_changed` when the page's canonical file and database
copy differed at publication, as every write did on a brain whose v0.13.1
grandfather `validate: false` stamp lived only in the database (#6429, fixed
in v0.60.157.0: that stamp is no longer read as a file edit). Each refused
write keeps a receipt with its full intent until receipt compaction
(`persistence.receipt_retention_days`, 30 days by default). `gbrain repair
failed-writes` submits those writes again. It is explicit-only and
preview-bound, and needs v0.60.38.0 or later (`gbrain doctor --json` reports
schema version 197 or later). Doctor's `lost_caller_writes` counts the
retained refused writes that may be replayable, per source, and names this
preview; the preview decides which ones it replays. Doctor leaves out (and
lists under `details.not_replayable`) the two classes it can decide from the
receipt alone: an unpinned `remember` (`unpinned_target`) and a `put_page`
whose page changed after the revision the caller read (`revision_superseded`, which
the preview classes `superseded`). The
preview changes no page content, but it records an approval checkpoint for its
replay set, which `--apply --expect <hash>` reads.

**Say to your agent:** *"Preview which refused writes gbrain can replay, show
me the list, then apply after I agree."* The agent runs `gbrain repair
failed-writes` and, after you agree, the printed apply command.

```bash
gbrain config set persistence.receipt_retention_days 90   # keep the receipts while you recover
gbrain repair failed-writes --source <id>                 # preview: every refused write with its class
gbrain repair failed-writes --source <id> --apply --expect <hash>
gbrain repair failed-writes --source <id>                 # replayed writes now read already_written
```

Candidates are failed receipts refused by the guard (`writer_coordinator_required`,
or `storage_error` "Publication failed (P0001)" from releases that did not keep
the guard's message) and conflict receipts refused `source_changed` at
publication. Only writes a caller made directly are replayed:
`put_page`, `add_timeline_entry` and `remember`. The preview gives every
candidate one class:

| Class | Meaning | What happens |
| --- | --- | --- |
| `replay` | No later write supersedes it. | Replayed on apply. |
| `already_written` | A later request with the same intent committed, or an earlier apply replayed it. | Kept. |
| `duplicate` | A later request with the same intent exists; that one is the candidate. | Kept. |
| `superseded` | A later write or delete of the page committed or is pending; for `put_page`, also a later failed `put_page` (newer content) or a page changed since the caller read it. | Kept; re-issue by hand if still wanted. |
| `unpinned_target` | A `remember` saved unattributed; replaying would infer its subject again and could pick another page. | Kept. Re-issue it with an explicit `entity` if it is still wanted. |
| `file_database_drift` | Its last replay hit `source_changed` and the file still differs from the database. | Kept until the file matches again (a reconcile that writes only the file counts) or the page changes; reconcile it first. |
| `producer_owned` | gbrain produced it (sync or file import, reconcile, relink, maintenance page, job). | Kept. The preview prints the command that produces it again from current content (sync: `gbrain sync --source <id> --no-pull`). |

The apply replays exactly the previewed set. Each write is classified again
and its original caller's authority is checked again first: a write that
changed class since the preview reports `changed_since_preview`, and one whose
caller lost its grant or whose source was re-created reports
`authority_revoked`; both are kept. A replay goes through the operation's
normal path on the original caller's trust lane and under its stored authority:
the same writer (an OAuth client stays that client), delegation, scopes,
take-holder and delegated namespace limits and link trust, for the same source
incarnation, checked against the live grant at admission and again at
publication. A write an agent sent over MCP is prepared as a remote write
again, so it can do no more than the original could; a grant revoked or
narrowed between admission and publication refuses the replay at publication.
A subagent or restricted-namespace write gets back the identity it recorded
(the job id of an OAuth-delegated job, or the `wiki/agents/<id>/` namespace of
a legacy subagent, which stays database-only); one that recorded neither is
confined to exactly its stored namespace allow-list. Live subagent dispatches
without a job id are still refused. A `put_page`
replay is bound to the page revision the preview saw (an original `force: true`
is dropped), so a page changed since the preview reports `changed_since_preview`
or `conflict` instead of being overwritten. A `remember` replay targets the
subject the original resolved. Each replay uses a new request id derived from
the failed one, so a rerun after a crash resumes the same request and a second
apply never writes it twice (`pending_elsewhere` when another writer holds that
request). Attribution names the original writer. A replay the
brain refuses reports `refused` with the code. The failed receipts stay as
history.

Since #6693 a `remember` refused because its page's file held a committed Git
change sync had not imported (`pending_import`) or was held by sync
(`sync_held`) is not left for this preview alone: after every managed sync the
same replay runs by itself for those remembers whose page now matches its file
(at most 50 per sync and 30 s; the sync result's `replayedRemembers` and one
stderr line count them). A replay keeps the fact's original `valid_from` and
expiry. `put_page` and `add_timeline_entry` refusals are only replayed here,
after you preview them. Receipts refused before this release are not replayed
automatically; this preview lists them.

<a id="split-facts"></a>
### Split facts

A page whose `## Facts` fence lived below the timeline sentinel got a second
fence above the sentinel from managed `remember` and `extract_facts` writes
before this release (#6686). Writers now edit a lone timeline fence where it
is, and `extract_facts` reconciles it there, but a page that is already split
keeps two fences: `extract_facts` leaves its index as it is and warns
`FACTS_FENCE_BELOW_SENTINEL` naming this repair. `gbrain repair split-facts`
merges them. It is explicit-only and preview-bound and never runs from
`--all`, doctor's remediation plan, the maintenance cycle or an upgrade.

**Say to your agent:** *"Preview which pages have split facts fences, show me
the list, then merge them after I agree."*

```bash
gbrain repair split-facts --source <id>                          # preview: merge / row_collision / unparsed / not_conserved
gbrain repair split-facts --source <id> --apply --expect <hash>  # merges exactly the previewed pages
```

The merged fence stays below the sentinel and holds every row of both fences
under its own row number, so each fact keeps its id; the body fence goes, with
the `## Facts` heading above it when that heading holds nothing else. A page is
kept and listed when a fence does not parse cleanly (`unparsed`: preview
`gbrain repair fences`), when a row number appears in both fences
(`row_collision`: edit the page so each number appears once, then preview
again), or when the merged page would not read back exactly
(`not_conserved`: merge by hand). Each merge is a revision-bound `put_page`;
a page changed since the preview reports `changed_since_preview` and is kept.
Undo a merge on a managed source with `git revert` of its commit.

<a id="url-clone-fences"></a>
### URL clone fences

A source added with `gbrain sources add <id> --url <git-url>` is a clone gbrain
owns and updates with `git pull --ff-only`. Before this release, `remember`,
`extract_facts` and page writes on an unmanaged brain wrote `## Facts` fence
rows and page files into that clone (#6946). The local change blocks every pull
that touches the same file, so the clone stops following upstream. Current
releases keep those writes database-only: a fact about a clone page is stored
and recalled from the database with no fence row (`row_num` empty), and page
write-through reports `skipped: "url_clone"`. A managed brain does the same
with `gbrain sources mirror-readonly <id>`.

A clone an older release already dirtied still blocks its pulls. `gbrain sync
--source <id>` then prints `pull_blocked_local_changes` with the changed files
and an `ask_user` fix naming this repair (the sync JSON `reason` stays
`pull_failed`; the cycle's sync phase carries the code in `pull_blocked`).

**Say to your agent:** *"Preview which files of the clone gbrain changed, show
me the list, then restore them after I agree."*

```bash
gbrain repair url-clone-fences --source <id>                                # preview: fence_rows_only / refused classes
gbrain repair url-clone-fences --source <id> --apply --expect <hash> --yes  # restores exactly the previewed files
gbrain sync --source <id>                                                   # pulls again
```

The preview lists every tracked file that differs from HEAD and proves the
difference is only fence rows gbrain appended: both fences parse, HEAD's rows
are an unchanged prefix of the working copy's, and re-rendering HEAD with the
working fence reproduces the file byte for byte. Any other difference is
named with its class (`non_fence_edit`, `unparsed_fence`, `staged_change`,
`deleted`, `not_in_head`, `unreadable_checkout`) and the file is left alone; resolve it in the clone (keep
the edit upstream, or discard it with `git checkout -- <path>`), then preview
again. Each restored file is first backed up under
`~/.gbrain/backups/url-clone-fences/`. Its rows stay active and recallable as
database-only facts, HEAD's bytes are imported as the page (as sync would
import them), and only then is the file restored; each step is idempotent, so
a stopped run previews the same file again. A file that changed since the preview
reports `changed_since_preview` and is kept. The hash is bound to the `--source`
selection, each source's incarnation and clone root, and each file's page: an
apply with another `--source`, or after `gbrain sources set-path` moved the
source or it was removed and added again under the same id, refuses
`preview_changed` and writes nothing, and so does a file with a change staged
since the preview. Preview again and approve the new hash. Undo by copying the backup over
the file. It is explicit-only and never runs from `--all`, doctor's
remediation plan, the maintenance cycle or an upgrade.

<a id="file-drift"></a>
### File drift

A page whose canonical file differs from its database copy refuses every
coordinated write with `source_changed` (detail `file_database_drift`) until
someone resolves it. Before #6643 nothing resolved them in bulk, and
`synthesize_concepts` paid for a new narrative for each drifted concept on
every cycle, then left another conflict receipt behind. Now maintenance checks
the file before it spends or admits anything: a drifted concept is skipped
(recorded in `dream.concepts.drift_skips`, released once the file and database
agree), and a maintenance write to a drifted page refuses before admission
without a request row. Doctor's `maintenance_write_drift` counts the drifted
pages and the skips.

`gbrain repair file-drift` resolves them through the same canonical
reconciliation as `gbrain sources reconcile`, preferring one side. It is
explicit-only, preview-bound and runs only from the trusted local CLI on the
canonical owner host.

**Say to your agent:** *"List the pages whose writes keep refusing
source_changed, preview resolving them with the file winning, show me the
exceptions, then apply after I agree."*

```bash
gbrain sources reconcile <id> --brain host --audit --conflicts   # read-only: receipts per slug, still drifted?, class
gbrain repair file-drift --source <id> --slug notes/a --prefer file        # preview one page
gbrain repair file-drift --source <id> --all-drifted --class structurally_additive --prefer file
gbrain repair file-drift --source <id> --all-drifted --class structurally_additive --prefer file --apply --expect <hash>
gbrain repair file-drift --source <id> --all-drifted --only 'concepts/**' --prefer database   # preview every drifted page filed under concepts/
gbrain repair file-drift --source <id> --all-drifted --since 7d --prefer database             # only pages that drifted in the last 7 days
```

Select pages with `--slug` (repeatable), `--request <id>` (a conflict receipt,
repeatable) or `--all-drifted` (every page the conflict audit still finds
drifted, up to 1,000). `--prefer file` takes the canonical file, `--prefer
database` the database copy. The preferred side wins the title, type, body,
timeline and ordinary frontmatter (a key only the other side has is dropped)
inside reconcile's existing protections: protected metadata (provenance,
trust, source and scan fields) stays as the database holds it, tags are the
union of both sides, and protected takes and private fact rows are kept as
stored. Each page's preview lists `exceptions`, the places where the result
differs from the preferred side and why (`protected_metadata`, `scan_state`,
`tags_union`, `protected_takes_or_private_facts`).

<a id="file-drift-globs"></a>`--only <path>` and `--skip <path>` (both repeatable) narrow any selection by
the page's canonical file path, relative to the source. A value with no `*`
is an exact path (`concepts/agi.md` selects that file only), as `--only` is for
`frontmatter`, `fences` and `slug-conflicts`. Globs work on `file-drift` only:
`*` matches within one path segment (`concepts/*` is every file directly under
concepts/) and `**` matches across segments (`concepts/**` is everything under
it, at any depth); the other kinds' `--only` takes exact paths. A page is
selected when it matches some `--only` (or there is none) and no `--skip`.
They match the file path, not the slug: `--only concepts/agi` selects
nothing, `--only concepts/agi.md` selects the page. The pages they leave out
are counted as `not_selected`, the mixed-class check and the 1,000-page bound
run on the selected pages only, and the globs are bound into the preview hash
and printed in the apply command, so running that exact command applies
exactly the previewed pages (an apply under other globs refuses
`preview_changed`). Quote a glob so the shell does not expand it.

<a id="file-drift-since"></a>`--since <ISO-8601 | age>` narrows `--all-drifted` to the pages whose newest
drift receipt was recorded at or after that instant (#6712 PR 2). An age
(`90s`, `30m`, `12h`, `7d`) is converted to one concrete UTC instant when the
command runs, and the preview hash and the printed apply command carry that
instant, not the age, so the apply selects the same pages the preview did.
Any other value refuses before anything is read. `--since` with `--slug` or
`--request` refuses: it only narrows `--all-drifted`. The fix that
`gbrain sources writer failures` prints for a group of drift receipts already
carries `--since` with the oldest receipt's time. One parser serves this flag
and `gbrain agent logs --since`.

`--keep` belongs to `stuck-recovery`; file-drift refuses it and names the
equivalent: `--prefer database` keeps the database copy, `--prefer file`
keeps the file.

<a id="deleted-canonical-files"></a>**A page whose canonical file is gone** (#6712). A page selected with
`--slug` or `--request` whose recorded canonical file is missing is resolved
by where the deletion stands in Git:

| The file is | Route | `--prefer database` | `--prefer file` |
|---|---|---|---|
| deleted in the worktree but still committed at HEAD (staged or not) | Not file drift: commit the deletion (sync then imports it), or remove the page with [`gbrain repair ghost-pages`](#ghost-pages) (its own valve and consent). To keep the page, restore the file from Git and sync. The file-drift preview lists it `deletion_uncommitted` and resolves nothing. | — | — |
| gone from the last commit (a committed deletion sync held because the page changed, or a checkout with no commit) | `gbrain repair file-drift --source <id> --slug <slug> --prefer database\|file` | Recreates the canonical file from the page through the reconcile apply; the page is unchanged. Git durability commits the file; when it is off the preview warns, and you commit the file yourself, or the next sync imports the committed deletion again | Soft-deletes exactly that page (purged after 72 h; `gbrain restore <slug> --force` undoes it until then) |

Both are preview-first and bound to the page revision and the observed
absence: a file that reappears, or a page that moves, between preview and
apply is `changed_since_preview` and nothing is written. Soft deletes honor
the sync mass-delete valve (more than half of a source's file-backed pages
refuses [`ghost_mass_delete_refused`](error-codes.md#ghost_mass_delete_refused)
unless `GBRAIN_ALLOW_MASS_RECONCILE=1`). `gbrain sources reconcile --preview` on
such a page refuses and names the same route, and a held deletion's next step
in `gbrain sources status` is the `--prefer database` preview. `--all-drifted`
does not select missing files.

The audit gives every drifted page one class: `structurally_additive`,
`additive_with_suggestions`, `review_required`, `formatting_only` or `error`.
`--all-drifted` refuses a selection that mixes classes (the message counts
each one) unless `--class <name>` keeps exactly one, so a single `--prefer`
never resolves differently shaped drift in bulk. Review `review_required`
pages one at a time with `--slug`.

The preview writes each page's resolved result to a private artifact under
the gbrain config directory (`repair-previews/file-drift/<hash>.json`,
outside every checkout) and prints the hash. `--apply --expect <hash>`
applies exactly that set through the reconcile apply, with its preimage
checks and retained backups, under request ids derived from the hash, so an
interrupted apply resumes and never writes a page twice. Each page reports
`repaired`, `refused` (with the code) or `changed_since_preview` (the file or
the page changed after the preview; preview again). A changed set refuses
with `preview_changed`.

<a id="file-drift-keep-db"></a>**Opt-in policy: keep the database copy under some prefixes.** For
derived pages nobody edits by hand (concepts a cycle regenerates, for
example) the database copy is the one to keep. Declare their prefixes in the
source's `gbrain.yml`:

```yaml
storage:
  keep_db:
    - concepts/
```

On the canonical owner host the resident consumer of `gbrain serve`,
`gbrain jobs work` or `gbrain autopilot` then reconciles each drifted page
under those prefixes with the database copy winning, the same resolution
`--prefer database` previews (reconcile's protections and backups apply). It
submits one request per drifted page, at most 10 every 10 minutes, never
twice for the same drift (the request id is derived from the page revision
and file bytes), and stops before an admission that would cross 90% of the
write-quota stop line. Prefixes match page slugs by whole path segments, like
`db_tracked` and `db_only`. Nothing else reads the policy: another host, a
short-lived command, and remote or caller writes keep refusing
`source_changed` until the page is reconciled. Doctor `maintenance_write_drift`
echoes each declared policy (`keep_db_policy`: prefixes, how many of the
drifted pages it checked match, their receipt cost). Remove the block to turn
the policy off.

<a id="held-files"></a>
### Held files

A file gbrain cannot import without guessing does not stop a sync. Sync holds it, imports the rest of the source, advances the checkpoint and
keeps reporting the file until it changes, is deleted, or a newer gbrain can
read it. A held new file has no page yet; a page whose newer file is held keeps
its last good revision, search marks it `stale`, `get_page` carries
`file_held`, and `put_page` refuses it until the file is repaired, so an agent
must not retry a refused write. Hold codes and their fixes are in
[write refusal reasons](write-refusals.md#invalid_frontmatter).

**Say to your agent:** *"Sync says some files in my notes source are held.
Show me what is wrong with each one and what gbrain would change, then fix the
safe ones."* or *"After the upgrade my notes source was blocked by one broken
file. Get it syncing again."*

The session below is real output (volatile ids, hashes and times shown as
`<id>`, `<hash>`, `<time>`; `test/held-files-walkthrough.test.ts` runs
these commands and checks every line shown). Before the upgrade, a generator
committed three notes to the `notes` source: `notes/standup.md` with a title
that continues on an unquoted line, a new `notes/digest.md` with `title:`
twice, and a new `notes/roundup.md` with an unquoted `: ` in `author:`. A
gbrain older than v0.60.47.0 blocks the source on the first file it refuses.

1. After upgrading, `gbrain post-upgrade` names the blocked source and the
   command that unblocks it now. Doing nothing also works: the next scheduled
   or manual sync recovers the source by itself.

   ```console
   $ gbrain post-upgrade
   frontmatter_holds: 1 source(s) are blocked by a file gbrain could not import (notes). The next scheduled or manual sync recovers a blocked source automatically; to do it now run gbrain sync --source notes --no-pull.
   ```

2. The sync converts the blocked request in place: both broken files are held,
   the readable one imports (after quoting `author`, which gbrain reports so the
   generator can be fixed), and the checkpoint advances.

   ```console
   $ gbrain sync --source notes --no-pull
   +1 added, ~0 modified, -0 soft-deleted (recoverable 72h), R0 renamed
   Held notes/digest.md: invalid_frontmatter (needs_interpretation) at line 4, key "title"; its page is missing until the file imports. Next: gbrain repair frontmatter --source notes --include-ambiguous (docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation)
   Held notes/standup.md: invalid_frontmatter (needs_interpretation) at line 2, key "title"; its page keeps its last good revision and is read-only for put_page until the file is repaired. Next: gbrain repair frontmatter --source notes --include-ambiguous (docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation)
   2 file(s) held this run, 2 held in source notes; they do not block sync. Inspect them with 'gbrain sources status notes'; the repair preview proposes each fix and writes nothing. Preview the repair: gbrain repair frontmatter --source notes
   Converted 1 failed request(s) of the blocked cursor in place: <id>.
   1 file(s) under notes/ imported only after quoting unquoted frontmatter values: whatever writes them emits YAML other tools refuse. Fix the generator to quote values (or write through put_page); the preview shows the on-disk quoting fix. Preview: gbrain repair frontmatter --source notes
   ```

3. `gbrain sources status <id>` lists every hold with its code, line, key and
   next command (`--json` adds the structured `git_holds` shown in step 6).

   ```console
   $ gbrain sources status notes
   notes: 2 held file(s): not imported, and they do not block sync. A page whose newer file is held keeps its last good revision and is read-only for put_page until the file is repaired.
   Held notes/digest.md: invalid_frontmatter (needs_interpretation) at line 4, key "title"; its page is missing until the file imports. Next: gbrain repair frontmatter --source notes --include-ambiguous (docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation) Held since <time>.
   Most holds re-screen on the next sync by themselves (the file changed or was deleted, or a newer gbrain can read it): gbrain sync --source notes --no-pull
   ```

4. Preview, pass 1 (safe changes only). Nothing is written. The safe class
   only quotes values exactly as gbrain already reads them; the two held files
   need an interpretation, so they are listed as not selected and the preview
   names the `--include-ambiguous` pass.

   ```console
   $ gbrain repair frontmatter --source notes
   safe: notes:notes/roundup.md (Quoted the value of "author" at line 3 (value unchanged))
   interpretive_pending: notes:notes/digest.md (Kept the later "title" (line 4) and dropped the earlier one (line 2))
   interpretive_pending: notes:notes/standup.md (Folded the unquoted lines after "title" (line 2) into its value)
   classes: safe=1, interpretive=0, interpretive (needs --include-ambiguous)=2, needs_review=0
   -author: acme-example (citing fund-a) (original: https://example.com/post/1)
   +author: "acme-example (citing fund-a) (original: https://example.com/post/1)"
   next: gbrain repair frontmatter --source notes --apply --expect <hash> --yes (asks the user first: destructive)
   next: gbrain repair frontmatter --source notes --include-ambiguous
   ```

5. Preview, pass 2, with the interpretations. Show the user each diff. Here the
   user approves the folded standup title and wants to look at the digest
   later, so the preview skips it; `--only` and `--skip` are bound into the
   hash. After the user agrees, apply exactly that preview.

   ```console
   $ gbrain repair frontmatter --source notes --include-ambiguous --skip notes/digest.md
   classes: safe=1, interpretive=1, interpretive (needs --include-ambiguous)=0, needs_review=0
   -title: Standup with acme-example
   -the team agreed to ship on Friday
   +title: "Standup with acme-example\nthe team agreed to ship on Friday"
   next: gbrain repair frontmatter --source notes --skip notes/digest.md --include-ambiguous --apply --expect <hash> --yes (asks the user first: destructive)
   $ gbrain repair frontmatter --source notes --include-ambiguous --skip notes/digest.md --apply --expect <hash> --yes
   applied 2, skipped 0, failed 0, complete
   repaired: notes:notes/roundup path=notes/roundup.md, written=true, imported=skipped, hold_cleared=false, committed=queued
   repaired: notes:notes/standup path=notes/standup.md, written=true, imported=updated, hold_cleared=true, committed=queued
   ```

   `imported=skipped` means the page already held those values (quoting
   changed nothing gbrain reads). `committed=queued` means the Git target effect
   records the change; a checkout without gbrain's Git durability hook keeps the
   repaired files uncommitted, so commit them the way you commit any edit. The
   next sync never re-holds a repaired file that is published but not yet
   committed.

6. Commit, sync, and read the remaining hold as JSON.

   ```console
   $ git -C ~/brain/notes commit -q -m "Repair frontmatter" -- notes/roundup.md notes/standup.md
   $ gbrain sync --source notes --no-pull
   0 file(s) held this run, 1 held in source notes; they do not block sync. Inspect them with 'gbrain sources status notes'; the repair preview proposes each fix and writes nothing. Preview the repair: gbrain repair frontmatter --source notes
   $ gbrain sources status notes --json
   "git_holds": {
   "count": 1,
   "path": "notes/digest.md",
   "code": "invalid_frontmatter",
   "reason": "needs_interpretation",
   "key": "title",
   "line": 4,
   "message": "Invalid YAML frontmatter: key \"title\" at line 4 appears more than once. Reading it would mean guessing, so it was not imported. Keep one line per key with its whole value quoted on that line, then import it again.",
   "stale": false,
   "held_since": "<time>",
   "actor": "agent",
   "docs": "docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation"
   "outcome": "held",
   ```

   Every hold carries `code`, `reason`, `key`, `line`, a location-only
   `message` (never a frontmatter value), `stale` (a page exists and keeps its
   older revision), `fix` (the exact argv) and `docs`. `recent_conversions`
   records the blocked request the upgrade converted.

7. Later the user approves the digest interpretation (keep the later title).
   The apply creates its page and clears the last hold; the next sync is clean.

   ```console
   $ gbrain repair frontmatter --source notes --include-ambiguous --only notes/digest.md
   interpretive: notes:notes/digest.md (Kept the later "title" (line 4) and dropped the earlier one (line 2))
   $ gbrain repair frontmatter --source notes --include-ambiguous --only notes/digest.md --apply --expect <hash> --yes
   repaired: notes:notes/digest path=notes/digest.md, written=true, imported=created, hold_cleared=true, committed=queued
   $ git -C ~/brain/notes commit -q -m "Keep the later digest title" -- notes/digest.md
   $ gbrain sync --source notes --no-pull
   +0 added, ~0 modified, -0 soft-deleted (recoverable 72h), R0 renamed
   $ gbrain doctor --only git_held_files,frontmatter_repairable
   [OK] git_held_files: No Git source files are held.
   [OK] frontmatter_repairable: No file has frontmatter gbrain repair frontmatter would fix.
   ```

Doctor reports the same state: `git_held_files` (warn per source with counts,
the first paths and the commands; `fail` above `GBRAIN_SYNC_HOLD_ESCALATE_COUNT`,
default 50) and `frontmatter_repairable` (files the repair can fix, including
ones that import only after quoting). Both are explicit-only findings:
`gbrain doctor --remediation-plan --json` lists them as `explicit_kind_required`
with `gbrain repair frontmatter --source <id>`, and `--remediate` never runs the
repair. `frontmatter_hook` warns when an installed pre-commit hook is older
than the running gbrain's hook; refresh it with `gbrain frontmatter install-hook --force`.

**A hold that blames the write owner, not the file.** A `preparation_stalled`
hold means the owner could not finish preparing that file's write within its
attempts (`persistence.max_preparation_attempts`, each bounded by
`persistence.sync_preparation_ms`). The file is fine and `gbrain repair` has
nothing to change in it: `sources status`, `sources retry-held` and doctor
`git_held_files` route it to the writer instead of to frontmatter or fence
repair, and a source holding all three kinds prints one route for each. Read
what the owner was stuck on, fix that, then re-screen the held files and run
the same sync with the same options (the hold prints them, `--no-embed`
included). Nothing here is destructive and no hash is involved.

```bash
gbrain sources status notes --json                  # the held files, each with the step it stalled on
gbrain sources writer status --source notes --json  # read-only: the owner, its gbrain version, the stuck step
gbrain sources retry-held notes                     # after the cause is fixed or gbrain is upgraded
gbrain sync --source notes --no-pull --no-embed     # the option-preserving command retry-held prints
```

Runbook: [catch-up stuck / held N files](troubleshooting.md#catch-up-stuck);
reference: [`preparation_stalled`](write-refusals.md#preparation_stalled).

Settings, all read by every sync (`sync.holds` is a brain config key; the `GBRAIN_SYNC_*` variables are read from the
environment of the process that syncs and replace the `sync.hold_*` and `sync.parser_regression` keys retired in
0.60.266.0, see [sync config keys](live-sync.md#sync-config-keys)):

| Setting | Default | Effect |
| --- | --- | --- |
| `sync.holds` | `hold` | `fail` makes sync fail closed: a content refusal blocks the sync. |
| `GBRAIN_SYNC_HOLD_CAP` | `500` | How many holds a sync result lists in detail; storage is never capped and valid files always import. |
| `GBRAIN_SYNC_HOLD_ESCALATE_COUNT` / `GBRAIN_SYNC_HOLD_ESCALATE_PCT` | `50` / `5` | A source holding more files, or a run holding more than that share of at least 40 screened imports, reports `holds_escalated` and doctor `git_held_files` fails. A run whose `preparation_stalled` holds would cross it stops as `preparation_systemic` instead of holding them. |
| `GBRAIN_SYNC_PARSER_REGRESSION` | `stop` | `hold` holds a file whose exact bytes imported under an earlier gbrain (`parser_regression`) instead of stopping the run with `sync_parser_regression`. |

To prevent new broken files, write brain files through `put_page`/`capture`
or a YAML serializer, check generated content with
`gbrain frontmatter validate --stdin --path <source-relative path>` before
writing it, and install the staged-content pre-commit hook with
`gbrain frontmatter install-hook` (the user's decision: it writes into their
repository). See the `frontmatter-guard` skill.

<a id="content-lane"></a>
#### The content-repair lane (#6377)

The walkthrough above is the interpretive path: frontmatter fixes change what
a file says, so each one is approved by hash. Holds about a file's *content*
(`invalid_fence`, and `frontmatter_slug_conflict` once its lane kind ships)
take a different path and clear with no one acting. The content-repair lane
(`src/core/repair/content-lane.ts`) is the ordered list of repair kinds that
clear them, today `fences`, run under one paid-model allowance and one
deadline: what the first kind spends on the model is gone for the next, and
every kind keeps its own census, owner checks, caps, daily ledger
(`fences.repair.max_usd_per_page`, `fences.repair.max_usd_per_day`, shared by
the whole lane), attempt memo and validation gates. It runs from three places:

- The maintenance run: `fence_repair` runs the `fences` kind right after
  `sync`, and `content_repair` runs every other lane kind right after it, both
  gated on `fences.repair.enabled`, so a hold the sync just wrote is repaired
  before the extract phases read the page.
- `gbrain sync unblock --source <source> --apply` runs the lane on exactly the
  held paths now, one bounded apply, then schedules the re-screen and prints
  the sync. Each path reports `repaired`, `held`, `needs_human` or `skipped`
  with its reason code, receipt and next step; `--no-llm` keeps to the free
  tiers and `--no-repair` restores the refuse-only behaviour
  ([runbook](sync-unblock-runbook.md)).
- By hand:

```bash
gbrain repair content --source <source>                                    # preview: every lane kind, read-only, no model call; one hash per kind
gbrain repair content --source <source> --apply --expect <hash>[,<hash>]   # the apply command the preview prints: exactly those sets
gbrain repair content --source <source> --only <path> --apply              # one file, each kind's current plan
```

The preview plans every kind before anything is written and prints each
kind's own hash and the apply command; there is no combined hash, and a wrong
hash count refuses (`invalid_params`) before any kind runs. `--max-usd <n>` is
the lane's allowance for the run; `--no-llm` keeps every kind to its free
tiers. `--apply` alone applies each kind's current plan as `gbrain repair
<kind> --apply` does, each file bound to the bytes the plan read
(`changed_since_read`).

**What a repair proves.** Every repair is one coordinated write. On a managed
source the file is rewritten, imported, its hold cleared and the commit queued
through the Git effect, whose subject is `gbrain: repair fence in <path>
(<classes>)` and whose trailer `gbrain-repair: <hold_code> <tier> <confidence>`
names what was repaired, which tier decided it and how sure the rule was. The
receipt the write carries (location-only: mode, tier, classes, rows, columns,
`before_sha256`, `after_sha256`, `committed: effect | commit_step |
not_in_git`, and for a merge the merged fence occurrences, never a cell) is
parsed before it reaches a commit message, so nothing forged lands there.
`git revert` of that one commit restores the bytes; the hold then re-screens.
A legacy source is backed up under `~/.gbrain/backups/` and prints the commit
step with the same `-m` pair.

**What the model decides, and what it never does.** The deterministic tiers
run first and the model sees only the cases they mark ambiguous: the trailing
lines after an unclosed fence on a world-visible page (prose, rows or unsure)
and a slug conflict whose two pages might be the same thing (`remove_slug`,
`merge_into <canonical>` or `needs_human`). The model chooses among coded
answers; every byte written comes from a rule and passes the gates. Merges are
**recommended, not executed**: a `merge_into` answer becomes a `needs_human`
hold naming the canonical page ([`merge_recommended`](write-refusals.md#merge_recommended)),
and a world-page close that would expose text waits for the hash-bound
approval ([`tail_exposure_approval`](write-refusals.md#tail_exposure_approval)).
`gbrain sync status --source <source> --json` lists each such hold with its
paragraph in `human_reason`; `fences.repair.llm false` turns the model tier
off for the whole lane.

**Slug conflicts agree with sync.** The `slug-conflicts` kind screens a held
file, and the edit it would write, with the same screen managed sync froze
the file with. A held file the screen now admits as it is (its `slug:` line
names the file's own page, or it no longer conflicts) is listed as `import`
and imported unchanged; the write clears only the hold observation the
preview read, so a hold a newer sync wrote stays and the next run retries it.
A file sync would hold whatever the lane writes (the page it is filed as
carries a different slug than its path, or the line reaches the page only
through an alias) is held [`slug_page_mismatch`](write-refusals.md#slug_page_mismatch)
with both slugs and the exact hand edit.

**Say to your agent:** *"Sync is holding a few files over their tables or
slugs. Repair what gbrain can by itself and tell me what it wants me to
decide."*

<a id="frontmatter"></a>
### Frontmatter

A file whose YAML frontmatter gbrain cannot read without guessing is held by
sync instead of blocking it, and some files import only after gbrain
quotes an unquoted value. `gbrain repair frontmatter` fixes those files on
disk and imports them. It also finds pages an older import stored wrong: a
body that begins with its own frontmatter block, or a title derived from the
slug although the file names one. It is explicit-only and preview-bound.

**Say to your agent:** *"Some files in my notes source are held. Show me what
gbrain would change in each one, then fix the safe ones."* The agent runs
`gbrain repair frontmatter --source <id>` and, after you agree, the printed
apply command.

```bash
gbrain repair frontmatter --source <id>                          # pass 1: safe changes, one sample diff per class
gbrain repair frontmatter --source <id> --apply --expect <hash> --yes
gbrain repair frontmatter --source <id> --include-ambiguous --diff   # pass 2: every interpretation, per file
gbrain repair frontmatter --source <id> --include-ambiguous --only notes/a.md --apply --expect <hash> --yes
```

Each file gets one minimal line change in one class:

| Class | Changes | Default |
| --- | --- | --- |
| `safe` | Quote a value exactly as gbrain already reads it, strip NUL bytes, swap the outer quotes of a nested quoted value. Every parsed value stays the same. | Included. |
| `interpretive` | Fold unquoted continuation lines into the value above, keep the later of a duplicated key, quote an unclosed `[`/`{` or a `#`-leading title, insert a missing closing `---`, remove a `slug:` line that names another page, re-import a page from its file, re-bind a held rename to the old page's current revision. | Only with `--include-ambiguous`. |
| `needs_review` | No rule fixes it (mis-indented YAML, a protected key such as `visibility`, an import that would keep page data the file does not carry, a file over the [page size limit](memory-boundaries.md#large-page-limits)). | Never written. The preview names the exact manual fix. |

Two passes: when interpretive candidates exist, the safe preview's
`next_actions` carry both the safe apply and the `--include-ambiguous` preview.
Review each interpretation in the full diff, then approve all of them or only
some with `--only`/`--skip`; a file left out stays held and unchanged.

Every change must leave a file that parses strictly and earns no hold. The
hash binds the selected files, their exact before and after bytes, and the
page each import would store (bound to the page revision). The apply derives
each change again from the file as it is: a file, proposal or page that
changed since the preview reports `changed_since_preview` and is not written.
The apply refuses a selected file a write in flight or an unfinished managed
sync's frozen manifest still names (`sync_in_progress`, checked again when the
write is admitted; finish the sync with `gbrain sync --source <id> --no-pull`
or let the next run pick the file up).

On a managed brain each file is one coordinated write (`managed_file_repair`):
the exact approved bytes, the import, and the hold clear commit together, and
the file is committed through the Git effect like any page write. On a legacy
brain the apply backs each file up under `~/.gbrain/backups/frontmatter/`,
writes it, imports it, clears its hold and prints the `git add`/`git commit`
step. Per-file outcomes report `written`, `imported`, `hold_cleared` and
`committed`. Repair stays explicit-only: `gbrain repair --all` and
`gbrain doctor --remediate` never run it.

<a id="fences"></a>
### Fences

A facts or takes fence gbrain cannot import without guessing never blocks a
sync: sync holds the one file and imports the rest, and a fence with one exact
meaning is rewritten in the same write. `gbrain repair fences` repairs what is
left, and the maintenance run (cycle phase `fence_repair`) applies the same
repair by itself on the brain's owner host, so a fence hold usually clears with
no command. It finds held files, stored pages whose fence does not parse, and
checkout files not yet synced. The preview is read-only and makes no model
call; applying needs no extra consent. What each reason means and who acts:
[fence holds](write-refusals.md#invalid_fence); the format and every rule:
[fence format](fence-format.md).

**Say to your agent:** *"Sync held some pages because of their facts or takes
tables. Show me what gbrain would change, then repair them."* or *"How many
broken facts tables are left, and what will fixing them cost?"*

Each candidate gets the cheapest tier that repairs it exactly:

| Tier | What it does | Cost |
| --- | --- | --- |
| `deterministic` | The lossless rules every write already runs (missing end marker, stray empty cells with one valid removal, row numbers, header aliases and order, enum and kind synonyms, assistant holders, percent confidences). | Free. |
| `resolver` | A holder written as a display name becomes the `people/` or `companies/` page it names, only on an exact match (slug, unique slug basename or alias; never a guess, never a private page on a world-visible page). | Free. |
| `llm` | Rows only a rewrite can realign (no header, a header column with no canonical name, rows above the header, short rows). The repair model sees only the fence header and those rows, never valid rows of a row-level problem and never the rest of the page, with no tools, and answers HOLD instead of guessing when a row has two readings. | Paid, within `fences.repair.max_usd_per_page` ($0.30) and `fences.repair.max_usd_per_day` ($1.00). |
| `manual` | Anything gbrain never guesses (a stray end marker, an unknown takes kind, a weight out of range, a holder no page matches, extra cells that removing empty cells cannot line up, a sentence in the facts `kind` column). The preview names the exact edit. | Your edit. |

Every proposal, whichever tier made it, must pass the validation
[gates (a) to (g)](fence-format.md#gates) against the bytes as read (claims,
existing row numbers and valid cells unchanged, no row more visible, nothing the
fence hid shown) and be a normalizer fixed point, or it is not written. A model
proposal that does not parse or changes the row count (gates (a) and (e)) gets
one corrective re-ask naming the gate and rows; any other gate rejection, a
HOLD, or a failed re-ask leaves the file held, and the same bytes are never
sent again until the file, the model or the rules change.

The repair model is `models.fence_repair` when set. Unset, it is the first
model the fence-repair eval measured as accurate enough whose provider key the
brain has: `openai:gpt-6.1-sol` with an OpenAI key, else
`anthropic:claude-opus-5-5` with an Anthropic key. With neither key, model-tier fences wait as
`no_measured_model` until the user picks a model.

The gates check that no text is lost or rewritten; they cannot tell which of two
free-text columns a moved cell belongs in, which is why only measured models
are defaults. On 40 held-out synthetic malformed fences over three runs
(`evals/fence-repair-tier3`), `openai:gpt-6.1-sol` and
`anthropic:claude-opus-5-5` each repaired 95 of the 99 attempts that reached
the model, none with a cell in the wrong column, and answered HOLD on the
other 4; rows with stray empty cells were lined up by the free rule instead.

The session below is real output (volatile ids, hashes and times shown as
`<id>`, `<hash>`, `<time>`; `test/fence-walkthrough.test.ts` runs these
commands against a local stand-in for the model provider and checks every line
shown). Before the upgrade a generator committed three notes to the `notes`
source: a meeting note whose facts fence has no end marker and an invented
kind, a company note whose facts rows have no header, and a project note whose
takes row names its holder as `Alice Example` (a `people/alice-example` page
exists). An older gbrain blocked the source on the first fence it refused.

1. After upgrading, `gbrain post-upgrade` names the blocked source, the
   malformed-fence count, the preview and the pause command. No maintenance
   run is active on this brain yet, so nothing repairs the fences by itself.

   ```console
   $ gbrain post-upgrade
   [AGENT]   fence_integrity: 3 (not repaired automatically (no maintenance run is active); preview with: gbrain repair fences)
   [AGENT]   fence_holds: 1 source(s) are blocked by a file whose facts or takes fence gbrain could not import (notes). The next scheduled or manual sync recovers each with no command; to do it now run gbrain sync --source notes --no-pull. The file is then held and the rest of the source imports. 3 malformed fence(s) are known so far (gbrain doctor --only fence_integrity counts them by tier); nothing repairs them by itself until a maintenance run is active, so preview them and apply the plan the preview prints once the user agrees. Preview (read-only, no model call): gbrain repair fences. Pause automatic fence repair first with: gbrain config set fences.repair.enabled false. Recipe: docs/guides/repair.md#fences
   ```

2. One sync gets the source going again: the blocked request is converted in
   place, the meeting note's fence is rewritten (claims and row numbers
   unchanged), and the other two files are held while the rest imports.

   ```console
   $ gbrain sync --source notes --no-pull
   +1 added, ~0 modified, -0 soft-deleted (recoverable 72h), R0 renamed
   Held companies/acme-example.md: invalid_fence (no_header) in the facts fence (body), at line 6; its page is missing until the file imports. Next: gbrain repair fences --source notes --only companies/acme-example.md, then gbrain repair fences --source notes --only companies/acme-example.md --apply (docs/guides/write-refusals.md#fence-no_header)
   Held projects/widget-launch.md: invalid_fence (holder_unresolved) in the takes fence (body), row 1, column who, at line 9; its page is missing until the file imports. Next: gbrain repair fences --source notes --only projects/widget-launch.md, then gbrain repair fences --source notes --only projects/widget-launch.md --apply (docs/guides/write-refusals.md#fence-holder_unresolved)
   2 file(s) held this run, 2 held in source notes; they do not block sync. Inspect them with 'gbrain sources status notes'; then nothing repairs the fence and slug-conflict holds by itself (no maintenance run is active), so preview the content repairs with gbrain repair content --source notes (read-only, no model call: it lists each held file with its planned repair or the exact edit, kind by kind, and prints the apply command with --expect <hash>[,<hash>]), then run the apply command it prints. Preview the repair: gbrain repair content --source notes
   Converted 1 failed request(s) of the blocked cursor in place: <id>.
   Normalized fences in 1 file(s) (kind_map x1, close_fence x1). 1 file(s) under meetings/ had a malformed facts or takes fence that sync rewrote losslessly and committed (claims and existing row numbers unchanged); whatever writes them emits fences gbrain has to repair. Write facts with `remember` and takes with `takes_add` (or emit the canonical columns) so rows never need normalizing. Re-read a normalized page before editing it.
   ```

3. `gbrain sources status <id>` lists each fence hold with its fence, section,
   row, column, line and next step (`--json` adds the structured `fence` object:
   reasons, rows, columns, tier, `auto_retry` and `next_attempt_after`).

   ```console
   $ gbrain sources status notes
   Held companies/acme-example.md: invalid_fence (no_header) in the facts fence (body), at line 6; its page is missing until the file imports. Next: gbrain repair fences --source notes --only companies/acme-example.md, then gbrain repair fences --source notes --only companies/acme-example.md --apply (docs/guides/write-refusals.md#fence-no_header) Held since <time>.
   ```

4. Preview. Nothing is written and no model is called. The resolver tier shows
   its exact diff; the model tier shows the rows it will rewrite and the
   estimated cost against what is left of today's cap.

   ```console
   $ gbrain repair fences --source notes
   cost: 2 request ID(s), 32768 receipt bytes, 2 page(s) to re-embed, paid model ~$0.0273 ($1.0000 left under today's cap)
   llm: notes:companies/acme-example.md (no_header; rewritten by openai:gpt-6.1-sol at apply time, gated by (a)-(g); est. $0.0273)
   resolver: notes:projects/widget-launch.md (holder_verified; rows 1)
   tiers: deterministic=0, resolver=1, llm=1, held=0; model openai:gpt-6.1-sol
   model caps: $0.30/page, $1.00/day ($1.0000 left today)
   -| 1 | The launch slips a week | bet | Alice Example | 0.6 | 2026-04 | standup |
   +| 1 | The launch slips a week | bet | people/alice-example | 0.6 | 2026-04 | standup |
   next: gbrain repair fences --source notes --apply --expect <hash>
   Kinds that may call a paid model: fences (estimated $0.0273; $1.0000 left under today's cap).
   ```

5. Apply exactly the previewed set. A file that changed since the preview is
   skipped as `changed_since_preview`. Each file is one coordinated write: the
   repaired bytes, the import and the hold clear commit together.

   ```console
   $ gbrain repair fences --source notes --apply --expect <hash>
   cost: 2 request ID(s), 32768 receipt bytes, 2 page(s) to re-embed, paid model $0.0039 spent ($0.9961 left under today's cap)
   applied 2, skipped 0, failed 0, complete
   repaired 2; nothing left in this selection
   repaired: notes:companies/acme-example tier=llm, classes=no_header, slug=companies/acme-example, mode=managed, path=companies/acme-example.md, imported=created, hold_cleared=true, committed=queued
   repaired: notes:projects/widget-launch tier=resolver, classes=holder_verified, slug=projects/widget-launch, mode=managed, path=projects/widget-launch.md, imported=created, hold_cleared=true, committed=queued
   ```

   `committed=queued` means the Git target effect records the change. On a
   checkout with gbrain's Git durability hook (`gbrain sources harden <id>`)
   the owner's persistence worker commits each repaired file with the subject
   `gbrain: repair fence in <path> (<classes>)` (a commit that batches several
   lists one `<path> (<classes>)` per body line). This checkout has no
   durability hook, so the rewritten files (the meeting note sync normalized,
   too) stay uncommitted: commit them the way you commit any edit.

6. Commit and check. Doctor `fence_integrity` is `ok` once nothing is held,
   stored malformed or waiting in the checkout.

   ```console
   $ git -C ~/brain/notes status --short
   M companies/acme-example.md
   M meetings/2026-04-03.md
   M projects/widget-launch.md
   $ git -C ~/brain/notes commit -q -m "Repair fences" -- companies/acme-example.md meetings/2026-04-03.md projects/widget-launch.md
   $ gbrain doctor --only fence_integrity
   [OK] fence_integrity: No malformed facts or takes fence is held, stored or waiting in a checkout (2 source(s) scanned).
   ```

One command got the source syncing again (the sync), and two repaired the rest
(preview, apply), for $0.0039 of model spend.

Selection and output:

```bash
gbrain repair fences --source <id> --only companies/acme-example.md   # one file; --skip <path> leaves one out
gbrain repair fences --source <id> --slug notes/db-only               # a stored page with no file
gbrain repair fences --source <id> --diff                             # every diff, not one sample per tier
gbrain repair fences --source <id> --no-llm                           # free tiers only; model-tier items stay held (llm_disabled)
gbrain repair fences --source <id> --max-usd 0.10                     # at most $0.10 on the model this run (lowers the cap only)
gbrain repair fences --source <id> --json                             # every diff and the full result
```

The selection and `--no-llm`/`--max-usd` are bound into the preview hash and
printed in its apply command. A bare `--apply` (what `gbrain repair --all`,
`gbrain doctor --remediate` and the maintenance run use) applies the current
plan. The result keeps the shared `complete` (every pending item was tried) and
adds `repaired` (what this run repaired), `remaining` (what still waits, by
reason), `scan` (`fresh_at`, `partial`: whether the census behind the plan
finished) and `verification` (repairs per tier, holds per reason, the oldest
hold and USD per model repair). A run whose every model proposal is rejected
reports `repaired 0` with the gate reasons; a run that ends with only manual
edits left exits 0. When the daily ledger refuses the next model call, the run
stops with `budget_exhausted` and exits 1, naming what was spent against the
cap, the reset time (the next 00:00 UTC), the pages still waiting and the fix
`gbrain config set fences.repair.max_usd_per_day <usd>`: raising it is the
user's call.

Where each repair writes: a managed source through `managed_file_repair` (bound
to the file's before-hash and page revision, committed through the Git effect);
a legacy (unmanaged) source by backing the file up under
`~/.gbrain/backups/fences/<run>/`, writing it, importing it and recording an
"uncommitted fence repair" notice that `gbrain sources status` and doctor show
with the exact `git add`/`git commit` step until the path is committed; a
stored page with no file by a revision-bound page write; a read-only mirror in
the database only (the file is never written). Every write's receipt carries
the actor `fence-repair`, the tier, the classes, rows and columns, the model,
the before and after sha256 and the cost, never a cell value. MCP and
thin-client callers cannot run a repair or reach the model; a hold's fix hands
them the owner-host command to give the user.

<a id="fence-repair-during-a-sync"></a>
#### Fence repair during a sync

A running `gbrain sync` of the source no longer stops the repair. Each
candidate is checked on its own against the sync's busy set, and only the
ones below wait as `sync_in_progress`; every other candidate is repaired while
the catch-up runs, including a file the sync held earlier (a held path is not
busy, because the sync retries a held file only once its bytes change, and
the repair is what changes them).

| Busy (waits as `sync_in_progress`) | Why |
| --- | --- |
| A file or page a queued, running or recovering write names, or a finished write whose recovery is still open; both endpoints of a rename | The write is still publishing it. |
| A file still ahead in the running sync's frozen manifest (from the cursor's index on) | The sync admits it later with the raw hash it reads then; a repair that changed the bytes first would make that entry refuse (`source_changed`). |
| Every candidate, when the busy set cannot be read (a failed query, a cursor whose manifest is missing) | The check fails closed; the hold's text says so. |

The busy set is read when the plan is made, again when each item is applied
(a sync may have started since the preview), and once more when the managed
file write is admitted, because a sync can freeze the candidate while the
repair waits on its model call. An item caught at that last check is skipped
`sync_in_progress`, nothing is written, and its model attempt is recorded as
transient, so the next run sends the same bytes again.

<a id="owner-reasons"></a>
#### Owner reasons

Fence repairs write only on the host that owns the source's checkout. When
this host may not, the candidate is skipped with the condition as its reason
(the same reasons `gbrain errors owner_unavailable` lists and chronicle and
the other maintenance writers refuse with), and the hold records it:

| Reason | What it means | Who acts | Next |
| --- | --- | --- | --- |
| `host_mismatch` | Another host id owns the checkout; the text prints both ids' first 8 characters and, for a local caller, the `host.json` path this process read. Two environments on one machine with different `GBRAIN_HOME` values (a launchd or cron worker and a shell) look exactly like this. Not retryable. | host administrator | Run the repair on the owner host (`gbrain sources writer status --source <id> --json` names it), or give the worker and the shell one `GBRAIN_HOME`. Never copy or regenerate `host.json`. |
| `transfer_in_progress` | The worktree is draining for a prepared writer transfer. | nobody | Wait 30 s and retry; the next maintenance run repairs it once the transfer is accepted or cancelled. |
| `clone_in_progress` | A topology clone or reclone is recovering the worktree. | nobody | Wait 30 s and retry; the next run repairs it once the clone finishes. |
| `incarnation_changed` | The checkout binding is from an earlier incarnation of the source (removed and re-added, or restored). | host administrator | Review writer status and re-bind the checkout. |
| `local_path_missing` | This host owns the worktree but has no checkout path registered. | host administrator | Review writer status and register the checkout again. |
| `coordination_path_missing` | This host's registration has no coordination directory. | host administrator | Review writer status and repair the registration. |
| `owner_unavailable` | The generic fallback: a source with no owner at all, or an older hold. | host administrator | Review writer status. |

Nothing in this path claims or transfers ownership to get a repair through;
the fix is always the read-only writer status. Remote callers get the host ids
but never a local path.

Inspect or undo a repair:

- Managed sources: `git log --grep 'repair fence in'` lists the repair commits,
  `git show <commit>` the change, and `git revert <commit>` undoes it (for one
  file of a batched commit, `git checkout <commit>^ -- <path>` and commit).
- Stored pages: `gbrain history <slug>` shows every version, including the one
  before the repair; `gbrain revert <slug> <version_id>` restores it.
- Legacy sources: the original file is in the backup the apply output names;
  copy it back and sync.

Turning the settings off stops future repairs and does not undo past ones. A
restored malformed fence is held again on the next sync and repaired again by
the next maintenance run, so pause first if you want to keep the original.

| Setting | Default | Effect |
| --- | --- | --- |
| `fences.repair.enabled` | `true` | `false` pauses the maintenance run's repair; `gbrain repair fences --apply` still works. |
| `fences.repair.llm` | `true` | `false` keeps every repair to the free tiers; model-tier holds stay `llm_disabled`. |
| `fences.repair.max_usd_per_page` | `0.30` | The most one page may spend on the model, checked against each call's worst case (the prompt plus the full output ceiling, with 2,048 tokens for a reasoning model to think). `0` means no model spend. |
| `fences.repair.max_usd_per_day` | `1.00` | The most all processes together spend per UTC day, through a durable ledger. `0` means no model spend. |
| `models.fence_repair` | unset: the first measured model with a key (`openai:gpt-6.1-sol` with an OpenAI key, else `anthropic:claude-opus-5-5` with an Anthropic key), else none | The model Tier 3 calls (`gbrain models` shows it). A model you set always runs; one gbrain has no price for runs under the default caps at an estimated ceiling (the highest chat rate gbrain knows; `gbrain pricing set` makes it exact) and waits for its price under a cap you set. |
| `fences.normalize` | `true` | `false` stops the inline rewrite on writes and syncs: a fixable fence is held or refused like any other. |

<a id="unindexed-files"></a>
### Unindexed files

A file an older gbrain refused before refusals became holds has no page and no
hold; incremental sync never revisits it. The
maintenance phase `unindexed_files` finds such files (bounded, never
clean while incomplete) and schedules a re-screen; doctor
`unindexed_files` reports them. Run `gbrain sources retry-held <id> --unindexed`, then the sync it prints: each file imports or becomes a
[hold](#held-files). `slug_taken` (the path slug belongs to another page) and `deleted_page`
(the page was deleted while the file stayed committed) are never scheduled:
rename one of the two files, or delete the file or restore the page.
`metafile_skipped` (never scheduled) lists titled scaffolding files sync skips
on purpose (`index.md`, `README.md`, ...): rename one
(`investors/fund-a/index.md` to `investors/fund-a.md`), commit and sync.

## Resume

Runs are resumable. After each page commits, the position is saved under the
kind, the brain and the source list. Rerunning the same command (the same kind
and `--source`) continues after the last committed page, and the preview says
`resuming after item ...`. A finished run clears the saved position. `--limit`
does not change the position key, so `--limit 500` batches continue each other.

Request IDs are derived from the page and its revision, so rerunning after a
crash replays the same write instead of making a second one. If the run stops
with "still pending publication" or "the canonical writer ... is held", check
`gbrain sources writer status <source>`, then rerun the printed apply command.

Every applying kind waits for each publication with the CLI write wait: `--wait <seconds>`, then
`GBRAIN_WRITE_WAIT_MS`, then `persistence.write_wait_ms`, else 30 seconds. That includes the doctor
remediation run and the replay of a restore a previous `extractor-facts` apply left pending.

A write that is accepted but still pending when its wait ends does not stop the run while a consumer
on this host is publishing (#6543). The run keeps the receipt, leaves its saved position before that
item, and admits the remaining items without a per-item wait. At most half the principal's
outstanding-request cap (`persistence.limits.principal_outstanding`, at most 64) stays unresolved at
once; past that the run waits for earlier receipts first. All receipts settle against one shared wait:
the run gives up only when nothing it admitted has published for the write wait. A preview-bound kind
(`--expect`) settles every earlier receipt before its last item, so its approved set is kept until
every admitted item is accounted for. When the run still stops, `pending` lists the receipts (item and
`request_id`) and rerunning the same apply command replays them; a crash leaves the position before
the first unresolved receipt, so the rerun does the same. `--wait 0` waits for nothing: it admits what
it can and stops with `pending`. With no live consumer on this host, or one that reports
`restart_required`, the run stops at the first pending write as before and its `fix` names the owner. A malformed
`GBRAIN_WRITE_WAIT_MS` refuses the apply with `invalid_write_wait` before anything is written; a preview
never reads it.

## Capacity stop

`timeline` and `visibility` write through the managed write journal, which has
permanent per-principal and per-brain limits on request IDs and receipt bytes.
Before each page, the repair checks those counters and stops before it would
cross 90% of any limit. The stop message names the setting and a value that
lets the remaining pages finish:

```text
STOPPED: Stopped before crossing 90% of brain lifetime_ids (...). Run: gbrain config set persistence.limits.brain_lifetime_ids 1200000 — then rerun `gbrain repair timeline --apply` to resume.
```

Raise the limit on the brain host only if you agree, then rerun. Raised limits
are brain-wide; request IDs stay permanent replay protection. `safe-chunks`
and `contextual-mode` take no journal admission and never hits this stop. The limits and their
defaults are in [bounded admission and retention](concurrent-writes.md#bounded-admission-and-retention).

## Where it runs

Run `gbrain repair` on the brain host, the machine that holds the database. A
thin client refuses before doing anything:

```text
`gbrain repair` is not routable. repair runs on the brain host (it publishes coordinated page writes against the local engine). Run `gbrain repair` on the brain host.
```

A repair is an ordinary trusted local write and follows the same rules as
any other page save. It never transfers an existing owner and does not change
activation, sync checkpoints or search settings. Like any local save on a
PGLite brain, the first `timeline` or `visibility` write to a source with a
configured checkout and no owner yet claims that checkout for this host. Do not set
`search.remote_private_pages` to get derived pages back remotely: that exposes
every private page.

## Verify

```bash
gbrain repair --json     # every kind reports "affected": 0
gbrain doctor --json     # timeline_history, derived_visibility, safe_index_pending
gbrain doctor --remediation-plan   # no repair steps left
```

Items the repair leaves alone can keep a doctor warning: concepts without
lineage still count under `derived_visibility`, and code pages without a
source path or unsupported page kinds still count as unsealed pages. Check
the residual counters before treating a remaining warning as a failed repair.

## Run repairs through doctor

**Say to your agent:** *"Preview what doctor would fix after the upgrade, then
run the repairs I agree to with a $2 cap."*

`gbrain doctor --remediation-plan` previews two kinds of step. Job steps come
from the brain score and `--target-score`. Repair steps come from every
`gbrain repair` kind that has pending items, whatever the score target, and
each is marked `requires user agreement`. Every step prints the exact command
that applies it, and the plan ends with one combined command:

```text
Repair steps: 2 (requires user agreement; PROTECTED, run on this host only; independent of the score target)
  R1. timeline — 12 item(s) (free) [requires user agreement]
     apply: gbrain repair timeline --apply
  R2. safe-chunks — 40 item(s) (~$0.0031 embeddings) [requires user agreement]
     apply: gbrain repair safe-chunks --apply

Apply everything after the user agrees: gbrain doctor --remediate --yes --include-repairs --max-usd 0.01 --expect ph_3f9c2a1b7d4e5f60a1b2c3d4
Ask the user before applying any repair step.
```

The plan never includes an explicit-only kind as a repair step. It prints them
in an `Explicit-only repairs` block instead, one line per kind with its
read-only preview command (`stale-atoms: gbrain repair stale-atoms`), and
`--json` lists them as `explicit_repairs[]` (`kind`, `code:
"explicit_kind_required"`, `preview_command`, `docs`). Run each by name after
the user agrees (see [Explicit-only repair kinds](#explicit-only-repair-kinds)).

A repair kind whose preview errors (on a large brain this is usually a
statement timeout) does not stop the plan. Every other kind is still
previewed, and the failed kind is listed under `Repair kinds whose preview
failed` with its error code, its error and the read-only command that
repeats the preview. In `--json` it appears in `repair_preview_failures[]`,
which is present only when a preview failed. Each entry is
`{kind, code, message, why, fix}`: `code` is `timeout` for a statement
timeout (raise `GBRAIN_STATEMENT_TIMEOUT`) and `preview_failed` for anything
else, `message` is redacted and then capped at 300 characters, and `fix` is
the read-only preview. A failed kind is never a step, so `gbrain doctor
--remediate` runs the remaining steps, names the kinds it could not run and
exits 1. An approval covers only the steps the user was shown: once the
failed preview succeeds, the plan changes and the run refuses with
`preview_changed`. Preview the plan again and ask the user.

`gbrain doctor --remediate --yes` runs job steps only. Repair steps run only
when you also pass `--include-repairs`, which records the user's agreement;
without it they are listed as `N repair steps skipped (user agreement required):
re-run with --include-repairs`. Repair steps are PROTECTED: they run in this
process on the brain host, and a remote caller cannot include them. They run
even when the score target is unreachable (a keyless brain often cannot reach
90); `--target-score` governs job steps only, and an included repair step runs
to completion.

`--max-usd <n>` is a cumulative cap across the run and every `--resume`. A paid
step (one that may queue embeddings) whose estimate exceeds what is left is not
started; the free steps still run, and the run then stops as budget-exhausted
with a resume command that repeats the cap and `--include-repairs`:

```text
Resume with:
  gbrain doctor --remediate --yes --include-repairs --max-usd 0 --resume 3f9c2a1b7d4e5f60
```

The checkpoint lives in `~/.gbrain/remediation/<plan hash>.json` on this host
and records the brain, the cap, the `--include-repairs` agreement, the spend so
far and the original steps. `--resume` without `--max-usd` reuses the recorded
cap and prints it; a higher `--max-usd` raises it. A resume only continues the
original steps: repair kinds or job steps found later need a fresh run and a
fresh agreement. A checkpoint recorded for another brain is refused.

When an embedding model is configured, every kind can spend. `timeline` and
`visibility` publish page writes whose embeddings the persistence consumer
computes afterwards, outside this run, so their estimate is charged against the
cap before they start; `--no-embed` does not change that. The consumer does
not see the cap, so for those kinds the cap bounds the estimate, not each
provider call, and the estimate counts the page as it is before the repair.
`safe-chunks` embeds in the run itself under the remaining cap and
`--no-embed` makes it free. When the budget runs out after pages are re-sealed,
the checkpoint keeps their sources and `--resume` finishes their embeddings
under the same cap; a run that leaves embeddings behind exits 1 and says to run
`gbrain embed --stale`.

With `--json`, the result adds `repairs[]` (one entry per repair step, with
`status` `completed`, `stopped`, `failed`, `budget_refused` or
`budget_exhausted`), `repairs_skipped[]`, `budget`, `repairs_completed`,
`healthy` and `findings[]`. Each finding has a `check_id`, a `message` and a
`class`:

| Class | Meaning |
| --- | --- |
| `cleared` | The finding was present before the run and is gone after it. |
| `pending` | A repairable finding remains: its step stopped, was refused by the budget, left items behind, or the check could not run. |
| `consent_required` | A repairable finding whose step was skipped for lack of `--include-repairs`; `command` applies it. |
| `operator_required` | Needs a named manual action on the brain host (`instruction`), for example raising a journal limit, retrying a parked effect, or quarantining self-captures. |
| `explicit_kind_required` | Only an explicit-only kind clears it (for example `atom_provenance_drift` and `stale-atoms`); `command` is that kind's read-only preview. It never runs under `--remediate` and does not fail the exit status. |
| `unsupported` | No command can clear it yet; it is reported so it is never hidden (a stale queued embedding effect). |

Exit status: `0` when no automatically repairable finding remains and no step
failed, even if operator-required, explicit-only or unsupported findings
remain (they are listed); `1` when a repairable finding remains, a step failed, or the budget
ran out; `2` when the score target is unreachable and there was no repair step
to run, or a resume was refused. `healthy` is true only when every recovery
check is clean after the run; `repairs_completed` counts the repair steps that finished.

### Doctor budgets

Every doctor check runs under a budget, so a slow check reports `unknown` instead of holding the run.

- **Order:** the ops sections run first, then the cheap incident checks (`persistence_capacity`, `managed_sync_not_moving`, `managed_sync_blocked`, `text_projection_readiness`, `partial_embedding`, `links_extraction_lag`), then the full scans.
- **Per check:** `doctor.entry_budget_ms` (default 15000). A check's database statements stop at its budget: Postgres cancels the statement; PGLite refuses the next one but cannot stop one already running, so a check there can finish late. The frontmatter and fence scans report what they read by then.
- **Per run:** a non-interactive `gbrain doctor --json` (stderr not a terminal, no `--budget-ms`, `--tier`, `--fix` or remediation flag) caps its check run at `doctor.default_budget_ms` (file plane, default 90000; connect and migrations are not counted) and says so on stderr. `--budget-ms 0` turns it off for one run; `gbrain config set doctor.default_budget_ms 0` turns it off for good.
- **Past a budget:** the check reports `details.health: "unknown"` with `details.limit` (`entry` or `overall`) and prints `gbrain doctor --only <check> --budget-ms N --json`, which gives that check the whole N.

## Recover after an upgrade

<a id="recover-after-upgrading-to-this-release"></a>

**Say to your agent:** *"We just upgraded gbrain. Check what needs repair and
walk me through it before changing anything."*

1. `gbrain post-upgrade` runs the recovery checks once and, when something
   needs attention, prints an `[AGENT] Relay this to your operator` banner with
   each finding's count. It never applies anything.
2. Preview: `gbrain doctor --remediation-plan`. Show the user the repair steps
   and their estimated cost, and ask before applying.
3. After the user agrees, apply with a budget:
   `gbrain doctor --remediate --yes --include-repairs --max-usd <n> --expect <plan_hash>`
   (the plan prints `<n>` and `<plan_hash>` filled in; `--remediation-plan --json`
   reports the hash as `plan_hash`). If the plan changed since the preview, the
   run refuses with `preview_changed` and changes nothing: preview and ask again.
4. If it stops as budget-exhausted, ask the user again, then run the printed
   resume command (raise `--max-usd` only with their agreement).
5. Follow each `operator_required` instruction the run prints, and note the
   `unsupported` ones.
6. Verify: `gbrain doctor --remediation-plan` lists no repair steps.

<a id="repair-upgrade-symptoms"></a>

| Symptom or error text | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- |
| Sync `BLOCKED` on one file (`Invalid YAML frontmatter`, a frontmatter slug conflict, `Content too large`); after upgrading, sync prints `Held <path>: …`; doctor `git_held_files` or `frontmatter_repairable` warns; the upgrade banner prints `frontmatter_holds:` | `gbrain sources status <source>`, then `gbrain repair frontmatter --source <source>` (add `--include-ambiguous` for interpretations) | nothing to unblock: the next sync converts the blocked request in place (`gbrain sync --source <source> --no-pull` does it now); for the backlog, the printed `gbrain repair frontmatter … --apply --expect <hash> --yes` ([held files](#held-files)) | `gbrain doctor --only git_held_files,frontmatter_repairable --json` (both ok) | brain host; the repair apply after the user agrees | `destructive` (repair apply rewrites the previewed lines) |
| Tag, timeline or take writes fail with `writer_coordinator_required` or `storage_error: Publication failed (P0001)` on a managed brain; sync ends `PARTIAL` at a tagged page | `gbrain doctor --json` (`schema_version` is 197 or later) | the original `gbrain sync --source <source> … --no-pull --json`, then `gbrain extract --stale --source-id <source>` and `gbrain extract timeline --source db --source-id <source>`, then `gbrain facts relink --source <source> --dry-run` (paid tier only after the user agrees), then `gbrain repair failed-writes --source <source>` and, after the user agrees, its printed `--apply --expect <hash>` | `gbrain sources status` shows the new `last_commit`; a second `gbrain extract timeline --source db` run adds no rows; a second `gbrain repair failed-writes` preview lists nothing to replay | brain host; the replay apply after the user agrees | paid (relink tier), destructive (replay apply) |
| Sync `BLOCKED` with `checkpoint_validation_timeout` | `gbrain doctor` (`persistence_request_indexes`) | `gbrain repair request-indexes --apply` when an index is missing or INVALID, then the printed `gbrain sync --source <source> --no-pull …` | `gbrain doctor --only persistence_request_indexes --json` reports `ok`; `gbrain sources status` shows the new `last_commit` | brain host | none |
| Doctor `persistence_request_indexes` warns | `gbrain repair request-indexes` | `gbrain repair request-indexes --apply` | `gbrain doctor --only persistence_request_indexes --json` | brain host | none |
| Doctor `persistence_request_growth` warns | `gbrain doctor --json` | the printed `gbrain config set persistence.limits.<limit> <value>` | `gbrain doctor --only persistence_request_growth --json` | brain host | none |
| Working-tree sync prints `legacy file(s) skipped … no contextual retrieval mode` | `gbrain repair contextual-mode` | `gbrain repair contextual-mode --apply` | the next `gbrain sync --working-tree` no longer prints the line | brain host, after the user agrees | none |
| Working-tree sync prints `legacy file(s) skipped … not valid UTF-8` | `find <checkout> -name '*.md' ! -exec iconv -f UTF-8 -t UTF-8 -o /dev/null {} \; -print` | re-save each listed file as UTF-8 | the next `gbrain sync --working-tree` no longer prints the line | user (re-saves the files) | none |
| Doctor `google_file_modes` warns, or the upgrade printed `[google] Google source <id> keeps its files in <dir>, outside ~/.gbrain` | `gbrain repair google-file-modes --source <id>` | `gbrain repair google-file-modes --source <id> --apply` | `gbrain doctor --only google_file_modes --json` (`google_file_modes` ok) | brain host, after the user agrees | none |
| Recall or hot memory returns facts from gbrain's own claude-cli sessions or from pasted text; doctor `captured_facts_active` warns; the upgrade banner prints `captured_facts_active: N (explicit_kind_required; …)` | `gbrain repair captured-facts` (add `--include-ambiguous` to include paste candidates) | `gbrain repair captured-facts --apply --expect <hash>` with the hash that preview printed | `gbrain doctor --only captured_facts_active --json` (`captured_facts_active` ok) | brain host, after the user agrees | `destructive` (quarantines facts) |
| A finished promise still shows on entity cards and in recall after its loop was closed; doctor `loop_facts_drift` warns; the upgrade banner prints `loop_facts_drift: N (explicit_kind_required; …)` | `gbrain repair loop-facts` | `gbrain repair loop-facts --apply --expect <hash>` | `gbrain doctor --only loop_facts_drift --json` (`loop_facts_drift` ok) | brain host, after the user agrees | `destructive` (retires facts) |
| `gbrain upgrade` refuses with `requires Bun >=<floor>` (exit 78), or doctor `self_upgrade_health` says `Auto-upgrade to <target> held` | `bun --version` | `bun upgrade`, then `gbrain upgrade` ([Bun floor](upgrades-auto-update.md#bun-floor)) | `gbrain --version` shows the target; `gbrain doctor --only self_upgrade_health --json` (`self_upgrade_health` ok) | user | `persistent_install` |

**Say to your agent:** *"After the upgrade, preview the captured-facts and
loop-facts repairs and tell me what each would expire before applying
anything."* The agent runs `gbrain repair captured-facts` and `gbrain repair
loop-facts`, shows you both lists, and after you agree runs each printed
`--apply --expect <hash>` command. See [Captured facts](#captured-facts) and
[Loop facts](#loop-facts).

Hosted and thin-client callers see the same checks in `gbrain remote doctor`
as one line each, for example
`timeline_history: ... host operator action required: on the brain host run gbrain doctor --remediation-plan`.
A line that says `Unknown:` means the check could not run; it is not a clean
result. Ask the brain host's operator to run the steps above.

<a id="fix-wave-6"></a>
### Upgrading to v0.60.30.0

**Say to your agent:** *"We upgraded gbrain to v0.60.30.0. Preview the
unlinked facts relink and the link re-derivation for each source, and tell me
what would change before applying anything."*

`gbrain upgrade` applies migrations v187 (fact relink attempts) and v188 (the
per-stint ontology dedup index). Restart every `gbrain serve`, autopilot and
worker so they run the new code, then work through what applies:

<a id="repair-recall-symptoms"></a>

| Symptom | Check or code | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- | --- |
| "Who invested in X?" or "Who attended <meeting>?" finds nobody; meeting attendance edges point meeting -> person, or notes-only mentions are typed attended | none | `gbrain extract links --source db --repair-attendance --source-id <id>` (attendance only, preview-bound) | `gbrain extract links --source db --include-frontmatter --source-id <id>` per source; body links also re-derive on the next `gbrain extract --stale` | `gbrain graph <person-slug>` shows person -> page `invested_in` / `attended` edges | brain host, after the user agrees | none |
| Facts saved without an entity are missing from entity recall and skipped as `no_entity` by the conflict sweep | doctor `unlinked_facts` | `gbrain facts relink --dry-run` | `gbrain facts relink` (model tier capped by `--max-usd`, default $1.00) | `gbrain doctor` (`unlinked_facts`); `gbrain decide status` | agent, after the user agrees | `paid` (capped by `--max-usd`) |
| `remember` answers `warnings: ["NO_ENTITY"]` | none | none | pass `entity`, or name exactly one existing person or company in the text; `gbrain config set facts.entity_inference off` turns inference off | the response carries `entity_inferred` or the chosen entity | agent | none |
| A CLI write on PGLite pauses for up to 30 s, then fails lock-busy | lock busy | none | wait for the other CLI call, or stop the long-running non-serve holder (for example a jobs daemon) | re-run the write | agent | none |
| The next `gbrain eval suspected-contradictions` estimates a full re-judge | none | the printed cost estimate | run it after you agree (judge prompt v3 invalidated the cache once) | the run reports judged pairs | agent, after the user agrees | `paid` |
| Hybrid search on Postgres returns keyword-only results or hits the vector timeout | doctor `vector_plan` | `gbrain doctor` | upgrade and restart; to roll back: `gbrain config set search.vector_legacy_guard true`, then restart serve and autopilot | `gbrain doctor` shows `vector_plan` ok | brain host | none |
| Facts about you that came from pasted text or from gbrain's own claude-cli calls | doctor `self_capture` | `gbrain recall` for the fact | `gbrain forget <fact id>`; doctor `self_capture` prints one-time quarantine commands for old self-capture files | `gbrain doctor` | agent, after the user agrees | `destructive` (forgets the fact) |

<a id="fix-wave-5"></a>
### Upgrading to v0.60.28.0

**Say to your agent:** *"We upgraded gbrain to v0.60.28.0. Restart everything
that runs it, then walk me through what doctor finds, in order, before
changing anything."*

Most of these fixes take effect only in a process that runs v0.60.28.0 or
later, so restart first. `gbrain sources writer status --json` lists, in
`writer_versions[]`, the latest version each host and principal was seen
writing with in the retained requests. That is history, not proof: an idle
older `gbrain serve` never shows up there. Restart in this order:

1. Stop autopilot and workers (`gbrain autopilot --status` names the job;
   `gbrain jobs work` or your supervisor for workers).
2. Stop each resident `gbrain serve`: HTTP services through their service
   manager, and harness-owned stdio servers by quitting the harness.
3. Upgrade each host: `gbrain upgrade`.
4. Run `gbrain --version` through each launcher's own binary path (the path in
   the service definition, the harness MCP command, the hook commands) and
   confirm it prints `0.60.28.0`.
5. Restart services, harnesses, workers and autopilot.
6. Make one write from each host, then confirm a fresh `last_seen` for that
   host in `gbrain sources writer status --json` (`writer_versions[]`).

Then recover what doctor names, in this order (skip a step whose check is ok):

1. `gbrain doctor`.
2. Legacy jobs (`legacy_job_authority`): see
   [Legacy job authority](#legacy-job-authority).
3. Projections (`text_projection_readiness`): `gbrain projections drain`
   (Postgres, or PGLite with no resident); on PGLite with a resident, let it
   drain or stop, drain and restart it. See
   [Drain queued text projections](#projection-drain).
4. Stale atoms (`atom_provenance_drift`): `gbrain repair stale-atoms --source <id>`,
   then after the user agrees `gbrain repair stale-atoms --source <id> --apply --expect <hash>`.
5. Extractor facts (`extractor_facts_expired`): `gbrain repair extractor-facts`,
   then after the user agrees `gbrain repair extractor-facts --apply --expect <hash>`
   (add `--include-ambiguous` to both for ambiguous facts). See
   [Extractor facts](#extractor-facts).
6. `gbrain doctor` again, then `gbrain doctor --remediation-plan` for the
   automatic kinds.

<a id="repair-runtime-symptoms"></a>

| Symptom | Check or code | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- | --- |
| synthesize fails every run; `POST /ingest` returns 409 (500 on an older gbrain); workers refuse to start with "legacy jobs have missing or unsupported authority" | `legacy_job_authority` / `permission_denied` ([legacy job authority](#legacy-job-authority)) | stop `gbrain serve`, autopilot and workers; `gbrain jobs cancel <active id>`; `gbrain jobs authorize-legacy --select "status=waiting\|delayed\|waiting-children\|paused"` | `gbrain jobs authorize-legacy --select "<same filter>" --expect <hash> --yes`, then restart | `gbrain doctor` shows `legacy_job_authority` ok; `/ingest` returns 202 | brain host, after the user agrees | `paid` (authorizes legacy jobs) |
| Search returns atoms quoting text a page no longer has, or atoms of deleted pages | doctor `atom_provenance_drift` | `gbrain repair stale-atoms --source <id>` | `gbrain repair stale-atoms --source <id> --apply --expect <hash>` | `gbrain doctor` (`atom_provenance_drift` drops by the retired count) | brain host, after the user agrees | `destructive` (removes stale atoms) |
| `sources add`, `claim`, `rebind`, `archive`, `remove`, clone, reclone or `sources writer transfer` on a repo with more than ~10k files fails with "The verified source manifest exceeds the 1 MiB administration metadata bound" | `request_too_large` | none: upgrade and restart every writer host and resident `gbrain serve` | Re-run the failed command (with the same `--request-id` if you kept it) | `gbrain sources writer status --json` shows the source bound, and its `manifest_digest` is set | agent | none |
| A stdio agent bound with `GBRAIN_SOURCE` (or `.gbrain-source`) gets `permission_denied` naming the binding when it passes `source_id` | `permission_denied` (hint starts "This connection is bound to source …") | `gbrain sources list` (the source must show `federated`, not `isolated` or `unset`) | `gbrain sources federate <id>` on the brain host | Repeat the read with `source_id: "<id>"`; it returns only that source's rows. See [explicit reads from a bound agent connection](multi-source-brains.md#explicit-reads-from-a-bound-agent-connection) | brain host, after the user agrees | none |
| A new session's start-up context showed another session's text (`Last session activity: …`) | none | none | Upgrade the `gbrain` each harness runs its hooks with and restart the harness. If you set `GBRAIN_HOOKS=0` as a workaround, remove it from the environment the harness starts from (shell profile or service) and restart the harness again | A new session shows no `Last session activity` line, and `gbrain doctor` reports `bootstrap_hooks_heartbeat` again after a few turns (capture and session persistence are back) | user (upgrades and restarts the harness) | `persistent_install` |
| `connect --harness codex\|claude-code\|opencode --install` stored the bearer token inline in the harness config without telling you | receipt `token_storage: "inline"` | On the brain host: `gbrain mcp admin invalidate-tokens <client_id> --url <mcp_url> --admin-token-file <owner-admin-token-file> --json` (only if the config file was exposed) | `gbrain mcp admin invalidate-tokens <client_id> --yes --if-version <revision> --url <mcp_url> --admin-token-file <owner-admin-token-file> --json`, then `gbrain connect <mcp_url> --harness <harness> --credentials-file <handoff> --install --fresh-token`, then reload the harness | The new receipt prints `token_storage`, `config_path`, `renew_command` and `if_exposed`, and the harness answers a memory round trip | brain host, after the user agrees | `credentials` (invalidates tokens) |
| A second brain's autopilot replaced the first one's job, logs interleave in `~/.gbrain/autopilot.log`, or `gbrain autopilot --status --json` shows `job.needs_reinstall: "legacy_shared_job"` (or `"wrapper_missing"` after moving a brain); install refuses with `autopilot_job_owned_by_other_brain` | `gbrain autopilot --status --json` (`job.*`) / `autopilot_job_owned_by_other_brain` | `GBRAIN_HOME=<brain parent> gbrain autopilot --status --json` | `GBRAIN_HOME=<brain parent> gbrain autopilot --install` (every non-default brain first, then the default brain) | `GBRAIN_HOME=<brain parent> gbrain autopilot --status --json` shows `job.needs_reinstall: null` and the brain's own `launchd_label` / `systemd_unit`. See [several brains on one host](live-sync.md#several-brains-on-one-host) | brain host, after the user agrees | `persistent_install` |
| `gbrain serve` started in a `.gbrain-mount` project: CLI writes fail `owner_unavailable` and MCP writes stay `queued` | `owner_unavailable` | none | Upgrade and restart the resident `gbrain serve` (the harness that spawns it) | `gbrain sources writer status --probe --json` from the project answers | user (upgrades and restarts the harness) | `persistent_install` |
| Backup coverage reports `remote evidence: unavailable` for a private remote that is pushed | doctor `backup_coverage` | none | Upgrade, then `gbrain backup check` | `gbrain backup status --json` shows `verification.state: "verified"`; see [remote unavailable](../operations/backup-check.md#remote-unavailable) | agent, after the user agrees | `persistent_install` (upgrade) |
| On Windows, a write or `gbrain sync` refuses a colon slug such as `calendar:abc` | [`colon_slug_windows_write_through`](write-refusals.md#colon_slug_windows_write_through) | none | Use a slug without `:`, or write the page from a macOS or Linux host that owns the source | The write succeeds, or `gbrain sync` no longer lists the file | agent | none |
| Search empty or incomplete after upgrading; doctor `text_projection_readiness` warns | `text_projection_readiness` | `gbrain doctor --only text_projection_readiness --json` (counts per class, also while a PGLite resident runs) | `gbrain projections drain --dry-run`, then `gbrain projections drain` (Postgres, or PGLite with no resident; it seals `sealable` images too); on PGLite with a resident, wait for text, or stop, drain and restart per [projection owner resident](#projection-owner-resident); `reimport` images: `gbrain embed --stale --images --dry-run`, then the paid run | `gbrain doctor` shows `text_projection_readiness` ok | brain host | none |
| `Error [projection_owner_resident]` from `gbrain projections drain` (exit 2) | [`projection_owner_resident`](#projection-owner-resident) | `gbrain doctor` | the printed stop, drain and restart commands | `gbrain doctor` | brain host | none |
| `[gbrain] warning: OPENAI_API_KEY in this process's environment differs from openai_api_key …`; doctor `embedding_key_source` warns | `embedding_key_source` ([provider key source](#embedding-key-source)) | `gbrain doctor` (`embedding_key_source`) | remove the variable and restart that process, or `gbrain config unset openai_api_key` | the warning no longer prints; `gbrain doctor` shows `embedding_key_source` ok | user (owns the key) | `credentials` |
| `The OpenAI embedding provider rejected its key (HTTP 401)` | [`embedding_auth_failed`](write-refusals.md#embedding_auth_failed) | `gbrain doctor` (`embedding_key_source`, `embedding_provider`) | the printed fix for the key source in effect, then `gbrain embed --stale` | `gbrain doctor` shows `embedding_provider` ok | user (owns the key) | `credentials`; `paid` for `embed --stale` |
| Conversation facts missing from recall after managed writes | `extractor_facts_expired` | `gbrain repair extractor-facts` | `gbrain repair extractor-facts --apply --expect <hash>` (ambiguous: add `--include-ambiguous` to both) | `gbrain doctor` | brain host, after the user agrees | `destructive` (rewrites expired facts) |
| Recall returns conversation facts such as "Date said …" or "Attendees said …", or facts dated 1970-01-01; doctor `conversation_label_facts` warns; the upgrade banner prints `conversation_label_facts: N (explicit_kind_required; …)` | `gbrain repair conversation-labels` (ambiguous: add `--include-ambiguous`) | `gbrain repair conversation-labels --apply --expect <hash> --yes`, then the printed `gbrain extract-conversation-facts --slugs … --dry-run` | `gbrain doctor --only conversation_label_facts --json` | brain host, after the user agrees | `destructive` (retires facts; no model calls) |


### Upgrading to v0.60.20.0

<a id="repair-migration-symptoms"></a>

| Symptom or error text | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- |
| `gbrain upgrade` said the upgrade failed, or migrations ran twice | `gbrain apply-migrations --list` | `gbrain apply-migrations --yes` | `gbrain doctor --only minions_migration --json` (`minions_migration` ok) | agent, after the user agrees | none |
| `another apply-migrations is running (host …, pid …)` | `gbrain doctor` | wait, then `gbrain apply-migrations --yes` | `gbrain apply-migrations --list` | agent | none |
| doctor `orphan_persistence_bindings`; a re-added source fails with `writer_coordinator_required` | `gbrain repair orphan-bindings` | `gbrain repair orphan-bindings --apply` | `gbrain doctor` | brain host, after the user agrees | none |
| doctor `stale_embedding_effects`; `writer_not_quiesced` names an embedding effect | `gbrain repair embedding-effects --source <id>` | `gbrain repair embedding-effects --source <id> --apply` | `gbrain doctor` (pending until the owner run commits a `retry_queued` effect) | brain host, after the user agrees | none |
| autopilot never syncs a connector, or prints `has never synced` | `gbrain sources status <id>` | `gbrain sync --source <id>` once | `gbrain sources status <id>` | agent | `egress` (fetches from the provider) |
| a connector source keeps a stale `local_path` | `gbrain sources list` | `gbrain sources set-path <id> --clear` | `gbrain sources list` | agent, after the user agrees | none |
| classic writes refused after leaving managed mode, or `local_markers: pending` | `gbrain sources writer deactivate --dry-run` | see the [deactivate runbook](../architecture/topologies.md#deactivate-runbook) | `gbrain sources writer status` on every host | brain host, after the user agrees | none |

`orphan-bindings` and `embedding-effects` also run under `gbrain repair --all`
and `gbrain doctor --remediate --include-repairs`; `embedding-effects` is paid
work when it queues a retry. Retry commands: `gbrain sources writer retry-effects <source> --request-id <id>`
(one failed or parked effect), `gbrain sync --source <id> --no-pull`
(a failed sync write) and `gbrain repair embedding-effects --source <id> --apply`
(stuck embedding effects, including a used-up retry allowance).

## Quarantine self-captured corpus files

`gbrain doctor` reports `self_capture` when the dream session corpus
(`dream.synthesize.session_corpus_dir`) still holds files captured from
gbrain's own `claude-cli` sessions. Dream and the sweep skip
the ones they can identify, but nothing removes them. The check never moves
or deletes files. It lists what it classified (a harness transcript under a
gbrain scratch project matches the file) and counts what it cannot decide (no
harness transcript is left for that session).

To quarantine the classified files on the brain host:

```bash
gbrain doctor --json > /tmp/gbrain-doctor.json
# Review the list first:
jq -r '.checks[] | select(.name=="self_capture") | .details.classified_sample[]' /tmp/gbrain-doctor.json
# Then run the exact commands doctor printed (one mkdir, one move per file, sidecars included):
jq -r '.checks[] | select(.name=="self_capture") | .details.quarantine_commands[]' /tmp/gbrain-doctor.json | sh
gbrain doctor --json | jq '.checks[] | select(.name=="self_capture") | .details'
```

The quarantine directory is a sibling of the corpus directory
(`<corpus>.quarantine`), so dream never reads it. Doctor prints at most 20 move
commands per run; rerun the sequence until `classified` reaches 0. Review the
`unclassifiable` files by hand; delete the quarantine directory only when you
are sure you do not need it.

## Stale queued embedding effects

**Say to your agent:** *"Doctor says an embedding effect is stuck and it blocks
activation. Settle it."*

`gbrain doctor` reports `stale_embedding_effects` when a committed write still
has an embedding effect that is queued an hour later with no consumer claiming
it, or that failed (for example after a provider outage). Either
one keeps the write receipt from compacting and blocks activation with
`writer_not_quiesced`. Preview, then apply after you agree, on the brain host:

```bash
gbrain repair embedding-effects --source <source>          # predicts each effect's outcome
gbrain repair embedding-effects --source <source> --apply  # settles them
gbrain doctor                                              # verify: stale_embedding_effects is ok
```

Each effect ends in exactly one outcome; no obligation is dropped without one:

| Outcome | When | Spends |
| --- | --- | --- |
| `reconciled` | The page's current chunks already pass the effect's verifier (same revision, selected column, model and hashes). The effect commits. | Nothing |
| `superseded` | The page was deleted, or a newer revision of the same page owns its own embedding effect. The effect commits as superseded. | Nothing |
| `retry_queued` | The owner embeds it: a stale queued effect is re-queued; a failed one gets the `retry-effects` allowance; when that allowance is used up (`embedding_retry_exhausted`), one new bounded retry cycle, once per explicit apply. | Provider calls, up to the bounded retry budget |
| `blocked` | Nothing changed. `owner_unavailable` (run it on the owner host), `embedding_disabled` or `embedding_unconfigured` (configure embeddings first), `projection_pending` (sync the page first) or `no_replacement_obligation` (the page changed without a newer embedding obligation; run `gbrain embed <slug> --source <source>`). | Nothing |

`retry_queued` is not success: doctor keeps the effect pending until the
owner's run commits it. The preview marks retries as paid work; through
`gbrain doctor --remediate --yes --include-repairs --expect <plan_hash> --max-usd <n>`, the estimate
covers the whole retry budget each grant authorizes. A resumed run replays the
grant it already made instead of granting another cycle. A signature-mismatched
vector is never reconciled; it is re-embedded.

## Recorded-time reads

`get_page {known_as_of}` and `get_versions {known_as_of}` read a page as this
brain had recorded it at an instant, from the belief ledger
([design, section 10](../designs/BELIEF_LEDGER.md#10-what-w2s-first-slice-needs-from-w1)).
`known_as_of` is recorded time: an ISO 8601 instant with a zone. It is not
`as_of` on `get_links`, which is valid time (a date). A read answers with the
interval the instant falls in, `certified` (false with `uncertified_reason` on
an unmanaged source, a drifted interval or a truncated walk), and a `body` of
`live`, `version`, `segmented` (read it through `body_ref`) or `unavailable`
with a `body_reason` (`purged`, `expired`, `hard_deleted`, `pruned`,
`version_missing`). A body no retained version holds is disclosed, never
borrowed from the version next to it. The refusals below change nothing; run
`gbrain beliefs status --source <id> --json` to see the coverage a read is
checked against.

### Coverage from

The ledger does not cover the instant: it is before the ledger was enabled on
the source, or before the page's baseline cut. Earlier times are unknown, not
empty. `reason` is `not_recorded`, or `backfill_only` / `backfill_incomplete`
when `gbrain beliefs backfill` seeded best-effort history for the page: that
history carries source times only, so it never answers a recorded-time read.
Ask about an instant at or after the time the message names.

### Coverage gap

The ledger was not recording at the instant: coverage was stopped
(`reason: not_covered`), or a backup restore replaced the ledger with an
archive, and what happened between the archive's time and the restore is
unknown (`reason: restore`). Ask about an instant outside the gap the message
names.

### Clock mismatch

`known_as_of` got a calendar date (`reason: date_for_instant`). A date is
valid time; recorded time needs an instant. Pass a full instant such as
`2026-10-01T12:00:00Z`.

### Known as of unproven

A change to the page was recorded before the instant, but nothing proves it
had committed by then: its commit mark is later, and no later write to the
same page was recorded by the instant (section 5.3 of the design). The page at
that instant can't be stated either way, so the read refuses rather than
guess. The refusal is `retryable`: ask about an instant before the write's
recorded time, or after its commit was observed (the message names the write).
A stalled transaction stays unproven until it commits and is marked.

### What changed in a window

`gbrain beliefs changes [<entity>...] [--since 7d]` (and `delta {beliefs: true}`
for agents) lists each fact, take, link and page that ended the window
different from how it started: before, after, the event that caused it and
its event id. An edit and its revert report nothing. `earlier value unknown`
means no recorded body answers for the start of the window, not that the
belief was absent; `end by <date>` is a relationship end the nightly check
inferred, so it ended on or before that date. A window that starts before the
ledger was enabled says where coverage starts. On a thin client the command
runs through the host and lists only world beliefs on pages visible now
([design, section 15](../designs/BELIEF_LEDGER.md#15-w4-as-built-the-weekly-change-diff)).

## Repair refusal codes

Each heading below is the `docs` anchor a refusal carries.

### Explicit-only repair kinds

`google-file-modes`, `stale-atoms`, `extractor-facts`, `captured-facts`,
`loop-facts`, `ontology-facts`, `file-drift` and `missing-tables` run only when named: `gbrain repair <kind>` previews, and
`gbrain repair <kind> --apply` applies (every kind but `google-file-modes`
also needs `--expect <hash>`, so it applies exactly the previewed set; `google-file-modes` re-checks each file's owner,
type and mode at apply time). They are excluded everywhere else:

- `gbrain repair --all` (and `gbrain repair` with no kind) lists each with its
  preview command (`--json`: `explicit_kinds[]`) and never runs it. A
  `--all --apply` run exits 0 when only explicit-only kinds remain.
- `gbrain doctor --remediation-plan` prints them in an `Explicit-only repairs`
  block (`--json`: `explicit_repairs[]`, each `{kind, code:
  "explicit_kind_required", preview_command, docs}`), never as a repair step.
- `gbrain doctor --remediate --include-repairs` classifies a finding only an
  explicit-only kind clears as `explicit_kind_required`, with the preview as
  its `command`. That class does not fail the exit status.
- The `gbrain post-upgrade` banner prints such a finding as
  `<check>: N (explicit_kind_required; preview with: gbrain repair <kind>)`.

A remediation step or any other runner that reaches an explicit-only kind
without its name refuses with `explicit_kind_required`. A build that does not
implement the kind refuses with `unavailable`.

### Preview changed

`preview_changed`: the hash passed with `--expect` names no saved preview, the
saved preview is older than 7 days, or the selection no longer matches it (for
`stale-atoms`, a different `--source`). Nothing was applied. The message reads
"The preview changed since <hash>; re-run <preview command> and use the new
hash." Re-run the printed preview command and apply with the new hash. It
applies to `gbrain jobs authorize-legacy --select`, `gbrain jobs cancel
--select`, `gbrain repair stale-atoms`, `gbrain repair extractor-facts`,
`gbrain repair captured-facts` and `gbrain repair loop-facts`.

### Recovery bundle unsupported

`recovery_bundle_unsupported`: `gbrain repair stuck-recovery` found a
shared-skill bundle recovery record (several skill files published together)
that this binary cannot read: an unknown shape, or more files than a bundle
holds. A readable bundle record is resolved like a page recovery (see
[stuck recovery](#stuck-recovery)). Nothing was changed. The preview lists it
under `refused`, and its `fix` is `ask_user` with the exact preview command;
naming it with `--request-id` refuses with this code. Upgrade gbrain on the
brain host and preview again, or ask the user which version of each skill file
to keep, put those bytes in place by hand, and let the resident writer finish
the recovery.

### Recovery prior stage unavailable

<a id="recovery-large-file-unsupported"></a>

`recovery_prior_stage_unavailable`: `gbrain repair stuck-recovery` can't apply
that `--keep` choice to a page recovery whose prior file is over the 24 MiB
single-string ceiling, and nothing was changed. Such a recovery keeps its prior
bytes as a staged copy beside the file, named in the record by path and
SHA-256, and that copy is missing, doesn't match its recorded SHA-256, or isn't
a regular file. Without it `--keep prior` has nothing safe to put back. The
refusal's `fix` is the remaining exit, the `--keep disk` apply under the same
preview hash (`next: ask_user`, because it keeps the edit and abandons the
write), with `gbrain sources writer status --source <id> --json` as its
`verify`. When the staged copy isn't a regular file, `--keep disk` can't back
it up either; the `fix` is then that read-only status, and the preview offers
the choices again once the path holds a regular file.

Builds before this one listed every large-file recovery as refused with
`recovery_large_file_unsupported` and had no exit for it; this build resolves
them with `gbrain repair stuck-recovery`.

### Recovery choice refused

`recovery_choice_refused`: `gbrain repair stuck-recovery` will not apply that
`--keep` choice to that request, and nothing was changed. Either the request is
terminal while its recovery record is still set (its outcome is immutable,
recovery never restores its file, and `--keep prior` would roll back committed
bytes; the record only waits for staging cleanup, see `gbrain sources writer
status --source <id> --json`), or the record cannot support the choice
(`--keep prior` without stored prior bytes, or a blocked path that is not a
regular file), or a record in the approved preview does not offer that choice
(`--keep disk` or `--keep prior` on a withdrawal-mirror effect, `--keep
withdrawn` on a page or bundle; refused before anything runs, so narrow the
preview with `--request-id`). The preview lists only the choices it can make
safe.

### Recovery effect unsupported

`recovery_effect_unsupported`: a withdrawal-mirror effect recovery blocks the
source's worktree, and its record cannot be written forward: it holds no
usable withdrawn bytes (missing or corrupt), or it was recorded for another
owner epoch, root or source incarnation. A usable record is resolved with
`--keep withdrawn` (see [stuck recovery](#stuck-recovery)). That recovery
only finishes forward (it never restores the bytes from before a withdrawal),
so nothing was changed. The preview lists the effect as `refused`, and its
`fix` is `ask_user` with the exact preview command
(`gbrain repair stuck-recovery --source <id> --request-id <request>`) and a
`user_message` to relay; naming its request with `--request-id` refuses with
this code and the same fix. The user copies the edited file aside and puts it
back to its committed version (never deletes it); the resident writer then
finishes the effect, and the edit is made again without the forgotten fact. A
sync queued behind a stuck effect stops at once with
[`drain_stalled`, `cause: head_blocked`](write-refusals.md#head-blocked), and
its fix runs the stuck-recovery preview.

### Legacy job authority

`permission_denied` with this anchor means a queued job row has SQL NULL
`submission_authority`, left by an upgrade across v0.50.

- A resubmission over a **dead or cancelled** legacy key releases the key and
  queues a fresh job. No step needed.
- A **completed or failed** legacy row is reused by local producers (synthesize,
  autopilot, `POST /ingest`). No step needed. A remote `submit_job` caller is
  refused and resubmits with a new idempotency key.
- A **live** legacy row (waiting, delayed, waiting-children, paused, active)
  blocks every worker, so nothing reuses it. `POST /ingest` returns 409
  `{error, message, hint, docs_url}`, never 500.

`gbrain doctor` (`legacy_job_authority`) counts exactly the rows that block workers,
split into authorizable (SQL NULL) and unsupported (non-NULL) rows, and prints the
filled commands. Recovery, in order:

1. Stop producers and workers: the resident `gbrain serve`, `gbrain autopilot`,
   `gbrain jobs work` / supervisor.
2. Cancel each active job the hint or doctor names: `gbrain jobs cancel <id>`.
   (Stall and timeout sweeps are behind the same gate, so an orphaned active row
   never finishes on its own.)
3. Preview: `gbrain jobs authorize-legacy --select "status=waiting|delayed|waiting-children|paused"`
   (narrow with `,name=<job>|<job>`). It lists counts by job name and status, the
   first 20 ids, marks paid-provider job names, and prints a hash. `--json` has the full rows.
4. Apply exactly that set with the printed command:
   `gbrain jobs authorize-legacy --select "<same filter>" --expect <hash> --yes`.
   To drop work instead, `gbrain jobs cancel --select "<filter>"` previews and its
   printed `--expect <hash> --yes` cancels exactly the previewed set.
5. Unsupported non-NULL rows cannot be authorized: run matching application and
   database versions, or cancel them (`gbrain jobs cancel <id>`, as doctor lists).
6. Restart producers and workers. Verify: `gbrain doctor` shows
   `legacy_job_authority` ok; `POST /ingest` returns 202.

### Legacy jobs active

`legacy_jobs_active`: `authorize-legacy --select`/`--ids` or `jobs cancel --select`
found active jobs. Legacy review needs nothing active. Stop producers
(`gbrain serve`, `gbrain autopilot`) and workers, cancel the listed jobs
(`gbrain jobs cancel <id>`; the refusal lists up to 10, the rest with
`gbrain jobs list --status active`), then re-run the preview it names.

### Legacy job selection invalid

`legacy_job_selection_invalid`: `--select` named an unknown key or value, a
flag combination was wrong (`--ids` with `--select`; apply without both
`--expect <hash>` and `--yes`), a selected row no longer exists or is not SQL
NULL, or a `jobs cancel --select` selection would also cancel a job outside it
(the message names those ids; cancel them on purpose or widen the filter). The
grammar is `--select "status=<s>[|<s>…],name=<job-name>[|<name>…]"`; the
message lists the valid statuses, and the hint is a complete example.

### Projection owner resident

`projection_owner_resident` (exit 2): `gbrain projections drain` did not run
because a gbrain process (named with its pid) holds this PGLite brain. Nothing
changed. The resident drains queued Markdown and code itself; re-run
`gbrain doctor` to watch the counts in `text_projection_readiness` (doctor asks
the resident over its local socket, so the counts show while the resident
runs; a resident that does not answer, or answers without the image classes,
runs an older gbrain, so restart it on the current version).

The resident never seals images, so `sealable` image pages need the database
to itself. Doctor's fix is then a two-step action the user runs: stop the
owner, run `gbrain projections drain --limit <n>`, start the owner again. Its
message names the image count and how long the owner is down per drain run;
harnesses connected through that `gbrain serve` disconnect until it restarts.
Verify with `gbrain doctor --only text_projection_readiness --json`, which
reads the counts through the restarted resident.

To drain faster, stop the owner, drain, then restart it. The restart runs
whether or not the drain failed:

| Owner | Stop, drain, restart |
| --- | --- |
| `gbrain serve` service, launchd | `launchctl bootout gui/$(id -u)/com.gbrain.serve && { gbrain projections drain; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gbrain.serve.plist; }` |
| `gbrain serve` service, systemd | `systemctl --user stop gbrain-serve.service && { gbrain projections drain; systemctl --user start gbrain-serve.service; }` |
| autopilot, launchd | `launchctl bootout gui/$(id -u)/com.gbrain.autopilot && { gbrain projections drain; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gbrain.autopilot.plist; }` |
| autopilot, systemd | `systemctl --user stop gbrain-autopilot.service && { gbrain projections drain; systemctl --user start gbrain-autopilot.service; }` |
| a manual `gbrain serve` | stop it (`kill <pid>`), run `gbrain projections drain`, then start `gbrain serve` again |

The rows above show the default brain's names. The refusal prints these
commands filled in: with `--brain <id>` for a mounted brain, and with this
brain's own autopilot job (or the shared job an older install still runs it
from) for a brain under another `GBRAIN_HOME`. The autopilot launchd label
follows `GBRAIN_AUTOPILOT_LABEL` when set.

### Page projection conflict

`page_projection_conflict` (retryable): another worker installed a newer
search projection (chunks and text seal) of the same page while this command
prepared its own, at an unchanged page revision. The usual other worker is the
persistence owner's resident projection rebuild (`gbrain serve` or autopilot);
an `embed` or `import` run can be one too. Nothing was installed by the losing
command, and the newer projection is kept. `detail` names what changed:
`text_projection_revision` (the page was sealed), `chunk_digest` (its chunk
set changed) or `indexing_context` (the embedding column, model, chunker
version or another indexing input changed).

Callers that install a projection re-read the page and prepare again up to
three times before reporting this code. To recover, re-run the same command;
it re-reads the current projection. If it conflicts again, another worker is
still installing: wait for it to finish (`gbrain doctor` shows the pending
count in `text_projection_readiness`), then re-run. `gbrain get --source <id>
-- <slug>` shows the page as stored now.

### File removed during scan

`file_removed_during_scan` is a non-fixable `gbrain lint` issue: a file the
scan listed was deleted or renamed before lint read it, so that file was not
linted. Lint continues with the remaining files. Re-run `gbrain lint <target>`
to check the files that exist now. On a managed brain, `lint --fix` instead
reports the page as a pending `canonical_file_missing` repair (counted in
`fix_pending`); see
[lint repairs waiting on a managed brain](concurrent-writes.md#lint-repairs-waiting-on-a-managed-brain).

### Fix not writable

`fix_not_writable` is a non-fixable `gbrain lint --fix` issue: lint found a
fixable problem but the file refused the write (`EACCES`, `EPERM` or `EROFS`:
its permissions or a read-only mount), so the file was left unchanged. The
issue's `reason` is the lowercased errno. Lint continues with the remaining
files and counts the page in `fix_pending`; the cycle's lint phase reports
`warn`, not `fail`. Make the file writable by the user running gbrain, or pass
its directory or file name to `gbrain lint --exclude`, then run lint again.

## Setup refusals

`gbrain setup <harness>` resolves the brain, source, transport, launcher and
registration owner before it writes anything, and refuses with one of these
codes when that target is not safe to wire. A refusal writes nothing. Guide:
[connect an agent with gbrain setup](setup.md).

### Setup harness unsupported

`setup_harness_unsupported`: setup wires Claude Code and Codex in this release.
The message names the guide for the harness you asked for (OpenClaw:
[docs/mcp/OPENCLAW.md](../mcp/OPENCLAW.md), Hermes:
[docs/mcp/HERMES.md](../mcp/HERMES.md)); follow its manual steps.
`gbrain setup --help` lists the supported harnesses.

### Setup owner conflict

`setup_owner_conflict`: something setup does not own holds the target. The
`reason` says which:

- `live_serve`: a running `gbrain serve` holds this PGLite brain's
  single-writer lock and is not the server this setup registered. A stdio
  registration would start a second server that fails on the lock. Stop that
  server (quit the agent session that started it), or keep it and connect
  through it: a shared `gbrain serve --http` is wired with
  `gbrain bootstrap harness --harness <claude-code|codex>`.
- `unowned_entry`: the harness configuration already has an entry under the
  same MCP server name, and its hash is not one this setup recorded (you or
  another tool wrote it, or you edited it). Setup never overwrites it. Pick
  another name with `--name`, or remove that entry yourself and run setup
  again.
- `other_install`: the connection receipt for this name belongs to a gbrain
  install with a different `GBRAIN_HOME`. Run setup with `--name <other>` so
  each install owns its own entries.
- `harness_lane`: `gbrain bootstrap harness` (or a workspace bootstrap
  install) already wires gbrain hooks or MCP in this configuration. Keep that
  wiring, or remove it with `gbrain bootstrap harness --remove` first. On
  Codex this also fires when the bootstrap Codex lane's `SessionEnd` hook is in
  `hooks.json` and you passed `--capture`: keep that lane and run setup without
  `--capture`.

`gbrain setup claude-code --dry-run --json` shows the resolved target and the
blocking owner without writing anything.

### Setup hosted connection

`setup_hosted_connection`: this machine already reaches a hosted brain (a
thin-client config from `gbrain init --mcp-only`, a remote `gbrain` entry in
the harness configuration, or a `gbrain connect --install` receipt), and no
`gbrain setup` receipt owns it. Setup never falls back to a new local brain,
because sessions would then read an empty brain while useful memory stays on
the hosted one. Manage that connection with `gbrain connect <mcp-url>
--harness <claude-code|codex> --install`; `gbrain doctor --only harness_wiring` shows
which brain the registration reaches.

## Connection notices

Two notices tell an agent, on its own MCP connection, why something it
expected is out of reach. Neither changes what the connection can call.

### Grant blocked operations

`grant_blocked_operations` (info): this connection's grant cannot call some
operations its scopes allow. The notice says which proven blocker applies,
with counts and never operation names: the grant's operation snapshot, the
client's stored tool surface (a pin the brain owner set), or the server's
tool surface. A missing scope is named only on a refused call, because it is
how the grant was issued. Grant age is kept apart from the blockers: a grant
whose snapshot was written before snapshots recorded their operation catalog
says "this grant's snapshot excludes N currently eligible operations;
original intent unknown", and only a grant with recorded catalog provenance
says it predates operations. Operations outside the grant's scopes are never
counted, so a writer is not told about admin-only operations.

It arrives once per session: once per (principal, transport session) on
stdio and HTTP, and for a stateless HTTP call with no session id once per
(principal, grant revision), so a rescoped grant is diagnosed afresh.
`fix.next` is `tell_user_to_run`: the brain owner previews the change on the
brain host and then applies it (`then`). For an OAuth client that is
`gbrain auth rescope --client <client_id> --operations <OPERATIONS> --surface full --dry-run`
(`--surface full` only when the stored surface also blocks), then the same
command without `--dry-run`; for a legacy token,
`gbrain auth rescope --id <token_id> --refresh-operations` and then
`... --add <OPERATIONS>`. The owner chooses `<OPERATIONS>`. When only the
server's tool surface blocks, no grant change lifts it, and the fix is the
read-only doctor check that names the setting. `fix.verify` is read-only:
`gbrain doctor --only grant_new_ops_available --json` on the host, or
`whoami` on the same connection (its `grant_diagnosis` field carries the same
diagnosis). Nothing widens automatically; see
[grants that cannot reach new operations](../mcp/ADMIN.md#grants-that-cannot-reach-new-operations).

### Hidden tool content

`hidden_tool_content` (info): a page read, search or query left out takes
(page reads and search never include the takes table for an agent-facing
reader) and the tool that lists them, `takes_list`, is not in this
connection's tool list. The notice counts the takes and names the result's
own pages, and its `fix` is the next step this connection can actually take:

- `takes_list` is callable but not listed (an advertised surface narrower
  than the callable one): the fix is the `takes_list` call itself, and a
  stdio session also adds it to its tool list. A client that ignores
  `tools/list_changed` can still call it by name.
- one `request_tools {surface}` call would make it callable: the fix is that
  call (stdio: this session only, nothing written; HTTP: the client's own
  surface, within the server ceiling and never past an operator pin).
- otherwise only the brain host can change it: on HTTP the fix is the grant
  repair from `grant_blocked_operations`; on stdio it is the tool's CLI
  equivalent, relayed to the user.

A fix never names a call the connection cannot make: read-only access,
operator pins, the grant's snapshot and `GBRAIN_MCP_FORCE_SURFACE` all hold.

## Related

- [Write refusal reasons](write-refusals.md) — what a refused write means and the recovery command
- [Concurrent writes and durable receipts](concurrent-writes.md) — receipts, retries and capacity limits
- [v0.60.5.0 upgrade steps](../../skills/migrations/v0.60.5.0.md) — backup-first upgrade steps for a brain older than v0.60.5.0
- [Topologies: claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook) — quiescence checklist, the writer admin lock
