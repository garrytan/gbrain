---
conversation_id: 69334678-479c-832f-b688-53114c6cd9ce
created: 2025-12-05
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Header component review
type: guide
updated: 2025-12-05
---

# Header component review

**Related:** [[coding_web_dev]]

> Conversation ID: 69334678-479c-832f-b688-53114c6cd9ce
> Created: 2025-12-05T20:55:05Z
> Updated: 2025-12-05T20:55:37Z
> Messages: 2

---

## User

Give me a prompt to look at our header component and ensure it has all apple level design practices including but not limited to accessibility and proper contrast in light and dark mode. And also that it matches linear.app level design and that is refactored for atomic design and performances.

---

## Assistant

Here you go, Mr. White—copy-paste this and drop your header code where indicated:

```markdown
You are a senior product/UI engineer with deep knowledge of Apple Human Interface Guidelines, modern web accessibility (including WCAG 2.1 AA), performance optimization, and atomic design. 

Task:
Review and refactor the following **Header component** so that it:

1. **Matches Apple-level design & UX quality**
   - Align with Apple Human Interface Guidelines for spacing, hierarchy, motion, iconography, typography, and states (hover/active/focus).
   - Ensure subtle, tasteful motion/feedback only where it adds clarity.
   - Avoid visual noise; prioritize clarity and calmness.

2. **Matches the visual & interaction quality of Linear.app**
   - Use a similar aesthetic: minimal, crisp, “tool for pros” feel.
   - Consider layout, spacing, icon sizing, micro-interactions, hover states, and the way sections are grouped and aligned.
   - Ensure the header feels like it belongs inside a Linear-style SaaS app (desktop-first, still responsive).

3. **Accessibility & contrast (light + dark mode)**
   - Ensure WCAG 2.1 AA contrast for all text and key UI elements in **both** light and dark themes.
   - Include/verify:
     - Proper semantic structure and ARIA where needed.
     - Full keyboard navigation (tab order, focus states clearly visible).
     - Logical focus management and skip-to-main if relevant.
     - Respect for `prefers-reduced-motion` and `prefers-color-scheme`.
   - Explicitly call out contrast ratios for primary text, secondary text, and key interactive elements.

4. **Atomic design & clean architecture**
   - Refactor into atomic design: atoms (buttons, icons, text styles, inputs), molecules (search bar, profile menu, nav items), organisms (the full Header).
   - Avoid duplication: centralize shared primitives (tokens, button variants, icon wrapper, typography styles, spacing system).
   - Make the component easy to extend (adding new nav items, new actions) with minimal changes.

5. **Performance & implementation quality**
   - Remove unnecessary re-renders and heavy logic from the header.
   - Ensure efficient use of memoization/hooks if using React (or equivalent patterns in other frameworks).
   - Avoid unnecessary DOM nodes and overly deep nesting.
   - Make sure any animations are performant (GPU-friendly transforms, no layout thrashing).
   - If icons/images are used, ensure they are optimized (SVG where possible).

6. **Deliverables**
   - Provide:
     1. **A short critique** of the current header: what’s wrong or suboptimal from Apple/Linear/accessibility/performance perspectives.
     2. **A refactored implementation** that:
        - Uses atomic design structure (show file/component boundaries).
        - Includes light and dark mode styles with guaranteed accessible contrast.
        - Includes clear focus states and keyboard behavior.
     3. **Design + engineering notes**:
        - Bullet list of key design decisions (spacing, typography, layout, colors, motion).
        - Bullet list of performance and accessibility improvements.

Here is the current Header component code and any relevant styles/theme tokens:

[PASTE HEADER COMPONENT CODE + STYLES HERE]


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_video-header-component]]
- [[chatgpt/chatgpt_vue-component-code-review]]
- [[chatgpt/chatgpt_vuejs-table-header-component]]
- [[chatgpt/chatgpt_add-prop-to-vue-component]]
- [[chatgpt/chatgpt_add-prop-to-vuejs-component]]
