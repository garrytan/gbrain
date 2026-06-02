---
title: "Grid Alignment Instructions"
type: essay
created: 2026-05-19
updated: 2026-05-19
source: chatgpt-export
conversation_id: 6a0cd8ea-9b28-83e8-bad6-64a1b01f3064
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Grid Alignment Instructions

> Conversation ID: 6a0cd8ea-9b28-83e8-bad6-64a1b01f3064
> Created: 2026-05-19T21:41:04Z
> Updated: 2026-05-19T22:37:50Z
> Messages: 8

---

## User

{'asset_pointer': 'sediment://file_000000007fa471f89b1b08e43bfd3e6a', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1964, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 276061, 'width': 1018}
{'asset_pointer': 'sediment://file_000000007da071fdaa95daa06ecb8340', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1314, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 805573, 'width': 2048}
Can you give me specific instructions to get nav, header, subheader, and all toolbars aligned on a grid.

---

## Assistant

Mr. White, use a single **8px app shell grid** and make every major surface consume that grid instead of letting each component define its own margins.

## Target layout spec

### Global grid tokens

```css
:root {
  --grid: 8px;

  --sidebar-w: 320px;
  --sidebar-pad-x: 24px;

  --main-pad-x: 32px;
  --gap: 16px;

  --topbar-h: 72px;
  --subbar-h: 56px;
  --content-gap-y: 16px;

  --toolbar-h: 32px;
  --icon-btn: 32px;
  --icon-size: 16px;

  --column-header-h: 48px;
  --card-pad: 16px;
}
```

At the screenshot width, this gives you clean rails:

| Rail | Position |
|---|---:|
| Sidebar left | `0` |
| Sidebar/content divider | `320px` |
| Main left rail | `352px` |
| Main right rail | `window width - 32px` |
| Board column gap | `16px` |

With a 2048px-wide window, board columns become:

```txt
main width = 2048 - 320 - 64 = 1664
column width = (1664 - 48) / 4 = 404

Column 1 x = 352
Column 2 x = 772
Column 3 x = 1192
Column 4 x = 1612
Right rail  = 2016
```

## App shell structure

Use one parent grid for the whole app:

```css
.app-shell {
  height: 100vh;
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  grid-template-rows:
    var(--topbar-h)
    var(--subbar-h)
    var(--content-gap-y)
    minmax(0, 1fr);

  box-sizing: border-box;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}
```

Then assign every major region to this same shell:

```css
.sidebar-topbar {
  grid-column: 1;
  grid-row: 1;
  padding-inline: var(--sidebar-pad-x);
  display: flex;
  align-items: center;
}

.page-header {
  grid-column: 2;
  grid-row: 1;
  padding-inline: var(--main-pad-x);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.sidebar-subbar {
  grid-column: 1;
  grid-row: 2;
  padding-inline: var(--sidebar-pad-x);
  display: flex;
  align-items: center;
}

.page-subheader {
  grid-column: 2;
  grid-row: 2;
  padding-inline: var(--main-pad-x);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.sidebar-nav {
  grid-column: 1;
  grid-row: 4;
  padding-inline: var(--sidebar-pad-x);
  min-height: 0;
  overflow: auto;
}

.board {
  grid-column: 2;
  grid-row: 4;
  padding-inline: var(--main-pad-x);
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--gap);
  min-height: 0;
  overflow: hidden;
}
```

## Exact alignment rules

### 1. Sidebar/nav

Set the sidebar to exactly `320px`. Avoid values like `316px`, `318px`, or content-dependent widths.

```css
.sidebar-nav-item {
  height: 40px;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding-inline: 8px;
  border-radius: 8px;
}
```

Sidebar rules:

- Sidebar width: `320px`
- Sidebar horizontal padding: `24px`
- Nav item height: `40px`
- Icon slot: `24px`
- Icon size: `16px`
- Label starts at a consistent x-position across every nav item
- Section headers align to the same inner rail as nav icons or labels; pick one and keep it consistent

In your screenshot, the selected `Tasks` item, section headings, and lower nav groups have slightly different left starts. Put them all on the same sidebar rail.

### 2. Header

The page header should use the same main rail as the board and subheader.

