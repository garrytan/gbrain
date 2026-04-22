# Phase 3 Acceptance Pack Implementation Plan

1. Add a failing test for `scripts/bench/phase3-acceptance-pack.ts`.
2. Create the acceptance-pack script by adapting the Phase 2 pack to the
   published Phase 3 benchmarks.
3. Add `bench:phase3-acceptance` and `test:phase3` package scripts.
4. Document the phase-level verification commands in `docs/MBRAIN_VERIFY.md`.
5. Run the new test, the acceptance benchmark, then `bun run test:phase3`.
