---
title: "Influencer CRM vs music product"
type: note
created: 2025-08-09
updated: 2025-08-09
source: chatgpt-export
conversation_id: 6897909b-6880-8320-b47d-6df07ab2cd14
message_count: 2
tags: [chatgpt, import, long-form]
---
# Influencer CRM vs music product

> Conversation ID: 6897909b-6880-8320-b47d-6df07ab2cd14
> Created: 2025-08-09T18:17:10Z
> Updated: 2025-08-09T18:17:54Z
> Messages: 2

---

## User

So, in 2021, I created a product called Jovi, and I opened up the startup, and I started building it. And we built a CRM, and basically it's a CRM that shows you... It was built on Laravel with Vue frontend, and it showed you a giant... It had a really pretty interface database. It was modeled after the linear interface very closely. And it would just show you a list of contacts. On the left, you had the ability to create lists for contacts, and you could drag them from the list onto the sidebar to add them to a list. You could just drag and drop them to add them to lists. And then you had the ability... There was a board view where you could drag them between stages to move them, to change the stage of the contact. It was built for influencer marketing, so the idea was that you'd have a stage where it was like, here's my list of influencers. Once I contact them, I move them to the contact stage. If they reject the offer, they get rejected. If not, they get moved to the negotiating stage. Then to the approved stage, or whatever, that they've signed a contract. And then when they deliver the content, they get moved to the delivering stage. And then it was set up to use queues on Laravel, where I could import people by pasting in a giant list or a CSV file of either emails or Instagram handles or Twitter handles or YouTube links. And we would import all of those contacts. We would then go out and scrape their social pages, looking for links to other pages. For example, if we scraped their Twitter page, we found an Instagram link, and we could confirm that those were together and they were a match. We'd then, in our database, link them together so that in the future, if anyone imported that Instagram profile, it automatically gave all of the information we had from Twitter. And we'd pull in profile images, bios, names from all of their different social medias, and we'd start aggregating all that data together. And over time, building this giant central database of all of these social profiles, and as individual users imported, we would have the ability to then enrich them. We'd enrich contacts with credits, and we'd charge people per user, per seat. It was built for agencies doing influencer marketing, and our first client was Neil Patel Digital, who was our beta tester, basically, because my ex-girlfriend was the influencer director there. And so we would charge for teams per seat billing and then usage. So the more credits they wanted for enrichment, the more we charged them. But if they just wanted to manage a campaign with it without doing the enrichment, then they just paid per seat, team billing. And it was a B2B SaaS software, and it was a web app. And then we planned on eventually rolling out a desktop app using, I forget what that wrapper thing is called that everyone uses for discords built on Electron, I think. We were going to build an Electron app or something. It kind of worked a little bit like Folk CRM with the ability to use, but it was basically built around influencer marketing. And we had a Chrome extension where you'd go to a website, and it was any kind of social website, like a Twitter or an Instagram. And we automatically detect that and then embed a button on the page, save to Joby. When you click save to Joby, it would then scrape that page, send them to the database, and then auto-enrich them against everything else. And it would add them to a list. And any time there was a link, like if you went to a team page on an investor site and it showed all the different investors with their Twitter links, you could right-click on any Twitter link and say add to Joby. Or when you right-click, it would populate all your lists, and you could add them to a list. So it was great for fundraising research and stuff like that for founders. Anyway, that was the idea of the whole app. I built it. It was functional. Everything I just described worked. We did use the name Joby, but now we're using it, obviously, for this product. But we shut it down before we really had any paying customers. And everything that I said worked, but it was very buggy. At the time, I was hiring someone else to do back-end development, and I was doing front-end development. And also at the time, there was no such thing as AI coding at all. Obviously, now we're using it insane. We have GPT-5. We have all of these, Linear, Windsurf, GitHub, Copilot, Codex, all of these things. We're able to triage with AI. We're able to code review with AI. We're just at a crazy scale. If I were to open up the project for Joby and revamp it, it would probably be something that I could build much, much, much, much, much quicker. That being said, I definitely enjoy building the current Joby product more. It's for musicians and stuff, and that's my network. But I just want a quick assessment. If you think that it would be worth it to dive into all the technical overhead and revamp that app and sell that as my startup, or to continue building the current Joby thing targeted towards musicians and stuff, that's, you know, I don't know. Tell me what you think.

