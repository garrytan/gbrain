# MBrain Postgres Runtime Status

Date: 2026-05-31
Status: Post-merge implementation snapshot

## Purpose

This snapshot reconciles the 2026-05-20 Postgres runtime phase plan with the
current repository after the ChatGPT Developer Mode validation and MCP descriptor
hardening merge.

It is not a replacement implementation plan. Use it to avoid rebuilding already
landed slices and to choose the next phase from current evidence.

## Overall Result

- The original P0 gap for live ChatGPT Developer Mode validation is closed.
- `mbrain serve --http --oauth` has live OAuth/DCR/PKCE evidence against
  ChatGPT and real Postgres.
- HTTP MCP now serves full tool descriptors for ChatGPT action discovery while
  stdio remains compact.
- Phase 14 now has a real Postgres runtime confidence smoke for the final
  migration cleanup gate.
- No open PR remains for the runtime-confidence branch.

## Phase Status

| Phase | Status | Current evidence | Remaining work |
|---|---|---|---|
| 00 Postgres Foundation | Implemented | `src/core/postgres-runtime/connection-profile.ts`, `test/postgres-runtime-foundation.test.ts`, `docs/MBRAIN_VERIFY.md` | Keep release docs synced when target-runtime defaults change. |
| 01 Source Registry And Policy | Implemented | `src/core/source-registry/source-policy.ts`, `src/core/services/source-registry-service.ts`, `src/core/operations-source-registry.ts`, `test/source-registry-policy-service.test.ts`, `test/source-registry-operations.test.ts` | Add new source kinds only through policy tests. |
| 02 Raw Ingest And Provenance | Implemented | `src/core/source-registry/raw-ingest.ts`, `src/core/source-registry/raw-access-ledger.ts`, `test/raw-ingest-provenance-service.test.ts`, `test/raw-access-ledger-service.test.ts` | Keep raw text untrusted and scoped for future connectors. |
| 03 Assertion Pipeline | Implemented | `src/core/assertions/`, `src/core/services/assertion-pipeline-service.ts`, `test/assertion-pipeline-service.test.ts`, `test/assertion-resolution.test.ts`, `test/assertion-evidence-service.test.ts`, `test/assertion-operations*.test.ts` | Broaden real-source extraction fixtures as connectors land. |
| 04 Governed Canonical Write | Implemented | `src/core/canonical-write/`, `src/core/services/governed-canonical-write-service.ts`, `test/governed-canonical-write-service.test.ts` | Keep every new canonical mutation routed through policy. |
| 05 Maintenance Runtime | Implemented | `src/core/maintenance/job-runtime.ts`, `src/core/services/maintenance-runtime-service.ts`, `test/maintenance-runtime-service.test.ts`, `test/maintenance-runtime-db-adapter.test.ts`, `test/maintenance-runtime-schema.test.ts` | Watch queue/backpressure behavior under longer real workloads. |
| 06 Autopilot Daemon | Implemented | `src/core/maintenance/autopilot.ts`, `src/commands/autopilot.ts`, `test/autopilot-service.test.ts`, `test/dream-cli-autopilot.test.ts`, CLI surface in `src/cli.ts` | Keep platform-specific scheduling behavior covered when launch profiles change. |
| 07 Dream Cycle | Implemented | `src/core/maintenance/dream-cycle.ts`, `src/core/services/dream-cycle-runner-service.ts`, `src/core/services/dream-cycle-maintenance-service.ts`, `test/dream-cycle-runner-service.test.ts`, `test/dream-cycle-maintenance-service.test.ts`, `test/dream-cli-autopilot.test.ts`, `test/phase8-dream-cycle.test.ts` | Expand phase families only with report and unavailable-family coverage. |
| 08 Lifecycle Forgetting | Implemented | `src/core/maintenance/lifecycle-forgetting.ts`, `src/core/services/lifecycle-forgetting-service.ts`, `src/core/operations-lifecycle-forgetting.ts`, `test/lifecycle-forgetting-*.test.ts`, `test/phase8-longitudinal-evaluation.test.ts` | Continue adding policy cases as new source kinds and connectors appear. |
| 09 Restricted Runner | Implemented | `src/core/runners/`, `src/core/services/restricted-runner-service.ts`, `test/restricted-runner-service.test.ts`, `test/restricted-runner-policy.test.ts`, `test/restricted-runner-postgres.test.ts` | Provider-backed/live runner execution remains environment-gated; keep deterministic fallback coverage green without API keys. |
| 10 System Of Record Reconciler | Implemented | `src/core/reconciler/`, `src/core/services/system-of-record-reconciler-service.ts`, `test/system-of-record-reconciler-service.test.ts`, `test/markdown-projection-contracts.test.ts` | Add more real Markdown drift fixtures as projection targets expand. |
| 11 Personal Data Connectors | Implemented | `src/core/connectors/`, `src/core/services/personal-data-connector-service.ts`, `test/personal-data-connector-service.test.ts`, `test/credential-refs-service.test.ts` | Real external adapters should continue landing behind source policy and credential-ref tests. |
| 12 Review, Audit, And Health | Implemented | `src/core/services/memory-review-report-service.ts`, `src/commands/memory-report.ts`, `test/memory-review-report-service.test.ts`, `test/memory-operations-health-*.test.ts`, `test/doctor.test.ts`, audit surfaces in `src/core/operations-assertions.ts` | Keep report actions routed through governed operations as new action kinds appear. |
| 13 Evaluation And Replay | Implemented for deterministic replay | `src/core/evaluation/memory-replay.ts`, `src/core/evaluation/memory-eval-cases.ts`, `test/memory-replay-service.test.ts`, `bun run test:phase13` | Live LLM eval remains provider-key-gated and must not be claimed without credentials. |
| 14 Migration And Cleanup | Implemented | `test/postgres-runtime-migration-cleanup.test.ts`, README/agent-rule/verify cleanup coverage, `src/commands/migrate-engine.ts`, `scripts/smoke-test-postgres-runtime.ts`, `bun run smoke:postgres-runtime` | Keep the smoke pointed at disposable Postgres targets and report provider-key-gated Tier 2 work separately. |

## Current Next Phase

The original 00-14 Postgres runtime plan is implemented at the repository level.
The next safest work is release integration and operating discipline:

1. Run `bun run smoke:postgres-runtime` against a disposable real Postgres
   target during release verification.
2. Keep `bun run test:phase13`, `mbrain doctor --json`, and descriptor/OAuth
   smoke evidence distinct from provider-key-dependent Tier 2 skill tests.
3. Only claim live LLM eval or provider-backed skills when the required
   credentials exist and those gates actually run.

This is not a new feature phase. It is the acceptance and release hygiene layer
around the now-implemented runtime plan.

## Verification Pointers

Focused post-merge documentation and descriptor checks:

```bash
bun test test/mcp-tool-schema.test.ts test/mcp-http-transport.test.ts test/mcp-stdio-frame-budget.test.ts test/mcp-response-guard.test.ts
DATABASE_URL='postgresql://...' bun run smoke:postgres-runtime
bun run test:phase13
bunx tsc --noEmit --pretty false
```

Full pre-ship gates still remain:

```bash
bun test
bun run test:e2e
```

Tier 2 skill tests require provider credentials and should be reported as skipped
when `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are intentionally absent.
