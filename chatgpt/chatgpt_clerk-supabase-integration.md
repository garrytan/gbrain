---
title: "Clerk Supabase Integration"
type: note
created: 2025-07-05
updated: 2025-07-05
source: chatgpt-export
conversation_id: 6869b3b3-f0a8-8007-a263-e1d2ba65f46b
message_count: 2
tags: [chatgpt, import, code]
---
# Clerk Supabase Integration

> Conversation ID: 6869b3b3-f0a8-8007-a263-e1d2ba65f46b
> Created: 2025-07-05T23:22:28Z
> Updated: 2025-07-05T23:22:43Z
> Messages: 2

---

## User

clerk supabase intergration

---

## Assistant

​To integrate Clerk with Supabase, follow these steps:

1. **Set Up Clerk as a Supabase Auth Provider**:
   - In the Clerk Dashboard, navigate to the Supabase integration setup.
   - Activate the Supabase integration to obtain your Clerk domain.
   - In the Supabase Dashboard, go to Authentication > Sign In / Up.
   - Add Clerk as a third-party provider and paste the Clerk domain.

2. **Configure Row Level Security (RLS) in Supabase**:
   - Create a `user_id` column in your tables, defaulting to the Clerk user's ID:
     ```sql
     create table tasks (
       id serial primary key,
       name text not null,
       user_id text not null default auth.jwt()->>'sub'
     );
     ```
   - Enable RLS on the table:
     ```sql
     alter table tasks enable row level security;
     ```
   - Create policies to restrict data access based on the Clerk user ID:
     ```sql
     create policy "User can view their own tasks"
     on tasks
     for select
     using (auth.jwt()->>'sub' = user_id);

     create policy "Users must insert their own tasks"
     on tasks
     for insert
     with check (auth.jwt()->>'sub' = user_id);
     ```

3. **Install the Supabase Client Library**:
   - Install the library using your preferred package manager:
     ```bash
     npm install @supabase/supabase-js
     ```

4. **Set Up Environment Variables**:
   - In your `.env` file, add the following:
     ```env
     NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
     NEXT_PUBLIC_SUPABASE_KEY=your-supabase-anon-key
     ```

5. **Configure the Supabase Client with Clerk**:
   - Use Clerk's session token to authenticate Supabase requests:
     ```javascript
     import { createClient } from '@supabase/supabase-js';
     import { useSession } from '@clerk/clerk-react';

     const { session } = useSession();

     const supabase = createClient(
       process.env.NEXT_PUBLIC_SUPABASE_URL,
       process.env.NEXT_PUBLIC_SUPABASE_KEY,
       {
         global: {
           headers: {
             Authorization: `Bearer ${session?.getToken()}`,
           },
         },
       }
     );
     ```

6. **Test the Integration**:
   - Run your application.
   - Sign in with Clerk and perform operations to ensure that data access is appropriately restricted based on the authenticated user.

For a comprehensive guide and example code, refer to Clerk's official documentation on integrating with Supabase: linkturn0search0. 


**Topic:** [[chatgpt-clusters/coding_devops]]
