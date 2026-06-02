---
title: "YC Application Strategy Review"
type: essay
created: 2026-04-23
updated: 2026-04-23
source: chatgpt-export
conversation_id: 69ea92b3-998c-83e8-a79d-24dbf2453393
message_count: 4
tags: [chatgpt, import, long-form]
---
# YC Application Strategy Review

> Conversation ID: 69ea92b3-998c-83e8-a79d-24dbf2453393
> Created: 2026-04-23T21:44:23Z
> Updated: 2026-04-23T21:51:59Z
> Messages: 4

---

## User

It's April 23. May 4 is the deadline for our YC application. We absolutely have to get in to survive. Please review our repo and our application and provide an actionable list of everything I should do right now to maximize our chances with YC. I have access to substantial free AI leverage, including ARAMIS agents, plus Claude Code running agent teams, swarming, and more. We have free usage to burn over the next 24 hours, so anything we can do to deploy those agents, whether it’s acquiring customers, writing code, finding investors, rewriting the YC application, or working on design, please detail.

Please provide the actionable list here and audit yourself afterward, identifying flaws in the plan and auditing it four times with adversarial hats:

1) As if you’re just another AI like Claude Code evaluating it  
2) As if you’re Gary Tan  
3) As if you’re Paul Graham  
4) As if you’re Harge  

Loop on all those evaluations until each persona gives the plan a 9/10 or higher.

---

## Assistant

I’ll treat this as a 24-hour YC triage: use current YC guidance and any accessible project context, be explicit if repo/application artifacts aren’t visible, then produce a ranked execution plan with adversarial audits.

---

## Assistant

I found public Jovie repo/site signals and current YC timing, but no application draft. Early repo read suggests real velocity, with a risk of scattered execution and overpromised positioning.

---

## Assistant

I could not retrieve a YC application draft from the attached/connected context, so I cannot line-edit your exact answers. I did review the public repo, live site, investor content in the repo, current YC application guidance, and your known Jovie context. The plan below is optimized for the next **24 hours**, then the **11 days until the May 4, 8pm PT on-time YC Summer 2026 deadline**. YC says Summer 2026 runs July–September in San Francisco, on-time applicants get decisions by June 5, most interviews happen in May/June, and YC invests as soon as companies are accepted. citeturn784350view0

## The core move

Stop trying to look more polished. Spend the next 24 hours creating **new evidence that Jovie is a real, fast-moving, customer-pulled startup**.

YC’s own interview guide says the best edge is not rehearsal, but making visible progress between application and interview: launching, improving product, increasing revenue, and knowing your users and metrics cold. citeturn815904view1 Paul Graham’s YC application advice is also directly relevant: the first sentence must be simple, clear, and matter-of-fact; specificity beats marketing language. citeturn479441view0

Your current external positioning undersells the company. The live site says “The link your music deserves” and frames Jovie as streams, drops, tips, bookings, and fan capture in a single page. citeturn496702view0 The repo README similarly describes Jovie as “a modern artist profile and link-in-bio platform.” citeturn345001view0 But the strongest internal memo says Jovie is much more: artists connect Spotify once; Jovie detects new releases, generates smart links, captures fans into CRM, sends release notifications, generates playlist pitches, and accumulates career context. citeturn124205view0

That mismatch is the biggest fix.

Your YC application should not say “link-in-bio for artists.” It should say:

> **Jovie is an AI manager for independent music artists. Artists connect Spotify once; Jovie detects new releases, generates smart links, captures fans, sends release notifications, and drafts release-promo work automatically.**

That is narrower, clearer, more ambitious, and more defensible.

---

## Do this in the next 24 hours

### 1. Freeze all non-YC-critical coding immediately

Your repo shows a lot of execution velocity: 5,506 commits, 145 open issues, and 26 open PRs. citeturn345001view0turn543136view0 That is good, but right now it is also dangerous. The open PR list includes useful fixes, but also command palette work, reels work, UI refactors, CI timeout changes, font sweeps, and design-token sweeps. citeturn543136view0 None of those materially increase YC odds unless they unblock onboarding, revenue, metrics, demo reliability, or customer acquisition.

For the next 24 hours, agents may only work on:

1. production blockers;
2. onboarding and claim flow;
3. analytics/traction extraction;
4. homepage and YC copy;
5. customer acquisition;
6. demo polish.

