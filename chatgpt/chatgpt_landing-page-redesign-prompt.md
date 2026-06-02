---
conversation_id: 69a3c49b-8c04-8327-847e-d7070943ce57
created: 2026-03-01
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Landing Page Redesign Prompt
type: note
updated: 2026-03-01
---

# Landing Page Redesign Prompt

> Conversation ID: 69a3c49b-8c04-8327-847e-d7070943ce57
> Created: 2026-03-01T04:47:14Z
> Updated: 2026-03-01T04:48:14Z
> Messages: 4

---

## User

give me a prompt to go throuhg out landing page and without changing content improve the layout and the design. inspired by linear.app design system. using high fidentilty mockups (real components) and beautiful typegrophuy and spacing. things all on grid etc. loop and iterate to perfection. for gemini 3.1 pro high thinking

---

## Assistant

Mr. White, paste this into Gemini 3.1 Pro (High / Thinking). Replace the bracketed parts with your URL and any constraints.

:::writing{id="57410" variant="standard"}
You are a senior product designer and design system expert. Your job is to redesign the *layout and visual design* of an existing landing page **without changing any copy/content or meaning** (no rewriting text, no new sections, no removing sections; only re-layout, hierarchy, spacing, typography, component styling, and visuals that do not alter the message).

**Input**
- Landing page URL (or pasted HTML): [PASTE URL OR HTML]
- Brand constraints: [colors, logo usage, must-keep elements]
- Target audience: [who]
- Primary CTA: [what]
- Secondary CTA: [what]
- Device priority: Desktop-first with mobile and tablet versions.

**Design direction**
- Inspired by Linear.app’s design quality: restrained, crisp, high-contrast, modern minimalism.
- Emphasis on: grid discipline, strong typographic hierarchy, precise spacing, subtle depth, and polished components.
- Use **high-fidelity mockups with real UI components** (buttons, inputs, cards, nav, tabs, badges, accordions where already present). Keep component choices appropriate to the existing content.

**Hard rules**
1) Do not change any wording, headings, or section order.  
2) Do not add/remove sections or features.  
3) You may adjust: spacing, alignment, typography, color usage, borders, radii, shadows, icon style, illustration treatment, background treatments, component composition, responsive behavior, and micro-interactions (hover/focus states).  
4) Maintain accessibility: target WCAG AA contrast; clear focus states; readable type sizes.  
5) Everything aligns to a coherent grid; no arbitrary offsets.

**Process**
1) Audit the page structure: list all sections in order with their purpose, current issues, and opportunities (layout, hierarchy, scanability, spacing, consistency).
2) Propose a **grid + layout system**:
   - Max width, columns, gutters, baseline spacing unit, breakpoints.
   - Section vertical rhythm rules (padding top/bottom by section type).
3) Define a **type system**:
   - Font choices (use system/Inter-like if unknown), sizes, line heights, letter spacing, weights.
   - H1/H2/H3, body, caption, overline, buttons, nav.
4) Define **component specs** (high fidelity):
   - Button styles (primary/secondary/tertiary), input fields (if any), cards, nav, badges, dividers, tables (if any), FAQ/accordion (if any).
   - States: default/hover/active/disabled/focus.
5) Redesign section-by-section:
   - For each section, provide: layout description, grid placement, spacing values, typography assignments, and component usage.
   - Provide at least one “before → after” explanation focusing on hierarchy and alignment (without changing copy).
6) Produce **deliverables**:
   - A concise “Figma build guide” with tokens + specs.
   - A set of **annotated high-fidelity mockup descriptions** for: Desktop (1440), Tablet (768), Mobile (375).
   - If helpful, include a lightweight design-token table (space scale, type scale, radii, shadows, border color, surface layers).

**Iteration loop (required)**
- Do 3 critique passes:
  - Pass A: ruthlessly remove visual noise; enforce grid and rhythm.
  - Pass B: refine typography (measure, line height, tracking) and CTA prominence.
  - Pass C: polish (optical alignment, consistent radii/shadows, spacing edge cases, responsive).
- After each pass, list the changes you made and the rationale.
- Keep iterating until the design reads “Linear-level” crisp and calm.

**Output format**
- Start with: “Section inventory” (numbered).
- Then: “System” (grid, spacing, type, color usage, components).
- Then: “Section redesign” (numbered, matching inventory).
- Then: “Responsive mockups” (desktop/tablet/mobile).
- Then: “Iteration passes A/B/C”.
- End with: “Final checklist” (grid, typography, accessibility, consistency).

