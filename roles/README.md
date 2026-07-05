# roles/ — agent role briefs (pre-skill priming)

Compressed, **anonymised** professional briefs distilled from the care-team job
descriptions (`hackathon_raw_data/Agents - *.docx`). Each brief primes an agent
with **who it is** — its scope, reporting lines, core duties, competencies, and
escalation posture — **before** it runs a task skill. Briefs answer "what is my
role?"; skills (`skills/<slug>/SKILL.md`) answer "how do I do this task?".

**Intended use:** the orchestrator/executor loads the brief for a skill's `role`
and prepends it to the agent's context, so a nurse skill runs with nursing scope
and a psychiatrist skill with psychological-assessment scope. (Wiring into the
run path is a follow-up; the briefs are the content.)

## Role map (job → agent role)

| Care-team job (source) | Agent role (`SKILL_ROLES`) | Brief |
|---|---|---|
| Geriatric Care Assistant / Nursing Assistant (ASG/AS/AMP) | `nurse` | `nurse.md` |
| Psychologist (PASA) | `psychiatrist` | `psychiatrist.md` |
| Coordinating / treating physician | `general-medicine` | `general-medicine.md` |
| **Psychomotor Therapist (PASA)** | **— none —** | `psychomotor-therapist.md` |

Shared operational context every role runs within: `_daily-protocol.md` (the PASA
daily organization protocol).

## Are we missing any jobs?

**Yes — the Psychomotor Therapist.** The dataset defines four distinct care
professions, but our frozen `SKILL_ROLES` contract has only three
(`nurse | psychiatrist | general-medicine`). The psychomotor therapist
(psychomotor assessment, fall-prevention, sensory/motor rehab, PASA coordination)
maps to none of them. Its brief is included here and flagged; promoting it to a
canonical role would be a **contract change** (`src/core/skill-frontmatter.ts`
`SKILL_ROLES`, Dev A arbitrates) — not done here to avoid silently widening the
frozen contract.

The other three jobs are also approximate fits, worth noting:
- `nurse` ← **ASG** is a care *assistant* (AS/AMP), not a registered nurse.
- `psychiatrist` ← **Psychologist** (clinical psychology + CBT), not an MD psychiatrist.
- `general-medicine` ← the **coordinating physician** has no standalone job doc; the
  brief is synthesized from cross-references in the other three.

## Privacy

Briefs are role/profession descriptions — no patient data. All identifiers,
resident names, room numbers, and facility names are excluded (APPI
要配慮個人情報). Regenerating from source must keep that bar (see the qwen
branch's `anonymise.py`).
