# Rust engine contract map: every CLI command and MCP op

Research map, pinned to `rust-engine/cli-members` at `955b18ef59`. It extends the
[first map](rust-cli-executeraw-map.md), which covered `import`, `extract all --source db` and eight read commands.
This map covers every other CLI command and every operation in `src/core/operations.ts`. It lists each `executeRaw`
call site that a real run makes on a PGLite brain, the typed `BrainEngine` member that can replace it, and the first
`engine_capability_missing` refusal that each command meets on a Rust brain. It changes no code.

## Summary

- The CLI on `955b18ef59` cannot open a Rust brain. `src/core/engine-construct.ts` throws
  `Unknown engine type: "rust". Supported engines: postgres, pglite.` The `case 'rust'` arm exists only on
  `rust-engine/pr8-construct` (`8725c0505f`) and `rust-engine/pr8-integration-preview`. A merge of pr8-construct into
  `955b18ef59` conflicts in `src/core/rust-engine.ts`, `scripts/check-orphan-modules.mjs`,
  `scripts/module-size-limits.tsv` and `test/fixtures/goldens/exports/types.json`.
- With that arm added, CLI `import` refuses on a Rust brain before it writes a page. The refusal is `executeRaw`
  (capability `raw_sql`) at `src/core/source-resolver.ts:377` (`pickSoleNonDefaultSource`, from
  `src/cli/commands/import.ts:438`). With `--source default` it refuses at `source-resolver.ts:671`
  (`assertSourceExists`). With a programmatic source id it refuses at `persistence/managed-mode.ts:53`
  (`readManagedMode`).
- 376 commands ran on Rust. 254 refuse on `executeRaw`, 63 on a typed member Rust does not implement yet, and 59
  do not refuse. The source resolver (`src/core/source-resolver.ts`) is the refusal for 199 of the 254. Every command
  that resolves a source refuses there, so the resolver hides all later refusals. A second Rust pass stubbed the three
  resolver reads (scratch only) to find the next refusal. In that pass, 121 commands still refuse on `executeRaw`, 143 refuse
  on a typed member that Rust does not implement yet, and 112 do not refuse.
- 872 call sites outside the first map need to move off `executeRaw`. 112 of them can use a member that exists now
  (107 of those members run on Rust). 757 need a new or extended member. The persistence write pipeline is the
  largest group: 180 sites and 1,857 calls.

## Counts

| Class | Sites | Calls | Meaning |
|---|---:|---:|---|
| existing typed member | 112 | 785 | A `BrainEngine` member on `955b18ef59` returns the same rows or does the same write. The call site can switch with no new engine code. 107 sites use a member that Rust implements now; 5 use `readPersistenceBrainId`, `deleteChunksExcept`, `setChunkerVersion` or `livePageIdsAt`, which Rust does not implement yet. |
| new member needed | 757 | 4,567 | No member returns these rows. A new typed member (or an extended one) is needed. Includes 2 sites that run through `executeRawDirect`, which is also `raw_sql`. |
| inside a typed member (found by review) | 3 | 18 | `core/page-state/tags.ts:9`, `:13`, `:19` run only inside the PGLite `addTag` and `removeTag`. Excluded from the move count. |
| total to move | 869 | 5,352 | |
| already inside a typed member | 5 | 79 | `core/search/read-enrichment.ts:254`, `:279`, `:294`, `:305`, `:360` run inside `getBacklinkCounts`, `getAdjacencyBoosts`, `getContentFlagsByPageIds`, `getUnverifiedExtractionPageIds` and `resolveAliases`. Excluded. |
| first-map sites | 57 | 4,412 | Sites that the first-map commands also reach (47 to move, 4 inside a member, 6 schema). See the first map. Excluded. |
| traced sites | 934 | 9,861 | Every site outside the control commands' own runs. |

There is no "covered by scope B" class in this map: scope B (`typed-import-search`) is merged into `955b18ef59`.

The "existing typed member" class is strict but was set mostly from the SQL text, the tables and the member
signatures. Many of these members read more rows or columns than the call needs (for example `listAllSources`
returns every source with the default first, and `getSource` returns more columns). The notes in the per-site rows
say so. Treat each row as a candidate that a lane confirms.

## Method

- Fixture: the 20-page brain in `test/fixtures/rust-cli-parity-brain/`. The PGLite base brain was made with CLI
  `import`. The Rust base brain was seeded in process through typed members, because CLI `import` refuses: 20 pages,
  28 tags, 55 links, 22 timeline entries and 34 chunks, with no embeddings.
- Commands: all 204 operations in `src/core/operations.ts` less the 8 first-map operations, run through the trusted
  local `call <op> <json>` path (`handleToolCall`, then `dispatchToolCall`), 182 of them run and 14 skipped. Also 73
  operation CLI forms (for example `tags`, `get`, `list`) and 121 CLI-only commands, run with realistic arguments.
  376 commands ran on both engines. Before some commands a setup step ran without logging (for example a
  `remember`, a `takes add`, a job submit, a storage register, a `sources add`, a page delete, or
  `config set feedback.enabled true`).
- Controls: the ten first-map commands ran on PGLite only. A site they reach is a first-map site and is excluded.
- PGLite arm: a scratch patch (never committed) to the PGLite `executeRaw`, and to the `executeRaw` handed out by
  `withReservedConnection`, logs the SQL text and the JavaScript stack of every call.
- Rust arm: a scratch worktree, never pushed. It is `955b18ef59` plus a clean merge of `rust-cli-connect`
  (`1bdf01ab21`), with `src/core/engine-construct.ts` taken from `rust-engine/pr8-construct`. A scratch patch to
  `capabilityMissing` in `src/core/rust-engine/errors.ts` logs the member and the stack of every refusal, including
  refusals that a caller catches.
- Second Rust pass: the same worktree with `pickSoleNonDefaultSource`, `assertSourceExists` and `liveSourceRows` in
  `src/core/source-resolver.ts` stubbed to the default source. It shows the refusal after the resolver.
- A site is the first stack frame outside the engine (`pglite-engine.ts`, `pglite-engine/`, `engine-sql/`) and the
  SQL helpers (`statement-deadline.ts`, `sql-query.ts`). A call is in the schema group when its stack passes through
  the migration runner. A call is inside a typed member when its stack passes through a `BrainEngine` member other
  than `executeRaw`, `executeRawDirect`, `transaction`, `withReservedConnection` and `initSchema`.
- Equality uses the normalize and compare rules of `test/rust-cli-parity.serial.test.ts` (ids, timestamps and
  clocks masked), with each arm's paths replaced by placeholders, on the JSON (or text) stdout and the exit code.
- Classification of the 872 sites into existing or new members, groups and owners was done by four reviewers, one per
  part of the tree, from the SQL, the tables, the function and, where unclear, the source.

## Limits

- Bun truncates async stacks, so the caller chain is often lost. The persistence write pipeline (journal,
  page-state transactions, managed mode, deactivation, protocol) seldom shows `putPage` or another typed write
  member in its frames. The "inside a typed member" count is therefore an undercount, and some "new member needed"
  sites in the persistence group may run only inside a typed write member. The persistence reviewer marked 13 sites
  "write pipeline" where it saw a submit-path caller.
- One fixture, one run per command, mostly happy paths. Branches the fixture does not take are not traced: no
  embeddings, no registered writer, no Google source, no storage backend, no attested actor, no Wakeshift.
- About 60 commands exit non-zero on PGLite too, after the code reached the traced sites. Examples:
  `writer_registration_required`, `wakeshift_not_enabled`, `upload_not_found`, `actor_not_attested`, no Google source
  for `loops_mute`, `embedded_engine_required` for `file_register` and `file_verify`, no storage backend,
  `revision_required`, version not found, an interactive confirm for `confirm_memory`, an invalid storage card, and
  job state errors. Sites after each failure are not traced.
- The Rust seed did not copy `source_path`, `import_filename` or `chunker_version`, because `putPage` refuses the
  `source_path` option. Commands that read these fields can differ for that reason alone.
- Equality can hide a refusal. A caller that catches a refusal and falls back looks equal. In the first Rust pass,
  `behavior-change-notice.ts:164` (`brainCreatedBefore`, from `completeEngineStartup`) refused in 315 runs and every
  one was caught. Treat an equal command with a caught refusal as a hidden refusal, not as parity.
- Proposed member names are the reviewers' proposals, one per site in most rows. A lane merges names that need the
  same rows. They are not checked against a Rust store design.
- Rust refusal sites in the per-command table are lines in the scratch worktree. Files changed by `rust-cli-connect`
  or by the stubs (`source-resolver.ts`, `search/hybrid/arms.ts`, `verbs/entity-card.ts`, `planner-stats.ts`,
  `persistence/deactivation.ts`, `persistence/graduation-schema.ts`) can differ by a few lines from `955b18ef59`.
  Per-site rows are `955b18ef59` lines.

## New members needed, grouped

Groups are ordered by new-member sites. "Existing" counts sites in the group that can switch to a current member.
Owner lanes follow `docs/designs/RUST_ENGINE_INTERFACES.md`. Where no family covers the tables, the owner column
proposes a new family.

| # | Group | Proposed owner | New sites | Existing-member sites | Calls | Main files |
|---:|---|---|---:|---:|---:|---|
| 1 | Persistence journal, effects, sync holds, page-state projections | core: new `persistence` family. The design keeps the journal with core | 180 | 4 | 1,857 | `core/page-state/projections.ts` (12), `core/persistence/journal.ts` (9), `core/persistence/effect-journal.ts` (7) |
| 2 | Page reads, counts and hygiene checks | Lane 1: page_ops | 72 | 4 | 270 | `core/repair/visibility.ts` (4), `commands/doctor/checks/extraction-sync.ts` (2), `commands/doctor/checks/content-quality.ts` (2) |
| 3 | Trust tiers, claims, review, fact withdrawal, beliefs | Lane 4: new `trust` family next to facts and contradictions | 64 | 4 | 310 | `core/facts/withdrawal.ts` (7), `commands/doctor/checks/routing-federation.ts` (4), `core/trust/backfill.ts` (4) |
| 4 | Minion job queue, cycle locks, Wakeshift rows | core: new `jobs` family (queue claims need transactions) | 60 | 1 | 131 | `core/minions/queue.ts` (18), `commands/doctor/checks/legacy-job-authority.ts` (5), `commands/status.ts` (5) |
| 5 | Facts queries, purge and unlinked-fact checks | Lane 4: facts | 50 | 0 | 163 | `commands/doctor/checks/unlinked-facts.ts` (3), `core/persistence/loop-fact-retirement.ts` (2), `core/facts/unfenced-facts.ts` (2) |
| 6 | Doctor catalog probes and one-off health SQL | core: catalog probes become Rust no-ops; counts go to the family that owns each table | 35 | 1 | 163 | `commands/doctor/checks/atom-retirements.ts` (2), `commands/doctor/checks/core-health.ts` (2), `commands/doctor/checks/graph-embedding.ts` (2) |
| 7 | Source rows, local paths, routing, source config | core: new `sources` family (with the source delete cascade) | 30 | 69 | 319 | `core/sources-ops.ts` (2), `core/repair/frontmatter.ts` (2), `commands/doctor/checks/frontmatter-hook.ts` (1) |
| 8 | Page body storage, uploads and projections | Lane 3: page_body | 27 | 0 | 131 | `commands/doctor/checks/content-quality.ts` (4), `core/persistence/page-upload.ts` (4), `commands/doctor/checks/calibration.ts` (2) |
| 9 | Journal request writes and planner settings inside transactions | core: transactions | 24 | 0 | 456 | `core/persistence/journal.ts` (5), `core/persistence/page-upload.ts` (3), `core/repair/attribution-backfill.ts` (3) |
| 10 | Link, edge and relationship queries | Lane 6: link_queries | 20 | 0 | 57 | `commands/doctor/checks/edge-validity.ts` (3), `commands/doctor/checks/graph-embedding.ts` (3), `commands/doctor/checks/graph-health.ts` (3) |
| 11 | Chunk, code-reference and readiness queries | Lane 6: chunk_queries | 19 | 1 | 100 | `core/code-intel/recursive-walk.ts` (2), `core/code-graph-readiness.ts` (2), `commands/code-def.ts` (2) |
| 12 | Shared skills catalog, policy and retention | core: with the `persistence` family (reads persistence_requests) | 15 | 1 | 184 | `core/shared-skills/retention.ts` (4), `core/shared-skills/knowledge-guard.ts` (2), `core/shared-skills/catalog.ts` (2) |
| 13 | Takes rows and projections | Lane 5: takes | 14 | 0 | 68 | `core/persistence/takes-prepare.ts` (7), `commands/doctor/checks/core-health.ts` (1), `core/persistence/canonical-projections.ts` (1) |
| 14 | Search telemetry, MCP usage, feedback, budget | Lane 6: new `search_telemetry` family | 13 | 0 | 66 | `core/mcp-usage.ts` (3), `core/feedback/store.ts` (3), `core/ops/usage.ts` (2) |
| 15 | Timeline projections and checks | Lane 6: timeline_queries | 12 | 0 | 153 | `core/persistence/canonical-projections.ts` (4), `core/repair/timeline.ts` (3), `commands/doctor/checks/knowledge-health.ts` (2) |
| 16 | Chronicle ledger | Lane 4: new `chronicle` family | 10 | 0 | 41 | `core/chronicle/ledger-stats.ts` (5), `core/cycle/chronicle.ts` (2), `core/chronicle/ledger.ts` (2) |
| 17 | Mentions, referrers and gazetteer | Lane 2: new `mentions` family next to aliases | 10 | 0 | 24 | `core/mentions/referrers.ts` (4), `core/by-mention.ts` (3), `core/mentions/coverage.ts` (2) |
| 18 | Embedding state and coverage counts | core: embeddings | 10 | 0 | 20 | `core/page-state/projections.ts` (2), `commands/doctor/checks/data-integrity.ts` (1), `commands/doctor/checks/embedding-health.ts` (1) |
| 19 | Alias fan-out and alias checks | Lane 2: aliases | 8 | 0 | 34 | `core/search/alias-fanout.ts` (2), `core/onboard/checks.ts` (2), `core/persistence/links-preparation.ts` (1) |
| 20 | Access members, guests and OAuth rows | core: new `access` family | 8 | 0 | 28 | `core/access/serves.ts` (1), `core/access/members.ts` (1), `core/access/labelled-only.ts` (1) |
| 21 | Entity identity, entity card and questions | Lane 2: new `entity_identity` family | 8 | 0 | 23 | `core/questions/store.ts` (3), `core/entity-identity.ts` (3), `core/verbs/entity-card.ts` (2) |
| 22 | AI decide store and calibration rollups | Lane 5: new `decide` family next to eval_capture | 8 | 0 | 13 | `core/ai/decide/store.ts` (5), `core/ai/decide/review-lane.ts` (2), `commands/calibration.ts` (1) |
| 23 | Schema-pack type statistics | Lane 4: with ontology | 7 | 0 | 104 | `core/schema-pack/detect.ts` (3), `core/schema-pack/stats.ts` (2), `core/schema-pack/entity-types.ts` (1) |
| 24 | Derived generations and fences | Lane 4: new `generations` family | 7 | 0 | 37 | `commands/doctor/checks/generations.ts` (2), `core/generations/managed.ts` (2), `core/generations/fence.ts` (2) |
| 25 | Raw data and file metadata | Lane 4: raw_files | 7 | 0 | 11 | `commands/doctor/checks/data-integrity.ts` (2), `core/ops/files.ts` (2), `commands/doctor/checks/queue-assets.ts` (1) |
| 26 | Connect and source resolver | rust-cli-connect | 6 | 4 | 204 | `commands/doctor/checks/db-connection.ts` (1), `commands/upgrade.ts` (1), `core/sync-pending.ts` (1) |
| 27 | Core memory and open loops | Lane 4: new `loops` family | 5 | 0 | 15 | `core/core-memory.ts` (2), `core/loops/loops-store.ts` (2), `core/verbs/entity-card.ts` (1) |
| 28 | Extraction state checks and rollups | Lane 2: extraction | 5 | 0 | 10 | `commands/doctor/checks/extraction-input.ts` (2), `commands/doctor/checks/extraction-sync.ts` (1), `core/cycle/extract-atoms.ts` (1) |
| 29 | Config reads | core: 23 of 27 sites can use getConfig or getConfigValues now | 4 | 23 | 292 | `core/transcripts/archive.ts` (2), `core/health-memo.ts` (1), `core/config-db-merge.ts` (1) |
| 30 | Keyword arms and search vectors | Lane 6: keyword | 4 | 0 | 12 | `core/search/retrieval-coverage.ts` (1), `core/search/entity-anchor.ts` (1), `core/search/fact-relevance.ts` (1) |
| 31 | Edge contradictions | Lane 4: contradictions | 4 | 0 | 4 | `core/cycle/edge-contradictions.ts` (2), `commands/edge-proposals.ts` (1), `core/trust/review.ts` (1) |
| 32 | Stats, connectors and backup coverage | Lane 4: stats | 3 | 0 | 10 | `commands/doctor/checks/connectors.ts` (1), `commands/doctor/checks/knowledge-health.ts` (1), `core/backup/coverage.ts` (1) |
| 33 | Ontology facts and supersede | Lane 4: ontology | 3 | 0 | 8 | `core/repair/ontology-facts.ts` (1), `core/trust/supersede-handlers.ts` (1), `core/belief/writers.ts` (1) |
| 34 | Planner statistics | core: decision; a Rust no-op may be right | 2 | 0 | 48 | `core/planner-stats.ts` (2) |
| 35 | Code edges and traversal cache | Lane 5: code_edges | 2 | 0 | 2 | `core/code-intel/traversal-cache.ts` (1), `core/chunkers/symbol-resolver.ts` (1) |
| 36 | Salience checks | Lane 5: salience | 1 | 0 | 2 | `commands/doctor/checks/knowledge-health.ts` (1) |

Notes on the groups:

- Group 1 (persistence) is the largest by calls. Part of it may run only inside typed write members (see Limits).
  The design keeps journal writes with core ("Write transactions and the journal"), so this group needs a core
  decision first: a `persistence` family of typed members, or a Rust journal that the write members call directly.
- Group 7 (sources) is mostly switchable now: 69 of its 99 sites can use `listAllSources`, `getSource`,
  `listSourceRecords`, `listLocalPathSources`, `listSourceRoutingRows` or `readSourceIncarnation`, which Rust
  implements. Most of these reads need the `archived` flag or a narrower filter applied in TypeScript.
- The config group needs almost no engine work: 23 of its 27 sites can use `getConfig` or `getConfigValues`.
- Catalog probes (`to_regclass`, `pg_catalog`, `pg_index`, `information_schema`, `set_config`, planner settings)
  appear in several groups. On Rust most of them have one fixed answer, so a no-op member or a capability check is a
  candidate. That is a core decision.
- `readPersistenceBrainId` (`core/persistence/identity.ts:207`) is the most common typed refusal after the resolver
  (43 commands in the second pass). It is an existing member that Rust does not implement yet.

## First refusal per command

"As built" is the first Rust pass. "Resolver stubbed" is the second pass. A command with no refusal can still differ
from PGLite (see the equal column). `call:` rows are the MCP operation through `call`; `cli:` rows are the
operation's CLI form; `cmd:` rows are CLI-only commands.

Most common refusals in the second pass:

| Member | Site (worktree line) | Commands |
|---|---|---:|
| `readPersistenceBrainId` | `core/persistence/identity.ts:207` | 43 |
| `executeRaw` | `core/minions/queue.ts:704` | 7 |
| `executeRaw` | `core/ops/storage-manifest.ts:37` | 7 |
| `executeRaw` | `core/persistence/managed-mode.ts:53` | 6 |
| `executeRaw` | `core/shared-skills/compatibility.ts:10` | 6 |
| `searchTitles` | `core/search/hybrid/arms.ts:100` | 5 |
| `executeRaw` | `core/sources-ops.ts:904` | 4 |
| `executeRaw` | `commands/orphans.ts:68` | 3 |
| `executeRaw` | `core/shared-skills/retention.ts:127` | 3 |
| `executeRaw` | `core/loops/loops-store.ts:262` | 3 |
| `getHealth` | `core/remediation/plan.ts:50` | 3 |
| `executeRaw` | `core/source-resolver.ts:756` | 3 |
| `executeRaw` | `core/chronicle/backfill.ts:139` | 2 |
| `getTimelineForDate` | `core/ops/chronicle.ts:78` | 2 |
| `getLastSeen` | `core/ops/chronicle.ts:151` | 2 |
| `getOnThisDay` | `core/ops/chronicle.ts:105` | 2 |
| `getSince` | `core/ops/chronicle.ts:128` | 2 |
| `resolveAliases` | `core/verbs/entity-card.ts:341` | 2 |
| `executeRaw` | `core/entity-identity.ts:71` | 2 |
| `executeRaw` | `core/entity-identity.ts:220` | 2 |

Typed members that refuse in the second pass, by number of commands (143 in all): `readPersistenceBrainId` 43, `transaction` 9, `getHealth` 6, `searchTitles` 5, `getSince` 4, `readPageSnapshot (option resolveAlias)` 4, `findTrajectory` 4, `getStats` 4, `listTakes` 4, `listAllPageRefs` 4, `findAnomalies` 3, `getRecentSalience` 3, `getTimelineForDate` 2, `getLastSeen` 2, `getOnThisDay` 2, `resolveAliases` 2, `resolveSlugWithAlias` 2, `loadContradictionsTrend` 2, `findPages` 2, `getBacklinks (option temporal)` 2, `getLinks (option temporal)` 2, `getTimeline (option eligibility)` 2, `listLinkSources` 2, `listPages (option listColumnsOnly)` 2, `findOntologyConflicts` 2, `discoverOntologyDimensions` 2, `getOntology` 2, `searchKeywordPages` 2, `getCalibrationCurve` 2, `getScorecard` 2, `searchTakes` 2, `traverseGraph (option temporal)` 2, `getCalleesOf` 1, `getCallersOf` 1, `getChunkPage` 1, `getIngestLog` 1, `getRawData` 1, `logIngest` 1, `putRawData` 1, `resolveSlugs` 1, `acquireCycleLock` 1, `unknown` 1

