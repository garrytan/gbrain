---
title: "Clerk Auth Vercel Preview"
type: guide
created: 2025-12-26
updated: 2025-12-26
source: chatgpt-export
conversation_id: 694ef8c4-a0d8-832d-902f-b602fe57ab87
message_count: 4
tags: [chatgpt, import, code]
---
# Clerk Auth Vercel Preview

> Conversation ID: 694ef8c4-a0d8-832d-902f-b602fe57ab87
> Created: 2025-12-26T21:06:13Z
> Updated: 2025-12-26T21:07:06Z
> Messages: 4

---

## User

clerk auth on vercel preview domains

---

## Assistant

Mr. White,

**Clerk authentication on Vercel preview domains** requires explicitly allowing dynamic preview URLs. The issue is almost always misconfigured allowed domains or redirect URLs.

---

## The core problem
entity["company","Vercel","cloud hosting platform"] preview deployments generate **unique subdomains** per PR  
(e.g. `my-app-git-feature-x.vercel.app`).  
entity["company","Clerk","authentication platform"] blocks auth unless those domains are whitelisted.

---

## Correct Clerk configuration (required)

### 1. Allow preview domains
In **Clerk Dashboard → Domains**:
```
*.vercel.app
```
If you use a custom preview domain:
```
*.preview.myapp.com
```

---

### 2. Set redirect URLs (critical)
In **Clerk Dashboard → Redirects**:

Add:
```
https://*.vercel.app/*
```

Also ensure your **Production** domain is still listed separately.

---

## Vercel environment variables

In **Vercel → Project → Settings → Environment Variables**  
Make sure these exist for **Preview**:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/
```

⚠️ **Do not** use production keys in Preview.

---

## Common failure modes (facts, not opinions)

- ❌ Missing wildcard domain → infinite redirect loop  
- ❌ Using production Clerk instance on preview  
- ❌ Hardcoded callback URL (e.g. `localhost`)  
- ❌ Middleware blocking `/sign-in` or `/sign-up`

---

## Recommended best practice
Create **two Clerk instances**:
- **Production** → `myapp.com`
- **Development** → `*.vercel.app`, `localhost`

This isolates preview auth completely and avoids subtle session bugs.

---

If you want, tell me:
- App router or pages router
- Middleware setup (`middleware.ts`?)
- OAuth providers in use  

I’ll pinpoint the exact failure path.

---

## User

so this requires paying for sattleite domains?

---

## Assistant

Mr. White,

**No. Clerk preview auth does *not* require paying for Satellite Domains.**

Here are the facts, cleanly separated.

---

## What Satellite Domains actually are
Clerk **Satellite Domains** are only needed when:

- You authenticate on **multiple first-party domains**
- You need **shared sessions across domains**
  - e.g. `app.myapp.com` ↔ `dashboard.myapp.com`

That is **not** what Vercel preview URLs are.

---

## Vercel preview domains (the key distinction)

`*.vercel.app` are **third-party preview hosts**, not first-party satellites.

Clerk allows:
```
*.vercel.app
```
**for free** on Development instances.

No Satellite pricing applies.

---

## When you WOULD need Satellite Domains (paid)

You only need to pay if **all** are true:

- You use **custom preview domains**
  - e.g. `pr-123.preview.myapp.com`
- You want **shared auth sessions**
- Those domains are **not** subpaths of the same origin

That’s a deliberate multi-domain auth architecture.

---

## Correct setup (zero cost)

**Clerk Dev Instance**
- Allowed domains:
  ```
  localhost
  *.vercel.app
  ```
- Redirects:
  ```
  https://*.vercel.app/*
  ```

**Clerk Prod Instance**
- Allowed domains:
  ```
  myapp.com
  www.myapp.com
  ```

No Satellite Domains.
No extra billing.
No hacks.

---

## Why people think this costs money
Most confusion comes from:
- Using **one Clerk instance** for prod + preview
- Seeing “Satellite required” errors
- Misreading the dashboard warning

That warning only applies when **session sharing** is detected.

---

### Bottom line
**Vercel preview auth with Clerk is free and supported.**  
Satellite Domains are unrelated unless you deliberately architect cross-domain SSO.

If you want, I can:
- Validate your exact domain config
- Tell you whether Clerk thinks you’re in a satellite scenario
- Review your middleware for false positives

Just say the word.
