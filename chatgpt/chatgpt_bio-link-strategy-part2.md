
Mr. White,

Mostly yes. The biggest change is sequence.

With four weeks of runway, YC and Speedrun are upside, not the survival plan. YC’s on-time Summer 2026 deadline is **May 4 at 8pm PT** and on-time decisions come by **June 5**. YC also says to apply as soon as you’re ready and notes that if you’re actively fundraising, they invest as soon as a company is accepted. Speedrun’s current deadline is **May 17, 2026**, and they review applications every two weeks. That means neither program is dependable near-term cash for a company that needs to survive April. citeturn508729view1turn508729view0turn508729view2turn747943view0turn747943view2

So the plan should be **parallel, not sequential**:

1. launch today  
2. founder outbound tomorrow  
3. bridge fundraising starting now  
4. YC and Speedrun applications within the next 72 hours

The fundraising point is the important one. Do **not** wait to “go in on the investor meeting” after launch or after the YC application. Open a rolling SAFE now. If the target is $500k on a $5m post, fine, but take any real **$25k–$100k** checks immediately on the same terms. Optimize for closing speed, not elegance.

On GTM, your current scoring logic is **directionally right**, but I would tighten it. Paid Linktree, Feature.fm/Linkfire, retargeting pixels, and paid SoundCloud are good **willingness-to-pay** signals. The mistake would be treating “two paid tools” as sufficient by itself. I would only count a lead as truly qualified if the stack score is paired with a **timing signal**: release in the next 30 days, a drop in the last 45 days, or active touring. SoundCloud Pro alone is weak. A retargeting pixel or Feature.fm/Linkfire is much stronger. The fastest-converting segment is the artist already paying for the current mess and still sending fans through multiple hops. I couldn’t inspect the exact scoring code path from here, so this is a strategy answer rather than a literal code audit.

The biggest product risk is message drift. Your best thesis is still the one you wrote down: **always-on notifications instead of campaigns**, running through **one adaptive artist profile**. fileciteturn1file0 fileciteturn1file1 But the current homepage still leads with the broader release-system story — “Drop more music. Crush every release.” — and then splits attention across Artist Profiles, Release Destinations, and a Command Center. The repo docs also still define **Founding Member at $12/month**, **Pro at $39/month**, **Growth at $99/month**, with **Release Notifications marked Free+**, **contact capture free to 100 contacts**, and **pixels, verified badge, and tips** in Pro+. If you are implementing the new pricing/story today, make the homepage hero, pricing, feature gates, and onboarding all agree before GTM goes live. citeturn401766view0turn364112view3turn826129view0turn826129view1turn364112view1turn826129view5turn364112view7

That means I would make one tactical change to the launch: if you cannot fully rewrite the homepage today, send outbound traffic to a **dedicated artist-profiles / fan-notifications page** instead of the general homepage. Your email and landing page need to tell the exact same story.

On the outbound email, remove “would love your thoughts.” That asks for work. Ask for a concrete yes/no action.

Use something closer to:

**Subject:** built this because the current artist stack sucks

**Body:**  
Hey [Name] — I’m Tim, an artist building Jovie. I noticed you’re using [Linktree / Feature.fm / retargeting pixels]. I built Jovie because I hated sending fans through three layers of bio links and release pages. It gives you one artist profile that auto-updates for releases, tickets, tips, and fan notifications. If you want, I’ll import, verify, and set up your profile for free. Want me to do it?

That is much stronger than “thoughts,” because it offers immediate value and a clear next step. If you send these at scale, remember they are commercial emails, so use accurate sender information, a valid postal address, and a clear opt-out path. citeturn970314search0

For the next two weeks, I would freeze almost everything outside the launch wedge. Do **not** spend time on acoustic auto-spinoffs, extra AI asset generation, playlist automation, or anything else that does not directly improve:
- landing-page clarity
- signup/import speed
- activation tracking
- concierge onboarding
- paid conversion
- bridge fundraising

The current product already has enough surface area: public adaptive profile, release notifications, subscriber capture, Bandsintown sync, pixels, tips, and Spotify onboarding. That is enough to sell right now. citeturn826129view0turn826129view1turn364112view1turn364112view6turn364112view7turn826129view9

For YC, submit earlier than feels comfortable. YC explicitly says it’s a mistake to wait if you’re ready, and their FAQ says that if something material changes after submission, you can submit an update. That means the right move is: **submit once the story is coherent, then update with launch numbers**. citeturn508729view0turn252471view0turn252471view1

