---
name: gbrain-ingest
description: Queue async GBrain ingest without blocking agent work.
triggers:
  - "gbrain-ingest"
  - "remember this"
  - "ingest into gbrain"
  - "save this to gbrain"
  - "preserve this in gbrain"
---

# gbrain-ingest

Use this when the user asks to remember, save, ingest, or preserve durable
content in GBrain and the current turn should not wait for enrichment.

## Contract

This skill queues durable GBrain ingestion work and returns immediately. The
foreground agent gets a `job_id`, `status_command`, and `status_url`; source
normalization, filesystem brain write, database import, relationship
extraction, concept/person/company surfacing, and enrichment happen in the
worker.

## Command

```bash
gbrain-ingest --text "Remember this: ..." --json
gbrain-ingest --url https://example.com/page --json
gbrain-ingest --file ./notes/source.md --json
```

The command returns immediately with `job_id`, `status_command`, and
`status_url`. Check progress with:

```bash
gbrain jobs get <job-id>
```

For runtime health, prefer bounded status surfaces before raw logs:

```bash
gbrain doctor --fast --json --codex-oauth-smoke
gbrain jobs smoke --gbrain-ingest --json --timeout-ms 60000
```

The doctor smoke is opt-in and verifies the non-interactive Codex OAuth route
for `gpt-5.4-mini`. The jobs smoke proves enqueue, worker terminal status, and
enrichment status separately.

## Rules

- Do not use GBrain MCP.
- Do not call `gbrain serve`.
- Do not store raw transcripts, raw prompts, or raw tool output from automatic
  hook capture.
- Use `--mode signal` only for distilled hook payloads and explicit
  `remember this` moments.
- Write/enrichment inference is handled by workers through Codex OAuth with
  `gpt-5.4-mini`.
- OpenAI API-key material is for embeddings only.
- If source/import succeeds and enrichment fails, the job must still reach a
  terminal result with `enrichment.status` such as `timeout`,
  `configuration_error`, `failed`, or `skipped`.
- When the target source has `sources.local_path`, the worker writes the source
  markdown into that filesystem brain before importing the same content into
  PostgreSQL/searchable state.

## Anti-Patterns

- Do not block the current coding turn to extract entities or enrich pages.
- Do not store raw transcripts, raw prompts, or raw tool output from automatic
  hook capture.
- Do not pass secret material as ingest content.
- Do not re-run embedding work for unchanged chunks.
- Do not paste raw service logs, raw prompts, or environment output into docs or
  brain pages while debugging. Use redacted job/doctor/smoke output first.

## Output Format

For `--json`, return one JSON object with:

- `job_id`
- `queued`
- `idempotency_key`
- `status_command`
- `status_url`
- `job_name`
- `queue`

For human output, print the job id and the status command only.
