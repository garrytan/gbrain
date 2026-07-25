---
kind: external_dependency
name: Voyage AI — 代码/通用嵌入模型
slug: voyage-ai
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Voyage AI
- 角色：提供 voyage-4 系列（general）、voyage-code-3（代码专用）、voyage-multimodal-3（文本+图像）等嵌入模型，支持 Matryoshka 降维。
- 维度约束：HNSW 上限 2000，2048 维会回退到精确向量扫描（仍正确但更慢）；`VOYAGE_VALID_OUTPUT_DIMS = [256, 512, 1024, 2048]`，超出范围在 embed 边界抛出 `AIConfigError` 并给出 paste-ready 修复命令。
- 代码检索推荐：对源码仓库场景优先 `voyage:voyage-code-3`，`gbrain reindex --code` 运行时会提示当前模型是否代码调优。
- 多模态：`voyage-multimodal-3` 走独立的 `/multimodalembeddings` 端点（非 openai-compatible 路径），需显式配置 `embedding_multimodal_model`。
- 环境：`VOYAGE_API_KEY`；可配合 `LITELLM_BASE_URL` 代理任意后端。