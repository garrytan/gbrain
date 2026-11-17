# Usage: how gbrain-evals and gbrain's agent docs use the gbrain CLI and MCP

Inputs: eval repo `gbrain-evals@cd447b3ae` (detached worktree, HEAD `cd447b3ae` "Release v0.10.237", read only); gbrain (`github.com/garrytan/gbrain`) (VERSION 0.60.733.0); inventories in `docs/research/rust-engine/data/`. Counts come from rg and small Python scans over the working trees. Scratch scripts and intermediate tables are in `scratch script ` (not in any repo). Nothing in either repo was modified.

## 0. Summary

- **gbrain-evals is a library consumer first.** 131 `.ts` files import a `gbrain/…`, `gbrain-cues/…` or `gbrain-reader/…` subpath: 82 under `eval/` (79 of them `eval/runner/`) and 46 under `test/`. Distinct specifiers: 17 `gbrain/*`, 9 `gbrain-cues/*`, 5 `gbrain-reader/*` (section 1a).
- **Library imports go past the exports map.** Runners also load gbrain source files by absolute path through `importGbrain(gut, 'src/…')` and similar helpers: 116 distinct `src/` paths in 68 non-test eval files. Only 16 of those 116 match a `package.json` `exports` target; 100 are path-only (for example `src/cli.ts`, `src/mcp/dispatch.ts`, `src/commands/*.ts`). A Rust binary cannot satisfy these contracts directly.
- **The eval pins gbrain by commit, not `#master`.** `package.json` pins `gbrain` to `6ce7195b44a0…`, `gbrain-cues` to `939232f1746…` and `gbrain-reader` to `e78f1c38b94…`. The brief said `#master`; the pins are what the eval actually runs.
- **CLI and MCP use is real but narrow.** About 26 distinct CLI verbs appear in eval argv (verified sites in 1b). About 28 distinct MCP op names are called (1c). Most of the CLI use is harness setup (`init`, `config set`, `sources add`, `auth register-client`), quiescence checks (`doctor --json`, `jobs list --json`), and the generic `gbrain call <op> <json>` bridge.
- **The only language-neutral seam is HTTP protocol v1.** `eval/systems/PROTOCOL.md` defines an HTTP shim (`/health`, `/capabilities`, `/reset`, `/ingest`, `/finish`, `/retrieve`, `/delete_source`, optional `/answer`). A system is selected with `--system <http URL>`. A Rust service that implements the protocol can run without touching TypeScript. The Python `gbrain-defaults` shim also shows a second seam: it drives the binary named by `GBRAIN_BIN` through CLI calls and MCP stdio.
- **Classification (220 CLI commands):** agent-core 16, agent-occasional 91, admin/maintenance 80, setup/install 15, dev/eval-only 10, hidden/internal 8. **MCP (204 ops):** agent-core 16, agent-occasional 57, admin/maintenance 113, hidden/internal 18 (the 18 that are not in the public contract). Rules and judgment calls are in section 3.

## 1. gbrain-evals: every way it touches gbrain

### 1a. Library imports

The package dependency is `"gbrain": "github:garrytan/gbrain#6ce7195b44a034f85aec811f11fbf862db376f50"` (`gbrain-evals `package.json`:69`). `gbrain-cues` and `gbrain-reader` are separate pins of the same repo (lines 70-71).

gbrain's `package.json` (`gbrain `package.json``, version 0.60.733.0) has 31 `exports` entries, `main` = `src/core/index.ts`, and `bin.gbrain` = `src/cli.ts`. The `exports` map is what makes `gbrain/<subpath>` resolve for a package consumer. Every `gbrain/*` specifier the eval uses is in that map.

Counts are distinct files per specifier (static `from` and dynamic `import()`), from `scratch script scan_imports.py`:

| specifier | in exports map | files, all dirs | files under eval/ |
|---|---|---:|---:|
| `gbrain/pglite-engine` | yes (`./pglite-engine`) | 62 | 49 |
| `gbrain/ai/gateway` | yes | 54 | 36 |
| `gbrain/types` | yes (`./types`) | 24 | 19 |
| `gbrain/operations` | yes | 22 | 20 |
| `gbrain/config` | yes | 20 | 13 |
| `gbrain/import-file` | yes | 19 | 17 |
| `gbrain/search/hybrid` | yes | 18 | 16 |
| `gbrain/core/skillopt` | yes | 16 | 9 |
| `gbrain/engine` | yes | 11 | 9 |
| `gbrain/extract` | yes (`./extract`) | 5 | 5 |
| `gbrain/embedding` | yes | 5 | 5 |
| `gbrain/link-extraction` | yes | 5 | 4 |
| `gbrain/think` | yes | 3 | 3 |
| `gbrain/ai/invocation-guard` | yes | 2 | 1 |
| `gbrain/search/expansion` | yes | 1 | 1 |
| `gbrain/core/model-pricing` | yes | 1 | 1 |
| `gbrain/transcription` | yes | 1 | 1 |

