# Brain-First Lookup Protocol

## Goal

Check the brain before calling ANY external API or doing broad repo search.
The brain almost always has something. External sources fill gaps, they don't
start from scratch.

## What the User Gets

Without this: the agent calls Brave Search for someone you've had 12 meetings
with, or greps 100K lines of unfamiliar code just to find three files.

With this: the agent pulls compiled truth, recent timeline entries, and
technical maps before doing anything else. External APIs or code search only
fill gaps.

## Implementation

```
lookup(name_or_topic):
  // STEP 1: Probe the governed context surface.
  probe = mbrain retrieve-context "{name_or_topic}"

  // STEP 2: Read canonical evidence selected by the probe.
  if probe.required_reads.length > 0:
    read = mbrain read-context --selectors '<probe.required_reads json>'
    if read.answer_ready:
      return answer_from(read.canonical_reads)

  // STEP 3: If you already know the exact slug/selector, read it directly.
  if exact_selector_known(name_or_topic):
    read = mbrain read-context --selectors '[...]'
    if read.answer_ready:
      return answer_from(read.canonical_reads)

  // STEP 4: Keyword, hybrid, and get_page remain lower-level escape hatches.
  // search/query chunks and candidate_signals are pointers, not answer evidence.
  // Use them to refine a new retrieve_context/read_context pass or disclose that
  // only probe metadata exists.

  // STEP 5: External API or broad repo search (FALLBACK ONLY)
  // Only reach here if canonical brain evidence is absent or insufficient.
  return external_search_or_repo_scan(name_or_topic)
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

For technical work, blind repo search gives you file matches with no structure.
The brain can give you: "this concept lives in these three systems, here are the
entry points, and here is the vocabulary each codebase uses."

## Tricky Spots

1. **Probe first, then read.** `retrieve_context` is cheap discovery and
   planning; `read_context` is the factual evidence boundary. Do not answer
   from search/query chunks or Memory Inbox candidate signals.

2. **Fuzzy slug matching is an escape hatch.** `mbrain get` can still help when
   a user asks for a complete page or when you are debugging selectors, but
   ordinary answers should prefer bounded `read_context` evidence.

3. **Don't skip for "simple" questions.** Even "what's Acme Corp's address?"
   should check the brain first. The brain might have it, and the lookup adds
   no latency (< 100ms for keyword search).

4. **Load compiled truth + recent timeline intentionally.** The compiled truth
   gives you the state of play in 30 seconds. Include timeline only when the
   question needs recency or change history; otherwise keep reads bounded.

5. **Use the same protocol for code questions.** Before searching a repo for
   "autograd" or "dispatcher", check `concepts/` and `systems/` first. The map
   tells you which files to inspect and which vocabulary to search for.

## How to Verify

1. Ask about someone in the brain. Verify the agent called `retrieve_context`
   first, then `read_context` before factual claims.
2. Ask about someone NOT in the brain. Verify the agent probed/read the brain,
   found no canonical evidence, disclosed the gap, THEN fell back to external
   search.
3. Ask the same question twice. Second time should be instant (brain has it).

---

*Part of the [MBrain Skillpack](../MBRAIN_SKILLPACK.md). See also: [Brain-Agent Loop](brain-agent-loop.md), [Search Modes](search-modes.md)*
