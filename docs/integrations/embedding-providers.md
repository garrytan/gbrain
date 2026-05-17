# Embedding providers

GBrain ships with 14 embedding-provider recipes covering OpenAI, the major hosted alternatives, three local options, and a universal escape hatch (LiteLLM proxy). Run `gbrain providers list` to see the live registry; `gbrain providers explain --json` emits a machine-readable matrix for agents.

This page is the human-readable counterpart: capability per provider, env-var setup, dimensions, cost, and known constraints.

## Quick start

```
gbrain providers list                          # see all providers
gbrain providers env <provider-id>             # see required env vars
gbrain providers test --model openai:text-embedding-3-large   # smoke-test
gbrain init --pglite --model voyage            # use a non-default provider
```

## TL;DR table

| Provider | env vars | default dims | cost ($/1M tokens) | local? | multimodal? |
|---|---|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | 1536 | 0.13 | no | no |
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

## Decision tree

- **Cost-sensitive, English-only**: Ollama (free, local) or Voyage (paid, best quality per dollar).
- **Quality-first**: Voyage `voyage-4-large` (1024-2048 dims, ~3-4× more dense tokens than OpenAI tiktoken).
- **Reranking pair**: Voyage (their reranker `rerank-2.5` pairs cleanly with Voyage embeddings).
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

### Google Gemini

Set `GOOGLE_GENERATIVE_AI_API_KEY` (the AI Studio public API key). Model: `gemini-embedding-001`. Default 768 dims; Matryoshka up to 3072. Cheap.

For GCP service-account / Vertex AI auth (production deployments), see the v0.32.x follow-up — Vertex ADC is on the roadmap.

### Azure OpenAI

Enterprise OpenAI behind Azure tenancy. Required env: `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` (e.g. `https://my-resource.openai.azure.com`), `AZURE_OPENAI_DEPLOYMENT` (the deployment name from your Azure portal). Optional: `AZURE_OPENAI_API_VERSION` (defaults to `2024-10-21`).

Unlike vanilla OpenAI, Azure uses `api-key:` header (not `Authorization: Bearer`) and a templated URL with `?api-version=` query param — gbrain handles both via the recipe's resolveAuth + resolveOpenAICompatConfig overrides.

Models: `text-embedding-3-large`, `text-embedding-3-small`, `text-embedding-ada-002` (your Azure deployment must serve the requested model).

### MiniMax (海螺AI)

Set `MINIMAX_API_KEY`. Optional `MINIMAX_GROUP_ID` for org-scoped accounts. Model: `embo-01` (1536 dims).

MiniMax's API takes a `type: 'db' | 'query'` field for asymmetric retrieval. v0.32 routes everything as `type='db'` (symmetric retrieval — same vector space for indexing and queries). Asymmetric query support is a v0.32.x follow-up.

### DashScope (Alibaba)

Set `DASHSCOPE_API_KEY`. International endpoint at `dashscope-intl.aliyuncs.com` by default; override `provider_base_urls.dashscope` in `~/.gbrain/config.json` for the China endpoint:

```json
{
  "provider_base_urls": {
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1"
  }
}
```

Models: `text-embedding-v4` (current; Matryoshka 64-2048 dims), `text-embedding-v3` (512/768/1024 dims), `text-embedding-v2`.

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

Three options:

1. **Use LiteLLM proxy** (above) — the universal escape hatch. Works for 100+ providers.
2. **Open a feature request** at [github.com/garrytan/gbrain/issues](https://github.com/garrytan/gbrain/issues) with the provider's API docs URL and a setup snippet. Recipes are ~30-40 lines of TypeScript.
3. **Submit a recipe**: clone, copy `src/core/ai/recipes/voyage.ts` as the gold-standard openai-compat template, register in `src/core/ai/recipes/index.ts`, add a per-recipe smoke test under `test/ai/recipe-<name>.test.ts`. The recipe contract test (`test/ai/recipes-contract.test.ts`) and IRON RULE regression test pin the structural invariants.

## Switching providers on an existing brain

Embedding dimensions are baked into the schema at `gbrain init` time. To change providers post-init, you usually need to re-embed:

1. Update config: `gbrain config set embedding_model <provider>:<model>` and `embedding_dimensions <N>`.
2. Reindex schema if dims changed: `gbrain doctor` will detect the mismatch and print the exact `ALTER TABLE` recipe.
3. Re-embed: `gbrain embed --all` (or `--stale` for incremental).

`gbrain doctor` 8c "alternative_providers" surfaces unconfigured providers whose env is already set — useful when you've configured OpenAI but also have e.g. `VOYAGE_API_KEY` exported and want to know you can switch without extra setup.
