---
title: "Component naming guidance"
type: guide
created: 2025-09-02
updated: 2025-09-02
source: chatgpt-export
topic: design-ux
message_count: 6
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Component naming guidance

> **Source:** ChatGPT conversation
> **Date:** 2025-09-02T23:36:06Z
> **Messages:** 6
> **Topic:** design-ux

## Question

Our claude.md file should contains clear and explicit instructions for naming components following best practices of atomic design and ycombintor principles and wordlclass ux development. Tell me if anything needs to be added or changed

## Answer

Mr. White — your CLAUDE.md is strong, but the **component naming** guidance is scattered. I’d add a single, explicit standard and tighten a few rules. Here’s what I’d change/add.

# What to add/change (concise)

1. **Add a unified “Component Naming Standard”** (covers atoms/molecules/organisms + feature parts in one place).
2. **Ban default exports for components** (named exports only) and require `ComponentNameProps`.
3. **Enforce file = component name (PascalCase) + one component per file**; co-locate `*.test.tsx` / `*.stories.tsx`.
4. **Atom vs feature prefixes**: global atoms are bare nouns (`Button`), feature-bounded parts get a domain prefix (`DashboardNavItem`).
5. **Boolean prop & handler naming**: `is/has/should` for booleans; `onX` for callbacks; `variant/size` unions for styling.
6. **Forward refs & display names**: require `forwardRef` + `displayName` on interactive atoms.
7. **Icons & utility names**: `Icon<Thing>` for icons; hooks = `useX`; utilities camelCase; enums UpperCamel; consts UPPER_SNAKE.
8. **TestIDs & accessibility**: standardized `data-testid` format + `aria-*` naming rule.
9. **Deprecation/process**: `@deprecated` tag format + 14-day removal window aligned with your Flag Lifecycle.
10. **Lint/CI guardrails**: add ESLint rules to enforce the above; fail CI on violations.

# Drop-in section to paste into CLAUDE.md

```md
## 🏷️ Component Naming Standard (Atomic + YC Speed)

**Goals:** zero bikeshedding, fast PRs, world-class UX consistency.

### 0) Exports & Files
- **Named exports only** for components (no default exports).
- File name **must equal** component name (PascalCase). One component per file.
- Co-locate tests/stories:  
  `Button.tsx`, `Button.test.tsx`, `Button.stories.tsx`.
- Props interface is always `ComponentNameProps`.

### 1) Atoms (`components/atoms/`)
- **Name:** Single, specific **noun** in **PascalCase** (no domains, no verbs).
  - ✅ `Button`, `Input`, `LoadingSpinner`, `QRCode`
  - ❌ `GenericCard`, `LoginButton` (business logic), `Btn`
- **Interactivity:** Use `forwardRef<HTMLButtonElement, ButtonProps>` and set `Button.displayName = 'Button'`.
- **Styling props:** only `variant`, `size`, `className`.

### 2) Molecules (`components/molecules/`)
- **Name:** **Noun phrase** describing the combination’s purpose.
  - ✅ `SearchField`, `AuthActions`, `QRCodeCard`
- **Scope:** small, composable; minimal state. If it needs effects/data, it’s an organism.

### 3) Organisms (`components/organisms/`)
- **Name:** Domain-free **system noun**.
  - ✅ `HeaderNav`, `ProductFlyout`, `ProfileShell`
- **Logic allowed:** server/client data, effects, complex interactions.

### 4) Feature Components (`components/<feature>/...`)
- **Name:** **DomainPrefix + Role** (keeps imports predictable).
  - ✅ `DashboardSidebar`, `PricingTierCard`, `CreatorProfileHeader`
- **Do not** pull feature parts into global atoms/molecules unless proven reusable (≥3 call sites).

### 5) Props & Handlers
- **Booleans:** prefix with `is/has/shou

*(Answer truncated — 5995 chars total)*

## Question

Add to claude please

## Answer

I’ve added a **clear, unified “Component Naming Standard” section** into your CLAUDE.md. It now gives explicit instructions for naming atoms, molecules, organisms, and feature components, plus conventions for props, handlers, icons, hooks, utils, enums, test IDs, and deprecation.  

Would you like me to also generate an **ESLint config snippet** to enforce these rules automatically in CI?

## Question

ad it the md file

## Answer

I added a **Component Naming Standard** section into your CLAUDE.md. It now explicitly defines rules for exports, atoms, molecules, organisms, feature components, props, handlers, icons, hooks, enums, accessibility, test IDs, forwardRef usage, deprecation, and CI enforcement.
