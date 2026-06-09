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

Contract-first: `src/core/operations.ts` defines ~47 shared operations (v0.29 adds `get_recent_salience`, `find_anomalies`, `get_recent_transcripts`). CLI and MCP
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
  hand-roll source filtering — a missed thread is a cross-source data leak.
- **JSONB: never `JSON.stringify` into a `::jsonb` cast.** postgres.js double-encodes it;
  PGLite hides the bug. Pass raw objects to `engine.executeRaw`, or use `executeRawJsonb`.
  Guarded by `scripts/check-jsonb-pattern.sh`.
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


## Reference map (load on demand)

CLAUDE.md is the always-loaded orientation + dispatcher. Detailed reference loads
on demand — read the linked doc before working in that area. (Same two-layer
pattern gbrain ships for its own skills: thin router in `skills/RESOLVER.md`, fat
detail on demand.)

| When you're working on... | Read first |
|---|---|
| any file in `src/` (what it does + its invariants) | `docs/architecture/KEY_FILES.md` — find the file's entry |
| search / ranking / hybrid / retrieval | `docs/architecture/RETRIEVAL.md` + the `search/*` entries in `KEY_FILES.md` |
| search modes / cost knobs | `docs/guides/search-modes.md` |
| schema packs / page types / extraction | `docs/architecture/schema-packs.md`, `type-taxonomy.md`, `lens-packs.md` |
| thin-client / remote MCP / cross-modal | `docs/architecture/thin-client.md` |
| the CLI surface (commands + flags) | `gbrain --help` / `gbrain --tools-json`, plus the relevant `KEY_FILES.md` entry |
| running or writing tests | `docs/TESTING.md` |
| bulk-command progress wiring | `docs/progress-events.md` |
| eval methodology / metrics | `docs/eval/` |
| brains vs sources / topology | `docs/architecture/brains-and-sources.md`, `topologies.md` |
| skill routing | `skills/RESOLVER.md` |
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
- **Reference docs (`KEY_FILES.md`, `thin-client.md`, `TESTING.md`) describe
  CURRENT behavior only.** Release history goes in `CHANGELOG.md` + git. Do NOT
  append `**vX.Y.Z (#NNN):**` clauses, codex/review tags, or "pre-fix/then/was-now"
  narration. When a file's behavior changes, UPDATE its entry to the new truth.
- **CI is the enforcement, not this prose.** `scripts/check-key-files-current-state.sh`
  (in `bun run verify`) fails on the bolded-release-clause marker in the reference
  docs AND on a CLAUDE.md size cap. A written rule caused this disease; a guard
  cures it.
- **After any CLAUDE.md or reference-doc edit, run `bun run build:llms`** — the
  llms bundle inlines/links these (config in `scripts/llms-config.ts`); the
  freshness + budget test (`bun test test/build-llms.test.ts`) fails CI otherwise.

## Search Mode (v0.32.3)

GBrain ships three named search modes that bundle the search-lite knobs from
PR #897 into a single config key. Pick one at install time; the rest of the
project resolves through `src/core/search/mode.ts`.

| Knob                          | `conservative` | `balanced` | `tokenmax`     |
|-------------------------------|----------------|------------|----------------|
| `cache.enabled`               | true           | true       | true           |
| `cache.similarity_threshold`  | 0.92           | 0.92       | 0.92           |
| `cache.ttl_seconds`           | 3600           | 3600       | 3600           |
| `intentWeighting`             | true           | true       | true           |
| `tokenBudget`                 | **4000**       | **12000**  | **off**        |
| `expansion` (LLM multi-query) | false          | false      | **true**       |
| `relationalRetrieval`         | false          | **true**   | **true**       |
| `searchLimit` default         | 10             | 25         | 50             |

**Cost anchors (downstream agent input cost — gbrain itself is rounding error).**
The corner-to-corner spread is 25x once you pair mode with downstream model.
Chunks ~400 tokens avg. Per-query cost @ 10K queries/month (typical
single-user volume), full search payload, no cache savings:

