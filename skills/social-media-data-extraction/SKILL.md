---
name: social-media-data-extraction
description: Research, select, and sanity-check libraries, APIs, and self-hosted tools for extracting social media metrics and metadata across major platforms.
triggers:
  - social media metrics extraction
  - get YouTube TikTok Instagram views programmatically
  - compare social scraping libraries
  - is this scraping repo legit
  - self-hosted social media scraper
  - extract video engagement stats
writes_pages: false
mutating: false
---

# Social Media Data Extraction

## Contract

A run of this skill is complete when:

1. The task distinguishes self-hosted libraries, official APIs, private/unofficial APIs, browser automation, and hosted scraping marketplaces.
2. Repository/API recommendations are based on code/docs/source shape and maintenance signals, not catalog hype.
3. For “prove it works” requests, live adapter probes capture exact fields and errors.
4. The final answer leads with concrete links/results when the user asks where to click or what works.

## Output Format

- Verdict first for a sent repo/catalog.
- Shortlist table: option, platforms, self-hosted status, best use, caveats.
- Field mapping for views/likes/comments/shares and source confidence.
- Probe evidence matrix for live verification tasks.

## Anti-Patterns

- Calling Apify/RapidAPI catalogs self-hosted libraries.
- Making third-party scraper APIs the architecture when the user asked for OSS/self-hosted posture.
- Burying exact tested URLs/numbers under generic “tests passed” language.

## Procedure

Use this when the user asks for tools/libraries/APIs to extract social media posts, profiles, video metadata, comments, view counts, likes, engagement, transcripts, or media URLs.

### Default stance

1. **Separate self-hosted libraries from hosted marketplaces.** A GitHub repo that is only a catalog of Apify actors, affiliate links, RapidAPI endpoints, or SaaS wrappers is not a self-hosted scraper/library. Say that plainly.
2. **Prefer a working shortlist over a giant directory.** The user usually wants something actionable, not 3000 links. Return 3–6 options with tradeoffs.
3. **Check the repo shape before recommending it.** Inspect README, file tree, commits, language mix, and whether there is actual scraping code, package manifests, examples, schemas, and tests.
4. **Platform APIs differ sharply.** YouTube has a stable official API, but do not assume an API key should be the primary path when the project goal is minimum dependencies/self-hosted posture. For dependency-light metadata services, try `yt-dlp`/public metadata extraction first and keep YouTube Data API v3 as an official fallback/verification path. TikTok/Instagram public scraping is fragile and often needs cookies/proxies/browser automation; Instagram Graph API is mainly for authorized Business/Creator media, not arbitrary public reels.
5. **Do not make third-party scraper APIs the architecture unless explicitly requested.** For self-hosted product research, hosted vendors (Bright Data/Apify/Oxylabs/etc.) are fallback/proof aids, not the primary design. First look for OSS/self-hosted adapter chains, own throwaway sessions, stable proxies, and browser/mobile API paths.
6. **When the user asks “give links / куда тыкать,” provide concrete URLs immediately.** Do not stop at explaining the category; include exact repo/docs/dashboard links and what to click/check on each page.
7. **Be concise and direct for “what is this?”** If the user sends a screenshot/link and asks what it is, answer with a verdict first: “catalog/affiliate lead-gen, not a library” or “real package”, then the evidence.

### Quick decision tree

#### User wants view counts / engagement by URL

- **Fast self-hosted baseline:** `yt-dlp` with `--skip-download`, `--print`, or `-j`; normalize fields such as `view_count`, `like_count`, `comment_count`, `extractor_key`, `id`, `webpage_url`.
- **YouTube default for minimum-dependency services:** put `yt-dlp`/public metadata extraction first so the service works without `YOUTUBE_API_KEY`. Add YouTube Data API v3 `videos.list?part=statistics&id=...` → `statistics.viewCount` as fallback/verification, not as the foundation, unless the user explicitly wants official API first.
- **TikTok:** try `yt-dlp`; for Python/browser fallback use `TikTokApi` and read `statsV2`/`stats` → `playCount`. Expect `ms_token`, Playwright, and proxies.
- **Instagram:** test the lowest-friction anonymous public web path before asking for cookies. For arbitrary public Reels, prefer this self-hosted chain: (1) anonymous page bootstrap (`GET /reel/<shortcode>/` to get transient cookies/LSD/App-ID), then shortcode GraphQL `POST /graphql/query` with `doc_id=10015901848480474` and `variables={"shortcode":"..."}`; parse `xdt_shortcode_media.video_view_count`, `video_play_count`, `edge_media_preview_like.count`, and `edge_media_to_comment.count`; (2) anonymous oEmbed/older shortcode GraphQL as partial fallback for media/owner/likes/comments; (3) own warmed throwaway IG session via `instagrapi` private mobile API `user_clips_v1()` / `clips/user/` when public GraphQL returns 403/429/null; (4) authenticated Playwright/Selenium intercept of profile Reels GraphQL `xdt_api__v1__clips__user__connection_v2` / `PolarisProfileReelsTabContentQuery(_connection)`; (5) `yt-dlp`/Instaloader partial fallback. Official Instagram Graph API Media Insights works for authorized professional media with metrics like `views` / `total_views`, not general public scraping.

