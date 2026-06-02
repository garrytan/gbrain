---
title: "UI Spec Extraction Guide"
type: guide
created: 2025-12-23
updated: 2025-12-23
source: chatgpt-export
topic: coding-web
message_count: 6
tags: [chatgpt, knowledge, coding-web]
---
# UI Spec Extraction Guide

> **Source:** ChatGPT conversation
> **Date:** 2025-12-23T05:26:18Z
> **Messages:** 6
> **Topic:** coding-web

## Question

i want you to extract the exact fonts opactiy font size, leading, tracking, and line spacing for the different UI components. the exact bg for each section. and the icon library used. I want border codes too.

make this into a exact spec for creating dshabords in this theme

## Answer

Mr. White — I can’t extract **exact** fonts/opacity/sizes/spacing/backgrounds/borders/icon library from what’s currently attached. The only UI-related content I can see is a **build log + a Linear project page shell**, not the actual dashboard UI (no CSS rules, no rendered components, no computed styles).

What I *can* do right now is:
1) give you an **exact spec template** (ready to fill) that matches how dashboards should be tokenized, and  
2) tell you the **fastest reliable way to pull the exact values** (font-size, leading/line-height, tracking/letter-spacing, opacity, border codes, backgrounds, icon library) from the real UI with DevTools—so the spec is truly exact.

---

## How to extract exact values (DevTools, copy/paste exact numbers)

For each UI component (Top nav, sidebar, page header, cards, tables, buttons, inputs, badges, modals, toasts):

### Typography (font, size, leading, tracking, opacity)
1. Inspect element → **Computed** panel  
2. Copy these **computed** values (not “author”):
- `font-family`
- `font-size`
- `font-weight`
- `line-height`  *(this is “leading” / line spacing)*
- `letter-spacing` *(tracking)*
- `text-transform` (if any)
- `color` (RGBA/HEX)
- `opacity` *(if applied; note it can be on a parent)*

### Backgrounds per section
Inspect the *container* element for each section and capture:
- `background-color` (RGBA/HEX)
- `background-image` / gradients (full string)
- `backdrop-filter` (blur, etc. — important for “glass”)
- `box-shadow` (if used as elevation instead of borders)

### Borders (“border codes”)
Capture:
- `border-width`
- `border-style`
- `border-color` (RGBA/HEX)
- `border-radius`
If borders are implemented as shadows, capture `box-shadow` too.

### Icons: identify the library
Inspect an icon element:
- If it’s `<svg>` with class patterns like `lucide-*`, `hero-*`, `ph-*`, `tabler-*`, etc. you’ll usually know immediately.
- Also check `package.json` for dependencies: `lucide-react`, `@heroicons/react`, `react-icons`, `@phosphor-icons/react`, `@tabler/icons-react`, etc.
- In DevTools Console you can run:
  - Search the DOM for `data-lucide`, `lucide`, `heroicons`, `phosphor`, `tabler`
  - Or search Sources for `from "lucide-react"` etc.

---

## Dashboard Theme Spec (fill-in “exact” values)
Copy this into your design system doc (or Linear doc). Everything is structured so it becomes implementation-ready.

### 1) Foundations (Tokens)

**Typography tokens**
- `--font-sans: <exact font-family stack>`
- `--font-mono: <exact stack if used>`
- `--text-opacity-default: <number 0–1 or %>`

**Type scale (map to components below)**
- `--text-xs: <font-size> / <line-height> / <letter-spacing>`
- `--text-sm: ...`
- `--text-base: ...`
- `--text-lg: ...`
- `--text-xl: ...`

**Font weights**
- `--weight-regular: <number>`
- `--weight-medium: <number>`
- `--weight-semibold: <number>`
- `--weight-bold: <number>`

