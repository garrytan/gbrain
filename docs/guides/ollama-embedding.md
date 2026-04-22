# Ollama Embedding Configuration Guide

Use local Ollama as gbrain's embedding backend, no OpenAI API key required.

## Supported Models

Ollama supports any embedding model that implements the `/v1/embeddings` API:

- `qwen3-embedding:latest` - Qwen3 embedding, 32-4096 configurable dimensions
- `mxbai-embed-large:latest` - Mxbai embedding
- `bge-m3:latest` - BGE M3 embedding

## Environment Variables

Add to `~/.zshrc` or `~/.bashrc`:

```bash
# Ollama embedding configuration for gbrain
export GBRAIN_EMBEDDING_BASE_URL="http://localhost:11434/v1"
export GBRAIN_EMBEDDING_MODEL="qwen3-embedding:latest"
export GBRAIN_EMBEDDING_DIMENSIONS="1536"
export GBRAIN_EMBEDDING_API_KEY=""  # Ollama doesn't need a key, but OpenAI SDK requires non-empty
```

## Dimension Settings

### qwen3-embedding

qwen3-embedding supports any dimension from 32 to 4096.

**Recommended settings:**

| Use case | Dimensions | Notes |
|----------|------------|-------|
| gbrain default | 1536 | Matches OpenAI text-embedding-3-large |
| High precision | 4096 | Maximum dimension, best quality, more storage |
| Resource saving | 1024 | Minimum recommended, fastest |

```bash
# gbrain default (1536)
export GBRAIN_EMBEDDING_DIMENSIONS="1536"

# Maximum precision (4096)
export GBRAIN_EMBEDDING_DIMENSIONS="4096"
```

Verify dimensions:
```bash
curl http://localhost:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-embedding:latest","input":"test","dimensions":1536}' \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data'][0]['embedding']))"
```

## Ollama Service

Ensure Ollama service is running:

```bash
# Start Ollama service (macOS)
ollama serve

# Verify service status
curl http://localhost:11434/api/tags
```

## Usage

### CLI Usage

```bash
# Write page (via stdin)
echo "# My Page

Content here." | gbrain put my-page

# Keyword search
gbrain search "keyword"

# Vector query
gbrain query "natural language question"
```

### Claude Code MCP

Configure gbrain MCP server:

```bash
claude mcp add gbrain -- sh -c "GBRAIN_DB=~/.gbrain/brain.pglite bun run /path/to/gbrain/src/cli.ts serve"
```

## Troubleshooting

### Embedding fails

1. Verify Ollama service is running:
   ```bash
   curl http://localhost:11434/api/tags
   ```

2. Check environment variables:
   ```bash
   echo $GBRAIN_EMBEDDING_BASE_URL
   echo $GBRAIN_EMBEDDING_MODEL
   ```

3. Test API directly:
   ```bash
   curl http://localhost:11434/v1/embeddings \
     -d '{"model":"qwen3-embedding:latest","input":"hello"}'
   ```

### Dimension mismatch

If you see `expected 1536 dimensions, not X` error:
- Check `GBRAIN_EMBEDDING_DIMENSIONS` environment variable
- Verify Ollama model supports the configured dimension
- qwen3-embedding supports 32-4096

### API Key error

Ollama doesn't need an API key, but OpenAI SDK requires a non-empty value:
```bash
export GBRAIN_EMBEDDING_API_KEY=""  # Must be set, even if empty
```
