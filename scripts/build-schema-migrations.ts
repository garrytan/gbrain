#!/usr/bin/env bun
/**
 * Schema-migration registry generator (refactor wave 1, W3).
 *
 * Reads every `src/core/schema-migrations/v<NNN>-<name>.ts` file and writes the
 * committed static-import registry `src/core/schema-migrations/registry.generated.ts`
 * (static imports only, so `bun build --compile` bundles every migration and the
 * engine-dynamic-import rule holds). Regenerate, never hand-merge:
 *
 *   bun run build:schema-migrations            # rewrite the registry
 *   bun run new:migration <snake_name>         # scaffold v<max+1>-<name>.ts, then rewrite
 *   bun scripts/build-schema-migrations.ts --check   # exit 1 if the committed registry is stale
 *
 * Checks (FAIL/Why/Fix/See, exit 1): filename `v<NNN>-<name-with-dashes>.ts`
 * with NNN zero-padded to at least 3; the file exports exactly one
 * `export const v<NNN>: Migration = { version: <NNN>, name: '<name_with_underscores>', ... }`
 * whose version and name match the filename; no version appears in two files.
 *
 * Array order: the runner sorts by version, but `MIGRATIONS` keeps master's
 * historical array order (pinned by the migrations golden). Versions listed in
 * HISTORICAL_ARRAY_ORDER come first in that order; every other version follows
 * ascending. New migrations therefore append in version order.
 *
 * Seams for tests: --dir <path> (migrations dir), --out <path> (registry path).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPO = resolve(import.meta.dir, '..');
const DEFAULT_DIR = join(REPO, 'src/core/schema-migrations');
const REGISTRY_NAME = 'registry.generated.ts';
const SEE = 'See:  docs/TESTING.md#schema-migration-registry';

/**
 * Master's MIGRATIONS array order for the versions that were not appended in
 * version order (release-order reasons: v20-v23 landed before v15/v16, v37/v38
 * before v30, v58/v59 before v55, v77/v78 before v66). Frozen: never edit.
 */
export const HISTORICAL_ARRAY_ORDER: readonly number[] = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 23, 22, 21, 20, 15, 16, 24, 25, 26, 27, 28, 29, 37, 38, 30, 31, 32,
  33, 34, 35, 36, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 59, 58, 55, 56, 57, 60, 61, 62,
  63, 64, 65, 78, 77, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76,
];

export interface MigrationFile {
  file: string;
  version: number;
  name: string;
  exportName: string;
}

export class RegistryError extends Error {}

const FILE_RE = /^v(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/;
const NON_MIGRATION_FILES = new Set(['types.ts', 'helpers.ts', REGISTRY_NAME]);

export function pad(version: number): string {
  return String(version).padStart(3, '0');
}

function rel(p: string): string {
  return relative(REPO, p) || p;
}

function fail(what: string, why: string, fix: string): never {
  throw new RegistryError(`FAIL: ${what}\nWhy:  ${why}\nFix:  ${fix}\n${SEE}`);
}

function readLiteral(file: string): { exportName: string; version: number; name: string } {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { exportName: string; version: number; name: string; line: number }[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue;
      if (!d.type || d.type.getText(sf) !== 'Migration') continue;
      let version: number | undefined;
      let name: string | undefined;
      for (const p of d.initializer.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
        if (p.name.text === 'version' && ts.isNumericLiteral(p.initializer)) version = Number(p.initializer.text);
        if (p.name.text === 'name' && ts.isStringLiteralLike(p.initializer)) name = p.initializer.text;
      }
      const line = sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1;
      if (version === undefined || name === undefined) {
        fail(`${rel(file)}:${line} ${d.name.text} has no literal \`version: <number>\` and \`name: '<string>'\``,
          'the registry generator reads the version and name statically; computed values cannot be cross-checked against the filename.',
          `write them as literals, e.g. \`version: 179, name: 'add_widget_index'\`.`);
      }
      found.push({ exportName: d.name.text, version, name, line });
    }
  }
  if (found.length !== 1) {
    fail(`${rel(file)} exports ${found.length} \`Migration\` constants (expected exactly 1)`,
      'each schema migration file holds one migration so the registry, the filename and schema_version agree.',
      'keep one `export const v<NNN>: Migration = { ... };` per file (bun run new:migration <name> writes the template).');
  }
  return found[0]!;
}

