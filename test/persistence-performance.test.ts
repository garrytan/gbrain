import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { overlapPercent, summarizeReadRuns } from '../scripts/persistence/read-metrics.ts';
import { runReadPerformance } from '../scripts/persistence/performance.ts';
import { runReadLatencyWorkload } from '../scripts/persistence/read-workload.ts';
import { WriteTimingRecorder } from '../scripts/persistence/read-admission.ts';
import { withEnv } from './helpers/with-env.ts';
import { childEnvironment } from '../scripts/persistence/validate.ts';

describe('read-load evidence', () => {
  test.each([false, true])('unavailable RSS stays explicit without invalidating real reads and writes (all=%s)', async all => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-read-rss-'));
    const original = process.memoryUsage;
    let calls = 0;
    const memory = spyOn(process, 'memoryUsage').mockImplementation(Object.assign(() => {
      if (++calls === 1 || all) throw new Error('Failed to get memory usage');
      return original.call(process);
    }, { rss: original.rss }));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const result = await runReadLatencyWorkload({ pages: 4, queries: 200, writers: 1, writesPerWriter: 100 });
        expect(result.ok).toBe(true);
        expect(result.phase_b.writes_completed).toBeGreaterThan(0);
        expect(result.phase_b.writes_failed).toBe(0);
        expect(result.rss_unavailable_samples).toBeGreaterThan(0);
        expect(result.metrics[0].rss_bytes).toBeNull();
        if (all) {
          expect(result.metrics.every((sample: { rss_bytes: number | null }) => sample.rss_bytes === null)).toBe(true);
          expect(result.peak_rss_bytes).toBeNull();
        } else {
          expect(result.rss_unavailable_samples).toBe(1);
          expect(result.peak_rss_bytes).toBeGreaterThan(0);
        }
      });
    } finally { memory.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  }, 60000);

  test('rejects invalid workload sizes before opening a datastore', async () => {
    await expect(runReadPerformance({ pages: 0 })).rejects.toThrow('Invalid pages');
  });
  test('late completion cannot hide an idle interval in the middle of reads', () => {
    expect(overlapPercent(100, 200, [[90, 120], [180, 220]])).toBe(40);
    expect(overlapPercent(100, 200, [[90, 160], [130, 190]])).toBe(90);
    expect(overlapPercent(100, 200, [[190, 220], [80, 180], [150, 190]])).toBe(100);
  });
  test('warmup reset retains separate, deduplicated admission and terminal timings', () => {
    const timings = new WriteTimingRecorder();
    timings.start('seed', 100); timings.admitted('seed', 110); timings.complete('seed', 150);
    timings.reset();
    timings.admitted('seed', 160); // A late unrelated observation cannot restore a discarded seed.
    expect(timings.admissionMs).toEqual([]);
    expect(timings.completionMs).toEqual([]);
    expect(timings.intervals).toEqual([]);
    timings.start('pressure', 200);
    expect(() => timings.reset()).toThrow('unfinished warmup');
    expect(() => timings.complete('pressure', 220)).toThrow('earlier observed durable admission');
    timings.admitted('pressure', 230); timings.admitted('pressure', 240);
    timings.complete('pressure', 280);
    expect(timings.admissionMs).toEqual([30]);
    expect(timings.completionMs).toEqual([80]);
    expect(timings.intervals).toEqual([[200, 280]]);
    expect(() => timings.complete('pressure', 290)).toThrow('only once');
  });
  const run = (idle: number, loaded: number) => ({ ok: true, overlap_pct: 95,
    admission: { count: 12, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
    commit: { count: 12, p50_ms: 10, p95_ms: 20, p99_ms: 30 },
    phase_a: { p50_ms: idle, p95_ms: idle, p99_ms: idle, queries_run: 200 },
    phase_b: { p50_ms: loaded, p95_ms: loaded, p99_ms: loaded, queries_run: 200, writes_completed: 12, writes_committed_during_reads: 10, writes_failed: 0 } });
  test('compares independent medians and preserves the 50 percent boundary', () => {
    const results = [run(10, 15), run(1000, 10), run(9, 1000)];
    expect(summarizeReadRuns(results).verdict).toBe('pass');
    expect(summarizeReadRuns([run(10, 15.01), run(10, 15.01), run(10, 15.01)]).verdict).toBe('fail');
  });
  for (const [informational, valid, exit] of [[false, true, 1], [true, true, 0], [true, false, 1]] as const) {
    test(`CLI advisory policy preserves measured failure and rejects invalid work (${informational}, ${valid})`, () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-read-policy-'));
      try {
        const preload = join(home, 'preload.ts');
        const manifest = join(home, 'manifest.json');
        const fixture = { ...run(10, 30), ok: valid };
        writeFileSync(preload, `Bun.spawn = () => ({
          stdout: new Blob([${JSON.stringify(`${JSON.stringify(fixture)}\n`)}]).stream(),
          exited: Promise.resolve(0), exitCode: 0, kill() {},
        });`);
        const result = Bun.spawnSync([process.execPath, '--no-env-file', '--preload', preload,
          resolve(import.meta.dir, '../scripts/persistence/performance.ts'), `--manifest=${manifest}`,
          ...(informational ? ['--informational'] : [])], { env: childEnvironment(home), timeout: 30_000 });
        expect(result.exitCode).toBe(exit);
        const recorded = JSON.parse(readFileSync(manifest, 'utf8'));
        expect(recorded.ok).toBe(valid);
        expect(recorded.verdict).toBe('fail');
        expect(recorded.status).toBe('failed');
        expect(recorded.full_gate).toBe(false);
        expect(recorded.delta_p99_pct).toBe(200);
        expect(recorded.threshold_pct).toBe(50);
        expect(recorded.runs).toHaveLength(3);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }, 40_000);
  }
  test('a fast invalid or incomplete sample always fails', () => {
    for (const mutate of [
      (r: any) => { r.ok = false; }, (r: any) => { r.overlap_pct = 89.99; },
      (r: any) => { r.phase_b.writes_completed = 0; }, (r: any) => { r.phase_b.writes_failed = 1; },
      (r: any) => { r.phase_b.writes_committed_during_reads = 0; },
      (r: any) => { r.admission.count = 0; }, (r: any) => { r.commit.count = 11; },
      (r: any) => { delete r.admission; }, (r: any) => { r.admission.p99_ms = 0; },
      (r: any) => { r.phase_b.queries_run = 199; }, (r: any) => { r.phase_a.p99_ms = NaN; },
    ]) { const results = [run(10, 1), run(10, 1), run(10, 1)]; mutate(results[1]); expect(summarizeReadRuns(results).verdict).toBe('fail'); }
    expect(summarizeReadRuns([run(10, 1), run(10, 1)]).verdict).toBe('fail');
  });
});
