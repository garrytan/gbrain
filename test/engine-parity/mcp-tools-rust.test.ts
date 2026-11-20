/**
 * BrainEngine parity: MCP tools that a Rust brain refused with no owner (lane 12's serve-http route table), called
 * through `dispatchToolCall` as a trusted local stdio caller, on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each tool answers the same on PGLite, Postgres and Rust, or the Rust arm stops on a named refusal.
 *    get_job_stats raises the `no_worker` notice with the waiting count of its queue; cache_stats refuses on Rust as
 *    `query_cache_unavailable` (the store keeps no query_cache table) and never answers zero rows there.
 *  - Regression: a raw-SQL read on the tool path that a Rust brain refuses, or a fail-open catch that hides the refusal
 *    and answers as if the table were empty.
 *  - Why existing coverage misses it: test/quarantine-cache-ops.test.ts and the jobs op tests run on PGLite only.
 *  - Seam: dispatchToolCall, the MCP tools/call path both transports share; results are parsed from its text block.
 */
import { describe, expect } from 'bun:test';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { NoticeLedger } from '../../src/core/notice-ledger.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const LOCAL = { remote: false, transport: 'stdio' as const, sourceId: 'default' };

interface ToolAnswer { error: string | null; body: Record<string, unknown> | null; notices: string[] }

/** One tools/call: the parsed JSON body, or the error code of an isError result, and the notice codes. */
async function call(engine: Parameters<typeof dispatchToolCall>[0], name: string, params: Record<string, unknown> = {}): Promise<ToolAnswer> {
  // A fresh ledger per call: the process ledger admits a notice once per audience, so a later arm would not see it.
  const res = await dispatchToolCall(engine, name, params, { ...LOCAL, noticeLedger: new NoticeLedger() });
  // A success renders each notice as a text block beside the body; the body is the block that is a JSON object.
  const blocks = res.content.map(c => (c as { text?: string }).text ?? '');
  const text = blocks.find(b => b.trimStart().startsWith('{')) ?? blocks.join('\n');
  const meta = (res as { _meta?: { gbrain_notices?: Array<{ code?: string }> } })._meta;
  const notices = (meta?.gbrain_notices ?? []).map(n => String(n.code));
  if (res.isError) {
    let code = text;
    try { const parsed = JSON.parse(text) as { error?: string; code?: string; detail?: string }; code = `${parsed.code ?? parsed.error}${parsed.detail ? ` ${parsed.detail}` : ''}`; } catch { /* plain text */ }
    return { error: code, body: null, notices };
  }
  return { error: null, body: JSON.parse(text) as Record<string, unknown>, notices };
}

describe('engine parity: MCP tools a Rust brain refused', () => {
  parityTest('get_job_stats names the waiting jobs of a queue no worker serves',
    { methods: ['listWaitingByQueue'] }, async (engine) => {
      const queue = new MinionQueue(engine);
      await queue.add('sync', { n: 1 }, { queue: 'lane-q' });
      await queue.add('sync', { n: 2 }, { queue: 'lane-q' });
      await queue.add('sync', { n: 3 }, { queue: 'other-q' });
      const answer = await call(engine, 'get_job_stats', { queue: 'lane-q' });
      expect(answer.error).toBeNull();
      expect(answer.body?.no_worker).toBe(true);
      expect(answer.notices).toContain('no_worker');
      return { no_worker: answer.body?.no_worker, notices: answer.notices };
    });

  parityTest('cache_stats counts the query cache on SQL brains and refuses by name on Rust, never as zero rows',
    { methods: ['readQueryCacheStats'] }, async (engine, backend) => {
      const answer = await call(engine, 'cache_stats');
      if (backend === 'rust') {
        expect(answer.body).toBeNull();
        expect(answer.error).toContain('engine_capability_missing');
        expect(answer.error).toContain('query_cache_unavailable');
        // The harness wants the Rust arm to end on the typed refusal the member raised.
        await engine.readQueryCacheStats();
      }
      expect(answer.error).toBeNull();
      return { total_rows: answer.body?.total_rows, total_hits: answer.body?.total_hits };
    });
});
