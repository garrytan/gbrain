---
title: "Inbox Ops Process"
type: guide
created: 2026-05-27
updated: 2026-05-27
source: chatgpt-export
conversation_id: 6a172d09-1a08-83e8-9300-057ad14446a1
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Inbox Ops Process

> Conversation ID: 6a172d09-1a08-83e8-9300-057ad14446a1
> Created: 2026-05-27T17:42:46Z
> Updated: 2026-05-27T17:50:41Z
> Messages: 6

---

## User

OKay. i need to deal with 
some operations stuff.

• Twitter DMs need to get triaged and handled
• FB Messages
• IMessage
• IG DMs


we need to build a process for this

---

## Assistant

Mr. White, I’ll frame this as an operating system first, then map tools/agents onto it. The key is separating capture, classification, drafting, approval, and sending.

---

## Assistant

Mr. White, build this as **Inbox Ops**, not “reply to messages.”

## Core rule

**No agent sends anything without approval.**  
The system should triage, summarize, draft, and queue. You approve/send.

## Operating model

### 1. One source of truth: `Inbox Ops` board

Use Linear, Airtable, or a simple database table.

Each item gets:

| Field | Purpose |
|---|---|
| Channel | Twitter, FB, iMessage, IG |
| Sender | Name + handle/phone |
| Relationship | friend, fan, investor, customer, seller, scam, unknown |
| Intent | opportunity, support, personal, logistics, spam, conflict |
| Urgency | now, today, this week, ignore |
| Value | high, medium, low |
| Risk | normal, sensitive, legal, money, relationship |
| Suggested action | reply, archive, follow up, escalate |
| Draft reply | editable |
| Status | new → triaged → drafted → approved → sent → logged |

## Channel policy

### Twitter DMs

Likely highest business value.

Route aggressively for:

- investors
- founder/networking intros
- Jovie leads
- creators/artists
- press
- technical opportunities
- known people

Default action: **summarize + draft + queue for approval.**

### IG DMs

Likely highest social/audience value.

Route for:

- artists
- fans
- girls/social
- music collaborators
- Jovie leads
- content replies
- inbound opportunities

Default action: **separate personal/social from business.**  
Do not let business automation make you sound like a corporate account.

### Facebook Messages

Likely mixed value.

Route for:

- Marketplace
- old contacts
- event/show contacts
- local logistics
- scams/lowballers

Default action: **fast canned replies.**  
FB gets the lowest writing effort unless it is clearly valuable.

### iMessage

Most sensitive.

Route for:

- reminders
- unresolved threads
- logistics
- people you owe replies to
- relationship/family/friend priority

Default action: **summaries and suggested replies only.**  
No auto-send. No scraping entire personal history unless explicitly needed.

## Triage categories

Use these 8 buckets.

### 1. Money now

Examples: sale, job, booking, investor, customer, urgent business.

Action: **same-day response.**

### 2. Jovie lead

Artist, manager, creator, label, founder, partner.

Action: **log to Jovie CRM + draft concise reply.**

### 3. Relationship maintenance

Friends, collaborators, people worth keeping warm.

Action: **draft casual reply, no corporate tone.**

### 4. Personal urgent

Liv, family, rent, apartment, health, logistics.

Action: **surface immediately.**

### 5. Social optional

Fans, compliments, casual chatter, low-value banter.

Action: **batch reply or heart/react.**

### 6. Marketplace / transactional

Buyers, sellers, scheduling, price negotiation.

Action: **use canned scripts.**

### 7. Conflict / sensitive

Legal, money disputes, emotional threads, exes, anything that could escalate.

Action: **summarize only. Require manual handling.**

### 8. Spam / dead

Bots, scams, cold garbage, obvious low-value.

Action: **archive/block/ignore.**

## Approval flow

Use a simple approval menu:

- **Send**
- **Edit**
- **Make shorter**
- **Make warmer**
- **Make colder**
- **Ask me first**
- **Ignore**
- **Follow up later**

For you, default should be:

> concise, direct, casual, low-effort unless high-value.

## Agent setup

### Best architecture

Use **one Inbox Ops agent**, not four separate platform agents.

Under it, use channel adapters:

```text
Chief of Staff
└── Inbox Ops Agent
    ├── Twitter Adapter
    ├── Instagram Adapter
    ├── Facebook Adapter
    └── iMessage Adapter
```

