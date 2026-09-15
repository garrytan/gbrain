// #4879: the patterns phase re-ran a paid subagent on the same unchanged
// reflections every autopilot tick (no completion stamp, unlike synthesize /
// auto_think). The fix is a knob-free evidence watermark: a completed run
// stamps `dream.patterns.last_evidence_ts` = max reflection updated_at, and
// the phase skips (`no_new_evidence`) while nothing is newer than that.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const STAMP_KEY = 'dream.patterns.last_evidence_ts';

// Mutable so T4 can drive the child to a non-completed outcome.
let childStatus = 'completed';

mock.module('../src/core/ai/gateway.ts', () => ({
  probeChatModel: () => ({ ok: true }),
}));

mock.module('../src/core/cycle/synthesize.ts', () => ({
  loadAllowedSlugPrefixes: async () => ['wiki/personal/patterns/*'],
  loadOutputRoot: async () => 'wiki',
  runSubagentsInline: async () => undefined,
}));

mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  TimeoutError: class TimeoutError extends Error {},
  waitForCompletion: async (_queue: unknown, jobId: number) => ({
    id: jobId,
    status: childStatus,
  }),
  // A module mock replaces the WHOLE module, so it must export every named
  // import its consumers reach for (a missing one is a load-time SyntaxError).
  waitForCompletionRenewing: async (
    _queue: unknown,
    jobId: number,
    opts?: { renew?: () => Promise<void> },
  ) => {
    if (opts?.renew) await opts.renew();
    return { id: jobId, status: childStatus };
  },
}));

const { runPhasePatterns } = await import('../src/core/cycle/patterns.ts');

let engine: PGLiteEngine;
let schemaVersion: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-evidence-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  childStatus = 'completed';
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
  await seedReflections();
});

const reflectionSlug = (i: number) => `wiki/personal/reflections/2026-08-0${i + 1}-reflection`;

async function seedReflections(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth)
       VALUES ($1, 'note', $2, $3)`,
      [reflectionSlug(i), `Reflection ${i + 1}`, `Recurring theme fixture number ${i + 1}.`],
    );
  }
}

async function maxReflectionUpdatedAt(): Promise<string> {
  const rows = await engine.executeRaw<{ m: string | Date }>(
    `SELECT max(updated_at) AS m FROM pages WHERE slug LIKE 'wiki/personal/reflections/%'`,
  );
  return new Date(rows[0].m).toISOString();
}

describe('runPhasePatterns evidence watermark (#4879)', () => {
  test('T1: completed run stamps max reflection updated_at; identical re-run skips no_new_evidence', async () => {
    const first = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(first.status).toBe('ok');
    expect(first.details.child_outcome).toBe('completed');

    expect(await engine.getConfig(STAMP_KEY)).toBe(await maxReflectionUpdatedAt());

    const second = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(second.status).toBe('skipped');
    expect(second.details.reason).toBe('no_new_evidence');
    expect(second.summary).toContain('--once');
  });

  test('T2: an edited reflection re-arms the phase and advances the stamp', async () => {
    const first = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(first.status).toBe('ok');
    const stampBefore = await engine.getConfig(STAMP_KEY);
    expect(stampBefore).toBeTruthy();

    const later = new Date(Date.parse(stampBefore!) + 5_000).toISOString();
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = 'edited', updated_at = $2::timestamptz WHERE slug = $1`,
      [reflectionSlug(1), later],
    );

    const second = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(second.status).toBe('ok');
    expect(await engine.getConfig(STAMP_KEY)).toBe(later);
  });

  test('T3: --once bypasses the gate and still stamps the consumed evidence', async () => {
    // A stamp in the future would gate every normal run.
    await engine.setConfig(STAMP_KEY, new Date(Date.now() + 60_000).toISOString());

    const forced = await runPhasePatterns(engine, { brainDir, dryRun: false, once: true });
    expect(forced.status).toBe('ok');
    // A manually consumed evidence set must not be re-paid by the next tick.
    expect(await engine.getConfig(STAMP_KEY)).toBe(await maxReflectionUpdatedAt());
  });

  test('T4: a non-completed child does not stamp (retried next tick)', async () => {
    childStatus = 'timeout';
    const result = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(result.status).toBe('fail');
    expect(result.error?.code).toBe('PATTERNS_CHILD_TIMEOUT');
    expect(await engine.getConfig(STAMP_KEY)).toBeNull();
  });

  test('T5: dry-run reports the skip honestly when nothing is newer', async () => {
    await engine.setConfig(STAMP_KEY, await maxReflectionUpdatedAt());
    const result = await runPhasePatterns(engine, { brainDir, dryRun: true });
    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('no_new_evidence');
  });
});
