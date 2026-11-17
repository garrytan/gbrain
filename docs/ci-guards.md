# CI guards

The guard registry, its self-test and the source guards it runs. Moved out of [TESTING.md](TESTING.md#guard-registry-and-self-test) to keep that file under its size cap.

## Guard registry and self-test

The privacy and test-isolation guards use `scripts/lib/guard-candidates.sh` to
scan fresh file contents in bounded batches before applying their detailed
per-file rules. They do not cache passing results. Candidate scanner failures
fail the guard, and matching files retain the same allowlists and diagnostics.

`scripts/guards-manifest.tsv` is THE single registry of `scripts/check-*`
guards, each classified `scanner` (greps/parses repo sources —
must eventually carry fixtures), `buildfresh`, or `repostate` (build/freshness
guards are exempt-with-reason, not fixture-tested).
`scripts/guard-self-test.sh` (`bun run check:guard-self-test`, wired into
`bun run verify`) proves every `selftest=yes` scanner CAN fail: it runs each
one against known-bad (must exit non-zero) and known-good (must pass) fixture
trees under `test/fixtures/guards/<guard>/{bad,good}/` via the
`GBRAIN_GUARD_ROOT` env seam (guards run 4 at a time, `GUARD_SELF_TEST_JOBS`
overrides; results print in manifest order; the whole pass must finish inside
its 30 s budget), and enforces manifest completeness — a new
`scripts/check-*` script that isn't registered in the manifest fails the
build. A guard whose pattern rots into a permanently-green no-op fails CI
instead of masquerading as coverage.

A guard may carry extra known-bad trees named `bad-<variant>/`; each one must
fail on its own. Refactor wave 1 adds one inside each split module location for
every scanner that names a split file, listed in
[`docs/designs/refactor-wave-1/path-consumers.md`](designs/refactor-wave-1/path-consumers.md).

### Layering guard

`scripts/check-layering.ts` (`bun run check:layering`, in `bun run verify`)
parses every file under `src/core/engine-sql/`, `src/core/schema-migrations/`
and `src/core/persistence/` and fails on any import, type-only included, of an
engine façade (`pglite-engine.ts`, `postgres-engine.ts`, `engine-factory.ts`)
from engine-sql, of `src/core/migrate.ts` from schema-migrations, or of
`src/core/ai/gateway.ts` from persistence. The first two directories are loaded
by the engines and by `migrate.ts`, so an import back up is an ESM cycle that
can fail with a temporal-dead-zone error at module load. Take the executor as a
parameter and import types from `src/core/engine.ts`; migration helpers live in
`schema-migrations/helpers.ts` and the `Migration` type in
`schema-migrations/types.ts`; persistence embeds via `src/core/embedding.ts`.

### Write-path model guards

`scripts/check-ai-sdk-importers.ts` (in `bun run verify`) fails when a file
outside `scripts/ai-sdk-importers.allowlist` imports a provider SDK (`ai`,
`@ai-sdk/*`, `@anthropic-ai/sdk`, `openai`) as a value, so every model call
goes through `invokeAI`. Each mutating op has a write-inference class
(`src/core/ops/write-inference.ts`). `test/write-path-zero-llm.serial.test.ts`
asserts no generative call before commit and only attributed facts extraction
after it; `test/write-path-no-egress.serial.test.ts`: keyless CLI writes open
no connection. Helper: `test/helpers/ai-tripwire.ts`.

### Durable-flush guard

`scripts/check-durable-flush.ts` (`bun run check:durable-flush`, in
`bun run verify`) fails on an `fsyncSync(fd)` anywhere in `src/` outside
`src/core/fs-durable.ts` whose `fd` is assigned from a read-only `openSync`
(flags omitted, a flag string without `w`/`a`/`+`, or `O_RDONLY` without
`O_WRONLY`/`O_RDWR`), file or directory, and on one whose flags it cannot
read: Windows refuses fsync on a read-only handle and has no directory flush
(EPERM; #5595, #5475). Fix: fsync the descriptor you wrote through before
closing it (`fchmodSync(fd)` first for its final mode), or call `flushFile` /
`flushDirectory(path, { bestEffort? })` from `src/core/fs-durable.ts`. A file
that cannot migrate yet goes in the guard's `ALLOWLIST` with a reason; a stale
entry fails. Fixtures: `test/fixtures/guards/check-durable-flush.ts/`. The
#5595/#5475 regressions run natively on the `windows-latest` row of the
test.yml `security-regressions` job; `test/helpers/win32-flush-semantics.ts`
makes them discriminate on POSIX.

### Windows hidden-console guard

`scripts/check-windows-hide.ts` (`bun run check:windows-hide`, in `verify`;
#4992): a runtime `child_process` import or `Bun.spawn*` in `src/` outside
`src/core/spawn.ts` fails unless the file is in `NOT_YET_MIGRATED` (a ratchet;
a stale entry fails); `windowsHide: false` needs an `ALLOWLIST` reason.
`test/windows-hidden-console.test.ts` is the native proof on the same row.

### Engine-sql ratchet

`scripts/check-engine-sql-ratchet.ts` (`bun run check:engine-sql-ratchet`, in
`bun run verify`) keeps each storage domain's SQL in one place,
`src/core/engine-sql/<domain>.ts`, by stopping SQL from growing back into the
engines. It parses `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`
and every file under `src/core/pglite-engine/` and `src/core/postgres-engine/`,
and names each class member (`PostgresEngine.getPage`), top-level function and
top-level variable (`insertFact`). A unit is SQL-bearing when the literal text
of a string, template, tagged template or `+` chain inside it has SQL
structure: `SELECT ... FROM <x>`, `SELECT <fn>(`, `INSERT INTO <x>`,
`UPDATE <x> [alias] SET`, `DELETE FROM <x>`, `WITH <x> AS (`,
`CREATE|ALTER|DROP <object kind>`, `TRUNCATE <x>`, `SET LOCAL <x>`,
`ON CONFLICT`, `WHERE ... ORDER BY|GROUP BY|LIMIT`, or a `$<n>::type` cast.
Comments and identifiers never count. Keywords match in upper or lower case
but never Title Case, and a lowercase match also needs a second SQL signal
(`where`, `returning`, `$1`, `::`, `;`, `*` and similar), so "Select a file"
or "could not delete from cache" is not SQL.

`scripts/engine-sql-baseline.tsv` lists `migrated<TAB><domain>` rows (the
domain's module must exist under `src/core/engine-sql/`) and
`method<TAB><path><TAB><QualifiedName>` rows for the SQL-bearing members that
remain. Rows only shrink. The guard fails on:

- a new SQL-bearing member with no row: move the SQL into
  `src/core/engine-sql/<domain>.ts` and delegate, or mark the declaration (on
  its line or the line above) with `// engine-sql-ok: <reason>`; an empty
  reason fails;
- a stale row, whose member is gone, no longer SQL-bearing or now marked:
  delete it, or run `bun scripts/check-engine-sql-ratchet.ts --prune`, which
  drops stale and duplicate rows and never adds one;
- a duplicate or malformed row, or a `migrated` row with no module.

When a domain moves, delete its members' rows and add its `migrated` row in
the same commit.

### Engine raw-SQL ratchet

`scripts/check-engine-raw-sql-ratchet.ts` (`bun run check:engine-raw-sql-ratchet`,
in `bun run verify`) keeps raw SQL outside the engines from growing while it
moves behind typed engine methods (D6 in `docs/designs/RUST_ENGINE.md`, "Track 2
rules"). It parses every `.ts` file under `src/` except the engines
(`src/core/engine.ts`, `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`,
`src/core/pglite-engine/`, `src/core/postgres-engine/` and
`src/core/engine-sql/`) and counts, per file:

- `execute_raw`: calls named `executeRaw`, `executeRawDirect` or
  `executeRawJsonb`, whatever the receiver (the engine, a transaction, a helper
  that takes `Pick<BrainEngine, 'executeRaw'>`, an executor), with a dot or a
  literal bracket (`e['executeRaw'](...)`);
- `sql_template`: tagged templates whose literal text has SQL structure;
- `driver_call`: `.unsafe(...)`, and `.query(...)` or `.exec(...)` with an
  argument whose literal text has SQL structure.

SQL structure is the engine-sql ratchet's test, so comments and prose never
count. A SQL string held in a variable and passed to `.query(v)` is not seen.

`scripts/engine-raw-sql-baseline.tsv` holds `path<TAB>metric<TAB>count` rows,
with an optional fourth `note` column, generated from the tree (`--print`). A
higher count or a file with no row fails, and so does a lower count until its
row is lowered (`bun scripts/check-engine-raw-sql-ratchet.ts --prune` lowers
stale rows, keeps their notes and never raises one). Instead of a new site,
call a typed engine method, or add one with its SQL in
`src/core/engine-sql/<domain>.ts` (CONTRIBUTING.md "Storage method"). When a
fix must add a site before its area is converted, raise the row (or add it) in
the same PR and write the reason in the note column, as
`scripts/module-size-limits.tsv` does; a reviewer sees the baseline change. A
moved or split file carries its rows with it in the same PR.

### Engine-kind branches

`scripts/check-engine-kind-branches.ts` (`bun run check:engine-kind-branches`,
in `bun run verify`) counts two-way engine branches per file over the same
files: `kind_compare` (`x === 'pglite'`, `x !== 'postgres'`, either side,
where `x` ends in `kind`, `engineKind`, `engine_kind` or `engine`) and
`kind_case` (`case 'pglite':` in a switch over such `x`). A third engine must
not fall silently into one of these branches, so new code asks a capability
question or switches over every engine kind with a `default` clause whose
first statement hands the switched value to a `never` check
(`const unreachable: never = kind;`, `kind satisfies never;`,
`assertNever(kind);`, or `return` / `throw assertNever(kind);`). Such an
exhaustive switch never counts: a third engine fails typecheck there instead.
A check after other statements, inside a nested function, on a shadowing name
or through a cast (`kind as never`) does not exempt a switch. Baseline
`scripts/engine-kind-branches-baseline.tsv`, same rules as above.

### Page body readers

`bun run check:page-body-readers` (in verify): every site that reads or writes
a page body as one string has a row in `scripts/page-body-readers-baseline.tsv`
naming what it must become; rows only shrink. Rules: the script's header.

### Engine-sql dynamic SQL

`scripts/check-engine-sql-dynamic.ts` (`bun run check:engine-sql-dynamic`, in
`bun run verify`) parses every file under `src/core/engine-sql/` except
`fragment.ts`, the renderer, which writes `$n` and splices trusted text by
design. In engine-sql every value reaches SQL as a bound parameter through
`sqlFragment`, and only constant text is spliced. Trusted text is a string
literal; a `const` in the same file initialized with trusted text or an
`as const` object or array literal (members and element accesses included); a
`CONSTANT_ALLOWLIST` name (`ENRICH_ORDER_SQL`); a call to a `VETTED_BUILDERS`
entry (`pageReadFilter`, `buildRecencyComponentSql`,
`privatePagesFilterFragment`, `currentCodeEdgeFilter`, `buildCJKKeywordSql`,
`currentTextProjectionFilter`); a template or `+` chain whose parts are all
trusted or are numbers the same function checked earlier with
`Number.isFinite(<same expression>)`; or a conditional whose branches are both
trusted. Both registries live in the script with a one-line reason each. The
guard fails on:

- `trustedSql(arg)` with an arg that is not trusted text: bind the value with
  `${value}` in `sqlFragment` instead, or register a new builder with its
  reason after review;
- an untagged template or `+` concatenation, passed directly or through a
  local variable (`let` appends included) as the SQL of `.query(`,
  `.unsafe(`, `.executeRaw(` or `executeRawJsonb(`, with an untrusted part:
  compose with `sqlFragment` and run it with `executor.run(fragment)`;
- a literal `$<digit>`, or a `$` right before a substitution, in a composed
  string (a template with substitutions, any `sqlFragment` template, any `+`
  operand): let `renderFragment` number the parameters. A static string passed
  as-is may carry `$1`;
- an expanded list, `IN (` right before a substitution or a non-literal `+`
  operand: bind the array as one parameter, `= ANY(${ids}::text[])`, so
  prepared-statement caches stay bounded.

Fixtures: `test/fixtures/guards/check-engine-sql-dynamic.ts/`; forms are
driven in `test/scripts/engine-sql-dynamic.test.ts`.

### Engine-sql brands

`scripts/check-engine-sql-brands.ts` (`bun run check:engine-sql-brands`, in
`bun run verify`) keeps the RLS read brands in
`src/core/engine-sql/brands.ts` unforgeable. `ScopedRead` records a read that
ran inside `withScopedReadTransaction` on master and `LegacyUnscopedRead` one
that ran unscoped on the pool (EO4), so a forged brand silently changes how a
read is scoped. The guard fails on:

- a brand key (any `__obtainVia...` name) in a text file under `src/`,
  `test/` or `scripts/` other than `brands.ts` and the guard's own script,
  fixtures and test: get a branded executor from `scopedRead(tx)` inside
  `withScopedReadTransaction`, or from `unscopedExecutor(executor, '<reason>')`;
- in `src/`, a cast onto `ScopedRead` or `LegacyUnscopedRead` outside
  `brands.ts`, an `as unknown as T` where `T` names `SqlExecutor`,
  `ScopedRead` or `LegacyUnscopedRead`, or a double cast passed straight to
  `scopedRead(` or `unscopedExecutor(`. Driver-handle casts such as
  `tx as unknown as PgConn` in `dialect-postgres.ts` pass;
- an import of `unscopedExecutor` or `LegacyUnscopedRead` (value, type,
  alias, re-export or `import('...').X` type) from outside engine-sql, the two
  engine façades, doctor (`src/commands/doctor.ts`, `src/commands/doctor/**`,
  `src/core/doctor*`), maintenance (`src/core/maintenance/**`), admin
  (`src/commands/admin*.ts`, `src/core/admin/**`), migrations
  (`src/core/migrate.ts`, `src/core/schema-migrations/**`,
  `src/commands/migrations/**`) and `test/`; an import of `scopedRead` from
  outside engine-sql, the façades and `test/`; or a namespace, dynamic or
  `require` import of `brands.ts` from outside that `scopedRead` list.
  `src/core/ops/**`, the MCP-facing surface, is always denied. Take the
  branded executor from the engine façade instead.

The allowlists live in the script.

### Retired-phrase guard

`scripts/check-retired-phrases.sh` (`bun run check:retired-phrases`, in
`bun run verify`, under a second) keeps the instructions agents follow
literally in step with refactor wave 1. It greps `CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `docs/` and `skills/` for the contributor-workflow phrases
the wave retired: the old migrations-array wording and appending to it, the
rule that every engine method is written twice, the CLI switch-case step, the
migrate.ts region policy, and schema text listed as a hand-synced pair of
`schema.sql` and the PGLite schema module. The patterns and the current
instruction for each live in the script's `RETIRED` table. Historical records
may quote them and are exempt: `docs/designs/`, `docs/test-audit/`,
`docs/incidents/`, `docs/plans/`, `docs/proposals/`, `docs/research/`,
`docs/issues/`, `docs/superpowers/`, `docs/migrations/`, `skills/migrations/`
and the wave 1 porting kit (`docs/architecture/wave-1-*`); `CHANGELOG.md` is
not scanned. Each hit prints `FAIL: <file:line> retired phrase "<match>"`,
then `Why:`, `Fix:` with the current instruction, and `See:`. The fix is to
rewrite the sentence to the current workflow, never to exempt the file. To
retire another phrase, add a row to `RETIRED`. Fixtures:
`test/fixtures/guards/check-retired-phrases.sh/` (one `bad-<location>` tree per
scanned location); every pattern and the exemptions are driven in
`test/scripts/check-retired-phrases.test.ts`.

### Bash 3.2 parse guard

macOS ships GNU bash 3.2.57 as `/bin/bash`, and its parser rejects shapes
bash 5 accepts. The one that broke every Mac (#5810) is a heredoc inside
`$(...)` whose body holds an odd quote. `scripts/check-bash32.sh`
(`bun run check:bash32`) runs the real 3.2 parser, `bash -n`, over every
tracked `*.sh` except the guard fixtures under `test/fixtures/guards/`. It
uses the first parser available: `GBRAIN_BASH32=<path>` (a bash 3.x binary),
`/bin/bash` when it is bash 3.x (stock macOS), or the digest-pinned `bash:3.2`
Docker image (`GBRAIN_BASH32=docker` forces the image). With none it prints
one skip line and exits 0; `GBRAIN_TEST_BASH32_REQUIRE=1` makes that exit 2. Each
failure prints `FAIL: <file:line>`, `Why:` (macOS `/bin/bash` is 3.2), `Fix:`
(read heredoc text with `IFS= read -r -d '' VAR <<'EOF' || true`) and `See:`.
To reproduce one file by hand:
`docker run --rm -v "$PWD":/w -w /w bash:3.2 bash -n <file>`.

The guard checks parsing only. It is not in `bun run verify`, which must not
need Docker. The `test.yml` verify job runs it with `GBRAIN_TEST_BASH32_REQUIRE=1`
together with `test/scripts/check-bash32.test.ts`, whose real-parser cases
feed it the `test/fixtures/guards/check-bash32.sh/{bad,good}` trees. The
macOS 26 job runs it under `/bin/bash` and then runs `bun run verify` there,
which covers bash-4 runtime features the parser cannot see.
