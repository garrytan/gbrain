
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

Homepage tests assert CTAs point to `/signup`, including hero, header, artist profiles, mobile drawer, and final CTA. fileciteturn47file0 That catches broken links, but it does not prove the user lands on a working signup experience.

**Fix:** every public signup/pricing CTA test should click through and assert:

1. URL is `/signup` or `/signup?plan=...`.
2. `#auth-form` renders.
3. Correct signup-specific copy renders.
4. At least one enabled, configured auth method renders.
5. No Clerk proxy error, JSON error, or invalid-client page appears.
6. Opposite-mode link routes to `/signin`.
7. Plan intent is persisted when `?plan=` is present.

---

### 3. Synthetic Golden Path has a signup coverage escape hatch

The production synthetic test clicks the homepage primary CTA and reaches `/signup`. Then it looks for email signup. If email signup is unavailable, it only asserts that an Apple or Google OAuth button is visible, logs a warning, and does not complete onboarding/profile creation. The warning text says onboarding/profile creation is not exercised while production email signup is unavailable. fileciteturn53file0

That means a visible Apple button can satisfy the synthetic path even if clicking Apple produces `invalid_client`.

**Fix:** synthetic signup must fail unless one complete signup path works. “OAuth visible” is insufficient. Either:

- use a production-safe test email signup path, or
- click the rendered OAuth provider and assert it starts a valid provider flow without `invalid_client`, then stop at a safe expected boundary.

Synthetic warnings on signup coverage should be treated as failures for launch readiness.

---

### 4. Auth tests check render health more than exact product behavior

`auth.spec.ts` verifies signin/signup render Clerk UI, legal links show, and signin/signup navigation preserves `redirect_url`. It accepts broad Clerk UI selectors like email input, Continue, Google, Sign up, or Sign in. fileciteturn50file0

`smoke-auth.spec.ts` checks signin/signup pages load without 5xx and that the body has content. fileciteturn39file0

`smoke-prod-auth.spec.ts` verifies production sign-in with seeded credentials and dashboard/tab navigation. It does not create a new production signup. fileciteturn51file0

The auth README also says Clerk Dashboard configuration is the source of truth for enabled auth methods and providers. fileciteturn49file0 That makes provider-config drift a real risk unless production/staging tests click or validate the rendered provider list.

**Fix:** add an auth contract spec:

- `/signup` must contain signup copy, not signin copy.
- `/signin` must contain signin copy, not signup/request-access copy.
- Signup page must expose link to signin.
- Signin page must expose link to signup.
- Every rendered social provider must be allowed by a testable provider config.
- Apple must be hidden when Apple credentials are missing.
- Clicking Apple/Google in staging/production smoke must never produce `invalid_client` or Clerk proxy JSON errors.

---

### 5. Chat Golden Path covers one happy command, not the broken states you hit

`golden-path-app.spec.ts` has a chat test that signs in, opens `/app/chat`, fills `preview profile`, clicks send, and asserts an assistant message appears containing “profile.” fileciteturn31file0

That is useful, but it does not cover:

- fresh first message being rate-limited,
- normal “hello” send path,
- slash command layout shift,
- smart chip/entity state for “Taylor Swift,”
- input focus ring behavior,
- global `T` theme shortcut interfering with chat.

The ChatInput unit tests cover focused send, attachment menu, and quick actions. fileciteturn59file0 The actual global `T` shortcut exists in `CoreProviders.tsx`; it toggles theme on `/app`, `/onboarding`, `/signin`, `/signup`, and `/waitlist`, unless the event target is detected as a form element. fileciteturn61file0

**Fix:** create `chat-composer-contract.spec.ts`:

- fresh signed-in user sends `hello`; no first-message rate-limit.
- `T` pressed in chat does not toggle theme.
- `/` opens the picker with composer surface height/position within a strict delta.
- “Taylor Swift” entity/chip path keeps the input editable and sendable.
- focus-visible state screenshots compare against expected rounded composer focus.

Also remove or dev-gate the global `T` shortcut. It has too much production blast radius.

---

### 6. Cookie banner tests are unit-state tests, not browser clickability tests

The code path does set analytics and marketing true on Accept All. fileciteturn64file0 Cookie unit tests confirm Accept All stores `marketing: true`, Reject stores `marketing: false`, and saved modal preferences load. fileciteturn68file0

