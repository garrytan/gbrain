---
title: "Notebook LM for Podcasts"
type: essay
created: 2026-05-31
updated: 2026-05-31
source: chatgpt-export
conversation_id: 6a1bc5f1-6e3c-83e8-b5d5-761696ea8ebe
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Notebook LM for Podcasts

> Conversation ID: 6a1bc5f1-6e3c-83e8-b5d5-761696ea8ebe
> Created: 2026-05-31T05:24:02Z
> Updated: 2026-05-31T06:49:40Z
> Messages: 6

---

## User

So we've had a lot of conversations today about content and everything in Jovi and all this stuff. I'm checking out Notebook LM right now, and I'm just curious about it, you know, because it's supposed to create audio and video overviews from your documents and stuff like that is kind of the idea. Is this a thing that we could use to create our podcasts, a thing that we should use to create our podcasts, a thing that we could use to make our deck, a thing we should use to make our deck, etc.?

---

## Assistant

Mr. White, I’ll assess NotebookLM as a practical content tool for Jovie, covering podcasts, decks, research synthesis, and where it should support your pipeline rather than replace it.

---

## Assistant

Mr. White, my recommendation:

## Verdict

**Use NotebookLM for Jovie, but use it as a source-grounded content lab, not as the final creative authority.**

It is useful for:

| Use case | Could use it? | Should use it? | Role |
|---|---:|---:|---|
| **Podcast ideation** | Yes | Yes | Strong |
| **Internal podcast drafts / research briefings** | Yes | Yes | Strong |
| **Public Jovie podcast episodes** | Yes | Carefully | Use as draft/input, not default final output |
| **Investor deck first drafts** | Yes | Yes | Good for variants |
| **Final investor deck** | Yes | With heavy editing | Founder-led narrative should control |
| **Product explainer videos** | Yes | Yes | Good for fast tests |
| **Automated Jovie feature inside the product** | Maybe | Later | Enterprise/API constraints matter |

## Why NotebookLM is relevant

NotebookLM now supports the exact modes you’re describing: **Audio Overviews**, **Video Overviews**, **Slide Decks**, infographics, source Q&A, and other source-grounded outputs. Audio Overviews create AI-hosted deep-dive discussions from uploaded sources, with formats like Deep Dive, Brief, Critique, and Debate; they can be downloaded and generated in 80+ languages. citeturn670392view0

Video Overviews turn notebook sources into narrated videos, with options for format, language, visual style, and steering prompts. Google explicitly says these videos are AI-generated and may contain inaccuracies or glitches. citeturn739215view2

Slide Decks are also now a real NotebookLM feature. They can generate polished decks from sources, support “Detailed Deck” or “Presenter Slides,” allow prompting for audience/style/focus, and can be downloaded as **PDF or PowerPoint**. The limitation: adding/removing slides is currently unsupported during revision, and revisions do not currently re-check sources. citeturn739215view0

## Podcasts: use it, but don’t let it become the brand

For Jovie’s podcast workflow, NotebookLM is useful for:

1. Turning product docs, artist feedback, competitor notes, and release-strategy docs into a **fake podcast conversation**.
2. Testing whether a topic has enough substance for an episode.
3. Creating internal “listen instead of read” briefings.
4. Generating episode outlines, objections, counterarguments, and soundbite candidates.
5. Producing “AI briefing” bonus content if you intentionally brand it that way.

I would **not** make the main Jovie podcast simply “two generic AI hosts talking about our docs.” That format is useful, but it is already commoditized. For Jovie, credibility comes from founder taste, product judgment, artist empathy, and specific examples from real release workflows.

The better workflow:

```text
Sources → NotebookLM Audio Overview → transcript/outline → human edit → founder/artist recording → branded final episode
```

Use NotebookLM to compress the research. Use you, artists, or a real host to create the public trust.

## Deck: use it for drafts, not final strategy

For the Jovie deck, NotebookLM is worth using as a **variant generator**. Feed it the current Jovie narrative, product screenshots, traction notes, release workflow example, ICP notes, and investor objections. Then ask for:

- 8-slide seed deck
- 5-slide cold-email deck
- 12-slide detailed deck
- artist-market narrative version
- investor-market narrative version
- “brutally concise YC-style” version
- “visual product walkthrough” version

That said, the final deck should remain manually controlled. A fundraising deck has to make the company instantly understandable, compress the product into one concrete example, prove momentum, and create conviction. NotebookLM can help visualize and organize; it should not decide the core story.

Given the direction we’ve discussed before, the core should stay close to:

> **Jovie helps independent artists release more music with less work.**

NotebookLM can help make that more visual. It should not bury it under generic AI slide language.