Other packages: `gbrain-cues` (9 specifiers, 25 file-hits summed over specifiers, all dirs; `pglite-engine`, `ai/gateway`, `config`, `operations`, `import-file`, `search/hybrid`, `types`, `memory-cues`, `engine`) and `gbrain-reader` (5 specifiers, 11 file-hits; `eval/longmemeval/reader`, `ai/gateway`, `ai/invocation-guard`, `types`, `core/model-pricing`). These two packages are separate pins and their export maps were not checked.

Totals: 131 distinct `.ts` files import one of the three packages (82 under `eval/`, of which 79 are under `eval/runner/`; 46 under `test/`; 3 under `docs/`). 28 files use a dynamic `import('gbrain/…')`; the most common are `gbrain/ai/gateway` (16 sites), `gbrain/operations` (10), `gbrain/pglite-engine` (9), `gbrain/config` (8) and `gbrain/import-file` (7).

Path-based imports (the bigger contract). `eval/runner/gbrain-under-test.ts` documents that runners import gbrain modules "by absolute path under the chosen root" so that a copied checkout (`--gbrain <checkout>@<ref>`) is measured. `eval/runner/adapters/gbrain-inline.ts:66, 84-100` does the same for `productRoot`. Scan result from `scratch script scan_imports.py` and the refinement that counts only `src/` strings on `importGbrain`/`load` lines:

- 116 distinct `src/…` paths, in 68 non-test eval files.
- 16 of the 116 are exports targets (`src/core/operations.ts`, `src/core/pglite-engine.ts`, `src/core/ai/gateway.ts`, `src/core/import-file.ts`, `src/core/search/hybrid.ts`, `src/core/config.ts`, `src/core/think/index.ts`, `src/commands/extract.ts`, etc.).
- 100 are path-only: not reachable as a package import. Examples: `src/cli.ts` (21 files), `src/cli/main.ts`, `src/mcp/dispatch.ts` (7), `src/mcp/server.ts` (6), `src/mcp/tool-defs.ts` (3), `src/core/search/mode.ts` (5), `src/core/eligibility/*.ts`, `src/core/persistence/*.ts`, `src/core/eval-contradictions/*.ts`, `src/commands/extract-conversation-facts.ts` (3).
- Most used path-only: `src/core/pglite-engine.ts` appears in 39 files, `src/core/ai/gateway.ts` in 30, `src/core/operations.ts` in 24, `src/core/import-file.ts` in 23 (these four are also exports targets, so the path is valid whether or not the package is used).

Typed contract: the `GbrainModules` interface the in-process TS system takes (`eval/runner/systems/gbrain.ts:37-41`) requires three symbols: `PGLiteEngine`, `importFromContent` and `hybridSearch`. `eval/runner/systems/gbrain-agent.ts:121-129` loads `src/mcp/dispatch.ts`, `src/mcp/tool-defs.ts` and `src/core/operation-manifest.generated.ts` by path and calls `dispatchToolCall` in process.

Impact for Rust: each of these is a TypeScript-level contract (functions and classes with TS signatures, engine handles and `BrainEngine` objects). None can be satisfied by a Rust binary. Runners in these 79 + 46 files would need to be re-pointed at a protocol or process boundary; the exports-map list is the minimum and the path-only list is larger.

### 1b. CLI invocations (spawn/exec of `gbrain …`)

Method: each verb below was checked at its call site (file:line). The JSON fields column lists what the code reads from stdout. "argv only" means the argument array is built but the call was not run in that file.

