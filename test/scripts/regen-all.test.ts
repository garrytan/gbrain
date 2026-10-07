/**
 * scripts/regen-all.ts (GBRA-47 B8, DX-14): one table drives both the
 * regeneration and the read-only check verify runs; a stale artifact is named
 * with the fix; generators run offline and keyless; Postgres goldens are
 * excluded and named.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS, CONTRACT_GOLDENS, POSTGRES_GOLDENS, checkArtifacts, goldenArgv, offlineEnv, staleReport, type Artifact } from '../../scripts/regen-all.ts';

const ROOT = join(import.meta.dir, '../..');

describe('regen:all', () => {
  test('--check names each stale artifact and prints Why/Fix/Docs; fresh ones pass', async () => {
    const fake: Artifact[] = [
      { name: 'fresh artifact', regen: ['true'], check: ['true'] },
      { name: 'drifted artifact', regen: ['true'], check: ['bash', '-c', 'echo "fixture.json differs from its generator"; exit 1'] },
    ];
    const stale = await checkArtifacts(fake, offlineEnv());
    expect(stale.map(s => s.artifact.name)).toEqual(['drifted artifact']);
    const report = staleReport(stale);
    expect(report).toContain('STALE drifted artifact');
    expect(report).toContain('  | fixture.json differs from its generator');
    expect(report).toContain('Fix: bun run regen:all');
    expect(report).toContain('Docs: docs/RELEASING.md#generated-artifacts');
    expect(readFileSync(join(ROOT, 'docs/RELEASING.md'), 'utf8')).toContain('## Generated artifacts');
  });

  test('every generator and check names a script or test that exists, and llms is regenerated last', () => {
    for (const a of ARTIFACTS) {
      for (const argv of [a.regen, a.check]) {
        const path = argv.find(x => /^(scripts|test)\//.test(x));
        if (path) expect(existsSync(join(ROOT, path)), `${a.name}: ${path}`).toBe(true);
      }
    }
    expect(ARTIFACTS.at(-1)!.name).toContain('llms');
    for (const f of CONTRACT_GOLDENS) expect(existsSync(join(ROOT, f)), f).toBe(true);
    for (const c of POSTGRES_GOLDENS) expect(existsSync(join(ROOT, /bun test (?:--timeout=\d+ )?(\S+)/.exec(c)![1]!)), c).toBe(true);
  });

  test('every bun test it spawns passes an explicit --timeout (bunfig\'s [test] timeout is not applied, #6187)', () => {
    const argvs = [...ARTIFACTS.flatMap(a => [a.regen, a.check]), ...CONTRACT_GOLDENS.map(goldenArgv)];
    const bunTests = argvs.filter(argv => argv[0] === 'bun' && argv[1] === 'test');
    expect(bunTests.length).toBeGreaterThanOrEqual(2 + CONTRACT_GOLDENS.length);
    for (const argv of bunTests) expect(argv.some(x => /^--timeout=\d+$/.test(x)), argv.join(' ')).toBe(true);
  });

  test('generators run without provider keys or database URLs', () => {
    const env = offlineEnv({ PATH: '/bin', OPENAI_API_KEY: 'k', UBICLOUD_API_TOKEN: 't', DATABASE_URL: 'postgres://x', GBRAIN_DATABASE_URL: 'y', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  test('verify runs check:regen-all and its failure hint names regen:all', () => {
    const verify = readFileSync(join(ROOT, 'scripts/run-verify-parallel.sh'), 'utf8');
    expect(verify).toContain('"check:regen-all"');
    expect(verify).toContain('Run: bun run regen:all');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:regen-all']).toBe('bun scripts/regen-all.ts --check');
    expect(pkg.scripts['regen:all']).toBe('bun scripts/regen-all.ts');
  });
});
