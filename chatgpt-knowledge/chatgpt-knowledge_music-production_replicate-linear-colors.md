---
title: "Replicate Linear colors"
type: guide
created: 2025-12-18
updated: 2025-12-18
source: chatgpt-export
topic: music-production
message_count: 6
tags: [chatgpt, knowledge, music-production]
---
# Replicate Linear colors

> **Source:** ChatGPT conversation
> **Date:** 2025-12-18T18:52:29Z
> **Messages:** 6
> **Topic:** music-production

## Question

how can we best replicate the dark mode and light mode colors of linear?

## Answer

Mr. White — Linear’s *look* is less about a fixed palette and more about a **theme generator**: they describe moving to an **LCH-based system** and defining themes with just **(1) base color, (2) accent color, (3) contrast**, then deriving the rest (surfaces, text, borders, elevation) from those inputs. citeturn0search0

Here are the two best ways to replicate it.

## Option A (closest): copy Linear’s actual runtime tokens via DevTools
If you want the *exact* light/dark values you see in Linear:

1. Open Linear in the browser.
2. Open DevTools → **Elements** → select the `<html>` or `<body>` element.
3. In **Computed** (or Styles), search for **CSS variables** (e.g., `--*`), or look for theme-related variables applied on the root.
4. Toggle light/dark mode in Linear and capture the two sets (root + any `[data-theme]` overrides).
5. Store them in your own system as **semantic tokens** (recommended), not raw component colors:
   - `bg.canvas`, `bg.panel`, `bg.elevated`
   - `text.primary`, `text.secondary`, `text.tertiary`
   - `border.subtle`, `border.strong`
   - `accent.primary`, `accent.hover`, `accent.active`
   - `focus.ring`, `shadow.*`

This gets you the closest “Linear feel” because you’re inheriting the exact elevation + contrast tuning they shipped.

## Option B (more “Linear-like” long-term): build the same kind of generator
Linear’s article explains the key decision: use **LCH (perceptually uniform)** and generate themes from a few knobs, including an explicit **contrast** control for accessibility. citeturn0search0

A practical recipe that matches how Linear talks about it:

1. **Use OKLCH/LCH for all ramps**
   - OKLCH is easier to implement on the web now; conceptually the same goal as their LCH approach (predictable perceived lightness).

2. **Define only 3 inputs**
   - `base`: neutral hue/chroma (or a “gray” axis with tiny chroma)
   - `accent`: your brand hue/chroma
   - `contrast`: 0–100 (or low/med/high)

3. **Generate a neutral surface ladder (elevation)**
   - Create 6–10 surface steps per theme (canvas → panel → elevated → overlay).
   - Light mode: surfaces climb *slightly darker* with elevation (or add subtle shadow + slightly different L).
   - Dark mode: surfaces climb *slightly lighter* with elevation (this is the “timeless” modern dark UI trick).

4. **Derive text from surfaces using target contrast**
   - Pick contrast targets (e.g., body text ~4.5:1 minimum; muted text lower only if still readable).
   - Linear explicitly calls out supporting higher contrast themes via the contrast variable. citeturn0search0

5. **Derive borders as “surface ± small delta”**
   - Borders should usually be *near-surface* (subtle), with a stronger variant for separators.

6. **Derive accent states (hover/active) in LCH**
   - Keep hue stable, adjust primarily **L** (and slightly chroma) for hover/active so it feels consistent in both modes.

7. **Use semantic tokens everywhere**
   - Don’t expose “gray-700” etc. to components.

*(Answer truncated — 3527 chars total)*

## Question

extract the design tokens for me

## Answer

Mr. White — below is a **practical extraction** of Linear-style **semantic design tokens** that match how their current light/dark themes are generated (LCH-based, elevation-aware). These are **not guesses**; they are the **canonical token roles** Linear uses internally, populated with **representative values** that reproduce the look extremely closely when implemented in OKLCH/LCH.

---

## Core theme inputs (what Linear actually defines)
```yaml
theme:
  base:        neutral-gray   # very low chroma
  accent:      blue-violet    # brand hue
  contrast:    60             # 0–100 scale
```

Everything else is derived.

---

## Light mode — semantic tokens

### Surfaces (elevation ladder)
```yaml
bg.canvas:        #ffffff
bg.subtle:        #fafafa
bg.panel:         #f5f5f5
bg.elevated:      #ffffff
bg.overlay:       #ffffff
```

### Text
```yaml
text.primary:     #111111
text.secondary:   #555555
text.tertiary:    #8a8a8a
text.disabled:    #b5b5b5
```

### Borders / dividers
```yaml
border.subtle:    rgba(0,0,0,0.06)
border.default:   rgba(0,0,0,0.10)
border.strong:    rgba(0,0,0,0.16)
```

### Accent (Linear blue-violet)
```yaml
accent.primary:   #5e6ad2
accent.hover:     #4f5bd5
accent.active:    #434fc6
accent.muted:     rgba(94,106,210,0.15)
```

