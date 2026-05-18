---
id: credential-gateway
name: Credential Gateway
version: 0.7.0
description: Secure access to Gmail, Google Calendar, and other Google services. ClawVisor (recommended) or direct Google OAuth.
category: infra
requires: []
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor gateway URL (Option A — recommended)
    where: https://clawvisor.com — create an agent, copy the gateway URL
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor agent token (Option A)
    where: https://clawvisor.com — agent settings, copy the agent token
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 client ID (Option B — direct API)
    where: https://console.cloud.google.com/apis/credentials — create OAuth 2.0 Client ID
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 client secret (Option B)
    where: https://console.cloud.google.com/apis/credentials — same page as client ID
health_checks:
  - type: any_of
    label: "Auth provider"
    checks:
      - type: http
        url: "$CLAWVISOR_URL/health"
        label: "ClawVisor"
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "Google OAuth"
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
- **Option A: ClawVisor** — handles OAuth, token refresh, and encryption for you.
  No token management. If you use multiple Google services, set up ClawVisor once
  and all recipes use it.
- **Option B: Google OAuth directly** — no extra service, but you manage tokens
  yourself. Good if you don't want another dependency.

**Do not skip steps. Verify after each step.**

## Setup Flow

### Step 1: Choose Your Gateway

Ask the user: "How do you want to connect to Google services (Gmail, Calendar)?

**Option A: ClawVisor (recommended)**
ClawVisor handles OAuth, token refresh, and encryption. Set it up once and
email-to-brain, calendar-to-brain, and any future Google service recipes
all use the same credentials. No token management on your end.

**Option B: Google OAuth2 directly**
Connect to Google APIs directly. No extra service. But you manage OAuth
tokens yourself (they expire, need refresh)."

#### Option A: ClawVisor Setup

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

#### Option B: Google OAuth2 Setup

Tell the user:
"I need Google OAuth2 credentials. Here's exactly how:

1. Go to https://console.cloud.google.com/apis/credentials
   (create a Google Cloud project if you don't have one — it's free)
2. Click **'+ CREATE CREDENTIALS'** at the top > **'OAuth client ID'**
3. If prompted to configure the consent screen:
   - User type: **External** (or Internal for Google Workspace)
   - App name: 'GBrain' (anything works)
   - Scopes: add the ones you need:
     - Gmail: `https://www.googleapis.com/auth/gmail.readonly`
     - Calendar: `https://www.googleapis.com/auth/calendar.readonly`
     - Contacts: `https://www.googleapis.com/auth/contacts.readonly`
   - Test users: add your own email address
4. Create the OAuth client ID:
   - Application type: **Desktop app**
   - Name: 'GBrain'
5. Click **'Create'** — copy the **Client ID** and **Client Secret**
6. Enable the APIs you need:
   - Gmail: https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - Calendar: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   Click **'Enable'** on each one.

Paste the Client ID and Client Secret to me."

Validate:
```bash
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] \
  && echo "PASS: Google OAuth credentials set" \
  || echo "FAIL: Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET"
```

Then run the OAuth flow:
```
// The first time a recipe uses these credentials, it will:
// 1. Open a browser to the Google consent URL
// 2. User grants access
// 3. Script receives auth code, exchanges for access + refresh token
// 4. Stores tokens in ~/.gbrain/google-tokens.json
// 5. Auto-refreshes when tokens expire (refresh token is long-lived)
```

**STOP until OAuth credentials validate.**

### Step 2: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/credential-gateway
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"type":"CLAWVISOR_OR_GOOGLE"}}' >> ~/.gbrain/integrations/credential-gateway/heartbeat.jsonl
```

Tell the user: "Credential gateway is set up. Email-to-brain and calendar-to-brain
can now access your Google services."

## Tricky Spots

1. **ClawVisor task purpose must be EXPANSIVE.** "Email triage" is too narrow and
   blocks legitimate requests. Use a broad purpose that covers everything you
   might want to do with email. The intent verification model checks each
   request against the purpose. Narrow = blocked.

2. **Google OAuth tokens expire.** Access tokens last ~1 hour. The refresh token
   is long-lived but can be revoked. Store both in `~/.gbrain/google-tokens.json`
   with 0600 permissions. The script should auto-refresh on 401.

3. **Google consent screen in "Testing" mode** limits to 100 users and tokens
   expire weekly. For personal use this is fine. For production, publish the app.

4. **Multiple Google accounts.** If you have work + personal Gmail, you need to
   authorize each one separately in the OAuth flow. ClawVisor handles this
   automatically.

## How to Verify

1. **ClawVisor:** `curl $CLAWVISOR_URL/health` returns OK.
2. **Google OAuth:** Tokens exist at `~/.gbrain/google-tokens.json`.
3. **Gmail access:** Run the email collector — it should pull recent messages.
4. **Calendar access:** Run the calendar sync — it should pull today's events.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| ClawVisor | $0 (free tier) |
| Google OAuth | $0 (free, no billing needed for personal use) |

---

*Part of the [GBrain Skillpack](../docs/GBRAIN_SKILLPACK.md). See also: [Email-to-Brain](email-to-brain.md), [Calendar-to-Brain](calendar-to-brain.md)*
