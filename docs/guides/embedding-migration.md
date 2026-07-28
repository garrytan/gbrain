# Embedding migration — moving a brain to another embedding provider

`gbrain migrate embeddings` re-embeds an entire brain onto a different
embedding provider/model, safely and resumably. It is the forward path off a
sunsetting provider (for example ZeroEntropy's hosted API, which shuts down
2026-09-04 and is the shipped default for brains that never picked a model) —
but it is provider-agnostic: any configured `provider:model` works as a
target.

Also reachable as `gbrain retrieval-upgrade` (the name `doctor` and the
README reference).

## Quick start

```bash
# Preview the work + cost. Changes nothing.
gbrain migrate embeddings --to openai:text-embedding-3-small --dry-run

# Run it (interactive confirm shows chunk count + $ estimate first).
gbrain migrate embeddings --to openai:text-embedding-3-small

# Non-interactive (cron / scripts): --yes is required, else exit 2.
gbrain migrate embeddings --to voyage:voyage-3-large --yes
```

`--dim <N>` overrides the target width; it defaults to the provider recipe's
declared width and is required for recipes that don't declare one (litellm,
llama-server, and other bring-your-own-model providers).

## What it does, in order

1. **Plan.** Counts every chunk not already in the target embedding space —
   including chunks on pages with **no recorded embedding signature**
   (pages embedded before the v108 provenance stamp). Prices the re-embed
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
4. **Env-override gate.** Refuses when `GBRAIN_EMBEDDING_MODEL` /
   `GBRAIN_EMBEDDING_DIMENSIONS` would silently defeat the switch at
   runtime (the same guard `ze-switch` uses). `--ignore-env-override` for
   people running deliberate experiments.
5. **Apply.** When the target width differs from the actual column width,
   runs the same atomic schema transition `ze-switch` uses, in one
   transaction. It rebuilds **all three dim-pinned text-embedding-space
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

The dimension change **deletes every stored embedding vector** in the brain —
they are in the old model's space and unusable. They are not recoverable:
going back to the previous provider means paying for a second full re-embed.
`content_chunks` vectors are rebuilt by the re-embed pass, the query cache
refills on the next query, and fact embeddings are rewritten on their next
write (or a `gbrain extract` pass).

## Resume after a kill

The NULL-embedding column is the checkpoint. If the run is killed (or some
pages fail to embed), re-run the **same command**: chunks already embedded on
the target are never re-embedded, the schema/config steps no-op, and the run
continues where it stopped. An in-flight marker (`embedding_migration.state`
in DB config) records the target; it is cleared only when the backlog drains
to zero.

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

## Pages without an embedding signature (#3391)

Pages embedded before provenance stamping have `embedding_signature IS NULL`
and are grandfathered by the routine stale sweep (so an upgrade never
surprise-re-embeds a whole corpus). After a provider swap that grandfather
clause would silently leave those pages in the OLD embedding space — mixed
vector spaces in one index, degrading retrieval with nothing in the logs.

- `gbrain migrate embeddings` always includes them.
- Plain `gbrain embed --stale` warns when a model swap leaves NULL-signature
  pages behind, and `gbrain embed --stale --include-null-signature` re-embeds
  them.

## Reranker

Migrating embeddings does not touch the reranker. If
`search.reranker.model` points at the outgoing provider, the plan prints a
warning; disable it (`gbrain config set search.reranker.enabled false`) or
point it at another provider.

## Self-hosting instead of migrating

If the outgoing model's weights are available (zembed-1's are Apache-2.0),
serving them locally via `llama-server` / `ollama` / a LiteLLM proxy
preserves your existing vectors — no re-embed at all. Point
`embedding_model` at the local recipe and keep the same dimensions. The
migration command is for when you'd rather move to a hosted provider.
