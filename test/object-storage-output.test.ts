/** Protect nested storage credentials in get/show and backend references in
 * upload-raw. Existing scalar-secret tests miss object values and camelCase;
 * existing uploads omit backend labels. No new production seam is needed. */
import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { runFiles } from '../src/commands/files.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

test('nested storage secrets are hidden in get/show, with raw opt-out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'storage-output-'));
  const storage = {
    backend: 's3', bucket: 'brain-files', accessKeyId: 'credential-id',
    secretAccessKey: 'credential-secret', serviceRoleKey: 'role-secret',
    nested: [{ token: 'nested-secret', label: 'public-label' }],
  };
  mkdirSync(join(home, '.gbrain'));
  const configPath = join(home, '.gbrain', 'config.json');
  const original = JSON.stringify({ engine: 'pglite', storage });
  writeFileSync(configPath, original);
  const engine = { getConfig: async () => null } as unknown as BrainEngine;
  const logs: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const args of [['get', 'storage'], ['show'], ['get', 'storage.secretAccessKey']]) {
        logs.length = 0;
        await runConfig(engine, args);
        const output = [...logs, ...errors].join('\n');
        for (const secret of ['credential-id', 'credential-secret', 'role-secret', 'nested-secret']) {
          expect(output).not.toContain(secret);
        }
        expect(output).toContain('***');
        if (args[1] === 'storage' || args[0] === 'show') {
          expect(output).toContain('brain-files');
          expect(output).toContain('public-label');
        }
      }
      logs.length = 0;
      await runConfig(engine, ['get', 'storage', '--raw']);
      expect(JSON.parse(logs[0]!)).toEqual(storage);
    });
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  } finally {
    log.mockRestore(); error.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('upload-raw reports the selected backend in JSON and the pointer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'storage-upload-'));
  mkdirSync(join(home, '.gbrain'));
  const localPath = join(home, 'objects');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite', storage: { backend: 'local', bucket: 'brain-files', localPath },
  }));
  const input = join(home, 'sample.png');
  writeFileSync(input, 'synthetic-media');
  const engine = { executeRaw: async () => [] } as unknown as BrainEngine;
  const logs: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await withEnv({ GBRAIN_HOME: home }, () => runFiles(engine, ['upload-raw', input, '--page', 'assets/sample']));
    const output = JSON.parse(logs[0]!);
    expect(output.storage).toBe('local');
    expect(output.reference).toBe('local://brain-files/assets/sample/sample.png');
    expect(readFileSync(input + '.redirect.yaml', 'utf8')).toContain(output.reference);
    expect(readFileSync(join(localPath, 'assets/sample/sample.png'), 'utf8')).toBe('synthetic-media');
  } finally {
    log.mockRestore(); error.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});
