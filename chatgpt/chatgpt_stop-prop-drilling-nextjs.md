---
title: "Stop Prop Drilling Next.js"
type: guide
created: 2026-01-14
updated: 2026-01-14
source: chatgpt-export
conversation_id: 6967d645-4348-832f-8b97-88ed195fe004
message_count: 6
tags: [chatgpt, import, code]
---
# Stop Prop Drilling Next.js

> Conversation ID: 6967d645-4348-832f-8b97-88ed195fe004
> Created: 2026-01-14T17:45:41Z
> Updated: 2026-01-14T17:47:05Z
> Messages: 6

---

## User

stop prop drilling in next.us

---

## Assistant

Mr. White,

To stop **prop drilling in Next.js (App Router)**, use **state colocated where it’s needed**, **global state**, or **composition**. These are the only approaches that scale.

---

## 1. **React Context (local, scoped state)**
Best when state is shared by a **subtree**, not the entire app.

```tsx
// context/UserContext.tsx
"use client";
import { createContext, useContext } from "react";

const UserContext = createContext(null);

export const UserProvider = ({ value, children }) => (
  <UserContext.Provider value={value}>{children}</UserContext.Provider>
);

export const useUser = () => useContext(UserContext);
```

```tsx
// layout.tsx
<UserProvider value={user}>
  {children}
</UserProvider>
```

Use sparingly. Context re-renders everything below it.

---

## 2. **Global State (recommended for most apps)**
Best option if the state is **cross-cutting**.

### Zustand (most common in Next.js)
- No providers
- Minimal re-renders
- Works perfectly with App Router

```ts
// store/useUserStore.ts
import { create } from "zustand";

export const useUserStore = create(set => ({
  user: null,
  setUser: user => set({ user }),
}));
```

```tsx
const user = useUserStore(s => s.user);
```

This is the **default choice** for avoiding prop drilling.

---

## 3. **Server Components + Fetch Once**
If the data is **read-only**, don’t pass it at all.

```tsx
// layout.tsx (Server Component)
const user = await getUser();

return (
  <>
    <Header user={user} />
    {children}
  </>
);
```

Even better: fetch again in child Server Components—**Next caches it**. No drilling needed.

---

## 4. **Component Composition (often overlooked)**
Pass **components**, not data.

```tsx
<Layout
  header={<Header />}
  footer={<Footer />}
/>
```

This eliminates props entirely.

---

## What NOT to do
- ❌ Deep prop chains
- ❌ Massive Context providers
- ❌ Lifting state to `layout.tsx` “just in case”

---

## Practical Rule
- **UI-only, local** → Context  
- **Shared, interactive** → Zustand  
- **Read-only, server data** → Server Components  
- **Layout structure** → Composition  

If you want, I can recommend an **exact architecture** based on your app size and data flow.

---

## User

zustand alternatives

---

## Assistant

Mr. White,

Here are **credible Zustand alternatives**, ordered by **practical value in modern Next.js (App Router)**. Facts, no fluff.

---

## Top Tier (Zustand-level or better for specific cases)

### **Jotai**
**Atomic state model (Recoil done right)**  
- Fine-grained reactivity  
- Excellent for derived/computed state  
- Minimal re-renders  

**Downside:** Mental overhead for large apps

**Use when:** You want **precise updates** and complex derived state.

---

### **Valtio**
**Proxy-based, mutation-first**
- Extremely simple mental model
- Reads like plain JS
- Great DX for small–medium apps

**Downside:** Less explicit → easier to create hidden coupling

**Use when:** You want **simplicity > explicitness**

---

### **Redux Toolkit**
**The enterprise standard**
- Predictable
- Best devtools
- Mature ecosystem

**Downside:** Boilerplate, even with RTK

**Use when:**  
- Very large teams  
- Auditing/debugging is critical  
- Long-lived enterprise apps  

---

## Mid Tier (situational)

### **Recoil**
- Facebook-backed
- Atomic model

**Reality:** Still unstable long-term, weak SSR story  
**Verdict:** Not recommended for new Next.js apps

---

### **MobX**
- Reactive, automatic tracking
- Fast

**Downside:** Implicit magic, harder debugging  
**Verdict:** Powerful but risky at scale

---

## Server-State (NOT Zustand replacements)

These solve **data fetching**, not UI state:

- **TanStack Query**
- **SWR**

Use them **with** Zustand/Jotai, not instead of.

---

## Quick Decision Table

| Need | Pick |
|----|----|
| Default choice | **Zustand** |
| Fine-grained reactivity | **Jotai** |
| Minimal mental overhead | **Valtio** |
| Enterprise / compliance | **Redux Toolkit** |
| Server data | **TanStack Query** |

---

### Bottom line
If you’re replacing Zustand:
- **Jotai** is the only real peer  
- **Redux Toolkit** only if you *must*  
- Everything else is niche or legacy  

If you want, I can recommend **the best combo** (e.g., Zustand + TanStack Query) for your exact app constraints.

---

## User

whats the ebst opiton fo rus?

---

## Assistant

Mr. White,

Assuming **modern Next.js (App Router)** and a **startup-scale product**, the **best option** is:

## **Zustand + TanStack Query**

### Why this is the correct choice
**Clear separation of concerns**:
- **Zustand** → client/UI state (toggles, modals, wizards, optimistic UI)
- **TanStack Query** → server state (API data, caching, retries, invalidation)

This mirrors how React *actually* behaves and scales cleanly.

---

## Why not the others (facts)
- **Redux Toolkit** → too heavy unless you have compliance / audit needs  
- **Jotai** → great, but higher cognitive load as the app grows  
- **Valtio** → easy early, risky later due to implicit coupling  
- **Context-only** → performance and maintainability issues at scale  

---

## Architecture rule of thumb
- **If it comes from the server** → TanStack Query  
- **If it’s UI or cross-component interaction** → Zustand  
- **If it’s read-only** → Server Components (no state at all)

---

## Final call
For speed, correctness, and long-term sanity:

**Zustand + TanStack Query is the optimal default.**

If you want, I can sketch a **folder structure + patterns** that keep this clean as you scale.
