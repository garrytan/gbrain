---
conversation_id: 697960d3-2b88-832c-95be-41b66495fae5
created: 2026-01-28
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: React Hooks Error
type: note
updated: 2026-01-28
---

# React Hooks Error

**Related:** [[coding_web_dev]]

> Conversation ID: 697960d3-2b88-832c-95be-41b66495fae5
> Created: 2026-01-28T01:05:24Z
> Updated: 2026-01-28T01:05:37Z
> Messages: 2

---

## User

react ## Error Type
Runtime Error

## Error Message
Rendered more hooks than during the previous render.

Next.js version: 16.1.1 (Turbopack)


---

## Assistant

Mr. White, this is a **classic React hooks violation**. Facts only.

---

## What the error means
> **“Rendered more hooks than during the previous render”**

React requires that **hooks are called in the exact same order on every render**.  
Your component broke that rule.

---

## The usual causes (in order of frequency)

### 1. **Calling hooks conditionally**
❌ **Wrong**
```tsx
if (isLoggedIn) {
  const [user, setUser] = useState(null);
}
```

✅ **Correct**
```tsx
const [user, setUser] = useState(null);

if (!isLoggedIn) return null;
```

---

### 2. **Calling hooks after an early return**
❌ **Wrong**
```tsx
if (!data) return null;
const [state, setState] = useState();
```

✅ **Correct**
```tsx
const [state, setState] = useState();
if (!data) return null;
```

---

### 3. **Hooks inside loops**
❌ **Wrong**
```tsx
items.map(item => {
  const [x, setX] = useState();
});
```

Hooks must be **top-level only**.

---

### 4. **Hooks inside nested functions**
❌ **Wrong**
```tsx
function handleClick() {
  const [count, setCount] = useState();
}
```

---

### 5. **Different component trees between renders (Next.js-specific)**
Common in **Next.js App Router** when mixing:
- Server vs Client Components
- `use client` added conditionally
- Dynamic imports returning different trees

Example:
```tsx
if (typeof window === "undefined") return null;
```
This can change hook order between SSR and client.

---

## Fast way to find the bug
1. Open the stack trace → **first component listed**
2. Search for:
   - `if (...) use`
   - `return` before hooks
   - hooks inside `.map`, `.forEach`, or functions
3. Fix **order**, not logic

---

## Golden rule (memorize this)
> **Hooks must run unconditionally, at the top level, in the same order, every render.**

---

If you want, paste **the component code** and I’ll pinpoint the exact line in under a minute.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
