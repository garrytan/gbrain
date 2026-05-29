# Eval Capture Schema

This document defines the tenant-safe NDJSON contract emitted by
`cortex eval export`. The format is used by Cortex CI, private tenant
benchmarks, and partner validation harnesses that replay real workflows without
copying production data into public fixtures.

## Pipeline

```text
MCP client, CLI, dashboard, or worker
  -> query/search operation handler
  -> retrieval result plus metadata
  -> scrub sensitive query text
  -> write eval_candidates row
  -> export as NDJSON when requested
```

Capture is fire-and-forget. User-facing queries should not fail because an eval
row could not be written; failures are stored in the companion audit table and
surfaced by `cortex doctor`.

## Export Command

```bash
cortex eval export [--since DUR] [--limit N] [--tool query|search]
```

The command writes one JSON object per newline to stdout. Progress and warnings
go to stderr so the stdout stream can be piped into a fixture file.

```bash
cortex eval export --since 7d --tool query > .ci/evals/retrieval.ndjson
cortex eval export --tool search | jq -c 'select(.latency_ms > 500)'
```

## Row Schema

Every row starts with `schema_version: 1`. Consumers must branch on that field
before parsing.

| Field | Type | Notes |
|---|---|---|
| `schema_version` | number | Always `1` for this contract |
| `id` | number | Export-stable row id |
| `tool_name` | `"query"` or `"search"` | Operation that produced the row |
| `query` | string | Scrubbed query text unless tenant config explicitly disables scrubbing |
| `retrieved_slugs` | string[] | Deduplicated result slugs in result order |
| `retrieved_chunk_ids` | number[] | Chunk ids in result order, duplicates preserved |
| `source_ids` | string[] | Distinct source ids represented in the result set |
| `expand_enabled` | boolean or null | Whether expansion was requested |
| `detail` | `"low"`, `"medium"`, `"high"`, or null | Caller-requested detail level |
| `detail_resolved` | `"low"`, `"medium"`, `"high"`, or null | Detail level used after inference |
| `vector_enabled` | boolean | Whether vector retrieval actually ran |
| `expansion_applied` | boolean | Whether expansion produced variants |
| `latency_ms` | number | Wall-clock operation duration |
| `remote` | boolean | Whether the caller was a remote MCP or API client |
| `job_id` | number or null | Worker job id when applicable |
| `subagent_id` | number or null | Worker or agent id when applicable |
| `created_at` | string | UTC ISO timestamp |

Field order is not guaranteed. Consumers must parse by key.

## Ordering

Rows are exported by `created_at DESC, id DESC`. The id tie-breaker keeps
same-millisecond inserts deterministic.

## Sensitive Data Handling

By default, query text is scrubbed before it is persisted. The scrubber redacts:

- email addresses
- phone numbers
- payment card numbers that pass Luhn checks
- bearer tokens, JWTs, and common API token formats
- social-security-number-shaped strings

Tenants can disable scrubbing only for controlled evaluation workspaces where
the data distribution is explicitly approved.

## Capture Configuration

Capture is opt-in for tenant-controlled environments:

```json
{
  "eval": {
    "capture": true,
    "scrub_pii": true
  }
}
```

Environment overrides are reserved for CI and managed worker contexts:

```bash
CORTEX_EVAL_CAPTURE=1 cortex eval export --limit 100
```

The most explicit tenant config wins. Managed production deployments should use
tenant policy rather than ad-hoc host environment variables.

## Failure Audit

Eval write failures are recorded with one of these stable reason codes:

| Reason | Meaning |
|---|---|
| `db_down` | Storage was unavailable |
| `rls_reject` | Tenant isolation policy rejected the write |
| `check_violation` | The row failed a schema constraint |
| `scrubber_exception` | Sensitive-data scrubber threw |
| `other` | Unknown failure |

Run:

```bash
cortex doctor
```

to surface recent failures before trusting a benchmark export.

## Versioning

Additive optional fields keep `schema_version: 1`. Renames, type changes, or
removals require `schema_version: 2` and a compatibility runway.
