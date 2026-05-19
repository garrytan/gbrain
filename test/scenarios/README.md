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
| S23 | `s23-duplicate-review-governance.test.ts` | G1, L6 | ✅ green |
| S24 | `s24-duplicate-review-acceptance.test.ts` | G1, G2, L6 | ✅ green |
| S25 | `s25-memory-consolidation-retention.test.ts` | L5/L6/G1 | ✅ green |
| S26 | `s26-gbrain-absorption-contracts.test.ts` | GA-P0, GA-P1, I4, I5, L4, L6, G1 | ✅ green |
| S27 | `s27-gbrain-evaluation-foundation.test.ts` | GA-P2, E1, L5, L6, L7, G1 | ✅ green |
| S28 | `s28-gbrain-memory-authority.test.ts` | GA-P4, L4, L5, L6, G1 | ✅ green |
| S29 | `s29-gbrain-corpus-lanes.test.ts` | GA-P3, I5, L6, G1 | ✅ green |
| S30 | `s30-gbrain-code-lane.test.ts` | GA-P5, L4, L6, E1 | ✅ green |
| S31 | `s31-gbrain-personal-maintenance-cycle.test.ts` | GA-P6, G1, G2, L5, L6 | ✅ green |
| S32 | `s32-gbrain-upstream-discipline.test.ts` | GA-P7, E1, L4, L6, G1 | ✅ green |

Legend:
- ✅ green = passes on current code

The redesign scenario suite currently has zero placeholder tests. It covers the
original S1-S14 redesign contracts, S15-S21 loop-observability and
interaction-identity contracts, S22 agentic canonical retrieval transcript
coverage, S23 duplicate review governance coverage, plus S24 duplicate review
acceptance coverage, S25 memory consolidation retention coverage, S26
GBrain absorption contract coverage, S27 GA-P2 evaluation foundation, and S28
GA-P4 memory authority, S29 GA-P3 corpus lane provenance coverage, S30
GA-P5 code lane derived-orientation coverage, and S31 GA-P6 personal
maintenance cycle report/control-plane coverage, and S32 GA-P7 consolidation
and upstream-discipline coverage. Run this as
part of final acceptance:

```sh
if rg -n "test\\.todo|todo\\(" test/scenarios; then
  echo "Scenario placeholders remain"
  exit 1
fi
```

It should produce no matches and exit 0.
