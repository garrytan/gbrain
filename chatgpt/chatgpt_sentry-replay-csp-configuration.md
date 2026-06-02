---
title: "Sentry Replay CSP Configuration"
type: note
created: 2026-01-23
updated: 2026-01-23
source: chatgpt-export
conversation_id: 6973156f-6840-8325-a201-7425198fc117
message_count: 2
tags: [chatgpt, import, code]
---
# Sentry Replay CSP Configuration

> Conversation ID: 6973156f-6840-8325-a201-7425198fc117
> Created: 2026-01-23T06:30:08Z
> Updated: 2026-01-23T06:31:03Z
> Messages: 2

---

## User

sentry replay csp

---

## Assistant

**Sentry Replay CSP** refers to how **Sentry’s Session Replay feature interacts with your site’s Content Security Policy (CSP)** — specifically what you must configure so that Session Replay can run and report data without being blocked by the browser’s security policy.

### What’s going on
- **Session Replay** is a Sentry feature that records DOM changes & user interactions so you can *reconstruct* user sessions to debug issues. It isn’t video but playback of DOM events. citeturn0search0turn0search14
- **CSP (Content Security Policy)** is a browser-enforced security header that restricts where scripts, workers, iframes, etc. can be loaded from to prevent XSS & code injection attacks. citeturn0search31

### Why CSP matters for Sentry Replay
If your site has a restrictive CSP, the browser may **block Sentry’s Replay SDK scripts or worker code** from executing or uploading recordings — you’ll see CSP violation errors in console. That stops session replay from working. citeturn0search1

Typical CSP problems with Replay include:
- Inline scripts / hashes are blocked
- Workers spawned from blob URLs are blocked
- Script or worker loading from Sentry domains is not permitted

### How to fix/configure CSP for Sentry Replay
To allow Sentry Replay under CSP you need to **permit the necessary sources in your CSP directives**:

1. **Allow Sentry domains**  
   Add Sentry script/worker hosts (e.g., `https://browser.sentry-cdn.io`, `https://browser.sentry-cdn.com`, `https://js.sentry-cdn.com`, `https://*.sentry.io`) to relevant CSP directives (`script-src`, `connect-src`, `worker-src`, etc.).  
   This ensures browser will load Sentry’s SDK and send data. citeturn0search5

2. **Handle blobs & workers**  
   If the session replay SDK uses blob workers (e.g., for compression), you must include `blob:` in relevant CSP sources such as `worker-src` or `script-src`.  
   Without it, blob workers will be blocked by CSP. citeturn0search5

3. **Nonce or hash for inline content**  
   If your CSP forbids inline scripts/styles, you may need CSP nonces or hashes for any inline Replay initialization content.

4. **Check CSP reporting/troubleshooting**  
   If you’re not seeing replay data at all, CSP restrictions are a common cause and need relaxing for the required endpoints/domains. citeturn0search1

### Example CSP patterns you might need (simplified)
(Not copy-paste for production, adjust to your own policy)

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://browser.sentry-cdn.io https://browser.sentry-cdn.com https://js.sentry-cdn.com blob:;
  connect-src 'self' https://*.sentry.io;
  worker-src 'self' blob: https://browser.sentry-cdn.io;
  img-src 'self' data: https://*.sentry.io;
```

This allows:
- Sentry Replay scripts and assets
- Blob workers
- Connections back to Sentry for sending replay data

> The exact hosts you need depend on your Sentry setup and SDK version; consult Sentry docs & logs. citeturn0search5

### Common errors
- **“Refused to apply inline style/script…”** — CSP blocks inline code or missing hash/nonce.  
- **Worker blob errors** — missing `blob:` in `worker-src`.  
- **No replay events** — CSP blocked SDK from loading or reporting.

If you share your CSP policy or framework (Next.js, Express, etc.), I can tailor a concrete CSP config for Sentry Replay.


## See Also
- [[chatgpt/chatgpt_check-email-configuration]]
- [[chatgpt/chatgpt_configuration-check-summary]]
- [[chatgpt/chatgpt_gstack-configuration-request]]
- [[chatgpt/chatgpt_laravel-mix-configuration]]
- [[chatgpt/chatgpt_nuxt-configuration-module-settings]]
