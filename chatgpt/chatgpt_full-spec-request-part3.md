
Mr. White,

Yes: **do YC first, no code before submission.** YC says Summer 2026’s on-time deadline was **May 4 at 8pm PT**, but late applications are still considered, and they specifically encourage applying as soon as you’re ready. citeturn250532search0turn250532search2

The application should say one thing clearly:

> **Most music software helps artists measure their career. Jovie operates the catalog and makes it earn.**

That is the center of the pitch.

YC’s own application advice is to be exceptionally clear, concise, and matter-of-fact. Paul Graham specifically says the first answer should explain what the company makes in simple terms, without marketing-speak. citeturn250532search5

# Demo strategy

There are two separate videos.

## 1. YC founder video

This is **not** the demo. YC says the application video should be **1 minute**, contain **only founders talking**, and should not be a demo or promotional video. They also say to use bullet points rather than reading a script. citeturn250532search1

Use webcam. No music. No app footage. No fancy edit.

### Founder video bullets

Say this naturally:

> “I’m Tim White, founder of Jovie. I’m an artist and software founder building Jovie because I have the problem myself: I have a music catalog, but most of the work required to monetize it never happens.”
>
> “We originally built Jovie as an operating system for artists: catalog, tracks, audience, public profiles, and fan notifications. The big learning was that release management is the wrong wedge. Artists release too infrequently. The stronger wedge is helping them make money from music they already made.”
>
> “Jovie is now an AI revenue operator for music catalogs. It imports an artist’s catalog, finds revenue opportunities, texts the artist for approval, then executes: short-form content, fan messages, merch drops, outreach, and performance tracking.”
>
> “Most music software helps artists measure their career. Jovie operates the catalog and makes it earn.”

That’s the founder video.

## 2. Product demo video

This can be the Loom/Playwright recording with your voiceover.

Target length: **90 seconds**.  
No need for music.  
Clean voiceover beats fancy editing.

The point is to show that you already built enough substrate for the pivot.

# Product demo storyboard

## 0:00–0:08 — cold open

Screen: Jovie homepage or app dashboard.

Voiceover:

> “Jovie is an AI revenue operator for music catalogs. Most music software helps artists measure their career. Jovie operates the catalog and makes it earn.”

## 0:08–0:25 — show the existing OS

Screen: library view → track view → audience view.

Voiceover:

> “We already built the music operating system: artist profiles, song libraries, track-level context, audience data, and fan notification infrastructure.”

What the Playwright recording should show:
- open app
- go to library
- click artist or track
- show song metadata / smart chips / DSP-style context
- show audience view

## 0:25–0:42 — show the learning/pivot

Screen: track page with a song.

Voiceover:

> “The original product helped artists manage releases. The learning was that releases are too infrequent. The better product is: take songs that already exist and turn them into daily revenue actions.”

This directly matches the strongest insight in your note: the pitch changed from “release more music” to “make more money from music you already made.” fileciteturn0file0

## 0:42–1:05 — show the text-first workflow

Screen: chat/onboarding or mock text flow.

Voiceover:

> “The artist texts Jovie. Jovie finds their catalog, proposes one action, and asks for approval. For example: ‘Your song X has the right energy for a short-form video. I made three variants. Reply 1, 2, 3, tweak, or reject.’”

What the Playwright recording should show:
- chat page or onboarding
- artist identification
- suggested action card
- generated variants
- approval/reject/tweak affordance if available

If the UI does not have this yet, show a simple static card or prefilled chat message. Do not code a full feature today.

## 1:05–1:25 — show execution

Screen: content calendar / notification / profile / output asset.

Voiceover:

> “After approval, Jovie executes: posts the short-form video, sends a fan message, prepares a merch drop, or drafts outreach. Every action is tied back to performance.”

What Playwright should show:
- content calendar
- scheduled item
- fan notification
- public profile
- sample generated post or asset

## 1:25–1:35 — close

Screen: dashboard/profile.

Voiceover:

> “We’re starting with my own catalog and a few warm manager and catalog pilots. The goal is simple: prove Jovie can make dormant catalogs earn more money.”

