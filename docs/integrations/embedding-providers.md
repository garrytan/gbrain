# Embedding providers

GBrain ships with 16 embedding-provider recipes covering Voyage (the default), OpenAI, OpenRouter (single key, many hosted models), the major hosted alternatives, three local options, a universal escape hatch (LiteLLM proxy), and the deprecated ZeroEntropy recipe (hosted API shuts down 2026-09-04). Run `gbrain providers list` to see the live registry; `gbrain providers explain --json` emits a machine-readable matrix for agents.

This page is the human-readable counterpart: capability per provider, env-var setup, dimensions, cost, and known constraints.

## Quick start

```
gbrain providers list                          # see all providers
gbrain providers env <provider-id>             # see required env vars
gbrain providers test --model openai:text-embedding-3-large   # smoke-test
gbrain init --pglite --model voyage            # use a non-default provider
```

## Init resolves your provider from your keys

`gbrain init --pglite` auto-detects which provider to use from your provider keys — env vars or the file plane (`~/.gbrain/config.json` fields like `voyage_api_key`; env wins when both are set). With `VOYAGE_API_KEY` set, you get Voyage (`voyage:voyage-4` @ 1024d). With `OPENAI_API_KEY` set, you get OpenAI. Whenever a Voyage key is present — even if a different embedding provider is picked — init also writes `search.reranker.model voyage:rerank-2.5` as explicit config (one key covers both); keyed installs without a Voyage key get `search.reranker.enabled false` written instead. If multiple provider keys are set, init fires an interactive picker (non-TTY auto-picks the Voyage default when its key is present). ZeroEntropy is deprecated and excluded from both auto-pick and the picker — explicit `--embedding-model zeroentropyai:*` still works, with a loud warning. With no provider keys at all, init continues keyless (keyword-only search) with a loud notice; recover later with `gbrain init --force --embedding-model voyage:voyage-4`. Explicit flags (`--embedding-model`, `--no-embedding`) always win over key detection.

The resolved provider + dimensions get persisted to `~/.gbrain/config.json` atomically, so subsequent runs are deterministic across releases.

## TL;DR table

| Provider | env vars | default dims | cost ($/1M tokens) | local? | multimodal? |
|---|---|---|---|---|---|
| `voyage` (**default** — `voyage-4` @ 1024d; `rerank-2.5` reranker on the same key) | `VOYAGE_API_KEY` | 1024 | 0.06 (`voyage-4`) | no | yes (`voyage-multimodal-3`) |
| `openai` | `OPENAI_API_KEY` | 1536 | 0.13 | no | no |
| `openrouter` | `OPENROUTER_API_KEY` | per-model (1536 for the default `openai/text-embedding-3-small`; unlisted ids require explicit dims) | 0.02 | no | model-dependent |
| `zeroentropyai` — **DEPRECATED** (hosted API **shuts down 2026-09-04**; replacement `voyage:voyage-4` — see note below) | `ZEROENTROPY_API_KEY` | 2560 (Matryoshka to 1280/640/320/...) | 0.05 | no | no |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | 768 | 0.025 | no | no |
| `azure-openai` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | 1536 | 0.13 | no | no |
| `minimax` | `MINIMAX_API_KEY` | 1536 | 0.07 | no | no |
| `dashscope` | `DASHSCOPE_API_KEY` | 1024 | varies | no | no |
| `zhipu` | `ZHIPUAI_API_KEY` | 1024 | varies | no | no |
| `ollama` | (none — runs locally) | 768 | 0 | yes | no |
| `llama-server` | (none — runs locally) | user-set | 0 | yes | no |
| `litellm` | `LITELLM_API_KEY` (optional) | user-set | varies | yes (proxy) | yes (backend permitting) |
| `together` | `TOGETHER_API_KEY` | 768 | varies | no | no |
| `anthropic` | (no embedding model — chat only) | — | — | — | — |
| `deepseek` | (no embedding model — chat only) | — | — | — | — |
| `groq` | (no embedding model — chat only) | — | — | — | — |

**Note on local providers.** Ollama and llama-server have no required API key, so they don't show up in env-detection auto-pick. Pick them explicitly with `--embedding-model ollama:<model>` to avoid silently routing to a daemon that may not be running. Ollama can also run local chat/expansion models; set those routes explicitly with `gbrain config set models.chat ollama:<model>` and related per-task model keys.

