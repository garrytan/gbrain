/**
 * v0.32.3 — doctor search_mode + eval_drift check tests.
 * Pins [CDX-20]: status stays 'ok', no health-score docking; hint lives
 * in `message`. Tests the two exported helpers directly to avoid the
 * expensive full runDoctor walk.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSearchMode, checkEvalDrift } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'search.%'`);
});

describe('checkSearchMode [CDX-20]', () => {
  test('unset mode → ok with hint to pick a mode', async () => {
    const c = await checkSearchMode(engine);
    expect(c.name).toBe('search_mode');
    expect(c.status).toBe('ok'); // never warn, never dock score
    expect(c.message).toMatch(/unset/i);
    expect(c.message).toContain('gbrain search modes');
  });

  test('mode set, no overrides → ok with "canonical" message', async () => {
    await engine.setConfig('search.mode', 'balanced');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('balanced');
    expect(c.message).toContain('canonical');
  });

  test('mode set + overrides → ok with reset hint + override list', async () => {
    await engine.setConfig('search.mode', 'conservative');
    await engine.setConfig('search.cache.enabled', 'false');
    await engine.setConfig('search.tokenBudget', '8000');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok'); // [CDX-20]: still ok, never warn
    expect(c.message).toContain('conservative');
    expect(c.message).toContain('search.cache.enabled');
    expect(c.message).toContain('search.tokenBudget');
    expect(c.message).toContain('gbrain search modes --reset');
  });

  test('upgrade-notice state key is excluded from override count', async () => {
    await engine.setConfig('search.mode', 'balanced');
    await engine.setConfig('search.mode_upgrade_notice_shown', 'true');
    const c = await checkSearchMode(engine);
    expect(c.message).toContain('no per-key overrides');
  });

  test('tokenmax mode is recognized without any override warning', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('tokenmax');
    expect(c.message).toContain('canonical');
  });
});

describe('checkEvalDrift [CDX-6]', () => {
  test('returns ok status (never warn — per [CDX-20])', async () => {
    const c = await checkEvalDrift(engine);
    expect(c.name).toBe('eval_drift');
    expect(c.status).toBe('ok');
  });

  test('message is non-empty (either no-drift or drift summary)', async () => {
    const c = await checkEvalDrift(engine);
    expect(c.message).toBeTruthy();
    expect(c.message.length).toBeGreaterThan(0);
  });
});
