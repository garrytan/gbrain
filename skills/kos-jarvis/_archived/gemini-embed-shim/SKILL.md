---
name: gemini-embed-shim
version: 1.0.0
description: |
  Provider-neutrality adapter. GBrain's src/core/embedding.ts hardcodes
  OpenAI (`new OpenAI()`) for 1536-dim vector generation. Lucien's stack
  uses Gemini embeddings via Google Generative Language API through
  NANO_BANANA_API_KEY. This shim is a tiny local HTTP server that speaks
  OpenAI /v1/embeddings on the client side but calls Gemini
  batchEmbedContents on the backend, preserving the 1536 dimension via
  outputDimensionality. Keeps upstream src/ untouched.
triggers:
  - "run embedding shim"
  - "start gemini shim"
tools: []
mutating: false
---

# Gemini Embed Shim

## Why

GBrain's schema pins `vector(1536)` and the embed client is a direct
`new OpenAI()`. OpenAI embedding API is the only path the vanilla fork
supports. Lucien's environment has no OpenAI key but has
`NANO_BANANA_API_KEY` for Google Gemini. Shim makes Gemini pretend to
be OpenAI for this one contract.

## How

Local bun HTTP server on 7222. OpenAI SDK `new OpenAI({ baseURL })`
reads `OPENAI_BASE_URL` env; we point it at the shim. SDK sends
standard OpenAI embedding request → shim translates to Gemini
batchEmbedContents with `outputDimensionality: 1536` and `taskType:
RETRIEVAL_DOCUMENT` → shim reshapes response to OpenAI format.

## Config

Env at startup:
- `NANO_BANANA_API_KEY` — required. Google Generative Language API key.
- `GEMINI_EMBED_MODEL` — optional, default `gemini-embedding-2-preview`.
- `OPENAI_SHIM_PORT` — optional, default 7222.

Env for gbrain when shim is running:
- `OPENAI_BASE_URL=http://127.0.0.1:7222/v1`
- `OPENAI_API_KEY=stub` (SDK refuses empty; value is ignored by shim)

## Run

```bash
# terminal A — start shim
export NANO_BANANA_API_KEY=<google key>
bun run skills/kos-jarvis/gemini-embed-shim/server.ts

# terminal B — use gbrain
export OPENAI_BASE_URL=http://127.0.0.1:7222/v1
export OPENAI_API_KEY=stub
gbrain embed --all
```

For cutover (Week 4.2), register both the shim and kos-compat-api as
launchd services so they start on boot. See
`_archived/feishu-bridge/SKILL.md` § Cutover checklist for the historical
plist rotation (the cutover itself completed 2026-04 and was later
archived along with the Feishu signal-detector extension on 2026-05-05).

## Dimensions check

Before first `gbrain embed`, confirm Gemini returns 1536-length vectors:
```bash
curl -s -X POST http://127.0.0.1:7222/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"text-embedding-3-large","input":"hello","dimensions":1536}' \
  | jq '.data[0].embedding | length'
# expected: 1536
```

If you see 768 or 3072, the Gemini model ignored `outputDimensionality`
or the API signature changed. Adjust `geminiEmbed()` body accordingly.

## Caveats

- Shim does no retry (gbrain's embedding.ts already does exponential
  backoff 5x with 4s base / 120s cap). Rate limit errors propagate.
- Shim does no batching smarter than 1:1 forwarding. Gemini
  batchEmbedContents supports up to 100 per request; gbrain already
  batches 100, so this matches.
- `taskType: RETRIEVAL_DOCUMENT` is right for ingest; query-time
  embeddings ideally use `RETRIEVAL_QUERY`. GBrain doesn't distinguish
  at the embed layer, so we hard-code DOCUMENT. Minor quality impact
  on query-side semantic match; revisit if recall suffers.
