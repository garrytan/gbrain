---
title: "Agent skills entry"
type: note
created: 2026-01-31
updated: 2026-01-31
source: chatgpt-export
conversation_id: 697e845e-0354-8327-ac3a-a0c10b6082bb
message_count: 2
tags: [chatgpt, import]
---
# Agent skills entry

> Conversation ID: 697e845e-0354-8327-ac3a-a0c10b6082bb
> Created: 2026-01-31T22:38:22Z
> Updated: 2026-01-31T22:39:02Z
> Messages: 2

---

## User

agent skills entry

---

## Assistant

**Agent skills** are modular, reusable capability packages that extend an AI agent’s functionality with specialized knowledge, workflows, and instructions. They let an agent perform complex or domain-specific tasks more reliably and without repeating context every time. citeturn0search1turn0search10

**Key points:**  
• A skill is typically a folder containing a required `SKILL.md` file with metadata (like name and description) and detailed instructions for the agent. Optional scripts, templates, and reference assets can also be included. citeturn0search1turn0search10  
• Agents load only the names and descriptions of available skills initially, then read full instructions *on demand* when a user request matches a skill’s purpose. This progressive loading keeps context efficient. citeturn0search10  
• They differ from simple prompts or one-off configurations: skills are persistent, discoverable, and can be shared or reused across projects or teams. citeturn0search1  
• Used by AI systems (e.g., GitHub Copilot coding agent, Claude, Spring AI), skills help specialize general-purpose models for task-specific workflows without hard-coding behaviors. citeturn0search2turn0search8


## See Also
- [[chatgpt/chatgpt_agent-skills-in-ai-coding]]
- [[chatgpt/chatgpt_agent-skills-overview-2]]
- [[chatgpt/chatgpt_agent-skills-overview]]
- [[chatgpt/chatgpt_agent-skills-vs-code-cli]]
- [[chatgpt/chatgpt_slash-commands-vs-agent-skills]]
