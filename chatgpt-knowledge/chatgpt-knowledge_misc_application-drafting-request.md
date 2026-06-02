---
title: "Application Drafting Request"
type: guide
created: 2026-05-14
updated: 2026-05-14
source: chatgpt-export
topic: misc
message_count: 14
tags: [chatgpt, knowledge, misc]
---
# Application Drafting Request

> **Source:** ChatGPT conversation
> **Date:** 2026-05-14T01:20:16Z
> **Messages:** 14
> **Topic:** misc

## Question

https://speedrun.a16z.com/apply/form

I think that for this one, we actually don't even need the demo video. We should have everything we need to apply. Can you extract everything in here and confirm, and then draft up the application? 

## Answer

I’ll inspect the a16z form, verify required fields including demo-video requirements, then draft a ready-to-paste application using available Jovie context.

## Answer

I verified the form structure: no required demo video field is visible. The only required post-details item is “Where did you learn about speedrun,” while deck, traction, funding, and referral sections are optional.

## Answer

Mr. White — confirmed: the visible Speedrun form does **not** show a demo video requirement. The form requires team info, startup info, and a “Where did you learn about speedrun?” source. Pitch deck, traction, funding history, active fundraising round, and referral are listed under Additional Information and appear optional. citeturn132103view0turn132103view1turn132103view2

Jovie has enough company/product/founder material to apply. Remaining fields to fill manually: **email, phone if desired, citizenship, LinkedIn, highest education, and how you heard about Speedrun**.

## Extracted requirements

| Section | Required fields |
|---|---|
| Team | full-time/part-time, number of full-time founders, total FTE, founder first/last/email, relevant experience, country/city, citizenship, college/university, highest education, years professional experience, technical enough, LinkedIn, team description |
| Startup Details | startup name, one-liner max 10 words, description max 100 words, primary category, intended build country/city, founded year/month |
| Additional Information | “Where did you learn about speedrun?” source |
| Optional | phone, GitHub, X, portfolio, company website, anything else, pitch deck, traction, funding history, active fundraising round, referral |

## Draft application

### Team

**Full-time or part-time**  
Full-time

**Number of full-time founders**  
1

**Total FTEs, including founders**  
1

**Founder 1 — First name**  
Tim

**Founder 1 — Last name**  
White

**Founder 1 — Email**  
`[fill]`

**Founder 1 — Phone number**  
`[fill optional]`

**Relevant experience**  
Solo founder with 15+ years in music as an artist, producer, songwriter, marketer, and operator. My debut single drove 70M+ YouTube plays with zero marketing budget through a UGC system I built myself. I have 190K Instagram followers, 500+ live performances, releases on Armada Music, and a Cosmic Gate collaboration on Black Hole Recordings. I also built interactive and digital marketing systems for Google, Netflix, NFL, NBA All-Star Game, and Hulu, including a Clio Award. Self-taught developer; built Jovie solo.

**Country**  
United States

**City**  
Los Angeles

**Citizenship**  
`[fill]`

**College / University**  
Drexel University

**Highest education level**  
`[fill: Some college / no degree]`

**Years of professional experience**  
15

**Technical enough to build the product?**  
Yes

**LinkedIn**  
`[fill]`

**GitHub**  
`https://github.com/itstimwhite`

**X**  
`[fill optional]`

**Portfolio**  
`https://jov.ie/tim`

**Team description — max 100 words**  
Solo founder. I am the artist, operator, and developer. I built Jovie because I have done the release work manually for 15 years: smart links, fan capture, release notifications, metadata, playlist pitching, release tasks, and follow-up across scattered tools. That gives me direct founder-market fit and a live dogfood loop through my own artist profile and audience. Product, engineering, ops, and

*(Answer truncated — 6647 chars total)*

## Question

