---
title: "UI Spec Extraction Guide"
type: note
created: 2025-12-23
updated: 2025-12-23
source: chatgpt-export
conversation_id: 694a27a5-f420-8329-a48a-f1de1a100766
message_count: 6
tags: [chatgpt, import, long-form]
---
# UI Spec Extraction Guide

> Conversation ID: 694a27a5-f420-8329-a48a-f1de1a100766
> Created: 2025-12-23T05:26:18Z
> Updated: 2025-12-23T05:30:25Z
> Messages: 6

---

## User

i want you to extract the exact fonts opactiy font size, leading, tracking, and line spacing for the different UI components. the exact bg for each section. and the icon library used. I want border codes too.

make this into a exact spec for creating dshabords in this theme

---

## Assistant

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
- `--bg-surface-1: <hex/rgba>` (cards)
- `--bg-surface-2: ...` (raised/hover)
- `--bg-sidebar: ...`
- `--bg-topnav: ...`
- `--bg-modal: ...`
- `--text-primary: ...`
- `--text-secondary: ...`
- `--text-tertiary: ...`
- `--border-default: ...`
- `--border-subtle: ...`
- `--focus-ring: ...`

**Radius tokens**
- `--radius-sm: <px>`
- `--radius-md: <px>`
- `--radius-lg: <px>`
- `--radius-xl: <px>`

**Border tokens (“border codes”)**
- `--border-1: <width> <style> <color>`
- `--border-2: ...`

**Elevation tokens**
- `--shadow-1: <exact box-shadow string>`
- `--shadow-2: ...`

**Spacing tokens**
- `--space-1: <px>`
- `--space-2: <px>`
- `--space-3: <px>`
- … (map to padding/margins)

---

### 2) Component Specs (exact per UI element)

Below is the format you want for every component. Repeat this block per component.

#### Component: Sidebar item (default / hover / active)
**Typography**
- Font: `var(--font-sans)`
- Weight: `<exact>`
- Size / Leading / Tracking: `<font-size> / <line-height> / <letter-spacing>`
- Text color: `<rgba/hex>`
- Opacity: `<exact>`

**Layout**
- Height: `<px>`
- Padding: `<px> <px>`
- Gap (icon-text): `<px>`
- Icon size: `<px>`

**Background**
- Default: `<bg token or exact value>`
- Hover: `<exact>`
- Active: `<exact>`

**Border**
- Default: `<exact border code>`
- Active indicator (if any): `<exact>`

**Radius / Shadow**
- Radius: `<px>`
- Shadow: `<exact>` (or none)

---

### 3) Required Dashboard Components (recommended list)
To make this “dashboard-ready”, you should have specs for:

- App frame: **Top nav**, **Sidebar**, **Content canvas**
- Page header: title, subtitle, breadcrumbs, actions
- Surfaces: card, panel, section header, dividers
- Data viz chrome: chart card, legend text, tooltip, axis labels
- Table: header cells, body cells, row hover, selected row, empty state
- Inputs: text, select, date picker, search
- Buttons: primary/secondary/ghost/destructive + sizes
- Badges/chips/tags
- Alerts/toasts
- Modal/drawer
- Tabs
- Pagination
- Skeleton/loading states

---

## If you want me to produce the *actual* exact spec
Do one of these and I’ll turn it into a filled, precise theme spec:

- **Option A (best):** open your dashboard in the browser and share the URL/page in this chat so I can read the DOM/CSS context.
- **Option B:** paste the **CSS variables / tailwind config / theme file** (e.g., `tailwind.config.ts`, `globals.css`, `tokens.css`).
- **Option C:** drop **3–6 screenshots** (top nav, sidebar, a card, a table, a modal). I can infer a lot, but it won’t be “exact” unless we also have computed styles.

If you share **any one** of A/B, I’ll return a complete spec with exact values for every component you listed (type + spacing + backgrounds + borders + icon library).

---

