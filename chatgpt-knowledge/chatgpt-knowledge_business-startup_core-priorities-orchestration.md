---
title: "Core Priorities Orchestration"
type: essay
created: 2026-04-21
updated: 2026-04-21
source: chatgpt-export
topic: business-startup
message_count: 17
tags: [chatgpt, knowledge, business-startup]
---
**Topic:** [[chatgpt-knowledge/_topics/business-startup]]

# Core Priorities Orchestration

> **Source:** ChatGPT conversation
> **Date:** 2026-04-21T21:35:01Z
> **Messages:** 17
> **Topic:** business-startup

## Question

You have context in the ops repo, the KPIs on the RR. You have context on OpenPRs. There's a bunch of stability work in progress and then more working on Playback Dentalists like 3 and a half weeks runway.

Can you look at Open linear issues and all repo context and kind of orchestrate what core priorities should be and what's missing from Open issues and what needs to be tackled

## Answer

I’ll pull the repo, PR, and Linear context first, then turn it into a priority sequence for the remaining runway, call out execution risks, and identify concrete missing tickets.

## Answer

I can use the public GitHub/Linear mirror and repo docs as the source of truth here: 241 open issues, 15 open PRs, plus a preview-first release flow with CI, migration, smoke, and gated production checks. Current evidence makes stability the gating priority, with Sentry errors rising week over week and clustering around cron/release-notification queries, Clerk auth middleware misuse, Stripe webhook price handling, and E2E smoke failures.

## Answer

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

The biggest gap is issue quality. Several GitHub-mirrored Linear issues have **no description, no assignee, no labels, no projec

*(Answer truncated — 7180 chars total)*

## Question

playwright demos not Playback Dentalists
go open linea issues not and set them. then re-prirotize other issues

## Answer

The public mirror shows a pattern worth fixing first: the top Linear-created issues in GitHub have no descriptions, labels, assignees, milestones, or linked branches, including auth, admin, schema, Stripe, and React runtime errors.

## Answer

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
Fix failed-query clusters across creator profiles, distribution events, profile photos, metadata submission, audience blocks, user linking, and release queries. The visible issue list shows repeated open failed-query issues across creator/pr

*(Answer truncated — 12445 chars total)*

## Question

Can you handle that for me? You should have access.

## Answer

I’ll try to make the Linear updates directly using whatever write-capable connector is available here. If write access still isn’t exposed, I’ll report the exact blocker and hand you the precise update payloads.

## Question

linear mcp

## Answer

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

5.

*(Answer truncated — 6190 chars total)*

## Question

{'asset_pointer': 'sediment://file_000000006ba071f8ba6ee82012abe3c8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1078, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 260368, 'width': 1538}
yes you do

## Answer

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
- Defer `#7

*(Answer truncated — 3238 chars total)*

## Question

Update everything.

## Answer

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

## Question

try niow

## Answer

Mr. White — I tried again. The Linear MCP callable namespace still is not exposed in this turn, so I cannot mutate Linear from here.

Current confirmed changes:
- Created `launch-blocker` label.
- No bulk issue updates were applied.

To finish this, start a fresh chat/message with **Linear MCP Server** selected before sending the prompt. Then send:

```text
Update everything from the Linear triage plan: create missing issues, attach them to Launch: YC S26, reprioritize open issues, mark duplicates, add labels, and move non-release work out of the current cycle.
```

Once the Linear MCP call surface is actually available, I can execute it directly.