End.

# What to update in the Playwright recording

Do **not** rewrite the app before YC. Only update the recording route.

The automated demo should hit this path:

1. `/` or app landing
2. Library view
3. Artist profile
4. Track view
5. Audience view
6. Chat/onboarding view
7. Content calendar or notification flow
8. Public artist profile
9. Final title card:  
   **Jovie operates the catalog and makes it earn.**

If you can add overlay captions in the video generation step, use these:

1. “Import the catalog”
2. “Understand each song”
3. “Know the audience”
4. “Recommend revenue actions”
5. “Get approval by text”
6. “Execute”
7. “Measure what worked”
8. “Improve the catalog”

That is enough.

# Demo assets to prepare today

Use your own catalog.

Pick:
- 1 artist profile: you
- 3 songs
- 1 fan/audience screen
- 1 public profile
- 1 proposed action

The proposed action should be concrete:

> “Jovie found that this song has the best short-form potential. She created three video concepts and one fan message. Tim approves variant 2. Jovie schedules it for TikTok, Reels, and Shorts.”

The demo does not need to actually post to TikTok today. It needs to show the loop.

# YC application: exact pitch language

Below is the language I’d use.

## What is your company going to make?

**Jovie is an AI revenue operator for music catalogs.**

Artists connect their catalog and public profiles. Jovie finds ways to make that catalog earn more money, texts the artist for approval, and executes the work: short-form content using their songs, fan messages, merch drops, outreach, and performance tracking.

Most music software helps artists measure their career. Jovie operates the catalog and makes it earn.

## What does your company do?

Jovie helps artists, managers, and indie labels make more money from music they already own.

The product starts as a text-first agent. An artist texts Jovie, Jovie identifies their artist profile and songs, then starts recommending revenue actions. Example: “Your song X is underused. I made three short-form video ideas and a fan message. Reply 1, 2, 3, tweak, or reject.” Once approved, Jovie executes the workflow and tracks results.

Under the hood, Jovie is a music-specific operating system: catalog, tracks, artist context, audience, fan notifications, public profiles, and automation. The first wedge is catalog monetization because artists already made the music; the missing piece is an operator that turns those assets into daily revenue-generating actions.

## Why did you pick this idea?

I’m an artist with my own catalog, and I have lived the problem.

The music industry is full of dashboards that tell artists what happened: streams, followers, audience, release stats. That is useful, but passive. Artists need something that acts on the catalog: makes content, contacts fans, prepares merch, creates outreach, and learns which actions produce revenue.

We initially built Jovie as an operating system for artists to manage songs, releases, audience, profiles, and fan notifications. The biggest learning was that release management is too intermittent as a wedge. Artists do not release often enough. The better opportunity is helping them make money from music they already made.

## What have you built?

We have built the core music operating system:

- desktop/web app that also works as a Mac app
- artist library view
- track view
- audience view
- public artist profiles
- smart music context/chips
- fan notification infrastructure
- chat/onboarding surfaces
- internal workflow infrastructure

This gives us the substrate for the new product: Jovie can know an artist’s catalog, understand their songs and audience, recommend revenue actions, and eventually execute them.

## What have you learned from users?

Our original thesis was that artists needed better release and fan notification tooling. That was partly true, but too narrow. The deeper user need is monetization.

Artists do not want another dashboard. They want help turning existing songs into money. The strongest user reaction comes when we frame Jovie as an operator: “you already made the music; now Jovie helps make it earn.”

We are now dogfooding Jovie on my own catalog and lining up pilots with managers/catalog owners who already control music assets.

## Who are your customers?

Initial customers:
- independent artists with released catalogs
- managers with multiple artists
- indie labels with under-monetized catalog
- producers/songwriters with released songs
- small catalog owners

The best first customers are managers and catalog owners because they already think in terms of monetizing assets, not just releasing songs.

## How will you make money?

Initially, concierge pilots:

- $1,000/month per artist/catalog
- higher-priced manager/label plans for multiple artists
- optional performance-based upside later

Long term:
- SaaS subscription for individual artists
- team plans for managers/labels
- revenue-share or performance fee on specific monetization workflows
- eventually catalog financing/acquisition opportunities once we can prove repeatable uplift

