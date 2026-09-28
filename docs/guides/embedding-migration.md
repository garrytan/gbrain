# Embedding migration — moving a brain to another embedding provider

`gbrain migrate embeddings` re-embeds an entire brain onto a supported
embedding provider/model, safely and resumably. It requires an explicit target
and approval; upgrading or changing a default does not convert stored vectors.
Inspect the intended brain with `--status`, keep a verified full backup, and
coordinate quiescing embedding writers before approving a live run.

`gbrain retrieval-upgrade` is an alias for the same provider-agnostic migration
command. It uses the same flags, preview, consent and verification workflow.

## Quick start

```bash
# Preview the work + cost. Changes nothing.
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run

# After reviewing the plan, run with interactive confirmation.
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --max-cost-usd 1

# Only after explicit approval: --yes is required non-interactively, else exit 2.
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --max-cost-usd 1 --yes
```

`--dim <N>` overrides the target width; it defaults to the provider recipe's
declared width and is required for recipes that don't declare one (litellm,
llama-server, and other bring-your-own-model providers).

## Recommended targets

- **`voyage:voyage-4 --dim 1024`** (the default for new installs). One
  `VOYAGE_API_KEY` covers embedding, the `rerank-2.5` reranker, and the
  multimodal model; the voyage-4 family shares one embedding space, so you
  can later point the query model at `voyage-4-large` or `voyage-4-lite`
  without reindexing. Note: **1280 is not a valid Voyage width** (valid:
  256/512/1024/2048), so a legacy 1280d brain gets a one-time schema/HNSW
  index rebuild to 1024 — the command handles it, and it is resumable if
  killed.
- **`openai:text-embedding-3-small --dim 1280`** — the keep-your-width
  alternative: OpenAI's text-embedding-3 models support flexible dims, so a
  1280d brain keeps its column (no schema rebuild). No reranker coverage on
  the OpenAI key.

Set the target's API key via `export VOYAGE_API_KEY=...`, via
`gbrain config set voyage_api_key ...` (API keys are routed to the file
plane, which the provider pipeline reads), or by editing
`~/.gbrain/config.json` directly.

**Pick `--dim` = your brain's current column width when the target supports
it.** A different width triggers the destructive schema transition (column +
index rebuild across all three dim-pinned tables); the same width skips it
entirely, but still requires re-embedding into the target model's space.

Keeping the width does not make different models' vectors compatible. A model
change still invalidates old fact and take vectors and clears the semantic
query cache before publishing the new identity. The underlying memory text
remains. Invalidation and its checkpoint commit with the database identity,
so a same-target retry does not erase companion vectors already regenerated
for the new model. Use `--status` to inspect remaining fact embeddings.
Inspect the real column widths with `--status`; a configured dimension can
drift from the database. An unsupported provider is not a migration target,
even if a custom base URL still serves its old model.

## What it does, in order

1. **Plan.** Counts every chunk not already in the target embedding space —
   including chunks on pages with **no recorded embedding signature**
   (pages whose chunks were embedded without a provenance stamp). Prices the re-embed
   from the pricing table; unknown providers print "estimate unavailable"
   instead of a fabricated number.
2. **Consent gate.** Prints the plan; requires an interactive `y` or `--yes`,
   plus a finite `--max-cost-usd` total authorization for a new migration.
   Non-TTY without `--yes` refuses with exit 2 (mirrors the `reindex-code`
   gate in [spend-controls](../operations/spend-controls.md)). Unlike the pure
   cost gates there, `spend.posture=tokenmax` does **not** bypass this one:
   this gate guards both destructive work and bounded provider attempts.
   `--yes` confirms the operation; it does not waive the cap. Retries retain
   pre-dispatch debits, including requests with uncertain outcomes. Raising
   the total cap explicitly authorizes more work. Unknown pricing or a
   missing conservative provider input ceiling refuses before dispatch.
3. **Live probe.** After checking environment and embedding-enabled policy,
   one tiny embed against the TARGET provider before any
   vector invalidation — validates the API key, model id, and dimension
   support in a single call. A bad key preserves vectors; its authorization
   debit and resumable marker remain. Pending projections are then rebuilt
   through the canonical queue/snapshot/install path in batches of at most
   100 pages. Unsupported or still-pending projections refuse migration-wide
   invalidation and retain their recovery work.
   Pending projections in archived sources also block a brain-wide schema
   rebuild; restore the source deliberately before attempting its repair.
