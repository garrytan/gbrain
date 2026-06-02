---
conversation_id: 695ece54-b8c4-8327-9dfb-5d71e8f4ee18
created: 2026-01-07
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Linear Design System OKLCH
type: guide
updated: 2026-01-07
---

# Linear Design System OKLCH

> Conversation ID: 695ece54-b8c4-8327-9dfb-5d71e8f4ee18
> Created: 2026-01-07T21:21:25Z
> Updated: 2026-01-07T21:26:24Z
> Messages: 6

---

## User

explain to me linear design system and okthc

---

## Assistant

Mr. White,

Below is a clear, practical explanation of **Linear Design System** and **OKLCH**—and why they’re often mentioned together.

---

## Linear Design System

image_group{"query":["Linear app interface design","Linear design system components","Linear app UI dark mode","Linear typography UI"]}

The **Linear Design System** is the internal UI system used by entity["company","Linear","issue tracking software company"]. It’s widely studied because it exemplifies **high-performance, low-noise interface design**.

### Core characteristics
- **Speed-first UX**  
  Everything is optimized for fast interaction: keyboard shortcuts, minimal animations, zero visual clutter.
- **Extreme consistency**  
  Spacing, typography, motion, and color are mathematically regular. Nothing is “eyeballed.”
- **Low visual entropy**  
  Muted palettes, limited contrast spikes, and restrained hierarchy reduce cognitive load.
- **Systematic motion**  
  Animations are subtle, short, and informative—never decorative.
- **Dark-mode native**  
  The system is designed primarily for dark surfaces, not retrofitted.

### Why it matters
Linear shows what happens when a design system is treated like **infrastructure**, not branding. The result is:
- Faster user throughput
- Lower mental fatigue
- Higher trust in the interface

---

## OKLCH (often mistyped as “okthc”)

image_group{"query":["OKLCH color space diagram","OKLCH vs HSL color comparison","perceptual color space chart","color lightness chroma hue diagram"]}

**OKLCH** is a modern, perceptual color space. Unlike RGB or HSL, it aligns closely with **how humans actually perceive color**.

It has three components:
- **L – Lightness** (how bright a color appears)
- **C – Chroma** (color intensity/saturation)
- **H – Hue** (the color angle, like red vs blue)

### Why OKLCH is superior
- **Perceptual uniformity**  
  Increasing lightness by the same amount *actually looks* like the same increase.
- **Predictable contrast**  
  Critical for accessibility and dark-mode interfaces.
- **Safer color scaling**  
  You can generate lighter/darker variants without colors “breaking” or shifting hue.
- **Future-proof**  
  Native support is expanding in modern CSS and design tools.

### Practical example
With OKLCH, you can:
- Define a single hue
- Systematically vary lightness and chroma
- Get consistent results across themes and states

No guesswork. No manual tweaking.

---

## Why Linear + OKLCH pair so well

Linear’s design philosophy demands:
- Mathematical consistency
- Predictable contrast
- Minimal visual noise

OKLCH provides the **color math** that makes this possible.

Together, they enable:
- Clean dark-mode palettes
- Scalable semantic colors (success, error, warning)
- Reliable accessibility without constant overrides

---

### Bottom line
- **Linear Design System** = discipline, speed, and consistency applied to UI.
- **OKLCH** = the color model that makes that discipline feasible at scale.

If you want, I can:
- Break down how to implement OKLCH in CSS today  
- Show how to build a Linear-style color system from scratch  
- Compare OKLCH vs HSL/RGB numerically and visually

---

## User

how do we implement in tailwind

---

## Assistant

Mr. White,

Here is the **correct, production-grade way** to implement **OKLCH in Tailwind** (Linear-style), without hacks.

---

## 1. Use OKLCH as CSS variables (single source of truth)

Define **semantic color tokens**, not raw colors.

