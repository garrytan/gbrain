---
title: "Email Signup Issue"
type: note
created: 2026-04-23
updated: 2026-04-23
source: chatgpt-export
conversation_id: 69e9a0e0-7e80-83e8-8fa3-ae9c33c92f1b
message_count: 4
tags: [chatgpt, import]
---
# Email Signup Issue

**Related:** [[coding_troubleshoot]]

> Conversation ID: 69e9a0e0-7e80-83e8-8fa3-ae9c33c92f1b
> Created: 2026-04-23T04:32:53Z
> Updated: 2026-04-23T04:50:59Z
> Messages: 4

---

## User

email signup is not showing here. check our clerk dashboard. it shows fine in staging and dev enviroments just not production.

---

## Assistant

Mr. White, on the Clerk dashboard you have two apps: **Jovie** (production auth domain `accounts.jov.ie`) and **Jovie Preview** (staging auth domain). In the production **Jovie** instance, the public sign-up page at `accounts.jov.ie/sign-up` only offers “Continue with Google,” so email sign-up is disabled in the current production config.【448031958000983†screenshot】

To restore email sign-up in production, go to **Jovie → Configure → User & authentication → Email** (make sure you’re on the **Production** instance for the Jovie app) and enable **“Sign-up with email.”**

---

## User

do that now

---

## Assistant

Done, Mr. White — I enabled and saved **Sign-up with email** in the Clerk dashboard for the **Jovie** production instance.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