4. **Env-override policy (checked before the probe).** When `GBRAIN_EMBEDDING_MODEL` /
   `GBRAIN_EMBEDDING_DIMENSIONS` are set and DISAGREE with the target, the
   live run refuses (config-says-new / runtime-embeds-old silently splits a brain
   across two embedding spaces); `--ignore-env-override` for deliberate experiments. When they
   AGREE with the target the run proceeds with a loud notice (env-first
   deployments are legitimate; keep the env in sync everywhere gbrain runs).
   Nothing load-bearing trusts the env either way: the "nothing to migrate"
   decision verifies the DATABASE (column widths, NULL censuses, signature
   census, the un-merged file plane), so a pre-set env var cannot fake a
   completed migration.
5. **Apply.** When the target width differs from the actual column width,
   runs the atomic schema transition owned by `embedding-migration.ts`,
   in one transaction. It rebuilds **all three dim-pinned text-embedding-space
   columns** — `content_chunks.embedding`, `query_cache.embedding`, and
   `facts.embedding` — at the new width, preserving each column's type
   (`vector` vs `halfvec`) and recreating its HNSW index. Missing any of the
   three leaves it silently broken: a narrow `query_cache.embedding` makes
   every cache write and read fail *by design* (the cache swallows errors so
   it can never break search) for a permanent 0% hit rate, and a narrow
   `facts.embedding` fails every per-fact embed write. The image/multimodal
   columns ARE deliberately untouched — they use separate models whose
   dimensions are independent of the text embedding model.
   Writes `embedding_model` + `embedding_dimensions` to BOTH config planes
   (file plane for the runtime gateway, DB plane for doctor), invalidates
   every chunk still in the old space — **including NULL-signature pages** —
   and purges the semantic query cache so stale cached results can't be
   served across the swap.
6. **Re-embed.** The standard embed pipeline (`embed --stale --catch-up`)
   with per-source single-flight locks, rate-limit backoff, stderr progress,
   and optional DB-contention pacing (`--pace[=mode]`).
   Active facts are repaired through the same guarded document-embedding
   path as `embed --facts --stale`, including same-width model swaps and
   facts-only brains. Expired, withdrawn, superseded and audit rows are not
   work. Unknown legacy fact provenance is never inferred from new config.

## Recovery

Legacy saved facts have no recorded embedding model until they are repaired.
Exact-text duplicate detection still works, but semantic duplicate detection
and consolidation do not compare these unverified vectors. Preview the scoped
work with `gbrain embed --facts --stale --source 'source-example' --dry-run --json`;
repair requires explicit `--yes --max-cost-usd <amount>` authorization. No paid
re-embedding is started automatically on upgrade. Existing page vectors with a
matching model and a legacy NULL text hash remain searchable, including after a
failed migration attempt; this does not relabel vectors from another model.

Stop older GBrain mutation workers before repair; this release does not prove
mixed-version mutation compatibility. Preserve their durable queued work.
Select the intended brain using the ordinary global `--brain` option. This
migration is brain-wide: both `gbrain migrate embeddings` and `gbrain retrieval-upgrade`
reject `--source` and `--slugs`, including `--flag=value`
forms, before planning or opening the brain. Neither flag narrows schema work.

Both routes accept only their documented migration controls and the global
`--brain`, `--quiet`, `--progress-json`, and `--progress-interval` controls.
Flags from embed/import, such as `--facts`, `--limit`, or `--background`, are
unsupported; so is `--timeout` (migration has no CLI deadline implementation).
Validation checks the original arguments even when global parsing consumes a
flag. Unsupported controls, duplicate flags, missing values, and invalid numbers
refuse before opening the brain rather than silently widening work.

Use separate values for `--to`, `--dim`, `--batch-size`, `--max-cost-usd`, and
`--reranker`; their `--flag=value` forms are unsupported. Dimensions must be an
integer from 1 through 100000, batch size an integer from 1 through 10000, and the
cost cap finite and nonnegative. Values are never truncated or clamped. Pacing
accepts bare `--pace` (balanced), `--pace=off|gentle|balanced|aggressive`, and
`--pace-max-concurrency N` or `--pace-max-concurrency=N` with a positive safe
integer. Empty or unknown pace modes refuse rather than falling back to off.
Pacing's existing configuration/environment precedence is unchanged.

