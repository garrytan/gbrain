---
title: "YC Testing Audit"
type: note
created: 2026-02-02
updated: 2026-02-02
source: chatgpt-export
conversation_id: 697ff71e-e63c-832c-9896-a74a6f80e56d
message_count: 4
tags: [chatgpt, import, long-form]
---
# YC Testing Audit

> Conversation ID: 697ff71e-e63c-832c-9896-a74a6f80e56d
> Created: 2026-02-02T01:00:15Z
> Updated: 2026-02-02T01:05:48Z
> Messages: 4

---

## User

audit this from a ycombinator perspective

Alright, Mr. White. Based on your answers, here is a **clear, enforceable testing philosophy** designed explicitly for:

* **AI-authored code**
* **Junior-heavy contributors**
* **High deploy frequency (2–3×/day)**
* **Revenue-critical, always-on profiles**
* **Determinism > elegance**
* **False positives are the real enemy**

This is written as something you can hand to **humans and AI agents** and expect consistent behavior.

---

# Testing Thesis (One Paragraph)

> Tests exist to protect revenue, uptime, and core product flows by enforcing deterministic, adversarial, and machine-actionable guarantees. A test that can pass while the product is broken is a failure. All tests must be capable of failing meaningfully, produce structured signals an AI agent can act on, and bias toward catching incorrect success rather than blocking progress. We optimize for fast, gated confidence during the deploy loop and exhaustive, adversarial validation asynchronously.

---

# The 7 Laws of Testing (Non-Negotiable)

## 1. **Negative Testing Is Mandatory**

Every test suite must include cases that prove:

* Invalid input is rejected
* Misuse fails loudly
* Partial failure does not masquerade as success

> If a test only proves the happy path, it is incomplete.

---

## 2. **Determinism Over Realism**

Tests must be deterministic by default.

**Forbidden in gated CI unless explicitly approved:**

* Real time
* Real randomness
* Live network calls
* External APIs (Stripe, Clerk, etc.)

**Allowed:**

* Controlled fakes
* Seeded randomness
* Recorded/replayed responses
* Deterministic clocks

Nightly jobs may reintroduce realism.

---

## 3. **False Positives Are Worse Than False Negatives**

A passing test that hides a bug is more dangerous than a failing test that blocks a deploy.

Therefore:

* Assertions must be **strong**, not vague
* “Does not throw” is not sufficient
* Snapshots without semantic assertions are discouraged
* Every test should answer: *“How could this falsely pass?”*

---

## 4. **Tests Must Produce AI-Usable Failure Signals**

When a test fails, it must emit:

* Structured error data
* Clear invariant violations
* Machine-parsable context (inputs, expected vs actual, boundary violated)

> If an AI agent can’t fix the bug from the failure output, the test is under-specified.

---

## 5. **Revenue and Profile Availability Are Tier-0**

The following paths receive **redundant coverage across unit, integration, and E2E**:

* Profile rendering
* Link resolution
* Redirect correctness
* Stripe billing paths
* Feature flag fallbacks

These paths must never:

* Load slowly
* Fail silently
* Degrade UI into unusability

---

## 6. **Performance Is a Functional Requirement**

Tests may assert:

* Upper bounds on response time
* Query counts
* Memory usage (where measurable)
* Cold start behavior (serverless)

> A fast but wrong product is broken.
> A slow but correct product is also broken.

---

## 7. **A Test That Never Fails Is Guilty Until Proven Innocent**

Default response to a perpetually passing test:

1. Audit the risk it claims to cover
2. Prove it can fail by:

   * Adversarial inputs
   * Boundary conditions
   * Partial system failure
3. Rewrite or strengthen if risk is real
4. Remove **only** if the risk is gone or redundantly covered
5. Document the decision

---

# Test Layer Expectations

## Gated (Must Be Fast)

* Lint
* Typecheck
* Deterministic unit tests
* Deterministic integration tests
* Minimal E2E smoke (core money + profile paths only)

## Nightly (Can Be Slow, Brutal, Real)

* Full E2E
* Realistic traffic patterns
* Property-based fuzzing
* Performance regression detection
* Failure injection (timeouts, partial data, flag flips)

---

# Mocking Rules

* Mock **at boundaries**, never inside core logic
* No mocking business rules
* External systems are mocked or replayed
* Feature flags must be tested both ON and OFF

