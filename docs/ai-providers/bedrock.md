# Amazon Bedrock

Use Bedrock when you want AWS-managed auth and model access.

## Requirements

- `AWS_REGION`
- Bedrock model access enabled in that region
- IAM permission for `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`

## Auth

### Explicit keys

```bash
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=***
export AWS_SESSION_TOKEN=***   # optional
```

### IAM role

Set `AWS_REGION` and let the SDK resolve credentials from the environment or instance role.

## Supported models

### Embeddings

- `amazon.titan-embed-text-v2:0` — 256/512/1024/1536 dims
- `amazon.titan-embed-text-v1` — 1536 dims
- `cohere.embed-english-v3`
- `cohere.embed-multilingual-v3`

### Rerank

- `amazon.rerank-v1:0`
- `cohere.rerank-v3-5:0`

### Chat

- `anthropic.claude-sonnet-4-5-20251101-v1:0`
- `anthropic.claude-sonnet-4-6-20260101-v1:0`
- `anthropic.claude-haiku-4-5-20251001-v1:0`
- `us.anthropic.claude-sonnet-4-5-20251101-v1:0`
- `us.anthropic.claude-sonnet-4-6-20260101-v1:0`
- `us.anthropic.claude-haiku-4-5-20251001-v1:0`
- `amazon.nova-pro-v1:0`
- `amazon.nova-lite-v1:0`
- `amazon.nova-micro-v1:0`

## Example

```bash
gbrain config set embedding_model bedrock:amazon.titan-embed-text-v2:0
gbrain config set reranker_model bedrock:amazon.rerank-v1:0
gbrain config set expansion_model bedrock:anthropic.claude-sonnet-4-6-20260101-v1:0
```

## Subagents

`supports_subagent_loop` stays `false` for now. If you want Bedrock-backed tool loops, enable:

```bash
gbrain config set agent.use_gateway_loop true
```

## Troubleshooting

- `AccessDeniedException` → enable the model in the Bedrock console and check IAM.
- `UnrecognizedClientException` / `InvalidSignatureException` → bad or expired AWS credentials.
- `ValidationException: model not found` → wrong model ID or region.
- Endpoint resolution errors → choose a Bedrock-supported `AWS_REGION`.
