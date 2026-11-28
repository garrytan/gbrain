/**
 * Page-body facts take the page's observation date, never the sync time.
 *
 * Protects: a dated note (meetings/2019-05-01-…) imported today stores its
 * extracted facts at 2019-05-01; an undated page leaves the event date unknown; an
 * explicit caller validFrom still wins over the page date; and such facts
 * decay as old evidence in hot-memory ranking (effectiveConfidence).
 * Seams: gateway chat transport stub; in-memory PGLite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runFactsBackstop, type FactsBackstopCtx } from '../../src/core/facts/backstop.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../../src/core/facts/queue.ts';
import { effectiveConfidence } from '../../src/core/facts/decay.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
afterEach(() => { __setChatTransportForTests(null); resetGateway(); __resetFactsQueueForTests(); });

const BODY = 'this is a real meeting note longer than eighty characters for the backstop gate. '.repeat(2);

function chatStub(fact: string) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: [{ fact, kind: 'fact', entity: null, confidence: 1, notability: 'high' }] }),
    blocks: [], stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub', providerId: 'test',
  }));
}

const ctx = (overrides: Partial<FactsBackstopCtx> = {}): FactsBackstopCtx =>
  ({ engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline', ...overrides });

async function validFromOf(ids: number[]): Promise<Date> {
  const rows = await engine.executeRaw<{ valid_from: Date }>('SELECT valid_from FROM facts WHERE id = $1', [ids[0]]);
  return new Date(rows[0].valid_from);
}

describe('backstop valid_from for page-body facts', () => {
  test('a dated page stores its facts at the page date', async () => {
    chatStub('Acme-example renewed its contract');
    const r = await runFactsBackstop({ slug: 'meetings/2019-05-01-acme-example-renewal', type: 'meeting', compiled_truth: BODY, frontmatter: {} }, ctx());
    expect(r.mode === 'inline' && r.inserted).toBe(1);
    const at = await validFromOf(r.mode === 'inline' ? r.fact_ids : []);
    expect(at.toISOString().slice(0, 10)).toBe('2019-05-01');
  });

  test('an undated page leaves the event date unknown', async () => {
    chatStub('Beta-example hired a designer');
    const r = await runFactsBackstop({ slug: 'notes/beta-example-hiring', type: 'note', compiled_truth: BODY, frontmatter: {} }, ctx());
    const rows = await engine.executeRaw<{ valid_from: Date | null }>('SELECT valid_from FROM facts WHERE id = $1', [(r.mode === 'inline' ? r.fact_ids : [])[0]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].valid_from).toBeNull();
  });

  test('a caller validFrom still wins over the page date', async () => {
    chatStub('Gamma-example closed a round');
    const r = await runFactsBackstop({ slug: 'meetings/2019-06-01-gamma-example', type: 'meeting', compiled_truth: BODY, frontmatter: {} },
      ctx({ validFrom: new Date('2020-01-02T00:00:00Z') }));
    const at = await validFromOf(r.mode === 'inline' ? r.fact_ids : []);
    expect(at.toISOString().slice(0, 10)).toBe('2020-01-02');
  });

  test('archive-dated facts rank as old evidence in hot memory', () => {
    const base = { id: 1, fact: 'x', kind: 'event' as const, confidence: 1, expired_at: null, valid_until: null };
    const now = new Date('2026-10-04T00:00:00Z');
    const old = effectiveConfidence({ ...base, valid_from: new Date('2019-05-01T00:00:00Z') } as never, now);
    const fresh = effectiveConfidence({ ...base, valid_from: now } as never, now);
    expect(old).toBeLessThan(0.001);
    expect(fresh).toBe(1);
  });
});
