/**
 * Protect get/show scrollback from nested storage credentials. Regresses when
 * objects bypass redaction or camelCase keys evade matching. Existing object
 * display coverage checks only a sensitive parent. No new production seam.
 */
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig, redactConfigValue } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

test('config get/show redact nested credentials while raw preserves stored values', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'config-nested-'));
  const storage = {
    backend: 's3', bucket: 'example-bucket', forcePathStyle: true,
    accessKeyId: 'example-access', secretAccessKey: 'example-secret',
    profiles: [{ sessionToken: 'example-session', label: 'primary' }],
    nested: { api_key: 'example-api', retries: 3, enabled: false, optional: null },
  };
  const safe = {
    ...storage, accessKeyId: '***', secretAccessKey: '***',
    profiles: [{ sessionToken: '***', label: 'primary' }],
    nested: { ...storage.nested, api_key: '***' },
  };
  const engine = { getConfig: async () => null } as unknown as BrainEngine;
  try {
    mkdirSync(join(scratch, '.gbrain'));
    const configPath = join(scratch, '.gbrain', 'config.json');
    const original = JSON.stringify({ engine: 'pglite', storage });
    writeFileSync(configPath, original);
    await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined }, async () => {
      const lines: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
      const err = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await runConfig(engine, ['get', 'storage']);
        expect(JSON.parse(lines.pop()!)).toEqual(safe);
        await runConfig(engine, ['show']);
        const shown = lines.find(line => line.startsWith('  storage: '));
        expect(shown).toBeDefined();
        expect(JSON.parse(shown!.slice('  storage: '.length))).toEqual(safe);
        lines.length = 0;
        await runConfig(engine, ['get', 'storage.secretAccessKey']);
        expect(lines.pop()).toBe('***');
        await runConfig(engine, ['get', 'storage', '--raw']);
        expect(JSON.parse(lines.pop()!)).toEqual(storage);
        expect(redactConfigValue('storage', JSON.stringify(storage))).toBe(JSON.stringify(safe));
        expect(redactConfigValue('monkey', 'ordinary')).toBe('ordinary');
        expect(readFileSync(configPath, 'utf8')).toBe(original);
      } finally {
        log.mockRestore();
        err.mockRestore();
      }
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
