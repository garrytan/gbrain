---
title: "Slash Commands vs Agent Skills"
type: guide
created: 2026-01-13
updated: 2026-01-13
source: chatgpt-export
conversation_id: 6966d143-49c4-8330-b6f3-7c5d6f9a477e
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Slash Commands vs Agent Skills

> Conversation ID: 6966d143-49c4-8330-b6f3-7c5d6f9a477e
> Created: 2026-01-13T23:12:03Z
> Updated: 2026-01-13T23:18:15Z
> Messages: 6

---

## User

slash commands vs agent skills

---

## Assistant

Mr. White,

**Slash commands** and **agent skills** solve different problems. Here’s the clean distinction.

---

## Slash commands
**What they are:**  
User-invoked shortcuts (e.g. `/summarize`, `/translate`) that run a **single, predefined action**.

**Key traits**
- Explicitly triggered by the user  
- Stateless or minimally stateful  
- Fast, predictable, low risk  
- No autonomy

**Best used for**
- Formatting, transformations, lookups  
- Repetitive micro-tasks  
- Power-user efficiency

**Mental model:** *CLI commands for an LLM*

---

## Agent skills
**What they are:**  
Reusable **capabilities an autonomous agent can decide to use** while pursuing a goal.

**Key traits**
- Chosen by the agent, not the user  
- Goal-driven, multi-step  
- Can chain tools, reason, and adapt  
- Often stateful and contextual

**Best used for**
- Research, planning, execution loops  
- Multi-step workflows  
- Acting on behalf of the user (within constraints)

**Mental model:** *Tools in a toolbox for an AI worker*

---

## Side-by-side

| Dimension | Slash Commands | Agent Skills |
|---------|---------------|--------------|
| Trigger | User | Agent |
| Autonomy | None | High |
| Scope | Single action | Multi-step |
| Predictability | Very high | Variable |
| UX | Explicit | Implicit |
| Risk | Low | Higher (needs guardrails) |

---

## Practical rule
- **Need speed + certainty?** Use **slash commands**.  
- **Need outcomes + delegation?** Use **agent skills**.

If you want, I can map this to product design decisions or startup architecture tradeoffs.

---

## User

so give me a rpactical example

---

## Assistant

Mr. White,

Here’s a **concrete, real-world example** using the *same product* to show the difference clearly.

---

## Scenario: You’re running a startup and preparing for an investor meeting

### Slash command example
You type:

```
/summarize pitch_deck.pdf
```

**What happens**
- The system summarizes the deck
- One-shot execution
- No follow-up, no decisions

**Why this is a slash command**
- You explicitly asked for a specific action
- The system didn’t decide *what* to do next
- Output is immediate and bounded

---

### Agent skill example
You say:

> “Help me get ready for my investor meeting tomorrow.”

**What the agent does (autonomously)**
1. Reviews your pitch deck  
2. Notices missing TAM clarity  
3. Uses its **market research skill** to pull comps  
4. Uses its **financial modeling skill** to sanity-check projections  
5. Uses its **writing skill** to rewrite slides 7–9  
6. Generates likely investor objections  
7. Prepares a mock Q&A

**Why these are agent skills**
- You never invoked them directly
- The agent chose which skills to use
- Multi-step reasoning toward an outcome
- Persistent context across steps

---

## Same capability, different control

Think of it this way:

- Slash command: **“Do exactly this.”**
- Agent skill: **“Achieve this outcome.”**

---

## Product design takeaway (important)
- Slash commands are **UX features**
- Agent skills are **system capabilities**
- Mature products often expose *both*:
  - Slash commands for power users
  - Agents for delegation and leverage

If you want, I can give a **technical architecture example** (APIs, permissioning, guardrails) or a **founder-level decision framework** for when to ship each.

---

## User

okay so for next.js, clerk, drizzle, neon db, stripe, tanstack table vitrtilzstion query and pacer, and nuqs in turbo repo with github actions ci.

whats some skills we should have and some hooks

my thouhgts: crtiqiue and expand:
biome on every edit
a PR skill that auto name and fills out pr but also runs typecheck and biome and unit tests (only for affected files) and sets pr to auto merge

Skills for ideation: identify top offenders in code quality, performance, security, ux, code imrpvoements etc each seperately.

and then i want to be able to ask frequently whst to work on next and have it surface top ideas.
also would be good for our agents to talk to linear more closely, checking in on open issues so a slash command can pull latest linear issues, triage them, and pick top one to work on, then finish it and open a pr. etc

---

## Assistant

Mr. White,

You’re thinking in the **right direction**. What you have is good; it’s just **under-scoped, under-guardrailed, and missing a clear split between hooks vs skills**. I’ll critique first, then expand into a clean system.

