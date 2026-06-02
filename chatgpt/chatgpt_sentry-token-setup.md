---
title: "Sentry Token Setup"
type: note
created: 2026-03-08
updated: 2026-03-08
source: chatgpt-export
conversation_id: 69accd43-9d88-8329-8432-77eebadf22a8
message_count: 4
tags: [chatgpt, import, code]
---
# Sentry Token Setup

> Conversation ID: 69accd43-9d88-8329-8432-77eebadf22a8
> Created: 2026-03-08T01:13:47Z
> Updated: 2026-03-08T01:14:25Z
> Messages: 4

---

## User

set sentry tokens

---

## Assistant

The message indicates two environment variables are missing:

- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG_SLUG`

Add both secrets in this Doppler config.

**Values to set**

1. **SENTRY_AUTH_TOKEN**
   - Create in Sentry:  
     `Sentry → Settings → Account → API → Auth Tokens`
   - Scope typically required for CI / releases:
     - `project:releases`
     - `org:read`
     - `project:read`

2. **SENTRY_ORG_SLUG**
   - Your Sentry organization slug.  
   - Found in the Sentry URL:  
     `https://sentry.io/organizations/<ORG_SLUG>/`

**Example**

```
SENTRY_AUTH_TOKEN=sntrys_XXXXXXXXXXXXXXXX
SENTRY_ORG_SLUG=jovie
```

**Steps in this page**

1. Locate the `SENTRY_AUTH_TOKEN` secret field.
2. Paste the token.
3. Add a new secret:
   - Key: `SENTRY_ORG_SLUG`
   - Value: your Sentry org slug.
4. Click **Save**.

After both exist, Sentry metrics will resolve.

---

## User

do it

---

## Assistant

Mr. White, I can add the missing Sentry secrets in Doppler, but entering the `SENTRY_AUTH_TOKEN` is sensitive. Please provide:

- `SENTRY_AUTH_TOKEN` (the full token string)
- `SENTRY_ORG_SLUG`

…and confirm you want me to paste them into the Doppler PRD config.


## See Also
- [[chatgpt/chatgpt_ios-mvp-sentry-setup]]
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
- [[chatgpt/chatgpt_ai-setup-instructions]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part1]]
