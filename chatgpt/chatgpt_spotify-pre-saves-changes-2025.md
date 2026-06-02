---
conversation_id: 6945a38b-abc0-8333-af67-970ccae2ef51
created: 2025-12-19
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Spotify pre-saves changes 2025
type: note
updated: 2025-12-19
---

# Spotify pre-saves changes 2025

**Related:** [[jovie_music]]

> Conversation ID: 6945a38b-abc0-8333-af67-970ccae2ef51
> Created: 2025-12-19T19:12:13Z
> Updated: 2025-12-19T19:18:59Z
> Messages: 4

---

## User

Talk to me about spotify preserves in 2025. What has changed since 2015. Api changes, spotify native features, is it still worth it, best practices, what majors are doing etc.

---

## Assistant

Mr. White — I’m assuming you meant **Spotify “pre-saves”** (not “preserves”). In 2025, pre-saves have split into two worlds: **Spotify-native** (Countdown Pages) and **3rd-party/Web API “library save” flows**.

## What’s changed since 2015

### 1) Spotify finally made pre-saves a native, first-party feature
Back in 2015 there wasn’t an on-platform “pre-save” button; pre-saves were essentially a marketing workaround. In 2024–2025 Spotify formalized it with **Countdown Pages**, positioned as the “first-ever way to drive pre-saves… directly on Spotify.” citeturn1view3

Countdown Pages (2025 reality):
- Fans can **pre-save**, preview tracklist, watch **Clips**, and buy **merch** in one place. citeturn3view2turn5search7  
- On release, Spotify **push-notifies pre-savers** and **auto-adds the release to their Library**. citeturn3view2turn1view3  
- Discovery got more “in-app”: **Upcoming Releases hub** + global “Top 10 Countdowns” surfaces what’s coming. citeturn3view2turn3view1  

### 2) Eligibility + format constraints (this matters a lot operationally)
Countdown Pages are **not** for everything:
- Requires **≥5,000 “monthly active listeners”** (Spotify’s metric) citeturn3view2  
- Only **new, original albums + EPs** (no singles; no deluxe/reissues/compilations). citeturn3view2  

So for **singles**, most artists still use off-platform pre-saves (smart links + Web API library saves).

---

## API + platform changes that impact pre-saves (2015 → 2025)

### A) OAuth got stricter (big breaking change in 2025)
If you built (or used) old-school client-side pre-save flows, Spotify is shutting the door on the weakest patterns:
- **Implicit Grant removed on Nov 27, 2025**
- **HTTP redirect URIs disallowed**
- **“localhost aliases” disallowed** (loopback IP like `127.0.0.1` still ok) citeturn1view1turn1view2  

Practical meaning: pre-save implementations should be **Authorization Code + PKCE** (especially for web/mobile). citeturn1view2turn4search3  

### B) Web API got more restricted for *new* apps (less relevant to pre-save directly, but important for tooling)
As of **Nov 27, 2024**, new Web API use cases lost access to endpoints/features like **Recommendations, Audio Features/Analysis, Related Artists, featured/category playlists, preview URLs in multi-get**, and “algorithmic/editorial playlists.” citeturn2view0  
This affects how teams build targeting, discovery tooling, and “pre-save optimizer” products.

### C) “Extended access” got harder to obtain (2025)
From **May 15, 2025**, Spotify tightened criteria for **extended quota mode** to “established, scalable, impactful” apps aligned with platform strategy. citeturn3view0  
If you’re building internal label tooling, assume you may need to operate within standard quotas unless you’re truly at scale.

---

## Spotify-native pre-saves: what you can do in 2025

**Countdown Pages best-used features:**
- **Clips + merch** directly on the page; Spotify explicitly recommends using them. citeturn3view2turn5search2  
- **Automatic featuring**: Countdown Pages can appear at the top of your artist profile for fans who haven’t pre-saved yet. citeturn5search15  
- **Analytics**: pre-saves, impressions, and % who streamed in first 7 days (in Spotify for Artists). citeturn1view3  

**Timing guidance Spotify itself pushes:**
- Publish **≥7 days before release** → nearly **2x** pre-saves on average; dropping a single ahead of the album also correlates with **~2x** pre-saves. citeturn0search10turn3view1  

---

## Is it still worth doing pre-saves in 2025?

**Yes, for high-intent fans—especially if you can use Countdown Pages.** Two reasons:
1) Spotify routes pre-savers into **push notifications + auto-library add** on release day (real distribution, not just “interest”). citeturn3view2turn1view3  
2) Spotify reports high downstream consumption: “nearly 70%” of people who pre-save an album stream it week one. citeturn3view2turn1view3  

**When it’s *not* worth emphasizing:**
- If most of your spend is **cold acquisition**, pre-save friction can underperform a straight-to-play “listen now” objective.
- If your release is a **single**, you’re often relying on 3rd-party pre-save flows (more drop-off, more compliance/security overhead).

---

## Best practices (what works in 2025)

### If you’re eligible for Countdown Pages (album/EP)
- Launch the Countdown Page **as soon as it appears** in Spotify for Artists (it can show up within ~72 hours after metadata is delivered). citeturn3view2  
- Use a “waterfall” content plan: **single(s) → Clips → tracklist reveal → merch drop → final countdown**. Countdown Pages are designed for this. citeturn1view3turn3view1  
- Put the Countdown Page everywhere: artist profile placement + social sharing. citeturn5search15turn5search2  

