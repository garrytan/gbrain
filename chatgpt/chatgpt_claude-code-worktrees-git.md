---
title: "Claude Code Worktrees Git"
type: note
created: 2026-01-20
updated: 2026-01-20
source: chatgpt-export
conversation_id: 696fe877-a560-8328-a7f4-d160e9b161df
message_count: 2
tags: [chatgpt, import, code]
---
# Claude Code Worktrees Git

> Conversation ID: 696fe877-a560-8328-a7f4-d160e9b161df
> Created: 2026-01-20T20:41:28Z
> Updated: 2026-01-20T20:42:01Z
> Messages: 2

---

## User

claude code worktrees

---

## Assistant

**Claude Code Worktrees (with Git)** — concise explanation:

**What worktrees are:**  
Git worktrees let you check out *multiple branches* of the **same Git repository** into *separate directories*, sharing a single `.git` history but isolating working files. That means you can work on feature-A and bug-fix-B simultaneously without switching branches or losing state. citeturn0search0

**How this ties to Claude Code:**  
Claude Code (Anthropic’s CLI AI coding assistant) runs inside a directory and builds deep context about your codebase. If you switch a branch in one directory, that context resets — costly if you were mid-task. By combining **Git worktrees + Claude Code**, you can:

- Run **multiple Claude Code sessions in parallel**, one per worktree/branch. citeturn0search1  
- Preserve Claude’s context in each branch without branch switching. citeturn0search1  
- Keep tasks isolated so one session’s changes don’t conflict with another. citeturn0search18

**Typical workflow:**  
1. From your main repo:  
   ```bash
   git worktree add ../my-feature-branch feature/my-feature
   ```  
2. `cd ../my-feature-branch`  
3. `claude`  
4. Give Claude Code your prompt/task for that branch. citeturn0search18

Repeat for other branches/worktrees to run parallel AI productivity workflows. citeturn0search0

**Why it’s valuable:**  
- **Parallelism:** No stashing / branch switching. citeturn0search12  
- **Context preservation:** Each Claude session keeps its own code understanding. citeturn0search1  
- **Clean Git history:** All worktrees share the same Git repo metadata but remain independent. citeturn0search0

**Limitations / practical notes:**  
- Some Claude Code setups enforce strict directory navigation, which can block worktree directories unless configured. citeturn0search9  
- Each worktree’s dependencies (like `node_modules` or venvs) might need installation separately. citeturn0search18

In short: use **Git worktrees + Claude Code** to spawn multiple isolated coding environments allowing parallel AI-assisted development with minimal context loss. citeturn0search1


**Topic:** [[chatgpt-clusters/coding_ai]]