Everything else gets labeled `defer-until-after-yc`.

### 2. Define one YC-grade traction metric and extract it today

Paul Graham says the one number every founder should know is the growth rate, and that revenue is the best metric; active users are next best if you are not charging yet. citeturn479441view1

Create a private “YC Metrics” dashboard or even a simple spreadsheet today with:

| Metric | Why it matters | Source |
|---|---:|---|
| Claimed artist profiles | Core activation | DB |
| Artists active in last 7 days | Real usage | app events |
| Releases detected automatically | Product value | release/discog tables |
| Smart links generated | Automation proof | DB |
| Fan subscribers captured | Distribution proof | notification tables |
| Release notifications sent/opened | Retention/value | notification/email logs |
| Paying artists / LOIs | Revenue pull | Stripe + signed docs |
| Time saved per release | Customer pain | user interviews |
| Weekly growth rate | YC-relevant growth | computed |

Do not submit vanity metrics like “commits,” “stars,” “AI agents used,” or “profiles generated” unless they tie to real artists and real usage. GitHub stars are currently zero, which is not a problem, but it means the story must be customer pull, not developer community pull. citeturn496702view3

### 3. Run a founder-led customer sprint, not an agent-led spam sprint

Your repo’s GTM memo says the fastest channel is Tim’s music-industry network, including 190K Instagram followers, 500+ live performances, and credibility in electronic music. citeturn124205view1 Use that.

The target for the next 24 hours:

| Outcome | Minimum | Strong |
|---|---:|---:|
| Artists personally contacted | 100 | 250 |
| Warm founder DMs sent by Tim | 50 | 100 |
| Calls booked | 10 | 25 |
| Artists onboarded | 5 | 15 |
| Artists paying or signed LOI | 2 | 5 |
| Written testimonials/case notes | 3 | 10 |

Agents should research, prepare, and draft. Tim should send. YC will care that the founder can get users directly.

Use this outreach message:

> I’m building Jovie, an AI manager for independent artists. You connect Spotify once, and every new release gets detected automatically, turned into a smart link, added to your fan CRM, and queued for release notifications/promo work.  
>   
> I’m onboarding 20 artists manually this week before our YC deadline. I’ll build your release page and import your catalog free today. If it saves you time, paid plans will be $39–$99/mo later. Want me to set yours up?

Do not ask for “feedback.” Ask to onboard them.

### 4. Create a concierge onboarding factory

Use agents to build profiles for specific artists before they reply. This creates a much stronger sales motion: “I already made this for you.”

Agent workflow:

1. Find artists with recent or upcoming releases.
2. Gather Spotify/Apple/YouTube/Bandcamp/SoundCloud/Instagram links.
3. Generate a Jovie profile draft.
4. Create a private preview.
5. Write a personalized DM: “I made this for your latest release.”
6. Track reply, claim, usage, and objections.

Prioritize artists who are already paying for fragmented tooling: bio-link tools, smart-link tools, or marketing plugins. Your own GTM memo says this is the right outbound wedge. citeturn124205view1

### 5. Fix the live demo path before adding features

YC may ask for a demo; their guide says to have a working version ready and loaded. citeturn815904view1 Your demo should be one continuous story:

1. artist signs up;
2. connects/imports catalog;
3. Jovie detects a release;
4. Jovie generates smart links;
5. fan subscribes;
6. artist sees captured fan and release analytics;
7. Jovie drafts next action, such as playlist pitch or release notification.

The repo already has the relevant technical surface: creator profiles, social links, click events, tips, notification subscriptions, RLS, analytics, Stripe, Statsig, Sentry, Vercel, and production smoke checks. citeturn496702view1turn496702view2 Your open issues show demo-risk bugs around onboarding fallback, XAI API key, `/api/chat`, Clerk middleware, cron query failures, missing notifications page selector, rollback errors, and ISRC misses. citeturn564635view0 Those outrank all aesthetic work.

P0 fixes for agents:

| Priority | Task | Why |
|---|---|---|
| P0 | Fix `/api/chat` auth/API-key fail-soft behavior | AI demo cannot hard-fail |
| P0 | Fix Clerk middleware matcher for POST `/api/chat` | auth bug in demo path |
| P0 | Fix dashboard-to-onboarding redirect loop | onboarding trust killer |
| P0 | Fix failed cron query on `discog_releases` | release automation story depends on this |
| P0 | Add fallback UX when Deezer/MusicBrainz miss ISRC | avoids “Jovie is wrong” moment |
| P0 | Verify claim/signup/profile flow in production | YC may click it |

