---
title: "Auto-assign Linear Agents"
type: note
created: 2026-01-24
updated: 2026-01-24
source: chatgpt-export
conversation_id: 69742aa3-225c-8332-9640-efc07a9605cd
message_count: 2
tags: [chatgpt, import]
---
# Auto-assign Linear Agents

> Conversation ID: 69742aa3-225c-8332-9640-efc07a9605cd
> Created: 2026-01-24T02:12:51Z
> Updated: 2026-01-24T03:08:31Z
> Messages: 2

---

## User

can you auto assign linear agents to sentry issues

---

## Assistant

Yes, **you can auto-assign Linear agents to Sentry issues**, but not natively with full flexibility. Here are the **fact-based options**, from most to least robust.

---

## Native option (limited)

entity["company","Sentry","error tracking platform"] has a built-in integration with entity["company","Linear","issue tracking tool"] that can:

- Automatically **create Linear issues from Sentry issues**
- Sync status (resolve in Linear → resolve in Sentry)

**Limitation:**  
Native Sentry → Linear does **not** support rule-based assignee mapping (e.g., by service, team, ownership). Assignment is typically manual or static.

---

## Recommended: Automation via webhook (best practice)

To **auto-assign reliably**, you need a small automation layer.

**How it works**
1. Sentry fires a **webhook** when an issue is created.
2. Your service:
   - Reads Sentry metadata (project, environment, stack trace, ownership rules).
   - Maps it to a **Linear team + assignee**.
3. Calls the **Linear API** to create the issue with `assigneeId`.

**What you can base assignment on**
- Sentry project → Linear team
- Code ownership (CODEOWNERS → Linear user)
- Error tags (service, backend/frontend, etc.)
- Severity / environment (prod vs staging)

**This is the only way to get deterministic auto-assignment today.**

---

## No-code / low-code options

If you don’t want to write code:

- Zapier / Make.com  
  - Trigger: Sentry issue created  
  - Action: Create Linear issue  
  - **Caveat:** assignment logic is basic (conditional, not deep ownership)

Good for small teams, not great for large repos or shared ownership.

---

## What you cannot do (as of now)

- ❌ Configure auto-assignment rules *inside Sentry* for Linear assignees  
- ❌ Have Linear dynamically assign based on Sentry data without automation

---

## TL;DR

- **Yes, auto-assignment is possible**
- **No, not natively**
- **Webhook + Linear API is the correct solution**
- Native integration = issue creation + sync only

If you want, I can:
- Sketch the webhook logic
- Provide a minimal Node/Python example
- Design an ownership → Linear mapping schema

Tell me which.


## See Also
- [[chatgpt/chatgpt_auto-assign-sentry-issues]]
- [[chatgpt/chatgpt_codex-auto-pr-linear]]
- [[chatgpt/chatgpt_linear-auto-pr-setup]]
- [[chatgpt/chatgpt_linear-agents-webhooks]]
- [[chatgpt/chatgpt_auto-advance-date-tracking]]
