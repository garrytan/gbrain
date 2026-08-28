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
the run partial without blocking it. A single thread that repeatedly fails to fetch is skipped after a few
consecutive failures instead of wedging the sync forever;
`gbrain sync --source <id> --full` retries skipped threads with a fresh
ledger.

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
`syncToken` 410) are handled automatically with bounded re-lists — never
user-facing.

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
