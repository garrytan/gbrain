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
Signal arrives (message, meeting, email, tweet, link)
  │
  ▼
DETECT entities (people, companies, concepts, original thinking)
  │  → spawn sub-agent (see entity-detection.md)
  │
  ▼
READ: check brain FIRST (before responding)
  │  → gbrain search "{entity name}"
  │  → gbrain get {slug} (if you know it)
  │  → gbrain query "what do we know about {topic}"
  │
  ▼
RESPOND with brain context (every answer is better with context)
  │
  ▼
WRITE: update brain pages (new info → compiled truth + timeline)
  │  → gbrain put {slug} (update page)
  │  → add_timeline_entry (append to timeline)
  │  → add_link / `gbrain link … --link-type <T>` (T must be a taxonomy RELATIONSHIP label)
  │
  ▼
SYNC: gbrain indexes changes
  │  → gbrain sync --no-pull --no-embed
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
    results = gbrain_search(name)
    if results:
      page = gbrain_get(results[0].slug)
      context.append(page.compiled_truth)

  // 3. RESPOND (with brain context injected)
  response = compose_response(text, context)

  // 4. WRITE (after responding, if new info emerged)
  if response_contains_new_info(response):
    for entity in mentioned_entities:
      gbrain_add_timeline_entry(entity.slug, {
        date: today,
        summary: "Discussed {topic}",
        source: "[Source: User, conversation, {date}]"
      })

  // 5. SYNC
  gbrain_sync()
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

2. **Don't skip the write step.** "I'll update the brain later" means never.
   Write immediately after the conversation, while the context is fresh.

3. **Sync after every write batch.** Without sync, the brain search index is
   stale. The next query won't find what you just wrote.

4. **External APIs are fallback, not primary.** `gbrain search` before
   Brave Search. `gbrain get` before Crustdata. The brain has relationship
   history, your own assessments, meeting transcripts, cross-references.
   No external API can provide that.

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

4. **Check the sync.** After a conversation, run `gbrain search "{topic}"`
   from the CLI. The new information should be searchable.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md). See also: [Entity Detection](entity-detection.md), [Brain-First Lookup](brain-first-lookup.md)*
