---
title: "Profile and Release Issues"
type: essay
created: 2026-04-21
updated: 2026-04-21
source: chatgpt-export
conversation_id: 69e7db35-88f0-83e8-a255-f929d97f4e9d
message_count: 6
tags: [chatgpt, import, long-form]
---
# Profile and Release Issues

> Conversation ID: 69e7db35-88f0-83e8-a255-f929d97f4e9d
> Created: 2026-04-21T20:16:54Z
> Updated: 2026-04-21T21:09:10Z
> Messages: 6

---

## User

Okay I'm gonna list out some issues and I need you to pull them and organize them and then open up well-scoped issues in Linear so on public profiles.
Right now on desktop when you open the right drawer or the menu:
1. The menu on desktop is opening at the bottom of the browser even though the profile is contained in a smaller area.
2. When I click on releases it then expands to a giant drawer even though that's scrolling; it's way too tall.
3. I'm seeing releases that don't have album art and stuff.
There are a couple of things that need to happen there:
1. You need to make sure that if it doesn't have album art it never is allowed to be a published release. We should never have a published release that doesn't have art on it. The minimum requirement should be that it has album art, it has a title, it has an artist set, and it has a release date set. If it doesn't have that, the issue never becomes a published release and is a draft.
2. I don't know why, but somehow on my public profile anyway we've ingested a number of copies of an EP over and over again. There's a duplication issue that we need where we should be able to make sure we're not pulling duplicate releases. That shouldn't theoretically happen because they should have UPC codes on them that match so we need to do an application against UPC codes.
3. Anything that's probably should have a nice UPC code assigned to it if it doesn't have enough ISRC code. That should be a warning. You don't need to warn if it's in a draft state. I might say that you wouldn't get an ISRC code until you had this distribution so you should still be able to put an ISRC code. I guess an ISRC code is non-blocking but there should be a warning on the backend if something is scheduled or has a release date on it but doesn't have an ISRC code attached to it.
4. Just some kind of icon in the releases table and some kind of overlay that basically just says there's no release on this and help them.
1.  Homepage cleanup design-wise, which will be cloned off the artist profiles design that comes back. So we're waiting on the designer to complete that in the next 12 to 24 hours.
2.  Right drawer. There's information density clean-up and there's still extra carding particularly on the about tab that needs to be removed. I think that that should be taken into Claude design and generally we should do one design pass over each one of the core elements. So entity cards in the right drawer, tabs cards, home state for chat and empty chat. Insights should be designed as well and then that should be with like the card carousel and stuff with empty states. On releases page we have this pop over for the loading state that should just go away and everything should be pushed down to skeleton loaders and to minimize LCP.
3.  A general audit on entities or entitlements so that like CSV export is properly blocked behind a pro count and all that stuff. Particularly on the settings page I'm seeing slow load and that could use a design pass. So the admin toolbar setting actually the toggle states the toggle state when in particular in light mode, yeah it's fine in dark mode, in light mode toggles are not visible I think it's an order token issue.
4.  Some weird situation just happened where I'm clicking through the settings and got logged out. I see six console warnings, custom state pseudo classes have been changed from radix drop down to state radix dropdown, their depreciation warnings, so that needs to be looked at which can just be handled in a general investigate/investigate gstack commands that runs against production and looks for console errors.
5.  The loader on the continue with Google button goes fucking crazy whenever you click on it.
6.  Okay so I got logged out and then when I came back I'm getting an auth callback error. Email sign that needs to be re-enabled on production. Is there actually a waitlist fucking thing? There's some weird CSS glitch or something where when I log out I'm landing on the home page with a grey header and then on a refresh it goes back to the normal header styling.
7.  Auth screens are still incredibly slow.

---

## Assistant

I’ll break this into focused, copy-ready Linear issues with clear scope, priority, acceptance criteria, and dependencies, separating public-profile work from auth/settings/platform cleanup.

---

## Assistant

Mr. White, here are Linear-ready issues, organized and scoped. I’d create these as separate tickets rather than one giant cleanup issue.

## Epic: Public Profile Releases + Drawer UX

### 1. Fix desktop public profile menu/drawer positioning

**Priority:** P1  
**Area:** Frontend  
**Labels:** `public-profile`, `desktop`, `drawer`, `ui-bug`

