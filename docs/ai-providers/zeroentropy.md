# ZeroEntropy — zembed-1 + zerank-2 (DEPRECATED)

> **DEPRECATED — hosted API shutdown: 2026-09-04.** ZeroEntropy announced
> (2026-07-24) that its hosted endpoints — `/models/embed` and
> `/models/rerank` — shut down on that date, and gbrain has deprecated the
> recipe: `gbrain init` auto-pick and the interactive picker exclude it
> (explicit `--embedding-model zeroentropyai:*` still works, with a loud
> warning), every ZE embed/rerank call prints a once-per-process
> deprecation warning, `gbrain providers` annotates it DEPRECATED
> (`gbrain providers env zeroentropyai` prints this off-ramp instead of a
> signup link), and
> `gbrain ze-switch` is a pure refusal/redirect shim (every invocation
> refuses or redirects; `--undo` prints the exact migrate command that
> returns a switched brain to its prior provider — it no longer acts).
> The September release removes the recipe entirely. A brain still embedding through the hosted API loses semantic
> retrieval entirely on the shutdown date: query embedding uses the same
> endpoint, so **existing vectors become unqueryable**, not just new
> content. Two fixes, either works:
>
> 1. **Migrate to Voyage (recommended)** — `gbrain migrate embeddings
>    --to voyage:voyage-4 --dim 1024 --dry-run` (cost preview), then
>    `--yes`. 1280 is not a valid Voyage width (valid: 256/512/1024/2048),
>    so a 1280d brain gets a one-time schema/HNSW rebuild to 1024 — the
>    command handles it, resumable if killed. The OpenAI alternative keeps
>    the width (flexible dims): `--to openai:text-embedding-3-small --dim
>    1280`. Reranker: `gbrain config set search.reranker.model
>    voyage:rerank-2.5` (needs `VOYAGE_API_KEY`) or `gbrain config set
>    search.reranker.enabled false`. See
>    [the migration guide](../guides/embedding-migration.md); `gbrain
>    doctor` (check `provider_sunset`) prints both commands target-aware
>    (Voyage at 1024; OpenAI keep-width when your brain's actual width is
>    valid there).
> 2. **Self-host the same model (zero re-embed, advanced)** — zembed-1
>    weights are Apache-2.0. Keep the `zeroentropyai:zembed-1` model id
>    (the embedding signature must not change) and point its base URL at
>    your own endpoint: `gbrain config set
>    provider_base_urls.zeroentropyai <url>`. The endpoint must speak
>    **ZeroEntropy's wire dialect** (`/models/embed`, `{results: [...]}`
>    responses — the id routes through a ZE-specific compat fetch), so a
>    generic OpenAI-compatible llama-server or Ollama endpoint will NOT
>    work without a compat proxy in front. Switching the provider id
>    instead changes `pages.embedding_signature` and triggers a full
>    re-embed. This path survives only until the September removal release
>    deletes the recipe.
>
> The hosted setup below remains accurate until the shutdown date.

[ZeroEntropy](https://zeroentropy.dev) shipped two specialized small
models for retrieval pipelines (factual specs kept for existing users and
self-hosters — this is not a recommendation):

- **`zembed-1`** — multilingual embedding distilled from zerank-2.
  Flexible Matryoshka dims (2560/1280/640/320/160/80/40), 32K context,
  asymmetric `input_type: query|document` encoding.
- **`zerank-2`** — multilingual cross-encoder reranker. Plus `zerank-1`
  and `zerank-1-small` (open-source weights).

Both landed in gbrain v0.35.0.0 behind the openai-compatible recipe path,
alongside OpenAI and Voyage.

## Setup (existing brains and self-hosters only — do not onboard)

New installs use Voyage (`gbrain init` handles it); do not create a new
ZeroEntropy account for a provider that shuts down on 2026-09-04. A brain
that already has a key exports it as before for the remaining hosted
window:

```bash
export ZEROENTROPY_API_KEY=<your-existing-key>
```

## Leaving ZeroEntropy (the off-ramp)

The switch-ONTO instructions that used to live here are gone — following
them would strand a brain on a dead API. The maintained off-ramp is the
agent playbook at `skills/migrations/v0.46.3.0.md`; the one command
(embeddings + reranker in the same consented run):

```bash
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run   # cost preview
gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --yes
```

Plane note (still true, and the reason NOT to hand-edit config for this):
`embedding_model` / `embedding_dimensions` resolve from the **file plane**
(`~/.gbrain/config.json`) and the **env plane** (`GBRAIN_EMBEDDING_MODEL` /
`GBRAIN_EMBEDDING_DIMENSIONS`) — never the DB plane — because they size the
schema. The migration command writes the right planes for you and verifies
the database before claiming anything is done. Check state any time with
`gbrain migrate embeddings --status`.

### Re-embed

The migration command drains the re-embed itself and refuses to declare
completion until the database verifies — there is no separate embed step
on the off-ramp path. If a run is killed mid-drain, `gbrain migrate
embeddings --status` prints the exact resume command. Self-hosters keeping
`zeroentropyai:zembed-1` via `provider_base_urls` re-embed nothing (the
embedding signature is unchanged).

### Verify

```bash
gbrain migrate embeddings --status
```

Read-only and spend-free: reports every config plane, actual column
widths, the NULL-vector and signature censuses, the in-flight marker, and
the last completion's smoke-check outcome. Step 5 of the playbook
(`skills/migrations/v0.46.3.0.md`) walks the full DB-verified check.

## Reranker switch — zerank-2

The reranker is the bigger story: gbrain had no cross-encoder reranker
stage before v0.35.0.0. It slots between RRF dedup and token-budget
enforcement in hybrid search.

### Default-on with `balanced` and `tokenmax` modes

The `balanced` and `tokenmax` mode bundles default
`search.reranker.enabled = true`. Brains that never set
`search.reranker.model` still fall back to `zerank-2` (the legacy bundle
default until the September cutover — new installs write explicit reranker
config instead: `voyage:rerank-2.5` when a Voyage key is present, otherwise
`search.reranker.enabled false`). With
`ZEROENTROPY_API_KEY` set, the ZE reranker fires automatically. Without
the key, every rerank call fails-open (audit-logged) and search returns
RRF order — same UX as before, just with an observable failure surfaced
via `gbrain doctor`.

### Enabling reranking today

Set the surviving reranker FIRST, then enable — enabling on a brain that
never set `search.reranker.model` falls back to the dying `zerank-2`:
`gbrain config set search.reranker.model voyage:rerank-2.5`, then
`gbrain config set search.reranker.enabled true`.

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
| `search.reranker.enabled` | `true` for balanced/tokenmax, `false` for conservative | One-flip opt-in/out |
| `search.reranker.model` | `zeroentropyai:zerank-2` (legacy fallback; new installs write `voyage:rerank-2.5`) | The recommended replacement is `voyage:rerank-2.5` |
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