### If you need 3rd-party pre-saves (singles / not eligible)
Under the hood, most “pre-save” tools do some version of:
- OAuth consent requesting **`user-library-modify`**
- On (or right after) release time, call Spotify Web API to **save the track/album into the user’s Library** citeturn4search0turn4search1turn4search3  

**2025 implementation rules of thumb:**
- Build on **Auth Code + PKCE** (do not use implicit). citeturn1view1turn1view2  
- Request the **minimum scope** (`user-library-modify`) and be explicit about what you’re doing.
- Treat token storage + consent as a security product (because Spotify is enforcing it harder now). citeturn1view2turn3view0  

---

## What majors are doing (patterns you can copy)
Spotify says that since Countdown Pages launched (summer 2024), **60% of major artists** have used them. citeturn3view1  
Tactically, the major-label playbook looks like:
- **Make Countdown Pages the canonical pre-save** (on-platform, less friction)
- Stack **Clips + Fans First-style merch moments + tracklist reveals** to create repeat touchpoints before release citeturn3view1turn3view2  
- Use Spotify’s visibility layers: **Upcoming Releases hub** + “Top 10 Countdowns / Countdown Charts” dynamics citeturn3view1turn3view2  
- Then convert on/after release with paid in-platform tools (where eligible), e.g., **Marquee/Showcase**. citeturn5search0turn5search6  

---

If you tell me whether you’re asking as **(a) an artist/label planning campaigns** or **(b) a developer building pre-save tooling**, I’ll give you a tighter, step-by-step 2025 playbook for that path (including the exact scopes/flows + what to avoid).

---

## User

Is it worth building preserves into our link in bio product for musicians?

---

## Assistant

Mr. White — **it can be worth it**, but in 2025 “pre-save” is **table-stakes** in music smart links *and* it comes with real security/compliance overhead. The right move depends on whether you’ll build a **real pre-save engine** or just support **native pre-release destinations**.

## Reality check: you’re entering a crowded, expectation-driven feature
Major smart-link players already market **Spotify pre-save + Apple Music pre-add** as a core feature (Linkfire, Feature.fm, ToneDen). citeturn0search3turn1search0turn1search1  
So if you’re competing for “release marketing” budgets, **not having it can lose deals**.

## But Spotify also “went native,” which changes what’s worth building
Spotify’s **Countdown Pages** now do the best version of pre-save *natively* (push notify + auto-add to Library). citeturn0search0turn0search4  
However, they’re **limited**: artists need **≥5,000 monthly active listeners**, and it’s for **albums/EPs** (not singles). citeturn0search0turn0search12  
That means third-party pre-saves are still relevant, especially for **singles** and smaller artists.

## The real cost: OAuth + token storage got stricter in 2025
If you implement Spotify pre-save the classic way (OAuth → on release day “Save to Library”), you’re taking on:
- **Secure OAuth requirements**: Spotify is removing **Implicit Grant**, disallowing **HTTP redirect URIs**, etc. (hard break if you cut corners). citeturn0search1turn0search9turn0search13  
- **Refresh-token handling**: access tokens expire (~1 hour) and you’ll need refresh tokens to “save on release day.” citeturn1search7  
- **Scopes + user trust**: you’ll request `user-library-modify` and call “Save Tracks/Albums” endpoints. citeturn0search2turn0search18turn0search6  
- **Policy obligations**: you must provide an easy way for users to disconnect and control stored data. citeturn1search3  

## So… should you build it?
### Build it **if** you want to win “release campaigns” (and can do it right)
It’s worth it when:
- Your customers are actively running releases (labels, managers, serious indies).
- You can monetize it (bundle into a “Release Mode” tier) and it improves retention.
- You’re willing to operate a secure OAuth + job system (release-day execution, retries, logging, data deletion).

### Don’t build full OAuth pre-save **if** you’re a lightweight link-in-bio
If your product is mostly a profile hub (not a campaign tool), the feature can become:
- A support burden (“my pre-save didn’t work”)
- A compliance/security risk (tokens + scopes)
- A low-ROI checkbox (especially if many users can just use Countdown Pages / Apple pre-add links)

## A pragmatic path that usually wins
1) **“Native-first” pre-release support (cheap, high value)**
   - Detect and surface Spotify **Countdown Page** links when eligible. citeturn0search4turn0search0  
   - Support **Apple Music pre-add** links (first-party behavior). citeturn1search2turn1search6  
   - Add countdown, tracklist, email/SMS capture, pixels, auto-switch “Pre-save” → “Listen now” on release day (users expect this). citeturn1search0  

2) **Offer Spotify OAuth pre-save only for cases where native doesn’t cover**
   - Singles, non-eligible artists, or “one link for all services.”
   - Implement **Auth Code + PKCE only** (no legacy shortcuts). citeturn0search5turn0search1  

3) **Skip (or postpone) “future saves/subscriptions”**
   - Competitors push it (Linkfire/Feature.fm), but it’s the highest trust + compliance burden because it implies ongoing access. citeturn0search7turn0search19  

If you tell me your product’s current positioning (bio hub vs release marketing suite) and your typical customer (indie DIY vs label/manager), I’ll give you a clear “build / partner / link-out” recommendation and a minimal spec that avoids the common OAuth traps.


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_ai-resume-builders-2025]]
- [[chatgpt/chatgpt_best-auth-providers-2025]]
- [[chatgpt/chatgpt_dashcam-value-2025]]
- [[chatgpt/chatgpt_justin-hailey-news-2025]]
- [[chatgpt/chatgpt_mac-buyer-options-2025]]
