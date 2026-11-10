/**
 * Smoke run of scripts/bench-skill-resolver.ts on a tiny catalog, so the
 * GBRA-377 latency bench keeps running as the resolver it drives moves. The
 * timed bars run in .github/workflows/skill-resolver-bench.yml on a 2-vCPU
 * runner; this asserts the output shape only, never timings.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

describe('bench-skill-resolver', () => {
  test('a tiny run reports one cell per size', () => {
    const run = Bun.spawnSync([process.execPath, 'scripts/bench-skill-resolver.ts', '--sizes', '40,90', '--turns', '5', '--json', '--no-gate'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const out = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!) as { bench: string; cells: { skills: number; turns: number; p95_ms: number; bar_ms: number | null; pass: boolean }[] };
    expect(out.bench).toBe('skill-resolver');
    expect(out.cells.map(c => [c.skills, c.turns, c.bar_ms, c.pass])).toEqual([[40, 5, null, true], [90, 5, null, true]]);
    expect(out.cells.every(c => c.p95_ms > 0)).toBe(true);
  }, 60_000);
});
