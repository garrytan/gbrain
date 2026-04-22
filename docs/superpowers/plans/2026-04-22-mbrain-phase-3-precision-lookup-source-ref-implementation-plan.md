# Phase 3 Precision Lookup Source Ref Implementation Plan

1. Add failing tests for exact `source_ref` lookup in service, operation, and selector coverage.
2. Extend precision lookup inputs with `source_ref`.
3. Reuse existing paginated section and manifest reads to resolve a unique exact citation, preferring section matches over page matches.
4. Degrade explicitly when the citation is missing or ambiguous.
5. Update precision and selector benchmarks to cover the `source_ref` case.
6. Run targeted tests, benchmarks, then shared regressions.