#### User sends a “social media scraping APIs” catalog/repo

Check whether it is:

- static README tables only;
- links mostly to Apify/RapidAPI/SaaS with affiliate params;
- no package code or only generator scripts;
- inflated “API count” generated from a marketplace;
- mixed-quality entries unrelated to the requested task.

If yes, classify it as a **directory/affiliate marketplace**, not a tool. It can be a paid fallback source, but should not be treated as a dependency.

### Verification workflow

1. **Open authoritative sources:** GitHub repo README/file tree/raw docs; official API docs; package docs for Python/Node libs.
2. **For each candidate record:** license, install/runtime, auth/cookies/proxies, output fields for views/likes/comments, maintenance signals, and expected breakage modes.
3. **Prefer primary claims:** package docs or source fields over blog posts. For official APIs, cite official docs.
4. **When the user asks for a “full probe” / “prove it works,” run an actual adapter spike** instead of stopping at research: test real URLs with `yt-dlp`, official APIs where available, and candidate fallbacks; record exact returned fields/errors. Include small repos (<50 stars) if they contain concrete endpoint/header/intercept patterns, but label them as references unless runtime-verified.
5. **For live social-metrics verification, save the evidence matrix before summarizing.** For every tested URL, capture and report the exact public URL, platform, adapter/source, resolved media id, views/likes/comments/shares/reposts/plays, confidence, and parsed/failed status. If a smoke test succeeded but the exact URL or numbers were not saved, call it an incomplete smoke result and rerun with a concrete URL list before claiming the platform is verified. In the chat reply, put the concrete links and numbers first; generic “tests passed” belongs after the evidence.
6. **Inspect downloader internals for latent stats.** Media downloaders often parse rich raw objects but discard engagement fields. For TikTok, look for `__UNIVERSAL_DATA_FOR_REHYDRATION__ → webapp.video-detail → itemInfo.itemStruct.stats/statsV2`. For Instagram, look for `i.instagram.com` media info or web GraphQL nodes with `play_count`, `ig_play_count`, `video_view_count`, `clips_play_count`.
7. **If recommending self-host:** include a minimal command/snippet and exact output fields to parse.
7. **Flag legal/ToS and operational risk without moralizing.** Focus on stability, account risk, rate limits, proxy cost, and data access scope.
8. **Do not leave verification only in chat/README/gbrain.** When the work includes live tests, provider probes, or a meaningful verification matrix, add or update a repo doc such as `docs/verification-results.md`, link it from README, and push it. The document should separate automated checks from platform/provider live findings and include the exact commands/output summary, caveats, and privacy notes.

### Output patterns

#### Shortlist

```md
| Option | Platforms | Self-host? | Best for | Caveats |
|---|---|---:|---|---|
| yt-dlp | YouTube/TikTok/Instagram/etc. | ✅ | URL → metadata/views MVP | Fragile on TikTok/IG; cookies/proxies may be needed |
```

#### Repo verdict

```md
Это не либа и не self-hosted scraper. Это <catalog/affiliate directory/hosted actor list>.
Evidence:
- <static README/catalog>
- <links to hosted marketplace with affiliate params>
- <no scraping logic/package>
Use it only as <paid fallback/source of vendor names>, not as a dependency.
```

### Pitfalls

