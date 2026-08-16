# Embedding migration — moving a brain to another embedding provider

`gbrain migrate embeddings` re-embeds an entire brain onto a different
embedding provider/model, safely and resumably. It is the forward path off a
sunsetting provider (for example ZeroEntropy's hosted API, which shuts down
2026-09-04 and remains the configless runtime fallback for existing brains
that never picked a model — new installs default to `voyage:voyage-4`) — but
it is provider-agnostic: any configured `provider:model` works as a target.

Also reachable as `gbrain retrieval-upgrade` — the alias that `gbrain doctor`
repair hints and the README point at.

## Quick start

```bash
# Preview the work + cost. Changes nothing.
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run

# Run it (interactive confirm shows chunk count + $ estimate first).
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024

# Non-interactive (cron / scripts): --yes is required, else exit 2.
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --yes
```

`--dim <N>` overrides the target width; it defaults to the provider recipe's
declared width and is required for recipes that don't declare one (litellm,
llama-server, and other bring-your-own-model providers).

Targets on a provider with an announced shutdown are refused (a paid re-embed
onto a dying API would strand the brain). Self-hosting a wire-compatible
endpoint behind a `provider_base_urls` override? `--force-sunset-target` is
the explicit escape hatch.

## Recommended targets

- **`voyage:voyage-4 --dim 1024`** (the new-install default). One
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

Set the target's API key via `export VOYAGE_API_KEY=...` (or edit
`~/.gbrain/config.json` directly) — do NOT use `gbrain config set
voyage_api_key`: that writes the DB plane, which the embedding pipeline never
reads.

**Pick `--dim` = your brain's current column width when the target supports
it.** A different width triggers the destructive schema transition (column +
index rebuild across all three dim-pinned tables); the same width skips it
entirely. `gbrain doctor` (check `provider_sunset`, for providers with an
announced shutdown) prints target-aware paste-ready commands — the Voyage
command at its valid 1024 width, plus an OpenAI keep-width alternative with
your actual width filled in when that width is valid there — reading the real
`vector(N)` column, not the config value, which can drift.

## How affected brains find out (provider sunsets)

Three surfaces flag a brain whose embedding model, reranker, or custom
embedding columns are on a provider with an announced hosted-API shutdown,
such as ZeroEntropy (2026-09-04):

- **`gbrain doctor`** — the `provider_sunset` check warns on every run until
  the brain is off the provider. After the shutdown date it escalates to
  `fail` only when embedded vectors actually exist on the dead provider
  (retrieval is genuinely down); a zero-vector brain whose config merely
  resolves to the dead default stays `warn`, so doctor-as-CI-gate setups
  don't start exiting 1 on the date. The reranker side resolves through the
  same plane search actually reranks with (the mode bundle +
  `search.reranker.*` overrides), and ZE-backed custom `embedding_columns`
  entries are flagged too. The message carries target-aware paste-ready
  migration commands (Voyage at 1024; OpenAI keep-width when your width is
  valid there). Accepted the risk?
  `gbrain config set doctor.suppress_provider_sunset true` silences it.
- **`gbrain upgrade`** — a one-shot banner (gated by
  `ze_sunset_notice_shown`) with the same two fixes, plus a stage-2 banner
  per brain.
- **The v0.46.3 version migration** (runs via `gbrain upgrade` /
  `gbrain apply-migrations`) — detect-and-notify only: it checks the host
  brain's exposure (embedding, reranker, custom columns), prints the ACTION
  REQUIRED block, and files an agent action item pointing at
  `skills/migrations/v0.46.3.0.md` in
  `~/.gbrain/migrations/pending-host-work.jsonl`. It never changes config or
  spends money on your behalf.

All of them state the full consequence: after the shutdown, **existing
vectors become unqueryable** — query embedding uses the same endpoint as
ingestion — not just new content.

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
`search.reranker.model` (or the mode-bundle fallback) resolves to the
outgoing provider, the plan prints a warning; point it at the recommended
replacement — `gbrain config set search.reranker.model voyage:rerank-2.5`
(needs `VOYAGE_API_KEY`) — or disable it
(`gbrain config set search.reranker.enabled false`).

## Custom embedding columns

There is **no automated off-ramp for custom `embedding_columns` entries**:
`migrate embeddings` covers the primary column only. Re-declare each custom
column's config on the new provider and re-embed its content, or drop the
column config.

## Self-hosting instead of migrating

If the outgoing model's weights are available (zembed-1's are Apache-2.0),
self-hosting preserves your existing vectors — no re-embed at all — but only
when the embedding signature doesn't change: keep the SAME model id
(`zeroentropyai:zembed-1`) and point its base URL at your endpoint with
`gbrain config set provider_base_urls.zeroentropyai <url>`. The endpoint
must speak ZeroEntropy's wire dialect (`/models/embed`,
`{results: [...]}` responses) — the model id routes through a ZE-specific
compat fetch, so a generic OpenAI-compatible `llama-server` or Ollama
endpoint will NOT work without a compat proxy in front. Switching the
provider id instead (e.g. `llama-server:zembed-1`) changes
`pages.embedding_signature`, and the next stale-embed pass re-embeds
everything — a full re-embed, not a zero-cost move. This path survives only
until the September removal release deletes the `zeroentropyai` recipe. The
migration command is for when you'd rather move to a hosted provider.
