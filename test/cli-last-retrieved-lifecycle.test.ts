/**
 * Regression: short-lived read commands must print their result and then exit.
 *
 * `get`/`search` start a best-effort last_retrieved_at write-back after the
 * visible result is known. The CLI must drain that already-started write before
 * disconnecting PGLite; otherwise wrappers that wait for process exit hang.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

let tmpHome: string;
let dbPath: string;

function runCli(args: string[]) {
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 3000,
    env: {
      ...process.env,
      GBRAIN_HOME: tmpHome,
      GBRAIN_NO_BANNER: '1',
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cli-lifecycle-'));
  const configDir = join(tmpHome, '.gbrain');
  mkdirSync(configDir, { recursive: true });
  dbPath = join(configDir, 'brain.pglite');
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbPath }, null, 2),
  );

  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbPath });
  await engine.initSchema();
  await importFromContent(
    engine,
    '20-wiki/brain-operating-contract',
    '---\ntype: wiki\ntitle: Brain Operating Contract\n---\n# Brain Operating Contract\n\nbrain operating contract lifecycle fixture.\n',
    { noEmbed: true, sourceId: 'default' },
  );
  await engine.disconnect();
});

afterAll(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe('CLI last_retrieved_at lifecycle', () => {
  test('search emits output and exits cleanly', () => {
    const result = runCli(['search', 'brain operating contract', '--source', 'default', '--limit', '1']);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('20-wiki/brain-operating-contract');
  });

  test('get emits output and exits cleanly', () => {
    const result = runCli(['get', '20-wiki/brain-operating-contract', '--source', 'default']);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Brain Operating Contract');
  });
});