Unsuccessful CLI JSON and local `migrate_embeddings` operation envelopes retain
their existing status and reason fields and add a `recovery` object with the status
command, this guide, and partial-state and authorization cautions. Human stderr
prints the same guidance after the case-specific advice. The operation remains
local-only and admin-scoped; its `failed` discriminator is unchanged. Reuse the same
brain selection when inspecting status; do not blindly retry or reset the migration marker.

| Failure | Action before retrying | Partial state to inspect |
| --- | --- | --- |
| `locked` | Check the existing holder; let it finish or deliberately stop it, then inspect status. | A previous holder may have committed progress or debits. |
| `refused` | Resolve the named environment mismatch or deliberately choose whether to resume or retarget. | An earlier migration and its authorization may still be live. |
| `probe_failed` (operation: `failed`) | Check provider configuration and the reported dimensions before authorizing another attempt. | An authorized probe debit may remain even when invalidation did not run. |
| `apply_failed` (operation: `failed`) | Inspect the specific blocker first. Restore an archived source with `gbrain sources restore <id>` only after owner approval; unsealed unsupported projections need their original importer. Resolve configuration, database, or ownership errors before retrying. | Canonical repairs, schema/config changes, vectors, and debits may have committed in earlier phases. |
| `retained_vectors_blocked` within `apply_failed` (operation: `failed`) | Inspect both the retained page-chunk/fact/take counts and the archived-page blocked-work count. Migration can lack an eligible rebuild path even when vectors are already missing. Preserve the data and obtain the owner's retention/recovery decision before retrying. | Refusal does not undo earlier committed progress or authorization debits. |
| `retained_vector_check_failed` within `apply_failed` (operation: `failed`) | Rebuildability could not be established. Inspect the same selected brain's status and database/schema/embedding-registry access; restore reliable inspection before retrying. Do not interpret an unavailable census as zero blockers. | This phase is refused; the failed check does not establish that previous phases made no changes or spent nothing. |
| `incomplete` | Inspect remaining work, provider health, and ownership; resume only after resolving the blocker. | Completed chunks/facts and prior debits remain; incomplete is not a rollback. |

Keeping the current model, or leaving an in-flight migration paused, is valid until
the owner chooses an eligible recovery path. Preserve deletion and `embed_skip`
intent: do not automatically restore pages or remove skip policy to bypass a
refusal. A width change may refuse because of retained deleted/skip vectors even
when a same-width migration can leave those vectors untouched and complete.
Archived blocked work can include NULL vectors, contentful chunkless pages,
unsealed projections, or signature/legacy text-hash drift. At preflight, known
archived blockers refuse migration before new authorization or provider calls.
Standalone brain-wide `embed --stale` can repair active work while explicitly
reporting archived blockers as incomplete; it does not dispatch archived text.
Restoring an archived source still requires the owner's deliberate approval.
Unsealed unsupported media needs its original importer; a sealed imported image
with usable stored chunks can migrate through the existing embedder. These are
phase-local checks, not a purge path or permission for raw SQL, a forced marker
reset, or a new override. `--status` and `--dry-run` describe runnable work and
estimates; they do not prove that the live retained-vector check will pass.

Use `gbrain migrate embeddings --status --json` on the selected brain. Increasing
`--max-cost-usd` is renewed authorization for a larger **total** cap, not a reset
of prior debits. The CLI does not infer that a failure means zero writes.

1. Inspect without mutations or provider calls:
   `gbrain migrate embeddings --status --json`, then a target-specific
   `--dry-run`. Inspect chunks, facts, projection blockers, target dimensions,
   reranker action and whether pricing is known.
