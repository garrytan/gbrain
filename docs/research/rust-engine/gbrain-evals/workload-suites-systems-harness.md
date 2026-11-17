> Appendix to [../gbrain-evals.md](../gbrain-evals.md). Detailed per-area notes from one research pass over gbrain-evals `cd447b3` (v0.10.237) and gbrain `6ce7195`. Paths are relative to the gbrain-evals root unless marked `gbrain:`. "G1" to "G10" in the text name the appendix files listed in the main map.

# G7: workload suites, memory systems, harness, shootout, generators

Checkout: the gbrain-evals checkout (HEAD cd447b3, Release v0.10.237). All paths are relative to that root unless absolute.
gbrain pins seen here: package.json and docs/gbrain-under-test.md pin 6ce7195b (v0.60.733.0). eval/systems/gbrain-defaults pins f05943e (0.60.138.0, the frozen A14 commit) by default. See Cross-cutting observations.

Key answer for the Rust parity work: the binary contract that already exists is the gbrain-defaults shim (`eval/systems/gbrain-defaults/shim.py`). It drives a gbrain executable (name from env `GBRAIN_BIN`) through CLI JSON commands and one MCP stdio server (`gbrain serve --surface starter`). It does not import gbrain in process. PROTOCOL.md (HTTP, protocol v1) is the wrapper contract for memory systems. It is not a gbrain-internal API.

## Summary

