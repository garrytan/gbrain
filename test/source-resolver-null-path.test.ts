/**
 * A source with no local path (a database-only source, such as the conversation archive's) never answers a path lookup:
 * every resolver that maps a directory to a source skips it, whether its path is NULL or an empty string, on both
 * engines, so a checkout, its subfolders, an unregistered folder and / never resolve to it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resolveRegisteredLocalPathSource, resolveSourceForRepoPath, resolveSourceId, resolveSourceWithTier } from '../src/core/source-resolver.ts';

const work = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-null-path-')));
const checkout = join(work, 'source-a');
const outside = join(work, 'elsewhere');
const engines: Array<{ name: string; engine: BrainEngine }> = [];
let closePg: (() => Promise<void>) | undefined;

beforeAll(async () => {
  mkdirSync(join(checkout, 'notes'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  engines.push({ name: 'pglite', engine: pglite });
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push({ name: 'postgres', engine: pg.engine });
    closePg = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const { name, engine } of engines) if (name === 'pglite') await engine.disconnect();
  await closePg?.();
  rmSync(work, { recursive: true, force: true });
});

async function register(engine: BrainEngine, id: string, localPath: string | null): Promise<void> {
  await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path', [id, localPath]);
}

describe('a source with no local path never answers a path lookup', () => {
  for (const dbOnlyPath of [null, '']) {
    test(`local_path ${dbOnlyPath === null ? 'NULL' : "''"}: the checkout resolves to its own source, nothing resolves to the database-only one`, async () => {
      for (const { name, engine } of engines) {
        await register(engine, 'source-a', checkout);
        await register(engine, 'conversations', dbOnlyPath);
        for (const cwd of [checkout, join(checkout, 'notes')]) {
          expect({ name, cwd, id: await resolveSourceId(engine, null, cwd) }).toEqual({ name, cwd, id: 'source-a' });
          expect({ name, cwd, tier: (await resolveSourceWithTier(engine, null, cwd)).tier }).toEqual({ name, cwd, tier: 'local_path' });
          expect({ name, cwd, id: await resolveRegisteredLocalPathSource(engine, cwd) }).toEqual({ name, cwd, id: 'source-a' });
          expect({ name, cwd, id: (await resolveSourceForRepoPath(engine, cwd))?.source_id }).toEqual({ name, cwd, id: 'source-a' });
        }
        for (const cwd of [outside, work, '/']) {
          expect({ name, cwd, id: await resolveSourceId(engine, null, cwd) }).not.toEqual({ name, cwd, id: 'conversations' });
          expect({ name, cwd, id: await resolveRegisteredLocalPathSource(engine, cwd) }).toEqual({ name, cwd, id: null });
          expect({ name, cwd, hit: await resolveSourceForRepoPath(engine, cwd) }).toEqual({ name, cwd, hit: null });
        }
        await engine.executeRaw("DELETE FROM sources WHERE id IN ('source-a', 'conversations')");
      }
    });
  }
});
