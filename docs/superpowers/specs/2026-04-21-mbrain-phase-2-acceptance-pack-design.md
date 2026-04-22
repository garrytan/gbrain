# MBrain Phase 2 Acceptance Pack Design

## Context

Phase 2 now spans:

- note manifest
- note sections
- structural paths
- context map persistence and stale-aware reads
- context atlas registry, selection, overview, and report
- workspace and atlas orientation cards and bundles

Each slice already has its own verification and benchmark entrypoint. The gap is
that Phase 2 still lacks one phase-level acceptance pack that can be run as a
single check before merge or rollout.

## Recommendation

Add one additive `Phase 2 acceptance pack`.

This slice should:

- define one `test:phase2` umbrella script
- define one `bench:phase2-acceptance` summary runner
- summarize the status of all Phase 2 benchmark scripts in one JSON report

This slice should not:

- change Phase 2 runtime behavior
- introduce new storage or schema
- reinterpret per-slice benchmark thresholds
- replace the existing per-slice verification commands

## Scope

This slice includes:

- one phase-level benchmark summary script
- one shared test umbrella script
- one benchmark-shape test for the acceptance pack
- verification doc updates for the new phase-level commands

This slice excludes:

- new product commands
- any new map, atlas, or memory behavior
- benchmark threshold changes
- CI workflow changes

## Acceptance Pack Contract

The pack should expose:

- `bun run test:phase2`
- `bun run bench:phase2-acceptance --json`

The benchmark summary output should include:

- `generated_at`
- `engine`
- `phase`
- `benchmarks`
- `acceptance`

Each `benchmarks` entry should include:

- `name`
- `readiness_status`
- `phase2_status`

The top-level `acceptance` block should include:

- `readiness_status`
- `phase2_status`
- `summary`

## Locked Decisions

- the acceptance runner should call existing benchmark scripts instead of
  duplicating their workload logic
- the pack should fail if any Phase 2 benchmark script fails or emits a failing
  acceptance status
- the pack remains local-first and uses the same sqlite benchmark paths already
  exercised by the per-slice runners
- the test umbrella is just a stable package script over the existing Phase 2
  test files

## Query Behavior

This slice is operational rather than user-facing. It does not add retrieval
behavior or new memory semantics.

## Acceptance

This slice is accepted when:

- `bun run test:phase2` executes the full published Phase 2 test set
- `bun run bench:phase2-acceptance --json` returns a deterministic summary over
  the published Phase 2 benchmark scripts
- the summary fails when any child benchmark fails or reports a failing
  acceptance status
- the new pack does not change any existing Phase 2 benchmark thresholds

## Next Boundary

If this slice succeeds, Phase 2 can be treated as one acceptance unit and the
next work should move to Phase 3 navigation behavior, starting with a minimal
`map-explain` read path.
