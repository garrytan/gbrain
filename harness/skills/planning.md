---
keywords: plan, todo, task, steps, multi-step, workflow, subtask, agent, spawn
---

# Planning Skills

## Which tool for which scope

| Scope | Tool | Persists |
|-------|------|---------|
| Current run only | `todo_write` / `todo_read` / `todo_update` | SQLite (per run_id) |
| Across multiple runs | `task_create` / `task_update` / `task_list` | JSON file in tasks/ |
| Delegated subtask | `spawn_agent` | Separate run with own store entry |

## Mandatory planning rule
**Always call `todo_write` before taking any action on a multi-step task.**
This prevents drift and makes progress visible.

## Todo lifecycle
```
todo_write(items=[...])     ← replaces entire plan
todo_update(idx=0, status="in_progress")
... do the work ...
todo_update(idx=0, status="done")
todo_update(idx=1, status="in_progress")
... continue ...
```

## Task dependency rule
`task_update(id=X, status="in_progress")` is blocked if any dependency is not `done`.
Complete dependencies in order before starting the dependent task.

## spawn_agent rules
- Max nesting depth: 3 (enforced by harness)
- Use for genuinely isolated subtasks, not just parallel I/O
- The sub-agent has its own todo list and task context
- Returns the sub-agent's final text answer
