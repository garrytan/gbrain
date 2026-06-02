---
conversation_id: 6973ba43-b428-832e-be6d-d8609a495a81
created: 2026-01-23
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Claude sub-agents explained
type: note
updated: 2026-01-23
---

# Claude sub-agents explained

> Conversation ID: 6973ba43-b428-832e-be6d-d8609a495a81
> Created: 2026-01-23T18:13:24Z
> Updated: 2026-01-23T18:13:56Z
> Messages: 2

---

## User

claude sub agents

---

## Assistant

**Claude sub-agents** (in the *Claude Code* ecosystem by Anthropic) are **specialized, smaller AI assistants** that a main Claude agent can **delegate specific tasks to**. They’re meant to break complex workflows into focused pieces, each handled by an expert-like instance with its own purpose. citeturn0search0turn0search9

### What sub-agents are
- **Task-specialized assistants** — each has a distinct role (e.g., code reviewer, debugger, data analyst). citeturn0search9  
- **Pre-configured system prompts** — you define how it behaves, its expertise, and constraints. citeturn0search0  
- **Own context windows** — they keep separate memory/history so the main conversation doesn’t get cluttered. citeturn0search4  
- **Selective tool access** — you can restrict which tools or capabilities each sub-agent has. citeturn0search8  

### How they work
- The **main Claude Code agent** either **automatically delegates** to an appropriate sub-agent based on context, or you **explicitly invoke** a named sub-agent. citeturn0search9  
- Each sub-agent operates like a mini-AI specialist, focusing on its defined area and returning results to the main workflow. citeturn0search8

### Key benefits
- **Cleaner context management:** keeps lengthy threads narrow and focused. citeturn0search4  
- **Better task quality:** specialists usually outperform a generalist on complex sub-tasks. citeturn0search10  
- **Modular workflows:** build an “AI team” for multi-stage projects. citeturn0search7

In short, sub-agents in Claude Code are **autonomous, purpose-built AI instances** that help decompose work into manageable, expert-level subtasks. citeturn0search9


**Topic:** [[chatgpt-clusters/coding_ai]]
