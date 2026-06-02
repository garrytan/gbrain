---
conversation_id: 6845ef66-8ea8-8007-bfad-5feeae275f02
created: 2025-06-08
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Builder.io Supabase Integration
type: guide
updated: 2025-06-08
---

# Builder.io Supabase Integration

**Related:** [[coding_devops]]

> Conversation ID: 6845ef66-8ea8-8007-bfad-5feeae275f02
> Created: 2025-06-08T20:15:34Z
> Updated: 2025-06-08T20:47:13Z
> Messages: 6

---

## User

If I'm using Builder.io to build out a progressive web app in Vue, and I want to use Supabase as my backend for both database and auth, and I'm on Versal, and I used Versal to create the Supabase project, and I have that, and I have my API keys and stuff now, what are my options with Builder.io? Can I get Builder.io to talk to Supabase, or do I have to set up my database separately myself? And then does Builder.io need .env file, or how do I set that up? Because if I put in auth and stuff, is Builder.io not going to be able to work with it anymore?

---

## Assistant

Mr. White, Builder.io is purely your headless CMS/front-end layer—it doesn’t spin up or manage your database/auth for you. You’ll still use Supabase (via Vercel) as your single source of truth for data and auth; Builder simply “talks” to your app, not directly to Supabase.

**Your options:**  
1. **Fetch Supabase data in your Vue code**  
   - In your pages/components, import and initialize `@supabase/supabase-js` with your VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.  
   - Query Supabase directly (e.g. `supabase.from('…').select()`) and then pass that data into your Builder components via the `data` prop on `<BuilderComponent>`.  
   - Your Vue build (on Vercel) handles both: Builder.io delivers the “shell” and layout, Supabase supplies the content. citeturn0search2  

2. **Use Builder.io’s Custom Data Sources (HTTP)**  
   - In the Builder.io dashboard, add a new Data Source, point it at Supabase’s REST endpoints (e.g. `https://your-project.supabase.co/rest/v1/…`), and configure headers for your anon key.  
   - Designer–side you can drag in that Data Source and bind fields directly—no extra code needed in Vue.  

3. **Roll your own Builder plugin/SDK call**  
   - If you want the “magic” of supabase-js (realtime, auth hooks), wrap your Supabase calls in a little service module and expose it to Builder via Vue plugins or provide/inject.  

---

### Environment variables  
- **Supabase**  
  ```bash
  // .env.local (Vite/Nuxt)
  VITE_SUPABASE_URL=https://<your-project>.supabase.co
  VITE_SUPABASE_ANON_KEY=<your-anon-key>
  ```  
  – then in your code:  
  ```js
  import { createClient } from '@supabase/supabase-js';
  export const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY
  );
  ``` citeturn0search0  

- **Builder.io**  
  ```bash
  // .env.local
  VITE_BUILDER_PUBLIC_API_KEY=<your-builder-public-key>
  ```  
  – and in your app entry:  
  ```js
  import { builder } from '@builder.io/vue';
  builder.init(import.meta.env.VITE_BUILDER_PUBLIC_API_KEY);
  ``` citeturn0search3  

**Auth and the Builder editor:**  
Builder’s preview/editor will hit your dev server like any browser. As long as your Supabase auth checks are client-side (e.g. magic link in localStorage) you won’t break the editor. If you gate routes server-side, you may need a “preview” endpoint that skips auth so Builder can render; you can detect `builderUserAgent` on incoming requests and bypass auth for localhost.

---

## User

If I start editing my Builder.io project locally in VS Code, and then I push those changes to GitHub, will Builder.io pull in those changes, or am I only able to use Builder.io at the beginning of the project?

---

## Assistant

Mr. White, out of the box Builder.io’s Visual Editor and your code repo are totally decoupled—pushing code to GitHub won’t update the Builder UI unless you opt into their Projects workflow:

- **Classic headless-CMS + SDK mode**  
  You use the Builder CLI once (e.g. `npx "@builder.io/dev-tools" add <snippetId>`) to scaffold native Vue code. After that, Builder only manages content models—you continue editing code in VS Code and pushing to GitHub, but Builder won’t pull those commits back into its editor citeturn0search7.

- **Builder Projects (beta/Enterprise) with GitHub integration**  
  You connect your GitHub repo to a Develop Space. Builder then clones your main branch each time you launch or switch branches in the editor. When you merge a pull request, Builder fetches those changes automatically (and even deletes the old feature branch) so the Visual Editor stays in sync with your repo citeturn2search0.

**Bottom line:**  
- If you’re on the standard Builder.io plan, code stays local—Builder won’t pull your GitHub updates.  
- If you join Projects and hook up your repo, you get true two-way sync between VS Code ↔ GitHub ↔ Builder.

---

## User

If I set my .env file on builder.io and then I use the interact page to like log in, will it be able to interact with SupaBase if my SupaBase keys are in there?

---

## Assistant

Mr. White, Builder’s Interact pane simply frames whatever URL you’ve set as your “Preview” host—it doesn’t itself load your local .env. 

- **If your Preview URL points at your local dev server (e.g. http://localhost:3000)**  
  and you run `npm run dev` with a `.env.local` containing:  
  ```bash
  VITE_SUPABASE_URL=https://<your-project>.supabase.co
  VITE_SUPABASE_ANON_KEY=<anon-key>
  ```  
  then your Vue app will boot with those keys and the Interact page will be able to log in and fetch from Supabase just as if you’d opened localhost directly citeturn0search8turn0search3.

- **If your Preview URL is your deployed Vercel site**, you must add those same two vars in **Vercel → Settings → Environment Variables** (using `NEXT_PUBLIC_…` prefixes if you like) so that your build on Vercel injects them at compile time citeturn0search8.

- **Setting a .env in Builder.io’s dashboard** only feeds Builder Cloud Pages/Functions—it won’t magically inject into your front-end code. The Interact view never “reads” Builder’s Cloud secrets; it just pulls in your app from whatever host you’ve configured citeturn0search6.

**Bottom line:** give your Vue app access to Supabase via env on the host it’s actually running on (local or Vercel). Builder’s Interact will faithfully render it with whatever keys your app has available.


**Topic:** [[chatgpt-clusters/coding_devops]]


## See Also
- [[chatgpt/chatgpt_clerk-supabase-integration-audit]]
- [[chatgpt/chatgpt_clerk-supabase-integration]]
- [[chatgpt/chatgpt_supabase-swift-integration]]
- [[chatgpt/chatgpt_ai-command-palettes-integration]]
- [[chatgpt/chatgpt_analytics-integration-advice]]
