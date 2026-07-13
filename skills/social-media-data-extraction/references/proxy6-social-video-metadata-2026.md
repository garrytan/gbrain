# Proxy6 notes for social video metadata

Session learning from implementing and live-testing a Proxy6-backed proxy provider and operator-side pool bootstrap for a self-hosted social video stats resolver.

## Proxy6 API shape

- API base: `https://px6.link/api/{api_key}/{method}`.
- `getproxy` accepts `state`, `descr`, `page`, `limit` and returns `list` entries with fields like `id`, `version`, `host`, `port`, `user`, `pass`, `type`, `country`, `active`, `date_end`.
- `check` can validate an existing proxy by `ids` or a raw `ip:port:user:pass` string.
- `buy` mutates/spends; useful params: `count`, `period`, `country`, `version`, `descr`.
- `setdescr` can retag bought proxies by `ids` + `new`; use it to manage pools like `social-video-metadata-tiktok` and `social-video-metadata-bad-tiktok`.
- `getcount` + `getprice` let the operator choose a country/version before buying.
- API docs state a limit of max 3 requests/sec. In practice, rapid read-only calls can hit `429 Too Many Requests`; cache `getproxy` and sleep ~1.1s between admin calls.

## Config pattern that worked

Prefer a platform-agnostic proxy layer:

```env
PROXY_PROVIDER=auto     # auto | proxy6 | none
PROXY_URL=              # single manual override for all platforms
PROXY6_API_KEY=         # never commit/log
PROXY6_DESCR=social-video-metadata
PROXY6_STATE=active
PROXY6_LIMIT=100
PROXY6_SCHEME=http      # or auto to map type=socks -> socks5h
PROXY6_BUY_VERSION=4
PROXY6_BUY_PERIOD=7
PROXY6_BUY_COUNTRIES=pl,us,nl,de,gb
PROXY6_API_PAUSE_SEC=1.15
PROXY_HEALTHCHECK_URL=https://httpbin.org/ip
PROXY_TARGET_SMOKE_URL=https://www.tiktok.com/@tiktok/video/7106594312292453678
```

Deprecated platform-specific envs (`TIKTOK_PROXY_URL`, `INSTAGRAM_PROXY_URL`, `HTTP_PROXY_URL`) can remain compatibility fallbacks, but should not be the main design.

Build proxy URLs from Proxy6 items as:

```text
http://user:pass@host:port
```

For `PROXY6_SCHEME=auto`, `type=socks` can map to:

```text
socks5h://user:pass@host:port
```

## Verification ladder

Do not claim the provider works after unit tests only. State what was and was not tested.

1. Code-level tests:
   - proxy precedence (`none` > `PROXY_URL` > Proxy6 > deprecated fallback);
   - Proxy6 item -> URL formatting;
   - provider failure/429 returns fallback or `None`, not a resolver crash;
   - country rotation skips countries that already produced target-failed purchases in the current bootstrap run.
2. Read-only live tests:
   - account API returns `status=yes`;
   - `getproxy?state=active&limit=...` returns expected list;
   - `check` on existing proxy returns `proxy_status=true`;
   - app `get_proxy_for()` produces a redacted URL shape with scheme/host/port/auth present.
3. Mutating live test (only after explicit approval because it spends/mutates):
   - `buy` 1 cheap proxy for the shortest useful period with a unique transient `descr`;
   - `getproxy` by `descr` finds it;
   - `check` succeeds after warmup if needed;
   - `setdescr` transient -> transient-ok -> final project descriptor;
   - configure local gitignored `.env` and verify app reads it.
4. End-to-end platform smoke:
   - first smoke generic HTTP through proxy (`https://httpbin.org/ip` or equivalent);
   - then test target platform adapter and exact fields.

## Operator pool bootstrap pattern

Keep the normal `/resolve` path non-mutating. Buying, tagging, and bad-marking must not happen inside an arbitrary user-facing resolver request.

