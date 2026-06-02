---
title: "UI audit and refactor"
type: note
created: 2025-10-28
updated: 2025-10-28
source: chatgpt-export
conversation_id: 6901063c-d13c-8327-aad2-5193c2a3befc
message_count: 4
tags: [chatgpt, import, long-form]
---
# UI audit and refactor

> Conversation ID: 6901063c-d13c-8327-aad2-5193c2a3befc
> Created: 2025-10-28T18:07:44Z
> Updated: 2025-10-28T18:11:54Z
> Messages: 4

---

## User

Write a modern world class AI prompt for claude code plan mode asking it to audit and fix our UI. I want to ensure that all components use Sharon UI primitives and support light and dark mode. We follow the openai frontend guidelines for the most part in terms of dependencies and icons etc. Tailwind 4 and next.js. Everything should be world class in accessibility and design and use proper component extraction and atomic design. There should be no left over legacy components, minimal code duplication, and no scenario where multiple components exist for the same things. Also need to ensure that the code base uses the latest version of any component (a problem that ai coding agents create because they constantly make components and then only change a couple references so the code base is fragmented In which component version it uses.) it should also ensure it follows our design system across the board and that no outliers exist. Finally things like tooltips, portals, etc and sidebars collapse/expand should all work properly. And nothing should be UI blocking. Where clerk.dev auth components are in use, they should be fully integrated Into our UI using the new clerk beta UI primitives that they released this summer to build our own components rather than using the prebuilt components.

---

## Assistant

Mr. White — here’s a drop-in, world-class prompt tailored for **Claude Code Plan** to audit and fix your UI codebase.

---

**Prompt for Claude (Code Plan mode)**

