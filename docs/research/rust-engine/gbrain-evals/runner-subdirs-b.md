> Appendix to [../gbrain-evals.md](../gbrain-evals.md). Detailed per-area notes from one research pass over gbrain-evals `cd447b3` (v0.10.237) and gbrain `6ce7195`. Paths are relative to the gbrain-evals root unless marked `gbrain:`. "G1" to "G10" in the text name the appendix files listed in the main map.

# G6 runner dirs B: gbrain-evals runners (live-recall through takes-bootstrap)

Source root: the gbrain-evals checkout (HEAD cd447b3, Release v0.10.237). Paths below are relative to that root.
Scope: eval/runner/{live-recall, memory-qa, memory-trust, messy-company, miss-mining, nightly, outcomes, predictive,
providers, refresh-barrier, rs1, skillopt-method, sota, strict-pageless, system-one, systems, takes-bootstrap},
eval/runner/mcp-contract.ts, eval/runner/tool-bridge.ts, docs/nightly.md, scripts/nightly-*.sh, scripts/refresh-barrier-*.ts.
Method: header and usage reads, rg for gbrain imports, spawns, JSON-RPC and tool names. Not every file was read in full.
Files under cat40/ (McpClient, execGbrain-like helpers, loop.ts) and lifecycle/drivers.ts are outside this scope and were read only where a scoped file calls them.

## Summary table

