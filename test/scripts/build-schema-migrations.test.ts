/**
 * W3 schema-migration registry (refactor wave 1): scripts/build-schema-migrations.ts,
 * scripts/check-schema-migrations-fresh.sh and scripts/check-schema-migration-order.ts.
 *
 * Protects: schema_version history and apply order after the MIGRATIONS array
 * became one file per migration. Fails when the generator silently sorts, drops
 * or duplicates a file, when a filename and its version/name disagree, when the
 * committed registry drifts from the directory, or when the out-of-order rule
 * stops catching a version at or below origin/master's latest.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  HISTORICAL_ARRAY_ORDER,
  RegistryError,
  registryOrder,
  renderRegistry,
  scaffold,
  scanMigrations,
} from '../../scripts/build-schema-migrations.ts';
import { baseMigrations } from '../../scripts/check-schema-migration-order.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const DIR = join(REPO, 'src/core/schema-migrations');
const GENERATOR = join(REPO, 'scripts/build-schema-migrations.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-schema-migrations-'));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}
const mig = (v: number, name: string, exportName = `v${String(v).padStart(3, '0')}`) =>
  `import type { Migration } from './types.ts';\n\nexport const ${exportName}: Migration = {\n  version: ${v},\n  name: '${name}',\n  sql: '',\n};\n`;

function scanError(d: string): string {
  try {
    scanMigrations(d);
  } catch (e) {
    if (e instanceof RegistryError) return e.message;
    throw e;
  }
  throw new Error('expected a RegistryError');
}

describe('committed registry', () => {
  test('is exactly what the generator produces from the directory', () => {
    // test-reads-source-ok[structural]: generated-file freshness contract.
    expect(readFileSync(join(DIR, 'registry.generated.ts'), 'utf8')).toBe(renderRegistry(scanMigrations(DIR)));
  });

  test('covers every migration file once, uses static imports only, and keeps master order', () => {
    const files = scanMigrations(DIR);
    expect(files.length).toBe(MIGRATIONS.length);
    expect(registryOrder(files).map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
    const text = renderRegistry(files);
    expect(text).not.toMatch(/import\s*\(/);
    expect(text).not.toContain('require(');
  });

  test('gaps 17-19 and 100 stay gaps; every file name matches its version and name', () => {
    const files = scanMigrations(DIR);
    const versions = new Set(files.map((m) => m.version));
    for (const gap of [17, 18, 19, 100]) expect(versions.has(gap)).toBe(false);
    for (const m of files) {
      expect(m.file.endsWith(`/v${String(m.version).padStart(3, '0')}-${m.name.replace(/_/g, '-')}.ts`)).toBe(true);
    }
  });

  test('HISTORICAL_ARRAY_ORDER is a permutation of versions that all exist', () => {
    const versions = new Set(scanMigrations(DIR).map((m) => m.version));
    expect(new Set(HISTORICAL_ARRAY_ORDER).size).toBe(HISTORICAL_ARRAY_ORDER.length);
    for (const v of HISTORICAL_ARRAY_ORDER) expect(versions.has(v)).toBe(true);
  });

  test('no file under schema-migrations imports migrate.ts', () => {
    for (const f of readdirSync(DIR)) {
      // test-reads-source-ok[structural]: EO10 layering, also enforced by scripts/check-layering.ts.
      expect(readFileSync(join(DIR, f), 'utf8')).not.toMatch(/from\s+['"]\.\.\/migrate(\.ts)?['"]/);
    }
  });
});

describe('generator diagnostics (FAIL/Why/Fix/See)', () => {
  test('duplicate version names both files and the git mv + regenerate recipe', () => {
    const d = fixture({ 'v176-add-widget-index.ts': mig(176, 'add_widget_index'), 'v176-add-alias-table.ts': mig(176, 'add_alias_table') });
    const msg = scanError(d);
    expect(msg).toContain('FAIL: schema migration version 176 is defined twice:');
    expect(msg).toContain('v176-add-alias-table.ts');
    expect(msg).toContain('v176-add-widget-index.ts');
    expect(msg).toMatch(/Fix: {2}git mv \S+v176-add-widget-index\.ts \S+v177-add-widget-index\.ts/);
    expect(msg).toContain('set `version: 177`');
    expect(msg).toContain('bun run build:schema-migrations');
    expect(msg).toContain('See:  docs/TESTING.md#schema-migration-registry');
  });

  test('filename version disagreeing with the version field fails', () => {
    const msg = scanError(fixture({ 'v176-add-x.ts': mig(177, 'add_x', 'v176') }));
    expect(msg).toContain('declares `version: 177` but its filename says 176');
  });

  test('name field disagreeing with the filename slug fails', () => {
    expect(scanError(fixture({ 'v176-add-x.ts': mig(176, 'add_y') }))).toContain("implies 'add_x'");
  });

  test('unpadded or malformed filenames fail', () => {
    expect(scanError(fixture({ 'v76-add-x.ts': mig(76, 'add_x', 'v076') }))).toContain('is not named v<NNN>-<name-with-dashes>.ts');
    expect(scanError(fixture({ 'add_x.ts': mig(76, 'add_x') }))).toContain('is not named');
  });

  test('export name must be the padded version', () => {
    expect(scanError(fixture({ 'v176-add-x.ts': mig(176, 'add_x', 'addX') }))).toContain('exports `addX`');
  });

  test('new versions append in version order after the historical prefix', () => {
    const d = fixture({ 'v002-a.ts': mig(2, 'a'), 'v023-b.ts': mig(23, 'b'), 'v015-c.ts': mig(15, 'c'), 'v300-d.ts': mig(300, 'd'), 'v200-e.ts': mig(200, 'e') });
    expect(registryOrder(scanMigrations(d)).map((m) => m.version)).toEqual([2, 23, 15, 200, 300]);
  });

  test('scaffold writes the next version with a typed template the generator accepts', () => {
    const d = fixture({ 'v002-a.ts': mig(2, 'a'), 'v178-b.ts': mig(178, 'b') });
    const file = scaffold(d, 'add_widget_index');
    expect(file.endsWith('/v179-add-widget-index.ts')).toBe(true);
    const body = readFileSync(file, 'utf8');
    expect(body).toContain('export const v179: Migration = {');
    expect(body).toContain("name: 'add_widget_index'");
    expect(body).toContain('idempotent: true');
    expect(scanMigrations(d).map((m) => m.version)).toEqual([2, 178, 179]);
  });

  test('--check fails on a stale registry and passes after regeneration', () => {
    const d = fixture({ 'v002-a.ts': mig(2, 'a') });
    const out = join(d, 'registry.generated.ts');
    const run = (...args: string[]) => spawnSync('bun', [GENERATOR, '--dir', d, '--out', out, ...args], { encoding: 'utf8' });
    expect(run().status).toBe(0);
    writeFileSync(join(d, 'v003-b.ts'), mig(3, 'b'));
    const stale = run('--check');
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('is stale');
    expect(stale.stderr).toContain('Fix:  bun run build:schema-migrations');
    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);
  });
});

describe('out-of-order landing check', () => {
  test('reads the base ref versions (pre-W3 base parses migrate.ts literals)', () => {
    const r = spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/master^{commit}'], { cwd: REPO });
    if (r.status !== 0) return; // no origin/master in this checkout; the CI verify job fetches it
    const base = baseMigrations('origin/master');
    expect(base.size).toBeGreaterThan(150);
    expect(base.get(2)).toBe('slugify_existing_pages');
  });

  test('a new migration numbered at or below the base latest fails; above passes; a reused version fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-migration-order-'));
    dirs.push(root);
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    const migDir = join(root, 'src/core/schema-migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(join(migDir, 'v002-a.ts'), mig(2, 'a'));
    writeFileSync(join(migDir, 'v178-b.ts'), mig(178, 'b'));
    git('init', '-q');
    git('-c', 'user.email=alice-example@example.com', '-c', 'user.name=alice-example', 'commit', '-q', '--allow-empty', '-m', 'root');
    git('add', '.');
    git('-c', 'user.email=alice-example@example.com', '-c', 'user.name=alice-example', 'commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/base/master', 'HEAD');
    const run = () => spawnSync('bun', [join(REPO, 'scripts/check-schema-migration-order.ts')], {
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_GUARD_ROOT: root, GBRAIN_MIGRATION_BASE_REF: 'base/master', CI: 'true' },
    });
    expect(run().status).toBe(0);

    writeFileSync(join(migDir, 'v100-late-arrival.ts'), mig(100, 'late_arrival'));
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("adds version 100, not above base/master's latest version 178");
    expect(bad.stderr).toContain('skipped forever');
    expect(bad.stderr).toContain('v179-<name>.ts');
    rmSync(join(migDir, 'v100-late-arrival.ts'));

    writeFileSync(join(migDir, 'v179-late-arrival.ts'), mig(179, 'late_arrival'));
    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("1 new migration(s) above base/master's latest v178 (179)");

    rmSync(join(migDir, 'v178-b.ts'));
    writeFileSync(join(migDir, 'v178-other.ts'), mig(178, 'other'));
    const reused = run();
    expect(reused.status).toBe(1);
    expect(reused.stderr).toContain("reuses version 178, which base/master already assigns to 'b'");
  }, 60_000);
});
