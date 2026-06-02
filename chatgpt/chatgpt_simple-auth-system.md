---
title: "Simple auth system"
type: guide
created: 2025-09-27
updated: 2025-09-27
source: chatgpt-export
conversation_id: 68d83844-fdac-8333-9405-8620f797ae9f
message_count: 2
tags: [chatgpt, import, code]
---
# Simple auth system

> Conversation ID: 68d83844-fdac-8333-9405-8620f797ae9f
> Created: 2025-09-27T19:17:58Z
> Updated: 2025-09-27T19:18:45Z
> Messages: 2

---

## User

How complex would a simple auth system be to lock down a few pages on our next.js site. We only want it to be for admins and we dont havea. Database currently.

---

## Assistant

Mr. White — easiest paths, no DB:

## 1) HTTP Basic Auth (shared credentials)
**When to use:** You just need to hide a few routes (e.g., `/admin`, `/ops`) from the public.  
**How it works:** Put a `middleware.ts` that challenges with Basic Auth and checks against env vars.

```ts
// middleware.ts
import { NextResponse } from "next/server"

const PROTECTED = [/^\/admin(\/|$)/, /^\/ops(\/|$)/] // add routes here
const USER = process.env.ADMIN_USER!
const PASS = process.env.ADMIN_PASS!

export function middleware(req: Request) {
  const { pathname } = new URL(req.url)
  if (!PROTECTED.some((re) => re.test(pathname))) return NextResponse.next()

  const auth = req.headers.get("authorization")
  if (!auth?.startsWith("Basic ")) {
    return new NextResponse("Auth required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Restricted"' },
    })
  }
  const [u, p] = Buffer.from(auth.split(" ")[1], "base64").toString().split(":")
  if (u === USER && p === PASS) return NextResponse.next()

  return new NextResponse("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Restricted"' } })
}

export const config = { matcher: ["/admin/:path*", "/ops/:path*"] }
```

**Pros:** Fastest; zero UI; no cookies/sessions.  
**Cons:** One shared username/password; browser remembers per origin; no fine-grained users.

---

## 2) “Password gate” with signed cookie (single secret)
**When to use:** You want a simple login form + logout, still no DB, and a *single* admin password.

**Flow:**
- `/admin/login` posts a password; if it matches `process.env.ADMIN_SECRET`, set an **HttpOnly**, **Secure** cookie (e.g., `adm=HMAC(secret, "ok")` with an expiry).
- `middleware.ts` checks the cookie for protected routes.

**Server utils (cookie signing):**
```ts
// lib/auth.ts
import crypto from "crypto"
const SECRET = process.env.ADMIN_SECRET!

export function sign(val: string) {
  return `${val}.${crypto.createHmac("sha256", SECRET).update(val).digest("base64url")}`
}
export function unsign(signed: string) {
  const [val, sig] = signed.split(".")
  const good = crypto.createHmac("sha256", SECRET).update(val).digest("base64url")
  return sig === good ? val : null
}
```

**Middleware:**
```ts
// middleware.ts
import { NextResponse } from "next/server"
import { cookies } from "next/headers" // not available in middleware; use request.headers instead
import { unsign } from "./lib/auth"

export function middleware(req: Request) {
  const { pathname } = new URL(req.url)
  const protectedPaths = ["/admin", "/ops"]
  const isProtected = protectedPaths.some(p => pathname === p || pathname.startsWith(p + "/"))
  if (!isProtected) return NextResponse.next()

  const cookie = req.headers.get("cookie") ?? ""
  const match = cookie.match(/(?:^|;\s*)adm=([^;]+)/)
  const val = match ? decodeURIComponent(match[1]) : null
  if (val && unsign(val) === "ok") return NextResponse.next()

  return NextResponse.redirect(new URL("/admin/login", req.url))
}

export const config = { matcher: ["/admin/:path*", "/ops/:path*"] }
```

**Route action (sets cookie):**
```ts
// app/admin/login/actions.ts
"use server"
import { cookies } from "next/headers"
import { sign } from "@/lib/auth"

export async function login(formData: FormData) {
  const pwd = formData.get("password")
  if (pwd !== process.env.ADMIN_SECRET) return { ok: false }
  cookies().set("adm", sign("ok"), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60*60*8 })
  return { ok: true }
}
```

**Pros:** Simple UI + logout possible; avoids basic-auth dialog; still no DB.  
**Cons:** Single shared secret; no per-user audit.

---

## 3) JWT-only Auth.js (Credentials provider, no DB)
**When to use:** You want a standard auth library and session helpers, but still no database.

**How it works:** Use **Auth.js (NextAuth)** with `CredentialsProvider` and `session: { strategy: "jwt" }`. Admins can be a small list in `ENV` (e.g., comma-separated emails or one shared code). Use `withAuth` or middleware to protect routes.

**Pros:** Familiar API, easy guards (`useSession`, `getServerSession`).  
**Cons:** Slightly more setup; you’re still hard-coding admins; adding real users later means migrating to a DB.

---

### Recommendation
- **Fastest + good enough:** **Basic Auth (Option 1)** for a handful of internal pages.
- **Slightly nicer UX + logout:** **Signed-cookie gate (Option 2)**.
- **Growing toward real auth later:** **Auth.js JWT mode (Option 3)**, then swap in a DB when ready.

If you want, tell me which routes to protect and which option you prefer; I’ll drop in the exact files.


## See Also
- [[chatgpt/chatgpt_auth-system-with-toast-pin]]
- [[chatgpt/chatgpt_auth-provider-for-chatgpt]]
- [[chatgpt/chatgpt_auth-ux-audit]]
- [[chatgpt/chatgpt_basic-auth-in-nextjs]]
- [[chatgpt/chatgpt_best-auth-providers-2025]]