---

# What We Explicitly Do *Not* Test

* Third-party correctness (Stripe works, Clerk authenticates)
* UI pixel perfection
* Internal implementation details
* Trivial getters/setters
* “Coverage-only” tests

---

# AI Agent Operating Rules (Critical)

* AI agents **must write tests first or alongside code**
* AI agents may modify tests only if:

  * They strengthen assertions
  * They increase determinism
  * They reduce false positives
* AI agents must explain *why* a test can fail

---

## One-Line Summary (For the Repo README)

> We test to prevent silent failure of revenue, availability, and core product flows—fast by default, adversarial by design, deterministic always.

If you want, next I can:

* Translate this into a **checklist AI agents must follow**
* Turn this into **GitHub Actions enforcement**
* Define a **“Tier-0 test matrix”** for revenue/profile paths
* Write a **PR rubric** that auto-rejects weak tests


---

## Assistant

Alright, Mr. White. Here’s a **Y Combinator–style audit**: blunt, founder-focused, and tied to what actually kills startups.

---

## Overall Verdict (YC Lens)

**This is strong, opinionated, and unusually mature for a seed-stage company.**  
It clearly optimizes for *velocity without revenue risk*, which YC likes.

However: **it slightly over-indexes on process rigor before product-market fit is proven.** YC partners would like this *after* early traction, not necessarily *before* it.

Net: **A- for Series A readiness. B+ for pre-PMF.**

---

## What YC Would Love ✅

### 1. Revenue-First Framing
YC cares about exactly three things:
1. Are users getting value?
2. Is revenue fragile?
3. Can you move fast without breaking #1 and #2?

Your thesis explicitly protects:
- Revenue paths  
- Availability  
- Silent failure modes  

That aligns perfectly with how YC evaluates engineering maturity.

> “Tests exist to protect revenue, uptime, and core product flows”  
That sentence would survive a partner meeting.

---

### 2. Velocity-Aware (Not Cargo Cult Testing)
You explicitly:
- Separate gated vs nightly
- Bias against false positives
- Optimize for deploy-loop confidence

This avoids the classic YC anti-pattern:
> “We move slowly because our tests are slow.”

YC partners hate that excuse. Your framework preempts it.

---

### 3. AI-First Thinking (Quietly Excellent)
YC is already seeing:
- AI writing 30–70% of early-stage code
- Junior-heavy teams scaling faster than seniors

Your insistence on:
- Determinism
- Machine-actionable failures
- Structured signals

…is **ahead of the median YC batch**. This is future-proofing.

---

### 4. Clear Taste (YC Keyword)
YC values *taste* more than process.

This doc has taste:
- You reject coverage theater
- You reject snapshot nonsense
- You explicitly call out “tests that never fail”

That signals a founder who understands second-order effects.

---

## Where YC Would Push Back ⚠️

### 1. Risk of Premature Rigor (Big One)
YC might ask:

> “How many users do you have *today*?”

If the answer is:
- <1k active users
- <meaningful revenue
- Still searching for PMF

Then some of this is **overbuilt**.

Specifically risky *pre-PMF*:
- Performance assertions
- Memory bounds
- Redundant multi-layer coverage

YC’s mantra:
> “Do things that don’t scale.”

This doc scales *very well* — which is both a strength and a red flag early.

---

### 2. Enforcement Cost Isn’t Addressed
YC will implicitly worry about:
- Developer friction
- Slowed onboarding
- AI agents fighting strict CI

You describe **what** must happen, but not:
- How often exceptions are allowed
- Who grants approval
- How teams escape the rules under pressure

YC loves rules, but only if:
> “A founder can break them at 2am to save the company.”

You should explicitly bless that escape hatch.

---

### 3. Missing a “Kill Switch” Principle
YC would expect one more law:

> *Any test or rule that materially slows iteration during PMF search can be bypassed with founder approval.*

Without that, this reads slightly “BigCo” rather than “scrappy-but-serious.”

---

## Specific Section Critiques

### “False Positives Are Worse Than False Negatives”
**Correct. Rare. YC-aligned.**  
Most teams get this wrong.

No changes recommended.

---

### “Performance Is a Functional Requirement”
This is valid **only for Tier-0 paths**.

