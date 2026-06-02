
Good question. Think of it like this:

- **AI SDK** = client/library in your app.
- **Vercel AI Gateway** = infra layer in front of model providers.

They’re complementary, not alternatives.

Here’s what the **Gateway** buys you *on top of* just using the SDK directly with OpenAI/etc.

---

## What AI Gateway adds beyond the SDK

### 1. One endpoint for tons of models + no provider juggling

With the Gateway you hit **one API** and can switch between ~100 models via a model string, without managing separate keys, accounts, or SDKs. citeturn0search3turn0search4  

AI SDK already unifies the *code*, but without the Gateway you still:

- Store and rotate multiple provider keys
- Track limits/spend per provider
- Configure retries/failover per provider yourself

Gateway centralizes that.

---

### 2. Reliability: routing, retries, and failover

Gateway is explicitly about **production reliability**:

- If one provider fails or rate-limits you, Gateway can **fail over** to another. citeturn0search3  
- You can load balance across providers.
- You avoid a single-point-of-failure on “this one OpenAI key.”

If your app ever becomes “mission critical” and you can’t afford “OpenAI is having a moment” outages, this is the main win.

---

### 3. Observability & spend tracking in one place

Gateway gives you dashboards for:

- Requests by model
- Time to first token / latency
- Input/output token counts
- Spend by model/project/team citeturn0search2turn0search8  

Without Gateway, you’d need to:

- Stitch together logs from your own app + each provider
- DIY token accounting and per-feature AI cost

For you, that could be nice when you want to see:

- “How much are onboarding helpers costing vs outreach emails?”
- “Is this new model actually cheaper/faster in practice?”

---

### 4. Key management and security

Gateway can hold provider keys on its side and expose a **single key** to your app. citeturn0search3turn0search4  

That simplifies:

- Keeping keys out of some surfaces
- Rotating keys/providers without redeploying your app

Not life-or-death at your stage, but cleaner.

---

### 5. Pricing / markup

Important: per Vercel’s GA blog, Gateway is **zero-markup** when you bring your own keys and contracts – you pay provider rates, Gateway doesn’t tack on per-token margin. citeturn0search3  

So:

- Using **AI SDK alone**: you pay providers directly, no gateway.
- Using **AI Gateway + AI SDK**: you still pay provider rates; Gateway gives infra/observability/routing on top. The “cost” is mostly complexity and any Vercel plan limits, not extra token markup.

---

## When it *is* worth using Gateway for Jovi

I’d say Gateway becomes obviously useful when:

- You’re using **more than one** provider/model in production, **and**
- AI is powering core flows (onboarding suggestions, outreach, etc.), **and**
- You want:
  - Central spend tracking
  - Reliability/failover
  - Simple “try this new model” experiments

At that point, the time savings + observability probably outweigh the overhead.

---

## What I’d do *right now* in your shoes

Given your stage and traffic:

1. **Use AI SDK in your Next.js app** as the client.
2. Wrap it in your own `aiService` module (your domain-level API).
3. **Start by calling providers directly** (e.g., OpenAI) through AI SDK.
4. Design that `aiService` so the underlying client can be swapped from:
   - `provider SDK / AI SDK direct` → **Gateway endpoint**
   by changing config, not all your app code.

Then, once:

- You’re doing meaningful volume **or**
- You want multi-provider routing / dashboards / failover,

you flip to using **Vercel AI Gateway** under that same `aiService`.

So: Gateway won’t “jack up” your token costs if you use BYO keys, but it *does* add another moving piece. I’d treat it as a **Phase 2 infra upgrade**, not a blocker to shipping v1.


does Okay, we've talked about building a system for admins to just put in a link tree, or a Instagram or something, and then have it create a profile based off of that. That can then be claimed, which I could claim. The other thing I want to do is we have our Universal Links Manager that lets you type in any social link and it then auto formats it and everything to add it to your creator profile. Also, if you type in an app handle or something, or you type in Instagram, it will automatically be like Instagram.com slash Tim White, and automatically turns that into HGCPS and all that stuff. If you just do at Tim White, it's like, oh, this is an Instagram or a TikTok or whatever, and you can click it, all that kind of shit, right? What I like to do there is then also you paste in a link tree, and then it fires off a queue in the background and scrapes that link tree, and then auto-suggests adding those other handles. Help me think about how to expand on that flow idea, and then what part of it to build first, and how to go about implementing it, and how to go about doing that queue system so that it intelligently works. Maybe we start by supporting just link tree, and then we add more things, or I don't know what the best way to do this. And then for the actual scraping, should we be using AI or if you're using a lightweight puppeteer thing or some other kind of scraper, what would be the most efficient way to do it? Because I want to be able to spin these things up at scale. And then do we have to use, like in the past, I've used proxy services and APIs and stuff to do that kind of stuff at scale. Am I going to have to do that, or can we fire it through AI, or what is the modern, most efficient, and cheapest way to do that?


