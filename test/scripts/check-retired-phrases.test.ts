/**
 * scripts/check-retired-phrases.sh — refactor wave 1 (W7) stale-instruction guard.
 *
 * Protects: CLAUDE.md, AGENTS.md, CONTRIBUTING.md, docs/ and skills/ never
 * again teach a workflow refactor wave 1 retired (the migrations array, the
 * two-engine SQL rule for migrated domains, the CLI switch case, the
 * migrate.ts region policy, hand-synced PGLite schema text), while historical
 * records (docs/designs/, release migration notes, the porting kit) may quote
 * them.
 * Fails when: a retired phrase in a scanned location stops failing, an exempt
 * location starts failing, or the failure loses its FAIL / Why / Fix / See
 * lines or the file:line.
 * Seam: GBRAIN_GUARD_ROOT pointed at temp trees.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts/check-retired-phrases.sh');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retired-phrases-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function run() {
  return spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
}

const RETIRED: Array<[string, string]> = [
  ['the `MIGRATIONS` array in migrate.ts', 'MIGRATIONS` array'],
  ['the MIGRATIONS array', 'MIGRATIONS array'],
  ['append an entry to the MIGRATIONS list', 'append an entry to the MIGRATIONS'],
  ['a new method lands in BOTH engines', 'lands in BOTH'],
  ['Add the case to `src/cli.ts`', 'Add the case to'],
  ['migrate.ts is region-exempt', 'region-exempt'],
  ['mirror in schema.sql + pglite-schema.ts', 'schema.sql + pglite-schema.ts'],
  ['mirror in pglite-schema.ts + schema.sql', 'pglite-schema.ts + schema.sql'],
];

describe('check-retired-phrases.sh', () => {
  it('passes a tree that uses the current instructions', () => {
    write('CLAUDE.md', '- One file per migration in `src/core/schema-migrations/` (`bun run new:migration <name>`).\n');
    write('docs/guides/x.md', 'A CLI-only command is a record in `src/cli/command-table.ts`.\n');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✓ retired phrases');
  });

  for (const [sentence, match] of RETIRED) {
    it(`fails on "${match}" with FAIL / Why / Fix / See and the file:line`, () => {
      write('docs/guides/x.md', `# Guide\n\nSee ${sentence}.\n`);
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`FAIL: docs/guides/x.md:3 retired phrase "${match}"`);
      expect(r.stderr).toMatch(/^Why: {2}\S/m);
      expect(r.stderr).toMatch(/^Fix: {2}rewrite the sentence to the current instruction: \S/m);
      expect(r.stderr).toContain('See:  docs/TESTING.md#retired-phrase-guard');
    });
  }

  it('scans CLAUDE.md, AGENTS.md, CONTRIBUTING.md, docs/ and skills/', () => {
    for (const rel of ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/a/b.md', 'skills/s/SKILL.md']) {
      write(rel, 'the MIGRATIONS array\n');
    }
    const r = run();
    expect(r.status).toBe(1);
    for (const rel of ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/a/b.md', 'skills/s/SKILL.md']) {
      expect(r.stderr).toContain(`FAIL: ${rel}:1 `);
    }
  });

  it('exempts historical records and the porting kit', () => {
    for (const rel of [
      'docs/designs/p.md', 'docs/test-audit/a.md', 'docs/incidents/i.md', 'docs/plans/p.md', 'docs/proposals/p.md',
      'docs/research/r.md', 'docs/issues/i.md', 'docs/superpowers/s.md', 'docs/migrations/m.md',
      'skills/migrations/v0.1.0.md', 'docs/architecture/wave-1-porting.md', 'CHANGELOG.md', 'test/x.md',
    ]) write(rel, 'the MIGRATIONS array; a new method lands in BOTH engines\n');
    const r = run();
    expect(r.status).toBe(0);
  });
});