## User

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
    --content-color-dark: #6b6f76;
    --content-highlight-color-dark: #ffffff;
    --sidebar-width: 244px;
    --font-monospace: "Berkeley Mono","SFMono Regular",Consolas,"Liberation Mono",Menlo,Courier,monospace;
    --font-regular: "Inter Variable","SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen,Ubuntu,Cantarell,"Open Sans","Helvetica Neue","Linear Thai",sans-serif;
    --font-display: var(--font-regular);
    --font-emoji: "Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Segoe UI","Twemoji Mozilla","Noto Color Emoji","Android Emoji";
    --speed-highlightFadeIn: 0s;
    --speed-highlightFadeOut: .15s;
    --speed-quickTransition: .1s;
    --speed-regularTransition: .25s;
    --speed-slowTransition: .35s;
    --font-size-micro: .6875rem;
    --font-size-microPlus: .6875rem;
    --font-size-mini: .75rem;
    --font-size-miniPlus: .75rem;
    --font-size-small: .8125rem;
    --font-size-smallPlus: .8125rem;
    --font-size-regular: .9375rem;
    --font-size-regularPlus: .9375rem;
    --font-size-large: 1.125rem;
    --font-size-largePlus: 1.125rem;
    --font-size-title1: 2.25rem;
    --font-size-title2: 1.5rem;
    --font-size-title3: 1.25rem;
    --font-weight-light: 300;
    --font-weight-normal: 450;
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --font-weight-bold: 700;
    --radius-circle: 50%;
    --radius-rounded: 9999px;
    --editor-block-spacing: 1rem;
    --editor-block-spacing-large: 1.375rem;
    --editor-block-spacing-small: .375rem;
    --editor-block-radius: 6px;
    --editor-block-menu-size: 20px;
    --editor-block-menu-offset: 28px;
    --editor-last-invisible-paragraph-spacing: 10px;
    --editor-line-height: 1.6;
    --editor-letter-spacing: -.00666667em;
    --editor-list-inset: 1.5rem;
    --editor-bullet-disc-width: .5em;
    --editor-bullet-disc-offset: .5em;
    --editor-todolist-checkbox-width: 14px;
    --editor-font-size: var(--font-size-regular);
    --editor-safe-area: 16px;
    --ease-in-quad: cubic-bezier(.55,.085,.68,.53);
    --ease-in-cubic: cubic-bezier(.55,.055,.675,.19);
    --ease-in-quart: cubic-bezier(.895,.03,.685,.22);
    --ease-in-quint: cubic-bezier(.755,.05,.855,.06);
    --ease-in-expo: cubic-bezier(.95,.05,.795,.035);
    --ease-in-circ: cubic-bezier(.6,.04,.98,.335);
    --ease-out-quad: cubic-bezier(.25,.46,.45,.94);
    --ease-out-cubic: cubic-bezier(.215,.61,.355,1);
    --ease-out-quart: cubic-bezier(.165,.84,.44,1);
    --ease-out-quint: cubic-bezier(.23,1,.32,1);
    --ease-out-expo: cubic-bezier(.19,1,.22,1);
    --ease-out-circ: cubic-bezier(.075,.82,.165,1);
    --ease-in-out-quad: cubic-bezier(.455,.03,.515,.955);
    --ease-in-out-cubic: cubic-bezier(.645,.045,.355,1);
    --ease-in-out-quart: cubic-bezier(.77,0,.175,1);
    --ease-in-out-quint: cubic-bezier(.86,0,.07,1);
    --ease-in-out-expo: cubic-bezier(1,0,0,1);
    --ease-in-out-circ: cubic-bezier(.785,.135,.15,.86);
    --focus-ring-color: lch(47.918% 59.303 288.421);
    --focus-ring-width: 1px;
    --focus-ring-offset: 0px;
    --focus-ring-outline: var(--focus-ring-width) solid var(--focus-ring-color);
    --color-bg-primary: lch(4.8% 0.7 272);
    --color-bg-secondary: lch(10.633% 3.033 272 / 1);
    --color-bg-tertiary: lch(14.133% 4.2 272 / 1);
    --color-bg-quaternary: lch(7.133% 1.867 272 / 1);
    --color-bg-quinary: 0;
    --color-text-primary: lch(100% 0 272 / 1);
    --color-text-secondary: lch(90.65% 1.35 272 / 1);
    --color-text-tertiary: lch(62.6% 1.35 272 / 1);
    --color-text-quaternary: lch(38.29% 1.35 272 / 1);
    --color-border-primary: lch(9.77% 3.54 272 / 1);
    --color-border-secondary: lch(14.74% 3.54 272 / 1);
    --color-border-tertiary: lch(19% 3.54 272 / 1);
    --control-border-radius: var(--control-border-radius, 4px);
    --content-color: var(--content-color-dark);
    --content-highlight-color: var(--content-highlight-color-dark);
    --bg-sidebar-color: lch(2.467% 0 272 / 1);
    --bg-base-color: lch(4.8% 0.7 272);
    --bg-border-color: lch(14.74% 3.54 272 / 1);
    --scrollbar-width: 0px;
    --bg-color: lch(2.467% 0 272 / 1);
    box-sizing: border-box;
    touch-action: pan-x pan-y;

