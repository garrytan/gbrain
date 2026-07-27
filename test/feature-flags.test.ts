/**
 * Tests for src/core/feature-flags.ts (v0.40 D23).
 *
 * Pin the default-on posture and the explicit-'false'-disables semantics.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { isFederatedV2Enabled, FEDERATED_V2_CONFIG_KEY } from '../src/core/feature-flags.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('isFederatedV2Enabled', () => {
  test('default (key unset) → enabled', async () => {
    expect(await isFederatedV2Enabled(engine)).toBe(true);
  });

  test('explicit "false" → disabled', async () => {
    await engine.setConfig(FEDERATED_V2_CONFIG_KEY, 'false');
    expect(await isFederatedV2Enabled(engine)).toBe(false);
  });

  test('explicit "true" → enabled', async () => {
    await engine.setConfig(FEDERATED_V2_CONFIG_KEY, 'true');
    expect(await isFederatedV2Enabled(engine)).toBe(true);
  });

  test('anything-not-literally-false → enabled (defensive default)', async () => {
    for (const v of ['False', 'FALSE', '0', 'off', 'no', '']) {
      await engine.setConfig(FEDERATED_V2_CONFIG_KEY, v);
      expect(await isFederatedV2Enabled(engine)).toBe(true);
    }
  });

  test('config key name is stable', () => {
    expect(FEDERATED_V2_CONFIG_KEY).toBe('sync.federated_v2');
  });
});
