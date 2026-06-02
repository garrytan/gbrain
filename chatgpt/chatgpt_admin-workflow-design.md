---
title: "Admin workflow design"
type: essay
created: 2025-08-31
updated: 2025-08-31
source: chatgpt-export
conversation_id: 68b49c6a-64a4-832f-a4ef-6bcf5f2501f9
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Admin workflow design

> Conversation ID: 68b49c6a-64a4-832f-a4ef-6bcf5f2501f9
> Created: 2025-08-31T19:03:06Z
> Updated: 2025-08-31T19:24:54Z
> Messages: 8

---

## User

So based on what you know about Jovi and how we work, I'd like, what I'd like to do is build some kind of workflow where basically someone with admin privileges would have the ability to say log in to their, I actually would like your suggestions on what the best way to do this is. I don't even know if it's something that should be done. I guess initial thought is this could either be a CLI script, this could be a Slack integration where you just send a message in Slack, or this could be something that we just build into the dashboard where when you log in as an admin, there's a special admin tab, and this could be one of the tools that appears there among other internal tools and stuff. But none of this is really terribly difficult to implement with AI. I mean building a graphic user interface literally takes seconds with AI, so I don't know that that's even necessarily, it matters. It would just be what would be, what would be the best way to do this. I don't know. Anyway, basically what it is, is we want to build an interface where, so I guess with the way that we're, basically we would want to build an interface where, so we have clear separation between creator profiles and end-user profiles. And so what I'm thinking is basically I would love to have a thing where I can go and say, okay I'm gonna onboard, you know, oh hey we're talking to David Guetta, and David Guetta, you know, we want to onboard David Guetta to Jovi. Before we go to reach out to David Guetta's people, one of our employees would go use this tool and basically just type in David Guetta's, the URL of David Guetta's Spotify account, and and and it would go and hit enter, and then our system would then go and create a profile for David Guetta by basically going out and scraping that Spotify profile, downloading the artist image into, into our system, or like into the Subversal Blob Storage the same way it would be stored if they had signed up directly and uploaded the photo themselves. It would pull their name and it would set the name on the profile. It would create a username, which in the case of Spotify artists would just be their name, so slash YouTube slash David Guetta slash Spice Girls, and then it would pull in their, it would add the Spotify link to the profile, and then, you know, if we can, we would get their, their social URLs from the About page on Spotify, and all that. And then, you know, ideally, this would also accept other profiles, like we would be able to put in like a link tree, and then just scrape their link tree and create a profile for them, or we'd be able to put in their Instagram account, or whatever. And then in the case of like the Instagram account, instead of it, taking their name as the handle, it would take their Instagram username as the handle, and, you know, be able to put in someone who's not necessarily a music artist or whatever. So that's, that's my, that's what I'm trying to figure out is like, what's the best way to build that as an internal tool. That being said, we probably also at some point would want like a link tree importer. So that if someone does have a link tree, you know, we can just scrape their link tree, create the profile for them, or a Beacons importer, or a Hubie importer, or any of the link to buy our products. But we'd also want to be able to do, you know, and eventually, in an ideal world, you know, we'd scrape their Instagram account, and then find their website on it. Oh, their website is the link tree. Well, we know that a link tree is a link to buy our products. So then we go to the link tree, and we scrape all the data for it. And then we parse this all together, and we create a profile for them. And so then what I'd say is in our link management thing, when someone pieces in, when someone adds a link to say, like an Instagram profile, where I would love to do is say, they add the Instagram link, and they hit enter, it saves that Instagram link in the database, and it automatically adds it to their profile. But then in the background, it triggers a background process where that Instagram profile is then being scraped in the background, and we detect a link tree. And then we know it's a link tree, so we know it's a link to buy, so we know it's a profile we should scrape. That triggers a process to go and scrape that link tree. And then we scrape the link tree. And we find, oh, a Twitter and a TikTok and a Spotify and an Apple Music. And now, on that link page, this person has just entered their Instagram, and the Instagram link has added. And then as they're working on that page, and they're starting to type in like their TikTok, all of a sudden, boom, three or four more links appear below that say suggested on them. And it's like, oh, we think that, you know, you entered your Instagram, oh, we think that this might be your YouTube, we think this might be your Spotify account. And then they can just click a check or an X to confirm, yeah, that's, that's mine. And then this would just feel really magical, because it all be happening in the background. So that's, you know, that's how where we want to get to with the link with the, the actual profile management. You have a few things you have potentially on an onboarding, we asked them if they have an existing link and bio product. And they can just click Yes, I have a link to a thing, I have another. And, or they could, or whatever. Then you have the magic, behind the scenes, auto suggesting links that we could do in the link management feature. And I have an internal admin tool where we create Joby profiles for people that we're reaching out to. And then we can contact creators and just be like, hey, click this link. And you can claim the profile that we already made for you. And then it becomes very simple for them to onboard. Basically, what I want is to think about our stack, neon database, upstash with Redis, Drizzle, Next.js, Clark auth, Tailwind 4, GitHub actions for CI, various AI tools for coding. And basically what I want to do is just keeping all of this in mind, I want to build this... I want to know what's the best way to build all of this in a way that we're not... it's going to be able to scale and it's not going to affect user performance and we're not recreating work, right? So if we have the internal tool for us to build profiles on the creator's behalf, we don't want to be building a bunch of code. The link tree scraping process should not be duplicated in three different places for this to happen. And so I want to figure out how to do this and I know I've done a lot of stuff like this in the past with Laravel and queues and stuff and multiple queues and managing queue concurrency and stuff to keep things in the background and update and stuff. But that's not the stack we're using. We're using Next.js and we're using all this other stuff. So help me figure this out. What would be the best way to do this? And then what would be the Y Combinator approach to implementing it all?

