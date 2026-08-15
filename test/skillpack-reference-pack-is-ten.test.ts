/**
 * Regression test pinning examples/skillpack-reference/ at 10/10.
 *
 * Per the locked DX spec: every gbrain-shipped skillpack must score 10/10.
 * If this test ever fails, gbrain is shipping below the bar it demands of
 * third-party publishers. Fix the reference pack, never lower the bar.
 */
import { describe, test, expect } from 'bun:test';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { runDoctor } from '../src/core/skillpack/doctor.ts';

// Resolve the absolute path to examples/skillpack-reference relative to
// the test file location — works whether tests run from repo root or
// from any nested workdir.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_PACK_PATH = resolve(__dirname, '..', 'examples', 'skillpack-reference');

describe('examples/skillpack-reference — 10/10 invariant', () => {
  test('runDoctor --quick on the reference pack scores 10/10 endorsed', async () => {
    const r = await runDoctor({ packRoot: REFERENCE_PACK_PATH, mode: 'quick' });
    if (r.score !== 10) {
      const failed = r.dimensions.filter((d) => !d.passed).map((d) => `${d.id}.${d.name} (${d.detail})`);
      throw new Error(
        `Reference pack regressed below 10/10. Failing dimensions:\n  ${failed.join('\n  ')}\n\n` +
          `This is the bar gbrain demands of third-party publishers. Fix the reference pack, do not lower the rubric.`,
      );
    }
    expect(r.score).toBe(10);
    expect(r.tier_eligibility).toBe('endorsed');
  });

  test('reference pack manifest validates + exports the expected skill', async () => {
    const r = await runDoctor({ packRoot: REFERENCE_PACK_PATH, mode: 'quick' });
    expect(r.pack_name).toBe('reference-pack');
    expect(r.dimensions.find((d) => d.name === 'manifest_valid')?.passed).toBe(true);
  });
});