---

## Assistant

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
- `--color-text-tertiary: lch(62.6% 1.35 272 / 1);`
- `--color-text-quaternary: lch(38.29% 1.35 272 / 1);`

### 2.3 Border colors (LCH)
- `--color-border-primary: lch(9.77% 3.54 272 / 1);`
- `--color-border-secondary: lch(14.74% 3.54 272 / 1);`
- `--color-border-tertiary: lch(19% 3.54 272 / 1);`

### 2.4 App-level aliases (exact)
- `--bg-sidebar-color: lch(2.467% 0 272 / 1);`
- `--bg-base-color: lch(4.8% 0.7 272);`
- `--bg-border-color: lch(14.74% 3.54 272 / 1);`
- `--bg-color: lch(2.467% 0 272 / 1);`
- `--content-color: var(--content-color-dark);` where `--content-color-dark: #6b6f76;`
- `--content-highlight-color: var(--content-highlight-color-dark);` where `--content-highlight-color-dark: #ffffff;`

---

## 3) Radii + Focus

### 3.1 Radius tokens
- `--control-border-radius: 4px;`  *(note: defined as `var(--control-border-radius, 4px)` in your snippet)*
- `--editor-block-radius: 6px;`
- `--radius-rounded: 9999px;`
- `--radius-circle: 50%;`

### 3.2 Focus ring
- `--focus-ring-color: lch(47.918% 59.303 288.421);`
- `--focus-ring-width: 1px;`
- `--focus-ring-offset: 0px;`
- `--focus-ring-outline: 1px solid lch(47.918% 59.303 288.421);`

---

## 4) Motion (Exact)
- `--speed-highlightFadeIn: 0s;`
- `--speed-highlightFadeOut: 0.15s;`
- `--speed-quickTransition: 0.1s;`
- `--speed-regularTransition: 0.25s;`
- `--speed-slowTransition: 0.35s;`

Easing functions provided (use as-is):
- `--ease-out-quint: cubic-bezier(.23,1,.32,1);` *(etc — use your full list as token set)*

---

## 5) Component Mapping for Dashboards (Theme Application)

### 5.1 App layout surfaces (exact mapping)
- **App root background (behind everything):**
  - `background: var(--bg-color);` → `lch(2.467% 0 272 / 1)`
- **Sidebar background:**
  - `background: var(--bg-sidebar-color);` → `lch(2.467% 0 272 / 1)`
  - Sidebar width: `--sidebar-width: 244px;`
- **Main content canvas background:**
  - `background: var(--bg-base-color);` → `lch(4.8% 0.7 272)`

### 5.2 Panels / sections
Use this consistent ramp (matches your provided bg tiers):
- **Panel / Card (default):** `background: var(--color-bg-secondary);`
- **Raised / Hover panel:** `background: var(--color-bg-tertiary);`
- **Subtle inset / alternative:** `background: var(--color-bg-quaternary);`

