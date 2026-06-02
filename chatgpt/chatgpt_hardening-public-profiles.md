---
title: "Hardening Public Profiles"
type: essay
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
conversation_id: 69fe8949-5024-83e8-93fc-1fbf6bfc2380
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Hardening Public Profiles

> Conversation ID: 69fe8949-5024-83e8-93fc-1fbf6bfc2380
> Created: 2026-05-09T01:09:30Z
> Updated: 2026-05-09T01:19:02Z
> Messages: 4

---

## User

I need to harden the public profiles. The public profiles are the most important surface on our app. They're what get the most traffic. Every artist who signs up is theoretically sharing one of these profiles, and then all of their fans are going through those profiles and links every time they have music or any kind of social traffic or merch sales or anything, right? High traffic. It's important that these profiles look amazing, because they are outbound marketing or inbound marketing. They want to look good so people want them, so people are like, "Oh, what is this? Can I get my own?" You want amazing-looking profiles, and they have to be functional, and if they work, they have to not be jank.

I'm getting a little frustrated because it's been a long time that these things have just looked like shit and been jank. Now we have a decent design. I fired off a bunch of jobs. I don't know where they're at. I don't know if they need to be pushed through and dealt with or not. Basically, I have a bunch of jobs waiting to pardon these profiles and stuff, and I'm going to tell my chief of staff to work on that immediately.

What I want is a prompt from you that takes into account everything that's going on with these profiles and really hardens them, makes the profiles feel like a native iOS app. There's a menu bar at the bottom. It should function the way a menu bar functions. When I tap on one page, I see the menu bar. When I tap on another page, the menu bar disappears. You know what I mean?

Clearly, the app is not, or the profile pages have been built over six months and then repurposed and then redesigned and all this shit, and they're just a mess. I need them built to Next.js best practices, with every single page passing the Gmail test, with all of the scrolling working exactly how scrolling should work on a native mobile app. No horizontal scrolling jankiness, nothing weird, no redundant copy, no page where it says alert 17 times. Just like common sense stuff. I just need these things generally hardened, and I think there's probably some of it that's taste, but it's very little.

Can you help me figure out exactly how I should go about doing this? Give me the fucking world-class prompt that's going to harden these profiles, and I'm going to give this to my CFO, who only dispatches, and it's going to dispatch. We have a skill to handle the dispatching and stuff, so we don't have to worry about that. Give me a prompt for everything that needs to be done to harden these, and then I'll let it go and split that up into issues and triage the existing issues and stuff. Help me figure out how to make this work.

World-class now, the design is kind of there. Some of the pages in modes might be on legacy design, like a couple of pages or so, using a drawer for something where we have full pages for other things, and we should probably just move to the full pages everywhere. There's a mix of design tokens and stuff like that, and then there are some navigation things that are jank and stuff. When you tap a bell icon somewhere, something and an email subscribe pops up as an embed in something. You tap the alert button somewhere else, and it shows up as a full page. Tap it somewhere else, and it shows up as a drawer. You know what I mean? That kind of shit. You need everything to work the same way and effectively in stuff. What do we think about that, and how do I make this? How do we make this a world-class thing? 

---

## Assistant

I’ll turn this into a dispatch-ready master prompt with concrete acceptance criteria, plus a triage structure so the work can split cleanly without losing the product standard.

---

## Assistant

This should become a public-profile platform hardening epic: canonical shell, navigation model, interaction patterns, design-system layer, QA matrix, and measurable release gates.

---

## Assistant

Mr. White, the right move is a **public-profile hardening epic**, not another batch of cosmetic tickets. Standardize the profile surface around one shell, one navigation contract, one full-page flow pattern, one design-token system, and one QA matrix. In iOS terms, the bottom control should behave like a **tab bar** for top-level profile sections; Apple’s guidance frames tab bars as navigation between top-level areas, while toolbars are for contextual actions. citeturn738989search0turn738989search2

