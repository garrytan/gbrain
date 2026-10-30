/**
 * The door per-write bench (scripts/bench/door-write-overhead.ts) is opt-in and never runs in CI, so a change to
 * commitThroughDoor's contract could break it unnoticed. This runs its door and trace phases on a tiny checkout: the
 * loop of new pages and edits through the real door must finish with a clean checkout and report every sample.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BENCH = join(resolve(import.meta.dir, '..'), 'scripts/bench/door-write-overhead.ts');

describe('door write overhead bench', () => {
  test('the door and trace phases run on a small checkout and report each measured write', () => {
    const work = mkdtempSync(join(tmpdir(), 'door-bench-smoke-'));
    try {
      const out = join(work, 'out.json');
      const run = spawnSync(process.execPath, [BENCH, '--files', '60', '--writes', '4', '--warmup', '1', '--phases', 'door,trace',
        '--work', work, '--label', 'smoke', '--out', out], { encoding: 'utf8', env: { ...process.env, GBRAIN_HOME: join(work, 'home') }, timeout: 120_000 });
      expect(run.stderr + run.stdout).not.toContain('not clean');
      expect(run.status).toBe(0);
      const result = JSON.parse(readFileSync(out, 'utf8'));
      const entry = result.sizes['60'];
      expect(entry.door.n).toBe(4);
      expect(entry.door_traced.n).toBe(4);
      expect(entry.door.p95).toBeGreaterThan(0);
      expect(Object.values(entry.subprocess as Record<string, { calls_per_write: number }>).some(s => s.calls_per_write > 0)).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 180_000);
});