That still misses the actual bug you saw: buttons can exist and unit-test correctly while being unclickable in a real viewport because of overlay, z-index, pointer-events, safe-area layout, or responsive expansion.

Public exhaustive QA includes optional `cookie-banner` interactions in the public surface manifest. fileciteturn44file0 The exhaustive spec runs declared interactions and checks no critical errors/overflow. fileciteturn43file0 Optional interaction means this can pass without proving Accept All and Save Preferences work on the homepage in desktop/mobile.

**Fix:** make cookie consent a required browser-level contract for `home`, `legal-cookies`, and marketing pages:

- force `jv_cc_required=1`;
- click Accept All on desktop and mobile;
- assert banner hides and localStorage/cookie reflect analytics+marketing true;
- reopen preferences;
- toggle analytics/marketing;
- click Save Preferences;
- assert saved state persists after reload.

---

### 7. Pricing behavior is controlled by env and defaults only Free active

`marketingPricingPlans.ts` defaults `NEXT_PUBLIC_MARKETING_ACTIVE_PLANS` to `free`. Pro and Team use `waitlistCtaLabel: 'Request Access'` unless marked active. All plan hrefs still route to `/signup?plan=${planId}`. fileciteturn71file0

The signup page captures `?plan=` and stores plan intent. It currently renders “Request Access” and sends successful signup to `APP_ROUTES.WAITLIST`. fileciteturn72file0

**Fix:** align public pricing with the intended product behavior:

- mark Pro active if users should be able to select it;
- replace public “Request Access” with signup/trial language where appropriate;
- preserve internal gating after signup;
- add test coverage that Free and Pro CTAs click through, preserve plan intent, and reach onboarding/waitlist gating without public “waitlist/request access” framing.

## P0 changes I would make to the existing system

| Area | Existing file(s) | Current gap | Required change |
|---|---|---|---|
| Bad public copy | `apps/web/data/homepageLaunchCopy.ts`, `homepage.spec.ts` | Test asserts “launch objection” | Rewrite/flag section; add public-copy guard |
| CTA/signup | `homepage.spec.ts`, `auth.spec.ts`, `synthetic-golden-path.spec.ts` | Href/render checks stop before working signup | Click every CTA through to working auth shell |
| OAuth | Auth README, `smoke-prod-auth.spec.ts` | Provider visibility can pass while provider is invalid | Provider canary: rendered providers must start valid auth flow |
| Synthetic | `synthetic-golden-path.spec.ts` | Warning permits incomplete signup coverage | Treat signup coverage warnings as failures |
| Chat | `golden-path-app.spec.ts`, `ChatInput.test.tsx`, `CoreProviders.tsx` | Happy command only; no slash/chip/T/rate-limit coverage | Add chat composer contract spec; remove/dev-gate `T` |
| Cookie | `CookieBannerSection.tsx`, `CookieModal.tsx`, cookie unit tests, public manifest | Unit state passes while browser clickability can fail | Required browser click tests at desktop/mobile |
| Pricing | `marketingPricingPlans.ts`, signup page | Active plan/env mismatch creates Request Access flow | One plan-intent contract from pricing → signup → gating |

## The gate adjustment

Add one new required lane: **P0 Conversion Contract**.

It should run on merge queue, main, launch-candidate PRs, and any PR touching:

- `apps/web/app/(home)/`
- `apps/web/components/features/home/`
- `apps/web/data/homepageLaunchCopy.ts`
- `apps/web/data/marketingPricingPlans.ts`
- `apps/web/app/(auth)/`
- `apps/web/components/features/auth/`
- `apps/web/components/jovie/`
- `apps/web/components/chat/`
- `apps/web/components/organisms/Cookie*`
- `apps/web/lib/cookies/`
- `apps/web/components/providers/CoreProviders.tsx`

The lane should include:

- homepage CTA click-through contract;
- auth copy/provider contract;
- cookie consent browser contract;
- chat composer contract;
- pricing plan-intent contract;
- public-copy guard;
- seed/screenshot media contract.

## Bottom line

The repo has the right foundation. The failures came from contract gaps:

- tests proving presence instead of completion;
- optional interactions where the product needs hard requirements;
- synthetic warnings where launch readiness needs failure;
- exact assertions preserving bad copy;
- missing production-provider canaries;
- missing real-browser clickability checks;
- missing chat composer edge-state coverage.

