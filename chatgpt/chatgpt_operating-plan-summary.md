---
title: "Operating plan summary"
type: essay
created: 2026-05-25
updated: 2026-05-25
source: chatgpt-export
conversation_id: 6a14ae21-6cb0-83e8-bb06-634cf66bd011
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Operating plan summary

> Conversation ID: 6a14ae21-6cb0-83e8-bb06-634cf66bd011
> Created: 2026-05-25T20:16:34Z
> Updated: 2026-05-25T20:43:46Z
> Messages: 6

---

## Assistant

Mr. White, I’ll turn this into a dependency-ordered execution plan with today’s critical path, owner splits, cash/runway items, and verified accelerator/application deadlines.

---

## Assistant

I verified YC remains open for late applications, Speedrun is a warm-intro/future-cohort path, and HF0 still shows May 31. I’m also checking repos only to identify demo blockers, without changing GitHub or Linear.

---

## Assistant

Mr. White, here is the operating plan extracted from your notes. I’m treating **today, Monday May 25, 2026**, as a hard execution day around: **YC, Daniel’s meeting tomorrow, the demo Loom, rent cash, and fundraising prep**. Source notes: fileciteturn0file0

## 1. Core priority stack

### P0 — Must happen today

| Priority | Outcome | Why it matters |
|---:|---|---|
| 1 | **YC fully handled** | The application is the live external deadline. YC’s official page says the on-time S26 deadline was May 4, 2026, and late applications are still being accepted; your notes treat May 25 as the extended cutoff, so operate as though this expires tonight. citeturn300268search0turn300268search1 |
| 2 | **Daniel gets investor-ready materials** | He has a meeting tomorrow. He needs a deck, forwardable blurb, and crisp verbal framing. |
| 3 | **Demo Loom recorded** | YC, Daniel, A16Z, Speedrun, and future investor conversations all benefit from the same compact proof artifact. |
| 4 | **Rent/cash plan activated** | You need **$900**, have **$40**, so remaining gap is **$860**. This cannot be allowed to distract every other task indefinitely. |
| 5 | **Fundraising system v0 created** | You need a repeatable call flow, not ad hoc fundraising conversations. |

### P1 — Important after P0 is stable

| Area | Outcome |
|---|---|
| Boardy / intro agent | Upload Jovi context, target investor criteria, and warm-intro ask. Boardy describes itself as an AI networking agent for professional connections. citeturn960074search0 |
| Granola | Set up before calls start so every fundraising conversation becomes structured notes. |
| Calendar | Define fundraising call blocks and customer-call blocks. |
| CRM / investor tracker | One canonical list: investor, source, fit, intro path, status, next action. |
| AI credit applications | Start with OpenAI, Google Cloud, Vercel, Together AI. |
| Product onboarding | Waitlist flow, iOS invite flow, auth, landing-page cleanup. |
| Agent infrastructure | Arames always-on, shared G-Brain/Rooflow knowledge, unified agent docs. |

---

## 2. Today’s execution order

## Phase 1 — 30 minutes: Command center

Create one working doc called:

```txt
Jovi May 25 Deadline Plan
```

Sections:

```txt
1. YC
2. Daniel
3. Demo Loom
4. Product demo blockers
5. Fundraising materials
6. Cash/rent
7. Agent assignments
8. Open questions / parking lot
```

Rules:

- Anything needed for **YC, Daniel, or Loom** stays in the main plan.
- Everything else goes into the parking lot unless it blocks one of those three.
- Agents get tasks with exact done criteria.
- You personally only do founder-context work: pitch, final judgment, relationship messages, camera/Loom recording, Daniel ask.

---

# 3. Dependency map

## A. YC completion path

```txt
YC complete
├── Daniel recommendation ask sent
├── Updated demo Loom uploaded
│   ├── Merged merch demo works
│   ├── Navigation/UI is clean enough for recording
│   ├── iPhone screen recording path works
│   └── 90-second demo script ready
└── Application final sanity check
```

