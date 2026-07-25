---
kind: external_dependency
name: Supabase — 托管 Postgres + pgvector
slug: supabase
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Supabase
- 角色：托管 Postgres + pgvector 数据库，面向共享/大规模/多机部署。
- 交易池模式：Supabase 的 session-mode pooler 与事务池器拓扑差异导致多次升级失败（#699, #820 历史），需要针对 transaction pooler + statement_timeout 的测试夹具。
- 迁移：从 PGLite 迁移到 Supabase 通过 `gbrain migrate --to supabase`。