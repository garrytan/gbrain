---
title: "Allow preview.jov.ie setup"
type: note
created: 2025-12-07
updated: 2025-12-07
source: chatgpt-export
conversation_id: 6935b23d-2fb0-832c-9928-3d6929a7324d
message_count: 4
tags: [chatgpt, import]
---
# Allow preview.jov.ie setup

> Conversation ID: 6935b23d-2fb0-832c-9928-3d6929a7324d
> Created: 2025-12-07T16:58:46Z
> Updated: 2025-12-07T17:02:13Z
> Messages: 4

---

## User

set clerk to allow preview.jov.ie

---

## Assistant

Mr. White, you don’t actually “add” `preview.jov.ie` on this Domains screen—the Clerk instance is already bound to `jov.ie` (and `clerk.jov.ie`). What you need is either:

1. **Allow `preview.jov.ie` in URLs / redirects (most common)**  
2. (Optional) Set it up as a **Satellite domain** if you want full multi-domain support.

---

### 1. Allow `preview.jov.ie` for auth redirects

Do this in the **Configure → User & authentication** area, not on the Domains page you’re on now.

In the left sidebar:

1. Click **Configure → User & authentication**.  
2. Go to the section for **URLs / Redirects / Allowed origins** (wording varies slightly, but it’s in that screen).  
3. Add the following where appropriate:
   - **Allowed redirect URLs**:  
     - `https://preview.jov.ie/*` or the exact callback paths you use (e.g. `https://preview.jov.ie/sso-callback`, `https://preview.jov.ie/sign-in`, etc.).
   - **Allowed origins** (for CORS / frontend):  
     - `https://preview.jov.ie`
   - **Allowed origins (proxy)** if you’re using the Clerk proxy:  
     - `https://preview.jov.ie`

Then make sure your app’s env vars match, for example (Next.js / similar):

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...` (same key as production)
- Any URL-specific vars like `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, etc. should use the `https://preview.jov.ie/...` paths.

That’s usually all you need for a preview domain.

---

### 2. (Optional) Make `preview.jov.ie` a Satellite

Only do this if you want multi-domain behavior (different branding, paths, etc. per domain).

From the page you’re on now:

1. Under **Developers → Domains**, click **Satellites (Add-on)**.  
2. Click **Add satellite**.  
3. Set:
   - **URL**: `https://preview.jov.ie`
   - Name/label: something like `Preview`  
4. Save.

DNS-wise you just keep:

- `preview.jov.ie` → your app host (e.g. Vercel)  
- `clerk.jov.ie` → `frontend-api.clerk.services` (already shown and verified)

You don’t need a separate Clerk CNAME for `preview.jov.ie`.

---

If you tell me which framework you’re using (Next, Remix, etc.), I can give you the exact env var values for `preview.jov.ie`.

---

## User

do it for me in agent mode

---

## Assistant

I accessed the Clerk dashboard and tried to locate the configuration section for “Allowed redirect URLs” and “Allowed origins” so I could whitelist `preview.jov.ie`. I navigated through **Configure → User & Authentication**, used the quick‑search function and explored the Restrictions and Domains sections. However, the interface does not appear to expose fields for adding new redirect URLs or origins from within the current context, and the “Preview” options only lead to sign‑up/sign‑in demos rather than configuration settings【57140768201733†screenshot】. 

If you can point me to a specific section or provide any additional details (such as the exact menu name for the redirect/origin settings), I can try again. Alternatively, you might need to add `https://preview.jov.ie` to the allowed redirect URLs and origins from your environment configuration or code (e.g., via environment variables like `NEXT_PUBLIC_CLERK_SIGN_IN_URL` and `NEXT_PUBLIC_CLERK_SIGN_UP_URL`). Once I have more precise instructions on where to enter this domain, I’ll be able to complete it for you.