| Command | PGLite exit | Rust, as built | Rust, resolver stubbed | Refusal site (stubbed) | Equal (stubbed) |
|---|---:|---|---|---|---|
| `call:abort_page_upload` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:add_link` | 0 | `executeRaw` | `executeRaw` | `core/persistence/managed-mode.ts:53` | no |
| `call:add_tag` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:add_timeline_entry` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:advisor` | 0 | `executeRaw` | none |  | no |
| `call:append_page` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:assemble_evidence` | 0 | `executeRaw` | `executeRaw` | `core/search/evidence-delivery.ts:1652` | no |
| `call:begin_page_upload` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:cache_stats` | 0 | `executeRaw` | none |  | yes |
| `call:cancel_job` | 0 | `executeRaw` | `transaction` | `core/minions/queue.ts:1059` | no |
| `call:cancel_write_request` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:capture` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:chronicle_backfill` | 0 | `executeRaw` | `executeRaw` | `core/chronicle/backfill.ts:139` | no |
| `call:chronicle_day` | 0 | `executeRaw` | `getTimelineForDate` | `core/ops/chronicle.ts:78` | no |
| `call:chronicle_last_seen` | 0 | `executeRaw` | `getLastSeen` | `core/ops/chronicle.ts:151` | no |
| `call:chronicle_on_this_day` | 0 | `executeRaw` | `getOnThisDay` | `core/ops/chronicle.ts:105` | no |
| `call:chronicle_since` | 0 | `executeRaw` | `getSince` | `core/ops/chronicle.ts:128` | no |
| `call:code_blast` | 0 | `executeRaw` | none |  | no |
| `call:code_callees` | 0 | `executeRaw` | `getCalleesOf` | `core/ops/code-intel.ts:99` | no |
| `call:code_callers` | 0 | `executeRaw` | `getCallersOf` | `core/ops/code-intel.ts:59` | no |
| `call:code_def` | 0 | `executeRaw` | `executeRaw` | `commands/code-def.ts:65` | no |
| `call:code_flow` | 0 | `executeRaw` | none |  | no |
| `call:code_refs` | 0 | `executeRaw` | `executeRaw` | `commands/code-refs.ts:54` | no |
| `call:code_traversal_cache_clear` | 0 | `executeRaw` | `executeRaw` | `core/code-intel/traversal-cache.ts:174` | no |
| `call:commit_page_upload` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:confirm_memory` | 3 | `executeRaw` | `executeRaw` | `core/trust/owner-actions.ts:137` | no |
| `call:connectors_status` | 0 | `executeRaw` | none |  | yes |
| `call:context_pack` | 0 | `executeRaw` | none |  | no |
| `call:delete_page` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:delete_skill` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:delta` | 0 | `executeRaw` | none |  | no |
| `call:edit_page` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:entity` | 0 | `executeRaw` | `resolveAliases` | `core/verbs/entity-card.ts:341` | no |
| `call:entity_identity_link` | 0 | `executeRaw` | `executeRaw` | `core/entity-identity.ts:71` | no |
| `call:entity_identity_list` | 0 | `executeRaw` | `executeRaw` | `core/entity-identity.ts:220` | no |
| `call:entity_identity_unlink` | 0 | `executeRaw` | `executeRaw` | `core/entity-identity.ts:146` | no |
| `call:extract_entities` | 0 | `executeRaw` | `resolveSlugWithAlias` | `core/enrichment-service.ts:226` | no |
| `call:extraction_review` | 0 | `executeRaw` | none |  | yes |
| `call:fetch` | 0 | `executeRaw` | `readPageSnapshot (option resolveAlias)` | `core/ops/pages.ts:302` | no |
| `call:file_list` | 0 | `executeRaw` | `executeRaw` | `core/ops/files.ts:45` | no |
| `call:file_register` | 1 | `executeRaw` | none |  | yes |
| `call:file_upload` | 1 | `executeRaw` | none |  | no |
| `call:file_url` | 1 | `executeRaw` | `executeRaw` | `core/ops/files.ts:204` | no |
| `call:file_verify` | 1 | `executeRaw` | none |  | yes |
| `call:find_anomalies` | 0 | `executeRaw` | `findAnomalies` | `core/ops/salience.ts:97` | no |
| `call:find_contradictions` | 0 | `executeRaw` | `loadContradictionsTrend` | `core/ops/insights.ts:259` | no |
| `call:find_experts` | 0 | `executeRaw` | `searchTitles` | `core/search/hybrid/arms.ts:100` | no |
| `call:find_orphans` | 0 | `executeRaw` | `executeRaw` | `commands/orphans.ts:68` | no |
| `call:find_pages` | 0 | `executeRaw` | `findPages` | `core/ops/find-pages.ts:78` | no |
| `call:find_trajectory` | 0 | `executeRaw` | `findTrajectory` | `core/ops/insights.ts:354` | no |
| `call:forget` | 0 | `executeRaw` | none |  | no |
| `call:forget_fact` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:get_active_schema_pack` | 0 | `executeRaw` | none |  | yes |
| `call:get_backlinks` | 0 | `executeRaw` | `getBacklinks (option temporal)` | `core/ops/links.ts:331` | no |
| `call:get_brain_health` | 0 | `executeRaw` | none |  | no |
| `call:get_brain_identity` | 0 | `executeRaw` | `getStats` | `core/ops/admin.ts:145` | no |
| `call:get_calibration_profile` | 0 | `executeRaw` | `executeRaw` | `commands/calibration.ts:72` | no |
| `call:get_chunks` | 0 | `executeRaw` | `getChunkPage` | `core/ops/chunks.ts:72` | no |
| `call:get_health` | 0 | `executeRaw` | `getHealth` | `core/ops/admin.ts:96` | no |
| `call:get_ingest_log` | 0 | `executeRaw` | `getIngestLog` | `core/ops/ingest-log.ts:76` | no |
| `call:get_job` | 0 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:704` | no |
| `call:get_job_progress` | 0 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:704` | no |
| `call:get_job_stats` | 0 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:1321` | no |
| `call:get_links` | 0 | `executeRaw` | `getLinks (option temporal)` | `core/ops/links.ts:330` | no |
| `call:get_memory_settings` | 0 | `executeRaw` | none |  | yes |
| `call:get_page` | 0 | `executeRaw` | `readPageSnapshot (option resolveAlias)` | `core/ops/pages.ts:155` | no |
| `call:get_page_upload` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:get_raw_data` | 0 | `executeRaw` | `getRawData` | `core/ops/raw-data.ts:56` | no |
| `call:get_recent_salience` | 0 | `executeRaw` | `getRecentSalience` | `core/ops/salience.ts:54` | no |
| `call:get_recent_transcripts` | 0 | `executeRaw` | none |  | yes |
| `call:get_skill` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/compatibility.ts:10` | no |
| `call:get_skill_asset` | 1 | `executeRaw` | `transaction` | `core/shared-skills/catalog.ts:101` | no |
| `call:get_skill_policy` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/policy.ts:234` | no |
| `call:get_skill_retention` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/retention.ts:127` | no |
| `call:get_stats` | 0 | `executeRaw` | `getStats` | `core/ops/admin.ts:60` | no |
| `call:get_status_snapshot` | 0 | `executeRaw` | `executeRaw` | `core/ops/skills-catalog.ts:374` | no |
| `call:get_tags` | 0 | `executeRaw` | none |  | yes |
| `call:get_timeline` | 0 | `executeRaw` | `getTimeline (option eligibility)` | `core/ops/timeline.ts:109` | no |
| `call:get_usage` | 0 | `executeRaw` | none |  | no |
| `call:get_versions` | 0 | `executeRaw` | none |  | yes |
| `call:get_write_attribution` | 0 | `executeRaw` | `executeRaw` | `core/ops/attribution.ts:170` | no |
| `call:get_write_request` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:import_skill_proposal` | 2 | `executeRaw` | none |  | yes |
| `call:join_brain` | 1 | `executeRaw` | none |  | yes |
| `call:leave_brain` | 1 | `executeRaw` | `transaction` | `core/shared-skills/membership.ts:273` | no |
| `call:list_brain_skillpack` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/compatibility.ts:10` | no |
| `call:list_jobs` | 0 | `executeRaw` | `executeRaw` | `core/minions/job-list-page.ts:40` | no |
| `call:list_link_sources` | 0 | `executeRaw` | `listLinkSources` | `core/ops/links.ts:487` | no |
| `call:list_page_purges` | 0 | `executeRaw` | `executeRaw` | `core/persistence/page-purge.ts:517` | no |
| `call:list_pages` | 0 | `executeRaw` | `listPages (option listColumnsOnly)` | `core/ops/pages.ts:624` | no |
| `call:list_schema_packs` | 0 | `executeRaw` | none |  | yes |
| `call:list_skills` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/compatibility.ts:10` | no |
| `call:list_watches` | 1 | `executeRaw` | none |  | yes |
| `call:list_write_conflicts` | 0 | `executeRaw` | `executeRaw` | `core/persistence/drift-conflicts.ts:298` | no |
| `call:list_write_requests` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:log_ingest` | 0 | `executeRaw` | `logIngest` | `core/ops/ingest-log.ts:44` | no |
| `call:loops_close` | 0 | `executeRaw` | `executeRaw` | `core/loops/loops-store.ts:204` | no |
| `call:loops_mute` | 2 | `executeRaw` | none |  | yes |
| `call:loops_unmute` | 2 | `executeRaw` | none |  | yes |
| `call:memory_conversation_mode` | 0 | `executeRaw` | none |  | yes |
| `call:memory_propose` | 1 | `executeRaw` | none |  | yes |
| `call:memory_recall` | 0 | `executeRaw` | none |  | no |
| `call:memory_write` | 1 | `executeRaw` | none |  | yes |
| `call:mute_notice` | 0 | `executeRaw` | none |  | yes |
| `call:ontology_conflicts` | 0 | `executeRaw` | `findOntologyConflicts` | `core/ops/chronicle.ts:298` | no |
| `call:ontology_dimensions` | 0 | `executeRaw` | `discoverOntologyDimensions` | `core/ops/chronicle.ts:281` | no |
| `call:ontology_get` | 0 | `executeRaw` | `getOntology` | `core/ops/chronicle.ts:183` | no |
| `call:ontology_propose` | 0 | `executeRaw` | `executeRaw` | `core/belief/writers.ts:41` | no |
| `call:open_loops` | 0 | `executeRaw` | `executeRaw` | `core/loops/loops-store.ts:262` | no |
| `call:pause_job` | 0 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:2299` | no |
| `call:promote_guest_note` | 1 | `executeRaw` | `executeRaw` | `core/guests/promote.ts:49` | no |
| `call:prune_skill_revisions` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/retention.ts:127` | no |
| `call:purge_deleted_pages` | 0 | `executeRaw` | `executeRaw` | `core/persistence/derived-origin-hold.ts:111` | no |
| `call:purge_fact` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:put_page` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:put_pages` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:put_raw_data` | 0 | `executeRaw` | `putRawData` | `core/ops/raw-data.ts:36` | no |
| `call:put_skill` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:quarantine_list` | 0 | `executeRaw` | none |  | yes |
| `call:query` | 0 | `executeRaw` | `searchTitles` | `core/search/hybrid/arms.ts:100` | no |
| `call:questions_list` | 0 | `executeRaw` | `executeRaw` | `core/questions/store.ts:115` | no |
| `call:questions_pin` | 0 | `executeRaw` | `executeRaw` | `core/questions/service.ts:78` | no |
| `call:questions_status` | 1 | `executeRaw` | none |  | yes |
| `call:questions_unpin` | 1 | `executeRaw` | none |  | yes |
| `call:rate_answer` | 2 | `executeRaw` | none |  | yes |
| `call:reload_schema_pack` | 0 | `executeRaw` | none |  | yes |
| `call:remember` | 0 | `executeRaw` | none |  | no |
| `call:remove_link` | 0 | `executeRaw` | `executeRaw` | `core/persistence/managed-mode.ts:53` | no |
| `call:remove_tag` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:replay_job` | 2 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:704` | no |
| `call:request_tools` | 0 | `executeRaw` | none |  | yes |
| `call:resolve_slugs` | 0 | `executeRaw` | `resolveSlugs` | `?` | no |
| `call:restore_page` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:resume_job` | 2 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:704` | no |
| `call:retain_skill_revision` | 1 | `executeRaw` | `executeRaw` | `core/shared-skills/retention.ts:127` | no |
| `call:retry_job` | 2 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:704` | no |
| `call:revert_version` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:run_doctor` | 0 | `executeRaw` | none |  | no |
| `call:run_onboard` | 0 | `executeRaw` | `getHealth` | `core/remediation/plan.ts:50` | no |
| `call:schema_apply_mutations` | 0 | `executeRaw` | none |  | yes |
| `call:schema_explain_type` | 0 | `executeRaw` | none |  | yes |
| `call:schema_graph` | 0 | `executeRaw` | none |  | yes |
| `call:schema_lint` | 0 | `executeRaw` | none |  | yes |
| `call:schema_review_orphans` | 0 | `executeRaw` | `executeRaw` | `core/schema-pack/review.ts:146` | no |
| `call:schema_stats` | 0 | `executeRaw` | `executeRaw` | `core/schema-pack/stats.ts:178` | no |
| `call:search` | 0 | `executeRaw` | `searchKeywordPages` | `core/search/keyword-paging.ts:184` | no |
| `call:search_modes` | 0 | `executeRaw` | none |  | yes |
| `call:search_stats` | 0 | `executeRaw` | none |  | yes |
| `call:search_tune` | 0 | `executeRaw` | none |  | yes |
| `call:send_job_message` | 0 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:704` | no |
| `call:set_memory_writeback` | 0 | `executeRaw` | none |  | yes |
| `call:set_skill_policy` | 2 | `executeRaw` | none |  | yes |
| `call:sources_add` | 0 | `executeRaw` | `executeRaw` | `core/source-default-search.ts:39` | no |
| `call:sources_inspect` | 0 | `executeRaw` | none |  | no |
| `call:sources_remove` | 0 | `executeRaw` | `executeRaw` | `core/persistence/managed-mode.ts:53` | no |
| `call:sources_resolve_path` | 1 | `executeRaw` | `executeRaw` | `core/persistence/resolve-paths.ts:122` | no |
| `call:sources_status` | 0 | `executeRaw` | `executeRaw` | `core/sources-ops.ts:299` | no |
| `call:storage_find` | 0 | `executeRaw` | `executeRaw` | `core/ops/storage-manifest.ts:37` | no |
| `call:storage_get` | 1 | `executeRaw` | `executeRaw` | `core/ops/storage-manifest.ts:37` | no |
| `call:storage_list` | 0 | `executeRaw` | `executeRaw` | `core/ops/storage-manifest.ts:37` | no |
| `call:storage_register` | 1 | `executeRaw` | none |  | yes |
| `call:storage_update` | 1 | `executeRaw` | `executeRaw` | `core/ops/storage-manifest.ts:37` | no |
| `call:submit_job` | 0 | `executeRaw` | `transaction` | `core/minions/queue.ts:355` | no |
| `call:sync_brain` | 0 | `executeRaw` | `executeRaw` | `core/source-resolver.ts:756` | no |
| `call:sync_brain_skills` | 1 | `executeRaw` | `transaction` | `core/shared-skills/membership.ts:224` | no |
| `call:takes_add` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:takes_calibration` | 0 | `executeRaw` | `getCalibrationCurve` | `core/ops/takes.ts:240` | no |
| `call:takes_list` | 0 | `executeRaw` | `listTakes` | `core/ops/takes.ts:104` | no |
| `call:takes_rebuild` | 0 | `executeRaw` | `listAllPageRefs` | `core/cycle/extract-takes.ts:329` | no |
| `call:takes_remove` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:takes_resolve` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:takes_scorecard` | 0 | `executeRaw` | `getScorecard` | `core/ops/takes.ts:187` | no |
| `call:takes_search` | 0 | `executeRaw` | `searchTakes` | `core/ops/takes.ts:139` | no |
| `call:takes_supersede` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:takes_update` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `call:traverse_graph` | 0 | `executeRaw` | `traverseGraph (option temporal)` | `core/ops/links.ts:634` | no |
| `call:unpurge_page` | 0 | `executeRaw` | `transaction` | `core/persistence/page-purge.ts:529` | no |
| `call:unwatch` | 1 | `executeRaw` | none |  | yes |
| `call:upload_page_part` | 2 | `executeRaw` | none |  | yes |
| `call:volunteer_chronicle` | 0 | `executeRaw` | `getSince` | `core/context/chronicle-context.ts:42` | no |
| `call:volunteer_context` | 0 | `executeRaw` | none |  | no |
| `call:wait_job` | 0 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:704` | no |
| `cli:advisor` | 1 | none | none |  | no |
| `cli:anomalies` | 0 | `findAnomalies` | `findAnomalies` | `commands/anomalies.ts:90` | no |
| `cli:attribution` | 0 | `executeRaw` | `executeRaw` | `core/ops/attribution.ts:170` | no |
| `cli:backlinks` | 0 | `getBacklinks (option temporal)` | `getBacklinks (option temporal)` | `core/ops/links.ts:331` | no |
| `cli:brain-skillpack` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/compatibility.ts:10` | no |
| `cli:cancel-write-request` | 1 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:chronicle-backfill` | 0 | `executeRaw` | `executeRaw` | `core/chronicle/backfill.ts:139` | no |
| `cli:context-pack` | 0 | none | none |  | no |
| `cli:day` | 0 | `getTimelineForDate` | `getTimelineForDate` | `core/ops/chronicle.ts:78` | no |
| `cli:delete` | 0 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:delete-skill` | 1 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:delta` | 0 | none | none |  | no |
| `cli:entity` | 0 | `resolveAliases` | `resolveAliases` | `core/verbs/entity-card.ts:341` | no |
| `cli:entity-identity-link` | 0 | `executeRaw` | `executeRaw` | `core/entity-identity.ts:71` | no |
| `cli:entity-identity-list` | 0 | `executeRaw` | `executeRaw` | `core/entity-identity.ts:220` | no |
| `cli:entity-identity-unlink` | 0 | `executeRaw` | `executeRaw` | `core/entity-identity.ts:146` | no |
| `cli:extract-entities` | 0 | `resolveSlugWithAlias` | `resolveSlugWithAlias` | `core/enrichment-service.ts:226` | no |
| `cli:fetch` | 0 | `readPageSnapshot (option resolveAlias)` | `readPageSnapshot (option resolveAlias)` | `core/ops/pages.ts:302` | no |
| `cli:find` | 0 | `findPages` | `findPages` | `core/ops/find-pages.ts:78` | no |
| `cli:find-contradictions` | 0 | `loadContradictionsTrend` | `loadContradictionsTrend` | `core/ops/insights.ts:259` | no |
| `cli:find-trajectory` | 0 | `findTrajectory` | `findTrajectory` | `core/ops/insights.ts:354` | no |
| `cli:get` | 0 | `readPageSnapshot (option resolveAlias)` | `readPageSnapshot (option resolveAlias)` | `core/ops/pages.ts:155` | no |
| `cli:graph` | 0 | `traverseGraph (option temporal)` | `traverseGraph (option temporal)` | `core/ops/links.ts:634` | no |
| `cli:health` | 0 | `getHealth` | `getHealth` | `core/ops/admin.ts:96` | no |
| `cli:history` | 0 | none | none |  | yes |
| `cli:last-seen` | 0 | `getLastSeen` | `getLastSeen` | `core/ops/chronicle.ts:151` | no |
| `cli:leave-brain` | 1 | `transaction` | `transaction` | `core/shared-skills/membership.ts:273` | no |
| `cli:link` | 0 | `executeRaw` | `executeRaw` | `core/persistence/managed-mode.ts:53` | no |
| `cli:link-sources` | 0 | `listLinkSources` | `listLinkSources` | `core/ops/links.ts:487` | no |
| `cli:links` | 0 | `getLinks (option temporal)` | `getLinks (option temporal)` | `core/ops/links.ts:330` | no |
| `cli:list` | 0 | `listPages (option listColumnsOnly)` | `listPages (option listColumnsOnly)` | `core/ops/pages.ts:624` | no |
| `cli:memory-settings` | 0 | none | none |  | yes |
| `cli:on-this-day` | 0 | `getOnThisDay` | `getOnThisDay` | `core/ops/chronicle.ts:105` | no |
| `cli:ontology` | 0 | `getOntology` | `getOntology` | `core/ops/chronicle.ts:183` | no |
| `cli:ontology-add` | 0 | `executeRaw` | `executeRaw` | `core/belief/writers.ts:41` | no |
| `cli:ontology-contradictions` | 0 | `findOntologyConflicts` | `findOntologyConflicts` | `core/ops/chronicle.ts:298` | no |
| `cli:ontology-dimensions` | 0 | `discoverOntologyDimensions` | `discoverOntologyDimensions` | `core/ops/chronicle.ts:281` | no |
| `cli:orient` | 0 | `getSince` | `getSince` | `core/context/chronicle-context.ts:42` | no |
| `cli:orphans` | 0 | `executeRaw` | `executeRaw` | `commands/orphans.ts:68` | no |
| `cli:put` | 0 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:query` | 0 | `searchTitles` | `searchTitles` | `core/search/hybrid/arms.ts:100` | no |
| `cli:rate` | 2 | none | none |  | yes |
| `cli:remember` | 0 | none | none |  | no |
| `cli:restore` | 0 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:revert` | 1 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:salience` | 0 | `getRecentSalience` | `getRecentSalience` | `commands/salience.ts:87` | no |
| `cli:search` | 0 | `searchKeywordPages` | `searchKeywordPages` | `core/search/keyword-paging.ts:184` | no |
| `cli:since` | 0 | `getSince` | `getSince` | `core/ops/chronicle.ts:128` | no |
| `cli:skill` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/compatibility.ts:10` | no |
| `cli:skill-asset` | 1 | `transaction` | `transaction` | `core/shared-skills/catalog.ts:101` | no |
| `cli:skill-policy` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/policy.ts:234` | no |
| `cli:skills` | 0 | `executeRaw` | `executeRaw` | `core/shared-skills/compatibility.ts:10` | no |
| `cli:stats` | 0 | `getStats` | `getStats` | `core/ops/admin.ts:60` | no |
| `cli:storage-find` | 0 | `executeRaw` | `executeRaw` | `core/ops/storage-manifest.ts:37` | no |
| `cli:storage-get` | 1 | `executeRaw` | `executeRaw` | `core/ops/storage-manifest.ts:37` | no |
| `cli:storage-list` | 0 | `executeRaw` | `executeRaw` | `core/ops/storage-manifest.ts:37` | no |
| `cli:sync` | 0 | `executeRaw` | `executeRaw` | `core/source-resolver.ts:756` | no |
| `cli:sync-brain-skills` | 1 | `transaction` | `transaction` | `core/shared-skills/membership.ts:224` | no |
| `cli:tag` | 0 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:tags` | 0 | none | none |  | yes |
| `cli:takes-calibration` | 0 | `getCalibrationCurve` | `getCalibrationCurve` | `core/ops/takes.ts:240` | no |
| `cli:takes-list` | 0 | `listTakes` | `listTakes` | `core/ops/takes.ts:104` | no |
| `cli:takes-scorecard` | 0 | `getScorecard` | `getScorecard` | `core/ops/takes.ts:187` | no |
| `cli:takes-search` | 0 | `searchTakes` | `searchTakes` | `core/ops/takes.ts:139` | no |
| `cli:timeline` | 0 | `getTimeline (option eligibility)` | `getTimeline (option eligibility)` | `core/ops/timeline.ts:109` | no |
| `cli:timeline-add` | 0 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:unlink` | 0 | `executeRaw` | `executeRaw` | `core/persistence/managed-mode.ts:53` | no |
| `cli:untag` | 0 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:volunteer-context` | 0 | none | none |  | no |
| `cli:whoknows` | 0 | `searchTitles` | `searchTitles` | `core/search/hybrid/arms.ts:100` | no |
| `cli:write-conflicts` | 0 | `executeRaw` | `executeRaw` | `core/persistence/drift-conflicts.ts:298` | no |
| `cli:write-request` | 1 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cli:write-requests` | 1 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cmd:access check` | 2 | none | none |  | yes |
| `cmd:access member list` | 0 | `executeRaw` | `executeRaw` | `core/access/members.ts:129` | no |
| `cmd:advisor` | 1 | none | none |  | no |
| `cmd:agent logs` | 0 | `executeRaw` | `executeRaw` | `core/minions/transcript.ts:54` | no |
| `cmd:anomalies` | 0 | `findAnomalies` | `findAnomalies` | `commands/anomalies.ts:90` | no |
| `cmd:append` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cmd:apply-migrations --dry-run` | 0 | none | none |  | no |
| `cmd:apply-migrations --list` | 0 | none | none |  | no |
| `cmd:auth list` | 0 | `executeRaw` | `executeRaw` | `commands/auth.ts:179` | no |
| `cmd:autopilot --status` | 0 | none | none |  | yes |
| `cmd:backfill list` | 0 | none | none |  | yes |
| `cmd:backup status` | 1 | none | none |  | no |
| `cmd:beliefs changes` | 0 | `executeRaw` | `executeRaw` | `core/belief/coverage-report.ts:53` | no |
| `cmd:beliefs status` | 0 | `executeRaw` | `executeRaw` | `core/belief/coverage-report.ts:347` | no |
| `cmd:bootstrap status` | 0 | none | none |  | no |
| `cmd:bundled-skill` | 0 | none | none |  | yes |
| `cmd:cache prune` | 0 | none | none |  | yes |
| `cmd:cache stats` | 0 | none | none |  | yes |
| `cmd:calibration` | 0 | `executeRaw` | `executeRaw` | `commands/calibration.ts:72` | no |
| `cmd:capture` | 0 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cmd:check-backlinks` | 0 | none | none |  | no |
| `cmd:check-resolvable` | 0 | none | none |  | yes |
| `cmd:code-callers` | 0 | `executeRaw` | `executeRaw` | `core/sources-ops.ts:904` | no |
| `cmd:code-def` | 0 | `executeRaw` | `executeRaw` | `core/sources-ops.ts:904` | no |
| `cmd:compile-context` | 0 | none | none |  | no |
| `cmd:config get` | 0 | none | none |  | no |
| `cmd:config set` | 0 | none | none |  | yes |
| `cmd:config show` | 0 | none | none |  | no |
| `cmd:conversation-parser scan` | 0 | none | none |  | yes |
| `cmd:core add` | 0 | none | none |  | no |
| `cmd:core list` | 0 | `executeRaw` | `executeRaw` | `core/core-memory.ts:267` | no |
| `cmd:core status` | 0 | `executeRaw` | `executeRaw` | `core/core-memory.ts:267` | no |
| `cmd:creds list` | 0 | none | none |  | yes |
| `cmd:db-repair` | 1 | none | none |  | no |
| `cmd:decide status` | 0 | `executeRaw` | `executeRaw` | `core/ai/decide/store.ts:466` | no |
| `cmd:delete` | 0 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cmd:diag` | 0 | `executeRaw` | `executeRaw` | `core/search/alias-fanout.ts:109` | no |
| `cmd:doctor --fast` | 0 | none | none |  | no |
| `cmd:doctor --remediation-plan` | 0 | `getHealth` | `getHealth` | `core/remediation/plan.ts:50` | no |
| `cmd:doctor --tier quick` | 0 | none | none |  | no |
| `cmd:dream --dry-run` | 0 | `executeRaw` | `acquireCycleLock` | `core/db-lock.ts:256` | no |
| `cmd:edge-proposals list` | 0 | `executeRaw` | `executeRaw` | `commands/edge-proposals.ts:52` | no |
| `cmd:edges-backfill` | 0 | none | none |  | no |
| `cmd:embed --stale --dry-run` | 0 | none | none |  | no |
| `cmd:engine status` | 0 | none | none |  | no |
| `cmd:enrich --dry-run` | 0 | `executeRaw` | `executeRaw` | `core/sources-ops.ts:904` | no |
| `cmd:errors` | 0 | `unknown` | `unknown` |  | yes |
| `cmd:eval trajectory` | 0 | `findTrajectory` | `findTrajectory` | `commands/eval-trajectory.ts:135` | no |
| `cmd:export` | 1 | none | none |  | no |
| `cmd:extract links --by-mention` | 0 | `executeRaw` | `executeRaw` | `core/by-mention.ts:517` | no |
| `cmd:extract timeline --source db` | 0 | `listAllPageRefs` | `listAllPageRefs` | `commands/extract-timeline-db.ts:102` | no |
| `cmd:extract-conversation-facts --dry-run` | 0 | `executeRaw` | `executeRaw` | `core/sources-ops.ts:904` | no |
| `cmd:facts relink --dry-run` | 0 | `executeRaw` | `executeRaw` | `core/facts/relink.ts:118` | no |
| `cmd:facts retry-dead` | 0 | `executeRaw` | `executeRaw` | `core/facts/dead-absorb-retry.ts:111` | no |
| `cmd:features` | 0 | `getStats` | `getStats` | `commands/features.ts:119` | no |
| `cmd:feedback status` | 0 | `executeRaw` | `executeRaw` | `core/feedback/store.ts:392` | no |
| `cmd:files list` | 0 | `executeRaw` | `executeRaw` | `commands/files.ts:158` | no |
| `cmd:forget --purge --status` | 1 | `executeRaw` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |
| `cmd:founder scorecard` | 0 | `findTrajectory` | `findTrajectory` | `commands/founder-scorecard.ts:305` | no |
| `cmd:frontmatter audit` | 0 | `executeRaw` | `executeRaw` | `core/brain-writer.ts:1025` | no |
| `cmd:graph-query` | 0 | `executeRaw` | none |  | no |
| `cmd:guests init (preview)` | 0 | `executeRaw` | `executeRaw` | `core/guests/sources.ts:56` | no |
| `cmd:integrations stats` | 0 | none | none |  | yes |
| `cmd:integrity check` | 0 | `listAllPageRefs` | `listAllPageRefs` | `commands/integrity.ts:405` | no |
| `cmd:jobs list` | 0 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:751` | no |
| `cmd:jobs stats` | 0 | `executeRaw` | `executeRaw` | `core/minions/queue.ts:1321` | no |
| `cmd:lint` | 0 | none | none |  | yes |
| `cmd:loops list` | 0 | `executeRaw` | `executeRaw` | `core/loops/loops-store.ts:262` | no |
| `cmd:maintain --dry-run` | 0 | `getHealth` | `getHealth` | `commands/maintain.ts:277` | no |
| `cmd:maintain --status` | 0 | none | none |  | no |
| `cmd:mcp expose --status` | 2 | none | none |  | yes |
| `cmd:memory-proposals list` | 0 | `executeRaw` | `executeRaw` | `core/persistence/memory-proposals.ts:193` | no |
| `cmd:migrate --status` | 0 | none | none |  | no |
| `cmd:models` | 0 | none | none |  | yes |
| `cmd:mounts list` | 0 | none | none |  | yes |
| `cmd:notices list` | 0 | none | none |  | yes |
| `cmd:onboard --check` | 0 | `getHealth` | `getHealth` | `core/remediation/plan.ts:50` | no |
| `cmd:orphans` | 0 | `executeRaw` | `executeRaw` | `commands/orphans.ts:68` | no |
| `cmd:pages ghosts` | 1 | `executeRaw` | `executeRaw` | `core/persistence/ownership.ts:86` | no |
| `cmd:pages purges list` | 0 | `executeRaw` | `executeRaw` | `core/persistence/page-purge.ts:517` | no |
| `cmd:post-upgrade` | 0 | none | none |  | no |
| `cmd:pricing list` | 0 | none | none |  | yes |
| `cmd:projections drain --dry-run` | 0 | `executeRaw` | `executeRaw` | `core/page-state/projections.ts:726` | no |
| `cmd:protocol` | 0 | none | none |  | yes |
| `cmd:providers list` | 0 | none | none |  | yes |
| `cmd:quarantine list` | 0 | `executeRaw` | `executeRaw` | `core/write-gate-store.ts:198` | no |
| `cmd:questions list` | 0 | `executeRaw` | `executeRaw` | `core/questions/store.ts:115` | no |
| `cmd:reconcile-links --dry-run` | 0 | `executeRaw` | `executeRaw` | `commands/reconcile-links.ts:120` | no |
| `cmd:reindex --aliases --dry-run` | 0 | `listAllPageRefs` | `listAllPageRefs` | `commands/reindex-aliases.ts:57` | no |
| `cmd:reindex --markdown --dry-run` | 0 | `executeRaw` | `executeRaw` | `commands/reindex.ts:283` | no |
| `cmd:reindex --oversized --dry-run` | 0 | `executeRaw` | `executeRaw` | `core/oversized-backfill.ts:95` | no |
| `cmd:reindex-code --dry-run` | 1 | none | none |  | yes |
| `cmd:reindex-frontmatter --dry-run` | 0 | `executeRaw` | `executeRaw` | `core/backfill-effective-date.ts:191` | no |
| `cmd:reindex-search-vector --dry-run` | 0 | `executeRaw` | `executeRaw` | `commands/reindex-search-vector.ts:101` | no |
| `cmd:repair (all preview)` | 0 | `executeRaw` | `executeRaw` | `core/repair/core.ts:291` | no |
| `cmd:repair frontmatter` | 0 | `executeRaw` | `executeRaw` | `core/repair/core.ts:291` | no |
| `cmd:repair-jsonb --dry-run` | 0 | none | none |  | no |
| `cmd:report` | 1 | none | none |  | yes |
| `cmd:repos list` | 0 | `executeRaw` | `executeRaw` | `commands/sources.ts:140` | no |
| `cmd:resolvers list` | 0 | none | none |  | yes |
| `cmd:routing-eval` | 0 | none | none |  | no |
| `cmd:salience` | 0 | `getRecentSalience` | `getRecentSalience` | `commands/salience.ts:87` | no |
| `cmd:schema active` | 0 | none | none |  | yes |
| `cmd:schema stats` | 0 | `executeRaw` | `executeRaw` | `core/schema-pack/stats.ts:178` | no |
| `cmd:skillpack list` | 0 | none | none |  | yes |
| `cmd:skillpack-check` | 1 | none | none |  | yes |
| `cmd:sources add` | 0 | `executeRaw` | `executeRaw` | `core/persistence/managed-mode.ts:53` | no |
| `cmd:sources status` | 0 | `executeRaw` | `executeRaw` | `core/source-health.ts:384` | no |
| `cmd:status` | 0 | none | none |  | no |
| `cmd:storage status` | 0 | `executeRaw` | `executeRaw` | `core/restore-target.ts:45` | no |
| `cmd:sweep --once` | 0 | none | none |  | no |
| `cmd:sync --dry-run` | 0 | `executeRaw` | `executeRaw` | `core/source-resolver.ts:756` | no |
| `cmd:takes list` | 0 | `listTakes` | `listTakes` | `commands/takes.ts:131` | no |
| `cmd:takes page` | 0 | `listTakes` | `listTakes` | `commands/takes.ts:131` | no |
| `cmd:transcripts archive status` | 0 | `executeRaw` | `executeRaw` | `core/access/members.ts:129` | no |
| `cmd:transcripts status` | 0 | `executeRaw` | `executeRaw` | `core/transcripts/discover.ts:146` | no |
| `cmd:trust review` | 0 | `executeRaw` | `executeRaw` | `core/trust/review.ts:268` | no |
| `cmd:waiting` | 0 | `executeRaw` | `executeRaw` | `core/loops/loops-store.ts:262` | no |
| `cmd:wakeshift status` | 0 | none | none |  | no |
| `cmd:whoknows` | 0 | `searchTitles` | `searchTitles` | `core/search/hybrid/arms.ts:100` | no |
| `cmd:write-request list` | 1 | `readPersistenceBrainId` | `readPersistenceBrainId` | `core/persistence/identity.ts:207` | no |

## Commands equal on both engines

Equal as built (30): `cli:history`, `cli:memory-settings`, `cli:rate`, `cli:tags`, `cmd:access check`, `cmd:autopilot --status`, `cmd:backfill list`, `cmd:bundled-skill`, `cmd:cache prune`, `cmd:cache stats`, `cmd:check-resolvable`, `cmd:config set`, `cmd:conversation-parser scan`, `cmd:creds list`, `cmd:errors`, `cmd:integrations stats`, `cmd:lint`, `cmd:mcp expose --status`, `cmd:models`, `cmd:mounts list`, `cmd:notices list`, `cmd:pricing list`, `cmd:protocol`, `cmd:providers list`, `cmd:reindex-code --dry-run`, `cmd:report`, `cmd:resolvers list`, `cmd:schema active`, `cmd:skillpack list`, `cmd:skillpack-check`

Equal with the resolver stubbed (68): `call:cache_stats`, `call:connectors_status`, `call:extraction_review`, `call:file_register`, `call:file_verify`, `call:get_active_schema_pack`, `call:get_memory_settings`, `call:get_recent_transcripts`, `call:get_tags`, `call:get_versions`, `call:import_skill_proposal`, `call:join_brain`, `call:list_schema_packs`, `call:list_watches`, `call:loops_mute`, `call:loops_unmute`, `call:memory_conversation_mode`, `call:memory_propose`, `call:memory_write`, `call:mute_notice`, `call:quarantine_list`, `call:questions_status`, `call:questions_unpin`, `call:rate_answer`, `call:reload_schema_pack`, `call:request_tools`, `call:schema_apply_mutations`, `call:schema_explain_type`, `call:schema_graph`, `call:schema_lint`, `call:search_modes`, `call:search_stats`, `call:search_tune`, `call:set_memory_writeback`, `call:set_skill_policy`, `call:storage_register`, `call:unwatch`, `call:upload_page_part`, `cli:history`, `cli:memory-settings`, `cli:rate`, `cli:tags`, `cmd:access check`, `cmd:autopilot --status`, `cmd:backfill list`, `cmd:bundled-skill`, `cmd:cache prune`, `cmd:cache stats`, `cmd:check-resolvable`, `cmd:config set`, `cmd:conversation-parser scan`, `cmd:creds list`, `cmd:errors`, `cmd:integrations stats`, `cmd:lint`, `cmd:mcp expose --status`, `cmd:models`, `cmd:mounts list`, `cmd:notices list`, `cmd:pricing list`, `cmd:protocol`, `cmd:providers list`, `cmd:reindex-code --dry-run`, `cmd:report`, `cmd:resolvers list`, `cmd:schema active`, `cmd:skillpack list`, `cmd:skillpack-check`

In the first pass every equal command also met the caught `behavior-change-notice.ts:164` refusal, so none of these
is clean parity yet. With the resolver stubbed, 38 more operations become equal, which shows how much the resolver
alone blocks.

## Skipped commands

| Command | Reason |
|---|---|
| `call:synthesize` | LLM call (chat model key) |
| `call:search_by_image` | image embedding provider key |
| `call:submit_agent` | agent job runs an LLM |
| `call:get_agent_job` | needs a submitted agent job (LLM) |
| `call:watch_job` | Wakeshift network service |
| `call:watch_write_request` | Wakeshift network service |
| `call:watch_cron` | Wakeshift network service |
| `call:accept_wakeshift_terms` | Wakeshift network service |
| `call:think` | LLM call (chat model key) |
| `call:connector_sync` | network fetch from a chat provider |
| `call:extract_facts` | LLM fact extraction (chat model key) |
| `call:migrate_embeddings` | embedding provider key (paid re-embed) |
| `call:run_skillopt` | LLM optimisation loop |
| `call:questions_refresh` | LLM answer refresh |
| `cmd:brainstorm --dry-run` | LLM call (chat model key) |
| `cmd:lsd` | LLM call (chat model key) |
| `cmd:think` | LLM call (chat model key) |
| `cmd:agent run` | LLM agent run |
| `cmd:connectors sync` | network fetch from a chat provider |
| `cmd:google connect` | Google OAuth network flow |
| `cmd:remote ping` | remote MCP host (network) |
| `cmd:connect` | remote MCP host (network) |
| `cmd:providers test` | live provider probe (network, key) |
| `cmd:models doctor` | live model probe (network, key) |
| `cmd:self-upgrade / upgrade / check-update` | network release check |
| `cmd:embed / embeddings / reinit-pglite / migrate embeddings` | embedding provider key (paid) |
| `cmd:book-mirror / skillopt / notability-eval` | LLM calls |
| `cmd:serve / mcp expose / autopilot (daemon)` | long-running server or daemon, not a one-shot command |
| `cmd:claw-test` | spawns a fresh install in a temp dir (not an engine path) |

## Per-site rows

One row per site, grouped as in "New members needed, grouped". "Calls" counts calls in all traced runs; "Cmds" counts
the commands that reach the site. Lines are `955b18ef59` lines under `src/`. "Class" is `existing` (switch to the
named member), `new` (the named member is a proposal) or `inside` (excluded).

### 1. Persistence journal, effects, sync holds, page-state projections (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/diag.ts:83` | `readHolds` | 1 | 1 | op_checkpoints, sources | new | `countSyncHoldsBySource` | sync-hold counts by source |
| `commands/doctor/checks/coordination-lock.ts:21` | `checkCoordinationLockLocation` | 4 | 3 | persistence_host_bindings, sources | new | `listCoordinationRoots` | Union of sources and host bindings |
| `commands/doctor/checks/foreign-writers.ts:135` | `repositories` | 2 | 1 | persistence_host_bindings, persistence_source_bindings | new | `listRepositoryHostBindings` | Host bindings joined to source bindings |
| `commands/doctor/checks/git-holds.ts:118` | `readNoncanonicalPrivate` | 4 | 3 | op_checkpoints, sources | new | `listNoncanonicalCheckpoints` | Checkpoint join to sources |
| `commands/doctor/checks/git-holds.ts:144` | `contentBlockedSources` | 2 | 1 | op_checkpoints, persistence_requests | new | `listContentBlockedSources` | Checkpoint errors joined to requests |
| `commands/doctor/checks/local-edit-adoptions.ts:22` | `runLocalEditAdoptions` | 2 | 1 | persistence_requests | new | `countLocalEditAdoptions` | Local-edit adoption counts by source |
| `commands/doctor/checks/maintenance-drift.ts:38` | `maintenanceWriteDriftCheck` | 4 | 3 | persistence_requests | new | `readMaxPersistenceSequence` | Max request sequence; no member |
| `commands/doctor/checks/maintenance-drift.ts:50` | `maintenanceWriteDriftCheck` | 4 | 3 | persistence_requests | new | `listDriftedSlugsSince` | Slugs written since sequence |
| `commands/doctor/checks/managed-guard.ts:101` | `checkPublicationRefusals` | 2 | 1 |  | new | `countPublicationRefusals` | Refusal counts by origin |
| `commands/doctor/checks/orphan-bindings.ts:48` | `checkForeignOwnershipMarkers` | 4 | 3 | persistence_worktrees | new | `listPersistenceWorktreeIds` | Worktree ids; no member |
| `commands/doctor/checks/orphan-bindings.ts:49` | `checkForeignOwnershipMarkers` | 4 | 3 | persistence_host_bindings, sources | new | `listCoordinationRoots` | Union of sources and host bindings |
| `commands/doctor/checks/owner-host-stale.ts:23` | `ownerHostStaleCheck` | 2 | 1 | persistence_requests, persistence_source_bindings | new | `listOwnerHostStaleWrites` | Open writes per worktree; no member |
| `commands/doctor/checks/parked-effects.ts:52` | `checkParkedEffects` | 4 | 3 | persistence_effects | new | `countParkedEffects` | Parked effect count; no member |
| `commands/doctor/checks/parked-effects.ts:53` | `checkParkedEffects` | 4 | 3 | persistence_source_bindings | new | `listParkedEffectRequests` | Parked effects joined to bindings |
| `commands/doctor/checks/persistence-capacity.ts:32` | `checkPersistenceCapacity` | 6 | 5 | persistence_counters | new | `readPersistenceCounters` | Persistence counter read; no member |
| `commands/doctor/checks/persistence-compaction.ts:24` | `checkPersistenceCompaction` | 6 | 5 | now, persistence_consumers | new | `countLivePersistenceConsumers` | Live consumers via now(); no member |
| `commands/doctor/checks/persistence-compaction.ts:60` | `checkPersistenceCounterDrift` | 4 | 3 | persistence_requests, persistence_topology_changes | new | `computePersistenceCounterDrift` | Unions request and topology counters |
| `commands/doctor/checks/persistence-requests.ts:77` | `requestGrowthCheck` | 4 | 3 | persistence_requests | new | `countPersistenceRequests` | Request row count; no member |
| `commands/doctor/checks/persistence-requests.ts:78` | `requestGrowthCheck` | 4 | 3 | persistence_counters | new | `readPersistenceCounterLifetime` | Counters by key; no member |
| `commands/doctor/checks/persistence-requests.ts:150` | `writeStallCheck` | 4 | 3 |  | new | `listStalledWriteRequests` | Stalled writes; no member |
| `commands/doctor/checks/purge-mirror.ts:26` | `checkPurgeMirror` | 2 | 1 | fact_purges, page_purges | new | `listPurgeMirrorRequests` | Purge mirror request ids |
| `commands/doctor/checks/stale-embedding-effects.ts:20` | `staleEmbeddingEffectsCheck` | 4 | 3 | persistence_effects, persistence_requests | new | `countStaleEmbeddingEffects` | Effects joined to requests |
| `commands/doctor/checks/stale-embedding-effects.ts:23` | `staleEmbeddingEffectsCheck` | 4 | 3 | persistence_effects, persistence_requests | new | `listStaleEmbeddingEffects` | Stale embedding effect rows |
| `commands/doctor/checks/unbound-source.ts:16` | `checkUnboundSource` | 4 | 3 | persistence_source_bindings, sources | new | `listUnboundSourcePages` | Page counts by binding state |
| `commands/doctor/checks/writer-version.ts:16` | `writerVersionCheck` | 5 | 4 | persistence_brain | new | `readWriterVersionCutoff` | persistence_brain cutoff column; no member |
| `commands/doctor/last-known.ts:65` | `readLastKnown` | 1 | 1 | op_checkpoints | new | `readLastKnownCheckpoint` | op_checkpoints fingerprint and entry |
| `commands/status.ts:294` | `buildLocks` | 1 | 1 | gbrain_cycle_locks | new | `listActiveCycleLocks` | unexpired cycle lock rows; readCycleLocks cannot filter that |
| `core/eligibility/scan.ts:59` | `readCursor` | 2 | 1 | op_checkpoints | new | `readOpCheckpointKeys` | op_checkpoints keys by fingerprint |
| `core/fence-repair/census-store.ts:92` | `readScanRecord` | 11 | 5 | op_checkpoints | new | `readFenceScanRecord` | op_checkpoints scan record by fingerprint |
| `core/fence-repair/census-store.ts:98` | `writeScanRecord` | 19 | 5 | SET, op_checkpoints | new | `writeFenceScanRecord` | op_checkpoints upsert write |
| `core/fence-repair/census-store.ts:117` | `clearCandidateParts` | 5 | 5 | op_checkpoints | new | `clearFenceCandidateParts` | op_checkpoints delete of candidate parts |
| `core/fence-repair/census-store.ts:119` | `clearCandidateParts` | 5 | 5 | op_checkpoints | new | `updateFenceCandidateParts` | op_checkpoints array update of candidate parts |
| `core/fence-repair/census-store.ts:125` | `readCandidateRecords` | 14 | 5 | op_checkpoints, sources | new | `readFenceCandidateRecords` | op_checkpoints records joined to sources |
| `core/fence-repair/census-store.ts:171` | `readTrend` | 4 | 3 | op_checkpoints | new | `readFenceRepairTrend` | op_checkpoints trend records by source |
| `core/fence-repair/uncommitted.ts:67` | `readUncommittedFenceRepairs` | 5 | 4 | op_checkpoints | new | `readUncommittedFenceRepairs` | op_checkpoints uncommitted repair records |
| `core/notifier/status.ts:110` | `freshnessReported` | 5 | 5 | sync_notifier_sources | new | `freshnessReported` | sync_notifier_sources observed check |
| `core/op-checkpoint.ts:139` | `loadOpCheckpoint` | 3 | 3 | op_checkpoint_paths, op_checkpoints | new | `loadOpCheckpointKeys` | op checkpoint paths and keys union |
| `core/page-state/credential-reseal.ts:40` | `credentialProjectionPending` | 5 | 3 |  | new | `credentialProjectionPending` | pending credential projection counts |
| `core/page-state/credential-reseal.ts:84` | `readCredentialResealHolds` | 6 | 3 | op_checkpoints, pages | new | `readCredentialResealHolds` | reseal holds from checkpoints |
| `core/page-state/credential-reseal.ts:94` | `recordCredentialResealHolds` | 1 | 1 | op_checkpoints, pages | new | `recordCredentialResealHolds` | DELETE stale reseal hold checkpoints |
| `core/page-state/credential-reseal.ts:116` | `resealCredentialProjections` | 1 | 1 | p.knowled, pages, sources | new | `listCredentialResealPages` | pages needing credential reseal |
| `core/page-state/projections.ts:44` | `sealImportedPage` | 8 | 8 | pages | new | `sealImportedPage` | chunker seal with knowledge revision guard |
| `core/page-state/projections.ts:132` | `indexingContext` | 4 | 2 | pages | new | `readPageIndexingContext` | chunker version and corpus generation |
| `core/page-state/projections.ts:134` | `indexingContext` | 4 | 2 | pages | new | `readPageKind` | page kind for indexing |
| `core/page-state/projections.ts:330` | `<anonymous>` | 2 | 2 | sources | new | `readSourceArchived` | source archived flag |
| `core/page-state/projections.ts:359` | `<anonymous>` | 2 | 2 | pages | existing | `setChunkerVersion` | same stamp; no revision guard in site |
| `core/page-state/projections.ts:362` | `<anonymous>` | 2 | 2 | page_projection_jobs | new | `clearProjectionJob` | DELETE job by incarnation, slug, revision |
| `core/page-state/projections.ts:570` | `noteProjectionRebuilds` | 2 | 2 | pg_class | new | `noteProjectionRebuilds` | Postgres catalog probe; Rust no-op candidate |
| `core/page-state/projections.ts:668` | `selectWindowJobs` | 41 | 32 | page_projection_jobs | new | `selectProjectionJobWindow` | projection job window scan |
| `core/page-state/projections.ts:726` | `projectionBacklog` | 4 | 3 | content_chunk | new | `projectionBacklog` | text chunk backlog counts |
| `core/page-state/projections.ts:759` | `previewProjectionDrain` | 1 | 1 | page_projection_jobs, pages, sources | new | `previewProjectionDrain` | preview of job drain rows |
| `core/page-state/projections.ts:803` | `rebuildPendingPageProjections` | 2 | 2 | page_projection_jobs | new | `listPendingProjectionRebuilds` | pending projection jobs for rebuild |
| `core/page-state/projections.ts:824` | `<anonymous>` | 2 | 2 | page_projection_jobs | new | `projectionJobReason` | reason of one projection job |
| `core/page-state/projections.ts:915` | `<anonymous>` | 2 | 2 | page_projection_jobs, pages, sources | new | `hasLiveProjectionJob` | job exists for live source incarnation |
| `core/page-state/revision-backfill-schema.ts:55` | `readRevisionBackfillStatus` | 2 | 1 | pages, pg_attribute | new | `revisionColumnNotNull` | Postgres catalog probe; Rust no-op candidate |
| `core/page-state/tags.ts:9` | `<anonymous>` | 8 | 4 | pages | inside | `addTag` | page id lookup inside mutatePageTag; addTag impl |
| `core/page-state/tags.ts:13` | `<anonymous>` | 8 | 4 | SET, tags | inside | `addTag` | tag insert inside mutatePageTag; addTag impl |
| `core/page-state/tags.ts:19` | `<anonymous>` | 2 | 2 | pages, tags | inside | `removeTag` | tag delete inside mutatePageTag; removeTag impl |
| `core/page-state/transactions.ts:66` | `transactionMemo` | 92 | 32 | persistence_local_writers | new | `getLocalWriter` | FOR SHARE writer row in page tx memo |
| `core/persistence/applied-watermark.ts:88` | `readWriteWatermark` | 4 | 4 | persistence_requests, sources | new | `readWriteWatermark` | source and pending request watermark |
| `core/persistence/applied-watermark.ts:92` | `readWriteWatermark` | 4 | 4 | persistence_requests | new | `readMaxRequestSequence` | max request sequence |
| `core/persistence/applied-watermark.ts:104` | `readCheckoutRoot` | 4 | 4 | persistence_host_bindings, persistence_source_bindings, sources | new | `readCheckoutRoot` | checkout root from host binding |
| `core/persistence/applied-watermark.ts:132` | `readAppliedWatermark` | 4 | 4 | content_chunks, pages | new | `readAppliedWatermark` | content chunk and page watermark |
| `core/persistence/atom-maintenance.ts:903` | `listHeldManagedAtoms` | 2 | 1 |  | new | `listHeldManagedAtoms` | held atom requests from checkpoints |
| `core/persistence/authority.ts:204` | `authorizeWrite` | 33 | 33 | persistence_local_writers | new | `getLocalWriter` | local writer lease row; no lock |
| `core/persistence/capacity-forecast.ts:118` | `principalDays` | 8 | 8 | persistence_requests, walk | new | `principalCapacityDays` | recursive day walk of request counts |
| `core/persistence/capacity-forecast.ts:148` | `readCapacityForecast` | 24 | 23 | persistence_counters | new | `readCapacityCounters` | capacity counters read |
| `core/persistence/capacity-forecast.ts:151` | `readCapacityForecast` | 24 | 23 |  | new | `principalCapacityDailyCounts` | per-principal daily request counts |
| `core/persistence/capacity-forecast.ts:157` | `readCapacityForecast` | 24 | 23 | now, pers, persistence_requests | new | `readCapacityEarliest` | earliest request age for forecast |
| `core/persistence/capacity-forecast.ts:163` | `readCapacityForecast` | 6 | 5 | persistence_requests | new | `readCapacityRecentRequests` | recent live request rows for forecast |
| `core/persistence/capacity-forecast.ts:171` | `readCapacityForecast` | 6 | 5 |  | new | `persistenceRequestBytes` | Postgres catalog probe; Rust no-op candidate; table size |
| `core/persistence/checkpoint-validation.ts:160` | `readRequestIndexStates` | 6 | 4 |  | new | `readRequestIndexStates` | Postgres catalog probe; Rust no-op candidate |
| `core/persistence/compaction-pass.ts:77` | `housekeepReceipts` | 32 | 32 | config, persistence_counters | new | `readReceiptCompactionStatus` | retention config and counters read |
| `core/persistence/connector-account-mismatch.ts:33` | `connectorAccountMismatches` | 2 | 1 | sources | new | `listLiveSourcesForAccount` | live sources with local path and config |
| `core/persistence/connector-status.ts:73` | `readConnectorSourceStatuses` | 2 | 2 | sources | new | `listConnectorSources` | unarchived connector sources by kind |
| `core/persistence/consumer-diagnostics.ts:111` | `hostIdentityMismatches` | 2 | 1 | persistenc, persistence_source_bindings, persistence_worktrees | new | `hostIdentityMismatches` | host identity mismatch rows |
| `core/persistence/consumer.ts:960` | `phase` | 36 | 12 | persistence_requests, persistence_worktrees | new | `listHostOwnedRequests` | per-host request scan; consumer, not submit path |
| `core/persistence/derived-origin-hold.ts:94` | `clearOwedPurges` | 2 | 2 | op_checkpoints | new | `clearOwedPurges` | DELETE owed purge checkpoints |
| `core/persistence/derived-origin-hold.ts:111` | `readDerivedOriginParks` | 3 | 2 | op_checkpoints, pages | new | `readDerivedOriginParks` | parks for pages still present |
| `core/persistence/detached-pages.ts:136` | `scanMissingRecordedFiles` | 2 | 1 | sources | new | `readRecordedSourceRoot` | source root and strategy for recorded files |
| `core/persistence/drift-conflicts.ts:298` | `auditDriftConflicts` | 2 | 2 | persistence_requests, sources | new | `auditDriftConflicts` | source incarnation and max sequence |
| `core/persistence/drift-conflicts.ts:326` | `auditDriftConflicts` | 2 | 2 | persistence_requests | new | `countDriftReceipts` | drift receipt slug and count totals |
| `core/persistence/drift-conflicts.ts:331` | `auditDriftConflicts` | 2 | 2 |  | new | `listDriftReceiptSlugs` | per-slug drift receipt counts |
| `core/persistence/effect-catchup.ts:29` | `readStalledCatchups` | 4 | 3 |  | new | `readStalledCatchups` | busy effect counts per source |
| `core/persistence/effect-journal.ts:157` | `<anonymous>` | 53 | 32 | persistence_effects, persistence_worktrees | new | `claimPersistenceEffect` | effect claim select; consumer loop |
| `core/persistence/effect-journal.ts:170` | `<anonymous>` | 12 | 12 | persistence_effects | new | `claimPersistenceEffect` | effect claim UPDATE with lease |
| `core/persistence/effect-journal.ts:202` | `mirrorGates` | 12 | 12 | persistence_effects | new | `listWithdrawalMirrorEffects` | withdrawal mirror effect states |
| `core/persistence/effect-journal.ts:231` | `hasRearmableTargets` | 12 | 12 | persistence_effects | new | `hasRearmableTargets` | rearmable git or embedding effect probe |
| `core/persistence/effect-journal.ts:314` | `releaseAbandonedClaims` | 12 | 12 | persistence_effects | new | `releaseAbandonedEffectClaims` | clears abandoned effect claims |
| `core/persistence/effect-journal.ts:317` | `releaseAbandonedClaims` | 12 | 12 | persistence_requests | new | `releaseAbandonedWriteClaims` | clears abandoned request claims |
| `core/persistence/effect-journal.ts:373` | `completeEffect` | 12 | 12 | persistence_effects | new | `completeEffect` | effect terminal-state UPDATE |
| `core/persistence/effect-recovery-scan.ts:13` | `selectEffectRecoveries` | 41 | 32 | persistence_effects, persistence_worktrees | new | `selectEffectRecoveries` | recovery scan joined to worktrees |
| `core/persistence/effect-recovery.ts:37` | `guardEffectSource` | 12 | 12 | persistence_brain | new | `readPersistenceBrainLock` | persistence_brain row FOR SHARE |
| `core/persistence/effect-recovery.ts:44` | `guardEffectSource` | 12 | 12 | sources | new | `readSourceGuard` | source incarnation and archived, FOR SHARE |
| `core/persistence/forget-prepare.ts:51` | `refuseForgetReachingOtherCopies` | 4 | 2 | facts, pages | new | `refuseForgetReachingOtherCopies` | write pipeline; other-copies refusal check |
| `core/persistence/forget-prepare.ts:108` | `readForgetTarget` | 6 | 2 | facts | new | `readForgetTarget` | write pipeline; fact row lookup for forget |
| `core/persistence/forget-prepare.ts:205` | `<anonymous>` | 2 | 2 | facts | new | `appendFactContext` | write pipeline; forget note on fact context |
| `core/persistence/git-push-holds.ts:37` | `readGitPushHolds` | 4 | 3 |  | new | `readGitPushHolds` | git push hold rows |
| `core/persistence/graduation-custody.ts:366` | `assertGraduationAdmission` | 32 | 32 | persistence_graduation | new | `getGraduationRun` | graduation run row with session settings |
| `core/persistence/held-reads.ts:81` | `<anonymous>` | 2 | 2 | op_checkpoints, pages, sources | new | `heldReadRecords` | held record and page revision read |
| `core/persistence/held-reads.ts:102` | `<anonymous>` | 9 | 8 |  | new | `readHeldReads` | held read counts from checkpoints |
| `core/persistence/housekeeping-turn.ts:34` | `claimHousekeepingTurn` | 9 | 9 | op_checkpoints, persistence_consumers | new | `claimHousekeepingTurn` | checkpoint claim INSERT |
| `core/persistence/housekeeping-turn.ts:47` | `completeHousekeepingTurn` | 9 | 9 | op_checkpoints | new | `completeHousekeepingTurn` | checkpoint UPDATE to done |
| `core/persistence/intent-redaction.ts:209` | `findRequestsCarrying` | 1 | 1 | persistence_requests | new | `findRequestsCarrying` | requests carrying a redacted claim |
| `core/persistence/journal.ts:254` | `getWriteRequest` | 67 | 36 | persistence_requests | new | `getWriteRequestByPrincipal` | request row by principal and request id |
| `core/persistence/journal.ts:262` | `assertPageRequestIdentity` | 32 | 32 | persistence_topology_changes | new | `getTopologyChangeByRequest` | topology change lookup for request identity |
| `core/persistence/journal.ts:267` | `getWriteRequestById` | 2 | 2 | persistence_requests | new | `getWriteRequestById` | request row by id |
| `core/persistence/journal.ts:788` | `hasClaimableWrite` | 41 | 32 | persistence_requests, persistence_worktrees | new | `hasClaimableWrite` | claimable-write probe; consumer loop |
| `core/persistence/journal.ts:868` | `<anonymous>` | 32 | 32 | persistence_requests | new | `claimNextWrite` | claim UPDATE; consumer loop, not submit path |
| `core/persistence/journal.ts:921` | `renewWriteClaim` | 30 | 30 |  | new | `(executeRawDirect)` | runs through executeRawDirect, also raw_sql |
| `core/persistence/journal.ts:1176` | `vacuumPersistenceQueues` | 32 | 32 | pg_class | new | `listRelationNames` | Postgres catalog probe; Rust no-op candidate |
| `core/persistence/journal.ts:1184` | `vacuumPersistenceQueues` | 32 | 32 | pg_class | new | `relationRowEstimate` | Postgres catalog probe; Rust no-op candidate |
| `core/persistence/journal.ts:1249` | `compactWriteReceiptsDetailed` | 32 | 32 | persistence_effects, persistence_requests | new | `listCompactibleReceipts` | terminal requests eligible for compaction |
| `core/persistence/limits.ts:66` | `readJournalLimits` | 93 | 50 | config, pages_segmented_body_bytes_idx, pg_index | new | `readJournalLimits` | limits keys plus pg_index probe and body max |
| `core/persistence/managed-sync-orphans.ts:135` | `classifyManagedSyncOrphans` | 3 | 2 |  | new | `listManagedSyncOrphans` | orphan cursors from op_checkpoints |
| `core/persistence/managed-sync-orphans.ts:170` | `classifyManagedSyncOrphans` | 3 | 2 | op_chec | new | `listManagedSyncOrphans` | orphan checkpoints joined to sources |
| `core/persistence/managed-sync-orphans.ts:182` | `classifyManagedSyncOrphans` | 3 | 2 | persistence_requests | new | `listManagedSyncOrphans` | orphan requests joined to sources |
| `core/persistence/managed-sync-orphans.ts:196` | `classifyManagedSyncOrphans` | 3 | 2 |  | new | `listManagedSyncOrphans` | orphan cursors by incarnation |
| `core/persistence/managed-sync-orphans.ts:215` | `classifyManagedSyncOrphans` | 3 | 2 |  | new | `listManagedSyncOrphans` | orphan checkpoint scan by incarnation |
| `core/persistence/memory-mutations.ts:236` | `submitRememberMutation` | 2 | 2 | sources | new | `readSourceGuard` | write pipeline; source incarnation and kind read |
| `core/persistence/memory-mutations.ts:439` | `submitForgetMutation` | 2 | 2 | sources | new | `readSourceGuard` | write pipeline; source read for forget |
| `core/persistence/memory-mutations.ts:465` | `submitForgetMutation` | 2 | 2 | pages | new | `pagesExistForSlugs` | write pipeline; live page existence check |
| `core/persistence/memory-prepare.ts:61` | `activeUnlinkedCopy` | 4 | 2 | facts | new | `activeUnlinkedFactIds` | write pipeline; active unlinked facts for source |
| `core/persistence/memory-proposals.ts:193` | `runMemoryProposalUpkeep` | 33 | 33 | memory_proposals | new | `expireMemoryProposals` | UPDATE expires awaiting proposals |
| `core/persistence/memory-proposals.ts:201` | `runMemoryProposalUpkeep` | 33 | 33 | memory_proposals | new | `listAwaitingMemoryProposals` | oldest awaiting proposals, limited |
| `core/persistence/memory-proposals.ts:214` | `runMemoryProposalUpkeep` | 33 | 33 | memory_proposals | new | `deleteSettledMemoryProposals` | DELETE settled proposals past retention |
| `core/persistence/memory-proposals.ts:392` | `listMemoryProposals` | 1 | 1 | memory_proposals | new | `listMemoryProposals` | memory proposals filtered by state |
| `core/persistence/memory-proposals.ts:403` | `pendingProposalSummary` | 3 | 2 | memory_proposals, now | new | `pendingProposalSummary` | pending proposal count and oldest age |
| `core/persistence/mirror-read-only.ts:26` | `sourceMirrorReadOnly` | 6 | 3 | sources | existing | `getSource` | config and local path; flag derived in TS |
| `core/persistence/mirror-read-only.ts:37` | `readOnlyCheckout` | 1 | 1 | sources | existing | `getSource` | config and local path; reads more |
| `core/persistence/orphan-bindings.ts:29` | `listOrphanBindings` | 6 | 4 | persistence_requests | new | `listOrphanBindings` | bindings with orphaned requests |
| `core/persistence/ownership.ts:86` | `getWorktreeBinding` | 50 | 35 |  | new | `getWorktreeBinding` | worktree binding join; many callers |
| `core/persistence/page-append.ts:437` | `<anonymous>` | 2 | 2 | pages | new | `pageBodyBytes` | write pipeline; append body byte size |
| `core/persistence/page-batch.ts:117` | `readBatch` | 1 | 1 | persistence_requests | new | `getWriteRequestsByPrincipal` | request rows by principal and id list |
| `core/persistence/page-batch.ts:154` | `batchLinks` | 1 | 1 | persistence_effects | new | `batchLinkEffectStates` | links effect state by request ids |
| `core/persistence/page-purge.ts:517` | `listPagePurges` | 2 | 2 | page_purges | new | `listPagePurges` | purge records by source and slug |
| `core/persistence/page-purge.ts:531` | `<anonymous>` | 1 | 1 | page_purges | new | `deletePagePurge` | DELETE purge record returning request id |
| `core/persistence/page-upload.ts:202` | `<anonymous>` | 1 | 1 |  | new | `reservedUploadBytes` | sum of reserved staging bytes |
| `core/persistence/parked-groups.ts:28` | `readParkedGroups` | 4 | 3 | persistence_source_bindings | new | `readParkedGroups` | parked effects grouped by binding |
| `core/persistence/purge-deleted.ts:113` | `recordedTombstones` | 4 | 3 | op_checkpoints, p.deleted_at, pages | new | `listRecordedTombstones` | recorded tombstones by source |
| `core/persistence/purge-parks.ts:48` | `readPurgeParks` | 2 | 1 | op_checkpoints, p.deleted_at, pages | new | `readPurgeParks` | purge park checkpoints for deleted pages |
| `core/persistence/receipt-true-up.ts:35` | `trueUpRequests` | 12 | 12 | persistence_effects | new | `listTrueUpRequests` | effects joined for receipt true-up |
| `core/persistence/receipt-true-up.ts:51` | `<anonymous>` | 12 | 12 | persiste, persistence_requests, t | new | `trueUpRequestReceipts` | CTE rewrites request receipt sizes |
| `core/persistence/receipt-true-up.ts:83` | `sweepCompactedReservations` | 32 | 32 | persistence_requests | new | `sweepCompactedReservations` | sequence scan of compacted requests |
| `core/persistence/refresh-barrier.ts:147` | `expireDeferredWrites` | 18 | 12 | persistence_requests, persistence_worktree_refreshes, persistence_worktrees | new | `listExpiredDeferredWrites` | deferred requests past expiry |
| `core/persistence/refresh-barrier.ts:160` | `expireDeferredWrites` | 18 | 12 | persistence_requests, persistence_worktrees, sources | new | `listExpiredDeferredWrites` | deferred requests with source join |
| `core/persistence/refusal-breaker.ts:69` | `listSuppressedWrites` | 4 | 3 | persistence_requests | new | `listSuppressedWrites` | suppressed write refusal counts |
| `core/persistence/resolve-paths.ts:122` | `resolveSourcePaths` | 1 | 1 | sources | new | `readSourcePaths` | source path, commit, config, archived |
| `core/persistence/segmented-mirror-gate.ts:89` | `resumeGatedMirrors` | 32 | 32 | persistence_effects, persistence_requests, persistence_worktrees | new | `listGatedMirrorRequests` | gated mirror effects joined to requests |
| `core/persistence/semantic-pages.ts:83` | `prepareSemanticPageMutation` | 2 | 2 | sources | new | `readSourceKind` | write pipeline; source kind read |
| `core/persistence/soak-counters.ts:90` | `readSoakCounters` | 4 | 3 | op_checkpoints | new | `readSoakCounters` | soak counts from checkpoints |
| `core/persistence/sync-admission.ts:84` | `readSetting` | 4 | 3 | config, op_checkpoints | new | `readSyncSetting` | config value plus checkpoint override |
| `core/persistence/sync-authority.ts:50` | `resolveSyncPersistenceMode` | 4 | 3 | persistence_source_bindings, sources | new | `resolveSyncPersistenceMode` | binding existence per source |
| `core/persistence/sync-blocked.ts:32` | `readBlockedManagedSyncs` | 3 | 2 | op_checkpoints | new | `listBlockedManagedSyncs` | blocked managed sync cursors |
| `core/persistence/sync-blocked.ts:47` | `readBlockedManagedSyncs` | 3 | 2 | op_checkpoints, sources | new | `listBlockedManagedSyncFailures` | blocked syncs with failure rows |
| `core/persistence/sync-delete-tombstones.ts:48` | `readUnreviewedSyncTombstones` | 4 | 3 | op_checkpoints, pages | new | `listUnreviewedTombstones` | unreviewed sync tombstone rows |
| `core/persistence/sync-drain.ts:1252` | `readManagedSyncBacklog` | 4 | 3 | op_checkpoints, sources | new | `readManagedSyncBacklog` | backlog header from checkpoint |
| `core/persistence/sync-failures.ts:171` | `readManagedSyncFailures` | 6 | 3 |  | new | `listManagedSyncFailureCursors` | failure cursors by source |
| `core/persistence/sync-failures.ts:202` | `readManagedSyncFailures` | 6 | 3 | op_checkpoints, sources | new | `listManagedSyncFailures` | failure rows joined to sources |
| `core/persistence/sync-freshness.ts:105` | `readSyncFreshness` | 1 | 1 | persist, persistence_source_bindings, sources | new | `readSyncFreshness` | binding and source freshness rows |
| `core/persistence/sync-holds.ts:556` | `readGitImageHoldCounts` | 2 | 1 | op_checkpoints, sources | new | `readGitImageHoldCounts` | image hold counts per source |
| `core/persistence/sync-holds.ts:564` | `countGitHolds` | 4 | 4 | op_checkpoints | new | `countGitHolds` | hold count from checkpoint |
| `core/persistence/sync-holds.ts:575` | `readGitSourceHolds` | 16 | 8 | op_checkpoints, sources | new | `readGitSourceHolds` | git hold counts per source |
| `core/persistence/sync-holds.ts:595` | `readGitHoldListing` | 1 | 1 | op_checkpoints, sources | new | `listGitHoldListing` | git hold listing by source |
| `core/persistence/sync-holds.ts:1165` | `readSyncConversions` | 1 | 1 | op_checkpoints, sources | new | `readSyncConversions` | conversion counts from checkpoints |
| `core/persistence/sync-holds.ts:1184` | `readGitHoldRetryPaths` | 3 | 3 | op_checkpoints | new | `readGitHoldRetryPaths` | retry paths from checkpoint |
| `core/persistence/sync-holds.ts:1449` | `buildHoldReport` | 3 | 3 |  | new | `readHoldReport` | hold count and drift from checkpoints |
| `core/persistence/sync-holds.ts:1455` | `buildHoldReport` | 3 | 3 | sources | existing | `getSource` | mirror flag from config; derive in TS |
| `core/persistence/sync-movement.ts:141` | `readSourceMovement` | 4 | 3 | persistence_source_bindings, persistence_worktrees, sources | new | `readSourceMovement` | binding worktree owner per source |
| `core/persistence/sync-pass-row.ts:185` | `readLivePassRows` | 21 | 10 | op_checkpoints, sources | new | `readLiveSyncPassRows` | live pass rows from checkpoints |
| `core/persistence/takes-prepare.ts:102` | `heldTakeRows` | 1 | 1 | derived_generations | new | `heldTakeRows` | held derived generation for takes |
| `core/persistence/terminal-failures.ts:105` | `bounded` | 6 | 5 |  | new | `listBoundedTerminalFailures` | bounded terminal failure rows |
| `core/persistence/terminal-failures.ts:240` | `readCheckpointBlockerMap` | 6 | 5 | op_checkpoints, sources | new | `readCheckpointBlockers` | source ids with checkpoint blockers |
| `core/persistence/terminal-failures.ts:246` | `readCheckpointBlockerMap` | 6 | 5 | op_checkpoints, persistence_source_bindings, sources | new | `readCheckpointBlockerMap` | checkpoint blocker worktree map |
| `core/persistence/topology-recovery.ts:224` | `scan` | 24 | 12 | persistence_topology_changes, persistence_worktrees | new | `listTopologyRecoveries` | topology change recovery scan |
| `core/persistence/valid-time-advisory.ts:25` | `<anonymous>` | 8 | 8 | pages | new | `readPageBodyForAdvisory` | write pipeline; advisory reads page body |
| `core/persistence/worktree-refresh.ts:1224` | `resumeWorktreeRefreshes` | 12 | 12 | persistence_worktree_refreshes, persistence_worktrees | new | `listStaleWorktreeRefreshes` | stale worktree refresh rows |
| `core/persistence/worktree-refresh.ts:1548` | `stuckWorktreeRefreshes` | 2 | 1 | persistence_worktree_refreshes | new | `listStuckWorktreeRefreshes` | worktree refreshes in stuck states |
| `core/persistence/writer-versions.ts:74` | `recentWriterVersions` | 5 | 4 | persistence_brain, persistence_requests | new | `recentWriterVersions` | recent writer versions since cutoff |
| `core/repair/core.ts:303` | `readCursor` | 33 | 4 | op_checkpoints | new | `readOpCheckpoint` | op_checkpoints cursor; no member |
| `core/repair/core.ts:324` | `capacity` | 33 | 4 | persistence_counters | new | `readPersistenceCounters` | persistence_counters keyed read; no member |
| `core/repair/failed-writes.ts:217` | `lostCallerWrites` | 4 | 3 |  | new | `listLostCallerWrites` | persistence_requests failed rows |
| `core/repair/failed-writes.ts:228` | `lostCallerWrites` | 4 | 3 | persistence_requests | new | `countLostCallerWrites` | persistence_requests count |
| `core/repair/fences.ts:556` | `reportFences` | 3 | 3 | op_checkpoints | new | `readSyncHoldHeldAt` | sync-hold checkpoints; no member |
| `core/repair/slug-conflicts.ts:821` | `reportConflicts` | 3 | 3 | op_checkpoints | new | `readSyncHoldHeldAt` | frontmatter slug conflict hold time |
| `core/sync-identity-downgrades.ts:113` | `listIdentityDowngrades` | 2 | 1 | op_checkpoints, pages | new | `listIdentityDowngrades` | op_checkpoints joined to pages identity downgrades |
| `core/sync-pending.ts:106` | `readFirstDue` | 1 | 1 | sync_wanted_markers | new | `readSyncFirstDue` | sync wanted markers first due time |

