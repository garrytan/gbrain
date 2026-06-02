---
title: "No DB needed for Tixr"
type: guide
created: 2025-09-23
updated: 2025-09-23
source: chatgpt-export
conversation_id: 68d2df42-6940-8327-aec7-6a1b64d17627
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# No DB needed for Tixr

> Conversation ID: 68d2df42-6940-8327-aec7-6a1b64d17627
> Created: 2025-09-23T17:56:53Z
> Updated: 2025-09-23T18:22:03Z
> Messages: 7

---

## User

i want to pull in tier data from our halloween show to list sales of GA, VIP, and Couches. I want to display the number for each show in our operations site next.js site. The data comes from tixr. How can i do this

---

## User

Right now i dont have a db. Just vercel. do i need a db?

---

## Assistant

No, you don’t *need* a database if all you want is to display live Tixr numbers on a Next.js site.

**Quick-path (no DB)**
1. **Get a Tixr API key** – Tixr offers a REST API that exposes event inventory/sales by ticket type. Request credentials from their support/partner portal.
2. **Serverless fetch on Vercel** – Create an API route in your Next.js app (`/api/tixr-sales`).
   ```ts
   // app/api/tixr-sales/route.ts
   import { NextResponse } from 'next/server'

   export async function GET() {
     const res = await fetch(`https://api.tixr.com/v1/events/{eventId}/sales`, {
       headers: { Authorization: `Bearer ${process.env.TIXR_TOKEN}` }
     })
     const data = await res.json()
     return NextResponse.json({
       ga: data.tiers.GA.sold,
       vip: data.tiers.VIP.sold,
       couch: data.tiers.COUCH.sold
     })
   }
   ```
3. **Client display** – On your ops page, call that endpoint with `useSWR` or a simple `fetch` to show counts.  
   ```ts
   const { data } = useSWR('/api/tixr-sales', fetcher, { refreshInterval: 60000 })
   ```
   This hits Tixr every minute and shows live numbers.

**When a DB *would* help**
- Historical reporting or trend graphs.
- Caching to reduce API calls/latency.
- Combining with other internal data.

If you only need a real-time snapshot of GA / VIP / Couch sales per show, Vercel serverless + Tixr API is enough—no database required.

---

## User

I have tier studio and it lets me make webhooks...

---

## Assistant

Short answer: you can do this **without a DB** by having Tixr (Tier Studio) **push webhooks** to your Vercel API route and caching the latest counts in-process or in a lightweight config. DB only needed if you want history.

# Plan (no DB)
1. **Create a Webhook in Tier Studio** targeting `POST https://yourdomain.com/api/tixr/webhook`. (Studio advertises webhooks + APIs for real-time data. citeturn0search4)
2. **Verify & upsert counts** in memory (works on a single region, resets on cold starts) or **Vercel Edge Config** (recommended for durability & multi-region).
3. **Display per-show totals** (GA, VIP, Couch) by reading that cache on your ops page and auto-refreshing.

# Minimal Next.js (App Router)

**1) Webhook receiver (Edge runtime)**
```ts
// app/api/tixr/webhook/route.ts
import { NextRequest } from 'next/server'
import { get, set } from '@vercel/edge-config' // or replace with an in-memory Map as a quick start

export const runtime = 'edge'

type TixrWebhook = {
  id: string             // event id for idempotency
  type: string           // e.g. "order.created", "inventory.updated"
  event_id: string       // your show id
  tiers: Array<{ id: string; name: string; sold: number }>
  // ↑ shape may differ; map from your actual payload
}

const IDEMPOTENCY_KEY_PREFIX = 'tixr_evt_'

const normalize = (name: string) => {
  const n = name.toLowerCase()
  if (n.includes('couch')) return 'couch'
  if (n.includes('vip')) return 'vip'
  return 'ga'
}

export async function POST(req: NextRequest) {
  // TODO: verify signature header from Tixr if provided (HMAC/shared secret)
  const body = (await req.json()) as TixrWebhook

  // Idempotency guard (skip if we've processed this webhook id)
  const seen = await get<boolean>(IDEMPOTENCY_KEY_PREFIX + body.id)
  if (!seen) {
    const current = (await get<Record<string, any>>(`show:${body.event_id}`)) || { ga: 0, vip: 0, couch: 0 }
    const totals = { ga: 0, vip: 0, couch: 0 }

    for (const t of body.tiers ?? []) {
      const bucket = normalize(t.name)
      totals[bucket] += t.sold ?? 0
    }

    // save merged snapshot for the show
    await set(`show:${body.event_id}`, { ...current, ...totals, updatedAt: Date.now() })
    await set(IDEMPOTENCY_KEY_PREFIX + body.id, true)
  }

  // Revalidate any pages using this tag
  // await revalidateTag(`tixr:${body.event_id}`)  // if using on-demand revalidation
  return new Response('ok')
}
```