So the plan I would actually run is:

**Today:** launch the clearer page, unify pricing/copy/gating, turn on GTM events, start bridge outreach.  
**Tomorrow:** send founder-led outbound to the highest-scored switchers, onboard replies manually the same day.  
**Within 72 hours:** submit YC, submit Speedrun, keep investor outreach live every day.  
**This week:** measure reply rate, signup rate, activated profiles, and paid conversions — not just scraped leads.

The single most important change is this: **fundraising starts now**. Everything else is in service of giving investors and accelerators evidence that people want the product before you run out of cash.


we actually auto create the profiles. completely automated as part of the ingest. any lead thats qualified gets a profile created autoatmically and then queued for email. 

help me organize my thoughts here. what are the top things to get done.
look at jov.ie as it is now. look at my personal jovie profile jov.ie/tim

What needs to happen to prepare for the raise? What needs to happen to make the landing pages and profiles possible? What needs to happen for what needs to be shipped before any of that starts? What needs to be done before the YC application goes in? 


I’m checking the live site, your profile, and the repo side by side first, then I’ll turn that into a strict priority order for launch, raise prep, and YC.


I’ve confirmed the core gap: the homepage still sells three products at once, and `jov.ie/tim` is too thin to prove the profile story. I’m checking the repo’s scoring, gating, and current surfaces now so the ship order matches what’s already real.


Mr. White,

Yes. Here is the order I would run.

The live homepage still sells three products at once: adaptive profiles, release destinations plus notifications, and a release command center. It opens with “Drop more music. Crush every release,” then moves through “Profiles that convert,” “Share every release. Reach every fan. Automatically,” and “A command center for your career.” citeturn769715view0

Your live `jov.ie/tim` profile does not yet prove the wedge. Right now it shows “Tim White,” “YC Accepted Me!,” a Listen CTA, and duplicated Powered by Jovie / footer links. It is too bare for cold outreach, investor click-through, or YC reviewer clicks. citeturn769715view3

The good news is the product already supports most of the story you want to tell. The docs describe a public profile at `jov.ie/{username}` with `/listen`, `/subscribe`, `/contact`, `/about`, `/tour`, and `/tip`, plus release notifications, subscriber capture, contact export/CRM, Bandsintown sync, retargeting pixels, tips, and AI/tool-use expansion. The repo also already defines canonical homepage, public-profile, and release-landing surfaces for review. citeturn518801view1turn518801view2turn770843view2turn770843view1turn518801view5turn655544view5turn655544view6

Your own notes are already converging on the right framing: the outside story is one adaptive artist profile plus opinionated notifications; the inside story is the release operating system and automation layer. That is the split to keep. fileciteturn1file1 fileciteturn1file0

The biggest risk right now is drift. Internal docs still list Free / Founding Member / Pro / Growth, still include “Remove Jovie Branding” as a Pro+ feature, the homepage still says “No credit card required,” and the Terms page still says Jovie is currently free for all creators. If you are turning on paid now, these need to agree immediately. citeturn552837view0turn518801view3turn769715view0turn699937search0

## The top things to get done

### 1. Freeze the wedge
Pick one sentence and make the whole company repeat it.

I would use:

**Jovie gives artists one profile link that updates itself and automatically notifies fans when new music drops.**

Everything else is underneath that:
- artist profile is the surface
- notifications are the compounding mechanic
- release ops / AI is the expansion layer

Do not lead the homepage, investor deck, or YC app with the full automation stack. Lead with the simplest visible behavior.

### 2. Ship one “golden path” that actually works
Before more GTM, one end-to-end path must feel inevitable:

**auto-created profile → claim profile → connect / verify → turn on notifications → fan subscribes → release notification goes out → listener clicks to stream**

That is the product. That is also the demo.

Because you auto-create profiles, the profile preview is the primary conversion surface for outbound. The homepage is secondary. Your cold email should push people to **their already-created profile preview** with a clear claim CTA, not to a general homepage.

### 3. Make the auto-created profiles good enough before claim
This is the must-ship item before volume.

Every generated profile needs:
- artist name
- avatar / art
- short bio or clean fallback
- latest release with working listen CTA
- empty sections hidden
- obvious claim / correct / remove path
- no embarrassing placeholder copy

Right now `jov.ie/tim` is not doing that job. It needs to become the standard bearer or you need a separate canonical demo artist. citeturn769715view3

