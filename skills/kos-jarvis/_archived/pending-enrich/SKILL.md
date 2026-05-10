---
name: pending-enrich
version: 1.0.0
description: |
  Queue schema for entity-mention signals that need later enrichment.
  Producer: OpenClaw Feishu signal-detector fork (external). Consumer:
  skills/kos-jarvis/enrich-sweep/run.ts. This file pins the on-disk format
  so both sides stay honest without shared code.
triggers:
  - "pending enrich"
  - "enrich queue"
tools: []
mutating: false
---

# pending-enrich queue

Bridge between Phase 2 (Feishu ambient signal capture) and Phase 3
(batch enrich-sweep). See `docs/JARVIS-NEXT-STEPS.md` §4-§5 for the
phase context.

## File

**Path**: `~/brain/agent/pending-enrich.jsonl`
(override via `PENDING_ENRICH_PATH` env var)

**Format**: JSONL. One self-contained JSON object per line, newline-terminated.
Never pretty-printed. Never rewritten — only appended to by producers,
only rotated (move + truncate) by the consumer after a successful sweep.

## Line schema

```json
{
  "ts": "2026-04-17T10:32:14Z",
  "name": "alice-example",
  "kind": "person",
  "context": "VC who invested in widget-co seed; mentioned by you on Feishu",
  "source": "feishu:oc_abc123#msg_456",
  "confidence": 0.7
}
```

### Required fields

- `ts` — ISO 8601 UTC timestamp of the mention
- `name` — entity name as spoken / written; **do not slugify here**,
  dedup happens in enrich-sweep
- `kind` — one of `person | company | concept | project`. If unknown,
  emit `person` and let enrich-sweep reclassify
- `context` — 40-300 chars of surrounding text. This becomes the first
  line of the stub's State section if the entity gets promoted
- `source` — opaque origin string. Convention:
  - `feishu:<chat_id>#<message_id>` for Feishu bridge
  - `manual:<anything>` for human-appended lines
  - `openclaw:<skill-name>` for other OpenClaw skills

### Optional fields

- `confidence` — producer's self-reported 0-1 float. enrich-sweep
  ignores <0.5 unless mention recurs
- `aliases` — array of alternate strings observed alongside `name`
- `url` — canonical link if the mention came with one (tweet, article)

## Producer responsibilities (OpenClaw side)

1. **Append-only**. Never read-modify-write. Open with `O_APPEND`
   semantics (`appendFileSync` in Node) to avoid races.
2. **One message → zero-or-more lines**. Multiple entities in a single
   Feishu message each emit their own line.
3. **Skip trivia**. Don't emit for: common first names alone ("John"),
   generic role titles ("the CEO"), personal pronouns.
4. **Best-effort timestamp**. If the message timestamp is unavailable,
   use `new Date().toISOString()`.
5. **Size discipline**. If the file exceeds 10 MB, stop producing and
   alert — consumer is probably broken.

## Consumer responsibilities (enrich-sweep side)

1. **Rotate, don't truncate in place.** At sweep start:
   ```
   mv ~/brain/agent/pending-enrich.jsonl \
      ~/brain/agent/pending-enrich.processing.<ts>.jsonl
   ```
   Process the rotated file. If the sweep crashes, the next run
   inherits the `.processing.*` file (and may find another fresh one).
2. **Merge with in-brain scan.** Queue entries are hints, not
   truth — enrich-sweep dedupes against (a) existing brain pages and
   (b) entities already extracted from the 86-page corpus via Haiku NER.
3. **Archive after success.** Move `.processing.<ts>.jsonl` to
   `~/brain/agent/pending-enrich-archive/` after a clean run.
4. **Never edit a live queue file.** Producers are racy by design.

## Example lines

```jsonl
{"ts":"2026-04-17T09:12:03Z","name":"Naval Ravikant","kind":"person","context":"Lucien discussed Naval's 'Specific Knowledge' framework","source":"feishu:oc_hub#msg_7781","confidence":0.9}
{"ts":"2026-04-17T09:15:44Z","name":"Tavily","kind":"company","context":"chose Tavily over Brave for enrich-sweep Tier 2 web search","source":"feishu:oc_hub#msg_7784"}
{"ts":"2026-04-17T11:02:11Z","name":"context-engineering","kind":"concept","context":"new concept page created in ideas/ during morning sync","source":"manual:lucien-terminal"}
```

## Non-goals

- This queue is **not a full event bus**. It carries entity mention
  signals only. Original-thinking signals go straight through
  `POST /ingest` on kos-compat-api (see
  `docs/FEISHU-SIGNAL-DETECTOR-SETUP.md`).
- This queue is **not a task tracker**. enrich-sweep decides what to
  enrich based on the whole brain, not just this queue.

## Related

- Consumer: `skills/kos-jarvis/enrich-sweep/SKILL.md`
- Producer setup: `docs/FEISHU-SIGNAL-DETECTOR-SETUP.md`
- Upstream contract: `skills/signal-detector/SKILL.md`
