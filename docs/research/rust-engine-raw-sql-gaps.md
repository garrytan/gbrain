# Rust engine: raw SQL gap list

Base commit: `4f0993a7b0`. Census run: 2026-11-19, on a local merge of `4f0993a7b0` and `d972a45b41`
(which carries `0a68889b57` and `da8c1b0296`). No site line moves between the two trees except the eight
sites that `d972a45b41` removes (marked below). Full per-site list: [rust-engine/data/raw-sql-gaps.tsv](rust-engine/data/raw-sql-gaps.tsv).

## What this list covers

The Rust engine refuses every `executeRaw`, `executeRawDirect` and `executeRawJsonb` call with the typed
`raw_sql` refusal (`src/core/rust-engine/members.ts:23-24`). `SqlQuery` (`src/core/sql-query.ts`) runs
through `engine.executeRaw`, so it refuses the same way. A site is "fail-soft" when the call sits lexically
inside a `try`, a `.catch(...)` or `Promise.allSettled`: on Rust the refusal is swallowed and the caller
continues with a default, so the CLI or MCP answer can look normal while the work did not happen.

Every site outside the engine files is in scope. The engine files are the ones
`scripts/check-engine-raw-sql-ratchet.ts` excludes (`src/core/engine.ts`, `pglite-engine*`, `postgres-engine*`,
`src/core/engine-sql/**`): their SQL runs behind typed members, which Rust serves or refuses by capability.

## Totals

| Measure | Count |
|---|---|
| Raw SQL sites outside the engine files | 4723 |
| - `executeRaw` | 4541 |
| - `sql_template` | 155 |
| - `executeRawJsonb` | 17 |
| - `executeRawDirect` | 10 |
| Fail-soft sites (`try` / `.catch`) | 851 (755 / 96) |
| Files with at least one site | 1059 |
| Driver calls (`.unsafe`, `.query`, `.exec`), counted apart | 23 in 10 files |
| Census cases (CLI + MCP) | 425: 297 equal, 72 refused, 43 differ, 13 skipped |
| Census cases that reach at least one raw SQL site | 237 |
| Census cases whose first refusal is `raw_sql` | 102 |
| Distinct raw SQL sites the census reaches | 121 |
| Sites the census does not reach | 4603 |
| Hits on a shared SQL helper (`statement-deadline.ts`; `sql-query.ts` had none) | 3: 2 resolved to their caller, 1 not resolved |

The ratchet total (`execute_raw` + `sql_template`) is 4723, the same as the site count.

## How the columns are measured

- Census hits: the number of census cases (`scripts/rust-census/census.ts`, 20-page fixture, PGLite
  reference) whose Rust run reaches the site. A case counts once per site. "refused / differs / equal" splits
  the hits by the case result; "equal" hits are refusals the caller swallowed. "decisive" counts the refused
  cases whose last refusal (`endSite`) is this site.
- CLI and MCP: the census cases that reach the site. For sites the census does not reach, the TSV gives a
  static count: CLI command modules and MCP op modules whose import closure (static and dynamic imports)
  contains the file. That count over-approximates: most files sit in the closure of more than 100 commands.
- Owning lane: an area map from the routing of this work (op_checkpoints SQL to lane 9, journal and
  projection to 7, page body to 3, search, graph and mentions to 6, facts and beliefs to 4, takes, decide and
  eval to 5, access to 11, session state to 10, other CLI command files to 2). "-" means no lane owns the area
  yet. Treat the column as a routing proposal, not a record.

## Census-reached sites, by census hits

| # | Site | Function | Fail-soft | Hits | refused / differs / equal | Decisive | CLI cases | MCP tools | Lane |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `src/core/backup/coverage.ts:128` | countLivePages | try | 170 | 19 / 23 / 128 | 0 | `advisor`, `backup` | 168: `abort_page_upload`, `add_link`, `add_tag`, `add_timeline_entry`, ... | - |
| 2 | `src/core/notifier/resident.ts:70` | listHostSources | no | 168 | 19 / 21 / 128 | 0 | - | 168: `abort_page_upload`, `add_link`, `add_tag`, `add_timeline_entry`, ... | - |
| 3 | `src/core/notifier/store.ts:189` | claimLease | no | 168 | 19 / 21 / 128 | 0 | - | 168: `abort_page_upload`, `add_link`, `add_tag`, `add_timeline_entry`, ... | - |
| 4 | `src/core/readiness.ts:618` | countWaitingJobs | no | 168 | 19 / 21 / 128 | 0 | - | 168: `abort_page_upload`, `add_link`, `add_tag`, `add_timeline_entry`, ... | - |
| 5 | `src/core/readiness.ts:698` | run | no | 168 | 19 / 21 / 128 | 0 | - | 168: `abort_page_upload`, `add_link`, `add_tag`, `add_timeline_entry`, ... | - |
| 6 | `src/core/persistence/journal.ts:1004` | completeWrite | no | 20 | 7 / 13 / 0 | 7 | 7: `append`, `capture`, `put`, `revert`, ... | 13: `add_tag`, `add_timeline_entry`, `append_page`, `capture`, ... | 7 |
| 7 | `src/core/generations/fence.ts:180` | listFenceHolds | no | 3 | 0 / 0 / 3 | 0 | `call`, `get` | `get_page` | 3 |
| 8 | `src/core/persistence/effect-journal.ts:69` | queuePublicationEffects | no | 3 | 1 / 2 / 0 | 0 | `capture` | `capture`, `put_page` | 7 |
| 9 | `src/core/questions/store.ts:115` | listPins | no | 3 | 2 / 0 / 1 | 1 | `context-pack`, `dream`, `questions` | - | - |
| 10 | `src/core/shared-skills/compatibility.ts:10` | sharedCatalogActive | no | 3 | 3 / 0 / 0 | 3 | `brain-skillpack`, `skill`, `skills` | - | - |
| 11 | `src/core/shared-skills/retention.ts:127` | operatorSource | no | 3 | 3 / 0 / 0 | 3 | `prune-skill-revisions`, `retain-skill-revision`, `skill-retention` | - | - |
| 12 | `src/commands/calibration.ts:72` | getLatestProfile | no | 2 | 2 / 0 / 0 | 2 | `calibration` | `get_calibration_profile` | 2 |
| 13 | `src/commands/doctor/checks/core-health.ts:336` | checkVolunteerChannels | try | 2 | 0 / 2 / 0 | 0 | `doctor` | `run_doctor` | 2 |
| 14 | `src/core/advisor/collect-chronicle.ts:133` | collect | try | 2 | 0 / 2 / 0 | 0 | `advisor` | `advisor` | - |
| 15 | `src/core/advisor/collect-mcp-client-fit.ts:108` | readClientSurfaces | try | 2 | 0 / 2 / 0 | 0 | `advisor` | `advisor` | - |
| 16 | `src/core/belief/coverage-report.ts:347` | coveredSources | no | 2 | 2 / 0 / 0 | 2 | `beliefs` | `takes_rebuild` | 4 |
| 17 | `src/core/belief/writers.ts:41` | ontologyStreamSlugs | no | 2 | 2 / 0 / 0 | 2 | `ontology-add` | `ontology_propose` | 4 |
| 18 | `src/core/brainstorm/domain-bank.ts:190` | enumeratePrefixes | no | 2 | 2 / 0 / 0 | 2 | `brainstorm`, `lsd` | - | - |
| 19 | `src/core/chronicle/backfill.ts:139` | runChronicleBackfill | no | 2 | 2 / 0 / 0 | 2 | `chronicle-backfill` | `chronicle_backfill` | - |
| 20 | `src/core/chronicle/ledger-stats.ts:29` | readChronicleLedgerStats | try | 2 | 0 / 2 / 0 | 0 | `advisor` | `advisor` | - |
| 21 | `src/core/embedding-readiness.ts:87` | countBlocked | no | 2 | 2 / 0 / 0 | 1 | `dream`, `embed` | - | - |
| 22 | `src/core/health-memo.ts:79` | readGeneration | try | 2 | 1 / 0 / 1 | 0 | `health` | `get_health` | - |
| 23 | `src/core/mentions/referrers.ts:234` | readReferrerGroups | no | 2 | 2 / 0 / 0 | 2 | `entity` | `entity` | 6 |
| 24 | `src/core/onboard/checks.ts:54` | safeCount | try | 2 | 0 / 2 / 0 | 0 | `onboard` | `run_onboard` | - |
| 25 | `src/core/onboard/checks.ts:712` | checkTypeProliferation | try | 2 | 0 / 2 / 0 | 0 | `onboard` | `run_onboard` | - |
| 26 | `src/core/onboard/checks.ts:781` | checkDanglingAliases | try | 2 | 0 / 2 / 0 | 0 | `onboard` | `run_onboard` | - |
| 27 | `src/core/op-checkpoint.ts:139` | loadOpCheckpoint | try | 2 | 0 / 0 / 2 | 0 | `enrich`, `extract-conversation-facts` | - | - |
| 28 | `src/core/page-state/projections.ts:719` | projectionBacklog | no | 2 | 1 / 1 / 0 | 1 | `projections` | `run_doctor` | 7 |
| 29 | `src/core/persistence/drift-conflicts.ts:298` | auditDriftConflicts | no | 2 | 2 / 0 / 0 | 2 | `write-conflicts` | `list_write_conflicts` | - |
| 30 | `src/core/persistence/memory-mutations.ts:236` | submitRememberMutation | no | 2 | 2 / 0 / 0 | 2 | `remember` | `remember` | - |
| 31 | `src/core/persistence/page-batch.ts:117` | readBatch | no | 2 | 2 / 0 / 0 | 2 | `put-pages` | `put_pages` | - |
| 32 | `src/core/persistence/semantic-pages.ts:83` | prepareSemanticPageMutation | no | 2 | 1 / 1 / 0 | 0 | `timeline-add` | `add_timeline_entry` | - |
| 33 | `src/core/persistence/sync-holds.ts:575` | readGitSourceHolds | no | 2 | 2 / 0 / 0 | 2 | `sync` | `sync_brain` | 9 |
| 34 | `src/core/repair/core.ts:291` | resolveRepairScope | .catch | 2 | 2 / 0 / 0 | 0 | `dream`, `repair` | - | - |
| 35 | `src/core/repair/core.ts:303` | readCursor | no | 2 | 2 / 0 / 0 | 0 | `dream`, `repair` | - | 9 |
| 36 | `src/core/repair/origin-carry.ts:121` | originOf | no | 2 | 0 / 1 / 1 | 0 | `delete` | `delete_page` | - |
| 37 | `src/core/search/query-cache.ts:425` | stats | try | 2 | 2 / 0 / 0 | 2 | `cache` | `cache_stats` | 6 |
| 38 | `src/core/shared-skills/membership-authority.ts:51` | memberAuthority | no | 2 | 2 / 0 / 0 | 2 | `leave-brain`, `sync-brain-skills` | - | - |
| 39 | `src/core/source-health.ts:384` | pageCountsBySource | no | 2 | 1 / 1 / 0 | 1 | `sources` | `run_doctor` | - |
| 40 | `src/core/sync-status-report.ts:136` | buildSyncStatusReport | no | 2 | 1 / 1 / 0 | 1 | `status` | `get_status_snapshot` | - |
| 41 | `src/core/synopsis-sweep.ts:52` | readSynopsisTierConfig | no | 2 | 0 / 1 / 1 | 0 | - | `run_doctor`, `search_modes` | - |
| 42 | `src/commands/db-repair.ts:239` | probeAccess | try | 1 | 1 / 0 / 0 | 1 | `db-repair` | - | 2 |
| 43 | `src/commands/diag.ts:62` | readSources | no | 1 | 0 / 1 / 0 | 0 | `diag` | - | 2 |
| 44 | `src/commands/diag.ts:83` | readHolds | no | 1 | 0 / 1 / 0 | 0 | `diag` | - | 2 |
| 45 | `src/commands/doctor/checks/calibration.ts:192` | checkHiddenBySearchPolicy | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 46 | `src/commands/doctor/checks/calibration.ts:281` | checkLinkResolutionOpportunity | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 47 | `src/commands/doctor/checks/calibration.ts:371` | checkAbandonedThreads | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 48 | `src/commands/doctor/checks/calibration.ts:419` | checkCalibrationFreshness | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 49 | `src/commands/doctor/checks/calibration.ts:466` | checkGradeConfidenceDrift | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 50 | `src/commands/doctor/checks/calibration.ts:566` | checkVoiceGateHealth | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 51 | `src/commands/doctor/checks/calibration.ts:66` | checkContextualRetrievalCoverage | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 52 | `src/commands/doctor/checks/consolidation-cycle.ts:51` | checkSyncConsolidation | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 53 | `src/commands/doctor/checks/derived-visibility.ts:40` | derivedVisibilityCheck | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 54 | `src/commands/doctor/checks/memory-writeback.ts:132` | corpusSourceHoldProblem | no | 1 | 0 / 1 / 0 | 0 | `maintain` | - | 2 |
| 55 | `src/commands/doctor/checks/persistence-capacity.ts:33` | checkPersistenceCapacity | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 56 | `src/commands/doctor/checks/persistence-compaction.ts:24` | checkPersistenceCompaction | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 57 | `src/commands/doctor/checks/persistence-compaction.ts:60` | checkPersistenceCounterDrift | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 58 | `src/commands/doctor/checks/persistence-requests.ts:80` | requestGrowthCheck | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 59 | `src/commands/doctor/checks/privacy-label-ignored.ts:30` | privacyLabelIgnoredCheck | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 60 | `src/commands/doctor/checks/safe-index.ts:15` | safeIndexPendingCheck | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 61 | `src/commands/doctor/checks/sync-failures.ts:35` | checkRecordedSyncFailures | no | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 62 | `src/commands/doctor/checks/unbound-source.ts:16` | checkUnboundSource | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 63 | `src/commands/doctor/last-known.ts:85` | writeLastKnown | try | 1 | 0 / 1 / 0 | 0 | `doctor` | - | 9 |
| 64 | `src/commands/doctor/report-remote.ts:182` | doctorReportRemote | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 65 | `src/commands/doctor/report-remote.ts:307` | doctorReportRemote | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 66 | `src/commands/doctor/schema-pack-checks.ts:118` | checkSchemaPackConsistency | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 67 | `src/commands/doctor/schema-pack-checks.ts:193` | checkSchemaPackSourceDrift | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 2 |
| 68 | `src/commands/edge-proposals.ts:52` | rows | no | 1 | 1 / 0 / 0 | 1 | `edge-proposals` | - | 2 |
| 69 | `src/commands/export.ts:114` | runExport | try | 1 | 1 / 0 / 0 | 1 | `export` | - | 2 |
| 70 | `src/commands/reconcile-links.ts:120` | runReconcileLinks | no | 1 | 1 / 0 / 0 | 1 | `reconcile-links` | - | 2 |
| 71 | `src/commands/sync/perform.ts:43` | syncStartedAt | try | 1 | 1 / 0 / 0 | 0 | `sync` | - | 2 |
| 72 | `src/core/access/members.ts:129` | listMembers | no | 1 | 1 / 0 / 0 | 1 | `access` | - | 11 |
| 73 | `src/core/ai/decide/store.ts:359` | listCalibrations | no | 1 | 1 / 0 / 0 | 1 | `decide` | - | 5 |
| 74 | `src/core/ai/decide/store.ts:466` | recentResolvedModels | no | 1 | 1 / 0 / 0 | 0 | `decide` | - | 5 |
| 75 | `src/core/backfill-effective-date.ts:185` | backfillEffectiveDate | no | 1 | 1 / 0 / 0 | 1 | `reindex-frontmatter` | - | - |
| 76 | `src/core/context/retrieval-reflex.ts:357` | resolveEntitiesToPointers | try | 1 | 0 / 1 / 0 | 0 | `volunteer-context` | - | 10 |
| 77 | `src/core/context/retrieval-reflex.ts:417` | resolveEntitiesToPointers | try | 1 | 0 / 1 / 0 | 0 | `volunteer-context` | - | 10 |
| 78 | `src/core/context/retrieval-reflex.ts:447` | resolveEntitiesToPointers | try | 1 | 0 / 1 / 0 | 0 | `volunteer-context` | - | 10 |
| 79 | `src/core/cycle/chronicle.ts:68` | discover | no | 1 | 1 / 0 / 0 | 0 | `dream` | - | - |
| 80 | `src/core/cycle/edge-contradictions.ts:548` | markRevertedProposals | no | 1 | 1 / 0 / 0 | 0 | `dream` | - | - |
| 81 | `src/core/cycle/extract-atoms.ts:552` | countExtractAtomsBacklog | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | - |
| 82 | `src/core/feedback/store.ts:392` | feedbackStatus | no | 1 | 1 / 0 / 0 | 1 | `feedback` | - | - |
| 83 | `src/core/fence-repair/census-store.ts:125` | readCandidateRecords | no | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 9 |
| 84 | `src/core/mentions/newer-mentions.ts:77` | readNewerMentions | try | 1 | 0 / 0 / 1 | 0 | `context-pack` | - | 6 |
| 85 | `src/core/ops/admin.ts:73` | visibleMostConnected | no | 1 | 1 / 0 / 0 | 1 | - | `get_health` | - |
| 86 | `src/core/ops/attribution.ts:170` | handler | no | 1 | 1 / 0 / 0 | 1 | `attribution` | - | - |
| 87 | `src/core/ops/files.ts:204` | handler | no | 1 | 1 / 0 / 0 | 1 | - | `file_url` | - |
| 88 | `src/core/ops/files.ts:45` | handler | no | 1 | 1 / 0 / 0 | 1 | - | `file_list` | - |
| 89 | `src/core/ops/persistence.ts:105` | hostOperatorReceipt | no | 1 | 1 / 0 / 0 | 1 | `write-request` | - | - |
| 90 | `src/core/ops/tags.ts:90` | handler | no | 1 | 1 / 0 / 0 | 1 | - | `get_tags` | - |
| 91 | `src/core/page-state/credential-reseal.ts:40` | credentialProjectionPending | no | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 7 |
| 92 | `src/core/persistence/connector-checkpoint-migration.ts:44` | loadableConnectorKeys | no | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | - |
| 93 | `src/core/persistence/links-preparation.ts:29` | liveSlugAliases | try | 1 | 1 / 0 / 0 | 0 | `put` | - | - |
| 94 | `src/core/persistence/memory-mutations.ts:439` | submitForgetMutation | no | 1 | 1 / 0 / 0 | 1 | `forget` | - | - |
| 95 | `src/core/persistence/mirror-read-only.ts:37` | readOnlyCheckout | no | 1 | 1 / 0 / 0 | 0 | `dream` | - | - |
| 96 | `src/core/persistence/page-prepare.ts:1093` | prepareInlineOrSegmentedMutation | no | 1 | 1 / 0 / 0 | 0 | `revert` | - | - |
| 97 | `src/core/persistence/sync-blocked.ts:32` | readBlockedManagedSyncs | no | 1 | 0 / 1 / 0 | 0 | - | `get_brain_health` | 9 |
| 98 | `src/core/persistence/sync-freshness.ts:105` | readSyncFreshness | no | 1 | 0 / 1 / 0 | 0 | `status` | - | - |
| 99 | `src/core/persistence/terminal-failures.ts:241` | readCheckpointBlockerMap | no | 1 | 0 / 1 / 0 | 0 | - | `get_brain_health` | 9 |
| 100 | `src/core/quarantine.ts:116` | quarantinedSlugs | no | 1 | 1 / 0 / 0 | 1 | `extract` | - | - |
| 101 | `src/core/repair/timeline.ts:77` | scanTimelineHistory | no | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | - |
| 102 | `src/core/schema-pack/detect.ts:108` | runDetect | no | 1 | 1 / 0 / 0 | 1 | `dream` | - | - |
| 103 | `src/core/schema-pack/review.ts:146` | findTypeOrphans | no | 1 | 1 / 0 / 0 | 1 | - | `schema_review_orphans` | - |
| 104 | `src/core/schema-pack/stats.ts:178` | fetchCountRows | try | 1 | 1 / 0 / 0 | 1 | - | `schema_stats` | - |
| 105 | `src/core/search/relational-recall.ts:167` | resolveSeedScoped | no | 1 | 0 / 1 / 0 | 0 | `query` | - | 6 |
| 106 | `src/core/shared-skills/catalog.ts:54` | readSnapshot | no | 1 | 1 / 0 / 0 | 1 | `skill-asset` | - | - |
| 107 | `src/core/shared-skills/content-freshness.ts:39` | ownedContentRows | no | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | - |
| 108 | `src/core/shared-skills/migration.ts:109` | runSharedSkillsMigration | no | 1 | 1 / 0 / 0 | 1 | `apply-migrations` | - | - |
| 109 | `src/core/shared-skills/policy.ts:236` | getSharedSkillPolicy | no | 1 | 1 / 0 / 0 | 1 | `skill-policy` | - | - |
| 110 | `src/core/source-health.ts:463` | loadSyncFreshnessSources | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | - |
| 111 | `src/core/source-health.ts:470` | loadSyncFreshnessSources | try | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | - |
| 112 | `src/core/source-health.ts:475` | loadSyncFreshnessSources | no | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | - |
| 113 | `src/core/sources-not-readable.ts:52` | assertUnscopedReadReachesPages | try | 1 | 0 / 0 / 1 | 0 | - | `recall` | 1 |
| 114 | `src/core/statement-deadline.ts:113 (hub; caller not resolved)` | - | ? | 1 | 0 / 1 / 0 | 0 | `maintain` | - | - |
| 115 | `src/core/sweep.ts:216` | runMaintenanceSweep | try | 1 | 0 / 1 / 0 | 0 | `sweep` | - | - |
| 116 | `src/core/sweep.ts:381` | runLinksTimelinePass | no | 1 | 0 / 1 / 0 | 0 | `sweep` | - | - |
| 117 | `src/core/sync-dispatch-read.ts:51` | syncDispatchRow | no | 1 | 1 / 0 / 0 | 0 | `sync` | - | - |
| 118 | `src/core/timeline-dedup-repair.ts:80` | checkTimelineDedupIndex | no | 1 | 0 / 1 / 0 | 0 | - | `run_doctor` | 6 |
| 119 | `src/core/transcripts/discover.ts:146` | indexImportedSessions | no | 1 | 1 / 0 / 0 | 1 | `transcripts` | - | - |
| 120 | `src/core/trust/supersede-handlers.ts:142` | guardRemoteForget | no | 1 | 1 / 0 / 0 | 1 | - | `forget` | - |
| 121 | `src/core/verbs/entity-variants.ts:161` | readPossibleDuplicates | try | 1 | 0 / 0 / 1 | 0 | - | `rank_entities` | - |