Got you, Mr. White — this is basically “make the Universal Links Manager a thin UX layer on top of the ingestion engine we’ve been talking about.”

I’ll break it into:

1. The ideal **user flow** inside Universal Links Manager  
2. **What to build first** (phased)  
3. **Queue design** for the background scrape  
4. **Scraping approach** (AI vs Puppeteer vs plain HTTP)  
5. **Scale / proxies / cost**

---

## 1. Expanded flow for Universal Links Manager

Think of it as: *one input, many behaviors*; everything funnels into the same backend ingestion pipeline.

### User-facing flow

Universal Links Manager input supports:

- Direct profile URLs (IG, TikTok, X, Spotify, etc.)
- Handles (`@timwhite`)
- Link-in-bio URLs (e.g. Linktree, later Beacons, Koji, etc.)

**Concrete UX for the Linktree case:**

1. User pastes a Linktree URL into the field.  
2. You immediately:
   - Normalize the URL (`https://linktr.ee/…`),
   - Store it as a link on their profile,
   - Kick off a background job: `IMPORT_LINKTREE_LINKS` with creatorId + URL.
3. UI feedback:
   - Show the Linktree link as “saved” instantly.
   - Show a small non-blocking status:  
     “Importing your other links from Linktree…” with a spinner or subtle toast.
4. When the job finishes:
   - Backend saves a bunch of *suggested links* in a `link_suggestions` table.
   - Frontend subscribes (poll or websocket) and shows a side panel:
     > “We found these links from your Linktree:  
     > [Spotify] [Instagram] [Twitter] [Website] – Add all / Add selected”
5. User clicks “Add all” or cherry-picks; suggestions turn into real links on their profile and disappear from the suggestion list (or get marked as dismissed).

**Important:** the flow is *non-blocking*. They can keep editing their profile; suggestions appear a few seconds later.

Same engine later supports:

- “Paste an Instagram profile” → we add that link *and* suggest the other links we discover from that IG bio.
- “Paste @handle” → we infer platform + construct URL and, in the background, still attempt an import if it’s a supported platform.

---

## 2. What to build first (phased)

Keep it stupid simple at the start:

### Phase 1 – Only Linktree, only links

- Extend Universal Links Manager so it can detect Linktree URLs.
- Backend:
  - Add a route like `POST /api/import/linktree` that:
    - Validates URL
    - Writes an `ingestion_job` row (`type = 'linktree_links'`)
    - Pushes a job onto a `linktree-import` queue
- Worker:
  - Fetch HTML
  - Extract `<a>` tags (href + text)
  - Classify *just* the URL type (social vs generic, and which platform) using simple regex rules.
  - Save into `link_suggestions`:
    - `creator_id`
    - `url`
    - `title`
    - `type` (spotify, instagram, twitter, generic, etc.)
- Frontend:
  - Add “suggestions” section to Universal Links Manager:
    - Poll `GET /api/link-suggestions?creatorId=…`
    - Show list with “Add” / “Dismiss”.

No recursion, no avatars, no AI. Just “paste Linktree → see suggested links”.

### Phase 2 – Multiple sources + handles

- Extend detection in Universal Links Manager:
  - If user enters `@timwhite`, show platform picker chips (IG/TikTok/X) and then build URL.
  - If user enters any supported social URL, enqueue a matching import job (IG, Spotify, etc.) in the background.
- Add more scrapers (still simple HTML/JSON based) reusing the same ingestion/pipeline shape.
- Suggestions now come also from IG, Spotify, etc., not just Linktree.

### Phase 3 – Recursion + fancier enrichment

- From each scraped page, identify other profile URLs and enqueue additional jobs with:
  - Max depth (e.g. 2 hops)
  - Per-source rate limits
- Start capturing avatars / names too (the other ingestion work we talked about).

You don’t need all that to get a ton of value from “paste Linktree → get suggestions.” Start small and then deepen.

---