Next.js gives the right primitives for this: route layouts, metadata, optimized navigation, caching, image/font optimization, and production checks. The hardening prompt below points agents toward those primitives instead of letting them keep patching legacy components route by route. citeturn486512view0turn486512view1turn486512view2turn630242search0turn630242search1

## Give your dispatcher this prompt

```text
PUBLIC PROFILE HARDENING EPIC — JOVIE

Role:
You are the senior staff engineer, product-minded frontend lead, and mobile-web QA owner responsible for hardening Jovie’s public artist profiles. These public profiles are the highest-traffic, highest-visibility, highest-acquisition surface in the app. Treat this like production infrastructure plus premium consumer UX.

Mission:
Harden the public profile experience so every public artist profile feels like a polished native iOS app, works cleanly from high-traffic fan entry points, passes mobile/in-app-browser QA, uses modern Next.js best practices, and has no visible jank, legacy UI mismatch, inconsistent flows, redundant copy, broken scrolling, or weird navigation behavior.

Context:
- Public profiles are shared by artists and visited by fans from social links, music releases, merch links, email, Gmail, SMS, search, and other inbound traffic.
- The current profile system appears to have been built, repurposed, redesigned, and patched over time. Expect mixed legacy components, inconsistent navigation patterns, inconsistent drawers/full pages/embeds, old design tokens, duplicate copy, and route-specific hacks.
- The new visual design direction is mostly approved. Do not start a new redesign. Harden, normalize, polish, and make the implementation feel intentional.
- The priority is mobile-first. Desktop must work, but mobile is the core surface.
- “Gmail test” means every public-profile URL and deep-link URL must open cleanly from Gmail on iOS and Android, render the correct page, show correct link preview metadata where applicable, have correct viewport behavior, support back navigation, and avoid broken layouts inside in-app browsers.

Primary outcome:
A fan should be able to open any public artist profile, tap through top-level sections, subscribe to alerts, follow links, view music/merch/social sections, and return/back out without encountering any jank, horizontal scroll, redundant UI, mismatched legacy design, broken drawer, clipped bottom content, weird copy, console error, or dead end.

NON-NEGOTIABLES

1. Mobile native feel
- Treat the bottom profile navigation as a tab bar for top-level profile sections only.
- The tab bar must be visually stable, thumb-friendly, safe-area-aware, and consistent across all top-level profile routes.
- The tab bar must show on top-level profile sections and hide on secondary task flows where it would be wrong or distracting.
- No ad-hoc per-component decisions about whether the tab bar appears. Use one central route/surface config.

2. Full-page consistency
- Normalize inconsistent drawers, embeds, and modals.
- Alerts, email subscribe, notification signup, and similar fan task flows should use a single canonical full-page pattern unless a clearly documented exception exists.
- Remove legacy drawer/embed variants for the same task. One action should not appear as a drawer in one place, a full page elsewhere, and an embedded card somewhere else.

3. No scrolling jank
- No horizontal page scrolling at any mobile width.
- No content clipped behind the bottom tab bar or iOS home indicator.
- No nested vertical scroll containers unless intentionally required and documented.
- Long artist names, URLs, handles, buttons, embeds, media cards, and carousels must not break layout.
- Keyboard interactions on email/subscribe forms must not obscure the active input or submit button.

4. No legacy visual mismatch
- Audit and remove legacy profile components, old drawer patterns, old typography, old spacing, old color tokens, and one-off styles.
- Use the current design system/tokens consistently.
- Preserve the approved design direction while tightening spacing, touch targets, layout rhythm, copy, loading states, empty states, and error states.

5. No redundant or embarrassing copy
- Remove repeated words, repeated section labels, duplicate “alert” language, placeholder copy, awkward helper text, and conflicting CTA names.
- A fan should never see “alert” or any other term repeated mechanically across a small surface.
- Copy should be short, clear, consumer-grade, and consistent across all variants.

6. Next.js best practices
- Use current Next.js App Router conventions where the repo supports them.
- Use layouts/templates for shared profile shell behavior.
- Use server components for data where appropriate and client components only for interactive UI.
- Use `next/link` for internal navigation except when imperative routing is truly required.
- Use Next metadata APIs for profile titles, descriptions, canonical URLs, Open Graph, and Twitter/X cards.
- Use `next/image` or the project’s approved image abstraction for artist images, cover art, avatars, and share imagery.
- Use appropriate caching/revalidation for public profile data. Public pages must be fast and resilient.
- Avoid leaking private/internal data into public routes.

7. Accessibility and tap quality
- All controls must have accessible names.
- Active tab state must be exposed correctly.
- Focus states must exist.
- Touch targets must be large enough and spaced properly.
- Forms must have labels, validation messages, loading states, success states, and error states.
- External links must be understandable to screen readers.

8. High-traffic reliability
- No console errors.
- No hydration warnings.
- No broken image states.
- No unhandled promise states.
- No layout shifts from late-loading images, embeds, or fonts.
- Graceful fallback for missing artist image, missing bio, missing links, no music, no merch, no socials, unpublished sections, invalid URLs, and slow network.

PHASE 0 — DISCOVERY / INVENTORY

Before writing implementation code, produce a route and component inventory.

Create `public-profile-hardening-audit.md` with:

1. Route matrix
For every public-profile route and deep-linkable state, document:
- Path pattern
- Top-level section or secondary task flow
- Current component(s)
- Current navigation behavior
- Whether bottom tab bar should show
- Current drawer/modal/embed/full-page behavior
- Expected canonical behavior
- Scroll container behavior
- Metadata/link-preview status
- Known visual/copy issues
- Test coverage status
- Priority: P0, P1, P2

2. Component duplication map
Identify duplicate or near-duplicate components for:
- Profile shell
- Bottom navigation
- Alert/subscribe/email capture
- Link buttons
- Music cards/embeds
- Merch/social blocks
- Drawers/modals/sheets
- Empty states
- Error states

3. Legacy cleanup list
Identify old components, styles, drawers, tokens, and route-specific hacks that should be removed after migration.

4. Risk list
Call out risky areas before implementation:
- Routes with unclear product intent
- Places where data model assumptions are unclear
- Third-party embeds that may cause layout/scroll issues
- Any analytics/events that could break
- Any public SEO/share behavior that may regress

PHASE 1 — CANONICAL UX CONTRACT

Create or update a repo document named `public-profile-surface-spec.md`.

It must define:

1. Route categories
- Top-level profile section: appears in bottom tab bar.
- Secondary task flow: full-page route, bottom tab bar hidden.
- External action: opens outbound destination with tracking and safe fallback.
- System/utility state: loading, empty, error, unavailable.

2. Bottom tab bar contract
- Exactly which routes show the tab bar.
- Exactly which routes hide it.
- How active state is determined.
- How the tab bar handles direct page load, refresh, deep link, and browser back.
- How content padding accounts for tab bar height and safe area.
- How the tab bar behaves on desktop/tablet.
- How many tabs are allowed before overflow or redesign is required.

3. Navigation contract
- Top-level sections navigate using route changes, not local fake-tab state.
- Secondary flows use full-page routes.
- Back behavior must be predictable:
  - From a secondary flow, back returns to the prior profile context when possible.
  - Direct entry to a secondary flow has a clear close/back affordance to the profile root or parent section.
- No route should rely on drawer state as the only way to access content.
- No user should get trapped in an overlay, embedded form, or dead-end state.

4. Alert/subscribe contract
- One canonical CTA label.
- One canonical destination.
- One canonical full-page UI pattern.
- One canonical success state.
- One canonical error state.
- One canonical analytics event set.
- No duplicate drawer/embed variants unless explicitly justified and approved.

5. Copy contract
- Approved labels for tabs, CTAs, helper text, empty states, validation errors, and success messages.
- Rules for truncation and wrapping.
- Rules for missing/empty artist data.

PHASE 2 — IMPLEMENTATION HARDENING

Implement the canonical architecture.

1. Profile shell
Create or consolidate a single public profile shell responsible for:
- Profile layout
- Safe-area handling
- Bottom tab bar placement
- Top-level section rendering
- Shared background/spacing
- Scroll behavior
- Loading/empty/error boundaries
- Metadata integration where appropriate

2. Central route config
Create a single source of truth for public profile routes, including:
- Route key
- Path builder
- Label
- Icon
- Top-level vs secondary
- Bottom tab bar visibility
- Active tab mapping
- Metadata behavior
- Analytics surface name

No scattered `if pathname.includes(...)` logic unless there is no better option and it is documented.

3. Bottom tab bar
Build one canonical bottom tab bar:
- Fixed or sticky according to the shell spec.
- Safe-area-aware.
- Uses current design tokens.
- Uses accessible labels.
- Shows correct active state on direct load, refresh, and navigation.
- Does not reflow or flicker during route transitions.
- Does not cover page content.
- Hides on canonical secondary task flows.
- Handles small screens without horizontal overflow.

4. Full-page task flows
Migrate alert/subscribe/email capture and similar profile task flows to full-page routes:
- Remove drawer/embed variants.
- Use one shared form component or flow component.
- Include loading, validating, submitting, success, error, and retry states.
- Make keyboard behavior correct on iOS and Android.
- Make direct links to the task flow work.
- Make back/close behavior correct.

5. Design-token cleanup
- Replace one-off colors, spacing, typography, borders, shadows, radii, and z-indexes with current tokens.
- Remove legacy tokens where safe.
- Use clear z-index layering for shell, tab bar, overlays, toasts, and media.
- Avoid magic pixel values except documented shell constants like tab bar height.

6. Layout and scroll hardening
- Use one intentional vertical scroll model.
- Eliminate body/page horizontal overflow.
- Avoid `width: 100vw` on inner content unless mathematically safe.
- Add `min-width: 0`, `max-width: 100%`, wrapping, truncation, and responsive embed constraints where needed.
- Make all media, embeds, buttons, cards, and carousels responsive.
- Use dynamic viewport units/safe-area padding where appropriate.
- Account for bottom tab bar height in page padding.
- Verify no bottom CTA/input is hidden behind browser chrome, tab bar, or home indicator.

7. Metadata and share hardening
Every public profile and important deep-link route must have:
- Correct `<title>`
- Correct meta description
- Canonical URL
- Open Graph title/description/image
- Twitter/X card metadata where supported
- Absolute image URLs where required
- Fallback share image
- Correct behavior for unpublished/private/missing profiles
- No duplicate/conflicting metadata tags

8. Image/media hardening
- Use optimized image handling.
- Define width/height/aspect ratios to avoid layout shift.
- Add real fallbacks for missing artist images and broken remote images.
- Prevent cover art, avatars, embeds, and link previews from overflowing.
- Lazy-load non-critical media where appropriate.
- Prioritize above-the-fold hero/artist imagery where appropriate.

9. Performance hardening
- Reduce unnecessary client JS.
- Keep interactive components isolated.
- Remove dead legacy components after migration.
- Avoid blocking third-party scripts.
- Ensure profile home and top-level sections load fast on mobile.
- Add or preserve caching/revalidation appropriate for public profile data.
- Add lightweight production monitoring for route-level performance and errors if not already present.

10. Security/privacy hardening
- Public profiles must not expose private artist/account fields.
- Sanitize or safely render artist-provided text.
- External links must be validated/sanitized.
- Use safe `target`/`rel` behavior where links open new tabs.
- Review CSP/security headers if public profile pages embed third-party content.
- Ensure unpublished/private profiles produce intentional responses and metadata.

PHASE 3 — QA MATRIX

Create automated and manual QA coverage.

Automated tests must cover:

1. Route rendering
- Every route in the route matrix renders without console errors.
- Every route has the expected bottom tab bar visibility.
- Active tab state is correct for each top-level route.
- Secondary task flows hide the tab bar.
- Direct deep links work.

2. Mobile viewport coverage
At minimum test:
- iPhone SE width
- iPhone 12/13/14-style width
- iPhone Pro Max-style width
- Pixel/Android common width
- Tablet-ish breakpoint
- Desktop

3. No horizontal overflow
Add a test similar to:
- `document.documentElement.scrollWidth <= window.innerWidth`
- Check after initial load, after route navigation, after opening forms, after focusing inputs, after loading images/embeds, and after long-content fixtures.

4. Scroll behavior
- Page scrolls vertically as expected.
- No nested scroll trap.
- Last item is reachable above tab bar/home indicator.
- Back/forward does not create weird scroll jumps beyond acceptable browser behavior.

5. Forms
- Email/subscribe/alert form validates.
- Submit loading state works.
- Success state works.
- Error/retry state works.
- Keyboard focus behavior works in mobile emulation.

6. Metadata
- Profile routes produce expected title, description, canonical, OG, Twitter/X metadata.
- Missing data falls back cleanly.
- No duplicate/conflicting metadata tags.

7. Accessibility
- No obvious automated accessibility failures.
- Buttons/links have accessible names.
- Focus states are visible.
- Tab bar exposes active state.
- Form fields have labels and errors.

8. Copy regression
- No repeated placeholder strings.
- No obvious duplicate CTA clusters.
- No temporary copy.
- No repeated “alert”/“alerts” clusters caused by component duplication.

Manual QA must cover:

1. Real-device mobile
- iPhone Safari
- Android Chrome
- At least one small phone
- At least one large phone

2. Gmail test
For representative public profile URLs and secondary task-flow URLs:
- Send/open link from Gmail on iOS.
- Send/open link from Gmail on Android.
- Confirm link preview title/image/description where Gmail exposes a preview.
- Tap through to the profile.
- Confirm first paint and layout are correct.
- Confirm bottom tab bar behavior.
- Confirm back returns cleanly.
- Confirm subscribe/alert flow works.
- Confirm keyboard does not cover fields/submit.
- Confirm no horizontal scroll.

3. Social/in-app-browser smoke test
Where practical, test profile links opened from:
- Instagram/TikTok-style in-app browser
- X/Twitter-style in-app browser
- SMS/iMessage preview
- Slack/Discord-style preview if relevant

4. Content fixtures
Test with artists/profiles that have:
- No avatar/cover image
- Very long artist name
- Very long bio
- Many links
- One link
- No links
- No music
- Many music items
- Merch enabled
- Merch disabled
- Alerts enabled
- Alerts disabled
- Broken remote image
- Invalid external URL
- Unpublished/private profile

PHASE 4 — ACCEPTANCE CRITERIA

Do not mark this epic complete until all are true:

Product/UX:
- All public profile top-level sections share one consistent shell.
- Bottom tab bar appears only where the spec says it appears.
- Bottom tab bar hides only where the spec says it hides.
- Alert/subscribe/email capture uses one canonical full-page pattern.
- No route uses a legacy drawer/embed for the same canonical task.
- No visible legacy design mismatch remains on public profile routes.
- No redundant or placeholder copy remains.
- Empty, loading, success, and error states look intentional.

Mobile/layout:
- Zero horizontal page scroll on tested devices.
- No clipped content behind bottom tab bar, browser chrome, keyboard, or home indicator.
- No broken long-name/long-link layouts.
- No scroll traps.
- Forms are usable with mobile keyboard open.

Technical:
- Typecheck passes.
- Lint passes.
- Relevant unit/component tests pass.
- E2E/mobile tests pass.
- No console errors or hydration warnings in tested flows.
- Dead legacy components are removed or clearly isolated for future removal.
- Route config and surface spec are committed.

Performance:
- Public profile home and top-level routes meet agreed Lighthouse/performance budgets on mobile.
- Core Web Vitals targets are treated as release gates or monitored budgets:
  - LCP <= 2.5s at p75
  - INP <= 200ms at p75
  - CLS <= 0.1 at p75
- No avoidable layout shift from images, embeds, fonts, or tab bar transitions.
- No unnecessary client-side bundle bloat from profile shell changes.

Share/SEO:
- Profile URLs have correct metadata.
- OG/Twitter images work.
- Canonical URLs are correct.
- Gmail/mobile link opening works.
- Unpublished/private/missing profiles behave intentionally.

Evidence required:
- Route matrix before/after.
- PR summary mapping changes to the spec.
- Screenshots for representative routes at mobile sizes.
- At least one short screen recording of mobile navigation through profile home, top-level tabs, alert/subscribe flow, back navigation, and external link tap.
- Test output.
- List of removed legacy components/patterns.
- Known remaining issues with explicit priority and owner.

ISSUE SPLITTING INSTRUCTIONS

Split this into issues in this order:

1. Public profile audit + route/component inventory.
2. Public profile surface spec + canonical UX contract.
3. Shared profile shell + central route config.
4. Bottom tab bar implementation and route visibility rules.
5. Alert/subscribe/email capture migration to full-page canonical flow.
6. Scroll, viewport, safe-area, and no-horizontal-overflow hardening.
7. Design-token and legacy component cleanup.
8. Metadata, OG image, canonical URL, and Gmail/link-preview hardening.
9. Mobile E2E, accessibility, and copy-regression tests.
10. Performance, image/media optimization, and production monitoring.
11. Final QA pass, screenshots, screen recordings, and release checklist.

For each issue include:
- Scope
- Out of scope
- Files likely involved
- Acceptance criteria
- Test plan
- Screenshots/videos required
- Dependencies
- Rollback risk

TRIAGE INSTRUCTIONS FOR EXISTING ISSUES/JOBS

Before creating new work, inspect existing public-profile jobs/issues/PRs:
- Link duplicates into this epic.
- Preserve useful work.
- Close or supersede stale jobs that conflict with the canonical spec.
- Re-label everything by workstream.
- Do not allow separate agents to independently invent navigation or subscribe-flow behavior.
- All agents must reference `public-profile-surface-spec.md`.

OPERATING PRINCIPLE

This is complete when the profiles feel boringly solid: beautiful, fast, consistent, touch-friendly, shareable, and impossible to embarrass the company under real fan traffic.
```

