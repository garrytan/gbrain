---
name: notion-ingest-delta
version: 2.0.0
description: |
  Notion → gbrain incremental sync. Design only — real implementation lives
  in workers/notion-poller/run.ts (5-min cron) + the /ingest endpoint in
  server/kos-compat-api.ts. This SKILL.md is a redirect; the original design
  rationale moved to the worker's header comment.
mutating: false
---

# notion-ingest-delta — moved

The actual sync code lives at:

- **Worker**: [`workers/notion-poller/run.ts`](../../../workers/notion-poller/run.ts) — 5-min cron, `last_edited_time > cursor` delta, blocks → markdown → POST `/ingest`
- **Endpoint**: [`server/kos-compat-api.ts`](../../../server/kos-compat-api.ts) `/ingest` — accepts `{markdown, title, source:"notion:<id>", notion_id, kind}` payload, skips fetch when markdown is present
- **Cursor / failure modes / config**: [`workers/notion-poller/README.md`](../../../workers/notion-poller/README.md)

The original design contract (two-sync pattern, trigger filter, payload
shape, failure modes) was inlined into the worker's file header on
2026-05-10 (M1). See git history for the pre-shrink SKILL.md if you need
the full design narrative.