**Problem**  
On desktop public profiles, opening the right drawer/menu positions the menu at the bottom of the browser viewport, even when the profile content is constrained to a smaller centered area.

**Expected behavior**  
The drawer/menu should anchor relative to the public profile container, not the full browser viewport.

**Acceptance criteria**
- Desktop menu opens aligned to the profile container.
- Menu does not appear at the bottom of the browser unless the profile container itself is there.
- Behavior works across common desktop viewport sizes.
- No regression to mobile drawer behavior.
- Add visual/test coverage if available for public profile desktop drawer positioning.

---

### 2. Constrain releases drawer height on public profiles

**Priority:** P1  
**Area:** Frontend  
**Labels:** `public-profile`, `releases`, `drawer`, `ui-bug`

**Problem**  
Clicking “Releases” on the public profile expands the drawer into a giant oversized panel. The drawer is too tall even though the releases content is scrollable.

**Expected behavior**  
The releases drawer should have a bounded height and internal scrolling.

**Acceptance criteria**
- Releases drawer has a reasonable max-height on desktop.
- Releases list scrolls inside the drawer.
- Drawer does not exceed the intended profile container/page layout.
- Empty/loading/error states respect the same height constraints.
- Mobile behavior remains usable.

---

### 3. Block publishing releases that are missing required metadata

**Priority:** P0  
**Area:** Backend  
**Labels:** `releases`, `publishing`, `data-integrity`, `public-profile`

**Problem**  
Published releases are appearing publicly without required metadata, including missing album art.

**Required metadata for published releases**
- Album art
- Title
- Artist
- Release date

**Expected behavior**  
A release that is missing any required field must remain a draft and must never appear as a published public release.

**Acceptance criteria**
- Server-side validation prevents publishing when album art, title, artist, or release date is missing.
- Imported/ingested releases missing required metadata are stored as drafts.
- Existing published releases missing required metadata are migrated or corrected so they no longer appear publicly.
- Public profile queries exclude invalid published releases defensively.
- Add tests for publish flow, import flow, and public profile release query.

---

### 4. Dedupe ingested releases by UPC

**Priority:** P0  
**Area:** Backend  
**Labels:** `releases`, `ingestion`, `deduplication`, `data-integrity`

**Problem**  
The same EP has been ingested multiple times and appears as duplicate releases on the public profile. Releases with matching UPCs should not create duplicate release records.

**Expected behavior**  
Release ingestion should upsert against UPC rather than creating duplicates.

**Acceptance criteria**
- Normalize UPC values before comparison.
- Ingestion checks for an existing release with the same UPC before creating a new release.
- Matching UPC creates or updates a single canonical release record.
- Existing duplicate releases with matching UPCs are identified and safely merged or hidden.
- Add logging/metrics for dedupe decisions.
- Add tests covering repeated ingestion of the same UPC.

**Implementation note**  
Recommended uniqueness rule: normalized UPC scoped to the relevant artist/account context unless the current data model supports a stronger global release identity.

---

### 5. Add metadata warnings for scheduled/published releases missing UPC or ISRCs

**Priority:** P1  
**Area:** Backend + Frontend  
**Labels:** `releases`, `metadata`, `warnings`, `admin`

**Problem**  
Releases that are scheduled or have release dates should surface warnings when important distribution metadata is missing. ISRC should be non-blocking, especially before distribution, but the backend should still warn for scheduled/non-draft releases.

**Expected behavior**
- Draft releases do not show these warnings.
- Scheduled or published releases show warnings for missing UPC and/or missing track ISRCs.
- ISRC warnings are non-blocking.

**Acceptance criteria**
- Backend exposes warning state for non-draft releases missing UPC.
- Backend exposes warning state for non-draft releases with tracks missing ISRCs.
- Warning state is visible in admin/release management UI.
- Warning does not prevent saving or publishing unless separate publish validation requires it.
- Draft releases do not display these warnings.
- Add tests for draft, scheduled, and published states.

---

### 6. Add missing-art indicator and helper overlay in releases table

**Priority:** P2  
**Area:** Frontend  
**Labels:** `releases`, `ui`, `empty-state`, `metadata`

