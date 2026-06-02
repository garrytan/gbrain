---
title: "Landing Page Audit"
type: guide
created: 2026-05-11
updated: 2026-05-11
source: chatgpt-export
conversation_id: 6a02287d-2d7c-83e8-ad4e-694e954e2d36
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# Landing Page Audit

> Conversation ID: 6a02287d-2d7c-83e8-ad4e-694e954e2d36
> Created: 2026-05-11T19:05:34Z
> Updated: 2026-05-11T19:54:46Z
> Messages: 7

---

## User

review jov.ie landing page. audit it. ground it in our recent chats. what needs to change. for now i just want to drive waitlist signups and keep it looking like a game changer product without disclosing too much as i start raising/getting intial beta users

---

## Assistant

Mr. White, I’ll audit the live Jovie page against your waitlist, fundraising, and beta goals, using recent context to prioritize conversion, category-defining positioning, and controlled disclosure.

---

## Assistant

I’m seeing a consistent mismatch: the site presents an open SaaS/product exploration flow with split CTAs, pricing/trial cues, and too much public roadmap detail.

---

## Assistant

Mr. White — the current site feels **too launched** for your actual phase.

It proves Jovie is real, but it weakens the waitlist motion by presenting a public SaaS product with trials, pricing, feature menus, docs, changelog, investor page, and roadmap-level detail. For raising and initial beta users, the page should feel like a **private beta for a category-defining artist operating system**.

## Core diagnosis

The homepage currently leads with “Release more music with less work,” “Start Free Trial,” “Explore Profiles,” a full feature menu, a pricing link, and public product sections. That reads as available/self-serve rather than selective/invite-only. citeturn849182view0

Your recent direction was controlled waitlist access, high-signal beta users, source/role tracking, and manual invite control. The site should optimize for **qualified demand**, not immediate self-serve signup.

## What needs to change first

### 1. Replace every primary CTA with one CTA: **Request Access**

Current CTA language is fragmented: “Start Free Trial,” “Claim your profile,” “Request Access,” “Contact Sales,” and “Start Pro Trial” all appear across the site. The pricing page also publicly shows Free, Pro, Team, and Enterprise plans with $39/mo and $99/mo anchors. citeturn569491view4

Use one motion everywhere:

**Request beta access**

Secondary CTA, if needed:

**See how it works**

Avoid “Start Free Trial” for now. It makes Jovie feel commoditized and available. You want scarcity, qualification, and signal.

### 2. Change the hero from task relief to category creation

“Release more music with less work” is clear, but it feels like productivity SaaS. The game-changing version is about owning the artist-fan surface.

Use this:

> **The artist operating system for turning traffic into fans.**  
> Jovie connects every release, profile visit, QR scan, and show into one intelligent fan path — so each drop builds an audience you can reach again.

CTA:

> **Request beta access**

Microcopy:

> Private beta. No credit card. We’re prioritizing artists and teams with upcoming releases.

This keeps the product big without exposing the full system.

### 3. Reduce the nav hard

For this phase, the public nav should be:

**Jovie** | **Product** | **Request Access**

Footer should be:

**Sign in** | **Contact** | **Privacy** | **Terms**

Remove public nav/footer links to Pricing, Changelog, Investors, Compare, Alternatives, Help Center, Docs, Status, and Product Demo. Some can exist behind direct private links, but they should not be part of the main funnel.

The current footer exposes Investors, Changelog, Blog, Compare, Alternatives, Help Center, and Status from the homepage. citeturn849182view0

### 4. Gate or remove over-disclosing pages

The public `/launch` page discloses too much: adaptive CTAs, email/SMS notifications, streaming preference memory, AI assistant, Spotify Canvas generator, Apple Lyrics formatter, impersonation alerts, fan scoring, source attribution, export/sync, cross-artist patterns, smart routing model, and an internal LTV estimate. That is investor-deck-level or roadmap-level content. citeturn838374view0

The public docs expose feature docs, Chat & AI, Tips, Analytics, an API reference, the API base URL, and planned API sections for profiles, releases, audience, and analytics. citeturn276736view0 citeturn152558view0 citeturn152558view1

