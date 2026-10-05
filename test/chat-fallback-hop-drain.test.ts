/**
 * Where the first-hop `chat_fallback_hop` notice is drained (fix wave lane B3).
 *
 * Protects: the process-level queue `chatWithFallback` fills is drained into
 * the first stdio MCP tool result and into the CLI op notice channel; HTTP
 * never drains it (it names models, which stay on the brain host).
 * Fails when: a drain site stops reading the queue, or HTTP starts leaking it.
 * Seams: the queue is filled directly; PGLite for dispatch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { NoticeLedger, __resetProcessNoticeLedgerForTests } from '../src/core/notice-ledger.ts';
import { queueFirstFallbackHop, takeChatFallbackHopNotices, __resetChatFallbackHopNoticeForTests } from '../src/core/ai/fallback-hop-queue.ts';
import { chatFallbackHopNotice } from '../src/core/ai/chat-fallback.ts';
import { applyCliOpNotices } from '../src/cli/op-notices.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const HOP = '[gbrain notice chat_fallback_hop kind=safety]';
const queueHop = () => queueFirstFallbackHop(() => chatFallbackHopNotice('claude-cli:claude-sonnet-4-6', 'openai:gpt-5.6-luna', 'upstream 503', false));

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(() => { __resetChatFallbackHopNoticeForTests(); __resetProcessNoticeLedgerForTests(); });

const cfg = { engine: 'pglite', database_path: join(tmpdir(), 'hop-drain-brain') } as GBrainConfig;

describe('chat_fallback_hop drain sites', () => {
  test('the first stdio tool result after a hop carries it once', async () => {
    await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-hop-')) }, async () => {
      expect(queueHop()).toBe(true);
      expect(queueHop()).toBe(false);
      const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default', config: cfg };
      const first = await dispatchToolCall(engine as never, 'list_pages', {}, opts);
      const block = first.content.map(c => c.text).find(t => t.startsWith(HOP));
      expect(block).toContain('openai:gpt-5.6-luna');
      expect(block).toContain('claude-cli:claude-sonnet-4-6');
      const second = await dispatchToolCall(engine as never, 'list_pages', {}, opts);
      expect(second.content.some(c => c.text.startsWith(HOP))).toBe(false);
    });
  }, 60_000);

  test('HTTP never drains it', async () => {
    await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-hop-')) }, async () => {
      queueHop();
      const res = await dispatchToolCall(engine as never, 'list_pages', {}, {
        remote: true, transport: 'http', sourceId: 'default', config: cfg, noticeLedger: new NoticeLedger(),
        auth: { token: 't', clientId: 'hop-client', clientName: 'hop-client', scopes: ['read'], expiresAt: Date.now() / 1000 + 3600 } as never,
      });
      expect(res.content.some(c => c.text.startsWith(HOP))).toBe(false);
      expect(takeChatFallbackHopNotices()).toHaveLength(1);
    });
  }, 60_000);

  test('the CLI op notice channel drains it into a --json result', () => {
    queueHop();
    const { result } = applyCliOpNotices({ ok: true }, true);
    expect((result as { notices?: Array<{ code: string }> }).notices?.map(n => n.code)).toEqual(['chat_fallback_hop']);
    expect(takeChatFallbackHopNotices()).toEqual([]);
  });
});
