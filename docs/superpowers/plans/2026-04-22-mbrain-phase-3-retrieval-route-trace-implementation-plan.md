# Phase 3 Retrieval Route Trace Implementation Plan

1. Add selector input/output fields for explicit trace persistence.
2. Add failing tests for service, operation, and benchmark shape.
3. Implement trace persistence inside the selector service using task scope.
4. Extend the `retrieval-route` operation to expose `persist_trace`.
5. Add benchmark and verification coverage.
6. Run targeted tests, benchmark, then shared regressions.
