---
title: "Throughput-maximized learning"
type: essay
created: 2025-12-21
updated: 2025-12-21
source: chatgpt-export
topic: business-startup
message_count: 24
tags: [chatgpt, knowledge, business-startup]
---
**Topic:** [[chatgpt-knowledge/_topics/business-startup]]

# Throughput-maximized learning

> **Source:** ChatGPT conversation
> **Date:** 2025-12-21T20:29:11Z
> **Messages:** 24
> **Topic:** business-startup

## Question

Yo, I just have a question I'm curious on. So, I'm thinking about it, and I'm like, you know, the general philosophy of taking more shots on goal for a startup, right? Like, the faster your iteration cycle is, the more chances you have to, you know, to iterate, and the faster you can develop products and stuff. And even if you make the wrong decisions, you'll figure out that they're wrong faster, and then make decisions that may or may not be right after that, and continually loop. So, if you're taking 10 shots on goal every week, and another company's taking 2 shots on goal, you might go way off track and come way back on track, and still end up ahead of a company that only took 2 shots on goal, but made the right choices. So, basically, like, that's the concept I'm thinking about, and Sam Altman has talked about this a lot, and like, getting iteration cycles down to like 4 hours rather than, you know, 4 days and stuff like that. And so, as I'm thinking about that, one of the things t

## Answer

Mr. White—

Your intuition is mostly **right**, but it only holds under **specific constraints**. Here’s a clean thesis and where it breaks.

---

## The core thesis (why this *does* make sense)

You’re describing **throughput-maximized learning**, not productivity.

What actually compounds in startups isn’t hours worked, it’s:

> **validated decisions per unit time**

Short iteration loops increase the *rate at which wrong hypotheses die*. That’s enormously powerful early.

A globally staggered team + AI orchestration can, in theory, produce:
- 3–4× more **decision cycles**
- Continuous CI, deploy, test, observe
- Near-zero idle time for builds, evals, or agents
- Faster convergence on product-market reality

This aligns with what **entity["people","Sam Altman","openai ceo"]** means by compressing feedback loops—not working harder, but **learning faster**.

So the idea is directionally sound.

---

## Where this actually works

This model wins **only** when these conditions are true:

### 1. Work is *modular and testable*
If tasks can be:
- Clearly specified
- Independently executed
- Objectively validated (tests, metrics, user signals)

Then handoffs across time zones are cheap.

This is why it works best for:
- Infrastructure
- Dev tools
- AI-first products
- Early MVP exploration

It fails for:
- Ambiguous UX work
- Deep product discovery
- Strategy-heavy pivots

---

### 2. There is a single, ruthless product oracle
Someone (usually a founder) must:
- Own the product truth
- Reject 80% of shipped work immediately
- Prevent local optimization

Without this, you get **high-velocity thrash**—lots of shots, no aim.

More shots only help if the target is continuously re-aimed.

---

### 3. Latency does not corrupt intent
Time zones introduce **semantic drift**:
- “Build X” becomes 3 interpretations
- Small misunderstandings compound overnight
- Rework increases nonlinearly

This is manageable **only if**:
- Specs are brutally explicit
- Acceptance criteria are machine-checkable
- Product people are closer to “executional PMs” than visionaries

---

## Where it breaks (and breaks badly)

### 1. Iteration speed ≠ progress speed
At some point, the bottleneck is:
- Taste
- Judgment
- User empathy
- Strategic coherence

Those do *not* parallelize.

You can run 8 loops/day and still be wrong in the same direction.

---

### 2. Communication overhead grows superlinearly
A 24-hour relay introduces:
- More documentation
- More coordination
- More error correction

Past ~4–6 people, gains collapse unless the system is extremely disciplined.

This is why most successful companies **start co-located**, then distribute *after* product clarity.

---

### 3. AI agents amplify both good and bad decisions
AI doesn’t just increase velocity—it increases **error surface area**.

If your product intuition is wrong, AI helps you be wrong *faster*.

That’s good early.
That’s catastrophic once users are real.

---

## The correct synthesis (what actually works best)


*(Answer truncated — 4086 chars total)*

## Question