---

## Assistant

Mr. White — here’s a clean, YC-style plan to ship this fast, keep it DRY, and make it scale.

# 1) Product shape (ship the smallest useful thing)
- **V1 scope (2 providers):** Spotify Artist URL → create pre-built profile; Linktree URL → import links.  
  Skip Instagram/TikTok scraping in V1 (ToS + anti-bot headaches). Add later behind tokens or a third-party actor.
- **Single workflow, many entry points:** one **Profile Intake API** that everything calls. Wire 3 UIs to it when convenient:
  1) **Admin tab** in the dashboard (primary)  
  2) **Slack slash-command** (calls the same API)  
  3) **CLI script** (calls the same API)  
  The logic lives in one place; UIs are just thin front-ends.
- **Claim flow:** pre-create profile → send **claim link** (magic token via Clerk) → creator verifies ownership and takes over.

# 2) Architecture (monorepo, shared libs, one pipeline)
```
/apps/web                # Next.js app (routes, Admin UI)
/apps/worker             # Long-running worker (Playwright jobs, heavy fetch)
// If you want, the worker can be a Next.js route handler + QStash; 
// but Playwright usually wants a long-lived runner (Fly/Railway/Docker).
/packages/db             # Drizzle schema + migrations (Neon)
/packages/ingestors      # All provider modules (spotify, linktree, …)
/packages/events         # Typed events & payloads
/packages/utils          # Idempotency, rate limits, URL parser, etc.
```

**Data stores**
- **Neon (Postgres)**: source of truth.  
- **Upstash Redis**: idempotency keys, rate limiting, short-lived job state, fan-out.  
- **Cloudinary (or Vercel Blob)**: artist images & thumbnails (pick one and standardize).

**Queues/cron**
- **Upstash QStash** (HTTP queues) to trigger workers reliably from serverless routes.
- **Vercel Cron** (for retries/cleanup) or a small cron inside the worker container.

# 3) Unified “Profile Intake” pipeline (the only code path)
**Interface**
```ts
// packages/ingestors/types.ts
export type IntakeSource = { url: string; submittedByUserId?: string; creatorId?: string };
export type IntakeResult = {
  normalized: {
    displayName?: string;
    handle?: string;              // e.g., "david-guetta" or instagram username
    avatar?: { url: string; hash: string };
    socials?: Array<{ kind: 'spotify'|'youtube'|'instagram'|'x'|'tiktok'|'linktree'|'website', url: string, confidence: number }>;
    links?: Array<{ title?: string; url: string, kind?: string }>;
  };
  raw: unknown;                    // store for provenance/debug
  provider: 'spotify'|'linktree'|...;
};
```

**Provider contract**
```ts
export interface Provider {
  canHandle(url: URL): boolean;               // domain + path regex
  fetch(url: URL): Promise<IntakeResult>;     // does the work, returns normalized + raw
}
```

