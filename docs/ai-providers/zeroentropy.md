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

## Embedding switch — zembed-1

**Important:** `gbrain config set embedding_model …` is NOT a live
gateway switch. `embedding_model` and `embedding_dimensions` size the
schema and must be stable across engine connects, so they only resolve
from the **file plane** (`~/.gbrain/config.json`) and the **env plane**
(`GBRAIN_EMBEDDING_MODEL` / `GBRAIN_EMBEDDING_DIMENSIONS`). The DB plane
is intentionally ignored for these two keys (same posture as today's
Voyage setup).

### Option A — file plane (recommended for stable installs)

Edit `~/.gbrain/config.json`:

```json
{
  "embedding_model": "zeroentropyai:zembed-1",
  "embedding_dimensions": 2560
}
```

Valid dims: `2560` (default), `1280`, `640`, `320`, `160`, `80`, `40`.
Matryoshka-style — smaller trades quality for storage monotonically.
Pick the largest that fits your column width.

### Option B — env plane (CI / Docker)

```bash
export GBRAIN_EMBEDDING_MODEL=zeroentropyai:zembed-1
export GBRAIN_EMBEDDING_DIMENSIONS=2560
```

### Re-embed

Switching embedding models invalidates the vector index. Re-embed:

```bash
gbrain embed --stale --limit 50    # smoke a small batch
gbrain embed --stale               # full re-embed
```

### Verify

```bash
gbrain models doctor --json | jq '.probes[] | select(.touchpoint=="embedding_config")'
```

Expected: `status: "ok"`. Invalid dims (e.g. `1024`, `1536`, `3072`)
surface as `status: "config"` with a paste-ready
`gbrain config set embedding_dimensions <one of 2560|1280|640|320|160|80|40>` fix hint.

## Reranker switch — zerank-2

The reranker is the bigger story: gbrain had no cross-encoder reranker
stage before v0.35.0.0. It slots between RRF dedup and token-budget
enforcement in hybrid search.

### Default-on with `tokenmax` mode

`tokenmax` mode now defaults `search.reranker.enabled = true` with
`zerank-2`. If you already use `tokenmax` AND have `ZEROENTROPY_API_KEY`
set, reranker fires automatically. Without the key, every rerank call
fails-open (audit-logged) and search returns RRF order — same UX as
before, just with an observable failure surfaced via `gbrain doctor`.

### Opt-in on `conservative` or `balanced` mode

```bash
gbrain config set search.reranker.enabled true
```

The override sits above the mode-bundle default; opt-out is one flip.

### Cost anchor

At 30 candidates × ~400 tokens/chunk × $0.025/1M = **~$0.0003/query**.
Rounding error against the `tokenmax + Opus` pairing's ~$700/mo at
single-user volume per the CLAUDE.md cost matrix.

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
| `search.reranker.enabled` | `true` for tokenmax, `false` for others | One-flip opt-in/out |
| `search.reranker.model` | `zeroentropyai:zerank-2` | Try `zerank-1` (older SOTA) or `zerank-1-small` (Apache-2.0 open) |
| `search.reranker.top_n_in` | `30` | Candidates sent to reranker (caps API spend) |
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
