---
name: daily-task-manager
version: 1.0.0
description: |
  Task lifecycle management. Add, complete, defer, remove, and review tasks.
  Maintains a running task list as an ops/tasks.md workspace file.
triggers:
  - "add task"
  - "complete task"
  - "what are my tasks"
  - "task list"
  - "defer task"
tools:
  - search
  - add_timeline_entry
mutating: true
---

# Daily Task Manager

## Contract

This skill guarantees:
- Tasks stored in the workspace file `ops/tasks.md` with structured format
- The live-context engine can read P1 tasks from the same file this skill writes
- Task lifecycle: add → in-progress → complete | defer
- Priority levels: P0 (urgent), P1 (today), P2 (this week), P3 (backlog)
- Completed tasks archived with completion date
- Deferred tasks carry forward with reason

## Phases

1. **Load current tasks.** Read the workspace file `ops/tasks.md`. If it does not exist, create it from the Output Format below.
2. **Execute the requested action:**
   - **Add:** Append task with priority, description, due date. Add timeline entry.
   - **Complete:** Mark as done, move to completed section with date.
   - **Defer:** Move to next day/week with reason.
   - **Remove:** Delete from list (rare, prefer complete or defer).
   - **Review:** Display all active tasks by priority.
3. **Save.** Write the updated task list back to `ops/tasks.md`.

## Output Format

```markdown
# Tasks

## P0 — Urgent
- [ ] {task description} (due: {date})

## P1 — Today
- [ ] {task description}

## P2 — This Week
- [ ] {task description}

## P3 — Backlog
- [ ] {task description}

## Completed
- [x] {task} (completed: {date})
```

## Anti-Patterns

- Adding tasks without a priority level
- Completing tasks without recording the completion date
- Deferring tasks without a reason
- Letting the task list grow unbounded (review weekly)
- Writing tasks through `gbrain put ops/tasks`; `ops/` is deliberately excluded from sync, and the live-context engine reads `ops/tasks.md` from disk.
