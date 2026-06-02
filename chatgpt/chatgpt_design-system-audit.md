---
conversation_id: 69f2bbad-8858-83e8-9c3a-360188feb36b
created: 2026-04-30
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Design System Audit
type: note
updated: 2026-04-30
---

# Design System Audit

**Related:** [[design_ux]]

> Conversation ID: 69f2bbad-8858-83e8-9c3a-360188feb36b
> Created: 2026-04-30T02:17:34Z
> Updated: 2026-04-30T02:29:35Z
> Messages: 4

---

## User

how do we fix this page. only design system teweaks not content. ui bugs or inconsistency count too

---

## Assistant

Audit of the current page (design system + UI consistency only):

---

## 1. Typography System Is Inconsistent

**Issues**
- Multiple font sizes used for similar hierarchy levels (hero, section headers, cards)
- Line-height varies unpredictably
- CTA buttons and nav use different weight/size rules

**Fix**
- Lock a strict type scale (example):
  - H1: 56 / 64
  - H2: 40 / 48
  - H3: 28 / 36
  - Body: 16 / 24
  - Caption: 14 / 20
- Use **one font weight per role**:
  - Headlines: semibold
  - Body: regular
  - UI/meta: medium
- Normalize letter-spacing (slight negative for headlines)

---

## 2. Spacing System Lacks Rhythm

**Issues**
- Sections feel uneven (hero tight, later sections crowded)
- Cards and text blocks don’t align to a consistent grid
- Vertical spacing varies arbitrarily

**Fix**
- Adopt 8pt grid system:
  - Section padding: 96 / 120 top-bottom
  - Component spacing: 24 / 32 / 48 only
- Align everything to a **max-width container (e.g. 1200px)**
- Enforce consistent left/right margins across all sections

---

## 3. CTA Hierarchy Is Blurry

**Issues**
- Too many identical CTAs (“Start Free Trial”, “Build Your Weekly Rhythm”, “Claim My Workspace”)
- Same visual weight → no primary action
- Buttons appear in inconsistent styles

**Fix**
- Define:
  - **Primary button** (solid)
  - **Secondary button** (outline)
  - **Tertiary link** (text only)
- Only ONE primary CTA per viewport section
- Normalize button:
  - Height: 44px
  - Radius: full pill
  - Padding: 16–20 horizontal

---

## 4. Visual Components Lack Systemization

**Issues**
- Cards (CRM, profile, merch, etc.) all look slightly different
- Border radius, shadows, and padding inconsistent
- Some images look raw, others styled

**Fix**
- Standardize card component:
  - Radius: 16px or 20px (pick one)
  - Shadow: subtle (Apple-level, low blur, low opacity)
  - Padding: 24px
- Define image behavior:
  - Always rounded
  - Always same aspect ratio per component type
- Introduce **consistent background surfaces**:
  - Primary: white
  - Secondary: light gray section
  - Accent: rare

---

## 5. Carousel / Slider Feels Unfinished

**Issues**
- Navigation arrows are low-visibility and not aligned
- Slides don’t feel anchored
- No clear active state

**Fix**
- Increase arrow size + contrast
- Add **pagination dots or progress indicator**
- Snap slides to center with consistent margins
- Add hover + active states

---

## 6. Grid Alignment Problems

**Issues**
- Logos, cards, and text blocks are slightly off-grid
- Some sections center-aligned, others left-aligned without logic

**Fix**
- Choose alignment rule:
  - Marketing sections: center OR left (pick one system-wide)
- Use strict grid:
  - 12-column layout
  - Consistent gutters (24px)

---

## 7. Color System Is Underdefined

**Issues**
- Mostly monochrome, but no clear token system
- Grays vary inconsistently
- No clear semantic colors (success, alert, etc.)

**Fix**
- Define tokens:
  - Gray scale (100–900)
  - Primary (black/white)
- Use:
  - Text primary: #111
  - Text secondary: #666
  - Borders: #E5E5E5
- Avoid random gray usage

---

## 8. Section Transitions Feel Abrupt

**Issues**
- Sections stack without visual rhythm
- No breathing room or separation logic

**Fix**
- Alternate backgrounds:
  - White → light gray → white
- Increase vertical spacing between sections
- Introduce subtle dividers or fades

---

## 9. Navigation Bar Needs Refinement

**Issues**
- Feels light compared to rest of page
- CTA not emphasized enough
- Spacing between items inconsistent

**Fix**
- Height: ~64px
- Increase spacing between nav items
- Make “Start Free Trial” a clear primary button
- Add subtle bottom border or blur background

