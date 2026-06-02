---
title: "Core Priorities Orchestration"
type: essay
created: 2026-04-21
updated: 2026-04-22
source: chatgpt-export
conversation_id: 69e7ed84-7064-83e8-a302-94d88a9c6d5c
message_count: 17
tags: [chatgpt, import, code, long-form]
---
# Core Priorities Orchestration

> Conversation ID: 69e7ed84-7064-83e8-a302-94d88a9c6d5c
> Created: 2026-04-21T21:35:01Z
> Updated: 2026-04-22T01:50:34Z
> Messages: 17

---

## User

You have context in the ops repo, the KPIs on the RR. You have context on OpenPRs. There's a bunch of stability work in progress and then more working on Playback Dentalists like 3 and a half weeks runway.

Can you look at Open linear issues and all repo context and kind of orchestrate what core priorities should be and what's missing from Open issues and what needs to be tackled

---

## Assistant

I’ll pull the repo, PR, and Linear context first, then turn it into a priority sequence for the remaining runway, call out execution risks, and identify concrete missing tickets.

---

## Assistant

I can use the public GitHub/Linear mirror and repo docs as the source of truth here: 241 open issues, 15 open PRs, plus a preview-first release flow with CI, migration, smoke, and gated production checks. Current evidence makes stability the gating priority, with Sentry errors rising week over week and clustering around cron/release-notification queries, Clerk auth middleware misuse, Stripe webhook price handling, and E2E smoke failures.

---

## Assistant

Mr. White — I can see the public GitHub/Linear mirror, not the private Linear board directly. Based on that visible repo context, the current shape is: **241 open issues, 15 open PRs**, with recent work clustered around auth, billing, schema drift, CI/readiness, product-funnel instrumentation, and launch gates. citeturn996616view0turn996616view1

## Core priority order

**1. Stabilize production/revenue/auth before feature expansion.**  
The top open issues are runtime errors in Clerk/auth middleware, admin auth, schema/query failures, unknown Stripe price IDs, CSP/tracking, Stripe Connect readiness, fan-data retries, release queries, and hook-order runtime errors. These map directly to signup, admin visibility, checkout/billing, creator profile reliability, and post-payment flows. citeturn996616view1turn347052view2

**2. Clean the PR queue into a release train.**  
Merge or close in this order:  
`#7460` profile write guard → `#7461` repo-health/static/billing alert hardening after small review cleanup → `#7450` CI/Lighthouse/Sonar blocker fix → close or stack `#7459` if it duplicates `#7450` → defer most Dependabot updates except safe patch/security updates → then land `#7414` launch readiness gates after remote staging/prod evidence. `#7460` looks safe and narrow; `#7461` is also close, with only small regex/JSDoc/test-policy follow-up concerns. citeturn793471view0turn786591view0turn793471view2turn793471view1

**3. Treat `#7414` as the main launch-readiness PR.**  
It adds operational controls for signup, checkout, Stripe webhooks, cron fanout, staging auth/billing gates, Sentry cron monitoring, and readiness docs. Its own note says live staging/production journey execution still depends on GitHub Actions secrets and deployed environments, so it should be merged only after real remote runs are verified. citeturn130889view0

**4. Split or constrain `#7415` product-funnel alerts.**  
It is valuable for RR/KPI visibility, but it is very large: DB schema, cron, admin UI, signup/pricing/claim/onboarding instrumentation, Stripe/Clerk hooks, synthetic monitor, and many tests. CodeRabbit marked it as critical review effort and posted many actionable comments around durable rate limiting, bounded Clerk/Slack calls, Slack failure isolation, JSON narrowing, PII removal, route constants, and duplicate funnel visits. This should become a small “minimum funnel visibility” landing path, or it risks consuming the runway. citeturn409183view0

**5. Defer process-heavy work unless it directly unblocks stability.**  
`#7413` coverage policy is useful, but it is CI/process plumbing, not product or revenue. It also has follow-ups to make coverage blocking later. Keep it out of the critical path unless the team is already blocked by regression-test discipline. citeturn130889view1

## What is missing from open issues

The biggest gap is issue quality. Several GitHub-mirrored Linear issues have **no description, no assignee, no labels, no project, no milestone, and no linked branch/PR**, even for active production-looking errors like Clerk middleware and admin auth. That prevents orchestration. citeturn810146view0turn810146view1

