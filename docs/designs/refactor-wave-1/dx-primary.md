# DX Review (Phase 2.5, primary voice): GBrain Refactor Wave 1

Methodology: gstack `/plan-devex-review` v2.0.0, executed in full (Step 0 + Passes 1-8 + scorecard) under the /autoplan
overrides: mode **DX POLISH**, no questions asked, every issue auto-decided with the 6 principles (completeness, boil
lakes under 1 day of CC time inside the blast radius, pragmatic, DRY, explicit over clever, bias to action). Skipped per
override: preamble, scope gate, AskUserQuestion format, completeness principle, search-before-building, completion
status, telemetry, base-branch detection, readiness dashboard, plan-file report, prerequisite offer, outside voice.

Plan under review: `autoplan-dx-FlAo6F/dx-implementation.md`. Baseline code: `master @ 608a174dc` (v0.60.10.0), read-only.

Evidence labels used below: **[code]** = verified in the repo at 608a174 with the command/path cited; **[plan]** = the
plan's own text; **[est]** = estimate from counted steps and files, not a measured run; **[doc]** = peer documentation,
in-distribution knowledge, not re-fetched this session.

---

## Step 0: DX Investigation

### Pre-review audit (what I verified before scoring)

Plan facts confirmed **[code]**:

- `src/core/migrate.ts` is 7,307 lines; `export const MIGRATIONS` opens at line 196 and `LATEST_VERSION` at 6782
  (`MIGRATIONS.length > 0 ? max...`). Module-size row is `region-exempt`, ceiling 722.
- `handleCliOnly` starts at `src/cli.ts:2095`; 62 `case '<cmd>'` labels between 2095 and 3610.
- `registerBuiltinHandlers` at `src/commands/jobs.ts:2200` has 24 `worker.register(` sites (29 in the whole file).
- `src/commands/doctor/checks/` holds 32 flat, topic-named modules (`backup-coverage.ts`, `calibration.ts`, ...), each
  exporting `check<Topic>()`. Categories come from `categorizeCheck(name)` in `src/core/doctor-categories.ts`
  (`BRAIN_/SKILL_/OPS_/META_CHECK_NAMES` sets).
- Per-engine domain modules exist: `src/core/{pglite,postgres}-engine/{facts,takes,salience,code-edges,cjk-search}.ts`.
- `test/helpers/doctor-source.ts` already implements the containment (`doctorSource()`) vs positional
  (`doctorFileSource(rel)`) split the plan's A10 wants to generalize.
- `scripts/build-schema.sh` already exists (generates `schema-embedded.generated.ts` from `schema.sql`); `build:schema`
  is the package.json entry.
- `module-size-limits.tsv` notes really are changelogs-in-a-cell: `src/cli.ts` row is 4,691 chars, `src/commands/sync.ts`
  6,397 chars. Every PR that grows these files edits the same line, so they are conflict hotspots.

Plan facts that are **wrong or incomplete [code]** (they drive several findings below):

1. **serve-http naming convention.** The plan says route modules "follow the existing convention
   (`serve-http-oauth-routes.ts`, `serve-http-admin-routes.ts`, `serve-http-mcp-routes.ts`, `serve-http-metrics-routes.ts`,
   `serve-http-spa-routes.ts`)". No `-routes` file exists. The real convention is `serve-http-<area>.ts` exporting
   `mount<Area>(app, requireAdmin, engine, ...)`: `serve-http-oauth.ts` (`mountConfidentialOAuth`, `mountOAuthConsent`),
   `serve-http-metrics.ts`, `serve-http-registration.ts` (`mountAdminRegistration`), `serve-http-grants.ts`,
   `serve-http-clients.ts` (`mountAdminClients`), `serve-http-admin-limits.ts`. The plan's names would put
   `serve-http-oauth-routes.ts` next to `serve-http-oauth.ts`.
2. **Snapshot cache keys.** The plan says update `.github/workflows/e2e.yml` lines 71 and 186. The identical
   `pglite-snapshot-${{ hashFiles('src/core/migrate.ts', ...) }}` key has **11 homes**: `e2e.yml` 71, 186, 243, 372, 557 and
   `test.yml` 194, 246, 308, 353, 460, 542 (`grep -rn "pglite-snapshot-\${{" .github/workflows/`). The e2e.yml comment
   itself says "byte-identical with the homes in test.yml".
3. **E9 already exists.** `test/serve-http-admin-route-guard.test.ts` is a structural scan of `src/commands/serve-http.ts`
   with a 7-entry allowlist (`/admin/login`, `/admin/api/issue-magic-link`, `/admin/auth/:token`, the static `/admin`
   mount, the `/admin` redirect, and the two-arm `/admin/{*path}` SPA fallback), an anti-vacuity floor and a self-test.
   The plan describes E9 as new, with a 3-entry allowlist. It reads only `serve-http.ts`, so moving routes into modules
   silently drops them out of its view (the floor catches only a count drop below the known surface).
4. **Flag-registry coupling is missing.** `scripts/generate-flag-registry.ts` segments `handleCliOnly` with the regex
   `^      case '([a-z0-9-]+)':` / `if (command === 'X'` and follows `import('./commands/Y.ts')` one level deep, plus a
   hand-kept `facadeExpansion()` list (doctor/, skillpack/, connectors/, six `src/core/sync-*.ts` files). Replacing the
   switch with a table breaks the generator; peeling sync into `src/commands/sync/` drops those modules' flags from
   the scan. The CLI validator rejects unknown flags before dispatch, so a shrunken registry is a user-visible break.
5. **Hardcoded paths to moved files are everywhere.** At least 35 scripts/workflows name the files being split
   (`scripts/generate-flag-registry.ts` ×8, `check-cli-executable.sh` ×6, `smoke-test.sh` ×7, `e2e-test-map.ts` ×4,
   `check-no-legacy-getconnection.sh` ×4, `test.yml` ×10, `e2e.yml` ×6, ...). Scanner guards that hardcode
   `src/core/migrate.ts` (`check-jsonb-pattern.sh:53`, `check-engine-dynamic-import.sh:27`, `check-source-config-leak.sh`)
   will scan an empty-of-DDL runner after W3 and stay green: the "permanently-green guard" class the manifest header
   warns about. `scripts/select-e2e.ts` lists `src/core/migrate.ts` as an escape-hatch (run-all) file; new migration
   files under a new directory are not in that list.
6. **Two existing "migrations" registries.** `src/commands/migrations/index.ts` already exports `migrations: Migration[]`
   (app-version orchestrator migrations, files `v0_11_0.ts` ... 22 entries) with its own `Migration` type. The plan's
   `src/core/migrations/index.ts` would be a second `migrations/index.ts` with a second, different `Migration` type and
   look-alike `v0NN` filenames.
7. **An executor already exists.** `src/core/sql-query.ts:sqlQueryForEngine()` is a deliberately narrow tagged SQL seam
   (scalars only, used by 18 src files in auth/admin/OAuth). The plan builds a second, richer executor "beside" it
   without saying how a contributor chooses.
8. **Always-loaded agent instructions go stale.** `CLAUDE.md` says "a new method/SQL shape lands in BOTH [engines]",
   "Schema DDL lives in the `MIGRATIONS` array in `src/core/migrate.ts`", "migrate.ts is `region-exempt`", and lists
   `sync.ts (src/core/sync-*)` as the sync peel. `CONTRIBUTING.md` says "Add the case to `src/cli.ts`" and its project
   tree lists the per-engine module dirs. `docs/ENGINES.md:209`, `docs/guides/rls-and-you.md:124` and
   `docs/architecture/infra-layer.md:16` point at the MIGRATIONS array. The plan's Docs section lists only
   `KEY_FILES.md`, `key-files/*` and `doctor-categories.ts` references.
9. **Driver error identity is load-bearing.** 281 files under `src/core` read `err.code`/`e.code`/`error.code`;
   `migrate.ts:7101 isDeadlockError` keys on `.code === '40P01'` or `.sqlState`. The executor contract in A1 lists
   encoding, transactions, cancellation, retries, but not error pass-through.

### Auto-detected product type

