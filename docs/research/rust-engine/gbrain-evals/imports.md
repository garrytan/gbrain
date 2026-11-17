> Appendix to [../gbrain-evals.md](../gbrain-evals.md). Detailed per-area notes from one research pass over gbrain-evals `cd447b3` (v0.10.237) and gbrain `6ce7195`. Paths are relative to the gbrain-evals root unless marked `gbrain:`. "G1" to "G10" in the text name the appendix files listed in the main map.

# g1-imports: how gbrain-evals depends on gbrain internals

Scope: gbrain-evals checkout the gbrain-evals checkout at HEAD `cd447b3a` (v0.10.237). Pinned gbrain source read with `git show <sha>:<path>` from a gbrain checkout.

Pins (from `package.json`):

| Alias | Commit | Version | Export map source |
|---|---|---|---|
| `gbrain` | `6ce7195b44a034f85aec811f11fbf862db376f50` | 0.60.733.0 | `git show 6ce7195b:package.json` `exports` |
| `gbrain-cues` | `939232f1746381b4e932d620d6c709e29198f14c` | 0.55.0.0 | same, at 939232f |
| `gbrain-reader` | `e78f1c38b947b053f3a46881340f74f316be855a` | 0.59.0.0 | same, at e78f1c3 |

Method. Import specifiers come from a regex scan of every `.ts`/`.js` file in the checkout (static, `import type`, `import()`, template `import(\`${x}/...\`)`, `require`, `Bun.resolveSync`, `import.meta.resolve`), plus `node_modules/gbrain*/...` deep paths and `importGbrain(gut, 'src/...')` subpaths. Symbol counts are file counts of multi-line-aware import parses (comments stripped). Call-site counts are files whose text contains `name(`, so generic names (`connect`, `get`, `embed`) overcount. Engine method counts are name matches across `eval/`, `scripts/`, `test/`, `types/`. Nothing was run; no API keys or paid paths touched.

Headline numbers:

- 249 files reference gbrain: `eval/` 128, `test/` 72, `docs/` 49 (one-off repro scripts under `docs/benchmarks`, `docs/plans`, `docs/audit`). `scripts/` and `types/` have zero references.
- Classes (see Section 3): PIN-STATIC 83, OVERLAY-CAPABLE 50, MIXED 2, DYN-PATH 66, DEEP-PATH-ONLY 48.
- 37 files mention `--gbrain` or `gbrainSpecFrom`. Only 35 of them are overlay-capable; the other 2 keep static pin imports.
- 41 files call `importGbrain(gut, 'src/...')` (absolute-path import into the overlay or pinned root).
- 96 files reach into `node_modules/gbrain*/src/...` by relative path or string, bypassing the export map.

---

## 1. Import inventory by specifier

Resolution column: the pinned source file the export-map entry points to. "Files" counts static non-type imports plus type-only imports, unless marked dyn.

### 1.1 `gbrain/*` (pin 6ce7195)

| Specifier | Resolves to (pin) | Symbols used (files) | Example file:line |
|---|---|---|---|
| `gbrain/pglite-engine` (56 files) | `src/core/pglite-engine.ts` | `PGLiteEngine` class (40 value, 15 type-only); `computeSnapshotSchemaHash` (1) | `eval/runner/longmemeval.ts:83`; `test/support/pglite-snapshot.ts:19` |
| `gbrain/ai/gateway` (47) | `src/core/ai/gateway.ts` | `configureGateway` (30), `__setEmbedTransportForTests` (19), `ChatResult` (12 incl type), `getEmbeddingDimensions` (6), `getEmbeddingModel` (5), `ChatOpts` (5), `__setChatTransportForTests` (5), `chat` (3), `diagnoseEmbedding` (2), `getChatModel` (1), `resetGateway` (1), `embed` (1), `getExpansionModel` (1), `__setRerankTransportForTests` (1), `__setGenerateTextTransportForTests` (1), `__setGenerateObjectTransportForTests` (1), `toolLoop` (1), `* as gatewayPackage` (1). Dynamic: `validateModelId` (`eval/runner/cat36-production.ts:84`, `longmemeval-answers.ts:258`), `rerank` (`eval/runner/smoke.ts:140`) | `eval/runner/longmemeval.ts:93`; `eval/runner/skillopt-method/rollouts.ts:36` (`toolLoop`) |
| `gbrain/types` (24) | `src/core/types.ts` | type-only: `HybridSearchMeta` (15), `SearchResult` (15), `PageType` (2), `PageInput` (2), `BrainHealth` (1), `ResolvedColumn` (1), `SearchOpts` (1) | `eval/runner/cat21-code-retrieval.ts:67` |
| `gbrain/operations` (21) | `src/core/operations.ts` | value: `operations` (3), `operationsByName` (2), `OperationError` (1). Type: `OperationContext` (17), `Operation` (4), `ParamDef` (3), `AuthInfo` (1) | `eval/runner/tool-bridge.ts:33`; `eval/runner/mcp-contract.ts:41` |
| `gbrain/config` (12) | `src/core/config.ts` | `loadConfig` (7), `configPath` (3), type `GBrainConfig` (5) | `eval/runner/longmemeval.ts:88`; `eval/precisionmembench/seed.ts:48` |
| `gbrain/import-file` (14) | `src/core/import-file.ts` | `importFromContent` (13), `importFromFile` (1), `* as importPackage` (1) | `eval/precisionmembench/seed.ts:31`; `eval/runner/cat24-capture-provenance.ts:64` |
| `gbrain/search/hybrid` (16) | `src/core/search/hybrid.ts` (some names re-exported from `cosine-rescore.ts`, `alias-hop.ts`) | `hybridSearch` (15), `HybridSearchOpts` (type, 1), `RRF_K` (1), `PRE_FUSION_POOL_FLOOR` (1), `rrfFusionWeighted` (1), `cosineReScore` (1), `cosineSimilarity` (1), `shouldBoostCompiledTruth` (1), `runPostFusionStages` (1), `applyAliasHop` (1), `stampUnverifiedExtractions` (1), `PostFusionOpts` (type, 1), `* as searchPackage` (1) | `eval/runner/longmemeval.ts:85`; `eval/runner/relational-ab.ts:37` |
| `gbrain/engine` (11) | `src/core/engine.ts` | type `BrainEngine` (10), value `MAX_SEARCH_LIMIT` (1) | `eval/runner/cat13-gap-localize.ts:75` |
| `gbrain/core/skillopt` (16) | `src/core/skillopt/index.ts` | `runSkillOpt` (6), `scoreSkillOnTasks` (5, in tests and cat32 only), `runRollout` (4), `loadHeldOut` (4), `SKILLOPT_HOOK_BUDGET_EXHAUSTED` (2), `describeJudges` (2), `scoreSkillPerTask` (1), `scoreTrajectory` (1), `rolloutToolsForSkill` (1); types `BenchmarkTask` (8), `SkillOptOpts` (1), `ScoreOnTasksOpts` (1) | `eval/runner/skillopt-method/rollouts.ts:38`; `eval/runner/cat31-skillopt-ablation.ts:67-72` |
| `gbrain/link-extraction` (5) | `src/core/link-extraction.ts` | `extractPageLinks` (4), `extractEntityRefs` (1), `parseTimelineEntries` (1), type `SlugResolver` (3) | `eval/runner/adversarial.ts:16`; `eval/runner/cat6-prose-scale.ts:82` |
| `gbrain/extract` (4 static, 5 total) | `src/commands/extract.ts` | `runExtract` (3). Called with CLI argv: `runExtract(engine, ['links', '--source', 'db'])` | `eval/runner/multi-adapter.ts:50`, `eval/runner/before-after.ts:20`, `eval/runner/multi-adapter.ts:178` |
| `gbrain/embedding` (4) | `src/core/embedding.ts` | `embedQuery` (3), `embed` (2), `embedBatch` (1) | `eval/runner/adapters/vector.ts:33` |
| `gbrain/think` (3) | `src/core/think/index.ts` | `runThink` (3), type `ThinkLLMClient` (3), `ThinkResult` (2), `ThinkResponse` (1), `RunThinkOpts` (indirect) | `eval/runner/cat14-calibration.ts:104`; `eval/runner/cat25-trajectory-routing.ts:91` |
| `gbrain/search/expansion` (1) | `src/core/search/expansion.ts` | `expandQuery` (1). Passed as `expandFn`, never called directly | `eval/runner/longmemeval.ts:86`, `:1353` |
| `gbrain/ai/invocation-guard` (2) | `src/core/ai/invocation-guard.ts` | `withAIInvocationGuard` (2) | `eval/runner/skillopt-method/rollouts.ts:37` |
| `gbrain/core/model-pricing` (1) | `src/core/model-pricing.ts` | `canonicalLookup` (1) | `eval/runner/budget-ledger.ts:79` |
| `gbrain/transcription` (dyn, 1) | `src/core/transcription.ts` | `transcribe` via `mod.transcribe` (dynamic `import`) | `eval/runner/cat11-multimodal.ts:479` |
| `gbrain/package.json` | not in export map | none (only in comments in `eval/runner/gbrain-version.ts:5-7`) | n/a |

The bare `gbrain` specifier appears only as `import.meta.resolve('gbrain')` / `Bun.resolveSync('gbrain', ...)` in `eval/runner/gbrain-version.ts:28` and `test/eval/no-provider-keys-gbrain-source.test.ts:6`. Both are resolve-only.

### 1.2 `gbrain-cues/*` (pin 939232f)

| Specifier | Resolves to | Symbols (files) | Example |
|---|---|---|---|
| `gbrain-cues/pglite-engine` (3) | `src/core/pglite-engine.ts` | `PGLiteEngine` (3) | `eval/runner/longmemeval-m-pilot-replay.ts:5` |
| `gbrain-cues/operations` (1) | `src/core/operations.ts` | `operationsByName` (1) | `test/eval/longmemeval-m-pilot-replay.test.ts:8` |
| `gbrain-cues/search/hybrid` (1) | `src/core/search/hybrid.ts` | `hybridSearch` (1) | `eval/runner/longmemeval-m-pilot-replay.ts:6` |
| `gbrain-cues/ai/gateway` (1 static, 8 total) | `src/core/ai/gateway.ts` | `configureGateway` (1). Dynamic `await import('gbrain-cues/ai/gateway')` in cues tests and `longmemeval-m-pilot-replay.ts:182` | `eval/runner/longmemeval-m-pilot-replay.ts:7` |
| `gbrain-cues/import-file` (1 static, 3 total) | `src/core/import-file.ts` | `importFromContent` (1) | `eval/runner/longmemeval-m-pilot-import-check.ts:5` |
| `gbrain-cues/types` (2) | `src/core/types.ts` | type `SearchResult` (2) | `eval/runner/longmemeval-m-pilot-replay.ts:8` |
| `gbrain-cues/engine` (1) | `src/core/engine.ts` | type `BrainEngine` (1) | `eval/runner/longmemeval-m-pilot-live.ts:13` |
| `gbrain-cues/memory-cues` (dyn, 2) | `src/core/memory-cues/index.ts` | `cueSignature`, `memoryCueColumn` (dynamic); exports include `recallMemoryCues`, `runMemoryCueBuild`, `runPendingMemoryCueJob` | `eval/runner/cat36-production.ts:92`; `test/eval/cat36-candidate-integration.test.ts:25` |
| `gbrain-cues/config` (dyn, 3) | `src/core/config.ts` | dynamic `import()` | `test/eval/situation-recall-associative.test.ts:216` |
| `gbrain-cues/contextual-retrieval` (dyn) | `src/core/contextual-retrieval-service.ts` | dynamic | `eval/runner/cat36-production.ts:475` |

### 1.3 `gbrain-reader/*` (pin e78f1c3)

| Specifier | Resolves to | Symbols (files) | Example |
|---|---|---|---|
| `gbrain-reader/eval/longmemeval/reader` (5) | `src/eval/longmemeval/reader.ts` | `READER_MAX_SESSION_CHARS` (3), `resolveReaderConfig` (3), `readerConfigHash` (3), `READER_NOTES_SYSTEM_TEXT` (2), `buildReaderUserText` (1), `generateAnswer` (1); `buildReaderRequest` (test) | `eval/runner/reading-notes-requests.ts:19`; `eval/runner/reading-notes-run.ts:9` |
| `gbrain-reader/ai/gateway` (2) | `src/core/ai/gateway.ts` | `chat` (1), `configureGateway` (1), types `ChatOpts`, `ChatResult` | `eval/runner/reading-notes-run.ts:6` |
| `gbrain-reader/ai/invocation-guard` (2) | `src/core/ai/invocation-guard.ts` | `invokeAI` (1), `withAIInvocationGuard` (1), type `AIInvocationUsage` (1) | `eval/runner/reading-notes-run.ts:7` |
| `gbrain-reader/core/model-pricing` (1) | `src/core/model-pricing.ts` | `canonicalLookup` (1) | `eval/runner/reading-notes-run.ts:8` |
| `gbrain-reader/types` (1) | `src/core/types.ts` | type `SearchResult` (1) | `eval/runner/reading-notes-requests.ts:20` |

Note: `generateAnswer(client: ThinkLLMClient, ...)` in the reader takes gbrain's think client interface, so the reader A/B couples to the think LLM contract.

### 1.4 Deep paths (`node_modules/gbrain*/src/...`)

These bypass the export map. Counts are files.

| Path (under `node_modules/gbrain/src/...` unless noted) | Files | Used for | Example |
|---|---|---|---|
| `core/page-state/projections.ts` (installPageProjection, readProjectionSnapshot) | 1 | identity | `eval/runner/identity.ts:31` |
| `core/embedding-pricing.ts` (lookupEmbeddingPrice) | 4 | budget ledger pricing | `eval/runner/budget-ledger.ts:80` |
| `core/ai/gateway.ts` (configureGateway, chat) | 3 | n2 judge replay, batch capture, precisionmembench | `eval/runner/n2-judge-replay.ts:161`; `eval/runner/batch/w10a-capture.ts:19` |
| `core/ai/build-gateway-config.ts` | 2 | | `eval/runner/batch/w10a-capture.ts:20` |
| `core/search/mode.ts` (loadSearchModeConfig, resolveSearchMode, KNOBS_HASH_VERSION) | 3 | search mode knobs | `eval/runner/cat13-conceptual.ts:102` |
| `core/search/source-boost.ts`, `dedup.ts`, `intent-weights.ts`, `exact-lookup.ts`, `token-budget.ts`, `query-intent.ts`, `transcript-quote.ts` | ~6 | cat13 and cat13b ranking helpers | `eval/runner/cat13-gap-localize.ts:94-104` |
| `core/chunkers/token-estimate.ts` (estimateTokens, cl100kAvailable) | 2 | reading headroom | `eval/runner/reading-headroom.ts:29` |
| `commands/eval-longmemeval.ts` (runEvalLongMemEval) | 2 | batch capture | `test/eval/batch-sources.test.ts:10` |
| `eval/longmemeval/{reader,metrics,adapter,sanitize}.ts` | ~6 | batch sources, p8 custodian | `eval/runner/batch/sources.ts:23-26` |
| `commands/extract-conversation-facts.ts` (runExtractConversationFactsCore) | 1 | cat35 | `eval/runner/cat35-transcript-distill.ts:64` |
| `core/transcripts/ingest.ts` (runTranscriptsIngest), `core/cycle/synthesize.ts` (runPhaseSynthesize) | 1 each | cat35 | `eval/runner/cat35-transcript-distill.ts:63,65` |
| `core/cycle/propose-takes.ts` | 3 | cat15 | `eval/runner/cat15-propose-takes.ts:63` |
| `core/brainstorm/orchestrator.ts` | 1 | cat20 | `eval/runner/cat20-brainstorm.ts:69` |
| `core/eval-contradictions/{judge,types}.ts` | 2 | n2 | `eval/runner/n2-judge-replay.ts:162` |
| `core/entities/resolve.ts`, `resolve-on-save.ts` | 2 | cat23, n4 | `eval/runner/n4-entity-resolution.ts:294` |
| `core/brain-score-recommendations.ts`, `commands/embed.ts` (runEmbedCore) | 1 each | cat19 | `eval/runner/cat19-doctor-remediate.ts:61-62` |
| `core/skillopt/score.ts` (scoreQrels) | 1 | skillopt generator tests | `test/eval/skillopt-gen-heldout.test.ts:208` |
| `core/model-config.ts` (TIER_DEFAULTS) | 1 | model defaults test | `test/eval/model-defaults.test.ts:9` |
| `core/ai/defaults.ts` (DEFAULT_EMBEDDING_*) | 1 | pglite snapshot | `test/support/pglite-snapshot.ts:21` |
| `core/memory-cues/{evidence,providers,types}.ts` | 3 | reference policy tests | `test/eval/situation-recall-reference-policy.test.ts:115` |
| `core/transcripts/claude-code-jsonl.ts` (path string) | 1 | transcript generator | `eval/generators/transcript-distill-gen.ts:618` |
| `core/search/transcript-quote.ts` (fenceTranscriptText), `core/context/turn-context.ts` (renderFactLine) | 3 | fence checks | `test/eval/cat37-memory-poisoning.test.ts:10-11` |
| `core/takes-fence.ts` (parseTakesFence) | 1 | cat40 hidden tool test | `test/eval/cat40-hidden-tool.test.ts:22` |
| `core/runtime-version.ts` (MINIMUM_BUN_VERSION) | 1 | text parse in test | `test/eval/systems-bootstrap.test.ts:21` |
| `src/core/*` via `importGbrain(gut, 'src/...')` | 41 files | Section 1.5 | see below |