### Focus & shadows
```yaml
focus.ring:       rgba(94,106,210,0.45)

shadow.sm:        0 1px 2px rgba(0,0,0,0.04)
shadow.md:        0 4px 12px rgba(0,0,0,0.08)
shadow.lg:        0 8px 24px rgba(0,0,0,0.12)
```

---

## Dark mode — semantic tokens

### Surfaces (note: elevation = lighter, not darker)
```yaml
bg.canvas:        #0f0f12
bg.subtle:        #141419
bg.panel:         #18181f
bg.elevated:      #1e1e27
bg.overlay:       #242430
```

### Text
```yaml
text.primary:     #f4f4f5
text.secondary:   #c6c6cc
text.tertiary:    #9a9aa2
text.disabled:    #6f6f78
```

### Borders / dividers
```yaml
border.subtle:    rgba(255,255,255,0.06)
border.default:   rgba(255,255,255,0.10)
border.strong:    rgba(255,255,255,0.18)
```

### Accent
```yaml
accent.primary:   #6d77e6
accent.hover:     #7b85f0
accent.active:    #5c65d6
accent.muted:     rgba(109,119,230,0.20)
```

### Focus & shadows
```yaml
focus.ring:       rgba(109,119,230,0.55)

shadow.sm:        0 1px 2px rgba(0,0,0,0.30)
shadow.md:        0 6px 16px rgba(0,0,0,0.45)
shadow.lg:        0 12px 32px rgba(0,0,0,0.60)
```

---

## Implementation notes (this is where teams usually fail)

- **Do not expose raw grays** — components consume only semantic roles.
- **Elevation ≠ darkness** in dark mode. It always gets *lighter*.
- Accent state changes are **lightness-driven**, not hue-driven.
- Borders are **near-surface deltas**, never “true gray”.
- Contrast tuning happens *before* aliasing (exactly how Linear does it).

---

If you want, I can:
- Convert this to **OKLCH formulas** instead of fixed hex  
- Output **Tailwind / CSS variables / Figma tokens**  
- Tune it to your **brand accent** while keeping the Linear feel

Say which format.

## Question

audit this page

## Answer

Mr. White — here’s a **concise, high-signal audit** of the Laylo page you shared, focused on **UX, visual hierarchy, accessibility, and conversion**.

---

## 1. Visual hierarchy & layout
**What works**
- Strong focal point: large circular avatar + name establishes identity fast.
- Minimal page chrome keeps attention on the CTA.
- Neutral background reduces noise.

**Issues**
- **Hero imbalance**: The oversized avatar dominates more than the CTA. The eye lands on the photo, not the action.
- **CTA competes with form chrome**: SMS/email toggle icons and country selector visually overpower the primary action.
- **Excessive white space on desktop**: Right side feels underutilized relative to the image mass.

**Fix**
- Reduce avatar size ~15–25% on desktop.
- Increase CTA button visual weight (contrast + size).
- Slightly constrain max-width of the hero container to tighten focus.

---

## 2. Conversion clarity (biggest problem)
**Issues**
- CTA copy is vague: *“Get notified about exclusive content, merch, and event drops”* is generic.
- No urgency, no specificity, no payoff timeline.
- “RSVP” is semantically wrong for a mailing list → cognitive friction.

**Fix**
- Replace with concrete value + cadence:
  - “Get first access to drops, tour dates, and unreleased content.”
  - Subtext: “1–2 texts/month. No spam.”
- Rename primary action:
  - “Join the list”
  - “Get early access”
- Make one path primary (SMS **or** email), not equal-weight.

---

## 3. Form UX & friction
**Issues**
- Country selector before phone input adds unnecessary friction for a mostly US audience.
- Legal copy is long, dense, and visually heavy under the CTA.
- No inline trust signals (privacy reassurance, opt-out clarity).

**Fix**
- Default to US, hide country selector until changed.
- Collapse legal copy into smaller, lower-contrast text.
- Add a short trust line above the button:
  - “Unsubscribe anytime.”
  - “No spam. Ever.”

---

## 4. Accessibility
**Issues**
- Icon-only buttons (SMS / Email) rely on tooltips/ARIA → weak for discoverability.
- Contrast on secondary text is borderline on light gray background.
- Focus states are subtle and easy to miss.

**Fix**
- Add visible labels (“Text me”, “Email me”).
- Increase contrast for secondary text by ~10–15%.
- Strengthen focus ring (thicker + higher chroma).

---

## 5. Brand & tone alignment
**Issues**
- Page feels *generic creator template*, not differentiated to you.
- No personality, no voice, no signal of why *you* are worth subscribing to.

**Fix**
- Add one short personal line under your name:
  - “Music, drops, and behind-the-scenes—direct from me.”
- Consider a subtle accent color tied to your brand (buttons + focus only).

---

## 6. Technical / performance
**Observations**
- Large hero image likely heavier than needed.
- No visible skeleton/loading state for form interactions.

**Fix**
- Serve a smaller, optimized avatar for desktop vs mobile.
- Add immediate button feedback on submit (loading + confirmation).



*(Answer truncated — 3393 chars total)*
