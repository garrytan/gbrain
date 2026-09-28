# Switching embedding models or dimensions on an existing brain

Use `gbrain migrate embeddings` for both same-width model changes and dimension
changes, on **PGLite and PostgreSQL**. It coordinates the text-vector schema,
configuration, invalidation, guarded projection recovery, chunk/fact repair and
resumable authorization. Changing a config value alone does not convert vectors.
Do not wipe/reinitialize a brain, re-import Markdown, or run hand-written vector
column SQL as an embedding migration: those paths bypass this coordination and
can lose database-only memory or durable intent.

Select the intended brain with the global `--brain` option and retain that
selection on every command below. Migration is **brain-wide**; `--source` does
not narrow it. See the [migration reference](guides/embedding-migration.md) and
[explicit-consent playbook](../skills/migrations/v0.46.3.0.md).

## Preview, authorize, then verify

Inspect state and preview a deliberately selected target without provider work:

```bash
gbrain migrate embeddings --status --json
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run --json
```

Review actual column widths, model provenance, pending chunks and facts,
projection blockers, estimated cost (or unavailable pricing), and the reranker
action. The example target is not a recommendation to change a keyless brain.
An upgrade or health warning never authorizes paid work.

Before applying, verify a [full backup on an isolated restore](#backup-and-isolated-restore),
coordinate quiescing writers with the owner, and obtain approval for the selected
brain, target, dimensions, reranker action and a finite nonnegative **total USD
cap**. Replace `<approved-total-usd>` with the operator's choice, not an amount
invented by the agent:

```bash
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 \
  --max-cost-usd <approved-total-usd> --yes --json
gbrain migrate embeddings --status --json
```

`--yes` is operation consent, not a substitute for the cap. Batch size is not a
spending bound. Admission uses conservative per-attempt ceilings, so the preview
estimate is not a guarantee that the selected cap will finish the work. Unknown
pricing or a missing provider input ceiling can refuse before dispatch.

At the same width, the schema need not resize, but a new model is still a new
vector space: incompatible fact/take vectors and semantic cache entries cannot
be retained as though they belonged to the target. A width change uses the
guarded transition for all three dim-pinned text columns, not a PGLite wipe.
Image/multimodal embeddings remain separate.

Completion requires inspecting the actual remaining work, not just the configured
model. An incomplete or failed run may have committed projection repairs,
configuration/schema changes, vectors or authorization debits. Inspect `--status`
before resuming the same approved target; correct chunks/facts are retained.
Increasing `--max-cost-usd` authorizes a larger **total**, not a reset of prior
debits. Do not reset the marker or clear another writer's lock. `--no-embed` is
deferred work, not completion; resume through the migration command so its
authorization and verification remain in force.

After completion, separately authorize any provider calls needed to check a
known-positive retrieval and a genuine miss in the same brain. A green width
check alone does not prove retrieval. See the
[verification commands and expected hit/miss distinction](guides/embedding-migration.md#verify-a-known-result-and-a-genuine-miss)
and [failure/recovery table](guides/embedding-migration.md#recovery).

## Repair missing fact vectors deliberately

Fact vectors are separate from page/chunk embeddings. The brain-wide migration
repairs eligible active facts as part of its guarded run, including same-width
model swaps and facts-only brains. Standalone fact repair is a separate,
explicitly **source-scoped** operation:

```bash
gbrain embed --stale --facts --source source-example --dry-run --json
```

Eligible work includes a missing vector, a different or unknown stored model,
a missing/mismatched text hash, or the wrong vector width. It is **not NULL-only**.
Expired, superseded, withdrawn and audit facts, facts from archived sources, and
facts linked to deleted pages are excluded. Already-current vectors are retained;
unknown legacy provenance is not inferred from today's configuration.

The preview reports the scope and count, not a repair-price estimate. Its zero
cost means no provider spend occurred during the preview. After reviewing the
count and obtaining an operator-selected cap, authorize the bounded repair:

```bash
gbrain embed --stale --facts --source source-example \
  --yes --max-cost-usd <approved-usd> --json
```

The cap must be finite and nonnegative. `--max-facts` limits attempted facts
(default 100, range 1–10,000); `--batch-size` bounds each batch (default 100,
range 1–100); `--budget-ms` limits run time (default 60,000, range 1–3,600,000).
All three accept integers. These limits do not authorize spend. Standalone
repair is bounded per invocation; use brain-wide migration when durable total
authorization across interruptions is required.

Each provider attempt rechecks source identity, authority, selected-brain and
database off switches, model identity and spend allowance. Installation rechecks
row version and eligibility. Managed sources repair physical fact projections,
not canonical text; an owner-held PGLite brain uses private resident delegation.
Provider failures leave the affected original facts intact and report bounded
diagnostics. Inspect `remaining`, `failures` and `stopped`; do not equate a bounded
batch with a completed backfill. Repair does not run automatically on upgrade.

## Backup and isolated restore

A backup is a **point-in-time snapshot**, not a rollback of later events.
An old snapshot does not contain later edits, withdrawals, grants/revocations or
queued requests. Restoring it can make a subsequently withdrawn claim active
again in the isolated copy. Preserve the current brain and reconcile those later
changes before considering any restored copy for service. Reverting a binary is
not data restoration, and Markdown export is not a full database backup.

The examples below are operator templates, not commands run against your brain.
They are grounded in a tiny synthetic drill using the current runtime: closed
PGLite copies and supported archives, and PostgreSQL 16 `pg_dump`/`pg_restore`
with pgvector. The drill verified canonical edits, fact withdrawals, retained
queued intent, unchanged originals and PGLite occupied-target refusal. It did
**not** establish old-binary/mixed-version compatibility or safe service activation.

For either engine:

1. Obtain approval to pause all writers: MCP/service owners, persistence
   consumers, scheduled jobs, CLI writers, sync and file editors. Stop old-version
   workers too. Let active transactions finish and engines close/checkpoint;
   preserve queued work rather than draining or discarding it merely to back up.
2. Record the selected database, configuration, binary/schema versions, extensions,
   external files/object stores and the snapshot time. Keep comparison evidence
   for canonical pages, facts, `fact_withdrawals`, `persistence_requests` and
   `page_projection_jobs`. A momentary lack of sessions is not a fence against a
   scheduler reconnecting.
3. Keep archives, configuration and comparison evidence private. Full database
   snapshots may contain credentials and withdrawn/history content; they are not
   sanitized exports or evidence of physical erasure. Never publish them in a PR.
4. Restore only into a new isolated target with compatible software. Do not point
   an application, worker or harness at it, publish it, or reuse its old authority.

### PGLite: supported archive into an absent root

This format requires a file-configured local host installation with the database
at `<root>/.gbrain/brain.pglite`. `GBRAIN_HOME` selects `<root>`, **not** its
`.gbrain` child. Use an absolute recorded CLI launcher if your harness has one.
Replace the example source root after verifying its configuration; keep the
backup directory outside it. With all owners stopped:

```bash
umask 077
source_root=/absolute/path/to/brain-root
backup_dir=$(mktemp -d "$HOME/gbrain-backup.XXXXXX")
GBRAIN_HOME="$source_root" gbrain backup create --brain host \
  --output "$backup_dir/brain.gbrain-backup" --json
```

The archive contains the full database plus sanitized file configuration and
installer-managed files, not every external asset. Review its omitted-assets
inventory and separately protect excluded source files, credentials and object
storage. A custom database path is not supported by this archive format; use a
verified closed whole-directory backup plus configuration instead, and rebase
only the copied configuration before inspecting a copy with the matching binary.
Never copy individual live database files or rename the original out of service
as a migration step.

Restore the archive into an absent child of a fresh private directory. Do **not**
create `restored_root` first; occupied roots are refused:

```bash
restore_parent=$(mktemp -d "$HOME/gbrain-restore-review.XXXXXX")
restored_root="$restore_parent/brain"
GBRAIN_HOME="$source_root" gbrain backup restore "$backup_dir/brain.gbrain-backup" \
  --brain host --into "$restored_root" --mode new-brain --json
```

Read `restore-receipt.json` and `.gbrain/restore-detached.json` under the restored
root. New-brain restore revokes archived authority, disables publication and
quarantines unfinished work without starting automation. In the synthetic drill,
the queued request's intent and digest survived, but its state became `cancelled`
with `restore_new_brain`; do not expect automatic replay. Compare canonical
pages, facts and the withdrawal ledger with snapshot evidence, and account for
this deliberate queue-state transformation. Do not use `--mode recovery` merely
to avoid these safeguards or to claim an old service has been excluded.

### PostgreSQL: dump into a separate, newly created database

Use compatible PostgreSQL client tools, the required pgvector/extensions and a
separate inspection server without application access. Configure private libpq
service entries beforehand: `gbrain-source-example` selects the exact source
database; `gbrain-restore-admin-example` selects the isolated inspection server's
maintenance database with permission to create a database. These are placeholders,
not services GBrain creates. Keep credentials in protected service/password
files, not command text. Do not reuse a production service for the restore.

After quiescing the source and protecting its file configuration/external assets:

```bash
umask 077
backup_dir=$(mktemp -d "$HOME/gbrain-pg-backup.XXXXXX")
pg_dump --dbname='service=gbrain-source-example' --format=custom \
  --no-owner --no-acl --file="$backup_dir/brain.dump"

createdb --maintenance-db='service=gbrain-restore-admin-example' \
  --template=template0 gbrain_restore_example &&
pg_restore --dbname='service=gbrain-restore-admin-example dbname=gbrain_restore_example' \
  --no-owner --no-acl --exit-on-error "$backup_dir/brain.dump"
```

The `&&` is intentional: if the database already exists, `createdb` fails and
restore must not run. On any restore error, leave that partial inspection target
offline and use a different new name for the next attempt. Do not add `--clean`,
drop the current brain, or restore over an occupied database. PostgreSQL tools
alone do not provide GBrain's PGLite occupied-root protection or authority
quarantine. A raw dump retains queued work and application authority; it must
remain inspection-only. `--no-owner --no-acl` does not sanitize stored credentials.

Compare the restored canonical state, facts, withdrawal ledger and durable intent
with snapshot evidence before any reconciliation. The synthetic PostgreSQL drill
preserved full queued rows exactly and never launched a consumer on the copy.
Account separately for roles/permissions, configuration and external storage,
which this single-database dump does not restore. Have the owner reconcile every
post-snapshot withdrawal, write and authority change from preserved current
records before any separately approved cutover. If those records are unavailable,
do not assume the stale copy is safe to activate.
