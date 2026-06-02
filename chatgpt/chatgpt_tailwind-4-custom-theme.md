---
title: "Tailwind 4 custom theme"
type: note
created: 2025-08-28
updated: 2025-08-28
source: chatgpt-export
conversation_id: 68b0e03a-5fb0-832f-a372-724374bb0cce
message_count: 2
tags: [chatgpt, import, code]
---
# Tailwind 4 custom theme

> Conversation ID: 68b0e03a-5fb0-832f-a372-724374bb0cce
> Created: 2025-08-28T23:04:44Z
> Updated: 2025-08-28T23:05:46Z
> Messages: 2

---

## User

Accroding to tailwind what is the best way to manage a custom theme in tailwind 4. What do we need to ensure we respect all performance. 

---

## Assistant

Mr. White — short and straight:

# Tailwind 4: “official” way to theme + perf rules

**How to define a custom theme (v4)**
1. **CSS-first config.** No `tailwind.config.js` needed. Put everything in your global CSS. citeturn0search2  
2. **Declare tokens with `@theme` (top-level only).** These become utilities *and* CSS variables you can override at runtime.  
   ```css
   /* app.css */
   @import "tailwindcss";

   @theme {
     --color-brand-50: oklch(0.97 0.01 260);
     --color-brand-500: oklch(0.65 0.14 260);
     --font-sans: "Inter", ui-sans-serif, system-ui;
     --radius-lg: 1rem;
     --breakpoint-3xl: 120rem; /* gives you 3xl: variants */
   }
   ```
   Use `bg-brand-500`, `text-brand-50`, `font-sans`, `rounded-lg`, `3xl:*`, etc. citeturn1search8
3. **Dark / multi-theme without rebuilding.** Leave base tokens in `@theme`, then **override the generated CSS variables** under a selector (class or `[data-theme]`).  
   ```css
   :root[data-theme="dark"] {
     --color-brand-500: oklch(0.72 0.18 260); /* runtime swap */
     /* override any tokens you need */
   }
   ```
   (You don’t nest `@theme` inside selectors; you override the variables it emits.) citeturn1search8turn1search2  
   Use a simple toggle (e.g., set `document.documentElement.dataset.theme = "dark"`), or the system-aware approach in the docs. citeturn1search1

**When to use `@theme` vs `:root`**
- Use **`@theme`** for *design tokens* that should create utilities (colors, fonts, radii, spacing, breakpoints).  
- Use **`:root`/scoped CSS vars** for values that shouldn’t map to utilities (one-off CSS vars). citeturn0search6

**Performance checklist (v4)**
- **Use v4’s Oxide engine** (default via `@import "tailwindcss"`). It’s substantially faster in full and incremental builds. citeturn0search7turn0search4turn0search13
- **Keep tokens in `@theme`, styles in utilities.** Avoid giant `@layer base` blocks and heavy `@apply` chains; let utilities do the work. citeturn0search16
- **Prefer tokenized colors** over ad-hoc arbitrary values to limit CSS churn and enable runtime theme overrides (fewer new rules). citeturn1search8
- **Ship production builds** (minified, tree-shaken by Oxide; no PostCSS config required). Ensure your target browsers meet v4’s baseline (Safari 16.4+, Chrome 111+, Firefox 128+). citeturn0search5
- **Scope theme overrides narrowly** (e.g., on `html` or a top container) to minimize repaint/recalc on theme flips. (Community best practice; consistent with v4 multi-theme approach.) citeturn1search2

**Tiny starter you can drop in**
```css
@import "tailwindcss";

/* 1) Tokens */
@theme {
  --color-brand-50: oklch(0.97 0.01 260);
  --color-brand-500: oklch(0.65 0.14 260);
  --font-sans: "Inter", ui-sans-serif, system-ui;
  --radius-lg: 1rem;
}

/* 2) Theme scopes (runtime overrides, no rebuild) */
:root[data-theme="dark"]{
  --color-brand-500: oklch(0.72 0.18 260);
}
```

That’s the clean, official path: define tokens once with `@theme`, override via scoped CSS vars for dark/brand themes, and let Oxide handle perf.