### YC task list

| Task | Owner | Dependency | Done when |
|---|---|---|---|
| Send Daniel YC recommendation ask | You | None | Daniel has direct ask + deadline + link/context |
| Verify YC update already filed | You/agent | None | Screenshot or confirmation saved |
| Produce updated Loom | You + product agent | Demo path stable | Loom link is uploaded to YC |
| Final YC pass | You | Loom ready | Application has latest fundraising/progress/demo info |

### Daniel YC recommendation ask

Send this:

```txt
Daniel — quick YC ask.

We submitted Jovi for YC S26 and today is the final push on the application. Would you be willing to submit a short recommendation today?

The cleanest framing:

Tim/Jovi is building an AI operating system for creators and brands to launch commerce campaigns from natural language. The product is now close enough to demonstrate end-to-end: a user can ask Jovi to launch a merch drop, and Jovi turns that into an actionable campaign workflow.

The strongest signal is execution velocity. We’ve been shipping aggressively, consolidating the product surface, and moving toward a usable demo/customer onboarding path.

I can send the recommendation link/context immediately.
```

---

# 4. Daniel meeting tomorrow: required package

Daniel needs enough to pitch you without improvising.

## Daniel package

| Asset | Length | Status target |
|---|---:|---|
| Deck | 8 slides max | Today |
| 30-second pitch | 4–5 sentences | Today |
| 2-minute pitch | One spoken script | Today |
| Forwardable email | 150–200 words | Today |
| Demo Loom | 60–90 sec | Today |
| Specific asks | 3 bullets | Today |

## Deck v0.9 structure

Use this, no extra slides today:

1. **Title** — Jovi: AI operating system for creator/brand commerce.
2. **Problem** — launching drops/campaigns requires too many disconnected tools and operators.
3. **Product** — chat-based workflow that turns intent into campaign execution.
4. **Demo** — screenshots or Loom QR/link: “drop new merch for EDC this weekend.”
5. **Why now** — AI agents can now coordinate creative, commerce, messaging, and ops workflows.
6. **Market / wedge** — start with creators/brands doing drops; expand into broader commerce ops.
7. **Progress** — product shipped, mobile/desktop work, demo flow, waitlist/customer readiness.
8. **Ask** — intros, accelerator support, capital/credits, design partners.

YC’s own pitch guidance emphasizes clarity and concision; their “How to Pitch Your Company” guide frames the pitch around a small set of essential questions rather than a sprawling narrative. citeturn144098search0

## 30-second pitch draft

```txt
I’m Tim White, founder of Jovi.

Jovi is an AI operating system for creators and brands that turns a plain-English business intent into an executed commerce workflow.

For example, a user can say: “I want to drop new merch for EDC this weekend,” and Jovi helps generate the campaign plan, product/drop flow, assets, messaging, and operational steps from chat.

The wedge is creator commerce, but the bigger vision is an AI-native command center for running a modern internet business.
```

## 2-minute pitch draft

```txt
I’m Tim White, founder of Jovi.

Creators and small brands increasingly operate like media companies, commerce companies, and software companies at the same time. They have to plan drops, create assets, manage products, message audiences, coordinate launches, and keep the whole system moving across a messy stack of tools.

Jovi turns that workflow into a conversational operating system. A user can start with a business intent like, “I want to drop new merch for EDC this weekend,” and Jovi converts that into a structured launch workflow: what to make, how to position it, what assets and pages are needed, what messages go out, and what steps need approval.

The product is moving from prototype into usable demo/customer onboarding. We’ve been aggressively consolidating the interface, mobile app, desktop app, waitlist flow, and agent workflows so that the product can show the full loop from intent to execution.

The initial market is creators and small brands running drops, campaigns, and merch. The larger opportunity is the AI-native business operating system: one place where the founder, creator, or operator tells the business what they want done, and agents coordinate the execution.

Right now we’re looking for help with three things: investor intros, accelerator support, and design partners who run real launches and can use Jovi as their command center.
```

