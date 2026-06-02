---
conversation_id: 69def555-e490-83e8-acbb-0d1a92cd1826
created: 2026-04-15
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 5
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Prelaunch Repo Testing
type: guide
updated: 2026-04-15
---

# Prelaunch Repo Testing

**Related:** [[business_startup]]

> Conversation ID: 69def555-e490-83e8-acbb-0d1a92cd1826
> Created: 2026-04-15T02:17:58Z
> Updated: 2026-04-15T02:43:20Z
> Messages: 5

---

## User

I want a prompt that can run the /qa exhastive skill from gstack across my whole repo. ill run it in conductor with codex and gpt 5.4. i can set plan more or any reasoning level you recommend. 
it neds to work through the whole app and make sure its rock solid. it shoudl chaos test everything to the extreme trying to break it and then find and fix.

when it finds things it should fix them and the /qa them to confirm no issues post fix, then /review and then /ship and then continue working.

it should keep doing this shipping small slices of fixes til the whole repo has been tested to the extreme.

this is a prelaunch cehck. and i want to make sure its solid. 
COre concerns are the appearnaece of slwoness (not just is it actually slow, but does it look slow because of loader mismatch, poor hydrations etc. layoushift not just on load but also between naviation, between states and hovers, clicks text inputs errors, etc, anything that changes the page and causes unexpected layout shifting. 


---

## User

also perceived jankiness. and then flat out console errors, error screens, error states like Server error etc, text that cant be read, things that look fine until you hit a certain breakpoint, or light mode/ dark mode issues. area where an optimistic update or chache invalidation is needed, anything that would make you loose trust in the platform.
famous artists are going to use this to drive ALL of their revenue generating traffic for ticketmaster sales, streams, and merch sales. it has to be trustworthy and stable.

the core improtance is what the user SEES and feels. security is not a concern here. DX is not a concern here. This is about the users perception that this is "SOLID". 


---

## Assistant

I’m checking the current Conductor and GStack conventions so the prompt fits your tooling and run style exactly. Then I’ll give you a production-ready prompt centered on perceived solidity, with an iterative fix, verify, review, and ship loop.

---

## Assistant

I’ve confirmed `/qa --exhaustive` already does real-browser find, fix, regression-test, and re-verify work, so the prompt should mainly sharpen its quality bar and force small slice loops. I’m also tuning the run settings around high or xhigh reasoning for this long, adversarial repo-wide pass.

---

## Assistant

Mr. White, run GPT-5.4 with plan-more on and reasoning=`high`. GPT-5.4 is OpenAI’s better default when the workflow mixes coding and planning, it supports `xhigh`, and OpenAI’s current guidance for long-horizon agents is to start at `medium` or `high` with a strong completion contract before turning effort up further. I’d reserve `xhigh` for the conductor only if the run starts missing second-order UX failures or losing coverage discipline. citeturn366944view2turn366944view4turn373583view0

This prompt forces full-app coverage because gstack’s `/qa` becomes diff-aware on a feature branch when no URL is given, while providing a URL switches it to full mode that systematically explores reachable pages. The exhaustive tier is the one that fixes cosmetic and low-severity issues too, with one atomic commit per fix, re-test, and regression-test steps in the loop. gstack’s docs also position `/review` as the production-minded review pass and `/ship` as the release step. citeturn306034view0turn306034view1turn306034view2turn306034view3turn232682view0

Paste this into Conductor:

```text
You are running a repo-wide prelaunch trust-hardening campaign.

Mission
Make this app feel SOLID to end users. Optimize for what users see, feel, and trust. Security is out of scope unless it creates a user-visible failure. DX is out of scope unless it causes user-visible instability or blocks a necessary fix.

Operating context
- Base URL: APP_URL
- Base branch: main
- Auth / seed accounts / test users: AUTH_NOTES
- This is whole-app coverage. Do not stay diff-scoped.
- Use gstack skills directly.
- Use /qa, not /qa-only.
- Ship in small atomic slices.

Critical standard
This product must feel trustworthy enough for famous artists to send revenue-generating traffic through it for ticket sales, streams, merch, and outbound conversions. Treat every user-visible trust leak as important.

What matters most
Prioritize perceived solidity over internal neatness.

Hunt aggressively for:
- perceived slowness
- perceived jankiness
- layout shift on load, after hydration, during navigation, on hover, on click, on focus, while typing, when validation appears, when toasts appear, when accordions expand, when modals open, when tabs switch, when lists refresh, and after optimistic updates
- skeleton / loader / final-content dimension mismatch
- hydration mismatches, flashes, and client/server render disagreement
- theme flashes and light-mode / dark-mode inconsistencies
- stale UI after mutations, missing optimistic updates, bad cache invalidation, and state that looks wrong until refresh
- console errors, error boundaries, blank states, “Server error” pages, failed fetch states, and silent broken interactions
- text that cannot be read, clipped text, truncation, overflow, broken contrast, overlapping elements, missing focus visibility, tiny hit targets, broken disabled/submitting states
- issues that only appear at specific breakpoints, zoom levels, viewport sizes, or after repeated interactions
- anything that makes a user lose trust in the platform

Perceived slowness includes cases where the app is technically fast but LOOKS unstable:
- the loader appears too late
- the loader does not match the final layout
- content pops into place
- buttons feel dead before feedback appears
- navigation feels frozen
- scroll position jumps
- hover/focus/pressed states feel inconsistent
- input latency or validation timing feels awkward
- state changes look uncertain or glitchy

Execution rules
1. Force full-app coverage.
   - Do not limit work to the branch diff.
   - Build and maintain a coverage ledger of every meaningful user-visible surface:
     routes, modals, drawers, sheets, tabs, menus, forms, tables/lists, detail views, empty states, loading states, error states, success states, onboarding, auth, settings, search, and all revenue-critical outbound flows.
   - Discover the app map first, then keep updating the ledger as you find hidden surfaces.

2. Work slice by slice.
   Break the app into small user-visible slices and finish each slice completely before moving on.
   Suggested order:
   - landing / home / global navigation
   - auth / session / onboarding
   - discovery / search / list pages
   - detail pages / artist pages / media pages
   - outbound revenue CTAs and attribution-critical flows
   - merch / ticket / stream funnels
   - forms / settings / profile editing
   - dashboards / saved state / account surfaces
   - empty / loading / error / offline-ish states
   - theme coverage
   - breakpoint and responsive passes

3. For each slice, run a hostile-but-realistic QA loop.
   Invoke /qa --exhaustive against APP_URL with explicit focus on the current slice.
   Test like a skeptical power user trying to break trust, including:
   - repeated rapid clicks
   - double submit attempts
   - back / forward navigation
   - navigating away mid-load and coming back
   - refresh during pending UI states
   - invalid, empty, overlong, weirdly formatted, and boundary-case inputs
   - resizing across breakpoints repeatedly
   - mobile, tablet, desktop, and awkward in-between widths
   - light mode and dark mode
   - hover, focus, active, pressed, disabled, loading, success, and error states
   - long text, short text, zero-state, one-item, many-item, and overflow cases
   - deep links into internal pages
   - repeated open/close of dialogs, menus, drawers, and popovers
   - stale-state checks after mutations
   - optimistic update checks and rollback behavior
   - scroll continuity and scroll-jump checks
   - client-side navigation, not just fresh page loads

4. Fix what /qa finds immediately.
   For every fixable issue:
   - make the smallest correct source change
   - keep fixes atomic
   - re-run /qa on the affected route/state plus adjacent flows to confirm the issue is truly gone and no regression was introduced
   - add regression tests when appropriate and consistent with the repo’s existing test style
   - do not widen scope into unrelated refactors

5. After each slice is clean:
   - run /review
   - fix any review findings that affect user-visible stability, correctness, runtime reliability, or realistic regression risk
   - run /ship
   - then continue to the next slice immediately

6. Do not declare success early.
   Passing tests is not enough.
   One clean pass is not enough.
   Continue until every meaningful user-visible surface in the repo is covered.

Severity rules for this run
- Critical:
  broken revenue path, blank screen, crash, broken auth/session, severe mobile breakage, unreadable text, visible hydration failure, hard console/runtime failure in a core flow, major layout shift or jank in a core journey
- High:
  obvious perceived slowness, unstable loaders, stale optimistic state, broken cache invalidation, broken breakpoint/theme, clipped controls, confusing validation or error handling, console errors during normal use, scroll jumps, repeated-state bugs
- Medium:
  visible roughness that weakens trust, smaller CLS/jank, inconsistent empty/loading/error states, awkward hover/focus/pressed behavior, alignment/wrapping/truncation issues
- Low:
  cosmetic user-visible issues that still reduce polish or trust

Non-negotiable checks on every slice
- no visible hydration mismatch
- no obvious layout shift during the tested flow
- no console errors during normal use
- no unreadable or clipped text
- no broken loading / empty / error / success state
- no broken responsive layout at the tested breakpoints
- no obvious theme mismatch
- no stale or misleading post-mutation UI
- no dead-feeling interactive control without immediate feedback
- no trust-eroding inconsistency between what the UI promises and what it does

Review discipline
- Keep a running ledger with:
  slice
  routes/surfaces covered
  issues found
  fixes shipped
  re-QA result
  /review result
  /ship result
  remaining risks or deferrals
- After each shipped slice, write a short note on exactly what user-visible trust problems were removed.
- Any deferred item must include proof it is outside repo control or blocked by an external dependency.

Stopping condition
Only stop when:
- the whole app has been covered, not just the changed files
- every reproducible in-repo user-visible issue found in covered surfaces has been fixed, verified, reviewed, and shipped, or explicitly deferred with evidence
- the final report includes:
  - coverage map
  - shipped slices
  - deferred items
  - remaining trust risks
  - top 5 surfaces still most likely to hide perceived-jank bugs

Do the work. Keep shipping small slices until the repo-wide prelaunch trust-hardening pass is complete.
```

Optional harder variant: add one line near the end — `On any slice that still feels visually unstable after /qa, run /design-review before /ship.` gstack’s docs describe `/design-review` as a live-site visual audit + fix loop, which fits your “feels solid” bar well. citeturn232682view0


**Topic:** [[chatgpt-clusters/business_startup]]
