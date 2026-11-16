/**
 * #8452: when open_loops cannot read the sources table it does not know
 * whether a google source exists, so it must not answer
 * `no_google_sources: true` with `completeness: "complete"` (an empty,
 * complete inbox). PGLite with the sources read failing, remote and local.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Notice } from '../src/core/agent-output.ts';

let engine: PGLiteEngine;
const openLoops = loopsOperations.find(o => o.name === 'open_loops')!;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config, last_sync_at) VALUES ('source-a', 'source-a', '{"kind":"google"}'::jsonb, now()) ON CONFLICT (id) DO NOTHING`);
});
afterAll(async () => { await engine.disconnect(); });

function failingSources(base: BrainEngine): BrainEngine {
  return new Proxy(base, { get(t, k, r) {
    if (k === 'executeRaw') return (sql: string, params?: unknown[]) => /FROM sources WHERE archived/.test(sql)
      ? Promise.reject(new Error('connection reset by peer at db-host-example')) : t.executeRaw(sql, params as never);
    const v = Reflect.get(t, k, r); return typeof v === 'function' ? v.bind(t) : v;
  } });
}

async function call(e: BrainEngine, remote: boolean, params: Record<string, unknown> = {}) {
  const notices: Notice[] = [];
  const ctx = { engine: e, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'source-a',
    emitNotice: (n: Notice) => notices.push(n) } as unknown as OperationContext;
  const result = await openLoops.handler(ctx, { include_context: false, ...params }) as Record<string, unknown>;
  return { result, notices };
}

describe('#8452 open_loops with an unreadable sources table', () => {
  for (const view of [{}, { group_by: 'none' }]) {
    test(`reports source presence unknown and coverage partial (${JSON.stringify(view)})`, async () => {
      const { result, notices } = await call(failingSources(engine), true, view);
      expect(result.no_google_sources).toBeNull();
      expect(result.completeness).toBe('partial');
      expect(result.stale).toBe(true);
      expect(notices.map(n => n.code)).toContain('loops_source_read_failed');
      expect(notices.map(n => n.code)).not.toContain('loops_no_google_in_scope');
      expect(JSON.stringify({ result, notices })).not.toContain('db-host-example');
    });
  }

  test('the trusted digest says the sources could not be read, not "no google source" or "clean"', async () => {
    const { result } = await call(failingSources(engine), false);
    expect(result.text).toContain('could not be read');
    expect(result.text).not.toContain('No google source is connected');
    expect(result.text).not.toContain('You are clean');
  });

  test('a readable sources table answers as before', async () => {
    const { result, notices } = await call(engine, true);
    expect(result.no_google_sources).toBe(false);
    expect(result.completeness).toBe('complete');
    expect(notices.map(n => n.code)).not.toContain('loops_source_read_failed');
  });
});
