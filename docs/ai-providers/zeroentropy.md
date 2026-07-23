# ZeroEntropy — zembed-1 + zerank-2

[ZeroEntropy](https://zeroentropy.dev) ships two specialized small models
for retrieval pipelines:

- **`zembed-1`** — multilingual embedding distilled from zerank-2.
  Flexible Matryoshka dims (2560/1280/640/320/160/80/40), 32K context,
  asymmetric `input_type: query|document` encoding. $0.025/1M tokens
  (sale) / $0.05 regular.
- **`zerank-2`** — SOTA multilingual cross-encoder reranker.
  $0.025/1M tokens (~50% cheaper than Cohere/Voyage rerankers).
  Plus `zerank-1` and `zerank-1-small` for legacy / open-source needs.

Both land in gbrain v0.35.0.0 behind the openai-compatible recipe path,
alongside OpenAI and Voyage.

## Setup

1. Get an API key at
   [dashboard.zeroentropy.dev](https://dashboard.zeroentropy.dev).
2. Export it:
   ```bash
   export ZEROENTROPY_API_KEY=<your-key>
   ```

## Use zembed-1 for embeddings

`embedding_model` and `embedding_dimensions` size the database schema. Choose
them during initialization:

```bash
gbrain init --pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 2560
```

Valid dims: `2560` (default), `1280`, `640`, `320`, `160`, `80`, `40`.
With Matryoshka embeddings, smaller dimensions trade retrieval quality for
storage.
Pick the largest that fits your column width.

### Change an existing brain

For a single-source PGLite brain using the default `gbrain-base-v2` schema
pack, first confirm the active pack:

```bash
gbrain config get schema_pack
```

Continue only when that prints `gbrain-base-v2`, then use the schema-aware
reinitialization command:

```bash
gbrain reinit-pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 2560
```

The previous database is preserved at `<path>.bak`, and the default brain repo
is synced again. The current command defaults the replacement brain to
`gbrain-base-v2`; it does not preserve a custom or older active schema pack.
It also does not restore non-default source registrations. Stop and use a
pack-preserving/manual migration for a non-default pack. Before migrating a
multi-source brain, export or record `gbrain sources list --json`, preserve the
`.bak`, and plan to re-register and resync every source explicitly; do not use
the single-source command as a drop-in multi-source migration. For Postgres,
follow
[`../embedding-migrations.md`](../embedding-migrations.md).

Do not edit only `embedding_model` or `embedding_dimensions`. A config-only
change cannot resize the vector column and is refused by `gbrain config set`.

### Verify

```bash
gbrain models doctor --json | jq '.probes[] | select(.touchpoint=="embedding_config")'
```

Expected: `status: "ok"`. If the configured size and database column disagree,
repair PGLite with `gbrain reinit-pglite` or use the Postgres embedding
migration guide.

## Reranker switch — zerank-2

The reranker is the bigger story: gbrain had no cross-encoder reranker
stage before v0.35.0.0. It slots between RRF dedup and token-budget
enforcement in hybrid search.

### Default-on with `balanced` and `tokenmax`

`balanced` and `tokenmax` default `search.reranker.enabled = true` with
`zerank-2`. With `ZEROENTROPY_API_KEY` set, reranking runs automatically.
Without the key, reranking fails open, records the failure, and returns the
pre-rerank order.

### Opt in on `conservative`

```bash
gbrain config set search.reranker.enabled true
```

The override sits above the mode-bundle default; opt-out is one flip.

### Cost anchor

Cost scales with the number and length of candidates sent to the reranker.
Check current provider pricing and `gbrain search modes` instead of relying on
a fixed monthly estimate.

### Verify

```bash
gbrain models doctor --json | jq '.probes[] | select(.touchpoint=="reranker_config")'
```

Two probes run for reranker:
- `reranker_config` (zero-network) — validates the model resolves
  through the recipe registry and is in the touchpoint's allowlist.
- A reachability probe sends a minimal `{query: "probe", documents:
  ["probe"]}` rerank to verify auth + URL.

## Knobs reference

| Config key | Default | Notes |
|---|---|---|
| `search.reranker.enabled` | `true` for balanced and tokenmax; `false` for conservative | One-flip opt-in/out |
| `search.reranker.model` | `zeroentropyai:zerank-2` | Try `zerank-1` (older SOTA) or `zerank-1-small` (Apache-2.0 open) |
| `search.reranker.top_n_in` | `25` in balanced; `50` in tokenmax | Candidates sent to reranker |
| `search.reranker.top_n_out` | `null` (no truncate) | Truncate reranked output to this many; `null` preserves full length |
| `search.reranker.timeout_ms` | `5000` | HTTP timeout; long stalls degrade UX worse than RRF fallback |

## Failure observability

Reranker is fail-open by construction: every error class (auth, rate-limit,
network, timeout, payload-too-large, unknown) returns the original RRF
order unchanged. Failures log to
`~/.gbrain/audit/rerank-failures-YYYY-Www.jsonl` (ISO-week rotation).

`gbrain doctor` reads the audit and surfaces:
- **auth failures** — any single one warns (config-time problem doctor's
  own probe should have caught)
- **payload-too-large** — any single one warns (workload-mismatch signal)
- **transient (network/timeout/rate_limit)** — warns at >=5 in 7 days

Query text is SHA-256 hashed in the audit; never logged raw.

## Asymmetric input_type

ZE zembed-1 (and Voyage v3+) use asymmetric query/document encoding for
better retrieval. The gateway's `embedQuery(text)` companion threads
`input_type: 'query'`; standard `embed(texts)` defaults to
`'document'`. Hybrid search's two query-side embed sites use
`embedQuery()` automatically; all ingest paths use `embed()`.

Symmetric providers (OpenAI text-embedding-3, fixed-dim Voyage models)
ignore the field — no behavior change.

## Cache key versioning

v0.35.0.0 bumped `KNOBS_HASH_VERSION` 1 → 2 to fold reranker config into
the `query_cache.knobs_hash` column. During a rolling deploy:

- Expect a temporary cache hit-rate dip (~1 hour at default
  `cache.ttl_seconds = 3600s`)
- Hot queries may briefly double their cache row count (one row per
  version)

Both clear naturally; no operator action required.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `embedding_config` probe says invalid dim | Defaulting to 1536 (OpenAI default) | Set `embedding_dimensions` to one of 2560/1280/640/320/160/80/40 |
| `reranker_config` probe says model not in allowlist | Typo in `search.reranker.model` | Use one of `zerank-2` / `zerank-1` / `zerank-1-small` |
| `reranker_health` doctor warns about auth | `ZEROENTROPY_API_KEY` not set or invalid | Re-export the env var; `gbrain models doctor` to verify |
| `reranker_health` doctor warns about transient failures | Upstream flake or rate limit | Reranker fails open to RRF; check ZE status page if persistent |
| Cache hit rate dipped after upgrade | Expected during rolling deploy | Clears within `cache.ttl_seconds` (default 3600s) |
