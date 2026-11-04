/**
 * GBRA-283 B3a on Postgres: an embedded engine's chat usage still lands in its own database after reconnect(), and
 * 1,000 per-call open/read/close cycles leave no engine in the process alias and privacy policy sets. Uses a scratch
 * database on the DATABASE_URL server; skips without DATABASE_URL. The chat provider is a transport stub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { __setGenerateTextTransportForTests, chat, resetGateway } from '../../src/core/ai/gateway.ts';
import { openEngine, withEngineScope, type EngineSettings } from '../../src/core/engine-open.ts';
import { __aliasPolicyEngineCountForTests, readHonorAliases, remotePrivacyRelaxed } from '../../src/core/search/private-visibility.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { waitFor } from '../helpers/wait-for.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) console.log('Skipping E2E B3a embedded engine on Postgres (DATABASE_URL not set)');

let url = '';
let drop: (() => Promise<void>) | null = null;
const settings = (): EngineSettings => ({
  embedded_core: true, engine: 'postgres', database: { url }, pool: { max: 1 }, host: { id: randomUUID() },
  ai: { providers: { openai: { apiKey: `sk-b3a-${randomBytes(12).toString('hex')}` } }, models: { chat: 'openai:gpt-5.6' } },
});

beforeAll(async () => {
  if (!DATABASE_URL) return;
  assertSafeE2eDatabaseUrl(DATABASE_URL);
  const admin = postgres(DATABASE_URL, { max: 1, prepare: false });
  const name = `gbrain_test_b3a_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const parsed = new URL(DATABASE_URL);
  parsed.pathname = `/${name}`;
  url = parsed.toString();
  drop = async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); };
  const seed = await openEngine(settings());
  try { await seed.initSchema(); } finally { await seed.disconnect(); }
}, 120_000);

afterAll(async () => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
  await drop?.().catch(() => {});
});

describeE2E('embedded engine on Postgres (B3a)', () => {
  test('chat usage still lands in the engine\'s own database after reconnect()', async () => {
    __setGenerateTextTransportForTests((async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } })) as any);
    const engine: BrainEngine = await openEngine(settings());
    const rows = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chat_usage_log'))[0]!.n);
    try {
      const start = await rows();
      await withEngineScope(engine, () => chat({ messages: [{ role: 'user', content: 'hello' }] }));
      await waitFor(async () => (await rows()) >= start + 1, { timeoutMs: 10_000, label: 'first usage row' });
      expect(await rows()).toBe(start + 1);
      await engine.reconnect();
      await withEngineScope(engine, () => chat({ messages: [{ role: 'user', content: 'hello again' }] }));
      await waitFor(async () => (await rows()) >= start + 2, { timeoutMs: 10_000, label: 'usage row after reconnect' });
      expect(await rows()).toBe(start + 2);
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('1,000 open, read and close cycles leave no engine in the alias and privacy policy sets', async () => {
    const before = __aliasPolicyEngineCountForTests();
    for (let i = 0; i < 1000; i++) {
      const engine = await openEngine(settings());
      try {
        await withEngineScope(engine, () => remotePrivacyRelaxed(engine));
        await readHonorAliases(engine);
      } finally {
        await engine.disconnect();
      }
    }
    expect(__aliasPolicyEngineCountForTests()).toBe(before);
  }, 600_000);
});
