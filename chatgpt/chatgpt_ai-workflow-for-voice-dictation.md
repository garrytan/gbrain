---
title: "AI Workflow for Voice Dictation"
type: guide
created: 2026-04-18
updated: 2026-04-18
source: chatgpt-export
conversation_id: 69e3d1dd-eeec-83e8-a135-8c85b91a1328
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# AI Workflow for Voice Dictation

> Conversation ID: 69e3d1dd-eeec-83e8-a135-8c85b91a1328
> Created: 2026-04-18T18:47:58Z
> Updated: 2026-04-18T19:29:19Z
> Messages: 8

---

## User

Hey, currently using WhisperFlow to talk to agents on my Mac, and then I also have like the Claude app and all the different AI apps on my phone. And then I'm thinking about like Hermes agent on a machine, and then using that over like Signal or something. Question is, when I'm on the go, I have AirPods in usually and my phone. What would be the best workflow for me to set up where I can just like, like in an ideal world, I could say, like, hey Siri or something like that with my AirPods in and have it automatically start dictating with like Whisper flow into a chat input or something that I could then send entirely with voice commands to my Hermes agent or something like that. Is there like a workflow or a shortcut I could run where it's basically like either I push the quick action button on my phone or I push a button on my AirPods or I say command, and then it starts to allow me to dictate. And then when I finish, I say enter or something like that and the dictation automatically sends a message to my Hermes agent. And like, I guess I could always just use built-in SMS messaging would do this, but then I'd have to pay for Twilio. Is there a way I can do this over like Slack or Signal or something that would be free and send the messages to my agent because if I can do that, I can theoretically code while away from my machine and that would be a like massive unlock.

---

## Assistant

Mr. White, I’d build it like this:

**AirPods/Siri or Action Button → iOS Shortcut dictation → authenticated HTTPS POST → Hermes webhook → response delivered to Telegram or Slack.**

That gives you a mostly hands-free “code from anywhere” pipe without SMS/Twilio. Hermes already has a messaging gateway and webhook adapter, and its docs list Telegram, Discord, Slack, Signal, Matrix, email, webhooks, and SMS as supported channels. SMS is the Twilio path; the others avoid Twilio. citeturn275628view0turn991707view3

## Recommended setup

### 1. Trigger: Siri through AirPods, Action Button, or Back Tap

Use **Siri/AirPods** as the hands-free trigger. AirPods can activate Siri by press-and-hold or double-tap depending on model, and Siri can run any shortcut in your Shortcuts library by name. citeturn705196search1turn275628view5

Use **Action Button** as the reliable physical trigger. Apple supports assigning the iPhone Action Button to run a Shortcut on supported iPhones. citeturn930910view0turn930910view2

Use **Back Tap** as the fallback trigger. Apple supports double-tap/triple-tap on the back of the iPhone to run a Shortcut. citeturn930910view1

Best trigger names:

```text
Hermes
Tell Hermes
Agent
Ship this
```

Then you can say:

```text
Hey Siri, Hermes
```

or press your AirPods stem to invoke Siri and say:

```text
Hermes
```

### 2. Dictation: use Apple Shortcut dictation for automation, Flow for manual chat

For the fully automated workflow, use the iOS Shortcut action **Dictate Text** or **Ask for Input with dictation**, then send the transcript with **Get Contents of URL** as a JSON POST. Apple Shortcuts supports API requests through “Get Contents of URL,” including POST with a JSON request body. citeturn275628view6

Wispr Flow is still useful, but I’d treat it as the manual app-input layer. Flow’s iOS docs say its shortcut can be assigned to Action Button, Back Tap, or Control Center; when the Flow keyboard is active, text inserts into the active text field, and otherwise the transcript is copied to the clipboard. citeturn275628view3 Flow’s iOS hands-free docs also say iOS lacks desktop-style keyboard shortcuts and uses tap-to-record or Siri-triggered Flow notes. citeturn275628view4

So:

