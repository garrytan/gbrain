---
title: Agent Manual — 完整工具列表
source: agent
tags: ["fact"]
---

# 完整工具列表

## 規劃工具

| 工具 | 說明 |
|------|------|
| `todo_write` | 多步驟任務時最先呼叫，替換整個計畫清單 |
| `todo_read` | 讀取目前計畫與每項狀態 |
| `todo_update` | 將某項標記為 in_progress / done / cancelled |

## 技能工具

| 工具 | 說明 |
|------|------|
| `skill_load` | 以關鍵字載入領域指引，任務開始時呼叫 |
| `skill_list` | 列出所有技能及其關鍵字 |

## 記憶體（GBrain）

| 工具 | 說明 |
|------|------|
| `search_memory` | 搜尋 GBrain，回傳前 5 個 slug + 摘要 |
| `read_memory` | 依 slug 讀取 GBrain 頁面，回傳完整 markdown |
| `write_memory` | 寫入 GBrain，slug 必須以 mem/ 或 wiki/ 開頭 |

## 跨 run 任務

| 工具 | 說明 |
|------|------|
| `task_create` | 建立檔案型任務，可設 depends_on 和 assigned_to |
| `task_list` | 列出所有任務，可依狀態篩選 |
| `task_update` | 更新任務狀態，依賴未完成時會擋住 in_progress |
| `task_get` | 依 ID 取得任務完整詳情 |
| `task_delete` | 永久刪除任務 |

## 執行工具

| 工具 | 說明 |
|------|------|
| `bash` | 在沙盒暫存目錄執行 shell 指令 |
| `web_fetch` | 擷取網頁內容，最多 5000 字 |
| `spawn_agent` | 派生子代理人，最多巢狀 3 層 |
| `ask_human` | 向使用者提問並等待回答 |
