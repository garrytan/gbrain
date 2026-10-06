# Chat Connectors — live sync of ChatGPT + Claude history

Chat connectors sync your own AI-assistant conversation history into the brain
using your own session credential, incrementally and (opt-in) on a schedule.
They are the LIVE front-end to the export-file lane the `conversation-archive`
skill already documents: fetch replaces the manual download, and everything
downstream (redaction, slugging, part-splitting, idempotency) is the exact
`gbrain transcripts ingest` pipeline.

Live providers: **ChatGPT** and **Claude**. Perplexity has no live
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

A usage error (no provider, an unknown provider, or `--source` without a
value) exits 2 with an `invalid_params` error; under `--json` it is one
envelope whose `fix` is the corrected command (`gbrain connectors sync --help`
prints the usage).

`gbrain connectors status` shows credential provenance/expiry and sync state
(never the secret). `gbrain connectors logout <provider>` removes a credential.

### Headless lane (an agent without a terminal)

The credential is the user's own browser session, so an agent cannot sign in
for them. When `gbrain connectors auth <provider>` runs with no credential and
nobody at the terminal (no TTY, `CI`, an agent process, or
`GBRAIN_NON_INTERACTIVE=1`), it does not wait for a paste:

- It prints an `[AGENT]` block (`actor: user`, `next: tell_user_to_run`) with
  the provider's cookie checklist fenced in `[SHOW USER]` and the stdin command
  to run, saves nothing, and exits 1.
- `--try-oauth` never starts the loopback sign-in headless; it says OAuth
  needs a person at a browser and hands over the same cookie checklist. With a person at the
  terminal, `--no-browser` prints the sign-in URL instead of opening a browser.

What the agent does: relay the `[SHOW USER]` text verbatim and ask the user to
copy the cookie from a browser where they are logged in (never reuse, guess or
search for one). The user can run `pbpaste | gbrain connectors auth <provider>
--cookie -` themselves; if they hand the value over, pass it only on stdin
(`printf '%s' "$COOKIE" | gbrain connectors auth <provider> --cookie -`), never
in argv. A stdin that stays open without data ends after 30 seconds ("stdin
was open but silent"; `GBRAIN_STDIN_TIMEOUT_MS` waits longer) and saves
nothing. If the user would rather not share a session cookie, use the export
lane (`gbrain transcripts ingest <export-file>`). Verify with
`gbrain connectors status --json`. The full agent script lives in
`skills/chat-connectors/SKILL.md`.

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

## Feed imported conversations to Dream

Every imported session (connectors, `gbrain transcripts ingest` of a Hermes
`state.db`, Claude or ChatGPT export) is a `type: conversation` page. Dream's
synthesize phase reads those pages from the database, in the cycle's source
(`gbrain dream --source <id>`), beside any `dream.synthesize.session_corpus_dir`
files. `--date` / `--from` / `--to` filter on the page's `date` frontmatter;
`dream.synthesize.min_chars` and `exclude_patterns` apply as for corpus files;
a page is judged and synthesized again only after its text changes.

| Setting | Effect |
| --- | --- |
| `session_corpus_dir` set, `conversation_pages` unset | corpus files + conversation pages |
| `gbrain config set dream.synthesize.conversation_pages true` | conversation pages, with or without a corpus dir |
| `gbrain config set dream.synthesize.conversation_pages false` | corpus files only |

With neither a corpus dir nor `conversation_pages` set, synthesis is not
configured; when the source holds conversation pages the phase warns
`conversation_pages_not_consumed` and names the opt-in command (synthesis makes
paid model calls, so it never starts on its own). Setting the key to `false`
silences the warning.

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

<a id="chat-connectors-troubleshooting"></a>

| Symptom | Cause | Fix | Who acts | Consent | Verify |
|---|---|---|---|---|---|
| `forbidden` | Cloudflare/bot challenge on server-side fetch | Use the official export + `gbrain transcripts ingest` | user (downloads the export); agent ingests it | none | `gbrain connectors status --json` |
| `auth_required` | cookie expired/invalid | Re-copy a fresh Cookie header, `gbrain connectors auth` | user (copies a fresh Cookie header) | `credentials` | `gbrain connectors status --json` |
| `connectors auth` exits 1 with an `[AGENT]` cookie checklist | no credential and nobody at the terminal ([headless lane](#headless-lane-an-agent-without-a-terminal)) | Relay the `[SHOW USER]` checklist; the user pipes the cookie into `gbrain connectors auth <provider> --cookie -` | user (copies the cookie) | `credentials` | `gbrain connectors status --json` |
| `partial` | some fetches failed | Watermark not advanced; just re-run | agent | `egress` (fetches from the provider again) | `gbrain connectors status --json` |
| receipt shows drift | provider API shape changed | Affected threads skipped (not lost); export lane still works | agent (reports it) | none | `gbrain connectors status --json` |

## v2 roadmap

Perplexity live client (+ a native `perplexity` transcript adapter), an advisor
collector for connector health, multi-account per provider, attachment/image
capture, export-ZIP auto-unwrap, and a nightly spec-target drift probe.