### 6. Rewrite homepage and README to match the YC story

Current public copy makes Jovie sound like a better Linktree for music. That is a crowded lane. Laylo already positions around drops, owned audience, fan messaging, and reports 10,000+ artists/creators; Linkfire offers bio links, pre-saves, ticket links, music release links, and reward links; Feature.fm offers smart links, pre-saves, bio links, contests, tour links, and fan-base management. citeturn981549search0turn981549search1turn981549search2

Your wedge should be:

> **Jovie is release infrastructure that becomes an AI manager.**

Homepage hero replacement:

> **Your AI manager for every music release.**  
> Connect Spotify once. Jovie detects new releases, generates smart links, captures fans, sends notifications, and drafts the promo work artists usually do manually.

Secondary line:

> Built for independent artists who need a team before they can afford one.

Do not lead with “link-in-bio.” Say that profiles and smart links are the wedge.

### 7. Write the missing AI memo today

The repo’s investor AI memo currently says only “Coming soon.” citeturn124205view2 That is a red flag because the company’s strongest pitch is now AI/agentic automation.

The memo should be one page:

**Title:** How Jovie uses AI  
**Thesis:** Music creation is increasingly abundant; post-creation coordination is the bottleneck.  
**Today:** deterministic automation around release detection, smart links, fan capture, release notifications, playlist-pitch drafting.  
**Next:** role-based agents: publicist, booking intake, release coordinator, visual asset assistant, fan CRM assistant.  
**Moat:** artist career context: discography, audience, fan interactions, collaborators, release history, conversion data.  
**Trust:** every agent action is logged, explainable, reversible, and artist-approved for external actions.

YC’s Spring 2026 RFS says AI-native companies can now be built faster, cheaper, and with more ambition, and specifically calls out AI-native systems and AI-native agencies that deliver finished work rather than just tools. citeturn225512view0 Jovie should ride that thesis without sounding like “AI wrapper for music.”

### 8. Record a brutally simple 90-second demo video

Do not make a polished commercial. Record a founder screen-share:

Script:

> “Jovie is an AI manager for independent artists. The problem is that artists need a manager, publicist, CRM, smart-link tool, and release coordinator before they can afford any of them.  
>   
> Here’s the product. I connect/import an artist. Jovie detects their releases. It generates a release page and smart links. Fans subscribe here. The artist sees fan capture and release activity here. Jovie drafts the next promo step here.  
>   
> I built this because I spent 15 years as an artist and learned that the creative work is not the bottleneck. The manual release work is. We’re onboarding artists now and charging $39–$99/mo.”

Then show one real artist profile, one release, one subscriber capture, one dashboard view, and one automation.

### 9. Convert survival panic into a credible financing story

Do not write “we need YC to survive.” That is a negative signal. Write:

> “We have a lean runway and are using YC as an accelerant. In the next 30 days, our goal is to convert the first cohort of independent artists into paying users and prove that release automation drives retention.”

In parallel, run a bridge process, but keep it lightweight:

1. list 50 music/creator/AI angels;
2. identify warm paths;
3. send 15 high-quality updates;
4. ask for $100k–$250k SAFE bridge or intros;
5. do not let investor outreach displace customer work.

YC is much more likely to fund a founder who will survive regardless of YC.

---

## Agent deployment plan for the next 24 hours

Use your AI leverage, but constrain it. Your repo already supports parallel agent work with Git worktrees and shared Turbo cache. citeturn496702view1 The Claude guidance lists available gstack skills including `/plan-ceo-review`, `/plan-eng-review`, `/review`, `/ship`, `/browse`, `/qa`, `/retro`, and `/perf-loop`. citeturn893855view1 Use those as the operating system.

