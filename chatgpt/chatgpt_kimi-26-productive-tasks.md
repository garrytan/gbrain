---
title: "Kimi 2.6 Productive Tasks"
type: guide
created: 2026-04-30
updated: 2026-04-30
source: chatgpt-export
conversation_id: 69f2dd3a-4288-83e8-ad31-9dcf3f641fa3
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# Kimi 2.6 Productive Tasks

> Conversation ID: 69f2dd3a-4288-83e8-ad31-9dcf3f641fa3
> Created: 2026-04-30T04:41:30Z
> Updated: 2026-04-30T06:19:58Z
> Messages: 2

---

## User

i have kimi 2.6 free use and worktrees to run it in. for jovie. give me the most productive tasks to throw at it that are sefl contained use gstack skill ship and land themselves. onboarding powered by ai or agent infra are of interest but hardening and qa are propbably the most productive

---

## Assistant

Mr. White, best use of free Kimi 2.6: give it **tight, self-contained hardening tasks** with clear verification and permission to ship. Avoid broad “build AI onboarding” until the substrate is safer.

## Best task categories for Kimi worktrees

### 1. QA hardening on public artist profiles
Highest ROI. It touches core product, user-facing conversion, and likely catches real bugs.

**Task prompt:**

```text
Use gstack.

Goal: harden public artist profiles without changing product strategy or visual direction.

Before making changes:
- Read the latest code.
- Identify the actual public profile routes/components.
- Do not assume filenames from this prompt.
- Create a short implementation plan.

Scope:
- Run the relevant QA command with the exhaustive flag against public artist/profile pages.
- Find and fix real bugs only.
- Prioritize:
  1. mobile viewport issues
  2. horizontal scroll
  3. broken loading/error/empty states
  4. broken social/music links
  5. hydration/runtime errors
  6. accessibility violations that are low-risk to fix
  7. obvious responsive layout regressions
  8. image sizing/aspect-ratio bugs
  9. analytics/event errors if visible in code
  10. 404/redirect/canonical issues on public profiles

Constraints:
- Do not redesign the page.
- Do not rewrite architecture.
- Do not change copy unless fixing broken or placeholder text.
- Keep changes small and reviewable.
- Split into multiple PRs if fixes are unrelated.

Verification:
- Run typecheck, lint, relevant tests, and the exhaustive gstack QA command.
- Capture before/after notes.
- Run /review.
- Run /ship.
- Land only if checks pass.

Deliverable:
- One or more small PRs with clear summaries.
```

---

### 2. Mobile overflow guardrail
This is perfect for an agent because it is narrow and testable.

```text
Use gstack.

Goal: prevent mobile horizontal scrolling regressions across Jovie.

Before making changes:
- Inspect latest code, existing Playwright setup, test helpers, and viewport config.
- Do not duplicate existing coverage if it already exists.

Implement:
- Add or improve automated tests that verify no horizontal overflow on key mobile viewports.
- Cover at minimum:
  - public artist profile
  - landing page
  - sign in/sign up/onboarding entry routes if present
  - dashboard/app shell route if testable
- Test viewports roughly matching modern iPhones, including narrow and large widths.
- The test should fail when document/body scrollWidth exceeds viewport width by more than a tiny tolerance.
- Prefer reusable test helpers.

Constraints:
- Focus on tests/guardrails first.
- Only fix actual overflow bugs discovered by the tests.
- Keep fixes minimal and design-system aligned.

Verification:
- Run Playwright tests for the new coverage.
- Run lint/typecheck.
- Run /review and /ship.
- Land if green.
```

---

### 3. Onboarding smoke test + failure-state audit
Good bridge between AI onboarding interest and QA productivity.

