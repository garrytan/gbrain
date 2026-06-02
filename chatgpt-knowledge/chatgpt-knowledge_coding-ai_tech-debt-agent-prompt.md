---
title: "Tech Debt Agent Prompt"
type: essay
created: 2026-01-03
updated: 2026-01-03
source: chatgpt-export
topic: coding-ai
message_count: 12
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Tech Debt Agent Prompt

> **Source:** ChatGPT conversation
> **Date:** 2026-01-03T22:40:01Z
> **Messages:** 12
> **Topic:** coding-ai

## Question

Our app has the following instructions
## 17. Tech Debt Tracking (REQUIRED)

 

AI agents **must** maintain the tech debt tracker at `TECH_DEBT_TRACKER.md` in the repo root.

 

### When to Update the Tracker

 

**You MUST update `TECH_DEBT_TRACKER.md` when:**

 

1. **Fixing tech debt:** Move items from "Open Issues" to "Resolved Issues"

2. **Discovering new tech debt:** Add items to the appropriate "Open Issues" section

3. **Completing refactoring tasks:** Update the metrics dashboard
In the agent.md file. I want to have an agent recursively run through and grab some tasks, tackle them, run lint and type check and tests and ensure they all pass, then update the file and pr and then rebase off main and then repeat. It should only stop when the whole md file has been tackled. Please write a prompt. The agent has full visibility into code base so no need to specify stack etc.

## Answer

Mr. White — here’s a ready-to-paste **agent prompt** that enforces your `TECH_DEBT_TRACKER.md` rules and iterates until the tracker is fully addressed.

```text
You are an autonomous engineering agent working in a git repo. Your mission is to completely tackle ALL items in TECH_DEBT_TRACKER.md (repo root) and stop only when there are no remaining actionable items in “Open Issues” (or equivalent open sections).

Hard requirements (must follow):
- You MUST maintain the tech debt tracker at TECH_DEBT_TRACKER.md.
- You MUST update TECH_DEBT_TRACKER.md when:
  1) Fixing tech debt: move items from “Open Issues” to “Resolved Issues”
  2) Discovering new tech debt: add items to the appropriate “Open Issues” section
  3) Completing refactoring tasks: update the metrics dashboard in agent.md
- Every change must be validated by running lint, typecheck, and tests; all must pass before you open/update a PR.
- Work in small, reviewable increments (one item or a tight cluster per loop). Prefer minimal risk and minimal surface-area.
- Never mark an item as resolved unless it is fully done and verified by the checks.

Operating loop (repeat until done):
1) Sync & baseline
   - Checkout main, pull latest.
   - Create a fresh working branch for this loop (or reuse a single “tech-debt-sweep” branch if your workflow prefers).
   - Read TECH_DEBT_TRACKER.md thoroughly.
   - Build a concrete TODO list of all remaining Open Issues, in priority order (prefer: highest impact, easiest, most blocking).

2) Select work
   - Pick the next single Open Issue (or smallest coherent bundle) that you can finish end-to-end safely.
   - If the issue is ambiguous, inspect code, history, and surrounding docs; choose a reasonable interpretation and proceed.

3) Implement
   - Make the necessary code changes.
   - If you uncover additional tech debt while working, immediately add it to the correct Open Issues section in TECH_DEBT_TRACKER.md (do not hide it).
   - If you complete a refactor task that affects tracked metrics, update the metrics dashboard in agent.md accordingly.

4) Verify (must be clean)
   - Run lint.
   - Run typecheck.
   - Run tests (unit/integration as appropriate).
   - If anything fails, fix until all checks pass. Do not proceed while red.

5) Update tracker (required)
   - Move the completed item(s) from Open Issues to Resolved Issues in TECH_DEBT_TRACKER.md.
   - For each resolved item, add a short resolution note: what changed, where, and how it was verified (commands run / test scope).

6) PR
   - Commit with clear messages referencing the tracker item(s).
   - Open or update a PR.
   - PR description must include:
     - Which tracker items were resolved (links/anchors if possible)
     - Summary of changes
     - Verification: lint/typecheck/test commands and results
     - Any new tech debt entries added

7) Rebase & keep green
   - Rebase the branch on latest main.
   - Resolve conflicts carefully.
   - Re-run lint, typecheck, tests; ensure still green.
   

*(Answer truncated — 4044 chars total)*

## Question

Yeah and also have it check open prs and see if anything failed, and also it should check the comments from code reviewers and address them and update them. 

## Answer

```text
You are an autonomous engineering agent working in a git repo. Your mission is to completely tackle ALL items in TECH_DEBT_TRACKER.md (repo root) and stop only when there are no remaining actionable items in “Open Issues” (or equivalent open sections).

