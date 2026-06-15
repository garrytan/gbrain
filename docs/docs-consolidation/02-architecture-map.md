# Architecture Map

Status: static architecture map from the installed `understand-anything`
workflow, refreshed after the upstream merge

Baseline reviewed: `docs/docs-consolidation/00-upstream-base.md`

Pinned upstream commit: `090bb53203557f5659563ea28c1c847c32167aeb`

Current branch merge commit: `416f2ae29788a16cba1b20fb33ccf05a4eb665c1`

Proof level: `code_proven` static analysis only. No GBrain runtime command,
server, migration, import, sync, or Docker lifecycle proof was attempted.

## Scope And Safety

This map describes the current upstream GBrain repository shape so a docs-only
PR can align documentation with code and repo-local documentation reality.

No local Nexus runtime, local brain home, local corpus path, runtime configs, or
out-of-repo `.env` files were inspected. No `gbrain` commands were run.

## Method

The second pass used the installed skill at:

- `/Users/vitorcepedalopes/.understand-anything/repo/understand-anything-plugin/skills/understand/SKILL.md`

The installed skill scripts were used for:

- project scan
- import-map extraction
- semantic batching
- structural extraction
- batch merge/normalization
- inline graph validation
- fingerprint baseline generation

The original full pass used five read-only `gpt-5.4-mini` domain reviews:

- CLI/runtime architecture
- engines, schema, migrations, and storage
- retrieval, search modes, AI providers, and eval capture
- MCP, OAuth/auth, remote transport, and thin-client docs
- docs, skills, generated LLM maps, tests, and release process

Execution notes:

- The plugin core had to be built before running the skill scripts.
- `pnpm` was invoked through `corepack`.
- The first frozen install failed because the plugin lockfile was out of sync
  with `packages/core/package.json`; dependencies were then installed with
  `--no-frozen-lockfile --ignore-scripts`, and only the plugin core was built.
- The installed skill path did not include the agent definition markdown files
  named in the skill contract for assemble review, architecture, or tour. Those
  phases were assembled deterministically from the merged graph and then
  validated with the inline validator.
- After upstream advanced to `0.42.44.0`, the current branch was merged with
  `origin/master`, CodeGraph was synced, and `understand-anything` was refreshed
  incrementally. The refresh re-ran deterministic scan, import-map extraction,
  changed-batch computation, structural extraction, graph update,
  validation-reference checks, fingerprint generation, and metadata update.
  Because the plugin subagent definitions are not available in this Codex
  environment, the refresh does not claim a new LLM semantic review for the
  changed batches.

## Generated Artifacts

- `.understand-anything/knowledge-graph.json`
- `.understand-anything/fingerprints.json`
- `.understand-anything/meta.json`
- `.understand-anything/intermediate/scan-result.json`
- `.understand-anything/intermediate/import-map.json`
- `.understand-anything/intermediate/batches.json`
- `.understand-anything/intermediate/assembled-graph.json`
- `.understand-anything/intermediate/review.json`

## Graph Summary

| Metric | Value |
|---|---:|
| files scanned | 2,537 |
| files filtered by `.understandignore` | 0 |
| import-map files with imports | 1,681 |
| import-map resolved edges | 4,588 |
| incremental batches refreshed | 27 |
| files structurally refreshed in current merge batches | 653 |
| files skipped | 0 |
| graph nodes | 13,660 |
| graph edges | 17,749 |
| layers | 9 |
| guided tour steps | 6 |
| validation issues | 0 |
| broken edge/layer/tour references | 0 |
| fingerprint baseline | 2,537 files |

Node types:

| Type | Count |
|---|---:|
| file | 2,052 |
| function | 5,323 |
| class | 151 |
| schema | 79 |
| pipeline | 4 |
| concept | 5,640 |
| config | 52 |
| document | 353 |
| service | 3 |
| table | 3 |

Edge types:

| Type | Count |
|---|---:|
| contains | 7,544 |
| calls | 3,362 |
| imports | 3,267 |
| documents | 3,570 |
| tested_by | 6 |

## System Layers