/** Scan and cross-check every migration file in `dir`. */
export function scanMigrations(dir: string): MigrationFile[] {
  const out: MigrationFile[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.ts') || NON_MIGRATION_FILES.has(entry)) continue;
    const file = join(dir, entry);
    const m = FILE_RE.exec(entry);
    if (!m) {
      fail(`${rel(file)} is not named v<NNN>-<name-with-dashes>.ts`,
        'every non-helper file in src/core/schema-migrations/ is a migration, and its filename carries the version the registry is sorted and checked by.',
        `rename it, e.g. git mv ${rel(file)} ${rel(join(dir, 'v179-add-widget-index.ts'))} (NNN zero-padded to 3), then run: bun run build:schema-migrations`);
    }
    const fileVersion = Number(m[1]);
    const slug = m[2]!;
    if (m[1] !== pad(fileVersion)) {
      fail(`${rel(file)} version ${m[1]} is not zero-padded to exactly ${pad(fileVersion).length} digits`,
        'filenames sort lexically; padding keeps directory order equal to version order.',
        `git mv ${rel(file)} ${rel(join(dir, `v${pad(fileVersion)}-${slug}.ts`))}`);
    }
    const lit = readLiteral(file);
    const expectedName = slug.replace(/-/g, '_');
    if (lit.version !== fileVersion) {
      fail(`${rel(file)} declares \`version: ${lit.version}\` but its filename says ${fileVersion}`,
        'the filename and the version field must agree; the runner applies and records `version`.',
        `set \`version: ${fileVersion}\` inside it, or git mv it to v${pad(lit.version)}-${slug}.ts; then run: bun run build:schema-migrations`);
    }
    if (lit.name !== expectedName) {
      fail(`${rel(file)} declares \`name: '${lit.name}'\` but its filename implies '${expectedName}'`,
        'the name field is the filename slug with - replaced by _; both appear in schema_version history and logs.',
        `set \`name: '${expectedName}'\`, or rename the file to v${pad(fileVersion)}-${lit.name.replace(/_/g, '-')}.ts`);
    }
    if (lit.exportName !== `v${pad(fileVersion)}`) {
      fail(`${rel(file)} exports \`${lit.exportName}\` but the registry expects \`v${pad(fileVersion)}\``,
        'the generated registry imports each migration by its padded version name.',
        `rename the export to \`export const v${pad(fileVersion)}: Migration = { ... }\``);
    }
    out.push({ file, version: fileVersion, name: lit.name, exportName: lit.exportName });
  }
  const byVersion = new Map<number, MigrationFile>();
  for (const m of out) {
    const prior = byVersion.get(m.version);
    if (prior) duplicate(prior, m, out);
    byVersion.set(m.version, m);
  }
  return out;
}

function onOriginMaster(file: string): boolean {
  const r = spawnSync('git', ['cat-file', '-e', `origin/master:${rel(file)}`], { cwd: REPO, stdio: 'ignore' });
  return r.status === 0;
}

function duplicate(first: MigrationFile, second: MigrationFile, all: MigrationFile[]): never {
  const [keep, move] = onOriginMaster(second.file) && !onOriginMaster(first.file) ? [second, first] : [first, second];
  const tag = (m: MigrationFile) => (onOriginMaster(m.file) ? '  (on origin/master)' : '  (this branch)');
  const next = Math.max(...all.map((m) => m.version)) + 1;
  const moved = join(move.file, '..', `v${pad(next)}-${basename(move.file).replace(FILE_RE, '$2')}.ts`);
  throw new RegistryError([
    `FAIL: schema migration version ${keep.version} is defined twice:`,
    `      ${rel(keep.file)}${tag(keep)}`,
    `      ${rel(move.file)}${tag(move)}`,
    'Why:  versions are applied in order and recorded in schema_version; two files cannot share one.',
    `Fix:  git mv ${rel(move.file)} ${rel(moved)}`,
    `      set \`version: ${next}\` and \`export const v${pad(next)}\` inside it, then run: bun run build:schema-migrations`,
    '      (already applied to a disposable dev DB: rebuild it and replay; applied to retained data:',
    '      reconcile schema_version explicitly, never just edit the counter.)',
    SEE,
  ].join('\n'));
}

