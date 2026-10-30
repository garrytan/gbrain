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
  watermark (config scalar) ◀──────────┘  advance once nothing still holds it back
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

The watermark moves forward only when nothing in the run still holds it back:
the conversation list loaded completely, no `--limit` cap cut the run short,
the run was not aborted, and every conversation that failed to fetch or ingest
has now failed three times at its current update time. That last case is
quarantine. On its third failure at the same `updatedAt` a conversation is
listed under `quarantined` in the sync result (`--json`) and stops blocking the
watermark, so the watermark can advance. Any other failed conversation keeps
the watermark where it is, so the next run lists it and tries again.
Re-imports are free (content-hash idempotency), so re-running is safe.

One conversation the brain refuses (a typed refusal such as `source_changed`)
fails alone: the rest of its batch still imports, and `gbrain connectors status
<provider> --json` shows the refusal's `code` on its row. Only a failure of the
run itself (a lost database connection, the writer unavailable, an abort)
stops the sync. On a managed brain, a conversation whose write was accepted but
has not published within the wait is listed under `pending`: it is not marked
synced and holds the watermark, and the next sync waits on that same write
instead of submitting a second one. If that write ends without committing, the
next sync submits it again.

A failed conversation is never forgotten. It stays in the source's failed
ledger until it imports, even after the watermark passes it and the provider
stops listing it. Each sync retries up to 10 due failures by id, oldest first,
and keeps slots for them under `--limit`. A quarantined conversation waits 1
hour, then 6 hours, then a day between attempts; an edit at the
provider or `--full` retries it at once. While any conversation is
unresolved, the sync status is `partial` and the result counts `unresolved`;
`gbrain connectors status <provider> --json` lists each one with its next
retry time, and `gbrain doctor` warns that the archive is incomplete. Aborting
a sync or an expired cookie never counts against a conversation. When a
`--full` listing no longer contains a failed conversation (it was deleted at
the provider), the sync drops it and lists it under `gone`.

Long messages are archived whole. A message too large for one page part
continues in the next block under the same speaker and time; redaction runs
over the whole message first.

### Recovering an archive synced before this fix

Two kinds of loss happened before the fix and leave no record a normal sync
can find:

- A conversation that failed three times while the watermark moved past it
  was dropped from the failed ledger and never imported.
- Every message longer than 4,000 characters was cut at 4,000 characters, and
  the sync deleted its download, so the page holds only the start.

One full re-sync recovers both, for conversations the provider still has. It
re-downloads your whole history with your saved session: many requests to the
provider, and pages whose text grows are re-imported (and re-extracted if fact
extraction is on). **Ask the user first**, then run:

```bash
gbrain connectors sync <chatgpt|claude> --full
```

Conversations the provider deleted, or no longer returns, can't be recovered
this way; use the official export if you still have one (`gbrain transcripts
ingest conversations.json` re-imports it in full). Claude failures recorded
before gbrain tracked their organization are held for the same `--full` run
(the sync hint and doctor name the command).

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

`connectors.<p>.auto_sync` is the owner's switch for every unattended run:
`connectors sync --all` syncs only providers whose `auto_sync` is on (it names
each one it skips on stderr), and a queued `connector-sync` job rechecks it when
it starts and returns `skipped` (`reason: auto_sync_off`) if it was turned off
while the job waited. Only an explicit `gbrain connectors sync <provider>`
(inline or `--background`) syncs a provider with `auto_sync` off.

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

## Request bounds

Every run has a hard ceiling, whatever the flags say:

| Bound | Value | When reached |
|---|---|---|
| Requests per run (every request: probe, list pages, conversations, token refreshes, retries) | 10,000 (`MAX_CONNECTOR_REQUESTS_PER_RUN`, about 2 hours at the 700 ms spacing) | `partial`, `stopReason: max_requests` |
| Requests per Claude organization per run | 5,000 (`CLAUDE_MAX_REQUESTS_PER_ORG`) | `partial`, `stopReason: max_requests` |
| Claude organizations listed per run | 10 (`CLAUDE_MAX_ORGS`) | the first 10 are synced; the listing counts as incomplete, so the run is `partial` and the watermark holds |
| List pages per pass (per organization for Claude) | 500 | the listing counts as incomplete (`partial`) |
| Items taken from one list page | the page size asked for (ChatGPT 28, Claude 100) | the rest of an over-long page is fetched on the next page; a page that also ignores `offset` is drift (`partial`), never a silently shortened list |

Lower the bound for one invocation with `--max-requests N` (1 to 10,000) or
`--deadline <duration>` (`90s`, `30m`, `2h`; with `--all` it covers every
provider together). Both are checked before each request and before each retry
wait, so a run never starts a request after its deadline. ChatGPT's token refresh
goes through the same client: it is paced and counted like any other request.

A run that stops at a bound keeps what it imported, leaves the watermark where it
was and records no failure against the conversations it did not reach. Continue
with `gbrain connectors sync <provider>` without `--full`: conversations already
imported are skipped, so each run gets further. (`--full` fetches every listed
conversation again, so a history larger than the ceiling never completes in one
`--full` run.)