No, this was just like a thought experiment because I was just curious on it. But, I mean, I'm not planning on hiring at all in the foreseeable future, so irrelevant. But, that being said, current situation is that I am solo founder at Jovi, only employee right now. And I'm kind of trying to figure out what the best way to go about iterating on shit is right now. And my main question, dilemma, situation right now is basically this. It's like, do I... Do I... Go to... Do I go to... You know, do I go to... Basically... Do I go to... I guess what I'm trying to understand is, like, there's a couple ways that I can work. And I'm trying to understand the ways that YC would recommend working with the way OpenAI or Sam Altman would work. Like, when you're... Well, I mean, I guess OpenAI just started with a few billion dollars, so that's a different story. But, how would a lean, you know, founder-only startup at YC be encouraged to work? What would be the best way for them to work in terms of, 

## Answer

Mr. White — as a solo founder with AI, the “best workflow” is the one that maximizes **learning per day** while keeping **production risk bounded**. The mistake is trying to run *either* a classic weekly sprint *or* pure “ship everything instantly.” You want a **two-lane system**: fast lane for safe changes, gated lane for risky changes.

Here’s a concrete cadence that works well for solo + AI.

## The operating model: 3 loops, 2 lanes

### Loop A: Daily “MRR decision” (15–25 min, every morning)
You’re not sprint planning; you’re choosing *today’s single outcome*.

1. Write the **one metric move** for today (ex: “increase trial→paid by improving checkout completion”).
2. Pick **1 big bet** (2–6 hours of focused progress) + **3 small bets** (≤30 min each).
3. Everything else goes into a parking lot.

This is YC-ish in spirit: obsess over the metric, keep scope brutal, don’t let planning become work.

### Loop B: Continuous “AI execution” (all day)
Treat agents like interns who write code fast and need tight acceptance criteria.

For each task you hand to AI, include:
- **Definition of done** (observable behavior)
- **Non-goals** (what not to touch)
- **Test plan** (how it will be validated)
- **Rollback plan** (what breaks if wrong)

You can keep this lightweight, but *something* written beats “in your head” because it prevents drift and lets you parallelize.

### Loop C: Shipping cadence (2–4 times/day)
Don’t “ship every green build” unless your app is extremely low-risk and you’re fully behind flags. Instead:

- **2 shipping windows/day** (midday + end of day) is the sweet spot for solo.
- If you’re moving very fast, **4 windows/day** (every ~2–3 hours) can work.

That gives you speed without turning your day into constant production babysitting.

---

## The two lanes: what auto-goes to prod vs what gets gated

### Fast lane (auto-deploy OK)
Auto-deploy on green **only** for changes that are:
- UI copy/layout tweaks
- Small refactors behind tests
- Non-critical pages
- Analytics/event additions (carefully)
- Anything fully behind a **feature flag**

Rule: if it can’t meaningfully break payments, auth, data integrity, or uptime, it can be fast lane.

### Gated lane (manual check required)
Manual review + explicit release for:
- Billing / checkout / pricing
- Auth / permissions
- DB migrations / data transforms
- Anything touching core data models
- Performance-sensitive or security-related changes

Rule: if rollback is non-trivial, it’s gated.

---

## How to structure the work (Linear is fine, but keep it minimal)

For solo founder + AI, you want **just enough** structure to:
1) not forget things, 2) enable parallelization, 3) preserve product intent.

A good minimum is:

**Three buckets**
- **Now (today)**: 1 big + 3 small
- **Next (this week)**: shortlist of 5–10
- **Later**: everything else

That’s it. You do not need real “sprints” unless it motivates you.

When you create a ticket, write it in this format (copy/paste template):

- **Goal:*

*(Answer truncated — 5633 chars total)*

## Question

Okay, so what I currently have in CI is basically some pre-commit hooks for lint and type check and stuff like that, although it's kind of flaky on AI using that. AI will use it when I'm running AI locally, but when I deploy AI from the cloud or cloud-hosted agents or something, they don't use those hooks, so because there's... I just have to figure out how to configure those or whatever because they're just with Husky right now, and so I mean I could theoretically figure out how to set that up, but basically PR, it checks the PR, they go through some fast tests, then if I approve merge and ready, click that, and then they go into the merge queue, and then they go through the merge CI, which I guess is a duplication of CI, so like I don't really understand how that's supposed to go, but I mean that does slow things down, so maybe there's a way to speed that up. I don't know. That's a question for you. And then we go into merge queue, and then from merge queue, things get merged, obviou