| Squad | Agents | Mission | Output by end of day | Kill condition |
|---|---:|---|---|---|
| YC App War Room | 2 | Draft YC answers, compress language, remove hype | final application draft + 1-page metrics sheet | any answer has vague claims |
| Customer Research | 6–10 | Find artists with recent/upcoming releases and existing fragmented tooling | 250 ranked prospects with links and personalization | generic outreach |
| Concierge Profile Factory | 4–6 | Build preview profiles for high-priority artists | 25 preview profiles | quality below demoable |
| Founder Outreach Ops | 2 | Prepare DMs/emails, log responses, schedule calls | CRM board + call calendar | agents send without founder review |
| Reliability P0 | 3–5 | Fix only demo/onboarding/auth/cron/API blockers | merged P0 fixes + smoke report | PR touches unrelated refactors |
| Metrics/Analytics | 2 | Extract real metrics from DB/Statsig/Stripe | YC metrics dashboard | unverifiable numbers |
| Homepage/Copy | 2 | Reposition site from link-in-bio to AI manager/release automation | homepage PR + README PR | copy says unsupported AI claims |
| Red Team | 1–2 | Attack the YC app, demo, metrics, and claims | contradiction list + fixes | becomes generic critique |

Rules for every agent:

1. one branch/worktree per task;
2. no migrations unless P0 and manually reviewed;
3. no Stripe/auth/onboarding changes without human review;
4. no fake testimonials, fake stats, or placeholder logos;
5. every PR must include demo steps, screenshots, test output, and rollback note;
6. founder approves anything that changes positioning or user-facing claims.

Your own Claude rules already warn not to use fake stats or fake testimonials near the top of the artist landing page. citeturn893855view1 Keep that standard everywhere.

---

## YC application rewrite

Use these as draft answers. Replace bracketed metrics with real numbers only.

### Company one-liner

> Jovie is an AI manager for independent music artists.

Alternative if YC’s field allows more detail:

> AI release manager for independent music artists.

### What is your company going to make?

> Jovie is an AI manager for independent music artists. Artists connect Spotify once; Jovie detects new releases, generates smart links, captures fans into a CRM, sends release notifications, and drafts the promo work artists usually do manually.  
>   
> We start with release automation because every artist has the same recurring workflow: finish song → create links → update platforms → notify fans → pitch playlists → track results. Longer term, Jovie becomes the shared context layer for an artist’s career, where AI and human team members coordinate around releases, fans, collaborators, bookings, and promotion.

### How far along are you?

> Product is live at jov.ie. We have [X] artist profiles, [Y] claimed artists, [Z] releases detected/generated, [N] fan subscribers captured, and [$M] revenue or [K] signed paid commitments.  
>   
> In the last [7/14] days, we onboarded [X] artists and learned that the acute pain is not “make me a prettier link page,” but “remove the repetitive work around every release.”

If revenue is zero, say zero. Then immediately show usage, commitment, or paid pilots.

### Why did you pick this idea?

> I spent 15 years as an artist, songwriter, producer, and digital strategist. My first independent single reached tens of millions of streams with no budget; my later label experience showed me that understanding and executing the system matters more than waiting for a team.  
>   
> Independent artists need a manager, publicist, CRM, smart-link tool, and release coordinator before they can afford any of them. Jovie gives them the first version of that team through software.

Your internal memo claims 70M streams for the first independent single and 90M streams as accumulated experience; use the exact number you can verify. citeturn124205view0

### Who are your competitors?

> Today artists use Linktree-style bio tools, music smart-link tools like Linkfire/Feature.fm, and drop/fan CRM tools like Laylo. These tools help with pieces of the workflow. Jovie is different because it is release-aware and context-aware: it detects releases, generates assets, captures fans, tracks engagement, and uses the artist’s career context to decide what should happen next.  
>   
> The long-term competitor is not another link page. It is the manager/publicist/operator an artist cannot yet afford.

This answer is important because competitors are strong. Laylo, Linkfire, and Feature.fm all cover meaningful parts of the music-marketing workflow. citeturn981549search0turn981549search1turn981549search2 The answer must show exactly why Jovie is not just “same thing with AI.”

### How will you make money?

> SaaS for artists, starting at $39/mo for release automation and smart links, with a $99/mo Growth tier for deeper automation, fan messaging, and agent workflows.  
>   
> We will start by selling directly to independent artists who already pay for fragmented tools. As usage compounds, we can expand to managers, small labels, and service providers who manage multiple artists.

### What is your insight?

> Music creation is getting cheaper, but music-career coordination is getting harder. Every artist can now create and distribute music, but the work after creation is fragmented across Spotify, social platforms, email, smart links, fan data, booking inquiries, collaborators, and memory.  
>   
> The winning system is not a prettier landing page. It is the context layer that knows the artist’s catalog, fans, collaborators, release history, and next actions.