## Forwardable intro blurb for Daniel

```txt
Subject: Intro — Jovi / AI operating system for creator commerce

Wanted to introduce Tim White, founder of Jovi.

Jovi is building an AI operating system for creators and brands. The product lets a user describe a business objective in natural language — for example, “I want to drop new merch for EDC this weekend” — and turns that into an executable commerce/campaign workflow across planning, assets, messaging, product/drop setup, and launch ops.

The wedge is creator commerce and merch drops, but the broader vision is an AI-native command center for running a modern internet business.

Tim has been shipping quickly and is at the point where the product can be demonstrated end-to-end. He’s currently looking for investor intros, accelerator support, and early design partners.

Worth a conversation.
```

## Daniel ask list

Ask Daniel for exactly this:

```txt
1. YC recommendation today.
2. Help with tomorrow’s AI House / investor meeting using the deck + forwardable.
3. Warm intros to A16Z / Speedrun scouts, especially anyone who can still influence a late or future Speedrun path.
```

---

# 5. Demo Loom plan

## Goal

Record a **60–90 second iPhone screen recording** that proves Jovi can turn intent into execution.

## Demo narrative

```txt
“I want to drop new merch for EDC this weekend.”
```

The demo should show:

1. User opens Jovi mobile app.
2. User enters the merch-drop request.
3. Jovi asks or infers key launch details.
4. Jovi produces a structured plan.
5. Jovi shows generated campaign/drop output.
6. Founder closes with the business point: this replaces fragmented creator-commerce ops.

## Loom script

```txt
This is Jovi.

Jovi is an AI operating system for creator and brand commerce. Instead of jumping between tools to plan a launch, create assets, write copy, and coordinate execution, the user starts with intent.

Here I’m asking Jovi: “I want to drop new merch for EDC this weekend.”

Jovi turns that into a structured launch workflow: what we’re launching, who it’s for, what needs to be created, what the campaign should say, and what operational steps need approval.

The initial wedge is merch drops and creator commerce. The bigger vision is that Jovi becomes the command center for running an internet business from chat.
```

## Product blockers for the Loom

### Demo-critical only

| Task | Owner | Done when |
|---|---|---|
| Confirm merged merch demo works | Product agent | Screen recording proof exists |
| Fix navigation chaos enough for recording | Product agent | Demo path has no confusing detours |
| Fix obvious white-on-white CTA if visible | Product agent | Button text readable |
| Confirm mobile app auth state | Product agent | You can open demo path without auth failure |
| Prepare fallback demo account/state | Product agent | You can record even if onboarding is unstable |

### Defer unless visible in Loom

| Issue | Reason to defer |
|---|---|
| Search consolidation | Important product cleanup, probably not Loom-critical |
| Full waitlist flow | Important for customer onboarding, probably not YC Loom-critical |
| Settings duplicate text/font weirdness | Fix only if visible in demo path |
| Full iOS TestFlight invite automation | P1 after YC/Daniel |

---

# 6. Agent assignments for today

## Agent 1 — Product demo stabilization

```txt
Mission: Make the Jovi mobile demo recordable today.

Target demo path:
User says: “I want to drop new merch for EDC this weekend.”
Jovi responds with a useful merch/drop campaign workflow.

Scope:
1. Verify merged merch demo is live and functional.
2. Clean the navigation only where it affects the demo path.
3. Fix any obvious visual regression visible in the demo, especially white text on white background.
4. Confirm auth does not block the iPhone demo.
5. Produce a short QA note with:
   - demo URL/build
   - account/state used
   - known issues
   - exact steps for Tim to record

Do not refactor search, settings, onboarding, or general navigation unless it blocks the demo.
```

## Agent 2 — Deck builder