Create these Linear issues now:

**P0 — Linear/Sentry issue hygiene contract**  
Acceptance criteria: every auto-created Sentry/Linear issue includes severity, affected users/events, first/last seen, route, stack trace link, environment, suspected owner, source system, linked PR, and explicit close condition.

**P0 — Resolve auth/middleware regression cluster**  
Covers Clerk `auth()` middleware detection, unauthorized admin access without user ID, and billing/settings manifest/auth edge cases. Acceptance criteria: synthetic auth smoke passes on staging and production, admin routes produce expected 401/403 behavior, and no new Clerk middleware Sentry events for 24h. citeturn996616view1turn347052view3

**P0 — Stripe price/env parity and duplicate unknown-price cleanup**  
`#7340` and `#7339` are duplicate unknown-price events, and older billing env-var issues remain open. `#7461` improves alert context, but the root issue still needs a Stripe price mapping/config parity fix plus dedupe/closure of duplicates. citeturn996616view1turn347052view2turn786591view0

**P0 — Database schema drift and migration parity gate**  
There are open failed-query issues around `creator_profiles` and `discog_releases`, and `#7415` explicitly notes shared dev DB migration-history drift where product funnel tables are missing. Acceptance criteria: staging/prod/dev schema parity check, migration journal verification, and a pre-merge gate that fails when Drizzle schema references columns not present in target DB. citeturn996616view1turn409183view0

**P0 — Public tracking/funnel endpoint hardening before merge**  
For `#7415`, create a focused issue to resolve durable IP rate limiting, bounded retries/timeouts for Clerk and Slack, Slack notification failure isolation, and PII removal from funnel metadata before anything goes live. citeturn409183view0

**P1 — Release train cleanup / PR dependency graph**  
Acceptance criteria: each open PR is classified as merge, stack, split, or close; every PR has a linked Linear issue; duplicate CI-fix branches are reconciled; Dependabot is batched after stability.

**P1 — Remote launch-gate evidence runbook**  
Acceptance criteria: staging signup, claim, onboarding, checkout, webhook, entitlement, dashboard, and production smoke evidence are attached to the launch-readiness issue before `#7414` merges. citeturn130889view0

**P1 — Playback Dentalists epic definition**  
I do not see a visible public repo artifact by that exact name. Create one Linear epic with: target customer, must-ship scope, non-goals, demo path, KPI target, and dependencies on stability/readiness work. With 3.5 weeks of runway, any workstream without an explicit revenue/activation KPI should be cut.

**P1 — Agent/tooling docs consistency**  
`AGENTS.md` says Node 22.x and `package.json` enforces `>=22.13.0 <23`, while `CODEX.md` says Node 24.x and even references a different Doppler project name pattern. This will keep creating agent failures and wrong setup attempts. citeturn290560view0turn913965view0turn290560view1

## Operating plan for the next 3.5 weeks

**Today / tomorrow:** merge the narrow safe fixes, close duplicate CI branches, assign the top P0 runtime issues, and create the missing Linear hygiene/stability issues above.

**This week:** land `#7414` after real staging/prod evidence, fix auth + billing + schema drift, and ship only the minimum funnel telemetry needed to see signup → checkout → paid → activation.

**Next two weeks:** focus on the core revenue path: public profile/claim → signup → onboarding → checkout → webhook entitlement → dashboard. Defer ISRC, lyrics, SMS, design-system refactors, extension future tiers, and most dependency churn unless they unblock launch or revenue.

The founder priority is simple: **turn the open PR/issue pile into a release train that protects signup, checkout, billing, profile reliability, and KPI visibility.** Everything else is backlog until those are green.

---

## User

playwright demos not Playback Dentalists
go open linea issues not and set them. then re-prirotize other issues

---

## Assistant

The public mirror shows a pattern worth fixing first: the top Linear-created issues in GitHub have no descriptions, labels, assignees, milestones, or linked branches, including auth, admin, schema, Stripe, and React runtime errors.

---

## Assistant

Mr. White — correction applied: **Playwright demos**, not Playback Dentalists.

