/**
 * v0.31 Phase 6 — facts engine round-trip tests on PGLite (in-memory, no
 * DATABASE_URL required).
 *
 * Pins every BrainEngine facts method end-to-end:
 *   - insertFact (insert, supersede)
 *   - expireFact (idempotent-as-false)
 *   - listFactsByEntity / Since / Session / Supersessions
 *   - findCandidateDuplicates (entity-prefiltered, k cap, cosine ordering)
 *   - consolidateFact
 *   - getFactsHealth
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const vec = (...vals: number[]): Float32Array => {
  const a = new Float32Array(1536);
  for (let i = 0; i < vals.length; i++) a[i] = vals[i];
  return a;
};

describe('insertFact + listFactsByEntity', () => {
  test('inserts a fact and reads it back', async () => {
    const r = await engine.insertFact(
      { fact: 'alice example fact', kind: 'fact', entity_slug: 'people/alice-example', source: 'test' },
      { source_id: 'default' },
    );
    expect(r.id).toBeGreaterThan(0);
    expect(r.status).toBe('inserted');
    const rows = await engine.listFactsByEntity('default', 'people/alice-example');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const ours = rows.find(x => x.id === r.id);
    expect(ours).toBeDefined();
    expect(ours!.fact).toBe('alice example fact');
    expect(ours!.kind).toBe('fact');
    expect(ours!.visibility).toBe('private');
    // v0.31.2: row mapper exposes notability; default 'medium' when caller omits.
    expect(ours!.notability).toBe('medium');
    expect(ours!.confidence).toBe(1.0);
  });

  test('respects kind CHECK', async () => {
    const r = await engine.insertFact(
      { fact: 'durable', kind: 'preference', entity_slug: 'alice-test', source: 'test' },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsByEntity('default', 'alice-test');
    const ours = rows.find(x => x.id === r.id);
    expect(ours?.kind).toBe('preference');
  });

  test('v0.31.2: notability round-trips for each tier (PR1 commit 4 contract pin)', async () => {
    const tiers: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
    for (const tier of tiers) {
      const r = await engine.insertFact(
        {
          fact: `notability ${tier} test`,
          kind: 'fact',
          entity_slug: `notability-${tier}-pin`,
          source: 'test',
          notability: tier,
        },
        { source_id: 'default' },
      );
      const rows = await engine.listFactsByEntity('default', `notability-${tier}-pin`);
      const ours = rows.find(x => x.id === r.id);
      expect(ours).toBeDefined();
      // The row mapper MUST expose notability; without this assertion, the
      // codex P1 #4 regression (FactRow drops the column) reappears silently.
      expect(ours!.notability).toBe(tier);
    }
  });

  test('supersede path: superseding row marks old as expired_at + superseded_by', async () => {
    const old = await engine.insertFact(
      { fact: 'old fact', kind: 'fact', entity_slug: 'super-test', source: 'test' },
      { source_id: 'default' },
    );
    const newer = await engine.insertFact(
      { fact: 'new fact', kind: 'fact', entity_slug: 'super-test', source: 'test' },
      { source_id: 'default', supersedeId: old.id },
    );
    expect(newer.status).toBe('superseded');
    expect(newer.id).toBeGreaterThan(old.id);

    const supersessions = await engine.listSupersessions('default');
    const oldRow = supersessions.find(r => r.id === old.id);
    expect(oldRow).toBeDefined();
    expect(oldRow!.expired_at).not.toBeNull();
    expect(oldRow!.superseded_by).toBe(newer.id);
  });
});

describe('expireFact', () => {
  test('returns true on first call, false on idempotent re-call', async () => {
    const r = await engine.insertFact(
      { fact: 'will expire', kind: 'fact', source: 'test' },
      { source_id: 'default' },
    );
    expect(await engine.expireFact(r.id)).toBe(true);
    expect(await engine.expireFact(r.id)).toBe(false);
  });

  test('returns false on unknown id', async () => {
    expect(await engine.expireFact(99999999)).toBe(false);
  });
});

describe('listFactsSince + listFactsBySession', () => {
  test('listFactsSince filters by created_at', async () => {
    const before = new Date();
    await engine.insertFact(
      { fact: 'recent', kind: 'fact', source: 'test', source_session: 'topic-since' },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsSince('default', before);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every(r => r.created_at.getTime() >= before.getTime())).toBe(true);
  });

  test('listFactsBySession filters by source_session', async () => {
    await engine.insertFact(
      { fact: 'topic-A note', kind: 'fact', source: 'test', source_session: 'topic-A' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'topic-B note', kind: 'fact', source: 'test', source_session: 'topic-B' },
      { source_id: 'default' },
    );
    const a = await engine.listFactsBySession('default', 'topic-A');
    const b = await engine.listFactsBySession('default', 'topic-B');
    expect(a.every(r => r.source_session === 'topic-A')).toBe(true);
    expect(b.every(r => r.source_session === 'topic-B')).toBe(true);
    expect(a.find(r => r.source_session === 'topic-B')).toBeUndefined();
  });
});

describe('findCandidateDuplicates', () => {
  test('entity-prefiltered: rows from other entities never returned', async () => {
    await engine.insertFact(
      { fact: 'alice fact', kind: 'fact', entity_slug: 'cand-alice', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'tim fact', kind: 'fact', entity_slug: 'cand-tim', source: 'test' },
      { source_id: 'default' },
    );
    const candidates = await engine.findCandidateDuplicates('default', 'cand-alice', 'alice fact');
    expect(candidates.every(c => c.entity_slug === 'cand-alice')).toBe(true);
    expect(candidates.find(c => c.entity_slug === 'cand-tim')).toBeUndefined();
  });

  test('k cap honored', async () => {
    for (let i = 0; i < 7; i++) {
      await engine.insertFact(
        { fact: `cap-test ${i}`, kind: 'fact', entity_slug: 'cap-entity', source: 'test' },
        { source_id: 'default' },
      );
    }
    const result = await engine.findCandidateDuplicates('default', 'cap-entity', 'x', { k: 3 });
    expect(result.length).toBe(3);
  });

  test('embedding cosine ordering when both sides have embeddings', async () => {
    await engine.insertFact(
      { fact: 'A', kind: 'fact', entity_slug: 'embed-test', source: 'test', embedding: vec(1, 0, 0) },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'B', kind: 'fact', entity_slug: 'embed-test', source: 'test', embedding: vec(0, 1, 0) },
      { source_id: 'default' },
    );
    const result = await engine.findCandidateDuplicates(
      'default', 'embed-test', 'q',
      { embedding: vec(1, 0, 0) },
    );
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Closest by cosine should come first.
    expect(result[0].fact).toBe('A');
  });
});

describe('consolidateFact', () => {
  test('marks consolidated_at + consolidated_into; never DELETE', async () => {
    // Need a take to point at — seed a page + take.
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title) VALUES ('cons-test', 'concept', 'Cons Test') ON CONFLICT DO NOTHING`,
    );
    const pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'cons-test' AND source_id = 'default'`,
    );
    const pageId = pageRows[0].id;
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 99, 'cons claim', 'fact', 'self') ON CONFLICT DO NOTHING`,
      [pageId],
    );
    const takeRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM takes WHERE page_id = $1 AND row_num = 99`,
      [pageId],
    );
    const takeId = takeRows[0].id;

    const fact = await engine.insertFact(
      { fact: 'will be consolidated', kind: 'fact', entity_slug: 'cons-test', source: 'test' },
      { source_id: 'default' },
    );

    await engine.consolidateFact(fact.id, takeId);
    const rows = await engine.executeRaw<{ id: number; consolidated_at: Date | null; consolidated_into: number | null }>(
      `SELECT id, consolidated_at, consolidated_into FROM facts WHERE id = $1`,
      [fact.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].consolidated_at).not.toBeNull();
    expect(Number(rows[0].consolidated_into)).toBe(takeId);
  });
});

describe('getFactsHealth', () => {
  test('returns counters keyed by source_id', async () => {
    const health = await engine.getFactsHealth('default');
    expect(health.source_id).toBe('default');
    expect(health.total_active).toBeGreaterThanOrEqual(0);
    expect(health.total_today).toBeGreaterThanOrEqual(0);
    expect(health.total_week).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(health.top_entities)).toBe(true);
  });

  test('total_today subset of total_week subset of total_active+expired', async () => {
    const health = await engine.getFactsHealth('default');
    expect(health.total_today).toBeLessThanOrEqual(health.total_week);
    expect(health.total_active + health.total_expired).toBeGreaterThanOrEqual(health.total_week);
  });
});
