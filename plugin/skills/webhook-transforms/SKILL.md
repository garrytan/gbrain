---
name: webhook-transforms
version: 1.0.0
description: |
  Generic framework for converting external events (SMS, meetings, social mentions)
  into brain-ingestible signals. Define a transform function, register a webhook URL,
  and incoming events get processed through the brain pipeline.
triggers:
  - "set up webhook"
  - "process webhook event"
  - "transform this event"
tools:
  - put_page
  - add_timeline_entry
  - search
mutating: true
---

# Webhook Transforms

## Contract

This skill guarantees:
- External events are transformed into brain pages with proper citations
- Raw payloads are preserved (dead-letter queue if transform fails)
- Entity extraction runs on every transformed event
- Input sanitization: no raw HTML/script passes to brain pages
- Error handling: transform failure logs raw payload, retries once

## Phases

1. **Define transform.** Map event schema to brain page format:
   - Input: raw webhook payload (JSON)
   - Output: brain page content (markdown) + metadata (slug, type, citations)
   - Must sanitize: strip HTML tags, escape script content

2. **Register webhook URL.** Provide the external service with the webhook endpoint.

3. **On event received:**
   - Parse payload
   - Run transform function
   - Write brain page via `gbrain put`
   - Extract entities, run enrichment
   - Add timeline entries to mentioned entities
   - Sync: `gbrain sync`

4. **Error handling:**
   - If transform throws: log raw payload to `_dead-letter/{timestamp}.md`
   - Surface error type to agent
   - Retry once
   - Don't lose events

## Example Transforms

### SMS Received
```
Input: {from: "+1555...", body: "Meeting moved to 3pm", timestamp: "..."}
Output: Timeline entry on sender's brain page + task update if action item detected
```

### Meeting Completed
```
Input: {title: "Weekly sync", attendees: [...], transcript: "...", summary: "..."}
Output: Delegate to meeting-ingestion skill
```

### Social Mention
```
Input: {platform: "twitter", author: "@handle", text: "...", url: "..."}
Output: Brain page in media/ + entity extraction + backlinks
```

## Output Format

Event transformed and written to brain. Report: "Webhook: {event_type} from {source}
→ {brain_page_path}"

## Anti-Patterns

- Passing raw HTML/script to brain pages (XSS risk)
- Silently dropping events when transform fails (use dead-letter queue)
- Processing webhooks without entity extraction
- Not sanitizing external input before brain writes
