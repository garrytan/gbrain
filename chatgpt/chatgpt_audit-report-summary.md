---
title: "Audit report summary"
type: essay
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a0105b1-3884-83e8-800a-96a8f0924214
message_count: 5
tags: [chatgpt, import, long-form]
---
# Audit report summary

> Conversation ID: 6a0105b1-3884-83e8-800a-96a8f0924214
> Created: 2026-05-10T22:24:50Z
> Updated: 2026-05-10T22:40:40Z
> Messages: 5

---

## Assistant

Mr. White, I’ll run a live-product QA pass within available browser access, mapping reachable Jovie surfaces from the visible app state before prioritizing findings.

---

## Assistant

The tooling lacks live click control, so I’m grounding coverage in the authenticated snapshot, repo route/nav maps, and public fetches while separating observed from inferred findings.

---

## Assistant

Mr. White, I used the uploaded QA brief as the audit scope, but this run was **not a true exhaustive live clickthrough** because this chat did not expose a live browser-control tool for clicking, resizing, typing, screenshots, keyboard traversal, or mobile viewport testing. The report below is a **bounded production audit** based on the captured authenticated `/app/chat` page context, public production pages, GitHub route/config evidence, Linear QA history, and docs/support/legal surfaces. The requested standard was exhaustive live exploration; this result should be treated as **high-signal discovery, medium confidence overall**, with clear blockers called out. fileciteturn0file0

# 1) Executive summary

## Overall assessment

Jovie has strong route architecture work, mature automated QA, and serious backend/stability discipline. The roughest product gaps are **not code hygiene**; they are **trust, IA, canonical destination clarity, and public/customer-facing consistency**.

The product currently feels like three partially merged systems:

1. **Chat-first creator app** at `/app/chat`.
2. **Dashboard/admin route families** under `/app/dashboard/*`, `/app/library`, `/app/admin/*`.
3. **Marketing/support/docs/legal/billing story** that promises more mature SaaS controls than the captured app context proves are discoverable.

The most founder-relevant problem: Jovie looks internally powerful, but a real customer may ask, “Where do I manage my account, billing, outputs, privacy, and generated work?” too often.

## Top 10 issues by business impact

1. **Billing story is contradictory across pricing, terms, support, and app IA** — pricing says waitlist/request access, support says Settings → Billing, terms describe paid subscriptions/cancellation and a 14-day Pro trial. P1. citeturn339988view0turn747838view2turn451704view1  
2. **Public Support FAQ links users to a broken Getting Started URL** — support says `docs.jov.ie/getting-started`; that path returned 404, while the actual docs page is `/docs/getting-started`. P1. citeturn451704view1turn267252view0turn149794view0  
3. **Status link is exposed publicly but returned 404** — pricing/home resources point to `status.jov.ie`; fetch failed with 404. P1/P2. citeturn339988view0turn451704view0  
4. **Canonical route clarity is still messy** — route constants and redirects show many legacy aliases and dashboard/settings/profile migrations; this weakens product confidence and creates stale entry points. P1/P2. fileciteturn6file0 fileciteturn7file0  
5. **Account/profile/settings surfaces are conceptually split** — `/app/chat?panel=profile`, `/app/settings/artist-profile`, dashboard aliases, and “Profile” drawer behavior create unclear ownership. P2. fileciteturn6file0 fileciteturn17file0  
6. **Public API/docs maturity mismatch** — pricing advertises API access, but API docs say the section is under development and detailed endpoints are coming soon. P2. citeturn339988view0turn149794view1  
7. **Homepage appears to serve inconsistent hero/copy variants for the same canonical domain during the same audit session** — one fetch showed “The link your music deserves,” another showed “Release more music with less work.” Needs verification, but it is a trust/SEO risk if real. P2, lower confidence. citeturn747838view0turn358729view1  
8. **Generated-output retrieval is not obvious from the captured app home** — quick actions include album art, playlist pitch, release planning, momentum analysis, and feedback, but the persistent destination for generated assets/work is not clearly explained. P2.  
9. **Public profile route family has known duplication and canonical ambiguity** — internal audit shows separate profile modes, drawer/full-page inconsistencies, duplicate notifications/alerts surfaces, legacy shells, and silent catch-all redirects. P2/P1 depending on route. fileciteturn19file0  
10. **Recent QA has focused heavily on automation, route breadth, and state transitions, but the remaining risk is human-polish breadth** — the completed QA campaign and route QA work are strong, yet this audit still finds cross-surface copy, trust, and IA leaks. fileciteturn12file0 fileciteturn13file0