```txt
Mission: Create Jovi deck v0.9 for Daniel’s meeting tomorrow.

Constraints:
- 8 slides max.
- Plain, investor-readable.
- Use the demo/Loom as proof.
- Focus on clarity over polish.

Slides:
1. Title
2. Problem
3. Product
4. Demo
5. Why now
6. Market / wedge
7. Progress
8. Ask

Output:
- PDF
- editable source
- 5-bullet summary Daniel can read in 60 seconds
```

## Agent 3 — Fundraising material compiler

```txt
Mission: Build the first fundraising command pack.

Create:
1. 30-second pitch
2. 2-minute pitch
3. Forwardable intro email
4. Investor call script
5. Objection-response sheet
6. Investor tracker template

Tone:
Clear, direct, no jargon, no founder life story.

Call flow:
- One-line intro
- Concrete example
- “Does that make sense?”
- Ask what they want to dig into
- Handle objections
- Ask process/timeline
- Close next step
```

## Agent 4 — Cash/rent liquidation

```txt
Mission: Turn unused gear into the fastest credible cash path.

Target:
- $860 remaining rent gap.

Inventory from notes:
- Sony A7 III
- Sigma 85mm Art prime
- SM7B
- Cloudlifter
- iPads
- Samsung T5 drive
- power tools
- MacBook docks / bridge docks
- other electronics

Output:
1. Same-day local sale priority list.
2. eBay list with expected net and time-to-cash.
3. Missing accessories needed, especially body/lens caps.
4. Draft listings for Facebook Marketplace, Craigslist, and eBay.
5. Recommendation: what to sell locally today vs list on eBay.
```

## Agent 5 — AI credits / accelerator scan

```txt
Mission: Find immediately actionable credits, accelerators, and application paths.

Prioritize:
1. OpenAI startup credits
2. Google Cloud AI startup program
3. Vercel startup credits / AI accelerator
4. Together AI startup accelerator
5. Soma Fellows
6. Techstars programs
7. AI Grant next batch
8. A16Z Speedrun late/future cohort path

Output:
- Name
- Deadline/status
- Benefit
- Fit for Jovi
- Application link
- Required assets
- Whether to do today, this week, or monitor
```

---

# 7. Fundraising call system

Use this structure. It matches your instinct: concise opening, concrete example, then let the investor drive. YC’s seed fundraising guide is also process-oriented: know what you are raising, keep momentum, and understand investor process. citeturn144098search1

## Investor call script

### Opening

```txt
I’ll give the quick version, then you can tell me what’s most interesting to dig into.

I’m Tim White, founder of Jovi. Jovi is an AI operating system for creators and brands that turns plain-English intent into executed commerce workflows.

For example, a user can say, “I want to drop new merch for EDC this weekend,” and Jovi turns that into the launch plan, campaign assets, messaging, product/drop workflow, and operational checklist.

Does that make sense?
```

### Then ask

```txt
What part of that is most interesting to you: the creator-commerce wedge, the AI agent workflow, the product demo, or the broader business operating system vision?
```

### Objections

| Investor asks | Answer |
|---|---|
| “Is this just Shopify with AI?” | “Shopify is the commerce backend. Jovi is the operator layer. The user expresses business intent, and Jovi coordinates the launch workflow across tools.” |
| “Who is the initial customer?” | “Creators and small brands running drops, merch, and campaigns where speed and coordination matter.” |
| “What is the wedge?” | “Merch/drop execution from chat. It is concrete, frequent, visual, and easy to demo.” |
| “Why now?” | “Agentic workflows can now coordinate planning, creative, messaging, and operational execution in a way that was brittle before.” |
| “What traction do you have?” | “We are moving from prototype to usable demo/customer onboarding. The strongest current signal is shipping velocity and the end-to-end workflow coming online.” |
| “What are you raising?” | “We are preparing the round now. The immediate goal is to bring in capital and credits to extend runway, increase agent throughput, and get design partners using the product.” |
| “What do you need from me?” | “Three things: feedback on the wedge, intros to investors who like AI-native commerce/workflow companies, and design partners who run real launches.” |

