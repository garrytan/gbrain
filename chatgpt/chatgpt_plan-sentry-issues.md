---
title: "Plan Sentry Issues"
type: note
created: 2026-02-18
updated: 2026-02-18
source: chatgpt-export
conversation_id: 69964a82-0988-832f-bd15-55543cca5eb5
message_count: 2
tags: [chatgpt, import]
---
# Plan Sentry Issues

**Related:** [[coding_troubleshoot]]

> Conversation ID: 69964a82-0988-832f-bd15-55543cca5eb5
> Created: 2026-02-18T23:26:08Z
> Updated: 2026-02-18T23:26:22Z
> Messages: 2

---

## User

I want every issue created by sentry to get a plan

---

## Assistant

Mr. White — easiest way is to make a ruleset that matches **Sentry-created issue titles**, since Sentry usually prefixes them.

Do this on the screen you’re on:

1) **Name**: something like “Plan Sentry issues”  
2) **Conditions → IF → Title**
   - Operator: **contains**
   - Value: **[Sentry]** (common default)

If your Sentry issues don’t use `[Sentry]`, use **contains → Sentry** instead (or create multiple conditions if the UI allows OR rules).

Then **Enable ruleset → Save**.

:::writing{id="60741" variant="standard"}
Plan Sentry issues
:::

If you paste one example Sentry issue title here, I’ll tell you the exact best “contains” value to match **all** of them.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
