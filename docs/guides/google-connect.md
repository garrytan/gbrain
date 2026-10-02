# Connecting Google (Gmail, Calendar, Contacts)

gbrain's google connector ingests your Gmail threads, calendar events, and
contacts into your brain and runs the [open-loop engine](open-loops.md) on
top: *who is waiting on you, what you promised, and the context needed to
respond.*

Everything is **bring-your-own OAuth**: you create your own (free) Google
Cloud OAuth client, so you own the app, the quota, and the tokens. Tokens
live only in your local credential vault (`~/.gbrain/credentials.json`,
mode 0600). The connector is read-only — it never writes to your Google
account (`gmail.readonly`, `calendar.readonly`, `contacts.readonly`).

## The fast path (one command)

```bash
gbrain google setup
```

`setup` walks the whole chain idempotently: guided credential intake →
consent → source registration → a first sync (newest mail first, budgeted so
it finishes fast; the deep backfill resumes automatically on later syncs) →
your first `gbrain waiting` digest. Re-running it is always safe — it
detects what's done and continues.

The pieces, if you want them separately:

```bash
gbrain google connect                 # credentials + consent only
gbrain sources add gmail-you --kind google --account you@example.com
gbrain sync --source gmail-you
gbrain waiting
```

## One-time Google Cloud setup (~7 minutes)

You need a Desktop-app OAuth client in your own Google Cloud project.
`gbrain google connect` prints this exact checklist when no credentials are
on file:

1. Create (or pick) a project: <https://console.cloud.google.com/projectcreate>
2. Enable the three APIs (one click each):
   - Gmail: <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
   - Calendar: <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
   - Contacts (People): <https://console.cloud.google.com/apis/library/people.googleapis.com>