```css
/* globals.css */
:root {
  /* Base surfaces */
  --bg: oklch(12% 0.02 260);
  --bg-elevated: oklch(16% 0.025 260);

  /* Text */
  --text-primary: oklch(92% 0.01 260);
  --text-secondary: oklch(72% 0.02 260);

  /* Accent */
  --accent: oklch(65% 0.18 250);
  --accent-hover: oklch(70% 0.18 250);

  /* Status */
  --success: oklch(70% 0.16 145);
  --error: oklch(62% 0.22 25);
}
```

**Why this matters**
- OKLCH lives in CSS (not Tailwind config)
- Tokens are semantic → scalable
- Dark/light themes become trivial

---

## 2. Map CSS variables into Tailwind

```js
// tailwind.config.js
export default {
  theme: {
    extend: {
      colors: {
        bg: 'oklch(var(--bg))',
        'bg-elevated': 'oklch(var(--bg-elevated))',

        text: {
          primary: 'oklch(var(--text-primary))',
          secondary: 'oklch(var(--text-secondary))',
        },

        accent: {
          DEFAULT: 'oklch(var(--accent))',
          hover: 'oklch(var(--accent-hover))',
        },

        success: 'oklch(var(--success))',
        error: 'oklch(var(--error))',
      },
    },
  },
};
```

Now Tailwind utilities work normally:

```html
<div class="bg-bg text-text-primary">
<button class="bg-accent hover:bg-accent-hover">
```

No plugins. No runtime cost.

---

## 3. Linear-style lightness scaling (the key insight)

Instead of random shades (`500`, `600`, etc.), scale **L only**.

```css
:root {
  --accent-h: 250;
  --accent-c: 0.18;

  --accent-400: oklch(75% var(--accent-c) var(--accent-h));
  --accent-500: oklch(65% var(--accent-c) var(--accent-h));
  --accent-600: oklch(55% var(--accent-c) var(--accent-h));
}
```

This guarantees:
- No hue drift
- No saturation collapse
- Perfect contrast ramps

---

## 4. Dark / light themes (zero duplication)

```css
:root {
  --bg: 12% 0.02 260;
  --text-primary: 92% 0.01 260;
}

.light {
  --bg: 98% 0.01 260;
  --text-primary: 12% 0.02 260;
}
```

Tailwind stays unchanged.

```html
<html class="light">
```

---

## 5. Accessibility (facts, not vibes)

OKLCH lets you **guarantee contrast** by controlling **L**.

Rule of thumb:
- Text on dark bg → ΔL ≥ **60**
- Muted text → ΔL ≥ **40**
- Disabled → ΔL ~ **25–30**

This is why Linear feels effortless to read.

---

## 6. Browser support reality (2026)

- Chromium, Safari, Firefox: **OKLCH fully supported**
- Fallbacks are unnecessary unless you target legacy enterprise browsers

---

## Recommended mental model

| Old Tailwind | Linear / OKLCH |
|-------------|---------------|
| `blue-500` | `accent` |
| Shade guessing | Lightness math |
| Color = styling | Color = system |
| Tweaking by eye | Deterministic |

---

### Bottom line
- Put **OKLCH in CSS variables**
- Expose them through Tailwind
- Scale **lightness, not hex values**
- Name **semantically**, not numerically

If you want, I can:
- Generate a **Linear-grade color palette** for your product
- Add **WCAG-safe lightness math**
- Show **real UI examples** using these tokens

---

## User

can you spec this as a prompt for claude code to revampe all our marketing pages to respect it and be aligned with exactly what linear.app uses on their marketing pages for differnet elements

---

## Assistant

Mr. White,

Below is a **copy-paste ready prompt** you can give to **Claude Code** to systematically refactor all marketing pages to a **Linear-grade design system** using **OKLCH + Tailwind**, aligned with how Linear structures and styles its **marketing site** (not the app UI).

---

### Claude Code – System Design Refactor Prompt