## Video overviews: useful for investor follow-up and product education

Video Overviews could be useful for:

- a short “what Jovie does” explainer
- investor follow-up after a meeting
- artist onboarding
- internal product training
- turning release-workflow docs into narrated demos
- short social clips, if edited afterward

I would treat these like generated rough cuts. They may be factually or visually wrong, so every claim, number, screenshot, pricing point, and product promise needs review. Google’s own docs flag AI-generated inaccuracies for both video and slide outputs. citeturn739215view2turn739215view0

## Privacy / IP constraints

For normal NotebookLM use, Google says NotebookLM uses your uploaded files, outputs, and chat history to build your notebook knowledge base, and that content is not used to directly train foundational models unless you provide feedback. If you give thumbs-up/thumbs-down feedback, associated prompts, uploads, outputs, and sources can be collected and reviewed; Workspace/Education users get stronger treatment where uploads, queries, and responses are not human-reviewed even with feedback. citeturn739215view4

Practical Jovie rule:

- Use **sanitized source packs** for investor decks and public content.
- Avoid uploading unreleased artist material, contracts, private emails, PII, private revenue data, or anything you lack rights to use.
- Do not submit feedback on sensitive notebooks.
- Use a Workspace/Enterprise setup for confidential company materials.

Google also says users should respect copyright laws and avoid sharing copyrighted content without rights; Google says it does not claim ownership over original generated content from services including NotebookLM. citeturn505667view2

## Product integration angle

If you mean “could Jovie integrate NotebookLM-like podcast generation into the product for artists,” the answer is more complicated.

Google now documents NotebookLM Enterprise APIs for creating/managing notebooks and audio overviews, but those APIs are **Pre-GA** and enterprise-oriented. citeturn916507view0turn433604view0 Google also documents a standalone Podcast API, but it is marked **deprecated** and Google says it is not allowlisting new customers. citeturn433604view1

So: **manual/team workflow now, product integration later only if the API path becomes clean.**

For Jovie product features, I would build your own pipeline using models you control rather than depend on NotebookLM unless Google gives you a stable integration path.

## Recommended Jovie workflow

Create one master notebook:

**Sources to upload**
- Jovie one-liner and positioning
- current deck draft
- product screenshots
- pricing page copy
- changelog
- artist onboarding flow
- ICP notes
- competitor notes
- real or anonymized artist release examples
- traction notes
- investor objections
- founder notes / transcripts

**Outputs to generate**
1. **Audio Overview — Debate**  
   Prompt: “Debate whether independent artists need Jovie or can just use existing smart-link and release tools.”

2. **Audio Overview — Critique**  
   Prompt: “Critique the Jovie fundraising story as if you are a skeptical seed investor.”

3. **Slide Deck — Presenter Slides**  
   Prompt: “Create an 8-slide investor deck. Make the company instantly understandable. Lead with one concrete artist release workflow. Keep text minimal.”

4. **Slide Deck — Detailed Deck**  
   Prompt: “Create a detailed version suitable for sending after a meeting.”

5. **Video Overview — Brief**  
   Prompt: “Create a short explainer for independent artists showing how Jovie helps them release a single with less manual work.”

## Final recommendation

Use NotebookLM immediately for:

- podcast research
- internal audio briefings
- investor-deck variants
- product explainer drafts
- objection discovery
- content calendar generation

Do **not** use it as the final voice of Jovie. The final podcast and deck should sound like a founder with specific product insight, specific artist pain, and specific market conviction. NotebookLM should accelerate the compression and iteration step.

---

## User

Okay, I'd love for you to give me YC style pitch deck, pulling the Michael Seibel advice. Look at the existing pitch deck, go to jov.ie slash pitch, pull that in, and then go over like the story that we're going after right now, where it's like, it's not just about releasing more music, it's about taking the music that you have and turning it into 52 Fridays, right? It's about monetizing your existing catalog or your new music, right? It's about how do you take an artist who's been, or not just an artist, but music creators in general, and how do we take their music and then turn that into a artistic universe across social media and across the world and, you know, create content, create collabs, create moments, all this, and ship all the time, and then have a closed loop where that data informs what's working and then you would keep going, right?

---

## Assistant

I’ll ground this in the live Jovie pitch page and YC/Michael Seibel deck guidance, then compress the “52 Fridays” catalog-to-universe story into a tighter deck.

---

## Assistant

According to a document from May 19, 2026, Jovie’s current investor-safe positioning is: **Jovie is an AI marketing agent / AI manager for music creators that connects to an artist’s catalog and turns releases into fan paths, smart links, notifications, campaigns, and revenue opportunities.** The current ask is **$500K on a $5M post-money SAFE** to reach **first revenue and 1,000 paying creators**. fileciteturn11file17