### Closing

```txt
What is your process from here, and what would you need to see to make a decision?
```

---

# 8. Cash/rent plan

## Current gap

```txt
Rent target: $900
Already raised: $40
Remaining: $860
```

## Best path

### Same-day cash

Prioritize local sale items with immediate buyer demand:

1. **SM7B + Cloudlifter**
2. **iPads**
3. **Power tools**
4. **T5 SSD / electronics bundle**
5. **MacBook docks**

Reason: these are easier local cash sales than a camera/lens kit.

### Camera path

Samy’s offer: **$650 check in ~1 week** for Sony A7 III + Sigma 85mm Art. That is a useful floor, but weak for rent urgency. eBay could net more, but needs body/lens caps and carries delay, fees, buyer risk, and possible return friction.

Recommended:

```txt
Today:
- List camera kit locally at a cash price above Samy’s floor.
- Also prepare eBay listing, but do not rely on eBay for immediate rent.

Fallback:
- If no local buyer appears, use Samy’s $650 as a floor or list on eBay with caps included.
```

### Listing priority

```txt
Bundle A — Fast cash:
SM7B + Cloudlifter

Bundle B — Fast cash:
iPad(s), priced to move

Bundle C — Higher value:
Sony A7 III + Sigma 85mm Art + SD cards/accessories

Bundle D — Cleanup:
T5 drive, docks, power tools, miscellaneous electronics
```

---

# 9. AI credits and accelerator action list

## Apply / pursue now

| Program | Status / benefit | Action |
|---|---|---|
| **OpenAI for Startups** | OpenAI says applicants need a VC referral code, product/API usage description, company info, team contacts, and basic funding details. citeturn171861search0 | Ask Daniel/investors for referral code. Prepare 1-paragraph API usage case. |
| **Google Cloud AI Startup Program** | Google advertises up to **$350,000 in Cloud credits** for AI startups. citeturn171861search6 | Apply this week. Strong fit if Jovi can use Gemini/infra credits. |
| **Vercel for Startups** | Vercel startup credits page advertises up to **$30,000** in credits. citeturn171861search8 | Apply immediately since you already use Vercel/AI Gateway. |
| **Together AI Startup Accelerator** | Together offers compute credits, engineering support, and GTM resources for AI-native startups. citeturn171861search19 | Apply this week if inference cost matters. |
| **Soma Fellows** | Current page shows deadline **June 10, 2026** and “up to $2M uncapped.” citeturn303783search2 | Put on this week’s application list. |

## Monitor / secondary

| Program | Status | Action |
|---|---|---|
| **a16z Speedrun SR007** | Official apply page says SR007 deadline was **May 17, 2026**; late applications are considered for a future cohort. citeturn699570search20 | Use Daniel/scout intros and submit/update only if available. |
| **AI Grant** | Batch 4 is closed; listed benefits include $250k uncapped SAFE and credits. citeturn303783search0 | Monitor next batch. |
| **Techstars Anywhere** | September 2026 program page shows final deadline **June 10, 2026**. citeturn303783search11 | Consider after YC/Daniel assets are done. |
| **Vercel AI Accelerator** | 2026 recap says next applications open later this year; Vercel also advertises AI Accelerator credits. citeturn171861search14turn171861search25 | Monitor; apply to startup credits now. |
| **AI House Seattle** | AI2 Incubator’s AI House page frames it as Seattle’s AI hub for AI experts, entrepreneurs, and builders. citeturn699570search2 | Daniel meeting tomorrow: deck + 30-sec pitch + forwardable. |

---

# 10. Arames / agent infrastructure decision

## Decision for today

Run Arames on the **MacBook Air always-on** for now.

Reason:

- No new cash required.
- No Railway deployment yak shave today.
- Good enough for orchestration, task watching, reminders, and context packaging.
- Railway can come later when uptime/logging/webhook reliability matters.

