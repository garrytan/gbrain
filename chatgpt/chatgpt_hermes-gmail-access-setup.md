---
title: "Hermes Gmail Access Setup"
type: note
created: 2026-05-30
updated: 2026-05-30
source: chatgpt-export
conversation_id: 6a1a876e-50c8-83e8-a309-72d51aa16abe
message_count: 4
tags: [chatgpt, import, code]
---
# Hermes Gmail Access Setup

> Conversation ID: 6a1a876e-50c8-83e8-a309-72d51aa16abe
> Created: 2026-05-30T06:45:06Z
> Updated: 2026-05-30T06:47:08Z
> Messages: 4

---

## User

hermes agent gmail access app password or passkey?

---

## Assistant

Mr. White, for Hermes Agent, it depends on how it's accessing Gmail:

### If Hermes uses IMAP/SMTP directly
Use an **App Password**, not a passkey.

1. Enable 2-Step Verification on your Google account.
2. Go to Google's App Passwords page:
   urlGoogle App Passwordshttps://myaccount.google.com/apppasswords
3. Generate a 16-character app password.
4. Use:
   - SMTP: `smtp.gmail.com` (port 587 or 465)
   - IMAP: `imap.gmail.com` (port 993)
   - Username: your Gmail address
   - Password: the generated app password

### If Hermes uses the Gmail API
Use **OAuth**, not an app password.

Typical setup:
- Create a project in urlGoogle Cloud Consolehttps://console.cloud.google.com
- Enable Gmail API
- Create OAuth credentials
- Authenticate Hermes through Google's consent screen
- Hermes stores refresh/access tokens

### Passkeys
Passkeys are only for you signing into Google interactively. They do not work as credentials for IMAP, SMTP, or API access.

### Recommendation
For a personal Hermes deployment, use OAuth if available. If Hermes only supports IMAP/SMTP, use an App Password. Avoid using your primary Google account password entirely.

---

## User

it uses  himalaya

---

## Assistant

If Hermes is using **Himalaya** (the email CLI/library), then use a **Gmail App Password**.

Himalaya typically connects through IMAP and SMTP, so the setup is:

- Gmail account
- 2-Step Verification enabled
- Generate an App Password
- Use the App Password in your Himalaya/Hermes config

Example:

```toml
[email]
backend = "imap"

[imap]
host = "imap.gmail.com"
port = 993
login = "you@gmail.com"
passwd = "your-16-character-app-password"

[smtp]
host = "smtp.gmail.com"
port = 587
login = "you@gmail.com"
passwd = "your-16-character-app-password"
```

A passkey will not work for Himalaya.

One caveat: newer versions of Himalaya also support OAuth for some providers. If your Hermes install specifically mentions Gmail OAuth, that's preferable. If the docs/config are asking for `login` and `password`, use an App Password.


## See Also
- [[chatgpt/chatgpt_gmail-app-password-setup]]
- [[chatgpt/chatgpt_gmail-setup-with-himalaya]]
- [[chatgpt/chatgpt_hermes-orchestrator-model-setup]]
- [[chatgpt/chatgpt_hermes-voice-interaction-setup]]
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
