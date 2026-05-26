# Phase 01: Source Registry And Policy

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 00

## Goal

Introduce the source registry and internal source policy model that allow MBrain
to act as a personal data hub while keeping user-facing consent simple.

## Design Decisions

- Users grant minimal consent per source.
- MBrain chooses source-kind defaults for ingest, index, extract, LLM use,
  automatic canonical write, retention, export, and forgetting.
- Advanced overrides exist but are not primary onboarding UX.
- Source kind x claim type authority matrix is introduced here as policy data,
  even if enforcement is completed in Phase 04.
- Source policy is data, not hardcoded conditionals spread across tools.

## In Scope

- Source registry schema.
- Source kind taxonomy.
- Source policy schema.
- Minimal consent state.
- Source enable/pause/disable state.
- Sensitivity defaults.
- Retention defaults.
- LLM permission defaults.
- Automatic canonical write defaults.
- Advanced override storage.
- Source policy resolution service.
- CLI/MCP read surfaces for source status.

## Out Of Scope

- Actual connector implementations.
- Raw source item ingestion.
- Assertion extraction.
- Canonical writes.
- Runtime jobs.

## Source Registry Schema

Core tables:

- `sources`
- `source_policies`
- `source_policy_overrides`
- `source_authority_rules`
- `source_retention_rules`
- `source_llm_rules`
- `source_status_events`

`sources` fields:

- `id`
- `kind`
- `display_name`
- `connector_id`
- `locator`
- `consent_state`
- `enabled`
- `paused_at`
- `created_at`
- `updated_at`
- `archived_at`
- `policy_id`

`consent_state` values:

- `not_requested`
- `granted`
- `denied`
- `revoked`

Source kinds must include:

- `user_direct`
- `codex_session`
- `claude_session`
- `agent_session`
- `manual_note`
- `markdown_file`
- `document`
- `pdf`
- `meeting_transcript`
- `code_repo`
- `email`
- `calendar`
- `browser`
- `bookmark`
- `chat_export`
- `slack`
- `discord`
- `imported_archive`

## User-Facing Policy UX

Normal onboarding should ask only:

```text
Can MBrain use this source for memory?
```

Possible answers:

- yes
- no
- later

Optional second-level actions:

- pause source
- disconnect source
- purge source data
- review source activity

Advanced policy overrides are CLI/config surfaces, not required onboarding.

## Internal Policy Dimensions

Each source policy resolves:

- ingest mode
- index mode
- extraction mode
- raw copy mode
- chunk retention
- LLM access
- runner access
- automatic canonical write authority
- candidate route conditions
- conflict route conditions
- forgetting lifecycle
- restore window
- purge policy
- export/reconcile behavior

## Seeded Default Policy Matrix

Phase 01 must seed deterministic defaults for every source kind. Later phases may
add connector-specific overrides, but they must start from this matrix.

Legend:

- `metadata+chunks`: store locator, hashes, metadata, and selected chunks.
- `summary-only`: store derived summary/chunks, not full raw source.
- `redacted`: raw access is redacted before LLM/runner use.
- `local-only`: local runner/LLM access only unless explicitly overridden.
- `verify`: automatic canonical write is blocked until current/source evidence is
  verified.

