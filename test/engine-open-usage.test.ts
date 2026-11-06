/**
 * GBRA-283 B3a (1c, N2, #8499): an engine opened from settings books chat usage only to its own database, from its
 * own scope, and never sits on the process chat-usage stack that unscoped and local calls book to. Its sink survives
 * reconnect(), which a file-backed PGLite engine implements as disconnect plus connect. Every provider is a stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { __setGenerateTextTransportForTests, chat, resetGateway } from '../src/core/ai/gateway.ts';
import { __chatUsageSinkCountForTests } from '../src/core/ai/chat-usage.ts';
import { openEngine, withEngineScope, type EngineSettings } from '../src/core/engine-open.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { waitFor } from './helpers/wait-for.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const key = () => `sk-usage-${randomBytes(12).toString('hex')}`;
const settingsFor = (database: EngineSettings['database']): EngineSettings => ({
  embedded_core: true, engine: 'pglite', database, host: { id: randomUUID() },
  embedding: { model: 'openai:text-embedding-3-small', dimensions: 1536 },
  ai: { providers: { openai: { apiKey: key() } }, models: { chat: 'openai:gpt-5.6' } },
});
const usageRows = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chat_usage_log'))[0]!.n);
const booked = (engine: BrainEngine, n: number) => waitFor(async () => (await usageRows(engine)) >= n, { timeoutMs: 10_000, label: `${n} usage row(s)` });
const hello = (engine: BrainEngine) => withEngineScope(engine, () => chat({ messages: [{ role: 'user', content: 'hello' }] }));

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});
function stubChat(): void {
  __setGenerateTextTransportForTests((async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } })) as any);
}

describe('embedded chat usage', () => {
  test('openEngine leaves the process usage stack as it found it; createEngine still registers', async () => {
    const before = __chatUsageSinkCountForTests();
    const embedded = await openEngine(settingsFor({}));
    try {
      expect(__chatUsageSinkCountForTests()).toBe(before);
      const cli = await createEngine({ engine: 'pglite' });
      expect(__chatUsageSinkCountForTests()).toBe(before + 1);
      await cli.disconnect();
      expect(__chatUsageSinkCountForTests()).toBe(before);
    } finally {
      await embedded.disconnect();
    }
  }, 60_000);

  test('after reconnect() a file-backed engine\'s chat usage still lands in its own database', async () => {
    stubChat();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-embedded-usage-'));
    const engine = await openEngine(settingsFor({ path: join(dir, 'brain-a.pglite') }));
    try {
      await engine.initSchema();
      await hello(engine);
      await booked(engine, 1);
      expect(await usageRows(engine)).toBe(1);
      await engine.reconnect();
      await hello(engine);
      await booked(engine, 2);
      expect(await usageRows(engine)).toBe(2);
    } finally {
      await engine.disconnect();
    }
  }, 120_000);
});
