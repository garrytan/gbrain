---
title: "CSP Management with Clerk"
type: guide
created: 2026-02-18
updated: 2026-02-18
source: chatgpt-export
topic: personal-development
message_count: 8
tags: [chatgpt, knowledge, personal-development]
---
# CSP Management with Clerk

> **Source:** ChatGPT conversation
> **Date:** 2026-02-18T17:24:59Z
> **Messages:** 8
> **Topic:** personal-development

## Question

is there a way to manage csp autoamtically that we should be using with clerk and next.js? or should we just manaually add stuff

## Answer

Mr. White,

Short answer: **don’t manage CSP fully manually** with Clerk + Next.js. Use a hybrid approach:

- ✅ **Start with a generated baseline**
- ✅ **Use nonces (not unsafe-inline)**
- ✅ **Let Clerk’s documented domains drive your allowlist**
- ❌ Avoid hard-coding brittle CSP strings long term

---

## The Right Way (Production-Grade Setup)

### 1️⃣ Use nonce-based CSP with Next.js Middleware

In **Next.js (App Router or Pages Router)**, generate a per-request nonce in `middleware.ts` and attach it to:

- CSP header
- `<Script nonce={nonce}>`
- `<NextScript nonce={nonce}>`

This avoids `unsafe-inline`.

Example pattern:

```ts
// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const nonce = crypto.randomUUID();

  const res = NextResponse.next({
    request: {
      headers: new Headers(req.headers),
    },
  });

  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' https://clerk.com https://*.clerk.accounts.dev;
    connect-src 'self' https://clerk.com https://*.clerk.accounts.dev;
    img-src 'self' data: blob: https:;
    style-src 'self' 'unsafe-inline';
    frame-src https://clerk.com https://*.clerk.accounts.dev;
  `.replace(/\n/g, '');

  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("x-nonce", nonce);

  return res;
}
```

Then pass the nonce into `_document.tsx` or your root layout.

---

## 2️⃣ What Clerk Requires

Clerk needs these categories allowed:

- `script-src` → Clerk domains
- `connect-src` → Clerk API endpoints
- `frame-src` → Clerk hosted components
- `img-src` → Clerk + blob/data
- WebAuthn may require `webauthn:` depending on setup

Clerk domains differ by environment:
- Production: `clerk.com`
- Dev: `*.clerk.accounts.dev`

Check your actual dashboard domain and allow only what you use.

---

## 3️⃣ Should You Use an Automatic CSP Library?

There are three common options:

### ✅ Option A — `next-safe-middleware` (Recommended if you want abstraction)
- Handles nonce
- Clean API
- Less brittle than manual strings

Good if:
- You want structured CSP
- You expect policy to grow
- You want less string management

---

### ⚠️ Option B — Vercel Edge Config
Only useful if dynamically toggling CSP policies. Overkill for most apps.

---

### ❌ Option C — Static header in `next.config.js`
Too rigid.
You’ll end up adding `unsafe-inline` out of frustration.
Not recommended for Clerk.

---

## 4️⃣ What I Recommend for a Startup

Since you're building in Next.js:

> Use middleware + nonce + structured CSP config.

Manual string is fine **if**:
- You use nonce
- You avoid unsafe-inline
- You keep policy minimal
- You monitor violations

Add this header for debugging:

```
Content-Security-Policy-Report-Only
```

Use it first in Report-Only mode before enforcing.

---

## 5️⃣ Production Reality

Most startups:

- Start strict
- Hit Clerk breakage
- Add `unsafe-inline`
- Never fix it


*(Answer truncated — 3494 chars total)*

## Question

im on vercel. app router. custom clerk ui. and we have statsig, and neon, and stipe, 

## Answer

Mr. White — with **Vercel + App Router + custom Clerk UI + Statsig + Neon + Stripe**, you should use:

> **Middleware-based CSP with per-request nonce**
> Not a static header.
> Not fully manual string chaos.
> Not unsafe-inline.

Below is a hardened production template.

---

# 🔐 Architecture Overview

You need to allow:

| Service | Needs |
|----------|--------|
| Clerk | script, connect, frame |
| Stripe | script, frame, connect |
| Statsig | script, connect |
| Neon | connect (WebSocket + HTTPS) |
| Vercel | blob, data, edge runtime |

---

# 1️⃣ `middleware.ts` (App Router, Vercel-ready)

```ts
// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const res = NextResponse.next({
    request: {
      headers: new Headers(req.headers),
    },
  });

  const clerkDomains = [
    "https://clerk.com",
    "https://*.clerk.accounts.dev",
  ];

  const stripeDomains = [
    "https://js.stripe.com",
    "https://api.stripe.com",
    "https://hooks.stripe.com",
  ];

  const statsigDomains = [
    "https://featureassets.org",
    "https://prodregistryv2.org",
    "https://api.statsig.com",
  ];

  const neonDomains = [
    "https://*.neon.tech",
    "wss://*.neon.tech",
  ];

  const csp = `
    default-src 'self';

    script-src 
      'self'
      'nonce-${nonce}'
      ${clerkDomains.join(" ")}
      ${stripeDomains.join(" ")}
      ${statsigDomains.join(" ")};

    connect-src 
      'self'
      ${clerkDomains.join(" ")}
      ${stripeDomains.join(" ")}
      ${statsigDomains.join(" ")}
      ${neonDomains.join(" ")};

    frame-src
      ${clerkDomains.join(" ")}
      https://js.stripe.com
      https://hooks.stripe.com;

    img-src
      'self'
      data:
      blob:
      https:;

    style-src
      'self'
      'unsafe-inline';

    font-src
      'self'
      data:

    object-src 'none';
    base-uri 'self';
    frame-ancestors 'none';
    form-action 'self';
  `
    .replace(/\n/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("x-nonce", nonce);

  return res;
}
```

---

# 2️⃣ Pass Nonce to App Router Layout

In `app/layout.tsx`:

```tsx
import { headers } from "next/headers";
import Script from "next/script";

