# Phase 02: Raw Ingest And Provenance

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 01

## Goal

Store source items, chunks, provenance, safety flags, and raw access audit data
so every future extracted claim and canonical assertion can be traced to source
evidence.

## Design Decisions

- MBrain stores metadata and selected chunks by default, not full raw copies.
- Full raw copy is source-policy controlled.
- Raw source text is untrusted.
- Prompt injection and secrets are detected during ingest.
- Runner access to raw source chunks is scoped and logged.

## In Scope

- Source item schema.
- Source chunk schema.
- Provenance references.
- Content hash and parser version tracking.
- Prompt injection classifier flags.
- Secret detection and redaction metadata.
- Raw access ledger.
- Ingest status and error tracking.
- Chunk retention metadata.

## Out Of Scope

- Full connector implementations.
- Extracted claim generation.
- Assertion resolution.
- Canonical writes.
- Dream cycle.

## Schema

Core tables:

- `source_items`
- `source_chunks`
- `source_item_events`
- `raw_access_ledger`
- `secret_detections`
- `prompt_injection_flags`
- `ingest_attempts`

`source_items` fields:

- `id`
- `source_id`
- `external_id`
- `origin_event`
- `locator`
- `title`
- `source_created_at`
- `source_updated_at`
- `ingested_at`
- `content_hash`
- `metadata_json`
- `raw_copy_mode`
- `raw_copy_ref`
- `sensitivity_level`
- `ingest_status`
- `retention_policy_id`

`origin_event` values include:

- `initial_import`
- `connector_sync`
- `manual_entry`
- `user_direct_entry`
- `session_capture`
- `markdown_edit`

`source_chunks` fields:

- `id`
- `source_item_id`
- `chunk_index`
- `chunk_hash`
- `chunk_text`
- `redacted_text`
- `token_count`
- `parser_version`
- `extractor_version`
- `sensitivity_flags`
- `prompt_injection_risk`
- `secret_risk`
- `created_at`
- `expires_at`

## Raw Copy Policy

Default:

- store metadata
- store selected chunks/excerpts
- store source locator and hashes
- do not store full raw copy

Full raw copy is allowed only when source policy permits it.

Sensitive/secret-bearing sources default to no full copy or short retention.

## Prompt Injection Policy

Ingest must classify raw text for:

- instruction override attempts
- credential exfiltration attempts
- tool misuse requests
- prompt leakage attempts
- hidden or encoded instructions
- suspicious remote command instructions

Outcomes:

- `none`
- `flagged`
- `quarantined`

Quarantined source chunks:

- cannot trigger automatic canonical write
- cannot be sent to runner without explicit sanitized handling
- appear in reports

## Secret Policy

Secret detection runs before runner/LLM access.

Secret-bearing chunks:

- store redaction metadata
- provide redacted text to runner/LLM
- cannot create canonical secret assertions
- get retention/purge priority
- appear in report without secret value

Detected secret metadata:

- secret type
- hash
- confidence
- source item/chunk
- redaction status
- purge/redaction plan status

## Raw Access Ledger

Every raw source read by runner, daemon, MCP session, or CLI operation must log:

- actor type
- actor id
- session id
- job id
- source id
- source item id
- chunk ids
- reason
- policy decision
- prompt hash/input hash when applicable
- timestamp

## Tests

Required tests:

- ingest creates source item and chunks with hashes
- no full raw copy by default
- full raw copy only when policy allows
- prompt injection flag prevents automatic canonical route
- secret redaction happens before runner payload construction
- raw access ledger records scoped reads
- source revocation prevents future raw access

## Acceptance Criteria

- Every ingested item is traceable by source id, item id, chunk id, and hash.
- Safety flags exist before extraction.
- Raw access is scoped and auditable.
- Later phases can extract claims without losing provenance.
