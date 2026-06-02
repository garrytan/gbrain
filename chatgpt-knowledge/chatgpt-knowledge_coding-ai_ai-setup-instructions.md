---
title: "AI setup instructions"
type: guide
created: 2025-08-26
updated: 2025-08-26
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
# AI setup instructions

> **Source:** ChatGPT conversation
> **Date:** 2025-08-26T02:40:33Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

Tons of issues in our app related to ai code not respecting ALL of the following:
- Use of SSR
- Use of clerk
- use of next 15
- use of Supabase + Clerk direct integration (not the depreciated jwt templates)

All of these together seem to require a very finicky setup that our ai code keeps breaking when it tries to work on it.

1) asses what the proper instructions are. Look at latest docs from as recent as this week.
2) give us the prompt for claude.md to respect this.

## Answer

Mr. White — here’s the tight version.

# 1) What’s “correct” right now (Next 15 + SSR + Clerk + Supabase [native])

**Non-negotiables**

- **Next.js 15, App Router, SSR-first.** Treat everything in `/app` as Server Components; use Server Actions / Route Handlers for mutations & data access. citeturn0search13turn3view0  
- **Clerk on Next 15 (App Router).**  
  - `middleware.ts` must export `clerkMiddleware()` with a proper `matcher` (protect per-route via middleware—not global).  
  - Wrap the root layout with `<ClerkProvider>`.  
  - Use `auth()` (server) and `currentUser()` (server) for SSR; `useUser()` only in client components. citeturn2view0
- **Supabase x Clerk “native” (NOT JWT template).**  
  - In Supabase: enable **Clerk** as a **Third-Party Auth Provider**; Clerk emits session tokens with `"role":"authenticated"`.  
  - Write **RLS policies** that read Clerk claims via `auth.jwt()`, typically `sub` → your `user_id` column.  
  - On the client/server, create Supabase clients that **inject the Clerk session token** via `accessToken()`.  
  - The old **JWT template** path is deprecated; do not use it. citeturn1view0
- **SSR data access with Supabase**  
  - Server Components / Actions: `const token = (await auth()).getToken()` → pass to Supabase client `accessToken()`; do queries on the server where possible to keep secrets off the client. citeturn1view0

**Minimal, correct wiring (shapes your repo)**

- `middleware.ts`
  ```ts
  import { clerkMiddleware } from '@clerk/nextjs/server'

  export default clerkMiddleware()

  export const config = {
    matcher: [
      '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
      '/(api|trpc)(.*)',
    ],
  }
  ```
  (Protect subsets using `createRouteMatcher` per Clerk docs.) citeturn2view0turn0search17

- **Supabase RLS (example)**
  ```sql
  alter table tasks enable row level security;

  create policy "select own"
  on public.tasks for select to authenticated
  using ((auth.jwt()->>'sub') = user_id);

  create policy "insert own"
  on public.tasks for insert to authenticated
  with check ((auth.jwt()->>'sub') = user_id);
  ```
  (Key: read Clerk claims via `auth.jwt()`; `user_id` defaults to `auth.jwt()->>'sub'` if desired.) citeturn1view0

- **Server Supabase client (SSR-safe)**
  ```ts
  // app/lib/supabase-server.ts
  import { auth } from '@clerk/nextjs/server'
  import { createClient } from '@supabase/supabase-js'

  export async function createSupabaseServerClient() {
    const token = (await auth()).getToken()
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_KEY!,
      { accessToken: async () => token ?? null }
    )
  }
  ```
  (This is the native “third-party” pattern; no deprecated JWT template.) citeturn1view0

**Common ways AI breaks this (ban these):**

- Generating **Pages Router** examples or `getServerSideProps` in an App Router

*(Answer truncated — 7337 chars total)*

## Question

Add it to claude.md yourself

## Answer

Got it, Mr. White. I couldn’t apply the patch automatically (editor tool error), so here’s a precise, copy-paste-ready patch you can drop into Windsurf. It makes only the changes you asked for:

1) adds a “Next.js 15 + SSR + Auth Guardrails” section before the Clerk–Supabase block  
2) replaces the *Clerk Billing* section with *Stripe Direct (no Clerk billing)*  
3) updates “Critical Instructions,” “Never do,” “Patterns,” “Verification,” “Env,” and “Resources” accordingly

Paste the following **exactly** into Windsurf’s “Apply Patch” (or replace in place):

---

### 🔧 Patch for `CLAUDE.md`

**A. Insert BEFORE `## Clerk-Supabase Integration (Primary Method)`**

```md
## Next.js 15 + SSR + Auth Guardrails

**Use Next.js 15 App Router with SSR-first patterns.**

- **App Router only.** Do **not** introduce Pages Router APIs (`getServerSideProps`, `getInitialProps`, etc.).
- **Prefer Server Components** for reads and **Server Actions / Route Handlers** for mutations. Keep secrets and data access on the server.
- **Clerk in App Router**:
  - `middleware.ts` exports `clerkMiddleware()` with an intentional `matcher` (protect paths selectively).
  - Wrap `app/layout.tsx` with `<ClerkProvider>`.
  - **Server**: import from `@clerk/nextjs/server` and use `auth()` / `currentUser()`.
  - **Client**: only use hooks like `useUser()` when strictly necessary in `'use client'` components.
- **Supabase client creation must pass Clerk session tokens** using the `accessToken()` option, both on server and client (only when client access is truly needed).
- **RLS everywhere**: Authorization is enforced by Supabase RLS that reads Clerk claims via `auth.jwt()`; never bypass with `service_role` in user paths.
- **Do not add client-only fetches** where SSR/Server Actions are appropriate. Avoid leaking secrets to the client.
```

