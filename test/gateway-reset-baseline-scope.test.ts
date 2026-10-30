/**
 * The test preload's reset baseline (test/helpers/legacy-embedding-preload.ts)
 * snapshots process.env. A resetGateway() inside a withEnv scope that sets a
 * provider key used to leave that key in the gateway after the scope ended, so
 * every later test file in the same bun process saw chat as available. In CI
 * that let test/pathological/g5-single-page-generations.test.ts turn on the
 * Gmail loops catch-up in test/google-gmail-recent-first.test.ts.
 */
import { expect, test } from 'bun:test';
import { isAvailable, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

test('a reset inside a scoped provider key uses that key', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-scoped-probe' }, async () => {
    resetGateway();
    expect(isAvailable('chat')).toBe(true);
  });
});

test('the next test does not inherit the key the scoped reset snapshotted', () => {
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(isAvailable('chat')).toBe(false);
});
