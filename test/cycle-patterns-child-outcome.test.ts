/**
 * #2782 — patterns phase status must reflect the child subagent outcome.
 *
 * Pre-fix, runPhasePatterns returned status:ok with child_outcome:timeout and
 * zero pattern pages written (e.g. when no subagent-capable worker slot was
 * free for the whole wait window) — a silent no-op for days.
 *
 * Drives the real phase against PGLite with the (#1594-family) configurable
 * wait timeout set to 1ms and NO worker running, so the child job never
 * completes: waitForCompletion throws TimeoutError → outcome 'timeout' →
 * nothing written → the phase must report status 'fail', not 'ok'.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  // resetPgliteState truncates `config`, wiping the `version` row that
  // MinionQueue.ensureSchema checks. Capture it so beforeEach can restore.
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

async function seedReflections(): Promise<void> {
  // Enough recent reflections to clear min_evidence (default 3).
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth)
       VALUES ($1, 'note', $2, $3)`,
      [
        `wiki/personal/reflections/2026-07-0${i + 1}-reflection`,
        `Reflection ${i + 1}`,
        `Recurring theme fixture number ${i + 1}.`,
      ],
    );
  }
}

describe('runPhasePatterns child-outcome status (#2782)', () => {
  test('child timeout with zero writes → status fail (was silent ok)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-outcome-'));
    try {
      await seedReflections();

      // #1594-family knob: make the wait window elapse immediately. No
      // minion worker runs in this test, so the child job stays queued.
      await engine.setConfig('dream.patterns.subagent_wait_timeout_ms', '1');

      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('fail');
      expect(result.details.child_outcome).toBe('timeout');
      expect(result.details.patterns_written).toBe(0);
      expect(result.error?.code).toBe('PATTERNS_CHILD_TIMEOUT');
      expect(result.error?.class).toBe('Timeout');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('dream.patterns.subagent_timeout_ms flows to the submitted job', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-timeout-'));
    try {
      await seedReflections();
      await engine.setConfig('dream.patterns.subagent_timeout_ms', '600000');
      await engine.setConfig('dream.patterns.subagent_wait_timeout_ms', '1');

      await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false }),
      );

      const jobs = await engine.executeRaw<{ timeout_ms: string | number | null }>(
        `SELECT timeout_ms FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      expect(jobs).toHaveLength(1);
      expect(Number(jobs[0]!.timeout_ms)).toBe(600000);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);
});
