import { describe, expect, test } from 'bun:test';
import { privateContextIpcEnabled } from '../src/core/context/private-context-ipc-policy.ts';
import { withEnv } from './helpers/with-env.ts';

describe('private context IPC deployment policy', () => {
  test('defaults off and requires an exact file-plane true', async () => {
    await withEnv({ GBRAIN_PRIVATE_CONTEXT_IPC: undefined }, () => {
      expect(privateContextIpcEnabled(null)).toBe(false);
      expect(privateContextIpcEnabled({})).toBe(false);
      expect(privateContextIpcEnabled({ private_context_ipc: 'true' })).toBe(false);
      expect(privateContextIpcEnabled({ private_context_ipc: true })).toBe(true);
    });
  });

  test('environment is the operator override with common explicit values', async () => {
    for (const value of ['true', '1', 'ON', 'yes']) {
      await withEnv({ GBRAIN_PRIVATE_CONTEXT_IPC: value }, () => {
        expect(privateContextIpcEnabled({ private_context_ipc: false })).toBe(true);
      });
    }
    for (const value of ['false', '0', 'off', 'no', 'garbage']) {
      await withEnv({ GBRAIN_PRIVATE_CONTEXT_IPC: value }, () => {
        expect(privateContextIpcEnabled({ private_context_ipc: true })).toBe(false);
      });
    }
  });
});
