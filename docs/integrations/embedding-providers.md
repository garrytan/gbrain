# Embedding providers

GBrain ships with 16 embedding-provider recipes covering OpenAI, ZeroEntropy, Voyage, OpenRouter (single key, many hosted models), the major hosted alternatives, three local options, and a universal escape hatch (LiteLLM proxy). Run `gbrain providers list` to see the live registry; `gbrain providers explain --json` emits a machine-readable matrix for agents.

This page is the human-readable counterpart: capability per provider, env-var setup, dimensions, cost, and known constraints.

## Quick start

```
gbrain providers list                          # see all providers
gbrain providers env <provider-id>             # see required env vars
gbrain providers test --model openai:text-embedding-3-large   # smoke-test
gbrain init --pglite --model voyage            # use a non-default provider
```

## Init resolves your provider from env keys

As of v0.37, `gbrain init --pglite` auto-detects which provider to use from your env vars. With `OPENAI_API_KEY` set, you get OpenAI. With `ZEROENTROPY_API_KEY` set, you get ZeroEntropy. If multiple provider keys are set, init fires an interactive picker. If no provider keys are set in a non-TTY context (CI, Docker build), init exits 1 with a paste-ready setup hint. Explicit flags (`--embedding-model`, `--no-embedding`) always win over env detection.

The resolved provider + dimensions get persisted to `~/.gbrain/config.json` atomically, so subsequent runs are deterministic across releases.

## TL;DR table

| Provider | env vars | default dims | cost ($/1M tokens) | local? | multimodal? |
|---|---|---|---|---|---|
| `zeroentropyai` | `ZEROENTROPY_API_KEY` | 2560 (Matryoshka to 1280/640/320/...) | 0.05 | no | no |
| `openai` | `OPENAI_API_KEY` | 1536 | 0.13 | no | no |
| `openrouter` | `OPENROUTER_API_KEY` | 1536 | 0.02 | no | model-dependent |
| `voyage` | `VOYAGE_API_KEY` | 1024 | 0.18 | no | yes (`voyage-multimodal-3`) |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | 768 | 0.025 | no | no |
| `azure-openai` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | 1536 | 0.13 | no | no |
| `minimax` | `MINIMAX_API_KEY` | 1536 | 0.07 | no | no |
| `dashscope` | `DASHSCOPE_API_KEY` | 1024 | varies | no | no |
| `zhipu` | `ZHIPUAI_API_KEY` | 1024 | varies | no | no |
| `ollama` | (none — runs locally) | 768 | 0 | yes | no |
| `llama-server` | (none — runs locally) | user-set | 0 | yes | no |
| `litellm` | `LITELLM_API_KEY` (optional) | user-set | varies | yes (proxy) | no |
| `together` | `TOGETHER_API_KEY` | 768 | varies | no | no |
| `anthropic` | (no embedding model — chat only) | — | — | — | — |
| `deepseek` | (no embedding model — chat only) | — | — | — | — |
| `groq` | (no embedding model — chat only) | — | — | — | — |

**Note on local providers.** Ollama and llama-server have no required API key, so they don't show up in env-detection auto-pick. Pick them explicitly with `--embedding-model ollama:<model>` to avoid silently routing to a daemon that may not be running.

## If first import fails

If `gbrain import` fails with `expected N dimensions, not M`, run `gbrain doctor`. The output will print the exact `gbrain config set ...` or `gbrain retrieval-upgrade` command to repair the mismatch. **You should not need to delete `~/.gbrain`.** The bug-class that historically forced `rm -rf` recoveries is closed as of v0.37.

The doctor distinguishes two repair paths:

- **Empty brain** (no embedded chunks yet) — drop and re-init at the right dim:
  ```
  gbrain init --force --pglite --embedding-model <provider>:<model> --embedding-dimensions <N>
  ```

- **Non-empty brain** — migrate cleanly with the supported reindex path:
  ```
  gbrain retrieval-upgrade --to <provider>:<model> --reindex
  ```

## Decision tree

