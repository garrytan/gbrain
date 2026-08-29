---
id: credential-gateway
name: Credential Gateway
version: 1.0.0
description: Secure access to Gmail, Google Calendar, and Google Contacts. Native `gbrain google connect` (recommended) or the ClawVisor hosted gateway.
category: infra
requires: []
secrets:
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 client ID (Option A — native connector; env intake works, `--client-json` is preferred)
    where: https://console.cloud.google.com/auth/clients — create a Desktop app OAuth client
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 client secret (Option A)
    where: https://console.cloud.google.com/auth/clients — same client, click Download JSON
  - name: CLAWVISOR_URL
    description: ClawVisor gateway URL (Option B — alternative hosted gateway)
    where: https://clawvisor.com — create an agent, copy the gateway URL
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor agent token (Option B)
    where: https://clawvisor.com — agent settings, copy the agent token
health_checks:
  - type: command
    argv: ["gbrain", "google", "status", "--json"]
    label: "Google connector"
  - type: any_of
    label: "Auth provider"
    checks:
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "Google OAuth"
      - type: http
        url: "$CLAWVISOR_URL/health"
        label: "ClawVisor"
setup_time: 15 min
cost_estimate: "$0 (both options are free)"
---

# Credential Gateway: Secure Access to Google Services

Gmail, Google Calendar, Google Contacts, and other services require OAuth
credentials. This recipe sets up secure access that email-to-brain and
calendar-to-brain depend on.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Other recipes depend on this one. If the user wants
email-to-brain or calendar-to-brain, set up credential-gateway FIRST.

**Two options, both free:**
- **Option A: Native connector (recommended)** — `gbrain google connect` runs the
  whole OAuth flow itself: BYO Desktop-app client, loopback consent (auto
  paste-back over SSH/headless), token refresh, and custody. Tokens live only in
  the local credential vault (`~/.gbrain/credentials.json`, mode 0600). No
  collector scripts, no hand-managed token files, no extra service.
- **Option B: ClawVisor** — a hosted gateway that handles OAuth, token refresh,
  and encryption server-side. Useful if you already run ClawVisor for other
  agents or don't want a Google Cloud project of your own.

**Do not skip steps. Verify after each step.**

## Setup Flow

### Step 1: Choose Your Gateway

Ask the user: "How do you want to connect to Google services (Gmail, Calendar,
Contacts)?

**Option A: Native connector (recommended)**
gbrain connects directly with your own (free) Google OAuth client. You own the
app, the quota, and the tokens — they never leave your machine. One-time setup
is ~7 minutes of Google Cloud console clicks, then everything is automatic.

**Option B: ClawVisor**
A hosted gateway handles OAuth and token refresh for you. Slightly faster to
set up, but your tokens are custodied by the gateway service."

#### Option A: Native Connector Setup

Run:

```bash
gbrain google connect --json
```

When no client credentials are on file, the command prints a fenced
`[SHOW USER] ... [/SHOW USER]` block with the exact Google Cloud checklist.
**Relay that block to the user verbatim** — do not paraphrase (details like
"Desktop app, NOT Web application" are load-bearing). The checklist walks:

1. Create (or pick) a project: https://console.cloud.google.com/projectcreate
2. Enable the three APIs (one click each):
   - Gmail: https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - Calendar: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   - Contacts (People): https://console.cloud.google.com/apis/library/people.googleapis.com
