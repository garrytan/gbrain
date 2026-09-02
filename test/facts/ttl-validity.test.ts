/**
 * WP5 — TTL honesty via READ-TIME validity filtering (outside-voice A10).
 *
 * Active fact reads exclude validity-lapsed rows (`valid_until <= now()`,
 * `expired_at IS NULL`) at query time — exact-time, zero-maintenance, no
 * sweep mutation. History readers (activeOnly:false, listSupersessions)
 * still see lapsed rows: `valid_until` is TEMPORAL VALIDITY, not retention.
 *
 * PGLite in-memory, keyless. The Postgres half of the same behavior is
 * pinned by test/e2e/engine-parity.test.ts (DATABASE_URL-gated).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

const SOURCE = 'default';
const HOUR = 60 * 60 * 1000;
const past = () => new Date(Date.now() - HOUR);
const future = () => new Date(Date.now() + 24 * HOUR);

afterAll(async () => {
  await engine.disconnect();
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

describe('WP5 read-time TTL validity — active reads', () => {
  const entity = 'people/ttl-alice-example';
  const session = 'ttl-session-1';
  let lapsedId: number;
  let futureId: number;
  let openId: number;

  beforeAll(async () => {
    const lapsed = await engine.insertFact(
      {
        fact: 'alice-example has a mild cough today',
        kind: 'fact',
        entity_slug: entity,
        source: 'test',
        source_session: session,
        valid_until: past(),
      },
      { source_id: SOURCE },
    );
    lapsedId = lapsed.id;
    const fut = await engine.insertFact(
      {
        fact: 'alice-example is traveling this week',
        kind: 'fact',
        entity_slug: entity,
        source: 'test',
        source_session: session,
        valid_until: future(),
      },
      { source_id: SOURCE },
    );
    futureId = fut.id;
    const open = await engine.insertFact(
      {
        fact: 'alice-example prefers dark mode',
        kind: 'preference',
        entity_slug: entity,
        source: 'test',
        source_session: session,
        // valid_until omitted → NULL (durable)
      },
      { source_id: SOURCE },
    );
    openId = open.id;
  });

  test('listFactsByEntity excludes backdated valid_until; includes future + NULL', async () => {
    const rows = await engine.listFactsByEntity(SOURCE, entity);
    const ids = rows.map(r => r.id);
    expect(ids).not.toContain(lapsedId);
    expect(ids).toContain(futureId);
    expect(ids).toContain(openId);
  });

  test('listFactsSince excludes backdated valid_until; includes future + NULL', async () => {
    const since = new Date(Date.now() - 24 * HOUR);
    const rows = await engine.listFactsSince(SOURCE, since, { entitySlug: entity });
    const ids = rows.map(r => r.id);
    expect(ids).not.toContain(lapsedId);
    expect(ids).toContain(futureId);
    expect(ids).toContain(openId);
  });

  test('listFactsBySession excludes backdated valid_until; includes future + NULL', async () => {
    const rows = await engine.listFactsBySession(SOURCE, session);
    const ids = rows.map(r => r.id);
    expect(ids).not.toContain(lapsedId);
    expect(ids).toContain(futureId);
    expect(ids).toContain(openId);
  });

  test('findCandidateDuplicates (recency branch) excludes lapsed rows', async () => {
    const candidates = await engine.findCandidateDuplicates(
      SOURCE, entity, 'alice-example has a mild cough today',
    );
    const ids = candidates.map(r => r.id);
    expect(ids).not.toContain(lapsedId);
    expect(ids).toContain(futureId);
    expect(ids).toContain(openId);
  });

  test('findCandidateDuplicates (embedding branch) excludes lapsed rows', async () => {
    const emb = new Float32Array(1536);
    emb[7] = 1.0;
    const embEntity = 'people/ttl-embed-example';
    const lapsedEmb = await engine.insertFact(
      {
        fact: 'embed lapsed fact', kind: 'fact', entity_slug: embEntity,
        source: 'test', valid_until: past(), embedding: emb,
      },
      { source_id: SOURCE },
    );
    const liveEmb = await engine.insertFact(
      {
        fact: 'embed live fact', kind: 'fact', entity_slug: embEntity,
        source: 'test', embedding: emb,
      },
      { source_id: SOURCE },
    );
    const candidates = await engine.findCandidateDuplicates(
      SOURCE, embEntity, 'embed lapsed fact', { embedding: emb },
    );
    const ids = candidates.map(r => r.id);
    expect(ids).not.toContain(lapsedEmb.id);
    expect(ids).toContain(liveEmb.id);
  });

  test('activeOnly:false (history read) still returns the lapsed row', async () => {
    const rows = await engine.listFactsByEntity(SOURCE, entity, { activeOnly: false });
    const ids = rows.map(r => r.id);
    expect(ids).toContain(lapsedId);
    expect(ids).toContain(futureId);
    expect(ids).toContain(openId);
  });

  test('re-stated identical fact after expiry inserts fresh (no candidate → inserted)', async () => {
    const restateEntity = 'people/ttl-restate-example';
    const text = 'charlie-example has a mild cough today';
    const first = await engine.insertFact(
      { fact: text, kind: 'fact', entity_slug: restateEntity, source: 'test', valid_until: past() },
      { source_id: SOURCE },
    );
    // The dedup gate consults findCandidateDuplicates; the lapsed row must
    // NOT surface as a candidate, so the caller re-inserts fresh.
    const candidates = await engine.findCandidateDuplicates(SOURCE, restateEntity, text);
    expect(candidates.map(r => r.id)).not.toContain(first.id);
    const second = await engine.insertFact(
      { fact: text, kind: 'fact', entity_slug: restateEntity, source: 'test' },
      { source_id: SOURCE },
    );
    expect(second.status).toBe('inserted');
    expect(second.id).not.toBe(first.id);
    // Fresh row is active; the lapsed original stays out of active reads.
    const active = await engine.listFactsByEntity(SOURCE, restateEntity);
    expect(active.map(r => r.id)).toContain(second.id);
    expect(active.map(r => r.id)).not.toContain(first.id);
  });
});

describe('WP5 read-time TTL validity — history + health surfaces', () => {
  test('listSupersessions still shows a valid_until-closed superseded row', async () => {
    const entity = 'people/ttl-supersede-example';
    const oldRow = await engine.insertFact(
      { fact: 'acme-example MRR is 10k', kind: 'fact', entity_slug: entity, source: 'test' },
      { source_id: SOURCE },
    );
    const newRow = await engine.insertFact(
      { fact: 'acme-example MRR is 20k', kind: 'fact', entity_slug: entity, source: 'test' },
      { source_id: SOURCE },
    );
    // Ontology-writer style close: valid_until (lapsed) + superseded_by,
    // expired_at stays NULL so --asof time-travel keeps working.
    await engine.executeRaw(
      `UPDATE facts SET valid_until = now() - interval '1 hour', superseded_by = $1 WHERE id = $2`,
      [newRow.id, oldRow.id],
    );
    const supersessions = await engine.listSupersessions(SOURCE);
    expect(supersessions.map(r => r.id)).toContain(oldRow.id);
    // ...while active reads exclude the lapsed old row.
    const active = await engine.listFactsByEntity(SOURCE, entity);
    expect(active.map(r => r.id)).not.toContain(oldRow.id);
    expect(active.map(r => r.id)).toContain(newRow.id);
  });

  test('getFactsHealth: lapsed rows leave the active bucket and count as expired-style', async () => {
    const src = 'ttl-health';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [src],
    );
    await engine.insertFact(
      { fact: 'health lapsed', kind: 'fact', entity_slug: 'people/h-example', source: 'test', valid_until: past() },
      { source_id: src },
    );
    await engine.insertFact(
      { fact: 'health live', kind: 'fact', entity_slug: 'people/h-example', source: 'test' },
      { source_id: src },
    );
    const h = await engine.getFactsHealth(src);
    expect(h.total_active).toBe(1);
    expect(h.total_expired).toBe(1);
    // active + expired still partition the table exactly.
    expect(h.total_active + h.total_expired).toBe(2);
    // top_entities counts only validity-live active rows.
    const top = h.top_entities.find(t => t.entity_slug === 'people/h-example');
    expect(top?.count).toBe(1);
  });

  test('countUnconsolidatedFacts excludes lapsed rows (backlog matches what the consolidator can read)', async () => {
    const src = 'ttl-backlog';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [src],
    );
    await engine.insertFact(
      { fact: 'backlog lapsed', kind: 'fact', entity_slug: 'people/b-example', source: 'test', valid_until: past() },
      { source_id: src },
    );
    await engine.insertFact(
      { fact: 'backlog live', kind: 'fact', entity_slug: 'people/b-example', source: 'test' },
      { source_id: src },
    );
    expect(await engine.countUnconsolidatedFacts(src)).toBe(1);
  });
});
