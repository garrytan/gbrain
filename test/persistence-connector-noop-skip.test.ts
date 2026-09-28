import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, contact, sourceCheckpoint } from './helpers/connector-fixture.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const importReceipts = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_connector_import'", [sourceId]))[0].n;

// bp-ry3r.1: every sweep re-lands the same contacts under a new checkpointBefore,
// which is exactly what a Gmail backfill, gap walk or re-anchor does to threads.
test('an unchanged connector rewalk admits no import receipt while changed content still publishes', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [false, true]) {
    const f = bound ? await boundSource(engine, googleConfig) : await source(engine, googleConfig);
    let organization = 'Initial organization';
    const fetcher = async (url: string) => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      return json({ connections: ['first', 'second', 'third'].map(id => ({ ...contact(id, `${id} Example`), organizations: [{ name: id === 'first' ? organization : 'Stable' }] })),
        nextSyncToken: 'contacts-rewalk' });
    };
    const run = () => runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, fetcher);

    expect((await run()).added).toBe(3);
    expect(await importReceipts(engine, f.id)).toBe(3);
    await disposePersistenceConsumer(engine);

    const before = await sourceCheckpoint(engine, f.id);
    const file = bound ? readFileSync(join(f.dir, 'people/first-example.md'), 'utf8') : null;
    const rewalk = await run();
    expect(rewalk.status).not.toBe('partial');
    expect(rewalk.modified).toBe(0);
    // The cursor still advances (one checkpoint receipt) but no page receipt is minted.
    expect(await sourceCheckpoint(engine, f.id)).not.toEqual(before);
    expect(await importReceipts(engine, f.id)).toBe(3);
    if (file !== null) expect(readFileSync(join(f.dir, 'people/first-example.md'), 'utf8')).toBe(file);
    await disposePersistenceConsumer(engine);

    organization = 'Changed organization';
    expect((await run()).modified).toBe(1);
    expect(await importReceipts(engine, f.id)).toBe(4);
    expect((await engine.getPage('people/first-example', { sourceId: f.id }))?.compiled_truth).toContain('Changed organization');
    if (bound) expect(readFileSync(join(f.dir, 'people/first-example.md'), 'utf8')).toContain('Changed organization');
    await disposePersistenceConsumer(engine);
  }
}), 180_000);
