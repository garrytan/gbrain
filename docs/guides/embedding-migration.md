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
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024

# Only after explicit approval: --yes is required non-interactively, else exit 2.
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --yes
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
2. **Consent gate.** Prints the plan; requires an interactive `y` or `--yes`.
   Non-TTY without `--yes` refuses with exit 2 (mirrors the `reindex-code`
   gate in [spend-controls](../operations/spend-controls.md)). Unlike the pure
   cost gates there, `spend.posture=tokenmax` does **not** bypass this one:
   posture waives the spend *ceiling*, and this gate also guards a
   destructive schema rebuild. Under `tokenmax` the dollar figure is marked
   informational and the confirmation is still asked. `--yes` is the single
   scripted bypass.
3. **Live probe.** One tiny embed against the TARGET provider before any
   mutation — validates the API key, model id, and dimension support in a
   single call. A bad key fails here, with nothing changed.
4. **Env-override gate.** When `GBRAIN_EMBEDDING_MODEL` /
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

## What the rebuild deletes

The dimension change **deletes the stored vectors in the dim-pinned text columns** —
they are in the old model's space and unusable. They are not recoverable:
going back to the previous provider means paying for a second full re-embed.
`content_chunks` vectors are rebuilt by the re-embed pass. Semantic result
caching remains disabled. Fact-vector repair is separate and explicitly
consented; see [fact-vector repair](../embedding-migrations.md). Image and
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

`--no-embed` applies schema + config + invalidation and stops, so you can run
the (potentially long) re-embed later or in the background:

```bash
gbrain migrate embeddings --to openai:text-embedding-3-small --yes --no-embed
gbrain embed --stale --catch-up --include-null-signature --background
```

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