2. Verify a full database backup on an isolated restore. For PGLite, stop all
   processes using the brain, wait for a clean close/checkpoint, and copy the
   entire database directory plus configuration. Open a **copy** with the
   matching binary. For PostgreSQL, use the PostgreSQL backup tools against
   the selected database and restore into a separate database with compatible
   pgvector/extensions. Compare canonical pages, facts, withdrawal ledger and
   queued intent. Markdown export is not a database backup. Follow the
   [engine-specific backup and isolated-restore examples](../embedding-migrations.md#backup-and-isolated-restore).
3. Authorize a bounded migration, for example:
   `gbrain migrate embeddings --to openai:text-embedding-3-small --dim 1536 --reranker off --max-cost-usd 1 --yes --json`.
   The dollar amount is an operator-chosen total limit, not a price quote.
   A batch size is not a spending cap. The preview character-based cost is
   an estimate; admission reserves conservative per-attempt token ceilings.
4. An incomplete or failed apply exits nonzero. Read `--status` before
   repeating the same command. Already-correct chunks/facts are not sent
   again. A crash, timeout or provider refusal does not refund a debit.
   If the cap is exhausted, fix the underlying provider problem and explicitly
   raise the **total** authorization to continue. Do not reset the marker.
   Projection recovery may have made durable progress even when migration
   invalidation was refused. Unsealed unsupported media needs its original
   importer; never stamp projection revisions with SQL.
5. Verify `facts_pending`, remaining chunks and the completion receipt with
   `--status --json`, then perform a known-positive retrieval in the same
   brain and a genuine miss. `--no-embed` is deliberately deferred, not
   complete. A cursor reaching EOF does not mean blocked work completed.

For a synthetic brain containing one pending page and one active fact, the
tested PostgreSQL and PGLite runs returned this subset of the JSON result:

```json
{"status":"completed","remaining":0,"facts_embedded":1,"facts_remaining":0,"blocked_projection_pages":0}
```

Repeating the same completed migration, including `--reranker off`, returned
`{"status":"skipped_no_work"}` without new provider work. These are synthetic
recovery checks, not a prediction of a personal brain's counts or provider cost.

For a brain already missing page vectors, `gbrain embed --stale
--include-null-signature` uses the same bounded canonical projection recovery.
For source-scoped facts, preview `gbrain embed --facts --stale --source
'source-example' --dry-run --json`; explicit repair requires `--yes
--max-cost-usd 1` and supports `--max-facts` bounded work. Use the brain-wide
migration command when durable authorization across interruptions is required.

Prefer forward recovery. A binary rollback does not restore vectors or undo
the schema. Restoring an older backup over a brain with intervening writes or
committed withdrawals can resurrect forgotten content and is unsafe; do not
do that without a separately reviewed reconciliation of all later intent.

### Verify a known result and a genuine miss

After status reports completion, keep the same brain and source selection and
check content you already know exists. Authorize any provider calls separately;
a search on an embedded brain can contact its configured provider. In the
network-isolated keyless fixture used for this release, these exact commands ran
against an existing synthetic page:

```bash
gbrain --brain host search amberbadgerfixtureproof --source default --json
gbrain --brain host search zzzgenuinemissfixtureproof --source default --json
```

The first returned `concepts/keyless-fixture-example` with `keyword_hit: true`;
the second returned `[]`, and both exited zero. These tokens belong only to that
fixture. For your brain, substitute an existing non-sensitive phrase and a
deliberately absent phrase, and check the expected source/slug rather than merely
counting results. A clean miss must remain a miss. Those recorded keyless results
prove content persistence and keyword retrieval, **not vector repair**: that
fixture explicitly reported keyword-only degradation. On an approved embedded
brain, also inspect migration completion and retrieval degradation; a keyword
hit alone does not establish semantic recovery. Do not paste private content
into diagnostic reports.

## What the rebuild deletes

The dimension change **deletes the stored vectors in the dim-pinned text columns** —
they are in the old model's space and unusable. They are not recoverable:
going back to the previous provider means paying for a second full re-embed.
`content_chunks` vectors are rebuilt by the re-embed pass. Semantic result
caching remains disabled. Eligible fact vectors are repaired in the same
consented migration; a separate source-scoped repair is also available in
[fact-vector repair](../embedding-migrations.md#repair-missing-fact-vectors-deliberately). Image and
multimodal columns are not part of this text-space rebuild.

## Resume after a kill

The NULL-embedding column is the checkpoint. If the run is killed (or some
pages fail to embed), re-run the **same command**: chunks already embedded on
the target are never re-embedded, the schema/config steps no-op, and the run
continues where it stopped. An in-flight marker (`embedding_migration.state`
in DB config) records the target; it is cleared only when the backlog drains
to zero. Re-running with a DIFFERENT `--to` target while a migration is in
flight refuses and names both options: the exact resume command for the
original target, or the same command with `--retarget` to abandon it
deliberately (the marker records the superseded target in its history).

One caveat after a HARD kill (SIGKILL, crash, power loss — not Ctrl-C): the
run's per-source single-flight embed lock is left behind, and an immediate
re-run skips the re-embed and reports the migration as paused. The command
says so explicitly (`lock_skipped` in `--json`); the lock expires on its own
after at most 60 minutes, then the same re-run resumes normally.

A page whose chunks straddle two stale batches is embedded correctly but not
stamped by the embed loop (which only stamps all-or-nothing per batch), so the
migration runs one reconcile pass after the drain that stamps every
fully-embedded page. Without it a large brain would report "incomplete" and the
re-run would pay again for those pages. `--batch-size N` tunes the batch
(default 2000).

`--no-embed` applies schema + config + invalidation and stops with deliberately
deferred work. Inspect status, then resume the migration without `--no-embed` so
the existing total authorization and completion checks still cover the repair:

```bash
gbrain migrate embeddings --to openai:text-embedding-3-small --yes --no-embed --max-cost-usd 1
gbrain migrate embeddings --status --json
gbrain migrate embeddings --to openai:text-embedding-3-small --yes --max-cost-usd 1
```

The example cap must be approved by the operator. The resumed command retains
earlier debits; it does not authorize another dollar. A standalone/background
embedding invocation does not inherit this migration's durable allowance.

## During the migration

While the re-embed runs, semantic search returns degraded (lexical-arm-only)
results for not-yet-re-embedded content. Pick a quiet window for large
brains, or use `--pace` to keep the DB responsive.

## Pages without an embedding signature

Pages whose chunks were embedded without a provenance stamp have `embedding_signature IS NULL`
and are grandfathered by the routine stale sweep (so an upgrade never
surprise-re-embeds a whole corpus). After a provider swap that grandfather
clause would silently leave those pages in the OLD embedding space — mixed
vector spaces in one index, degrading retrieval with nothing in the logs.

- `gbrain migrate embeddings` always includes them.
- Plain `gbrain embed --stale` warns when a model swap leaves NULL-signature
  pages behind, and `gbrain embed --stale --include-null-signature` re-embeds
  them.

## Reranker

The migration handles the reranker in the same run (`--reranker auto` is the
default): when the ACTIVE reranker — resolved through the mode bundles, so
the common no-explicit-config case counts — is unsupported or is on the
outgoing provider, and the target provider ships a reranker, the run probes it
live and switches `search.reranker.model` under the same consent gate (config
write + query-cache purge in one transaction). Overrides: `--reranker off`
disables reranking, `--reranker keep` leaves it, `--reranker
<provider:model>` picks explicitly (validated before anything runs). When the
target provider has no reranker (OpenAI), the run prints an ACTION line with
the exact commands instead of silently enabling a third provider:
`gbrain config set search.reranker.model voyage:rerank-2.5` (needs
`VOYAGE_API_KEY`) or `gbrain config set search.reranker.enabled false`. A
failed reranker probe keeps the previous config and is reported as
`switch_failed` — never silent, never fatal to the migration.

## Status (read-only, spend-free)

`gbrain migrate embeddings --status [--json]` reports every config plane (env
presence, file, DB — API keys as presence booleans only), actual column
widths (including `facts` / `query_cache`), NULL and chunkless censuses, the
page-signature census, the in-flight marker with the exact resume command,
and the last completion record including its smoke-check outcome. It is the
mid-incident "where am I?" surface; `gbrain doctor`'s
`embedding_migration_state` check surfaces the same marker on every doctor
run.

## Custom embedding columns

There is **no automated off-ramp for custom `embedding_columns` entries**:
`migrate embeddings` covers the primary column only. Changing a custom
column's model label does not convert its vectors. Plan a separate replacement
and re-embed, or remove it, only with the owner's explicit approval.

## Local targets and unsupported provider IDs

Fresh installs use `voyage:voyage-4` at 1024 dimensions. An existing brain
without an explicit embedding model does not inherit that default: semantic
embedding is unavailable, while keyword search, page reads and migration
status remain usable. Schema initialization preserves a recorded model and
column width; if the stored model is missing, it refuses rather than guessing.
Re-running `init` cannot assign a different model to populated vectors, even
when the widths match. Inspect `--status`, keep a verified backup and preview
an explicit migration instead of editing labels to make the warning disappear.

Local providers such as Ollama, llama-server and LM Studio can be explicit
migration targets. Select the model actually served and its output width;
changing a provider ID changes the embedding signature and is not proof that
old vectors are compatible. Do not rewrite stored signatures to bypass the
re-embed. Removed provider IDs and their former base-URL compatibility paths
are no longer supported; use a supported recipe and an approved migration.