> **Objective**  
> Audit and refactor our UI so **every component** is built on **Sharon UI primitives**, supports **light/dark mode**, complies with our **OpenAI frontend guidelines** (deps, icons, patterns), and follows **atomic design** with excellent **a11y**. Eliminate legacy/duplicate components, unify to the **latest** version of each component, and ensure interactions (tooltips, portals, sidebars, etc.) function correctly and are **non-blocking**. Stack: **Next.js**, **Tailwind 4**. Auth: **Clerk** using their **beta UI primitives** (build our own; do not use prebuilt drop-ins).
>
> **Guardrails (follow exactly)**  
> - Work in a new branch: `chore/ui-sharon-migration`. Small, reviewable commits.  
> - Do not invent files/paths. Discover first, then propose diffs with exact paths.  
> - Prefer **codemods** over manual edits. No TODOs left behind.  
> - Never add new design systems or icon packs beyond what our guidelines allow.  
> - Keep UI **non-blocking**: use suspense/skeletons/optimistic updates; no modal or overlay may trap focus or block critical flows.  
>
> **Deliverables**  
> 1) **Audit Report** at `docs/ui-audit-[YYYY-MM-DD].md` with: component inventory, duplicates, legacy usage, theming gaps, a11y findings, Clerk usage map, and a remediation plan.  
> 2) **Codemods** (TS/jscodeshift or TS-Morph) under `tools/codemods/` with a README and dry-run examples.  
> 3) Refactor PR(s) that:  
>    - Migrate all UI to **Sharon** primitives.  
>    - Remove legacy/duplicate components and dead styles.  
>    - Enforce **atomic design**: tokens → primitives → components → patterns → pages.  
>    - Ensure **light/dark parity** and theming via Tailwind 4 + tokens.  
>    - Replace **Clerk prebuilt** components with **beta primitives** wrappers that look/behave like our design system.  
>    - Fix tooltips/portals/menus/sheets/sidebars (collapse/expand) with correct focus mgmt + a11y.  
> 4) **Quality gates**: a11y checks (axe), unit/integration tests, Playwright E2E for core flows, ESLint rules to prevent regressions, and Storybook stories for all primitives + composites.  
>
> **Definition of Done (acceptance checklist)**  
> - ✅ All UI imports resolve to **Sharon** (single canonical entry). No `components/*/Button*.tsx` strays; no parallel versions.  
> - ✅ Zero usages of prebuilt Clerk UI; all flows use **Clerk beta primitives** wrapped in our Sharon-styled components.  
> - ✅ Light/dark: every screen and component verified; no hard-coded colors; tokens + Tailwind 4 only.  
> - ✅ A11y: interactive elements keyboard-navigable; `aria-*` complete; focus traps fixed; color contrast ≥ WCAG AA; tooltips/menus/dialogs are in **Portals** with correct `aria` and dismissal.  
> - ✅ Sidebars collapse/expand with `aria-expanded`, persists state, no layout reflow jank, no blocking spinners.  
> - ✅ No duplicate or legacy components; deleted code removed and imports codemodded.  
> - ✅ ESLint/TS/CI/Storybook/Playwright all green; visual and a11y snapshots added.  
>
> **Repository discovery (run, then summarize before edits)**  
> - Build inventory & hotspots:  
>   - `rg -n "from ['\"]@/components|@/ui|sharon|clerk|tooltip|portal|sidebar|sheet['\"]" -g '!node_modules'`  
>   - `rg -n "(Button|Input|Tooltip|Dialog|Sheet|Sidebar|ThemeProvider)" --ts --tsx`  
>   - `rg -n "class(Name)?=.*(dark:|data-theme|aria-)"`  
>   - `rg -n "@clerk/(nextjs|elements|react)"`  
> - Generate a CSV/JSON manifest at `docs/ui-manifest.json` mapping: **ComponentName → file → import source → props → referenced tokens → first/last commit**.  
>
> **Codemods to implement**  
> 1) **Import unification**: rewrite all UI imports to the canonical Sharon entry (e.g., `@/sharon`), banning deep links.  
> 2) **Duplicate killer**: detect `Button*/Card*/Input*` siblings; keep the latest canonical version; rewrite all references; delete the rest.  
> 3) **Prop normalization**: map legacy props (`variant/size/intent/tone`) to Sharon’s prop API; enforce a single enum source.  
> 4) **Tokenization**: replace hard-coded colors/spacing/typography with **design tokens** + Tailwind 4 utilities.  
> 5) **Clerk migration**: replace `<SignIn/>/<UserButton/>/<OrganizationSwitcher/>` prebuilt components with wrappers built on **Clerk beta primitives**; ensure our theme + a11y + i18n; move logic to `features/auth/`.  
> 6) **Theming**: consolidate ThemeProvider; data-attribute or class toggle (`data-theme="dark"`); remove one-off theme hacks.  
> 7) **No-restricted-imports**: add ESLint rules to forbid legacy paths and non-approved icon/dep imports.  
>
> **A11y & UX requirements**  
> - Menus, sheets, dialogs, tooltips: rendered in **Portals**, labelled via `aria-labelledby`/`aria-describedby`, ESC to close, focus return on close, arrow-key navigation.  
> - Tooltips: **non-blocking**; show on focus and hover; never trap focus; correct `role="tooltip"`.  
> - Sidebar: reduced-motion friendly; `aria-expanded`; collapses to icons with accessible labels; persists state (localStorage) without blocking hydration.  
> - Forms: proper labels, errors, descriptions; no placeholder-as-label; announce errors via `aria-live="polite"`.  
>
> **Tailwind 4 + tokens**  
> - Centralize tokens in `tailwind.config.ts` + CSS vars (e.g., `--color-fg`, `--radius-md`).  
> - Replace ad-hoc classes with semantic utilities; ensure dark variants are via tokens, not raw hex.  
>
> **Testing & CI**  
> - **Unit**: RTL + jest-dom; snapshot states (enabled/disabled/hover/focus/dark).  
> - **A11y**: `@axe-core/playwright` against top routes and key components.  
> - **E2E (Playwright)**: auth flows (sign in/out, org switch), navigation, sidebar toggle, tooltip hover/focus, dialog open/close, theme switch.  
> - **Storybook**: per component stories + dark mode; add Chromatic/visual snapshots if available.  
> - **ESLint/Prettier**: add `no-restricted-imports` for legacy paths; rule to require tokens over hex.  
>
> **OpenAI frontend guideline alignment**  
> - Verify dependencies, icon set, patterns; remove non-approved libs; align loading states, skeletons, and empty-state patterns per our guideline doc.  
>
> **Plan & output format**  
> 1) Post **Plan** with: inventory summary, risk list, and PR breakdown.  
> 2) Propose **codemod specs** (before code) with examples of input→output.  
> 3) For each PR: show a condensed diff (file list + key hunks), test updates, and a rollback note.  
> 4) Conclude with the filled **Definition of Done** checklist and links to reports/tests/stories.  
>
> Start by running discovery, produce the **Audit Report outline**, then proceed with codemods and refactors as scoped PRs.