| Mode \ Downstream | Haiku 4.5 (\$1/M) | Sonnet 4.6 (\$3/M) | Opus 4.7 (\$5/M) |
|---|---|---|---|
| conservative (~4K) | **\$40/mo** | \$120/mo | \$200/mo |
| balanced (~10K) | \$100/mo | \$300/mo | \$500/mo |
| tokenmax (~20K) | \$200/mo | \$600/mo | **\$1,000/mo** |

Scales linearly: multiply by 10 for 100K/mo (heavy power user / multi-user
fleet); divide by 10 for 1K/mo (light usage). Natural pairings span ~4x.
Mismatches (tokenmax+Haiku, conservative+Opus) waste capacity differently
— too-big payload overwhelms a cheap model; too-small payload starves an
expensive one.

tokenmax adds ~\$1.50 per 1K queries in Haiku expansion calls on top of
the matrix (\$15/mo @ 10K). Cache hits cut all numbers ~50%. **The cost
picker copy in `gbrain init` carries the same matrix verbatim** — update
both when refreshing.

**Per-query math vs real-world spend.** The matrix above is what an
isolated benchmark would measure. Real agent loops with disciplined
Anthropic prompt caching see 50-80% discount on top (cache hits skip
downstream entirely). The realistic-scale anchor in
`docs/eval/SEARCH_MODE_METHODOLOGY.md` walks the natural pairings at
single-power-user volume (~860 turns/mo): tokenmax+Opus ~\$700/mo,
balanced+Sonnet ~\$430/mo, conservative+Haiku ~\$170/mo. Setups WITHOUT
cache-aware prompt layout (frequent prefix churn) see the per-query
matrix dominate — mode + model choice matters more there.

**Resolution chain** (matches the v0.31.12 model-tier pattern at
`src/core/model-config.ts:resolveModel`):

    per-call SearchOpts → per-key config (search.cache.enabled, …) →
      MODE_BUNDLES[search.mode] → MODE_BUNDLES.balanced (fallback)

Mode resolution lives in **bare `hybridSearch`** (NOT just the cached wrapper)
per `[CDX-5+6]` in `~/.claude/plans/lets-take-a-look-validated-parrot.md` — so
`gbrain eval replay` and `gbrain eval longmemeval` test the same mode-affected
behavior as the production `query` op.

**Cache-key contamination hotfix `[CDX-4]`:** migration v56 added a
`knobs_hash` column to `query_cache`. The lookup filter is now
`WHERE source_id = $ AND knobs_hash = $ AND embedding similarity < $` so a
tokenmax write (expansion=on, limit=50) can't be served to a conservative
read.

**v0.36.3.0 knobs_hash v=2 → v=3.** The hash now folds the active
embedding column name + provider into the cache key, so a query routed
through `embedding_voyage` (1024d Voyage) can't be served a cache row
written against `embedding` (1536d OpenAI). Existing v=2 rows become
unreachable on first re-query (one-time miss spike on upgrade);
`mode.ts:KNOBS_HASH_VERSION` is the single source of truth.

**v0.42.34.0 knobs_hash v=9 → v=10.** Folds the `relationalRetrieval` knob +
depth into the cache key so a relational-on result set can't be served to a
relational-off lookup (same contamination class as graph_signals). One-time
miss spike on upgrade.

