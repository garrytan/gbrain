# GA-P7 Consolidation And Upstream Discipline

## Goal

Consolidate the GA-P2 through GA-P6 gbrain absorption slices into a durable
upstream-discipline checkpoint without changing production runtime behavior.

GA-P7 is accepted only when docs, fixtures, and executable scenario coverage
agree on what was adopted, reinterpreted, rejected, and deferred from the
reference gbrain work.

## Scope

- Add a GA-P7 upstream-discipline checkpoint to `docs/UPSTREAM_SYNC.md`.
- Add GA-P7 acceptance rules to the redesign evaluation owner.
- Add GA-P7 verification commands to `docs/MBRAIN_VERIFY.md`.
- Add a deterministic fixture and scenario test that check docs and fixture
  alignment.
- Register S32 as green in the scenario registry.

## Non-Goals

- No new runtime services.
- No database, network, or hosted upstream dependency.
- No direct port of upstream HTTP MCP, OAuth, Minions, hosted jobs, or storage
  flows.
- No reclassification of GA-P2 through GA-P6 acceptance beyond documenting the
  current implementation state.

## Acceptance Anchors

- `docs/UPSTREAM_SYNC.md` contains
  `## Roadmap 2026-05-19 - GA-P7 consolidation and upstream discipline checkpoint`.
- `docs/architecture/redesign/08-evaluation-and-acceptance.md` contains
  `## GBrain Absorption GA-P7 Consolidation And Upstream Discipline`.
- `docs/MBRAIN_VERIFY.md` contains
  `## GBrain Absorption GA-P7 Verification`.
- `test/scenarios/README.md` registers S32 as green.
- `test/fixtures/gbrain-absorption/ga-p7-upstream-discipline.fixture.json`
  uses `stage_id: "GA-P7"` and includes the required consolidation cases.
- `test/scenarios/s32-gbrain-upstream-discipline.test.ts` pattern-matches the
  existing S26-S31 scenario style and stays deterministic.

## Verification

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s32-gbrain-upstream-discipline.test.ts
bun run test:scenarios
bunx tsc --noEmit --pretty false
git diff --check
```

Expected: all commands pass, with no production runtime files changed.
