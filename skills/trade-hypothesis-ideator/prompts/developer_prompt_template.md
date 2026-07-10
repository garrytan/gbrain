## Objective
Generate 1-5 high-quality trade hypothesis cards for iterative testing.

## Evidence Summary
{{evidence_summary}}

## Output Requirements
Return JSON with top-level key `hypotheses`.
Each hypothesis must include all required fields from `schemas/hypothesis_card.schema.json`.
Focus on:
- clear mechanism
- testability with available features
- explicit invalidation and constraints-awareness
