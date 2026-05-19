# GBrain Absorption GA-P6 Personal Maintenance Cycle Plan

**Goal:** Implement the `GA-P6` roadmap contract for personal maintenance as a
report-first cycle. Maintenance may surface reviewable suggestions, stale
candidate checks, duplicate merge suggestions, and derived-artifact freshness
warnings, but it must not gain a shortcut to canonical truth.

**Scope:** Do not add scheduler runtime or direct canonical mutation paths in
this slice. GA-P6 extends the existing dream-cycle maintenance service with a
report-only derived freshness scan and an explicit apply-control-plane summary,
then proves the behavior through an S31 scenario. Apply remains delegated to the
existing memory operations control plane.

## Owned Files

- `docs/superpowers/plans/2026-05-19-gbrain-absorption-ga-p6-personal-maintenance-cycle.md`
- `src/core/services/dream-cycle-maintenance-service.ts`
- `src/core/operations-memory-inbox.ts`
- `test/dream-cycle-maintenance-service.test.ts`
- `test/dream-cycle-maintenance-operations.test.ts`
- `test/fixtures/gbrain-absorption/ga-p6-personal-maintenance-cycle.fixture.json`
- `test/scenarios/s31-gbrain-personal-maintenance-cycle.test.ts`
- `test/gbrain-absorption-docs-contract.test.ts`
- `test/scenarios/README.md`
- `docs/architecture/redesign/06-workstream-governance-and-inbox.md`
- `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- `docs/MBRAIN_VERIFY.md`

## Contract

- Maintenance defaults to report and suggestion output.
- Dry-run output must show the same target, policy, scope, snapshot, and
  redaction validation that apply would use.
- Apply is optional and must go through the existing memory operations control
  plane with an active realm/session, mutation ledger event, target snapshot,
  and source refs.
- Candidate writes remain governed candidate state, not compiled truth.
- Redaction and sensitive maintenance checks fail closed.
- Derived freshness reports expose stale context-map artifacts as orientation,
  not answer authority.

## Test-First Steps

- [ ] Add GA-P6 docs-contract anchors for governance, evaluation, and
  verification docs.
- [ ] Add `ga-p6-personal-maintenance-cycle.fixture.json` with report cases and
  apply-control cases.
- [ ] Extend `runDreamCycleMaintenance` with `authority`,
  `canonical_write_allowed`, `maintenance_phases`,
  `derived_freshness_report`, and `apply_control_plane` output.
- [ ] Expose `include_derived_freshness` on `run_dream_cycle_maintenance`.
- [ ] Add S31 to replay report/suggestion output, candidate-only writes,
  derived freshness, and Phase 9 control-plane guards.
- [ ] Register S31 in the scenario README as green.
- [ ] Run the focused service, docs, and scenario checks.

## Verification

Run the focused GA-P6 check:

```bash
bun test test/dream-cycle-maintenance-service.test.ts test/dream-cycle-maintenance-operations.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s31-gbrain-personal-maintenance-cycle.test.ts
```

Expected: dream-cycle output remains report/candidate-only, S31 proves
maintenance cannot mutate canonical truth directly, and the GA-P6 fixture/docs
anchors stay aligned.

Then run:

```bash
bun run test:phase8
bun run test:phase9
bun run test:scenarios
bunx tsc --noEmit --pretty false
```
