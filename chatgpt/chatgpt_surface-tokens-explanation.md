---
title: "Surface Tokens Explanation"
type: guide
created: 2026-02-18
updated: 2026-02-18
source: chatgpt-export
conversation_id: 6995546a-189c-8329-b327-694db42b74c1
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# Surface Tokens Explanation

> Conversation ID: 6995546a-189c-8329-b327-694db42b74c1
> Created: 2026-02-18T05:56:08Z
> Updated: 2026-02-18T05:59:09Z
> Messages: 10

---

## User

what are the surdace tokens

---

## Assistant

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

---

## User

i mean the css of this app

---

## Assistant

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

---

## User

yes

---

## Assistant

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

---

## User

dev tools open. just ectract the whole design system pelase

---

## Assistant

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

---

## User

vendor-sentry.Deg_lyPw.js:6  __                                               _____          __          __           ______          v1.55973.0/\ \       __                                    /\  __`\       /\ \      __/\ \__       /\__  _\                       \ \ \     /\_\    ___      __     __     _ __    \ \ \/\ \  _ __\ \ \____/\_\ \ ,_\      \/_/\ \/     ___     ___        \ \ \  __\/\ \ /' _ `\  /'__`\ /'__`\  /\`'__\   \ \ \ \ \/\`'__\ \ '__`\/\ \ \ \/         \ \ \   /' _ `\  /'___\       \ \ \L\ \\ \ \/\ \/\ \/\  __//\ \L\.\_\ \ \/     \ \ \_\ \ \ \/ \ \ \L\ \ \ \ \ \_  __     \_\ \__/\ \/\ \/\ \__/  __    \ \____/ \ \_\ \_\ \_\ \____\ \__/.\_\\ \_\      \ \_____\ \_\  \ \_,__/\ \_\ \__\/\ \    /\_____\ \_\ \_\ \____\/\_\    \/___/   \/_/\/_/\/_/\/____/\/__/\/_/ \/_/       \/_____/\/_/   \/___/  \/_/\/__/\ \/    \/_____/\/_/\/_/\/____/\/_/                                                                                      \/The product development system for teams and agentsWE'RE HIRING: https://linear.app/careersCHANGELOG:    https://linear.app/changelog
preferences:1 Uncaught SyntaxError: Illegal return statement
preferences:1 Uncaught SyntaxError: Illegal return statement
preferences:1 Uncaught SyntaxError: Illegal return statement
preferences:1 Uncaught SyntaxError: Illegal return statement
preferences:1 Uncaught SyntaxError: Illegal return statement
VM725:1 Uncaught SyntaxError: Illegal return statement
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

