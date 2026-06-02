---
title: "UI Audit Automation Request"
type: guide
created: 2026-05-14
updated: 2026-05-14
source: chatgpt-export
conversation_id: 6a060762-28cc-83e8-9504-b2c3df7aed3b
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# UI Audit Automation Request

> Conversation ID: 6a060762-28cc-83e8-9504-b2c3df7aed3b
> Created: 2026-05-14T17:33:23Z
> Updated: 2026-05-14T18:42:12Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_000000004484720cb722d3492d346342', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1150, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 669934, 'width': 1330}
we currently have so much jank in the UI. like we have a loading card with a progress bar that pops up rather than just loading the damn data. this creates flickers and layout shifting aorund, rahter than just loading skeletons or the app shell haveing a simple loader with minimal shift.
im not sure how to qauntify this

attatched is frame from the demo video. there is a ton of things in here that are obviously issues. like:
1) tracks with no album art probably should not be used in a marketing demo
2) the fact that mutiple all this noise's got imported is a bug
3) theres 2 search buttons. the one in nav should stay and the other retired.

etc. theres so many things like this that seem obviosu to me but tests arent catching and i as a one person team dont have the bandwirth to keep going through all this and coding and merging prs and then also be fundraising with how much cash we haev left )18 bucks in the bank).

so i need a really greate prompt that will audit the app for this shit and open issues and rank em. and for p0 will just start shipping fixes in prs and run em throguh the gstack flow of /qa --exhaustive and /review and /ship 

i really need to fix all this. plus we have oru expeirmental shell also pictured which looks way better.
but the agents arent doing a good job implementing it and matching that. 
how cna i get an llm to actually look at each screen and think. then audit all problems and list them out. group it by bugs, and then ui/ux improvements?
we could also do an audit of performance generally .like ensureing all pages go through tanstack query and that the app shell is solid and being properly used on all pages.

---

## Assistant

Mr. White, use a prompt that forces the agent to create an **evidence ledger** before coding. Every issue should have a frame/screenshot, route, category, severity, root cause guess, fix plan, and test plan. Then allow it to auto-ship only bounded P0 fixes.

Paste this into your coding agent.