## Overall confidence level

**Medium.**  
High confidence for public web/docs/legal/support issues and route-map/redirect issues. Medium confidence for authenticated app IA observations from the captured `/app/chat` context. Low confidence for interaction-specific jank, mobile overflow, keyboard/focus issues, modal/back behavior, and actual billing/account settings behavior because live control was unavailable.

# 2) Coverage summary

## Surface families covered

**Captured authenticated context**

- `/app/chat`
- Chat home
- Sidebar/nav labels
- Profile panel/drawer content visible inside chat
- Social/Music/Earn/About tabs visible in profile panel
- Quick actions
- Admin navigation labels
- Mobile/bottom-nav labels present in DOM

**Public production pages fetched**

- `/`
- `/pricing`
- `/support`
- `/signin`
- `/signup`
- `/legal/terms`
- `/legal/privacy`
- `/tim` public profile via `/timwhite` redirect
- `docs.jov.ie`
- docs Getting Started canonical page
- docs API Reference
- docs Self-Serve Guide
- broken docs path `/getting-started`
- broken public status link

**Route/config/internal coverage**

- Central route constants
- Redirect and rewrite map
- Canonical surface inventory
- Shell V1 architecture
- Version source
- Prior stability audit
- Prior route QA and app QA Linear issues
- Public profile hardening audit
- Current triage issue involving `CHAT_JANK_MONITOR`

The app route constants show a broad authenticated surface area: dashboard, releases, tasks, audience, library, insights, lyrics, presence, settings/account/billing/payments/data privacy, many admin routes, marketing, legal, auth, onboarding, and billing callback routes. fileciteturn6file0

## Desktop/mobile coverage performed

- **Desktop:** partial, via captured page context and public web text fetches.
- **Mobile 320–390 px:** not performed.
- **Second mobile width/tablet:** not performed.
- **Zoom/accessibility resizing:** not performed.
- **Keyboard/focus traversal:** not performed.
- **Screenshots:** none available from live app.

## Could not reach or verify

- Interactive dropdown behavior.
- Modal/drawer close behavior.
- Browser back behavior inside drawers/sheets.
- Escape/outside-click behavior.
- Form validation and partial-form abandonment.
- Narrow viewport overflow.
- Sticky input/keyboard collisions.
- Scroll restoration.
- Authenticated settings pages.
- Billing pages up to final confirmation.
- Account deletion/export controls.
- Payment method management.
- Admin internals.
- Release creation flow.
- Tasks detail behavior.
- Library asset retrieval behavior.
- Actual generated-output persistence.

Reason: no live browser-control tool was exposed in this chat.

# 3) Issues by surface

## Issue 1 — Billing story contradicts itself across public surfaces

**Severity:** P1  
**Confidence:** High  
**Surface / exact URL:** `/pricing`, `/support`, `/legal/terms`, likely `/app/settings/billing`

**Repro steps**

1. Open `/pricing`.
2. Read pricing plan language.
3. Open `/support`.
4. Read “How do I upgrade my plan?”
5. Open `/legal/terms`.
6. Read “Payment and Subscriptions.”

**Expected behavior**

Jovie should have one coherent billing story:

- Is billing live or waitlisted?
- Are paid plans self-serve?
- Is there a Pro trial?
- Where exactly do users upgrade/cancel/manage billing?
- Which plans exist?

**Actual behavior**

- Pricing says paid plans open from the waitlist and lists Free, Pro, Team, Enterprise. citeturn339988view0  
- Support says users should go to Settings → Billing to view plans and manage subscriptions. citeturn451704view1  
- Terms say Jovie offers Free, Pro, and Max plans, mentions monthly/annual Stripe billing, says new accounts start with a 14-day Pro trial, and says cancellation is available from account settings. citeturn747838view2  