| Layer | Current role | Primary docs to keep aligned |
|---|---|---|
| CLI e comandos | CLI dispatch, command handlers, trusted local shortcuts, and user-facing command routing. | `README.md`, `docs/INSTALL.md`, `AGENTS.md`, `CLAUDE.md`, `docs/architecture/KEY_FILES.md` |
| Dominio core e operacoes | Operation contracts, source scoping, page/entity/fact behavior, minions, jobs, and shared domain logic. | `CLAUDE.md`, `docs/architecture/brains-and-sources.md`, `docs/architecture/KEY_FILES.md` |
| Engines, schema e storage | PGLite/Postgres engine selection, schema, migrations, verification, storage tiering, and persistence config. | `docs/ENGINES.md`, `docs/storage-tiering.md`, `docs/architecture/system-of-record.md`, `docs/architecture/schema-packs.md` |
| Retrieval, AI e avaliacao | Search modes, hybrid retrieval, embeddings, reranking, provider recipes, eval capture/export/replay. | `docs/architecture/RETRIEVAL.md`, `docs/guides/search-modes.md`, `docs/eval-capture.md`, `docs/eval-bench.md`, `docs/ai-providers/*` |
| MCP, auth e remoto | Stdio MCP, HTTP OAuth, legacy bearer compatibility, thin-client routing, remote doctor, client auth. | `docs/architecture/thin-client.md`, `docs/mcp/DEPLOY.md`, `docs/mcp/*.md`, `SECURITY.md` |
| Skills e operacoes de agentes | Skills, resolver, conventions, skillpack manifest/runtime, recipes, and examples. | `skills/RESOLVER.md`, `skills/manifest.json`, `openclaw.plugin.json`, `docs/guides/skillpacks-as-scaffolding.md` |
| Documentacao publica | README, install docs, architecture refs, tutorials, generated docs maps, release/testing docs. | `README.md`, `AGENTS.md`, `CLAUDE.md`, `INSTALL_FOR_AGENTS.md`, `llms.txt`, `llms-full.txt` |
| Testes, CI e release | Unit/E2E tests, fixtures, CI workflows, generated-doc guards, release checks. | `docs/TESTING.md`, `docs/RELEASING.md`, `scripts/ci-local.sh`, `scripts/run-e2e.sh`, `test/build-llms.test.ts` |
| Admin UI e assets | Admin UI assets, styles, and design references. | `docs/admin-ui-design-system.md`, admin/UI assets under `src/` |

## Runtime Shape By Domain

### CLI And Operation Dispatch

`src/cli.ts` is a substantial router, not just a generated facade. It branches
early on thin-client config, routes remote installs through `runThinClientRouted`,
and otherwise creates the local engine path through config load, gateway setup,
engine creation, connect/retry, migrations, DB config re-merge, and command
dispatch.

`src/core/operations.ts` is still the shared operation contract with the largest
blast radius. It distinguishes `OperationContext.remote = false` for trusted
local CLI callers from `remote = true` for MCP/agent-facing callers.

Docs implication: keep "CLI and MCP share the operation registry" but avoid
wording that implies the CLI is literally generated from `operations.ts`.

### Engines, Schema, And Persistence

`src/core/engine-factory.ts` currently supports only `postgres` and `pglite`.
Docs that describe broader engine pluggability should mark that as architecture
direction unless they are describing the live factory.

Postgres and PGLite share the migration contract, but they are not identical
runtime paths:

- Postgres uses schema replay, migration retry, `verifySchema()`, advisory lock
  behavior, and cleanup paths.
- PGLite uses the embedded schema/migration path and local single-writer DB
  behavior.

Docs implication: `docs/ENGINES.md` should not treat its interface snippet as
the live `BrainEngine` contract, and `docs/storage-tiering.md` should make the
PGLite nuance explicit.

### Retrieval, Search Modes, And AI Providers

Search mode resolution flows through `loadSearchModeConfig`,
`resolveSearchMode`, and `MODE_BUNDLES`. Install-time mode selection flows
through `runModePicker` and persists `SEARCH_MODE_KEY`.

The current retrieval surface includes more than the older three-mode prose
shows: reranker knobs, graph signals, contextual retrieval, autocut, relational
retrieval, embedding-column selection, eval capture, and token-budget shaping.

Provider setup uses recipe registration and gateway config precedence. The
subagent pass confirmed the checked ZeroEntropy docs are broadly aligned on
`ZEROENTROPY_API_KEY`, `zembed-1`, `zerank-2`, and env/file precedence, but the
full gateway and doctor probe internals were not runtime-proven.