---

## 10. Footer Density + Hierarchy

**Issues**
- Too many links with equal weight
- Hard to scan

**Fix**
- Reduce opacity of secondary links
- Increase spacing between columns
- Emphasize section headers more

---

## 11. Micro-Interactions Missing

**Issues**
- Feels static and less “premium”
- No hover/press feedback

**Fix**
- Buttons:
  - Hover: slight darken
  - Press: scale 0.98
- Cards:
  - Hover: subtle lift
- Links:
  - Underline on hover or color shift

---

## 12. Repetition Without Variation

**Issues**
- Sections visually repeat same structure (text + image)
- Feels template-like instead of designed

**Fix**
- Introduce pattern variation:
  - Left text / right image
  - Full-bleed sections
  - Centered storytelling sections
- Keep system, vary composition

---

## Highest-Leverage Fixes (Do First)

1. Lock typography scale  
2. Enforce spacing system (8pt grid)  
3. Standardize buttons + CTAs  
4. Normalize card component  
5. Fix grid alignment + container  

These five changes alone move it to “Apple-level clean.”

---

If needed, can convert this into a **strict Tailwind design token spec + component checklist** for implementation.

---

## User

Give it to me as an audit that I can give to an agent that has the whole code in front of it, but respect that you might be incorrect in some things, so phrase everything like, check for this issue if it exists, fix it, but not deterministically saying that it does exist, because it might not, because you don't necessarily have proper rendering of everything. There's also a screenshot fix that should be fixed in the hero, and the instructions should explicitly say that they should check the latest code before implementing anything, because that would need fixing. And then mention also that we have a new design system that is the design system we're using for the app shell, which has great pill-shaped buttons in it and stuff like that. We should start bringing those over and using those exact buttons on the homepage and start iterating towards that.

---

## Assistant

### Jovie Marketing Page — Design System Audit (Agent-Ready)

**Instructions**
- Pull latest `main` before making any changes.
- Verify each issue exists in the current codebase before fixing.
- Do not change copy, structure, or content. Only design system, UI consistency, and bugs.
- Align changes with the **existing app shell design system** (pill buttons, spacing, tokens, etc.). Reuse components where possible instead of creating new ones.

---

## 0. Hero Screenshot / Visual Bug (High Priority)

**Check**
- Validate the hero visual (release calendar / screenshot area) is rendering correctly across breakpoints.
- Check for:
  - Low contrast / overly dark rendering
  - Blurry or scaled images
  - Misaligned overlay elements (notification card, dots, labels)
  - Improper aspect ratio or clipping
  - Duplicate rendering (there are signs of repeated markup in DOM)

**Fix**
- Ensure:
  - Proper container constraints (no overflow clipping unintentionally)
  - Image uses correct resolution (`srcset` if needed)
  - Overlay UI aligns to a grid
  - Only one instance of the component is rendered (remove duplicates if present)
- Match polish level of app shell visuals (sharp, high contrast, intentional glow)

---

## 1. Typography System

**Check**
- Audit all heading, body, and UI text sizes.
- Look for:
  - Same-level headings using different sizes
  - Inconsistent line-height
  - Button text not matching system scale

**Fix**
- Map all text to a strict type scale (reuse app shell tokens if available)
- Normalize:
  - Heading weights
  - Body size + line-height
  - Button font size and weight
- Ensure consistent tracking for large headlines

---

## 2. Button System (Adopt App Shell)

**Check**
- Compare homepage buttons vs app shell buttons.
- Look for:
  - Different border radius
  - Different padding
  - Inconsistent hover/active states
  - Multiple button styles doing the same role

**Fix**
- Replace homepage buttons with **exact app shell button component**
  - Pill shape
  - Same padding + height
  - Same interaction states
- Define usage:
  - Primary (solid)
  - Secondary (outline)
  - Tertiary (text)
- Ensure only one primary CTA per section

---

## 3. Spacing & Layout System

**Check**
- Inspect vertical spacing between sections and within sections.
- Look for:
  - Inconsistent padding (hero vs other sections)
  - Elements not aligned to same horizontal grid
  - Arbitrary spacing values

**Fix**
- Enforce 8pt grid system:
  - Section spacing: consistent top/bottom (e.g. 96–120)
  - Internal spacing: 24 / 32 / 48 only
- Ensure all sections use same max-width container
- Align all content to a consistent grid

---

## 4. Grid & Alignment

**Check**
- Inspect alignment of:
  - Hero text vs calendar
  - Logo row
  - Cards and feature sections