**Note on the ZeroEntropy hosted API.** ZeroEntropy announced (2026-07-24) that its hosted endpoints shut down on **2026-09-04**, and the recipe is deprecated: init auto-pick and the interactive picker exclude it (explicit `--embedding-model zeroentropyai:*` still works, with a loud warning), every ZE embed/rerank call prints a once-per-process deprecation warning, and `gbrain providers` annotates it DEPRECATED (`providers env zeroentropyai` prints the deprecation notice + migration command instead of the signup funnel, `providers explain` leads the row with ⚠ regardless of key readiness, and `gbrain doctor`'s ZE missing-key hint is migration-first). A brain still embedding through the hosted API loses semantic retrieval entirely on that date — query embedding uses the same endpoint, so existing vectors become unqueryable, not just new content. The off-ramp: `gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run` (cost preview), then `--yes`. 1280 is not a valid Voyage width (valid: 256/512/1024/2048), so a 1280d brain gets a one-time schema/HNSW rebuild to 1024; the OpenAI alternative keeps the width (flexible dims): `--to openai:text-embedding-3-small --dim 1280`. See [the migration guide](../guides/embedding-migration.md). Self-hosting the Apache-2.0 zembed-1 weights keeps every existing vector with zero re-embed, but the endpoint must speak ZeroEntropy's wire dialect — a generic OpenAI-compatible llama-server/Ollama will NOT work without a compat proxy (details in [`docs/ai-providers/zeroentropy.md`](../ai-providers/zeroentropy.md)). `gbrain doctor` (check `provider_sunset`) flags affected brains — including ZE-backed custom embedding columns — and prints target-aware paste-ready commands (Voyage at 1024; OpenAI keep-width when the brain's actual width is valid there); accepted the risk? `gbrain config set doctor.suppress_provider_sunset true` silences it.

## If first import fails

If `gbrain import` fails with `expected N dimensions, not M`, run `gbrain doctor`. The output will print the exact `gbrain config set ...` or `gbrain migrate embeddings` command to repair the mismatch. **You should not need to delete `~/.gbrain`.** The bug-class that historically forced `rm -rf` recoveries is closed as of v0.37.

The doctor distinguishes two repair paths:

- **Empty brain** (no embedded chunks yet) — drop and re-init at the right dim:
  ```
  gbrain init --force --pglite --embedding-model <provider>:<model> --embedding-dimensions <N>
  ```

- **Non-empty brain** — migrate cleanly with the supported migration path
  (resumable; preview cost with `--dry-run` first):
  ```
  gbrain migrate embeddings --to <provider>:<model> --dim <N>
  ```
  Leaving ZeroEntropy specifically: `gbrain migrate embeddings --to voyage:voyage-4 --dim 1024`
  (the full playbook is `skills/migrations/v0.46.3.0.md`).

## Decision tree

- **Cost-sensitive, English-only**: Ollama (free, local) or Voyage (paid, best quality per dollar).
- **Quality-first**: Voyage `voyage-4-large` (1024-2048 dims, ~3-4× more dense tokens than OpenAI tiktoken).
- **Code-heavy brain (gstack per-worktree, source repos)**: Voyage `voyage-code-3` (1024 default; supports 256/512/1024/2048), or the newer `voyage-code-4` (hosted, flexible dims, $0.12/M). Tuned on programming languages. Voyage publishes head-to-head numbers showing it outperforms their general flagships on code retrieval ([voyageai.com/blog](https://voyageai.com/blog)). For gstack's per-worktree pglite-backed code brain, this is the right default — see Topology 3 in `docs/architecture/topologies.md`.
- **Reranking pair**: Voyage `rerank-2.5` ($0.05/M; `rerank-2.5-lite` at $0.02/M for cost-sensitive setups) is the new-install default and rides the same `VOYAGE_API_KEY` as embeddings. ZeroEntropy `zerank-2` remains the fallback only for brains that never set `search.reranker.model` — deprecated, hosted API ends 2026-09-04 (see [`docs/ai-providers/zeroentropy.md`](../ai-providers/zeroentropy.md)).
- **Local reranking (no API spend)**: `llama-server-reranker` recipe (v0.40.6.1) — point gbrain at your own `llama-server --reranking` instance running Qwen3-Reranker or self-hosted ZeroEntropy weights. Same `gateway.rerank()` seam, $0 per call. Walkthrough in [`docs/ai-providers/llama-server-reranker.md`](../ai-providers/llama-server-reranker.md).
- **One key for many hosted models**: OpenRouter. Set `OPENROUTER_API_KEY` and use `openrouter:<provider>/<model>` for chat against GPT-5.2, Claude 4.x, Gemini 3, DeepSeek, and dozens more without juggling per-provider keys. Embedding catalog includes OpenAI, Google, Qwen, BGE-M3.
- **Enterprise compliance**: Azure OpenAI (data residency + private endpoints) or self-hosted via llama-server / Ollama.
- **China region**: DashScope (Alibaba) or Zhipu (BigModel). DashScope's international endpoint at `dashscope-intl.aliyuncs.com`; override `provider_base_urls.dashscope` for the China endpoint.
- **OSS local, full control**: llama-server (`llama.cpp`) for any GGUF model; Ollama for the curated catalog.
- **Anything else**: LiteLLM proxy. Run LiteLLM in front of any provider (Bedrock, Vertex, Cohere, Jina, Fireworks, etc.) and point gbrain at it via `LITELLM_BASE_URL`.

## Per-provider details

### OpenAI

The main alternative to the Voyage default (its flexible-dim `text-embedding-3` models can keep an existing column width during a provider migration). Set `OPENAI_API_KEY`. Models: `text-embedding-3-large` (3072 max, 1536 default), `text-embedding-3-small` (1536). Matryoshka via the `dimensions` field — gbrain pins it from `embedding_dimensions` config so existing 1536-dim brains stay aligned across SDK upgrades.

Optional `OPENAI_BASE_URL` — point the native OpenAI provider at an OpenAI-compatible gateway. A bare host is normalized to carry the `/v1` suffix automatically (so `https://gw.example.com` and `https://gw.example.com/v1` both work); when unset, the SDK's default endpoint is untouched. With `OPENAI_BASE_URL` set, embedding no longer requires `OPENAI_API_KEY` — the override targets local OpenAI-compatible servers (LM Studio, vLLM) that ignore auth, so gbrain sends a placeholder key instead of refusing (#4385). `ANTHROPIC_BASE_URL` gets the same normalization for Anthropic chat/expansion calls.

### Voyage AI

**The default provider** — new installs get `voyage-4` @ 1024d ($0.06/M) plus the `rerank-2.5` reranker on the same key. Best-in-class quality on the Voyage 4 family (Jan 2026 release). Set `VOYAGE_API_KEY`. Models: `voyage-4-large`, `voyage-4`, `voyage-4-lite`, `voyage-4-nano`, `voyage-code-4` (code-tuned, hosted, flexible dims, $0.12/M), `voyage-3.5`, `voyage-code-3`, `voyage-finance-2`, `voyage-law-2`, `voyage-multimodal-3` (text + image).

Voyage 4 family shares an embedding space across all variants, so you can index with `voyage-4` and later point the query model at `voyage-4-large` or `voyage-4-lite` without reindexing. Dims: 256, 512, 1024, 2048. **2048 exceeds pgvector's HNSW cap of 2000** — those brains fall back to exact vector scans (still correct, just slower).

Voyage also serves the hosted rerankers `rerank-2.5` ($0.05/M) and `rerank-2.5-lite` ($0.02/M) at `POST /v1/rerank` (prices verified 2026-08-15) — the new-install reranker default, configured via `gbrain config set search.reranker.model voyage:rerank-2.5`.

**For brains that index source code** (gstack's per-worktree pglite-backed code brain — see Topology 3 in `docs/architecture/topologies.md`), prefer `voyage-code-3` over `voyage-4-large`. Voyage tunes it on programming languages and publishes head-to-head numbers vs their general flagships on code retrieval. Configure at install time:

```bash
gbrain init --pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024
```

To switch an existing brain, run `gbrain migrate embeddings --to voyage:voyage-code-3 --dim 1024` (works on both engines; resumable, cost-previewed with `--dry-run` — see [`docs/guides/embedding-migration.md`](../guides/embedding-migration.md)). `gbrain config set embedding_model` is refused — the schema column has to resize, and the migration command is the path that does that safely.

`gbrain reindex --code` will print a recommendation when run against a brain whose configured embedding model isn't code-tuned; suppress with `GBRAIN_NO_CODE_MODEL_NUDGE=1` if you've intentionally chosen another model (single-vendor procurement, compliance, etc.).

### Google Gemini

Set `GOOGLE_GENERATIVE_AI_API_KEY` (the AI Studio public API key). Model: `gemini-embedding-001`. Default 768 dims; Matryoshka up to 3072. Cheap.

For GCP service-account / Vertex AI auth (production deployments), see the v0.32.x follow-up — Vertex ADC is on the roadmap.

### OpenRouter

Single OpenAI-compatible API for fan-out to OpenAI, Anthropic, Google, DeepSeek, Meta Llama, Qwen, and dozens of other hosted providers. One key, many models. Set `OPENROUTER_API_KEY` or `openrouter_api_key` in `~/.gbrain/config.json`, then use `openrouter:<provider>/<model>` (e.g. `openrouter:openai/gpt-5.2`, `openrouter:anthropic/claude-sonnet-4.6`).

**Embedding**: `openai/text-embedding-3-small` (1536d default, Matryoshka shrink to 512/768/1024). The recipe carries verified per-model native dims for its catalog — `openai/text-embedding-3-large` (3072), `qwen/qwen3-embedding-8b` (4096), `bge-m3` (1024) — so opting in via `--embedding-model openrouter:<id>` plans the right column width automatically. Any id NOT in that list (including `google/gemini-embedding-2-preview`, whose width is unverified) has no silent default: you must pass explicit dimensions (`--embedding-dimensions <N>` or `embedding_dimensions` config) or the command errors with the fix. Pricing matches the upstream provider (OR adds a small markup).

**Chat**: every chat model OR proxies works through `/v1/chat/completions`. The recipe lists 8 curated entry points (GPT-5.2 family, Claude 4.5/4.6/4.7, Gemini 3 Flash Preview, DeepSeek); any other OR catalog ID also works. Tool-calling envelope is supported by the OR endpoint, but per-model capability varies — check https://openrouter.ai/models before counting on tools for a specific slug.

**Optional env**:
- `OPENROUTER_BASE_URL` — point at a self-hosted OR-compatible proxy.
- `OPENROUTER_REFERER` (default `https://gbrain.ai`) and `OPENROUTER_TITLE` (default `gbrain`) — attribution headers for OR's leaderboard. Forks running gbrain inside a different agent stack (OpenClaw deployments etc.) should set these so their traffic gets attributed to them, not gbrain.

**Subagent loops**: gbrain's subagent infrastructure hard-pins to Anthropic-direct (stable `tool_use_id` across crashes/replays). OR-routed Anthropic is rejected at submit time regardless of the recipe flag. If you want the price/availability story OR offers for tool-calling, use it for chat only and keep an Anthropic key for subagent work.

### Azure OpenAI

Enterprise OpenAI behind Azure tenancy. Required env: `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` (e.g. `https://my-resource.openai.azure.com`), `AZURE_OPENAI_DEPLOYMENT` (the deployment name from your Azure portal). Optional: `AZURE_OPENAI_API_VERSION` (defaults to `2024-10-21`).

Unlike vanilla OpenAI, Azure uses `api-key:` header (not `Authorization: Bearer`) and a templated URL with `?api-version=` query param — gbrain handles both via the recipe's resolveAuth + resolveOpenAICompatConfig overrides.

Models: `text-embedding-3-large`, `text-embedding-3-small`, `text-embedding-ada-002` (your Azure deployment must serve the requested model).

### MiniMax (海螺AI)

Set `MINIMAX_API_KEY`. Optional `MINIMAX_GROUP_ID` for org-scoped accounts. Model: `embo-01` (1536 dims).

MiniMax's API takes a `type: 'db' | 'query'` field for asymmetric retrieval. v0.32 routes everything as `type='db'` (symmetric retrieval — same vector space for indexing and queries). Asymmetric query support is a v0.32.x follow-up.

### DashScope (Alibaba)

Set `DASHSCOPE_API_KEY`. International endpoint at `dashscope-intl.aliyuncs.com` by default; override `provider_base_urls.dashscope` for the China endpoint. Models: `text-embedding-v3` (current; Matryoshka 64-1024 dims), `text-embedding-v2`.

CJK-dominant content tokenizes denser than OpenAI tiktoken; gbrain declares `chars_per_token: 2` so the batch pre-split leaves headroom.

### Zhipu AI (BigModel)

Set `ZHIPUAI_API_KEY`. Models: `embedding-3` (current; Matryoshka 256-2048 dims), `embedding-2`. v0.32 default is 1024 (HNSW-compatible). The 2048-dim option works but falls into the exact-scan branch (see Voyage 4 Large note above).

### Ollama (local)

No env required — Ollama runs unauthenticated locally. Optional `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`) and `OLLAMA_API_KEY` (for auth-enabled deployments).

Recipe ships with `nomic-embed-text` (768d, recommended), `mxbai-embed-large` (1024d), `all-minilm` (384d), plus the larger modern embedders `qwen3-embedding:8b` (4096d) and `snowflake-arctic-embed2` (1024d) — those are the real pullable Ollama library tags; the earlier `qwen3-embed-8b` / `snowflake-arctic-embed-l-v2` spellings never matched a pullable tag and stay accepted only so brains initialized with them keep validating. `gbrain providers test --model ollama:nomic-embed-text` smoke-tests the local install.

The recipe default is `nomic-embed-text`'s 768 dims. If you run one of the larger models, declare its native dimension with `--embedding-dimensions <N>` at init — gbrain trusts the value you declare for local recipes instead of rejecting a non-768 width.

Ollama also exposes an OpenAI-compatible `/v1/chat/completions` endpoint, so gbrain can use local chat models for query expansion, `think`, facts extraction, and dream synthesis. A minimal local setup:

```bash
ollama pull nomic-embed-text
ollama pull qwen2.5-coder:14b

gbrain init --pglite --embedding-model ollama:nomic-embed-text --embedding-dimensions 768
gbrain config set models.chat ollama:qwen2.5-coder:14b
gbrain config set models.expansion ollama:qwen2.5-coder:14b
gbrain config set models.think ollama:qwen2.5-coder:14b
gbrain config set models.dream.synthesize ollama:qwen2.5-coder:14b
gbrain config set models.dream.synthesize_verdict ollama:qwen2.5-coder:14b
gbrain config set models.dream.patterns ollama:qwen2.5-coder:14b
gbrain config set facts.extraction_model ollama:qwen2.5-coder:14b
```

The recipe marks Ollama chat as **not** tool-capable. That is enough for local reasoning flows, but not for gbrain's subagent/tool loop; keep `models.tier.subagent` on a provider with tool calling when you need that path.

### llama-server (local, llama.cpp)

`llama.cpp`'s `llama-server --embeddings` endpoint. No env required. Optional `LLAMA_SERVER_BASE_URL` (default `http://localhost:8080/v1`) and `LLAMA_SERVER_API_KEY`.

User-driven models: launch llama-server with `--model <gguf-path> --embeddings`, then run `gbrain init --embedding-model llama-server:<your-id> --embedding-dimensions <N>`. gbrain trusts the dimension you declare (you know the GGUF you launched); the recipe refuses the implicit shorthand `--model llama-server` because there's no canonical first model.

### LiteLLM proxy (universal escape hatch)

Run [LiteLLM](https://docs.litellm.ai/docs/proxy/quick_start) in front of any provider — Bedrock, Vertex, Cohere, Jina, Fireworks, OctoAI, etc. The proxy normalizes everything to the OpenAI-compatible API; gbrain points at the proxy via `LITELLM_BASE_URL` and proxies the call.

This is the catch-all for "my provider isn't in the list above." Set up LiteLLM, then `gbrain init --embedding-model litellm:<your-model-id> --embedding-dimensions <N>`.

**Include the `/v1` suffix in `LITELLM_BASE_URL` if your proxy serves the OpenAI route there** (e.g. `http://localhost:4000/v1`). Many LiteLLM deployments expose the OpenAI-compatible API only under `/v1`; pointing gbrain at the bare host 404s or fails authentication with no hint. gbrain trusts the dimension you declare for the proxy-backed model — the proxy's backend, not gbrain, decides the true width — so `--embedding-dimensions <N>` is required and accepted as-is.

## Choosing dimensions

Three numbers matter:
1. **Provider's native dims**: each model has a "true" output dim (e.g. OpenAI `text-embedding-3-large` is 3072 native).
2. **Matryoshka reductions**: most modern providers let you request a smaller vector via the `dimensions` field.
3. **HNSW cap**: pgvector's HNSW index supports up to 2000 dims. Brains above that fall back to exact vector scans (slower but correct; gbrain handles the SQL automatically via `chunkEmbeddingIndexSql` in `src/core/vector-index.ts`).

For most users: **stay at 1024 or 1536**. Bigger isn't better below the noise floor; smaller saves disk + RAM with marginal recall loss on Matryoshka providers.

## Bulk-embed failure knobs

Two env vars tune how bulk embeds (`gbrain embed --stale` and the autopilot/minion cycles that ride the same stale path) behave under sustained failures. Both matter most against local serial servers (Ollama at `-np 1`, llama-server), where re-sending doomed requests compounds into congestion collapse:

| Env var | Default | What it does |
|---|---|---|
| `GBRAIN_EMBED_QUARANTINE_AFTER` | 3 | Consecutive zero-progress attempts (no chunk embedded) before a page is quarantined for the rest of the process. An attempt that embeds ANY chunk resets the page's counter — partial progress shrinks the stale set, so the next pass sends a smaller request, not the identical doomed one. Quarantine is keyed per page (`source_id::slug`) and announced once on stderr; later passes skip quarantined pages with a count. Process-lifetime by design: restarting retries deliberately, and `frontmatter.embed_skip` is the permanent block. Non-numeric or non-positive values fall back to 3. |
| `GBRAIN_EMBED_MAX_BATCH_TOKENS` | (unset) | Token cap per embedding request for recipes that ship without one — ollama, llama-server, and litellm declare `no_batch_cap` because real capacity depends on the operator's server. When set, chunk texts are pre-split into sub-batches within `cap × safety_factor` (default 0.8) tokens, estimated via the recipe's `chars_per_token` (default 4). A recipe-declared cap always wins; invalid values are ignored. Read once from the environment at process start, never at call time. Without it, `no_batch_cap` recipes still get a conservative 16-item sub-batch cap so the per-call embed timeout bounds a fixed amount of work. |

## My provider isn't listed

Four options:

1. **Use OpenRouter** when the provider/model is available through OR's OpenAI-compatible API (covers most hosted chat models + a growing embedding catalog).
2. **Use LiteLLM proxy** (above) — the universal escape hatch. Works for 100+ providers.
3. **Open a feature request** at [github.com/garrytan/gbrain/issues](https://github.com/garrytan/gbrain/issues) with the provider's API docs URL and a setup snippet. Recipes are ~30-40 lines of TypeScript.
4. **Submit a recipe**: clone, copy `src/core/ai/recipes/voyage.ts` as the gold-standard openai-compat template, register in `src/core/ai/recipes/index.ts`, add a per-recipe smoke test under `test/ai/recipe-<name>.test.ts`. The recipe contract test (`test/ai/recipes-contract.test.ts`) and IRON RULE regression test pin the structural invariants.

## Switching providers on an existing brain

Embedding dimensions are baked into the schema at `gbrain init` time. As of v0.37.11.0, `gbrain config set embedding_model` and `gbrain config set embedding_dimensions` are refused — the schema column has to resize alongside the config, and `config set` only touches the config row.

The supported paths:

- **PGLite (default install):** `gbrain reinit-pglite --embedding-model <provider>:<model> --embedding-dimensions <N>` — one-command wipe-and-reinit that preserves every other config field (chat model, expansion model, API keys), backs up the prior brain to `<path>.bak`, runs `gbrain init` with the new flags, and re-syncs your brain repo. Add `--no-sync` to skip the resync, `--yes` to skip the TTY confirmation, `--json` for scripts.
- **Postgres (Supabase / self-hosted):** follow the SQL recipe in `docs/embedding-migrations.md` (drop the HNSW index, ALTER COLUMN TYPE, clear stale embeddings, recreate the index conditionally, then `gbrain init --supabase --embedding-model X --embedding-dimensions N` to update the file plane and re-embed).

`gbrain doctor` 8c "alternative_providers" surfaces unconfigured providers whose env is already set — useful when you've configured OpenAI but also have e.g. `VOYAGE_API_KEY` exported and want to know you can switch without extra setup.
