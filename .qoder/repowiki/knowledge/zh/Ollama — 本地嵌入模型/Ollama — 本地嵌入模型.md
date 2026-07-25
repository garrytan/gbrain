---
kind: external_dependency
name: Ollama — 本地嵌入模型
slug: ollama
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Ollama
- 角色：本地运行的嵌入模型服务，无需 API key，适合离线/隐私敏感场景。
- 模型：`nomic-embed-text`（768d，推荐）、`mxbai-embed-large`（1024d）、`all-minilm`（384d）。
- 连接：可选 `OLLAMA_BASE_URL`（默认 `http://localhost:11434/v1`）和 `OLLAMA_API_KEY`（认证部署）。
- 注意：因无必需 API key，不会参与 env 自动检测，需显式 `--embedding-model ollama:<model>` 指定。