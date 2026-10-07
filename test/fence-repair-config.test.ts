/**
 * #6188 PR3 fence repair caps (src/core/fence-repair/config.ts).
 *
 * Protects: `fences.repair.max_usd_per_page` (default 0.30) and
 * `fences.repair.max_usd_per_day` (default 1.00) are registered keys that
 * `gbrain config set` accepts as non-negative USD amounts (0 = no model
 * spend) and refuses otherwise with nothing written; the reader keeps the
 * default for an unset or unreadable value and says whether the cap is the
 * user's (an unpriced model is refused only under a user cap).
 * Fails when: a negative, empty or non-numeric cap is accepted, 0 is refused,
 * a key is missing from KNOWN_CONFIG_KEYS, or an unset cap reads as 0.
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import {
  FENCE_CONFIG_KEYS, FENCE_REPAIR_MAX_USD_PER_DAY_KEY, FENCE_REPAIR_MAX_USD_PER_PAGE_KEY, readFenceRepairCaps, validateFenceConfigValue,
} from '../src/core/fence-repair/config.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); }, 60_000);

describe('fence repair caps', () => {
  test('both keys are registered and accept non-negative USD amounts, 0 included', () => {
    for (const key of [FENCE_REPAIR_MAX_USD_PER_PAGE_KEY, FENCE_REPAIR_MAX_USD_PER_DAY_KEY]) {
      expect(KNOWN_CONFIG_KEYS).toContain(key);
      expect(FENCE_CONFIG_KEYS).toContain(key);
      for (const ok of ['0', '0.05', '1.00', '12', ' 2.5 ']) expect(validateFenceConfigValue(key, ok)).toBeNull();
      for (const bad of ['-1', '-0.01', '', 'abc', '1e3', '0x10', 'Infinity', 'true', '1.']) {
        expect(validateFenceConfigValue(key, bad)).toBe(`${key} must be a non-negative USD amount such as 0.05 (0 means no model spend on fence repair; got "${bad}"). Nothing was written.`);
      }
    }
    expect(validateFenceConfigValue('fences.normalize', 'false')).toBeNull();
    expect(validateFenceConfigValue('fences.normalize', '0.05')).toContain('must be true or false');
    expect(validateFenceConfigValue('fences.repair.max_usd', '1')).toContain('Unknown config key');
  });

  test('the reader keeps the defaults until the user sets a cap, and reports whose cap it is', async () => {
    expect(await readFenceRepairCaps(engine)).toEqual({ perPageUsd: 0.3, perDayUsd: 1, perPageSource: 'default', perDaySource: 'default' });
    await engine.setConfig(FENCE_REPAIR_MAX_USD_PER_DAY_KEY, '0');
    await engine.setConfig(FENCE_REPAIR_MAX_USD_PER_PAGE_KEY, '0.2');
    expect(await readFenceRepairCaps(engine)).toEqual({ perPageUsd: 0.2, perDayUsd: 0, perPageSource: 'user', perDaySource: 'user' });
    await engine.setConfig(FENCE_REPAIR_MAX_USD_PER_PAGE_KEY, 'garbage');
    expect((await readFenceRepairCaps(engine)).perPageUsd).toBe(0.3);
    const failing = { getConfig: async () => { throw new Error('config table unavailable'); } };
    expect(await readFenceRepairCaps(failing)).toEqual({ perPageUsd: 0.3, perDayUsd: 1, perPageSource: 'default', perDaySource: 'default' });
  });
});
