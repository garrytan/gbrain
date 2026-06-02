---
title: "MusicBrainz Contributor Guide"
type: guide
created: 2026-01-25
updated: 2026-01-25
source: chatgpt-export
topic: design-ux
message_count: 8
tags: [chatgpt, knowledge, design-ux]
---
# MusicBrainz Contributor Guide

> **Source:** ChatGPT conversation
> **Date:** 2026-01-25T19:25:26Z
> **Messages:** 8
> **Topic:** design-ux

## Question

musicbrainz contributer

## Answer

A **MusicBrainz contributor** is someone who helps build and improve the **MusicBrainz** music metadata database by adding, editing, and maintaining information about artists, recordings, releases, and related data. citeturn0search0

**Key points about being a contributor:**

**• Collaborative editing:** Anyone with an account can submit edits—like adding a new artist, album (release), track, or relationships between entities (e.g., credits). These edits go into an edit queue and are reviewed/voted on by other contributors. citeturn0search0

**• Types of contributions:**  
- **Add data:** Enter new artists, releases, recordings, tracklists, etc. citeturn0search0  
- **Improve/maintain data:** Correct errors, merge duplicates, update metadata, add relationships like composer, performer, and other credits. citeturn0search6  
- **Support tools & infrastructure:** Some contributors write code, documentation, or help with the community and site features. citeturn0search0

**• Contribution tools:** You can edit directly via the MusicBrainz website, use tools like **MusicBrainz Picard** to submit fingerprints (AcoustIDs) and metadata, or help tag digital files that feed into the database. citeturn0search0

**• Community-driven:** MusicBrainz is a volunteer-driven project where contributors’ edits help grow and refine the open music metadata used by tagging apps, streaming services, and research tools. citeturn0search11

In short, being a MusicBrainz contributor means participating in the collective improvement of a structured, open music metadata library.

## Question

talk to me about bot contributor. for jovie were going to have a ton of first party data from verified artists. can we have a Jovie bot that updates musicbrainz on behalf of artists if we have confidence in the data?

## Answer

Yes, Mr. White — **this is feasible**, but only if you play by **MusicBrainz’s bot and data-quality rules**. Here’s the straight, factual breakdown.

---

## What a **MusicBrainz bot contributor** is
A bot contributor is an **automated editor** that submits edits via the MusicBrainz API instead of a human using the UI. These are allowed, but **tightly governed**.

Core principle: **MusicBrainz optimizes for accuracy and verifiability over speed**.

---

## Can a Jovie bot submit edits on behalf of artists?
**Yes, conditionally.** MusicBrainz already accepts bot edits from trusted sources (labels, libraries, archives). Your idea fits the model *if executed correctly*.

But **“verified artist” ≠ automatically trusted** in MusicBrainz terms.

---

## MusicBrainz requirements you must meet

### 1. **Explicit bot registration**
You must:
- Register a dedicated MusicBrainz account for the bot
- Declare it publicly as a bot
- Document:
  - Data sources
  - Validation logic
  - Scope of edits

Undeclared automation = ban risk.

---

### 2. **Conservative edit scope (critical)**
Approved bots usually stick to **low-dispute data**, such as:
- New releases
- Tracklists
- Release dates
- Labels
- URLs (official artist/label links)
- ISRCs (if validated)

⚠️ **High-dispute data** (artist credits, relationships, composer splits, featured artist semantics) should:
- Either stay human-submitted
- Or go into the normal voting queue with **no auto-approval**

---

### 3. **Human-reviewed or vote-gated edits**
Best practice (and strongly recommended):
- Bot submits edits
- Edits enter **open voting**
- Experienced editors can review / reject

Trying to bypass this = immediate community backlash.

---

### 4. **Transparent provenance**
Every edit note must clearly state:
> “Data supplied by artist via Jovie (verified account)”

MusicBrainz editors care **more about provenance than confidence scores**.

---

## How Jovie *should* frame trust
This framing works:

✅ “Artist-submitted, identity-verified, platform-authenticated metadata”  
❌ “Authoritative / canonical / guaranteed correct”

MusicBrainz ideology: **no single source is infallible**, including artists.

(Artists get things wrong *all the time*.)

---

## Recommended architecture (clean + scalable)

**Tiered submission model**
- **Tier 1 (Bot, auto-submit):**
  - Releases
  - Tracklists
  - Dates
  - URLs
- **Tier 2 (Bot + vote):**
  - Credits
  - Featured artist roles
- **Tier 3 (Human only):**
  - Complex relationships
  - Historical corrections
  - Merges

This mirrors how Discogs + MusicBrainz successful bots operate.

---

## Strategic upside for Jovie
If done right:
- Jovie becomes a **trusted upstream metadata source**
- You gain leverage with DSPs, tagging tools, and archives
- You align with open-data ecosystems instead of fighting them

If done wrong:
- Your bot gets blocked
- Your brand gets flagged in editor forums
- Trust is hard to regain

---

## Bottom line
**Yes — build the bot.**  
But:
- D

*(Answer truncated — 3276 chars total)*

## Question

how can we reliable verify spotify artists 

## Answer

Mr. White — **reliable Spotify artist verification is doable**, but only if you **anchor identity to Spotify-controlled signals**, not self-assertion. Here’s the clean, defensible stack.

---

## The only signals that actually matter

### 1. **Spotify for Artists OAuth (non-negotiable)**
This is the **gold standard**.

