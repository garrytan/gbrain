---
conversation_id: 699a55ca-62a0-832c-a96d-ee342d5cbc60
created: 2026-02-22
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Website to Figma Mockup
type: note
updated: 2026-02-22
---

# Website to Figma Mockup

> Conversation ID: 699a55ca-62a0-832c-a96d-ee342d5cbc60
> Created: 2026-02-22T01:03:29Z
> Updated: 2026-02-22T01:04:47Z
> Messages: 2

---

## User

turn an existing website into a figma mockup

---

## Assistant

Mr. White, here’s the most efficient way to turn an existing website into a Figma mockup.

---

## 1️⃣ Fastest Method (Best for Most Cases)

### Use **HTML → Figma import plugin**

**Tools:**
- Figma plugin: *HTML to Figma*  
- Or: *Anima* plugin (more structured output)

### Steps:
1. Open the website in Chrome.
2. Inspect → Copy page URL.
3. In Figma → Plugins → Run **HTML to Figma**
4. Paste URL.
5. Import.

You’ll get:
- Auto-generated frames
- Text layers (editable)
- Images
- Basic layout structure

⚠️ Expect cleanup. Auto-imported files are messy and not componentized.

---

## 2️⃣ Cleaner Professional Workflow (Recommended)

If you want a *true design system–ready mockup*:

### Step 1: Capture Layout
- Take full-page screenshot (Chrome extension: “GoFullPage”)
- Or export DOM via Webflow/Framer if applicable

### Step 2: Rebuild in Figma
Do NOT rely on raw HTML import.

Recreate:
- Typography styles
- Spacing system (8pt grid ideally)
- Color variables
- Components (buttons, cards, nav)

This gives:
- Clean Auto Layout
- Reusable components
- Dev-ready design system

This is what agencies do.

---

## 3️⃣ Pixel-Perfect Extraction (Advanced)

If you need exact spacing & styling:

### Use:
- Chrome DevTools → Inspect element
- Extract:
  - Font family
  - Font size
  - Line height
  - Padding/margins
  - Color hex
  - Border radius
  - Shadow values

Then recreate precisely in Figma.

This produces a production-grade mockup.

---

## 4️⃣ If You Want It Very Fast (Hack Method)

1. Screenshot website
2. Drop into Figma
3. Lock layer
4. Trace over with Auto Layout

This works surprisingly well for MVP redesigns.

---

## 5️⃣ Important Questions

Before choosing a method, clarify:

- Is this for redesign?
- Is this for investor presentation?
- Is this for handing off to dev?
- Is this for cloning a competitor?
- Do you need responsive breakpoints too?

The workflow changes depending on objective.

---

If you'd like, tell me:
- The website URL
- Your goal (redesign, clone, improve UX, etc.)
- Whether you need desktop only or full responsive

I’ll give you a precise execution plan.


**Topic:** [[chatgpt-clusters/design_ux]]
