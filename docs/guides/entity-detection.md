# Entity Detection: Opt-in Conversation Capture

## Goal

After the user opts in, scan substantive messages for original thinking and
entity mentions within their chosen scope. Capture is off by default; ordinary
recall and explicit remembering work without it. A chat-only request suppresses
capture for that message. Paid enrichment and delegation need separate authority.

## What the User Gets

Without this: the agent answers questions but forgets everything. You mention
Alice in a meeting, and next week the agent doesn't know who Alice is.

With this: every person, company, and idea mentioned in conversation gets a
brain page. Next time Alice comes up, the agent already has context. The
brain compounds.

## Implementation

Check the stored capture choice before every pass. With an opt-in and authorized
delegation, a lightweight sub-agent can run in parallel. Otherwise, perform
authorized capture inline or skip it; never assume native background routing.

This pattern is harness-side by design, but gbrain ships help on both ends:
the `signal-detector` skill (`skills/signal-detector/`) is the bundled
version of this detection loop, and `gbrain extract` runs gbrain's own
extraction machinery (entities, facts) over already-synced content.

```
on_every_message(message_text, source_context):

  if not explicit_capture_opt_in or chat_only(message_text):
    return

  // 1. SPAWN ASYNC — don't block the response
  spawn_subagent({
    model: configured_model,   // requires authorized delegation/spending
    timeout: 120,              // seconds
    task: build_detection_prompt(message_text, source_context)
  })

  // 2. RESPOND TO USER NORMALLY
  // The sub-agent runs in the background
```

### The Detection Prompt

```
build_detection_prompt(text, source):
  return `
SIGNAL DETECTION — scan this message for ideas AND entities:

Message: "${text}"
Source: [Source: User, ${source.topic}, ${source.platform}, ${source.timestamp}]

STEP 1 — IDEAS FIRST (highest priority):
Is the user expressing an original thought, observation, thesis, or framework?

If yes:
  - Create or update brain/originals/{slug}.md
  - Use the user's EXACT phrasing (the language IS the insight)
  - "The ambition-to-lifespan ratio has never been more broken" is better
    than "tension between ambition and mortality"
  - Include [Source: ...] citation with full context

If the idea references a world concept: brain/concepts/{slug}.md
If it's a product/business idea: brain/ideas/{slug}.md

STEP 2 — ENTITIES:
Extract all person names, company names, media titles.

For each entity:
  a. Run: gbrain search "{name}"
  b. If page exists AND new info: append timeline entry
     Format: - YYYY-MM-DD | {what happened} [Source: {who}, {context}, {date}]
  c. If no page AND entity is notable: save supplied facts with provenance
  d. Enrich further only when that capability and spending are authorized

STEP 3 — BACK-LINKING (mandatory):
For every entity mentioned, add a back-link FROM their page TO this source.
An unlinked mention is a broken brain.
Format: - **YYYY-MM-DD** | Referenced in [{page title}]({path}) — {context}

STEP 4 — SYNC:
Run: gbrain sync --no-pull --no-embed

If nothing to capture, reply "No signals detected" and exit.
`
```

### Notability Filtering

Before creating a new entity page, check notability:

```
is_notable(entity):
  // CREATE a page for:
  - People the user knows or discusses with specificity
  - Companies the user is evaluating, working with, or investing in
  - Media the user mentions with personal reaction
  - Anyone the user has explicitly engaged with

  // DON'T create a page for:
  - Generic references or passing examples
  - Low-engagement accounts who mentioned the user once
  - Pure metaphors ("like the Roman Empire...")
  - One-off encounters with no follow-up

  // If notable AND no page: create FULL page (not a stub)
  // If not notable: skip silently
```

### What Counts as Original Thinking

| Capture | Don't Capture |
|---------|---------------|
| Original observations about how the world works | "ok", "do it", "sure" |
| Novel connections between disparate things | Pure questions without observations |
| Frameworks and mental models | Echoing back what the agent said |
| Pattern recognition ("I keep seeing X in every Y") | Acknowledgments and reactions |
| Hot takes with reasoning | Routine operational messages |
| Metaphors that reveal new angles | Requests without embedded insight |
| Emotional/psychological insights about self or others | |

### Filing Rules

| Signal | Destination |
|--------|-------------|
| User generated the idea | `brain/originals/{slug}.md` |
| User's synthesis of others' ideas | `brain/originals/` (the synthesis is original) |
| User's ghostwritten book/essay | `brain/originals/` (note ghostwriter in metadata) |
| World concept someone else coined | `brain/concepts/{slug}.md` |
| Product or business idea | `brain/ideas/{slug}.md` |
| Person mentioned | `brain/people/{slug}.md` |
| Company mentioned | `brain/companies/{slug}.md` |
| Media referenced | `brain/media/{type}/{slug}.md` |
| Article ABOUT the user | `brain/media/writings/{slug}.md` |

This table is the single home for the capture/filing taxonomy. Other guides
([idea-capture](idea-capture.md) especially) link here rather than carrying
their own copy.

### The Iron Law of Back-Linking

Every entity mention MUST create a back-link FROM the entity page TO the
source. This is not optional.

```
// When message mentions "Alice" and creates a meeting page:

// 1. Update the meeting page (normal)
brain/meetings/2026-04-10-board-sync.md:
  - Alice presented Q1 numbers

// 2. ALSO update Alice's page (back-link)
brain/people/alice-example.md:
  ## Timeline
  - **2026-04-10** | Presented Q1 numbers at board sync
    [Source: User, board meeting, 2026-04-10]
```

Without back-links, you can't traverse the graph. "Show me everything related
to Alice" only works if Alice's page links back to every mention.

## Tricky Spots

1. **Don't block the conversation.** Entity detection runs async. The user
   should see a response immediately, not wait 2 minutes while the sub-agent
   enriches 5 entity pages.

2. **Capture and paid enrichment are separate.** Use the user's configured
   model and budget only when authorized. Do not add provider calls just because
   capture is on.

3. **Exact phrasing matters.** "Markdown is actually code" is an insight.
   "Markdown can be used as code" is a summary. Capture the first version.

4. **Preserve uncertainty.** Save supported facts with provenance. Do not
   invent details to fill a thin page or perform unrequested web enrichment.

5. **Dedup before creating.** Always `gbrain search` before creating a page.
   Variant spellings, nicknames, and company abbreviations cause duplicates.
   "Alice Example" and "Alice" might be the same person.

## How to Verify

First leave capture off and send a substantive message: verify no write occurs.
Then explicitly enable capture for the following harmless fixtures. A generated
skill file alone does not prove the harness runs this loop.

1. **Send a message mentioning a person.** Say "I had coffee with alice-example
   from acme-example today." Verify: brain/people/alice-example.md was created or
   updated, brain/companies/acme-example.md was created or updated, both have
   timeline entries with today's date.

2. **Send a message with an original idea.** Say "What if we could distribute
   software as markdown files that agents execute?" Verify:
   brain/originals/{slug}.md was created with your exact phrasing.

3. **Check back-links.** Open alice-example's page. It should have a timeline
   entry linking back to today's conversation. Check acme-example's page too.

4. **Send a boring message.** Say "ok sounds good." Verify: nothing was
   created. The detector should report "No signals detected."

5. **Check for duplicates.** Mention "Alice" then later "Alice Example."
   Verify: one page, not two.

6. **Exercise consent boundaries.** A chat-only message creates no memory.
   Turning capture off stops subsequent automatic writes; an explicit request
   to remember one fact still works without re-enabling capture.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
