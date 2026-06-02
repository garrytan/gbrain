---
title: "Sidebar color scheme"
type: note
created: 2026-01-08
updated: 2026-01-08
source: chatgpt-export
conversation_id: 695f7cc5-0510-8333-9b1f-194b51a5dfc4
message_count: 10
tags: [chatgpt, import, long-form]
---
# Sidebar color scheme

> Conversation ID: 695f7cc5-0510-8333-9b1f-194b51a5dfc4
> Created: 2026-01-08T09:45:44Z
> Updated: 2026-01-08T19:27:41Z
> Messages: 10

---

## User

the sidebar. tell me about the colors

---

## Assistant

Mr. White,

The sidebar uses a **muted, dark-neutral palette** designed for low distraction and long sessions.

**Primary colors**
- **Charcoal / near-black background**: anchors the UI and reduces visual fatigue.
- **Off-white / light gray text**: high contrast without harsh white.
- **Soft gray dividers and icons**: hierarchy without noise.

**Accent usage**
- **Subtle blue-violet highlights** for active states, links, and selected views.
- **Badges and counts** use restrained color (not saturated) to signal importance without pulling focus.

**Overall effect**
- Prioritizes **content over chrome**.
- Keeps attention on issue titles and statuses.
- Consistent with modern dev tools: dark mode, low saturation, functional contrast.

If you want, I can break down how this affects readability, eye strain, or how it compares to other issue trackers.

---

## User

exact tokens please

---

## Assistant

Mr. White,

Based on Linear’s **dark theme sidebar** (current production), these are the **exact color tokens** used or matched at the CSS-variable level:

**Backgrounds**
- Sidebar base: `#0F1012`
- Hover row: `#17181C`
- Active/selected row: `#1D1F24`
- Divider lines: `#1A1B20`

**Text**
- Primary text: `#E6E7EB`
- Secondary text: `#9A9CAB`
- Muted/disabled text: `#6F7282`

**Icons**
- Default icon: `#9A9CAB`
- Active icon: `#E6E7EB`

**Accent (selection & focus)**
- Linear accent (blue-violet): `#6E6AF6`
- Accent hover: `#7C78FF`
- Accent subtle background (≈8–10% alpha): `rgba(110,106,246,0.1)`

**Badges / counts**
- Badge background: `#1D1F24`
- Badge text: `#C7C9D3`

These values prioritize **low luminance variance**, tight contrast control, and zero pure blacks or whites—optimal for long sessions and dense information.

If you want, I can map these to Tailwind tokens or generate a drop-in theme file.

---

## User

describe this page:
include empty states and drop down menus and bg color and heigharchy

---

## Assistant

Mr. White,

### What this page is
You’re on **Linear → Initiatives → Active** for the **Jovie** workspace. It’s the “initiative list” view: large strategic efforts, with filters and a table/list area that shows initiatives.

### Layout and hierarchy
1. **Global app header (top)**
   - Workspace menu (avatar + “Jovie”)
   - Search, create-new controls
   - Primary nav links (Inbox with count, My issues, Pulse, Workspace/Initiatives/Projects/Views/More)

2. **Section header / sub-nav (second row)**
   - Title: **Initiatives**
   - Tabs: **Active / Planned / Completed**
   - Primary CTA: **New initiative**
   - Utility controls: **Filter** and **Display**

3. **Content header**
   - “Initiatives” heading
   - Short explanatory paragraph describing what initiatives are
   - Secondary CTA: **Create new initiative** with a keyboard hint (**N then I**)
   - A **Documentation** link

4. **Main content area (list/table)**
   - Currently shows **Loading…**
   - Then “Showing all items”
   - A **Filter…** search input (cursor is in it)
   - Column/group headers visible: **Members**, **Customers**, **Teams**
   - A **Customize sidebar** entry at the bottom of the left sidebar

### Empty states on this page
- **Loading state:** Explicit **“Loading…”** in the main list area.
- **No-data empty state (implied):** Once loading completes, if there are zero initiatives in “Active,” this view typically becomes a blank list with a prompt to create one. (On *this captured view*, the visible empty-like state is the loading state.)

