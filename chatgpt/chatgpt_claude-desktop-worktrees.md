---
conversation_id: 69499b71-a274-8325-8747-91fdb99ec993
created: 2025-12-22
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Claude desktop worktrees
type: note
updated: 2025-12-22
---

# Claude desktop worktrees

**Related:** [[coding_ai]]

> Conversation ID: 69499b71-a274-8325-8747-91fdb99ec993
> Created: 2025-12-22T19:26:42Z
> Updated: 2025-12-22T19:27:15Z
> Messages: 2

---

## User

claude desktop worktrees

---

## Assistant

**Claude Desktop *worktrees*** are a feature in the **Claude Code desktop app** that let you run **multiple isolated coding sessions in parallel** using Git worktrees.citeturn0search1

**What it is**  
- A **worktree** is essentially a separate working directory for a Git repo where you can check out a branch without switching the main repo. Each worktree has its own copy of the project files as of that branch but shares the same Git history.citeturn0search2  
- In Claude Desktop, worktrees are used to give **each Claude Code session its own isolated workspace** within the same repository. That way you can run multiple Claude Code instances on different tasks at once without file conflicts or context overlap.citeturn0search1

**How it works in Claude Desktop**  
- When you start a local Claude Code session in the desktop app, it creates a **Git worktree** (by default in `~/.claude-worktrees` unless you configure another path).citeturn0search1  
- Each worktree is a separate folder representing a branch or task. Claude Code runs in that folder, reads the code, writes changes, and manages commits independently of other sessions.citeturn0search1  
- This enables **parallel agentic development workflows** — e.g., one worktree for UI work, another for backend logic — without having to stash and switch.citeturn0search4  

**Why it’s useful**  
- Lets you run **multiple AI coding agents simultaneously** without them interfering with each other’s context or file edits.citeturn0search1turn0search25  
- Keeps work isolated per task or branch, reducing merge conflicts and accidental cross-contamination of changes.citeturn0search4  
- You can then **merge** completed worktrees back into your main branch like typical feature branches.citeturn0search28

In short, worktrees in Claude Desktop provide a structured, parallel workflow for AI-assisted coding by leveraging Git’s ability to maintain multiple independent working directories tied to one repo.citeturn0search1


**Topic:** [[chatgpt-clusters/coding_ai]]