## What is your insight?

The music-tech market is overbuilt around measurement and underbuilt around operation.

Artists have dashboards for streams, followers, audiences, and releases. Those tools tell them what happened. They do not wake up every day and do the work required to make the catalog earn.

The second insight is that releases are the wrong center of gravity. A release happens occasionally. A catalog exists every day. The product should operate the catalog every day.

## Why now?

AI agents can now coordinate the pieces that used to require a team: understanding a catalog, generating content, writing fan messages, creating merch concepts, drafting outreach, scheduling posts, and reading performance data.

At the same time, short-form video has made old songs monetizable again. A song does not need a new release cycle to earn. It needs the right repeated actions around it.

## Who are your competitors?

Current alternatives:
- artists do it manually
- managers/labels hire social media teams
- tools like Linktree/Feature.fm/ToneDen/Chartmetric/Soundcharts/Spotify for Artists help with links, campaigns, or analytics
- distributors provide limited dashboards and marketing add-ons

Jovie is different because it is an operator, not just a dashboard. The goal is to execute revenue actions, not just report metrics.

## How big can this get?

Recorded music is a massive global market, and every released song is an under-operated asset. The first market is independent artists and small catalog owners. The larger opportunity is becoming the operating layer for music catalogs: content, fans, merch, outreach, analytics, and monetization.

If Jovie proves it can reliably increase catalog revenue, it can expand from software into performance pricing, manager/label tooling, and eventually catalog investment.

## Why you?

I am both the builder and the first user. I have a music catalog, I have artist relationships, and I have already built the core product surfaces required to operate a catalog.

I also know the industry from the inside. I have released music, worked with labels, and understand how fragmented the artist workflow is. That lets me build a product that feels native to artists rather than generic AI automation.

## What is the current status?

We have built the operating-system substrate and are now focusing the product around the strongest wedge: catalog monetization.

Next steps:
- submit YC
- demo the existing catalog/audience/profile/chat infrastructure
- run Jovie on my own catalog
- launch 2–3 concierge pilots with warm artist/manager contacts
- prove that daily revenue actions can produce measurable outcomes

# The YC one-liner

Use this everywhere:

> **Jovie is an AI revenue operator for music catalogs.**

Expanded:

> **Artists connect their catalog. Jovie finds ways to make it earn more money, gets approval by text, then executes.**

Killer line:

> **Most music software helps artists measure their career. Jovie operates the catalog and makes it earn.**

# The demo one-liner

> “This is not the final product UI. This is the operating system we already built. The pivot is that Jovie now uses this context to operate the catalog and generate revenue.”

That preempts the obvious objection that the existing UI looks broader than the pitch.

# The exact YC demo description

Use this in the demo field:

> This demo shows the substrate we have already built: an artist catalog, track pages, audience view, public artist profile, fan notification infrastructure, and chat/onboarding. The product is now being focused around one workflow: Jovie identifies revenue opportunities in an artist’s existing catalog, texts the artist for approval, then executes actions like short-form content, fan messages, merch drops, and outreach.

# Founder video versus product demo

Do this:

- Founder video: webcam only, 1 minute, no music, no app footage.
- Product demo: Loom/Playwright recording, 90 seconds, voiceover acceptable.

YC explicitly separates the founder application video from the product demo; the founder video should only show founders talking. citeturn250532search1

# My recommended order right now

1. Record founder video.
2. Generate Playwright product demo from current app.
3. Record voiceover in one take.
4. Submit YC.
5. Clean landing page after submission.

Do not wait for the demo to be perfect. Late applications are accepted, but YC notes late apps have less predictable timing, so speed matters. citeturn250532search0turn250532search7


Monetize your music catalog


Mr. White,

Yes. **“Monetize your music catalog”** is the right compressed phrase.

Use it as the **headline/category**, then attach the sharper Jovie sentence underneath.

# Best version

**Headline:**  
**Monetize your music catalog.**

**Subhead:**  
Jovie turns your released songs into daily revenue actions: short-form content, merch drops, fan campaigns, and outreach. You approve by text. Jovie executes.

