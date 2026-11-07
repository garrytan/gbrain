/**
 * `storage.publicEndpoint` and the other object-storage leaves are read from
 * the file-plane `storage` object. `gbrain config set` writes that object.
 * `storage.git_lfs` is a different key and is not one of these leaves.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runConfig } from '../src/commands/config.ts';
import { loadConfig } from '../src/core/config.ts';
import { isObjectStorageConfigKey } from '../src/commands/config/object-storage.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function stubEngine(): { engine: BrainEngine; setCalls: Array<[string, string]> } {
  const setCalls: Array<[string, string]> = [];
  const engine = {
    getConfig: async () => null,
    setConfig: async (key: string, value: string) => { setCalls.push([key, value]); },
    unsetConfig: async () => 0,
  } as unknown as BrainEngine;
  return { engine, setCalls };
}

async function runConfigCapture(
  engine: BrainEngine,
  args: string[],
): Promise<{ logs: string[]; errs: string[]; exit: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
  try {
    await runConfig(engine, args);
  } catch (e) {
    if (!(e as Error).message.startsWith('EXIT:')) throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exit };
}

describe('object-storage file-plane config', () => {
  test('set publicEndpoint and signedUrlExpiresIn land on the storage object; secrets are redacted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-object-storage-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      storage: { backend: 's3', endpoint: 'http://127.0.0.1:9000', bucket: 'brain-files' },
    }));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined }, async () => {
        const { engine, setCalls } = stubEngine();
        const set = await runConfigCapture(engine, ['set', 'storage.publicEndpoint', 'https://files.example.ts.net/']);
        expect(set.exit).toBeNull();
        expect(setCalls).toEqual([]);
        expect(set.logs.join('\n')).toContain('https://files.example.ts.net');
        expect(set.logs.join('\n')).toContain('file plane');

        const ttl = await runConfigCapture(engine, ['set', 'storage.signedUrlExpiresIn', '120']);
        expect(ttl.exit).toBeNull();
        const secret = await runConfigCapture(engine, ['set', 'storage.secretAccessKey', 'test-secret-not-in-the-log']);
        expect(secret.exit).toBeNull();
        expect(secret.logs.join('\n')).toContain('***');
        expect(secret.logs.join('\n')).not.toContain('test-secret-not-in-the-log');

        const storage = loadConfig()?.storage as Record<string, unknown>;
        expect(storage).toEqual({
          backend: 's3',
          endpoint: 'http://127.0.0.1:9000',
          bucket: 'brain-files',
          publicEndpoint: 'https://files.example.ts.net',
          signedUrlExpiresIn: 120,
          secretAccessKey: 'test-secret-not-in-the-log',
        });

        const bad = await runConfigCapture(engine, ['set', 'storage.publicEndpoint', 'http://user:pw@files.example']);
        expect(bad.exit).toBe(1);
        expect((loadConfig()?.storage as { publicEndpoint: string }).publicEndpoint).toBe('https://files.example.ts.net');

        const unset = await runConfigCapture(engine, ['unset', 'storage.publicEndpoint']);
        expect(unset.exit).toBeNull();
        expect((loadConfig()?.storage as Record<string, unknown>).publicEndpoint).toBeUndefined();
        expect((loadConfig()?.storage as { bucket: string }).bucket).toBe('brain-files');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('storage.git_lfs is not an object-storage leaf', () => {
    expect(isObjectStorageConfigKey('storage.publicEndpoint')).toBe(true);
    expect(isObjectStorageConfigKey('storage.git_lfs')).toBe(false);
    expect(isObjectStorageConfigKey('storage.not_a_field')).toBe(false);
  });
});
