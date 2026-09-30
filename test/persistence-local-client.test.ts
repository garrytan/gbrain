import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistenceConfigForBrain, readPersistenceCliRegistration, maybeDelegateLocalOperation } from '../src/core/persistence/local-client.ts';
import { resolveSourceId } from '../src/core/source-resolver.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const BRAIN = '10000000-0000-4000-8000-000000000001';
const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'gb-local-write-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

describe('engine-free local persistence routing', () => {
  test('mounted brains select their own database, including aliases', () => {
    const host = { engine: 'pglite' as const, database_path: '/host/db' };
    const mounts = [{ id: 'example-brain', alias: 'example', engine: 'pglite' as const, path: '/mount', database_path: '/mount/db' }];
    expect(persistenceConfigForBrain(host, 'host', mounts)).toBe(host);
    expect(persistenceConfigForBrain(host, 'example', mounts)?.database_path).toBe('/mount/db');
    expect(() => persistenceConfigForBrain(host, 'absent', mounts)).toThrow('not an enabled mount');
    expect(() => persistenceConfigForBrain(host, 'example-brain', [{ ...mounts[0], enabled: false }])).toThrow('not an enabled mount');
  });

  test('missing registration never allocates a replacement principal', async () => {
    const dir = temp();
    await withEnv({ GBRAIN_HOME: dir }, () => {
      expect(() => readPersistenceCliRegistration(BRAIN)).toThrow('no readable durable writer registration');
      expect(() => readFileSync(join(dir, '.gbrain', 'persistence', `${BRAIN}.cli.json`))).toThrow();
      expect(() => readPersistenceCliRegistration('../other')).toThrow('UUID');
    });
  });

  test('reads only the exact brain CLI credential and refuses a stdio registration', async () => {
    const dir = temp();
    const folder = join(dir, '.gbrain', 'persistence');
    mkdirSync(folder, { recursive: true });
    const registration = { id: BRAIN, credential: 'a'.repeat(64), lane: 'cli' as const };
    const path = join(folder, `${BRAIN}.cli.json`);
    writeFileSync(path, JSON.stringify(registration), { mode: 0o600 });
    await withEnv({ GBRAIN_HOME: dir }, () => {
      expect(readPersistenceCliRegistration(BRAIN)).toEqual(registration);
      writeFileSync(path, JSON.stringify({ ...registration, lane: 'stdio' }));
      expect(() => readPersistenceCliRegistration(BRAIN)).toThrow('invalid');
    });
  });

  test('local and delegated paths retain a client ID before any engine opens', async () => {
    const params: Record<string, unknown> = { slug: 'test/page', content: 'body' };
    const dir = temp();
    const config = { engine: 'pglite' as const, database_path: join(dir, 'db') };
    const first = await maybeDelegateLocalOperation('put_page', params, config, { brain: 'host', cwd: dir });
    expect(first).toEqual({ handled: false });
    const originalId = params.request_id;
    expect(originalId).toMatch(/^[a-f0-9-]{36}$/);
    await maybeDelegateLocalOperation('put_page', params, config, { brain: 'host', cwd: dir });
    expect(params.request_id).toBe(originalId);
  });

  test('owner source environment and dotfiles cannot redirect a client with no local signal', async () => {
    const dir = temp();
    writeFileSync(join(dir, '.gbrain-source'), 'owner-source');
    const engine = {
      executeRaw: async (sql: string, params?: unknown[]) => {
        if (sql.includes('WHERE id = $1')) return [{ id: params?.[0] }];
        if (sql.includes('local_path')) return [{ id: 'client-path-source', local_path: dir, archived: false }];
        return [];
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_SOURCE: 'owner-source' }, async () => {
      expect(await resolveSourceId(engine, null, dir, { skipLocalSignals: true })).toBe('client-path-source');
      expect(await resolveSourceId(engine, 'client-selected', dir, { skipLocalSignals: true })).toBe('client-selected');
      expect(await resolveSourceId(engine, null, dir)).toBe('owner-source');
    });
  });
});
