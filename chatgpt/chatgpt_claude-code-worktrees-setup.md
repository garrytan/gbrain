---
conversation_id: 6947724d-d7b8-8327-bf59-56f190cc9281
created: 2025-12-21
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Claude code worktrees setup
type: note
updated: 2025-12-21
---

# Claude code worktrees setup

**Related:** [[coding_ai]]

> Conversation ID: 6947724d-d7b8-8327-bf59-56f190cc9281
> Created: 2025-12-21T04:06:38Z
> Updated: 2025-12-21T04:07:19Z
> Messages: 2

---

## User

claude code in worktrees

---

## Assistant

Here’s how **Claude Code** works with **Git worktrees** for parallel development workflows (what “Claude code in worktrees” refers to):

### 📌 What Git Worktrees Are
Git worktrees let you check out **multiple branches of the same repo simultaneously** into separate directories without duplicating the `.git` data. This means you can work on different branches at once **without switching back and forth**. citeturn0search0

### 🧠 Why It Matters for Claude Code
Claude Code runs in your **terminal** and can:
- read your codebase
- make edits
- run commands
- commit changes

If you run **one Claude Code session in one worktree per branch**, each session has its **own isolated working directory and context**. That avoids:
- AI sessions overwriting each other
- context collision between branches
- constantly switching branches and restarting Claude sessions

This pattern lets you run **parallel Claude Code sessions**, each focused on a specific branch or feature. citeturn0search2turn0search8

### 🛠️ Typical Workflow with Claude Code + Worktrees

1. **Create worktrees for each branch**  
   ```bash
   # from the main repo folder
   git worktree add ../project-feature-1 feature/feature-1
   git worktree add ../project-feature-2 feature/feature-2
   ```
2. **Open separate Claude Code sessions**  
   In each worktree directory:
   ```bash
   cd ../project-feature-1
   claude
   # in another tab
   cd ../project-feature-2
   claude
   ```
3. **Each Claude session stays bound to its own branch**  
   You can ask each AI to work on its own task without interference. citeturn0search9

4. **Commit & merge when done**  
   Work in one worktree completes → commit → push → open PR → merge → remove worktree.

### 📌 Benefits
- **Isolation:** Each session runs independently on its own branch. citeturn0search8
- **Parallelism:** No waiting for one task to finish to start another. citeturn0search2
- **Less context switching:** No stashing/un-stashing when switching branches. citeturn0search16

### ⚠️ Limitations & Caveats
- Claude Code currently may restrict directory navigation for security, so navigating to sibling worktree dirs isn’t always automatic; some users work around this manually. citeturn0search14
- Running many sessions increases compute and context usage.

### 🧩 Useful Enhancements
Some workflows build helper scripts or tools (bash functions or session managers like **CCManager**) to automate creating worktrees and starting Claude sessions. citeturn0search21

---

**Summary:** With Git worktrees, you can spin up separate directories for each feature branch and run multiple **Claude Code** sessions in parallel, giving each session its own local workspace and avoiding conflicts between tasks. This pattern accelerates development with AI assistance. citeturn0search0


**Topic:** [[chatgpt-clusters/coding_ai]]