### 2. Page reads, counts and hygiene checks (Lane 1)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/calibration.ts:191` | `checkHiddenBySearchPolicy` | 2 | 1 | pages, sources | new | `countHiddenBySearchPolicy` | Slug pattern counts over pages |
| `commands/doctor/checks/content-quality.ts:298` | `runQuarantine` | 2 | 1 | pages | new | `countQuarantinedPages` | Pages with quarantine frontmatter |
| `commands/doctor/checks/content-quality.ts:316` | `runQuarantine` | 2 | 1 | pages | new | `countContentFlaggedPages` | Pages with content_flag frontmatter |
| `commands/doctor/checks/core-health.ts:278` | `jsonbIntegrityCheck` | 16 | 1 | pages | new | `countStringFrontmatterPages` | Pages with string-typed frontmatter |
| `commands/doctor/checks/core-health.ts:560` | `rawProvenanceCheck` | 2 | 1 | pages | new | `countRawProvenancePages` | Dream-generated or raw-provenance pages |
| `commands/doctor/checks/core-memory.ts:29` | `coreMemoryCheck` | 2 | 1 | pages | new | `countCoreMemoryPages` | Always-load pages with body |
| `commands/doctor/checks/default-source-path.ts:73` | `defaultSourceLocalPathCheck` | 2 | 1 | pages | new | `countDefaultSourceFileBacked` | Default-source live and file-backed counts |
| `commands/doctor/checks/derived-visibility.ts:40` | `derivedVisibilityCheck` | 4 | 3 | pages | new | `listDerivedVisibilityPages` | Derived atoms and concepts; pages |
| `commands/doctor/checks/entity-duplicates.ts:50` | `runPersonTitleDuplicates` | 2 | 1 | pages | new | `listPersonTitleCandidates` | Person pages by slug pattern |
| `commands/doctor/checks/extraction-sync.ts:220` | `checkContentHashDuplicates` | 2 | 1 | pages | new | `listDuplicateContentHashes` | Hash groups; findDuplicatePages needs inputs |
| `commands/doctor/checks/extraction-sync.ts:827` | `computeAtomProvenanceDriftCheck` | 4 | 3 |  | new | `countAtomProvenanceDrift` | Atom provenance drift; pages |
| `commands/doctor/checks/git-holds.ts:121` | `readNoncanonicalPrivate` | 4 | 3 | jsonb_object_keys, pages, sources | new | `listNoncanonicalPrivatePages` | Pages by frontmatter key; pages |
| `commands/doctor/checks/knowledge-health.ts:431` | `conversationPipelineNote` | 2 | 1 | pages | new | `countPagesOutsideConversationSlugs` | Pages by type and slug pattern |
| `commands/doctor/checks/local-audits.ts:148` | `runExtractionBacklogs` | 2 | 1 | pages | new | `listBracketSourcePaths` | Pages with bracketed source paths |
| `commands/doctor/checks/privacy-label-ignored.ts:30` | `privacyLabelIgnoredCheck` | 4 | 3 | pages | new | `listPrivacyLabelHits` | Pages with access labels |
| `commands/doctor/checks/safe-index.ts:15` | `safeIndexPendingCheck` | 4 | 3 |  | new | `countSafeIndexRebuildable` | Rebuildable page counts by kind |
| `commands/doctor/checks/slug-path-mismatch.ts:63` | `runSlugPathMismatch` | 2 | 1 | pages, sources | new | `listSlugPathMismatchPages` | Pages whose slug mismatches source path |
| `commands/doctor/checks/storage-manifest.ts:27` | `storageManifestCheck` | 2 | 1 | pages, tags | new | `countStorageManifestPagesBySource` | Storage manifest counts by source |
| `commands/doctor/checks/transcript-secrets.ts:30` | `transcriptSecretExposureCheck` | 2 | 1 | pages | new | `countTranscriptImportPages` | Transcript-import conversation pages |
| `commands/doctor/schema-pack-checks.ts:118` | `checkSchemaPackConsistency` | 3 | 2 | pages | new | `listSchemaPackPageTypes` | Page type and kind consistency |
| `commands/migrations/v0_18_0.ts:150` | `phaseCVerify` | 1 | 1 | pages | new | `countPagesWithoutSource` | count of pages with null source |
| `commands/migrations/v0_29_1.ts:96` | `phaseCVerify` | 1 | 1 | pages | new | `countPagesWithoutEffectiveDate` | count pages null effective date |
| `commands/reconcile-links.ts:120` | `runReconcileLinks` | 1 | 1 | pages | new | `listMarkdownSlugs` | markdown page slugs by source |
| `commands/reindex.ts:283` | `countPending` | 1 | 1 | pages | new | `countPagesBelowChunkerVersion` | pages with stale chunker_version count |
| `core/advisor/collect-chronicle.ts:133` | `<anonymous>` | 3 | 3 | pages | new | `listChroniclePageDates` | page dates for advisor chronicle |
| `core/backfill-effective-date.ts:191` | `backfillEffectiveDate` | 4 | 2 | pages | new | `listPagesForEffectiveDateBackfill` | keyset page scan for backfill |
| `core/backup/coverage.ts:128` | `countLivePages` | 5 | 5 | pages | new | `countLivePages` | count of live pages |
| `core/context/retrieval-reflex.ts:417` | `resolveEntitiesToPointers` | 2 | 2 | pages | new | `readPagesForPointers` | pages with compiled truth for pointers |
| `core/eligibility/fence-overlay.ts:278` | `loadFenceChunkOverlay` | 4 | 4 | pages | new | `loadFenceChunkOverlay` | fence overlay on pages; incoming claims |
| `core/eligibility/scan.ts:206` | `readTrustScanState` | 8 | 1 | pages | new | `countTrustScanRemaining` | pages with untrusted tiers after cursor |
| `core/embedding-readiness.ts:87` | `<anonymous>` | 2 | 2 | p.knowledge_revision, pages, sources | new | `countPagesMissingEmbeddingRevision` | pages joined to sources; embedding readiness count |
| `core/entities/resolve.ts:246` | `followRetirement` | 4 | 2 |  | new | `followPageRetirement` | retirement flags and targets |
| `core/entity-identity.ts:71` | `resolvePageId` | 2 | 2 | pages | new | `resolvePageIdBySlug` | live page id by slug and source |
| `core/export-snapshot.ts:44` | `readExportPages` | 20 | 1 | export_page, pages, tags | new | `readExportPageRows` | export page rows with tags |
| `core/facts/derivation-inputs.ts:39` | `recordDerivationInputs` | 2 | 2 | derivation_inputs | new | `insertDerivationInputs` | derivation_inputs insert; write path |
| `core/facts/derivation-inputs.ts:58` | `derivedRowsFrom` | 7 | 7 | derivation_inputs | new | `listDerivedRowsForInputs` | derivation_inputs join; no member |
| `core/facts/purge.ts:189` | `planFactPurge` | 1 | 1 | page_versions, pages | new | `countPurgeVersionHits` | page_versions text hit count for purge |
| `core/facts/withdrawal-discovery.ts:156` | `discoverWithdrawalTargets` | 7 | 3 | pages | new | `listWithdrawalCandidatePages` | pages body scan by source |
| `core/facts/withdrawal-discovery.ts:205` | `discoverWithdrawalTargets` | 7 | 3 | pages | new | `listPageRevisionsByIds` | page revision by id; no existing member returns it |
| `core/facts/withdrawal.ts:118` | `<anonymous>` | 2 | 2 | pages | new | `listWithdrawalPageSlugs` | pages; slugs from facts source markdown |
| `core/facts/withdrawal.ts:161` | `<anonymous>` | 2 | 2 | pages | new | `markPagesRevisionReset` | pages revision reset write; core write rule |
| `core/fence-repair/census.ts:151` | `scanPages` | 5 | 5 |  | new | `scanFencePages` | pages scan for fence census |
| `core/fence-repair/census.ts:163` | `scanPages` | 7 | 5 |  | new | `scanFencePages` | pages scan for fence census; second call site |
| `core/last-retrieved.ts:222` | `<anonymous>` | 8 | 8 | SET, page_retrievals, pages | new | `touchPageRetrievals` | insert page_retrievals rows |
| `core/maintenance/status.ts:56` | `brainAgeMs` | 3 | 2 | pages | new | `oldestPageCreatedAt` | min created_at across pages |
| `core/ops/attribution.ts:170` | `<anonymous>` | 2 | 2 | pages | new | `readPageRevisionAttribution` | page revision write attribution |
| `core/ops/attribution.ts:196` | `<anonymous>` | 2 | 2 | page_versions | new | `readVersionWriteAttribution` | page_versions write attribution |
| `core/ops/get-page-projection.ts:217` | `pageTrustForRead` | 4 | 4 | needs_rederive, pages | new | `countRederiveEligiblePage` | page eligibility count vs needs_rederive |
| `core/page-state/versions.ts:44` | `<anonymous>` | 22 | 22 | page_versions | existing | `createVersion` | same page_versions insert; tx callers |
| `core/persistence/origin-guard.ts:157` | `assertRevivalUnclaimed` | 2 | 2 | pages | new | `listRevivalCandidates` | deleted page revival candidates by slug |
| `core/persistence/overwritten-edits.ts:90` | `scanOverwrittenEdits` | 2 | 1 |  | new | `scanOverwrittenEdits` | page versions joined to requests |
| `core/persistence/page-prepare.ts:1093` | `prepareInlineOrSegmentedMutation` | 2 | 2 | page_versions | new | `readPageVersion` | page version row by id and page |
| `core/questions/pages.ts:37` | `readQuestionPage` | 1 | 1 | pages | new | `readQuestionPage` | question page body and revision |
| `core/questions/receipt.ts:125` | `buildReceipt` | 1 | 1 | pages | new | `resolvePageIdBySlug` | live page id by slug; getPage applies read policy |
| `core/repair/atom-fence-rows.ts:85` | `findAtomFenceRows` | 4 | 3 |  | new | `listAtomFenceRows` | atom pages with revision and text |
| `core/repair/attribution-backfill.ts:41` | `<anonymous>` | 6 | 2 |  | new | `listAttributionBackfillCandidates` | grouped page attribution from write requests |
| `core/repair/attribution-backfill.ts:131` | `plan` | 6 | 2 | pages | new | `countPagesMissingAttribution` | count of unattributed pages |
| `core/repair/connector-fences.ts:58` | `candidates` | 2 | 2 | pages, sources | new | `listConnectorFenceCandidates` | connector pages joined to sources |
| `core/repair/connector-fences.ts:65` | `segmentedCandidates` | 2 | 2 | pages, sources | new | `listSegmentedConnectorCandidates` | segmented connector pages |
| `core/repair/origin-carry.ts:121` | `<anonymous>` | 3 | 3 | pages | new | `readPageDeletionState` | deleted flag by source and slug |
| `core/repair/origin-carry.ts:184` | `<anonymous>` | 1 | 1 | pages | new | `readDeletedPagesBefore` | soft-deleted pages older than cutoff |
| `core/repair/timeline.ts:78` | `scanTimelineHistory` | 6 | 4 | pages, timeline_entries | new | `scanPagesForTimelineHistory` | keyset page scan with body fields |
| `core/repair/visibility.ts:91` | `planLineage` | 2 | 2 | pages | new | `listLineageCandidatePages` | concept pages with visibility |
| `core/repair/visibility.ts:117` | `planLineage` | 2 | 2 |  | new | `listLineageCandidatePages` | page visibility and lengths |
| `core/repair/visibility.ts:152` | `planEvents` | 2 | 2 |  | new | `listEventLineageRows` | event pages with origin join |
| `core/repair/visibility.ts:171` | `planAliases` | 2 | 2 | pages | new | `listAliasVisibilityRows` | alias page visibility rows |
| `core/source-health.ts:384` | `pageCountsBySource` | 1 | 1 | pages | existing | `countPagesBy` | per-type rows; caller sums per source |
| `core/sources-ops.ts:318` | `countAllPages` | 1 | 1 | pages | new | `countAllPagesForSource` | counts including soft-deleted pages |
| `core/sources-ops.ts:326` | `countVisiblePages` | 5 | 5 | pages | existing | `countPagesBy` | reads more: per-type rows; total.pages used |
| `core/sweep.ts:216` | `runMaintenanceSweep` | 1 | 1 | pages | new | `listRecentlyUpdatedSlugs` | pages updated since cutoff |
| `core/sweep.ts:381` | `runLinksTimelinePass` | 1 | 1 | pages | new | `readPageUpdateStamps` | read and update stamps by slug |
| `core/sync-anchor.ts:490` | `resolveSlugRootMode` | 3 | 3 | pages | new | `hasPageUnderSlugPrefix` | exists page with slug prefix |
| `core/sync-status-report.ts:137` | `buildSyncStatusReport` | 2 | 2 | s | new | `countSourcePagesAndChunks` | per-source pages and chunk counts |
| `core/transcripts/discover.ts:146` | `indexImportedSessions` | 1 | 1 | pages | new | `listConversationFrontmatter` | conversation page frontmatter by source |
| `core/trust/taint.ts:177` | `lowerDerivedPageIn` | 2 | 2 | pages | existing | `livePageIdsAt` | live page ids by source and slug |
| `core/write-through.ts:392` | `resolvePageWriteTarget` | 3 | 3 | pages | new | `readPageSourcePaths` | source path and uri for one page |