| Use case | Best dictation layer |
|---|---|
| Fully hands-free “send to agent” | Apple Shortcuts dictation |
| High-quality longform dictation into Slack/Telegram/Claude app | Wispr Flow keyboard |
| Voice memos to agent | Telegram/Hermes voice message support |

Hermes’s Telegram integration supports text, voice, images, and file attachments; it can auto-transcribe voice memos. citeturn298944view0

## Best transport choice

### Best overall: **Hermes webhook + Telegram response**

This is the cleanest path. The phone never needs to automate Slack/Signal UI. The shortcut sends a POST directly to Hermes, and Hermes replies wherever you want.

Hermes’s webhook adapter accepts POST requests, transforms the payload into an agent prompt, and can route responses to Telegram, Discord, Slack, Signal, Matrix, email, or logs. citeturn991707view0turn991707view3

Use Telegram as the response surface because Hermes Telegram is first-class, simple, mobile-native, and supports voice memos. Telegram’s Bot API is HTTP-based, and Hermes’s Telegram setup uses BotFather-issued bot tokens and allowed user IDs. citeturn275628view8turn298944view0turn298944view1

### Good alternative: **Hermes webhook + Slack response**

Slack is fine if you already live there. Hermes’s Slack adapter uses Socket Mode, so Hermes does not need a public Slack-facing HTTP endpoint; it connects over WebSocket with Slack bot/app tokens. citeturn781777view0 Slack’s free plan is workable, with a 90-day searchable message history limit. citeturn470873search0

Avoid using a Slack **incoming webhook** as your primary “send to Hermes” path. Slack incoming webhooks post messages from apps into Slack channels, which means the message is app-authored rather than a normal user-authored Hermes DM. citeturn318168search2 Use Hermes’s own webhook as the inbound path, then deliver the result to Slack.

### Privacy option: **Signal**

Hermes supports Signal, but it uses `signal-cli` in HTTP daemon mode. Hermes’s docs require signal-cli, Java, and a Signal account linked as a secondary device. citeturn275628view1 The signal-cli project describes itself as an unofficial command-line/JSON-RPC interface and says it must be kept current because Signal server changes can break older releases. citeturn501977view0

Use Signal if privacy is the priority. Use Telegram or Slack if speed and reliability are the priority.

## Concrete build

### iOS Shortcut: “Hermes”

Create a Shortcut named **Hermes**:

1. **Dictate Text**
   - Language: English
   - Stop Listening: After Pause
2. **Dictionary**
   - `event_type`: `mobile_command`
   - `source`: `ios_shortcut`
   - `message`: dictated text
   - `timestamp`: current date
3. **Get Contents of URL**
   - URL: your relay endpoint, for example:

```text
https://agent.yourdomain.com/voice
```

   - Method: `POST`
   - Headers:

```text
Content-Type: application/json
Authorization: Bearer <long-random-mobile-token>
```

   - Request Body: JSON dictionary from step 2
4. **Speak Text** or **Show Notification**
   - “Sent to Hermes.”

Then map it to:

```text
Settings → Action Button → Shortcut → Hermes
```

and:

```text
Settings → Accessibility → Touch → Back Tap → Double Tap → Hermes
```

For AirPods:

```text
Hey Siri, Hermes
```

or press/hold AirPods to activate Siri, then say:

```text
Hermes
```

### Hermes webhook route

In `~/.hermes/config.yaml`, create a mobile route:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      secret: "your-hermes-hmac-secret"
      routes:
        mobile:
          events: ["mobile_command"]
          secret: "your-hermes-hmac-secret"
          prompt: |
            Mobile voice command from Tim:

            {message}

            Treat this as an instruction from the owner. If this involves code:
            - identify the repo/branch if provided
            - ask for missing destructive permissions
            - prefer creating a branch and PR over pushing to main
          deliver: "telegram"
          deliver_extra:
            chat_id: "YOUR_TELEGRAM_CHAT_ID"
```

Hermes supports route-level prompt templates, skills, delivery targets, and delivery metadata such as chat IDs. citeturn991707view0turn991707view1

For Slack delivery, change:

```yaml
deliver: "slack"
deliver_extra:
  chat_id: "YOUR_SLACK_CHANNEL_ID"
