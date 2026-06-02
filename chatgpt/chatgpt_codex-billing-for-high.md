---
title: "Codex Billing for High"
type: note
created: 2026-04-08
updated: 2026-04-08
source: chatgpt-export
conversation_id: 69d6cc0e-1a00-83e8-9184-a2ac0b154a07
message_count: 3
tags: [chatgpt, import]
---
# Codex Billing for High

> Conversation ID: 69d6cc0e-1a00-83e8-9184-a2ac0b154a07
> Created: 2026-04-08T21:43:56Z
> Updated: 2026-04-08T21:44:50Z
> Messages: 3

---

## User

does codex bill more for high and extra high

---

## Assistant

I’m checking the current OpenAI docs and pricing pages to verify whether “High” and “Extra high” change billing.

---

## Assistant

Yes. In Codex, **High** and **Extra high / xhigh** can increase what you pay or how fast you burn credits, because higher reasoning effort uses more reasoning tokens, and OpenAI says reasoning tokens are billed as **output tokens**. OpenAI also states that reducing reasoning effort usually means fewer reasoning tokens, while `xhigh` should be used only when the extra latency and cost are justified. citeturn359805view1turn359805view2

For **Codex billing specifically**, OpenAI’s current rate card says usage is based on **input, cached input, and output tokens**, and actual credit usage depends on that token mix. It also says **output-heavy tasks consume more credits**. That means higher reasoning effort usually costs more indirectly, even though there is no separate line item labeled “High” or “xHigh.” citeturn156928view0

If you use Codex through a **ChatGPT plan**, your included usage is consumed first, and after you hit plan limits, Codex starts drawing from your purchased credits. citeturn156928view1turn156928view0

Separate from reasoning effort, **Fast mode** is explicitly billed at **2x credits** in the Codex rate card. citeturn156928view0

So the practical answer is: **yes, High and xHigh generally bill more in token-based Codex usage, because they tend to generate more billed reasoning/output tokens.**


## See Also
- [[chatgpt/chatgpt_codex-billing-overview]]
- [[chatgpt/chatgpt_chatgpt-vs-gpt-51-codex]]
- [[chatgpt/chatgpt_cheapest-codex-usage-options]]
- [[chatgpt/chatgpt_codex-51-vs-claude-45]]
- [[chatgpt/chatgpt_codex-52-for-refactoring]]