```css
.page-title {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--toolbar-h);
  min-width: 0;
}

.page-title-icon {
  width: var(--icon-btn);
  height: var(--icon-btn);
  display: grid;
  place-items: center;
}

.page-header-actions {
  justify-self: end;
}
```

Rules:

- Header left edge starts at `mainLeft = sidebarW + mainPadX`
- Header right toolbar ends at `mainRight = windowWidth - mainPadX`
- The `Tasks` icon sits on the main rail
- The `Tasks` text starts after the icon slot
- `+ New Task` aligns to the same right rail used by the subheader toolbar

### 3. Subheader

The subheader tabs and right-side tools should share the same rails as the header.

```css
.tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--toolbar-h);
}

.tab {
  height: var(--toolbar-h);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-inline: 12px;
  border-radius: 999px;
}

.subheader-tools {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--toolbar-h);
}
```

Rules:

- `All`, `Assigned To Me`, and `Assigned To Jovie` start on the same main left rail as the board
- Search/filter/sort icons end on the same main right rail as `+ New Task`
- Each icon button is `32x32`
- Toolbar gap is `8px`
- No custom `margin-left` or `margin-right` on individual tab/tool elements

### 4. Board columns

The board should be one CSS grid, not manually positioned columns.

```css
.kanban-column {
  min-width: 0;
  display: grid;
  grid-template-rows: var(--column-header-h) minmax(0, 1fr);
  border-radius: 10px;
  overflow: hidden;
}

.column-header {
  height: var(--column-header-h);
  padding-inline: 16px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--icon-btn);
  align-items: center;
}

.column-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.column-add-button {
  width: var(--icon-btn);
  height: var(--icon-btn);
  display: grid;
  place-items: center;
  justify-self: end;
}

.column-body {
  min-height: 0;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```

Rules:

- Board left edge aligns to subheader left edge
- Board right edge aligns to subheader/header right edge
- Columns use `repeat(4, minmax(0, 1fr))`
- Column gap is exactly `16px`
- Column headers are `48px`
- Column `+` buttons are `32x32`
- Card left edges align to `columnLeft + 16px`

### 5. Toolbar component standard

Create one reusable toolbar system and use it everywhere.

```css
.toolbar {
  height: var(--toolbar-h);
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon-button {
  width: var(--icon-btn);
  height: var(--icon-btn);
  padding: 0;
  display: grid;
  place-items: center;
}

.text-button {
  height: var(--toolbar-h);
  padding-inline: 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
```

Apply this to:

- Top-right `+ New Task`
- Search/filter/sort toolbar
- Column `+` buttons
- Sidebar collapse/back controls
- Any future page actions

This prevents each toolbar from having its own height, padding, and optical offset.

## Specific fixes for the current screen

1. **Round the sidebar width to `320px`.**  
   The divider appears slightly off-grid. Make the sidebar a fixed app-shell column.

2. **Put header, subheader, and board inside the same main rail.**  
   They should all use `padding-inline: 32px` from the main content column.

3. **Remove independent margins from header/subheader/board.**  
   No `ml-6`, `px-5`, `left-[...]`, or component-specific nudges on these regions.

4. **Make the top rows shared across sidebar and main.**  
   Use:
   ```txt
   Row 1: 72px  topbar/header
   Row 2: 56px  workspace selector / page tabs
   Row 3: 16px  gap
   Row 4: rest  nav list / board
   ```

5. **Align sidebar nav start with board start.**  
   The `New thread/Search/Tasks` block should begin on the same vertical row as the board columns.

6. **Right-align all toolbars to the same rail.**  
   `+ New Task`, search/filter/sort, and the far-right edge of the Done column should all terminate on `mainRight`.

7. **Standardize all toolbar buttons to `32px`.**  
   This includes the top action button, filter icons, sort icon, and column add buttons.

8. **Use `box-sizing: border-box`.**  
   Borders should be included in measured widths. This avoids 1px drift between columns and headers.

## Debug overlay

Add this temporarily while aligning:

```css
.grid-debug::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 999999;
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, 0.06) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, 0.06) 1px, transparent 1px);
  background-size: 8px 8px;
}
```

Then check:

- Sidebar divider lands on an 8px line
- Header title group starts on the main rail
- Tabs start on the same rail
- Board starts on the same rail
- Header actions and subheader tools end on the same right rail
- Column left/right edges land on calculated grid positions
- Every toolbar button is `32x32`
- Every major row height is a multiple of `8`