export default function RootLayout({ children }) {
  const nonce = headers().get("x-nonce") || undefined;

  return (
    <html>
      <body>
        {children}
      </body>
    </html>
  );
}
```

If you manually inject any `<Script>`, pass:

```tsx
<Script nonce={nonce} />
```

---

# 3️⃣ Important Service Notes

## 🧾 Clerk (Custom UI)

Since you're using custom UI:

- You do NOT need Clerk hosted iframe origins
- Keep connect-src + script-src only
- You can remove frame-src Clerk if not embedding

---

## 💳 Stripe

Stripe requires:
- `https://js.stripe.com`
- frame-src to Stripe
- connect-src to

*(Answer truncated — 4305 chars total)*

## Question

stripe checkout. neon drizzle http driver. we use edge functions yes. give me a prompt to audit this with claude code

## Answer

Mr. White — since you're using:

- **Stripe Checkout (redirect-based)**
- **Neon Drizzle HTTP driver (server-side only)**
- **Vercel Edge Functions**
- **Custom Clerk UI**
- **Statsig**

Your CSP surface area is smaller than most people think. Neon does **not** need to be in CSP. Stripe Checkout changes `frame-src` needs.

Below is a clean, high-signal prompt you can paste into Claude Code to audit your setup.

---

:::writing{id="84729" variant="standard"}
You are a senior web security engineer.

Audit my Next.js 14 (App Router) production application for Content Security Policy correctness and security hardening.

Stack details:

- Hosted on Vercel
- App Router
- Middleware-based CSP with per-request nonce
- Custom Clerk UI (no hosted Clerk components)
- Stripe Checkout (redirect flow, not Elements)
- Statsig client SDK
- Neon database via Drizzle HTTP driver (server-side only)
- Using Vercel Edge Functions

Tasks:

1. Review my middleware CSP implementation.
2. Identify:
   - Overly permissive directives
   - Missing required origins
   - Any need for frame-src for Stripe Checkout
   - Any unnecessary Neon allowances (should be server-only)
   - Any unsafe-inline or unsafe-eval usage
