---
name: public-web-scraping-validation
description: Validate self-hosted or open-source scraping approaches for public websites before recommending or building production services.
triggers:
  - validate scraper feasibility
  - public web scraping validation
  - prove this scraper works
  - self-hosted scraping approach
  - test social media metadata extraction
  - anti-bot scraping spike
writes_pages: false
mutating: false
---

# Public Web Scraping Validation

## Contract

A run of this skill is complete when:

1. The exact product contract is pinned: inputs, required fields, reliability target, and auth/proxy assumptions.
2. A live probe matrix or explicit blocker is recorded before declaring feasibility.
3. Success is classified as VALIDATED, PARTIAL, INVALIDATED, or UNKNOWN.
4. Credential/cookie/proxy material is redacted from all outputs and persisted notes.

## Output Format

- Probe matrix with URL class, adapter/source, fields returned, confidence, and errors.
- Verdict: VALIDATED / PARTIAL / INVALIDATED / UNKNOWN.
- Implementation recommendation with typed fallbacks.
- Operational risk notes: auth, proxy, rate limit, ToS/account stability.

## Anti-Patterns

- Recommending a scraper because README/GitHub stars look good.
- Saying “works” when only media download URLs work but required metadata fields are absent.
- Generalizing from one platform’s success to another platform.

## Procedure

Use this skill when the user wants to build or choose a **self-hosted/open-source scraper** for public websites, social platforms, media metadata, analytics, or engagement stats — especially when they need confidence that it will work without a long exploratory build.

### Core rule

Do not recommend a scraper based on GitHub stars, README promises, or docs alone. Public scraping against anti-bot platforms must be validated with live probes against representative URLs and the exact required fields.

### Workflow

1. **Pin the product contract**
   - Required inputs: single URL, profile URL, batch URLs, account-owned media, or arbitrary public media.
   - Required fields: e.g. `views`, `likes`, `comments`, `shares`, `author`, `published_at`.
   - Required reliability: best-effort, near-prod, or official/API-grade.
   - Auth assumptions: no auth, cookies/session allowed, official API keys, proxy pool, owned accounts only.

2. **Shortlist by class, not hype**
   - Prefer mature extractors for broad media (`yt-dlp`, `gallery-dl`) when a single URL-to-metadata path is enough.
   - Prefer official APIs for owned-media/business workflows and stable YouTube stats.
   - Treat unofficial/private APIs and browser automation as fragile until proven.
   - Treat catalogs/affiliate lists as discovery sources only, not implementation candidates.

3. **Run a live probe matrix before promising feasibility**
   - Use 5–10 representative URLs from the user when possible.
   - Include at least one recent URL per target platform; stale social URLs can fail with misleading `blocked` / `unavailable` errors that do not invalidate the whole approach.
   - Test the exact field, not just request success. Example: `likes/comments` without `views` is a partial result, not success.
   - Record stderr, null fields, auth redirects, challenge pages, and rate-limit/challenge requirements.
   - If the user provides proxy/cookies/session credentials, verify the access path live but **never echo raw credentials** in outputs, notes, gbrain, screenshots, or final reports; redact them before persistence. When implementing proxy support, prefer a unified `PROXY_URL` / provider config (for example Proxy6 `getproxy`) over platform-specific env sprawl unless separate pools are operationally required.
   - Validate proxy integrations in layers: provider API (`getproxy`/`check`) → app proxy selection → generic HTTP through the proxy → target-site field extraction. Do not conflate generic proxy health with platform viability; TikTok/Instagram may still block datacenter IPs that pass `httpbin` and provider checks.
   - Keep provider mutation out of normal request paths: buying, tagging, bad-marking, and warmup retries belong in an explicit operator CLI/cron/script, not in `/resolve` or user-facing scrape requests. The resolver should consume a selected proxy; pool maintenance should manage descriptors/statuses separately.
   - For social media video stats, include a direct raw-response probe alongside libraries: inspect embedded rehydration JSON / mobile API responses before deciding a downloader cannot expose stats.

4. **Classify outcomes honestly**
   - `VALIDATED`: exact fields returned for representative URLs under stated assumptions.
   - `PARTIAL`: some fields/platforms work, but key fields are null/missing or require cookies/proxies/session state.
   - `INVALIDATED`: core field cannot be obtained under the stated constraints.
   - `UNKNOWN`: needs user-provided URLs, credentials, cookies, or proxy assumptions before a real verdict.

5. **Design with typed fallbacks**
   - Return structured partial failures instead of hiding missing data:
     ```json
     {
       "platform": "instagram",
       "media_id": "...",
       "views": null,
       "likes": 123,
       "comments": 45,
       "confidence": "partial",
       "source": "yt-dlp",
       "reason": "view_count_not_exposed"
     }
     ```
   - Build adapters per source and platform; don't hardcode one scraper as a universal truth.

### Pitfalls

- Do not say "works" when only download URLs or media files work; metadata/stat fields may be absent.
- Conversely, do not discard a downloader project too early: inspect whether its raw platform response already contains the needed stats but the project simply does not surface them. For example, a media downloader may parse TikTok `itemStruct` for `playAddr` while ignoring adjacent `stats.playCount`.
- Do not generalize from YouTube success to TikTok/Instagram; they have very different anti-bot/auth surfaces.
- Do not promise arbitrary public Instagram/TikTok stats without testing cookies/session/proxy needs.
- Do not persist transient setup failures as durable tool limitations. Capture the validation method and required assumptions instead.

### References

- `references/social-media-stats-scraping.md` — compact field-tested notes for YouTube/TikTok/Instagram video-stat scraping, including cobalt-style TikTok rehydration parsing, proxy/cookie assumptions, and a recommended probe matrix.

## Verification Checklist

- [ ] The answer is grounded in current sources or explicit live probe output when the task requires freshness.
- [ ] Private credentials, cookies, sessions, personal names, and internal infrastructure are absent or redacted.
- [ ] Uncertainty is labeled instead of hidden behind a confident recommendation.
- [ ] The final response gives the user a concrete next action, not only background context.
