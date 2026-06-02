---
title: "Notebook LM for Podcasts"
type: guide
created: 2026-05-31
updated: 2026-05-31
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Notebook LM for Podcasts

> **Source:** ChatGPT conversation
> **Date:** 2026-05-31T05:24:02Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

So we've had a lot of conversations today about content and everything in Jovi and all this stuff. I'm checking out Notebook LM right now, and I'm just curious about it, you know, because it's supposed to create audio and video overviews from your documents and stuff like that is kind of the idea. Is this a thing that we could use to create our podcasts, a thing that we should use to create our podcasts, a thing that we could use to make our deck, a thing we should use to make our deck, etc.?

## Answer

Mr. White, I’ll assess NotebookLM as a practical content tool for Jovie, covering podcasts, decks, research synthesis, and where it should support your pipeline rather than replace it.

## Answer

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

For the J

*(Answer truncated — 8123 chars total)*

## Question

Okay, I'd love for you to give me YC style pitch deck, pulling the Michael Seibel advice. Look at the existing pitch deck, go to jov.ie slash pitch, pull that in, and then go over like the story that we're going after right now, where it's like, it's not just about releasing more music, it's about taking the music that you have and turning it into 52 Fridays, right? It's about monetizing your existing catalog or your new music, right? It's about how do you take an artist who's been, or not just an artist, but music creators in general, and how do we take their music and then turn that into a artistic universe across social media and across the world and, you know, create content, create collabs, create moments, all this, and ship all the time, and then have a closed loop where that data informs what's working and then you would keep going, right?

## Answer

I’ll ground this in the live Jovie pitch page and YC/Michael Seibel deck guidance, then compress the “52 Fridays” catalog-to-universe story into a tighter deck.

## Answer

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

### **Music creators have assets. They lack ex

*(Answer truncated — 15178 chars total)*