### 3. Trust tiers, claims, review, fact withdrawal, beliefs (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/access-lineage.ts:23` | `rawOnlyRules` | 2 | 1 | access_rules | new | `listRawOnlyAccessRules` | Access rules without derived coverage |
| `commands/doctor/checks/access-lineage.ts:36` | `audienceMembers` | 2 | 1 | access_members | new | `listAudienceMemberIds` | Active audience members |
| `commands/doctor/checks/attest-read-access.ts:31` | `attestReadVerdict` | 2 | 1 | access_tokens | new | `listAttestTokens` | Attest-actor access tokens |
| `commands/doctor/checks/folder-access.ts:30` | `policySources` | 2 | 1 | access_policy_state | new | `listAccessPolicySourceIds` | access_policy_state source ids |
| `commands/doctor/checks/folder-access.ts:111` | `runFolderAccess` | 2 | 1 |  | new | `readAccessStateUnreadable` | Calls access-state SQL function |
| `commands/doctor/checks/grant-new-ops.ts:101` | `checkGrantNewOps` | 2 | 1 | oauth_clients | new | `listOauthClientRows` | Live OAuth clients |
| `commands/doctor/checks/grant-new-ops.ts:118` | `checkGrantNewOps` | 2 | 1 | access_tokens | new | `listActiveAccessTokens` | Unrevoked access tokens |
| `commands/doctor/checks/guest-source.ts:85` | `guestSourceCheck` | 2 | 1 | guest_sources, sources | new | `readGuestSourceRows` | guest_sources join; readGuestSourceRow is per source |
| `commands/doctor/checks/legacy-token-grants.ts:31` | `runLegacyTokenGrants` | 2 | 1 | access_tokens | new | `listLegacyTokenGrants` | Unrevoked access tokens |
| `commands/doctor/checks/routing-federation.ts:190` | `checkOauthConfidentialHealth` | 2 | 1 | oauth_clients | new | `listOauthConfidentialClients` | Confidential OAuth client hashes |
| `commands/doctor/checks/routing-federation.ts:258` | `checkOauthClientScopeHealth` | 2 | 1 | oauth_clients, sources | new | `listOauthFederatedGrants` | Federated grants with source join |
| `commands/doctor/checks/routing-federation.ts:285` | `checkOauthClientScopeHealth` | 2 | 1 | facts, pages, sources | new | `findSourceForGrantSuffix` | Source lookup by grant suffix |
| `commands/doctor/checks/routing-federation.ts:310` | `checkOauthClientScopeHealth` | 2 | 1 | oauth_clients, oauth_grant_audit | new | `listOauthClientsNoRevision` | OAuth clients with zero revision |
| `commands/doctor/checks/trust-sources-unclaimed.ts:38` | `runTrustSourcesUnclaimed` | 2 | 1 | sources | new | `listUnclaimedTrustSources` | Operator-curated sources lacking claim |
| `core/belief/coverage-report.ts:53` | `coverageIntervals` | 1 | 1 | belief_events, sources | new | `readCoverageIntervals` | belief events joined to sources |
| `core/belief/coverage-report.ts:347` | `coveredSources` | 5 | 4 | belief_events, sources | new | `listCoveredSources` | sources with coverage events |
| `core/belief/lifetimes.ts:19` | `readOpenLifetimes` | 1 | 1 | belief_page_lifetimes | new | `readOpenLifetimes` | open belief page lifetimes |
| `core/belief/lifetimes.ts:31` | `mintLifetime` | 6 | 1 | belief_page_lifetimes | new | `mintBeliefLifetime` | insert belief page lifetime |
| `core/belief/lifetimes.ts:57` | `resolveLifetimes` | 1 | 1 | belief_page_lifetimes, pages | new | `resolveBeliefLifetimes` | lifetimes joined to pages |
| `core/belief/purge.ts:363` | `suppressedFields` | 1 | 1 | belief_redactions | new | `readBeliefRedactions` | belief_redactions by subject |
| `core/belief/state.ts:119` | `readBeliefState` | 1 | 1 | pages | new | `readBeliefState` | belief state page query; large |
| `core/eligibility/generation.ts:27` | `readTrustGeneration` | 2 | 2 | trust_policy_state | new | `readTrustGeneration` | trust_policy_state generation |
| `core/eligibility/stamp.ts:230` | `stampRowTrust` | 2 | 2 | write_gate_receipts | new | `readWriteGateReceipt` | write_gate_receipts trust fields |
| `core/export-snapshot.ts:18` | `readExportWithdrawals` | 1 | 1 | fact_withdrawals | new | `exportWithdrawalBytes` | export size of withdrawal rows |
| `core/export-snapshot.ts:23` | `readExportWithdrawals` | 1 | 1 | fact_purges, fact_withdrawals | new | `listExportWithdrawalRows` | withdrawal and purge rows for export |
| `core/facts/meta-hook.ts:101` | `withdrawalWatermark` | 2 | 2 | access_rules | new | `withdrawalWatermark` | access_rules withdrawal watermark digest |
| `core/facts/purge-overlay.ts:18` | `sourceHasPurges` | 21 | 7 | fact_purges, take_purges | new | `hasSourcePurges` | fact_purges and take_purges existence probe |
| `core/facts/purge-verify.ts:215` | `<anonymous>` | 36 | 1 | context_volunteer_events | new | `countContextVolunteerLeaks` | purge verify scan of context_volunteer_events |
| `core/facts/purge-verify.ts:533` | `verifyFactPurge` | 1 | 1 | derivation_inputs, pages | new | `countUnpurgedDerivedPages` | purge verify: pages and derivation_inputs count |
| `core/facts/purge.ts:204` | `planFactPurge` | 1 | 1 | decide_review_proposals, decide_review_queue | new | `countPurgeReviewQueueRefs` | decide_review queue refs count |
| `core/facts/withdrawal-discovery.ts:117` | `discoverWithdrawalTargets` | 7 | 3 | fa, facts | new | `findWithdrawalTargetFacts` | withdrawal rows joined to facts |
| `core/facts/withdrawal-discovery.ts:129` | `discoverWithdrawalTargets` | 7 | 3 | facts | new | `listWithdrawalMatchPageIds` | facts joined to withdrawal input; page ids |
| `core/facts/withdrawal-discovery.ts:144` | `<anonymous>` | 14 | 3 |  | new | `matchWithdrawalAmbiguity` | anonymous; facts and pages join, ambiguity flag |
| `core/facts/withdrawal.ts:71` | `planFactWithdrawal` | 6 | 2 |  | new | `planFactWithdrawal` | withdrawal plan read; facts fingerprint |
| `core/facts/withdrawal.ts:79` | `planFactWithdrawal` | 6 | 2 | fact_withdrawals | new | `isFactWithdrawnV1` | fact_withdrawals v1 fingerprint lookup |
| `core/facts/withdrawal.ts:139` | `<anonymous>` | 2 | 2 | fact_withdrawals | new | `insertFactWithdrawal` | fact_withdrawals insert write |
| `core/facts/withdrawal.ts:149` | `<anonymous>` | 2 | 2 | decide_review_queue | new | `insertWithdrawReviewItem` | decide_review_queue insert; ON CONFLICT |
| `core/facts/withdrawal.ts:203` | `withdrawalDates` | 6 | 2 |  | new | `withdrawalDates` | withdrawal dates from fingerprints; CTE, no tables parsed |
| `core/facts/withdrawal.ts:268` | `isFactWithdrawn` | 6 | 2 | fact_purges, fact_withdrawals | new | `isFactWithdrawn` | fact_withdrawals fingerprint lookup |
| `core/facts/withdrawal.ts:278` | `isFactPurged` | 6 | 2 | fact_purges | new | `isFactPurged` | fact_purges fingerprint lookup |
| `core/repair/access.ts:18` | `plan` | 2 | 2 | gbrain_access_readers, pages | new | `listPagesWithReaders` | page readers keyset; gbrain_access_readers |
| `core/trust/allow-rules.ts:132` | `listTrustAllowRules` | 1 | 1 | trust_allow_rules | new | `listTrustAllowRules` | trust_allow_rules list |
| `core/trust/backfill.ts:423` | `relowerClaimedRows` | 2 | 1 | sources | new | `listClaimedSourceTiers` | claimed source tier decisions |
| `core/trust/backfill.ts:444` | `relowerClaimedRows` | 8 | 1 |  | new | `relowerClaimedRows` | computes lowered tiers; write path |
| `core/trust/backfill.ts:481` | `readTrustBackfillState` | 2 | 1 | op_checkpoints | new | `countTrustBackfillCheckpoints` | op_checkpoints count by fingerprint |
| `core/trust/backfill.ts:492` | `readTrustTierCounts` | 8 | 1 | pages | new | `readTrustTierCounts` | page counts grouped by tier |
| `core/trust/claim.ts:215` | `claimCandidates` | 3 | 2 | sources | new | `listTrustClaimCandidates` | claimed sources with tier |
| `core/trust/claim.ts:225` | `legacyUnknownBySource` | 3 | 2 | facts, pages | new | `legacyUnknownBySource` | unknown-tier counts by source |
| `core/trust/fence-append.ts:30` | `withPageTierKept` | 2 | 2 | pages | existing | `readPageTrustRows` | keyed read; reads more columns |
| `core/trust/fence-append.ts:34` | `withPageTierKept` | 2 | 2 | pages | existing | `readPageTrustRows` | by id; reads more columns |
| `core/trust/fence-guard.ts:73` | `guardFenceRows` | 18 | 18 |  | new | `guardFenceFactRows` | fence rows with tier ranking |
| `core/trust/owner-actions.ts:169` | `holdTableExists` | 1 | 1 | write_gate_holds | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `core/trust/owner-actions.ts:188` | `list` | 1 | 1 | write_gate_holds | new | `listWriteGateHolds` | held write-gate rows with filters |
| `core/trust/page-write.ts:85` | `storedPageTier` | 38 | 19 | pages | existing | `readPageTrustRows` | reads more: flags and write_origin |
| `core/trust/page-write.ts:287` | `recordAgentPageLowering` | 6 | 6 | pages | existing | `readPageTrustRows` | by id; reads more: flags and write_origin |
| `core/trust/page-write.ts:306` | `recordAgentPageLowering` | 6 | 6 | page_versions | new | `findPageVersionByTier` | latest page version at tier |
| `core/trust/proposals.ts:107` | `insertTrustProposal` | 6 | 6 | trust_proposals | new | `insertTrustProposal` | insert into trust_proposals |
| `core/trust/proposals.ts:142` | `listTrustProposals` | 1 | 1 | trust_proposals | new | `listTrustProposals` | trust_proposals with filters |
| `core/trust/provenance-drift.ts:255` | `scanProvenanceDrift` | 2 | 1 | pages, persistence_ | new | `scanProvenanceDrift` | pages and provenance drift scan |
| `core/trust/provenance-drift.ts:258` | `scanProvenanceDrift` | 2 | 1 | page_versions, persistence_requests | new | `scanProvenanceDrift` | page version provenance scan |
| `core/trust/review.ts:172` | `standingPreferences` | 1 | 1 | write_gate_receipts | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `core/trust/review.ts:197` | `flaggedPages` | 1 | 1 | write_gate_receipts | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `core/trust/review.ts:199` | `flaggedPages` | 1 | 1 | pages | new | `listFlaggedPages` | live pages not quarantined |
| `core/trust/review.ts:268` | `buildTrustReview` | 1 | 1 | write_gate_receipts | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `core/trust/taint.ts:53` | `readTaintInputs` | 6 | 2 | pages | new | `readTaintInputPages` | pages keyed by json input list |
| `core/trust/taint.ts:127` | `lowerToDerivedTier` | 2 | 2 | pages | new | `lowerPageTrustTiers` | UPDATE pages trust tier; write |
| `core/write-gate-store.ts:80` | `clearStalePageGateReceipts` | 10 | 10 | write_gate_receipts | new | `clearStalePageGateReceipts` | DELETE stale gate receipts for page |
| `core/write-gate-store.ts:198` | `listWriteGateHolds` | 1 | 1 |  | new | `listWriteGateHolds` | write gate holds listing |

