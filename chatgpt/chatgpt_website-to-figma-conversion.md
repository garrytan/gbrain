---
conversation_id: 6993bc40-47d0-8330-9ecc-a8486f3972b5
created: 2026-02-17
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Website to Figma Conversion
type: guide
updated: 2026-02-17
---

# Website to Figma Conversion

> Conversation ID: 6993bc40-47d0-8330-9ecc-a8486f3972b5
> Created: 2026-02-17T00:55:06Z
> Updated: 2026-02-17T00:57:21Z
> Messages: 6

---

## User

can i get a website turned into figma? can i extract a design system form an ecisting web app? whats the best way to do this that would be accurate and exact and light/dark mode and all states

---

## Assistant

Yes. You can convert a live website into Figma and extract a structured design system — including light/dark modes and interactive states — but accuracy depends on the method.

Here’s the correct way to do it if you want it **exact and production-faithful**.

---

# 1️⃣ Can you turn a website into Figma?

## Option A — HTML → Figma Plugins (Fast, Not Perfect)

Examples:
- **html.to.design**
- **Locofy**
- **Anima**

**Pros**
- Quick
- Preserves layout structure
- Pulls fonts, colors, spacing

**Cons**
- Messy auto-layout
- Poor component structure
- States usually flattened
- Dark mode not separated into tokens

Use this only as a starting draft.

---

## Option B — Inspect + Rebuild (Most Accurate)

This is the professional method used in product teams.

### Step 1 — Extract Design Tokens from DevTools
Open Chrome DevTools → inspect:

- Colors (including CSS variables like `--color-bg-primary`)
- Typography scales
- Spacing scale
- Border radius
- Shadows
- Breakpoints
- Motion timing

If the app uses CSS variables, you can extract light/dark easily because tokens are already defined.

---

### Step 2 — Extract Component States

You must manually capture:

- Default
- Hover
- Active
- Focus
- Disabled
- Error
- Loading

Use:
- DevTools “:hover” force state toggle
- Responsive mode
- Record interactions if needed

This is the only way to get **accurate state logic**.

---

### Step 3 — Screenshot for Pixel Reference

Take high-res screenshots (2x or 3x DPR) for:
- Light mode
- Dark mode
- All breakpoints

Rebuild in Figma using:
- Auto Layout
- Proper constraints
- Variables for tokens

---

# 2️⃣ Extracting a Design System from an Existing Web App

Yes — this is completely possible.

The best workflow:

## 🔹 Step A — Pull CSS Variables (If They Exist)

Look in `:root` for:
```
--color-primary
--spacing-2
--radius-md
--font-size-sm
```

If tokens exist → replicate directly into Figma Variables.

This preserves:
- Light/Dark themes
- Brand consistency
- System logic

---

## 🔹 Step B — Build a Token Map in Figma

In Figma:
- Create color variables
- Create typography styles
- Create spacing variables
- Create semantic tokens (Primary / Surface / Error / etc.)

Mirror exactly how the app structures tokens.

---

## 🔹 Step C — Component Audit

Inventory:
- Buttons
- Inputs
- Modals
- Dropdowns
- Tables
- Navigation
- Cards

Map:
Component → Variants → States → Size → Theme

Use Figma component variants for:
- Size
- State
- Mode (Light/Dark)

---

# 3️⃣ Handling Light / Dark Mode Properly

Correct way:

### Use Figma Variables + Modes

Define:
Color → Variable → Modes:
- Light
- Dark

Do NOT duplicate components.

Instead:
- One component
- Token driven
- Mode switch controls theme

This mimics production behavior.

---

# 4️⃣ If You Want It 1:1 Accurate

This is the highest fidelity workflow:

1. Clone the app locally (if you have access)
2. Extract full CSS file
3. Parse tokens programmatically
4. Build token spreadsheet
5. Import into Figma variables
6. Reconstruct components using real spacing values
7. Test side-by-side against browser

That yields near pixel-perfect parity.

---

# 5️⃣ What NOT to Do

❌ Don’t rely solely on HTML-to-Figma conversion  
❌ Don’t screenshot and trace without extracting tokens  
❌ Don’t rebuild without checking hover/focus states  
❌ Don’t duplicate light/dark as separate files  

