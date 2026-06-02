---
title: "Artist Data via API"
type: note
created: 2026-02-08
updated: 2026-02-08
source: chatgpt-export
conversation_id: 6988d1e6-5bb8-832b-b7d1-a2aed64f985a
message_count: 4
tags: [chatgpt, import]
---
# Artist Data via API

> Conversation ID: 6988d1e6-5bb8-832b-b7d1-a2aed64f985a
> Created: 2026-02-08T18:12:09Z
> Updated: 2026-02-08T18:13:08Z
> Messages: 4

---

## User

Can we get any about data for artists over Spotify API or Apple Music like bio and hometown and years active etc

---

## Assistant

Yes, but **Spotify + Apple Music give you only a slice** of what you listed.

## Spotify Web API (artist metadata you *can* get)
From `GET /v1/artists/{id}`, you get things like:
- `name`, `id`, `uri`, `external_urls`
- `images`
- `genres` *(deprecated)*  
- `followers` + `popularity` *(deprecated, and slated as removed in Spotify’s Feb 2026 change log)* citeturn1view2turn1view3

**What you generally cannot get from Spotify Web API:**
- **Biography / bio text**
- **Hometown / origin**
- **Years active / formed date**
Spotify has long not exposed artist bios in the public Web API (devs have requested it for years). citeturn0search21

## Apple Music API (artist metadata you *can* get)
Apple Music’s catalog API supports artist resources and includes **“notes about the artist”** via `editorialNotes` (when available), plus basics like genre names. citeturn0search1turn0search6

**What you generally cannot get from Apple Music API:**
- **Hometown / origin**
- **Years active**
(Those aren’t standard Apple Music artist fields.)

## If you need bio + hometown + years active
In practice, people **merge streaming IDs with knowledge bases**, e.g.:
- **MusicBrainz** (artist area/origin, begin/end, type)
- **Wikidata / Wikipedia** (bio, hometown, years active)
- Sometimes **Last.fm** (bios), depending on licensing/terms

### Common approach
1) Search artist on Spotify/Apple to get stable IDs + links/images/genres. citeturn1view2turn0search1  
2) Resolve to MusicBrainz/Wikidata via name + external links/ISNI/URLs where possible.  
3) Pull bio/origin/years-active from those sources and store a merged “artist profile” in your DB.

If you tell me your target stack (Node/Python) and whether you want **global catalog** only or also **user-library context**, I can sketch the exact endpoint flow + data model.

---

## User

Can you confirm I get external urls?

---

## Assistant

Yes, **Spotify’s Artist object includes `external_urls`**.

- In `GET /v1/artists/{id}`, the response has `external_urls` (“Known external URLs for this artist”), and in practice it contains at least the `spotify` URL. citeturn0search0  
- The same `external_urls` field also appears in “simplified” artist objects returned inside other endpoints (tracks, albums, search results, etc.). citeturn0search2turn0search15  

One nuance: people often expect socials (Instagram/Twitter/etc.) there, but Spotify generally **only returns the Spotify link** in `external_urls`. citeturn0search18
