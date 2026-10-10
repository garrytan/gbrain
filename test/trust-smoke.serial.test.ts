/**
 * The DX-18 memory-trust contributor smoke runs green (#5575): tier stamp,
 * gate verdict, owner confirm and purge through real write paths on a
 * zero-key in-memory PGLite (scripts/trust-smoke.ts, `bun run trust:smoke`).
 * Serial: the trust brain sets GBRAIN_HOME for its run.
 */
import { expect, test } from 'bun:test';
import { runTrustSmoke } from '../scripts/trust-smoke.ts';

test('every memory-trust smoke check passes', async () => {
  const checks = await runTrustSmoke();
  expect(new Set(checks.map(c => c.seam))).toEqual(new Set(['tier stamp', 'gate verdict', 'owner confirm', 'purge']));
  expect(checks.filter(c => !c.ok)).toEqual([]);
}, 120_000);
