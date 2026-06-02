---
conversation_id: 69d86d12-30b8-83e8-bc6c-b061cb542871
created: 2026-04-10
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 5
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Design System Audit Plan
type: note
updated: 2026-04-11
---

# Design System Audit Plan

> Conversation ID: 69d86d12-30b8-83e8-bc6c-b061cb542871
> Created: 2026-04-10T03:22:59Z
> Updated: 2026-04-11T03:24:23Z
> Messages: 5

---

## User

audit our design system and generate a plan to consolidate it to a central design system and elinimate ui/ux inconsistencies between pages. include light mode and dark mode and all break points. and all states. be comphrensive. follow world class ux/ui practives. do not add styles not alreaddy there. just clean up and conform and consolidate. suggestions for layout improvements are welcome as well.

---

## Assistant

I’m auditing the implemented UI and codebase as the source of truth, extracting existing tokens, components, states, themes, breakpoints, and page-level patterns to build a consolidation and migration plan.

---

## Assistant

There’s no local repo mounted, so I’m grounding this in the live product surface. So far I’ve found multiple page shells, docs likely using a separate implementation, and auth needs internal follow-up.

---

## Assistant

I have enough signal now to turn this into an execution-ready consolidation program, and I’m packaging it as a report with a migration matrix for design and engineering. There are already a few concrete cleanup items to include: duplicated navigation/theme controls in docs, a likely broken support doc URL, and a marketing route resolving to a not-found state.

---

## Assistant

Mr. White, based on a live audit of Jovie’s public surfaces, the product already has good building blocks. The issue is fragmentation. Marketing, pricing/support/legal, docs, auth, public profiles, and the dashboard implied by docs/privacy are behaving like separate surface families instead of one centralized system. The main shell is reused on home, support, pricing, and legal pages, but docs use a separate shell and the public profile is much lighter, so the cleanup should focus on centralization, not redesign. citeturn839182view0turn512718view0turn512718view1turn854198view0turn512718view3turn272079view1turn534063view0

I put the full working document here: [Jovie design system consolidation plan](sandbox:/mnt/data/jovie_design_system_consolidation_plan.md)

## What I found

- **Multiple shells and repeated implementations.** The docs surface has its own search, sidebar, on-page nav, and theme control, while marketing/support/pricing/legal share a different shell. The docs pages also expose duplicated nav/theme text in extracted accessible content, which strongly suggests parallel mobile/desktop markup or hidden UI that is not fully removed from the accessibility tree. The public profile also shows repeated footer/brand labels in extracted output. citeturn854198view0turn116087view0turn116087view1turn116087view2turn512718view3

- **Route and link consistency issues need to be fixed first.** The support page’s “Getting Started” card points to a docs URL that returns 404, while the actual docs page lives at `/docs/getting-started`. The docs “Edit this page on GitHub” link also returns 404. The `link-in-bio` route is even worse: search currently presents it as a marketing landing page, but the live URL resolves to “Profile Not Found.” citeturn512718view0turn854198view1turn272079view0turn902646view0turn217923search6turn512718view2

- **Pricing/content consistency is drifting.** Search currently describes pricing as Free, Pro, and Growth with different amounts, while the live pricing page shows Free and Pro at $20/month. That is partly SEO/metadata, but it is also a design-system governance problem because page templates, structured data, and live content are not staying aligned. citeturn217923search3turn512718view1

- **CTA hierarchy and product taxonomy are inconsistent.** The live surface uses “Get Started,” “See Demo,” “Visit →,” “Send email→,” “Learn more,” “Contact Support,” “Listen,” “Command Center,” “Releases & Smart Links,” “Audience & Growth,” and “AI Assistant” across different surfaces. Those labels are not wrong individually, but they need one canonical CTA hierarchy and one terminology map. citeturn839182view0turn512718view0turn512718view1turn272079view1turn967033view1turn967033view2turn967033view3

