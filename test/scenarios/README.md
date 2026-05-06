# Scenario-based test suite

Design-contract-driven tests that validate the redesign invariants in
`docs/architecture/redesign/00`–`08` end-to-end. Each scenario cites the
specific invariant(s) it falsifies on violation.

## Running

```sh
bun run test:scenarios
# or
bun test test/scenarios/
```

## Design doc

The durable invariant catalog lives in `docs/architecture/redesign/`. Local
agent planning/spec files are intentionally not tracked.

## Current Scenario Contract

| # | File | Invariants | Status |
|---|---|---|---|
| S1  | `s01-fresh-install.test.ts` | I6, I7, I4 | ✅ green |
| S2  | `s02-task-resume.test.ts` | I3, L7 | ✅ green |
| S3  | `s03-intent-driven-routing.test.ts` | I1 | ✅ green |
| S4  | `s04-personal-scope-deny.test.ts` | I5 | ✅ green |
| S5  | `s05-mixed-intent-decomposition.test.ts` | L1, I5 | ✅ green |
| S6  | `s06-promotion-requires-provenance.test.ts` | I4, G1, L6 | ✅ green (includes engine-level I4 fix) |
| S7  | `s07-supersession-cross-engine.test.ts` | I7, L5 | ✅ green on SQLite + PGLite, Postgres when `DATABASE_URL` is set |
| S8  | `s08-rejection-preserves-provenance.test.ts` | G2, L5 | ✅ green |
| S9  | `s09-curated-over-map.test.ts` | L2 | ✅ green |
| S10 | `s10-precision-degradation.test.ts` | L3 | ✅ green |
| S11 | `s11-code-claim-verification.test.ts` | L4 | ✅ green |
| S12 | `s12-baseline-gated-acceptance.test.ts` | E1 | ✅ green (tests regression-fail case) |
| S13 | `s13-personal-export-boundary.test.ts` | I5, G2 | ✅ green |
| S14 | `s14-retrieval-trace-fidelity.test.ts` | L6 | ✅ green |
| S15 | `s15-brain-loop-audit.test.ts` | L6 | ✅ green |
| S16 | `s16-interaction-linked-writes-audit.test.ts` | L6, G1, G2 | ✅ green |
| S17 | `s17-task-less-trace.test.ts` | L6 | ✅ green |
| S18 | `s18-interaction-id-handoff.test.ts` | L6, G1 | ✅ green |
| S19 | `s19-interaction-id-supersession.test.ts` | L6, L5 | ✅ green on SQLite + PGLite, Postgres when `DATABASE_URL` is set |
| S20 | `s20-interaction-id-nullable.test.ts` | L6 | ✅ green |
| S21 | `s21-candidate-status-events-audit.test.ts` | L6, G1 | ✅ green |
| S22 | `s22-agentic-canonical-retrieval.test.ts` | Task 7 | ✅ green |

Legend:
- ✅ green = passes on current code

The redesign scenario suite currently has zero placeholder tests. It covers the
original S1-S14 redesign contracts, S15-S21 loop-observability and
interaction-identity contracts, plus S22 agentic canonical retrieval transcript
coverage. Run this as part of final acceptance:

```sh
if rg -n "test\\.todo|todo\\(" test/scenarios; then
  echo "Scenario placeholders remain"
  exit 1
fi
```

It should produce no matches and exit 0.
