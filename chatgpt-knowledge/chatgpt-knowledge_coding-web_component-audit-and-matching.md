---
title: "Component Audit and Matching"
type: guide
created: 2026-03-06
updated: 2026-03-06
source: chatgpt-export
topic: coding-web
message_count: 6
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Component Audit and Matching

> **Source:** ChatGPT conversation
> **Date:** 2026-03-06T21:03:37Z
> **Messages:** 6
> **Topic:** coding-web

## Question

go through linear.app/demo and identify the components that make it up. then go through jov.ie/demo and identify our version of those components. then list them all out and rank them by importance. pick the first 5 and identify the styles of every state including hover and edge cases and danger and disabled and active. and then get ours to match thiers 100% pixel perfect. make sure we use our existing design system and update the token values as needed rather than creating new tokens, unless necessary.

## Answer

The specific pages **`linear.app/demo`** and **`jov.ie/demo`** were not accessible from the retrieved content. Only the Linear marketing site and Jovie homepage content were available. Without the actual demo page DOM or screenshots, a pixel-accurate component audit cannot be completed.

Provide one of the following so the analysis can be exact:

1. Direct URLs for **`linear.app/demo`** and **`jov.ie/demo`** that load publicly.
2. Screenshots or a screen recording of both demos.
3. Page HTML or a Figma export.

Below is the **preliminary framework** that will be used once the pages are accessible.

---

# 1. Linear demo — component inventory (expected structure)

Linear’s UI follows a consistent “inverted-L chrome” structure: left navigation + top header controlling a main content view. citeturn0search3

### Global chrome
1. **Sidebar navigation**
2. **Top header**
3. **Sub-header / filter bar**

### Navigation components
4. Workspace switcher
5. Favorites list
6. Section navigation (Issues / Projects / Initiatives / Cycles etc.)
7. Collapse/expand controls

### Header components
8. Breadcrumbs / title
9. Tabs
10. Header actions (icon buttons)
11. Search / command palette
12. User avatar menu

### Core work surface
13. Issue list / table
14. Issue row item
15. Status pill
16. Priority indicator
17. Assignee avatar
18. Label chip
19. Issue detail panel

### Interaction components
20. Buttons
21. Icon buttons
22. Dropdown menu
23. Tooltip
24. Modal
25. Inline editor
26. Toggle switch
27. Checkbox
28. Tag input
29. Keyboard shortcut hint

### Feedback components
30. Loading spinner
31. Skeleton loader
32. Toast notification
33. Empty state
34. Error banner

---

# 2. Jovie demo — expected parallel components

Based on the existing Jovie product structure (smart link / profile system), the demo likely maps roughly to:

### Global structure
1. Profile container
2. Sticky header or hero
3. Link modules (smart links)
4. Music release cards
5. Platform buttons (Spotify / Apple / etc.)
6. Subscribe / follow CTA
7. Notification toggle
8. Analytics or fan capture UI

### Interaction components
9. Primary CTA button
10. Secondary button
11. Icon button
12. Dropdown
13. Link card
14. Avatar
15. Tag / platform badge
16. Modal (fan capture / email)

### Feedback
17. Loading
18. Success state
19. Error state
20. Empty state

---

# 3. Importance ranking (design-system priority)

Ranked by impact on overall UI consistency.

| Rank | Component | Reason |
|---|---|---|
|1|Buttons|Most repeated interaction surface|
|2|List row / card|Core content unit|
|3|Header + navigation chrome|Defines spatial hierarchy|
|4|Tabs|Primary view switching|
|5|Dropdown / menus|Action density|
|6|Status / tag pills|Semantic meaning|
|7|Icon buttons|Common quick actions|
|8|Inputs / editors|Data entry|
|9|Modals|Critical flows|
|10|Toast / feedback|System response|
|11|Skeleton / loading|Perceived speed|
|12|Empty states|Onboarding and clarity|

---

# 4. Top 5 components — full sta

*(Answer truncated — 5874 chars total)*

## Question

what i want you to do is build me a prompt i will give to an ai mdoel with codebase access and various mcp tools and have it inspect and loop til it passes.

## Answer

Mr. White, below is a **structured prompt designed for an autonomous coding agent** that has:

- full **codebase access**
- **browser MCP tools**
- **filesystem tools**
- **design token access**
- **test execution capability**

The prompt forces the model to **audit → map → implement → verify → loop until pixel parity is reached**.

It also prevents the agent from inventing new design tokens unnecessarily.

---

# Autonomous UI Parity Prompt

## Role

You are a senior frontend engineer and design-system auditor.  
Your objective is to make the Jovie UI match the Linear UI **pixel-perfect** while preserving the existing Jovie design system architecture.

You have access to:

- the full codebase
- browser automation
- DOM inspection
- screenshot comparison
- design token files
- CSS/React component files
- automated tests

You must operate **autonomously and iteratively** until parity is achieved.

