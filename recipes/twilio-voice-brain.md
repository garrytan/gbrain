---
id: twilio-voice-brain
name: Voice-to-Brain
version: 0.8.1
description: Phone calls create brain pages via Twilio + voice pipeline + GBrain MCP. Two architectures -- OpenAI Realtime (turnkey) or DIY STT+LLM+TTS (full control). Callers talk, brain pages appear.
category: sense
requires: [ngrok-tunnel]
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

Two pipeline options:

### Option A: OpenAI Realtime (turnkey, simpler)
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

### Option B: DIY STT+LLM+TTS (full control, production-grade)
```
Caller (phone or WebRTC browser)
  ↓ Twilio WebSocket OR WebRTC
Voice Server (Node.js)
  ↓ Deepgram STT (streaming speech-to-text, speaker diarization)
  ↓ Claude API (streaming SSE, sentence-boundary dispatch)
  ↓ Cartesia / OpenAI TTS (text-to-speech, low latency)
  ↓ Function calls during conversation
GBrain MCP (semantic search, page reads, page writes)
  ↓ Post-call
Brain page + audio upload + transcript storage
```

**Why v2 (Option B)?** OpenAI Realtime is a black box — you can't control STT
quality, swap LLMs, or debug audio issues. The DIY stack gives you transparent
Deepgram+Claude+TTS with full control over each stage. Trade-off: more integration
work, but you own the pipeline.

**Production-tested v2 architecture (pipeline.mjs, ~250 lines):**
- Streaming SSE from Claude with sentence-boundary TTS dispatch
- 20-turn conversation history cap (prevents context bloat)
- Reconnect logic with exponential backoff on STT/TTS disconnects
- Periodic keepalives to prevent WebSocket timeout
- Audio endpointing for natural turn-taking
- Smart VAD (Silero) as default with push-to-talk fallback

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

**Credential 3: ngrok Account (Hobby tier recommended)**

Tell the user:
"I need your ngrok auth token. **I strongly recommend the Hobby tier ($8/mo)**
because it gives you a fixed domain that never changes. With the free tier,
your URL changes every time ngrok restarts, breaking Twilio and Claude Desktop.

1. Go to https://dashboard.ngrok.com/signup (sign up)
2. **Recommended:** Go to https://dashboard.ngrok.com/billing and upgrade to
   **Hobby** ($8/mo). This gives you a fixed domain.
3. If you upgraded: go to https://dashboard.ngrok.com/domains and click
   **'+ New Domain'**. Choose a name (e.g., `your-brain-voice.ngrok.app`).
4. Go to https://dashboard.ngrok.com/get-started/your-authtoken
5. Copy your **Authtoken** and paste it to me
6. Also tell me your fixed domain name (if you created one)"

```bash
ngrok config add-authtoken $NGROK_TOKEN \
  && echo "PASS: ngrok configured" \
  || echo "FAIL: ngrok auth token rejected"
```

If user has a fixed domain, use `--url` flag (Step 3 below).
If user stayed on free tier, URLs will change on restart (the watchdog handles this).

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
# With fixed domain (Hobby tier — recommended):
ngrok http 8765 --url your-brain-voice.ngrok.app

# Without fixed domain (free tier — URL changes on restart):
ngrok http 8765
```

If using a fixed domain, the URL is always `https://your-brain-voice.ngrok.app`.
If using free tier, copy the URL from the ngrok output (changes every restart).

Note: ngrok runs in the foreground. Run it in a background process or new terminal tab.

The same ngrok account can also serve your GBrain MCP server (see
[ngrok-tunnel recipe](recipes/ngrok-tunnel.md) for the full multi-service pattern).

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

6. **WebRTC endpoint** (optional, for browser-based calling):
   - `POST /session` — accepts SDP offer, forwards to OpenAI Realtime `/v1/realtime/calls` as multipart form-data, returns SDP answer
   - `GET /call` — serves a web client HTML page with:
     - WebRTC connection to OpenAI Realtime API
     - RNNoise WASM noise suppression (AudioWorklet)
     - Push-to-talk AND auto-VAD mode switching
     - Pipeline: Microphone → RNNoise denoise → MediaStream → WebRTC → OpenAI
   - `POST /tool` — receives tool calls from the WebRTC data channel, executes them, returns results
   - This lets users call the voice agent from a browser tab instead of a phone

   **WebRTC session creation pseudocode:**
   ```
   POST /session:
     sdp = request.body  // caller's SDP offer

     sessionConfig = JSON.stringify({
       type: 'realtime',
       model: 'gpt-4o-realtime-preview',
       audio: { output: { voice: VOICE } },
       instructions: buildPrompt(null),
       tools: TOOL_SETS.unauthenticated,
     })

     // Use native FormData (Node 18+) — NOT manual multipart
     fd = new FormData()
     fd.set('sdp', sdp)
     fd.set('session', sessionConfig)

     response = POST 'https://api.openai.com/v1/realtime/calls'
       Authorization: Bearer OPENAI_API_KEY
       body: fd   // fetch() sets Content-Type automatically

     return response.text()  // SDP answer
   ```

   **Important WebRTC gotchas:**
   - `voice` goes under `audio.output.voice`, not top-level
   - Do NOT send `turn_detection` in session config (not accepted by `/v1/realtime/calls`)
   - Do NOT send `session.update` on connect (server already configured it)
   - All `session.update` calls must include `type: 'realtime'` to avoid session.type errors
   - `input_audio_transcription` is NOT supported over WebRTC data channel — use Whisper post-call on recorded audio instead
   - Trigger greeting via data channel after WebRTC connects