### 5.3 Text roles (exact colors)
- **Primary text:** `color: var(--color-text-primary);`
- **Secondary text:** `color: var(--color-text-secondary);`
- **Tertiary / labels:** `color: var(--color-text-tertiary);`
- **Disabled / de-emphasized:** `color: var(--color-text-quaternary);`  
  (If your UI uses opacity instead of color for disabled, capture it exactly in Section 6.)

### 5.4 Borders (“border codes”)
Define these as canonical border styles:
- **Border / divider default:** `1px solid var(--color-border-secondary);`
- **Border subtle:** `1px solid var(--color-border-primary);`
- **Border strong:** `1px solid var(--color-border-tertiary);`

Radius for controls:
- Inputs, buttons, chips: `border-radius: var(--control-border-radius);` (4px)

---

## 6) Missing-to-be-exact: per-component computed styles (1 minute per component)

To make this spec **fully exact**, for each of these components:
- Top nav
- Sidebar item (default/hover/active)
- Page title + subtitle
- Section headers (“Properties”, etc.)
- Card container
- Table header cell + row
- Button (primary/secondary/ghost)
- Input
- Chip/badge
- Icon button

Capture from DevTools → **Computed**:
- `font-size` (should match one of your tokens)
- `line-height` (leading)
- `letter-spacing` (tracking)
- `opacity` (if any; note parent opacity)
- `color` (computed)
- `background-color` (computed)
- `border` (width/style/color)
- `border-radius`
- `box-shadow` (if used as borders/elevation)

Paste those computed values back into this document under each component section.

---

## 7) Icon library (must be verified)
Not determinable from the provided tokens alone.

**How to identify exactly:**
- Inspect any icon SVG in the DOM.
- Look for class/attributes or import hints (`lucide-*`, `hero-*`, `ph-*`, `tabler-*`, etc.).
- Check `package.json` dependencies for `lucide-react`, `@heroicons/react`, `@phosphor-icons/react`, `@tabler/icons-react`, or `react-icons`.

Once identified, standardize:
- Icon set name
- Default icon size (e.g., 16/18/20px)
- Stroke width (if stroke-based)
- Icon color tokens: secondary/tertiary text mapping

---

## 8) Implementation notes (to keep dashboards consistent)
- Prefer tokens only (no raw hex sprinkled into components).
- Use bg tiers consistently:
  - Canvas: `--bg-base-color`
  - Cards/panels: `--color-bg-secondary`
  - Hover/active: `--color-bg-tertiary`
  - Dividers: `--color-border-secondary`
- Focus ring always: `outline: var(--focus-ring-outline); outline-offset: var(--focus-ring-offset);`
:::

If you want, Mr. White, paste **computed styles for just 3 things** (a sidebar item, a card title, a table header cell) and I’ll finish the spec with **exact leading/tracking/opacity** for the whole dashboard system and produce the full component library section in the same format.

---

## User

take over my browser and inspect the app yourself

---

## Assistant

I’ve loaded the Linear project page you shared, but this environment doesn’t expose browser DevTools or computed CSS properties. The tools available let me click and type on elements or read the accessible DOM, but they don’t provide the font sizes, line heights, letter spacing, opacity, or icon metadata directly.

To produce the exact spec you’re after, I’d still need the computed values for each component (font size, line height, letter spacing, opacity, etc.), which requires either DevTools output or a theme file. If you can share a CSS/theme file or paste the computed styles for a few representative elements from your own DevTools, I can integrate those into a complete spec.


## See Also
- [[chatgpt/chatgpt_app-spec-and-mockups]]
- [[chatgpt/chatgpt_avatar-upload-spec]]
- [[chatgpt/chatgpt_branch-full-spec-request-part1]]
- [[chatgpt/chatgpt_branch-full-spec-request-part2]]
- [[chatgpt/chatgpt_branch-full-spec-request-part3]]
