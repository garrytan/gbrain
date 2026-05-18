---
title: Frontmatter 格式規範
type: convention
tags: ["convention", "frontmatter"]
source: agent
---

# Frontmatter 格式規範

## 標準格式

```yaml
---
title: 頁面標題
type: concept | analysis | guide | writing | task | log | status | convention
tags: [source:ai, topic-tag]
source: ai
ai_confidence: high | medium | low
created: YYYY-MM-DD
---
```

## ai_confidence 判斷標準

| 等級 | 條件 |
|------|------|
| `high` | 基於腦庫內 3+ 頁交叉確認 |
| `medium` | 腦庫內 1-2 頁 + 自身知識 |
| `low` | 純自身知識，腦庫內無資料 |

## Slug 路徑分類

| 路徑前綴 | 用途 |
|---------|------|
| `wiki/analysis/` | AI 分析報告 |
| `wiki/summary/` | AI 摘要 / 多頁整合 |
| `wiki/index/` | 主題索引頁（解 orphan 最快方式）|
| `wiki/draft/` | AI 草稿，待人類 review |
| `wiki/identity/` | 實體定義（人工維護，**AI 唯讀**）|
| `wiki/status/` | 狀態與進度追蹤（活文件）|
| `wiki/conventions/` | 規範與慣例（活文件）|
| `wiki/workflow/` | 工作流程定義 |
| `mem/` | 個人筆記、進度記錄 |

## 必要 Tag

- `source:ai` — 所有 AI 寫入的頁面必加
- `source:original` — 原創內容
- `source:external` — 外部資料整理
- `source:mixed` — 混合來源