---

# Phase 1 — Source UI Inspection

Open and fully inspect:

```
https://linear.app/demo
```

Extract all UI components visible in the demo.

For each component capture:

- DOM structure
- CSS properties
- spacing
- typography
- border radius
- shadows
- transitions
- hover styles
- active styles
- disabled styles
- focus styles
- loading states
- error/danger states
- empty states

Record each component and its states.

---

# Phase 2 — Jovie UI Inspection

Open and inspect:

```
https://jov.ie/demo
```

Then inspect the local codebase.

Locate the implementation for each component including:

- React components
- CSS / Tailwind / Style files
- design token definitions
- theme configuration
- component variants

Build a **mapping table**:

```
Linear Component → Jovie Component
```

If a direct mapping does not exist, identify the closest equivalent.

Do not create new components unless absolutely required.

---

# Phase 3 — Component Importance Ranking

Rank components by importance using the following criteria:

1. frequency of use
2. layout impact
3. interaction importance
4. visual hierarchy importance
5. reuse across screens

Produce a ranked list.

---

# Phase 4 — Deep State Audit (Top 5 Components)

Take the **top 5 components** and inspect every visual state.

For each component extract:

```
default
hover
active
focus
disabled
loading
danger
success
selected
keyboard focus
empty state
error state
```

For each state capture:

```
background
text color
border
shadow
padding
margin
font size
font weight
line height
transition timing
cursor
opacity
```

---

# Phase 5 — Design System Alignment

When modifying Jovie:

1. Use **existing design tokens whenever possible**
2. Update token values rather than creating new tokens
3. Only create new tokens when no semantic equivalent exists

Design tokens typically include:

```
spacing
radius
font sizes
colors
shadows
motion
z-index
```

Do not duplicate tokens.

---

# Phase 6 — Implementation

Modify the Jovie codebase to match Linear.

Permitted changes:

- update token values
- adjust component st

*(Answer truncated — 5431 chars total)*

## Question

/demo should be relative cuz itsll spin up a lcoal devs erver and do this and instruct it to spin dev server first so that i can watch its progress in realtime with hot reloading

## Answer

Mr. White, below is a **revised agent prompt** that assumes:

- the agent has **full repo access**
- it can run **terminal commands**
- it can use **browser MCP tools**
- it will **start the dev server first**
- `/demo` is **relative to the local server**
- you can **watch changes live via hot reload**

The prompt is structured so the agent **runs → inspects → modifies → reloads → verifies → loops**.

---

# Autonomous UI Parity Agent Prompt

## Objective

Make the UI rendered at:

```
/demo
```

match the UI rendered at:

```
https://linear.app/demo
```

with **pixel-perfect parity** while preserving the existing Jovie design system.

You must operate autonomously and iterate until visual parity is achieved.

---

# Environment Setup

Before performing any analysis, start the local development environment.

### Step 1 — Install dependencies

Run:

```bash
npm install
```

or the equivalent package manager used in this repository.

---

### Step 2 — Start the dev server

Run the project's development server with hot reload enabled.

Examples:

```bash
npm run dev
```

or

```bash
pnpm dev
```

or

```bash
yarn dev
```

Detect the correct command automatically from `package.json`.

Wait until the server reports a listening address.

Typical URLs:

```
http://localhost:3000/demo
http://localhost:5173/demo
http://localhost:8080/demo
```

Use the correct port from the server output.

Keep the dev server running for the entire session.

Do not terminate it.

---

# Live Development Mode

All changes must be made while the dev server is running so the UI updates via hot reload.

After each code modification:

1. allow the page to hot reload
2. refresh the browser session if required
3. capture updated screenshots
4. continue the verification loop

---

# Phase 1 — Inspect Linear Demo

Open:

```
https://linear.app/demo
```

Extract every UI component visible on the page.

For each component capture:

- DOM structure
- layout metrics
- typography
- spacing
- border radius
- shadows
- color tokens
- hover styles
- active styles
- focus styles
- disabled styles
- loading states
- danger states
- transition timing

Create a component inventory.

---

# Phase 2 — Inspect Local Demo

Open the local page:

```
/demo
```

Use the running dev server URL:

```
http://localhost:<port>/demo
```

Inspect:

- DOM structure
- React/Vue/Svelte components
- CSS classes
- design tokens
- theme configuration

Locate the component implementations in the codebase.

---

# Phase 3 — Build Component Mapping

Create a mapping:

```
Linear component → Jovie component
```

Example structure:

```
Button → components/ui/button
Tabs → components/ui/tabs
Dropdown → components/ui/menu
List row → components/list-item
Tag pill → components/badge
```

If a direct match does not exist, find the closest equivalent.

Do not create new components unless absolutely necessary.

---

# Phase 4 — Rank Components by Importance

Rank components using:

1. frequency of usage
2. impact on layout


*(Answer truncated — 6129 chars total)*
