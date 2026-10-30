# Key files — per-file index (gbrain repo)

Read a file's entry before editing it. This page routes to bounded subsystem
references; **do not load the whole directory**.

Find a path's entry:

```bash
rg -n -F 'src/core/ops/pages.ts' docs/architecture/key-files/
```

Ranges use each entry's first path; an entry can document several
files. Search when a path crosses subsystems.
Edit the subsystem entry, not this page, when behavior changes.
Keep entries current-state: history belongs in `CHANGELOG.md` and Git.
Where a new storage method, migration, doctor check, command, route or sync
phase goes: [CONTRIBUTING.md](../../CONTRIBUTING.md#where-does-my-change-go).
A branch from before refactor wave 1 follows the generated
[porting guide](wave-1-porting.md) ([JSON map](wave-1-moves.json)).
`scripts/check-key-files-current-state.sh` guards each subsystem against
history, duplicate entries and size growth. Split a growing subsystem and
link it here rather than raising the cap.

| Subsystem | Entry range / scope |
|---|---|
| [Page identity and writer administration](key-files/page-identity-and-administration.md) | Opaque result IDs, current grants, state-bound ownership changes |
| [Canonical reconciliation](key-files/canonical-reconciliation.md) | Exact-page repair, retained originals, [derived generations](key-files/generations.md), sync discovery and the origin rule (`sync-origin.ts`, `file-claims.ts`) |
| [Company-brain ingestion](key-files/company-brain.md) | Inspection, admission, receipts, derived relationships and schema; [operator guide](../guides/company-brain-ingestion.md) |
| [Agent operator contract](key-files/agent-contract.md) | `agent-output.ts`, error registry + docs, notice ledger, `isCallable`, `--json` guard, contract scanner |
| [Commands (1/6)](key-files/commands-1.md) | `src/commands/agent-logs.ts` through `src/commands/db-repair.ts` |
| [Commands (2/6)](key-files/commands-2.md) | `src/commands/doctor.ts` and `src/commands/doctor/` |
| [Commands (2/6, continued)](key-files/commands-2-continued.md) | `doctor/checks/routing-federation.ts`, `git-convergence.ts`, `keyword-plan.ts`, `dream-retriage.ts` to `embed.ts` |
| [Commands (3/6)](key-files/commands-3.md) | `src/commands/engine-status.ts` through `src/commands/extract.ts` |
| [Commands (3/6, continued)](key-files/commands-3-continued.md) | `src/commands/extract-timeline-db.ts` through `src/commands/frontmatter-install-hook.ts` |
| [Commands (4/6)](key-files/commands-4.md) | `src/commands/frontmatter.ts` through `pages-status.ts` |
| [Commands (4/6, continued)](key-files/commands-4-continued.md) | `persistence-admin.ts` to `reindex-search-vector.ts`, `init-mode-picker.ts`, `core/embedding-migration-cli.ts` |
| [Commands (5/6)](key-files/commands-5.md) | `src/commands/reindex.ts` through `src/commands/storage.ts` |
| [Commands (6/6)](key-files/commands-6.md) | `src/commands/sync.ts` through `src/commands/whoknows.ts` |
| [Core Ai](key-files/core-ai.md) | `src/core/ai/` gateway, embedding, dims, errors, fallbacks |
| [Core Ai (continued)](key-files/core-ai-continued.md) | `src/core/ai/providers/*`, `recipes/*`, `voyage-gateway.ts` |
| [Core Decide](key-files/core-decide.md) | `src/core/ai/decide/*`, `src/core/search/decide-stage.ts`, `gbrain decide`, `decide_health` (System One) |
| [Core Questions](key-files/core-questions.md) | Pinned questions: `src/core/questions/*`, `gbrain questions`, `standing_questions` |
| [Core Cycle](key-files/core-cycle.md) | `src/core/cycle/anomaly.ts` through `src/core/cycle/phase-table.ts`: atoms, facts, drains, probes, phase scope |
| [Core Cycle (continued)](key-files/core-cycle-continued.md) | synthesis postprocess |
| [Core Cycle (patterns)](key-files/core-cycle-patterns.md) | patterns, drift, synthesis |
| [Core Minions (1/2)](key-files/core-minions-1.md) | `src/core/minions/` through `src/core/minions/protected-names.ts` |
| [Core Minions (2/2)](key-files/core-minions-2.md) | `src/core/minions/queue.ts` through `src/core/minions/worker.ts` |
| [Core Persistence](key-files/core-persistence.md) | `src/core/persistence/` journal, coordinator, effects, managed sync |
| [Core Persistence (continued)](key-files/core-persistence-continued.md) | worktree-refresh*, connectors, holds, receipts; [fence repair](key-files/core-fence-repair.md) |
| [Persistence capacity](key-files/core-persistence-capacity.md) | write caps, true-up |
| [Core Persistence (seams)](key-files/core-persistence-request-indexes.md) | `checkpoint-validation`, `fault-points`, `native-file-target`, `admission-retry`, `unbound-source` |
| [Core Persistence (managed facts)](key-files/core-persistence-facts.md) | `facts-maintenance.ts`, `facts-prepare.ts`, `derived-facts.ts`, `same-page-shadow.ts` |
| [Core Persistence (engine graduation)](key-files/core-persistence-graduation.md) | `engine-graduation*.ts`, `graduation-*.ts`, `commands/migrate-graduation.ts` |
| [Managed sync and persistence stalls](key-files/persistence-stalls.md) | preparation budgets, `claim-phase.ts`, `consumer.ts`, `group-publish.ts`, `diagnostics.ts`, `worktree-manifest.ts` |
| [Managed sync bookkeeping](key-files/managed-sync-bookkeeping.md) | `sync-failures.ts`, `managed-sync-orphans.ts`, `sync-checkpoint-replaced.ts` |
| [Core Search (1/2)](key-files/core-search-1.md) | `src/core/search/` through `search/read-policy-sql.ts` |
| [Core Search (2/2)](key-files/core-search-2.md) | `search/rerank.ts` through `search/vector-pool.ts`, relational, multi-hop, `hub-dampening.ts`, `crag.ts`; [CJK](key-files/core-search-cjk.md), [evidence](key-files/core-search-evidence.md) |
| [Core Services (1/3)](key-files/core-services-1.md) | `src/core/advisor/*.ts` through `src/core/connectors/` |
| [Core Services (1/3, continued)](key-files/core-services-1-continued.md) | `src/core/context/` through `src/core/context/ipc-path.ts` |
| [Core Services (2/3)](key-files/core-services-2.md) | `src/core/conversation-parser/` through `src/core/ops/sources.ts`, except `src/core/persistence/` |
| [Core Services (2/3, continued)](key-files/core-services-2-continued.md) | `page-state/`, `page-{body,window}/`, `progressive-batch/` |
| [Commit notifier](key-files/commit-notifier.md) | `src/core/notifier/` |
| [Core Services (3/3)](key-files/core-services-3.md) | `src/core/think/index.ts` through `src/core/verbs/usage-log.ts` |
| [Core Utilities (1/2)](key-files/core-utilities-1.md) | `archive-crawler-config.ts` through `remediation-checkpoint.ts`; [`cycle.ts`](key-files/core-cycle-primitive.md) |
| [Core Utilities (2/2)](key-files/core-utilities-2.md) | `src/core/repair/` through `src/core/utils.ts` |
| [Engines (1/2)](key-files/engines-1.md) | `src/core/connection-manager.ts` through `pglite-repair.ts` |
| [Engines (2/2)](key-files/engines-2.md) | `src/core/pglite-resetwal.ts` through `worker-pool.ts` |
| [Entrypoints And Docs](key-files/entrypoints-and-docs.md) | `.agents/gbrain-launcher` through `templates/` |
| [Evaluation](key-files/evaluation.md) | `evals/brainbench/` through `src/eval/shared/judge-runner.ts` |
| [Files And Sync (1/2)](key-files/files-and-sync-1.md) | `src/core/audit-week-file.ts` through `src/core/sync-embed-backfill.ts` |
| [Files And Sync (2/2)](key-files/files-and-sync-2.md) | `src/core/sync-failure-ledger.ts` through `src/core/write-through.ts` |
| [Graph And Facts](key-files/graph-and-facts.md) | `src/core/check-resolvable.ts` through `src/core/trajectory-format.ts` |
| [Entity recall](key-files/entity-recall.md) | `src/core/mentions/*`, `src/core/ops/backlinks-paged.ts`, `extract mentions --explain`, migration v206 |
| [Mcp](key-files/mcp.md) | `src/mcp/dispatch.ts` through `src/mcp/validate-params.ts` |
| [Providers](key-files/providers.md) | `src/core/anthropic-pricing.ts` through `src/core/transcription.ts` |
| [Runtime](key-files/runtime.md) | `src/core/abort-check.ts` through `src/core/zombie-reap.ts` |
| [Security](key-files/security.md) | `src/core/destructive-guard.ts` through `src/core/write-gate-scan.ts`; [purge](key-files/memory-purge.md) |
| [Shared brain skills](key-files/shared-skills.md) | Canonical catalog, enrollment, migration, publication and harness integration |
| [Skills](key-files/skills.md) | `src/core/audit-skill-brain-first.ts` through `src/core/skills-integrity.ts` |
| [Tooling And Tests](key-files/tooling-and-tests.md) | `.github/workflows/test.yml` through `test/remote-privacy-sweep.test.ts` |
| [CI Health And Test Guards](key-files/ci-health-and-test-guards.md) | `nightly-watch.yml` through `check-image-decoders-embedded.sh`, contributor audit, fix-wave gate |
| [BrainBench (sibling repo)](key-files/brainbench.md) | Cross-file contract |
| [Hindsight calibration](key-files/hindsight.md) | Cross-file contract |
| [Schema packs: mutation surface](key-files/schema-mutation.md) | Cross-file contract |
| [Agent bootstrap cluster (paste-in install)](key-files/agent-bootstrap.md) | Cross-file contract |
| [Agent Bootstrap (continued)](key-files/agent-bootstrap-continued.md) | Remaining entries |
| [Google connector + open-loop engine](key-files/google-and-loops.md) | Cross-file contract; [more](key-files/google-and-loops-continued.md), [API](key-files/google-api-access.md) |
| [Open loops](key-files/open-loops-engine.md) | detect, extract, store |
| [Always-loaded core memory](key-files/core-memory.md) | Core tier, write-path guard and lock order, delivery lanes, pressure notice |
| [Workspace push and backup coverage](key-files/workspace-push-and-backup.md) | Workspace push, hook push backstops, backup verdicts, git writer |
| [Secret and sensitivity scanning](key-files/secret-scan.md) | `secret-scan*.ts`: detection, allowlist, scan counters |
| [Ambient capture consent gate](key-files/ambient-capture.md) | `memory.auto_writeback` capture lanes |
| [Belief ledger](key-files/belief-ledger.md) | `src/core/belief/`, `gbrain beliefs`, doctor coverage |
| [Quarantine](key-files/quarantine.md) | Gate-marker strip; quarantined pages in facts, reads, writes |
