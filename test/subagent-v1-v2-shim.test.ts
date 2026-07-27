import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { __testing } from '../src/core/minions/handlers/subagent.ts';

const { adaptContentBlocksToChatBlocks, loadPriorToolsV2 } = __testing as any;

/**
 * v0.38 Slice 1 — D5 read-time content_blocks shim.
 *
 * The crash-replay reconciliation key in v0.38+ is a gbrain-owned UUID v7
 * (ordinal + gbrain_tool_use_id columns added in migration v81). Pre-v0.38
 * rows used Anthropic's provider-supplied tool_use_id as the key and stored
 * Anthropic-shaped content blocks ({type:'tool_use', id, ...}). The shim is
 * what lets crash-replay reconcile across the binary upgrade boundary —
 * jobs that committed v1-shaped rows pre-upgrade must replay through the
 * post-upgrade gateway loop without double-executing tools.
 *
 * Tests pin both shim functions:
 *   - adaptContentBlocksToChatBlocks: v1 Anthropic blocks → v2 ChatBlocks
 *   - loadPriorToolsV2: v1 rows (ordinal=NULL, gbrain_tool_use_id=NULL)
 *     synthesize a stable key from (jobId, msgIdx, tool_use_id, tool_name)
 *     so the gateway-loop reconciler sees them keyed alongside v2 rows.
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '85');
});

describe('adaptContentBlocksToChatBlocks (D5 — v1 Anthropic → v2 ChatBlock shape)', () => {
  it('passes a string through unchanged (plain-text user message)', () => {
    expect(adaptContentBlocksToChatBlocks('hello world')).toBe('hello world');
  });

  it('returns [] for a non-array, non-string input (defensive)', () => {
    expect(adaptContentBlocksToChatBlocks(null)).toEqual([]);
    expect(adaptContentBlocksToChatBlocks(undefined)).toEqual([]);
    expect(adaptContentBlocksToChatBlocks(42)).toEqual([]);
  });

  it('adapts v1 text block (type:text) verbatim', () => {
    const blocks = [{ type: 'text', text: 'hello' }];
    expect(adaptContentBlocksToChatBlocks(blocks)).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('adapts v1 Anthropic tool_use block → v2 tool-call', () => {
    // Anthropic shape: {type:'tool_use', id, name, input}
    // Gateway ChatBlock shape: {type:'tool-call', toolCallId, toolName, input}
    const blocks = [{
      type: 'tool_use',
      id: 'toolu_01ABC',
      name: 'search',
      input: { q: 'foo' },
    }];
    expect(adaptContentBlocksToChatBlocks(blocks)).toEqual([{
      type: 'tool-call',
      toolCallId: 'toolu_01ABC',
      toolName: 'search',
      input: { q: 'foo' },
    }]);
  });

  it('passes v2 tool-call block through (re-read of own writes)', () => {
    const blocks = [{
      type: 'tool-call',
      toolCallId: 'gbrain-uuid-7',
      toolName: 'get_page',
      input: { slug: 'wiki/foo' },
    }];
    expect(adaptContentBlocksToChatBlocks(blocks)).toEqual(blocks);
  });

  it('adapts v1 Anthropic tool_result block → v2 tool-result (synthesizes __legacy__ toolName)', () => {
    // v1 tool_result blocks don't carry tool_name — they reference the
    // assistant turn's tool_use_id via tool_use_id. The shim synthesizes
    // a sentinel toolName since the gateway shape requires one.
    const blocks = [{
      type: 'tool_result',
      tool_use_id: 'toolu_01ABC',
      content: 'search results json',
    }];
    expect(adaptContentBlocksToChatBlocks(blocks)).toEqual([{
      type: 'tool-result',
      toolCallId: 'toolu_01ABC',
      toolName: '__legacy__',
      output: 'search results json',
      isError: false,
    }]);
  });

  it('adapts v1 tool_result with is_error: true', () => {
    const blocks = [{
      type: 'tool_result',
      tool_use_id: 'toolu_01XYZ',
      content: 'tool failed: timeout',
      is_error: true,
    }];
    const out = adaptContentBlocksToChatBlocks(blocks) as any[];
    expect(out[0].isError).toBe(true);
  });

  it('passes v2 tool-result block through', () => {
    const blocks = [{
      type: 'tool-result',
      toolCallId: 'tc1',
      toolName: 'search',
      output: { results: [] },
      isError: false,
    }];
    expect(adaptContentBlocksToChatBlocks(blocks)).toEqual(blocks);
  });

  it('handles a mixed-shape array (v1 + v2 blocks in same message — mid-upgrade scenario)', () => {
    const blocks = [
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'toolu_a', name: 'search', input: { q: 'foo' } },
      { type: 'tool-call', toolCallId: 'gb-b', toolName: 'get_page', input: { slug: 'x' } },
    ];
    const out = adaptContentBlocksToChatBlocks(blocks) as any[];
    expect(out.length).toBe(3);
    expect(out[0]).toEqual({ type: 'text', text: 'thinking...' });
    expect(out[1].type).toBe('tool-call');
    expect(out[1].toolCallId).toBe('toolu_a');
    expect(out[2].type).toBe('tool-call');
    expect(out[2].toolCallId).toBe('gb-b');
  });

  it('skips malformed blocks (defensive: null entries, missing fields)', () => {
    const blocks = [
      null,
      { type: 'text' /* missing text */ },
      { type: 'tool_use', id: 'ok', name: 'real', input: {} },
      { type: 'unknown_type', whatever: true },
    ];
    const out = adaptContentBlocksToChatBlocks(blocks) as any[];
    expect(out.length).toBe(1);
    expect(out[0].toolCallId).toBe('ok');
  });
});