## Answer

Mr. White — given your stage (**pre-launch, lots of sharp-edge bugs, solo founder, AI-heavy PR throughput**), you want:

- **Auto-merge aggressively**
- **Auto-deploy to *staging* always**
- **Auto-deploy to *production* only for “fast lane”**
- **Everything else ships via feature flags + scheduled production “release windows”**

That gives you maximum iteration without turning production into a slot machine.

---

## 1) The best promotion model for your setup

### Always
**PR → checks → merge queue → `main` → auto-deploy to Staging**

That should be non-negotiable. Staging is where you let chaos happen.

### Production
Use **two paths**:

#### Fast lane: auto-promote to prod
Auto-promote from staging to prod if ALL are true:
- No DB migrations / schema changes
- No auth/billing changes
- No changes to “core flow” paths (signup, create page, publish page, subscribe capture)
- Either (a) behind a Statsig flag, or (b) purely cosmetic / copy / non-critical

This is how you keep momentum while you’re fixing tons of papercuts.

#### Gated lane: manual promote to prod
Manual review is required for:
- DB migrations
- Clerk/Auth logic
- Anything that could break onboarding, publish, subscribe capture
- Payment-related (when you add it)
- Anything “can’t easily roll back” (data writes, side-effects)

**Key point:** gated lane can still auto-merge to `main` and auto-deploy to staging. The *only* manual gate is production promotion.

---

## 2) How many manual production reviews per day?

Don’t try to “review every push.” It will crush you.

Until launch: **1 production release window/day** (end of day)  
After launch: **2/day** (midday + end of day)

Fast lane can keep auto-promoting in the background, but your *gated* production promotions happen in those windows.

---

## 3) Fix your Husky / pre-commit flakiness the right way

Pre-commit hooks are *developer ergonomics*, not your quality gate.

Make GitHub Actions the source of truth:
- `lint`
- `typecheck`
- unit tests (even small)
- e2e smoke (minimal but real)

Then Husky can be “nice to have,” but if cloud agents bypass it, nothing breaks.

**Practical move:** mirror your Husky commands into CI and stop caring if Husky runs.

---

## 4) Merge queue “duplication” and how to speed it up

What you’re seeing is normal:
- PR checks run on the PR branch
- Merge queue often re-runs (or partially re-runs) on the “merge group” commit to prevent race conditions

To speed up without losing safety:
- Keep PR checks **fast** (lint/typecheck/unit)
- Keep “merge queue” checks **the same** but optimized (cache, avoid rebuilding)
- Put e2e smoke tests in the **post-merge deploy pipeline** (staging), not blocking every PR unless they’re quick

If your e2e suite is heavy, don’t run full e2e on every PR right now. Run:
- **e2e smoke** on every merge to `main` (staging deploy)
- **full e2e** nightly or before major releases

---

## 5) The specific pipeline I’d run for Jovi (Next + Vercel + Neon + Clerk + Statsig)

### P

*(Answer truncated — 5169 chars total)*

## Question

Okay whats the best way to handle ai code review

## Answer

Mr. White — treat AI code review as a **filter + checklist generator**, not a final judge. The best setup is **two-pass AI review + deterministic gates**.

## The gold-standard flow

### 1) Pre-review (agent self-check, mandatory)
Before the PR even asks for review, have the coding agent run and paste results for:
- `lint`
- `typecheck`
- `tests` (whatever exists)
- “What changed + why”
- “Risk areas” (auth/billing/db/schema/perf)
- “How to validate manually”

This alone removes most garbage PRs.

### 2) AI Review Pass #1 (strict, blocking)
Prompt the reviewer to:
- Summarize the diff in 5 bullets
- Identify **risk category**: fast lane vs gated lane
- Find issues in this order:
  1) security/privacy (Clerk/session handling, webhooks, secrets)
  2) data integrity (Neon, writes, idempotency)
  3) correctness (edge cases)
  4) UX regressions
  5) performance (N+1, overfetch, client/server boundary)
- Output in a structured checklist:
  - **Blockers** (must fix)
  - **Should fix**
  - **Nice to have**
  - **Required tests to add/update**
  - **Manual QA steps**

Rule: only *Blockers* prevent merge.

