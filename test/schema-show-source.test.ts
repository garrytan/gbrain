/** #8899: `schema show --source <id>` resolves that source's pack instead of reading the id as a pack name. */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSchema } from '../src/commands/schema.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-show-source-'));
  const brain = join(home, '.gbrain');
  mkdirSync(brain, { recursive: true });
  const databasePath = join(brain, 'brain.pglite');
  writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath }));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    await engine.initSchema();
    await engine.setConfig('schema_pack.source.notes-src', 'gbrain-base-v2');
  } finally {
    await engine.disconnect();
  }
}, 60_000);

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

test('schema show --source prints the source-resolved manifest', async () => {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code ?? 0; throw new Error('__exit__'); }) as never);
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SCHEMA_PACK: undefined },
      () => runSchema(['show', '--source', 'notes-src', '--json']));
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    log.mockRestore(); error.mockRestore(); exit.mockRestore();
  }
  expect(err.join('\n')).not.toContain('Unknown pack');
  expect(exitCode).toBeUndefined();
  expect(JSON.parse(out.join('\n') || '{}').name).toBe('gbrain-base-v2');
}, 60_000);
