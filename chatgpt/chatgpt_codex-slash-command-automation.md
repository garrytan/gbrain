---
title: "Codex Slash Command Automation"
type: note
created: 2026-02-21
updated: 2026-02-21
source: chatgpt-export
conversation_id: 6999f421-acf4-832e-b5ad-0e68c3da2e00
message_count: 2
tags: [chatgpt, import]
---
# Codex Slash Command Automation

> Conversation ID: 6999f421-acf4-832e-b5ad-0e68c3da2e00
> Created: 2026-02-21T18:06:50Z
> Updated: 2026-02-21T18:10:35Z
> Messages: 2

---

## User

is it possible to run a slash command at the end of every single. codex run

---

## Assistant

Short answer: **No — Codex does *not* currently support automatically running a slash command at the end of every single Codex run.** Slash commands in the Codex CLI must be invoked manually by the user; they’re not automatically executed after each run or response. citeturn0search2turn0search7

**Explanation**

- In the Codex CLI, slash commands are *manual triggers* — you type `/...` within the session to tell Codex to run that specific action. They are designed as shortcuts and interactive commands, not hooks that automatically fire after each run. citeturn0search7  
- There’s no built-in mechanism in Codex to define a post-execution hook or event handler that fires a slash command automatically after every request. Slash commands remain a user-initiated interface feature. citeturn0search2  
- Some feature requests on the official Codex repo discuss richer slash command integration (like auto-invoke or metadata to trigger commands based on context), but these are *requests* and not available features. citeturn0search20

If you’re trying to automate workflows (e.g., after each execution), you’d need to wrap the Codex CLI invocation in an external script or automation tool (like a shell script, Makefile, or CI pipeline) that runs whatever commands you want *after* Codex finishes — Codex itself won’t trigger those automatically.