---

## User

{'asset_pointer': 'sediment://file_000000002b8c71fdbcede0d6720497b0', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 540, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 413995, 'width': 1846}
nad is there a cheap test to prevent this regressing? and clean tool tips that show full text on truncated items.
add in making these pill shaped so everything has matching radius. we use tailwind. give general agent guidance not spefic code.

---

## Assistant

Mr. White, here is general agent guidance you can paste into the implementation task.

---

## Agent guidance: grid alignment, truncation tooltips, pill radius, and cheap regression coverage

### Goal

Bring the app chrome onto one consistent layout system:

- Sidebar nav
- Page header
- Page subheader
- Search/filter toolbar
- Board/list toolbars
- Pills, filters, chips, tags, selected states
- Truncated labels and long titles

Use Tailwind conventions and shared tokens/classes. Avoid one-off spacing, radius, and alignment values.

---

## 1. Establish one Tailwind layout rhythm

Use an **8px-based rhythm** everywhere.

The agent should audit the current layout and replace scattered spacing/radius values with shared Tailwind choices:

| UI concern | Preferred Tailwind direction |
|---|---|
| Major page padding | `px-6`, `px-8`, or one shared app value |
| Section gaps | `gap-2`, `gap-4`, `gap-6` |
| Toolbar height | one shared height, usually `h-8` or `h-10` |
| Icon button size | one shared square size, usually `size-8` |
| Pills/chips | `rounded-full` |
| Cards/panels | one shared rounded value, usually `rounded-xl` or `rounded-2xl` |
| Borders | one shared border color token |
| Muted text | one shared muted text token |

The important rule: **each layout region should inherit its position from the app shell grid**, rather than using local nudges.

Avoid component-specific fixes like:

- arbitrary left offsets
- mixed `ml-*` values to visually compensate
- inconsistent `px-*` between header, subheader, and content
- different icon button dimensions in different toolbars
- mixed `rounded-md`, `rounded-lg`, `rounded-xl`, and `rounded-full` for the same control family

---

## 2. Align nav, header, subheader, and toolbars to shared rails

Define two major rails:

1. **Sidebar rail**
   - Sidebar width fixed.
   - Sidebar internal padding consistent.
   - Nav icons, labels, section headers, and selected states align to predictable internal columns.

2. **Main content rail**
   - Header, subheader, search toolbar, and content all start at the same x-position.
   - Right-side toolbar actions all end at the same x-position.
   - Board/list content uses the same horizontal padding as the header/subheader.

The agent should verify these alignments visually and with bounding boxes:

- Header title group starts on the main content rail.
- Subheader tabs/search controls start on the same rail.
- Main content/card/list area starts on the same rail.
- Top-right action button ends on the same right rail as filter/sort toolbar.
- Column/list/card container ends on the same right rail.

---

## 3. Standardize toolbar behavior

Create a single toolbar pattern and reuse it.

All toolbars should share:

- Same height
- Same vertical centering
- Same icon button size
- Same gap between controls
- Same border/radius treatment
- Same hover/focus behavior
- Same disabled state

Apply this pattern to:

- Header actions
- Search/filter/sort controls
- Board column actions
- Sidebar top controls
- Search modal controls
- Inline filter chips

This will prevent the search overlay, page toolbar, and board toolbar from drifting apart over time.

---

## 4. Make filter chips and controls pill-shaped

For pills, chips, filters, badges, and selected tokens, use a consistent pill system:

- Use `rounded-full`.
- Use one or two approved heights only.
- Use consistent horizontal padding.
- Keep icon spacing consistent.
- Make close buttons use the same internal hit area.
- Match hover, active, selected, and focus states.

In the screenshot, the search chip/filter controls should visually belong to the same family as other selected filters and tags. The agent should normalize them to the same pill shape and radius.

Recommended control family split:

| Component family | Radius guidance |
|---|---|
| Pills, chips, filters, badges | `rounded-full` |
| Icon buttons | `rounded-full` or same pill treatment when inside toolbars |
| Cards, panels, columns | shared panel radius |
| Inputs/search containers | shared input radius, likely pill-shaped for global search |

The important rule: **interactive inline controls should all feel like pills unless they are cards/panels.**

---

