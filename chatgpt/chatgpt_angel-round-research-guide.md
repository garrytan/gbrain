---
title: "Angel Round Research Guide"
type: note
created: 2026-02-15
updated: 2026-02-15
source: chatgpt-export
conversation_id: 69922b26-9b5c-8333-a6d0-b0e081b60772
message_count: 2
tags: [chatgpt, import, long-form]
---
# Angel Round Research Guide

> Conversation ID: 69922b26-9b5c-8333-a6d0-b0e081b60772
> Created: 2026-02-15T20:31:23Z
> Updated: 2026-02-15T20:32:13Z
> Messages: 2

---

## User

Yo, so I'm gonna start raising angel round for Jovi probably this week, next week, something like that. And what I'm thinking about right now is my friend Daniel is an advisor for the company. He is a YC founder. He had a company raise a $3.2 million pre-seed round, or sorry, seed round out of YC. He's also ex-SoftBank, and he's currently managing about 40 people as the head of the Organic and Agantic search at Expedia. And so he's an advisor, and he's got an Excel template that he gave me that's basically, he was like, you know, it's basically like a thing of like, okay, you know, if we're trying to raise $150K, then, you know, that means we've gotta, you know, talk to, you know, 150 investors and get one yes or something, you know what I mean? Whatever the fuck it is, right? You know, for a $100K check or something, right? I don't know, you know, obviously my math doesn't make any sense, but you understand what I'm saying, right? So, my question to you is, basically what I want to do right now is I want to go in and start researching angels, and some of these will come from my personal network, and some of them will come with people from people who have domain expertise who might invest, and then some of these will come from people who are like just straight-up angels, whatever, right? Cold outreach, try to have like a connection to a friend or something, right? And, you know, or we'll go secure the warm intro, whatever it is, right? So I'm trying to build this list now, and my, I guess my main concern is like, do I... Like, why are you just... Close this gap, man. So my main question right now is like, how do I... Dude, come on. Like... Dude, come on. Like, stop letting the whole world through. Um, this is me yelling in a car. Um, so my question is, um, as we're building this, um... Fuck ass. Um... As we're building this, do I need to, like, how should I be thinking about, oh, I, you know, I want, I gotta fill out the spreadsheet, right? So he just sent me like an Excel file, right? So I guess my question is, I'm gonna have, like, AI agents basically assist me. And I'm gonna have AI agents assist me and have them basically look for, you know, do research and then fill out the spreadsheet, right? And so I guess my question is, what's the most efficient way for me to do this right now? Now I have access to all of the AI tools in the world, right? What would be the best way to do this? Do I get the new Clawed Excel thing where it's like Clawed in Excel and then just have Clawed, like, do some research and fill out the spreadsheet and stuff? Or do I go get, use Clawed co-work on desktop? Do I upload the spreadsheet to Google Drive and do a Google sheet and then have, like, Clawed code in the browser work on it or ChatGPT with a connector to connect to the spreadsheet? Or do I use like OpenClaw or one of these things that like runs on the operating system level and have it, like, start doing research and stuff for me? What would be the most effective way for me to do this? And right now I'm like primarily concerned with, you know, finding the people and filling out the sheet as step one. Once I've kind of built that sheet and stuff, I can do another pass with a different AI tool or something to say, you know, have it, have it like iterate through said sheet and improve the data or whatever. And then once I'm done with that, you know, then I can worry about like, okay, is this going in a CRM? Am I gonna use like a just a Gmass or something like that? Am I gonna manually email all these people, you know, like and upload and update the spreadsheet, or do I, you know, use Google Drive and then have And then have Claude, you know, do I, do I update the Google Drive or have Claude? I would have, oh, and then at that point, Claude could like, I could, you know, use an open claw or something and have it take over my computer and read the spreadsheet, compose the email, and then update the spreadsheet after it sends the email and then read my email and then get the responses and then go, you know, like all that stuff, like, I'm just, there's a million ways to do this, and I'm just kind of trying to like break it out into concise steps and fucking go and be as fast as we can with this because I don't have time. I'm a solo founder, and it's early stage. I'm the only employee in the company. I don't have time to be doing this inefficiently. I need to get as many angels as I can who I have contacts or warm intros to, or I can get warm intros to, which I mean, I guess is anyone in the world in theory. Um, and then, um, put them in this spreadsheet and then, and kind of like, and I'm, and I'm optimizing for angels who are most likely to say yes with the least friction. Um, that's what we're optimizing for. And I'm not, then I'm like gonna, you know, organize these by phases and stuff and try and reach out to the quickest yeses first. Um, you know, I've already got a $25K check in. Um, you know, how do we optimize for this?

---

## Assistant

Mr. White — you’re basically building a **deal-flow machine**. The fastest setup is the one that:

1) keeps the data in **one canonical place**,  
2) lets you do **semi-automated enrichment** with tight QA,  
3) gives you a **simple scoring + sequencing** system so you’re always working “highest probability / lowest friction” first.

Here’s the most efficient way to do it in practice.

---

## 1) Pick a “source of truth” (don’t overthink it)
**Use Google Sheets as the canonical sheet** (even if Daniel’s template is Excel).

Why:
- frictionless sharing with advisors / introducers
- easy copy/paste + filters + comments
- easiest for most AI tools to read/write (via browser, CSV, or lightweight scripts)
- works well with later migration to Airtable/HubSpot/Attio

**Keep Excel only if the template has heavy formulas you can’t easily port.** Otherwise convert it.

---

## 2) Split your sheet into 3 tabs (this matters)
### Tab A — **Investor Master (canonical)**
This is *the* database. One row per investor.

