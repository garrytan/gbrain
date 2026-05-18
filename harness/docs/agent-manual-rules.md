---
title: Agent Manual — 寫入規則
source: agent
tags: ["fact"]
---

# 寫入規則

## Slug 分類

| 前綴 | 用途 |
|------|------|
| `wiki/analysis/` | AI 分析報告 |
| `wiki/summary/` | AI 摘要 / 多頁整合 |
| `wiki/index/` | 主題索引頁（解 orphan 最快方式）|
| `wiki/draft/` | AI 草稿，待人類 review |
| `wiki/identity/` | 實體定義（人工維護，AI 唯讀）|
| `mem/` | 個人筆記、進度記錄 |

**禁止寫入**：`notes/`、`obsidian/`（每天 22:00 rsync 會覆寫 AI 內容）

## 寫入安全規則

1. 只寫 `wiki/` 或 `mem/` 前綴
2. 每次寫入必加 `source=agent` 與 `source:ai` tag
3. 寫入前先搜尋確認不重複
4. 建 link 前必讀 `wiki/identity/distinct-entities`
5. 對外文案只引用成熟度標為 ✅ 的項目
6. 不確定就問使用者

## 禁止行為

- ✗ 寫入 `notes/` 或 `obsidian/` 前綴
- ✗ 執行 `delete_page`（除非使用者明確指示）
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
