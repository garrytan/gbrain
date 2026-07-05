---
name: patient-history-review
version: 1.0.0
description: |
  Role-agnostic patient history retrieval. Pulls and summarizes a patient's
  medical record from the brain — history, medications, allergies — as a
  sourced brief for either a nursing or psychiatric review. Read-only
  decision-support.
triggers:
  - "patient history"
  - "medication list"
  - "allergies"
  - "past medical history"
  - "medical record"
role: shared
tools:
  - search
  - query
  - get_page
  - list_pages
mutating: false
---

# patient-history-review — sourced patient history brief

Use this skill when either lane (nurse or psychiatrist) needs the patient's
existing record assembled before they act. It is deliberately `role: shared`:
the T2 orchestrator can select it ahead of a nurse or a psychiatrist skill in
the same routing pass. It retrieves and summarizes; it does not assess.

> **Convention:** brain-first — this skill IS the brain-first lookup that other
> care skills build on. See `skills/conventions/brain-first.md`.

## Phase 1: Brain-First Lookup

This skill is the lookup:

- `gbrain query "<patient> medical record: history, medications, allergies"`
  for a synthesized, cited brief.
- `gbrain search` / `gbrain get-page` / `gbrain list-pages` for the specific
  record pages.

## Contract

- **Input:** the patient identifier and (optionally) the review lane it's
  feeding (nurse | psychiatrist), so the summary can emphasize the relevant
  parts.
- **Output:** a sourced brief — past medical history, current medication list,
  known allergies, and any recent significant events, each with citations and
  an explicit "not on file" note where the brain is silent.
- **Side effect:** none. `mutating: false`. Read-only by design.

## When to invoke

- Ahead of a triage or a psychiatric screen, to give it a real history.
- At the start of a consult, ward round, or handover.
- Whenever a clinician asks "what do we already have on this patient".

## Procedure

1. **Retrieve** the patient's record pages (above).
2. **Summarize** into the four buckets — history, medications, allergies,
   recent events — with citations.
3. **Flag gaps** — say what the brain does NOT know, so the downstream skill
   can account for it.
4. **Hand off** the brief to the selected care skill.

## Guardrails (read before every run)

- **Retrieval, not judgment.** This skill summarizes what exists; it makes no
  clinical recommendation. The nurse/psychiatrist skills do that.
- **APPI / 要配慮個人情報.** The record is special-care personal information
  under Japan's APPI. Stay strictly within the patient's source scope
  (`sourceScopeOpts`) — a shared skill is the highest-risk place for a
  cross-patient leak. Every auto-run is auditable.
- **Gaps are findings.** An incomplete record is a result to report, never a
  detail to paper over.
