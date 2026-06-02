---
conversation_id: 696a8965-3380-8327-b49b-f0cd625bbfe5
created: 2026-01-16
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 10
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Spotify to DSP Mapping
type: guide
updated: 2026-01-16
---

# Spotify to DSP Mapping

> Conversation ID: 696a8965-3380-8327-b49b-f0cd625bbfe5
> Created: 2026-01-16T18:54:50Z
> Updated: 2026-01-16T19:54:33Z
> Messages: 10

---

## User

If we have an artist spotify url, whats the most reliable way for use to get their other music DSPs?

---

## Assistant

Mr. White,

**Most reliable approach (production-grade): use a canonical artist ID, not name matching.**

### Recommended pipeline

1. **Resolve the Spotify artist → MusicBrainz artist**
   - Use the Spotify Artist ID from the URL.
   - Query **entity["organization","MusicBrainz","open music metadata database"]** by:
     - ISRCs from the artist’s top tracks (best)
     - Or Spotify artist name + country + releases (fallback)

2. **Extract universal identifiers**
   - From MusicBrainz, pull:
     - **ISRCs** (track-level, strongest join key)
     - **UPC/EAN** (release-level)
   - These IDs are DSP-agnostic and stable.

3. **Map ISRCs to other DSPs**
   - Use DSP search APIs with ISRC:
     - **entity["company","Apple Music","music streaming service"]** Search API (by ISRC)
     - **entity["company","YouTube Music","music streaming service"]** (via Content ID / ISRC where available)
     - **entity["company","Amazon Music","music streaming service"]**
     - **entity["company","Deezer","music streaming service"]**
   - Aggregate results back to artist profiles on each DSP.

### Why this works best
- **ISRCs beat name matching** (artists with aliases, translations, collabs).
- **MusicBrainz acts as the canonical linker** across catalogs.
- Minimizes false positives/negatives at scale.

### Practical fallback (lower accuracy)
- Direct artist-name search on each DSP → cluster by overlapping ISRCs.
- Acceptable for small volumes; not reliable at scale.

### If you want a shortcut
- Use a **commercial metadata provider** (higher cost, highest reliability):
  - Sound Ideas: **entity["company","Soundcharts","music analytics platform"]**, **entity["company","Chartmetric","music analytics platform"]**
  - Enterprise metadata: **entity["company","Gracenote","music metadata provider"]**

**Bottom line:**  
Spotify URL → Spotify Artist ID → MusicBrainz → ISRCs → DSP searches.  
That’s the most reliable, defensible method.

---

## User

This is great. Whats cost on commercial providers. If there's no free developer plan or crazy cheap dev plan, then its not practical option for us.

---

## Assistant

Mr. White — here’s a **clear snapshot of what the commercial music data providers actually cost and whether they’re practical for a startup/dev team**:

### 💰 Commercial Providers (Typical Pricing)

**1. Soundcharts**  
- Basic dashboard starts **$10/mo per artist**; multi-artist tiers ~$49/mo and unlimited ~$129/mo. citeturn0search0  
- **Developer API access costs more** (~$250/mo for ~500K queries; scales up). citeturn0search2  
- Custom enterprise datasets start ~$500/mo+ and require contacting sales. citeturn0search2  
- *No substantial free API plan.*  
**Bare minimum practical if you need API access:** **$250+/mo**.

**2. Chartmetric**  
- Offers low entry consumer/artist tiers (~$5–$10/mo for single artists). citeturn0search1  
- Professional/industry tiers range **$40–$150+/mo** depending on number of artists and data needed. citeturn0search1  
- Developer API reportedly **~$350+/mo per user** with rate limits. citeturn0search20  
- There’s typically a **free version or trial**, but API access is restricted at free tier. citeturn0search12

**3. Songstats (smaller/less expensive alternative)**  
- Entry plans start around **€11.99/mo (~$12/mo)**; higher tiers ~€19.99–€99.99/mo. citeturn0search4  
- Doesn’t replace full metadata set, but covers cross-DSP data and alerts.

**4. Viberate (mid-tier)**  
- Around **$19.90/mo (~$239/yr)** for analytics; API access often extra (~€300/mo). citeturn0search19turn0search20

**5. Gracenote**  
- Enterprise-grade metadata platform with **custom quotes only** — typically out of reach for small teams due to cost and integration complexity. citeturn0search18

---

### 📌 Practical Reality for Dev Teams

1. **Free / Cheap API access doesn’t really exist** for cross-DSP artist metadata at scale — the ones that do (Soundcharts, Chartmetric) start in the **hundreds of dollars per month** once you need API calls and high query volume.

2. **Artist-level dashboard plans (~$5–$60/mo)** are cheap, but **not useful for automated DSP lookup** outside of manual UI use.

3. **API plans (~$250–$350/mo+)** are where you get usable developer access, and they’re *generally not cheap*.

4. Lower-cost alternatives like Songstats/Viberate can be useful for **alerting and analytics**, but they aren’t full coverage metadata APIs the way you’d need to reliably map Spotify to other DSP catalogs.