The changelog exposes internal implementation details like `AuthShell`, sign-in/sign-up refactors, OAuth behavior, internal ticket IDs, marketing screenshot capture behavior, and Mac app release details. citeturn549784view1

Action: gate these, unpublish them, or at minimum remove links and add noindex. For anything strategically sensitive, authentication is the real fix.

### 5. Keep the product aura, show less mechanism

Keep these concepts:

- “Artist profiles built to convert”
- “Capture every fan”
- “Automatic fan notifications”
- “One workspace for every release”
- “Built for artists. By artists.”

These are strong and already present on the site. citeturn849182view0

Cut the exhaustive feature list. Replace it with three outcome cards:

**Capture**  
Turn profile visits, QR scans, release traffic, and show moments into reachable fans.

**Route**  
Send every fan to the right release, platform, show, or action.

**Reactivate**  
Bring fans back when the next drop or nearby show matters.

That communicates the system without giving away the full product map.

## Recommended homepage structure

### 1. Hero

Eyebrow:

> Private beta for artists and teams

Headline:

> The artist operating system for turning traffic into fans.

Subhead:

> Jovie connects releases, profiles, smart links, fan capture, and reactivation into one intelligent surface — built so every drop compounds.

Form:

- Email
- Role: Artist / Manager / Label / Creator / Other
- Artist or company
- Button: **Request beta access**

Microcopy:

> Invite-only. We’re prioritizing artists and teams with active releases.

### 2. Proof strip

Current logo strip says “Trusted by artists and teams releasing on” followed by AWAL, The Orchard, Universal Music Group, Armada, and others. citeturn849182view0

That wording can imply official customer or partner relationships. Safer wording:

> Built by music operators with releases and campaigns across

or

> For artists and teams operating across

Keep the logos if defensible. Tighten the claim.

### 3. Product preview

Show one premium product visual. Blur or abstract deeper UI.

Caption:

> One surface for the fan path: release, profile, capture, route, return.

Avoid showing admin UI, internal labels, tables of fake user data, roadmap features, or implementation detail.

### 4. The problem

Use the investor-page insight publicly, without the investor framing:

> Every campaign ends at the same choke point: the artist profile. Jovie turns that surface from a link list into a fan path.

The public investor page already states the “traffic choke point,” “compounding data asset,” and “revenue paths” thesis. That is useful language, but it should live in the product story, with less strategic detail. citeturn549784view0

### 5. Three outcomes

Use **Capture / Route / Reactivate**.

No feature matrix. No pricing. No API. No AI roadmap.

### 6. Private beta CTA

Headline:

> Request access to the private beta.

Subhead:

> We’re opening Jovie in small cohorts for artists and teams preparing real releases.

Fields:

- Email
- Role
- Artist/company
- Spotify/artist URL
- Upcoming release? Yes/No
- Hidden: UTM, referrer, page path, plan intent, duplicate status

Confirmation:

> You’re on the list. Add your artist link and upcoming release details to help us prioritize your invite.

## Waitlist system requirements from our recent direction

Track:

- Total signups
- New signups by day/week
- Role breakdown
- Artist/company
- Source/UTM/referrer
- High-signal users
- Invited users
- Activated users
- Invite-to-activation conversion
- Duplicate prevention
- Manual invite status: waitlisted, qualified, invited, activated, declined

This matters because fundraising wants evidence of demand quality, not just raw email count.

## Specific cuts

Remove or hide:

- Public pricing matrix
- “Start Free Trial”
- Public changelog
- Public investor page link
- Public docs/API reference
- Product roadmap pages
- `/launch` page from public nav
- Compare/Alternatives links that resolve poorly or look unfinished
- AI feature specifics: Canvas, lyrics formatting, impersonation alerts, model/flywheel, fan scoring, internal LTV
- Technical implementation details and internal ticket IDs

Keep:

- Premium product visuals
- Founder/operator credibility
- Music-specific positioning
- “Built to convert”
- “Capture every fan”
- Invite-only beta
- Clear waitlist form
- One strong CTA

## Best immediate version

**Headline:**  
The artist operating system for turning traffic into fans.

**Subhead:**  
Jovie connects every release, profile visit, QR scan, and show into one intelligent fan path — so each drop builds an audience you can reach again.

**CTA:**  
Request beta access

