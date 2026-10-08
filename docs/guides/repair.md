# Repair residual damage with `gbrain repair`

`gbrain doctor` finds some damage that it cannot fix on its own: timeline
history that exists only in the database, derived pages without an explicit
visibility, pages indexed before the safe-chunk fence, pages imported
without a contextual retrieval mode, connector checkpoint rows no source
can load, and Google source files other local users can read. `gbrain repair`
fixes those and the other kinds listed in
[What each kind fixes](#what-each-kind-fixes). Every run is a preview unless
you pass `--apply`.
Nine explicit-only kinds, `google-file-modes`, `stale-atoms`, `extractor-facts`,
`captured-facts`, `loop-facts`, `ontology-facts`, `orphan-children`, `failed-writes` and `frontmatter`, run only when you name them (see [Explicit-only repair kinds](#explicit-only-repair-kinds)).
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
| `--expect <hash>` | Explicit-only kinds: apply exactly the set the preview printed under this hash. Required with `--apply` for `stale-atoms`, `extractor-facts`, `captured-facts`, `loop-facts`, `failed-writes` and `frontmatter`. |
| `--include-ambiguous` | `extractor-facts` and `captured-facts`: widen the hashed set to `ambiguous` facts. `frontmatter`: add interpretive file changes. Pass it to both the preview and the apply. See [Extractor facts](#extractor-facts), [Captured facts](#captured-facts) and [Frontmatter](#frontmatter). |
| `--only <path>`, `--skip <path>` | `frontmatter` only: select source-relative files (repeatable). The hash covers the selection, so pass the same flags to the apply. |
| `--diff` | `frontmatter` only: print every per-file diff instead of one sample per class (`--json` always carries all of them). |
| `--yes` | `frontmatter --apply` only: the user agreed to the previewed file changes (destructive consent). Without it a terminal asks, and a run without a terminal exits 3 with the consent payload. |
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
| `take-supersession` | none | Rebuilds `takes.superseded_by` for supersession chains written before the pointer moved onto the old fence row (#5886). Each struck take is linked to the row that replaced it only from evidence: a committed `takes_supersede` receipt, a stored `superseded_by`, or a row carrying the old `superseded by #<own row>` pointer with exactly one possible predecessor. The pointer is written onto the old row (`<source>; superseded by #N`) and stale self-pointers are dropped through a revision-bound `put_page`; a page whose fence is already right but whose stored pointers differ is reprojected without a page write. See [take supersession](#take-supersession). | `ambiguous_pages` / `ambiguous_rows`: pages where a new row has two or more possible predecessors, or where evidence conflicts. The preview lists each with its candidates and the manual edit; nothing on them changes. `unparsed_pages`: pages whose takes fence does not parse cleanly. |
| `connector-checkpoints` | `connector_checkpoints` | Deletes managed connector checkpoint rows and retry pointers that no registered connector source can load and that are older than 7 days. They accumulate after a content setting such as `g_history_days` changes, or when a connector host older than v0.60.11.0 runs during an upgrade. Cleanup only: it never copies or re-keys a checkpoint, takes no journal admission and runs brain-wide (`--source` does not narrow it). | Rows a queued or running connector write, or a connector's recorded pending set, still references. |
| `orphan-bindings` | `orphan_persistence_bindings` | Deletes persistence source bindings whose source was removed, or that belong to an earlier incarnation of a source re-added under the same id. `gbrain sources remove` and `gbrain sources purge` delete the binding; one an older gbrain left behind makes the re-added source read as claimed, so every `gbrain sync --source <id>` fails with `writer_coordinator_required`. Bookkeeping only: no journal admission, no page or file changes, and it runs brain-wide (`--source` does not narrow it). See [orphan bindings](#orphan-bindings). | A binding that a queued, running or recovering write request of the same source incarnation still references. |
| `embedding-effects` | `stale_embedding_effects` | Settles stale queued and failed embedding effects of committed writes, which block receipt compaction and activation: `reconciled` when current vectors pass the effect verifier, `superseded` when the page was deleted or a newer revision owns its own effect, `retry_queued` for the owner (paid; a used-up retry allowance gets one new bounded cycle per explicit apply). See [stale queued embedding effects](#stale-queued-embedding-effects). | `blocked` effects, counted by reason (`owner_unavailable`, `embedding_disabled`, `embedding_unconfigured`, `projection_pending`, `no_replacement_obligation`). |
| `attribution-backfill` | none | Fills write attribution (who wrote it) on pages, page versions and facts written before attribution was recorded, only where exactly one committed request in the write journal proves the writer: the page write whose recorded result is the row's revision, or the `remember` that inserted the fact. Fills NULLs only, in committed batches of 1,000 that resume after an interruption; no content, revision, page file or request ID changes. See [write attribution](../mcp/ADMIN.md#write-attribution). | `unrecorded_pages`, `unrecorded_page_versions`, `unrecorded_facts`: rows the journal cannot prove. They stay `unrecorded`; nothing is inferred. |
| `safe-chunks` | `safe_index_pending` (also `contextual_retrieval_coverage`, `details.unsealed_pages`) | Rebuilds the chunks of markdown and code pages indexed before the safe-chunk fence, which remote and MCP search withhold. It rebuilds projections only: no page write, no new page version and no request ID. Vectors whose embedding input did not change are kept; the rest are embedded unless you pass `--no-embed` or no embedding model is configured. | `code_without_source_path`: code pages with no recorded file to re-chunk. `unsupported_page_kind`: other page kinds, such as images. Their importer re-seals them. |
| `orphan-children` | `child_table_orphans` (also a `storage_corrupt` error) | Explicit-only. Deletes rows of page child tables (chunks, versions, tags, takes, raw data, timeline, links) whose page row no longer exists, and clears dangling `links.origin_page_id` and `files.page_id` references, each in one statement that rechecks the orphan condition. See [orphan children](#orphan-children). | `torn_pages`: page rows whose stored body cannot be read (torn TOAST). The preview names them; the repair never changes them. |
| `planner-stats` | `planner_stats_stale` | Runs `ANALYZE` on the hot tables (pages, links, facts, takes, content_chunks, timeline_entries) whose planner statistics are stale, so search and graph reads stop planning as slow nested loops. PGLite also resets each table's pending row count; Postgres runs each `ANALYZE` with a 60 s statement timeout and a 2 s lock timeout. No journal admission, no user data changes, brain-wide. | none |
| `contextual-mode` | `contextual_retrieval_coverage` (pages with no recorded mode) | Stamps the contextual retrieval mode on markdown pages imported without one (for example by a large `--no-embed` sync, or by a connector source on an older gbrain), exactly as a fresh import of the page would: the page, source and brain settings decide, and the per-chunk synopsis tier lands at the free title tier. It rebuilds projections only: no page write, no new page version and no request ID. A page whose stored vectors already match the stamped convention keeps them and queues no re-embedding; a page whose embedding input changes has only those vectors cleared and is re-embedded once, unless you pass `--no-embed`. | `unsealed_projection`: pages whose chunks lag their text; `gbrain embed --stale` or `safe-chunks` seals them first, and the next run stamps them. `embed_skip`: pages marked to skip embedding keep their stored vectors and are not stamped. |

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
### Managed sync request indexes

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
queued Markdown and code page is rebuilt. Doctor
`text_projection_readiness` warns while any visible page is pending.

The resident owner (`gbrain serve` or autopilot) drains the queue on
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

<a id="failed-writes"></a>
### Failed writes

On a managed brain whose `tags`, `timeline_entries` or `takes` table has a
`source_id` column gbrain does not create, the managed writer guard of a
gbrain older than v0.60.38.0 refuses writes it should allow. Each refused write
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
| `superseded` | A later write or delete of the page committed or is pending; for `put_page`, also a later failed `put_page` (newer content) or a page changed since the caller read it. | Kept; re-issue by hand if still wanted. |
| `unpinned_target` | A `remember` saved unattributed; replaying would infer its subject again and could pick another page. | Kept. Re-issue it with an explicit `entity` if it is still wanted. |
| `file_database_drift` | Its last replay hit `source_changed` (file and database differ). | Kept until the page changes; reconcile it first. |
| `producer_owned` | gbrain produced it (sync or file import, reconcile, relink, maintenance page, job). | Kept. The preview prints the command that produces it again from current content (sync: `gbrain sync --source <id> --no-pull --retry-failed`). |

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
   applied 2, skipped 0, complete
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
   $ git -C ~/brain/notes commit -qam "Repair frontmatter"
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
   $ git -C ~/brain/notes commit -qam "Keep the later digest title"
   $ gbrain sync --source notes --no-pull
   +0 added, ~0 modified, -0 soft-deleted (recoverable 72h), R0 renamed
   $ gbrain doctor --only git_held_files,frontmatter_repairable
   [OK] git_held_files: No Git source files are held.
   [OK] frontmatter_repairable: No file has frontmatter gbrain repair frontmatter would fix.
   ```

Doctor reports the same state: `git_held_files` (warn per source with counts,
the first paths and the commands; `fail` above `sync.hold_escalate_count`,
default 50) and `frontmatter_repairable` (files the repair can fix, including
ones that import only after quoting). Both are explicit-only findings:
`gbrain doctor --remediation-plan --json` lists them as `explicit_kind_required`
with `gbrain repair frontmatter --source <id>`, and `--remediate` never runs the
repair. `frontmatter_hook` warns when an installed pre-commit hook is older
than the running gbrain's hook; refresh it with `gbrain frontmatter install-hook --force`.

Settings, all read by every sync:

| Key | Default | Effect |
| --- | --- | --- |
| `sync.holds` | `hold` | `fail` makes sync fail closed: a content refusal blocks the sync. |
| `sync.hold_cap` | `500` | How many holds a sync result lists in detail; storage is never capped and valid files always import. |
| `sync.hold_escalate_count` / `sync.hold_escalate_pct` | `50` / `5` | A source holding more files, or a run holding more than that share of at least 40 screened imports, reports `holds_escalated` and doctor `git_held_files` fails. |
| `sync.parser_regression` | `stop` | `hold` holds a file whose exact bytes imported under an earlier gbrain (`parser_regression`) instead of stopping the run with `sync_parser_regression`. |

To prevent new broken files, write brain files through `put_page`/`capture`
or a YAML serializer, check generated content with
`gbrain frontmatter validate --stdin --path <source-relative path>` before
writing it, and install the staged-content pre-commit hook with
`gbrain frontmatter install-hook` (the user's decision: it writes into their
repository). See the `frontmatter-guard` skill.

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
| `needs_review` | No rule fixes it (mis-indented YAML, a protected key such as `visibility`, an import that would keep page data the file does not carry, a file over 5 MB). | Never written. The preview names the exact manual fix. |

Two passes: when interpretive candidates exist, the safe preview's
`next_actions` carry both the safe apply and the `--include-ambiguous` preview.
Review each interpretation in the full diff, then approve all of them or only
some with `--only`/`--skip`; a file left out stays held and unchanged.

Every change must leave a file that parses strictly and earns no hold. The
hash binds the selected files, their exact before and after bytes, and the
page each import would store (bound to the page revision). The apply derives
each change again from the file as it is: a file, proposal or page that
changed since the preview reports `changed_since_preview` and is not written.
The apply refuses while an unfinished managed sync still names a selected file
(`sync_in_progress`; finish it with `gbrain sync --source <id> --no-pull`).

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
   2 file(s) held this run, 2 held in source notes; they do not block sync. Inspect them with 'gbrain sources status notes'; then nothing repairs the fence holds by itself (no maintenance run is active), so preview the fence repairs with gbrain repair fences --source notes (read-only, no model call: it lists each held file with its planned repair or the exact edit, and prints the apply command with --expect <hash>), then run the apply command it prints. Preview the repair: gbrain repair fences --source notes
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
   applied 2, skipped 0, complete
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
   $ git -C ~/brain/notes commit -qam "Repair fences"
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
the before and after sha256 and the cost, never a cell value. A source this
host does not own is skipped (`owner_unavailable`), and so is one whose sync is
still running (`sync_in_progress`); the next run picks them up. MCP and
thin-client callers cannot run a repair or reach the model; a hold's fix hands
them the owner-host command to give the user.

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
remediation run and the replay of a restore a previous `extractor-facts` apply left pending. A malformed
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
| Tag, timeline or take writes fail with `writer_coordinator_required` or `storage_error: Publication failed (P0001)` on a managed brain; sync ends `PARTIAL` at a tagged page | `gbrain doctor --json` (`schema_version` is 197 or later) | the original `gbrain sync --source <source> … --no-pull --retry-failed --json`, then `gbrain extract --stale --source-id <source>` and `gbrain extract timeline --source db --source-id <source>`, then `gbrain facts relink --source <source> --dry-run` (paid tier only after the user agrees), then `gbrain repair failed-writes --source <source>` and, after the user agrees, its printed `--apply --expect <hash>` | `gbrain sources status` shows the new `last_commit`; a second `gbrain extract timeline --source db` run adds no rows; a second `gbrain repair failed-writes` preview lists nothing to replay | brain host; the replay apply after the user agrees | paid (relink tier), destructive (replay apply) |
| Sync `BLOCKED` with `checkpoint_validation_timeout` | `gbrain doctor` (`persistence_request_indexes`) | `gbrain repair request-indexes --apply` when an index is missing or INVALID, then the printed `gbrain sync --source <source> --no-pull --retry-failed …` | `gbrain doctor --only persistence_request_indexes --json` reports `ok`; `gbrain sources status` shows the new `last_commit` | brain host | none |
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
| Search empty or incomplete after upgrading; doctor `text_projection_readiness` warns | `text_projection_readiness` | `gbrain doctor` (pending count, also while a PGLite resident runs) | `gbrain projections drain` (Postgres, or PGLite with no resident); on PGLite with a resident, wait or stop, drain and restart per [projection owner resident](#projection-owner-resident) | `gbrain doctor` shows `text_projection_readiness` ok | brain host | none |
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
(one failed or parked effect), `gbrain sync --source <id> --no-pull --retry-failed`
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

## Repair refusal codes

Each heading below is the `docs` anchor a refusal carries.

### Explicit-only repair kinds

`google-file-modes`, `stale-atoms`, `extractor-facts`, `captured-facts`,
`loop-facts` and `ontology-facts` run only when named: `gbrain repair <kind>` previews, and
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
changed. The resident drains the queue itself; re-run `gbrain doctor`
to watch the pending count in `text_projection_readiness` (doctor asks the
resident over its local socket, so the count shows while the resident runs; a
resident that does not answer runs an older gbrain, so restart it on the
current version).

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

## Related

- [Write refusal reasons](write-refusals.md) — what a refused write means and the recovery command
- [Concurrent writes and durable receipts](concurrent-writes.md) — receipts, retries and capacity limits
- [v0.60.5.0 upgrade steps](../../skills/migrations/v0.60.5.0.md) — backup-first upgrade steps for a brain older than v0.60.5.0
- [Topologies: claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook) — quiescence checklist, the writer admin lock