```text
Use gstack.

Goal: harden the onboarding path so users can reliably create/claim accounts.

Before making changes:
- Read latest onboarding code and auth flow.
- Identify the actual onboarding routes, feature flags, and Clerk/auth boundaries.
- Document the current flow briefly before editing.

Scope:
- Add or improve smoke/e2e coverage for the onboarding path.
- Cover:
  1. initial onboarding page loads
  2. user can proceed through required steps with mocked/minimal data
  3. validation errors are visible and understandable
  4. loading states do not dead-end
  5. auth redirects work as intended
  6. AI/user-interview step gracefully handles unavailable API/mocked failure
  7. user can recover from failed step or retry

Constraints:
- Do not build new onboarding product features.
- Do not add new AI infra.
- Do not change pricing/business logic.
- If AI services are involved, mock them for test reliability.

Verification:
- Run relevant e2e/smoke tests.
- Run lint/typecheck.
- Run /review.
- Run /ship.
- Land if green.
```

---

### 4. Error boundaries and empty states
Very productive because AI agents often expose ugly edge cases.

```text
Use gstack.

Goal: improve resilience for user-facing Jovie pages by adding/fixing error, loading, and empty states.

Before making changes:
- Inspect latest app router structure.
- Identify pages missing loading.tsx, error.tsx, not-found.tsx, or equivalent local fallbacks.
- Prioritize public profile and onboarding routes.

Scope:
- Add missing route-level loading/error/not-found states where appropriate.
- Ensure public artist profiles handle:
  - missing artist
  - artist with no releases
  - artist with no social links
  - broken/missing image
  - failed external platform match
- Ensure onboarding handles:
  - empty input
  - bad Spotify/social URL
  - failed profile generation
  - retry path

Constraints:
- Use existing design system components/tokens.
- Keep states minimal, premium, and consistent.
- No broad redesign.
- No new product copy beyond concise fallback text.

Verification:
- Add tests where practical.
- Manually/automatically verify the affected routes.
- Run lint/typecheck.
- Run /review and /ship.
- Land if green.
```

---

### 5. Feature flag cleanup / mixed Statsig + Vercel Flags audit
High leverage because this has caused agent confusion before.

```text
Use gstack.

Goal: audit and harden feature flag usage in Jovie.

Before changing code:
- Read latest code for Statsig and Vercel Flags usage.
- Identify all feature flags, server/client boundaries, and duplicate/mixed patterns.
- Produce a short findings note in the PR body or a docs file.

Scope:
- Fix only low-risk inconsistencies.
- Add guardrails/tests where useful.
- Ensure flags used in onboarding/public profiles have safe defaults.
- Ensure server-only flag evaluation is not accidentally imported into client components.
- Ensure missing env/config does not crash public pages.

Constraints:
- Do not migrate the entire flag system unless it is already clearly intended in the codebase.
- Do not remove active flags unless obviously dead and verified.
- Prefer documentation and small fixes over architecture rewrite.

Verification:
- Run typecheck/lint/tests.
- Run /review and /ship.
- Land only if green.
```

---

### 6. Analytics instrumentation QA
Useful because onboarding/product learning depends on events.

```text
Use gstack.

Goal: verify and harden analytics events for public profile and onboarding funnels.

Before making changes:
- Inspect existing analytics provider(s), naming conventions, and event helpers.
- Do not invent a new analytics system.

Scope:
- Audit key funnel events:
  - public profile viewed
  - platform/link clicked
  - notify/fan capture CTA clicked
  - signup started
  - onboarding started
  - onboarding completed
  - profile claimed/generated if applicable
  - pricing/trial started if applicable
- Fix missing or broken events only where safe.
- Add lightweight tests/mocks where practical.
- Ensure events do not include sensitive/private data unnecessarily.

Constraints:
- Keep event names consistent with existing conventions.
- Avoid noisy duplicate events.
- No major refactors.

Verification:
- Run tests/typecheck/lint.
- Add a short event map to the PR summary.
- Run /review and /ship.
- Land if green.
```

---

### 7. Broken links + SEO metadata sweep
Low risk, very self-contained, directly tied to acquisition.

