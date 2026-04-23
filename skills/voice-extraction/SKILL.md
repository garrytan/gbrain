---
name: voice-extraction
version: 1.0.0
description: |
  Analyze outbound emails in the brain to extract the user's writing voice.
  Produces a voice-profile brain page with patterns, recipient-type variations,
  real example quotes, and a drafting checklist. Requires email data in the brain
  (50+ outbound emails minimum). Re-runnable to refine as more data arrives.
triggers:
  - "extract my voice"
  - "analyze my writing"
  - "build voice profile"
  - "how do I write"
  - "create voice profile"
  - "update voice profile"
tools:
  - search
  - query
  - get_page
  - put_page
mutating: true
---

# Voice Extraction — Writing Voice Profile from Email Corpus

Mine the user's outbound emails to produce a structured writing voice profile.
Agents use this to draft emails that sound like the user — not generic AI.

## Contract

This skill guarantees:
- Voice profile is derived exclusively from the user's actual sent emails in the brain
- Every pattern claim is backed by ≥2 real examples from the corpus
- Characteristic phrases are direct quotes, never paraphrases
- "Never does" claims are verified by absence across 50+ emails
- Recipient-type variations include real quoted examples
- Output includes a drafting checklist for consuming agents
- Privacy: quotes are selected for stylistic value, not sensitive content.
  No dollar amounts, private addresses, or non-public names in examples.

## Prerequisites

- Brain contains outbound emails with `from_email` in page frontmatter
- At least 50 outbound emails from the user's known email address(es)
- If insufficient data, the skill warns and produces a partial profile

The primary data source is the `email-to-brain` recipe, but any pages with
`from_email` matching the user's address work. No hard dependency on a specific
ingestion method.

## Protocol

### Phase 1: Discover and Sample

**Goal:** Collect 50–100 diverse outbound email samples across contexts.

1. **Identify the user's email addresses.** Check USER.md or ask:
   "What email addresses do you send from? (e.g., work and personal)"

2. **Search for outbound emails.** For each address:
   ```
   gbrain search "{email_address}"
   ```
   Filter results to pages where `from_email` matches the user's address.
   These are the user's sent emails.

3. **Sample for breadth.** Collect emails across these categories:
   - Professional/work colleagues
   - Vendors / service providers
   - External contacts (investors, partners, institutions)
   - Personal / family
   - Quick replies (1–2 sentences)
   - Substantive emails (3+ paragraphs)
   - Difficult messages (declining, pushing back, negotiating, delivering bad news)
   - Grateful / appreciative messages
   - Scheduling / logistics

   Aim for 8–12 emails per category. Prefer diversity of recipients over
   depth with one recipient.

4. **Read full bodies.** For each sample:
   ```
   gbrain get {slug}
   ```
   Extract the user's authored text only (strip quoted replies, signatures,
   forwarded content).

**Output:** A working set of 50–100 authored email texts, categorized by context.

### Phase 2: Extract Universal Patterns

**Goal:** Identify patterns that hold across all contexts.

Analyze the sample set for:

| Dimension | What to look for |
|-----------|-----------------|
| **Openings** | Greeting style by context. When greetings are skipped entirely. First-email vs. reply differences. |
| **Closings** | Sign-off variants and when each is used. When sign-offs are skipped. |
| **Structure** | Typical paragraph count and length. How multi-topic emails are organized (bullets? line breaks? headers?). |
| **Length** | Distribution: what % are 1-liners, 2-3 sentences, 1 paragraph, multi-paragraph? |
| **Punctuation** | Em-dash usage, ellipses, exclamation points (frequency and context), comma patterns. |
| **Reply style** | Top-posting vs. inline? Quoting previous messages or not? |
| **Formality** | Contractions? Sentence fragments? Typos left in or polished? |
| **Emoji** | Used? In which contexts? |

For each pattern, collect the specific evidence:
- ✅ "Opens with 'Hey [Name],' in 23/30 casual emails"
- ❌ "Generally uses a casual opening" (too vague, no evidence)

### Phase 3: Profile Recipient-Type Variations

**Goal:** Document how the voice shifts by audience.

1. **Infer recipient types** from the sample set. Common buckets:
   - Work colleagues (shared context, efficient)
   - Vendors / service providers (respectful, clear instructions)
   - External professional (slightly more formal)
   - Institutional / formal (schools, government, legal)
   - Personal / family (warmest)

   Don't force categories — let them emerge from the data. If the user only
   emails in 2–3 distinct registers, document 2–3 types.

2. **For each type, document:**
   - Tone delta from baseline (warmer? more formal? terser?)
   - Opening/closing pattern if different from universal
   - Typical length
   - 3–5 real quoted examples that capture the register
   - "Common moves" — recurring patterns for that audience
     (e.g., "acknowledges vendor constraints before making requests")

3. **Select quotes for privacy safety.** Prefer examples that show style
   without leaking sensitive substance:
   - ✅ "Totally understood, can we talk about it on Monday so I can better
     understand which parts are more time consuming."
   - ❌ "The $22.5M offer on 91 Mandarin needs to close by Friday."

   If a quote demonstrates an important pattern but contains sensitive details,
   redact the specifics: replace dollar amounts with [amount], addresses with
   [property], names with [name] — but only when necessary. Unredacted quotes
   that happen to be innocuous are always better.