### 3) Agent fixes + evidence
Agent responds to each blocker with:
- “Fixed in commit X”
- “Test added/updated”
- “How I verified”

### 4) AI Review Pass #2 (verification, short)
Second AI pass only checks:
- Did blockers get fixed?
- Are the tests/QA steps satisfied?
- Any new risk introduced?

If clean → label `ready`.

---

## What AI review should NOT be responsible for
Never let AI be the only guardrail for:
- auth changes
- DB migrations / data transforms
- subscription capture flow
- anything that touches production money (later)

Those require either:
- strong automated tests + staged rollout, or
- you eyeballing the diff + a quick manual QA script.

---

## How to implement it fast (without building tooling)

### Option A: GitHub PR comment trigger (simple)
- You (or a bot) comments: `@review-bot`
- Bot posts the structured review
- You paste review back to the coding agent: “Fix all blockers; respond with proof.”

### Option B: Always-on review (best once stable)
- Every PR auto-triggers AI review
- If risk is “gated lane,” it automatically adds a “ship requires manual QA” checklist.

---

## The actual prompt you should use (copy/paste)

**AI reviewer prompt:**

> You are a senior engineer reviewing this PR for a Next.js + Clerk + Neon + Vercel app.  
> Goals: prevent auth/data regressions, keep diffs minimal, and ensure deploy safety.  
> Output format exactly:
> 1) Summary (5 bullets)  
> 2) Risk classification: Fast lane or Gated lane + why  
> 3) Blockers (must fix before merge)  
> 4) Should fix  
> 5) Nice to have  
> 6) Tests required (specific files/areas)  
> 7) Manual QA steps (numbered, 2–8 steps)  
> Review priorities: security/privacy > data integrity > correctness > UX > performance.  
> Be specific: cite functions/files, suggest exact fixes, and call out any missing rollback/flagging.

---

## My recommended policy for you right

*(Answer truncated — 3497 chars total)*

## Question

Should we use coderabbit?

## Answer

Mr. White — **yes, CodeRabbit is worth trying** for your situation, with one caveat: treat it as a **signal booster**, not a safety gate.

### Why CodeRabbit fits you (solo + lots of AI PRs)
- It’s designed to post structured PR feedback automatically (summary + inline comments), which is exactly what you need when you’re approving PRs from your phone.
- Pricing is straightforward (free tier + paid tier) and it’s quick to install. citeturn0search4turn0search0
- They explicitly position themselves around security/privacy practices and have a trust center/docs you can sanity-check. citeturn0search1turn0search5turn0search12

### The caveat (important)
AI code review tools can be noisy and can miss real issues—so don’t let “CodeRabbit approved” mean “ship to prod.” Keep CI + smoke tests + your fast/gated lane rules as the real gate.

---

## Recommended setup if you use CodeRabbit
1) **Run CodeRabbit on every PR** automatically.
2) Add a policy: **no merge if CodeRabbit finds “blockers”** (or whatever its highest severity is), *unless you override intentionally*.
3) For **gated-lane PRs** (auth/db/core flow): require
   - green CI
   - staging smoke green
   - *your* quick diff skim + manual QA steps
4) Keep CodeRabbit focused:
   - small PRs
   - require PR template: “Goal / DoD / Test plan / Risk”
   - otherwise any reviewer (AI or human) performs worse.

---

## Should you use CodeRabbit vs GitHub Copilot Review?
Since you’re already living in GitHub, also know Copilot can auto-review PRs, but it’s quota/billing-based as a premium feature. citeturn0search2turn0search19turn0search23  
In practice: try CodeRabbit first (fast feedback loop), and if you end up wanting “one vendor inside GitHub,” evaluate Copilot review later.

---

## My call for you
- **Try CodeRabbit for 1 week** on all PRs.
- Keep your true gates: **CI + staging smoke + lane-based prod promotion**.
- If CodeRabbit reduces your “phone merge anxiety” and catches issues you’d miss, keep it. If it’s noisy, drop it—your workflow still works.

If you tell me what your current PR sizes look like (typical files changed) and whether you already have a PR template, I’ll give you the exact “review policy” wording to paste into your repo so agents + CodeRabbit behave.

## Question

Should we add a preps hook to use coderabiir cli or keep it exclusively to ci?

## Answer

