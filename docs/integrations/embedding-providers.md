# Embedding Providers

Cortex supports hosted and self-managed embedding providers for tenant search.
Production SaaS tenants should configure providers through environment secrets,
deployment config, or tenant admin workflows; local development brains can still
use the same provider recipes through the Cortex CLI.

## Quick Start

```bash
cortex providers list
cortex providers env <provider-id>
cortex providers test --model openai:text-embedding-3-large
```

For a hosted tenant, set the provider keys in the deployment secret manager and
run the SaaS preflight before exposing the tenant.

```bash
bun run scripts/saas-preflight.ts --json
```

## Provider Matrix

| Provider | Env vars | Default dims | Notes |
| --- | --- | --- | --- |
| `zeroentropyai` | `ZEROENTROPY_API_KEY` | 2560 | Strong default for hosted company-brain retrieval and reranking. |
| `openai` | `OPENAI_API_KEY` | 1536 | Broad compatibility. |
| `openrouter` | `OPENROUTER_API_KEY` | 1536 | One key for many hosted models. |
| `voyage` | `VOYAGE_API_KEY` | 1024 | Strong retrieval quality; includes code and multimodal options. |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | 768 | Low-cost hosted option. |
| `azure-openai` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | 1536 | Enterprise tenancy and data-residency fit. |
| `dashscope` | `DASHSCOPE_API_KEY` | 1024 | Alibaba endpoint support. |
| `zhipu` | `ZHIPUAI_API_KEY` | 1024 | BigModel endpoint support. |
| `ollama` | Optional `OLLAMA_BASE_URL` | model-specific | Local development or self-managed deployment. |
| `llama-server` | Optional `LLAMA_SERVER_BASE_URL` | user-set | Self-managed `llama.cpp` endpoint. |
| `litellm` | `LITELLM_BASE_URL`, optional `LITELLM_API_KEY` | user-set | Proxy escape hatch for other providers. |

## Recommended Defaults

- Cost-sensitive hosted tenants: ZeroEntropy embeddings with ZeroEntropy
  reranking.
- Enterprise OpenAI procurement: Azure OpenAI.
- Code-heavy sources: Voyage code embeddings.
- Self-managed deployments: llama-server or Ollama, with explicit model and
  dimension selection.
- Provider fan-out: OpenRouter or LiteLLM proxy.

## Switching Providers

Embedding dimensions are baked into the database schema. Changing to a model
with a different dimension requires the migration recipe in
[Switching Embedding Models Or Dimensions](../embedding-migrations.md).

For hosted Postgres/Supabase tenants, schedule a maintenance window, back up the
tenant database, run the SQL column migration, and re-embed.

For local PGLite development brains:

```bash
cortex reinit-pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 1280
```

## Agent Guidance

Agents can inspect provider readiness with `cortex providers list` and
`cortex providers test`, but they should not rotate a production tenant's
provider or embedding dimensions without an operator-approved maintenance plan.

When a provider fails quota or auth checks, surface the failure and the affected
tenant/source. Do not silently mix vectors from different providers in the same
embedding column.