## 3. Queue system: how it should work

You don’t need anything exotic to begin — just a per-source queue and a simple worker.

### Job structure

Each job might look like:

```json
{
  "type": "import_linktree_links",
  "creatorId": "123",
  "sourceUrl": "https://linktr.ee/timwhite"
}
```

Worker does:

1. Fetch page (HTTP GET).
2. Parse HTML.
3. Extract links.
4. Classify links.
5. Upsert into `link_suggestions`.

### Queues & throttling

- One queue to start: `linktree-import` (e.g. BullMQ in Node).
- Config:
  - `concurrency` (e.g. 5 jobs at a time)
  - Optional `rateLimit` (X jobs per Y ms)
- Later:
  - Split into `linktree-import`, `instagram-import`, `spotify-import` etc., each with its own concurrency and rate limits so one source’s slowness doesn’t poison the others.
- Store those limits in a config table so you can adjust from the admin panel without redeploying.

### Deduplication

Before creating suggestions:

- Remove URLs you already have as active links for that creator.
- Collapse duplicates within the same scrape.
- Optionally normalize URLs (strip tracking params, trailing slashes) before comparing.

---

## 4. Scraping: AI vs Puppeteer vs “normal” scraping

### For Linktree & most link-in-bios: don’t use AI or Puppeteer first

For what you want (anchors + hrefs), the best combo is:

- Plain HTTP GET (`fetch` / `axios`)  
- HTML parse with something like `cheerio`  
- Deterministic rules

Linktree pages are relatively simple: a bunch of `<a>` tags. You don’t need a headless browser or an LLM to find them.

**Classification logic** (determine platform/type) is easy without AI:

- URL pattern matching:
  - `spotify.com/artist` → `spotify_artist`
  - `instagram.com/` → `instagram`
  - `tiktok.com/@` → `tiktok`
  - `x.com/` or `twitter.com/` → `twitter`
  - `onlyfans.com/` → `onlyfans`
  - etc.
- For everything else, mark `type = 'generic'`.

That’s fast, cheap, and scale-friendly.

### When Puppeteer makes sense

Use a headless browser *only* when:

- The page is heavily JS-driven and you literally don’t see links in the server-rendered HTML, **and**
- You really need the extra data.

Puppeteer (or Playwright) is heavier:

- Higher CPU/memory → more infra cost
- More likely to trigger anti-bot measures
- Slower per request

I’d keep Puppeteer as a special-case fallback, not the default.

### Where AI can help (but isn’t required)

AI is bad as a primary HTML parser (too expensive and overkill), but can help with:

- Classifying weird / niche links:
  - You give it URL + link text and ask “is this a social / store / newsletter / booking / merch?”  
  - Use only when your regex-based classifier says “unknown”.
- Generating *labels*:
  - You have URL + maybe page title, and ask AI to generate a nice short label: “My Store”, “Tour Tickets”, etc.
- Summarizing profiles (for your own internal lead notes).

But **for the core “pull links out of Linktree and classify common platforms” use case, AI is overkill and more expensive** than simple regex + a few lines of code.

---

## 5. Scale, proxies & “modern cheapest way”

A few realities here:

- At small/medium scale, you can usually get away with:
  - Direct HTTP requests
  - Reasonable rate limits
  - Respecting robots.txt / ToS
  - Good user-agent and backoff

- At larger scale, platforms may:
  - Apply rate limits
  - Use anti-bot services / CAPTCHAs
  - Explicitly disallow scraping in their terms

**Policy/compliance note:**  
You should design this to respect ToS and local laws. For anything beyond light, user-initiated scraping (user pastes their own Linktree), you’ll want to:

- Review the specific platform’s terms.
- Keep volume modest and tied to explicit user actions.
- Provide a way for users to request deletion of imported data.

### Do you *need* proxies?

- For low-volume, user-driven actions (user pastes their own Linktree, you fetch it once): probably not.
- For high-volume background crawling of *lots* of random Linktrees: you may start hitting limits and need:
  - Either a **third-party scraping API** (they handle IP rotation, CAPTCHAs, etc.),
  - Or your own proxy/rotation setup.

But: *don’t start there*. Start with:

- Direct requests
- Conservative rate limits
- Good caching (don’t re-scrape the same URL constantly)

See how far that takes you. Bring in proxies or scraping APIs only once you actually see blocking or throttling becoming a real constraint.

### “Can we fire it through AI instead of proxies?”

