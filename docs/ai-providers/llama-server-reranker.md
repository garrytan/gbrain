# llama-server reranker (local) — Qwen3-Reranker, self-hosted ZE, any ZE-wire-shape provider

[`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
is the HTTP wrapper that ships with llama.cpp. With `--reranking`, it
exposes an OpenAI-style `POST /v1/rerank` endpoint that returns
`{results: [{index, relevance_score}]}` — exactly the wire shape gbrain
already drives for ZeroEntropy's hosted reranker. The
`llama-server-reranker` recipe (added in v0.40.6.1) routes
`gateway.rerank()` at your local llama.cpp instance instead of ZE.

Two flavors of "local" this recipe covers:

- **Qwen3-Reranker** (0.6B / 4B / 8B) — open-weight cross-encoder; pull
  the GGUF from HuggingFace and serve.
- **Self-hosted ZeroEntropy** (`zerank-2`, `zerank-1-small`) — the
  weights are on HuggingFace too. GGUF-convert them and serve them the
  same way. **Quality is not guaranteed to match ZE-hosted:** GGUF
  conversion + quantization + pooling/rank metadata + tokenizer special
  tokens all affect scores. If you self-host ZE for production
  retrieval, pin your own brain-relevant eval (
  [docs/eval-bench.md](../eval-bench.md)) as a regression guard.

This recipe is the path override + recipe shape. Any provider whose
request/response wire matches ZE/llama.cpp can use it by just pointing
at a different base URL. Providers whose wire shape differs (Voyage uses
`top_k` not `top_n`, returns `data[]` not `results[]`) need a separate
recipe with adapter hooks — that lands in a follow-up plan.

## Setup

### 1. Build llama.cpp (or download a release)

```bash
# Clone and build (CPU only; add `-DGGML_CUDA=ON` for GPU)
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
cmake -B build
cmake --build build --config Release -j
```

Pin a specific commit when you ship — `llama-server`'s path aliases
(`/rerank`, `/v1/rerank`, `/reranking`, `/v1/reranking`) have shifted
across releases. The recipe sends to `/v1/rerank`.

### 2. Pull a reranker GGUF

For Qwen3-Reranker-4B (quantized Q4_K_M is the sweet spot for CPU):

```bash
# Pick a quant level — Q4_K_M is the usual CPU sweet spot.
huggingface-cli download \
  Qwen/Qwen3-Reranker-4B-GGUF qwen3-reranker-4b-q4_k_m.gguf \
  --local-dir ./models
```

For self-hosted ZeroEntropy weights, find a community GGUF conversion
or convert from the HuggingFace weights yourself (out of scope of this
doc — see llama.cpp's `convert_hf_to_gguf.py`).

### 3. Launch llama-server with --reranking AND --alias

```bash
./build/bin/llama-server \
  --model ./models/qwen3-reranker-4b-q4_k_m.gguf \
  --alias qwen3-reranker-4b \
  --reranking \
  --port 8081
```

The `--alias` matters: without it, llama-server's `/v1/models` (and the
`model` field rerank requests echo) defaults to the full gguf file
path, which makes the gbrain config string ugly and brittle. With
`--alias qwen3-reranker-4b`, your config string is short and stable.

`--reranking` and `--embeddings` are mutually exclusive at server
launch. If you also run a local embedder via the
[`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
recipe, run two separate llama-server processes on two different ports
(typically 8080 for embeddings, 8081 for reranking — gbrain's defaults
match that convention).

### 4. Wire gbrain at your server

```bash
# Point gbrain at the llama.cpp host (skip if running locally on default port)
gbrain config set provider_base_urls.llama-server-reranker http://your-host:8081/v1

# Tell search to use this reranker
gbrain config set search.reranker.model llama-server-reranker:qwen3-reranker-4b
gbrain config set search.reranker.enabled true
```

The `qwen3-reranker-4b` after the colon is your `--alias` value from
step 3. Any string works as long as it matches your server's alias.

Env vars work too as an alternative to the config set above:

```bash
export LLAMA_SERVER_RERANKER_BASE_URL=http://your-host:8081/v1
# Optional: if you front llama-server with nginx + bearer auth
export LLAMA_SERVER_RERANKER_API_KEY=your-bearer-token
```

### 5. Verify

```bash
gbrain models doctor
# Expect: ✔ reranker_config llama-server-reranker:qwen3-reranker-4b ok
#         ✔ reranker_config llama-server-reranker:qwen3-reranker-4b ok (reachability)

gbrain search "some query" --json | jq '.[].rerank_score'
# Expect: rerank_score on every row
```

If `gbrain models doctor` reports the reachability probe as `network`
status, two common causes:

1. The server is reachable but in embedding mode, not reranking mode.
   `--reranking` and `--embeddings` are mutually exclusive at launch
   — relaunch the right one.
2. The recipe path doesn't match what your llama.cpp version serves.
   This recipe sends `/v1/rerank`; older llama.cpp installs may only
   serve `/rerank`. Pin to a recent llama.cpp commit.

## Cold-start headroom

CPU-only first-call warmup on a 4B reranker can take 8-15 seconds. The
recipe declares `default_timeout_ms: 30000` so the first call after a
server restart doesn't fail-open silently. That value flows through
search-mode resolution unless you override it:

```bash
# Tighten or loosen per-search timeout (overrides recipe default):
gbrain config set search.reranker.timeout_ms 60000
```

Per-call overrides in `SearchOpts.reranker_timeout_ms` still win for
any single call.

## Budget caps + local rerank

The recipe declares `cost_per_1m_tokens_usd: 0` and registers under
`FREE_LOCAL_RERANK_PROVIDERS` in the budget tracker, so
`--max-cost`-bounded callers (autopilot loops, batch jobs) do NOT
hard-fail when configured for local rerank. Local rerank costs
electricity, not API tokens.

```bash
GBRAIN_MAX_USD=0.01 gbrain search "..." --reranker llama-server-reranker:qwen3-reranker-4b
# Works: rerank fires, recorded at $0, cumulative cap untouched.
```

## Fail-open contract preserved

`applyReranker` in `src/core/search/rerank.ts` still has the
fail-open posture: any error class (network, timeout, malformed
response) logs to `~/.gbrain/audit/rerank-failures-*.jsonl` and
returns the original RRF order unchanged. Search reliability beats
reranker quality. If your llama.cpp host goes down, your searches keep
working — they just stop ranking against the cross-encoder until you
restart the server.
