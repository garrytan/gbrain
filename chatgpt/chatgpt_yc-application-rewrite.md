---
title: "YC Application Rewrite"
type: essay
created: 2026-04-29
updated: 2026-05-01
source: chatgpt-export
conversation_id: 69f25e19-cea8-83e8-97c0-945dcca07d17
message_count: 21
tags: [chatgpt, import, long-form]
---
# YC Application Rewrite

> Conversation ID: 69f25e19-cea8-83e8-97c0-945dcca07d17
> Created: 2026-04-29T19:38:02Z
> Updated: 2026-05-01T03:44:41Z
> Messages: 21

---

## User

yc application is due may 4 its april 29. in the last 7 days ive rethought htis product and honed in on so much and shipped so much that i think the application needs to be rewritten ground up. im going to waitlist gate the procut. chat only onboarding that conducts a user inteview before wiatlisting the user. when we flip it live it will still interview them and then use that to handle objects and show them build things for them. before you land on the ashboard you already have uour music and your catalog loaded. and im  going to start doing things like have jovie scrap you merch in the bg or other context and then say "it looke liek you don havt any merch. ive got 3 designs here you might like just say which one and ill scedhuel it drop on friday. then a joveie alert tot he fans. so a musicians who never built merch has it designed,and for sale and schedule to be texted to their fanbase before they even finish onbaording. printful api and then we nufge ema  week later (hey we cant pay you for you mercch sales til you connect stripe). which now habdles them conneting striipe so they use the tupping feature. and then were rolling out cleaner ui and lot of ai features. can we rewurtie this application. look at our github ops repo witht he old yc applicaiton and our actual code and then linear for whats in flight and our recent convos then write the best apllication to get me in to ycombinator this batch.

---

## User

5 users so far. werecharhing 39/mo then 199/mo and artist profiles are free. reverse 14 day trial. 
we are dogfooding. after discovering the 5 users having issues creating accounts we rebuild onboarding from the groudn up aronud an ai first user interview. we then waitlist gated while we dogfood til were happy.


some additioanl uqniue insights. for merch for example the bottleneck was never selling merch online. shopify solved this after teespring solved after insert 20 other comapnies solved it.

the problem was you spent hundreds of dolalrs hiring mrerch designers becaus eoyou dont have time or skill and you get garabage abck. if jovie can geenrate 3 quality designs and you can text back 2 and she schedules and drops it you built ecomm artist will actually use.

revenue is 39/mo from me. im using it for real for my own music. can we count that?


---

## User

the founder video should follow the michael siebel how to pitch a startup video transcript afvice.

including a specific example.