Mr. White — **keep CodeRabbit exclusively in CI (PR workflow)**, not as a pre-commit hook.

Pre-commit is for **fast, deterministic, local** checks (lint/typecheck/format). CodeRabbit is **networked, slower, non-deterministic**, and your cloud agents will bypass it anyway, so you’ll end up with inconsistent behavior and extra friction.

### Do this instead

#### Local / pre-commit (Husky)
Keep only:
- format (Prettier)
- lint
- typecheck (if it’s fast)
- *optionally* a tiny unit test subset

#### CI / PR checks
- Run CodeRabbit review automatically on PR open + update
- Require green CI before merge
- Treat CodeRabbit “blockers” as merge-blocking (but allow manual override)

#### Merge queue / post-merge
- Staging deploy + e2e smoke
- Prod promotion rules (fast lane auto, gated lane manual)

### One exception where a hook is OK
If you personally like it as a **manual command**, add a script like `pnpm review:ai` that runs CodeRabbit CLI (or triggers your reviewer) — but **don’t make it a hook**.

Net: **hooks = deterministic; AI review = CI.**

## Question

{'asset_pointer': 'sediment://file_00000000da1871f5ab8c11bab39e7588', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 583, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 212861, 'width': 605}

## Answer

Mr. White — for **your stage (solo, pre-launch, lots of AI PRs)**, select **only the rules that reduce catastrophic risk**, not noise.

### Turn ON (strongly recommended)
✅ **Security patterns**  
This is non-negotiable. You’re touching auth, analytics, ingestion, and user data. Let CodeRabbit yell about:
- hardcoded secrets
- missing auth checks
- unsafe input handling

✅ **Migration patterns** *(only if you actually run DB migrations)*  
If you’re doing **Neon schema changes**, keep this on. Bad migrations are one of the few ways to permanently hurt yourself pre-launch.

---

### Leave OFF (for now)
❌ **Performance patterns**  
Too noisy this early. N+1s and bundle size matter **after** users exist. Right now it’ll distract you from correctness.

❌ **Test coverage requirements**  
You don’t want CodeRabbit blocking PRs because “no test added” while you’re still stabilizing flows. You already know where tests matter (onboarding, subscribe capture).

❌ **Other / custom**  
Don’t invent rules yet. You don’t have enough signal.

---

### The principle to remember
AI review rules should:
- **prevent irreversible damage**
- **not slow shipping**
- **not create false confidence**

Security + migrations meet that bar. Performance and test nagging do not (yet).

---

### When to add more rules later
Add **Performance patterns** only when:
- you have real traffic
- you see slow dashboards / fan pages
- bundle size actually hurts conversion

Add **Test requirements** only when:
- core flows are stable
- regressions become the main risk, not missing features

---

### Final answer (checkbox summary)
✔ Security patterns  
✔ Migration patterns (if applicable)  
✖ Performance patterns  
✖ Test coverage requirements  

That setup is **correct for where you are right now**.

## Question

Any mcp we should add to coderabbit?

## Answer

Mr. White — **yes, but keep MCPs extremely limited**. For CodeRabbit, you want MCPs that give **context**, not execution power.

## MCPs you SHOULD add (high value, low risk)

### 1) **Repo / Codebase context MCP** ✅ (most important)
Purpose:
- Let CodeRabbit understand your **monorepo structure**, shared utils, and conventions.

What it enables:
- Better diff understanding
- Fewer “false positive” comments
- Smarter suggestions that respect your patterns

This is the single MCP that actually improves review quality.

---

### 2) **Schema / DB context MCP** (read-only) ✅
If you can expose:
- Prisma / Drizzle schema
- Migration history
- Key tables (artists, pages, subscribers, events)

Then do it **read-only**.

Why:
- Prevents silent data integrity mistakes
- Improves migration reviews
- Helps catch “this breaks onboarding/subscriber state” issues

This is especially valuable with **Neon**.

---

### 3) **Auth model context MCP** (read-only) ✅
Expose:
- How Clerk auth is wired
- Where session/user IDs are trusted
- Any middleware or guards

Why:
- AI reviewers are *bad* at auth unless you show them the rules
- This sharply reduces dangerous auth regressions

---

## MCPs you should NOT add (yet)

### ❌ CI / deploy control MCP
Never let CodeRabbit:
- trigger deploys
- approve releases
- mutate environments