The top five sites are startup and status probes (backup coverage, the notifier, readiness). Every MCP
case runs them; they fail soft, so they hide in equal cases. `journal.ts:1004` is the write admission
refusal behind every refused CLI write (`put`, `append`, `capture`, `revert`, ...).


## op_checkpoints writers and readers outside op-checkpoint.ts

On `4f0993a7b0`, `op-checkpoint.ts` itself is still raw SQL (7 sites: lines 139, 200, 230, 251, 276, 281,
514); the census reaches line 139 from `enrich` and `extract-conversation-facts`. The op checkpoint branch
(`rust-engine/write-attribution-reads`, head `2a0c47d19b`) moves every one of them onto typed members except
`purgeStaleCheckpoints`: parent rows at `d 0x02 <op> 0x00 <fingerprint>` (the same key and row as a
housekeeping turn), path rows at `d 0x07 <op> 0x00 <fingerprint> 0x00 <path>`.

The sites below reach the same `op_checkpoints` rows with their own SQL, so they stay raw after that branch
lands: on Rust they refuse (or fail soft), and rows they own never reach the Rust store. Lines are on
`4f0993a7b0` and point at the `executeRaw` call; where the brief named the SQL text line, the call is one or
two lines above. `sync-identity-downgrades.ts:63` is the shared SQL fragment of the downgrade calls, not a
call.

A wider count: 344 raw SQL sites in 89 files name `op_checkpoints` within 15 lines of
the call (a text-window count, so it can include a neighbouring statement). The TSV marks every site; the
table lists the ones routed here.

| Site | Function | Role | Fail-soft | Hits | Census cases | On Rust |
|---|---|---|---|---|---|---|
| **Identity downgrades** | | | | | | |
| `src/core/sync-identity-downgrades.ts:100` | recordIdentityDowngrades | insert a downgrade row | no | 0 | - | refused |
| `src/core/sync-identity-downgrades.ts:113` | listIdentityDowngrades | read downgrade rows with their pages | no | 0 | - | refused |
| `src/core/sync-identity-downgrades.ts:201` | settleIdentityDowngrade | update a downgrade row | no | 0 | - | refused |
| **Sync holds** | | | | | | |
| `src/commands/sources-git-gap.ts:394` | countSourceRows | hold counts by code | no | 0 | - | refused |
| `src/commands/doctor/checks/git-holds.ts:118` | readNoncanonicalPrivate | held-file count | no | 0 | - | refused |
| `src/commands/doctor/checks/git-holds.ts:144` | contentBlockedSources | held files joined to persistence_requests | .catch | 0 | - | fails soft |
| `src/commands/diag.ts:83` | readHolds | hold summary per source | no | 1 | `cli diag` | refused |
| **Fence repair** | | | | | | |
| `src/core/fence-repair/census-store.ts:92` | readScanRecord | read census record | no | 0 | - | refused |
| `src/core/fence-repair/census-store.ts:98` | writeScanRecord | write census record | no | 0 | - | refused |
| `src/core/fence-repair/census-store.ts:106` | upsertCandidatePart | write census record | no | 0 | - | refused |
| `src/core/fence-repair/census-store.ts:117` | clearCandidateParts | delete census rows | no | 0 | - | refused |
| `src/core/fence-repair/census-store.ts:119` | clearCandidateParts | trim census record | no | 0 | - | refused |
| `src/core/fence-repair/census-store.ts:125` | readCandidateRecords | read census records | no | 1 | `mcp run_doctor` | refused |
| `src/core/fence-repair/census-store.ts:142` | recordSyncRunTrend | write attempt record | no | 0 | - | refused |
| `src/core/fence-repair/census-store.ts:150` | recordWriteTrend | write attempt record | no | 0 | - | refused |
| **Other op_checkpoints raw sites** | | | | | | |
| `src/commands/import.ts:632` | runImport | read company-brain content state | no | 0 | - | refused |
| `src/commands/import.ts:825` | processFile | write company-brain content state | no | 0 | - | refused |
| `src/core/company-brain/runtime.ts:182` | execute | read company-brain state | try | 0 | - | fails soft |
| `src/core/company-brain/runtime.ts:197` | execute | write company-brain state | try | 0 | - | fails soft |
| `src/core/company-brain/admission.ts:270` | after | write admission row | no | 0 | - | refused |
| `src/core/company-brain/profile.ts:86` | readCompanyBrainPlan | read profile row | no | 0 | - | refused |
| `src/core/google/loop-catchup.ts:228` | recordLoopsExtractOutcome | write catch-up outcome | no | 0 | - | refused |
| `src/core/google/loop-catchup.ts:240` | readLoopsExtractOutcomes | read catch-up outcomes | no | 0 | - | refused |
| `src/core/google/loops-exclusion.ts:110` | storeLoopsExclusion | write exclusion row | no | 0 | - | refused |
| `src/core/google/loops-exclusion.ts:133` | loadLoopsExclusionPolicy | read exclusion row | no | 0 | - | refused |
| `src/core/attendance-repair.ts:354` | applyAttendanceRepair | read repair state | no | 0 | - | refused |
| `src/core/attendance-repair.ts:369` | applyAttendanceRepair | write repair state | no | 0 | - | refused |
| `src/core/trust/backfill.ts:266` | readCursor | read backfill keys | no | 0 | - | refused |
| `src/core/trust/backfill.ts:272` | saveCursor | write backfill keys | no | 0 | - | refused |
| `src/core/trust/backfill.ts:384` | runTrustBackfill | delete backfill row | no | 0 | - | refused |
| `src/core/trust/backfill.ts:481` | readTrustBackfillState | count backfill rows | no | 0 | - | refused |
| `src/commands/doctor/last-known.ts:65` | readLastKnown | read last-known doctor result | try | 0 | - | fails soft |
| `src/commands/doctor/last-known.ts:85` | writeLastKnown | write last-known doctor result | try | 1 | `cli doctor` | fails soft |
| `src/commands/google-attachments.ts:121` | runGoogleAttachments | read managed-connector row | try | 0 | - | fails soft |
| `src/commands/autopilot-dispatch.ts:595` | readConnectorRateLimits | read retry rows | no | 0 | - | refused |
| `src/commands/sources-strategy.ts:30` | unfinishedManagedSyncRuns | read strategy cursors | no | 0 | - | refused |

Engine-side readers of the same rows. These are typed members, so Rust does not refuse them, but the Rust
answer assumes the rows above never exist:

| Site | Member | On Rust |
|---|---|---|
| `src/core/engine-sql/persistence-journal.ts:133` | `readHeldPageRows` (`HELD_PAGES_SQL`, joins `op_checkpoints` to `sources` and `pages`) | store member returns `[]`: "no page is ever held" (`store-members/persistence.ts:67-68`) |
| `src/core/engine-sql/persistence-journal.ts:154` | `readHeldCoverageRows` (hold summary per source) | store member returns `[]` (`store-members/persistence.ts:70-71`) |
| `src/core/engine-sql/persistence-housekeeping.ts:97`, `:99` | `listCompactableReceipts` (`COMPACTABLE_RECEIPTS_SQL`, excludes receipts of open `managed-sync` and `managed-sync-pass` rows) | Rust store skips both exclusions: "this engine has no managed-sync checkpoint rows" (`rust/crates/gbrain-store/src/persistence/housekeeping.rs:310-313`) |

When any writer above moves onto Rust, these three answers must start reading the rows it writes, or a held
page reads as unheld and an open sync run's receipts become compactable.

### purgeStaleCheckpoints does not run on Rust

`purgeStaleCheckpoints` (`src/core/op-checkpoint.ts:506-558`) is one raw `WITH deleted AS (DELETE FROM
op_checkpoints ...)` statement (call at line 514, SQL from line 516). It is fail-soft: the catch at line 554
logs `[op-checkpoint] purge failed` and returns 0. It has two callers:

- the `purge` minion job handler (`src/core/minions/handlers/purge.ts:31-32`, result `checkpointsPurged`),
  registered by `src/commands/jobs.ts:630`;
- the cycle's `bookkeeping_gc` phase (`src/core/cycle/bookkeeping-gc.ts:20-21`, from `src/core/cycle.ts:3082`),
  which wraps it in its own `try` as well.

On Rust both report 0 rows purged. Once the branch above stores checkpoints on Rust, every `d 0x02`
and `d 0x07` checkpoint row stays forever. The statement also
carries the keep rules (managed atoms and connectors, sync holds, fence rows, open managed-sync runs,
incomplete ingestion receipts) that a typed member has to keep. The census does not reach it: no purge job
or cycle runs in the fixture.


## Key tags

Every store key starts with a one-byte family tag (`rust/crates/gbrain-store/src/keys.rs`); many families
put a one-byte sub-tag next. One row per tag, on the three commits. A cell gives the constant name and
`file:line` under `rust/crates/gbrain-store/src/`; "-" means the commit does not have it.

### Collisions

| Tag | Where | Clash | Status |
|---|---|---|---|
| `d 0x05` | `persistence.rs:72` `CHECKPOINT_PATH` on `rust-engine/write-attribution-reads` at `03441d61e1` | `persistence/effects.rs:28` `EFFECT` (persistence_effects rows) on `1a6511788d` and `071ccd4615` | **collision.** Fixed on the same branch by `21732c84c9` (head `2a0c47d19b`): `CHECKPOINT_PATH` is `0x07` at `persistence.rs:76`. `0x07` is free on all three commits. |

No other byte has two meanings. Checked: no two families share a family byte on any commit or across the
three; inside each family, no sub-tag byte has different names on different commits. Two near misses:

- `F` (facts) has two constants named `PURGE` for two tables: `F 0x0F` is the fact purge ledger
  (`fact_purges`, `facts/purge_ledger.rs`, only on `4f0993a7b0`) and `F 0x0C` is the page purge ledger
  (`page_purges`, `facts/page_purges.rs`, only on `071ccd4615`). Different bytes, so no clash, but a merge
  needs both to keep their own names in review.
- `F 0x0E` `GENERATION` (`facts/generations.rs`, only on `071ccd4615`) and the `h` family
  `DERIVED_GENERATION` (`generations.rs`, only on `1a6511788d`) both store generation records under
  different families. No clash; a merge should pick one home.

Mirrors, not collisions: `alias_fanout_reads.rs` repeats `k 0x02` and `k 0x03` from `aliases.rs`, and
`write_guards.rs` repeats `b 0x01`, `b 0x03` (and a literal `b 0x02`) from `page_body.rs`, to read the same
rows. Pending heads checked too: `d972a45b41` adds the family `y` `SESSION_STATE` (`keys.rs:100`), distinct
from `Y` `DREAM_VERDICT`; `2a0c47d19b` adds `d 0x07`. `keyword/trgm.rs` and `keyword/tsearch.rs` constants are
encoding flags inside a key, not tags, and are left out.

### Family tags

| Family | Byte | `4f0993a7b0` | `1a6511788d` | `071ccd4615` |
|---|---|---|---|---|
| `META` | `b'M'` | keys.rs:5 | keys.rs:5 | keys.rs:5 |
| `CONFIG` | `b'C'` | keys.rs:6 | keys.rs:6 | keys.rs:6 |
| `SOURCE` | `b'S'` | keys.rs:7 | keys.rs:7 | keys.rs:7 |
| `PAGE` | `b'P'` | keys.rs:8 | keys.rs:8 | keys.rs:8 |
| `PAGE_ID` | `b'I'` | keys.rs:9 | keys.rs:9 | keys.rs:9 |
| `CHUNK` | `b'K'` | keys.rs:10 | keys.rs:10 | keys.rs:10 |
| `POSTING` | `b'T'` | keys.rs:11 | keys.rs:11 | keys.rs:11 |
| `VERSION` | `b'V'` | keys.rs:12 | keys.rs:12 | keys.rs:12 |
| `REQUEST` | `b'J'` | keys.rs:13 | keys.rs:13 | keys.rs:13 |
| `REQUEST_ID` | `b'j'` | keys.rs:14 | keys.rs:14 | keys.rs:14 |
| `WRITER` | `b'W'` | keys.rs:15 | keys.rs:15 | keys.rs:15 |
| `LINK` | `b'L'` | keys.rs:16 | keys.rs:16 | keys.rs:16 |
| `LINK_TO` | `b'l'` | keys.rs:17 | keys.rs:17 | keys.rs:17 |
| `LINK_UNIQUE` | `b'U'` | keys.rs:18 | keys.rs:18 | keys.rs:18 |
| `LINK_ORIGIN` | `b'O'` | keys.rs:19 | keys.rs:19 | keys.rs:19 |
| `TIMELINE` | `b'E'` | keys.rs:20 | keys.rs:20 | keys.rs:20 |
| `TIMELINE_DEDUP` | `b'D'` | keys.rs:21 | keys.rs:21 | keys.rs:21 |
| `TIMELINE_LATEST` | `b'G'` | keys.rs:22 | keys.rs:22 | keys.rs:22 |
| `PAGE_ORIGIN` | `b'o'` | keys.rs:23 | keys.rs:23 | keys.rs:23 |
| `PAGE_OPS` | `b'p'` | keys.rs:29 | keys.rs:29 | keys.rs:29 |
| `EXTRACTION` | `b'e'` | keys.rs:31 | keys.rs:31 | keys.rs:31 |
| `ALIAS` | `b'k'` | keys.rs:33 | keys.rs:33 | keys.rs:33 |
| `PAGE_BODY` | `b'b'` | keys.rs:35 | keys.rs:35 | keys.rs:35 |
| `FACT` | `b'F'` | keys.rs:37 | keys.rs:37 | keys.rs:37 |
| `ONTOLOGY` | `b'N'` | keys.rs:39 | keys.rs:39 | keys.rs:39 |
| `TAKE` | `b'A'` | keys.rs:41 | keys.rs:41 | keys.rs:41 |
| `CONTRADICTIONS` | `b'Q'` | keys.rs:43 | keys.rs:43 | keys.rs:43 |
| `DREAM_VERDICT` | `b'Y'` | keys.rs:45 | keys.rs:45 | keys.rs:45 |
| `EVAL_CAPTURE` | `b'Z'` | keys.rs:47 | keys.rs:47 | keys.rs:47 |
| `CODE_EDGE` | `b'H'` | keys.rs:49 | keys.rs:49 | keys.rs:49 |
| `CODE_TRAVERSAL_CACHE` | `b'g'` | keys.rs:51 | keys.rs:51 | keys.rs:51 |
| `SALIENCE` | `b's'` | keys.rs:53 | keys.rs:53 | keys.rs:53 |
| `INGEST_LOG` | `b'n'` | keys.rs:55 | keys.rs:55 | keys.rs:55 |
| `RAW_FILES` | `b'r'` | keys.rs:57 | keys.rs:57 | keys.rs:57 |
| `LINK_QUERIES` | `b'q'` | keys.rs:59 | keys.rs:59 | keys.rs:59 |
| `TIMELINE_QUERIES` | `b'u'` | keys.rs:61 | keys.rs:61 | keys.rs:61 |
| `TRIGRAM` | `b'R'` | keys.rs:63 | keys.rs:63 | keys.rs:63 |
| `CHUNK_QUERIES` | `b'c'` | keys.rs:65 | keys.rs:65 | keys.rs:65 |
| `VECTOR` | `b'X'` | keys.rs:67 | keys.rs:67 | keys.rs:67 |
| `EMBEDDING_STATE` | `b'B'` | keys.rs:69 | keys.rs:69 | keys.rs:69 |
| `LOCK_QUEUE` | `b'w'` | keys.rs:71 | keys.rs:71 | keys.rs:71 |
| `RELATION_CATALOG` | `b'v'` | keys.rs:73 | keys.rs:73 | keys.rs:73 |
| `PERSISTENCE` | `b'd'` | keys.rs:77 | keys.rs:77 | keys.rs:77 |
| `JOBS` | `b'm'` | keys.rs:79 | keys.rs:79 | keys.rs:79 |
| `TRUST` | `b't'` | keys.rs:81 | keys.rs:81 | keys.rs:81 |
| `TELEMETRY` | `b'a'` | keys.rs:84 | keys.rs:84 | keys.rs:84 |
| `TELEMETRY_SEARCH` | `0x01` | keys.rs:86 | keys.rs:86 | keys.rs:86 |
| `TELEMETRY_MCP_REQUEST` | `0x02` | keys.rs:87 | keys.rs:87 | keys.rs:87 |
| `TELEMETRY_MCP_ROLLUP` | `0x03` | keys.rs:88 | keys.rs:88 | keys.rs:88 |
| `TELEMETRY_RETRIEVAL_EVENT` | `0x04` | keys.rs:89 | keys.rs:89 | keys.rs:89 |
| `TELEMETRY_RETRIEVAL_EVENT_PAGE` | `0x05` | keys.rs:90 | keys.rs:90 | keys.rs:90 |
| `TELEMETRY_RETRIEVAL_EVENT_LINK` | `0x06` | keys.rs:91 | keys.rs:91 | keys.rs:91 |
| `TELEMETRY_FEEDBACK` | `0x07` | keys.rs:92 | keys.rs:92 | keys.rs:92 |
| `TELEMETRY_RETRIEVAL_WEIGHT` | `0x08` | keys.rs:93 | keys.rs:93 | keys.rs:93 |
| `TELEMETRY_BUDGET_LEDGER` | `0x09` | keys.rs:94 | keys.rs:94 | keys.rs:94 |
| `TELEMETRY_BUDGET_RESERVATION` | `0x0A` | keys.rs:95 | keys.rs:95 | keys.rs:95 |
| `TELEMETRY_CHAT_USAGE` | `0x0B` | keys.rs:96 | keys.rs:96 | keys.rs:96 |
| `DREAM_SYNTHESIS_COMPLETION` | `b'f'` | keys.rs:98 | keys.rs:98 | keys.rs:98 |
| `ENTITY_IDENTITY` | `b'i'` | keys.rs:100 | - | - |
| `DERIVED_GENERATION` | `b'h'` | - | keys.rs:100 | - |

### Sub-tags

