---
title: "Auto-assign Sentry Issues"
type: note
created: 2026-02-19
updated: 2026-02-19
source: chatgpt-export
conversation_id: 69966362-30d8-8332-b397-44b58e9f1c72
message_count: 2
tags: [chatgpt, import]
---
# Auto-assign Sentry Issues

**Related:** [[coding_troubleshoot]]

> Conversation ID: 69966362-30d8-8332-b397-44b58e9f1c72
> Created: 2026-02-19T01:12:12Z
> Updated: 2026-02-19T01:13:10Z
> Messages: 2

---

## User

can i auto assign sentry created issues to sentry ai agent in linear

---

## Assistant

Mr. White — *yes, but with limitations.*

Here’s how it works and what’s possible:

**1) Linear + Sentry integration creates issues.**  
When you connect link_titleSentry and Linear integration docsturn0search1, Sentry can automatically create Linear issues from alerts and exceptions. The integration doesn’t natively include a rule to assign those issues to a specific user or AI agent automatically — it only creates the issue (with fields like title, team, assignee optionally set manually). citeturn0search2

**2) Linear **AI agents** exist, including a Sentry agent.**  
Linear supports “AI agents” (app-user accounts you can assign to issues), including a Sentry agent which performs analysis and responds when assigned or @-mentioned. citeturn0search18turn0search9

**3) Automatic assignee on creation isn’t built-in.**  
Out of the box, the Linear + Sentry integration does not include a configuration to automatically assign newly created issues to a specific assignee (human or agent) by rule. You still choose the assignee when the Linear issue is created from Sentry’s alert rule. citeturn0search1

**Workarounds to simulate auto-assignment:**

- **Use Linear’s automation (Product Intelligence / Triage rules).**  
Linear now supports auto-applying properties like *assignee* based on Triage suggestions rules. You can configure rules so if an issue meets criteria (e.g., issues from Sentry) it auto-assigns a specified Linear agent or user. This isn’t strictly part of the Sentry integration, but is Linear’s internal automation. citeturn0search3

- **Use third-party automation tools (e.g., n8n, Zapier).**  
You can listen for new Sentry issues via webhook and then call Linear’s API to create or update the issue with a specific assignee set to your Sentry AI agent. Tools like n8n let you define: “When Sentry issue -> create/assign in Linear to AgentX.” citeturn0search13

- **Custom integration.**  
Build custom webhook/automation using Sentry and Linear APIs to auto-assign specific AI agent accounts (e.g., the Sentry Agent) whenever an issue is created.

**Summary:**  
You *can* have Sentry create Linear issues and you *can* assign those issues to a Sentry or other Linear AI agent, but there’s no native toggle in the Sentry integration to auto-assign them to an agent by default. You’ll need to use Linear’s own automation rules or an external automation (API/webhooks) to auto-set the assignee.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
