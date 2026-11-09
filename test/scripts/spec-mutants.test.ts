/**
 * scripts/spec/mutants.ts is the guard-mutant runner for the TLA+ specs (spec/tla/README.md). TLC itself runs in the
 * tla-spec workflow; this pins the runner's argument contract, which fails before any java or jar is needed, and that
 * every per-mutant config it would copy into a TLC run exists.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const RUNNER = join(ROOT, 'scripts/spec/mutants.ts');
const run = (...args: string[]) => spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });

describe('scripts/spec/mutants.ts arguments', () => {
  it('refuses an unknown flag with MUTANT_USAGE', () => {
    const r = run('refresh-barrier', '--bogus');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('MUTANT_USAGE: unknown flag --bogus');
  });

  it('refuses --spec-only with --code-only, which would check nothing', () => {
    const r = run('refresh-barrier', '--spec-only', '--code-only');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('MUTANT_USAGE: --spec-only and --code-only together');
  });

  it('refuses an --only id the catalog does not have', () => {
    const r = run('refresh-barrier', '--only', 'no-such-mutant', '--spec-only');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no mutant no-such-mutant in refresh-barrier');
  });
});

describe('spec/tla mutant catalogs', () => {
  const specs = readdirSync(join(ROOT, 'spec/tla')).filter(d => existsSync(join(ROOT, 'spec/tla', d, 'mutants.json')));
  it.each(specs)('%s: the default config and every per-mutant config exist', (spec) => {
    const dir = join(ROOT, 'spec/tla', spec);
    const catalog = JSON.parse(readFileSync(join(dir, 'mutants.json'), 'utf8')) as { module: string; config: string; mutants: Array<{ id: string; config?: string }> };
    expect(existsSync(join(dir, `${catalog.module}.tla`))).toBe(true);
    const missing = [catalog.config, ...catalog.mutants.map(m => m.config).filter((c): c is string => !!c)].filter(c => !existsSync(join(dir, c)));
    expect(missing).toEqual([]);
  });
});