**Killer line:**  
Most music software helps artists measure their career. Jovie operates the catalog and makes it earn.

This matches the core learning in your notes: the stronger pitch is “make more money from music you already made,” rather than “release more music” or “do more work.” fileciteturn0file0

# YC one-liner

**Jovie is an AI revenue operator that helps artists monetize their music catalog.**

Expanded:

**Artists connect their catalog. Jovie finds revenue opportunities, texts them for approval, and executes: content, merch, fan campaigns, and outreach.**

# Landing page hero

**Monetize your music catalog.**

You already made the music. Jovie helps it earn.

Jovie finds revenue opportunities in your songs, creates the content or campaign, gets your approval by text, and executes.

# Even punchier options

**Your catalog should be working.**

**Turn released songs into revenue.**

**Make your old songs earn again.**

**An AI operator for your music catalog.**

**Jovie monetizes your music catalog.**

My preferred final stack:

> **Monetize your music catalog.**  
> You already made the music. Jovie helps it earn.  
> Most music software helps artists measure their career. Jovie operates the catalog and makes it earn.


Ai agent that monetizes your music cataloge is that 50 cahracter desc?


Mr. White,

Yes. Corrected:

**AI agent that monetizes your music catalog**

That is **42 characters** including spaces.

I’d make it slightly stronger and broader:

**AI agent that monetizes music catalogs**

That is **38 characters** and better for YC because it sounds like a company, not a personal tool.

Best 50-character description:

**AI agent that monetizes music catalogs**

It captures the shift from “help artists release more” to “make more money from music they already made.” fileciteturn0file0


Ok, the main thing that we need is to work backwards from revenue. If you're going to put, I don't know, I guess this message got lost, but basically what I was saying before is that I want to work backwards from revenue. You want to do what's going to make. It seems like it's not necessarily even a pivot, right? It's like monetize your music catalog. Well, how do you monetize your music catalog? Well, to me there are going to be a bunch of different workflows and skills that we could do that are going to leverage, right? We should basically be working backwards from what has the highest ROI, because the thing that's going to have the highest ROI is the only thing that you can justify spending money on, right?

So, to me, the thing that's going to have. Okay, I'll give you an example. One of the things that was the biggest impact for my career in music was my collaboration with Cosmic Gate. That song did roughly in between the extended version and the original version. I think it's like roughly a million and a half streams on Spotify. I'd have to look it up and I can tell you, but I think it did like another almost a million just on the Estate of Trance version of it on Spotify. It was premiered on Estate of Trance to 30 million listeners live around the world. Armin van Buuren interviewed Cosmic Gate on that episode and specifically interviewed them, asking about me and what it was like working with me on that song. That was like a massive unlock that resulted in an advance. I got a few thousand euros as an advance on it, then I get a 50/50 on the master between me and Cosmic Gate, and then you know, done on whatever deal they have with their label. So they were taken 70 minutes. I get 15 or whatever the hell it is, right? I'm technically individually making more money than each of the members of Cosmic Gate, as there are two of them. Cosmic Gate is on the record, and as a result, I don't know, I'm losing my train of thought. It made me money and it got me attention, and then it also, I got inbound from other people being like, "Oh, you sang on that Cosmic Gate track. If you want to sing on my track." Collaboration is a big deal. How did we get that? We had a record sitting around that hadn't been touched. I had written it. It was a piano demo on a vocal. We sent one email to a guy named Arnie Bink. He's the head of Black Hole Recordings, and via that email he sent it, forwarded it to Cosmic Gate. Cosmic Gate liked it and they came back to 
Okay, I guess my message got cut off, but basically they finished the track, and then that was it. Thousands of dollars of revenue directly towards me, and how much indirectly? Off of one email, right?

We had a girl on our management, or the managing company that managed me. Same thing, sent an email to one of the guys at Armada. Got her on a song with Armin Van Buren. Armin Van Buren goes on tour. Takes her with him. $2,000 a night, hotels, flights, and meals paid for. They did Madison Square Garden. They did just about every big venue in every big city you can think of. Big deal, right?