This is not a public product change. The "product" is **the GBrain codebase as an internal SDK for contributors**
(module layout, registries, generators, guards, docs) with a frozen external contract (CLI, MCP, package.json
`exports`). Primary type: **Library/SDK (internal contributor API)**, secondary **CLI Tool** (zero-change contract).
Auto-decided (no confirmation question in autoplan).

### 0A. Developer persona cards

```
TARGET DEVELOPER PERSONA (primary)
==================================
Who:       A GBrain contributor or, more often, an AI coding agent (Claude Code, Codex) opening a PR
           against a repo that ships several releases a day with ~50 PRs open at once.
Context:   Arrives with a narrow task: "add a storage method", "add migration v176", "add a doctor
           check", "add a CLI command", "add an admin HTTP route", "add a sync phase". Reads the
           always-loaded CLAUDE.md, greps, follows the first plausible pattern it finds.
Tolerance: An agent does not abandon, it guesses. The failure mode is a confident wrong change
           (SQL written twice, a migration appended to a file that no longer holds MIGRATIONS, a route
           without requireAdmin) that CI may or may not catch. A human gives up on a 3,000-line
           closure after ~20 minutes.
Expects:   One obvious place per change kind; CLAUDE.md telling the truth; every forgotten companion
           edit (registry, category set, flag registry, cache key) failing locally in `bun run verify`
           with the exact fix.
```

```
SECONDARY PERSONA: author of an open PR that now conflicts
Who:       Owner (human or agent) of one of the ~51 open PRs touching target files.
Context:   Rebases after the wave lands; git shows a conflict in a function that no longer exists.
Tolerance: Low. If porting costs more than the original change, the PR rots.
Expects:   old path:function -> new path:function lookup, a recipe per conflict kind, an agent-ready prompt.

TERTIARY PERSONA: downstream importer / CLI and MCP user
Who:       Code importing `gbrain/engine`, `gbrain/pglite-engine`, `gbrain/operations`,
           `gbrain/search/hybrid`, `gbrain/types`, `gbrain/minions`; users of `gbrain` CLI and MCP tools.
Expects:   Nothing to notice. Same exports, same help text, same exit codes, same errors, same speed.
```

### 0B. Developer empathy narrative (first person, primary persona, after the plan as written)

> I'm an agent asked to add a `countFactsBySource` storage method. CLAUDE.md loads first and tells me the two engines
> "move in lockstep — a new method/SQL shape lands in BOTH". So I open `postgres-engine/facts.ts` and
> `pglite-engine/facts.ts`. They're gone, or they're thin shims now, and I find `src/core/store/facts.ts`. Is `store`
> the same thing as `src/core/storage/`, the S3/Supabase folder next to it? I read both to be sure. There's also
> `sql-query.ts` with its own tagged SQL function, and the new executor. I pick one. For the method itself I copy the
> pattern I just saw. Then I need to add `countPagesBySource`, and `pages` wasn't migrated in this wave, so the old
> dual-SQL pattern is still right there. Nothing tells me which domains are "done" except reading the guard's source.
>
> Next task: migration v176. CLAUDE.md says the MIGRATIONS array lives in `migrate.ts`; it doesn't anymore. I grep
> `migrations/index.ts` and find two: `src/commands/migrations/index.ts` (the app-version one) and
> `src/core/migrations/index.ts`. I edit the wrong one first. When I get it right, a freshness guard tells me the
> index is stale. Fine, but which command regenerates it? Then CI's snapshot cache key didn't include my new helper
> import and a stale PGLite snapshot passes my test on CI but not on a fresh machine.
>
> Observed vs predicted: the stale CLAUDE.md lines, the two `migrations/index.ts` registries, `store` next to `storage`,
> the second executor and the snapshot cache list are observed in code today or in the plan text. The confusion
> sequence is predicted.

### 0C. Competitive DX benchmark

Clock (auto-decided): **start** = fresh clone of post-refactor master with Bun installed and `bun install` done; **end** =
a correct, PR-ready change of one common kind, with every companion edit made, passing `bun run verify` and the unit
tests the docs route to. Excludes CI wall time (`ci:ubicloud` about 5 min) and E2E. Adapted tiers for this clock:
Champion under 15 min, Competitive 15-30, Needs Work 30-60, Red Flag over 60 (AI agent; a human is roughly 2-3×).

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| Kysely | new dialect/query → runs on PG/SQLite/MySQL | not comparable in minutes [doc] | One query builder; per-dialect `Dialect` = driver + adapter + query compiler. SQL written once, dialect differences isolated in the adapter. | kysely.dev/docs/dialects [doc] |
| Drizzle Kit | schema edit → migration | ~1 command [doc] | `drizzle-kit generate` writes numbered SQL files plus a generated `meta/_journal.json`; the journal is a known merge-conflict point for parallel branches. | orm.drizzle.team/docs/kit-overview [doc] |
| Prisma Migrate | schema edit → migration | ~1 command [doc] | `prisma migrate dev --name x` scaffolds `migrations/<timestamp>_x/migration.sql`; timestamps avoid number collisions across branches. | prisma.io/docs/orm/prisma-migrate [doc] |
| Rails | new migration | 1 generator command [doc] | `bin/rails g migration X` scaffolds a timestamped file; moved to timestamps specifically because sequential numbers collided on parallel branches. | guides.rubyonrails.org/active_record_migrations.html [doc] |
| Express Router | new route group | [doc] | `express.Router()` modules mounted with `app.use('/admin', router)`; middleware at router level makes auth hard to forget. | expressjs.com/en/guide/routing.html [doc] |
| **GBrain today** | clone → new storage method | 60-90 min [est], Red Flag | Write SQL twice in two dialect spellings (tagged `sql` vs `$n`), keep parity by 28 drift tests; JSONB double-encode only visible on Postgres e2e. | engines + `test/e2e/engine-parity.test.ts` [code] |
| **GBrain today** | clone → new migration | 45-75 min [est] | Append to a 7,307-line file, pick max+1, often also edit `schema.sql` + `pglite-schema.ts` + forward-reference bootstrap in both engines. | `migrate.ts:196-6780` [code] |
| **GBrain after plan (as written)** | same | 30-45 min [est] for migrated domains, unchanged for the 7 unmigrated ones | One SQL copy in `src/core/store/`, generated migration registry, doctor/route/command registries. Friction from stale docs, naming collisions, hidden generator coupling. | [plan] |

Limitation: peer times are "one command" documentation claims, not measured contributor journeys; only the DX choices
are comparable, not the minutes.

**Target (auto-decided, taste D4): Competitive, ≤ 30 min [est]** for the six change kinds once their area is migrated,
reached through obligations O1-O8. Champion (<15 min) would need scaffolders for every kind, which is new tooling
beyond POLISH scope except the one taste item D8 (migration scaffold).

### 0D. Magical moment (auto-decided, taste D5)

For this product the magical moment is: **"I put my change in the one obvious file, run `bun run verify`, and every
companion edit I forgot fails with a message naming the exact file and command to fix it."** No tribal knowledge, no
waiting for a CI shard to tell me.

Vehicle chosen (existing capabilities only): (A) the guard failure texts specified in O9, plus (B) a "Where does my change
go?" recipe table in `CONTRIBUTING.md` (O1). Rejected: a hosted "contributor portal" or interactive CLI wizard (new
product surface, out of POLISH scope).

### 0E. Mode

DX POLISH (set by parent). Enhancement to an existing codebase; no scope additions except items marked taste.

### 0F. Developer journey trace (9 stages)