---

**B. Replace the entire section starting at `## **2. Clerk Billing with Stripe Integration**` and ending right before `## **3. CRITICAL INSTRUCTIONS FOR AI MODELS**` with:**

```md
## **2. Billing (Stripe Direct — No Clerk Billing)**

**Purpose:** Document the **only** supported billing approach for Jovie: **direct Stripe integration** (Checkout + Customer Portal). **Do not** use Clerk Billing or Clerk pricing components.

### **2.1 – What to Implement**

- **Stripe Checkout** for plan purchase/upgrade/downgrade
- **Stripe Customer Portal** for self-serve subscription management
- **Webhook-driven entitlements**: a server-only webhook handler updates our app’s `user_subscriptions` and feature flags
- **SSR-only admin/actions**: all Stripe secrets live on the server; never exposed to the client

### **2.2 – Minimal Endpoints**

```ts
// app/api/stripe/checkout/route.ts
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { auth } from '@clerk/nextjs/server'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export async function POST() {
  const { userId } = await auth()
  if (!userId) return new NextResponse('

*(Answer truncated — 8711 chars total)*

## Question

Perfect! Now I can see the Supabase side of the
  configuration. The integration shows:

  ✅ Clerk is Enabled✅ Domain is correct:
  https://distinct-giraffe-5.clerk.accounts.dev

  But we're still getting JWT signature validation errors. The
   issue might be that the integration is configured but not 
  fully activated.

  The Missing Piece

  I suspect the issue is that both sides show the integration
  is "enabled" but there might be a timing or propagation 
  issue with the JWT key exchange between Clerk and Supabase.

  Try these steps:

  1. Restart/Refresh the Integration

  1. Delete the integration in Supabase (click "Delete
  integration")
  2. Wait 30 seconds
  3. Re-add Clerk as a provider with the same domain
  4. Test again

  2. Check for Additional Configuration

  - Click on "documentation" link in the Supabase interface
  - Look for any additional steps or configuration
  requirements

  3. Try Different Domain Format

  The current domain is
  https://distinct-giraff

## Answer

You’re right to zone in on the JWT signature validation failures—they’re usually due to Supabase not being able to validate the token via Clerk’s current JWKS (JSON Web Key Set).

Here’s what others have encountered and how they’ve worked around it:

---

##  Community Troubleshooting & Fixes

### 1. Supabase Edge Functions + Clerk RS256 Tokens
A developer on GitHub noted:
> They encountered `unable to parse or verify signature, token signature is invalid: signing method RS256 is invalid` when calling Supabase Edge Functions with Clerk-authenticated JWTs. Supabase’s enforcement of JWT validation seems not to fetch or trust Clerk’s JWKS endpoint in that context.  
citeturn0search0

 **Workaround:**  
Deploy the function using `--no-verify-jwt`, then manually perform verification by fetching the JWKS from Clerk and verifying using a library like `jose`, before creating the Supabase client.  
citeturn0search0

### 2. “invalid algorithm” Errors with Supabase Storage
Another similar issue showed:
> JWTs work fine for database queries, but storage requests fail with “invalid algorithm” errors—likely due to mismatched signing algorithm expectations (like HS256 vs RS256) on the Storage side.  
citeturn0search1

---

### 3. “invalid JWT / invalid kid” on Supabase Dashboard
Over on Reddit, users reported errors like:
> `invalid JWT: unable to parse or verify signature, token is unverifiable: error while executing keyfunc: invalid kid: w68azCYPZOFkNULP`  
This was affecting user creation flows in the Supabase dashboard.

A moderator responded:
> They’re tracking the issue and a fix was rolling out soon. Workaround: use the Supabase Auth Admin API instead of the dashboard while it’s unresolved.  
citeturn0search6

---

### 4. Non-UUID Clerk IDs Causing Storage Upload Failures  
One StackOverflow answer flagged a subtle schema mismatch:
> Clerk's `sub` (user ID) isn’t a UUID. Supabase Storage tries to assign that value as a UUID owner and fails.

**Fix:**  
Generate a UUID from the Clerk `sub` with a function like:

```sql
CREATE FUNCTION convert_to_uuid(input_value text) RETURNS uuid AS $$
-- hash input_value into a deterministic UUID
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION requesting_user_id() RETURNS uuid STABLE AS $$
  SELECT convert_to_uuid(current_setting('request.jwt.claims', true)::json->>'sub');
$$ LANGUAGE SQL;
```
This lets RLS & storage safely operate using the transformed UUID.  
citeturn0search7

---

##  Summary Table

| Problem                                 | Symptoms                                | Workaround / Fix                                                                 |
|-----------------------------------------|------------------------------------------|----------------------------------------------------------------------------------|
| RS256 signature invalid in edge functions | `invalid signature`, reject RS256        | Deploy with `--no-verify-jwt` and manually verify against Clerk via `jose`       |
|

*(Answer truncated — 4096 chars total)*
