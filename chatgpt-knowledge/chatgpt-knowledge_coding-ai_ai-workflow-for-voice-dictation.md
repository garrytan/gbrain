---
title: "AI Workflow for Voice Dictation"
type: guide
created: 2026-04-18
updated: 2026-04-18
source: chatgpt-export
topic: coding-ai
message_count: 8
tags: [chatgpt, knowledge, coding-ai]
---
# AI Workflow for Voice Dictation

> **Source:** ChatGPT conversation
> **Date:** 2026-04-18T18:47:58Z
> **Messages:** 8
> **Topic:** coding-ai

## Question

Hey, currently using WhisperFlow to talk to agents on my Mac, and then I also have like the Claude app and all the different AI apps on my phone. And then I'm thinking about like Hermes agent on a machine, and then using that over like Signal or something. Question is, when I'm on the go, I have AirPods in usually and my phone. What would be the best workflow for me to set up where I can just like, like in an ideal world, I could say, like, hey Siri or something like that with my AirPods in and have it automatically start dictating with like Whisper flow into a chat input or something that I could then send entirely with voice commands to my Hermes agent or something like that. Is there like a workflow or a shortcut I could run where it's basically like either I push the quick action button on my phone or I push a button on my AirPods or I say command, and then it starts to allow me to dictate. And then when I finish, I say enter or something like that and the dictation automatically s

## Answer

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

Hermes’s webhook adapter accepts POST requests, transforms the payload into an agent p

*(Answer truncated — 9164 chars total)*

## Question

seems overcomplicated. cant i just get a shortcut to open slack and write a message there? heremey is alreayd setup to accept slack maessages

## Answer

Yes. I’m simplifying this to Shortcut dictation into Slack since Hermes already reads Slack, and I’m checking whether iOS allows the final send to be fully automatic or requires one tap.

## Answer

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

## Question

is this the best or is there an even better move like ssh or whatsapp or something else?

## Answer

I’ll compare the realistic mobile-to-Hermes options by friction, reliability, hands-free potential, security, and whether they preserve your existing Slack setup. The main distinction is chat transport versus direct machine control, and whether Hermes needs messages to appear as you or can safely accept bot/API-originated ones.

## Answer

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

Important gotcha: if Hermes ignores bot-authored Slack messages, configure Hermes to allow one trusted “mobile voice” Slack bot, or use a user-token approach. Slack has user-token scopes for sending messages on a user’s behalf, but I would first try the cleaner bot route and explicitl

*(Answer truncated — 5927 chars total)*