vendor-sentry.Deg_lyPw.js:6 --bg-base-color: lch(4.8% 0.7 272);
--bg-base-color-dark: #101012;
--bg-base-color-light: #fcfcfc;
--bg-border-color: lch(14.74% 3.54 272 / 1);
--bg-border-color-dark: #23252a;
--bg-border-color-light: #e0e0e0;
--bg-color: lch(2.467% 0 272 / 1);
--bg-sidebar-color: lch(2.467% 0 272 / 1);
--bg-sidebar-dark: #090909;
--bg-sidebar-light: #f5f5f5;
--collapsible-mask-opacity: 0%;
--color-bg-primary: lch(4.8% 0.7 272);
--color-bg-quaternary: lch(7.133% 1.867 272 / 1);
--color-bg-quinary: 0;
--color-bg-secondary: lch(10.633% 3.033 272 / 1);
--color-bg-tertiary: lch(14.133% 4.2 272 / 1);
--color-border-primary: lch(9.77% 3.54 272 / 1);
--color-border-secondary: lch(14.74% 3.54 272 / 1);
--color-border-tertiary: lch(19% 3.54 272 / 1);
--color-text-primary: lch(100% 0 272 / 1);
--color-text-quaternary: lch(38.29% 1.35 272 / 1);
--color-text-secondary: lch(90.65% 1.35 272 / 1);
--color-text-tertiary: lch(62.6% 1.35 272 / 1);
--content-color: #6b6f76;
--content-color-dark: #6b6f76;
--content-color-light: #b0b5c0;
--content-highlight-color: #ffffff;
--content-highlight-color-dark: #ffffff;
--content-highlight-color-light: #23252a;
--control-border-radius: ;
--ease-in-circ: cubic-bezier(.6, .04, .98, .335);
--ease-in-cubic: cubic-bezier(.55, .055, .675, .19);
--ease-in-expo: cubic-bezier(.95, .05, .795, .035);
--ease-in-out-circ: cubic-bezier(.785, .135, .15, .86);
--ease-in-out-cubic: cubic-bezier(.645, .045, .355, 1);
--ease-in-out-expo: cubic-bezier(1, 0, 0, 1);
--ease-in-out-quad: cubic-bezier(.455, .03, .515, .955);
--ease-in-out-quart: cubic-bezier(.77, 0, .175, 1);
--ease-in-out-quint: cubic-bezier(.86, 0, .07, 1);
--ease-in-quad: cubic-bezier(.55, .085, .68, .53);
--ease-in-quart: cubic-bezier(.895, .03, .685, .22);
--ease-in-quint: cubic-bezier(.755, .05, .855, .06);
--ease-out-circ: cubic-bezier(.075, .82, .165, 1);
--ease-out-cubic: cubic-bezier(.215, .61, .355, 1);
--ease-out-expo: cubic-bezier(.19, 1, .22, 1);
--ease-out-quad: cubic-bezier(.25, .46, .45, .94);
--ease-out-quart: cubic-bezier(.165, .84, .44, 1);
--ease-out-quint: cubic-bezier(.23, 1, .32, 1);
--editor-block-menu-offset: 28px;
--editor-block-menu-size: 20px;
--editor-block-radius: 6px;
--editor-block-spacing: 1rem;
--editor-block-spacing-large: calc(1.375 * 1rem);
--editor-block-spacing-small: calc(.375 * 1rem);
--editor-bullet-disc-offset: .5em;
--editor-bullet-disc-width: .5em;
--editor-font-size: .9375rem;
--editor-last-invisible-paragraph-spacing: 10px;
--editor-letter-spacing: -.00666667em;
--editor-line-height: 1.6;
--editor-list-inset: 1.5rem;
--editor-safe-area: 16px;
--editor-todolist-checkbox-width: 14px;
--focus-ring-color: lch(47.918% 59.303 288.421);
--focus-ring-offset: 0px;
--focus-ring-outline: 1px solid lch(47.918% 59.303 288.421);
--focus-ring-width: 1px;
--font-display: "Inter Variable", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", "Linear Thai", sans-serif;
--font-emoji: "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Segoe UI", "Twemoji Mozilla", "Noto Color Emoji", "Android Emoji";
--font-monospace: "Berkeley Mono", "SFMono Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
--font-regular: "Inter Variable", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", "Linear Thai", sans-serif;
--font-size-large: 1.125rem;
--font-size-largePlus: 1.125rem;
--font-size-micro: .6875rem;
--font-size-microPlus: .6875rem;
--font-size-mini: .75rem;
--font-size-miniPlus: .75rem;
--font-size-regular: .9375rem;
--font-size-regularPlus: .9375rem;
--font-size-small: .8125rem;
--font-size-smallPlus: .8125rem;
--font-size-title1: 2.25rem;
--font-size-title2: 1.5rem;
--font-size-title3: 1.25rem;
--font-weight-bold: 700;
--font-weight-light: 300;
--font-weight-medium: 500;
--font-weight-normal: 450;
--font-weight-semibold: 600;
--radius-circle: 50%;
--radius-rounded: 9999px;
--scrollbar-width: 0px;
--sidebar-width: 255px;
--speed-highlightFadeIn: 0s;
--speed-highlightFadeOut: .15s;
--speed-quickTransition: .1s;
--speed-regularTransition: .25s;
--speed-slowTransition: .35s;
--x106vkwq: 5px;
--x10m5hot: #fcfaff;
--x114lnz8: #c9ffff;
--x115ent3: #07d2e5;
--x11872iu: 0 0 0 1px #5e69d1;
--x11ndltn: #191b1f;
--x12fhtcv: 0.25s;
--x12lkabp: #0f1011;
--x132bcqu: #3cb652;
--x13g9ne9: #967000;
--x13wbu44: #ff5f60;
--x13z5sx7: #d9343f;
--x14id3h5: #f34e52;
--x14mcv2c: 500;
--x166lfkh: #969799;
--x16cnifl: .8125rem;
--x16dys8j: #ff7235;
--x16oggyh: #ffcf00;
--x16omjg9: #26282f;
--x17axjfw: #353758;
--x180uarx: #212329;
--x18x5lpp: #ffffff;
--x1950ivc: #7281ff;
--x1963xcn: #ffffff1e;
--x19wnoea: 0px 2px 8px #0000004c;
--x1aw1rfm: #d5ffd6;
--x1axyu6l: "Inter Variable", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", "Linear Thai", sans-serif;
--x1c42fo1: 0px 4px 4px -1px #0000000f, 0px 1px 1px 0px #0000001e;
--x1c6vacv: #5e69d1;
--x1cux1aw: #55ccff;
--x1cxrqua: #00ceff;
--x1dg9gkz: 0 1px 1px inset #0000001a, 0 1px 3px inset #0000001a, 0 2px 5px inset #00000026;
--x1duddbu: 1.125rem;
--x1e0qfn8: #e3e4e6;
--x1e4yew5: #5e6ad2;
--x1em6omi: 2.25rem;
--x1f62wcm: #ffffff4c;
--x1fnykki: #ff8c4d;
--x1g7h9b4: #00e8ff;
--x1gm0h57: #008a2a;
--x1go50c6: #969799;
--x1h6hjc: 0.1s;
--x1i5jen0: #7881ed;
--x1i8uhct: 700;
--x1ibmueu: #dbffff;
--x1ihf1t9: #141518;
--x1jbsnip: #ffffff2d;
--x1k5b9uu: 450;
--x1kq0gl2: #e3e4e6;
--x1ks1ohb: #6e78e2;
--x1l448wz: #ffffff4c;
--x1lp8i39: #383a3f;
--x1nns58z: #17192d;
--x1notdih: 300;
--x1ousgx1: #fefeff;
--x1pcq1dm: #007def;
--x1re96k8: 0.35s;
--x1rjkp7e: #081b31;
--x1s6jrn1: #ffffff14;
--x1sh2oab: #ff8244;
--x1smbnfm: #79e7ff;
--x1sp1nh7: "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Segoe UI", "Twemoji Mozilla", "Noto Color Emoji", "Android Emoji";
--x1vmev9f: #191a1e;
--x1vp0dxh: #adbaff;
--x1x0qvdp: 0 0 0 0.5px #23252a;
--x1x4cgxy: #47bf5b;
--x1xdrpcn: .9375rem;
--x1xigm33: #3de261;
--x1y17p4d: #6c78e6;
--x1y9qbcn: #1e2025;
--x2odwqg: #ffffff;
--x2qviu2: #2c2e33;
--x2w6sjl: 0.15s;
--x2xxq8w: #00889c;
--x485r07: 600;
--x4cljr1: #1f2025;
--x4hzblp: #1f190e;
--x52lwyv: #ff9958;
--x54evbs: #ff6968;
--x59dbp7: #5a5b5d;
--x5fx5ih: #1d1f22;
--x5t34sx: #0a0a0a26;
--x72vvj3: 0.5px;
--x7tktu3: #26282d;
--x7vgbli: #26a544;
--x7ylchl: .9375rem;
--x8dmboc: 0 3px 8px #0000002f, 0 2px 5px #0000002f, 0 1px 1px #0000002f;
--x8x637w: #2a1411;
--x99a7n8: #cf4608;
--x9ku8zr: #5e69d1;
--x9ugv1t: #ffe7de;
--x9ybrk6: 0.8125rem;
--xai135j: #1e2025;
--xawh0s6: #111318;
--xb0u0nb: .75rem;
--xbyimlc: #ff8583;
--xbyjof2: 1px solid #23252a;
--xcit351: #1b1c20;
--xd05ikt: #091d21;
--xd7waoh: #f0bf00;
--xdf591: #0a0a0a26;
--xefufb8: #1a1d37;
--xel1uc5: 13vh;
--xfgduz4: #5b5c5e;
--xfif8e3: "Berkeley Mono", "SFMono Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
--xfnk854: #2c1214;
--xgqo555: #595a5c;
--xi07oti: #00b8cb;
--xi7v7s: #191b1f;
--xilmiwk: #ffffff66;
--xiwe9x: #0e1d12;
--xkqhomi: #292b30;
--xkus2id: #ffffff1e;
--xlcme14: #26282f;
--xlm7sa3: 1.25rem;
--xm3qdf0: #2f3152;
--xm3tzf5: #fffaa6;
--xm4qld0: #2c2e33;
--xmlhern: 6px 12px;
--xo031ep: #ffffff1e;
--xos2teq: #00000001;
--xpnqlzk: 0s;
--xprvzym: 1.5rem;
--xqufior: #edbf0a;
--xr0z2jl: .6875rem;
--xrapajs: #1a1c21;
--xrpsc95: #595a5c;
--xs4gwln: #636fd7;
--xt22jw: #ffd800;
--xt61g72: 0 4px 40px #00000026, 0 3px 20px #0000002f,0 3px 12px #0000002f, 0 2px 8px #0000002f, 0 1px 1px #0000002f;
--xtn391d: #00c8dc;
--xu0oz8c: #ffffff1e;
--xu5e804: 0 3px 8px #0000002f, 0 2px 5px #0000002f, 0 1px 1px #0000002f;
--xv13j1g: #f0bf00;
--xv9i5nf: #6cddff;
--xvka8mh: 1.125rem;
--xw3w3ld: #222328;
--xwgwkqd: #00000099;
--xxay8j2: #1f2241;
--xxcbaz9: #080808;
--xxpaqyv: .8125rem;
--xyjiww4: #0f1011;
--xyqq2fc: #fefeff;
--xyug5hn: .6875rem;
--xz2lfyu: .75rem;
--xz4najp: #e3e4e6;
--xz5fbl5: #151617;
--xzhbanc: #23252a;
--xzmh5ln: #ffeac6;
247