Mr. White, I could not directly retrieve `jov.ie/pitch` through web search, but I pulled in the latest pitch materials I found: the May 16 revised v4 seed deck and the May 19 investor context dump. The recommendation below merges those with the “52 Fridays” narrative.

## Michael Seibel filter

The YC-style version should follow this order:

1. **Say what Jovie does immediately.**
2. **Show one concrete user path.**
3. **Show progress.**
4. **Explain the insight.**
5. **Make the business model simple.**
6. **Show why you are the founder.**
7. **Ask directly.**

Michael Seibel’s YC pitch guidance emphasizes opening with what the company does, keeping the explanation simple, using a concrete user path when the product is unfamiliar, and covering progress, unique insight, business model, team, and ask. citeturn400971search1 YC’s broader advice also pushes founders toward launching, talking to users, building a product people love, and focusing on one or two key metrics. citeturn104627view1

The main shift I would make: **move “52 Fridays” from internal concept to the core user path.**

## Clean one-liner

### Best YC-style version

> **Jovie turns a music creator’s catalog into 52 Fridays of releases, content, fan moments, and revenue workflows.**

### Slightly more investor-safe

> **Jovie is an AI manager for music creators that turns catalog and fan data into weekly release, content, and revenue workflows.**

### Current-deck compatible

> **Jovie knows your catalog, watches for demand, and ships the work that turns music into fans and revenue.**

The current deck already says Jovie is an “AI manager for music artists” that knows the catalog, watches demand, and ships revenue workflows. fileciteturn11file7 The May 19 investor context says the public positioning is “Monetize your music catalog with AI” and “Every creator gets an AI manager.” fileciteturn11file17

---

# YC-style pitch deck

## Slide 1 — Title

### **Jovie turns music catalogs into 52 Fridays.**

**On-slide copy**

> AI manager for music creators.  
> Connect your catalog. Jovie turns songs into weekly release moments, fan paths, campaigns, and revenue workflows.

**Visual**

A simple transformation:

```text
Catalog → 52 Fridays → Fans → Revenue → Next Friday
```

**Speaker note**

“Music creators already have songs, demos, stems, studio footage, tour dates, collaborators, and fans. Jovie turns that raw material into a year of things to release and the workflows to ship them.”

---

## Slide 2 — Problem

### **Music creators have assets. They lack execution.**

**On-slide copy**

> Songs, demos, collabs, videos, lyrics, tour dates, and fan attention are valuable assets.  
> Most of them sit unused because the work around every release is manual.

**Supporting points**

- Every release needs art, links, copy, fan capture, notifications, content, playlist pitching, merch, follow-up, and analytics.
- Creators stitch this together across too many tools.
- The result is release spikes followed by silence.

**Visual**

Red flatline/spike chart from the existing deck, updated with labels:

```text
Drop → spike → silence
Drop → spike → silence
Drop → spike → silence
```

**Why this works**

The current deck’s problem slide says most artists’ careers flatline because they lack systems and leverage, and that released and unreleased songs are valuable assets with execution as the missing layer. fileciteturn9file9 This keeps that idea and makes it more concrete.

---

## Slide 3 — User path

### **A four-song EP becomes a year of Fridays.**

**On-slide copy**

> An artist connects Spotify and uploads a four-song EP.  
> Jovie creates 52 release moments: singles, remixes, acoustic versions, lyric videos, visualizers, collabs, merch drops, tour tie-ins, and fan alerts.

**Example**

```text
Friday 1: single
Friday 2: behind-the-song clip
Friday 3: lyric video
Friday 4: club remix
Friday 5: merch drop
Friday 6: acoustic version
Friday 7: collab post
Friday 8: playlist push
...
```

**Workflow underneath each Friday**

- Artwork
- Smart link
- Fan notification
- Promo copy
- Release checklist
- Playlist pitch
- Analytics

**Speaker note**

“This is the user path. The artist clicks Generate Release Plan. Jovie turns four songs into 52 weeks of release moments, and every Friday teaches Jovie what to do next.”

This directly reflects the 52 Fridays demo script: Jovie turns a four-song EP into 52 weeks of release moments, with workflows underneath each moment including artwork, smart links, fan notifications, promo copy, release checklist, playlist pitch, and analytics. fileciteturn7file15

---

## Slide 4 — Solution

### **Jovie ships the work around every release.**

**On-slide copy**

> Jovie gives music creators the systems and leverage of a manager.

**Product verbs**

```text
Watch → Detect → Draft → Ship → Measure → Recommend
```

