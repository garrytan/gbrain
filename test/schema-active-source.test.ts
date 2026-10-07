/**
 * #6090: `schema active --source <id>` resolves the pack the way the engine
 * does for that source (tier-3 `schema_pack.source.<id>`), refuses an unknown
 * source with `unknown_source`, and never presents a config.json-only answer
 * as complete when the database can't be read. Successes run in-process;
 * refusals run the real CLI (their envelope is written to fd 1 directly).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSchema } from '../src/commands/schema.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;
let brokenHome: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-active-source-'));
  const brain = join(home, '.gbrain');
  mkdirSync(brain, { recursive: true });
  const databasePath = join(brain, 'brain.pglite');
  writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath }));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    await engine.initSchema();
    await engine.setConfig('schema_pack.source.default', 'gbrain-base-v2');
  } finally {
    await engine.disconnect();
  }

  brokenHome = mkdtempSync(join(tmpdir(), 'gbrain-schema-active-broken-'));
  mkdirSync(join(brokenHome, '.gbrain'), { recursive: true });
  const notADirectory = join(brokenHome, 'not-a-database');
  writeFileSync(notADirectory, 'plain file, not a PGLite data directory');
  writeFileSync(join(brokenHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: notADirectory }));
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(brokenHome, { recursive: true, force: true });
});

async function run(args: string[], gbrainHome = home): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
  const stderrWrite = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as never);
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code ?? 0; throw new Error('__exit__'); }) as never);
  try {
    await withEnv({ GBRAIN_HOME: gbrainHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SCHEMA_PACK: undefined },
      () => runSchema(['active', ...args]));
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    log.mockRestore(); error.mockRestore(); stdoutWrite.mockRestore(); stderrWrite.mockRestore(); exit.mockRestore();
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

describe('#6090 schema active --source', () => {
  test('text mode honors the per-source pack and names what it resolved', async () => {
    const r = await run(['--source', 'default']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Active pack: gbrain-base-v2');
    expect(r.stdout).toContain('Resolved for source default: per-source-db');
  }, 60_000);

  test('--json reports the per-source override', async () => {
    const r = await run(['--source', 'default', '--json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      schema_version: 1, pack: 'gbrain-base-v2', resolved_from: 'per-source-db', source_id: 'default', database: 'read',
    });
  }, 60_000);

  test('without --source the brain-wide resolution stands', async () => {
    const r = await run(['--json']);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.resolved_from).not.toBe('per-source-db');
    expect(doc.source_id).toBeNull();
  }, 60_000);

  test('an unknown source is refused with unknown_source and a sources list fix', async () => {
    const r = await runCli(['schema', 'active', '--source', 'no-such-source', '--json'], { home, cwd: home, env: { GBRAIN_SCHEMA_PACK: undefined }, timeoutMs: 60_000 });
    expect(r.exitCode).not.toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.code).toBe('unknown_source');
    expect(doc.fix.argv.slice(0, 4)).toEqual(['gbrain', 'sources', 'list', '--json']);
  }, 60_000);

  test('an unreadable database is a degraded read: --json exits nonzero, text mode marks it', async () => {
    const json = await runCli(['schema', 'active', '--json'], { home: brokenHome, cwd: brokenHome, env: { GBRAIN_SCHEMA_PACK: undefined }, timeoutMs: 60_000 });
    expect(json.exitCode).not.toBe(0);
    const doc = JSON.parse(json.stdout);
    expect(doc).toMatchObject({ code: 'database_error', degraded: true, database: 'unreadable' });
    expect(typeof doc.pack).toBe('string');
    expect(doc.fix.argv.slice(0, 3)).toEqual(['gbrain', 'doctor', '--json']);

    const text = await run([], brokenHome);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toContain('database unreadable');
  }, 60_000);
});
