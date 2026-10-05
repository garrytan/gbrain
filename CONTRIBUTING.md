# Contributing to GBrain

## Setup

```bash
git clone https://github.com/garrytan/gbrain.git
cd gbrain
bun install --frozen-lockfile && bun run test && bun run verify
```

`bun run test` is the parallel unit loop; `bun run verify` is CI's guard
battery. [`docs/TESTING.md`](docs/TESTING.md#quick-start) covers E2E, failure
logs and the lanes.

Requires Bun 1.4.0 or newer, matching `package.json`.

### Windows

`bun run test`, `verify`, `ci:local` and `test:e2e` all dispatch through bash, so
the shell scripts under `scripts/` must be checked out with Unix line endings.
The root `.gitattributes` pins `*.sh text eol=lf`, which overrides the
`core.autocrlf=true` that Git for Windows installs by default. A fresh clone is
correct with no extra steps.

`.gitattributes` pins `*.md text eol=lf` for the same reason. The frontmatter
readers anchor on a `---` fence followed by a Unix line ending, so a CRLF
checkout makes a well-formed document parse as having no frontmatter. That
failure is silent: no error, the field just comes back empty.

If you cloned before either pin existed, your working copy still has the old
Windows line endings. Bash will fail with `$'\r': command not found`, and
frontmatter will read as absent. Refresh it once, from the repository root:

```bash
git rm --cached -r . -q
git reset --hard
bash -n scripts/run-unit-parallel.sh          # silence means bash can read the scripts
git ls-files --eol -- '*.md' | grep -cE 'w/(crlf|mixed)' # 0 means Markdown is clean
```

Every `check:*` entry in `package.json` invokes its script as `bash scripts/<name>.sh`
rather than relying on the shebang, because bun on Windows cannot exec a `.sh`
directly. Keep that prefix when you add a new shell-script check.

## Project structure

```
src/
  cli.ts                  CLI entry point: op dispatch + the ordered CLI-only pipeline (handleCliOnly)
  cli/
    command-table.ts      One record per CLI-only command (phase, thin-client mode, lazy loader)
    commands/             Per-command dispatch modules each record loads (glue only)
  commands/               CLI-only command implementations (init, upgrade, import, export, etc.)
    doctor.ts             gbrain doctor façade (flag parse, registry run, output)
    doctor/               registry.ts (ordered check registry) + checks/<topic>.ts entries
    sync.ts               gbrain sync façade (re-exports performSync, performFullSync, ...)
    sync/                 Sync implementation: SyncRun state + phases (preflight, deletes, renames, imports, finalize)
    jobs.ts, jobs/        gbrain jobs façade (subcommand table, registerBuiltinHandlers) + one module per subcommand
    serve-http.ts         HTTP server: buildServeHttpApp (shared context, mount order) + listen/shutdown
    serve-http-<area>.ts  mount<Area>(app, ctx) route modules (oauth, metrics, admin-api, spa, mcp, webhooks)
    autopilot*.ts         Autopilot mode table, daemon tick steps, dispatch, probes
    migrations/           Versioned upgrade orchestrators (vX.Y.Z, gbrain apply-migrations)
  core/
    operations.ts         Operation contract assembly (façade over ops/)
    ops/                  Contract types + security fences + the op domain modules
    engine.ts             BrainEngine interface
    engine-factory.ts     Engine factory (dynamic import of the configured engine)
    postgres-engine.ts    Postgres + pgvector implementation (façade; migrated domains delegate to engine-sql/)
    postgres-engine/      Postgres-only modules (cancellation, init-schema lock)
    pglite-engine.ts      PGLite (embedded Postgres via WASM) implementation (façade)
    pglite-engine/        PGLite-only modules (checkpoint guard, dialect-specific reads)
    engine-sql/           One SQL implementation per migrated storage domain: executor, dialect adapters,
                          sqlFragment, RLS read brands, row normalizer, forward-reference bootstrap
    migrate.ts            Schema-migration runner (re-exports MIGRATIONS from the generated registry)
    schema-migrations/    One file per schema migration (v<NNN>-<name>.ts) + registry.generated.ts
    pglite-schema.ts      Façade over the generated PGLite schema template (pglite-schema.generated.ts)
    doctor-categories.ts  The single doctor check category authority
    page-state/           Canonical snapshots, revisions, versions and guarded projections
    persistence/          Durable requests, owner coordination, recovery and writer enforcement
    db.ts                 Connection management + schema loader
    import-file.ts        Import pipeline (chunk + embed + tags)
    sync-*.ts             Reusable sync clusters (cost-gate, git, anchor, lock, reconcile, status-report, ...)
    minions/              Job queue + worker; handlers/ holds one module per built-in job handler
    types.ts              TypeScript types
    markdown.ts           Frontmatter parsing
    config.ts             Config file management
    storage.ts            Pluggable blob storage interface
    storage/              Blob storage backends (S3, Supabase, local)
    supabase-admin.ts     Supabase admin API
    file-resolver.ts      MIME detection + content hashing
    sql-query.ts          Scalar-only tagged SQL for OAuth/admin/auth tables (sqlQueryForEngine)
    bootstrap/            Agent-bootstrap flow (interview, hooks, repo, verify)
    yaml-lite.ts          Lightweight YAML parser
    chunkers/             3-tier chunking (recursive, semantic, llm)
    search/               Hybrid search: hybrid.ts runs the named stages in hybrid/ (request, arms, rank, cache)
    embedding.ts          Embedding service (provider-routed; Voyage default)
  mcp/
    server.ts             MCP stdio server (generated from operations)
    http-transport.ts     HTTP MCP transport (OAuth, body caps)
    dispatch.ts           Op dispatch + scope enforcement + param redaction
    rate-limit.ts         Rate limiting
  schema.sql              Postgres DDL, hand-edited (fragment regions + both engine blobs generated by bun run build:schema)
skills/                   Fat markdown skills for AI agents
test/                     Unit tests (bun test, no DB required)
test/e2e/                 E2E tests (requires DATABASE_URL, real Postgres+pgvector)
  fixtures/               Miniature realistic brain corpus (16 files)
  helpers.ts              DB lifecycle, fixture import, diagnostics
  mechanical.test.ts      All operations against real DB
  skills.test.ts          Tier 2 skill tests (requires OpenClaw + API keys)
docs/                     Architecture docs
```

Façades (`operations.ts`, `doctor.ts`, `sync.ts`, `jobs.ts`, `serve-http.ts`, `hybrid.ts`,
`migrate.ts`, `pglite-schema.ts`, both engines) keep exporting everything they always exported;
new code goes in the module directories, never back into the façade. If you are porting a branch
written before refactor wave 1, the [porting guide](docs/architecture/wave-1-porting.md) maps every
moved symbol to its new home.

Per-file invariants live in `docs/architecture/KEY_FILES.md` — read a file's entry
before editing it.

## Running tests

The canonical reference for test tiers, isolation rules, timing, and the E2E
lifecycle is [`docs/TESTING.md`](docs/TESTING.md). The short version:

```bash
# Inner edit loop (~8min full suite on a Mac dev box; single files in seconds)
bun run test                      # parallel 4-shard fan-out (memory-adaptive) + serial post-pass; PGLite snapshot default-on
bun test test/markdown.test.ts    # specific unit test

# Pre-push gate (50+ parallel checks + typecheck)
bun run verify

# Pre-merge local suites (platform/persistence matrices run separately)
bun run test:full                 # verify + parallel unit + slow + smart e2e

# Slow / serial / e2e in isolation
bun run test:slow                 # *.slow.test.ts only (cold-path correctness)
bun run test:serial               # *.serial.test.ts only (pooled per-file processes, heaviest-first)
bun run test:e2e                  # real-Postgres E2E (requires DATABASE_URL)

# E2E setup (Postgres with pgvector)
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e

# Or use your own Postgres / Supabase
DATABASE_URL=postgresql://... bun run test:e2e
```

Heads-up: a bare `bun test` refuses to start while `DATABASE_URL` or
`GBRAIN_DATABASE_URL` is set in your environment — some tests run destructive
SQL against whatever those URLs point at. Unset the variable for unit runs
(they need no database) or use the wrappers: the unit/slow runners strip the
variables at their boundary, and `bun run test:e2e` opts in at its own. The
refusal message walks you through it; details in
[`docs/TESTING.md`](docs/TESTING.md) ("Database-URL run guard"). If you point
`bun run test:e2e` at your own Postgres or Supabase, a second floor applies:
the database name must carry "test" as a word segment (like `gbrain_test`
above) or destructive tests refuse to run — opt a differently-named database
in one-shot with `GBRAIN_E2E_ALLOW_DB=<name>`.

Changes to durable persistence also require the native/runtime, process-crash,
soak, deployment-matrix and read-latency gates in
[`scripts/persistence/README.md`](scripts/persistence/README.md#test-suites).
`test:full` alone does not execute those complete platform and runtime matrices.
Keep each result tied to its tested revision and disclose skipped cells.

Use `bun run verify` before pushing. It runs 50+ guard checks in parallel
(`scripts/run-verify-parallel.sh`), including: banned fork-name leaks
(`scripts/check-privacy.sh`), `JSON.stringify(x)::jsonb` interpolation
patterns (`scripts/check-jsonb-pattern.sh`), `\r` progress bleed to stdout
(`scripts/check-progress-to-stdout.sh`), test-isolation rule violations
(`scripts/check-test-isolation.sh` — see "Writing tests that survive the parallel
loop" below), silent fallback to recursive chunking in the compiled binary
(`scripts/check-wasm-embedded.sh`), stale admin-dashboard build artifacts
(`scripts/check-admin-build.sh`), resolver drift on bundled skills
(`bun run check:resolver`), and typecheck. The guard REGISTRY is
`scripts/guards-manifest.tsv`, and `scripts/guard-self-test.sh` (also in
`verify`) proves each self-tested scanner guard (`selftest=yes` in the
manifest; coverage ratchets up from the `todo` rows) can actually fail by
running it against known-bad fixtures — a new `scripts/check-*` guard must be
registered in the manifest or the build fails. There is no `check:all` script; the
trailing-newline and no-legacy-getconnection checks run in `verify` with
everything else, and `test/public-exports.test.ts` owns the package export map.

### Writing tests that survive the parallel loop

`bun run test` shards 1000+ unit-test files across up to 4 worker processes,
capping total concurrency (shards × intra-shard files) to available memory and
re-running OOM-killed or externally-killed files serially before calling them
failures (see `docs/TESTING.md` for the rescue-pass details and knobs). Files
in the same shard share a process, so process-global state leaks between them.
Four lint rules (`scripts/check-test-isolation.sh`, R1–R4) enforce isolation:
no direct `process.env` mutation (use `withEnv()` from
`test/helpers/with-env.ts`), no `mock.module(...)` outside `*.serial.test.ts`,
and every `new PGLiteEngine(` goes inside the canonical `beforeAll` block with
a paired `afterAll(disconnect)`.

**The full rules, the canonical PGLite block, the `withEnv` pattern, and the
`*.serial.test.ts` quarantine policy live in
[`docs/TESTING.md`](docs/TESTING.md#test-isolation-lint-and-helpers)
— read that before writing a new test file.** Files that predate the rules are
listed in `scripts/check-test-isolation.allowlist`; the allow-list MUST shrink
over time — never add new entries.

### Discrimination test — required for every fix (#3665)

A fix's test is only worth anything if it **fails without the fix**. A test
that passes both ways is worse than no test: it inflates reviewer confidence,
gets weighted into the CI shards forever, and keeps passing after a future
refactor silently breaks the behavior. (An adversarial review pass found PRs
where 7 of 8 new tests passed on master.)

Every PR that fixes behavior must fill the **Discrimination test** field in
the PR template with the actual result of checking this:

> Discrimination test: reverted `<source file(s)>` to `<ref>`, ran
> `<test file>` → `N pass / M fail`. Restored → all pass.

The helper does the whole dance in one command:

```bash
bash scripts/check-test-discriminates.sh <test-file> <source-file> [<source-file>...]
```

It reverts the source files to the pre-fix state (plain file copies, no git
stash), runs the test file, requires at least one EXECUTED test to fail —
exit ≠ 0 alone does not count, because a missing file or import crash also
exits non-zero (exit 3, the vacuous-failure class) — restores, and prints the
paste-ready field line. Exit 1 means the test passed with the fix reverted:
tighten the assertions before asking for review.

Vacuous-assertion shapes to avoid (they recur):
- asserting only `exit ≠ 0` (a missing binary also exits non-zero);
- asserting membership in a set that covers every reachable value
  (`['warn','fail']` when those are the only outputs);
- asserting a substring that would also appear in the broken output —
  assert parsed structure instead.

For a whole range of merged changes or open PRs, the contributor audit runs
the same check per change without the helper's whole-file revert: it reverses
only that change's product hunks at the audited head, so later fixes stay in
place. Try it on the offline fixture first:

```bash
bun scripts/contributor-audit-fixture.ts /tmp/audit-demo   # prints the audit command for the fixture range
bun run audit:contributors <base>..<head> [--prs <manifest>] [--json]
```

Details, exit codes and the scrubbed sandbox: [Contributor audit](docs/TESTING.md#contributor-audit).

Before adding a test, answer the four questions in the
[authoring gate](docs/TESTING.md#authoring-gate); before deleting one, follow
[Retiring a test](docs/TESTING.md#retiring-a-test) and record its evidence
table in the PR body.

Relatedly: a test whose only assertion is a regex over source text pins
spelling, not behavior. A test that reads `src/` text (`readFileSync`,
`readFile` or `Bun.file` on a `src/` path, directly or through a path
constant) needs a tagged marker on or just above the read:
`// test-reads-source-ok[<category>]: <why>`, with the category one of
`prompt-byte`, `trust-boundary`, `generated-artifact`, `structural` or
`raw-bytes`. `test/test-reads-source-smell.test.ts` enforces this and ratchets
pre-existing files by their exact count of unjustified read sites. It counts
read sites only, so new assertions over an existing source binding still need
the authoring gate. See [Source reads in tests](docs/TESTING.md#source-reads-in-tests).

### Local CI gate (recommended before pushing)

```bash
bun run ci:local         # full gate: gitleaks + guards/typecheck + 4-shard parallel unit + E2E
bun run ci:local:diff    # doc-only diff: gitleaks + doc checks; otherwise the full gate
bun run ci:select-e2e    # print the E2E files the diff selects (nothing for doc-only, else all)
bun run ci:ubicloud      # the same gate fanned out across ephemeral Ubicloud VMs (~5 min)
bun run ci:ubicloud:diff # Ubicloud gate with the same doc-only fast path
```

`ci:local` spins up four pgvector services plus a transaction-mode PgBouncer via
`docker-compose.ci.yml`, runs everything PR CI runs plus the full E2E suite
sharded 4 ways in parallel, then tears down. Named volumes keep the install warm
across runs. Requires Docker (Docker Desktop, OrbStack, or Colima) and `gitleaks`
on host (`brew install gitleaks`). Override the postgres host port with
`GBRAIN_CI_PG_PORT=5435 bun run ci:local` if 5434 collides.

`ci:ubicloud` needs no Docker or gitleaks locally, only `UBICLOUD_API_KEY` (or
`UBICLOUD_API_TOKEN`) for a Ubicloud project. It tests the working tree,
uncommitted edits included; see "Ubicloud fan-out" in
[`docs/TESTING.md`](docs/TESTING.md).

E2E selection runs every E2E file for any change that is not doc-only; diff
narrowing is retired because a typical E2E file imports most of `src/`. A
doc-only diff still runs llms freshness, the KEY_FILES byte caps, documented
paths, skill references and the privacy guards (`scripts/ci-doc-checks.sh`).
See [E2E selection](docs/TESTING.md#e2e-selection).

### Local graduation smoke (PGLite → Postgres)

A five-minute end-to-end check of `gbrain migrate --to postgres` on the E2E
container conventions from [`docs/TESTING.md`](docs/TESTING.md) (pinned
`pgvector/pgvector:pg16`, a database name carrying "test", tear down when done).
It uses its own container name and port so it never touches `gbrain-test-pg`,
and an isolated `GBRAIN_HOME` so it never touches your brain. Unset
`DATABASE_URL` and `GBRAIN_DATABASE_URL` first: the plan lists either one as a
blocker when it points anywhere but the target.

```bash
# 1. Target database
docker run -d --name gbrain-graduation-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=gbrain_graduation_test \
  -p 5436:5432 pgvector/pgvector:pg16
until docker exec gbrain-graduation-pg pg_isready -U postgres; do sleep 1; done

# 2. Source brain with write history, in a throwaway home
export GBRAIN_HOME="$(mktemp -d)"
bun run src/cli.ts init --pglite --no-embedding
echo "Alice Example runs the acme-example pilot." | bun run src/cli.ts put people/alice-example

# 3. Plan (exit 3, nothing changes), then run with the plan hash
export GBRAIN_TARGET_URL=postgresql://postgres:postgres@localhost:5436/gbrain_graduation_test
bun run src/cli.ts migrate --to postgres --url-env GBRAIN_TARGET_URL --json > plan.json; echo "exit $?"
bun run src/cli.ts migrate --to postgres --url-env GBRAIN_TARGET_URL --yes --expect "$(jq -r .plan_hash plan.json)"

# 4. The brain answers from Postgres
bun run src/cli.ts doctor --no-migrate --json
bun run src/cli.ts get people/alice-example
bun run src/cli.ts migrate --status --json

# 5. Clean up (always, pass or fail)
docker rm -f gbrain-graduation-pg
rm -rf "$GBRAIN_HOME" plan.json
unset GBRAIN_HOME GBRAIN_TARGET_URL
```

Expected: step 3 prints `exit 3` and then a run that ends with the target's
doctor result, `get` returns the page, and `ls "$GBRAIN_HOME/.gbrain"` before
cleanup shows `brain.pglite` as a tombstone file next to the retained
`brain.pglite.graduated-<run_id>` copy. For rollback,
run `bun run src/cli.ts migrate --rollback-to-source` before step 5 and check
that `get` answers from PGLite again.

### PR-side security checks

Besides the test gate, PRs may trigger three security workflows: Semgrep CE
SAST (every PR — **blocking for findings new since the PR base**, so a net-new
issue fails the check while pre-existing findings never block an unrelated PR;
scheduled/dispatch runs do a full-tree report-only scan), OSV-Scanner (only when
`package.json` or `bun.lock` change), and actionlint (only when
`.github/workflows/**` change). See `SECURITY.md` → "Automated security
scanning" for details.

## Building

```bash
bun build --compile --no-compile-autoload-bunfig --outfile bin/gbrain src/cli.ts
```

## Adding a new operation

GBrain uses a contract-first architecture. Add your operation to one domain module
and it automatically appears in the CLI, MCP server, and tools-json:

1. Add your operation to the matching domain module under `src/core/ops/`
   (`pages.ts`, `search.ts`, `takes.ts`, `jobs.ts`, ... — define params, handler,
   cliHints there). `src/core/operations.ts` is the assembly façade that spreads
   every domain module into the single `operations` array: a new op in an existing
   domain needs no façade change; a brand-new domain module gets one spread line
   in `operations.ts`. Shared contract types live in `src/core/ops/contract.ts`,
   the security/scope fences in `src/core/ops/context.ts`.
2. Add tests
3. That's it. The CLI, MCP server, and tools-json are generated from operations.

For CLI-only commands (init, upgrade, import, export, files, embed, doctor, sync):
1. Put the implementation in `src/commands/mycommand.ts`.
2. Add a record to `src/cli/command-table.ts` (`name`, `phase`, `thinClient`, and
   `load: () => import('./commands/mycommand.ts')`) and its dispatch module
   `src/cli/commands/mycommand.ts`, exporting `run(args, ctx)` for a pre-connect
   (engine-free) command or `run(engine, args, ctx)` for a post-connect one.
3. Regenerate the flag registry: `bun run build:flag-registry`. The CLI rejects
   unknown flags before dispatch; each CLI-only command's legal flag set is
   derived from its source into `src/core/cli-flag-registry.generated.ts`.
   `test/cli-flag-validation.test.ts` pins registry freshness, drift, and
   consumption evidence (a safety flag like `--dry-run` may only be advertised
   if the command's code actually reads it), so a stale registry fails the
   build. At runtime a missing registry entry fails open — a forgotten regen
   never bricks a command. Rerun the regen whenever you add or remove a flag
   on an existing command, too.

The full recipe for this and the other change kinds is in
[Where does my change go?](#where-does-my-change-go) below.

Parity tests (`test/parity.test.ts`) verify CLI/MCP/tools-json stay in sync.

## Where does my change go?

An op added to a domain module under `src/core/ops/` keeps its automatic path:
it appears in the CLI, the MCP server and `--tools-json` with no other edit
(see [Adding a new operation](#adding-a-new-operation)). Everything else lands
in one of these six places. Every row ends with the same pre-merge gate:
`bun run verify`, then `bun run ci:ubicloud` (or `bun run ci:local`) for the
full unit + E2E run on PGLite, direct Postgres and PgBouncer.

The façades these rows edit (`src/cli.ts`, `src/core/engine.ts`, both engine
files, `src/commands/sync.ts`) sit at their `check:module-size` ceilings, so a
change that adds lines to one of them also raises that file's ceiling in
`scripts/module-size-limits.tsv` by the lines you added, in the same commit.
That is expected, not a smell: engine methods and interface fields cannot move
to a sibling module. Every row also adds a behavior test of its own; the
"Smallest test" column lists the guards and goldens to run next to it.

| Change kind | Create or edit | Registry to touch | Regenerate | Smallest test |
|---|---|---|---|---|
| Storage method (a `BrainEngine` method) | The signature in `src/core/engine.ts`; the SQL once in `src/core/engine-sql/<domain>.ts`; a one-line delegation in `src/core/pglite-engine.ts` and `src/core/postgres-engine.ts` (copy a sibling read's shape, e.g. `getAllSlugs`) | `scripts/module-size-limits.tsv`: raise the `engine.ts`, `pglite-engine.ts` and `postgres-engine.ts` ceilings by the lines you added. A new SQL-bearing engine member fails `check:engine-sql-ratchet`; `scripts/engine-sql-baseline.tsv` rows only shrink | Nothing | `test/engine-sql-<domain>-<topic>.test.ts` on PGLite (seed with `engine.putPage(slug, { type, title, compiled_truth })`; the default source id is `'default'`); for a write, a case in `test/helpers/engine-sql-rollback-cases.ts`, run by `bun test test/engine-sql-transaction.test.ts` |
| Schema migration | `bun run new:migration <snake_name>` writes `src/core/schema-migrations/v<NNN>-<name>.ts`; fresh-install DDL in `src/schema.sql` (or the TS fragment its region banner names); a forward-reference probe in `src/core/engine-sql/bootstrap.ts` only when the schema blob references a column older brains lack | `src/core/schema-migrations/registry.generated.ts` (generated) | `new:migration` already regenerates the registry; rerun `bun run build:schema-migrations` only after editing or renaming a migration file. `bun run build:schema` whenever `schema.sql` or a fragment changed. Every object a fresh install should have goes in `schema.sql` (or its fragment) as well as the migration; grep `src/schema.sql` first so you do not add a second index on the same columns | `bun test test/scripts/build-schema-migrations.test.ts test/migrate.test.ts`, then `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/migrations-golden.test.ts test/schema-catalog-golden.test.ts` and review the golden diff |
| Doctor check | A `{ name, emits, run }` entry in the topic module under `src/commands/doctor/checks/` (a new topic gets a new file): `name` and `emits` are string literals, and `run` names a top-level `async function run<X>(ctx): Promise<Check[]>` in the same file that builds `const checks: Check[] = []` and calls `checks.push({ name: '<literal>', ... })` directly (the `emits` test walks that AST; helpers and returned array literals are invisible to it) | `DOCTOR_CHECK_REGISTRY` in `src/commands/doctor/registry.ts` (position = output order; `test/doctor-registry-golden.test.ts` pins `dangling_aliases` as the last check, so insert before `searchModeEntry`) and every emitted name in `src/core/doctor-categories.ts` | The doctor goldens, deliberately: `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/doctor-registry-golden.test.ts test/doctor-json-golden.test.ts` | `test/doctor-<name>.test.ts` on in-memory PGLite (copy `test/doctor-slug-collisions.test.ts`), plus `bun test test/doctor-registry.test.ts` |
| CLI-only command | The implementation in `src/commands/<name>.ts`; the dispatch module `src/cli/commands/<name>.ts`; a help line in `printHelp` (`src/cli.ts`, so raise its `module-size-limits.tsv` ceiling by one) | A record in `CLI_COMMANDS` (`src/cli/command-table.ts`): `phase: 'pre-connect'` when the command never touches the database, `'post-connect'` when its `run(engine, args, ctx)` needs an engine; `thinClient: 'none'` unless remote brains must refuse it (`'refuse'`, or `'route-then-refuse'` for subcommand routing); `selfHelp: true` when the command has flags or subcommands (its `run` then prints its own `--help`); optional `skipStartupHooks`; `load: () => import('<literal>')` | `bun run build:flag-registry`; the CLI goldens, deliberately: `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/cli-goldens.test.ts test/cli-dispatch-phase.test.ts test/cli-dispatch-thin-client.test.ts` | `test/<name>.test.ts` spawning `bun src/cli.ts <name>` and asserting output and exit code, plus `bun test test/cli-command-table.test.ts test/cli-flag-validation.test.ts` |
| HTTP route (`gbrain serve --http`) | The route inside `mount<Area>(app, ctx)` in `src/commands/serve-http-<area>.ts` (`/admin/api/*` goes in `serve-http-admin-api.ts`, `/mcp` in `serve-http-mcp.ts`, OAuth in `serve-http-oauth.ts`); a new area is a new module plus one mount call in `buildServeHttpApp` (`src/commands/serve-http.ts`). An `/admin` route takes `ctx.requireAdmin` before its handler | None for a route in an existing area; a new area adds its mount call in `buildServeHttpApp` (order matters) | The route goldens, deliberately: `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/serve-http-route-golden.test.ts test/serve-http-route-runtime-golden.test.ts` | A behavior test (`test/serve-http-<area>-<route>.test.ts`: mount the area on a bare `express()` app with a stub ctx; `mountAdminApi` reads `requireAdmin`, `sseClients` and `mcpResourceUrl` at mount time) plus `bun test test/serve-http-admin-route-guard.test.ts`, which finds the new route by itself |
| Sync phase | A module under `src/commands/sync/` taking `(run, Pick<SyncPlan, ...>, ...)` and returning `SyncResult \| undefined`; state it shares across awaits becomes a field on `SyncRun` (`src/commands/sync/sync-run.ts`). A value for the final summary flows `SyncRun` field -> `finalizeIncrementalSync` (`sync/finalize.ts`) -> `SyncResult` (`src/commands/sync.ts`, raise its ceiling) -> `printSyncResult` (`sync/report.ts`) when it should print | The phase call order in `performSyncInner` (`src/commands/sync/incremental.ts`) | Nothing | A case in `test/sync-run-ordering.serial.test.ts` (it has the git-repo + PGLite harness: `commitPages`, `performSync`), plus `bun test test/sync.test.ts test/sync-run-ordering.serial.test.ts` |

A golden regenerated on purpose is a reviewer-visible diff: say in the PR body
why the output changed. Regenerate generated files instead of merging them
(`registry.generated.ts`, `schema-embedded.generated.ts`,
`pglite-schema.generated.ts`, `cli-flag-registry.generated.ts`).

### Which directory?

| If your code is... | It goes in | Not in |
|---|---|---|
| SQL behind a `BrainEngine` method, shared by both engines | `src/core/engine-sql/<domain>.ts` | an engine file (only dialect-specific code stays in `pglite-engine/` or `postgres-engine/`, marked `// engine-sql-ok: <reason>`) |
| A blob storage backend (files, attachments; S3, Supabase Storage, local disk) | `src/core/storage/` behind `src/core/storage.ts` | `engine-sql/` (that is the database) |
| Durable write-path protocol above the engine (requests, owner coordination, recovery, writer enforcement) | `src/core/persistence/` | `engine-sql/` (it holds statements, not protocols) |
| A numbered DDL change applied on `initSchema` (`schema_version`) | `src/core/schema-migrations/` | `src/commands/migrations/` |
| A versioned upgrade orchestrator run once per release (`gbrain apply-migrations`, host work) | `src/commands/migrations/` (agent notes in `skills/migrations/`) | `schema-migrations/` |
| One step of an incremental sync run that shares `SyncRun` state | `src/commands/sync/<phase>.ts` | `src/core/sync-*.ts` |
| Sync logic other code reuses (cost gate, git helpers, locks, reconcile, status report) | `src/core/sync-*.ts` (no `SyncRun`) | `src/commands/sync/` |
| SQL on OAuth, admin or auth tables outside `BrainEngine` (scalar binds only) | `sqlQueryForEngine` from `src/core/sql-query.ts` (`executeRawJsonb` for JSONB) | the engine-sql executor, which only engines hand out |
| SQL inside an engine method | the `SqlExecutor` the engine passes to `src/core/engine-sql/<domain>.ts` | `sql-query.ts` |
| An HTTP route | `src/commands/serve-http-<area>.ts` (flat files, one per area) | a new directory or back in `serve-http.ts` |
| CLI-only command wiring | `src/cli/commands/<name>.ts` (dispatch glue) + a `src/cli/command-table.ts` record | new branches in `src/cli.ts` |
| A CLI-only command's behavior | `src/commands/<name>.ts` | `src/cli/commands/` |
| A built-in Minion job handler | `src/core/minions/handlers/<name>.ts`, registered in `registerBuiltinHandlers` (`src/commands/jobs.ts`) | the body of `jobs.ts` |
| A hybrid search step | the stage module in `src/core/search/hybrid/` that owns it | the body of `hybridSearch` |

### Worked example: an engine-sql read and write

Say the salience domain needs a count of salient pages (a read) and a way to
clear emotional weight (a write). The domain is migrated (`migrated salience`
in `scripts/engine-sql-baseline.tsv`); a domain that is not migrated yet
works the same way, and its older methods move over later.

1. **Declare the methods** on `BrainEngine` in `src/core/engine.ts`:

   ```ts
   countSalientPages(opts: { minWeight: number; sourceId?: string; sourceIds?: string[] }): Promise<number>;
   clearEmotionalWeight(slugs: string[], sourceId: string): Promise<number>;
   ```

   The source scope arrives already resolved: the op layer turns the caller's
   context into `sourceId` / `sourceIds` with `sourceScopeOpts(ctx)`. Store
   functions filter on it and never resolve it themselves.

2. **Write the SQL once** in `src/core/engine-sql/salience.ts`:

   ```ts
   import type { SqlExecutor } from './executor.ts';
   import type { ScopedRead } from './brands.ts';
   import { sqlFragment } from './fragment.ts';
   import { compileRowNormalizer } from './normalize.ts';

   // Declared once at module scope: int8 arrives as a string from postgres.js
   // and as a number from PGLite; the declared kind makes both a number.
   // Declare only columns that need conversion (jsonb, bigint, date, vector,
   // text[]); plain text and numeric columns pass through untouched.
   const normalizeCount = compileRowNormalizer<{ n: number }>({ n: 'bigint' });

   export async function countSalientPages(
     exec: ScopedRead,
     opts: { minWeight: number; sourceId?: string; sourceIds?: string[] },
   ): Promise<number> {
     const scope = opts.sourceIds && opts.sourceIds.length > 0
       ? sqlFragment`AND p.source_id = ANY(${opts.sourceIds}::text[])`
       : opts.sourceId
         ? sqlFragment`AND p.source_id = ${opts.sourceId}`
         : sqlFragment``;
     const { rows } = await exec.run(sqlFragment`
       SELECT count(*)::bigint AS n
         FROM pages p
        WHERE p.emotional_weight >= ${opts.minWeight}
          AND p.deleted_at IS NULL
          ${scope}
     `);
     return normalizeCount(rows[0] ?? { n: 0 }).n;
   }

   export async function clearEmotionalWeight(exec: SqlExecutor, slugs: string[], sourceId: string): Promise<number> {
     if (slugs.length === 0) return 0;
     const { affectedRows } = await exec.run(sqlFragment`
       UPDATE pages SET emotional_weight = 0
        WHERE slug = ANY(${slugs}::text[]) AND source_id = ${sourceId}
          AND emotional_weight <> 0
     `);
     return affectedRows;
   }
   ```

   Parameter encoding: every value is a `${}` inside `sqlFragment`, which
   numbers the placeholders when the statement renders; never write `$1` in a
   composed string. Lists bind as one array, `= ANY(${ids}::text[])`, never as
   an expanded `IN (...)`. JSONB goes through `jsonbParam(obj)` (see
   `writeContradictionsRun` in `engine-sql/takes.ts`), never
   `JSON.stringify` into a `::jsonb` cast. A vector binds as its text literal
   with a `::vector` cast, a `bigint` with an explicit `::bigint`, and a
   `Date` as-is. Only constant text may be spliced with `trustedSql(...)`.
   Read results go through a declared normalizer, and write counts through
   `affectedRows`; never read the driver's `.count`.

3. **Delegate from both engines**, choosing the read's RLS scope. The brand
   on the read's parameter decides how the engine must obtain the executor:
   `ScopedRead` for a source-scoped read that should bind `app.scopes` when
   `GBRAIN_RLS_SCOPE_BINDING` is on (follow the domain's sibling reads), and
   `LegacyUnscopedRead` via `unscopedExecutor(this.engineSql, '<specific reason>')`
   for a read that runs on the pool with no scope transaction. Writes take the
   plain `this.engineSql`.

   ```ts
   // src/core/postgres-engine.ts
   async countSalientPages(opts: { minWeight: number; sourceId?: string; sourceIds?: string[] }): Promise<number> {
     return this.withScopedReadTransaction(opts.sourceIds, opts.sourceId, async (tx) =>
       salienceImpl.countSalientPages(scopedRead(this.engineSqlOn(tx)), opts));
   }
   async clearEmotionalWeight(slugs: string[], sourceId: string): Promise<number> {
     return salienceImpl.clearEmotionalWeight(this.engineSql, slugs, sourceId);
   }

   // src/core/pglite-engine.ts (no RLS layer: the engine brands its own executor)
   async countSalientPages(opts: { minWeight: number; sourceId?: string; sourceIds?: string[] }): Promise<number> {
     return salienceImpl.countSalientPages(scopedRead(this.engineSql), opts);
   }
   async clearEmotionalWeight(slugs: string[], sourceId: string): Promise<number> {
     return salienceImpl.clearEmotionalWeight(this.engineSql, slugs, sourceId);
   }
   ```

   `this.engineSql` is a getter that builds a fresh adapter over the engine's
   current connection on every access. Never store it: inside
   `engine.transaction()` the engine is a clone whose connection is the
   transaction, and a cached executor would write outside it.

4. **Test it.** A PGLite unit test for both methods, with the canonical
   PGLite block from [docs/TESTING.md](docs/TESTING.md#test-isolation-lint-and-helpers).
   A rollback case for the write in `test/helpers/engine-sql-rollback-cases.ts`
   (`bun test test/engine-sql-transaction.test.ts` runs it on PGLite; the E2E
   twin runs it on Postgres). A Postgres arm in the domain's parity E2E
   (`test/e2e/engine-parity-salience.test.ts`), which the backend matrix runs
   on direct Postgres and PgBouncer. `bun run verify` then runs the
   engine-sql guards: the ratchet (no SQL left in the engines), the
   dynamic-SQL scanner (only constant text spliced), the brand guard (no
   forged `ScopedRead`) and the layering guard (engine-sql never imports an
   engine). See [docs/TESTING.md, "Engine-sql"](docs/TESTING.md#engine-sql).

## Adding a new engine

See [`docs/ENGINES.md`](docs/ENGINES.md#adding-a-new-engine) for the full guide. In short:

1. Create `src/core/myengine-engine.ts` implementing `BrainEngine`, and add it to
   the engine factory in `src/core/engine-factory.ts`.
2. If it speaks the Postgres dialect, write a dialect adapter implementing
   `SqlExecutor` (`src/core/engine-sql/executor.ts`) next to `dialect-pglite.ts`
   and `dialect-postgres.ts`, and delegate every migrated domain to
   `src/core/engine-sql/<domain>.ts` exactly as the two engines do; the domain
   SQL, the RLS read brands and the forward-reference bootstrap come for free.
   Methods of domains that are not migrated yet are written in the engine.
3. A non-SQL engine implements every method itself.
4. Run the engine-agnostic suites against it (the engine-sql contract tests in
   [docs/TESTING.md](docs/TESTING.md#engine-sql) plus `test/e2e/engine-parity.test.ts`)
   and document it in `docs/`.

The original SQLite engine plan was superseded by PGLite (embedded Postgres 17 via WASM), which uses the same SQL dialect as Postgres and eliminates the need for a separate FTS5/sqlite-vss translation layer. See [`docs/ENGINES.md`](docs/ENGINES.md) for the engine architecture and the rationale.

## CONTRIBUTOR_MODE — turn on the dev loop

gbrain captures retrieval traffic so you can replay real queries against
your code changes before merging. **This is off by default** (production
users get a quiet brain, no surprise data accumulation). Contributors turn
it on with one shell rc line:

```bash
# In ~/.zshrc or ~/.bashrc:
export GBRAIN_CONTRIBUTOR_MODE=1
```

That's it. Every `query` / `search` you (or agents pointed at your dev
brain) run from that shell now writes a row to `eval_candidates`, and the
[replay tool](#running-real-world-eval-benchmarks-touching-retrieval-code)
has data to work against.

What CONTRIBUTOR_MODE actually does:

- Turns on `query`/`search` capture into the local `eval_candidates` table.
  Without it the gate is closed and capture is a no-op.
- That's all. PII scrubbing, retention, and replay are independent.

Resolution order (most explicit wins):

1. `eval.capture: true` in `~/.gbrain/config.json` → on
2. `eval.capture: false` in `~/.gbrain/config.json` → off
3. `GBRAIN_CONTRIBUTOR_MODE=1` → on
4. otherwise → off

Quick check that capture is actually running:

```bash
gbrain query "anything" >/dev/null
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'
# (or `gbrain doctor` — surfaces silent capture failures cross-process)
```

To disable capture even with the env var set, write
`{"eval": {"capture": false}}` to `~/.gbrain/config.json` — explicit config
beats the env var both directions.

## Running real-world eval benchmarks (touching retrieval code)

If your PR touches retrieval — search ranking, RRF fusion, embeddings,
intent classification, query expansion, source boost, or the `query` /
`search` op handlers — run `gbrain eval replay` against a snapshot of
real traffic before merging. Requires `CONTRIBUTOR_MODE` (above) so you
have captured rows to replay against.

Quick loop:

```bash
gbrain eval export --since 7d > baseline.ndjson    # snapshot before your change
# ... make your change ...
gbrain eval replay --against baseline.ndjson       # diff retrieval, get Jaccard@k
```

Three numbers come back: mean Jaccard@k between captured and current slug
sets, top-1 stability, and mean latency Δ. The replay tool flags the worst
regressions so you can eyeball whether the change is hurting real queries.

Trigger paths (rerun if your diff touches any of these):

- `src/core/search/hybrid.ts` and its stages in `src/core/search/hybrid/`
- `src/core/search/source-boost.ts`, `sql-ranking.ts`
- `src/core/search/query-intent.ts`, `expansion.ts`, `dedup.ts`
- `src/core/embedding.ts`
- `src/core/ops/search.ts` (query / search op handlers)
- `src/core/postgres-engine.ts` / `pglite-engine.ts` (searchKeyword /
  searchVector SQL) and any search SQL under `src/core/engine-sql/`

See [`docs/eval-bench.md`](./docs/eval-bench.md) for the full guide
including CI integration, hand-crafted NDJSON corpora (so a fresh checkout
without captured data can still replay), and cost considerations. The
NDJSON wire format is documented in
[`docs/eval-capture.md`](./docs/eval-capture.md).

For public benchmark coverage on top of replay, `gbrain eval longmemeval
<dataset.jsonl>` runs LongMemEval against gbrain's hybrid
retrieval. One in-memory PGLite per question, runtime-enumerated
`TRUNCATE` between questions, ground-truth scoring via LongMemEval's
published `evaluate_qa.py`. Use it alongside replay when changes affect
retrieval quality on long-context conversational data — replay catches
regressions on YOUR queries, LongMemEval catches them on a public set the
benchmark community already cites. See the "Public benchmarks: LongMemEval"
section in [`docs/eval-bench.md`](./docs/eval-bench.md).

## Shipping

Releases go through the `/ship` skill, never hand-rolled. The full release +
contributor process (CHANGELOG voice, version-locations sync, PR conventions,
community-PR-wave workflow) lives in [`docs/RELEASING.md`](docs/RELEASING.md).
Community PRs are batched into release waves rather than merged one-by-one;
contributor attribution stays attached via `Co-Authored-By:` trailers and every
accepted contribution is credited in `CHANGELOG.md`.

### How a contributor PR lands

Contributor PRs are never merged into master as-is. A maintainer folds the
change into a fix-wave PR, revises it there (tests, agent-facing errors,
conventions) and lands it with credit: the commit says `Contributed by @handle`
and carries a `Co-Authored-By:` trailer. Your PR stays open until then. When
the fix wave merges, a workflow closes your PR with a comment that links the wave.

The **Fix-wave gate** check enforces this. It fails every PR into master whose
head branch is not in `garrytan/gbrain` itself, and posts one comment saying
so when the PR opens. A red gate on a contributor PR is expected and is not a
judgment of the work. Maintainers' own branches (`capy/*`, `garrytan/*`) pass.

`maintainer-override` label: a human on the maintainer allowlist in
`scripts/fix-wave-gate.ts` (it starts as `garrytan`) may apply it to pass the
gate for one PR a maintainer has decided may land from its fork (for example a
fix wave a maintainer opened from a fork); record the reason in a PR comment.
Bots never count, and the label only counts when the most recent
`labeled` event was made by an allowlisted human. Every override is written to
the check's run log and step summary with who applied it and when. Process and
settings: [docs/RELEASING.md](docs/RELEASING.md#fix-wave-gate).

## Welcome PRs

- Additional engine implementations (see [`docs/ENGINES.md`](docs/ENGINES.md))
- Docker Compose for self-hosted Postgres
- Additional migration sources
- New enrichment API integrations
- Performance optimizations
