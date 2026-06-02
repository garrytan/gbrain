---
title: "Tailwind font size button"
type: note
created: 2025-12-16
updated: 2025-12-16
source: chatgpt-export
conversation_id: 6940a694-8a2c-8333-9af9-4605e65be7f0
message_count: 6
tags: [chatgpt, import, code]
---
# Tailwind font size button

> Conversation ID: 6940a694-8a2c-8333-9af9-4605e65be7f0
> Created: 2025-12-16T00:23:55Z
> Updated: 2025-12-16T00:24:52Z
> Messages: 6

---

## User

whats the tailwind class for the font size on the buttons

---

## Assistant

Mr. White,

On Linear’s buttons, the font size corresponds to **Tailwind `text-sm`**.

For reference in Tailwind defaults:
- `text-sm` → **14px / 0.875rem**
- Common button stack: `text-sm font-medium`

If you want to verify in DevTools, inspect a button and check the computed `font-size`; Linear is consistent about `text-sm` for auth buttons.

---

## User

and button borders

---

## Assistant

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

---

## User

border radius

---

## Assistant

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