---

## Assistant

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
| `--radius-rounded` | `9999px` |
| `--editor-block-radius` | `6px` |

Note: `--control-border-radius` is currently empty in your dump (unset or overridden later).

## Motion tokens

**Durations**
| Token | Value |
| --- | --- |
| `--speed-quickTransition` | `.1s` |
| `--speed-regularTransition` | `.25s` |
| `--speed-slowTransition` | `.35s` |
| `--speed-highlightFadeOut` | `.15s` |
| `--speed-highlightFadeIn` | `0s` |

**Easing (selection)**
- `--ease-in-out-cubic`: `cubic-bezier(.645, .045, .355, 1)`
- `--ease-out-quint`: `cubic-bezier(.23, 1, .32, 1)`
- (You have the full ease set in the paste.)

## Layout / density tokens

| Token | Value |
| --- | --- |
| `--sidebar-width` | `255px` |
| `--scrollbar-width` | `0px` |
| `--editor-safe-area` | `16px` |

## Editor tokens

You have a full editor subsystem defined:
- sizing: `--editor-font-size: .9375rem`, `--editor-line-height: 1.6`
- spacing: `--editor-block-spacing: 1rem`, `--editor-block-spacing-large`, `--editor-block-spacing-small`
- list insets, checkbox widths, etc.

