# Design System — GBrain Admin Dashboard

## Product Context
- **What this is:** Admin dashboard for GBrain MCP server — manage OAuth agents, API keys, monitor requests
- **Who it's for:** GBrain operators managing multi-agent access to their brain
- **Space/industry:** Developer infrastructure (peers: Supabase dashboard, Vercel, Railway)
- **Project type:** Dense utilitarian admin panel — Steve Krug "Don't Make Me Think"

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian — function-first, data-dense, zero decoration
- **Decoration level:** None — every pixel earns its place with information
- **Mood:** Ops dashboard for someone who builds. Not a marketing site. Not a consumer app. A cockpit.
- **Reference:** Supabase dashboard (dark + dense), Linear (restrained), Grafana (data-forward)

## Alignment
- **Text alignment:** Left-align everything. No centered text in tables, cards, forms, or labels.
- **Headings:** Left-aligned
- **Table data:** Left-aligned (including numbers — contextual readability over columnar alignment)
- **Form labels:** Left-aligned above inputs
- **Buttons in forms:** Right-aligned (action flows left-to-right: Cancel → Submit)
- **Modal titles:** Left-aligned
- **Page titles:** Left-aligned
- **Only exception:** Empty states and the login page lock icon can center for visual weight

## Typography
- **Display/Headings:** Inter (Semibold 600) — clean, neutral, disappears into the content
- **Body/UI:** Inter (Regular 400 / Medium 500)
- **Data/Tables/Code:** JetBrains Mono (Regular 400 / Medium 500) — monospace for anything the user might copy, any ID, any token, any technical value
- **Loading:** Google Fonts. `display=swap`.
- **Scale:**
  - Page title: 24px / Inter Semibold
  - Section title: 14px / Inter Semibold, uppercase, letter-spacing 0.5px
  - Table header: 12px / Inter Medium, uppercase, letter-spacing 1px, muted color
  - Body: 14px / Inter Regular
  - Small/Caption: 13px
  - Micro: 12px (badges, timestamps)
  - Code/Data: 13px / JetBrains Mono

## Color
- **Approach:** Monochrome base + semantic color only. No primary brand color. Color means something.
- **Background:**
  - Base: #0a0a0f (near-black with blue undertone)
  - Surface/cards: #12121a
  - Hover: #1a1a2a
  - Input/code blocks: #0f0f1a
- **Borders:** #1e1e2e (default), #3a3a5a (hover/active)
- **Text:**
  - Primary: #e0e0e0
  - Secondary: #888888
  - Muted: #555555
  - Link: #88aaff
- **Semantic (badges only):**
  - Success/active: #34a853
  - Error/danger: #ff6b6b
  - Warning: #f5a623
  - Read scope: #3b82f6
  - Write scope: #f59e0b
  - Admin scope: #ef4444
- **No accent color.** The data IS the interface. Badges carry all the color.

## Spacing
- **Base unit:** 4px
- **Density:** Dense — this is an ops tool, not a landing page
- **Scale:** 4px, 8px, 12px, 16px, 20px, 24px, 32px, 48px
- **Table row padding:** 10px 16px
- **Card padding:** 24px
- **Modal padding:** 24px
- **Section gaps:** 24px between sections, 12px between related elements

## Layout
- **Sidebar:** Fixed left, 200px wide, dark (#0a0a0f)
- **Main content:** Fluid, max-width none (fills available space)
- **Grid:** Single column for tables (full width), 2-column for stats cards
- **Border radius:**
  - Cards/panels: 16px
  - Buttons/inputs: 8px
  - Badges: 9999px (pill)
  - Tables: 0 (sharp edges — data is rectangular)

## Components

### Tables
- Full-width, no outer border
- Header row: uppercase, letter-spaced, muted color, no background
- Data rows: subtle hover (#1a1a2a), pointer cursor when clickable
- All text left-aligned
- Monospace for IDs, tokens, latency values

### Badges
- Pill shape (border-radius: 9999px)
- Padding: 2px 8px
- Font: 12px
- Scoped to semantic meaning: `success`, `danger`, `read`, `write`, `admin`

### Buttons
- Primary: white text on #3a3a5a, hover brightens
- Secondary: muted text on transparent, border #1e1e2e
- Danger: white text on #ff6b6b background
- Size: 13px font, 6px 14px padding

### Modals
- Overlay: rgba(0,0,0,0.7)
- Card: #12121a, border #1e1e2e, border-radius 16px, max-width 480px
- Title: 18px Semibold, left-aligned
- Close: top-right ✕ button

### Drawers
- Right-side panel, 400px wide
- Slide in from right
- Dark overlay behind
- Close button top-right
- Sections separated by section titles (uppercase, muted)

### Tabs
- Inline horizontal, wrapping allowed
- Active: white text, bottom border
- Inactive: muted text, no border
- No background color on tabs

### Code blocks
- Background: rgba(0,0,0,0.3)
- Border-radius: 8px
- Padding: 10px 14px
- Font: JetBrains Mono 12px
- Copy button: right-aligned, subtle

### Empty states
- Centered text (only exception to left-align rule)
- Muted color
- Suggest next action

## Motion
- **Approach:** Minimal — transitions for hover states only
- **Duration:** 150ms for hovers, 200ms for drawer slide
- **No loading spinners** — show stale data until fresh arrives
- **SSE live feed:** Real-time, no animation on new entries (just prepend)

## Anti-Patterns (do NOT do these)
- ❌ Center-aligned table data
- ❌ Center-aligned headings or labels (except empty states)
- ❌ Gradient backgrounds
- ❌ Shadows (the dark theme IS the depth model)
- ❌ Rounded table corners
- ❌ Icons as navigation (use text labels)
- ❌ Loading skeletons (show real data or nothing)
- ❌ Confirmation toasts (action → result is immediate and visible)
- ❌ Color for decoration (every color means something)

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-01 | Dark theme only | Ops dashboard. No light mode needed. |
| 2026-05-01 | Steve Krug lens | Zero happy talk, mindless choices, scannable tables, billboard-speed comprehension. |
| 2026-05-01 | JetBrains Mono for data | Anything copyable or technical should be monospace. |
| 2026-05-03 | Left-align everything | Garry preference. Centered text is a design crutch. Left-align forces hierarchy through typography weight and spacing, not position. |
| 2026-05-03 | Incorporate GStack design DNA | Same family: Inter + JetBrains Mono, dark base, semantic-only color. Diverges on accent (GStack: amber; GBrain: none — data is the color). |
| 2026-05-03 | Per-client config export tabs | Claude Code, ChatGPT, Claude.ai, Cursor, Perplexity, JSON. Every agent has a copy-paste setup path. |
| 2026-05-03 | Magic link auth | Login page tells you to ask your agent. No pasting hex strings into forms. |
