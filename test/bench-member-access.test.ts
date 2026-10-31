/**
 * Smoke run of scripts/bench-member-access.ts on a tiny synthetic corpus, so the
 * GBRA-218 benchmark keeps running as the search and access code it drives moves.
 * Asserts the output shape and that the member recalls its readable pages, never timings.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

describe('bench-member-access', () => {
  test('a tiny run reports every cell and full member recall', () => {
    const run = Bun.spawnSync(['bun', 'scripts/bench-member-access.ts', '--pages', '40', '--queries', '2', '--shares', '0,0.5', '--json'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, DATABASE_URL: '' },
    });
    expect(run.stderr.toString()).not.toContain('bench search degraded or failed');
    expect(run.exitCode).toBe(0);
    const out = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!) as {
      pages: number; queries: number; cells: { share: number; who: string; match: string; p50: number; p95: number; hit_at_10?: number }[];
    };
    expect(out.pages).toBe(40);
    expect(out.queries).toBe(2);
    expect(out.cells.map(c => `${c.share}/${c.match}/${c.who}`).sort()).toEqual([
      '0.5/hybrid/aud1', '0.5/hybrid/aud2', '0.5/hybrid/member', '0.5/hybrid/unbound',
      '0.5/keyword/aud1', '0.5/keyword/aud2', '0.5/keyword/member', '0.5/keyword/unbound',
      '0/hybrid/member', '0/hybrid/unbound', '0/keyword/member', '0/keyword/unbound',
    ]);
    for (const c of out.cells.filter(c => c.share === 0.5 && c.who !== 'unbound')) expect(c.hit_at_10).toBe(1);
  }, 120_000);
});