For Docker-bound services, prefer a **service-native lifecycle** over a CLI-only workflow:

```env
PROXY_POOL_BOOTSTRAP_ON_START=true
PROXY_POOL_PLATFORM=tiktok
PROXY_POOL_TARGET_DESCR=social-video-metadata-tiktok
PROXY_POOL_BAD_DESCR=social-video-metadata-bad-tiktok
PROXY6_REUSE_DESCRS=social-video-metadata
PROXY_POOL_MAX_BUY=0   # reuse/status only; no spend
```

Recommended surface:

- FastAPI/app lifespan runs bootstrap only when `PROXY_POOL_BOOTSTRAP_ON_START=true`.
- `GET /proxy/status` returns redacted read-only status and the last startup report.
- `PROXY_POOL_MAX_BUY=0` is the production-safe default: check/reuse existing pools, never buy.
- Set `PROXY_POOL_MAX_BUY>0` only when the operator explicitly allows spend.
- CLI can remain as a debug/admin entrypoint (`docker exec`, one-off job, local probe), but it should not be the main production dependency.

Debug CLI shape when needed:

```bash
python -m social_video_metadata.proxy_pool status \
  --platform tiktok \
  --descr social-video-metadata

python -m social_video_metadata.proxy_pool bootstrap \
  --platform tiktok \
  --target-descr social-video-metadata-tiktok \
  --bad-descr social-video-metadata-bad-tiktok \
  --max-buy 2
```

Bootstrap algorithm:

1. `getproxy` by target descriptor.
2. Evaluate target-pool proxies with provider `check`, generic HTTP, then target smoke.
3. If no target proxy works, evaluate `PROXY6_REUSE_DESCRS` before buying; do not mark reused generic/shared pools bad just because one platform blocks them.
4. If reused proxy passes target smoke, promote it with `setdescr` to the target descriptor.
5. If target-pool/fresh-purchase target smoke fails, `setdescr` to the bad descriptor.
6. If no good/reused proxy exists and `max_buy > 0`, buy from `PROXY6_BUY_COUNTRIES`.
7. Fresh purchases get a transient candidate descriptor and warmup retries because they may fail `check` for ~60 seconds.
8. If candidate passes target smoke, `setdescr` to the target descriptor.
9. If candidate fails target smoke, `setdescr` to bad descriptor and rotate country; do not buy the same failed country repeatedly in one bootstrap run.
10. Periodically delete project-owned bad/extra descriptors once they are known-useless; do not delete unlabeled or ambiguous proxies.
11. Print only redacted shapes, not raw proxy credentials.

## Operational findings from live test

- Proxy6 automation worked: buy, `setdescr`, `getproxy` by descriptor, provider `check`, warmup/retry, and generic HTTP through proxies.
- Newly bought proxies may not be usable immediately. A US IPv4 proxy returned `check=false` and generic HTTP failed immediately after purchase, then became `check=true` and `httpbin` worked after ~60 seconds. Add retry/wait before marking fresh proxies bad.
- Proxy6 datacenter IPv4 proxies can work for generic HTTP but still be blocked by TikTok post access. Tested PL/US/NL/GB proxies passed Proxy6/generic HTTP checks, but TikTok URL smoke returned no metadata and `yt-dlp` reported the IP was blocked from accessing tested posts. DE had 0 available in that run.
- Therefore, health is two-layered: proxy connectivity is not the same as platform viability. Maintain separate descriptors/statuses for `generic-ok`, `bad-tiktok`, target-good, etc.
- For TikTok, next options are residential/mobile proxy providers, target-specific browser/session strategy, or a different TikTok data path.

## Privacy

- Never print or persist real API keys, proxy hosts, proxy users, or proxy passwords in commits, gbrain notes, screenshots, or final reports.
- When reporting, redact to shapes like `{scheme, host_present, port_present, auth_present}`.
- Local `.env` is acceptable only if gitignored and verified as ignored.
