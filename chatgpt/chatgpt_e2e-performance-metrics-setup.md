---
title: "E2E Performance Metrics Setup"
type: note
created: 2026-02-02
updated: 2026-02-02
source: chatgpt-export
conversation_id: 698119de-d358-8332-bb7e-f75a7059dbcf
message_count: 4
tags: [chatgpt, import]
---
# E2E Performance Metrics Setup

> Conversation ID: 698119de-d358-8332-bb7e-f75a7059dbcf
> Created: 2026-02-02T21:40:47Z
> Updated: 2026-02-02T21:43:10Z
> Messages: 4

---

## User

i want to instruct claude to add metrics to our core e2e tests to measure load times for each core db page plus homepage and public profiles and each auth, onboarding, and waitlist screen. the goal is to have them perceived fast, like the gmail 100ms standard. help me craft this into a prompt to have it set those performance goals and make them warn only for now

---

## Assistant

Got it. Here’s a **clean, precise prompt** you can drop straight into Claude. It sets **clear scope**, **explicit performance targets (perceived speed)**, and **warn-only behavior** so you don’t break CI yet.

---

### Claude Prompt

> You are working in our end-to-end (E2E) test suite.  
>  
> **Objective**  
> Add performance instrumentation to our core E2E tests to measure and record **page load times and perceived responsiveness**, without failing tests yet. This is **warn-only** for now.  
>  
> **Scope (must be covered)**  
> Instrument and report load/perceived-ready times for:
> - Homepage  
> - All core database (DB) pages  
> - Public profile pages  
> - Authentication flows (login, signup, password reset, etc.)  
> - Onboarding screens  
> - Waitlist screens  
>  
> **What to Measure**  
> For each page/screen, capture:
> - Time to first contentful paint (or closest equivalent in our tooling)  
> - Time until the page is **visually and interactively usable** (not just network idle)  
> - Any major blocking delays (long tasks, delayed hydration, etc.), if available  
>  
> Use realistic user navigation paths (not direct URL loads unless unavoidable).  
>  
> **Performance Goals (Perceived Speed)**  
> Set reference targets inspired by Gmail-level perceived performance:
> - **~100ms:** ideal perceived response (instant)  
> - **≤300ms:** fast, no noticeable delay  
> - **≤1s:** acceptable but needs attention  
>  
> These are **targets**, not hard failures yet.  
>  
> **Behavior**  
> - Do **not fail** tests based on performance  
> - Emit clear, structured **warnings** when targets are exceeded  
> - Output timings in a machine-readable format (JSON or structured logs) so we can trend them later  
> - Make it easy to upgrade warnings → failures in the future with a config change  
>  
> **Constraints**  
> - Minimize test flakiness  
> - Avoid introducing significant runtime overhead  
> - Keep instrumentation isolated and reusable  
>  
> **Deliverable**  
> Implement the instrumentation, integrate it into existing core E2E tests, and include brief inline comments explaining:
> - What is being measured  
> - Why it reflects perceived performance  
>  
> Do not refactor unrelated test logic.

---

If you want, I can:
- Tighten this for **Playwright vs Cypress vs custom runner**
- Add **budget-style reporting** (p50 / p95)
- Reframe it to explicitly support **CI dashboards or GitHub annotations**

Just say the word.

---

## User

dashboard pages not db pages. we dont use passwords only otp. and its playwright

---

## Assistant

Perfect — here’s a **tight, corrected Playwright-specific prompt** you can paste directly into Claude. Clean scope, no ambiguity, warn-only, OTP auth reflected.

---

### Claude Prompt (Revised)

> You are working in our **Playwright end-to-end (E2E) test suite**.  
>  
> **Objective**  
> Add performance instrumentation to our core Playwright E2E tests to measure **page load times and perceived responsiveness**. This is **warn-only** for now (do not fail CI).  
>  
> **Scope (must be covered)**  
> Instrument and report perceived load times for:
> - Homepage  
> - **All core dashboard pages**  
> - Public profile pages  
> - Authentication flows (**OTP-based only**, no passwords)  
> - Onboarding screens  
> - Waitlist screens  
>  
> **What to Measure (Perceived Performance)**  
> For each page/screen, capture:
> - Time to first contentful paint (or closest Playwright-accessible equivalent)  
> - Time until the page is **visually complete and interactively usable** (not just network idle)  
> - Major blocking delays (long tasks, delayed hydration, client-side rendering stalls), when observable  
>  
> Measurements should reflect **real user navigation paths** (e.g., clicks and transitions), not direct URL loads unless unavoidable.  
>  
> **Performance Targets (Reference Budgets — Warn Only)**  
> Use Gmail-style perceived performance targets:
> - **~100ms:** ideal (instant response)  
> - **≤300ms:** fast, no noticeable delay  
> - **≤1s:** acceptable but requires attention  
>  
> These are **reference thresholds only**. Exceeding them should produce warnings, not failures.  
>  
> **Behavior Requirements**  
> - Do **not** fail tests based on performance  
> - Emit clear, structured **warnings** when thresholds are exceeded  
> - Output metrics in a **machine-readable format** (JSON or structured logs) suitable for future trend analysis  
> - Make it trivial to upgrade warnings → hard failures later via configuration  
>  
> **Playwright Constraints & Guidance**  
> - Use Playwright-native APIs where possible (`performance.timing`, `PerformanceObserver`, tracing, etc.)  
> - Avoid introducing flakiness or significant test runtime overhead  
> - Keep instrumentation **isolated, reusable, and composable** across tests  
>  
> **Deliverable**  
> Implement the instrumentation and integrate it into existing core Playwright E2E tests.  
> Include concise inline comments explaining:
> - What is being measured  
> - Why it reflects **perceived** performance rather than raw load time  
>  
> Do not refactor unrelated test logic.

---

If you want to push this further later, I’d recommend:
- Adding **p50 / p95 aggregation per route**
- Flagging **regressions vs baseline** instead of absolute thresholds
- Capturing **client-side hydration completion** explicitly (huge for perceived speed)

Say the word and I’ll extend the prompt in that direction.


## See Also
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
- [[chatgpt/chatgpt_ai-setup-instructions]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part1]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part10]]