For gbrain-cues, the deep path `node_modules/gbrain-cues/src/core/{markdown,markdown-chunks,batch-rows,embedding-context,memory-cues/*}.ts` is used by about 5 `eval/runner/longmemeval-m-pilot-*.ts` files, which parse markdown and build cue windows without going through the cues export map.

### 1.5 `importGbrain(gut, subpath)` (overlay-aware in-process loading)

`importGbrain` (`eval/runner/gbrain-under-test.ts`) is `import(join(gut.root, subpath))`. It loads files by absolute path under the chosen root (pin or overlay). Occurrences by subpath (regex count, multi-hit files counted):

| Subpath | Hits |
|---|---|
| `src/core/pglite-engine.ts` | 18 |
| `src/core/ai/gateway.ts` | 17 |
| `src/core/import-file.ts` | 15 |
| `src/core/operations.ts` | 13 |
| `src/core/search/hybrid.ts` | 11 |
| `src/core/config.ts` | 5 |
| `src/core/ai/invocation-guard.ts` | 5 |
| `src/mcp/dispatch.ts` | 3 (`dispatchToolCall`) |
| `src/core/feedback/{settings,record,rate}.ts` | 3 each |
| `src/core/eval-contradictions/{types,runner,judge}.ts` | 3, 1, 1 |
| `src/core/engine-factory.ts` (`createEngine`) | 3 |
| `src/core/ai/defaults.ts` | 3 |
| `src/core/search/{private-visibility,rerank,token-budget,sql-ranking,eval-pool-depth,mode}.ts` | 2 or 1 each |
| `src/mcp/server.ts` (`handleToolCall`), `src/mcp/tool-defs.ts` | 1 each |
| `src/core/access/caller.ts`, `src/core/access/members.ts`, `src/core/persistence/{service,identity}.ts` | 1-2 each |
| `src/commands/{export,eval-longmemeval,embed}.ts`, `src/cli.ts`, `src/cli/main.ts` | 1 each |
| `src/core/think/index.ts`, `src/core/entities/resolve*.ts`, `src/core/chronicle/*.ts`, `src/core/belief/changes.ts`, `src/core/line-grammar.ts`, `src/core/fts-language.ts`, `src/core/migrate.ts`, `src/core/token-mint.ts`, `src/core/scope.ts`, `src/core/trust/channel.ts`, `src/core/transcripts/detect.ts`, `src/core/minions/tools/brain-allowlist.ts`, `src/core/cycle/edge-contradictions.ts`, `src/core/context/turn-context.ts`, `src/core/ai/build-gateway-config.ts` | 1-2 each |

Full per-file list: Section 3 `gb_subpaths` column.

### 1.6 Engine methods (`BrainEngine` via `engine.X(...)`)

Instances: `new PGLiteEngine()` (91 sites, no-arg constructor, `src/core/pglite-engine.ts:732`); `createEngine(config)` (4 files, `src/core/engine-factory.ts:10`); and a `BrainEngine` typed parameter or field in about 10 more. Connect call forms: `engine.connect({})` (`eval/runner/longmemeval.ts:1269`, default location), `connect({ database_path })` (about 6), `connect({ database_url, poolSize })` (2).

BrainEngine methods called anywhere in `eval/`, `scripts/`, `test/`, `types/`, with the number of files whose text contains `.name(`:

| Method | Files | Method | Files |
|---|---|---|---|
| `disconnect` | 120 | `softDeletePage` | 4 |
| `connect` | 103 | `searchVector` | 4 |
| `initSchema` | 90 | `readPageSnapshot` | 4 |
| `setConfig` | 64 | `listPages` | 4 |
| `executeRaw` | 60 | `addLink` | 3 |
| `getConfig` | 18 | `insertFact` | 2 |
| `getPage` | 15 | `getStats` | 2 |
| `searchKeyword` | 14 | `getLinks` | 2 |
| `getChunks` | 10 | `updateSlug` | 1 |
| `putPage` | 7 | `unsetConfig` | 1 |
| `traversePaths` | 6 | `traversePathsDetailed` | 1 |
| `transaction` | 6 | `sweepSegments` | 1 |
| `deletePage` | 5 | `searchTitles` | 1 |
| `traverseGraph` | 4 | `searchKeywordChunks` | 1 |
|  |  | `getTimeline` | 1 |
|  |  | `getHealth` | 1 |
|  |  | `getBacklinks` | 1 |
|  |  | `findTrajectory` | 1 |

Only names declared on the `BrainEngine` interface (`src/core/engine.ts:830-2890`, about 197 members) were searched. `executeRaw(sql, params)` (`src/core/pglite-engine.ts:2916`) is the raw SQL escape hatch, used by about 60 files for schema or fixture work. Names not on the interface (`query`, `db`, `exec`) do not belong to BrainEngine.

### 1.7 `gbrain/operations` invocation modes

Three ways runners touch operations:

1. Handler dispatch in-process: `op.handler(ctx, params)` (`.handler(` in 31 files). Examples: `eval/runner/tool-bridge.ts:442`, `eval/runner/mcp-contract.ts:160`, `eval/runner/cat24-capture-provenance.ts:325`, `eval/runner/memory-trust/sut.ts:246`.
2. Lookup by name: `operations.find(o => o.name === N)` (`eval/runner/mcp-contract.ts:157`), `operationsByName[name]` (`eval/runner/memory-trust/sut.ts:244`), `operationsByName.delta.handler` (`eval/runner/belief-weekly-probes.ts:166`), `operationsByName.memory_cues.handler` (`eval/runner/longmemeval-m-pilot-live.ts:97`), and a `Map` built from `operations` (`eval/runner/tool-bridge.ts:200,381`).
3. Surface introspection: `operations.filter(op => offered.has(op.name) && !op.mutating && !op.localOnly)` (`eval/runner/skillopt-method/headroom.ts:167,179`); `mcp-contract.ts:486-500` checks every op has a function `handler`.

Operation names invoked, by literal (count of literal `name: 'x'` or lookup sites):

| Operation | Use |
|---|---|
| `get_page` (56 literal) | read, many arms |
| `search` (46) | read, many arms |
| `put_page` (19 + 3 lookups) | write |
| `remember` (17) | write, `eval/runner/cat41/brief-db.ts` and scenarios |
| `query` (8 + 3 lookups) | read |
| `recall` (7) | read |
| `memory_cues` (9 lookups + configure) | cues arms |
| `delta` (1) | belief probes |
| `think` (1), `assemble_evidence` (1) | evidence delivery |
| `list_pages`, `traverse_graph`, `get_links`, `get_backlinks`, `get_timeline`, `get_tags`, `get_stats`, `get_chunks`, `resolve_slugs` | `EXPOSED_READ_TOOLS` in `eval/runner/tool-bridge.ts:41-52` |
| `add_timeline_entry`, `add_link`, `put_page` (dry-run) | `DRY_RUN_TOOLS` in `eval/runner/tool-bridge.ts:59` |

`OperationContext` fields set by runners (from `src/core/ops/contract.ts:477`):

| Field | Set where | Notes |
|---|---|---|
| `engine` | all | BrainEngine instance |
| `config` | all | `{ engine: 'pglite', database_path: ':memory:' }` (`eval/runner/mcp-contract.ts:147`), or `{ engine: 'pglite', embedding_model, embedding_dimensions }` (`eval/runner/longmemeval-m-pilot-live.ts:95`) |
| `logger` | all | `{ info(){}, warn(){}, error(){} }` style |
| `dryRun` | all | |
| `sourceId` | many | `'default'` |
| `remote` | 64 files (129 hits) | `true` in 23 files, `false` in 54. The tool bridge sets `remote: true` (`eval/runner/tool-bridge.ts:395`) to match the MCP posture |
| `transport` | 2 files | `'http'` (`eval/runner/memory-trust/sut.ts:236`) |
| `takesHoldersAllowList` | 4 files | |
| `auth` | not set by evals | `AuthInfo` type is imported only |

Errors: `OperationError` is thrown by gbrain and caught as `err instanceof OperationError` or by duck-typing `name === 'OperationError'` and `toJSON()` (`eval/runner/adapters/claude-sonnet-with-tools.ts:207-210`). The error envelope is serialized back to the model.

### 1.8 `gbrain/ai/gateway` functions (what runners call)

Process-global gateway. Configure once, stub transports for tests, then call `embed`/`chat`/`toolLoop`/`rerank`. Full signatures are in Section 2. Usage:

- `configureGateway` (30 static files, 78 including dynamic and test): every live runner sets embedding or chat models before first use.
- Test seams `__set*TransportForTests` (19 for embed, 5 chat, 1 each for generate-text, generate-object, rerank): keyless stubs. Hermetic runners rely on these.
- `chat` (3 static files; 45 files contain a `chat(` call, mostly test mocks). Real calls: `eval/runner/longmemeval-answers.ts:259`, `eval/runner/a4-abstention.ts:392` (via `gw.chat`), `eval/runner/cat36-grounded-answers.ts:132`, `eval/runner/skillopt-method/one-shot.ts:32`.
- `toolLoop`: one call, `eval/runner/skillopt-method/rollouts.ts:271`.
- `embed` (gateway): `test/eval/systems-conformance.test.ts:212`. Runner embeddings mostly go through `gbrain/embedding`.
- `validateModelId`, `getEmbeddingDimensions`, `getEmbeddingModel`, `getExpansionModel`, `getChatModel`, `diagnoseEmbedding`, `resetGateway`: model-id and provenance receipts (`eval/runner/longmemeval.ts:1123-1141`, `eval/runner/relational-ab.ts:40`).

### 1.9 Other modules (summary)

- `gbrain/core/skillopt` is the SkillOpt optimizer. `runSkillOpt` is called in `test/eval/*` and `eval/runner/skillopt-method/*`; `runRollout`, `scoreSkillPerTask`, `loadHeldOut`, `describeJudges`, `rolloutToolsForSkill` are called from `eval/runner/skillopt-method/*` and `cat30-33`. `scoreSkillOnTasks` has no direct call in `eval/` (test names only).
- `gbrain/think` `runThink(engine, { question, anchor?, rounds?, save?, take? })` is called by cat14, cat25, cat29 and precisionmembench, with a client-injected `ThinkLLMClient` (the Anthropic messages shape). That keeps the LLM outside gbrain.
- `gbrain/extract` `runExtract(engine, argv)` takes CLI-style argv, so it is an in-process CLI call. It runs `extract links --source db` and `extract --stale` style steps.
- `gbrain/link-extraction` is the deterministic parser: `extractPageLinks`, `extractEntityRefs`, `parseTimelineEntries`. It is called without an LLM in adversarial, type-accuracy, cat6, cat27.
- `gbrain/config`: `loadConfig()` reads `GBRAIN_HOME` (`~/.gbrain/config.json`, `.env`). `hermetic-env.ts` sets GBRAIN_HOME to a fresh temp dir so no keys are read back in.
- `gbrain/search/hybrid` `hybridSearch(engine, query, opts)`: 27 files contain a call, across cat13/cat18/cat21/cat26, longmemeval, live-recall and precisionmembench. Several runners set `expansion: false` explicitly (for example `eval/runner/longmemeval.ts:1347`, `eval/runner/live-recall/task-arms.ts`).

---

## 2. Signatures of used symbols at the pins

One line each. File:line is in the pinned tree. Signatures are abbreviated where the options object is long; the options type is named.

### 2.1 gbrain 6ce7195 (`src/...`)