I did not run the suite; this is based on repo inspection. The immediate highest-leverage fix is to turn the specific bugs you found into hard P0 regression contracts inside the existing Playwright/QA/gate system rather than adding another broad test layer.


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
     C. Chat composer/rate-limit/smart chips/keyboard shortcuts/focus rings
     D. Cookies/consent/legal-behavior alignment
     E. Testing/guardrails/CI/G-STACK/release gates
     F. G-Brain documentation and coverage audit
   - Run these in parallel where possible, but serialize shipping/merge order by risk:
     P0 signup/auth/chat/cookie/internal-copy removal first
     P1 homepage data/pricing/logo/focus/seed-data hardening second
     P2 polish/animation/footer/card-height/visual refinements third
3. Use G-STACK for validation.
   - Discover the exact existing G-STACK commands and validation sequence in the repo.
   - Use existing scripts and conventions before inventing new ones.
   - Do not skip validation because a lane is slow. If a lane is flaky or currently skips coverage, investigate and fix the lane or document the precise reason with a mitigation.
   - Validate each shipped batch with the relevant subset, then run the full required stack before final.
4. No assumptions.
   - Verify actual current behavior locally/staging/prod-equivalent.
   - Verify what existing tests cover and what they only appear to cover.
   - Update tests that currently assert bad behavior.
   - Add failing regression tests before or alongside fixes where feasible.
   - Prefer durable source-of-truth changes over one-off patches.
5. Ship autonomously.
   - Make the changes.
   - Open/prepare PRs or commits in relevant order.
   - Record all findings in G-Brain.
   - Produce a final handoff report with exact tests run and results.

Known repo signals to verify:
- Root package has extensive scripts for build, lint, typecheck, test, E2E, smoke, guard, profile, flaky, pre-push, web-specific lanes, etc.
- apps/web has extensive Playwright/Vitest/Axe/Lighthouse/public QA/screenshot/visual/golden-path scripts.
- Existing likely relevant files/tests include:
  - apps/web/package.json
  - package.json
  - apps/web/data/homepageLaunchCopy.ts
  - apps/web/tests/e2e/homepage.spec.ts
  - apps/web/tests/e2e/auth.spec.ts
  - apps/web/tests/e2e/smoke-auth.spec.ts
  - apps/web/tests/e2e/signup-funnel.smoke.spec.ts
  - apps/web/tests/e2e/golden-path-app.spec.ts
  - apps/web/tests/e2e/chat-composer.spec.ts
  - apps/web/tests/e2e/public-exhaustive.spec.ts
  - apps/web/scripts/public-surface-qa.ts
  - apps/web/tests/e2e/axe-audit.spec.ts
  - apps/web/tests/e2e/visual-regression.spec.ts
  - any G-STACK, G-Brain, ROOTFLOW, launch-gate, and CI workflow files
- Important: homepageLaunchCopy currently contains “Answers for every launch objection,” and homepage.spec appears to assert that exact public heading. That must become a regression-prevention case, not a passing assertion.

P0 issues to investigate and fix:

1. Signup/auth is broken or misleading.
Observed:
- Apple signup returned invalid client.
- Apple was manually disabled in Clerk production during QA. Add code/config/test guardrails so broken Apple credentials cannot render in production again.
- Signup page shows sign-in copy: “Welcome back / no account / sign up.”
- Signin and signup pages appear to show the same copy.
- Signup modal says “Create your account,” but modal typography/layout is janky.
- Modal back button is janky.
- Clicking sign-in from the auth flow/modal does not navigate correctly.
- Clerk proxy error / JSON error occurred.
- User was unexpectedly logged out.
- Homepage CTA buttons must reliably route to signup or open a correct signup modal.
- For now, prefer sending public CTAs to the signup page unless the homepage hero chat/modal experience is fully hardened.

Required fixes:
- Audit signin/signup routes, route constants, Clerk components, modal auth components, CTA components, middleware/proxy, env/config, and any feature flags.
- Refactor signin/signup page and modal to shared source-of-truth components where appropriate.
- Ensure signin mode has signin copy and signup mode has signup copy.
- Ensure every signup view links to signin and every signin view links to signup.
- Ensure redirect_url/plan/handle params survive all auth mode transitions.
- Ensure provider buttons render only when configured and valid.
- Ensure Apple cannot appear in production unless credentials/config are valid.
- Investigate whether email signup should remain enabled or be hidden. Only change this if current product/config direction supports it. Record decision in G-Brain.
- Fix Clerk proxy error root cause.
- Fix unexpected logout root cause if reproducible.