/** Registry order: HISTORICAL_ARRAY_ORDER first, then every other version ascending. */
export function registryOrder(files: MigrationFile[]): MigrationFile[] {
  const byVersion = new Map(files.map((m) => [m.version, m]));
  const historical = new Set(HISTORICAL_ARRAY_ORDER);
  const ordered: MigrationFile[] = [];
  for (const v of HISTORICAL_ARRAY_ORDER) {
    const m = byVersion.get(v);
    if (m) ordered.push(m);
  }
  ordered.push(...files.filter((m) => !historical.has(m.version)).sort((a, b) => a.version - b.version));
  return ordered;
}

export function renderRegistry(files: MigrationFile[]): string {
  const ordered = registryOrder(files);
  const imports = [...files]
    .sort((a, b) => a.version - b.version)
    .map((m) => `import { ${m.exportName} } from './${basename(m.file)}';`);
  return [
    '// AUTO-GENERATED by scripts/build-schema-migrations.ts from src/core/schema-migrations/v<NNN>-*.ts.',
    '// Do not edit or hand-merge. Regenerate: bun run build:schema-migrations',
    '//',
    '// Schema migrations (database DDL, applied by src/core/migrate.ts runMigrations and',
    '// recorded in schema_version). Not to be confused with the version-upgrade',
    '// orchestrator registry in src/commands/migrations/index.ts.',
    '',
    "import type { Migration } from './types.ts';",
    ...imports,
    '',
    '// Array order is historical (see HISTORICAL_ARRAY_ORDER in the generator); the',
    '// runner sorts by version before applying.',
    'export const MIGRATIONS: Migration[] = [',
    ...ordered.map((m) => `  ${m.exportName},`),
    '];',
    '',
  ].join('\n');
}

export function scaffold(dir: string, rawName: string): string {
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(rawName)) {
    fail(`migration name '${rawName}' is not lower-case snake_case`,
      'the name becomes both the filename slug (dashes) and the `name` field (underscores).',
      'use lower-case letters, digits and _ (e.g. bun run new:migration add_widget_index).');
  }
  const files = scanMigrations(dir);
  const next = files.length === 0 ? 2 : Math.max(...files.map((m) => m.version)) + 1;
  const name = rawName.replace(/-/g, '_');
  const file = join(dir, `v${pad(next)}-${name.replace(/_/g, '-')}.ts`);
  if (existsSync(file)) fail(`${rel(file)} already exists`, 'scaffolding never overwrites a migration.', 'pick another name.');
  writeFileSync(file, [
    "import type { Migration } from './types.ts';",
    '',
    '// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md',
    '// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.',
    `export const v${pad(next)}: Migration = {`,
    `  version: ${next},`,
    `  name: '${name}',`,
    '  // Re-running must be safe: CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.',
    '  idempotent: true,',
    '  sql: `',
    '    -- TODO: DDL',
    '  `,',
    '};',
    '',
  ].join('\n'));
  return file;
}

function main(argv: string[]): number {
  let dir = DEFAULT_DIR;
  let out: string | undefined;
  let check = false;
  let newName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dir') dir = resolve(argv[++i]!);
    else if (a === '--out') out = resolve(argv[++i]!);
    else if (a === '--check') check = true;
    else if (a === '--new') newName = argv[++i];
    else {
      console.error(`unknown argument ${a}`);
      return 2;
    }
  }
  if (argv.includes('--new') && !newName) {
    console.error('usage: bun run new:migration <snake_name>');
    return 2;
  }
  const target = out ?? join(dir, REGISTRY_NAME);
  try {
    if (newName) console.log(`Created ${rel(scaffold(dir, newName))}`);
    const text = renderRegistry(scanMigrations(dir));
    if (check) {
      const committed = existsSync(target) ? readFileSync(target, 'utf8') : '';
      if (committed !== text) {
        console.error([
          `FAIL: ${rel(target)} is stale (does not match the migration files in ${rel(dir)}).`,
          'Why:  the registry is generated; an added, renamed or removed migration file (or a hand edit/merge of the registry) makes it drift.',
          'Fix:  bun run build:schema-migrations   (then commit the regenerated registry; never hand-merge it)',
          SEE,
        ].join('\n'));
        return 1;
      }
      console.log(`✓ ${rel(target)} is fresh`);
      return 0;
    }
    writeFileSync(target, text);
    console.log(`Generated ${rel(target)}`);
    return 0;
  } catch (e) {
    if (e instanceof RegistryError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
