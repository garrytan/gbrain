---
title: "React Nuqs Library"
type: note
created: 2026-01-13
updated: 2026-01-14
source: chatgpt-export
conversation_id: 6966bd41-d198-832f-852c-5fd5493bb8cc
message_count: 2
tags: [chatgpt, import, code]
---
# React Nuqs Library

> Conversation ID: 6966bd41-d198-832f-852c-5fd5493bb8cc
> Created: 2026-01-13T21:46:42Z
> Updated: 2026-01-14T23:31:24Z
> Messages: 2

---

## User

react nuqs

---

## Assistant

**nuqs** is a lightweight React/Next.js library for **type-safe URL query-parameter state management** — basically `useState` that syncs with the browser’s URL instead of memory. citeturn0search0turn0search1

**What it does**  
• Provides React hooks (e.g., `useQueryState`) that bind component state to URL search params. citeturn0search0  
• Keeps state reflected in the URL query string automatically. citeturn0search1  
• Parses and serializes values with built-in type safety (numbers, booleans, arrays, JSON, etc.). citeturn0search1

**Why it’s useful**  
• **Shareable/bookmarkable state:** UI filters, pagination, search terms, and similar state persist across refreshes and can be shared via URL. citeturn0search1  
• **Less boilerplate:** Simplifies manual `URLSearchParams` handling and router updates. citeturn0search1  
• **Type safety:** Works well with TypeScript and ensures query params map to proper types. citeturn0search0  
• **SSR & Next.js support:** Works with server and client components and modern Next.js routers. citeturn0search1

**How it works (example)**

```jsx
import { useQueryState, parseAsInteger } from 'nuqs';

function Page() {
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));

  return (
    <>
      <button onClick={() => setPage(p => p + 1)}>Next page</button>
      <div>Current page: {page}</div>
    </>
  );
}
```

Here `page` reflects the `?page=` in the URL and updates it on change. citeturn0search1

**When to use**  
✔ Interfaces where state should be visible in URLs (filters, sorts, pagination, deep links). citeturn0search1  
✔ Apps wanting type safety and smoother URL-state sync across components/SSR. citeturn0search0

**When not to use**  
✘ For private or large/complex state (URLs have size limits). citeturn0search1  
✘ For UI state that shouldn’t change the URL (animations, ephemeral modals, etc.). citeturn0search1

In short, **nuqs** makes query-param-based state in React apps **simple, type-safe, shareable and URL-synced**. citeturn0search0


**Topic:** [[chatgpt-clusters/coding_web_dev]]