The **Chief of Staff** should only receive escalations:

- high-value opportunity
- urgent personal issue
- unresolved conflict
- money/legal/rent/work
- Jovie lead worth logging
- anything needing your actual judgment

The Inbox Ops agent handles everything else.

## MVP process

### Daily cadence

#### Morning: 10–15 minutes

Agent produces:

```text
Inbox Digest

1. Urgent / money
2. Jovie leads
3. Personal replies owed
4. Social optional
5. Ignore/archive
```

You approve the highest-priority replies.

#### Afternoon: 5 minutes

Quick check for urgent follow-ups.

#### Night: 5 minutes

Clear personal/social backlog or intentionally leave it.

## Message handling rules

### Auto-draft allowed

- “Thanks, will check this out.”
- “Can you send details?”
- “What time works?”
- “Price is firm.”
- “Send me the link.”
- “Appreciate you.”
- “Yeah, down. What day?”

### Manual approval required

- money
- legal
- rent
- relationship tension
- investors
- anything sexual/flirty
- anything involving Liv/family
- anything reputational
- anything that sounds like a promise

### Never let the agent do this

- apologize excessively
- overexplain
- negotiate against your own interest
- sound like customer support in personal DMs
- send multi-paragraph replies unless requested
- promise work, meetings, discounts, favors, or availability without approval

## Suggested database schema

```ts
InboxItem {
  id
  channel
  externalThreadId
  senderName
  senderHandle
  senderRelationship
  lastMessageText
  threadSummary
  detectedIntent
  urgency
  valueScore
  riskLevel
  suggestedAction
  draftReply
  approvalStatus
  sentAt
  followUpAt
  linkedPersonId
  linkedCompanyId
  linkedJovieLeadId
  createdAt
  updatedAt
}
```

## Canned reply bank

### Marketplace

```text
It’s available. Pickup only. Fastest confirmed pickup gets it.
```

```text
Price is firm unless you can pick up sooner.
```

```text
I’m not holding it without payment.
```

### Jovie lead

```text
Appreciate you reaching out. Jovie helps artists turn plain-English intent into release, merch, fan, and promo workflows. Send me your artist link and I’ll take a look.
```

### Investor / founder

```text
Good timing. I’m building Jovie full-time now. Happy to send the deck or do a quick call this week.
```

### Social / music

```text
Appreciate that. Means a lot.
```

```text
Hell yeah, send it over.
```

### Unknown person

```text
What’s this regarding?
```

## The actual workflow

```text
1. Pull new messages
2. Summarize threads
3. Classify sender + intent
4. Score urgency/value/risk
5. Draft reply
6. Queue for approval
7. Send after approval
8. Log relationship/context
9. Schedule follow-up if needed
```

## Build order

### Phase 1: Manual MVP

Use a daily digest. You or an assistant paste screenshots/text into the Inbox Ops agent. It returns triage + drafts.

This proves the categories and reply style.

### Phase 2: Semi-automated

Connect what can be connected through APIs, email notifications, browser automation, or manual exports.

Output goes into the same board.

### Phase 3: Approval system

Telegram/Beeper/Slack-style approval queue:

```text
IG — @artistname
Intent: Jovie lead
Urgency: Today
Draft: “Send me your artist link and I’ll take a look.”

[Send] [Edit] [Ignore] [Follow up]
```

### Phase 4: Agent-assisted sending

Agent opens the relevant inbox, fills the reply, and waits for final confirmation before sending.

## My recommendation

Start with:

1. **IG + Twitter first**
2. **FB Marketplace second**
3. **iMessage last**
4. **One Inbox Ops agent**
5. **Approval-only sending**
6. **Daily digest + urgent escalations**
7. **Log useful people into CRM/GBrain**

This gives you leverage without risking weird AI replies in personal DMs.

---

## User

we we have beeper. and beeper has an mcp. my inclination is to use beeper ncp since its already handling all the adapters. is that right or should we look for hemes adapters or something

---

## Assistant

I’ll treat Beeper as the aggregation layer unless the MCP is missing critical read/write primitives. I’m checking current Beeper MCP capabilities before giving the recommendation.

---

## Assistant

Mr. White, yes: **use Beeper MCP as the adapter layer.**  
Do **not** build separate Hermes adapters for Twitter/X, FB, iMessage, and IG yet.

## Why Beeper MCP is the right default

