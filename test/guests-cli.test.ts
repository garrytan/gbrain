/**
 * gbrain guests init and gbrain sources writers (GBRA-504 slice 1).
 *
 * Protects: init previews by default and writes nothing; --yes creates the
 * guest source database-only, federated and marked guest with its ceiling, and
 * its guest_sources row with the writer list, in one go; init refuses a source
 * that has a local_path and a malformed writer; sources writers lists, adds,
 * removes and clears writers and refuses a source that is not a guest source;
 * set-path refuses a guest source. PGLite, no repository, no embedding key.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runGuests } from '../src/commands/guests.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
let origExit: typeof process.exit;
let exitCode: number | null;
let out: string[];
let err: string[];
let spies: Array<{ mockRestore: () => void }> = [];
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  exitCode = null; out = []; err = [];
  origExit = process.exit;
  (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
    exitCode = n;
    throw new Error(`__test_exit_${n}__`);
  }) as never;
  spies = [
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); }),
    spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); }),
  ];
});

afterEach(() => {
  process.exit = origExit;
  for (const spy of spies) spy.mockRestore();
});

const run = (fn: () => Promise<void>) => fn().catch((e: Error) => { if (!/^__test_exit_/.test(e.message)) throw e; });
const sourceRow = async (id: string) => (await engine.executeRaw<{ local_path: string | null; config: unknown }>(
  'SELECT local_path, config FROM sources WHERE id=$1', [id]))[0];
const guestRow = async (id: string) => (await engine.executeRaw<{ writers: string[]; trust_ceiling: string }>(
  'SELECT writers, trust_ceiling FROM guest_sources WHERE source_id=$1', [id]))[0];
const configOf = (config: unknown) => (typeof config === 'string' ? JSON.parse(config) : config) as Record<string, unknown>;

describe('gbrain guests init', () => {
  test('refuses an existing source that already holds pages, in the preview and with --yes', async () => {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', ['source-a']);
    await engine.putPage('notes/owner-a', { title: 'Owner', type: 'note' as never, compiled_truth: 'Mine.', frontmatter: {}, timeline: '' }, { sourceId: 'source-a' } as never);
    for (const args of [['init', '--source', 'source-a'], ['init', '--source', 'source-a', '--yes']]) {
      exitCode = null; err = [];
      await run(() => runGuests(engine, args));
      expect({ args, exitCode: exitCode as number | null, said: err.join('\n').includes('already holds 1 page') }).toEqual({ args, exitCode: 2, said: true });
    }
    expect(await guestRow('source-a')).toBeUndefined();
    expect(configOf((await sourceRow('source-a'))!.config).guest).toBeUndefined();
  });

  test('previews by default and writes nothing', async () => {
    await run(() => runGuests(engine, ['init', '--writer', 'oauth_client:client-a']));
    expect(exitCode).toBeNull();
    expect(out.join('\n')).toContain('guests');
    expect(out.join('\n')).toContain('--yes');
    expect(await sourceRow('guests')).toBeUndefined();
    expect(await engine.executeRaw('SELECT 1 FROM guest_sources')).toEqual([]);
  });

  test('--yes creates a database-only, federated guest source and its writer list', async () => {
    await run(() => runGuests(engine, ['init', '--writer', 'oauth_client:client-a', '--writer', 'legacy_token:token-a', '--yes']));
    expect(exitCode).toBeNull();
    const source = await sourceRow('guests');
    expect(source?.local_path).toBeNull();
    expect(configOf(source?.config)).toMatchObject({ federated: true, guest: true, trust_ceiling: 'external_untrusted' });
    expect(await guestRow('guests')).toEqual({ writers: ['legacy_token:token-a', 'oauth_client:client-a'], trust_ceiling: 'external_untrusted' });
  });

  test('--source names the source, and a second run adds writers', async () => {
    await run(() => runGuests(engine, ['init', '--source', 'source-a', '--writer', 'oauth_client:client-a', '--yes']));
    await run(() => runGuests(engine, ['init', '--source', 'source-a', '--writer', 'oauth_client:client-b', '--yes']));
    expect(exitCode).toBeNull();
    expect((await guestRow('source-a'))?.writers).toEqual(['oauth_client:client-a', 'oauth_client:client-b']);
  });

  test('refuses a source that has a local_path', async () => {
    await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES('source-a','source-a','/tmp/source-a')`);
    await run(() => runGuests(engine, ['init', '--source', 'source-a', '--yes']));
    expect(exitCode).toBe(2);
    expect(err.join('\n')).toContain('database-only');
    expect(await guestRow('source-a')).toBeUndefined();
  });

  test('refuses a malformed writer', async () => {
    await run(() => runGuests(engine, ['init', '--writer', 'client-a', '--yes']));
    expect(exitCode).toBe(2);
    expect(await sourceRow('guests')).toBeUndefined();
  });
});

describe('gbrain sources writers', () => {
  test('lists, adds, removes and clears the writers of a guest source', async () => {
    await run(() => runGuests(engine, ['init', '--writer', 'oauth_client:client-a', '--yes']));
    await run(() => runSources(engine, ['writers', 'guests', '--add', 'oauth_client:client-b']));
    expect((await guestRow('guests'))?.writers).toEqual(['oauth_client:client-a', 'oauth_client:client-b']);
    await run(() => runSources(engine, ['writers', 'guests', '--remove', 'oauth_client:client-a']));
    expect((await guestRow('guests'))?.writers).toEqual(['oauth_client:client-b']);
    out = [];
    await run(() => runSources(engine, ['writers', 'guests', '--json']));
    expect(JSON.parse(out.join('\n'))).toEqual({ source: 'guests', writers: ['oauth_client:client-b'], trust_ceiling: 'external_untrusted' });
    await run(() => runSources(engine, ['writers', 'guests', '--clear']));
    expect((await guestRow('guests'))?.writers).toEqual([]);
    expect(exitCode).toBeNull();
  });

  test('refuses a source that is not a guest source, and an unknown one', async () => {
    await run(() => runSources(engine, ['writers', 'default', '--add', 'oauth_client:client-a']));
    expect(exitCode).toBe(2);
    expect(await engine.executeRaw('SELECT 1 FROM guest_sources')).toEqual([]);
    exitCode = null;
    await run(() => runSources(engine, ['writers', 'source-missing']));
    expect(exitCode as number | null).toBe(4);
  });

  test('set-path refuses a guest source', async () => {
    await run(() => runGuests(engine, ['init', '--yes']));
    const dir = mkdtempSync(join(tmpdir(), 'gb-guests-'));
    tmpDirs.push(dir);
    await run(() => runSources(engine, ['set-path', 'guests', dir]));
    expect(exitCode).toBe(2);
    expect(err.join('\n')).toContain('database-only');
    expect((await sourceRow('guests'))?.local_path).toBeNull();
  });
});
