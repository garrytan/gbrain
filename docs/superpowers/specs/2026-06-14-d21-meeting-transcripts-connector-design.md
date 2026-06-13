# D-21 Meeting Transcript Filesystem Connector Design

Date: 2026-06-14
Status: Design for D-21 implementation slice
Depends on: Phase 01, Phase 02, Phase 11

## Goal

Implement the first end-to-end connector for meeting transcripts by syncing
local Markdown or plain-text transcript files into the source registry raw
ingest path. The connector produces source items and chunks only. It never
writes canonical brain pages, assertions, candidates, summaries, or projections.

This slice proves that the existing connector substrate can move real personal
data through consent, source policy, idempotent ingest planning, provenance,
secret scanning, and prompt-injection scanning without adding a remote credential
surface.

## Current Substrate

The repository already has the framework pieces needed for this connector:

- `meeting_transcripts` is registered as a connector with source kind
  `meeting_transcript` and default scope `meetings.read`.
- `createPersonalDataConnectorService().registerConnectorSource()` creates a
  source registration plan with consent and source policy.
- `createPersonalDataConnectorService().syncConnector()` authorizes provider
  access through `loadItems`, rejects revoked or paused sources, and maps
  connector items through `planConnectorSync()`.
- `planConnectorSync()` converts connector items into raw ingest plans and skips
  unchanged items by `external_id` and `content_hash`.
- `persistRawIngestPlan()` and the source registry operations persist source
  items, chunks, and sync records.
- `mbrain connectors` currently supports definition inspection only through
  `list` and `show`.

## User Workflow

```bash
mbrain connectors sync meeting_transcripts --path ~/Meetings/transcripts
mbrain connectors sync meeting_transcripts --path ~/Meetings/2026-06-14.md
mbrain connectors sync meeting_transcripts --path ~/Meetings/transcripts --dry-run
```

The explicit `--path` argument is the consent action for this local-only
connector. The first successful non-dry run registers a connector source for the
normalized path root with consent state `granted`. No credential secret is
needed; the implementation uses a local credential reference with no secret
payload so the existing connector authorization contract remains intact.

## Scope

In scope:

- A filesystem loader for `meeting_transcripts`.
- Input path can be a single file or a directory.
- Supported file extensions are `.md`, `.markdown`, and `.txt`.
- Directory traversal is recursive, deterministic, and sorted by normalized
  relative path.
- Hidden files and hidden directories are skipped.
- Unsupported extensions are skipped and counted.
- Each file is read as UTF-8 text.
- Each file has a maximum size of 5 MiB. Oversized files are skipped and counted
  with reason `file_too_large`.
- Empty files are skipped and counted with reason `empty_file`.
- A dry run reports counts and planned item metadata without mutating the
  database.
- A non-dry run registers or reuses the matching connector source, plans raw
  ingest, persists changed source items and chunks, records sync success, and
  reports skipped unchanged items.
- Existing source revocation, pause, and consent rules remain authoritative.

Out of scope:

- Audio, video, OCR, PDF, or image parsing.
- Calendar, Zoom, Google Meet, Microsoft Teams, Slack, or remote OAuth sync.
- Background watchers or daemonized filesystem monitoring.
- Deleting or archiving source items when files disappear from disk.
- LLM extraction, meeting summarization, assertion creation, candidate
  promotion, or canonical page writes.
- Exposing raw transcript text in command output.

## Source Identity

The connector source is keyed by the normalized real path root:

- For a directory input, root is the directory real path.
- For a single-file input, root is the parent directory real path.
- The source account locator is `file://<root-realpath>`.
- The display name is `Meeting Transcripts: <basename(root)>`.

The source is reused when an existing enabled source has the same connector id
and locator. If a matching source exists but is revoked or paused, sync stops
before reading transcript files.

## Item Mapping

Each accepted file maps to one connector source item:

- `external_id`: normalized POSIX-style relative path from the source root.
- `locator`: `file://<file-realpath>`.
- `title`: frontmatter `title:` for Markdown files when present; otherwise the
  filename without extension.
- `body`: full file text.
- `created_at`: `null`.
- `updated_at`: file modification time as an ISO timestamp.
- `metadata_json`:
  - `connector_id`: added by `planConnectorSync()`.
  - `source_path`: absolute file real path.
  - `relative_path`: normalized relative path.
  - `extension`: lowercase file extension.
  - `file_size_bytes`: file size in bytes.
  - `mtime_ms`: file modification time in milliseconds.

`external_id` is path-stable across content edits. Content changes are detected
by the raw ingest content hash. File renames produce a new `external_id`; missing
old paths are retained under normal source retention policy until a separate
deletion slice implements archive signals.

## Command Output

The command prints JSON. Dry-run and non-dry-run output share the same top-level
shape:

```json
{
  "connector_id": "meeting_transcripts",
  "source_id": "src_example",
  "dry_run": false,
  "path": "/Users/example/Meetings/transcripts",
  "planned": 2,
  "persisted": 2,
  "skipped_unchanged": 0,
  "skipped_files": [
    {
      "relative_path": "archive/call.pdf",
      "reason": "unsupported_extension"
    }
  ]
}
```

Dry runs set `source_id` to `null` when the source would be newly registered and
set `persisted` to `0`.

## Error Handling

- Missing `--path` exits with a usage error.
- Unknown connector id exits with the existing unknown connector error.
- Any connector other than `meeting_transcripts` exits with
  `connectors sync only supports meeting_transcripts`.
- A path that does not exist exits with `meeting transcript path does not exist`.
- A path that is neither file nor directory exits with
  `meeting transcript path must be a file or directory`.
- UTF-8 read failures or filesystem permission failures fail the sync and record
  a connector failure event when a source exists.
- Revoked or paused source state stops before reading files.
- Raw ingest secret scanning and prompt-injection scanning remain part of
  `buildRawIngestPlan()`; the connector does not bypass them.

## Implementation Plan

1. Add a small loader module for meeting transcript filesystem inputs.
2. Add focused loader tests first for traversal, filtering, item identity, title
   extraction, size limits, and stable ordering.
3. Extend `mbrain connectors` with `sync meeting_transcripts --path <path>
   [--dry-run]`.
4. Add command/service tests proving dry-run no mutation, first sync persistence,
   unchanged rerun skipping, and revoked source blocking.
5. Keep all persisted content in source registry raw ingest tables; do not touch
   canonical brain page write paths.

Likely files:

- `src/core/connectors/meeting-transcripts-filesystem.ts`
- `src/commands/connectors.ts`
- `test/meeting-transcripts-connector.test.ts`
- `test/connectors-command.test.ts`

## Required Verification

Run only focused verification for this slice:

```bash
bun test test/meeting-transcripts-connector.test.ts test/connectors-command.test.ts test/personal-data-connector-service.test.ts
bunx tsc --noEmit
command git diff --check
```

Full repository tests are intentionally deferred to the user-requested final
validation pass after the backlog PR sequence.

## Acceptance Criteria

- `mbrain connectors sync meeting_transcripts --path <dir>` ingests supported
  local transcript files into source registry source items and chunks.
- Re-running the same command without file changes skips unchanged items by
  `external_id` and content hash.
- `--dry-run` reports planned work without registering sources or persisting raw
  ingest records.
- Revoked or paused matching sources block sync before transcript files are
  read.
- Command output exposes counts and paths, not raw transcript text.
- No canonical brain pages, assertions, candidates, summaries, or projections
  are created by this connector.