---

## First: sharpen the mental model

- **Hooks** = *signals + triggers* (cheap, frequent, deterministic)
- **Skills** = *capabilities* (expensive, agent-invoked, goal-driven)

Your mistake would be letting skills fire too often. Most of this should be **hook-driven escalation**.

---

## Critique of your ideas

### 1. “Biome on every edit”
**Good instinct, wrong layer.**

- This is **not an agent skill**
- This is a **pre-commit / editor hook**
- Agent involvement here is wasteful

**Correct form**
- Hook: `onSave` or `pre-commit`
- Tooling: Biome, typecheck, lint
- Agent only gets involved **if failure patterns repeat**

👉 Promote *patterns*, not *events*, to agents.

---

### 2. “PR skill that auto names, fills PR, runs checks, auto-merges”
**This *is* a real agent skill — but needs constraints.**

Problems:
- “Runs unit tests only for affected files” is non-trivial
- Auto-merge without risk classification is dangerous

Fix:
Split into **3 skills + 2 hooks**

---

## Proposed architecture (clean + scalable)

### 🔹 Core Hooks (always-on, cheap)

#### 1. Code Change Hook
Triggered on:
- git diff
- CI failure
- perf regression
- flaky test

Emits:
- changed packages (Turbo graph)
- affected routes/components
- risk score (low / medium / high)

---

#### 2. CI Result Hook (GitHub Actions)
Triggered on:
- failure
- slowdown
- repeated warnings

Feeds:
- quality agent
- performance agent
- reliability agent

---

#### 3. Linear Sync Hook
Triggered on:
- issue opened
- issue stale
- sprint start/end

Keeps:
- agent world model in sync
- prevents hallucinated priorities

---

## 🔹 Agent Skills (invoked selectively)

### 1. **PR Authoring Skill** (refined)
What it *should* do:
- Name PR semantically (`feat(auth): add passkey support`)
- Generate description from diff + Linear issue
- Decide:
  - run full test suite vs affected tests
  - auto-merge eligibility

Auto-merge **only if**:
- low risk score
- no schema changes
- no auth/payments touched
- green CI twice (retry once for flakes)

---

### 2. **Code Quality Auditor Skill**
Runs on schedule or when asked:
- cyclomatic complexity
- dead code
- leaky abstractions
- Drizzle query misuse
- TanStack Query anti-patterns
- Nuqs misuse (URL state abuse)

Outputs:
- ranked list
- estimated effort
- expected payoff

---

### 3. **Performance Profiler Skill**
Specifically for your stack:
- Next.js route waterfalls
- RSC misuse
- Over-fetching via TanStack Query
- Neon cold-start amplification
- Stripe webhook latency

This is *not* run constantly.
Triggered by:
- Web Vitals regression
- user complaint
- deploy diff touching data paths

---

### 4. **Security & Risk Skill**
Targets:
- Clerk auth boundaries
- Stripe idempotency errors
- webhook replay risks
- server action exposure
- leaked env vars in CI

Runs:
- weekly
- before major releases

---

### 5. **UX Friction Detector**
Inputs:
- session replays (if you have them)
- support tickets
- rage clicks
- drop-off funnels

Outputs:
- “Top 3 UX offenders”
- with *code-level suggestions*

---

## 🔹 Ideation & Prioritization (this is where you’re strongest)

### 6. **“What should we work on next?” Skill**
This is the *CEO agent*.

Inputs:
- Linear backlog
- open PRs
- recent regressions
- quality/perf/security debt
- business metrics (if available)

Scoring function:
- user impact
- revenue risk
- effort
- confidence

Output:
- Top 3 recommendations
- Clear “why now”
- Suggested owner (human or agent)

---

## 🔹 Slash Commands (explicit control)

These are **power tools**, not autonomy.

Examples you absolutely should have:

- `/linear sync`
- `/linear triage`
- `/pick-next-issue`
- `/fix-top-offender quality|perf|security|ux`
- `/open-pr from-linear-123`
- `/audit area=auth|billing|db`
- `/why-is-this-slow route=/dashboard`

Slash commands **invoke skills**, but never decide scope on their own.

---

## Final guidance (important)

**Do NOT**
- let agents run continuously
- auto-merge medium/high risk changes
- blur hooks and skills

**DO**
- make hooks noisy, skills selective
- centralize prioritization
- treat agents like senior engineers with guardrails

If you want next, I can:
- design the **risk scoring heuristic**
- sketch a **TurboRepo-aware test selection algorithm**
- or map this into a **12-week rollout plan** for a real team