**Microcopy:**  
Private beta. No credit card. Prioritizing artists and teams with upcoming releases.

**Section line:**  
Every artist’s traffic ends somewhere. Jovie makes it compound.

That gives you the “game changer” feel while revealing only the outcome, not the machinery.

---

## User

ground this your knoweldge of jovie and recent convos. i wanna keep funneling then into the chat and the chat will user invterview them and waitlist them or qualify them etc.

---

## Assistant

I’ll frame this as a chat-first funnel: the landing page builds intrigue, then the chat interviews, qualifies, prioritizes, and waitlists users.

---

## Assistant

Mr. White — yes. The correct move is **not “landing page → waitlist form.”** It should be:

> **Landing page → Jovie Chat → user interview → qualification → waitlist/invite/sales review**

That fits the product better and preserves the “game changer” feeling.

## The strategic shift

The homepage should make users feel like they are already using Jovie.

Right now, the page presents Jovie like a normal SaaS site: nav menus, features, pricing, “Start Free Trial,” “Explore Profiles,” and a public pricing section. The live homepage also does not appear to position chat as the main entry point; a text search of the page found no “chat” match. citeturn130730view2turn130730view3turn130730view0

But the strongest thing already on the page is this idea:

> Ask Jovie for the launch plan; Jovie drafts the fan path, creates the task list, and assigns next actions.

That is the product. That should be the funnel. citeturn130730view2

## What I would change

### 1. Make the hero a chat box

Replace the current above-the-fold CTA with a large Jovie Chat input.

**Headline:**

> Tell Jovie what you’re launching.

**Subhead:**

> Jovie turns your release, profile, and fan traffic into a path that captures fans and brings them back.

**Chat placeholder:**

> “I have a song coming out next month and want to capture fans…”

**Prompt chips:**

- Launch my next release
- Claim my artist profile
- Capture fans from my links
- Build a fan path for my drop
- Apply for beta access

**Primary button:**

> Start with Jovie

The user should feel like they are talking to the product, not filling out a lead form.

### 2. Change the CTA language everywhere

Remove:

- Start Free Trial
- Claim your profile
- Contact Sales
- Explore Profiles as a primary CTA

Use one core CTA:

> Start with Jovie

Secondary CTA:

> See what Jovie does

The current “Start Free Trial” CTA fights the private-beta strategy and makes the product feel self-serve/commodity. citeturn130730view2

### 3. Route the user into a lightweight public chat

For now, avoid forcing auth before the interview.

Recommended flow:

1. User types into homepage chat.
2. Jovie opens `/chat` or `/start`.
3. The first message is preserved.
4. Jovie interviews them.
5. Jovie asks for email after it has context.
6. Jovie assigns a status: waitlisted, qualified, priority beta, team review, or low-signal waitlist.
7. The lead gets stored with transcript summary, source, role, intent, and qualification reason.

This is better than a static waitlist because every signup becomes investor-useful data.

## The chat interview flow

Jovie should ask short, useful questions. No long form.

### Opening

> Tell me what you’re working on — a release, artist profile, fan capture, tour, team workflow, or something else?

### Then collect

- Role: artist, manager, label, creator, team, other
- Artist or company name
- Artist/profile link
- Upcoming release or campaign date
- Main goal: streams, presaves, email/SMS capture, shows, merch, payments, team workflow
- Current tools: Linktree, ToneDen, Feature.fm, Beacons, Hypeddit, custom site, spreadsheets, none
- Audience size or rough traction
- Team size
- Urgency
- Email

### Qualification logic

Use hidden scoring.

High-signal users:

- Have an upcoming release in the next 90 days
- Provide a real artist/profile link
- Are artists, managers, labels, or teams
- Have traffic but poor fan capture
- Mention presaves, smart links, fan reactivation, city routing, or release ops
- Are willing to test now
- Came from a warm source

Routes:

| Route | Criteria | Result |
|---|---|---|
| Priority beta | Real artist/team + active release + clear pain | “You’re a strong fit. We’ll prioritize your beta invite.” |
| Standard waitlist | Real user, less urgency | “You’re on the waitlist.” |
| Team review | Manager, label, agency, multiple artists | “We’ll review this as a team workflow.” |
| Low signal | Vague, no artist, no campaign | “You’re on the general waitlist.” |
| Investor/media | Not a user | Separate hidden tag |

