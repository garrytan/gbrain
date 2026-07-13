# YouTube/TikTok/Instagram view-count extraction — July 2026 notes

## Practical shortlist

| Tool/API | Platforms | Self-hosted? | View metric field | Notes |
|---|---|---:|---|---|
| `yt-dlp` | YouTube, TikTok, Instagram, many others | Yes | `view_count` | Best MVP for `URL -> normalized metadata`; supports `--print`, `-j`, `--skip-download`; TikTok/IG can break and may need cookies/proxies. |
| YouTube Data API v3 | YouTube | Client only | `statistics.viewCount` | Official/stable. `videos.list?part=statistics&id=<VIDEO_ID>` costs low quota and returns view count. |
| `TikTokApi` Python | TikTok | Yes | `statsV2.playCount` or `stats.playCount` | Unofficial; Playwright/session based; may need `ms_token` and proxies. `video.info()` returns raw dict and assigns `self.stats = data.get("statsV2") or data.get("stats")`. |
| `Instaloader` Python | Instagram | Yes | `Post.video_view_count`, `Post.video_play_count` | Good for post/reel objects but fragile; login/cookies and rate limiting often needed. |
| Instagram Graph API Media Insights | Instagram owned/authorized professional media | Client only | `views`, `total_views` | Official. Requires Instagram/Facebook login + permissions. Not a general scraper for arbitrary public reels/posts. |
| TikTok Research API wrappers | TikTok research access | Client only | API-dependent video metrics | More official than scraping, but requires approved Research API access. |
| `imputnet/cobalt` internals | YouTube/TikTok/Instagram/VK downloads | Yes | Not surfaced by API; raw objects may contain stats | Useful as a downloader/extractor reference. TikTok/IG handlers parse raw service objects but discard engagement fields. Fork/adapter can expose them if raw JSON is reachable. |

## Useful command/snippet patterns

### yt-dlp normalized CLI

```bash
yt-dlp --skip-download \
  --print "%(extractor_key)s\t%(id)s\t%(view_count)s\t%(like_count)s\t%(comment_count)s\t%(webpage_url)s" \
  "https://..."
```

### yt-dlp JSON

```bash
yt-dlp -j --skip-download "https://..." \
  | jq '{platform: .extractor_key, id: .id, views: .view_count, likes: .like_count, comments: .comment_count, url: .webpage_url}'
```

### TikTokApi field path

```python
info = await api.video(url=url).info()
stats = info.get("statsV2") or info.get("stats") or {}
views = stats.get("playCount")
```

### Instaloader field path

```python
post = instaloader.Post.from_shortcode(L.context, shortcode)
views = post.video_view_count
plays = post.video_play_count
```

### Cobalt-style TikTok raw path

Cobalt fetches `https://www.tiktok.com/@i/video/<postId>` and parses:

```js
const json = html
  .split('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">')[1]
  .split('</script>')[0];
const data = JSON.parse(json);
const detail = data["__DEFAULT_SCOPE__"]["webapp.video-detail"].itemInfo.itemStruct;
const stats = detail.statsV2 || detail.stats || {};
const views = stats.playCount;
```

This may need residential/mobile proxy and/or TikTok cookies; if the HTML lacks `__UNIVERSAL_DATA_FOR_REHYDRATION__`, do not pretend the method works in that environment.

### Cobalt-style Instagram raw paths

Cobalt's IG handler tries several routes:

```text
i.instagram.com/api/v1/oembed/?url=https://www.instagram.com/p/<shortcode>/
i.instagram.com/api/v1/media/<media_id>/info/
https://www.instagram.com/p/<shortcode>/embed/captioned/
https://www.instagram.com/graphql/query
```

Useful stat fields in raw mobile/web nodes, when available:

```text
like_count
comment_count
play_count
ig_play_count
video_view_count
clips_play_count
view_count
```

Anonymous `media/<id>/info/` commonly returns `403 login_required`; use throwaway cookies/session for proof runs.

## Repo sanity-check case: `cporter202/social-media-scraping-apis`

Verdict: **not a library and not self-hosted scraping code**. It is a static/auto-generated catalog of Apify actors.

Evidence found:

- GitHub repo has only a few commits and static/generated markdown tables plus generator/settings files.
- README advertises “3,268 APIs” and links entries to `https://apify.com/{author}/{slug}?fpr=p2hrc6`.
- DeepWiki summary says the catalog files are static Markdown generated from `settings/apify_actors.json`; scraping logic runs on Apify, not in the repo.
- Entries are mixed-quality and broad, including unrelated/growth-hack items like YouTube view generators and AI copy/episode idea tools.