**Why this matters**

Billing copy is a trust surface. Contradictions here make users wonder whether they can be charged, whether cancellation exists, whether the product is waitlisted, and whether the legal docs are stale.

**Likely escapes automated tests**

Yes. Link tests and route smoke tests can pass while the product story is inconsistent.

**Suggested fix direction**

Create a single billing canonical spec and update pricing, support FAQ, terms, settings billing copy, onboarding plan copy, and account cancellation copy together. Then add a content consistency test for plan names: Free, Pro, Team/Max, Enterprise.

**Screenshot reference**

Unavailable.

---

## Issue 2 — Support FAQ points to a broken docs URL

**Severity:** P1  
**Confidence:** High  
**Surface / exact URL:** `/support`, docs path `https://docs.jov.ie/getting-started`

**Repro steps**

1. Open `/support`.
2. Read FAQ answer: “Full walkthrough at `https://docs.jov.ie/getting-started`.”
3. Open that docs URL.
4. Open canonical docs Getting Started link from docs nav.

**Expected behavior**

The FAQ should send users to the working Getting Started docs page.

**Actual behavior**

The Support FAQ names `docs.jov.ie/getting-started`; that path returned 404. The working page is `/docs/getting-started`. citeturn451704view1turn267252view0turn149794view0

**Why this matters**

This is a direct trust leak on a first-use support path. New users who need help get sent to a dead page.

**Likely escapes automated tests**

Yes, unless external docs URLs are crawled from support content.

**Suggested fix direction**

Update FAQ link to the canonical docs URL. Add a link crawler that checks all public marketing/support/legal/docs cross-links.

**Screenshot reference**

Unavailable.

---

## Issue 3 — Public status link returns 404

**Severity:** P1/P2  
**Confidence:** High  
**Surface / exact URL:** `/pricing`, `/`, `status.jov.ie`

**Repro steps**

1. Open `/pricing`.
2. Find Resources → Status.
3. Open status link.

**Expected behavior**

Status should show a public status page or be removed.

**Actual behavior**

The status link was exposed publicly, and fetch returned 404. citeturn339988view0turn451704view0

**Why this matters**

A broken status page is worse than no status page. It makes reliability look theatrical.

**Likely escapes automated tests**

Yes, if tests only check that the link exists or only crawl same-origin links.

**Suggested fix direction**

Either provision the status page, redirect it to `/support` with incident copy, or remove the status link until it exists.

**Screenshot reference**

Unavailable.

---

## Issue 4 — Route architecture still carries too many competing canonicals

**Severity:** P1/P2  
**Confidence:** High  
**Surface / exact URL:** `/app/*`

**Repro steps**

1. Inspect active app nav context: Releases points to `/app/dashboard/releases`, Library points to `/app/library`, Tasks points to `/app/dashboard/tasks`, Settings appears separately in bottom/menu context.
2. Compare route constants and redirects.
3. Compare rewrites for `/app/releases`, `/app/audience`, `/app/insights`, `/app/presence`.

**Expected behavior**

Each product concept should have one canonical route and one clear redirect story.

**Actual behavior**

Route constants include dashboard routes, legacy dashboard routes, top-level aliases, settings redirects, and profile aliases. `next.config.js` contains a large legacy redirect map plus rewrites from top-level `/app/*` routes to dashboard destinations. fileciteturn6file0 fileciteturn7file0

**Why this matters**

Users do not see route constants, but they feel the consequences: stale bookmarks, inconsistent breadcrumbs, support docs drifting, and CTAs that sound current but land in legacy surfaces.

**Likely escapes automated tests**

Partially. Route sweeps can prove every alias lands somewhere while missing that the IA feels split-brained.

**Suggested fix direction**

For each concept, define one canonical:

- Releases: choose `/app/releases` or `/app/dashboard/releases`.
- Audience: choose `/app/audience` or `/app/dashboard/audience`.
- Profile editing: choose chat panel or settings profile.
- Earnings/pay: choose settings tab or dashboard route.
- Settings: make `/app/settings` a real index or a visibly intentional redirect.

Then expose canonical URLs in nav, docs, support, and app CTAs.

**Screenshot reference**

