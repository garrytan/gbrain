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
 *
 * v0.48.2: the mode-bundle default is the LIVE voyage reranker, so the
 * bundle-only cases are back to the original [CDX-20] `ok` and a reset can
 * never re-arm a dying provider — only an EXPLICIT zeroentropyai:* override
 * still warns.
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
  test('unset mode → ok with pick-a-mode hint (balanced fallback reranks with the live voyage default)', async () => {
    const c = await checkSearchMode(engine);
    expect(c.name).toBe('search_mode');
    // [CDX-20] original never-warn contract holds again: the balanced
    // fallback's reranker is live (v0.48.2), so no sunset claim.
    expect(c.status).toBe('ok');
    expect(c.message).toMatch(/unset/i);
    expect(c.message).toContain('gbrain search modes');
    expect(c.message).not.toContain(ZEROENTROPY_SUNSET_DATE);
  });

  test('mode set, no overrides → "canonical" message, ok (balanced reranks with the live default)', async () => {
    await engine.setConfig('search.mode', 'balanced');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('balanced');
    expect(c.message).toContain('canonical');
    expect(c.message).not.toContain(ZEROENTROPY_SUNSET_DATE);
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
    // tokenmax bundle reranks with the live voyage default → ok.
    expect(c.status).toBe('ok');
    expect(c.message).toContain('tokenmax');
    expect(c.message).toContain('canonical');
    expect(c.message).not.toContain(ZEROENTROPY_SUNSET_DATE);
  });
});

describe('checkSearchMode sunset-awareness (#3657/#4382)', () => {
  test('explicit voyage overrides equal to the live bundle default → plain --reset advice, no sunset claims (v0.48.2)', async () => {
    // The old #4382 repro: tokenmax + explicit voyage reranker overrides. A
    // reset now restores the SAME live model, so consolidation is safe again.
    await engine.setConfig('search.mode', 'tokenmax');
    await engine.setConfig('search.reranker.enabled', 'true');
    await engine.setConfig('search.reranker.model', NEW_INSTALL_DEFAULT_RERANKER_MODEL);
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('gbrain search modes --reset');
    expect(c.message).not.toContain('load-bearing');
    expect(c.message).not.toContain(LEGACY_DEFAULT_RERANKER_MODEL);
    expect(c.message).not.toContain(ZEROENTROPY_SUNSET_DATE);
    // Override roster stays visible.
    expect(c.message).toContain('search.reranker.model');
  });

  test('bundle default, no overrides (balanced) → ok, no sunset date, no reset advice needed', async () => {
    await engine.setConfig('search.mode', 'balanced');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).not.toContain(LEGACY_DEFAULT_RERANKER_MODEL);
    expect(c.message).not.toContain(ZEROENTROPY_SUNSET_DATE);
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

  test('reranker disabled by override → plain --reset advice (a reset re-arms the LIVE default, not a dying one)', async () => {
    await engine.setConfig('search.mode', 'balanced');
    await engine.setConfig('search.reranker.enabled', 'false');
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('gbrain search modes --reset');
    expect(c.message).not.toContain(ZEROENTROPY_SUNSET_DATE);
  });

  test('an explicit search.reranker.model equal to the bundle default is called redundant with a precise unset, never --reset', async () => {
    // Every v0.46.3–v0.47.10 Voyage install carries this row from init.
    await engine.setConfig('search.mode', 'balanced');
    await engine.setConfig('search.reranker.model', NEW_INSTALL_DEFAULT_RERANKER_MODEL);
    const c = await checkSearchMode(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('redundant');
    expect(c.message).toContain('gbrain config unset search.reranker.model');
    expect(c.message).not.toContain('--reset');
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