| invocation (verbatim argv) | where (file:line) | JSON fields the eval reads |
|---|---|---|
| `init --pglite --path <dir> --embedding-model <m> --non-interactive` | `cat40/gbrain-arm.ts:396`, `p5-brain.ts:160`, `memory-trust/flag-rate.ts:149`, `facts-absorb-gate.ts:190`; `init --pglite --json` in `shim.py:571` | `init --json`: `status`, `engine`, `embedding_check`, `pages` (shim.py:588) |
| `config set <key> <value> [--force]` / `config get <key>` | `p5-brain.ts:164`, `p4-stream/run.ts:207`, `facts-absorb-gate.ts:191-192`, `chronicle-lift.ts:219-221`, `shim.py:625-626` | `config get` stdout text |
| `sources add <name> --path <dir> [--force]`, `sources default <name>` | `p5-brain.ts:161-162`, `lifecycle-experiment.ts:208-209`, `cat40/gbrain-arm.ts:416` | none |
| `sources writer status --json` | `cat40/gbrain-arm.ts:509-514` | `local_process_ingress` |
| `auth register-client <id> --grant-types client_credentials --scopes "read write" --source <s>` | `p5-brain.ts:168`, `lifecycle-experiment.ts:213`, `lifecycle/slice.ts:224`, `n6-postgres-http.ts:343` | client registration output (not parsed in detail) |
| `serve --surface starter\|full` (stdio MCP) | `cat40/gbrain-arm.ts:93`, `memory-trust/flag-rate.ts:156` (`full`), `p5-agent.ts:107` (`full`), `t0/parity.ts:125`, `shim.py:684`, `shim.py:715` | MCP JSON-RPC responses |
| `serve --http --bind 127.0.0.1 --port <p>` | `n6-postgres-http.ts:351` | HTTP MCP |
| `sweep --once --source <s> --json` | `p5-brain.ts:194` | `report.skipped[].reason` (fails on any `*_error`) |
| `jobs list --json [--limit N] [--status S]` | `shim.py:499-503` (quiesce gate) | JSON array; each job's `status` (PENDING_JOB_STATES, shim.py:98) |
| `jobs stats --json` / `jobs work --concurrency N` | `p8-write-cost.ts:132,138`, `memory-trust/flag-rate.ts:182`, `nightly/smokes/ingest-retry-across-upgrade.ts:87` | `jobs stats` output not parsed in detail |
| `doctor --json` | `shim.py:582` (`doctor_gate`), `shim.py:905` (quiesce rounds) | `checks[]` by `name`: `connection` (`details.reason == "live_serve"`, message `Connected, N pages`), `embeddings` (message `X% coverage, N missing`), `stale_embedding_effects.status`, `facts_drain.details.backlog`; any check with `status == "fail"` (shim.py:361-383) |
| `search modes --json` | `shim.py:641`, `cat40/rerank-pool-replay.ts:688` | `resolved` (the defaults hash input) |
| `models --json` | `shim.py:642` | `resolved.model_tasks["models.think"]` (shim.py:799) |
| `apply-migrations --yes --non-interactive --no-autopilot-install` | `shim.py:574`, `nightly/smokes/harness.ts` | exit code |
| `embed --stale` | `lifecycle-experiment.ts:251` | exit code |
| `extract --stale` | `lifecycle-experiment.ts:158`, `p5-agent.ts:115` | exit code |
| `extract-conversation-facts --yes --json --max-cost-usd 5 --workers 8` | `workload-suites/bench.ts:258-259` | stdout after the first `{` |
| `import <dir> --no-embed --json` | `p5-agent.ts:80`, `chronicle-lift.ts:222` | not parsed in detail |
| `recall --since 2000-01-01 --limit 1000 --json` | `predictive/cli-arm.ts:193` | not parsed in detail |
| `call recall '{"grep":…,"limit":100}'` | `facts-absorb-gate.ts:171-173` | `facts[].id` |
| `call <op> <json>` (generic bridge) | `lifecycle/drivers.ts:93`, `p4-stream/run.ts:209` (`put_page`) | op result |
| `dream --phase chronicle --json` | `chronicle-lift.ts:232` | not parsed in detail |
| `export --dir <d>` | `predictive/cli-arm.ts:183` | files |
| `put <slug>` (stdin markdown), `sync` | `predictive/cli-arm.ts:147,151` (`brain.must`) | exit code |
| `remember …`, `get <slug> --lines …`, `sources list`, `git commit-push …` (argv only) | `generators/write-contract-gen.ts:123,166,152,145` | not run in that file |
| `eval longmemeval <dataset> …` | `scripts/run-shootout-phase1.sh:188` | shell-level only |
| `stats` | `cat41/scenarios.ts:186` | not parsed in detail |