I could inspect the public GitHub/Linear mirror and repo context, but I do **not** have Linear write access exposed in this chat, so I did not mutate Linear directly. Current visible state: **241 open issues and 15 open PRs**. The Linear-mirrored issues are mostly unusable for orchestration because several high-priority runtime issues have no description, assignee, labels, project, milestone, linked branch, or relationships. citeturn419588view0turn419588view1turn622303view0turn622303view1

## Set these new Linear issues

### P0 — Launch/RR release train: stabilize revenue path
**Project:** Launch / RR  
**Cycle:** Apr 21–May 15, 2026  
**Priority:** Urgent  
**Owner:** Eng lead / whoever is shipping today  
**Links:** `#7414`, `#7460`, `#7461`, `#7450`, `#7447`, `#7423`, `#7358`, `#7340`, `#7339`, `#7118`, `#7117`, `#7115`, `#7112`

**Description:**  
Own the release train for the only path that matters during runway: public profile/claim → signup → onboarding → checkout/payment → webhook entitlement → dashboard.

**Acceptance criteria:**
- Auth, profile, checkout, billing, webhook, and dashboard smoke paths pass on staging.
- Top runtime issue clusters are assigned to canonical issues.
- Duplicate Sentry/Linear issues are linked and closed as duplicates.
- Every open release PR is marked merge / split / close / defer.
- RR KPIs have at least daily visibility: visit, claim start, signup complete, onboarding complete, checkout start, payment success, activation.

### P0 — Auth/Clerk middleware regression cluster
**Priority:** Urgent  
**Labels:** `area:auth`, `stability`, `sentry`, `launch-blocker`  
**Canonical issue:** `#7447`  
**Duplicate/related:** `#7180`, `#6947`, `#6919`, `#6916`, `#6846`, `#6789`, `#6640`, `#7423`, `#6920`

**Description:**  
Consolidate recurring Clerk middleware/auth-context failures and admin auth failures. The visible mirror shows repeated `auth() was called but Clerk can't detect usage of clerkMiddleware()` issues and admin middleware unauthorized-access errors. citeturn636540view0turn419588view0

**Acceptance criteria:**
- Canonical root cause identified.
- Duplicates linked and closed.
- Admin auth behavior is explicit: unauthenticated = 401, unauthorized = 403.
- No new Clerk middleware Sentry issues for 24 hours after deploy.
- Playwright deployed-auth smoke passes on staging.

### P0 — DB schema drift / failed-query cleanup
**Priority:** Urgent  
**Labels:** `schema:drizzle`, `database`, `stability`, `launch-blocker`  
**Canonical issue:** `#7358`  
**Related:** `#7218`, `#7217`, `#7163`, `#7160`, `#7141`, `#7065`, `#6954`, `#6953`, `#6930`, `#7240`, `#7118`, `#7117`

**Description:**  
Fix failed-query clusters across creator profiles, distribution events, profile photos, metadata submission, audience blocks, user linking, and release queries. The visible issue list shows repeated open failed-query issues across creator/profile/data paths. citeturn906996view1turn406126view0turn406126view1

**Acceptance criteria:**
- Staging/prod schema parity verified.
- Drizzle migration journal matches deployed DB.
- Failed-query Sentry issues are grouped by root missing column/table/index.
- CI blocks schema references that lack migrations.
- Canonical issue links all duplicate query failures.

### P0 — Stripe billing/price/env parity
**Priority:** Urgent  
**Labels:** `billing`, `stripe`, `revenue`, `launch-blocker`  
**Canonical issue:** `#7340`  
**Duplicate:** `#7339`  
**Related:** `#6945`, `#6503`, `#5822`

**Description:**  
Fix unknown Stripe price ID, billing/settings route readiness, and price/env parity across staging and production. `#7340` and `#7339` are duplicate unknown-price issues with no descriptions or labels, which should be consolidated. citeturn153101view0turn153101view1turn636540view1

**Acceptance criteria:**
- Stripe price IDs are validated at boot/deploy.
- Staging and production price/env maps are documented.
- Unknown price emits actionable alert context.
- Duplicate issue closed after canonical issue is updated.
- Checkout smoke passes on staging.

### P0 — Sentry → Linear hygiene and dedupe
**Priority:** Urgent  
**Labels:** `ops`, `sentry`, `linear`, `triage`  