- **The profile surface and the marketed profile modules are not clearly governed by one module contract.** The home page markets growth/tickets/tips/streams switching, tip presets, tour dates, DSP buttons, release modules, and command-center workflows. The docs describe profile customization plus audience, chat/AI, tips, analytics, and dashboard settings. The public profile page is much leaner. That gap needs one canonical set of domain components with explicit populated, empty, disabled, hidden, and not-found behavior. citeturn839182view0turn272079view2turn967033view0turn967033view1turn967033view2turn967033view3turn534063view0turn534063view3

## Consolidation plan

### 1. Freeze and inventory what already exists

Do not start by designing. Start by extracting every current production value from code and design files: colors, font sizes, weights, line-heights, spacing, radii, borders, shadows, opacity, motion, z-index, container widths, and every breakpoint constant. Then inventory every repeated component and every page template. The goal is to choose winners from what already exists and delete duplicates. A token layer is the right source-of-truth model for this, and the current W3C Design Tokens work is explicitly aimed at one interoperable source of truth across tools and code, including theming. citeturn819177search0turn891660view1

### 2. Build a central token system without changing the visual language

Create two layers only:

- **Primitive tokens:** the actual current values already in production.
- **Semantic tokens:** aliases like `surface/default`, `text/primary`, `border/subtle`, `interactive/primary`, `focus`, `danger`, `success`.

This does not add style. It centralizes style. Light and dark mode should both map to the same semantic contract, using existing production colors only. If an accessible focus or error state is missing in one surface, reuse an existing production treatment from another surface instead of inventing a new aesthetic. The theme system should cover marketing, docs, profile, auth, and product surfaces with one contract. citeturn819177search0turn891660view1turn854198view0

### 3. Unify shells first

Before rebuilding feature components, centralize the shared shell primitives:

- header
- footer
- logo lockup
- nav item
- page intro block
- primary / secondary / tertiary CTA
- text link
- content container
- section spacing
- legal/footer cluster
- docs TOC / side rail primitives
- cookie banner
- auth card

This removes the current drift between marketing, support/pricing/legal, docs, and auth. It also fixes the accessible-name duplication problem faster than waiting for a full component rewrite. WCAG’s consistency rules are directly relevant here: repeated navigation and repeated functions should be presented consistently and identified consistently. citeturn512718view0turn512718view1turn854198view0turn549875search2turn549875search3

### 4. Build one canonical component library

After shells, centralize the reusable components that already exist in the live product family:

- buttons, links, badges, pills, cards, banners, empty states, skeletons, progress indicators
- pricing plan cards and comparison rows
- legal article template and TOC
- docs sidebar/search/feedback/edit-link row
- profile hero, release card, DSP row, tip selector, tour date row
- task row, analytics stat card, chart frame, notification prompt
- inputs, selects, toggles, textareas, helper text, error text, loading states

Material’s current guidance is useful here because it treats states as part of the component system, not as page-specific exceptions. It also treats loading/progress as a first-class component family. Apple’s HIG makes the same broader point on consistency and layout adaptation across contexts. citeturn933775search0turn933775search1turn804324search2turn465149search2

### 5. Normalize light mode and dark mode

Your requirement to cover both modes is correct. The practical approach is:

- inventory every color currently used
- identify which ones already behave as background, text, border, accent, success, warning, danger
- map those to semantic roles for light and dark
- apply the same mapping to every shared component and page template
- QA every component in both modes before migration is considered complete

The docs surface already exposes a light-theme control in extracted content, which makes it clear that theme behavior is already part of the product family and should be centralized instead of handled per app. The Design Tokens spec’s stable release also explicitly calls out theming and multi-theme support as a core use case. citeturn116087view0turn819177search0

### 6. Normalize breakpoints without inventing new ones

Because you do not want new styles added, do **not** invent a fresh breakpoint system. Extract the breakpoint values already in your codebase, cluster the one-offs, and choose a canonical set from the values you already ship. Then alias every page to that set and deprecate page-specific breakpoints.

