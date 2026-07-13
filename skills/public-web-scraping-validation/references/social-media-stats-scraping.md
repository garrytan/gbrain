# Social media video-stat scraping notes

Context: evaluating an open-source/self-hosted service for extracting video statistics from YouTube, TikTok, and Instagram. The durable lesson is not that any one tool is permanently broken; the lesson is that these platforms require a live field-level validation matrix before committing to an architecture.

## Candidate classes

| Candidate | Scope | Use |
|---|---|---|
| `yt-dlp` | Broad media extractor: YouTube, TikTok, Instagram, many others | First-pass URL-to-metadata adapter. Good for quick MVP and YouTube/TikTok when proxy/session assumptions are satisfied. |
| YouTube Data API | Official YouTube stats | Stable path for `statistics.viewCount` when API key/quota is acceptable. |
| `youtubei.js` | Unofficial YouTube InnerTube client | Node/TS fallback when official API is not desired. |
| `TikTokApi` | Unofficial TikTok API wrapper | TikTok fallback; usually needs browser/session/cookies/proxy assumptions. |
| Cobalt-style raw extractors | Downloader internals for TikTok/Instagram/VK/YouTube | Inspect raw service responses. A downloader may ignore stats adjacent to media URLs. |
| `Douyin_TikTok_Download_API` | Self-hosted TikTok/Douyin API/downloader | Worth testing as a prebuilt TikTok adapter, not as a guarantee. |
| `Instaloader` | Instagram metadata/downloader | Instagram fallback; may need login/session. Has `video_view_count` / `video_play_count` properties when metadata is accessible. |
| `instagrapi` | Instagram private/mobile API | Powerful but operationally fragile: account trust, device state, challenge handling, proxies. |
| `gallery-dl` | Broad gallery/media downloader | Useful secondary extractor, especially for Instagram/TikTok media, but validate stat fields. |
| Apify catalogs | Hosted actor discovery | Not implementation; often affiliate indexes. Treat as paid fallback discovery only. |

## Field-tested cobalt-style patterns

### TikTok rehydration JSON

Cobalt's TikTok downloader fetches a video page and parses embedded rehydration JSON for media URLs. The same object often carries stats.

Probe shape:

```text
GET https://www.tiktok.com/@i/video/<video_id>
# or canonical https://www.tiktok.com/@<username>/video/<video_id>
parse <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
detail = data["__DEFAULT_SCOPE__"]["webapp.video-detail"].itemInfo.itemStruct
stats = detail.statsV2 || detail.stats
```

Useful fields:

```json
{
  "views": "stats.playCount",
  "likes": "stats.diggCount",
  "comments": "stats.commentCount",
  "shares": "stats.shareCount",
  "saves": "stats.collectCount"
}
```

Live validation lesson: if TikTok returns a shell/about page or `webapp.video-detail` only has `statusCode/statusMsg`, do not conclude the parser is wrong. Try a recent public URL and the intended proxy/session assumptions. In one validated run, a residential/mobile-style proxy changed TikTok from missing rehydration data to a valid response; both `yt-dlp --proxy` and direct cobalt-style parsing returned matching stats for a fresh public video.

### Instagram mobile + browser paths

Cobalt's Instagram downloader tries multiple sources:

1. `https://i.instagram.com/api/v1/oembed/?url=https://www.instagram.com/p/<shortcode>/` to resolve `media_id`.
2. `https://i.instagram.com/api/v1/media/<media_id>/info/` with Instagram mobile UA and optional cookies/bearer.
3. HTML embed / web page parsing.
4. Web GraphQL with dynamically extracted tokens and optional cookies.

Expected stats if raw objects are available:

```text
like_count
comment_count
play_count
ig_play_count
video_view_count
clips_play_count
view_count
```

Live validation lesson: anonymous/proxy-only Instagram may return likes/comments but no reel views; mobile media info can return `login_required`. Treat this as `PARTIAL` and request throwaway account cookies/session before claiming Instagram reel views are validated.

### VK in cobalt

Cobalt's VK support uses a cleaner anonymous API flow:

```text
auth.getAnonymToken
video.get
```

This explains why VK downloads can work without user auth. It is a useful pattern to look for, but TikTok/Instagram do not necessarily provide an equivalent public arbitrary-stats API.

## Proxy / credential handling

When the user provides proxy credentials:

- Test protocol modes (`socks5h`, `socks5`, `http`) because tools differ. Example: Chromium/Playwright may reject SOCKS5 auth but work through the same proxy in HTTP mode.
- Redact raw proxy/cookie/account credentials in logs, final messages, skill notes, and external memory.
- Verify with a simple IP endpoint, then run platform probes under the same proxy.
- Do not persist raw credentials; persist only the validated assumption (`proxy required`, `cookies required`, `session required`).

## Probe matrix pattern

Use representative user-supplied URLs where possible. For each URL and extractor, capture:

- `platform`
- `media_id`
- `title` / `author`
- required stat fields: `views`, `likes`, `comments`, `shares` as applicable
- auth state: no auth / cookies / API key / proxy / account session
- result: `validated`, `partial`, `failed`, `unknown`
- reason: `field_missing`, `auth_required`, `challenge`, `rate_limited`, `not_supported`, `stale_or_unavailable_url`, etc.

Example `yt-dlp` probe:

```bash
yt-dlp -J --skip-download --no-playlist "$URL" > out.json 2> err.log
python - <<'PY'
import json
j=json.load(open('out.json'))
print({k:j.get(k) for k in [
    'extractor_key','id','title','view_count','like_count','comment_count','repost_count','uploader','webpage_url'
]})
PY
```

Quick one-line smoke test:

```bash
yt-dlp --skip-download --no-playlist \
  --print '%(extractor_key)s\t%(id)s\tviews=%(view_count)s\tlikes=%(like_count)s\tcomments=%(comment_count)s' \
  "$URL"
```

Proxy variant:

```bash
yt-dlp --proxy "$PROXY_URL" --skip-download --dump-single-json "$URL" \
  | python - <<'PY'
import json, sys
j=json.load(sys.stdin)
print({k:j.get(k) for k in ['id','view_count','like_count','comment_count','repost_count','uploader']})
PY
```

## Architecture recommendation

Build an adapter-based resolver, not a single universal scraper:

```text
POST /stats { url }
  -> detect platform
  -> YouTube: official API if configured, else yt-dlp/youtubei.js
  -> TikTok: cobalt-style rehydration JSON with proxy/session, then yt-dlp, then TikTokApi/browser fallback
  -> Instagram: mobile media info / GraphQL with cookies, then Instaloader/instagrapi, then yt-dlp partial fallback
  -> normalize result with typed partial failures
```

Recommended response shape:

```json
{
  "platform": "instagram",
  "media_id": "...",
  "views": null,
  "likes": 981966,
  "comments": 15945,
  "confidence": "partial",
  "source": "yt-dlp",
  "reason": "view_count_not_exposed"
}
```

## Durable cautions

- YouTube is the easiest to make stable; official API is the clean path for video stats.
- TikTok can be validated via rehydration JSON / `yt-dlp` under proxy/session assumptions; stale/unavailable video URLs can produce misleading failures, so test fresh URLs too.
- Instagram arbitrary public reel views are still more fragile: anonymous/proxy-only paths may expose likes/comments but not views; expect cookies/session or owned-media official Graph API.
- Instagram official Graph API is strong for owned Business/Creator media, not arbitrary public reels.
- A scraper that downloads media is not necessarily a scraper that returns statistics — but its internal raw response may already contain stats.
- If the user wants high confidence, run the probe matrix before writing production code.