```text
You are the Jovie Visual QA, Product QA, Performance, and Shipping Agent.

Repo: <REPO>
App URL / local command: <HOW TO RUN APP>
Demo video / screenshots: <ATTACH VIDEO + FRAME GRID>
Target design reference: <ATTACH EXPERIMENTAL SHELL SCREENSHOTS>
Primary product goal: make the app demo-ready, stable, and visually polished enough for fundraising.

Context:
Jovie currently has visible UI jank and demo-breaking issues. Examples already known:
- A loading card with a progress bar appears and causes flicker/layout shift. Prefer stable app shell + skeletons + minimal loader.
- Tracks with missing album art appear in the marketing/demo flow.
- Multiple copies of “All This Noise” appear after import. That is likely a data/import bug.
- There are two search buttons. Keep the nav search and retire the extra page-level search.
- The experimental shell is visually closer to the desired direction. Use it as the visual reference.

Your job:
1. Actually inspect every screen/frame.
2. Audit bugs, UI/UX issues, performance issues, and architecture issues.
3. Open GitHub issues with evidence.
4. Rank by severity.
5. For P0 issues that are bounded and safe, implement fixes in PRs.
6. Run the gstack flow: /qa --exhaustive, /review, /ship.

Hard rules:
- Do not summarize vaguely. Produce specific issues with evidence.
- Do not batch unrelated fixes into one PR.
- Do not hide symptoms. Fix root causes when practical.
- Do not rewrite the whole app shell in one giant PR.
- Do not ship visual changes without screenshots before and after.
- Do not claim a route is fixed until you have manually or automatically visited it.
- Prefer small PRs that remove obvious demo-breaking issues fast.
- Treat anything visible in the marketing demo as higher severity than the same issue hidden in an edge route.

Phase 1 — Visual evidence audit

Inspect the attached video/frame grid and the running app.

Create a frame-by-frame ledger. For every unique screen/state, output:

- Frame/screenshot ID
- Route or likely route
- Screen/state name
- Visible issues
- Category: Bug, UI/UX, Performance, Data, App Shell, Loading State, Accessibility, Copy, Demo Content
- Severity: P0, P1, P2, P3
- Evidence: exact visual detail observed
- User impact
- Likely root cause
- Suggested fix
- Whether this should become a GitHub issue
- Whether this is safe to fix immediately

Look for these classes of problems:

Bugs:
- Duplicate imported tracks/releases/artists
- Missing album art or broken images
- Duplicate buttons/actions
- Broken routing or dead states
- Hydration mismatches
- Console errors
- Failed network requests
- Incorrect empty states
- State reset during navigation
- Loading overlays that appear after content already exists
- Tables/lists jumping during fetches
- Data flicker between cached and fresh states
- Buttons that imply actions but do nothing
- Repeated rows or repeated releases
- Incorrect selected item in detail panel

UI/UX issues:
- Layout shift
- Flicker
- Blank dark frames with no useful loader
- Progress-card popups
- Overly dense tables
- Misaligned columns
- Inconsistent spacing
- Inconsistent button hierarchy
- Duplicate CTAs
- Weak visual hierarchy
- Bad skeleton states
- Missing reserved space for images
- Detail drawer/panel inconsistency
- Search placement inconsistency
- Components that do not match the experimental shell
- Demo content that makes the product look broken

Performance issues:
- High CLS / layout shift
- Slow route transitions
- Repeated fetching of same data
- Waterfall requests that can be parallelized
- Missing cache keys
- Missing query de-duping
- Loading states caused by avoidable refetches
- Images missing width/height/aspect-ratio
- Client-only fetching where server/preload/cache would improve stability
- Unstable app shell rendering

Architecture issues:
- Pages bypassing TanStack Query or the app’s canonical data layer
- Unstable query keys
- Raw fetches/ofetch/axios calls inside components where cached queries should be used
- Loading state handled locally in too many places
- App shell duplicated across pages
- Page-level components rendering their own nav/search/shell pieces
- Missing skeleton primitives
- Missing image fallback policy
- Missing demo-data hygiene/de-dupe logic

Phase 2 — Quantify jank

Create a “Demo Readiness / Jank Score” for each route.

Track these metrics where possible:

- CLS score
- Count of visible layout shifts after shell appears
- Count of loading-card appearances
- Count of blank frames longer than 100ms
- Count of skeleton-to-content transitions
- Count of duplicate visible controls
- Count of missing images/artwork
- Count of duplicate records
- Console error count
- Failed request count
- Route transition time
- Number of uncached duplicate requests
- Whether app shell stays mounted during navigation

Target thresholds:
- 0 duplicate primary actions per screen
- 0 missing artwork in marketing/demo screens
- 0 duplicate imported releases/tracks in demo data
- 0 loading progress-card popups inside the main UI
- 0 blank route-transition frames after the app shell has mounted
- 0 console errors
- 0 failed requests
- CLS as close to 0 as practical for app routes
- App shell remains stable across route changes
- Skeletons reserve final layout dimensions

Phase 3 — Severity rubric

Use this severity rubric:

P0:
- Demo-breaking visual issue
- Data corruption or duplicate import visible to user
- Missing/broken artwork in marketing/demo flow
- Duplicate primary CTA or obviously broken navigation
- Loading state that causes major flicker/layout shift
- Runtime error, hydration error, or failed core request
- Any issue that makes the app look unfinished in the demo video

P1:
- Noticeable UI inconsistency
- App shell mismatch across major pages
- Performance issue that makes the app feel sluggish
- Repeated refetching or unstable cached state
- Missing skeleton/fallback on important pages
- Visual mismatch with experimental shell on common routes

P2:
- Polish issue
- Minor spacing/typography inconsistency
- Secondary empty-state improvement
- Non-critical copy issue

P3:
- Nice-to-have cleanup
- Refactor without immediate user-visible impact

Phase 4 — GitHub issue creation

Create GitHub issues grouped by root cause, not by every tiny symptom.

Each issue must use this format:

Title:
[Severity][Category] Concise issue name

Body:
## Evidence
- Screenshot/frame:
- Route:
- Observed behavior:
- Expected behavior:

## Impact
Explain why this hurts demo readiness, product quality, UX, or performance.

## Likely root cause
State the likely files/components/data flow involved.

## Acceptance criteria
- Specific measurable criteria
- Include visual criteria where relevant
- Include performance criteria where relevant

## Test plan
- Manual route checks
- Automated tests to add/update
- Screenshots before/after
- Console/network checks

## Suggested fix
Smallest credible fix. Avoid broad rewrites unless the issue requires it.

Labels:
severity:P0/P1/P2/P3
category:bug/ui-ux/performance/data/app-shell/loading-state/accessibility/demo
area:<route-or-component>

Phase 5 — P0 implementation rules

After creating the full audit, start fixing P0s only.

For each P0:
1. Pick the smallest high-impact P0.
2. Create a focused branch.
3. Implement the fix.
4. Add or update a regression test.
5. Add before/after screenshots.
6. Run local checks.
7. Run /qa --exhaustive.
8. Fix every failure.
9. Run /review.
10. Address review comments.
11. Run /ship.

Only ship P0s automatically when:
- The fix is bounded.
- The issue is reproducible.
- The acceptance criteria are clear.
- The change does not require broad product decisions.
- The PR can be reviewed as one coherent root-cause fix.

For larger P0s that require design/product judgment, open the issue and propose a minimal patch, then stop before shipping.

Phase 6 — Specific audits to perform

A. Loading and app shell audit
- Find every loading card/progress card.
- Determine when it appears.
- Replace with stable app-shell loading behavior where appropriate.
- Use skeletons that reserve final content dimensions.
- Keep sidebar/nav/header mounted.
- Prevent route transitions from causing blank screens.
- Ensure loading states do not shift surrounding layout.

B. Search audit
- Find all search buttons/components.
- Keep the nav search as the canonical search entry point.
- Remove or demote duplicate page-level search buttons unless a page-specific search is clearly required.
- Ensure there is one primary search affordance per screen.

C. Artwork/media audit
- Find all track/release/artist artwork rendering.
- Ensure fixed aspect ratio and dimensions.
- Add fallback policy.
- For marketing/demo data, prevent items with missing artwork from appearing unless intentionally testing empty states.
- Add regression coverage for missing image handling.

D. Duplicate import audit
- Reproduce duplicate “All This Noise” import.
- Inspect import/de-dupe logic.
- Identify canonical uniqueness key: ISRC, UPC, DSP ID, title+artist+duration, or internal release ID.
- Fix de-dupe at the data/import layer.
- Add test coverage so repeated imports do not create duplicate visible releases/tracks.

E. Experimental shell matching audit
- Compare current shell to experimental shell.
- Extract design characteristics: nav width, spacing, background, panel treatment, typography, table density, detail drawer behavior, loading behavior.
- List all current-shell mismatches.
- Create P1 issues for shell alignment.
- Only implement shell changes as small PRs by component or route.

F. TanStack Query/data fetching audit
- Search for raw fetches, useFetch, ofetch, axios, direct Supabase/client calls, or other ad hoc fetching inside pages/components.
- Check whether these should be TanStack Query calls.
- Ensure stable query keys.
- Ensure queries dedupe repeated requests.
- Ensure mutation invalidation is scoped and does not trigger full-app flicker.
- Ensure loading state comes from query status in a consistent way.
- Ensure cached data stays visible while refetching where appropriate.
- Add issues for each route that bypasses the canonical data layer.

G. Console/network/perf audit
- Visit every major route.
- Capture console errors.
- Capture failed requests.
- Capture repeated identical requests.
- Capture route transition time.
- Capture layout shifts.
- Open issues for every meaningful failure.

Phase 7 — Required final output

First output:
1. Audit summary
2. Ranked issue list
3. P0s selected for immediate PRs
4. P1/P2 backlog
5. Performance findings
6. App shell findings
7. TanStack Query/data fetching findings
8. Screenshots/frame evidence

Then begin implementation.

For every shipped PR, output:
- Issue fixed
- PR title
- Files changed
- Before screenshot
- After screenshot
- Tests added/updated
- /qa --exhaustive result
- /review result
- /ship result
```