### 4. Split the surfaces by job
You need three different surfaces, each with one job.

The homepage should explain the company in 10 seconds.

The artist-profiles page should sell the adaptive profile and notifications story.

The personalized profile preview should convert outbound leads into claimed accounts.

Do not force one page to do all three.

## What needs to ship before the landing pages really work

The landing pages are only believable if these are live:

A real adaptive profile state. Upcoming release countdown or current-release hero.  
A real notify flow. Fan subscribes, then receives the release email. The docs already describe release notifications and profile subscribe surfaces, so this should be shown, not described. citeturn518801view0turn518801view1

A real contact surface. Your differentiated artist contact-team story matters. The docs already support contact pages and CRM/contact roles, so surface that in the profile story. citeturn518801view2turn770843view2

A real tip surface. Tipping is strong lower on the page once the core profile works. The docs already define `/tip` and tracked tip flows. citeturn770843view1turn518801view4

A real tour fallback. Bandsintown sync is already in the product, so the profile should either show local dates or gracefully fall back to music. citeturn518801view2

A real branded trust stance. If Jovie branding is meant to be part of the trust layer, stop selling “remove Jovie branding” as a major product value. The docs still frame white-labeling as Pro+, which conflicts with your current thinking. citeturn518801view3

## What needs to happen before GTM really starts

Turn on measurement first. You need one daily view with:
- qualified profiles created
- emails queued and sent
- open rate
- reply rate
- claim rate
- Spotify connect / import rate
- subscriber opt-in rate
- paid activation rate

That is the scoreboard for the company, the raise, and YC.

Then QA the first batch manually. Even with full automation, you should hand-check the first 20 to 30 profiles and the emails that go out. One ugly auto-created profile or one wrong artist match destroys trust faster than any design polish problem.

Also get the email basics right. Cold outbound and most product marketing emails are commercial email, so use truthful sender info, a valid postal address, and a working opt-out path. The FTC guidance is explicit on this, and it also warns against casually treating mixed promotional emails as purely transactional. citeturn750895search0

## What needs to happen to prepare for the raise

You do not need a polished brand system. You need proof.

Prepare these in parallel:

A 6-slide investor deck or memo:
- problem
- product
- why now
- traction
- GTM
- ask / use of funds

A 60–90 second product demo video:
- auto-created profile
- claim flow
- notification setup
- fan notification
- listener lands on stream page

A live traction snapshot:
- how many qualified profiles generated
- how many claimed
- how many subscribers captured
- how many notifications sent
- how many paid activations

A clear fundraising setup:
- SAFE open now
- standard terms
- minimum close you will actually take
- list of investors to contact this week

The raise is won by showing that this wedge already works, not by describing the full future AI roadmap.

## What needs to happen before the YC application goes in

Before YC, I would require only four things:

A coherent story.  
A live product that matches the story.  
A short demo video.  
A few real metrics from launch / outbound.

That is enough.

YC’s current Summer 2026 on-time deadline is May 4 at 8pm PT, they encourage founders to apply as soon as they are ready, and their FAQ says you can submit an update later if something material changes after submission. That means you should submit once the wedge and demo are coherent, then append traction updates as they come in. citeturn256984search0turn256984search1

## The dependency order

Before anything else:
1. Freeze the one-sentence wedge.
2. Make one golden-path profile + notification flow work end to end.
3. Align pricing, terms, and billing copy.

Before broad GTM:
4. Make auto-created profiles claimable, accurate, and presentable.
5. Turn on daily funnel tracking.
6. Send outbound to the personalized profile preview, not the generic homepage.

Before investor meetings:
7. Record the short demo.
8. Build the traction snapshot and memo.
9. Start rolling fundraising immediately.

Before YC submit:
10. Tighten the app answers around the wedge and submit early.

The practical answer is this:

**Your next job is not “clean up the homepage.” Your next job is “make one auto-created profile and notification flow so good that it closes both users and investors.”**

I would treat the next 48 hours as:
- one sentence
- one perfect profile
- one perfect notification flow
- one claim funnel
- one metrics dashboard
- one short demo video


ok so what does the homepage look like? its different the artist profile landing page correct?


I’m checking the live homepage and your profile side by side, then I’ll separate each page’s job and turn that into a concrete homepage structure.


Yes—the homepage and the artist-profile page should do different jobs. I’ve confirmed the homepage still tries to explain the whole system, and I’m checking the live profile plus canonical surface docs to make the split concrete.