| Symbol | Pinned file:line | Signature |
|---|---|---|
| `BrainEngine` (interface) | `src/core/engine.ts:830` | `interface BrainEngine { readonly kind: 'postgres'\|'pglite'; connect(config: EngineConfig): Promise<void>; disconnect(); initSchema(); ... ~197 members }` |
| `MAX_SEARCH_LIMIT` | `src/core/engine.ts:821` | `const MAX_SEARCH_LIMIT = 100` |
| `clampSearchLimit` | `src/core/engine.ts:824` | `(limit: number \| undefined, defaultLimit = 20, cap = MAX_SEARCH_LIMIT): number` |
| `EngineConfig` | `src/core/types.ts:2340` | `{ database_url?, database_path?, engine?: 'postgres'\|'pglite', keyword_statement_timeout_ms?, pglite_shared_buffers?, pool_max? }` |
| `PGLiteEngine` (class) | `src/core/pglite-engine.ts:732` | `class PGLiteEngine implements BrainEngine` (constructed with no arguments by evals) |
| `computeSnapshotSchemaHash` | `src/core/pglite-engine.ts:369` | `(crypto: typeof import('node:crypto'), fs: typeof import('node:fs')): string \| null` |
| `executeRaw` (method) | `src/core/pglite-engine.ts:2916` | `executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<T[]>` |
| `createEngine` | `src/core/engine-factory.ts:10` | `(config: EngineConfig): Promise<BrainEngine>` |
| `importFromContent` | `src/core/import-file.ts:254` | `(engine: BrainEngine, slug: string, content: string, opts: { noEmbed?, sourceId?, prepare?, coordinated?, existingSnapshot?, prepareFrontmatter?, ... }): Promise<ImportResult>` (result carries `embedding_deferred` since v0.59.10.0, see `eval/runner/import-embedded.ts`) |
| `importFromFile` | `src/core/import-file.ts:1025` | `(engine, filePath: string, relativePath: string, opts: { noEmbed?, inferFrontmatter?, sourceId?, forceRechunk?, activePack?, ... })` |
| `hybridSearch` | `src/core/search/hybrid.ts:1086` | `(engine: BrainEngine, query: string, opts?: HybridSearchOpts): Promise<SearchResult[]>` |
| `HybridSearchOpts` | `src/core/search/hybrid.ts:842` | `extends SearchOpts { expansion?, anyWordFill?, decide?, aliasTokenHop?, onRelationalMeta?, mode?, expandFn?: (q: string) => Promise<string[]>, ... }` |
| `RRF_K` / `PRE_FUSION_POOL_FLOOR` | `src/core/search/hybrid.ts:58` / `:68` | `const RRF_K = 60` / `const PRE_FUSION_POOL_FLOOR = 50` |
| `rrfFusionWeighted` | `src/core/search/hybrid.ts:1467` | `(lists: FusionListEntry[], applyBoost: boolean \| number = true, attribute = false): SearchResult[]` |
| `runPostFusionStages` | `src/core/search/hybrid.ts:543` | exported async function, options `PostFusionOpts` (`:473`) |
| `cosineReScore` / `cosineSimilarity` | `src/core/search/cosine-rescore.ts:37` / `:133` | `cosineReScore(...)` async; `cosineSimilarity(a: Float32Array, b: Float32Array): number`, re-exported by hybrid.ts:1556 |
| `applyAliasHop` | `src/core/search/alias-hop.ts:141` | async, re-exported by hybrid.ts:29 |
| `shouldBoostCompiledTruth` | `src/core/search/hybrid.ts:92` | `(detail: string \| null \| undefined): boolean` |
| `stampUnverifiedExtractions` | `src/core/search/hybrid.ts:178` | async exported |
| `SearchResult` (type) | `src/core/types.ts:846` | `{ slug, page_id, title, type, chunk_text, chunk_source: 'compiled_truth'\|'timeline'\|'fenced_code', chunk_id, chunk_index, score, stale: boolean \| {held_since, last_indexed_revision}, content_flag? }` |
| `HybridSearchMeta` (type) | `src/core/types.ts:2174` | `{ vector_enabled, decide?, rerank?: {model_resolved}, answerability?, detail_resolved: 'low'\|'medium'\|'high'\|null, expansion_applied, intent?, adaptive_return?, ... }` |
| `PageInput` (type) | `src/core/types.ts:234` | `{ type, title, compiled_truth, timeline?, frontmatter?, tags?, content_hash? }` |
| `SearchOpts` (type) | `src/core/types.ts:1247` | `extends PageReadPolicy { limit?, offset?, onVectorPoolMeta?, ... }` |
| `PageType` (type) | `src/core/types.ts:28` | `type PageType = string` |
| `BrainHealth` (type) | `src/core/types.ts:1912` | health report interface |
| `ResolvedColumn` (type) | `src/core/types.ts` | column descriptor for embeddings |
| `operations` | `src/core/operations.ts:146` | `const operations: Operation[]` (spliced cluster arrays; `finalizeOperation` applied) |
| `operationsByName` | `src/core/operations.ts:247` | `Record<string, Operation>` |
| `OperationError` (class) | `src/core/ops/contract.ts:72` | `class OperationError extends Error { detail?; protocolVersion?; toJSON() }` |
| `Operation` (type) | `src/core/ops/contract.ts:826` | `{ name, description, params: Record<string, ParamDef>, callShape?, handler(ctx: OperationContext, params: Record<string, unknown>): Promise<unknown>, outputRedaction, mutating?, writeInference?, idempotent?, scope?, requiredScopes?, localOnly? }` |
| `OperationContext` (type) | `src/core/ops/contract.ts:477` | `{ engine: BrainEngine, config: GBrainConfig, logger: Logger, dryRun: boolean, auth?: AuthInfo, remote: boolean, transport?: 'stdio'\|'http', agentLabel?, emitNotice?, mcpCaller?, surfaceCeiling?, ... }` (plus `sourceId` and `takesHoldersAllowList` used by evals) |
| `ParamDef` (type) | `src/core/ops/contract.ts:260` | `{ type: 'string'\|'number'\|'integer'\|'boolean'\|'object'\|'array', required?, description?, default?, enum?, minimum?, exclusiveMinimum?, minItems?, actsWhenTrue? }` |
| `AuthInfo` (type) | `src/core/ops/contract.ts:295` | `{ token, clientId, principal?, member? }` |
| `embed` (embedding.ts) | `src/core/embedding.ts:39` | `(text: string): Promise<Float32Array>` |
| `embedQuery` | `src/core/embedding.ts:43` | `(text: string, opts?: { embeddingModel?, dimensions?, abortSignal?, queryPrefix? }): Promise<Float32Array>` |
| `embedBatch` | `src/core/embedding.ts:80` | `(texts: string[], options?: EmbedBatchOptions): Promise<Float32Array[]>` |
| `configureGateway` | `src/core/ai/gateway.ts:470` | `(config: AIGatewayConfig): void` (`AIGatewayConfig` in `src/core/ai/types.ts:494`: `embedding_model?`, `embedding_dimensions?`, `embedding_multimodal_model?`, ...) |
| `__setEmbedTransportForTests` | `src/core/ai/gateway.ts:797` | `(fn: EmbedManyFn \| null): void` |
| `__setChatTransportForTests` | `src/core/ai/gateway.ts:839` | `(fn: ((opts: ChatOpts) => Promise<ChatResult>) \| null): void` |
| `__setGenerateTextTransportForTests` | `src/core/ai/gateway.ts:813` | `(fn: GenerateTextFn \| null): void` |
| `__setGenerateObjectTransportForTests` | `src/core/ai/gateway.ts:824` | `(fn: GenerateObjectFn \| null): void` |
| `__setRerankTransportForTests` | `src/core/ai/gateway.ts:4346` | `(fn: RerankTransport \| null): void` |
| `resetGateway` | `src/core/ai/gateway.ts:767` | `(): void` |
| `getEmbeddingModel` / `getEmbeddingDimensions` | `src/core/ai/gateway.ts:861` / `:872` | `(): string` / `(): number` |
| `getExpansionModel` | `src/core/ai/gateway.ts:895` | `(): string` |
| `getChatModel` | `src/core/ai/gateway.ts:909` | `(): string` |
| `diagnoseEmbedding` | `src/core/ai/gateway.ts:958` | `(modelOverride?: string): EmbeddingDiagnosis` |
| `embed` (gateway) | `src/core/ai/gateway.ts:1625` | `(texts: string[], opts?: EmbedOpts): Promise<Float32Array[]>` (calls `refuseUnscoped()` first) |
| `EmbedOpts` (type) | `src/core/ai/gateway.ts:1588` | `{ abortSignal?, maxRetries?, ... }` |
| `chat` | `src/core/ai/gateway.ts:3579` | `(opts: ChatOpts): Promise<ChatResult>` |
| `ChatOpts` (type) | `src/core/ai/gateway.ts:3150` | `{ model?, system?, messages: ChatMessage[], tools?, maxTokens?, temperature?, abortSignal?, timeoutMs?, providerOptions?, cacheSystem?, ... }` |
| `ChatResult` (type) | `src/core/ai/gateway.ts:3116` | `{ text, blocks: ChatBlock[], stopReason: 'end'\|'tool_calls'\|'length'\|'refusal'\|'content_filter'\|'other', usage: {input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens?}, model, responseModel?, providerId, providerMetadata?, fallbackFrom?, fallbackReason? }` |
| `toolLoop` | `src/core/ai/gateway.ts:4056` | `(opts: ToolLoopOpts): Promise<ToolLoopResult>`; `ToolLoopOpts` `:3937` `{ model?, system?, initialMessages, tools, toolHandlers: Map<string, ToolHandler>, maxTurns? (20), maxTokens? (4096), abortSignal?, cacheSystem?, replayState? }`; `ToolLoopResult` `:4031` `{ finalText, totalTurns, totalUsage, stopReason, messages }` |
| `validateModelId` | `src/core/ai/gateway.ts:3263` | `(modelStr: string, touchpoint: TouchpointKind = 'chat'): ModelIdValidity` |
| `rerank` | `src/core/ai/gateway.ts:4352` | `(input: RerankInput): Promise<RerankResult[]>`; `RerankInput` `:4316` `{ query, documents: string[], topN?, model?, signal?, timeoutMs? (5000), onMeta? }`; `RerankResult` `:4331` `{ index, relevanceScore }` |
| `withAIInvocationGuard` | `src/core/ai/invocation-guard.ts:30` | `<T>(guard: AIInvocationGuard, run: () => Promise<T>, opts?: { inherit?: boolean }): Promise<T>` |
| `extractPageLinks` | `src/core/link-extraction.ts:844` | `(slug, content, frontmatter: Record<string, unknown>, pageType: PageType, resolver: SlugResolver, opts?: ExtractPageLinksOptions): Promise<PageLinksResult>` |
| `extractEntityRefs` | `src/core/link-extraction.ts:409` | `(content: string): EntityRef[]` |
| `parseTimelineEntries` | `src/core/link-extraction.ts:2217` | `(content: string): TimelineCandidate[]` |
| `SlugResolver` (interface) | `src/core/link-extraction.ts:1674` | `{ resolveAttendance?(name: string, dirHint?: string \| string[]): Promise<string \| null>; resolve(name: string, dirHint?: string \| string[], opts?: ResolveOptions): Promise<string \| null> }` |
| `runExtract` | `src/commands/extract.ts:929` | `(engine: BrainEngine, args: string[], authority?: { remote: boolean })` (CLI-argv shaped) |
| `expandQuery` | `src/core/search/expansion.ts:57` | `(query: string): Promise<string[]>` |
| `runThink` | `src/core/think/index.ts:625` | `(engine: BrainEngine, opts: RunThinkOpts): Promise<ThinkResult>` |
| `RunThinkOpts` | `src/core/think/index.ts:71` | `{ question, anchor?, rounds?, save?, take?, ... }` |
| `ThinkLLMClient` | `src/core/think/index.ts:50` | `{ create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: {signal?}): Promise<Anthropic.Message> }` |
| `ThinkResult` | `src/core/think/index.ts:185` | `{ question, answer, citations, gaps, pagesGathered, takesGathered, graphHits, modelUsed, rounds, warnings: string[] }` |
| `ThinkResponse` | `src/core/think/index.ts:164` | `{ answer, citations: {page_slug, row_num, citation_index?}[], gaps: string[] }` |
| `loadConfig` | `src/core/config.ts:716` | `(): GBrainConfig \| null` (reads `GBRAIN_HOME` config and `.env`) |
| `configPath` | `src/core/config.ts:1996` | `(): string` |
| `GBrainConfig` (type) | `src/core/config.ts:36` | `{ engine: 'postgres'\|'pglite', push?, ... }` |
| `canonicalLookup` | `src/core/model-pricing.ts:294` | `(modelId: string \| null \| undefined): ModelPricing \| undefined` |
| `runSkillOpt` | `src/core/skillopt/orchestrator.ts:175` | `(opts: SkillOptOpts): Promise<RunSkillOptResult>` |
| `runRollout` | `src/core/skillopt/rollout.ts:87` | `(opts: RolloutOpts): Promise<Trajectory>` |
| `rolloutToolsForSkill` | `src/core/skillopt/rollout.ts:53` | `(skillText: string): ReadonlySet<string>` |
| `scoreSkillPerTask` | `src/core/skillopt/validate-gate.ts:274` | `(opts: ScoreOnTasksOpts): Promise<PerTaskScore>` |
| `scoreSkillOnTasks` | `src/core/skillopt/validate-gate.ts:301` | `(opts: ScoreOnTasksOpts): Promise<number>` |
| `loadHeldOut` | `src/core/skillopt/held-out.ts:98` | `(heldOutPath: string): BenchmarkTask[]` |
| `describeJudges` | `src/core/skillopt/reflect.ts:83` | `(tasks: ReadonlyArray<{ judge: Judge }>): string` |
| `scoreTrajectory` | `src/core/skillopt/score.ts` | exported; used once in `test/eval/skillopt-method-v3.test.ts:553` |
| `SKILLOPT_HOOK_BUDGET_EXHAUSTED` | `src/core/skillopt/must-abort.ts:18` | `= 'skillopt_hook_budget_exhausted'` |
| `BenchmarkTask` (type) | `src/core/skillopt/types.ts:46` | `{ task_id: string; task: string; judge: Judge }` |
| `transcribe` | `src/core/transcription.ts:55` | `async (...)` (reached only via dynamic import in cat11) |

### 2.2 gbrain-reader e78f1c3 (`src/eval/longmemeval/reader.ts`)

| Symbol | Line | Signature |
|---|---|---|
| `READER_MAX_TOKENS` | `:36` | `= 512` |
| `READER_MAX_SESSION_CHARS` | `:45` | `= 60_000` |
| `READER_NOTES_SYSTEM_TEXT` | `:62` | string constant (derived from `READER_SYSTEM_TEXT`) |
| `resolveReaderConfig` | `:77` | `(input: { mode?: string; maxTokens?: number } = {}): ReaderConfig` |
| `readerConfigHash` | `:90` | `(config: ReaderConfig, model: string): string` |
| `buildReaderUserText` | `:115` | `(input: ReaderUserTextInput): string` |
| `buildReaderRequest` | `:123` | `(input, model: string, config?: ReaderConfig)` |
| `generateAnswer` | `:147` | `(client: ThinkLLMClient, question: {question, question_date?}, results: readonly SearchResult[], pages: ReadonlyArray<{slug, content, date?}>, slugToRaw: SlugToRawMap, model: string, trajectoryBlock = '', config = resolveReaderConfig()): Promise<ReaderAnswer>` |
| `invokeAI` | e78f1c3 `src/core/ai/invocation-guard.ts:41` | `<T>(call: AIInvocation, run: () => Promise<T>, usage: (result: T) => AIInvocationUsage \| null \| Promise<...>)` |
| `canonicalLookup` | `src/core/model-pricing.ts:208` | same contract as gbrain's |

### 2.3 gbrain-cues 939232f (`src/core/memory-cues/index.ts` and friends)

| Symbol | Location | Signature |
|---|---|---|
| `configureGateway` | `src/core/ai/gateway.ts:463` | `(config: AIGatewayConfig): void` |
| `hybridSearch` | `src/core/search/hybrid.ts:1227` | `(engine, query, opts?): Promise<SearchResult[]>` |
| `recallMemoryCues` | `src/core/memory-cues/recall.ts:33` | `(engine: BrainEngine, queryEmbedding: Float32Array, ...)` |
| `memoryCueColumn` | `src/core/memory-cues/settings.ts:34` | `(engine: BrainEngine): Promise<ResolvedColumn>` |
| `cueSignature` | `src/core/memory-cues/settings.ts:41` | `(column: ResolvedColumn): string` |
| `CUE_SYSTEM_PROMPT` / `formatCueEvidence` | `src/core/memory-cues/evidence.ts:19` / `:37` | prompt constant / `(evidence: string, includeBridge: boolean)` |
| `liveMemoryCueProviders` | `src/core/memory-cues/providers.ts:17` | provider object used by a live OpenRouter test |

### 2.4 Rust-port notes on shape

- `SearchResult.chunk_source` is a closed enum (`compiled_truth`, `timeline`, `fenced_code`); `stale` is a union `bool | {held_since, last_indexed_revision}`.
- `ChatResult.stopReason` is a closed enum of six values. `usage` has four required token counts and one optional reasoning count.
- `OperationContext.remote` is the trust boundary (remote callers get fenced reads and write gating). Evals set it explicitly, so the Rust port must keep the flag.
- `ParamDef.type` is a closed set of six JSON types. Operation handlers take `Record<string, unknown>` and validate in code, not in the schema.

---

## 3. Matrix: file x import specifier (grouped by runner family)

Columns: `family`, `file`, `class`, `overlay_flag` (Y if the file mentions `--gbrain` or `gbrainSpecFrom`), `static_specs(symbols)` (`T:` prefix means type-only), `dynamic_specs` (`${var}` means a path or product alias), `gb_subpaths` (`importGbrain` targets), `deep_node_modules_paths`.

Class meaning:

- PIN-STATIC: runtime static import of `gbrain*` in the file. Always loads the installed alias, regardless of `--gbrain`.
- OVERLAY-CAPABLE: imports `gbrain-under-test.ts` and loads modules through `importGbrain`. Honors `--gbrain`.
- MIXED: both (overlay for some modules, pin for others). Only `eval/runner/relational-ab.ts` and `test/eval/skillopt-rollout-empty-args.test.ts`.
- DYN-PATH: loads by variable path or alias (`${productPackage}/...`, `join(root, ...)`). Honors whichever root or alias the caller supplies.
- DEEP-PATH-ONLY: only `node_modules/gbrain*/src/...` relative or string paths, or type-only imports.

