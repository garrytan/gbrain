/**
 * #9192: scripts/check-migration-projection.ts fails verify on a migration that
 * changes what the page revision trigger watches, unless
 * scripts/migration-projection-baseline.tsv lists it with a reason.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts/check-migration-projection.ts');
const BASELINE = 'scripts/migration-projection-baseline.tsv';
const REGISTRY = 'src/core/schema-migrations/registry.generated.ts';
const FIXTURES = join(REPO, 'test/fixtures/guards/check-migration-projection.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(root?: string) {
  const env = { ...process.env };
  if (root) env.GBRAIN_GUARD_ROOT = root;
  else delete env.GBRAIN_GUARD_ROOT;
  const r = spawnSync('bun', [GUARD], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + '\n' + r.stderr };
}

function tree(migrations: string, baseline: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-migration-projection-'));
  dirs.push(root);
  for (const [rel, body] of [[REGISTRY, 'export const MIGRATIONS = [\n' + migrations + '\n];\n'], [BASELINE, baseline]]) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const TITLES = "  { version: 7, name: 'lower_titles', sql: 'UPDATE pages SET title = lower(title);' },";

describe('check-migration-projection.ts', () => {
  test('the good fixture passes', () => {
    const r = run(join(FIXTURES, 'good'));
    expect(r.out).toContain('check-migration-projection: ok (5 migrations, 1 baseline rows)');
    expect(r.code).toBe(0);
  });

  test('the bad fixture fails and names the migration and the column', () => {
    const r = run(join(FIXTURES, 'bad'));
    expect(r.out).toContain('v1 lower_titles: UPDATE pages SET title');
    expect(r.out).toContain('check-migration-projection: 1 violation(s)');
    expect(r.code).toBe(1);
  });

  test('the real registry passes with every baseline row matched', () => {
    const rows = readFileSync(join(REPO, BASELINE), 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const r = run();
    expect(r.out).toContain(`baseline rows)`);
    expect(r.out).toMatch(new RegExp(`check-migration-projection: ok \\(\\d+ migrations, ${rows.length} baseline rows\\)`));
    expect(r.code).toBe(0);
  });

  test('a baseline row with a reason allows its migration', () => {
    const r = run(tree(TITLES, '# allowed\n7\tlower_titles\tonly pages that were never searchable\n'));
    expect(r.out).toContain('check-migration-projection: ok (1 migrations, 1 baseline rows)');
    expect(r.code).toBe(0);
  });

  test('a baseline row without a reason fails', () => {
    const r = run(tree(TITLES, '7\tlower_titles\t\n'));
    expect(r.out).toContain('row without a reason');
    expect(r.code).toBe(1);
  });

  test('a baseline row whose name differs does not excuse the migration', () => {
    const r = run(tree(TITLES, '7\trenamed_titles\treason\n'));
    expect(r.out).toContain('v7 lower_titles: UPDATE pages SET title');
    expect(r.out).toContain('stale baseline row v7 renamed_titles');
    expect(r.code).toBe(1);
  });
});