## 5. Add clean tooltips for truncated items

Add a reusable truncation-tooltip behavior.

### Behavior requirements

For any item that can truncate:

- Show ellipsis in the normal layout.
- Show the full text in a tooltip only when the text is actually truncated.
- Tooltip appears on hover and keyboard focus.
- Tooltip disappears on blur, mouse leave, escape, or route change.
- Tooltip should use the full raw text, not the visually truncated text.
- Tooltip should avoid covering the item when possible.
- Tooltip should constrain width and wrap cleanly for long strings.
- Tooltip should be accessible through `aria-label` or equivalent screen-reader support.

### Where to apply

Apply this to:

- Sidebar thread titles
- Sidebar nav items with long labels
- Task/card titles
- Release names
- Search result titles
- Filter chips with long values
- Table/list cells
- Breadcrumbs
- Any selected search token like `Never Say A Word`

### Tooltip quality bar

The tooltip should feel lightweight:

- Small delay before appearing
- No giant popovers for short text
- No tooltip when the full text already fits
- Consistent dark/light styling
- Consistent radius and shadow
- Does not cause layout shift
- Works inside scroll containers

The agent should implement this as a reusable primitive, rather than adding ad hoc `title` attributes everywhere.

Native browser `title` can be used as a last-resort fallback, but a custom tooltip primitive gives better styling, timing, keyboard behavior, and consistency.

---

## 6. Cheap regression test

Use a low-cost **Playwright geometry test** rather than relying only on screenshots.

Create one deterministic test route or seeded app state with:

- Sidebar visible
- Header visible
- Subheader visible
- Search/filter toolbar visible
- Board/list content visible
- At least one long truncated title
- At least one long filter chip
- At least one right-side toolbar
- At least one selected nav item

### Test viewport

Run at one or two fixed desktop viewports:

- Primary: the common wide desktop size used in your screenshots
- Optional secondary: a narrower desktop size

Keep it deterministic:

- Disable animations during tests.
- Use seeded data.
- Avoid network-dependent content.
- Avoid image-loaded layout shifts where possible.
- Use stable fonts or wait for fonts to load.

### Geometry assertions

The test should measure element bounding boxes and assert:

- Header left rail equals subheader left rail.
- Header left rail equals main content left rail.
- Header right rail equals subheader toolbar right rail.
- Main content right rail equals header action right rail.
- Sidebar width is stable.
- Toolbar controls have the expected shared height.
- Icon buttons have the expected shared square size.
- Board/list columns start and end on the expected rails.
- Major horizontal gaps match the shared spacing token.
- Pills have radius at least half their height.
- Matching pill components share the same height and radius.

Use a small tolerance, around 1px, to account for browser rounding.

### Tooltip assertions

Add a cheap tooltip test:

- Render one truncated item.
- Confirm its visible text is clipped.
- Hover or focus it.
- Confirm a tooltip appears.
- Confirm tooltip text equals the full underlying label.
- Confirm tooltip does not appear for a short item that fits.
- Confirm keyboard focus also triggers the tooltip.
- Confirm Escape or blur dismisses it.

### Pill shape assertions

Add a simple check for pill-shaped controls:

- Filter chips
- Search tokens
- Badges
- Inline selected filters
- Icon buttons if they are part of the pill family

Assert their rendered border radius is consistent with pill geometry.

This test catches regressions when someone changes Tailwind classes, swaps a component, or adds a custom radius.

---

## 7. Optional visual snapshot

Add one lightweight screenshot snapshot after the geometry test passes.

Use it only as a secondary guardrail. Geometry tests are cheaper and less flaky for this problem.

Snapshot should cover:

- Sidebar
- Header
- Subheader
- Search/filter state
- Board/list area
- Truncated tooltip open state

Keep the snapshot scoped to the app shell area, not the full OS/browser frame.

---

## 8. Acceptance criteria

The work is done when:

- Header, subheader, content, and right toolbars align to shared rails.
- Sidebar items align to a consistent internal grid.
- Toolbars share the same sizing system.
- Filter/search chips are pill-shaped and visually consistent.
- Truncated items show clean full-text tooltips.
- Tooltips appear only when truncation actually occurs.
- Keyboard users can trigger and dismiss tooltips.
- A Playwright geometry test prevents alignment regressions.
- The test runs cheaply in CI without relying on manual visual review.

