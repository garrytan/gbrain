# Entity Detection: Scan Every Message, Write Only Durable Signals

## Goal

Every inbound message gets scanned for original thinking AND entity mentions so durable signals are captured automatically without turning every mention into a write.

## What the User Gets

Without this: the agent answers questions but forgets everything. You mention
Pedro in a meeting, and next week the agent doesn't know who Pedro is.

With this: notable people, companies, and ideas mentioned with durable context
get recorded. Next time Pedro comes up, the agent already has context. The
brain compounds without filling up with transient task mechanics.

## Implementation

Spawn a lightweight sub-agent on EVERY inbound message. Do NOT wait for it
to finish before responding. It runs in parallel.

```
on_every_message(message_text, source_context):

  // 1. SPAWN ASYNC — don't block the response
  spawn_subagent({
    model: "sonnet-class",     // cheap + fast, not opus
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
Extract all person names, company names, media titles, technical systems,
and reusable technical concepts.

For each entity:
  a. Run: mbrain search "{name}"
  b. If page exists AND new info: append timeline entry
     Format: - YYYY-MM-DD | {what happened} [Source: {who}, {context}, {date}]
  c. If no page AND entity is notable: create page with web enrichment
  d. If page is thin (< 5 lines compiled truth): spawn background enrichment

STEP 3 — BACK-LINKING (mandatory):
For every entity mentioned, add a back-link FROM their page TO this source.
An unlinked mention is a broken brain.
Format: - **YYYY-MM-DD** | Referenced in [{page title}]({path}) — {context}

STEP 4 — SYNC:
If any page was created or updated, run: mbrain sync --no-pull --no-embed

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

### Filing Rules

| Signal | Destination |
|--------|-------------|
| User generated the idea | `brain/originals/{slug}.md` |
| User's synthesis of others' ideas | `brain/originals/` (the synthesis is original) |
| World concept someone else coined | `brain/concepts/{slug}.md` |
| Technical concept or mechanism | `brain/concepts/{slug}.md` |
| Product or business idea | `brain/ideas/{slug}.md` |
| Person mentioned | `brain/people/{slug}.md` |
| Company mentioned | `brain/companies/{slug}.md` |
| Repo / codebase / subsystem mentioned | `brain/systems/{slug}.md` |
| Media referenced | `brain/media/{type}/{slug}.md` |

### The Iron Law of Back-Linking

Every entity mention MUST create a back-link FROM the entity page TO the
source. This is not optional.

```
// When message mentions "Pedro" and creates a meeting page:

// 1. Update the meeting page (normal)
brain/meetings/2026-04-10-board-sync.md:
  - Pedro presented Q1 numbers

// 2. ALSO update Pedro's page (back-link)
brain/people/pedro-franceschi.md:
  ## Timeline
  - **2026-04-10** | Presented Q1 numbers at board sync
    [Source: User, board meeting, 2026-04-10]
```

Without back-links, you can't traverse the graph. "Show me everything related
to Pedro" only works if Pedro's page links back to every mention.

## Tricky Spots

1. **Don't block the conversation.** Entity detection runs async. The user
   should see a response immediately, not wait 2 minutes while the sub-agent
   enriches 5 entity pages.

2. **Sonnet, not Opus.** Entity detection is pattern matching, not deep
   reasoning. Sonnet is 5-10x cheaper and fast enough. Use Opus for the
   main conversation.

3. **Exact phrasing matters.** "Markdown is actually code" is an insight.
   "Markdown can be used as code" is a summary. Capture the first version.

4. **Don't create stubs.** If you create a page, make it good. Run a web
   search, build out the compiled truth, add context. A stub page with just
   a name is worse than no page (it gives false confidence).

5. **Dedup before creating.** Always `mbrain search` before creating a page.
   Variant spellings, nicknames, and company abbreviations cause duplicates.
   "Pedro Franceschi" and "Pedro" might be the same person.

6. **Technical detection uses the same compounding loop.** If the user asks
   "where is operator fusion implemented?" or compares two systems, treat that
   like an entity signal. Search for existing `concepts/` and `systems/` pages,
   then update them with codemap pointers when the exploration reveals reusable
   structure.

## How to Verify

1. **Send a message mentioning a person.** Say "I had coffee with Sarah Chen
   from Acme Corp today." Verify: brain/people/sarah-chen.md was created or
   updated, brain/companies/acme-corp.md was created or updated, both have
   timeline entries with today's date.

2. **Send a message with an original idea.** Say "What if we could distribute
   software as markdown files that agents execute?" Verify:
   brain/originals/{slug}.md was created with your exact phrasing.

3. **Check back-links.** Open Sarah Chen's page. It should have a timeline
   entry linking back to today's conversation. Open Acme Corp's page. Same.

4. **Send a boring message.** Say "ok sounds good." Verify: nothing was
   created. The detector should report "No signals detected."

5. **Check for duplicates.** Mention "Pedro" then later "Pedro Franceschi."
   Verify: one page, not two.

---

*Part of the [MBrain Skillpack](../MBRAIN_SKILLPACK.md).*
