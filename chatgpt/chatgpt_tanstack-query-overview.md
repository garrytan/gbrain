---
title: "TanStack Query Overview"
type: note
created: 2026-01-12
updated: 2026-01-12
source: chatgpt-export
conversation_id: 696444f2-4ff0-8327-9250-cb20b4b7526c
message_count: 2
tags: [chatgpt, import, code]
---
# TanStack Query Overview

> Conversation ID: 696444f2-4ff0-8327-9250-cb20b4b7526c
> Created: 2026-01-12T00:48:51Z
> Updated: 2026-01-12T00:49:30Z
> Messages: 2

---

## User

litanstack query

---

## Assistant

**TanStack Query** (formerly *React Query*) is a JavaScript/TypeScript library for *asynchronous data fetching and server-state management* in frontend apps like React, Vue, Svelte, Solid, and Angular. It’s designed to make fetching, caching, synchronizing and updating remote data much easier and more efficient than manual fetch/​useEffect approaches. citeturn0search1turn0search2

### Core idea
- You declare *what* data you need and *how* to fetch it.
- TanStack Query handles *when* to fetch, *how* to cache it, and *when to refresh*, with minimal boilerplate. citeturn0search1

### Key concepts
**Queries**  
- Represent a request for remote data (e.g., API call).  
- Use `useQuery` (or framework-equivalent) with a *key* and *fetch function*.  
- Provides states like `isLoading`, `isError`, `data`, etc.  
- Automatically caches results, deduplicates duplicate requests, and can refetch on window focus or reconnect. citeturn0search1

**Mutations**  
- Used for *creating/updating/deleting* data on the server.  
- Use `useMutation`.  
- Often paired with *query invalidation* to refresh related cached data. citeturn0search6

**Caching & Invalidation**  
- Cached data has freshness control (`staleTime`, `cacheTime`).  
- You can explicitly *invalidate* a query so it refetches next time it’s needed. citeturn0search6

### Why use it
Compared with manual fetch + `useState`/`useEffect`, TanStack Query:  
- Avoids boilerplate for async state, error/loading handling, polling, retries.  
- Keeps cache in sync across components sharing the same query key.  
- Improves performance via smart caching and deduplication. citeturn0search1

### Example pattern (React)
```js
const { data, isLoading, error } = useQuery({
  queryKey: ['todos'],
  queryFn: () => fetch('/api/todos').then(res => res.json())
});
```
This handles fetching + caching + state flags automatically. citeturn0search2

In short: **TanStack Query abstracts server-state logic into a powerful, declarative data layer** for modern frontend apps. citeturn0search1
