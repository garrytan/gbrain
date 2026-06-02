---
conversation_id: 692dee71-7284-832c-9a74-590c6e487581
created: 2025-12-01
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Spotify API limitations
type: note
updated: 2025-12-02
---

# Spotify API limitations

**Related:** [[jovie_music]]

> Conversation ID: 692dee71-7284-832c-9a74-590c6e487581
> Created: 2025-12-01T19:37:22Z
> Updated: 2025-12-02T19:18:04Z
> Messages: 2

---

## User

So we're building Jovi, which is like basically a link tree specifically for music creators that's more polished and smarter and uses AI to create magical experiences. So one thing I'm thinking about is like, what if during the onboarding or whatever, you know, we were thinking about like, okay, you connect your Spotify account and you connect your Apple Music account or something. Or you at least tell us like your Spotify user, you have a search bar and you like pick your name on Spotify and we can then like pull in your Spotify profile and Apple Music profile and auto-populate stuff maybe. But then I'm thinking like beyond that, like it'd be great to like pull in their existing discography of music, identify like their music and stuff and just have that in the background. We can do stuff with it later. But one thing I'm thinking about is like, I want to make like link fire style links for their new songs and stuff. What if we had the ability to know that they have a new song coming out before it comes out and email them to be like, hey, your new song, you know, called whatever is coming out. We've already prepared a page for it, a special smart link for it. Here it is to share it. And what I was thinking is on the artist back end, it already has that in the system. When songs are coming out, if they've already been distributed to Spotify, is there a way that we could through the Spotify API or Apple Music API or something like that kind of detect that they've distributed a song to Spotify that has not been released yet and get the ISRC code and the release date. So that we can kind of do that.

---

## Assistant

Short version:  

- You **can’t reliably see “just-distributed but not yet in catalog” tracks** via the public Spotify or Apple Music APIs. That info lives in Spotify for Artists / Apple Music for Artists / distributors, not in the open APIs. citeturn0search0turn0search18  
- You **can** reliably detect tracks **once they appear in the public catalog**, including pre-release/pre-add content, and at that point you can grab **ISRC + release date** and auto-make smart links. citeturn0search13turn0search20turn0search23turn0search4  

So the “we magically prepared your link before release” experience is definitely doable — but the timeframe is **from the moment the release hits the catalog** (pre-save / pre-add) onward, not from the instant they upload to DistroKid or whatever.

---

## 1. What Spotify will and won’t give you

### What you *can* do

Once a track is in Spotify’s public catalog (including pre-release objects for some pre-save / countdown setups):

- You can fetch **albums/singles by artist**:  
  `GET /artists/{id}/albums?include_groups=single,album`  
- For each album/single, you can fetch tracks.  
- For each track, `GET /tracks/{id}` returns:  
  - `external_ids.isrc` → ISRC  
  - `album.release_date` / `release_date_precision` → release date (Y / Y-M / Y-M-D) citeturn0search1turn0search13turn0search4  

So Jovi can:

1. Store the artist’s Spotify **artist ID** at onboarding.  
2. Run a background job every X hours:
   - Call `GET /artists/{id}/albums` and crawl all associated tracks.
   - For any track you haven’t seen before, inspect `album.release_date`.
3. If `release_date > today` → treat as **upcoming** and auto-generate a Jovi pre-release smart link.
4. If `release_date == today` → “your new song is out, here’s your link.”

That’s exactly how Linkfire-style pre-release flows work: they piggyback on the fact that the track/album has an ID in Spotify’s public catalog before full release, even if it’s not yet playable.

### What you *can’t* do (realistically)

- There is **no public Spotify “Spotify for Artists” API** for normal third-party devs. Spotify explicitly says there’s no public S4A API; provider APIs are only for distributors/labels with direct deals. citeturn0search0  
- When the artist uploads to a distributor and the release is just “ingested” / pending, those objects live in **provider / ingestion systems**, not in the public catalog. You **do not see them** via the Web API.  
- There’s no endpoint like “give me all upcoming unreleased tracks for this artist.” You only see what the public catalog sees.

Also worth noting: Spotify tightened API access in late 2024 for new apps (related artists, curated playlists, etc.), so you definitely don’t want to architect Jovi around any gray-area endpoints or hacks. citeturn0news30

---

## 2. What Apple Music will and won’t give you

Apple splits things into:

- **Catalog** (public Apple Music)  
- **Library** (user’s personal library)

For your use case you care about the catalog.

### What you *can* do

Apple’s Music API exposes:

- `GET /v1/catalog/{storefront}/artists/{id}/albums` / `songs` → lists catalog content for the artist.  
- Song attributes include:  
  - `releaseDate` (may be in the **future** for prerelease) citeturn0search20  
  - `isrc` → ISRC (for catalog songs) citeturn0search23  

Apple explicitly notes that **prerelease songs may have an expected release date in the future** in this `releaseDate` field. citeturn0search20turn0search11  

