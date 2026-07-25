---
kind: external_dependency
name: Zhipu AI（智谱）— 中国区域嵌入
slug: zhipu-ai
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Zhipu AI (BigModel)
- 角色：提供 embedding-3（Matryoshka 256-2048 维）和 embedding-2 嵌入模型。
- 维度约束：默认 1024 维（HNSW 兼容）；2048 维可行但落入精确扫描分支。
- 环境：`ZHIPUAI_API_KEY`。