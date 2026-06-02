---
title: "LLM Contrastive Correction"
type: note
created: 2026-02-25
updated: 2026-02-25
source: chatgpt-export
conversation_id: 699f3837-06a8-8333-9296-0b306f8f721a
message_count: 2
tags: [chatgpt, import]
---
# LLM Contrastive Correction

> Conversation ID: 699f3837-06a8-8333-9296-0b306f8f721a
> Created: 2026-02-25T17:58:38Z
> Updated: 2026-02-25T18:21:45Z
> Messages: 2

---

## User

can yo identify the patter llms have for saying things like "this is not x its y" in their writing? and the instructions i need to rpevent it

---

## Assistant

Yes, Mr. White.

That pattern is a **contrastive correction** (a kind of **antithesis** / **reframing-by-negation**).

### The pattern LLMs overuse
Common forms:
- **“This is not X, it’s Y.”**
- **“It’s not about X; it’s about Y.”**
- **“This isn’t just X — it’s Y.”**
- **“Not X, but Y.”**
- **“Less X, more Y.”**

### Why LLMs do it
LLMs learned a lot of internet/business/editorial writing, where this structure is used because it sounds:
- punchy
- confident
- “insightful”
- persuasive

But in practice it often reads like a cliché and can create fake oppositions.

---

## Instructions to prevent it (copy/paste into your prompt)

Use this in your system or style prompt:

- **Do not use contrastive negation framing** (e.g., “not X, but Y,” “this is not X, it’s Y,” “it’s not about X; it’s about Y”).
- **State the point directly** instead of defining it by what it is not.
- **Avoid rhetorical antithesis** unless explicitly requested.
- **Prefer precise explanation over punchy contrast.**
- If a sentence uses **not/but** to create emphasis, **rewrite it as a plain declarative sentence**.
- **Do not manufacture oppositions** (“X vs Y”) unless the distinction is necessary and factual.

---

## Stronger version (if you want to really suppress it)
- **Ban all “not X, but Y” constructions**
- **Ban “isn’t just… it’s…” phrasing**
- **Ban “it’s not about…” phrasing**
- **Minimize rhetorical flourishes; use neutral, literal prose**

---

## Good replacements (what to ask for instead)
Instead of:
- “This is not a growth problem, it’s an execution problem.”

Use:
- “This is primarily an execution problem.”
- “The main constraint is execution.”
- “Execution is the bottleneck here.”

---

## Optional QA rule (post-check)
Add this instruction:
- **Before finalizing, scan for sentences that use “not … but …” or “isn’t … it’s …” and rewrite them.**

If you want, I can also give you a **full anti-LLM-style prompt** (for removing other tells like em dashes, “crucially,” “it’s worth noting,” etc.).