| Runner | Entry path | Measures | Run command | Tier / time / cost | LLM keys | Corpus | Coupling |
|---|---|---|---|---|---|---|---|
| Workload suites, offline checks | eval/workload-suites/cli.ts | Generator validity: schema, needle presence, stub-reader solvability, correction schedule | `bun eval/workload-suites/cli.ts <suite\|all> [--smoke] [--dry-run] [--write-manifest]` | Offline. Time unknown. $0 | None | Generated from seed; digests in eval/data/workload-suites/*.manifest.json | none |
| Workload suites, paid bench | eval/workload-suites/bench.ts (+ bench-infra.ts, correction-adapters.ts) | Memory QA accuracy on four suites, correction and stale-answer rates | `bun eval/workload-suites/bench.ts <suite> --phase answer\|sweep\|score [--stub] [--gbrain <checkout>@<ref>]` | Paid. Program cap $720 (bench-infra.ts:33). Time unknown | Yes: Anthropic (reader, judge fallback), OpenAI, Particle, Voyage (gbrain). `--stub` is keyless | Generated suite + eval/data/world-v1 | CLI + MCP stdio, through Python bridge |
| Workload suites, report | eval/workload-suites/report.ts | Markdown tables and receipts from finished bench runs | `bun eval/workload-suites/report.ts [--copy docs/benchmarks/<date>-workload-suites]` | Offline. Under 1 s expected (not measured) | None | eval/reports/workload-bench/<suite>/ | none |
| Harness cell launcher | eval/runner/harness-cell.ts | One audited cell of the agent-memory harness (ingest, retrieve, answer, judge) | `bun run harness:cell plan\|run\|resume\|tune\|cli` | Paid unless `--stub-upstream`. Plan is free and prints a cost estimate | Yes (OpenAI, Anthropic, Voyage, Gemini, Groq, Particle routes), or none with `--stub-upstream` | Dataset via harness cache; .harness/ venv | CLI + MCP, through Python child (mpw.cell) |
| Harness dev sweep | eval/runner/harness-dev.ts | Retrieval-knob tuning to delivered-context targets, one cell per target | `bun eval/runner/harness-dev.ts sweep --provider gbrain --dataset beam --split 100k ...` | Paid (runs cells). Unknown | Yes | Same as harness-cell | Via harness-cell |
| Harness smoke | eval/runner/harness-smoke.ts | Protocol plumbing for each dataset x provider x mode, not scores | `bun eval/runner/harness-smoke.ts [--providers gbrain,comparator]` | Keyless, stub upstream. Time unknown | None | Dataset fixtures | Via harness-cell (CLI + MCP) |
| Harness test, env, comparator, ledger | eval/runner/harness-test.ts, harness-env.ts, harness-comparator.ts, harness-ledger.ts | Test runner, pinned Python install, comparator server install, ledger rebuild | `bun run harness:test`, `harness:setup`, `harness:comparator install\|check`, `bun eval/runner/harness-ledger.ts --plan ...` | Free (no provider calls) | None | eval/harness-provider/ledger/ | none for the TS files (ledger imports chatPrice from harness-cell.ts) |
| Metering proxy and stub upstream | eval/runner/harness-metering-proxy.ts, metering-proxy.ts, stub-upstream.ts | Infrastructure: the only egress for paid calls, budget reservation and keyless stand-in | Started by launchers, not by hand | Infrastructure | Proxy holds real keys; stub needs none | n/a | none (HTTP proxy); gbrain children reach it via env base URLs |
| Shootout cell launcher | eval/runner/shootout-cell.ts | Lease, VM launch, settle for one (system, slice, config) cell | `bun eval/runner/shootout-cell.ts init\|reserve\|launch\|settle\|...` | Paid, bounded by campaign cap (manifest `cap_usd`, value not checked) | Yes, through the lease proxy | Campaign manifest; datasets via custody | none in TS (launches bootstrap.sh inside the VM) |
| Shootout driver (embedder) | eval/runner/shootout-driver.ts (via scripts/run-shootout-phase2.sh) | P@5 / R@5 on relational and cat13 subsets, one embedder/reranker cell | `bun eval/runner/shootout-driver.ts --cell <id> --embedder <p:m> --dim N [--reranker ...] [--subset cat13-embedder]` | Paid, no dollar cap (scripts/RUNBOOK_SHOOTOUT.md). Time unknown | Yes: OpenAI, Voyage (Anthropic for smoke) | eval/data/world-v1, Cat 13 subset | In-process |
| Shootout report | eval/runner/shootout-report.ts | Pre-registered analysis of committed cell results | `bun eval/runner/shootout-report.ts --results <dir> --campaign <json> --output <dir>` | Offline | None | Committed results | none |
| Phase 1 embedder wrapper (historical) | scripts/run-shootout-phase1.sh | LongMemEval answer quality for 4 embedder cells (RUNBOOK: incomplete) | `bash scripts/run-shootout-phase1.sh` (refuses reranked cells) | Paid. Wall cap 9000 s (PHASE1_CELL_WALL_CAP_SECONDS). No dollar cap | Yes: OpenAI, Anthropic, Voyage | ~/datasets/longmemeval (env LONGMEMEVAL_DATASET) | CLI (`gbrain eval longmemeval`, `gbrain --version`) |
| Memory-system shims (protocol v1) | eval/systems/<system>/shim.py, _shim/shim.py | Adapter that serves PROTOCOL.md for one memory system | `bash eval/systems/bootstrap.sh up --system <id> --config recipe\|common` | Paid when metered; keyless with fakes | Yes via proxy, dummy keys in container | Per-system store in its volume | gbrain-defaults: CLI + MCP stdio. Other six: vendor SDK or vendor CLI/MCP, no gbrain |
| Keyless fake shim | eval/systems/_fake/fake.py | Protocol reference, in-memory keyword store | `python3 eval/systems/_fake/fake.py` or `bootstrap.sh up --system _fake` | Free | None | Synthetic | none |
| Restart check | eval/systems/restart_check.sh | Whether a container restart loses state, with a canned provider | `bash eval/systems/restart_check.sh <system> ...` | Keyless, local Docker. Time unknown | None (fake provider) | Synthetic (lifecycle-lite) | none in shell; lifecycle-lite drives shim over HTTP |
| Protocol client (TS) | eval/runner/systems/http.ts | Harness-side client of protocol v1 | Used by harness runs | n/a | n/a | n/a | HTTP to shim |
| In-process gbrain adapters | eval/runner/systems/gbrain.ts, gbrain-agent.ts | gbrain as a MemorySystem inside the harness | Used by memory-qa runs (`--system gbrain`) | Paid if answering | Yes | Session pages | In-process (importGbrain) |
| Generators | eval/generators/*.ts (93 files) | Seeded corpora and oracles for suites and runners | `bun eval/generators/<name>.ts` (per file header) | Mostly free; 4 generators call Opus or GPT | 4 generators need keys (see section) | Write into eval/data/<dir>/ | none (no gbrain import found) |
| Custody, regression, schemas, external authors | eval/custody/, eval/regression/, eval/schemas/, eval/external-authors/ | Sealed-file custody tooling, regression inventory, JSON Schemas, contributor query batches | Mostly tooling | Free | None | n/a | none |

## Shared protocol: PROTOCOL.md (v1), read in full

Source: eval/systems/PROTOCOL.md. Implemented by eval/systems/_shim/shim.py (shared base) and each shim.

### Launch and transport

| Item | Value | Evidence |
|---|---|---|
| Process | Each system is a container whose CMD runs its shim (`python3 shim.py` in gbrain-defaults/Dockerfile:23) | eval/systems/gbrain-defaults/Dockerfile |
| Transport | HTTP/1.1 JSON, `ThreadingHTTPServer` on 0.0.0.0, port from `SHIM_PORT` (default 8700). Non-JSON body gives 400 | eval/systems/_shim/shim.py:130-158 |
| Host publish | bootstrap.sh publishes the shim on 127.0.0.1:`SHIM_HOST_PORT` through an egress relay | eval/systems/bootstrap.sh (compose_env, lines about 60-75) |
| Config select | `SHIM_CONFIG=recipe\|common` at container start; `/health` reports it | PROTOCOL.md "Capability record" |
| Stdio | None at the protocol level. Stdio is used inside gbrain-defaults (MCP to gbrain) and in some vendors (MCP to vendor binaries) | shim files, see per-system |
| Provider egress | Only `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `VOYAGE_BASE_URL` (pointed at metering proxy). Container holds dummy keys | PROTOCOL.md "What crosses the boundary" |
| Telemetry | Must be off; list in capability `telemetry_off` | PROTOCOL.md |

### Endpoints

| Method and path | Request body | Response body |
|---|---|---|
| GET /health | none | `{ok: true, config}` once backend accepts writes |
| GET /capabilities | none | Capability record (below) |
| POST /reset | `{ns}` | `{ok: true}`, namespace empty incl. pending work |
| POST /ingest | `{ns, session: {source_id, event_time, turns: [{role, speaker, content}]}}` | `{items_created, warnings[], errors[], completeness: known\|unknown\|degraded}` |
| POST /finish | `{ns, timeout_s}` | `{ready, waited_ms, completeness}` |
| POST /retrieve | `{ns, question, query_time, policy: {name, mode: vendor-default\|fixed-evidence, settings: {}}}` | `{items: [Item], applied_settings, truncated, raw?}` |
| POST /delete_source | `{ns, source_id}` | `{status: deleted\|partial\|unsupported, receipt}` |
| POST /answer (optional) | `{ns, question, query_time, mode, model?}` | `{answer, outcome: scored\|harness_invalid, degraded, source_ids[], model, usage{input,output}, usd, raw}` |

Extra routes, served only by gbrain-defaults (shim.py `extended_dispatch`, lines about 1250-1272): `GET /stats` (serve RSS and brain size), `POST /restart {ns}` (serve restart time).

Item: `{id, rank, type: fact|episode|chunk|note|entity|observation, text, source_ids[], valid_from, valid_to, provenance_status: exact|partial|unavailable}`. `source_ids` must be ids this namespace ingested. `unavailable` means `source_ids` is empty.

Error envelope on any 4xx/5xx: `{"error": {"kind": ..., "message": ...}}` with kind one of `unsupported`, `product_error`, `timeout`, `invalid_request`, `budget` (shim.py:14 ERROR_KINDS). Every response carries `service_ms`.

Rules: `event_time`/`query_time` are ISO-8601 or null. Sessions arrive in event-time order, one at a time per namespace. Parallel namespaces only if `parallel_namespaces: true`. Shims never log request bodies outside the container. Shims never query vendor DBs privately for provenance.

### Capability record (keys)

`system`, `protocol`, `versions{package, lock_sha256, image, vendor_benchmark_code}`, `configs{recipe{model_roles, notes}, common{model_roles, unsettable}}`, `time` (native|in-text|none), `provenance{status, mechanism}`, `delete` (native|public-api-composition|unsupported), `readiness`, `namespace`, `parallel_namespaces`, `retrieval_policies{vendor-default, fixed-evidence}` (each with `settings`), `streaming`, `telemetry_off`, `agent_surface{kind: vendor-mcp|harness-mcp|native-agent|none, transport, version}`, `deviations_from_vendor_code`, `answer` (only if /answer is served).

Harness records /health and /capabilities in each run receipt and hashes them into the run config.

### Conformance and checks

| Check | Path | Evidence |
|---|---|---|
| Conformance suite | `bun test test/eval/systems-conformance.test.ts` (with `SHIM_URL`, or keyless against eval/systems/_fake) | PROTOCOL.md "Conformance"; test file not read here |
| Protocol check script | eval/systems/_shim/protocol_check.py (stdlib, `--url`, `--questions N`) | _shim/protocol_check.py header |
| Shim-side fake provider | eval/systems/_shim/fake_provider.py (432 lines) | file list |

## Systems: per-system mapping

Kind ids from eval/systems/kinds.json (13 kinds, 8 with a system, 4 baselines + none without a bundle). gbrain-defaults is kind `gbrain-defaults`. The vendor products are named in docs/comparison-systems.md; this report uses kind ids.

| Kind id | Bundle in eval/systems | Bundle in docs/comparison-systems | Server in container | Passive API | time | provenance | delete | parallel_namespaces | Agent surface | gbrain import |
|---|---|---|---|---|---|---|---|---|---|---|
| gbrain-defaults | eval/systems/gbrain-defaults | (none) | gbrain CLI + MCP stdio | yes | in-text | exact | unsupported (starter has no page delete) | false | vendor-mcp (`gbrain serve --surface starter`) | CLI + MCP, not in-process |
| ext-extract-first | eval/systems/extract-first | docs/comparison-systems/ext-extract-first | vendor Python package (`Memory.add/search`, user_id scope) | yes | in-text | partial | public-api-composition | true | harness-mcp | none |
| ext-memory-bank | eval/systems/memory-bank | docs/comparison-systems/ext-memory-bank | vendor server + vendor Python client (`hindsight_client`) | yes | native | exact | native | true | vendor-mcp | none |
| ext-graph-pipeline | eval/systems/graph-pipeline | docs/comparison-systems/ext-graph-pipeline | vendor Python (asyncio, add + cognify per session) | yes | in-text | partial | native | false | vendor-mcp | none |
| ext-temporal-graph | eval/systems/temporal-graph | docs/comparison-systems/ext-temporal-graph | graphiti_core on Neo4j 5.26 | yes | native | partial | native | true | vendor-mcp | none |
| ext-markdown-kb | eval/systems/markdown-notes | docs/comparison-systems/ext-markdown-kb | `bm` CLI + `bm mcp` stdio | yes | in-text | exact | native | false | vendor-mcp | none |
| ext-verbatim-session | (none) | docs/comparison-systems/ext-verbatim-session | not reviewed (bundle only) | not reviewed | n/a | n/a | n/a | n/a | n/a | none |
| ext-agent-runtime | eval/systems/agent-runtime | docs/comparison-systems/ext-agent-runtime | vendor CLI backend + App Server (WebSocket) | no: all passive calls return `unsupported` | none | unavailable | unsupported | false | native-agent | none |
| baseline-* (4) and none | no bundle | no bundle | harness-side (eval/runner/systems/baselines.ts) | n/a | n/a | n/a | n/a | n/a | n/a | not reviewed |

Source for the table columns: each eval/systems/<x>/capability.json, read with a small script. The gbrain-defaults answer route (`answer` in /capabilities) is injected at runtime by shim.py:785-787 (see the observation list).

### gbrain-defaults (the gbrain row)

Entry: eval/systems/gbrain-defaults/shim.py (1272 lines). Helpers: `fake_upstream.py` (keyless provider stand-in, extends _shim/fake_provider.py), `capability.json`, `Dockerfile`, `docker-compose.yml`, `README.md`.

What it measures: gbrain's shipped defaults as the documented install resolved them at the pinned gbrain commit (PGLite, voyage-4 1024d, LLM expansion and the reranker on, search mode tokenmax, limit 50). Current gbrain does not expand queries by default in any search mode. Each namespace is one clean install.

Process model:
- The shim (Python, PID of `python3 shim.py`) starts the gbrain executable as a subprocess. Name comes from env `GBRAIN_BIN` (default `gbrain`), shim.py:62. The same name is used for the CLI calls (shim.py:480, `cli`) and for serve (shim.py:684, `McpStdio([GBRAIN, "serve", ...])`).
- Environment for children: `GBRAIN_HOME=/data/home`, `HOME=/data/home`, `NO_COLOR=1`, all `SHIM_*` removed (shim.py:475-477).
- Provider base URLs are written into gbrain's config.json before `init`, from `GBRAIN_PROXY_BASE=http://egress:9000/<slot>` (docker-compose.yml, README "How the shim maps the protocol"). Not from env vars (gbrain does not read VOYAGE_BASE_URL, per README).

CLI commands the shim runs (all via `gbrain <args>` as subprocess):

| Command | Where | Purpose |
|---|---|---|
| `init --pglite --json` | shim.py:571 (install_brain) | Clean install; output parsed as JSON; `notices` answered by defaults |
| `apply-migrations --yes --non-interactive --no-autopilot-install` | install step (README) | Setup step gbrain's postinstall would run |
| `doctor --json` | shim.py:582, 95 (finish) | Quiesce gate: every page present, 0 chunks missing embeddings, no live serve |
| `jobs list --json [--limit N \| --status S --limit 1000000]` | shim.py:495-510 | Pending job queue (states waiting, delayed, paused, waiting-children, active) |
| `config ...`, `search modes --json`, `models --json` | F6 overlay (`config set`); README for resolved config | Resolved-configuration hash and F6 overlays |
| `extract-conversation-facts --source-id default --max-cost-usd X --json --yes` | shim.py:161 (F6 only) | Fact extraction under a dollar cap |
| `repair safe-chunks --source default [--apply] --json` | shim.py:176-178 (F6 only) | Repair after extraction |

MCP stdio (`gbrain serve --surface starter`, or `--surface full` when `GBRAIN_FULL_SURFACE=1` or F6):
- Client: shim.py:193-270 `McpStdio`. JSON-RPC 2.0 over stdin/stdout; `initialize` with protocolVersion `2025-06-18`, then `notifications/initialized`, `tools/list` (cursor paging), `tools/call`.
- Tools the shim calls: starter `put_page`, `get_write_request`, `list_write_requests`, `query`, `list_pages`, `synthesize` (shim.py:55-60, STARTER_CALLS). Full: `think`. F6: `recall`. Serve start fails if `tools/list` lacks any of these (shim.py:717-722).
- `query` args: `{query, limit?, autocut?, expand?}`; `token_budget` and `return_unit` are refused (shim.py FORBIDDEN_QUERY_KEYS), because they switch gbrain to chunk delivery.
- `put_page` args: `{slug, content, request_id, wait_ms: 30000}`; pending receipts polled with `get_write_request`.

Endpoint mapping (from README table and code): `/reset` = fresh scripted install, verified against reference install. `/ingest` = one `put_page` of a `type: conversation` page at `conversations/<date>/<source id>`, request id uuidv5(ns|source_id). `/finish` = stop serve, doctor gate, drain or horizon for jobs, record `background_liabilities`, restart serve. `/retrieve` = `query` (not `token_budget`). `/answer` = `synthesize` (starter) or `think` (full surface). `/delete_source` = `unsupported`.

Reference-install checks: the first install is the reference (`/data/reference.json`). Later installs and every serve start must match `resolved_sha256` (config.json hash without install timestamp, search modes, models) and the starter tools/list hash (shim.py:709-713, 542-556). A mismatch is a `product_error`.

Namespaces: one at a time (`parallel_namespaces: false`). Brains are moved by rename between `/data/ns/<ns>` and GBRAIN_HOME, never copied (README).

Dummy keys: `VOYAGE_API_KEY` and `OPENAI_API_KEY` are set to the cell token or a dummy (docker-compose.yml). The proxy injects real keys.

Capability `recipe` model roles (eval/systems/gbrain-defaults/capability.json): embedder voyage:voyage-4 (1024), reranker voyage:rerank-2.5, expansion anthropic:claude-haiku-4-5-20251001, synthesis anthropic:claude-opus-4-7, extraction anthropic:claude-haiku-5-5. Resolved values come from the reference install (`/capabilities` adds `resolved`).

Coupling: CLI + MCP stdio. No in-process import.
Parity fit: Yes for a Rust binary parity check, if the Rust binary exposes the same CLI JSON and MCP tool names. Needs keys unless `fake_upstream.py` stands in (`--profile keyless`). Deterministic only with keyless upstream.

### Other vendor shims (no gbrain)

| Kind | Shim file | Key facts (evidence) |
|---|---|---|
| ext-extract-first | eval/systems/extract-first/shim.py (250 lines) | Mirrors vendor benchmark (commit 4b61c5d): each chunk is one `Memory.add` scoped by `user_id`; search is `Memory.search(question, filters={"user_id": ...})`. /reset moves to a fresh user_id. Fake provider: fake_provider.py. |
| ext-memory-bank | eval/systems/memory-bank/shim.py (207 lines) | `hindsight_client` (`Hindsight as MemoryBankClient`), `retain_async=true`, polls `OperationsApi.get_operation_status`. Config env: memory-bank.recipe.env, memory-bank.common.env. test_shim.py. |
| ext-graph-pipeline | eval/systems/graph-pipeline/shim.py (201 lines) | Asyncio; per session `add` then `cognify(run_in_background=False)`; retrieval `search` with `HYBRID_COMPLETION`, `only_context=True`. Tests in tests/ (keyless run_keyless.sh). |
| ext-temporal-graph | eval/systems/temporal-graph/shim.py (185 lines) | `graphiti_core.Graphiti` on Neo4j; `openai` client; `group_id = ns`; reset = clear_data for group. Fake: fake_provider.py. test_shim.py. |
| ext-markdown-kb | eval/systems/markdown-notes/shim.py (289 lines) | `bm project add`, `bm reindex --search --embeddings -p <ns>`, `search_notes` over a warm `bm mcp` stdio session. No vendor code copied. protocol_check.py. |
| ext-agent-runtime | eval/systems/agent-runtime/shim.py (95 lines) | Serves capability only; passive calls `unsupported`. App Server answers `app_server_info` on WebSocket; `/health` reports it. Native-agent Cat 40 driver only. |

### Keyless and infrastructure shims

| Path | Role | Keys |
|---|---|---|
| eval/systems/_fake/fake.py (99 lines) | In-memory keyword store implementing v1; `SHIM_STATE_FILE` keeps state across restarts | None |
| eval/systems/_shim/shim.py (158 lines) | Shared base: routing, timing, error shapes, validation. Vendor shims subclass `Adapter` | n/a |
| eval/systems/_shim/fake_provider.py (432 lines) | Shared fake of OpenAI/Anthropic/embedding shapes | None |
| eval/systems/_shim/protocol_check.py (204 lines) | Stdlib protocol check against any URL | Optional `--questions` makes provider calls |
| eval/systems/bootstrap.sh | `setup`, `proxy`, `up`, `restart`, `down`, `snapshot`, `restore` for a cell. Compose file lookup: `eval/systems/<id>/` then `docs/comparison-systems/<id>/`; `--config <name>` picks `<bundle>/<config>/docker-compose.yml` if present | Proxy holds keys |
| eval/systems/restart_check.sh | Keyless restart check: fake provider (port 18787), stack at `common` config (port 18700), lifecycle-lite with `--restart`, output eval/reports/restart-check/<system>/ | None |
| eval/systems/kinds.json | Public kind ids and bundle paths | n/a |
| eval/systems/name-guard-baseline.json | Counts of files naming external products; may only fall | n/a |

## Workload suites (eval/workload-suites/)

Four suites, all deterministic from a seed, all template based, no model in generation:

| Suite id | Entry module | Seed | Size (full, from eval/data/workload-suites manifests) | Measures |
|---|---|---|---|---|
| passing-details | passing-details.ts (354 lines) | 20261005 | 40 users, 2560 documents, 400 queries | Detail mentioned in passing, buried in a chat about something else; miss classes absent_from_storage, stored_not_retrieved, delivered_but_misread |
| corrections (B2) | corrections.ts (539 lines) | 20261006 | 100 items, 100 users, 400 docs, 300 queries | Corrected-value accuracy and stale rate after 1 and 5 unrelated writes, per arm |
| time-relationships (B3) | time-relationships.ts (313 lines) | 20261007 | 2 users, 354 docs, 374 queries | As-of employer (N3 ledger), one-hop and multi-hop relations (N9, relational paraphrase) |
| beliefs (B4) | beliefs.ts (290 lines) | 20261008 | 25 histories, 1200 docs, 150 queries | Holders, confidence changes, resolved predictions |

Support modules: common.ts (document rendering, `scoreGold`, `bundleManifest` with sha256 digest), filler.ts (filler topics), world-conversations.ts (world-v1 pages to conversations; reads eval/data/world-v1), types.ts, schema-check.ts (validates against eval/schemas/workload-suite.schema.json), checks.ts (schema, presence, solvability, corrections checks), run-config.ts (model config and arms), report.ts, bench.ts, bench-infra.ts, correction-adapters.ts.

### Offline checks (cli.ts)

- Run: `bun eval/workload-suites/cli.ts <passing-details|corrections|time-relationships|beliefs|all> [--seed N] [--smoke] [--output DIR] [--dry-run] [--target-tokens N] [--write-manifest] [--json]`.
- package.json scripts: `eval:workload-suites` (all), `eval:<suite>`, `eval:<suite>:smoke`, `eval:<suite>:dry`.
- Output: eval/reports/workload-suites/<version>[-smoke]/ plus check-receipt.json. Exit 1 on schema failure or manifest difference.
- Cost: $0. No provider called, no key read (cli.ts header).
- Checks: schema, needle presence, solvability with stub reader (oracle, full history, no memory), correction schedule (checks.ts header).
- `--dry-run` prints paid-run plan (arms, ingest tokens, reader and judge calls, dollars from ledger).
- Corpus: regenerated on demand (not committed). Digests and counts committed in eval/data/workload-suites/*.manifest.json (see its README). Upstream data: eval/data/world-v1 (world-conversations.ts:13), eval/data/relational-paraphrase-v1, eval/data/n9-multihop-paraphrase-v1, N3 generator (time-relationships.ts:28-31).
- Metrics: exact or normalized value match (common.ts scoreGold, valueForms). No statistical test here.
- gbrain imports: none.
- Parity-gate fit: deterministic, fast, keyless. It validates the corpus, not gbrain.

### Paid bench (bench.ts)

- Run: `bun eval/workload-suites/bench.ts <suite> --phase answer|sweep|score [--arms a,b] [--smoke N] [--budget-usd N] [--out DIR] [--stub] [--gbrain <checkout>[@ref]] [--gbrain-search-config k=v] [--remember-valid-from]` (header of bench.ts). No package.json script for bench.ts among the workload-suite entries.
- Phases: `answer` (ingest each arm, presence check, retrieve, fixed reader answers every question; B2 runs its correction schedule), `sweep` (re-read frontier subset saved contexts with sweep models, no retrieval, no ingest), `score` (deterministic scoring; only `ambiguous` answers go to the judge; writes results.json).
- Cost: program cap $720 (bench-infra.ts:33), ledger .budget/workload-suites.sqlite (DEFAULT_LEDGER). Per-run cap from `--budget-usd`. Time: unknown. Each call is metered under labels gbrain, comparator, reader, judge.
- Models (eval/workload-suites/run-config.ts, MODEL_CONFIG): fixed reader `anthropic:claude-opus-5-5`; sweep `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol`, `particle:particle-1`; judge `openai:gpt-6.1-sol` (judges only `ambiguous`); frontier_fraction 0.25; alternate reader `openai:gpt-6-astra`. Excluded: Sonnet, Haiku, Opus 4, GPT-5 and older, Fable (smoke only). MODEL_CONFIG.status says "placeholder" (checked 2026-11-02). docs/benchmarks/2026-10-05-workload-suites.md:245 says the fixed reader has been claude-opus-5-5 since 2026-11-02.
- Keys: Anthropic and OpenAI for reader, judge and sweep; Particle through COMPAT_PROVIDERS; Voyage for gbrain (bridge env `gbrainCredentials` default `['voyage']`, bench-infra.ts:97). `--stub` makes every provider call go to stub-upstream.ts with a throwaway ledger (keyless).
- Caching: reader and judge calls cached by prompt hash in `<out>/model-cache` (bench-infra.ts modelCaller).
- Metrics: corrected-value accuracy, stale-answer rate after 1 and after 5 writes, presence per needle, miss class per query (passing-details.ts classifyMiss).
- Published references: docs/benchmarks/2026-10-05-workload-suites.md; receipts copied by report.ts to docs/benchmarks/<date>-workload-suites.
- gbrain imports: none in TypeScript. The bench talks to gbrain through the Python bridge (below).

Coupling detail, CLI + MCP via bridge:
- bench-infra.ts:253-299 spawns `python -m mpw_workload.bridge` (eval/harness-provider/mpw_workload/bridge.py), JSON lines on stdin/stdout. Env: `MPW_GBRAIN_CLI=<gbrain root>/src/cli.ts`, `MPW_BUN`, child env for gbrain with proxy base URLs.
- Bridge methods (bridge.py header): `init`, `ingest`, `retrieve`, `gbrain_tools`, `gbrain_call(unit, tool, args)` (MCP tools/call on serve), `gbrain_cli(unit, args)` (CLI; closes serve first because PGLite has one writer, bridge.py:235), `comparator_http`, `presence`, `close`.
- eval/harness-provider/mpw/gbrain_provider.py: serve per unit via `McpChild([self.bun, self.cli, "serve"])` (line 425). CLI through `_cli(home, *args)`, which runs `[self.bun, self.cli, *args]` (lines 329-334). Commands used: `init`, `apply-migrations`, `config`, `models`, `--version` (lines 355-374).
- MCP tools called by gbrain_provider.py: `put_page`, `put_pages`, `query`, `recall`, `think`, `get_stats`, `get_health`.
- Correction arms (correction-adapters.ts): `gbrain_put`, `gbrain_call` (e.g. `forget` with id, reason), remember with `replaces` only when the build has it (bench.ts:317, correction-adapters.ts:77).
- Note: the bridge hard-wires `bun <cli.ts>` (self.bun + self.cli). A native binary needs a wrapper or a change to gbrain_provider.py:329 and :425.

### Report (report.ts)

- Run: `bun eval/workload-suites/report.ts [--copy docs/benchmarks/<date>-workload-suites]`. Refuses a run directory whose run.json records another fixed reader.
- Reads eval/reports/workload-bench/<suite>/{results,run,spend}.json. Imports REPO_ROOT and harness-env (path constant only).
- Keyless and offline.

## Harness (eval/harness-provider/ and eval/runner/harness-*.ts)

### Structure of eval/harness-provider/ (368 files, not read individually)

| Directory | Files | Role |
|---|---|---|
| mpw/ | 24 Python | Provider implementations and harness logic: gbrain_provider.py (gbrain via CLI + MCP), comparator_provider.py and comparator_server.py (comparator, product name not written here), mcp_stdio.py (MCP client), cell.py (`python -m mpw.cell run`), scorer.py, leakage.py, context.py, tune.py, projection.py, anthropic_llm.py, stub_llm.py, register.py, names.py |
| mpw_workload/ | 2 | bridge.py: JSON-lines bridge for the workload bench |
| mpw_tools/ | 6 | probe-preload.ts (MCP child event probe), equivalence_report.py, replay.py, sealed_cost.py, store-census.ts |
| tests/ | 18 | pytest (`bun run harness:test`) |
| cells/ | about 270 | Cell specs (dev, mpw2 confirm/dev/iso/retune/step0/w5, matched, equivalence, posthoc), acceptance and fixture cells |
| ledger/ | 3 | plan.json, inputs.json, ledger.json (measured spend, rebuilt by harness-ledger.ts) |
| timestamp-manifests/ | 10 JSON | Observed-session-time manifests per dataset (beam-100k, longmemeval-s, locomo10, ...) |
| coding-spike/ | 3 | Spike scripts |
| top level | Markdown contracts (CONTRACTS.md, LEDGER.md, SCORER.md), harness.lock.json, comparator.lock.json, pyproject.toml, uv.lock, shell wrappers (mpw-*.sh, dev-*.sh) | Cell launches and lock pins |

Contracts: CONTRACTS.md describes the process tree: `bun eval/runner/harness-cell.ts` (launcher, metering proxy in process) starts `python -m mpw.cell run`, which starts `bun <gbrain>/src/cli.ts serve` per unit (stdio MCP, label gbrain) and the comparator server (label comparator).

### Launcher and helpers (eval/runner/harness-*.ts)

| File | Lines | What it does | Imports (relevant) |
|---|---|---|---|
| harness-cell.ts | 680 | `plan`, `run`, `resume`, `tune`, `cli` for one cell; content-addressed cell id; flags `--stub-upstream`, `--budget-ledger`, `--gbrain`, `--cells-dir` | budget-ledger.ts, gbrain-under-test.ts (`gbrainSpecFrom`, `resolveGbrainUnderTest`, `productIdentityFor`), harness-env.ts, receipt.ts |
| harness-dev.ts | 149 | Sweeps retrieval knobs to delivered-context targets (±10% gate), writes specs to eval/harness-provider/cells/dev/ and tracks to eval/reports/harness-dev/ | harness-cell.ts (type), harness-env.ts (REPO_ROOT) |
| harness-smoke.ts | 85 | Keyless protocol smoke: longmemeval s, locomo10, beam 100k (and more) x rag, agentic-rag, agent x providers; stub upstream; writes eval/reports/harness-smoke/summary.json | harness-cell.ts (type), harness-env.ts |
| harness-test.ts | 21 | Runs pytest in the harness venv | harness-env.ts |
| harness-env.ts | 210 | Installs the pinned harness from eval/harness-provider/harness.lock.json into .harness/ (git pack, uv lock, CPU torch) | none (node builtins) |
| harness-comparator.ts | 19 | `python -m mpw.comparator_server install\|check\|describe` | harness-env.ts |
| harness-ledger.ts | 216 | Rebuilds ledger.json and LEDGER.md from measured cells | harness-cell.ts (`chatPrice`, `embeddingPrice`) |
| harness-metering-proxy.ts | 538 | In-process metering proxy: token check, saves bodies, prices and reserves on BudgetRun, swaps token for key, streams back | budget-ledger.ts, metering-proxy.ts (UPSTREAM_DEADLINE_MS), providers/openai-compatible.ts, usage-receipt.ts |

Cost and time for the launcher: unknown (no budget constants beyond the ledger caps). `plan` prints an estimate and spends nothing.

Coupling for the harness: the TS launcher does not import gbrain modules to run a cell. It resolves a checkout (`gbrain-under-test.ts`: git archive overlay under .gbrain-overlays/, `bun install --frozen-lockfile`), and the Python process spawns the gbrain CLI and MCP serve. Classification: CLI + MCP.

## Shootout (eval/runner/shootout-*.ts, scripts/)

### shootout-cell.ts (1454 lines): launcher

- Modes: `init | reserve | launch | settle | abandon | status | raise-cap | hash | resume | remote` (usage block, lines 20-50).
- Lease model: each cell reserves a lease from the campaign run budget in a SQLite ledger (budget-ledger.ts). Launch marks the lease launched. The VM runs `scripts/ubicloud/ubi-runner.sh` (or `UBI_RUNNER`). A `local: true` cell runs on this host.
- Q1 scoreboard campaigns (`kind: q1-scoreboard-campaign`) freeze the campaign hash over git blobs of `executes` paths and image digests.
- Imports: memory-qa/corpus.ts (bg1 unit conversations), budget-ledger.ts, metering-proxy.ts (`DEFAULT_MAX_OUTPUT_TOKENS`, `DEFAULT_ROUTE_CAPS`, `KEY_ENV`, `keylessUpstream`), q1/scoreboard-errors.ts, memory-qa/beam10m-corpus.ts, sealed-confirmation-lib.ts. No gbrain import.
- Custody: sealed files come from `GBRAIN_EVALS_*_SOURCE` outside the repo (checks at lines 430-506). Never inside the checkout.
- Cost: bounded by lease and campaign cap. Campaign cap_usd is in the manifest (not located in this pass).
- Coupling: none to gbrain code. The VM command runs eval/systems/bootstrap.sh and the cell runner.

### shootout-driver.ts (269 lines): embedder cell, in process

- Run: `bun eval/runner/shootout-driver.ts --cell <id> --embedder <provider:model> --dim <n> [--reranker <model>] [--subset cat13-embedder] --output <file>`.
- Adapter: `HybridNoGraphAdapter` (eval/runner/adapters/vector-grep-rrf-fusion.ts). Imports gbrain modules directly:
  - `gbrain/pglite-engine`: `PGLiteEngine` (new), engine.connect, engine.initSchema, engine.setConfig, engine.disconnect
  - `gbrain/search/hybrid`: `hybridSearch`
  - `gbrain/ai/gateway`: `configureGateway({embedding_model, embedding_dimensions, ...})`
  - `gbrain/types`: `HybridSearchMeta`, `SearchResult` (types)
  - `../import-embedded.ts`: `importFromContentEmbedded` (wraps gbrain/import-file `importFromContent`)
  - `./gbrain-inline.ts`: `gcNow`
- Measures: P@5 and R@5 on relational queries (queries/relational.ts, shared with multi-adapter) and on the cat13 embedder subset.
- Keys: OPENAI and Voyage per cell, Anthropic for smoke (RUNBOOK_SHOOTOUT.md). Paid, no dollar cap (RUNBOOK). Time unknown.
- Parity fit: in-process, so not a binary-adapter target as it stands.

### shootout-report.ts (498 lines): analysis

- Pre-registered analysis of committed results only. Uses memory-qa/outcomes.ts (scored, product failures scored 0, harness failures excluded), stats/paired.ts (clustered paired delta, Holm adjustment, power note), metrics.ts (percentile). Preregistration: docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md.
- Keyless, no gbrain import.

### scripts/run-shootout-phase2.sh (152 lines): wrapper for shootout-driver

- 4 BrainBench cells, each run twice (relational, then cat13 subset), with a smoke gate `bun run eval/runner/smoke.ts` first (smoke.ts imports `gbrain/ai/gateway` `configureGateway, embed`, in process).
- Keys required at startup: OPENAI, ANTHROPIC, VOYAGE (lines 22-24).

### scripts/run-shootout-phase1.sh (255 lines) and scripts/RUNBOOK_SHOOTOUT.md (86 lines): historical

- Runbook says this embedder comparison is historical. Phase 1 refuses its reranked cells (RUNBOOK). The current matrix is A0, A1-voyage-rerank-2.5, B0, B1-voyage-rerank-2.5 and no run or cost has been recorded for it.
- Coupling: CLI. `gbrain --version` must be at least 0.35.1.0 (script lines 83-87), `gbrain eval longmemeval --mode tokenmax --expansion` (answer generation), external LongMemEval evaluate_qa.py with OpenAI judge.
- Keys: OPENAI_API_KEY (embeddings and judge), ANTHROPIC_API_KEY (answers), VOYAGE_API_KEY (Voyage cells). The script aborts on missing keys (line 52).
- Cost: wall cap 9000 s (PHASE1_CELL_WALL_CAP_SECONDS), no dollar cap (RUNBOOK says the older "$90 per cell" figure was incorrect).

## eval/runner/systems/ (adjacent, PROTOCOL-facing)

- http.ts (125 lines): protocol v1 client. Methods: `capabilities` (GET /capabilities), `health`, `reset` (POST /reset), `ingest` (POST /ingest, default timeout 60 min), `finish` (POST /finish, deadline timeout_s + 60 s), `retrieve` (POST /retrieve). Checks outgoing bodies with sanitize.ts (`findLeaks`, `NS_RE`, `SRC_RE`). No gbrain import. Coupling: HTTP.
- gbrain.ts (194 lines): `GbrainLegacySystem` and `GbrainShootoutSystem`. In process: `importGbrain` (gbrain-under-test.ts:117, imports by absolute path under the chosen root) returns `PGLiteEngine`, `importFromContent`, `hybridSearch`. Calls: `new PGLiteEngine()`, `importFromContent(engine, slug, page, {})`, `hybridSearch(engine, text, opts)`, `engine.deletePage`, `engine.executeRaw`, `engine.disconnect`. Coupling: in-process.
- gbrain-agent.ts (250 lines): gbrain's MCP tools (query, search, get_page) run in process through `dispatchToolCall` (mcp-tools.ts) and `buildToolDefs` over the build's OPERATION_MANIFEST. Imports gbrain-under-test.ts (`importGbrain`, `productIdentityFor`) and `hashEmbed` from memory-qa/run-systems.ts. Coupling: in-process.
- gbrain-query/ (system.ts, connector.ts, README.md): not reviewed in this pass.

## Generators (eval/generators/, 93 files)

No file imports `gbrain` or `@garrytan/gbrain`. Generators are pure data producers except where noted.

### Generators that call a model or API

| File | Calls | Key | Output (eval/data/...) | Offline mode |
|---|---|---|---|---|
| gen.ts | Anthropic Opus (prose) | ANTHROPIC_API_KEY, read from .env.testing (gen.ts:13) | eval/data/world-v1 (line 153) | `--dry-run`, `--max N` |
| amara-life-gen.ts | Anthropic, `claude-opus-4-5` (line 85) | ANTHROPIC_API_KEY (line 752) | eval/data/amara-life-v1/ (+ gold/) and a dry-run preview root | `--dry-run` (stub bodies), `--max` |
| transcript-distill-gen.ts | Anthropic `claude-opus-4-5` (line 86) plus `claude-haiku-4-5-20251001` audit (line 89) | ANTHROPIC_API_KEY (line 69) | eval/data/transcript-distill-v1/ (transcripts, gold, brain-scaffold, _manifest.json) | none found |
| p8-withdraw-review-gen.ts | OpenAI `/v1/responses` for paraphrases (`--model gpt-6.1-sol`, line 90) | OPENAI_API_KEY (line 91) | JSONL to `--out` (facts-fixtures format for `gbrain decide dataset`) | Dev seed 1 names pool, no key needed for other pieces (not traced further) |
| n13-code-scout-vendor.ts | HTTP fetch of vendored pathe source (line 59) | none | eval/data/n13-code-scout | n/a |

Other generators (about 80) are seeded and deterministic. Examples with their output: world.ts (world skeleton, no LLM), n3-temporal-gen.ts (N3 ledger, used by time-relationships), relational-paraphrase-gen.ts (data/relational-paraphrase-v1), n9-multihop-paraphrase-gen.ts (data/n9-multihop-paraphrase-v1), changing-facts-gen.ts (eval/data/changing-facts-v1), model-ladder-gen.ts (eval/data/model-ladder-v1, -large, -wide-dev), synthetic-v1-gen.ts (eval/data/synthetic-v1), skillopt-v1-gen.ts (eval/data/skillopt-v1), sealed-confirmation-gen.ts and -v2-gen.ts (eval/data/sealed-confirmation-v1, v2; manifests), world-v1-attendees.ts (eval/data/world-v1-attendees), facts-absorb-gen.ts, a4/n1/n2/n4..n8/n12/n14, cat37/38/39, freshness-world-gen.ts, write-contract-gen.ts, entity-agent-gen.ts, etc. Output directories were taken from file headers and output-path strings. Not every generator was traced end to end.

Generated data is committed under eval/data/ (60+ directories, listed by `ls eval/data`). Workload-suite records are not committed (eval/data/workload-suites/README.md).

Test file: generators/world-html.test.ts (a test with one key-name hit; not a runner).

## Custody, regression, schemas, external authors

| Path | Contents | Notes |
|---|---|---|
| eval/custody/bg1/ | mint.sh, render.ts, fill-manifest.ts, hashlist.ts, validate.ts | Custodian tooling for sealed BG1 set. Shootout-cell mirrors it (`GBRAIN_EVALS_BG1_SOURCE`). No LLM, no gbrain. |
| eval/custody/rs1/ | beam-checkout.sh, beam-paths.ts | Custodian tooling for RS1. |
| eval/regression/situation-recall-v1.json | Inventory with keys schema_version, name, inspected_eval_sha, declared_historical_pin, status, amendments, native_contracts, absent_categories | Data record, not read in full. |
| eval/schemas/*.json (10) | receipt, scorecard, transcript, workload-suite, evidence-contract, public-probe, corpus-manifest, cat35-receipt, cat36-corpus, tool-schema | workload-suite.schema.json used by workload-suites/schema-check.ts. |
| eval/external-authors/README.md | Contributor query batches at eval/external-authors/<handle>/queries.json, validated by `bun run eval:query:validate` | No code. |

## Cross-cutting observations

1. Two coupling patterns exist, and both are non-in-process for the parity work. (a) Subprocess: gbrain-defaults shim (CLI + MCP stdio), harness gbrain_provider.py (`bun cli.ts serve` and CLI commands), workload bridge (same), phase1 script (`gbrain eval longmemeval`). (b) In-process imports: eval/runner/systems/gbrain.ts, gbrain-agent.ts, shootout-driver.ts and its adapter, smoke.ts, plus ~60 runner files listed by `rg "from 'gbrain"` under eval/runner/. The in-process files are outside this group's scope, but they are the ones a Rust rewrite cannot reuse as-is.

2. The gbrain-defaults CLI and MCP surface is the nearest thing to a binary contract. Needed by shim.py: `init --pglite --json`, `apply-migrations`, `doctor --json` (checks: pages, embedding coverage, live_serve reason), `jobs list --json` (status and limit flags), `config`, `search modes --json`, `models --json`, `serve --surface starter|full`, MCP tools `put_page`, `get_write_request`, `list_write_requests`, `query`, `list_pages`, `synthesize` (and `think`, `recall` on full or F6). The shim also compares resolved-config hashes and tools/list hashes between installs, so a Rust binary has to match those JSON shapes exactly, not just the tool names.

3. The Rust-facing switch point already exists for gbrain-defaults: `GBRAIN_BIN` (shim.py:62) names the executable used for both CLI and serve. The workload bridge and harness do not have this switch: they run `bun <cli.ts>` (gbrain_provider.py:329, 425; bridge env MPW_BUN and MPW_GBRAIN_CLI).

4. Pin mismatch (observed, not investigated): package.json and docs/gbrain-under-test.md pin gbrain 6ce7195b (v0.60.733.0). gbrain-defaults defaults to f05943e (0.60.138.0, the Q1 freeze), in shim-facing docs (README, Dockerfile ARG, docker-compose default) and in capability.json `versions.package`. docker-compose and Dockerfile take GBRAIN_SHA to override. F6 requires GBRAIN_LAUNCH_SHA equal to the image commit (shim.py f6_pin_problem).

5. Stale or inconsistent capability fields (observed): capability.json uses `own_answer` and `extensions` keys and no `answer` key (the shim injects `answer` at runtime, shim.py:785-787). capability.json `agent_surface.version` says `gbrain serve --surface starter (gbrain 0.60.95.0)` while `versions.package` says 0.60.138.0. The on-disk record is therefore not the exact `/capabilities` response.

6. Two bundle copies per external system. eval/systems/<short name>/ (extract-first, memory-bank, graph-pipeline, temporal-graph, markdown-notes, agent-runtime) and docs/comparison-systems/ext-<id>/ (per kinds.json). All six pairs differ in Dockerfile, README, capability.json and docker-compose.yml (diff -rq). eval/systems copies also have PILOT.md, and the docs agent-runtime copy has answer-cell.json. bootstrap.sh checks eval/systems/<--system>/ first, so the name used on the command line decides which copy runs. restart_check.sh uses the short names. Which copy is canonical was not verified.

7. Keyless paths are consistent: stub-upstream.ts (harness), `--stub` (bench.ts), `_fake` and `fake_provider.py` (shims), `restart_check.sh`, `harness-smoke.ts`, and the workload `cli.ts` checks. Paid paths all go through the metering proxy (metering-proxy.ts, harness-metering-proxy.ts) and its ledger (budget-ledger.ts).

8. Model placeholder status: eval/workload-suites/run-config.ts says MODEL_CONFIG.status is a placeholder, while docs say claude-opus-5-5 has been the fixed reader since 2026-11-02. Generators use claude-opus-4-5 and claude-haiku-4-5 (not readers). Both facts are from file text, not checked against a live model list.

9. Unknowns: wall time for every paid runner; campaign cap_usd values in shootout manifests; whether the four generators with keys have offline modes beyond the listed ones (p8 and n13 were only partly read); gbrain-query and baselines were not reviewed.

10. Naming rules: the comparator's product name must not be written in this repository (eval/harness-provider/CONTRACTS.md "Naming"). This report uses "comparator" and kind ids, not product names, for that reason.
