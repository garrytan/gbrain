# Phase 4 Scope Gate Implementation Plan

1. Add failing tests for scope-gate service, operation, and benchmark coverage.
2. Add standalone scope-gate types and a deterministic service that resolves
   `work`, `personal`, `mixed`, or `unknown`.
3. Expose the service through a new shared operation with CLI help.
4. Publish a `phase4-scope-gate` benchmark and package script.
5. Document the verification commands in `docs/MBRAIN_VERIFY.md`.
6. Run targeted tests and benchmark, then broader regression if operation
   wiring changes.