I directly saw the inbound effect after that, so you know, to me, that could be a huge thing, right? It's like, if you can, I mean, I don't know. I have songs laying around that aren't out, right? We could theoretically just give them to an agent, give him a fucking SoundCloud link, and then just have them fucking go out and start emailing people as my AI manager. If they were able to secure a deal, then you'd effectively get paid for that.

I just feel like, is it just a generic AI that just fucking runs email and stuff then? Because I mean, theoretically, I got my first manager by just emailing a few hundred managers, and then I literally scraped a fucking industry database and got thousands and thousands of management contacts. I then filtered him down to who manages DJs or electronic music artists or pop artists and emailed them all. I sent them my EP, and a bunch of them emailed back. I took 21 meetings, and the last meeting I picked was with the manager that ended up signing with.

I don't know, is the highest value thing you can do a collaboration if that's just sending an email or DM? Is it easy enough for us to just build a database that's for an agent that just surfaces contacts and is like, "Hey, we think you should reach out to this person"? Drafts a collaboration request email. That could be a shorter MVP. You could deploy it off like an air means agent or something, or it could be the termistic script. We do a Gmail connector through Composio, or we build our own, and then it just automatically fires that off. That might be a better move because you get to leverage an actual actual return.

I have to think about this backwards from, like, okay, if I'm starting over today with my catalog, how do I reactivate it? The way I think that I'm doing that is, I mean, the biggest thing, the biggest thing, was that a collaboration shit is that you get to leverage other people, right? For that record, it was low effort on my part because all I had to do was say yes. I had already written the song. I had it laying around. All I had to do was say yeah, so it was like, "Okay, here's the email they," and then boom, you've got a I'll give you a great example. I saw an ad for a company called Wheels Up that basically did an ad for a private air company or something. I happen to have a song called "Wheels Up," so I took out my phone one day when I saw that ad, fired off an email to my manager, and was like, "Hey, can we hit these guys up and do something?" My manager talks to the partner at the comp firm, who was the silent partner investor, but after unboxing the company, he happened to know one of the guys who invested in Wheels Up, and he was like, "Oh yeah, I'll make a call." Now nothing ended up coming from that, but that's the kind of thing that you can do that is low effort, high reward, right? Like asymmetric returns, and so I wondered if that's something we should be going after, because it's like, "Hey, I did this all the time where it was like I would pull out my phone and be like, 'Hey, two friends, I really like, two friends, new song forever, that was out on Armada,' and I had a song out at Armada at the same time. I was like, 'Dude, I just pulled out my phone and emailed my manager, and I was like, "Hey, this sounds cool. Can we make this happen?" One of the girls at the management company was really, really into "Two Friends" as well, like a fan. She was like, "Yeah, let's do it," so she emails "Two Friends." I don't know if I forget if it was directly them or their manager or something, but she just emails them and reaches out.

It's like, "Hey, you know, this is Ashley from Big Band, who's been in New York. We have an artist here, Tim White, who just released on Armada, and you know, I liked the song. Here's a couple of his on release top lines that we have. He'd love to work with the guys. Is this something that we can make happen?" They ended up just going in and doing. They put me on a fucking plane and flew me out to LA. I was in New York at the time. They flew me to LA and put me in the room with these guys, and we wrote a fucking song together. I forget when this was, but we wrote a song at their fucking house, and now those guys are fucking touring everywhere right now. That song, I don't think, ended up ever coming out, but it's one of those things where they're now playing. I'm trying to honestly, I think they played Madison Square Garden. They have a residency at XS in Las Vegas and stuff, and they're doing very well. That's a thing where it's like you catch the right guy on the come-up and you fucking set that up. That could be a higher ROI in the long run, except it's hard to measure. It's kind of hard to measure the ROI on that because it's so delayed, so I'd be slightly concerned with that as a model but deal. If we can 


The next thing would be, "Okay, what actually gives you an ROI?" Going viral on TikTok gives you an ROI. How many shots you take increases the probability of it. I feel like what we basically need to do is quantify opportunity costs versus reward for every one of these artists and then just work backwards from that. If it's revenue-generating, to what degree and to what cost?