Unavailable.

---

## Issue 5 — Profile editing ownership is unclear: chat panel vs settings route

**Severity:** P2  
**Confidence:** Medium-high  
**Surface / exact URL:** `/app/chat?panel=profile`, `/app/settings/artist-profile`

**Repro steps**

1. Inspect active `/app/chat` context.
2. Observe Profile drawer/panel content inside chat.
3. Compare route constants: `PROFILE` is deprecated and points to `/app/chat`; `SETTINGS_ARTIST_PROFILE` points to `/app/settings/artist-profile`.
4. Compare prior Linear issue that had to fix “Edit Profile” landing in chat by accident.

**Expected behavior**

“Edit profile” should have a single product owner and destination.

**Actual behavior**

The captured app context shows profile management inside `/app/chat`, with tabs Social, Music, Earn, About. Route constants also define `/app/settings/artist-profile`. The constants mark `PROFILE` as deprecated but still map it to `/app/chat`; an earlier issue explicitly noted “Edit Profile” resolving to `/app/chat` as a misleading destination. fileciteturn6file0 fileciteturn17file0

**Why this matters**

Profile is core to Jovie. Users will naturally ask whether profile editing lives in Chat, Settings, Dashboard, Artist Workspace, or public preview.

**Likely escapes automated tests**

Yes. Every route can work while the mental model remains muddy.

**Suggested fix direction**

Make one route canonical for profile editing. If chat owns it, rename the panel as an assistant workspace and add “Open full profile settings.” If settings owns it, make chat profile edits a shortcut/deep-link into settings.

**Screenshot reference**

Unavailable.

---

## Issue 6 — Settings/account/billing discoverability is too weak for a SaaS product

**Severity:** P1/P2  
**Confidence:** Medium  
**Surface / exact URL:** `/app/chat`, `/app/settings/account`, `/app/settings/billing`, `/app/settings/data-privacy`

**Repro steps**

1. Inspect active authenticated context.
2. Look for first-class account/settings/billing entry.
3. Compare legal/support promises for account settings, billing, cancellation, deletion, export, and OAuth revocation.

**Expected behavior**

A mature SaaS product should expose account, billing, data privacy, connected accounts, export, delete account, and logout predictably.

**Actual behavior**

The captured primary sidebar emphasizes Tasks, Library, Artist Workspace, Profile, Releases, Audience, Admin, and admin utilities. Settings appears in the lower/menu/mobile context, not as an obvious primary account-management surface in the captured desktop nav. Public legal and support pages tell users to manage billing, deletion, exports, and settings from account/settings surfaces. citeturn451704view1turn339988view3

**Why this matters**

Account/billing/privacy are “where do I trust this company?” surfaces. Hiding them behind secondary menus is a mature-SaaS smell.

**Likely escapes automated tests**

Yes. Automated tests check routes; humans judge discoverability.

**Suggested fix direction**

Add a persistent account/settings entry to the authenticated shell. The account menu should visibly include Account, Billing, Data & Privacy, Connected Accounts, Support, Docs, and Sign out.

**Screenshot reference**

Unavailable.

---

## Issue 7 — Public API access is advertised before docs are ready

**Severity:** P2  
**Confidence:** High  
**Surface / exact URL:** `/pricing`, docs API Reference

**Repro steps**

1. Open `/pricing`.
2. Find API access in plan matrix.
3. Open docs API Reference.

**Expected behavior**

If API access is sold or promised, docs should explain authentication, endpoints, limits, and examples.

**Actual behavior**

Pricing lists API access under platform features. The API docs page says the section is under development and detailed endpoint documentation is coming soon. citeturn339988view0turn149794view1

**Why this matters**

API access is a buying criterion for teams/labels. “Coming soon” docs make the plan matrix feel aspirational.

**Likely escapes automated tests**

Yes.

**Suggested fix direction**

Either remove API access from pricing until docs exist, label it “planned,” or ship minimal docs for the routes that are already intended to be public.

**Screenshot reference**

Unavailable.

---

## Issue 8 — Homepage appears inconsistent across same canonical URL

**Severity:** P2  
**Confidence:** Low-medium  
**Surface / exact URL:** `/`

