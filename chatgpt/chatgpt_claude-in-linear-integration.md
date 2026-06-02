---
conversation_id: 694ad7f9-f5c8-8333-8007-15e609481c2c
created: 2025-12-23
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Claude in Linear Integration
type: note
updated: 2025-12-23
---

# Claude in Linear Integration

**Related:** [[coding_ai]]

> Conversation ID: 694ad7f9-f5c8-8333-8007-15e609481c2c
> Created: 2025-12-23T17:57:15Z
> Updated: 2025-12-23T17:57:48Z
> Messages: 2

---

## User

claude in linear

---

## Assistant

**Claude in Linear = using Anthropic’s Claude AI with Linear’s project-management tool.**

It refers to an **integration where Claude (the conversational/agent AI from Anthropic) is connected to Linear’s issue and project system** so Claude can *read, create, update, and manage Linear issues, projects, comments, etc.* via natural-language prompts, instead of manually using Linear’s UI. citeturn0search0turn0search2

**Key points**
- *Claude* is Anthropic’s large language model/assistant. citeturn0search27
- *Linear* is a modern issue-tracking and project management platform.  
- When you integrate Claude with Linear (typically via the **Linear MCP server**), Claude can:
  * Search & fetch issues or project context
  * Create new issues and assign them
  * Update statuses, priorities, labels
  * Add comments  
  — all through prompts to Claude instead of clicking through Linear’s Web UI. citeturn0search0turn0search2

**How it works**
- The integration uses **Linear’s MCP (Model Context Protocol) server**, which acts as a bridge so Claude accesses Linear data and actions as structured tools. citeturn0search0turn0search3  
- Setup usually involves registering the Linear MCP endpoint in Claude (or Claude Code) so Claude can authenticate and act on your Linear workspace. citeturn0search0

**Use cases**
- Ask Claude to automatically *create a bug ticket*, *assign priorities*, or *list tasks due this week*  
- Claude can assist with *issue summaries, triage, and workflow automation* without switching contexts between tools. citeturn0search2

If you want a brief setup guide or example prompts for using Claude with Linear, just let me know.


**Topic:** [[chatgpt-clusters/coding_ai]]


## See Also
- [[chatgpt/chatgpt_chatgpt-linear-integration]]
- [[chatgpt/chatgpt_claude-linear-agent-explanation]]
- [[chatgpt/chatgpt_github-linear-integration-setup]]
- [[chatgpt/chatgpt_linear-github-integration]]
- [[chatgpt/chatgpt_sentry-linear-integration-issues]]