No. AI doesn’t solve:

- Network access
- IP-based rate limiting
- CAPTCHAs

You still need to **retrieve** the HTML somehow. AI comes downstream (for classification/labeling), not as a network layer.

---

## TL;DR for next steps

1. **Implement Linktree-only import via queue** from the Universal Links Manager:
   - Paste Linktree → enqueue job → fetch page → parse `<a>`s → write `link_suggestions`.
2. **Build suggestions UI** in Universal Links Manager:
   - Show suggested links with “Add all / Add selected / Dismiss”.
3. Use **simple HTTP + HTML parse + regex** for now:
   - No AI, no Puppeteer, no proxies at this phase.
4. Once that’s solid:
   - Add IG/Spotify import using the same pattern.
   - Add recursion + deeper enrichment.
   - Later sprinkle AI for labeling and suggestions where it makes UX feel magical.

If you want, I can sketch out the actual data structures (`link_suggestions` table + job payload shape + simple URL classifier) so you can plug it straight into your Next.js/BullMQ setup.


So, good plan. The only tweaks is, like, I wouldn't tell them that we're scraping their link tree. I feel like that's not useful. Instead, what I would do is just add to the action panel we already have with the pills for suggested links. I would just start populating more links into that pill automatically. And just make it, like, this magical, like, suggestion thing. Like, oh, is this also your thing, you know? Then it's just more of, like, a magical, like, nudge rather than a, like, oh, stand by while we do this fucking thing, you know? I also feel like that's, like, yeah, I just feel like that's a better way to do it. The rest of this seems good. I would add that I really want them to be able to, ideally, concurrency and rate limiting and all that stuff we handle. We have a, like, section in the admin panel where the admin can change that easily. In an ideal world, unless there's an easy UI for managing that somewhere else. Okay, so for link three for now, we could go with just the simple Axios or whatever. But we should have an intelligent system in how we build this. Because I want to build this in a very intelligent way where, like, we build a scalable system that will work going forward. And we won't have to keep rebuilding. So I want to think, like, have an intelligent way for us to easily add more networks in the future. And then have an intelligent way for us to specify, like, oh, this network is going to need Puppeteer. This network is going to just use Axios. This network is going to use an LLM or something. Kind of, like, build with that in mind where there's, like, going to be a way for us to easily rotate through scraping methods or whatever. I think for now we don't even have to worry about proxies. Because I think we'll have relatively low usage to start. Except maybe on the admin side. The admins are adding a lot of them. But, yeah, we should have at least we can, you know, set some basic rate limits and stuff to keep us safe. Caching is a good idea. And then the other thing I want to do is we talked briefly about this before. But basically if we scrape an entire profile for, like, say, someone's Instagram or something. And we add that and all of the data we have to, like, a creator table in the database. But we don't necessarily know that those are, like, confirmed links, right? Like, that's what we suggest or we suspect belongs to that creator. And if they go in and they claim that profile, at that point, we can say, okay, those are now confirmed. You know, if they haven't changed them. If a user manually adds a link themselves, that's a confirmed link. We know it belongs to them. But if they add, like, a link tree and then we bring in a bunch of things that we think are theirs, you know, that's not confirmed, but we suspect it is. So there's some confidence that it is, but it's not. So I guess we just need to manage, like, that confidence level on all the data that we're bringing in. And maybe there's even a more intelligent system where it's, like, if they add a Twitter account and they add a YouTube account and both of them link to an Instagram, that's higher confidence than if we just pulled in, like, their link tree and it had an Instagram. You know what I mean? Like, the more times we see that link, the higher confidence we have for it, you know? And maybe even there's some waiting, like, is it similar to their other usernames, which would help, you know, differentiate between, like, sometimes it'll be like, oh, maybe I'm like, you know, maybe it's like Armin Van Buren, right? The DJ. Maybe his link tree has a link to Armin Van Buren's Instagram, but it also has a link to the Armada music label Instagram. Well, the Armin Van Buren Instagram handle is similar to his link tree handle and his Twitter handle, so that's higher confidence than the Armada one because that's going to be a company, not his personal Instagram, right? So it's going to be lower confidence on that. So that's the thing that we might want to, like, think about having some kind of, like, little algorithm for the confidence level and just making sure we're storing confidence level in a database or something. Or if there's a more intelligent way that I'm not thinking about how to do this, to do that, to just make sure that we're sorting through all of this data in an intelligent way so that we have the ability to make these suggestions and empower these intelligence features. That would be another thing that I would just add to this. So let's just expand this plan. So let's just expand this plan. And I want to, like, I want to have this kind of, like, cleanly laid out how all of this is going to work from now to the finished product so that I can not have to rebuild anything and not take on technical debt. And I want to be able to kind of put this document into our repo so that it's visible where this is supposed to go and that any AI coding agents have access to it. So that's kind of where I'm at with that. And then, as far as. Yeah, the dashboard should be magical so it should come in, like, you know, update automatically and stuff. But yeah, the priority, I guess you're correct, is that we should be able to do link tree as our minimal thing in the links manager where they can just paste in a link tree and then boom, it starts suggesting links for them. That should be the first thing. The next thing I would want to have then would be for the admin to be able to have, like, somewhere in the admin dashboard is basically a version of the groups link manager where the admin can edit and it can kind of create a creator profile, a Joby profile. And add all those links and then also pull in their name and their photo and stuff. And we want to kind of think of that, you know, across the board, too. Like, anytime we pull in this data, it's not just the social links and the music DSPs that we want to pull in, but we also want to pull in, like, what is their name? And do they have a photo? And we want to weight those photos. You know, the Spotify artist profile is going to be a better photo than the Instagram photo, but the Instagram photo is going to be a better photo than the Twitter photo, right? And so we want to kind of, like, have all that stuff coming in, too. And so then when the admin posted a link tree, it makes a profile for them that already has their photo in it and everything. So we just want to be thinking about that stuff, too. All right.