**Description:**  
Auto-created Linear issues are arriving with no description, no labels, no owner, no project, no branch/PR, and no close condition. That makes the board look busy while hiding the actual release blockers. citeturn622303view0turn622303view1turn622303view2

**Acceptance criteria:**
- Every Sentry-created Linear issue includes route, environment, severity, first/last seen, event count, stack link, suspected owner, and close condition.
- Duplicate grouping rules exist for Clerk, Stripe price, upload 405, failed query, hook-order, and Playwright failures.
- New Sentry issues default to triage with required fields.
- Duplicates are closed weekly.

### P1 — Playwright demos: founder/customer golden paths
**Priority:** High  
**Labels:** `playwright`, `demo`, `testing`, `rr`, `launch`  
**Related existing issue:** `#6342`

There is already one open Playwright issue: public profile smoke test for `jov.ie/timwhite`, including load, 200 status, <3s load, artist name, DSP links, tip/contact/listen buttons, screenshot artifact, and CI wiring. That issue has no project, milestone, relationship, or linked PR, so it should be pulled into the current release train. citeturn763120view0turn906996view0

**Description:**  
Create Playwright demo scripts that can be run locally and in CI against staging to prove the customer-facing story.

**Demo scripts:**
1. Public profile demo: `/timwhite` loads, artist identity visible, DSP/tip/contact/listen surfaces visible, screenshot/video artifact saved.
2. Claim/signup demo: claim CTA → signup → onboarding → dashboard.
3. Billing demo: pricing → checkout start → Stripe test/staging flow → entitlement/dashboard visible.
4. Operational controls demo: signup/checkout disabled state shows clean unavailable path.
5. Admin/RR KPI demo: founder view shows funnel counts and recent failure states.

**Acceptance criteria:**
- Tests live under `tests/e2e/demo/`.
- Each demo saves screenshot/video artifacts.
- Demos can run with `BASE_URL=https://staging.jov.ie`.
- Demo suite is deterministic with seeded test users.
- CI exposes artifacts for investor/customer/internal review.

### P1 — Remote evidence runbook for launch gates
**Priority:** High  
**Labels:** `launch`, `playwright`, `ci`, `staging`, `readiness`  
**Related PR:** `#7414`

`#7414` adds runtime controls for signup, checkout, Stripe webhooks, cron fanout, staging auth/billing Playwright gates, Sentry cron monitoring, and launch-readiness docs. Its own note says local validation does not prove the live staging/production remote runs because those depend on GitHub Actions secrets and deployed environments. citeturn122452view0

**Acceptance criteria:**
- Staging auth smoke evidence attached.
- Staging billing smoke evidence attached.
- Synthetic golden path evidence attached.
- Production smoke evidence attached.
- Required secrets verified in Actions.
- `#7414` merges only after remote evidence is attached.

### P1 — Minimum RR KPI visibility
**Priority:** High  
**Labels:** `analytics`, `rr`, `funnel`, `admin`, `revenue`  
**Related PR:** `#7415`

`#7415` instruments the product funnel from visit through retained day 7, adds admin funnel queries/UI, Slack alert evaluation, backend synthetic signup monitor, claim tracking, and anonymous beacons. It is also large: CodeRabbit estimated critical review effort, and later review surfaced many actionable comments. citeturn443476view4turn443476view1turn443476view2

**Description:**  
Ship the minimum funnel visibility needed for RR decisions without taking on the full `#7415` blast radius.

**Acceptance criteria:**
- Daily visibility for visit → claim/signup → onboarding → checkout → paid → activation.
- Admin or report view is usable by founder.
- No PII stored in anonymous tracking metadata.
- Public tracking endpoint has durable rate limiting.
- Slack failures cannot fail cron/request paths.
- Full retained-day-7 analytics can remain follow-up.

### P1 — Stripe Connect readiness cache
**Priority:** High  
**Labels:** `stripe-connect`, `checkout`, `performance`, `revenue`  
**Existing issue:** `#7251`

`#7251` already has a good issue body. It proposes replacing live `stripe.accounts.retrieve()` polling on every tip checkout with cached DB fields maintained by `account.updated` webhook events. This removes Stripe API latency from the payment-critical path. citeturn595764view0

