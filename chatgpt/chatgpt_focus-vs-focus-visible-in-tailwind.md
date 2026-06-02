---
conversation_id: 68a16ceb-af3c-832f-882b-4532e88c1a01
created: 2025-08-17
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Focus vs focus-visible in Tailwind
type: note
updated: 2025-08-17
---

# Focus vs focus-visible in Tailwind

**Related:** [[coding_web_dev]]

> Conversation ID: 68a16ceb-af3c-832f-882b-4532e88c1a01
> Created: 2025-08-17T05:47:39Z
> Updated: 2025-08-17T05:47:44Z
> Messages: 2

---

## User

Should i use focus or focus visible in tailwind to keep cat's acceibsle but prettty

---

## Assistant

Use **`focus-visible`** in Tailwind, not `focus`.  

- `focus`: always shows focus styles when an element is focused (keyboard *or* mouse click). That means if you click a button with a mouse, you'll see the ugly ring/border.  
- `focus-visible`: only shows focus styles when the browser thinks they’re needed—usually when navigating by keyboard (e.g. Tab). This keeps things **accessible** for keyboard users while keeping the UI **clean** for mouse users.  

So your Tailwind classes should look like:

```html
<button class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
  Click me
</button>
```

That way, mouse users don’t see the outline, but keyboard users still get the accessibility indicator.  

Want me to give you a short Tailwind snippet that makes buttons *pretty* but still passes accessibility?


**Topic:** [[chatgpt-clusters/coding_web_dev]]