Counts: PIN-STATIC 83 (eval 54, test 26, docs 3), OVERLAY-CAPABLE 50 (eval 40, test 10), MIXED 2, DYN-PATH 66, DEEP-PATH-ONLY 48.

Table below (CSV). Regenerate with the script described in the Method note.

```csv
family,file,class,overlay_flag,static_specs(symbols),dynamic_specs,importGbrain_subpaths,deep_node_modules_paths
"docs(repro-scripts)","docs/audit/2026-11-04-superiority-p/recompute.ts",DEEP-PATH-ONLY,,"","","","gbrain/docs/eval/decisions"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-capability-matrix/probes/p10-volunteer.ts",DYN-PATH,,"","${G}/context/volunteer.ts; ${G}/operations.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-capability-matrix/probes/p11-embed.ts",DYN-PATH,,"","${G}/ai/gateway.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-capability-matrix/probes/p4-contradictions.ts",DYN-PATH,,"","${G}/eval-contradictions/date-filter.ts; ${G}/eval-contradictions/runner.ts; ${G}/ops/insights.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-capability-matrix/probes/p5-crag.ts",DYN-PATH,,"","${G}/ai/decide/answerable.ts; ${G}/search/crag.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-capability-matrix/probes/p6-gmail.ts",DYN-PATH,,"","${G}/google/loop-detect.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-capability-matrix/probes/p7-relational.ts",DYN-PATH,,"","${G}/search/relational-intent.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-capability-matrix/probes/p8-transcripts.ts",DYN-PATH,,"","${G}/conversation-parser/builtins.ts; ${G}/conversation-parser/parse.ts; ${G}/transcripts/detect.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-capability-matrix/probes/p9-code.ts",DYN-PATH,,"","${G}/ops/code-intel.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n1-n5/repro/n1-1-ontology-propose-managed.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/cli.ts"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n1-n5/repro/n1-2-ontology-revert-noop.ts",DYN-PATH,,"","${root}/operations.ts; ${root}/pglite-engine.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n1-n5/repro/n1-3-ontology-private-remote.ts",DYN-PATH,,"","${root}/operations.ts; ${root}/pglite-engine.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n12-format-fidelity/repros/n12-1-bold-label-note.ts",DYN-PATH,,"","${G}/conversation-parser/parse.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n12-format-fidelity/repros/n12-2-offset-timestamp-roundtrip.ts",DYN-PATH,,"","${G}/conversation-parser/parse.ts; ${G}/transcripts/claude-export.ts; ${G}/transcripts/render.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n12-format-fidelity/repros/n12-7-legacy-pack-attendance.ts",DYN-PATH,,"","${G}/operations.ts; ${G}/pglite-engine.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n13-code-intelligence/repros/n13-1-merged-arrow-defs.ts",DYN-PATH,,"","${G}/core/import-file.ts; ${G}/core/pglite-engine.ts; ${G}/mcp/server.ts","","gbrain/src"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n13-code-intelligence/repros/n13-2-resolved-flag.ts",DYN-PATH,,"","${G}/core/chunkers/symbol-resolver.ts; ${G}/core/import-file.ts; ${G}/core/pglite-engine.ts; ${G}/mcp/server.ts","","gbrain/src"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n13-code-intelligence/repros/n13-3-shared-name-language-gate.ts",DYN-PATH,,"","${G}/core/chunkers/symbol-resolver.ts; ${G}/core/import-file.ts; ${G}/core/pglite-engine.ts; ${G}/mcp/server.ts","","gbrain/src"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n2-contradiction-surfacing/repro/n2-1-undated-page-gets-a-date.ts",DYN-PATH,,"","${G}/eval-contradictions/runner.ts; ${G}/operations.ts; ${G}/pglite-engine.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n2-contradiction-surfacing/repro/n2-2-find-contradictions-default-cli.ts",DYN-PATH,,"","${G}/ops/insights.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n7-open-loops-email/repro/_thread.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-1-nudge-backfill.ts",DYN-PATH,,"","${G}/google/loop-detect.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-2-thanks-closes.ts",DYN-PATH,,"","${G}/google/loop-detect.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-3-fulfillment-gap.ts",DYN-PATH,,"","${G}/google/loop-detect.ts; ${G}/loops/loops-store.ts; ${G}/pglite-engine.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-5-ranking-clock.ts",DYN-PATH,,"","${G}/loops/loops-store.ts; ${G}/operations.ts; ${G}/pglite-engine.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-6-age-from-detection.ts",DYN-PATH,,"","${G}/google/loop-detect.ts; ${G}/pglite-engine.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-7-url-question-mark.ts",DYN-PATH,,"","${G}/google/loop-detect.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n8-proactive-recall/repro/_brain.ts",DYN-PATH,,"","${G}/import-file.ts; ${G}/operations.ts; ${G}/pglite-engine.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-01-n8-proactive-recall/repro/n8-2-private-turn-context.ts",DYN-PATH,,"","${G}/context/turn-context.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-03-wave7-repin/repros/n13-8-member-call.ts",DYN-PATH,,"","${G}/core/chunkers/symbol-resolver.ts; ${G}/core/import-file.ts; ${G}/core/pglite-engine.ts; ${G}/mcp/server.ts","","gbrain/src"
"docs(repro-scripts)","docs/benchmarks/2026-10-03-wave7-repin/repros/n7-5-as-of-pins-order.ts",DYN-PATH,,"","${G}/loops/loops-store.ts; ${G}/operations.ts; ${G}/pglite-engine.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-03-wave7-repin/repros/n7-6-request-time-age.ts",DYN-PATH,,"","${G}/google/loop-detect.ts; ${G}/pglite-engine.ts","","gbrain/src/core"
"docs(repro-scripts)","docs/benchmarks/2026-10-04-longmemeval-opaque-followups/scripts/driver-retrieval-at.ts",DYN-PATH,,"","${SRC}/src/commands/eval-longmemeval.ts; ${SRC}/src/core/ai/build-gateway-config.ts; ${SRC}/src/core/ai/gateway.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-04-longmemeval-opaque-followups/scripts/driver-retrieval.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/commands/eval-longmemeval.ts; gbrain/src/core/ai/build-gateway-config.ts; gbrain/src/core/ai/gateway.ts"
"docs(repro-scripts)","docs/benchmarks/2026-10-04-longmemeval-opaque-followups/scripts/knobs.ts",DYN-PATH,,"","${dir}/src/core/search/mode.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-04-longmemeval-opaque-followups/scripts/lib.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/ai/build-gateway-config.ts; gbrain/src/core/ai/gateway.ts; gbrain/src/eval/longmemeval/judge.ts; gbrain/src/eval/shared/judge-runner.ts"
"docs(repro-scripts)","docs/benchmarks/2026-10-04-operator-wave-repin/run-repros.ts",DEEP-PATH-ONLY,,"","","","gbrain/package.json"
"docs(repro-scripts)","docs/benchmarks/2026-10-04-p7-multi-hop-planner/probes/p7-falsefire.ts",DYN-PATH,,"","${EVALS}/eval/runner/queries/index.ts; ${gbrain}/src/core/search/relational-plan.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-05-hangul-mention-boundaries/scripts/scan.ts",DYN-PATH,,"","${gbrain}/src/core/by-mention.ts; ${gbrain}/src/core/pglite-engine.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-06-followups-repin/run-repros.ts",DEEP-PATH-ONLY,,"","","","gbrain/package.json"
"docs(repro-scripts)","docs/benchmarks/2026-10-13-cat40-dev-gate/run.ts",DYN-PATH,,"","${H}/eval/runner/cat40/gbrain-arm.ts; ${H}/eval/runner/lifecycle/builds.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-13-vector-side-early/receipts/warm.ts",DYN-PATH,,"","${root}/scripts/bench-refactor-wave-1.ts; ${root}/src/core/ai/build-gateway-config.ts; ${root}/src/core/ai/gateway.ts; ${root}/src/core/config.ts; ${root}/src/core/engine-factory.ts; ${root}/src/core/operations.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-14-f5-messy-company/build.ts",DYN-PATH,,"","${G}/commands/extract.ts; ${G}/core/cli-options.ts; ${G}/core/pglite-engine.ts; ${G}/core/search/private-visibility.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-10-14-f5-messy-company/score.ts",DYN-PATH,,"","${E}/runner/messy-company/common.ts; ${E}/runner/messy-company/score-owner-phrases.ts","",""
"docs(repro-scripts)","docs/benchmarks/2026-11-01-skillopt-rebaseline/scripts/frontier-probe.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{configureGateway}; gbrain/core/skillopt{loadHeldOut,scoreSkillOnTasks}","","",""
"docs(repro-scripts)","docs/benchmarks/2026-11-01-skillopt-rebaseline/scripts/repro-success-reflect.ts",PIN-STATIC,,"gbrain/ai/gateway{chat,configureGateway}","","","gbrain/src/core/skillopt/reflect.ts"
"docs(repro-scripts)","docs/benchmarks/2026-11-02-skillopt-ceiling/runs/get-page-replay/replay.ts",PIN-STATIC,,"gbrain/core/skillopt{BenchmarkTask,runRollout}","","","gbrain/VERSION"
"docs(repro-scripts)","docs/benchmarks/p2-e2-consumers/run.ts",DYN-PATH,,"","${WT}/src/core/ai/gateway.ts; ${WT}/src/core/chronicle/extract-events.ts; ${WT}/src/core/cycle/extract-atoms-schema.ts; ${WT}/src/core/cycle/extract-atoms.ts; ${WT}/src/core/cycle/propose-takes.ts; ${WT}/src/core/cycle/synthesize.ts; ${WT}/src/core/minions/handlers/subagent-oneshot.ts","",""
"docs(repro-scripts)","docs/plans/2026-10-08-gbrain-budgeted-delivery/receipts/keyless-delivery-replay.ts",DYN-PATH,,"","${G}/core/ai/gateway.ts; ${G}/core/import-file.ts; ${G}/core/pglite-engine.ts; ${G}/core/search/evidence-delivery.ts; ${G}/core/search/hybrid.ts; ${MQA}/corpus.ts; ${MQA}/qa.ts; ${MQA}/run.ts","",""
"eval/generators","eval/generators/skillopt-method/gen.ts",DEEP-PATH-ONLY,,"","","","gbrain/skills"
"eval/generators","eval/generators/transcript-distill-gen.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/transcripts/claude-code-jsonl.ts"
"eval/harness-provider","eval/harness-provider/mpw_tools/probe-preload.ts",DYN-PATH,,"","${root}/src/core/operations.ts; ${root}/src/core/pglite-engine.ts","",""
"eval/precisionmembench","eval/precisionmembench/gbrainAdapter.ts",PIN-STATIC,,"T:gbrain/engine{BrainEngine}; gbrain/search/hybrid{hybridSearch}; T:gbrain/types{HybridSearchMeta,SearchResult}","","","gbrain/src/core/search/query-intent.ts"
"eval/precisionmembench","eval/precisionmembench/gbrainThinkAdapter.ts",DEEP-PATH-ONLY,,"T:gbrain/engine{BrainEngine}","","","gbrain/src/core/think/index.ts"
"eval/precisionmembench","eval/precisionmembench/seed.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file; gbrain/config{loadConfig}; T:gbrain/engine{BrainEngine}","","","gbrain/src/core/ai/gateway.ts"
"runner/(top)","eval/runner/adversarial.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/link-extraction{SlugResolver,extractPageLinks,parseTimelineEntries}; T:gbrain/types{PageInput}","","",""
"runner/(top)","eval/runner/agent-retrieval-shapes.ts",OVERLAY-CAPABLE,Y,"T:gbrain/config{GBrainConfig}; T:gbrain/operations{OperationContext}; T:gbrain/pglite-engine{PGLiteEngine}","gbrain/operations; gbrain/pglite-engine","src/core/import-file.ts; src/core/operations.ts; src/core/pglite-engine.ts",""
"runner/(top)","eval/runner/before-after.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/extract{runExtract}","","",""
"runner/(top)","eval/runner/belief-weekly-probes.ts",OVERLAY-CAPABLE,Y,"","","src/core/belief/changes.ts; src/core/operations.ts; src/core/search/token-budget.ts; test/helpers/belief-ledger.ts",""
"runner/(top)","eval/runner/budget-ledger.ts",PIN-STATIC,,"gbrain/core/model-pricing{canonicalLookup}","","","gbrain/src/core/embedding-pricing.ts"
"runner/(top)","eval/runner/cat11-multimodal.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file","gbrain/transcription","",""
"runner/(top)","eval/runner/cat13-conceptual.ts",PIN-STATIC,,"gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway,getEmbeddingDimensions,getEmbeddingModel}","","","gbrain/src/core/search/mode.ts"
"runner/(top)","eval/runner/cat13-gap-localize.ts",PIN-STATIC,,"T:gbrain/pglite-engine{PGLiteEngine}; gbrain/embedding{embed,embedQuery}; gbrain/engine{MAX_SEARCH_LIMIT}; gbrain/search/hybrid{PRE_FUSION_POOL_FLOOR,PostFusionOpts,RRF_K,applyAliasHop,cosineReScore,cosineSimilarity,hybridSearch,rrfFusionWeighted,runPostFusionStages,shouldBoostCompiledTruth,stampUnverifiedExtractions}; T:gbrain/types{HybridSearchMeta,SearchOpts,SearchResult}; gbrain/ai/gateway{__setEmbedTransportForTests}","","","gbrain/src/core/search/dedup.ts; gbrain/src/core/search/exact-lookup.ts; gbrain/src/core/search/intent-weights.ts; gbrain/src/core/search/mode.ts; gbrain/src/core/search/query-intent.ts; gbrain/src/core/search/token-budget.ts"
"runner/(top)","eval/runner/cat13-kacf-calibrate.ts",PIN-STATIC,,"gbrain/search/hybrid{hybridSearch}; T:gbrain/types{HybridSearchMeta,SearchResult}; T:gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests}","","",""
"runner/(top)","eval/runner/cat13b-source-swamp.ts",PIN-STATIC,,"gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway}","","","gbrain/src/core/search/source-boost.ts"
"runner/(top)","eval/runner/cat14-calibration.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway}; gbrain/think{ThinkLLMClient,ThinkResult,runThink}","","",""
"runner/(top)","eval/runner/cat15-propose-takes.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/cycle/propose-takes.ts"
"runner/(top)","eval/runner/cat18-embedding-providers.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway,getEmbeddingDimensions}; gbrain/search/hybrid{hybridSearch}; T:gbrain/types{HybridSearchMeta,SearchResult}","","",""
"runner/(top)","eval/runner/cat18b-embedding-rerank-matrix.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests,__setRerankTransportForTests,configureGateway}; gbrain/search/hybrid{hybridSearch}; T:gbrain/types{HybridSearchMeta,SearchResult}","","",""
"runner/(top)","eval/runner/cat19-doctor-remediate.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file; gbrain/extract{runExtract}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway}; T:gbrain/types{BrainHealth}","","","gbrain/src/commands/embed.ts; gbrain/src/core/brain-score-recommendations.ts"
"runner/(top)","eval/runner/cat20-brainstorm.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{ChatOpts,ChatResult,__setEmbedTransportForTests,chat,configureGateway}","","","gbrain/src/core/brainstorm/orchestrator.ts"
"runner/(top)","eval/runner/cat21-code-retrieval.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway}; gbrain/search/hybrid{hybridSearch}; T:gbrain/types{HybridSearchMeta,SearchResult}","","",""
"runner/(top)","eval/runner/cat22-source-isolation.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file; gbrain/ai/gateway{configureGateway}; gbrain/search/hybrid{hybridSearch}","","",""
"runner/(top)","eval/runner/cat23-phantom-redirect.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file","","","gbrain/src/core/entities/resolve.ts"
"runner/(top)","eval/runner/cat24-capture-provenance.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file; gbrain/ai/gateway{configureGateway}; gbrain/operations{OperationContext,operationsByName}","","",""
"runner/(top)","eval/runner/cat25-trajectory-routing.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway}; gbrain/think{ThinkLLMClient,ThinkResult,runThink}","","",""
"runner/(top)","eval/runner/cat26-contextual-retrieval.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway}; gbrain/search/hybrid{hybridSearch}","","","gbrain/src/core/search/mode.ts"
"runner/(top)","eval/runner/cat27-graph-signals.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/link-extraction{extractEntityRefs}; gbrain/search/hybrid{hybridSearch}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway,getEmbeddingDimensions}","","",""
"runner/(top)","eval/runner/cat28-federated-sync-latency.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file; gbrain/ai/gateway{configureGateway}","","",""
"runner/(top)","eval/runner/cat29-think-vs-search.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway}; gbrain/search/hybrid{hybridSearch}; gbrain/think{ThinkLLMClient,ThinkResponse,runThink}","","",""
"runner/(top)","eval/runner/cat30-skillopt-improvement.ts",PIN-STATIC,,"gbrain/import-file; gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{ChatOpts,ChatResult,__setChatTransportForTests,configureGateway}; gbrain/core/skillopt","","",""
"runner/(top)","eval/runner/cat31-skillopt-ablation.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setChatTransportForTests,configureGateway}; gbrain/core/skillopt","","",""
"runner/(top)","eval/runner/cat32-skillopt-reward-hacking.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setChatTransportForTests,configureGateway}; gbrain/core/skillopt","","",""
"runner/(top)","eval/runner/cat33-skillopt-transfer.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setChatTransportForTests,configureGateway}; gbrain/core/skillopt","","",""
"runner/(top)","eval/runner/cat35-transcript-distill.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{configureGateway}; gbrain/import-file","","","gbrain/package.json; gbrain/skills/_brain-filing-rules.json; gbrain/src/commands/extract-conversation-facts.ts; gbrain/src/core/cycle/synthesize.ts; gbrain/src/core/transcripts/ingest.ts"
"runner/(top)","eval/runner/cat36-grounded-answers.ts",DYN-PATH,,"T:gbrain/ai/gateway{ChatResult}","${productPackage}/ai/gateway; ${productPackage}/config; gbrain/ai/gateway; gbrain/config","",""
"runner/(top)","eval/runner/cat36-production.ts",DYN-PATH,,"T:gbrain/engine{BrainEngine}; T:gbrain/operations{OperationContext}; T:gbrain/types{HybridSearchMeta,ResolvedColumn,SearchResult}","${productPackage}/ai/gateway; ${productPackage}/config; ${productPackage}/import-file; ${productPackage}/operations; ${productPackage}/pglite-engine; ${productPackage}/search/hybrid; gbrain-cues/operations; gbrain/ai/gateway; gbrain/config; gbrain/import-file; gbrain/operations; gbrain/pglite-engine; gbrain/search/hybrid","",""
"runner/(top)","eval/runner/cat6-prose-scale.ts",PIN-STATIC,,"gbrain/link-extraction{SlugResolver,extractPageLinks}; T:gbrain/types{PageType}","gbrain/extract; gbrain/import-file; gbrain/pglite-engine","",""
"runner/(top)","eval/runner/constrained-relational.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/gateway.ts; src/core/search/hybrid.ts",""
"runner/(top)","eval/runner/feedback-replay-locomo.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/gateway.ts; src/core/feedback/rate.ts; src/core/feedback/record.ts; src/core/feedback/settings.ts; src/core/import-file.ts; src/core/pglite-engine.ts; src/core/search/hybrid.ts",""
"runner/(top)","eval/runner/feedback-replay-world.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/gateway.ts; src/core/feedback/rate.ts; src/core/feedback/record.ts; src/core/feedback/settings.ts; src/core/search/hybrid.ts",""
"runner/(top)","eval/runner/feedback-think-replay.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/gateway.ts; src/core/feedback/record.ts; src/core/feedback/settings.ts; src/core/import-file.ts; src/core/operations.ts; src/core/pglite-engine.ts",""
"runner/(top)","eval/runner/gbrain-pin.ts",DEEP-PATH-ONLY,,"","","","gbrain/package.json"
"runner/(top)","eval/runner/gbrain-under-test.ts",DEEP-PATH-ONLY,,"gbrain/…{type`}","","",""
"runner/(top)","eval/runner/gbrain-version.ts",DYN-PATH,,"","gbrain; gbrain/package.json; resolve:gbrain; resolve:gbrain/package.json","",""
"runner/(top)","eval/runner/identity.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}","","","gbrain/src/core/page-state/projections.ts"
"runner/(top)","eval/runner/import-embedded.ts",PIN-STATIC,,"gbrain/import-file{that caused it. */ import { importFromContent }}","","",""
"runner/(top)","eval/runner/lifecycle-lite.ts",OVERLAY-CAPABLE,Y,"","","src/core/import-file.ts; src/core/pglite-engine.ts; src/core/search/hybrid.ts",""
"runner/(top)","eval/runner/line-grammar-junk-audit.ts",OVERLAY-CAPABLE,Y,"","","src/core/line-grammar.ts",""
"runner/(top)","eval/runner/longmemeval-answers.ts",DYN-PATH,,"T:gbrain/types{SearchResult}; T:gbrain/ai/gateway{ChatResult}","gbrain; gbrain/ai/gateway; gbrain/config; resolve:gbrain; resolve:gbrain/ai/gateway","",""
"runner/(top)","eval/runner/longmemeval-m-pilot-batch-payload.ts",DEEP-PATH-ONLY,,"","","","gbrain-cues/src/core/batch-rows.ts; gbrain-cues/src/core/embedding-context.ts; gbrain-cues/src/core/markdown-chunks.ts; gbrain-cues/src/core/markdown.ts"
"runner/(top)","eval/runner/longmemeval-m-pilot-build.ts",DYN-PATH,,"","gbrain-cues/ai/gateway","",""
"runner/(top)","eval/runner/longmemeval-m-pilot-feasibility.ts",DEEP-PATH-ONLY,,"","","","gbrain-cues/src/core/batch-rows.ts; gbrain-cues/src/core/embedding-context.ts; gbrain-cues/src/core/markdown-chunks.ts; gbrain-cues/src/core/markdown.ts; gbrain-cues/src/core/memory-cues/providers.ts; gbrain-cues/src/core/memory-cues/windows.ts"
"runner/(top)","eval/runner/longmemeval-m-pilot-hypothetical-cost.ts",DEEP-PATH-ONLY,,"","","","gbrain-cues/src/core/batch-rows.ts; gbrain-cues/src/core/markdown-chunks.ts; gbrain-cues/src/core/markdown.ts; gbrain-cues/src/core/memory-cues/providers.ts"
"runner/(top)","eval/runner/longmemeval-m-pilot-import-check.ts",PIN-STATIC,,"gbrain-cues/pglite-engine{PGLiteEngine}; gbrain-cues/import-file","","","gbrain-cues/src/core/memory-cues/windows.ts"
"runner/(top)","eval/runner/longmemeval-m-pilot-live.ts",DEEP-PATH-ONLY,,"T:gbrain-cues/engine{BrainEngine}","","",""
"runner/(top)","eval/runner/longmemeval-m-pilot-offset-audit.ts",DEEP-PATH-ONLY,,"","","","gbrain-cues/src/core/batch-rows.ts; gbrain-cues/src/core/markdown-chunks.ts; gbrain-cues/src/core/markdown.ts"
"runner/(top)","eval/runner/longmemeval-m-pilot-replay.ts",PIN-STATIC,,"gbrain-cues/pglite-engine{PGLiteEngine}; gbrain-cues/search/hybrid{hybridSearch}; gbrain-cues/ai/gateway{configureGateway}; T:gbrain-cues/types{SearchResult}","gbrain-cues/ai/gateway","",""
"runner/(top)","eval/runner/longmemeval.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/search/hybrid{hybridSearch}; gbrain/search/expansion{expandQuery}; T:gbrain/types{SearchResult}; gbrain/config{loadConfig}; gbrain/embedding{embedQuery}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway,diagnoseEmbedding,getEmbeddingDimensions,getEmbeddingModel,getExpansionModel}","","",""
"runner/(top)","eval/runner/mcp-contract.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/operations{operations}; T:gbrain/operations{OperationContext}; T:gbrain/config{GBrainConfig}","","",""
"runner/(top)","eval/runner/multi-adapter.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/extract{runExtract}","","",""
"runner/(top)","eval/runner/n1-knowledge-update.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{OperationContext}","","src/core/operations.ts; src/core/pglite-engine.ts",""
"runner/(top)","eval/runner/n12-format-fidelity.ts",OVERLAY-CAPABLE,Y,"","","src/core/transcripts/detect.ts",""
"runner/(top)","eval/runner/n14-large-page-fidelity.ts",OVERLAY-CAPABLE,Y,"T:gbrain/pglite-engine{PGLiteEngine}","","src/commands/embed.ts; src/commands/export.ts; src/core/ai/gateway.ts; src/core/import-file.ts; src/core/operations.ts",""
"runner/(top)","eval/runner/n2-3-prompt-ab.ts",OVERLAY-CAPABLE,Y,"","","src/core/eval-contradictions/types.ts",""
"runner/(top)","eval/runner/n2-contradiction-surfacing.ts",OVERLAY-CAPABLE,Y,"","","src/cli.ts; src/cli/main.ts; src/core/eval-contradictions/judge.ts; src/core/eval-contradictions/runner.ts; src/core/eval-contradictions/trends.ts; src/core/eval-contradictions/types.ts; src/core/search/hybrid.ts",""
"runner/(top)","eval/runner/n2-judge-replay.ts",OVERLAY-CAPABLE,Y,"","","src/core/eval-contradictions/types.ts","gbrain/src/core/ai/gateway.ts; gbrain/src/core/eval-contradictions/judge.ts; gbrain/src/core/eval-contradictions/types.ts"
"runner/(top)","eval/runner/n3-temporal-asof.ts",OVERLAY-CAPABLE,Y,"T:gbrain/config{GBrainConfig}; T:gbrain/operations{OperationContext}; T:gbrain/pglite-engine{PGLiteEngine}","gbrain/operations; gbrain/pglite-engine","src/core/chronicle/config.ts; src/core/chronicle/extract-events.ts; src/core/operations.ts; src/core/pglite-engine.ts",""
"runner/(top)","eval/runner/n4-entity-resolution.ts",OVERLAY-CAPABLE,Y,"T:gbrain/engine{BrainEngine}; T:gbrain/operations{Operation,OperationContext}; T:gbrain/config{GBrainConfig}","gbrain/import-file; gbrain/operations; gbrain/pglite-engine","src/core/entities/resolve-on-save.ts; src/core/entities/resolve.ts; src/core/import-file.ts; src/core/operations.ts; src/core/pglite-engine.ts","gbrain/src/core/entities/resolve-on-save.ts; gbrain/src/core/entities/resolve.ts"
"runner/(top)","eval/runner/n4-similar-pages.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{OperationContext}","","src/core/config.ts",""
"runner/(top)","eval/runner/n6-postgres-http.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{Operation,OperationContext}","","",""
"runner/(top)","eval/runner/n6-visibility-fuzz.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{AuthInfo,Operation,OperationContext,ParamDef}","","src/core/minions/tools/brain-allowlist.ts; src/core/operations.ts; src/core/pglite-engine.ts; src/core/scope.ts; src/mcp/dispatch.ts",""
"runner/(top)","eval/runner/n7-open-loops-email.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{OperationContext}","","","gbrain/src/core/connectors/providers/; gbrain/src/core/google/loop-detect.ts"
"runner/(top)","eval/runner/n8-proactive-recall.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{OperationContext}","","",""
"runner/(top)","eval/runner/n9-multi-hop-paraphrase.ts",OVERLAY-CAPABLE,Y,"T:gbrain/pglite-engine{PGLiteEngine}","","",""
"runner/(top)","eval/runner/p5-brain.ts",OVERLAY-CAPABLE,,"T:gbrain/operations{OperationContext}","","src/core/config.ts",""
"runner/(top)","eval/runner/perf.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; T:gbrain/types{PageInput}","","",""
"runner/(top)","eval/runner/precisionmembench-instrument.ts",DEEP-PATH-ONLY,,"T:gbrain/engine{BrainEngine}","","",""
"runner/(top)","eval/runner/precisionmembench-system.ts",OVERLAY-CAPABLE,Y,"","","src/core/import-file.ts; src/core/pglite-engine.ts; src/core/search/hybrid.ts",""
"runner/(top)","eval/runner/reading-headroom.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/chunkers/token-estimate.ts"
"runner/(top)","eval/runner/reading-notes-requests.ts",PIN-STATIC,,"gbrain-reader/eval/longmemeval/reader{READER_MAX_SESSION_CHARS,generateAnswer,readerConfigHash,resolveReaderConfig}; T:gbrain-reader/types{SearchResult}","gbrain-reader/eval/longmemeval/reader; resolve:gbrain-reader/eval/longmemeval/reader","",""
"runner/(top)","eval/runner/reading-notes-run.ts",PIN-STATIC,,"gbrain-reader/ai/gateway{ChatOpts,ChatResult,chat,configureGateway}; gbrain-reader/ai/invocation-guard{AIInvocationUsage,withAIInvocationGuard}; gbrain-reader/core/model-pricing{canonicalLookup}; gbrain-reader/eval/longmemeval/reader{readerConfigHash,resolveReaderConfig}","gbrain-reader/eval/longmemeval/reader; resolve:gbrain-reader/eval/longmemeval/reader","",""
"runner/(top)","eval/runner/relational-ab.ts",MIXED,Y,"T:gbrain/pglite-engine{PGLiteEngine}; gbrain/search/hybrid{HybridSearchOpts,hybridSearch}; T:gbrain/types{HybridSearchMeta,SearchResult}; gbrain/embedding{embedQuery}; gbrain/ai/gateway{__setEmbedTransportForTests,configureGateway,diagnoseEmbedding,getEmbeddingDimensions,getEmbeddingModel}","","src/core/ai/gateway.ts; src/core/embedding.ts; src/core/search/hybrid.ts",""
"runner/(top)","eval/runner/retrieval-pins.ts",DEEP-PATH-ONLY,,"T:gbrain/types{HybridSearchMeta}","","",""
"runner/(top)","eval/runner/situation-recall-associative.ts",DYN-PATH,,"T:gbrain/engine{BrainEngine}; T:gbrain/operations{OperationContext}; T:gbrain/types{HybridSearchMeta}","${productPackage}/ai/gateway; ${productPackage}/config; ${productPackage}/import-file; ${productPackage}/operations; ${productPackage}/pglite-engine; ${productPackage}/search/hybrid; gbrain/ai/gateway; gbrain/config; gbrain/embedding; gbrain/import-file; gbrain/operations; gbrain/pglite-engine; gbrain/search/hybrid","",""
"runner/(top)","eval/runner/situation-recall-cat13b.ts",DYN-PATH,,"","${productPackage}/ai/gateway; ${productPackage}/config; ${productPackage}/operations; gbrain/ai/gateway; gbrain/config; gbrain/operations","",""
"runner/(top)","eval/runner/situation-recall-programmatic.ts",PIN-STATIC,,"gbrain/config{configPath,loadConfig}","","",""
"runner/(top)","eval/runner/smoke.ts",PIN-STATIC,,"gbrain/ai/gateway{configureGateway,embed}","gbrain/ai/gateway","",""
"runner/(top)","eval/runner/temporal-contradictions.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/gateway.ts; src/core/cycle/edge-contradictions.ts; src/core/operations.ts; src/core/pglite-engine.ts",""
"runner/(top)","eval/runner/temporal-edges.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{OperationContext}","","src/core/config.ts",""
"runner/(top)","eval/runner/temporal-ingest-answer.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{OperationContext}","","",""
"runner/(top)","eval/runner/temporal.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}","","",""
"runner/(top)","eval/runner/tool-bridge.ts",PIN-STATIC,,"gbrain/operations{operations}; T:gbrain/operations{Operation,OperationContext,ParamDef}; T:gbrain/engine{BrainEngine}; T:gbrain/config{GBrainConfig}","","",""
"runner/(top)","eval/runner/type-accuracy.ts",PIN-STATIC,,"gbrain/link-extraction{extractPageLinks}; T:gbrain/types{PageType}","${productPackage}/link-extraction; gbrain/link-extraction","",""
"runner/adapters","eval/runner/adapters/claude-sonnet-with-tools.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/operations{OperationError}","","","gbrain/src/core/search/mode.ts."
"runner/adapters","eval/runner/adapters/gbrain-inline.ts",PIN-STATIC,Y,"gbrain/pglite-engine{* as enginePackage}; gbrain/extract{* as extractPackage}; gbrain/search/hybrid{* as searchPackage}; gbrain/import-file{* as importPackage}; gbrain/ai/gateway{* as gatewayPackage}; T:gbrain/types{HybridSearchMeta,SearchResult}","${pkg}/ai/gateway; ${pkg}/extract; ${pkg}/import-file; ${pkg}/pglite-engine; ${pkg}/search/hybrid","",""
"runner/adapters","eval/runner/adapters/vector-grep-rrf-fusion.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/search/hybrid{hybridSearch}; gbrain/ai/gateway{configureGateway}; T:gbrain/types{HybridSearchMeta,SearchResult}","","",""
"runner/adapters","eval/runner/adapters/vector-rerank.ts",OVERLAY-CAPABLE,,"","","src/core/search/rerank.ts",""
"runner/adapters","eval/runner/adapters/vector.ts",PIN-STATIC,,"gbrain/embedding{embed,embedBatch}; gbrain/ai/gateway{configureGateway,getEmbeddingModel}","","",""
"runner/batch","eval/runner/batch/sources.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/eval/longmemeval/adapter.ts; gbrain/src/eval/longmemeval/metrics.ts; gbrain/src/eval/longmemeval/reader.ts; gbrain/src/eval/longmemeval/sanitize.ts"
"runner/batch","eval/runner/batch/w10.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/eval/longmemeval/metrics.ts"
"runner/batch","eval/runner/batch/w10a-capture.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/commands/eval-longmemeval.ts; gbrain/src/core/ai/build-gateway-config.ts; gbrain/src/core/ai/gateway.ts"
"runner/cat41","eval/runner/cat41/brief-db.ts",DYN-PATH,,"","${GB}/core/config.ts; ${GB}/core/context/proactive-brief.ts; ${GB}/core/engine-factory.ts; ${GB}/mcp/resolve-ipc-binding.ts","",""
"runner/graph-backend","eval/runner/graph-backend/pg-load.ts",DYN-PATH,,"","${engineDir}/src/core/pglite-engine.ts; ${engineDir}/src/core/postgres-engine.ts","",""
"runner/graph-backend","eval/runner/graph-backend/worker.ts",DYN-PATH,,"","${engineDir}/src/core/pglite-engine.ts; ${engineDir}/src/core/postgres-engine.ts","",""
"runner/live-recall","eval/runner/live-recall/brain.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/build-gateway-config.ts; src/core/ai/gateway.ts; src/core/config.ts; src/core/engine-factory.ts; src/core/migrate.ts",""
"runner/live-recall","eval/runner/live-recall/run.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/gateway.ts; src/core/import-file.ts; src/core/pglite-engine.ts","gbrain/package.json"
"runner/live-recall","eval/runner/live-recall/synthetic.ts",OVERLAY-CAPABLE,,"","","src/core/ai/gateway.ts; src/core/ai/invocation-guard.ts; src/core/fts-language.ts; src/core/import-file.ts; src/core/pglite-engine.ts; src/core/search/eval-pool-depth.ts; src/core/search/sql-ranking.ts",""
"runner/live-recall","eval/runner/live-recall/task-arms.ts",OVERLAY-CAPABLE,,"","","src/core/access/caller.ts; src/core/ai/invocation-guard.ts; src/core/operations.ts; src/core/search/hybrid.ts; src/core/search/private-visibility.ts; src/mcp/dispatch.ts; src/mcp/server.ts; src/mcp/tool-defs.ts",""
"runner/live-recall","eval/runner/live-recall/tasks.ts",OVERLAY-CAPABLE,Y,"","","src/core/access/caller.ts; src/core/search/private-visibility.ts","gbrain/package.json; gbrain/src/core/embedding-pricing.ts; gbrain/src/core/model-id.ts; gbrain/src/core/model-pricing.ts"
"runner/memory-qa","eval/runner/memory-qa/run-systems.ts",OVERLAY-CAPABLE,Y,"","","src/core/import-file.ts; src/core/pglite-engine.ts; src/core/search/hybrid.ts",""
"runner/memory-qa","eval/runner/memory-qa/run.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/defaults.ts; src/core/think/index.ts",""
"runner/memory-trust","eval/runner/memory-trust/sut.ts",OVERLAY-CAPABLE,,"","","src/core/ai/gateway.ts; src/core/context/turn-context.ts; src/core/import-file.ts; src/core/operations.ts; src/core/persistence/identity.ts; src/core/persistence/service.ts; src/core/pglite-engine.ts; src/core/token-mint.ts; src/core/trust/channel.ts",""
"runner/memory-trust","eval/runner/memory-trust/utility-guard.ts",OVERLAY-CAPABLE,Y,"","","src/commands/eval-longmemeval.ts; src/core/ai/build-gateway-config.ts; src/core/ai/gateway.ts",""
"runner/messy-company","eval/runner/messy-company/load.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file","","",""
"runner/nightly","eval/runner/nightly/tool-contract.ts",DEEP-PATH-ONLY,,"T:gbrain/core/skillopt{BenchmarkTask}","","",""
"runner/pilot","eval/runner/pilot/evidence.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/chunkers/token-estimate.ts"
"runner/predictive","eval/runner/predictive/out-of-view/reach.ts",OVERLAY-CAPABLE,,"","","src/core/import-file.ts; src/core/pglite-engine.ts; src/mcp/dispatch.ts",""
"runner/predictive","eval/runner/predictive/scale-latency/build.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/defaults.ts; src/core/ai/gateway.ts; src/core/engine-factory.ts; src/core/pglite-engine.ts",""
"runner/q1","eval/runner/q1/cells/definitions.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/embedding-pricing.ts"
"runner/q2","eval/runner/q2/preflight.ts",OVERLAY-CAPABLE,,"","","","gbrain/package.json"
"runner/skillopt-method","eval/runner/skillopt-method/ceiling-stages.ts",PIN-STATIC,,"gbrain/core/skillopt{describeJudges}; T:gbrain/pglite-engine{PGLiteEngine}","","",""
"runner/skillopt-method","eval/runner/skillopt-method/headroom.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file; gbrain/ai/gateway{ChatOpts,ChatResult,__setChatTransportForTests,configureGateway}; gbrain/core/skillopt{BenchmarkTask,rolloutToolsForSkill,runSkillOpt}; gbrain/operations{operations}","","",""
"runner/skillopt-method","eval/runner/skillopt-method/one-shot.ts",PIN-STATIC,,"gbrain/ai/gateway{chat}; T:gbrain/pglite-engine{PGLiteEngine}","","",""
"runner/skillopt-method","eval/runner/skillopt-method/rollouts.ts",PIN-STATIC,,"gbrain/ai/gateway{toolLoop}; gbrain/ai/invocation-guard{withAIInvocationGuard}; gbrain/core/skillopt{BenchmarkTask,SKILLOPT_HOOK_BUDGET_EXHAUSTED,runRollout,scoreSkillPerTask}; T:gbrain/pglite-engine{PGLiteEngine}","","",""
"runner/skillopt-method","eval/runner/skillopt-method/score.ts",DEEP-PATH-ONLY,,"T:gbrain/core/skillopt{BenchmarkTask,ScoreOnTasksOpts}","","",""
"runner/skillopt-method","eval/runner/skillopt-method/test-stage.ts",DEEP-PATH-ONLY,,"T:gbrain/pglite-engine{PGLiteEngine}","","",""
"test","test/eval/adversarial-injections-scoring.test.ts",PIN-STATIC,,"gbrain/link-extraction{SlugResolver,extractPageLinks}","","",""
"test","test/eval/batch-sources.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/commands/eval-longmemeval.ts; gbrain/src/eval/longmemeval/reader.ts"
"test","test/eval/cat13-gap-localize.test.ts",DEEP-PATH-ONLY,,"T:gbrain/types{SearchResult}","","",""
"test","test/eval/cat13b-source-swamp.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/search/source-boost.ts"
"test","test/eval/cat15-propose-takes.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/cycle/propose-takes.ts"
"test","test/eval/cat20-judges.test.ts",DEEP-PATH-ONLY,,"T:gbrain/ai/gateway{ChatOpts,ChatResult}","","",""
"test","test/eval/cat26-contextual-retrieval.test.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}","","",""
"test","test/eval/cat28-federated-sync-latency.test.ts",DYN-PATH,,"","gbrain/import-file","",""
"test","test/eval/cat35-external-lane.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/commands/extract-conversation-facts.ts; gbrain/src/core/cycle/synthesize.ts; gbrain/src/core/transcripts/ingest.ts"
"test","test/eval/cat36-associative-retrieval.test.ts",DEEP-PATH-ONLY,,"","","","gbrain-cues/package.json"
"test","test/eval/cat36-candidate-integration.test.ts",DYN-PATH,,"","gbrain-cues/ai/gateway; gbrain-cues/config; gbrain-cues/import-file; gbrain-cues/memory-cues; gbrain-cues/operations; gbrain-cues/pglite-engine; gbrain-cues/search/hybrid","","gbrain-cues/package.json"
"test","test/eval/cat36-grounded-answers.test.ts",DYN-PATH,,"T:gbrain/ai/gateway{ChatResult}","gbrain/config","",""
"test","test/eval/cat36-operation-conformance.test.ts",PIN-STATIC,,"gbrain/operations{operationsByName}","","","gbrain/src/core/search/transcript-quote.ts"
"test","test/eval/cat36-snapshot.test.ts",DYN-PATH,,"","gbrain/pglite-engine","",""
"test","test/eval/cat37-memory-poisoning.test.ts",OVERLAY-CAPABLE,,"","","","gbrain/src/core/context/turn-context.ts; gbrain/src/core/search/transcript-quote.ts"
"test","test/eval/cat40-cost-levers.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/embedding-pricing.ts"
"test","test/eval/cat40-hidden-tool.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/takes-fence.ts"
"test","test/eval/cat41-agent-operator.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/README.md"
"test","test/eval/conditions-recall.test.ts",OVERLAY-CAPABLE,,"","","src/core/ai/invocation-guard.ts; src/core/search/hybrid.ts",""
"test","test/eval/evidence-delivery-requests.test.ts",PIN-STATIC,,"gbrain-reader/eval/longmemeval/reader{READER_MAX_SESSION_CHARS,READER_NOTES_SYSTEM_TEXT}","","","gbrain/src/eval/longmemeval/sanitize.ts"
"test","test/eval/harness-metering-proxy.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/cli.ts"
"test","test/eval/live-recall-postgres.test.ts",OVERLAY-CAPABLE,,"","","src/core/engine-factory.ts",""
"test","test/eval/live-recall-tasks.test.ts",OVERLAY-CAPABLE,,"","","src/core/access/members.ts; src/core/ai/gateway.ts; src/core/import-file.ts",""
"test","test/eval/live-recall.test.ts",OVERLAY-CAPABLE,,"","","src/core/ai/invocation-guard.ts; src/core/search/hybrid.ts",""
"test","test/eval/longmemeval-answers.test.ts",DYN-PATH,,"T:gbrain/types{SearchResult}; T:gbrain/ai/gateway{ChatResult}","gbrain/config","",""
"test","test/eval/longmemeval-m-pilot-openrouter.test.ts",DYN-PATH,,"","gbrain-cues/ai/gateway; gbrain-cues/config","","gbrain-cues/src/core/memory-cues/providers.ts"
"test","test/eval/longmemeval-m-pilot-replay.test.ts",PIN-STATIC,,"T:gbrain-cues/types{SearchResult}; gbrain-cues/pglite-engine{PGLiteEngine}; gbrain-cues/operations{operationsByName}","gbrain-cues/ai/gateway; gbrain-cues/memory-cues","",""
"test","test/eval/longmemeval-m-pilot-v5-stage.test.ts",DYN-PATH,,"","gbrain-cues/ai/gateway","",""
"test","test/eval/longmemeval-metrics.test.ts",DYN-PATH,,"","gbrain/ai/gateway","",""
"test","test/eval/longmemeval-opaque-ids.test.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/import-file; T:gbrain/ai/gateway{ChatResult}","","",""
"test","test/eval/model-defaults.test.ts",PIN-STATIC,,"gbrain/ai/gateway{configureGateway,getChatModel,resetGateway}","","","gbrain/src/core/model-config.ts"
"test","test/eval/multi-adapter-tiers.test.ts",DYN-PATH,,"","gbrain/ai/gateway","",""
"test","test/eval/n1-knowledge-update.test.ts",OVERLAY-CAPABLE,,"","","","gbrain/src/core/search/transcript-quote.ts"
"test","test/eval/n6-visibility-fuzz.test.ts",OVERLAY-CAPABLE,Y,"T:gbrain/operations{ParamDef}","","",""
"test","test/eval/n7-open-loops-email.test.ts",DYN-PATH,,"","${G}/google/google-clients.ts","","gbrain/src/core"
"test","test/eval/n9-multi-hop.test.ts",PIN-STATIC,,"gbrain/search/hybrid{hybridSearch}","","",""
"test","test/eval/no-provider-keys-gbrain-home.test.ts",PIN-STATIC,,"gbrain/config{loadConfig}","","",""
"test","test/eval/no-provider-keys-gbrain-source.test.ts",DYN-PATH,,"","gbrain; resolve:gbrain","",""
"test","test/eval/p8-custodian.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/eval/longmemeval/adapter.ts"
"test","test/eval/pglite-snapshot.test.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{configureGateway}","","",""
"test","test/eval/predictive-out-of-view.test.ts",OVERLAY-CAPABLE,,"","","","gbrain/package.json"
"test","test/eval/predictive-scale-latency.test.ts",OVERLAY-CAPABLE,Y,"","","src/core/ai/defaults.ts",""
"test","test/eval/reading-notes-requests.test.ts",PIN-STATIC,,"gbrain-reader/eval/longmemeval/reader{readerConfigHash,resolveReaderConfig}; gbrain-reader/ai/invocation-guard{invokeAI}; T:gbrain-reader/ai/gateway{ChatResult}","gbrain-reader/eval/longmemeval/reader; resolve:gbrain-reader/eval/longmemeval/reader","",""
"test","test/eval/relational-ab.test.ts",PIN-STATIC,,"T:gbrain/pglite-engine{PGLiteEngine}; T:gbrain/types{HybridSearchMeta,SearchResult}; gbrain/search/hybrid{hybridSearch}","","",""
"test","test/eval/retrieval-receipts.test.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}","","",""
"test","test/eval/search-observations.test.ts",PIN-STATIC,,"T:gbrain/types{HybridSearchMeta}; T:gbrain/pglite-engine{PGLiteEngine}; gbrain/ai/gateway{__setEmbedTransportForTests}","","",""
"test","test/eval/situation-native-evidence-18-24.test.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine}","","",""
"test","test/eval/situation-native-evidence-35.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/commands/extract-conversation-facts.ts; gbrain/src/core/cycle/synthesize.ts; gbrain/src/core/transcripts/ingest.ts"
"test","test/eval/situation-recall-associative.test.ts",DYN-PATH,,"","gbrain-cues/config; gbrain/config","","gbrain-cues/package.json"
"test","test/eval/situation-recall-cat13b.test.ts",PIN-STATIC,,"gbrain/config{configPath,loadConfig}","","",""
"test","test/eval/situation-recall-observations.test.ts",DEEP-PATH-ONLY,,"T:gbrain/types{HybridSearchMeta}","","",""
"test","test/eval/situation-recall-openrouter.test.ts",DYN-PATH,,"","gbrain/ai/gateway","","gbrain-cues/src/core/embedding-pricing.ts; gbrain-cues/src/core/model-pricing.ts"
"test","test/eval/situation-recall-programmatic.test.ts",PIN-STATIC,,"gbrain/config{configPath,loadConfig}","","",""
"test","test/eval/situation-recall-reference-policy.test.ts",DYN-PATH,,"","gbrain/ai/gateway","","gbrain/src/core/ai/gateway.ts; gbrain/src/core/memory-cues/evidence.ts; gbrain/src/core/memory-cues/providers.ts; gbrain/src/core/memory-cues/types.ts"
"test","test/eval/situation-recall-regression.test.ts",DYN-PATH,,"","gbrain/config; resolve:gbrain/config","","gbrain/scripts/r1-namedthing-rerank-ab.ts"
"test","test/eval/skillopt-ceiling-preconditions.test.ts",PIN-STATIC,,"gbrain/ai/invocation-guard{withAIInvocationGuard}; gbrain/core/skillopt{BenchmarkTask,SKILLOPT_HOOK_BUDGET_EXHAUSTED,runSkillOpt}; T:gbrain/pglite-engine{PGLiteEngine}","","",""
"test","test/eval/skillopt-ceiling-stages.test.ts",PIN-STATIC,,"T:gbrain/ai/gateway{ChatResult}; gbrain/core/skillopt{describeJudges}; T:gbrain/pglite-engine{PGLiteEngine}","","",""
"test","test/eval/skillopt-gen-heldout.test.ts",DYN-PATH,,"","gbrain/pglite-engine","","gbrain/src/core/skillopt/score.ts; gbrain/src/core/skillopt/types.ts"
"test","test/eval/skillopt-method-probe.test.ts",PIN-STATIC,,"gbrain/ai/gateway{ChatOpts,ChatResult,__setEmbedTransportForTests,__setGenerateObjectTransportForTests,__setGenerateTextTransportForTests}","","",""
"test","test/eval/skillopt-method-v3.test.ts",PIN-STATIC,,"gbrain/core/skillopt{scoreTrajectory}","","",""
"test","test/eval/skillopt-method.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/package.json; gbrain/skills"
"test","test/eval/skillopt-rollout-empty-args.test.ts",MIXED,,"gbrain/core/skillopt{BenchmarkTask,runRollout}; T:gbrain/ai/gateway{ChatResult}","","",""
"test","test/eval/skillopt-tool-calls.test.ts",PIN-STATIC,,"gbrain/core/skillopt{BenchmarkTask,runRollout}","","",""
"test","test/eval/systems-bootstrap.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/src/core/runtime-version.ts"
"test","test/eval/temporal-contradictions.test.ts",OVERLAY-CAPABLE,,"","","src/core/operations.ts; src/core/pglite-engine.ts",""
"test","test/eval/tool-bridge-citation.test.ts",DEEP-PATH-ONLY,,"T:gbrain/engine{BrainEngine}","","",""
"test","test/eval/tool-bridge.test.ts",DEEP-PATH-ONLY,,"T:gbrain/engine{BrainEngine}","","",""
"test","test/eval/verify-documentation-refresh.test.ts",DEEP-PATH-ONLY,,"","","","gbrain/package.json"
"test","test/eval/w6-embedding-matrix.test.ts",PIN-STATIC,,"gbrain/ai/gateway{__setEmbedTransportForTests}","","",""
"test","test/fixtures/no-provider-keys/gbrain-home-probe.ts",PIN-STATIC,,"gbrain/config{loadConfig}","","",""
"test","test/support/evidence-delivery-fixture.ts",PIN-STATIC,,"gbrain-reader/eval/longmemeval/reader{READER_MAX_SESSION_CHARS,READER_NOTES_SYSTEM_TEXT,buildReaderUserText}","","","gbrain/src/eval/longmemeval/metrics.ts; gbrain/src/eval/longmemeval/sanitize.ts"
"test","test/support/pglite-snapshot.ts",PIN-STATIC,,"gbrain/pglite-engine{PGLiteEngine,computeSnapshotSchemaHash}; gbrain/ai/gateway{getEmbeddingDimensions,getEmbeddingModel}","","","gbrain/src/core/ai/defaults.ts"
```

---

## 4. Out-of-process drivers of gbrain

Every place gbrain is started as a process, spoken to over MCP JSON-RPC, or called over HTTP. Command lines show the binary and arguments as written in source. "Runs `bun <cli.ts>`" means the subprocess is `bun <build>/src/cli.ts` (or `--no-env-file` form). No mode runs a compiled gbrain binary, except the gbrain-defaults container shim, which execs `GBRAIN_BIN` (default `gbrain` on PATH).

### 4.1 CLI invocations (spawn or exec)

| File:line | Mechanism | Command line (arguments) | Parses JSON? |
|---|---|---|---|
| `eval/runner/lifecycle/drivers.ts:73` | `spawn('bun', [entry, ...args])` in `runCli` (`CliDriver`, `:87`) | `gbrain call <tool> <json>`, `config get <k>`, `sources writer status --json`, etc. | Yes, JSON parse helpers `:51-53` |
| `eval/runner/lifecycle/drivers.ts:143` | `spawn('bun', [entry, 'serve'])` (`McpStdioDriver`, `:117`) | JSON-RPC over stdio | Yes, line-JSON `:155` |
| `eval/runner/lifecycle/drivers.ts:298` | `spawn('bun', [entry, 'serve', '--http', '--port', port])` (`McpHttpDriver`, `:287`) | JSON-RPC POST `http://127.0.0.1:<port>/mcp` (`:242`), OAuth client_credentials (`:223`) | Yes |
| `eval/runner/n6-postgres-http.ts:351` | `spawn('bun', [gut.root/src/cli.ts, 'serve', '--http', '--bind', '127.0.0.1', '--port', N])`, env `GBRAIN_REMOTE_PRIVATE_PAGES` optional | POST `/mcp` `:217`, token POST `:234`, DELETE `/mcp` `:271` | Yes (JSON-RPC responses `:230`, `:250`) |
| `eval/runner/p5-brain.ts:122-194` | `cli(['config','set',k,v,'--force'])`, `runCli(['config','get',k])`, `cli(['sweep','--once','--source',HTTP_SOURCE,'--json'])`, server `serve --http` | config, sweep, serve | Yes (`stdoutJson`, `:194`) |
| `eval/runner/p5-agent.ts:128,144,156` | `execFileSync('bun', ['-e', script])` with cwd GBRAIN_HOME | in-process script importing gbrain modules | Yes (JSON from script) |
| `eval/runner/p4-stream/hooks.ts:16` | `spawn('bun', [buildDir/src/cli.ts, 'hook', event])` (`run.ts:13` documents `gbrain serve --surface` over stdio) | hook events | No |
| `eval/runner/t0/delivery.ts:76` | `spawn('bun', [cli.ts, 'hook', event])` | hook session-start, user-prompt | No |
| `eval/runner/t0/parity.ts:48,125` | writes MCP config `{ command: 'bun', args: [cli.ts, 'serve', '--surface', 'starter'] }`; hook command `bun cli.ts hook <event>` | | No |
| `eval/runner/cat40/gbrain-arm.ts:93` | `spawn('bun', [buildDir/src/cli.ts, 'serve', ...args])` (`McpClient`, `:60`) | JSON-RPC stdio | Yes, `:104` |
| `eval/runner/predictive/cli-arm.ts:102` | `execFile('bun', ['--no-env-file', gut.root/src/cli.ts, ...argv])` (`execGbrain`) | model-chosen argv (`validateArgv`) | No (text returned to model) |
| `eval/runner/predictive/cli-arm.ts:227` | `GbrainMcpArm.start` uses `McpClient` `serve` | JSON-RPC stdio | Yes |
| `eval/runner/nightly/smokes/harness.ts:108,174` | `spawn('bun', ['--no-env-file', cli.ts, ...args])` and `serve --http --port N` | | Partly |
| `eval/runner/forward-reference-heal.ts:31,60` | `serve --http` (OAuth client) + `sweep --once` via live server | HTTP and CLI | Partly |
| `eval/runner/chronicle-lift.ts:195,200,218-221` | `spawnSync('bun', [GBRAIN/src/cli.ts, ...args])`, `Bun.spawn(['bun', cli.ts, ...])` | `init --pglite --non-interactive --no-embedding`, `config set chronicle.auto_recent_days 365`, `config set chronicle.auto_settle_seconds 0`, `config set auto_chronicle false` | Not verified |
| `eval/runner/memory-trust/flag-rate.ts:149,185,188` | `cli(...)` helper; `runCli` | `init --pglite --path D --embedding-model M --non-interactive`; `trust review --json`; `execFileSync('bun', ['-e', sqlScript])` reads the PGLite brain | Yes (trust review) |
| `eval/runner/cat41/in-container.ts:59,236` | `spawn` inside a Docker container (`box.gb(argv)`) | `call list_pages <json>`, `call recall <json>`, `init --pglite --no-embedding --json`, `remember ...`, `config set ...`, `serve` (stdio) | Yes for `call` and `init --json` (`cat41/scenarios.ts:157,176-177`) |
| `eval/runner/cat40/rerank-pool-replay.ts:557`, `cat40/firing.ts:88`, `cat40/gbrain-arm.ts:412,561`, `facts-absorb-gate.ts:103`, `refresh-barrier/retrieval.ts:62` | `execFileSync('bun', ['-e', script])` | in-process scripts importing gbrain | Yes (scripts print JSON) |
| `eval/workload-suites/bench-infra.ts:89`, `eval/runner/harness-cell.ts:448,590` | sets `MPW_GBRAIN_CLI=<gut.root>/src/cli.ts` in the child environment for a Python harness | | |
| `eval/harness-provider/mpw/gbrain_provider.py:295-330,355-375` | `subprocess.run([bun, cli, *args], env, cwd=home, start_new_session)` in `_cli()` | `init --pglite --db-only --non-interactive --json`, `apply-migrations --yes --no-autopilot-install`, `config set K V`, `config unset K`, `--version`, `models --json` | Yes: `json.loads(out[out.index('{'):])` at `:375` |
| `eval/systems/gbrain-defaults/shim.py:480` | `subprocess.run([GBRAIN, *args], env, cwd=WORK, capture_output)`, `GBRAIN = os.environ.get('GBRAIN_BIN', 'gbrain')` (`:62`) | `jobs list --json`, `apply-migrations --yes --non-interactive --no-autopilot-install`, `--version`, `config set/get K`, `extract-conversation-facts --source-id default --max-cost-usd X --json --yes`, `doctor --json` (per docstring) | Yes for `--json` forms |
| `eval/systems/gbrain-defaults/shim.py:198` | `subprocess.Popen(argv, stdin=PIPE, stdout=PIPE, env)` | `gbrain serve --surface starter` (per docstring) over MCP stdio (`McpStdio`, `:193`) | Yes, JSON-RPC |

