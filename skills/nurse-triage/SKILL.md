---
name: nurse-triage
version: 1.0.0
description: |
  Nursing intake and triage decision-support. Reviews presenting symptoms,
  vital signs, and the patient's brain history to suggest an assessment order
  and an escalation recommendation. Decision support only — a licensed nurse
  or clinician makes the call.
triggers:
  - "chest pain"
  - "shortness of breath"
  - "triage"
  - "vital signs"
  - "fever"
  - "wound care"
role: nurse
tools:
  - search
  - query
  - get_page
  - list_pages
mutating: false
---

# nurse-triage — nursing intake & triage decision-support

Use this skill when a patient presents with a physical symptom that needs a
nursing assessment and an escalation decision. It gathers what the brain
already knows about the patient, structures the presenting complaint, and
proposes a triage order. It does **not** diagnose and never auto-acts.

> **Convention:** brain-first — read the patient's existing brain pages before
> advising. See `skills/conventions/brain-first.md`.

## Phase 1: Brain-First Lookup

Before assessing, pull the patient's context so triage is informed, not blind:

- `gbrain query "<patient> recent vitals, active problems, medications"` for a
  synthesized summary with citations.
- `gbrain search` / `gbrain get-page` for the specific note pages behind it.

If the brain has nothing on this patient, say so explicitly — an unknown
history changes the risk picture.

## Contract

- **Input:** a presenting complaint (symptom + any measured vitals) and the
  patient identifier.
- **Output:** a structured triage note — presenting complaint, relevant
  history, an ordered assessment checklist, and an escalation recommendation
  (self-care / nurse review / urgent clinician / emergency).
- **Side effect:** none by default. `mutating: false`. Any write of the triage
  note to the brain is a separate, human-confirmed step.

## When to invoke

- A patient reports a physical symptom (chest pain, breathlessness, fever,
  a wound) and someone needs to know how urgently to act.
- Vital signs are abnormal and need to be put in context.
- A ward round or handover needs a quick, sourced triage summary.

## Procedure

1. **Brain-first lookup** (above) — establish baseline + active problems.
2. **Structure the complaint** — onset, severity, associated symptoms,
   measured vitals.
3. **Cross-reference risk** — flag red-flag combinations (e.g. chest pain +
   breathlessness) against the patient's history.
4. **Propose an assessment order** — a checklist a nurse can work through.
5. **Recommend an escalation level** — with the reasoning and the sources.

## Guardrails (read before every run)

- **Decision support, not diagnosis.** Output is a recommendation for a
  licensed clinician to confirm. Never present it as a diagnosis or an order.
- **APPI / 要配慮個人情報.** Patient health data is special-care personal
  information under Japan's APPI. Stay within the patient's source scope
  (`sourceScopeOpts`) — never pull another patient's pages into this one's
  triage. Every auto-run is auditable.
- **Escalate on uncertainty.** When the brain lacks data or the picture is
  ambiguous, recommend the higher escalation level, not the lower.
