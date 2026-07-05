---
name: psych-risk-screen
version: 1.0.0
description: |
  Psychiatric risk-screening decision-support. Structures a mental-status
  picture and a risk assessment (self-harm, suicidality, escalation) from the
  presenting concern and the patient's brain history. Decision support only —
  a psychiatrist or qualified clinician makes the call.
triggers:
  - "suicidal"
  - "self-harm"
  - "mental status"
  - "psychiatric risk"
  - "depression"
  - "anxiety"
role: psychiatrist
tools:
  - search
  - query
  - get_page
  - list_pages
mutating: false
---

# psych-risk-screen — psychiatric risk-screening decision-support

Use this skill when a patient presents with a mental-health concern that needs
a structured risk screen and an escalation decision. It gathers the patient's
psychiatric history from the brain, structures a mental-status picture, and
proposes a risk level. It does **not** diagnose and never auto-acts.

> **Convention:** brain-first — read the patient's existing brain pages before
> advising. See `skills/conventions/brain-first.md`.

## Phase 1: Brain-First Lookup

Before screening, pull the patient's psychiatric context:

- `gbrain query "<patient> psychiatric history, current medications, prior risk events"`
  for a synthesized, cited summary.
- `gbrain search` / `gbrain get-page` for the underlying note pages.

If the brain has no prior psychiatric history, state that — absence of a
record is not absence of risk.

## Contract

- **Input:** the presenting mental-health concern and the patient identifier.
- **Output:** a structured screen — presenting concern, relevant history,
  a mental-status summary, and a risk recommendation (routine / enhanced
  monitoring / urgent psychiatric review / crisis response).
- **Side effect:** none by default. `mutating: false`. Writing the screen to
  the brain is a separate, human-confirmed step.

## When to invoke

- A patient expresses hopelessness, self-harm ideation, or acute distress.
- A depression or anxiety presentation needs a structured risk picture.
- A clinician needs a sourced mental-status summary before a review.

## Procedure

1. **Brain-first lookup** (above) — establish psychiatric baseline + prior events.
2. **Structure the concern** — onset, severity, protective and risk factors.
3. **Screen for acute risk** — self-harm / suicidality indicators, weighted
   against history.
4. **Summarize mental status** — a structured picture a clinician can confirm.
5. **Recommend a risk level** — with reasoning and sources.

## Guardrails (read before every run)

- **Decision support, not diagnosis.** Output is a recommendation for a
  qualified clinician to confirm. Never present it as a diagnosis or an order.
- **Acute risk is not this skill's job to hold.** If indicators point to
  imminent self-harm, the recommendation is immediate escalation to crisis
  response — a screen never substitutes for a real-time clinical response.
- **APPI / 要配慮個人情報.** Psychiatric data is special-care personal
  information under Japan's APPI. Stay within the patient's source scope
  (`sourceScopeOpts`); never cross patients. Every auto-run is auditable.
- **Escalate on uncertainty.** When data is thin or the picture is ambiguous,
  recommend the higher level of care.
