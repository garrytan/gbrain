---
title: "Email Setup Options"
type: guide
created: 2026-03-05
updated: 2026-03-05
source: chatgpt-export
conversation_id: 69aa0be5-60dc-832d-8c61-a8b0fa37ca5e
message_count: 2
tags: [chatgpt, import, code]
---
# Email Setup Options

> Conversation ID: 69aa0be5-60dc-832d-8c61-a8b0fa37ca5e
> Created: 2026-03-05T23:05:11Z
> Updated: 2026-03-05T23:05:33Z
> Messages: 2

---

## User

Question, I'm using instantly at dot AI and I guess it lets you set up multiple domains and email accounts through them, and then I can like, it's letting me buy like a Google account for five bucks a month for each email. So like right now, if I checked out, I'd have five email accounts all in different Google accounts under the one domain and a domain through them. And then it's 40 bucks, 15 for the domain annually, and then 25 a month for the Google accounts. And then I guess they automatically set them up for me. Is that worth doing and then, or am I better off to just make my own account and then make it a catch-all, and then I theoretically could just make as many emails as I want, right?

---

## Assistant

Mr. White,

### Short Answer
Create **one Google Workspace account and enable a catch-all** on your domain. This is usually the most cost-efficient setup. Purchasing multiple $5 inboxes through Instantly is typically unnecessary unless each inbox must log in separately.

---

## Option 1 — Multiple Google accounts ($5 each)
What Instantly is selling is essentially **separate Google Workspace mailboxes**.

Example with 5 accounts:

| Inbox | Monthly Cost |
|---|---|
| inbox1@domain.com | $5 |
| inbox2@domain.com | $5 |
| inbox3@domain.com | $5 |
| inbox4@domain.com | $5 |
| inbox5@domain.com | $5 |
| **Total** | **$25/month** |

Advantages:
- Each inbox has its own **Google login**
- Better **email deliverability separation**
- Required for many **cold outreach tools** (including Instantly)
- Each account has its own sending limits

Disadvantages:
- Cost scales linearly
- More accounts to manage

---

## Option 2 — One Google Workspace + Catch-All
Setup:

- 1 Google Workspace inbox: `main@domain.com`
- Enable **catch-all** on the domain
- Any address works:

Examples:
```
sales@domain.com
hello@domain.com
tim@domain.com
outreach1@domain.com
anything@domain.com
```

All mail lands in **one inbox**.

Cost:

| Item | Cost |
|---|---|
| Google Workspace (1 user) | ~$6/month |
| Domain | ~$12–15/year |

Advantages:
- Extremely cheap
- Unlimited addresses
- Very simple to manage

Disadvantages:
- **Only one real mailbox**
- Cold outreach tools usually **cannot send from catch-all addresses**
- Google sending limits apply to the single account

---

## Critical Detail for Cold Email (Instantly)
If you are using **entity["software","Instantly.ai","cold email outreach platform"]**, catch-all addresses typically **do not work as separate sending inboxes**.

Cold outreach tools expect:

- Separate **SMTP/IMAP authenticated accounts**
- Each inbox warmed separately
- Sending limits per mailbox

Example typical scaling model:

| Domains | Inboxes per Domain | Total Inboxes |
|---|---|---|
| 3 | 5 | 15 |
| 5 | 5 | 25 |

Reason: **deliverability risk spreads across domains and mailboxes**.

---

## What Most Cold Email Operators Do
Typical structure:

```
domain1.com
  inbox1@
  inbox2@
  inbox3@
  inbox4@
  inbox5@

domain2.com
  inbox1@
  inbox2@
  inbox3@
  inbox4@
  inbox5@
```

Each inbox is a **real Google account**.

This is why Instantly sells them pre-configured.

---

## My Recommendation
For **cold outreach**:

- Buy **separate inboxes**
- Use **multiple domains**
- 3–5 inboxes per domain

For **normal business email**:

- One **Google Workspace inbox**
- Enable **catch-all**

---

## Cost-Efficient Hybrid Setup

**Primary domain**
```
jovie.com
tim@
hello@
support@
```

**Outreach domains**
```
jovieapp.co
tryjovie.com
getjovie.co
```

Each outreach domain:
- 3–5 inboxes

This protects the primary domain’s reputation.

---

## Important Warning
Never run cold email from your **main company domain**. Domain reputation damage affects deliverability permanently.

---

If useful, I can also explain:

- The **cheapest way founders scale to 50–200 inboxes**
- Why **Google accounts outperform Outlook for cold email**
- The **exact inbox/domain ratio Instantly users follow for best deliverability**.