Write-path classification: `eval/runner/cat41/classify.ts:54-57` defines `WRITE_PATH_COMMANDS = {put, timeline-add, remember, import, sync, capture, report, tag, link, edit}` and `WRITE_PATH_OPS = {put_page, edit_page, add_timeline_entry, remember, capture, add_tag, add_link}`, and states that `embed`, `doctor`, remediation, extraction and enrichment are not write paths. This is the eval's own command classification and agrees with section 3 on `doctor` and `embed`.

Heuristic counts (not used as evidence): a regex over argv arrays also matches generic words such as `facts`, `status`, `list` in unrelated string arrays (`facts:44`, `status:44`). Those numbers were discarded.

### 1c. MCP usage

Transport: newline-delimited JSON-RPC over stdio. `eval/runner/cat40/gbrain-arm.ts:60-100` (`McpClient`) spawns `bun <buildDir>/src/cli.ts serve --surface <surface>` with `GBRAIN_HOME` as cwd and reads responses line by line. The Python shim does the same with `McpStdio([GBRAIN, "serve", ...])` (`shim.py:193-270`, `:684`). `serve --http` is used once (`n6-postgres-http.ts:351`). `eval/runner/systems/mcp-tools.ts` is a neutral adapter over any server with `listTools()` and `callTool()`.

Surfaces used by the eval: `starter` (default in `cat40-model-ladder.ts:732`; `shim.py:715`; `t0/parity.ts:125`; `p4-stream/run.ts:212`), `full` (`memory-trust/flag-rate.ts:156`, `p5-agent.ts:107`, and the labeled `think` row in the shim, `GBRAIN_FULL_SURFACE=1`). `cat41-agent-operator.ts:256` takes the surface as a parameter.

Tool names called (count = call sites in non-test eval code: `.call('name')`, `callTool`, `.op('…')`, plus the Python shim constants `STARTER_CALLS`, `FULL_SURFACE_CALLS`, `F6_CALLS`, and `GBRAIN_AGENT_TOOLS`):

| MCP tool | eval call sites | where (examples) |
|---|---:|---|
| `get_page` | 16 | `cat40/gbrain-arm.ts`, `systems/gbrain-agent.ts:49` (`query`, `search`, `get_page`) |
| `put_page` | 11 | `shim.py` STARTER_CALLS; `p4-stream/run.ts`; `n14-large-page-fidelity.ts` |
| `remember` | 8 | `memory-trust/flag-rate.ts:173`, `repro.ts`, `n5-forget-residue.ts` |
| `query` | 6 | `shim.py` STARTER_CALLS; `systems/gbrain-agent.ts` |
| `search` | 5 | `systems/gbrain-agent.ts`, `n5-forget-residue.ts:126` |
| `recall` | 5 | `shim.py` F6_CALLS; `correction-adapters.ts:96`; `n5-forget-residue.ts` |
| `entity` | 4 | `cat38-state-resolution.ts`, `temporal-ingest-answer.ts` |
| `context_pack` | 4 | `memory-trust/repro.ts`, `n6-postgres-http.ts` |
| `forget` | 3 | `correction-adapters.ts:102` (`gbrain_call` → `forget`) |
| `purge_fact` | 2 | `cat39-deletion-audit.ts` |
| `assemble_evidence` | 2 | `n6-postgres-http.ts`, `evidence-delivery/e3.ts` |
| `list_pages` | 2 | `shim.py` STARTER_CALLS; `p5-agent.ts` |
| `list_write_requests` | 1 | `shim.py` STARTER_CALLS (`outbox_pending`) |
| `get_write_request` | 1 | `shim.py`; `refresh-barrier/runtime.ts` |
| `synthesize` | 1 | `shim.py` STARTER_CALLS |
| `think` | 1 | `shim.py` FULL_SURFACE_CALLS |
| `add_timeline_entry` | 1 | `p5-agent.ts`, `n3-temporal-asof.ts` |
| `get_timeline`, `get_versions`, `get_links`, `get_chunks` | 1 each | `n6-postgres-http.ts`, `lifecycle/observe.ts` |
| `begin_page_upload`, `upload_page_part` | 1 each | `n14-large-page-fidelity.ts` |
| `delete_page`, `takes_add`, `sources_add`, `run_doctor` | 1 each | `p5-agent.ts`, `cat39-deletion-audit.ts`, `agent-retrieval-shapes.ts` |

