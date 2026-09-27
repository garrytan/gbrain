# CLAUDE.md

GBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable
engines: PGLite (embedded Postgres via WASM, zero-config default) or Postgres + pgvector
+ hybrid search in a managed Supabase instance. `gbrain init` defaults to PGLite;
suggests Supabase for 1000+ files. GStack teaches agents how to code. GBrain teaches
agents everything else: brain ops, signal detection, content ingestion, enrichment,
cron scheduling, reports, identity, and access control.

## North Star

gbrain aims to be the **next Postgres for memory**: the most well-tested, widest-coverage,
best-for-the-most-at-the-least retrieval + agent memory system for company brains and
personal AI, built to serve a billion people. Every feature and every eval is judged
against this bar. "gbrain is best" is a WHOLE-SYSTEM claim — proven across the full
BrainBench suite (retrieval, longmemeval, calibration, …) — not by any single feature.
When scoping an eval, prove the FEATURE delivers value to gbrain users; do not waste it
proving that gbrain's particular algorithm beats some other algorithm (a research
bake-off, off-mission).

## Two organizational axes (read this first)

GBrain knowledge is organized along two orthogonal axes. Users AND agents must
understand both, or queries misroute silently.

- **Brain** — WHICH DATABASE. Your personal brain is `host`. You can mount
  additional brains (team-published, each with their own DB and access policy)
  via `gbrain mounts add` (v0.19+). Routing: `--brain`, `GBRAIN_BRAIN_ID`,
  `.gbrain-mount` dotfile.
- **Source** — WHICH REPO INSIDE THE DATABASE. A brain can hold many sources
  (wiki, gstack, openclaw, essays). Slugs scope per source. Routing:
  `--source`, `GBRAIN_SOURCE`, `.gbrain-source` dotfile.

Both axes follow the same 6-tier resolution pattern. Read
`docs/architecture/brains-and-sources.md` for topology diagrams (personal, team
mount, CEO-class with multiple team brains) and
`skills/conventions/brain-routing.md` for the agent-facing decision table.

## Architecture

Contract-first: `src/core/operations.ts` defines 100+ shared operations (including `volunteer_context` — push-based context, see `docs/guides/push-context.md` — and the seven frozen MEMORY_VERBS `recall`/`remember`/`entity`/`synthesize`/`forget`/`context_pack`/`delta` — the last two are v0.45.7 ambient-recall boundary verbs (budget-packed pack + "what changed since"), all seven stamp `protocol_version: 1`, servable alone via `gbrain serve --surface verbs`, see `docs/protocol/MEMORY_VERBS_v1.md` + `docs/guides/ambient-recall.md`). CLI and MCP
server are both generated from this single source. Engine factory (`src/core/engine-factory.ts`)
dynamically imports the configured engine (`'pglite'` or `'postgres'`). Skills are fat
markdown files (tool-agnostic, work with both CLI and plugin contexts).

**Trust boundary:** `OperationContext.remote` distinguishes trusted local CLI callers
(`remote: false` set by `src/cli.ts`) from untrusted agent-facing callers
(`remote: true` set by `src/mcp/server.ts`). Security-sensitive operations like
`file_upload` tighten filesystem confinement when `remote=true` and default to
strict behavior when unset.

**Cross-cutting invariants (must-never-violate, regardless of which file you touch).**
These used to be buried across the per-file index; they live here so they always load.
Per-file detail is in `docs/architecture/KEY_FILES.md`.

- **Trust is fail-closed.** `OperationContext.remote` is REQUIRED on the type. Anything not
  strictly `false` is treated as remote/untrusted (`ctx.remote === false` for trusted-only
  sites; `ctx.remote !== false` for untrust-unless-explicit-false). Don't default it falsy.
- **Source isolation.** Every read-side op routes through `sourceScopeOpts(ctx)`; precedence
  is federated array (`ctx.auth.allowedSources`) > scalar (`ctx.sourceId`) > nothing. Don't
  hand-roll source filtering — a missed thread is a cross-source data leak. Corollary
  (unscoped-check/scoped-write): `engine.getPage` with no opts matches ANY source while
  `putPage` defaults to `'default'` — an existence check + write pair must scope the read
  to the write's source (`getPage(slug, { sourceId: x ?? 'default' })`). Guarded by
  `scripts/check-getpage-scoped-write.mjs` (opt-out marker
  `gbrain-allow-unscoped-getpage` for read-only first-match sites).
