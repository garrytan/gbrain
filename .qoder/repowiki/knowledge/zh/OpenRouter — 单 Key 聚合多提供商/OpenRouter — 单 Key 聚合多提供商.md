---
kind: external_dependency
name: OpenRouter — 单 Key 聚合多提供商
slug: openrouter
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### OpenRouter
- 角色：单一 OpenAI 兼容 API，聚合 OpenAI、Anthropic、Google、DeepSeek、Meta Llama、Qwen 等数十家托管模型，一个 key 访问多个 provider。
- 认证：`OPENROUTER_API_KEY`；可选 `OPENROUTER_BASE_URL` 指向自托管 OR 兼容代理；推荐设置 `OPENROUTER_REFERER` 和 `OPENROUTER_TITLE` 以便 attribution。
- 子代理循环限制：gbrain 的子代理基础设施硬编码要求 Anthropic-direct（稳定 `tool_use_id`），OR 代理的 Anthropic 模型在提交时被拒绝——OR 仅用于 chat，subagent 仍需直连 Anthropic key。
- 嵌入：`openai/text-embedding-3-small`（1536d，Matryoshka 至 512/768/1024），也支持 qwen/qwen3-embedding-8b、bge-m3 等。