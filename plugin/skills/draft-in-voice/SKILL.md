---
name: draft-in-voice
version: 1.0.0
description: >
  Ghostwrite content in a specific person's voice from a VALIDATED voice
  profile — tweets, replies, short posts, launch copy, recruiting blurbs,
  emails. Loads the subject's voice profile (people/<slug>-voice) plus
  first-party context from the brain, drafts 2-3 options in-register, then
  runs a hard voice-fidelity self-check before showing anything. Includes
  the profile BUILDER: if no validated profile exists, drafting hard-stops
  and this skill walks the corpus-to-fingerprint build instead. Never
  auto-posts.
triggers:
  - "draft in voice"
  - "write this as"
  - "make this sound like"
  - "ghostwrite"
  - "draft a tweet as"
  - "write a post as"
  - "in their voice"
  - "in my voice"
  - "build a voice profile"
mutating: true
writes_pages: true
writes_to:
  - people/
upstream: draft-in-voice@fc834ee
---

# draft-in-voice — Memory-Grounded Ghostwriting

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) —
> the voice profile and all substance come from the brain, never from memory
> or improvisation.
>
> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation and back-link rules, and
> [_brain-filing-rules.md](../_brain-filing-rules.md) — voice profiles are
> person-subject pages and file under `people/`.

## What this is

Ghostwrite in a specific person's voice with high fidelity. The voice work is
done UPSTREAM: a validated voice profile already exists in the brain at
`people/<slug>-voice` (e.g. `people/alice-example-voice`), and this skill is
the disciplined *application* of it. Never freehand "founder voice" or "their
voice" from memory — always load the profile and obey its hard rules.

