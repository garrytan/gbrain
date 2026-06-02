---
title: "Accessibility contrast check"
type: guide
created: 2025-12-09
updated: 2025-12-09
source: chatgpt-export
conversation_id: 69379682-f2d8-832c-bc23-8d56d0903366
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Accessibility contrast check

> Conversation ID: 69379682-f2d8-832c-bc23-8d56d0903366
> Created: 2025-12-09T03:26:09Z
> Updated: 2025-12-09T03:28:45Z
> Messages: 4

---

## User

Can you give me a prompt to recursively look through EVERY part of our dashbaord and check that text, icons, etc show up with enough contrast to be visible and match accessibility standards. It shouldn't stop til every item has been checked. It should also be looking at what the browser actually shows not just the code for instances where a weird token or something doesnt render correctly. 

---

## Assistant

Here’s a prompt you can drop into your agent / test runner, Mr. White:

---

**Prompt:**

You are an automated accessibility QA tester working inside a real browser.  
Your **single goal** is to systematically and exhaustively verify visual contrast and visibility of **all user-facing UI elements** in our web dashboard.

### 1. Scope & navigation

- Start from the current page and **recursively explore every part of the dashboard UI**:
  - All navigation items (sidebars, top nav, bottom nav).
  - All menu items, dropdowns, accordions, tabs, drawers, popovers, dialogs/modals, toasts.
  - All pages, subpages, and nested routes that can be reached by clicking visible elements.
  - All interactive controls: buttons, links, inputs, toggles, chips, tags, pills, pagination, tables, charts legends, filters, etc.
- Use the **actual rendered UI**, not just source code:
  - Evaluate what the browser visually renders (final computed styles and colors).
  - Treat any missing/failed tokens, fallback colors, or rendering glitches as **failures**.
- Keep track of visited states/routes so you **don’t stop** until:
  - All reachable page states, menus, tabs, and dialogs have been opened and inspected.
  - No new interactive elements or screens can be discovered by further clicking.

### 2. What to check for each element

For **every user-visible element** (text or icon), inspect:

1. **Text nodes**
   - Examples: headings, labels, form placeholders, button text, table text, chip labels, chart labels, empty-state text, error messages, helper text.
   - Determine:
     - Text color (computed CSS color).
     - Effective background color (including gradients, overlays, and parent backgrounds if transparent).
   - Compute or approximate the **contrast ratio** between text and background.
   - Check against **WCAG 2.1 contrast**:
     - Normal text (< 18pt / < 14pt bold): **≥ 4.5:1**.
     - Large text (≥ 18pt, or ≥ 14pt bold): **≥ 3:1**.
   - Mark issues where:
     - Contrast ratio is below the threshold.
     - Text is difficult to read due to low opacity, blur, shadows, overlays, or image backgrounds.
     - Text appears clipped, cut off, or partially hidden.

2. **Icons and non-text UI**
   - Examples: standalone icons, icon buttons, status indicators, SVG icons, font icons, checkmarks, toggles, radio buttons, switches, slider handles, badges, chart lines or bars used as primary state indicators.
   - Determine:
     - Icon/indicator color and opacity.
     - Background or surround color.
   - For icons/controls serving as key indicators (state, status, action), check:
     - **Contrast ratio ≥ 3:1** against the immediate background.
     - Sufficient size and visual clarity to be recognizable.
   - Flag issues where:
     - Icon is barely visible.
     - Disabled state is indistinguishable from enabled state.
     - Error/warning/success colors are too light/low contrast (e.g., pale red on light background).

3. **States and interactions**
   - For all focusable/interactive elements (links, buttons, inputs, toggles, tabs, menu items, pagination, etc.), check:
     - **Default state**
     - **Hover state**
     - **Active/pressed state**
     - **Focus state** (keyboard focus outline, if any)
     - **Disabled state** (if present)
   - Verify:
     - Focus outlines or rings have sufficient contrast with underlying content.
     - Hover/active states do not reduce contrast to non-compliant levels.
     - Disabled elements are still readable if they contain important text (labels, values).

4. **Dynamic and conditional UI**
   - Expand and inspect:
     - Dropdown menus
     - Accordions
     - Tooltips
     - Popovers
     - Modals/dialogs
     - Toasts/notifications
     - Autocomplete and typeahead results
     - Date/time pickers
   - For each, verify **all text and icons** meet the same contrast rules.

### 3. How to interact with the UI

- Use **clicks and keyboard navigation** as a real user would:
  - Click on menus, icons, tabs, and buttons to reveal more content.
  - Use scroll to reveal off-screen content in containers and pages.
  - Open every modal, dropdown, and accordion you can find.
- Maintain an internal set of visited routes/states to avoid infinite loops, but:
  - **Continue until no new UI elements, routes, or states can be discovered.**

### 4. Data to record for each failure

For **every element that fails or looks suspect**, record at least:

- A short identifier / description:
  - e.g. “Left sidebar → ‘Settings’ menu item”,  
    “Billing page → ‘Current plan’ label”,  
    “Modal: ‘Delete user?’ → primary button text”.
- The **type** of element:  
  - (body text / heading / button / icon / badge / input label / table cell / etc.)
- The **observed colors**:
  - Text/icon color (computed value, e.g. `#7F8C8D`).
  - Background color (computed or derived, e.g. `#FFFFFF`).
  - Approximate **contrast ratio** and relevant WCAG threshold.
- Screenshot anchor (if available in your environment):
  - Attach or reference a screenshot/viewport crop if supported.

### 5. Output format

When you have exhausted the dashboard (no new elements or screens found):

1. Provide a **summary**:
   - Total number of elements checked (approximate if needed).
   - Number of elements failing contrast, by type (text vs icon vs control).
   - The worst contrast ratios you found and where.

2. Provide a **detailed list of issues**, for example:

   - `Page / Route:` …
     - `Element:` …
     - `Role/Type:` …
     - `Text/Icon:` …
     - `Foreground:` …
     - `Background:` …
     - `Contrast:` X:1 (required ≥ Y:1)
     - `State:` default / hover / focus / disabled / active
     - `Notes:` why it’s problematic (too light, on image, clipped, etc.)

3. Do **not** stop on the first failure.  
   - Continue until you have covered the entire dashboard and **every reachable element** has been evaluated at least once.

---

If you’d like, I can also give you a more tailored version for a specific tool (e.g. Playwright + an LLM agent, Cypress, or Selenium) with concrete examples of how to drive the crawling logic.

---

## User

I want to make sure it's going to still respect our design though. And it needs light and dark mode.  Im gonna have opus 4.5 do this

---

## Assistant

Got you, Mr. White. Here’s a revised, drop-in prompt for Opus 4.5 that:

- Crawls everything like before  
- Looks at **rendered** UI, not just code  
- Checks **light + dark** modes  
- **Respects the existing design system** and only flags true accessibility/visibility issues

---