**Repro steps**

1. Open the homepage from search result.
2. Open the homepage via the “Powered by Jovie” link from public profile/home context.
3. Compare hero/copy.

**Expected behavior**

The same canonical production homepage should serve one deliberate variant unless an intentional experiment is active and instrumented.

**Actual behavior**

One production fetch showed “The link your music deserves.” Another production fetch of the same domain showed “Release more music with less work,” plus a different page structure. citeturn747838view0turn358729view1

**Why this matters**

If this is a real cache/variant issue, it creates SEO, analytics, QA, and user-trust ambiguity. If it is an intentional experiment, it needs clear ownership.

**Likely escapes automated tests**

Yes, especially if tests fetch only one path or one cache context.

**Suggested fix direction**

Verify whether this is an A/B test, stale static cache, CDN split, or crawler artifact. If intentional, expose experiment metadata internally. If accidental, purge stale caches and add a homepage canonical content check.

**Screenshot reference**

Unavailable.

---

## Issue 9 — Generated-output retrieval is not obvious

**Severity:** P2  
**Confidence:** Medium  
**Surface / exact URL:** `/app/chat`, `/app/library`, `/app/dashboard/releases`

**Repro steps**

1. Inspect app home quick actions.
2. Note actions: Plan a release, Generate album art, Pitch playlists, Build artist profile, Analyze momentum, Share feedback.
3. Look for obvious “Outputs,” “History,” “Generated assets,” or “Previous work” destination in captured context.

**Expected behavior**

Any AI/product action that creates something should have an obvious durable home.

**Actual behavior**

The captured app context shows quick actions but does not clearly explain where generated album art, playlist pitches, momentum analysis, release plans, or feedback artifacts persist. Library exists, but the relationship is not explicit.

**Why this matters**

Users are trained to distrust AI tools that generate transient work. Persistent retrieval is a core product expectation.

**Likely escapes automated tests**

Yes. A smoke test can confirm the button responds without checking user confidence about where the result goes.

**Suggested fix direction**

Add output destinations in each action’s success state:

- “Saved to Library”
- “Added to Release Plan”
- “View generated assets”
- “Open previous pitches”
- “Recent outputs” in chat sidebar

**Screenshot reference**

Unavailable.

---

## Issue 10 — Public profile has known canonical/interaction fragmentation

**Severity:** P2/P1 depending on route  
**Confidence:** High from internal audit, medium for current production behavior  
**Surface / exact URL:** `/{username}`, `/{username}?mode=*`, `/{username}/alerts`, `/{username}/notifications`, `/{username}/pay`, `/{username}/releases`

**Repro steps**

1. Review public profile route map and hardening audit.
2. Compare main profile root, mode query states, standalone alert/notification/pay/release routes, and redirects.

**Expected behavior**

Public profile should have one obvious shell, one obvious drawer system, and intentional canonical routes for fan-facing actions.

**Actual behavior**

Internal hardening audit identifies duplicate shell implementations, duplicate bottom nav implementations, separate alert/notification surfaces, drawer vs full-page inconsistencies, redirect sinks, and a silent catch-all redirect to profile root. fileciteturn19file0

**Why this matters**

Public profile is the product’s front door. Fragmentation here creates inconsistent fan experiences, harder QA, and fragile route behavior.

**Likely escapes automated tests**

Partially. E2E can cover happy paths while missing product-level route intent.

**Suggested fix direction**

Complete the profile hardening cleanup:

- One live shell.
- One live drawer/sheet primitive.
- One canonical subscribe/alerts route.
- Unknown subpaths should 404 or show a controlled fallback, not silently redirect.
- Fan-facing route matrix should be owned as product spec, not only implementation notes.

**Screenshot reference**

Unavailable.

---

## Issue 11 — Public profile copy polish: “Dont Look Down”

**Severity:** P3  
**Confidence:** Medium  
**Surface / exact URL:** `/tim`

**Repro steps**

1. Open public Tim profile via `/timwhite`.
2. Observe redirect to `/tim`.
3. Read visible release/profile text.

**Expected behavior**

If the song title is “Don’t Look Down,” copy should preserve the apostrophe. If the official title is stylized “Dont Look Down,” no issue.

