---
title: "Spotify playcount API limitations"
type: note
created: 2026-01-26
updated: 2026-01-26
source: chatgpt-export
conversation_id: 6977bfb5-fd2c-8327-8323-a2a555515375
message_count: 4
tags: [chatgpt, import]
---
# Spotify playcount API limitations

> Conversation ID: 6977bfb5-fd2c-8327-8323-a2a555515375
> Created: 2026-01-26T19:25:43Z
> Updated: 2026-01-26T19:26:24Z
> Messages: 4

---

## User

get spotify playcount over api

---

## Assistant

Mr. White,

Short answer: **you can’t get true Spotify play counts via the official API**.

### What the **entity["company","Spotify","music streaming company"] Web API** actually provides
- **Track `popularity`** (0–100): a *relative* score based on recent plays + recency weighting.  
- **Artist `followers.total`**: follower count, *not* plays.  
- **Your own streams**: only for the authenticated user (recently played, top tracks), not global counts.

There is **no endpoint** for:
- Total plays per track  
- Daily/weekly play counts  
- Historical play time series  

This is by design.

### Common workarounds (none are perfect)
1. **Scraping Spotify UI**  
   - Desktop/web client sometimes shows play counts for popular tracks.  
   - ❌ Violates Spotify ToS. Risky.

2. **Third-party datasets / APIs**  
   - Examples: Chartmetric, Soundcharts, Kworb.  
   - ✔ Aggregated estimates  
   - ❌ Paid, indirect, not official

3. **Infer via popularity over time**  
   - Poll `track.popularity` daily and model deltas.  
   - ✔ ToS-safe  
   - ❌ Only relative, noisy, non-linear

### If you need real numbers
- **Spotify for Artists** gives *your own* tracks’ play counts (UI + limited export).
- For research or products, you typically need **licensed analytics providers**.

### Bottom line
- **Official API ≠ play counts**
- **Only popularity proxies are available**
- **Exact counts require UI access or paid third parties**

If you want, I can:
- Show example API calls for `popularity`
- Help design an inference model
- Compare third-party providers (cost vs accuracy)

---

## User

how does chatmetric do it

---

## Assistant

Mr. White,

Services like **Chartmetric** don’t get official Spotify play counts from a hidden API — they **aggregate and infer data** from multiple sources over time. Here’s how they do it, factually:

### 1) **Large-scale aggregation of public data**
Chartmetric continuously crawls and ingests data from many channels, not just Spotify. Their dataset includes:
- **Spotify metrics** visible via the official API (popularity index, followers, monthly listeners, playlist info, etc.). citeturn0search2turn0search1
- **Playlist placements** and playlist metadata (e.g., which playlists a track is on and follower counts of those playlists). citeturn0search2
- **Other platforms** like YouTube, Apple Music, TikTok, radio airplay, and social networks. citeturn0search2

They **store this data over time** in their own database so they can show historical trends.

### 2) **Estimating stream trends**
While they *cannot* access Spotify’s real play counts for all tracks directly:
- For some **top artists** they maintain more frequent track streaming updates. citeturn0search9
- For others, they update less frequently (e.g., monthly). citeturn0search9
- They **infer performance** by combining:
  - Playlist reach (playlists * follower counts)
  - Changes in Spotify popularity scores
  - Followers and monthly listener trends
  These act as proxies for how many people are likely streaming a track and how that changes over time. citeturn0search32

### 3) **Proprietary scoring & modeling**
Chartmetric doesn’t just display raw data — they build models that:
- Normalize metrics across platforms  
- Weight recent performance more heavily  
- Create composite “track scores” and “artist scores” that reflect relative momentum and reach, not absolute play counts. citeturn0search32

### 4) **Historical time series**
By storing daily snapshots of the above signals, they can show **trends over time** (e.g., estimated daily streams rising or falling) even though exact Spotify play counts aren’t available via any official API.

### Limitations
- These are **estimates and proxies**, not guaranteed actual stream counts.  
- Chartmetric shows real Spotify **popularity index** where available (from Spotify API) but the underlying play count inference is proprietary. citeturn0search1

If you want to replicate something similar yourself without Chartmetric, the closest legal method is to:
1. Regularly poll the **Spotify Web API** for popularity/follower/listener data.  
2. Track playlist placements and playlist follower counts.  
3. Store and analyze these over time to approximate trends.

That’s essentially what analytics platforms do under the hood — they combine **official API outputs with large-scale, repeated data collection** and their own models.


**Topic:** [[chatgpt-clusters/jovie_music]]
