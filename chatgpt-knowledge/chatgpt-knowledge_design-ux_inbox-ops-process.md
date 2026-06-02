---
title: "Inbox Ops Process"
type: guide
created: 2026-05-27
updated: 2026-05-27
source: chatgpt-export
topic: design-ux
message_count: 6
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Inbox Ops Process

> **Source:** ChatGPT conversation
> **Date:** 2026-05-27T17:42:46Z
> **Messages:** 6
> **Topic:** design-ux

## Question

OKay. i need to deal with 
some operations stuff.

• Twitter DMs need to get triaged and handled
• FB Messages
• IMessage
• IG DMs


we need to build a process for this

## Answer

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

Acti

*(Answer truncated — 7351 chars total)*

## Answer

Mr. White, I’ll frame this as an operating system first, then map tools/agents onto it. The key is separating capture, classification, drafting, approval, and sending.

## Question

we we have beeper. and beeper has an mcp. my inclination is to use beeper ncp since its already handling all the adapters. is that right or should we look for hemes adapters or something

## Answer

I’ll treat Beeper as the aggregation layer unless the MCP is missing critical read/write primitives. I’m checking current Beeper MCP capabilities before giving the recommendation.

## Answer

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
| Send mode | write-ca

*(Answer truncated — 4256 chars total)*