## Model routing

For today:

```txt
Coding agents: preserve Codex/Claude Code for actual code.
Orchestration agent: cheap model through OpenRouter or direct DeepSeek.
High-stakes writing/pitch: use best available model manually.
```

OpenRouter’s site positions itself as a unified API with model routing and fallback across providers, which is useful for orchestration resilience. citeturn171861search12

## Agent knowledge system

Do one lightweight setup today:

```txt
/AGENTS.md
/TODAY.md
/FUNDRAISING.md
/DEMO.md
/KNOWN_ISSUES.md
```

Each agent gets instructed:

```txt
Before starting, read AGENTS.md and TODAY.md.
After finishing, update TODAY.md with:
- what changed
- proof
- blockers
- next recommended action
```

Do not spend today re-architecting G-Brain/Rooflow unless agents are failing because of missing shared context.

---

# 11. Product backlog after Loom

## P0 demo blockers

```txt
1. Merged merch demo verified.
2. Mobile auth works or demo account bypass works.
3. Navigation clean enough for recording.
4. Critical CTA color bug fixed.
5. Demo script recorded.
```

## P1 customer-readiness

```txt
1. Waitlist signup works.
2. Waitlist toggle ON puts user on waitlist.
3. Waitlist toggle OFF sends invite/access email.
4. iOS waitlist users can request TestFlight access.
5. Existing users can request iOS access from chat and a button.
6. Landing page gets 1-hour cleanup pass.
```

## P2 app polish

```txt
1. Search behavior consolidated.
2. Command palette replaced/merged into header search.
3. Settings duplicate text fixed.
4. Font weirdness fixed.
5. Release page styling regression tests added.
6. Promptfoo/eval infrastructure verified.
```

---

# 12. The actual today checklist

## Founder-only

```txt
[ ] Send Daniel YC recommendation ask.
[ ] Send Daniel meeting package once deck/Loom are ready.
[ ] Record iPhone Loom.
[ ] Do final YC upload/check.
[ ] Make final judgment on deck wording.
[ ] Decide what gear gets listed for immediate cash.
[ ] Record or approve 30-sec and 2-min pitch.
```

## Delegate to agents

```txt
[ ] Demo path QA.
[ ] Navigation/UI cleanup for recording path.
[ ] White-on-white CTA fix.
[ ] Deck v0.9.
[ ] Forwardable email + investor script.
[ ] Cash listing drafts.
[ ] AI credits / accelerator tracker.
[ ] Boardy context package.
[ ] Granola setup checklist.
[ ] Investor CRM template.
```

## Do later today only after YC + Daniel package

```txt
[ ] Submit/update Speedrun path.
[ ] Apply Vercel startup credits.
[ ] Prepare OpenAI startup credits referral request.
[ ] Start Soma Fellows application shell.
[ ] Set up Boardy.
[ ] Set up Granola.
[ ] Create fundraising calendar blocks.
```

---

# 13. Recommended order for the next 4 hours

```txt
00:00–00:20
Create command center. Assign agents.

00:20–01:30
Product agent fixes demo blockers.
Deck agent builds deck v0.9.
Fundraising agent drafts pitch/email/script.

01:30–02:00
You review demo path.
Record Loom.

02:00–02:30
Upload Loom to YC.
Send Daniel YC recommendation ask if not already sent.
Final YC sanity check.

02:30–03:15
Review deck.
Package Daniel email:
- deck
- Loom
- forwardable
- 30-sec pitch
- asks

03:15–04:00
Cash/rent execution:
- post fast-cash listings
- message likely buyers
- decide camera local/eBay/Samy’s path
```

---

# 14. Single operating principle for today

**Do the smallest amount of product cleanup necessary to produce a credible demo and investor package.**

The trap is trying to fix navigation, auth, waitlist, search, agent infra, evals, G-Brain, credits, fundraising process, and cash all at once. Today’s win condition is narrower:

```txt
YC submitted.
Daniel armed.
Loom recorded.
Rent plan activated.
Fundraising system started.
```

---

## User

Yes, you use so much jargon in your 30-second pitch draft, so it should be something like this:

Hi, I'm Tim White. I'm an artist based in Los Angeles, and I'm the founder of Jovie. Jovie is an AI operating system for creators that turns plain English business intent into executable workflows.

For example, a music artist or a DJ from Brooklyn could say, "I want to drop new merch for EDC this weekend." Jovie instantly generates three merch designs and asks you to select one. A simple thumbs up triggers the creation of that item, fulfilled automatically through Printful and shipped to users. We generate a live merch shelf on their artist profile and a concise text message that goes out to all of their fans. A concise text message goes out to all the fans. This happens automatically via simple conversation. This means that artists can literally ideate, ship, and market their entire merch line during the bathroom break in their recording session.

That's the kind of language I want to use. I want to emphasize that Jovie's here to help you make more money as an artist and then get the fuck out of the way so that you can keep creating art. 

Also, Jovie is how you spell Jovie. I use speech-to-text every time I talk to you, and you keep fucking that up, so please stop doing it. You keep writing Jovie. That's not the name of the company. 

---

## Assistant

Mr. White, understood. I’m replacing the pitch language with sharper creator-commerce language and using Jovie consistently.

---

## Assistant

Understood, Mr. White. The company is **Jovie**. I’ll use that spelling.

Your better positioning:

> **Jovie helps artists make more money from their audience, then gets the fuck out of the way so they can keep creating art.**

That should become the spine of the pitch.

## 30-second pitch — plain version

```txt
Hi, I’m Tim White. I’m an artist based in Los Angeles, and I’m the founder of Jovie.

Jovie helps artists make more money from their audience through simple conversation.

For example, a DJ from Brooklyn can say, “I want to drop new merch for EDC this weekend.” Jovie generates three merch designs, asks them to pick one, creates the product, connects fulfillment through Printful, adds a live merch shelf to their artist profile, and writes the text message that goes out to their fans.

An artist can ideate, ship, and market an entire merch drop during a bathroom break in a recording session.
```

## 30-second pitch — sharper investor version

```txt
Hi, I’m Tim White. I’m an artist based in Los Angeles, and I’m the founder of Jovie.

Jovie helps artists make more money without pulling them away from making art.

A music artist or DJ can say, “I want to drop new merch for EDC this weekend.” Jovie instantly generates merch designs, lets them approve one with a thumbs up, creates the item through Printful, puts it on their artist profile, and sends a clean text to their fans.

The result is simple: artists can launch and market a real merch drop from a conversation, in minutes.
```

## 45-second version with the “get out of the way” line

```txt
Hi, I’m Tim White. I’m an artist based in Los Angeles, and I’m the founder of Jovie.

Jovie helps artists make more money, then gets the fuck out of the way so they can keep creating art.

A DJ from Brooklyn can say, “I want to drop new merch for EDC this weekend.” Jovie generates three designs, asks them to pick one, creates the product, handles fulfillment through Printful, adds the item to their artist profile, and writes the text message that goes out to their fans.

So instead of spending days coordinating designers, merch tools, storefronts, and marketing copy, the artist can launch a merch line from a conversation during a bathroom break in their recording session.
```

## 60–75 second fundraising opening

```txt
Hi, I’m Tim White. I’m an artist based in Los Angeles, and I’m the founder of Jovie.

Jovie helps artists make more money from their audience through simple conversation.

Here’s the easiest example. A music artist or DJ says, “I want to drop new merch for EDC this weekend.” Jovie generates three merch designs and asks them to choose one. They give it a thumbs up, and Jovie creates the product, connects fulfillment through Printful, publishes a live merch shelf on their artist profile, and writes the text message that goes out to their fans.

The artist does not need to open five tools, hire a designer, figure out a store, write marketing copy, or manage fulfillment. They just say what they want to sell, approve the version they like, and Jovie handles the rest.

The goal is simple: help artists make more money and give them their time back.
```