So, same pattern as Spotify:

1. Store Apple Music **artist ID** for the user.  
2. Periodically call the catalog endpoints for that artist.  
3. Any song/album with `releaseDate > today` → mark as **upcoming** and create the pre-add / smart link.  
4. Once `releaseDate <= today`, flip to “live” mode in the Jovi link.

### What you *can’t* do

Same limitation as Spotify:

- You **don’t** get internal “just uploaded to distributor but not in Apple catalog yet” data.  
- You can only see things once Apple has created catalog objects (which is also when pre-add / pre-order normally exists).

---

## 3. How to design the “magic” flow in Jovi

Here’s a realistic architecture that gets you 90% of the magic without needing secret partner deals.

### Onboarding

1. User connects Spotify via OAuth → you get:
   - Their **user** info, but more importantly
   - They choose their **artist profile** from search or you associate their known artist ID.
2. Same thing for Apple Music (or they manually paste their Apple artist link; you parse ID).
3. Store:
   - `spotify_artist_id`
   - `apple_artist_id`
   - Preferred markets (US, etc.).

### Background watcher

For each artist you manage:

- **Frequency**: every few hours / once per day (tune later).  

**Spotify side**

- `GET /artists/{id}/albums?include_groups=single,album&limit=50` and paginate.  
- For each album/single:
  - If Jovi has never seen this Spotify album ID:
    - Fetch album → get `release_date`.
    - Fetch album tracks → grab each track ID.
    - For each track: `GET /tracks/{id}` → `external_ids.isrc`.
- Persist: `track_id`, `isrc`, `album_release_date`, `track_name`, `cover`, etc.

Then:

- If `album_release_date > today` → mark all tracks as **upcoming**.
- If `album_release_date == today` and `now - discovered_at < X days` → treat as **new release**.

**Apple side**

- `GET /v1/catalog/{storefront}/artists/{id}/albums` + `songs` (or walk via albums → tracks).
- Read `attributes.releaseDate` (may be future for prerelease). citeturn0search20turn0search23  
- Read `attributes.isrc`.

Same logic as Spotify: first time you see a new song with a future `releaseDate`, auto-create link.

### Jovi “magic email” logic

Whenever your watcher finds a **new upcoming track**:

1. Check if there is already a Jovi link for that combination of ISRC or (artist, title).
2. If not, auto-create:
   - A Jovi URL with:
     - Spotify pre-save / pre-add link if available.
     - Apple pre-add link.
     - Any other DSPs you support.
3. Fire an email like:
   > “We found your upcoming release ‘XYZ’ (out on March 3). Here’s your smart link, already set up for pre-save / pre-add.”

Then on release day, the same link just becomes a normal multi-DSP link.

---

## 4. Handling the earlier “distributor only” stage

If you truly want to react **before** the track is visible in catalog (like same day they upload to DistroKid):

You’re outside what Spotify/Apple alone can give you. Options:

1. **Distributor integrations (power move)**  
   - Partner with a distributor or two who already have access to Spotify/Apple provider APIs or their own scheduling metadata.  
   - They can push you webhooks when a release with Artist X is created (ISRC + release date included).  
   - You then create links even before catalog IDs exist; later, when Spotify/Apple IDs show up, you match via ISRC.

2. **Manual-but-guided Jovi flow (low friction)**  
   - In the Jovi dashboard, add “I’ve got a release coming up” flow:  
     - Ask for title, release date, ISRC or UPC.  
     - Optionally let them paste their future Spotify/Apple URLs when the distributor provides them.  
   - You then:
     - Use ISRC search to attach catalog objects as soon as they show up:  
       - Spotify search by ISRC (via `/search?q=isrc:XXX&type=track`). citeturn0search4  
       - Apple Music “Get multiple catalog songs by ISRC” endpoint. citeturn0search23  

3. **Hybrid**  
   - If they give you preliminary info (title, release date), you can poll Spotify/Apple searches by **ISRC or title+artist** to detect when it hits the catalog and then fire the “we prepared your link” email at that moment.

---

## 5. Practical bottom line

So if we answer your original question directly:

> “Is there a way through the Spotify API or Apple Music API to detect that they’ve distributed a song that has not been released yet and get the ISRC and release date?”

- **You can’t** reliably detect “just distributed, not yet in catalog anywhere” with public APIs. That’s provider-level data.  
- **You can**:
  - Automatically detect **pre-release / pre-add catalog entries** for an artist (releaseDate in the future).  
  - Pull **ISRC + releaseDate** for those songs. citeturn0search13turn0search20turn0search23turn0search4  
  - Use that to auto-build pre-save / smart links and send those “we already prepared your link” emails.

If you want, next step I can sketch a concrete data model + cron / worker design for Jovi (tables, fields, and how to key everything on ISRC so it stays robust across DSPs).

navlistSpotify API volatility & why to design defensivelyturn0news30


**Topic:** [[chatgpt-clusters/jovie_music]]