Treat these widths as a required QA matrix whether or not they all become production tokens:

- 320
- 360
- 375
- 390
- 414
- 768
- 820
- 1024
- 1280
- 1440
- 1536

The non-negotiable accessibility check is reflow and full function at 320 CSS px / 400% zoom, with no standard-content horizontal scroll. Material’s current layout guidance also centers responsive behavior on explicit window-size classes rather than ad hoc layout exceptions. citeturn891660view6turn804324search3turn804324search2

### 7. Document every state, not just default visuals

Every reusable component should have an explicit state matrix. At minimum:

- **interaction:** default, hover, focus-visible, pressed, selected/current, disabled, visited, dragged where relevant
- **form:** empty, filled, helper, valid, invalid, required, optional, read-only, disabled, submitting, success
- **data/async:** initial, loading, skeleton, partial, optimistic, success, empty, error, offline, retry, stale/refreshing
- **disclosure/navigation:** open, closed, expanded, collapsed, sticky/scrolled, current item, current section
- **Jovie-specific:**  
  - release = pre-launch, countdown, live, archived, unavailable  
  - profile = full, no bio, no release, no events, no tips, no notifications, unpublished, not found  
  - pricing/billing = free, paid, trial, current plan, feature locked, failed payment  
  - chat/AI = empty, drafting, sending, sent, failed, AI generating, AI unavailable  
  - analytics = no data, filtered, comparison on/off, export ready, export processing, export failed

Material’s current guidance explicitly treats combined and consistent interaction states as part of the system, and WCAG requires visible focus, unobscured focus, explicit labels/instructions, and text-based error identification. citeturn933775search0turn933775search2turn549875search1turn465149search0turn891660view8turn891660view9

### 8. Migrate by template family, not page by page

The migration order should be:

1. broken routes and broken links
2. tokens
3. shell primitives
4. CTA / form primitives
5. pricing/support/legal/docs templates
6. profile modules
7. dashboard/product templates
8. deprecate legacy components and raw style values

This avoids the common failure mode where teams “clean up” individual pages but leave the system fragmented underneath. The docs edit-link problem, support-to-docs 404, and `link-in-bio` mismatch are the right first fixes because they affect trust immediately. citeturn854198view1turn902646view0turn217923search6turn512718view2

## Layout improvements that stay inside the current aesthetic

These are structural improvements, not visual redesign:

- Use one page-intro anatomy across marketing/support/legal/docs: label if needed, H1, one support paragraph, primary CTA, secondary CTA.
- Normalize container widths and vertical rhythm across marketing, pricing, support, legal, and docs.
- Standardize CTA casing, arrow treatment, and icon placement.
- Use one table/comparison pattern for pricing and analytics.
- Make public profile sections truly modular with explicit show/hide/reorder rules and explicit empty/off states.
- Simplify docs chrome so one accessible nav system exists at a time.
- Standardize status communication with one empty/loading/error/success component family. citeturn839182view0turn512718view0turn512718view1turn821311search1turn854198view0turn512718view3

## Non-negotiable QA gates

- focus visible and not obscured
- pointer targets large enough and spaced safely
- no standard-content horizontal scroll at 320 CSS px / 400% zoom
- labels/instructions present before failure where possible
- errors described in text, not color alone
- repeated navigation and repeated functions named consistently
- light/dark parity across every shared component and template

Those are not cosmetic standards. They are baseline UX and accessibility requirements in WCAG 2.2. citeturn891660view2turn891660view6turn891660view7turn891660view8turn891660view9turn549875search2turn549875search3

The shortest path to visible improvement is this: fix the broken/inconsistent routes, centralize tokens, unify shell + CTA + form primitives, normalize docs accessibility and links, then migrate pricing/support/legal/profile modules onto the shared system.


**Topic:** [[chatgpt-clusters/design_ux]]
