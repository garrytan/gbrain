---
conversation_id: 68c3616b-a840-832e-ae7b-c2fc19369185
created: 2025-09-11
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Featured artists carousel solution
type: guide
updated: 2025-09-11
---

# Featured artists carousel solution

> Conversation ID: 68c3616b-a840-832e-ae7b-c2fc19369185
> Created: 2025-09-11T23:55:24Z
> Updated: 2025-09-11T23:56:09Z
> Messages: 2

---

## User

Our featured artists carousel pulls form the db. An dit should update based on artists in our db with a featured flag as well as an opt in flag for marketing use. But we dont need it to be current to the second. It could be delayed by as much as a week. We do however need ti to load instantly since it shows on the homepage above the fold. Whats the best method for this?

---

## Assistant

Mr. White — use **ISR + a cached server query** and pre-optimized assets. It’s instant on the client, allows up to a week of staleness, and never blocks the fold.

### TL;DR architecture
- **Server-render the carousel (RSC)** with a **cached query**; ship the HTML.  
- **ISR window:** up to **7 days** (or whatever you choose).  
- **On-demand refresh:** cron + admin button to revalidate sooner.  
- **Images:** pre-optimized on a CDN, blur placeholders baked in.  
- **Deterministic shuffle** so the order can feel “fresh” without cache misses.

### Minimal implementation (Next.js 15/16 style)

**1) Cached loader**
```ts
// lib/featured.ts
import { unstable_cache } from 'next/cache';
import { sql } from '@/db'; // your db adapter

type Artist = { id: string; name: string; slug: string; heroUrl: string; blur: string };

async function fetchFeatured(): Promise<Artist[]> {
  const rows = await sql/* sql */`
    SELECT id, name, slug, hero_url AS "heroUrl", blur_hash AS blur
    FROM artists
    WHERE featured = true AND marketing_opt_in = true
      AND hero_url IS NOT NULL
    LIMIT 24
  `;
  // deterministic weekly shuffle so order changes w/o breaking cache
  const seed = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return rows.sort((a, b) => (hash(a.id + seed) > hash(b.id + seed) ? 1 : -1));
}

export const getFeaturedArtists = unstable_cache(fetchFeatured, ['featured-artists'], {
  revalidate: 60 * 60 * 24 * 7 // 7 days
});

// tiny, fast hash
function hash(s: string){ let h=9; for (let i=0;i<s.length;i++) h=Math.imul(h^s.charCodeAt(i),9**9); return h>>>0; }
```

**2) Server component (no client fetch)**
```tsx
// app/(marketing)/page.tsx
import { getFeaturedArtists } from '@/lib/featured';
import Image from 'next/image';

export default async function Home() {
  const artists = await getFeaturedArtists(); // HTML ships with data → instant
  return (
    <section aria-label="Featured Artists" className="container">
      <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {artists.map((a, i) => (
          <li key={a.id} className="rounded-xl overflow-hidden">
            <a href={`/a/${a.slug}`} className="block">
              <Image
                src={a.heroUrl}
                alt={a.name}
                width={480}
                height={480}
                sizes="(max-width:768px) 50vw, (max-width:1200px) 33vw, 16vw"
                placeholder="blur"
                blurDataURL={a.blur}
                priority={i < 3} // make first row ultra-fast
                loading={i < 3 ? 'eager' : 'lazy'}
              />
              <div className="px-2 py-1 text-sm">{a.name}</div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

**3) Revalidation paths**
- **Cron (daily/hourly):**
  - Vercel cron → `/api/revalidate/featured`
- **Admin button:** call the same endpoint after you toggle flags in CMS.

```ts
// app/api/revalidate/featured/route.ts
import { revalidateTag } from 'next/cache';

export async function POST() {
  revalidateTag('featured-artists');
  return Response.json({ ok: true });
}
```

### Image + payload hygiene
- Store **AVIF/WebP** on your image CDN; ensure `next/image` hits it.  
- Precompute **blurDataURL** (LQIP) and **square crops** server-side so layout is stable.  
- Keep the record **lean** (id, name, slug, heroUrl, blur). No nested junk above the fold.

### Why this wins
- **Instant render:** data is in the HTML; no client fetch.  
- **Stable + cheap:** one cached server query; 7-day ISR protects DB.  
- **Timely enough:** cron/admin can refresh anytime; otherwise weekly.  
- **Deterministic variety:** weekly seed changes order without thrashing cache.

If you want global, sub-100ms reads regardless of region, you can swap `unstable_cache` for writing the computed list into **Vercel Edge Config / Upstash Redis** on your cron, then read it in the server component (still rendered server-side so the HTML includes the data). But for your “week-latency OK, instant load” requirement, **ISR + cached server query** is the simplest, fastest path.


**Topic:** [[chatgpt-clusters/jovie_music]]