### Phase 4: Generate Voice Profile

**Goal:** Produce the brain page.

Assemble findings into a structured page with these sections:

```markdown
# Voice Profile

## Core Voice
One paragraph capturing the overall quality of the user's writing.
Not adjective soup — a specific, testable description.

## Universal Patterns
### Openings
### Closings
### Structure
### Punctuation & Style

## Recipient-Type Variations
### [Type 1]
### [Type 2]
...

## Common Moves
| Situation | Pattern |
|-----------|---------|
| Making a decision | ... |
| Pushing back | ... |
| Expressing gratitude | ... |
...

## Never Does
Verified absences across the corpus.

## Drafting Checklist
Numbered checklist a consuming agent runs before presenting a draft.
```

Write to brain:
```
gbrain put voice-profile < voice-profile.md
```

### Quality Gate (before writing)

Run these checks against the draft profile:

1. **Evidence test:** Every claim in "Universal Patterns" is backed by a count
   ("in N of M emails") or ≥2 quoted examples.
2. **Quote authenticity:** Every entry in "Characteristic phrases" or example
   quotes is a verbatim string from a real email, not a paraphrase.
3. **Absence test:** Every "Never does" item was checked against ≥50 emails.
   Don't list things that are generically uncommon — list things that a generic
   AI would do but this user specifically does not.
4. **Privacy test:** No quotes contain dollar amounts, private addresses,
   private phone numbers, health information, or non-public personal names
   unless the user explicitly approves.
5. **Usefulness test:** Could another agent read this profile and draft an email
   that a close colleague would believe came from the user? If not, the profile
   is too vague.

## Re-running

The skill is idempotent. Running again with more email data refines the profile.

Options for targeted re-runs:
- "Analyze my voice when emailing vendors" — scope to one recipient type
- "Update voice profile with recent emails" — re-sample with `newer_than:30d` bias
- "I write differently now" — full re-run, comparing old vs. new patterns

When re-running, read the existing `voice-profile` page first to preserve
validated patterns and only update what new data contradicts or enriches.

## What This Skill Does NOT Do

- **Draft emails.** This skill produces the profile. A separate skill or
  workflow consumes it for drafting. Separation keeps the profile reusable
  across drafting contexts (email, Slack, messages).
- **Analyze non-email writing.** V1 focuses on email. Slack messages, documents,
  and other formats have different voice registers and should be handled by
  future extensions.
- **Learn continuously.** The skill runs on-demand. An agent could schedule
  monthly re-runs, but the skill itself is stateless between invocations.

## Example Output

A well-formed voice profile for a hypothetical user:

```markdown
# Voice Profile

## Core Voice
Writes like someone who values other people's time as much as their own.
Emails are short, direct, and warm without being performative. Gets to the
point in the first sentence, provides just enough context, and closes cleanly.

## Universal Patterns

### Openings
- Most common: dives straight in with no greeting on quick replies
- First email or new topic: "Hi [Name]," or "Hey [Name],"
- Never opens with: "I hope this finds you well"

### Closings
- Default: "Best, [Name]"
- After asking for something: "Thanks, [Name]" or just "Thank you!"
- Quick reply: often no sign-off at all

### Structure
- One-liner replies are common and normal
- Multi-topic emails use line breaks or simple bullets, not bold headers
- Paragraphs rarely exceed 3 sentences

### Punctuation & Style
- Em-dashes used naturally for asides
- Occasional sentence fragments: "Totally understood."
- Exclamation points rare but genuine, used for real gratitude

## Recipient-Type Variations

### Vendors / Service Providers
Respectful, direct, treats them as competent professionals.
Shares personal context when it helps them do their job.

Examples:
> "That's a lot more time than I'd realized, can we talk about it
> on Monday so I can better understand which parts are more time consuming."

> "I've decided to postpone [project] for now — there's been a lot going on
> and I want to get through the current projects first."

### Institutional / Formal
More carefully composed. Leads with gratitude, then the decision, then reasoning.

Examples:
> "I wanted to thank you again for taking the time to meet me."
> "We really hope to be considered for next year, as we remain excited
> about everything you and the team have achieved there."

## Common Moves
| Situation | Pattern |
|-----------|---------|
| Making a decision | States it clearly upfront: "Ok we decided to..." |
| Pushing back | Frames as wanting to understand: "That's a lot more than I'd realized, can we talk..." |
| Expressing gratitude | Specific: "You've been fantastic in helping us navigate..." |

## Never Does
- "I hope this finds you well"
- "Just circling back"
- "Please don't hesitate to reach out"
- "Cheers" or "Regards" sign-offs
- Headers with bold/underline in emails
- Emoji in email

## Drafting Checklist
1. Would the user actually write this many words? Compress if over 3 short paragraphs.
2. Does the first sentence get to the point?
3. Any phrase the user would never say? Check "Never Does."
4. Does the sign-off match the context?
5. Read it as a chat message. If it sounds too formal, it's too formal for this user.
```
