---
conversation_id: 69684d89-4100-832b-ad52-aadad9aef9b5
created: 2026-01-15
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Clerk Vercel Preview Setup
type: note
updated: 2026-01-15
---

# Clerk Vercel Preview Setup

**Related:** [[coding_devops]]

> Conversation ID: 69684d89-4100-832b-ad52-aadad9aef9b5
> Created: 2026-01-15T02:14:33Z
> Updated: 2026-01-15T02:15:13Z
> Messages: 2

---

## User

cleark on vercel preview domains

---

## Assistant

Mr. White,

Here’s the **correct way to use entity["company","Clerk","authentication platform"] with entity["company","Vercel","cloud hosting platform"] preview domains**.

---

## 1) Add Vercel Preview Domains to Clerk
Clerk **must explicitly allow** every domain that will serve auth.

**Clerk Dashboard → Settings → Domains**
- Add:
  - `*.vercel.app`
  - (Optional, safer) `*.your-project.vercel.app`

This is required because **each PR gets a new subdomain**.

---

## 2) Set Environment Variables Correctly (Critical)
In **Vercel → Project → Settings → Environment Variables**:

### Required (Preview + Production)
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
```

### Strongly Recommended
```
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/
```

Do **not** hardcode full URLs for preview environments.

---

## 3) Use Dynamic Origin (Avoid Redirect Bugs)
If you’re using Next.js middleware or custom redirects:

**Do NOT** hardcode your production domain.

✔ Correct pattern:
```ts
const origin = req.nextUrl.origin
```

❌ Wrong:
```ts
https://myapp.com
```

Hardcoding breaks previews.

---

## 4) Cookies: Use the Default (Don’t Override)
Do **not** manually set:
- cookie domain
- SameSite
- secure flags

Clerk already handles **preview + prod** correctly. Overriding causes random logouts on previews.

---

## 5) Common Failure Modes (Facts)
- ❌ Forgot `*.vercel.app` → infinite redirect loop
- ❌ Prod-only env vars → auth works locally, fails on preview
- ❌ Hardcoded URLs → OAuth callback mismatch
- ❌ Custom cookie domain → session loss on previews

---

## Bottom Line
Clerk works perfectly on Vercel previews **if and only if**:
- Wildcard domain is allowed
- Env vars exist for Preview
- No hardcoded origins or cookie overrides

If you want, I can audit your **middleware.ts**, **auth config**, or **OAuth redirect setup** in under a minute.


**Topic:** [[chatgpt-clusters/coding_devops]]