**Actual behavior**

Public profile text rendered “Dont Look Down.” citeturn358729view0

**Why this matters**

Small polish defects on public artist pages read as data-quality issues.

**Likely escapes automated tests**

Yes.

**Suggested fix direction**

Verify canonical music metadata. If title is not stylized, normalize display punctuation or fix imported metadata.

**Screenshot reference**

Unavailable.

---

## Issue 12 — Chat/app DOM shows likely duplicate responsive/nav elements

**Severity:** P2/P3  
**Confidence:** Low-medium  
**Surface / exact URL:** `/app/chat`

**Repro steps**

1. Inspect captured DOM context.
2. Note repeated labels: Jovie/Jovie, Search/Search, New thread duplicated, Home/Releases/Audience/Library/Tasks repeated in multiple nav blocks.

**Expected behavior**

Responsive duplicate navs should be hidden from assistive tech when not visible.

**Actual behavior**

The text extraction includes duplicated navigation/control labels. This may be harmless if hidden elements are correctly `aria-hidden`; it may be an accessibility problem if not.

**Why this matters**

Screen reader users can get duplicate navigation landmarks and repeated controls.

**Likely escapes automated tests**

Yes, unless accessibility tests inspect the accessibility tree rather than the DOM.

**Suggested fix direction**

Run axe/accessibility-tree checks on desktop and mobile shell. Ensure hidden responsive nav copies use proper visibility and `aria-hidden` behavior.

**Screenshot reference**

Unavailable.

---

## Issue 13 — Chat command status may linger as confusing state

**Severity:** P3  
**Confidence:** Low-medium  
**Surface / exact URL:** `/app/chat`

**Repro steps**

1. Inspect captured `/app/chat` context.
2. Note chat/status text: “Opening Releases — Preparing your release workspace.”
3. Note profile panel content is also visible.

**Expected behavior**

Transient navigation/action messages should resolve, disappear, or become useful.

**Actual behavior**

The captured context shows a release-opening status message while profile panel content is visible. It may be normal conversation history, but it reads as stale transitional state.

**Why this matters**

Chat-first apps need exceptional state clarity. Lingering “opening” messages make the system feel stuck.

**Likely escapes automated tests**

Yes.

**Suggested fix direction**

Navigation/tool messages should end in a durable state: “Opened Releases,” “Failed to open,” or disappear after route transition.

**Screenshot reference**

Unavailable.

---

## Issue 14 — App version display is useful but looks like internal debug chrome

**Severity:** P3  
**Confidence:** Medium  
**Surface / exact URL:** `/app/chat`

**Repro steps**

1. Inspect active app context.
2. Observe sidebar version label `v26.4.179`.
3. Compare version source.

**Expected behavior**

Version display should be deliberately placed for admins/support, hidden from regular users, or visually framed as support metadata.

**Actual behavior**

The captured app context exposes `v26.4.179`; repo `version.json` also shows `26.4.179`. fileciteturn8file0

**Why this matters**

Version labels can be good for support, but if they look like dev chrome they reduce consumer polish.

**Likely escapes automated tests**

Yes.

**Suggested fix direction**

Keep it in an About/Support drawer or show it only for admins/debug mode.

**Screenshot reference**

Unavailable.

---

## Issue 15 — Known backend stability risks remain relevant to product trust

**Severity:** P0/P1 if still unresolved in production  
**Confidence:** Medium; source is prior audit  
**Surface / exact URL:** API/billing/profile/calendar/health routes

**Repro steps**

1. Review prior stability audit.
2. Pay attention to Stripe cancel, Stripe checkout, billing status fallback, audit log filtering, profile/social update race conditions, and health route observability.

**Expected behavior**

Billing/profile/account operations should be highly observable, retryable, and consistent.

**Actual behavior**

The February stability audit identified critical/high issues around Stripe cancellation observability, checkout retry behavior, billing fallback, audit log leakage risk, and profile/social link race conditions. fileciteturn9file0

**Why this matters**

Human polish cannot compensate for billing/account reliability issues. These directly affect trust and revenue.

**Likely escapes automated tests**

