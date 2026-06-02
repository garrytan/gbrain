---
title: "gstack GitHub Repo"
type: note
created: 2026-03-15
updated: 2026-03-15
source: chatgpt-export
conversation_id: 69b6ef88-eb18-8322-a590-85599ec248c1
message_count: 2
tags: [chatgpt, import, code]
---
# gstack GitHub Repo

> Conversation ID: 69b6ef88-eb18-8322-a590-85599ec248c1
> Created: 2026-03-15T17:42:33Z
> Updated: 2026-03-15T17:43:16Z
> Messages: 2

---

## User

gstack github

---

## Assistant

**GitHub repo:**  
- https://github.com/garrytan/gstack → entity["software","gstack","Garry Tan Claude Code setup"] citeturn0search0  

### What it is
**gstack** is an open-source configuration package for **Claude Code** that installs an opinionated workflow and command system for AI-assisted development. citeturn0search0turn0search9  

It converts a single coding assistant into multiple specialized workflows (triggered via commands). citeturn0search0  

Typical capabilities include:  
- product planning workflows  
- architecture review  
- code review rules  
- QA / testing patterns  
- “one-command shipping”  
- browser automation for testing/debugging  
- engineering retrospectives citeturn0search0turn0search12  

These are implemented through a structured **`CLAUDE.md` configuration** that controls how Claude behaves during coding sessions. citeturn0search9  

### Example install
Typical install flow (after verifying the package):

```bash
npm info gstack
npx gstack@<version>
```

This writes configuration files into:

```
~/.claude/CLAUDE.md
```

which Claude Code reads as its persistent instruction set. citeturn0search9  

### Why developers use it
- avoids manually building Claude Code configs  
- ships a tested baseline workflow  
- easily forked and customized  
- reproducible setup across machines and teams citeturn0search9  

### Important clarification
There are **multiple unrelated projects named “gstack” on GitHub** (e.g., CLI tools for stacked PRs or Go libraries). The AI-coding tool above refers specifically to **Garry Tan’s `garrytan/gstack` repo**. citeturn0search4turn0search5  

If useful, I can also explain:  
- how gstack compares to **OpenAI Codex / Cursor / Claude Code setups**, or  
- the **actual files inside the repo and how the workflows work**.


## See Also
- [[chatgpt/chatgpt_github-repo-cost-estimate]]
- [[chatgpt/chatgpt_allow-claude-biom-github]]
- [[chatgpt/chatgpt_building-a-github-action]]
- [[chatgpt/chatgpt_codex-integration-with-repo]]
- [[chatgpt/chatgpt_create-readme-for-repo]]