Review ≠ authority.

---

### ❌ Production data access MCP
Absolutely no:
- live DB access
- analytics dashboards
- user data

High risk, low benefit at your stage.

---

### ❌ Performance / analytics MCP (for now)
Until you have real traffic:
- performance comments are noise
- reviewers will over-optimize prematurely

Add later if needed.

---

## The correct mental model
CodeRabbit MCPs should answer:
> “What are the rules of this system?”

Not:
> “Please operate the system.”

Think **context injection**, not automation.

---

## Final recommendation (tl;dr)
Add:
- ✅ Repo/codebase context MCP  
- ✅ Read-only DB/schema MCP  
- ✅ Read-only auth model MCP  

Do **not** add:
- ❌ deploy / CI MCPs  
- ❌ production data MCPs  
- ❌ performance MCPs (yet)

That setup will **materially improve review quality** without slowing you down or increasing risk.

## Question

So neon, clerk, and GitHub? linear?

## Answer

Mr. White — **yes to Neon, Clerk, GitHub; no to Linear (for now).**

Here’s the clean breakdown.

---

## ✅ Add these MCPs

### **Neon (read-only) — YES**
Highest value MCP for you.

Use it only to expose:
- schema / migrations
- table relationships
- constraints / indexes

**Why:**  
Prevents silent data corruption and bad migrations. This is one of the few failure modes that actually hurts you pre-launch.

**Rule:** read-only, schema-level only. No data access.

---

### **Clerk (read-only auth model) — YES**
Expose:
- how users are identified
- where auth middleware lives
- what routes require auth
- what “unauthenticated” means in your app

**Why:**  
AI reviewers are terrible at auth unless explicitly told the rules. This dramatically reduces dangerous suggestions.

---

### **GitHub (repo + PR context) — YES**
Expose:
- repo structure
- PR history
- commit context
- CI status (read-only)

**Why:**  
Improves review accuracy, reduces repetitive comments, understands patterns across files.

This should basically always be on.

---

## ❌ Do NOT add (yet)

### **Linear — NO (for now)**
Low value, high distraction.

Why it’s not worth it yet:
- You’re solo
- Issues change constantly
- Review quality does **not** improve meaningfully with ticket context
- Adds noise (“this PR doesn’t reference a ticket”)

Add Linear later **only when**:
- PRs regularly map 1:1 to stable issues
- You want enforcement, not speed

---

## Mental model (important)

MCPs should answer:
> “What are the rules and structure of this system?”

Not:
> “What’s the planning or process state?”

Neon + Clerk + GitHub define **system truth**.  
Linear defines **process truth**, which you don’t need yet.

---

## Final recommendation (exact set)

**Add now**
- ✅ GitHub MCP  
- ✅ Neon MCP (schema-only, read-only)  
- ✅ Clerk MCP (auth model, read-only)

**Skip for now**
- ❌ Linear MCP  

That setup is **correct and optimal** for your current stage and workflow.

## Question

sentry?

## Answer

Mr. White — **yes, add Sentry as an MCP, but only in a very narrow, read-only way.**  
Done correctly, it’s high leverage for you right now.

---

## ✅ Add Sentry MCP (read-only, scoped)

### What to expose
Give CodeRabbit access to:
- **Error group summaries** (top issues)
- **Stack traces**
- **Affected files / functions**
- **Recent regressions** (new vs existing)

### What NOT to expose
❌ No raw user data  
❌ No environment variables  
❌ No write / acknowledge / deploy actions  
❌ No alerting controls  

Sentry should inform *review*, not *operate* the system.

---

## Why Sentry MCP is worth it *for you*
You’re:
- pre-launch
- fixing tons of papercut bugs
- shipping many AI-generated PRs

Sentry context lets CodeRabbit:
- say **“this PR touches code currently throwing errors”**
- flag **“this change likely re-introduces a known crash”**
- connect diffs to *real runtime failures*, not hypothetical ones

That’s exactly the kind of signal AI reviewers are otherwise blind to.

---

## How CodeRabbit should use Sentry (policy)
Configure it conceptually like this:

- If PR touches a file with active Sentry errors → **call it out**
- If PR claims to fix a bug → **check whether Sentry confirms it**
- If PR adds a new code path → **warn if unmonitored**