Mr. White,

Yes. Different job, same thesis.

The clean split is:

**Homepage** = explains the company  
**Artist Profiles page** = sells the wedge  
**Actual artist profile** = converts the fan

Right now the live homepage is doing all three at once. It leads with “Drop more music. Crush every release,” says the artist page, release page, and workflow all run in one system, then gives equal weight to “Profiles that convert,” “Share every release. Reach every fan. Automatically,” and “A command center for your career.” That is why it feels broad instead of sharp. citeturn151218view0turn495076view0

Your own notes already point to the clearer wedge: one bio link that becomes the right surface automatically — countdown before release, listen after launch, local tour dates when relevant, contact when needed, tip flow when live — plus Jovie-branded notifications that run automatically instead of campaigns. fileciteturn1file1 fileciteturn1file0

## What the homepage should be

The homepage should say:

**Jovie turns one artist profile into an always-on release system.**

That means the homepage is broader than the Artist Profiles page, but only slightly broader.

I would make the homepage structure:

**Hero**  
Eyebrow: *The link your music deserves*  
H1: **One profile link. Automatic fan notifications. Every release.**  
Subhead: Put one Jovie link in your bio. Before a drop it becomes a countdown. On release day it becomes the best place to listen. When fans subscribe, Jovie notifies them automatically.  
CTA: **Claim your profile**  
Secondary CTA: **See artist profiles**

**Problem section**  
Show the broken stack:
Instagram bio → Linktree → smart link → DSP  
Then show:
Instagram bio → Jovie → notify / listen / tickets / tip / contact

**One profile, different modes**  
This is the strongest section. Four states:
- upcoming release
- out now
- local show
- no campaign / catalog mode

**Fan notifications**  
This is the second pillar.  
Fans subscribe once. Jovie handles the rest.  
No campaigns. No template builder. No switching tools.  
This is where you show the Jovie-branded email / notification system. fileciteturn1file0

**Under the hood**  
Only here do you mention the ops layer:
- imports releases
- keeps links updated
- tracks launch tasks
- builds the release system behind the profile

This is where the current “command center” section belongs. Lower on the page, not in the hero. The current site already has the material for this section. It just should not be the opening story. citeturn151218view0turn495076view0

**Pricing / CTA**  
Free profile  
Paid notifications / release system  
Final CTA: Claim your profile

## What the Artist Profiles landing page should be

This page is narrower.

It should not try to explain the whole company. It should just answer:

**Why should an artist replace Linktree / Linkfire / Laylo with Jovie?**

So that page should be:

H1: **One artist profile that updates itself**  
Subhead: One link in bio that turns into the right page for every release.

Then:
- upcoming release countdown
- out now smart listen page
- local tour fallback
- contact team for booking / brand deals
- tip flow and supporter capture
- fans subscribe once, then get notified automatically

That page is basically the clearest version of the story you wrote out in your notes. fileciteturn1file1

## What the actual artist profile is

This is separate from both.

The actual profile should not explain Jovie much at all. It should just do the job:
- show the primary CTA
- show more music
- show tickets if relevant
- show contact
- show tip

That page is product, not marketing.

## What I would do today

Because you are moving fast, I would **not** build two fully different narratives today.

I would make the homepage mostly the Artist Profiles story, then keep one lower section for “the system behind it.”

So the fast version is:

1. rewrite the hero around the adaptive profile + notifications  
2. remove task-list / command-center emphasis from above the fold  
3. keep profiles as the main story  
4. keep notifications as the second story  
5. move release ops lower down as supporting infrastructure  
6. let outbound go to personalized claim pages, not the homepage

So yes, they are different conceptually.

But for this launch, the homepage should be **homepage + artist profiles page merged**, with the broader ops story pushed lower on the page.

That gives you one sharp story instead of three competing ones.


give me a spec for the putch deck. make each slide STUPID CONCISE.
like a sentence on each slide or 3 bullet points and thats it.
https://www.youtube.com/watch?v=lw2X3PxKlAY <- this is the gold standard on how to build this.
make it simple. make it clean. make it modern. follow every single tip from the video i shared.


Mr. White,

**Deck thesis:**  
**Jovie replaces the broken artist stack with one adaptive profile and automatic fan notifications.**

