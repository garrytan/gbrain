# Chat Connectors — live sync of ChatGPT + Claude history

Chat connectors sync your own AI-assistant conversation history into the brain
using your own session credential, incrementally and (opt-in) on a schedule.
They are the LIVE front-end to the export-file lane the `conversation-archive`
skill already documents: fetch replaces the manual download, and everything
downstream (redaction, slugging, part-splitting, idempotency) is the exact
`gbrain transcripts ingest` pipeline.

Providers in v1: **ChatGPT** and **Claude** (both live). Perplexity has no live
connector yet (no transcript adapter) — use the conversation-archive manual
conversion for it.

## Quick start

**Say to your agent:** *"Connect my chatgpt account and pull my whole history into
the brain"* — *"Connect my claude account"* — *"Keep my conversations synced
automatically."* The chat-connectors skill walks the whole flow: cookie capture,
dry-run → sample → full backfill, and the opt-in schedule. The commands below are
the manual path.

```bash
# 1. Connect (cookie paste-in is the primary lane; kept out of argv via stdin)
gbrain connectors auth chatgpt --cookie -      # paste the Cookie header, Ctrl-D
gbrain connectors auth claude  --cookie -      # paste `sessionKey=<value>`, Ctrl-D

# 2. First sync (preview → sample → full)
gbrain connectors sync chatgpt --dry-run
gbrain connectors sync chatgpt --limit 5
gbrain connectors sync chatgpt --full

# 3. (optional) keep it synced automatically — opt-in, daily
gbrain config set connectors.chatgpt.auto_sync true
gbrain autopilot --install
```

`gbrain connectors status` shows credential provenance/expiry and sync state
(never the secret). `gbrain connectors logout <provider>` removes a credential.

## How it works

```
  cookie/token (~/.gbrain/connectors/<p>.json, 0600)
        │
        ▼
  ConnectorClient ── list (metadata, newest-first, stop at watermark−7d)
        │                 └─ archived second pass (ChatGPT)
        ▼
  fetch each new conversation ──▶ spool (native-export shape, 0600, batched)
        │                              │
        │                              ▼
        │                    runTranscriptsIngest  (redact → slug → split → import)
        ▼                              │
  watermark (config scalar) ◀──────────┘  advance ONLY on a fully clean run
  connectors.<p>.watermark_iso           receipt → ingest_log; stamp last_sync_at
```

### Incremental sync + gap-heal

Each provider keeps a watermark in the **config table**
(`connectors.<provider>.watermark_iso`) — the newest conversation update-time
imported. Later runs list newest-first and stop at `watermark − windowDays`
(default 7), so:

- only genuinely new conversations are fetched (detail fetches are the expensive
  part; the metadata list is cheap and paginated), and
- a conversation edited just behind the watermark (within the trailing window)
  is re-listed and re-imported in place — no silent gap.

The watermark advances **only on a fully clean run** (no fetch errors, no
`--limit` cap, clean ingest). A `partial` run leaves it untouched so the next run
heals. Re-imports are free (content-hash idempotency), so re-running is always
safe.

The watermark is deliberately a config scalar, **not** `op_checkpoint`:
`op_checkpoint` stores a completed-key set (no scalar timestamp) and GCs rows
after 7 days, which would wipe the watermark on any gap longer than a week and
trigger a full re-fetch of your entire history — the exact traffic pattern most
likely to trip a provider's anti-abuse. The config table is durable and never
GC'd.

## Automation lanes

Scheduled sync is **opt-in per provider** and **daily by default**. It polls your
account on a cadence — that is your account making automated requests, so it is
off until you enable it.

- **Autopilot (preferred, harness-agnostic):** `gbrain autopilot --install`
  installs the right OS tick (launchd / systemd / crontab / container start
  script) and runs the dispatch. It is credential-gated and auto_sync-gated, and
  a dead cookie stops it (and surfaces in `gbrain doctor`).
- **Host cron (daemonless):** `0 6 * * * gbrain connectors sync --all` (daily).
  Tune the floor with `gbrain config set connectors.sync_floor_min <minutes>`
  (default 1440).

On PGLite (the default engine, no worker daemon) sync runs inline; on Postgres,
`--background` submits a `connector-sync` minion job (single-flight per provider).

## Config keys

| Key | Default | Meaning |
|---|---|---|
| `connectors.source_id` | `default` | Source the pages land in. |
| `connectors.sync_floor_min` | `1440` | Scheduled-sync cadence floor (minutes). |
| `connectors.embed_kickoff_min_pages` | `25` | Embed backfill after a run importing ≥ this many pages. |
| `connectors.doctor_stale_hours` | `72` | `gbrain doctor` flags a stalled auto-sync past this. |
| `connectors.<p>.auto_sync` | off | Opt-in scheduled sync for a provider. |
| `connectors.<p>.last_sync_at` | — | Stamped each run (staleness gate). |
| `connectors.<p>.auth_error_at` | — | Stamped on a dead credential. |
| `connectors.<p>.watermark_iso` | — | Incremental watermark. |

Env override for a credential (incident escape hatch):
`GBRAIN_CONNECTOR_<PROVIDER>_COOKIE` / `_TOKEN`.

## Security & posture

- Credentials are session cookies / tokens — password-equivalent. They live
  file-plane at `~/.gbrain/connectors/<provider>.json` (0600, dir 0700), never in
  the DB, `sources.config`, the config planes, or any op payload. The only
  network egress is to the provider's own host.
- Transcripts are redacted (secret patterns) before any page is written, exactly
  as the export-file lane does; the spool is 0600 and pruned after ingest.
- These are ops-facing, local-only operations (the `connectors_status` /
  `connector_sync` ops are `localOnly` and never expose a credential over MCP).
- You are syncing your own conversation data with your own account — the same
  data the provider's official export contains. Keep the cadence polite (daily
  default) so automated polling doesn't risk your account.

## Feasibility caveat (Cloudflare)

`chatgpt.com` / `claude.ai` sit behind bot-management that fingerprints the
TLS/HTTP2 handshake, and `cf_clearance` is bound to a real browser. A server-side
`fetch` with a valid cookie may still draw a 403 challenge. When that happens the
connector reports `forbidden` and points you at the official export lane; it never
loop-retries. If server-side fetch is reliably blocked in your environment, prefer
the export-file lane (`conversation-archive`) — it always works.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `forbidden` | Cloudflare/bot challenge on server-side fetch | Use the official export + `gbrain transcripts ingest` |
| `auth_required` | cookie expired/invalid | Re-copy a fresh Cookie header, `gbrain connectors auth` |
| `partial` | some fetches failed | Watermark not advanced; just re-run |
| receipt shows drift | provider API shape changed | Affected threads skipped (not lost); export lane still works |

## v2 roadmap

Perplexity live client (+ a native `perplexity` transcript adapter), an advisor
collector for connector health, multi-account per provider, attachment/image
capture, export-ZIP auto-unwrap, and a nightly spec-target drift probe.