:::writing{id="59341" variant="standard"}
You are acting as a **principal design systems engineer** tasked with refactoring all marketing pages to match the **visual, structural, and semantic design system used by Linear.app’s marketing site**.

Your goal is **not imitation by pixels**, but **replication of principles, constraints, and structure**.

---

## Core Objectives (Non-Negotiable)

1. **Adopt OKLCH as the color foundation**
   - All colors must be defined as **CSS variables using OKLCH**
   - No hex, RGB, HSL, or Tailwind default palettes
   - Colors must be **semantic tokens**, not numeric shades

2. **Tailwind remains the utility layer**
   - Tailwind should consume CSS variables
   - No hardcoded colors in components
   - No arbitrary values unless strictly required

3. **Match Linear’s marketing design philosophy**
   - Low visual entropy
   - Muted surfaces
   - Precise spacing
   - Calm hierarchy
   - Strong typography rhythm
   - Minimal but intentional motion

---

## Color System Specification

### Token Categories
Define tokens for:
- Backgrounds (base, elevated, subtle)
- Text (primary, secondary, muted)
- Accent (primary CTA, hover, pressed)
- Borders (default, subtle)
- Status (success, error, warning)

### Rules
- Scale **lightness (L)** only for variants
- Hue (H) and Chroma (C) must remain constant per semantic color
- Accent chroma should be restrained (no neon)
- Background chroma must be near-zero

Example structure (conceptual, not literal):
- `--bg`
- `--bg-elevated`
- `--text-primary`
- `--text-secondary`
- `--accent`
- `--accent-hover`

---

## Typography System (Critical)

### Fonts
- Use a **modern grotesk / neo-grotesk** stack similar to Linear’s marketing site
- No decorative fonts
- Prefer system performance over novelty

### Hierarchy
Implement a **tight, minimal scale**:
- Hero headline
- Section headline
- Subheadline
- Body
- Caption / metadata

Rules:
- Headlines: strong weight, low letter-spacing
- Body: high readability, relaxed line-height
- No dramatic size jumps
- Avoid overuse of bold

---

## Layout & Spacing

- Use **8px-based spacing**
- Large vertical rhythm (Linear breathes vertically)
- Avoid dense grids
- Prefer single-column layouts with controlled max-widths
- White space is intentional, not filler

---

## Components Alignment

### Buttons
- Flat or near-flat
- No heavy shadows
- Subtle hover via **lightness shift**, not color change
- Rounded but not pill-shaped

### Cards / Panels
- Slight background elevation
- Soft borders or none
- No strong outlines
- Calm hover (if any)

### Navigation
- Minimal
- No visual noise
- Clear hierarchy
- Accent color used sparingly

---

## Motion & Interaction

- Animations must be:
  - Short
  - Purposeful
  - Subtle
- No bounce, spring, or playful easing
- Prefer opacity + transform
- Motion should communicate structure, not delight

---

## Accessibility Constraints

- Text contrast must be guaranteed via **lightness math**
- Do not rely on color alone to convey meaning
- All interactive elements must have clear hover/focus states

---

## Implementation Instructions

1. Introduce a **global design token layer** (CSS variables)
2. Refactor Tailwind config to reference tokens only
3. Update all marketing components to:
   - Use semantic colors
   - Respect spacing and typography rules
4. Remove legacy colors, ad-hoc spacing, and visual noise
5. Keep code minimal, readable, and systematic

---

## Evaluation Criteria

A successful result:
- Feels calm, confident, and premium
- Matches Linear’s marketing site **in restraint and clarity**
- Looks intentional at every breakpoint
- Can scale without visual drift

Do not add flair.  
Do not invent branding.  
Do not over-design.

Build a **system**, not pages.
:::

---

If you want, I can:
- Tighten this to **Claude Code–specific directives**
- Add **file-by-file refactor instructions**
- Generate a **before/after checklist** to verify alignment


**Topic:** [[chatgpt-clusters/design_ux]]