Got it, Mr. White. Let’s turn all of this into a clean, repo-ready design doc you can hand to AI agents and future you.

I’ll write it as if it’s `docs/link_ingestion_and_suggestions.md`.

---

# Jovi Link Ingestion & Suggestions System

## High-level goals

- Let **users and admins paste any profile/link-in-bio/social URL** and:
  - Auto-normalize it.
  - Enrich it with other accounts/links, names, and photos.
  - Surface high-confidence matches as “magical” suggestions (pills).
- Use **one shared ingestion system** for:
  - Universal Links Manager (user-facing)
  - Admin tooling (pre-building profiles)
  - Future bulk imports.
- Make it **easy to add new networks** (Linktree now, more later) without rewrites.
- Track **confidence levels** for all inferred data:
  - Distinguish *suspected* vs *confirmed*.
  - Promote to confirmed when users/owners implicitly or explicitly validate.
- Keep **rate limits & concurrency configurable from admin** so we can scale up/down safely.

We *never* tell users “we are scraping X.” They just experience magical “is this also you?” suggestions.

---

## Core concepts

### Entities

- **Creator**
  - Canonical person/artist.
- **Social Account**
  - An account on a specific platform (Instagram, Spotify, Twitter/X, TikTok, OnlyFans, Linktree, etc.).
- **Link**
  - A URL that appears on the creator’s Jovi profile (social profile, DSP, shop, booking, etc.).
- **Asset**
  - Images (avatars, banners) associated with a creator.
- **Ingestion Job**
  - A queued unit of work to fetch/parse/enrich from some URL.
- **Evidence & Confidence**
  - Each inferred link/account/photo has evidence from one or more sources with a computed confidence score.

---

## Data model (simplified)

This is conceptual; map it to Prisma/Drizzle/etc.

### Table: `creators`

```text
id                  PK
slug                unique, used for jlv.ie/slug
display_name        string
primary_vertical    enum (music, fitness, etc.), nullable
claimed_user_id     FK -> users.id, nullable
claim_status        enum('unclaimed','invited','claimed','verified')
created_at
updated_at
```

### Table: `social_accounts`

```text
id                  PK
creator_id          FK -> creators.id
platform            enum('instagram','spotify','twitter','tiktok','linktree',...)
handle              string   -- normalized handle, e.g. "@timwhite"
url                 string   -- canonical profile URL
is_verified_flag    bool     -- if we can detect verification
paid_flag           bool     -- e.g. Linktree Pro or Meta Verified heuristic
raw_data            jsonb    -- raw scraped data blob
confidence          float    -- 0.0–1.0
status              enum('suspected','confirmed','rejected')
created_at
updated_at
```

### Table: `links`

Used for both active links and suggested links in the UI.

