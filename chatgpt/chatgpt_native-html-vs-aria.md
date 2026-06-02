---
conversation_id: 6973ab8c-44cc-832c-b3b2-294e35df7eb0
created: 2026-01-23
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Native HTML vs ARIA
type: note
updated: 2026-01-23
---

# Native HTML vs ARIA

> Conversation ID: 6973ab8c-44cc-832c-b3b2-294e35df7eb0
> Created: 2026-01-23T17:10:36Z
> Updated: 2026-01-23T20:55:30Z
> Messages: 2

---

## User

Use native HTML elements instead of ARIA roles

---

## Assistant

Use **native HTML elements first**. They come with built-in semantics, keyboard behavior, and accessibility APIs. ARIA is a fallback, not a replacement.

### Core rule
> **If there’s a native HTML element for the job, use it.**  
> Only use ARIA when no semantic element exists.

### Common replacements (ARIA → native)
- `role="button"` → `<button>`
- `role="link"` → `<a href="…">`
- `role="navigation"` → `<nav>`
- `role="main"` → `<main>`
- `role="banner"` → `<header>`
- `role="contentinfo"` → `<footer>`
- `role="list"` / `role="listitem"` → `<ul><li>`
- `role="textbox"` → `<input>` / `<textarea>`
- `role="checkbox"` → `<input type="checkbox">`
- `role="radio"` → `<input type="radio">`
- `role="dialog"` → `<dialog>` (or `<section>` with heading if not modal)
- `role="table"` → `<table>`

### Why this matters (facts)
- Native elements **automatically expose correct accessibility semantics**.
- They **handle keyboard interaction** (Tab, Enter, Space) without JS.
- Screen readers are **more reliable** with native semantics.
- ARIA does **not add behavior**—you must implement everything yourself.
- Misused ARIA can **reduce accessibility**.

### Example
**Bad**
```html
<div role="button" tabindex="0" onclick="save()">Save</div>
```

**Good**
```html
<button type="button" onclick="save()">Save</button>
```

### When ARIA *is* appropriate
- No native equivalent exists (e.g., complex widgets).
- Enhancing semantics, not replacing them:
  - `aria-expanded`
  - `aria-live`
  - `aria-describedby`

### Hard rule to remember
> **No ARIA is better than bad ARIA.**

If you want, share a snippet and I’ll refactor it to native HTML, Mr. White.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
