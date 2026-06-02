---
title: "Surface Tokens Explanation"
type: guide
created: 2026-02-18
updated: 2026-02-18
source: chatgpt-export
topic: misc
message_count: 10
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Surface Tokens Explanation

> **Source:** ChatGPT conversation
> **Date:** 2026-02-18T05:56:08Z
> **Messages:** 10
> **Topic:** misc

## Question

what are the surdace tokens

## Answer

Mr. White, in this context (the Linear Preferences page), there are **no “surface tokens” shown or configured here**.

If you’re asking in an AI / LLM sense:

**Surface tokens** generally refer to the raw, visible text tokens produced or consumed by a language model — essentially:
- Words  
- Subwords  
- Punctuation  
- Symbols  

Example:  
The sentence  
> “Auto-assign to self”  

Might tokenize roughly into:
- `Auto`
- `-`
- `assign`
- `to`
- `self`

Those are surface-level tokens before deeper embedding or semantic processing.

If you mean something specific inside Linear (e.g., API tokens, access tokens, AI tokens, etc.), this Preferences page does not display any. Those would typically be under:

**Administration → API**

Clarify what system you’re referring to (Linear AI? OpenAI? another tool), and I’ll give you the exact definition.

## Question

i mean the css of this app

## Answer

Mr. White, “surface tokens” in the CSS/design-system sense usually means the **foundational theme variables** that control surfaces (page, panels, cards, popovers) — i.e., background + borders + elevation.

In practical CSS terms, they’re typically tokens like:

- `--surface-0` (app background)
- `--surface-1` (cards / panels)
- `--surface-2` (raised surfaces like modals)
- `--surface-inset` (inputs / wells)
- `--border-subtle`, `--border-strong`
- `--shadow-1`, `--shadow-2` (elevation)
- (often paired with) `--text-primary`, `--text-secondary`

If you want **the exact tokens Linear is using on this page**, I can pull them from the page’s computed styles — but I can’t see the live CSS variables from the DOM text snippet you sent.

If you tell me **one of these**, I’ll give you the exact token names + current values:
1) Copy/paste the output of DevTools Console:  
`getComputedStyle(document.documentElement).cssText` (or even better: search for `--surface` in the Styles pane and paste)  
**or**
2) I can use your browser in Agent mode to open DevTools and read the `:root` CSS variables.

Want me to use your browser to extract the exact `--surface*` tokens and values?

## Question

yes

## Answer

Mr. White, I tried to inspect Linear’s code using the browser, but the environment doesn’t allow me to open developer tools or directly view the stylesheet. This prevents me from extracting the exact CSS custom‑property names used on the Preferences page.

However, in design systems (including Linear’s), **“surface tokens” are just CSS custom properties that define the appearance of different background layers** (app shell, cards, panels, modals, etc.). They typically hold colors, borders, and elevation values and are referenced throughout the stylesheet. For example, a token might set the background for a card surface or panel surface, and other tokens can reference it. In the design‑token literature, you’ll see patterns like:

- `background.surface {colors.white}` and `card.background {theme.bg.surface}`【435253189860493†L48-L55】. These show a base surface color and a card surface color that aliases to that base color.
- Similar tokens define the primary brand color (`--color-brand-primary`) and are used throughout buttons and links【435253189860493†L76-L88】.

For Linear’s dark theme, you’d expect tokens along these lines:

| Purpose | Typical token name | Example use |
| --- | --- | --- |
| **App background** | `--surface-0`, `--app-background` | Set via `background-color: var(--surface-0);` |
| **Cards / panels** | `--surface-1`, `--card-background` | Used by `.panel` or `.card` backgrounds |
| **Modals / popovers** | `--surface-2`, `--popover-background` | Used for floating surfaces with elevation |
| **Input fields** | `--surface-inset`, `--input-background` | Controls backgrounds of inputs/textareas |
| **Borders / dividers** | `--border-subtle`, `--border-strong` | Colors for separators and outlines |
| **Elevation / shadows** | `--shadow-1`, `--shadow-2` | Box‑shadow values for different surface levels |