Docs implication: make `docs/architecture/RETRIEVAL.md` the current pipeline
source and make `docs/guides/search-modes.md` a concise, updated router.

### MCP, Auth, And Remote Clients

The MCP surface has two transport paths that converge on shared operation
dispatch:

- local stdio MCP for same-machine agents
- HTTP MCP with OAuth/client credentials for remote clients

HTTP also retains legacy bearer-token compatibility through the OAuth/provider
verification path. Thin-client docs currently under-describe this compatibility
path, `gbrain remote doctor`, and the newer fields returned by
`get_brain_identity`.

Docs implication: `docs/mcp/DEPLOY.md` should own protocol truth. Thin-client
and brain/source docs should mention legacy bearer compatibility only as
compatibility, not as the primary current path.

### Skills, Skillpacks, And Generated Maps

The repo has several skill-related surfaces with different scopes:

- `openclaw.plugin.json#skills`: 37 scaffolded bundled skills consumed by the
  skillpack runtime.
- `skills/manifest.json`: 51 resolver/registry entries.
- `skills/**/SKILL.md`: 52 skill markdown files.
- `skills/` documentation area in the inventory: 57 files when resolver/shared
  markdown is included, excluding conventions and migrations.
- `scripts/llms-config.ts`, `llms.txt`, and `llms-full.txt`: "26
  fat-markdown skills."
- `CLAUDE.md`: says the repo ships 29 skills.
- `README.md` and `docs/INSTALL.md`: currently say "43 skills."

Docs implication: this is definition drift. A docs-only PR should remove bare
skill counts or qualify each number with its source.

Generated LLM maps have an additional fork-specific gap: checked-in `llms.txt`
and `llms-full.txt` still use upstream `garrytan/gbrain/master` raw URLs, while
`AGENTS.md` tells forks to regenerate with `LLMS_REPO_BASE` and
`scripts/llms-config.ts` supports it.

## Documentation Alignment Queue

### 0. Changelog-To-Current-Capabilities Baseline

The docs cleanup should begin by converting the latest changelog window into a
current-capability ledger. The minimum release window is `0.42.44.0` through
`0.42.41.0`, with special attention to `0.42.43.0` and `0.42.42.0`:

- push-based volunteered context: `volunteer_context`, `gbrain
  volunteer-context`, `gbrain watch`, rolling retrieval-reflex windows,
  feedback stats, and suppression semantics
- bounded teardown and truthful exit verdicts across engines
- PGLite error exit-code correction and output flush fencing
- data/source durability, grant hardening, reconnect, lock, and doctor
  correctness changes from the surrounding release wave

PR direction: produce a changelog-derived capability matrix first, then mark
each doc as current, incomplete-current, contradictory, or historical. This
keeps the PR from flattening the problem into "delete stale docs" when several
docs need evolution instead.

### 1. Search Mode Language

Current code and docs distinguish two states that entrypoints sometimes collapse
under "default":

- runtime fallback when `search.mode` is unset or invalid: `balanced`
- fresh-init recommended/persisted mode: usually `tokenmax`, with conservative
  exceptions for lower-cost or missing-key cases

PR direction: replace generic "default" wording with "runtime fallback" and
"init-time recommendation" wherever both facts matter.

### 2. Retrieval Pipeline Drift

`docs/guides/search-modes.md` remains an older three-mode explainer and misses
the current `MODE_BUNDLES` surface: `reranker_*`, `graph_signals`,
`contextual_retrieval`, `autocut`, and `relationalRetrieval`.

`CLAUDE.md` also has a partial search-mode table. The `gbrain search modes`
report code itself only attributes a subset of knobs, so docs should not imply
that command displays the entire bundle.

PR direction: update the architecture/reference docs first, then route concise
entrypoint prose to that source.

### 3. Eval Capture Drift

`docs/eval-capture.md` does not mention `embedding_column`, while
`EvalCandidateInput` and `captureEvalCandidate` persist it so replay can stay in
the same embedding space.

PR direction: add `embedding_column` to the capture/replay contract and note why
it matters for embedding-space parity.

### 4. Engine And Storage Drift

`docs/ENGINES.md` is accurate as a high-level overview but not as a live
interface reference. It also sounds broader than the checked-in factory, which
currently supports only `postgres` and `pglite`.