This should answer all these questions with as much context as you can from linear issues and the repo and everything, like any insights about what we've learned to make these stronger. You want to make it clear that we've gone down the hermes and pulled all the founding context and all that stuff so that this is bulletproof for our ongoing raise. You might want to consider filling that out too, like putting a 1.5 or whatever pre-seed or something in there, 1.25, whatever you want to be. For pricing, I would say:
- Free
- 39 a month (reverse trial)
- 299 a month for the operator plan

## Answer

Mr. White — I pulled the current Speedrun form, the JovieApplication repo, the Ops fundraising repo, Linear, and the Jovie repo/PR history.

Confirmed: the visible Speedrun form has **no demo video field**. It asks for Team, Startup Details, and Additional Information; pitch deck, traction, funding history, active fundraising round, and referral are optional, while “Where did you learn about speedrun?” is required. citeturn873444view0

The strongest version uses the newer Ops/Linear context over the older JovieApplication answers. The older Speedrun draft says “no capital” and old pricing; the current Ops application says Jovie has a live product, 4 inbound external signups, 1 active dogfood artist, $25K raised on a $5M cap SAFE, and an accelerator-first fundraising path. fileciteturn43file0 fileciteturn51file0 fileciteturn63file0

## Key upgrades baked into this draft

The product framing should be **AI release ops / release OS for artists and operators**, powered by fan demand, rather than a simple link-in-bio tool. The latest Ops application frames the wedge as fan alerts and profile claiming: fans create demand, artists claim the profile, and Jovie runs the release workflow around that audience. fileciteturn63file0

The “why now” is stronger: AI makes music creation easier, which increases release volume and makes the operational work around each release the bottleneck. The old app already identified “storytelling in infinite content” as the market shift, but the newer raise narrative is sharper around release operations and owned demand. fileciteturn33file0 fileciteturn63file0

The traction should be honest and specific: live product, dogfooding on Tim’s artist profile, 4 inbound external signups, 0 paying users, acquisition intentionally gated while onboarding is hardened. That is stronger than pretending the product is fully scaled. fileciteturn63file0

The execution story is unusually strong: Linear/GitHub show the unified AI onboarding front door shipped in four merged PRs, including anonymous `/start`, Spotify/handle tools, deterministic access decisions, inline signup, transcript claiming, and checkout handoff. fileciteturn15file0 fileciteturn48file0 fileciteturn47file0 fileciteturn49file0 fileciteturn46file0

The “we went down Hermes” point is real: the repo has a read-only automation audit covering crons, Linear orchestration, Hermes worker, agent workflows, KPI alignment, cost guardrails, and OpenRouter substitutions; the AgentOS architecture doc positions Hermes/Ruflo as bounded execution adapters under Linear, GitHub Actions, GStack, CI, and human-review gates. fileciteturn55file0 fileciteturn57file0 fileciteturn58file0 fileciteturn59file0

## Paste-ready Speedrun application

### Team

| Field | Answer |
|---|---|
| Are you full-time or part-time? | Full-time |
| Number of full-time founders | 1 |
| Total FTE employees | 1 |
| Founder first name | Tim |
| Founder last name | Whit

*(Answer truncated — 8909 chars total)*

## Question

dec was the legal founding. open my browser and start filling this out then leave for me to review and submit

## Question

Closed loop agentic OS for music artists.

## Answer

Use this as the **one-liner**:

**Closed loop agentic OS for music artists**

Updated supporting fields:

**Startup description**  
Jovie is a closed loop agentic OS for music artists. Artists connect Spotify; Jovie imports their catalog, release dates, artwork, credits, links, and fan demand into one operating workspace. It creates public artist profiles, smart links, fan-capture flows, launch tasks, release notifications, playlist-pitch drafts, and onboarding-to-checkout through one conversational front door. The system observes release state, recommends the next action, executes workflows, measures outcomes, and updates the plan around every drop.

