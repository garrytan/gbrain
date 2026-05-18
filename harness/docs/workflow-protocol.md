---
title: Genspark ↔ 本地 AI 協作協議
type: convention
tags: ["workflow", "protocol", "collaboration"]
source: agent
---

# Genspark ↔ 本地 AI 協作協議

## 核心概念

GBrain 是兩個 AI 的共享工作台。
- **Genspark**：規劃者、決策者（有網路、推理強）
- **本地 AI**：執行者（有 file system、工具整合）

## 任務命名空間

```
wiki/inbox/{YYYY-MM-DD}-{topic}   ← Genspark 寫任務
wiki/outbox/{YYYY-MM-DD}-{topic}  ← 本地 AI 寫結果（可選）
```

## 任務頁格式

```markdown
---
title: 任務標題
type: task
status: pending
assigned_to: local-ai
created_by: genspark
created: YYYY-MM-DD
---

## Task
具體要做什麼（越明確越好）

## Context
相關 slug 列表、背景資訊

## Result
（本地 AI 執行後填入）

## Review
（Genspark 審閱後的後續指令）
```

## 狀態機

```
pending → in_progress → done → reviewed
```

| 狀態 | 誰來設定 | 說明 |
|------|---------|------|
| `pending` | Genspark | 任務已寫入，等待執行 |
| `in_progress` | 本地 AI | 已取得任務，執行中 |
| `done` | 本地 AI | 執行完成，結果已寫入 |
| `reviewed` | Genspark | 已讀取結果，任務關閉 |

## 本地 AI 工作流程

```
1. search("wiki/inbox") → 找 status:pending 的任務
2. 更新 status → in_progress
3. 執行 Task 內容
4. 將結果寫入 ## Result 區塊
5. 更新 status → done
6. 回報給使用者
```

## Genspark 工作流程

```
1. 寫任務到 wiki/inbox/{date}-{topic}
2. 通知使用者：「已寫入任務，請本地 AI 執行」
3. 使用者觸發本地 AI 後讀取結果
4. get_page(wiki/inbox/{date}-{topic}) 讀 ## Result
5. 更新 status → reviewed，繼續下一步
```

## 適合分工的場景

| 任務類型 | 由誰執行 |
|---------|---------|
| 網路搜尋、資料整理 | Genspark |
| 大量 link 建構 | 本地 AI |
| find_orphans + 批次索引 | 本地 AI |
| 分析報告撰寫 | Genspark |
| 寫入 wiki/analysis/ | 本地 AI（依 Genspark 指令）|
| 決策、策略規劃 | Genspark |
