# CoE Lite deferred implementation questions

The following choices are intentionally deferred and do not alter the frozen v1 contract:

- which filesystem/object adapter and atomic-write primitive will implement the canonical registry;
- projection table layout, indexes, and event-cursor representation for each database backend;
- operational retention periods and the authorized hard-deletion workflow;
- concrete verifier implementations and policy thresholds beyond the fail-closed baseline;
- retrieval/reranking implementations and evaluation datasets;
- reviewer groups and escalation timing for human review.

Each choice belongs to a later gate. If an implementation cannot honor a frozen invariant, the
contract gate must be reopened through a new ADR and version decision rather than relaxed silently.
