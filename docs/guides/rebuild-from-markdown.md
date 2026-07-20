# Rebuild from markdown into a disposable target

This runbook describes recovery verification. It does not authorize deletion,
cutover, production reconfiguration, or a write to the damaged database.
GBrain has no destructive `gbrain rebuild` command at this head.

## Authority and isolation

Markdown in the clean, symmetric brain source repository is the source of
truth for pages and the FS-canonical categories named in
[`system-of-record.md`](../architecture/system-of-record.md). The recovery
target is a derived, disposable Postgres/pgvector database.

Every drill must have:

- a per-run `GBRAIN_HOME`, config root, runtime root, and artifact root;
- a dedicated disposable database and credential that cannot access the
  production target;
- an explicit brain ID and source ID;
- the exact source Git head and clean/upstream-symmetric readback;
- a pinned GBrain commit, schema version, active pack identity, embedding
  model/dimensions, chunker version, and embedding signature;
- an immutable external phase journal and strict before/after snapshots.

Do not inherit the Windows-user production config, repoint Town/MCP/CLI
production readers, alter scheduled tasks, or use PGLite or production as a
fallback target. Keep credentials out of receipts and command transcripts.

## Strict snapshot boundary

Capture the production comparison artifact through the explicitly routed,
read-only command:

```text
gbrain recovery snapshot --brain <production-brain-id> --source <source-id> --json
```

The command opens the selected brain directly and runs one read-only,
repeatable-read transaction. It refuses schema drift, a missing source, a pack
resolution failure, or any incomplete required section. It emits no partial
success envelope.

The artifact contains no page body, fact text, take text, database URL,
credential, or raw local path. It binds:

- brain/engine and a credential-free target fingerprint;
- GBrain version and exact schema version;
- active pack identity, manifest hash, and alias-closure hash;
- selected source identity and source revision anchors;
- active/total/soft-delete counts;
- per-page source path-or-slug anchor, content hash, normalized digest, and
  chunk/retrieval identity;
- FS-canonical facts, takes, links, timeline, tags, and synthesis-evidence
  counts/digests;
- chunker, embedding model, dimensions, modality, and embedding signature;
- runtime DB-only category counts, explicitly marked as non-parity state.

`gbrain status` remains a tolerant operational dashboard. It is not a recovery
contract and must not substitute for this snapshot.

## Phased rebuild journal

Run these phases in order. Persist an immutable `started`, `completed`, or
`vetoed` journal entry for each phase. A crash resumes the last incomplete
phase; it does not start a second target or layer an outer retry loop over
GBrain's own bounded retries.

1. **Init.** Create the isolated GBrain home and dedicated disposable
   pgvector-capable target. Record the target fingerprint and prove it differs
   from production. Do not initialize against production.
2. **Register source.** Verify the markdown repository is clean and
   `HEAD == upstream`, then register that exact local source path with
   `gbrain sources add <source-id> --path <path>` inside the isolated home.
3. **Sync pages.** Run the source-scoped sync against the disposable target.
   Record every active and soft-deleted source page disposition. A DB-only page
   or missing source path is a veto unless an immutable source-truth ruling
   covers that exact identity.
4. **Reconcile links and timeline.** Run the author-owned extract/reconcile
   seams for links and timeline. Bind each result to its source page and
   revision; counts alone are insufficient.
5. **Reconcile facts and takes.** Rebuild facts and takes from their markdown
   fences through the author-owned extraction/reconciliation seams. If
   production has nonzero facts/takes but the source has no corresponding
   fences, stop: that is an authority/recoverability veto, not an acceptable
   derived-state deviation.
6. **Converge embeddings/backfills.** Drain the source-scoped embed/backfill
   work to a stable no-op. Prove model, dimensions, chunker, and embedding
   signature identity. Deferred, stale, or missing embeddings keep retrieval
   recovery open.
7. **Strict target snapshot.** Capture the target with the same explicit
   `recovery snapshot` command and contract version used for production.
8. **Disposable reader checks.** Point only isolated CLI and MCP readers at the
   disposable target. Verify exact citations/readback and refusal when that
   target is unavailable even if PGLite is present. Do not switch production
   readers during a drill.
9. **Finalize.** Compare snapshots, journal all vetoes/deviations, and freeze
   the credential-free evidence packet. Target deletion is a separately
   authorized lifecycle action after evidence readback; the drill never
   silently destroys an unproven target.

## Parity and veto rules

Parity is exact for source-backed active pages and normalized page/source
anchors. Facts, takes, links, and timeline are source-bound and must reconcile
exactly. Embedding counts without identical model/dimensions/chunker/signature
do not pass. Jobs, audit rows, raw infrastructure, and other named DB-only
runtime categories are reported separately and are not required to match.

Any of these conditions vetoes recovery readiness:

- production or target schema/pack/source identity is missing or contradictory;
- the source repo is dirty, divergent, or unavailable;
- a DB-only knowledge page lacks an immutable source-truth disposition;
- a fact/take/link/timeline row cannot be reconstructed from its source;
- an embedding is deferred, stale, or identity-incompatible;
- the strict snapshot is partial, corrupt, or has a different contract;
- a reader reaches production, falls back to PGLite, or mutates either target;
- a mutation outcome is ambiguous or an outer wrapper adds blind retries.

`gbrain migrate`, `gbrain export --restore-only`, raw SQL, and a nonexistent
`gbrain rebuild` are prohibited recovery inputs. `migrate` copies database
state and rewrites local configuration; `export --restore-only` restores files
from database state. Neither proves recovery from source markdown.

The provisional planning targets of 60 minutes for rebuild and 5 minutes for
reader reconnect become SLOs only after they are measured on the current
corpus. Zero unexplained parity deviation is always required.
