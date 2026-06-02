---
title: "Waitlist Onboarding Chat"
type: guide
created: 2026-05-23
updated: 2026-05-23
source: chatgpt-export
conversation_id: 6a123413-3380-83e8-a69a-94fe163f5070
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Waitlist Onboarding Chat

> Conversation ID: 6a123413-3380-83e8-a69a-94fe163f5070
> Created: 2026-05-23T23:11:39Z
> Updated: 2026-05-23T23:12:25Z
> Messages: 3

---

## User

Build me a world class version of the waitlist onboarding chat where we user interview people superhuman style and qualify them then waitlist them

---

## Assistant

Mr. White, I’ll frame this as a product spec an AI agent can execute: UX, interview logic, scoring, data model, waitlist states, and first shippable version.

---

## Assistant

## Jovie Waitlist Onboarding Chat

**Goal:** turn signup into a high-signal artist interview, qualify the user, build their initial Jovie context, and place them into the right waitlist lane.

This should feel less like a form and more like a sharp A&R/operator interview.

---

# Core Concept

The waitlist onboarding chat should act like:

> “Jovie is interviewing you to understand whether you are ready for an AI manager.”

It should gather enough context to answer:

1. **Who are you?**
2. **Are you a serious artist?**
3. **Do you release music actively?**
4. **Do you already have fans, traffic, or revenue?**
5. **Can Jovie materially help you grow?**
6. **Should we admit you now, waitlist you, or reject/low-prioritize you?**

The experience should produce three outputs:

| Output | Purpose |
|---|---|
| **Artist Profile Context** | Used to pre-build their Jovie profile |
| **Qualification Score** | Used to prioritize access |
| **Waitlist Lane** | Determines what happens next |

---

# Product Principles

## 1. Chat first, form second

The user should feel interviewed, not processed.

Bad:

> “What is your genre?”

Better:

> “What kind of artist are you? Give me the version you’d say to someone in the green room, not a Spotify genre tag.”

Then parse genre, identity, market, and tone from the answer.

---

## 2. Superhuman-style qualification

Superhuman asked: “How would you feel if you could no longer use Superhuman?”

Jovie’s version:

> **“How painful would it be if every release you put out this year had to be planned, promoted, and followed up manually?”**

Answer options:

- Extremely painful — I already feel this problem
- Annoying — I know I should do more
- Mildly annoying — I release casually
- Irrelevant — I just need a link page

This is the core qualification question.

---

## 3. Make the user feel selected

The waitlist should feel like limited access because Jovie needs serious artists with enough signal to benefit from automation.

Copy direction:

> “We’re onboarding artists in batches so Jovie can build useful context before you get access.”

Avoid:

> “Thanks, you’re on the waitlist.”

Use:

> “You’re in the review queue. Based on your answers, Jovie is preparing your artist profile and release context.”

---

# Ideal Flow

## Step 1 — Opening

**Chat message:**

> “Jovie is currently onboarding artists in batches. I’m going to ask a few questions to understand your music, your release cadence, and whether Jovie can actually help you grow. Takes about 2 minutes.”

CTA:

> **Start interview**

---

## Step 2 — Identity

Ask:

> “What’s your artist name?”

Then:

> “Drop your best link — Spotify, Instagram, TikTok, SoundCloud, Linktree, or your website.”

System should infer:

- Artist name
- Primary platform
- Spotify ID if available
- Social reach if available
- Existing link-in-bio usage
- Whether they are real / findable

If they give Spotify, Jovie should attempt to ingest/preview:

> “Found you. Looks like you’ve released music publicly. I’ll use this to build your artist context.”

If lookup fails:

> “I couldn’t confidently match that yet. No problem — I’ll use your answers for now.”

---

## Step 3 — Artist Context

Ask:

> “Describe your music in one sentence.”

Follow-up only if needed:

> “Who are 2–3 artists your fans might also listen to?”

Extract:

- Genre
- Scene
- references
- positioning
- audience expectation
- tone

Internal example:

```json
{
  "artist_positioning": "Dark melodic techno artist with cinematic vocals",
  "genre_tags": ["melodic techno", "dark pop", "electronic"],
  "reference_artists": ["Anyma", "CamelPhat", "RÜFÜS DU SOL"]
}
```

---

## Step 4 — Release Cadence

Ask:

> “How often are you releasing music right now?”

Options:

- Weekly / multiple times per month
- Monthly
- Every few months
- A few times per year
- Rarely / still preparing first release

Then ask:

> “How many finished or nearly-finished songs do you have right now?”

Options:

- 0
- 1
- 2–3
- 4–10
- 10+

This directly qualifies the **4 songs → 52 Fridays** thesis.

High-priority users:

- Already releasing
- Have unreleased music
- Need release ops help
- Have enough volume for automation

---

## Step 5 — Pain Discovery

