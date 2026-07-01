---
id: meeting-sync
name: Meeting Sync
version: 0.8.0
description: Fireflies and Granola transcripts imported through local Composio CLI as two-phase GBrain meeting pages with mandatory propagation before completion.
category: sense
requires:
  - composio
secrets: []
setup_time: 15 min
cost_estimate: "Depends on Fireflies, Granola, and Composio accounts already in use"
---

# Meeting Sync: Transcript-Grounded Meeting Memory

Meeting sync turns recorded Fireflies and Granola meetings into durable brain
pages. The deterministic command only performs Phase 1: it fetches raw/diarized
transcripts through the local Composio CLI, writes idempotent meeting markdown,
and marks each page `ingestion_status: pending_propagation`.

Phase 2 is agent work. A meeting is not fully ingested until attendees,
mentioned entities, action items, timelines, and bidirectional backlinks have
all been propagated and verified. Only then may the page be marked
`ingestion_status: complete`.

## Sources

The built-in command uses Composio only. Do not call provider APIs directly and
do not ask for Fireflies or Granola API keys.

Required connected Composio toolkits:

- `fireflies`
- `granola_mcp`

Required Composio tool slugs:

- Fireflies listing: `FIREFLIES_GET_TRANSCRIPTS`
- Fireflies detail: `FIREFLIES_GET_TRANSCRIPT_BY_ID`
- Granola listing: `GRANOLA_MCP_LIST_MEETINGS`
- Granola details: `GRANOLA_MCP_GET_MEETINGS`
- Granola transcript: `GRANOLA_MCP_GET_MEETING_TRANSCRIPT`

Circleback remains a documented meeting source elsewhere in the skillpack, but
it is not part of this built-in Fireflies + Granola implementation.

## Architecture

```
Fireflies / Granola
  -> local Composio CLI
  -> gbrain meeting-sync
  -> meetings/{YYYY-MM-DD}-{slug}.md
     ingestion_status: pending_propagation
  -> agent propagation
  -> ingestion_status: complete
```

## Phase 1: Deterministic Transcript Collection

Run:

```bash
gbrain meeting-sync --providers fireflies,granola --days 2 --repo ~/brain
```

For scheduled automation, submit the same deterministic collection through
Minions so the run is durable and observable:

```bash
gbrain meeting-sync --providers fireflies,granola --days 2 --repo ~/brain --background
```

Run a Minions worker or supervisor in Postgres-backed deployments so queued
jobs are claimed:

```bash
gbrain jobs supervisor start --detach --json
```

`meeting-sync` is submitted explicitly with `--background`; do not rely on
legacy cron auto-rewrite for this handler.

Backfill:

```bash
gbrain meeting-sync --providers fireflies,granola --all --repo ~/brain
```

Inspect incomplete pages:

```bash
gbrain meeting-sync --list-pending --repo ~/brain
```

Then index newly written markdown:

```bash
gbrain sync --no-pull --no-embed
gbrain embed --stale
```

### Ground Truth Rules

- Fireflies transcript text must come from `sentences[]`.
- Granola transcript text must come from `GRANOLA_MCP_GET_MEETING_TRANSCRIPT`.
- AI summaries or notes may populate summary sections, but never replace the
  transcript ground truth.
- If no diarized/raw transcript is available, skip the meeting and report an
  error. Do not write a summary-only meeting page.

### Idempotency

Every meeting uses a stable source ID:

- `fireflies:<transcript_id>`
- `granola:<meeting_uuid>`

The command skips an existing meeting when either the target filename already
exists or any existing `meetings/**/*.md` file contains the same `source_id`.
Reruns must not create duplicates.

## Meeting Page Contract

Path:

```text
meetings/{YYYY-MM-DD}-{slug}.md
```

Required frontmatter:

```yaml
---
type: meeting
source_type: fireflies
source_id: fireflies:abc123
date: 2026-06-29
duration: 30 min
location: Google Meet
attendees:
  - name: Alice Example
    email: alice@example.com
tags: [sync]
ingestion_status: pending_propagation
---
```