Beeper already solves the annoying part: aggregating chat networks. Their Desktop API + MCP is explicitly built as a local API/MCP server for chats across Instagram, Messenger, X, iMessage, Google Messages, LinkedIn, Discord, Slack, and others, and it runs on your device. citeturn107723view0turn107723view2

The official docs show the MCP server works with Claude Code, Codex, Cursor, VS Code, and other MCP clients, using a local endpoint at:

```text
http://localhost:23373/v0/mcp
```

It requires Beeper Desktop to be running. citeturn107723view1

So the clean architecture is:

```text
Beeper = message transport layer
Hermes = triage/orchestration brain
GBrain = memory/context/CRM
Chief of Staff = escalation layer
Approval UI = send/edit/ignore/follow-up
```

## Do not make Hermes per-platform adapters yet

That would duplicate Beeper.

Bad path:

```text
Hermes Twitter adapter
Hermes Instagram adapter
Hermes Facebook adapter
Hermes iMessage adapter
```

Better path:

```text
Hermes Inbox Ops Agent
└── Beeper MCP / CLI
    ├── X DMs
    ├── IG DMs
    ├── FB Messenger
    ├── iMessage
    └── everything else later
```

## What Hermes should actually own

Hermes should handle:

- message triage
- thread summarization
- intent classification
- relationship classification
- drafting replies
- creating follow-up reminders
- logging high-value contacts to GBrain / CRM
- escalating risky threads to you
- requiring approval before sends

Beeper should handle:

- reading chats
- searching chats/messages
- sending approved replies
- marking read/unread
- archiving
- opening/focusing chats
- downloading/uploading media where needed

The Beeper docs list API surfaces for chats, messages, search, send, archive, mark read/unread, contacts, assets, and bridge capabilities. citeturn665449view1

## Best setup

### 1. Run Beeper on the always-on MacBook Air

Because Beeper MCP is local and requires Beeper Desktop running, the Air is the obvious message bridge machine. citeturn107723view1

### 2. Connect Hermes to Beeper MCP

If Hermes supports MCP directly, connect it directly.

If Hermes does not support MCP cleanly, build a **thin wrapper**:

```text
Hermes → inbox-ops wrapper → Beeper MCP/CLI → Beeper
```

The wrapper should expose only safe commands:

```text
get_unread_threads
get_recent_threads
summarize_thread
draft_reply
queue_reply_for_approval
send_approved_reply
mark_handled
archive_thread
set_follow_up
```

### 3. Use read-only mode for scans

Beeper CLI docs mention `--read-only`, where mutating commands are rejected and writes stay explicit. That is exactly what you want for scheduled triage. citeturn107723view2

Use two modes:

| Mode | Permission | Use |
|---|---:|---|
| Scan mode | read-only | scheduled triage, digest, summaries |
| Send mode | write-capable | only after explicit approval |

## Approval policy

Default:

```text
Agent can read, summarize, classify, and draft.
Agent cannot send unless approved.
```

Approved send flow:

```text
1. Hermes drafts reply
2. You approve in Telegram/Beeper/terminal/UI
3. Hermes calls Beeper send
4. Thread is marked handled
5. Useful relationship info goes to GBrain
```

## When to build custom adapters

Only build custom adapters if Beeper fails one of these:

- cannot reliably access a channel
- cannot access message requests
- cannot preserve sender/thread IDs
- cannot send replies on that platform
- cannot handle attachments you need
- latency is unacceptable
- channel account keeps disconnecting
- Beeper’s abstraction hides platform-specific data you actually need

Until then, custom adapters are premature.

## Final recommendation

Use this stack:

```text
MacBook Air
├── Beeper Desktop running 24/7
├── Beeper MCP enabled
├── Tailscale for trusted remote access if needed
├── Hermes Inbox Ops Agent
├── GBrain memory/CRM logging
└── Approval queue before any outbound send
```

Build **one Inbox Ops agent** around Beeper MCP.

Do not start with separate Hermes adapters. Start with Beeper as the universal chat bus, then patch only the gaps.


## See Also
- [[chatgpt/chatgpt_7shifts-bid-process]]
- [[chatgpt/chatgpt_ai-app-testing-process-part1]]
- [[chatgpt/chatgpt_ai-app-testing-process-part2]]
- [[chatgpt/chatgpt_ai-app-testing-process-part3]]
- [[chatgpt/chatgpt_ai-app-testing-process-part4]]
