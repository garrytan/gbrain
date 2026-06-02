---
title: "Product Feedback and Issues"
type: guide
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
topic: music-production
message_count: 7
tags: [chatgpt, knowledge, music-production]
---
**Topic:** [[chatgpt-knowledge/_topics/music-production]]

# Product Feedback and Issues

> **Source:** ChatGPT conversation
> **Date:** 2026-05-10T19:16:14Z
> **Messages:** 7
> **Topic:** music-production

## Question

{'asset_pointer': 'sediment://file_000000005c2c71f5b5f0088286cfc75a', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 206, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 39966, 'width': 642}

I'm going to go through right now and give you everything that I see that is wrong with the products, okay? It's gonna be a giant mess. First up, I'm on the home page. Header's looking pretty slick. I know that we probably shipped- I don't know if the home page I'm looking at on production is up-to-date or not but the Blanco y Negro and RecPlay logos in the logo bar are not real logos, they're just text. Those should be cleaned up. If we can't find prop

## Answer

Mr. White, the pattern is clear: production is shipping without a hard-enforced “public surface + signup + onboarding + chat” release gate.

I checked the GitHub repos I could access. The current `JovieApplication` `package.json` only exposes `dev`, `build`, `start`, and `lint`; it does not define unit, integration, E2E, accessibility, visual regression, or smoke-test scripts. Its dependencies also do not show Playwright/Cypress/Vitest/Jest/Axe-style test tooling. fileciteturn3file0 The older Nuxt repo looks similar: build/dev/generate/preview/postinstall, with no test script surface. fileciteturn4file0 If this is the production app/repo, the answer to “why didn’t our tests catch this?” is simple: the actual release-critical test harness does not appear to exist in the executable project surface.

## P0 — stop bleeding immediately

### 1. Signup/auth is broken or misleading

**Observed issues**
- Apple signup returned invalid client.
- Signup page uses sign-in copy: “Welcome back / no account / sign up.”
- Signup modal says “Create your account,” but typography/layout is janky.
- Modal back button is janky.
- Sign-in button/link inside auth flow does not navigate correctly.
- Clerk proxy error / JSON browser error.
- User can get logged out unexpectedly.
- Homepage CTAs do not reliably send users into a working signup path.

**Best fix**
- Stop using auth modals for now unless the modal is fully hardened. Route all public CTAs to `/sign-up`.
- Keep `/sign-in` and `/sign-up` as first-class pages.
- Disable Apple in Clerk production until credentials are valid. You already did this manually; now add a config guard so it cannot silently appear when broken.
- Refactor auth UI into one shared `AuthShell` component with `mode="sign-in" | "sign-up"`.
- Make page and modal use the exact same content model, typography scale, links, and provider list.
- Fix Clerk proxy/env config before touching design polish.

**Guardrails/tests**
- Playwright: every public CTA with `data-testid="cta-sign-up"` must navigate to `/sign-up` or open a signup modal with `role="dialog"` and `data-auth-mode="sign-up"`.
- Playwright: `/sign-up` must contain signup copy, signup form/providers, and a working link to `/sign-in`.
- Playwright: `/sign-in` must contain sign-in copy, sign-in form/providers, and a working link to `/sign-up`.
- Playwright: auth modal close behavior works by Escape, backdrop click, visible close button, and browser back.
- Config test: social providers shown in UI must match enabled provider config. If Apple credentials are missing, Apple cannot render.
- Smoke test: production-like environment must complete the first unauthenticated CTA → signup page → auth attempt → onboarding/waitlist handoff path.

---

### 2. Chat input is broken

**Observed issues**
- First message gets rate-limited.
- Chat message does not send.
- Slash command causes layout shift.
- Entity chip/smart chip for “Taylor Swift” becomes janky.
- Input focus ring shows square/incor

*(Answer truncated — 18193 chars total)*

## Question

jovieinc/jovie the actual repo. We ground this in the actual repo. There's extensive testing on it already, and a whole system of checks and stuff. PRs already have to pass through a bunch of gates. 

## Answer

Mr. White, you’re right. My previous read was pointed at the wrong repo.

I inspected `JovieInc/Jovie`. The repo already has a serious testing and gate system: root scripts include `test`, `test:ci`, `test:e2e`, `test:web:e2e`, `test:web:smoke`, `test:guard`, `test:flaky`, `next:proxy-guard`, `tailwind:check`, `pre-push`, and Playwright/Vitest dependencies. fileciteturn26file0 The web app has even more: Golden Path, smoke, synthetic, visual regression, screenshots, Axe, Lighthouse for public/dashboard/onboarding/admin/chat, public route QA, exhaustive public surface QA, overnight QA, mutation hotspots, and performance budget checks. fileciteturn27file0

The right diagnosis is: the system exists, and several of the failures are slipping through because the assertions are too shallow, too scoped, or preserving bad states.

## What the current repo is actually doing well

There are real launch gates. `docs/launch/LAUNCH_GATES.md` says launch-candidate PRs require `PR Ready`, `Golden Path (PR)`, dashboard Lighthouse, and onboarding Lighthouse; those gates activate for auth signup/signin entrypoints, onboarding, dashboard shell/releases, billing/checkout, golden-path specs/helpers, and launch-gate config. fileciteturn36file0

