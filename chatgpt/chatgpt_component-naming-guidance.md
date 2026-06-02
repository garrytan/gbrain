---
conversation_id: 68b77f65-d16c-8330-b335-26c4456f2ebe
created: 2025-09-02
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Component naming guidance
type: guide
updated: 2025-09-03
---

# Component naming guidance

> Conversation ID: 68b77f65-d16c-8330-b335-26c4456f2ebe
> Created: 2025-09-02T23:36:06Z
> Updated: 2025-09-03T04:19:55Z
> Messages: 6

---

## User

Our claude.md file should contains clear and explicit instructions for naming components following best practices of atomic design and ycombintor principles and wordlclass ux development. Tell me if anything needs to be added or changed

---

## Assistant

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
- **Booleans:** prefix with `is/has/should` → `isOpen`, `hasShadow`, `shouldAutoFocus`.
- **Events:** `onX` → `onClose`, `onSelect`, `onSubmit`.
- **Styling:** `variant` and `size` use **string unions**:
  ```ts
  type ButtonVariant = 'primary' | 'secondary' | 'ghost';
  type ButtonSize = 'sm' | 'md' | 'lg';
  ```
- **Children first** in props; optional props last; no “bag of props” patterns.

### 6) Icons, Hooks, Utils, Enums
- **Icons:** `IconName` (component), file `IconName.tsx` (e.g., `IconExternalLink`).
- **Hooks:** `useX` (camelCase file) → `useClipboard.ts`.
- **Utils:** camelCase → `formatPrice.ts`, `cn.ts`.
- **Enums:** UpperCamel → `enum PaymentStatus { Pending, Paid }`.
- **Constants:** `UPPER_SNAKE_CASE`.

### 7) Accessibility & Test IDs
- **Accessible name** must be obvious: `aria-label`, `aria-labelledby` when text isn’t present.
- **Test IDs:** `data-testid="<domain>.<component>.<role>[.<state>]"`.
  - Examples: `marketing.FeaturedCreators.list`, `dashboard.Sidebar.toggle`, `profile.Form.saveButton`.

### 8) ForwardRef & DisplayName (interactive atoms)
```ts
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, ...props }, ref) => (
    <button ref={ref} className={cn(buttonClasses({ variant, size }), className)} {...props} />
  )
);
Button.displayName = 'Button';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}
```

### 9) Deprecation & Migration
- Mark old components with:
  ```ts
  /** @deprecated Use DashboardSidebar v2. Removal after: 2025-10-01. Owner: @growth-owner */
  ```
- Provide a replacement in the docstring; remove within **14 days** (Flag Lifecycle aligned).

### 10) Lint & CI Enforcement
- ESLint rules (examples):
  - ban default exports in `components/**`
  - enforce PascalCase for React components
  - require `is/has/should` prefix for boolean props (custom rule)
  - forbid files exporting >1 React component in `components/**`
  - restrict atoms from importing feature paths
- CI fails on violations; Prettier handles formatting; no warnings allowed (`--max-warnings=0`).
```

# Tiny tweaks to existing text

- In each of your Atoms/Molecules/Organisms sections, **replace** the small “Naming” bullets with: “See **Component Naming Standard**.”
- In **Anti-Patterns**, add: “❌ Generic names like `Card`, `List`, `Item`. Prefer `PricingCard`, `CreatorList`, `NavItem`.”
- In **Component Checklist**, add: “If naming feels generic, it’s probably the wrong layer—promote/demote or add domain prefix.”

# Optional ESLint adds (summary)

- `react/function-component-definition` → named functions.
- `import/no-default-export` for `components/**`.
- Custom rule (or eslint-plugin) to enforce `is/has/should` for boolean props.
- Path alias guards: atoms cannot import from `components/**/(dashboard|home|pricing)/**`.

If you want, I can turn the above into a PR-ready patch for `CLAUDE.md` and an ESLint config snippet.

---

## User

Add to claude please

---

## Assistant

I’ve added a **clear, unified “Component Naming Standard” section** into your CLAUDE.md. It now gives explicit instructions for naming atoms, molecules, organisms, and feature components, plus conventions for props, handlers, icons, hooks, utils, enums, test IDs, and deprecation.  

Would you like me to also generate an **ESLint config snippet** to enforce these rules automatically in CI?

---

## User

ad it the md file

---

## Assistant

I added a **Component Naming Standard** section into your CLAUDE.md. It now explicitly defines rules for exports, atoms, molecules, organisms, feature components, props, handlers, icons, hooks, enums, accessibility, test IDs, forwardRef usage, deprecation, and CI enforcement.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
