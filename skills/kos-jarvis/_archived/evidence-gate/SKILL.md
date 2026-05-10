---
name: evidence-gate
version: 1.0.0
description: |
  Gatekeeper that blocks low-evidence claims from landing on durable pages.
  Ports KOS v1 evidence levels E0-E4 to GBrain. Different page types have
  different minimum evidence thresholds. Fails fast on violations; advises
  how to upgrade the claim.
triggers:
  - "check evidence"
  - "validate claims"
  - "can I promote this"
tools:
  - get_page
  - search
  - backlinks
mutating: false
---

# Evidence Gate Skill

Port of KOS v1 `knowledge/meta/evidence-levels.md`.

## Evidence levels

| Level | Name | What qualifies |
|-------|------|----------------|
| E0 | Unverified observation | Intuition, single chat mention, provisional note |
| E1 | Single source | One document, one message thread, one meeting |
| E2 | Multi-source consistent | ≥2 independent sources align |
| E3 | High-confidence factual record | Official docs, system config, verified repeatable state |
| E4 | Decision-grade conclusion | Adopted in real operations, behavior-shaping, durable |

## Minimum thresholds by kind

| `kind` | Min evidence for durable claim |
|--------|--------------------------------|
| `source` | E1 (by definition — captures one source) |
| `concept` | E2 — concepts must be multi-sourced |
| `synthesis` | E2 — synthesis bridges multiple sources |
| `comparison` | E2 per compared item |
| `decision` | E3+ — decisions change real behavior |
| `protocol` | E3+ — protocols are executed by the system |
| `project` | E1 for description, E2 for "current state" claims |
| `entity` (person) | E1 for existence, E2+ for beliefs/motivations |

## Rule

Every durable judgment on a page must carry an explicit evidence level.
Frontmatter format:
```yaml
evidence_summary:
  primary: E3
  claims:
    - claim: "Omada software org reports to Lucien"
      level: E3
      source: "~/.openclaw/workspace/USER.md"
    - claim: "User prefers Chinese-first responses"
      level: E4
      source: "operational observation since 2025-10"
```

For unstructured pages, inline tag `[E2]` or `[E3]` after claims in prose.

## Gate algorithm

Before accepting a `put_page` call with `kind in {decision, protocol, concept, synthesis, comparison}`:
1. Parse frontmatter for `evidence_summary` OR scan body for `[E\d]` inline tags
2. Compute max evidence level present
3. If max < threshold for this kind, **reject** with actionable feedback:
   - "Decision page requires E3+. Highest evidence found: E1.
     Upgrade by either: (a) adding a second independent source to reach E2,
     (b) moving this to `kind: synthesis` if E2 is sufficient,
     (c) demoting to `kind: concept` (draft) until more evidence accumulates."

## Exceptions

- `status: draft` pages bypass the gate (flagged for follow-up by `kos-patrol`)
- `status: deprecated` pages bypass (historical record, no longer asserted)

## Inspection command

```bash
bun run ~/Projects/jarvis-knowledge-os-v2/skills/kos-jarvis/evidence-gate/run.ts check <slug>
# Reports: max_evidence, threshold, gate_pass|gate_fail, suggested_remediation
```