```text
You are an automated accessibility QA tester working inside a REAL browser session for our product dashboard.

Your goal is to systematically and exhaustively verify **visual contrast and visibility** of all user-facing UI elements in our dashboard, in **both light and dark modes**, while **respecting the existing design system**.

====================================
1. Design constraints (very important)
====================================

- Assume the current typography, spacing, and visual style are intentional.
- DO NOT suggest global redesigns, new visual languages, or arbitrary stylistic changes.
- Only flag issues that are:
  - Clear violations of WCAG 2.1 contrast requirements, OR
  - So low-contrast or broken that they’re realistically hard to see/read.
- When you propose fixes, keep them **minimal and local**, e.g.:
  - Slightly darken/lighten an existing token.
  - Adjust opacity.
  - Swap between existing semantic tokens (e.g. `text.subtle` → `text.default`).
- Prefer referencing **existing design tokens / semantic colors** (e.g. primary, danger, success, subtle, on-surface) rather than inventing new colors.

=================================================
2. Theme handling: check both LIGHT and DARK mode
=================================================

- Identify how to switch themes:
  - If there is a theme toggle/switch in the UI, use it.
  - If not, look for:
    - a settings screen with appearance/theme options, OR
    - attribute on `<html>`/`<body>` (e.g. `data-theme="light|dark"`), OR
    - CSS class toggles (e.g. `.dark` on `<html>` or `<body>`).
- For each screen/route/state, you must:
  - Inspect it in **light mode**.
  - Inspect the **same** screen in **dark mode**.
- Record issues separately by theme:
  - “Light mode only”
  - “Dark mode only”
  - “Both themes”

===========================================
3. Scope & navigation (full dashboard crawl)
===========================================

- Start from the current page and recursively explore every part of the dashboard UI:
  - Sidebars, top/bottom nav, secondary nav, app switchers.
  - Pages, subpages, and nested routes reachable via clicks.
  - Tabs, accordions, drawers, dropdowns, popovers, tooltips, modals/dialogs.
  - Tables, lists, charts, legends, filters, pagination, settings forms, etc.
- Use **actual rendered UI**, not just source code:
  - Rely on computed styles and what the browser actually draws.
  - Treat missing/failed tokens, fallback colors, or non-rendering icons as failures.
- Keep a set of visited:
  - Routes/URLs
  - Tabs
  - Modal/dialog states
- Continue exploring until **no new UI surfaces** can be discovered by:
  - Clicking interactive elements
  - Opening menus, dialogs, and accordions
  - Switching tabs/filters
- Do NOT stop at the first failure. Crawl the entire dashboard.

===================================
4. What to inspect for each element
===================================

For every user-visible, user-relevant element, in both light and dark themes:

A. Text elements
- Examples:
  - Headings, body text, labels, helper text, placeholders
  - Button text, chip/pill labels, badge text
  - Table headers and cells, chart labels, empty states, error messages
- For each:
  - Determine **text color** (computed).
  - Determine **effective background** (including parent backgrounds/overlays if current background is transparent).
  - Estimate or compute the **contrast ratio** between text and background.
- Compare to WCAG 2.1:
  - Normal text (< 18pt or < 14pt bold): **≥ 4.5:1**
  - Large text (≥ 18pt or ≥ 14pt bold): **≥ 3:1**
- Flag issues where:
  - Contrast ratio is below the applicable threshold.
  - Text is washed out due to opacity, overlays, or image backgrounds.
  - Text is partially cut off or overlapped, making it hard to read.

B. Icons and non-text indicators
- Examples:
  - Standalone icons, icon-only buttons, status indicators, SVG icons, checkmarks
  - Toggles, radio buttons, switches, slider handles, progress indicators
  - Chips, tags, badges where color conveys state (success, warning, error)
- For each:
  - Determine icon/indicator color and background.
  - For critical state/meaning indicators, ensure **≥ 3:1** contrast.
- Flag issues where:
  - Icon is barely visible against its background.
  - Disabled vs active states are indistinguishable.
  - Semantic states (error/warning/success/info) are too low contrast to reliably notice, especially in one of the themes.

C. Interactive states
- For all focusable/interactive elements (links, buttons, inputs, toggles, menu items, tabs, pagination, etc.), check in **both themes**:
  - Default
  - Hover
  - Active/pressed
  - Focus (keyboard focus outline)
  - Selected/current
  - Disabled (if present)
- Verify:
  - Focus outline is visible and has good contrast with surrounding content.
  - Hover/active states don’t drop contrast below WCAG thresholds.
  - Disabled elements with text remain legible enough to understand their purpose.

D. Dynamic/conditional UI
- Expand/open and inspect, in both light and dark:
  - Dropdowns and select menus
  - Accordions
  - Tooltips and popovers
  - Modals/dialogs, drawers, side panels
  - Toasts/notifications
  - Autocomplete/typeahead, date/time pickers
- Apply the same contrast checks to all text and icons inside these surfaces.

=========================================
5. How to interact with the UI realistically
=========================================

- Use clicks and keyboard navigation like a real user:
  - Scroll containers and pages to reveal off-screen items.
  - Click tabs, filters, menus, and “more”/overflow actions.
  - Open and close dialogs, drawers, dropdowns, and accordions.
- Avoid infinite loops:
  - Track visited URL + visible state identifiers (e.g., selected tab).
  - Skip states you’ve already fully inspected in both light and dark modes.

=========================
6. Output and issue format
=========================

When you have fully explored the dashboard (no new screens/states are found), produce:

1. A high-level summary
   - Approximate total number of elements inspected.
   - Number of contrast/visibility issues, split by:
     - Light-only
     - Dark-only
     - Both
   - Notable patterns (e.g., “subtle text tokens on cards in dark mode often fail”).

2. A detailed issue list
   For each issue, provide structured info like:

   - `Theme:` light / dark / both
   - `Page / Route:` (e.g. `/billing`, `/settings/profile`)
   - `Location:` brief description of how to reach it
     - e.g. “Sidebar → Settings → Billing → Invoices table”
   - `Element type:` (heading, body text, button, icon, badge, input label, table cell, etc.)
   - `State:` default / hover / focus / active / disabled / selected
   - `Text/Icon:` the visible text OR icon description
   - `Foreground color:` computed value (e.g. `#7F8C8D`)
   - `Background color:` computed or derived (e.g. `#1E1E24`)
   - `Approx contrast ratio:` X:1 (required ≥ Y:1)
   - `Severity:` minor / moderate / major, based on how hard it is to see in real use
   - `Suggested minimal fix:`
     - Describe a conservative adjustment, ideally in terms of existing tokens
       (e.g. “Use `text.default` instead of `text.subtle` on this card title in dark mode.”)

3. Respect for design
   - Always phrase suggestions as **minimal modifications** that keep the current visual language.
   - Do NOT propose totally new colors or radically different patterns unless the existing tokens cannot be adjusted to meet basic accessibility.

Remember:
- Work from the **rendered UI** only.
- Cover **every reachable part** of the dashboard.
- Check **both light and dark themes**.
- **Respect the design**, only calling out real accessibility/visibility problems.
```

If you tell me what framework / theme toggle you’re using (e.g. Tailwind `.dark`, Chakra, MUI, etc.), I can tighten a version specifically for that setup as well.


## See Also
- [[chatgpt/chatgpt_ct-scan-contrast-prep]]
- [[chatgpt/chatgpt_ada-gym-accessibility-rules]]
- [[chatgpt/chatgpt_altman-openai-salary-fact-check]]
- [[chatgpt/chatgpt_atari-deal-fact-check]]
- [[chatgpt/chatgpt_auto-promote-blockers-check]]
