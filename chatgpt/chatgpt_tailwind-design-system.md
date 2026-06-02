---
title: "Tailwind Design System"
type: guide
created: 2026-02-01
updated: 2026-02-01
source: chatgpt-export
conversation_id: 697fc8d1-060c-8325-9fb7-63bb94e20c1b
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Tailwind Design System

> Conversation ID: 697fc8d1-060c-8325-9fb7-63bb94e20c1b
> Created: 2026-02-01T21:42:50Z
> Updated: 2026-02-01T22:23:45Z
> Messages: 4

---

## User

Explain how to build a design system in tailwind

---

## Assistant

Mr. White, here’s a practical way to build a real design system **using Tailwind as the delivery mechanism** (tokens → components → documentation), not just a pile of utility classes.

## 1) Start with tokens (your system’s source of truth)
Define the “non-negotiables” once: color, type scale, spacing, radii, shadows, motion, z-index. These become your **Tailwind theme**.

**Tailwind config (tokens):**
```js
// tailwind.config.js
export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,html}"],
  theme: {
    extend: {
      colors: {
        // Use semantic names, not “blue-500”
        bg: {
          DEFAULT: "hsl(var(--bg))",
          subtle: "hsl(var(--bg-subtle))",
        },
        fg: {
          DEFAULT: "hsl(var(--fg))",
          muted: "hsl(var(--fg-muted))",
        },
        brand: {
          DEFAULT: "hsl(var(--brand))",
          fg: "hsl(var(--brand-fg))",
        },
        border: "hsl(var(--border))",
        danger: { DEFAULT: "hsl(var(--danger))", fg: "hsl(var(--danger-fg))" },
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
      },
      spacing: {
        // optional: unify layout rhythm
        18: "4.5rem",
        22: "5.5rem",
      },
    },
  },
  plugins: [],
};
```

**CSS variables (themes + dark mode):**
```css
/* app.css */
:root {
  --bg: 0 0% 100%;
  --bg-subtle: 210 40% 98%;
  --fg: 222 47% 11%;
  --fg-muted: 215 16% 47%;
  --brand: 222 89% 54%;
  --brand-fg: 0 0% 100%;
  --border: 214 32% 91%;
  --danger: 0 84% 60%;
  --danger-fg: 0 0% 100%;

  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;

  --shadow-sm: 0 1px 2px hsl(222 47% 11% / 0.08);
  --shadow-md: 0 8px 20px hsl(222 47% 11% / 0.12);
}

.dark {
  --bg: 222 47% 11%;
  --bg-subtle: 223 47% 13%;
  --fg: 210 40% 98%;
  --fg-muted: 215 20% 65%;
  --brand: 217 91% 60%;
  --brand-fg: 222 47% 11%;
  --border: 217 32% 25%;
}
```

**Why semantic tokens?** Because “brand / danger / border / fg-muted” scales across products and themes. “blue-500” doesn’t.

---

## 2) Define foundations: layout + typography rules
Create a small set of “foundation decisions”:
- container widths + gutters
- spacing rhythm (4px or 8px scale)
- typography scale (e.g., 12/14/16/18/20/24/30/36)
- icon sizing rules
- focus styles (accessibility)

In Tailwind, use:
- `prose` (typography plugin) for long-form content
- consistent `leading-*`, `tracking-*`, `text-*` choices
- focus ring utilities standardized (see components section)

---

## 3) Build components as *APIs*, not class soup
A design system is reusable **behavior + styling**. Tailwind is great, but you want *named components* with variants.

### Option A (recommended): component wrapper + variant helper
If you’re in React, use a “variant” pattern (often done with a helper like `cva`, but you can do it manually).

**Button example (variant-based):**
```tsx
// Button.tsx
const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium " +
  "transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand " +
  "disabled:opacity-50 disabled:pointer-events-none";

const variants = {
  solid: "bg-brand text-brand-fg hover:opacity-90 shadow-sm",
  outline: "border border-border bg-transparent hover:bg-bg-subtle",
  ghost: "bg-transparent hover:bg-bg-subtle",
};

const sizes = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

export function Button({
  variant = "solid",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}) {
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
```