3. Configure the consent screen: <https://console.cloud.google.com/auth/overview>
   - **Google Workspace account** → user type **Internal**. Done — no
     verification, tokens never expire weekly.
   - **Personal gmail.com** → user type **External**, then BOTH:
     a. add your own email as a **Test user** (<https://console.cloud.google.com/auth/audience>), and
     b. click **Publish app** on that same page. *Skipping this makes Google
     silently revoke your tokens every 7 days* — the single most common
     failure in the wild.
4. Create the OAuth client: <https://console.cloud.google.com/auth/clients>
   — application type **Desktop app** (NOT "Web application").
5. Click **Download JSON**.

Then:

```bash
gbrain google connect --client-json ~/Downloads/client_secret_*.json
```

You can also paste the JSON contents on stdin (`--client-json -`), export
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, or type the pair at the prompt.
Pasted values are sanitized (smart quotes, stray whitespace) and validated
by shape before anything talks to Google.

gbrain records the scopes Google *actually granted* (the consent screen lets
you uncheck scopes), so a narrower-than-needed grant surfaces immediately as
`scope_missing` with the reauth fix attached — never as opaque per-sweep 403s.

During consent Google shows **"Google hasn't verified this app."** That is
YOUR app — click *Advanced → Continue*.

## Headless / SSH / agent-on-another-machine

The connector auto-detects environments where a local browser can't open
(SSH, WSL, containers, no display) and switches to **paste-back mode**: it
prints the consent URL; you open it anywhere, approve, and the browser fails
to load a `http://127.0.0.1:41999/...` page — that's expected. Copy that
page's full address-bar URL and paste it back (interactive prompt), or
complete non-interactively:

```bash
gbrain google connect --paste          # prints the URL, stores flow state
gbrain google connect --code "http://127.0.0.1:41999/?code=...&state=..."
```

Force it anytime with `--paste` or `GBRAIN_FORCE_PASTE=1`.

Note: Google's device-code flow is **not** an option — Gmail/Calendar/
Contacts scopes are excluded from it by Google. Loopback + paste-back is the
supported path.

## Multiple accounts

Repeat `gbrain google connect --account work@yourco.com` per account; each
account becomes its own source (`gbrain sources add gmail-work --kind google
--account work@yourco.com`) with independent sync cursors and locks.

## Secondary calendars

The calendar sweep reads ONE calendar per source (so each keeps its own
incremental sync token) and defaults to the account's primary calendar.
Shared, subscribed, and secondary calendars the granted `calendar.readonly`
scope already covers are ingested by pointing an additional source at them:

```bash
gbrain google calendars                 # list every calendar the account can
                                        # read (* marks the primary), with ids
gbrain google calendars --json          # { ok, status, account, calendars[],
                                        #   next_action.command } for agents
gbrain sources add family-cal --kind google --account you@example.com \
  --services calendar --calendar-id "family0123456789@group.calendar.google.com"
```

**Say to your agent:** *"list the calendars my google account can read"* —
*"ingest my family calendar into the brain"* (your agent runs
`gbrain google calendars`, then `gbrain sources add … --calendar-id <id>`).

Each source's incremental sync token is bound to the calendar it was minted
for. Re-pointing an existing source at a different calendar (its
`g_calendar_id` config key) is safe: the next sweep notices the change, logs
`[google] calendar changed (<old> → <new>)`, discards the old cursor, and
re-lists the new calendar from a fresh window instead of replaying the old
calendar's delta. Pages already imported from the previous calendar stay in
the brain until you remove them — they are not reconciled automatically.

## Calendar window

The calendar keeps pages for events from `--history-days` back to 60 days
ahead. Every sweep enforces that window itself, including incremental
syncs: a change to a recurring series makes Google return every instance of
it, years in both directions, and only the ones inside the window become
pages. As days pass, the sweep lists the newly reached stretch of the
60-day horizon, so upcoming instances of an unchanged series still arrive.

`gbrain sync --source <id> --full` also soft-deletes calendar pages that the
sweep wrote outside that window (they stay recoverable for 72 hours before
the autopilot purge). Meetings imported while they were inside the window
are kept after they age out. More than 200 deletions in one run are refused
and the run is reported partial; to clean up a large backlog, run it once
with `GBRAIN_ALLOW_MASS_RECONCILE=1`.

**Say to your agent:** *"clean up the far-future calendar pages in my
brain"* (your agent runs `gbrain sync --source <id> --full`, and with your
go-ahead repeats it with `GBRAIN_ALLOW_MASS_RECONCILE=1` if the mass-delete
guard refuses).

## Continuous sync

Google sources are ordinary gbrain sources: `gbrain sync --source <id>`,
`gbrain sync --all`, autopilot, and the dream cycle all pick them up. A bare
un-targeted `gbrain sync` (repo mode) does not — target it or use `--all`.
Health: `gbrain google status` (live refresh probe per account) and
`gbrain doctor` (the `google_oauth` check warns once a Testing-mode account
goes 5+ days without a successful refresh — note an account that refreshes
daily gets no pre-warning before Google kills Testing-mode tokens at day 7;
publishing to Production is the real fix). Once you publish the app to
Production, record it by re-running consent —
`gbrain google connect --reauth <email> --consent-state production` — so the
weekly-expiry warning stops firing. Less-common flags
(`--via`, `--no-browser`, `--no-probe`, `--purge-client`, and setup's
`--history-days` / `--sync-budget-ms`): `gbrain google --help`. The `--via`
hosted fast path (a verified OAuth client brokering consent, tokens still
stored locally) is feature-gated off until the relay server exists; its full
design lives at
[`docs/designs/HOSTED_OAUTH_RELAY.md`](../designs/HOSTED_OAUTH_RELAY.md).

