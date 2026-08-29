/**
 * v0.32.3 — doctor search_mode + eval_drift check tests.
 * Pins [CDX-20]: status stays 'ok', no health-score docking; hint lives
 * in `message`. Tests the two exported helpers directly to avoid the
 * expensive full runDoctor walk.
 *
 * #3657/#4382 sunset-awareness amends [CDX-20]: when the ACTIVE resolved
 * reranker is on the sunset list (RERANKER_SUNSETS), search_mode DOES warn
 * (with the sunset date), and the `gbrain search modes --reset` advice is
 * withheld whenever a reset would re-arm a sunsetting reranker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSearchMode, checkEvalDrift } from '../src/commands/doctor.ts';
import {
  ZEROENTROPY_SUNSET_DATE,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
  LEGACY_DEFAULT_RERANKER_MODEL,
} from '../src/core/ai/defaults.ts';

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
  test('unset mode → warn (balanced fallback arms the sunsetting reranker) with pick-a-mode hint', async () => {
    const c = await checkSearchMode(engine);
    expect(c.name).toBe('search_mode');
    // Balanced fallback resolves reranker_enabled=true on the sunsetting
    // legacy default → sunset warn (amends the original [CDX-20] never-warn).
    expect(c.status).toBe('warn');
    expect(c.message).toMatch(/unset/i);
    expect(c.message).toContain('gbrain search modes');
    expect(c.message).toContain(ZEROENTROPY_SUNSET_DATE);
  });

  test('mode set, no overrides → "canonical" message survives (with sunset warn for balanced)', async () => {
    await engine.setConfig('search.mode', 'balanced');
    const c = await checkSearchMode(engine);
    // balanced bundle reranks with the sunsetting legacy default → warn.
    expect(c.status).toBe('warn');
    expect(c.message).toContain('balanced');
    expect(c.message).toContain('canonical');
    expect(c.message).toContain(ZEROENTROPY_SUNSET_DATE);
  });

  test('mode set + overrides → ok with reset hint + override list (sunset-clean mode)', async () => {
    await engine.setConfig('search.mode', 'conservative');
    await engine.setConfig('search.cache.enabled', 'false');
    await engine.setConfig('search.tokenBudget', '8000');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok'); // [CDX-20]: conservative reranks nothing → still ok
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

  test('tokenmax mode is recognized; no override roster in message', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    const c = await checkSearchMode(engine);
    // tokenmax bundle reranks with the sunsetting legacy default → warn.
    expect(c.status).toBe('warn');
    expect(c.message).toContain('tokenmax');
    expect(c.message).toContain('canonical');
  });
});

describe('checkSearchMode sunset-awareness (#3657/#4382)', () => {
  test('overrides holding the reranker OFF the sunsetting bundle default → reset advice withheld, named load-bearing', async () => {
    // The exact #4382 repro: tokenmax + explicit voyage reranker overrides.
    await engine.setConfig('search.mode', 'tokenmax');
    await engine.setConfig('search.reranker.enabled', 'true');
    await engine.setConfig('search.reranker.model', 'voyage:rerank-2.5');
    const c = await checkSearchMode(engine);
    // State is healthy — it's the RECOMMENDATION that was the hazard (#4382).
    expect(c.status).toBe('ok');
    expect(c.message).not.toContain('--reset');
    expect(c.message).toContain('load-bearing');
    // Names what a reset would restore + when it dies.
    expect(c.message).toContain(LEGACY_DEFAULT_RERANKER_MODEL);
    expect(c.message).toContain(ZEROENTROPY_SUNSET_DATE);
    // Override roster stays visible.
    expect(c.message).toContain('search.reranker.model');
  });

  test('active reranker on the sunset list (bundle default, no overrides) → warn with sunset date + replacement', async () => {
    await engine.setConfig('search.mode', 'balanced');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain(LEGACY_DEFAULT_RERANKER_MODEL);
    expect(c.message).toContain(ZEROENTROPY_SUNSET_DATE);
    expect(c.message).toContain(NEW_INSTALL_DEFAULT_RERANKER_MODEL);
    expect(c.message).not.toContain('--reset');
  });

  test('active sunsetting reranker via explicit override → warn, never a reset into the same dying default', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    await engine.setConfig('search.reranker.model', 'zeroentropyai:zerank-1');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('zeroentropyai:zerank-1');
    expect(c.message).toContain(ZEROENTROPY_SUNSET_DATE);
    expect(c.message).not.toContain('--reset');
  });

  test('reranker disabled by override → reset advice withheld (reset would re-arm the sunsetting default)', async () => {
    await engine.setConfig('search.mode', 'balanced');
    await engine.setConfig('search.reranker.enabled', 'false');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).not.toContain('--reset');
    expect(c.message).toContain(ZEROENTROPY_SUNSET_DATE);
  });

  test('sunset-clean mode + overrides keeps the --reset recommendation (conservative bundle reranks nothing)', async () => {
    await engine.setConfig('search.mode', 'conservative');
    await engine.setConfig('search.cache.enabled', 'false');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('gbrain search modes --reset');
    expect(c.message).not.toContain(ZEROENTROPY_SUNSET_DATE);
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