- **Cost-sensitive, English-only**: Ollama (free, local) or Voyage (paid, best quality per dollar).
- **Quality-first**: Voyage `voyage-4-large` (1024-2048 dims, ~3-4× more dense tokens than OpenAI tiktoken).
- **Code-heavy brain (gstack per-worktree, source repos)**: Voyage `voyage-code-3` (1024 default; supports 256/512/1024/2048). Tuned on programming languages. Voyage publishes head-to-head numbers showing it outperforms their general flagships on code retrieval ([voyageai.com/blog](https://voyageai.com/blog)). For gstack's per-worktree pglite-backed code brain, this is the right default — see Topology 3 in `docs/architecture/topologies.md`.
- **Reranking pair**: Voyage (their reranker `rerank-2.5` pairs cleanly with Voyage embeddings).
- **One key for many hosted models**: OpenRouter. Set `OPENROUTER_API_KEY` and use `openrouter:<provider>/<model>` for chat against GPT-5.2, Claude 4.x, Gemini 3, DeepSeek, and dozens more without juggling per-provider keys. Embedding catalog includes OpenAI, Google, Qwen, BGE-M3.
- **Enterprise compliance**: Azure OpenAI (data residency + private endpoints) or self-hosted via llama-server / Ollama.
- **China region**: DashScope (Alibaba) or Zhipu (BigModel). DashScope's international endpoint at `dashscope-intl.aliyuncs.com`; override `provider_base_urls.dashscope` for the China endpoint.
- **OSS local, full control**: llama-server (`llama.cpp`) for any GGUF model; Ollama for the curated catalog.
- **Anything else**: LiteLLM proxy. Run LiteLLM in front of any provider (Bedrock, Vertex, Cohere, Jina, Fireworks, etc.) and point gbrain at it via `LITELLM_BASE_URL`.

## Per-provider details

### OpenAI

Default. Set `OPENAI_API_KEY`. Models: `text-embedding-3-large` (3072 max, 1536 default), `text-embedding-3-small` (1536). Matryoshka via the `dimensions` field — gbrain pins it from `embedding_dimensions` config so existing 1536-dim brains stay aligned across SDK upgrades.

### Voyage AI

Best-in-class quality on the Voyage 4 family (Jan 2026 release). Set `VOYAGE_API_KEY`. Models: `voyage-4-large`, `voyage-4`, `voyage-4-lite`, `voyage-4-nano`, `voyage-3.5`, `voyage-code-3` (code-tuned), `voyage-finance-2`, `voyage-law-2`, `voyage-multimodal-3` (text + image).

Voyage 4 family shares an embedding space across all variants, so you can index with `voyage-4-large` and query with `voyage-4-lite` without reindexing. Dims: 256, 512, 1024, 2048. **2048 exceeds pgvector's HNSW cap of 2000** — those brains fall back to exact vector scans (still correct, just slower).

**For brains that index source code** (gstack's per-worktree pglite-backed code brain — see Topology 3 in `docs/architecture/topologies.md`), prefer `voyage-code-3` over `voyage-4-large`. Voyage tunes it on programming languages and publishes head-to-head numbers vs their general flagships on code retrieval. Configure at install time:

```bash
gbrain init --pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024
```

To switch an existing brain, use `gbrain reinit-pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024` (PGLite) or follow `docs/embedding-migrations.md` (Postgres). `gbrain config set embedding_model` is refused — the schema column has to resize.

`gbrain reindex --code` will print a recommendation when run against a brain whose configured embedding model isn't code-tuned; suppress with `GBRAIN_NO_CODE_MODEL_NUDGE=1` if you've intentionally chosen another model (single-vendor procurement, compliance, etc.).

### Google Gemini

Set `GOOGLE_GENERATIVE_AI_API_KEY` (the AI Studio public API key). Model: `gemini-embedding-001`. Default 768 dims; Matryoshka up to 3072. Cheap.

For GCP service-account / Vertex AI auth (production deployments), see the v0.32.x follow-up — Vertex ADC is on the roadmap.

### OpenRouter

Single OpenAI-compatible API for fan-out to OpenAI, Anthropic, Google, DeepSeek, Meta Llama, Qwen, and dozens of other hosted providers. One key, many models. Set `OPENROUTER_API_KEY` and use `openrouter:<provider>/<model>` (e.g. `openrouter:openai/gpt-5.2`, `openrouter:anthropic/claude-sonnet-4.6`).

**Embedding**: `openai/text-embedding-3-small` (1536d default, Matryoshka shrink to 512/768/1024). OR's embedding catalog also includes `text-embedding-3-large`, `google/gemini-embedding-2-preview`, `qwen/qwen3-embedding-8b`, `bge-m3` — opt in via `--embedding-model openrouter:<id>`. Pricing matches the upstream provider (OR adds a small markup).

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

Recipe ships with `nomic-embed-text` (768d, recommended), `mxbai-embed-large` (1024d), `all-minilm` (384d). `gbrain providers test --model ollama:nomic-embed-text` smoke-tests the local install.

### llama-server (local, llama.cpp)

`llama.cpp`'s `llama-server --embeddings` endpoint. No env required. Optional `LLAMA_SERVER_BASE_URL` (default `http://localhost:8080/v1`) and `LLAMA_SERVER_API_KEY`.

User-driven models: launch llama-server with `--model <gguf-path> --embeddings`, then run `gbrain init --embedding-model llama-server:<your-id> --embedding-dimensions <N>`. The recipe refuses the implicit shorthand `--model llama-server` because there's no canonical first model.

### LiteLLM proxy (universal escape hatch)

Run [LiteLLM](https://docs.litellm.ai/docs/proxy/quick_start) in front of any provider — Bedrock, Vertex, Cohere, Jina, Fireworks, OctoAI, etc. The proxy normalizes everything to the OpenAI-compatible API; gbrain points at the proxy via `LITELLM_BASE_URL` and proxies the call.

This is the catch-all for "my provider isn't in the list above." Set up LiteLLM, then `gbrain init --embedding-model litellm:<your-model-id> --embedding-dimensions <N>`.

## Choosing dimensions

Three numbers matter:
1. **Provider's native dims**: each model has a "true" output dim (e.g. OpenAI `text-embedding-3-large` is 3072 native).
2. **Matryoshka reductions**: most modern providers let you request a smaller vector via the `dimensions` field.
3. **HNSW cap**: pgvector's HNSW index supports up to 2000 dims. Brains above that fall back to exact vector scans (slower but correct; gbrain handles the SQL automatically via `chunkEmbeddingIndexSql` in `src/core/vector-index.ts`).

For most users: **stay at 1024 or 1536**. Bigger isn't better below the noise floor; smaller saves disk + RAM with marginal recall loss on Matryoshka providers.

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

`gbrain doctor` 8c "alternative_providers" surfaces unconfigured providers whose env is already set — useful when you've configured OpenAI but also have e.g. `VOYAGE_API_KEY` exported and want to know you can switch without extra setup.