`duration` and `location` are included when the provider returns them.
The command may also emit metadata such as `id`, `source`, `provider_id`,
`source_url`, and `updated_at`. These are informational; `source_id` remains
the idempotency key.

Required sections above the separator:

```markdown
## Summary
None

## Key Decisions
None

## Action Items
None

## Discussion Notes / Key Points
None

## Attendees
- Alice Example

---

## Transcript

**Alice Example** (00:00): Raw transcript line.
```

Render `None` when any required content section is absent. Attendee display
lists must not show raw email addresses. Calendar resources and group/list
addresses should be filtered out. If only an email exists for a real attendee,
derive a display name from the local part.

The full diarized transcript lives below the separator and is append-only.
Phase 2 and reruns must not rewrite, truncate, or replace that transcript
block.

## Phase 2: Mandatory Propagation

For every page returned by `gbrain meeting-sync --list-pending`:

1. Read the full meeting transcript.
2. Create or update every attendee people page.
3. Detect mentioned people, companies, projects, and topics from the full
   transcript.
4. Create or update each detected entity page, or document a skip reason.
5. Add timeline entries to every attendee and every detected entity.
6. Track action items with owner attribution where available.
7. Create bidirectional backlinks between the meeting and every propagated
   entity.
8. Verify backlinks, timelines, action items, and searchability.
9. Set `ingestion_status: complete` only after all verification passes.

The CLI can do a deterministic first pass:

```bash
gbrain meeting-sync --propagate-pending --repo ~/brain
gbrain meeting-sync --propagate-pending --meeting granola:<uuid> --repo ~/brain
gbrain meeting-sync --propagate-pending --repo ~/brain --background
```

This pass creates/updates attendee pages, links existing mentioned entity pages,
tracks action items, writes timeline entries, creates bidirectional graph links,
and preserves the transcript block. It deliberately leaves
`ingestion_status: pending_propagation` and records
`propagation_status: deterministic_propagated_pending_agent_review`, because
new entity discovery/enrichment and the final searchability check still require
agent review. Do not mark the page `complete` until the full verification list
below passes.

Finalize only after agent review:

```bash
gbrain meeting-sync --verify-complete --agent-reviewed --meeting granola:<uuid> --repo ~/brain
```

`--verify-complete` checks the Phase 2 verification list and refuses to write
`ingestion_status: complete` unless `--agent-reviewed` is present and no
blockers remain. This is intentionally explicit: cron/autopilot may run
collection and deterministic propagation as Minion jobs, but final completion
requires agent-reviewed verification. A fully autonomous deployment should
enqueue a `meeting-ingestion` subagent job for each pending meeting, then run
this finalizer only after that agent has resolved entity/action review markers.

## Verification

After Phase 1:

- Every created file exists at the expected path.
- Frontmatter `source_id` matches the provider ID.
- Frontmatter has `ingestion_status: pending_propagation`.
- A rerun creates no duplicates.
- The transcript section contains speaker, timestamp, and text lines.
- The transcript block is unchanged by an idempotent rerun.
- `gbrain search "<meeting title>" --limit 3` returns the meeting.

After Phase 2:

- Every attendee has a people page.
- Every detected entity has a page or documented skip reason.
- Every attendee/entity has a timeline entry referencing the meeting.
- Every action item is tracked and linked to the meeting.
- Backlinks exist both directions for every propagated entity.
- The transcript block remains unchanged.
- `gbrain search "<meeting title>" --limit 3` returns the meeting.
- `ingestion_status` is set to `complete`.

## Failure Modes

- `composio` is missing: install or restore the local Composio CLI.
- Toolkit not connected: run `composio link fireflies` or
  `composio link granola_mcp`, then retry.
- Provider returns summary/notes without raw transcript: skip the meeting and
  report the error.
- Duplicate-looking meeting: trust `source_id`; do not create a second page for
  the same provider meeting.