**Problem**  
Releases without album art need a clear visual indicator and help state in the releases table.

**Expected behavior**  
The releases table should show an icon or visual indicator when album art is missing, with a helpful overlay explaining what is missing and how to fix it.

**Acceptance criteria**
- Releases table shows a clear missing-art icon/state.
- Hover/click overlay explains that album art is required for publishing.
- Overlay links or routes the user to the place where album art can be added.
- Draft releases can show this as guidance.
- Published releases should not reach this state after the backend validation fix.

---

## Epic: Design Cleanup

### 7. Homepage cleanup based on updated artist profile design

**Priority:** P2  
**Area:** Design + Frontend  
**Labels:** `homepage`, `design`, `blocked`

**Problem**  
Homepage needs design cleanup and should be cloned/adapted from the updated artist profile design once the designer completes it.

**Dependency**  
Waiting on designer deliverable expected within 12–24 hours.

**Acceptance criteria**
- Homepage visual direction follows updated artist profile design system.
- Spacing, cards, typography, and hierarchy are cleaned up.
- Responsive desktop/mobile states are reviewed.
- Empty/loading states are accounted for.
- Implementation ticket is created after design handoff if needed.

---

### 8. Run design pass on right drawer core states

**Priority:** P1  
**Area:** Design  
**Labels:** `right-drawer`, `design`, `claude-design`

**Problem**  
Right drawer has information density issues and excessive carding, especially on the About tab. Core states need a focused design pass.

**Scope**
- Entity cards in the right drawer
- Tab/card structure
- About tab carding cleanup
- Chat home state
- Empty chat state
- Insights state
- Card carousel
- Insights empty states

**Acceptance criteria**
- Produce updated designs for each core right-drawer state.
- Reduce unnecessary nested cards and visual noise.
- Improve information density.
- Include empty/loading states.
- Provide implementation notes for frontend.

---

### 9. Implement right drawer cleanup from design pass

**Priority:** P2  
**Area:** Frontend  
**Labels:** `right-drawer`, `frontend`, `design-implementation`, `blocked`

**Problem**  
After the design pass, frontend needs to implement the cleaned-up right drawer states.

**Dependency**  
Blocked by Issue 8 design output.

**Acceptance criteria**
- About tab extra carding is removed.
- Entity cards follow updated design.
- Tabs/cards/home chat/empty chat/insights states match final design.
- Card carousel and empty states are implemented.
- Desktop and mobile drawer states are QA’d.

---

### 10. Replace releases page loading popover with skeleton loaders

**Priority:** P1  
**Area:** Frontend  
**Labels:** `releases`, `loading-state`, `performance`, `lcp`

**Problem**  
The releases page currently shows a popover-style loading state. This should be removed in favor of skeleton loaders to reduce layout disruption and improve LCP.

**Expected behavior**  
Loading should happen in-place with skeletons, with page structure preserved.

**Acceptance criteria**
- Remove loading popover from releases page.
- Add skeleton loaders in the table/list/content areas.
- Page layout remains stable during loading.
- No content jumps from popover removal.
- Verify LCP impact does not regress.

---

## Epic: Entitlements + Settings

### 11. Audit entity entitlements and Pro-gated actions

**Priority:** P1  
**Area:** Backend + Frontend  
**Labels:** `entitlements`, `billing`, `pro`, `security`

**Problem**  
Need a general audit to make sure gated actions are properly blocked behind Pro, especially CSV export.

**Scope**
- CSV export
- Entity-level gated features
- Settings-page gated actions
- Any admin/user capabilities tied to plan entitlements

**Acceptance criteria**
- CSV export is blocked for non-Pro accounts.
- Backend authorization enforces entitlement checks, not only frontend UI.
- Frontend clearly communicates upgrade requirement.
- Audit other known gated entity actions.
- Add tests for at least CSV export and one representative gated entity action.

---

### 12. Improve settings page load performance

**Priority:** P2  
**Area:** Frontend  
**Labels:** `settings`, `performance`, `design`

**Problem**  
Settings page feels slow to load and needs a cleanup pass.

**Expected behavior**  
Settings page should load quickly with stable layout and appropriate skeleton/loading states.

