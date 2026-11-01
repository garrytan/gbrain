/**
 * #7286: a remote open_loops call whose granted sources hold no google source
 * says so (a notice: the answer covers only this connection's sources, how to
 * pass source_id, the sources_list fix) instead of a bare empty result, and
 * the answer is the same whether or not a google source exists elsewhere in
 * the brain: no out-of-scope id, count or existence leaks. PGLite, synthetic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';

let engine: PGLiteEngine;
const openLoops = loopsOperations.find(o => o.name === 'open_loops')!;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('source-a', 'source-a', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
});

async function seedGoogleElsewhere(): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name, config, last_sync_at) VALUES ('google-elsewhere', 'google-elsewhere', '{"kind":"google"}'::jsonb, now()) ON CONFLICT (id) DO NOTHING`);
  await upsertOpenLoop(engine, { sourceId: 'google-elsewhere', dedupKey: 'thread:18c2f4a9b3d21e07:unanswered_inbound', loopType: 'unanswered_inbound',
    counterpartyEmail: 'bob@example.com', summary: 'Reply owed to bob@example.com', evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'Can you review?' }],
    threadId: '18c2f4a9b3d21e07', detector: 'deterministic_thread' } as Parameters<typeof upsertOpenLoop>[1]);
}

async function call(params: Record<string, unknown>) {
  const notices: Notice[] = [];
  const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'source-a',
    emitNotice: (n: Notice) => notices.push(n) } as unknown as OperationContext;
  const result = await openLoops.handler(ctx, { as_of: '2026-10-31T00:00:00Z', ...params }) as Record<string, unknown>;
  return { result, notices };
}

describe('#7286 open_loops for a remote caller bound to a non-google source', () => {
  for (const view of [{}, { group_by: 'none' }]) {
    test(`says the answer covers only this connection's sources (${JSON.stringify(view)})`, async () => {
      const { result, notices } = await call(view);
      expect(result.no_google_sources).toBe(true);
      const notice = notices.find(n => n.code === 'loops_no_google_in_scope');
      expect(notice).toBeDefined();
      expect(notice!.why).toContain('source-a');
      expect(notice!.why).toContain('source_id');
      expect(notice!.why).toContain('not "inbox clean"');
      expect(notice!.fix?.mcp).toEqual({ tool: 'sources_list', arguments: {} });
    });

    test(`is identical whether or not a google source exists outside the grant (${JSON.stringify(view)})`, async () => {
      const without = await call(view);
      await seedGoogleElsewhere();
      const withGoogle = await call(view);
      expect(JSON.stringify(withGoogle)).toBe(JSON.stringify(without));
      expect(JSON.stringify(withGoogle)).not.toContain('google-elsewhere');
    });
  }

  test('a scope that holds a google source carries no such notice', async () => {
    await seedGoogleElsewhere();
    const notices: Notice[] = [];
    const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'google-elsewhere',
      emitNotice: (n: Notice) => notices.push(n) } as unknown as OperationContext;
    const result = await openLoops.handler(ctx, {}) as Record<string, unknown>;
    expect(result.no_google_sources).toBe(false);
    expect(notices.map(n => n.code)).not.toContain('loops_no_google_in_scope');
  });
});
