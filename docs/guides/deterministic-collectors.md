# Deterministic Collectors: Code for Data, LLMs for Judgment

## Goal

Separate mechanical work (100% reliable code) from analytical work (LLM judgment) so that deterministic tasks never fail probabilistically.

## What the User Gets

Without this: the LLM generates Gmail links, formats tables, and tracks state.
It follows the rule for the first 10 items, then drops a link on item 11. You
write "NO EXCEPTIONS" in the prompt. It still fails. 90% reliability over 20
items means visible failures twice per day. Trust is destroyed.

With this: code handles URLs, formatting, and state (100% reliable). The LLM
reads pre-formatted data and adds judgment, classification, and enrichment.
Links are never wrong because the LLM never generates them.

## Implementation

```
// The pattern: code collects, LLM analyzes

// STEP 1: Deterministic collector (script, no LLM calls)
collector_run():
  messages = gmail_api.fetch_unread()
  for msg in messages:
    structured = {
      id: msg.id,
      from: msg.sender,
      subject: msg.subject,
      snippet: msg.snippet,
      gmail_link: f"https://mail.google.com/mail/u/?authuser={account}#inbox/{msg.id}",
      gmail_markdown: f"[Open in Gmail]({gmail_link})",
      is_signature: regex_match(msg, DOCUSIGN_PATTERNS),
      is_noise: regex_match(msg, NOISE_PATTERNS),
      is_new: msg.id not in state.seen_ids
    }
    store(structured)
    state.seen_ids.add(msg.id)
  generate_markdown_digest(structured_messages)

// STEP 2: LLM reads the pre-formatted digest
llm_analyze():
  digest = read("data/digests/today.md")  // links already baked in
  classify_urgency(digest)                 // judgment call
  add_commentary(digest)                   // contextual analysis
  run_brain_enrichment(notable_entities)   // cortex search + update
  draft_replies(urgent_items)              // creative work
  surface_to_user(final_output)            // delivery

// STEP 3: Wire into cron
cron_job():
  collector_run()     // fast, cheap, deterministic
  llm_analyze()       // slower, expensive, creative
```

### The Architecture

```
+-----------------------------+     +------------------------------+
|  Deterministic Collector    |---->|       LLM Agent              |
|  (Node.js / Python script)  |     |                              |
|                             |     |  - Read the pre-formatted    |
|  - Pull data from API       |     |    digest                    |
|  - Store structured JSON    |     |  - Classify items            |
|  - Generate links/URLs      |     |  - Add commentary            |
|  - Detect patterns (regex)  |     |  - Run brain enrichment      |
|  - Track state (seen/new)   |     |  - Draft replies             |
|  - Output markdown digest   |     |  - Surface to user           |
|                             |     |                              |
|  CODE — deterministic,      |     |  AI — judgment, context,     |
|  never forgets              |     |  creativity                  |
+-----------------------------+     +------------------------------+
```

### File Structure

```
scripts/email-collector/
├── email-collector.mjs     # No LLM calls, no external deps
├── data/
│   ├── state.json          # Last pull timestamp, known IDs, pending signatures
│   ├── messages/           # Structured JSON per day
│   │   └── 2026-04-09.json
│   └── digests/            # Pre-formatted markdown
│       └── 2026-04-09.md
```

### Where the Pattern Applies

| Signal Source | Collector Generates | LLM Adds |
|--------------|-------------------|----------|
| **Email** | Gmail links, sender metadata, signature detection | Urgency classification, enrichment, reply drafts |
| **X/Twitter** | Tweet links, engagement metrics, deletion detection | Sentiment analysis, narrative detection, content ideas |
| **Calendar** | Event links, attendee lists, conflict detection | Prep briefings, meeting context from brain |
| **Slack** | Channel links, thread links, mention detection | Priority classification, action item extraction |
| **GitHub** | PR/issue links, diff stats, CI status | Code review context, priority assessment |

### The Principle

If a piece of output MUST be present and MUST be formatted correctly every
time, generate it in code. If a piece of output requires judgment, context,
or creativity, generate it with the LLM. Don't ask the LLM to do both in
the same pass.

## Tricky Spots

1. **LLMs forget links -- bake them in code.** The LLM will follow the
   "include a Gmail link" rule for the first 10 items, then silently drop
   it on item 11. No amount of prompt engineering fixes probabilistic
   formatting over long outputs. The fix: generate every link in the
   collector script. The LLM reads pre-formatted markdown where links are
   already embedded. It can't forget what it didn't generate.

2. **Noise filtering must be deterministic.** Regex-based noise detection
   (newsletters, automated receipts, marketing) belongs in the collector,
   not the LLM. The LLM might classify a newsletter as "possibly important"
   on one run and "noise" on the next. Code classifies the same input the
   same way every time.

3. **Atomic writes prevent corruption.** The collector writes to a state
   file (`state.json`) that tracks which messages have been seen. If the
   script crashes mid-write, the state file can be corrupted. Write to a
   temp file first, then rename atomically. This also prevents the LLM
   from reading a partial digest if the cron fires during a collection run.

## How to Verify

1. **Run the collector and check every link.** Execute the collector script
   manually. Open the generated digest. Click every `[Open in Gmail]` link
   (or equivalent). Every single link must resolve to the correct item. If
   any link is broken or missing, the collector has a bug.

2. **Verify noise filtering is consistent.** Run the collector twice on the
   same input data. The noise classification (is_noise field) must be
   identical both times. If it varies, a probabilistic element leaked into
   the deterministic layer.

3. **Verify the LLM reads structured output.** Run the full pipeline
   (collector then LLM). Check that the LLM's analysis references data
   from the structured digest, not from its own generation. The links in
   the final output should be identical to the links in the digest file.

---

*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md).*