Not gbrain MCP tools, though they appear in the same call sites: `comparator_http`, `comparator_retain` (the Hindsight comparator, `workload-suites/correction-adapters.ts:137`), `retrieve`, `ingest`, `init`, `close`, `gbrain_put`, `gbrain_call`, `gbrain_cli` (harness bridge names in `workload-suites/`).

### 1d. Adapter and plug-in interfaces

Four seams exist. The first two are TypeScript-only. The third (HTTP protocol v1) and the fourth (a process that the shim drives through CLI and MCP) can take a Rust binary with no TypeScript involved.

1. **`Adapter` (TypeScript, in process)**: `eval/runner/types.ts:209-260`. Methods: `name`, `init(rawPages, config) -> BrainState`, `query(PublicQuery, state) -> RankedDoc[]`, and optional `snapshot`, `getPoisonDisposition`, `teardown`. `BrainState` is opaque. Implementers: `GbrainInlineAdapter` (`adapters/gbrain-inline.ts:163`), `RipgrepBm25Adapter` (`adapters/grep-only.ts:156`), `VectorOnlyAdapter` (`adapters/vector.ts:101`), `HybridNoGraphAdapter` (`adapters/vector-grep-rrf-fusion.ts:77`), `ClaudeSonnetWithToolsAdapter` (`adapters/claude-sonnet-with-tools.ts:225`), `GbrainNoSourceBoostAdapter` (`cat13b-source-swamp.ts:348`). The registry is a local list (`multi-adapter.ts:665`, `selectAdapters` at `:623`). `createGbrainProductAdapter()` (`multi-adapter.ts:80`) is used at 30 construction sites across 15 files. No adapter spawns a process: a Rust engine would need a TypeScript wrapper, and none exists.

2. **`MemorySystem` (TypeScript, in process)**: `eval/runner/systems/types.ts:132-145`. Methods: `capabilities()`, `reset(ns)`, `ingestSession(ns, session, event_time)`, `finishIngest(ns, timeoutS)`, `retrieve(ns, question, policy)`, `deleteSource(ns, sourceId)`, optional `close()`. Implementers include `GbrainShootoutSystem` / `GbrainLegacySystem` (`systems/gbrain.ts`, which takes `GbrainModules`), `FakeMemorySystem`, `FullContextSystem`, `NoMemorySystem`, `PlainHybridSystem` (`systems/baselines.ts`), `AgentRuntimeSystem`, `GbrainAgentSystem`, and `HttpMemorySystem`.

3. **Protocol v1 over HTTP (language neutral)**: `eval/systems/PROTOCOL.md` (127 lines). The client is `HttpMemorySystem` (`eval/runner/systems/http.ts:36`), which implements `MemorySystem`. Endpoints: `GET /health`, `GET /capabilities` (capability record with `versions`, `configs`, `retrieval_policies`, `agent_surface`, optional `answer.modes`), `POST /reset {ns}`, `POST /ingest {ns, session{source_id, event_time, turns[]}}`, `POST /finish {ns, timeout_s}`, `POST /retrieve {ns, question, query_time, policy{name, mode, settings}}` returning `items[]` with `id`, `rank`, `type`, `text`, `source_ids`, `provenance_status`, `POST /delete_source {ns, source_id}`, and optional `POST /answer`. Selection: `--system <http(s) URL>` in `memory-qa/run-systems.ts:592` and `--system-url <URL>` in `q1/cell.ts:9,494`. There are 7 `new HttpMemorySystem(...)` sites in non-test code (`lifecycle-lite.ts:180`, `precisionmembench-system.ts:369,427`, `memory-qa/run-systems.ts:382,592`, `q1/cell.ts:494`, `q1/stress-pilot.ts:228`).ts:494`). The harness sanitizes inputs and never sends dataset ids or answer labels (PROTOCOL.md, "What crosses the boundary").

4. **CLI and MCP process seam (example: the gbrain-defaults shim)**: `eval/systems/gbrain-defaults/shim.py` (1272 lines) is a Python HTTP shim that drives an external gbrain. It runs the binary named by `GBRAIN_BIN` (default `gbrain`, `shim.py:62`) for CLI calls (`init`, `apply-migrations`, `doctor --json`, `jobs list --json`, `search modes --json`, `models --json`, `config set/get`) and runs `serve --surface starter|full` over MCP stdio (`shim.py:684`). Its required MCP ops are `put_page`, `get_write_request`, `list_write_requests`, `query`, `list_pages`, `synthesize` (starter), `think` (full, labeled) and `recall` (F6). `shim.py:75-80` checks at install and at every serve start that these appear in `tools/list`.

Rust implications:
- Option A (cleanest): implement protocol v1 as an HTTP service. The harness then needs no change, only `--system http://…`. Capability record and `/finish` readiness semantics must be reproduced.
- Option B: keep the gbrain-defaults shim and point `GBRAIN_BIN` at a Rust binary. That binary must match the CLI verbs and JSON shapes in 1b (especially `doctor --json` checks, `jobs list --json` arrays, `search modes --json` / `models --json` resolved values) and the starter MCP tool list.
- Not possible without a TypeScript build: `--gbrain <checkout>` (`gbrain-under-test.ts`) extracts and runs a TypeScript source tree; `Adapter` and `MemorySystem` are TypeScript interfaces; path-based imports load `src/*.ts`.