---

### 🧠 Bottom Line

- **Free developer metadata APIs for cross-DSP artist info don’t exist at production scale** — you’ll be looking at **$250–$400+/month** from a commercial provider if you need real API access.  
- If your use case is smaller (e.g., manually checking a handful of artists), the **consumer/artist tiers ($5–$60/mo)** might suffice.  
- For *true large-scale automated discovery or integration*, **commercial metadata APIs are the practical route* but **not ultra-cheap**.

Would you like me to list **free or low-cost open metadata sources/APIs** (e.g., MusicBrainz, Wikidata, open ISRC databases) you can combine programmatically?

---

## User

Ok so for now lets layout the plan without them.

---

## Assistant

Mr. White,

Below is a **clean, production-ready plan that avoids all paid providers** and still gets you **high-confidence cross-DSP artist mapping**.

---

## Goal
**Input:** Spotify artist URL  
**Output:** Artist profiles + catalogs on major DSPs (Apple, YouTube, Amazon, Deezer)  
**Constraint:** Free / open APIs only

---

## System Architecture (No Commercial Data)

### 1. Parse Spotify Artist URL
- Extract **Spotify Artist ID**
- Fetch:
  - Artist name
  - Popular tracks
  - Track **ISRCs**

**Why:** Spotify’s ISRC coverage is very strong and free.

---

### 2. Canonicalize via **entity["organization","MusicBrainz","open music metadata database"]**
**Primary match method (reliable):**
- Query MusicBrainz using **ISRCs**
- Resolve:
  - MusicBrainz Artist ID (MBID)
  - Official artist aliases
  - Releases + recordings

**Fallback:**
- Name + country + release overlap
- Reject matches without ISRC confirmation

**Result:** One canonical artist identity.

---

### 3. Build an Internal ID Graph
Create your own stable mapping table:

```
internal_artist_id
├─ spotify_artist_id
├─ musicbrainz_artist_id
├─ artist_aliases[]
├─ isrcs[]
├─ upcs[]
```

This becomes your **source of truth**.

---

### 4. Map to Other DSPs (Free APIs / Search)

#### Apple Music
- Search by **ISRC**
- Group results by artist ID
- Extract Apple Music artist URL

#### YouTube / YouTube Music
- Search by ISRC → video
- Resolve **Official Artist Channel (OAC)**
- Back-propagate to artist page

#### Amazon Music
- ISRC or track search
- Cluster by shared UPCs + artist name

#### Deezer
- Native ISRC search
- Deezer has excellent free search coverage

**Key rule:**  
> **Never trust artist name alone**  
Require **≥2 shared ISRCs** to confirm artist mapping.

---

### 5. Confidence Scoring (Critical)
Assign confidence to each DSP match:

| Signal | Weight |
|------|-------|
| Exact ISRC match | High |
| Shared UPC | Medium |
| Alias match | Medium |
| Name-only match | Low |

Only publish artist DSP links above a confidence threshold (e.g. 0.8).

---

### 6. Cache Aggressively
- Cache:
  - ISRC → DSP track IDs
  - Artist → DSP artist IDs
- Re-hydrate incrementally as catalog grows
- Prevent rate-limit issues

---

## What You *Won’t* Get (Without Paid Providers)
Be clear-eyed:

❌ Instant artist-level DSP mapping  
❌ 100% coverage for legacy catalogs  
❌ Perfect handling of compilation-only artists  
❌ Label-side corrections

But you **will get**:
- **High accuracy for modern releases**
- **Scales cheaply**
- **Defensible, auditable logic**
- **Zero vendor lock-in**

---

## Why This Is the Right Move Now
- ISRC-based joins are how labels do this internally.
- You avoid $3–5k/year burn before PMF.
- You can later **swap in Soundcharts/Chartmetric as a fast path**, not a dependency.

---

## When to Reconsider Commercial Providers
Re-evaluate when:
- You need sub-second responses at scale
- You need historic catalogs pre-ISRC coverage
- You need label-verified corrections

---

If you want, next we can:
- Design the **exact API call flow**
- Define **schema + DB tables**
- Build **false-positive filters**
- Walk through **edge cases (collabs, splits, remasters)**

Just say the word.

---

## User

What do you think about us building an open source music brainze competitor and using it as our primary data source for music artists?

---

## Assistant

Mr. White,

Short answer: **bad idea as a primary strategy, good idea only as a long-term side asset**. Here’s the straight, non-romantic take.

---

## Why an open-source MusicBrainz competitor is a bad primary move

### 1. **Data gravity will crush you**
**entity["organization","MusicBrainz","open music metadata database"]** works because of:
- 20+ years of community edits
- Label + distributor feeds
- Deep moderation tooling
- Cultural buy-in from the industry

You won’t replicate that without:
- Years of burn
- A dedicated contributor community
- Incentives for corrections (which are expensive)

This is not an engineering problem — it’s a **social coordination problem**.

---