## Cleaner one-liner options

Use these in deck/email copy:

```txt
Jovie helps artists launch merch, sell to fans, and make more money from a conversation.
```

```txt
Jovie turns an artist’s idea into a live merch drop in minutes.
```

```txt
Jovie lets artists ideate, ship, and market merch without leaving the studio.
```

```txt
Jovie helps artists monetize their audience without becoming full-time operators.
```

```txt
Jovie is the business layer for artists: say what you want to sell, approve the output, and keep creating.
```

## Deck language replacement

Replace the old jargon-heavy slide copy with this:

### Slide 1 — Title

```txt
Jovie

Helping artists make more money from simple conversation.
```

### Slide 2 — Problem

```txt
Artists already have audiences.

Turning that audience into real revenue still requires too much work:
designers, merch tools, storefronts, fulfillment, copywriting, texting fans, and launch planning.

Most artists did not become artists to manage ops.
```

### Slide 3 — Product

```txt
Jovie lets an artist say what they want to sell.

Jovie creates the designs, builds the product, publishes the merch shelf, writes the fan message, and helps launch the drop.
```

### Slide 4 — Demo

```txt
Prompt:
“I want to drop new merch for EDC this weekend.”

Jovie:
1. Generates merch concepts
2. Lets the artist approve one
3. Creates the product
4. Connects fulfillment
5. Publishes the merch shelf
6. Sends the fan text
```

### Slide 5 — Why it matters

```txt
Artists can turn inspiration into revenue while the idea is still fresh.

A merch drop should take minutes, not days.
```

### Slide 6 — Vision

```txt
Jovie becomes the place where artists run their business without becoming business operators.

Make money.
Keep creating.
```

## Daniel-forwardable version

```txt
Subject: Intro — Tim White / Jovie

Wanted to introduce Tim White, an artist based in Los Angeles and the founder of Jovie.

Jovie helps artists make more money from their audience through simple conversation.

For example, a DJ can say, “I want to drop new merch for EDC this weekend.” Jovie generates merch designs, lets them approve one, creates the product, connects fulfillment through Printful, publishes a live merch shelf on their artist profile, and writes the text message that goes out to their fans.

The core idea is simple: artists should be able to ideate, ship, and market a merch drop in minutes without getting pulled away from making art.

Worth a conversation.
```

## Updated fundraising call opener

```txt
I’ll give the quick version.

I’m Tim White. I’m an artist based in Los Angeles, and I’m the founder of Jovie.

Jovie helps artists make more money through simple conversation.

For example, an artist can say, “I want to drop new merch for EDC this weekend.” Jovie generates designs, lets them approve one, creates the product, connects fulfillment, publishes it to their artist profile, and writes the fan text.

The artist gets a live merch drop in minutes.

Does that make sense?
```

## Phrases to stop using in the spoken pitch

Drop these from the 30-second pitch:

```txt
AI operating system
business intent
executable workflows
creator commerce
operator layer
agentic workflow
campaign orchestration
AI-native command center
```

They can appear later in investor materials after the listener understands the simple version. The spoken pitch should stay anchored in:

```txt
artist
money
merch
fans
conversation
minutes
keep creating
```

The original task context was to tighten the Jovie pitch, deck, demo Loom, Daniel package, and fundraising script today. fileciteturn0file0


## See Also
- [[chatgpt/chatgpt_10k-mrr-plan]]
- [[chatgpt/chatgpt_agent-orchestration-summary]]
- [[chatgpt/chatgpt_ai-coding-plan-comparison]]
- [[chatgpt/chatgpt_ai-lead-plan-for-linktree]]
- [[chatgpt/chatgpt_ai-plan-for-ios-refactor]]
