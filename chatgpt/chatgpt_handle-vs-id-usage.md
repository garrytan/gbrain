---
title: "Handle vs ID usage"
type: note
created: 2025-08-20
updated: 2025-08-20
source: chatgpt-export
conversation_id: 68a526ae-2370-832c-853d-ff3a444dedb5
message_count: 2
tags: [chatgpt, import, code]
---
# Handle vs ID usage

> Conversation ID: 68a526ae-2370-832c-853d-ff3a444dedb5
> Created: 2025-08-20T01:37:16Z
> Updated: 2025-08-20T01:37:37Z
> Messages: 2

---

## User

Based on what you know of Joby, I'm just looking at our seed file, like, seeds in, based on handles. So it's like, here's the Apple Music URL from artist for a handle is Rihanna. Is that going to cause issue if we don't use IDs?

---

## Assistant

Mr. White — short answer: yes, relying on handles will bite you. Use platform IDs.

Why handles break:
- Not unique, can change, get reused; casing/Unicode/emoji variants collide.
- Apple Music paths are localized/SEO’d (`/artist/rihanna/63346553`) and can change; the **numeric artist ID** is the stable key.
- Spotify “names” are non-unique; the **artist ID** is the stable key.
- Redirects/renames = silent data drift in your seed lookups & caches.

Do this instead:
- Store a stable **provider_id** per platform and treat the handle as display-only.
- Parse and persist the ID from the URL at seed time (e.g., Apple Music last path segment numeric; Spotify base62 after `spotify:artist:` or in the URL).
- Make your code path “handle → once-off resolve → ID,” then operate **only** on IDs.

Minimal seed shape:
```json
{
  "handle": "rihanna",
  "display_name": "Rihanna",
  "profiles": {
    "apple_music": {
      "id": "63346553",
      "url": "https://music.apple.com/.../artist/rihanna/63346553",
      "storefront": "us"
    },
    "spotify": {
      "id": "2wY79sveU1sp5g7SokKOiI",
      "url": "https://open.spotify.com/artist/2wY79sveU1sp5g7SokKOiI"
    }
  },
  "image_url": "https://…",
  "type": "Artist"
}
```

Migration plan (fast):
1) Add `profiles.apple_music.id` and `profiles.spotify.id`.  
2) Backfill by parsing existing URLs; verify 200/OK & canonicalize.  
3) Enforce “ID required” at ingest; keep handle optional.  
4) In queries, key on IDs; only show handles in UI.

Net: keep your own **handle** for `jov.ie/<handle>`, but **never** use it to talk to Apple/Spotify—use their IDs.


## See Also
- [[chatgpt/chatgpt_clarification-on-handle]]
- [[chatgpt/chatgpt_handle-cell-navigation-event]]
- [[chatgpt/chatgpt_handle-claim-strategy]]
- [[chatgpt/chatgpt_handle-missing-backend-data]]
- [[chatgpt/chatgpt_toilet-handle-issue-fix]]