**Reference implementation:** The architecture above and the OpenAI Realtime API
docs (https://platform.openai.com/docs/guides/realtime) provide the building blocks.

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
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.8.1","status":"ok","details":{"phone":"TWILIO_NUMBER","deployment":"local+ngrok"}}' >> ~/.gbrain/integrations/twilio-voice-brain/heartbeat.jsonl
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

**Note on Option B credentials:** If using the DIY pipeline (Option B), you will
also need API keys for your chosen STT provider (e.g., Deepgram) and TTS provider
(e.g., Cartesia, OpenAI TTS). Collect and validate these during Step 2 alongside
the Twilio and OpenAI credentials listed above.

## Critical Production Fixes (v0.8.1)

These are NOT optional. They prevent real production failures discovered in a
deployment handling daily calls.

### Unicode Crash Fix (CRITICAL)

**Problem:** Em dashes (--), arrows (->), and other non-ASCII characters in the
prompt context cause broken surrogate pairs that crash the Twilio WebSocket
connection. Phone calls drop silently.

**Fix:** Replace ALL non-ASCII characters with ASCII equivalents throughout the
entire prompt file before sending to Twilio. This is invisible in development
(browsers handle unicode fine) and catastrophic in production.

```javascript
function sanitizeForTwilio(text) {
  return text
    .replace(/[\u2014\u2013]/g, '--')   // em/en dash
    .replace(/[\u2018\u2019]/g, "'")     // smart quotes
    .replace(/[\u201C\u201D]/g, '"')     // smart double quotes
    .replace(/\u2192/g, '->')              // right arrow
    .replace(/\u2190/g, '<-')              // left arrow
    .replace(/[\u2026]/g, '...')         // ellipsis
    .replace(/[^\x00-\x7F]/g, '')        // strip remaining non-ASCII
}
```

### PII Scrub from Voice Context (CRITICAL)

**Problem:** Brain context loaded into the voice prompt may contain phone numbers,
email addresses, and other PII. The voice agent reads these aloud to callers.

**Fix:** Regex-strip PII from all voice context before injecting into the prompt:
- Phone numbers: `/\+?\d[\d\s\-().]{7,}\d/g`
- Email addresses: `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g`
- URLs with auth tokens or API keys
- Any string matching common credential patterns

### Identity-First Prompt (IMPORTANT)

**Problem:** Voice agents lose their identity mid-conversation. Saying "You are NOT
Claude" doesn't stick. The model reverts to its base persona.

**Fix:** Put identity FIRST in the system prompt, before any context or rules:
```
# You ARE [Agent Name]
You are [Name], a voice assistant who works with [Brain Name].
You are NOT Claude. You are NOT a general AI assistant.
[Name] has their own personality: [traits].

# Context
[... brain context, calendar, tasks ...]

# Rules
[... behavioral rules ...]
```

Positioning identity before context ensures the model sees it first and
maintains it throughout the conversation.

### Auto-Upload Call Audio (RECOMMENDED)

**Problem:** If post-call processing fails, the call audio is lost forever.

**Fix:** Auto-upload ALL call audio immediately on call end:
- Twilio calls: download the MP3 recording URL from Twilio
- WebRTC calls: capture via MediaRecorder (webm/opus format)
- Upload via `gbrain files upload-raw <audio-file> --page meetings/call-slug --type call-recording`
- GBrain auto-routes: small files stay in git, large files go to cloud storage
  with `.redirect.yaml` pointer. Files >= 100 MB use TUS resumable upload.
- Generate signed URLs for playback: `gbrain files signed-url <storage-path>`
- This ensures every call has a recoverable audio source regardless
  of whether the transcript or brain page was created successfully

### Smart VAD as Default

**Problem:** Push-to-talk is unnatural on phone calls. Server-side VAD has
variable quality.

**Fix:** Default to Smart VAD (Silero VAD) for voice activity detection:
- Better endpointing than server-side VAD
- Fewer false triggers in noisy environments
- PTT available as fallback (UI toggle for WebRTC clients)
- Presets: quiet (0.7 threshold), normal (0.85), noisy (0.95), very_noisy (0.98)

## Production Patterns (Recommended)

These patterns come from a production voice deployment handling real calls daily.
They are NOT required for basic setup. **Implement them AFTER the smoke test passes.**
Each pattern is self-contained and optional.

### Agent Identity & Engagement

#### Identity Separation
**Problem:** A voice agent pretending to be the full AI system creates uncanny valley.
**Pattern:** The voice agent picks its own name and personality, distinct from the main
AI brain. "I work with [Brain], [Owner]'s AI." Lighter, more playful, more curious.

#### Pre-Computed Bid System
**Problem:** Dead air kills engagement. Voice agents wait passively.
**Pattern:** At call start, scan live context and pre-compute up to 10 engagement bids.
Two types: informative (tasks, calendar, social monitoring) and relational (curiosity templates).
Bids go INTO the prompt so the agent picks from a list. Use bids #1 and #2 for greeting,
cycle the rest during conversation. Never ask "anything else?" — bring up the next bid.

#### Context-First Prompt
**Problem:** Voice agent greets generically because it doesn't know what's happening today.
**Pattern:** Load live context at call start: tasks, calendar, location, social monitoring,
morning briefing. Position context FIRST in the prompt (before rules) so the model sees
it immediately and uses it in the greeting. Try/catch per section. Cap 500-1000 chars each.

#### Proactive Advisor Mode
**Problem:** Voice agents are reactive task machines.
**Pattern:** The agent drives the conversation. Anticipate decisions on stale tasks.
Suggest capitalizing on trending items. Connect upcoming events with brain context.
"Dead air is your enemy" — fill every pause. Never wait passively.

#### Conversation Timing (the #1 fix)
**Problem:** Voice agents interrupt mid-thought AND go silent when the caller is done.
Both feel terrible. Early "fill every pause" instructions cause the agent to talk over
the caller while they're thinking.
**Pattern:** Replace blanket "never be silent" with nuanced timing rules:
- **Caller talking or thinking:** SHUT UP. Even 3-5 second pauses mid-thought, wait.
  Incomplete sentence or mid-story = still thinking. Do not interrupt.
- **Caller done** (complete thought + 2-3 seconds silence): NOW respond. Use a bid,
  ask a follow-up, or pivot to the next topic.
- **Detection heuristic:** Incomplete sentence = still thinking. Complete statement +
  silence = done. Question directed at you = respond immediately.
- **Hard rule:** Never let silence go past 5 seconds after a COMPLETE thought.

Add this as a labeled section in the system prompt (e.g., `# CRITICAL: Conversation Timing`)
positioned prominently so the model sees it early. This came from real usage feedback
and is the single highest-impact voice quality improvement.

#### No Repetition Rule
**Problem:** Voice agent cycles back to the same bid multiple times in a call.
**Pattern:** Add to the system prompt: "Do NOT repeat yourself. If you already said
something, move to the NEXT bid. Vary your responses." Simple but addresses a real
annoyance that compounds over longer calls.

### Prompt Engineering

#### Radical Prompt Compression
**Problem:** Long system prompts increase latency and cost on every turn.
**Pattern:** Compress aggressively. Production went 13K to 4.7K tokens (65% cut).
Bullets over prose, cut repetition, behavior-first. Every token costs latency + money.

#### OpenAI Realtime Prompting Guide Structure
**Problem:** Prose paragraphs parse slowly for the model.
**Pattern:** Use labeled markdown sections: `# Role & Objective`, `# Personality & Tone`,
`# Rules`, `# Conversation Flow` with state machine substates (`## State 1: VERIFY`,
`## State 2: GREETING`, `## State 3: CONVERSATION`), `# Trust`.

#### Auth-Before-Speech
**Problem:** Auth flow adds dead air at call start.
**Pattern:** Call the auth tool BEFORE speaking any greeting. Then speak "Hey, code's on
its way." Shaves seconds off the round-trip.

#### Brain Escalation
**Problem:** Voice agent can't answer complex questions that need the full brain.
**Pattern:** If caller says "talk to [Brain]" or asks a deep question, immediately route
to main AI via gateway tool with verbal bridge: "one sec, checking with [Brain]."

### Call Reliability

#### Stuck Watchdog
**Problem:** Calls go silent when VAD stalls or tool execution hangs.
**Pattern:** 20-second timer. If no audio out: clear input buffer, inject "you still
there?" system message, force `response.create`.

#### Never Hang Up
**Problem:** AI agents try to end calls.
**Pattern:** Hard prompt rule: only the caller decides when the call ends. Never say
goodbye, "I'll let you go," or wrap-up language. If silence, ask "you still there?"

#### Thinking Sound
**Problem:** Dead air during slow tool execution.
**Pattern:** Pre-generate g711_ulaw audio chunks in a JSON array. Loop at 20ms intervals
during slow tools (brain search, web lookup). Stop when tool result returns.

#### Fallback TwiML
**Problem:** Voice agent crashes, callers get silence.
**Pattern:** `/fallback` endpoint returns TwiML forwarding to owner's cell. Configure as
Twilio fallback URL.

### Authentication & Authorization

#### Tool Set Architecture
**Problem:** Unauthenticated callers accessing write operations.
**Pattern:** Four sets: READ_TOOLS (all callers), WRITE_TOOLS (owner), SCOPED_WRITE_TOOLS
(trusted users), GATEWAY_TOOLS (authenticated). LLM doesn't see write tools until auth
succeeds. Upgrade via `session.update` with new tools array. All `session.update` calls
must include `type: 'realtime'`.

#### Trusted User Auth with Callback
**Problem:** People other than the owner need authenticated access.
**Pattern:** Phone registry + callback verification. Each user gets a scope: full,
household, content, operational. Scope determines which tools they access.

#### Caller Routing
**Problem:** Different callers need different experiences.
**Pattern:** `buildPrompt(callerPhone)` returns different system prompts: owner (OTP),
trusted (callback), inner circle (warm greeting + transfer), known (greeting, message),
unknown (screen + message).

### Voice Quality

#### Dynamic VAD / Noise Mode
**Problem:** Background noise causes false triggers or missed speech.
**Pattern:** `set_noise_mode` tool adjusts VAD threshold mid-call. Presets: quiet (0.7),
normal (0.85), noisy (0.95), very_noisy (0.98). Agent calls proactively on noise.

#### On-Screen Debug UI
**Problem:** console.log is useless when testing from a phone.
**Pattern:** WebRTC client displays tool calls, results, errors, and key events inline.

### Real-Time Awareness

#### Live Moment Capture
**Problem:** Important things said during a call are lost if the call drops or the
post-call summary tool doesn't fire.
**Pattern:** When the caller shares something important (feedback, ideas, personal
stories, decisions), log it in real-time using a `log_voice_request` tool. Don't
wait until the call ends. Tell the caller: "Got that, sending it to [Brain] now."
Also stream key moments to [messaging platform] during the call so the main agent
has awareness before the call is over.

#### Belt-and-Suspenders Post-Call
**Problem:** Post-call processing depends on the voice agent remembering to call the
`post_call_summary` tool. If the call drops or the agent forgets, the call is lost.
**Pattern:** Both the tool-based AND the automatic call-end handler should post
structured signals. The call-end handler (fires on WebSocket close or `/call-end`)
should post to [messaging platform] with:
- Audio file path
- Transcript file path (or warning if missing)
- Tools used during the call
- Explicit instruction: "[Brain]: Read the call, summarize, take action."

This ensures every call gets processed regardless of whether the voice agent
remembered to call the summary tool. Belt and suspenders.

### Post-Call Processing

#### Mandatory 3-Step Post-Call
**Problem:** Main agent doesn't know a call happened.
**Pattern:** Every call ends with three steps:
1. **Messaging notification** — summary to [messaging platform]
2. **Transcript to brain** — `brain/meetings/YYYY-MM-DD-call-{caller}.md`
3. **Audio to storage** — Twilio MP3 or WebRTC webm/opus, uploaded to cloud storage

#### WebRTC Audio + Transcript Parity
**Problem:** WebRTC calls don't go through Twilio, no automatic logging.
**Pattern:** Client captures audio (MediaRecorder, webm/opus) and transcript (per-turn
POST to `/transcript`). On call end, POST to `/call-end` saves JSON log. Both channels
produce identical output formats. Note: `input_audio_transcription` is NOT supported
over WebRTC data channel — use Whisper post-call instead.

#### Dual API Event Handling
**Problem:** OpenAI Realtime API changed event names.
**Pattern:** Handle both `response.audio.delta` (old) and `response.output_audio.delta`
(new). Same for `.done` events. Future-proofs against API changes.

### Brain Query Optimization

#### Report-Aware Query Routing
**Problem:** Voice queries about specific topics trigger slow vector searches.
**Pattern:** Check the question against a keyword map BEFORE full brain search:

| Keyword | Report Loaded |
|---------|--------------|
| email, inbox, mail | inbox sweep report |
| social, twitter, mentions | social engagement report |
| briefing, morning | morning briefing |
| meeting | meeting sync report |
| slack | slack scan report |
| content, ideas | content ideas report |

Load up to 2,500 chars of matching report. Break after first match. Fall back to full
brain search if no keyword matches.