### 4. Minion job queue, cycle locks, Wakeshift rows (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/embed-backfill-stalled.ts:25` | `embedBackfillStalledCheck` | 2 | 1 | minion_jobs | new | `listStalledEmbedBackfillSources` | Failed embed-backfill job sources |
| `commands/doctor/checks/global-maintenance-timeouts.ts:21` | `globalMaintenanceTimeoutsCheck` | 2 | 1 | minion_jobs | new | `listGlobalMaintenanceTimeouts` | Global maintenance job status rows |
| `commands/doctor/checks/global-maintenance-timeouts.ts:31` | `globalMaintenanceTimeoutsCheck` | 2 | 1 |  | new | `countGlobalMaintenanceDeathsByPhase` | Maintenance deaths by phase |
| `commands/doctor/checks/knowledge-health.ts:373` | `factsAbsorbJobsStillDead` | 2 | 1 | minion_jobs | new | `listDeadFactsAbsorbJobs` | Dead facts-absorb jobs |
| `commands/doctor/checks/legacy-job-authority.ts:31` | `readLegacyJobAuthority` | 3 | 2 | minion_jobs | new | `listLegacyAuthorityJobs` | Job authority rows; no member |
| `commands/doctor/checks/legacy-job-authority.ts:38` | `readLegacyJobAuthority` | 3 | 2 | minion_jobs | new | `listActiveJobIds` | Active job ids; no member |
| `commands/doctor/checks/legacy-job-authority.ts:39` | `readLegacyJobAuthority` | 3 | 2 | minion_jobs | new | `countLegacyAuthorityByStatus` | Null-authority jobs by status |
| `commands/doctor/checks/legacy-job-authority.ts:69` | `readQueuedSpend` | 3 | 2 |  | new | `listQueuedSpendAuthority` | Queued spend authority classification |
| `commands/doctor/checks/legacy-job-authority.ts:77` | `readQueuedSpend` | 3 | 2 | minion_jobs | new | `listStaleWaitingSpendJobs` | Waiting spend-authorized jobs |
| `commands/doctor/checks/queue-jobs.ts:352` | `computePgliteQueueHealth` | 3 | 2 | minion_jobs | new | `computeQueueDepths` | Waiting depth and age by queue |
| `commands/doctor/checks/queue-jobs.ts:574` | `computeOrphanedPrivateQueueCheck` | 2 | 1 |  | new | `listOrphanedPrivateQueues` | Private queue health by queue |
| `commands/doctor/checks/queue-jobs.ts:602` | `computeOrphanedPrivateQueueCheck` | 2 | 1 | acquired_at, gbrain_cycle_locks | new | `listLiveCycleLockIds` | readCycleLocks lacks id and TTL filter |
| `commands/doctor/checks/runtime-build-skew.ts:74` | `recentChildBuilds` | 3 | 2 | minion_jobs | new | `listRecentChildStacktraces` | Job stacktrace lines; no member |
| `commands/jobs/stats.ts:35` | `runJobsStats` | 1 | 1 | minion_jobs | new | `countCancelledJobsByName` | cancelled jobs by name in 24h |
| `commands/status.ts:253` | `buildCycleSnapshot` | 2 | 2 | minion_jobs | new | `listCompletedCycleJobs` | completed autopilot-cycle jobs |
| `commands/status.ts:265` | `buildCycleSnapshot` | 2 | 2 | minion_jobs | new | `listCompletedAutopilotJobs` | completed autopilot jobs with result |
| `commands/status.ts:319` | `buildQueueCounts` | 2 | 2 | minion_jobs | new | `countJobsByStatus` | same member as row 59; status counts |
| `commands/status.ts:343` | `buildQueueDepths` | 1 | 1 | minion_jobs | new | `queueDepths` | queue depth and oldest waiting age |
| `commands/status.ts:396` | `buildWorkersSnapshot` | 1 | 1 | minion_jobs | new | `lastCompletedJobAt` | latest completed minion job time |
| `commands/wakeshift.ts:85` | `watchCounts` | 1 | 1 | wake_subscriptions | new | `countWakeSubscriptions` | wake subscriptions by state |
| `core/advisor/collect-stalled-jobs.ts:22` | `<anonymous>` | 3 | 3 | minion_jobs | new | `countStalledActiveJobsByName` | stalled active jobs grouped by name |
| `core/cycle/dream-breaker.ts:101` | `countDeadDreamSubmissions` | 4 | 3 | minion_jobs | new | `countDeadDreamSubmissions` | dead dream subagent submissions; dream breaker input |
| `core/facts/dead-absorb-retry.ts:111` | `reconcile` | 4 | 3 | minion_jobs | new | `listDeadAbsorbJobs` | failed minion_jobs for dead-absorb retry |
| `core/facts/drain.ts:124` | `factsDrainBacklog` | 2 | 1 | minion_jobs | new | `factsDrainBacklog` | minion_jobs facts drain counts by status |
| `core/minions/admission.ts:315` | `countTtlExpiredWaiting` | 1 | 1 | minion_jobs | new | `countTtlExpiredWaiting` | waiting jobs past ttl count |
| `core/minions/delegated-admission.ts:23` | `admitDelegatedRetry` | 1 | 1 | minion_jobs | new | `getFailedJobForRetry` | failed or dead job name and data |
| `core/minions/global-maintenance-stall.ts:58` | `assessGlobalMaintenanceStall` | 2 | 1 | minion_jobs | new | `listGlobalMaintenanceFailures` | autopilot global maintenance job failures |
| `core/minions/idempotency-coalesce.ts:68` | `insertOrCoalesce` | 2 | 2 | minion_jobs | new | `insertOrCoalesceJob` | minion_jobs insert with idempotency coalesce |
| `core/minions/job-insight.ts:145` | `describeJobs` | 2 | 2 |  | existing | `readDatabaseClock` | returns database now() as text |
| `core/minions/job-insight.ts:148` | `describeJobs` | 2 | 2 | minion_jobs | new | `listJobSubmitters` | submitter and owner for job describe |
| `core/minions/job-insight.ts:158` | `describeJobs` | 2 | 2 | minion_jobs | new | `countWaitingAhead` | waiting jobs ahead by priority and age |
| `core/minions/job-insight.ts:164` | `describeJobs` | 2 | 2 | minion_jobs | new | `listActiveJobsOwned` | active jobs by queue and owner |
| `core/minions/job-insight.ts:203` | `describeJobs` | 2 | 2 | minion_jobs, tree | new | `listJobTreeOwners` | recursive job tree owners |
| `core/minions/job-list-page.ts:40` | `listJobPage` | 1 | 1 | created_at, minion_jobs | new | `listJobPage` | paged minion_jobs by created_at |
| `core/minions/queue-families.ts:13` | `queueFamilyStats` | 2 | 2 |  | new | `queueFamilyStats` | queue family aggregate counts |
| `core/minions/queue.ts:704` | `getJob` | 17 | 8 | minion_jobs | new | `getMinionJob` | minion_jobs row by id; no engine member |
| `core/minions/queue.ts:751` | `getJobs` | 1 | 1 | minion_jobs | new | `listJobsRecent` | minion_jobs ordered page, offset |
| `core/minions/queue.ts:760` | `removeJob` | 1 | 1 | minion_jobs | new | `removeTerminalJob` | minion_jobs delete if terminal |
| `core/minions/queue.ts:1060` | `<anonymous>` | 1 | 1 | minion_jobs | new | `listDescendantJobIds` | recursive descendant job ids |
| `core/minions/queue.ts:1229` | `<anonymous>` | 1 | 1 | minion_jobs | new | `getMinionJob` | minion_jobs row by id; same as row 51 |
| `core/minions/queue.ts:1321` | `getStats` | 2 | 2 | minion_jobs | new | `countJobsByStatus` | minion_jobs status counts |
| `core/minions/queue.ts:1328` | `getStats` | 2 | 2 |  | new | `countJobsByName` | minion job totals by name |
| `core/minions/queue.ts:1343` | `getStats` | 2 | 2 |  | new | `countDailyJobsByName` | minion job 24h counts by name |
| `core/minions/queue.ts:1358` | `getStats` | 2 | 2 | minion_jobs | new | `oldestWaitingByName` | waiting job count and oldest age |
| `core/minions/queue.ts:1398` | `getStats` | 2 | 2 | minion_jobs | new | `countStalledActiveJobs` | active jobs past lock expiry count |
| `core/minions/queue.ts:1404` | `getStats` | 2 | 2 | minion_jobs | new | `countActiveJobsByHealth` | active healthy vs waiting counts |
| `core/minions/queue.ts:1490` | `claim` | 1 | 1 |  | new | `(executeRawDirect)` | runs through executeRawDirect, also raw_sql |
| `core/minions/queue.ts:1524` | `hasOverdueWatchdogSuspect` | 1 | 1 | minion_jobs | new | `hasOverdueWatchdogSuspect` | overdue watchdog suspect exists check |
| `core/minions/queue.ts:1752` | `<anonymous>` | 1 | 1 | minion_jobs | new | `getJobParentId` | parent_job_id by job id |
| `core/minions/queue.ts:1764` | `<anonymous>` | 1 | 1 | minion_jobs | new | `completeJobRow` | minion_jobs complete update; core write |
| `core/minions/queue.ts:2299` | `pauseJob` | 1 | 1 | minion_jobs | new | `pauseMinionJob` | minion_jobs pause update |
| `core/minions/queue.ts:2314` | `resumeJob` | 1 | 1 | minion_jobs | new | `resumeMinionJob` | minion_jobs resume update returning row |
| `core/minions/queue.ts:2336` | `sendMessage` | 1 | 1 | minion_inbox | new | `insertMinionInboxMessage` | minion_inbox insert |
| `core/minions/submission-authority.ts:372` | `assertNoUnreviewedJobs` | 4 | 1 | minion_jobs | new | `listUnreviewedJobs` | unreviewed submission authority jobs |
| `core/minions/supervisor.ts:287` | `queryWedgeSignals` | 1 | 1 |  | new | `countWedgeSignals` | stalled and active counts for supervisor |
| `core/minions/supervisor.ts:413` | `probeQueueStateInner` | 1 | 1 | minion_jobs | new | `oldestWaitingAgeSeconds` | oldest waiting job age in queue |
| `core/minions/transcript.ts:54` | `loadTranscriptRows` | 1 | 1 | subagent_messages | new | `listSubagentMessages` | subagent_messages transcript rows |
| `core/minions/transcript.ts:62` | `loadTranscriptRows` | 1 | 1 | subagent_tool_executions | new | `listSubagentToolExecutions` | subagent_tool_executions rows |
| `core/retry.ts:270` | `withRetry` | 5 | 2 | minion_jobs | new | `requeueDelayedJobs` | UPDATE delayed jobs to waiting |
| `core/source-health.ts:422` | `jobCountsBySource` | 1 | 1 |  | new | `jobCountsBySource` | failed or dead job counts by source |
| `core/sync-status-report.ts:187` | `buildSyncStatusReport` | 2 | 2 |  | new | `countQueuedJobsBySource` | queued job counts by source |