How to present it to the user:

> Это не либа и не self-hosted scraper. Это рекламный/affiliate каталог Apify actors. Его можно использовать как источник названий paid actors, но не как dependency и не как готовую self-hosted реализацию.

## Cobalt inspection notes

Repo: `imputnet/cobalt` commit `a636575` (checked July 2026).

- `api/src/processing/services/tiktok.js` resolves short links, fetches `@i/video/<postId>`, parses `__UNIVERSAL_DATA_FOR_REHYDRATION__`, then extracts media URLs from `itemStruct.video.playAddr`, `itemStruct.music.playUrl`, and `itemStruct.imagePost.images`. The same `itemStruct` normally carries `stats`/`statsV2`, but cobalt discards these because it is a downloader.
- `api/src/processing/services/instagram.js` tries oEmbed → mobile media info → HTML embed → GraphQL, optionally with cookies/bearer. It extracts media URLs from `video_versions`, `video_url`, `image_versions2`; raw nodes may include play/view fields.
- `api/src/processing/services/vk.js` uses a public-ish anonymous VK Video flow: `auth.getAnonymToken` + `video.get` with VK Video iOS UA. This explains VK downloads and is a useful pattern to look for elsewhere, but TikTok/IG do not expose an equally stable arbitrary-public stats API in these findings.
- Public cobalt API docs mark TikTok/Instagram metadata as unavailable/unreasonable; treat cobalt as a code reference/fork base, not an out-of-box stats endpoint.

## Low-star repo leads worth checking

Low stars should not disqualify repos during a “full probe”; inspect for concrete endpoint/header/intercept patterns.

| Repo | Signal | Verdict |
|---|---|---|
| `AlbertoQuian/instagram-tiktok-scraper` | Instagram Playwright intercepts `web_profile_info`/GraphQL and maps `video_view_count`, `view_count`, `play_count`, `ig_play_count`, `clips_play_count`; TikTok uses `yt-dlp` `.info.json` and maps `view_count`/likes/comments/shares. | High-signal reference; not proof until run against target URLs. |
| `erenmyeager15/tiktok-profile-scraper` | Crawlee/Playwright actor parses TikTok rehydration JSON for profile data and intercepts `post/item_list` or `item/list` XHR, mapping `stats.playCount`, `diggCount`, `commentCount`, `shareCount`. | Good pattern for profiles/feeds; actor code may be disabled/under-maintenance. |
| `plat-09/tiktok-instagram-scraper` | TikTok Playwright page content regex for `diggCount`/`playCount`/`commentCount`; IG mobile shortcode info endpoint with cookies. | Useful minimal pattern; cookie-dependent. |
| `yassa-life/Reach_Scraper` | YouTube official API; IG via Instaloader; TikTok regex over rehydration JSON. | Snippet source, not production-ready. |
| `AbyatarFL/instagram-reels-scraper` | Selenium GUI for IG Reels view counts. | Potentially useful but heavy; needs runtime verification. |
| `Marcoslaurenz/INFLUSCRAPER` | Claims total views for TikTok/Instagram/YouTube but includes hardcoded IG credentials and crude parsing. | Do not use directly; security/quality bad. |
| `thirdwatch-dev/tiktok-scraper` | README claims stats but repo lacks implementation. | Not useful. |

## Proof-run matrix for “make it work” asks

When the user wants a definitive working stack, ask for the missing operational inputs rather than guessing:

1. Residential/mobile HTTP(S) or SOCKS proxy, preferably US/EU and region-stable.
2. TikTok `ms_token` or full cookies export from a throwaway browser session if proxy alone fails.
3. Instagram cookies/session from a throwaway account.
4. Test URLs: at least 3 YouTube, 3 TikTok, 4 Instagram/Reels.

Run adapters in this order:

```text
YouTube:
  YouTube Data API -> yt-dlp -> YouTube.js/cobalt internals

TikTok:
  yt-dlp with proxy/cookies -> cobalt-style rehydration JSON stats -> TikTokApi with ms_token/proxy -> Playwright intercept item_list/webapp.video-detail

Instagram:
  cookies/session mobile media info -> Playwright web_profile_info/GraphQL intercept -> instaloader/instagrapi with session -> yt-dlp partial fallback
```

Return normalized results with source and confidence instead of pretending every platform always has views:

```json
{
  "platform": "tiktok",
  "id": "...",
  "views": 123,
  "likes": 45,
  "comments": 6,
  "source": "rehydration_json",
  "confidence": "high",
  "reason": null
}
```