**2) Read API for the UI**
```ts
// app/api/shows/[id]/sales/route.ts
import { NextResponse } from 'next/server'
import { get } from '@vercel/edge-config'
export const runtime = 'edge'

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const data = await get<Record<string, any>>(`show:${params.id}`)
  return NextResponse.json(data ?? { ga: 0, vip: 0, couch: 0 })
}
```

**3) UI component**
```tsx
// app/ops/[id]/page.tsx
'use client'
import useSWR from 'swr'
const fetcher = (u: string) => fetch(u).then(r => r.json())

export default function OpsShow({ params }: { params: { id: string } }) {
  const { data } = useSWR(`/api/shows/${params.id}/sales`, fetcher, { refreshInterval: 30_000 })
  const d = data ?? { ga: 0, vip: 0, couch: 0 }
  return (
    <div className="grid gap-4 grid-cols-3">
      <Card label="GA" value={d.ga} />
      <Card label="VIP" value={d.vip} />
      <Card label="Couches" value={d.couch} />
    </div>
  )
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl p-6 border">
      <div className="text-sm opacity-70">{label}</div>
      <div className="text-4xl font-semibold">{value}</div>
    </div>
  )
}
```

# Notes & options
- **Tier → bucket mapping**: easiest is to standardize Tier names in Tixr (e.g., include “GA”, “VIP”, “Couch”) or add a **custom field/tag** you can parse in the webhook (e.g., `meta.bucket = 'couch'`). Studio exposes APIs & webhooks for real-time ops; confirm available fields in your payload. citeturn0search4turn0search5
- **Signature verification**: most webhook providers sign payloads; if Tixr provides a signature header, verify with HMAC before processing (their Webhooks docs describe real-time notifications). citeturn0search0
- **Cache choice**:
  - *In-memory Map*: zero setup, but resets on cold starts and doesn’t share across regions.
  - *Vercel Edge Config*: trivial setup, low-latency global reads, perfect for “latest counts” without running a DB.
  - If you later want **history/trends**, add a DB (Neon/Supabase) and append rows on each webhook.
- **Multiple shows**: you’ll receive per-event updates; store under `show:{event_id}` keys and render `ops/[event_id]`.

If you want, I’ll drop in the exact Edge Config wiring and a stricter signature-verify once you share the Tixr webhook headers format.

---

## User

These are our tier events

---

## Assistant

Got it, Mr. White.

I parsed your CSV and surfaced clean **Tixr Event IDs + times** so you can wire your Next.js endpoint(s) per show. I also saved a JSON seed you can import.

- I put an interactive table in your workspace: **“Tixr Events Parsed (IDs & Times)”** — it has:
  - `event_id` (no commas, ready for API calls)
  - `event_name`
  - `short_url`
  - `start_iso`, `end_iso` (parsed)

- JSON seed (useful for routing/show pages or preview lists):  
  [Download tixr_events_seed.json](sandbox:/mnt/data/tixr_events_seed.json)

### What to do next (no DB)
1. **Create a read API** per event:
   - `GET /api/shows/[eventId]/sales` → returns `{ ga, vip, couch }`
2. **Populate it** either by:
   - **Polling Tixr** (serverless fetch) on request, or
   - **Receiving webhooks** and caching the latest snapshot in **Vercel Edge Config** under `show:{eventId}`.
3. **UI**: your ops page reads `/api/shows/[eventId]/sales` and displays GA/VIP/Couch.

### Sample wiring (Edge Config + webhook)
- Keys you’ll set from that parsed list:
  - `show:<eventId>` → `{ ga, vip, couch, updatedAt }`
- Webhook handler maps tier names → buckets (case-insensitive contains):
  - `couch` → `couch`
  - `vip` → `vip`
  - else → `ga`

If you want, I’ll drop in the exact files (`/api/tixr/webhook`, `/api/shows/[id]/sales`, and a client component) using your event IDs from the seed.