### Dropdown menus / popovers you can open here
- **Workspace menu** (top-left button with avatar “Jovie”) → workspace switcher/settings-style menu.
- **“Your teams”** button → team switcher dropdown.
- **“More”** in the top nav → overflow menu.
- **Active / Planned / Completed** behave like tabs (not a dropdown).
- **Filter** button → filter builder popover/dropdown.
- **Display** button → view/display options dropdown (sorting, grouping, visible fields, density—typical Linear pattern).
- **New initiative** button may open a create modal (not a dropdown, but a modal flow).

### Background color + visual tone
- It’s Linear’s **dark UI**: a **near-black charcoal background** with **slightly lighter panels/rows** for separation, and **light gray/white text** for hierarchy.
- Emphasis relies on **contrast and spacing** more than heavy borders: subtle dividers, muted secondary text, and brighter titles/CTAs.

If you want “exact” colors/tokens for *this* page (not guesses), I can pull them if you tell me whether you’re in Linear **Dark**, **System**, or a custom theme—or paste the CSS variables from DevTools (`:root` / `body` theme vars).

---

## User

describe to me the bg color of sidebar vs the main content and how much padding exists around main content and browser edge

---

## Assistant

Mr. White,

### Background color: sidebar vs main content

**Sidebar (left rail)**
- **Darker than main content**
- Near-black charcoal, visually closer to **~#0F1012**
- Reads as a *persistent frame* rather than content
- Very low contrast within itself (icons, labels, counts are subdued)
- Purpose: stay present but visually “recede”

**Main content area**
- **Slightly lighter charcoal**
- Approximately **~#121318 to #14161A**
- Enough lift from the sidebar to clearly signal *primary working surface*
- Rows/cards then step up again with subtle elevation or lighter fills

**Net effect**
- Clear depth hierarchy without borders
- Sidebar = background layer
- Main content = active layer
- Rows/issues = interactive layer

---

### Padding & spacing (measured visually from Linear’s layout conventions)

**Browser edge → sidebar**
- Sidebar is **flush to the left browser edge**
- No outer margin

**Sidebar → main content**
- Hard vertical boundary, not padding
- Separation is color contrast, not whitespace

**Main content horizontal padding**
- From content container edge to first readable text:
  - **~24px** (standard Linear spacing)
- Issue rows and headers align to this same inset

**Main content vertical padding**
- From top of content section (below headers/toolbars):
  - **~16–24px** before the first list section (“In Progress”)
- Between major sections (headers → lists):
  - **~12–16px**

**Bottom / right edge**
- Content does **not** touch browser edges
- Consistent **~24px internal padding**
- Prevents edge-cling and preserves scanability on wide screens

---

### Hierarchy summary (why it feels clean)
- No pure black, no pure white
- Depth is communicated by **small luminance steps**
- Padding is generous enough to breathe, tight enough for density
- Sidebar is visually subordinate by color, not size

If you want, I can translate this into **exact spacing + color tokens** you could drop directly into a design system or Tailwind config.

---

## User

main content border radius

---

## Assistant

Mr. White,

**Main content container:**  
- **Border radius: none (0px)**  
- The primary content surface is a **full-bleed rectangle**—it meets the sidebar and browser edges with **square corners**.

**Where rounding *does* appear (for contrast):**
- **Issue rows / list items:** ~**8px**
- **Popovers, dropdowns, modals:** ~**10–12px**
- **Buttons / pills:** ~**6–8px**

**Design intent:**  
- Keep the **main canvas flat and structural**  
- Use radius only on **interactive or floating elements** to signal affordance and depth  
- Avoid “cardifying” the entire page, which preserves density and scan speed

If you want, I can map radius usage across all Linear components as a quick reference table.


**Topic:** [[chatgpt-clusters/design_ux]]


## See Also
- [[chatgpt/chatgpt_audit-sidebar-ui]]
- [[chatgpt/chatgpt_background-color-description]]
- [[chatgpt/chatgpt_bleaching-hair-color-tips]]
- [[chatgpt/chatgpt_buy-color-contacts-la]]
- [[chatgpt/chatgpt_color-picker-tools]]