## How I’d run it

Make the dispatcher create **one master epic** and force every existing public-profile job into that epic. The first deliverable should be the route/component inventory, because otherwise multiple agents will keep fixing symptoms and preserving contradictions.

I would make these the first three workstreams: **profile shell + route config**, **canonical alert/subscribe full-page flow**, and **scroll/viewport hardening**. Those three will eliminate most of the visible jank. Metadata/link previews, performance budgets, and E2E coverage come immediately after because these profiles are an acquisition surface, not an internal app screen.

The QA bar should be measurable. Use Playwright for mobile/device emulation, because it can emulate device viewport, user agent, screen size, and touch behavior. Use Lighthouse/Lighthouse CI for regression prevention across performance, accessibility, SEO, and best-practice audits. citeturn486512view7turn486512view6

For mobile polish, make safe areas and overflow explicit acceptance criteria. CSS safe-area environment variables are meant to keep content visible around notches, rounded corners, toolbars, and dynamic keyboards, and `overflow-x: clip`/horizontal overflow handling should be used deliberately to prevent sideways page scroll. citeturn466622view0turn466622view1

For performance, use Core Web Vitals as the budget language: LCP 2.5s, INP 200ms, CLS 0.1, measured at the 75th percentile across mobile and desktop. citeturn976997view0

For accessibility, make every tap target and form control pass basic mobile standards. WCAG 2.2’s minimum pointer target size is 24×24 CSS pixels with documented exceptions, and profile tabs/forms/links should comfortably exceed that in practice. citeturn486512view8