Sync freshness is honest by construction: the GMAIL sweep's success gates the
source's synced stamp (it protects loop freshness — the thing `gbrain
waiting`'s staleness gate exists to guard); contacts/calendar failures mark
the run partial without blocking it. Current mail comes first: each sync
drains the history delta (and any gap left by an expired history token)
before it continues the historical backfill, and the source is fresh once the
delta is drained, no gap is open and the last 14 days are imported, while the
deep backfill carries on. A thread that keeps failing is held (see
[Held items](#held-items)) instead of wedging the sync. Autopilot keeps a
source synced after its first sync; a source that has never synced stays idle
until you run `gbrain sync --source <id>` once.

### Rate limits during backfill

A large mailbox backfilling a wide `--history-days` window can trip Gmail's
per-user rate limit in bursts — Google answers with HTTP 403
(`rateLimitExceeded` / `userRateLimitExceeded`) or 429, and it clears on its
own within seconds to low minutes. The client retries a rate-limited request
patiently — 6 attempts by default, exponential backoff with jitter capped at
60s, honoring `Retry-After` when Google sends one — before finally giving up
and reporting `rate_limited`. That budget is deliberately much larger than
the 2-attempt budget used for other retryable failures (like a 401 needing a
token refresh): giving up too early used to mean a thread that would have
succeeded a few seconds later was instead skipped for the rest of the sync.

Even when a thread's retry budget IS exhausted, a rate-limit failure is never
counted toward a hold — unlike a genuine per-thread
failure (a malformed message, a permissions edge case), a rate limit says
nothing about that specific thread, so the sweep keeps retrying it on every
future run instead of silently giving up on it.

## Held items

A connector item that fails with an item-scoped error on three consecutive
syncs is **held**: it is recorded in the source's cursor state, and the sync
moves on past it instead of wedging the whole source. A held item is never
skipped silently:

- `gbrain sources status` lists up to 10 held items per source (key, sender and
  subject or title when known, error code, class, first and last failure,
  attempts, next automatic retry), then `+N more; --json lists all`;
- `gbrain doctor` reports a per-source count in the `connector_held_items`
  check;
- the sync summary prints the held count and the retry command;
- for Gmail, `gbrain waiting` returns `completeness: "partial"` and names each
  held thread from the last 14 days (or with an unknown date).

A held item does not block the source's freshness stamp. To re-attempt:

```bash
gbrain sources status <id>          # what is held and why
gbrain sources retry-held <id>      # schedule every held item (add --dry-run to preview)
gbrain sync --source <id>           # run the re-attempt now
gbrain sources status <id>          # a recovered item leaves the list
```

`gbrain sync --source <id> --full` also clears every hold. A held item whose
upstream copy changes is re-attempted once automatically.

**The thresholds are fixed** so every brain behaves the same way and a held
item always means the same thing:

| Rule | Value | Why it is fixed |
| --- | --- | --- |
| Hold after | 3 consecutive attempted syncs that failed for that item, at the same upstream version | Long enough to ride out a flaky run, short enough that one bad item cannot pin the cursor for days |
| Never counted | Rate limits, and source-level errors (auth, config, writer coordination, lock and statement timeouts, database contention) | They say nothing about the item |
| Circuit breaker | A sync with at least 5 attempted items counts nothing when at least half of them failed transiently, or when at least 5 and at least half failed with the same error code | A provider outage must not hold healthy items |
| Transient retry | A held item whose error was transient (5xx, network, unknown) is retried after 1 h, 6 h, 24 h, then daily, for 7 days; after that it stays held like a content error | Recovers on its own from a provider incident |
| Cap | 100 held items per source; a sync that would hold more stops advancing its cursor and fails with `connector_holds_exhausted` | Many held items means something is wrong with the source, not with items |

The overrides are `gbrain sources retry-held <id>` and
`gbrain sync --source <id> --full`. See
[write refusal reasons](write-refusals.md) for `connector_holds_exhausted`,
`invalid_connector_text` and `connector_fence_below_timeline`.

## Other ways to reach Google (no gbrain OAuth)

If your stack already holds Google access another way — a Google CLI with its
own auth store, `gcloud`, or a credential gateway that can mint short-lived
access tokens — the source can use it directly and skip gbrain's OAuth flow
entirely. `--account` stays required as the IDENTITY (it drives "is this
message mine" loop direction and the Gmail deep links' `authuser`); no
credential is stored in gbrain for these modes.

**Say to your agent:** *"connect my gmail through my existing Google CLI —
your agent runs `gbrain sources add <id> --kind google --access command
--token-command \"<your token command>\" --account <email>`"*