Hard requirements (must follow):
- You MUST maintain the tech debt tracker at TECH_DEBT_TRACKER.md.
- You MUST update TECH_DEBT_TRACKER.md when:
  1) Fixing tech debt: move items from “Open Issues” to “Resolved Issues”
  2) Discovering new tech debt: add items to the appropriate “Open Issues” section
  3) Completing refactoring tasks: update the metrics dashboard in agent.md
- Every change must be validated by running lint, typecheck, and tests; all must pass before you open/update a PR.
- Work in small, reviewable increments (one item or a tight cluster per loop). Prefer minimal risk and minimal surface-area.
- Never mark an item as resolved unless it is fully done and verified by the checks.
- You MUST continuously triage existing open PRs: fix failing checks and address reviewer comments before starting new work, unless a PR is clearly unrelated and owned by someone else.

Pre-loop PR triage (do this at the start of EVERY cycle):
0) Inventory open PRs
   - List all open PRs in the repo.
   - For each PR, capture: title, purpose, author, last update time, CI status, and whether it touches TECH_DEBT_TRACKER.md / agent.md.
   - Prioritize in this order:
     A) PRs authored by you (or your agent identity)
     B) PRs that are failing CI
     C) PRs with unresolved reviewer comments / change requests
     D) PRs that modify TECH_DEBT_TRACKER.md, debt-related areas, or shared infrastructure

0a) Fix failing PRs
   - For any PR with failing checks that you can reasonably fix:
     - Pull the PR branch, reproduce failures locally, fix root cause.
     - Run lint, typecheck, tests locally until green.
     - Push updates and confirm CI is passing.

0b) Address reviewer feedback
   - For any PR with reviewer comments/requests that you can address:
     - Enumerate each actionable comment.
     - Implement fixes (or respond with a clear technical rationale when you disagree).
     - Reply in the PR thread for each comment with what changed and where.
     - If the comment reveals additional tech debt, add it to TECH_DEBT_TRACKER.md Open Issues.

0c) Close the loop
   - If a PR becomes merge-ready and you have permission: merge it.
   - If you cannot merge: clearly mark it “ready” and request re-review.
   - Rebase onto latest main and re-run lint/typecheck/tests if needed.

Operating loop (repeat until tracker is fully addressed):
1) Sync & baseline
   - Checkout main and pull latest.
   - Read TECH_DEBT_TRACKER.md thoroughly.
   - Build a concrete TODO list of all remaining Open Issues, in priority order (prefer: highest impact, easiest, most blocking).

2) Select work
   - Pick the next single Open Issue (or smallest coherent bundle) that you can finish end-to-end safely.
   - If the issue is a

*(Answer truncated — 5559 chars total)*

## Question

How does she 1.5 compare to get 5.2 5.2 codex and opus 4.5

## Answer

Mr. White — here’s a **clear, factual comparison** focused on *capability, reliability, and agentic work*, not hype.

---

## High-level summary

| Model | Primary Strength | Weakness | Best Use |
|---|---|---|---|
| **She-1.5** | Fast, cheap, good general reasoning | Shallow on complex codebases, weaker long-horizon planning | Simple agents, CRUD logic, lightweight refactors |
| **GPT-5.2** | Strong general reasoning + tool use | Can be verbose, still fallible on deep code archaeology | Default “workhorse” agent |
| **GPT-5.2 Codex** | Code accuracy, repo-wide understanding, PR-quality diffs | Narrower outside coding | Large refactors, debt payoff, CI/debug loops |
| **Opus 4.5** | Deep reasoning, consistency, long-horizon planning | Slower, more expensive | Complex agents, multi-PR initiatives, policy-heavy systems |

---

## Detailed breakdown

### **She-1.5**
- **Reasoning depth:** Medium–low  
- **Code understanding:** Localized; struggles with large repos  
- **Agent reliability:** Degrades over long loops  
- **Typical failure mode:** “Looks right” changes that miss edge cases  

**Verdict:**  
Good for *cheap, fast* tasks. **Not suitable** for recursive tech-debt elimination with CI + PR feedback loops.

---

### **GPT-5.2**
- **Reasoning depth:** High  
- **Code understanding:** Strong across files/modules  
- **Tool use:** Very good  
- **Typical failure mode:** Overconfidence, sometimes over-engineers  

**Verdict:**  
Solid default. Works well if guarded by strict instructions (like your tracker rules).

---

### **GPT-5.2 Codex**
- **Reasoning depth:** High (code-specific)  
- **Code understanding:** **Best-in-class** for large repos  
- **CI / test debugging:** Excellent  
- **Typical failure mode:** Less creative outside code  

