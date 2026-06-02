---
title: "Working with PRs"
type: note
created: 2025-09-03
updated: 2025-09-03
source: chatgpt-export
conversation_id: 68b89cde-6260-8330-ac56-a8e10fafbcf1
message_count: 2
tags: [chatgpt, import]
---
# Working with PRs

> Conversation ID: 68b89cde-6260-8330-ac56-a8e10fafbcf1
> Created: 2025-09-03T19:54:41Z
> Updated: 2025-09-03T19:54:52Z
> Messages: 2

---

## User

If im working and I push and open a pr from my feat branch into preview. And it auto merges via ci. Should i then switch to preview or can i keep working in the feat branch and then push and pr again etc.

---

## Assistant

You can keep working in your **feat branch**. Here’s the clean flow most teams use:

- **Keep working in feat branch**: After your PR auto-merges into `preview`, don’t switch branches unless you want to test or hotfix directly in `preview`. Just keep committing to `feat/foo`, push, and open a new PR when you’re ready.  
- **CI auto-merge means integration is done**: Once merged, `preview` contains the latest tested state of your feature. Your `feat/foo` is just your workspace until the next PR.  
- **Good hygiene**:  
  - Periodically pull/rebase from `preview` into your feat branch so you’re not drifting too far.  
  - Delete or reset old feature branches when the work is fully merged/finished to avoid clutter.

So: you don’t need to switch to `preview` for daily work. Keep coding in your `feat` branch → push → PR → CI auto-merges into `preview`.  

Do you want me to sketch out the exact Git commands for the cleanest rebase/PR cycle in this setup?


## See Also
- [[chatgpt/chatgpt_1password-with-chatgpt-atlas]]
- [[chatgpt/chatgpt_ac-not-working-troubleshooting]]
- [[chatgpt/chatgpt_adjusting-parfait-with-pecans]]
- [[chatgpt/chatgpt_arguing-with-facts]]
- [[chatgpt/chatgpt_auth-system-with-toast-pin]]