```text
id                  PK
creator_id          FK -> creators.id
url                 string
title               string        -- label shown in UI
type                enum('spotify','apple_music','instagram','twitter','shop','generic',...)
source_platform     enum('linktree','instagram','spotify','manual','admin',...)
confidence          float         -- 0.0–1.0
state               enum('suggested','active','rejected')
created_at
updated_at
```

- **Universal Links Manager** shows:
  - `state = 'active'` as current links.
  - `state = 'suggested'` as the pills.

### Table: `assets`

```text
id                  PK
creator_id          FK -> creators.id
type                enum('avatar','banner')
url_cloudinary      string
source_platform     enum('spotify','instagram','twitter','linktree','manual',...)
width               int
height              int
confidence          float        -- 0.0–1.0
locked_by_user      bool         -- set true when user uploads manually
created_at
updated_at
```

### Table: `ingestion_jobs`

```text
id                  PK
job_type            enum('import_linktree','import_instagram','import_spotify',...)
payload             jsonb        -- { creatorId, sourceUrl, depth, ... }
status              enum('pending','processing','succeeded','failed')
error               text
attempts            int
created_at
updated_at
```

### Table: `scraper_configs`

Configurable via admin.

```text
id                  PK
network             enum('linktree','instagram','spotify',...)
strategy            enum('http','browser','api')   -- default scraping strategy
max_concurrency     int
max_jobs_per_minute int
enabled             bool
created_at
updated_at
```

---

## Confidence / evidence model

We need to distinguish:

- **Suspected links/accounts** (inferred from scraping)
- **Confirmed links/accounts** (user/admin validated)
- A **scored continuum** so we can:
  - Automatically show suggestions.
  - Decide when to auto-add something (e.g. admin-created preprofile).
  - Handle conflicting data intelligently.

### Confidence tiers

Let’s define:

- `0.0–0.3` → ignore (too weak, no UI)
- `0.3–0.7` → suggestions (`state = 'suggested'` in `links`)
- `0.7–1.0` → auto-eligible; either:
  - auto-add as `state = 'active'` in some flows (e.g. admin prebuild), or
  - show as “strong suggestion” pill.

### Evidence types & weights (initial idea)

Each time we see a piece of evidence for a given candidate link/account, we add weight:

- Manual actions:
  - User adds link manually: +0.6, mark `state = 'active'` + `status = 'confirmed'`.
  - Admin adds link manually: +0.5 (for admin-built profiles).
  - User edits / keeps link after claim: +0.2 per “unchanged” event.

- From scraping:
  - Appears on linktree: +0.2
  - Appears in Instagram bio: +0.25
  - Appears in Spotify profile/links: +0.3
  - Appears across 2+ distinct sources: +0.15 bonus per extra source.

- Handle similarity:
  - Candidate Instagram handle similar to creator’s main handle or slug (e.g. `arminvanbuuren` vs `arminvanbuurenofficial`): +0.1 to +0.2 depending on similarity score.
  - Handle clearly different brand (e.g. `armadamusic` vs `arminvanbuuren`): 0 or even subtract a small amount.

**We cap at 1.0** and store the final `confidence` on the record.

Implementation detail:

- Track evidence in memory when computing, or define an optional `link_evidence` table if we want auditable history later. For v1, we can simply recompute confidence whenever new evidence is discovered.

### Confirmed vs suspected

- **Confirmed**:
  - `links.state = 'active'` AND created/edited by user or admin.
  - `social_accounts.status = 'confirmed'` when:
    - User adds that account manually, or
    - User claims a pre-generated profile and leaves that account in place.

- **Suspected**:
  - Anything coming purely from scraping with no manual confirmation yet.
  - Saved as:
    - `links.state = 'suggested'` or `'rejected'` before claim.
    - `social_accounts.status = 'suspected'`.

Upon **claim**:

- For each suspected link/account:
  - If user keeps it (no change and no delete):
    - bump confidence (+0.2)
    - `state = 'active'` (links) / `status = 'confirmed'` (social accounts).
  - If user deletes/dismisses it:
    - `state = 'rejected'` (links) / `status = 'rejected'` (social accounts).
    - confidence can be set to 0.

---

## Avatar & name selection

We want a deterministic but flexible algorithm for choosing the best avatar and display name.

### Avatar selection

We maintain multiple possible `assets` with `confidence`. To select the primary avatar:

1. If there is any `asset.locked_by_user = true` for type `avatar`:
   - Use that, ignore everything else.