Some yes, especially race conditions and third-party outage handling.

**Suggested fix direction**

Reconcile the prior audit against current main/prod. Close, downgrade, or re-open each item explicitly.

**Screenshot reference**

N/A.

# 4) Missing core product expectations

## 1. One obvious account hub

Jovie needs a first-class account hub with Profile, Account, Billing, Payments, Data & Privacy, Connected Accounts, Team, Support, Docs, and Sign out.

## 2. One obvious billing hub

Public support and terms already tell users billing management exists. The app should make that impossible to miss. citeturn451704view1turn747838view2

## 3. Self-service cancellation clarity

Terms say users may cancel anytime from account settings. That must be discoverable, boring, and testable. citeturn747838view2

## 4. Data export and deletion controls

Privacy says users can delete accounts and download/export data. The app needs an obvious Data & Privacy screen with these actions. citeturn339988view3

## 5. Connected account disconnect/revoke controls

Privacy explains Google/Spotify revocation externally. A mature app should also show connected providers and explain what disconnecting does. citeturn339988view3

## 6. Persistent generated-output library

AI-generated album art, pitches, plans, copy, and analyses should have a durable, named home.

## 7. Clear release-plan ownership

Marketing says Jovie generates release plans, task lists, fan paths, and actions. The authenticated product should make “where release plans live” immediately clear. citeturn358729view1

## 8. Support/docs/status consistency

Support, docs, and status should be linked, current, and crawled automatically.

## 9. Public route canonical policy

Public profile modes, alert routes, notification routes, pay/tip redirects, release paths, and catch-alls need one product-owned route matrix. The internal hardening audit already identifies this need. fileciteturn19file0

## 10. Accessibility-quality nav policy

Duplicate responsive navs, hidden sidebars, mobile bottom navs, profile drawers, and command/chat controls need screen-reader and keyboard behavior checks.

# 5) Prioritized punch list

## Now

1. Fix broken support docs link to canonical `/docs/getting-started`.
2. Fix or remove public status link.
3. Resolve billing contradictions across Pricing, Terms, Support, Settings, and onboarding.
4. Decide whether billing is waitlist-only, self-serve, trial-based, or admin-enabled.
5. Make account/settings/billing/data privacy discoverable from the authenticated shell.
6. Audit public pages for stale copy and plan-name drift.
7. Verify homepage variant/caching behavior.
8. Reconcile prior billing/stability audit items against current production.
9. Add crawler coverage for external docs/status/support links.
10. Verify profile route hardening issues still open vs shipped.

## Next

1. Collapse route aliases into product-owned canonicals.
2. Make profile editing ownership explicit: chat shortcut vs settings workspace.
3. Add persistent “Generated outputs” or “Recent work” destination.
4. Harden public profile route matrix and remove dead profile shells/drawers.
5. Add accessibility-tree checks for duplicate responsive navs.
6. Add support/docs/legal/pricing content consistency tests.
7. Add settings/account/billing UX walkthrough tests with human-readable assertions.
8. Add public API docs or remove API access from pricing until ready.

## Later

1. Add product-state observability for route transitions and chat tool states.
2. Add status/incident page with real uptime and incident history.
3. Add admin-only debug/version/support drawer.
4. Add canonical route documentation visible to support and growth teams.
5. Add regression tests for homepage cache/variant consistency.
6. Add human QA script specifically for “where does this live?” discoverability.

**Blocked coverage:** true exhaustive live QA still needs a browser agent/session that can click, resize, type, screenshot, navigate back/forward, refresh mid-flow, and test mobile widths.

---

## User

You should have agent mode now, so you should be able to go forward. 

---

## Assistant

Mr. White, agent mode isn’t currently active on my side (tool calls are being blocked), so I can’t proceed with live browser actions yet. Please restart/enable agent mode again and tell me what page you’re on, and I’ll continue from there.


## See Also
- [[chatgpt/chatgpt_bodyspec-report-summary]]
- [[chatgpt/chatgpt_inventory-summary-report]]
- [[chatgpt/chatgpt_ux-audit-summary]]
- [[chatgpt/chatgpt_app-test-report]]
- [[chatgpt/chatgpt_chat-testing-report]]