**What Jovie ships**

- Release pages
- Smart links
- Presaves
- Fan capture
- Fan notifications
- Playlist-pitch drafts
- Campaign ideas
- Merch drops
- Social content tasks
- Analytics and next actions

**Speaker note**

“Jovie is the execution layer after the song is made. It knows the catalog, sees the opportunity, creates the work, ships it to fans, and learns from the response.”

The v4 deck already frames Jovie as giving artists the systems and leverage of a manager, with release, event, content, and commerce workflows and AI execution that runs every day. fileciteturn11file9

---

## Slide 5 — Product loop

### **Every Friday makes the next Friday smarter.**

**On-slide copy**

> Jovie closes the loop from catalog → campaign → fan action → next recommendation.

**Loop**

```text
Catalog + fan data
      ↓
Release moment
      ↓
Assets + campaign
      ↓
Fans click / opt in / buy / stream
      ↓
Jovie recommends the next move
```

**Speaker note**

“This is the real product. Jovie learns what fans respond to, which formats work, which songs deserve more life, and which campaign should ship next.”

The current deck says Jovie watches the catalog, detects the moment, drafts the work, publishes the result, and measures what made money. fileciteturn11file5 The May 19 context also frames the product as moving from campaign generation into a feedback loop: detect, launch, measure, recommend, repeat. fileciteturn10file10

---

## Slide 6 — Demo example

### **Jovie finds a real moment and ships it.**

**On-slide copy**

> Cosmic Gate is playing EDC.  
> Tim has “The Deep End” with Cosmic Gate.  
> Jovie recommends a merch drop, drafts the campaign, updates the smart link, alerts fans, and monitors performance.

**Visual**

Use the existing Tim White × Cosmic Gate / EDC slide, but make it more YC-simple:

```text
Signal: Cosmic Gate at EDC
Catalog: Tim x Cosmic Gate song
Action: merch + fan alert + smart link update
Result: campaign live
```

**Speaker note**

“This is what a manager would notice. Jovie notices it automatically and turns it into work that ships.”

The current v4 deck already uses the Tim White × Cosmic Gate at EDC example, where Jovie sees the moment, proposes merch concepts, publishes a drop, and schedules the fan alert. fileciteturn11file15 The May 19 context identifies this as the strong investor demo narrative: detect the opportunity, draft the campaign, prepare assets, route fans, queue notifications, monitor response, and recommend the next action. fileciteturn10file10

---

## Slide 7 — Why now

### **Creation is abundant. Release execution is the bottleneck.**

**On-slide copy**

> AI makes it easier to create music.  
> Music creators still need to launch, build fans, monetize attention, and keep shipping.

**Supporting points**

- More songs means more release work.
- More creators means more fragmented marketing work.
- Labels and managers give systems and leverage to a few artists.
- Jovie gives that operating layer to the long tail.

**Speaker note**

“AI music tools increase supply. The bottleneck moves to coordination, fan capture, marketing, and monetization. Jovie sits after creation.”

The May 19 investor context says AI has made music creation easier and faster, shifting the bottleneck to building audiences, launching consistently, capturing fan demand, and converting attention into revenue. fileciteturn10file8

---

## Slide 8 — Traction

### **Live product. Real catalog. Organic pull.**

**On-slide copy**

> Jovie is live, founder-dogfooded, and already pulling in artists organically.

**Current deck metrics**

- 4 external artists joined organically last month
- 0 paid acquisition
- 180K founder dogfood audience
- $25K first angel check committed

**Speaker note**

“We have the product live, a real artist catalog to dogfood on, and early organic artist demand. The next metric is paid conversion from claimed profiles into Pro and Operator workflows.”

The v4 deck lists the above traction metrics and states the next metric is converting organic demand into paid Pro and Operator plans through merch drops, fan alerts, and release workflows. fileciteturn11file2

**Suggested YC metric to add**

> **Release moments shipped per creator per month.**

Secondary metrics:

- Claimed profiles
- Activated artists
- Paid conversion
- Fan captures per artist
- Revenue workflows shipped
- Repeat weekly usage

---

## Slide 9 — Go-to-market

### **Pre-built profiles create the pull.**

**On-slide copy**

> Artists receive a working Jovie profile before the sales call.

**Flow**

```text
Identify active artists
→ Build pre-built profile
→ Show catalog opportunities
→ Artist claims profile
→ Jovie ships first paid workflow
```

**Speaker note**

“Instead of sending a generic landing page, we show the artist their own catalog, their own missed opportunities, and the first workflows Jovie can ship.”

