---
title: "iOS app icon design"
type: note
created: 2025-11-17
updated: 2025-11-17
source: chatgpt-export
conversation_id: 691b4a00-f2b4-8333-ac90-764318758ac6
message_count: 10
tags: [chatgpt, import, long-form]
---
# iOS app icon design

> Conversation ID: 691b4a00-f2b4-8333-ac90-764318758ac6
> Created: 2025-11-17T16:14:57Z
> Updated: 2025-11-17T16:46:20Z
> Messages: 10

---

## User

Design an iOS app icon for a body aesthetics tracking app called LogYourBody.
The icon should be a black rounded square with a subtle “liquid glass” look, using blacks and greys as the primary colors and a single teal accent (#6EE7F0).
In the center, place a minimal, geometric V-taper male torso silhouette drawn with clean light-grey lines, no head or details, just shoulders tapering to a narrow waist.
Surround the torso with a partial teal progress ring that looks like a glowing HUD arc, not a full circle.
Keep the style flat-modern, high contrast, no skeuomorphic textures, and make sure it reads clearly even at small sizes.

---

## Assistant

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
3. Optional inner glow:
   - Slight, using a darker teal `#22A6B3` at 20–30% opacity, blur ~30 px.

Keep the glow subtle; it should read “HUD” not neon sign.

---

## 5. Composition & Alignment

- **Z-order (bottom → top):**
  1. Black gradient background.
  2. Inner shadow / highlight for glass effect.
  3. Teal progress arc.
  4. Torso line art.

- **Centering:**
  - Torso and arc share the same center point.
  - Torso height should fit comfortably *inside* the arc with ~10–15% padding from the arc’s inner edge.

---

## 6. Small Size Legibility Tweaks

When exporting smaller icons (e.g. 60×60, 40×40):

- Slightly **increase stroke thickness** proportionally:
  - Mobile exports: aim for torso line thickness that is **1.5–2 px** at 60×60.
  - Arc thickness should still be clearly thicker than torso lines.
- If needed, **remove the inner short lat lines** at very small sizes to avoid clutter.
- Ensure the background gradient remains very subtle so torso and arc are the main contrast elements.

---

## 7. Quick Implementation Checklist

- [ ] Rounded black square, subtle vertical gradient.
- [ ] Soft top highlight + bottom inner shadow for “liquid glass” depth.
- [ ] Light-grey V-taper torso line-art, centered, no internal details.
- [ ] Teal (#6EE7F0) partial HUD arc (210° → 330°), glowing slightly.
- [ ] High contrast, clean at 60×60, no textures, no extra colors.

If you’d like, Mr. White, I can also give you a ready-to-use SVG layout (paths and coordinates) that you can drop into a design tool.

---

## User

Generate it for me

---

## User

Looks great. Now give me a version where the ring is a little more blue and less green. Just slightly. And also make it fill the full frame so I can drop into Xcode directly rather than it mocking up the background and tile design

---

## User

Perfect. Now can we try one where the person is slightly less literal and more abstract 

---

## User

Better but maybe even simpler 

---

## User

Cool but maybe more curved and less sharp

---

## User

That’s it. But remove the neck so it’s just 4 stroke lines and the shoulders don’t connect 

---

## User

Great now incorporate all the rules of design and golden ratios and such to adjust the strokes so everything fits and feels perfect and aesthetically pleasing 

---

## User

Make it occupy more space to align with the iOS 26 standards 


**Topic:** [[chatgpt-clusters/coding_mobile]]
