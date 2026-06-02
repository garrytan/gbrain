---
title: "Statsig Integration Options"
type: note
created: 2026-02-07
updated: 2026-02-07
source: chatgpt-export
conversation_id: 69869fef-09f4-832b-8be1-b3b8281aa802
message_count: 2
tags: [chatgpt, import]
---
# Statsig Integration Options

> Conversation ID: 69869fef-09f4-832b-8be1-b3b8281aa802
> Created: 2026-02-07T02:14:37Z
> Updated: 2026-02-07T02:16:14Z
> Messages: 2

---

## User

im trying to keep stasig from evfecting perfomance on nextjs One key question (so I implement the right thing)
Do you want server-side Statsig to be:

Option A: SSR-only gating (flags evaluated on server, passed as props; client never re-evaluates), or
Option B: server evaluation + client hydration via a cookie/serialized bootstrap (still “server SDK only”, but lets client read a precomputed value without another network call)?

---

## Assistant

Mr. White — **Option B** is the correct choice if your goal is **zero client perf impact** *and* clean SSR/CSR consistency.

Here’s the factual breakdown.

---

## Option A: SSR-only gating
**What it is**
- Flags evaluated on the server
- Values passed as props
- Client never re-evaluates or knows about Statsig

**Pros**
- Absolute minimum client JS
- No hydration payload
- No client-side Statsig logic at all

**Cons (real ones)**
- **Hydration mismatch risk** if flags affect markup and client logic diverges later
- Flags are **not available after navigation** unless you re-fetch
- Breaks for:
  - client-side routing
  - dynamic re-renders
  - components that need flags post-hydration

**When this is correct**
- Flags only gate **entire pages**
- No client transitions
- No flag-dependent client behavior
- Think: marketing pages, auth walls, coarse routing

---

## Option B: Server eval + serialized bootstrap (recommended)
**What it is**
- Statsig evaluated **only on the server**
- Results serialized (cookie or inline JSON)
- Client reads **precomputed values**
- No client SDK, no network call

**Pros**
- **Zero runtime perf hit** on the client
- **Hydration-safe** (server === client)
- Flags usable during:
  - initial render
  - client navigation
  - re-renders
- Preserves React mental model

**Cons**
- Slightly larger HTML payload (usually negligible)
- You must manage cache/user identity correctly

**Key point**
This is still **server-SDK-only**. The client is dumb — it just reads values.

---

## Clear recommendation
If performance is the priority **and** this is a real app (not static pages):

👉 **Option B is the correct architecture**

This is also how Statsig internally recommends avoiding:
- client SDK cost
- duplicate evaluations
- hydration bugs

---

## Implementation guidance (high-level)
- Evaluate flags in:
  - `middleware` **or**
  - server components / `getServerSideProps`
- Serialize:
  - minimal flag map only (booleans/variants)
  - no SDK state
- Read once on the client from:
  - `window.__FLAGS__` or
  - signed cookie
- Never re-evaluate client-side

If you want, I can:
- sanity-check your exact Next.js setup (App Router vs Pages)
- give a minimal reference implementation
- show how to avoid cache poisoning with cookies

Just say the word.


## See Also
- [[chatgpt/chatgpt_renpho-scale-integration-options]]
- [[chatgpt/chatgpt_100-mbps-upload-options]]
- [[chatgpt/chatgpt_ai-command-palettes-integration]]
- [[chatgpt/chatgpt_airpods-pro-3-options]]
- [[chatgpt/chatgpt_airpods-replacement-options]]
