/**
 * #9552: on a managed brain, pages a connector publishes (a Slack day page, a meeting page) are queued for
 * automatic fact extraction through the publication outbox, the way a page write is, and the queued work
 * extracts facts. A connector run never calls a direct queue backstop on a managed brain (that throws
 * `writer_coordinator_required`).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { createConnectorFixture, json, options, settleConnectorWrites, withGoogleAccount } from './helpers/connector-fixture.ts';
import { addThread, fakeGmail, gmailFetch } from './helpers/connector-holds-fixture.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { slackFetch, slackTs, type FakeSlack, slackTestToken } from './helpers/slack-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { runSlackSync } from '../src/core/slack/slack-source.ts';
import { parseSlackSourceConfig } from '../src/core/slack/source-config.ts';
import { slackApi } from '../src/core/slack/client.ts';
import { runMeetingsSync } from '../src/core/meetings/meetings-source.ts';
import { parseMeetingsSourceConfig } from '../src/core/meetings/source-config.ts';
import { firefliesProvider } from '../src/core/meetings/providers/fireflies.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runFactsDrain, __resetFactsDrainNoticesForTests } from '../src/core/facts/drain.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';

const { engines, env, setup, teardown, source } = createConnectorFixture();
beforeAll(setup, 120_000);
// runFactsDrain leaves its first-run notice in a process-wide slot that the next stdio tool reply takes; no test here reads it, so it must not outlive this file (a later file in the same bun process, such as onboarding-ops, would get it as an extra reply item).
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); __resetFactsDrainNoticesForTests(); await teardown(); });

const KEYS = { ANTHROPIC_API_KEY: 'sk-test-9552', OPENAI_API_KEY: 'sk-test-9552' };
const MODEL = 'anthropic:claude-sonnet-4-6';
const DAY = 86_400_000;
const NOW = Date.now();
const OWNER = 'owner@example.invalid';
const CLAIM = 'Acme Example signed a three-year renewal with Beta Example worth two million dollars in October.';
const extract = { ...options, noExtract: false };

const workspace = (): FakeSlack => ({ teamId: 'TACME00001', users: { UALICE0001: { name: 'Alice Example' } }, calls: [], channels: [
  { id: 'CGENERAL01', name: 'general', messages: [{ ts: slackTs(NOW - DAY), user: 'UALICE0001', text: `${CLAIM} The renewal closes the account review for the year.` }] }] });
const meetings = [{ id: 'mtg-9552a', title: 'Renewal review', date: NOW - DAY }];
const fetchImpl = async (_url: string, init: RequestInit) => {
  const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
  if (query.includes('GbrainUser')) return json({ data: { user: { user_id: 'u-9552', email: OWNER, name: 'Owner Example' } } });
  if (query.includes('GbrainTranscripts')) return json({ data: { transcripts: Number(variables.skip) > 0 ? [] : meetings.map(m => ({ id: m.id, title: m.title, date: m.date })) } });
  const m = meetings.find(x => x.id === variables.id)!;
  return json({ data: { transcript: { id: m.id, title: m.title, date: m.date, duration: 30, organizer_email: OWNER, participants: [OWNER],
    meeting_attendees: [{ email: OWNER, displayName: 'Owner Example' }], summary: { overview: `${CLAIM} The team agreed the pricing terms and the next review date.`, action_items: [], keywords: [] } } } });
};

async function managedSource(engine: BrainEngine, id: string, config: Record<string, unknown>) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [id, JSON.stringify(config)]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}
const count = async (engine: BrainEngine, sql: string, params: unknown[]) => Number((await engine.executeRaw<{ n: number }>(sql, params))[0]?.n ?? 0);
const queuedExtractions = (engine: BrainEngine, sourceId: string) => count(engine,
  `SELECT count(*)::int AS n FROM minion_jobs WHERE name='facts-absorb' AND data->>'sourceId'=$1`, [sourceId]);
const openEffects = (engine: BrainEngine, sourceId: string) => count(engine,
  `SELECT count(*)::int AS n FROM persistence_effects WHERE source_id=$1 AND kind='facts-backstop' AND state IN ('queued','running')`, [sourceId]);
const factRows = (engine: BrainEngine, sourceId: string) => count(engine,
  "SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND expired_at IS NULL AND fact LIKE '%three-year renewal%'", [sourceId]);

async function captureStderr<T>(run: () => Promise<T>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { stderr += String(chunk); return original(chunk as never, ...rest as never[]); }) as typeof process.stderr.write;
  try { await run(); return stderr; } finally { process.stderr.write = original; }
}

test('managed brain: a Slack page and a meeting page a connector publishes are queued for facts, and the queued work extracts them', async () => withEnv({ ...env, ...KEYS }, async () => {
  for (const engine of engines) {
    configureGateway({ embedding_disabled: true, env: KEYS } as never);
    await engine.setConfig('facts.extraction_model', MODEL);
    await engine.setConfig('embedding_disabled', 'true');

    const slackConfig = { kind: 'slack', s_channels: 'CGENERAL01', s_record: 'database', federated: false };
    await managedSource(engine, 'slack-9552', slackConfig);
    let stderr = await captureStderr(() => runSlackSync(engine, 'slack-9552', parseSlackSourceConfig(slackConfig, ''), extract,
      { api: slackApi({ token: slackTestToken(), userAgent: 'gbrain-test', fetchImpl: slackFetch(workspace()), sleep: async () => {}, minDelayMs: 0 }) }));
    await settleConnectorWrites(engine, 'slack-9552');

    const meetingConfig = { kind: 'meetings', m_provider: 'fireflies', m_record: 'database', federated: false };
    await managedSource(engine, 'meet-9552', meetingConfig);
    stderr += await captureStderr(() => runMeetingsSync(engine, 'meet-9552', parseMeetingsSourceConfig(meetingConfig, ''), extract,
      { provider: firefliesProvider({ token: 'synthetic-fixture-key', userAgent: 'gbrain-test', fetchImpl, sleep: async () => {} }) }));
    await settleConnectorWrites(engine, 'meet-9552');

    for (const [id, type] of [['slack-9552', 'slack'], ['meet-9552', 'meeting']] as const) {
      const pages = await engine.executeRaw<{ type: string }>('SELECT type FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [id]);
      expect(pages.map(p => p.type)).toEqual([type]);
      await waitFor(async () => (await openEffects(engine, id)) === 0, { timeoutMs: 30_000 });
    }
    expect(stderr).not.toContain('writer_coordinator_required');
    expect({ slack: await queuedExtractions(engine, 'slack-9552'), meeting: await queuedExtractions(engine, 'meet-9552') }).toEqual({ slack: 1, meeting: 1 });

    __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: [{ fact: 'Acme Example signed a three-year renewal with Beta Example', kind: 'fact',
      entity: 'companies/acme-example', confidence: 0.9, notability: 'high' }] }), blocks: [], stopReason: 'end', model: MODEL, providerId: 'anthropic',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } }) as unknown as ChatResult);
    try {
      if (engine.kind === 'pglite') await runFactsDrain(engine, { owner: 'cycle', yieldMs: 0, log: () => {} });
      await runPhaseConversationFactsBackfill(engine, {});
    } finally { __setChatTransportForTests(null); }
    if (engine.kind === 'pglite') expect({ slack: await factRows(engine, 'slack-9552'), meeting: await factRows(engine, 'meet-9552') }).toEqual({ slack: 1, meeting: 1 });
  }
}), 180_000);

test('managed brain: a Gmail import queues no fact extraction, as on an unmanaged brain', async () => withEnv({ ...env, ...KEYS }, async () => {
  for (const engine of engines) {
    configureGateway({ embedding_disabled: true, env: KEYS } as never);
    await engine.setConfig('facts.extraction_model', MODEL);
    const account = 'reader@example.com';
    const gmailConfig = { kind: 'google', g_account: account, g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
    const f = await source(engine, gmailConfig);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f69552', Date.now() - 3_600_000, `${CLAIM} The renewal closes the account review for the year.`);
    await runGoogleSync(engine, f.id, parseGoogleSourceConfig(gmailConfig, f.dir), extract, withGoogleAccount(gmailFetch(fx), account));
    await settleConnectorWrites(engine, f.id);
    const pages = await engine.executeRaw<{ type: string }>('SELECT type FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id]);
    expect(pages.map(p => p.type)).toEqual(['email']);
    await waitFor(async () => (await openEffects(engine, f.id)) === 0, { timeoutMs: 30_000 });
    expect(await queuedExtractions(engine, f.id)).toBe(0);
    await disposePersistenceConsumer(engine);
  }
}), 120_000);

test('managed brain: a run with --no-extract queues no fact extraction', async () => withEnv({ ...env, ...KEYS }, async () => {
  for (const engine of engines) {
    const config = { kind: 'meetings', m_provider: 'fireflies', m_record: 'database', federated: false };
    await managedSource(engine, 'meet-9552-noextract', config);
    await runMeetingsSync(engine, 'meet-9552-noextract', parseMeetingsSourceConfig(config, ''), options,
      { provider: firefliesProvider({ token: 'synthetic-fixture-key', userAgent: 'gbrain-test', fetchImpl, sleep: async () => {} }) });
    await settleConnectorWrites(engine, 'meet-9552-noextract');
    const [receipt] = await engine.executeRaw<{ facts: unknown }>(
      `SELECT outcome->'facts_backstop' AS facts FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import'`, ['meet-9552-noextract']);
    expect(receipt?.facts ?? null).toBeNull();
    expect(await openEffects(engine, 'meet-9552-noextract')).toBe(0);
    expect(await queuedExtractions(engine, 'meet-9552-noextract')).toBe(0);
  }
}), 120_000);

test('unmanaged brain: a page whose fact extraction could not be queued is logged to ingest_log and stderr, not dropped', async () => withEnv({ ...env, ...KEYS }, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const config = { kind: 'meetings', m_provider: 'fireflies', m_record: 'database', federated: false };
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', ['meet-9552-plain', JSON.stringify(config)]);
    const failing = new Proxy(engine, { get: (target, key, receiver) => key === 'getConfig'
      ? async (k: string) => { if (k === 'facts.extraction_enabled') throw new Error('synthetic config read failure'); return target.getConfig(k); }
      : Reflect.get(target, key, receiver) }) as BrainEngine;
    try {
      const stderr = await captureStderr(() => runMeetingsSync(failing, 'meet-9552-plain', parseMeetingsSourceConfig(config, ''), extract,
        { provider: firefliesProvider({ token: 'synthetic-fixture-key', userAgent: 'gbrain-test', fetchImpl, sleep: async () => {} }) }));
      expect(stderr).toContain('meet-9552-plain: fact extraction was not queued for 1 page(s): synthetic config read failure');
      const logged = await engine.executeRaw<{ summary: string }>(`SELECT summary FROM ingest_log WHERE source_id=$1 AND source_type='facts:absorb'`, ['meet-9552-plain']);
      expect(logged.map(r => r.summary)).toEqual(['pipeline_error: extraction failed (Error)']);
    } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  }
}), 120_000);

test('Slack pages a connector published before the fix get their facts from gbrain extract-conversation-facts', async () => withEnv({ ...env, ...KEYS }, async () => {
  const { runExtractConversationFacts } = await import('../src/commands/extract-conversation-facts.ts');
  const day = NOW - DAY;
  const conversation = (): FakeSlack => ({ teamId: 'TACME00001', users: { UALICE0001: { name: 'Alice Example' }, UBOB000001: { name: 'Bob Example' } }, calls: [], channels: [
    { id: 'CGENERAL01', name: 'general', messages: [
      { ts: slackTs(day, 1), user: 'UALICE0001', text: CLAIM },
      { ts: slackTs(day, 2), user: 'UBOB000001', text: 'Great news. Did Beta Example agree to the pricing terms we proposed last week?' },
      { ts: slackTs(day, 3), user: 'UALICE0001', text: 'Yes, they accepted the pricing terms and the renewal starts in January.' },
      { ts: slackTs(day, 4), user: 'UBOB000001', text: 'I will update the account plan and schedule the next review for the spring.' }] }] });
  for (const engine of engines) {
    configureGateway({ embedding_disabled: true, env: KEYS } as never);
    await engine.setConfig('facts.extraction_model', MODEL);
    await engine.setConfig('embedding_disabled', 'true');
    const config = { kind: 'slack', s_channels: 'CGENERAL01', s_record: 'database', federated: false };
    await managedSource(engine, 'slack-9552-before', config);
    await runSlackSync(engine, 'slack-9552-before', parseSlackSourceConfig(config, ''), options,
      { api: slackApi({ token: slackTestToken(), userAgent: 'gbrain-test', fetchImpl: slackFetch(conversation()), sleep: async () => {}, minDelayMs: 0 }) });
    await settleConnectorWrites(engine, 'slack-9552-before');
    expect(await queuedExtractions(engine, 'slack-9552-before')).toBe(0);
    expect(await factRows(engine, 'slack-9552-before')).toBe(0);
    __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: [{ fact: 'Acme Example signed a three-year renewal with Beta Example', kind: 'fact',
      entity: 'companies/acme-example', confidence: 0.9, notability: 'high' }] }), blocks: [], stopReason: 'end', model: MODEL, providerId: 'anthropic',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } }) as unknown as ChatResult);
    try { await runExtractConversationFacts(engine, ['--source-id', 'slack-9552-before', '--types', 'slack', '--yes']); }
    finally { __setChatTransportForTests(null); }
    expect(await factRows(engine, 'slack-9552-before')).toBeGreaterThan(0);
  }
}), 120_000);