**Rule:** Consumers should pick *variants* (solid/outline/ghost) and *sizes*, not re-invent styling.

### Option B: Tailwind `@layer components` for pure CSS components
Good when you want HTML-first components.

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer components {
  .btn {
    @apply inline-flex items-center justify-center gap-2 rounded-md font-medium transition
           focus:outline-none focus-visible:ring-2 focus-visible:ring-brand
           disabled:opacity-50 disabled:pointer-events-none;
  }
  .btn-solid { @apply bg-brand text-brand-fg hover:opacity-90 shadow-sm; }
  .btn-outline { @apply border border-border hover:bg-bg-subtle; }
  .btn-md { @apply h-10 px-4 text-sm; }
}
```

**Rule:** Keep these minimal; don’t recreate Bootstrap. Build only what your product actually uses.

---

## 4) Standardize states + interactions
For every interactive component, define:
- hover/active
- focus-visible
- disabled
- loading
- error / invalid
- dark mode behavior

In Tailwind, consistently use:
- `focus-visible:*` (avoid rings on mouse click)
- `aria-*` or `data-*` attributes for state styling (clean for components)

Example:
```html
<input
  class="h-10 w-full rounded-md border border-border bg-bg px-3
         focus-visible:ring-2 focus-visible:ring-brand
         aria-invalid:border-danger aria-invalid:focus-visible:ring-danger"
/>
```

---

## 5) Decide your composition model: primitives → composites
A maintainable design system usually has layers:
- **Primitives:** Button, Input, Label, Text, Stack, Grid, Card
- **Patterns:** Modal, Dropdown, Toast, Table, FormField
- **Templates:** Page layouts (rarely in the shared library unless you have multiple apps)

Keep primitives **boring** and composable.

---

## 6) Governance: rules that prevent design drift
You need enforcement, not hope:
- **Linting:** disallow arbitrary values except in escape hatches (`[--x:...]`), or limit via code review
- **Token-only rule:** colors must be semantic tokens (no random hex in components)
- **Deprecation policy:** how you rename variants without breaking apps
- **Contribution checklist:** accessibility, responsive behavior, dark mode, tests

---

## 7) Documentation + examples (so people actually use it)
Minimum docs per component:
- purpose + when to use
- variants + sizes
- do/don’t
- accessibility notes (keyboard, ARIA)
- examples + code snippets

If you’re in React, Storybook is common; otherwise a simple docs site works. The key is **searchable examples**.

---

## 8) Release it like a product
Treat the system as versioned software:
- package it (`@yourorg/ui`, `@yourorg/tokens`)
- semantic versioning
- changelog
- CI checks (typecheck, visual snapshots if you can)

---

### A sane starting checklist (do this first)
1. Semantic color tokens via CSS variables + Tailwind theme mapping  
2. Button + Input + Text + Card with variants and states  
3. A single “FormField” pattern (label + help + error)  
4. Docs page for each component with copy/paste examples  

If you tell me your stack (React/Next? Vue? plain HTML?) and whether you need multi-brand theming, I’ll give you a concrete folder structure and an initial token set + 8–10 starter components that cover most apps.

---

## User

Next.js turbo pack we use radix primitives where possible Lucifer react icons tailwind 4 clerk tanstack query virtual table and pacer drizzle kit on neon serverless with http driver turbo repo vercel deployed GitHub actions for ci 

---

## Assistant

Mr. White — with your stack (entity["company","Next.js","react framework by vercel"] + entity["company","Turbopack","next.js bundler"], entity["organization","Radix UI","react primitives library"], entity["company","Tailwind CSS","utility css framework v4"], entity["company","Clerk","authentication platform"], entity["company","TanStack Query","react query library"], entity["company","TanStack Table","react table library"] + entity["company","TanStack Virtual","virtualization library"], entity["company","TanStack Pacer","timing utilities library"], entity["company","Drizzle ORM","typescript orm"] + entity["company","Neon","serverless postgres platform"], entity["company","Vercel","deployment platform"], entity["company","GitHub Actions","ci platform"], entity["company","Lucide","icon set for react"]), the cleanest “design system” shape is:

**tokens (CSS) → Tailwind utilities → Radix-based components → app composition patterns → docs + governance**.

Below is a concrete, Turborepo-friendly setup.

---

## 1) Turborepo layout that won’t rot

```
apps/
  web/                       # Next.js app
