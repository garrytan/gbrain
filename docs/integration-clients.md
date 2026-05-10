# Integrating with `kos-compat-api`

> Audience: external agent owners (OpenClaw 飞书 skill, Notion Knowledge
> Agent, future webhook receivers) — anyone calling `kos-compat-api`
> from outside the `jarvis-knowledge-os-v2` repo.
>
> If you only run code inside this repo, you don't need this file:
> `workers/notion-poller/` and the launchd plists are already wired
> correctly via `.env.local` + `KOS_API_PORT=7225`.

## Endpoints

| Environment | Base URL | Notes |
|---|---|---|
| Production (external) | `https://kos.chenge.ink` | Cloudflare tunnel → `127.0.0.1:7225`. Stable boundary; do not depend on the tunnel's internal port. |
| Local dev (same host) | `http://127.0.0.1:7225` | Direct connection. Skip TLS, skip cloudflared. |

Auth on every request:

```
Authorization: Bearer $KOS_API_TOKEN
```

`KOS_API_TOKEN` is rotated rarely. Coordinate before changing it; the
external `.env.local` plus every connected agent need to update together.

## Routes

| Method | Path | Purpose | Typical latency |
|---|---|---|---|
| POST | `/ingest` | Fetch URL → write to `~/brain/<kind>/<slug>.md` → `gbrain sync` → embed | **20–80 s warm, up to ~210 s under contention** |
| POST | `/query` | `gbrain ask <question>` over Postgres | 1–80 s (depends on retrieval depth) |
| GET  | `/status` | Direct Postgres inventory (page counts by kind/type/confidence) | < 200 ms |
| GET  | `/digest?since=N` | Latest `kos-patrol` digest for the last N days | < 500 ms |
| GET  | `/health` | Liveness + brain dir + engine label | < 50 ms |

## Three rules every client MUST follow

These are not optional. They were learned the hard way; ignoring them
will cause cascading slowdowns or silent data loss.

### Rule 1: `/ingest` timeout ≥ 240 seconds

`/ingest` is *not* a microservice call. Each request runs the full
pipeline: HTTP fetch the URL → write the markdown file → `gbrain sync`
→ git commit → embed via Gemini shim. Cold path is normally 20–80 s,
but contention with concurrent ingests, dream-cycle, or kos-patrol can
push p99 past 200 s.

Set the client HTTP timeout to **at least 240 seconds**. If your
framework defaults to 30 s or 60 s, raise it explicitly for this
endpoint.

If the timeout fires, **do not retry blindly** — see Rule 2.

### Rule 2: never retry a slow `/ingest` without checking server state first

`gbrain` runs ingests serially through a single CLI subprocess. If your
client times out and re-fires the same URL, you create a cascade:

```
t0   client POST /ingest <url>          → server starts pipeline
t60  client times out, retries          → server starts a SECOND pipeline
                                          (queued behind the first)
t120 client times out again, retries    → THIRD queued pipeline
...
t300 first request finally completes (now at 300 s, not 60 s, because
     the queue dragged it out)
```

This is exactly what produced the 22:18–22:23 incident on 2026-05-01.
Four parallel ingests of the same URL ran in series, each one ~213 s,
with no useful work happening for 14 minutes.

**Correct retry policy** (in order of preference):

1. **No retry.** Let the timeout surface to the user; they re-trigger
   if they want. `kos-compat-api` is idempotent on URL — re-running
   ingests the same slug, nothing breaks.
2. **Backoff retry with health probe.** Before retrying, `GET /status`
   (which is < 200 ms even under load). If `/status` returns, the
   server is alive and the previous request is probably still in
   flight; wait at least 60 s before considering a retry.
3. **Idempotency key (preferred for high-volume callers).** Generate
   a request UUID, store it client-side; if the original request
   eventually returns 200, discard the retry response. Never let two
   in-flight `/ingest` calls for the same URL coexist.

### Rule 3: embed failure is NOT ingest failure

When `/ingest` succeeds at the file-write step but the embed step fails
(e.g. Gemini quota, billing card expired, transient 5xx), the response
is:

```json
{
  "imported": true,
  "slug": "sources/<slug>",
  "wrote_to": "/Users/chenyuanquan/brain/sources/<slug>.md",
  "commit": "committed",
  "warning": "embedding failed: <details>"
}
```

The page **is** in the brain. It will be picked up by the next
`gbrain embed --stale` run (kicked off automatically by `dream-cycle`
or manually with `gbrain embed --slugs <slug>`).

