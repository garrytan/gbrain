---
conversation_id: 67d315f4-e84c-8007-9f7b-b7060a9127e6
created: 2025-03-13
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 144
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: RLS Error in Supabase
type: essay
updated: 2025-03-15
---

# RLS Error in Supabase

> Conversation ID: 67d315f4-e84c-8007-9f7b-b7060a9127e6
> Created: 2025-03-13T17:29:25Z
> Updated: 2025-03-15T03:42:30Z
> Messages: 144


// /server/api/createUser.js
import { createClient } from '@supabase/supabase-js'
import { readBody, getMethod } from 'h3'

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_KEY
const supabase = createClient(supabaseUrl, serviceRoleKey)

export default defineEventHandler(async (event) => {
  // Only allow POST requests
  if (getMethod(event) !== 'POST') {
    return { error: 'Method not allowed' }
  }

  // Parse the request body
  const body = await readBody(event)
  const { clerk_user_id, firstName, lastName, birthday, height } = body

  if (!clerk_user_id) {
    return { error: 'Missing Clerk user ID' }
  }

  // Check if the user already exists
  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('clerk_user_id', clerk_user_id)
    .single()

  if (existingUser) {
    return { message: 'User already exists.' }
  }

  // Build the new user object
  const newUser = {
    clerk_user_id,
    first_name: firstName || null,
    last_name: lastName || null,
    name: firstName && lastName ? `${firstName} ${lastName}` : null,
    birthday: birthday || null,
    height_cm: height || null,
    username: null,
    profile_image: null
  }

  // Insert the new user into Supabase
  const { data, error } = await supabase
    .from('users')
    .insert([newUser])

  if (error) {
    return { error: error.message }
  }

  return { message: 'User created successfully.', data }
})


and then i get this error when i do a terminal call on my local mac
timwhite@tims-air headsupdisplay % curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"clerk_user_id": "34234"}' \
  http://localhost:3000/api/createUser
{
  "error": "new row violates row-level security policy for table \"users\""
}%                                                                                                                                                                                                   timwhite@tims-air headsupdisplay % 


Mr. White, this error means that row-level security (RLS) is enabled on your "users" table and no current policy allows the insert of your new row. Here are two common solutions:

- **Use the Service Role Key Correctly:** Ensure that your environment variable for the service role key is loaded properly. The service role should bypass RLS. If it isn’t being used, your operation will fall back to the anon role, which likely doesn’t have insert permissions.
- **Adjust RLS Policies:** Either disable RLS on the table (if that fits your security model) or add an insert policy that allows your desired operation.

Double-check your environment configuration and Supabase dashboard to resolve the issue.


help me setup the RLS properly in supabase


Mr. White, here’s a concise guide to setting up RLS properly in Supabase for your “users” table:

1. **Confirm Your Connection Key:**  
   Ensure your backend uses the service role key (which bypasses RLS). If it isn’t loaded properly, your inserts will run under the anon key and trigger RLS errors.

2. **Create an Insert Policy:**  
   In your Supabase dashboard’s SQL editor, run a policy command. For example, if you simply want to allow any insert as long as `clerk_user_id` isn’t null, you can use:
   ```sql
   CREATE POLICY "Allow insert for users"
   ON public.users
   FOR INSERT
   WITH CHECK (clerk_user_id IS NOT NULL);
   ```
   This policy allows the insertion of any row where `clerk_user_id` is provided.

3. **Optionally, Restrict by Authenticated User:**  
   If you prefer to restrict inserts to authenticated users whose UID matches `clerk_user_id`, use:
   ```sql
   CREATE POLICY "Authenticated insert"
   ON public.users
   FOR INSERT
   USING (auth.uid() IS NOT NULL)
   WITH CHECK (auth.uid() = clerk_user_id);
   ```
   *(Ensure your authentication setup supports the `auth.uid()` function.)*

4. **Test Your Changes:**  
   After applying the policy, re-run your curl command to verify that the insert now succeeds.

This setup should resolve the “violates row-level security policy” error.


for step 3 ERROR:  42601: only WITH CHECK expression allowed for INSERT


Mr. White, for INSERT policies in Supabase you can only use a WITH CHECK clause. To enforce that the authenticated user's UID matches the clerk_user_id, combine both conditions in the WITH CHECK clause. For example:

```sql
CREATE POLICY "Authenticated insert"
ON public.users
FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = clerk_user_id);
```

This policy ensures that the new row is only inserted if the authenticated user's UID is not null and equals the clerk_user_id field.


**Topic:** [[chatgpt-clusters/coding_devops]]
