# Phase 4 Personal Write Target Implementation Plan

1. Add failing service, operation, benchmark, and acceptance-pack tests for `personal_write_target`.
2. Add a deterministic preflight service that maps `profile_memory` and `personal_episode` onto the existing scope gate.
3. Add a shared `personal-write-target` operation with explicit allow, deny, and defer disclosures.
4. Publish a `phase4-personal-write-target` benchmark and add it to the Phase 4 acceptance pack.
5. Document verification commands in `docs/MBRAIN_VERIFY.md`.
6. Run targeted tests and benchmark, then `test:phase3`, `test:phase4`, and the Phase 4 acceptance pack because scope-gate behavior is shared.