**Set:** keep open, assign owner, attach to release train, due after checkout stability.

### P1 — Durable post-tip fan-data retry
**Priority:** High  
**Labels:** `tipping`, `webhook`, `reliability`, `revenue`  
**Existing issue:** `#7250`

`#7250` already documents the at-most-once failure mode: if `processTipCompleted()` fails transiently, audience upsert and thank-you email can be permanently dropped after payment success. citeturn595764view1

**Set:** keep open, assign owner, attach to release train, due after Stripe price/env parity.

## Re-prioritize existing issues

### P0 now
Set these as **Urgent / current cycle / launch-blocker**:

- `#7447`, `#7180`, `#6947`, `#6919`, `#6916`, `#6846`, `#6789`, `#6640` — Clerk middleware/auth cluster.
- `#7423`, `#6920` — admin auth cluster.
- `#7358`, `#7218`, `#7217`, `#7163`, `#7160`, `#7141`, `#7065`, `#6954`, `#6953`, `#6930`, `#7240` — DB/schema failed-query cluster.
- `#7340` — canonical Stripe unknown price ID.
- `#7339` — mark duplicate of `#7340`.
- `#7118`, `#7117` — user linking/database operation failures.
- `#7115`, `#7112`, `#6945` — Next.js manifest failures on public/music/billing routes.
- `#7116` — subscription/billing UI smoke failure if it blocks checkout demo.

### P1 this week
Set these as **High / current cycle**:

- `#6342` — public profile Playwright smoke. Attach to new Playwright demos issue.
- `#7251` — Stripe Connect readiness cache.
- `#7250` — durable post-tip fan-data retry.
- `#6921` — tipping stats timeout.
- `#7104`, `#7106`, `#7108`, `#7109`, `#6663` — upload 405 cluster.
- `#7100` — static-to-dynamic runtime regression.
- `#7221`, `#6879` — hook-order runtime errors.
- `#6680`, `#6681`, `#6636` — Playwright/E2E failure cluster.

### P2 after release train is green
Set these as **Medium / next cycle**:

- `#7415` — split into “minimum RR KPI visibility” and “full funnel analytics.”
- `#7413` — PR coverage policy.
- `#6531` — duplicate React key warnings.
- `#6532` — Biome warning suppression.
- `#6530` — Clerk UI/deprecation cleanup.
- `#6502` — duplicate tip webhook handlers.
- `#5822` — billing/payments normalization.

### P3 / backlog
Set these as **Low / backlog**:

- `#6725` — empty-state redesign.
- `#6876`, `#6875`, `#6874` — outreach/Instantly config.
- `#7243`, `#7244` — duplicate artistId cron/release notification errors unless they are high-volume in Sentry.
- Dependabot PRs unless security-patch or blocking CI.

## PR release order

1. **Merge first:** `#7460` profile write guard.
2. **Then:** `#7461` repo-health/static/billing checks.
3. **Then:** `#7450` CI/Lighthouse/Sonar blocker fix.
4. **Close or stack:** `#7459` if it duplicates `#7450`.
5. **Then:** `#7414` after remote staging/prod evidence is attached.
6. **Split:** `#7415`; land only minimum RR KPI visibility.
7. **Defer:** `#7413` coverage policy and most Dependabot updates.

The active PR list shows the immediate queue: `#7461`, `#7460`, `#7459`, `#7450`, Dependabot PRs, `#7415`, `#7414`, and `#7413`. citeturn381571view0

## What is missing

The board needs these missing structures:

1. A real **Launch/RR release train** project tying PRs, issues, demos, and KPIs together.
2. A **Playwright demos** epic separate from ordinary test coverage.
3. A **canonical Sentry dedupe policy** so blank Linear issues stop multiplying.
4. A **remote evidence issue** for `#7414`.
5. A **minimum RR KPI issue** that trims `#7415` to founder-useful metrics.
6. A **schema drift gate** that prevents DB/query failures from reaching prod.

Priority principle for the next 3.5 weeks: **auth, profile, checkout, billing, webhook entitlement, dashboard, RR visibility, and Playwright demos.** Everything else goes to next cycle or backlog.

---

## User

Can you handle that for me? You should have access.

---