`docs/storage-tiering.md` is correct on `db_tracked` / `db_only`, but some
offload wording is Postgres-centric. On PGLite, the practical behavior collapses
closer to local DB plus gitignore housekeeping.

PR direction: mark the live engine support explicitly and clarify the two
different `StorageConfig` meanings: binary storage backend config versus repo
tiering config.

### 5. MCP And Thin-Client Drift

`docs/architecture/thin-client.md` under-describes:

- server-side transport split across `serve.ts`, `serve-http.ts`, and
  `mcp/server.ts`
- `gbrain remote doctor`, which now checks more than scopes
- `get_brain_identity`, which returns update/version fields beyond the older
  doc list
- legacy bearer-token compatibility alongside OAuth

`docs/mcp/ALTERNATIVES.md` and parts of `SECURITY.md` also retain older framing
around bearer tokens and Postgres-only remote MCP assumptions.

PR direction: make `docs/mcp/DEPLOY.md` the single protocol truth and update
thin-client/security alternatives as pointers or compatibility notes.

### 6. Skill Count Drift

Skill counts differ by surface: 26, 29, 37, 43, 51, 52, and 57 all appear
depending on source and definition.

PR direction: remove broad numeric skill claims, or replace them with scoped
phrasing such as "37 scaffolded skills in the OpenClaw bundle."

### 7. Generated LLM Map Fork Gap

`llms.txt` and `llms-full.txt` still point at upstream raw URLs. Fork support is
documented and implemented through `LLMS_REPO_BASE`, but the checked-in files
have not been regenerated for this fork.

PR direction: for an upstream PR, avoid changing URLs to the fork. For fork
publication, regenerate with the fork base and keep this separate from upstream
docs cleanup.

### 8. E2E Count Drift

`AGENTS.md` and `docs/RELEASING.md` mention "all 29 E2E files", while this
checkout contains 147 `test/e2e/*.test.ts` files and CI scripts compute the set
dynamically.

PR direction: replace hard-coded E2E counts with count-free wording or a
script-derived description.

### 9. Testing Reference Drift

`docs/TESTING.md` references `test/skillpack-sync-guard.test.ts`, but that file
is not present in this checkout.

PR direction: replace the missing-file reference with the current guard/test
names or remove the specific filename if the guard is now split.

### 10. Historical Status Labels

Historical and forward-looking docs live near current reference docs:
`docs/GBRAIN_V0.md`, `docs/designs/*`, `docs/issues/*`, `docs/proposals/*`,
`docs/incidents/*`, and `TODOS.md`.

PR direction: add lightweight status banners only where a historical doc can be
mistaken for current install or runtime authority.

## Proposed Docs-Only PR Slices

0. Changelog/current-capabilities baseline: derive the live capability matrix
   from `CHANGELOG.md` before editing install or agent docs.
1. Entry-point truth labels: add source-of-truth callouts to `README.md`,
   `AGENTS.md`, `INSTALL_FOR_AGENTS.md`, and `docs/INSTALL.md` without rewriting
   the install flow.
2. Search/retrieval cleanup: normalize runtime fallback vs init recommendation,
   update current `MODE_BUNDLES` surface, and add eval-capture
   `embedding_column`.
3. Engine/storage cleanup: correct live engine support wording, clarify
   Postgres/PGLite differences, and disambiguate `StorageConfig`.
4. MCP/thin-client cleanup: update remote doctor, identity fields, transport
   split, and legacy bearer compatibility wording.
5. Skill/test count cleanup: remove or qualify brittle numeric claims and
   replace stale test-file references.
6. Generated-map fork note: keep upstream PR separate from fork URL
   regeneration; document the fork regeneration path if needed.
7. Archive labeling: add small status labels only to documents that currently
   look like live reference but are historical/design/proposal material.

## Proof Limits

This pass is static. It is useful for docs consolidation, but it does not prove:

- CLI behavior at runtime.
- MCP stdio or HTTP behavior against a live server.
- database migration behavior.
- test-suite health.
- provider API behavior.
- generated LLM bundle freshness after future edits.

The graph is generated and validator-clean, but the layer and tour text were
assembled deterministically because the installed skill path did not include
the LLM agent definition files referenced by the skill contract. The five
domain subagent passes are code/doc inspection, not runtime proof.