### 4.2 MCP and HTTP clients

- There is no `@modelcontextprotocol/sdk` import anywhere in `eval/`, `scripts/`, `test/`. MCP is hand-rolled JSON-RPC: `McpClient` (`eval/runner/cat40/gbrain-arm.ts:60`), `McpStdioDriver` and `McpHttpClient` (`eval/runner/lifecycle/drivers.ts:117,213`), `McpStdio` in Python (`eval/systems/gbrain-defaults/shim.py:193`).
- HTTP to gbrain: `POST http://127.0.0.1:<port>/mcp` (`n6-postgres-http.ts:217`, `lifecycle/drivers.ts:242`) with bearer tokens from OAuth `client_credentials`, plus `GET /health` (`lifecycle-lite.ts:140`).
- In-process MCP dispatch (no transport): `importGbrain(gut, 'src/mcp/dispatch.ts')` (`dispatchToolCall`), `importGbrain(gut, 'src/mcp/server.ts')` (`handleToolCall`) used by `eval/runner/live-recall/task-arms.ts:134-135`, `eval/runner/n13-code-intelligence.ts:193`, `eval/runner/n6-visibility-fuzz.ts:394`. These are the "remote" arms without a transport.
- The Python harness (`eval/harness-provider/mpw/`) calls the CLI, not MCP.

