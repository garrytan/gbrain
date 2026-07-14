# LiteLLM proxy — run gbrain on any backend (Bedrock, Vertex, Azure, …)

gbrain speaks two model dialects natively: the OpenAI-compatible HTTP shape and
the Anthropic HTTP shape. Some providers — most notably **Amazon Bedrock** —
speak neither (Bedrock uses an AWS-SigV4-signed API). To reach those, run a
[LiteLLM proxy](https://docs.litellm.ai) in front of the provider. LiteLLM
normalizes everything to the OpenAI-compatible `/v1/chat/completions` and
`/v1/embeddings` endpoints, and gbrain points at it.

```
gbrain ──OpenAI-shaped HTTP──▶ LiteLLM (localhost:4000) ──provider-native──▶ backend
```

Two recipes target this:

- **`bedrock`** — a first-class recipe pre-declaring Bedrock's Claude chat
  models and Cohere Embed v4 (with Matryoshka `dims_options`). Use this for
  Bedrock; `gbrain init` needs no `--embedding-dimensions` flag.
- **`litellm`** — the universal bring-your-own-backend recipe for any other
  provider LiteLLM supports. You declare the model id and (for embeddings) the
  dimensions yourself.

---

## Bedrock quick start

### 1. Install LiteLLM

```bash
python3 -m venv ~/.gbrain-litellm/.venv
~/.gbrain-litellm/.venv/bin/pip install 'litellm[proxy]' boto3
```

### 2. Configure AWS credentials

LiteLLM's Bedrock calls use boto3's standard credential chain — the same
credentials your `aws` CLI uses. Make sure a profile (or env vars, or an
instance role) is active and has `bedrock:InvokeModel` for the models you want.

```bash
aws sts get-caller-identity          # confirm you're authenticated
export AWS_REGION=us-west-2          # the region your models are enabled in
```

> Bedrock's short-lived STS tokens expire. If the proxy starts returning
> `The security token included in the request is expired`, refresh your
> credentials and **restart the proxy** so boto3 re-reads them.

### 3. Write the proxy config

Most current Bedrock models are **inference-profile only** — the raw
on-demand ids (`anthropic.claude-opus-4-8`, `cohere.embed-v4:0`) fail with a
`ValidationException`. Use the inference-profile id (the `us.` / `global.`
prefix). List what's active in your region with:

```bash
aws bedrock list-inference-profiles --region "$AWS_REGION" \
  --query "inferenceProfileSummaries[].inferenceProfileId" --output text
```

`~/.gbrain-litellm/config.yaml` — name each route after its inference-profile id
so gbrain's `bedrock:<id>` model strings map 1:1:

```yaml
model_list:
  - model_name: us.anthropic.claude-opus-4-8      # synthesis (gbrain think)
    litellm_params:
      model: bedrock/us.anthropic.claude-opus-4-8
      aws_region_name: us-west-2

  - model_name: us.cohere.embed-v4:0              # embeddings (semantic search)
    litellm_params:
      model: bedrock/us.cohere.embed-v4:0
      aws_region_name: us-west-2

litellm_settings:
  drop_params: true
  request_timeout: 600

general_settings:
  master_key: null    # loopback, unauthenticated. Set a key if you expose it.
```

### 4. Start the proxy

```bash
~/.gbrain-litellm/.venv/bin/litellm \
  --config ~/.gbrain-litellm/config.yaml --host 127.0.0.1 --port 4000 &

# smoke-test both routes
curl -s localhost:4000/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"us.cohere.embed-v4:0","input":"hello"}' | head -c 200
```

### 5. Point gbrain at it

If the proxy isn't on the default `http://localhost:4000`, set
`BEDROCK_PROXY_BASE_URL`. Then:

```bash
gbrain init --pglite \
  --embedding-model bedrock:us.cohere.embed-v4:0 \
  --chat-model bedrock:us.anthropic.claude-opus-4-8
```

> **Wire the synthesis tier too.** `--chat-model` sets the `chat_model` config
> key, but `gbrain think` and query-expansion resolve their model from
> `models.think` and `models.expansion`. Until init sets those automatically,
> set them yourself or synthesis silently falls back to the native-Anthropic
> default (which needs `ANTHROPIC_API_KEY`):
>
> ```bash
> gbrain config set models.think     bedrock:us.anthropic.claude-opus-4-8
> gbrain config set models.expansion bedrock:us.anthropic.claude-opus-4-8
> ```

Verify end-to-end:

```bash
gbrain import ~/notes/
gbrain think "what themes recur across my notes?"
# Footer should read: Model: bedrock:us.anthropic.claude-opus-4-8 | Pages: N | Citations: N
```

---

## Embedding dimensions (Cohere Embed v4)

Cohere Embed v4 is Matryoshka-aware. The `bedrock` recipe defaults to **1536**
and accepts **256 / 512 / 1024 / 1536** via:

```bash
gbrain config set embedding_dimensions 1024   # then re-init to resize the column
```

Changing the embedding dimension invalidates the vector index — re-init the
brain (PGLite) or run the documented `ALTER` recipe (Postgres). See
`docs/embedding-migrations.md`.

---

## Subagents (Minions) on Bedrock-proxied Claude

`gbrain think` synthesis works on any chat provider. The **Minions subagent
loop** is stricter: it hard-pins to native Anthropic (`isAnthropicProvider`)
for stable `tool_use_id` behavior across crashes/replays, and rejects
proxied models by default. To run subagents on Bedrock-proxied Claude, enable
the gateway-native tool loop:

```bash
gbrain config set agent.use_gateway_loop true
```

---

## Generic backends (the `litellm` recipe)

For any non-Bedrock backend LiteLLM supports, use the universal recipe. Because
the model list and dimensions are backend-specific, you declare them:

```bash
# example: an OpenAI-compatible embedding model behind LiteLLM
gbrain init --pglite \
  --embedding-model litellm:my-embed-model --embedding-dimensions 1024 \
  --chat-model litellm:my-chat-model
```

Set `LITELLM_BASE_URL` if the proxy isn't on `http://localhost:4000`, and
`LITELLM_API_KEY` if you gave the proxy a `master_key`.