**Verdict:**  
**Best choice for your use case**:
- Tech debt tracking
- Recursive refactors
- Lint/typecheck/test loops
- Reviewer comment resolution
- Rebase + CI hygiene  

If you run *one* model for this agent, use **GPT-5.2 Codex**.

---

### **Opus 4.5**
- **

## Question

Swe 1.5


## Answer

Mr. White — here is the **corrected comparison with SWE-1.5** (not “She”).

## Bottom line (direct answer)
**SWE-1.5 is weaker than GPT-5.2 Codex and Opus 4.5 for your use case**, and roughly on par or slightly below base GPT-5.2 for large, long-running agentic workflows.

---

## SWE-1.5 vs others (focused on agentic code work)

| Model | Repo-scale code | Long loops | CI / test debugging | Reviewer feedback handling | Verdict |
|---|---|---|---|---|---|
| **SWE-1.5** | Medium | Weak–medium | Medium | Weak | ❌ Not ideal |
| **GPT-5.2** | High | High | High | Medium–high | ✅ Good |
| **GPT-5.2 Codex** | **Very high** | **Very high** | **Excellent** | **High** | ✅ **Best** |
| **Opus 4.5** | High | **Excellent** | High | **Excellent** | ⚠️ Overkill |

---

## SWE-1.5 (what it’s actually good at)
- Fast, cheaper
- Single-issue fixes
- Small diffs
- Straightforward refactors
- Limited CI debugging

### Where SWE-1.5 fails for your workflow
Your agent requires:
- Recursive traversal of `TECH_DEBT_TRACKER.md`
- Multi-PR state tracking
- CI failure diagnosis
- Reviewer comment resolution
- Rebase discipline
- Stopping only at global completion

**SWE-1.5 degrades over long horizons**:
- Loses tracker state
- Misses reviewer comments
- Marks items “done” prematurely
- Re-introduces debt

---

## Recommendation (fact-based)
- ❌ **Do not** use SWE-1.5 for this agent
- ✅ **Use GPT-5.2 Codex** as the primary model
- ⚠️ Use Opus 4.5 only if:
  - You want maximum reasoning consistency
  - Cost/latency are irrelevant
  - The repo is extremely complex or political

### Ideal setup
- **Primary:** GPT-5.2 Codex  
- **Fallback / planner:** Opus 4.5  
- **Never:** SWE-1.5 for recursive debt elimination

If you want, I can also rewrite your agent prompt to **explicitly guard against SWE-1.5-style failure modes** (false completion, tracker drift, CI blindness).

## Question

To maximize value, can you give me a recommendation for having one model open linear issues and swe-1.5 which is free for us to tackle those issues recurcsily til they're all done?

What would be best for this? Were using windsurf so we have all those models with various pricing.

## Answer

Mr. White — yes, this **two-model split is exactly the right way** to maximize value with Windsurf. Here’s the **cleanest, lowest-risk architecture** that works in practice.

---

## Goal restated (correctly)
- **Expensive / strong model**: decides *what* to do (Linear issues, scope, sequencing, acceptance criteria).
- **Free / cheap model (SWE-1.5)**: does the *mechanical execution* repeatedly until exhaustion.
- System must be **self-correcting** and **non-lying** (no false “done”).

---

## Recommended setup (battle-tested pattern)

### 1️⃣ **Planner / Issuer Model (Paid, Low Frequency)**
**Best choice:** **GPT-5.2 Codex**  
**Runner-up:** Opus 4.5 (only if cost is irrelevant)

**Responsibilities (ONLY these):**
- Read `TECH_DEBT_TRACKER.md`
- Open / update **Linear issues**
- Define:
  - Exact acceptance criteria
  - Required files
  - Commands to run
  - “Done” definition
- Chunk work into **SWE-1.5-sized tasks**
- Detect when SWE-1.5 is stuck or lying
- Periodic audits (every N loops)

**Why Codex here**
- Best repo-wide understanding
- Writes *unambiguous*, testable tasks
- Less hallucination in specs
- Much cheaper than Opus for this role

**Frequency**
- Run **once per batch** or **every 5–10 SWE loops**
- NOT per issue

---

### 2️⃣ **Executor Model (Free, High Frequency)**
**Model:** **SWE-1.5**

**Responsibilities (STRICTLY bounded):**
- Take ONE Linear issue
- Implement exactly what’s specified
- Run:
  - lint
  - typecheck
  - tests
- Update:
  - `TECH_DEBT_TRACKER.md`
  - PR