## 2. Agent usage inside gbrain itself

Counting method: `gbrain <verb>` strings matched with `rg -o` over each surface, then joined to the 220 CLI names; MCP tool names counted as backticked `` `name` `` and as `mcp__gbrain*__name`. `skills/migrations/` (per-version upgrade notes, 1102 command hits) is counted separately because it describes history, not agent behavior. `plugin/skills/` is a near copy of `skills/` (84 files differ, mostly `SKILL.md`; `RESOLVER.md` is only in `skills/`), so it is reported separately and not added to the totals.

| surface | files | distinct CLI commands referenced | command hits |
|---|---|---:|---:|
| `skills/` (76 `SKILL.md`, `RESOLVER.md`, `_AGENT_README.md`, 19 `conventions/*.md`, excluding `migrations/`) | 90 entries | 122 | 1505 |
| `skills/migrations/` (version notes) | 85 | 88 | 1102 |
| `plugin/skills/` (mirror; `plugin/` has 141 files) | 141 | 117 | 1398 |
| templates + `INSTALL_FOR_AGENTS.md` + `AGENTS.md` + `BOOTSTRAP_FOR_AGENTS.md` + `docs/UPGRADING_DOWNSTREAM_AGENTS.md` + `CLAUDE.md` + `README.md` | | 77 | 446 |
| `src/mcp/instructions.ts`, `openclaw.plugin.json`, `src/openclaw-context-engine.ts`, `plugin/README.md` | 4 | 3 (prose only) | — |

Top CLI references in skills/ (excluding migrations): `schema` 96, `doctor` 74, `jobs` 72, `search` 63, `sync` 62, `query` 59, `mcp` 56, `config` 50, `sources` 40, `get` 38, `bootstrap` 32, `eval` 31, `serve` 28, `files` 25, `capture` 22, `skillpack` 22, `write-request` 22, `recall` 21, `graph-query` 19, `publish` 19, `dream` 18, `extract` 17, `init` 17, `put` 17, `transcripts` 17.

Top in the agent entry docs (templates + top-level guides): `bootstrap` 52, `doctor` 34, `config` 16, `init` 16, `sync` 16, `setup` 15, `upgrade` 13, `serve` 12, `sources` 12, `extract` 10, `query` 10, `search` 10.

Notes on the largest counts: `schema` is concentrated in the `schema-author` and `brain-taxonomist` skills; `doctor` and `config` are spread across many files, and `doctor` appears in `conventions/agent-operator-protocol.md` 26 times (the operator protocol that tells an agent to run health checks). `bootstrap` in templates is mostly `templates/bootstrap/*` text (25 lines in templates alone).

### 2a. MCP server instructions (`src/mcp/instructions.ts`)

This file is the operating contract every MCP client receives on `initialize`. It names these tools as agent behavior (the text, not counts):

- Memory loop: `context_pack` (session start), `volunteer_context` (topic shift), `remember` (explicit keep requests, provenance), `recall` ("facts saved with remember are read back with recall"), `entity` (briefs; `names` rows), `get_backlinks`.
- Search: `search`, `query` ("before external lookup"), `get_page` (`include_content:true`).
- Writing: `put_page` (replaces the whole page; read it first), `put_pages` (batches over 3 pages), `append_page`, `edit_page` (over 256 KB), and `wait_ms` / `request_id` replay.
- Skills: `list_skills`, `get_skill`, `get_skill_asset`, `put_skill`, `delete_skill` (needs `skill_editor` authority), `join_brain`, `sync_brain_skills`.
- Other: `forget`, `memory_conversation_mode`, `whoami`, `request_tools`, `watch_job`, `submit_job`, `submit_agent`, and the resource `gbrain://capabilities`.