```text
Use gstack.

Goal: harden public SEO/link behavior for Jovie public pages.

Before changes:
- Inspect latest routing, metadata generation, sitemap/robots/canonical logic.
- Identify actual public routes.

Scope:
- Check and fix:
  - missing/incorrect canonical URLs
  - malformed Open Graph/Twitter metadata
  - broken favicon/social preview image references
  - broken profile URLs
  - sitemap inclusion/exclusion mistakes
  - robots rules that block intended public pages
  - 404 behavior for missing profiles
  - trailing slash/case handling if relevant

Constraints:
- Do not change brand positioning/copy.
- Do not redesign pages.
- Keep fixes minimal.

Verification:
- Add/adjust tests where practical.
- Run relevant route/metadata checks.
- Run lint/typecheck.
- Run /review and /ship.
- Land if green.
```

---

## Best “AI onboarding” tasks that are still safe

Do these before asking Kimi to build the actual agent.

### 8. AI onboarding schema + mocked interview contract

```text
Use gstack.

Goal: define the minimal AI onboarding interview contract without building full agent infra.

Before changes:
- Read existing onboarding code.
- Find current data models, validation libraries, server actions/API routes, and tests.

Scope:
- Add a typed schema for onboarding interview state.
- Include fields for:
  - artist goal
  - current release workflow
  - fan capture status
  - biggest objection/blocker
  - primary platform links
  - pricing/trial eligibility state if already present
  - next recommended action
- Add validation.
- Add mocked fixtures for tests.
- Add tests proving valid/invalid interview states behave correctly.
- If there is an existing onboarding UI, wire only the safest minimal mocked path.

Constraints:
- No live LLM calls.
- No agent framework.
- No Trigger.dev queue.
- No broad UI redesign.
- Keep this as a foundation PR.

Verification:
- Run unit tests, typecheck, lint.
- Run /review and /ship.
- Land if green.
```

### 9. Objection-handling copy/state machine only

```text
Use gstack.

Goal: add a small, typed objection-handling foundation for AI onboarding.

Before changes:
- Inspect onboarding and pricing/trial code.
- Identify where objections would be represented.

Scope:
- Create a small typed objection taxonomy:
  - price
  - time/setup effort
  - already uses Linktree/Feature.fm/ToneDen
  - not releasing music soon
  - wants to see examples first
  - privacy/data concern
  - unclear value
- Add deterministic response templates or next-action mappings.
- Add tests for mapping objection -> response/next action.
- Do not expose this in production UI unless an existing safe place already exists.

Constraints:
- No live AI.
- No new agent infra.
- No major UX changes.
- Keep PR foundational and testable.

Verification:
- Run tests/typecheck/lint.
- Run /review and /ship.
- Land if green.
```

---

## My top 5 to run tonight

1. **Public profile exhaustive QA**
2. **Mobile overflow guardrail**
3. **Onboarding smoke test + failure states**
4. **Error/loading/empty states**
5. **SEO/link metadata sweep**

Those are the highest-probability “agent can finish and land” tasks.

## Avoid giving Kimi these yet

Avoid:

```text
Build AI onboarding end-to-end.
Build agent infrastructure.
Implement Trigger.dev pipeline.
Create memory system.
Rebuild onboarding from scratch.
Design world-class onboarding UX.
```

Those are too open-ended. They will sprawl, break architecture, or create fake infra.

## Best master prompt to paste into Kimi

```text
You are working in a Jovie worktree.

Use gstack skill.

Your job is to complete one self-contained hardening task, ship it, and land it if green.

Rules:
- Read the latest code before making assumptions.
- Keep scope small.
- Prefer tests and guardrails over redesigns.
- Do not rewrite architecture.
- Do not introduce new dependencies unless clearly justified.
- Do not change product strategy, pricing, or copy unless fixing broken/placeholder text.
- Use existing design system components/tokens.
- If you find unrelated issues, note them but do not fix them in this PR.
- Split into multiple PRs if changes are unrelated.
- Run relevant tests, lint, typecheck, and gstack QA commands.
- Run /review.
- Run /ship.
- Land only if checks pass.
- If blocked, leave a precise note with the command/error and smallest next step.

Task:
[PASTE ONE TASK FROM ABOVE]
```

Most productive setup: launch **5 Kimi worktrees**, one task each, with the first five above. That gives you parallel PRs with low collision risk.
