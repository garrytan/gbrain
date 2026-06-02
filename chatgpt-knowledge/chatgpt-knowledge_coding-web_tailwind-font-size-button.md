---
title: "Tailwind font size button"
type: note
created: 2025-12-16
updated: 2025-12-16
source: chatgpt-export
topic: coding-web
message_count: 6
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Tailwind font size button

> **Source:** ChatGPT conversation
> **Date:** 2025-12-16T00:23:55Z
> **Messages:** 6
> **Topic:** coding-web

## Question

whats the tailwind class for the font size on the buttons

## Answer

Mr. White,

On Linear’s buttons, the font size corresponds to **Tailwind `text-sm`**.

For reference in Tailwind defaults:
- `text-sm` → **14px / 0.875rem**
- Common button stack: `text-sm font-medium`

If you want to verify in DevTools, inspect a button and check the computed `font-size`; Linear is consistent about `text-sm` for auth buttons.

## Question

and button borders

## Answer

Mr. White,

Linear’s buttons use **no visible border** by default.

In Tailwind terms:
- Border width: **`border-0`** (or no `border` class at all)
- Style relies on **background + subtle shadow**, not borders

Typical pattern you’ll see:
- Primary: `rounded-md bg-* shadow-sm`
- Secondary/ghost: `bg-transparent hover:bg-*` with **no border**

If you want the closest explicit equivalent:
- **No border:** `border border-transparent` (keeps layout stable)
- Radius: `rounded-md` (≈ 6px)

If you want, I can give you the exact Tailwind recipe to visually match each Linear button variant.

## Question

border radius

## Answer

Mr. White,

Linear buttons use **Tailwind `rounded-md`**.

Details:
- `rounded-md` → **6px radius**
- This is consistent across primary, secondary, and auth buttons

Closest explicit spec:
```html
rounded-md
```

If you want an exact clone including hover/active feel, I can break down the full button utility stack.
