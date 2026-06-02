---
title: "Resumen diseño reset"
type: guide
created: 2025-12-23
updated: 2025-12-23
source: chatgpt-export
conversation_id: 694a1e39-7cb8-832c-a47d-d9ed327c3511
message_count: 6
tags: [chatgpt, import, code]
---
# Resumen diseño reset

**Related:** [[personal_life]]

> Conversation ID: 694a1e39-7cb8-832c-a47d-d9ed327c3511
> Created: 2025-12-23T04:44:43Z
> Updated: 2025-12-23T05:47:48Z
> Messages: 6

---

## User

sumaruze

---

## Assistant

Mr. White, here’s a concise summary:

**Summary — *A design reset (Part I)* by Karri Saarinen**

- **Redesigns are inevitable.** No product design is timeless. Continuous shipping creates **design debt** that eventually degrades coherence and user experience.
- **Incremental changes cause imbalance.** While small updates are efficient, they fragment the overall experience. Design debt should be paid off in **large, periodic resets** (every ~2–3 years).
- **Delay increases risk.** Waiting too long makes products feel dated and opens the door for faster, more modern competitors.
- **Redesigns require CEO backing.** Only the CEO can provide the authority and protection needed to redesign the entire product surface.
- **Tie redesigns to strategy.** Successful resets align with broader company shifts (e.g., new product direction or platform focus).
- **Use concept designs first.** Treat early work as “conceptual” to reduce resistance, build alignment, and gradually make the new direction feel inevitable.
- **Linear’s case.** entity["company","Linear","software company"] is evolving from an issue tracker into a full product development system, requiring a foundational UI reset to support future planning workflows.
- **Next step.** Part II explains how the concept was turned into a real, shippable redesign.

Author: **entity["people","Karri Saarinen","designer and ceo"]**  
Referenced example: entity["company","Airbnb","hospitality company"] mobile redesign as a strategic shift driver.

If you want, I can distill this into **actionable principles for founders** or **a checklist for deciding when to redesign**.

---

## User

again

---

## Assistant

Mr. White, here’s a concise **summary of Part II**:

**Summary — *How we redesigned the Linear UI (Part II)***

- **Goal:** Create a more cohesive, timeless UI to support Linear’s shift from an issue tracker to a full product development system.
- **Small, focused team.** The redesign started as a solo concept effort by **entity["people","Karri Saarinen","designer and ceo"]**, then expanded to a tight designer–engineer group to move fast.
- **Scope discipline.** Navigation changes were intentionally avoided due to risk; the focus stayed on UI chrome, hierarchy, density, and clarity.
- **Concept → prototype quickly.** Hundreds of Figma screens explored; a clear “north star” concept guided rapid prototyping.
- **Stress testing before shipping.** Designs were tested across:
  - **Environment:** macOS, Windows, and browser (Electron constraints).
  - **Appearance:** Light/dark themes rebuilt using **LCH color space** for perceptual consistency and accessibility.
  - **Hierarchy:** All major views (list, board, timeline, split, fullscreen).
- **Theme system simplification.** Reduced from ~98 variables to 3 (base, accent, contrast), enabling consistent theming and high-contrast accessibility modes.
- **Execution speed.** Dedicated team, feature flags, internal dogfooding, private beta, then gradual GA rollout.
- **Timeline:** ~6 weeks end to end.
- **Key principle:** Redesigns should be **fast, opinionated, and fully resourced**—not side projects—or they create new design debt immediately.

Company context: **entity["company","Linear","software company"]**

If you want, I can extract **founder-level lessons** or turn this into a **playbook for running a high-speed redesign**.

---

## User

spec the design system colors

---

## Assistant

Mr. White, here is a **clean, implementation-ready color system spec** based on Linear’s redesign.

---

## Design System Color Spec (Linear-style)

**Company reference:** entity["company","Linear","software company"]

### 1. Color Model (Non-Negotiable)
- **Color space:** **LCH** (not HSL / RGB)
- **Rationale:** Perceptual uniformity  
  - Equal lightness values look equally bright to humans
  - Enables predictable theming, contrast control, and accessibility

---

### 2. Core Theme Inputs (Only 3 Variables)

```text
Base Color     — Neutral foundation (gray-tinted hue)
Accent Color  — Brand / interactive emphasis
Contrast      — Scalar (0–100)
```

These three values **generate all other colors**.

---

### 3. Generated Color Layers (Derived)

All UI colors are computed from the inputs above.

#### Surfaces
- Background
- Elevated surface
- Panel
- Modal
- Overlay / translucent layers

#### Content
- Primary text
- Secondary text
- Muted text
- Icons (neutral + accent)
- Borders / dividers

#### Controls
- Default
- Hover
- Active
- Disabled
- Focus

> No hardcoded hex values per component.

---

### 4. Contrast System (Critical)

- **Contrast = continuous variable**, not presets
- Example:
  - Contrast 30 → soft, low-strain UI
  - Contrast 100 → high-contrast accessibility mode

This enables:
- Automatic WCAG compliance
- User-adjustable accessibility modes
- One theme engine for all needs

---

### 5. Light & Dark Mode (Same Engine)

- Light and Dark themes use **identical generation logic**
- Difference is **base lightness**, not color math
- Ensures:
  - Visual parity
  - Faster iteration
  - Zero drift between modes

---

### 6. Rules & Constraints

- ❌ No per-theme overrides
- ❌ No manual tweaking of derived colors
- ❌ No one-off exceptions for features
- ✅ All UI colors must be traceable to the 3 inputs
- ✅ Designers and engineers speak the same variables

---

### 7. Outcome

- Reduced theme variables from ~**98 → 3**
- Faster design iteration
- Consistent density, hierarchy, and readability
- Scales across platforms (Electron, web, native)
- Future-proof against design debt

---

If you want, I can:
- Translate this into **design tokens (JSON)**  
- Produce a **Figma-ready variable schema**  
- Or adapt it for **Tailwind / CSS variables**


**Topic:** [[chatgpt-clusters/personal_life]]