Suggested columns (minimal but sufficient):
- Name  
- Type (Warm / Semi-warm / Cold)  
- Check size range (min / typical / max)  
- Fit tags (consumer, travel, marketplaces, AI infra, etc.)  
- Proof of fit (1–2 bullet facts)  
- Best path to intro (who / how)  
- Contact (email / LinkedIn)  
- City / timezone  
- Notes  
- Status (Not contacted / Intro requested / Intro sent / Meeting / Soft yes / Hard no / Follow-up / Invested)  
- Last touch date  
- Next action date  
- Owner (you / advisor / whoever)

### Tab B — **Intro Paths**
One investor can have multiple intro routes. This tab keeps it clean:
- Investor name  
- Connector name  
- Relationship strength (1–5)  
- Ask (intro / forwarding blurb / meeting)  
- Result (pending / done / no response)  
- Notes

### Tab C — **Outreach Log**
Every outbound email + follow-ups live here:
- Investor  
- Date  
- Channel (email/linkedin)  
- Message version  
- Outcome  
- Next step

This structure prevents the “spreadsheet turns into a junk drawer” problem.

---

## 3) Don’t let an agent “free-run” on your sheet
Best practice is **agent does research → drafts rows → you approve → it writes to canonical**.

If you let an OS-level agent autonomously browse + edit your canonical sheet, you’ll get:
- duplicate investors
- wrong emails
- hallucinated “facts”
- broken formulas
- messy statuses

Speed comes from **batching + QA**, not from zero-supervision automation.

---

## 4) The fastest “AI-assisted” workflow (what I’d do)
### Step 1 — Build a raw lead queue (fast, messy)
Make a **separate “Raw Leads” tab** where you dump names/links with zero perfection.

Sources:
- your personal network (highest hit rate)
- YC founders in relevant verticals
- operators in your domain (potential strategic angels)
- people who’ve invested in adjacent companies
- “angel syndicates / micro-VCs that behave like angels” (if relevant)

### Step 2 — Batch enrichment in chunks of 20–50
For each batch, have AI produce **standardized output** for each lead:
- check size guess + evidence
- 2–3 “why them” bullets
- likely intro paths (based on your network list + LinkedIn graph hints)
- best contact method

Then you (or an assistant) quickly QA: keep / discard / needs more research.

### Step 3 — Only after QA, write into Investor Master
This is where the sheet stays clean and usable.

---

## 5) Tool choice: what actually works best
### Option A (most efficient for you right now): **Google Sheets + ChatGPT/Claude in browser + structured prompts**
- You manually paste batches in / out OR use CSV import/export.
- Lowest setup, highest control, fastest time-to-value.

### Option B (if you want heavier automation): **Sheets + a lightweight script/API enrichment**
- Use an enrichment step that outputs clean rows to paste/import.
- You can later automate via Zapier/Make/n8n if you want.

### Option C (if you want a “CRM-lite” immediately): **Airtable/Attio**
- Better for relationship mapping + pipelines.
- Slightly more setup, but reduces spreadsheet pain later.
- I wouldn’t start here unless you already love one of them.

### What I would *not* do first
- **OS-level “computer-use” agents** to browse, decide, and edit the sheet end-to-end.  
They’re great for *one-off tasks*, not for building a clean database fast.

---

## 6) Your optimization goal = a simple scoring model
You said: “most likely yes, least friction.”

Add 3 numeric columns (1–5):
- **Warmth** (intro strength)  
- **Fit** (domain + stage + check size)  
- **Speed** (how fast you can get a real shot: direct text/email > warm intro > cold)

Then compute:
**Priority Score = Warmth × 2 + Fit + Speed**

Sort descending and work top-down.

This is how you avoid spending 6 hours chasing a “maybe” when there are 10 fast “yes” shots sitting there.

---

## 7) Pipeline math that actually helps (simple targets)
Early angel rounds are usually a conversion funnel:

- Warm intros: **10–30%** meeting rate  
- Meetings to “yes”: **5–20%** depending on traction + fit  
- Cold: usually brutal unless your story is hot

So if you want (example) **$150k**, and your typical check is **$10–25k**, you might need:
- 6–15 real “at-bats” (meetings with legit fit)
- which might require 25–60 warm targets
- which might require 60–150 total names in your universe

Your advisor’s “150 for one yes” vibe is basically: **plan for volume, but bias toward warmth**.

---

## 8) Message ops: keep it extremely templated
Once Investor Master exists, do outreach in “waves”:

- **Wave 1:** top priority (warm + fit + fast)  
- **Wave 2:** warm but slower / slightly weaker fit  
- **Wave 3:** cold but high-fit

Every wave has:
- initial email
- follow-up #1 (2–4 days)
- follow-up #2 (7–10 days)
- close-the-loop (optional)

AI can draft these per investor from the “Proof of fit” bullets, but you keep the structure identical.

---

## 9) If you want a concrete “today” plan (fast)
1) Convert Daniel’s Excel to Google Sheets and create the 3-tab structure above.  
2) Spend 60 minutes dumping **every warm-ish name** you can think of into Raw Leads (no research).  
3) Batch 30 names → AI enrichment → you QA → push into Investor Master.  
4) Add scoring columns and sort.  
5) Start Wave 1 intros/outreach the same day.

---

If you paste (or upload) Daniel’s template columns here, I’ll map them to the clean 3-tab structure and give you:
- the exact columns to add/remove,
- a scoring formula,
- and a copy/paste prompt you can reuse to batch-enrich 20–50 investors at a time without garbage output.