## Assistant

I’ll try to make the Linear updates directly using whatever write-capable connector is available here. If write access still isn’t exposed, I’ll report the exact blocker and hand you the precise update payloads.

---

## User

linear mcp

---

## Assistant

Mr. White — I don’t have a callable Linear MCP tool exposed in this session. I can’t create or update Linear issues from here.

Linear’s official MCP can create/update Linear objects when the connector is attached and authenticated, but the available tools in this chat do not include a Linear namespace or MCP call surface. Linear documents the official MCP endpoint as `https://mcp.linear.app/mcp`, with tools for finding, creating, and updating issues/projects/comments. citeturn714862search0

No Linear changes have been made.

Use this prompt in a Linear-MCP-enabled client, or reconnect this chat with the Linear MCP tool exposed:

```text
Use Linear MCP for the Jovie workspace.

Create or update a Launch/RR release train project for Apr 21–May 15, 2026.

Create these Linear issues if they do not already exist, otherwise update matching existing issues:

1. P0 — Launch/RR release train: stabilize revenue path
Priority: Urgent
Labels: launch-blocker, rr, revenue, stability
Description:
Own public profile/claim → signup → onboarding → checkout/payment → webhook entitlement → dashboard.
Acceptance:
- Auth, profile, checkout, billing, webhook, and dashboard smoke paths pass on staging.
- Top runtime clusters assigned to canonical issues.
- Duplicate Sentry/Linear issues linked and closed.
- Every open release PR marked merge / split / close / defer.
- RR KPIs visible daily: visit, claim start, signup complete, onboarding complete, checkout start, payment success, activation.
Link issues/PRs:
#7414 #7460 #7461 #7450 #7447 #7423 #7358 #7340 #7339 #7118 #7117 #7115 #7112

2. P0 — Auth/Clerk middleware regression cluster
Priority: Urgent
Labels: area:auth, stability, sentry, launch-blocker
Canonical GitHub issue: #7447
Related: #7180 #6947 #6919 #6916 #6846 #6789 #6640 #7423 #6920
Acceptance:
- Root cause identified.
- Duplicates linked/closed.
- Admin auth behavior explicit: unauthenticated = 401, unauthorized = 403.
- No new Clerk middleware Sentry issues for 24h after deploy.
- Playwright deployed-auth smoke passes on staging.

3. P0 — DB schema drift / failed-query cleanup
Priority: Urgent
Labels: schema:drizzle, database, stability, launch-blocker
Canonical GitHub issue: #7358
Related: #7218 #7217 #7163 #7160 #7141 #7065 #6954 #6953 #6930 #7240 #7118 #7117
Acceptance:
- Staging/prod schema parity verified.
- Drizzle migration journal matches deployed DB.
- Failed-query Sentry issues grouped by root missing column/table/index.
- CI blocks schema references that lack migrations.
- Canonical issue links all duplicate query failures.

4. P0 — Stripe billing/price/env parity
Priority: Urgent
Labels: billing, stripe, revenue, launch-blocker
Canonical GitHub issue: #7340
Duplicate: #7339
Related: #6945 #6503 #5822
Acceptance:
- Stripe price IDs validated at boot/deploy.
- Staging/prod price/env maps documented.
- Unknown price emits actionable alert context.
- Duplicate issue closed after canonical issue is updated.
- Checkout smoke passes on staging.

5. P0 — Sentry → Linear hygiene and dedupe
Priority: Urgent
Labels: ops, sentry, linear, triage
Acceptance:
- Every Sentry-created Linear issue includes route, environment, severity, first/last seen, event count, stack link, suspected owner, and close condition.
- Duplicate grouping rules exist for Clerk, Stripe price, upload 405, failed query, hook-order, and Playwright failures.
- New Sentry issues default to triage with required fields.
- Duplicates reviewed weekly.

6. P1 — Playwright demos: founder/customer golden paths
Priority: High
Labels: playwright, demo, testing, rr, launch
Related GitHub issue: #6342
Acceptance:
- tests/e2e/demo/ contains public profile, claim/signup, billing, operational-controls, and admin/RR KPI demos.
- Each demo saves screenshots/videos.
- Demos run with BASE_URL=https://staging.jov.ie.
- Tests use deterministic seeded users.
- CI exposes artifacts for review.

7. P1 — Remote evidence runbook for launch gates
Priority: High
Labels: launch, playwright, ci, staging, readiness
Related PR: #7414
Acceptance:
- Staging auth smoke evidence attached.
- Staging billing smoke evidence attached.
- Synthetic golden path evidence attached.
- Production smoke evidence attached.
- Required GitHub Actions secrets verified.
- #7414 merges only after remote evidence is attached.

8. P1 — Minimum RR KPI visibility
Priority: High
Labels: analytics, rr, funnel, admin, revenue
Related PR: #7415
Acceptance:
- Daily visibility for visit → claim/signup → onboarding → checkout → paid → activation.
- Founder/admin report view usable.
- No PII stored in anonymous tracking metadata.
- Public tracking endpoint has durable rate limiting.
- Slack failures cannot fail cron/request paths.
- Retained-day-7 analytics moved to follow-up if needed.

9. P1 — Stripe Connect readiness cache
Priority: High
Labels: stripe-connect, checkout, performance, revenue
Existing GitHub issue: #7251
Set owner and attach to release train.

10. P1 — Durable post-tip fan-data retry
Priority: High
Labels: tipping, webhook, reliability, revenue
Existing GitHub issue: #7250
Set owner and attach to release train.

Reprioritize existing issues:

Urgent / P0 / current cycle / launch-blocker:
#7447 #7180 #6947 #6919 #6916 #6846 #6789 #6640
#7423 #6920
#7358 #7218 #7217 #7163 #7160 #7141 #7065 #6954 #6953 #6930 #7240
#7340
#7118 #7117
#7115 #7112 #6945
#7116 if blocking checkout demo

Mark #7339 duplicate of #7340.

High / P1 / current cycle:
#6342
#7251
#7250
#6921
#7104 #7106 #7108 #7109 #6663
#7100
#7221 #6879
#6680 #6681 #6636

Medium / P2 / next cycle:
#7415, split into minimum RR KPI visibility and full funnel analytics.
#7413
#6531
#6532
#6530
#6502
#5822

Low / P3 / backlog:
#6725
#6876 #6875 #6874
#7243 #7244 unless high-volume in Sentry.
Dependabot PRs unless security-patch or blocking CI.

Open PR release order:
1. Merge #7460.
2. Merge #7461.
3. Merge #7450.
4. Close or stack #7459 if duplicate of #7450.
5. Merge #7414 only after remote evidence.
6. Split #7415 and land only minimum RR KPI visibility.
7. Defer #7413 and most Dependabot updates.
```