**Pipeline**
1) **Detect provider** (regex by domain/path).  
2) **Idempotency**: SHA256(url) in Redis; if in progress/done, short-circuit.  
3) **Invoke provider** (Spotify or Linktree).  
4) **Normalize** to internal schema.  
5) **Write** to Postgres in a transactional upsert:
   - `creators` (or `profiles`)
   - `social_accounts` (status=`verified`|`suggested`, `confidence`)
   - `links` (for imported external links)
   - `assets` (avatar stored in Cloudinary, keep original URL + checksum)
   - `intake_jobs` + `intake_events` (audit trail)
6) **Emit events** (Redis pub/sub or outbox table):  
   - `profile.intake.completed`  
   - `profile.suggestions.ready` (for the “Suggested” links UX)

**Re-use:**  
- Admin Intake, “Paste Instagram” background suggest, Linktree importer, Slack/CLI — they **all** call `/api/intake` which simply **enqueues** a job (QStash) to the worker that runs the **same** pipeline. Zero duplication.

# 4) Providers (V1: Spotify + Linktree)
**Spotify (preferred: official API)**
- Parse artist ID from URL. Use **Client Credentials** flow.  
- Pull: name, images, external URLs (sometimes has socials via `external_urls` only partial).  
- Avatar: pick the largest, store to Cloudinary, keep checksum.  
- Handle: slugify display name (`/david-guetta`, dedupe with suffixes if taken).  
- Socials: seed `spotify` link with **verified** status, confidence=1.0.

**Linktree**
- GET HTML → parse embedded `window.__STATE__` (or public JSON) for links.  
- Map to known kinds (YouTube/Spotify/Apple/TikTok/X/Website).  
- For each, create `social_accounts` as **suggested** with confidence (e.g., 0.9 if exact match, 0.7 if fuzzy).  
- Do not fetch avatars here.

**Later (V2+)**
- **Instagram/TikTok/YouTube**: add via official APIs or via a Playwright actor inside `/apps/worker` (respect robots/ToS; throttle via Redis tokens).  
- **Beacons/Koji/Hubie**: same technique as Linktree.  
- **Website autodiscovery**: parse `rel="me"`, JSON-LD, OpenGraph to find socials.

# 5) Background “magic suggestions” (when user pastes one link)
- User saves **one** link (e.g., Instagram) → immediately persist and show it.  
- **Async trigger**: `link.saved` → enqueue `/api/intake` on that URL.  
- If Instagram page reveals a Linktree/Beacons site (V2), enqueue an **intake cascade** for that URL, which then yields Spotify/TikTok/etc as **suggested** entries.  
- UI shows “Suggested” cards with **Accept / Dismiss** → flips `social_accounts.status` to `verified` or `rejected`.  
- All of this reuses the *same* intake pipeline + DB tables.

# 6) Data model (Drizzle, minimal & future-proof)
- **creators**: id, handle (unique), display_name, avatar_asset_id, status (`draft|unclaimed|active`), created_by, claimed_user_id, claimed_at
- **social_accounts**: id, creator_id, kind, url (unique per creator+kind), status (`verified|suggested|rejected`), confidence, source (`intake|user|admin`), last_checked_at
- **links**: id, creator_id, title, url, kind (`music|video|social|store|other`), source, rank
- **assets**: id, kind (`avatar|banner`), storage (`cloudinary|blob`), url, checksum, width, height
- **intake_jobs**: id, submitted_by, creator_id (nullable), url, provider, status (`queued|running|succeeded|failed`), started_at, finished_at
- **intake_events** (append-only): job_id, type, payload(json), ts
- **claim_tokens**: id, creator_id, token (hashed), expires_at, redeemed_by, redeemed_at

# 7) Security, perf, and reliability
- **Scopes & auth:** Admin routes gated by Clerk role (`role=admin`).  
- **Idempotency:** Redis SET with TTL per URL; also unique constraints (creator+kind+url).  
- **Rate limits:** token bucket in Redis per provider/domain.  
- **Retries:** QStash DLQ → worker reads and retries with backoff.  
- **Observability:** store raw provider payloads (S3/Blob) + event logs; add a simple `/admin/jobs` view.  
- **Legal/ToS:** Prefer official APIs; if you must scrape, use your worker with polite headers, crawl-delay, and opt-outs; never store PII you don’t need.

# 8) Admin UX (tiny but powerful)
- **Admin → “Create profile”**: paste URL(s), optional: “force handle”, “attach to existing creator”.  
- Show a **live job tile** (status, logs, duration, links added).  
- **One-click claim link**: generates `claim_token` → copy/share link.  
- **Suggested links** panel: bulk Accept/Dismiss.

