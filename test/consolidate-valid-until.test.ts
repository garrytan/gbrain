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
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  // v0.36.2.0: DEFAULT_EMBEDDING_DIMENSIONS flipped to 1280 (ZE Matryoshka).
  // This test inserts 1536-dim unit vectors (line ~38). If another test file
  // in the shard configured the gateway before us, initSchema() would size
  // facts.embedding at vector(1280) and the inserts below would throw
  // "expected 1280 dimensions, not 1536". Pin the gateway to 1536d so this
  // file is hermetic against cross-file state.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM takes`);
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'cdx4-%'`);
});

async function takeIdFor(slug: string): Promise<number> {
  const r = await engine.executeRaw<{ id: number }>(
    `SELECT t.id FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 ORDER BY t.id LIMIT 1`,
    [slug],
  );
  return r[0].id;
}

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

describe('#4057 — consolidation work-window eligibility', () => {
  test('#4057: consolidated rows cannot hide older unconsolidated facts beyond the 100-row window', async () => {
    const slug = 'cdx4-over-100-active';
    const pageId = await seedPage(slug);
    const oldDate = new Date('2025-01-01T00:00:00Z');
    const recentDate = new Date('2026-01-01T00:00:00Z');

    for (let i = 0; i < 100; i++) {
      await insertFact({
        entity_slug: slug,
        text: 'already consolidated claim',
        valid_from: new Date(recentDate.getTime() + i * 60_000),
      });
    }
    const take = await engine.executeRaw<{ id: number }>(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder)
       VALUES ($1, 1, 'already consolidated claim', 'fact', 'self')
       RETURNING id`,
      [pageId],
    );
    await engine.executeRaw(
      `UPDATE facts
          SET consolidated_at = now(), consolidated_into = $1
        WHERE entity_slug = $2`,
      [take[0].id, slug],
    );

    for (let i = 0; i < 3; i++) {
      await insertFact({
        entity_slug: slug,
        text: 'still pending claim',
        valid_from: new Date(oldDate.getTime() + i * 60_000),
      });
    }

    const result = await runPhaseConsolidate(engine, {});

    expect(result.details.facts_consolidated).toBe(3);
    const pending = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM facts
        WHERE entity_slug = $1
          AND expired_at IS NULL
          AND consolidated_at IS NULL`,
      [slug],
    );
    expect(Number(pending[0].count)).toBe(0);
  });
});

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
    // WP5 read-time TTL validity: the chronological valid_until writeback
    // closes older facts at the NEXT fact's valid_from. If every valid_from
    // were in the past, run 1's closes would validity-lapse the older rows
    // and the second consolidate's active read (listFactsByEntity) would no
    // longer see them — skipping the bucket instead of exercising the F4
    // semantic-upsert path this test pins. Keep the oldest fact 30h old
    // (satisfies the age gate) and the rest in the FUTURE so run 1's closes
    // stay validity-live across the re-run.
    const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-idempo-1',
        text: 'stable claim',
        valid_from: i === 0 ? oldDate : new Date(Date.now() + i * 60 * 60 * 1000),
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

  test('identical claim text on TWO pages consolidates into two page-scoped takes (never cross-page merged)', async () => {
    // The take identity is (page_id, claim) scoped to this phase's rows. Two
    // entities that happen to carry the same wording must each get their own
    // take — a claim-only lookup would attach page B's facts to page A's take.
    await seedPage('cdx4-shared-a');
    await seedPage('cdx4-shared-b');
    const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000);
    for (const slug of ['cdx4-shared-a', 'cdx4-shared-b']) {
      for (let i = 0; i < 3; i++) {
        await insertFact({
          entity_slug: slug,
          text: 'ships a weekly release',
          valid_from: new Date(oldDate.getTime() + i * 60 * 60 * 1000),
        });
      }
    }

    const r1 = await runPhaseConsolidate(engine, {});
    expect(r1.details.takes_written).toBe(2);
    expect(r1.details.facts_consolidated).toBe(6);

    const takes = await engine.executeRaw<{ page_id: number; slug: string; claim: string }>(
      `SELECT t.page_id, p.slug, t.claim FROM takes t JOIN pages p ON p.id = t.page_id
       WHERE t.claim = 'ships a weekly release' ORDER BY p.slug`,
    );
    expect(takes).toHaveLength(2);
    expect(takes.map(t => t.slug)).toEqual(['cdx4-shared-a', 'cdx4-shared-b']);
    expect(new Set(takes.map(t => t.page_id)).size).toBe(2);

    // Each page's facts point at ITS OWN take, never the sibling page's.
    for (const t of takes) {
      const facts = await engine.executeRaw<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM facts WHERE entity_slug = $1 AND consolidated_into = $2`,
        [t.slug, await takeIdFor(t.slug)],
      );
      expect(parseInt(facts[0].n, 10)).toBe(3);
    }

    // Re-run after an extract_facts-style reset: still two, zero new.
    await engine.executeRaw(
      `UPDATE facts SET consolidated_at = NULL, consolidated_into = NULL
       WHERE entity_slug IN ('cdx4-shared-a', 'cdx4-shared-b')`,
    );
    const r2 = await runPhaseConsolidate(engine, {});
    expect(r2.details.takes_written).toBe(0);
    const after = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM takes WHERE claim = 'ships a weekly release'`,
    );
    expect(parseInt(after[0].n, 10)).toBe(2);
  });

  test('semantic upsert: a re-extracted claim with a newer valid_from reuses the take', async () => {
    await seedPage('cdx4-idempo-3');
    const day1 = new Date(Date.now() - 72 * 60 * 60 * 1000);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-idempo-3',
        text: 'stable claim',
        valid_from: new Date(day1.getTime() + i * 60 * 60 * 1000),
      });
    }

    const r1 = await runPhaseConsolidate(engine, {});
    expect(r1.details.takes_written).toBe(1);
    const firstTake = await engine.executeRaw<{ id: number; since_date: string }>(
      `SELECT id, since_date::text FROM takes WHERE page_id = (SELECT id FROM pages WHERE slug = 'cdx4-idempo-3')`,
    );
    expect(firstTake.length).toBe(1);

    // Simulate the next cycle's extract_facts: it hard-deletes and re-inserts
    // the page's facts. The claim text is unchanged, but the new rows carry a
    // fresh valid_from (an LLM extraction that defaults valid_from to now()),
    // so MIN(valid_from) — and therefore since_date — lands on a later day.
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug = 'cdx4-idempo-3'`);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-idempo-3',
        text: 'stable claim',
        valid_from: new Date(day1.getTime() + 24 * 60 * 60 * 1000 + i * 60 * 60 * 1000),
      });
    }

    const r2 = await runPhaseConsolidate(engine, {});
    expect(r2.details.facts_consolidated).toBe(4);
    expect(r2.details.takes_written).toBe(0);

    const countAfter2 = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM takes WHERE page_id = (SELECT id FROM pages WHERE slug = 'cdx4-idempo-3')`,
    );
    expect(parseInt(countAfter2[0].n, 10)).toBe(1); // STILL 1 — no duplicate

    // The take keeps its identity: same row, same since_date as first promotion.
    const afterTake = await engine.executeRaw<{ id: number; since_date: string }>(
      `SELECT id, since_date::text FROM takes WHERE page_id = (SELECT id FROM pages WHERE slug = 'cdx4-idempo-3')`,
    );
    expect(afterTake[0]).toEqual(firstTake[0]);
  });

  test('semantic upsert: a human-authored take with the same claim is not hijacked', async () => {
    const pageId = await seedPage('cdx4-foreign');
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, source, active)
       VALUES ($1, 1, 'shared claim', 'bet', 'garry', 'human:garry', TRUE)`,
      [pageId],
    );
    const day1 = new Date(Date.now() - 72 * 60 * 60 * 1000);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-foreign',
        text: 'shared claim',
        valid_from: new Date(day1.getTime() + i * 60 * 60 * 1000),
      });
    }

    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.takes_written).toBe(1);

    const rows = await engine.executeRaw<{ id: number; kind: string; holder: string; source: string }>(
      `SELECT id, kind, holder, source FROM takes WHERE page_id = $1 ORDER BY id`,
      [pageId],
    );
    // The bet keeps its provenance; consolidate appends its own take instead
    // of adopting a row it did not author.
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ kind: 'bet', holder: 'garry', source: 'human:garry' });
    expect(rows[1]).toMatchObject({ kind: 'fact', holder: 'self' });
  });

  test('semantic upsert: a superseded take is not resurrected as a new active row', async () => {
    const pageId = await seedPage('cdx4-supersede');
    const day1 = new Date(Date.now() - 96 * 60 * 60 * 1000);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-supersede',
        text: 'retired claim',
        valid_from: new Date(day1.getTime() + i * 60 * 60 * 1000),
      });
    }
    await runPhaseConsolidate(engine, {});

    // The user retires the take.
    await engine.executeRaw(
      `UPDATE takes SET active = FALSE, superseded_by = 999 WHERE page_id = $1`,
      [pageId],
    );

    // Next cycle re-extracts the same claim with a fresher valid_from.
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug = 'cdx4-supersede'`);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-supersede',
        text: 'retired claim',
        valid_from: new Date(day1.getTime() + 24 * 60 * 60 * 1000 + i * 60 * 60 * 1000),
      });
    }

    const r2 = await runPhaseConsolidate(engine, {});
    expect(r2.details.takes_written).toBe(0);

    const rows = await engine.executeRaw<{ active: boolean; claim: string }>(
      `SELECT active, claim FROM takes WHERE page_id = $1`,
      [pageId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].active).toBe(false); // retirement survives the dream cycle
  });

  test('semantic upsert: a resolved take is reused but never mutated', async () => {
    const pageId = await seedPage('cdx4-resolved');
    const day1 = new Date(Date.now() - 96 * 60 * 60 * 1000);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-resolved',
        text: 'resolved claim',
        valid_from: new Date(day1.getTime() + i * 60 * 60 * 1000),
      });
    }
    await runPhaseConsolidate(engine, {});
    await engine.executeRaw(
      `UPDATE takes SET resolved_at = now(), source = 'frozen' WHERE page_id = $1`,
      [pageId],
    );
    const before = await engine.executeRaw<{ id: number; source: string; updated_at: Date }>(
      `SELECT id, source, updated_at FROM takes WHERE page_id = $1`,
      [pageId],
    );

    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug = 'cdx4-resolved'`);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-resolved',
        text: 'resolved claim',
        valid_from: new Date(day1.getTime() + 24 * 60 * 60 * 1000 + i * 60 * 60 * 1000),
      });
    }
    const r2 = await runPhaseConsolidate(engine, {});
    expect(r2.details.takes_written).toBe(0);

    const after = await engine.executeRaw<{ id: number; source: string; updated_at: Date }>(
      `SELECT id, source, updated_at FROM takes WHERE page_id = $1`,
      [pageId],
    );
    expect(after.length).toBe(1);
    expect(after[0].source).toBe(before[0].source);
    expect(new Date(after[0].updated_at).getTime()).toBe(new Date(before[0].updated_at).getTime());

    // Facts still consolidate into it — reuse without mutation.
    const facts = await engine.executeRaw<{ consolidated_into: number }>(
      `SELECT consolidated_into FROM facts WHERE entity_slug = 'cdx4-resolved' AND consolidated_into IS NOT NULL`,
    );
    expect(facts.length).toBe(4);
    expect(facts[0].consolidated_into).toBe(before[0].id);
  });

  test('upgrade shape: pre-fix (page_id, claim, since_date) duplicates reconcile into the lowest-id row instead of minting a third', async () => {
    // Brains that ran the pre-fix lookup already hold duplicate takes for the
    // same claim — one per since_date the old key minted. The widened
    // (page_id, claim, kind, holder) lookup with ORDER BY id must
    // deterministically reuse the OLDEST row and never insert another.
    const pageId = await seedPage('cdx4-upgrade');
    const dupA = await engine.executeRaw<{ id: number }>(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, source, since_date, active)
       VALUES ($1, 1, 'legacy claim', 'fact', 'self', 'test', '2026-08-01', TRUE)
       RETURNING id`,
      [pageId],
    );
    const dupB = await engine.executeRaw<{ id: number }>(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, source, since_date, active)
       VALUES ($1, 2, 'legacy claim', 'fact', 'self', 'test', '2026-08-02', TRUE)
       RETURNING id`,
      [pageId],
    );
    expect(dupB[0].id).toBeGreaterThan(dupA[0].id);

    // The next cycle re-extracts the same claim with yet another valid_from
    // (a THIRD since_date — the old lookup would have minted a third take).
    const day3 = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (let i = 0; i < 4; i++) {
      await insertFact({
        entity_slug: 'cdx4-upgrade',
        text: 'legacy claim',
        valid_from: new Date(day3.getTime() + i * 60 * 60 * 1000),
      });
    }

    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.takes_written).toBe(0); // reconciled, not duplicated
    expect(r.details.facts_consolidated).toBe(4);

    const count = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM takes WHERE page_id = $1`,
      [pageId],
    );
    expect(parseInt(count[0].n, 10)).toBe(2); // still the two legacy rows

    // Deterministic choice: facts landed in the LOWEST-id duplicate.
    const facts = await engine.executeRaw<{ consolidated_into: number }>(
      `SELECT consolidated_into FROM facts WHERE entity_slug = 'cdx4-upgrade' AND consolidated_into IS NOT NULL`,
    );
    expect(facts.length).toBe(4);
    for (const f of facts) expect(f.consolidated_into).toBe(dupA[0].id);
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
