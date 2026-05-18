/**
 * v0.35.4 (D-CDX-4) — consolidate semantic upsert + chronological
 * valid_until writeback.
 *
 * Pins:
 *   - R4a: a cluster of 3 chronologically-ordered facts produces
 *          2 facts with valid_until set (older) and 1 with NULL (newest).
 *   - R4b/R7: running consolidate twice on the same input produces zero
 *          NEW takes (semantic upsert by (page_id, claim, since_date)).
 *          This is the Codex F4 fix — without it, the second cycle's
 *          extract_facts would clear consolidated_at and the second
 *          consolidate would append duplicate takes via MAX(row_num)+1.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';

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
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM takes`);
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'cdx4-%'`);
});

function unitVec(): string {
  const a = new Float32Array(1536);
  a[0] = 1.0;
  return '[' + Array.from(a).join(',') + ']';
}

async function seedPage(slug: string): Promise<number> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title) VALUES ($1, 'company', 'Test') ON CONFLICT DO NOTHING`,
    [slug],
  );
  const r = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return r[0].id;
}

async function insertFact(args: {
  entity_slug: string;
  text: string;
  valid_from: Date;
  confidence?: number;
}): Promise<number> {
  const r = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, confidence, embedding, embedded_at)
     VALUES ('default', $1, $2, 'fact', 'test', $3::timestamptz, $4, $5::vector, $3::timestamptz)
     RETURNING id`,
    [args.entity_slug, args.text, args.valid_from.toISOString(), args.confidence ?? 0.9, unitVec()],
  );
  return r[0].id;
}

describe('R4a — chronological valid_until writeback', () => {
  test('cluster of 3 chronologically-ordered facts: 2 older get valid_until set, newest stays NULL', async () => {
    await seedPage('cdx4-acme-mrr');
    const olderDay = new Date('2026-01-15T00:00:00Z');
    const midDay   = new Date('2026-04-12T00:00:00Z');
    const newest   = new Date('2026-07-08T00:00:00Z');

    // All three close enough in vector space to cluster together (identical
    // embeddings via unitVec()). Past the 24h "oldest age" gate.
    const idOlder = await insertFact({
      entity_slug: 'cdx4-acme-mrr',
      text: 'MRR claim',
      valid_from: olderDay,
    });
    const idMid = await insertFact({
      entity_slug: 'cdx4-acme-mrr',
      text: 'MRR claim',
      valid_from: midDay,
    });
    const idNewest = await insertFact({
      entity_slug: 'cdx4-acme-mrr',
      text: 'MRR claim',
      valid_from: newest,
    });

    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.facts_consolidated).toBe(3);
    expect(r.details.takes_written).toBe(1);

    const rows = await engine.executeRaw<{ id: number; valid_until: Date | null }>(
      `SELECT id, valid_until FROM facts WHERE entity_slug = 'cdx4-acme-mrr' ORDER BY valid_from ASC`,
    );
    expect(rows.length).toBe(3);
    // Older fact's valid_until = mid.valid_from.
    expect(rows[0].id).toBe(idOlder);
    expect(rows[0].valid_until).not.toBeNull();
    expect(new Date(rows[0].valid_until!).toISOString().slice(0, 10)).toBe('2026-04-12');
    // Mid fact's valid_until = newest.valid_from.
    expect(rows[1].id).toBe(idMid);
    expect(rows[1].valid_until).not.toBeNull();
    expect(new Date(rows[1].valid_until!).toISOString().slice(0, 10)).toBe('2026-07-08');
    // Newest fact's valid_until stays NULL.
    expect(rows[2].id).toBe(idNewest);
    expect(rows[2].valid_until).toBeNull();
  });

  test('same-day cluster (3 facts, identical valid_from): id tiebreaker establishes chronological order', async () => {
    await seedPage('cdx4-acme-sameday');
    const sameDay = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const idA = await insertFact({ entity_slug: 'cdx4-acme-sameday', text: 'same day', valid_from: sameDay });
    const idB = await insertFact({ entity_slug: 'cdx4-acme-sameday', text: 'same day', valid_from: sameDay });
    const idC = await insertFact({ entity_slug: 'cdx4-acme-sameday', text: 'same day', valid_from: sameDay });

    await runPhaseConsolidate(engine, {});

    // All three valid_from values are equal; the (id ASC) tiebreaker
    // makes the lowest-id row the "oldest" chronologically. Pin that
    // contract since the trajectory CLI depends on this ordering.
    const rows = await engine.executeRaw<{ id: number; valid_until: Date | null }>(
      `SELECT id, valid_until FROM facts WHERE entity_slug = 'cdx4-acme-sameday' ORDER BY id ASC`,
    );
    expect(rows.length).toBe(3);
    expect(rows[0].id).toBe(idA);
    expect(rows[1].id).toBe(idB);
    expect(rows[2].id).toBe(idC);
    // First two are "older" by tiebreaker → both get valid_until set
    // (= sameDay, since the next-newer fact has the same valid_from).
    expect(rows[0].valid_until).not.toBeNull();
    expect(rows[1].valid_until).not.toBeNull();
    // Newest by tiebreaker stays NULL.
    expect(rows[2].valid_until).toBeNull();
  });
});

describe('R4b / R7 — cycle idempotency: re-run consolidate produces zero new takes (Codex F4 fix)', () => {
  test('semantic upsert: second consolidate on identical state produces zero NEW takes', async () => {
    await seedPage('cdx4-idempo-1');
    const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-idempo-1',
        text: 'stable claim',
        valid_from: new Date(oldDate.getTime() + i * 60 * 60 * 1000),
      });
    }

    // First run: 1 take, 4 facts consolidated.
    const r1 = await runPhaseConsolidate(engine, {});
    expect(r1.details.takes_written).toBe(1);
    const countAfter1 = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM takes WHERE page_id = (SELECT id FROM pages WHERE slug = 'cdx4-idempo-1')`,
    );
    expect(parseInt(countAfter1[0].n, 10)).toBe(1);

    // Simulate the Codex F4 scenario: clear consolidated_at on every fact
    // (extract_facts cycle phase wipes facts via delete-then-insert, which
    // is functionally identical to NULL-ing consolidated_at). DO NOT touch
    // valid_until — the prior consolidate wrote it; the semantic upsert
    // should still find the take.
    await engine.executeRaw(
      `UPDATE facts SET consolidated_at = NULL, consolidated_into = NULL
       WHERE entity_slug = 'cdx4-idempo-1'`,
    );

    // Second run: must NOT append another take.
    const r2 = await runPhaseConsolidate(engine, {});
    expect(r2.details.facts_consolidated).toBe(4);
    // takes_written reports the NEW takes inserted this run; on the upsert
    // hit path it's 0 (no new INSERT) but facts still get marked consolidated.
    expect(r2.details.takes_written).toBe(0);

    const countAfter2 = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM takes WHERE page_id = (SELECT id FROM pages WHERE slug = 'cdx4-idempo-1')`,
    );
    expect(parseInt(countAfter2[0].n, 10)).toBe(1); // STILL 1 — no duplicate

    // Facts were re-consolidated into the existing take.
    const facts = await engine.executeRaw<{ consolidated_into: number }>(
      `SELECT consolidated_into FROM facts WHERE entity_slug = 'cdx4-idempo-1' AND consolidated_into IS NOT NULL`,
    );
    expect(facts.length).toBe(4);
  });

  test('valid_until idempotency: second run leaves valid_until unchanged (no diff)', async () => {
    await seedPage('cdx4-idempo-2');
    const t1 = new Date('2026-01-15T00:00:00Z');
    const t2 = new Date('2026-04-12T00:00:00Z');
    const t3 = new Date('2026-07-08T00:00:00Z');
    await insertFact({ entity_slug: 'cdx4-idempo-2', text: 'iterable', valid_from: t1 });
    await insertFact({ entity_slug: 'cdx4-idempo-2', text: 'iterable', valid_from: t2 });
    await insertFact({ entity_slug: 'cdx4-idempo-2', text: 'iterable', valid_from: t3 });

    await runPhaseConsolidate(engine, {});
    const before = await engine.executeRaw<{ id: number; valid_until: Date | null }>(
      `SELECT id, valid_until FROM facts WHERE entity_slug = 'cdx4-idempo-2' ORDER BY valid_from ASC`,
    );

    // Reset consolidated_at to simulate extract_facts re-run.
    await engine.executeRaw(
      `UPDATE facts SET consolidated_at = NULL, consolidated_into = NULL
       WHERE entity_slug = 'cdx4-idempo-2'`,
    );

    await runPhaseConsolidate(engine, {});
    const after = await engine.executeRaw<{ id: number; valid_until: Date | null }>(
      `SELECT id, valid_until FROM facts WHERE entity_slug = 'cdx4-idempo-2' ORDER BY valid_from ASC`,
    );
    // Same valid_until values; the IS DISTINCT FROM guard avoided rewrites.
    expect(after.length).toBe(3);
    for (let i = 0; i < before.length; i++) {
      expect(after[i].id).toBe(before[i].id);
      const a = after[i].valid_until ? new Date(after[i].valid_until!).toISOString() : null;
      const b = before[i].valid_until ? new Date(before[i].valid_until!).toISOString() : null;
      expect(a).toBe(b);
    }
  });
});