---

Want me to tweak any section (e.g., token naming, canonical import path, or Clerk wrapper locations) before you run it?

---

## User

I meant to use ui.shadcn.com primitives. Also ensure we use the latest from them including their new componetns:
Spinner: An indicator to show a loading state.
Kbd: Display a keyboard key or group of keys.
Button Group: A group of buttons for actions and split buttons.
Input Group: Input with icons, buttons, labels and more.
Field: One component. All your forms.
Item: Display lists of items, cards, and more.
Empty: Use this one for empty states.

We should take FULL advantage of what they offer and reference their blocks for best practices on how to combine components and build a world class dasshboard: https://ui.shadcn.com/blocks

---

## Assistant

Mr. White — here’s the revised drop-in **Claude Code Plan** prompt using **ui.shadcn.com** (latest primitives + Blocks).

---

**Prompt for Claude (Code Plan mode)**

> **Objective**  
> Audit and refactor our UI so **every component** is built on **ui.shadcn.com** primitives, supports **light/dark**, follows our **OpenAI frontend guidelines** (deps, icons, patterns), and implements **atomic design** with world-class **a11y**. Eliminate legacy/duplicate components, unify to a **single latest** version of each component, and ensure interactions (tooltips, portals, sidebars, etc.) are correct and **non-blocking**. Stack: **Next.js** + **Tailwind 4**. Auth: **Clerk**, using **Clerk beta UI primitives** to build our own—not prebuilt drop-ins.  
>
> **shadcn scope (use latest)**  
> - Ensure we use and expose: **Spinner**, **Kbd**, **Button Group**, **Input Group**, **Field** (forms), **Item** (lists/cards), **Empty** (empty states).  
> - Take full advantage of shadcn **Blocks** for patterns and a world-class dashboard (see: ui.shadcn.com/blocks).  
> - Unify all imports through a **single canonical entry** (e.g., `@/ui`) mapped to local shadcn components; no deep or duplicate paths.  
>
> **Guardrails**  
> - New branch: `chore/ui-shadcn-migration`; small, reviewable commits.  
> - Discover first, then propose exact diffs (no invented paths).  
> - Prefer **codemods** over manual edits; remove dead code; no TODOs left.  
> - Keep UI **non-blocking**: suspense/skeletons/optimistic updates; no focus traps.  
> - Don’t add unapproved deps/icon packs; align with our OpenAI frontend guidelines.  
>
> **Deliverables**  
> 1) **Audit Report** `docs/ui-audit-[YYYY-MM-DD].md`: inventory, duplicates, legacy usage, theming gaps, a11y findings, Clerk usage map, outliers vs design system, and a remediation plan referencing **Blocks** where relevant.  
> 2) **Codemods** under `tools/codemods/` (+ README, dry-run examples).  
> 3) Refactor PR(s) that:  
>    - Migrate all UI to **shadcn** primitives (latest).  
>    - Replace legacy/duplicate components and deep imports; enforce **atomic design** (tokens → primitives → components → patterns → pages).  
>    - Implement **light/dark parity** via Tailwind 4 + tokens; no hard-coded colors.  
>    - Replace **Clerk prebuilt** components with wrappers built on **Clerk beta primitives** styled like our system.  
>    - Fix tooltips/menus/dialogs/sheets/sidebars (collapse/expand) with correct focus mgmt, portals, and keyboard support.  
> 4) **Quality gates**: a11y (axe), unit/integration tests, Playwright E2E, ESLint rules to prevent regressions, and Storybook for primitives + composites (light/dark).  
>
> **Definition of Done**  
> - ✅ All UI imports resolve via `@/ui` (single source). No parallel versions (e.g., `Button*.tsx` variants).  
> - ✅ Using **latest shadcn** primitives, explicitly including: **Spinner**, **Kbd**, **Button Group**, **Input Group**, **Field**, **Item**, **Empty**; Stories for each (light/dark).  
> - ✅ **Blocks-inspired** dashboard patterns adopted (navigation, tables, forms, empty/zero states).  
> - ✅ Zero **prebuilt** Clerk components; all flows use **Clerk beta primitives** wrappers in `features/auth/` (or agreed path).  
> - ✅ Full light/dark coverage; tokens only; contrast ≥ WCAG AA.  
> - ✅ Menus/dialogs/sheets/tooltips in **Portals** with correct `aria`, ESC/blur dismiss, focus return; no UI-blocking states.  
> - ✅ No duplicates/legacy components; imports codemodded; dead code removed.  
> - ✅ ESLint/TS/CI/Storybook/Playwright all green; visual + a11y snapshots added.  
>
> **Repository discovery (run, then summarize before edits)**  
> - Inventory & hotspots:  
>   - `rg -n "from ['\"]@/components|@/ui|shadcn|clerk|tooltip|portal|sidebar|sheet['\"]" -g '!node_modules'`  
>   - `rg -n "(Button|Input|Tooltip|Dialog|Sheet|Sidebar|Spinner|Kbd|Field|Item|Empty|Button\\s*Group|Input\\s*Group|ThemeProvider)" --ts --tsx`  
>   - `rg -n "@clerk/(nextjs|elements|react)"`  
>   - `rg -n "class(Name)?=.*(dark:|data-theme|aria-)"`  
> - Emit `docs/ui-manifest.json`: **ComponentName → file → import source → props → tokens → first/last commit**.  
>
> **Codemods**  
> 1) **Import unification**: rewrite to `@/ui` canonical entry; forbid deep/shadow copies.  
> 2) **Duplicate killer**: detect `Button*/Card*/Input*/Field*/Item*`; keep canonical; rewrite refs; delete strays.  
> 3) **Prop normalization**: map legacy `variant/size/intent/tone` to shadcn primitives’ API; unify enums.  
> 4) **Tokenization**: replace raw hex/spacing/typography with design tokens + Tailwind 4 utilities.  
> 5) **Clerk migration**: swap prebuilt `<SignIn/>/<UserButton/>/<OrganizationSwitcher/>` with wrappers built on **Clerk beta primitives**; style to match ui; centralize in `features/auth/`.  
> 6) **Theming**: single ThemeProvider; `data-theme="dark"` or class toggle; remove hacks.  
> 7) **ESLint**: `no-restricted-imports` for legacy paths; rule to ban raw hex/colors outside tokens; forbid non-approved icon/dep imports.  
>
> **A11y & UX**  
> - Menus/dialogs/sheets/tooltips: **Portals**, labelled (`aria-labelledby`/`aria-describedby`), ESC to close, focus return, arrow-key navigation; tooltips show on **focus & hover**; `role="tooltip"`.  
> - Sidebar: `aria-expanded`, reduced-motion friendly, persists state (localStorage) without blocking hydration; zero layout jank.  
> - Forms via **Field**: explicit labels, descriptions, errors; no placeholder-as-label; `aria-live="polite"` for errors.  
>
> **Tailwind 4 + tokens**  
> - Centralize tokens in `tailwind.config.ts` + CSS vars (e.g., `--color-fg`, `--radius-md`); dark variants via tokens, not hex.  
>
> **Testing & CI**  
> - **Unit**: RTL + jest-dom; states (enabled/disabled/hover/focus/dark).  
> - **A11y**: `@axe-core/playwright` on key routes/components.  
> - **E2E (Playwright)**: auth flows, navigation, sidebar toggle, tooltip focus/hover, dialog open/close, theme switch, loading with **Spinner**.  
> - **Storybook**: for all primitives/composites; light/dark stories; snapshots.  
>
> **OpenAI frontend guideline alignment**  
> - Verify deps, icon set, loading/skeleton and empty-state patterns; remove non-approved libs; align patterns accordingly.  
>
> **Plan & output format**  
> 1) Post **Plan**: inventory summary, risk list, PR breakdown.  
> 2) Propose **codemod specs** (input→output examples).  
> 3) For each PR: condensed diff (file list + key hunks), tests updated, rollback note.  
> 4) Conclude with the **DoD** checklist filled and links to audit, stories, tests.  
>
> Start with discovery; produce the **Audit Report outline** (including where we’ll use specific **Blocks**), then execute codemods and refactors via scoped PRs.

---

Want me to set the canonical `@/ui` path and target folders (e.g., `app/(dash)/`, `features/auth/`, `components/`) before you run it?
