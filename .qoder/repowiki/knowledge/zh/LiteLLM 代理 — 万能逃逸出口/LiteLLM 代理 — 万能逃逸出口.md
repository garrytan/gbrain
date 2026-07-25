---
kind: external_dependency
name: LiteLLM 代理 — 万能逃逸出口
slug: litellm
category: external_dependency
category_hints:
    - vendor_identity
    - sdk_real_api
scope:
    - '**'
---

### LiteLLM 代理
- 角色：在 gbrain 前面运行 LiteLLM 代理，将 Bedrock、Vertex、Cohere、Jina、Fireworks、OctoAI 等 100+ 提供商统一为 OpenAI 兼容 API，gbrain 通过 `LITELLM_BASE_URL` 指向代理。
- 用法：`gbrain init --embedding-model litellm:<your-model-id> --embedding-dimensions <N>`。
- 适用场景：当所需提供商不在内置列表中时的 catch-all 方案。