**Anything else**  
Since the earlier Speedrun draft, Jovie has evolved from artist profile software into a closed loop agentic OS. The unified AI onboarding front door now handles anonymous /start, Spotify and handle tools, deterministic access decisions, inline signup, transcript claiming, and checkout handoff. We also audited Hermes/Ruflo/cron automation and formalized AgentOS so internal agents compound founder work under human-review, CI, GStack, cost, and deploy gates. The product and company are both becoming agentic systems.

**Traction**  
Live product. I dogfood Jovie on my own artist profile, and 4 external artists have signed up inbound with zero outreach. I have deliberately gated broader acquisition while hardening onboarding; each inbound signup surfaced issues that were fixed immediately. The product now supports Spotify import, public artist profiles, catalog pages, smart links across DSPs, fan capture, release notifications, AI playlist pitch generation, and a conversational onboarding-to-checkout front door. Pricing: Free, $39/month Pro via reverse trial, and $299/month Operator for managers, labels, agencies, and high-volume artist teams.

## Question

These are just ideas. You need to actually ground this in what would actually make sense. 

## Question

Daniel Kang is advising us and is a a speed run guy scout or something liek that 

## Question

build the application and then on my approval well fill it out and submit

## Answer

I’ll build a grounded review-ready Speedrun application with shipped product facts first, agentic OS as the roadmap/moat, and Daniel Kang included as advisor/referral context without overstating it.

## Answer

Mr. White — the grounded version should **lead with “release OS”**, then use “closed-loop / agentic” as the strategic layer. “Closed-loop agentic OS” is directionally right, but front-loading it in the one-liner risks sounding like a thesis before they understand what the product does.

## Recommended positioning

**Use this one-liner:**

**Closed-loop release OS for music artists.**

It is cleaner, under 10 words, and still carries the agentic idea without sounding inflated.

The application should say: Jovie is already live as release infrastructure for artists — Spotify import, artist profiles, smart links, fan capture, release notifications, AI onboarding, and checkout. The “agentic OS” layer is the next logical step: Jovie observes release context, recommends next actions, executes workflows with approval, measures outcomes, and updates the plan.

---

# Speedrun application draft

## Team

**Are you full-time or part-time on the startup?**  
Full-time

**Number of full-time founders**  
1

**Total FTE employees, including founders**  
1

**Founder first name**  
Tim

**Founder last name**  
White

**Founder email**  
tim@jov.ie

**Phone number**  
`[confirm before submit]`

**Relevant experience**  
I’ve spent 15+ years in music as an artist, songwriter, producer, marketer, and builder. I drove 70M+ fan-generated YouTube views on my debut single with a UGC system I built myself, released music through Armada and Black Hole, collaborated with Cosmic Gate, and performed 500+ shows. I also built digital and interactive marketing systems for Google, Netflix, NFL, NBA All-Star Game, Hulu, and other major brands, including Clio-recognized work. I’m building Jovie myself and dogfooding it as an artist.

**Country**  
United States

**City**  
Los Angeles

**Citizenship**  
`[confirm before submit]`

**College / University**  
Drexel University

**Highest education**  
Some college — Music Industry

**Years of professional experience**  
15

**Are you technical enough to build the product end-to-end?**  
Yes

**LinkedIn URL**  
`[confirm exact URL before submit]`

**GitHub URL**  
https://github.com/itstimwhite

**X URL**  
`[optional / confirm before submit]`

**Portfolio URL**  
https://jov.ie/tim

**Tell us more about the team**  
Solo founder. I am the artist, operator, and developer. Jovie came from doing release work manually for 15 years: links, fan capture, release notifications, metadata, playlist pitching, launch tasks, and follow-up across disconnected tools. I’m building the product myself and using it on my own artist profile, which keeps user research and product iteration direct. I also run the company through a documented AI operating system across Linear, GitHub, and agent workflows so one founder can ship with high leverage.

---

## Startup Details

**Startup name**  
Jovie

**One-liner**  
Closed-loop release OS for music artists.

**Startup description**  
Jovie helps music artists release more music with less work. Artists con

*(Answer truncated — 6971 chars total)*