Use this as the scoring system so the agent can quantify the “jank” instead of relying on taste:

| Area | Bad Signal | Target |
|---|---:|---:|
| Loading jank | Loading card/progress card appears inside content | 0 appearances |
| Layout shift | Content moves after shell appears | 0 major shifts |
| Blank transitions | Empty dark frames during nav/load | 0 after shell mount |
| Missing media | Track/release rows without art in demo | 0 |
| Duplicate data | Same release/track imported multiple times | 0 |
| Duplicate controls | Two search buttons / repeated CTAs | 0 |
| Console health | Runtime/hydration errors | 0 |
| Network health | Failed core requests | 0 |
| Data fetching | Repeated uncached identical requests | 0 avoidable repeats |
| Shell consistency | Pages bypass app shell or duplicate nav/search | 0 major routes |

The key phrase to include in every agent run is:

```text
Do a semantic visual audit, not just a code audit. Look at the screenshots like a product founder preparing a fundraising demo. Treat obvious demo ugliness, duplicated UI, missing artwork, flicker, and layout shifting as bugs with evidence, severity, acceptance criteria, and regression tests.
```

For your immediate case, the first P0 batch should probably be:

1. Remove/replace the loading progress card with stable app-shell skeleton loading.
2. Fix duplicate “All This Noise” import/de-dupe.
3. Remove the duplicate page-level search button and keep nav search canonical.
4. Prevent missing-artwork tracks from appearing in demo/marketing flows, plus add a proper fallback state.
5. Add screenshot/Playwright regression coverage for the main demo route so these failures get caught before merge.
