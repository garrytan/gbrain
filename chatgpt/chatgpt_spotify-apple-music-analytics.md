---
conversation_id: 694f46bf-b57c-832d-90b4-1011c906c489
created: 2025-12-27
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: Spotify Apple Music Analytics
type: note
updated: 2025-12-27
---

# Spotify Apple Music Analytics

**Related:** [[jovie_music]]

> Conversation ID: 694f46bf-b57c-832d-90b4-1011c906c489
> Created: 2025-12-27T02:39:08Z
> Updated: 2025-12-27T02:41:14Z
> Messages: 4

---

## User

Can we get analytics from spotify and Apple Music over api?

---

## Assistant

Yes—but **it depends what kind of “analytics” you mean (artist/label performance vs. a listener’s personal stats)**.

### Spotify
- **Spotify Web API (public)**: good for **catalog + discovery metrics** (artist/track metadata, “popularity” score, followers, top tracks, etc.), **not** for true **streams/listeners-by-day, geography, demographics, saves rate, playlist performance**. citeturn0search0turn0search21  
- **Spotify for Artists analytics** exist in the dashboard, but **there’s no public Spotify for Artists analytics API**. citeturn0search2turn0search6  

### Apple Music
- **Apple Music API / MusicKit (public)**: mostly **catalog + user library**. It does **not** provide global “how many streams did this song get” style analytics.
- **MusicKit can expose a user’s own play counts** for tracks/videos (i.e., *that user’s* play count), with the right user permissions. citeturn0search16turn0search9  
- **Apple Music Analytics API (partner/label-focused)**: Apple has a **Music Analytics API** that returns **aggregated/anonymized listeners and plays** across dimensions—but it’s **not generally public**; availability is tied to Apple’s partner programs/eligibility (e.g., Apple describes availability for labels above a plays threshold). citeturn0search1turn0search15  

If you tell me whether you’re trying to build **(a)** an artist/label analytics product or **(b)** a consumer app showing *each user their own stats*, I can map the exact “official API path” + auth approach for each.

---

## User

Artists mostly listeners and play counts etc

---

## Assistant

For **artist-level “listeners + plays/streams”**, the two platforms aren’t symmetrical:

### Spotify
- **No, not via the public Spotify Web API.** Spotify’s developer API is mostly *catalog + user-permissioned playback/library stuff*—it does **not** expose official per-track/artist **stream counts** or **daily listeners**. citeturn0search0turn0search17  
- **There’s also no public “Spotify for Artists analytics API.”** Spotify staff/community mods have repeatedly said it isn’t public; “Provider APIs” exist but are **only for parties with direct distribution/partner access** (not typical app developers). citeturn0search21turn0search17  

**Practical implication:** to get Spotify streams/listeners “officially,” you usually need to ingest them from **distributor/label reporting** (or be an approved provider partner). Spotify Charts stream counts exist, but only for charted tracks, not full analytics.

### Apple Music
- **Yes, but it’s partner-gated:** Apple has a **Music Analytics API** that produces **aggregated, anonymized counts of listeners and plays** across dimensions (time/territory/etc.). citeturn0search2turn0search4  
- Separately, **Apple Music for Artists** shows plays + daily listeners in the dashboard (the API is what partners use to pull analytics programmatically). citeturn0search5turn0search9  

### If you’re building an artist analytics product
- **Apple Music:** pursue Music Analytics API access (partner onboarding). citeturn0search4turn0search2  
- **Spotify:** plan on **distributor/label ingestion** (or provider partnership). There isn’t a clean public API route for streams/listeners. citeturn0search21turn0search0  

If you tell me your situation (Mr. White)—**are you the label/distributor, or building a SaaS where artists connect their accounts?**—I can outline the most realistic integration architecture for each.


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_apple-music-affiliate-program]]
- [[chatgpt/chatgpt_apple-music-overview]]
- [[chatgpt/chatgpt_apple-music-profile-ux]]
- [[chatgpt/chatgpt_apple-music-style-guide-part1]]
- [[chatgpt/chatgpt_apple-music-style-guide-part2]]
