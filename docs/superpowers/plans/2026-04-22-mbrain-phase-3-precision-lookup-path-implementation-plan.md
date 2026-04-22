# Phase 3 Precision Lookup Path Implementation Plan

1. Add failing tests for exact page-path and anchored section-path lookup in service, operation, and selector coverage.
2. Keep the existing `path` surface and interpret `path#section/path` as an exact section artifact request.
3. Reuse paginated manifest and section reads to resolve exact page or section targets without adding engine-level path filters.
4. Update precision and selector benchmarks to assert both page-path and section-path cases.
5. Run targeted tests, benchmarks, then shared regressions.
