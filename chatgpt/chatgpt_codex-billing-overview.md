---
title: "Codex Billing Overview"
type: note
created: 2026-05-26
updated: 2026-05-26
source: chatgpt-export
conversation_id: 6a15ec90-5dec-83e8-8a55-02202b82a112
message_count: 2
tags: [chatgpt, import]
---
# Codex Billing Overview

> Conversation ID: 6a15ec90-5dec-83e8-8a55-02202b82a112
> Created: 2026-05-26T18:55:14Z
> Updated: 2026-05-26T18:55:25Z
> Messages: 2

---

## User

How is codex billed

---

## Assistant

Mr. White, **Codex billing depends on your plan**:

## ChatGPT Plus / Pro

- Codex usage is included up to your plan’s **agentic usage limit**.
- Codex usage counts against the same broad “agentic usage” bucket as Codex, ChatGPT for Excel, and Workspace Agents. The number of usable Codex messages varies based on task size, complexity, and execution environment. citeturn770840search2
- If you hit the limit on Plus or Pro, OpenAI may let you **buy credits** from Codex Settings → Usage → Credits. Free and Go users are prompted to upgrade instead. citeturn770840search9
- As of OpenAI’s current Pro pricing page, Pro $100 has a temporary Codex usage promo through **May 31, 2026**, and Pro $200 includes higher ongoing Codex usage. citeturn770840search1

## ChatGPT Business

Business has two relevant seat types:

| Seat type | Access | Billing |
|---|---:|---:|
| Standard ChatGPT seat | ChatGPT + baseline Codex | Fixed per-user monthly cost |
| Codex seat | Codex only | Usage-based, no fixed seat fee |

Standard Business seats are fixed-price: **$25/user/month monthly** or **$20/user/month annual**, with a 2-seat minimum. Codex-only seats have **no fixed monthly seat fee** and are billed based on usage through workspace credits. citeturn770840search0turn770840search6

## How usage is metered

Codex usage is now priced based on **token usage**, expressed as credits per million:

- input tokens
- cached input tokens
- output tokens

OpenAI says this replaced average per-message estimates with a direct token-to-credit mapping. citeturn770840search3

## Practical answer

For you:

- If you’re using **ChatGPT Pro**, you’re mostly dealing with a **monthly included usage cap**, then optional credits after.
- If you spin up **Business Codex seats**, it becomes closer to **pay-as-you-go engineering-agent usage**, with workspace credits and spend controls.
- For heavy Jovie coding loops, the cost driver is likely **long context + repeated repo reads + output-heavy patches/reviews**, rather than simple message count.


## See Also
- [[chatgpt/chatgpt_codex-billing-for-high]]
- [[chatgpt/chatgpt_codex-cli-overview]]
- [[chatgpt/chatgpt_codex-max-overview]]
- [[chatgpt/chatgpt_clerk-billing-overview]]
- [[chatgpt/chatgpt_chatgpt-vs-gpt-51-codex]]
