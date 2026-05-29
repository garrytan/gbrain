# Idea Capture: Originals, Depth, and Distribution

## Goal

Capture the user's original thinking with exact phrasing, deep context, and cross-links so the originals folder becomes the highest-value content in the brain.

## What the User Gets

Without this: brilliant ideas said in conversation disappear. The agent heard
"the ambition-to-lifespan ratio has never been more broken" and forgot it.

With this: every original observation is captured verbatim, cross-linked to
the people and ideas that shaped it, and rated for publishing potential. Your
intellectual archive grows with every conversation.

## Implementation

```
capture_idea(message_text, source_context):

  // 1. AUTHORSHIP TEST — where does this idea belong?
  if user_generated_the_idea(message_text):
    destination = "brain/originals/{slug}.md"
  elif user_synthesis_of_others(message_text):
    destination = "brain/originals/{slug}.md"  // synthesis IS original
  elif world_concept(message_text):
    destination = "brain/concepts/{slug}.md"
  elif product_or_business_idea(message_text):
    destination = "brain/ideas/{slug}.md"
  elif ghostwritten_by_user(message_text):
    destination = "brain/originals/{slug}.md"  // note ghostwriter in metadata
  elif article_about_user(message_text):
    destination = "brain/media/writings/{slug}.md"

  // 2. CAPTURE WITH EXACT PHRASING — never paraphrase
  page = create_or_update(destination, {
    content: message_text,          // verbatim, not summarized
    source: source_context,         // conversation, meeting, moment
    reasoning_path: influences,     // what led to the insight
    depth_context: emotional_nuance // the WHY behind the WHAT
  })

  // 3. ORIGINALITY RATING (for notable ideas)
  if is_notable(message_text):
    rate_originality(page, populations=[
      "general_population", "tech_industry",
      "intellectual_media", "political_establishment"
    ])

  // 4. CROSS-LINK (mandatory — an original without links is dead)
  link_to_people(page, mentioned_people)
  link_to_companies(page, mentioned_companies)
  link_to_meetings(page, source_meeting)
  link_to_media(page, influences)
  link_to_other_originals(page, related_ideas)
  link_to_concepts(page, referenced_concepts)

  // 5. SYNC
  cortex sync --no-pull --no-embed
```

### The Authorship Test

| Signal | Destination |
|--------|-------------|
| User generated the idea | `brain/originals/{slug}.md` |
| User's unique synthesis of others' ideas | `brain/originals/` (the synthesis is original) |
| World concept someone else coined | `brain/concepts/{slug}.md` |
| Product or business idea | `brain/ideas/{slug}.md` |
| User's ghostwritten book/essay | `brain/originals/` (note ghostwriter in metadata) |
| Article ABOUT user | `brain/media/writings/` |

### Capture Standards

**Use the user's EXACT phrasing.** The language IS the insight.

"The ambition-to-lifespan ratio has never been more broken" captures something that
"tension between ambition and mortality" doesn't. Don't clean it up. Don't paraphrase.
The vivid version is the real version.

**What counts as worth capturing:**
- Original observations about how the world works
- Novel connections between disparate things
- Frameworks and mental models
- Pattern recognition moments ("I keep seeing X in every Y")
- Hot takes with reasoning behind them
- Metaphors that reveal new angles
- Emotional/psychological insights about self or others

**What does NOT count:**
- Routine operational messages ("ok", "do it")
- Pure questions without embedded observations
- Echoing back something the agent said
- Acknowledgments and reactions

### The Depth Test

**Could someone unfamiliar with the user read this page and understand not
just WHAT they think but WHY and HOW they got there?**

If the answer is no, it needs more depth. Include:
- The reasoning path (what led to the insight)
- The influences (what they were reading/watching/experiencing)
- The context (conversation, meeting, moment)
- The emotional or psychological nuance

### Originality Distribution Rating

For notable ideas, rate originality 0-100 across different populations:

```markdown
## Originality Distribution

- **General population:** 72/100 — most people haven't encountered this framework
- **Tech industry:** 45/100 — common in startup circles but novel to most
- **Intellectual/media class:** 68/100 — would resonate, not yet articulated
- **Political establishment:** 82/100 — completely foreign to policy thinking

**Publish signal:** Strong essay candidate. Best audience: founders, builders.
```

This tells the user which ideas are worth turning into essays, talks, or videos,
and which audience would find them most novel.

### Deep Cross-Linking Mandate

**An original without cross-links is a dead original.** The connections ARE
the intelligence.

Every original MUST link to:
- **People** who shaped the thinking
- **Companies** where the idea played out
- **Meetings** where it was discussed
- **Books and media** that influenced it
- **Other originals** it connects to (ideas form clusters)
- **Concepts** it builds on or challenges

### Notability Filtering

Before creating any entity page, check notability:

**Create a page for:**
- People you know or discuss with specificity
- Companies you're evaluating, working with, or investing in
- Media you mention with personal reaction
- Anyone you've explicitly engaged with

**Don't create pages for:**
- Generic references or passing examples
- Low-engagement accounts who mentioned you once
- Pure metaphors ("like the Roman Empire...")
- One-off encounters with no follow-up

**Decision:** If notable AND no page exists, create a full page with web
search enrichment. No stubs. If you make a page, make it good.

## Tricky Spots

1. **Synthesis IS original.** When the user connects two existing ideas in a
   new way, that synthesis belongs in `brain/originals/`, not `brain/concepts/`.
   The novel combination is the insight, even if the component ideas aren't new.

2. **Exact phrasing is non-negotiable.** Never paraphrase, summarize, or
   "clean up" the user's language. "The ambition-to-lifespan ratio has never
   been more broken" is the insight. "Tension between ambition and mortality"
   is a corpse. Capture the first version.

3. **Cross-links are mandatory, not optional.** An original without links to
   the people, companies, meetings, and concepts that shaped it is a dead
   original. The connections ARE the intelligence. Check every original for
   at least 2 cross-links before considering it captured.

## How to Verify

1. **Generate an idea and check the page.** Say something original in
   conversation (e.g., "What if markdown files are actually distributed
   software?"). Verify that `brain/originals/{slug}.md` was created with
   your exact phrasing, not a paraphrase.

2. **Check cross-links exist.** Open the newly created original page. It
   should link to at least the people or concepts mentioned. Open those
   linked pages and verify they back-link to the original.

3. **Verify the depth test passes.** Read the captured page as if you were
   a stranger. Can you understand not just WHAT the user thinks but WHY?
   If the reasoning path and context are missing, the capture is incomplete.

---

*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md).*