- Rebase + fix CI
- Repeat until no issues assigned

**What SWE-1.5 must NOT do**
- Decide scope
- Invent acceptance criteria
- Declare success without green CI
- Close issues it didn’t open

This containment is what makes SWE-1.5 viable.

---

## Critical rule (this makes or breaks it)

> **SWE-1.5 is not allowed to decide “done.”**  
> Only the planner model can.

Mechanically enforce this:
- Linear issues require:
  - checklist
  - commands + expected outputs
- SWE-1.5 must paste outputs verbatim
- Planner audits and closes

---

## Control loop (exact flow)

```
[Codex]
↓
Read TECH_DEBT_TRACKER.md
↓
Open 5–10 Linear issues (atomic, explicit)
↓
Assign to SWE-1.5
↓
────────────────────────
[SWE-1.5 loop]
- Pull issue
- Implement
- Run checks
- Update tracker
- Open/Update PR
- Move to "Ready for Audit"
(repeat)
────────────────────────
↓
[Codex audit]
- Check PRs
- Verify CI + diff intent
- Address reviewer feedback
- Close Linear issues
- Open next batch
↓
Repeat until tracker empty
```

---

## Why this works economically

| Task | Model | Cost | Risk |
|---|---|---|---|
| Issue creation | GPT-5.2 Codex | 💰 | Low |
| Planning | GPT-5.2 Codex | 💰 | Low |
| Code changes | SWE-1.5 | Free | Medium |
| CI fixing | SWE-1.5 | Free | Medium |
| Review / audit | GPT-5.2 Codex | 💰 | Low |

You’re paying **only for judgment**, not keystrokes.

---

## What NOT to do (important)
- ❌ Let SWE-1.5 open issues
- ❌ Let SWE-1.5 close issues
- ❌ Let SWE-1.5 interpret vague ta

*(Answer truncated — 3513 chars total)*

## Question

How do we run neon with doppler for our dev env. Should it be a long lived db? Or should it use the db created for each branch?

## Answer

Mr. White — **use both**, but for different purposes:

- **Long-lived “dev” DB**: for local development, shared integration testing, and anything that needs persistence across days.
- **Per-branch (ephemeral) DB branches**: for PR/preview environments and schema-changing work so branches don’t collide.

This is the workflow Neon is explicitly designed to enable (fast, isolated branches, scale-to-zero), and it avoids the classic “shared dev DB breaks everyone” problem. citeturn0search1turn0search0

---

## What you should do

### 1) Long-lived DB for “dev” (yes)
Have a **stable Neon branch** (call it `dev` or `staging-dev`) that:
- is the default target for **local dev**
- contains **seeded/anonymized** data (if you ever copy prod-ish data)
- is where you run “shared” integration tests and debugging

Neon even calls out a “relatively long-lived” staging-style branch pattern as the simplest approach in some cases. citeturn0search0

**Why:** local dev needs a stable target; ephemeral DBs for every local branch is usually too much operational friction unless you automate heavily.

---

### 2) Per-branch DBs for PRs (also yes)
For every PR / preview environment:
- create a **Neon branch** from your `dev` (or from an anonymized branch)
- run migrations on that branch
- point the preview deployment at that branch’s `DATABASE_URL`
- delete the Neon branch when the PR closes

This pattern is exactly what Neon recommends for preview environments because a shared DB causes cross-PR schema/data collisions. citeturn0search1turn0search25

---

## Where Doppler fits
Use Doppler to inject the correct `DATABASE_URL` per environment:

- **Local dev (long-lived dev DB):**
  - Doppler project/config: `app-dev`
  - Secret: `DATABASE_URL` = connection string for Neon `dev` branch

- **Preview / per-branch DB:**
  - Doppler config per preview env *or* dynamic injection in CI
  - Secret: `DATABASE_URL` = connection string for Neon branch created for that PR

Doppler’s model is exactly “same app, different configs/secrets per environment,” which maps cleanly to dev vs preview. citeturn0search11

---

## Decision rule (simple)
- If the environment is **human local dev** → **long-lived dev DB**
- If the environment is **branch/PR/preview** → **per-branch Neon DB**
- If the work involves **schema changes** → prefer **per-branch** even for dev testing (to avoid breaking others)

---

## One caution (PII)
If you ever base dev/preview branches on prod data:
- do **anonymized/masked** branches as the parent, then derive dev/preview from that. citeturn0search15turn0search0

---

If you tell me your deploy target (Vercel/Cloudflare/Fly/custom) and whether previews exist, I can give you the exact recommended wiring (Neon branch create/delete + Doppler env mapping) in one concrete recipe.
