---
title: "Blocking OnlyFans Links"
type: guide
created: 2025-08-21
updated: 2025-08-21
source: chatgpt-export
topic: business-jovie
message_count: 6
tags: [chatgpt, knowledge, business-jovie]
---
# Blocking OnlyFans Links

> **Source:** ChatGPT conversation
> **Date:** 2025-08-21T21:50:48Z
> **Messages:** 6
> **Topic:** business-jovie

## Question

For jovie how do we block onlyfans links etc on peoples link in bios from being scraped by instagram etc to prevent instagram from flagging us?

## Answer

Mr. White — short version: don’t ever put `onlyfans.com` (or other “flaggable” domains) in the public HTML, metadata, or static JSON. Wrap, gate, and de-referrer everything.

# What to do (practical + effective)
1) **Link wrapping**
- Store external links as records (e.g., `links(id, kind, url_encrypted)`).
- Render as `/go/:id` (never the real domain).
- 302 → an **interstitial** page (see #2) → then client-side fetch reveals the real URL.

2) **Bot-proof interstitial**
- Route: `/out/:id` (SSR page with ZERO destination in HTML).
- Add:
  - `<meta name="robots" content="noindex,nofollow,noarchive,noimageindex,nosnippet">`
  - HTTP `X-Robots-Tag: noindex, nofollow, noarchive`
  - `Referrer-Policy: no-referrer`
- Require a **user gesture** (click) to request a short-lived signed URL via XHR (e.g., 30–60s JWT). No gesture, no URL.

3) **User-Agent & ASN blocks (defense-in-depth)**
- Deny on edge/middleware if UA/IP matches Meta:
  - UAs: `facebookexternalhit`, `Facebot`, `Instagram` (various), `MetaInspector`.
  - IPs/ASNs: AS32934, AS63293 (Meta). (Maintain a small CIDR/ASN allowlist/denylist and refresh periodically.)
- If matched, serve a blank 404/410 from `/out/*`.

4) **De-referrer + no-preview everywhere**
- All outbound `<a>`: `rel="noreferrer noopener ugc nofollow"` and `referrerpolicy="no-referrer"`.
- Do **not** set OpenGraph/Twitter meta that expose the target (no `og:url` to OnlyFans, no link text containing the domain).
- Button copy like “Subscribe” instead of the raw URL.

5) **Obfuscate at rest & in transit**
- Encrypt `url` at rest; never leak in client props/JSON.
- On interstitial click: GET `/api/link/:id?token=…` → returns the **real** URL only if:
  - Human check passes (hCaptcha turnstile or simple puzzle),
  - UA/IP not blocked,
  - Token valid & single-use.
- Then do `window.location.replace(realUrl)`.

6) **Per-link policy flags**
- `links.kind = 'adult'|'gambling'|'normal'` → adult/gambling always use interstitial + CAPTCHA + stricter blocks.
- Allow creators to mark a link “sensitive”; default sensitive for known domains (OnlyFans, Fansly, Pornhub, etc.).

7) **Content scanning on save**
- On creator input, normalize URL, check PSL, and map to `domain_category`.
- If `adult`, auto-wrap in the strict path above and **never** render the domain anywhere public.

# Minimal Next.js implementation sketch
- **Middleware (Edge):**
  - If path starts with `/out/` or `/api/link/`, check UA and IP ASN; block Meta → 404.
- **/out/[id] page:**
  - Renders with robot-blocking meta.
  - A “Continue” button triggers hCaptcha → `fetch(/api/link/[id])` → receives short-lived URL → `location.replace`.
- **/api/link/[id] API:**
  - Verifies signed token, hCaptcha, rate limit, UA/IP not blocked.
  - Decrypts & returns `{"url":"…"}`.
- **DB:**
  - `links(id uuid, kind text, url_ciphertext bytea, created_by, …)`.