packages/
  ui/                        # Radix-based components (Button, Dialog, etc.)
  theme/                     # Tailwind v4 tokens + globals (CSS-first)
  tailwind-config/           # (optional) shared config if you still use config files
  db/                        # Drizzle schema + client + migrations
  eslint-config/
  tsconfig/
```

Why this split:
- **`theme`** owns *design tokens* and globals.
- **`ui`** owns *components* (Radix primitives + Tailwind classes + variants).
- **`apps/web`** should mostly *compose* components, not invent them.

---

## 2) Tokens in Tailwind v4 (CSS-first)

Tailwind v4 supports CSS-first configuration (so tokens can live in CSS instead of a big JS config). citeturn0search6

**`packages/theme/src/theme.css`**
```css
@import "tailwindcss";

/* Design tokens */
@theme {
  /* semantic colors */
  --color-bg: hsl(0 0% 100%);
  --color-bg-subtle: hsl(210 40% 98%);
  --color-fg: hsl(222 47% 11%);
  --color-fg-muted: hsl(215 16% 47%);
  --color-border: hsl(214 32% 91%);
  --color-brand: hsl(222 89% 54%);
  --color-brand-fg: hsl(0 0% 100%);
  --color-danger: hsl(0 84% 60%);
  --color-danger-fg: hsl(0 0% 100%);

  /* radii, shadows */
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --shadow-sm: 0 1px 2px hsl(222 47% 11% / 0.08);
  --shadow-md: 0 8px 20px hsl(222 47% 11% / 0.12);
}

/* dark theme */
.dark {
  --color-bg: hsl(222 47% 11%);
  --color-bg-subtle: hsl(223 47% 13%);
  --color-fg: hsl(210 40% 98%);
  --color-fg-muted: hsl(215 20% 65%);
  --color-border: hsl(217 32% 25%);
  --color-brand: hsl(217 91% 60%);
  --color-brand-fg: hsl(222 47% 11%);
}
```

Then in `apps/web/src/app/globals.css`:
```css
@import "@acme/theme/theme.css";
```

This gives you a single source of truth for tokens, and every app can opt into the same theme by importing it.

---

## 3) “Radix-first” component rules (so the system stays consistent)

For each component in `packages/ui`:
1. **Use a Radix primitive** when it exists (Dialog, DropdownMenu, Tabs, Tooltip, etc.)
2. Style via Tailwind classes with:
   - **semantic tokens only** (bg/fg/brand/border)
   - **variants + sizes** (no one-off class soup in app code)
   - consistent focus rings + disabled states

Example: **Button**

```tsx
// packages/ui/src/button.tsx
import * as React from "react";

const base =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] " +
  "font-medium transition focus:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-[--color-brand] disabled:opacity-50 disabled:pointer-events-none";

const variants = {
  solid: "bg-[--color-brand] text-[--color-brand-fg] hover:opacity-90 shadow-[var(--shadow-sm)]",
  outline: "border border-[--color-border] bg-transparent hover:bg-[--color-bg-subtle]",
  ghost: "bg-transparent hover:bg-[--color-bg-subtle]",
  danger: "bg-[--color-danger] text-[--color-danger-fg] hover:opacity-90",
} as const;

const sizes = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
} as const;