### 4.3 Calls that drive gbrain in-process but look like process calls

- `runExtract(engine, ['links', '--source', 'db'])` (`eval/runner/multi-adapter.ts:178`) takes CLI argv.
- `importGbrain(gut, 'src/commands/eval-longmemeval.ts')` and `runEvalLongMemEval` (`test/eval/batch-sources.test.ts:10`).

---

## 5. Infrastructure: pin, overlay, selection, identity, receipts

### 5.1 Files and what they do

| File | Role | gbrain coupling |
|---|---|---|
| `eval/runner/gbrain-pin.ts` | `bump` command: finds newest `v*` tag on gbrain master, rewrites `package.json`, `bun.lock`, the pin line in `docs/gbrain-under-test.md`, and writes a changelog fragment | No gbrain import; uses git against `https://github.com/garrytan/gbrain.git`. Refuses if already current |
| `eval/runner/gbrain-under-test.ts` | `GbrainUnderTest {root, version, overlay}`, `gbrainSpecFrom(argv, env)`, `parseGbrainSpec`, `resolveGbrainUnderTest(spec)`, `importGbrain(gut, subpath)`, `productIdentityFor`, `overlaySummary`, `HELD_GBRAIN_DEFAULTS` | Path-based. Calls `prepareBuild` from `lifecycle/builds.ts`. Overlay root is `.gbrain-overlays/<label>` |
| `eval/runner/gbrain-version.ts` | `gbrainVersion()` (installed package version via `import.meta.resolve('gbrain')`, walks up to package.json), `gbrainInstallTag()` (`.bun-tag`), `gbrainPin()` (declared spec from `package.json`) | Resolves the installed alias, so always the pinned `node_modules/gbrain` even under `--gbrain` |
| `eval/runner/hermetic-env.ts` | `enterHermeticEnv` strips every `*_API_KEY`, endpoints, `GBRAIN_DECIDE_SLOTS`; points `GBRAIN_HOME` at an empty temp dir; `assertSystemOneOff` | Environment only (keeps `loadConfig()` from reading keys back) |
| `eval/runner/pins.ts` | `declaredPin(name)` reads `package.json` dependency spec | none |
| `eval/runner/retrieval-pins.ts` | Explicit search pins (`search.mode`, embedder `openai:text-embedding-3-large`, reranker `voyage:rerank-2.5`) and `retrievalPins()` | Type-only import of `HybridSearchMeta` |
| `eval/runner/eval-config.ts` | `GBRAIN_EVAL_CONFIG="k=v,..."` applies any gbrain config key to a fresh brain (`applyEvalConfig`) | none (uses `setConfig` through engine when called) |
| `eval/runner/eval-adapter-config.ts` | typed sidecar for embedder shootout adapter config | none |
| `eval/runner/model-defaults.ts` | registered model defaults and exceptions; test imports gbrain `TIER_DEFAULTS` by deep path | none in source |
| `eval/runner/identity.ts` | Installs page projections and reads snapshots on a PGLite engine; stamps `gbrain_version` and `gbrain_pin` | Static `PGLiteEngine` and deep `page-state/projections.ts` |
| `eval/runner/receipt.ts` | Receipt schema v2. Fields `gbrain_version`, `gbrain_pin` (required, `:194-195`, validated `:245-246`); `execution.product` (`:290-296`); `productIdentity(pkg, root)` (`:374`) | Reads `node_modules/<pkg>` package.json, git HEAD if it is a git checkout, and `regressionPackageHash` |
| `eval/runner/recorder.ts` | append-only JSONL recorder | none |
| `eval/runner/usage-receipt.ts` | usage source normalization (`anthropic`, `openai`, `gbrain-think`) | none (names the gbrain think convention) |
| `eval/runner/budget-ledger.ts` | SQLite spend ledger; prices via `canonicalLookup` and `lookupEmbeddingPrice` | Static `gbrain/core/model-pricing` and deep `node_modules/gbrain/src/core/embedding-pricing.ts` |
| `eval/runner/llm-budget.ts` | budget wrapper for LLM calls | none |
| `eval/runner/bug-ledger.ts` | reproduction ledger | none |
| `eval/runner/probe-accounting.ts` | probe error accounting types | none |
| `eval/runner/paid-arm.ts` | `--paid` and `--budget-run-id` guard, delegates to budget ledger | none |
| `eval/runner/anthropic-request.ts` | fits Anthropic request fields to model (drops `temperature` for Claude 5 family) | none |
| `eval/runner/openai-judge-shim.ts` | Anthropic-shaped `messages.create` backed by OpenAI Responses API | none |
| `eval/runner/prereg.ts` | preregistration attestation (git `merge-base`) | none |
| `eval/runner/promotion.ts` | evaluates promotion rules against a receipt | none |
| `eval/runner/mutation-kit.ts` | scorer mutation tests (pure) | none |
| `eval/runner/name-guard.ts` | enforces product-name guard via `git ls-files` | none |
| `eval/runner/validate-data.ts` | validates data (imports generators, not gbrain) | dynamic only |
| `eval/runner/synthetic-corpus-loader.ts` | loads synthetic corpora from disk | none |
| `eval/runner/import-embedded.ts` | `importFromContentEmbedded` wraps `importFromContent` to throw on `embedding_deferred` | Static `gbrain/import-file` |
| `docs/gbrain-under-test.md` | the one page that names the pin (`:7-18`), read-defaults changes, changelog | none (docs) |
| `docs/usage-receipt.md` | usage receipt schema (`gbrain-think` source) | none |
| `docs/settings.md` | search and config knob descriptions (`search.*`, `GBRAIN_EVAL_*`) | none |