**Color tokens (prefer HEX + alpha tokens)**
- `--bg-app: <hex/rgba>`
- `--bg-surface-1: <hex/rgba>` (card

*(Answer truncated — 5715 chars total)*

## Question

{'asset_pointer': 'sediment://file_00000000699471f59de9a0027bd18f01', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1399, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 680068, 'width': 2048}
    font-size: inherit;
    font-family: inherit;
    font-weight: inherit;
    line-height: inherit;
    -webkit-tap-highlight-color: transparent;
    --bg-sidebar-light: #f5f5f5;
    --bg-base-color-light: #fcfcfc;
    --bg-border-color-light: #e0e0e0;
    --content-color-light: #b0b5c0;
    --content-highlight-color-light: #23252a;
    --bg-sidebar-dark: #090909;
    --bg-base-color-dark: #101012;
    --bg-border-color-dark: #23252a;
    --content-

## Answer

Mr. White — from what you provided I can make an **exact, implementation-ready spec for the theme tokens** (fonts, sizes, weights, key colors, borders, radii, motion).  
What I **cannot** truthfully claim as “exact” yet: **per-component computed line-height/letter-spacing/opacity** and the **icon library**, because those aren’t in the snippet (they’re typically set on each component class or inherited). I’ll still give you a complete dashboard spec **wired to the exact tokens you pasted**, with a short “how to fill the missing computed fields” section.

:::writing{id="73510" variant="standard"}
# Dashboard Theme Spec (Exact Tokens + Component Mapping)

## 0) Source of truth
Use these CSS custom properties as the canonical theme source (do not hand-pick hexes elsewhere). Values below are **exactly as provided**.

---

## 1) Typography

### 1.1 Font families
- **Sans / UI (default)**
  - `--font-regular: "Inter Variable","SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen,Ubuntu,Cantarell,"Open Sans","Helvetica Neue","Linear Thai",sans-serif;`
  - `--font-display: var(--font-regular);`
- **Monospace**
  - `--font-monospace: "Berkeley Mono","SFMono Regular",Consolas,"Liberation Mono",Menlo,Courier,monospace;`
- **Emoji**
  - `--font-emoji: "Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Segoe UI","Twemoji Mozilla","Noto Color Emoji","Android Emoji";`

### 1.2 Font weights
- `--font-weight-light: 300;`
- `--font-weight-normal: 450;`
- `--font-weight-medium: 500;`
- `--font-weight-semibold: 600;`
- `--font-weight-bold: 700;`

### 1.3 Type scale (rem + px @ 16px root)
- `--font-size-micro: 0.6875rem;` (**11px**)
- `--font-size-mini: 0.75rem;` (**12px**)
- `--font-size-small: 0.8125rem;` (**13px**)
- `--font-size-regular: 0.9375rem;` (**15px**)
- `--font-size-large: 1.125rem;` (**18px**)
- `--font-size-title3: 1.25rem;` (**20px**)
- `--font-size-title2: 1.5rem;` (**24px**)
- `--font-size-title1: 2.25rem;` (**36px**)

> Note: `microPlus/miniPlus/smallPlus/regularPlus/largePlus` are defined and currently equal to their base sizes.

### 1.4 Leading (line-height) + Tracking (letter-spacing)
Only **editor** values are explicitly defined in your snippet:
- `--editor-line-height: 1.6;`
- `--editor-letter-spacing: -0.00666667em;`
- `--editor-font-size: var(--font-size-regular);`

**UI component line-height / letter-spacing / opacity are not defined in the pasted tokens** (likely set per component class).  
**Requirement to be “exact”:** capture computed `line-height`, `letter-spacing`, and `opacity` per component (see Section 6).

---

## 2) Color System (Exact)

### 2.1 Core background ramp (LCH)
- `--color-bg-primary: lch(4.8% 0.7 272);`
- `--color-bg-secondary: lch(10.633% 3.033 272 / 1);`
- `--color-bg-tertiary: lch(14.133% 4.2 272 / 1);`
- `--color-bg-quaternary: lch(7.133% 1.867 272 / 1);`

### 2.2 Text colors (LCH)
- `--color-text-primary: lch(100% 0 272 / 1);`
- `--color-text-secondary: lch(90.65% 1.35 272 / 1);`
- `--colo

*(Answer truncated — 8048 chars total)*

## Question

take over my browser and inspect the app yourself

## Answer

I’ve loaded the Linear project page you shared, but this environment doesn’t expose browser DevTools or computed CSS properties. The tools available let me click and type on elements or read the accessible DOM, but they don’t provide the font sizes, line heights, letter spacing, opacity, or icon metadata directly.

To produce the exact spec you’re after, I’d still need the computed values for each component (font size, line height, letter spacing, opacity, etc.), which requires either DevTools output or a theme file. If you can share a CSS/theme file or paste the computed styles for a few representative elements from your own DevTools, I can integrate those into a complete spec.
