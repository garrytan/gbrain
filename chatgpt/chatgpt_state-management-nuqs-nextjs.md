---
conversation_id: 69668155-1540-832a-8eda-058bff7b2fb4
created: 2026-01-13
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: State Management Nuqs Next.js
type: guide
updated: 2026-01-13
---

# State Management Nuqs Next.js

> Conversation ID: 69668155-1540-832a-8eda-058bff7b2fb4
> Created: 2026-01-13T17:31:10Z
> Updated: 2026-01-13T17:46:21Z
> Messages: 4

---

## User

State management next.js nuqs 

---

## Assistant

Mr. White — **nuqs** is a “`useState`, but stored in the URL query string” library, with typed parsers and **server/client type-safety**. citeturn2view0

## When it’s a good “state manager” in Next.js
Use it for **navigation/shareable state**: filters, sorting, pagination, tabs, selected IDs, “open modal=…”, etc. It keeps state across refresh + enables copy/paste URLs. citeturn2view0  
Don’t use it for large/secret data (URLs are public + length-limited).

## Setup (Next.js App Router)
1) Install the right major:
- `nuqs@^2` targets **Next.js >= 14.2.0**. citeturn5search1

2) Wrap your app with the adapter in `app/layout.tsx`: citeturn6view0
```tsx
// src/app/layout.tsx
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import type { ReactNode } from 'react'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  )
}
```

## Client-side usage (typed query state)
```tsx
'use client'

import { useQueryState, useQueryStates, parseAsInteger, parseAsString } from 'nuqs'

export function Filters() {
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''))
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1))

  // or manage multiple at once:
  const [{ q2, page2 }, setParams] = useQueryStates({
    q2: parseAsString.withDefault(''),
    page2: parseAsInteger.withDefault(1),
  })

  return (
    <>
      <input value={q} onChange={(e) => setQ(e.target.value)} />
      <button onClick={() => setPage((p) => p + 1)}>Next page ({page})</button>
    </>
  )
}
```
Built-in parsers like `parseAsInteger` are provided. citeturn0search2turn2view0

## Triggering Server Component re-renders (important)
By default nuqs does **shallow, client-only updates** (no server call). citeturn4view0turn2view0  
If you want Next.js to re-render Server Components based on the updated query string, opt in:
```tsx
const [q, setQ] = useQueryState('q', { shallow: false })
```
…and you can throttle/debounce URL+server updates to avoid spamming requests. citeturn4view0

## Server-side parsing (App Router)
Define parsers once, then parse safely on the server with a loader: citeturn1view0
```tsx
// src/app/search-params.ts
import { parseAsInteger, parseAsString } from 'nuqs'
import { createLoader } from 'nuqs/server'

export const productSearchParams = {
  q: parseAsString.withDefault(''),
  page: parseAsInteger.withDefault(1),
}

export const loadProductSearchParams = createLoader(productSearchParams)
```

```tsx
// src/app/products/page.tsx (Server Component)
import type { SearchParams } from 'nuqs/server'
import { loadProductSearchParams } from '../search-params'

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { q, page } = await loadProductSearchParams(searchParams)
  // fetch/render using q + page
  return null
}
```
(There’s also `createSearchParamsCache` for deep server components.) citeturn1view0

If you tell me whether you’re on **App Router or Pages Router** and what kind of state (filters/pagination/modals), I’ll show the cleanest pattern for that exact case.

---

## User

Tanstack 

---

## Assistant

Mr. White — **TanStack** is a family of React libs. For “state management” in Next.js, the one people usually mean is **TanStack Query** (server/cache state). citeturn0search14

### What to use for what (Next.js)
- **URL / navigation state (filters, sort, page, tab):** `nuqs` (great fit) or a router with typed search params (TanStack Router has first-class search params). citeturn0search12  
- **Server state (fetching, caching, dedupe, background refetch):** **TanStack Query**. citeturn0search14  
- **Global client-only state (UI that shouldn’t be in the URL):** consider a small store (TanStack Store exists, but Query is the mainstream pick for “state” in the TanStack ecosystem). citeturn0search22  

### TanStack Query + Next.js App Router (the common pattern)
- Query hooks run in **Client Components**, and for App Router/RSC you typically **prefetch on the server + hydrate on the client** using TanStack’s SSR/Advanced SSR guidance. citeturn0search0turn0search1  

Minimal provider (client):
```tsx
'use client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient())
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
```

If you tell me which you meant—**Query** (data fetching), **Router** (routing/search params), or **Store** (client state)—I’ll give you the exact Next.js setup + recommended architecture with `nuqs`.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
