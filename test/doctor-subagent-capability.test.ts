// v0.42.x — `subagent_capability` doctor check: explicit `models.subagent`
// precedence over `models.tier.subagent` (residual hunk from #2112; fix-wave A
// / #2820 superseded the rest of that PR but not this one).
//
// Pinned contracts:
//   - explicit `models.subagent` set (bad model) + `models.tier.subagent` set
//     (good model) → warn attributed to `models.subagent` (explicit wins,
//     doesn't fall through to the tier value).
//   - explicit `models.subagent` unset, `models.tier.subagent` set (bad model)
//     → warn attributed to `models.tier.subagent` (unchanged fallback order).
//   - explicit `models.subagent` set (good model) → ok, message references
//     the explicit model.
//
// Hermetic: PGLite, per CLAUDE.md R1/R3/R4.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSubagentCapability } from '../src/commands/doctor.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('subagent_capability: explicit models.subagent precedence (#2112 residual)', () => {
  test('explicit models.subagent (bad) wins over models.tier.subagent (good) → warn attributed to models.subagent', async () => {
    await engine.setConfig('models.subagent', 'bogus-provider:not-a-real-model');
    await engine.setConfig('models.tier.subagent', 'anthropic:claude-sonnet-4-6');

    const check = await checkSubagentCapability(engine);

    expect(check.status).toBe('warn');
    expect(check.message).toContain('models.subagent');
    expect(check.message).toContain('bogus-provider:not-a-real-model');
    // Must be attributed to the explicit key, not silently fall through to
    // the (good) tier value's source label instead.
    expect(check.message).not.toContain('models.tier.subagent');
  });

  test('models.subagent unset, models.tier.subagent (bad) → warn attributed to models.tier.subagent (unchanged fallback)', async () => {
    await engine.setConfig('models.tier.subagent', 'bogus-provider:not-a-real-model');

    const check = await checkSubagentCapability(engine);

    expect(check.status).toBe('warn');
    expect(check.message).toContain('models.tier.subagent');
    expect(check.message).toContain('bogus-provider:not-a-real-model');
  });

  test('explicit models.subagent (good) → ok, message references the explicit model', async () => {
    await engine.setConfig('models.subagent', 'anthropic:claude-sonnet-4-6');
    // Tier left unset entirely, and modelsDefault unset, so if precedence were
    // wrong (fell through past explicit) the ok message would say "default"
    // instead of naming the explicit model.

    const check = await checkSubagentCapability(engine);

    expect(check.status).toBe('ok');
    expect(check.message).toContain('Subagent model resolves to "anthropic:claude-sonnet-4-6"');
  });
});