To make this executable here, the Linear MCP connector needs to appear as an available tool in the chat.

---

## User

{'asset_pointer': 'sediment://file_000000006ba071f8ba6ee82012abe3c8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1078, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 260368, 'width': 1538}
yes you do

---

## Assistant

Mr. White — I checked the live Linear board through MCP.

Two facts matter immediately:
- You already have the right release container: **`Launch: YC S26`**.
- Current cycle **#9** has **98 issues**. It is overloaded. The board is noisy because repeated Sentry issues are landing as **High + In Progress** with no useful grouping.

I created the **`launch-blocker`** label. I have **not** bulk-updated the rest of the issue states in this run.

## Set the board like this

### P0 — keep in current cycle, attach to `Launch: YC S26`
Use: `launch-blocker`, `severity:P0-blocker`

- **`JOV-1773`** — Clerk auth/middleware canonical  
  Fold under it: `JOV-1756`, `JOV-1723`, `JOV-1716`, `JOV-1714`, `JOV-1706`, `JOV-1698`  
  Related: `JOV-1734`, `JOV-1722`, `JOV-1671`

- **`JOV-1772`** — admin auth canonical  
  Related: `JOV-1717`, `JOV-1704`

- **`JOV-1771`** — DB schema/query drift canonical  
  Fold under it: `JOV-1763`, `1760`, `1759`, `1758`, `1755`, `1754`, `1752`, `1747`, `1746`, `1731`, `1726`, `1725`, `1719`, `1696`, `1432`, `1618`, `1619`

- **`JOV-1770`** — Stripe price/env parity canonical  
  Mark **`JOV-1769`** duplicate  
  Related: `JOV-1064`

- **`JOV-1748`** — signup/user creation failure canonical  
  Related: `JOV-1733`, `JOV-1712`

- Keep these in P0 **only if they still block billing smoke**
  - **`JOV-1721`** — billing route manifest failure
  - **`JOV-1745`** — subscription composer missing in E2E

### P1 — current cycle after P0
- **`JOV-1767`** — Stripe Connect readiness cache
- **`JOV-1766`** — durable retry for post-tip fan pipeline
- **Upload 405 cluster** — keep one canonical, use `JOV-1741`; duplicate `JOV-1742`, `1740`, `1738`
- **Hook-order/runtime cluster** — keep `JOV-1762`; relate `JOV-1713`
- **Next/runtime manifest cluster** — `JOV-1744`, `1743`, `1737`
- **Playwright/E2E failure cluster** — `JOV-1724`, `1720`, `1751`
- **`JOV-1718`** — tipping stats timeout

### P2 — move out of current cycle
- `JOV-1710`, `1709`, `1711` — Instantly/outreach
- `JOV-1768` — Trovo CSP unless it breaks paid flow
- `JOV-1702`, `1411` — circuit-breaker noise unless live funnel is failing
- `JOV-1750`, `1732`, `1735`, `1736`, `1730`, `1707`, `1708`, `1703`, `1701`
- `JOV-1581`, `1684`, `1687`, `1693`

## Missing issues to add
- **Playwright demos: founder/customer golden paths**
- **Launch evidence: staging + production remote smoke for PR #7414**
- **Minimum RR KPI visibility**
- **Sentry → Linear dedupe and field hygiene**
- **Signup/onboarding core path stabilization** if you want a parent over `JOV-1748 / 1733 / 1712`

## Board rules
- Auto-created Sentry issues start in **Triage**
- Only canonical blockers go to **In Progress**
- Use **Duplicate** aggressively
- Keep the cycle to **10–15 active issues**. `98` is far too large

## Repo sync
- Merge `#7460`
- Merge `#7461`
- Merge `#7450`
- Close or stack `#7459` if overlapping
- Merge `#7414` only after remote evidence exists
- Split `#7415`; ship minimum KPI visibility first
- Defer `#7413` and most dependency churn

## Core priority for the next 3.5 weeks
1. auth  
2. signup/user creation  
3. DB/schema parity  
4. billing/price/env parity  
5. checkout + webhook entitlement  
6. RR KPI visibility  
7. Playwright demos

---

## User

Update everything.

---

## Assistant

Mr. White — I can’t complete the bulk Linear mutations from the current callable tool surface.

What already happened:
- Linear MCP was reachable earlier.
- I verified your Linear profile, team, projects, statuses, labels, current cycle, and issue list.
- I created the `launch-blocker` label.
- No other Linear issues were updated after your “Update everything” command.

What needs to happen:
- Re-expose the **Linear MCP Server** tool in the chat for this run, or start a fresh message with **Linear MCP Server** selected.
- Then I can update the board directly: create the missing issues, attach canonical blockers to `Launch: YC S26`, reprioritize existing issues, mark duplicates, add labels, and move lower-priority work out of the current cycle.

The concrete mutation plan is ready. The blocker is tool access in this response, not the Linear account.

---

## User

try niow

---

## Assistant

Mr. White — I tried again. The Linear MCP callable namespace still is not exposed in this turn, so I cannot mutate Linear from here.

Current confirmed changes:
- Created `launch-blocker` label.
- No bulk issue updates were applied.

To finish this, start a fresh chat/message with **Linear MCP Server** selected before sending the prompt. Then send:

```text
Update everything from the Linear triage plan: create missing issues, attach them to Launch: YC S26, reprioritize open issues, mark duplicates, add labels, and move non-release work out of the current cycle.
```

Once the Linear MCP call surface is actually available, I can execute it directly.


## See Also
- [[chatgpt/chatgpt_agent-orchestration-summary]]
- [[chatgpt/chatgpt_ai-orchestration-platform]]
- [[chatgpt/chatgpt_branch-agent-orchestration-summary]]
- [[chatgpt/chatgpt_ci-orchestration-help]]
- [[chatgpt/chatgpt_core-values-compilation-part1]]
