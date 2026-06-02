---
title: "Prompting in Modern Coding"
type: note
created: 2025-12-30
updated: 2025-12-30
source: chatgpt-export
conversation_id: 69531f28-44dc-8328-9aa7-ddbff60d892f
message_count: 4
tags: [chatgpt, import]
---
# Prompting in Modern Coding

> Conversation ID: 69531f28-44dc-8328-9aa7-ddbff60d892f
> Created: 2025-12-30T00:39:05Z
> Updated: 2025-12-30T00:41:24Z
> Messages: 4

---

## User

how important is promting in claude code and gpt 5.2-codex etc. Do i still need comprehensive prompts in a certain format or can a simple question get me there?

---

## Assistant

Mr. White,

**Short answer:** prompting still matters, but **far less than it used to**. With modern coding models (Claude Code, GPT-5.2-Codex–class systems), *clarity of intent* matters more than *prompt engineering gymnastics*.

---

## 1. What changed vs older models
Older GPT-3 / early GPT-4 models:
- Needed rigid formats (“You are a senior engineer…”, step-by-step instructions).
- Were sensitive to missing constraints.
- Hallucinated structure if you didn’t specify it.

Modern coding models:
- Maintain long-range context.
- Infer intent, language, and framework defaults.
- Self-correct when you iterate.
- Are trained on real code review + PR workflows, not just completions.

**Result:** a clean, plain English request often works.

---

## 2. When a simple prompt *is enough*
A simple question like:

> “Add pagination to this React table and keep it accessible.”

is usually sufficient **if**:
- The task is local and well-scoped
- You provide the relevant code/context
- You’re okay with 80–90% correctness on the first pass

This is now the **default workflow**.

---

## 3. When comprehensive prompts still matter
You still want structured prompting when:

### A. Architectural decisions
- Multi-service systems
- Tradeoffs (latency vs cost, SQL vs NoSQL, etc.)
- Security / compliance constraints

Example upgrade:
> “Design this as if it must scale to 1M MAU, prioritize debuggability over raw performance.”

### B. Non-obvious constraints
- Legacy systems
- Company conventions
- Performance ceilings
- Style or API guarantees

Models **cannot guess** hidden constraints.

### C. High-risk code
- Auth
- Payments
- Concurrency
- Memory management
- Crypto

Here, explicit instructions still materially improve outcomes.

---

## 4. Best modern prompting pattern (practical)
Forget long role-play prompts. Use **this 4-line mental model**:

1. **Context** – “Here’s the code / system.”
2. **Goal** – “I want X outcome.”
3. **Constraints** – “Must / must not.”
4. **Output expectation** – “Show diff / full file / explanation.”

Example:
> “Here’s a Node API using Express. I want to add rate limiting.  
> Must be Redis-backed and production-safe.  
> Show the minimal diff.”

That’s enough.

---

## 5. Iteration beats upfront perfection
The biggest shift:
- **Iteration > prompt perfection**
- Treat the model like a junior-to-mid engineer you can rapidly course-correct.

First answer wrong?
> “No — latency is more important than throughput. Rework.”

This is faster than crafting a 300-word prompt.

---

## 6. Bottom line
- ❌ You no longer need rigid prompt templates.
- ❌ You don’t need “act as a senior engineer” fluff.
- ✅ You *do* need clear intent and real constraints.
- ✅ Simple questions work surprisingly well.
- ✅ Complex systems still benefit from explicit framing.

If you want, I can give you **prompt patterns optimized specifically for Claude Code vs Codex-style models** — they *do* differ slightly in how they respond to ambiguity.

---

## User

whats the highest ROI other learnings you can tell me concisely

---

## Assistant

Mr. White,

Here are **high-ROI learnings** that consistently separate people who *use* modern models from those who *compound with them*—kept tight and practical.

---

## 1. Iteration speed beats prompt quality
**ROI:** Extremely high  
- Fire a quick prompt → correct → refine.
- 3 short turns outperform 1 “perfect” prompt.
- Treat models like fast junior engineers, not oracles.

**Rule:** If your first prompt takes >30 seconds, you’re overthinking it.

---

## 2. Context > clever wording
**ROI:** Extremely high  
- Paste real code, schemas, logs, or examples.
- Models reason *from artifacts*, not abstractions.

**Rule:** Add concrete input before adding adjectives.

---

## 3. Explicit constraints prevent 80% of bad output
**ROI:** Very high  
Always state:
- Must / must not
- Performance or cost ceilings
- Compatibility targets

**Example:**  
> “Must run in <50ms P95, no new dependencies.”

---

## 4. Ask for diffs, not explanations
**ROI:** Very high  
- “Show a minimal diff”
- “Only output the modified function”
- “Return a patch”

This reduces noise and hallucination.

---

## 5. Force verification when correctness matters
**ROI:** High  
Use:
- “List assumptions before answering”
- “Call out uncertainties”
- “What would break this in production?”

Models will surface risks you didn’t ask about.

---

## 6. Use models to *think*, not just write
**ROI:** High  
High-leverage prompts:
- “What’s the simplest version of this?”
- “What am I overengineering?”
- “What would you remove?”

This consistently yields better decisions than output-only usage.

---

## 7. Separate exploration from execution
**ROI:** High  
- First: open-ended reasoning (“options + tradeoffs”)
- Then: constrained execution (“pick one and implement”)

Mixing them degrades both.

---

## 8. Don’t trust defaults
**ROI:** Medium–High  
Models assume:
- Modern frameworks
- Happy paths
- Ideal infra

Override defaults explicitly when they matter.

---

## 9. Models are better critics than creators
**ROI:** Medium–High  
- Write something yourself.
- Ask the model to *tear it apart*.

This produces sharper output than greenfield generation.

---

## 10. Your bottleneck is taste, not capability
**ROI:** Foundational  
- Models are fast and capable.
- Most wasted value comes from accepting mediocre output too early.

**Rule:** If you wouldn’t ship it from a human, don’t ship it from a model.

---

### One-sentence summary
**Move fast, give real context, state constraints, iterate aggressively, and use models as critics and thinking partners—not magic generators.**

If you want, I can condense this into a **one-page operating system for using AI in startups**.


## See Also
- [[chatgpt/chatgpt_codex-52-prompting-guide]]
- [[chatgpt/chatgpt_actor-in-modern-family]]
- [[chatgpt/chatgpt_clowning-before-modern-family]]
- [[chatgpt/chatgpt_commentary-on-modern-poetry]]
- [[chatgpt/chatgpt_harold-grossman-modern-family]]
