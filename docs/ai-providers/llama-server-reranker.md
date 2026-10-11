# llama-server reranker (local) — Qwen3-Reranker and compatible endpoints

[`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
is the HTTP wrapper that ships with llama.cpp. With `--reranking`, it
exposes an OpenAI-style `POST /v1/rerank` endpoint that returns
`{results: [{index, relevance_score}]}` — exactly the wire shape gbrain
supports for cross-encoder rerankers. The
`llama-server-reranker` recipe routes
`gateway.rerank()` at your local llama.cpp instance.

One supported local model family:

- **Qwen3-Reranker** (0.6B / 4B / 8B) — open-weight cross-encoder. Qwen
  publishes official GGUFs for its EMBEDDING models but not for the
  rerankers. Use the llama.cpp maintainers' 0.6B build, or convert the
  official weights yourself (step 2). Some community conversions drop the
  classifier head and score every passage near zero.

This recipe is the path override + recipe shape. Any provider whose
request/response wire matches llama.cpp can use it by just pointing
at a different base URL. A provider whose request differs only in the
top-N key declares it via the recipe's `top_param` — that's how the
hosted Voyage reranker recipe (`voyage:rerank-2.5`, the new-install
default, `top_k`) works. On the response side the gateway parser accepts
both known array keys (`results[]` for llama.cpp, `data[]` for
Voyage's REST — the shared item shape is `{index, relevance_score}`);
a genuinely different item shape needs its own recipe with adapter hooks.

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

Default: the llama.cpp maintainers' conversion of Qwen3-Reranker-0.6B
(`ggml-org` on Hugging Face):

```bash
huggingface-cli download \
  ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF qwen3-reranker-0.6b-q8_0.gguf \
  --local-dir ./models
```

(`llama-server -hf ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` downloads and
serves it in one step.)

For 4B or 8B there is no maintainers' build. Convert the official
`Qwen/Qwen3-Reranker-4B` (or `-8B`) weights yourself with llama.cpp's
`convert_hf_to_gguf.py`, then quantize with `llama-quantize` (Q4_K_M is the
usual CPU choice).

> **Check a GGUF before you trust it.** A conversion without the
> classifier tensor (`cls.output.weight`) loads and answers, but every
> score is meaningless (around 1e-28 in the llama.cpp issue tracker). List
> the tensors with the dump script in llama.cpp's `gguf-py`
> (`python gguf-py/gguf/scripts/gguf_dump.py ./models/<file>.gguf | grep cls.output`)
> and expect a match. `gbrain models doctor` also catches it (step 5).

### 3. Launch llama-server with --reranking AND --alias

```bash
./build/bin/llama-server \
  --model ./models/qwen3-reranker-0.6b-q8_0.gguf \
  --alias qwen3-reranker-0.6b \
  --reranking --pooling rank \
  --port 8081
```

The `--alias` matters: without it, llama-server's `/v1/models` (and the
`model` field rerank requests echo) defaults to the full gguf file
path, which makes the gbrain config string ugly and brittle. With
`--alias qwen3-reranker-0.6b`, your config string is short and stable.
`--pooling rank` selects the reranking head explicitly.

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
gbrain config set search.reranker.model llama-server-reranker:qwen3-reranker-0.6b
gbrain config set search.reranker.enabled true
```

The `qwen3-reranker-0.6b` after the colon is your `--alias` value from
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
# Expect: ✔ reranker_config llama-server-reranker:qwen3-reranker-0.6b ok
#         ✔ reranker_config llama-server-reranker:qwen3-reranker-0.6b ok (reachable; ranks a relevant passage above an unrelated one)

gbrain search "some query" --json | jq '.[].rerank_score'
# Expect: rerank_score on every row
```

The reachability probe sends one question with a relevant and an
unrelated passage. If it reports `config` ("scores an unrelated passage as
high as a relevant one"), the server answers but the model can't rank:
usually a broken conversion. Replace the GGUF (step 2).

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

## Document size

Every document handed to the reranker is capped before the call: about 1,400
estimated tokens (a 6,000-character cut first, then a shrink by measured
token ratio), always on a UTF-8-safe boundary so a lone surrogate never turns
a 500 into a 400. Prose chunks (~300 words) pass through untouched; code or
CJK chunks at the chunker ceiling lose part of their tail before scoring, the
same trade the embed side already makes. The cap exists because a
chunker-ceiling chunk plus the query plus the server-side reranker template
does not fit llama-server's default 2048 ubatch, and a pooled self-hosted
reranker answered that overflow with a 500 that `applyReranker` fails open
on, silently serving raw RRF order. It applies to every provider, hosted
included, and has no config knob.

## Budget caps + local rerank

The recipe declares `cost_per_1m_tokens_usd: 0` and registers under
`FREE_LOCAL_RERANK_PROVIDERS` in the budget tracker, so
`--max-cost`-bounded callers (autopilot loops, batch jobs) do NOT
hard-fail when configured for local rerank. Local rerank costs
electricity, not API tokens.

```bash
GBRAIN_MAX_USD=0.01 gbrain search "..." --reranker llama-server-reranker:qwen3-reranker-0.6b
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