**Acceptance criteria**
- Identify slow-loading settings modules.
- Avoid blocking the entire page on lower-priority settings data.
- Add skeletons or progressive loading where appropriate.
- Reduce unnecessary re-renders or redundant data fetches.
- Confirm no major LCP/interaction regression.

---

### 13. Fix light-mode toggle visibility in settings/admin toolbar

**Priority:** P1  
**Area:** Frontend  
**Labels:** `settings`, `admin-toolbar`, `design-system`, `light-mode`

**Problem**  
Toggle states in the admin toolbar/settings area are difficult or impossible to see in light mode. Dark mode appears fine. This seems likely to be a token/order issue.

**Expected behavior**  
Toggle states should be clearly visible in light mode and dark mode.

**Acceptance criteria**
- Toggle checked/unchecked/disabled/focus states are visible in light mode.
- Dark mode toggle states remain correct.
- Fix uses design tokens correctly.
- QA admin toolbar settings specifically.
- Add visual regression coverage if available.

---

## Epic: Auth + Production Stability

### 14. Investigate unexpected logout while navigating settings

**Priority:** P0  
**Area:** Full-stack  
**Labels:** `auth`, `settings`, `production`, `investigation`

**Problem**  
User was unexpectedly logged out while clicking through settings.

**Expected behavior**  
Navigating settings should not invalidate the session or force logout.

**Acceptance criteria**
- Reproduce or identify logs around the logout event.
- Check auth/session refresh behavior on settings routes.
- Check whether any settings request returns an auth-invalidating response.
- Confirm no client-side error is clearing auth state.
- Add logging or guardrails if root cause is unclear.
- Fix identified cause or create follow-up ticket with evidence.

---

### 15. Investigate production console warnings and Radix state deprecations

**Priority:** P2  
**Area:** Frontend  
**Labels:** `console-warnings`, `radix`, `production`, `tech-debt`

**Problem**  
Production console shows warnings, including Radix custom state pseudo-class deprecation warnings: custom state pseudo classes changed from Radix dropdown state naming.

**Expected behavior**  
Production should not emit avoidable console warnings during normal navigation.

**Acceptance criteria**
- Run production console audit against relevant app flows.
- Capture all warnings/errors.
- Update deprecated Radix state selectors/usages.
- Confirm warnings are resolved in production build.
- Create separate issues for unrelated console errors if discovered.

---

### 16. Fix “Continue with Google” button loader animation

**Priority:** P1  
**Area:** Frontend  
**Labels:** `auth`, `google-login`, `loading-state`, `ui-bug`

**Problem**  
The loader on the “Continue with Google” button behaves erratically after click.

**Expected behavior**  
The button should enter a stable loading state after click and remain visually controlled until auth redirects or fails.

**Acceptance criteria**
- Loader animation is visually stable.
- Button is disabled while auth request is in progress.
- Multiple clicks do not trigger duplicate auth attempts.
- Error state resets button correctly.
- Works in light and dark mode.

---

### 17. Fix production auth callback error and re-enable email sign-in

**Priority:** P0  
**Area:** Backend + Auth  
**Labels:** `auth`, `production`, `email-login`, `callback-error`

**Problem**  
After being logged out and returning, auth callback error appears. Email sign-in also needs to be re-enabled on production.

**Expected behavior**
- Auth callback completes successfully.
- Email sign-in is enabled and functional in production.
- Failed auth states show clear user-facing errors.

**Acceptance criteria**
- Identify root cause of auth callback error.
- Confirm production OAuth callback URLs/config are correct.
- Re-enable email sign-in in production.
- Verify email sign-in end-to-end.
- Verify Google sign-in end-to-end.
- Add logging for auth callback failures.

---

### 18. Remove or fix unexpected waitlist state after logout

**Priority:** P1  
**Area:** Frontend + Auth  
**Labels:** `auth`, `homepage`, `waitlist`, `routing`

**Problem**  
After logout, user appears to land in a strange waitlist/homepage state. There may be an unintended waitlist UI or routing condition.

**Expected behavior**  
Logged-out users should land on the correct public/home auth state with the intended CTA and layout.

**Acceptance criteria**
- Confirm whether waitlist mode should exist in production.
- Remove unintended waitlist state or gate it behind the correct feature flag.
- Ensure logout redirects to the correct route.
- Ensure auth/homepage CTA state is correct for logged-out users.
- QA refresh and direct navigation behavior.