### What is most impressive about the founder?

> Tim built and shipped Jovie as a solo founder using AI-heavy engineering workflows, with a production Next.js/Clerk/Neon/Stripe/Statsig/Sentry stack, thousands of commits, and live product infrastructure. He also has deep founder-market fit from 15 years as an artist and digital strategist, including [verified stream count], label experience, and a large artist network.

Make this concrete. Paul Graham specifically warns that generic founder praise carries little weight; specific achievements matter. citeturn479441view0

### What are the biggest risks?

> First, artists are price-sensitive, so we need to prove that release automation creates enough recurring value to support $39–$99/mo. Second, data quality matters: wrong artist/release matches destroy trust, so we are building confirmation and fallback UX around DSP matching. Third, AI actions must be transparent and reversible because artists have low trust in opaque intermediaries.

That answer is stronger than pretending there are no risks. YC explicitly says candid discussion of obstacles is more convincing than glib dismissal. citeturn815904view1

---

## Product/code priorities from the repo audit

### Must ship or verify before submitting YC app

1. **Production golden path:** signup → claim/import → profile → release page → fan subscribe → dashboard.
2. **Release automation proof:** a real or seeded demo showing release detection/generation.
3. **Fan capture proof:** subscriber event visible in dashboard.
4. **AI proof:** playlist pitch / release notification / next-action draft generated from artist context.
5. **Fallback/error UX:** if DSP matching fails, the artist sees a helpful fallback, not a broken product.
6. **Metrics dashboard:** founder can answer “how many users, how much usage, where did users come from, what retained?”

### Defer until after application

1. command palette;
2. viral reels MVP;
3. broad UI token sweeps;
4. card/button refactors;
5. extension performance budgets;
6. SMS;
7. Pinterest/Snap/X pixels;
8. lyrics;
9. birthday capture;
10. broad investor deck design.

These may be useful later. They are not the current bottleneck.

### One exception: smart-link routing

The repo’s Linear issue list marks full geo/device/platform smart-link routing as launch-relevant for new artist acquisition. citeturn367143view0 Ship only the smallest version that improves artist demos: device-aware or platform-preference routing, not a full routing platform.

---

## Before May 4: day-by-day plan

### Apr 23–24: proof sprint

Goal: new customer evidence.

1. freeze noncritical PRs;
2. fix P0 demo blockers;
3. extract metrics;
4. rewrite homepage/README;
5. create 25 artist previews;
6. contact 100–250 artists;
7. book 10+ calls;
8. onboard 5+ artists;
9. get 2+ paid commitments or LOIs.

### Apr 25–27: activation sprint

Goal: turn onboarded artists into proof.

1. watch every onboarding session;
2. write down top 10 objections;
3. fix only the top 3;
4. collect quotes from real users;
5. improve claim/import flow;
6. add instrumentation where blind;
7. ship 2–3 case studies.

### Apr 28–30: application sprint

Goal: make the app concise and undeniable.

1. write final application;
2. cut every vague phrase;
3. replace every unsupported claim with data;
4. record founder video;
5. record product demo;
6. ask 5 sharp people to read it and answer: “What does Jovie do?”
7. if they answer “link-in-bio,” rewrite.

### May 1–3: interview readiness through progress

Goal: be able to say what changed since applying.

1. submit early if ready;
2. keep onboarding users;
3. keep shipping P0 improvements;
4. update metrics daily;
5. prepare a one-page “since application” update;
6. know competitors cold;
7. know why reluctant artists did not convert.

### May 4: submit

Submit before 8pm PT. Do not wait for perfect. The app should be simple, specific, and true.

---

## What not to do

Do not spend the next day building investor-deck polish, new feature breadth, or agent theatrics. YC does not fund “we have agents.” They fund founders making something people want.

Do not claim AI capabilities that are not working. Your best story is not “AGI for music.” It is:

> Artists have repetitive release operations. Jovie already automates the first loop. Every artist and release deepens the context. That context becomes the foundation for an AI manager.

Do not say “we need YC to survive.” Say:

> We are applying to YC because this is the exact moment to turn a working release-automation wedge into the AI manager for independent artists.

---

## Blunt flaws in the current plan/company