It names no CLI command. The only `gbrain <word>` strings in that file are prose ("gbrain as", "gbrain notice").

### 2b. Plugin, OpenClaw and context engine

- `openclaw.plugin.json`: `mcpServers.gbrain` is `./.agents/gbrain-launcher` with args `["serve"]`; `contracts.contextEngines` lists `gbrain-context-engine`; `skills` lists 65 bundled skills; `excluded_from_install` is `skills/setup`, `skills/migrate`, `skills/publish`. Those three are therefore operator-only workflows.
- `plugin/README.md:11`: the plugin's MCP server runs `gbrain serve --surface full` (204 tools), with `GBRAIN_SURFACE=starter` or `verbs` to narrow the surface.
- `src/openclaw-context-engine.ts` (146 lines): imports `./core/context-engine.ts`, `./core/context/reflex.ts` and `node:path` only. It has no CLI or MCP string. It is an in-process TypeScript integration.

### 2c. Hooks

`gbrain hook <event>` is a harness entry point, not an agent command. `src/cli/commands/hook.ts` says it "NEVER opens an engine (talks to serve's IPC socket only)". `src/commands/hook.ts:27-32` documents the events: `session-start` (digest from file reads), `user-prompt` (returns `additionalContext` from IPC `turn_context`), `stop` and `session-end` (transcript to a secret-scanned corpus file). The hook is referenced in `docs/mcp/CODEX.md:92`, `docs/mcp/CLAUDE_CODE.md`, `docs/guides/setup.md:340`, `docs/guides/ambient-writeback.md:311` (`GBRAIN_HOOKS=0` disables it), and `skills/RESOLVER.md:174`. `hook` has 0 skill references and 9 eval text mentions (harness-level).

### 2d. Templates and bootstrap

`templates/bootstrap/` (`AGENTS.md.template`, `CLAUDE.md.template`, `MEMORY.md.template`, `questions.json`, and a `template-repo/`) mentions `bootstrap` 25 times, `doctor` 7, `sources` 6, and `skills`/`search`/`query`/`get` 4 each. `BOOTSTRAP_FOR_AGENTS.md` (310 lines) is almost entirely `bootstrap` (29) and `doctor` (8).

### 2e. Surface sizes (inventory cross-check)

- CLI: 220 public commands, matching `docs/contracts/public-surface.json` `cli-command` (220 entries, no differences from the inventory). 613 `cli-flag` entries; 132 explicit command-table records (`src/cli/command-table.ts`: 74 post-connect, 46 pre-connect, 12 pre-connect-own-engine; the rest dispatch through the op manifest).
- MCP: 204 ops in `operation-manifest.json` / `ops-summary.tsv`; 186 public `mcp-tool` entries in the contract. The 18 ops that are not public are all `cliOnly` or `localOnly` (`purge_deleted_pages`, `purge_fact`, `connector_sync`, `storage_register`, ...).
- Surface files: `tools-list-verbs.json` 7 tools; `tools-list-starter.json` 41 (the 7 verbs plus 34 starter ops); `tools-list-full.json` 176.
- `cliHints.hidden: true` is set on 36 ops in `operation-manifest.json`. That hides the op from the op-derived CLI; several of those names are also explicit CLI commands (for example `think`, `capture`, `advisor`, `orphans`), so the flag does not by itself mean "internal".

## 3. Classification


### 3a. Rules

Each command gets one class by its primary purpose. Eval use and agent references are separate columns, so a reader can see a dependency without it changing the class.