---

### 19. Fix homepage header styling glitch after logout

**Priority:** P2  
**Area:** Frontend  
**Labels:** `homepage`, `auth`, `css`, `ui-bug`

**Problem**  
After logout, the homepage initially loads with a grey header. Refreshing restores the normal header styling.

**Expected behavior**  
Homepage header styling should be correct immediately after logout without requiring refresh.

**Acceptance criteria**
- Reproduce logout-to-homepage styling issue.
- Identify whether auth state, hydration, route transition, or CSS ordering causes the grey header.
- Header uses correct styling immediately after logout redirect.
- Refresh and direct-load states match.
- Light/dark mode both checked.

---

### 20. Improve auth screen performance

**Priority:** P1  
**Area:** Frontend  
**Labels:** `auth`, `performance`, `lcp`

**Problem**  
Auth screens are still very slow.

**Expected behavior**  
Auth screens should load quickly, especially because they are critical entry points.

**Acceptance criteria**
- Profile auth screen load performance.
- Identify blocking assets, scripts, data requests, or layout shifts.
- Reduce initial JS/CSS where possible.
- Add skeleton/fallback only where useful.
- Verify measurable improvement in LCP and interaction readiness.
- Check Google/email auth entry points.

---

## Suggested Linear grouping

| Issue | Priority | Owner area |
|---|---:|---|
| Block publishing releases missing required metadata | P0 | Backend |
| Dedupe ingested releases by UPC | P0 | Backend |
| Investigate unexpected logout while navigating settings | P0 | Full-stack |
| Fix production auth callback error and re-enable email sign-in | P0 | Backend/Auth |
| Fix desktop public profile menu/drawer positioning | P1 | Frontend |
| Constrain releases drawer height on public profiles | P1 | Frontend |
| Add metadata warnings for scheduled/published releases missing UPC or ISRCs | P1 | Backend + Frontend |
| Run design pass on right drawer core states | P1 | Design |
| Replace releases page loading popover with skeleton loaders | P1 | Frontend |
| Audit entity entitlements and Pro-gated actions | P1 | Full-stack |
| Fix light-mode toggle visibility in settings/admin toolbar | P1 | Frontend |
| Fix “Continue with Google” button loader animation | P1 | Frontend |
| Remove or fix unexpected waitlist state after logout | P1 | Frontend/Auth |
| Improve auth screen performance | P1 | Frontend |
| Add missing-art indicator and helper overlay in releases table | P2 | Frontend |
| Homepage cleanup based on updated artist profile design | P2 | Design + Frontend |
| Implement right drawer cleanup from design pass | P2 | Frontend |
| Improve settings page load performance | P2 | Frontend |
| Investigate production console warnings and Radix state deprecations | P2 | Frontend |
| Fix homepage header styling glitch after logout | P2 | Frontend |

---

## User

Open up issues in linear for each one of these please 

---

## Assistant

I can map these into separate Linear issues, but there’s no Linear connector exposed here to create them directly. I’ll provide an import-ready CSV fallback so you can bulk import them.

---

## Assistant

Mr. White, I don’t have a Linear connector/action available in this chat, so I couldn’t create the tickets directly in Linear.

I prepared a Linear-import-ready CSV with all **20 scoped issues**. It uses Linear’s documented CSV fields: `Title`, `Description`, `Priority`, `Status`, `Assignee`, `Created`, `Completed`, `Labels`, and `Estimate`. Linear documents imports under **Settings → Administration → Import/Export**, with admin access required, and recommends the CLI importer for CSV imports using the “Linear” CSV option. citeturn322544view0

Files:

- [Download Linear CSV import file](sandbox:/mnt/data/linear_issues_public_profile_auth_cleanup.csv)
- [Download readable Markdown review file](sandbox:/mnt/data/linear_issues_public_profile_auth_cleanup.md)

Priority mapping used:

| Internal priority | Linear priority |
|---|---|
| P0 | Urgent |
| P1 | High |
| P2 | Medium |

All issues are set to `Backlog` with labels for area, feature, and priority.


**Topic:** [[chatgpt-clusters/jovie_music]]
