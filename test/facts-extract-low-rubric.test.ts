import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { buildExtractorSystem, EXTRACTION_LOW_DEFINITION, getExtractorVariant } from '../src/core/facts/extract.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Base prompt bytes pinned from the locally recorded upstream/master.
const upstreamHashes = [
  '5df290c0002bfc73371897c339e1a34e33caf844e3fb6d24b35c05d47e862ddf',
  'a4b468b86e867f3703a4c834583f5ac9a99f47ff4f0c50484fdd6b22706465c7',
];
for (const admits of [false, true]) test(`low rubric prompt, admitsLow=${admits}`, () => {
  const off = buildExtractorSystem(admits);
  const on = buildExtractorSystem(admits, { lowRubric: true });
  expect(createHash('sha256').update(off).digest('hex')).toBe(upstreamHashes[Number(admits)]);
  expect(buildExtractorSystem(admits, { lowRubric: false })).toBe(off);
  expect(on).toContain(EXTRACTION_LOW_DEFINITION);
  expect(on.replace(EXTRACTION_LOW_DEFINITION,
    '  * "low": Logistical noise, restaurant orders, routine scheduling, "we\'re at X place".')).toBe(off);
  for (const prompt of [off, on]) {
    expect(prompt).toContain('else a display name the caller can canonicalize');
    expect(prompt).toContain(admits ? 'Label honestly' : 'Skip entirely');
  }
  for (const dateGrounding of [false, true]) for (const attribution of [false, true]) {
    const variant = { dateGrounding, attribution };
    expect(buildExtractorSystem(admits, { ...variant, lowRubric: true }).replace(EXTRACTION_LOW_DEFINITION,
      '  * "low": Logistical noise, restaurant orders, routine scheduling, "we\'re at X place".'))
      .toBe(buildExtractorSystem(admits, variant));
  }
});
test('expanded low rubric is registered and opt-in', async () => {
  expect(KNOWN_CONFIG_KEYS.includes('facts.extraction_low_rubric')).toBe(true);
  expect((await getExtractorVariant()).lowRubric).toBeUndefined();
  for (const value of [null, 'off', 'on', ' ON ', 'true', 'invalid']) {
    const engine = { getConfig: async () => value } as unknown as BrainEngine;
    expect((await getExtractorVariant(engine)).lowRubric).toBe(value?.trim().toLowerCase() === 'on');
  }
  const failing = { getConfig: async () => { throw new Error('unavailable'); } } as unknown as BrainEngine;
  expect((await getExtractorVariant(failing)).lowRubric).toBe(false);
});