```bash
# Any command that prints an access token (bare token, or JSON with a
# token/access_token field and optional expiry/expires_in). gbrain runs it
# at sync time and caches the token until it expires; it never stores it.
gbrain sources add gmail-work --kind google --account you@example.com \
  --access command --token-command "gcloud auth print-access-token"

# Or read a live token from an env var refreshed by something outside gbrain
# (a gateway sidecar, a cron job). The var NAME goes in config, never a value.
gbrain sources add gmail-work --kind google --account you@example.com \
  --access env --token-env GOOGLE_ACCESS_TOKEN
```

What changes vs the vault flow: `gbrain google status`'s refresh probe and
`gbrain doctor`'s `google_oauth` check cover vault accounts only (your
external tool owns token health); the scope preflight trusts `--services`
(a token missing a scope surfaces as `api_not_enabled`/`upstream` per sweep
instead of `scope_missing`); send-as aliases are fetched live when the token
allows it, otherwise identity degrades to the account address alone. The
token command runs locally at sync time with your shell — it lives in local
source config, is never reachable over MCP, and is the same trust class as a
recipe health-check command. Failures surface as `access_command_failed` /
`access_env_missing` with the fix attached.

## Troubleshooting

Every failure the connector can hit maps to a typed error with the fix
attached. The catalog (also emitted as structured JSON with `--json`):

