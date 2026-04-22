# Phase 4 Safe Personal Writes Implementation Plan

1. Add failing operation tests for scope-gated profile-memory and personal-episode writes.
2. Add safe wrapper operations that call `personal_write_target` before invoking canonical writes.
3. Return deterministic blocking errors when preflight denies or defers the write.
4. Document verification commands in `docs/MBRAIN_VERIFY.md`.
5. Run the new operation test and `test:phase4`.