| Runner | Entry path | Measures | Run command | Tier / time / cost | LLM keys | Corpus | Coupling |
|---|---|---|---|---|---|---|---|
| BrainBench Cat 12 MCP contract | eval/runner/mcp-contract.ts | Remote vs local trust boundary and limits on gbrain operation handlers (depth cap, list clamp, search mode, injection) | `bun eval/runner/mcp-contract.ts [--json]` | offline; seconds; $0 | none | generated in-run (~150 pages) | in-process (PGLiteEngine, OPERATIONS handlers) |
| Tool bridge (library, no runner) | eval/runner/tool-bridge.ts | Adapts read ops to Anthropic tool defs; executes them with remote:true | imported by Cat 8/9 agent loops (outside scope) | n/a | none | n/a | in-process (gbrain/operations) |
| Nightly gbrain check | eval/runner/nightly/run.ts (+ tool-contract.ts, smokes/, worker.ts, adapters.ts, bisect.ts) | Dev-set pass rates per suite, cost per correct answer, regressions vs previous night | `bun eval/runner/nightly/run.ts --ref master --tier matrix --fake --out <dir> --gbrain-clone <path>` (docs/nightly.md:251) | `--fake` keyless; `--paid` needs ledger run; wall time unknown | only for model suites (`--paid`) | eval/data dev-set, docs/benchmarks inputs (exported by scripts/nightly-export.sh) | mixed: CLI (smokes), in-process (tool-contract, worker), HTTP (serve --http health only) |
| Nightly tool-contract replay | eval/runner/nightly/tool-contract.ts | Refusals of recorded frontier tool calls on rollout, write-capture and MCP dispatch paths | `bun eval/runner/nightly/tool-contract.ts --gbrain-root <dir> --out <file.json> [--families sol,opus] [--skills query,briefing,fact-check]` | keyless; wall time unknown | none | docs/benchmarks/2026-11-01-skillopt-method/probe/frontier | in-process (dynamic import of build src/mcp/dispatch.ts) |
| Nightly system smokes | eval/runner/nightly/smokes/*.ts | Seven keyless CLI and serve behaviours (upgrade, sync, ingest retry, Postgres 15) | via nightly/run.ts `system-smokes` suite | keyless; unknown | none | seeded synthetic brain | CLI (spawn `bun src/cli.ts`), HTTP (`serve --http`, GET /health) |
| Refresh-barrier validation | eval/runner/refresh-barrier/run.ts (+ trial.ts, child.ts, agent.ts, runtime.ts, schedule.ts, analyze.ts) | Refresh write barrier: write landing, refusals, concurrency, quiet latency; agent-level writes | `bun eval/runner/refresh-barrier/run.ts --block trials\|named\|quiet --engine postgres\|pglite --gbrain-root <G> --out <dir>` | paid agent caps: opus $65, sol $35, smoke $5 (refresh-barrier/agent.ts:72-76); trials keyless; wall time unknown | Anthropic, OpenAI for agent block | seeded synthetic git fixture (fixture.ts) | in-process (dispatchToolCall, PGLite/Postgres engines), child processes (bun child.ts) |
| Refresh-barrier helpers | scripts/refresh-barrier-b1-guard.ts, scripts/refresh-barrier-partc-adjudicate.ts | Idle-machine guard; Part C write adjudication | `bun scripts/refresh-barrier-b1-guard.ts --out <dir> -- <cmd>` | n/a | none | n/a | none (scripts) |
| Live recall | eval/runner/live-recall/run.ts (+ task-arms.ts, tasks.ts, brain.ts, synthetic.ts, scorecard.ts) | recall@k and retrieval arms A/B/C/D on private questions | `bun eval/runner/live-recall/run.ts run --fixture` or `run --synthetic <dir>`; `freeze`; `--paid` for Voyage | `--paid` cost from synthetic.ts estimateVoyageUsd; time unknown | Voyage (embedding, rerank), Anthropic/OpenAI for readers | private brain on the box (not committed) or synthetic dir | in-process for embeddings; MCP-shaped dispatch (dispatchToolCall) |
| Memory QA (arms) | eval/runner/memory-qa/run.ts + run-systems.ts (+ corpus.ts, qa.ts, arms.ts, beam10m-*.ts) | LoCoMo, LongMemEval-S, BEAM accuracy per gbrain build | `bun eval/runner/memory-qa/run.ts --benchmark locomo\|lme-s\|beam-100k\|beam-1m\|fixture [--embed hash\|real] [--paid --budget-run-id <id>]` | `--embed hash` and `--qa none` keyless; paid estimate in code (run.ts:572); wall time unknown | QA reader and judge when `--qa reader` | benchmark datasets (eval/data), generated synthetic corpora | in-process (PGLite, hybridSearch, importFromContent, runThink) |
| Memory trust flag-rate (amendment 5) | eval/runner/memory-trust/flag-rate.ts | How often the write gate flags ordinary use; review queue size on LongMemEval-S users | `bun eval/runner/memory-trust/flag-rate.ts --out <dir> [--users 16 --control-users 4 --inject 5] [--smoke --keyless]` | paid budget via startPaidRun; time unknown | Anthropic/OpenAI for agent | LongMemEval-S haystacks (`--lme`) | MCP over stdio (`serve --surface full`) + CLI |
| Memory trust sut / repro / utility guard | eval/runner/memory-trust/sut.ts, repro.ts, utility-guard.ts, agent.ts, flag-rate-score.ts, join-cat37.ts | Cat 37/38/39 trust checks on a hermetic PGLite brain; finding repros; LongMemEval utility | `bun eval/runner/memory-trust/repro.ts --gbrain <checkout>@<ref> <finding>` | repro keyless; utility guard paid | utility guard: reader and judge keys | synthetic brain; LongMemEval-S | in-process (operationsByName handlers), CLI capture for utility-guard |
| Messy company loader and scorers | eval/runner/messy-company/load.ts, score-*.ts, common.ts | Ownership windows, timelines, aliases, document status, entity mentions on messy-company-v1 | `bun eval/runner/messy-company/load.ts --split dev\|heldout\|all [--db <dir>] [--json]`; `score-*.ts <system output.json>` | keyless; seconds | none | eval/data/messy-company-v1/corpus/<split> (committed) | in-process (load only: importFromContent, PGLiteEngine); scorers none |
| Miss mining | eval/runner/miss-mining/weekly-counts.ts, to-live-recall.ts, schema.ts, custody.ts | Private miss log to counts and live-recall questions | `bun eval/runner/miss-mining/weekly-counts.ts --log <log.jsonl> --week <date> --out <json>` | keyless | none | private miss log (not in repo) | none |
| Outcomes v3 | eval/runner/outcomes/v3.ts, rescore-a4.ts, validate-labeler.ts | Versioned answer-outcome labels (abstain, hedge, commit) beside frozen scorer | `bun eval/runner/outcomes/rescore-a4.ts <receipt.json>` ($0) ; `validate-labeler.ts --paid ...` | rescore $0; labeler paid | labeler: model ladder keys | A4 receipts; labeler samples (custodian folder) | none (pure scoring) |
| Predictive measures | eval/runner/predictive/run.ts (+ cli-arm.ts, write-contract.ts, episodes.ts, out-of-view/, scale-latency/, ubicloud/) | Agent behaviour on CLI and MCP surfaces: write landing, call contract, reach, latency | `bun eval/runner/predictive/run.ts ...` (see predictive/README.md); scale-latency via ubicloud/run.sh | keyless grammar; paid episodes; wall time unknown | Anthropic/OpenAI for agent episodes | synthetic brain built per run | CLI (execFile `bun src/cli.ts`) + MCP (`gbrain serve` stdio) + in-process brain build |
| Provider transport | eval/runner/providers/openai-compatible.ts | Request/response/error shape for Particle and Gemini judge endpoints | imported by reader and judge runners | n/a | Particle, Gemini keys at call time | n/a | none |
| RS1 verdict | eval/runner/rs1/verdict.ts, iut.ts, power.ts, pricing.ts, paid-window.ts | RS1 pre-registered decision rule (gbrain vs memory-bank vs extract-first) | `bun eval/runner/rs1/verdict.ts verdict --receipts <dir>...` | $0 analysis; pricing and paid-window are guards | none directly | receipts from cell.ts (outside scope) | none (pure analysis) |
| SkillOpt method | eval/runner/skillopt-method/*.ts | SkillOpt optimizer headroom, one-shot, scoring, gate on gbrain skills | `headroom.ts`, `one-shot.ts`, `score.ts` (see file headers) | frontier probe paid; test seam for chat transport | Anthropic (claude-opus-5-5), OpenAI (gpt-6.1-sol) | skillopt-method-v2/v3 dataset (docs/benchmarks) | in-process (gbrain/core/skillopt, ai/gateway, pglite-engine, operations) |
| SOTA loop | eval/runner/sota/*.ts (+ ubicloud/) | Monthly gbrain minus leader (whole-history reader, grep agent) on dev and sealed questions | `bun eval/runner/sota/leader.ts plan --cache <dir>`; `oracle.ts run ...`; `scorecard.ts --rows ...` | paid via q1 cells (outside scope) | Anthropic, OpenAI, Particle | BEAM-1M and LongMemEval-S outcome cache | indirect (memory-qa reader via q1 cells); scoring none |
| Strict-pageless cell | eval/runner/strict-pageless/agent.ts (+ items.ts, analyze.ts, report.ts) | Does a remember for an entity with no page survive a rebuild from Git; is the reply truthful | `bun eval/runner/strict-pageless/agent.ts --model <p:id>\|fake --gbrain-root <checkout> --items 1-24 --k 1 --out <dir>` | paid (budgetOptionsFrom); `--model fake` keyless | Anthropic, OpenAI when not fake | refresh-barrier fixture, synthetic | MCP-shaped dispatch (dispatchToolCall, remote stdio) + in-process sync/extract |
| System One (Jev) per-slot evals | eval/runner/system-one-jev.ts (+ slots.ts, datasets.ts, recount.ts) | Nine gbrain System One decision slots, matched pair per slot | `bun eval/runner/system-one-jev.ts verify` / `plan` / `run` | paid (typesafe:jev-1.13.0); plan prints commands | TypeSafe Jev key | LongMemEval / dataset runners | CLI (spawnSync `bun src/cli.ts`, env allowlist) |
| Memory-system shootout (systems) | eval/runner/systems/*.ts | Adapter layer: gbrain in process, gbrain-agent, gbrain-query connector, neutral MCP tools, HTTP systems | consumed by memory-qa and shootout drivers | keyless for gbrain legacy; baselines paid | per baseline | shootout datasets | in-process (gbrain.ts, gbrain-agent.ts, gbrain-query), MCP-shaped neutral adapter (mcp-tools.ts), HTTP client (http.ts, non-gbrain) |
| Takes bootstrap overlay | eval/runner/takes-bootstrap/harness-overlay.mjs (+ .diff) | gbrain takes-bootstrap harness with price overrides, summary and request log | `bun eval/runner/takes-bootstrap/harness-overlay.mjs --gbrain-dir <tree> ...` | paid (provider requests logged) | provider key for the model under test | gbrain's evals/takes-bootstrap corpus | in-process (loads gbrain harness and src/ from --gbrain-dir) |

---

## MCP and CLI surface (priority section)

This section seeds the adapter-surface recommendation. Two kinds of call exist:
1. Real MCP wire calls: a child process runs `bun <build>/src/cli.ts serve ...` and the client speaks JSON-RPC 2.0 over newline-delimited stdio.
2. In-process "MCP-shaped" calls: gbrain's own `dispatchToolCall(engine, name, args, opts)` from `src/mcp/dispatch.ts` is imported and called, returning `{content:[{type:'text',text}], isError?}`. No protocol framing or process boundary is crossed. Several runners label this "as gbrain serve receives them".

### Server launch (real wire)

| Caller | Command | Transport | Notes |
|---|---|---|---|
| McpClient in eval/runner/cat40/gbrain-arm.ts:93 (used by predictive/cli-arm.ts:232, memory-trust/flag-rate.ts:156, predictive/out-of-view/agent.ts) | `spawn('bun', [<buildDir>/src/cli.ts, 'serve', ...args], {env, cwd: GBRAIN_HOME})` | stdio, newline JSON-RPC | args e.g. `['--surface','full']`, `['--surface','starter']`, `['--access','read-only']` |
| McpClient warm start (cat40/gbrain-arm.ts:482) | same | stdio | waits for reply to one read-only `entity` call before timing |
| nightly/smokes/harness.ts:174 | `spawn('bun', ['--no-env-file', <root>/src/cli.ts, 'serve', '--http', '--port', N, ...])` | HTTP | ready when `GET http://127.0.0.1:<port>/health` returns 200 |
| nightly/smokes/harness.ts:149 | writes a shim `bin/gbrain` = `exec bun --no-env-file <root>/src/cli.ts "$@"` | CLI | used for upgrade-from-previous installs |

### JSON-RPC methods and shapes (McpClient, cat40/gbrain-arm.ts:60-145)

| Method | Params sent | Result read |
|---|---|---|
| `initialize` | `{protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'gbrain-evals-cat40', version:'1'}}` (line 120) | `init.error` checked; instructions taken from the result |
| `notifications/initialized` | none (notification, no id) | none |
| `tools/list` | `{}` | list of `{name, description, inputSchema}` (`listTools`, line 137) |
| `tools/call` | `{name, arguments}` (line 143) | `{content:[{type:'text',text}], isError?}`; text blocks joined by newline |
| server notification `notifications/tools/list_changed` | n/a | triggers relist (line 105) |

Error and invalid-JSON lines are skipped (`not JSON-RPC`, line 104). Per-call timeout is `callTimeoutMs`; init timeout defaults to 180 s (line 91).

### MCP tool names called (by file)

| Tool | Called from | Request arguments observed | Response assertions |
|---|---|---|---|
| `search` | cat40 McpClient call (outside scope), predictive/run.ts (`call` op) | `{query}` | text result |
| `query` | live-recall/task-arms.ts:186 (in-process), live-recall/tasks.ts (`.call('query'`), memory-trust/repro.ts:41, nightly/smokes via CLI | `{query, limit, expand:false forced}` | `_meta.retrieval` via emitResponseMeta; `meta.degraded[].stage` |
| `get_page` | live-recall/task-arms.ts:210, predictive/out-of-view/agent.ts (`.call('get_page'`), refresh-barrier/agent.ts (`call('get_page'`), refresh-barrier/runtime.ts (`call(s, sourceId, 'get_page'`), nightly/tool-contract.ts (REPLAY_SLUG) | `{slug}` | text contains `"slug"` when readable; `isError` otherwise |
| `get_backlinks` | nightly/tool-contract.ts (replayed), skillopt rollout registry | `{slug}` | refusal classification only |
| `traverse_graph` | nightly/tool-contract.ts (replayed), mcp-contract.ts | `{slug, depth, direction?}` | GraphPath rows `{from_slug,to_slug,depth}`; depth cap 10 |
| `list_pages` | mcp-contract.ts | `{limit}` | remote clamp at REMOTE_LIST_PAGES_CAP=100 |
| `remember` | refresh-barrier/runtime.ts (`remember`), strict-pageless/agent.ts, memory-trust/flag-rate.ts (`.call('remember'`), memory-trust/repro.ts | `{fact, entity, provenance, request_id}` or `{items:[...]}` | response `items[].page` or `page`; notice text `entity_page_missing` |
| `put_page` | refresh-barrier/runtime.ts (MCP path; put_blind goes via CLI `submitPageMutation`), memory-trust/flag-rate.ts, memory-trust/repro.ts | `{slug, content, force?, request_id}` | `retry_after_ms`, `write_request.state`, `code`, `retryable`/`class` |
| `get_write_request` | refresh-barrier/runtime.ts (poll), refresh-barrier/agent.ts | `{request_id}` | `state` in committed, conflict, failed, cancelled (pending otherwise) |
| `submit_answer` | refresh-barrier/agent.ts, strict-pageless/agent.ts, write-contract (predictive) | Anthropic tool input, not gbrain | not a gbrain tool; it is the eval's own tool |
| `get_chunks` | live-recall/task-arms.ts:202 (count chunk_index) | `{slug}` | count of `"chunk_index"` matches |
| `context_pack`, `recall` | memory-trust/repro.ts | per finding | per finding |
| `entity` | predictive/scale-latency/probe.ts (OPS), cat40 coverage probe | `{name}` | parsed by parseCoverage |
| `sync` | predictive/scale-latency/probe.ts (`call('sync'`) | n/a | n/a |

Tool names in tool-bridge.ts (EXPOSED_READ_TOOLS, line 41): search, query, get_page, list_pages, get_backlinks, get_links, get_timeline, get_tags, traverse_graph, resolve_slugs, get_chunks, get_stats. Dry-run tools (line 59): dry_run_put_page, dry_run_add_link, dry_run_add_timeline_entry. Mutating ops are rejected with ForbiddenOpError (line 73).

Live-recall TOOL_NAMES (task-arms.ts:33): query, search, get_page. GBRAIN_AGENT_TOOLS (systems/gbrain-agent.ts:49): same three. Server-side tool defs are generated by `buildToolDefs(chosen)` from `src/mcp/tool-defs.ts` and filtered: `expand`, `source_id`, `source_ids` are dropped (DROPPED_PARAMS in task-arms.ts, expand forced false for query).

### Request and response shapes asserted

- Dispatch context used everywhere in MCP-shaped calls: `{remote: true, transport: 'stdio', sourceId, admissionOrigin: 'interactive', takesHoldersAllowList: ['world'], surface: 'full'}` (systems/gbrain-agent.ts:226; refresh-barrier/runtime.ts:88; strict-pageless/agent.ts:95). Live-recall adds `metaHook`.
- CLI-path write context (refresh-barrier/runtime.ts:71): `{engine, sourceId, remote:false, dryRun:false, admissionOrigin:'interactive', config:{engine, embedding_disabled:true}}`, calling `s.g.pageMutations.submitPageMutation(ctx, {operation:'put_page', params})` in process.
- memory-trust/sut.ts uses `remote: true, transport: 'http'` and an auth object `{token:'', clientId, principal:{kind:'legacy_token'}, scopes:['read','write']}` but invokes `operationsByName[name].handler(ctx, {request_id, ...params})` in process, with no HTTP.
- Error envelope parsed (refresh-barrier/agent.ts:269-275): text starts with `Error: ` then a JSON object. classifyResult (runtime.ts:39-47) reads `code`, `retryable`, `class==='retryable'`, `retry_after_ms` (or `retry_after_ms=N` in `detail`), `write_request.state`.
- Refusal shape (nightly/tool-contract.ts:51): `{code?, message, suggestion?, fix?: {mcp?: {tool, arguments}}}`. A refusal whose `fix.mcp.arguments.request_id` names the same tool is replayed with the same request id (refresh-barrier/agent.ts:253-259).
- Live-recall access check (task-arms.ts:~120): when `caller.appliedAccessSummary` exists, every response must carry `_meta.access` with `member: null`, `groups: []`, `audience: null`, `relaxation: 'none'`; otherwise HarnessError.
- mcp-contract.ts assertions: traverse_graph depth=1000 frontier exactly 10 hops (checkDepthCap, line 194); depth=5 honored; remote default direction=both; list_pages limit=1M remote clamped to 100 (line 351-359); search with unknown `mode` rejected locally and ignored remotely (line 384-387); 10 MB query returns within 5 s (line 460-466); injection payloads not silently accepted (line 443-450).

### CLI commands and JSON fields parsed

Launch: every CLI call is `bun --no-env-file <build>/src/cli.ts <argv...>` via execFile or spawn, `shell:false`, with a hermetic env (GBRAIN_HOME set, no provider keys). Source: predictive/cli-arm.ts:102 (execGbrain), nightly/smokes/harness.ts:108, refresh-barrier/trial.ts:156, memory-trust/flag-rate.ts (runCli from lifecycle/drivers.ts, outside scope).

| CLI command | Caller | Output parsed |
|---|---|---|
| `init --pglite --path <dir> --embedding-model <m> --non-interactive` | memory-trust/flag-rate.ts:149 | exit code only |
| `init --pglite --non-interactive --content-root <dir> --git` | predictive/cli-arm.ts:144 | exit code |
| `put <slug> [--force] [--wait-ms N]` with markdown on stdin | predictive/cli-arm.ts:147; nightly/smokes/postgres-15.ts:112 | exit code; error text |
| `put <slug> --source-id <id> --expected-revision <rev>` | nightly/smokes/ingest-retry-across-upgrade.ts:41 | exit code |
| `sync [--source <id>] [--no-pull]` | predictive/cli-arm.ts:151; nightly/smokes/* | exit code; `sync status --source X --json` gives `last_error.code` (source-pinned-sync.ts:40) |
| `sync status --source <id> --json` | nightly/smokes/source-pinned-sync.ts:40 | `last_error?.code` |
| `get <slug> [--source <id>\|--source-id <id>] --json` | nightly/smokes/source-pinned-sync.ts:25, ingest-retry-across-upgrade.ts:95, upgrade-from-previous.ts:59 | JSON page |
| `search <q> --json` | nightly/smokes/source-pinned-sync.ts:44; upgrade-from-previous.ts:65 | JSON array with `slug` |
| `query <q> --limit N --json` | nightly/smokes/query-contract.ts:18 | JSON hits |
| `recall <slug> --json`, `recall --since <d> --limit N --json` | nightly/smokes/query-contract.ts:13; predictive/cli-arm.ts:193 | JSON |
| `list --limit N --offset M --json` | nightly/smokes/upgrade-from-previous.ts:87 | JSON array |
| `export --dir <dir>` | predictive/cli-arm.ts:183 | files on disk, then read as snapshot |
| `call <op> <json-args>` | predictive/run.ts:252 (`execGbrain(brain.gut, brain.env, ['call', op, JSON.stringify(args)])`); predictive/cli-arm.ts:272 | stdout+stderr text; error code from `Error [code]`, `"code":"..."`, or `"error":"..."` (predictive/write-contract.ts:71); exit code |
| `sources writer status --json` | nightly/smokes/upgrade-from-old.ts:56, 114 | JSON |
| `sources writer claim <src> --path <repo> --admin-intent writer_claim --expected-state <s>` | upgrade-from-old.ts:119 | exit code |
| `sources writer activate --confirm-quiesced [--dry-run] --json` | upgrade-from-old.ts:122-124 | JSON |
| `sources retry-held <src> --dry-run --json` | nightly/smokes/managed-sync.ts:44 | `items[].key`, `items[].code` |
| `sources set-path <src> <repo> --json` | nightly/smokes/source-pinned-sync.ts:32 | JSON |
| `sources add vault --path <p>` | cat40 (outside scope) | exit code |
| `config set <key> <value>` | nightly/smokes/managed-sync.ts:39 | exit code |
| `jobs work [--concurrency N]` | memory-trust/flag-rate.ts:182; nightly/smokes/ingest-retry-across-upgrade.ts:87 | exit code |
| `jobs get <id> --json`, `jobs list --limit N --json` | ingest-retry-across-upgrade.ts:89, 102 | JSON `status` fields |
| `trust review --json` | memory-trust/flag-rate.ts:185-187 | JSON after first `{` |
| `serve` (stdio) / `serve --http --port N` | see Server launch | GET /health 200 |
| `system-one` decide flags | system-one-jev.ts:301 via spawnSync | JSON `execution` block with `package`, `declared_pin`, `loaded_git_head`, `package_sha256` (system-one-jev.ts:213) |

### In-process imports used as an MCP/CLI substitute

These runners bypass the wire and import gbrain source directly. They are the parts an adapter must replace.

| Runner | Import (dynamic from build root) | Symbols and methods called |
|---|---|---|
| mcp-contract.ts | `gbrain/operations`, `gbrain/pglite-engine`, `gbrain/config` | `operations` (find by name, `op.handler(ctx, params)`); `PGLiteEngine` (`connect`, `initSchema`, `setConfig`, `putPage`, `addLink`, `disconnect`) |
| tool-bridge.ts | `gbrain/operations`, `gbrain/engine`, `gbrain/config` | `operations` (`buildToolDefs` maps `ParamDef`), `op.handler` |
| nightly/tool-contract.ts | `<root>/src/mcp/dispatch.ts`, `src/core/pglite-engine.ts`, `src/core/import-file.ts`, `src/core/ai/gateway.ts`, `src/core/skillopt/index.ts` | `dispatchToolCall(engine, tool, args, {remote, transport, sourceId})`; `PGLiteEngine` (`connect`, `initSchema`, `setConfig`); `importFromContent(engine, slug, content, {noEmbed})`; `configureGateway`; `runRollout` |
| refresh-barrier/runtime.ts, agent.ts | `<root>/src/core/config.ts`, `src/core/operation-manifest.generated.ts`, `src/mcp/surface.ts`, `src/mcp/server.ts`, `src/mcp/tool-defs.ts`, `src/mcp/validate-params.ts`, `src/mcp/instructions.ts`, `src/mcp/initialize-context.ts`, `src/core/facts/writeback-config.ts`, `src/core/facts/writeback-settings.ts`, `src/version.ts`, `src/mcp/dispatch.ts`, `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, `src/commands/sync.ts`, `src/core/cycle/extract-facts.ts`, `src/core/persistence/service.ts` | `dispatch.dispatchToolCall`; `pageMutations.submitPageMutation`; `buildToolDefs(listed, {strictParams})`; `resolveMcpInstructions`; `instructionReadiness(engine, cfg, 'stdio')`; `persistence service disposePersistenceConsumer`; `PGLiteEngine` and `PostgresEngine` (`connect`, `initSchema`, `disconnect`) |
| live-recall/task-arms.ts | `src/mcp/dispatch.ts`, `src/core/operations.ts`, `src/mcp/tool-defs.ts`, `src/mcp/server.ts`, `src/core/ai/invocation-guard.ts`, `src/core/search/hybrid.ts`, `src/core/search/private-visibility.ts`, `src/core/access/caller.ts` (optional) | `dispatchToolCall`; `buildToolDefs(chosen)`; `resolveMcpStdioSourceScope(engine)`; `withAIInvocationGuard(guard, run)` (allows only embedding and rerank kinds); `appliedAccessSummary` |
| live-recall/synthetic.ts, run.ts, brain.ts | `src/core/ai/gateway.ts`, `src/core/ai/build-gateway-config.ts`, `src/core/config.ts`, `src/core/engine-factory.ts`, `src/core/import-file.ts`, `src/core/pglite-engine.ts`, `src/core/search/eval-pool-depth.ts`, `src/core/search/sql-ranking.ts`, `src/core/fts-language.ts` | `configureGateway`; `importFromContent`; `PGLiteEngine`; `LATEST_VERSION` |
| memory-trust/sut.ts | `src/core/pglite-engine.ts`, `src/core/operations.ts` (`operationsByName`), `src/core/token-mint.ts` (`mintLegacyToken`), `src/core/persistence/identity.ts` (`registerLocalWriter`, `readLocalWriter`), `src/core/persistence/service.ts` (`disposePersistenceConsumer`), `src/core/ai/gateway.ts` (`configureGateway`, `resetGateway`), `src/core/import-file.ts` (`importFromContent`), `src/core/context/turn-context.ts` (`assembleTurnContext`), `src/core/trust/channel.ts` (optional) | `engine.executeRaw` (SQL on `persistence_brain`, `sources`, `information_schema`); `engine.setConfig`; `operationsByName[name].handler(ctx, {request_id, ...params})` for remote (`transport:'http'`) and local (`remote:false`) callers |
| memory-trust/flag-rate-score.ts | `<buildDir>` via `bun -e` | `src/core/write-gate.ts` (dynamic) |
| memory-trust/utility-guard.ts | `src/commands/eval-longmemeval.ts`, `src/core/ai/build-gateway-config.ts`, `src/core/ai/gateway.ts` | gbrain's own `eval longmemeval` command, with the recording stub reader |
| strict-pageless/agent.ts | `src/core/pglite-engine.ts`, `src/commands/sync.ts` (`performSync`), `src/core/cycle/extract-facts.ts` (`runExtractFacts`) | `dispatchToolCall`; `engine.executeRaw` on `pages`; `performSync`; `runExtractFacts` |
| predictive/out-of-view/reach.ts | `src/core/import-file.ts`, `src/core/pglite-engine.ts`, `src/mcp/dispatch.ts` | `importFromContent`; `dispatchToolCall` |
| predictive/scale-latency/build.ts | `src/core/ai/defaults.ts`, `src/core/ai/gateway.ts`, `src/core/engine-factory.ts`, `src/core/pglite-engine.ts` | configuration and engine construction |
| memory-qa/run-systems.ts, run.ts | `PGLiteEngine`, `hybridSearch`, `importFromContent`, `runThink`, `DEFAULT_RERANKER_MODEL` | `hybridSearch` with expansion off (systems/gbrain.ts header) |
| messy-company/load.ts | `gbrain/import-file` (`importFromContent`), `gbrain/pglite-engine` (`PGLiteEngine`) | `importFromContent(engine, slug, content, {noEmbed})` |
| skillopt-method/*.ts | `gbrain/core/skillopt` (`runRollout`, `scoreSkillPerTask`, `runSkillOpt`, `rolloutToolsForSkill`, `describeJudges`, `SKILLOPT_HOOK_BUDGET_EXHAUSTED`, `BenchmarkTask` type, `ScoreOnTasksOpts` type), `gbrain/ai/gateway` (`chat`, `toolLoop`, `configureGateway`, `__setChatTransportForTests`, `ChatOpts`, `ChatResult`), `gbrain/ai/invocation-guard` (`withAIInvocationGuard`), `gbrain/pglite-engine` (`PGLiteEngine`), `gbrain/operations` (`operations`), `gbrain/import-file` (`importFromContent`) | rollout, scoring and chat; `__setChatTransportForTests` is a stub seam |
| systems/gbrain-agent.ts | `../gbrain-under-test.ts` (`gbrainSpecFrom`, `importGbrain`, `resolveGbrainUnderTest`, `productIdentityFor`), `src/mcp/dispatch.ts` (`dispatchToolCall`), `src/mcp/server.ts` (`MCP_STDIO_MAX_MESSAGE_BYTES`), `src/core/operation-manifest` (OPERATION_MANIFEST) | `mcpToolArm('gbrain', {listTools, callTool}, GBRAIN_AGENT_TOOLS)` |
| systems/gbrain.ts | `gbrain/pglite-engine`, `gbrain/import-file`, `gbrain/search/hybrid` (per header) | `hybridSearch`, `importFromContent`, PGLite schema setup |

### Coupling classification (the runner's gbrain contact)

| Runner or file | Classification | Evidence |
|---|---|---|
| mcp-contract.ts | in-process | `import ... from 'gbrain/operations'`; `runOp` calls `op.handler(c, params)` (mcp-contract.ts:156-167) |
| tool-bridge.ts | in-process | `import ... from 'gbrain/operations'`; `op.handler(ctx, safeInput)` (tool-bridge.ts ~line 440) |
| nightly/tool-contract.ts | in-process (MCP-shaped) | dynamic import of `<root>/src/mcp/dispatch.ts`; `dispatchToolCall` with `{remote:true, transport:'stdio'}` |
| nightly/smokes/*.ts | CLI and HTTP (real process) | spawn `bun src/cli.ts`; `serve --http` plus GET /health |
| nightly/worker.ts, adapters.ts, bisect.ts | in-process plus spawn | worker imports `src/core/postgres-engine.ts`; adapters spawn `bun` (`spawn(o.cmd[0], ...)`, line 84) and cat40 runner commands |
| refresh-barrier | in-process plus child processes (no `gbrain serve`) | `dispatchToolCall`; `submitPageMutation`; `spawn('bun', [child.ts, ...])` (trial.ts:156). Comment at child.ts:3 says each agent's `gbrain serve` session is emulated as a resident process |
| live-recall | in-process MCP-shaped | `dispatchToolCall` on phase-1 engine (task-arms.ts:186) |
| memory-qa | in-process | PGLite, hybridSearch, importFromContent |
| memory-trust/flag-rate.ts | MCP (real wire) plus CLI | McpClient `serve --surface full` (flag-rate.ts:156); `runCli` for init, jobs work, `trust review --json` |
| memory-trust/sut.ts, repro.ts | in-process | `operationsByName[...].handler` |
| memory-trust/utility-guard.ts | in-process | `eval-longmemeval` import |
| messy-company | in-process (load only) | importFromContent; scorers none |
| miss-mining, outcomes, rs1, providers, sota scorers | none | pure data, scoring or transport; no gbrain import |
| predictive | CLI (real), MCP (real) plus in-process build | execGbrain (`bun src/cli.ts`, execFile); McpClient `serve`; `brain.gut` import |
| skillopt-method | in-process | gbrain/core/skillopt, gbrain/ai/gateway |
| strict-pageless | in-process MCP-shaped | dispatchToolCall (agent.ts:95) |
| system-one-jev.ts | CLI (real) | spawnSync `bun` argv (system-one-jev.ts:301) |
| systems/gbrain*.ts | in-process | gbrain.ts legacy adapter; gbrain-agent.ts (header line 13: "In process rather than a `gbrain serve` subprocess") |
| systems/http.ts | HTTP to a non-gbrain system | HttpMemorySystem; wire protocol in eval/systems/PROTOCOL.md (not read) |
| takes-bootstrap overlay | in-process (gbrain harness loaded from tree) | harness-overlay.mjs:54 `--gbrain-dir`, default `node_modules/gbrain` |

---

## Per-runner sections

### Adapter-relevant runners (MCP/CLI or in-process gbrain)

### eval/runner/mcp-contract.ts (BrainBench Category 12)
- Entry: eval/runner/mcp-contract.ts (main at line 492). Helpers: eval/runner/gbrain-version.ts, probe-accounting.ts.
- Measures: whether gbrain operation handlers enforce the trust boundary (local vs remote) and limits. Question: does a remote caller get tighter behaviour, and do caps and injection checks bite.
- Run: `bun eval/runner/mcp-contract.ts [--json]`. Output receipt via `receiptPath('mcp-contract')`.
- Cost and time: unknown; no network. Hermetic PGLite with about 150 pages (RING 10, CHAIN 16, NOTE 110).
- LLM keys: none. Keyless by construction (`search.mcp_keyword_only=true`, setup at line 100-110).
- Corpus: generated in-run (setupEngine).
- Metrics: pass/fail assertions (checkDepthCap, checkRemoteDirectionDefault, checkRemoteListClamp, checkListPagesTrustMatrix, checkModeDifferential) plus a handler sanity walk (`handlerSanityWalk`, line 485).
- gbrain imports: `gbrain/operations` (`operations`; `op.handler`), `gbrain/pglite-engine` (`PGLiteEngine`: `connect`, `initSchema`, `setConfig`, `putPage`, `addLink`, `disconnect`), `gbrain/config` (type). OperationContext fields: `engine, config, logger, dryRun, remote, sourceId`.
- Ops invoked: `traverse_graph`, `list_pages`, `search` (mode), `get_page`, `add_timeline_entry`.
- Coupling: in-process. For a different binary the runner would need a CLI JSON or MCP adapter: `call` each op over `gbrain serve` stdio with `remote` posture, then assert the same response shapes (GraphEdgeRow, list clamp 100, mode rejection on local only).
- Parity-gate fit: deterministic, keyless, fast. Strong candidate for a first MCP-based parity check.

### eval/runner/tool-bridge.ts (library)
- Entry: no CLI. Exports `buildToolDefs()` (line 198), `createToolBridge(config)` (line 378), `sanitizeToolInput`, `checkCitationFormat`, `ForbiddenOpError`, `UnknownToolError`.
- Measures: serves as the Cat 8/9 agent tool surface: read tools plus dry-run write intent recording.
- Behaviour: `executeTool` forces `remote:true` and `sourceId:'default'`; strips `expand` from `query` (sanitizeToolInput); truncates results to DEFAULT_MAX_CHARS (32768 * 4); scans for poison fixtures.
- Cost, keys, corpus: n/a (library).
- gbrain imports: `gbrain/operations` (`operations`, types `Operation`, `OperationContext`, `ParamDef`), `gbrain/engine` (type `BrainEngine`), `gbrain/config` (type `GBrainConfig`).
- Coupling: in-process. Reusable reference for which read tools a remote agent exposes (EXPOSED_READ_TOOLS, line 41) and the exact result envelope (`{content, truncated, matched_poison_fixture_ids}`).
- Parity-gate fit: deterministic; a library, not a runner.

### eval/runner/nightly/ (nightly check, `run.ts` plus helpers)
- Entry: eval/runner/nightly/run.ts. Usage at header lines 3-12. Helpers: tool-contract.ts, smokes/index.ts and smokes/*.ts (7 smokes), worker.ts, adapters.ts, bisect.ts, devset.ts, select-devset.ts, ledger.ts, outcome.ts, report.ts, write-score.ts, keyless.ts, judge-cache.ts, item-support.ts.
- Measures: pass rate per dev-set suite per gbrain ref; cost per correct answer; regressions vs previous night, with paired bootstrap; a bisect mode for regressions (bisect.ts).
- Run: `bun eval/runner/nightly/run.ts --ref master|stable|<sha> --tier nightly|matrix|smoke --out <dir> [--fake | --paid --budget-ledger <path> (--budget-run-id <id> | --night-cap-usd N --month-cap-usd N)] [--suites a,b] [--items x,y] [--gbrain-clone <path>]`. Resume: `--resume <night dir>`.
- Cost and time: `--fake` makes no paid call and refuses `--paid` (docs/nightly.md:246-251). Night caps via `--night-cap-usd` (run.ts:104). Wall time: unknown. Ubicloud VM bootstrap is in scripts/nightly-vm.sh (docs/nightly.md, header lines 1-6).
- LLM keys: model suites need `--paid`. The nightly tier uses `gpt-6.1-sol` alone (docs/nightly.md:59). Keyless suites use keylessEnv (nightly/keyless.ts): provider keys removed and base URLs pointed at a dead loopback port.
- Corpus: dev-set frozen (`devset.ts`), docs/benchmarks inputs exported by scripts/nightly-export.sh.
- Metrics: `report.ts` with thresholds (pass-rate drop of at least 5 points with paired bootstrap interval excluding zero, or cost per correct answer rise of 25 percent or more, docs/nightly.md:119-120).
- gbrain imports: `src/core/postgres-engine.ts` (worker.ts, dynamic); `gbrain/core/skillopt` `BenchmarkTask` type (tool-contract.ts:20); git on clone (`execFileSync('git', ['-C', clone, ...])`).
- Coupling: mixed. Smokes: CLI and `serve --http` (see tables). Adapters: spawn `bun` for cat40 runners (adapters.ts:84, 162). Worker: in-process gbrain agents with keyedFetch (keyless.ts header).
- Parity-gate fit: suites are mostly deterministic when `--fake`; model suites need keys and are not a parity gate. The keyless smokes and tool-contract are the most useful parity signals.

### eval/runner/nightly/tool-contract.ts (tool-contract replay)
- Entry: eval/runner/nightly/tool-contract.ts (usage at header lines 1-14): `bun eval/runner/nightly/tool-contract.ts --gbrain-root <dir> --out <file.json> [--families sol,opus] [--skills query,briefing,fact-check]`.
- Measures: whether gbrain refuses tool calls that real frontier models make, counted by family, path, tool and error code. Each replayed call keeps its recorded arguments; a refusal caused by the replay brain's content is an isContentMiss, counted as answered.
- Inputs: docs/benchmarks/2026-11-01-skillopt-method/probe/frontier (`PROBE_DIR`, line 36), 2 families (sol, opus) times 3 skills.
- Replay tools: get_page, get_backlinks, traverse_graph (REPLAY_SLUG line 46: `people/vera-chen-14`, `companies/ranger-22`; these are synthetic example slugs).
- Paths: rollout (SkillOpt registry, read-only), write-capture (SkillOpt registry), mcp (MCP dispatcher as remote stdio client). Source for the mcp path: `withMcp` (line ~100).
- Cost and time: keyless; wall time unknown.
- LLM keys: none (withHermeticEnv and keyless env).
- Metrics: refusal counts by family, path, tool, error code. `isContentMiss` for coverage_from, coverage_gap and "has no heading" refusals (line 26-27 region).
- gbrain imports: dynamic `src/core/ai/gateway.ts` (`configureGateway`), `src/core/pglite-engine.ts` (`PGLiteEngine`: `connect`, `initSchema`, `setConfig`), `src/core/import-file.ts` (`importFromContent(engine, slug, content, {noEmbed:true})`), `src/mcp/dispatch.ts` (`dispatchToolCall`), `src/core/skillopt/index.ts` (`runRollout` with `writeCapture` or `allowedTools`). Also `refresh-barrier/agent.ts` (`readResult`, `resultText`) and `skillopt-method/*` constants.
- Coupling: in-process (MCP-shaped). For a different binary, replace `withMcp` with a `gbrain serve` stdio client using tools/call with `{name, arguments}`, and parse `isError` plus the `Error: ` text envelope.
- Parity-gate fit: deterministic, keyless. Strong parity candidate on argument handling and refusal codes.

### eval/runner/nightly/smokes/ (system smokes)
- Entry: smokes/index.ts; 7 smokes: query-contract, source-pinned-sync, managed-sync, upgrade-from-previous, upgrade-from-old, ingest-retry-across-upgrade, postgres-15 (plus harness.ts, brain.ts).
- Measures: CLI and serve behaviours across upgrades and sync: JSON output contracts, writer claim and activate, held-sync retry, Postgres 15 concurrent writers.
- Run: via `nightly/run.ts` `system-smokes` suite, keyless.
- Cost: $0. Time: unknown (waits up to 600 s per sync in code).
- Keys: none (`assertKeyless` in harness.ts:106, 171).
- Corpus: seeded synthetic brain (brain.ts).
- gbrain imports: none directly; the harness spawns `bun --no-env-file <root>/src/cli.ts`.
- CLI JSON fields read: see the CLI table (sync status `last_error.code`, `items[].key/code`, search `slug`, `sources writer status --json`, `jobs get --json`).
- HTTP: `serve --http --port N` ready on GET /health 200 (harness.ts:170-193); the ingest-retry smoke also drives `gbrain serve --http` with an OAuth client_credentials client (ingest-retry-across-upgrade.ts header line 4).
- Coupling: CLI (real) and HTTP (real). Most directly reusable as a parity adapter because it already drives CLI JSON.
- Parity-gate fit: deterministic, keyless, moderate speed.

### eval/runner/refresh-barrier/ (refresh write barrier)
- Entry: eval/runner/refresh-barrier/run.ts (usage at header lines 1-12). Helpers: trial.ts (in-process PGLite trial and child spawn), child.ts (Postgres child), agent.ts (agent arm, catalog capture, paid runs), runtime.ts (write/poll client), schedule.ts (B_KINDS), named-case.ts, verify.ts, retrieval.ts, analyze.ts, rescore.ts, ledger.ts, ledger-preload.ts, adjudicate.ts, fixture.ts, plus repo-root scripts (refresh-barrier-b1-guard.ts, refresh-barrier-partc-adjudicate.ts).
- Measures: whether concurrent writers and refresh ticks land writes correctly under a refresh barrier, with latency. Agent block measures whether a model's writes land and its report is truthful.
- Run: `bun eval/runner/refresh-barrier/run.ts --block trials|named|quiet --engine postgres|pglite --gbrain-root <G> --out <dir> [--seeds 1001-1500] [--arms off,on] [--concurrency 6]` (quiet uses concurrency 2).
- Cost: agent arms capped (agent.ts:72-76): `anthropic:claude-opus-5-5` $65, `openai:gpt-6.1-sol` $35, smoke $5. Trials and named cases are keyless (`keylessEnv`).
- Time: unknown.
- LLM keys: Anthropic and OpenAI for the agent block (fixture.ts PROVIDER_KEYS; keyedFetch in agent.ts).
- Corpus: synthetic git fixture (fixture.ts: bare remote plus managed clone, two sources alpha and beta, eight people-example pages and eight notes each), generated per trial.
- Metrics: refused, retry and landing counts; `classifyWrite` (agent.ts:240); analysis in analyze.ts; preregistration docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md.
- gbrain imports: `src/core/pglite-engine.ts` (`PGLiteEngine`: `connect`, `initSchema`, `disconnect`), `src/core/postgres-engine.ts` (`PostgresEngine`: `connect({database_url, poolSize})`), `src/core/persistence/service.ts` (`disposePersistenceConsumer`), `src/mcp/dispatch.ts` (`dispatchToolCall`), `pageMutations.submitPageMutation` (runtime.ts:72), `src/core/persistence/switches.ts` (`readWriteSwitches`, `viewedEngine`), MCP surface modules (agent.ts:175-178).
- MCP calls in the runtime: `remember`, `put_page` (MCP surface), `get_page`, `get_write_request`, and `submit_answer` (agent only). `put_blind` uses the CLI-path `submitPageMutation`.
- Coupling: in-process MCP-shaped (dispatchToolCall, not wire), CLI-shaped write (submitPageMutation in process), and child processes (`spawn('bun', ['--no-env-file', child.ts ...])`, trial.ts:156).
- Parity-gate fit: trials and named cases are deterministic and keyless but heavy (multi-process Postgres). Agent block needs keys.

### eval/runner/live-recall/ (live recall phase 1 and 2)
- Entry: eval/runner/live-recall/run.ts (usage at header lines 1-12, subcommands `run`, `freeze`). Helpers: task-arms.ts (four arms A/B/C/D), tasks.ts, brain.ts (phase 1 guarded engine), synthetic.ts (Voyage pricing and estimate), scorecard.ts, task-scorecard.ts, task-judge.ts, redact-scorecard.ts, visibility-epoch.ts, paraphrase-opus.ts, snapshot.sh.
- Measures: recall@k and retrieval-ablation over private questions; arms: A no retrieval, B gbrain query/search/get_page, C summariser loop, D hybridSearch plus get_page.
- Run: `bun eval/runner/live-recall/run.ts run --fixture`; `run --synthetic <dir> [--protocol batch3] [--paid --budget-run-id <id>]`; `freeze --questions <private.jsonl> --out <freeze.json> [--protocol batch1..batch4] [--gbrain <checkout>@<commit>]`.
- Cost: paid synthetic run uses Voyage (embedding, rerank); cost estimate `estimateVoyageUsd` (synthetic.ts, called at run.ts:755), recorded in paid-receipt.json. Amount not in headers; unknown here.
- Time: unknown.
- LLM keys: Voyage (synthetic paid run); reader and judge models through Cat 40 loop (medium effort).
- Corpus: private live-recall questions on the brain's box, not committed; synthetic dirs from eval/generators/conditions-recall-gen.ts or batch3-synthetic-gen.ts.
- Metrics: recall@k, per-query-type ablations; judge verdict via task-judge.ts; scorecard redacted (redact-scorecard.ts).
- gbrain imports: `src/mcp/dispatch.ts`, `src/core/operations.ts`, `src/mcp/tool-defs.ts`, `src/mcp/server.ts` (`resolveMcpStdioSourceScope`), `src/core/ai/invocation-guard.ts` (`withAIInvocationGuard`), `src/core/search/hybrid.ts`, `src/core/search/private-visibility.ts`, `src/core/access/caller.ts` (optional), `src/core/ai/gateway.ts`, `src/core/import-file.ts`, `src/core/pglite-engine.ts`, `src/core/config.ts`, `src/core/engine-factory.ts`, `src/core/search/sql-ranking.ts`, `src/core/search/eval-pool-depth.ts`, `src/core/fts-language.ts`.
- Coupling: in-process MCP-shaped (dispatchToolCall with `remote:true, transport:'stdio'`, `metaHook`). The `_meta.access` and `_meta.retrieval` fields are a contract an adapter must reproduce.
- Parity-gate fit: needs Voyage for the paid run; the arm logic is deterministic with a stubbed embed (live-recall `--fixture`). Partial fit.

### eval/runner/memory-trust/ (trust categories and flag-rate)
- Entry points: flag-rate.ts (amendment 5, the LongMemEval user simulation, usage in header lines 1-30 and main at line 218), repro.ts (finding repros, `--gbrain <checkout>@<ref> <finding>`), utility-guard.ts (LongMemEval utility; `capture`, `submit`, `judge`, `poll`, `summary`), sut.ts (shared hermetic brain for Cat 37/38/39), agent.ts (remote agent loop), flag-rate-score.ts, join-cat37.ts, models.ts, user-preferences.ts.
- Measures: flag-rate (how often the gate flags ordinary use, review items per user); repro (does a known finding still reproduce); utility (LongMemEval recall and answers vs published W10 rows).
- Run: `bun eval/runner/memory-trust/flag-rate.ts --out <dir> [--users 16] [--control-users 4] [--inject 5] [--smoke] [--keyless] [--no-agent] [--max-sessions N] [--concurrency 4] [--user-allowance-usd 2]`. Repro keyless.
- Cost: flag-rate uses `startPaidRun('memory-trust-flag-rate', ...)` with estimate; `--keyless` on smoke skips the ledger (flag-rate.ts:252). Per-user allowance default $2 (line 255). Time: unknown.
- LLM keys: agent model (Anthropic/OpenAI via McpClient-driven agent); judge for flags; utility-guard uses reader and judge keys (official gpt-4o-2024-08-06 judge batch per header).
- Corpus: LongMemEval-S haystacks (`--lme`, default DEFAULT_LME), injected marker lines (`marker-inj-N`).
- Metrics: flag rate; review queue counts from `trust review --json`; repro exit code 1 means finding still reproduces; utility recall_all@5 and McNemar vs published W10.
- gbrain imports: sut.ts (see table); flag-rate-score.ts `src/core/write-gate.ts` via `bun -e`; utility-guard.ts `src/commands/eval-longmemeval.ts` plus `src/core/ai/gateway.ts`, `src/core/ai/build-gateway-config.ts`.
- Coupling: flag-rate uses the real MCP wire (McpClient `serve --surface full`, tools `remember` and `put_page`) plus CLI (`init`, `jobs work`, `trust review --json`). sut.ts and repro.ts are in-process `operationsByName` handlers. utility-guard runs gbrain's own `eval longmemeval` command in process through a copied overlay.
- Parity-gate fit: sut and repro are deterministic and keyless (strong fit). flag-rate needs keys unless `--keyless --smoke`.

### eval/runner/predictive/ (agent stack, CLI and MCP surfaces)
- Entry: run.ts (`runGrammar` at line 240, `main` at 266), README.md (Modes, Paid runs). Helpers: cli-arm.ts (SyntheticBrain, execGbrain, GbrainCliArm, GbrainMcpArm, validateArgv), write-contract.ts (classifyCall, schemaShapes, runSchemaGrammar), episodes.ts (CLI and MCP episode shapes), causes.ts, passk.ts, verdict.ts, validity.ts, freshness.ts, mapping.ts, paid.ts, entity-agent.ts, export-references.ts, out-of-view/ (agent.ts, run.ts, tasks.ts, gen.ts, reach.ts, README.md), scale-latency/ (build.ts, probe.ts, ubicloud.ts, vm-setup.sh, README.md), ubicloud/ (setup.sh, run.sh, vm-run.sh).
- Measures: agent behaviour on the CLI and MCP surfaces: write landing (G3), refusal causes, reach (out-of-view), latency (scale-latency), pass^k and cost per correct answer.
- Run: `bun eval/runner/predictive/run.ts` (flags in code; see predictive/README.md Modes). Scale-latency through `ubicloud/run.sh`. Out-of-view `run.ts` with `gbrain serve --access read-only`.
- Cost and time: paid episodes gated by paid.ts; time unknown. The README gives modes but no figures here.
- LLM keys: Anthropic and OpenAI for the model side (cat40 toolLoop); `--model fake` style paths keyless (grammar is keyless).
- Corpus: synthetic brain built per run (SyntheticBrain: content root under GBRAIN_HOME, git-backed); GRAMMAR_PAGES; out-of-view generated (gen.ts).
- Metrics: passk.ts (pass^k), causes.ts, validity.ts; write-contract classifyCall reads `Error [code]`, `"code"`, `"error"` and detail `pending_import`, `file_database_drift` (write-contract.ts:33-71).
- gbrain surfaces: CLI `init --pglite --non-interactive --content-root <dir> --git`, `put <slug>` (markdown on stdin), `sync`, `export --dir`, `recall --since 2000-01-01 --limit 1000 --json`, `get`, `search`, `call <op> <json>`. MCP: `gbrain serve` stdio via McpClient; tools `get_page`, `remember`, `query` (per episode shapes).
- gbrain imports: `gbrain/config`, `src/core/ai/defaults.ts`, `src/core/ai/gateway.ts`, `src/core/engine-factory.ts`, `src/core/pglite-engine.ts`, `src/core/import-file.ts`, `src/mcp/dispatch.ts` (out-of-view reach).
- Coupling: CLI (real, execFile `bun src/cli.ts`) and MCP (real, `serve` stdio) and in-process brain build. This is the closest existing model for a multi-surface adapter: one `gbrain` tool taking an argv array (cli-arm.ts:29, GBRAIN_CLI_TOOL) and the same schema through `tools/list`.
- Parity-gate fit: keyless grammar (`runSchemaGrammar`, `schemaShapes`) is deterministic and cheap; episodes need keys.

### eval/runner/strict-pageless/ (GBRA-449 cell)
- Entry: eval/runner/strict-pageless/agent.ts (usage at header lines 13-20; main at line 300). Helpers: items.ts (item ids and keys), analyze.ts, report.ts (scoreReport, Truth).
- Measures: on a Git-canonical source, does a fact remembered for an entity with no page survive rebuild from Git, and is the reply truthful.
- Run: `bun eval/runner/strict-pageless/agent.ts --model <provider:id>|fake --gbrain-root <checkout> --items 1-24 --k 1 --out <dir> [--budget-ledger <path> --program-cap-usd N --budget-usd N] [--pilot]`.
- Cost and time: paid run via `startPaidRun` (agent.ts:317, estimateUsd null). Time unknown.
- LLM keys: model provider key when not `fake`.
- Corpus: fresh PGLite brain built by refresh-barrier fixture (`openBrain`, trial.ts), eight people pages and eight notes per source.
- Metrics: kept_in_git (active fact row with token whose entity slug names the item), truthful (report.ts scoreReport), exposure (remember call carrying token with entity having no page; `entity_page_before` from SQL on `pages`).
- MCP calls: `remember` (`items` array or single entity), `put_page`, `get_page`, `submit_answer` (eval tool). Tool list from `captureCatalog` (refresh-barrier/agent.ts), with server instructions shown in system hint (strict-pageless/agent.ts:74).
- gbrain imports: `src/core/pglite-engine.ts`, `src/commands/sync.ts` (`performSync`), `src/core/cycle/extract-facts.ts` (`runExtractFacts`), plus `dispatchToolCall` via the opened `g.dispatch`.
- Coupling: MCP-shaped in process (`remote:true, transport:'stdio', sourceId: alpha`). Response envelope read with `readResult` and `resultText`.
- Parity-gate fit: `--model fake` deterministic; uses the same fixture as refresh-barrier.

### eval/runner/system-one/ and system-one-jev.ts
- Entry: system-one-jev.ts (usage header; `verify` and `plan` in package.json at eval:system-one, eval:system-one:plan). Helpers: system-one/slots.ts (nine slot definitions, `--decide` modes), datasets.ts, recount.ts.
- Measures: each of gbrain's nine System One slots (S1 rerank, S2 route, S3 prune, S4 answerable, S5 prompt-injection flag, S6 needs-memory, S7 dream triage, S8 claim support, S9 contradiction) as a matched pair on the same commit.
- Run: `bun eval/runner/system-one-jev.ts verify` (package.json eval:system-one) or `plan` (eval:system-one:plan, prints all commands).
- Cost and time: paid through TypeSafe Jev (`typesafe:jev-1.13.0`); unknown amount.
- LLM keys: TypeSafe Jev key (not in the grep list; check system-one-jev.ts env allowlist).
- Coupling: CLI. `spawnSync('bun', argv, {cwd, env})` (system-one-jev.ts:301). The execution block reads `product.package`, `declared_pin`, `loaded_git_head`, `package_sha256`, `version` (system-one-jev.ts:213).
- Parity-gate fit: `plan` is deterministic and keyless; `run` is paid.

### eval/runner/systems/ (adapter layer)
- Entry: no runner. Consumed by memory-qa and the shootout driver. Files: types.ts (`MemorySystem` contract, sanitized inputs), gbrain.ts (GbrainLegacySystem, GbrainShootoutSystem, in process), gbrain-agent.ts (GbrainAgentSystem, in process), gbrain-query/ (connector.ts, system.ts, README.md), mcp-tools.ts (neutral MCP tool adapter), http.ts (HttpMemorySystem, HTTP to a non-gbrain stack, `POST /answer` optional), file-agent.ts (rg, not gbrain), agent-runtime.ts (docker, not gbrain), baselines.ts (extract-first, memory-bank, pgvector), fake.ts, render.ts and render-v2.ts, sanitize.ts.
- mcp-tools.ts: the neutral MCP adapter. Types `McpTool {name, description?, inputSchema}`, `McpToolResult {content: [{type, text?}], isError?}`, `McpToolServer {listTools(), callTool(name, args)}`. `mcpToolArm(name, server, allowed)` refuses to build when a named tool is absent and refuses calls outside `allowed`. Result text is the text blocks joined by newline; `isError` is thrown. This is the shape an adapter for a Rust gbrain MCP server should match.
- gbrain-agent.ts: `GBRAIN_AGENT_TOOLS = ['query','search','get_page']`; `tools/list` = `buildToolDefs` over the build's OPERATION_MANIFEST; `tools/call` = `dispatchToolCall(engine, name, args, dispatch)` with `transport:'stdio'`, `inboundFrameBytes: MCP_STDIO_MAX_MESSAGE_BYTES`, `takesHoldersAllowList:['world']`, `sourceId:'default'`, `surface:'full'` (line 226). Runs in process so gbrain's provider calls pass the paid-request guard (header lines 13-14).
- gbrain-query connector: `wireRequest(name, query, {limit, budget})` (connector.ts:50), `assembleRequest(hits, unit, budget, packing)` (line 69), `QUERY_PATH_PINS` (line 28), `AUTO_PACKINGS` (off, cap_only, breadth_capped, depth_first; line 74), `search.auto_packing` config key (line 76), `deliveryRecord`, `parity(live, assembled)` (line 245). Its `loadConnectorModules(load)` dynamically imports gbrain modules through a loader. This is the closest existing code to a request-shape spec for query delivery.
- http.ts: a generic HTTP client for an external memory system (`HttpMemorySystem`), not gbrain. Its wire protocol is in eval/systems/PROTOCOL.md (not read).
- Coupling: gbrain.ts and gbrain-agent.ts in-process; mcp-tools.ts neutral; http.ts HTTP to a non-gbrain system.
- Parity-gate fit: in-process paths are deterministic; the neutral MCP adapter is the natural seam for a binary-based parity run.

### eval/runner/takes-bootstrap/
- Entry: harness-overlay.mjs (overlay of gbrain's evals/takes-bootstrap/harness.mjs at gbrain c5fb0201, v0.60.95.0) and harness-overlay.diff.
- Measures: the takes-bootstrap harness, with pricing overrides, a summary JSON (model, estimate, ceiling, hard cap, spend, prices used, per-case classifier errors, wall time) and a request log.
- Run: `bun eval/runner/takes-bootstrap/harness-overlay.mjs --gbrain-dir <tree> [--price-input N --price-output N] [--summary <path>] [--request-log <path>] --model <m>` (flags from header lines 1-15).
- Cost: spend estimate and hard cap via BudgetTracker; provider key needed for the model under test.
- Coupling: in-process by loading the gbrain harness, corpus, scorer and `src/` tree from `--gbrain-dir` (line 54; default `node_modules/gbrain`). Detail beyond the header was not read.
- Parity-gate fit: paid; not a parity gate as is.

### Non-adapter runners (in scope, no gbrain contact or only indirect)

### eval/runner/memory-qa/ (benchmark arm runner)
- Entry: run.ts (usage header lines 1-14), run-systems.ts (dispatched for memory-system flags). Helpers: corpus.ts, qa.ts, qa-v2.ts, instruments.ts, arms.ts, records.ts, outcomes.ts, sealed-profile.ts, bg1-names.ts, beam10m-corpus.ts, beam10m-questions.ts.
- Measures: LoCoMo, LongMemEval-S, BEAM accuracy per gbrain build (and per memory system via run-systems).
- Run: `bun eval/runner/memory-qa/run.ts --benchmark locomo|lme-s|beam-100k|beam-1m|fixture [--split dev] [--embed hash|real] [--qa reader|think] [--paid --budget-run-id <id>]`. Sealed split needs a custodian decision id.
- Cost: paid estimate computed in code (run.ts:572, `Math.max(0.05, ...)`); per-question and per-QA constants. Not published in headers; unknown.
- LLM keys: `--embed real` needs embedding provider; `--qa reader|think` needs QA model keys (ChatClient, run.ts:575). `--qa none` keyless. `--embed hash` keyless.
- Corpus: benchmark datasets under eval/data (LoCoMo, LME-S, BEAM); generated in part (beam10m-corpus.ts).
- Metrics: accuracy per category, judge via instruments.ts; receipts with cost and fidelity fields.
- gbrain imports: `PGLiteEngine`, `hybridSearch` (expansion off), `importFromContent`, `runThink`, `DEFAULT_RERANKER_MODEL` (run.ts, run-systems.ts). Coupling: in-process.
- Parity-gate fit: `--embed hash --qa none` deterministic and keyless.

### eval/runner/messy-company/
- Entry: load.ts (usage header lines 1-12), score-ownership.ts, score-timeline.ts, score-agent-tasks.ts, score-document-status.ts, score-entity-mentions.ts, score-changes.ts, score-aliases.ts, score-owner-phrases.ts, score-governing-records.ts, common.ts (Wilson intervals, normalization).
- Measures: messy-company-v1 lanes: ownership windows (owner-on-date accuracy, acting-cover, exact-window recall/precision), timeline, aliases, document status, entity mentions, governing records, agent tasks.
- Run: `bun eval/runner/messy-company/load.ts --split dev|heldout|all [--db <dir>] [--public-only] [--json]` then the score-*.ts scorers on a system's output JSON (shape in each header and eval/data/messy-company-v1/SCORING.md).
- Cost: $0; keyless (importFromContent with noEmbed). Time: seconds.
- Corpus: eval/data/messy-company-v1/corpus/<split> (committed Markdown pages), labels/ (gold).
- Metrics: counts with 95 percent Wilson intervals (common.ts).
- gbrain imports: `gbrain/import-file` (`importFromContent`), `gbrain/pglite-engine` (`PGLiteEngine`) in load.ts only.
- Coupling: in-process (load) and none (scorers). Parity-gate fit: deterministic and keyless.

### eval/runner/miss-mining/
- Entry: weekly-counts.ts (usage header), to-live-recall.ts, schema.ts, custody.ts.
- Measures: weekly counts of private misses by cause x ask kind x detection mode; conversion of logged misses into live-recall questions.
- Run: `bun eval/runner/miss-mining/weekly-counts.ts --log <miss-log.jsonl> --week <YYYY-MM-DD> --out <weekly.json>`; `to-live-recall.ts --log <log> --out <questions.jsonl>`.
- Cost $0; keyless. Corpus: private log on the box; output passes custody.ts.
- gbrain imports: none. Coupling: none.

### eval/runner/outcomes/
- Entry: v3.ts (outcome-v3 instrument, header: versioned answer outcomes, replaces no historical scorer), rescore-a4.ts (`$0` rescoring of A4 receipts), validate-labeler.ts (labeler validation, paid).
- Measures: outcome labels (abstain, hedge, commit) and a judged commitment/hedge labeler validated against GBRA-49 hand labels. Preregistered rule: first model with precision >= 0.90 on both `hedged` and `abstain` is selected; ladder gpt-6-luna, claude-haiku-5-5, claude-sonnet-5-5.
- Run: `bun eval/runner/outcomes/rescore-a4.ts <receipt.json>...` ($0); `validate-labeler.ts --labels-dir <dir> --stage select|confirm --paid --budget-run-id <id> --budget-ledger <path>`.
- Cost: rescore $0; labeler paid (amount unknown).
- LLM keys: labeler ladder keys (Anthropic, OpenAI).
- Corpus: A4 receipts (committed) and hand-labelled answers (custodian folder).
- gbrain imports: none. Coupling: none.

### eval/runner/providers/openai-compatible.ts
- Entry: module only (no CLI). Pieces: `compatRequest`, `compatSend` (sends once, never retries), `parseCompatResponse`, `classifyCompatError`, `compatError`. Providers: Particle AI (`https://api.particle.ai/v1`, US endpoint `https://us.api.particle.ai/v1`) in COMPAT_PROVIDERS; Google Gemini OpenAI-compatible endpoint as judge-only.
- Measures: transport facts only. Checked against provider docs on 2026-10-31 (header).
- Keys: Particle and Gemini keys at call time. Coupling: none (no gbrain). Parity-gate fit: n/a.

### eval/runner/rs1/
- Entry: verdict.ts (`verdict` and `pilot` subcommands, header lines 1-10), iut.ts (estimand and decision rule, the single source the power simulation and verdict both call), power.ts, pricing.ts, paid-window.ts (guard CLI: `check --paid-window <unit> --window-cap-usd N --budget-ledger <file> --budget-run-id <id>`, exit 2 on refusal).
- Measures: RS1 pre-registered comparison of gbrain against memory-bank and extract-first servers, paired by conversation, with a one-sided 95 percent t lower bound on n minus 1 df (iut.ts header).
- Run: `bun eval/runner/rs1/verdict.ts verdict --receipts <dir>... [--manifest <file>] [--set RS1|RS1-dev2] [--out <dir>]`.
- Cost: analysis $0. pricing.ts estimates spend from `--n`, `--spent-usd`, `--gbrain-api-per-mtok`.
- Keys: none direct (receipts come from cell.ts, outside scope).
- gbrain imports: none. Coupling: none.
- Parity-gate fit: deterministic analysis; not a gbrain parity gate.

### eval/runner/skillopt-method/
- Entry points: headroom.ts (A1 headroom probe; frontier targets `opus` = claude-opus-5-5, `sol` = gpt-6.1-sol), one-shot.ts (harness one-shot arm, runs seed on 24 train tasks), score.ts / score-v3.ts (scoring), gate.ts, rollouts.ts (toolLoop and runRollout), tool-calls.ts (rollout tool-call accounting), test-stage.ts (test split reader), ceiling-stages.ts, dataset.ts and dataset-context.ts (skillopt-method-v2/v3 dataset), kept-rewrites.ts, audit.ts, contract.ts (output contracts per skill).
- Measures: whether gbrain's shipped skills (query, briefing, fact-check) leave headroom for an optimizer; one-shot rewrite; gate decision on kept rewrites.
- Run: headroom and one-shot via their file usage text (not read in full). Frontier probe is paid.
- Cost: paid frontier probe; amounts not read here.
- LLM keys: Anthropic (claude-opus-5-5) and OpenAI (gpt-6.1-sol) for the frontier probe. A test seam exists: `__setChatTransportForTests` (headroom.ts import) for offline stubs.
- Corpus: skillopt-method dataset (docs/benchmarks/2026-11-01-skillopt-method/...), skills from gbrain's skills tree.
- gbrain imports: see table (gbrain/core/skillopt, gbrain/ai/gateway, gbrain/ai/invocation-guard, gbrain/pglite-engine, gbrain/operations, gbrain/import-file, gbrain/core/skillopt describeJudges).
- Coupling: in-process. Parity-gate fit: the rollout and scoring path is in process; no CLI or MCP seam.

### eval/runner/sota/
- Entry: leader.ts (plan and import subcommands), oracle.ts (plan, import-a4, run), scorecard.ts (monthly scorecard), answerability.ts, fixlist.ts, ledger.ts, cache.ts, custody.ts, sealed-guard.ts, lme-support.ts, scorecard.ts; ubicloud/ (setup.sh, run.sh, vm-run.sh).
- Measures: monthly gbrain minus leader (whole-history reader on LongMemEval, grep file agent on BEAM-1M) on dev and sealed questions, with conversation-clustered 95 percent interval, in points; status ahead, behind, parity (inside ±3.5 points).
- Run: `bun eval/runner/sota/leader.ts plan --cache <dir>`; `leader.ts import --from <q1 out dir> --cell <id> --cache <dir>`; `oracle.ts run --benchmark beam-1m|lme-s --reader <provider:model> --items <ids.txt> --cache <dir>`; `scorecard.ts --rows <rows.json> [--previous <file>] --takeaways <file> --out <file outside repo>`.
- Cost and time: runs go through q1 cells (outside scope); unknown.
- LLM keys: readers claude-opus-5-5, gpt-6.1-sol, particle-1; judges gpt-6-astra (Claude rows) and claude-opus-5-5 (GPT and particle rows) per oracle.ts header.
- Corpus: BEAM-1M and LongMemEval-S outcome cache.
- gbrain imports: none directly in scoped files; memory-qa reader indirectly via q1 cells (outside scope).
- Coupling: none for scorecard, ledger, cache, custody; indirect in-process via q1 for leader and oracle.
- Parity-gate fit: scorecard deterministic; oracle and leader paid.

### eval/runner/nightly and eval/runner/mcp-contract.ts also feed docs
- docs/nightly.md describes the nightly tiers (`concurrent-writers`, `system-smokes`, `tool-contract-replay`, dev-set suites), `--fake`, `--paid`, and the Ubicloud VM (scripts/nightly-vm.sh, scripts/nightly-export.sh).

---

## Cross-cutting observations

1. Two protocols exist in this scope, and only one is a real wire. The real MCP wire is McpClient (cat40/gbrain-arm.ts, outside scope) spawning `bun <build>/src/cli.ts serve`. Everything else called "MCP" calls `dispatchToolCall` in process. A Rust adapter can match the `tools/call` result envelope `{content:[{type:'text',text}], isError}` but must still speak JSON-RPC over stdio to be tested as a real server.
2. The CLI is driven through `bun --no-env-file <build>/src/cli.ts <argv>` in every case. No runner calls an installed `gbrain` binary directly, except via the shim written by nightly/smokes/harness.ts:149. That makes the entry point swappable: replace `<build>/src/cli.ts` with a binary path.
3. JSON output is parsed in several places with inconsistent tolerance. flag-rate.ts:187 slices from the first `{`; predictive/write-contract.ts:71 regex-matches error codes from text (`Error [code]`, `"code":`, `"error":`). A CLI JSON contract would need to replace these regexes.
4. Error classification depends on text. refresh-barrier/agent.ts:269-275 parses `Error: ` plus a JSON body; refresh-barrier/runtime.ts:41 regex-matches `retry_after_ms=N` from `detail`. A Rust adapter must keep `code`, `retryable` or `class`, `retry_after_ms`, `write_request.state` as structured fields.
5. Shared helpers across runners: refresh-barrier/agent.ts is imported by nightly/tool-contract.ts (readResult, resultText), strict-pageless/agent.ts (captureCatalog, keyedFetch, readResult, resultText, writeToolsOf), and skillopt via refresh-barrier/fixture.ts (gitHead). refresh-barrier/trial.ts (openBrain, quiesce) is shared by strict-pageless. Treat refresh-barrier as a library layer for the agent/MCP surface.
6. Keyless enforcement is structural: keylessEnv (nightly/keyless.ts), assertKeyless (nightly/smokes/harness.ts:106), enterHermeticEnv (hermetic-env.ts), and `--fake` modes. Any adapter must run under a stripped env with provider base URLs on a dead port.
7. Two different gbrain loaders exist: the npm pin `node_modules/gbrain` (package exports such as `gbrain/operations`) and a build root path (dynamic `import(join(root, 'src/...'))`) via gbrain-under-test.ts (`importGbrain`, overlay with `git archive` into `.gbrain-overlays/`). Most MCP-shaped runners need the source tree, not the package exports.
8. The `mcp-contract.ts` header says "Category 12" and points out assertion design: many checks were rewritten after audit (the header notes that pre-fix checks could not fail). Those are the assertions an adapter must reproduce to claim parity.
9. Surprises: refresh-barrier and strict-pageless call `put_blind` through the CLI write path (`submitPageMutation`) and not through MCP, so a write-path adapter must support both. memory-trust/sut.ts builds `transport:'http'` contexts but never opens HTTP.
10. Not verified: the full contents of many files (nightly/report.ts, live-recall/tasks.ts, memory-qa/corpus.ts, sota/*), exact costs in several headers, and the cat40/loop.ts and lifecycle/drivers.ts helpers that the scope calls. The "unknown" entries in the table mark these.

Summary (5 lines)
1. Real MCP wire exists only via McpClient (cat40/gbrain-arm.ts) spawning `bun <build>/src/cli.ts serve --surface <s>` over newline JSON-RPC stdio (2025-06-18); used by flag-rate, predictive, out-of-view.
2. Other MCP-shaped calls are in-process `dispatchToolCall` (src/mcp/dispatch.ts) with `{remote:true, transport:'stdio'}`: live-recall, refresh-barrier, strict-pageless, nightly tool-contract, systems/gbrain-agent.
3. CLI runners spawn `bun --no-env-file <build>/src/cli.ts <argv>` and parse JSON from `--json` for get/search/query/recall/list/jobs/sources/sync status/trust review; predictive also uses `call <op> <json>`.
4. Keyless and deterministic candidates for a parity gate: mcp-contract.ts, tool-bridge.ts, memory-trust/repro.ts and sut.ts, nightly/tool-contract.ts, nightly/smokes, messy-company load, predictive schema grammar.
5. Costs are capped in code only for refresh-barrier agent arms ($65 opus, $35 sol, $5 smoke); other paid runs estimate in code or are unknown. No runner uses a published gbrain binary.