# Extra hardening
- Rate limit `/api/link/*`.
- Strip previews: set `Content-Security-Policy: referrer no-referrer;` (actually us

*(Answer truncated — 3507 chars total)*

## Question

Should we do this? Should we do it for social links? Or just links to onlyfans etc?

## Answer

Mr. White — do it, but **tier it**.

# Recommendation
- **Wrap *all* external links** behind `/go/:id` so real domains never appear in HTML/JSON. Cheap, safe, invisible to users, future-proof.
- **Apply “hard mode” only to sensitive domains** (OnlyFans, Fansly, Pornhub, gambling, etc.).

# Policy (simple)
- **Default (social/DSPs: IG, TikTok, X, YouTube, Spotify, Apple Music, etc.)**
  - `/go/:id` → 302 direct.
  - `rel="noreferrer noopener ugc nofollow"`, `Referrer-Policy: no-referrer`.
  - No OG/Twitter meta that expose targets.
  - No interstitial, no CAPTCHA, no bot blocks.

- **Sensitive (adult/gambling/pay-per-view)**
  - `/out/:id` interstitial (no target in HTML).
  - Human-gesture → short-lived signed URL → `window.location.replace()`.
  - Block Meta UAs/IP ASNs at edge; return 204/404.
  - Robots: `noindex,nofollow,noarchive` + `X-Robots-Tag`.
  - Optional hCaptcha + rate limiting.

# Why this split
- **Stops IG from flagging** you for explicit domains (they’re never in the DOM or OG tags).
- **Maintains UX** for normal socials (no extra click/friction).
- **Scales**: per-link `kind` flag drives behavior; creators can mark “sensitive.”

# Quick defaults to ship
- `links.kind ∈ {normal, sensitive}`
- All links wrapped; **only** `kind="sensitive"` uses interstitial + bot blocks.
- Hide domains in sitemaps/feeds; exclude sensitive links entirely.

If you want, I’ll drop the exact Next.js middleware + interstitial + `/api/link/[id]` handlers using this policy.

## Question

ioen an issue in linear for this

## Answer

Got it, Mr. White. Here’s a ready-to-paste Linear issue.

# Title
Tiered Link Wrapping & Anti-Scrape Interstitials (Sensitive Domains)

# Description
Implement link-wrapping for all external links and “hard mode” protections for sensitive domains (OnlyFans, Fansly, Pornhub, gambling, etc.) to reduce IG/Meta flagging.  
- All links render as `/go/:id` (no raw domains in HTML/JSON).  
- Sensitive links use `/out/:id` interstitial with bot blocks and human gesture before reveal.

# Scope
- DB: `links.kind ∈ {normal, sensitive}`; encrypt URL at rest.
- Normal: `/go/:id` → 302 direct; add `rel="noreferrer noopener ugc nofollow"` and `Referrer-Policy: no-referrer`.
- Sensitive: `/out/:id` SSR page with **no target in HTML**, robots noindex headers, short-lived signed URL fetch after click (and optional hCaptcha), then `location.replace`.
- Edge/middleware: block Meta UAs (`facebookexternalhit`, `Facebot`, `Instagram`) and ASNs (AS32934, AS63293) for `/out/*` and `/api/link/*`; return 204/404.
- No OG/Twitter tags exposing targets. Exclude sensitive links from sitemaps/feeds.

# Acceptance Criteria
- [ ] Public pages never expose raw external domains in HTML, JSON, or OG tags.  
- [ ] Normal links redirect in ≤150ms end-to-end.  
- [ ] Sensitive links never resolve for Meta crawlers; humans can reach target in ≤1 click post-gesture.  
- [ ] Referrer to target is empty (`no-referrer`).  
- [ ] E2E tests cover both paths; CI blocks on regression.

# Tasks
- [ ] Add `kind` column + URL encryption at rest.  
- [ ] Build `/go/:id` 302 controller.  
- [ ] Build `/out/[id]` interstitial with robots meta + headers.  
- [ ] Build `/api/link/[id]` to return signed, single-use URL (30–60s TTL), rate-limited.  
- [ ] Edge middleware: UA/ASN blocklist for Meta; 204/404 response.  
- [ ] Add `rel` + `referrerpolicy` to all outbound `<a>`.  
- [ ] Remove/guard OG/Twitter tags that reveal targets.  
- [ ] Sitemap: exclude sensitive links.  
- [ ] Add domain categorizer on save (PSL parse → `kind`).  
- [ ] Tests: unit (categorizer, signer, encrypt/decrypt), integration (middleware), E2E (normal vs sensitive flows).

# Security/Privacy
- Encrypt URLs at rest; never ship targets in client props.  
- Log only link ID, not target URL.

# Flags
- perf, security, growth, web

# Priority
High

# Estimate
3–4 days including tests

# Notes
This is deliberate cloaking to reduce automated flags; enforce sensitively and monitor.