---

## User

{'asset_pointer': 'sediment://file_00000000f4e071fdb21d5e2cfdce7ca4', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 542, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 137233, 'width': 1052}
{'asset_pointer': 'sediment://file_00000000c03471fda3737c5f70e635ed', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 346, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 120702, 'width': 1020}
and here we have 3 sidebar collapse button. plus the back to app is probably not need in the elctron app cuz we have the back button etc right there. and we want the white pill udpate button to live up there wwhen an update is ready like codex app does it live in that space to the right of the arrows

---

## Assistant

Mr. White, add this to the agent brief.

---

# Agent guidance: sidebar chrome cleanup and update pill placement

## Goal

Match the Codex-style Electron chrome pattern:

```txt
Traffic lights → Sidebar toggle → Back → Forward → Update pill when ready
```

Remove duplicate sidebar-collapse controls and avoid putting navigation controls inside the content header.

---

## 1. Use one sidebar-collapse control

There should be exactly **one** primary sidebar toggle in the Electron app shell.

### Keep

The sidebar toggle should live in the top chrome row, immediately after the macOS traffic lights.

Placement:

```txt
[red yellow green] [sidebar toggle] [back] [forward] [update pill if ready]
```

### Remove or hide

Remove the duplicate sidebar-toggle affordances from:

- The workspace/sidebar header row.
- The main content header.
- Any circular “sidebar” button beside the page title.

In the screenshot, there are currently three visual sidebar/collapse controls. Collapse this down to one canonical control in the titlebar.

### Tooltip

Use the Codex-style tooltip:

```txt
Toggle sidebar   ⌘B
```

Behavior:

- Tooltip on hover and keyboard focus.
- `⌘B` toggles sidebar.
- Button remains visible whether the sidebar is open or closed.
- Button state should visually indicate active/open state if needed.

---

## 2. Remove “Back to app” from the Electron layout

In the Electron app, the dedicated “Back to app” control is redundant because the app chrome already has back/forward navigation.

### Guidance

- Remove the “Back to app” button from the main header in the desktop Electron shell.
- Keep native-style back and forward buttons in the top chrome row.
- If the web app still needs “Back to app,” keep it web-only behind an environment/layout condition.
- The main page header should start with the actual page title, not navigation chrome.

Result:

```txt
Electron chrome handles navigation.
Page header handles page identity and page actions.
Sidebar handles app sections.
```

---

## 3. Put the update pill in the titlebar toolbar

When an update is available, show the white pill in the empty chrome space to the right of the navigation arrows, matching the Codex pattern.

Placement:

```txt
Traffic lights
→ Sidebar toggle
→ Back
→ Forward
→ Update pill
→ remaining draggable titlebar space
```

### Update pill behavior

Use a compact pill-shaped button.

States:

| State | UI |
|---|---|
| No update | No pill shown |
| Update available | White pill appears after forward arrow |
| Update downloaded | Pill copy changes to “Restart to update” or equivalent |
| Updating | Disabled/loading state if needed |

The update pill should:

- Use the same pill radius system as filter chips.
- Use consistent titlebar button height.
- Avoid pushing page content around.
- Stay in the chrome layer, outside the sidebar and page header.
- Be keyboard focusable.
- Have a clear tooltip or accessible label.

---

## 4. Titlebar structure

Use a single Electron titlebar control cluster.

Recommended order:

```txt
macOS traffic lights
sidebar toggle
back button
forward button
conditional update pill
draggable empty region
```

Rules:

- All controls are vertically centered.
- All icon buttons use the same square size.
- Back/forward disabled states are visually clear.
- Titlebar controls are marked as interactive, not draggable.
- Empty titlebar space remains draggable.
- No page-level component should duplicate these controls.

---

## 5. Page header cleanup

After removing the duplicate navigation/control buttons, the main header should contain only:

- Page title
- Optional page icon if it is semantic, not interactive chrome
- Page-level actions on the right

Example:

```txt
New thread                                      [page actions if any]
```

Do not put these in the page header:

- Sidebar collapse
- Back to app
- Browser back
- Browser forward
- Update button

---

## 6. Sidebar cleanup

The sidebar should contain:

- Workspace selector
- Primary nav
- Thread list
- User/workspace/admin sections
- Footer/version if needed