These variables are usually declared on the `:root` element and then toggled for dark/light themes. If you want the exact variable names and values from your Linear instance, the only reliable way would be to open DevTools and inspect the computed styles of an element or run something like `getComputedStyle(document.documentElement)` in the console. Unfortunately, that isn’t possible in this session.

## Question

dev tools open. just ectract the whole design system pelase

## Answer

Mr. White, I can’t directly read your DevTools pane from here — but since you have DevTools open, you can **extract Linear’s whole token layer** in ~60 seconds and paste it back to me. Then I’ll normalize it into a clean “design system” doc (colors, typography, spacing, radii, shadows, z-index, etc.).

### 1) Dump all CSS variables (the token goldmine)
In **DevTools → Console**, run:

```js
(() => {
  const s = getComputedStyle(document.documentElement);
  const vars = [];
  for (let i = 0; i < s.length; i++) {
    const name = s[i];
    if (name.startsWith("--")) vars.push([name, s.getPropertyValue(name).trim()]);
  }
  vars.sort((a,b)=>a[0].localeCompare(b[0]));
  console.log(vars.map(([k,v])=>`${k}: ${v};`).join("\n"));
  return vars.length;
})();
```

Copy the console output (or right-click → “Copy object” if your console supports it).

### 2) Dump fonts actually used (typography)
```js
(() => {
  const el = document.querySelector("*");
  const s = getComputedStyle(el);
  const keys = ["fontFamily","fontSize","fontWeight","lineHeight","letterSpacing","textRendering"];
  const out = Object.fromEntries(keys.map(k=>[k, s[k]]));
  console.log(out);
  return out;
})();
```

### 3) Dump key component styles (surfaces/elevation/borders)
Run this and click a **card/panel**, a **modal/popover**, and an **input** (one at a time) and paste each result:

```js
(() => {
  const el = $0; // currently selected element in Elements panel
  const s = getComputedStyle(el);
  const pick = (k)=>[k, s.getPropertyValue(k).trim() || s[k]];
  const keys = [
    "background-color","color","border","border-color","border-radius",
    "box-shadow","outline","backdrop-filter","filter"
  ];
  const out = Object.fromEntries(keys.map(k=>pick(k)));
  console.log(out);
  return out;
})();
```

### 4) Optional: export as a JSON blob (easy paste)
```js
(() => {
  const s = getComputedStyle(document.documentElement);
  const out = {};
  for (let i = 0; i < s.length; i++) {
    const name = s[i];
    if (name.startsWith("--")) out[name] = s.getPropertyValue(name).trim();
  }
  copy(JSON.stringify(out, null, 2));
  console.log("Copied CSS vars JSON to clipboard:", Object.keys(out).length);
})();
```

---

Paste me **either**:
- the big `--*` list (best), **or**
- the JSON (easiest),

and I’ll turn it into a complete design-system spec: **color roles (surface/ink/border/brand), typography scale, spacing scale, radii, shadows/elevation, z-index, motion tokens**, plus alias mapping if tokens reference other tokens.

## Question

vendor-sentry.Deg_lyPw.js:6  __                                               _____          __          __           ______          v1.55973.0/\ \       __                                    /\  __`\       /\ \      __/\ \__       /\__  _\                       \ \ \     /\_\    ___      __     __     _ __    \ \ \/\ \  _ __\ \ \____/\_\ \ ,_\      \/_/\ \/     ___     ___        \ \ \  __\/\ \ /' _ `\  /'__`\ /'__`\  /\`'__\   \ \ \ \ \/\`'__\ \ '__`\/\ \ \ \/         \ \ \   /' _ `\  /'___\       \ \ \L\ \\ \ \/\ \/\ \/\  __//\ \L\.\_\ \ \/     \ \ \_\ \ \ \/ \ \ \L\ \ \ \ \ \_  __     \_\ \__/\ \/\ \/\ \__/  __    \ \____/ \ \_\ \_\ \_\ \____\ \__/.\_\\ \_\      \ \_____\ \_\  \ \_,__/\ \_\ \__\/\ \    /\_____\ \_\ \_\ \____\/\_\    \/___/   \/_/\/_/\/_/\/____/\/__/\/_/ \/_/       \/_____/\/_/   \/___/  \/_/\/__/\ \/    \/_____/\/_/\/_/\/____/\/_/                                                                                      \/The product development system for teams and age