export function Button({
  variant = "solid",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}) {
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
```

**App code rule:** only choose `variant/size`, don’t restyle the button in `apps/web` except spacing/layout.

---

## 4) Standardize “interaction contracts” once

Put these on *every* interactive component:
- `focus-visible:ring-2` with brand ring
- disabled: opacity + pointer-events-none
- error states use `--color-danger`

Example input:
```tsx
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        "h-10 w-full rounded-[var(--radius-md)] border border-[--color-border] " +
        "bg-[--color-bg] px-3 text-[--color-fg] " +
        "placeholder:text-[--color-fg-muted] " +
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[--color-brand] " +
        "aria-[invalid=true]:border-[--color-danger] aria-[invalid=true]:focus-visible:ring-[--color-danger]"
      }
    />
  );
}
```

---

## 5) Tables: TanStack Table + virtualization as a system component

TanStack Table is headless; you pair it with a virtualization library (TanStack Virtual is the obvious match). citeturn1search25turn1search17

Make **one** reusable `DataTable` in `packages/ui` that:
- accepts column defs + data
- supports row selection / sorting / pagination in a consistent way
- optionally turns on virtualization (for big datasets)

Key design-system idea: the *table surface* (header height, row height, padding, hover, selection color, empty states) must be standardized.

---

## 6) TanStack Query: bake defaults + cache rules into a “Provider package”

In `packages/ui` or `packages/web-core`, export `AppProviders`:
- QueryClient with standard staleTime/retry
- Clerk Provider in app root
- Theme class toggling (`dark`)

Then apps don’t reinvent defaults. (This matters more than people think.)

---

## 7) Pacer: make “rate limiting UI work” a first-class pattern

Pacer is explicitly for debouncing/throttling/queueing/batching. citeturn1search2turn1search3turn1search0

Design system usage examples:
- typeahead search input: debounced query
- infinite scrolling: throttle fetch calls
- prefetching: queued/batched prefetch (pairs nicely with Query)

Make small hooks in `packages/ui/src/hooks/` like `useDebouncedValue`, `useThrottledCallback`, etc. backed by Pacer so the whole org does it the same way.

---

## 8) Drizzle + Neon serverless HTTP driver in a shared `db` package

Drizzle has a dedicated `neon-http` adapter and Neon documents the serverless HTTP driver approach. citeturn0search1turn0search3turn1search5

**`packages/db/src/client.ts`**
```ts
import { drizzle } from "drizzle-orm/neon-http";

export const db = drizzle(process.env.DATABASE_URL!);
```

**Migration setup** (drizzle-kit config lives in `packages/db`), following the “drizzle config file” pattern. citeturn0search19

⚠️ Watch versions: there’s a recent report of incompatibility involving `@neondatabase/serverless` 1.0.0 and Drizzle’s neon-http adapter. Pinning versions in the repo (or following Drizzle/Neon guidance) avoids surprise CI breakage. citeturn1search8

---

## 9) Next.js + Turbopack + Vercel: keep it boring

- Turbopack is stable for dev, and Next.js 16 says it’s stable for production builds + default for new projects. citeturn0search2turn0search10
- Don’t invent custom bundler tricks inside the design system; focus on deterministic builds and caching.

---

## 10) CI in GitHub Actions (monorepo essentials)

Minimum jobs:
- install (pnpm) + cache
- lint
- typecheck
- test (if you have it)
- build (turbo filtered)

Plus: enforce design-system constraints:
- forbid raw hex colors in UI package (simple eslint rule or grep)
- require exported components to include `data-slot` / `displayName` (optional)
- basic a11y checks for key components (at least for Dialog/Menu)

---

## The 10 components that cover ~80% of product UI fast
Build these first in `packages/ui` (Radix where possible):
1. Button
2. Input + Textarea
3. FormField (Label + Help + Error)
4. Dialog (Radix)
5. DropdownMenu (Radix)
6. Tabs (Radix)
7. Tooltip (Radix)
8. Toast/Sonner-style notifications (Radix or equivalent)
9. DataTable (TanStack Table + optional virtualization)
10. Skeleton + Spinner + EmptyState

---

If you want, I’ll give you a *copy/paste* repo skeleton (package.json workspaces, turbo.json pipelines, a `theme.css`, and 3 starter Radix components: Button, Dialog, DropdownMenu) that matches your exact stack and deploy setup.