### 5. Facts queries, purge and unlinked-fact checks (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/conversation-outcomes.ts:26` | `conversationOutcomesStaleCheck` | 4 | 3 | facts | new | `listConversationFactRows` | Facts by extract source prefix; reads facts |
| `commands/doctor/checks/facts-redaction-marker.ts:15` | `factsRedactionMarkerCheck` | 4 | 3 | facts, sources | new | `countRedactedFacts` | Facts with redaction marker |
| `commands/doctor/checks/outside-content-fences.ts:25` | `runOutsideContentFences` | 2 | 1 |  | new | `listOutsideContentFenceCounts` | Facts, world facts, takes per page |
| `commands/doctor/checks/queue-assets.ts:57` | `runQueueHealth` | 3 | 2 | facts | new | `countAtomFacts` | Live atom facts count |
| `commands/doctor/checks/trust-release-unpreviewed.ts:20` | `runTrustReleaseUnpreviewed` | 2 | 1 | facts, write_gate_holds | new | `listUnpreviewedTrustFacts` | Joins write_gate_holds; not in any family |
| `commands/doctor/checks/unlinked-facts.ts:86` | `unlinkedFactsStats` | 2 | 1 |  | new | `countUnlinkedFactsByOrigin` | fact_relink_attempts not in any family |
| `commands/doctor/checks/unlinked-facts.ts:115` | `unlinkedFactsStats` | 2 | 1 | fact_relink_attempts | new | `countUnlinkedFactStats` | fact_relink_attempts not in any family |
| `commands/doctor/checks/unlinked-facts.ts:127` | `unlinkedFactsStats` | 2 | 1 | fact_relink_attempts | new | `countFactRelinkOutcomes` | fact_relink_attempts not in any family |
| `commands/doctor/checks/vector-coverage.ts:45` | `runFactTakeVectors` | 2 | 1 | md5 | new | `countStaleFactEmbeddings` | Fact embedding staleness; vectors wait on core |
| `commands/enrich.ts:283` | `retrieveEvidence` | 10 | 1 | facts | new | `listActiveFactsForEntity` | listFactsByEntity may cover; filters differ |
| `commands/extract-conversation-facts.ts:777` | `findFreshExtractionOutcomes` | 4 | 1 | facts | new | `listFreshExtractionOutcomes` | facts outcomes for fresh extraction |
| `commands/migrations/v0_32_2.ts:247` | `phaseCVerify` | 1 | 1 | facts | new | `findRowNumConflicts` | facts grouped by source slug; migration check |
| `core/belief/purge.ts:345` | `rowSubject` | 1 | 1 | facts | new | `readFactSubject` | fact source and subject slug by id |
| `core/cycle/extract-facts.ts:363` | `listExistingFactsForPage` | 20 | 1 | facts | new | `listFactsForPage` | facts rows for a page; no page-keyed member |
| `core/cycle/extract-facts.ts:779` | `pendingLegacyRows` | 1 | 1 | facts, pages | new | `countLegacyFactsPending` | facts with no row_num or dimension, by entity |
| `core/cycle/phases/consolidate.ts:207` | `runPhaseConsolidate` | 1 | 1 | facts, pages | new | `countUnconsolidatedFactsBySource` | groups by entity; existing count is total only |
| `core/facts/bulk-days.ts:70` | `findBulkFactDays` | 4 | 3 | facts, sources | new | `findBulkFactDays` | facts grouped by day; active rows only |
| `core/facts/fence-fact-append.ts:171` | `prepareFenceFactAppend` | 2 | 2 | facts | new | `maxFenceRowNum` | MAX row_num per source markdown slug |
| `core/facts/purge-verify.ts:554` | `verifyFactPurge` | 1 | 1 | facts | new | `countFactFingerprintLeftovers` | facts fingerprint leftover count after purge |
| `core/facts/purge.ts:108` | `loadTarget` | 1 | 1 | facts | new | `loadPurgeTarget` | facts row with embedding for purge plan |
| `core/facts/purge.ts:175` | `planFactPurge` | 1 | 1 | facts, pages | new | `planFactPurgeIds` | facts ids for purge plan |
| `core/facts/reconcile-watermark.ts:138` | `readFactsReconcileBacklog` | 2 | 1 | p.k, page_facts_reconcile, pages | new | `readFactsReconcileBacklog` | page_facts_reconcile backlog rows |
| `core/facts/reconcile-watermark.ts:151` | `readFactsReconcileBacklog` | 2 | 1 | facts, p.knowledge_revision, page_facts_reconcile | new | `countFactsReconcileBacklog` | page_facts_reconcile backlog count |
| `core/facts/relink.ts:93` | `loadRelinkCandidates` | 1 | 1 | facts | new | `loadRelinkCandidates` | facts with no entity; candidate rows |
| `core/facts/relink.ts:118` | `runFactsRelink` | 1 | 1 | facts | new | `countRelinkCandidates` | facts with no entity; count |
| `core/facts/similar-active.ts:52` | `similarActiveAfterForget` | 1 | 1 | facts | new | `similarActiveAfterForget` | facts embedding presence by id |
| `core/facts/single-prepare.ts:170` | `decideSingleFact` | 4 | 2 | facts | new | `listActiveSingleFacts` | null entity compare; listFactsByEntity cannot match null |
| `core/facts/unfenced-facts.ts:303` | `planUnfencedFacts` | 5 | 3 | pages | new | `listUnfencedFactRows` | pages table; fence repair input |
| `core/facts/unfenced-facts.ts:363` | `heldFenceFactRows` | 2 | 2 | facts | new | `listHeldFenceFactRows` | held fence facts for a page |
| `core/facts/withdrawal.ts:84` | `planFactWithdrawal` | 6 | 2 | facts, pages | new | `listWithdrawalSlugs` | facts slugs by fingerprint and visibility |
| `core/facts/withdrawal.ts:141` | `<anonymous>` | 2 | 2 | facts | new | `expireFactsByWithdrawal` | facts expiry by fingerprint; expireFact is per id |
| `core/fence-repair/import-step.ts:38` | `storedFenceRows` | 2 | 2 | facts | new | `listStoredFenceFactRows` | facts row_num and fact for a markdown slug |
| `core/persistence/loop-fact-retirement.ts:186` | `loopFactDrift` | 4 | 3 | facts, open_loops | new | `loopFactDrift` | open loops joined to facts |
| `core/persistence/loop-fact-retirement.ts:198` | `closedLoopWithActiveFact` | 1 | 1 | facts, open_loops | new | `closedLoopWithActiveFact` | loop status joined to fact |
| `core/repair/agent-session-facts.ts:258` | `classifyAgentSessionFacts` | 4 | 3 | facts | new | `listSessionFactsForClassification` | fact rows with session fields |
| `core/repair/captured-facts.ts:173` | `classifyCapturedFacts` | 4 | 3 | facts | new | `listCapturedFactsForClassification` | facts with fingerprint; no member |
| `core/repair/conversation-labels.ts:430` | `countLabelFacts` | 4 | 3 | facts, pages | new | `countLabelFacts` | counts facts on live pages |
| `core/repair/extractor-facts.ts:126` | `classifyExtractorFacts` | 4 | 3 | facts | new | `listExtractorFactsForClassification` | extractor facts with expiry state |
| `core/repair/purged-page-facts.ts:111` | `countPurgedPageFacts` | 4 | 3 | facts | new | `countPurgedPageFacts` | facts of purged pages |
| `core/repair/unwithdrawn-facts.ts:102` | `classifyUnwithdrawnFacts` | 4 | 3 |  | new | `listUnwithdrawnFacts` | retired facts via withdrawal preimages |
| `core/repair/visibility.ts:220` | `worldFactsFromPrivateSources` | 6 | 4 |  | new | `listWorldFactsFromPrivateSources` | facts joined to pages; visibility check |
| `core/search/fact-relevance.ts:239` | `<anonymous>` | 3 | 3 | facts | new | `listFactsForRelevance` | facts with tsvector rank |
| `core/search/fact-relevance.ts:314` | `<anonymous>` | 2 | 2 | facts | new | `listFactsForRelevance` | facts keyed read; same as row 90 |
| `core/search/saved-facts-match.ts:143` | `matchingSavedFacts` | 3 | 3 |  | new | `matchSavedFacts` | saved-fact tsquery matches |
| `core/trust/owner-actions.ts:137` | `readFactTarget` | 1 | 1 | facts | new | `readFactForOwnerAction` | one fact row with many fields |
| `core/trust/review.ts:174` | `standingPreferences` | 1 | 1 | facts | new | `listStandingPreferences` | preference and commitment facts |
| `core/trust/supersede-handlers.ts:59` | `lexicalContestCandidate` | 4 | 2 | facts | new | `listLexicalContestCandidates` | live facts with kind and visibility |
| `core/trust/supersede-handlers.ts:84` | `restatedPrivateCopy` | 4 | 2 | facts | new | `listRestatedPrivateCopies` | private copies of world fact |
| `core/trust/taint.ts:234` | `readDerivedTaintShare` | 8 | 1 | facts | new | `readDerivedTaintShare` | counts of derived facts by tier |
| `core/verbs/entity-card.ts:663` | `assembleCard` | 4 | 4 | facts, pages | new | `countWorldFacts` | world facts count for entity |

### 6. Doctor catalog probes and one-off health SQL (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/atom-retirements.ts:20` | `atomRetirementsRestorableCheck` | 4 | 3 |  | new | `countRetirementsBySource` | Retirement join; tables unparsed |
| `commands/doctor/checks/atom-retirements.ts:26` | `atomRetirementsRestorableCheck` | 4 | 3 |  | new | `countRestorableRetirements` | Nested retirement CTE; tables unparsed |
| `commands/doctor/checks/core-health.ts:143` | `pgvectorCheck` | 2 | 1 | pg_extension | new | `hasPgvectorExtension` | pg_extension probe; Rust no-op candidate |
| `commands/doctor/checks/core-health.ts:270` | `jsonbIntegrityCheck` | 16 | 1 |  | new | `tableExists` | to_regclass probe; Rust no-op candidate |
| `commands/doctor/checks/edge-validity.ts:34` | `edgeValidityStats` | 2 | 1 | link_relationships | new | `tableExists` | to_regclass probe; Rust no-op candidate |
| `commands/doctor/checks/embedding-health.ts:331` | `runEmbeddingColumnRegistry` | 2 | 1 | pg_attribute, pg_class, pg_namespace | new | `listColumnFormatTypes` | pg_attribute probe; Rust no-op candidate |
| `commands/doctor/checks/extraction-sync.ts:1004` | `computeExtractHealthCheck` | 2 | 1 |  | new | `sumExtractionCostByKind` | Cost and eval sums; tables unparsed |
| `commands/doctor/checks/function-search-path.ts:24` | `functionSearchPathProblems` | 2 | 1 | pg_namespace, pg_proc | new | `functionSearchPathProblems` | pg_proc probe; Rust no-op candidate |
| `commands/doctor/checks/graph-embedding.ts:157` | `checkBrainstormHealth` | 2 | 1 | information_schema.columns | new | `columnExists` | information_schema probe; Rust no-op candidate |
| `commands/doctor/checks/graph-embedding.ts:219` | `checkBrainstormHealth` | 2 | 1 | calibration_profiles | new | `readActiveBiasTags` | Latest calibration profile tags |
| `commands/doctor/checks/managed-guard.ts:57` | `checkManagedGuardSchemaDrift` | 2 | 1 | information_schema.columns | new | `listManagedGuardColumns` | information_schema probe; Rust no-op candidate |
| `commands/doctor/checks/mcp-request-log.ts:43` | `mcpRequestLogRetentionResult` | 2 | 1 |  | new | `relationSizeBytes` | pg_total_relation_size probe; Rust no-op candidate |
| `commands/doctor/checks/mcp-request-log.ts:46` | `mcpRequestLogRetentionResult` | 2 | 1 | mcp_request_log | new | `countMcpRequestLogRows` | Bounded request log row count |
| `commands/doctor/checks/owner-host-stale.ts:21` | `ownerHostStaleCheck` | 2 | 1 | public.persistence_requests, public.persistence_worktrees | new | `tableExists` | to_regclass probe; Rust no-op candidate |
| `commands/doctor/checks/queue-assets.ts:45` | `runQueueHealth` | 3 | 2 | information_schema.tables | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `commands/doctor/checks/schema-function-bodies.ts:34` | `schemaFunctionBodyDrift` | 2 | 1 | pg_namespace, pg_proc | new | `functionBodyDrift` | pg_proc probe; Rust no-op candidate |
| `commands/doctor/checks/unlinked-facts.ts:78` | `unlinkedFactsStats` | 2 | 1 | fact_relink_attempts, facts | new | `tableExists` | to_regclass probe; Rust no-op candidate |
| `commands/doctor/checks/wakeshift.ts:41` | `runWakeshiftCheck` | 2 | 1 | wake_forgets | new | `countPendingWakeForgets` | wake_forgets not in any family |
| `commands/migrations/v0_14_0.ts:58` | `phaseASchema` | 1 | 1 | information_schema.columns | new | `readColumnDefault` | Postgres catalog probe; Rust no-op candidate |
| `commands/migrations/v0_16_0.ts:54` | `phaseBVerify` | 1 | 1 | information_schema.tables | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `commands/migrations/v0_18_0.ts:132` | `phaseCVerify` | 1 | 1 | sources | existing | `getSource` | default source row; reads more |
| `commands/migrations/v0_18_0.ts:145` | `phaseCVerify` | 1 | 1 | pg_constraint | new | `constraintExists` | Postgres catalog probe; Rust no-op candidate |
| `commands/migrations/v0_28_0.ts:75` | `phaseASchema` | 1 | 1 | pg_tables | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `commands/migrations/v0_31_0.ts:57` | `phaseASchema` | 1 | 1 | pg_tables | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `commands/migrations/v0_32_2.ts:97` | `phaseASchema` | 1 | 1 | information_schema.columns | new | `readColumnNames` | Postgres catalog probe; Rust no-op candidate |
| `core/facts/purge-verify.ts:214` | `<anonymous>` | 36 | 1 |  | new | `setStatementTimeout` | set_config statement timeout; Postgres catalog probe; Rust no-op candidate |
| `core/fence-repair/census.ts:104` | `passHorizon` | 12 | 5 | pg_stat_activity | new | `probeOldestXactAge` | pg_stat_activity probe; Postgres catalog probe; Rust no-op candidate |
| `core/link-source-check-repair.ts:56` | `checkLinkSourceCheck` | 13 | 2 | links | new | `probeLinksTable` | to_regclass links probe; Postgres catalog probe; Rust no-op candidate |
| `core/link-source-check-repair.ts:60` | `checkLinkSourceCheck` | 13 | 2 | links, pg_constraint | new | `probeLinkSourceConstraint` | pg_constraint probe; Postgres catalog probe; Rust no-op candidate |
| `core/onboard/checks.ts:168` | `sampleVisibleEntityCoverage` | 8 | 3 | pages | new | `sampleVisibleEntityCoverage` | sampled entity visibility coverage |
| `core/onboard/checks.ts:698` | `checkTypeProliferation` | 4 | 3 | pages, pairs | new | `countPageTypePairs` | recursive distinct type pairs |
| `core/schema-missing-tables.ts:95` | `readMissingTables` | 3 | 2 |  | new | `listMissingRelations` | to_regclass missing relations; Postgres catalog probe; Rust no-op candidate |
| `core/schema-verify.ts:155` | `getActualColumns` | 3 | 2 | information_schema.columns | new | `listActualColumns` | information_schema columns; Postgres catalog probe; Rust no-op candidate |
| `core/schema-verify.ts:171` | `getActualTables` | 3 | 2 | information_schema.tables | new | `listActualTables` | information_schema tables; Postgres catalog probe; Rust no-op candidate |
| `core/trust/backfill.ts:118` | `readColumns` | 2 | 1 | information_schema.columns | new | `listTableColumns` | Postgres catalog probe; Rust no-op candidate |
| `core/trust/provenance-drift.ts:165` | `columnsOf` | 4 | 1 | information_schema.columns | new | `listTableColumns` | Postgres catalog probe; Rust no-op candidate |

### 7. Source rows, local paths, routing, source config (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/agent-session-facts.ts:16` | `agentSessionFactsCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/atom-fence-rows.ts:19` | `atomFenceRowsCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/atom-retirements.ts:19` | `atomRetirementsRestorableCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/captured-facts.ts:16` | `capturedFactsCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/consolidation-cycle.ts:51` | `checkSyncConsolidation` | 2 | 1 | sources | new | `listLocalPathSourcesNoStorage` | Local path minus storage; no member |
| `commands/doctor/checks/conversation-outcomes.ts:25` | `conversationOutcomesStaleCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/conversation-outcomes.ts:74` | `conversationLabelFactsCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/core-health.ts:604` | `checkSourceConfigShape` | 2 | 1 | sources | new | `listNonObjectSourceConfigs` | Sources with non-object config |
| `commands/doctor/checks/db-ahead-of-git.ts:67` | `runDbAheadOfGit` | 2 | 1 | sources | existing | `listAllSources` | Same ids plus local_path; reads more |
| `commands/doctor/checks/default-source-path.ts:32` | `relativeSources` | 2 | 1 | sources | new | `listNonDefaultLocalPathSources` | Non-default local path; no member |
| `commands/doctor/checks/default-source-path.ts:53` | `defaultSourceLocalPathCheck` | 2 | 1 | sources | existing | `getSource` | Reads full row; returns local_path for default |
| `commands/doctor/checks/derived-visibility.ts:31` | `derivedVisibilityCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/entity-duplicates.ts:44` | `runPersonTitleDuplicates` | 2 | 1 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/extraction-sync.ts:381` | `checkUndeclaredDbOnlyPages` | 2 | 1 | sources | new | `listUndeclaredLocalSources` | Local-path sources with config |
| `commands/doctor/checks/extractor-facts.ts:15` | `extractorFactsCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/frontmatter-hook.ts:10` | `outdatedFrontmatterHooks` | 5 | 3 | sources | new | `listFrontmatterHookSources` | Sources with local path, id filter |
| `commands/doctor/checks/frontmatter-keys.ts:16` | `staleFrontmatterKeysCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/generations.ts:29` | `activeSources` | 12 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/git-convergence.ts:174` | `sourceRoots` | 8 | 1 | sources | new | `listSourceRootsForGit` | Close to localPathOnly; lacks role filter |
| `commands/doctor/checks/git-index-lag.ts:33` | `runGitIndexLag` | 2 | 1 | sources | new | `listGitCanonicalSourcesWithCommit` | Git-canonical sources with last commit |
| `commands/doctor/checks/google-api-access.ts:17` | `googleApiAccessCheck` | 4 | 3 | sources | new | `listGoogleSources` | Sources filtered by config kind |
| `commands/doctor/checks/google-calendar.ts:18` | `googleCalendarReadableCheck` | 4 | 3 | sources | new | `listGoogleSources` | Sources filtered by config kind |
| `commands/doctor/checks/image-embedding-coverage.ts:26` | `imageEmbeddingCoverageCheck` | 2 | 1 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/local-audits.ts:571` | `runDefaultSourcePath` | 2 | 1 | sources | existing | `listSourceRecords` | Same ids plus local_path; reads more |
| `commands/doctor/checks/loop-facts.ts:12` | `loopFactsDriftCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/maintenance-drift.ts:37` | `maintenanceWriteDriftCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/memory-writeback.ts:132` | `corpusSourceHoldProblem` | 2 | 1 | sources | new | `listFirstTwoSourceIds` | Two source ids; no member |
| `commands/doctor/checks/missing-recorded-files.ts:24` | `runMissingRecordedFiles` | 2 | 1 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/ontology-facts.ts:14` | `ontologyFactsCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/overwritten-edits.ts:22` | `runOverwrittenEdits` | 2 | 1 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/persistence-requests.ts:251` | `lostCallerWritesCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/provenance-stamp-drift.ts:20` | `runProvenanceStampDrift` | 2 | 1 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/purged-page-facts.ts:14` | `purgedPageFactsCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/routing-federation.ts:46` | `checkSourceRoutingHealth` | 2 | 1 | sources | existing | `listSourceRoutingRows` | Reads more; includes archived and default rows |
| `commands/doctor/checks/rows-behind.ts:34` | `runRowsBehind` | 2 | 1 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/shared-skills.ts:16` | `checkSharedSkillsSources` | 2 | 1 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/slug-collisions.ts:22` | `slugCollisionsCheck` | 2 | 1 | sources | new | `listLocalPathSourcesWithConfig` | Local-path sources with config |
| `commands/doctor/checks/storage-manifest.ts:26` | `storageManifestCheck` | 2 | 1 | sources | new | `getActiveSourceRow` | getSource ignores archived filter |
| `commands/doctor/checks/strict-facts-outside-git.ts:30` | `runStrictFactsOutsideGit` | 2 | 1 | sources | new | `listGitCanonicalSources` | Git-canonical source ids |
| `commands/doctor/checks/sync-failures.ts:35` | `checkRecordedSyncFailures` | 3 | 2 | sources | new | `listSourcePathStates` | Sources with local path and archived |
| `commands/doctor/checks/timeline-history.ts:73` | `timelineHistoryCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/transcript-archive.ts:85` | `checkTranscriptArchiveFreshness` | 2 | 1 | sources | new | `readOldestSourceCreatedAt` | Min created_at computed in SQL |
| `commands/doctor/checks/uncommitted-sync-deletions.ts:26` | `runUncommittedSyncDeletions` | 2 | 1 | sources | existing | `listAllSources` | Same ids (not archived); reads more |
| `commands/doctor/checks/unlinked-facts.ts:82` | `unlinkedFactsStats` | 2 | 1 | sources | existing | `listAllSources` | Same ids incl. archived; reads more |
| `commands/doctor/checks/unwithdrawn-facts.ts:13` | `unwithdrawnFactsCheck` | 4 | 3 | sources | existing | `listAllSources` | Same ids; reads more; default-first order |
| `commands/doctor/checks/vector-coverage.ts:43` | `runFactTakeVectors` | 2 | 1 | sources | existing | `listAllSources` | Same ids (not archived); reads more |
| `commands/orphans.ts:68` | `loadConnectorSourceIds` | 4 | 4 | sources | existing | `listAllSources` | source ids and kind; reads more |
| `commands/status.ts:504` | `<anonymous>` | 1 | 1 | sources | existing | `listAllSources` | includeArchived true; reads more: config and path |
| `commands/sync/connector.ts:16` | `runConnectorSync` | 3 | 3 | sources | existing | `getSource` | source local_path and config; reads more |
| `commands/sync/holds.ts:78` | `openLegacyHolds` | 3 | 3 | sources | existing | `readSourceIncarnation` | incarnation and config; same row |
| `commands/sync/plain-directory.ts:36` | `plainDirectorySyncRoot` | 6 | 3 | sources | new | `getSyncableSource` | like getSource but excludes archived |
| `commands/sync/preflight.ts:406` | `validateSourceRepoState` | 3 | 3 | sources | existing | `getSource` | source row for preflight; reads more |
| `commands/upgrade.ts:1028` | `runPostUpgrade` | 1 | 1 | sources | existing | `listAllSources` | localPathOnly non-archived; reads more: config |
| `core/advisor/collect-stalled-jobs.ts:50` | `<anonymous>` | 3 | 3 | sources | existing | `listAllSources` | reads more; caller filters last_sync_at age |
| `core/brain-writer.ts:1021` | `listSources` | 6 | 4 | sources | new | `listLocalPathSourcesWithKind` | listLocalPathSources may cover; kind unverified |
| `core/company-brain/status.ts:16` | `readCompanyBrainSourceStatus` | 1 | 1 | sources | existing | `readSourceIncarnation` | incarnation and config; same row |
| `core/connectors/item-holds-store.ts:77` | `readAllSourceHolds` | 4 | 3 | sources | existing | `listAllSources` | reads more: non-archived with local path; caller filters kind |
| `core/cycle/chronicle.ts:158` | `runPhaseChronicle` | 1 | 1 | sources | existing | `listAllSources` | reads more: id only; non-archived |
| `core/facts/purge-verify.ts:442` | `pageFilePaths` | 1 | 1 | sources | existing | `getSource` | reads more: full row; only local_path used |
| `core/facts/unfenced-facts.ts:296` | `planUnfencedFacts` | 5 | 3 | sources | existing | `listSourceRoutingRows` | reads more: adds default_has_pages column |
| `core/fence-repair/census.ts:94` | `censusSources` | 11 | 5 | sources | new | `listCensusSources` | sources with incarnation for census |
| `core/fence-repair/repair-io.ts:84` | `loadFenceSource` | 6 | 3 | sources | new | `getActiveSourceRow` | active source id, incarnation and local_path |
| `core/ghost-pages.ts:283` | `readGhostPages` | 2 | 1 | sources | existing | `listAllSources` | reads more; caller filters ghost check |
| `core/google/file-modes.ts:76` | `scanGoogleFileModes` | 5 | 3 | sources | existing | `listAllSources` | reads more; caller filters google kind |
| `core/guests/sources.ts:56` | `planGuestSource` | 1 | 1 | sources | existing | `getSource` | reads more; guest flag derived from config |
| `core/mentions/stale.ts:31` | `<anonymous>` | 3 | 2 | sources | existing | `listAllSources` | lists source ids; reads more columns |
| `core/ops/loops.ts:48` | `sourceHasGoogleContent` | 2 | 2 | sources | existing | `getSource` | reads more: full row; config used |
| `core/ops/loops.ts:74` | `googleSourceFreshness` | 3 | 3 | sources | existing | `listAllSources` | reads more: name, local_path; caller filters google |
| `core/ops/page-upload.ts:187` | `<anonymous>` | 1 | 1 | sources | new | `sourceArchiveState` | archived flag; readSourceIncarnation lacks it |
| `core/ops/skills-catalog.ts:358` | `<anonymous>` | 1 | 1 | sources | existing | `listAllSources` | non-archived sources; reads more: last_sync_at |
| `core/ops/storage-manifest.ts:37` | `shelfExists` | 7 | 7 | sources | new | `sourceIsActive` | existence of non-archived source; no member |
| `core/questions/service.ts:78` | `parseScope` | 1 | 1 | sources | new | `sourceIsActive` | same member as row 98; active source check |
| `core/remediation/context.ts:28` | `staleExtractionBlocked` | 3 | 3 | sources | existing | `listAllSources` | non-archived source ids; reads more |
| `core/remediation/context.ts:44` | `firstSourceLocalPath` | 3 | 3 | sources | existing | `listLocalPathSources` | first local path; caller takes first; verify order |
| `core/repair/core.ts:291` | `resolveRepairScope` | 5 | 4 | sources | existing | `listAllSources` | reads more: full source rows, filtered to live |
| `core/repair/fences.ts:353` | `plan` | 3 | 3 | sources | new | `listSourceIncarnations` | plural incarnation read; singular exists |
| `core/repair/frontmatter.ts:199` | `sourceRoots` | 1 | 1 | sources | new | `listSourceRootsByIds` | sources id, incarnation, local_path |
| `core/repair/frontmatter.ts:479` | `plan` | 1 | 1 | sources | new | `listSourceIncarnations` | plural incarnation read; singular exists |
| `core/repair/slug-conflicts.ts:511` | `plan` | 3 | 3 | sources | new | `listSourceIncarnations` | plural incarnation read; singular exists |
| `core/restore-target.ts:45` | `resolveRestoreTarget` | 1 | 1 | sources | existing | `getSource` | reads more; local_path used |
| `core/source-default-search.ts:39` | `withDefaultSearchChoice` | 2 | 2 | sources | existing | `getSource` | checks local_path null; reads more |
| `core/source-health.ts:473` | `loadSyncFreshnessSources` | 2 | 1 | sources | new | `listSyncFreshnessSources` | sources with sync and upstream columns |
| `core/sources-load.ts:266` | `fetchSource` | 12 | 12 | sources | new | `getSourceRecord` | listSourceRecords has same columns but all rows |
| `core/sources-ops.ts:299` | `fetchSourceRow` | 4 | 4 | sources | existing | `getSource` | reads more: full row; id and local_path used |
| `core/sources-ops.ts:391` | `assertNoOverlappingPath` | 2 | 2 | sources | existing | `listLocalPathSources` | reads more: all local-path sources; caller filters id |
| `core/sources-ops.ts:516` | `addSource` | 2 | 2 | sources | existing | `getSource` | reads more: full row; id and local_path used |
| `core/sources-ops.ts:768` | `addSource` | 2 | 2 | sources | new | `insertSource` | sources insert write; no member |
| `core/sources-ops.ts:904` | `listSources` | 4 | 4 | sources | existing | `listAllSources` | same rows and default-first order; reads more |
| `core/sources-ops.ts:1081` | `getSourceStatus` | 1 | 1 | sources | new | `sourceArchiveState` | archived flag by source id |
| `core/storage-manifest/door.ts:36` | `isStorageManifestSource` | 1 | 1 | sources | existing | `getSource` | role config check; reads more |
| `core/sync-anchor.ts:33` | `readSyncAnchor` | 6 | 3 | sources | existing | `getSource` | last_commit read; reads more columns |
| `core/sync-anchor.ts:405` | `readSlugRootMode` | 3 | 3 | sources | existing | `getSource` | slug_root_mode config key; reads more |
| `core/sync-applicability.ts:45` | `ownedByContentReceipt` | 6 | 3 | sources | existing | `readSourceIncarnation` | incarnation only; same row |
| `core/sync-status-report.ts:118` | `buildSyncStatusReport` | 2 | 2 | sources | existing | `listSourceRecords` | reads all sources; caller filters ids |
| `core/sync-upstream-rewrite.ts:116` | `readSourceConfig` | 3 | 3 | sources | existing | `getSource` | reads more: full row; config used |
| `core/sync-upstream-rewrite.ts:183` | `readUpstreamDivergences` | 4 | 3 | sources | existing | `listAllSources` | reads more; caller filters divergence config |
| `core/transcripts/archive.ts:277` | `effectiveSource` | 3 | 2 | sources | existing | `getSource` | reads more: full row; local_path used |
| `core/url-source-origin.ts:55` | `urlSourcesWithoutOrigin` | 4 | 3 | sources | existing | `listAllSources` | localPathOnly non-archived; reads more: config |
| `core/write-through.ts:381` | `resolvePageWriteTarget` | 3 | 3 | sources | existing | `getSource` | local_path only; reads more |

