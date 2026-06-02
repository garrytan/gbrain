---
title: "Gmail App Password Setup"
type: note
created: 2026-05-30
updated: 2026-05-30
source: chatgpt-export
conversation_id: 6a1a875e-545c-83e8-86da-a6b6ab550e5e
message_count: 2
tags: [chatgpt, import]
---
# Gmail App Password Setup

> Conversation ID: 6a1a875e-545c-83e8-86da-a6b6ab550e5e
> Created: 2026-05-30T06:44:47Z
> Updated: 2026-05-30T06:44:53Z
> Messages: 2

---

## User

app password gmail

---

## Assistant

To create a Gmail app password:

1. Turn on 2-Step Verification in your Google account. App passwords are unavailable without it. citeturn0search0turn0search5
2. Go to the Google App Passwords page:  
   urlGoogle App Passwordshttps://myaccount.google.com/apppasswords
3. Sign in.
4. Enter a custom name (for example: "Jovie SMTP" or "Nodemailer").
5. Click **Generate**.
6. Google will give you a 16-character password. Copy it immediately. You won't be able to view it again later. citeturn0search5turn0search7

For SMTP:

- Username: your full Gmail address
- Password: the 16-character app password
- SMTP Host: `smtp.gmail.com`
- Port: `587` (TLS) or `465` (SSL)

If the **App Passwords** option does not appear:
- Verify 2-Step Verification is enabled.
- Advanced Protection disables app passwords.
- Some Google Workspace admins block them. citeturn0search5turn0search4

Direct link:

urlApp Passwords Pageturn0search1