The v4 deck’s GTM slide uses this exact motion: identify artists using multiple tools, build a live profile, send specific catalog opportunities, and convert claimed profile into paid workflow. fileciteturn11file2 The May 19 context also frames pre-built profiles and claim flow as the core GTM wedge. fileciteturn10file13

---

## Slide 10 — Business model

### **Free profile. Paid automation.**

**On-slide copy**

| Plan | Price | Buyer | Job |
|---|---:|---|---|
| Free | $0 | Creator | Claim profile + fan capture |
| Pro | $39/mo | Artist | Release ops automation |
| Operator | $299/mo | Managers / labels | Higher-volume AI workflows |
| Usage | Variable | Power users | Agent runs, generation, data sync |
| Commerce | Upside | Artists / teams | Merch, fan sales, ticketing |

**Speaker note**

“We start by replacing fragmented creator tools. Then Jovie expands into labor-replacing workflows for artists, managers, and labels.”

The v4 deck lists Free, Pro at $39/month, Operator at $299/month, usage, and commerce upside, with a path to roughly $101.6M base ARR from 125k Pro artists and 12k Operators. fileciteturn11file2 The May 19 context also lists Pro at $39/month and Operator at $299/month, with future expansion into usage, services, payments, revenue share, merch, ticketing, and team/label plans. fileciteturn10file10

---

## Slide 11 — Team

### **Built from inside the workflow.**

**On-slide copy**

> Tim White  
> Founder  
> 15 years in music.  
> 90M+ streams.  
> Built the manual release workflows Jovie now automates.

**Speaker note**

“I’ve been the artist, the operator, and now the developer. Jovie is the software version of the release playbook I had to build manually.”

The current deck says Tim White has 15 years in music, drove 90M streams by manually running the release workflows Jovie now automates, and has the catalog, industry context, and founder-market fit to dogfood every release loop. fileciteturn11file2 The May 19 context lists approved founder signals including 90M+ streams, 190K audience, Clio Award, Armada label releases, and deep experience across artist, producer, songwriter, marketer, and operator workflows. fileciteturn10file10

---

## Slide 12 — Ask

### **Raising $500K pre-seed.**

**On-slide copy**

> $500K on a $5M post-money SAFE.  
> Milestone: first revenue and 1,000 paying creators.

**Use of funds**

- Product
- Creator acquisition
- Release-ops automation

**Speaker note**

“This round funds the path from product wedge to paid creator workflows.”

The May 19 context states the ask as $500K on a $5M post-money SAFE, with the milestone of first revenue and 1,000 paying creators, and use of funds focused on product, creator acquisition, and release-ops automation. fileciteturn10file10

---

# 30-second pitch

> Jovie is an AI manager for music creators. It connects to an artist’s catalog and turns their existing songs, new releases, videos, collabs, tour dates, and fan data into 52 Fridays of release moments. Under each moment, Jovie creates the work: smart links, fan alerts, promo copy, playlist pitches, merch drops, social tasks, and analytics. The product is live, four external artists joined organically last month, and we’re raising $500K to convert pre-built artist profiles into paid Pro and Operator workflows.

---

# What I would change from the existing deck

## Keep

- **AI manager** as the brand category.
- **Catalog + demand + shipped workflows** as the product frame.
- **Tim White × Cosmic Gate / EDC** as the concrete “manager notices the moment” demo.
- **Pre-built profile GTM** as the first sales motion.
- **Free → Pro → Operator** business model.
- **$500K on $5M SAFE** ask.

## Change

### 1. Lead with the user path

Current deck opens with “AI manager for music artists.” Good, but YC needs the baby-food explanation immediately after:

> “Jovie turns a creator’s catalog into 52 Fridays of releases, content, fan moments, and revenue workflows.”

### 2. Make 52 Fridays the spine

The story should be:

```text
A creator has music.
Jovie turns it into weekly moments.
Each moment ships with a workflow.
Fan/revenue data flows back.
Jovie recommends the next moment.
```

### 3. Put “systems and leverage” behind the example

“Systems and leverage” is true. It is abstract. Use it after the four-song EP example.

### 4. Add one killer metric

YC will care less about the category language and more about whether creators use it repeatedly. The clean metric:

> **Release moments shipped per creator per month.**

That captures the product, the habit loop, and the 52 Fridays thesis.

## Final deck thesis

> **Jovie turns music into a compounding release engine.**  
> A song becomes a Friday. A Friday becomes content, fan capture, merch, and data. The data teaches Jovie what to ship next. Over time, every creator gets the operating system that only managed artists used to have.


## See Also
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
- [[chatgpt/chatgpt_100-mbps-upload-options]]
- [[chatgpt/chatgpt_1001tracklisting-search-query]]