| Source kind | Ingest/index | Raw copy | Extraction | LLM/runner access | Auto-write default | Retention / restore / purge |
|---|---|---|---|---|---|---|
| `user_direct` | enabled when granted | none | direct claim | none unless requested | decisions/preferences auto, sensitive info candidate | long archive, easy restore, purge by explicit user request |
| `codex_session` | enabled when granted | metadata+chunks | structured + semantic | local-only, redacted | task outcomes auto, inferred preferences candidate | medium archive, purge transient mechanics quickly |
| `claude_session` | enabled when granted | metadata+chunks | structured + semantic | local-only, redacted | task outcomes auto, inferred preferences candidate | medium archive, purge transient mechanics quickly |
| `agent_session` | enabled when granted | metadata+chunks | structured + semantic | local-only, redacted | task outcomes auto, inferred preferences candidate | medium archive, purge transient mechanics quickly |
| `manual_note` | enabled when granted | metadata+chunks | semantic | local-only | decisions/preferences auto when explicit | long archive, easy restore |
| `markdown_file` | enabled when granted | metadata+chunks | semantic | local-only | candidate unless source is trusted project/user memory | long archive, repair through source pipeline |
| `document` | enabled when granted | metadata+chunks | semantic | redacted, policy-gated | world/project facts candidate or verify-first | source retention, restore while source retained |
| `pdf` | enabled when granted | metadata+chunks | semantic | redacted, policy-gated | world/project facts candidate or verify-first | source retention, restore while source retained |
| `meeting_transcript` | enabled when granted | summary-only by default | speaker-aware semantic | redacted, policy-gated | commitments auto only with clear speaker/target | medium archive, sensitive purge priority |
| `code_repo` | enabled when granted | metadata+chunks | code-aware semantic | local-only by default | code claims verify-first | stale quickly, reverify before answer/purge |
| `email` | enabled when granted | summary-only by default | relationship/event semantic | redacted, explicit grant for raw | relationship candidate, calendar-like events verify-first | short raw retention, long derived non-sensitive facts |
| `calendar` | enabled when granted | metadata+chunks | event semantic | redacted | events auto when target/time clear | medium archive, restore while source retained |
| `browser` | enabled when granted | metadata only by default | preference/topic summary | redacted, explicit grant for raw | preferences candidate | short retention, purge aggressively |
| `bookmark` | enabled when granted | metadata+chunks | topic/resource summary | local-only | candidate | medium archive |
| `chat_export` | enabled when granted | summary-only by default | semantic | redacted, policy-gated | candidate unless user-authored decision is explicit | medium archive, sensitive purge priority |
| `slack` | enabled when granted | summary-only by default | semantic | redacted, policy-gated | commitments candidate unless speaker/target clear | medium archive, sensitive purge priority |
| `discord` | enabled when granted | summary-only by default | semantic | redacted, policy-gated | commitments candidate unless speaker/target clear | medium archive, sensitive purge priority |
| `imported_archive` | enabled when granted | metadata+chunks | semantic | redacted, policy-gated | candidate until source trust is classified | source retention, manual purge review |

Minimal consent controls whether a source is enabled. This matrix controls what
an enabled source is allowed to do by default. Advanced overrides must be
persisted as policy data and logged.

## Authority Matrix Seed

Create policy rows for source kind x claim type. Enforcement happens later, but
the structure must exist.

Claim types include:

- `decision`
- `preference`
- `commitment`
- `event`
- `relationship`
- `profile_fact`
- `project_rule`
- `architecture_claim`
- `code_claim`
- `task_outcome`
- `source_summary`
- `world_fact`
- `inferred_pattern`
- `sensitive_personal_info`

Authority outcomes:

- `auto_canonical`
- `candidate`
- `verify_first`
- `conflict_check`
- `never_canonical`
- `quarantine`

## Safety

- Consent revocation must prevent future ingest/extraction.
- Paused sources must not generate new canonical writes.
- Source deletion/purge must not erase audit tombstones required for safety.
- Policy resolution must be deterministic and logged.

## Tests

Required tests:

- register source with minimal consent
- resolve default policy for every source kind
- seeded matrix covers every source kind
- override advanced policy without changing user-facing consent
- pause/revoke prevents future processing
- authority matrix lookup is deterministic
- policy event history is append-only

## Acceptance Criteria

- MBrain can register all target source kinds.
- Each source has an internal layered policy derived from minimal consent.
- Every source kind has seeded defaults for ingest, raw copy, extraction,
  LLM/runner access, automatic write, retention, restore, and purge.
- Source status and policy are inspectable.
- Later phases can ingest source items and enforce authority using this policy.