## Internal “hashed” tokens (`--x…`)

Those `--x...` variables are Linear’s **compiled token layer** (implementation details). They include:
- raw colors (many hex values)
- shadows/elevation (e.g. `--x19wnoea: 0px 2px 8px #0000004c;`, `--xt22jw: ...`)
- radii/padding snippets (e.g. `--xmlhern: 6px 12px;`)
- weights & font sizes duplicated

If you want the *full design system* in one clean spec, the next step is: **dump the variables as JSON** (so I can automatically group and de-dupe them). Use this exact snippet:

```js
(() => {
  const s = getComputedStyle(document.documentElement);
  const out = {};
  for (let i = 0; i < s.length; i++) {
    const name = s[i];
    if (name.startsWith("--")) out[name] = s.getPropertyValue(name).trim();
  }
  copy(JSON.stringify(out, null, 2));
  console.log("Copied tokens:", Object.keys(out).length);
})();
```

Paste that JSON here and I’ll return:
- **Canonical token names** (surface/ink/border/brand/state)
- **Alias mapping** (semantic ↔ hashed)
- **Elevation scale** (shadow 1/2/3…)
- **Spacing scale**, **radii scale**, **typography scale**
- A ready-to-use **`tokens.json`** structure (Style Dictionary / Tailwind / CSS variables)


## See Also
- [[chatgpt/chatgpt_5d-camelot-key-explanation]]
- [[chatgpt/chatgpt_abs-routine-explanation]]
- [[chatgpt/chatgpt_account-explanation-request]]
- [[chatgpt/chatgpt_ai-deal-workflow-explanation]]
- [[chatgpt/chatgpt_allied-axe-explanation]]