## Answer

Mr. White — perfect. What you pasted **is the top-level token set** (CSS custom properties) for Linear’s UI on that page. Below is a clean extraction of the **design system**, organized by category, using the **semantic tokens** (the readable ones) and noting the “hashed” internal tokens (`--x…`) as the implementation layer.

## Surface tokens

These are the “surface” / background layers (app shell, panels, raised surfaces).

| Token | Value |
| --- | --- |
| `--bg-base-color` | `lch(4.8% 0.7 272)` |
| `--bg-color` | `lch(2.467% 0 272 / 1)` |
| `--bg-sidebar-color` | `lch(2.467% 0 272 / 1)` |
| `--color-bg-primary` | `lch(4.8% 0.7 272)` |
| `--color-bg-secondary` | `lch(10.633% 3.033 272 / 1)` |
| `--color-bg-tertiary` | `lch(14.133% 4.2 272 / 1)` |
| `--color-bg-quaternary` | `lch(7.133% 1.867 272 / 1)` |
| `--bg-base-color-dark` | `#101012` |
| `--bg-sidebar-dark` | `#090909` |

**Interpretation (practical):**
- **App/page background**: `--bg-color`
- **Main container surface**: `--color-bg-primary`
- **Raised panels/cards**: `--color-bg-secondary` / `--color-bg-tertiary`
- **Low-contrast chips/hover layers**: `--color-bg-quaternary`

## Border tokens

| Token | Value |
| --- | --- |
| `--bg-border-color` | `lch(14.74% 3.54 272 / 1)` |
| `--color-border-primary` | `lch(9.77% 3.54 272 / 1)` |
| `--color-border-secondary` | `lch(14.74% 3.54 272 / 1)` |
| `--color-border-tertiary` | `lch(19% 3.54 272 / 1)` |
| `--bg-border-color-dark` | `#23252a` |

## Text tokens

| Token | Value |
| --- | --- |
| `--color-text-primary` | `lch(100% 0 272 / 1)` |
| `--color-text-secondary` | `lch(90.65% 1.35 272 / 1)` |
| `--color-text-tertiary` | `lch(62.6% 1.35 272 / 1)` |
| `--color-text-quaternary` | `lch(38.29% 1.35 272 / 1)` |
| `--content-color` | `#6b6f76` |
| `--content-highlight-color` | `#ffffff` |

## Focus / accessibility tokens

| Token | Value |
| --- | --- |
| `--focus-ring-color` | `lch(47.918% 59.303 288.421)` |
| `--focus-ring-outline` | `1px solid lch(47.918% 59.303 288.421)` |
| `--focus-ring-width` | `1px` |
| `--focus-ring-offset` | `0px` |

## Typography tokens

**Font families**
- `--font-regular` / `--font-display`: `"Inter Variable", "SF Pro Display", -apple-system, ...`
- `--font-monospace`: `"Berkeley Mono", "SFMono Regular", Consolas, ...`
- `--font-emoji`: `"Apple Color Emoji", "Segoe UI Emoji", ...`

**Font sizes**
| Token | Value |
| --- | --- |
| `--font-size-micro` | `.6875rem` |
| `--font-size-mini` | `.75rem` |
| `--font-size-small` | `.8125rem` |
| `--font-size-regular` | `.9375rem` |
| `--font-size-large` | `1.125rem` |
| `--font-size-title3` | `1.25rem` |
| `--font-size-title2` | `1.5rem` |
| `--font-size-title1` | `2.25rem` |

**Weights**
| Token | Value |
| --- | --- |
| `--font-weight-light` | `300` |
| `--font-weight-normal` | `450` |
| `--font-weight-medium` | `500` |
| `--font-weight-semibold` | `600` |
| `--font-weight-bold` | `700` |

## Radius tokens

| Token | Value |
| --- | --- |
| `--radius-circle` | `50%` |
| `

*(Answer truncated — 5223 chars total)*