If no validated profile exists, drafting **stops** — see
[Building a voice profile](#building-a-voice-profile) below. A made-up voice
is worse than asking.

> **The user's own voice is a special case.** If the subject is the user and
> the harness ships a dedicated personal voice skill (with its own register
> tuning and anti-AI patterns), prefer that. Use `draft-in-voice` for anyone
> else with a validated profile — colleagues, founders, partners, the people
> the user ghostwrites for — or for the user when no dedicated skill exists.

## Source of truth (read these FIRST, every time)

1. **The validated voice profile** — `gbrain get people/<slug>-voice`. The
   fingerprint, quantitative stats (median length, diction, rhythm), and the
   "how to write as this person" directive block. **This is binding.** If the
   page is missing, or its `status` is anything other than `validated`, STOP
   drafting and go to the builder appendix.
2. **First-party context** — the subject's main page (`gbrain get
   people/<slug>`) plus timeline and backlinks (`gbrain timeline <slug>`,
   `gbrain backlinks people/<slug>`): how they actually frame their work,
   their origin arc, their texture. Use for *substance* so the content is
   true to how they think, not just how they sound.
3. **(optional) Topic-specific pages** — if the draft is about a specific
   idea or company, pull the relevant page (`gbrain search "<topic>"`, then
   `gbrain get <slug>`) so every claim is accurate, not invented.

## The hard rules (read them OFF the profile)

A good voice profile encodes the person's non-negotiables. Honor whatever the
profile states. The six recurring categories to extract and obey:

1. **Tells to avoid.** Most profiles name a #1 giveaway (often em-dashes, a
   stock opener, a punctuation habit). A draft that trips the named tell is
   automatically wrong.
2. **Length discipline.** Match the profile's median length. One thought per
   short post. Cut.
3. **Register, picked not blended.** Most people have a casual register and a
   statement/technical register with different rules (caps, emoji, slang,
   jargon). Pick ONE per draft; never blend — emoji plus corporate jargon in
   the same line reads fake.
4. **Signature moves.** The profile names the person's characteristic
   constructions — use them.
5. **Banned boilerplate.** Whatever the profile bans (hashtags, "excited to
   announce", "1/n" threads, specific buzzwords) stays out.
6. **Worldview to channel.** Substance should reflect how they actually see
   the thing.

## Procedure

1. **Resolve the subject + load** `people/<slug>-voice` and first-party
   context from the brain. No validated profile → stop drafting and offer to
   build one (appendix below); do not fake it.
2. **Clarify register + intent** in one line if ambiguous: casual (chat
   energy) or statement (launch/technical)? Default casual for replies,
   statement for announcements.
3. **Draft 2-3 options**, not one. Keep each tight. Vary the angle, not the
   voice.
4. **Run the voice self-check** (below). Fix anything that flunks before
   showing the draft.
5. **Show the options + the self-check verdict.** Drafting only — posting or
   sending is the human's call and goes through the normal approval-gated
   path. This is a contract the agent upholds, not a mechanical guarantee:
   never wire a draft directly into a send.

## Voice self-check (run before showing any draft)

Score each draft against the loaded profile; fix fails, don't ship them:

- [ ] **Named-tell check:** the profile's #1 tell does not appear (auto-fail
  if it does).
- [ ] **Length:** within the profile's stated band, ideally at its median.
  One thought.
- [ ] **Register purity:** one register, not a blend.
- [ ] **No banned boilerplate:** nothing the profile explicitly bans.
- [ ] **Sounds like them, not generic:** would it sit naturally between two
  of their real posts? If unsure, pull 3 real adjacent samples from the
  corpus referenced in the profile's provenance block and compare cadence.
- [ ] **Substance is true:** every factual claim traces to a real brain page
  or first-hand fact — never invent metrics, customers, or specifics.
  Private details stay private unless the person has said them publicly.

## When the voice profile is thin or missing

Do NOT improvise. Either:

- build the profile first (appendix below), or
- tell the user the profile is missing/thin and ask for real samples to
  anchor on.

This refuse-to-draft-without-memory stance is the point of the skill: it is
brain-first discipline applied to voice.

## Building a voice profile

The builder half of the skill. Run this when drafting hard-stops on a missing
or unvalidated profile, or when the user asks to "build a voice profile".

### Step 0 — Consent

Confirm the user is authorized to ghostwrite for this person and record who
granted it and for what scope (e.g. "tweets and launch copy, not email").
Consent goes in the profile page (schema below). No consent recorded → build
stops the same way drafting stops without a profile.

### Step 1 — Gather the corpus (threshold: 20+ samples, 6+ months)

- **First-party writing only.** Their published posts, essays, emails they
  wrote, talks they gave. Never third-party descriptions, press coverage, or
  paraphrases — those capture reputation, not voice.
- **Minimum bar: 20+ samples spanning 6+ months.** Fewer samples overfit to
  a mood; a shorter span misses register variation. Below the bar, the
  profile can only be saved as `status: draft` — which does NOT unlock
  drafting.
- **Cover the target format.** If the user will ask for tweets, at least 5
  samples must be short posts; launch copy needs at least a few statement-
  register samples.
- Check what the brain already holds before asking for uploads:
  `gbrain search "<person name>"`, `gbrain backlinks people/<slug>`, and any
  `media/` archives. Ingest new samples through the normal ingest skills
  first so the profile's provenance can point at real pages.

### Step 2 — Extract the fingerprint (schema mirrors the six hard rules)

Analyze the corpus and fill all six categories — each one becomes a section
of the profile page:

| Fingerprint field | What to extract |
|---|---|
| `tells_to_avoid` | The #1 giveaway plus any others: punctuation habits, stock openers, constructions they never use. |
| `length` | Median length + band per format (tweet, reply, post, email), from actual counts — not vibes. |
| `registers` | Each distinct register (casual / statement / technical) with its own rules: caps, emoji, slang, jargon. |
| `signature_moves` | Characteristic constructions, openers, rhythms, recurring turns of phrase. |
| `banned_boilerplate` | Everything they demonstrably never do: hashtags, "excited to announce", thread numbering, buzzwords. |
| `worldview` | How they actually frame their domain — positions, recurring theses, what they care about. Cite brain pages. |

### Step 3 — Write the profile page

File at `people/<slug>-voice` (person-subject page per
`_brain-filing-rules.md`), via `gbrain put people/<slug>-voice` with the page
content on stdin. Required top-of-page metadata block:

````markdown
# Alice Example — Voice Profile

```yaml
subject: people/alice-example
status: draft            # draft | validated | stale — only `validated` unlocks drafting
profile_version: 1       # bump on every rebuild; prior versions via `gbrain history`
built_at: 2026-08-11
validated_at: null
validated_by: null
consent:
  granted_by: the user
  granted_at: 2026-08-11
  scope: "tweets + launch copy"
provenance:
  corpus_size: 26
  corpus_span: "2026-01 to 2026-08"
  sources:
    - media/x/alice-example/
    - writing/acme-example-launch-draft.md
```

## Fingerprint
### 1. Tells to avoid
### 2. Length discipline
### 3. Registers
### 4. Signature moves
### 5. Banned boilerplate
### 6. Worldview to channel

## How to write as this person
(the binding directive block the drafting half reads)
````

Back-link the profile from the subject's main page (`gbrain link
people/alice-example people/alice-example-voice --link-type has-voice-profile`
or the equivalent `add_link` op in your surface).

### Step 4 — Validate (blind check)

A profile only earns `status: validated` after it survives a blind test:

1. Hold out 5 real samples the fingerprint was NOT extracted from.
2. Draft 3 test pieces from the profile and interleave them with the
   held-out real samples.
3. Show the mixed set to the user (or the subject). If the drafts don't
   stand out, set `status: validated`, `validated_at`, `validated_by`, and
   bump nothing. If they do stand out, note WHICH tell exposed them, refine
   the fingerprint, and repeat.

### Maintenance

- **Staleness:** if the newest corpus sample is over ~12 months old, or the
  person's public voice visibly shifted, mark `status: stale` and refresh —
  a stale profile blocks drafting the same as a missing one.
- **Versioning:** every rebuild bumps `profile_version` and re-runs the blind
  check. `gbrain history people/<slug>-voice` is the audit trail.

## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Drafting NEVER proceeds without a `status: validated` voice profile at
  `people/<slug>-voice`; missing, draft, or stale profiles hard-stop into
  the builder.
- 2-3 draft options per request, each passed through the voice self-check
  before display.
- Output is drafts only — posting/sending stays a human decision on the
  approval-gated path.
- The only brain write this skill performs is the voice-profile page (and
  its back-link) under `people/`, per `writes_to:`.
- Privacy contract preserved: no real names in examples, no fork-specific
  filesystem path literals, no upstream-fork references; drafts never
  surface private details the subject hasn't made public.

## Output Format

**Drafting mode:** 2-3 labeled options, each with register + length noted,
followed by a self-check verdict per option (pass, or what was fixed).
Nothing is posted, sent, or written to the brain.

```
Option A (casual, 92 chars): ...
Option B (casual, 140 chars): ...
Option C (statement, 210 chars): ...

Self-check: A pass · B pass (trimmed to band) · C pass
```

**Builder mode:** the `people/<slug>-voice` page in the schema above
(metadata block + six fingerprint sections + directive block), plus a
one-line report of corpus size, span, and validation status.

## Anti-Patterns

- **Freehanding a voice from memory.** No validated profile → no draft. Ever.
- **Treating a `draft`/`stale` profile as good enough.** Only `validated`
  unlocks drafting.
- **Register blending.** One register per draft; mixing reads fake.
- **Inventing substance.** No made-up metrics, customers, or specifics —
  every claim traces to a brain page.
- **Auto-posting.** Wiring a draft into a send/publish path skips the human
  gate that makes ghostwriting safe.
- **Building a fingerprint from third-party writing ABOUT the person.**
  Corpus is first-party only.
- **Skipping consent.** Ghostwriting without recorded authorization is
  impersonation, not assistance.
- **One draft instead of 2-3.** A single option hides the voice-vs-angle
  tradeoff from the user.

## Dedup (sharp boundaries)

- **`voice-note-ingest`** (`skills/voice-note-ingest/SKILL.md`) — ingests the
  user's AUDIO into brain pages with exact phrasing preserved; it captures
  voice-as-content. `draft-in-voice` produces NEW prose in a person's textual
  voice from a profile. The only overlap is the word "voice". A voice memo
  that should become a post routes through voice-note-ingest first (capture),
  then draft-in-voice (rewrite in-register).
- **`reports`** / **`briefing`** (`skills/reports/SKILL.md`,
  `skills/briefing/SKILL.md`) — produce agent-voice summaries of brain
  content. `draft-in-voice` produces person-voice content for a human to
  publish as their own. If nobody's fingerprint is being imitated, it is not
  this skill.
- **Harness-level humanizer-style skills** — remove generic AI tells from any
  text. `draft-in-voice` targets ONE specific person's fingerprint from a
  validated profile; "make this less AI-sounding" without a named subject is
  not this skill.
- **`media-ingest`** (`skills/media-ingest/SKILL.md`) — corpus gathering for
  the builder appendix routes through the normal ingest skills; this skill
  reads the resulting pages, it does not own bulk ingestion.
