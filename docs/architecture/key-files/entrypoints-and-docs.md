# Key files: Entrypoints And Docs

[Subsystem index](../KEY_FILES.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

- `.agents/gbrain-launcher` — shared plugin MCP launcher (sh, Unix-only) for the Codex, Claude Code, and OpenClaw (`openclaw.plugin.json` `mcpServers.gbrain`) lanes: GBRAIN_BIN → ~/.bun/bin/gbrain → PATH resolution, one stderr resolution line, GBRAIN_SURFACE substitute-or-append override for `serve` argv, actionable exit-127 recovery copy, no auto-install by design. Behavioral branches all pinned in the manifest test.

- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` — the Claude Code plugin lane: inline MCP declaration (command/args/cwd via `${CLAUDE_PLUGIN_ROOT}`; no `env` block — Claude passes the parent env through); the Claude marketplace carries the full plugin PLUS the persona variant entries (`gbrain-coding`/`gbrain-daily` → `plugin-variants/`), while the codex marketplace intentionally stays single-entry until codex's multi-entry handling gets its observation run — variant names are pinned to `skills/plugin-lanes.json#personas` by `test/codex-plugin-manifest.test.ts`.

- `.codex-plugin/plugin.json` + `.codex-plugin/mcp.json` + `.agents/plugins/marketplace.json` — the Codex plugin lane: manifest (skills → the committed `plugin/` tree; mcpServers → the NON-root mcp.json), the MCP declaration (`serve --surface starter --source-guard`, code-derived `env_vars` passthrough), and the codex-native marketplace. Version lockstep with package.json + the claude/openclaw manifests pinned by `test/codex-plugin-manifest.test.ts`.

- `AGENTS.md` — Local-clone entry point for non-Claude agents (Codex, Cursor, OpenClaw, Aider). Mirrors `CLAUDE.md` intent via relative links. Claude Code keeps using `CLAUDE.md`.

- `admin/` — React 19 + Vite + TypeScript admin SPA embedded in the binary via `admin/dist/` served by `serve-http.ts`. 7 screens: Login (bootstrap token → session cookie), Dashboard (metrics + SSE feed + token health), Agents (sortable table + sparklines + Register), Register (modal with scope checkboxes + grant type selector), Credentials reveal (Copy + Download JSON + one-time-only warning), Request Log (filterable paginated), Agent Detail drawer (Details / Activity / Config Export tabs + Revoke). Design tokens: `#0a0a0f` bg, Inter for UI, JetBrains Mono for data, 4-32px spacing scale, rounded pill badges. HTTP-only SameSite=Strict cookie auth. 65KB gzip. Build: `cd admin && bun install && bun run build`; output at `admin/dist/` is committed for self-contained binaries.

- `docker-compose.ci.yml` + `scripts/ci-local.sh` — Local CI gate. `bun run ci:local` spins up four `pgvector/pgvector:pg16` services (postgres-1..4) + `oven/bun:${GBRAIN_CI_BUN_TAG:-1.3.13}` with named volumes (`gbrain-ci-pg-data-{1..4}`, `gbrain-ci-node-modules`, `gbrain-ci-admin-node-modules`, `gbrain-ci-admin-dist`, `gbrain-ci-bun-cache`), runs gitleaks on host, smoke-tests `scripts/run-e2e.sh` argv handling, runs the authoritative `bun run verify` once plus the explicit Bun test-timeout guard, then the complete serial and slow lanes before 4-shard parallel unit + E2E (`xargs -P4`, one Postgres per shard; unit phase keeps `DATABASE_URL` unset). `--no-shard` runs unit/E2E sequentially (debug aid); `--diff` narrows E2E selection without changing the chosen shard mode. The doc-only `--diff` fast path runs only the host secrets scans. Also runs a `pgbouncer` service (`edoburu/pgbouncer`, `POOL_MODE: transaction`, `AUTH_TYPE: plain` — pg16 stores SCRAM verifiers, so the userlist must hold the plaintext password; `IGNORE_STARTUP_PARAMETERS` whitelists gbrain's `statement_timeout`/`idle_in_transaction_session_timeout` startup params the way the Supabase pooler does) fronting postgres-1 on host port `GBRAIN_CI_PGBOUNCER_PORT` (default 6543); every E2E invocation exports `GBRAIN_PGBOUNCER_URL` (pooled; dedicated `gbrain_pgbouncer_test` database so it never races the `gbrain_test` TRUNCATE fixtures) + `GBRAIN_PGBOUNCER_DIRECT_URL`, consumed by `test/e2e/pgbouncer-teardown.test.ts` — which reproduces the transaction-mode teardown failure in the local gate. `--no-pull` skips upstream pulls; `--clean` nukes named volumes. Postgres host port defaults to 5434; override with `GBRAIN_CI_PG_PORT=NNNN`. Full persistence and native runtime matrices run separately; see `docs/TESTING.md`.

- `docs/UPGRADING_DOWNSTREAM_AGENTS.md` — Patches for downstream agent skill forks to apply when upgrading. Each release appends a new section; includes diffs for brain-ops, meeting-ingestion, signal-detector, enrich.

- `docs/architecture/RETRIEVAL.md` + `docs/incidents/RETRIEVAL_MAXPOOL_INCIDENT.md` — retrieval-pipeline architecture reference + the named-thing-miss incident write-up (root cause, the five-layer fix, the eval that pins it).

- `docs/architecture/infra-layer.md` — Shared infrastructure documentation

- `docs/designs/HOMEBREW_FOR_PERSONAL_AI.md` — 10-star vision for integration system

- `docs/ethos/MARKDOWN_SKILLS_AS_RECIPES.md` — "Homebrew for Personal AI" essay

- `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` — Architecture philosophy essay

- `docs/eval-bench.md` — contributor guide for using captured data to benchmark retrieval changes before merging. Linked from CONTRIBUTING.md under "Running real-world eval benchmarks (touching retrieval code)".

- `docs/eval-capture.md` — stable NDJSON schema reference for gbrain-evals consumers.

- `docs/guides/` — Individual SKILLPACK guides (broken out from monolith)

- `docs/guides/diligence-ingestion.md` — Data room to brain pages pipeline

- `docs/guides/idea-capture.md` — Originality distribution, depth test, cross-linking

- `docs/guides/quiet-hours.md` — Notification hold + timezone-aware delivery

- `docs/guides/repo-architecture.md` — Two-repo pattern (agent vs brain)

- `docs/guides/skill-development.md` — 5-step skill development cycle + MECE

- `docs/guides/sub-agent-routing.md` — Model routing table for sub-agents

- `docs/integrations/` — "Getting Data In" guides and integration docs

- `docs/mcp/` — Per-client setup guides (Claude Desktop, Code, Cowork, Perplexity)
- BrainBench retrieval benchmark (P@5/R@5 corpus + harness): lives in the separate [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo. Not installed alongside gbrain. Distinct from the in-repo cross-harness memory conformance suite (`gbrain eval brainbench` — `src/eval/brainbench/`, corpus at `evals/brainbench/`, methodology in `docs/eval/BRAINBENCH.md`).

- `docs/operations/conversation-parser-llm-fallback.md` — operator and maintainer contract for the default-off LLM parse fallback: exact config key, deterministic-first dispatch boundary, sampled data surface, untrusted-content prompt handling, page-date/cache-key coupling, timestamp validation, cache/checkpoint behavior, observability, limitations, and focused test commands.

- `docs/progress-events.md` — Canonical JSON event schema reference. Additive only.

- `docs/protocol/MCP_META_CHANNELS.md` — normative `_meta` conventions for MCP tool responses: one producer per top-level key, additive-forever within a key, producer isolation, and the registered-keys table (`brain_hot_memory`, `retrieval`, `warnings`). Anything the model must SEE rides a content block (mainstream harnesses don't feed `_meta` to the model); `_meta` serves structured consumers. Add a key by registering it in the table — one producer, additive-forever.

- `gbrain.yml` (brain repo root) — Optional storage tiering config. Top-level `storage:` section with `db_tracked:` and `db_only:` array-valued keys. `gbrain sync` auto-manages `.gitignore` for `db_only` paths on successful sync (skips on dry-run, blocked-by-failures, submodule context, or `GBRAIN_NO_GITIGNORE=1`). `gbrain export --restore-only [--repo P] [--type T] [--slug-prefix S]` repopulates missing `db_only` files from the database.

- `openclaw.plugin.json` — ClawHub bundle plugin manifest

- `recipes/` — Integration recipe files (YAML frontmatter + markdown setup instructions)

- `skills/RESOLVER.md` — Skill routing table (based on the agent-fork AGENTS.md pattern) with `skills/manifest.json`: schema-author wired into the dispatcher with the full functional-area trigger list (compressed routing pattern per the dispatcher convention).

- `skills/_brain-filing-rules.md` — Cross-cutting brain filing rules (referenced by all brain-writing skills)

- `skills/_friction-protocol.md` — shared cross-cutting convention skill (like `_brain-filing-rules.md`). Tells agents when to call `gbrain friction log` and how to choose a severity. Routes to friction CLI from any skill the claw-test exercises.

- `skills/_output-rules.md` — Output quality standards (deterministic links, no slop, exact phrasing)

- `skills/brain-ops/SKILL.md` — Brain-first lookup, read-enrich-write loop, source attribution

- `skills/citation-fixer/SKILL.md` — Citation format auditing and fixing

- `skills/conventions/` — Cross-cutting rules (quality, brain-first, model-routing, test-before-bulk, cross-modal)

- `skills/conventions/brain-routing.md` — agent-facing convention skill documenting the canonical 6-tier source resolution chain (flag → env → dotfile → local_path → brain_default → seed_default) with paste-ready decision tables. Linked from CLAUDE.md's "Two organizational axes" section and from `gbrain sources current`'s hint output.

- `skills/cron-scheduler/SKILL.md` — Schedule staggering, quiet hours, idempotency

- `skills/cross-modal-review/SKILL.md` — Quality gate via second model

- `skills/daily-task-manager/SKILL.md` — Task lifecycle with priority levels

- `skills/daily-task-prep/SKILL.md` — Morning prep with calendar context

- `skills/data-research/SKILL.md` — Structured data research: email-to-tracker pipeline with parameterized YAML recipes

- `skills/idea-ingest/SKILL.md` — Links/articles/tweets with author people page mandatory

- `skills/media-ingest/SKILL.md` — Video/audio/PDF/book with entity extraction

- `skills/meeting-ingestion/SKILL.md` — Transcripts with attendee enrichment chaining

- `skills/migrations/` — Version migration files with feature_pitch YAML frontmatter

- `skills/minion-orchestrator/SKILL.md` — Unified background-work skill. Two lanes: shell jobs via `gbrain jobs submit shell --params '{"cmd":"..."}'` (operator/CLI only; MCP throws `permission_denied` for protected names) and LLM subagents via `gbrain agent run` (user-facing entrypoint). Shared Preconditions block, parent-child DAGs with depth/cap/timeouts, `child_done` inbox for fan-in, PGLite `--follow` inline path for dev. Triggers narrowed to `"gbrain jobs submit"` + `"submit a gbrain job"` so `stats`/`prune`/`retry` questions fall through to `gbrain --help`.

- `skills/plugin-lanes.json` — curation record for the plugin lanes: lane set = (openclaw bundle ∖ base_exclusions) ∪ additions, a reason per entry; `starter_gaps` is the generated snapshot of per-skill beyond-starter MCP ops (refresh via `--write-gaps`). The openclaw lane's own curation is untouched — plugin users ARE the brain host (the downstream-vs-host inversion).

- `skills/repo-architecture/SKILL.md` — Filing rules by primary subject

- `skills/reports/SKILL.md` — Timestamped reports with keyword routing

- `skills/signal-detector/SKILL.md` — Always-on idea+entity capture on every message

- `skills/skill-creator/SKILL.md` — Create conforming skills with MECE check

- `skills/soul-audit/SKILL.md` — 6-phase interview for SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md

- `skills/testing/SKILL.md` — Skill validation framework

- `skills/webhook-transforms/SKILL.md` — External events to brain signals

- `src/assets/wasm/` — 37 tree-sitter grammar WASMs + tree-sitter runtime. Committed to the repo so `bun --compile` embeds them deterministically via `import path from ... with { type: 'file' }`. The CI guard `scripts/check-wasm-embedded.sh` requires semantic TypeScript and Bash case-statement symbols in the compiled binary. Bash uses the official tree-sitter-bash v0.23.3 ABI-14 release asset, pinned by checksum in `scripts/vendor-bash-wasm.sh`; `src/assets/wasm/README.md` records provenance. Code chunker version 7 invalidates old content hashes; `gbrain sync --source <id> --full` revisits affected history in active repositories. `tree-sitter-sql.wasm` (DerekStride/tree-sitter-sql @ c2e1e08db1ea20dc23bdb8d228a81a8756e9c450, built with tree-sitter-cli@v0.26.3 --abi 14) adds SQL coverage at 11 MB — larger than peers because the grammar covers PostgreSQL + MySQL + SQLite + T-SQL basics (40 MB generated parser.c); the compiled binary grows ~6%.

- `src/cli.ts` — generic thin-client mutation failures use the shared persistence reporter, retaining request IDs and typed JSON receipts while preserving SIGINT exit 130. `test/thin-client-write-errors.serial.test.ts` exercises real CLI timeout, cancellation, pending and conflict paths against a loopback MCP fixture. No-DB fallbacks announce themselves on stderr instead of degrading silently. `dream` dispatch binds the caught engine-connect error and emits `[dream] WARNING: could not connect to DB (...)` before falling through to filesystem-only phases; the `runDream(null, ...)` no-DB fallback is preserved (pinned by `test/cli-dream-engine-warn.test.ts`, 2 subprocess cases against good + bad DATABASE_URL). `doctor` dispatch does the same: when `connectEngine` OR the DB-backed `runDoctor` run throws, it emits `[doctor] DB-backed doctor run failed (...) — falling back to filesystem-only checks`, scrubbing the error message through BOTH `url-redact.ts:redactUrlsInText` and `redact-connection-info.ts:redactConnectionInfo` first, because doctor output is exactly what users paste into issues and CI logs (pinned by the fallback case in `test/doctor-minions-check.test.ts`: stderr note present, credentials absent, stdout stays parseable `--json`). `main()` opens with `await runCliPreflight()` (core/cli-preflight.ts: cwd-.env quarantine -> `~/.gbrain/.env` -> guardrails loader) before `parseGlobalFlags`; the former inline #3688 guardrails block lives in the preflight module.

- `src/cli.ts` strict flag validation + `src/core/cli-flag-registry.generated.ts` + `scripts/generate-flag-registry.ts` — pre-dispatch, pre-engine unknown-flag rejection for every command: a flag no handler consults fails loud (`unknown flag --x for 'gbrain <cmd>'`, exit 1; `--json` invocations also get a structured `{status:'error', reason:'invalid_flag'}` on stdout) instead of being silently ignored while the un-asked-for real operation runs. `validateCommandFlags(command, subArgs)` runs after the `--help` short-circuit and before any dispatch or engine connect, in two lanes mirroring dispatch order (CLI_ONLY first — `think`/`salience`/`anomalies` are both ops AND CLI_ONLY members whose handlers parse flags the op contract doesn't declare): CLI_ONLY commands validate against the generated `CLI_FLAG_REGISTRY` (per-command legal sets derived from each command's source — case block + imported modules + one level of relative imports + `EXTRA_FLAGS`; deliberately over-inclusive, help-text mentions count, but `//` and `/* */` comments are stripped at every depth before the scan — a helper's doc comment naming `--fresh` must not legalise it for a command that only imports one function from that helper; regenerate via `bun run build:flag-registry`); op commands validate via `findUnknownOpFlag`, which mirrors `parseOpArgs`'s traversal (non-boolean flags consume their value token; `--key=value` inline form recognized) plus the CLI-local flags consumed outside the op contract (`json`, `explain`, `help`, `source`, `dry-run`); the CLI_ONLY token scan is the exported `findUnknownFlag(args, legal)`. In `parseOpArgs`, `json`/`dry_run` are CLI-local booleans that never consume a value token, so a trailing `--dry-run` is a real rehearsal switch feeding `makeContext`'s `ctx.dryRun`. Uppercase flag spellings are treated as unknown (every handler is case-sensitive-lowercase, so they'd be silently ignored downstream — the exact class the validator kills). Exempt by contract: `call` (arbitrary `--param` interface), `config` (arbitrary set values), `jobs submit` (handler-defined payload params); everything after a literal `--` is passthrough and never validated. A command missing from the registry fails OPEN at runtime (never bricks a command); `test/cli-flag-validation.test.ts` pins registry freshness, per-command drift, and consumption evidence — a safety flag (`--dry-run`, `--yes`, `--force`) may only be advertised if the command's source actually reads it. The generator segments `handleCliOnly` into per-command text blocks with `segmentDispatchBlocks`: both `case 'X':` labels and every `if (command === 'X' …)` head — plain, compound (`&& args[0] === 'sub'`: the no-DB `eval <sub>` bypasses such as `eval longmemeval`, the `<cmd> --help` pre-engine branches, `agent register`) and multi-line — are markers, and ownership follows the `command === 'X'` head, never the condition's tail, so a compound block's flags land on its own command's row (the `eval` row is a union across eval subcommands, the registry's shape for every multi-subcommand command); a bare `command === 'X'` inside a non-`if` expression is deliberately not a marker. Only `import('./commands/*.ts')` inside a block counts as a command module (core helpers a block reaches for directly are not scanned — a flag the block consumes through one is already a literal in the block's own text), and `isValueOnlyImport` skips a destructured import whose bindings are all SCREAMING_CASE constants (a borrowed message string, not a handler). Pinned by `test/generate-flag-registry.test.ts` (acceptance AND rejection: `--frobnicate` is still refused) and `test/eval-longmemeval-cli-smoke.test.ts` (the documented `gbrain eval longmemeval … --retrieval-only --by-type --no-trajectory --keyword-only` invocation exits 0 as a subprocess).

- `src/schema.sql` — Full Postgres + pgvector DDL (source of truth, generates schema-embedded.generated.ts)

- `templates/` — SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md templates