Required tests/guards:
- E2E: all homepage public signup CTAs route to /signup or open a correct signup modal.
- E2E: /signup has signup-specific copy, signup UI, legal links, provider list, and signin link.
- E2E: /signin has signin-specific copy, signin UI, provider list, and signup link.
- E2E: redirect_url/plan/handle survive signin/signup link transitions.
- E2E: auth modal close/backdrop/Escape/browser-back works if modal remains supported.
- E2E: modal typography/layout matches page design system enough to prevent oversized text regression.
- Config/unit/static guard: social providers rendered in UI must match enabled/valid provider config.
- Guard: broken Apple config fails validation or hides Apple.
- Public CTA crawl: every link/button intended for signup/signin has correct destination and accessible label.
- Update existing auth/smoke/signup tests if they currently only assert “page loads” and miss incorrect copy/provider/modal behavior.

2. Chat input is broken.
Observed:
- Typing “hello” and pressing send produced a rate-limiting message on the first message.
- Chat did not send at all.
- Slash command caused layout shift.
- `T` key still toggles light mode. Remove that production shortcut.
- Mentioning “Taylor Swift” creates a smart chip but the chip/input becomes janky.
- Square focus ring/focus-visible issue appears across app, including the chat input screenshot.
- Chat is a core product path and must be a P0 test lane.

Required fixes:
- Audit ChatInput, composer surface, slash menu, smart/entity chip parsing, keyboard shortcut/theme handling, rate-limit logic, message send API, auth/session assumptions, and UI focus styles.
- Fix first-message rate-limit behavior. A fresh valid user/session must be able to send the first message.
- Ensure chat send works for plain natural-language text, not only deterministic commands.
- Remove or gate the `T` theme shortcut so it never fires while typing and does not exist as a production footgun.
- Stabilize smart chip rendering for “Taylor Swift” and other artist mentions.
- Stabilize slash command menu layout. Reserve space or otherwise prevent unintended layout shift.
- Centralize focus-visible styling for chat input and surrounding controls.

Required tests/guards:
- E2E: signed-in user can go to /app/chat, type “hello,” send it, and see the user message appear without immediate rate-limit error.
- E2E: first message from fresh/new test user is allowed.
- E2E: rate-limit test covers actual limit behavior separately.
- E2E: typing `/` opens slash command menu and layout shift stays below a strict threshold.
- E2E: typing “Taylor Swift” produces a stable smart chip and the input remains editable/sending works.
- E2E: pressing `T` while chat input is focused does not toggle theme.
- E2E/unit: theme shortcut is removed or only works in explicit non-input debug contexts, never production typing.
- Visual regression: empty, typing, slash menu, entity chip, focus, error, loading states.
- Update existing chat-composer/golden-path tests so they catch this exact failure, not only surface-mode transitions or deterministic “preview profile.”

3. Cookie/consent banner is broken.
Observed:
- Accept All cannot be clicked.
- Save Preferences cannot be clicked.
- Accept All should enable analytics and marketing according to intended product behavior.
- Current cookie banner jank must be fixed in the new one.
- Founder stated marketing/analytics should default on; verify current legal/product policy and existing consent implementation before changing defaults. Implement according to the product’s source of truth and document decision in G-Brain.

Required fixes:
- Audit cookie banner component, consent state, local storage/cookies, z-index/pointer-events, overlays, preferences modal, analytics/marketing integration.
- Fix clickability and persistence.
- Ensure preferences UI is keyboard accessible.
- Ensure consent changes actually toggle downstream analytics/marketing behavior.

Required tests/guards:
- E2E: Accept All button is clickable across desktop/mobile and enables expected categories.
- E2E: Save Preferences button is clickable and persists selected categories after reload.
- E2E: banner does not block unrelated CTAs after dismissal.
- E2E: keyboard-only consent flow works.
- Static/runtime guard: consent buttons must have nonzero bounding boxes and receive pointer events.
- Add coverage to public-surface QA if missing.

