---
title: Agent Manual — Index
source: agent
tags: ["fact"]
---

# Agent Manual — Index

讀完這頁就可以開始工作。只在需要時才讀對應章節。

---

## 開工三步

1. `read_memory("wiki/status/session-log")` — 上次做到哪
2. `read_memory("wiki/status/priorities")` — 現在做什麼
3. `GET /stats` — 更新腦庫數字到 `wiki/status/health`

## 核心工具（常用，直接記住）

| 工具 | 用途 |
|------|------|
| `search_memory` | 搜尋腦庫，q= 關鍵字 |
| `read_memory` | 讀頁面，slug= 路徑 |
| `write_memory` | 寫頁面，slug 必須 wiki/ 或 mem/ 開頭 |
| `ask_human` | 不確定時問使用者 |
| `todo_write` | 多步驟任務先列計畫 |

## 按需加載

| 情境 | 讀這頁 |
|------|--------|
| 要寫入 / 建立頁面 | `wiki/agent-manual/rules` |
| 要建立 link 或關係 | `wiki/agent-manual/links` |
| 不知道用哪個工具 | `wiki/agent-manual/tools` |
| 不知道工作流程 | `wiki/agent-manual/workflow` |
| Namespace 判斷 | `wiki/conventions/namespace-rules` |
| Frontmatter 格式 | `wiki/conventions/frontmatter` |
| 同步架構疑問 | `wiki/conventions/sync-architecture` |
| 查看收件匣任務 | `wiki/inbox/` search |
| 協作協議 | `wiki/workflow/protocol` |

## GBrain 三條鐵律

1. slug 只能 `wiki/` 或 `mem/` 開頭
2. 寫入前先搜尋確認不重複
3. 不確定就問，不要猜

## 收工三步

1. 更新 `wiki/status/session-log`（這次做了什麼、下次接力點）
2. 更新 `wiki/status/priorities`（推進進度）
3. 更新 `wiki/status/health`（stats 快照）
