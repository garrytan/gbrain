# Repair residual damage with `gbrain repair`

`gbrain doctor` finds some damage that it cannot fix on its own: timeline
history that exists only in the database, derived pages without an explicit
visibility, pages indexed before the safe-chunk fence, pages imported
without a contextual retrieval mode, and connector checkpoint rows no source
can load. `gbrain repair` fixes those five kinds. Every run is a preview
unless you pass `--apply`.
`gbrain doctor --remediation-plan` lists the same kinds as repair steps, and
`gbrain doctor --remediate --yes --include-repairs` runs them under a budget
(see [Run repairs through doctor](#run-repairs-through-doctor)).

**Say to your agent:** *"Doctor says some timeline history is only in the
database. Show me what `gbrain repair` would change, then apply it."* The
agent runs `gbrain repair` to preview and, after you agree,
`gbrain repair <kind> --apply` on the brain host.

## Preview first

```bash
gbrain repair                    # preview every kind
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
gbrain repair --all --apply                    # every kind in order
```

`--apply` writes without a prompt, so review the preview first. With
`--apply` you must name a kind or pass `--all`; `--yes` is refused, and so is
any other option the table below does not list, including `--max-usd`: a
refused run changes nothing. To cap paid embedding work, run the repairs
through `gbrain doctor --remediate --yes --include-repairs --max-usd <n>`. `--all`
runs `timeline`, then `visibility`, then `safe-chunks`, then `contextual-mode`, then `connector-checkpoints`, then `request-indexes`, then `connector-fences`, then `orphan-bindings`, then `embedding-effects`, and stops at the
first kind that stops.

Each item is re-checked against the page's current state just before it is
written, and the write is bound to the revision it just read, so an edit made
after planning is kept and repaired too. An item that no longer needs the
repair, or whose page changes during the write, is counted as `skipped` and
left for the next run. Nothing is deleted.

| Option | Effect |
| --- | --- |
| `--apply` | Write the repair. Without it, only preview. |
| `--source <id>` | Limit the run to one active source. The default is every active (non-archived) source. An unknown or archived id is refused. |
| `--limit <n>` | Repair at most `n` items per kind in this run (a positive integer; with `--all`, up to `n` for each kind). Rerun the same command to continue. |
| `--no-embed` | `safe-chunks` and `contextual-mode`: skip the embedding provider. Run `gbrain embed --stale` later. `timeline` and `visibility` pages are re-embedded by their publication either way. |
| `--all` | Run every kind in order. |
| `--json` | Print `{ scope, mode, results[], paid_kinds }`, one result per kind with `paid`, `affected`, `sample`, `residuals`, `cost`, `capacity`, `resumed_from`, `applied`, `skipped`, `complete`, `stopped` and `apply_command`. |

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
| `safe-chunks` | `safe_index_pending` (also `contextual_retrieval_coverage`, `details.unsealed_pages`) | Rebuilds the chunks of markdown and code pages indexed before the safe-chunk fence, which remote and MCP search withhold. It rebuilds projections only: no page write, no new page version and no request ID. Vectors whose embedding input did not change are kept; the rest are embedded unless you pass `--no-embed` or no embedding model is configured. | `code_without_source_path`: code pages with no recorded file to re-chunk. `unsupported_page_kind`: other page kinds, such as images. Their importer re-seals them. |
| `contextual-mode` | `contextual_retrieval_coverage` (pages with no recorded mode) | Stamps the contextual retrieval mode on markdown pages imported without one (for example by a large `--no-embed` sync or a connector source before this release), exactly as a fresh import of the page would: the page, source and brain settings decide, and the per-chunk synopsis tier lands at the free title tier. It rebuilds projections only: no page write, no new page version and no request ID. A page whose stored vectors already match the stamped convention keeps them and queues no re-embedding; a page whose embedding input changes has only those vectors cleared and is re-embedded once, unless you pass `--no-embed`. | `unsealed_projection`: pages whose chunks lag their text; `gbrain embed --stale` or `safe-chunks` seals them first, and the next run stamps them. `embed_skip`: pages marked to skip embedding keep their stored vectors and are not stamped. |

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

<a id="connector-held-items"></a>
### Connector held items

The doctor check `connector_held_items` counts Google and GitHub items held
after three consecutive failed syncs. It is not a repair kind: fix the cause
the item's error code names, then re-attempt. See
[held items](google-connect.md#held-items) for the rules.

| Symptom | Preview | Apply | Verify |
| --- | --- | --- | --- |
| `connector_held_items` warns, or `gbrain waiting` says coverage is partial | `gbrain sources status <source>` | `gbrain sources retry-held <source>`, then `gbrain sync --source <source>` | `gbrain sources status <source>` (a recovered item leaves the list) |
| A sync fails with `connector_holds_exhausted` | `gbrain sources status <source> --json` | Fix the cause, then `gbrain sources retry-held <source>` and `gbrain sync --source <source>` | `gbrain doctor` |
| A sync refuses with `connector_fence_below_timeline` | `gbrain repair connector-fences --source <source>` | `gbrain repair connector-fences --source <source> --apply`, then `gbrain sources retry-held <source>` | `gbrain sync --source <source>` succeeds |

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

Apply everything after the user agrees: gbrain doctor --remediate --yes --include-repairs --max-usd 0.01
Ask the user before applying any repair step.
```

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
| `unsupported` | No command can clear it yet; it is reported so it is never hidden (a stale queued embedding effect). |

Exit status: `0` when no automatically repairable finding remains and no step
failed, even if operator-required or unsupported findings remain (they are
listed); `1` when a repairable finding remains, a step failed, or the budget
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
   `gbrain doctor --remediate --yes --include-repairs --max-usd <n>`
   (the plan prints `<n>` filled in).
4. If it stops as budget-exhausted, ask the user again, then run the printed
   resume command (raise `--max-usd` only with their agreement).
5. Follow each `operator_required` instruction the run prints, and note the
   `unsupported` ones.
6. Verify: `gbrain doctor --remediation-plan` lists no repair steps.

| Symptom or error text | Issue | Preview | Apply | Verify |
| --- | --- | --- | --- | --- |
| Sync `BLOCKED` with `checkpoint_validation_timeout` | #5762 | `gbrain doctor` (`persistence_request_indexes`) | `gbrain repair request-indexes --apply` when an index is missing or INVALID, then the printed `gbrain sync --source <source> --no-pull --retry-failed …` | `gbrain doctor` shows `persistence_request_indexes` ok; `gbrain sources status` shows the new `last_commit` |
| Doctor `persistence_request_indexes` warns | #5762 | `gbrain repair request-indexes` | `gbrain repair request-indexes --apply` | `gbrain doctor` |
| Doctor `persistence_request_growth` warns | #5751, #5762 | `gbrain doctor --json` | the printed `gbrain config set persistence.limits.<limit> <value>` | `gbrain doctor --json` (check `persistence_request_growth`) |
| Working-tree sync prints `legacy file(s) skipped … no contextual retrieval mode` | #5751 | `gbrain repair contextual-mode` | `gbrain repair contextual-mode --apply` | the next `gbrain sync --working-tree` no longer prints the line |
| Working-tree sync prints `legacy file(s) skipped … not valid UTF-8` | #5751 | `find <checkout> -name '*.md' ! -exec iconv -f UTF-8 -t UTF-8 -o /dev/null {} \; -print` | re-save each listed file as UTF-8 | the next `gbrain sync --working-tree` no longer prints the line |

Hosted and thin-client callers see the same checks in `gbrain remote doctor`
as one line each, for example
`timeline_history: ... host operator action required: on the brain host run gbrain doctor --remediation-plan`.
A line that says `Unknown:` means the check could not run; it is not a clean
result. Ask the brain host's operator to run the steps above.

### Symptoms from the lifecycle fixes in this release

| Symptom or error text | Issue | Preview | Apply | Verify |
| --- | --- | --- | --- | --- |
| `gbrain upgrade` said the upgrade failed, or migrations ran twice | #5693 | `gbrain apply-migrations --list` | `gbrain apply-migrations --yes` | `gbrain doctor` (`minions_migration` ok) |
| `another apply-migrations is running (host …, pid …)` | #5693 | `gbrain doctor` | wait, then `gbrain apply-migrations --yes` | `gbrain apply-migrations --list` |
| doctor `orphan_persistence_bindings`; a re-added source fails with `writer_coordinator_required` | #5732 | `gbrain repair orphan-bindings` | `gbrain repair orphan-bindings --apply` | `gbrain doctor` |
| doctor `stale_embedding_effects`; `writer_not_quiesced` names an embedding effect | #5629, #5734 | `gbrain repair embedding-effects --source <id>` | `gbrain repair embedding-effects --source <id> --apply` | `gbrain doctor` (pending until the owner run commits a `retry_queued` effect) |
| autopilot never syncs a connector, or prints `has never synced` | #5673 | `gbrain sources status <id>` | `gbrain sync --source <id>` once | `gbrain sources status <id>` |
| a connector source keeps a stale `local_path` | #5673 | `gbrain sources list` | `gbrain sources set-path <id> --clear` | `gbrain sources list` |
| classic writes refused after leaving managed mode, or `local_markers: pending` | #5628 | `gbrain sources writer deactivate --dry-run` | see the [deactivate runbook](../architecture/topologies.md#deactivate-runbook) | `gbrain sources writer status` on every host |

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
`gbrain doctor --remediate --yes --include-repairs --max-usd <n>`, the estimate
covers the whole retry budget each grant authorizes. A resumed run replays the
grant it already made instead of granting another cycle. A signature-mismatched
vector is never reconciled; it is re-embedded.

## Related

- [Write refusal reasons](write-refusals.md) — what a refused write means and the recovery command
- [Concurrent writes and durable receipts](concurrent-writes.md) — receipts, retries and capacity limits
- [v0.60.5.0 upgrade steps](../../skills/migrations/v0.60.5.0.md) — the backup-first upgrade that introduced these repairs
- [Topologies: claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook) — quiescence checklist, the writer admin lock