Ask:

> “What part of releasing music feels most broken for you?”

Options:

- Planning releases
- Making content
- Getting fans to actually listen
- Collecting emails / SMS
- Selling merch
- Getting pre-saves
- Following up after release day
- Knowing what to do next
- Other

Then:

> “What do you currently use to manage this?”

Options:

- Linktree / Beacons / Feature.fm / ToneDen / Laylo / ConvertKit / Mailchimp / Google Sheets / Notes app / nothing / other

This gives competitor intelligence and urgency.

---

## Step 6 — Superhuman Qualification Question

Ask:

> “How disappointed would you be if Jovie could automatically plan, launch, and follow up on every release — but you couldn’t use it?”

Options:

- Very disappointed
- Somewhat disappointed
- Mildly disappointed
- Not disappointed

Then ask the Superhuman follow-up:

> “What would be the main reason?”

This answer is gold. Store it verbatim.

It becomes:

- positioning research
- landing page copy
- investor quote material
- product roadmap signal

---

## Step 7 — Commercial Intent

Ask:

> “If Jovie saved you hours every release and helped you build a fan list automatically, what would you realistically pay?”

Options:

- I need it free
- $19/mo
- $39/mo
- $99/mo
- $199+/mo if it drives real revenue

This should not hard-sell them. It qualifies willingness to pay.

---

## Step 8 — Access Decision

After the interview, Jovie should silently score the user.

### Qualification Score

| Signal | Points |
|---|---:|
| Has public music | +20 |
| Has Spotify / DSP catalog | +15 |
| Releases monthly or faster | +20 |
| Has 4+ unreleased songs | +15 |
| Says “very disappointed” | +20 |
| Already uses paid music tools | +10 |
| Willing to pay $39+ | +10 |
| Has meaningful audience | +10 |
| Touring / DJ / live performer | +10 |
| Has merch or wants merch | +5 |

Total possible: ~135.

---

# Waitlist Lanes

## Lane A — Immediate Priority

**Score:** 85+

Message:

> “You look like a strong fit for early access. Jovie is best for artists actively releasing music and trying to turn attention into owned fan relationships. We’re preparing your artist context now.”

CTA:

> **Join priority waitlist**

Secondary:

> “Want faster access? Add your Spotify and Instagram.”

---

## Lane B — Standard Waitlist

**Score:** 50–84

Message:

> “You’re a fit for Jovie, especially as your release calendar gets more active. We’ll use your answers to prepare your artist profile and notify you when your onboarding batch opens.”

CTA:

> **Join waitlist**

---

## Lane C — Nurture / Early Artist

**Score:** under 50

Message:

> “You’re early, which is fine. Jovie will be more useful once you have music ready to release. We’ll send you release planning tools and notify you when the early-artist workflow opens.”

CTA:

> **Join early artist list**

This keeps them without pretending they are the ideal ICP.

---

# Data Model

Minimum useful schema:

```ts
type WaitlistApplicant = {
  id: string;
  email: string;
  artistName?: string;
  primaryLink?: string;
  spotifyUrl?: string;
  instagramUrl?: string;
  tiktokUrl?: string;

  artistDescription?: string;
  genreTags?: string[];
  referenceArtists?: string[];

  releaseCadence?: 
    | "weekly"
    | "monthly"
    | "quarterly"
    | "few_per_year"
    | "rarely";

  unreleasedSongsCount?: 
    | "0"
    | "1"
    | "2_3"
    | "4_10"
    | "10_plus";

  biggestPain?: string[];
  currentTools?: string[];

  disappointmentScore?: 
    | "very_disappointed"
    | "somewhat_disappointed"
    | "mildly_disappointed"
    | "not_disappointed";

  disappointmentReason?: string;

  willingnessToPay?: 
    | "free"
    | "19"
    | "39"
    | "99"
    | "199_plus";

  qualificationScore: number;

  lane:
    | "priority"
    | "standard"
    | "early_artist"
    | "manual_review";

  rawTranscript: ChatMessage[];

  createdAt: Date;
};
```

---

# UX Details

## Chat Interface

Use a premium dark-mode chat UI consistent with Jovie:

- One question at a time
- Short messages
- Fast transitions
- Inline chips for structured answers
- Free-text when answers matter
- Progress indicator: “Question 3 of 8”
- No giant form
- No dead-end loading states

The chat should feel like:

> “An intelligent manager is interviewing me.”

It should avoid feeling like:

> “A SaaS lead form with bubbles.”

---

## Suggested UI Structure

```txt
[ Jovie logo ]

Let’s see if Jovie can help with your next release.

────────────────────────

Jovie
What’s your artist name?

[ Tim White                    ]

────────────────────────

Progress: 1 / 8
```

For chips:

```txt
How often are you releasing music right now?

[ Weekly ] [ Monthly ] [ Every few months ]
[ A few times per year ] [ Still preparing ]
```

---

# Final Confirmation Screen

Do not just show “submitted.”

Show what Jovie learned.

Example:

```txt
You’re on the priority waitlist.

Jovie learned:

Artist: Tim White
Current motion: Releasing singles
Main pain: Turning releases into repeatable fan growth
Best fit: Release planning + fan capture + automated follow-up

Next:
We’ll prepare your artist profile and notify you when your batch opens.
```

CTA buttons:

- **Share Jovie with another artist**
- **Add another link**
- **Follow Jovie updates**

---

# Viral Referral Layer

After waitlist submission:

> “Know another artist who releases often and hates doing promo manually?”

CTA:

> **Invite an artist**

Referral reward:

- Move up the waitlist
- Unlock earlier profile import
- Get free first month of Pro
- Get early access to Fan Alerts

Keep it clean. No fake scarcity.

---

# Admin View

The internal waitlist dashboard should show:

| Artist | Score | Lane | Pain | Cadence | WTP | Links |
|---|---:|---|---|---|---|---|
| Tim White | 92 | Priority | Follow-up after release | Monthly | $39 | Spotify, IG |

Admin actions:

- Approve
- Invite to onboarding
- Request more info
- Mark as bad fit
- Generate artist profile
- Generate onboarding summary
- Add to CRM/email sequence

---

# Agent Prompt to Build It

Use this with your coding agent:

```txt
Build a world-class waitlist onboarding chat for Jovie.

The experience should interview artists in a conversational Superhuman-style flow, qualify them, collect structured artist context, and place them into the correct waitlist lane.

Do not build a generic signup form. Build a premium chat-based interview.

Core requirements:

1. Create a dark-mode Jovie-branded onboarding chat UI.
2. Ask one question at a time.
3. Use a mix of free-text responses and selectable answer chips.
4. Keep the flow short: roughly 8 core questions.
5. Collect artist name, best link, artist description, release cadence, unreleased song count, biggest release pain, current tools, Superhuman-style disappointment score, reason, and willingness to pay.
6. Store the full transcript.
7. Parse/store structured fields separately from the transcript.
8. Compute a qualification score.
9. Assign the applicant to one of these lanes:
   - priority
   - standard
   - early_artist
   - manual_review
10. Show a personalized confirmation screen that summarizes what Jovie learned.
11. Avoid making the waitlist feel like a dead-end. Make the user feel selected and understood.
12. Include a referral/share step after submission.
13. Build this in a way that can later support Spotify/Instagram/TikTok enrichment, but do not block the MVP on third-party enrichment.
14. Make the UI feel premium, fast, and deliberate: minimal copy, strong spacing, smooth transitions, no layout shift, no duplicated headers, no generic SaaS form styling.
15. Include loading states, empty states, validation, error handling, and mobile responsiveness.
16. Add an internal admin-facing summary object for each applicant.

Scoring logic:

- Has public music: +20
- Has Spotify/DSP link: +15
- Releases monthly or faster: +20
- Has 4+ unreleased songs: +15
- Says they would be “very disappointed” without Jovie: +20
- Already uses paid music tools: +10
- Willing to pay $39+/mo: +10
- Has meaningful audience or strong social links: +10
- Touring/DJ/live performer: +10
- Has merch or wants merch: +5

Lane logic:

- 85+ = priority
- 50–84 = standard
- under 50 = early_artist
- unclear/fraudulent/incomplete = manual_review

The tone should be direct, sharp, and music-industry-native. Jovie should sound like an AI manager interviewing an artist, not a customer support bot.
```

---

# MVP Version

Ship this first:

1. Chat UI
2. 8-question flow
3. Email capture
4. Transcript storage
5. Structured field storage
6. Score calculation
7. Waitlist lane assignment
8. Personalized confirmation screen
9. Admin table

Do enrichment later.

---

# Later Version

Add:

- Spotify artist lookup
- Catalog import
- social follower detection
- Linktree/Feature.fm/Beacons detection
- auto-generated artist profile preview
- “your next 4 release moments” preview
- referral ranking
- batch invite system
- lifecycle email sequence
- founder review queue
- CRM tagging

---

# The Key Question

The whole flow should orbit one question:

> **“Are you an artist with enough release motion that an AI manager can compound your output?”**

If yes, prioritize them.

If no, keep them warm.

That is the waitlist.


## See Also
- [[chatgpt/chatgpt_waitlist-and-onboarding-system]]
- [[chatgpt/chatgpt_onboarding-chat-plan]]
- [[chatgpt/chatgpt_onboarding-chat-refinement]]
- [[chatgpt/chatgpt_onboarding-chat-ux-qa]]
- [[chatgpt/chatgpt_soft-auth-waitlist-strategy]]
