# Local Ollama embeddings via OpenAI-compatible API

## Goal
Run GBrain semantic search against a local Ollama embedding model without changing the current 1536-dimension vector schema.

## When to use this
- You want local embeddings instead of hosted OpenAI embeddings
- You already have an Ollama embedding model on the same machine
- You want `gbrain embed` and `gbrain query` to keep working with the existing OpenAI client path

## Working setup
GBrain's embedding client uses the OpenAI SDK. Ollama exposes an OpenAI-compatible endpoint at `/v1/embeddings`, so the simplest integration is to point GBrain at that endpoint and override the embedding model name.

### Required environment variables

```bash
export OPENAI_API_KEY=dummy
export OPENAI_BASE_URL=http://127.0.0.1:11434/v1
export OPENAI_EMBED_MODEL=qwen3-embedding:4b
export OPENAI_EMBED_DIMENSIONS=1536
```

### Why this works
- `OPENAI_BASE_URL` redirects the OpenAI SDK to Ollama's local OpenAI-compatible server.
- `OPENAI_EMBED_MODEL` tells GBrain which local embedding model to request.
- `OPENAI_EMBED_DIMENSIONS=1536` keeps the returned vectors aligned with the current `vector(1536)` schema used by GBrain.
- `OPENAI_API_KEY` only needs to be non-empty because the OpenAI SDK requires it; Ollama does not validate a real OpenAI key for local calls.

## Important detail: use `/v1/embeddings`, not Ollama's native `/api/embed`
Some Ollama embedding models return their native dimensionality on `/api/embed` (for example, `qwen3-embedding:4b` can return 2560 dimensions). That will not fit GBrain's current schema.

The OpenAI-compatible `/v1/embeddings` endpoint can return 1536-dimensional vectors when the request includes `dimensions: 1536`, which preserves compatibility with the existing schema and search pipeline.

## Verification steps

```bash
# Backfill any missing embeddings
gbrain embed --stale

# Confirm embeddings now exist
gbrain stats

# Run a semantic query
gbrain query "How can AI analysis be made trustworthy for product decisions?"
```

Expected result:
- `Embedded` count increases in `gbrain stats`
- `gbrain query` returns semantically relevant chunks, not just exact keyword matches

## Notes
- Keyword search still works without any embeddings.
- This setup is especially useful for local-first PGLite installs.
- If you switch to a different local embedding model, make sure it can return 1536 dimensions or update the schema and migration path accordingly.