describe('loadPriorToolsV2 (D5 — synthesizes stable keys for v1 rows)', () => {
  it('returns empty array when no rows exist for the job', async () => {
    const rows = await loadPriorToolsV2(engine, 999);
    expect(rows).toEqual([]);
  });

  it('uses gbrain_tool_use_id as stable key for v2 rows', async () => {
    // Seed a minion_jobs row + v2 tool execution.
    const job = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
       RETURNING id`,
    );
    const jobId = job[0].id;
    const gbrainId = '01987654-3210-7000-8000-000000000001';
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status,
          schema_version, ordinal, gbrain_tool_use_id, output)
       VALUES ($1, 0, 'toolu_provider', 'search', '{}'::jsonb, 'complete',
               2, 0, $2::uuid, '"results"'::jsonb)`,
      [jobId, gbrainId],
    );
    const rows = await loadPriorToolsV2(engine, jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].stableKey).toBe(gbrainId);
    expect(rows[0].status).toBe('complete');
    expect(rows[0].output).toBe('results');
  });

  it('synthesizes a legacy-prefixed stable key for v1 rows (ordinal NULL, gbrain_tool_use_id NULL)', async () => {
    const job = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
       RETURNING id`,
    );
    const jobId = job[0].id;
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version, output)
       VALUES ($1, 0, 'toolu_legacy_xyz', 'get_page', '{}'::jsonb, 'complete', 1, '"page content"'::jsonb)`,
      [jobId],
    );
    const rows = await loadPriorToolsV2(engine, jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].stableKey).toBe(`legacy:${jobId}:0:toolu_legacy_xyz:get_page`);
    expect(rows[0].status).toBe('complete');
  });

  it('preserves status + error text for failed legacy rows', async () => {
    const job = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
       RETURNING id`,
    );
    const jobId = job[0].id;
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, error, schema_version)
       VALUES ($1, 0, 'toolu_fail', 'search', '{}'::jsonb, 'failed', 'timeout after 30s', 1)`,
      [jobId],
    );
    const rows = await loadPriorToolsV2(engine, jobId);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toBe('timeout after 30s');
  });

  it('returns v1 + v2 rows side-by-side with both stable-key shapes resolving', async () => {
    // The mid-upgrade scenario: a long-running subagent job has v1 rows
    // (committed pre-upgrade) AND v2 rows (committed post-upgrade by the
    // gateway path). loadPriorToolsV2 must surface both keyed correctly
    // so the reconciler's Map<stableKey, outcome> sees both.
    const job = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
       RETURNING id`,
    );
    const jobId = job[0].id;
    // v1 row: ordinal NULL, gbrain_tool_use_id NULL
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version, output)
       VALUES ($1, 0, 'toolu_v1', 'search', '{}'::jsonb, 'complete', 1, '"v1 result"'::jsonb)`,
      [jobId],
    );
    // v2 row: ordinal + gbrain_tool_use_id populated
    const gbrainId = '01987654-3210-7000-8000-000000000002';
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status,
          schema_version, ordinal, gbrain_tool_use_id, output)
       VALUES ($1, 2, 'toolu_v2', 'get_page', '{}'::jsonb, 'complete',
               2, 0, $2::uuid, '"v2 result"'::jsonb)`,
      [jobId, gbrainId],
    );
    const rows = await loadPriorToolsV2(engine, jobId);
    expect(rows.length).toBe(2);
    const keys = (rows as Array<{ stableKey: string }>).map(r => r.stableKey);
    expect(keys).toContain(`legacy:${jobId}:0:toolu_v1:search`);
    expect(keys).toContain(gbrainId);
  });

  it('ordering: rows return ORDER BY message_idx, ordinal, id (stable for replay)', async () => {
    const job = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
       RETURNING id`,
    );
    const jobId = job[0].id;
    // Insert in scrambled order — message_idx 2 first, then 0, then 1.
    for (const [msg_idx, name] of [[2, 'third'], [0, 'first'], [1, 'second']] as const) {
      await engine.executeRaw(
        `INSERT INTO subagent_tool_executions
           (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version)
         VALUES ($1, $2, $3, $3, '{}'::jsonb, 'complete', 1)`,
        [jobId, msg_idx, name],
      );
    }
    const rows = await loadPriorToolsV2(engine, jobId);
    expect(rows.length).toBe(3);
    // The synthesized stable key embeds tool_name; pull names by parse.
    expect(rows[0].stableKey).toContain(':first');
    expect(rows[1].stableKey).toContain(':second');
    expect(rows[2].stableKey).toContain(':third');
  });
});