YC would likely suggest tightening language to:
- Performance guarantees apply **only** to revenue / availability paths
- Everything else is best-effort until PMF

Otherwise this can balloon test surface area.

---

### “AI Agent Operating Rules”
This is excellent, but YC would ask:
- What happens when AI and humans disagree?
- Who is the arbiter?

Add one line:
> “In conflicts, human owner decides; tests are then updated to reflect the decision.”

---

## What YC Would Tell You to Add

### 1. A PMF Mode Switch (Highly Recommended)

Something like:

> **PMF Mode:**  
> While searching for product-market fit, only Tier-0 paths are subject to full enforcement. All other test requirements are advisory and may be bypassed to accelerate learning.

This signals you know *when* to be disciplined.

---

### 2. Explicit Ownership
YC hates “everyone owns quality.”

Add:
- Every Tier-0 path has a single owner
- That owner is accountable for test health and bypass decisions

---

## YC-Style One-Line Assessment

> “This founder understands how engineering discipline supports speed — the main risk is applying Series A rigor before Series A traction.”

That’s a **good** critique to receive.

---

## Final Recommendation

**Keep this philosophy.**  
But add:
1. A PMF escape hatch  
2. Founder override language  
3. Clear ownership  

Do that, and this becomes:
- YC-partner defensible
- AI-scalable
- Growth-safe

If you want next, I can:
- Rewrite this as a **YC-ready internal memo**
- Strip it down into a **pre-PMF version**
- Add a **founder override + escalation protocol**
- Turn it into a **“what we enforce at 10 users vs 10k users” table**

Just say the word.

---

## User

when i mention performance i mean simply test perofmrance because it slows shipping when test take long to run in ci and we want to move fast.
otherwisee youre notes are good give me this as a section in agents.md

---

## Assistant

Got it, Mr. White. Here’s a **clean, drop-in section** for `agents.md`, written in enforcement language AI agents will actually follow, and scoped exactly to **test runtime performance (not product perf)**.

---

## Test Performance (CI Runtime Is a First-Class Constraint)

Tests are part of the deploy path. **Slow tests slow shipping.**  
Therefore, **test runtime performance is a functional requirement of the testing system itself.**

### Core Rule

> Any test that materially slows CI without proportional risk reduction is considered harmful, even if it is “correct.”

### Non-Negotiables

AI agents **must** ensure that:

- Gated CI tests run fast enough to support **2–3 deploys per day**
- Test runtime does **not** grow unbounded over time
- Added tests justify their runtime cost with **Tier-0 risk coverage**

### Gated vs Nightly Enforcement

**Gated CI (Deploy-Blocking):**
- Must be deterministic and fast
- No long-running E2E
- No exhaustive fuzzing
- No large fixture setup
- No real network, sleep, or polling loops

**Nightly / Async Jobs:**
- May be slow
- May be exhaustive
- May trade speed for coverage
- Must never block deploys

### Agent Rules (Strict)

AI agents **must not**:
- Add slow tests to gated CI by default
- Increase CI runtime without explaining why
- Justify slow tests with “better coverage” alone

AI agents **must**:
- Prefer fewer, stronger assertions over more tests
- Collapse redundant tests
- Move slow or high-cardinality tests to nightly
- Call out expected runtime impact in PRs when adding tests

### Failure Condition

A test suite is considered **broken** if:
- CI time increases noticeably without a corresponding Tier-0 risk reduction
- Engineers begin avoiding deploys due to slow feedback
- Tests are skipped locally to save time

### Default Bias

> If there is a tradeoff between **test thoroughness** and **iteration speed in CI**, bias toward speed and move the thoroughness elsewhere.

---

If you want next, I can:
- Add a **hard CI time budget** section (with escalation rules)
- Write an **agent checklist** for “should this test be gated or nightly?”
- Produce a **PR template block** that forces agents to justify test runtime impact

This version is tight and YC-safe.


## See Also
- [[chatgpt/chatgpt_ai-app-testing-process-part1]]
- [[chatgpt/chatgpt_ai-app-testing-process-part2]]
- [[chatgpt/chatgpt_ai-app-testing-process-part3]]
- [[chatgpt/chatgpt_ai-app-testing-process-part4]]
- [[chatgpt/chatgpt_ai-chaos-testing-tools]]
