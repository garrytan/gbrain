---
title: "iMessages Hermes Integration"
type: note
created: 2026-05-12
updated: 2026-05-12
source: chatgpt-export
conversation_id: 6a026f9b-d3ac-83e8-bcb1-d1341c2ed00f
message_count: 3
tags: [chatgpt, import]
---
# iMessages Hermes Integration

> Conversation ID: 6a026f9b-d3ac-83e8-bcb1-d1341c2ed00f
> Created: 2026-05-12T00:09:00Z
> Updated: 2026-05-12T00:12:13Z
> Messages: 3

---

## User

I find iMessages to just be like a nicer experience than Telegram or WhatsApp or anything. It's like where my texts already are, so it's just one less app to have. Can I set up my Hermes agent to use iMessages and do it without it costing me? Like, if my phone's on Wi-Fi and it's using iMessages, then it should just be free, right? Is that possible?

---

## Assistant

I’ll separate feasibility, reliability, and cost, since iMessage can be low-cost as transport while Apple’s tooling limits agent-style automation.

---

## Assistant

Mr. White, **yes, it is possible**, and **the iMessage transport itself can be effectively free**, but only under the right setup.

The cleanest route is **Hermes + BlueBubbles on an always-on Mac**. Hermes now documents a **BlueBubbles iMessage gateway** that connects Hermes to Apple Messages through a Mac running BlueBubbles Server. Hermes describes the flow as:

`iMessage → Messages.app → BlueBubbles Server → Webhook → Hermes`  
`Hermes → BlueBubbles REST API → Messages.app → iMessage`

It requires an always-on Mac, Messages.app signed into an Apple ID, BlueBubbles Server, and network connectivity between Hermes and the Mac. BlueBubbles is described as a free, open-source macOS iMessage bridge. citeturn276188view0turn265460view0

On cost: **blue-bubble iMessages are data messages, not SMS**. Apple says iMessages can be sent over Wi‑Fi or cellular, do not count against SMS/MMS/RCS allowances, and only cellular data rates may apply. So over Wi‑Fi, there is generally no per-message carrier cost. citeturn122793view0turn122793view1

The caveats:

1. **You need a Mac acting as the iMessage bridge.** Your phone being on Wi‑Fi helps when you message the agent, but the agent’s outbound iMessages are sent through the Mac’s Messages.app / Apple ID path, not directly through your iPhone.

2. **Avoid SMS fallback.** Hermes’s `imsg` skill supports forcing `--service imessage`; otherwise Messages may auto-pick SMS/RCS in some cases. Blue bubbles are the free path. Green bubbles can create carrier/SMS costs. Hermes’s own iMessage skill docs show service options for `imessage`, `sms`, and `auto`. citeturn977954view0

3. **Apple does not provide a normal public iMessage bot API like Telegram/Discord.** Hermes works around this through macOS Messages.app, BlueBubbles, webhooks, and REST. That is practical, but it depends on an always-on Mac and Apple’s Messages ecosystem. Hermes’s docs list BlueBubbles as a supported messaging platform, while a GitHub issue also notes the broader limitation that iMessage lacks an official bot-style API. citeturn977954view1turn977954view2

4. **The iMessage transport can be free, but the model may still cost money.** If Hermes is calling OpenAI, OpenRouter, Nous Portal, etc., you still pay those inference/API costs. If you run the model locally, then the marginal cost is basically electricity, Mac uptime, and internet.

My recommendation: use **BlueBubbles for receiving/sending iMessages through Hermes**, configure Hermes to only answer approved users, and force iMessage/blue-bubble behavior where possible. That gives you the closest version of “my agent lives in Messages and costs me nothing per message.”