| # | Stage | Developer does | Friction points (evidence) | Resolution | Status |
|---|---|---|---|---|---|
| 1 | Discover | Reads CLAUDE.md (always loaded), `KEY_FILES.md`, greps for the pattern | CLAUDE.md invariants for engine parity, migrations, region-exempt and sync façade become false (finding 8) [code] | O2: rewrite those invariants in the same PR + `build:llms` | fixed |
| 2 | Evaluate | Decides where the change belongs | Mixed state: 5 domains in the new store, 7 still dual-SQL; no single list [plan] | O3: one source of truth for migrated domains, shown in guard text + key-files entry | fixed |
| 3 | Install | `git clone && bun install && bun test` (CONTRIBUTING) | Unchanged by the refactor. New guards add verify time; `run-verify-parallel.sh` gives each check `TIMEOUT=120` [code] | O15: new guards measured and budgeted | ok |
| 4 | Hello world | Adds first change of a kind | Names collide or mislead: `store/` vs `storage/`, two `migrations/index.ts`, `-routes` suffix vs real `serve-http-<area>.ts` (findings 1, 6) [code] | D10, D11, D13 naming decisions + O1 recipes | fixed |
| 5 | Integrate | Registers the change (registry, category, flag registry, cache keys) | Flag-registry generator and 11 cache-key homes not in plan (findings 2, 4) [code] | O6, O7, O8 | fixed |
| 6 | Debug | Reads a failing guard | Plan specifies actionable text only for the function-size guard [plan] | O9: one failure format for every new guard, with docs anchor | fixed |
| 7 | Upgrade (rebase) | Open-PR author rebases onto the wave | E2 map + porting guide promised but format, location and durability unspecified; squash merge erases the move-only commits [plan][code] | O11, O12 | fixed |
| 8 | Scale | 50 concurrent PRs add migrations/functions | Sequential migration numbers collide; function-size baseline keyed by line would churn [plan] | D12, D19, O10 | fixed (collision stays loud, not prevented; timestamps deferred) |
| 9 | Migrate (downstream) | Importer of `gbrain/*` exports upgrades | `test/public-exports.test.ts` pins only 1-3 canaries per subpath [code] | O13: full export-surface golden | fixed |

### 0G. First-time developer confusion report (plan as written)

```
FIRST-TIME DEVELOPER REPORT
Persona: AI coding agent, first PR after the wave
Attempting: add migration v176 + a doctor check for it

T+0:00  CLAUDE.md: "Schema DDL lives in the MIGRATIONS array in src/core/migrate.ts". Opens migrate.ts.
        ~700 lines of runner, no array. [addressed: O2]
T+0:03  grep "migrations/index.ts": two hits, src/commands/migrations/ (app-version, `v0_21_0.ts`)
        and src/core/migrations/. Edits the first one; its `Migration` type has a different shape;
        typecheck fails with a type error, not a routing hint. [addressed: D11, O1]
T+0:10  Creates src/core/migrations/v176_add_x.ts (underscore, like the other dir). Generator
        rejects or silently mis-sorts? Plan does not specify the filename rule. [addressed: D12]
T+0:14  Freshness guard: "index.ts is stale". Which command? Plan names the pattern
        (check-tool-catalog-fresh.sh prints "To regenerate: ..."), not the command. [addressed: O9]
T+0:18  Adds the check to doctor/checks/brain/?? Plan says "grouped by doctor-categories.ts";
        existing dir is flat. [addressed: D15]
T+0:22  Forgets to add the name to doctor-categories; today that is a runtime
        "unknown check name" warning, not a failure. [addressed: O5]
T+0:30  verify green. CI green. A later PR's stale PGLite snapshot passes because the cache key
        lists helper files by hand. [addressed: O7]
Final:  Succeeded in ~30 min with two wrong turns; would be ~15-20 min with O1/O2/D11/D12/O9.
```

### TTHW assessment (per change kind, [est], AI agent, clock from 0C)

| Change kind | Before (master) | After plan as written | After plan + obligations | Main lever |
|---|---|---|---|---|
| New storage method (migrated domain) | 60-90 min: interface + 2 SQL dialects + 2 façade delegations + parity e2e; JSONB trap hidden on PGLite | 35-45 | 20-30 | one SQL copy (W1) + O3/O14 |
| New storage method (unmigrated domain) | 60-90 | 60-90 + "which pattern?" doubt | 60-90, doubt removed | O3 (honest residual) |
| New schema migration | 45-75: 7k-line append + up to 3 schema copies + 2 bootstraps | 25-35 | 15-25 (10-15 with D8 scaffold) | W2/W3 + D11/D12/O9 |
| New doctor check | 25-40: find position in 3,444-line `buildChecks` | 15-25 | 10-20 | registry + O5 |
| New CLI-only command | 20-30: case + CLI_ONLY + help + `build:flag-registry` | 15-20, or broken if the generator isn't re-targeted | 10-20 | O6 |
| New admin HTTP route | 30-45 inside 2,251-line closure; auth enforced by a scan of one file | 20-30 | 10-20 | D10 + O8 |
| New sync phase | 60-120: 46 closure `let`s | 30-45 | 25-40 | `SyncRun` + O9 destructuring guard text |

Weighted current trajectory ≈ **55 min (Needs Work)**; plan as written ≈ **35 min**; with obligations ≈ **20-25 min
(Competitive)** for migrated areas. Target: **≤ 30 min, Competitive**. Verification: O18 dry-run (taste D37).

---

## Pass 1: Getting Started (Zero Friction) — 5/10 → 8/10

What a 10 looks like here: for each change kind, one table row in CONTRIBUTING.md names the file to create, the
registry to touch, the one regenerate command, and the one test to run; CLAUDE.md never contradicts it; the gate
catches the rest.

Findings:
1. **No per-kind recipe** [plan]. The Docs workstream updates reference docs but never tells a contributor "to add X,
   do Y". CONTRIBUTING has recipes only for operations and CLI commands, and the CLI one becomes wrong.
   → **D6 (Mechanical): add a "Where does my change go?" table to CONTRIBUTING.md** covering the six kinds (O1).
2. **Always-loaded instructions contradict the new layout** (finding 8) [code]. Agents follow CLAUDE.md literally.
   → **D7 (Mechanical): update CLAUDE.md invariants + CONTRIBUTING tree/recipes + ENGINES.md + rls-and-you.md +
   infra-layer.md in the same PR, then `bun run build:llms`** (O2).
3. **Mixed migration state is invisible** [plan]. After W1-core, 5 domains are single-SQL and 7 are not.
   → **D9 (Mechanical): one source of truth** (the SQL-in-engine guard's baseline/config) listing migrated domains and
   methods; its failure text and the engines key-files entry print that list (O3).
4. **Migration creation is still hand-typed** (version = max+1, filename, export shape).
   → **D8 (Taste, recommend include): `--new <snake_name>` flag on the registry generator** writes the next-version file
   skeleton and regenerates the index. About 1-2 h CC, inside the accepted generator. It turns the most common schema
   change into one command, which is what every peer in 0C offers.

Stripe test (can the persona go from "never touched this area" to "it worked" in one terminal session?): yes after
O1-O3, because the recipe row plus the guard text substitute for reading the architecture docs.

## Pass 2: API/CLI/SDK Design (internal module API) — 5/10 → 8/10

Test: can the persona put a change in the right place after seeing one example? Naming consistency wins.

5. **`-routes` suffix contradicts the real convention** (finding 1). → **D10 (Mechanical): route modules are
   `src/commands/serve-http-<area>.ts` exporting `mount<Area>(app, deps)`**; extend the existing `serve-http-oauth.ts`
   and `serve-http-metrics.ts` instead of creating siblings; new areas: `serve-http-admin.ts`, `serve-http-mcp.ts`,
   `serve-http-spa.ts`. `requireAdmin` keeps being passed in, as `mountAdminClients` does today.
6. **`src/core/migrations/` collides with `src/commands/migrations/`** (finding 6). → **D11 (Taste, recommend):
   `src/core/schema-migrations/`**. "schema migration(s)" is already the repo's word (85 hits across docs/src vs 10 for
   "orchestrator migration"). The `Migration` type stays exported from `migrate.ts` under its current name (47 importers
   of `MIGRATIONS`), so no import site changes.
7. **Filename rule unspecified** [plan]. → **D12 (Mechanical): `v<NNN>-<name-with-dashes>.ts`, NNN zero-padded to 3**
   (`v002-slugify-existing-pages.ts`). The generator asserts the file's `version` field equals NNN and its `name`
   field equals the slug with `-`→`_`, and fails with a fix line otherwise. Two sources of the version (filename and
   field) are allowed only because the generator checks them against each other.