# 9) Background worker choices
- If you **don’t** need headless browsers now: keep everything on Vercel functions + QStash.  
- If you **do** (Instagram etc.): run `/apps/worker` on **Fly.io/Railway** with Playwright.  
  - The web app **enqueues** to QStash; worker **subscribes** to QStash webhooks.  
  - Keep provider code in `/packages/ingestors` so it’s shared.

# 10) Minimal endpoints (copy-paste sketch)
```ts
// apps/web/src/app/api/intake/route.ts
import { enqueue } from '@/lib/qstash'; // thin wrapper
import { z } from 'zod';

const Body = z.object({ urls: z.array(z.string().url()), creatorId: z.string().optional() });

export async function POST(req: Request) {
  // check Clerk admin
  const body = Body.parse(await req.json());
  const jobIds = await enqueue('intake', body.urls.map(url => ({ url, creatorId: body.creatorId })));
  return Response.json({ jobIds });
}
```

```ts
// apps/worker/src/handlers/intake.ts
import { providers } from '@jovi/ingestors';
import { db, upsertCreatorFromIntake } from '@jovi/db';
import { withIdempotency } from '@jovi/utils/redis';

export async function handleIntake(payload:{url:string, creatorId?:string}) {
  await withIdempotency(payload.url, async () => {
    const url = new URL(payload.url);
    const provider = providers.find(p => p.canHandle(url));
    if (!provider) throw new Error('No provider');
    const result = await provider.fetch(url);
    await db.transaction(tx => upsertCreatorFromIntake(tx, result, payload.creatorId));
    // publish profile.intake.completed
  });
}
```

# 11) Claim flow (simple & robust)
- Generate `claim_token` valid for 7 days.  
- Email/DM the link: `https://jovie.app/claim/:token`  
- Page requires Clerk sign-in → verifies token → sets `claimed_user_id`, flips `status` to `active`.  
- Optional verifications: ask for a temporary link in bio, or OAuth attach of one verified social.

# 12) YC approach & sequencing
1) **Week 1**: Only **Admin → Spotify Artist URL** → prebuild profile (name, avatar, Spotify link). Ship.  
2) **Week 2**: Add **Linktree importer** + “Suggested links” UI. Ship.  
3) **Week 3**: Background suggestor when a user saves any link → cascade to Linktree if found. Ship.  
4) **Later**: Add Instagram/TikTok/YouTube via **official APIs** or Playwright actor; add Beacons/Koji/Hubie.

# 13) Guardrails to avoid “recreating work”
- One **intake pipeline** (`/packages/ingestors`) used by **all** triggers.  
- One **API** (`/api/intake`) that everything hits (Admin/Slack/CLI/app).  
- One **DB writer** (`upsertCreatorFromIntake`) that owns all upsert rules.  
- Suggestions are **data**, not UI logic (`social_accounts.status = 'suggested'`).  
- Provider mapping in a single `providers/index.ts`.

If you want, I can spit out:
- Drizzle table definitions,  
- a Spotify provider module using Client Credentials,  
- the Linktree parser,  
- and the minimal Admin page (form + job list).

---

## User

Okay, I like the plan above. Can you just briefly, in relatively clear and concise terms, explain in plain language what would be implemented today, what would be implemented tomorrow, etc.?

---

## Assistant

Mr. White — here’s the crisp rollout.

# Today (ship by EOD)
- Create **/packages** libs: `db` (Drizzle schema), `ingestors` (provider interface), `events`, `utils`.
- Stand up **/api/intake** (Next.js route) that **enqueues** jobs to QStash.
- Add **/apps/worker** with a single handler `handleIntake`.
- Implement **Spotify provider (v1)** using Client Credentials: name, images, profile URL → normalized payload.
- Implement **DB upserts**: `creators`, `social_accounts`, `assets`, `intake_jobs`, `intake_events`.
- Build a tiny **Admin → “Create profile”** page: paste Spotify URL(s) → shows job status.
- Add **idempotency + basic rate limits** via Upstash Redis.
- “Happy path” claim link generation (token stored, no email template yet).

# Tomorrow
- Implement **Linktree provider (v1)** (HTML/JSON parse → map links to known kinds).
- Write **suggestion flow**: create `social_accounts` with `status='suggested'`, `confidence`.
- Admin UI: **Suggested links** drawer with **Accept/Dismiss** (flip status).
- Add **observability**: job/event log panel; raw payload saved to Blob for debug.
- Harden: retries/backoff, DLQ path, unique constraints.