### 5.2 How a run selects the gbrain under test

Four layers, from broadest to narrowest:

1. Default (no flag): `resolveGbrainUnderTest(null)` returns `root = <repo>/node_modules/gbrain`, `overlay = null`. This is the pinned alias installed by `bun install`. 34 files call `resolveGbrainUnderTest(null)` (8 of them under `eval/`, the rest are tests), so the default is the pin.
2. `--gbrain <checkout>[@<ref>]` on the CLI, `--gbrain=...`, or env `GBRAIN_UNDER_TEST`. `gbrainSpecFrom` (`gbrain-under-test.ts`) parses it. `parseGbrainSpec` splits on the last `@` when the left side is a directory. `resolveGbrainUnderTest` runs `git status --porcelain`, then `prepareBuild` makes a `git archive` copy under `.gbrain-overlays/` and runs `bun install --frozen-lockfile` there. It then verifies: tree hash equals the commit's tree, no symlinks under `src/`, dir is a realpath, and the copied CLI prints the copy's VERSION. Symlinks are rejected because Bun would resolve back to the pin. Uncommitted edits are not measured and are recorded as `checkout_dirty`.
3. Alias selection by runner: `productPackage` is `'gbrain' | 'gbrain-cues'` in `eval/runner/adapters/gbrain-inline.ts` (`loadProduct`, `:84-95`) and `cat36ProductPackage(arm)` returns `'gbrain-cues'` for memory-cue arms (`eval/runner/cat36-associative-retrieval.ts:100`). `type-accuracy.ts --package=gbrain|gbrain-cues` (`:119`). `longmemeval-m-pilot-*` loads `node_modules/gbrain-cues` by absolute path (`test/eval/longmemeval-m-pilot-*.test.ts`).
4. Per arm: `decide.ts` arms carry `gbrain` specs (`eval/runner/decide.ts:134`, `:251`), so one decision can compare two checkouts. `lifecycle-lite.ts:108` (`a.gbrain`) and `n9-multi-hop-paraphrase.ts:326` do the same for their arms.

