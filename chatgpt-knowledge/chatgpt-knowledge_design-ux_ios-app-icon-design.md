---
title: "iOS app icon design"
type: guide
created: 2025-11-17
updated: 2025-11-17
source: chatgpt-export
topic: design-ux
message_count: 10
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# iOS app icon design

> **Source:** ChatGPT conversation
> **Date:** 2025-11-17T16:14:57Z
> **Messages:** 10
> **Topic:** design-ux

## Question

Design an iOS app icon for a body aesthetics tracking app called LogYourBody.
The icon should be a black rounded square with a subtle “liquid glass” look, using blacks and greys as the primary colors and a single teal accent (#6EE7F0).
In the center, place a minimal, geometric V-taper male torso silhouette drawn with clean light-grey lines, no head or details, just shoulders tapering to a narrow waist.
Surround the torso with a partial teal progress ring that looks like a glowing HUD arc, not a full circle.
Keep the style flat-modern, high contrast, no skeuomorphic textures, and make sure it reads clearly even at small sizes.

## Answer

Here’s a precise spec you can hand to a designer (or implement directly in Figma/Sketch) for **LogYourBody**.

---

## 1. Canvas & Base Shape

- **Canvas:** 1024 × 1024 px (exportable to iOS sizes).
- **Icon shape:** Rounded square with **corner radius ≈ 220 px** (standard iOS squircle-like feel).
- **Background color:** Almost-black with subtle “liquid glass” depth:
  - Solid fallback: `#020617`
  - Optional subtle vertical gradient:
    - Top: `#020617`
    - Bottom: `#050816`

No noise, no textures, no bevels — just clean gradient to imply depth.

---

## 2. “Liquid Glass” Look (Subtle Only)

Add *very subtle* lighting to avoid skeuomorphism:

1. **Inner top highlight (overlay layer):**
   - Shape: same rounded square, inset by ~24 px.
   - Gradient:  
     - Top: white at 6–8% opacity  
     - Bottom: transparent.
   - Blend mode: `Screen` or `Soft Light`.
2. **Very soft inner shadow on bottom:**
   - Color: black at 20–30% opacity.
   - Offset: 0, +18 px.
   - Blur: ~60 px.
   - Spread: 0.

The result: a gentle glassy depth while still reading as flat-modern.

---

## 3. Torso Silhouette (Centerpiece)

**Style:** Minimal, geometric, line-art. No head, no abs, no nipples — just V-taper.

- **Placement:** Centered.
- **Bounding box:** ~ 56% of canvas height (about 570 px tall) and proportionally wide.
- **Stroke:**
  - Color: light grey `#E5E7EB`
  - Stroke width: **4–5% of canvas width** (~40–50 px at 1024 px).
  - Caps: Round.
  - Joins: Round.

**Shape breakdown (one continuous path):**

- Start at left shoulder:
  - Slightly curved horizontal shoulder line (from about x=320 to x=704 at y≈360).
- From each shoulder, draw a clean diagonal down to the narrow waist:
  - Left shoulder → left oblique line inward to about x=430, y=580.
  - Right shoulder → mirror to about x=594, y=580.
- At the waist, slightly curve inward again to indicate a tight V:
  - A short, shallow U-shaped curve at the bottom (waist) around y≈620.
- Optionally indicate lats with **two small inner lines**:
  - Short diagonal strokes starting under each shoulder, but keep them short and subtle so it doesn’t clutter at small sizes.

No interior anatomy; the V-shape and shoulder width do the aesthetic work.

---

## 4. Teal HUD Progress Arc

**Goal:** A partial glowing ring around the torso — HUD / fitness tracker feel.

- **Color:** Teal `#6EE7F0`.
- **Shape:** Circular arc centered on the icon, behind or just around the torso.
- **Radius:** 
  - Outer radius ≈ 78% of half-canvas (~400 px from center).
  - Thickness: **6–7% of canvas width** (~60–70 px).
- **Arc span:** Not a full circle.
  - Start angle: ~210° (around 7 o’clock).
  - End angle: ~330° (around 11 o’clock).
  - This gives an open lower-left area and a strong upper-right sweep.
- **Stroke style:**
  - Caps: Round.
  - No dash pattern (solid arc), to keep it readable at small sizes.

**Glow treatment:**

1. Base arc:
   - Solid `#6EE7F0`.
2. Outer glow:
   - Same teal, 40–50% opacity.
   - Blur: ~50–70 px.
3. Op

*(Answer truncated — 4517 chars total)*

## Question

Generate it for me

## Question

Looks great. Now give me a version where the ring is a little more blue and less green. Just slightly. And also make it fill the full frame so I can drop into Xcode directly rather than it mocking up the background and tile design

## Question

Perfect. Now can we try one where the person is slightly less literal and more abstract 

## Question

Better but maybe even simpler 

## Question

Cool but maybe more curved and less sharp

## Question

That’s it. But remove the neck so it’s just 4 stroke lines and the shoulders don’t connect 

## Question

Great now incorporate all the rules of design and golden ratios and such to adjust the strokes so everything fits and feels perfect and aesthetically pleasing 

## Question

Make it occupy more space to align with the iOS 26 standards 
