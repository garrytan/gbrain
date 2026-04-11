---
id: twilio-voice-brain
name: Voice-to-Brain
version: 0.7.0
description: Phone calls create brain pages via Twilio + OpenAI Realtime + GBrain MCP. Callers talk, brain pages appear.
category: sense
requires: []
secrets:
  - name: TWILIO_ACCOUNT_SID
    description: Twilio account SID (starts with AC)
    where: https://www.twilio.com/console — visible on the main dashboard after login
  - name: TWILIO_AUTH_TOKEN
    description: Twilio auth token (click "Show" next to the SID on the dashboard)
    where: https://www.twilio.com/console — click "Show" under Auth Token on the main dashboard
  - name: OPENAI_API_KEY
    description: OpenAI API key (needs Realtime API access enabled on your account)
    where: https://platform.openai.com/api-keys — click "+ Create new secret key", copy immediately (you can't see it again)
health_checks:
  - "curl -sf -u \"$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN\" \"https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID.json\" > /dev/null && echo 'Twilio: OK' || echo 'Twilio: FAIL'"
  - "curl -sf -H \"Authorization: Bearer $OPENAI_API_KEY\" https://api.openai.com/v1/models > /dev/null && echo 'OpenAI: OK' || echo 'OpenAI: FAIL'"
setup_time: 30 min
cost_estimate: "$15-25/mo (Twilio number $1-2 + voice $0.01/min, OpenAI Realtime $0.06/min input + $0.24/min output)"
---

# Voice-to-Brain: Phone Calls That Create Brain Pages

Call a phone number. Talk. A structured brain page appears with entity detection,
cross-references, and a summary posted to your messaging app.

## IMPORTANT: Instructions for the Agent

**You are the installer.** This recipe is written for YOU (the AI agent) to execute
on behalf of the user. Follow these instructions precisely.

**Why sequential execution matters:** Each step depends on the previous one:
- Step 1 validates prerequisites. If GBrain isn't configured, nothing else works.
- Step 2 collects credentials. If a credential is wrong, Steps 5-7 will silently fail.
- Step 3 creates the ngrok tunnel. Step 5 needs the ngrok URL for the Twilio webhook.
- Step 5 configures Twilio. Step 7 (smoke test) needs Twilio configured to reach your server.

**Do not skip steps. Do not reorder steps. Do not batch multiple steps.**

**Stop points (MUST pause and verify before continuing):**
- After Step 1: all prerequisites pass? If not, fix before proceeding.
- After each credential in Step 2: validation passes? If not, help the user fix it.
- After Step 6: health check passes? If not, debug before smoke test.
- After Step 7: brain page created? If not, troubleshoot before declaring success.

**When something fails:** Tell the user EXACTLY what failed, what it means, and what
to try. Never say "something went wrong." Say "Twilio returned a 401, which means the
auth token is incorrect. Let's re-enter it."

## Architecture

```
Caller (phone)
  ↓ Twilio (WebSocket, g711_ulaw audio — no transcoding)
Voice Server (Node.js, your machine or cloud)
  ↓↑ OpenAI Realtime API (STT + LLM + TTS in one pipeline)
  ↓ Function calls during conversation
GBrain MCP (semantic search, page reads, page writes)
  ↓ Post-call
Brain page created (meetings/YYYY-MM-DD-call-{caller}.md)
Summary posted to messaging app (Telegram/Slack/Discord)
```

## Opinionated Defaults

These are production-tested defaults from a real deployment. Customize after setup.

**Caller routing (prompt-based, enforced server-side):**
- Owner: OTP challenge via secure channel, then full access (read + write + gateway)
- Trusted contacts: callback verification, scoped write access
- Known contacts (brain score >= 4): warm greeting by name, offer to transfer
- Unknown callers: screen, ask name + reason, take message

**Security:**
- Twilio signature validation on `/voice` endpoint (X-Twilio-Signature header)
- Unauthenticated callers never see write tools
- Caller ID is NOT trusted for auth (OTP or callback required)

---

## Setup Flow

### Step 1: Check Prerequisites

**STOP if any check fails. Fix before proceeding.**

Run these checks and report results to the user:

```bash
# 1. Verify GBrain is configured
gbrain doctor --json
```
If this fails: "GBrain isn't set up yet. Let's run `gbrain init --supabase` first."

