# Social video metadata MVP notes (2026-07)

Session-derived implementation notes for building a self-hosted social-video metadata/stats resolver for YouTube, TikTok, and Instagram/Reels.

## Product framing

- This class of project is a **metadata/stats resolver**, not a downloader.
- Do not name runtime code after reference implementations (e.g. no `*_cobalt_*` names). Use platform/path names such as:
  - `tiktok_web_rehydration_adapter`
  - `instagram_private_session_adapter`
  - `instagram_profile_reels_adapter`
  - `youtube_yt_dlp_adapter`
  - `youtube_official_api_adapter` (fallback/verification, not the dependency-light default)
- Reference projects can be cited in docs/research, but adapter/class/function names should describe the extraction path, not the project copied from.

## Default architecture

```text
YouTube:
  yt-dlp/public metadata extraction -> official YouTube Data API fallback/verification

TikTok:
  webpage rehydration stats via stable proxy -> yt-dlp metadata fallback

Instagram:
  own warmed throwaway IG session via private mobile API -> authenticated profile Reels GraphQL intercept -> anonymous partial metadata fallback
```

Paid scraper APIs and provider marketplaces (Bright Data/Apify/Oxylabs/etc.) are only explicit emergency fallbacks/comparison tools, not the default architecture. Bought Instagram session/cookie marketplaces should not be recommended as a foundation for an OSS/self-hosted service.

## YouTube details

For self-hosted/minimum-dependency products, do **not** make `YOUTUBE_API_KEY` a required foundation. Default to `yt-dlp` / public metadata extraction first and keep YouTube Data API v3 as an official fallback or verification source.

Recommended chain:

```text
youtube_yt_dlp_adapter -> youtube_official_api_adapter
```

Add a regression test for the default adapter order so future refactors do not silently make the API key primary again.

## Instagram details

Anonymous single-shortcode/oEmbed/GraphQL paths can provide media/owner/likes/comments but may return `view_count: null` for Reels. Do not fabricate views.

Primary self-hosted path:

- operator-owned warmed throwaway account(s);
- stable proxy/IP and stable device/session settings per account;
- `instagrapi` private mobile API;
- `user_clips_v1()` / `clips/user/`;
- map `play_count` or `video_play_count` to normalized `views`.

Fallback:

- authenticated browser context;
- open `/<username>/reels/`;
- intercept GraphQL responses:
  - `xdt_api__v1__clips__user__connection_v2`
  - `PolarisProfileReelsTabContentQuery`
  - `PolarisProfileReelsTabContentQuery_connection`
- match target shortcode and read `media.play_count`.

Anonymous partial fallback should be best-effort only and `confidence="partial"`.

## TikTok details

The useful pattern is not “download video” but reuse downloader-style page parsing to expose stats:

- fetch canonical public video page through stable proxy;
- parse `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">`;
- walk `__DEFAULT_SCOPE__ -> webapp.video-detail -> itemInfo -> itemStruct`;
- read `stats` or `statsV2`:
  - `playCount` -> views
  - `diggCount` -> likes
  - `commentCount` -> comments
  - `shareCount` -> shares
  - `collectCount` optional raw.

`yt-dlp` can be a fallback metadata extractor with proxy/session.

## Config pitfall

Do not model proxy env vars as `HttpUrl`; that rejects or complicates SOCKS/SOCKS5H strings. Use `str | None` and pass raw strings to the consuming library.

Typical env surface:

```text
YOUTUBE_API_KEY=
YOUTUBE_API_ENABLED=true
HTTP_PROXY_URL=
TIKTOK_PROXY_URL=
INSTAGRAM_PROXY_URL=
INSTAGRAM_USERNAME=
INSTAGRAM_PASSWORD=
INSTAGRAM_SETTINGS_PATH=
INSTAGRAM_SESSION_DIR=
INSTAGRAM_CLIPS_LOOKBACK=48
```

## Response shape

Normalize partiality honestly:

```json
{
  "url": "https://...",
  "platform": "youtube|tiktok|instagram|unknown",
  "id": "...",
  "metrics": {
    "views": 123,
    "likes": 45,
    "comments": 6,
    "shares": null,
    "reposts": null
  },
  "source": "adapter-name",
  "confidence": "high|medium|low|partial",
  "reason": "human-readable explanation",
  "raw": {}
}
```

Sanitize `raw`: never expose credentials, cookies, session IDs, auth headers, signed media URLs, or full downloader `formats`.

## Verification pattern

Before handoff:

```bash
pytest -q
ruff check src tests
git diff --check
```

Also run:

- local FastAPI smoke (`/health`, `/resolve` unknown URL, `/resolve` Instagram URL without session should not fake views);
- privacy scan for secrets/session/proxy credentials;
- one live YouTube fallback check if acceptable;
- only claim TikTok/Instagram live views after real proxy/session inputs are supplied and the returned fields are observed.

## Useful links

- instagrapi: https://github.com/subzeroid/instagrapi
- instagrapi media docs: https://subzeroid.github.io/instagrapi/usage-guide/media.html
- instagrapi best practices: https://subzeroid.github.io/instagrapi/usage-guide/best-practices.html
- instagrapi play_count issue: https://github.com/subzeroid/instagrapi/issues/1117
- Boualam3 Instagram Reels Scraper: https://github.com/Boualam3/Instagram-Reels-Scraper
- YoppaV Instagram MCP: https://github.com/YoppaV/instagram-mcp
- seotanvirbd Instagram Reel Scraper: https://github.com/seotanvirbd/Instagram-Reel-Scraper
- Cobalt reference: https://github.com/imputnet/cobalt

Provider hints to remember as fallback/comparison only:

- Cloqly: https://cloqly.com/
- DataLikers: https://datalikers.com/
- LamaTok: https://lamatok.com/
