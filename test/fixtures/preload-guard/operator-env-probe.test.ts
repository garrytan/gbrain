/**
 * Probe fixture for test/operator-env-preload.test.ts.
 *
 * The parent test spawns `bun test` on this file with a controlled ambient
 * environment and asserts on what SURVIVED the preload stack, read back from
 * the JSON report written here. The probed names arrive via
 * GBRAIN_TEST_OPERATOR_ENV_PROBE_NAMES (comma-separated) so the parent stays
 * the single source of truth — this probe never dumps the whole environment,
 * whose values on a dev shell can be secrets.
 *
 * When the report-path var is absent (normal suite discovery running this
 * file directly), it passes as a no-op, like guard-probe.test.ts.
 */
import { test, expect } from 'bun:test';
import { writeFileSync } from 'fs';

test('probe: report surviving ambient env after preloads', () => {
  const out = process.env.GBRAIN_TEST_OPERATOR_ENV_PROBE_OUT;
  if (!out) {
    expect(true).toBe(true);
    return;
  }
  const names = (process.env.GBRAIN_TEST_OPERATOR_ENV_PROBE_NAMES ?? '')
    .split(',')
    .filter(Boolean);
  const seen: Record<string, string | null> = {};
  for (const name of names) seen[name] = process.env[name] ?? null;
  writeFileSync(out, JSON.stringify(seen));
});
