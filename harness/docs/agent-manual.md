---
title: Agent Operating Manual
source: agent
tags: ["fact"]
---

# Agent Operating Manual

This is your operating manual. Read it at the start of every task.
It describes your tools, the rules for using them, and the expected workflow.

---

## Tools

### Planning

| Tool | Description |
|------|-------------|
| `todo_write` | **Call first** on any multi-step task. Replaces the current plan with an ordered list. |
| `todo_read` | Read the current plan with status of each item. |
| `todo_update` | Mark a todo as `in_progress`, `done`, or `cancelled`. |

### Skills

| Tool | Description |
|------|-------------|
| `skill_load` | Load domain-specific guidance by keyword. Call at task start for context. |
| `skill_list` | List all available skills with their keywords. |

### Memory (GBrain)

| Tool | Description |
|------|-------------|
| `search_memory` | Search GBrain. Returns top 5 slugs + snippets. |
| `read_memory` | Read a GBrain page by slug. Returns full markdown. |
| `write_memory` | Write a page to GBrain. Slug must start with `mem/` or `wiki/`. |

### Tasks (cross-run)

| Tool | Description |
|------|-------------|
| `task_create` | Create a file-backed task with optional `depends_on` and `assigned_to`. |
| `task_list` | List all tasks, optionally filtered by status. |
| `task_update` | Update a task's status or assignee. Blocks `in_progress` if deps not done. |
| `task_get` | Get full details of a task by ID. |
| `task_delete` | Delete a task permanently. |

### Execution

| Tool | Description |
|------|-------------|
| `bash` | Run a shell command in a sandboxed temp dir. Returns exit_code + stdout + stderr. |
| `web_fetch` | Fetch URL content. Returns up to 5000 chars of cleaned text. |
| `spawn_agent` | Spawn a sub-agent for an isolated subtask. Returns its final answer. Max nesting: 3. |
| `ask_human` | Ask the user a question and wait for their reply. |

---

## GBrain Behaviour (v0.19.0)

| Aspect | Behaviour |
|--------|-----------|
| Write latency | `async=1` returns 202 in <50 ms; page readable in <250 ms |
| Lex index lag | Newly written pages appear in keyword search after **60–90 seconds** |
| Vec search | May timeout on some queries. Fall back to `keyword` mode if `hybrid` returns empty |
| Idempotent write | Same content hash → instant `skipped` response; safe to retry |
| Sync write (no async=1) | **Always times out. Never use.** |

---

## GBrain Rules

- Slugs must start with `mem/` or `wiki/`. No other prefix.
- **Search before writing** — confirm the page doesn't exist to avoid duplicates.
- If it exists, `write_memory` with the same slug performs an idempotent upsert.
- If `hybrid` search returns empty and the content was just written, retry with `mode: keyword`.
- Do not interpret a 404 immediately after writing as failure — allow up to 90 s for lex index.
- When unsure about the user's intent, use `ask_human`. Do not guess.

---

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

---

## 寫入安全規則

1. 只寫 `wiki/` 或 `mem/` 前綴
2. 每次寫入必加 `source=agent` 與 `source:ai` tag
3. 寫入前先搜尋確認不重複
4. 建 link 前必讀 `wiki/identity/distinct-entities` 確認實體歸屬
5. 對外文案只引用 `distinct-entities` 中成熟度標為 ✅ 的項目
6. 不確定就問使用者，不要猜

---

## 禁止行為

- ✗ 寫入 `notes/` 或 `obsidian/` 前綴
- ✗ 執行 `delete_page`（除非使用者明確指示）
- ✗ 跨主題自由聯想建 link（只在 search 結果內互連）
- ✗ 單次回合超過 100 次寫入操作
- ✗ 單頁超過 4000 字不停下確認

---

## Link Type 準則

| 類型 | 使用時機 |
|------|---------|
| `mentions` | A 文中提到 B（不確定時選這個）|
| `related_to` | A 和 B 同主題不同角度 |
| `part_of` | A 是 B 的子集 |
| `references` | A 引用了 B 的具體論點/數據 |
| `responds_to` | A 是對 B 的回應/反駁/延伸 |
| `founded` | 創立關係 |
| `works_at` | 任職關係 |
| `invested_in` | 投資關係 |
| `advises` | 顧問關係 |
| `attended` | 出席活動 |

---

## Namespace 判斷（建 link 前三問）

1. 這個 slug 的 namespace 是什麼？→ 對照 `distinct-entities` 找預設歸屬
2. 有沒有「興臺」「興台」字眼？→ 有則禁止連到房多多
3. 有沒有跨 namespace 吸引力？→ 有則讀內文確認，不靠名稱猜

---

## 回合結束條件

達到任一即停止並回報：

- 已建立 50 條新 link
- 已標記 100 個 source tag
- 已完整處理 1 個主題
- 連續 5 次 search 沒找到可加工的頁面

---

## 回報格式

```
本次回合結果：
- 處理主題：XXX
- 新增 links：N 條
- 排除頁面：slug + 排除理由
- 新增 wiki 頁面：slug 列表
- 剩餘待辦：下個建議主題
```

---

## Workflow

1. **Plan** — call `todo_write` with the ordered steps before taking any action.
2. **Load skills** — call `skill_load` with the task description to get domain guidance.
3. **Search memory** — call `search_memory` to pull relevant background context.
4. **Execute** — work through todos, calling `todo_update` as each step progresses.
5. **Persist** — write progress notes with `write_memory` after each major step.
6. **Summarise** — after completing the task, write a summary at `mem/summary-<slug>`.
7. **Done** — reply to the user in plain text. Do not call any more tools after the final answer.

---

## Completion

Once you have gathered enough information and taken all necessary actions, write your
final answer as plain text. Do not add a trailing tool call after the answer.