**Relational retrieval (v0.42.34.0).** `relationalRetrieval` (on for
balanced/tokenmax) adds a fourth recall arm: a relational query ("who invested
in X", "what connects A and B") resolves its seed entity and walks the typed-edge
graph (`src/core/search/relational-recall.ts` + `relational-intent.ts`,
`engine.relationalFanout`), injecting edge-derived answers into RRF. Within-source,
deterministic, mentions-excluded by default, pure no-op for non-relational queries.
The `query` op's `relational` flag forces it on/off per call.

**Three CLI surfaces:**

    gbrain search modes              # what is running, with per-knob attribution
    gbrain search modes --reset      # clear search.* overrides (mode bundle wins)
    gbrain search stats [--days N]   # cache hit rate, intent mix, budget drops
    gbrain search tune [--apply]     # data-driven recommendations

The install picker fires inside `gbrain init` AFTER `engine.initSchema()`
(non-TTY auto-selects). The upgrade banner fires once via `runPostUpgrade`
in `src/commands/upgrade.ts`, gated by `search.mode_upgrade_notice_shown`.

## Eval discipline (v0.32.3)

Every metric printed by any `gbrain eval *` or `gbrain search stats` command
resolves through `src/core/eval/metric-glossary.ts` so industry terms
(`P@k`, `nDCG@k`, `MRR`, `Jaccard@k`) carry a plain-English line in human
output and a `_meta.metric_glossary` block in JSON output (one block per
response per `[CDX-25]`, NOT sibling `_gloss` fields).

The full methodology — datasets, sample selection, pre-registered
expectations, threats to validity, paired-bootstrap + Bonferroni p-value
discipline `[CDX-14]` — lives in `docs/eval/SEARCH_MODE_METHODOLOGY.md`.
Auto-regenerated `docs/eval/METRIC_GLOSSARY.md` is CI-guarded against
drift (`scripts/check-eval-glossary-fresh.sh`).

Per-run records land at `<repo>/.gbrain-evals/eval-results.jsonl` per
`[CDX-23]`. The user's personal `~/.gbrain` brain is NEVER touched —
audit trail lives in the source repo's git history.

## Skills

Read the skill files in `skills/` before doing brain operations. GBrain ships 29 skills
organized by `skills/RESOLVER.md` (`AGENTS.md` is also accepted as of v0.19):

**Original 8 (conformance-migrated):** ingest (thin router), query, maintain, enrich,
briefing, migrate, setup, publish.

**Brain skills (ported from an upstream agent fork):** signal-detector, brain-ops, idea-ingest, media-ingest,
meeting-ingestion, citation-fixer, repo-architecture, skill-creator, daily-task-manager.

**Operational + identity:** daily-task-prep, cross-modal-review, cron-scheduler, reports,
testing, soul-audit, webhook-transforms, data-research, minion-orchestrator. As of
v0.20.4, `minion-orchestrator` is the single unified skill for both lanes of background
work (shell jobs via `gbrain jobs submit shell`, LLM subagents via `gbrain agent run`) ...
the prior `gbrain-jobs` skill was merged in, Preconditions are shared, and trigger
routing is narrowed to what the skill actually covers.

**Skillify loop (v0.19):** skillify (the markdown orchestration), skillpack-check
(agent-readable health report).

**Routing-table compression (v0.32.3.0):** `skills/functional-area-resolver/` —
two-layer dispatch pattern for shrinking large AGENTS.md / RESOLVER.md files
(>=12KB) without losing routing accuracy. Replaces one row per skill with one
entry per functional area, where each area declares its sub-skills in a
`(dispatcher for: ...)` clause. The static-prompt analog of hierarchical agent
routing (AnyTool [arXiv:2402.04253](https://arxiv.org/abs/2402.04253), RAG-MCP
[arXiv:2505.03275](https://arxiv.org/html/2505.03275v1), Anthropic Agent Skills
progressive disclosure). Empirically validated across Opus 4.7 / Sonnet 4.6 /
Haiku 4.5: +13 to +17pp over the verbose baseline at 48% the size (25KB → 13KB
on a real fork). The `(dispatcher for: ...)` clause is the load-bearing signal
— strip it and lenient accuracy collapses to 41.7% on Sonnet (the
`resolver-of-resolvers` ablation case). A/B eval surface lives at
`evals/functional-area-resolver/` (outside `skills/` deliberately so the
skillpack bundler doesn't ship eval infrastructure to downstream installs):
gateway-routed TypeScript harness, 20 training + 5 held-out fixtures, strict +
lenient scoring, three committed cross-model receipts in `baseline-runs/`.
Receipt header binds (model, prompt_template_hash, fixtures_hash, harness_sha,
ts) so future contributors can verify reproduction. Companion `rescore.mjs`
re-scores existing JSONL with lenient tolerance for zero API cost. Reproduce
with `cd evals/functional-area-resolver && node harness.mjs --model
{opus|sonnet|haiku}` (~$0.30–1.70 per model). Nine v0.33.x follow-up TODOs
filed for held-out corpus growth, cross-vendor verification, hierarchical
area-of-areas, embedding-based pre-router, and the run-1 vs run-2
prompt-design ablation methodology.

**Operational health (v0.19.1):** smoke-test (8 post-restart health checks with auto-fix
for Bun, CLI, DB, worker, Zod CJS, gateway, API key, brain repo; user-extensible via
`~/.gbrain/smoke-tests.d/*.sh`).

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.

## Bulk-action progress reporting

All bulk commands (doctor, embed, import, export, sync, extract, migrate,
repair-jsonb, orphans, check-backlinks, lint, integrity auto, eval, files
sync, and apply-migrations) stream progress through the shared reporter
at `src/core/progress.ts`. Agents get heartbeats within 1 second of every
iteration regardless of how slow the underlying work is.

Rules:
- Progress always writes to **stderr**. Stdout stays clean for data output
  (`--json` payloads, final summaries, JSON action events from `extract`).
- Non-TTY default: plain one-line-per-event human text. JSON requires the
  explicit `--progress-json` flag.
- Global flags (`--quiet`, `--progress-json`, `--progress-interval=<ms>`)
  are parsed by `src/core/cli-options.ts` BEFORE command dispatch.
- Phase names are machine-stable `snake_case.dot.path` (e.g.
  `doctor.db_checks`, `sync.imports`). Documented in
  `docs/progress-events.md`; additive changes only.
- `scripts/check-progress-to-stdout.sh` is a CI guard that fails the build
  if any new code writes `\r` progress to stdout. Wired into `bun run test`.
- Minion handlers pass `job.updateProgress` as the `onProgress` callback
  to core functions (DB-backed primary progress channel); stderr from
  `jobs work` stays coarse for daemon liveness only.

When wiring a new bulk command: `import { createProgress } from '../core/progress.ts'`
and `import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts'`.
Create a reporter with `createProgress(cliOptsToProgressOptions(getCliOptions()))`,
`start(phase, total?)` before the loop, `tick()` inside it, `finish()` after.
For single long-running queries, use `startHeartbeat(reporter, note)` with a
try/finally to guarantee cleanup. Never call `process.stdout.write('\r...')`
in bulk paths, the CI guard will fail the build.

## Capturing test output (NEVER pipe through `tail` / `head`)

**Iron rule:** when running `bun test`, `bun run test:e2e`, `bun run typecheck`,
or any other test/check command, redirect to a file FIRST, then `tail` the file
separately:

```bash
# RIGHT — full output preserved, real exit code visible
bun test > /tmp/ship_units.txt 2>&1
echo "EXIT=$?"
tail -50 /tmp/ship_units.txt
grep -E '(fail\)|✗|error:' /tmp/ship_units.txt | head -30
```

```bash
# WRONG — exit code is `tail`'s (always 0), failures truncated, ship gates fail open
bun test 2>&1 | tail -10
```

The pipe form silently breaks /ship Step T1 (test failure ownership triage) and
the test verification gate (Step 16) because:
- `$?` after a pipe is the LAST command's exit code (`tail` → 0), not bun's
- bun prints failure details before the summary line, so `tail -N` drops them
- Step T1 needs the full failure list to classify in-branch vs pre-existing

This bit us during v0.26.2 ship: `bun test 2>&1 | tail -10` reported "3911 pass / 23 fail"
but no failure details survived, forcing a 23-minute re-run to triage.

Apply the same pattern to any long-running command whose exit code matters:
`bun run typecheck`, `bun run ci:local`, migration runs, eval suites, etc.
For background tasks (`run_in_background: true`), the harness captures the exit
file separately — use it via the bg task's `<id>.exit` file, not the streamed
output.

## Sync resumability + lock tuning (v0.42.x, #1794)

`gbrain sync` is resumable and converges under pool exhaustion + repeated kills.
Progress banks into the append-only `op_checkpoint_paths` table (one row per drained
path, written via the direct session pool so it survives `EMAXCONNSESSION`); a killed
run resumes from the checkpoint and `last_commit` only advances on true completion. The
per-source lock heartbeats through the direct pool and refuses to steal a live,
recently-refreshed holder. Five env knobs tune it (all env-only, incident-time escape
hatches — no config-dashboard surface by design):

| Env var | Default | What it does |
|---|---|---|
| `GBRAIN_SYNC_CHECKPOINT_EVERY` | 1000 | Flush the checkpoint every N drained files. |
| `GBRAIN_SYNC_CHECKPOINT_SECONDS` | 10 | Also flush every N seconds (whichever comes first) — bounds worst-case loss regardless of throughput. Flush also fires after the first file. |
| `GBRAIN_SYNC_MAX_CHECKPOINT_FAILURES` | 3 | Consecutive failed flushes (each already retried ~12s) before the run aborts with `reason: 'checkpoint_unavailable'` instead of importing work it can never bank. |
| `GBRAIN_SYNC_YIELD_EVERY` | 64 | Yield the event loop (`setTimeout(0)`, NOT `setImmediate` — Bun starves the timers phase under a tight setImmediate loop) every N files so the lock-refresh `setInterval` heartbeat fires mid-import. |
| `GBRAIN_LOCK_STEAL_GRACE_SECONDS` | derived (~600 at 30min TTL) | A holder that refreshed within this window is NOT stolen even if its TTL lapsed (starved-but-alive). Dead holders stop refreshing, age past the grace, and become stealable; TTL stays the backstop. |

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Version locations (single source of truth: `VERSION` file)

Every release advances the version in **five files at once**. Keep these in
sync. `/ship` enforces this via Step 12's idempotency check (VERSION vs
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

**Required (every release must update all five):**

| File | What lives there | Format |
|---|---|---|
| `VERSION` | The single source of truth. Read first by `/ship`, the binary, and CI version-gate. | Bare 4-segment string `MAJOR.MINOR.PATCH.MICRO` (e.g. `0.31.4.1`), no leading `v`. |
| `package.json` | Bun/npm package version. `gbrain --version` reads it via the compiled binary's bundled package metadata. CI version-gate cross-checks this against `VERSION` and fails if they drift. | `"version": "0.31.4.1"` |
| `CHANGELOG.md` | Top entry header `## [0.31.4.1] - YYYY-MM-DD` plus the "To take advantage of v0.31.4.1" block. | Standard Keep-a-Changelog header. |
| `TODOS.md` | Any TODO entries that mention "follow-up from vX.Y.Z.W" use the version of the release that filed them. Update only when filing NEW follow-up TODOs. | Inline `vX.Y.Z.W` references in TODO bodies. |
| `CLAUDE.md` | The Key Files section's per-file annotations carry `vX.Y.Z.W (#NNN)` tags noting which release introduced a behavior. Update whenever a wave's annotations get folded in. | Inline `vX.Y.Z.W (#NNN, contributed by @user)` references. |

**Auto-derived (no manual edit; refreshed by their own commands):**

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

**The CI version-gate** rejects pushes where `VERSION` and
`package.json` disagree, OR where `VERSION` is not strictly greater
than master's VERSION. If a queue collision claims your version on
master before yours lands, /ship's queue-aware allocator (Step 12)
will detect drift and re-bump on the next run.

### Mandatory version-consistency audit (run after EVERY merge or commit that touches VERSION, package.json, or CHANGELOG)

**The trio MUST agree.** Every merge from master will hit conflicts on
VERSION + package.json + CHANGELOG.md because master ships its own
version bumps. Auto-merge sometimes resolves these silently in unexpected
ways. After any merge, branch update, or version-related edit, run this
audit. It's three lines and never lies:

```bash
echo "VERSION:     $(cat VERSION)"
echo "package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
grep -E "^## \[" CHANGELOG.md | head -1
```

All three MUST show the same `MAJOR.MINOR.PATCH.MICRO`. If any one
disagrees, you have not finished the merge. Fix it before pushing or
shipping. There is no situation in which "I'll fix it next push" is OK,
because:

- A green local test run with mismatched VERSION/package.json still
  fails the CI version-gate.
- A green CHANGELOG entry under the wrong version header silently lies
  to release-notes consumers.
- /ship's Step 12 idempotency check classifies a mismatch as
  `DRIFT_UNEXPECTED` and HALTS — but only if you remember to run /ship
  before pushing. Manual `git push` skips the check.

### Merge-conflict recovery procedure (memorize this)

When `git merge origin/master` reports conflicts on VERSION,
package.json, or CHANGELOG.md, resolve in this exact order:

1. **VERSION** — overwrite with the wave's version (`echo -n "X.Y.Z.W"
   > VERSION`). Highest semver wins; do NOT take master's lower version.
2. **package.json** — strip the conflict markers, keep the wave's
   version line. Sed pattern:
   `sed -i.bak '/^<<<<<<< HEAD$/d; /^=======$/,/^>>>>>>> /d' package.json && rm package.json.bak`
   (assumes ours is above the `=======`).
3. **CHANGELOG.md** — strip ALL three conflict markers; both your entry
   and master's entry stay. Sed pattern:
   `sed -i.bak '/^<<<<<<< HEAD$/d; /^=======$/d; /^>>>>>>> origin\/master$/d' CHANGELOG.md && rm CHANGELOG.md.bak`
   Then verify your entry is the topmost `## [X.Y.Z.W]` and master's
   newer-than-yours entries (if any) sit below.
4. **Run the 3-line audit above.** If it doesn't show your version on
   all three lines, you missed a marker.
5. **Run `bun install`** to refresh `bun.lock` against the resolved
   `package.json`. Stage and commit if it changed.
6. **Run `bun run typecheck`** before committing the merge.
7. Only THEN run `git commit` for the merge.

If the audit shows drift after step 4, do NOT proceed to step 5. Re-run
steps 1-3 against the actual file content; you missed a marker or
resolved one in the wrong direction.

**Anti-pattern to avoid:** Resolving via `git checkout --ours package.json`
and `git checkout --theirs scripts/test-shard.sh` mixed in the same
commit. The selective directional resolution is fine, but on
VERSION/package.json/CHANGELOG specifically, ALWAYS use the explicit
`echo > VERSION` + sed-strip-markers pattern above. The directional
checkout flags have bitten us when the conflict shape was unexpected
(e.g. master stripped a section we expected to keep).

### Pre-push gate (manual; tighten when you remember to)

Before any `git push` of a merge commit, run the audit one more time:

```bash
echo "VERSION:     $(cat VERSION)"
echo "package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
grep -E "^## \[" CHANGELOG.md | head -1
```

If you've been editing the branch via `/ship` you can rely on Step 12's
idempotency check. If you've been editing manually (merge resolution,
conflict fix, version bump), the audit is the last line of defense
before CI yells at you.

## Conductor branch-name = workspace-name (IRON RULE)

Conductor workspaces expect the git branch name to match the workspace
directory name. When they disagree, Conductor silently fails to render the
PR view + show ship state, leading to "did you actually push?" confusion.

**Check this FIRST on every ship and BEFORE creating any PR:**

```bash
WORKSPACE=$(basename "$PWD")              # e.g. puebla-v4
BRANCH=$(git branch --show-current)        # e.g. garrytan/gstack-requests
case "$BRANCH" in
  */"$WORKSPACE") echo "OK: branch tail matches workspace" ;;
  "$WORKSPACE")   echo "OK: branch == workspace" ;;
  *)              echo "MISMATCH: branch=$BRANCH workspace=$WORKSPACE — RENAME BEFORE SHIPPING" ;;
esac
```

If MISMATCH (branch is `garrytan/foo` but workspace is `puebla-v4`):

```bash
# Rename local, push under new name, delete old remote (and old PR if it
# was already created — github auto-closes it when head ref dies).
git branch -m garrytan/<workspace-name>
git push -u origin garrytan/<workspace-name>
git push origin --delete <old-branch-name>
# If a PR existed against the old branch:
#   gh pr comment <old-pr> --body "Superseded by #<new>: branch renamed to match Conductor workspace."
#   gh pr create --base master --title "..." --body "..."  # recreate from renamed branch
```

Caught the hard way on v0.41.9.0 ship: workspace `puebla-v4` but branch
`garrytan/gstack-requests` produced PR #1439 that Conductor wouldn't
display. Renamed to `garrytan/puebla-v4`; recreated as #1440.

The /ship workflow's Step 1 should be augmented to run the mismatch
check; until that lands upstream, ALWAYS run the check above before
`/ship` invokes its first push or PR-create step.


## Releasing

Before any ship, read **[docs/RELEASING.md](docs/RELEASING.md)** in full. It carries the
full release + contributor process: pre-ship test requirements (`bun run ci:local` / the
E2E lifecycle), the CHANGELOG voice + release-summary template, the "To take advantage of
vX" self-repair block, version migrations, the GitHub Actions SHA refresh, PR conventions,
and the community-PR-wave process. **Use `/ship` — never hand-roll a release.**

The ship-critical IRON RULES stay inline in this file (do NOT relocate them): the
Version-locations table above (the 5-file sync + the 3-line VERSION/package.json/CHANGELOG
audit), the Conductor branch=workspace rule (above), Post-ship `/document-release` (below),
the Privacy + Responsible-disclosure rules (below), and the PR-title-version-first rule
(below).

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

A ship without updated docs is an incomplete ship. Period.


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

**When a release fixes a security gap or a user-impacting bug, describe the fix
functionally. Do not enumerate the attack surface, quantify the exposure window,
or highlight the most sensitive records by name in public-facing artifacts.**

Public-facing artifacts include: `CHANGELOG.md`, `README.md`, `docs/`, PR titles
and bodies, commit messages, GitHub issue titles and comments, release pages,
tweets, blog posts.

**Don't write:**
- "10 tables were publicly readable by the anon key for months, including X, Y, Z"
- "X and Y are the most sensitive ones"
- "N tables exposed. Fix: enable RLS on these specific tables: ..."

**Do write:**
- "Security hardening pass. Fresh installs secure by default. Existing brains
  brought to the same bar automatically on upgrade."
- "If `gbrain doctor` still flags anything after upgrade, the message names each
  table and gives the exact fix."

Why: anyone reading the release page before they've upgraded now has a directed
probe list for unpatched installs. The source code ships the specifics anyway
(`src/schema.sql`, `src/core/migrate.ts`, test fixtures) — reverse engineers can
get them. But the release page is a broadcast channel. Don't hand attackers a
curated list with a banner.

**The test:** if a reader with no prior context could read the release note and
walk away knowing "gbrain at version X has table Y readable by anon key until
they patch," the note is too specific. Rewrite until that's no longer possible.

**What IS fine in public artifacts:**
- The mechanism of the fix ("the check now scans every public table instead of
  a hardcoded allowlist").
- User-facing operator ergonomics (the escape-hatch SQL template, the upgrade
  commands, the breaking-change flag).
- Credit to contributors.
- Generic framing of severity ("security posture tightening pass") without
  quantification.

**What stays in private artifacts (plan files, private memories, internal docs):**
- Specific table names, record counts, exposure duration.
- Which records stand out as highest-risk.
- Detailed before/after tables in the "numbers that matter" format.

If the CEO/Eng review of a plan produces a detailed exposure table, keep it in
the plan file under `~/.claude/plans/` or `~/.gstack/projects/`. Don't copy it
into the CHANGELOG or PR body.

Applies retroactively: if you see a prior CHANGELOG entry naming attack-surface
specifics, scrub it as a small cleanup commit, the same way a stale Wintermute
reference gets swept.


## PR title format — version FIRST (IRON RULE)

**Every PR title MUST start with the version, then the conventional-commit subject:**

```
vMAJOR.MINOR.PATCH.MICRO <type>(<scope>): <summary> (#issue or wave ref)
```

Example (correct): `v0.42.3.0 feat(search): autocut — score-discontinuity result-sizing (#1663 wave 1)`

The version goes at the **BEGINNING**, never the end. This matches the repo's
commit-subject convention (`git log` shows `v0.41.38.0 fix: ...`,
`v0.42.1.0 feat: ...`) so the PR list, the merge commit, and the changelog all
read version-first. A title with the version parenthesized at the end
(`feat(search): autocut ... (v0.42.3.0)`) is WRONG — fix it with
`gh pr edit <N> --title "vX.Y.Z.W <type>: <summary>"`.

This applies to `gh pr create` and every `gh pr edit --title`. When `/ship`
(or any flow) sets a PR title, the version is the first token. Same rule for the
final commit subject that carries the version bump.


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
