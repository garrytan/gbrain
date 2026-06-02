
Perfect—then let’s **lean into your current stack** and keep it agent-agnostic.

# Jovie Agent Control Plane — on Next.js + Supabase + Clerk + Vercel

## Architecture (minimal, scalable)
- **Next.js 14 (App Router)** on Vercel  
  - UI: Inbox/Kanban/Task detail (Linear-style) with **Tailwind v4**.  
  - **Server Actions/Route Handlers** for task CRUD and agent dispatch.
- **Supabase Postgres** (+ SQL migrations) for tasks, runs, usage, integrations.
- **Clerk** for auth/orgs/roles (Creator, Collaborator).
- **Background workflows:** **Inngest** (durable jobs, fan-out, retries, schedules).  
  - Alternative: Trigger.dev v3. Use one—don’t build your own queue.
- **LLMs:** Claude + OpenAI via server adapters (no LangChain unless needed).
- **3rd-party agents:** Opus Pro, Playground (thumbs), later: Hypefury/Typefully, etc.
- **Billing:** **Stripe Billing** (subscription) + **metered usage** (per agent run).  
  - **Stripe Connect** (Standard) to rev-share with agent vendors (optional in v2).
- **Observability:** Sentry (errors), PostHog (product), basic OpenTelemetry later.

## Data model (tables)
- `projects(id, org_id, name, …)`
- `tasks(id, project_id, type, status, title, payload_json, result_json, assignee_agent_id, created_at, updated_at)`
- `agents(id, org_id, provider, name, capabilities[], is_enabled, config_json)`  
- `agent_runs(id, task_id, agent_id, status, input_json, output_json, cost_cents, tokens_in, tokens_out, started_at, finished_at, error_text)`
- `integrations(id, org_id, provider, oauth_json, scopes[], created_at)`  // Opus, YouTube, etc.
- `usage_events(id, org_id, agent_id, quantity, unit, occurred_at, stripe_invoice_item_id)`  // feeds metered billing
- `audit_logs(id, org_id, actor_id, action, target_type, target_id, meta_json, created_at)`

> Add RLS: scope all rows to `org_id`. Log every agent action in `audit_logs`.

## Agent API contract (simple & future-proof)
**Internal TypeScript interface** every adapter must implement:
```ts
export type AgentRunInput = { taskId: string; orgId: string; payload: any };
export type AgentRunResult = { status: "succeeded"|"failed"; output?: any; costCents?: number; tokensIn?: number; tokensOut?: number; error?: string };

export interface AgentAdapter {
  id: string;                // "opus_pro", "gpt4o", "claude-3-5"
  capabilities: string[];    // ["repurpose_video","write_captions","generate_thumbnail"]
  run(input: AgentRunInput): Promise<AgentRunResult>;
  webhook?(req: Request): Promise<Response>; // for async providers (Opus)
}
```
- Store adapters in `src/agents/{provider}/adapter.ts`.  
- Dispatch via `registry[agentId].run()`; persist a row in `agent_runs`.

## Key flows

### 1) Text tasks (Claude/GPT)
- User creates task “Write 10 IG captions for {link} in my tone”.  
- `POST /api/tasks` → Supabase insert → **Inngest** job `agent.run` with `{agentId:"claude", payload}`  
- Adapter returns captions → persist `result_json` → task → **status=“review”**.

### 2) Opus Pro repurpose
- Task “Repurpose this YouTube URL into 5 shorts.”  
- `agent.run` posts to Opus API (async) → returns `run_id`.  
- Opus webhook → `POST /api/webhooks/opus` → look up `agent_run` → store assets (Supabase Storage / Mux) → update task to **review**.

### 3) Scheduling to platforms
- **YouTube**: official Data API (server-side, refresh tokens).  
- **IG/TikTok**: start with **export + reminder** (Buffer-style) until stable APIs or a partner integration.

### 4) Metered billing
- Each `agent_run` writes a `usage_events` row (`quantity` = tokens, seconds, or “runs”).  
- Nightly Inngest job aggregates → **Stripe Usage Records** on the customer’s subscription item.  
- For rev-share later: record vendor split on each `usage_event`.