4. Public homepage contains internal/manipulative copy.
Observed:
- Spec wall says “Answers for every launch objection.”
- “Objection” is internal sales language and should not be public-facing.
- Supporting copy “The release details that usually become another tool...” is weak.
- Whole spec wall needs work.
- Cards appear to use repetitive/same animation.
- This section should be removed/flagged off in production until rewritten.

Required fixes:
- Immediately remove, hide, or rewrite spec wall copy so no internal “objection” framing appears publicly.
- Rewrite this section with customer-facing copy.
- Evaluate whether spec wall remains, is replaced, or is feature-flagged until quality bar is met.
- Update homepageLaunchCopy and all tests that currently assert bad copy.
- Add public copy guardrails.

Required tests/guards:
- Test must fail if public pages contain banned/internal terms such as “objection” in this context.
- Update homepage.spec so it asserts the new customer-facing heading or absence of the section.
- Add copy lint/static guard for public marketing copy:
  - objection
  - waitlist, unless specifically allowlisted
  - test song
  - fake data
  - lorem/placeholder
  - internal-only notes
  - manipulation/sales-internal wording
- Public-surface QA should include public copy scanning.

P1 issues to investigate and fix:

5. Logo bar has fake/text logos.
Observed:
- Blanco y Negro and RecPlay in the logo bar are text, not real logos.
- If proper logos cannot be sourced, remove them.
- If proper logos are found, format to match, optimize, and ensure the logo bar looks world-class at every breakpoint.

Required fixes:
- Audit logo bar data/assets.
- Replace text placeholders with real assets or remove entries.
- Normalize optical sizing, contrast, grayscale/color treatment, spacing, wrapping, and alt text.
- Ensure images are optimized.

Required tests/guards:
- Static guard: logo bar cannot render plain text fallback for partner/customer logos.
- E2E/visual: logo bar across mobile/tablet/laptop/desktop/ultrawide.
- Asset guard: logo entries require asset, dimensions, alt, and approved format.

6. Homepage flow feels disjointed.
Observed:
- “A new kind of operating system built for music artists” is strong.
- The next section should show the operating system immediately.
- “Go live in 60 seconds” likely belongs directly below the OS headline.
- Moving “Go live in 60 seconds” up may make “A release plan Jovie can run” feel intentional.
- Founder does not need to be involved if this reorder solves the disjointed feel.

Required fixes:
- Audit current section order and visual flow.
- Reorder sections so product narrative is coherent:
  - operating system statement
  - go live in 60 seconds / workspace proof
  - release plan Jovie can run
  - one workspace for every release
  - artist profiles built to convert
  - pricing/FAQ/final CTA
- Keep this grounded in actual current components; do not blindly apply this order if the repo already evolved. Verify.

Required tests/guards:
- Homepage spec asserts intended section order.
- Visual regression across breakpoint matrix.
- Public-surface QA catches broken anchors/scroll/CTA behavior after reorder.

7. Product screenshots/seed data use fake or generic data.
Observed:
- Screenshot uses real artists and real songs mixed with generic/fake data.
- “Don’t Look Down” is a fake test song and should not appear as a real Tim White release.
- Actual album art should be pulled for real releases.
- Collaborator credits must be correct, especially collaborations like Gilkicker/Gilken Miller, Tim White, Sober, and possibly Tom Fall.
- Since Jovie has Tim White Spotify data, seed/screenshots should use canonical Spotify-derived metadata.
- Fake status, date, and future release state are acceptable for product storytelling.
- Fake song names, fake artists, fake credits, and fake artwork are not acceptable for real artists.
- If two screenshots show the audio player, timestamps should vary so screenshots do not look duplicated.

Required fixes:
- Audit screenshot generation, product screenshot scenarios, seed data, Spotify import/canonical metadata utilities, release fixtures, and homepage screenshot references.
- Replace fake real-artist data with canonical Spotify-derived title, artists, credits, artwork, duration, and identifiers where possible.
- Preserve demo usefulness by allowing fake statuses/dates/stages only in explicit demo fields.
- Ensure collaborator credits are correct.
- Remove “Don’t Look Down” or mark it as test-only in non-public test fixtures.
- Vary screenshot UI state such as audio player timestamp across screenshots.

