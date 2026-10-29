/**
 * Slack source kind on a managed brain (persistence enabled): the coordinator
 * journals each day page. A repo-less managed source records to the database
 * through the write journal (a receipt per page); a channel that becomes
 * private re-publishes its pages private through the journal; a Git-recorded
 * managed source without a bound checkout refuses instead of writing to the
 * database alone.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { createConnectorFixture, options, settleConnectorWrites } from './helpers/connector-fixture.ts';
import { slackFetch, slackTs, type FakeSlack } from './helpers/slack-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { runSlackSync } from '../src/core/slack/slack-source.ts';
import { parseSlackSourceConfig } from '../src/core/slack/source-config.ts';
import { slackApi } from '../src/core/slack/client.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const { engines, env, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const DAY = 86_400_000;
const NOW = Date.now();
const workspace = (): FakeSlack => ({ teamId: 'TACME00001', users: { UALICE0001: { name: 'Alice Example' } }, calls: [], channels: [
  { id: 'CGENERAL01', name: 'general', messages: [{ ts: slackTs(NOW - DAY), user: 'UALICE0001', text: 'Managed day one.' }, { ts: slackTs(NOW - 2 * DAY), user: 'UALICE0001', text: 'Managed day two.' }] }] });
const api = (fake: FakeSlack) => slackApi({ token: 'xoxb-synthetic-fixture', userAgent: 'gbrain-test', fetchImpl: slackFetch(fake), sleep: async () => {}, minDelayMs: 0 });

async function managedSource(engine: BrainEngine, id: string, config: Record<string, unknown>) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [id, JSON.stringify(config)]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}
const livePages = (engine: BrainEngine, id: string) => engine.executeRaw<{ slug: string; visibility: string | null }>(
  `SELECT slug, frontmatter->>'visibility' AS visibility FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug`, [id]);

test('managed repo-less: each day page is written through the journal with a receipt; a channel that becomes private re-publishes private', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'slack', s_channels: 'CGENERAL01', s_record: 'database', federated: false };
    await managedSource(engine, 'slack-managed', config);
    const cfg = parseSlackSourceConfig(config, '');
    const fake = workspace();
    await runSlackSync(engine, 'slack-managed', cfg, options, { api: api(fake) });
    await settleConnectorWrites(engine, 'slack-managed');
    expect((await livePages(engine, 'slack-managed')).map(r => r.visibility)).toEqual([null, null]);
    const receipts = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state='committed'`, ['slack-managed']);
    expect(receipts[0]!.n).toBeGreaterThan(0);

    fake.channels[0]!.isPrivate = true;
    await runSlackSync(engine, 'slack-managed', cfg, options, { api: api(fake) });
    await settleConnectorWrites(engine, 'slack-managed');
    expect((await livePages(engine, 'slack-managed')).map(r => r.visibility)).toEqual(['private', 'private']);
  }
}), 120_000);

test('managed Git-recorded source without a bound checkout refuses the day; nothing is written database-only', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'slack', s_channels: 'CGENERAL01', s_record: 'git', s_dir: '/nonexistent/slack', canonical: 'git', federated: false };
    await managedSource(engine, 'slack-managed-git', config);
    const cfg = parseSlackSourceConfig(config, '');
    await expect(runSlackSync(engine, 'slack-managed-git', cfg, options, { api: api(workspace()) })).rejects.toMatchObject({ code: 'connector_binding_missing' });
    expect(await livePages(engine, 'slack-managed-git')).toEqual([]);
  }
}), 120_000);
