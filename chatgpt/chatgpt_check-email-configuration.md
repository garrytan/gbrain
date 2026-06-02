---
title: "Check email configuration"
type: note
created: 2025-12-13
updated: 2025-12-13
source: chatgpt-export
conversation_id: 693df154-11f0-8332-9e04-457bc0b0dc77
message_count: 4
tags: [chatgpt, import]
---
# Check email configuration

> Conversation ID: 693df154-11f0-8332-9e04-457bc0b0dc77
> Created: 2025-12-13T23:05:56Z
> Updated: 2025-12-13T23:06:58Z
> Messages: 4

---

## User

check my email configureation

---

## Assistant

Mr. White — I can help, but I need **details** of your email setup.

Please provide the following:

1. **Email provider** (e.g., Gmail, Outlook, Yahoo, custom domain)
2. **Device/app** you’re configuring (e.g., iPhone Mail, Outlook desktop, Thunderbird)
3. The **incoming & outgoing server settings** you’ve entered:
   - Server names
   - Ports
   - Encryption type (SSL/TLS/STARTTLS)
   - Username
4. Any **error messages** you’re seeing

Send that info and I’ll verify your configuration.

---

## User

im not getting emails from stripe or slack

---

## Assistant

Mr. White — this is almost always **deliverability or filtering**, not Stripe or Slack failing to send.

Work through this in order:

### 1. Check Spam + All Mail (Critical)
- Search **exactly**:
  - `from:@stripe.com`
  - `from:@slack.com`
- Also check **Promotions**, **Updates**, **Junk**, and **Archived** folders.

### 2. Verify You’re Checking the Right Email
- Confirm Stripe & Slack are sending to the **correct address**
  - Stripe → *Settings → Email receipts & notifications*
  - Slack → *Preferences → Notifications → Email*
- Common issue: account tied to an **old or alias email**

### 3. Email Provider Filtering (Very Common)
If using **Google Workspace / Gmail**:
- Admin Console → **Email Log Search**
- Look for rejected or quarantined messages from:
  - `stripe.com`
  - `slack.com`
- Ensure **DMARC enforcement** isn’t set to `reject` without alignment.

If using **Outlook / Microsoft 365**:
- Check **Quarantine**
- Review **Anti-Spam Policies**
- Look for blocked domains or false positives

### 4. Rules & Filters
Check for rules that:
- Auto-archive
- Auto-delete
- Forward elsewhere

Specifically search for:
- “payment”
- “invoice”
- “notification”
- “slack”

### 5. Domain Email (Custom Domain Only)
If you use a custom domain:
- SPF must include your email host
- DMARC should be `p=none` or `quarantine` (not `reject`) unless perfectly configured
- Misconfigured DMARC will silently drop Stripe/Slack

### 6. Slack-Specific Gotcha
Slack **does not email** if:
- You’re active on desktop/mobile
- Notifications are set to **push only**
- Email notifications are disabled per-workspace

### 7. Stripe-Specific Gotcha
Stripe emails **only go to account owners/admins** for some events.
Verify your role.

---

If you tell me:
- **Email provider** (Gmail, Outlook, custom domain)
- **Custom domain or not**
- **Exact email address used in Stripe/Slack**

I’ll pinpoint the failure immediately.