The deck should be narrower than the homepage. The site currently sells artist pages, release pages, and a command center at once; the deck should sell **adaptive profile + notifications** first, with release ops presented later as the engine underneath. That is the clearest thread in your notes and the sharpest investor story. citeturn3view0L3-L5turn3view0L61-L63turn3view0L102-L104turn3view0L134-L166 fileciteturn1file0 fileciteturn1file1

Seibel’s rules are the right rules: **say what the company does immediately in two sentences, use a specific example, keep only real traction, order the middle slides by what is most impressive, ask directly for money and the milestone it buys, and keep the slides visually boring.** The deck is a prop for conversation, not a book report. citeturn2view0L67-L77turn2view0L81-L84turn2view0L92-L106

## Jovie seed deck spec

### Slide 1 — What we do
**H1:** Jovie is an always-on release system for artists.  
**Body:** We replace Linktree, smart links, and campaign tools with one profile link that updates itself and automatically notifies fans when new music drops.  
**Visual:** one clean phone mock of the artist profile.

### Slide 2 — Specific example
**Body:** A fan clicks `jov.ie/artist`; before release day they see a countdown and subscribe, and on release day the same link becomes the listen page and Jovie sends the notification.  
**Visual:** one before/after flow, nothing fancy.

### Slide 3 — Why this wins
- Every extra click kills conversion  
- Campaign tools die between drops  
- Artists need one always-on system

### Slide 4 — Product
- Adaptive artist profile  
- Automatic Jovie-branded fan notifications  
- Release ops running underneath

### Slide 5 — Traction
- `[X]` qualified artist profiles auto-created in `[Y]` days  
- `[A]%` claimed / `[B]%` activated  
- `[C]` paid artists / `[D]` fan subscribers

**Rule:** if these numbers are weak, delete this slide entirely. citeturn2view0L81-L84

### Slide 6 — Team
- Tim White — artist/founder  
- `[Name]` — `[role]`  
- one hard credential each, no life story

### Slide 7 — Market + model
- Start with artists already paying for 2+ tools in the stack  
- `$39/mo` per artist for notifications; more for ops automation  
- `[target artists] × [$39/mo] = [wedge ARR]`

### Slide 8 — Ask
- Raising **$500k** on a **$5m post** SAFE  
- **$25k** already in  
- Goal: reach `[X]` paid artists, `[Y]` subscribers, `[Z]` notifications/month

## Slide order rule

After slide 1, move the strongest real proof earlier.

**Default for you right now:**  
1. What we do  
2. Example  
3. Why this wins  
4. Product  
5. Traction  
6. Team  
7. Market  
8. Ask

**If traction gets real before meetings, move Traction to slide 2.**  
That is exactly how Seibel says to structure the middle: most impressive first. citeturn2view0L96-L99

## Style spec

- No title-only cover slide  
- White background  
- Black text  
- One accent color max  
- One font family  
- Huge type  
- One idea per slide  
- One screenshot max per slide  
- No gradients  
- No animations  
- No dense charts  
- No cute icons  
- No mockup collage

Modern here means **spacing + typography**, not decoration. Seibel is explicit that visually boring wins because the investor should focus on you, not the slide. citeturn2view0L104-L106

## What to cut

Do **not** include:
- mission slide
- vision slide
- roadmap slide
- competition matrix
- feature grid
- advisor slide
- TAM report screenshot
- “the link your music deserves” as the main H1

That slogan is landing-page copy. The deck needs investor language, not customer language. Seibel explicitly says the investor version of “what you do” should be simpler than homepage copy. citeturn2view0L73-L75

## Presentation spec

- First pass should take **2–3 minutes**
- Then stop and let them talk
- If they bite on something, jump there
- End by asking for money plainly

That is the whole game: concise, clear, conversational, direct. citeturn2view0L92-L103

## One-line version of the whole deck

**Jovie gives artists one profile link that updates itself and automatically notifies fans when new music drops.**

That should be the spine of every slide.


So a couple of questions:

1.  On the profile mark, would you show a link tree, like show a link tree of an actual artist's link tree, and then show the profile we created for them on Jovie and show the before and after, just side by side for that slide?
2.  The second thing would be: do you use me as the artist as an example, or do we use an actual artist, or do we use someone actually on Jovie? I am an artist, so I do have an actual profile and actual music to share.

a huge way i think about this is that artist try to think in "campaigns" which works for beyonce or taylor swift. it does not work for anyone else. including major label acts who are tier 2. 
the internet and algorithm reward consistency so the only way to play the game is to be "aleays on"

