/**
 * The sync-pass memory probe (scripts/bench/sync-pass-memory.ts, #7644) is opt-in and never runs in CI, so a change to
 * the conversion's plan or apply contract could break it unnoticed. This seeds a tiny template brain with database-ahead
 * pages and runs the probe's conversion apply on a clone: the apply must convert, adopt exactly the seeded pages and
 * leave RSS samples that name their phase.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const BENCH = join(resolve(import.meta.dir, '../..'), 'scripts/bench/sync-pass-memory.ts');

describe.skipIf(!url)('sync-pass memory probe', () => {
  test('seeds a template brain and its conversion apply adopts every database-ahead page while sampling memory', async () => {
    assertSafeE2eDatabaseUrl(url!);
    const work = mkdtempSync(join(tmpdir(), 'sync-pass-memory-smoke-'));
    const tag = `smoke_${process.pid}`;
    const probe = (...argv: string[]) => spawnSync(process.execPath, [BENCH, ...argv, '--url', url!, '--dir', work, '--tag', tag],
      { encoding: 'utf8', env: { ...process.env, GBRAIN_HOME: join(work, 'home') }, timeout: 240_000 });
    try {
      const seeded = probe('seed', '--pages', '40', '--ahead', '8', '--commits', '4');
      expect(seeded.status, seeded.stderr).toBe(0);
      const run = probe('run', '--mode', 'convert');
      expect(run.status, run.stderr).toBe(0);
      const { preview, result } = JSON.parse(readFileSync(join(work, 'result-convert.json'), 'utf8'));
      expect(preview.adopt.count).toBe(8);
      expect(result).toMatchObject({ status: 'converted', committed: { pages: 8 } });
      const samples = readFileSync(join(work, 'samples-convert.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every(sample => typeof sample.phase === 'string' && sample.rss_mb > 0)).toBe(true);
    } finally {
      const admin = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
      for (const db of [`gbrain_${tag}_run`, `gbrain_${tag}_seed`]) await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
      rmSync(work, { recursive: true, force: true });
    }
  }, 600_000);
});