- For services whose product is metadata/statistics, keep naming and docs aligned with that scope: call it a metadata/stats resolver, not a downloader. Do not name runtime adapters/functions/classes after reference projects (e.g. `*_cobalt_*`); use platform/path names like `tiktok_web_rehydration_adapter` or `instagram_private_session_adapter`.
- Do not call Apify actors “self-hosted” unless the actor source can actually be run independently and you verified it.
- Do not recommend a mega-list as if it solves extraction; first identify the specific actor/library and its schema/pricing.
- Do not overstate or understate Instagram public data access. Distinguish public page scraping, logged-in scraping, own throwaway mobile sessions, and official Graph API insights. For Reels views specifically, there are multiple shortcode GraphQL routes: older/Polaris media-info paths may return `view_count: null`, but anonymous page-bootstrap + `doc_id=10015901848480474` can expose `video_view_count` and `video_play_count` for public Reels. Validate both before asking the user for cookies; keep own `instagrapi` session as fallback/verification when public GraphQL is rate-limited, blocked, or returns null.
- Do not pivot to buying session/cookie marketplaces as the main answer. Treat bought sessions/cookies as high-risk and incompatible with an OSS/self-hosted posture; if paid vendors come up, label them as optional fallback only and continue looking for own-session/self-hosted paths.
- When modeling proxy config for TikTok/Instagram scraping, do not validate proxy env vars as `HttpUrl`; keep them as raw strings so `http`, `https`, `socks5`, and `socks5h` can pass through to the specific client library.
- Prefer a unified proxy configuration over per-platform env sprawl. Use one manual `PROXY_URL` for all adapters or a provider block such as `PROXY6_API_KEY`/`PROXY6_DESCR`; keep `TIKTOK_PROXY_URL` / `INSTAGRAM_PROXY_URL` only as deprecated compatibility fallbacks. Adapter code can still call `get_proxy_for(platform, settings)`, but operator-facing config should be platform-agnostic unless there is a real operational reason to split pools.
- When adding a paid/demo proxy provider integration, do not present it as “tested” after only unit tests. Say exactly what was tested. Run read-only live checks (`getproxy`, existing-proxy `check`, redacted app URL-shape) first; run mutating checks (`buy`, `setdescr`, `ipauth`, `delete`, `prolong`) only after explicit approval. After purchase, wait/retry because new proxies may take ~60s to pass `check`. Then test generic HTTP through the proxy and the target platform separately — datacenter proxies can pass httpbin but still be blocked by TikTok post access.
- For Docker-bound/social-video services, do not make proxy pool management CLI-only. Prefer service-native lifecycle: startup bootstrap behind an explicit env flag, read-only status endpoint, reuse existing descriptor pools before buying, and `max_buy=0` as the safe default. CLI may remain as a debug/admin entrypoint, but production should not depend on someone shelling into the container.
- When reporting live parsing/verification results, lead with the concrete answer: **which exact videos/URLs were parsed, which fields were obtained, and which platforms only had a smoke test or failed**. Do not bury this under “tests passed” or generic adapter status. If a YouTube/TikTok URL or exact numbers were not saved, say that plainly and mark the result as partial/nondeterministic rather than implying a full live sample matrix. See `references/social-video-verification-reporting-2026.md`.
- Do not assume `views` means the same metric across platforms: YouTube Shorts, TikTok plays, Instagram views/reach/impressions all have platform-specific definitions.
- Avoid long background explanations when the user asks “что это?” — verdict first, evidence second, practical recommendation last.

### References

- `references/youtube-tiktok-instagram-views-2026.md` — field notes from researching view-count extraction for YouTube/TikTok/Instagram and evaluating a GitHub “social media scraping APIs” catalog.
- `references/social-video-metadata-mvp-2026.md` — session-derived implementation notes for a self-hosted metadata/stats resolver: adapter naming, YouTube/TikTok/Instagram chains, Instagram own-session strategy, proxy config pitfalls, response schema, and verification checklist.
- `references/instagram-reels-anonymous-graphql-2026.md` — validated no-login Instagram Reels shortcode GraphQL path (`doc_id=10015901848480474`) for `video_view_count`, `video_play_count`, likes, and comments, with caveats and field mapping.
- `references/proxy6-social-video-metadata-2026.md` — Proxy6-specific notes from live provider testing: API methods, unified env pattern, 3 req/sec limit, mutating buy/setdescr/check flow, fresh-proxy warmup, and the distinction between generic proxy health and TikTok viability.
- `references/social-video-proxy6-unified-proxy.md` — unified proxy config pattern for social video metadata resolvers: `PROXY_URL`, Proxy6 `getproxy`, raw proxy URL construction, caching, and deprecated per-platform fallback handling.
- `references/social-video-verification-reporting-2026.md` — reporting pattern for social-video live verification: exact parsed URLs/IDs first, distinguish real sample parses from adapter smoke tests, and keep failed proxy/platform paths explicit.

## Verification Checklist

- [ ] The answer is grounded in current sources or explicit live probe output when the task requires freshness.
- [ ] Private credentials, cookies, sessions, personal names, and internal infrastructure are absent or redacted.
- [ ] Uncertainty is labeled instead of hidden behind a confident recommendation.
- [ ] The final response gives the user a concrete next action, not only background context.