## Recommendation pattern

For a real service that extracts view counts from arbitrary URLs:

```text
POST /resolve { url }
→ detect platform by hostname
→ YouTube: official API if configured, else yt-dlp
→ TikTok: proxy/cookie-aware adapter chain, not one extractor
→ Instagram: session/cookie-aware adapter chain; Graph API only for owned authorized media
→ normalize: { platform, media_id, views, likes, comments, collected_at, source, confidence, reason }
```

## Instagram Reels views — self-hosted path after July 2026 probe

When the user rejects dependence on hosted vendors, do **not** keep pushing Bright Data/Apify/Oxylabs. Keep them as disabled-by-default emergency fallback only. The durable self-hosted strategy is: own IG read accounts + stable proxy/device/session + private/mobile or authenticated-web endpoints.

### What was verified / learned

- Anonymous single-shortcode GraphQL can be useful for media metadata, owner id, likes/comments, caption, and video URLs, but may return `view_count: null` for Reels. Do not treat it as a reliable views source.
- The visible Reels counter is usually closer to `play_count` / `video_play_count`, not generic `view_count`.
- `instagrapi` is the strongest self-hosted candidate because current source has `user_clips_v1()` / `user_clips_paginated_v1()` calling private mobile endpoint `clips/user/` and mapping:

```python
media["view_count"] = media.get("view_count", media.get("video_view_count", 0))
media["play_count"] = media.get("play_count", media.get("video_play_count", 0))
```

- Profile Reels GraphQL connection is the other strong path:

```text
xdt_api__v1__clips__user__connection_v2
PolarisProfileReelsTabContentQuery
PolarisProfileReelsTabContentQuery_connection
media.play_count
```

- Logged-out browser/proxy alone may not trigger the useful profile Reels GraphQL response; expect to need a real throwaway IG session.
- Avoid purchased session/cookie marketplaces. They are operationally risky, likely stolen/unstable, and do not fit an OSS/self-hosted product story.

### Links worth keeping

- `instagrapi`: https://github.com/subzeroid/instagrapi
- instagrapi media docs: https://subzeroid.github.io/instagrapi/usage-guide/media.html
- instagrapi session/proxy best practices: https://subzeroid.github.io/instagrapi/usage-guide/best-practices.html
- instagrapi `play_count` issue context: https://github.com/subzeroid/instagrapi/issues/1117
- Authenticated Reels GraphQL reference: https://github.com/Boualam3/Instagram-Reels-Scraper
- Playwright response-intercept reference: https://github.com/YoppaV/instagram-mcp
- Anonymous shortcode GraphQL reference/fallback: https://github.com/seotanvirbd/Instagram-Reel-Scraper

### Recommended adapter chain

```text
IG URL -> shortcode
  1. anonymous oEmbed / shortcode GraphQL
     - collect media_id / owner_id / username / likes / comments when available
     - do not rely on views here
  2. instagrapi private mobile API with own warmed session
     - user_id_from_username(owner_username)
     - user_clips_v1(owner_id, amount=N)
     - match shortcode -> play_count, like_count, comment_count
  3. authenticated Playwright/Selenium intercept fallback
     - open /<username>/reels/
     - capture PolarisProfileReelsTabContentQuery(_connection)
     - parse xdt_api__v1__clips__user__connection_v2.edges[].node.media.play_count
  4. yt-dlp / Instaloader partial fallback
     - return likes/comments/media metadata; views may be null
  5. paid vendor fallback only if explicitly enabled
```

### Minimal proof snippet for own-session path

```python
from instagrapi import Client

cl = Client()
cl.set_proxy("http://USER:PASS at proxy.example.invalid:8080")
cl.login(USERNAME, PASSWORD)          # first run
cl.dump_settings("ig-session.json")   # reuse stable device/session

user_id = cl.user_id_from_username("target_username")
clips = cl.user_clips_v1(user_id, amount=24)
for m in clips:
    print(m.code, m.play_count, m.view_count, m.like_count, m.comment_count)
```

Production hygiene:

- one stable proxy/IP per IG account;
- reuse saved settings/device identifiers;
- warm new accounts gradually;
- read-heavy only, no likes/follows/DMs/uploads from scraping accounts;
- back off/freeze account on `LoginRequired`, challenge, `429`, `PleaseWaitFewMinutes`, or `FeedbackRequired`.

Be explicit with the user: YouTube can be stable; TikTok/Instagram require a proof run with proxy/cookies/own sessions before making “works reliably” claims.

