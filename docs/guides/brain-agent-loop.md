# The Brain-Agent Loop

## Goal

Every conversation makes the brain smarter. Every brain lookup makes responses
better. The loop compounds daily.

## What the User Gets

Without this: the agent answers from stale context. You discuss a deal on Monday,
and by Friday the agent has forgotten. Every conversation starts from zero.

With this: six months in, the agent knows more about your world than you can hold
in working memory. It never forgets. It never stops indexing.

## The Loop

```
Signal arrives (message, meeting, email, tweet, link, code question)
  │
  ▼
DETECT entities (people, companies, concepts, systems, original thinking)
  │  → spawn sub-agent (see entity-detection.md)
  │
  ▼
READ: check brain FIRST (before responding)
  │  → mbrain search "{entity name}"
  │  → mbrain search "{system or concept name}"
  │  → mbrain get {slug} (if you know it)
  │  → mbrain query "what do we know about {topic}"
  │
  ▼
RESPOND with brain context (every answer is better with context)
  │
  ▼
WRITE: update brain pages (new info → compiled truth + timeline)
  │  → mbrain put {slug} (update page)
  │  → add_timeline_entry (append to timeline)
  │  → add_link (cross-reference to other entities)
  │
  ▼
SYNC: mbrain indexes changes
  │  → mbrain sync --no-pull --no-embed
  │
  ▼
(next signal arrives — agent is now smarter)
```

## Implementation

### On Every Inbound Message

```
on_message(text):
  // 1. DETECT (async, don't block)
  spawn_entity_detector(text)

  // 2. READ (before composing response)
  entities = extract_entity_names(text)  // quick regex/NER
  context = []
  for name in entities:
    results = mbrain_search(name)
    if results:
      page = mbrain_get(results[0].slug)
      context.append(page.compiled_truth)

  // 3. RESPOND (with brain context injected)
  response = compose_response(text, context)

  // 4. WRITE (after responding, if durable new info emerged)
  if conversation_revealed_durable_knowledge(text, response):
    for entity in mentioned_entities:
      mbrain_add_timeline_entry(entity.slug, {
        date: today,
        summary: "Discussed {topic}",
        source: "[Source: User, conversation, {date}]"
      })

    // 5. SYNC only after a write batch
    mbrain_sync(no_pull=true, no_embed=true)
```

### The Two Invariants

1. **Every READ improves the response.** If you answered a question about a
   person without checking their brain page first, you gave a worse answer
   than you could have. The brain almost always has something. External APIs
   fill gaps, they don't start from scratch.

2. **Every WRITE improves future reads.** If a meeting transcript mentioned
   new information about a company and you didn't update the company page,
   you created a gap that will bite you later.

## Tricky Spots

1. **Read BEFORE responding, not after.** The temptation is to respond first
   and update the brain later. But the brain context makes the response better.
   Read first.

2. **Don't skip real durable writes.** "I'll update the brain later" means
   never. Write immediately after the conversation when new durable knowledge
   actually emerged.

3. **Sync after every write batch.** Without sync, the brain search index is
   stale. The next query won't find what you just wrote. If there was no write,
   there is nothing to sync.

4. **External APIs are fallback, not primary.** `mbrain search` before
   Brave Search. `mbrain get` before Crustdata. The brain has relationship
   history, your own assessments, meeting transcripts, cross-references.
   No external API can provide that.

5. **Technical questions use the same loop.** Before grepping a large repo
   for "where is X implemented?", check the relevant `concepts/` and `systems/`
   pages. A 400-token map often saves 10,000 tokens of blind code reading.

## How to Verify It Works

1. **Mention a person the brain knows.** Ask "what do we know about {name}?"
   The agent should search the brain and return compiled truth, not hallucinate
   or do a web search.

2. **Discuss something new about a known entity.** Say "I heard Acme Corp
   just raised Series B." After the conversation, check: does Acme Corp's
   brain page have a new timeline entry?

3. **Ask about the same person a day later.** The agent should immediately
   pull brain context without you asking. If it doesn't reference the brain
   page, the loop isn't running.

4. **Check the sync.** After a conversation, run `mbrain search "{topic}"`
   from the CLI. The new information should be searchable.

---

*Part of the [MBrain Skillpack](../MBRAIN_SKILLPACK.md). See also: [Entity Detection](entity-detection.md), [Brain-First Lookup](brain-first-lookup.md)*