8. **`src/core/store/` sits beside `src/core/storage/` and `storage.ts`** (blob backends S3/Supabase/local) and
   `src/core/persistence/` (write journal), three near-synonyms with unrelated meanings [code]. → **D13 (Taste,
   recommend): `src/core/engine-sql/`**, which lists next to `pglite-engine/` and `postgres-engine/` and says what it
   holds. Adapters inside: `engine-sql/executor.ts`, `engine-sql/dialect-postgres.ts`, `engine-sql/dialect-pglite.ts`,
   domains as `engine-sql/<domain>.ts` matching the existing per-engine filenames (`facts.ts`, `takes.ts`, ...).
9. **Two executors, no rule** (finding 7). → **D14 (Mechanical): document one decision table** in the engines
   key-files entry and ENGINES.md: `sqlQueryForEngine` = narrow scalar-only seam for auth/admin/OAuth (unchanged,
   its narrowness is a documented feature); `engine-sql` executor = storage-domain SQL; `engine.executeRaw` = one-off
   maintenance SQL. The new executor reuses `SqlValue` and `executeRawJsonb` from `sql-query.ts` (plan A1 already says
   so) rather than redefining them.
10. **Doctor "grouped by doctor-categories.ts" is ambiguous** [plan] and a `{name, category, run}` entry would
    duplicate `categorizeCheck` [code]. → **D15 (Mechanical): keep flat topic-named `doctor/checks/<topic>.ts`; registry
    entries are `{name, run}`; category is derived from `categorizeCheck(name)`**. The W0 golden still records ordered
    names + categories.
11. **Command table vs lazy loading** [code]: every `case` today does `await import('./commands/x.ts')`, which is why
    `gbrain --version` is fast. → **D16 (Mechanical): table entries are lazy loaders `() => import('./commands/x.ts')`**,
    never static imports; the flag-registry generator reads the table (O6).
12. **Sync placement** [code]: sync code already lives in `src/core/sync-*.ts` (12 files) and `src/commands/sync-*.ts`
    (3 files). → **D17 (Mechanical): accept `src/commands/sync/`** (matches `doctor/`, `skillpack/`, `connectors/`
    command dirs) with a one-line rule in the key-files entry: CLI-run orchestration phases in `src/commands/sync/`,
    reusable library code in `src/core/sync-*.ts`.
13. **SQL-in-engine guard keyed on "migrated methods" lets new methods regrow dual SQL** [plan]. A brand-new method in
    the `facts` domain written with inline SQL in both engines passes a guard that only watches listed methods. →
    **D18 (Taste, recommend): make it a ratchet over all engine methods**: a baseline TSV lists methods still allowed
    to contain SQL (unmigrated + dialect-specific, each with a one-line reason); the list only shrinks; new methods
    default to no SQL. This is the pit of success for the primary persona and mirrors the W5 function-size ratchet.
14. **Function-size baseline key** [plan]. Line-keyed rows would churn on every unrelated edit and conflict across 50
    PRs. → **D19 (Mechanical): key = `path<TAB>name-path`** built from declarations, property names and call context
    (`runServeHttp>app.post('/mcp')`, `MIGRATIONS[v131].handler`), never line numbers; the guard prints the key it
    computed so a contributor can copy it; stale-slack and shrink rules mirror `check-module-size.sh`; one row per
    function, sorted, one-line justification.
15. **Move-only commit identification unspecified** [plan]. → **D20 (Mechanical): git trailer `Move-Only: yes`**;
    `scripts/verify-move-only.ts` checks exactly the commits carrying it and the PR lists them.

## Pass 3: Error Messages & Debugging — 5/10 → 8/10

Three traced paths, what the persona sees vs should see:

**Path A: duplicate migration version after rebase** (plan: "the generator fails on duplicates, so two concurrent
branches ... fail loudly").
- Currently specified: "fail loudly", no text.
- Should see:
  ```
  FAIL: schema migration version 176 is defined twice:
        src/core/schema-migrations/v176-add-widget-index.ts  (on origin/master)
        src/core/schema-migrations/v176-add-alias-table.ts   (this branch)
  Why:  versions are applied in order and recorded in schema_version; two files cannot share one.
  Fix:  git mv src/core/schema-migrations/v176-add-alias-table.ts src/core/schema-migrations/v177-add-alias-table.ts
        set `version: 177` inside it, then run: bun run build:schema-migrations
  See:  docs/TESTING.md#schema-migration-registry
  ```

**Path B: SQL added to an engine method** (plan: "a guard that rejects SQL keywords ... inside migrated engine methods").
- Should see:
  ```
  FAIL: src/core/postgres-engine.ts:1234 PostgresEngine.countFactsBySource contains SQL ("SELECT ... FROM facts").
  Why:  facts is an engine-sql domain; its SQL lives once in src/core/engine-sql/facts.ts so both engines run the same text.
  Fix:  move the query to src/core/engine-sql/facts.ts and make both engine methods one-line delegations
        (example: PGLiteEngine.listFacts). If the SQL is genuinely dialect-specific, add a row with a reason to
        scripts/engine-sql-baseline.tsv.
  See:  docs/TESTING.md#engine-sql-ratchet
  ```

**Path C: `/admin` route without `requireAdmin`** (existing test's message today names the route and the allowlist file,
which is good). After the move it must name the module file and line where the registration lives, not
`serve-http.ts`, and it must see routes in every `serve-http-*.ts` module (O8).

Findings:
16. **→ D21 (Mechanical): one failure format for every new or re-pointed guard**: `FAIL: <file:line> <what>` /
    `Why: <cause>` / `Fix: <exact edit or command>` / `See: docs/TESTING.md#<anchor>`, most actionable line first. Applies
    to function-size, engine-sql ratchet (D18), engine-sql dynamic-SQL scanner (A2b), schema-migrations registry
    freshness + duplicates + filename rule, schema freshness (W2a), snapshot-hash inputs (A6), `verify-move-only`, the
    sync mutable-destructuring guard, the admin route guard. Existing guards already do most of this
    (`check-module-size.sh`, `check-tool-catalog-fresh.sh` print the fix), so this is consistency, not invention (O9).
17. **→ D22 (Mechanical)**: Path A text above is the required duplicate-version message.
18. **Driver error identity** (finding 9). → **D23 (Mechanical): the executor passes driver errors through unwrapped**;
    the E5 contract test asserts error class, `.code` and message for a unique violation (23505), a statement cancel
    (57014) and a deadlock-shaped error through `isDeadlockError`, on both engines (O14).
19. Sync destructuring guard text must say why: "destructuring `run.cursor` copies a value that later phases mutate;
    read `run.cursor` at the use site". Covered by D21.
20. Runtime CLI/MCP errors: behavior-preserving, pinned by A16b goldens. No issues beyond D23.

## Pass 4: Documentation & Learning — 4/10 → 8/10

21. **Docs list misses the files agents actually read** (finding 8). → covered by **D7/O2**.
22. **Porting guide format unspecified** [plan]. → **D24 (Mechanical): the porting guide has one recipe per conflict
    kind** (edited a moved function body; added an engine method in a migrated domain; added a migration; added a doctor
    check; added a route; added a CLI command), each with the new file, the command and the check to run; the E2 map is
    emitted **both as a markdown table and as JSON** (`{old: "path:fn", new: "path:fn", kind: "moved|split|delegated"}`)
    so agents can consume it; and a copy-paste "Say to your agent" prompt ("Rebase this PR onto master. Use the
    moved-symbol JSON in the wave PR to relocate each conflicting hunk, then run `bun run verify`."). Location: PR body +
    pinned PR comment; the CHANGELOG entry links the PR. Not in reference docs, which must describe current state only
    (`check-key-files-current-state.sh`).
23. **key-files size caps** [code]: `check-key-files-current-state.sh` fails on size growth. → **D26 (Mechanical): split
    a subsystem page at a useful boundary rather than raising its cap** when adding engine-sql / schema-migrations /
    serve-http module entries.
24. The ASCII diagram (store → executor → dialect adapter) is in plan; keep it in the engines key-files entry and ENGINES.md,
    renamed per D13.

## Pass 5: Upgrade & Migration Path — 6/10 → 8/10

25. **Downstream export surface pinned only by canaries** [code]: `test/public-exports.test.ts` checks 0-3 symbols per
    subpath; `check-exports-count.sh` checks the count (27). → **D27 (Mechanical): W0 export-surface golden** for every
    `exports` subpath whose module is touched (`.`, `engine`, `types`, `operations`, `minions`, `pglite-engine`,
    `search/hybrid`, `engine-factory`): sorted runtime export names plus the prototype method names of `PGLiteEngine` and
    `PostgresEngine`; byte-identical on the final candidate (O13). `migrate.ts` keeps exporting `MIGRATIONS`,
    `LATEST_VERSION` and `Migration` (47 importers).
26. **Forwarding exports** [plan: "where useful"]. → **D28 (Mechanical): every moved exported symbol stays importable
    from its old module** for this release, per CLAUDE.md "peeled façades keep their surface"; "where useful" becomes
    "always". This is what makes most open PRs' imports survive the rebase.
27. **Squash merge erases the move-only commits** [code: master history is squash-only, e.g. `(#5684)` subjects]. Future
    `git blame` on every moved line points at one wave commit. → **D25 (Taste, recommend): the squash commit body carries
    the file-level move summary and a link to the JSON map**, so `git log --grep` finds it later. Rejected:
    `.git-blame-ignore-revs` for the squash, because it also contains behavior commits and would hide real changes.
28. **Generated artifacts must not drift** [code]. → **D29 (Mechanical): zero diff** in
    `src/core/cli-flag-registry.generated.ts`, `docs/TOOL_CATALOG.md`, the admin build and `llms*` except doc edits;
    `schema-embedded.generated.ts` may change only as W2 intends, with E4 as proof (O6).
29. Versioning: one PATCH bump (owner rule). No deprecations needed because nothing public is removed. No issues.

## Pass 6: Developer Environment & Tooling — 5/10 → 8/10

30. **Hidden path consumers** (finding 5). → **D30 (Mechanical): path-consumer inventory before the first move.**
    `rg -l` over `scripts/`, `.github/`, `test/helpers/`, `docs/` for every file being split, committed as a checklist
    in the PR. For each scanner guard that names a moved file, extend its inputs to the new dirs and add a bad fixture
    that lives in the new dir, proving it still fires: `check-jsonb-pattern.sh` (+ `src/core/schema-migrations/`),
    `check-engine-dynamic-import.sh` (+ `schema-migrations/`, `engine-sql/`), `check-source-config-leak.sh`,
    `check-no-legacy-getconnection.sh`, `check-operations-filter-bypass.sh`. `select-e2e.ts` gets
    `src/core/schema-migrations/` as an escape-hatch prefix; `e2e-test-map.ts` maps `src/core/engine-sql/` the way it maps
    the engine files today, so store PRs keep the selector's speed (O16).
31. **11 snapshot cache-key homes and a hand-kept hash list** (finding 2) [code: `pglite-engine.ts:348` list,
    `computeSnapshotSchemaHash`]. → **D31 (Mechanical)**: one unit test reads both workflows and asserts all 11 keys
    are byte-identical and cover every file in the hash list, and that the hash list covers the transitive relative
    imports of `schema-migrations/index.ts` and the generated schema. Failure names the missing file and both places to
    add it (O7).
32. **Flag registry** (finding 4). → covered by **D16/O6**: re-target `generate-flag-registry.ts` to the command table,
    add `src/commands/sync/` (and any `jobs`/`autopilot` dir if they land) to `facadeExpansion`, and prove it by D29's
    zero diff.
33. **Existing admin-route guard** (finding 3). → **D32 (Mechanical): extend `test/serve-http-admin-route-guard.test.ts`**
    to scan the façade plus every `serve-http-*.ts` module (or switch it to runtime route-table introspection shared with
    the W0 golden), keep its 7-entry allowlist, add `/metrics` and `/admin/events` coverage; no second parallel invariant
    test (O8).
34. **Source-reading test ratchet** [code: `test/test-reads-source-smell.test.ts`]. A10's new per-surface loaders are
    read sites. → **D33 (Mechanical)**: each loader read carries `// test-reads-source-ok[structural]: ...`; grandfathered
    counts are only lowered (O17).
35. **Guard runtime** [code: `TIMEOUT=120` per check]. A TypeScript-AST function-size scan over 1,473 src files is the
    heaviest new check. → **O15**: each new guard's wall time on the 4-core machine is recorded in the PR; target under
    15 s each.

## Pass 7: Community & Ecosystem — 6/10 → 7/10

36. Landing window + announcement are in the plan [plan]; content is not. → **D34 (Mechanical): the announcement names
    the dates, the frozen path list, the porting guide + JSON map link, the agent prompt from D24, and where to ask
    (the pinned PR comment)**. Generic placeholders only.
37. DX input to the pending CEO user challenge UC1 (W1 breadth), not reopened: from a contributor's view, fewer
    half-migrated domains is better, so W1-extended domains should land only when their baseline rows (D18) are removed
    in the same commit, never as partial domains. **D35 (Mechanical, advisory)**.
38. Welcome-PRs list in CONTRIBUTING ("Additional engine implementations") becomes easier after W1: adding an engine is
    a dialect adapter + the dialect-specific baseline methods. Update the "Adding a new engine" section as part of O2.

## Pass 8: DX Measurement & Feedback Loops — 5/10 → 7/10

39. Plan (e) re-measures fix-commit causes at +3 months; nothing measures the contributor journey. → **D36 (Taste,
    recommend): add four git/GitHub-derived numbers to the same +3-month re-measure**, no telemetry: (i) share of
    storage PRs editing both engine files, (ii) conflicts on target paths per merged PR, (iii) engine-sql and
    function-size baseline rows remaining, (iv) median time for window PRs to rebase and merge after the wave.
40. Boomerang: no way to check the TTHW target. → **D37 (Taste, recommend): one TTHW dry-run before merge**: a fresh
    agent session with only CONTRIBUTING.md adds one change of each kind on a scratch branch; record time and wrong turns
    in the PR (O18). Under 1 day CC.

---

## DX Scorecard

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Initial | Target | Trend |
|----------------------|---------|--------|-------|
| Getting Started      |  5/10   |  8/10  |  ↑3   |
| API/CLI/SDK (module) |  5/10   |  8/10  |  ↑3   |
| Error Messages       |  5/10   |  8/10  |  ↑3   |
| Documentation        |  4/10   |  8/10  |  ↑4   |
| Upgrade Path         |  6/10   |  8/10  |  ↑2   |
| Dev Environment      |  5/10   |  8/10  |  ↑3   |
| Community            |  6/10   |  7/10  |  ↑1   |
| DX Measurement       |  5/10   |  7/10  |  ↑2   |
+--------------------------------------------------------------------+
| TTHW (contributor)   | ~55 min today; ~35 as written | ≤30 target (20-25 est.) |
| Competitive Rank     | Needs Work → Competitive (adapted tiers)     |
| Magical Moment       | designed via guard failure text + recipe table |
| Product Type         | Internal contributor SDK + frozen CLI/MCP contract |
| Mode                 | POLISH                                       |
| Overall DX           |  5.1/10 → 7.8/10                             |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered after O1/O2 (gap as written)            |
| Learn by Doing     | covered: recipes + guard examples (O1, O9)      |
| Fight Uncertainty  | covered after O9/O14 (gap as written)           |
| Opinionated + Escape Hatches | covered: ratchets with justified baseline rows |
| Code in Context    | covered: failure text names an existing example method |
| Magical Moments    | covered after O9 + O1                           |
+====================================================================+
```

No pass is below 6 at target. As written, Documentation (4) is critical DX debt: the always-loaded CLAUDE.md would
instruct agents to write the old pattern on day one. TTHW is not above 10 min in a blocking sense for this clock; the
"today" figure (~55 min) is the problem the plan exists to fix.

## DX Implementation Checklist (adapted to this plan)

```
[ ] Contributor TTHW ≤ 30 min per change kind in migrated areas (O18 dry-run)
[ ] Install unchanged: clone + bun install + bun test still the whole setup
[ ] "Where does my change go?" table in CONTRIBUTING.md, six kinds (O1)
[ ] CLAUDE.md / CONTRIBUTING / ENGINES / rls-and-you / infra-layer truthful; build:llms run (O2)
[ ] Migrated-domain list has one source and is printed by the guard (O3)
[ ] Naming: serve-http-<area>.ts + mount<Area>; schema-migrations/; engine-sql/; flat doctor checks (D10-D15)
[ ] Every new/re-pointed guard: problem + cause + fix + docs anchor, bad/good fixtures, manifest row (O9)
[ ] Executor passes driver errors through unchanged, contract-tested on both engines (O14)
[ ] Flag registry, TOOL_CATALOG, admin build byte-identical (O6)
[ ] 11 snapshot cache keys + hash list covered by one test (O7)
[ ] Admin route guard sees every serve-http module (O8)
[ ] Path-consumer inventory done; each affected scanner proven in the new dirs (O16)
[ ] Export-surface golden byte-identical; old import paths still resolve (O13)
[ ] Porting guide: per-kind recipes + JSON map + agent prompt; squash body links it (O11, O12)
[ ] New guards each < 15 s (O15)
[ ] CHANGELOG entry (one PATCH), generic placeholders only
```

## NOT in scope (DX items considered and deferred)

- Timestamp-based migration versions (Rails/Prisma style). Would change `schema_version` semantics; plan already
  rejects renumbering. Filed as TODO candidate.
- Router-level `requireAdmin` (`express.Router()` + `router.use`). Changes middleware order, which W0 goldens pin.
  Wave 2 candidate.
- Scaffolders for every change kind (doctor check, route, command). Only the migration scaffold (D8) is recommended now.
- `.git-blame-ignore-revs` for the squash (would hide behavior changes).
- Interactive contributor wizard or docs site changes.

## What already exists (reuse, don't rebuild)

- `test/helpers/doctor-source.ts`: containment vs positional loader split; generalize it (A10).
- `test/serve-http-admin-route-guard.test.ts`: the E9 invariant with allowlist, anti-vacuity floor and self-test.
- `scripts/check-tool-catalog-fresh.sh`: freshness pattern that already prints "To regenerate: ...".
- `scripts/check-module-size.sh`: ratchet semantics (growth, stale slack, missing row) to copy for function-size and
  engine-sql baselines.
- `scripts/check-engine-dynamic-import.ts`: TS-AST scanner pattern, marker handling, directory expansion for peeled
  engine modules.
- `scripts/build-schema.sh` + `build:schema`: the schema generator W2a extends.
- `scripts/guards-manifest.tsv` + `scripts/guard-self-test.sh`: registration and bad/good fixture proof.
- `scripts/generate-flag-registry.ts:facadeExpansion`: the hook for peeled command dirs.
- `src/core/sql-query.ts`: `SqlValue`, `executeRawJsonb`.
- `src/core/doctor-categories.ts:categorizeCheck`: single category source.
- `test/public-exports.test.ts` + `check-exports-count.sh`: export contract to extend.
- `scripts/check-test-discriminates.sh`: discrimination proof for the behavior-touching W1 tests.

## TODOS.md candidates (auto-decided)

| What | Decision | Why |
|---|---|---|
| Close `TODOS.md:1868` (3-way schema parity), `:1956` (sync 4a), `:1962`/`:4445` (doctor 4b), `:1976` (migrate-runner extraction) when their workstream lands | Add closure edits in the PR | Plan scope; keeps TODOS truthful |
| Timestamp migration versions | Add P3 TODO | Collision pain grows with PR concurrency; needs schema_version design |
| Router-level admin auth | Add P3 TODO | Structural auth; blocked on middleware-order goldens |
| jobs/hybrid/autopilot decomposition if cut from the window | Add P2 TODO naming the cut | Plan's cut line |
| Scaffolders for doctor check/route/command | Skip | Wait for O18 dry-run evidence |

---

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| D1 | Step 0 | Product type = internal contributor SDK + frozen CLI/MCP contract | Mechanical | Explicit | Plan changes no public surface; contributors are the users | Classifying as CLI tool |
| D2 | 0A | Personas as given by parent (agent contributor; conflicting-PR author; downstream importer/user) | Mechanical | Completeness | Parent-specified; code confirms ~51 open PRs and 27 exports | — |
| D3 | 0E | Mode DX POLISH | Mechanical | Bias to action | Parent-specified | EXPANSION/TRIAGE |
| D4 | 0C | Clock = clone → verify-green PR-ready change; target Competitive ≤30 min | Taste | Pragmatic | Matches plan's goal; Champion needs scaffolders for all kinds | Champion <15 |
| D5 | 0D | Magical moment via guard failure text + recipe table | Taste | Explicit | Uses existing gate; no new surface | Contributor wizard |
| D6 | P1 | Add "Where does my change go?" table (6 kinds) to CONTRIBUTING.md | Mechanical | Completeness | No per-kind recipe exists for 5 of 6 kinds | Rely on KEY_FILES |
| D7 | P1 | Update CLAUDE.md invariants, CONTRIBUTING, ENGINES.md, rls-and-you.md, infra-layer.md + build:llms | Mechanical | Completeness | Always-loaded text becomes false (finding 8) | Update only KEY_FILES |
| D8 | P1 | `--new <name>` migration scaffold on the registry generator | Taste | Boil lakes | 1-2 h CC inside accepted tool; peers all scaffold | Hand-typed files only |
| D9 | P1 | One source of truth for migrated domains, printed by guard + key-files | Mechanical | DRY, explicit | Mixed state is invisible otherwise | Tribal knowledge |
| D10 | P2 | `serve-http-<area>.ts` + `mount<Area>`; extend existing oauth/metrics files | Mechanical | Consistency | Plan's `-routes` "convention" does not exist | `-routes` suffix |
| D11 | P2 | `src/core/schema-migrations/` | Taste | Explicit, consistency | Collides with `src/commands/migrations/` registry + type | `src/core/migrations/` |
| D12 | P2 | Filename `v<NNN>-<dash-name>.ts`; generator cross-checks version + name | Mechanical | Explicit | Guessable; two sources checked against each other | Underscore names; version from filename only |
| D13 | P2 | `src/core/engine-sql/` | Taste | Explicit, consistency | `store/` next to `storage/` + `persistence/` misleads | `src/core/store/` |
| D14 | P2 | Document executor choice table; reuse `SqlValue`/`executeRawJsonb` | Mechanical | DRY, explicit | Two executors coexist | Silent coexistence; merging the narrow seam |
| D15 | P2 | Flat `doctor/checks/<topic>.ts`; registry `{name, run}`; category from `categorizeCheck` | Mechanical | DRY, consistency | 32 flat modules exist; category has one source | Category subdirs; category field in entry |
| D16 | P2 | Command table of lazy loaders; generator reads table | Mechanical | Pragmatic | Preserves cold start + flag registry | Static-import table |
| D17 | P2 | Accept `src/commands/sync/` with placement rule | Mechanical | Consistency | Matches doctor/skillpack/connectors dirs | `src/core/sync/` |
| D18 | P2 | Engine-SQL guard = ratchet over all engine methods, shrinking baseline | Taste | Completeness, pit of success | Method-list guard lets new dual-SQL methods in | Migrated-methods-only guard |
| D19 | P2 | Function-size key = name path, no line numbers; guard prints key | Mechanical | Explicit | Line keys churn and conflict across 50 PRs | Line-keyed baseline |
| D20 | P2 | `Move-Only: yes` trailer marks move-only commits | Mechanical | Explicit | verify-move-only needs a target set | Heuristic detection |
| D21 | P3 | One failure format (FAIL/Why/Fix/See) for every new or re-pointed guard | Mechanical | Explicit | Existing guards already mostly do this | Per-guard ad hoc text |
| D22 | P3 | Duplicate-version message includes git mv + regen recipe | Mechanical | Completeness | Most frequent collision for 50 open PRs | "fail loudly" only |
| D23 | P3 | Executor passes driver errors unwrapped; contract-tested | Mechanical | Completeness | 281 core files read `.code` | Wrapping in a store error |
| D24 | P4 | Porting guide: per-kind recipes, markdown + JSON map, agent prompt; PR body + pinned comment | Mechanical | Completeness | Agents are the primary rebasers | Prose-only guide |
| D25 | P5 | Squash body carries move summary + map link | Taste | Pragmatic | Squash erases move commits | blame-ignore-revs |
| D26 | P4 | Split key-files pages instead of raising caps | Mechanical | Consistency | Existing guard + rule | Raise caps |
| D27 | P5 | W0 export-surface golden incl. engine prototype methods | Mechanical | Completeness | Canary test pins 0-3 names per subpath | Canary only |
| D28 | P5 | Forwarding exports always, not "where useful" | Mechanical | Consistency | CLAUDE.md façade rule; open-PR imports survive | Case-by-case |
| D29 | P5 | Zero diff in generated artifacts (flag registry, TOOL_CATALOG, admin build) | Mechanical | Explicit | Cheap byte-level proof of no contract change | Trust goldens only |
| D30 | P6 | Path-consumer inventory + scanner fixtures in new dirs | Mechanical | Completeness | ≥35 scripts/workflows hardcode moved paths | Fix as CI fails |
| D31 | P6 | One test over all 11 cache-key homes + transitive hash inputs | Mechanical | DRY | Plan lists 2 of 11 homes | Hand-edit 2 lines |
| D32 | P6 | Extend existing admin-route guard test; keep its 7-entry allowlist | Mechanical | DRY | E9 already exists | New parallel test, 3-entry list |
| D33 | P6 | Tag A10 loader reads; only lower smell ratchet | Mechanical | Consistency | Existing rule | Grandfather new reads |
| D34 | P7 | Announcement content spec | Mechanical | Completeness | Plan says "announce" only | Free-form |
| D35 | P7 | W1-extended domains land whole, removing baseline rows in the same commit (advisory to UC1) | Mechanical | Explicit | Avoid half-migrated domains | Partial domains |
| D36 | P8 | Add 4 git-derived contributor metrics to the +3-month re-measure | Taste | Pragmatic | Measures the plan's actual DX goal, no telemetry | Telemetry; nothing |
| D37 | P8 | Pre-merge TTHW dry-run by a fresh agent | Taste | Bias to action | Only way to check D4 target | Skip |

## Taste decisions (surface at the final gate; all auto-chosen as recommended)

1. **D4** target Competitive ≤30 min (vs Champion).
2. **D5** magical moment = guard text + recipe table.
3. **D8** include the migration scaffold flag.
4. **D11** `src/core/schema-migrations/` (vs plan's `src/core/migrations/`).
5. **D13** `src/core/engine-sql/` (vs plan's `src/core/store/`).
6. **D18** engine-SQL guard as all-method ratchet (vs migrated-methods-only).
7. **D25** move summary in the squash commit body.
8. **D36** contributor metrics in the +3-month re-measure.
9. **D37** pre-merge TTHW dry-run.

User Challenges: none new from this phase. UC1 (W1 breadth) stays pending from CEO; D35 is advisory input.

---

## ACCEPTED OBLIGATIONS (add to the plan)

| ID | Requirement | Verification |
|---|---|---|
| O1 | CONTRIBUTING.md gains a "Where does my change go?" table: for storage method, schema migration, doctor check, CLI-only command, HTTP route, sync phase: file to create/edit, registry to touch, the one regenerate command, the test to run. Old "Add the case to `src/cli.ts`" step replaced. | Review; `test/docs-cli-commands.test.ts` passes for any `gbrain` commands in it; O18 dry-run uses only this table |
| O2 | Same PR updates CLAUDE.md (Engine parity, Migrations, Module-size `region-exempt` line, Peeled façades list incl. `engine-sql/`, `schema-migrations/`, `commands/sync/`, serve-http modules), CONTRIBUTING project tree + "Adding a new engine", `docs/ENGINES.md`, `docs/guides/rls-and-you.md:124`, `docs/architecture/infra-layer.md:16`, `KEY_FILES.md` + `key-files/*`; then `bun run build:llms`. | `rg -n "MIGRATIONS\` array\|MIGRATIONS array\|lands in BOTH\|Add the case to" CLAUDE.md CONTRIBUTING.md docs/` returns no stale hits; `bun test test/build-llms.test.ts`; `check-key-files-current-state.sh` green without raised caps |
| O3 | One committed source lists engine-sql domains and remaining SQL-bearing engine methods (the D18 baseline TSV); guard failure text and the engines key-files entry print it. | Guard bad fixture output contains the domain list; key-files entry references the TSV path |
| O4 | Naming per D10-D17: `serve-http-<area>.ts`/`mount<Area>`, `src/core/schema-migrations/v<NNN>-<name>.ts`, `src/core/engine-sql/`, flat `doctor/checks/<topic>.ts` with `{name, run}` entries, lazy-loader command table, `src/commands/sync/`. | Review against this list; generator rejects a bad filename (fixture) |
| O5 | Doctor registry test fails when an entry's name is not categorized by `categorizeCheck`, with FAIL/Why/Fix/See text naming `src/core/doctor-categories.ts`. | Bad fixture/unit test with an uncategorized name fails; good passes |
| O6 | `scripts/generate-flag-registry.ts` reads the new command table and `facadeExpansion` covers every new command dir; `src/core/cli-flag-registry.generated.ts`, `docs/TOOL_CATALOG.md` and the admin build are byte-identical to master. | `git diff master -- src/core/cli-flag-registry.generated.ts docs/TOOL_CATALOG.md` empty after regeneration; `bun test test/cli-flag-validation.test.ts`; `check:tool-catalog`, `check:admin-build` green |
| O7 | One unit test asserts the 11 `pglite-snapshot-*` cache keys in `e2e.yml`/`test.yml` are byte-identical, cover every file in `computeSnapshotSchemaHash`'s list, and that the list covers the transitive relative imports of `schema-migrations/index.ts` and the generated schema. Failure names the missing file and both places to add it. | Discrimination: remove one helper from the list → test fails naming it; restore → passes |
| O8 | `test/serve-http-admin-route-guard.test.ts` scans the façade plus every `src/commands/serve-http-*.ts` (or runtime route introspection shared with the W0 route golden), keeps the existing 7-entry allowlist, adds `/metrics` and `/admin/events`, reports module file:line. | Mutation: drop `requireAdmin` from one route in a moved module → fails with that file:line; anti-vacuity floor ≥ master count |
| O9 | Every new or re-pointed guard (function-size, engine-sql ratchet, engine-sql dynamic-SQL, schema-migrations registry/duplicate/filename, schema freshness, snapshot hash, verify-move-only, sync destructuring, admin route) prints `FAIL: <file:line> <what>` / `Why:` / `Fix: <exact edit or command>` / `See: docs/TESTING.md#<anchor>`; each has a TESTING.md subsection, a `guards-manifest.tsv` row (`selftest=yes` for scanners) and bad/good fixtures. | `bun run check:guard-self-test`; a unit test per guard asserts the four labels appear in bad-fixture output |
| O10 | Duplicate-version failure prints the two files and the `git mv` + `version:` + regenerate recipe (Path A text). Function-size baseline keyed by name path (D19); guard prints computed key. | Fixture with two v176 files; fixture shifting a function down 10 lines leaves the baseline untouched |
| O11 | E2 map emitted as markdown and JSON; porting guide has one recipe per conflict kind plus a copy-paste agent prompt; lives in PR body + pinned comment; announcement (D34) links it. | PR body review; JSON parses and every `old` entry resolves to an existing `new` path:function on the candidate |
| O12 | Squash commit body carries the file-level move summary and the map link; move-only commits carry `Move-Only: yes` and pass `scripts/verify-move-only.ts`. | `git log --format=%B` on the candidate; verify-move-only output in PR |
| O13 | W0 export-surface golden: sorted runtime export names for each touched `exports` subpath plus `PGLiteEngine`/`PostgresEngine` prototype method names; byte-identical on the final candidate. Every moved exported symbol still importable from its old module. `migrate.ts` still exports `MIGRATIONS`, `LATEST_VERSION`, `Migration`. | Golden test; `bun test test/public-exports.test.ts`; typecheck of all 47 `MIGRATIONS` importers unchanged |
| O14 | Executor contract (A1/E5) adds error pass-through: class, `.code` and message identical to today for 23505, 57014 and a deadlock-shaped error via `isDeadlockError`, on PGLite, direct Postgres and PgBouncer. | E5 contract test; `check-test-discriminates.sh` with a wrapping executor shows it fails |
| O15 | Each new guard's wall time on the 4-core machine recorded in the PR; target < 15 s each, and `bun run verify` total grows by < 20%. | Timings in PR body from `run-verify-parallel.sh` logs |
| O16 | Path-consumer inventory (`rg -l` for each split file over `scripts/`, `.github/`, `test/helpers/`, `docs/`) committed as a PR checklist before the first move; every scanner naming a moved file is extended to the new dirs with a bad fixture inside the new dir; `select-e2e.ts` escape-hatch covers `src/core/schema-migrations/`; `e2e-test-map.ts` maps `src/core/engine-sql/`. | Guard self-test with new-dir fixtures; `bun run ci:select-e2e` on a synthetic change under each new dir selects the expected files |
| O17 | A10 loader reads carry `test-reads-source-ok[structural]` markers; `test-reads-source-smell` grandfathered counts only decrease. | `bun test test/test-reads-source-smell.test.ts` |
| O18 | Pre-merge TTHW dry-run (taste D37): fresh agent session with only CONTRIBUTING.md adds one change of each kind on a scratch branch; time and wrong turns recorded in the PR; any wrong turn fixed in docs or guard text before merge. | PR section with six timings; target ≤ 30 min each for migrated areas |
| O19 | +3-month re-measure (taste D36) adds: share of storage PRs editing both engine files, conflicts on target paths per merged PR, remaining baseline rows (engine-sql, function-size), median rebase-to-merge time for window PRs. | TODOS entry with the four queries; recorded at +3 months |
| O20 | Public artifacts (CHANGELOG, PR body, porting guide, docs, fixtures) use generic placeholders only; one PATCH version. | `check-privacy.sh`, `check-fixture-privacy.sh`; version gate |

## Implementation Tasks

- [ ] **T1 (P1, human: ~3h / CC: ~30min)** — docs — Update always-loaded and contributor docs for the new layout
  - Surfaced by: Pass 1 finding 2 / pre-audit finding 8
  - Files: CLAUDE.md, CONTRIBUTING.md, docs/ENGINES.md, docs/guides/rls-and-you.md, docs/architecture/infra-layer.md, docs/architecture/key-files/*, llms.txt, llms-full.txt
  - Verify: stale-phrase `rg` empty; `bun test test/build-llms.test.ts`; `bash scripts/check-key-files-current-state.sh`
- [ ] **T2 (P1, human: ~2h / CC: ~20min)** — docs — "Where does my change go?" recipe table
  - Surfaced by: Pass 1 finding 1
  - Files: CONTRIBUTING.md
  - Verify: O18 dry-run
- [ ] **T3 (P1, human: ~4h / CC: ~45min)** — tooling — Re-target flag-registry generator to the command table and new dirs
  - Surfaced by: pre-audit finding 4, Pass 2 finding 11
  - Files: scripts/generate-flag-registry.ts, src/cli.ts
  - Verify: generated registry zero diff; `bun test test/cli-flag-validation.test.ts`
- [ ] **T4 (P1, human: ~3h / CC: ~30min)** — CI — Snapshot cache-key + hash-input consistency test
  - Surfaced by: pre-audit finding 2, Pass 6 finding 31
  - Files: .github/workflows/e2e.yml, .github/workflows/test.yml, src/core/pglite-engine.ts, test/(new) snapshot-cache-keys.test.ts
  - Verify: discrimination (drop one input → fails)
- [ ] **T5 (P1, human: ~3h / CC: ~30min)** — tests — Extend admin-route guard to all serve-http modules
  - Surfaced by: pre-audit finding 3, Pass 6 finding 33
  - Files: test/serve-http-admin-route-guard.test.ts
  - Verify: mutation drop of `requireAdmin` in a moved module fails with file:line
- [ ] **T6 (P1, human: ~4h / CC: ~40min)** — tooling — Path-consumer inventory and scanner re-pointing with new-dir fixtures
  - Surfaced by: pre-audit finding 5, Pass 6 finding 30
  - Files: scripts/check-jsonb-pattern.sh, scripts/check-engine-dynamic-import.sh, scripts/check-source-config-leak.sh, scripts/check-no-legacy-getconnection.sh, scripts/check-operations-filter-bypass.sh, scripts/select-e2e.ts, scripts/e2e-test-map.ts, test/fixtures/guards/*
  - Verify: `bun run check:guard-self-test`; `bun run ci:select-e2e` on synthetic changes
- [ ] **T7 (P1, human: ~2h / CC: ~20min)** — engine-sql — Executor error pass-through in the E5 contract test
  - Surfaced by: Pass 3 finding 18
  - Files: src/core/engine-sql/executor.ts, test/(E5 contract test)
  - Verify: contract test on PGLite/Postgres/PgBouncer; discrimination with a wrapping executor
- [ ] **T8 (P1, human: ~3h / CC: ~30min)** — tests — Export-surface golden
  - Surfaced by: Pass 5 finding 25
  - Files: test/public-exports.test.ts (or new golden), test/fixtures/goldens/*
  - Verify: golden byte-identical on the final candidate
- [ ] **T9 (P1, human: ~4h / CC: ~40min)** — guards — Uniform FAIL/Why/Fix/See failure text, TESTING.md anchors, manifest rows, fixtures for all new guards
  - Surfaced by: Pass 3 finding 16
  - Files: scripts/check-function-size.ts, scripts/(engine-sql guards), scripts/(schema-migrations generator), scripts/verify-move-only.ts, scripts/guards-manifest.tsv, docs/TESTING.md
  - Verify: per-guard output assertion tests; guard self-test
- [ ] **T10 (P2, human: ~2h / CC: ~20min)** — naming — Apply D10-D17 names (serve-http modules, schema-migrations/, engine-sql/, flat doctor checks, lazy table)
  - Surfaced by: Pass 2 findings 5-12
  - Files: plan text; new module paths
  - Verify: review against O4
- [ ] **T11 (P2, human: ~3h / CC: ~30min)** — guards — Engine-SQL guard as all-method shrinking ratchet with baseline TSV (taste D18)
  - Surfaced by: Pass 2 finding 13
  - Files: scripts/(engine-sql guard), scripts/engine-sql-baseline.tsv
  - Verify: fixture adding a new SQL-bearing method fails; baseline row removal passes
- [ ] **T12 (P2, human: ~2h / CC: ~20min)** — migrations — Filename/version cross-check, duplicate recipe text, `--new` scaffold (taste D8)
  - Surfaced by: Pass 2 finding 7, Pass 3 Path A, Pass 1 finding 4
  - Files: scripts/(schema-migrations generator)
  - Verify: fixtures for duplicate, mismatched name, scaffold output
- [ ] **T13 (P2, human: ~2h / CC: ~20min)** — release — Porting guide, JSON map, agent prompt, announcement, squash-body summary
  - Surfaced by: Pass 4 finding 22, Pass 5 finding 27, Pass 7 finding 36
  - Files: PR body, pinned comment, CHANGELOG.md
  - Verify: JSON map entries resolve on the candidate
- [ ] **T14 (P2, human: ~1h / CC: ~10min)** — tests — Tag A10 loader reads; lower smell ratchet counts
  - Surfaced by: Pass 6 finding 34
  - Files: test/helpers/*-source.ts, test/test-reads-source-smell.test.ts
  - Verify: `bun test test/test-reads-source-smell.test.ts`
- [ ] **T15 (P2, human: ~1h / CC: ~10min)** — perf — Record new-guard wall times
  - Surfaced by: Pass 6 finding 35
  - Files: PR body
  - Verify: each < 15 s
- [ ] **T16 (P2, human: ~4h / CC: ~1h)** — DX — Pre-merge TTHW dry-run (taste D37)
  - Surfaced by: Pass 8 finding 40
  - Files: PR body
  - Verify: six timings ≤ 30 min in migrated areas
- [ ] **T17 (P3, human: ~1h / CC: ~10min)** — TODOS — File +3-month contributor metrics (taste D36) and deferred items
  - Surfaced by: Pass 8 finding 39, NOT-in-scope list
  - Files: TODOS.md
  - Verify: entries present with queries

### Unresolved decisions

None from this phase: every issue was auto-decided (9 taste decisions listed above for the final gate). UC1 (W1 breadth)
remains pending from the CEO phase and is not reopened here.
