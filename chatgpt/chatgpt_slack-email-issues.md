---
title: "Slack email issues"
type: note
created: 2025-12-16
updated: 2025-12-16
source: chatgpt-export
conversation_id: 6941bdc3-e434-8332-85fc-b1e7b57b0ec7
message_count: 2
tags: [chatgpt, import]
---
# Slack email issues

> Conversation ID: 6941bdc3-e434-8332-85fc-b1e7b57b0ec7
> Created: 2025-12-16T20:15:01Z
> Updated: 2025-12-16T20:16:36Z
> Messages: 2

---

## User

im not getting emails from slack at all.  i get them from stripe and other rpodivders but not slack. not in spam folder no other service impacted. i cant login to slack without getting an email code.

---

## Assistant

Mr. White, given your symptoms this is almost certainly **Slack-specific email delivery**, not your email provider.

Work through this in order:

### 1. Check the exact Slack login email
Slack sends login codes from **`no-reply@slack.com`** or **`feedback@slack.com`**.
- Search **All Mail**, not just Inbox or Spam.
- If you use Gmail/Outlook, also search **Trash**, **Promotions**, **Updates**, **Quarantine**.

### 2. Email provider is silently blocking Slack
This is common with corporate domains and aggressive filters.
Actions:
- Whitelist **`@slack.com`** at the domain level (not just inbox rules).
- Ask your email admin to check **mail logs** for rejected Slack messages.
- Look specifically for blocks due to **DMARC / reputation filtering**.

### 3. You’re logging into the wrong workspace email
Slack login codes are sent to the **email tied to that workspace**, not necessarily your main address.
- If you’ve ever been invited under a different email, the code goes there.
- Try logging in at:  
  https://slack.com/signin → **“Sign in with email”** → try alternate addresses.

### 4. Slack account is stuck in email verification loop
This happens occasionally.
Fix:
- Go to **https://slack.com/help/requests/new**
- Choose **“Trouble logging in”**
- Select **“Not receiving confirmation or sign-in emails”**
- Provide the workspace name and email  
Slack can manually re-enable access.

### 5. Temporary workaround (fastest)
If **any** teammate is an admin:
- Have them invite you **again** to the workspace (same email).
- The invite email often gets through even when login codes don’t.

---

### What this is *not*
- Not your spam folder (already checked)
- Not your email provider globally (Stripe works)
- Not a Slack outage (others would be affected)

If you want, tell me:
- Your email provider (Google Workspace, Outlook 365, custom SMTP)
- Whether this is a personal or company domain  

I’ll give you the **exact admin-level fix**.
