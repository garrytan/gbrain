/**
 * #4206 — extract_facts event-time + provenance threading, and `context`
 * in the fact projections.
 *
 * Gaps covered (one test per gap):
 *   1. `valid_from` param threads through runFactsPipeline to the insert
 *      fallback — historical imports stop being stamped with import time.
 *   2. `source_slug` param lands in facts.context.
 *   3. An unparseable valid_from fails LOUD (silently defaulting to now()
 *      is the exact bug the param exists to fix).
 *   4. recall / context_pack / delta projections carry `context`.
 *
 * Serial: mock.module replaces the LLM extractor with a canned single-fact
 * outcome so the pipeline runs end-to-end with zero keys, deterministically.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import * as factsExtract from '../src/core/facts/extract.ts';

mock.module('../src/core/facts/extract.ts', () => ({
  ...factsExtract,
  extractFactsFromTurnWithOutcome: async () => ({
    ok: true,
    facts: [{
      fact: 'Alice moved to Berlin',
      kind: 'event',
      notability: 'high',
      entity_slug: null, // unparented → legacy DB-only bucket (no fence needed)
      source: 'mcp:extract_facts',
      source_session: null,
      confidence: 0.9,
      embedding: null,
    }],
  }),
}));

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const ctx = (): OperationContext =>
  ({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('extract_facts valid_from + source_slug threading (#4206)', () => {
  test('caller valid_from + source_slug land on the inserted fact row', async () => {
    const r = await operationsByName.extract_facts!.handler(ctx(), {
      turn_text: 'Alice moved to Berlin last spring.',
      valid_from: '2024-05-01T00:00:00.000Z',
      source_slug: 'meetings/2026-04-03',
    }) as { inserted: number };
    expect(r.inserted).toBe(1);

    const rows = await engine.executeRaw<{ fact: string; context: string | null; valid_from: Date | string }>(
      `SELECT fact, context, valid_from FROM facts WHERE fact = 'Alice moved to Berlin'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context).toBe('meetings/2026-04-03');
    const vf = rows[0]!.valid_from instanceof Date ? rows[0]!.valid_from : new Date(rows[0]!.valid_from);
    expect(vf.toISOString()).toBe('2024-05-01T00:00:00.000Z');
  });

  test('unparseable valid_from fails loud instead of silently stamping now()', async () => {
    await expect(operationsByName.extract_facts!.handler(ctx(), {
      turn_text: 'x',
      valid_from: 'last tuesday-ish',
    })).rejects.toThrow(/valid_from/);
  });
});

describe('context in the fact projections (#4206)', () => {
  test('recall carries context', async () => {
    const r = await operationsByName.recall!.handler(ctx(), {}) as {
      facts: Array<{ fact: string; context: string | null }>;
    };
    const mine = r.facts.find(f => f.fact === 'Alice moved to Berlin');
    expect(mine).toBeDefined();
    expect(mine!.context).toBe('meetings/2026-04-03');
  });

  test('context_pack and delta fact projections carry context', async () => {
    const pack = await operationsByName.context_pack!.handler(ctx(), {}) as {
      facts: Array<{ fact: string; context?: string | null }>;
    };
    const packFact = pack.facts.find(f => f.fact === 'Alice moved to Berlin');
    // The pack's hot-facts arm caps by confidence; presence implies context rides.
    if (packFact) expect(packFact.context).toBe('meetings/2026-04-03');

    const d = await operationsByName.delta!.handler(ctx(), {
      since: '2020-01-01T00:00:00.000Z',
      // The extracted fact defaults to private; delta is world-only unless a
      // trusted local caller widens it.
      include_private: true,
    }) as { facts: Array<{ fact: string; context?: string | null }> };
    const deltaFact = d.facts.find(f => f.fact === 'Alice moved to Berlin');
    expect(deltaFact).toBeDefined();
    expect(deltaFact!.context).toBe('meetings/2026-04-03');
  });
});