2. Otherwise, compute a **source weight**:

   Example base weights:

   ```text
   spotify     = 100
   apple_music = 95
   instagram   = 90
   twitter     = 80
   tiktok      = 75
   linktree    = 60
   manual      = 99 (for admin-only cases)
   ```

3. For each asset, compute:

   ```text
   asset_score =
     base_weight(source_platform)
     + log(resolution) * 0.1
     + confidence * 10
   ```

4. Pick asset with highest `asset_score`.

This function should live in a shared “identity resolution” module used by:

- Admin panel when creating/updating a profile.
- Onboarding preview when new data arrives.
- Background ingestion jobs.

### Display name selection

Similar strategy, but with text:

- Prefer Spotify/Apple Music “artist name” for musicians.
- Next prefer Linktree title or Instagram name.
- If user edits their display name in Jovi:
  - Save that as canonical and mark as locked.

---

## Scraper architecture (pluggable, future-proof)

We want to easily add new networks and change strategies (HTTP vs Puppeteer vs API/LLM) per network.

### Interface

Conceptually:

```ts
interface ScraperStrategy {
  network: 'linktree' | 'instagram' | 'spotify' | ...;

  supports(url: string): boolean;

  // fetch the raw document
  fetch(ctx: FetchContext): Promise<RawDocument>;

  // extract structured info: links, social accounts, assets, maybe a name
  extract(doc: RawDocument): Promise<ExtractionResult>;
}
```

Where:

```ts
type FetchStrategy = 'http' | 'browser' | 'api';

interface FetchContext {
  url: string;
  strategy: FetchStrategy; // from scraper_configs
  // includes HTTP client, optional browser instance, etc.
}
```

`ExtractionResult`:

```ts
interface ExtractionResult {
  links: Array<{
    url: string;
    title?: string;
    source_platform: string; // 'linktree' etc.
  }>;
  socialAccounts?: Array<{
    platform: string;
    handle: string;
    url: string;
  }>;
  assets?: Array<{
    type: 'avatar' | 'banner';
    url: string;
    source_platform: string;
  }>;
  displayName?: string;
}
```

Each network implements its own strategy:

- **Linktree**: `strategy = 'http'`, parse HTML via Cheerio, extract `<a>` tags, maybe page title.
- **Instagram**: maybe `strategy = 'http'` hitting public profile pages + parsing HTML/meta.
- **Spotify**: `strategy = 'api'` using official API.

We keep **the interface stable**, so switching Linktree from `http` to `browser` later is just a config change plus a new `fetch` implementation.

---

## Ingestion pipeline

Single canonical path from “we have a URL” to “we have enriched structured data & suggestions”.

### Job creation

Any time we want to ingest something:

- From Universal Links Manager (user):
  - User pastes Linktree URL:
    - Normalize and save as an *active* link immediately (so they see it).
    - Enqueue `ingestion_job` with `job_type = 'import_linktree'` and `payload = { creatorId, sourceUrl }`.

- From Admin:
  - Admin pastes Linktree/Spotify/Instagram when creating a Jovi profile:
    - Same as above; just creatorId may be new.

### Worker processing

Worker pulls `ingestion_job`:

1. Look up `scraper_configs` for the network to get:
   - `strategy` (`http`/`browser`/`api`)
   - `max_jobs_per_minute`
   - `enabled`.

2. Pick the correct `ScraperStrategy` implementation based on URL/network.

3. Call `strategy.fetch()` with appropriate client (HTTP, Puppeteer, etc.).

4. Call `strategy.extract()`.

5. Feed `ExtractionResult` into a **normalization & merge** function:

   ```ts
   normalizeAndMergeExtraction(creatorId, extractionResult)
   ```

   This function:
   - Normalizes URLs.
   - Classifies link types (spotify vs generic, etc.).
   - Upserts `social_accounts` with updated confidence.
   - Upserts `assets` and re-computes primary avatar if needed.
   - Upserts `links`:
     - For new URLs:
       - Compute confidence.
       - Decide `state`:
         - If high confidence (e.g. own Spotify for a music vertical), we may set `state = 'active'`.
         - Otherwise, `state = 'suggested'`.
     - For existing URLs:
       - Add evidence & bump confidence.

6. Optional recursion:
   - For each extracted link that looks like a new social profile/link-in-bio:
     - Enqueue another `ingestion_job` with `depth + 1`, respecting a max depth.

### Queue & rate limiting

Use separate queues per network:

- `queue:import:linktree`
- `queue:import:instagram`
- `queue:import:spotify`
- …