---

# 6️⃣ If You Want Enterprise-Level Accuracy

Tools teams use:

- Storybook (if app has it)
- Zeroheight (for documentation)
- Tokens Studio for Figma
- Style Dictionary (for token export/import)

If the app is React-based, you can sometimes inspect:
- Styled Components theme objects
- Tailwind config
- Design token JSON files

That’s gold.

---

# 7️⃣ Bottom Line

Yes, you can extract a design system from an existing web app.

For:
- Maximum accuracy
- All states
- Proper light/dark
- Production parity

You must:
- Extract tokens
- Audit components
- Rebuild systematically in Figma using variables

Auto-conversion tools alone won’t get you there.

---

If you'd like, tell me:
- Is the app built with React / Tailwind / something else?
- Do you have access to the codebase?
- Is this for redesign, documentation, or acquisition diligence?

That changes the optimal workflow.

---

## User

i want linear.app ass a design system

---

## Assistant

## entity["company","Linear","software company"] — Design System Breakdown

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["Linear app dashboard dark mode","Linear app dashboard light mode","Linear app issue view UI","Linear app command palette UI"],"num_per_query":1}

Mr. White — if you want **Linear as a design system**, the goal is not copying visuals. It’s extracting the underlying structure:

Linear is defined by:
- Tight spacing scale
- Subtle elevation
- Low-contrast surfaces
- Refined typography
- Motion-driven interactions
- Token-driven light/dark

Below is how to rebuild it properly in Figma.

---

# 1️⃣ Core Design Tokens (The Foundation)

Linear is heavily tokenized. You must build this first.

### Colors (Semantic, Not Raw)
Create variables like:

**Surface**
- `bg-primary`
- `bg-secondary`
- `bg-tertiary`

**Content**
- `text-primary`
- `text-secondary`
- `text-tertiary`

**Border**
- `border-default`
- `border-subtle`

**Intent**
- `accent`
- `danger`
- `success`
- `warning`

Use Figma Variables with **Light + Dark modes**, not separate styles.

Linear uses:
- Very low chroma grays
- Soft borders (barely visible)
- Accent color used sparingly

---

# 2️⃣ Typography System

Linear uses:
- Clean neo-grotesk (Inter-like)
- Tight vertical rhythm
- Strong hierarchy via weight, not size jumps

Recreate:

| Role | Size | Weight |
|------|------|--------|
| Display | 24–28 | 600 |
| H1 | 18–20 | 600 |
| Body | 14 | 400 |
| Meta | 12–13 | 500 |

Important:
- Small line-height delta
- Slight negative letter spacing for headings

---

# 3️⃣ Spacing System

Linear is extremely consistent.

Use 4px base scale:

4 / 8 / 12 / 16 / 20 / 24 / 32 / 40

Most padding is 12–16.
Most gaps are 8–12.

No randomness.

---

# 4️⃣ Component Architecture

You must build these as **variants**:

### Button
Variants:
- Primary
- Secondary
- Ghost
- Danger

States:
- Default
- Hover
- Active
- Focus
- Disabled

Size:
- Small
- Medium

---

### Input
Variants:
- Default
- Focused
- Error
- Disabled

Linear uses:
- Subtle border
- Slight fill change on focus
- No heavy shadows

---

### Table Rows
Critical for Linear feel:

States:
- Default
- Hover
- Selected
- Active

Rows use:
- Subtle background shifts
- Left accent indicator
- Minimal separators

---

# 5️⃣ Light / Dark Mode (Do This Correctly)

DO NOT duplicate components.

In Figma:
- Use color variables
- Create Light and Dark modes
- Apply semantic tokens to components

Switching modes should automatically update entire UI.

That mirrors how Linear works.

---

# 6️⃣ Motion (This Is Why Linear Feels Premium)

Most people miss this.

Linear uses:
- 150–200ms transitions
- Ease-out curves
- Slight scale fade for modals
- Soft hover opacity changes

If you don’t include motion in your system, it won’t feel like Linear.

---

# 7️⃣ What Makes Linear Special (Subtle Details)

- Borders are barely visible
- Dividers use opacity, not hard lines
- Dark mode is not inverted — it’s carefully tuned
- UI density is high but breathable
- Accent color is restrained

