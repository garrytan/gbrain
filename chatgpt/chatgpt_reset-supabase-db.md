---
title: "Reset supabase db"
type: guide
created: 2025-08-18
updated: 2025-08-18
source: chatgpt-export
conversation_id: 68a3a908-914c-8321-9c32-3ae23412d92f
message_count: 6
tags: [chatgpt, import, code]
---
# Reset supabase db

> Conversation ID: 68a3a908-914c-8321-9c32-3ae23412d92f
> Created: 2025-08-18T22:28:31Z
> Updated: 2025-08-18T22:38:03Z
> Messages: 6

---

## User

Can I reset a suoabase db from the web interface



---

## Assistant

Not directly. Supabase doesn’t have a “reset DB” button in the web dashboard.  

From the web interface you can:  
- **Drop individual tables/schemas**  
- **Run SQL scripts** from the SQL editor (e.g. `drop schema public cascade; create schema public;`) to effectively wipe the database  
- **Delete and recreate the project** (this is the only way to truly reset everything from scratch, including auth, storage, etc.)  

If you just need to clear data but keep your schema, you can truncate all tables from the SQL editor.  

Want me to give you the exact SQL snippet to fully reset your `public` schema without deleting the project?

---

## User

yes

---

## Assistant

Here’s the clean nuke-and-reset for your `public` schema:  

```sql
-- Drop the schema and everything inside it
drop schema public cascade;

-- Recreate the schema
create schema public;

-- Reset default grants
grant usage on schema public to postgres;
grant create on schema public to postgres;
grant usage on schema public to authenticated;
grant usage on schema public to anon;
```

⚠️ This will **delete all tables, views, functions, data, etc.** in `public`. Your other Supabase schemas (`auth`, `storage`, etc.) remain untouched.  

Run it in the **SQL Editor** in your Supabase dashboard.  

Do you want me to also give you a version that just **truncates (empties) all tables** but keeps the schema intact?

---

## User

Should we create seed users? And how can that work with clerk?

---

## Assistant

Short answer: **Yes—seed users, but only in dev/staging.** Do it **in Clerk**, not directly in Supabase. Supabase should only mirror Clerk users (via webhook/edge function) and hold your app-specific profile data.

# What to do

1) **Schema (Supabase)**
- Keep a lightweight `profiles` table keyed by Clerk ID.
```sql
create table if not exists profiles (
  clerk_id text primary key,
  username text unique,
  display_name text,
  avatar_url text,
  plan text default 'free',
  created_at timestamptz default now()
);

-- RLS example (read/write own row)
alter table profiles enable row level security;

create policy "read own profile"
on profiles for select
using (clerk_id = (auth.jwt() ->> 'sub'));

create policy "update own profile"
on profiles for update
using (clerk_id = (auth.jwt() ->> 'sub'));
```
> Note: Policies assume your requests to Supabase include a **validated Clerk JWT**, and you read the `sub` claim via `auth.jwt() ->> 'sub'`.

2) **Mirror Clerk → Supabase (Edge function)**
- Point Clerk **User Webhooks** (`user.created`, `user.updated`, `user.deleted`) to an Edge Function that upserts/deletes `profiles`.

_TypeScript (Edge Function)_
```ts
// supabase/functions/clerk-user-sync/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  // Verify Clerk webhook signature here if you’ve enabled signing.
  const evt = await req.json(); // {type, data:{id, username, image_url, ...}}
  const user = evt.data;

  if (evt.type === "user.deleted") {
    await supabase.from("profiles").delete().eq("clerk_id", user.id);
    return new Response("deleted");
  }

  // created/updated
  const payload = {
    clerk_id: user.id,
    username: user.username ?? null,
    display_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
    avatar_url: user.image_url ?? null,
    plan: (user.public_metadata?.plan as string) ?? "free",
  };

  await supabase.from("profiles").upsert(payload, { onConflict: "clerk_id" });
  return new Response("ok");
});
```

3) **Seed users (Clerk Admin API)**
- Run a tiny Node script (dev env only) to create test users. This will trigger your webhook and populate `profiles`.

_Node script (run once with `CLERK_SECRET_KEY` set)_
```ts
// scripts/seed-clerk-users.ts
import fetch from "node-fetch";

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY!;
const base = "https://api.clerk.com/v1";

const users = [
  { email: "demo+free@example.com", password: "Passw0rd!free", plan: "free" },
  { email: "demo+pro@example.com",  password: "Passw0rd!pro",  plan: "pro"  },
  { email: "demo+admin@example.com",password: "Passw0rd!admin",plan: "admin"},
];

(async () => {
  for (const u of users) {
    const res = await fetch(`${base}/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email_address: [u.email],
        password: u.password,
        public_metadata: { plan: u.plan, seed: true }
      }),
    });

    if (!res.ok) {
      console.error(u.email, await res.text());
      continue;
    }
    const json = await res.json();
    console.log("Created:", json.id, u.email, u.plan);
  }
})();
```

4) **Tagging & access in your app**
- Read `plan` from **Clerk public_metadata** (fastest) or from `profiles.plan` after the webhook upsert.
- For feature gates, check the claim in the Clerk JWT or fetch the profile row post-login.

5) **Cleanup & resets**
- When you “reset” your DB, also **delete seed users in Clerk** (filter by `public_metadata.seed = true`) to avoid orphaned identities.
- Re-run the seed script; webhooks will recreate `profiles`.

# TL;DR
- **Seed in Clerk.** Mirror to Supabase via webhook.  
- **Use Clerk JWT `sub`** to secure RLS in Supabase.  
- Keep `profiles` keyed by `clerk_id` (text), and store plan/role in metadata for gating.  

If you want, I’ll hand you a ready-to-run `package.json` script + `.env.example` for the seeder and the exact Clerk webhook config.
