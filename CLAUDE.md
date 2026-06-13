# CLAUDE.md

MBrain is a personal knowledge brain. It now ships in two truthful runtime profiles: managed Postgres + pgvector, or a fully local/offline SQLite profile with the same CLI/MCP contract.

## Architecture

Contract-first: `src/core/operations.ts` defines ~30 shared operations. CLI and MCP
server are both generated from this single source. Skills are fat markdown files
(tool-agnostic, work with both CLI and plugin contexts). The engine is selected at
runtime (`postgres` or `sqlite`), while offline profile policy controls what stays
available in local mode versus what must fail with honest guidance.

## Key files

- `src/core/operations.ts` — Contract-first operation definitions (the foundation)
- `src/core/operations-agent-session-memory.ts` — Agent/session memory preview and capture operations
- `src/core/operations-agent-session-activation.ts` — Agent-session activation planning operation
- `src/core/engine.ts` — Pluggable engine interface (BrainEngine)
- `src/core/pg-engine-base.ts` — Shared SQL logic for both Postgres-dialect engines (PgEngineBase + PgQueryable transport seam)
- `src/core/postgres-engine.ts` — Postgres + pgvector transport (postgres.js) over PgEngineBase
- `src/core/sqlite-engine.ts` — SQLite engine for local/offline mode
- `src/core/engine-factory.ts` — Config resolution + engine selection (`postgres` vs `sqlite`)
- `src/core/offline-profile.ts` — Honest capability gating for local/offline mode
- `src/core/embedding/provider.ts` — Local embedding runtime integration + availability reporting
- `src/core/db.ts` — Postgres connection management, schema initialization
- `src/core/services/agent-session-memory-service.ts` — Agent session normalization, source refs, and redacted capture planning
- `src/core/services/agent-session-compression-service.ts` — Zero-LLM agent session compression and bounded summaries
- `src/core/services/agent-session-classifier-service.ts` — MBrain-native profile/episode/procedure/task/no-write signal classification
- `src/core/services/agent-session-writeback-service.ts` — Governed Memory Inbox routing and preflighted direct personal writes for session signals
- `src/core/services/agent-session-activation-service.ts` — Authority-labelled activation artifacts for session-derived memory
- `src/core/services/agent-session-capture-envelope-service.ts` — Hook-friendly JSON/JSONL envelope normalization for session capture + Claude Code stop-hook transcript adapter (`parseClaudeCodeTranscript`)
- `src/core/services/agent-session-activation-planner-service.ts` — Authority-aware activation planning for future agent sessions
- `src/core/services/agent-session-maintenance-service.ts` — Session-derived candidate review and recurrence maintenance helpers
- `src/commands/agent-session.ts` — File-based preview/capture command for real session payloads
- `src/core/source-registry/raw-ingest-store.ts` — SQL-backed raw ingest persistence helper for source items, chunks, redaction, and flags
- `src/core/import-file.ts` — importFromFile + importFromContent (chunk + embed + tags)
- `src/core/sync.ts` — Pure sync functions (manifest parsing, filtering, slug conversion)
- `src/core/storage.ts` — Pluggable storage interface (S3, Supabase Storage, local)
- `src/core/supabase-admin.ts` — Supabase admin API (project discovery, pgvector check)
- `src/core/file-resolver.ts` — MIME detection, content hashing for file uploads
- `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided)
- `src/core/search/` — Hybrid search: vector + keyword + RRF + heuristic/local query expansion + dedup
- `src/core/embedding.ts` — Embedding pipeline orchestration
- `src/mcp/server.ts` — MCP stdio server (generated from operations)
- `supabase/functions/mbrain-mcp/index.ts` — Remote MCP server (Supabase Edge Function)
- `src/edge-entry.ts` — Curated bundle entry point for Edge Function (excludes fs-dependent modules)
- `src/commands/auth.ts` — Standalone token management (create/list/revoke/test)
- `src/commands/setup-agent.ts` — Auto-detect Claude Code/Codex, register MCP, inject agent rules
- `src/commands/setup-agent-autopilot.ts` — OS-scheduler registration (launchd/cron) for the daily candidate-only dream cycle, installed by `setup-agent --apply` (skip with `--no-autopilot`)
- `docs/MBRAIN_AGENT_RULES.md` — Compact behavioral rules for AI agents (injected by setup-agent)
- `docs/MCP_INSTRUCTIONS.md` — Documentation copy of the `MCP_INSTRUCTIONS` constant returned by the server in `InitializeResult` (runtime source: `src/core/operations.ts`)
- `skills/codemap-ingest/SKILL.md` — Technical knowledge map workflow for system pages + codemap-backed concepts
- `src/core/schema-embedded.ts` — AUTO-GENERATED from schema.sql (run `bun run build:schema`)
- `src/schema.sql` — Full Postgres + pgvector DDL (source of truth, generates schema-embedded.ts)
- `scripts/deploy-remote.sh` — One-script remote MCP deployment
- `docs/mcp/` — Remote/hosted per-client setup guides (Claude Desktop, Code, Cowork, Perplexity, ChatGPT)
- `docs/local-offline.md` — Local/offline SQLite + Codex/Claude Code setup guide (English)
- `docs/local-offline.ko.md` — Local/offline SQLite + Codex/Claude Code setup guide (Korean)
- `skills/_brain-filing-rules.md` — Cross-cutting brain filing rules (referenced by all brain-writing skills)
- `docs/UPSTREAM_SYNC.md` — Historical/reference log for optional upstream cherry-picks from `garrytan/gbrain`. Consult it when evaluating upstream imports, not for routine `mbrain` feature work.
- `openclaw.plugin.json` — ClawHub bundle plugin manifest
- `src/core/auto-promote/verdict.ts` — `PromotionVerdict` type + fail-closed JSON parser
- `src/core/auto-promote/config.ts` — `AutoPromoteConfig` + safe defaults (disabled by default)
- `src/core/auto-promote/candidate-selector.ts` — deterministic eligibility bucketing for promotion candidates
- `src/core/auto-promote/prompt.ts` — judge-only review prompt builder
- `src/core/auto-promote/cli-executor.ts` — claude/codex subprocess executor (fills the `RestrictedRunnerExecutor` seam)
- `src/core/auto-promote/promote-gate.ts` — deterministic gate: promotes confident verdicts, records canonical handoffs, and writes page-backed canonical notes through `put_page`
- `src/core/auto-promote/service.ts` — `runAutoPromote` orchestrator: select → judge (cached) → escalate → gate
- `src/core/types/auto-promote.ts` — `AutoPromoteVerdictKey` / `AutoPromoteVerdictRow` types
- `src/commands/auto-promote.ts` — `mbrain auto-promote` CLI command (`runAutoPromoteCommand`); default dry-run, `--apply` to mutate; config-gated (`auto_promote.enabled`, default off)

## Commands

Run `mbrain --help` or `mbrain --tools-json` for full command reference. For local/offline contributors: `mbrain init --local` writes the SQLite/offline profile, `mbrain serve` is the stdio MCP entrypoint both Codex and Claude Code consume, and `mbrain setup-agent` auto-detects installed AI clients, registers the MCP server, and injects behavioral rules. User-facing local setup docs now live in both `docs/local-offline.md` and `docs/local-offline.ko.md`.

Deterministic brain-quality tools (no LLM calls, no DB connection, engine-agnostic): `mbrain publish` renders a brain page as a self-contained HTML (optionally AES-256-GCM encrypted behind a password), `mbrain check-backlinks check|fix` enforces the Iron Law of Back-Linking across a brain directory, `mbrain lint` flags LLM preambles, broken frontmatter, and placeholder dates (use `--fix` to auto-clean), and `mbrain report --type <name>` saves a timestamped report into `brain/reports/{type}/YYYY-MM-DD-HHMM.md`.

`mbrain auto-promote --digest` saves a dry-run/apply digest report (promotable counts, exclusions grouped by reason) into `brain/reports/auto-promote-digest/` via `saveBrainReport` from `src/commands/report.ts`. `mbrain auto-promote` runs a judge-only LLM verdict on eligible Memory Inbox candidates and, when confidence is high enough, the deterministic gate advances/promotes the inbox rows, records canonical handoff rows, and writes page-backed canonical notes through the existing `put_page` governance path (default dry-run; pass `--apply` to mutate). The command is config-gated (`auto_promote.enabled`, default off), excludes open contradictions by default, and rechecks target content hashes before canonical page writes. Candidates carry a verification record (`verify_memory_candidate_entry` / `mbrain verify-memory-candidate`): refuted candidates are excluded from auto-promotion and denied at promotion preflight, verified candidates clear the revalidation defer and upgrade risky (inferred/ambiguous) extraction to the canonical-eligible lane, and `auto_promote.eligibility.require_verification` (default off) restricts the canonical lane to verified candidates only. A dream phase `auto_promote` (order 15) also exists in the dream cycle and is wired into `mbrain dream` / autopilot dream runs when local runner use is explicitly allowed.

## Testing

`bun test` runs the repo test suite. Unit tests run without a database. Postgres-backed E2E coverage skips gracefully when `DATABASE_URL` is not set.

Unit tests include `test/sqlite-engine.test.ts` (SQLite engine parity), `test/local-offline.test.ts` (offline profile + local embedding/rewrite semantics), `test/markdown.test.ts` (frontmatter parsing), `test/chunkers/recursive.test.ts` (chunking), `test/sync.test.ts` (sync logic), `test/parity.test.ts` (operations contract parity), `test/cli.test.ts` (CLI structure), `test/config.test.ts` (config resolution), `test/files.test.ts` / `test/file-migration.test.ts` / `test/file-resolver.test.ts` (storage + file handling), `test/import-file.test.ts` / `test/import-resume.test.ts` (import pipeline), `test/upgrade.test.ts`, `test/doctor.test.ts`, `test/migrate.test.ts`, `test/setup-branching.test.ts`, `test/slug-validation.test.ts`, `test/storage.test.ts`, `test/supabase-admin.test.ts`, `test/yaml-lite.test.ts`, `test/check-update.test.ts`, `test/init-config-guard.test.ts` (init overwrite guard + E2E config-isolation fence), `test/connection-failure-detail.test.ts` (DB connection error cause preservation), and `test/health-beacon.test.ts` (sync watch failure marker + `sync --clear-failure` CLI dispatch). Agent-session follow-up tests: `test/agent-session-capture-envelope-service.test.ts`, `test/agent-session-transcript-adapter.test.ts`, `test/agent-session-cli.test.ts`, `test/agent-session-activation-planner-service.test.ts`, `test/agent-session-activation-operations.test.ts`, `test/agent-session-maintenance-service.test.ts`, and `test/scenarios/s33-agent-session-memory-loop.test.ts`. Auto-promote unit tests: `test/auto-promote/{runner-policy-promotion,verdict,config,candidate-selector,prompt,cli-executor,verdict-cache,promote-gate,service,dream-phase,cli,digest}.test.ts`; migration v48 adds the `auto_promote_verdicts` verdict-cache table (Postgres/PGLite and SQLite). Candidate verification (verify gate) tests: `test/memory-inbox-verification.test.ts`; migration v53 adds verification fields (status/method/evidence/source refs/verified_at) to `memory_candidate_entries` on all engines. JSON-serialization regression fences: `test/postgres-jsonb-engine.test.ts` (Postgres, needs `DATABASE_URL`; also a dedicated `postgres-jsonb` CI job), `test/pglite-jsonb-engine.test.ts` and `test/sqlite-json-engine.test.ts` (no database required — same double-encoding trap fenced on the other two engines). `test/workflow-config.test.ts` pins the CI contract (macOS unit job at PR time, release smoke gate, action SHA pins).

E2E tests (`test/e2e/`): Run against real Postgres+pgvector. Require `DATABASE_URL`.
- `bun run test:e2e` runs Tier 1 (mechanical, all operations, no API keys)
- `test/e2e/upgrade.test.ts` runs check-update E2E against real GitHub API (network required)
- `test/e2e/auto-promote.test.ts` — PGLite pipeline E2E; real-CLI path gated behind `MBRAIN_E2E_REAL_CLI`
- Tier 2 (`skills.test.ts`) requires OpenClaw + API keys, runs nightly in CI
- If `.env.testing` doesn't exist in this directory, check sibling worktrees for one:
  `find ../  -maxdepth 2 -name .env.testing -print -quit` and copy it here if found.
- Always run E2E tests when they exist. Do not skip them just because DATABASE_URL
  is not set. Start the test DB, run the tests, then tear it down.

### API keys and running ALL tests

ALWAYS source the user's shell profile before running tests:

```bash
source ~/.zshrc 2>/dev/null || true
```

This loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Without these, Tier 2 tests
skip silently. Do NOT skip Tier 2 tests just because they require API keys — load
the keys and run them.

When asked to "run all E2E tests" or "run tests", that means ALL tiers:
- Tier 1: `bun run test:e2e` (mechanical, sync, upgrade — no API keys needed)
- Tier 2: `test/e2e/skills.test.ts` (requires OpenAI + Anthropic + openclaw CLI)
- Always spin up the test DB, source zshrc, run everything, tear down.

### E2E test DB lifecycle (ALWAYS follow this)

You are responsible for spinning up and tearing down the test Postgres container.
Do not leave containers running after tests. Do not skip E2E tests.

1. **Check for `.env.testing`** — if missing, copy from sibling worktree.
   Read it to get the DATABASE_URL (it has the port number).
2. **Check if the port is free:**
   `docker ps --filter "publish=PORT"` — if another container is on that port,
   pick a different port (try 5435, 5436, 5437) and start on that one instead.
3. **Start the test DB:**
   ```bash
   docker run -d --name mbrain-test-pg \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=mbrain_test \
     -p PORT:5432 pgvector/pgvector:pg16
   ```
   Wait for ready: `docker exec mbrain-test-pg pg_isready -U postgres`
4. **Run E2E tests:**
   `DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/mbrain_test bun run test:e2e`
5. **Tear down immediately after tests finish (pass or fail):**
   `docker stop mbrain-test-pg && docker rm mbrain-test-pg`

Never leave `mbrain-test-pg` running. If you find a stale one from a previous run,
stop and remove it before starting a new one.

## Skills

Read the skill files in `skills/` before doing brain operations. They contain the
workflows, heuristics, and quality rules for ingestion, querying, maintenance,
enrichment, technical codemap ingest, and setup. 8 skills: ingest, query,
codemap-ingest, maintain, enrich, briefing, migrate, setup.

## Build

`bun build --compile --outfile bin/mbrain src/cli.ts`

## Pre-ship requirements

Before shipping (/ship) or reviewing (/review), always run the full test suite:
- `bun test` — unit tests (no database required)
- Follow the "E2E test DB lifecycle" steps above to spin up the test DB,
  run `bun run test:e2e`, then tear it down.

Both must pass. Do not ship with failing E2E tests. Do not skip E2E tests.

## Post-ship requirements (MANDATORY)

After EVERY /ship, you MUST run /document-release. This is NOT optional. Do NOT
skip it. Do NOT say "docs look fine" without running it. The skill reads every .md
file in the project, cross-references the diff, and updates anything that drifted.

If /ship's Step 8.5 triggers document-release automatically, that counts. But if
it gets skipped for ANY reason (timeout, error, oversight), you MUST run it manually
before considering the ship complete.

Files that MUST be checked on every ship:
- README.md — does it reflect new features, commands, or setup steps?
- CLAUDE.md — does it reflect new files, test files, or architecture changes?
- CHANGELOG.md — does it cover every commit?
- TODOS.md — are completed items marked done?
- docs/ — do any guides need updating?
- Durable memory note — if the ship changes architecture, commands, setup,
  retrieval, governance, or agent workflows, check whether MBrain self-brain
  pages (`personal/mbrain/*`) are stale; record the needed follow-up or why no
  brain-page update is needed.

A ship without updated docs is an incomplete ship. Period.

## CHANGELOG voice

CHANGELOG.md is read by agents during auto-update (Section 17). The agent summarizes
the changelog to convince the user to upgrade. Write changelog entries that sell the
upgrade, not document the implementation.

- Lead with what the user can now DO that they couldn't before
- Frame as benefits and capabilities, not files changed or code written
- Make the user think "hell yeah, I want that"
- Bad: "Added MBRAIN_VERIFY.md installation verification runbook"
- Good: "Your agent now verifies the entire MBrain installation end-to-end, catching
  silent sync failures and stale embeddings before they bite you"
- Bad: "Setup skill Phase H and Phase I added"
- Good: "New installs automatically set up live sync so your brain never falls behind"

## Version migrations

Create a migration file at `skills/migrations/v[version].md` when a release
includes changes that existing users need to act on. The auto-update agent
reads these files post-upgrade (Section 17, Step 4) and executes them.

**You need a migration file when:**
- New setup step that existing installs don't have (e.g., v0.5.0 added live sync,
  existing users need to set it up, not just new installs)
- New SKILLPACK section with a MUST ADD setup requirement
- Schema changes that require `mbrain init` or manual SQL
- Changed defaults that affect existing behavior
- Deprecated commands or flags that need replacement
- New verification steps that should run on existing installs
- New cron jobs or background processes that should be registered

**You do NOT need a migration file when:**
- Bug fixes with no behavior changes
- Documentation-only improvements (the agent re-reads docs automatically)
- New optional features that don't affect existing setups
- Performance improvements that are transparent

**The key test:** if an existing user upgrades and does nothing else, will their
brain work worse than before? If yes, migration file. If no, skip it.

Write migration files as agent instructions, not technical notes. Tell the agent
what to do, step by step, with exact commands. See `skills/migrations/v0.5.0.md`
for the pattern.

## Schema state tracking

`~/.mbrain/update-state.json` tracks which recommended schema directories the user
adopted, declined, or added custom. The auto-update agent (SKILLPACK Section 17)
reads this during upgrades to suggest new schema additions without re-suggesting
things the user already declined. The setup skill writes the initial state during
Phase C/E. Never modify a user's custom directories or re-suggest declined ones.

## GitHub Actions SHA maintenance

All GitHub Actions in `.github/workflows/` are pinned to commit SHAs. Before shipping
(`/ship`) or reviewing (`/review`), check for stale pins and update them:

```bash
for action in actions/checkout oven-sh/setup-bun actions/upload-artifact actions/download-artifact softprops/action-gh-release gitleaks/gitleaks-action; do
  tag=$(grep -r "$action@" .github/workflows/ | head -1 | grep -o '#.*' | tr -d '# ')
  [ -n "$tag" ] && echo "$action@$tag: $(gh api repos/$action/git/ref/tags/$tag --jq .object.sha 2>/dev/null)"
done
```

If any SHA differs from what's in the workflow files, update the pin and version comment.

## Community PR wave process

Never merge external PRs directly into master. Instead, use the "fix wave" workflow:

1. **Categorize** — group PRs by theme (bug fixes, features, infra, docs)
2. **Deduplicate** — if two PRs fix the same thing, pick the one that changes fewer
   lines. Close the other with a note pointing to the winner.
3. **Collector branch** — create a feature branch (e.g. `garrytan/fix-wave-N`), cherry-pick
   or manually re-implement the best fixes from each PR. Do NOT merge PR branches directly —
   read the diff, understand the fix, and write it yourself if needed.
4. **Test the wave** — verify with `bun test && bun run test:e2e` (full E2E lifecycle).
   Every fix in the wave must have test coverage.
5. **Close with context** — every closed PR gets a comment explaining why and what (if
   anything) supersedes it. Contributors did real work; respect that with clear communication
   and thank them.
6. **Ship as one PR** — single PR to master with all attributions preserved via
   `Co-Authored-By:` trailers. Include a summary of what merged and what closed.

**Community PR guardrails:**
- Always AskUserQuestion before accepting commits that touch voice, tone, or
  promotional material (README intro, CHANGELOG voice, skill templates).
- Never auto-merge PRs that remove YC references or "neutralize" the founder perspective.
- Preserve contributor attribution in commit messages.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

**NEVER hand-roll ship operations.** Do not manually run git commit + push + gh pr
create when /ship is available. /ship handles VERSION bump, CHANGELOG, document-release,
pre-landing review, test coverage audit, and adversarial review. Manually creating a PR
skips all of these. If the user says "commit and ship", "push and ship", "bisect and
ship", or any combination that ends with shipping — invoke /ship and let it handle
everything including the commits. If the branch name contains a version (e.g.
`v0.5-live-sync`), /ship should use that version for the bump.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR, "commit and ship", "push and ship" → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