```

or configure `SLACK_HOME_CHANNEL` and omit `chat_id`. Hermes’s Slack docs also recommend allowlisting authorized Slack member IDs. citeturn781777view0

## Auth layer

Hermes generic webhooks expect an HMAC signature header when a secret is configured. The docs specify `X-Webhook-Signature` as a raw HMAC-SHA256 hex digest for generic webhooks, and requests are rejected when a secret exists without a recognized signature header. citeturn991707view3

iOS Shortcuts is awkward for HMAC signing. Use a tiny relay:

```python
import hashlib
import hmac
import os

import httpx
from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()

MOBILE_TOKEN = os.environ["MOBILE_TOKEN"]
HERMES_SECRET = os.environ["HERMES_WEBHOOK_SECRET"]
HERMES_URL = os.environ.get(
    "HERMES_URL",
    "http://127.0.0.1:8644/webhooks/mobile",
)

@app.post("/voice")
async def voice(request: Request, authorization: str = Header(default="")):
    if authorization != f"Bearer {MOBILE_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")

    body = await request.body()
    sig = hmac.new(
        HERMES_SECRET.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()

    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            HERMES_URL,
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Webhook-Signature": sig,
            },
        )
        r.raise_for_status()

    return {"ok": True}
```

Expose that relay through **Tailscale** or **Cloudflare Tunnel**. Tailscale’s Personal plan is free, and Cloudflare Tunnel can expose services without a public IP. citeturn242454search0turn242454search3

My preferred security shape:

```text
iPhone Shortcut
  → HTTPS relay with bearer token
  → local Hermes webhook with HMAC
  → Hermes gateway
  → Telegram/Slack/Signal response
```

## Final recommendation

Build this first:

```text
AirPods/Siri → Shortcut “Hermes” → Dictate Text → HTTPS relay → Hermes webhook → Telegram DM response
```

Then add:

```text
Action Button → same Shortcut
Back Tap → same Shortcut
Slack delivery → optional
Signal delivery → only if privacy matters more than setup friction
Wispr Flow → manual high-quality dictation into app text fields
```

That gives you the unlock you want: phone in pocket, AirPods in, dictate a coding instruction, Hermes executes on the machine/VPS, and the result comes back to your chat surface without paying for Twilio.

---

## User

seems overcomplicated. cant i just get a shortcut to open slack and write a message there? heremey is alreayd setup to accept slack maessages

---

## Assistant

Yes. I’m simplifying this to Shortcut dictation into Slack since Hermes already reads Slack, and I’m checking whether iOS allows the final send to be fully automatic or requires one tap.

---

## Assistant

Yes, Mr. White. Start with the simple version.

## Simplest practical Shortcut

Create an iOS Shortcut called **Hermes Slack**:

1. **Dictate Text**
   - Stop listening: **After Pause**
2. **Copy to Clipboard**
   - Input: dictated text
3. **Open URL**
   - For a Slack channel:

```text
slack://channel?team=T123456789&id=C123456789
```

   - For a Slack DM with Hermes/user/bot:

```text
slack://user?team=T123456789&id=U123456789
```

4. Optional: **Speak Text**
   - “Copied. Paste and send.”

Then trigger it with:

```text
Hey Siri, Hermes Slack
```

or bind it to the iPhone Action Button / Back Tap.

Slack officially supports `slack://` deep links for opening the native app, channels, and DMs on iPhone, but the supported URI list requires workspace/team IDs and channel/user IDs; it does not document a message-body parameter for pre-filling text. citeturn842880view0

So the realistic flow is:

```text
AirPods → “Hey Siri, Hermes Slack”
→ dictate message
→ Slack opens to Hermes channel/DM
→ tap message box
→ paste
→ send
```

Apple dictation works anywhere you can type, and supports spoken punctuation like “period,” “comma,” “new line,” etc. citeturn842880view3turn842880view4

## More hands-free version

Turn on **Voice Control** and after Slack opens, say:

```text
Tap message field
Paste
Tap send
```

That gets close to fully voice-only, though it may be slightly janky because you are driving the Slack UI through accessibility commands.

## Fully automated version, still simple

Use Slack’s API directly from the Shortcut:

```text
Dictate Text → POST to Slack chat.postMessage → Hermes sees the Slack message
```

Shortcut action:

**Get Contents of URL**

```text
https://slack.com/api/chat.postMessage
```

Method:

```text
POST
```

Headers:

```text
Authorization: Bearer xoxb-your-slack-bot-token
Content-Type: application/json
```

JSON body:

```json
{
  "channel": "C123456789",
  "text": "DICTATED_TEXT_GOES_HERE"
}
```

Slack’s `chat.postMessage` method posts a message to a public channel, private channel, or DM, and Slack Web API requests use bearer-token authentication. citeturn842880view1turn842880view2

The one gotcha: this posts as the Slack app/bot, not necessarily as you. Hermes may ignore bot-authored Slack messages to avoid loops. If Hermes reacts to bot messages in that channel, this is the cleanest setup. If Hermes only accepts human Slack messages from your user ID, use the clipboard/open-Slack flow above.

My recommendation:

```text
Phase 1:
Shortcut dictates → copies text → opens Hermes Slack channel

Phase 2:
If Hermes accepts bot messages:
Shortcut dictates → Slack API chat.postMessage → fully hands-free send
```

Start with Phase 1. It should take a few minutes and avoids webhooks, Signal, Twilio, and extra relay code.

---

## User

is this the best or is there an even better move like ssh or whatsapp or something else?

---

## Assistant

I’ll compare the realistic mobile-to-Hermes options by friction, reliability, hands-free potential, security, and whether they preserve your existing Slack setup. The main distinction is chat transport versus direct machine control, and whether Hermes needs messages to appear as you or can safely accept bot/API-originated ones.

---

## Assistant

Mr. White, **Slack is probably still the best move** since Hermes already accepts Slack messages.

The better version is:

```text
AirPods / Action Button / Siri
→ iOS Shortcut
→ Dictate Text
→ Slack API posts directly into Hermes Slack channel
→ Hermes responds in Slack
```

That beats opening Slack and pasting manually.

## Ranking

| Option | Verdict | Why |
|---|---:|---|
| **Shortcut → Slack API → Hermes** | **Best default** | Free, fast, mobile-native, async, searchable, already wired into Hermes |
| **Shortcut → SSH → Hermes/Mac command** | Best power-user fallback | Direct control of your machine, no Slack dependency, great for starting jobs |
| **Shortcut opens Slack + clipboard** | Good MVP | Almost zero setup, but requires tap/paste/send |
| **Signal** | Privacy option | More setup and usually more brittle |
| **WhatsApp** | Avoid | Policy/API friction, bot limitations, possible AI-assistant restrictions |
| **SMS/Twilio** | Avoid | Costs money and adds little value here |

## My recommendation

Use **Slack API as the primary input rail**, then optionally add **SSH as an emergency/direct-control rail**.

The ideal setup:

```text
“Hey Siri, Hermes”
→ Shortcut records dictation
→ posts to #hermes-mobile or Hermes DM in Slack
→ Hermes treats that Slack message as your command
→ Hermes replies in Slack
```

Slack’s `chat.postMessage` API can post into public channels, private channels, and DMs by channel ID, subject to the authenticated app/user’s permissions. Slack also documents bearer-token authentication for Web API requests. citeturn675238view0turn533360search3

## Why Slack beats SSH for this

Slack gives you:

```text
message history
threads
files/screenshots
mobile notifications
Hermes replies in the same place
easy “continue that task” conversations
no need for phone-to-Mac network reachability
```

SSH gives you:

```text
direct execution
lower latency
no third-party chat surface
works even if Slack/Hermes Slack adapter breaks
```

For actual “code while away from machine,” SSH is useful, but as a **command execution backend**, not as the main conversational interface.

## Best Slack implementation

Create a dedicated Slack channel:

```text
#hermes-mobile
```

