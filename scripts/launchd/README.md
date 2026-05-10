# launchd Services — Cutover Reference

After **M3 cutover (2026-05-10)** the production service lineup is:

1. **com.jarvis.kos-compat-api** — port 7225, drop-in HTTP replacement for
   the v1 Python kos-api.py. Talks to gbrain CLI; embeds via the native
   v0.27 Vercel AI SDK gateway (`google:gemini-embedding-001`, 1536 dim).
   Carries `GOOGLE_GENERATIVE_AI_API_KEY` + `GBRAIN_EMBEDDING_MODEL` +
   `GBRAIN_EMBEDDING_DIMENSIONS` + `KOS_API_TOKEN` + `ANTHROPIC_BASE_URL`.
2. **com.jarvis.dream-cycle**, **kos-patrol**, **enrich-sweep**,
   **notion-poller** — cron-style services. Each plist carries the same
   Google embedding env block so any embed code path works.

The old **com.jarvis.gemini-embed-shim** (port 7222 OpenAI→Gemini
translator) was retired in M3; its plist template lives at
`scripts/launchd/_archived/`. Don't reintroduce
`OPENAI_BASE_URL`/`OPENAI_API_KEY=stub` — that would silently route
around the native gateway.

The actual `.plist` files in this directory are **gitignored** (they
embed secrets). Only the `.plist.template` files are tracked.

## First-time install

```bash
# Five plists today (M3, 2026-05-10): kos-compat-api + 4 cron services
for svc in kos-compat-api dream-cycle enrich-sweep kos-patrol notion-poller; do
  cp com.jarvis.$svc.plist.template com.jarvis.$svc.plist
done

# Edit each .plist and replace:
#   <FILL:NANO_BANANA_API_KEY>  → your Google GenAI key (every plist with this placeholder)
#   <FILL:KOS_API_TOKEN>        → kos-compat-api auth token (kos-compat-api.plist only)

# Install to LaunchAgents
for svc in kos-compat-api dream-cycle enrich-sweep kos-patrol notion-poller; do
  cp com.jarvis.$svc.plist ~/Library/LaunchAgents/
done
cp com.jarvis.kos-compat-api.plist ~/Library/LaunchAgents/
```

## Cutover sequence (Stage 3.2 — historical, 2026-04-16)

> ⚠️ This section describes the original v1 → v2 cutover. The
> `gemini-embed-shim` step has been retired by M3 cutover (2026-05-10).
> For a fresh install today, skip steps 2 + 5 below — `kos-compat-api`
> talks directly to the native v0.27 Vercel AI SDK gateway, no shim
> needed. The four cron services (dream-cycle, kos-patrol, enrich-sweep,
> notion-poller) just need their plists copied + bootstrapped; they
> inherit the same Google embedding env block.

```bash
# 1. Stop v1 kos-api.py (keeps plist on disk for rollback)
launchctl unload ~/Library/LaunchAgents/com.jarvis.kos-api.plist
lsof -i :7225 -P  # expect: no listeners

# 2. [RETIRED M3] Embed shim used to run on 7222 — no longer needed.
#    Native gateway uses GOOGLE_GENERATIVE_AI_API_KEY directly from the
#    plist EnvironmentVariables block.

# 3. Start kos-compat-api (takes over 7225)
launchctl load ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
sleep 2
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7225/health | jq .
# expect: {"status":"ok","brain":"/Users/chenyuanquan/brain","engine":"gbrain"}

# 4. End-to-end check via kos.chenge.ink (same domain, new backend)
curl -s -H "Authorization: Bearer $TOKEN" https://kos.chenge.ink/status | jq .
# expect: total_pages=2718 (or current count)
```

## Rollback

If any cutover step fails:

```bash
launchctl unload ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
launchctl load ~/Library/LaunchAgents/com.jarvis.kos-api.plist
# v1 back in control, 30 seconds max downtime
```

## Archive old service (after 7-day dual-read proven stable)

```bash
launchctl unload ~/Library/LaunchAgents/com.jarvis.kos-api.plist
mv ~/Library/LaunchAgents/com.jarvis.kos-api.plist ~/Library/LaunchAgents/_archive/
```

## Logs

- Compat:  `server/kos-compat-api.std{out,err}.log`
- Shim (retired M3, kept for git-history audit): `skills/kos-jarvis/_archived/gemini-embed-shim/shim.std{out,err}.log`
- v1 (idle since cutover 2026-04-16): `workers/kos-worker/server/kos-api.st*.log` (v1 repo)

## Watch the services

```bash
launchctl list | grep com.jarvis
# expect after M3 cutover:
#   PID  0  com.jarvis.kos-compat-api      (long-running, KeepAlive)
#   -    0  com.jarvis.dream-cycle         (cron, daily 03:11)
#   -    0  com.jarvis.kos-patrol          (cron, daily 08:07)
#   -    0  com.jarvis.notion-poller       (cron, every 5 min)
#   -    0  com.jarvis.enrich-sweep        (cron, weekly Sun 22:13)
```
