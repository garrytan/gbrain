---
title: "Basic auth in Next.js"
type: guide
created: 2025-09-22
updated: 2025-09-22
source: chatgpt-export
conversation_id: 68d175dd-0a64-8326-8d0d-6d003f044701
message_count: 4
tags: [chatgpt, import, code]
---
# Basic auth in Next.js

> Conversation ID: 68d175dd-0a64-8326-8d0d-6d003f044701
> Created: 2025-09-22T16:15:29Z
> Updated: 2025-09-22T16:16:38Z
> Messages: 4

---

## User

i have a documentation website built in next.js.
I need very basic auth to allow admins to see one section of the site and no one else.
Whats the quickest, vleanedway to do this? My first thought is clerk.dev, but it want it to be fast to implement. Though i am using ai coding agents it will be quick. But i dont want to over complicate the code base.

---

## Assistant

Here are three simple approaches, from fastest to more structured, all easy to drop into a Next.js docs site.

---

### 1. Single password with middleware (fastest, no service)
- **How**:  
  Create an env var `ADMIN_SECRET`.  
  In `middleware.ts`:
  ```ts
  import { NextResponse } from 'next/server';

  export function middleware(req: Request) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/admin')) {
      const auth = req.headers.get('authorization');
      if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
        return new NextResponse('Unauthorized', { status: 401 });
      }
    }
    return NextResponse.next();
  }
  ```
- Use a browser extension like “ModHeader” or add a tiny login page that sets a cookie with that token.
- **Pros**: 5-minute setup, no extra deps, deploys anywhere.
- **Cons**: One shared secret, no user management.

---

### 2. NextAuth “Credentials” provider
- `npm i next-auth`
- Add a simple credentials provider that checks a hard-coded admin email/password in your env vars.
- Protect your admin pages with `getServerSideProps` or the new App Router `getServerSession`.
- **Pros**: Sessions, cookie-based auth, still very light.
- **Cons**: Slightly more code, but still a single file config.

---

### 3. Clerk.dev (your original idea)
- Great if you already want user accounts, social login, etc.
- Easiest managed option, but more moving parts and bigger bundle.

---

**Recommendation:**  
For a “docs site + one hidden admin section,” use **#1** if you just need a quick shared-secret gate.  
Use **#2** if you want real login sessions but still minimal code.  
Clerk is overkill unless you expect multiple admins or future user auth.

---

## User

Ok give me a prompt to do 1.


---

## Assistant

Here’s a clean prompt you can drop into your AI coding agent to implement the shared-secret middleware gate:

---

**Prompt:**  
> Create a `middleware.ts` file at the project root of my Next.js app (using the App Router).  
> Goal: protect all routes under `/admin` with a single shared secret.  
> Requirements:  
> – Read the secret from `process.env.ADMIN_SECRET`.  
> – Check the `Authorization` header for `Bearer <ADMIN_SECRET>`.  
> – If the header is missing or incorrect, return a 401 response with the text `Unauthorized`.  
> – Otherwise, allow the request to proceed.  
> – Apply only to paths starting with `/admin`.  
> – Export the proper `config` object so the middleware runs only on `/admin/:path*`.  
> – Keep the code concise and idiomatic for Next.js 13+.

---

That’s all the agent needs to generate the file.  
Remember to set `ADMIN_SECRET` in your `.env.local` before deploying.