```bash
# 2. Verify Node.js 18+
node --version
```
If missing or < 18: "Node.js 18+ is required. Install it: https://nodejs.org/en/download"

```bash
# 3. Check if ngrok is installed
which ngrok
```
If missing:
- **Mac:** "Run `brew install ngrok` in your terminal."
- **Linux:** "Run `snap install ngrok` or download from https://ngrok.com/download"

Tell the user: "All prerequisites checked. [N/3 passed]. [List any that failed and how to fix.]"

### Step 2: Collect and Validate Credentials

Ask for each credential ONE AT A TIME. Validate IMMEDIATELY. Do not proceed to
the next credential until the current one validates.

**Credential 1: Twilio Account SID + Auth Token**

Tell the user:
"I need your Twilio Account SID and Auth Token. Here's exactly where to find them:

1. Go to https://www.twilio.com/console (sign up free if you don't have an account)
2. After logging in, you'll see your **Account SID** right on the main dashboard
   (it starts with 'AC' followed by 32 characters)
3. Below it you'll see **Auth Token** — click **'Show'** to reveal it
4. Copy both values and paste them to me"

After the user provides them, validate immediately:

```bash
curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID.json" \
  | grep -q '"status"' \
  && echo "PASS: Twilio credentials valid" \
  || echo "FAIL: Twilio credentials invalid — double-check the SID starts with AC and the auth token is correct"
```

**If validation fails:** "That didn't work. Common issues: (1) the SID should start
with 'AC', (2) make sure you clicked 'Show' to reveal the auth token and copied the
full value, (3) if you just created the account, wait 30 seconds and try again."

**STOP HERE until Twilio validates.**

**Credential 2: OpenAI API Key**

Tell the user:
"I need your OpenAI API key. Here's exactly where to get one:

1. Go to https://platform.openai.com/api-keys
2. Click **'+ Create new secret key'** (top right)
3. Name it something like 'gbrain-voice'
4. Click **'Create secret key'**
5. **Copy the key immediately** — you won't be able to see it again after closing the dialog
6. Paste it to me

Note: your OpenAI account needs Realtime API access. Most accounts have it by default."

After the user provides it, validate immediately:

```bash
curl -sf -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models > /dev/null \
  && echo "PASS: OpenAI key valid" \
  || echo "FAIL: OpenAI key invalid — make sure you copied the full key (starts with sk-)"
```

