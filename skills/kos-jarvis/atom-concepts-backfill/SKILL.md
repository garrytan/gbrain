---
name: atom-concepts-backfill
version: 1.0.0
description: |
  Bridge an upstream gap: extract_atoms never stamps `frontmatter.concepts`
  on page-derived atoms, but synthesize_concepts consumes ONLY that field —
  so concept synthesis is permanently skipped ("no atoms with concept
  refs"). This script batch-labels atoms lacking the field with 1-3
  kebab-case shared-vocabulary topic labels (sonnet) and stamps them, so
  upstream synthesize_concepts can tier + materialize concepts/<label>
  pages. Idempotent: only touches atoms WITHOUT `concepts`; safe to rerun
  after each extract_atoms drain. Retires when the upstream fix lands.
triggers:
  - "atom concepts backfill"
  - "backfill atom concepts"
  - "concepts backfill"
mutating: true
---

# atom-concepts-backfill — bridge for the extract_atoms → synthesize_concepts gap

## 上游断点（2026-06-11 定位，gbrain v0.42.37.0/v0.42.38.0）

- `src/core/cycle/synthesize-concepts.ts` 头注释（设计意图）："when the
  Haiku 3-check from extract_atoms decides 'this atom is about concept X',
  it stamps the field" — `:92` 只消费 `frontmatter.concepts`。
- `src/core/cycle/extract-atoms.ts` 的 page 提取路径**从不写**该字段
  （只写 type/atom_type/lesson/source_hash/source_quote/virality_score/
  emotional_register）。
- 结果：所有 page-derived atoms 永远进不了 concept 合成（生产实证：696
  atoms / 0 含 concepts / synthesize_concepts 连续 skip）。
- 上游 issue 已起草（见 TODO）；本脚本为 fork 侧桥接，上游修复后自动
  退场（届时新 atoms 自带 concepts，本脚本查询恒为空集）。

## 用法

```bash
# 必须从 repo root 跑（bun 自动加载 .env.local 的 crs 代理 key/base）。
# Claude Code shell 注入的 ANTHROPIC_BASE_URL 会覆盖 .env.local 并破坏
# key/base 配对 —— 先 unset（见 memory: pitfall-anthropic-base-url）。
unset ANTHROPIC_BASE_URL

bun run skills/kos-jarvis/atom-concepts-backfill/run.ts              # dry-run（只打标签分布，不写库）
bun run skills/kos-jarvis/atom-concepts-backfill/run.ts --limit 60 --apply   # 试点
bun run skills/kos-jarvis/atom-concepts-backfill/run.ts --apply     # 全量
```

- 默认 dry-run；`--apply` 才写库（jsonb merge `concepts` + `concepts_by`
  审计标记，不动 body/chunks/embedding，无 re-embed 开销）。
- `--limit N` / `--batch N`（默认 40/批）；`KOS_CONCEPTS_MAX_SPEND`
  花费上限（默认 $5）；`KOS_CONCEPTS_MODEL` 模型覆盖（默认
  claude-sonnet-4-6，按 Lucien 2026-06-09 路由：上游设计的 Haiku 档
  → sonnet）。
- 词表跨批次累积并从已 stamp 的 atoms 预热，保证标签聚类（
  synthesize_concepts 需要 ≥2 atoms 同标签才物化 T3 concept 页）。

## 验证回路

1. `--limit 60 --apply` 试点 → 看输出的 "cluster(s) with >=2 atoms"。
2. `unset ANTHROPIC_BASE_URL && ~/.bun/bin/gbrain dream --phase synthesize_concepts --dir ~/brain`
   → 确认 `concepts/<label>` 页出现（`SELECT slug FROM pages WHERE
   frontmatter->>'synthesized_by' LIKE 'synthesize_concepts%'`）。
3. 全量 `--apply`；每次 extract_atoms drain 推进后重跑一次补新增。
