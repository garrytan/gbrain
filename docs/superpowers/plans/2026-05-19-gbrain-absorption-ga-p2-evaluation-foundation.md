# GBrain Absorption GA-P2 Evaluation Foundation Plan

**Goal:** Implement the `GA-P2` roadmap slice as an evaluation foundation only:
add replay-shaped fixtures, focused scenario coverage, and verification docs so
future retrieval, candidate, task-resume, scope, and derived-refresh changes can
be measured before and after a patch.

**Scope:** Do not implement `GA-P3` corpus lanes, `GA-P4` authority-model
changes, `GA-P6` maintenance automation, or new production services. Reuse the
existing SQLite-capable retrieval, Memory Inbox, task resume, Scope Gate, and
context-map freshness surfaces.

## Owned Files

- `docs/superpowers/plans/2026-05-19-gbrain-absorption-ga-p2-evaluation-foundation.md`
- `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- `docs/MBRAIN_VERIFY.md`
- `test/fixtures/gbrain-absorption/ga-p2-evaluation-foundation.fixture.json`
- `test/scenarios/s27-gbrain-evaluation-foundation.test.ts`
- `test/scenarios/README.md`

## Contract

The GA-P2 fixture must include one replay case per required regression family:

- retrieval regression
- candidate lifecycle regression
- task resume fidelity
- scope leak regression
- derived refresh regression

Each replay case must name the existing verification surface it exercises and
the authority boundary it preserves. Candidate and derived outputs are pointers
or historical orientation unless canonical evidence is read through
`read_context`.

## Test-First Steps

- [x] Add a docs contract assertion and S27 scenario that fail while GA-P2 docs,
  runbook text, fixture, and scenario registration are absent or incomplete.
- [x] Add `ga-p2-evaluation-foundation.fixture.json` with the five replay
  families and the focused verification command.
- [x] Add S27 coverage that runs one real SQLite flow per family using existing
  services and operations.
- [x] Update the evaluation contract, verification runbook, and scenario README
  with the minimal GA-P2 mapping.

## Verification

Run only the focused GA-P2 checks for this slice:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s27-gbrain-evaluation-foundation.test.ts
```

Expected: all docs contract assertions pass, the S27 replay fixture is registered,
and each required regression family runs through existing SQLite surfaces.
