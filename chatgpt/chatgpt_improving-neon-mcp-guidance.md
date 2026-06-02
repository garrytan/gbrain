---
title: "Improving Neon MCP Guidance"
type: note
created: 2026-01-09
updated: 2026-01-09
source: chatgpt-export
conversation_id: 69616503-c704-8329-9894-ddf827d432e4
message_count: 2
tags: [chatgpt, import]
---
# Improving Neon MCP Guidance

> Conversation ID: 69616503-c704-8329-9894-ddf827d432e4
> Created: 2026-01-09T20:29:04Z
> Updated: 2026-01-09T20:29:58Z
> Messages: 2

---

## User

how can i imporve the usage guidance for our neon mcp in coderabbit

---

## Assistant

Mr. White, here’s a **clear, high-signal improvement** you can drop directly into the **Usage guidance** field for your Neon MCP in CodeRabbit. It’s optimized to help the reviewer agent choose the *right tools*, *right branch*, and *avoid foot-guns*.

**What this improves**
- Makes branch semantics explicit (critical for PR reviews)
- Constrains destructive actions
- Tells the model *when* to use Neon vs inference
- Reduces noisy or unsafe SQL execution

---

### Recommended Usage Guidance (paste this)

:::writing{id="74219" variant="standard"}
Neon is our Postgres database provider.  
We use **database branching per Git feature branch**.

**Branch conventions**
- `main` → production database (**read-only** unless explicitly requested)
- `development` → shared dev database
- Feature branches → one Neon DB branch per Git branch (preferred for PR review)

**When to use this MCP**
- Inspect schemas, tables, indexes, or migrations
- Validate SQL used in PRs
- Explain or optimize queries
- Compare schema differences across branches
- Investigate slow queries or performance regressions

**Safety rules**
- ❌ Do NOT run `DELETE`, `UPDATE`, `DROP`, or `TRUNCATE` on `main`
- ❌ Do NOT modify data unless explicitly instructed
- ✅ Prefer `EXPLAIN` / `EXPLAIN ANALYZE` before executing complex queries
- ✅ Use `compare_database_schema` when reviewing migrations

**PR review workflow**
1. Identify the Git branch
2. Select the matching Neon DB branch
3. Review schema changes and query impact
4. Flag unsafe or non-performant SQL

Assume Postgres semantics unless stated otherwise.
:::

---

If you want, I can **tighten this further for CodeRabbit specifically** (e.g., biasing toward `describe_table_schema` over `run_sql`, or adding guardrails for migrations).


## See Also
- [[chatgpt/chatgpt_career-path-guidance]]
- [[chatgpt/chatgpt_clerk-elements-replacement-guidance]]
- [[chatgpt/chatgpt_component-naming-guidance]]
- [[chatgpt/chatgpt_fundraising-strategy-guidance]]
- [[chatgpt/chatgpt_holiday-drink-menu-guidance]]