Each queue’s worker:

- Reads `scraper_configs` periodically (or on startup).
- Sets:
  - `concurrency = max_concurrency`.
  - Rate-limit (jobs per minute) via the queue library.

We expose `scraper_configs` in the admin so you can tweak concurrency and rate limits at runtime.

---

## Universal Links Manager UX

**Current:** you already have an action panel with pills for suggested links.

**Behavior after this system:**

- User pastes *any* URL or handle:
  - We interpret it, normalize it, and save an `active` link immediately.
  - If it’s a Linktree or supported profile, we also enqueue ingestion.
- Background ingestion updates:
  - `links` table with new `state = 'suggested'` rows as we find more links.
- The UI:
  - Polls (or uses a subscription) for `links` where:
    - `creator_id = currentCreator`
    - `state = 'suggested'`
  - Renders them as pills:
    - “Is this also you?” with icon (platform) + title.
  - Actions:
    - **Add** → set `state = 'active'`, maybe bump `confidence`.
    - **Dismiss** → set `state = 'rejected'`, maybe set `confidence = 0`.

No explicit “we’re scraping xyz”; it just feels like the panel magically gets smarter.

---

## Admin panel UX

Short-term priorities:

1. **Scraper config section**
   - Table of networks (`linktree`, `spotify`, `instagram`, etc.).
   - Editable fields:
     - Enabled (on/off).
     - Strategy (`http`/`browser`/`api`).
     - Max concurrency.
     - Max jobs per minute.
   - Maybe a small stats column: jobs last 24h, error rate.

2. **Creator profile editor**
   - Mirror the Universal Links Manager but with admin controls:
     - Add/edit links (manually).
     - See suggested links (same pill system).
   - Avatar/name controls:
     - Show current primary avatar + source.
     - List alternative avatars (small thumbnails with source & confidence).
     - Allow “lock” to a specific asset (sets `locked_by_user/admin = true`).
   - Claim/verify controls (you already have verify button; just plug into the same `creators.claim_status` / `verified` logic).

The idea: **admin uses the same ingestion + suggestion engine**, just with more power and context.

---

## Implementation phases (from now → “finished”)

### Phase 1 – Linktree → suggested links

- Implement:
  - `links` table with `state` and `confidence`.
  - `ingestion_jobs`, `scraper_configs`.
  - `ScraperStrategy` interface.
  - `LinktreeScraper` using plain HTTP + HTML parsing.
- Universal Links Manager:
  - Detect Linktree URLs.
  - Save the Linktree link as `active`.
  - Enqueue `import_linktree` job.
  - Show suggested links from `links.state = 'suggested'` as pills.

### Phase 2 – Admin profile builder using same engine

- Admin:
  - UI for editing creator’s links & avatar using the same pills and selection logic.
  - Ability to paste Linktree/Spotify/etc. and trigger ingestion.
- Backend:
  - Start storing assets (avatars) and display names from extraction results.
  - Implement avatar selection logic.

### Phase 3 – Confidence & cross-source reasoning

- Implement the confidence model:
  - Evidence weighting functions.
  - Handle similarity scoring.
  - Multi-source bonuses.
- Apply to:
  - Links (`links.confidence`).
  - Social accounts (`social_accounts.confidence` & `status`).
  - Assets (`assets.confidence`).
- Hook into claim flow:
  - Promote suspected → confirmed when user keeps data on claim.
  - Reject when user deletes/dismisses.

### Phase 4 – More networks + recursion

- Add new `ScraperStrategy` implementations:
  - `SpotifyScraper` (likely API).
  - `InstagramScraper`, etc.
- Enable recursion:
  - From Linktree/Spotify/IG, enqueue follow-up jobs for discovered social profiles.
  - Respect per-network rate limits + max depth.

### Phase 5 – AI-assisted polish (optional, later)

- Use AI to:
  - Classify non-standard links into “shop / booking / newsletter / merch”.
  - Generate/clean link titles.
  - Summarize creator for internal notes.
- Keep AI out of the parsing core; use it only for *semantics*, not for raw data extraction.

---

This plan should let you:

- Start with **Linktree → magical pills** quickly.
- Reuse the **exact same ingestion + confidence system** for:
  - Admin prebuilt profiles.
  - Future bulk imports.
  - Future “paste any social link” onboarding.
- Grow into a full creator identity graph / lead engine without throwing anything away.