Two external selectors:

- gbrain-defaults container: the shim execs `GBRAIN_BIN` (default `gbrain`, PATH). The Dockerfile builds gbrain at `GBRAIN_SHA` via `bun install -g` (`eval/systems/gbrain-defaults/Dockerfile`). This is the only real "binary path" mode.
- MPW Python harness: `MPW_GBRAIN_CLI` or `provider_config.gbrain_cli`, run as `bun <cli.ts>`.

Gaps in selection:

- 83 PIN-STATIC files statically import the installed alias, so `--gbrain` does not change them. Only 1 PIN-STATIC file also mentions the flag (`eval/runner/adapters/gbrain-inline.ts`), and its static imports are type-level plus a dynamic `import(join(root, ...))` when a root is given.
- `eval/runner/relational-ab.ts` is MIXED. With an overlay it loads `hybrid.ts`, `embedding.ts` and `ai/gateway.ts` from the copy (`:326-333`), but it still statically imports `gbrain/search/hybrid` and `gbrain/embedding` (`:37-39`) and `gbrain/ai/gateway`. Partial overlay.
- The `productPackage` alias (`gbrain-cues`) and the `--gbrain` root are separate mechanisms. An overlay of gbrain master cannot be combined with the cues alias in one run through `--gbrain`; the cues arm loads from `node_modules/gbrain-cues`.
- Subprocess sites use `join(gut.root, 'src/cli.ts')`, so the overlay is respected there. The `gbrain-defaults` and MPW paths are not overlay-aware and need `GBRAIN_BIN` or `MPW_GBRAIN_CLI`.

### 5.3 Is there a system-under-test abstraction?

Yes, partly. There is no interface or trait. The de facto SUT abstraction is the `GbrainUnderTest` value with `root` (directory), `version`, and `overlay` (provenance), plus `importGbrain(gut, subpath)` and `gut.root` for subprocess paths. Every runner that is overlay-aware takes a `gut` argument, and `productIdentityFor(gut)` and `overlaySummary(gut)` feed receipts. Two problems for a Rust port:

- The abstraction is filesystem-path based: "the SUT is a TypeScript source tree at `<root>/src/...`". Rust cannot reuse `import(join(root, subpath))`. The contract is the file list plus CLI and MCP surfaces.
- Static imports and deep relative paths (`node_modules/gbrain/src/...`, 96 files) bypass it. Any port must either retire those runners or re-point them at a CLI/MCP driver.

### 5.4 How receipts record the gbrain version

Receipt fields (`eval/runner/receipt.ts:194-195`, validated `:245-246`):

- `gbrain_version`: string. Written from several sources. `gut.version` (27 sites, plus 3 `o.gut.version`) is the overlay-aware value, the version of the copy that ran. `gbrainVersion()` (41 sites) and its alias `gbrainVersionResolved()` (33 sites) read the installed alias package.json, which is always the pin (see caveat below).
- `gbrain_pin`: string from `gbrainPin()`, the declared dependency spec from `package.json` (e.g. `github:garrytan/gbrain#6ce7195b...`).
- `execution.product` (validated `receipt.ts:294-296`): `{ package, declared_pin, declared_sha, version, package_sha256, loaded_git_head }`. Built by `productIdentity(pkg)` (`receipt.ts:374`) for the alias (declared pin, package.json version, `regressionPackageHash` of `node_modules/<pkg>`, git HEAD if the package dir is itself a repo). Overlays use `productIdentityFor(gut)` (`gbrain-under-test.ts`), which sets `loaded_git_head` to the overlay commit and `package_sha256` to the copy's hash.
- `overlay` summary: `overlaySummary(gut)` gives `{ requested: 'gbrain@<ref>', ref, commit, tree, version, checkout_dirty, verified, copied_not_symlinked: true }`. It names the ref, never the checkout path.
- `execution.source_tree`: eval repo tree identity (`sourceTreeIdentity`, `eval/runner/receipt.ts:335`), `scheme: 'git-index-blob-v1'`.

Caveat: `gbrainVersion()` reads `import.meta.resolve('gbrain')` from `eval/runner/gbrain-version.ts`, so it reports the pinned package even when the run loaded an overlay. Receipts from runners that use it under `--gbrain` can carry the pin's version. Runners using `gut.version` or `productIdentityFor` are correct. Each runner needs checking.

Other known identity mechanisms: `regressionPackageHash` (`eval/runner/situation-recall-provenance.ts:23`) hashes a package directory, rejecting symlinks, skipping `.git` and `node_modules` at the root. `prepareBuild` verifies tree equality. `budget-ledger.ts` stores price-table lookups.

### 5.5 Notable hermetic guard

`hermetic-env.ts` sets `GBRAIN_HOME` to an empty temp dir and strips keys before any gbrain code runs. This matters because `loadConfig()` fills `process.env` from `~/.gbrain/.env`. `assertSystemOneOff` checks after gbrain loads.

---

## 6. The postgres@3.4.9 patch

File: `patches/postgres@3.4.9.patch` (844 lines, 9 hunks over the npm `postgres` 3.4.9 package: `cjs/src/{connection,index,query,queue}.js`, `src/{connection,index,query,queue}.js`, `types/index.d.ts`).

Declared in `package.json` `patchedDependencies` as `"postgres@3.4.9": "patches/postgres@3.4.9.patch"` (current), and in `bun.lock:25-26`.

What it changes (from the hunk headers and `+`/`-` lines):

- `connection.js` `cancel()`: remembers `cancelResolve` and `cancelReject`; if no socket after connect, rejects with `cancelError` or `CONNECTION_CLOSED`. The original raced `socket.once('error')` and `socket.once('close')` and could hang or misreport.
- `connection.js` `error()` and `errored()`: record `cancelError` while a cancel is pending.
- `connection.js` close handler: when a cancel is pending, resolves or rejects the cancel promise instead of the normal path.
- `connection.js` pipelining: the `onexecute` hook is evaluated once into `mayPipeline` before `write()`, so a `false` from `onexecute` is not ignored.
- `connection.js` `drain()`: does not call `onopen` on a reserved connection (`!connection.reserved`).
- `connection.js` reservation: `connection.reserved` becomes a function with release semantics (`reservation`, `ended`, `completed.cancelPromise`), so a reserved connection is released exactly once.
- `index.js`, `query.js`, `queue.js`: hunks that match the connection changes (reservation release and cancel bookkeeping).
- `types/index.d.ts`: one hunk of typings (the patch adds it alongside the reservation changes).

Why it exists. The repo's CHANGELOG (v0.10.0, `CHANGELOG.md:36-46` and `:6014`) says the patch is "required" so Bun's frozen-lockfile install gets "the cancellation-capable driver `gbrain-reader` expects". `gbrain-reader` pins `postgres` to exactly `3.4.9` (`bun.lock` gbrain-reader entry). `gbrain-cues` depends on `postgres ^3.4.0` (`bun.lock`), which resolves to 3.4.9 in this lock, so the patch covers both aliases.

Two more facts:

- The gbrain pin itself (6ce7195) has no npm `postgres` dependency. It vendors the same 3.4.9 source under `vendor/postgres` with the patch already applied, and maps `#postgres` through `package.json` `imports` (`docs/architecture/postgres-cancellation.md` says so). So the root patch matters for the `gbrain-cues` and `gbrain-reader` aliases only, and not for the pinned `gbrain` or for `--gbrain` overlays (overlays use their own vendored copy).
- History: a 2026-09-28 audit found the patch inert (`docs/plans/2026-09-28-gbrain-10x/audit/evals-docs-infra.md:256-266`) because `package.json` lacked `patchedDependencies`. v0.10.2 added it (`CHANGELOG.md:6014`). The current `package.json` declares it.

For the Rust port: the patch fixes cancellation semantics that gbrain's Postgres engine relies on (see `docs/architecture/postgres-cancellation.md`: abortable reservations, cancel fences). Any Rust Postgres driver must reproduce cancel-before-settle and reserved-connection release, or the cues and reader aliases' behavior under timeouts will not match.

---

## Cross-cutting observations

1. The evals are mostly pin-bound. 83 files statically import the installed `gbrain` alias and 1 more mixes it with the overlay. Only 37 files mention `--gbrain` at all, and of the 83 pin-bound files only `eval/runner/adapters/gbrain-inline.ts` mentions it. Any "measure this gbrain build" claim has to be checked file by file.
2. There are three coupling modes in the codebase, in order of how hard they are to port: (a) static imports of export-map subpaths, about 84 files, which need a function-level contract; (b) absolute-path imports (`importGbrain`, `import(join(root, ...))`, `productPackage` templates), about 66 DYN-PATH files plus 50 overlay files, which need the same contract plus a filesystem layout; (c) relative deep paths into `node_modules/gbrain/src/...`, 96 files, which bypass both and need a driver rewrite or retirement.
3. The out-of-process surface is already a usable oracle. Subprocess sites use `bun <cli.ts>` and the MCP JSON-RPC over stdio or HTTP. The MPW Python harness and the gbrain-defaults shim already parse `--json` output and reach gbrain as a black box. Those are the natural parity surfaces for a Rust binary (`GBRAIN_BIN`, `MPW_GBRAIN_CLI`), and they need no in-process TypeScript.
4. `gbrainVersion()` reads the installed alias, not the overlay, and 74 call sites use it or its alias. Receipts from overlay runs may carry the pin's version. Audit each overlay-capable runner that stamps `gbrain_version` with `gbrainVersion()` instead of `gut.version`.
5. `OperationContext.remote` is the security boundary. About 64 files set it explicitly, and the tool bridge and memory-trust SUT depend on the fence and visibility rules. The Rust port must reproduce `remote: true` behavior (fenced reads, write gating), or those arms will not match.
6. Type-only imports are erased at runtime, so the `gbrain/types` and `gbrain/engine` surfaces matter to the port only through method names and JSON shapes (`SearchResult`, `HybridSearchMeta`, `BrainEngine` methods listed in Section 1.6). The runtime-coupled surfaces are the ones in Section 2.
7. The most-used runtime surfaces are `configureGateway`, `__setEmbedTransportForTests`, `PGLiteEngine` and `initSchema`/`connect`/`disconnect`/`setConfig`/`executeRaw`, `importFromContent`, `hybridSearch`, and `operationsByName`/`op.handler`. These drive most of the 84 PIN-STATIC and 66 DYN-PATH files. A Rust port with equivalent behavior on these would unblock most runners.
8. Dynamic loading hides edges. `gbrain-cues` and `gbrain-reader` and the overlay root are chosen at runtime, so a static scan under-counts real coupling. The counts here are regex-based and can miss `require` built from variables. The matrix is complete for literal specifiers only.
9. The postgres patch matters only for the cues and reader aliases. The pinned gbrain vendors the same source, so Rust Postgres work should target the vendored behavior (`docs/architecture/postgres-cancellation.md`), not the npm package.
10. Infrastructure gaps observed: `scripts/` and `types/` have no gbrain coupling at all. `eval/runner/gbrain-pin.ts bump` moves the pin through git over HTTPS (`https://github.com/garrytan/gbrain.git`) and so is the only gbrain-facing network step outside the runners.