- **agent-core**: a verb in the 7-tool verbs surface, or a memory-loop op named in `src/mcp/instructions.ts` (`search`, `query`, `get_page`, `put_page`, `remember`, `recall`, `entity`, `forget`, `context_pack`, `volunteer_context`, `whoami`, `get_backlinks`, `request_tools`, `memory_conversation_mode`), plus CLI names that map to those ops or to `serve` and `call`. Only memory and retrieval operations an agent calls during a task.
- **agent-occasional**: an agent calls it in a specific workflow (skills, starter surface, or instructions), not in the everyday loop: ingest, takes, skills, storage, graph, insights, transcripts.
- **admin/maintenance**: operator tooling (repair, reindex, upgrade, migrations, jobs, sources, config, doctor, backup, sync, export/import, pricing, storage administration). Agents may run some of these as checks; that does not make them agent-core.
- **setup/install**: bring-up and host wiring (`init`, `setup`, `bootstrap`, `engine`, `connect`, `auth`, `creds`, `providers`, `google`, `remote`, `mcp`, `onboard`, `integrations`, skillpack install).
- **dev/eval-only**: benchmarks, eval runners, routing/skillpack checks, smoke tests.
- **hidden/internal**: harness-invoked (`hook`), aliases (`get_links`, `link-add`, `link-rm`), plumbing with no agent or skill references (`conversation-parser`, `compile-context`, `protocol`, `founder`).
- **MCP classes**: `hidden/internal` = not in the public contract (18 ops; CLI-only or local-only). `agent-core` = verbs or instruction-named ops. `agent-occasional` = starter surface, or any skill/doc/instruction/eval reference. `admin/maintenance` = everything else.

The full per-command tables live next to the contracts they classify:

- CLI (220 commands): [cli.md, Part C](cli.md#part-c-which-commands-agents-and-evals-use).
- MCP (204 operations): [mcp.md, section 8](mcp.md#8-which-tools-agents-and-evals-use).

### 3d. Judgment calls and what would change them

1. **Eval-used operator commands stay operator classes.** 19 commands that the eval invokes are not agent-core under the primary-purpose rule: `init`, `auth` (setup); `config`, `sources`, `sweep`, `jobs`, `extract`, `export`, `sync`, `doctor`, `models`, `apply-migrations`, `embed`, `dream`, `stats` (admin); `extract-conversation-facts`, `import`, `git` (agent-occasional); `eval` (dev). The eval column shows each one. If you want "any eval use" to mean agent-core, these 19 move; for porting order they are required for parity runs either way.
2. **`doctor` (74 skill refs) is admin/maintenance.** `conventions/agent-operator-protocol.md` tells agents to run it as a health gate, and the shim uses `doctor --json` as the quiesce gate. It is still an operator diagnostic.
3. **`schema` (96 skill refs) is agent-occasional.** Those refs are almost all in `schema-author` and `brain-taxonomist`, which author schema packs; the eval does not use it.
4. **`serve` and `call` are agent-core.** `serve` is the MCP entry point that every host launches, and the eval spawns it constantly. `call` is the generic CLI-to-op bridge the eval uses.
5. **`hook` is hidden/internal.** It is launched by the harness on session events, and the shim and agents never invoke it directly.
6. **`decide` is classed dev/eval-only, but it is mixed.** `src/cli/commands/decide.ts` says `decide probe` is user-facing and `decide judge-agreement` is eval-only. A split would be needed if the Rust port keeps both.
7. **Low-confidence classes** (no skill refs; class taken from the help header only): `founder`, `lsd`, `brainstorm`, `core`, `compile-context`, `protocol`, `beliefs`, `notices`.
8. **MCP hidden = not in the public contract.** Those 18 ops (`purge_deleted_pages`, `purge_fact`, `list_page_purges`, `unpurge_page`, `connector_sync`, `connectors_status`, `file_register`, `file_verify`, `get_recent_transcripts`, `get_skill_retention`, `prune_skill_revisions`, `retain_skill_revision`, `import_skill_proposal`, `sources_inspect`, `storage_register`, `storage_update`, `migrate_embeddings`, `extraction_review`) are unreachable from an MCP client, so they only need the CLI.

## 4. Caveats

- Counts are regex matches on text. `gbrain <word>` can be prose (for example `get`, `list`, `search`), and bare MCP names such as `query` or `search` are noisy, so MCP counts use backticks and `mcp__gbrain*__` only.
- Eval call sites were read or grepped for each verb in section 1b. The `embed --stale`, `dream --phase chronicle` and `stats` sites were found with a literal grep and not read in full.
- The eval's `package.json` pins were read, not the commit contents: `gbrain` at `6ce7195b…`, which is not the `master` the brief describes. Section 1 describes the pinned code only where the eval checkout pins it.
- `gbrain-cues` and `gbrain-reader` are separate package pins; their export maps and the specific symbols they export were not checked.
- The gbrain tree is the working copy at gbrain (`github.com/garrytan/gbrain`); the brief's commit `8bbfd0b5e8` was not verified against that copy.
- The MCP and CLI tables reflect the inventory at `docs/research/rust-engine/data/`. Where the inventory and the source differed, the source was used and noted above (for example `cliHints.hidden` on 36 ops).
