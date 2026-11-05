/** Real CLI processes against an isolated persistent PGLite, never the operator's brain. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';

let home: string, file: string, config: string, originalConfig: string;
let engine: PGLiteEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-hold-cli-'));
  const database = join(home, 'brain.pglite');
  file = join(home, 'hold-value'); config = join(home, '.gbrain', 'config.json');
  mkdirSync(join(home, '.gbrain'));
  originalConfig = JSON.stringify({ engine: 'pglite', database_path: database, embedding_dimensions: 1536,
    embedding_disabled: true, sources: { refresh_hold: 'false' } });
  writeFileSync(config, originalConfig);
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: database }); await engine.initSchema(); await engine.disconnect();
}, 120_000);
afterAll(async () => { await engine?.disconnect(); if (home) rmSync(home, { recursive: true, force: true }); });

test('refresh hold CLI reads only DB presence and losslessly restores empty, dash and special strings', async () => {
  const call = async (...args: string[]) => {
    const result = await runCli(['sources', 'refresh-hold', ...args, '--json'], { home });
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect(await call('get')).toEqual({ key: 'sources.refresh_hold', present: false, value: null });
  for (const value of ['', '-x', '\ufeff -quotes " $ & \\ 中文\n\n']) {
    writeFileSync(file, Buffer.from(value));
    expect(await call('set', '--file', file)).toEqual({ key: 'sources.refresh_hold', present: true, value });
    expect(await call('get')).toEqual({ key: 'sources.refresh_hold', present: true, value });
    // Separate processes re-read actual durable state; restore never relies on a cached echo.
    const saved = await call('get');
    writeFileSync(file, 'true'); await call('set', '--file', file);
    writeFileSync(file, Buffer.from(saved.value)); await call('set', '--file', file);
    expect(await call('get')).toEqual(saved);
  }
  expect(await call('clear')).toEqual({ key: 'sources.refresh_hold', present: false, value: null });
  expect(await call('get')).toEqual({ key: 'sources.refresh_hold', present: false, value: null });
  expect(readFileSync(config, 'utf8')).toBe(originalConfig);
}, 180_000);