Now begin. If the URL cannot be accessed, ask me to paste the HTML and any screenshots, then proceed with the same process.
:::

**Want a second version tailored for a specific stack** (e.g., “output as Tailwind classes” or “output as CSS variables + React components”)?

---

## User

this will be used in windsurf so it has context. and our page is jov.ie

---

## Assistant

Mr. White, use this version for Windsurf with full repo context and jov.ie as the target.

:::writing{id="61842" variant="standard"}
You are a senior product designer and frontend design systems expert working directly inside this codebase (Windsurf context available). Your task is to redesign the **layout and visual design only** of the existing landing page at https://jov.ie — without changing any copy, messaging, section order, or product meaning.

You have full repository access. Work directly with existing components where possible.

━━━━━━━━━━━━━━━━━━
OBJECTIVE
━━━━━━━━━━━━━━━━━━

Upgrade the landing page to a Linear.app-level design standard:
- Precise grid discipline
- Refined typography
- Calm, high-contrast minimalism
- Clean component architecture
- Consistent spacing system
- High-fidelity production-ready UI (real components, not conceptual)

The result should feel premium, technical, and highly intentional.

━━━━━━━━━━━━━━━━━━
HARD CONSTRAINTS
━━━━━━━━━━━━━━━━━━

1. Do NOT change any text, headings, or section order.
2. Do NOT add or remove sections.
3. Do NOT change messaging.
4. You MAY adjust:
   - Layout structure
   - Spacing & alignment
   - Typography system
   - Color usage within brand constraints
   - Borders, radii, shadows
   - Component composition
   - Background treatments
   - Micro-interactions
   - Responsive behavior
5. Maintain WCAG AA contrast compliance.
6. Everything must align to a coherent grid system.

━━━━━━━━━━━━━━━━━━
PROCESS (MANDATORY)
━━━━━━━━━━━━━━━━━━

STEP 1 — STRUCTURAL AUDIT
- Enumerate all landing page sections in order.
- Identify layout inconsistencies.
- Identify spacing issues, hierarchy weaknesses, alignment problems.
- Identify component inconsistency.

STEP 2 — DEFINE SYSTEM

Create a coherent design system for this page:

GRID
- Max width
- Column count (e.g., 12-column desktop)
- Gutter size
- Breakpoints
- Baseline spacing unit (e.g., 4px or 8px system)

SPACING SCALE
- Define spacing tokens (e.g., 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96)

TYPOGRAPHY
- Define full type scale:
  - H1 / H2 / H3 / H4
  - Body LG / Body / Small
  - Button text
  - Eyebrow / Overline
- Define font weights and line-heights.
- Improve rhythm and reading measure.
- Reduce unnecessary font-size variation.

COMPONENT SPEC
Define production-ready specs for:
- Primary / Secondary / Tertiary buttons
- Navbar
- Hero layout
- Cards
- Feature rows
- FAQ / accordion (if present)
- Footer

Include hover, focus, and active states.

━━━━━━━━━━━━━━━━━━
STEP 3 — SECTION-BY-SECTION REDESIGN

For each section:

- Describe the new layout grid placement
- Define spacing top/bottom
- Define column span usage
- Assign typography styles
- Adjust visual grouping
- Improve CTA prominence
- Remove visual noise

Do NOT rewrite copy.

━━━━━━━━━━━━━━━━━━
STEP 4 — HIGH-FIDELITY OUTPUT

Produce:

1. Updated layout structure ready for implementation
2. Tailwind (or existing stack) class recommendations
3. Any new reusable component abstractions
4. Token suggestions (CSS variables if appropriate)

━━━━━━━━━━━━━━━━━━
ITERATION LOOP (REQUIRED)

Run 3 refinement passes:

PASS A — Remove visual noise and enforce strict grid alignment  
PASS B — Refine typography and hierarchy for clarity  
PASS C — Polish spacing, optical alignment, and responsive behavior  

After each pass:
- List concrete improvements made
- Justify each improvement

Continue refining until the design reaches a “Linear.app-level” standard of clarity and composure.

━━━━━━━━━━━━━━━━━━
FINAL CHECKLIST

Before finishing, verify:

- Consistent grid alignment
- Consistent spacing rhythm
- No arbitrary padding
- Clear visual hierarchy
- CTA dominance is intentional
- Accessible contrast
- Mobile layout maintains hierarchy

Begin by auditing the current jov.ie landing page using the existing codebase.
:::

If you want a stricter engineering-focused variant (purely implementation output, minimal prose, maximum code diff style), I can provide that as well.


**Topic:** [[chatgpt-clusters/design_ux]]