---

## Assistant

Mr. White, here’s the blunt take.

# Stay on the music product. Don’t resurrect the influencer CRM as your main startup.

## Why (short, factual, decision-grade)

1. Founder–market fit & distribution  
   - You have reach with artists/labels; that’s immediate distribution.  
   - Agencies for influencer CRMs require outbound, demos, procurement, and references. Typical sales cycle: ~60–120 days; you’ll need case studies and compliance answers.

2. Tech & compliance risk  
   - Your old CRM’s core wedge was web scraping + enrichment. In 2025 that’s higher-risk (TOS, anti-bot, legal) and costlier to maintain at scale (rotating proxies, QA, breakage).  
   - Porting a 2021 Laravel/Vue codebase (and electron dreams) to your current Next/Supabase stack = near-rewrite. AI helps, but you’re still paying context-switch and re-architecture costs.

3. Unit economics reality  
   - Influencer CRM can win higher ACV ($5k–$50k/yr per agency) **if** you clear procurement + accuracy. That’s a heavy, sales-led motion.  
   - Jovie is low ARPU initially, but you can land many users fast and layer higher-margin add-ons (ads automation, attribution, tour tooling, “teams” seats). It fits your network and brand.

4. Competition dynamics  
   - Influencer CRM is a red ocean (entrenched platforms + suites). You need a new, hard moat (first-party data, workflow lock-in, or procurement credentials like SOC2).  
   - “Smart links for music” is crowded too, but your wedge (fast SSR, tasteful UX, creator-ops automations, ad/attribution layer) is buildable and marketable with your credibility.

## Best move
Keep building Jovie (music). Cannibalize the **useful** pieces of the old CRM as features:

- “Relations” mini-CRM inside Jovie: lists, Kanban stages, drag-and-drop pipelines for outreach (playlist curators, venues, influencers).  
- A safe Chrome helper: capture contacts + context from public pages, but avoid scraping arms races; lean on official APIs / user pastes / upload.  
- Lightweight enrichment: email discovery via partners, link graph built from user-provided handles, not bots. Credits can still monetize.

## 2-week execution plan (minimal thrash)

**Week 1**
- Ship: artist handle claim → Clerk → onboarding → profile live (fastest happy path).  
- Add built-in “Relations” board (your Linear-style UI is a small lift and on-brand).  
- Metered credits only for *manual* imports to start (CSV/paste). Instrument activation, DAU/WAU, link CTR.

**Week 2**
- Pricing: $5 intro → $12 core; add “Teams” (2–5 seats) and a credits pack.  
- Run a 20-artist pilot (your network) with a success target: ≥10 paying logos, ≥30% week-2 retention, ≥20% links clicked in 7 days.  
- If targets hit, double down; if not, iterate messaging and the handle→live path before adding scope.

## If you *must* test the influencer CRM again (kill-switch test)
- 7-day pre-sell: simple page + demo video + your network intro. Goal: 3 LOIs or $10k in pilots.  
- No scraping MVP: CSV → enrichment via vendors/APIs; ship the Linear-style pipeline + team billing only.  
- If you can’t pre-sell, kill it (again) and refocus on Jovie.

**Bottom line:** Your fastest path to traction with the least legal/tech drag is Jovie (music) with a built-in outreach mini-CRM. Use the old idea as a feature, not the company.


## See Also
- [[chatgpt/chatgpt_3d-product-video-creation]]
- [[chatgpt/chatgpt_agentic-billing-for-music]]
- [[chatgpt/chatgpt_ai-driven-music-bio]]
- [[chatgpt/chatgpt_ai-for-music-catalogs]]
- [[chatgpt/chatgpt_ai-growth-engine-for-music]]
