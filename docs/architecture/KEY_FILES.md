# Key files — per-file index (gbrain repo)

Read a file's entry before editing it. This page routes to bounded subsystem
references; **do not load every file in the directory**. Entries retain the
implementation evidence and test references from the former single-file index.

Find a specific path locally, then read that entry and its surrounding contract:

```bash
rg -n -F 'src/core/ops/pages.ts' docs/architecture/key-files/
```

The ranges below use the first path in each entry; grouped entries can document
several related files. Search is the fallback when a path crosses subsystems.
Edit the subsystem entry, not this routing page, when behavior changes.
Keep entries current-state: release history belongs in `CHANGELOG.md` and Git.
Where a new storage method, migration, doctor check, command, route or sync
phase goes: [CONTRIBUTING.md](../../CONTRIBUTING.md#where-does-my-change-go).
A branch written before refactor wave 1 follows the generated
[porting guide](wave-1-porting.md) ([JSON map](wave-1-moves.json)).
`scripts/check-key-files-current-state.sh` checks every subsystem for history,
duplicate file entries, and size growth. Split a growing subsystem at a useful
boundary and add its link here rather than raising the cap.

| Subsystem | Entry range / scope |
|---|---|
| [Page identity and writer administration](key-files/page-identity-and-administration.md) | Opaque result IDs, current grants, state-bound ownership changes |
| [Canonical reconciliation](key-files/canonical-reconciliation.md) | Exact-page repair, private retained originals, derived atom state and receipt diagnostics |
| [Company-brain ingestion](key-files/company-brain.md) | Inspection, admission, receipts, derived relationships and schema; [operator guide](../guides/company-brain-ingestion.md) |
| [Agent operator contract](key-files/agent-contract.md) | `agent-output.ts`, error registry + docs, notice ledger, `isCallable`, `--json` guard, contract scanner |
| [Commands (1/6)](key-files/commands-1.md) | `src/commands/agent-logs.ts` through `src/commands/db-repair.ts` |
| [Commands (2/6)](key-files/commands-2.md) | `src/commands/doctor.ts` and `src/commands/doctor/` |
| [Commands (2/6, continued)](key-files/commands-2-continued.md) | `src/commands/dream-retriage.ts` through `src/commands/embed.ts` |
| [Commands (3/6)](key-files/commands-3.md) | `src/commands/engine-status.ts` through `src/commands/frontmatter-install-hook.ts` |
| [Commands (4/6)](key-files/commands-4.md) | `src/commands/frontmatter.ts` through `src/commands/pglite-repair.ts` |
| [Commands (4/6, continued)](key-files/commands-4-continued.md) | `src/commands/protocol.ts` through `src/commands/reindex-search-vector.ts`, `init-mode-picker.ts`, `src/core/embedding-migration-cli.ts` |
| [Commands (5/6)](key-files/commands-5.md) | `src/commands/reindex.ts` through `src/commands/storage.ts` |
| [Commands (6/6)](key-files/commands-6.md) | `src/commands/sync.ts` through `src/commands/whoknows.ts` |
| [Core Ai](key-files/core-ai.md) | `src/core/ai/build-gateway-config.ts` through `src/core/ai/types.ts` |
| [Core Decide](key-files/core-decide.md) | `src/core/ai/decide/*`, `src/core/search/decide-stage.ts`, `gbrain decide`, `decide_health` (System One) |
| [Core Cycle](key-files/core-cycle.md) | `src/core/cycle/anomaly.ts` through `src/core/cycle/phase-table.ts`: atoms, facts, drains, probes, phase scope |
| [Core Cycle (continued)](key-files/core-cycle-continued.md) | `src/core/cycle/` synthesis, patterns, consolidation, concept publication and `connector-atoms.ts` |
| [Core Minions (1/2)](key-files/core-minions-1.md) | `src/core/minions/` through `src/core/minions/rss-default.ts` |
| [Core Minions (2/2)](key-files/core-minions-2.md) | `src/core/minions/run-child.ts` through `src/core/minions/worker.ts` |
| [Core Persistence](key-files/core-persistence.md) | `src/core/persistence/` write journal, coordinator, effects, canonical projections and managed sync |
| [Core Persistence (continued)](key-files/core-persistence-continued.md) | `src/core/persistence/connector-*.ts`, `src/core/connectors/item-holds*.ts`, checkpoint validation, no-op kernel, accepted-pending receipts, verb types/errors, database-write, attribution, purge-deleted and loop-fact retirement |
| [Core Persistence (engine graduation)](key-files/core-persistence-graduation.md) | `engine-graduation*.ts`, `graduation-*.ts`, `src/commands/migrate-graduation.ts`, the graduation doctor finding |
| [Managed sync and persistence stalls (key files cluster)](key-files/persistence-stalls.md) | `claim-phase.ts`, `pre-activation-release.ts`, `sync-concurrent-write.ts`, `worktree-manifest.ts`, `src/core/hardened-git.ts` |
| [Core Search (1/2)](key-files/core-search-1.md) | `src/core/search/` through `src/core/search/rerank.ts` |
| [Core Search (2/2)](key-files/core-search-2.md) | `src/core/search/return-policy.ts` through `src/core/search/vector-pool.ts`, the relational arm and multi-hop chain modules, `hub-dampening.ts` |
| [Core Services (1/3)](key-files/core-services-1.md) | `src/core/advisor/{types,run,render,recommended-set,history,apply,collect-*}.ts` through `src/core/connectors/` |
| [Core Services (1/3, continued)](key-files/core-services-1-continued.md) | `src/core/context/` through `src/core/context/ipc-path.ts` |
| [Core Services (2/3)](key-files/core-services-2.md) | `src/core/conversation-parser/` through `src/core/progressive-batch/`, except `src/core/persistence/` |
| [Core Services (3/3)](key-files/core-services-3.md) | `src/core/think/index.ts` through `src/core/verbs/usage-log.ts` |
| [Core Utilities (1/2)](key-files/core-utilities-1.md) | `src/core/archive-crawler-config.ts` through `src/core/remediation-checkpoint.ts` |
| [Core Utilities (2/2)](key-files/core-utilities-2.md) | `src/core/repair/` through `src/core/verbs.ts` |
| [Engines (1/2)](key-files/engines-1.md) | `src/core/connection-manager.ts` through `src/core/pglite-repair.ts` |
| [Engines (2/2)](key-files/engines-2.md) | `src/core/pglite-resetwal.ts` through `src/core/worker-pool.ts` |
| [Entrypoints And Docs](key-files/entrypoints-and-docs.md) | `.agents/gbrain-launcher` through `templates/` |
| [Evaluation](key-files/evaluation.md) | `evals/brainbench/` through `src/eval/shared/judge-runner.ts` |
| [Files And Sync (1/2)](key-files/files-and-sync-1.md) | `src/core/audit-week-file.ts` through `src/core/sync-git.ts:resolveSlugByPathOrSourcePath` |
| [Files And Sync (2/2)](key-files/files-and-sync-2.md) | `src/core/sync-policy.ts` through `src/core/write-through.ts` |
| [Graph And Facts](key-files/graph-and-facts.md) | `src/core/check-resolvable.ts` through `src/core/trajectory-format.ts` |
| [Entity recall](key-files/entity-recall.md) | `src/core/mentions/*`, `src/core/ops/backlinks-paged.ts`, `extract mentions --explain`, migration v206 |
| [Mcp](key-files/mcp.md) | `src/mcp/dispatch.ts` through `src/mcp/validate-params.ts` |
| [Providers](key-files/providers.md) | `src/core/anthropic-pricing.ts` through `src/core/transcription.ts` |
| [Runtime](key-files/runtime.md) | `src/core/abort-check.ts` through `src/core/zombie-reap.ts` |
| [Security](key-files/security.md) | `src/core/destructive-guard.ts` through `src/core/ssrf-validate.ts` |
| [Shared brain skills](key-files/shared-skills.md) | Canonical catalog, enrollment, migration, publication and harness integration |
| [Skills](key-files/skills.md) | `src/core/audit-skill-brain-first.ts` through `src/core/skills-integrity.ts` |
| [Tooling And Tests](key-files/tooling-and-tests.md) | `.github/workflows/test.yml` through `test/remote-privacy-sweep.test.ts` |
| [CI Health And Test Guards](key-files/ci-health-and-test-guards.md) | `.github/workflows/nightly-watch.yml` through `scripts/check-image-decoders-embedded.sh`, plus the contributor audit and the fix-wave gate |
| [BrainBench — in a sibling repo](key-files/brainbench.md) | Cross-file subsystem contract |
| [Hindsight calibration (key files cluster)](key-files/hindsight.md) | Cross-file subsystem contract |
| [Schema packs: mutation surface (key files cluster)](key-files/schema-mutation.md) | Cross-file subsystem contract |
| [Agent bootstrap cluster (the paste-in desktop-agent install)](key-files/agent-bootstrap.md) | Cross-file subsystem contract |
| [Agent Bootstrap (continued)](key-files/agent-bootstrap-continued.md) | Remaining cross-file entries |
| [Google connector + open-loop engine (key files cluster)](key-files/google-and-loops.md) | Cross-file subsystem contract |
| [Google And Loops (continued)](key-files/google-and-loops-continued.md) | Remaining cross-file entries |
| [Always-loaded core memory (key files cluster)](key-files/core-memory.md) | Core tier, write-path guard and lock order, delivery lanes, pressure notice |
| [Workspace push and backup coverage (key files cluster)](key-files/workspace-push-and-backup.md) | Workspace push, hook push backstops, backup verdicts |
| [Ambient capture consent gate (key files cluster)](key-files/ambient-capture.md) | `memory.auto_writeback` capture lanes |
| [Quarantine (cluster)](key-files/quarantine.md) | Gate-marker strip; quarantined pages in facts, reads, writes |

## BrainBench — in a sibling repo

See [BrainBench — in a sibling repo](key-files/brainbench.md).

## Hindsight calibration (key files cluster)

See [Hindsight calibration (key files cluster)](key-files/hindsight.md).

## Schema packs: mutation surface (key files cluster)

See [Schema packs: mutation surface (key files cluster)](key-files/schema-mutation.md).

## Agent bootstrap cluster (the paste-in desktop-agent install)

See [Agent bootstrap cluster (the paste-in desktop-agent install)](key-files/agent-bootstrap.md).

## Google connector + open-loop engine (key files cluster)

See [Google connector + open-loop engine (key files cluster)](key-files/google-and-loops.md).

## Always-loaded core memory (key files cluster)

See [Always-loaded core memory (key files cluster)](key-files/core-memory.md).