- Look for:
  - Mixed center + left alignment without intent
  - Elements slightly off-grid

**Fix**
- Standardize layout system:
  - Use consistent 12-column grid (or existing system)
  - Align all sections to same container + gutters
- Choose alignment rules and apply consistently

---

## 5. Card / Surface Components

**Check**
- Compare all card-like elements:
  - Carousel slides
  - Profile cards
  - CRM visuals
- Look for:
  - Different border radius
  - Different shadows
  - Inconsistent padding

**Fix**
- Normalize to one card component:
  - Single radius value
  - Single shadow style
  - Standard padding
- Ensure all visuals sit on consistent surface styles

---

## 6. Carousel / Slider

**Check**
- Inspect carousel behavior and UI.
- Look for:
  - Low visibility arrows
  - Misaligned controls
  - No clear active state
  - Poor snapping

**Fix**
- Improve:
  - Arrow size + contrast
  - Add pagination indicator (dots or progress)
  - Ensure proper snap alignment
  - Add hover/active states

---

## 7. Color System

**Check**
- Audit all grayscale usage.
- Look for:
  - Slightly different gray values used inconsistently
  - Borders not matching system tokens
  - Text contrast inconsistencies

**Fix**
- Map all colors to design tokens:
  - Text primary / secondary
  - Borders
  - Backgrounds
- Remove arbitrary hex values

---

## 8. Section Transitions

**Check**
- Look at transitions between sections.
- Look for:
  - Abrupt stacking
  - No visual separation

**Fix**
- Introduce consistent pattern:
  - Alternate background surfaces (white / subtle gray)
  - Increase vertical rhythm
  - Optional subtle dividers

---

## 9. Navigation Bar

**Check**
- Inspect navbar spacing and hierarchy.
- Look for:
  - Weak CTA emphasis
  - Tight spacing between items
  - Visual disconnect from rest of page

**Fix**
- Normalize:
  - Height (~64px)
  - Spacing between items
- Apply app shell button for CTA
- Add subtle divider or backdrop blur

---

## 10. Footer Hierarchy

**Check**
- Review footer readability.
- Look for:
  - Equal weight on all links
  - Dense layout

**Fix**
- Reduce opacity for secondary links
- Increase spacing between columns
- Emphasize section headers

---

## 11. Micro-Interactions

**Check**
- Inspect hover/active states.
- Look for:
  - Buttons with no feedback
  - Cards with no hover state

**Fix**
- Add:
  - Button hover + press states
  - Card hover lift
  - Link hover indication

---

## 12. Duplicate / Broken Markup

**Check**
- There are signs of duplicated content in DOM (e.g. repeated “Make Every Friday” section).
- Confirm if:
  - Components are rendering twice
  - Hidden duplicates exist

**Fix**
- Remove duplicate instances
- Ensure only one canonical component renders

---

## 13. Image Handling

**Check**
- Inspect all images:
  - Aspect ratios
  - Cropping
  - Resolution

**Fix**
- Standardize:
  - Consistent aspect ratios per component type
  - Proper object-fit usage
  - High-res assets only

---

## 14. Consistency With App Shell

**Check**
- Compare homepage vs app shell for:
  - Buttons
  - Inputs
  - Spacing
  - Typography
  - Interaction states

**Fix**
- Migrate homepage toward app shell system:
  - Reuse components directly
  - Avoid parallel systems
- Goal: homepage feels like extension of product, not separate design language

---

## Priority Order

1. Fix hero rendering + duplicates  
2. Replace buttons with app shell components  
3. Normalize typography  
4. Enforce spacing + grid  
5. Standardize cards + surfaces  
6. Clean up color tokens  
7. Fix carousel  
8. Add micro-interactions  

---

## Success Criteria

- Page feels like a direct extension of the app shell
- No visual inconsistencies across components
- Clean, predictable spacing and hierarchy
- High polish in hero and interactive elements
- Zero duplicate or broken UI artifacts

---

If needed, next step is converting this into a **component-level checklist mapped to actual files (e.g. `/components/ui/button`, `/sections/hero`, etc.)**.


**Topic:** [[chatgpt-clusters/design_ux]]


## See Also
- [[chatgpt/chatgpt_design-system-audit-2]]
- [[chatgpt/chatgpt_design-system-audit-plan]]
- [[chatgpt/chatgpt_code-review-system-design]]
- [[chatgpt/chatgpt_design-system-and-workflow]]
- [[chatgpt/chatgpt_design-system-application]]
