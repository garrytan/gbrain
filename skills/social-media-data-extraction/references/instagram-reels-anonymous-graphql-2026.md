# Instagram Reels anonymous GraphQL stats path (2026)

Use this when researching lower-friction ways to get public Instagram Reels `views` + `likes` without immediately asking the user for cookies/session.

## Validated pattern

1. `GET https://www.instagram.com/reel/<shortcode>/` with a normal browser UA.
2. Keep the anonymous cookies from that response (`csrftoken`, `mid`) and extract transient request tokens from HTML:
   - `LSD` token if present;
   - `X-IG-App-ID` if present, otherwise fallback commonly observed: `936619743392459`.
3. `POST https://www.instagram.com/graphql/query` with form body:

```text
variables={"shortcode":"<shortcode>"}
doc_id=10015901848480474
lsd=<lsd-token-if-found>
```

Useful headers:

```text
User-Agent: normal desktop Chrome UA
Content-Type: application/x-www-form-urlencoded
X-IG-App-ID: <app_id>
X-ASBD-ID: 129477
X-FB-LSD: <lsd>
X-CSRFToken: <csrftoken>
Referer: https://www.instagram.com/reel/<shortcode>/
Origin: https://www.instagram.com
Sec-Fetch-Site: same-origin
```

## Fields to parse

Response shape seen in successful probes:

```text
data.xdt_shortcode_media.video_view_count
data.xdt_shortcode_media.video_play_count
data.xdt_shortcode_media.edge_media_preview_like.count
data.xdt_shortcode_media.edge_media_to_comment.count
data.xdt_shortcode_media.shortcode
data.xdt_shortcode_media.owner.username
```

Recommended normalization:

- `metrics.views = video_view_count` (closer to visible views)
- keep `video_play_count` in raw/diagnostics because it is often larger (plays/replays)
- `metrics.likes = edge_media_preview_like.count` (or `edge_media_to_like.count` if present)
- `metrics.comments = edge_media_to_comment.count`

## Live probe evidence from session

No login/cookies provided by the user; only anonymous page bootstrap:

| Shortcode | views (`video_view_count`) | plays (`video_play_count`) | likes | comments |
|---|---:|---:|---:|---:|
| `DOvzTywjPGN` | 111088 | 264856 | 11062 | 180 |
| `Chunk8-jurw` | 11140517 | 29676378 | 981945 | 15945 |
| `CtjoC2BNsB2` | 127205 | 378124 | 69281 | 118 |

The repo `ahmedrangel/instagram-media-scraper` exposed the useful `doc_id=10015901848480474` route. The older/Polaris-style `doc_id=24368985919464652` route returned likes/comments/media info but `view_count = null` in the same research. Do not collapse all anonymous GraphQL routes into one verdict.

## Caveats

- Reverse-engineered public web path: medium confidence, not official.
- Can break on `doc_id` changes, anti-bot, 403/429, missing LSD/cookie bootstrap, or regional/session differences.
- If this path fails, fallback to own warmed throwaway session with `instagrapi` (`user_clips_v1` / `clips/user`) before paid providers.
- Do not store raw cookies, proxy credentials, signed media URLs, or full HTML/JSON dumps in durable notes.