Required tests/guards:
- Fixture/contract test: any release with Spotify ID must use canonical title/artists/artwork.
- Public screenshot seed test fails on known placeholder/test song names.
- Public screenshot seed test fails when real artist releases are missing collaborator credits.
- Screenshot generation test fails if repeated screenshots use identical visible audio player timestamp without intentional reason.
- G-Brain entry documents canonical demo data policy: fake status/date okay; fake canonical music metadata not okay.

8. Artist profile cards/readability.
Observed:
- Artist profiles built to convert looks great.
- Cards may be too tall on normal Retina MacBook Pro.
- Need readability across breakpoints.

Required fixes:
- Audit artist profile section card heights, viewport behavior, content readability.
- Tune height/spacing/responsive behavior.

Required tests/guards:
- Visual regression at 390, 768, 1024, 1280, 1440, 1512/1728, 2560.
- Assertion: no clipped content, no unusable CTAs, no excessive viewport domination on laptop.

9. Pricing is misaligned with actual intended product behavior.
Observed:
- Pricing does not align with real pricing.
- Free is available now.
- Pro should be sign-up-able.
- Remove “Request access” buttons.
- Let users sign up and enter waitlist/chat onboarding flow.
- Store intended plan.
- Gate plans internally for now.
- Waitlist everyone not manually signed on, but do not publicly show “waitlist.”
- Avoid writing “waitlist” publicly. If needed, use “coming soon,” but preferred framing is that plans exist and signup works.
- Pricing copy/plans need rewrite.

Required fixes:
- Audit plan source of truth, marketing pricing, onboarding, billing/Stripe, waitlist/gating, plan param handling, and signup funnel.
- Create or enforce one source of truth for plans.
- Make pricing cards route to signup with intended plan preserved.
- Store intended plan through auth/onboarding.
- Gate internally without public waitlist language.
- Remove request-access CTAs unless required for enterprise only and approved by existing product direction.

Required tests/guards:
- Contract test: marketing pricing cards match plan source of truth.
- E2E: Free CTA → signup with plan preserved → onboarding/gated flow stores intended plan.
- E2E: Pro CTA → signup with plan preserved → onboarding/gated flow stores intended plan.
- Public copy guard: no “waitlist” on public pricing unless allowlisted.
- Regression test: “Request access” does not appear on Free/Pro if product direction says direct signup.
- Billing/signup funnel tests updated accordingly.

10. Focus rings / focus-visible issues across app.
Observed:
- Square focus ring situation happens all over the app.
- Likely focus-visible/design-system issue.

Required fixes:
- Audit design-system focus styles, Tailwind utilities, shared Button/Input/Textarea/Dialog components, auth modal, chat input, homepage CTAs, cookie banner.
- Replace raw/ad hoc focus styles with approved focus-visible utilities.
- Mouse click should not create ugly keyboard focus ring.
- Keyboard navigation must remain accessible and visible.

Required tests/guards:
- Static guard/lint: raw focus/ring/outline classes on interactive elements require approved utility/component.
- E2E keyboard tab tests for homepage, auth, modal, cookie banner, onboarding, chat, dashboard.
- Visual regression for focused controls.
- Axe coverage remains green.

11. Homepage/footer polish.
Observed:
- Footer needs more generous padding.
- Homepage ultrawide looked okay in manual check.
- Need systematic breakpoint assurance.

Required fixes:
- Improve footer spacing.
- Confirm all homepage sections hold up across major viewports, including ultrawide.

Required tests/guards:
- Visual regression/page screenshots at:
  - 375
  - 390
  - 768
  - 1024
  - 1280
  - 1440
  - 1512/1728 MacBook-ish
  - 2560 ultrawide
- Assertions: no horizontal scroll, no clipped CTAs, no broken image quality, no overlapping sections.

Testing/coverage audit requirements:

Investigate why existing tests did not catch these issues. Specifically inspect:
- Whether relevant tests are skipped in E2E_FAST_ITERATION or CI.
- Whether tests assert “page loaded” but not correct content/mode/copy.
- Whether tests use auth bypass/mocks that hide Clerk/provider/proxy problems.
- Whether tests codify bad copy, as homepage.spec appears to do for “Answers for every launch objection.”
- Whether chat tests use deterministic commands that bypass first-message natural-language/rate-limit behavior.
- Whether public exhaustive QA has declared interactions for all relevant CTAs/modals/buttons.
- Whether visual regression snapshots include the affected breakpoints/states.
- Whether a11y/focus-visible tests actually inspect visual focus style and keyboard behavior.
- Whether test selectors are stable and comprehensive enough.