Then the Shortcut does:

```text
Dictate Text
→ Get Contents of URL
→ POST https://slack.com/api/chat.postMessage
```

JSON body:

```json
{
  "channel": "C123456789",
  "text": "DICTATED_TEXT"
}
```

Headers:

```text
Authorization: Bearer xoxb-...
Content-Type: application/json
```

Slack recommends short human-readable messages and notes that `text` is ideally under 4,000 characters, with hard truncation above 40,000 characters. That is fine for voice commands. citeturn675238view0

Important gotcha: if Hermes ignores bot-authored Slack messages, configure Hermes to allow one trusted “mobile voice” Slack bot, or use a user-token approach. Slack has user-token scopes for sending messages on a user’s behalf, but I would first try the cleaner bot route and explicitly allow that bot in Hermes. citeturn533360search2turn675238view0

## Where SSH fits

Add a second Shortcut called:

```text
Hermes SSH
```

Flow:

```text
Dictate Text
→ Run Script over SSH
→ execute local command on your Mac/server
```

Example remote command pattern:

```bash
printf '%s' "$SHORTCUT_INPUT" | hermes send --source mobile
```

or:

```bash
printf '%s' "$SHORTCUT_INPUT" >> ~/hermes/inbox/mobile.txt
```

or:

```bash
curl -s http://localhost:8644/mobile-command \
  -H 'Content-Type: application/json' \
  -d "{\"text\": $(jq -Rs . <<< "$SHORTCUT_INPUT")}"
```

iOS Shortcuts supports “Run Script over SSH”; a Mac setup guide describes enabling Remote Login, adding the Shortcuts SSH action, and using SSH-key authentication. citeturn675238view4

For remote access, I’d put the Mac/server on **Tailscale** rather than exposing SSH to the internet. Tailscale SSH is available on all plans and uses Tailscale identity/access controls for SSH authorization; Tailscale also has a free Personal plan for individual use. citeturn553336search0turn553336search1

Use SSH for commands like:

```text
restart Hermes
pull latest repo
kick off a build
open tmux session
run tests
ship this branch
```

Use Slack for natural-language tasking and responses.

## Why I would avoid WhatsApp

WhatsApp is bad for this specific use case.

The personal app has click-to-chat/deep-link style workflows, but it is not a clean programmable bot surface. The Business Platform has policy and pricing complexity. WhatsApp’s Business Solution Terms now include an “AI Providers” section that restricts AI/ML providers, including LLMs and general-purpose assistants, from using the WhatsApp Business Solution when the AI is the primary functionality, with exceptions for EEA/Brazil numbers. citeturn251743view1

There is also current regulatory conflict around Meta’s WhatsApp AI-assistant access policy, which adds instability to this as a build surface. citeturn675238view5

So I would not build your personal coding-agent control plane on WhatsApp.

## Signal

Signal is viable only if privacy matters more than convenience.

Most agent integrations use `signal-cli`, which is an unofficial command-line/JSON-RPC interface for Signal. It can send and receive messages, but it adds server setup and maintenance risk. citeturn855117search0

For your use case, Signal is worse than Slack unless you specifically want Signal’s privacy model.

## Final answer

Build this:

```text
Primary:
Shortcut → Dictate Text → Slack chat.postMessage → #hermes-mobile → Hermes

Secondary:
Shortcut → Dictate Text → Run Script over SSH via Tailscale → local Hermes/Mac command

Avoid:
WhatsApp, SMS/Twilio
```

The best first version is **Slack API, not opening Slack UI**. It gives you the voice workflow you want without extra infrastructure, and it keeps the entire Hermes conversation inside the tool Hermes already listens to.


## See Also
- [[chatgpt/chatgpt_voice-based-brainstorming-workflow]]
- [[chatgpt/chatgpt_2026-landing-page-workflow]]
- [[chatgpt/chatgpt_admin-workflow-design]]
- [[chatgpt/chatgpt_ai-deal-workflow-explanation]]
- [[chatgpt/chatgpt_ai-dev-workflow-optimization]]
