---
kind: external_dependency
name: 阿里云 DashScope（灵积）— 中国区域嵌入/聊天
slug: dashscope
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Alibaba DashScope (灵积)
- 角色：Alibaba 的 OpenAI 兼容 API，提供 text-embedding-v3（Matryoshka 64-1024 维）及 Qwen 系列聊天模型。
- 区域约束：国际端点 `dashscope-intl.aliyuncs.com/compatible-mode/v1` 为默认；中国区用户通过 `provider_base_urls['dashscope']` 覆盖为 `https://dashscope.aliyuncs.com/...`。
- CJK 优化：`chars_per_token: 2` 使批处理预分片为中文内容留出余量。
- 批量限制：每批最多 10 个条目（硬限，不受 token 数影响）。
- 环境：`DASHSCOPE_API_KEY`。