3. Confirm nonce is properly generated and attached to script-src.
4. Check if any directives conflict with Edge runtime behavior.
5. Recommend:
   - Removal of unnecessary domains
   - Additional hardening (object-src, base-uri, form-action, frame-ancestors, etc.)
   - Any CSP Level 3 improvements
6. Ensure Stripe Checkout only requires:
   - connect-src to api.stripe.com
   - redirect navigation (not iframe embedding)
7. Confirm Statsig domains are correct and minimal.

Output format:
- ✅ What is correct
- ⚠️ What is risky
- ❌ What is wrong
- 🔐 Hardened CSP recommendation (final version)
- Short explanation for each change

Do not explain CSP basics. Focus only on production-grade correctness and risk minimization.

Here is my middleware implementation:
[paste middleware here]

Here is my layout implementation:
[paste layout here]
:::

---

### Why This Prompt Works

It:
- Forces structured audit output
- Prevents CSP 101 explanations
- Focuses on your real architecture
- Makes Claude validate runtime + Edge behavior
- Avoids Stripe Elements confusion

---

If you want, I can also give you a **“paranoid fintech-grade” CSP variant** optimized for payments + auth-heavy apps.

## Question

prompt has access to our codebase. 

## Answer

Good — since Claude Code has full repo access, you can make this much more aggressive and force a real security review instead of a surface-level CSP check.

Use this upgraded version:

---

:::writing{id="93814" variant="standard"}
You are a senior application security engineer performing a production readiness audit.

You have full access to my repository.

Audit my Next.js 14 (App Router) application for Content Security Policy correctness, completeness, and security hardening.

Architecture:

- Hosted on Vercel
- App Router
- Middleware-based CSP with per-request nonce
- Custom Clerk UI (no hosted Clerk components)
- Stripe Checkout (redirect flow, not Stripe Elements)
- Statsig client SDK
- Neon via Drizzle HTTP driver (server-side only)
- Vercel Edge Functions enabled

Your objectives:

1. Locate and analyze:
   - middleware.ts
   - next.config.js
   - app/layout.tsx
   - Any custom <Script> usage
   - Any dangerouslySetInnerHTML usage
   - Any inline scripts or eval usage
   - Any third-party SDK initializations

2. Validate CSP implementation:
   - Nonce is cryptographically strong and unique per request
   - Nonce is correctly injected into all runtime scripts
   - No accidental fallback to unsafe-inline or unsafe-eval
   - No wildcard origins unless strictly required
   - No https: broad allowances

3. Verify origin requirements:
   - Stripe Checkout only requires redirect navigation and api.stripe.com in connect-src
   - No unnecessary frame-src for Stripe
   - Clerk only requires connect/script (custom UI)
   - Statsig domains are minimal and correct
   - Neon is NOT present in CSP (server-side only)

4. Check Edge runtime compatibility:
   - CSP header generation compatible with Edge runtime
   - No Node-only crypto usage in middleware
   - No dynamic header mutations that break streaming

5. Identify:
   - Overly permissive directives
   - Missing security directives
   - CSP Level 3 improvements
   - Any script injection risks in the codebase

6. Produce:

- ✅ What is implemented correctly
- ⚠️ Risky or overly permissive areas
- ❌ Incorrect or broken logic
- 🔐 Hardened final CSP policy
- 🔎 Any code-level XSS risks found
- 📉 Risk severity rating (Low / Medium / High / Critical)

Do not explain CSP basics.
Focus on production-grade hardening and exploit surface reduction.
Assume this is a fintech-grade environment.

Here is my current middleware implementation:
[paste middleware here]

Here is my layout implementation:
[paste layout here]
:::

---

This version forces Claude to:

- Actually traverse the repo
- Look for XSS vectors
- Check nonce wiring
- Check Edge compatibility
- Remove Stripe iframe allowances (since you use Checkout redirect)
- Verify Neon is not mistakenly client-exposed

If you want, I can also give you a version that makes it simulate an attacker and attempt to find a bypass.