There is synthetic production monitoring. The workflow runs against `https://jov.ie`, uses Doppler production secrets, executes `synthetic-golden-path.spec.ts` plus public profile smoke, parses results, fails the job if tests fail or skip, and sends Slack alerts. fileciteturn52file0

There is public surface QA. `public-surface-qa.ts` builds the production app locally, seeds data, runs public route QA, public exhaustive Playwright tests on desktop/mobile, Axe audit, performance budgets, and public Lighthouse. fileciteturn42file0

The homepage spec is already extensive: it checks hero copy, CTA hrefs, header CTA hrefs, product sections, image quality, pricing card layout, mobile drawer CTAs, overflow across common viewports, and console errors. fileciteturn47file0

## The gaps that explain your observed bugs

### 1. The homepage tests are currently blessing the bad copy

The public copy source contains:

`specWall.headline: 'Answers for every launch objection'`

and the body copy you flagged. fileciteturn46file0

The homepage E2E test explicitly asserts that this exact heading is visible. fileciteturn47file0 That turns bad customer-facing copy into a passing requirement.

**Fix:** replace or flag off the section, then add a public-copy guard that fails on internal-facing words in public marketing surfaces: `objection`, `request access` where signup is intended, `waitlist` outside approved contexts, `test song`, `fake data`, placeholder copy, and internal implementation language.

---

### 2. CTA tests check `href`, then stop too early

Homepage tests assert CTAs point to `/signup`, including hero, header, artist profiles, mobile drawer, and final CTA. fileciteturn47file0 That catches broken links, but it 

*(Answer truncated — 12280 chars total)*

## Question

jovieinc/jovie is the code repo. There's extensive testing in place in the actual repo, so you obviously didn't look at the right repo, it seems. Make no assumptions if you've not actually analyzed the repo. Compile this whole thing together with knowledge of the repo if you can, and then no additional assumptions. Give me the whole thing, everything included, as a handoff prompt I can get to Clonk code, which will have knowledge of the repo. Have it investigate all of this and harden all of this and build tests. 

## Question

Also instructed to use G-Brain and to make sure all of this knowledge exists in G-Brain. Instructed to use ROOTFLOW for spinning up agent teams to handle this in parallel as quickly as possible, and to make sure it uses G-STACK so that everything is validated as it ships. It ships all of this in relevant order and quickly and fully autonomously. 

## Answer

Mr. White, corrected. I verified `JovieInc/Jovie` and it has extensive testing in place. The root and `apps/web` package scripts include Playwright, Vitest, smoke, golden-path, a11y, visual, public QA, Lighthouse, guard, and profiling lanes. fileciteturn27file0 fileciteturn28file0 Existing coverage includes golden-path app/chat flows, smoke auth, signup funnel smoke, chat composer surface tests, auth route tests, public exhaustive QA, and homepage specs. fileciteturn31file0 fileciteturn34file0 fileciteturn35file0 fileciteturn36file0 fileciteturn37file0 fileciteturn42file0 One concrete repo finding: `apps/web/data/homepageLaunchCopy.ts` currently contains the public spec-wall headline “Answers for every launch objection,” and `homepage.spec.ts` currently asserts that exact heading, so at least one problem is encoded as passing behavior. fileciteturn44file0 fileciteturn45file0

Paste this into Clonk Code:

```text
You are working in the real Jovie repo: JovieInc/Jovie.

Do not assume anything. Start by inspecting the actual repo, current branch, tests, CI gates, G-Brain knowledge, G-STACK validation conventions, ROOTFLOW conventions, routes, components, feature flags, Statsig/config, Clerk config integration, and deployment pipeline.

Primary objective:
Investigate and harden the current production product issues described below. Fix the issues, add/repair tests and guardrails so they cannot regress, record all durable product/test knowledge in G-Brain, use ROOTFLOW to parallelize agent teams, and use G-STACK validation before shipping each relevant batch. Work fully autonomously unless blocked by credentials, destructive production changes, or a genuinely ambiguous business decision.

Founder QA context:
The product was manually tested on production/current web surface. The reported failures are blocking confidence in the signup funnel, homepage, onboarding, chat, consent, and launch-readiness quality bar. Some issues may already have partial coverage in tests. Your job is to investigate why existing coverage did not catch them, update the product, and harden the relevant lanes.

Mandatory operating instructions:
1. Use G-Brain first.
   - Read existing G-Brain knowledge for Jovie web, launch gates, public surface QA, homepage, auth, onboarding, waitlist, pricing, chat, cookies/consent, Clerk, seed data, screenshots, public profiles, G-STACK, and ROOTFLOW.
   - Do not duplicate stale knowledge. Update or supersede it.
   - Add a durable G-Brain entry for this incident/QA pass with:
     - issue summary
     - root causes found
     - files/components touched
     - test gaps found
     - new guardrails added
     - validation commands run
     - remaining risks or follow-ups
2. Use ROOTFLOW.
   - Spin up parallel agent teams for:
     A. Homepage/marketing/copy/logo/pricing/seed-screenshot surface
     B. Auth/signup/signin/Clerk/modal/onboarding handoff
     C. Chat composer/rate-limit/smart chips/keyboard shortcuts/

*(Answer truncated — 25712 chars total)*