| Family | Sub-tag | `4f0993a7b0` | `1a6511788d` | `071ccd4615` |
|---|---|---|---|---|
| `ALIAS` (`b'k'`) | `0x01` | `SLUG_ALIAS` aliases.rs:59 | `SLUG_ALIAS` aliases.rs:59 | `SLUG_ALIAS` aliases.rs:59 |
| `ALIAS` (`b'k'`) | `0x02` | `PAGE_ALIAS` alias_fanout_reads.rs:33<br>`PAGE_ALIAS` aliases.rs:61 | `PAGE_ALIAS` alias_fanout_reads.rs:33<br>`PAGE_ALIAS` aliases.rs:61 | `PAGE_ALIAS` alias_fanout_reads.rs:33<br>`PAGE_ALIAS` aliases.rs:61 |
| `ALIAS` (`b'k'`) | `0x03` | `PAGE_ALIAS_BY_SLUG` alias_fanout_reads.rs:35<br>`PAGE_ALIAS_BY_SLUG` aliases.rs:62 | `PAGE_ALIAS_BY_SLUG` alias_fanout_reads.rs:35<br>`PAGE_ALIAS_BY_SLUG` aliases.rs:62 | `PAGE_ALIAS_BY_SLUG` alias_fanout_reads.rs:35<br>`PAGE_ALIAS_BY_SLUG` aliases.rs:62 |
| `ALIAS` (`b'k'`) | `0x04` | `CR_STATE` aliases.rs:63 | `CR_STATE` aliases.rs:63 | `CR_STATE` aliases.rs:63 |
| `ALIAS` (`b'k'`) | `0x05` | `SLUG_ALIAS_BY_CANONICAL` aliases.rs:64 | `SLUG_ALIAS_BY_CANONICAL` aliases.rs:64 | `SLUG_ALIAS_BY_CANONICAL` aliases.rs:64 |
| `ALIAS` (`b'k'`) | `0x06` | `RENAME_HISTORY` aliases.rs:65 | `RENAME_HISTORY` aliases.rs:65 | `RENAME_HISTORY` aliases.rs:65 |
| `CODE_EDGE` (`b'H'`) | `0x01` | `ROW` code_edges.rs:48 | `ROW` code_edges.rs:48 | `ROW` code_edges.rs:48 |
| `CODE_EDGE` (`b'H'`) | `0x02` | `CHUNK_UNIQUE` code_edges.rs:50 | `CHUNK_UNIQUE` code_edges.rs:50 | `CHUNK_UNIQUE` code_edges.rs:50 |
| `CODE_EDGE` (`b'H'`) | `0x03` | `SYMBOL_UNIQUE` code_edges.rs:51 | `SYMBOL_UNIQUE` code_edges.rs:51 | `SYMBOL_UNIQUE` code_edges.rs:51 |
| `CODE_EDGE` (`b'H'`) | `0x04` | `BY_CHUNK` code_edges.rs:52 | `BY_CHUNK` code_edges.rs:52 | `BY_CHUNK` code_edges.rs:52 |
| `CODE_EDGE` (`b'H'`) | `0x05` | `BY_TO_SYMBOL` code_edges.rs:53 | `BY_TO_SYMBOL` code_edges.rs:53 | `BY_TO_SYMBOL` code_edges.rs:53 |
| `CODE_EDGE` (`b'H'`) | `0x06` | `BY_FROM_SYMBOL` code_edges.rs:54 | `BY_FROM_SYMBOL` code_edges.rs:54 | `BY_FROM_SYMBOL` code_edges.rs:54 |
| `CODE_TRAVERSAL_CACHE` (`b'g'`) | `0x01` | `ROW` code_edges/traversal_cache.rs:39 | `ROW` code_edges/traversal_cache.rs:39 | `ROW` code_edges/traversal_cache.rs:39 |
| `CODE_TRAVERSAL_CACHE` (`b'g'`) | `0x02` | `UNIQUE` code_edges/traversal_cache.rs:41 | `UNIQUE` code_edges/traversal_cache.rs:41 | `UNIQUE` code_edges/traversal_cache.rs:41 |
| `CODE_TRAVERSAL_CACHE` (`b'g'`) | `0x03` | `BY_SOURCE` code_edges/traversal_cache.rs:42 | `BY_SOURCE` code_edges/traversal_cache.rs:42 | `BY_SOURCE` code_edges/traversal_cache.rs:42 |
| `CONTRADICTIONS` (`b'Q'`) | `0x01` | `RUN` contradictions.rs:29 | `RUN` contradictions.rs:29 | `RUN` contradictions.rs:29 |
| `CONTRADICTIONS` (`b'Q'`) | `0x02` | `RUN_BY_TIME` contradictions.rs:31 | `RUN_BY_TIME` contradictions.rs:31 | `RUN_BY_TIME` contradictions.rs:31 |
| `CONTRADICTIONS` (`b'Q'`) | `0x03` | `CACHE` contradictions.rs:32 | `CACHE` contradictions.rs:32 | `CACHE` contradictions.rs:32 |
| `DERIVED_GENERATION` (`b'h'`) | `0x01` | - | `RECORD` generations.rs:39 | - |
| `DERIVED_GENERATION` (`b'h'`) | `0x02` | - | `POINTER` generations.rs:41 | - |
| `DERIVED_GENERATION` (`b'h'`) | `0x03` | - | `ITEM` generations.rs:42 | - |
| `EMBEDDING_STATE` (`b'B'`) | `b'b'` | - | `PAGE_BUDGET` page_embedding_budget.rs:25 | - |
| `EMBEDDING_STATE` (`b'B'`) | `b'c'` | `CHUNK_VECTOR` embeddings.rs:38 | `CHUNK_VECTOR` embeddings.rs:39 | `CHUNK_VECTOR` embeddings.rs:39 |
| `EMBEDDING_STATE` (`b'B'`) | `b'g'` | `GENERATION` embeddings.rs:41 | `GENERATION` embeddings.rs:42 | `GENERATION` embeddings.rs:42 |
| `EMBEDDING_STATE` (`b'B'`) | `b'k'` | `TAKE_STATE` embeddings.rs:43 | `TAKE_STATE` embeddings.rs:44 | `TAKE_STATE` embeddings.rs:44 |
| `EMBEDDING_STATE` (`b'B'`) | `b's'` | `PAGE_SIGNATURE` embeddings.rs:42 | `PAGE_SIGNATURE` embeddings.rs:43 | `PAGE_SIGNATURE` embeddings.rs:43 |
| `EMBEDDING_STATE` (`b'B'`) | `b't'` | `TAKE_VECTOR` embeddings.rs:40 | `TAKE_VECTOR` embeddings.rs:41 | `TAKE_VECTOR` embeddings.rs:41 |
| `ENTITY_IDENTITY` (`b'i'`) | `0x01` | `ROW` entity_identities.rs:39 | - | - |
| `ENTITY_IDENTITY` (`b'i'`) | `0x02` | `GROUP` entity_identities.rs:41 | - | - |
| `EVAL_CAPTURE` (`b'Z'`) | `0x01` | `CANDIDATE` eval_capture.rs:38 | `CANDIDATE` eval_capture.rs:38 | `CANDIDATE` eval_capture.rs:51 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x02` | `FAILURE` eval_capture.rs:39 | `FAILURE` eval_capture.rs:39 | `FAILURE` eval_capture.rs:52 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x10` | - | - | `STATE` eval_capture/decide_store.rs:42 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x11` | - | - | `SPEND` eval_capture/decide_store.rs:44 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x12` | - | - | `SPEND_BY_TIME` eval_capture/decide_store.rs:45 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x13` | - | - | `RECEIPT` eval_capture/decide_store/receipts.rs:24 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x14` | - | - | `RECEIPT_BY_TIME` eval_capture/decide_store/receipts.rs:26 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x15` | - | - | `CALIBRATION` eval_capture/decide_store/calibrations.rs:20 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x20` | - | - | `RECORD` eval_capture/calibration_profiles.rs:34 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x21` | - | - | `BY_TIME` eval_capture/calibration_profiles.rs:35 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x30` | - | - | `PROPOSAL` eval_capture/decide_proposals.rs:50 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x31` | - | - | `PROPOSAL_SWEEP` eval_capture/decide_proposals.rs:52 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x32` | - | - | `PROPOSAL_CLAIM_PAIR` eval_capture/decide_proposals.rs:54 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x38` | - | - | `REVIEW_PROPOSAL` eval_capture/decide_proposals.rs:56 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x39` | - | - | `REVIEW_PROPOSAL_KEY` eval_capture/decide_proposals.rs:58 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x3C` | - | - | `REVIEW_QUEUE` eval_capture/decide_proposals.rs:60 |
| `EVAL_CAPTURE` (`b'Z'`) | `0x3D` | - | - | `SWEEP_DEFERRED` eval_capture/decide_proposals.rs:62 |
| `FACT` (`b'F'`) | `0x01` | `ROW` facts.rs:84 | `ROW` facts.rs:77 | `ROW` facts.rs:83 |
| `FACT` (`b'F'`) | `0x02` | `BY_SOURCE` facts.rs:86 | `BY_SOURCE` facts.rs:79 | `BY_SOURCE` facts.rs:85 |
| `FACT` (`b'F'`) | `0x03` | `BY_ENTITY` facts.rs:87 | `BY_ENTITY` facts.rs:80 | `BY_ENTITY` facts.rs:86 |
| `FACT` (`b'F'`) | `0x04` | `BY_PAGE` facts.rs:88 | `BY_PAGE` facts.rs:81 | `BY_PAGE` facts.rs:87 |
| `FACT` (`b'F'`) | `0x05` | `FENCE` facts.rs:89 | `FENCE` facts.rs:82 | `FENCE` facts.rs:88 |
| `FACT` (`b'F'`) | `0x06` | `REFS` facts.rs:90 | `REFS` facts.rs:83 | `REFS` facts.rs:89 |
| `FACT` (`b'F'`) | `0x07` | `STINT` facts.rs:91 | `STINT` facts.rs:84 | `STINT` facts.rs:90 |
| `FACT` (`b'F'`) | `0x08` | `ROW` facts/loops.rs:30 | `ROW` facts/loops.rs:30 | `ROW` facts/loops.rs:30 |
| `FACT` (`b'F'`) | `0x09` | `DEDUP` facts/loops.rs:32 | `DEDUP` facts/loops.rs:32 | `DEDUP` facts/loops.rs:32 |
| `FACT` (`b'F'`) | `0x0A` | `ROW` facts/relink.rs:30 | `ROW` facts/relink.rs:30 | `ROW` facts/relink.rs:30 |
| `FACT` (`b'F'`) | `0x0B` | `BY_TARGET` facts/relink.rs:32 | `BY_TARGET` facts/relink.rs:32 | `BY_TARGET` facts/relink.rs:32 |
| `FACT` (`b'F'`) | `0x0C` | - | - | `PURGE` facts/page_purges.rs:21 |
| `FACT` (`b'F'`) | `0x0D` | - | - | `RECONCILE` facts/reconcile.rs:72 |
| `FACT` (`b'F'`) | `0x0E` | - | - | `GENERATION` facts/generations.rs:31 |
| `FACT` (`b'F'`) | `0x0F` | `PURGE` facts/purge_ledger.rs:33 | - | - |
| `JOBS` (`b'm'`) | `0x00` | `SEQ` jobs.rs:110 | `SEQ` jobs.rs:102 | `SEQ` jobs.rs:110 |
| `JOBS` (`b'm'`) | `0x01` | `JOB` jobs.rs:112 | `JOB` jobs.rs:104 | `JOB` jobs.rs:112 |
| `JOBS` (`b'm'`) | `0x02` | `CLAIM` jobs.rs:113 | `CLAIM` jobs.rs:105 | `CLAIM` jobs.rs:113 |
| `JOBS` (`b'm'`) | `0x03` | `CHILD` jobs.rs:114 | `CHILD` jobs.rs:106 | `CHILD` jobs.rs:114 |
| `JOBS` (`b'm'`) | `0x04` | `KEY` jobs.rs:115 | `KEY` jobs.rs:107 | `KEY` jobs.rs:115 |
| `JOBS` (`b'm'`) | `0x05` | `INBOX` jobs.rs:116 | `INBOX` jobs.rs:108 | `INBOX` jobs.rs:116 |
| `JOBS` (`b'm'`) | `0x06` | `STATUS` jobs.rs:117 | `STATUS` jobs.rs:109 | `STATUS` jobs.rs:117 |
| `JOBS` (`b'm'`) | `0x07` | `LOCK` jobs.rs:118 | `LOCK` jobs.rs:110 | `LOCK` jobs.rs:118 |
| `JOBS` (`b'm'`) | `0x08` | `ATTACH` jobs.rs:119 | `ATTACH` jobs.rs:111 | `ATTACH` jobs.rs:119 |
| `JOBS` (`b'm'`) | `0x09` | `OWNED` jobs.rs:120 | `OWNED` jobs.rs:112 | `OWNED` jobs.rs:120 |
| `JOBS` (`b'm'`) | `0x10` | `SUB` jobs/wake.rs:22 | `SUB` jobs/wake.rs:22 | `SUB` jobs/wake.rs:22 |
| `JOBS` (`b'm'`) | `0x11` | `SUB_OPEN` jobs/wake.rs:24 | `SUB_OPEN` jobs/wake.rs:24 | `SUB_OPEN` jobs/wake.rs:24 |
| `JOBS` (`b'm'`) | `0x13` | `FORGET` jobs/wake.rs:25 | `FORGET` jobs/wake.rs:25 | `FORGET` jobs/wake.rs:25 |
| `JOBS` (`b'm'`) | `0x14` | `FORGET_PENDING` jobs/wake.rs:26 | `FORGET_PENDING` jobs/wake.rs:26 | `FORGET_PENDING` jobs/wake.rs:26 |
| `JOBS` (`b'm'`) | `0x15` | `TERMS` jobs/wake.rs:27 | `TERMS` jobs/wake.rs:27 | `TERMS` jobs/wake.rs:27 |
| `JOBS` (`b'm'`) | `0x16` | `CRON` jobs/wake.rs:28 | `CRON` jobs/wake.rs:28 | `CRON` jobs/wake.rs:28 |
| `JOBS` (`b'm'`) | `0x17` | `CRON_RUN` jobs/wake.rs:29 | `CRON_RUN` jobs/wake.rs:29 | `CRON_RUN` jobs/wake.rs:29 |
| `JOBS` (`b'm'`) | `0x18` | `MSG` jobs/subagent.rs:31 | `MSG` jobs/subagent.rs:31 | `MSG` jobs/subagent.rs:31 |
| `JOBS` (`b'm'`) | `0x19` | `TOOL` jobs/subagent.rs:33 | `TOOL` jobs/subagent.rs:33 | `TOOL` jobs/subagent.rs:33 |
| `JOBS` (`b'm'`) | `0x1A` | `POSITION` jobs/subagent.rs:34 | `POSITION` jobs/subagent.rs:34 | `POSITION` jobs/subagent.rs:34 |
| `JOBS` (`b'm'`) | `0x1B` | `STABLE` jobs/subagent.rs:35 | `STABLE` jobs/subagent.rs:35 | `STABLE` jobs/subagent.rs:35 |
| `JOBS` (`b'm'`) | `0x1C` | `LEGACY` jobs/subagent.rs:36 | `LEGACY` jobs/subagent.rs:36 | `LEGACY` jobs/subagent.rs:36 |
| `JOBS` (`b'm'`) | `0x20` | `RES` jobs/spend.rs:35 | `RES` jobs/spend.rs:32 | `RES` jobs/spend.rs:35 |
| `JOBS` (`b'm'`) | `0x21` | `RES_JOB` jobs/spend.rs:37 | `RES_JOB` jobs/spend.rs:34 | `RES_JOB` jobs/spend.rs:37 |
| `JOBS` (`b'm'`) | `0x22` | `RES_EXP` jobs/spend.rs:38 | `RES_EXP` jobs/spend.rs:35 | `RES_EXP` jobs/spend.rs:38 |
| `JOBS` (`b'm'`) | `0x24` | `LOG` jobs/spend.rs:40 | `LOG` jobs/spend.rs:36 | `LOG` jobs/spend.rs:40 |
| `JOBS` (`b'm'`) | `0x25` | `LOG_AT` jobs/spend.rs:41 | `LOG_AT` jobs/spend.rs:37 | `LOG_AT` jobs/spend.rs:41 |
| `JOBS` (`b'm'`) | `0x26` | `LOG_JOB` jobs/spend.rs:42 | `LOG_JOB` jobs/spend.rs:38 | `LOG_JOB` jobs/spend.rs:42 |
| `JOBS` (`b'm'`) | `0x27` | `RES_OPEN` jobs/spend.rs:39 | - | `RES_OPEN` jobs/spend.rs:39 |
| `JOBS` (`b'm'`) | `0x28` | `LOG_REC` jobs/spend_log.rs:28 | - | `LOG_REC` jobs/spend_log.rs:28 |
| `JOBS` (`b'm'`) | `0x29` | `LOG_OWN` jobs/spend_log.rs:30 | - | `LOG_OWN` jobs/spend_log.rs:30 |
| `JOBS` (`b'm'`) | `0x2A` | `CLIENT` jobs/oauth_clients.rs:22 | - | `CLIENT` jobs/oauth_clients.rs:18 |
| `JOBS` (`b'm'`) | `0x2B` | `TOKEN` jobs/access_tokens.rs:19 | - | - |
| `LINK_QUERIES` (`b'q'`) | `b'R'` | `RELATIONSHIP` link_queries/link_temporal.rs:45 | `RELATIONSHIP` link_queries/link_temporal.rs:44 | `RELATIONSHIP` link_queries/link_temporal.rs:44 |
| `LINK_QUERIES` (`b'q'`) | `b'T'` | `TRANSITION` link_queries/link_temporal.rs:47 | `TRANSITION` link_queries/link_temporal.rs:46 | `TRANSITION` link_queries/link_temporal.rs:46 |
| `LINK_QUERIES` (`b'q'`) | `b'W'` | `WANTED` wanted_links.rs:30 | `WANTED` wanted_links.rs:30 | `WANTED` wanted_links.rs:30 |
| `PAGE_BODY` (`b'b'`) | `0x01` | `SEGMENT_TEXT_KIND` write_guards.rs:130<br>`TEXT` page_body.rs:49 | `SEGMENT_TEXT_KIND` write_guards.rs:131<br>`TEXT` page_body.rs:49 | `SEGMENT_TEXT_KIND` write_guards.rs:130<br>`TEXT` page_body.rs:49 |
| `PAGE_BODY` (`b'b'`) | `0x02` | `MANIFEST` page_body.rs:51 | `MANIFEST` page_body.rs:51 | `MANIFEST` page_body.rs:51 |
| `PAGE_BODY` (`b'b'`) | `0x03` | `BODY_STAGING_KIND` write_guards.rs:131<br>`STAGING` page_body.rs:52 | `BODY_STAGING_KIND` write_guards.rs:132<br>`STAGING` page_body.rs:52 | `BODY_STAGING_KIND` write_guards.rs:131<br>`STAGING` page_body.rs:52 |
| `PAGE_BODY` (`b'b'`) | `0x04` | `DERIVATION` page_body.rs:53 | `DERIVATION` page_body.rs:53 | `DERIVATION` page_body.rs:53 |
| `PAGE_BODY` (`b'b'`) | `0x05` | `BODY` page_body.rs:54 | `BODY` page_body.rs:54 | `BODY` page_body.rs:54 |
| `PAGE_BODY` (`b'b'`) | `0x06` | `STAGING_CLIENT` page_body.rs:55 | `STAGING_CLIENT` page_body.rs:55 | `STAGING_CLIENT` page_body.rs:55 |
| `PAGE_BODY` (`b'b'`) | `0x07` | `STAGING_TEXT` page_body.rs:56 | `STAGING_TEXT` page_body.rs:56 | `STAGING_TEXT` page_body.rs:56 |
| `PAGE_BODY` (`b'b'`) | `0x08` | `STAGING_BY_PAGE` page_body.rs:57 | `STAGING_BY_PAGE` page_body.rs:57 | `STAGING_BY_PAGE` page_body.rs:57 |
| `PAGE_OPS` (`b'p'`) | `0x01` | `RETRIEVAL` page_ops/retrievals.rs:20 | - | - |
| `PERSISTENCE` (`b'd'`) | `0x01` | `COUNTER` persistence.rs:64 | `COUNTER` persistence.rs:70 | `COUNTER` persistence.rs:65 |
| `PERSISTENCE` (`b'd'`) | `0x02` | `HOUSEKEEPING` persistence.rs:66 | `HOUSEKEEPING` persistence.rs:72 | `HOUSEKEEPING` persistence.rs:67 |
| `PERSISTENCE` (`b'd'`) | `0x03` | `TOPOLOGY` persistence.rs:68 | `TOPOLOGY` persistence.rs:74 | `TOPOLOGY` persistence.rs:69 |
| `PERSISTENCE` (`b'd'`) | `0x04` | `QUEUE` persistence.rs:70 | `QUEUE` persistence.rs:76 | `QUEUE` persistence.rs:71 |
| `PERSISTENCE` (`b'd'`) | `0x05` | - | `EFFECT` persistence/effects.rs:28 | `EFFECT` persistence/effects.rs:28 |
| `PERSISTENCE` (`b'd'`) | `0x06` | - | `EFFECT_ORDER` persistence/effects.rs:30 | `EFFECT_ORDER` persistence/effects.rs:30 |
| `RAW_FILES` (`b'r'`) | `0x01` | `RAW` raw_files.rs:37 | `RAW` raw_files.rs:37 | `RAW` raw_files.rs:37 |
| `RAW_FILES` (`b'r'`) | `0x02` | `FILE` raw_files.rs:39 | `FILE` raw_files.rs:39 | `FILE` raw_files.rs:39 |
| `RAW_FILES` (`b'r'`) | `0x03` | `FILE_BY_PAGE` raw_files.rs:40 | `FILE_BY_PAGE` raw_files.rs:40 | `FILE_BY_PAGE` raw_files.rs:40 |
| `TAKE` (`b'A'`) | `0x01` | `TAKE` takes.rs:41 | `TAKE` takes.rs:41 | `TAKE` takes.rs:39 |
| `TAKE` (`b'A'`) | `0x02` | `BY_ROW` takes.rs:42 | `BY_ROW` takes.rs:42 | `BY_ROW` takes.rs:40 |
| `TAKE` (`b'A'`) | `0x03` | `EVIDENCE` takes.rs:43 | `EVIDENCE` takes.rs:43 | `EVIDENCE` takes.rs:41 |
| `TAKE` (`b'A'`) | `0x04` | `CITED` takes.rs:44 | `CITED` takes.rs:44 | `CITED` takes.rs:42 |
| `TIMELINE_QUERIES` (`b'u'`) | `0x01` | `EVENT_INDEX` timeline_queries.rs:60 | `EVENT_INDEX` timeline_queries.rs:60 | `EVENT_INDEX` timeline_queries.rs:60 |
| `TRUST` (`b't'`) | `0x01` | `WITHDRAWAL` trust/withdrawals.rs:24 | `WITHDRAWAL` trust/withdrawals.rs:23 | `WITHDRAWAL` trust/withdrawals.rs:23 |
| `TRUST` (`b't'`) | `0x02` | `RECEIPT` trust/write_gate.rs:27 | `RECEIPT` trust/write_gate.rs:27 | `RECEIPT` trust/write_gate.rs:27 |
| `TRUST` (`b't'`) | `0x03` | `RECEIPT_TARGET` trust/write_gate.rs:29 | `RECEIPT_TARGET` trust/write_gate.rs:29 | `RECEIPT_TARGET` trust/write_gate.rs:29 |
| `TRUST` (`b't'`) | `0x04` | `HOLD` trust/write_gate.rs:30 | `HOLD` trust/write_gate.rs:30 | `HOLD` trust/write_gate.rs:30 |
| `TRUST` (`b't'`) | `0x05` | `HOLD_DEDUPE` trust/write_gate.rs:31 | `HOLD_DEDUPE` trust/write_gate.rs:31 | `HOLD_DEDUPE` trust/write_gate.rs:31 |
| `TRUST` (`b't'`) | `0x06` | `PROPOSAL` trust/proposals.rs:34 | `PROPOSAL` trust/proposals.rs:34 | `PROPOSAL` trust/proposals.rs:34 |
| `TRUST` (`b't'`) | `0x07` | `PENDING` trust/proposals.rs:36 | `PENDING` trust/proposals.rs:36 | `PENDING` trust/proposals.rs:36 |
| `TRUST` (`b't'`) | `0x08` | `BY_ROW` trust/proposals.rs:37 | `BY_ROW` trust/proposals.rs:37 | `BY_ROW` trust/proposals.rs:37 |

Telemetry (`a`) sub-tags are constants in `keys.rs` itself and are not repeated above: `0x01`
search_telemetry, `0x02` mcp_request_log, `0x03` mcp_request_log_rollup, `0x04` retrieval_events, `0x05`
retrieval_event_pages, `0x06` retrieval_event_links, `0x07` retrieval_feedback, `0x08` retrieval_weights,
`0x09` budget_ledger, `0x0A` budget_reservations, `0x0B` chat_usage_log. Families with no sub-tag: `s`
SALIENCE, `n` INGEST_LOG, `f` DREAM_SYNTHESIS_COMPLETION, `w` LOCK_QUEUE (reserved), `c` CHUNK_QUERIES, `v`
RELATION_CATALOG, and the core families whose key goes straight to an id or text.


## Sites the census does not reach, by file

Census hits are 0 for every site here. Sorted by site count, then file. Per-site lines, functions and the
static CLI and MCP reach are in the TSV.

| File | Sites | Fail-soft | Lane | First lines |
|---|---|---|---|---|
| `src/core/persistence/journal.ts` | 42 | 1 | 7 | 147, 396, 433, 444, 512, 533, ... |
| `src/core/page-state/projections.ts` | 37 | 7 | 7 | 128, 130, 184, 227, 241, 243, ... |
| `src/core/facts/purge.ts` | 36 | 0 | 4 | 127, 153, 167, 177, 180, 195, ... |
| `src/core/persistence/graduation-copy.ts` | 36 | 1 | - | 47, 94, 98, 104, 110, 112, ... |
| `src/core/embedding-migration.ts` | 34 | 13 | - | 89, 137, 138, 139, 150, 158, ... |
| `src/core/mentions/pass.ts` | 33 | 0 | 6 | 148, 162, 183, 236, 239, 245, ... |
| `src/core/page-body/segment-derive.ts` | 33 | 11 | 3 | 90, 94, 184, 224, 343, 361, ... |
| `src/core/persistence/source-lifecycle.ts` | 33 | 24 | -/9 | 90, 107, 108, 109, 112, 127, ... |
| `src/core/access/policy.ts` | 31 | 0 | 11 | 92, 99, 104, 112, 113, 117, ... |
| `src/core/persistence/page-purge.ts` | 30 | 0 | - | 96, 97, 104, 143, 148, 189, ... |
| `src/core/persistence/sync-holds.ts` | 30 | 0 | 9/- | 325, 343, 359, 386, 447, 468, ... |
| `src/core/persistence/worktree-refresh.ts` | 30 | 6 | - | 121, 141, 179, 224, 225, 434, ... |
| `src/core/persistence/sync-run.ts` | 28 | 4 | -/9 | 227, 232, 248, 250, 251, 273, ... |
| `src/core/shared-skills/restore.ts` | 27 | 0 | - | 41, 46, 48, 58, 59, 60, ... |
| `src/commands/migrate-engine.ts` | 26 | 10 | 2 | 136, 144, 194, 202, 265, 281, ... |
| `src/core/persistence/connector-sync.ts` | 26 | 4 | -/9 | 295, 434, 457, 459, 464, 480, ... |
| `src/core/access/members.ts` | 25 | 5 | 11 | 124, 144, 161, 191, 199, 231, ... |
| `src/core/belief/purge-mirror.ts` | 24 | 0 | 4 | 113, 129, 130, 133, 159, 162, ... |
| `src/core/facts/conversation-publication.ts` | 24 | 0 | 4 | 195, 222, 248, 275, 303, 342, ... |
| `src/core/persistence/ownership.ts` | 24 | 0 | - | 113, 114, 117, 130, 141, 142, ... |
| `src/core/repair/secret-spans.ts` | 24 | 0 | -/9 | 131, 155, 157, 159, 160, 161, ... |
| `src/core/oauth-provider.ts` | 22 | 11 | - | 329, 454, 467, 479, 494, 510, ... |
| `src/core/persistence/atom-maintenance.ts` | 21 | 0 | -/9 | 118, 134, 192, 227, 241, 246, ... |
| `src/core/persistence/effect-journal.ts` | 21 | 0 | 7 | 46, 98, 116, 160, 192, 221, ... |
| `src/core/facts/purge-verify.ts` | 20 | 5 | 4 | 86, 88, 165, 167, 214, 215, ... |
| `src/core/persistence/topology-locks.ts` | 20 | 0 | - | 30, 45, 61, 64, 113, 124, ... |
| `src/core/belief/purge.ts` | 19 | 0 | 4 | 51, 56, 95, 103, 123, 136, ... |
| `src/core/generations/publish.ts` | 19 | 1 | 3 | 71, 76, 80, 100, 101, 108, ... |
| `src/core/persistence/deactivation.ts` | 19 | 1 | - | 108, 117, 126, 150, 170, 192, ... |
| `src/core/persistence/effects.ts` | 19 | 5 | 7 | 117, 134, 164, 435, 546, 550, ... |
| `src/core/persistence/topology-clone.ts` | 19 | 18 | - | 41, 103, 104, 105, 108, 109, ... |
| `src/core/repair/failed-writes.ts` | 19 | 1 | - | 95, 134, 138, 176, 188, 217, ... |
| `src/core/feedback/store.ts` | 18 | 0 | - | 71, 79, 93, 104, 110, 114, ... |
| `src/core/persistence/effect-recovery.ts` | 18 | 0 | 7 | 37, 39, 58, 77, 93, 94, ... |
| `src/core/persistence/engine-graduation.ts` | 18 | 4 | - | 431, 441, 449, 479, 504, 657, ... |
| `src/core/ai/decide/review-lane.ts` | 17 | 0 | 5 | 103, 140, 148, 152, 163, 174, ... |
| `src/core/ai/decide/store.ts` | 17 | 0 | 5 | 100, 208, 213, 221, 232, 274, ... |
| `src/core/attendance-repair.ts` | 17 | 0 | -/9 | 100, 128, 138, 144, 180, 185, ... |
| `src/core/destructive-guard.ts` | 17 | 3 | - | 104, 119, 183, 192, 199, 208, ... |
| `src/core/persistence/sync-prepare.ts` | 17 | 0 | -/9 | 172, 197, 396, 563, 574, 625, ... |
| `src/core/persistence/topology-recovery.ts` | 17 | 6 | - | 35, 83, 84, 85, 89, 91, ... |
| `src/core/shared-skills/membership.ts` | 17 | 1 | - | 100, 132, 146, 148, 155, 163, ... |
| `src/core/ai/decide/proposals-store.ts` | 16 | 0 | 5 | 28, 53, 62, 91, 115, 125, ... |
| `src/core/oauth-grants.ts` | 16 | 1 | - | 136, 172, 184, 252, 274, 284, ... |
| `src/core/persistence/git-conversion.ts` | 16 | 1 | -/9 | 220, 282, 390, 568, 615, 635, ... |
| `src/core/persistence/page-upload.ts` | 16 | 0 | - | 139, 144, 156, 199, 200, 202, ... |
| `src/core/persistence/twin-merge.ts` | 16 | 0 | -/9 | 73, 76, 79, 82, 89, 103, ... |
| `src/commands/serve-http-admin-api.ts` | 15 | 10 | 2 | 76, 84, 85, 90, 93, 209, ... |
| `src/commands/sources-git-gap.ts` | 15 | 0 | 2/9 | 153, 167, 175, 176, 178, 189, ... |
| `src/core/persistence/graduation-verify.ts` | 15 | 2 | - | 94, 94, 108, 119, 133, 143, ... |
| `src/core/persistence/physical-root.ts` | 15 | 0 | - | 16, 35, 48, 53, 67, 69, ... |
| `src/core/trust/backfill.ts` | 15 | 0 | -/9 | 118, 266, 272, 297, 309, 356, ... |
| `src/core/trust/review.ts` | 15 | 0 | - | 122, 126, 130, 140, 174, 193, ... |
| `src/core/company-brain/runtime.ts` | 14 | 8 | -/9 | 64, 95, 138, 139, 153, 155, ... |
| `src/core/notifier/store.ts` | 14 | 0 | - | 104, 119, 123, 133, 146, 153, ... |
| `src/core/persistence/effect-retry.ts` | 14 | 1 | 7 | 33, 135, 136, 138, 153, 176, ... |
| `src/core/persistence/managed-sync-orphans.ts` | 14 | 0 | -/9 | 135, 170, 182, 196, 215, 244, ... |
| `src/core/persistence/sync-pass-run.ts` | 14 | 0 | -/9 | 117, 208, 220, 306, 344, 350, ... |
| `src/core/persistence/sync-pass.ts` | 14 | 0 | -/9 | 382, 460, 468, 468, 472, 488, ... |
| `src/core/planner-stats.ts` | 14 | 0 | - | 108, 111, 158, 178, 213, 214, ... |
| `src/core/questions/refresh.ts` | 14 | 6 | - | 141, 195, 200, 225, 239, 246, ... |
| `src/core/shared-skills/publication.ts` | 14 | 0 | - | 97, 113, 157, 245, 254, 433, ... |
| `src/commands/sources.ts` | 13 | 3 | 2 | 304, 842, 922, 933, 970, 1121, ... |
| `src/core/cycle/edge-contradictions.ts` | 13 | 0 | - | 201, 223, 288, 303, 448, 481, ... |
| `src/core/generations/adapters/chronicle-events.ts` | 13 | 0 | 3 | 63, 112, 119, 126, 150, 165, ... |
| `src/core/page-embedding-budget.ts` | 13 | 0 | - | 134, 142, 159, 165, 171, 172, ... |
| `src/core/persistence/prepared-maintenance.ts` | 13 | 0 | - | 82, 99, 144, 400, 574, 617, ... |
| `src/core/persistence/topology-receipts.ts` | 13 | 0 | - | 12, 53, 54, 55, 91, 97, ... |
| `src/core/repair/conversation-labels.ts` | 13 | 0 | - | 119, 174, 185, 223, 225, 243, ... |
| `src/eval/brainbench/trust-scenario.ts` | 13 | 2 | - | 210, 215, 220, 244, 258, 277, ... |
| `src/core/backfill-base.ts` | 12 | 11 | - | 173, 204, 213, 297, 302, 315, ... |
| `src/core/belief/coverage-report.ts` | 12 | 0 | 4 | 53, 83, 87, 92, 100, 117, ... |
| `src/core/company-brain/admission.ts` | 12 | 0 | -/9 | 117, 152, 159, 161, 182, 195, ... |
| `src/core/facts/held-fact-move.ts` | 12 | 5 | 4 | 57, 65, 86, 169, 174, 193, ... |
| `src/core/grants/legacy-token.ts` | 12 | 2 | - | 193, 211, 240, 241, 319, 323, ... |
| `src/core/migration-preludes.ts` | 12 | 1 | - | 58, 59, 86, 95, 119, 123, ... |
| `src/core/page-state/revision-backfill-schema.ts` | 12 | 0 | 7 | 55, 60, 62, 82, 95, 105, ... |
| `src/core/persistence/connector-checkpoint-migration.ts` | 12 | 0 | 9/- | 30, 84, 93, 109, 112, 128, ... |
| `src/core/persistence/skill-activation.ts` | 12 | 0 | - | 22, 50, 52, 55, 56, 57, ... |
| `src/core/repair/file-drift-class.ts` | 12 | 0 | 9/- | 187, 188, 206, 302, 304, 310, ... |
| `src/core/schema-migrations/helpers.ts` | 12 | 4 | - | 62, 94, 99, 99, 101, 126, ... |
| `src/core/transcripts/archive.ts` | 12 | 0 | - | 385, 390, 435, 465, 488, 522, ... |
| `src/commands/doctor/checks/extraction-sync.ts` | 11 | 11 | 2 | 178, 220, 373, 377, 405, 472, ... |
| `src/core/cycle/extract-facts.ts` | 11 | 0 | - | 202, 219, 457, 526, 529, 536, ... |
| `src/core/entities/resolve.ts` | 11 | 8 | - | 162, 360, 485, 528, 569, 576, ... |
| `src/core/grants/service.ts` | 11 | 1 | - | 15, 24, 73, 89, 123, 166, ... |
| `src/core/loops/loops-store.ts` | 11 | 0 | - | 153, 197, 243, 246, 265, 287, ... |
| `src/core/ops/files.ts` | 11 | 1 | - | 129, 131, 134, 146, 166, 266, ... |
| `src/core/page-state/guards.ts` | 11 | 0 | 7 | 32, 43, 46, 47, 49, 64, ... |
| `src/core/persistence/canonical-projections.ts` | 11 | 0 | - | 605, 637, 643, 682, 693, 697, ... |
| `src/core/persistence/graduation-drain.ts` | 11 | 0 | - | 47, 61, 71, 81, 89, 92, ... |
| `src/core/persistence/group-publish.ts` | 11 | 0 | - | 167, 167, 212, 212, 299, 344, ... |
| `src/core/persistence/sync-status.ts` | 11 | 1 | -/9 | 296, 304, 361, 380, 417, 565, ... |
| `src/core/repair/open-facts.ts` | 11 | 2 | - | 111, 126, 238, 348, 386, 395, ... |
| `src/core/repair/origin-twins.ts` | 11 | 0 | - | 95, 139, 144, 151, 172, 219, ... |
| `src/core/search/projection-statistics.ts` | 11 | 6 | 6 | 41, 111, 135, 158, 159, 213, ... |
| `src/core/shared-skills/retention.ts` | 11 | 0 | - | 62, 82, 91, 92, 99, 143, ... |
| `src/core/trust/supersede-handlers.ts` | 11 | 0 | - | 169, 208, 238, 248, 319, 326, ... |
| `src/core/context/proactive-brief.ts` | 10 | 2 | 10 | 203, 247, 279, 308, 341, 424, ... |
| `src/core/cycle/extract-takes.ts` | 10 | 0 | - | 110, 119, 130, 164, 187, 215, ... |
| `src/core/derived-links.ts` | 10 | 0 | - | 124, 167, 270, 272, 277, 281, ... |
| `src/core/page-body/projection.ts` | 10 | 2 | 3 | 53, 83, 89, 103, 105, 126, ... |
| `src/core/page-state/rename-alias.ts` | 10 | 8 | 7 | 28, 31, 33, 34, 42, 43, ... |
| `src/core/persistence/bounded-reads.ts` | 10 | 3 | - | 123, 131, 202, 210, 216, 217, ... |
| `src/core/persistence/derived-origin-hold.ts` | 10 | 0 | 9 | 37, 62, 67, 74, 81, 88, ... |
| `src/core/persistence/intent-redaction.ts` | 10 | 0 | - | 68, 137, 209, 226, 236, 248, ... |
| `src/core/persistence/page-visibility.ts` | 10 | 1 | - | 81, 86, 93, 129, 151, 155, ... |
| `src/core/persistence/recovery-resolve.ts` | 10 | 0 | -/9 | 234, 381, 430, 463, 464, 486, ... |
| `src/core/repair/lost-fence-rows.ts` | 10 | 0 | - | 91, 107, 118, 121, 122, 136, ... |
| `src/core/repair/visibility.ts` | 10 | 0 | - | 90, 97, 116, 151, 170, 183, ... |
| `src/core/timeline-dedup-repair.ts` | 10 | 0 | 6 | 87, 128, 148, 152, 204, 211, ... |
| `src/commands/agent-register.ts` | 9 | 3 | 2 | 455, 548, 551, 552, 627, 634, ... |
| `src/core/backup/quarantine.ts` | 9 | 0 | - | 40, 61, 64, 67, 72, 79, ... |
| `src/core/calibration/undo-wave.ts` | 9 | 0 | - | 105, 115, 123, 146, 155, 165, ... |
| `src/core/chronicle/execute.ts` | 9 | 0 | - | 87, 103, 125, 130, 156, 175, ... |
| `src/core/chronicle/ledger.ts` | 9 | 0 | - | 84, 97, 98, 101, 109, 135, ... |
| `src/core/company-brain/receipts.ts` | 9 | 0 | - | 130, 137, 141, 158, 166, 182, ... |
| `src/core/connectors/item-holds-store.ts` | 9 | 0 | 9/- | 76, 137, 196, 204, 218, 221, ... |
| `src/core/cycle/phases/consolidate.ts` | 9 | 5 | - | 139, 142, 170, 277, 285, 362, ... |
| `src/core/facts/withdrawal.ts` | 9 | 0 | 4 | 70, 102, 112, 140, 144, 152, ... |
| `src/core/page-body/segment-rewrite.ts` | 9 | 0 | 3 | 79, 174, 194, 216, 236, 238, ... |
| `src/core/page-state/versions.ts` | 9 | 0 | 7 | 28, 41, 44, 49, 75, 98, ... |
| `src/core/persistence/activation.ts` | 9 | 0 | - | 112, 146, 153, 191, 225, 243, ... |
| `src/core/persistence/coordinator.ts` | 9 | 3 | - | 534, 609, 620, 785, 795, 797, ... |
| `src/core/persistence/memory-proposals.ts` | 9 | 0 | - | 123, 124, 127, 130, 136, 165, ... |
| `src/core/persistence/page-prepare.ts` | 9 | 0 | - | 503, 530, 545, 590, 622, 782, ... |
| `src/core/persistence/segmented-apply.ts` | 9 | 0 | - | 58, 79, 104, 170, 179, 205, ... |
| `src/core/persistence/sync-failures.ts` | 9 | 0 | -/9 | 56, 57, 86, 97, 117, 124, ... |
| `src/core/persistence/sync-markers.ts` | 9 | 0 | 9/- | 92, 119, 122, 136, 145, 155, ... |
| `src/core/persistence/sync-page-fault.ts` | 9 | 0 | - | 75, 78, 95, 98, 102, 127, ... |
| `src/core/repair/agent-session-facts.ts` | 9 | 1 | - | 299, 334, 338, 423, 458, 465, ... |
| `src/core/search/fact-relevance.ts` | 9 | 0 | 6 | 156, 228, 231, 232, 233, 277, ... |
| `src/core/shared-skills/policy.ts` | 9 | 0 | - | 45, 95, 146, 149, 152, 177, ... |
| `src/core/timeline-extract.ts` | 9 | 0 | 6 | 316, 404, 412, 439, 441, 469, ... |
| `src/core/trust/claim.ts` | 9 | 0 | - | 69, 109, 116, 146, 149, 153, ... |
| `src/core/vector-index.ts` | 9 | 4 | - | 41, 96, 119, 120, 179, 216, ... |
| `src/commands/access-serves.ts` | 8 | 1 | 2 | 135, 136, 186, 197, 241, 251, ... |
| `src/commands/doctor/checks/content-quality.ts` | 8 | 8 | 2 | 62, 80, 126, 137, 148, 296, ... |
| `src/commands/files.ts` | 8 | 1 | 2 | 191, 206, 304, 379, 461, 476, ... |
| `src/core/access/attest-sources.ts` | 8 | 0 | 11 | 73, 75, 76, 101, 102, 177, ... |
| `src/core/access/member-sources.ts` | 8 | 1 | 11 | 30, 45, 47, 59, 63, 70, ... |
| `src/core/access/open-pages.ts` | 8 | 0 | 11 | 69, 82, 95, 97, 130, 159, ... |
| `src/core/belief/backfill.ts` | 8 | 0 | 4 | 59, 77, 98, 106, 169, 176, ... |
| `src/core/belief/page-at-time.ts` | 8 | 0 | 4 | 87, 137, 176, 189, 202, 240, ... |
| `src/core/cycle/phantom-redirect.ts` | 8 | 0 | - | 417, 421, 433, 450, 459, 564, ... |
| `src/core/embed-facts.ts` | 8 | 4 | - | 75, 83, 95, 153, 170, 191, ... |
| `src/core/embedding-ann-build.ts` | 8 | 2 | - | 58, 100, 102, 103, 105, 115, ... |
| `src/core/embedding-invalidation.ts` | 8 | 0 | - | 66, 125, 158, 193, 240, 245, ... |
| `src/core/facts/purge-reasons.ts` | 8 | 0 | 4 | 34, 63, 82, 99, 110, 118, ... |
| `src/core/facts/withdrawal-discovery.ts` | 8 | 0 | 4 | 26, 81, 117, 130, 145, 157, ... |
| `src/core/fence-repair/census-store.ts` | 8 | 0 | 9 | 92, 98, 106, 117, 119, 142, ... |
| `src/core/google/loop-catchup.ts` | 8 | 1 | -/9 | 85, 124, 214, 228, 240, 265, ... |
| `src/core/links-fence-projection.ts` | 8 | 0 | 6 | 44, 50, 53, 79, 80, 82, ... |
| `src/core/page-body/rechunk.ts` | 8 | 1 | 3 | 77, 109, 141, 166, 167, 179, ... |
| `src/core/page-body/segmented-embedding.ts` | 8 | 0 | 3 | 60, 78, 86, 101, 148, 181, ... |
| `src/core/persistence/administration.ts` | 8 | 0 | - | 75, 289, 297, 307, 326, 348, ... |
| `src/core/persistence/drift-conflicts.ts` | 8 | 4 | - | 149, 184, 326, 331, 342, 346, ... |
| `src/core/persistence/effect-links.ts` | 8 | 0 | 7 | 84, 88, 110, 129, 231, 239, ... |
| `src/core/persistence/graduation-schema.ts` | 8 | 0 | - | 99, 151, 187, 193, 216, 255, ... |
| `src/core/persistence/manual-links.ts` | 8 | 0 | - | 34, 37, 132, 162, 170, 175, ... |
| `src/core/persistence/sync-pass-confirm.ts` | 8 | 0 | - | 75, 134, 134, 134, 135, 135, ... |
| `src/core/persistence/sync-waivers.ts` | 8 | 4 | - | 39, 141, 207, 215, 227, 289, ... |
| `src/core/persistence/unindexed-files.ts` | 8 | 0 | -/9 | 223, 235, 249, 251, 284, 304, ... |
| `src/core/repair/extractor-facts.ts` | 8 | 0 | - | 173, 207, 220, 224, 241, 335, ... |
| `src/core/repair/frontmatter.ts` | 8 | 0 | - | 199, 234, 247, 432, 458, 479, ... |
| `src/core/repair/legacy-twins.ts` | 8 | 0 | - | 192, 206, 221, 303, 333, 357, ... |
| `src/core/schema-migrations/v142-takes-embedding-dimension-matches-config.ts` | 8 | 0 | - | 13, 17, 25, 38, 41, 42, ... |
| `src/core/sync-identity-downgrades.ts` | 8 | 1 | -/9 | 51, 84, 91, 100, 113, 151, ... |
| `src/core/take-proposals.ts` | 8 | 1 | - | 108, 131, 186, 262, 264, 317, ... |
| `src/core/trust/fence-guard.ts` | 8 | 0 | - | 70, 74, 104, 124, 155, 186, ... |
| `src/core/trust/page-write.ts` | 8 | 0 | - | 191, 225, 229, 232, 287, 293, ... |
| `src/commands/doctor/checks/core-health.ts` | 7 | 7 | 2 | 151, 280, 288, 492, 569, 580, ... |
| `src/core/access/actor.ts` | 7 | 3 | 11 | 50, 55, 170, 315, 329, 343, ... |
| `src/core/belief/append.ts` | 7 | 0 | 4 | 81, 100, 117, 124, 153, 175, ... |
| `src/core/chunkers/symbol-resolver.ts` | 7 | 0 | - | 148, 165, 201, 233, 278, 286, ... |
| `src/core/context/session-state.ts` (removed on d972a45b41) | 7 | 7 | 10 | 113, 148, 201, 299, 355, 389, ... |
| `src/core/cycle/patterns.ts` | 7 | 1 | - | 177, 627, 752, 859, 930, 966, ... |
| `src/core/generations/ledger-scrub.ts` | 7 | 0 | 3 | 20, 22, 24, 27, 34, 36, ... |
| `src/core/generations/managed.ts` | 7 | 0 | 3 | 130, 151, 185, 198, 213, 221, ... |
| `src/core/grants/lifecycle.ts` | 7 | 0 | - | 21, 29, 30, 31, 32, 33, ... |
| `src/core/grants/rescope.ts` | 7 | 5 | - | 72, 79, 97, 109, 117, 127, ... |
| `src/core/guests/sources.ts` | 7 | 0 | - | 36, 61, 91, 94, 96, 108, ... |
| `src/core/mentions/referrers.ts` | 7 | 0 | 6 | 143, 179, 192, 200, 440, 448, ... |
| `src/core/minions/authorize-legacy.ts` | 7 | 0 | - | 36, 37, 39, 56, 67, 104, ... |
| `src/core/minions/worker.ts` | 7 | 5 | - | 403, 405, 749, 997, 1020, 1030, ... |
| `src/core/ops/attribution.ts` | 7 | 0 | - | 55, 57, 59, 61, 90, 181, ... |
| `src/core/persistence/admin-lock.ts` | 7 | 0 | - | 28, 37, 47, 48, 52, 58, ... |
| `src/core/persistence/connector-state.ts` | 7 | 0 | -/9 | 122, 136, 151, 153, 166, 185, ... |
| `src/core/persistence/diagnostics.ts` | 7 | 1 | - | 100, 159, 169, 171, 177, 181, ... |
| `src/core/persistence/effect-facts.ts` | 7 | 0 | 7 | 42, 59, 69, 120, 136, 138, ... |
| `src/core/persistence/effect-settle.ts` | 7 | 0 | 7 | 74, 121, 179, 181, 196, 207, ... |
| `src/core/persistence/effect-targets.ts` | 7 | 0 | 7 | 25, 30, 32, 33, 37, 48, ... |
| `src/core/persistence/embedding-settlement.ts` | 7 | 0 | - | 66, 105, 113, 121, 140, 177, ... |
| `src/core/persistence/forget-prepare.ts` | 7 | 0 | - | 51, 54, 68, 98, 108, 159, ... |
| `src/core/persistence/git-declared.ts` | 7 | 0 | - | 92, 233, 248, 257, 266, 269, ... |
| `src/core/persistence/import-reads.ts` | 7 | 0 | - | 130, 135, 140, 143, 146, 152, ... |
| `src/core/persistence/moved-pages.ts` | 7 | 0 | - | 117, 123, 127, 128, 137, 140, ... |
| `src/core/persistence/pre-activation-release.ts` | 7 | 0 | - | 34, 72, 79, 80, 86, 87, ... |
| `src/core/persistence/purge-deleted.ts` | 7 | 1 | - | 113, 165, 259, 273, 399, 436, ... |
| `src/core/persistence/sync-cursor-key.ts` | 7 | 0 | -/9 | 78, 157, 159, 166, 169, 180, ... |
| `src/core/persistence/takes-prepare.ts` | 7 | 0 | - | 179, 196, 256, 261, 270, 276, ... |
| `src/core/repair/attribution-backfill.ts` | 7 | 0 | - | 39, 40, 43, 106, 111, 129, ... |
| `src/core/repair/purged-change-reasons.ts` | 7 | 0 | - | 52, 65, 88, 99, 108, 190, ... |
| `src/core/repair/rename-identity.ts` | 7 | 0 | -/9 | 82, 92, 243, 251, 252, 257, ... |
| `src/core/repair/segmented-tiling.ts` | 7 | 0 | -/9 | 91, 156, 222, 243, 256, 323, ... |
| `src/core/schema-migrations/v144-open-loops.ts` | 7 | 0 | - | 82, 89, 102, 103, 104, 105, ... |
| `src/core/search/query-cache.ts` | 7 | 6 | 6 | 242, 278, 352, 387, 394, 407, ... |
| `src/core/shared-skills/migration-export.ts` | 7 | 1 | - | 76, 188, 189, 195, 198, 218, ... |
| `src/core/trust/page-handlers.ts` | 7 | 0 | - | 86, 117, 124, 156, 157, 222, ... |
| `src/eval/brainbench/metrics/trust-reads.ts` | 7 | 0 | - | 39, 57, 77, 107, 116, 119, ... |
| `src/cli/enforced-member.ts` | 6 | 1 | - | 178, 195, 370, 374, 420, 547 |
| `src/commands/auth.ts` | 6 | 2 | 2 | 210, 237, 381, 588, 684, 1118 |
| `src/commands/core.ts` | 6 | 1 | 2 | 101, 193, 205, 219, 221, 225 |
| `src/commands/doctor/checks/routing-federation.ts` | 6 | 6 | 2 | 53, 188, 256, 283, 289, 308 |
| `src/commands/extract-mentions-explain.ts` | 6 | 1 | 2 | 80, 102, 117, 134, 138, 152 |
| `src/commands/migrate-embeddings.ts` | 6 | 4 | 2 | 569, 632, 633, 676, 777, 843 |
| `src/commands/migrations/v0_18_0-storage-backfill.ts` | 6 | 5 | 2 | 76, 114, 128, 132, 145, 160 |
| `src/core/belief/lifetimes.ts` | 6 | 0 | 4 | 19, 26, 31, 35, 41, 57 |
| `src/core/bootstrap/verify.ts` | 6 | 6 | - | 254, 256, 274, 762, 922, 1210 |
| `src/core/budget/daily-ledger.ts` | 6 | 4 | - | 137, 144, 157, 169, 179, 186 |
| `src/core/by-mention.ts` | 6 | 1 | - | 517, 527, 550, 1101, 1140, 1152 |
| `src/core/cycle/extract-atoms-input.ts` | 6 | 5 | -/9 | 105, 109, 113, 133, 149, 157 |
| `src/core/cycle/phantom-redirect-managed.ts` | 6 | 0 | - | 47, 97, 98, 104, 106, 122 |
| `src/core/embedding-migration-retention.ts` | 6 | 6 | - | 14, 15, 25, 47, 52, 62 |
| `src/core/facts/derivation-inputs.ts` | 6 | 0 | 4 | 39, 58, 90, 91, 92, 95 |
| `src/core/fence-repair/census.ts` | 6 | 1 | - | 94, 104, 108, 151, 163, 352 |
| `src/core/generations/adapters/fact-rows.ts` | 6 | 0 | 3 | 50, 84, 114, 137, 144, 152 |
| `src/core/generations/repair.ts` | 6 | 0 | 3 | 115, 147, 183, 199, 224, 299 |
| `src/core/grants/migration.ts` | 6 | 0 | - | 11, 14, 16, 29, 32, 39 |
| `src/core/minions/rate-leases.ts` | 6 | 0 | - | 81, 84, 89, 99, 119, 134 |
| `src/core/op-checkpoint.ts` | 6 | 2 | 9/- | 200, 230, 251, 276, 281, 514 |
| `src/core/oversized-backfill.ts` | 6 | 0 | - | 87, 95, 113, 121, 122, 191 |
| `src/core/page-body/read-range.ts` | 6 | 0 | 3 | 177, 199, 220, 235, 253, 631 |
| `src/core/pages-upsert-arbiter.ts` | 6 | 0 | - | 63, 80, 93, 129, 130, 131 |
| `src/core/persistence/local-edit-adoption.ts` | 6 | 0 | - | 138, 142, 195, 217, 283, 356 |
| `src/core/persistence/purge-parks.ts` | 6 | 0 | 9 | 48, 55, 60, 67, 76, 80 |
| `src/core/persistence/sync-discovery.ts` | 6 | 0 | - | 274, 540, 611, 650, 699, 776 |
| `src/core/questions/store.ts` | 6 | 0 | - | 104, 133, 146, 165, 176, 183 |
| `src/core/repair/captured-facts.ts` | 6 | 2 | - | 238, 254, 283, 318, 362, 381 |
| `src/core/repair/duplicate-facts.ts` | 6 | 0 | - | 73, 103, 120, 193, 221, 253 |
| `src/core/repair/file-drift.ts` | 6 | 0 | - | 323, 357, 656, 719, 725, 970 |
| `src/core/repair/orphan-children.ts` | 6 | 2 | - | 51, 53, 56, 70, 78, 90 |
| `src/core/repair/redacted-facts.ts` | 6 | 1 | - | 155, 167, 224, 228, 304, 378 |
| `src/core/schema-migrations/v210-clamp-oauth-token-ttl.ts` | 6 | 0 | - | 30, 38, 39, 44, 51, 53 |
| `src/core/shared-skills/setup.ts` | 6 | 0 | - | 21, 73, 124, 210, 234, 253 |
| `src/core/trust/owner-actions.ts` | 6 | 0 | - | 145, 169, 183, 188, 194, 209 |
| `src/core/wakeshift/forget.ts` | 6 | 6 | - | 23, 25, 27, 31, 34, 36 |
| `src/commands/access.ts` | 5 | 0 | 2 | 168, 194, 205, 208, 261 |
| `src/commands/doctor/checks/persistence-requests.ts` | 5 | 5 | 2 | 79, 81, 89, 153, 219 |
| `src/commands/doctor/skill-checks.ts` | 5 | 5 | 2 | 239, 246, 257, 267, 282 |
| `src/commands/edge-proposals.ts` | 5 | 0 | 2 | 101, 114, 126, 139, 144 |
| `src/commands/import.ts` | 5 | 3 | 2/9 | 82, 632, 825, 1139, 1180 |
| `src/commands/init-prefer-postgres.ts` | 5 | 5 | 2 | 116, 120, 267, 270, 282 |
| `src/commands/reindex-multimodal.ts` | 5 | 0 | 2 | 115, 125, 238, 285, 310 |
| `src/commands/serve-http-registration.ts` | 5 | 5 | 2 | 123, 168, 199, 202, 203 |
| `src/commands/sources-harden.ts` | 5 | 1 | 2 | 61, 65, 69, 163, 197 |
| `src/core/access/caller.ts` | 5 | 5 | 11 | 202, 206, 210, 259, 263 |
| `src/core/backup/snapshot.ts` | 5 | 4 | - | 160, 284, 286, 293, 295 |
| `src/core/belief/coverage.ts` | 5 | 0 | 4 | 27, 41, 93, 98, 141 |
| `src/core/cycle/derived-write-through.ts` | 5 | 1 | -/9 | 118, 124, 142, 299, 387 |
| `src/core/cycle/extract-atoms.ts` | 5 | 4 | - | 456, 597, 644, 1049, 1586 |
| `src/core/cycle/propose-takes-failures.ts` | 5 | 0 | -/9 | 63, 72, 79, 87, 193 |
| `src/core/cycle/propose-takes.ts` | 5 | 0 | - | 336, 988, 1080, 1094, 1133 |
| `src/core/cycle/synthesize.ts` | 5 | 4 | - | 779, 836, 1084, 1264, 1804 |
| `src/core/extract-timeline-from-meetings.ts` | 5 | 0 | - | 116, 137, 376, 380, 469 |
| `src/core/extraction-watermark.ts` | 5 | 5 | - | 186, 208, 226, 240, 243 |
| `src/core/facts/single-prepare.ts` | 5 | 0 | 4 | 97, 115, 126, 215, 231 |
| `src/core/ingestion/applied-captures.ts` | 5 | 1 | - | 35, 38, 51, 60, 69 |
| `src/core/page-state/credential-reseal.ts` | 5 | 0 | 9/7 | 84, 94, 97, 100, 116 |
| `src/core/page-state/image-seal.ts` | 5 | 0 | 7 | 78, 94, 103, 116, 122 |
| `src/core/page-state/materialize.ts` | 5 | 0 | 7 | 25, 26, 33, 37, 40 |
| `src/core/page-window/segmented.ts` | 5 | 2 | - | 283, 293, 294, 338, 355 |
| `src/core/persistence/checkpoint-validation.ts` | 5 | 2 | - | 72, 103, 133, 160, 164 |
| `src/core/persistence/embedding-noop-settle.ts` | 5 | 0 | - | 65, 71, 75, 84, 115 |
| `src/core/persistence/facts-prepare.ts` | 5 | 0 | - | 91, 132, 147, 198, 315 |
| `src/core/persistence/git-gap.ts` | 5 | 0 | - | 421, 453, 454, 459, 468 |
| `src/core/persistence/graduation-losses.ts` | 5 | 0 | - | 49, 56, 63, 67, 68 |
| `src/core/persistence/graduation-target.ts` | 5 | 3 | - | 166, 167, 332, 333, 334 |
| `src/core/persistence/loop-fact-retirement.ts` | 5 | 1 | - | 55, 58, 60, 122, 154 |
| `src/core/persistence/origin-index.ts` | 5 | 0 | - | 20, 30, 33, 55, 56 |
| `src/core/persistence/page-mutations.ts` | 5 | 0 | - | 110, 110, 187, 341, 574 |
| `src/core/persistence/reconcile-state.ts` | 5 | 0 | -/9 | 79, 157, 166, 239, 246 |
| `src/core/persistence/resolve-paths.ts` | 5 | 0 | - | 122, 150, 164, 187, 197 |
| `src/core/persistence/sync-lease.ts` | 5 | 3 | - | 136, 161, 259, 284, 295 |
| `src/core/persistence/sync-movement.ts` | 5 | 1 | - | 132, 141, 161, 162, 165 |
| `src/core/repair/atoms-restore.ts` | 5 | 0 | - | 67, 82, 104, 167, 203 |
| `src/core/repair/private-labels.ts` | 5 | 0 | - | 119, 211, 331, 368, 370 |
| `src/core/repair/purged-page-facts.ts` | 5 | 0 | - | 83, 118, 132, 193, 196 |
| `src/core/repair/segmented-mirror.ts` | 5 | 0 | - | 106, 160, 173, 188, 248 |
| `src/core/repair/slug-conflicts.ts` | 5 | 2 | -/9 | 372, 406, 512, 546, 822 |
| `src/core/repair/timeline-comments.ts` | 5 | 0 | - | 50, 62, 65, 66, 82 |
| `src/core/repair/unwithdrawn-facts.ts` | 5 | 0 | - | 104, 171, 182, 282, 289 |
| `src/core/repair/url-clone-fences.ts` | 5 | 0 | - | 97, 106, 125, 169, 174 |
| `src/core/schema-migrations/v302-link-transitions-source.ts` | 5 | 4 | - | 47, 59, 60, 62, 63 |
| `src/core/search/two-pass.ts` | 5 | 4 | 6 | 89, 97, 165, 174, 210 |
| `src/core/sync-anchor.ts` | 5 | 1 | - | 271, 276, 298, 409, 469 |
| `src/core/takes-horizon.ts` | 5 | 0 | 5 | 93, 95, 105, 111, 128 |
| `src/core/takes-write.ts` | 5 | 0 | 5 | 160, 229, 233, 470, 513 |
| `src/core/trust/allow-rules.ts` | 5 | 0 | - | 104, 108, 112, 121, 127 |
| `src/core/trust/taint.ts` | 5 | 0 | - | 47, 53, 127, 177, 235 |
| `src/commands/access-rules.ts` | 4 | 0 | 2 | 150, 157, 197, 204 |
| `src/commands/autopilot-dispatch.ts` | 4 | 1 | 2/9 | 344, 595, 679, 784 |
| `src/commands/db-repair.ts` | 4 | 4 | 2 | 251, 252, 511, 802 |
| `src/commands/doctor/checks/default-source-path.ts` | 4 | 0 | 2 | 32, 71, 90, 106 |
| `src/commands/doctor/checks/embedding-health.ts` | 4 | 4 | 2 | 91, 333, 353, 417 |
| `src/commands/doctor/checks/git-holds.ts` | 4 | 2 | 2/9 | 118, 121, 144, 154 |
| `src/commands/doctor/checks/guest-source.ts` | 4 | 1 | 2 | 36, 37, 77, 85 |
| `src/commands/doctor/checks/mcp-request-log.ts` | 4 | 0 | 2 | 43, 45, 46, 70 |
| `src/commands/doctor/checks/member-access.ts` | 4 | 0 | 2 | 36, 50, 82, 103 |
| `src/commands/doctor/checks/schema-health.ts` | 4 | 3 | 2 | 138, 201, 364, 427 |
| `src/commands/doctor/checks/vector-plan.ts` | 4 | 1 | 2 | 73, 121, 127, 135 |
| `src/commands/mcp-provision.ts` | 4 | 0 | 2 | 36, 37, 42, 102 |
| `src/commands/migrations/v0_18_0.ts` | 4 | 4 | 2 | 55, 132, 145, 150 |
| `src/commands/reindex.ts` | 4 | 0 | 2 | 271, 283, 308, 322 |
| `src/commands/serve-http-webhooks.ts` | 4 | 3 | 2 | 190, 235, 303, 800 |
| `src/commands/sync/holds.ts` | 4 | 0 | 2 | 203, 292, 343, 392 |
| `src/core/access/policy-migrate.ts` | 4 | 0 | 11 | 41, 80, 85, 104 |
| `src/core/belief/state.ts` | 4 | 0 | 4 | 117, 119, 189, 198 |
| `src/core/calibration/domain-aggregators.ts` | 4 | 0 | - | 107, 150, 198, 242 |
| `src/core/chronicle/ledger-stats.ts` | 4 | 4 | - | 42, 52, 55, 89 |
| `src/core/chronicle/publish.ts` | 4 | 0 | - | 186, 290, 300, 306 |
| `src/core/cycle/dream-breaker.ts` | 4 | 0 | - | 134, 135, 147, 229 |
| `src/core/cycle/dream-write-deferral.ts` | 4 | 0 | - | 91, 92, 97, 118 |
| `src/core/cycle/extract-atoms-generation.ts` | 4 | 0 | - | 75, 90, 102, 105 |
| `src/core/cycle/extract-atoms-page-state.ts` | 4 | 1 | - | 41, 53, 99, 105 |
| `src/core/cycle/grade-takes.ts` | 4 | 1 | - | 678, 834, 849, 902 |
| `src/core/cycle/source-window.ts` | 4 | 0 | - | 53, 54, 58, 67 |
| `src/core/db.ts` | 4 | 1 | - | 215, 553, 600, 611 |
| `src/core/eligibility/scan.ts` | 4 | 0 | 9/- | 60, 68, 134, 146 |
| `src/core/embedding-readiness.ts` | 4 | 1 | - | 14, 58, 100, 111 |
| `src/core/export-snapshot.ts` | 4 | 0 | - | 18, 23, 44, 62 |
| `src/core/facts/capture-dedup.ts` | 4 | 2 | 4 | 138, 142, 174, 346 |
| `src/core/facts/facts-home.ts` | 4 | 0 | 4 | 77, 94, 112, 136 |
| `src/core/facts/forget.ts` | 4 | 0 | 4 | 165, 194, 273, 358 |
| `src/core/facts/gone-page-facts.ts` | 4 | 0 | 4 | 60, 61, 62, 63 |
| `src/core/facts/ontology-rekey.ts` | 4 | 0 | 4 | 20, 38, 40, 42 |
| `src/core/facts/proposal-supersede.ts` | 4 | 0 | 4 | 106, 182, 201, 464 |
| `src/core/facts/reconcile-watermark.ts` | 4 | 0 | 4 | 55, 78, 98, 112 |
| `src/core/facts/relink-publish.ts` | 4 | 0 | 4 | 137, 149, 211, 294 |
| `src/core/generations/adapters/extracted-facts.ts` | 4 | 0 | 3 | 71, 82, 100, 113 |
| `src/core/generations/fence-evidence.ts` | 4 | 0 | 3 | 50, 58, 62, 80 |
| `src/core/generations/fence.ts` | 4 | 0 | 3 | 113, 128, 169, 196 |
| `src/core/google/google-source.ts` | 4 | 1 | - | 179, 205, 624, 987 |
| `src/core/google/loops-exclusion.ts` | 4 | 0 | -/9 | 101, 110, 126, 133 |
| `src/core/guests/promote.ts` | 4 | 0 | - | 49, 73, 86, 92 |
| `src/core/link-reconciliation.ts` | 4 | 1 | - | 71, 220, 229, 442 |
| `src/core/mentions/coverage.ts` | 4 | 1 | 6 | 43, 55, 64, 73 |
| `src/core/minions/legacy-cancel.ts` | 4 | 0 | - | 32, 41, 57, 107 |
| `src/core/onboard/checks.ts` | 4 | 2 | - | 93, 127, 169, 782 |
| `src/core/ops/jobs.ts` | 4 | 1 | - | 131, 292, 570, 933 |
| `src/core/page-body/body-tiling.ts` | 4 | 0 | 3 | 35, 55, 77, 99 |
| `src/core/page-embedding-lease.ts` | 4 | 1 | - | 87, 104, 117, 136 |
| `src/core/page-spend.ts` | 4 | 0 | - | 60, 82, 83, 92 |
| `src/core/persistence/applied-watermark.ts` | 4 | 0 | - | 88, 92, 104, 132 |
| `src/core/persistence/authority.ts` | 4 | 0 | - | 279, 308, 310, 338 |
| `src/core/persistence/change-reason.ts` | 4 | 0 | - | 74, 117, 119, 147 |
| `src/core/persistence/consumer.ts` | 4 | 0 | 7 | 584, 585, 587, 732 |
| `src/core/persistence/detached-pages.ts` | 4 | 0 | - | 62, 102, 136, 141 |
| `src/core/persistence/facts-maintenance.ts` | 4 | 0 | - | 168, 219, 400, 446 |
| `src/core/persistence/file-repair.ts` | 4 | 0 | - | 278, 414, 422, 424 |
| `src/core/persistence/git-durability-administration.ts` | 4 | 0 | - | 186, 226, 352, 354 |
| `src/core/persistence/graduation-digest.ts` | 4 | 0 | - | 88, 94, 140, 152 |
| `src/core/persistence/hosted-repo.ts` | 4 | 0 | - | 112, 114, 143, 157 |
| `src/core/persistence/identity.ts` | 4 | 3 | - | 351, 356, 358, 404 |
| `src/core/persistence/memory-mutations.ts` | 4 | 0 | - | 318, 418, 428, 465 |
| `src/core/persistence/purge-slug-stores.ts` | 4 | 0 | - | 27, 30, 47, 50 |
| `src/core/persistence/reconcile-backup.ts` | 4 | 0 | - | 34, 118, 121, 161 |
| `src/core/persistence/refresh-barrier.ts` | 4 | 1 | - | 38, 70, 171, 180 |
| `src/core/persistence/repair-busy.ts` | 4 | 4 | -/9 | 56, 60, 64, 67 |
| `src/core/persistence/rows-behind.ts` | 4 | 0 | - | 125, 143, 160, 161 |
| `src/core/persistence/soak-counters.ts` | 4 | 1 | 9/- | 40, 58, 69, 90 |
| `src/core/persistence/staging.ts` | 4 | 0 | - | 193, 195, 212, 214 |
| `src/core/persistence/sync-admission.ts` | 4 | 0 | -/9 | 34, 84, 99, 151 |
| `src/core/persistence/sync-drain.ts` | 4 | 1 | -/9 | 749, 805, 846, 1252 |
| `src/core/persistence/sync-pass-row.ts` | 4 | 0 | 9/- | 178, 185, 204, 206 |
| `src/core/persistence/unbound-source.ts` | 4 | 0 | - | 141, 146, 161, 166 |
| `src/core/repair/accepted-takes.ts` | 4 | 0 | - | 61, 75, 93, 166 |
| `src/core/repair/contact-rows.ts` | 4 | 0 | - | 42, 73, 124, 141 |
| `src/core/repair/content-receipt-root.ts` | 4 | 0 | - | 55, 113, 118, 120 |
| `src/core/repair/facts-rehome.ts` | 4 | 0 | - | 57, 85, 134, 142 |
| `src/core/repair/fences.ts` | 4 | 1 | -/9 | 199, 231, 354, 557 |
| `src/core/repair/moved-pages.ts` | 4 | 0 | - | 174, 187, 201, 229 |
| `src/core/repair/ontology-facts.ts` | 4 | 0 | - | 78, 133, 148, 155 |
| `src/core/repair/origin-twins-heal.ts` | 4 | 3 | -/9 | 59, 100, 114, 116 |
| `src/core/repair/timeline-order.ts` | 4 | 0 | - | 63, 113, 174, 190 |
| `src/core/schema-migrations/v123-configurable-fts-language.ts` | 4 | 0 | - | 67, 68, 81, 86 |
| `src/core/schema-migrations/v275-rls-backfill-unguarded-tables.ts` | 4 | 3 | - | 99, 117, 118, 119 |
| `src/core/search/entity-anchor.ts` | 4 | 1 | 6 | 38, 42, 53, 116 |
| `src/core/skillpack/shared-brain-bridge.ts` | 4 | 1 | - | 46, 80, 96, 171 |
| `src/core/slack/slack-source.ts` | 4 | 1 | - | 141, 238, 266, 315 |
| `src/core/storage-manifest/adopt.ts` | 4 | 1 | - | 230, 241, 369, 417 |
| `src/core/storage-manifest/find.ts` | 4 | 0 | - | 47, 78, 80, 86 |
| `src/core/storage-manifest/source.ts` | 4 | 0 | - | 34, 40, 66, 70 |
| `src/core/sync-rename-identity.ts` | 4 | 1 | - | 316, 328, 365, 375 |
| `src/core/trust/held-removals.ts` | 4 | 0 | - | 39, 67, 91, 93 |
| `src/core/trust/marker-repair.ts` | 4 | 0 | - | 111, 119, 121, 140 |
| `src/core/trust/propagation.ts` | 4 | 0 | - | 34, 50, 71, 79 |
| `src/core/vector-prewarm.ts` | 4 | 0 | - | 71, 80, 152, 153 |
| `src/commands/doctor/checks/atom-body-recheck.ts` | 3 | 0 | 2 | 45, 59, 62 |
| `src/commands/doctor/checks/data-integrity.ts` | 3 | 3 | 2 | 191, 315, 330 |
| `src/commands/doctor/checks/folder-access.ts` | 3 | 1 | 2 | 30, 38, 111 |
| `src/commands/doctor/checks/git-convergence.ts` | 3 | 2 | 2 | 74, 108, 174 |
| `src/commands/doctor/checks/keyword-plan.ts` | 3 | 0 | 2 | 72, 76, 89 |
| `src/commands/doctor/checks/knowledge-health.ts` | 3 | 2 | 2 | 196, 386, 419 |
| `src/commands/doctor/checks/maintenance-drift.ts` | 3 | 3 | 2 | 39, 51, 58 |
| `src/commands/doctor/checks/orphan-bindings.ts` | 3 | 3 | 2 | 47, 48, 49 |
| `src/commands/doctor/checks/queue-assets.ts` | 3 | 3 | 2 | 48, 118, 167 |
| `src/commands/dream-retriage.ts` | 3 | 0 | 2 | 479, 546, 597 |
| `src/commands/extract.ts` | 3 | 2 | 2 | 207, 497, 2599 |
| `src/commands/frontmatter-install-hook.ts` | 3 | 1 | 2 | 303, 309, 313 |
| `src/commands/google-attachments.ts` | 3 | 3 | 2/9 | 106, 120, 121 |
| `src/commands/import-calls.ts` | 3 | 0 | 2 | 287, 293, 300 |
| `src/commands/init.ts` | 3 | 2 | 2 | 1043, 1458, 1462 |
| `src/commands/sources-strategy.ts` | 3 | 0 | 2 | 30, 42, 58 |
| `src/commands/sync/preflight.ts` | 3 | 0 | 2 | 195, 949, 1160 |
| `src/commands/sync/run.ts` | 3 | 1 | 2 | 396, 400, 921 |
| `src/core/access/labelled-only.ts` | 3 | 1 | 11 | 41, 47, 75 |
| `src/core/access/requester-scope.ts` | 3 | 1 | 11 | 196, 269, 270 |
| `src/core/belief/retier.ts` | 3 | 0 | 4 | 43, 131, 155 |
| `src/core/brain-writer.ts` | 3 | 1 | - | 1011, 1021, 1025 |
| `src/core/chronicle/campaign.ts` | 3 | 0 | - | 54, 76, 86 |
| `src/core/code-chunks.ts` | 3 | 0 | 5 | 29, 30, 31 |
| `src/core/company-brain/evidence.ts` | 3 | 0 | - | 10, 17, 25 |
| `src/core/company-brain/verification.ts` | 3 | 0 | - | 15, 57, 68 |
| `src/core/connection-manager.ts` | 3 | 3 | - | 455, 486, 493 |
| `src/core/context/retrieval-reflex.ts` | 3 | 3 | 10 | 78, 428, 531 |
| `src/core/contextual-retrieval-service.ts` | 3 | 0 | - | 410, 529, 542 |
| `src/core/cycle/concept-publication.ts` | 3 | 0 | - | 101, 120, 123 |
| `src/core/cycle/dream-provenance.ts` | 3 | 1 | - | 37, 69, 90 |
| `src/core/cycle/inline-drain.ts` | 3 | 1 | - | 236, 286, 294 |
| `src/core/cycle/synthesize-verify-epochs.ts` | 3 | 0 | - | 14, 33, 50 |
| `src/core/eligibility/explain.ts` | 3 | 0 | - | 111, 116, 122 |
| `src/core/embed-stale.ts` | 3 | 2 | - | 200, 328, 339 |
| `src/core/embedding-migration-worst-case.ts` | 3 | 0 | - | 73, 112, 135 |
| `src/core/extract/rollup-writer.ts` | 3 | 3 | - | 88, 203, 242 |
| `src/core/facts/claim-conflicts.ts` | 3 | 0 | 4 | 103, 112, 125 |
| `src/core/facts/fts-index.ts` | 3 | 0 | 4 | 27, 54, 55 |
| `src/core/facts/proposal-review.ts` | 3 | 0 | 4 | 40, 46, 78 |
| `src/core/facts/purge-overlay.ts` | 3 | 0 | 4 | 18, 32, 47 |
| `src/core/facts/unfenced-facts.ts` | 3 | 1 | 4 | 272, 392, 678 |
| `src/core/facts/write-single.ts` | 3 | 2 | 4 | 171, 307, 317 |
| `src/core/fence-repair/attempts.ts` | 3 | 0 | 9 | 119, 128, 131 |
| `src/core/fence-repair/uncommitted.ts` | 3 | 0 | 9 | 47, 67, 72 |
| `src/core/forecast-journal.ts` | 3 | 0 | - | 64, 96, 144 |
| `src/core/function-search-path.ts` | 3 | 2 | - | 78, 162, 163 |
| `src/core/generations/adapters/atoms.ts` | 3 | 0 | 3 | 82, 114, 128 |
| `src/core/generations/fence-restore.ts` | 3 | 0 | 3 | 21, 24, 54 |
| `src/core/ghost-pages.ts` | 3 | 0 | - | 214, 216, 236 |
| `src/core/git/untrack-admission.ts` | 3 | 0 | - | 46, 50, 62 |
| `src/core/github-source.ts` | 3 | 1 | - | 1031, 1407, 1490 |
| `src/core/google/people-calendar-sweep.ts` | 3 | 2 | - | 301, 320, 478 |
| `src/core/guard-ledger-checks.ts` | 3 | 0 | - | 44, 57, 65 |
| `src/core/guests/admission.ts` | 3 | 1 | - | 128, 211, 222 |
| `src/core/heal-audit.ts` | 3 | 0 | - | 55, 56, 61 |
| `src/core/imessage/imessage-source.ts` | 3 | 1 | - | 96, 145, 218 |
| `src/core/link-source-check-repair.ts` | 3 | 0 | - | 63, 67, 92 |
| `src/core/meetings/meetings-source.ts` | 3 | 1 | - | 141, 250, 297 |
| `src/core/minions/handlers/ingest-capture.ts` | 3 | 0 | - | 271, 284, 387 |
| `src/core/minions/handlers/sync.ts` | 3 | 3 | - | 36, 60, 110 |
| `src/core/minions/spend-authorization.ts` | 3 | 1 | - | 99, 138, 257 |
| `src/core/onboard/impact-capture.ts` | 3 | 3 | - | 106, 112, 139 |
| `src/core/ops/backlinks-paged.ts` | 3 | 0 | - | 45, 50, 148 |
| `src/core/ops/known-as-of.ts` | 3 | 0 | - | 43, 63, 81 |
| `src/core/ops/loops.ts` | 3 | 3 | - | 166, 204, 566 |
| `src/core/ops/page-upload.ts` | 3 | 0 | - | 187, 310, 403 |
| `src/core/page-body/ingest.ts` | 3 | 0 | 3 | 174, 357, 447 |
| `src/core/page-body/segment-conversation.ts` | 3 | 0 | 3 | 47, 57, 92 |
| `src/core/page-searchability.ts` | 3 | 0 | - | 38, 43, 55 |
| `src/core/page-state/contextual-proof.ts` | 3 | 0 | 7 | 12, 19, 24 |
| `src/core/page-state/tags.ts` | 3 | 0 | 7 | 9, 13, 19 |
| `src/core/persistence/admin-intent.ts` | 3 | 0 | - | 10, 29, 30 |
| `src/core/persistence/connector-path.ts` | 3 | 0 | - | 23, 31, 39 |
| `src/core/persistence/consumer-diagnostics.ts` | 3 | 0 | 7 | 48, 111, 116 |
| `src/core/persistence/graduation-inventory.ts` | 3 | 1 | - | 260, 268, 311 |
| `src/core/persistence/import-mutations.ts` | 3 | 2 | 9 | 174, 215, 245 |
| `src/core/persistence/landing-gaps.ts` | 3 | 2 | - | 44, 49, 62 |
| `src/core/persistence/maintenance.ts` | 3 | 0 | - | 96, 101, 120 |
| `src/core/persistence/managed-mode.ts` | 3 | 0 | - | 71, 83, 92 |
| `src/core/persistence/memory-prepare.ts` | 3 | 0 | - | 66, 153, 210 |
| `src/core/persistence/overwritten-edits.ts` | 3 | 0 | - | 90, 109, 111 |
| `src/core/persistence/page-append.ts` | 3 | 0 | - | 194, 360, 437 |
| `src/core/persistence/preadmit-cache.ts` | 3 | 0 | - | 69, 73, 103 |
| `src/core/persistence/preview-approval.ts` | 3 | 0 | 9/- | 85, 96, 113 |
| `src/core/persistence/reconcile.ts` | 3 | 0 | - | 58, 64, 203 |
| `src/core/persistence/sync-ghosts.ts` | 3 | 2 | 9/- | 53, 95, 113 |
| `src/core/persistence/sync-pass-apply.ts` | 3 | 0 | -/9 | 295, 298, 444 |
| `src/core/persistence/sync-pass-batch.ts` | 3 | 0 | - | 88, 90, 96 |
| `src/core/persistence/sync-pass-fold.ts` | 3 | 0 | - | 100, 148, 150 |
| `src/core/persistence/sync-pass-status.ts` | 3 | 0 | - | 23, 96, 104 |
| `src/core/persistence/sync-slug-mode.ts` | 3 | 0 | - | 27, 50, 78 |
| `src/core/persistence/sync-tail-record.ts` | 3 | 0 | 9 | 16, 31, 40 |
| `src/core/persistence/terminal-failures.ts` | 3 | 1 | - | 106, 247, 255 |
| `src/core/questions/freshness.ts` | 3 | 0 | - | 134, 178, 183 |
| `src/core/repair/aliases.ts` | 3 | 0 | - | 40, 47, 58 |
| `src/core/repair/atom-fence-rows.ts` | 3 | 0 | - | 85, 99, 136 |
| `src/core/repair/consolidate-ties.ts` | 3 | 0 | - | 47, 69, 107 |
| `src/core/repair/core.ts` | 3 | 0 | 9/- | 311, 314, 324 |
| `src/core/repair/fact-claim-dates.ts` | 3 | 0 | - | 127, 167, 243 |
| `src/core/repair/origin-carry.ts` | 3 | 0 | - | 45, 184, 267 |
| `src/core/repair/overwritten-edits.ts` | 3 | 0 | - | 59, 147, 188 |
| `src/core/repair/provenance.ts` | 3 | 0 | -/9 | 41, 68, 81 |
| `src/core/repair/readers.ts` | 3 | 0 | - | 102, 128, 217 |
| `src/core/repair/receipt-compaction.ts` | 3 | 0 | - | 55, 61, 97 |
| `src/core/repair/rotation.ts` | 3 | 1 | 9/- | 11, 16, 35 |
| `src/core/repair/split-facts.ts` | 3 | 0 | - | 79, 102, 108 |
| `src/core/repair/stale-atoms.ts` | 3 | 0 | - | 80, 139, 215 |
| `src/core/repair/take-supersession.ts` | 3 | 0 | - | 169, 171, 217 |
| `src/core/schema-migrations/v232-fts-cjk-boundary.ts` | 3 | 0 | - | 31, 32, 33 |
| `src/core/schema-pack/lint-rules.ts` | 3 | 1 | - | 327, 415, 446 |
| `src/core/schema-pack/page-to-alias.ts` | 3 | 0 | - | 112, 130, 164 |
| `src/core/schema-pack/retype.ts` | 3 | 1 | - | 148, 154, 252 |
| `src/core/schema-pack/sync.ts` | 3 | 3 | - | 79, 85, 123 |
| `src/core/search-vector-backfill.ts` | 3 | 0 | 6 | 63, 106, 134 |
| `src/core/search/evidence-date.ts` | 3 | 0 | 6 | 110, 158, 165 |
| `src/core/search/facts-arm.ts` | 3 | 1 | 6 | 155, 175, 406 |
| `src/core/session-lane.ts` | 3 | 1 | - | 79, 82, 86 |
| `src/core/shared-skills/knowledge-guard.ts` | 3 | 0 | - | 41, 67, 121 |
| `src/core/shared-skills/membership-authority.ts` | 3 | 0 | - | 26, 34, 65 |
| `src/core/shared-skills/migration.ts` | 3 | 3 | - | 178, 248, 249 |
| `src/core/shared-skills/source-opt-out.ts` | 3 | 0 | - | 48, 81, 86 |
| `src/core/sources-ops.ts` | 3 | 1 | 1 | 424, 585, 1004 |
| `src/core/sync-git.ts` | 3 | 3 | - | 143, 159, 198 |
| `src/core/sync-pending.ts` | 3 | 1 | - | 106, 176, 205 |
| `src/core/synopsis-sweep.ts` | 3 | 1 | - | 122, 191, 232 |
| `src/core/token-mint.ts` | 3 | 1 | - | 145, 196, 213 |
| `src/core/transcripts/ingest.ts` | 3 | 0 | - | 522, 594, 708 |
| `src/core/trust/fence-append.ts` | 3 | 0 | - | 30, 34, 36 |
| `src/core/trust/provenance-drift.ts` | 3 | 0 | - | 165, 190, 201 |
| `src/core/verbs/entity-variants.ts` | 3 | 3 | - | 79, 106, 152 |
| `src/commands/access-read-by-nobody.ts` | 2 | 0 | 2 | 44, 77 |
| `src/commands/autopilot-fanout.ts` | 2 | 2 | 2 | 323, 351 |
| `src/commands/decide/proposals.ts` | 2 | 0 | 2 | 42, 103 |
| `src/commands/diag.ts` | 2 | 1 | 2 | 98, 108 |
| `src/commands/doctor/checks/access-lineage.ts` | 2 | 2 | 2 | 23, 36 |
| `src/commands/doctor/checks/atom-retirements.ts` | 2 | 2 | 2 | 21, 27 |
| `src/commands/doctor/checks/entity-duplicates.ts` | 2 | 2 | 2 | 51, 68 |
| `src/commands/doctor/checks/extraction-input.ts` | 2 | 2 | 2 | 67, 93 |
| `src/commands/doctor/checks/foreign-writers.ts` | 2 | 2 | 2 | 135, 176 |
| `src/commands/doctor/checks/generations.ts` | 2 | 2 | 2 | 37, 61 |
| `src/commands/doctor/checks/grant-new-ops.ts` | 2 | 2 | 2 | 101, 118 |
| `src/commands/doctor/checks/graph-embedding.ts` | 2 | 2 | 2 | 149, 211 |
| `src/commands/doctor/checks/managed-guard.ts` | 2 | 2 | 2 | 59, 103 |
| `src/commands/doctor/checks/orphan-estimate.ts` | 2 | 0 | 2 | 29, 45 |
| `src/commands/doctor/checks/owner-host-stale.ts` | 2 | 2 | 2 | 24, 26 |
| `src/commands/doctor/checks/parked-effects.ts` | 2 | 2 | 2 | 52, 53 |
| `src/commands/doctor/checks/search-eval.ts` | 2 | 2 | 2 | 648, 695 |
| `src/commands/doctor/checks/shared-agent-access.ts` | 2 | 2 | 2 | 27, 33 |
| `src/commands/doctor/checks/slug-collisions.ts` | 2 | 2 | 2 | 22, 38 |
| `src/commands/doctor/checks/slug-path-mismatch.ts` | 2 | 1 | 2 | 44, 63 |
| `src/commands/doctor/checks/stale-embedding-effects.ts` | 2 | 2 | 2 | 20, 23 |
| `src/commands/doctor/checks/storage-manifest.ts` | 2 | 2 | 2 | 26, 27 |
| `src/commands/doctor/checks/unscoped-multi-user-token.ts` | 2 | 0 | 2 | 47, 51 |
| `src/commands/extract-timeline-db.ts` | 2 | 0 | 2 | 253, 393 |
| `src/commands/jobs-watch.ts` | 2 | 2 | 2 | 145, 158 |
| `src/commands/jobs/smoke.ts` | 2 | 0 | 2 | 107, 157 |
| `src/commands/migrations/v0_14_0.ts` | 2 | 2 | 2 | 58, 68 |
| `src/commands/migrations/v0_32_2.ts` | 2 | 2 | 2 | 97, 237 |
| `src/commands/pages-status.ts` | 2 | 0 | 2 | 102, 177 |
| `src/commands/reindex-code.ts` | 2 | 0 | 2 | 144, 156 |
| `src/commands/reindex-synopsis.ts` | 2 | 1 | 2 | 202, 218 |
| `src/commands/reindex-vectors.ts` | 2 | 0 | 2 | 26, 36 |
| `src/commands/serve-http-api-keys.ts` | 2 | 1 | 2 | 94, 132 |
| `src/commands/serve-http-metrics.ts` | 2 | 1 | 2 | 263, 344 |
| `src/commands/sources-add-next.ts` | 2 | 1 | 2 | 29, 67 |
| `src/commands/sources-mirror.ts` | 2 | 0 | 2 | 20, 36 |
| `src/commands/sources-retry-held.ts` | 2 | 0 | 2 | 113, 145 |
| `src/commands/sources-set-path.ts` | 2 | 0 | 2 | 55, 92 |
| `src/commands/sources-trust.ts` | 2 | 0 | 2 | 29, 38 |
| `src/commands/sweep.ts` | 2 | 0 | 2 | 216, 230 |
| `src/commands/sync/full.ts` | 2 | 0 | 2 | 124, 460 |
| `src/commands/sync/rename-collision.ts` | 2 | 1 | 2 | 55, 65 |
| `src/commands/takes.ts` | 2 | 0 | 2 | 368, 923 |
| `src/core/access/member-facts.ts` | 2 | 0 | 11 | 49, 170 |
| `src/core/access/room.ts` | 2 | 0 | 11 | 153, 166 |
| `src/core/agent-install/setup.ts` | 2 | 2 | - | 293, 294 |
| `src/core/backfill-effective-date.ts` | 2 | 0 | - | 207, 233 |
| `src/core/backfill-skips.ts` | 2 | 0 | - | 57, 70 |
| `src/core/belief/changes.ts` | 2 | 0 | 4 | 303, 310 |
| `src/core/belief/identity.ts` | 2 | 0 | 4 | 84, 96 |
| `src/core/belief/preimages.ts` | 2 | 0 | 4 | 18, 34 |
| `src/core/calibration/think-ab.ts` | 2 | 0 | - | 68, 115 |
| `src/core/code-intel/recursive-walk.ts` | 2 | 1 | 5 | 123, 144 |
| `src/core/company-brain/demo.ts` | 2 | 0 | - | 31, 55 |
| `src/core/company-brain/profile.ts` | 2 | 0 | -/9 | 69, 86 |
| `src/core/connectors/api-source.ts` | 2 | 1 | 9/- | 75, 193 |
| `src/core/connectors/db-cursor.ts` | 2 | 0 | 9 | 31, 37 |
| `src/core/content-drift-sweep.ts` | 2 | 0 | - | 106, 107 |
| `src/core/context/corpus-source.ts` | 2 | 0 | 10 | 250, 302 |
| `src/core/context/volunteer-events.ts` | 2 | 1 | 10 | 199, 285 |
| `src/core/conversation-parser/llm-base.ts` | 2 | 0 | - | 255, 288 |
| `src/core/cycle.ts` | 2 | 2 | - | 1206, 1242 |
| `src/core/cycle/calibration-profile.ts` | 2 | 0 | - | 297, 402 |
| `src/core/cycle/chronicle.ts` | 2 | 0 | - | 106, 152 |
| `src/core/cycle/concept-redirects.ts` | 2 | 0 | - | 30, 58 |
| `src/core/cycle/drift.ts` | 2 | 0 | - | 205, 242 |
| `src/core/cycle/synthesize-completion.ts` | 2 | 1 | - | 78, 98 |
| `src/core/cycle/synthesize-postprocess.ts` | 2 | 0 | - | 51, 110 |
| `src/core/cycle/transcript-discovery.ts` | 2 | 0 | - | 529, 541 |
| `src/core/db-lock.ts` | 2 | 1 | - | 227, 933 |
| `src/core/embed-backfill-submit.ts` | 2 | 0 | - | 115, 209 |
| `src/core/embed-consent.ts` | 2 | 2 | - | 99, 102 |
| `src/core/embed-stale-images.ts` | 2 | 0 | - | 89, 93 |
| `src/core/embedding-dim-check.ts` | 2 | 0 | - | 534, 545 |
| `src/core/embedding-migration-budget.ts` | 2 | 0 | - | 60, 104 |
| `src/core/embedding-restamp.ts` | 2 | 2 | - | 85, 98 |
| `src/core/enrichment-service.ts` | 2 | 2 | - | 534, 538 |
| `src/core/eval-contradictions/scoped-read.ts` | 2 | 0 | 5 | 57, 75 |
| `src/core/extract-ner.ts` | 2 | 0 | - | 217, 219 |
| `src/core/extract/receipt-writer.ts` | 2 | 0 | - | 226, 242 |
| `src/core/facts/conversation-memo.ts` | 2 | 0 | 4 | 48, 55 |
| `src/core/facts/conversation-relink.ts` | 2 | 0 | 4 | 96, 117 |
| `src/core/facts/fence-fact-append.ts` | 2 | 0 | 4 | 91, 263 |
| `src/core/facts/fence-write.ts` | 2 | 1 | 4 | 508, 684 |
| `src/core/facts/file-body-guard.ts` | 2 | 0 | 4 | 49, 145 |
| `src/core/fence-repair/hold-fix.ts` | 2 | 1 | - | 57, 60 |
| `src/core/generations/adapters/page.ts` | 2 | 0 | 3 | 54, 98 |
| `src/core/generations/adapters/take-rows.ts` | 2 | 0 | 3 | 36, 51 |
| `src/core/google/attachment-backfill.ts` | 2 | 0 | - | 70, 79 |
| `src/core/google/sweep-shared.ts` | 2 | 0 | - | 146, 224 |
| `src/core/held-embedding.ts` | 2 | 0 | - | 57, 146 |
| `src/core/line-grammar-config.ts` | 2 | 0 | - | 42, 48 |
| `src/core/link-single-value.ts` | 2 | 0 | - | 82, 89 |
| `src/core/migrate.ts` | 2 | 1 | - | 116, 392 |
| `src/core/minions/db-probe.ts` | 2 | 0 | - | 143, 145 |
| `src/core/minions/handlers/embed-backfill.ts` | 2 | 1 | - | 311, 388 |
| `src/core/minions/handlers/subagent-oneshot.ts` | 2 | 2 | - | 552, 558 |
| `src/core/minions/job-context.ts` | 2 | 0 | - | 45, 53 |
| `src/core/minions/legacy-selection.ts` | 2 | 0 | - | 101, 104 |
| `src/core/minions/submission-authority.ts` | 2 | 0 | - | 114, 161 |
| `src/core/minions/sync-queue-wake.ts` | 2 | 1 | - | 91, 112 |
| `src/core/notifier/resident.ts` | 2 | 0 | - | 50, 176 |
| `src/core/notifier/status.ts` | 2 | 1 | - | 73, 143 |
| `src/core/ops/get-page-body.ts` | 2 | 0 | - | 335, 485 |
| `src/core/ops/persistence.ts` | 2 | 0 | - | 64, 73 |
| `src/core/ops/qm-memory.ts` | 2 | 0 | - | 167, 447 |
| `src/core/page-body/segment-blocks.ts` | 2 | 0 | 3 | 166, 227 |
| `src/core/page-body/splice.ts` | 2 | 0 | 3 | 153, 416 |
| `src/core/page-window/bounded-lead.ts` | 2 | 0 | - | 75, 114 |
| `src/core/persistence/blocking-effects.ts` | 2 | 0 | - | 16, 34 |
| `src/core/persistence/config-snapshot.ts` | 2 | 0 | - | 17, 26 |
| `src/core/persistence/connector-account-mismatch.ts` | 2 | 0 | -/9 | 33, 39 |
| `src/core/persistence/consumer-lane.ts` | 2 | 0 | 7 | 66, 66 |
| `src/core/persistence/coordination-lock.ts` | 2 | 0 | - | 106, 109 |
| `src/core/persistence/core-guard.ts` | 2 | 0 | - | 48, 175 |
| `src/core/persistence/database-write.ts` | 2 | 0 | - | 29, 41 |
| `src/core/persistence/file-claims.ts` | 2 | 0 | - | 87, 92 |
| `src/core/persistence/git-durability-policy.ts` | 2 | 0 | - | 58, 76 |
| `src/core/persistence/head-blocker.ts` | 2 | 0 | - | 101, 169 |
| `src/core/persistence/links-extraction-holds.ts` | 2 | 0 | - | 54, 72 |
| `src/core/persistence/links-preparation.ts` | 2 | 0 | - | 46, 55 |
| `src/core/persistence/mirror-read-only.ts` | 2 | 0 | - | 46, 51 |
| `src/core/persistence/noop-kernel.ts` | 2 | 0 | - | 99, 128 |
| `src/core/persistence/origin-guard.ts` | 2 | 0 | - | 150, 167 |
| `src/core/persistence/origin-twins.ts` | 2 | 0 | - | 29, 50 |
| `src/core/persistence/orphan-bindings.ts` | 2 | 0 | - | 29, 37 |
| `src/core/persistence/purged-intent.ts` | 2 | 0 | - | 44, 50 |
| `src/core/persistence/rebuildable-cache.ts` | 2 | 0 | - | 19, 27 |
| `src/core/persistence/reconcile-audit.ts` | 2 | 0 | - | 60, 166 |
| `src/core/persistence/refusal-breaker.ts` | 2 | 0 | - | 37, 69 |
| `src/core/persistence/searchable.ts` | 2 | 0 | - | 33, 45 |
| `src/core/persistence/sync-concurrent-write.ts` | 2 | 0 | - | 29, 32 |
| `src/core/persistence/sync-delete-tombstones.ts` | 2 | 0 | 9/- | 24, 48 |
| `src/core/persistence/sync-freshness.ts` | 2 | 0 | - | 117, 125 |
| `src/core/persistence/sync-pass-carried.ts` | 2 | 0 | - | 16, 25 |
| `src/core/persistence/sync-pass-episode.ts` | 2 | 0 | 9/- | 156, 163 |
| `src/core/persistence/sync-prescreen.ts` | 2 | 0 | - | 108, 123 |
| `src/core/persistence/sync-slices.ts` | 2 | 0 | 9 | 33, 39 |
| `src/core/persistence/sync-tail.ts` | 2 | 2 | 9 | 61, 74 |
| `src/core/persistence/sync-window.ts` | 2 | 0 | - | 52, 58 |
| `src/core/reason-trailers.ts` | 2 | 0 | - | 151, 262 |
| `src/core/repair/access.ts` | 2 | 0 | - | 18, 29 |
| `src/core/repair/connector-fences.ts` | 2 | 0 | - | 58, 65 |
| `src/core/repair/loop-facts.ts` | 2 | 0 | - | 41, 56 |
| `src/core/repair/missing-tables.ts` | 2 | 2 | - | 64, 65 |
| `src/core/schema-migrations/v045-facts-hot-memory-v0-31.ts` | 2 | 2 | - | 34, 55 |
| `src/core/schema-migrations/v055-query-cache-search-lite.ts` | 2 | 2 | - | 41, 59 |
| `src/core/schema-migrations/v191-alias-source-cascade.ts` | 2 | 0 | - | 51, 59 |
| `src/core/schema-pack/detect.ts` | 2 | 0 | - | 124, 147 |
| `src/core/schema-verify.ts` | 2 | 0 | - | 155, 171 |
| `src/core/search/query-cache-gate.ts` | 2 | 2 | 6 | 105, 116 |
| `src/core/search/relational-recall.ts` | 2 | 0 | 6 | 153, 190 |
| `src/core/search/safe-chunks.ts` | 2 | 0 | 6 | 119, 168 |
| `src/core/search/transcript-quote.ts` | 2 | 0 | 6 | 135, 510 |
| `src/core/shared-skills/catalog.ts` | 2 | 0 | - | 26, 160 |
| `src/core/shared-skills/migration-projection.ts` | 2 | 0 | - | 52, 57 |
| `src/core/shared-skills/receipt-root.ts` | 2 | 0 | - | 38, 54 |
| `src/core/source-delete.ts` | 2 | 0 | - | 54, 69 |
| `src/core/sql-query.ts` | 2 | 0 | - | 40, 142 |
| `src/core/sync-upstream.ts` | 2 | 2 | - | 67, 73 |
| `src/core/think/index.ts` | 2 | 0 | - | 530, 534 |
| `src/core/trust/release-publish.ts` | 2 | 0 | - | 170, 246 |
| `src/core/trust/timeline-projection.ts` | 2 | 0 | - | 22, 59 |
| `src/core/url-clone.ts` | 2 | 0 | - | 72, 103 |
| `src/core/wakeshift/drain.ts` | 2 | 0 | - | 77, 80 |
| `src/core/write-gate-scan.ts` | 2 | 0 | 1 | 176, 196 |
| `src/core/write-through.ts` | 2 | 0 | 1 | 312, 389 |
| `src/eval/brainbench/metrics/deletion.ts` | 2 | 0 | - | 76, 78 |
| `src/eval/brainbench/metrics/state-resolution.ts` | 2 | 0 | - | 35, 69 |
| `src/eval/longmemeval/harness.ts` | 2 | 0 | - | 48, 57 |
| `src/eval/longmemeval/retrieval-arms.ts` | 2 | 0 | - | 190, 199 |
| `src/mcp/http-transport.ts` | 2 | 2 | - | 297, 376 |
| `src/cli/enforced-commit-push.ts` | 1 | 0 | - | 71 |
| `src/commands/agent-logs.ts` | 1 | 0 | 2 | 141 |
| `src/commands/agent.ts` | 1 | 0 | 2 | 455 |
| `src/commands/autopilot-daemon.ts` | 1 | 1 | 2 | 585 |
| `src/commands/autopilot-health.ts` | 1 | 1 | 2 | 33 |
| `src/commands/autopilot-retry-global.ts` | 1 | 0 | 2 | 21 |
| `src/commands/autopilot.ts` | 1 | 1 | 2 | 387 |
| `src/commands/autopilot/install-repo.ts` | 1 | 0 | 2 | 12 |
| `src/commands/code-scope.ts` | 1 | 1 | 2 | 221 |
| `src/commands/config.ts` | 1 | 1 | 2 | 1425 |
| `src/commands/decide/claims-sweep.ts` | 1 | 0 | 2 | 29 |
| `src/commands/doctor/checks/attest-read-access.ts` | 1 | 1 | 2 | 31 |
| `src/commands/doctor/checks/calibration.ts` | 1 | 1 | 2 | 286 |
| `src/commands/doctor/checks/connectors.ts` | 1 | 1 | 2 | 101 |
| `src/commands/doctor/checks/consolidation-cycle.ts` | 1 | 0 | 2 | 281 |
| `src/commands/doctor/checks/coordination-lock.ts` | 1 | 1 | 2 | 21 |
| `src/commands/doctor/checks/core-memory.ts` | 1 | 1 | 2 | 29 |
| `src/commands/doctor/checks/database-encoding.ts` | 1 | 1 | 2 | 22 |
| `src/commands/doctor/checks/db-connection.ts` | 1 | 1 | 2 | 317 |
| `src/commands/doctor/checks/derivation-pricing.ts` | 1 | 1 | 2 | 21 |
| `src/commands/doctor/checks/derivation-purge-sweeps.ts` | 1 | 1 | 2 | 21 |
| `src/commands/doctor/checks/embed-backfill-stalled.ts` | 1 | 1 | 2 | 33 |
| `src/commands/doctor/checks/embedding-plane.ts` | 1 | 1 | 2 | 25 |
| `src/commands/doctor/checks/facts-pages.ts` | 1 | 1 | 2 | 25 |
| `src/commands/doctor/checks/fence-integrity.ts` | 1 | 1 | 2 | 193 |
| `src/commands/doctor/checks/frontmatter-hook.ts` | 1 | 0 | 2 | 10 |
| `src/commands/doctor/checks/function-search-path.ts` | 1 | 0 | 2 | 25 |
| `src/commands/doctor/checks/git-index-lag.ts` | 1 | 1 | 2 | 33 |
| `src/commands/doctor/checks/google-api-access.ts` | 1 | 1 | 2 | 17 |
| `src/commands/doctor/checks/google-calendar.ts` | 1 | 1 | 2 | 18 |
| `src/commands/doctor/checks/image-embedding-coverage.ts` | 1 | 1 | 2 | 21 |
| `src/commands/doctor/checks/landing-gaps.ts` | 1 | 0 | 2 | 26 |
| `src/commands/doctor/checks/legacy-token-grants.ts` | 1 | 0 | 2 | 31 |
| `src/commands/doctor/checks/local-audits.ts` | 1 | 1 | 2 | 148 |
| `src/commands/doctor/checks/local-edit-adoptions.ts` | 1 | 1 | 2 | 23 |
| `src/commands/doctor/checks/managed-sync-convergence.ts` | 1 | 1 | 2 | 23 |
| `src/commands/doctor/checks/managed-sync-movement.ts` | 1 | 0 | 2 | 44 |
| `src/commands/doctor/checks/memory-writeback.ts` | 1 | 1 | 2 | 411 |
| `src/commands/doctor/checks/origin-twins.ts` | 1 | 1 | 2 | 35 |
| `src/commands/doctor/checks/persistence-capacity.ts` | 1 | 1 | 2 | 51 |
| `src/commands/doctor/checks/pglite-worker.ts` | 1 | 1 | 2 | 167 |
| `src/commands/doctor/checks/postgres-tls.ts` | 1 | 1 | 2 | 87 |
| `src/commands/doctor/checks/projection-readiness.ts` | 1 | 1 | 2 | 84 |
| `src/commands/doctor/checks/purge-mirror.ts` | 1 | 1 | 2 | 26 |
| `src/commands/doctor/checks/schema-function-bodies.ts` | 1 | 0 | 2 | 35 |
| `src/commands/doctor/checks/strict-facts-outside-git.ts` | 1 | 1 | 2 | 30 |
| `src/commands/doctor/checks/supervisor-health.ts` | 1 | 1 | 2 | 162 |
| `src/commands/doctor/checks/transcript-archive.ts` | 1 | 1 | 2 | 85 |
| `src/commands/doctor/checks/transcript-secrets.ts` | 1 | 1 | 2 | 30 |
| `src/commands/doctor/checks/trust-sources-unclaimed.ts` | 1 | 1 | 2 | 38 |
| `src/commands/doctor/checks/unindexed-files.ts` | 1 | 1 | 2 | 78 |
| `src/commands/doctor/checks/unlinked-facts.ts` | 1 | 0 | 2 | 72 |
| `src/commands/doctor/last-known.ts` | 1 | 1 | 9 | 65 |
| `src/commands/doctor/schema-pack-checks.ts` | 1 | 1 | 2 | 197 |
| `src/commands/edges-backfill.ts` | 1 | 1 | 2 | 88 |
| `src/commands/embed.ts` | 1 | 1 | 2 | 2118 |
| `src/commands/engine-status.ts` | 1 | 0 | 2 | 222 |
| `src/commands/eval-suspected-contradictions.ts` | 1 | 0 | 2 | 219 |
| `src/commands/eval-whoknows.ts` | 1 | 1 | 2 | 252 |
| `src/commands/export.ts` | 1 | 1 | 2 | 124 |
| `src/commands/extract-conversation-facts.ts` | 1 | 0 | 2 | 1667 |
| `src/commands/extract-explain.ts` | 1 | 1 | 2 | 156 |
| `src/commands/extract-stale-options.ts` | 1 | 0 | 2 | 59 |
| `src/commands/extract-status.ts` | 1 | 1 | 2 | 179 |
| `src/commands/google-setup-tail.ts` | 1 | 0 | 2 | 46 |
| `src/commands/google.ts` | 1 | 1 | 2 | 691 |
| `src/commands/guests.ts` | 1 | 0 | 2 | 140 |
| `src/commands/init-embedding-plane.ts` | 1 | 0 | 2 | 24 |
| `src/commands/integrity.ts` | 1 | 0 | 2 | 468 |
| `src/commands/jobs/work.ts` | 1 | 0 | 2 | 359 |
| `src/commands/loops.ts` | 1 | 0 | 2 | 62 |
| `src/commands/migrations/v0_16_0.ts` | 1 | 1 | 2 | 54 |
| `src/commands/migrations/v0_28_0.ts` | 1 | 1 | 2 | 75 |
| `src/commands/migrations/v0_29_1.ts` | 1 | 1 | 2 | 96 |
| `src/commands/migrations/v0_31_0.ts` | 1 | 1 | 2 | 57 |
| `src/commands/onboard.ts` | 1 | 0 | 2 | 64 |
| `src/commands/quarantine.ts` | 1 | 0 | 2 | 212 |
| `src/commands/recall.ts` | 1 | 1 | 2 | 687 |
| `src/commands/repair-propose.ts` | 1 | 0 | 2 | 118 |
| `src/commands/serve-health.ts` | 1 | 1 | 2 | 69 |
| `src/commands/serve-http-clients.ts` | 1 | 1 | 2 | 21 |
| `src/commands/serve-http.ts` | 1 | 0 | 2 | 859 |
| `src/commands/sources-canonical.ts` | 1 | 0 | 2 | 111 |
| `src/commands/sources-git-reconcile.ts` | 1 | 0 | 2 | 90 |
| `src/commands/sources-lifecycle.ts` | 1 | 1 | 2 | 58 |
| `src/commands/sources-pull-strategy.ts` | 1 | 0 | 2 | 28 |
| `src/commands/sources-reindex.ts` | 1 | 0 | 2 | 61 |
| `src/commands/sources-reset-upstream.ts` | 1 | 0 | 2 | 98 |
| `src/commands/sources-set-calendar.ts` | 1 | 0 | 2 | 28 |
| `src/commands/sources-sync-enabled.ts` | 1 | 0 | 2 | 41 |
| `src/commands/sources-writers.ts` | 1 | 0 | 2 | 38 |
| `src/commands/storage.ts` | 1 | 1 | 2 | 158 |
| `src/commands/sync/plain-directory.ts` | 1 | 0 | 2 | 92 |
| `src/commands/sync/rename-reconcile.ts` | 1 | 0 | 2 | 46 |
| `src/commands/sync/renames.ts` | 1 | 0 | 2 | 371 |
| `src/commands/trust.ts` | 1 | 0 | 2 | 298 |
| `src/commands/upgrade.ts` | 1 | 1 | 2 | 1093 |
| `src/core/access/federation-exposure.ts` | 1 | 0 | 11 | 32 |
| `src/core/access/implicit-placement.ts` | 1 | 0 | 11 | 41 |
| `src/core/access/open-twins.ts` | 1 | 0 | 11 | 30 |
| `src/core/access/owner.ts` | 1 | 0 | 11 | 144 |
| `src/core/access/policy-transfer.ts` | 1 | 0 | 11 | 34 |
| `src/core/access/serves.ts` | 1 | 0 | 11 | 39 |
| `src/core/access/token-member-status.ts` | 1 | 0 | 11 | 11 |
| `src/core/agent-install/shared-skills.ts` | 1 | 1 | - | 37 |
| `src/core/ai/decide/egress.ts` | 1 | 0 | 5 | 49 |
| `src/core/analyze-lock.ts` | 1 | 0 | - | 19 |
| `src/core/backup/coverage.ts` | 1 | 1 | - | 112 |
| `src/core/belief/ledger.ts` | 1 | 0 | 4 | 105 |
| `src/core/belief/writers.ts` | 1 | 0 | 4 | 29 |
| `src/core/bootstrap/harness-cleanup.ts` | 1 | 0 | - | 56 |
| `src/core/bootstrap/harness-skills.ts` | 1 | 0 | - | 97 |
| `src/core/brainstorm/orchestrator.ts` | 1 | 1 | - | 398 |
| `src/core/chronicle/event-identity.ts` | 1 | 0 | - | 90 |
| `src/core/code-graph-readiness.ts` | 1 | 0 | 5 | 49 |
| `src/core/config-values.ts` | 1 | 0 | - | 36 |
| `src/core/connectors/connector-hold-session.ts` | 1 | 1 | - | 50 |
| `src/core/context/compile-view.ts` | 1 | 0 | 10 | 308 |
| `src/core/context/volunteer.ts` | 1 | 1 | 10 | 370 |
| `src/core/core-memory.ts` | 1 | 1 | - | 337 |
| `src/core/cycle/extract-atoms-stamp.ts` | 1 | 1 | - | 46 |
| `src/core/cycle/filing-rules.ts` | 1 | 1 | - | 77 |
| `src/core/cycle/pattern-claim-sources.ts` | 1 | 0 | - | 97 |
| `src/core/cycle/patterns-plan.ts` | 1 | 0 | - | 135 |
| `src/core/cycle/synthesize-concepts.ts` | 1 | 1 | - | 178 |
| `src/core/cycle/synthesize-generations.ts` | 1 | 0 | - | 66 |
| `src/core/cycle/unindexed-files.ts` | 1 | 0 | - | 52 |
| `src/core/eligibility/activation.ts` | 1 | 0 | - | 56 |
| `src/core/eligibility/stamp.ts` | 1 | 1 | - | 195 |
| `src/core/embed-backfill-stall.ts` | 1 | 0 | - | 70 |
| `src/core/embed-takes.ts` | 1 | 0 | - | 49 |
| `src/core/embedding-state.ts` | 1 | 0 | - | 167 |
| `src/core/entities/near-name.ts` | 1 | 0 | - | 156 |
| `src/core/entities/resolve-on-save.ts` | 1 | 1 | - | 113 |
| `src/core/eval-contradictions/cost-prompt.ts` | 1 | 1 | 5 | 55 |
| `src/core/extract-takes-from-pages.ts` | 1 | 0 | - | 252 |
| `src/core/extraction-lag.ts` | 1 | 0 | - | 93 |
| `src/core/facts/absorb-log.ts` | 1 | 1 | 4 | 217 |
| `src/core/facts/backstop.ts` | 1 | 0 | 4 | 730 |
| `src/core/facts/contested-claims.ts` | 1 | 1 | 4 | 42 |
| `src/core/facts/conversation-entity-hints.ts` | 1 | 0 | 4 | 51 |
| `src/core/facts/conversation-incremental.ts` | 1 | 0 | 4 | 369 |
| `src/core/facts/conversation-relink-carry.ts` | 1 | 0 | 4 | 26 |
| `src/core/facts/embedding-identity.ts` | 1 | 0 | 4 | 60 |
| `src/core/facts/question-recall.ts` | 1 | 1 | 4 | 238 |
| `src/core/facts/relink.ts` | 1 | 0 | 4 | 181 |
| `src/core/facts/retire.ts` | 1 | 0 | 4 | 31 |
| `src/core/facts/slot-tagging.ts` | 1 | 0 | 4 | 65 |
| `src/core/facts/subject-infer.ts` | 1 | 0 | 4 | 256 |
| `src/core/facts/writeback-settings.ts` | 1 | 0 | 4 | 121 |
| `src/core/fence-repair/repair-io.ts` | 1 | 0 | - | 84 |
| `src/core/generations/adapters/single-page.ts` | 1 | 0 | 3 | 110 |
| `src/core/generations/adapters/synthesis.ts` | 1 | 0 | 3 | 33 |
| `src/core/google/counterparty.ts` | 1 | 1 | - | 47 |
| `src/core/google/file-modes.ts` | 1 | 0 | - | 88 |
| `src/core/google/loops-extract.ts` | 1 | 0 | - | 345 |
| `src/core/google/loops-reciprocity.ts` | 1 | 0 | - | 43 |
| `src/core/grants/model.ts` | 1 | 0 | - | 438 |
| `src/core/grants/shared-exposure.ts` | 1 | 0 | - | 99 |
| `src/core/guests/marker.ts` | 1 | 1 | - | 121 |
| `src/core/guests/owner-credentials.ts` | 1 | 0 | - | 72 |
| `src/core/guests/stamp-readable.ts` | 1 | 0 | - | 33 |
| `src/core/harness/client-setup.ts` | 1 | 0 | - | 46 |
| `src/core/import-chunk-reuse.ts` | 1 | 0 | - | 110 |
| `src/core/import-file.ts` | 1 | 0 | - | 1885 |
| `src/core/import-identity.ts` | 1 | 0 | - | 110 |
| `src/core/link-extraction.ts` | 1 | 0 | - | 1836 |
| `src/core/maintenance/run.ts` | 1 | 1 | - | 377 |
| `src/core/maintenance/status.ts` | 1 | 1 | - | 56 |
| `src/core/mentions/siblings.ts` | 1 | 1 | 6 | 101 |
| `src/core/minions/handlers/autopilot-cycle.ts` | 1 | 0 | - | 71 |
| `src/core/minions/handlers/contextual-reindex-per-chunk.ts` | 1 | 0 | - | 250 |
| `src/core/minions/handlers/facts-absorb.ts` | 1 | 0 | - | 74 |
| `src/core/minions/handlers/sync-job-drain.ts` | 1 | 1 | - | 43 |
| `src/core/minions/idempotency-coalesce.ts` | 1 | 0 | - | 23 |
| `src/core/minions/terminal-events.ts` | 1 | 0 | - | 42 |
| `src/core/minions/terminal-hook.ts` | 1 | 0 | - | 114 |
| `src/core/minions/worker-shutdown.ts` | 1 | 0 | - | 28 |
| `src/core/multi-source-drift.ts` | 1 | 0 | - | 192 |
| `src/core/notifier/nudge.ts` | 1 | 0 | - | 17 |
| `src/core/onboard/mcp-onboarding.ts` | 1 | 0 | - | 319 |
| `src/core/ops/admin.ts` | 1 | 0 | - | 267 |
| `src/core/ops/chronicle.ts` | 1 | 0 | - | 42 |
| `src/core/ops/context.ts` | 1 | 0 | - | 1028 |
| `src/core/ops/facts.ts` (removed on d972a45b41) | 1 | 1 | - | 705 |
| `src/core/ops/links.ts` | 1 | 1 | - | 397 |
| `src/core/ops/put-page-revision-source.ts` | 1 | 1 | - | 19 |
| `src/core/ops/search-type-filter.ts` | 1 | 1 | - | 42 |
| `src/core/ops/search.ts` | 1 | 1 | - | 594 |
| `src/core/ops/storage-manifest.ts` | 1 | 0 | - | 72 |
| `src/core/ops/trust.ts` | 1 | 0 | - | 47 |
| `src/core/ops/whois.ts` | 1 | 0 | - | 125 |
| `src/core/output/writer.ts` | 1 | 1 | - | 192 |
| `src/core/page-body/segment-facts.ts` | 1 | 0 | 3 | 52 |
| `src/core/page-body/segment-ledger.ts` | 1 | 0 | 3 | 39 |
| `src/core/page-body/streamed-import.ts` | 1 | 0 | 3 | 463 |
| `src/core/page-state/projection-status.ts` | 1 | 0 | 7 | 30 |
| `src/core/page-state/rebuild-estimate.ts` | 1 | 0 | 7 | 40 |
| `src/core/persistence/capacity-view.ts` | 1 | 0 | - | 34 |
| `src/core/persistence/compaction-pass.ts` | 1 | 0 | - | 81 |
| `src/core/persistence/connector-google-receipts.ts` | 1 | 0 | - | 112 |
| `src/core/persistence/connector-reset.ts` | 1 | 0 | - | 7 |
| `src/core/persistence/context.ts` | 1 | 0 | - | 103 |
| `src/core/persistence/derived-retirement-hold.ts` | 1 | 0 | - | 51 |
| `src/core/persistence/effect-catchup.ts` | 1 | 0 | 7 | 29 |
| `src/core/persistence/filesystem-guard.ts` | 1 | 0 | - | 99 |
| `src/core/persistence/git-door.ts` | 1 | 0 | - | 64 |
| `src/core/persistence/git-push-holds.ts` | 1 | 0 | - | 37 |
| `src/core/persistence/held-reads.ts` | 1 | 1 | - | 193 |
| `src/core/persistence/import-deferral.ts` | 1 | 0 | - | 48 |
| `src/core/persistence/import-prepare.ts` | 1 | 0 | - | 169 |
| `src/core/persistence/legacy-locks.ts` | 1 | 0 | - | 7 |
| `src/core/persistence/legacy-sync-failures.ts` | 1 | 0 | 9 | 52 |
| `src/core/persistence/limits.ts` | 1 | 0 | - | 32 |
| `src/core/persistence/managed-sources.ts` | 1 | 0 | - | 69 |
| `src/core/persistence/onboarding.ts` | 1 | 0 | - | 56 |
| `src/core/persistence/owner-activity.ts` | 1 | 0 | - | 45 |
| `src/core/persistence/page-advisories.ts` | 1 | 0 | - | 31 |
| `src/core/persistence/page-batch.ts` | 1 | 0 | - | 154 |
| `src/core/persistence/parked-groups.ts` | 1 | 0 | - | 28 |
| `src/core/persistence/pending-import.ts` | 1 | 0 | - | 83 |
| `src/core/persistence/preparation-budget.ts` | 1 | 1 | - | 120 |
| `src/core/persistence/protocol.ts` | 1 | 0 | - | 78 |
| `src/core/persistence/publication-deadline.ts` | 1 | 0 | 7 | 93 |
| `src/core/persistence/purge-name-stores.ts` | 1 | 0 | - | 16 |
| `src/core/persistence/put-page-screen.ts` | 1 | 1 | - | 38 |
| `src/core/persistence/receipt-true-up.ts` | 1 | 0 | - | 49 |
| `src/core/persistence/reconcile-prepare.ts` | 1 | 0 | - | 192 |
| `src/core/persistence/refresh-retry-hint.ts` | 1 | 1 | - | 18 |
| `src/core/persistence/semantic-pages.ts` | 1 | 0 | - | 101 |
| `src/core/persistence/sync-administration.ts` | 1 | 0 | - | 19 |
| `src/core/persistence/sync-admitted.ts` | 1 | 0 | - | 38 |
| `src/core/persistence/sync-authority.ts` | 1 | 0 | - | 122 |
| `src/core/persistence/sync-blocked.ts` | 1 | 0 | 9 | 47 |
| `src/core/persistence/sync-dry-run-writer.ts` | 1 | 0 | - | 10 |
| `src/core/persistence/sync-group.ts` | 1 | 0 | - | 162 |
| `src/core/persistence/sync-held-deletions.ts` | 1 | 0 | - | 58 |
| `src/core/persistence/sync-holds-carried.ts` | 1 | 0 | 9 | 45 |
| `src/core/persistence/sync-idle-skips.ts` | 1 | 0 | 9 | 32 |
| `src/core/persistence/sync-lanes.ts` | 1 | 0 | - | 187 |
| `src/core/persistence/sync-origin.ts` | 1 | 0 | - | 105 |
| `src/core/persistence/sync-pass-readers.ts` | 1 | 0 | - | 24 |
| `src/core/persistence/sync-screen.ts` | 1 | 0 | - | 327 |
| `src/core/persistence/sync-stop-class.ts` | 1 | 0 | 9 | 91 |
| `src/core/persistence/sync-streamed.ts` | 1 | 0 | - | 142 |
| `src/core/persistence/topology-transaction.ts` | 1 | 1 | - | 27 |
| `src/core/persistence/transfer-administration.ts` | 1 | 0 | - | 81 |
| `src/core/persistence/transient-retry.ts` | 1 | 0 | - | 83 |
| `src/core/persistence/unimported-file.ts` | 1 | 0 | - | 64 |
| `src/core/persistence/upload-streamed.ts` | 1 | 0 | - | 57 |
| `src/core/persistence/write-applied.ts` | 1 | 0 | - | 35 |
| `src/core/persistence/writer-versions.ts` | 1 | 0 | - | 105 |
| `src/core/post-upgrade-reembed.ts` | 1 | 0 | - | 45 |
| `src/core/quarantine-override.ts` | 1 | 0 | - | 77 |
| `src/core/questions/auto-think-migration.ts` | 1 | 0 | - | 110 |
| `src/core/questions/pages.ts` | 1 | 0 | - | 37 |
| `src/core/questions/receipt.ts` | 1 | 0 | - | 125 |
| `src/core/questions/service.ts` | 1 | 0 | - | 78 |
| `src/core/reindex-consent.ts` | 1 | 1 | - | 35 |
| `src/core/remediation/run.ts` | 1 | 1 | - | 76 |
| `src/core/repair/ghost-pages.ts` | 1 | 0 | - | 246 |
| `src/core/repair/label-write.ts` | 1 | 0 | - | 41 |
| `src/core/repair/rows-behind.ts` | 1 | 0 | - | 152 |
| `src/core/repair/safe-chunks.ts` | 1 | 0 | - | 39 |
| `src/core/repair/settle.ts` | 1 | 0 | - | 32 |
| `src/core/repair/slug-autoheal.ts` | 1 | 0 | 9 | 95 |
| `src/core/repair/timeline.ts` | 1 | 0 | - | 55 |
| `src/core/schema-migrations/v039-multimodal-dual-column-v0-27-1.ts` | 1 | 0 | - | 40 |
| `src/core/schema-migrations/v124-page-search-vector-drop-compiled-truth.ts` | 1 | 0 | - | 51 |
| `src/core/schema-migrations/v153-verified-text-projection-activation.ts` | 1 | 0 | - | 11 |
| `src/core/schema-migrations/v164-shared-brain-skills-and-membership.ts` | 1 | 0 | - | 10 |
| `src/core/schema-migrations/v225-drop-duplicate-embedding-null-index.ts` | 1 | 0 | - | 25 |
| `src/core/schema-migrations/v234-persistence-git-durability.ts` | 1 | 0 | - | 22 |
| `src/core/schema-migrations/v245-page-search-vector-bounded-timeline.ts` | 1 | 0 | - | 28 |
| `src/core/schema-migrations/v281-derived-state-maintainers-fail-closed.ts` | 1 | 0 | - | 36 |
| `src/core/schema-missing-tables.ts` | 1 | 0 | - | 95 |
| `src/core/schema-pack/engine-resolution.ts` | 1 | 0 | - | 84 |
| `src/core/schema-pack/entity-types.ts` | 1 | 0 | - | 117 |
| `src/core/schema-pack/page-to-link.ts` | 1 | 0 | - | 141 |
| `src/core/schema-pack/query-cache-invalidator.ts` | 1 | 1 | - | 61 |
| `src/core/schema-pack/review.ts` | 1 | 0 | - | 160 |
| `src/core/schema-pack/stats.ts` | 1 | 1 | - | 217 |
| `src/core/schema-pack/unify-types-handler.ts` | 1 | 0 | - | 276 |
| `src/core/search/dedup.ts` | 1 | 1 | 6 | 68 |
| `src/core/search/entity-facts.ts` | 1 | 0 | 6 | 53 |
| `src/core/search/evidence-delivery.ts` | 1 | 1 | 6 | 416 |
| `src/core/search/feedback-boost.ts` | 1 | 0 | 6 | 40 |
| `src/core/search/frontmatter-where.ts` | 1 | 0 | 6 | 104 |
| `src/core/search/ignored-privacy-labels.ts` | 1 | 1 | 6 | 179 |
| `src/core/search/image-vector-presence.ts` | 1 | 1 | 6 | 20 |
| `src/core/search/private-visibility.ts` | 1 | 0 | 6 | 1107 |
| `src/core/search/relational-chain.ts` | 1 | 0 | 6 | 328 |
| `src/core/search/saved-facts-match.ts` | 1 | 1 | 6 | 58 |
| `src/core/search/slot-history.ts` | 1 | 0 | 6 | 88 |
| `src/core/serve-sync-runner.ts` | 1 | 0 | - | 586 |
| `src/core/shared-skills/adopted-packs.ts` | 1 | 1 | - | 20 |
| `src/core/shared-skills/compatibility.ts` | 1 | 0 | - | 54 |
| `src/core/shared-skills/migration-members.ts` | 1 | 0 | - | 13 |
| `src/core/shared-skills/optimizer.ts` | 1 | 0 | - | 126 |
| `src/core/shared-skills/setup-source-policy.ts` | 1 | 0 | - | 16 |
| `src/core/similar-pages.ts` | 1 | 0 | - | 41 |
| `src/core/source-default-search.ts` | 1 | 0 | - | 25 |
| `src/core/source-health.ts` | 1 | 0 | - | 403 |
| `src/core/sweep.ts` | 1 | 0 | - | 655 |
| `src/core/sync-attempt.ts` | 1 | 1 | - | 45 |
| `src/core/sync-cost-gate.ts` | 1 | 1 | - | 490 |
| `src/core/sync-policy.ts` | 1 | 1 | - | 49 |
| `src/core/sync.ts` | 1 | 1 | - | 951 |
| `src/core/takes-quality-eval/receipt-write.ts` | 1 | 0 | 5 | 28 |
| `src/core/takes-quality-eval/replay.ts` | 1 | 0 | 5 | 60 |
| `src/core/takes-quality-eval/runner.ts` | 1 | 0 | 5 | 115 |
| `src/core/takes-quality-eval/trend.ts` | 1 | 0 | 5 | 38 |
| `src/core/think/persist-take.ts` | 1 | 1 | - | 148 |
| `src/core/timeline-write-through.ts` | 1 | 1 | 6 | 403 |
| `src/core/transcripts/discover.ts` | 1 | 0 | - | 205 |
| `src/core/transcripts/recover.ts` | 1 | 0 | - | 46 |
| `src/core/transcripts/secret-audit.ts` | 1 | 0 | - | 64 |
| `src/core/trust/channel.ts` | 1 | 0 | - | 225 |
| `src/core/trust/derived-gate.ts` | 1 | 0 | - | 64 |
| `src/core/trust/label-lowerings.ts` | 1 | 0 | - | 59 |
| `src/core/trust/privacy-hold-reply.ts` | 1 | 1 | - | 56 |
| `src/core/trust/refs.ts` | 1 | 0 | - | 79 |
| `src/core/uncommitted-deletions.ts` | 1 | 0 | - | 73 |
| `src/core/url-source-origin.ts` | 1 | 0 | - | 240 |
| `src/core/verbs/entity-names.ts` | 1 | 1 | - | 103 |
| `src/core/verbs/entity-references.ts` | 1 | 0 | - | 230 |
| `src/core/verbs/entity-source.ts` | 1 | 0 | - | 74 |
| `src/core/verbs/entity-text-mentions.ts` | 1 | 1 | - | 103 |
| `src/eval/brainbench/adapters/codex.ts` | 1 | 1 | - | 119 |
| `src/eval/brainbench/metrics/continuity.ts` | 1 | 0 | - | 68 |
| `src/eval/brainbench/metrics/write-back.ts` | 1 | 0 | - | 186 |
| `src/eval/brainbench/seed.ts` | 1 | 0 | - | 59 |
| `src/eval/brainbench/trust-suites.ts` | 1 | 0 | - | 84 |
| `src/eval/decide-eval-flags.ts` | 1 | 1 | - | 342 |
| `src/mcp/source-preflight.ts` | 1 | 1 | - | 47 |