its the heart beat chart vs the up and to the right hockeey stick.
also becuase our emails are "notifications" The transactional nature versus marketing: the deliverability rates are significantly higher. It's like the whole thing of how the community tried to do SMS as a two-way thing. Lalo figured out it should be a one-way thing. We figured out it should be a transactional thing, so if it's a one-way thing but it's still customizable, the spam filters start kicking in. If it's an automated transactional email notification coming from a trusted platform, then deliverability is high. 
So anyone who is currently using a link tree and then pointing to feature FM, or using MailChimp to send out, is going to have all these deliverability problems. I actually did email marketing for the New Jersey part of the Bernie Sanders campaign. Actually, I forgot to mention that in my YC application, but the email marketing angle I think it's a unique insight: just the deliverability becoming a massive thing. It's not just deliverability, but it's a double plus, because by increasing the deliverability, by removing customization, you remove the customization, which means you remove manual work. There's no manual work.

It's kind of dumb that everyone's doing it this way, because if they're releasing every month (which DJs release very frequently), that's why they are our target demo first, because they release more frequently, because they have remixes and all kinds of stuff and mixes and stuff that come out constantly. They tend to have exponentially more releases than traditional artists because they're doing it that way. They're constantly shipping, but they're having to go and just manually rewrite the same email every month, and it's insane. I don't know if anything there strengthens this, but if it does, add it. It's not in time. And then I don't know that you have access to some info in the repo on me. I don't know what facts you want to use there:
- whether it's being an artist on Armada
- whether it's my first single doing 70 million streams
- whether it's me driving 90 million streams to music all monetized
- whether it's my first single being licensed by Universal
Any of these things, I don't know what should go in there. I also don't know if it's worth throwing a stack of logos of all the brands that I've worked with and all the labels I've worked with and all that shit. Also, my first internship was doing all this for a DJ. 


I


I’m checking the live pages, the strongest founder-proof facts already documented, and the safest way to frame the deliverability claim so I can give exact deck choices.


I’ve got the core call: use one concrete before/after product example, and keep the “always-on beats campaigns” insight as the reason it matters. Your live profile is too bare to serve as both product proof and founder proof, so I’m separating those and only using publicly defensible founder facts.


Mr. White,

1. **Yes, but make it a stack-replacement slide, not a design-comparison slide.**  
Seibel’s rule is clear: say what the company does simply, use one specific example, and keep the slides visually boring enough that the investor focuses on the point instead of the design. Your live homepage still sells three things at once, and your current `jov.ie/tim` page is still too thin to carry the full product story by itself. citeturn288982view0turn533936view0turn362928view0turn362928view1

The best version of that slide is:

**H1:** One link replaces the whole artist stack  
**Left:** Instagram bio → Linktree → Feature.fm  
**Right:** Instagram bio → Jovie  
**Caption:** Same artist. One link that changes from countdown to listen page and notifies fans automatically.

If you want screenshots, use **one cropped public “before”** and **one clean Jovie “after.”** Do not show full desktop pages. Crop hard. Label only **Before / After**. The point is fewer hops and always-on behavior, not prettier UI. Your own notes already define that wedge clearly. fileciteturn1file1

2. **Use a real artist on Jovie for the product slide. Use yourself on the team slide.**  
Because your current `jov.ie/tim` page only shows your name, “YC Accepted Me!,” and a Listen CTA, it is not yet the strongest proof artifact. Until that page shows the actual wedge — release state, notify, contact, maybe tour — I would not use it as the main product example. citeturn362928view1

The order I’d use is:

- **Best:** a real DJ / artist already on Jovie whose old public stack is obviously messy and whose Jovie page is obviously better  
- **Second-best:** you, after `jov.ie/tim` is fixed to show the real product  
- **Worst:** a fake artist example

Your wedge is DJs and frequent-release artists anyway, so the example should look like your target customer, not a generic singer-songwriter. That also matches your always-on thesis. fileciteturn1file0

3. **Your strongest added insight is “campaigns are dead for most artists.”**  
That is a real pitch-strengthener. It is sharper than “better link in bio.” The clean investor version is:

- Superstar artists can run campaigns  
- Most artists grow through consistency  
- DJs release too often to rebuild a campaign every month  
- Jovie turns release marketing into always-on infrastructure

