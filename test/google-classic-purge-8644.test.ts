import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../src/core/google/google-source.ts';
import { runRetryHeld } from '../src/commands/sources-retry-held.ts';
import { createConnectorFixture, contact, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { ItemHoldsRun } from '../src/core/connectors/item-holds.ts';

const fixture = createConnectorFixture();
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

for (const backend of fixture.backends) describe(`[${backend}] classic Google page purges`, () => {
  for (const service of ['contacts', 'calendar', 'gmail'] as const) {
    for (const keepFile of [true, false]) test(`${service}: a purged render with ${keepFile ? 'a retained' : 'no'} checkout file is a clean skip`, async () => withEnv(fixture.env, async () => {
      const engine = fixture.engines.find(e => e.kind === backend)!;
      const config = { ...googleConfig, g_services: service, g_history_days: 2 };
      const f = await fixture.source(engine, config);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      let generation = 0;
      const ms = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
      const fetcher = withGoogleAccount(async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/connections')) return json({ connections: [contact('c1', 'Alice Example'),
          { ...contact('c2', 'Bob Example'), organizations: [{ name: `Healthy ${generation}` }] }], nextSyncToken: `token-${generation}` });
        if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
        if (u.pathname.endsWith('/profile')) return json({ emailAddress: config.g_account, historyId: '2000' });
        if (u.pathname.endsWith('/events')) return json({ items: [
          { id: 'e1', summary: 'Target event', start: { dateTime: new Date(ms).toISOString() }, end: { dateTime: new Date(ms + 3_600_000).toISOString() } },
          { id: 'e2', summary: 'Sibling event', description: `Healthy ${generation}`, start: { dateTime: new Date(ms).toISOString() }, end: { dateTime: new Date(ms + 3_600_000).toISOString() } },
        ], nextSyncToken: `calendar-${generation}` });
        if (u.pathname.endsWith('/history')) return json({ historyId: '2000', history: [{ id: '2000', messagesAdded: [
          { message: { id: 'm1', threadId: 't1' } }, { message: { id: 'm2', threadId: 't2' } }] }] });
        if (u.pathname.endsWith('/messages')) {
          const floor = Number(/before:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? Infinity);
          return json({ messages: ms / 1000 < floor ? [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] : [] });
        }
        const tid = u.pathname.match(/\/threads\/(t[12])$/)?.[1];
        if (tid) return json({ id: tid, messages: [{ id: tid === 't1' ? 'm1' : 'm2', threadId: tid, labelIds: [], internalDate: String(ms),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
            { name: 'To', value: config.g_account }, { name: 'Subject', value: `Synthetic topic ${tid}` }],
          body: { data: Buffer.from(tid === 't1' ? 'A synthetic message to retain as purged.' : `Healthy sibling ${generation}.`).toString('base64url') } } }] });
        throw new Error(`Unexpected fixture route ${u.pathname}`);
      });
      const cfg = parseGoogleSourceConfig(config, f.dir);
      const sync = () => runGoogleSync(engine, f.id, cfg, { ...options, full: true }, fetcher);
      expect((await sync()).failedFiles ?? 0).toBe(0);
      const rows = await engine.executeRaw<{ slug: string; source_path: string; content_hash: string }>('SELECT slug,source_path,content_hash FROM pages WHERE source_id=$1 ORDER BY slug', [f.id]);
      const target = rows.find(r => service === 'contacts' ? r.slug === 'people/alice-example' : r.slug.includes(service === 'gmail' ? 't1' : 'target-event'))!;
      expect(target).toBeDefined();
      const path = join(f.dir, target.source_path);
      const original = readFileSync(path, 'utf8');
      if (keepFile) {
        writeFileSync(path, `${original}\nSynthetic independent file edit.\n`);
        for (let i = 0; i < 3; i++) expect((await sync()).failedFiles).toBe(1);
        expect(Object.values(new ItemHoldsRun(readGoogleState(f.dir).item_holds).initial().items).some(item => item.state === 'held')).toBe(true);
        writeFileSync(path, original);
      }
      await engine.executeRaw('INSERT INTO page_purges(source_id,content_hash,slug) VALUES($1,$2,$3)', [f.id, target.content_hash, target.slug]);
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [f.id, target.slug]);
      if (keepFile) {
        await runRetryHeld(engine, [f.id]);
      }
      if (!keepFile) rmSync(path);
      // A clean pre-write skip must not even remove a stale temp render.
      writeFileSync(`${path}.tmp`, 'synthetic stale temp bytes');
      generation++;
      for (let i = 0; i < 3; i++) {
        const result = await sync();
        expect(result.failedFiles ?? 0).toBe(0);
        expect(result.status).not.toBe('partial');
      }
      expect(await engine.getPage(target.slug, { sourceId: f.id })).toBeNull();
      expect(existsSync(path)).toBe(keepFile);
      if (keepFile) expect(readFileSync(path, 'utf8')).toBe(original);
      expect(readFileSync(`${path}.tmp`, 'utf8')).toBe('synthetic stale temp bytes');
      const state = readGoogleState(f.dir);
      expect(Object.keys(new ItemHoldsRun(state.item_holds).initial().items)).toEqual([]);
      if (service === 'contacts') expect(state.contacts_sync_token).toBe('token-1');
      else if (service === 'calendar') expect(state.calendar_sync_token).toBe('calendar-1');
      else expect(state.gmail_backfill_done).toBe(true);
      const sibling = rows.find(r => r.slug !== target.slug)!;
      expect((await engine.getPage(sibling.slug, { sourceId: f.id }))?.compiled_truth).toContain('Healthy');
      expect(await engine.executeRaw('SELECT 1 FROM page_purges WHERE source_id=$1 AND content_hash=$2', [f.id, target.content_hash])).toHaveLength(1);
      await runRetryHeld(engine, [f.id]);
      expect((await sync()).failedFiles ?? 0).toBe(0);
      // Explicit unpurge, not retry-held, is what authorizes restoring the page.
      await engine.executeRaw('DELETE FROM page_purges WHERE source_id=$1', [f.id]);
      rmSync(`${path}.tmp`);
      if (keepFile) rmSync(path);
      expect((await sync()).failedFiles ?? 0).toBe(0);
      expect(await engine.getPage(target.slug, { sourceId: f.id })).not.toBeNull();
    }), 180_000);
  }
});
