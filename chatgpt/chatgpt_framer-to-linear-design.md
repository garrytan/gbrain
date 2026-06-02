---
conversation_id: 69594f9a-b05c-832e-9332-97f559fbac96
created: 2026-01-03
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Framer to Linear Design
type: note
updated: 2026-01-03
---

# Framer to Linear Design

> Conversation ID: 69594f9a-b05c-832e-9332-97f559fbac96
> Created: 2026-01-03T17:19:30Z
> Updated: 2026-01-03T17:20:44Z
> Messages: 2

---

## User

how cna i get framer to make this look more like linear.app

---

## Assistant

Mr. White — to get **Framer** feeling closer to **Linear**, focus on these levers (in roughly this order):

### 1) Typography (most important)
- Use **one UI sans** (Inter is fine).
- Set a tight type scale:
  - H1: **56–64px**, weight **650–750**, line-height **1.05–1.15**
  - H2: **32–40px**, weight **600–700**, line-height **1.15–1.25**
  - Body: **16–18px**, weight **400–500**, line-height **1.5–1.7**
- Reduce letter spacing on big headlines: **-0.02em to -0.04em**.

### 2) Spacing + layout constraints
- Use a strict container width: **1040–1120px max**.
- Build sections on a consistent vertical rhythm:
  - Section padding: **96–120px** top/bottom (desktop)
  - Card padding: **20–28px**
  - Gaps: **12 / 16 / 24 / 32 / 48** (pick a scale and stick to it)
- Keep paragraphs short: **55–75 characters per line**.

### 3) Colors (Linear-style dark)
- Background: near-black (not pure): **#0B0D10** to **#0E1116**
- Surfaces/cards: **#11151C**
- Border lines: **1px** with **white at ~8–12% opacity**
- Text:
  - Primary: **white ~90–95%**
  - Secondary: **white ~60–70%**
  - Tertiary: **white ~40–50%**
- Add a single accent (purple/blue) and use it sparingly for CTAs and highlights.

### 4) Cards, borders, shadows (subtle)
- Radius: **14–18px** (consistent everywhere).
- Borders over shadows:
  - Prefer **1px border + very soft shadow** (or no shadow).
  - If shadow: keep it extremely light + large blur.

### 5) Buttons (Linear feel)
- Primary button:
  - Height **40–44px**
  - Radius **10–12px**
  - Weight **600**
  - Add a *tiny* hover lift: translateY **-1px** + slightly brighter bg.
- Secondary button: transparent with border, same sizing.

### 6) Background “Linear glow”
In the hero section, add **one** subtle radial gradient layer:
- A large **radial** glow behind the headline (purple/blue at low opacity).
- Optional second glow offset to the side for depth.
In Framer: add a background layer or a rectangle behind content with a radial gradient + low opacity.

### 7) Simplify the copy + tighten sections
Linear pages are *spare*:
- One headline, one subhead, **2 CTAs**, then social proof.
- Turn paragraphs into **1–2 lines** max.
- Replace long “how it works” text with **3 short bullets**.

### 8) Micro-interactions
- Animate only key elements:
  - Fade + slight upward move on scroll (**10–16px**, 250–400ms).
  - Hover: subtle border brighten, slight lift.
Avoid bouncy or springy defaults.

---

If you tell me **what your current Framer structure is** (hero, features, testimonials, pricing), I’ll give you a concrete “Linear pass” for each section (exact sizes + color values + what to remove). **Which section looks least Linear right now: hero, cards/testimonials, or nav?**


**Topic:** [[chatgpt-clusters/design_ux]]
