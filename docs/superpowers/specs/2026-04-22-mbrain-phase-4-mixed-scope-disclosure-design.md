# Phase 4 Mixed-Scope Disclosure Design

## Goal

Add one deterministic read artifact on top of `mixed_scope_bridge` so mixed
retrieval can disclose bounded personal context without flattening personal
records into raw output.

## Scope

- keep `mixed_scope_bridge` route selection unchanged
- add one derived disclosure read artifact for successful mixed bridges
- preserve work-side orientation output from `broad_synthesis`
- constrain personal-side disclosure by published visibility rules
- expose the disclosure artifact through one shared operation
- add benchmark and Phase 4 acceptance coverage

## Non-Goals

- changing scope-gate policy
- changing retrieval selector intent routing
- mixed-scope durable writes
- raw personal-episode export
- general-purpose visibility inheritance beyond this mixed-bridge projection

## Disclosure Rules

### Profile-Memory Branch

When the personal side resolves to `personal_profile_lookup`:

- `export_status: "exportable"` and `sensitivity !== "secret"` may disclose the
  exact profile content
- `export_status: "private_only"` may disclose `subject` and `profile_type`, but
  must withhold raw `content`
- `sensitivity: "secret"` must withhold raw `content` even if the record is
  otherwise exact-matchable

### Personal-Episode Branch

When the personal side resolves to `personal_episode_lookup`:

- disclose `title`, `source_kind`, and temporal metadata only
- do not disclose raw `summary` in this slice
- treat personal episodes as metadata-only mixed output unless a later explicit
  publication rule says otherwise

## Output Shape

The derived read should return:

- `selection_reason`
- `candidate_count`
- `scope_gate`
- `disclosure`, when a mixed bridge exists:
  - `disclosure_kind: "mixed_scope_bridge"`
  - `work_summary_lines`
  - `personal_route_kind`
  - `personal_visibility`
  - `personal_summary_lines`
  - `recommended_reads`

If the underlying mixed bridge cannot resolve, the disclosure read returns the
same degraded selection reason and no disclosure payload.

## Acceptance

- `mixed-scope-disclosure` is available through the shared operation surface
- exportable profile records surface bounded mixed disclosure content
- private or secret profile records withhold raw personal content
- personal-episode mixed disclosure remains metadata-only
- benchmark reports `mixed_scope_disclosure` and
  `mixed_scope_disclosure_correctness`
- `phase4-acceptance` includes the mixed-scope disclosure slice