Do not put this in the sidebar body/header:

- Another sidebar collapse button
- Back/forward navigation
- Update prompt

The sidebar can still respond to collapsed/expanded state, but the control for that state lives in the titlebar.

---

## 7. Regression tests

Add cheap Playwright coverage for this.

### Chrome control count

Assert that the Electron shell has:

- Exactly one visible `Toggle sidebar` button.
- Exactly one visible back button.
- Exactly one visible forward button.
- Zero visible “Back to app” controls in Electron mode.

### Sidebar toggle behavior

Assert:

- Clicking the titlebar sidebar toggle collapses the sidebar.
- Clicking it again expands the sidebar.
- `⌘B` performs the same toggle.
- Tooltip says `Toggle sidebar` and shows the shortcut.

### Update pill behavior

Use seeded update states.

Assert:

- No update state: update pill absent.
- Update-ready state: update pill visible after the forward button.
- Update pill is in the titlebar/chrome region, not inside page header or sidebar.
- Pill is horizontally positioned to the right of the forward arrow.
- Pill uses pill geometry: radius is at least half its height.
- Page content rails do not shift when the pill appears.

### Header cleanup

Assert in Electron mode:

- Page header starts with page title content.
- Page header does not contain sidebar toggle.
- Page header does not contain “Back to app.”
- Page header left rail remains aligned with main content.

---

## 8. Acceptance criteria

Done means:

- Only one sidebar toggle exists.
- Sidebar toggle lives beside the traffic lights.
- Back/forward live in the titlebar.
- “Back to app” is removed from Electron layout.
- Update pill appears to the right of the arrows when ready.
- Update pill uses the shared pill style.
- Main header contains page identity and page actions only.
- Playwright catches duplicate controls and update-pill placement regressions.

---

## User

open an issue for this

---

## Assistant

Mr. White, I found two related completed issues:

- **JOV-1967** — Desktop + web Update pill, completed. fileciteturn5file0L1-L3
- **JOV-2385** — Electron header / upgrade banner polish, completed. fileciteturn6file0L1-L3

I could not create a new Linear issue because the connected Linear tool currently exposes search/read/list actions, with no create-issue action available.

Use this new issue:

## Title

**Electron shell: unify titlebar controls, grid alignment, pill styling, and truncation tooltips**

## Description

Clean up the Electron app shell and prevent future regressions in titlebar/sidebar/header alignment.

### Scope

- Use exactly one sidebar-collapse control.
- Place the sidebar toggle in the Electron titlebar next to the traffic lights.
- Remove duplicate sidebar-collapse controls from the sidebar body/header and main page header.
- Remove “Back to app” from the Electron layout.
- Keep back/forward navigation in the titlebar chrome.
- Place the update pill to the right of the back/forward arrows when an update is ready.
- Align nav, header, subheader, search/filter toolbar, and content to shared grid rails.
- Make filter chips, search tokens, badges, and inline selected controls pill-shaped with matching radius.
- Add clean full-text tooltips for truncated items.
- Add cheap Playwright geometry coverage to prevent layout regressions.

### Acceptance criteria

- Only one visible `Toggle sidebar` control exists in Electron.
- `⌘B` toggles the sidebar.
- Sidebar toggle tooltip shows `Toggle sidebar` and the shortcut.
- Back/forward controls live in the titlebar.
- “Back to app” is absent in Electron.
- Update pill appears to the right of the forward arrow only when update state is ready.
- Update pill uses shared pill styling.
- Header, subheader, toolbar, and content left/right rails align.
- Truncated labels show full text on hover and keyboard focus.
- Tooltip appears only when the item is actually truncated.
- Pill controls use consistent height, padding, and `rounded-full`.
- Playwright checks duplicate controls, rail alignment, pill radius, and tooltip behavior.

### Regression tests

Add deterministic Playwright tests for:

- Single sidebar toggle count.
- No Electron “Back to app” control.
- Update pill titlebar placement.
- Shared header/subheader/content rail alignment.
- Toolbar button size consistency.
- Pill radius consistency.
- Truncated item tooltip behavior.
- Tooltip dismissal on blur/Escape.

### Related completed work

- JOV-1967 — update pill implementation.
- JOV-2385 — Electron header and upgrade banner polish.
