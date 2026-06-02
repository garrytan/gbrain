---
title: "Contrastive Negation Framing"
type: note
created: 2026-02-25
updated: 2026-02-25
source: chatgpt-export
conversation_id: 699f3dc0-4d94-832a-a7dd-3a4c6bd240bf
message_count: 2
tags: [chatgpt, import]
---
# Contrastive Negation Framing

> Conversation ID: 699f3dc0-4d94-832a-a7dd-3a4c6bd240bf
> Created: 2026-02-25T18:22:11Z
> Updated: 2026-02-25T18:23:36Z
> Messages: 2

---

## User

Yes, Mr. White.

That pattern is a **contrastive correction** (a kind of **antithesis** / **reframing-by-negation**).

### The pattern LLMs overuse

Common forms:

* **“This is not X, it’s Y.”**
* **“It’s not about X; it’s about Y.”**
* **“This isn’t just X — it’s Y.”**
* **“Not X, but Y.”**
* **“Less X, more Y.”**

### Why LLMs do it

LLMs learned a lot of internet/business/editorial writing, where this structure is used because it sounds:

* punchy
* confident
* “insightful”
* persuasive

But in practice it often reads like a cliché and can create fake oppositions.

---

## Instructions to prevent it (copy/paste into your prompt)

Use this in your system or style prompt:

* **Do not use contrastive negation framing** (e.g., “not X, but Y,” “this is not X, it’s Y,” “it’s not about X; it’s about Y”).
* **State the point directly** instead of defining it by what it is not.
* **Avoid rhetorical antithesis** unless explicitly requested.
* **Prefer precise explanation over punchy contrast.**
* If a sentence uses **not/but** to create emphasis, **rewrite it as a plain declarative sentence**.
* **Do not manufacture oppositions** (“X vs Y”) unless the distinction is necessary and factual.

---

## Stronger version (if you want to really suppress it)

* **Ban all “not X, but Y” constructions**
* **Ban “isn’t just… it’s…” phrasing**
* **Ban “it’s not about…” phrasing**
* **Minimize rhetorical flourishes; use neutral, literal prose**

---

## Good replacements (what to ask for instead)

Instead of:

* “This is not a growth problem, it’s an execution problem.”

Use:

* “This is primarily an execution problem.”
* “The main constraint is execution.”
* “Execution is the bottleneck here.”

---

## Optional QA rule (post-check)

Add this instruction:

* **Before finalizing, scan for sentences that use “not … but …” or “isn’t … it’s …” and rewrite them.**

If you want, I can also give you a **full anti-LLM-style prompt** (for removing other tells like em dashes, “crucially,” “it’s worth noting,” etc.).


take the above condense it a concise rule and add to my chatgpt personaizlation settings

---

## Assistant

Yes, Mr. White.

I can’t directly add a **custom writing rule** through the settings tool here — it only supports switching the **personality preset** (your current preset is **Default**).

Use this as a concise rule in your custom instructions / personalization notes:

- **Avoid contrastive-negation framing** (“not X, but Y,” “it’s not about X; it’s about Y,” “isn’t just X—it’s Y”). **State the point directly in plain declarative language** and use contrasts only when factually necessary.

Optional stricter version:

- **Rewrite any “not…but…” / “isn’t just…it’s…” phrasing into direct statements before sending.**

If you want, I can also switch your personality preset to **Efficient** (best match for this style).


## See Also
- [[chatgpt/chatgpt_llm-contrastive-correction]]
- [[chatgpt/chatgpt_cnn-outrage-framing-debate]]
- [[chatgpt/chatgpt_framing-vs-pouring-concrete]]
- [[chatgpt/chatgpt_yc-and-a16z-framing-part1]]
- [[chatgpt/chatgpt_yc-and-a16z-framing-part2]]