Liek Jovie helps ine[end artists release music faster. An artist connects their sptoify and within 60 seconds blah blah balh
for exmaple
Josh Wink a DJ from detroit, can blah blah blah...
like a real sounding person, with a real soundng career and specific examples that make it emotionally connect quickly.
cocnsie and clear and stupid simple.
dive into recent convos and see if anything can be improved from them. if not dont change a thing.


---

## User

try out AI agents for music industry ops and see if it works better for 50 character desc

---

## User

AI label ops for independent artists


What is the demo video for this. Shot by shot. Plan it.

---

## User

Add symphonyos as competitor

---

## Assistant

I’ll add SymphonyOS as the closest AI music marketing workflow competitor, while positioning Jovie around broader label ops and artist context.

---

## Assistant

Mr. White, yes. **SymphonyOS should be in the competitor section**, probably first.

SymphonyOS is the closest credible competitor because it already frames itself around automated music marketing, audience growth, AI-powered ads, CRM, landing pages, analytics, and fan engagement for artists. Its SoundCloud partner page describes ads across Meta/TikTok/Google, personalized analytics, landing pages, CRM, and AI-powered recommendations. citeturn981608search0turn981608search1

### Updated YC competitor answer

**Who are your competitors? What do you understand about your business that they don’t?**

Our closest competitor is SymphonyOS. They are building marketing automation for artists: ad campaigns, landing pages, audience analytics, CRM, and AI-powered recommendations. Feature.fm and Linkfire are focused on smart links and music marketing campaigns. Linktree is the generic profile/link-in-bio layer. Shopify, Printful, and Fourthwall handle commerce infrastructure.

What I understand from doing this manually for 15 years is that independent artists need label ops, not another dashboard.

The bottleneck is rarely whether an artist can technically sell merch, run a link page, or launch an ad. Those pieces already exist. The bottleneck is that the artist has to know what to do, set everything up, connect the tools, write the copy, design the merch, schedule the drop, follow up with fans, and keep doing that every release.

Jovie starts by owning the artist context: their Spotify catalog, profile, fan contacts, release history, and goals. Then it turns that context into work done for the artist. For example, an artist connects Spotify, Jovie builds their profile and release links, captures fans, starts the release follow-up, and can eventually say: “You don’t have merch yet. I made three designs from your artist identity. Reply 2 and I’ll schedule the drop for Friday and text your fans.”

SymphonyOS is a strong marketing automation product. Jovie is becoming the AI label operator for independent artists. The wedge is the free artist profile. The business is automating the release and fan-growth work that a label team would normally do.

---

## User

Amazing competitor answer. Let’s harden the application as best we can without fucking it up.

---

## User

For payments we launched Venmo quick so the tray lets you pick the amount the opens a pre populated Venmo tip in the Venmo app. This was to launch faster and not overbuild but stripe payments exist just not stable yet.

Also honestly agent building has changed dramatically in the last 6 months since I start building and now that I fully understand what’s possible more and more is shifting. But not launched. Anything we should add about that? The core premise remains Jove can turn 4 songs into 52 fridays and eventually automate ever step of the process

---

## Assistant

I’ll frame Venmo tips as live shipping discipline, Stripe as built but still stabilizing, and the newer agentic automation as clear product direction rather than launched capability.

---

## Assistant

Mr. White, add both facts, but only in the right places.

## 1. Payments: include Venmo as a strength

This is good YC material because it shows you **ship fast and avoid overbuilding**.

Use this in **“How far along are you?”**

> Jovie is live. An artist can create a free profile, connect Spotify, import their catalog, create release links, capture fans, and accept tips.
>
> For tipping, I launched the fastest usable version first: a fan picks an amount in Jovie and the payment tray opens a pre-populated Venmo tip in the Venmo app. Stripe Connect exists in the product, but I am not relying on it yet because it is still being stabilized. I chose Venmo so artists could start accepting money immediately instead of waiting for a perfect payments stack.

This is better than saying “Stripe payments exist but are unstable.” It says the same thing with founder judgment.

## 2. Revenue: separate subscription revenue from payments

Use this framing:

> We charge $39/month after a reverse 14-day trial, with a planned $199/month tier for heavier automation. Artist profiles are free.
>
> We have 5 users so far. I am also paying $39/month myself and using Jovie for my own music every day. I would count that as dogfooding revenue rather than external customer validation. The honest external paid-user number is still early.

For the actual YC field:

**Do you have revenue?**

> Yes, $39/month from founder dogfooding. No external paid users yet.

That is the cleanest version. Do not pretend your own $39/month is equivalent to a customer. YC will respect the honesty.

## 3. Agent shift: include it as “why now,” not traction

This is important. It sharpens the whole company.

Use it in **“What is your company going to make?”**

> Jovie is AI label ops for independent artists.
>
> Distributors get songs onto streaming services. Jovie handles the work that starts after that: release pages, fan capture, tips, merch, follow-up, and the weekly operational work an artist usually needs a label team to do.
>
> The product starts with a free artist profile. An artist connects Spotify, Jovie imports their catalog, builds their release surfaces, and starts collecting fan and commerce data. I am now rebuilding onboarding around an AI-first interview so Jovie understands the artist before they land on a dashboard.
>
> The long-term idea is simple: turn 4 songs into 52 Fridays. Most independent artists do not need more blank dashboards. They need a system that knows their catalog, audience, merch, releases, and goals, then keeps creating the next useful action every week.

That last line is strong. It says the whole company without overclaiming.

## 4. Add this to “What changed?”

This should replace the previous softer version:

> The biggest change is that the product has moved from “artist profile and smart links” toward “AI label ops.”
>
> Six months ago, this looked like a vertical SaaS product for musicians. After building it, dogfooding it, and watching early users struggle with account creation and setup, I realized the dashboard is downstream of the real problem. Artists need Jovie to interview them, understand their catalog, and start doing useful work before asking them to configure anything.
>
> Agent building has also changed dramatically since I started. The product is shifting from forms and dashboards toward agents that can edit artist objects, create release assets, schedule follow-up, and eventually run recurring fan and commerce workflows. The current product is live; the agentic version is what I am actively building toward.

This is candid and compelling.

## 5. Merch insight: keep it, but place it under competitors

The merch point is excellent because it shows a non-obvious insight.

Use this in the **competitor answer**, after the SymphonyOS paragraph:

> Another example is merch. Shopify, Printful, Fourthwall, Teespring, and a dozen other companies solved the ecommerce infrastructure. The reason most independent artists still do not sell merch is that they do not have the time, taste, or money to get good designs made and launched. The bottleneck is the operator work before the storefront.
>
> Jovie’s direction is to handle that work. If Jovie knows the artist’s catalog, visual identity, fans, and release calendar, it can say: “You do not have merch yet. I made three designs. Reply 2 and I’ll schedule the drop for Friday and text your fans.” That is the difference between selling tools and doing label ops.

Strong. Keep it as direction unless the full Printful loop is live.

## 6. Hardened short description

Use:

> **AI label ops for independent artists**

It is better than “AI agents for music industry ops.” More specific, more emotional, clearer customer, stronger wedge.

## 7. One sentence to carry the whole app

Use this repeatedly across written app, founder video, and demo:

> Jovie turns an independent artist’s catalog into weekly release, fan, and commerce actions.

Slightly sharper version:

> Jovie turns 4 songs into 52 Fridays of release, fan, and commerce ops.

Use the first in the application. Use the second in the founder video because it is memorable.

## 8. What to avoid

Do not say:

> Jovie automates every step of the process.

Say:

> Jovie is building toward automating the weekly release, fan, and commerce work that a label team normally handles.

Do not say:

> We have Stripe payments.

Say:

> Stripe Connect is implemented but still being stabilized; the live tipping flow uses Venmo so artists can accept money now.

Do not say:

> We have paying customers.

Say:

> We have 5 users, founder dogfooding at $39/month, and no external paid users yet.

The hardened application should now center on this:

**Jovie is AI label ops for independent artists. Artists do not need another dashboard. They need the work done. The first wedge is a free artist profile; the long-term product turns 4 songs into 52 Fridays of release, fan, merch, and commerce execution.**

---

## User

Explain the last sentence better. 52 fridays…of release moments….a lyric video, an acoustic version, a merch drop, remix…something new every single week. You show up with 4 songs Jovie gives you weekly drops, produced, fulfilled, and sent to your fans , automatically 

---

## Assistant

Mr. White, the sharper idea is:

**Jovie turns a small catalog into a year of weekly artist moments.**

“52 Fridays” means Jovie takes 4 songs and builds the operating plan around them: lyric videos, acoustic versions, remixes, merch drops, fan texts, behind-the-scenes posts, release anniversaries, live-session clips, preorder pushes, and follow-up campaigns. The artist brings the music. Jovie turns it into a weekly release engine.

Use this as the clean YC version:

> Jovie turns 4 songs into 52 Fridays of release moments. An artist shows up with a small catalog, and Jovie turns it into a year of weekly drops: a lyric video, an acoustic version, a remix, a merch drop, a fan text, a behind-the-scenes clip, or a new offer. Over time, Jovie produces the asset, schedules the drop, fulfills the commerce, and sends it to the fans automatically.

Even tighter:

> Jovie turns 4 songs into 52 Fridays. An artist brings the music; Jovie creates the weekly release moments around it: lyric videos, acoustic versions, remixes, merch drops, fan texts, and offers. The long-term product produces the asset, schedules the drop, fulfills it, and sends it to fans automatically.

For the application, I would use this version because it is clear and avoids overclaiming:

> The long-term vision is to turn 4 songs into 52 Fridays. An artist brings a small catalog; Jovie turns it into a year of weekly release moments: lyric videos, acoustic versions, remixes, merch drops, fan texts, behind-the-scenes clips, and offers. The product is moving toward producing, scheduling, fulfilling, and sending those moments automatically.

For the founder video, say it more emotionally:

> Most independent artists release a song and then run out of momentum. Jovie turns 4 songs into 52 Fridays. You bring the music, and Jovie keeps creating the next weekly moment: a lyric video, an acoustic version, a remix, a merch drop, a fan text, or a new offer. The goal is that every Friday, something useful ships to your fans automatically.

---

## User

Artist disappear for a year while working on 4 songs they drop in one day and then no one hears from them while they tour for 6 months. And then they repeat. With jovie the same artist, with the same input, drops something every single gel Friday, so their fans keep engaging and the flywheel builds itself.



---

## Assistant

Mr. White, this is the clearest framing:

**Independent artists have a cadence problem.**

They spend a year making four songs, drop everything at once, tour for six months, disappear from fans, then repeat the cycle. The same creative input could create a full year of fan engagement.

Use this in the YC app:

> Most independent artists spend months making a few songs, release them all at once, then disappear while they tour or make the next batch. Jovie changes the cadence. The same 4 songs become 52 Fridays of artist moments: lyric videos, acoustic versions, remixes, merch drops, fan texts, behind-the-scenes clips, preorder pushes, and new offers. The artist brings the music; Jovie builds the weekly drop plan and is moving toward producing, scheduling, fulfilling, and sending each moment automatically. Fans hear from the artist every week, and the release cycle starts compounding.

Tighter version:

> Jovie turns 4 songs into 52 Fridays. Today, independent artists spend months making music, drop it all at once, disappear, and repeat. Jovie takes the same input and creates a weekly release engine around it: lyric videos, acoustic versions, remixes, merch drops, fan texts, behind-the-scenes clips, and offers. The goal is that every Friday, something useful ships to fans automatically.

Best founder-video version:

> Most independent artists disappear for a year, make 4 songs, drop them all at once, tour for 6 months, and then start over. Jovie turns those same 4 songs into 52 Fridays. Every week the artist has something new for fans: a lyric video, acoustic version, remix, merch drop, behind-the-scenes clip, or fan text. Same artist, same songs, completely different cadence. That is how the fan flywheel starts building.

Best one-liner:

> **Jovie turns 4 songs into 52 Fridays of fan engagement.**

Best application sentence:

> **Jovie turns a small catalog into a weekly fan-engagement flywheel.**

---

## User

A fan text is not a drop. Every drop is texted to fans.

---

## Assistant

Mr. White, correct. **Fan text is the distribution rail, not the drop.**

The sharper framing:

> Jovie turns 4 songs into 52 Fridays of artist drops. Today, independent artists spend months making music, release it all at once, tour, disappear from fans, and repeat. Jovie takes the same 4 songs and creates a weekly drop plan around them: lyric videos, acoustic versions, remixes, merch drops, live-session clips, behind-the-scenes videos, alternate artwork, demos, stems, bundles, and limited offers. Every drop is scheduled, published, and texted to fans, so the artist keeps showing up every week and the fan flywheel compounds.

Founder-video version:

> Most independent artists disappear for a year, make 4 songs, drop them all at once, tour for 6 months, and then start over. Jovie turns those same 4 songs into 52 Fridays. Every week, fans get a real artist drop: a lyric video, acoustic version, remix, merch drop, live clip, behind-the-scenes video, demo, or limited offer. Jovie schedules it, publishes it, and texts it to the fanbase. Same artist, same songs, completely different cadence.

Application one-liner:

> **Jovie turns 4 songs into 52 Fridays of artist drops, each scheduled, published, and texted to fans.**

Cleaner version for “What are you building?”:

> The long-term vision is to turn a small catalog into a weekly release engine. An artist brings 4 songs; Jovie creates 52 Fridays of drops around them: lyric videos, acoustic versions, remixes, merch, live clips, demos, alternate artwork, bundles, and limited offers. Each drop is scheduled, published, and sent to fans automatically.

---

## User

Build that as a hardened application.

---

## Assistant

I’ll turn the current thesis into copy-paste YC application answers, separating live facts, dogfooding, and future vision so the application is aggressive without sounding inflated.

---

## Assistant

Mr. White, below is the hardened YC application draft I would work from. It keeps the ambition sharp, uses the **4 songs → 52 Fridays** idea, and avoids pretending future agent workflows are already live.

# YC Application Draft — Jovie

## Company

### Company name

Jovie

### Describe what your company does in 50 characters or less

**AI label ops for independent artists**

### Company URL

jov.ie

### Product link

jov.ie/tim

### If login credentials are required, provide them here

N/A. Public artist profiles are visible without login.

---

## What is your company going to make?

Jovie is AI label ops for independent artists.

Independent artists have a cadence problem. They spend months making a few songs, release them all at once, tour, disappear from fans, then repeat. Jovie turns the same catalog into a weekly release engine.

The long-term vision is to turn 4 songs into 52 Fridays of artist drops. An artist brings a small catalog; Jovie creates weekly drops around it: lyric videos, acoustic versions, remixes, merch drops, live-session clips, demos, alternate artwork, bundles, and limited offers. Each drop is scheduled, published, fulfilled when needed, and texted to fans.

The product today starts with the artist profile. An artist connects Spotify, Jovie imports their catalog, builds their public profile and release surfaces, captures fans, creates links, and helps them accept tips. I am rebuilding onboarding around an AI-first interview so Jovie understands the artist before they land on a dashboard. The next step is moving from “showing artists a dashboard” to “doing label work for them.”

---

## Location

### Where do you live now, and where would the company be based after YC?

Los Angeles, CA. The company would remain based in Los Angeles after YC.

### Explain your decision regarding location.

Los Angeles is where my first users, network, and founder-market advantage are strongest. I have spent 15+ years in music as an artist, producer, marketer, and operator. I would be in San Francisco for the batch, then continue building from Los Angeles because the customer density is highest for the early market.

---

# Founders

### Founder

Tim White — solo founder.

### Please provide some details about the founder.

I have spent 15+ years in music as an artist, producer, marketer, and operator. I have played 500+ live shows, built my own release systems by hand, and had one of my songs generate 70M+ YouTube user-generated plays with no marketing budget. I also produced Hulu Pride Fest from my apartment during COVID, which won a Clio.

I am also the engineer. I built Jovie myself.

### Who writes code, or does other technical work on your product? Was any of it done by a non-founder?

I write the code. No employees, contractors, or agencies built the product.

### What tech stack are you using?

Next.js, TypeScript, Tailwind, Clerk, Neon Postgres, Drizzle, Vercel, Stripe, Statsig, Spotify API, Bandsintown, Venmo deep-link tipping, and the Vercel AI SDK. I use AI coding tools heavily, but all product work is founder-built.

### Are you looking for a cofounder?

Open to the right person, but I am not waiting for one. The product is already live and founder-built.

---

# Progress

### How far along are you?

Jovie is live.

An artist can create a free profile, connect Spotify, import their catalog, create release pages and smart links, capture fans, and accept tips. I launched tipping with a fast Venmo flow: a fan chooses an amount in Jovie, then the payment tray opens a pre-populated Venmo tip in the Venmo app. I chose this so artists could accept money immediately instead of waiting for a perfect payments stack.

Stripe Connect exists in the product but is still being stabilized, so I am not relying on it as the live payment path yet.

I discovered that 5 early users were having trouble creating accounts and getting activated, so I rebuilt onboarding from the ground up around an AI-first user interview. New users are now waitlist-gated while I dogfood the flow until it is good enough to reopen broadly.

### How long have you been working on this? How much of that has been full-time?

I built an earlier version in 2021, then stopped after a cancer interruption. I restarted from scratch on December 15, 2025 and have been full-time since.

### Are people using your product?

Yes. We have 5 users so far, including me using Jovie for my own music every day.

### How many active users or customers do you have? How many are paying? Who is paying you the most, and how much do they pay you?

We have 5 users so far. I am paying $39/month and using Jovie for my own music every day. I would count that as dogfooding revenue, not external customer validation. The honest external paid-user number is still zero.

### Do you have revenue?

Yes — $39/month from founder dogfooding. No external paid users yet.

### Where does your revenue come from?

Subscription software.

Artist profiles are free. The paid product starts at $39/month after a reverse 14-day trial. We also have a planned $199/month tier for artists who want heavier automation.

The free profile is the wedge. The paid product is the AI label-ops layer that helps artists keep releasing, engaging fans, and making money from the catalog they already have.

### Anything else you would like us to know regarding your revenue or growth rate?

I have deliberately constrained broad acquisition while fixing activation.

The important learning from the first 5 users was that the product cannot start as a blank dashboard. Artists need Jovie to interview them, understand their catalog and goals, and start doing useful work before asking them to configure tools.

That is why I temporarily waitlist-gated the product and rebuilt onboarding around an AI-first user interview. I am dogfooding the new flow with my own artist account before reopening.

---

# Idea

### Why did you pick this idea to work on? Do you have domain expertise in this area? How do you know people need what you’re making?

I picked this because I have done the job manually for 15 years.

The music industry already solved distribution. Any artist can get a song onto Spotify. The unsolved problem is what happens after that: keeping fans engaged, launching assets, selling merch, collecting contacts, following up, creating weekly moments, and turning a small catalog into a real fan-growth machine.

Most independent artists disappear for a year, make 4 songs, drop them all at once, tour for 6 months, then start over. With Jovie, the same artist and the same 4 songs can become 52 Fridays of drops. Fans keep hearing from the artist, and the fan flywheel starts compounding.

I know this problem because I lived it. I built my own music career through fan behavior, UGC, creator distribution, live shows, and release tactics. Jovie is the system I wish I had.

### Who are your competitors? What do you understand about your business that they don’t?

Our closest competitor is SymphonyOS. They are building music marketing automation: ad campaigns, landing pages, audience analytics, CRM, and AI-powered recommendations. Feature.fm and Linkfire are focused on smart links and music marketing campaigns. Linktree is the generic profile/link-in-bio layer. Shopify, Printful, Fourthwall, and Teespring handle commerce infrastructure.

What I understand from doing this manually for 15 years is that independent artists need label ops, not another dashboard.

The bottleneck is rarely whether an artist can technically sell merch, run a link page, or launch an ad. Those pieces already exist. The bottleneck is that the artist has to know what to do, set everything up, connect the tools, write the copy, design the merch, schedule the drop, follow up with fans, and keep doing that every release.

Merch is a good example. Shopify, Printful, Fourthwall, Teespring, and many others solved ecommerce infrastructure. The reason most independent artists still do not sell merch is that they do not have the time, taste, or money to get good designs made and launched. The bottleneck is the operator work before the storefront.

Jovie’s direction is to handle that work. If Jovie knows the artist’s catalog, visual identity, fans, and release calendar, it can say: “You don’t have merch yet. I made three designs. Reply 2 and I’ll schedule the drop for Friday and text your fans.”

SymphonyOS is a strong marketing automation product. Jovie is becoming the AI label operator for independent artists. The wedge is the free artist profile. The business is automating the release, fan, merch, and commerce work that a label team would normally do.

### How do or will you make money? How much could you make?

We make money through subscription software.

Artist profiles are free. The paid product starts at $39/month after a reverse 14-day trial. The next tier is $199/month for heavier automation.

There are hundreds of thousands of working independent artists who already pay for distribution, links, design, websites, marketing tools, beat licenses, merch, and promotion. Jovie starts as the free artist profile and grows into the operating layer that coordinates those workflows.

Long term, Jovie can expand into managers, indie labels, merch, fan commerce, and payment flows, but the first business is simple: artists pay monthly for AI label ops.

### How do users find your product? How did you get the users you have now? If you run paid ads, what is your cost of acquisition?

Founder-led distribution into working musicians, especially where I already have credibility and direct access. Product-led distribution through public artist profiles, release links, and fan-facing pages. Direct outreach to artists already paying for fragmented tools.

No paid ads.

### If you track metrics around user engagement and retention, what are they?

The current key metrics are:

- onboarding completion
- time to first live profile
- successful Spotify catalog import
- profile published
- first fan captured
- first link created
- first tip attempt
- weekly artist action created or completed

The first major learning from real usage was that account creation and onboarding were the bottleneck, so I rebuilt onboarding around an AI-first interview and waitlist-gated while I dogfood it.

### Where will most of your initial users be located?

United States first, starting with independent artists in Los Angeles and adjacent music communities where I already have founder-market access.

### Which category best applies to your company?

Consumer / Creator Tools / Music / AI

---

# Fundraising and legal

### Have you formed any legal entity yet?

Yes.

### Please list all legal entities you have and in what state or country each was formed.

Jovie Technology Inc. — Delaware C-Corp, incorporated December 15, 2025.

### Please describe the breakdown of the equity ownership.

Tim White: 100% common stock.

### Have you taken any investment yet?

Yes.

### List any investments your company has received.

$25,000 on a post-money SAFE at a $5M valuation cap.

### Are you currently fundraising?

Yes, but YC is the priority. If YC does not work, I will raise a small angel round.

### How much money do you spend per month / have in the bank / runway?

**Update this with exact current numbers before submitting.**

---

# Founder profile answers

### Please tell us about a time you most successfully hacked some non-computer system to your advantage.

In 2014, I realized YouTube Content ID rewarded artists who created usable supply for creators instead of trying to control every use. I released stems and instrumentals, encouraged creators to use my music, let remixers send me versions, officially released the best ones, and monetized the rest through Content ID. One video hit 40M views, and that system drove 70M+ total user-generated plays with no marketing budget.

### Please tell us in one or two sentences about the most impressive thing other than this startup that you have built or achieved.

I produced Hulu Pride Fest from my apartment with two weeks’ notice after COVID killed the live event. It streamed to 1.7M YouTube subscribers and won a Clio.

### Please tell us in one or two sentences about something impressive that each founder has built or achieved.

My debut single generated 70M+ YouTube user-generated plays with zero marketing budget. That taught me how music growth actually works outside the industry’s official channels.

---

# Previous application / what changed

### If you are applying with the same idea as a previous batch, did anything change?

Yes. The earlier version of Jovie was too close to an artist profile and smart-link product. The current version is much clearer: Jovie is AI label ops for independent artists.

The biggest learning came from watching the first 5 users struggle with account creation and activation. I realized the dashboard is downstream of the real problem. Artists need Jovie to interview them, understand their catalog and goals, and start doing useful work before asking them to configure anything.

Agent building has also changed dramatically since I started. Six months ago, this looked more like vertical SaaS for musicians. Now the product is shifting toward agents that can edit artist objects, create release assets, schedule drops, coordinate fan communication, and eventually run recurring fan and commerce workflows.

The current product is live. The long-term product turns 4 songs into 52 Fridays of artist drops.

---

# Why YC

### What convinced you to apply to YC?

YC is the best place for what I need next: pressure-tested help on activation, retention, distribution, and fundraising.

I have founder-market fit and a live product. I need to turn that into a repeatable company. The next phase is not adding more random features; it is proving that Jovie can take a small artist catalog and create weekly drops that keep fans engaged and help artists make money.

---

# Optional “other things to know”

Jovie is being built from an unusual founder position: I am the customer, the operator, and the engineer.

I have spent years doing the manual version of this work. I am now using Jovie for my own music every day and paying for it myself at $39/month. That is not external customer validation, but it is real dogfooding. I am building the product I need, using it on my own releases, and tightening it before reopening onboarding broadly.

The core insight is simple: independent artists already have enough tools. They need the work done. Jovie starts with the free artist profile and grows into the AI label operator that turns a small catalog into weekly drops, each scheduled, published, fulfilled when needed, and texted to fans.


**Topic:** [[chatgpt-clusters/code_review]]