## Route handlers (skeleton)
- `POST /api/tasks` (create)  
- `POST /api/tasks/:id/approve` • `/reject` • `/revise`  
- `POST /api/agents/:id/run` (manual trigger)  
- `POST /api/webhooks/opus` • `/stripe` • `/inngest`  
- `GET /api/analytics/snapshot` (views, clicks, revenue by agent)

## UI (Next.js App Router)
- `/(app)/inbox` — default list w/ quick actions (Approve/Reject/Revise).  
- `/board` — Kanban: **To Review → In Progress → Scheduled → Done**.  
- `/agents` — control panel: toggle agents, view usage & costs.  
- `/analytics` — weekly snapshot (views, CTR, revenue), breakdown by agent.  
- `/profile` — public profile editor (bio, links, featured content).

## Security & governance
- All agent runs **server-side**; never expose provider keys to client.  
- **Per-task audit trail** (prompt & output hashes; redact sensitive text).  
- **Vercel envs**: `NEXT_PUBLIC_` only for innocuous values.  
- **No-train** stance in ToS + data retention setting per org.

## Sprint plan (fast)
**Week 1**  
- App shell (Inbox/Board/Task). Clerk orgs. Supabase tables + RLS.  
- Claude & GPT adapters (caption task). Inngest wired.  
- Stripe: Basic subscription; plan gating.

**Week 2**  
- Opus Pro adapter (async webhook), Supabase Storage/Mux for previews.  
- Approve/Reject loop; scheduled jobs; YouTube posting.  
- Usage metering → Stripe Usage Records. Sentry/PostHog.

**Week 3**  
- Agent Control Panel (toggle, limits, cost caps).  
- Public profile v1 (clean link-in-bio).  
- 3 E2E Playwright tests:  
  1) Create→Run→Review (text)  
  2) Opus async round-trip  
  3) Approve→Schedule→YouTube post

**Week 4**  
- First 5 pilot creators; collect baseline: time saved, posts/week ↑, CPM uplift.  
- Polish: optimistic UI, keyboard actions, dark/light theme.

## Naming conventions & folders
```
/src/app/(app)/inbox/page.tsx
/src/app/api/tasks/route.ts
/src/app/api/webhooks/opus/route.ts
/src/agents/claude/adapter.ts
/src/agents/openai/adapter.ts
/src/agents/opus/adapter.ts
/src/lib/db.ts  // supabase server client
/src/lib/stripe.ts
/src/lib/inngest.ts
/src/lib/auth.ts // Clerk helpers
/src/server/actions/tasks.ts
```

## Guardrails you’ll thank yourself for
- **Cost caps per org & per agent** (env-configurable).  
- **Retry & dead-letter queues** in Inngest.  
- **Deterministic render recipes** stored on `agent_runs` (reproducibility).  
- **Human-in-the-loop default**: nothing auto-posts without approval (toggle later).

---

If you want, I can draft a **minimal schema.sql** and the **Inngest `agent.run`** job (TS) tailored to Supabase so you can paste it in and boot the MVP.


Should we use upstach?


Short answer: **yes, but for the right jobs.**

Use **Upstash Redis** alongside your stack for:
- **Rate limiting & quotas** per org/agent.
- **Ephemeral caches** (agent results, previews, analytics shards).
- **Idempotency keys / dedup** for task runs & webhooks (Opus, Stripe).
- **Lightweight queues** (retry a few times, <24h retention).

Avoid using it as your **primary workflow engine**. Keep **durable, multi-step orchestrations** in **Inngest (or Temporal later)** so you get retries, schedules, and audit trails.

If you need a cheap event bus later, **Upstash Kafka** can fan out events (e.g., `task.created` → analytics/update/search), but don’t overbuild on day one.

**Recommended split**
- Upstash Redis: rate limits, caches, idempotency, short queues.
- Inngest: agent runs, webhooks → jobs, retries, schedules, DLQs.
- Supabase: source of truth (tasks, runs, usage, billing records).

This plays perfectly with **Next.js + Vercel** (edge-friendly, low latency) without locking you into Redis for things it’s not built to do.


