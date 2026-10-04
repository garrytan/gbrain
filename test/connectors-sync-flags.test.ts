import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runConnectorSyncCmd } from '../src/commands/connectors/sync.ts';
import { withEnv } from './helpers/with-env.ts';

// Absorbed in agent contract v1 D4 (#5930): the rejection is an invalid_params usage error (exit 2 via renderCliError).
// Contract: connector sync numeric flags reject malformed or unsafe values and retain valid values.
// Regression: Number() previously accepted decimals, zero for --limit, and unsafe integers.
// Existing coverage exercises core sync behavior but not CLI flag parsing.
// This uses the public command entry point and needs no production-only test seam.
const stubEngine = { getConfig: async () => null } as unknown as BrainEngine;

async function runWithoutCredentials(args: string[]): Promise<void> {
  const testHome = mkdtempSync(join(tmpdir(), 'gbrain-connectors-sync-flags-'));
  return withEnv({
    GBRAIN_HOME: testHome,
    GBRAIN_CONNECTOR_CHATGPT_COOKIE: undefined,
    GBRAIN_CONNECTOR_CHATGPT_TOKEN: undefined,
  }, async () => {
    try {
      await runConnectorSyncCmd(stubEngine, args);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
}

async function expectInvalidParams(args: string[], flag: string): Promise<void> {
  const result = runConnectorSyncCmd(stubEngine, args);
  await expect(result).rejects.toBeInstanceOf(OperationError);
  await expect(result).rejects.toMatchObject({
    code: 'invalid_params',
    message: expect.stringContaining(flag),
  });
}

describe('connector sync flags', () => {
  test('--limit requires a positive safe integer', async () => {
    for (const args of [
      ['chatgpt', '--limit', 'nope'],
      ['chatgpt', '--limit', '1.5'],
      ['chatgpt', '--limit', '0'],
      ['chatgpt', '--limit', '9007199254740992'],
      ['chatgpt', '--limit'],
    ]) {
      await expectInvalidParams(args, '--limit');
    }
  });

  test('--limit accepts a positive safe integer', async () => {
    await expect(runWithoutCredentials(['chatgpt', '--limit', '3'])).resolves.toBeUndefined();
  });

  test('--window-days requires a non-negative safe integer', async () => {
    for (const args of [
      ['chatgpt', '--window-days', 'nope'],
      ['chatgpt', '--window-days', '1.5'],
      ['chatgpt', '--window-days', '-1'],
      ['chatgpt', '--window-days', '9007199254740992'],
      ['chatgpt', '--window-days'],
    ]) {
      await expectInvalidParams(args, '--window-days');
    }
  });

  test('--window-days accepts zero and positive safe integers', async () => {
    // No credential in the isolated home makes the command stop normally after parsing.
    for (const days of ['0', '3']) {
      await expect(runWithoutCredentials(['chatgpt', '--window-days', days])).resolves.toBeUndefined();
    }
  });
});
