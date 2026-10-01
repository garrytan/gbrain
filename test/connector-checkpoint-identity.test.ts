import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, contact } from './helpers/connector-fixture.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

async function mark(engine: BrainEngine, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ seq: string | null }>('SELECT max(sequence)::text AS seq FROM persistence_requests WHERE source_id=$1', [sourceId]);
  return row?.seq ?? '0';
}

/** Page and checkpoint admissions since `after`, classified across both intent namespaces. */
async function admissions(engine: BrainEngine, sourceId: string, after: string) {
  const rows = await engine.executeRaw<{ kind: string }>('SELECT intent->>\'kind\' AS kind FROM persistence_requests WHERE source_id=$1 AND sequence>$2::bigint', [sourceId, after]);
  return { pages: rows.filter(r => /_(import|delete)$/.test(r.kind)).length, checkpoints: rows.filter(r => r.kind.endsWith('_checkpoint')).length };
}

async function stamp(engine: BrainEngine, sourceId: string): Promise<void> {
  const now = new Date().toISOString();
  expect(await engine.updateSourceConfig(sourceId, { last_source_cycle_at: now, last_full_cycle_at: now })).toBe(true);
}

/** A People fixture: `rotate` changes the sync token every sweep; `rewalk` ignores the token and lists everything. */
function peopleFetcher(opts: { rotate?: boolean; rewalk?: boolean; onList?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  let sweep = 0;
  const fetcher = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/people/me')) return json({ resourceName: 'people/me', emailAddresses: [{ value: googleConfig.g_account, metadata: { primary: true } }] });
    if (u.pathname.endsWith('/people/me/connections')) {
      await opts.onList?.();
      const token = opts.rotate ? `contacts-${++sweep}` : 'contacts-stable';
      if (u.searchParams.has('syncToken') && !opts.rewalk) return json({ connections: [], nextSyncToken: token });
      return json({ connections: [contact('first', 'First Example'), contact('second', 'Second Example')], nextSyncToken: token });
    }
    throw new Error(`Unexpected external fixture route ${u.pathname}`);
  };
  return { fetcher, calls };
}

test('#5686: two connector cycles with a cycle stamp between them resume one checkpoint and admit nothing new', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [false, true]) {
    const f = bound ? await boundSource(engine, googleConfig) : await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const { fetcher, calls } = peopleFetcher();
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(2);
    await stamp(engine, f.id);
    await disposePersistenceConsumer(engine);
    const before = await mark(engine, f.id);
    calls.length = 0;
    const second = await runGoogleSync(engine, f.id, cfg, options, fetcher);
    expect(second.status).not.toBe('partial');
    expect(calls.some(url => url.includes('syncToken=contacts-stable'))).toBe(true);
    expect(await admissions(engine, f.id, before)).toEqual({ pages: 0, checkpoints: 0 });
  }
}), 180_000);

test('#5686: a cycle stamp landing mid-sweep does not abort the connector sweep', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const { fetcher } = peopleFetcher({ onList: () => stamp(engine, f.id) });
    const result = await runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, fetcher);
    expect(result.status).not.toBe('partial');
    expect(result.added).toBe(2);
  }
}), 120_000);

test('#5686: a connector write still pending when the stamp lands publishes instead of failing source_changed', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, googleConfig);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const { fetcher } = peopleFetcher();
    try { await runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, fetcher); } catch { /* pending admission */ }
    const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' LIKE '%import' AND state='queued'", [f.id]);
    expect(pending.length).toBeGreaterThan(0);
    await stamp(engine, f.id);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    startPersistenceConsumer(engine, { engine: engine.kind });
    for (const row of pending) expect((await waitForWrite(engine, row, { engine: engine.kind }, 20_000)).state).toBe('committed');
    expect(readFileSync(join(f.dir, 'people/first-example.md'), 'utf8')).toContain('First Example');
  }
}), 120_000);

test('#5470: a re-walk of unchanged provider content admits no page and, with a stable cursor, no checkpoint', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [false, true]) {
    const f = bound ? await boundSource(engine, googleConfig) : await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const { fetcher } = peopleFetcher({ rewalk: true });
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(2);
    await disposePersistenceConsumer(engine);
    const before = await mark(engine, f.id);
    const second = await runGoogleSync(engine, f.id, cfg, options, fetcher);
    expect(second.status).toBe('up_to_date');
    expect(await admissions(engine, f.id, before)).toEqual({ pages: 0, checkpoints: 0 });
  }
}), 180_000);

test('#5470: a rotating provider cursor costs exactly one checkpoint admission and no page admission per quiet run', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const { fetcher } = peopleFetcher({ rotate: true, rewalk: true });
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(2);
    for (let run = 0; run < 2; run++) {
      await stamp(engine, f.id);
      await disposePersistenceConsumer(engine);
      const before = await mark(engine, f.id);
      expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).status).toBe('up_to_date');
      expect(await admissions(engine, f.id, before)).toEqual({ pages: 0, checkpoints: 1 });
    }
  }
}), 180_000);