# Next 2–3 days
- **Background magic**: when user saves any link → fire `link.saved` → enqueue intake; cascade if Linktree/Beacons detected.
- **Claim flow polish**: claim page w/ Clerk sign-in; mark `claimed_user_id`, `status='active'`.
- **Handles**: slugify + dedupe strategy; conflict resolution UI on Admin create.
- **Avatar pipeline**: standardize to Cloudinary (checksum, sizes).

# Week 2
- **Slack slash-command** and **simple CLI**—both call `/api/intake` (no new logic).
- **Batch intake** (CSV or paste multiple URLs).
- **Cron**: recheck suggested accounts weekly; auto-expire stale suggestions.
- **Permissions**: Clerk roles for admin routes + audit trail.

# Week 3
- **Importers**: add Beacons/Koji/Hubie (same Linktree pattern).
- **Onboarding assist**: in Link Management, show live “Suggested” cards as jobs complete.
- **Quality**: confidence scoring tweaks, fuzzy matching, duplicate-URL collapse.

# Later (when needed)
- **Headless providers** (Instagram/TikTok/YouTube) in `/apps/worker` with Playwright on Fly/Railway.
- **Website autodiscovery** (JSON-LD, rel=me, OG).
- **Email/SMS claim outreach**; partner CRM hooks.

**Definition of done for Today/Tomorrow:**  
- Paste Spotify/Linktree in Admin → job runs → profile created/updated → avatar stored → Spotify verified + other links suggested → Accept/Dismiss works → claim link generated.

---

## User

Okay, I like this plan, my only question would be... One would be, why Cloudinary? Your previous recommendations were to use Versal image and Versal blob storage for avatar images. Do we think that Cloudinary would benefit us to use? I mean, I guess I would probably want to do transforms where people... The only transforms I'd want to do initially would be, in terms of the actual product, for letting people upload their own avatars and stuff. The only transforms I'm thinking about would be the ability for users to auto-crop, face-aware cropping, I guess would be a nice one to have. And then face-aware cropping, and then also conforming the avatars to the same size and format, so that they're optimized for delivery. And that would really be the only transform that I'd want to do initially. And I probably would lean on Yeah, and then we would just want them optimized. And I don't know if this is necessary or not for all avatar images, but if they need to be served in different sizes. And that's something that we think needs to be created and saved in storage. That would be the only other thing. And then it'd be served using NextImage or VirtualImage or whatever. So, is there a thing we should go ahead and use Cloudinary for? Or should we use Versal for now? Keeping in mind, we want to keep cost down for the MVP, but I know that Cloudinary has a pretty generous free plan. And then the second thing would be, one incentive eventually would be, when I start sending claim links out, I'd love to tie that into a referral program where anybody creator and anyone who signs up with a paid profile, we give them 50% of the revenue for up to two years or something crazy. But I'm just thinking about that for the general planning.

---

## Assistant

Good questions, Mr. White. Let’s break it down.

---

## 1. Cloudinary vs. Vercel Blob/Image

**Vercel Blob + Next/Image**
- Pros: Zero setup, baked into your stack, cheap/free for MVP, simple upload → serve → done.
- Cons: No transforms beyond what Next/Image does (basic resize/compress). No face-aware or smart-cropping. If you want normalized avatars, you’d have to preprocess on upload (e.g. run a sharp.js function in a serverless route before saving).

**Cloudinary**
- Pros: Built for media. Free plan is generous.  
  - **Face-aware cropping** out of the box.  
  - **Auto-format / auto-quality** (WebP/AVIF when supported).  
  - **Resize/variants on the fly** via URL params (no need to pre-generate).  
- Cons: More moving parts, another third-party service, pricing once you scale.  

**YC-style call:**  
- For MVP, you can absolutely ship with **Vercel Blob + Next/Image** (fast, cheap, no extra accounts).  
- If you know you want **face-aware cropping + future-proof media handling**, **Cloudinary is worth it now**—especially since it takes almost no more time to wire up and saves you having to migrate later.  
- Since your only transforms are “resize to avatar square” and “maybe face-aware crop,” the calculus is:  
  - If you’re okay with **square center-crop only**, stick to Vercel.  
  - If you want **consistent, professional auto-cropping of human avatars**, go Cloudinary from day one.  

