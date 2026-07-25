---
kind: external_dependency
name: llama.cpp llama-server — 本地 GGUF 推理
slug: llama-server
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### llama.cpp llama-server
- 角色：`llama.cpp` 的 `llama-server --embeddings` 端点，完全本地运行任何 GGUF 模型。
- 连接：可选 `LLAMA_SERVER_BASE_URL`（默认 `http://localhost:8080/v1`）和 `LLAMA_SERVER_API_KEY`。
- 用法：先启动 `llama-server --model <gguf-path> --embeddings`，再 `gbrain init --embedding-model llama-server:<your-id> --embedding-dimensions <N>`。
- 限制：拒绝隐式简写 `--model llama-server`，因为不存在 canonical first model。