1. **The public positioning is too small.** “Link-in-bio” makes Jovie sound like a feature, not a venture-scale company.
2. **The internal AI story is stronger than the external AI story.** The AI memo is still “coming soon,” while the best YC pitch depends on AI/context/agents. citeturn124205view2
3. **There is too much parallel engineering surface.** 26 open PRs and many UI/refactor threads can create motion without traction. citeturn543136view0
4. **The company needs real customer pull fast.** Without paying artists, LOIs, or strong usage, YC may see this as a polished solo-founder product looking for a market.
5. **The competitor answer must be sharp.** Laylo, Linkfire, and Feature.fm are not weak. Jovie must be release-aware automation plus artist context, not “better music links.”
6. **Solo-founder risk is real.** AI leverage helps, but YC may still worry about resilience, sales capacity, and product judgment. Counter this with speed, customer love, and an obvious near-term hiring/cofounder plan.

---

## Adversarial audit loop

### Round 1: Claude Code-style evaluation

**Critique:**  
The plan is too broad. It asks for customer acquisition, code fixes, copy, metrics, investor outreach, and YC writing in 24 hours. Agent swarms can create PR sprawl and false confidence. The code plan needs stricter P0 gates.

**Plan changes made:**  
I narrowed engineering to demo/onboarding/auth/API/metrics only, added explicit kill conditions, and told you to freeze command palette, reels, UI sweeps, extension work, and refactors. I also added “founder sends, agents prepare” to avoid automated spam.

**Score after revision:** 9/10.

### Round 1: Gary Tan-style evaluation

**Critique:**  
Too much “optimize the application,” not enough “go get users.” YC wants to see that you are relentless and can create momentum now. Also, “we need YC to survive” is bad framing.

**Plan changes made:**  
I moved customer acquisition to the center: 100–250 artists contacted, 25 concierge previews, 10+ calls, 5+ onboarded, 2+ paid/LOI targets. I removed survival language and reframed YC as an accelerant.

**Score after revision:** 9/10.

### Round 1: Paul Graham-style evaluation

**Critique:**  
The original company story is too abstract: “AI manager,” “context layer,” “music career engine.” The first sentence must say plainly what the product does. Also, growth/revenue/user metrics matter more than a grand vision.

**Plan changes made:**  
I rewrote the core sentence to: “Artists connect Spotify once; Jovie detects new releases, generates smart links, captures fans, sends release notifications, and drafts release-promo work automatically.” I also forced a metrics dashboard and a single growth metric.

**Score after revision:** 9.5/10.

### Round 1: Harj Taggar-style evaluation

I’m treating “Harge” as Harj Taggar, YC Managing Partner. YC’s people page lists Harj as a Managing Partner and longtime YC partner/operator. citeturn126974view0

**Critique:**  
Solo founder plus many AI agents can look impressive but fragile. Who sells? Who talks to users? Who keeps quality high? Also, if Jovie is a music company, founder-market fit must be unmistakable.

**Plan changes made:**  
I made Tim’s direct artist network the primary channel, not agents. I added a concrete founder-led outreach plan and made agents support prospecting/profile prep instead of owning customer relationships. I also made founder-market fit a central YC answer.

**Score after revision:** 9/10.

### Round 2: final adversarial scores

| Persona | Remaining concern | Final score |
|---|---|---:|
| Claude Code | Still high operational load, but now bounded by P0 gates | 9/10 |
| Gary Tan | Needs real user conversion, not just outreach volume | 9/10 |
| Paul Graham | Must keep application brutally concise | 9.5/10 |
| Harj Taggar | Solo-founder risk remains, but speed + founder-market fit can offset it | 9/10 |

---

## The immediate checklist

Do these in order:

1. Write the one-sentence YC description.
2. Freeze noncritical PRs.
3. Extract real traction metrics.
4. Fix demo/onboarding/API P0s.
5. Rewrite homepage hero and README away from “link-in-bio.”
6. Write the one-page AI memo.
7. Create 25 artist preview profiles.
8. Send 100+ founder-led artist DMs/emails.
9. Book calls and onboard artists manually.
10. Get at least 2 paid commitments or signed LOIs.
11. Record the 90-second demo.
12. Rewrite the YC app with real numbers only.
13. Have 5 people read it and answer “what does Jovie do?”
14. Keep improving metrics every day until May 4.

The highest-leverage thing is not another feature. It is showing YC that between April 23 and May 4, you can turn a live product and founder-market insight into real artist adoption.
