# Repair residual damage with `gbrain repair`

`gbrain doctor` finds some damage that it cannot fix on its own: timeline
history that exists only in the database, derived pages without an explicit
visibility, pages indexed before the safe-chunk fence, pages imported
without a contextual retrieval mode, connector checkpoint rows no source
can load, and Google source files other local users can read. `gbrain repair`
fixes those and the other kinds listed in
[What each kind fixes](#what-each-kind-fixes). Every run is a preview unless
you pass `--apply`.
Seven explicit-only kinds, `google-file-modes`, `stale-atoms`, `extractor-facts`,
`captured-facts`, `loop-facts`, `orphan-children` and `failed-writes`, run only when you name them (see [Explicit-only repair kinds](#explicit-only-repair-kinds)).
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
runs `timeline`, then `visibility`, then `safe-chunks`, then `contextual-mode`, then `connector-checkpoints`, then `request-indexes`, then `connector-fences`, then `orphan-bindings`, then `embedding-effects`, and stops at the
first kind that stops.
The explicit-only kinds (`google-file-modes`, `stale-atoms`, `extractor-facts`) never run under
`--all`; it lists each with its preview command and still exits 0 when they
are the only findings left. `gbrain repair` with no kind does the same for a
preview. With `--json` the list is `explicit_kinds[]` (`kind`, `code:
"explicit_kind_required"`, `preview_command`, `docs`).

Each item is re-checked against the page's current state just before it is
written, and the write is bound to the revision it just read, so an edit made
after planning is kept and repaired too. An item that no longer needs the
repair, or whose page changes during the write, is counted as `skipped` and
left for the next run. No kind deletes data except `stale-atoms`, which
soft-deletes the atoms it retires (they stay recoverable through the
`restore_page` operation for 72 hours, and a later extraction that produces
a retired atom again restores it). See [Stale atoms](#stale-atoms).
`extractor-facts` only restores previewed facts (it clears `expired_at` and
gives each a fresh row number); it never deletes or rewrites a page.

| Option | Effect |
| --- | --- |
| `--apply` | Write the repair. Without it, only preview. |
| `--source <id>` | Limit the run to one active source. The default is every active (non-archived) source. An unknown or archived id is refused. |
| `--limit <n>` | Repair at most `n` items per kind in this run (a positive integer; with `--all`, up to `n` for each kind). Rerun the same command to continue. |
| `--no-embed` | `safe-chunks` and `contextual-mode`: skip the embedding provider. Run `gbrain embed --stale` later. `timeline` and `visibility` pages are re-embedded by their publication either way. |
| `--all` | Run every automatic kind in order. Explicit-only kinds are listed with their preview command, never run. |
| `--expect <hash>` | Explicit-only kinds: apply exactly the set the preview printed under this hash. Required with `--apply` for `stale-atoms`, `extractor-facts`, `captured-facts`, `loop-facts` and `failed-writes`. |
| `--include-ambiguous` | `extractor-facts` and `captured-facts` only: widen the hashed set to `ambiguous` facts. Pass it to both the preview and the apply. See [Extractor facts](#extractor-facts) and [Captured facts](#captured-facts). |
| `--json` | Print `{ scope, mode, results[], paid_kinds }`, one result per kind with `paid`, `affected`, `sample`, `residuals`, `cost`, `capacity`, `resumed_from`, `applied`, `skipped`, `complete`, `stopped` and `apply_command`, plus `explicit_kinds[]` when the run skipped explicit-only kinds. |

The command exits 1 when a run stops early (capacity, a pending write, or a
held writer). A `--limit` batch that leaves work behind exits 0, so scripts
should also check `results[].complete`.

## What each kind fixes

| Kind | Doctor check that points here | What it does | Left alone and counted |
| --- | --- | --- | --- |
| `timeline` | `timeline_history` | Re-saves each page with its current body through a revision-bound `put_page`. The save writes each database-only timeline entry back into the page as a bullet preceded by `<!-- gbrain:materialized v1 <hash> -->`. | `kept_unrenderable_rows`: entries that would change if written as a bullet (for example an empty source). They stay in the database. |
| `visibility` | `derived_visibility` | Stamps an explicit `visibility` on extracted atoms and synthesized concepts. An atom takes its origin page's visibility; transcript atoms and atoms whose origin is gone become `private`; a concept takes the strictest visibility of its input atoms. A concept input found only through an atom's `concepts:` list counts as private. Atoms are repaired before concepts. It never loosens an explicit value: `private` stays `private`, and `world` can only become `private`. A missing value is stamped with the origin's value, which is `world` when the origin page is public. | `concepts_without_lineage`: concepts whose inputs cannot be found. They stay as they are, and remote readers already treat a missing visibility as private. `atoms_origin_gone_to_private` counts atoms made private because their origin page no longer exists. |
| `request-indexes` | `persistence_request_indexes` | Creates a missing managed sync request index, or drops an INVALID one (left by an interrupted concurrent build) and rebuilds it, on a brain whose schema version is already current. Postgres builds each index `CONCURRENTLY`, one at a time, so writes continue; PGLite builds inline. It changes no user data, takes no journal admission and runs brain-wide (`--source` does not narrow it). See [managed sync request indexes](#request-indexes). | `building`: an index another session is still building; it is never dropped. |
| `connector-fences` | none (a `connector_fence_below_timeline` refusal names it) | Moves a facts or takes fence that sits below the timeline sentinel of a Google or GitHub page into the page body through a revision-bound `put_page`, so the connector's next re-render carries the fence instead of refusing. Then re-attempt the held item with `gbrain sources retry-held <source>`. | `kept_ambiguous_pages`: pages whose fences are duplicated, unbalanced or unparseable. Move the fence by hand: read the page, place the fence above the `<!-- timeline -->` line, and save it with the current `expected_revision`. |
| `connector-checkpoints` | `connector_checkpoints` | Deletes managed connector checkpoint rows and retry pointers that no registered connector source can load and that are older than 7 days. They accumulate after a content setting such as `g_history_days` changes, or when a connector host older than v0.60.11.0 runs during an upgrade. Cleanup only: it never copies or re-keys a checkpoint, takes no journal admission and runs brain-wide (`--source` does not narrow it). | Rows a queued or running connector write, or a connector's recorded pending set, still references. |
| `orphan-bindings` | `orphan_persistence_bindings` | Deletes persistence source bindings whose source was removed, or that belong to an earlier incarnation of a source re-added under the same id. Releases before this one left the binding behind on `gbrain sources remove` and `gbrain sources purge`, so the re-added source read as claimed and every `gbrain sync --source <id>` failed with `writer_coordinator_required`. Bookkeeping only: no journal admission, no page or file changes, and it runs brain-wide (`--source` does not narrow it). See [orphan bindings](#orphan-bindings). | A binding that a queued, running or recovering write request of the same source incarnation still references. |
| `embedding-effects` | `stale_embedding_effects` | Settles stale queued and failed embedding effects of committed writes, which block receipt compaction and activation: `reconciled` when current vectors pass the effect verifier, `superseded` when the page was deleted or a newer revision owns its own effect, `retry_queued` for the owner (paid; a used-up retry allowance gets one new bounded cycle per explicit apply). See [stale queued embedding effects](#stale-queued-embedding-effects). | `blocked` effects, counted by reason (`owner_unavailable`, `embedding_disabled`, `embedding_unconfigured`, `projection_pending`, `no_replacement_obligation`). |
| `attribution-backfill` | none | Fills write attribution (who wrote it) on pages, page versions and facts written before attribution was recorded, only where exactly one committed request in the write journal proves the writer: the page write whose recorded result is the row's revision, or the `remember` that inserted the fact. Fills NULLs only, in committed batches of 1,000 that resume after an interruption; no content, revision, page file or request ID changes. See [write attribution](../mcp/ADMIN.md#write-attribution). | `unrecorded_pages`, `unrecorded_page_versions`, `unrecorded_facts`: rows the journal cannot prove. They stay `unrecorded`; nothing is inferred. |
| `safe-chunks` | `safe_index_pending` (also `contextual_retrieval_coverage`, `details.unsealed_pages`) | Rebuilds the chunks of markdown and code pages indexed before the safe-chunk fence, which remote and MCP search withhold. It rebuilds projections only: no page write, no new page version and no request ID. Vectors whose embedding input did not change are kept; the rest are embedded unless you pass `--no-embed` or no embedding model is configured. | `code_without_source_path`: code pages with no recorded file to re-chunk. `unsupported_page_kind`: other page kinds, such as images. Their importer re-seals them. |
| `orphan-children` | `child_table_orphans` (also a `storage_corrupt` error) | Explicit-only. Deletes rows of page child tables (chunks, versions, tags, takes, raw data, timeline, links) whose page row no longer exists, and clears dangling `links.origin_page_id` and `files.page_id` references, each in one statement that rechecks the orphan condition. See [orphan children](#orphan-children). | `torn_pages`: page rows whose stored body cannot be read (torn TOAST). The preview names them; the repair never changes them. |
| `contextual-mode` | `contextual_retrieval_coverage` (pages with no recorded mode) | Stamps the contextual retrieval mode on markdown pages imported without one (for example by a large `--no-embed` sync or a connector source before this release), exactly as a fresh import of the page would: the page, source and brain settings decide, and the per-chunk synopsis tier lands at the free title tier. It rebuilds projections only: no page write, no new page version and no request ID. A page whose stored vectors already match the stamped convention keeps them and queues no re-embedding; a page whose embedding input changes has only those vectors cleared and is re-embedded once, unless you pass `--no-embed`. | `unsealed_projection`: pages whose chunks lag their text; `gbrain embed --stale` or `safe-chunks` seals them first, and the next run stamps them. `embed_skip`: pages marked to skip embedding keep their stored vectors and are not stamped. |
gbrain repair google-file-modes --apply             # explicit-only: runs only when named
gbrain repair --all --apply                    # every automatic kind in order

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
`last_source_cycle_at` stamp no longer makes every run start over. The
v0.60.11.0 migration copies each connector source's newest committed
checkpoint to the new key. A source whose newest checkpoint receipt was
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
### Managed sync request indexes

A managed sync checkpoint checks that every page receipt of its run
committed. On a large `persistence_requests` table that check used to scan the
whole table and hit the coordinator's 5-second statement timeout, so the
checkpoint never committed and was retried ahead of every other write to the
source (#5762). Two indexes now serve it, `persistence_requests_sync_run_open`
and `persistence_requests_sync_run_committed`. On Postgres, migration 179
builds them `CONCURRENTLY` after the upgrade; while it runs it prints
`building <index> on ~N rows; this can take minutes; it is safe to leave
running`. A timeout that still happens fails the checkpoint with
[`checkpoint_validation_timeout`](write-refusals.md#checkpoint-validation-timeout)
instead of retrying forever.

**Say to your agent:** *"My sync says checkpoint_validation_timeout. What do I run?"*

`gbrain doctor` reports `persistence_request_indexes`: ok when both indexes are
valid, a warning with progress while one is still building (leave it
running), and a warning naming `gbrain repair request-indexes --apply` when one
is missing or INVALID. After the rebuild, run the retry the refusal printed
(`gbrain sync --source <source> --no-pull --retry-failed` plus the saved
processing flags).

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

<a id="projection-drain"></a>
### Drain queued text projections

After an upgrade that re-queues text projections (for example the 0.51
protocol activation), search and code results stay incomplete until every
queued Markdown and code page is rebuilt (#5401). Doctor
`text_projection_readiness` warns while any visible page is pending.

The upgraded resident owner (`gbrain serve` or autopilot) drains the queue on
its own: each pass rebuilds up to 100 pages and starts no new page after
250 ms, and takes 2 pages while writes are waiting. A page whose rebuild fails
is retried after 30 seconds.

To drain now:

```bash
gbrain projections drain            # until every page queued at the start was tried once
gbrain projections drain --limit 5000
gbrain projections drain --json     # {rebuilt, superseded, failed: [{source_id, slug, reason}], remaining}
```

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

Verify: `gbrain doctor` shows `text_projection_readiness` ok.

<a id="embedding-key-source"></a>
### Provider key source

An exported provider key (for example `OPENAI_API_KEY`) wins over the matching
config key (`openai_api_key` in `~/.gbrain/config.json`) (#5137). When both are
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

<a id="orphan-bindings"></a>
### Orphan persistence bindings

**Say to your agent:** *"I removed a source and added it back, and now sync
says it needs a coordinator. Fix it."*

Removing a source now also removes that source's persistence binding, and the
claim check only counts a binding of the source's current incarnation. A
binding left behind by an older release is reported by doctor's
`orphan_persistence_bindings` check. Preview, then apply after you agree:

```bash
gbrain repair orphan-bindings            # lists each binding and why it is orphaned
gbrain repair orphan-bindings --apply    # deletes them
gbrain doctor                            # orphan_persistence_bindings is ok
```

Do not delete binding rows by hand: the repair rechecks, in the same
statement, that the binding is still orphaned and that no pending write
request uses it.

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
`gbrain apply-migrations --yes` resumes that backfill and prints its progress.

### Timeline history scan coverage

Doctor's `timeline_history` check classifies at most 2,000 pages or 10
seconds of work per run. On a larger brain each run continues where the last
one stopped (the cursor is kept in the config row
`doctor.timeline_history.scan:<sources>`), so a few consecutive `gbrain doctor`
runs finish a full pass and report exact counts. While the next pass is in
progress, a clean finished pass keeps the check `ok` until a newer timeline row
is written. A run that has neither says `scan incomplete` and is a lower bound;
`gbrain repair timeline` (preview) counts the whole brain in one go.

### Stale atoms

`gbrain repair stale-atoms` (explicit-only, #5770) retires atoms that drifted
before managed re-extraction learned to retire them. It lists live atoms bound
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

### Extractor facts

Before v0.60.11.0, every managed write to a conversation page without a
Facts fence expired all of that page's conversation-extractor facts
(`expired_at` set, `row_num` cleared), and recall stopped returning them.
`gbrain repair extractor-facts` (#5731) restores them. It is explicit-only and
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

The preview warns, naming the host, when a consumer older than this release
published writes after `writer_version_cutoff`: an old consumer expires
restored facts again. Upgrade and restart it first.

<a id="captured-facts"></a>
### Captured facts

Before v0.60.30.0, automatic capture (the writeback hook, the compaction
harvest and the corpus sweep) extracted facts from gbrain's own claude-cli
model sessions and from text you pasted into a conversation. New capture skips
both, but the facts already stored stay active, so recall and hot memory keep
returning them. `gbrain repair captured-facts` expires them. It is
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
pruned, the corpus file is gone) are counted as `unclassifiable` and kept.
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
`loops_close` tool) retires its commitment fact. A loop closed while that
retirement could not commit (for example on a managed brain, where the write
was refused but the close still reported `fact_expired: true`) left the fact
active, so entity cards and recall keep the finished promise. `gbrain repair
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

<a id="failed-writes"></a>
### Failed writes

Before v0.60.38.0, on a managed brain whose `tags`, `timeline_entries` or
`takes` table had a `source_id` column gbrain does not create, the managed
writer guard refused writes it should have allowed (#5983). Each refused write
keeps a failed receipt with its full intent until receipt compaction
(`persistence.receipt_retention_days`, 30 days by default). `gbrain repair
failed-writes` submits those writes again. It is explicit-only and
preview-bound, and needs v0.60.38.0 or later (`gbrain doctor --json` reports
schema version 197 or later).

**Say to your agent:** *"Preview which refused writes gbrain can replay, show
me the list, then apply after I agree."* The agent runs `gbrain repair
failed-writes` and, after you agree, the printed apply command.

```bash
gbrain config set persistence.receipt_retention_days 90   # keep the receipts while you recover
gbrain repair failed-writes --source <id>                 # preview: every refused write with its class
gbrain repair failed-writes --source <id> --apply --expect <hash>
gbrain repair failed-writes --source <id>                 # replayed writes now read already_written
```

Candidates are failed receipts refused by the guard: `writer_coordinator_required`,
or `storage_error` "Publication failed (P0001)" from releases that did not keep
the guard's message. Only writes a caller made directly are replayed:
`put_page`, `add_timeline_entry` and `remember`. The preview gives every
candidate one class:

| Class | Meaning | What happens |
| --- | --- | --- |
| `replay` | No later write supersedes it. | Replayed on apply. |
| `already_written` | A later request with the same intent committed, or an earlier apply replayed it. | Kept. |
| `duplicate` | A later request with the same intent exists; that one is the candidate. | Kept. |
| `superseded` | A later write or delete of the page committed or is still pending; for `put_page`, also a later failed `put_page` of the page (the newer content) or a page that changed after the revision the caller read. | Kept. Read the page and re-issue the change by hand if it is still wanted. |
| `unpinned_target` | A `remember` saved unattributed; replaying would infer its subject again and could pick another page. | Kept. Re-issue it with an explicit `entity` if it is still wanted. |
| `producer_owned` | gbrain produced it (sync or file import, reconcile, relink, maintenance page, job). | Kept. The preview prints the command that produces it again from current content, such as `gbrain sync --source <id> --no-pull --retry-failed --json`. |

The apply replays exactly the previewed set. Each write is classified again
and its original caller's authority is checked again first: a write that
changed class since the preview reports `changed_since_preview`, and one whose
caller lost its grant or whose source was re-created reports
`authority_revoked`; both are kept. A replay goes through the operation's
normal path on the original caller's trust lane: a write an agent sent over MCP
is prepared as a remote write again, with its take-holder and delegated
namespace limits, so it can do no more than the original could. A `put_page`
replay is bound to the page revision the preview saw (an original `force: true`
is dropped), so a page changed since the preview reports `changed_since_preview`
or `conflict` instead of being overwritten. A `remember` replay targets the
subject the original resolved. Each replay uses a new request id derived from
the failed one, so a rerun after a crash resumes the same request and a second
apply never writes it twice (`pending_elsewhere` when another writer holds that
request). Attribution names the local owner's writer for that lane. A replay the
brain refuses reports `refused` with the code. The failed receipts stay as
history.

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
to run, or a resume was refused. `healthy` is true only when every wave check
is clean; `repairs_completed` counts the repair steps that finished.

## Recover after upgrading to this release

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

| Symptom or error text | Issue | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- | --- |
| Tag, timeline or take writes fail with `writer_coordinator_required` or `storage_error: Publication failed (P0001)` on a managed brain; sync ends `PARTIAL` at a tagged page | #5983 | `gbrain doctor --json` (`schema_version` is 197 or later) | the original `gbrain sync --source <source> … --no-pull --retry-failed --json`, then `gbrain extract --stale --source-id <source>` and `gbrain extract timeline --source db --source-id <source>`, then `gbrain facts relink --source <source> --dry-run` (paid tier only after the user agrees), then `gbrain repair failed-writes --source <source>` and, after the user agrees, its printed `--apply --expect <hash>` | `gbrain sources status` shows the new `last_commit`; a second `gbrain extract timeline --source db` run adds no rows; a second `gbrain repair failed-writes` preview lists nothing to replay | brain host; the replay apply after the user agrees | paid (relink tier), destructive (replay apply) |
| Sync `BLOCKED` with `checkpoint_validation_timeout` | #5762 | `gbrain doctor` (`persistence_request_indexes`) | `gbrain repair request-indexes --apply` when an index is missing or INVALID, then the printed `gbrain sync --source <source> --no-pull --retry-failed …` | `gbrain doctor --only persistence_request_indexes --json` reports `ok`; `gbrain sources status` shows the new `last_commit` | brain host | none |
| Doctor `persistence_request_indexes` warns | #5762 | `gbrain repair request-indexes` | `gbrain repair request-indexes --apply` | `gbrain doctor --only persistence_request_indexes --json` | brain host | none |
| Doctor `persistence_request_growth` warns | #5751, #5762 | `gbrain doctor --json` | the printed `gbrain config set persistence.limits.<limit> <value>` | `gbrain doctor --only persistence_request_growth --json` | brain host | none |
| Working-tree sync prints `legacy file(s) skipped … no contextual retrieval mode` | #5751 | `gbrain repair contextual-mode` | `gbrain repair contextual-mode --apply` | the next `gbrain sync --working-tree` no longer prints the line | brain host, after the user agrees | none |
| Working-tree sync prints `legacy file(s) skipped … not valid UTF-8` | #5751 | `find <checkout> -name '*.md' ! -exec iconv -f UTF-8 -t UTF-8 -o /dev/null {} \; -print` | re-save each listed file as UTF-8 | the next `gbrain sync --working-tree` no longer prints the line | user (re-saves the files) | none |
| Doctor `google_file_modes` warns, or the upgrade printed `[google] Google source <id> keeps its files in <dir>, outside ~/.gbrain` | #5080 | `gbrain repair google-file-modes --source <id>` | `gbrain repair google-file-modes --source <id> --apply` | `gbrain doctor --only google_file_modes --json` (`google_file_modes` ok) | brain host, after the user agrees | none |
| Recall or hot memory returns facts from gbrain's own claude-cli sessions or from pasted text; doctor `captured_facts_active` warns; the upgrade banner prints `captured_facts_active: N (explicit_kind_required; …)` | #5812, #5820 | `gbrain repair captured-facts` (add `--include-ambiguous` to include paste candidates) | `gbrain repair captured-facts --apply --expect <hash>` with the hash that preview printed | `gbrain doctor --only captured_facts_active --json` (`captured_facts_active` ok) | brain host, after the user agrees | `destructive` (quarantines facts) |
| A finished promise still shows on entity cards and in recall after its loop was closed; doctor `loop_facts_drift` warns; the upgrade banner prints `loop_facts_drift: N (explicit_kind_required; …)` | #5869 | `gbrain repair loop-facts` | `gbrain repair loop-facts --apply --expect <hash>` | `gbrain doctor --only loop_facts_drift --json` (`loop_facts_drift` ok) | brain host, after the user agrees | `destructive` (retires facts) |
| `gbrain upgrade` refuses with `requires Bun >=<floor>` (exit 78), or doctor `self_upgrade_health` says `Auto-upgrade to <target> held` | #5855 | `bun --version` | `bun upgrade`, then `gbrain upgrade` ([Bun floor](upgrades-auto-update.md#bun-floor)) | `gbrain --version` shows the target; `gbrain doctor --only self_upgrade_health --json` (`self_upgrade_health` ok) | user | `persistent_install` |

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
### Upgrading to v0.60.30.0 (fix wave 6)

**Say to your agent:** *"We upgraded gbrain to v0.60.30.0. Preview the
unlinked facts relink and the link re-derivation for each source, and tell me
what would change before applying anything."*

`gbrain upgrade` applies migrations v187 (fact relink attempts) and v188 (the
per-stint ontology dedup index). Restart every `gbrain serve`, autopilot and
worker so they run the new code, then work through what applies:

<a id="repair-recall-symptoms"></a>

| Symptom | Check or code | Issue | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| "Who invested in X?" or "Who attended <meeting>?" finds nobody; meeting attendance edges point meeting -> person, or notes-only mentions are typed attended | none | N9-2, N9-3, N9-4, N12-7 | `gbrain extract links --source db --repair-attendance --source-id <id>` (attendance only, preview-bound) | `gbrain extract links --source db --include-frontmatter --source-id <id>` per source; body links also re-derive on the next `gbrain extract --stale` | `gbrain graph <person-slug>` shows person -> page `invested_in` / `attended` edges | brain host, after the user agrees | none |
| Facts saved without an entity are missing from entity recall and skipped as `no_entity` by the conflict sweep | doctor `unlinked_facts` | #5836 | `gbrain facts relink --dry-run` | `gbrain facts relink` (model tier capped by `--max-usd`, default $1.00) | `gbrain doctor` (`unlinked_facts`); `gbrain decide status` | agent, after the user agrees | `paid` (capped by `--max-usd`) |
| `remember` answers `warnings: ["NO_ENTITY"]` | none | #5836 | none | pass `entity`, or name exactly one existing person or company in the text; `gbrain config set facts.entity_inference off` turns inference off | the response carries `entity_inferred` or the chosen entity | agent | none |
| A CLI write on PGLite pauses for up to 30 s, then fails lock-busy | lock busy | N5-2 | none | wait for the other CLI call, or stop the long-running non-serve holder (for example a jobs daemon) | re-run the write | agent | none |
| The next `gbrain eval suspected-contradictions` estimates a full re-judge | none | N2-3 | the printed cost estimate | run it after you agree (judge prompt v3 invalidated the cache once) | the run reports judged pairs | agent, after the user agrees | `paid` |
| Hybrid search on Postgres returns keyword-only results or hits the vector timeout | doctor `vector_plan` | #5824 | `gbrain doctor` | upgrade and restart; rollback for this release: `gbrain config set search.vector_legacy_guard true`, then restart serve and autopilot | `gbrain doctor` shows `vector_plan` ok | brain host | none |
| Facts about you that came from pasted text or from gbrain's own claude-cli calls | doctor `self_capture` | #5812, #5820 | `gbrain recall` for the fact | `gbrain forget <fact id>`; doctor `self_capture` prints one-time quarantine commands for old self-capture files | `gbrain doctor` | agent, after the user agrees | `destructive` (forgets the fact) |

<a id="fix-wave-5"></a>
### Upgrading to v0.60.28.0 (fix wave 5)

**Say to your agent:** *"We upgraded gbrain to v0.60.28.0. Restart everything
that runs it, then walk me through what doctor finds, in order, before
changing anything."*

Most wave 5 fixes take effect only in a process that runs the new binary, so
restart first. `gbrain sources writer status --json` lists, in
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

| Symptom | Check or code | Issue | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| synthesize fails every run; `POST /ingest` 409 (was 500); workers refuse to start with "legacy jobs have missing or unsupported authority" | `legacy_job_authority` / `permission_denied` ([legacy job authority](#legacy-job-authority)) | #5157, #5114 | stop `gbrain serve`, autopilot and workers; `gbrain jobs cancel <active id>`; `gbrain jobs authorize-legacy --select "status=waiting\|delayed\|waiting-children\|paused"` | `gbrain jobs authorize-legacy --select "<same filter>" --expect <hash> --yes`, then restart | `gbrain doctor` shows `legacy_job_authority` ok; `/ingest` returns 202 | brain host, after the user agrees | `paid` (authorizes legacy jobs) |
| Search returns atoms quoting text a page no longer has, or atoms of deleted pages | doctor `atom_provenance_drift` | #5770 | `gbrain repair stale-atoms --source <id>` | `gbrain repair stale-atoms --source <id> --apply --expect <hash>` | `gbrain doctor` (`atom_provenance_drift` drops by the retired count) | brain host, after the user agrees | `destructive` (removes stale atoms) |
| `sources add`, `claim`, `rebind`, `archive`, `remove`, clone, reclone or `sources writer transfer` on a repo with more than ~10k files fails with "The verified source manifest exceeds the 1 MiB administration metadata bound" | `request_too_large` | #5790 | none: upgrade and restart every writer host and resident `gbrain serve` | Re-run the failed command (with the same `--request-id` if you kept it) | `gbrain sources writer status --json` shows the source bound, and its `manifest_digest` is set | agent | none |
| A stdio agent bound with `GBRAIN_SOURCE` (or `.gbrain-source`) gets `permission_denied` naming the binding when it passes `source_id` | `permission_denied` (hint starts "This connection is bound to source …") | #5081 | `gbrain sources list` (the source must show `federated`, not `isolated` or `unset`) | `gbrain sources federate <id>` on the brain host | Repeat the read with `source_id: "<id>"`; it returns only that source's rows. See [explicit reads from a bound agent connection](multi-source-brains.md#explicit-reads-from-a-bound-agent-connection) | brain host, after the user agrees | none |
| A new session's start-up context showed another session's text (`Last session activity: …`) | none | #5558 | none | Upgrade the `gbrain` each harness runs its hooks with and restart the harness. If you set `GBRAIN_HOOKS=0` as a workaround, remove it from the environment the harness starts from (shell profile or service) and restart the harness again | A new session shows no `Last session activity` line, and `gbrain doctor` reports `bootstrap_hooks_heartbeat` again after a few turns (capture and session persistence are back) | user (upgrades and restarts the harness) | `persistent_install` |
| `connect --harness codex\|claude-code\|opencode --install` stored the bearer token inline in the harness config without telling you | receipt `token_storage: "inline"` | #5775 | On the brain host: `gbrain mcp admin invalidate-tokens <client_id> --url <mcp_url> --admin-token-file <owner-admin-token-file> --json` (only if the config file was exposed) | `gbrain mcp admin invalidate-tokens <client_id> --yes --if-version <revision> --url <mcp_url> --admin-token-file <owner-admin-token-file> --json`, then `gbrain connect <mcp_url> --harness <harness> --credentials-file <handoff> --install --fresh-token`, then reload the harness | The new receipt prints `token_storage`, `config_path`, `renew_command` and `if_exposed`, and the harness answers a memory round trip | brain host, after the user agrees | `credentials` (invalidates tokens) |
| A second brain's autopilot replaced the first one's job, logs interleave in `~/.gbrain/autopilot.log`, or `gbrain autopilot --status --json` shows `job.needs_reinstall: "legacy_shared_job"` (or `"wrapper_missing"` after moving a brain); install refuses with `autopilot_job_owned_by_other_brain` | `gbrain autopilot --status --json` (`job.*`) / `autopilot_job_owned_by_other_brain` | #5195 | `GBRAIN_HOME=<brain parent> gbrain autopilot --status --json` | `GBRAIN_HOME=<brain parent> gbrain autopilot --install` (every non-default brain first, then the default brain) | `GBRAIN_HOME=<brain parent> gbrain autopilot --status --json` shows `job.needs_reinstall: null` and the brain's own `launchd_label` / `systemd_unit`. See [several brains on one host](live-sync.md#several-brains-on-one-host) | brain host, after the user agrees | `persistent_install` |
| `gbrain serve` started in a `.gbrain-mount` project: CLI writes fail `owner_unavailable` and MCP writes stay `queued` | `owner_unavailable` | #5237 | none | Upgrade and restart the resident `gbrain serve` (the harness that spawns it) | `gbrain sources writer status --probe --json` from the project answers | user (upgrades and restarts the harness) | `persistent_install` |
| Backup coverage reports `remote evidence: unavailable` for a private remote that is pushed | doctor `backup_coverage` | #5794 | none | Upgrade, then `gbrain backup check` | `gbrain backup status --json` shows `verification.state: "verified"`; see [remote unavailable](../operations/backup-check.md#remote-unavailable) | agent, after the user agrees | `persistent_install` (upgrade) |
| On Windows, a write or `gbrain sync` refuses a colon slug such as `calendar:abc` | [`colon_slug_windows_write_through`](write-refusals.md#colon_slug_windows_write_through) | #5032 | none | Use a slug without `:`, or write the page from a macOS or Linux host that owns the source | The write succeeds, or `gbrain sync` no longer lists the file | agent | none |
| Search empty or incomplete after upgrading; doctor `text_projection_readiness` warns | `text_projection_readiness` | #5401 | `gbrain doctor` (pending count, also while a PGLite resident runs) | `gbrain projections drain` (Postgres, or PGLite with no resident); on PGLite with a resident, wait or stop, drain and restart per [projection owner resident](#projection-owner-resident) | `gbrain doctor` shows `text_projection_readiness` ok | brain host | none |
| `Error [projection_owner_resident]` from `gbrain projections drain` (exit 2) | [`projection_owner_resident`](#projection-owner-resident) | #5401 | `gbrain doctor` | the printed stop, drain and restart commands | `gbrain doctor` | brain host | none |
| `[gbrain] warning: OPENAI_API_KEY in this process's environment differs from openai_api_key …`; doctor `embedding_key_source` warns | `embedding_key_source` ([provider key source](#embedding-key-source)) | #5137 | `gbrain doctor` (`embedding_key_source`) | remove the variable and restart that process, or `gbrain config unset openai_api_key` | the warning no longer prints; `gbrain doctor` shows `embedding_key_source` ok | user (owns the key) | `credentials` |
| `The OpenAI embedding provider rejected its key (HTTP 401)` | [`embedding_auth_failed`](write-refusals.md#embedding_auth_failed) | #5137 | `gbrain doctor` (`embedding_key_source`, `embedding_provider`) | the printed fix for the key source in effect, then `gbrain embed --stale` | `gbrain doctor` shows `embedding_provider` ok | user (owns the key) | `credentials`; `paid` for `embed --stale` |
| Conversation facts missing from recall after managed writes | `extractor_facts_expired` | #5731 | `gbrain repair extractor-facts` | `gbrain repair extractor-facts --apply --expect <hash>` (ambiguous: add `--include-ambiguous` to both) | `gbrain doctor` | brain host, after the user agrees | `destructive` (rewrites expired facts) |


### Symptoms from the lifecycle fixes in v0.60.20.0

<a id="repair-migration-symptoms"></a>

| Symptom or error text | Issue | Preview | Apply | Verify | Who acts | Consent |
| --- | --- | --- | --- | --- | --- | --- |
| `gbrain upgrade` said the upgrade failed, or migrations ran twice | #5693 | `gbrain apply-migrations --list` | `gbrain apply-migrations --yes` | `gbrain doctor --only minions_migration --json` (`minions_migration` ok) | agent, after the user agrees | none |
| `another apply-migrations is running (host …, pid …)` | #5693 | `gbrain doctor` | wait, then `gbrain apply-migrations --yes` | `gbrain apply-migrations --list` | agent | none |
| doctor `orphan_persistence_bindings`; a re-added source fails with `writer_coordinator_required` | #5732 | `gbrain repair orphan-bindings` | `gbrain repair orphan-bindings --apply` | `gbrain doctor` | brain host, after the user agrees | none |
| doctor `stale_embedding_effects`; `writer_not_quiesced` names an embedding effect | #5629, #5734 | `gbrain repair embedding-effects --source <id>` | `gbrain repair embedding-effects --source <id> --apply` | `gbrain doctor` (pending until the owner run commits a `retry_queued` effect) | brain host, after the user agrees | none |
| autopilot never syncs a connector, or prints `has never synced` | #5673 | `gbrain sources status <id>` | `gbrain sync --source <id>` once | `gbrain sources status <id>` | agent | `egress` (fetches from the provider) |
| a connector source keeps a stale `local_path` | #5673 | `gbrain sources list` | `gbrain sources set-path <id> --clear` | `gbrain sources list` | agent, after the user agrees | none |
| classic writes refused after leaving managed mode, or `local_markers: pending` | #5628 | `gbrain sources writer deactivate --dry-run` | see the [deactivate runbook](../architecture/topologies.md#deactivate-runbook) | `gbrain sources writer status` on every host | brain host, after the user agrees | none |

`orphan-bindings` and `embedding-effects` also run under `gbrain repair --all`
and `gbrain doctor --remediate --include-repairs`; `embedding-effects` is paid
work when it queues a retry. Retry commands: `gbrain sources writer retry-effects <source> --request-id <id>`
(one failed or parked effect), `gbrain sync --source <id> --no-pull --retry-failed`
(a failed sync write) and `gbrain repair embedding-effects --source <id> --apply`
(stuck embedding effects, including a used-up retry allowance).

## Quarantine self-captured corpus files

`gbrain doctor` reports `self_capture` when the dream session corpus
(`dream.synthesize.session_corpus_dir`) still holds files captured from
gbrain's own `claude-cli` sessions (#5413). Dream and the sweep already skip
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
it (#5629), or that failed (#5734, for example after a provider outage). Either
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

## Wave 5 refusal codes

Each heading below is the `docs` anchor a refusal carries.

### Explicit-only repair kinds

`google-file-modes`, `stale-atoms`, `extractor-facts`, `captured-facts` and
`loop-facts` run only when named: `gbrain repair <kind>` previews, and
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

### Legacy job authority

`permission_denied` with this anchor means a queued job row has SQL NULL
`submission_authority`, left by an upgrade across v0.50 (#5157, #5114).

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
changed. The upgraded resident drains the queue itself; re-run `gbrain doctor`
to watch the pending count in `text_projection_readiness` (doctor asks the
resident over its local socket, so the count shows while the resident runs; a
resident that does not answer may predate this release and should be restarted
on the upgraded gbrain).

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

## Related

- [Write refusal reasons](write-refusals.md) — what a refused write means and the recovery command
- [Concurrent writes and durable receipts](concurrent-writes.md) — receipts, retries and capacity limits
- [v0.60.5.0 upgrade steps](../../skills/migrations/v0.60.5.0.md) — the backup-first upgrade that introduced these repairs
- [Topologies: claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook) — quiescence checklist, the writer admin lock
