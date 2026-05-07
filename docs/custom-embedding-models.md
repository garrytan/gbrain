# Custom Embedding Models

GBrain defaults to OpenAI's `text-embedding-3-large` (1536d). You can use any OpenAI-compatible embedding endpoint.

## Quick Start

```bash
# Init with a custom model
export LITELLM_API_KEY="sk-..."
gbrain init --embedding-model litellm:Qwen3-Embedding-8B --embedding-dimensions 4096
```

## Configuration

Add to `~/.gbrain/config.json`:

```json
{
  "embedding_model": "litellm:your-model-name",
  "embedding_dimensions": 4096,
  "provider_base_urls": {
    "litellm": "https://your-proxy.example.com/v1"
  }
}
```

Set the API key via environment variable:

```bash
export LITELLM_API_KEY="sk-..."
```

## Supported Providers

| Provider | Prefix | Example |
|----------|--------|---------|
| OpenAI | `openai:` | `openai:text-embedding-3-large` |
| LiteLLM Proxy | `litellm:` | `litellm:Qwen3-Embedding-8B` |
| Google | `google:` | `google:gemini-embedding-001` |

For `litellm:` and other `openai-compatible` providers, you **must** set `provider_base_urls` so GBrain knows where to send requests.

## Environment Variable Overrides

These take precedence over `config.json`:

```bash
export GBRAIN_EMBEDDING_MODEL="litellm:Qwen3-Embedding-8B"
export GBRAIN_EMBEDDING_DIMENSIONS="4096"
export OPENAI_API_KEY="sk-..."        # used by openai: prefix
export LITELLM_API_KEY="sk-..."       # used by litellm: prefix
export ANTHROPIC_API_KEY="sk-ant-..." # used by anthropic: prefix
```

## PGLite Dimension Limits

PGLite's pgvector extension limits HNSW indexes to **2000 dimensions**.

For models that output more (e.g. Qwen3-Embedding-8B at 4096d), GBrain automatically skips the HNSW index and uses sequential scan. This is fine for small brains (< 1000 pages). The performance difference is negligible at this scale.

For production scale with high-dimensional embeddings, migrate to Postgres + Supabase:

```bash
gbrain migrate --to supabase
```

## Troubleshooting

### "Model is not listed for OpenAI embedding"

You're using the `openai:` prefix with a model not in OpenAI's native list. Switch to `litellm:` prefix and set `provider_base_urls`.

### "column cannot have more than 2000 dimensions for hnsw index"

Your embedding model outputs more than 2000 dimensions and you're on PGLite. Make sure you init with the correct dimensions so GBrain skips the HNSW index:

```bash
gbrain init --embedding-model litellm:your-model --embedding-dimensions 4096
```

If you already initialized with the default 1536d, delete `~/.gbrain/brain.pglite` and re-init.

### "Embedding dim mismatch: model returned N but schema expects M"

The model's actual output dimension doesn't match what the schema was created with. Delete the PGLite DB and re-init with the correct `--embedding-dimensions`.