**Why it works**
- Spotify has already verified control of the artist profile
- OAuth proves the user controls the Spotify for Artists account
- You can cryptographically bind:
  - Spotify Artist ID
  - Spotify User ID
  - Timestamp + token scope

**Implementation**
- Require Spotify for Artists login
- Store artist URI + OAuth grant
- Periodically re-validate token

**This alone is sufficient** for “Spotify-verified artist” claims.

---

### 2. **Artist URI + profile mutation check (strong secondary)**
After OAuth, require a **proof-of-control action**:

Examples:
- Temporary bio change with a verification phrase
- Add/remove a specific external link
- Update artist image → revert

This protects against:
- Delegated access abuse
- Label/manager impersonation edge cases

---

### 3. **ISRC cross-validation (supporting, not primary)**
Match artist-submitted ISRCs against:
- Spotify catalog
- Release ownership patterns
- Historical release cadence

Useful for **sanity checking**, but **never sufficient alone**.

ISRCs are frequently misassigned.

---

### 4. **Distributor metadata consistency**
If available, validate against:
- Distributor feeds (DistroKid, CD Baby, TuneCore, etc.)
- Matching artist name + Spotify Artist ID
- Consistent label / copyright owner

This increases confidence but should **not block verification**.

---

## What does NOT count as verification (do not rely on)
- Email domain matching  
- Social media accounts  
- Press links  
- Artist statements  
- “I uploaded the music” claims  

These are trivial to fake and will not stand up to scrutiny (or MusicBrainz editors).

---

## Recommended verification tiers (what you should expose publicly)

**Tier A — Spotify-Verified Artist**
- Spotify for Artists OAuth
- Artist URI bound
- Periodic token refresh

**Tier B — Spotify-Linked (Not Verified)**
- Artist URI supplied
- No OAuth
- Read-only privileges

**Tier C — Unverified**
- No Spotify linkage
- Manual or fan-submitted data only

Only **Tier A** should be allowed to:
- Submit first-party metadata
- Trigger bot submissions
- Claim “artist-supplied” provenance

---

## For MusicBrainz specifically
When your bot submits data, the edit note should say:

> “Artist verified via Spotify for Artists OAuth on Jovie; data supplied directly by artist representative.”

That phrasing aligns with MusicBrainz norms and avoids overclaiming authority.

---

## Bottom line
If you do **Spotify for Artists OAuth + URI binding**, you have:
- A defensible identity proof
- Platform-grade verification
- Zero reliance on trust narratives

If you want, I can:
- Design the exact OAuth + re-verification flow
- Map verification tiers to Mu

*(Answer truncated — 3081 chars total)*

## Question

can we submit to genius as a bot?

## Answer

Short answer, Mr. White: **Yes, but it’s materially harder than MusicBrainz, and the scope is narrower.**

Here’s the factual breakdown.

---

## Can you submit to **entity["organization","Genius","lyrics platform"]** as a bot?
**Technically yes. Practically: only with explicit approval and tight limits.**

Genius does **not** have an open, community-friendly bot ecosystem like MusicBrainz.

---

## How Genius actually works (important)
Genius is:
- Editorially moderated  
- Reputation-weighted  
- Protective of lyric accuracy and interpretation  

They treat automation as **risk**, not leverage.

---

## What Genius allows today

### 1. **API access ≠ edit permission**
Genius has an API, but it is:
- Primarily **read-only**
- Intended for search, annotations display, metadata consumption

The API **does not grant lyric submission or edit rights by default**.

---

### 2. **Bots require manual whitelisting**
If you want a bot that:
- Submits lyrics
- Updates credits
- Adds annotations
- Edits song metadata  

You must:
- Contact Genius directly
- Explain:
  - Data source
  - Verification model
  - Human oversight
  - Rollback procedures

This is **relationship-based**, not policy-based.

---

## What Genius is most likely to approve

### Low-risk (possible)
- Song metadata corrections (titles, release dates)
- Artist attribution fixes
- Link normalization
- Verified artist lyric submissions **for new releases only**

### High-risk (usually rejected)
- Bulk lyric ingestion
- Retroactive lyric overwrites
- Automated annotation publishing
- Interpretation or meaning edits

Lyrics are the **core IP and brand surface** for Genius.

---

## Critical difference vs MusicBrainz
MusicBrainz:
- Optimizes for structured facts
- Accepts machine-generated edits
- Prefers provenance over authority

Genius:
- Optimizes for *accuracy + cultural trust*
- Prefers humans, even if slower
- Treats artists as privileged but not infallible

An artist being verified **helps**, but does not remove editorial review.

---

## How Jovie should position itself (if you approach Genius)

Use this framing:
> “Artist-verified submissions for *new releases*, with human review and explicit rollback.”

Avoid:
- “Authoritative”
- “Canonical”
- “Automated corrections”

Those words will kill the conversation.

---

## Recommended Jovie strategy

**Hybrid model (most realistic):**
- Bot handles:
  - Draft creation
  - Metadata prefill
- Humans (or Genius editors) hit “publish”

This mirrors how Genius works internally.

---

## Bottom line
- **MusicBrainz:** bot-first is normal  
- **Genius:** bot-first is a red flag  

You *can* integrate, but:
- Expect manual approval
- Expect limits
- Expect slower iteration

If you want, I can:
- Draft an outreach proposal to Genius
- Define a “new release only” submission policy
- Compare ROI of Genius vs MusicBrainz vs DSP-native metadata surfaces