---

# 8️⃣ Best Way To Recreate It Accurately

1. Screenshot light and dark
2. Inspect CSS variables
3. Extract spacing + typography
4. Build tokens first
5. Build primitives (button/input/card)
6. Build layout components (sidebar, issue list, header)
7. Add interaction prototypes

Do NOT start by building pages.

Start with tokens.

---

If you want, I can:
- Break down Linear’s exact color palette
- Draft a full token table
- Outline the exact component inventory
- Or help you design a “Linear-inspired but differentiated” system

Which direction are you taking this, Mr. White — cloning, studying, or building your own product?

---

## User

can i do this as an automated process in claude or chat or windsurf? can it be deterinistic and perfoect?

---

## Assistant

Mr. White — short answer:

**No. It cannot be perfectly deterministic or 1:1 automated today.**  
But you can get ~80–90% there with automation + structured reconstruction.

Here’s the reality.

---

# Can Claude / ChatGPT / Windsurf Fully Extract Linear’s Design System?

## 1️⃣ If You Only Have the Live Website

Automation can:
- Scrape CSS variables
- Extract computed styles
- Capture DOM structure
- Detect spacing patterns
- Screenshot states

Automation cannot reliably:
- Infer semantic token naming
- Separate primitives vs components
- Understand interaction logic
- Extract motion curves precisely
- Capture all hidden states
- Rebuild clean Figma component architecture

The AI sees pixels + styles.  
It does **not** understand product architecture the way a designer does.

---

# Deterministic?

Deterministic means:
> Same input → same structured system output every time.

You won’t get that because:
- CSS can be layered / overridden
- Components may reuse classes inconsistently
- Some states only appear after interaction
- Light/dark may use runtime switching
- Responsive breakpoints complicate token mapping

Even if scraped, you’ll still need normalization logic.

---

# Where Automation *Does* Work Well

If you have access to the actual codebase (React, Tailwind, Styled Components):

Then yes — you can get much closer.

You can deterministically extract:

- Tailwind config
- Theme object
- CSS variables
- Token JSON
- Spacing scale
- Breakpoints

That part is near-perfect.

What remains non-deterministic:
- Component abstraction
- UX intent
- Motion architecture
- Variant modeling in Figma

---

# Best Semi-Automated Workflow

This is the most accurate pipeline today:

### Step 1 — Script Extraction
Use Playwright or Puppeteer to:
- Visit every route
- Force :hover / :focus states
- Toggle dark mode
- Dump computed styles
- Capture screenshots

### Step 2 — Extract Tokens
Parse:
- Colors
- Font families
- Font sizes
- Spacing values
- Border radius
- Shadows

Cluster values to detect scale patterns.

### Step 3 — Generate Structured Token JSON
Normalize into:
- Primitive tokens
- Semantic tokens
- Light/Dark modes

### Step 4 — Import Into Figma via Tokens Studio
Now you have a deterministic token base.

### Step 5 — Manually Reconstruct Components
This part cannot be automated cleanly yet.

---

# Windsurf / Claude Agent Possibility?

If you run an agent that:
- Crawls the app
- Reads CSS + JS
- Parses theme configs
- Outputs structured system documentation

You can get a very clean foundation.

But you still must:
- Curate
- Rename
- Organize
- Architect variants

No AI can currently rebuild Linear’s system with production-level cleanliness without human direction.

---

# If Your Goal Is Pixel-Perfect Clone

You would need:

1. Full code access
2. Token extraction script
3. State crawler
4. Motion inspector
5. Manual component modeling

Even then — “perfect” means matching behavior, not just visuals.

---

# The Honest Answer

You can automate:
- 70–90% of raw data extraction

You cannot automate:
- Design judgment
- Component architecture
- Interaction nuance
- Clean Figma system modeling

---

If you tell me your real objective, I can optimize the approach:

- Are you cloning Linear for internal tooling?
- Are you building a startup inspired by it?
- Are you trying to reverse engineer for acquisition analysis?
- Or building a reusable design system engine?

Those are very different strategies, Mr. White.


**Topic:** [[chatgpt-clusters/design_ux]]
