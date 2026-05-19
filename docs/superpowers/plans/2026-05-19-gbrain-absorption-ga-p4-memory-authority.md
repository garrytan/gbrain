# GBrain Absorption GA-P4 Memory Authority Plan

**Goal:** Implement the `GA-P4` roadmap slice as an authority-stage contract,
not a new memory subsystem. MBrain should be able to explain whether a signal or
artifact is compiled truth, profile memory, personal episode, historical
evidence, candidate-only, derived orientation, operational memory, or outside
durable memory.

**Scope:** Do not port upstream `facts` / `takes` tables. Do not weaken
`read_context` as the canonical evidence boundary. Do not route operational
continuity or personal canonical writes through Memory Inbox when direct domain
operations already own those homes.

## Owned Files

- `docs/superpowers/plans/2026-05-19-gbrain-absorption-ga-p4-memory-authority.md`
- `src/core/types.ts`
- `src/core/services/memory-activation-policy-service.ts`
- `src/core/services/scenario-memory-request-planner-service.ts`
- `test/memory-activation-policy-service.test.ts`
- `test/fixtures/gbrain-absorption/ga-p4-memory-authority.fixture.json`
- `test/scenarios/s28-gbrain-memory-authority.test.ts`
- `test/gbrain-absorption-docs-contract.test.ts`
- `test/scenarios/README.md`
- `docs/architecture/redesign/02-memory-loop-and-protocols.md`
- `docs/architecture/redesign/06-workstream-governance-and-inbox.md`
- `docs/architecture/redesign/07-workstream-profile-memory-and-scope.md`
- `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- `docs/MBRAIN_VERIFY.md`

## Contract

- Candidate signals are visible discovery aids, never answer-grounding evidence.
- Profile Memory and Personal Episodes require explicit scope allow and report
  their own authority, not generic compiled truth.
- Source Records and timelines are durable historical evidence but not current
  synthesis by themselves.
- Context maps, codemap pointers, and replay projections are derived
  orientation; every projection must name a canonical source and rebuild path.
- Page-backed canonical writes require provenance, allowed evidence kind,
  target type, target id, sensitivity, and target snapshot hash.
- Personal writes and operational continuity use their direct domain operations
  instead of being forced through Memory Inbox.

## Test-First Steps

- [ ] Add activation-policy assertions for explicit profile and personal
  authorities.
- [ ] Add an S28 replay fixture covering compiled truth, profile memory,
  personal episode, historical evidence, candidate-only, derived orientation,
  canonical snapshot guard, personal scope guard, and operational direct path.
- [ ] Add scenario coverage that exercises existing services and operation
  surfaces without introducing Postgres-only behavior.
- [ ] Update the architecture docs, scenario README, and verification runbook so
  the GA-P4 boundary is reviewable before later GA-P3 / GA-P5 behavior.

## Verification

Run the focused GA-P4 checks first:

```bash
bun test test/memory-activation-policy-service.test.ts test/memory-writeback-router-service.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s28-gbrain-memory-authority.test.ts
bun test test/scenario-memory-orchestration-operations.test.ts
bun run test:scenarios
```

Expected: personal artifacts no longer report `canonical_compiled_truth`,
candidate and derived artifacts remain non-canonical, direct canonical writes
remain snapshot-gated, and personal/operational write homes stay domain-owned.