---

## 2. Referral program tie-in

- **Claim link flow** can easily emit an event: `profile.claimed`.  
- When someone signs up and pays, you check: was this profile **pre-created by an admin referral**? If so, attribute it to the referring admin/creator.  
- A **referral table** (`referrals: id, referrer_user_id, referred_creator_id, revenue_share_pct, expires_at`) lets you track the 50% cut for 2 years.  
- This doesn’t need to be part of MVP. Just make sure **claim_tokens** store a `referrer_user_id` so you can backfill later.  

---

## Recommendation (short version)

- **MVP:** If you want fastest ship + lowest cost → use **Vercel Blob + Next/Image**. Accept basic crops only.  
- **If “face-aware cropping” matters to the sexy, polished vibe of Jovi → just use Cloudinary now.** It’s free-tier friendly, will make avatars look cleaner, and saves you a migration.  
- **Referral program:** don’t implement now. Just **store referral metadata** on claim_tokens so you can layer payouts later without redoing the flow.

---

Would you like me to give you the **exact schema additions + upload pipeline code** for *both* options (Vercel-first vs Cloudinary-first), so you can make the call with no extra work later?

---

## User

Estimate difference in overhead for using Cloudinary Verse using Versal.

---

## Assistant

Mr. White — quick deltas (Cloudinary vs Vercel Blob + Next/Image) for **overhead** only.

# Setup & DX
- **Accounts/keys:**  
  - Vercel: none (already have).  
  - Cloudinary: +1 account, 2–3 env vars. **(+10–20 min)**
- **SDKs/deps:**  
  - Vercel: 0 new deps.  
  - Cloudinary: `cloudinary` SDK (or pure URL building util). **(+1 dep)**
- **Code surface (MVP avatars):**  
  - Vercel: 40–60 LOC (upload route + Blob put + use `<Image>`).  
  - Cloudinary: 60–90 LOC (signed upload or server-side upload, URL transformations, asset metadata). **(+20–30 LOC)**

# Transform logic
- **Center/square crop only:**  
  - Vercel: do once with `sharp` in an API route, store result. **(+1 API, +~15–25 LOC)**  
  - Cloudinary: URL param (`c_fill,w,h,ar=1:1`). **(0 extra LOC beyond URL builder)**
- **Face-aware crop:**  
  - Vercel: build/host your own face detection (OpenCV/ML) or a 3rd-party lambda. **(days + ongoing maintenance)**  
  - Cloudinary: `g_face` (face gravity) in URL. **(negligible)**

# Ops & performance
- **Caching/CDN:**  
  - Vercel: built-in on `<Image>`; variants you pre-generate.  
  - Cloudinary: variants generated on-the-fly, globally cached. **(less image-variant bookkeeping)**
- **Build/runtime weight:**  
  - Vercel: lightest (no extra SDK).  
  - Cloudinary: tiny added bundle only if you client-side upload; server-side keeps client bundle clean. **(minimal)**
- **Observability/asset management:**  
  - Vercel: basic; you manage filenames/variants.  
  - Cloudinary: dashboard, usage, eager transforms, versioning. **(lower ops overhead)**

# Cost & risk (qualitative, MVP scale)
- **Vercel:** cheapest path now; but **hidden cost** if you later need face-aware → custom service or migration.  
- **Cloudinary:** free tier usually ample; **explicit vendor** but avoids a future migration for cropping/variants.

# Migration burden (later switch)
- **Vercel → Cloudinary later:** rewrite upload pipeline + backfill/migrate existing assets or implement dual-read. **(1–2 days + one-off script)**
- **Cloudinary → Vercel later:** drop transforms, pre-gen sizes, re-upload. **(similar 1–2 days)**

# Time-to-ship (realistic)
- **Vercel route (no face-aware):** ~1–2 hrs to production.  
- **Cloudinary with face-aware & standard sizes:** ~2–4 hrs (keys, upload, URL transforms, test).  
- **DIY face-aware on Vercel:** multiple days + maintenance.  

# Recommendation (overhead lens)
- If you **don’t need face-aware** for MVP: **Vercel Blob + Next/Image** (least overhead today).  
- If you want avatars to **always look pro** (creator-first brand) and avoid future rework: **Cloudinary now** (small upfront overhead; big downstream savings).

Want me to drop in the exact upload handlers and a tiny URL helper for both paths so you can pick one and go?
