---
conversation_id: 68a6b62f-2fb4-832f-87cc-de5a970c126e
created: 2025-08-21
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: Onboarding with Supabase RLS
type: note
updated: 2025-08-21
---

# Onboarding with Supabase RLS

**Related:** [[coding_devops]]

> Conversation ID: 68a6b62f-2fb4-832f-87cc-de5a970c126e
> Created: 2025-08-21T06:02:04Z
> Updated: 2025-08-21T06:05:31Z
> Messages: 4

---

## User

So the way AI wrote our code for our onboarding experience, it's asking for a service role key for SuperBase to bypass the RLS policies during the onboarding process. Is this correct? And should I set the service role key then? Or is there a better way to set it up so that we don't have to do that? What would be the optimal way to do this?

---

## Assistant

Mr. White — short answer: **don’t bypass RLS. Don’t ever put the service-role key in client/onboarding code.** Keep RLS on 24/7 and run any privileged setup on the server only.

## Optimal pattern (Supabase + Next.js + Clerk)
1. **Auth**  
   - Use Clerk for auth and **External JWT** with Supabase so `auth.uid()` resolves to the Clerk user ID.  
   - Client uses only `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

2. **RLS-first schema**  
   - Write policies so users can **insert their own row** and **update only their own data**. Typical patterns:
     - `INSERT ... WITH CHECK ( user_id = auth.uid() )`
     - `SELECT/UPDATE ... USING ( user_id = auth.uid() )`

3. **Onboarding writes (no service role on client)**  
   Choose one of these (both are good; pick per complexity):

   - **A. RLS-safe direct writes from the client**  
     Structure tables/policies so the user can create their own `profile/creator` records during onboarding with the anon key. No elevated key needed.

   - **B. Single server-side “scaffold” call** (best when onboarding touches many tables/needs a transaction)  
     Call a **server action/Route Handler/Edge Function** that:
     - Runs with **`SUPABASE_SERVICE_ROLE_KEY`** (kept only in server env).
     - Executes a Postgres **`SECURITY DEFINER` RPC** or transaction to create all onboarding rows.
     - Internally enforces `requested_user_id == authUserIdFromClerk` to prevent creating data for other users.

4. **When to use the service role**  
   - Only on the **server** (Next.js server action, API route, or Edge Function).  
   - For **admin/privileged** ops: backfills, system webhooks, email admin, cross-tenant writes.  
   - Never in browser/mobile; never to “temporarily disable” RLS.

## Minimal policy shapes (illustrative)
- Profiles:
  - `INSERT WITH CHECK ( user_id = auth.uid() )`
  - `SELECT/UPDATE USING ( user_id = auth.uid() )`
- Related tables (`links`, `creators`, etc.): include a FK path that ultimately ties to `user_id = auth.uid()` in `USING/WITH CHECK`.

## Practical setup
- **Env vars**  
  - Client: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`  
  - Server only: `SUPABASE_SERVICE_ROLE_KEY`
- **Flow**  
  - User signs in with Clerk → client calls either:
    - Direct RLS-safe inserts (simple onboarding), or
    - A server endpoint that runs the scaffold (complex onboarding).

### Bottom line
- **Correct** approach is **not** to “set the service role key for onboarding” in client code.  
- **Best** approach: keep RLS enforced; either make onboarding RLS-safe from the client or funnel it through a **single server-side scaffold** that uses the service role securely.

---

## User

Okay, that's perfect. Let's just update it to include, because I think the Anon key has been depreciated. We have it in our system as a fallback, but I think that the publishable key is what you're supposed to use now with the new API keys. So knowing that, give me a concise AI prompt for how to modify our system based on what you just told me.

---

## Assistant

Mr. White—here’s a tight prompt you can drop into your AI/code-agent:

---

**Task:** Refactor onboarding to keep RLS enforced and replace deprecated Supabase **anon key** with the new **publishable key**. Never expose the **service-role** key to clients.

**Requirements**
1. **Env & init**
   - Client uses: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
   - Server uses (only): `SUPABASE_SERVICE_ROLE_KEY`.
   - Update Supabase JS v2 init:
     - Browser: `createBrowserClient(url, publishableKey)`.
     - Server (Next.js 15): `createServerClient` or a dedicated admin client **only** in server actions/route handlers/edge functions with the service role key.
   - Rotate and remove any lingering anon keys; update CI secrets.

2. **Auth plumbing (Clerk ↔ Supabase)**
   - Use External JWT so `auth.uid()` resolves to the Clerk user ID.
   - Middleware/SSR must pass the Clerk token to Supabase; no key leakage in responses.

3. **Onboarding flow**
   - Prefer **RLS-safe client writes**: tables/policies allow user to create their own rows.
   - If multi-table/transactional, add a **single server endpoint** that:
     - Runs with service role on the server.
     - Verifies `requested_user_id === authUserId` internally.
     - Optionally uses a `SECURITY DEFINER` RPC.

4. **RLS policies (migrations)**
   - `INSERT WITH CHECK (user_id = auth.uid())`
   - `SELECT/UPDATE USING (user_id = auth.uid())`
   - For related tables, enforce FK path tying records to `auth.uid()`.

5. **Hardening & tests**
   - Grep repo to confirm no service-role key in client/runtime bundles.
   - Add e2e tests: user can complete onboarding; cannot read/update others’ data.
   - Add unit tests for policy-guarded inserts/updates.
   - Ensure 401/403 paths handled gracefully.

**Deliverables:** Updated env usage, client/server Supabase factories, migrations for policies, server onboarding endpoint (if used), and passing tests.


**Topic:** [[chatgpt-clusters/coding_devops]]


## See Also
- [[chatgpt/chatgpt_offline-sync-with-supabase]]
- [[chatgpt/chatgpt_1password-with-chatgpt-atlas]]
- [[chatgpt/chatgpt_adjusting-parfait-with-pecans]]
- [[chatgpt/chatgpt_ai-driven-onboarding-design]]
- [[chatgpt/chatgpt_arguing-with-facts]]
