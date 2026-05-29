# Brain-First Lookup Protocol

## Goal

Check the brain before calling ANY external API. The brain almost always has
something. External APIs fill gaps, they don't start from scratch.

## What the User Gets

Without this: the agent calls Brave Search for someone you've had 12 meetings with.
You get a LinkedIn summary instead of your relationship history.

With this: the agent pulls your compiled truth, recent timeline entries, and
shared context before doing anything else. External APIs only fill gaps.

## Implementation

```
lookup(name_or_topic):
  // STEP 1: Keyword search (fast, works day one, no embeddings needed)
  results = cortex search "{name_or_topic}"
  if results.length > 0:
    page = cortex get {results[0].slug}
    return page  // done, brain had it

  // STEP 2: Hybrid search (needs embeddings, finds semantic matches)
  results = cortex query "what do we know about {name_or_topic}"
  if results.length > 0:
    page = cortex get {results[0].slug}
    return page

  // STEP 3: Direct slug (if you know or can guess the slug)
  page = cortex get "people/{slugify(name_or_topic)}"
  if page: return page

  // STEP 4: External API (FALLBACK ONLY)
  // Only reach here if brain has nothing
  return external_search(name_or_topic)
```

**This is mandatory.** An agent that calls Brave Search before checking the brain
is wasting money and giving worse answers.

## Why Brain First

The brain has context no external API can provide:
- Relationship history (how you know them, what you discussed)
- Your own assessments (what you think of them, not their LinkedIn bio)
- Meeting transcripts (what was said, what was decided)
- Cross-references (who they know, what companies they're connected to)
- Timeline (what changed recently, what's trending)

A LinkedIn scrape gives you their job title. The brain gives you: "co-founded
Brex, you had coffee with him 3 times, last discussed the payments infrastructure
thesis, he's interested in your take on AI agents."

## Tricky Spots

1. **Try keyword first, then hybrid.** Keyword search works without embeddings
   (day one). Hybrid search needs embeddings but finds semantic matches. Try
   both in sequence.

2. **Fuzzy slug matching.** `cortex get` supports fuzzy matching. If the exact
   slug doesn't exist, it suggests alternatives. Use this for name variants
   ("Pedro" → "pedro-franceschi").

3. **Don't skip for "simple" questions.** Even "what's Acme Corp's address?"
   should check the brain first. The brain might have it, and the lookup adds
   no latency (< 100ms for keyword search).

4. **Load compiled truth + recent timeline.** The compiled truth gives you the
   state of play in 30 seconds. The timeline gives you what changed recently.
   Both together = full context.

## How to Verify

1. Ask about someone in the brain. Verify the agent searched the brain FIRST
   (check tool call order in the response).
2. Ask about someone NOT in the brain. Verify the agent searched the brain,
   found nothing, THEN fell back to external search.
3. Ask the same question twice. Second time should be instant (brain has it).

---

*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md). See also: [Brain-Agent Loop](brain-agent-loop.md), [Search Modes](search-modes.md)*