It seems to me that making an agent that just emails people all day based on actual data could be a lot more meaningful, right? I would take an agent. I have a few songs laying around that have not been cut. I would happily take an agent that just went and took those songs, put them on a smart link for private SoundCloud or a link on Jovie or something, and just emailed it to, and we just look at DJs and producers and go down the fucking list of people who the data shows are trending upwards and are basically going to be peaking 18 to 24 months from today and roughly align with the core audience and stuff. I don't give a shit what it is, as long as it's going to generate revenue. I don't know.

I think that if your shit is good, it's usually not hard to make these things happen. It's a lot easier than it seems, so I'm like, "Is that what it is? Are we just replacing the fucking manager?" It's just a system that emails people but actually has knowledge of the music industry and how it works and deal terms and all that kind of stuff, and is aware of who to reach out to to collaborate. An earlier version of it could be human in the loop, just drafting emails for you. A more autonomous version of it could exist later, sending them through your own email account.

Activating your team is often a high-leverage thing. It doesn't cost a lot. You send one text message or one email to everyone who's in your team. What I would do is I would just usually have an email thread going to schedule sessions and stuff anyway. I would just CC Jovie on the email and then have Jovie pick up the email and start tracking the session and the song. A lot of times, what happens is you don't even know, like if you're a working artist or songwriter, you might have a bunch of songs in the mix, and they're not all being.

Oftentimes I'll have five or six DJs who are quote-unquote working on a song for me. I just got to hound them, and sometimes I've had a song come out seven years later. Someone we sent it out to said they'll like it and they're gonna cut it. Some chick off of Universal in Brazil said yes to a song, and it wasn't till seven years later that the fucking thing actually came out. Sometimes, you know, that's just me sending emails being like, "Hey, my management didn't even do this." I would go and get in writing sessions with people, get your contact info there. What's up for the justice, and there are famous DJs that I just would sit there and just text every day and be like, "Hey, you fucking work on our song yet? You work on our song yet?" You need help, like, what can I do? What can I do to make this go further, you know what I mean? Yeah, I mean, generally that 
And then it's like, if you got a sync placement, that's big, right? Like, Cobra Starship, I think, exists because they got a fucking sync placement. That band got a fucking sync placement doing a song at the end of Snakes on a Plane, and I'm fucking singing the song, and I'm convinced that they only got that fucking thing because they were called Cobra Starship and they sent an email at the right time, or someone sent an email for them at the right time. You know, it's not even good, so I mean, that was clearly just some fucking suit who saw Snake and Cobra and was like, "Oh, these things are the same." You know? I don't know, I wonder about that and if that is meaningful.

I'm curious if, like, something else is higher ROI, right? I want to think backwards. I'm trying to think of my actual newsletter. What made me the most money, honestly, was viral videos on YouTube using my music that were monetized. One song I used in a video did 40 million plays and it was monetized and it was just thousands of dollars every quarter showing up. I do think that some of the things that create music group and stuff do, and some of the things that these other people do at scale, are interesting, but I think there is a potential for a business model where you just control YouTube collection and stuff. Thematic does this a little bit and stuff, but you need the partnerships in place and stuff in order to get that, because it's gatekept, so I think that was a little bit harder.

I don't know. I just want to work backwards from actual ROI. I'm sure there's other things. Can you interview me a little bit about this and help me, maybe, understand a little bit more about the context? Help me understand a little bit more about what makes sense in terms of how much effort we're going to put into this and what we're going to build ahead of time and how this fits into a broader narrative. 


I’ll treat this as a revenue-prioritization problem, separating asymmetric upside from immediate cash needs, then use an interview framework to identify the MVP wedge.


## See Also
- [[chatgpt/chatgpt_branch-full-spec-request-part3]]
- [[chatgpt/chatgpt_branch-full-spec-request-part1]]
- [[chatgpt/chatgpt_branch-full-spec-request-part2]]
- [[chatgpt/chatgpt_branch-full-spec-request-part4]]
- [[chatgpt/chatgpt_branch-full-spec-request-part5]]
