import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { childEnvironment } from '../scripts/persistence/validate.ts';
import { summarizeReadRuns } from '../scripts/persistence/read-metrics.ts';

async function child(code: string) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-read-diagnostics-test-'));
  const script = join(home, 'run.ts');
  writeFileSync(script, code);
  try {
    const proc = Bun.spawn([process.execPath, '--no-env-file', script], {
      env: childEnvironment(home), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 90_000);
    const [output, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      .finally(() => clearTimeout(timer));
    expect({ exit, stderr: exit ? stderr : '' }).toEqual({ exit: 0, stderr: '' });
    return JSON.parse(output.split('\n').find(line => line.startsWith('{"diagnostic_test":'))!).result;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const workloadImport = JSON.stringify(resolve(import.meta.dir, '../scripts/persistence/read-workload.ts'));
const engineImport = JSON.stringify(resolve(import.meta.dir, '../src/core/pglite-engine.ts'));
const admissionImport = JSON.stringify(resolve(import.meta.dir, '../scripts/persistence/read-admission.ts'));
const options = '{ pages: 5, queries: 20, writers: 1, writesPerWriter: 25 }';

test('tiny keyless manifest retains diagnostics without claiming a full gate', async () => {
  const performanceImport = JSON.stringify(resolve(import.meta.dir, '../scripts/persistence/performance.ts'));
  const result = await child(`
    import { readFileSync } from 'node:fs';
    import { runReadPerformance } from ${performanceImport};
    const manifest = process.env.GBRAIN_HOME + '/diagnostics.json';
    await runReadPerformance({ ...${options}, manifest });
    console.log(JSON.stringify({ diagnostic_test: true, result: JSON.parse(readFileSync(manifest, 'utf8')) }));
  `);
  expect(result.full_gate).toBe(false);
  expect(result.requested).toEqual({ pages: 5, queries: 20, writers: 1, writesPerWriter: 25, runs: 3, thresholdPct: 50 });
  expect(result.runs).toHaveLength(3);
  expect(result.source_hashes['scripts/persistence/read-diagnostics.ts']).toMatch(/^[a-f0-9]{64}$/);
  expect(result.ok).toBe(summarizeReadRuns(result.runs).ok);
  expect(result.verdict).toBe(summarizeReadRuns(result.runs).verdict);
  for (const run of result.runs) {
    if (!run.ok) {
      console.error(`Retained invalid tiny workload: ${JSON.stringify(run)}`);
      expect(result.verdict).toBe('fail');
      expect(run.diagnostics.failures.total).toBeGreaterThan(0);
      expect(run.diagnostics.failures.records.every((r: any) => r.stage === 'validate')).toBe(true);
    }
    expect(run.diagnostics.reads.records.filter((r: any) => r.phase === 'idle')).toHaveLength(20);
    expect(run.diagnostics.reads.records.filter((r: any) => r.phase === 'loaded')).toHaveLength(20);
    expect(run.diagnostics.writes.records.some((r: any) => r.event === 'admitted')).toBe(true);
    expect(run.diagnostics.writes.records.some((r: any) => r.event === 'committed')).toBe(true);
    expect(run.metrics_retention.total).toBe(run.metrics.length);
  }
}, 120_000);

test('RSS failure retains partial reads and safe stage/errno; a successful later sample cannot clear it', async () => {
  const result = await child(`
    import { PGLiteEngine } from ${engineImport};
    import { runReadLatencyWorkload } from ${workloadImport};
    import { WriteTimingRecorder } from ${admissionImport};
    let loaded = false; let releaseCommit;
    const committed = new Promise(resolve => { releaseCommit = resolve; });
    const complete = WriteTimingRecorder.prototype.complete;
    WriteTimingRecorder.prototype.complete = function(...args) {
      const result = complete.apply(this, args);
      if (loaded) releaseCommit();
      return result;
    };
    const keyword = PGLiteEngine.prototype.searchKeyword; let reads = 0;
    PGLiteEngine.prototype.searchKeyword = async function(...args) {
      if (++reads === 22) { loaded = true; await committed; }
      return keyword.apply(this, args);
    };
    const execute = PGLiteEngine.prototype.executeRaw;
    const interval = globalThis.setInterval;
    let sampler; let late = false; let injected = false;
    globalThis.setInterval = function(fn, ms, ...args) {
      if (ms === 250) sampler = fn;
      return interval(fn, ms, ...args);
    };
    const memory = process.memoryUsage;
    process.memoryUsage = Object.assign(function() {
      if (late && !injected) {
        injected = true;
        throw Object.assign(new Error('unsafe payload /private/path postgres://secret'), { name: 'SystemError', code: 'ENOMEM', errno: -12 });
      }
      return memory();
    }, memory);
    PGLiteEngine.prototype.executeRaw = async function(sql, ...args) {
      if (sql === 'SELECT count(*)::integer AS n FROM pages') {
        late = true;
        sampler();
      }
      return execute.call(this, sql, ...args);
    };
    const result = await runReadLatencyWorkload(${options});
    console.log(JSON.stringify({ diagnostic_test: true, result: { ...result, injected, subsequent_rss_succeeded: memory().rss > 0 } }));
  `);
  expect(result.injected).toBe(true);
  expect(result.subsequent_rss_succeeded).toBe(true);
  expect(result.ok).toBe(false);
  expect(result.overlap_pct).toBeGreaterThanOrEqual(90);
  expect(result.phase_a.queries_run).toBe(20);
  expect(result.phase_b.queries_run).toBe(20);
  expect(result.phase_b.writes_committed_during_reads).toBeGreaterThan(0);
  expect(result.phase_b.writes_failed).toBe(0);
  expect(result.admission.count).toBe(result.phase_b.writes_completed);
  expect(result.commit.count).toBe(result.phase_b.writes_completed);
  const failure = result.diagnostics.failures.records.find((r: any) => r.stage === 'metrics_rss');
  expect(failure.error).toEqual({ name: 'SystemError', code: 'ENOMEM', errno: -12, stack_present: true });
  expect(JSON.stringify(result)).not.toContain('unsafe payload');
  expect(JSON.stringify(result)).not.toContain('postgres://secret');
  expect(result.metrics.length).toBeGreaterThan(0);
}, 120_000);

test('late known Bun RSS unavailability is included in final sample counts and peaks', async () => {
  const result = await child(`
    import { PGLiteEngine } from ${engineImport};
    import { runReadLatencyWorkload } from ${workloadImport};
    import { WriteTimingRecorder } from ${admissionImport};
    let loaded = false; let releaseCommit;
    const committed = new Promise(resolve => { releaseCommit = resolve; });
    const complete = WriteTimingRecorder.prototype.complete;
    WriteTimingRecorder.prototype.complete = function(...args) {
      const result = complete.apply(this, args);
      if (loaded) releaseCommit();
      return result;
    };
    const keyword = PGLiteEngine.prototype.searchKeyword; let reads = 0;
    PGLiteEngine.prototype.searchKeyword = async function(...args) {
      if (++reads === 22) { loaded = true; await committed; }
      return keyword.apply(this, args);
    };
    const interval = globalThis.setInterval;
    let sampler; let late = false; let injected = false;
    globalThis.setInterval = function(fn, ms, ...args) {
      if (ms === 250) sampler = fn;
      return interval(fn, ms, ...args);
    };
    const memory = process.memoryUsage;
    process.memoryUsage = Object.assign(function() {
      if (late && !injected) {
        injected = true;
        throw Object.assign(new Error('Failed to get memory usage'), { name: 'SystemError', syscall: 'memoryUsage', errno: 2 });
      }
      return memory();
    }, memory);
    const execute = PGLiteEngine.prototype.executeRaw;
    PGLiteEngine.prototype.executeRaw = async function(sql, ...args) {
      if (sql === 'SELECT count(*)::integer AS n FROM pages') { late = true; sampler(); }
      return execute.call(this, sql, ...args);
    };
    const result = await runReadLatencyWorkload(${options});
    console.log(JSON.stringify({ diagnostic_test: true, result: { ...result, injected } }));
  `);
  expect(result.injected).toBe(true);
  expect(result.ok).toBe(true);
  expect(result.rss_unavailable_samples).toBe(1);
  expect(result.metrics.filter((sample: any) => sample.rss_bytes === null)).toHaveLength(1);
  expect(result.peak_rss_bytes).toBe(Math.max(...result.metrics.flatMap((sample: any) => sample.rss_bytes === null ? [] : [sample.rss_bytes])));
  expect(result.peak_queue_age_ms).toBe(Math.max(0, ...result.metrics.map((sample: any) => sample.queue_age_ms)));
  expect(result.peak_recovery_bytes).toBe(Math.max(0, ...result.metrics.map((sample: any) => sample.recovery_bytes)));
  expect(result.diagnostics.failures.total).toBe(0);
}, 120_000);

test('failed loaded lexical arm remains invalid and retains its partial query without raw errors', async () => {
  const result = await child(`
    import { PGLiteEngine } from ${engineImport};
    import { runReadLatencyWorkload } from ${workloadImport};
    const original = PGLiteEngine.prototype.searchKeyword; let calls = 0;
    PGLiteEngine.prototype.searchKeyword = async function(...args) {
      if (++calls === 24) throw new Error('unsafe lexical payload');
      return original.apply(this, args);
    };
    const result = await runReadLatencyWorkload(${options});
    console.log(JSON.stringify({ diagnostic_test: true, result }));
  `);
  expect(result.ok).toBe(false);
  expect(result.phase_a.queries_run).toBe(20);
  expect(result.diagnostics.reads.records.some((r: any) => r.phase === 'loaded' && r.outcome === 'rejected')).toBe(true);
  expect(result.diagnostics.failures.records.some((r: any) => r.stage === 'keyword')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('unsafe lexical payload');
}, 120_000);
