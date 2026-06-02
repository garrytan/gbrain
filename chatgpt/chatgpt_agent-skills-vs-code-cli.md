---
title: "Agent Skills vs Code CLI"
type: note
created: 2026-01-31
updated: 2026-01-31
source: chatgpt-export
conversation_id: 697e8b87-881c-832c-a9ec-67ad4526a832
message_count: 2
tags: [chatgpt, import]
---
# Agent Skills vs Code CLI

> Conversation ID: 697e8b87-881c-832c-a9ec-67ad4526a832
> Created: 2026-01-31T23:08:56Z
> Updated: 2026-01-31T23:09:34Z
> Messages: 2

---

## User

agent skills in claude.ai vs claude code cli

---

## Assistant

Here’s a clear comparison of **“agent skills” in Claude.ai / the Claude ecosystem** vs **Claude Code CLI agents**, and what each concept means in practice:

---

### 🔹 **Agent Skills (General Claude ecosystem)**

**What they are**  
• Modular capabilities that extend Claude’s functionality by packaging instructions, metadata, and optional executable resources — effectively adding *expertise* or *tools* Claude can automatically use when relevant. citeturn0search7

**Where you see them**  
• Available in **Claude.ai**, the **Claude API**, and in **Claude Code / Agent SDK**. citeturn0search7

**What they do**  
• Skills act like domain-specific extensions — e.g., Excel editing, Word manipulation, PDF handling, or your own custom workflows — that the model can invoke automatically instead of depending on just plain prompts. citeturn0search7  
• They *don’t require you to write a bunch of prompts every time*; they’re more like built-in utilities Claude loads when its reasoning determines they apply. citeturn0search32

**Key point**  
• Agent Skills *augment* Claude’s reasoning with specialized capabilities. They’re not standalone agents, but building blocks that *agents* (or Claude itself) call upon. citeturn0search7

---

### 🔹 **Claude Code CLI / Agents in Claude Code**

**What this is**  
• Claude Code is Anthropic’s **command-line agentic tool** focused on autonomous tasks like coding, debugging, running commands, exploring files, and integrating with workflows. It can run *agents* that act with autonomy in your project context. citeturn0search0turn0search34

**Agents in Claude Code**  
• Agents here are autonomous workers defined in agent manifests (like markdown docs) that can execute tasks — often making use of Skills and other extensions. citeturn0search0  
• You can spawn multiple agents for parallel work or complex automation. citeturn0search0

**Skills inside Claude Code**  
• Claude Code *can use Skills* (custom or built-in) just like Claude.ai — agents leverage them to handle domain knowledge or tooling. citeturn0search3

**Distinct nature**  
• Claude Code agents are *specialized CLI agents* designed for developer workflows. They integrate Skills, subagents, commands, and tools into a cohesive automation environment. citeturn0search4  
• These agents are fully autonomous in the context of your local project — e.g., they can read code, patch bugs, or generate tests with minimal prompting. citeturn0search34

---

### 🧠 **Simplified Difference**

| Feature | Agent Skills (Claude.ai / API) | Claude Code CLI Agents |
|---------|-------------------------------|------------------------|
| Purpose | Extend Claude’s abilities (e.g., Excel, PDF) | Full autonomous CLI agents running workflows |
| Scope | Reusable expertise modules | Autonomous workers that *use* skills/tools |
| Usage | Within chat, API, and CLI | Primarily in coding/automation pipelines |
| Autonomy | Skills invoked *by intent* | Agents execute tasks with autonomy |
| Customization | Create custom skills | Create agents + skills + commands + hooks |

---

### 🧩 **In One Line**

• **Agent Skills** = building blocks (expert modules) enhancing Claude’s capabilities. citeturn0search7  
• **Agents in Claude Code CLI** = autonomous workers that *use* those blocks (plus commands, subagents, etc.) to perform real tasks. citeturn0search0

---

If you want, I can break down example workflows showing how Skills get *invoked* inside a Claude Code agent step-by-step.


## See Also
- [[chatgpt/chatgpt_agent-skills-entry]]
- [[chatgpt/chatgpt_agent-skills-in-ai-coding]]
- [[chatgpt/chatgpt_agent-skills-overview-2]]
- [[chatgpt/chatgpt_agent-skills-overview]]
- [[chatgpt/chatgpt_claude-code-agent-teams-2]]
