# Unified proxy config for social video metadata resolvers

Session-derived pattern for self-hosted social video metadata/stats services that need proxies for TikTok/Instagram but should avoid per-platform env sprawl.

## Recommended config shape

Prefer one platform-agnostic proxy resolver:

```env
PROXY_PROVIDER=auto   # auto | proxy6 | none
PROXY_URL=            # manual all-platform proxy override

PROXY6_API_KEY=       # Proxy6 provider key; never commit/log real value
PROXY6_DESCR=         # optional pool/comment filter
PROXY6_STATE=active
PROXY6_LIMIT=100
PROXY6_SCHEME=http    # http or auto
```

Resolution order:

1. `PROXY_PROVIDER=none` disables proxies.
2. `PROXY_URL` wins as the single manual proxy for every platform adapter.
3. `PROXY6_API_KEY` discovers active proxies from Proxy6.
4. Old `HTTP_PROXY_URL`, `TIKTOK_PROXY_URL`, `INSTAGRAM_PROXY_URL` may remain compatibility fallbacks only, not the main documented path.

## Proxy6 API notes

Proxy6 docs: `https://px6.link/api/{api_key}/{method}`.

For this use case call:

```text
GET /api/{api_key}/getproxy?state=active&limit=100[&descr=<pool>]
```

Relevant response fields per proxy:

- `host`
- `port`
- `user`
- `pass`
- `type` (`http`, `socks`, `auto`)
- `active`
- `country`
- expiry metadata

Build URLs as raw strings, not typed `HttpUrl`:

```text
http://user:pass@host:port
socks5h://user:pass@host:port  # when PROXY6_SCHEME=auto and type=socks
```

Proxy6 API limit observed in docs: max 3 requests/second. Cache `getproxy` results and do not request on every URL resolve.

## Security / hygiene

- Never commit or persist real Proxy6 keys, proxy credentials, session cookies, or generated proxy URLs.
- Privacy scans should include known key prefixes/secret snippets from the session if a user pasted a key.
- Docs should show placeholders only.

## Why this matters

A variable like `TIKTOK_PROXY_URL` makes the architecture look platform-special even though proxy selection is an infrastructure concern shared by TikTok, Instagram anonymous GraphQL, Instagram own-session fallback, yt-dlp, etc. Keep adapter code asking for `get_proxy_for(platform, settings)`, but keep operator configuration unified.