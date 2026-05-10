# notion-poller

Local launchd cron on Lucien's Mac. Polls configured Notion databases
every 5 minutes, detects new or updated pages, converts them to
markdown, and pushes to `kos-compat-api` on port 7225. The brain grows
without Lucien touching anything: writing in a monitored Notion DB is
the ingest gesture.

Companion to `workers/kos-worker/` (Notion-side, exposes AI tools to
notion jarvis). Where kos-worker is **ad-hoc pull** (notion jarvis
decides to call `kosIngest`), notion-poller is **ambient push** (any
page saved in a monitored DB lands in the brain within 5 minutes).

## Config

Lives entirely in `.env.local` at repo root (gitignored). Reads:

- `NOTION_TOKEN` — Notion internal integration token. Needs Read access
  to every monitored database. Not the same thing as the kos-worker
  OAuth token; that one is managed by Notion.
- `NOTION_DATABASE_IDS` — comma-separated database IDs (dashed or
  dashless 32-char UUIDs). Integration must be shared to each.
- `KOS_API_TOKEN` — bearer for `kos-compat-api` (already in `.env.local`).
- `POLLER_STATE_PATH` — optional, defaults to
  `~/brain/agent/notion-poller-state.json`. Tracks
  `last_edited_time` per DB so the poller only ingests fresh edits.

## Run modes

```bash
# Dry run: show what would be ingested, no HTTP write-side calls.
bun run workers/notion-poller/run.ts --dry

# Backfill: ignore saved state and ingest every page in every DB
# (idempotent — repeating is safe but expensive).
bun run workers/notion-poller/run.ts --backfill

# Normal: delta since last saved state, produces new ingests.
bun run workers/notion-poller/run.ts
```

## State

After each run the poller writes:

```jsonl
{
  "2026-04-17T19:00:00Z": {
    "<db_id>": {
      "last_edited_time": "2026-04-17T18:57:11.000Z",
      "pages_seen": 42,
      "pages_ingested": 3
    }
  }
}
```

to `POLLER_STATE_PATH`. Reset with `rm ~/brain/agent/notion-poller-state.json`
(next run becomes a backfill).

## Launchd

Installed via `scripts/launchd/com.jarvis.notion-poller.plist.template`.
Schedule: every 5 minutes (`StartInterval 300`). Gated on
`NOTION_TOKEN` being non-empty — if empty, the script exits cleanly
with a reminder message, so the plist is safe to load even before
Lucien fills the token in.

```bash
cp scripts/launchd/com.jarvis.notion-poller.plist.template \
   scripts/launchd/com.jarvis.notion-poller.plist
cp scripts/launchd/com.jarvis.notion-poller.plist \
   ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.jarvis.notion-poller.plist
```

## Design notes

- **Polling over webhooks** — webhooks require a public HTTPS endpoint
  for Notion to hit; cloudflared already exposes `kos.chenge.ink` but
  adding a webhook receiver there means another auth surface to babysit.
  5-minute polling is good enough and the failure mode is just lag.
- **Mark-and-fetch, not mark-and-sweep** — poller never deletes. If a
  page is deleted in Notion, the brain page sticks around with
  `status: deprecated` marked on next touch. Manual cleanup via
  `gbrain delete <slug>`.
- **Markdown conversion is coarse** — Notion blocks are flattened to
  plain markdown (headings, paragraphs, lists, code, quotes). Complex
  blocks (databases, synced blocks, embeds) degrade to a link pointing
  back at the Notion page. Good enough for reading; not a full export.
- **Idempotent ingest** — re-ingesting the same `notion_id` overwrites
  the gbrain slug via `gbrain put`. History is preserved in gbrain's
  internal versioning, not here.

## Failure modes

| Problem | Symptom | Fix |
|---------|---------|-----|
| NOTION_TOKEN missing | Logs `"NOTION_TOKEN not set, skipping run"`, exits 0 | Fill in `.env.local`, reload plist |
| Integration not shared to DB | 404 from Notion API | Share integration: DB → Connections → Add connection |
| kos-compat-api down | Connection refused | `launchctl kickstart -k gui/$(id -u)/com.jarvis.kos-compat-api` |
| Google embed quota | Embed fails with `exceeded your current quota` | Wait for next quota window (Google free-tier resets per-minute RPM + per-day TPM); rerun `gbrain embed --stale` to backfill |
| Notion rate limit | 429 from Notion API | Script respects `Retry-After`; if persistent, reduce poll interval |

## Verification

After enabling:
1. Create a new page in any monitored DB, type a few paragraphs.
2. Within 5-10 minutes, check:
   ```bash
   curl -s -H "Authorization: Bearer $KOS_API_TOKEN" \
     https://kos.chenge.ink/status | jq .total_pages
   ```
   Count should increase by 1.
3. Confirm the page is searchable:
   ```bash
   gbrain query "<text from the Notion page>"
   ```

## Related

- `workers/kos-worker/` — Notion-side worker, exposes AI tools
- `server/kos-compat-api.ts` — /ingest handler that accepts `markdown`
- `docs/NOTION-JARVIS-WORKER-USAGE.md` — message to notion jarvis on how
  to use the kos-worker tools
