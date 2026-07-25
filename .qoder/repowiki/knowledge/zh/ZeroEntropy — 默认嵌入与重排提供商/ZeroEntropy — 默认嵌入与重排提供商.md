---
kind: external_dependency
name: ZeroEntropy — 默认嵌入与重排提供商
slug: zeroentropy
category: external_dependency
category_hints:
    - vendor_identity
    - framework_behavior
scope:
    - '**'
---

### ZeroEntropy
- 集成点：`src/core/ai/recipes/zeroentropyai.ts` 声明 embedding + reranker 两个 touchpoint；`gateway.ts` 通过 `zeroEntropyCompatFetch` 重写 URL `/embeddings → /models/embed`、注入 `input_type`、改写响应体以适配 SDK schema。
- 配置：`ZEROENTROPY_API_KEY` 环境变量；可通过 `gbrain config set search.reranker.model zeroentropyai:zerank-2` 切换重排模型。
- 注意：ZE 的 base_url_default 已带 `/v1`，URL 重写后不会重复拼接成 `/v1/v1/…`，由回归测试锁定。