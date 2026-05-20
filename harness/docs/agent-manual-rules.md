---
title: Agent Manual — 寫入規則
source: agent
tags: ["fact"]
---

# 寫入規則

## 同步架構（先理解才能安全寫入）

```
Obsidian → Railway（22:00 上行）← AI 唯一安全寫入點
Railway → Obsidian wiki-from-ai/（23:00 下行）
```

**Obsidian 永遠贏。** AI 只能寫 `wiki/` 和 `mem/`，其餘 rsync 會覆蓋。

完整說明見 `wiki/conventions/sync-architecture`

## Slug 分類

| 前綴 | 用途 |
|------|------|
| `wiki/analysis/` | AI 分析報告 |
| `wiki/summary/` | AI 摘要 / 多頁整合 |
| `wiki/index/` | 主題索引頁（解 orphan 最快方式）|
| `wiki/draft/` | AI 草稿，待人類 review |
| `wiki/identity/` | 實體定義（人工維護，**AI 唯讀**）|
| `wiki/status/` | 狀態與進度追蹤（活文件）|
| `wiki/conventions/` | 規範與慣例 |
| `wiki/workflow/` | 工作流程定義 |
| `mem/` | 個人筆記、進度記錄 |

**禁止寫入**：`notes/`、`obsidian/`、`_root/`（rsync 會覆蓋）

## Frontmatter 格式

```yaml
---
title: 頁面標題
type: concept | analysis | guide | task | log | status | convention
tags: [source:ai, topic-tag]
source: ai
ai_confidence: high | medium | low
created: YYYY-MM-DD
---
```

ai_confidence：`high` = 腦庫 3+ 頁交叉確認 / `medium` = 1-2 頁 + 自身知識 / `low` = 純自身知識

完整規範見 `wiki/conventions/frontmatter`

## Namespace 判斷（建 link 前必看）

| Namespace | 處理原則 |
|-----------|---------|
| `工作/房多多/`、`房多多資料庫/` | 預設房多多主題群 |
| `未來智能太空艙/` | 房多多相關但非旗下 |
| `_root/` 含「興臺/興台」 | **禁止連到房多多** |
| `notes/`、`_root/` 其他 | 必須讀內容才能判斷 |

完整對照表見 `wiki/conventions/namespace-rules`

## 寫入安全規則

1. 只寫 `wiki/` 或 `mem/` 前綴
2. 每次寫入必加 `source: ai` frontmatter 與 `source:ai` tag
3. 寫入前先搜尋確認不重複
4. 建 link 前必讀 `wiki/identity/distinct-entities`
5. 對外文案只引用成熟度標為 ✅ 的項目
6. 不確定就問使用者

## 禁止行為

- ✗ 寫入 `notes/`、`obsidian/`、`_root/` 前綴
- ✗ 執行 `delete_page` 或 `revert_version`（除非使用者明確指示）
- ✗ 跨主題自由聯想建 link
- ✗ 單次回合超過 100 次寫入
- ✗ 單頁超過 4000 字不停下確認

## GBrain 寫入行為

| 面向 | 行為 |
|------|------|
| 寫入延遲 | async=1，<250ms 可讀取 |
| Lex 索引 | 寫入後 60–90 秒才出現在關鍵字搜尋 |
| Vec 搜尋 | 可能逾時，改用 keyword 模式 |
| 冪等寫入 | 相同內容 → skipped，可安全重試 |
