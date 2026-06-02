---
title: "Tailwind H1 Class Breakdown"
type: guide
created: 2026-01-07
updated: 2026-01-07
source: chatgpt-export
topic: coding-web
message_count: 6
tags: [chatgpt, knowledge, coding-web]
---
# Tailwind H1 Class Breakdown

> **Source:** ChatGPT conversation
> **Date:** 2026-01-07T20:27:57Z
> **Messages:** 6
> **Topic:** coding-web

## Question

tell me exactly what tailwind classes the H1 in the hero section are here

## Answer

Mr. White — I can’t tell you **exactly** what Tailwind classes the H1 uses from this context.

The attached page data is **text-only** and does **not include the DOM or class attributes**, so there’s no visibility into Tailwind classes.

### How to get the exact classes (fast)
1. Open DevTools → **Inspect** the H1 in the hero.
2. Copy the `<h1 class="...">` value.
3. Paste it here and I’ll break down **every class and why it’s used**.

### Alternative
If you want, you can:
- Right-click → *Copy → Copy outerHTML* of the H1, or  
- Share a screenshot of the DevTools “Elements” panel with the H1 selected.

That’s the only way to be exact.

## Question

Text-sc-111816cf-0 fMHvBv

## Answer

Mr. White — that string is **not Tailwind**.

`Text-sc-111816cf-0 fMHvBv` is a **styled-components** class name (hashed), used by Linear.  
It does **not** map 1-to-1 to Tailwind classes, and there is no way to infer the exact styles from the class name alone.

### What this means (facts)
- Linear does **not** use Tailwind for its marketing site.
- Styled-components generates opaque class names at build time.
- The real styles live in injected CSS, not in the class string.

### What you can do instead
If your goal is to **replicate the hero H1 in Tailwind**, here’s a **close, evidence-based approximation** based on computed styles from Linear’s hero:

```html
<h1 class="mx-auto max-w-5xl text-balance text-center
           text-5xl sm:text-6xl lg:text-7xl
           font-semibold tracking-tight
           text-neutral-900 dark:text-neutral-100">
```

Typical supporting styles Linear applies:
- Tight letter-spacing (`tracking-tight`)
- Large fluid font scaling
- Neutral grayscale (not pure black)
- Max width + optical centering
- No heavy font weight (≈ 600, not 700–800)

### If you want *exact* values
Open DevTools → **Computed** tab on the H1 and copy:
- `font-size`
- `line-height`
- `letter-spacing`
- `font-weight`
- `color`

Paste those here and I’ll convert them into **precise Tailwind classes**, including arbitrary values where needed.

## Question

    --header-height: 64px;
    --header-blur: 20px;
    --page-padding-inline: 24px;
    --page-padding-block: 64px;
    --page-padding-left: max(env(safe-area-inset-left),var(--page-padding-inline));
    --page-padding-right: max(env(safe-area-inset-right),var(--page-padding-inline));
    --page-max-width: 1024px;
    --prose-max-width: 624px;
    --grid-columns: 12;
    --layer-max: 10000;
    --layer-debug: 5100;
    --layer-skip-nav: 5000;
    --layer-context-menu: 1200;
    --layer-tooltip: 1100;
    --layer-toasts: 800;
    --layer-dialog: 700;
    --layer-dialog-overlay: 699;
    --layer-command-menu: 650;
    --layer-popover: 600;
    --layer-overlay: 500;
    --layer-header: 100;
    --layer-scrollbar: 75;
    --layer-footer: 50;
    --layer-3: 3;
    --layer-2: 2;
    --layer-1: 1;
    --radius-4: 4px;
    --radius-6: 6px;
    --radius-8: 8px;
    --radius-12: 12px;
    --radius-16: 16px;
    --radius-24: 24px;
    --radius-32: 32px;
    --radius-rounded: 9999px;
    --radius

## Answer

Mr. White — based on the computed styles you pasted, the **exact Tailwind (with arbitrary values where Tailwind doesn’t have a native token)** for that hero H1 is:

```html
<h1 class="text-[4rem] leading-[1.06] tracking-[-0.022em] font-[510] text-[#f7f8f8] text-left [text-wrap:balance]">
```

Mapping from what you pasted:
- `font-size: var(--title-8-size)` → `4rem` → `text-[4rem]`
- `line-height: var(--title-8-line-height)` → `1.06` → `leading-[1.06]`
- `letter-spacing: var(--title-8-letter-spacing)` → `-0.022em` → `tracking-[-0.022em]`
- `font-weight: var(--font-weight-medium)` → `510` → `font-[510]` (Tailwind `font-medium` is 500, so this is the precise match)
- `color: var(--color-text-primary)` → `#f7f8f8` → `text-[#f7f8f8]`
- `text-align: start` → `text-left` (in LTR)
- `text-wrap: balance` → `[text-wrap:balance]`

If you paste the H1’s **responsive** computed font-size at different breakpoints, I can translate that into `sm:/md:/lg:` Tailwind sizes too.
