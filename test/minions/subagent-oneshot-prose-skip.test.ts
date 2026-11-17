/**
 * #9648 — a oneshot child that answers a skip as prose (not the skip JSON) is
 * re-asked once for the JSON contract, so the skip is banked instead of
 * falling through to an agentic loop that dead-letters under require_writes.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { buildBrainTools } from '../../src/core/minions/tools/brain-allowlist.ts';
import type { MinionJobContext, SubagentHandlerData } from '../../src/core/minions/types.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { runSubagentOneshot, type OneshotArgs } from '../../src/core/minions/handlers/subagent-oneshot.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

const DATA: SubagentHandlerData = {
  prompt: 'CONTEXT ... TRANSCRIPT ...',
  allowed_slug_prefixes: ['wiki/personal/reflections/*'],
  oneshot_slug_suffix: 'abc123',
  mode: 'oneshot',
  require_writes: true,
};

const PROSE = "I'm not writing any pages for this transcript. It contains only one idle notification.";
const SKIP_JSON = '{"pages": [], "skipped": true, "skip_reason": "routine idle notification"}';

describe('oneshot prose skip (#9648)', () => {
  test('prose skip is re-asked once and banked as a skip, not a fallback', async () => {
    const job = await queue.add('subagent', DATA as unknown as Record<string, unknown>, {}, { allowProtectedSubmit: true });
    const ac = new AbortController();
    const ctx = {
      id: job.id, name: job.name, data: DATA as unknown as Record<string, unknown>, attempts_made: 0,
      idempotency_key: null, signal: ac.signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
      async updateProgress() {}, async updateTokens() {}, async log() {}, async isActive() { return true; }, async readInbox() { return []; },
    } as MinionJobContext;
    const tools = buildBrainTools({
      subagentId: ctx.id, engine, config: { engine: 'pglite' } as unknown as GBrainConfig,
      allowedSlugPrefixes: DATA.allowed_slug_prefixes, sourceId: DATA.source_id, deferEmbeds: true,
    });
    let calls = 0;
    const chat = (async () => {
      calls++;
      const text = calls === 1 ? PROSE : SKIP_JSON;
      return {
        text, blocks: [{ type: 'text', text }], stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
      };
    }) as OneshotArgs['_chat'];
    const out = await runSubagentOneshot({
      engine, ctx, data: DATA, model: 'anthropic:claude-sonnet-4-6', maxOutputTokens: 8192,
      putPageTool: tools.find(t => t.name === 'brain_put_page'),
      leaseKey: 'anthropic:messages', maxConcurrent: 32, leaseTtlMs: 120_000, _chat: chat,
    });
    expect(out.kind).toBe('done');
    const rows = await engine.executeRaw<{ tool_name: string }>(
      `SELECT tool_name FROM subagent_tool_executions WHERE job_id = $1`, [ctx.id]);
    expect(rows.map(r => r.tool_name)).toContain('oneshot_skip');
  });
});
