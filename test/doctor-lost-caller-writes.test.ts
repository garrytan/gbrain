/**
 * lost_caller_writes doctor check (#6429): caller writes refused at
 * publication whose receipt still holds the intent are counted per source
 * with the explicit-only replay's preview. The warn path, the replay and the
 * clearing are exercised end to end in test/repair-failed-writes-conflict-6429.test.ts.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { lostCallerWritesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { REPAIR_REGISTRY } from '../src/core/repair/registry.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('a brain with no refused caller writes is ok, and the check is wired to the explicit-only replay', async () => {
  const check = await lostCallerWritesCheck(engine);
  expect(check.status).toBe('ok');
  expect(check.details).toMatchObject({ count: 0, writes: [], compacted_unreplayable: 0, repair: 'failed-writes' });
  expect(categorizeCheck('lost_caller_writes')).toBe('ops');
  const spec = WAVE_CHECKS.find(spec => spec.id === 'lost_caller_writes');
  expect(spec).toMatchObject({ resolution: 'repair', registration: 'wave' });
  expect(REPAIR_REGISTRY.find(spec => spec.kind === 'failed-writes')?.checks).toContain('lost_caller_writes');
});
