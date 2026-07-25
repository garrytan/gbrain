---
kind: external_dependency
name: PGLite — 嵌入式 Postgres（WASM）
slug: pglite
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### PGLite
- 角色：Postgres 17 的 WASM 嵌入式实现，零配置、零服务器，个人脑（≤~50K 页）默认引擎。
- 特性：与真实 Postgres 共享 SQL 方言，通过 `BrainEngine` 接口与 PostgresEngine 对齐 ~47 个操作。