| Code | What happened | Fix |
|---|---|---|
| `client_json_wrong_type` | The downloaded JSON is a **Web application** client (top-level `"web"` key) | Create a **Desktop app** client and download its JSON |
| `client_json_unreadable` | The client JSON path doesn't exist or isn't the Google Cloud download | Re-download from Credentials → your Desktop app client → Download JSON, pass with `--client-json <path>` |
| `client_shape_invalid` | Pasted ID/secret malformed (smart quotes, truncation) | Re-copy, or use `--client-json` |
| `redirect_uri_mismatch` | Google rejected the redirect | Almost always a Web-type client — use a Desktop app client |
| `access_denied_test_user` | Consent blocked (External + Testing, you're not a test user — or you clicked Cancel) | Add yourself under Audience → Test users, retry the same URL |
| `pasted_wrong_url` | You pasted the consent-page URL | Approve first, then paste the `http://127.0.0.1...` address-bar URL |
| `state_mismatch` | The paste came from an older attempt | Re-run connect, use the fresh URL |
| `admin_policy_enforced` | Workspace admin blocks third-party apps (even your own client) | Admin console → Security → API controls → trust the app; or make the consent screen Internal |
| `wrong_account_consented` | A different Google account approved | Re-run; the URL now pre-selects the right account |
| `port_in_use` | Loopback port taken | Re-run (fresh ephemeral port), `--port <n>`, or `--paste` |
| `consent_timeout` | Consent never completed within 10 minutes | Re-run connect |
| `invalid_grant_testing_expiry` | Refresh token dead ≈7 days after connect | Publish the app to Production, then `gbrain google connect --reauth <email>` |
| `invalid_grant_revoked` | Access revoked (password change, manual revoke, client rotated) | `gbrain google connect --reauth <email>` |
| `invalid_grant_clock_skew` | Your system clock is off by >60s | Fix time sync, retry |
| `code_reused` | Authorization code used twice | Re-run connect (codes are single-use) |
| `invalid_client` | Client secret rotated/deleted in the console | Download the current JSON, reconnect |
| `no_refresh_token` | Google returned no refresh token | Re-run connect; if persistent, revoke at <https://myaccount.google.com/permissions> and reconnect |
| `api_not_enabled` | An API isn't enabled in your project | The error carries the exact enable link (project pre-selected) |
| `rate_limited` | Google quota hit | Automatic backoff; nothing to do |
| `scope_missing` | Connected with narrower `--scopes` than needed | `gbrain google connect --reauth <email>` |
| `relay_unreachable` / `relay_session_expired` / `claim_already_used` / `relay_disabled` | Hosted fast-path (gbrain.io relay) issues | BYO connect always works: `gbrain google connect` |
| `not_connected` | No vault entry for the account | `gbrain google connect` |
| `upstream` | Google returned an unexpected error | Retry; if it persists, run `gbrain google status --json` and file the output |
| `access_command_failed` | The `--access command` token command exited non-zero, timed out, or printed nothing token-shaped | Run it by hand; it must print a bare token or JSON with `token`/`access_token` |
| `access_env_missing` | The `--access env` variable is unset/blank in this process | Export a live token into it (refresh externally), or switch back to the vault flow |

Cursor expiries (`historyId` older than ~a week, calendar/contacts
`syncToken` 410, or a contacts HTTP 400 explicitly reporting an expired sync
token) use bounded re-lists automatically. Contacts recovery refreshes its
own cursor without restarting Gmail. Unrelated HTTP 400 errors remain
upstream failures rather than triggering a full re-list.

## Custody, privacy, spend

- Tokens: local vault only, 0600, atomic writes. `sources.config` stores an
  account *pointer*, never a secret. `gbrain creds list` is always redacted.
- Disconnect: `gbrain google disconnect <email>` removes local tokens; revoke
  Google-side at <https://myaccount.google.com/permissions>.
- Upgrade/transfer: `gbrain creds export` produces a passphrase-encrypted
  bundle (a loud per-credential warning when a Testing-mode consent screen
  would travel with it — those tokens die within 7 days on the target).
- LLM spend: commitment extraction sends recent email text (last 30 days,
  capped per sweep) to your configured chat provider. Kill switch:
  `gbrain config set loops.extraction_enabled false`. The deterministic
  unanswered-thread detector is free and always on.

## For agents ([SHOW USER] protocol)

Every `gbrain google`/`creds`/`waiting` command supports `--json` and emits
`{ ok, status, next_action: { command?, user_message? }, error? }`. Human
copy the harness should relay verbatim is fenced in `[SHOW USER]` blocks.
The whole setup is exactly two user interactions: (1) the GCP checklist +
client JSON hand-back, (2) one consent click. Never pass secrets via argv —
use `--client-json <path>`, stdin, or env.

## Attachment receipts and historical repair

Gmail attachment receipts record filenames, MIME types, byte sizes when supplied,
account/message/part identity, and Gmail attachment IDs when available. They do
**not** download attachments or index their contents. Calendar documents and
inline parts are distinguished from ordinary documents; plain/HTML message-body
parts are not attachment receipts. Receipt metadata inherits its message page's
source and visibility. Filenames are inert data, not paths or executable links.

Message rendering distinguishes four states:

- **Not inspected:** a legacy message has no inspection receipt. Absence of a
  receipt says nothing about whether an attachment exists.
- **Inspection incomplete:** missing/malformed MIME data or a safety bound stopped
  inspection. Any receipts already observed remain visible, but absence is unknown.
- **Inspected; none found:** bounded inspection completed without attachments.
- **Present; not downloaded; not indexed:** metadata exists, but attachment content
  is not available to search. For example, `fixture.pdf — application/pdf; 17 bytes`.

Each message MIME walk is iterative, capped at depth 32 and 512 visited parts.
Attachment receipt payloads have a 64 KiB aggregate budget per fetched thread;
over-limit metadata is incomplete rather than silently marked empty. Missing part
IDs use deterministic MIME paths. Duplicate filenames remain separate receipts.
Missing message IDs have deterministic fallback identities but no invented Gmail
link. Pure-noise threads remain excluded by the existing ingestion policy.

Historical repair requests a Gmail partial response containing message IDs and
explicit MIME metadata fields; `body.data`, raw messages and snippets are never
selected. The selection includes child-identity sentinels beyond depth 32 so a
deeper MIME tree remains incomplete rather than appearing empty. Decoded metadata
responses are capped at 2 MiB before JSON parsing; oversized responses fail without
advancing repair. Ordinary sync's message-body requests are unchanged.

Upgrading changes future ingestion, **not** every historical page. Ordinary
incremental sync only revisits changed threads and its success does not establish
historical inspection. To repair already-imported pages without replaying bodies:

```sh
gbrain google attachments backfill --brain host --source gmail-example --json
gbrain google attachments backfill --brain host --source gmail-example --yes --limit 25 --json
```

This is a trusted **local, managed-persistence-only** command for both PGLite and
PostgreSQL. Use an existing Google source and existing CLI writer registration on
the selected canonical host. It never enables persistence, installs services, or
silently registers a new repair writer. Keep old conflicting mutation workers
quiesced without deleting their queued work. For PGLite, stop its resident owner
cleanly first: this command does not delegate historical repair to a running owner.
For PostgreSQL, use the configured host brain or an explicitly selected local
PostgreSQL mount; source selection never switches the database. Unmanaged sources
can continue ordinary ingestion, but this historical repair refuses them.

The first command is read-only and makes no Google calls. Its `status: "preview"`
names the effective brain, source, account, imported-page count and saved historical
cursor (or `not_inspected`). Review that scope before applying `--yes`. The apply
command processes at most 25 imported thread pages, patches only the
`gmail_attachment_receipts` frontmatter field, and preserves current body, other
frontmatter, tags, visibility and committed withdrawals. It never calls loop/fact
extraction or an attachment-download/model API. Canonical text projections are
rebuilt without provider calls; receipt filenames are not extracted as facts.

A batch returning `status: "paused", complete: false` exits nonzero with its
durable count and cursor. Repeat the **same command** to resume. The per-account
cursor is checkpointed only after committed page receipts; interruption can repeat
a page safely without duplicating receipt identities. `status: "complete"` means
traversal of the fixed upper page-ID boundary captured at the first repair invocation
is done, **not that every message was inspected or mailbox-wide coverage**.
`inspected` counts fully inspected pages; `unavailable` counts pages with missing
historical messages, and `unavailableMessages` counts those identities separately.
`inspection_complete` is false when traversal is paused or any identity is unavailable.
This scan has no date filter and does not import
missing/deleted pages; new ingestion handles newly imported pages.

A confirmed Gmail thread HTTP 404 or a missing historical message ID in an otherwise
valid thread records `messages[].unavailable` (`thread_not_found` or
`message_not_found`). Any prior receipt and inspection metadata stays intact; an
identity without prior metadata has `inspection.state: not_inspected`, not `none`.
The historical body, privacy and message IDs remain unchanged. The durable cursor
can then continue to later pages without repeatedly blocking on upstream absence.
Authorization/rate-limit errors, malformed responses, other HTTP errors and unknown
ownership are not disappearance and do not authorize skipping the affected page.

`incomplete` also exits nonzero and leaves the cursor before that page. A conflict
(unknown receipt ownership, canonical edit during publication, delete/recreation,
source/account change or lost lease) preserves existing content and stops progress.
Inspect the retained write receipt and source before retrying. After resolving a
terminal failed receipt, `--yes --retry-failed` explicitly authorizes its linked
retry; never reset cursors, force overwrite, or restore an old backup to bypass a
withdrawal. Completed partial work remains durable. Provider failure, unavailable
owners and malformed metadata are not successful inspection.

Verify with the preview command above and an authorized page read:

```sh
gbrain get emails/2026/09/example-thread --brain host --source gmail-example
```

Inspect `frontmatter.gmail_attachment_receipts.messages[].inspection` for the
individual states and preserved attachment identities. The page's existing Gmail
citation remains its navigation link; a missing message ID reports unavailable.
Private pages and their receipts remain unavailable to unauthorized remote readers.