## The data model you need

Every chat-created lead should save:

```ts
{
  email,
  name,
  role,
  artistName,
  companyName,
  artistUrl,
  source,
  utmSource,
  utmMedium,
  utmCampaign,
  referrer,
  initialPrompt,
  transcriptSummary,
  desiredOutcome,
  currentTools,
  upcomingReleaseDate,
  audienceSize,
  teamSize,
  urgency,
  qualificationScore,
  qualificationReason,
  status,
  tags,
  createdAt,
  lastContactedAt,
  invitedAt,
  activatedAt
}
```

Statuses:

```ts
"chat_started"
"interview_in_progress"
"waitlisted"
"qualified_beta"
"priority_beta"
"team_review"
"invited"
"activated"
"not_fit"
```

This gives you fundraising metrics beyond “emails collected.”

You can say:

> We’re collecting qualified beta demand through an AI-led onboarding interview. X% are artists or teams with upcoming releases. Y% have active campaigns. Z% requested fan capture, release links, or profile automation.

That is much stronger than “we have a waitlist.”

## The homepage structure I’d use

### Section 1 — Chat hero

> Tell Jovie what you’re launching.

Large input. Prompt chips. Minimal copy.

### Section 2 — What Jovie does

Three cards only:

**Plan the drop**  
Jovie turns release context into a launch plan.

**Build the fan path**  
Every link, profile visit, QR scan, and campaign route points fans to the right action.

**Bring fans back**  
Fans opt in once. Jovie helps you reach them for the next drop or show.

These map to what the current page already says about release plans, fan paths, profile updates, and notifications. citeturn318140view0

### Section 3 — Private beta

> Jovie is opening in small cohorts for artists and teams with active releases.

CTA:

> Start with Jovie

### Section 4 — Proof, lightly

Keep music credibility, but avoid overclaiming.

Current copy says “Trusted by artists and teams releasing on” above distributor/label logos. citeturn318140view0

Safer version:

> Built for artists and teams operating across modern music platforms.

Or:

> Designed around real release workflows across independent and label campaigns.

### Section 5 — Final chat CTA

> Start with your next release.

Input again.

## What to remove from the public funnel

Remove or hide from the landing-page path:

- Pricing section
- “Free forever”
- $39/mo and $99/mo plan anchors
- Start Free Trial
- Feature mega-menu
- Public roadmap-like feature lists
- Changelog link
- Investor link
- Docs/API links
- Compare/Alternatives links
- Too many footer links

The homepage currently exposes pricing directly on the page, including Free, Pro, Team, Enterprise, waitlist labels, and monthly price anchors. citeturn130730view3

For raising and early beta, that gives away too much structure too early.

## The exact page direction

Use this:

> **Tell Jovie what you’re launching.**  
> Jovie turns your release, profile, and fan traffic into a path that captures fans and brings them back.

Chat input:

> I’m dropping a new song and want to…

Prompt chips:

> Build my release plan  
> Capture fans from my links  
> Claim my artist profile  
> Route fans to my next drop  
> Apply for beta access

Microcopy:

> Private beta. Jovie will ask a few questions and route you to the right invite path.

Confirmation after chat:

> You’re on the list. Based on what you shared, we’ll prioritize beta access for artists and teams with active releases.

For high-signal users:

> You look like a strong fit for the private beta. We’ll review your artist/team details and follow up with next steps.

## Bottom line

Make Jovie Chat the product demo, waitlist form, and qualification layer.

The landing page should create intrigue and push people into one action:

> **Start a conversation with Jovie.**

Then the chat extracts the data you need, qualifies users, and gives you a better fundraising story: not just demand, but structured evidence of who wants Jovie, why they want it, what they are using today, and which users are worth inviting first.


## See Also
- [[chatgpt/chatgpt_landing-page-audit-prompt]]
- [[chatgpt/chatgpt_landing-page-audit]]
- [[chatgpt/chatgpt_yc-audit-for-landing-page]]
- [[chatgpt/chatgpt_2026-landing-page-workflow]]
- [[chatgpt/chatgpt_ai-landing-page-workflow]]
