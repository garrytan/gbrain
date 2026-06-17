---
id: ngrok-tunnel
name: Public Tunnel
version: 0.7.0
description: Fixed public URL for your brain (MCP server, voice agent, any service). One ngrok account, never changes.
category: infra
requires: []
secrets:
  - name: NGROK_AUTHTOKEN
    description: ngrok auth token (Hobby tier recommended for fixed domain)
    where: https://dashboard.ngrok.com/get-started/your-authtoken — sign up, then copy your authtoken
health_checks:
  - type: command
    argv: ["pgrep", "-f", "ngrok.*http"]
    label: "ngrok process"
  - type: http
    url: "http://localhost:4040/api/tunnels"
    label: "ngrok API"
setup_time: 10 min
cost_estimate: "$8/mo for Hobby tier (fixed domain). Free tier works but URLs change on restart."
---

# Public Tunnel: Fixed URL for Your Brain

Your GBrain MCP server and voice agent need public URLs so Claude Desktop,
Perplexity, and Twilio can reach them. ngrok gives you a fixed domain that
never changes.

## IMPORTANT: Instructions for the Agent

**You are the installer.** This is foundational infrastructure. Other recipes
(voice-to-brain, remote MCP) depend on this. Set it up first.

**Why this matters:**
- Voice-to-brain needs a public URL for Twilio webhooks
- Remote MCP needs a public URL for Claude Desktop and Perplexity
- Free ngrok URLs change on every restart, breaking all integrations
- Hobby tier ($8/mo) gives a fixed domain. Set it once, never touch it again.

**Do not skip steps. Verify after each step.**

## Architecture

```
Local services (your machine)
  ├── GBrain MCP server (port 3000)    gbrain serve
  └── Voice agent (port 8765)          node server.mjs
         │
         ▼
ngrok tunnel (fixed domain)
  └── https://your-brain.ngrok.app
         │
         ├── /mcp   → Claude Desktop, Claude Code, Perplexity
         └── /voice  → Twilio webhooks
```

## Setup Flow

### Step 1: Create ngrok Account + Get Hobby Tier

Tell the user:
"I need you to create an ngrok account. I strongly recommend Hobby tier ($8/mo)
for a fixed domain that never changes. Without it, every restart breaks your
Twilio webhooks and Claude Desktop connection.

1. Go to https://dashboard.ngrok.com/signup (sign up)
2. Go to https://dashboard.ngrok.com/billing and upgrade to **Hobby** ($8/mo)
3. Go to https://dashboard.ngrok.com/get-started/your-authtoken
4. Copy your **Authtoken** and paste it to me"

Validate:
```bash
ngrok config add-authtoken $NGROK_AUTHTOKEN \
  && echo "PASS: ngrok configured" \
  || echo "FAIL: ngrok auth token rejected"
```

If ngrok is not installed:
- **Mac:** `brew install ngrok`
- **Linux:** `curl -sL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar xz -C /usr/local/bin`

**STOP until ngrok validates.**

### Step 2: Claim a Fixed Domain

Tell the user:
"1. Go to https://dashboard.ngrok.com/domains
2. Click **'+ New Domain'**
3. Choose a name (e.g., `your-brain.ngrok.app`)
4. Click **'Create'**
5. Tell me the domain name you chose"

If user stayed on free tier (no fixed domain), note that URLs will change on
restart and the watchdog will need to update Twilio. Recommend upgrading later.

### Step 3: Start the Tunnel

```bash
# With fixed domain (Hobby):
ngrok http 8765 --url your-brain.ngrok.app

# Without fixed domain (free):
ngrok http 8765
```

Verify:
```bash
curl -sf http://localhost:4040/api/tunnels \
  && echo "PASS: ngrok tunnel active" \
  || echo "FAIL: ngrok not running"
```

### Step 4: Set Up Watchdog

The tunnel must auto-restart if it dies. Create a watchdog:

```bash
#!/bin/bash
# ngrok-watchdog.sh — run via cron every 2 minutes

# Check if ngrok is running
if ! pgrep -f "ngrok.*http" > /dev/null 2>&1; then
  echo "[watchdog] ngrok not running — starting..."

  # Install if missing
  if ! command -v ngrok > /dev/null 2>&1; then
    echo "[watchdog] ngrok not installed"
    exit 1
  fi

  # Start with fixed domain (if configured) or free
  if [ -n "$NGROK_DOMAIN" ]; then
    nohup ngrok http 8765 --url "$NGROK_DOMAIN" > /dev/null 2>&1 &
  else
    nohup ngrok http 8765 > /dev/null 2>&1 &
  fi
  sleep 5

  # If no fixed domain, update Twilio webhook with new URL
  if [ -z "$NGROK_DOMAIN" ] && [ -n "$TWILIO_ACCOUNT_SID" ]; then
    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
      | grep -o '"public_url":"https://[^"]*' | grep -o 'https://.*')
    if [ -n "$NGROK_URL" ] && [ -n "$TWILIO_NUMBER_SID" ]; then
      curl -s -X POST -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
        "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$TWILIO_NUMBER_SID.json" \
        -d "VoiceUrl=${NGROK_URL}/voice" > /dev/null
      echo "[watchdog] Twilio updated: $NGROK_URL"
    fi
  fi

  echo "[watchdog] ngrok started"
else
  echo "[watchdog] ngrok running"
fi
```

Add to crontab:
```bash
*/2 * * * * NGROK_DOMAIN=your-brain.ngrok.app /path/to/ngrok-watchdog.sh >> /tmp/ngrok-watchdog.log 2>&1
```

### Step 5: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/ngrok-tunnel
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"domain":"NGROK_DOMAIN","tier":"hobby"}}' >> ~/.gbrain/integrations/ngrok-tunnel/heartbeat.jsonl
```

## Connecting AI Clients (after tunnel is running)

**Claude Code:**
```bash
claude mcp add gbrain -t http https://your-brain.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_GBRAIN_TOKEN"
```

**Claude Desktop:**
Go to Settings > Integrations > Add. Enter:
`https://your-brain.ngrok.app/mcp`

IMPORTANT: Claude Desktop does NOT support remote MCP via JSON config.
You MUST use Settings > Integrations in the GUI. This is the #1 setup failure.

**Perplexity Computer:**
Settings > Connectors > Add Remote MCP.
URL: `https://your-brain.ngrok.app/mcp`

## Implementation Guide

### The Watchdog Pattern (from production)

```
watchdog():
  // Check: is ngrok running?
  if not process_running("ngrok.*http"):
    start_ngrok()
    sleep(5)

    // If no fixed domain, must update Twilio
    if no_fixed_domain AND twilio_configured:
      new_url = get_ngrok_url()  // from localhost:4040/api/tunnels
      update_twilio_webhook(new_url + "/voice")

  // Check: is the service behind ngrok running?
  if not curl_succeeds("http://localhost:PORT/health"):
    restart_service()
```

### ngrok Inspect Dashboard

`http://localhost:4040` shows all requests flowing through the tunnel. Use this
to debug MCP connection issues (see request/response headers, latency, errors).

## Tricky Spots

1. **Claude Desktop requires GUI setup.** Adding remote MCP servers via
   `claude_desktop_config.json` does NOT work. It silently fails with no error.
   You MUST use Settings > Integrations.

2. **Free tier URLs are ephemeral.** They change on every ngrok restart. The
   watchdog handles Twilio, but Claude Desktop and Perplexity must be manually
   reconfigured. This is why Hobby ($8/mo) is worth it.

3. **One domain, multiple services.** Hobby gives 1 free domain. Route by path
   (`/mcp`, `/voice`) on one domain, or pay $8/mo more for a second domain.

4. **The watchdog must run on startup.** If the machine reboots, ngrok won't
   auto-start unless you have a watchdog cron or systemd service.

## How to Verify

1. Start tunnel. Visit `https://your-brain.ngrok.app` in a browser.
   You should see a response (health check or default page).
2. From Claude Desktop, run `gbrain search "test"`. Results should come back.
3. Kill ngrok. Wait 2 minutes. Check the watchdog restarted it.
4. From a different device (phone), access the same URL. Verify it works.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| ngrok Free | $0 (ephemeral URLs, change on restart) |
| ngrok Hobby | $8/mo (1 fixed domain, enough for MCP + voice) |
| ngrok Pro | $20/mo (2+ domains, IP restrictions) |
| **Recommended** | **$8/mo (Hobby)** |

---

*Part of the [GBrain Skillpack](../docs/GBRAIN_SKILLPACK.md). See also: [Voice-to-Brain](twilio-voice-brain.md), [Remote MCP Deployment](../docs/mcp/DEPLOY.md)*