**Do not retry the entire ingest pipeline because embed failed.** That
re-fetches the URL, re-writes the same file, re-runs sync, re-attempts
embed — which costs ~70 s of compute to maybe re-fail at the same
embed step. Instead:

- Treat `imported: true` as success.
- Surface the `warning` to the user (so they know vector search is
  briefly unavailable for this page).
- Let the background sweep recover; or, if urgent, call `gbrain embed
  --slugs <slug>` directly on the host.

## Request shapes

### `POST /ingest`

Two input modes:

```json
// Mode 1: provide URL, server fetches
{
  "url": "https://example.com/article",
  "kind": "source"            // optional; auto-detected if omitted
}

// Mode 2: provide markdown directly (used by notion-poller)
{
  "markdown": "# Title\n\nBody text…",
  "title": "Page title",
  "source": "notion:<page_id>",
  "notion_id": "<uuid>",
  "kind": "source"
}
```

`kind` controls which `~/brain/<dir>/` the page lands in. Unknown kinds
default to `sources/`. Valid values: `source`, `concept`, `project`,
`entity`, `synthesis`, `comparison`, `protocol`, `decision`, `timeline`.

Response on success:

```json
{
  "imported": true,
  "slug": "sources/<slug>",
  "wrote_to": "<absolute path>",
  "commit": "committed",
  "engine": "gbrain (postgres)"
}
```

### `POST /query`

```json
{
  "question": "What's our current strategy on X?",
  "limit": 10            // optional, default 10
}
```

Returns gbrain's hybrid-search results with snippets and slugs.

### `GET /status`

Lightweight health + inventory; safe to poll once per minute as a
liveness probe.

```json
{
  "total_pages": 2424,
  "by_type": { "source": 1546, "concept": 208, ... },
  "by_kind": { ... },
  "engine": "gbrain (postgres)",
  "brain": "/Users/chenyuanquan/brain"
}
```

## Failure envelope

Errors are JSON, never HTML, never plain text:

```json
{ "error": "unauthorized" }                             // 401
{ "error": "missing required field: url" }              // 400
{ "imported": false, "error": "fetch 404: ..." }        // 200 with body
{ "imported": false, "output": "GBrain: ..." }          // 500
```

Any 5xx with `output` field carries the underlying `gbrain` CLI stderr
tail — useful for filing a bug, not useful for retry logic. Treat 5xx
the same as Rule 2 dictates: probe `/status` before retry.

## Cron + scheduled callers

If you call `/ingest` on a schedule (cron, launchd, systemd timer):

- **Stagger** runs across the hour. Don't pile every poller at `:00`.
- **Cap concurrency at 1 per client.** Multiple clients are fine; one
  client firing two parallel ingests is asking for cascade trouble.
- **Log the slug you sent**, not just the response. If the response
  hangs, the slug is what lets us correlate with `kos-compat-api`'s
  stdout to confirm whether the request was received.

## Quick smoke test for new integrators

```bash
# Liveness
curl -sS -H "Authorization: Bearer $KOS_API_TOKEN" \
  https://kos.chenge.ink/status | jq .total_pages

# Round-trip ingest (small page; ~5 s warm)
curl -sS --max-time 240 \
  -X POST https://kos.chenge.ink/ingest \
  -H "Authorization: Bearer $KOS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","kind":"source"}'

# Round-trip query
curl -sS --max-time 60 \
  -X POST https://kos.chenge.ink/query \
  -H "Authorization: Bearer $KOS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"hello"}'
```

If `/status` returns 200 but `/ingest` times out, the server is fine
and your timeout is too short — go fix the client config, not the
server.

## Related

- [`workers/notion-poller/README.md`](../workers/notion-poller/README.md)
  — in-repo polling client (correct reference implementation of these
  three rules).
- [`server/kos-compat-api.ts`](../server/kos-compat-api.ts) — server
  source.
- [`skills/kos-jarvis/_archived/feishu-bridge/SKILL.md`](../skills/kos-jarvis/_archived/feishu-bridge/SKILL.md)
  — archived 2026-05-05: migration manifest for the OpenClaw 飞书 skill
  (the OpenClaw extension was retired at the same time; doc preserved
  for historical reference).
- `docs/JARVIS-ARCHITECTURE.md` §6.18 — Postgres migration story
  (explains why ingest latency was lower on PGLite under low load but
  caps higher under contention).
