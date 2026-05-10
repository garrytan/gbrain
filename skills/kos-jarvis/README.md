---
name: kos-jarvis
description: |
  Lucien's KOS-flavored extensions on top of GBrain. DIKW compilation,
  E0-E4 evidence levels, confidence scoring, link-quality rules, the
  9 KOS page types (source/entity/concept/project/decision/synthesis/
  comparison/protocol/timeline) as augmentations to GBrain's 20-dir MECE,
  daily lint/patrol, and the MEMORY reflux bridge to OpenClaw.
type: extension-pack
owner: lucien
upstream_compat: garrytan/gbrain >= 0.31.2 (last verified 2026-05-09)
---

# kos-jarvis — KOS extension pack over GBrain

Lucien 从 `ChenyqThu/jarvis-knowledge-os` (KOS v1, Python/Shell) 迁移到
GBrain fork 时带过来的**质量管控 + 编译深度**定制层。所有扩展都驻扎在
`skills/kos-jarvis/` 一个目录内，**不修改 upstream src/ 或其他 skills/**，
以便长期跟随 `garrytan/gbrain` upstream merge 而不产生冲突。

## 为什么存在

GBrain 的核心哲学是 Thin Harness, Fat Skills。其原生能力覆盖实体富化、
被动信号捕获、MCP 暴露——这些 KOS v1 没有，是迁移的首要动机。但 GBrain
不覆盖这些 KOS v1 已有的能力：

| KOS v1 独有 | GBrain 无 | 本 pack 提供 |
|------------|----------|-------------|
| DIKW 编译管道（Data → Information → Knowledge → Wisdom） | brain-ops 是内循环 | `dikw-compile/` |
| Evidence Levels E0-E4 | `confidence=high/med/low` 即止 | `evidence-gate/` |
| 编译评分 A/B/C/F | 无质量评分 | `confidence-score/` |
| kos lint 六项检查 | `maintain/` 有部分 | `kos-lint/` |
| kos patrol 巡检 + 缺口检测 | `maintain/` 覆盖一半 | `kos-patrol/` |
| 9 种页面类型（作为 kind 字段约束） | 20-dir MECE（作为目录约束） | `templates/` + `type-mapping.md` |
| MEMORY 回流到 OpenClaw `MEMORY.md` | 无 | `digest-to-memory/` |
| Notion 实时增量摄入 | 仅一次性 migrate | `notion-ingest-delta/` |
| 批量 86 页实体抽取 + stub 自动生成(G1 主收益) | `enrich/` 是单实体交互式 | `enrich-sweep/` |
| ~~飞书消息通道 / 实体捕获队列~~ | ~~无~~ | ~~`feishu-bridge/` + `pending-enrich/`~~ → 归档 2026-05-05 |

## 目录结构（计划）

```
skills/kos-jarvis/
├── README.md                       # 本文件
├── PLAN-ADJUSTMENTS.md             # 迁移期间发现的计划偏差记录
├── type-mapping.md                 # KOS 9 types ↔ GBrain 20 dirs 映射
├── templates/                      # 9 种 KOS 页面模板（Week 1 搬运）
│   ├── source-page.md
│   ├── entity-page.md
│   ├── concept-page.md
│   ├── project-page.md
│   ├── decision-page.md
│   ├── synthesis-page.md
│   ├── comparison-page.md
│   ├── protocol-page.md
│   └── timeline-page.md
├── kos-patrol/                     # Week 2(phase 2 lint 已 noop,kos-lint archived 2026-05-10)
├── digest-to-memory/               # Week 3(保留澄清点)
├── notion-ingest-delta/            # Week 3 — SKILL.md 是 redirect,实现在 workers/notion-poller/
├── gemini-embed-shim/              # Week 4 — OpenAI→Gemini embed 桥接(M3 退役 in flight)
├── enrich-sweep/                   # Phase 3 (2026-04-17) — G1 主收益
└── _archived/                      # 退役 dirs(只读冷备)
    ├── feishu-bridge/              # 2026-05-05 — OpenClaw 飞书 command-mapping
    ├── pending-enrich/             # 2026-05-05 — Phase 2↔3 Feishu 队列 schema
    ├── kos-lint/                   # 2026-05-10 (M1) — 4/6 check 已被 frontmatter-guard + gbrain doctor + BrainWriter linkValidator + gbrain orphans 覆盖
    ├── frontmatter-ref-fix/        # 2026-05-10 (M1) — one-shot 已用完(2026-04-27 v1+v2,ERRORs 4→0)
    ├── slug-normalize/             # 2026-05-10 (M1) — one-shot 已用完(2026-04-23,7 strays renamed)
    ├── dikw-compile/               # 2026-05-10 (M2-A) — production dead code(0/2477 pages set dikw_layer);上游 `gbrain dream` + concept-synthesis 替代
    ├── evidence-gate/              # 2026-05-10 (M2-A) — production dead code(1/2477 pages set evidence_level)
    └── confidence-score/           # 2026-05-10 (M2-A) — confidence 字段被 kos-compat-api.ts 硬编码模板,不是脚本算的
```

## 与 GBrain 原生 skills 的关系

- **依赖**：`brain-ops`, `enrich`, `migrate`, `query`, `maintain`, `signal-detector`
- **追加触发**：DIKW compile 在 `ingest-pipeline` 后追加一步（强关联 > 弱覆盖检查）
- **不覆盖**：本 pack 不替换原生 skills；在 GBrain upstream 行为之上做 opt-in 校验

## 升级策略

1. `git fetch upstream && git merge upstream/master`
2. 冲突面：仅当 upstream 动 `skills/RESOLVER.md` 的公共表格时。本 pack 只
   追加 RESOLVER 扩展段（文件末尾 `## KOS-Jarvis extensions` 下），不动
   upstream 内容
3. 每月对 upstream CHANGELOG.md 做一次 review，评估是否有 upstream 新能力
   可以替代本 pack 某一项扩展（扩展应随时间自愿退场，而非永久膨胀）

## 当前状态(2026-04-17)

- [x] Week 1: Fork,v1-frozen tag,bun install,gbrain init,5 页 import 冒烟(frontmatter 保真 100%)
- [x] Week 2: 5 个核心 skill 移植
- [x] Week 3: 桥接层(kos-worker、飞书、Notion delta、MEMORY 回流)
- [x] Week 4: 85 页全量 + 7 天双读验证(Phase 1 观察 gate 已过)
- [x] Phase 2+3 wave(2026-04-17):enrich-sweep 脚手架 + pending-enrich 队列 schema
      + kos-patrol/run.ts(P0) + Feishu signal-detector 集成文档
- [ ] Phase 3 live run:Lucien 导出 `ANTHROPIC_API_KEY` + `TAVILY_API_KEY` 后跑
      `bun run skills/kos-jarvis/enrich-sweep/run.ts --plan`,review 后真跑
- [x] Phase 2 OpenClaw 侧落地:**退役 2026-05-05** — Feishu signal-detector
      extension(`~/.openclaw/extensions/jarvis-feishu-signal-detector/`)
      虽然实际已部署,但下游 `enrich-sweep` 没在 cron 上消费 `pending-enrich`
      队列,extension 在产生 garbage。决议:删 extension 硬拷贝(独立 repo
      `~/Projects/jarvis-feishu-signal-detector/` 保留作冷备),brain-side
      contract docs 归档至 `_archived/feishu-bridge` + `_archived/pending-enrich`。
- [ ] Phase 4 日历导入(下一 wave)
- [ ] Phase 5 邮件导入(再下一 wave)

详见:
- 迁移源 plan:`/Users/chenyuanquan/.claude/plans/docs-gbrain-vs-kos-analysis-md-gbrain-parsed-candle.md`
- 后续五阶段 roadmap:`docs/JARVIS-NEXT-STEPS.md`
- 本 wave 执行计划:`/Users/chenyuanquan/.claude/plans/docs-jarvis-next-steps-md-review-validated-pond.md`