## Feasibility caveat (Cloudflare)

`chatgpt.com` / `claude.ai` sit behind bot-management that fingerprints the
TLS/HTTP2 handshake, and `cf_clearance` is bound to a real browser. A server-side
`fetch` with a valid cookie may still draw a challenge, on a 403 or on any other status
(the `cf-mitigated: challenge` header, a challenge page, or a redirect to one). When that
happens the connector reports `forbidden` and points you at the official export lane; it
never loop-retries. Any other 403 (a JSON error body or a `www-authenticate` header)
ends the run as `auth_required` without a token refresh, and a redirect is never
followed (the cookie is only ever sent to the provider's own origin): it ends the run as
`auth_required` too. ChatGPT's token refresh obeys the same rules, so a refused refresh
reports `forbidden`, `rate_limited` or `auth_required`, and `connectors auth` reports
it without probing further. Sustained rate limiting ends the run as `rate_limited` instead of
working through the rest of the history, and five conversation fetches in a row that fail
with a server error or no response stop it as `partial` (`stopReason:
consecutive_fetch_failures`). If server-side fetch is reliably blocked in your environment, prefer
the export-file lane (`conversation-archive`) — it always works.

## Troubleshooting

<a id="chat-connectors-troubleshooting"></a>

| Symptom | Cause | Fix | Who acts | Consent | Verify |
|---|---|---|---|---|---|
| `forbidden` | Cloudflare/bot challenge on server-side fetch | Use the official export + `gbrain transcripts ingest` | user (downloads the export); agent ingests it | none | `gbrain connectors status --json` |
| `partial` with `stopReason: max_requests` or `deadline` | the run reached its request ceiling, `--max-requests` or `--deadline` ([request bounds](#request-bounds)) | Run `gbrain connectors sync <provider>` again, without `--full`; imported conversations are skipped | agent | `credentials` | `gbrain connectors status --json` |
| `connectors sync --all` prints `Skipped <p>: connectors.<p>.auto_sync is off` | that provider's owner has not opted in to unattended sync | Nothing, or sync it once explicitly with `gbrain connectors sync <p>`; `gbrain config set connectors.<p>.auto_sync true` opts in | user (decides on unattended sync) | `credentials` | `gbrain config get connectors.<p>.auto_sync` |
| `rate_limited` | the provider kept answering 429 after four retries, or asked for a wait over two minutes | Wait, then re-run; the next sync resumes where this one stopped. Don't loop it | agent | `credentials` | `gbrain connectors status --json` |
| `auth_required` with "cannot carry" in the hint | the saved cookie or token holds a line break, control or non-ASCII character (`invalid_header_value`); nothing was sent | Re-copy the Cookie header on one line, `gbrain connectors auth` | user (copies the cookie) | `credentials` | `gbrain connectors status --json` |
| `auth_required` | cookie expired/invalid | Re-copy a fresh Cookie header, `gbrain connectors auth` | user (copies a fresh Cookie header) | `credentials` | `gbrain connectors status --json` |
| `connectors auth` exits 1 with an `[AGENT]` cookie checklist | no credential and nobody at the terminal ([headless lane](#headless-lane-an-agent-without-a-terminal)) | Relay the `[SHOW USER]` checklist; the user pipes the cookie into `gbrain connectors auth <provider> --cookie -` | user (copies the cookie) | `credentials` | `gbrain connectors status --json` |
| `partial` | a conversation failed to fetch or import, the conversation list failed, or `--limit` capped the run | Re-run. A failed conversation is retried and holds the watermark until it imports. One that failed three times at the same update time is quarantined instead: it no longer holds the watermark and later syncs retry it on a backoff until it imports | agent | `credentials` (fetches from the provider again with the saved session) | `gbrain connectors status --json` |
| `partial` with `unresolved`, doctor says "archive incomplete" | conversations not archived yet | Nothing to do: sync retries them automatically. If `held` lists ids (or doctor's fix names `--full`), ask the user, then run `gbrain connectors sync <provider> --full` ([recovery](#recovering-an-archive-synced-before-this-fix)) | agent | `credentials` (`--full` re-downloads the whole history with the saved session) | `gbrain connectors status <provider> --json` |
| conversations or long-message tails synced before this fix are missing | lost before the fix; nothing records them | Ask the user, then run `gbrain connectors sync <provider> --full` once ([recovery](#recovering-an-archive-synced-before-this-fix)) | agent | `credentials` | `gbrain connectors status <provider> --json` |
| receipt shows drift | provider API shape changed | Affected threads skipped (not lost); export lane still works | agent (reports it) | none | `gbrain connectors status --json` |

## v2 roadmap

Perplexity live client (+ a native `perplexity` transcript adapter), an advisor
collector for connector health, multi-account per provider, attachment/image
capture, export-ZIP auto-unwrap, and a nightly spec-target drift probe.