Add or update tests in the existing framework. Prefer augmenting current specs over creating duplicate disconnected specs.

Minimum new/updated test coverage:
A. Homepage CTA crawler:
   - every signup/signin CTA on homepage/header/mobile drawer/pricing/final CTA routes correctly
   - no broken modal/page transitions
   - plan/redirect params preserved
B. Auth correctness:
   - signup page copy and mode
   - signin page copy and mode
   - signup ↔ signin links
   - modal behavior if modal remains
   - provider config guard including Apple
C. Chat P0:
   - first plain “hello” sends successfully
   - no first-message rate-limit
   - slash menu layout shift below threshold
   - Taylor Swift chip stable
   - T key does not toggle theme while typing
D. Cookie banner:
   - accept all clickable/persists/enables expected categories
   - save preferences clickable/persists
   - keyboard accessible
E. Public copy:
   - ban internal terms on public pages
   - no “objection” public heading
   - no public “waitlist” unless allowlisted
F. Seed/screenshot fixtures:
   - real Spotify metadata correctness
   - no fake song names for real artists
   - collaborator credits present
   - screenshot state variation
G. Focus-visible:
   - keyboard tab path
   - approved focus style
   - no ugly square rings from mouse focus
H. Visual/breakpoints:
   - homepage/logo/artist profiles/auth modal/chat/cookie/pricing at required viewport matrix

Suggested validation sequence to discover and adapt to repo:
- pnpm install or repo bootstrap as documented
- pnpm run typecheck / web typecheck
- pnpm run lint / web lint
- relevant unit tests
- relevant Playwright targeted specs
- public surface QA
- a11y axe
- visual regression where affected
- golden-path app/auth/signup/chat
- smoke lanes
- G-STACK full validation required by repo
Use exact repo commands after inspection. Do not invent command names if actual G-STACK defines them differently.

Expected shipping order:

Batch 1 — P0 safety unblock:
- Remove/replace public “objection” copy or flag section off.
- Fix signup/signin CTA routing and copy.
- Fix/guard Apple provider rendering.
- Fix Clerk proxy/auth breakage if reproducible.
- Fix chat first-send/rate-limit.
- Remove `T` production shortcut.
- Fix cookie banner clickability.
- Add P0 regression tests.
- Run targeted G-STACK validation.
- Update G-Brain.

Batch 2 — P1 product surface correctness:
- Logo bar real assets/remove placeholders.
- Pricing source-of-truth and CTA behavior.
- Seed/screenshot canonical metadata.
- Focus-visible design-system hardening.
- Homepage section order.
- Add contract/static/visual tests.
- Run relevant G-STACK validation.
- Update G-Brain.

Batch 3 — P2 polish and broad hardening:
- Artist profile card sizing/readability.
- Footer spacing.
- Spec wall animation/content polish if retained.
- Broader breakpoint/visual QA.
- Full public-surface QA and launch-gate validation.
- Update G-Brain.

Final deliverables:
1. Summary of what was fixed.
2. Root-cause analysis for why existing tests missed each issue.
3. List of tests added/updated with file paths.
4. List of guardrails added/updated with file paths.
5. G-Brain entries created/updated.
6. ROOTFLOW agents used and what each delivered.
7. G-STACK validation commands run and pass/fail results.
8. Remaining risks, only if truly unresolved.
9. PR/commit list in shipped order.

Quality bar:
A fresh user must be able to:
- visit homepage
- see only real/logically approved logo assets and customer-facing copy
- click any signup CTA
- land on correct signup page or a hardened signup modal
- switch between signup and signin
- see only valid configured auth providers
- authenticate or enter the intended auth/onboarding test lane
- preserve selected plan/handle/redirect intent
- enter onboarding/gated flow without public waitlist jank
- open chat
- type and send the first plain message
- use slash commands without layout shift
- mention Taylor Swift and keep a stable chip/input
- use cookie consent buttons
- keyboard-navigate with correct focus-visible styling
- pass the same core flow on mobile, laptop, desktop, and ultrawide

Do not stop at fixing visible symptoms. Harden the system so these classes of bugs are caught by CI/G-STACK/public QA/golden path before production.
```


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