**If validation fails:** "That didn't work. Common issues: (1) the key starts with
'sk-', (2) make sure you copied the entire key (it's long), (3) if you just created
it, it's active immediately — no delay needed."

**STOP HERE until OpenAI validates.**

**Credential 3: ngrok Auth Token**

Tell the user:
"I need your ngrok auth token. Here's where to find it:

1. Go to https://dashboard.ngrok.com/get-started/your-authtoken
   (sign up free at https://dashboard.ngrok.com/signup if you don't have an account)
2. You'll see your **Authtoken** displayed on the page
3. Copy it and paste it to me"

```bash
ngrok config add-authtoken $NGROK_TOKEN \
  && echo "PASS: ngrok configured" \
  || echo "FAIL: ngrok auth token rejected"
```

**Credential 4: Messaging Platform (for call summaries)**

Ask the user: "Where should I send call summaries? Options: Telegram, Slack, or Discord."

Based on their choice:
- **Telegram:** "Create a bot via @BotFather on Telegram, copy the bot token, and
  tell me which chat/group to send summaries to."
  Validate: `curl -sf "https://api.telegram.org/bot$TOKEN/getMe" | grep -q '"ok":true'`
- **Slack:** "Create an Incoming Webhook at https://api.slack.com/apps → your app →
  Incoming Webhooks → Add New. Copy the webhook URL."
  Validate: `curl -sf -X POST -d '{"text":"GBrain voice test"}' $WEBHOOK_URL`
- **Discord:** "Go to your server → channel settings → Integrations → Webhooks →
  New Webhook. Copy the webhook URL."
  Validate: `curl -sf -X POST -H "Content-Type: application/json" -d '{"content":"GBrain voice test"}' $WEBHOOK_URL`

Tell the user: "All credentials validated. Moving to server setup."

### Step 3: Start ngrok Tunnel

```bash
ngrok http 8765
```

This will display a URL like `https://abc123.ngrok-free.app`. Save this URL — you'll
need it for Twilio webhook configuration in Step 5.

Note: ngrok runs in the foreground. The agent should run this in a background process
or new terminal tab, then proceed.

### Step 4: Create Voice Server

Create the voice server directory and install dependencies:

```bash
mkdir -p voice-agent && cd voice-agent
npm init -y
npm install ws express
```

The voice server needs these components in `server.mjs`:

1. **HTTP server** on port 8765 with:
   - `POST /voice` — returns TwiML that opens a WebSocket media stream to `/ws`
   - `GET /health` — returns `{ ok: true }`
   - Twilio signature validation (`X-Twilio-Signature` header) on `/voice`

2. **WebSocket handler** at `/ws` that:
   - Accepts Twilio media stream (g711_ulaw audio)
   - Opens a second WebSocket to `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`
   - Bridges audio bidirectionally (no transcoding — both sides use g711_ulaw)
   - Handles `response.function_call_arguments.done` events from OpenAI (tool execution)
   - Sends tool results back via `conversation.item.create` with type `function_call_output`

3. **System prompt builder** that takes caller phone number and returns:
   - Appropriate greeting based on caller routing rules
   - Available tools (read-only for unauthenticated, full for authenticated)
   - Instructions: "You are a voice assistant. Search the brain before answering
     questions. Take messages from unknown callers. Never hang up first."

4. **Tool executor** that:
   - Spawns GBrain MCP client (`gbrain serve` as stdio child process)
   - Routes function calls: `search_brain` → `gbrain query`, `lookup_person` → `gbrain search` + `gbrain get`
   - Gates write tools behind authentication

5. **Post-call handler** that:
   - Saves transcript to `brain/meetings/YYYY-MM-DD-call-{caller}.md`
   - Posts summary to the user's messaging platform
   - Runs `gbrain sync --no-pull --no-embed` to index the new page

**Reference implementation:** A complete voice server is included in the GBrain
examples directory (coming in a future release). For now, the architecture above
and the OpenAI Realtime API docs (https://platform.openai.com/docs/guides/realtime)
provide the building blocks.

### Step 5: Configure Twilio Phone Number

Tell the user:
"Now I need to set up your Twilio phone number. Here's what to do:

1. Go to https://www.twilio.com/console/phone-numbers/search
2. Search for a number (pick your area code or any available number)
3. Click **'Buy'** next to the number you want (costs $1-2/month)
4. After purchase, go to https://www.twilio.com/console/phone-numbers/incoming
5. Click on your new number
6. Scroll to **'Voice Configuration'**
7. Under **'A call comes in'**, select **'Webhook'**
8. Enter: `https://YOUR-NGROK-URL.ngrok-free.app/voice`
9. Method: **HTTP POST**
10. Click **'Save configuration'**
11. Tell me the phone number you purchased"

Or if the user prefers CLI:
```bash
# Buy a number (US local)
twilio phone-numbers:buy:local --area-code 415

# Configure webhook
twilio phone-numbers:update PHONE_SID \
  --voice-url https://YOUR-NGROK-URL.ngrok-free.app/voice \
  --voice-method POST
```

### Step 6: Start Voice Server and Verify

```bash
cd voice-agent && node server.mjs
```

**STOP and verify:**
```bash
curl -sf http://localhost:8765/health && echo "Voice server: running" || echo "Voice server: NOT running"
```

If not running: check the server logs for errors. Common issues:
- Port 8765 already in use: `lsof -i :8765` to find what's using it
- Missing environment variables: make sure OPENAI_API_KEY is set
- Module not found: run `npm install` again

### Step 7: Smoke Test (Outbound Call)

**This is the magical moment.** The agent calls the USER to prove the system works.

Tell the user: "Your phone is about to ring. Pick up and talk for about 30 seconds.
Say something like 'Hey, I'm testing my new voice-to-brain system. Remind me to
check the quarterly numbers tomorrow.' When you're done, hang up."

```bash
curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Calls.json" \
  --data-urlencode "To=USER_PHONE_NUMBER" \
  --data-urlencode "From=TWILIO_PHONE_NUMBER" \
  --data-urlencode "Url=https://YOUR-NGROK-URL.ngrok-free.app/voice" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
```

**After the call ends, verify ALL of these:**

1. Messaging notification arrived with call summary
2. Brain page exists:
   ```bash
   gbrain search "call" --limit 1
   ```
3. The brain page has: transcript, entity mentions, action items

**If the smoke test fails:**
- No ring: check Twilio console for error logs at https://www.twilio.com/console/debugger
- Ring but no voice: check ngrok tunnel is up, check OpenAI key is valid
- Voice works but no brain page: check post-call handler logs, run `gbrain sync` manually
- Brain page but no messaging: check messaging bot token is valid

**STOP HERE until the smoke test passes. Do not declare success until the user
confirms they received the messaging notification AND the brain page exists.**

### Step 8: Set Up Inbound Calling

Tell the user: "The smoke test passed — voice-to-brain is live! Your number is
[TWILIO_NUMBER]. Now let's set up inbound calling."

1. Twilio webhook is already configured from Step 5
2. Ask: "Do you want calls to your existing phone to forward to this number
   after a few rings? That way you answer if you can, and the voice agent
   picks up if you don't."
3. Configure caller routing rules in the system prompt
4. Add the user's phone number as the "owner" number for full access

### Step 9: Watchdog (Auto-restart)

```bash
# Cron watchdog (every 2 minutes) — add to crontab
*/2 * * * * curl -sf http://localhost:8765/health > /dev/null || (cd /path/to/voice-agent && node server.mjs >> /tmp/voice-agent.log 2>&1 &)
```

If using ngrok, also set up URL monitoring (free ngrok URLs change on restart):
```bash
# Check if ngrok URL changed, update Twilio if so
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"https://[^"]*' | grep -o 'https://.*')
if [ -n "$NGROK_URL" ]; then
  twilio phone-numbers:update PHONE_SID --voice-url "$NGROK_URL/voice"
fi
```

### Step 10: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/twilio-voice-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"phone":"TWILIO_NUMBER","deployment":"local+ngrok"}}' >> ~/.gbrain/integrations/twilio-voice-brain/heartbeat.jsonl
```

Tell the user: "Voice-to-brain is fully set up. Your number is [NUMBER]. Here's
what happens now: anyone who calls gets screened by the voice agent. Known contacts
get a warm greeting. Unknown callers leave a message. Every call creates a brain
page with the full transcript, and you get a summary on [their messaging platform].
The watchdog restarts the server if it crashes."

## Cost Estimate

| Component | Monthly Cost | Source |
|-----------|-------------|--------|
| Twilio phone number | $1-2/mo | [Twilio pricing](https://www.twilio.com/en-us/voice/pricing) |
| Twilio voice minutes (100 min) | $1-2/mo | $0.0085-0.015/min depending on direction |
| OpenAI Realtime input (100 min) | $6/mo | [$0.06/min](https://openai.com/api/pricing/) |
| OpenAI Realtime output (50 min) | $12/mo | [$0.24/min](https://openai.com/api/pricing/) |
| ngrok (free tier) | $0 | Static domain: $8/mo |
| **Total estimate** | **$20-22/mo** | For ~100 min of calls |

## Troubleshooting

**Calls don't connect:**
- Check ngrok: `curl http://localhost:4040/api/tunnels` — if empty, ngrok isn't running
- Check voice server: `curl http://localhost:8765/health` — should return `{"ok":true}`
- Check Twilio debugger: https://www.twilio.com/console/debugger — shows webhook errors
- Check webhook URL: go to https://www.twilio.com/console/phone-numbers/incoming, click your number, verify the webhook URL matches your ngrok URL

**Voice agent doesn't respond:**
- Check OpenAI key: the validation command from Step 2 should still pass
- Check server logs for WebSocket errors (look for "connection refused" or "401")
- Verify Realtime API access: not all OpenAI accounts have it. Check https://platform.openai.com/docs/guides/realtime

**Brain pages not created after call:**
- Run `gbrain doctor` — if it fails, the database connection is broken
- Check if the post-call handler ran (look in server logs for "transcript saved")
- Run `gbrain sync` manually to force indexing
- Check file permissions on the brain repo directory

**ngrok URL keeps changing:**
- Free ngrok URLs change every time ngrok restarts
- The watchdog (Step 9) handles this automatically
- For a permanent URL: upgrade to ngrok paid ($8/mo) for a static domain, or deploy to Fly.io/Railway instead