3. Configure the consent screen: https://console.cloud.google.com/auth/overview
   - **Google Workspace account** → user type **Internal**. Done — no
     verification, tokens never expire weekly.
   - **Personal gmail.com** → user type **External**, then BOTH:
     add your own email as a **Test user**
     (https://console.cloud.google.com/auth/audience) AND click **Publish app**
     on that same page. Skipping the publish step makes Google silently revoke
     the tokens every 7 days — the single most common failure in the wild.
4. Create the OAuth client: https://console.cloud.google.com/auth/clients —
   application type **Desktop app** (NOT "Web application").
5. Click **Download JSON**.

When the user hands back the downloaded `client_secret_*.json`, save it to a
file (mode 0600) and pass the path — never paste secrets into argv:

```bash
gbrain google connect --client-json ~/Downloads/client_secret_*.json
```

Env intake (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) also works. The command
then prints the consent URL; during consent Google shows **"Google hasn't
verified this app"** — that is the user's OWN app, so warn them ahead of time:
Advanced → Continue. On headless/SSH machines the connector auto-switches to
paste-back mode (the user pastes the failed-to-load `http://127.0.0.1...` URL
back). Full flow reference: `docs/guides/google-connect.md`.

Validate:
```bash
gbrain google status --json   # per-account live refresh probe
```

**STOP until `status` shows the account with `refresh_probe: "ok"`.**

#### Option B: ClawVisor Setup

Tell the user:
"1. Go to https://clawvisor.com and create an account
2. Create an agent (or use existing one)
3. Activate the services you need:
   - **Gmail** (for email-to-brain)
   - **Google Calendar** (for calendar-to-brain)
   - **Google Contacts** (for enrichment)
4. Create a standing task with a broad purpose. CRITICAL: be EXPANSIVE.

   Good purpose: 'Full executive assistant access to Gmail, Calendar, and
   Contacts including inbox triage, event listing, contact lookup, and
   historical data access for all connected Google accounts.'

   Bad purpose: 'email triage' — too narrow, blocks legitimate requests.

5. Copy the **Gateway URL** and **Agent Token** and paste them to me"

Validate:
```bash
curl -sf "$CLAWVISOR_URL/health" \
  && echo "PASS: ClawVisor reachable" \
  || echo "FAIL: ClawVisor not reachable — check the URL"
```

**STOP until ClawVisor validates.**

### Step 2: Verify

```bash
gbrain google status --json      # Option A: accounts, scopes, refresh probes
gbrain doctor                    # includes the google_oauth vault-health check
```

Tell the user: "Credential gateway is set up. Email-to-brain and calendar-to-brain
can now access your Google services." (The connector logs its own funnel events
to `~/.gbrain/integrations/google/heartbeat.jsonl` — no manual heartbeat needed.)

## Tricky Spots

1. **Desktop app, NOT Web application.** A Web-type client fails with
   `client_json_wrong_type` or `redirect_uri_mismatch`. Every connector failure
   maps to a typed error code with the fix attached — the full catalog is in
   `docs/guides/google-connect.md#troubleshooting`.

2. **External consent screens MUST be published to Production.** In "Testing"
   mode Google silently revokes refresh tokens every 7 days
   (`invalid_grant_testing_expiry`). `gbrain doctor`'s `google_oauth` check
   warns once an account goes 5+ days without a successful refresh — an
   actively-syncing account gets no pre-warning, so publish rather than
   rely on the warning. Internal (Workspace) consent screens don't have
   this problem.

3. **Tokens live in the vault, not in env or ad-hoc files.** The native
   connector stores tokens in `~/.gbrain/credentials.json` (0600, atomic
   writes) and auto-refreshes them. Inspect with `gbrain creds list` (always
   redacted); move machines with `gbrain creds export` (passphrase-encrypted
   bundle). Never hand-manage token JSON files.

4. **Multiple Google accounts.** Repeat `gbrain google connect --account
   work@example.com` per account; each gets its own vault entry and its own
   source. ClawVisor handles multiple accounts on its side.

5. **ClawVisor task purpose must be EXPANSIVE.** "Email triage" is too narrow and
   blocks legitimate requests. Use a broad purpose that covers everything you
   might want to do with email. The intent verification model checks each
   request against the purpose. Narrow = blocked.

## How to Verify

1. **Native connector:** `gbrain google status --json` shows the account with
   `refresh_probe: "ok"`.
2. **ClawVisor:** `curl $CLAWVISOR_URL/health` returns OK.
3. **Gmail access:** run the email-to-brain setup — the first sync should pull
   recent threads.
4. **Calendar access:** run the calendar-to-brain setup — the first sync should
   pull today's events.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| Native connector (your own Google OAuth client) | $0 (free, no billing needed for personal use) |
| ClawVisor | $0 (free tier) |

---

*Part of the [GBrain Skillpack](../docs/GBRAIN_SKILLPACK.md). See also: [Email-to-Brain](email-to-brain.md), [Calendar-to-Brain](calendar-to-brain.md), [docs/guides/google-connect.md](../docs/guides/google-connect.md)*
