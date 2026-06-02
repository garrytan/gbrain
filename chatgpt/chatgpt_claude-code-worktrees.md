---
title: "Claude Code Worktrees"
type: note
created: 2026-01-18
updated: 2026-01-18
source: chatgpt-export
conversation_id: 696c2bae-87f0-8333-8f8d-53d287d8109b
message_count: 2
tags: [chatgpt, import, code]
---
# Claude Code Worktrees

> Conversation ID: 696c2bae-87f0-8333-8f8d-53d287d8109b
> Created: 2026-01-18T00:39:11Z
> Updated: 2026-01-18T00:40:20Z
> Messages: 2

---

## User

claude locally worktrees

---

## Assistant

Here’s how **Claude / Claude Code and Git worktrees** relate and how you can use them together effectively (locally):

### 🧠 What Git worktrees are  
A **Git worktree** lets you check out multiple branches of the *same Git repo* into separate directories that share one `.git` repository. Each worktree acts like an isolated working copy without needing full clones of the repo. citeturn0search1

### 🤖 Why use worktrees with Claude Code  
When using **Claude Code locally**, worktrees let you:

- Run **multiple Claude Code sessions in parallel**, each in its own directory/branch. citeturn0search0
- Avoid constantly switching branches and losing context with Claude. citeturn0search1
- Keep tasks isolated: one worktree per feature or bugfix. citeturn0search6

Practically this means in different terminals you can have:

```
# Worktree A
cd ~/project-feature-login
claude

# Worktree B
cd ~/project-bugfix-auth
claude
```

Each session **remembers context** separately and edits only its branch. citeturn0search6

### ⚙️ Typical setup with Git and Claude Code  
1. From your main repo:
   ```bash
   git worktree add ../project-feature-x -b feature/x
   git worktree add ../project-feature-y -b feature/y
   ```
2. Enter one worktree directory and start Claude Code:
   ```bash
   cd ../project-feature-x
   claude
   ```
3. Repeat for other worktrees. citeturn0search15

Each worktree keeps its **own working files and dependencies** (e.g., `node_modules`, venv), though they all share the same Git history. citeturn0search18

### 🛠️ Practical workflow benefits  
- **Parallel development**: AI can generate or edit code on different branches at the same time. citeturn0search1  
- **No stash/switch churn**: You don’t lose Claude’s context by switching branches. citeturn0search0  
- **Easier reviews**: Work in isolation, then merge back when Claude’s changes are ready. citeturn0search7

### ⚠️ Current tooling limitations  
- Claude Code **might not automatically navigate** to sibling worktree directories due to security constraints unless configured or invoked from within that directory. citeturn0search23

### 🧩 Summary  
- **Git worktrees** give you multiple local directories tied to the same project. citeturn0search1  
- Using Claude Code in each worktree lets you **run separate AI sessions in parallel** on different tasks/branches. citeturn0search0  
- This workflow improves productivity and isolates context per task, but may require careful directory setup and possibly tooling/scripts to manage multiple sessions cleanly. citeturn0search21

If you want, I can give you example shell scripts or Claude Code prompts to automate this workflow.


**Topic:** [[chatgpt-clusters/coding_ai]]