### 2. **Metadata quality is the hard part, not storage**
Storing artists, releases, ISRCs is trivial.  
Resolving:
- aliases  
- homonyms  
- collaborations  
- remasters vs originals  
- regional variants  

…is where 90% of effort goes.

MusicBrainz already solved this *just barely*.

---

### 3. **Open source ≠ free**
Hidden costs:
- Moderation
- Dispute resolution
- Anti-spam
- Data poisoning
- API stability guarantees

Once people depend on it, you become the unpaid steward.

---

## Why it *could* make sense (narrowly)

### 1. As a **derivative, not replacement**
Build a **thin, opinionated layer on top of MusicBrainz**, not a competitor.

Example:
```
MusicBrainz
+ Spotify ISRC graph
+ Deterministic matching rules
+ Confidence scoring
+ DSP back-links
= Your dataset
```

Open-source **that layer**, not the base corpus.

---

### 2. As a **strategic wedge**
If you:
- Open-source your **matching + confidence engine**
- Allow others to submit verified ISRC ↔ DSP mappings
- Keep write access gated by deterministic proofs

You might attract:
- Indie devs
- Research orgs
- Labels with narrow use cases

But this is **Phase 3**, not now.

---

### 3. As a defensive moat later
Once you have usage:
- Your internal graph becomes more valuable than MusicBrainz
- Open-sourcing parts builds trust
- You become *the* reference for cross-DSP resolution

But this requires:
- Real traffic
- Real feedback loops
- Real incentives

---

## What I’d do instead (strong recommendation)

### Phase 1 — Consume, don’t compete
- Use **MusicBrainz**
- Use ISRCs as truth
- Build deterministic pipelines
- Track confidence + disagreements

### Phase 2 — Quietly diverge
- Store every mismatch
- Track “known wrong” metadata
- Build private correction rules

### Phase 3 — Open-source selectively
Open-source:
- Matching heuristics
- Confidence scoring
- Conflict resolution logic

Do **not** open-source:
- Full dataset
- Moderation queues
- Abuse tooling

---

## Red line (important)
If you try to:
> “Build an open-source MusicBrainz replacement as our primary source”

You will:
- Delay product by 12–24 months
- Attract contributors before users
- Win GitHub stars and lose the market

---

## Bottom line
- **As a primary data source:** ❌ No  
- **As a long-term asset layered on top:** ✅ Possibly  
- **As an early differentiator:** ❌ Definitely not  

If you want, I can sketch:
- The **exact minimal open-source surface** that *would* make sense  
- A **governance model** that doesn’t destroy you  
- How to avoid becoming “maintainers of last resort”

Just tell me.

---

## User

Can we push our data back to musicbrainz to update profiles on behalf of artists?

---

## Assistant

Mr. White,

**Yes, you can contribute data back to MusicBrainz — but only in a limited, community-governed way, and “on behalf of artists” is not a special permission tier.** Your edits still go through the normal MusicBrainz edit/voting system.

## What you can push programmatically (realistic)
MusicBrainz’s own API docs are explicit: **only a narrow set of data can be submitted via the API at all**—primarily **ISRCs, barcodes, tags, ratings**; “for most data additions you should use the website instead.” citeturn4view0

If you want artists to authorize you, MusicBrainz supports OAuth2, and the scopes that matter for submissions include:
- `submit_isrc` (submit new ISRCs)
- `submit_barcode` (submit barcodes) citeturn3view0

So: **you can build an “artist connect” flow** where the artist logs into MusicBrainz and authorizes your app, then you submit **ISRCs/barcodes** on their behalf (where it’s supported). citeturn3view0turn1view0

## What you generally *cannot* push via API
- Full “profile updates” (bios, links, relationships, merges, etc.) are **not broadly supported via OAuth scopes**; most of that is done through **the website editing UI** and community review. citeturn4view0turn0search0

## If you want automation beyond ISRC/barcode
You’re in **bot territory**:
- MusicBrainz explicitly allows bots that “automatically enter edits,” but they have governance requirements and limits (bot account type, open edits/day limits, code open-sourced, etc.). citeturn1view2turn1view3
- Even then, you’re still not “verified artist edits.” You’re just a bot editor whose edits can be voted down.

## Practical recommendation (what works)
1. **Use OAuth2** for artists to authorize you.
2. **Submit only what the API supports** (ISRCs/barcodes) and treat that as your “write-back win.” citeturn3view0turn4view0  
3. For everything else, generate a **pre-filled edit package + instructions** for the artist (or your internal team) to submit via the website, with good edit notes and sources. citeturn0search0turn1view4  
4. If you later need scale: implement a bot, but follow the bot code of conduct and limits. citeturn1view3

## One big gotcha
MusicBrainz’s API is **free for non-commercial use** and they point commercial users to their commercial plans. If your product is commercial, assume you’ll need to address that. citeturn4view0

If you tell me *which exact “profile fields” you want to update* (DSP links? artist URLs? credits? label relationships?), I’ll map each one to: **API-submit / website-edit / bot-safe / don’t-do**.


**Topic:** [[chatgpt-clusters/jovie_music]]
