---
name: notion-ingest-delta
version: 3.0.0
description: |
  RETIRED 2026-05-17. The Notion → gbrain delta poller produced 0 net pages
  for at least 24 h (10.4 MB of "0 ingested (empty)" logs); brain has 0 pages
  with source_of_truth=notion and 0 pages tagged notion-ingest. Worker moved
  to workers/_archived/notion-poller/. Replacement: mailagent v4 SQLite SSoT
  push to kos-compat-api/ingest directly (方案 B), tracked in GitHub issue
  on ChenyqThu/jarvis-knowledge-os-v2. Story in §6.27.
mutating: false
---

# notion-ingest-delta — RETIRED 2026-05-17

The Notion → brain delta-poll path is dead code. See:

- **Archived worker**: [`workers/_archived/notion-poller/run.ts`](../../../workers/_archived/notion-poller/run.ts)
- **Endpoint still alive**: [`server/kos-compat-api.ts`](../../../server/kos-compat-api.ts) `/ingest` — still accepts `{markdown, title, source, kind}` for any pusher; this is the entry mailagent push (方案 B) will use
- **Retire story**: [`docs/JARVIS-ARCHITECTURE.md`](../../../docs/JARVIS-ARCHITECTURE.md) §6.27 — production evidence (24+ h × 0 ingest) + replacement design

Original design contract preserved in git history at the v2 SKILL.md and
in `workers/_archived/notion-poller/run.ts` header comment.