I would make that your **Unique Insight** slide. The “heartbeat vs campaign spikes” line is good **spoken language**, but I would not make it a chart in the deck. Seibel says only use graphs when they are real traction and clearly impressive. citeturn533936view0 fileciteturn1file0

4. **Your deliverability point is good, but the framing needs to change.**  
Do **not** pitch this as “transactional email so we bypass marketing rules.” The FTC treats transactional/relationship categories narrowly, and mixed promotional content can still count as commercial email. Mailchimp makes the same distinction, and providers like Postmark explicitly separate transactional and broadcast streams to protect sender reputation. citeturn533952search0turn284886search0turn273719search4

The pitch version should be:

**Jovie sends standardized, opt-in notifications from one trusted sender.**  
That does three things:
- improves operational reliability
- reduces manual work
- keeps sender reputation cleaner than ad hoc campaign blasts

That is a strong product insight. It is also legally safer and easier to defend. Deliverability is driven by sender reputation and sending practices, so this is a credible systems argument without overclaiming the legal category. citeturn284886search3turn273719search4

5. **Do not use a wall of logos.**  
Seibel is explicit that distracting slides hurt you. A logo salad makes the investor look at decoration instead of evidence. Put the names in one bullet if you need them. Three names in text beats twelve logos. citeturn533936view0

6. **These are the founder facts I would actually use.**  
Your official bio already supports the strongest clean bullets: 500+ shows, 70M+ UGC streams from “Take Me Over,” five singles signed to Armada Music, and work for Netflix, Google, and Hulu including a Clio-winning Hulu Pride Fest contribution. citeturn195564view0

So your team slide should read:

**Tim White — CEO / artist / builder**  
- 500+ live shows; first single drove 70M+ UGC streams  
- 5 singles signed to Armada Music  
- Wrote / produced for Netflix, Google, and Hulu; Clio-winning work citeturn195564view0

If the Bernie/email-marketing fact is clean and documentable, it is actually **highly relevant** because it directly supports the deliverability insight. I would consider swapping it in for one of the entertainment-brand bullets **only if you can back it up immediately**. I was able to verify the music/brand accomplishments above from your public bio; I did not find a clean public source for the Bernie point in the sources I checked.

So the clean answer is:

- **Yes** to before/after, but show **stack replacement**, not just nicer design  
- **Use a real Jovie artist** for the product example  
- **Use yourself** on the team slide  
- **Lead the insight slide** with “campaigns are dead; always-on wins”  
- **Call the emails standardized opt-in notifications**, not transactional marketing loopholes fileciteturn1file0

The exact slide I would rewrite next is your **Unique Insight** slide:

**Campaigns work for Beyoncé.**  
**Most artists need always-on release infrastructure.**  
**Jovie turns one bio link and one subscriber list into automatic fan notifications.**


i did the bernie email work through a super pac.
but my contractor was in direct contact with the campaign. i worked on probably 10 differnt political campaigns but most were small new kersey camapigns. i did ad buying, retargeting, and email marketing for them. my dad is a political consultant and would hire me to do that stuff for him. One of the big insights from all of that was that they'd be one-off campaigns, and the email lists often were passed around. The DNC would provide us a list or something for it, but then the candidate would be different all the time. These were like these campaigns, and then they would send them cold. Nothing would happen with that list for like two years, and then all of a sudden we hit again and it had obviously horrible deliverability.

The thing that I always tried to push through was building longer, ongoing messaging prior to the campaign. By the time the campaign came around, the list was warm, and we had removed all of the honey trap and gotten the deliverability rates up. We had done all the filtering for engagement and stuff and figured out where the engagement groups were to segment out when we needed to. Once the campaign hit, things just did a lot better with deliverability. Because politics are kind of worse than music and how infrequent the campaign cycles are 


I’m grounding this in the live site, your docs, and current comps so I can separate the simple public story from the ops layer. Then I’ll collapse it into one clear thesis, pricing logic, and investor narrative you can actually ship.


I’ve got the synthesis now: one company, two layers. The homepage is still mixing three stories, but the clean move is to sell the simple public promise first and let the deeper automation engine sit underneath.


## See Also
- [[chatgpt/chatgpt_ai-first-company-strategy-part2]]
- [[chatgpt/chatgpt_ai-ops-prioritization-strategy-part2]]
- [[chatgpt/chatgpt_bio-link-strategy-part1]]
- [[chatgpt/chatgpt_bio-link-strategy-part3]]
- [[chatgpt/chatgpt_code-cleanup-strategy-part2]]
