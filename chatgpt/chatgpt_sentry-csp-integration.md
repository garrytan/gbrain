---
title: "Sentry CSP Integration"
type: note
created: 2026-01-23
updated: 2026-01-23
source: chatgpt-export
conversation_id: 697314f6-7940-8325-887c-952a8d2ee427
message_count: 2
tags: [chatgpt, import, code]
---
# Sentry CSP Integration

> Conversation ID: 697314f6-7940-8325-887c-952a8d2ee427
> Created: 2026-01-23T06:28:07Z
> Updated: 2026-01-23T06:28:40Z
> Messages: 2

---

## User

sentry csp

---

## Assistant

Here’s a concise summary of **Sentry and Content Security Policy (CSP)**:

---

## 🔐 What CSP Is (General)
A **Content Security Policy (CSP)** is a browser security standard that specifies what content (scripts, images, styles, etc.) a webpage is allowed to load/execeute to prevent XSS and related attacks. It’s set via the `Content-Security-Policy` HTTP header. citeturn0search42

---

## 📌 How Sentry Uses CSP

### 1. **CSP Violation Reporting**
Sentry can **capture CSP violation reports** sent by browsers:
- You configure your CSP header to include a **report endpoint** pointing to Sentry.
- When a browser detects a CSP violation, it sends a report to that endpoint.
- Sentry stores and aggregates these reports so you can monitor security issues in your app. citeturn0search2

Example of CSP header pointing at Sentry:
```
Content-Security-Policy: default-src 'self'; report-uri https://sentry.io/api/<project>/security/?sentry_key=<key>
```
Browsers will post violation details to that URL. citeturn0search2

> Note: Modern CSP uses `report-to`, but Sentry currently only supports **report-uri** format for receiving reports. citeturn0search10

---

### 2. **Required CSP Settings for Sentry SDK**
If you load Sentry’s JavaScript SDK on a site with CSP:
- You must allow Sentry’s script and connection domains in your policy (`script-src`, `connect-src`, etc.). citeturn0search13
- Typically includes hostnames for Sentry’s CDN and ingest endpoints (e.g., `browser.sentry-cdn.com`, `o*.ingest.sentry.io`). citeturn0search1

That means your CSP policy must explicitly allow those origins or the browser will block Sentry’s scripts or reporting.

---

## 🛠 Sentry CSP Features in the Dashboard

- **Security Headers settings in a Sentry project** let you manage CSP reporting configuration (like project keys and ignore lists). citeturn0search3
- You can **filter out noisy CSP reports** by specifying additional ignored sources. citeturn0search8
- In Sentry’s UI you can query CSP reports using filters like:
```
logger:csp
event.type:csp
``` 
to focus on CSP-specific events. citeturn0search15

---

## 🧪 Testing & Report Visibility

- Reports don’t show up by default in your main issue list unless they’re sent and captured.
- In the Sentry dashboard, use filtering to surface CSP violation events. citeturn0search15

---

## ⚠️ Notes & Best Practices

- CSP reporting with Sentry **doesn’t block content**—it only *reports* violations. To enforce policy while testing, use **`Content-Security-Policy-Report-Only`** first. citeturn0search2
- Since `report-uri` is deprecated in web standards in favor of `report-to`, newer middleware may convert formats for you. citeturn0search10

---

If you want, I can show an example CSP header tailored to your environment that includes Sentry and typical modern asset sources.
