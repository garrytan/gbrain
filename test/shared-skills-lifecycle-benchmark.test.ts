import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { WriteTimingRecorder } from '../scripts/persistence/read-admission.ts';
import { LifecycleMeter, sharedReadGateSample, summarizeLifecycleReadGate, validateOptions } from '../scripts/shared-skills/lifecycle-metrics.ts';

function sample(loaded = 15, intervalEnd = 100, failures = 0) {
  const writes = new WriteTimingRecorder(); writes.start('synthetic-write', 0); writes.admitted('synthetic-write', 1); writes.complete('synthetic-write', intervalEnd);
  return sharedReadGateSample({ idle: [10, 10, 10], loaded: [loaded, loaded, loaded], started: 0, ended: 100,
    writes, durableCommits: [50], failures, correctness: true });
}
test('lifecycle gate preserves median-of-three p99 ratio at exactly1.5x', () => {
  expect(summarizeLifecycleReadGate([sample(), sample(), sample()]).verdict).toBe('pass');
  const slower = summarizeLifecycleReadGate([sample(15.01), sample(15.01), sample(15.01)]);
  expect(slower.ok).toBe(true); expect(slower.verdict).toBe('fail'); expect(slower.threshold_pct).toBe(50);
});
test('lifecycle gate cannot pass incomplete runs, low overlap or failed writes', () => {
  expect(summarizeLifecycleReadGate([sample()]).verdict).toBe('fail');
  expect(summarizeLifecycleReadGate([sample(10, 89.9), sample(10), sample(10)]).ok).toBe(false);
  expect(summarizeLifecycleReadGate([sample(10, 100, 1), sample(10), sample(10)]).ok).toBe(false);
  const missingAdmission = sample(10); missingAdmission.admission.count = 0;
  expect(summarizeLifecycleReadGate([missingAdmission, sample(10), sample(10)]).ok).toBe(false);
});
test('lifecycle overlap includes idle gaps rather than first-to-last writer span', () => {
  const writes = new WriteTimingRecorder();
  writes.start('one', 0); writes.admitted('one', 1); writes.complete('one', 30);
  writes.start('two', 70); writes.admitted('two', 71); writes.complete('two', 100);
  const measured = sharedReadGateSample({ idle: [10], loaded: [10], started: 0, ended: 100, writes, durableCommits: [20, 90], failures: 0, correctness: true });
  expect(measured.overlap_pct).toBe(60);
  expect(summarizeLifecycleReadGate([measured, measured, measured]).verdict).toBe('fail');
});
test('lifecycle observer only records recovery reservations after the outer transaction commits', async () => {
  let rejectCommit = false;
  const base = {
    async transaction<T>(run: (tx: BrainEngine) => Promise<T>): Promise<T> {
      const value = await run(base as unknown as BrainEngine);
      if (rejectCommit) throw new Error('synthetic rollback');
      return value;
    },
    async executeRaw() { return []; },
  };
  const meter = new LifecycleMeter(); const observed = meter.observe(base as unknown as BrainEngine);
  meter.startWrite('request');
  await observed.transaction(async () => ({ id: 'row', request_id: 'request', state: 'queued', principal_kind: 'local_cli', intent_bytes: 42 }));
  const reserve = (tx: BrainEngine) => tx.executeRaw('UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4,updated_at=now()', ['row', 'attempt', '{}', 1024]);
  rejectCommit = true;
  await expect(observed.transaction(reserve)).rejects.toThrow('synthetic rollback');
  expect(meter.recovery).toHaveLength(0);
  rejectCommit = false;
  await observed.transaction(reserve);
  expect(meter.recovery).toHaveLength(1); expect(meter.recovery[0].bytes).toBe(1024);
  await observed.transaction(async () => ({ id: 'row', request_id: 'request', state: 'committed', principal_kind: 'local_cli' }));
  meter.finishWrite('request');
  expect(meter.timings.admissionMs).toHaveLength(1); expect(meter.durableCommits.has('request')).toBe(true);
});
test('lifecycle options bound corpus, concurrency, payloads and writer pressure', () => {
  const base = { sizes: [10, 100, 1000], members: 3, queries: 200, runs: 3, maxWrites: 256, assetBytes: 16 * 1024 };
  expect(() => validateOptions(base)).not.toThrow();
  for (const overrides of [{ sizes: [1001] }, { sizes: [10, 10] }, { members: 9 }, { queries: 2 }, { runs: 4 }, { maxWrites: 257 }, { assetBytes: 65537 }]) {
    expect(() => validateOptions({ ...base, ...overrides })).toThrow();
  }
});

test.skipIf(process.env.GBRAIN_TEST_SHARED_LIFECYCLE_SMOKE !== '1')('opt-in tiny lifecycle smoke never claims the full performance gate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gbrain-lifecycle-smoke-result-'));
  try {
    const { runLifecycleBenchmark } = await import('../scripts/shared-skills/lifecycle.ts');
    const path = join(directory, 'smoke.json');
    const result = await runLifecycleBenchmark({ engine: 'pglite', sizes: [2], members: 2, queries: 4, runs: 1,
      maxWrites: 4, assetBytes: 128, warmChecks: 1, manifest: path, smoke: true });
    expect(result.correctness_pass).toBe(true); expect(result.full_gate).toBe(false);
    const recorded = JSON.parse(readFileSync(path, 'utf8'));
    expect(recorded.samples[0].seed.mode).toContain('NOT a measured canonical publication');
    expect(recorded.samples[0].cold_fetch_and_ack.verified_skill_revisions).toBe(4);
    expect(recorded.samples[0].publication.recovery_reserved_bytes.observations).toBeGreaterThan(0);
    expect(recorded.samples[0].queue_and_memory.recovery_bytes_end).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