### 8. Page body storage, uploads and projections (Lane 3)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/calibration.ts:280` | `checkLinkResolutionOpportunity` | 2 | 1 | pages | new | `listRecentPageBodies` | Newest 1000 page bodies and timelines |
| `commands/doctor/checks/calibration.ts:285` | `checkLinkResolutionOpportunity` | 2 | 1 | pages | new | `countRecentBodyStorage` | Body storage count over newest pages |
| `commands/doctor/checks/content-quality.ts:62` | `runContentSanity` | 2 | 1 | pages | new | `listOversizedPages` | Oversized page byte sizes |
| `commands/doctor/checks/content-quality.ts:84` | `runContentSanity` | 2 | 1 | pages | new | `countSegmentedPages` | Live segmented page count |
| `commands/doctor/checks/content-quality.ts:130` | `runContentSanity` | 2 | 1 | pages | new | `listContentSanityPages` | Page bodies for content sanity |
| `commands/doctor/checks/content-quality.ts:152` | `runContentSanity` | 2 | 1 | pages | new | `countRecentBodyStorage` | Body storage count over newest pages |
| `commands/doctor/checks/derivation-pricing.ts:21` | `runDerivationUnpricedModelCheck` | 2 | 1 | page_segment_derivations, pages | new | `listUnpricedDerivationModels` | Derivation models with no pricing |
| `commands/doctor/checks/derivation-purge-sweeps.ts:21` | `runDerivationPurgeSweeps` | 2 | 1 | page_segment_derivation_purges, persistence_requests | new | `listDerivationPurgeSweeps` | Segment derivation purge rows |
| `commands/doctor/checks/facts-pages.ts:25` | `factsUndatedLines` | 2 | 1 | pages | new | `listUndatedFactPageBodies` | Page bodies scanned for undated lines |
| `commands/doctor/checks/fence-integrity.ts:192` | `fenceIntegrityResult` | 4 | 3 | pages | new | `countSegmentedFencePages` | Segmented page fence integrity; pages |
| `core/facts/purge-verify.ts:88` | `segmentedProse` | 1 | 1 | page_versions, pages | new | `listSegmentedProseVersions` | segmented page_versions for prose check |
| `core/facts/purge.ts:132` | `stagingsWithClaimAcrossParts` | 1 | 1 | greatest, page_body_staging_parts, page_body_stagings | new | `listStagingsWithClaimParts` | page_body_stagings part head and tail scan |
| `core/facts/purge.ts:158` | `stagingsHoldingClaim` | 1 | 1 | page_body_manifest, page_body_stagings, page_segment_texts | new | `listStagingsHoldingClaim` | page_body_stagings holding claim ids |
| `core/facts/withdrawal-discovery.ts:81` | `splitFactsFences` | 7 | 3 | page_body_manifest, pages | new | `splitFactsFenceRegions` | manifest spans with pages; fence split |
| `core/facts/withdrawal-discovery.ts:171` | `discoverWithdrawalTargets` | 7 | 3 | page_body_manifest | new | `listSegmentWithdrawalSpans` | segment spans from page_body_manifest |
| `core/facts/withdrawal.ts:153` | `<anonymous>` | 2 | 2 | pages | new | `listSegmentedPagesBySlugs` | pages filtered to body_storage segmented |
| `core/oversized-backfill.ts:87` | `listCandidates` | 1 | 1 | pages | new | `listOversizedCandidates` | oversized candidate pages |
| `core/oversized-backfill.ts:95` | `countMarked` | 2 | 2 |  | new | `countOversizedPages` | count of oversized page bodies |
| `core/page-body/body-tiling.ts:99` | `untiledSegmentedPages` | 4 | 3 | pages, sources | new | `listUntiledSegmentedPages` | segmented pages with tile gaps |
| `core/page-body/projection.ts:235` | `rebuildPendingSegmentedProjections` | 41 | 32 | page_projection_jobs, pages, sources | new | `listPendingBodyProjections` | pending projection jobs with revisions |
| `core/page-body/tail-digest.ts:35` | `inlineRegions` | 2 | 2 | pages | new | `readPageBodyRegions` | compiled truth and timeline by id |
| `core/persistence/journal.ts:1198` | `sweepSegmentStorage` | 32 | 32 | page_body_stagings, page_segment_texts | new | `segmentStorageInUse` | existence probe on staging and segment tables |
| `core/persistence/page-upload.ts:139` | `readUpload` | 4 | 4 |  | new | `readUploadRow` | staging row by id |
| `core/persistence/page-upload.ts:144` | `readUploadByRequest` | 1 | 1 |  | new | `readUploadByRequest` | staging row by client request id |
| `core/persistence/page-upload.ts:156` | `transitionUploads` | 1 | 1 | page_body_stagings | new | `transitionUploads` | UPDATE staging state to expired or aborted |
| `core/persistence/page-upload.ts:211` | `<anonymous>` | 1 | 1 | page_body_stagings | new | `openBodyStaging` | INSERT staging row in upload tx |
| `core/repair/frontmatter.ts:247` | `reportSkippedSegmented` | 1 | 1 | pages | new | `countSegmentedSourcePaths` | counts segmented pages with source path |

### 9. Journal request writes and planner settings inside transactions (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/export.ts:113` | `<anonymous>` | 1 | 1 |  | new | `readOnlySnapshotTx` | transaction isolation control; transactions family |
| `commands/export.ts:114` | `<anonymous>` | 1 | 1 |  | new | `setStatementTimeoutLocal` | transaction-local timeout; transactions family |
| `core/belief/state.ts:117` | `readBeliefState` | 1 | 1 |  | new | `setPlannerSettingLocal` | transaction-local plan cache mode |
| `core/persistence/context.ts:73` | `withCoordinatedWrite` | 31 | 31 |  | new | `withCoordinatedWrite` | session write settings per coordinated write |
| `core/persistence/context.ts:134` | `currentWriteTrust` | 2 | 2 |  | new | `currentWriteTrust` | session trust tier read; trust writers too |
| `core/persistence/coordinator.ts:619` | `<anonymous>` | 30 | 30 | persistence_requests | new | `lockWriteRequest` | write pipeline; coordinator FOR UPDATE request row |
| `core/persistence/core-guard.ts:48` | `lockCoreSources` | 1 | 1 | sources | new | `lockCoreSources` | core source FOR UPDATE lock |
| `core/persistence/effect-journal.ts:69` | `queuePublicationEffects` | 23 | 23 | persistence_effects | new | `queuePublicationEffects` | write pipeline; effect enqueue inside write tx |
| `core/persistence/journal.ts:330` | `<anonymous>` | 31 | 31 | sources | new | `lockSourceForAdmission` | FOR SHARE source lock during admission |
| `core/persistence/journal.ts:371` | `<anonymous>` | 31 | 31 | persistence_counters, persistence_requests | new | `reserveWriteBudget` | reserve counters and insert request row |
| `core/persistence/journal.ts:1050` | `completeWrite` | 2 | 2 |  | new | `setSynchronousCommit` | synchronous_commit setting in completion tx; non-pipeline callers too |
| `core/persistence/journal.ts:1053` | `completeWrite` | 2 | 2 | persistence_requests | new | `lockWriteRequest` | FOR UPDATE request row in completion; non-pipeline callers too |
| `core/persistence/journal.ts:1074` | `completeWrite` | 32 | 32 | persistence_effects, persistence_requests | new | `completeWrite` | terminal step; also called by recovery and control paths |
| `core/persistence/page-mutations.ts:417` | `<anonymous>` | 28 | 28 | pg_catalog.pg_policy | new | `pageAdmissionSource` | write pipeline; putPage admission source read |
| `core/persistence/page-purge.ts:530` | `<anonymous>` | 1 | 1 | sources | new | `lockSourceForPurge` | FOR UPDATE source lock in unpurge |
| `core/persistence/page-upload.ts:199` | `<anonymous>` | 1 | 1 | persistence_counters | new | `ensurePersistenceCounters` | INSERT counter rows in upload tx |
| `core/persistence/page-upload.ts:200` | `<anonymous>` | 1 | 1 | persistence_counters | new | `lockCounters` | FOR UPDATE counter rows in upload tx |
| `core/persistence/page-upload.ts:218` | `<anonymous>` | 1 | 1 | persistence_counters | new | `setUploadIntentBytes` | UPDATE counter intent bytes in tx |
| `core/persistence/protocol.ts:25` | `declarePersistenceProtocol` | 153 | 33 | persistence_brain | new | `declarePersistenceProtocol` | session protocol settings; several callers |
| `core/persistence/protocol.ts:41` | `declareDurablePersistence` | 62 | 32 | persistence_brain | new | `declareDurablePersistence` | session durability settings in journal tx |
| `core/repair/attribution-backfill.ts:39` | `<anonymous>` | 6 | 2 |  | new | `readPlannerSetting` | session setting read; Rust no-op candidate |
| `core/repair/attribution-backfill.ts:40` | `<anonymous>` | 6 | 2 |  | new | `setPlannerSettingLocal` | transaction-local setting; Rust no-op candidate |
| `core/repair/attribution-backfill.ts:43` | `<anonymous>` | 6 | 2 |  | new | `setPlannerSettingLocal` | transaction-local setting; Rust no-op candidate |
| `core/search/fact-relevance.ts:238` | `<anonymous>` | 3 | 3 |  | new | `setPlannerSettingLocal` | transaction-local plan cache mode |

### 10. Link, edge and relationship queries (Lane 6)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/edge-validity.ts:37` | `edgeValidityStats` | 2 | 1 | link_relationships | new | `countEdgeValidityStatus` | link_relationships; no family |
| `commands/doctor/checks/edge-validity.ts:40` | `edgeValidityStats` | 2 | 1 | link_relationships, pages | new | `listEdgeValidityRows` | link_relationships with page slugs |
| `commands/doctor/checks/edge-validity.ts:50` | `edgeValidityStats` | 2 | 1 | link_edge_proposals | new | `countLinkEdgeProposals` | link_edge_proposals; no family |
| `commands/doctor/checks/graph-embedding.ts:80` | `checkGraphSignalsCoverage` | 2 | 1 | pages | new | `countLivePages` | Live page count; countPagesBy lacks this shape |
| `commands/doctor/checks/graph-embedding.ts:91` | `checkGraphSignalsCoverage` | 2 | 1 | links, pages | new | `countLinkedLivePages` | Distinct linked live pages |
| `commands/doctor/checks/graph-embedding.ts:467` | `checkJunkEntityHubs` | 2 | 1 | links | new | `listJunkEntityHubs` | High-degree hub edge counts |
| `commands/doctor/checks/graph-health.ts:49` | `runGraphCoverage` | 2 | 1 | pages | new | `countEligibleGraphPages` | Graph-eligible pages by type |
| `commands/doctor/checks/graph-health.ts:75` | `runGraphCoverage` | 2 | 1 | pages | new | `listEligibleGraphPageIds` | Eligible page ids with links |
| `commands/doctor/checks/graph-health.ts:186` | `runOrphanRatio` | 2 | 1 | pages | new | `countLivePagesOfTypes` | Orphan ratio pages by type |
| `commands/graph-query.ts:157` | `countForeignEdges` | 1 | 1 | links, pages | new | `countForeignEdges` | links crossing sources; count |
| `commands/orphans.ts:176` | `findOrphans` | 4 | 4 | pages | new | `listLivePagesForOrphanDenominator` | all live pages with type and quarantine; not orphans only |
| `core/derived-links.ts:328` | `publishDerivedLinks` | 3 | 3 | links | new | `updateLinkContexts` | UPDATE link context and origin |
| `core/link-relationship-notes.ts:68` | `loadRelationshipNotes` | 5 | 5 | link_transitions, pages | new | `loadRelationshipNotes` | relationship notes with transitions |
| `core/link-relationships.ts:200` | `staleRelationshipKeys` | 2 | 1 | links | new | `listStaleRelationshipKeys` | stale link relationship keys |
| `core/link-relationships.ts:215` | `staleRelationshipKeys` | 2 | 1 | link_relationships, links, pages | new | `listStaleRelationshipKeys` | stale link relationship keys |
| `core/link-relationships.ts:223` | `staleRelationshipKeys` | 2 | 1 | link, link_relationships, links | new | `listStaleRelationshipKeys` | stale relationship keys by scope |
| `core/link-temporal-apply.ts:160` | `removeManualTransitions` | 2 | 2 | link_transitions | new | `removeManualLinkTransitions` | DELETE manual link transitions |
| `core/mentions/referrers.ts:233` | `readReferrerGroups` | 2 | 2 | links, pages | new | `readReferrerGroups` | grouped inbound links by referrer |
| `core/persistence/links-preparation.ts:131` | `prepareAutomaticLinks` | 12 | 12 | own, pages | new | `listOwnPageLinkTargets` | automatic link targets; several callers |
| `core/verbs/entity-card.ts:636` | `assembleCard` | 4 | 4 | links, pages | new | `countInboundLinks` | inbound link count by target |

### 11. Chunk, code-reference and readiness queries (Lane 6)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/code-def.ts:65` | `findCodeDef` | 2 | 2 | content_chunks, pages | new | `findCodeDefinitions` | code definitions by symbol |
| `commands/code-def.ts:124` | `probeFilteredSymbolTypes` | 1 | 1 | content_chunks, pages, sources | new | `listSymbolTypesForName` | distinct symbol types for name |
| `commands/code-refs.ts:54` | `findCodeRefs` | 1 | 1 | content_chunks, pages | new | `findCodeRefChunks` | code chunks with file refs |
| `commands/doctor/checks/content-quality.ts:77` | `runContentSanity` | 2 | 1 | content_chunks, pages | new | `countOversizedEmbedSkips` | Oversized embed skips with chunk gap |
| `commands/doctor/checks/core-health.ts:482` | `childTableOrphansCheck` | 20 | 1 | content_chunks, pages | new | `countOrphanChunks` | Chunks whose page is missing |
| `commands/doctor/checks/extraction-sync.ts:306` | `checkCodeChunkMetadata` | 2 | 1 | content_chunks, pages | new | `countCodeChunkPages` | Code chunk and page counts |
| `core/code-graph-readiness.ts:30` | `codeChunksExist` | 4 | 2 | content_chunks, pages, sources | new | `codeChunksExist` | code chunk existence; no current filter |
| `core/code-graph-readiness.ts:49` | `currentChunksExist` | 14 | 8 | content_chunks, pages, sources | new | `currentCodeChunksExist` | code chunk existence for source |
| `core/code-intel/recursive-walk.ts:90` | `disambiguateSymbol` | 2 | 2 | content_chunks, pages, sources | new | `listQualifiedSymbolNames` | same member as row 179 |
| `core/code-intel/recursive-walk.ts:105` | `disambiguateSymbol` | 2 | 2 | content_chunks, pages, sources | new | `listQualifiedSymbolNames` | distinct qualified symbol names; chunks |
| `core/context/volunteer-events.ts:199` | `insertVolunteerEvents` | 2 | 2 | context_volunteer_events | new | `insertVolunteerEvents` | insert volunteer events |
| `core/facts/withdrawal-discovery.ts:186` | `discoverWithdrawalTargets` | 7 | 3 | content_chunks, pages | new | `listWithdrawalChunks` | content_chunks joined to pages for withdrawal |
| `core/facts/withdrawal.ts:164` | `<anonymous>` | 2 | 2 | content_chunks | new | `deleteChunksForPages` | content_chunks delete; core chunk helper |
| `core/page-state/projections.ts:349` | `<anonymous>` | 2 | 2 | content_chunks | existing | `deleteChunksExcept` | same chunk delete; caller holds page id |
| `core/repair/contextual-mode.ts:27` | `plan` | 2 | 2 | content_chunks, page | new | `listContextualModeCandidates` | pages with projection seal state |
| `core/repair/safe-chunks.ts:39` | `plan` | 2 | 2 | pages | new | `listSafeChunkPages` | pages with rendering kind |
| `core/search/evidence-delivery.ts:1652` | `resolveFrozenHits` | 1 | 1 |  | new | `resolveFrozenHits` | frozen hit rows with chunk text |
| `core/search/projection-readiness.ts:47` | `readinessGeneration` | 15 | 14 | page_generation_clock_seq, sources | new | `readProjectionGeneration` | readiness generation string |
| `core/search/projection-readiness.ts:106` | `probeUncached` | 14 | 14 | p.knowledge_revision, pages, sources | new | `probeProjectionReadiness` | projection readiness probe |
| `core/synopsis-sweep.ts:52` | `readSynopsisTierConfig` | 3 | 2 | sources | new | `listSourceIdsByRetrievalMode` | sources with per-chunk synopsis mode |

### 12. Shared skills catalog, policy and retention (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/shared-skills/catalog.ts:26` | `identity` | 2 | 2 | persistence_brain, shared_skill_state | new | `readSharedSkillIdentity` | brain id and token secret identity; no logging |
| `core/shared-skills/catalog.ts:54` | `readSnapshot` | 2 | 2 | shared_skill_heads, shared_skill_policies, sources | new | `readSharedSkillSnapshot` | heads, live sources and policies |
| `core/shared-skills/compatibility.ts:10` | `sharedCatalogActive` | 6 | 6 | persistence_brain | new | `readSkillBundlesEnabled` | skill bundles enabled flag |
| `core/shared-skills/content-freshness.ts:39` | `ownedContentRows` | 2 | 1 | persistence_requests | new | `ownedContentRows` | source, receipt and owned root rows |
| `core/shared-skills/knowledge-guard.ts:87` | `<anonymous>` | 32 | 32 | shared_skill_packs | new | `sharedSkillPacksPresent` | Postgres catalog probe; Rust no-op candidate |
| `core/shared-skills/knowledge-guard.ts:91` | `<anonymous>` | 118 | 32 | persistence_source_bindings, shared_skill_packs, sources | new | `readKnowledgeGuardRows` | pack, binding, source and worktree roots |
| `core/shared-skills/migration.ts:109` | `runSharedSkillsMigration` | 2 | 2 | sources | new | `listLiveSourceIncarnations` | live sources with incarnation and path |
| `core/shared-skills/policy.ts:175` | `readSharedSkillPolicy` | 2 | 2 | shared_skill_policies | new | `readSharedSkillPolicy` | policy and epoch for source incarnation |
| `core/shared-skills/policy.ts:234` | `getSharedSkillPolicy` | 2 | 2 | sources | new | `readLiveSourceIncarnation` | live incarnation; members lack archived filter |
| `core/shared-skills/retention.ts:62` | `sharedSkillRetentionStatus` | 2 | 2 | persistence_requests | new | `sharedSkillRetentionStatus` | pending revision and retention status |
| `core/shared-skills/retention.ts:91` | `pruneSharedSkillRevisionsInTransaction` | 1 | 1 | shared_skill_revision_leases | new | `pruneSharedSkillLeases` | DELETE expired revision leases |
| `core/shared-skills/retention.ts:92` | `pruneSharedSkillRevisionsInTransaction` | 1 | 1 | persistence_requests | new | `pruneSharedSkillRevisions` | pending-aware revision prune in tx |
| `core/shared-skills/retention.ts:127` | `operatorSource` | 3 | 3 | sources | existing | `readSourceIncarnation` | same row; member also returns config |
| `core/shared-skills/retention.ts:143` | `<anonymous>` | 1 | 1 | sources | new | `lockSourceIncarnation` | FOR UPDATE source incarnation lock |
| `core/shared-skills/setup-source-policy.ts:16` | `sharedSkillSourcePolicy` | 5 | 4 | sources | new | `readSharedSkillSourceConfig` | live source config for shared skills |
| `core/shared-skills/source-opt-out.ts:48` | `readSharedSkillsSourceView` | 3 | 2 | sources | new | `readSharedSkillsSourceView` | live source config and incarnation |

### 13. Takes rows and projections (Lane 5)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/core-health.ts:412` | `takesWeightGridCheck` | 2 | 1 | takes | new | `countOffGridTakeWeights` | Takes with weight off grid |
| `core/facts/purge.ts:178` | `planFactPurge` | 1 | 1 | facts, pages, takes | new | `planFactPurgeTakes` | takes linked to purge facts |
| `core/fence-repair/import-step.ts:40` | `storedFenceRows` | 2 | 2 | takes | new | `listTakeRowsForPage` | takes row_num and claim for a page |
| `core/onboard/checks.ts:53` | `safeCount` | 16 | 3 | takes | new | `countTakes` | total take count; reads no member |
| `core/ops/takes.ts:276` | `countMcpResolved` | 2 | 2 | pages, takes | new | `countMcpResolvedTakes` | resolved takes by MCP principal count |
| `core/persistence/canonical-projections.ts:708` | `<anonymous>` | 30 | 18 | takes | new | `matchTakeRowNumbers` | takes row-number match in projections |
| `core/persistence/takes-prepare.ts:184` | `prepare` | 1 | 1 | takes | new | `getTakeRowForPrepare` | take claim and trust by page and row |
| `core/persistence/takes-prepare.ts:201` | `prepare` | 1 | 1 | takes | new | `getTakeTrust` | take trust tier by page and row |
| `core/persistence/takes-prepare.ts:261` | `<anonymous>` | 2 | 2 | takes | new | `takeRowExists` | take row existence by page and row |
| `core/persistence/takes-prepare.ts:266` | `<anonymous>` | 5 | 5 | persistence_requests | new | `setTakeHoldersUsed` | takes authority counter update in prepare |
| `core/persistence/takes-prepare.ts:275` | `<anonymous>` | 1 | 1 | takes | new | `deleteTakeRow` | DELETE take row in prepare |
| `core/persistence/takes-prepare.ts:281` | `<anonymous>` | 1 | 1 | takes | new | `setTakeResolvedAt` | UPDATE resolved_at; resolveTake differs |
| `core/persistence/takes-prepare.ts:283` | `<anonymous>` | 2 | 2 | takes | new | `getTakeTrust` | take id and trust tier by page and row |
| `core/repair/take-supersession.ts:205` | `candidatePages` | 2 | 2 | pages, takes | new | `listTakeSupersessionCandidates` | pages that have takes |

### 14. Search telemetry, MCP usage, feedback, budget (Lane 6)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/budget/daily-ledger.ts:137` | `<anonymous>` | 10 | 5 | budget_ledger | new | `readBudgetLedger` | budget_ledger reserved, committed, cap |
| `core/feedback/store.ts:392` | `feedbackStatus` | 3 | 2 | retrieval_events, retrieval_feedback | new | `feedbackStatusCounts` | retrieval events and ratings counts |
| `core/feedback/store.ts:405` | `feedbackStatus` | 3 | 2 | retrieval_feedback, retrieval_weights | new | `listRetrievalWeights` | page retrieval weights with counts |
| `core/feedback/store.ts:414` | `feedbackStatus` | 3 | 2 | retrieval_weights | new | `listRetrievalWeights` | page retrieval weights above threshold |
| `core/mcp-usage.ts:138` | `readClientOpUsage` | 23 | 8 | mcp_request_log | new | `readClientOpUsage` | per-token op usage counts |
| `core/mcp-usage.ts:205` | `readMcpUsageCoverage` | 3 | 3 | mcp_request_log_rollup | new | `tableExists` | Postgres catalog probe; Rust no-op candidate |
| `core/mcp-usage.ts:208` | `readMcpUsageCoverage` | 3 | 3 | mcp_request_log_rollup | new | `readMcpRollupPrunedBefore` | max pruned_through from rollup |
| `core/ops/usage.ts:54` | `<anonymous>` | 1 | 1 |  | new | `countUsageByModelPhase` | usage counts and tokens by model and phase |
| `core/ops/usage.ts:70` | `<anonymous>` | 1 | 1 | chat_usage_log | new | `oldestChatUsageAt` | oldest chat_usage_log timestamp |
| `core/search/query-cache.ts:405` | `prune` | 1 | 1 | deleted, query_cache | new | `pruneQueryCache` | DELETE expired query_cache rows |
| `core/search/query-cache.ts:422` | `stats` | 2 | 2 |  | new | `queryCacheStats` | query_cache aggregate stats |
| `core/search/telemetry.ts:271` | `<anonymous>` | 11 | 7 | search_telemetry | new | `recordSearchTelemetry` | upsert search telemetry row |
| `core/search/telemetry.ts:592` | `readSearchStats` | 2 | 2 |  | new | `readSearchStats` | search telemetry aggregate |

### 15. Timeline projections and checks (Lane 6)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/knowledge-health.ts:480` | `runEffectiveDate` | 2 | 1 | pages, sample | new | `sampleEffectiveDates` | Newest 1000 effective-date sample |
| `commands/doctor/checks/knowledge-health.ts:513` | `runEffectiveDate` | 2 | 1 | pages, sample | new | `sampleEffectiveDateSources` | Newest 1000 effective-date sources |
| `commands/doctor/checks/timeline-history.ts:75` | `timelineHistoryCheck` | 4 | 3 | timeline_entries | new | `readMaxTimelineEntryId` | Max timeline entry id |
| `core/persistence/canonical-projections.ts:552` | `materializeTimeline` | 12 | 12 | timeline_entries | new | `listStoredTimelineRowsOrdered` | stored non-event rows ordered by date; member unordered |
| `core/persistence/canonical-projections.ts:571` | `pendingTimelineRows` | 84 | 4 | timeline_entries | new | `listStoredTimelineRowsOrdered` | same stored timeline rows; ordered by date |
| `core/persistence/canonical-projections.ts:678` | `prepareCanonicalProjections` | 12 | 12 | timeline_entries | new | `listStoredTimelineRowsOrdered` | same stored timeline rows; ordered by date |
| `core/persistence/canonical-projections.ts:796` | `<anonymous>` | 18 | 18 | timeline_entries | new | `deleteTimelineRows` | timeline delete by id list in projections |
| `core/repair/timeline.ts:37` | `storedRowsByPage` | 6 | 4 | timeline_entries | new | `storedTimelineRowsByPageIds` | batch stored timeline rows by page id |
| `core/repair/timeline.ts:106` | `segmentedTimelinePages` | 6 | 4 | pages, timeline_entries | new | `countSegmentedTimelinePages` | counts timeline rows per source |
| `core/repair/timeline.ts:130` | `plan` | 2 | 2 | pages, timeline_entries | new | `countTimelineEventPageRows` | timeline rows with event pages |
| `core/timeline-extract.ts:549` | `pruneTimelineOrphans` | 4 | 1 | pages, timeline_entries | new | `listTimelineOrphanPages` | pages with timeline for orphan prune |
| `core/trust/fence-guard.ts:219` | `heldRows` | 1 | 1 | timeline_entries | new | `readTimelineTrustRows` | timeline row tiers by id |

