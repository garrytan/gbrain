/**
 * Meetings source kind on a managed brain (persistence enabled): the
 * coordinator journals each page write. Repo-less managed sources record to
 * the database through the write journal (a receipt per page); a Git-recorded
 * managed source without a bound checkout refuses instead of writing to the
 * database alone.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { createConnectorFixture, json, options, settleConnectorWrites } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { runMeetingsSync } from '../src/core/meetings/meetings-source.ts';
import { parseMeetingsSourceConfig } from '../src/core/meetings/source-config.ts';
import { firefliesProvider } from '../src/core/meetings/providers/fireflies.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const { engines, env, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const DAY = 86_400_000;
const NOW = Date.now();
const OWNER = 'owner@example.invalid';
const meetings = [{ id: 'mtg-man111', title: 'Managed planning', date: NOW - DAY }];

const fetchImpl = async (_url: string, init: RequestInit) => {
  const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
  if (query.includes('GbrainUser')) return json({ data: { user: { user_id: 'u-managed', email: OWNER, name: 'Owner Example' } } });
  if (query.includes('GbrainTranscripts')) return json({ data: { transcripts: Number(variables.skip) > 0 ? [] : meetings.map(m => ({ id: m.id, title: m.title, date: m.date })) } });
  const m = meetings.find(x => x.id === variables.id)!;
  return json({ data: { transcript: { id: m.id, title: m.title, date: m.date, duration: 30, organizer_email: OWNER, participants: [OWNER],
    meeting_attendees: [{ email: OWNER, displayName: 'Owner Example' }], summary: { overview: 'Managed summary.', action_items: [], keywords: [] } } } });
};
const provider = () => firefliesProvider({ token: 'synthetic-fixture-key', userAgent: 'gbrain-test', fetchImpl, sleep: async () => {} });

async function managedSource(engine: BrainEngine, id: string, config: Record<string, unknown>) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [id, JSON.stringify(config)]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

test('managed repo-less: each meeting page is written through the journal with a receipt', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'meetings', m_provider: 'fireflies', m_record: 'database', federated: false };
    await managedSource(engine, 'meet-managed', config);
    const cfg = parseMeetingsSourceConfig(config, '');
    await runMeetingsSync(engine, 'meet-managed', cfg, options, { provider: provider() });
    await settleConnectorWrites(engine, 'meet-managed');
    const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', ['meet-managed']);
    expect(rows).toHaveLength(1);
    const receipts = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state='committed'`, ['meet-managed']);
    expect(receipts[0]!.n).toBeGreaterThan(0);
  }
}), 120_000);

test('managed Git-recorded source without a bound checkout refuses the meeting; nothing is written database-only', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'meetings', m_provider: 'fireflies', m_record: 'git', m_dir: '/nonexistent/meetings', canonical: 'git', federated: false };
    await managedSource(engine, 'meet-managed-git', config);
    const cfg = parseMeetingsSourceConfig(config, '');
    await expect(runMeetingsSync(engine, 'meet-managed-git', cfg, options, { provider: provider() })).rejects.toMatchObject({ code: 'connector_binding_missing' });
    const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', ['meet-managed-git']);
    expect(rows).toEqual([]);
  }
}), 120_000);
