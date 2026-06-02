---
title: "Audit of CLAWD MD"
type: guide
created: 2025-08-24
updated: 2025-08-24
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Audit of CLAWD MD

> **Source:** ChatGPT conversation
> **Date:** 2025-08-24T20:32:51Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

# Claude AI Guidelines for Jovie Project

## Critical Rules

### ⚠️ **NEVER PUSH TO PREVIEW OR PRODUCTION**

- **NEVER push directly to `preview` or `production` branches**
- **Work on feature branches opened from `preview`**
  - Naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>` where `<slug>` is 3–6 words, kebab-case
- **Open a PR against `preview`**
  - PRs must be up-to-date with `preview` and pass all checks
  - Auto-merge to `preview` after green CI is allowed
- **Promotion to `production` is manual via PR** (no auto-merge to `production`)

### 🔒 **Branch Protection**

- `preview` and `production` are protected branches
- No direct pushes to protected branches
- All changes flow via PR to `preview` with an up-to-date-with-`preview` requirement
- After CI success, feature PRs may auto-merge into `preview`
- Promotion from `preview` → `production` is performed manually via a PR per policy

## Feature Development & Branching (Windsurf Rules)

Follow this standardized flow whenever 

## Answer

Mr. White—here’s a tight audit of your CLAWD MD with concrete fixes. I focused on failure modes I’d expect from AI-generated diffs + your current rules.

# High-priority inconsistencies & gaps

1) **Billing inconsistency (critical)**
- Your prior directive: *“We don’t use Clerk billing; we use Stripe directly.”*  
- Current doc: a full “Clerk Billing with Stripe” section.  
**Fix:** Remove Section 2 entirely or replace with **Direct Stripe** guardrails (Checkout/Customer Portal via Stripe, Stripe Webhooks → server routes, plan/feature gating via your DB, not Clerk `has()`).

2) **Auth edge cases (Clerk ↔ Supabase)**
- You mandate native integration (good), but don’t specify **null/expired token behavior**, SSR/Edge nuances, or claim mapping verification.  
**Fix:** Add rules for:
  - `accessToken()` may return `null` → block DB calls; show auth-required UI.
  - Verify `auth.jwt()->>'sub'` equals Clerk User ID claim; fail fast if mapping drifts.
  - Server-only use of service-role key; never ship to client/edge.
  - Explicit guidance for **App Router** server actions & route handlers (no ad-hoc token plumbing).

3) **Feature flags lifecycle**
- You require flags (good) but no lifecycle hygiene.  
**Fix:** Add: owner, rollout plan, kill-switch SLA, expiry date, task to **remove** flag within 2 releases after GA.

4) **Tests: flake + scoping**
- You require unit/E2E but no flake policy or runtime budgets.  
**Fix:** Define: Playwright retries (e.g., 2), per-spec timeout (e.g., 60s), network idle strategy, test data isolation (seed/teardown), and a lightweight **Smoke E2E** (login → create → primary CTA) that runs pre-PR.

5) **TypeScript strictness is underspecified**
- You mention “explicit types” historically, but AI will still sneak `any`, swallowed promises, and null bugs.  
**Fix:** Enforce via config & lint rules (see “Concrete rule inserts” below).

6) **CI short-circuiting + PR hygiene**
- You require all checks, but not the order/short-circuit to save time.  
**Fix:** Stop pipeline at **typecheck/lint** failures; block Chromatic/E2E until basics pass. Add PR size guardrail and label requirements.

7) **PostHog schema discipline**
- You ask to instrument events, but not naming/versioning or PII rules.  
**Fix:** Add an **event contract** (naming, required props, versioning, no PII) and a CI schema check.

8) **Migrations & RLS safety**
- You require RLS but not safe rollout patterns.  
**Fix:** For schema changes: phased migrations (add columns → backfill → flip reads/writes → drop old), “preflight” RLS policies, and **down** migrations required.

9) **Observability**
- You mention Sentry verify, but not coverage or guardrails that stop promotion.  
**Fix:** Require Sentry DSN in envs, error rate budget gates on preview, and forbid `console.*` in production builds.

10) **Design/UX guardrails for AI**
- You want Linear/Apple minimalism but don’t codify tokens & patterns.  
**Fix:** Lock in **design tokens** (grayscale-first, accent-agnostic)

*(Answer truncated — 9395 chars total)*

## Question

Cool, let's definitely add in number 1, completely remove any mention of clerk billing, we're just using Stripe. And we're also going to use the Stripe hosted billing portal. 2, yep, you can clean that up for sure. 3, yep, that's good. 4, yep, we can add that. 5, yep, that's good. Good. Good for 6, 7 good, 8 good, 9 we can skip for now, 10 is good. Modify the Claw.md file directly and then give me an AI prompt and I'll have Windsurf set up the new lint rules.

## Answer

Done, Mr. White. I removed all Clerk billing references, added Direct Stripe + Hosted Portal, and inserted the guardrails you approved (2,3,4,5,6,7,8,10). I skipped observability (9) as requested. The file now enforces DB-backed entitlements, webhook-driven state, and stronger TS/CI/E2E rules.

Here’s a clean **AI prompt for Windsurf** to set up the new lint + TS rules:

---

**Windsurf Prompt — Apply TS/Lint Guardrails**

> Update the repo to enforce these TypeScript and ESLint rules across all packages:
>
> **TypeScript (`tsconfig.json`):**
> - Set `"strict": true`.
> - Add: `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"useUnknownInCatchVariables": true`, `"noImplicitReturns": true`, `"noFallthroughCasesInSwitch": true`.
> - Ensure path aliases (`@/*`) are configured in `compilerOptions.paths` and match `tsconfig` + tooling.
>
> **ESLint (`.eslintrc.*`):**
> - Error (not warn) on:
>   - `@typescript-eslint/no-explicit-any`
>   - `@typescript-eslint/no-floating-promises`
>   - `@typescript-eslint/await-thenable`
>   - `@typescript-eslint/no-misused-promises`
>   - `no-console` (allow `console.warn`/`console.error` **in development only** via env override)
> - Enforce sorted imports and path-alias usage (no deep relative imports to cross feature boundaries).
> - Add a rule or plugin to forbid exposing secrets/env values in logs (simple regex redaction rule OK).
>
> **Pre-commit (Husky / lint-staged):**
> - Run: `eslint --max-warnings=0`, `tsc -p tsconfig.json --noEmit`, and unit tests on staged files.
>
> **CI (GitHub Actions):**
> - Job order with hard fail fast: `lint → typecheck → unit` then only if green: `build → storybook/chromatic (iff UI changed) → e2e:smoke`.
> - Cancel downstream jobs on failure of lint/typecheck/unit.
>
> **Docs:**
> - Add a short `docs/engineering/ts-lint-guardrails.md` summarizing the rules and the rationale (AI diff hygiene).
>
> Make all edits and open a PR titled:  
> `[chore]: enforce strict TS + ESLint guardrails (fail-fast CI)`

---

If you want, I can also generate the GitHub Actions job snippet and a baseline `.eslintrc`/`tsconfig` diff next.

## Question

We have a nice, beautiful transition on the button. It goes to a loading state with a little spinner on the loading state. And then we have a nice, beautiful transition when you click the Listen button to take you to the Listen mode, where the page switches to have all of the DSP links. However, during that transition, it's moving the whole page instead of just the stuff that's changing. So the profile image is doing a transition and stuff just to reload the profile image and stuff like that. So that needs to be cleaned up. We need a linear issue for that.

## Answer

Mr. White—here’s a tight Linear ticket you can paste.

**Title**  
Fix Listen transition so only content pane animates (no global reflow / image remount)

**Description**  
Clicking **Listen** triggers a smooth loading→DSP view animation, but the **entire page reflows**: the profile image and static header areas re-animate/reload. Only the content pane that switches to DSP links should transition.

**Current**  
- Button: nice loading spinner → route/state change.  
- Transition: whole page shifts; profile image re-mounts/animates; jank.

**Expected**  
- Only the “content pane” (links/listen panel) animates.  
- Header/profile block remains fixed (no remount, no opacity/position changes).  
- Zero CLS during the transition.

**Steps to Repro**  
1. Open a creator profile.  
2. Click **Listen**.  
3. Observe profile image/header re-animating.

**Scope / Acceptance Criteria**  
- [ ] Profile image & header do not re-mount or animate during Listen transition.  
- [ ] Layout shift (CLS) = 0 for header region.  
- [ ] Only the content pane animates (opacity/translate), <= 250ms, ease-out.  
- [ ] Spinner uses reserved space—no button width/height change.  
- [ ] Mobile & desktop parity.

**Tech Notes / Likely Fixes**  
- Keep static regions outside the transitioning subtree:  
  - Structure as `Header (static) + ContentPane (switches modes)`.  
- Prevent remounts:  
  - Remove changing `key` props on top-level layout wrappers.  
  - `React.memo` the header/profile block; stable props.  
- Contain animation to pane:  
  - Wrap pane in a container with `contain: layout paint; will-change: transform;`  
  - Animate via `transform`/`opacity` (no layout-affecting properties).  
- Reserve space for loading states: fixed button dimensions; spinner absolutely centered.  
- Image stability:  
  - Ensure `next/image` has fixed `width/height` (or `fill` + fixed parent) and **stable `src`**.  
  - Avoid state/param changes that rebuild the `Image` component; memoize computed `src`.  
- Routing/state:  
  - Prefer client-state toggle for Listen mode when possible; avoid full route change.  
  - If routing, keep header in a persistent layout (`app/(profile)/layout.tsx`) so it isn’t replaced.  
- Optional: guard with Framer Motion `layout` only on the pane; disable on header block.

**PostHog / Metrics**  
- Event: `listen_mode_enter` with `latency_ms` (time from click → pane settled).  
- Watch `ui_cls_event` for non-zero CLS in header region.

**Rollback**  
Revert pane-scoped animation; keep existing behavior.

**Flag**  
`feature_listen_transition_refine` (default OFF → internal only for QA).