- **JSONB: never `JSON.stringify` into a `::jsonb` cast.** postgres.js double-encodes it (a jsonb
  string scalar); PGLite hides the bug. This bites BOTH spellings — the template form
  (`${JSON.stringify(x)}::jsonb`) AND the positional form (`executeRaw(\`…$N::jsonb\`, [JSON.stringify(x)])`,
  the #2339 class that aborted every sync). Fix: pass a raw object to `engine.executeRaw` / use
  `executeRawJsonb` / `sql.json()`; or for the positional path bind through `$N::text::jsonb` (binds as
  text, the cast parses it). Guarded by `scripts/check-jsonb-pattern.sh` (template grep) +
  `scripts/check-jsonb-params.mjs` (positional AST scanner); the real backstop is the DATABASE_URL-gated
  e2e parity tests, since PGLite can't surface the bug. Full rule in `docs/ENGINES.md`.
- **Engine-live paths avoid runtime dynamic `import()` for helper dependencies.** In
  `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, and
  `src/core/migrate.ts`, dependencies previously reached through runtime dynamic
  imports use static top-level imports. Besides the snapshot loader's lazy
  `require()` cluster in `pglite-engine.ts:tryLoadSnapshot` (fs/crypto + one
  gateway shape lookup — lazy so production builds without the test-fixture
  path don't eager-load; the snapshot hash reads migrate.ts/pglite-schema.ts
  FILE BYTES, never the loaded modules, so coverage instrumentation can't
  skew it; the guard now matches `require()` calls too), the only
  dynamic-`import()` exceptions
  are the four `ai/gateway.ts` lookups in both engines'
  `initSchema()` and `_upsertChunksOnce()` methods; each remains lazy inside a
  local `try/catch` because the gateway has a large provider/config closure and,
  more importantly, eager evaluation would occur before the catch and could
  turn a recoverable default/config-row fallback into a module-load failure.
  Every exception carries `engine-dynamic-import-ok` on the import line.
  `scripts/check-engine-dynamic-import.sh` enforces the rule. For history, use
  `git log -G'await[[:space:]]+import\\('`, not `git log -S`: a dynamic-to-static
  rewrite can preserve the searched token while changing its context.
- **Engine parity.** `src/core/postgres-engine.ts` and `src/core/pglite-engine.ts` move in
  lockstep — a new method/SQL shape lands in BOTH, pinned by `test/e2e/engine-parity.test.ts`.
  Forward-referenced columns/indexes go in the bootstrap probe set (guarded by
  `test/schema-bootstrap-coverage.test.ts`).
- **Contract-first.** `src/core/operations.ts` is the single source; CLI + MCP are generated
  from it. Every op carries `scope: 'read'|'write'|'admin'` + optional `localOnly`. HTTP
  dispatch enforces scope/localOnly before the handler runs.
- **Migrations.** Schema DDL lives in the `MIGRATIONS` array in `src/core/migrate.ts`.
  `CREATE INDEX CONCURRENTLY` needs `transaction: false` (pre-drop invalid remnants on
  Postgres; plain `CREATE INDEX` on PGLite via `sqlFor.pglite`).
- **Multi-source.** Slug uniqueness is `(source_id, slug)`, not slug. Key batch ops and
  reverse-writes on the composite key; `validateSourceId` before any `source_id` path join.
- **One canonical chat-pricing table.** All paid-cloud chat/completion prices live ONCE in
  `src/core/model-pricing.ts` (`CANONICAL_PRICING` + `canonicalLookup`). Every other table
  (`anthropic-pricing.ts`'s `ANTHROPIC_PRICING`, `takes-quality-eval/pricing.ts`'s
  `MODEL_PRICING`, the contradictions/cross-modal/skillopt cost views) is a DERIVED view, never
  a hand-copied duplicate — so cross-table price drift is structurally impossible. Update a
  price in `model-pricing.ts` only; each consumer keeps its own key allowlist + miss policy
  (fail-closed vs warn-only vs null), not its own numbers. Pinned by `test/model-pricing.test.ts`
  (drift guard asserts each view equals canonical). Embeddings price separately in
  `embedding-pricing.ts` (different unit).
- **Module-size ratchet.** `scripts/module-size-limits.tsv` pins per-file line ceilings
  (`check:module-size` in verify): growth over a ceiling, >50 lines of stale slack after a
  shrink, a row for a deleted file, and any UNLISTED src file over 1,500 lines all fail.
  Raise a ceiling only via a reviewer-visible TSV edit in the same commit; lower it in the
  same commit as any peel. migrate.ts is `region-exempt` (the MIGRATIONS array grows freely;
  the runner logic around it is ratcheted).
- **Peeled façades keep their surface.** operations.ts (`src/core/ops/*`), doctor.ts
  (`src/commands/doctor/*`), sync.ts (`src/core/sync-*`), skillpack.ts
  (`src/commands/skillpack/*`), and both engines
  (`src/core/{postgres,pglite}-engine/*`) are façades re-exporting everything they always
  exported — import sites and published package exports never chase the peel. New code goes
  in the module dirs, not back into the façades. Engine modules take narrow explicit deps
  (never an engine-shaped bag); doctor source-text guards read `test/helpers/doctor-source.ts`,
  and the flag-registry generator's `facadeExpansion` keeps peeled flag text in each command's
  scan surface.
- **Coverage is measured, honestly.** CI merges per-lane lcov (`scripts/merge-lcov.ts`) into
  a PR-corpus report on every run (advisory until the diff gate graduates via
  `COVERAGE_GATE_ENFORCE`) and a nightly fullCorpus number incl. the full e2e glob. bun
  facts: unique `--coverage-dir` per process (reuse overwrites lcov.info), line records only
  (JSC omits function names), no subprocess coverage (cli.ts is exempt as a documented
  undercount), never-loaded files are a count+list, never fake all-files math.


## Reference map (load on demand)

CLAUDE.md is the always-loaded orientation + dispatcher. Detailed reference loads
on demand — read the linked doc before working in that area. (Same two-layer
pattern gbrain ships for its own skills: thin router in `skills/RESOLVER.md`, fat
detail on demand.)

| When you're working on... | Read first |
|---|---|
| any file in `src/` (what it does + its invariants) | `docs/architecture/KEY_FILES.md` — choose the subsystem, then find the file's entry |
| search / ranking / hybrid / retrieval | `docs/architecture/RETRIEVAL.md` + the `search/*` entries in `KEY_FILES.md` |
| search modes / cost knobs | `docs/guides/search-modes.md` |
| engine detection / Postgres adoption / DB-access repair / degraded serve (`engine status`, `db-repair`, `init --prefer-postgres`, `GBRAIN_DB_ACCESS`) | `docs/ENGINES.md` ("Engine detection and access repair" + "Local Postgres") |
| embedding spend gates / cost gate / `spend.posture` / off switches | `docs/operations/spend-controls.md` |
| the monthly backup-coverage check (`gbrain backup`, render channels, nag budget) | `docs/operations/backup-check.md` + the `backup/*` entries in `KEY_FILES.md` |
| push-based context (volunteer/watch/reflex window) | `docs/guides/push-context.md` |
| checkpoint compaction / compiled context files (`gbrain compile-context`) | `docs/guides/checkpoint-compaction.md` + `docs/guides/ambient-recall.md` |
| ambient memory writeback (opt-in unprompted fact capture — `memory.auto_writeback`, harness instruction blocks, Stop-hook backstop, read-time TTL) | `docs/guides/ambient-writeback.md` + the ambient-writeback cluster in `KEY_FILES.md` |
| Memorable integration / session receipts / relay consent (`integrations.memorable.*`) | `docs/memorable-agents.md` + the hook-heartbeat/capture-spec/codex-hooks entries in `KEY_FILES.md` |
| chat connectors (live ChatGPT/Claude history sync — `gbrain connectors`) | `docs/guides/chat-connectors.md` + the `src/core/connectors/*` entries in `KEY_FILES.md` |
| schema packs / page types / extraction | `docs/architecture/schema-packs.md`, `type-taxonomy.md`, `lens-packs.md` |
| thin-client / remote MCP / cross-modal | `docs/architecture/thin-client.md` |
| publishing the brain's MCP server to other devices and agents (`gbrain mcp expose`, Tailscale default, Grok Bot / Muse hosted path) | `docs/guides/remote-mcp.md` + `docs/mcp/DEPLOY.md` + the `remote-mcp` skill |
| memory verbs / MCP tool surface (`--surface`) / conformance | `docs/protocol/MEMORY_VERBS_v1.md` + the `verbs*`/`surface.ts`/`protocol.ts` entries in `KEY_FILES.md` |
| the CLI surface (commands + flags) | `gbrain --help` / `gbrain --tools-json`, plus the relevant `KEY_FILES.md` entry |
| running or writing tests | `docs/TESTING.md` |
| bulk-command progress wiring | `docs/progress-events.md` |
| eval methodology / metrics | `docs/eval/` |
| brains vs sources / topology | `docs/architecture/brains-and-sources.md`, `topologies.md` |
| google connector (Gmail/Calendar/Contacts, OAuth) / credential vault | `docs/guides/google-connect.md` + the `creds/*` + `google/*` entries in `KEY_FILES.md` |
| open loops / `gbrain waiting` / commitment extraction | `docs/guides/open-loops.md` + the `loops*` entries in `KEY_FILES.md` |
| skill routing | `skills/RESOLVER.md` |
| agent bootstrap (paste-in install, hooks, `gbrain bootstrap`, sweep, keyless) | `docs/guides/bootstrap.md` + `docs/designs/AGENT_BOOTSTRAP_PLAN.md` + the KEY_FILES bootstrap cluster |
| shipping a release / CHANGELOG / PR conventions | `docs/RELEASING.md` (ship IRON RULES stay inline below) |

The per-file index (`## Key files`), the thin-client routing seam, and the testing
discipline used to live inline here. They moved to the docs above so this file
stays small enough to load every session. Nothing was lost — the pre-move content
is in git, and the docs carry every load-bearing invariant (compressed to
current-state).

## Maintaining CLAUDE.md and the reference docs

CLAUDE.md grew to ~592KB / ~147k tokens once the per-file index became append-only
(one `**vX.Y.Z:**` clause per release per file). That is the exact anti-pattern
gbrain exists to fix. The rules that keep it from recurring:

- **CLAUDE.md is orientation, not the implementation spec.** It carries the North
  Star, the two axes, architecture + cross-cutting invariants, the resolver, and
  the inline IRON RULES. Per-file/per-command/per-test detail lives in the
  reference docs and loads on demand.
- **Reference docs (`key-files/*.md`, `thin-client.md`, `TESTING.md`) describe
  CURRENT behavior only.** Release history goes in `CHANGELOG.md` + git. Do NOT
  append `**vX.Y.Z (#NNN):**` clauses, codex/review tags, or "pre-fix/then/was-now"
  narration. When a file's behavior changes, UPDATE its entry to the new truth.
- **CI is the enforcement, not this prose.** `scripts/check-key-files-current-state.sh`
  (in `bun run verify`) fails on the bolded-release-clause marker in the reference
  docs AND on size caps for CLAUDE, README, the index, and each subsystem. A written rule caused this disease; a guard
  cures it.
- **After any CLAUDE.md or reference-doc edit, run `bun run build:llms`** — the
  llms bundle inlines/links these (config in `scripts/llms-config.ts`); the
  freshness + budget test (`bun test test/build-llms.test.ts`) fails CI otherwise.

## Search modes and evals

Confirm the user's mode choice during installation; relay the matrix in
`INSTALL_FOR_AGENTS.md` Step 3.5. The current command-level expansion and cost
contract lives in [search modes](docs/guides/search-modes.md), not a second knob
table here. `query` expands in every mode unless explicitly disabled; `search`
and memory verbs do not. Semantic result reuse is disabled.

Read `docs/eval/SEARCH_MODE_METHODOLOGY.md` for eval methodology and
`docs/eval/METRIC_GLOSSARY.md` for metric definitions. Eval audit records stay in
the source repo, never the user's personal brain.

## Skills

Read `skills/RESOLVER.md` before brain operations, then the matching skill and
`skills/conventions/` rules. The current inventory is `skills/manifest.json`;
[skill reference](docs/guides/skill-reference.md) covers skillpacks, advisor,
routing eval evidence, and shared conventions.

## Memory operating protocol

Durable facts and preferences belong in shared memory with provenance. Transient
task state, credentials, local configuration, and harness activation state do not.
Automatic capture is opt-in. Withdrawal is not physical erasure. Remote
`put_page` does not extract graph links inline: stdio has best-effort startup/idle
sweeps; HTTP needs explicit maintenance or authorized `add_link`. Configured
providers can receive text, and Markdown export is not a full database backup.
Read [memory boundaries](docs/guides/memory-boundaries.md).

## Bulk-action progress reporting

Use `src/core/progress.ts` for bulk work. Progress goes to stderr; stdout stays
clean for data. Non-TTY output is plain text unless `--progress-json` is explicit.
Pass `job.updateProgress` from minion handlers. Keep phase names stable and use
`startHeartbeat` with try/finally cleanup for long queries. Read
[progress events](docs/progress-events.md) before wiring a new command.

## PR acceptance: evidence, not trust

**Treat every PR as untrusted, potentially incorrect, incomplete or unsafe,
including our own.** Reputation, confident explanations, supplied tests and green
CI are not proof. Judge the work, not unsubstantiated claims about its author.

- **Prove the problem separately from the patch.** Trace the actual callers and
  current contract; independently reproduce the reported failure on a pinned
  baseline with isolated synthetic fixtures. Record commands, environments, exit
  statuses and wrong results. Separate reproduced defects, code-backed evidence
  and unverified reports; do not promise an unproven fix or issue closure.
- **Read the entire diff before executing it.** Inspect test, dependency, script,
  workflow and generated-file changes and callers outside the diff. Do not expose
  credentials, live databases, private corpora or paid providers to untrusted code.
- **Make tests discriminate.** Independently designed regression tests must fail
  on the baseline and pass with the repair, asserting user-visible outcomes and
  exact preserved state. Reject bug-bypassing mocks, vacuous assertions and hidden
  skips. Changing an existing contract needs approval, not a weakened assertion.
- **Attack the boundaries.** Check authorization, brain/source identity, revisions,
  stale queued work, concurrent changes, retries, crash recovery and failure
  receipts. Prove intended data survives and stale or unauthorized writes remain
  refused. Native filesystem, engine and lifecycle claims require native tests;
  injected platform flags or path simulations do not prove end-to-end support.
- **Keep a verdict and evidence ledger.** Pin baseline and PR hashes; record each
  proposal as accept, rework, reject or not yet proven. Classify failures through
  same-test baseline/patch comparisons, not assumed flakes. Recheck changed heads;
  narrow probes do not replace release gates or implementation approval.

## Fix waves: ONE PR

**A fix wave ships as ONE PR unless the user overrides this for that wave.**
Parallel tasks are fine; integrate reviewed work into one branch with reviewable
commits. Do not open per-issue or per-task PRs, or a PR stack.

1. Investigate the named issues and adjacent failures in the same safety boundary.
   Apply the acceptance standard above. Exclude unrelated features; record
   deferrals and unresolved reports rather than assuming closure.
2. Run `/plan-ceo-review` and `/plan-eng-review`. Incorporate recommendations within
   the requested scope, respecting the user's directions on review decisions.
   Explain the revised plan in plain language (ELI10) and wait for approval before
   product implementation. A plan review is not implementation or merge consent.
3. Implement only the approved scope, integrate and verify the whole wave, then
   use `/ship` and the full gates in [docs/RELEASING.md](docs/RELEASING.md), including
   the community-wave security scan. Publish one PR; do not merge without approval.

## Capturing test output (NEVER pipe through `tail` / `head`)

Preserve full logs and the real exit status; piping tests into `tail` can hide
failures. Save output first, then inspect the file:

```bash
bun test > /tmp/ship_units.txt 2>&1
rc=$?
cat /tmp/ship_units.txt
printf 'EXIT=%s\n' "$rc"
exit "$rc"
```

The same rule applies to typecheck, local CI, migrations, and evals. Keep every
failure for triage; do not report a green check from truncated output.

## Sync and backfill pacing

Read [backfill pacing](docs/operations/backfill-pacing.md) before tuning sync locks,
checkpoint resume, or DB-contention-aware pace mode.

## Build

`bun build --compile --no-compile-autoload-bunfig --outfile bin/gbrain src/cli.ts`

## Version locations (single source of truth: `VERSION` file)

Every release updates the required version stamps in the table below.
Update TODOS only when filing new work, not to rewrite old entries. Keep these in sync. `/ship` enforces this via Step 12's idempotency check (VERSION vs
package.json drift), but the canonical list lives here so future runs and
the auto-update agent know where to look.

**Version format is mandatory: `MAJOR.MINOR.PATCH.MICRO` (four numeric
segments, dot-separated, no leading `v`).** Every new release MUST use the
4-segment form. The `.MICRO` slot is the dot-suffix follow-up channel: when
a release ships its commit subject ahead of its VERSION bump (e.g. PR #795
landing as `v0.31.4` without bumping the file), the corrective ship lands
as `0.31.4.1` rather than churning the patch number to `0.31.5`. Suffixes
like `-fixwave` are still allowed as needed (`0.31.1.1-fixwave`), but the
four numeric segments are required first. Historical 3-segment versions
(`0.31.3`, `0.22.1`) remain valid in `git log` and migration filenames
(`skills/migrations/v0.21.0.md`); do NOT rewrite them. Going forward only.

**Required (every release must update every row):**

| File | What lives there | Format |
|---|---|---|
| `VERSION` | The single source of truth. Read first by `/ship`, the binary, and CI version-gate. | Bare 4-segment string `MAJOR.MINOR.PATCH.MICRO` (e.g. `0.31.4.1`), no leading `v`. |
| `package.json` | Bun/npm package version. `gbrain --version` reads it via the compiled binary's bundled package metadata. CI version-gate cross-checks this against `VERSION` and fails if they drift. | `"version": "0.31.4.1"` |
| `CHANGELOG.md` | Top entry header `## [0.31.4.1] - YYYY-MM-DD` plus the "To take advantage of v0.31.4.1" block. | Standard Keep-a-Changelog header. |
| `TODOS.md` | Any TODO entries that mention "follow-up from vX.Y.Z.W" use the version of the release that filed them. Update only when filing NEW follow-up TODOs. | Inline `vX.Y.Z.W` references in TODO bodies. |
| `openclaw.plugin.json` | OpenClaw plugin manifest (v0.45.6.0, #4033). Hand-maintained; `test/openclaw-plugin-manifest.test.ts` fails the suite if it drifts from `package.json`. Merges from master auto-resolve it to master's version — re-bump it with the trio. | `"version": "0.45.12.0"` |
| `.codex-plugin/plugin.json` + `.claude-plugin/plugin.json` | Codex + Claude Code plugin manifests. Hand-maintained; `test/codex-plugin-manifest.test.ts` fails the suite when either drifts from `package.json` (the bump is now a FIVE-file lockstep: VERSION, package.json, openclaw.plugin.json, and both plugin manifests). Merges from master auto-resolve them to master's version — re-bump with the version set. | `"version": "0.46.7.0"` |
| `BOOTSTRAP_FOR_AGENTS.md` | Runbook stamp on line 1. `scripts/check-bootstrap-tag.sh` (in `bun run verify` + CI) fails when it drifts from `VERSION`; refresh it in the same commit as the bump. | `<!-- gbrain-runbook-stamp: X.Y.Z.W -->` |
| `templates/bootstrap/template-repo/` | Vendored template tree with an embedded version stamp. Auto-derived, but NOT by `bun install`: run `bun run scripts/generate-template-repo.ts --out templates/bootstrap/template-repo` after the bump; `scripts/check-bootstrap-templates.sh` fails CI on drift. | `<!-- gbrain-template-stamp: X.Y.Z.W -->` in generated files. |

**Auto-derived (no manual edit; refreshed by their own commands):**

- `plugin/` + `plugin-variants/` — the committed codex/claude plugin skill
  tree AND the persona variant trees (gbrain-coding, gbrain-daily) embed a
  `gbrain-plugin-tree-stamp: X.Y.Z.W` (the variants' generated plugin
  manifests carry the version too), so every version bump drifts them.
  Regenerate after the bump: `bun run scripts/generate-plugin-tree.ts --out
  plugin --variants-out plugin-variants` (guarded by
  `scripts/check-plugin-tree.sh` in `bun run verify`; the release
  `publish-codex-plugin` job also drift-gates it before publishing).
- `bun.lock` — root-package version is auto-pinned from `package.json`. After
  bumping `package.json`, run `bun install` to refresh the lockfile.
- `llms-full.txt` / `llms.txt` — auto-generated documentation bundles. **Any
  CLAUDE.md edit MUST be followed by `bun run build:llms` in the same commit
  (or a follow-up commit before push).** The committed bundles are checked
  against fresh generator output by `test/build-llms.test.ts`, which runs in
  CI shard 1. If you edited CLAUDE.md and didn't regenerate, CI will fail.
  This has bitten the wave 3 times — every CLAUDE.md edit gets a `bun run
  build:llms` chaser, no exceptions. (The `verify` gate doesn't run this
  test; only the full unit suite does. So `bun run typecheck` clean is NOT
  enough to know you can push after a CLAUDE.md edit.)

**Historical (DO NOT bump on release):**

- `skills/migrations/v0.21.0.md` — migration files use the version they
  shipped FROM as their filename. v0.21.0's migration always says v0.21.0.
- `src/commands/migrations/v0_21_0.ts` — same: migration code references
  the schema version it migrates to.
- `test/migrations-v0_21_0.test.ts`, `test/migration-orchestrator-v0_21_0.test.ts`,
  `test/migrate.test.ts` — migration tests reference historical migration
  versions; these are correct as-is and should not move.
- `src/core/db.ts`, `src/core/migrate.ts`, `src/core/import-file.ts`,
  `src/commands/reindex-code.ts` — code comments cite the release that
  introduced a feature. Once written, these are historical record.
- `README.md` — references the latest published feature names by version
  (e.g. "v0.21.0 Code Cathedral"); update only when the README's marketing
  copy is intentionally being refreshed, NOT on every micro/patch bump.

**The /ship workflow's version idempotency check:** Step 12 reads
`VERSION` and `package.json`, classifies as FRESH / ALREADY_BUMPED /
DRIFT_STALE_PKG / DRIFT_UNEXPECTED, and refuses to proceed on
DRIFT_UNEXPECTED. This is why the two must move together.

**Auto-renumber when needed; never ask.** Use `/ship`'s queue-aware allocator,
update all version stamps and the PR title, then report the number. This overrides
its ALREADY_BUMPED rebump prompt, not scope, merge or deployment approvals.
CI rejects mismatched `VERSION`/`package.json` or versions not newer than master.

### Version consistency and conflict recovery

After version-related edits or merges, verify `VERSION`, `package.json`, and the
top CHANGELOG entry agree before proceeding. Read the [version recovery checklist](docs/contributing/version-recovery.md)
for conflict resolution and the pre-push audit. Historical versions stay historical.

## Conductor branch-name = workspace-name (IRON RULE)

In a Conductor workspace, the branch tail must match the workspace directory
name before shipping or creating a PR. Check `basename "$PWD"` against
`git branch --show-current`. Use the ship workflow to resolve a mismatch; do not
silently rename unrelated branches or delete remote branches.

## Releasing

Before shipping, read [docs/RELEASING.md](docs/RELEASING.md) in full and use `/ship`.
**Never hand-roll ship operations.** It owns version allocation, CHANGELOG,
review, test coverage, and release documentation. Scope and consent still apply:
shipping instructions do not authorize a merge, deployment, or release the user
has excluded. Community waves also require `bun run wave-security-scan <base>..<head>`.

## Post-ship requirements (MANDATORY)

Run `/document-release` after every `/ship`; the ship workflow's automatic run
counts, but a skipped/failed run must be completed. Check README, the relevant
`docs/architecture/key-files/` entries, guides, CHANGELOG, and TODOS. Update
CLAUDE only for always-loaded rules or routing changes. It is a map, not a log;
per-file current behavior belongs in subsystem references, release history in
CHANGELOG and Git.

## "Say to your agent" rule: every feature doc addresses the END USER (IRON RULE)

Public feature docs need 1–3 natural-language prompts alongside CLI examples:
`**Say to your agent:** *"<outcome the user wants>"*`. When a skill backs the
feature, use phrases from its actual frontmatter triggers. For CLI-only features,
name the command the agent will run rather than implying an unavailable skill.
Use generic placeholders. A reader should know what to ask without translating
flags into prose.

## Privacy rule: scrub real names from public docs

**Never reference real people, companies, funds, or private agent names in any
public-facing artifact.** Public artifacts include: `CHANGELOG.md`, `README.md`,
`docs/`, `skills/`, PR titles + bodies, commit messages, and comments in checked-in
code. Query examples, benchmark stories, and migration guides MUST use generic
placeholders.

Why: gbrain runs a personal knowledge brain containing notes on real people and
real companies (YC founders, portfolio companies, funds, investors, meeting
attendees). When a doc copies a query like `gbrain graph diana-hu --depth 2` or
names a specific agent fork like `Wintermute`, that real name gets indexed by
search engines, surfaced in cross-references, and distributed with every release.

**Name mapping** to use in examples:
- Agent forks → `your agent fork`, `a downstream agent`, or `agent-fork`
- Example person → `alice-example`, `charlie-example`, or `a-founder`
- Example company → `acme-example`, `widget-co`, or `a-company`
- Example fund → `fund-a`, `fund-b`, `fund-c`
- Example deal → `acme-seed`, `widget-series-a`
- Example meeting → `meetings/2026-04-03` (generic date is fine)
- Example user → `you` or `the user`, never a proper name

**Specific rule: never say `Wintermute` in any CHANGELOG, README, doc, PR, or
commit message.** When the temptation is to illustrate with the real fork name:
- Reader-facing copy → `your OpenClaw` (covers Wintermute, Hermes, AlphaClaw,
  and any other downstream OpenClaw deployment in one term the reader already
  recognizes).
- First-person / origin-story copy → `Garry's OpenClaw` (honest that this is
  the production deployment driving the feature, without exposing the private
  agent's name).

`Wintermute` may appear in private artifacts (scratch plans under
`~/.gstack/projects/…`, memory files, conversation transcripts, CEO-review
plans) — those aren't distributed. Anything checked into this repo or shipped
in a release must use the OpenClaw phrasing above. Sweeping a stale reference
is a small clean-up PR, not a debate.

**When in doubt, ask yourself:** "Would this query reveal private information
about the user's contacts, investments, or portfolio if it were read by a
stranger?" If yes, replace with generic placeholders.

**Illustrative API examples with household-brand companies** (Stripe, Brex, OpenAI,
GitHub, etc.) are fine — they're public entities, not contacts in anyone's brain.
Do not confuse illustrative API examples with queries that reveal real
relationships.

## Responsible-disclosure rule: don't broadcast attack surface in release notes

Describe security fixes functionally in public artifacts. Do not publish a
curated list of sensitive tables, affected records, or exposure windows that
helps probe unpatched installs. Describe the mechanism, upgrade/repair commands,
and user impact; keep detailed exposure analysis in private investigation
artifacts. A reader should learn how to update, not how to target old installs.
This applies to README, CHANGELOG, docs, PRs, commits, issues, and release pages.

## PR title format — version FIRST (IRON RULE)

PR titles and version-bump commit subjects start with the version, followed by
the conventional-commit subject:

```
vMAJOR.MINOR.PATCH.MICRO <type>(<scope>): <summary> (#issue or wave ref)
```

Put the version first, never parenthesized at the end. Apply this when creating
or editing a PR through the host's supported workflow.

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

## Shared knowledge and skills

New local brains keep knowledge and a useful memory skillpack in one recorded content
root. Shared publication, own-principal following and editing have separate authority;
ordinary memory writes never imply skill editing or script execution. Native router
installation is not proof of native use. Read
[shared brain skills](docs/guides/shared-brain-skills.md) and its
[key-file contracts](docs/architecture/key-files/shared-skills.md) before changing this lifecycle.