{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000d5a461f6a4158a90ca5024c6', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:47:27.661084+00:00', 'format': 'wav', 'metadata': {'end': 193.74, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 9299598, 'tool_audio_direction': None}, 'audio_start_timestamp': 203.09159583086148, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-20T19:47:27.661084+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}
{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Okay, so then, as we're thinking about, um, as we're thinking about this, then I'm like, does it make sense for, um, does it make sense for us to, like, um, does it make sense for me to... What am I trying to say? What am I trying to say? What am I trying to say? What am I trying to say? What am I trying to say? What am I trying to say? Um, oh, so, like, all right, so then, basically, in my mind, you've got, like, this very clean, modern-looking interface where, like, you have a dashboard that looks, like, linear and a public profile that looks very clean. We already kind of have a design for it, um, and, you know, you log into your dashboard and you can kind of, like, see some analytics. Like, I'd probably then want this to be, like, your dashboard to be, like, kind of your heads-up display for your KPIs for your career, right? Like, like, maybe I want to log into my dashboard and I want to see what are my follower counts on all my social networks and are they going up or are they going down? Are they increasing or decreasing? Um, and then maybe I want to see what are my, um, what are my, like, what's my, I mean, my KPI should be revenue for my career. Is my money going up or down? Um, uh, you know, in my, in, uh, um, and then, you know, it becomes a thing of, like, um, you know, am I making more money today than I was yesterday? Have my, you know, and I, and maybe we plug into our Shopify account and see if our Shopify sales are going up for merch. Maybe we plug in and we see are my ticket sales going up. Maybe we plug in and we see are my whatever, whatever. And so that's kind of like your, like, heads-up display. It's your home dashboard that you want to log into every day and, like, see, like, what your career is doing. Then you have your, like, agents screen where, like, it's like, okay, now let's deploy our AI agents and stuff. And then we can see, like, what tasks they've been working on and stuff. And the AI agents don't necessarily have to be AI. Maybe they could be humans too, right? So maybe we could deploy a task that's like, oh, I have a task for a video editor. And you can, you know, deploy that task. And then do we, do we allow video editors to sign up to the platform and get, like, jobs? You know what I mean? Do we, do we have, like, thumbnail? Like, are we almost like a fiber then for, like, allowing you to create these tasks and stuff and manage operationally? Like, I don't know. You know what I mean? Like, that's kind of where my brain's going now."}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Absolutely, Mr. White. You’re thinking in a really powerful direction here. Let’s break it down.\n\n---\n\n### Vision: The Creator’s Mission Control Center\n\n**1. Career Dashboard as a Heads-Up Display**  \nThink of it like a command center for a creator’s whole career. You log in and immediately see all your key metrics in one clean place:\n- **Social growth**: Followers on each platform going up or down.\n- **Revenue streams**: Shopify merch sales, ticket sales, subscription earnings, all in one view.\n- Basically, a **one-stop career health check** so you know exactly where you stand.\n\n---\n\n**2. Task & Agent Deployment**  \nFrom that same dashboard, you’ve got a tab or screen to **deploy agents**—whether they’re AI or human.\n- For AI tasks: Write a caption, generate a thumbnail, repurpose a video.\n- For human tasks: Maybe you pull in freelance video editors, thumbnail creators, or other creators who want to take on gigs. It’s like a **tiny, focused Fiverr inside your platform**, but integrated into your workflow.\n\n---\n\n**3. Blurring the Lines Between AI and Human Help**  \nYou’re right on the money: you don’t have to limit yourself to just AI. You can let users deploy a mix of agents. Over time, you could even build out a marketplace of both AI tools and human freelancers, all managed from the same simple dashboard.\n\n---\n\n**4. Creator OS Meets Talent Network**  \nIn essence, you’re building a **Creator OS that’s part mission control, part agent hub, and part talent marketplace**. Creators log in to see their numbers, then deploy agents (AI or human) to tackle tasks, and keep everything humming.\n\n---\n\n**5. Defensible Niche and Scalable Vision**  \nBy starting in the creator space, you get a huge, fast-growing market that loves easy, integrated tools. Once you have that foothold, you can expand the model to other verticals. Maybe it’s post-production down the line, maybe it’s something else.\n\n---\n\nSo yes, that’s a solid direction. You start with a **Linear-style dashboard** for creators, plug in AI agents like Claude or GPT, and later open the doors to human freelancers and other integrations. It’s a strong, scalable idea.'}
{'asset_pointer': 'sediment://file_00000000f59061f6836a8260faceadd0', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:47:27.661149+00:00', 'format': 'wav', 'metadata': {'end': 101.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 4850478, 'tool_audio_direction': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Well, and then, and then I'm like thinking about it, like, it's like you're kind of almost like Upwork, right? Like on Upwork, I can like request a bunch of freelancers to work on projects for me and stuff. And as a creator, I've previously used Upwork in this manner. Like I've hired retouchers on Upwork to like retouch my photos. Then I've hired like a personal assistant to go through and comment back to all of the like comments on my posts and stuff as me. And I've like kind of done all of these different things, right? Hired video editors to edit YouTube videos. I've hired, I've hired people to like make short form videos out of my YouTube videos. I've hired people to, you know, do some like social media marketing for stuff. And I've done this all on Upwork and it kind of like sucks because it's like you have to make a job and each job is like a whole process just to create a job. You know what I mean? And then, and then you have to put a budget in for that job and you have to pay per job. And it's like, it kind of sucks. And if that was like even just as Upwork, even just with humans, like if you just made Upwork as easy to use as Linear where I can just be like, hey, I need this fucking, I need this photo retouched, you know, and then boom, click a button. And like, yeah, you can click a button to have like, you know, GPT-5, break it out into subtasks and describe it at scale. And then, you know, I hit a button and I deploy a human to work on this thing. You know what I mean?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000050a461f6a87a9fd09f72ddc7', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:50:12.940029+00:00', 'format': 'wav', 'metadata': {'end': 115.69, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 5553198, 'tool_audio_direction': None}, 'audio_start_timestamp': 423.18889315985143, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-20T19:50:12.940029+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Absolutely, Mr. White. You’re zeroing in on a really compelling simplification. If you take that “Upwork but as easy as Linear” concept and blend it into your Creator OS, you get something really powerful.\n\n---\n\n### The Evolution: Linear-Easy, Upwork-Flexible\n\n**1. One-Click Human Tasks**  \nRight now, hiring on platforms like Upwork is a whole production: you write a job post, set a budget, sift through proposals, and it’s just not streamlined. If you make it as simple as clicking a button in your Linear-style dashboard, you turn that into a seamless experience. Just like you’d deploy an AI agent, you could deploy a human retoucher or video editor with a click.\n\n**2. No Need for Full Job Posts**  \nInstead of creating a full job listing, you’d just define a quick task: “Retouch this photo,” “Edit this 60-second clip,” and the platform handles the rest. It’s all about making it feel like managing tasks rather than hiring jobs.\n\n**3. Hybrid Talent Pool**  \nYou’d have a pool of both AI and human “agents,” and creators just choose the best tool'}
{'asset_pointer': 'sediment://file_000000008db461f6927196c17bd9341a', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:50:12.940095+00:00', 'format': 'wav', 'metadata': {'end': 46.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 2232078, 'tool_audio_direction': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': ''}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000037b461f6b2b763c4f697fa58', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:50:46.625637+00:00', 'format': 'wav', 'metadata': {'end': 0.71, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 34158, 'tool_audio_direction': None}, 'audio_start_timestamp': 473.64681645692326, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-20T19:50:46.625637+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Exactly—you’re spot on with that thinking. Essentially, you’d be creating a hybrid platform that feels as intuitive as Linear but as flexible as Upwork. Instead of job posts feeling like a whole ordeal, it’s just adding a task to your queue. Then you click to assign it out to either an AI or a freelancer and get the results without the overhead.\n\nSo yeah, it’s a super strong concept: a Creator OS where you have a single dashboard to monitor your growth, deploy tasks, and leverage both AI and human talent on demand. It’s like turning your creator workflow into something as smooth as managing a to-do list.'}
{'asset_pointer': 'sediment://file_00000000bdfc61f68a09d756db04dc78', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:50:46.625719+00:00', 'format': 'wav', 'metadata': {'end': 29.95, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1437678, 'tool_audio_direction': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'Is there a pre-existing, like, human API that has creative skills or whatever or VA skills that we could tie into this, like Mechanical Turk or, like, I know ScaleAI kind of did a little bit of this?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000c0c861f6965049cf2f98d78d', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:53:11.776850+00:00', 'format': 'wav', 'metadata': {'end': 18.94, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 909198, 'tool_audio_direction': None}, 'audio_start_timestamp': 598.145275706891, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-20T19:53:11.776850+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Yeah, there are definitely some options you could tap into. One that comes to mind is Amazon Mechanical Turk, which is sort of the classic "human API" for microtasks. It’s more generic and not necessarily tailored specifically to creative skills, but you can use it to get humans to do all sorts of tasks. \n\nThere are also other platforms like Fiverr or Upwork that have APIs or integrations you could potentially hook into, though they might require a little more orchestration on your end. \n\nAnd then there are newer, more niche services. Some startups are building APIs specifically for hiring virtual assistants or creatives on demand. You could consider something like Scale AI, which originally started in data labeling and has expanded into more task-based human-in-the-loop services. \n\nSo, yes, there are definitely existing “human APIs” you could integrate, and you could leverage those to quickly add a human layer to your platform without having to build out your own full freelancer network from scratch.'}
{'asset_pointer': 'sediment://file_00000000ef2c61f69e2a3b2e61513dea', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:53:11.776919+00:00', 'format': 'wav', 'metadata': {'end': 50.9, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 2443278, 'tool_audio_direction': None}


{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000316461f6a21184d5f953650d', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:59:00.262178+00:00', 'format': 'wav', 'metadata': {'end': 221.0, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 10608078, 'tool_audio_direction': None}, 'audio_start_timestamp': 885.235886601964, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-20T19:59:00.262178+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}
{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "And what do we think about, like, um, in terms of, like— Okay, so there's something there. I think we're circling good ideas. I think we're going to—we're onto something, and we're starting to think in the right direction, and we've kind of got to just, like, figure out what— what—how to—how to get this in— how to quickly experiment with this and get it in front of people and figure out which things are going to work. But just one thing that I'm thinking about is, like, still I think the MVP to build this, I think, is still, you know, just a basic link in bio. And you get your profile, and then you get a dashboard. For the link in bio, I'm like, you know, just for the onboarding, I'm trying to think about it as, like, does it make more sense for the onboarding to be, like, you kind of, like, talking to a chat bot, like a ChatGPT interface, and it being like, hey, what's your name? What's your—you know, tell me briefly about what you do. And you're like, oh, I'm a comedian, or oh, I make music, you know. And then it's like, great, and then it labels you as an artist, a music artist, you know, or it labels you as a comedian. Or it's like, oh, I make videos on YouTube, and it's like, oh, you're a digital creator, you know. And then it, like, asks you, like, you know, what's your— you know, where do you make your content, or what's your, you know, whatever. And it, like, you know, kind of, like, starts to pull in some of this stuff and populate your profile for you. Is that a better onboarding experience than giving them, like, what we currently do, which is, like, hey, claim your handle. Hey. You know, and then show them, basically, an unpopulated profile and allow them to open it. And then, like, later we might do, like, import of stuff from social media. Or what's the—like, what's a good move here? I've also thought about, like, if they put in their Instagram handle, we do have a universal link thing where, like, if they start typing Instagram, we suggest that it's an Instagram link, detect it's an Instagram link, and then automatically categorize it as such. If they put in, like, an Apple Music link, then we automatically detect that as a music DSP. And then, again, it's categorized as such. And so if it's on the profile, it's now going to display in a different place than if it was a social link. And we're doing that. But, like, is it—I'm also wondering if it's, like, you know, if they put in their Instagram link, do we then go out to Instagram, grab their profile photo, and add it to the profile immediately if their profile currently doesn't have a photo on it? Do we then, like, grab their website from the link in their Instagram and, like, have it, like, suggest add website as a link or something, question mark? You know, like, stuff like that. Like, what—give me some ideas. Give me what do you think is going to be the best and convert the best."}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Absolutely, Mr. White. I think you’re onto something that could really boost your onboarding and conversion rates. Let’s break it down.\n\n---\n\n### Conversational Onboarding vs. Form-Based Onboarding\n\n**Conversational Onboarding (Chatbot Style)**\n\n- **Pros:** It’s super engaging. If you have a little “chat” that asks, “Hey, what’s your name?” and “Tell me about what you do,” it feels more personal and interactive. People love feeling like they’re having a conversation. It can also help you automatically categorize them—“Oh, you’re a music artist!”—and then pre-fill their profile accordingly.\n\n- **Cons:** Some users might prefer a quick form they can just fill out in one go. Also, if the chat flow gets too long, they might drop off. You have to keep it snappy.\n\n**Form-Based Onboarding (What You Have Now)**\n\n- **Pros:** It’s straightforward and familiar. People know how to fill out a form. If you keep it short and sweet, it’s easy. They pick a handle, see a preview, and they’re done.\n\n- **Cons:** It can feel a little less personal. It might not auto-categorize them as intuitively, and they might have to do more manual setup later.\n\n---\n\n### Hybrid Approach: Best of Both Worlds\n\nWhy not mix them? You could have a super lightweight conversational flow at the start—just a few fun questions to break the ice—and then drop them into a simple form to fine-tune details. That way you get the engagement of a chat and the efficiency of a form.\n\n---\n\n### Smart Data Pulling and Autofill\n\n**Auto-Detect and Autofill:** If they paste in their Instagram handle, absolutely go ahead and pull their profile photo to fill in the blank. Same with links—if you recognize it’s a YouTube or Apple Music link, categorize it instantly. The less they have to manually configure, the better.\n\n**Suggest Links from Their Socials:** If you pull their website from their Instagram bio and suggest it as a link, that’s a great touch. It makes them feel like, “Oh, this platform is doing the work for me,” which is always a good feeling.\n\n---\n\n### What Converts Best?\n\nTypically, the highest conversions come from a mix of making it feel personal and reducing friction. A short, friendly chat to get them started, combined with smart autofill and suggestions, will likely convert better than just a plain form. It shows you’re paying attention to who they are, makes the process feel effortless, and gets them to that “aha” moment faster where their profile looks great without them doing a ton of work.\n\n---\n\nIn short: a light conversational onboarding flow, smart auto-detection of links, and auto-populating their profile from existing social data is probably the best combo. It feels magical and easy, which is exactly what you want.'}
{'asset_pointer': 'sediment://file_00000000209461f6bdd6a5a35a0e3c71', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-20T19:59:00.262244+00:00', 'format': 'wav', 'metadata': {'end': 109.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 5256078, 'tool_audio_direction': None}


Take our mvp of ai agents in jovie and spin it up into a ai prompt to build the whole mvp


Got it, Mr. White. Here’s a **copy-paste, single prompt** you can drop into a capable coding agent to build the MVP exactly as we defined (Next.js + Supabase + Clerk + Stripe + Inngest, with Claude/GPT adapters and Opus Pro integration). It’s explicit, testable, and production-lean.

---

# BUILD THIS MVP

## Product
“**Jovie — Linear for Creators**”: a clean dashboard where creators run their career.  
MVP = Linear-style **Inbox/Board/Task** + **Agent runs** (Claude/GPT + Opus Pro) + **Public Profile (link-in-bio 2.0)** + **Usage-metered billing**.

## Tech Stack
- **Next.js 14 (App Router) + TypeScript + Tailwind v4** on **Vercel**  
- **Clerk** (auth, orgs)  
- **Supabase Postgres** (RLS) + **Supabase Storage**  
- **Inngest** (durable background jobs, retries, schedules)  
- **Stripe Billing** (subscriptions + metered usage)  
- **Sentry** (errors), **PostHog** (product analytics)  
- Optional: **Upstash Redis** for rate limits/idempotency

## ENV VARS (placeholder names)
```
# Next/Infra
NEXT_PUBLIC_APP_URL=
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
INGEST_SIGNING_KEY=
SENTRY_DSN=
POSTHOG_API_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# LLMs
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Integrations
OPUS_API_KEY=
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=
```

## App Structure (folders)
```
/src/app/(app)/inbox/page.tsx
/src/app/(app)/board/page.tsx
/src/app/(app)/tasks/[id]/page.tsx
/src/app/(app)/agents/page.tsx
/src/app/(app)/analytics/page.tsx
/src/app/(app)/profile/page.tsx
/src/app/(public)/[handle]/page.tsx   // public profile

/src/app/api/tasks/route.ts            // POST create
/src/app/api/tasks/[id]/approve/route.ts
/src/app/api/tasks/[id]/reject/route.ts
/src/app/api/tasks/[id]/revise/route.ts
/src/app/api/agents/[agentId]/run/route.ts
/src/app/api/webhooks/opus/route.ts
/src/app/api/webhooks/stripe/route.ts
/src/app/api/analytics/snapshot/route.ts

/src/agents/registry.ts
/src/agents/openai/adapter.ts
/src/agents/anthropic/adapter.ts
/src/agents/opus/adapter.ts

/src/lib/auth.ts
/src/lib/db.ts
/src/lib/inngest.ts
/src/lib/stripe.ts
/src/lib/redis.ts

/src/server/actions/tasks.ts
/src/server/actions/agents.ts

/src/styles/tailwind.css
```

## Database Schema (Supabase SQL)
```sql
-- orgs & users come from Clerk; store org_id (text) references Clerk
create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  name text not null,
  created_at timestamptz default now()
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  provider text not null,          -- "openai","anthropic","opus"
  name text not null,
  capabilities text[] not null,    -- e.g. {"write_captions","repurpose_video"}
  config_json jsonb not null default '{}',
  is_enabled boolean not null default true,
  created_at timestamptz default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  org_id text not null,
  type text not null,              -- "caption","thumbnail","repurpose_video"
  title text not null,
  status text not null default 'inbox',  -- inbox, in_progress, review, scheduled, done, failed
  payload_json jsonb not null default '{}',
  result_json jsonb,
  assignee_agent_id uuid references agents(id),
  cost_cents int default 0,
  created_by text,                 -- clerk user id
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id uuid not null references agents(id),
  status text not null default 'queued',    -- queued, running, succeeded, failed
  input_json jsonb not null,
  output_json jsonb,
  tokens_in int default 0,
  tokens_out int default 0,
  cost_cents int default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_text text
);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  provider text not null,  -- "youtube","opus","playground"
  oauth_json jsonb,
  scopes text[],
  created_at timestamptz default now()
);

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  agent_id uuid,
  task_id uuid,
  quantity numeric not null,       -- tokens, seconds, runs
  unit text not null,              -- "tokens","seconds","runs"
  occurred_at timestamptz not null default now(),
  stripe_invoice_item_id text
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  actor_id text,
  action text not null,            -- "task.create","task.approve","agent.run"
  target_type text not null,       -- "task","agent","integration"
  target_id text not null,
  meta_json jsonb,
  created_at timestamptz default now()
);

-- RLS: enable and restrict by org_id on all tables
```

## RLS Policy (describe)
- Enable RLS; for each table allow `select/insert/update` where `org_id = auth.org_id()`; expose a Postgres function `auth.org_id()` from Clerk JWT claim. (Add a Supabase “JWT custom claim” mapping to Clerk org id.)

## Agent API Contract (TypeScript)
```ts
export type AgentRunInput = { taskId: string; orgId: string; payload: any };
export type AgentRunResult = {
  status: "succeeded" | "failed";
  output?: any;
  costCents?: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
};

export interface AgentAdapter {
  id: string; // "gpt4o" | "claude-3-5" | "opus"
  capabilities: string[];
  run(input: AgentRunInput): Promise<AgentRunResult>;
  webhook?(req: Request): Promise<Response>; // for async providers (Opus)
}
```
- Registry at `src/agents/registry.ts` exports a map `{ [id]: AgentAdapter }`.

## Required Agents (MVP)
1) **Claude or GPT** (“write_captions”)  
- Input: `{ topicText?: string, brandTone?: string, link?: string, count: number }`  
- Output: `{ captions: string[] }`  
- Cost: estimate via tokens.

2) **Opus Pro** (“repurpose_video”)  
- Input: `{ youtubeUrl?: string, fileId?: string, clips: number, style: "default" | "subtitled" }`  
- Async webhook returns signed URLs to clips; store in Supabase Storage (or Mux) and attach to `result_json`.

## Routes & Flows

### Task Create
- `POST /api/tasks` → validate payload, insert row, enqueue Inngest job `agent.run` if `assignee_agent_id` present.  
- Log to `audit_logs`.

### Agent Run (Inngest)
- Load adapter via registry.  
- Mark `agent_runs.status="running"`, call `run()`.  
- On success: write `output_json`, update `tasks.result_json`, `status="review"`, add `usage_events` with unit `tokens` or `runs`.  
- On failure: set `status="failed"`, persist `error_text`.

### Approve/Reject/Revise
- `POST /api/tasks/:id/approve` → if schedulable, move to `scheduled`; otherwise `done`.  
- `reject` → back to `inbox` with reason; `revise` → enqueue new `agent.run` with feedback.

### Opus Webhook
- Verify signature if available.  
- Match `agent_run` by external id; store assets; update task to `review`.

### Stripe Billing
- Plans: **Starter ($19/mo)**, **Pro ($49/mo)**; both allow metered usage.  
- Each `usage_events` row → nightly Inngest aggregator creates **Stripe usage records**.  
- (v2) Stripe Connect split to partner agents.

## UI Requirements

### Global
- Linear-clean, keyboard shortcuts, optimistic updates.

### Pages
- **/(app)/inbox**: list of task cards with quick actions (Approve/Reject/Revise).  
- **/board**: Kanban columns = *To Review → In Progress → Scheduled → Done*.  
- **/tasks/[id]**: left = details & history; right = outputs (captions or video previews).  
- **/agents**: list of installed agents, usage this month, toggle, config.  
- **/analytics**: “Daily Snapshot” KPIs: posts scheduled, fan replies (placeholder), views by platform (placeholder), revenue from Stripe/Shopify (stub).  
- **/profile**: editor for public profile (title, bio, avatar, links).  
- **/(public)/[handle]**: public page (bio, hero, featured links), ultra fast.

### Onboarding (hybrid)
- Step 1: conversational quick setup (name, role: “artist/comedian/creator”), then  
- Step 2: form to add links; auto-detect platforms; auto-pull avatar if missing; suggest “Add website from Instagram bio?”  
- End by pre-creating a demo task: “Draft 10 IG captions about my latest post.”

## Public Profile Behavior
- Paste any link → auto classify: social vs music DSP vs video.  
- Auto-fetch OG image & favicon; if Instagram supplied and profile empty, pull avatar and suggest bio.

## Analytics Snapshot API
- `/api/analytics/snapshot` returns mock data initially; design types for future Shopify/YouTube/TikTok connectors.

## Security & Governance
- All provider keys server-side only.  
- Per-task audit trail (include prompt/response hashes; store raw in `result_json`, but redact in logs).  
- Rate limits per org/agent via Upstash Redis (e.g., 60 runs/hour).  
- Idempotency keys on `agent_runs` and webhooks.

## Tests (Playwright)
1) Create text task → agent run → review → approve (happy path).  
2) Opus async round-trip: create, receive webhook, preview clips, approve.  
3) Billing meter: run agent twice → verify `usage_events` aggregated to Stripe usage record (mock stripe).

## Acceptance Criteria
- A creator can sign up, create a project, add a task, run Claude/GPT to generate captions, review/approve.  
- A creator can run Opus repurpose via URL, receive 3–5 clips, preview in task detail, approve.  
- Metered usage records get written to Stripe on a schedule.  
- Public profile is live, loads fast, and shows categorized links.  
- Basic snapshot shows weekly counts and deltas.

## Nice-to-Have (not blocking)
- YouTube scheduling auth flow.  
- Dark/light theme toggle.  
- Keyboard “/” to create task anywhere.

## Out of Scope (MVP)
- IG/TikTok auto-posting (export + reminder only).  
- Agent marketplace UI (hard-code Opus + Claude/GPT).  
- Team roles/permissions beyond org owner/collab.

---

**Build all of the above.**  
If something is ambiguous, choose the simplest, production-sane default and proceed.


## See Also
- [[chatgpt/chatgpt_ai-problem-solving-markets-part1]]
- [[chatgpt/chatgpt_ai-problem-solving-markets-part2]]
- [[chatgpt/chatgpt_ai-problem-solving-markets-part3]]
- [[chatgpt/chatgpt_ai-problem-solving-markets-part5]]
- [[chatgpt/chatgpt_solving-package-theft-impersonation]]
