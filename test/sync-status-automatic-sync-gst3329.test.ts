/**
 * GST-3329: a source excluded from automatic sync (`config.syncEnabled=false`, set by `gbrain sources set-sync <id> off`)
 * is skipped by autopilot's per-source cycle, the freshness loop and `gbrain sync --all` without a log line, so its status
 * read as converged or resumable with nothing saying that only an explicit sync runs it. `gbrain sync status` now names it
 * in `automatic_sync`, with the read-only preview that turns it back on. Red on master: there is no `automatic_sync` field.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-auto-sync-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

const each = (run: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) await run(engine); });

async function source(engine: BrainEngine, config: Record<string, unknown>): Promise<string> {
  const id = `source-a-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)', [id, join(home, id), JSON.stringify(config)]);
  return id;
}

test('sync status names a source excluded from automatic sync and the preview that turns it back on', () => each(async engine => {
  const id = await source(engine, { syncEnabled: false });
  const status = await readSyncStatus(engine, id, { detail: false });
  expect(status.automatic_sync.enabled).toBe(false);
  expect(status.automatic_sync.fix?.argv).toEqual(['gbrain', 'sources', 'set-sync', id, 'on', '--dry-run']);
  expect(status.automatic_sync.fix?.actor).toBe('user');
  expect(status.automatic_sync.why).toContain('config.syncEnabled is false');
}), 60_000);

test('a source with automatic sync on (unset or true) reads enabled with no fix', () => each(async engine => {
  for (const config of [{}, { syncEnabled: true }]) {
    const status = await readSyncStatus(engine, await source(engine, config), { detail: false });
    expect(status.automatic_sync).toEqual({ enabled: true });
  }
}), 60_000);