But:
- Sentry findings are **advisory**, not merge-blocking by default
- Only block merges if *you* decide to later

---

## When NOT to add Sentry MCP
If:
- Sentry is still noisy / untriaged
- Errors aren’t symbolicated
- You’re not checking it daily

Then wait a week. Garbage in → garbage review.

---

## Final MCP set (now updated)

**Add**
- ✅ GitHub MCP  
- ✅ Neon MCP (schema-only, read-only)  
- ✅ Clerk MCP (auth model, read-only)  
- ✅ **Sentry MCP (read-only error context)**

**Skip**
- ❌ Linear (for now)
- ❌ CI/deploy MCPs
- ❌ Production data MCPs

---

### Bottom line
Sentry MCP is **worth it now**, because:
- bugs are your #1 problem
- it grounds AI review in reality
- it helps you decide *what to fix next*, not just *what looks wrong*

If you want, next step I can give you:
- the exact **Sentry → CodeRabbit prompt rules**
- or a **“block merge if this error class worsens”** policy you can enable later

## Question

statsigz?

## Answer

Mr. White — **Statsig: usually “no” as an MCP for CodeRabbit, at least not early.** It’s much lower leverage than **GitHub + Neon + Clerk + Sentry**.

## Why Statsig MCP is usually not worth it
- Feature flags are **process/intent**, not system truth.
- Review quality doesn’t improve much from “this is flagged” unless the reviewer can also see **exact code paths + rollout rules**, which it already can from the diff.
- Risk: reviewers start debating experiment design/metrics instead of catching correctness/auth/data bugs.

## When Statsig MCP *is* worth adding
Add it only if you can provide **read-only** access to:
- flag names + descriptions
- default values
- targeting rules (who sees what)
- environment separation (staging vs prod)
- change history (who flipped what)

…and you actually use Statsig heavily for safe rollouts.

Then it becomes useful for:
- “You added code but forgot to guard it behind `flag_X`”
- “This PR changes behavior but the flag targeting still exposes it to everyone”
- “Staging flag differs from prod; your testing is misleading”

## My recommendation for you right now (pre-launch)
**Skip Statsig MCP for now.**  
Instead, enforce a simple repo rule that gives you 90% of the benefit:

- Any “gated-lane” PR must include in the PR template:
  - `Flag:` (name or “none”)
  - `Default:` off/on
  - `Targeting:` internal / % rollout / all users

That keeps reviewers aligned without wiring another integration.

## Final set (best ROI)
✅ GitHub  
✅ Neon (schema-only)  
✅ Clerk (auth model)  
✅ Sentry (error context)  
⏳ Statsig (later, only if read-only + you’re doing real rollouts)

If you tell me whether you expect to do % rollouts and experiments in the next 2–4 weeks, I’ll tell you whether to add Statsig now or keep it as a “phase 2” integration.

## Question

{'asset_pointer': 'sediment://file_000000000dfc71f5bf1d1f4220848084', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 681, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 288528, 'width': 773}
what sentry permissions

## Answer

Mr. White — **select exactly these Sentry permissions** for CodeRabbit. Nothing more.

## ✅ Turn ON (read-only, high signal)

### **Inspect Issues & Events** ✅
This is the core value.
- Error groups
- Stack traces
- Event details
- Regressions

**Must-have.**

---

### **Seer** ✅
Sentry’s AI debugger.
- Root-cause summaries
- Error → code path explanations

Safe and useful because it’s **analytical**, not operational.

---

### **Documentation** ✅
Lets the reviewer:
- Reference correct Sentry SDK usage
- Avoid bad instrumentation suggestions

Low risk, mild upside.

---

## ❌ Leave OFF (do not enable)

### **Triage Issues** ❌
Do **not** allow:
- resolving issues
- assigning
- mutating status

Reviewers should *observe*, not change reality.

---

### **Manage Projects & Teams** ❌
Absolutely not.
- No project edits
- No DSNs
- No team changes

Zero upside, real risk.

---

## ✅ Final checkbox set (exact)
✔ Inspect Issues & Events  
✔ Seer  
✔ Documentation  

✖ Triage Issues  
✖ Manage Projects & Teams  

This gives CodeRabbit **maximum bug-awareness with zero blast radius**, which is exactly what you want pre-launch.