### 16. Chronicle ledger (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/chronicle/backfill.ts:139` | `runChronicleBackfill` | 4 | 2 | chronicle_page_state | new | `listChronicleBackfillPages` | pages for chronicle backfill |
| `core/chronicle/ledger-stats.ts:29` | `readChronicleLedgerStats` | 5 | 4 |  | new | `readChronicleLedgerStats` | chronicle ledger stats aggregate |
| `core/chronicle/ledger-stats.ts:42` | `readChronicleLedgerStats` | 5 | 4 | chronicle_page_state | new | `countChronicleSkipReasons` | chronicle auto skipped or failed reasons |
| `core/chronicle/ledger-stats.ts:52` | `readChronicleLedgerStats` | 5 | 4 | chronicle_judge_reservations | new | `countChronicleJudgeReservations` | judge reservations in last 24h |
| `core/chronicle/ledger-stats.ts:55` | `readChronicleLedgerStats` | 5 | 4 | chronicle_judge_reservations, chronicle_page_state | new | `countChronicleCallsByPrincipal` | chronicle calls by principal |
| `core/chronicle/ledger-stats.ts:89` | `readChronicleDuplicateEvents` | 2 | 1 | chronicle_pa, chronicle_page_state | new | `readChronicleDuplicateEvents` | duplicate chronicle events by page |
| `core/chronicle/ledger.ts:84` | `chronicleDailyRemaining` | 1 | 1 | chronicle_judge_reservations | new | `countChronicleJudgeReservations` | same member as row 124; 24h reservations |
| `core/chronicle/ledger.ts:157` | `hasExtractedEvents` | 12 | 12 | chronicle_page_state | new | `hasExtractedChronicleEvents` | chronicle_page_state extracted check |
| `core/cycle/chronicle.ts:67` | `discover` | 1 | 1 | pages | new | `listChroniclePages` | page rows for chronicle discovery |
| `core/cycle/chronicle.ts:105` | `candidates` | 1 | 1 | chronicle_page_state, pages | new | `listChronicleCandidates` | chronicle page state candidates joined to pages |

### 17. Mentions, referrers and gazetteer (Lane 2)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/by-mention.ts:517` | `buildGazetteer` | 2 | 1 | pages | new | `listPageSourceIds` | distinct live page source ids |
| `core/by-mention.ts:527` | `buildGazetteer` | 2 | 1 | pages | new | `listGazetteerPages` | pages with identity and headings |
| `core/by-mention.ts:1101` | `scanStaleMentions` | 2 | 1 | links, pages | new | `countStaleMentionLinks` | distinct stale mention referrers |
| `core/mentions/coverage.ts:43` | `readMentionCoverage` | 2 | 2 | mention_index_status | new | `readMentionIndexStatus` | mention_index_status rows |
| `core/mentions/coverage.ts:55` | `readMentionCoverage` | 2 | 2 | pages | new | `countLivePagesInSource` | live page count for one source |
| `core/mentions/newer-mentions.ts:77` | `readNewerMentions` | 2 | 2 | pages | new | `readPageEffectiveStamps` | page date stamps by slug |
| `core/mentions/referrers.ts:142` | `hydrate` | 4 | 4 |  | new | `hydrateReferrerPages` | referrer page bodies and dates |
| `core/mentions/referrers.ts:191` | `readReferrerPage` | 2 | 2 | pages | new | `readReferrerPage` | target page lookup with referrer join |
| `core/mentions/referrers.ts:199` | `readReferrerPage` | 2 | 2 | pages | new | `readReferrerPage` | target page lookup with referrer join |
| `core/mentions/referrers.ts:363` | `readPageStatusByRef` | 4 | 4 | pages | new | `readPageStatusByRefs` | page frontmatter status by refs |

### 18. Embedding state and coverage counts (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/data-integrity.ts:191` | `runCrossModal` | 2 | 1 | content_chunks | new | `countImageChunkModalityMismatch` | Image vectors with wrong modality |
| `commands/doctor/checks/embedding-health.ts:415` | `runEmbeddingColumnRegistry` | 2 | 1 | content_chunks | new | `readEmbeddingCoveragePct` | Embedding coverage percent |
| `commands/doctor/checks/image-embedding-coverage.ts:21` | `imageEmbeddingCoverageCheck` | 2 | 1 | content_chunks, pages | new | `countImageEmbeddingCoverage` | Image vector coverage counts |
| `commands/doctor/checks/schema-health.ts:412` | `readBacklogAge` | 2 | 1 | config, now | new | `readEmbeddingBacklogAge` | Backlog age; joins config |
| `core/held-embedding.ts:57` | `readBudgetLimited` | 4 | 3 | page_embedding_budget, pages | new | `readEmbeddingBudgetLimited` | budget-limited page embedding states |
| `core/page-state/projections.ts:188` | `planProjectionKeep` | 2 | 2 | md5, target.m | new | `planProjectionKeep` | chunk embedding hash keep plan |
| `core/page-state/projections.ts:350` | `<anonymous>` | 2 | 2 | content_chunks | new | `clearChunkEmbeddings` | clears chunk embeddings and hashes |
| `core/persistence/embedding-settlement.ts:66` | `listEmbeddingCandidates` | 2 | 2 | pages | new | `listEmbeddingCandidates` | embedding effects with page slugs |
| `core/post-upgrade-reembed.ts:45` | `computeReembedEstimate` | 1 | 1 | pages | new | `computeReembedEstimate` | pending reembed counts and sizes |
| `core/source-health.ts:403` | `chunkCountsBySource` | 1 | 1 | content_chunks, pages | new | `countEmbeddedChunksBySource` | content_chunks embedding not null count |

### 19. Alias fan-out and alias checks (Lane 2)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/by-mention.ts:550` | `buildGazetteer` | 2 | 1 | page_aliases, pages | new | `listGazetteerAliases` | aliases with page metadata |
| `core/onboard/checks.ts:767` | `checkDanglingAliases` | 4 | 3 | pages, slug_aliases | new | `countDanglingAliases` | alias rows pointing at deleted pages |
| `core/onboard/checks.ts:768` | `checkDanglingAliases` | 4 | 3 | page_aliases, pages, slug_aliases | new | `countDanglingAliases` | alias rows pointing at deleted pages |
| `core/persistence/links-preparation.ts:29` | `liveSlugAliases` | 8 | 8 | pages, slug_aliases | new | `liveSlugAliasMap` | alias to canonical slug; not resolveAliases shape |
| `core/search/alias-fanout.ts:109` | `<anonymous>` | 5 | 5 | pages | new | `findPagesByTitles` | pages by lowered title |
| `core/search/alias-fanout.ts:117` | `resolveQueryEntities` | 5 | 5 | page_aliases | new | `resolveCaseSensitiveAliases` | case-sensitive alias rows; resolveAliases lacks alias_text |
| `core/verbs/entity-card-identity.ts:140` | `readSiblingIdentity` | 2 | 2 | page_aliases | new | `readSiblingAliases` | aliases for sibling slugs |
| `core/verbs/entity-card.ts:804` | `readAka` | 4 | 4 | page_aliases | new | `readAliasNorms` | alias_norm list for one page |

### 20. Access members, guests and OAuth rows (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/auth.ts:179` | `<anonymous>` | 1 | 1 | access_tokens | new | `listAccessTokens` | access_tokens list |
| `core/access/labelled-only.ts:47` | `labelledOnlyMemberIds` | 2 | 1 | access_members | new | `listLabelledOnlyMemberIds` | labelled-only access member ids |
| `core/access/members.ts:129` | `listMembers` | 4 | 3 | access_group_members, access_members | new | `listAccessMembers` | access_members with group ids |
| `core/access/policy-transfer.ts:34` | `exportPolicyFiles` | 1 | 1 | access_policy_state | new | `listAccessPolicySourceIds` | access_policy_state source ids |
| `core/access/serves.ts:29` | `brainServes` | 10 | 5 | access_members | new | `listActiveAccessMemberIds` | access_members live ids |
| `core/advisor/collect-mcp-client-fit.ts:108` | `readClientSurfaces` | 3 | 3 | oauth_clients | new | `readOAuthClientSurfaces` | oauth_clients surfaces |
| `core/guests/marker.ts:26` | `withGuestSourceSql` | 6 | 6 |  | new | `listGuestSourceTrustRows` | guest trust rows; withGuestSourceSql |
| `core/guests/promote.ts:49` | `guestNote` | 1 | 1 | guest_sources, pages | new | `findGuestPageNote` | page joined to guest_sources by slug |

### 21. Entity identity, entity card and questions (Lane 2)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/entity-identity.ts:118` | `<anonymous>` | 2 | 2 | SET, entity_identities | new | `insertEntityIdentity` | entity_identities insert write |
| `core/entity-identity.ts:146` | `unlinkEntityIdentity` | 2 | 2 | entity_identities | new | `unlinkEntityIdentity` | entity_identities delete write |
| `core/entity-identity.ts:220` | `listEntityIdentities` | 4 | 4 | entity_identities, pages | new | `listEntityIdentities` | entity_identities joined to pages |
| `core/questions/store.ts:104` | `getPin` | 1 | 1 |  | new | `getPinnedQuestion` | pinned_questions row by id |
| `core/questions/store.ts:115` | `listPins` | 5 | 5 |  | new | `listPinnedQuestions` | pinned_questions list |
| `core/questions/store.ts:133` | `insertPin` | 1 | 1 | pinned_questions | new | `insertPinnedQuestion` | pinned_questions insert write |
| `core/verbs/entity-card.ts:351` | `selectEntityCandidates` | 4 | 4 | page_retrievals | new | `selectEntityCandidates` | page candidates with retrieval recency |
| `core/verbs/entity-card.ts:622` | `assembleCard` | 4 | 4 |  | new | `readEntityCardLinks` | link rows with temporal ranges |

### 22. AI decide store and calibration rollups (Lane 5)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/calibration.ts:72` | `getLatestProfile` | 2 | 2 | calibration_profiles | new | `getLatestCalibrationProfile` | latest calibration profile |
| `core/ai/decide/review-lane.ts:422` | `proposalReviewRates` | 1 | 1 |  | new | `proposalReviewRates` | pending review counts and ages |
| `core/ai/decide/review-lane.ts:423` | `proposalReviewRates` | 1 | 1 |  | new | `proposalReviewRates` | pending review counts and ages |
| `core/ai/decide/store.ts:274` | `dailySpend` | 1 | 1 | decide_spend | new | `dailyDecideSpend` | decide spend totals today |
| `core/ai/decide/store.ts:359` | `listCalibrations` | 3 | 2 | decide_calibrations | new | `listDecideCalibrations` | decide_calibrations list |
| `core/ai/decide/store.ts:416` | `slotUsage` | 1 | 1 |  | new | `decideSlotUsage` | per-slot usage totals |
| `core/ai/decide/store.ts:431` | `conflictNoEntityShare` | 1 | 1 | decision_receipts | new | `conflictNoEntityShare` | receipt share skipped no_entity |
| `core/ai/decide/store.ts:466` | `recentResolvedModels` | 3 | 2 | decision_receipts | new | `recentResolvedModels` | resolved models from receipts |

### 23. Schema-pack type statistics (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/schema-pack/detect.ts:108` | `runDetect` | 1 | 1 | pages | new | `pageTypeTotals` | total, untyped and typed counts |
| `core/schema-pack/detect.ts:124` | `runDetect` | 1 | 1 | pages | new | `pagePrefixSamples` | slug prefix counts with sample types |
| `core/schema-pack/detect.ts:147` | `runDetect` | 1 | 1 | pages | new | `countPagesByTypeForSource` | countPagesBy may cover; unverified |
| `core/schema-pack/entity-types.ts:123` | `resolveTypeFilter` | 26 | 11 | config, sources | new | `listSourceTypeFilterKeys` | config keys matched to sources |
| `core/schema-pack/review.ts:146` | `findTypeOrphans` | 1 | 1 | pages | new | `countPagesByTypeForSource` | countPagesBy may cover; unverified |
| `core/schema-pack/stats.ts:178` | `fetchCountRows` | 2 | 2 | pages | new | `countPagesByTypeForSource` | countPagesBy may cover; unverified |
| `core/schema-pack/stats.ts:217` | `detectDeadPrefixes` | 72 | 2 | pages | new | `countPagesByPrefix` | slug LIKE prefix count |

### 24. Derived generations and fences (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/generations.ts:36` | `generationRetirementsCheck` | 4 | 3 | derived_generation_items, derived_generations | new | `listGenerationRetirementCounts` | Derived generations join; no family |
| `commands/doctor/checks/generations.ts:60` | `generationHeldCheck` | 4 | 3 | derived_generations | new | `listHeldGenerationCounts` | Held generations by reason; no family |
| `core/generations/adapters/fact-rows.ts:72` | `projectFactFenceGeneration` | 18 | 18 |  | new | `projectFactFenceRows` | fact rows as jsonb projection |
| `core/generations/fence.ts:169` | `clearFenceHold` | 1 | 1 | derived_generations | new | `clearGenerationFenceHold` | DELETE held generation row |
| `core/generations/fence.ts:180` | `listFenceHolds` | 2 | 2 | derived_generations | new | `listGenerationFenceHolds` | held derived generations |
| `core/generations/managed.ts:221` | `listPendingMembers` | 4 | 3 | derived_generation_items, derived_generations | new | `listPendingGenerationMembers` | pending generation items |
| `core/generations/managed.ts:237` | `listOrphanCandidates` | 4 | 3 | derived_generation_activations | new | `listOrphanGenerationCandidates` | orphan activation candidates |

### 25. Raw data and file metadata (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/data-integrity.ts:327` | `runMarkdownBody` | 2 | 1 | pages, raw_data | new | `listMarkdownBodyMismatch` | Page body vs raw_data length |
| `commands/doctor/checks/data-integrity.ts:342` | `runMarkdownBody` | 2 | 1 | pages, raw_data | new | `countSegmentedRawPages` | Segmented pages with raw data |
| `commands/doctor/checks/queue-assets.ts:167` | `runImageAssets` | 2 | 1 | files, pages, sources | new | `listImageAssetFiles` | Image asset files with source paths |
| `commands/export.ts:124` | `<anonymous>` | 2 | 1 | raw_data | new | `exportPageRows` | pages with raw data for export |
| `commands/files.ts:158` | `listFiles` | 1 | 1 | files | new | `listFiles` | files table listing |
| `core/ops/files.ts:45` | `<anonymous>` | 1 | 1 | files | new | `listFilesForSlug` | files by page slug; listFilesForPage takes page id |
| `core/ops/files.ts:204` | `<anonymous>` | 1 | 1 | files | new | `getFileByStoragePath` | files by storage path; getFile needs source id |

### 26. Connect and source resolver (rust-cli-connect)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/diag.ts:62` | `readSources` | 1 | 1 | sources | new | `listSourcesForDiag` | source columns incl last_commit; no member |
| `commands/doctor/checks/db-connection.ts:317` | `runConnection` | 2 | 2 |  | new | `pingDatabase` | SELECT 1 connectivity ping; Rust no-op candidate |
| `commands/doctor/checks/orphan-bindings.ts:47` | `checkForeignOwnershipMarkers` | 4 | 3 | persistence_brain | existing | `readPersistenceBrainId` | Same singleton brain_id read |
| `commands/migrations/v0_32_2.ts:237` | `phaseCVerify` | 1 | 1 | sources | new | `listSourceIdsWithPaths` | source ids with local_path; no member |
| `commands/upgrade.ts:1093` | `runPostUpgrade` | 1 | 1 | persistence_brain | new | `readPersistenceBrainId` | persistence_brain singleton id; startup read |
| `core/repair/core.ts:290` | `resolveRepairScope` | 5 | 4 | persistence_brain | existing | `readPersistenceBrainId` | same singleton brain_id read |
| `core/source-resolver.ts:754` | `resolveSourceForRepoPath` | 3 | 3 | sources | existing | `listLocalPathSources` | source-resolver local-path lookup; reads more |
| `core/source-resolver.ts:1031` | `liveSourceRows` | 183 | 183 | sources | existing | `listAllSources` | source-resolver live sources; reads more |
| `core/sync-dispatch-read.ts:51` | `syncDispatchRow` | 2 | 2 | persistence_source_bindings, source_ingestion_receipts | new | `syncDispatchRow` | source row with persistence binding flag; dispatch read |
| `core/sync-pending.ts:205` | `loadPendingRoster` | 2 | 1 | persistence_host_bindings, persistence_source_bindings, sources | new | `loadPendingRoster` | persistence source bindings roster; startup read |

### 27. Core memory and open loops (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/core-memory.ts:267` | `listCorePages` | 8 | 5 | fact_withdrawals, pages | new | `listCorePages` | core page rows with withdrawn flag |
| `core/core-memory.ts:357` | `pendingCoreNotices` | 1 | 1 | core_edit_notices | new | `listPendingCoreNotices` | core_edit_notices latest per page |
| `core/loops/loops-store.ts:204` | `closeOpenLoop` | 1 | 1 | open_loops | new | `closeOpenLoop` | open_loops status update |
| `core/loops/loops-store.ts:262` | `listOpenLoops` | 3 | 3 | open_loops | new | `listOpenLoops` | open_loops list |
| `core/verbs/entity-card.ts:713` | `assembleCard` | 2 | 2 | open_loops | new | `listOpenLoopsForCounterparty` | open loops for counterparty |

### 28. Extraction state checks and rollups (Lane 2)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/extraction-input.ts:67` | `runExtractionInputTruncatedCheck` | 2 | 1 | page_extraction_state, pages | new | `listTruncatedConversationInputs` | Truncated extraction inputs |
| `commands/doctor/checks/extraction-input.ts:93` | `runExtractionInputTruncatedCheck` | 2 | 1 | page_extraction_state | new | `listExtractionInputReceipts` | Extraction input truncation receipts |
| `commands/doctor/checks/extraction-sync.ts:178` | `checkUnverifiedExtractions` | 2 | 1 | pages | new | `countUnverifiedExtractionPages` | Unverified extraction pages |
| `core/cycle/extract-atoms.ts:552` | `countExtractAtomsBacklog` | 2 | 1 | pages | new | `countExtractAtomsBacklog` | pages backlog count for atom extraction |
| `core/extract/rollup-writer.ts:88` | `readRecordedHaltReasons7d` | 2 | 1 | extract_rollup_7d | new | `readHaltReasons7d` | halt reason counts over 7 days |

### 29. Config reads (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/embedding-identity.ts:39` | `runEmbeddingIdentity` | 2 | 1 | config | existing | `getConfig` | Same config key read as getConfig |
| `commands/doctor/checks/persistence-capacity.ts:39` | `checkPersistenceCapacity` | 6 | 5 | config | existing | `getConfig` | Same config key read as getConfig |
| `commands/doctor/registry.ts:594` | `readEntryBudget` | 4 | 3 | config | existing | `getConfig` | Same config key read as getConfig |
| `core/backfill-effective-date.ts:112` | `getCheckpoint` | 2 | 2 | config | existing | `getConfig` | single-key config read |
| `core/backfill-effective-date.ts:126` | `setCheckpoint` | 1 | 1 | SET, config | existing | `setConfig` | upsert config value; same write |
| `core/backfill-effective-date.ts:139` | `clearCheckpoint` | 1 | 1 | config | existing | `unsetConfig` | delete config key; same write |
| `core/config-db-merge.ts:199` | `readDbPlaneMergeValues` | 1 | 1 | config | new | `readDbPlaneMergeValues` | config keys plus prefix patterns |
| `core/eligibility/scan.ts:78` | `readBaseline` | 2 | 1 | config | existing | `getConfigValues` | keyed read; returns key and value |
| `core/health-memo.ts:79` | `readGeneration` | 2 | 2 | config, page_generat | new | `readHealthMemoGeneration` | config keys plus page generation clock |
| `core/persistence/admission-origin.ts:70` | `readBackgroundPauseShare` | 8 | 7 | config | existing | `getConfigValues` | single config row; reads table directly |
| `core/persistence/capacity-forecast.ts:79` | `readDays` | 10 | 4 | config | existing | `getConfigValues` | config row; reads table directly |
| `core/persistence/capacity-forecast.ts:91` | `readCapacityConfig` | 24 | 23 | config | existing | `getConfigValues` | capacity config keys; same rows |
| `core/persistence/limits.ts:21` | `readReceiptTargetBytes` | 38 | 37 | config | existing | `getConfigValues` | same config row; reads table directly |
| `core/persistence/limits.ts:82` | `readReceiptRetentionDays` | 38 | 37 | config | existing | `getConfigValues` | same config row; reads table directly |
| `core/persistence/limits.ts:154` | `readUploadLimits` | 1 | 1 | config | existing | `getConfigValues` | upload limit config keys; same rows |
| `core/persistence/memory-prepare.ts:103` | `prepareMemoryMutation` | 2 | 2 | config | existing | `getConfigValues` | embedding config keys; same rows |
| `core/persistence/refresh-barrier.ts:145` | `expireDeferredWrites` | 18 | 12 | config | existing | `getConfigValues` | config key; value cast stays in TS |
| `core/persistence/schema-admission.ts:23` | `readSchemaBehind` | 6 | 5 | config | existing | `getConfigValues` | schema version config row; reads table directly |
| `core/persistence/schema-admission.ts:44` | `schemaAdmissionRefusal` | 32 | 32 | config | existing | `getConfigValues` | schema version config row; reads table directly |
| `core/persistence/switches.ts:83` | `readWriteSwitchSnapshot` | 3 | 3 | config | existing | `getConfigValues` | switch config keys; same rows |
| `core/persistence/terminal-failures.ts:55` | `readTerminalThresholds` | 6 | 5 | config | existing | `getConfigValues` | threshold config keys; same rows |
| `core/search/embedding-column.ts:701` | `resolveActiveEmbeddingColumnFromEngine` | 65 | 39 | config | existing | `getConfigValues` | config keys; same rows |
| `core/search/private-visibility.ts:1248` | `readServesPolicy` | 3 | 2 | config | existing | `getConfigValues` | config keys; same rows |
| `core/search/query-cache.ts:494` | `loadCacheConfig` | 3 | 3 | config | existing | `getConfigValues` | config keys; same rows |
| `core/transcripts/archive.ts:299` | `readArchiveLedger` | 3 | 2 | config | new | `listConfigByPrefix` | config keys by LIKE prefix; getConfigValues takes exact keys |
| `core/transcripts/archive.ts:325` | `legacyCovered` | 6 | 2 | config | new | `listConfigKeysByPrefix` | config keys by LIKE prefix |
| `core/trust/claim-state.ts:69` | `readLegacyCeilings` | 5 | 2 | config | existing | `getConfig` | single-key config read |

### 30. Keyword arms and search vectors (Lane 6)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/reindex-search-vector.ts:101` | `runReindexSearchVector` | 1 | 1 | content_chunks, pages | new | `countSearchVectorRows` | rows with search vector |
| `core/search/entity-anchor.ts:81` | `namedEntity` | 3 | 3 | pages, titled | new | `findNamedEntityPages` | pages whose titles appear in query |
| `core/search/fact-relevance.ts:166` | `wordStems` | 3 | 3 |  | new | `tokenizeWordStems` | english tsvector helper; Rust no-op candidate |
| `core/search/retrieval-coverage.ts:127` | `countInScope` | 5 | 5 |  | new | `countRetrievalCoverageInScope` | coverage count over haystack |

### 31. Edge contradictions (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/edge-proposals.ts:52` | `rows` | 1 | 1 | link_edge_proposals, pages | new | `listEdgeProposalRows` | link_edge_proposals with page slugs |
| `core/cycle/edge-contradictions.ts:223` | `findCandidateGroups` | 1 | 1 | link_relationships, pages | new | `findEdgeContradictionGroups` | link_relationships candidate groups |
| `core/cycle/edge-contradictions.ts:548` | `markRevertedProposals` | 1 | 1 | link_edge_proposals, link_transitions | new | `markEdgeProposalsReverted` | link_edge_proposals status update |
| `core/trust/review.ts:230` | `contradictions` | 1 | 1 |  | new | `listContradictionReviewRows` | contradiction rows with fact text |

### 32. Stats, connectors and backup coverage (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/connectors.ts:101` | `connectorsHealthCheck` | 2 | 1 | ingest_log | new | `readLatestConnectorIngest` | Latest connector summary; getIngestLog lacks filter |
| `commands/doctor/checks/knowledge-health.ts:196` | `runFactsExtraction` | 2 | 1 | ingest_log | new | `countFactsExtractionFailures` | Ingest log failure reasons by source |
| `core/backup/coverage.ts:112` | `brainMaturity` | 6 | 5 | facts, pages, sources | new | `readBrainMaturityCounts` | page, fact and source counts; getStats may differ |

### 33. Ontology facts and supersede (Lane 4)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/belief/writers.ts:41` | `ontologyStreamSlugs` | 2 | 2 | facts | new | `listOntologyStreamSlugs` | distinct slugs for ontology dimension |
| `core/repair/ontology-facts.ts:78` | `classifyOntologyFacts` | 4 | 3 | fact_withdrawals | new | `listOntologyWithdrawals` | fact_withdrawals joined to facts |
| `core/trust/supersede-handlers.ts:180` | `contestOntologySupersession` | 2 | 2 | facts | new | `listOntologyContestCandidates` | facts on same dimension |

### 34. Planner statistics (core)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/planner-stats.ts:108` | `readPlannerStatsState` | 44 | 40 | planner_stats_deltas, planner_stats_state | new | `readPlannerStatsState` | planner_stats_deltas and state pending counts |
| `core/planner-stats.ts:153` | `readExpressionIndexesWithoutStats` | 4 | 3 | pg_class, pg_index | new | `listExpressionIndexesWithoutStats` | pg_index catalog probe; Rust no-op candidate |

### 35. Code edges and traversal cache (Lane 5)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `core/chunkers/symbol-resolver.ts:133` | `resolveSymbolEdgesIncremental` | 1 | 1 | code_edges_symbol | new | `hasCodeEdgesSymbol` | code_edges_symbol existence by source |
| `core/code-intel/traversal-cache.ts:174` | `clearTraversalCache` | 1 | 1 | code_traversal_cache, deleted | new | `clearCodeTraversalCache` | code_traversal_cache delete |

### 36. Salience checks (Lane 5)

| Site | Function | Calls | Cmds | Tables | Class | Member | Note |
|---|---|---:|---:|---|---|---|---|
| `commands/doctor/checks/knowledge-health.ts:601` | `runSalience` | 2 | 1 | pages, takes | new | `countZeroWeightWithTakes` | Zero-weight pages with active takes |
