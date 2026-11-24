/**
 * Before/after parity for the reads that moved behind BrainEngine members in the S2b-ns move
 * (src/core/engine-sql/timeline-reads.ts, write-misc.ts and open-loops.ts, from their call sites at 33433faa84).
 *
 * Each case runs master's exact statement text (copied below, with the file and line it had) through `executeRaw` and the
 * new member on the same brain, over the same rows, and requires the same answer. Where a statement kept its text, a
 * second block compares the text the Postgres engine sends with master's text, byte for byte.
 *
 * 1. Protects: hasExtractedEvents (chronicle/ledger.ts), readMaxTimelineEntryId (doctor timeline_history),
 *    hasNotifierCoverage (notifier/status.ts), storedTimelineRowsByPageIds, countSegmentedTimelinePages and
 *    countTimelineCommentMarkupRows (repair/timeline.ts) answer what the statement they replaced answered, on rows that
 *    sit on each side of every predicate (state, event rows, soft-deleted pages, other sources, segmented or not).
 *    listOpenLoops and readEntityOpenLoops (no caller moved yet) answer what loops-store.ts and entity-card.ts asked.
 * 2. Fails when: a member drops or adds a predicate, changes a join, a cast, a limit or a column; sends text other than
 *    master's (Postgres text block); or a member's answer type differs from what the caller read before.
 * 3. Existing coverage: test/engine-parity/timeline-reads.test.ts and open-loops.test.ts compare the engines with each
 *    other through the typed members; neither compares a member with the statement master ran, and a Rust engine has no
 *    raw SQL to run master's text. write-misc-sql-pin.test.ts checks fragments of the text, not the rows.
 * 4. Seam: none. Real engines, the typed members as the "after", `executeRaw` with master's text as the "before".
 *    Rust: listOpenLoops and readEntityOpenLoops are the members Rust serves among these; with
 *    GBRAIN_TEST_RUST_ARM=1 the Rust members are compared with master's text run on a PGLite brain holding the same
 *    loops. The other members are `raw_sql` on Rust and refuse `engine_capability_missing`, so no Rust row is compared.
 *    `open_loops` has no visibility column and master's two loop reads carry no privacy filter (entity-card.ts skips the
 *    read for a world-only caller in JavaScript, `remote ? [] : ...`, a line this move does not touch), so there is no
 *    private row to add; the source-scoped counterparty rows below are the only filter the statements have.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MUTE_RECHECK, MUTED, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';
import { ADMISSION_SOURCE_SQL as MASTER_ADMISSION_SQL } from '../src/core/persistence/preadmit-cache.ts';
import { ADMISSION_SOURCE_SQL as MEMBER_ADMISSION_SQL } from '../src/core/engine-sql/write-misc.ts';
import { GUEST_SOURCES_HIDDEN_SQL } from '../src/core/guests/note.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { pageMeta } from './helpers/page-body-fixtures.ts';
import { testBackends } from './helpers/test-backends.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';
import { createSource, resetArm, type ParityArm } from './engine-parity/harness.ts';
import { openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';

// ---------------------------------------------------------------- master's statements, verbatim from 33433faa84

/** src/core/chronicle/ledger.ts:158 (hasExtractedEvents). */
const MASTER_HAS_EXTRACTED = "SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND state='extracted' AND cardinality(event_hashes) > 0 LIMIT 1";
/** src/commands/doctor/checks/timeline-history.ts:75. */
const MASTER_MAX_ENTRY = 'SELECT COALESCE(max(id), 0) AS max_entry FROM timeline_entries';
/** src/core/notifier/status.ts:110 (freshnessReported). */
const MASTER_NOTIFIER_COVERED = 'SELECT EXISTS (SELECT 1 FROM sync_notifier_sources WHERE observed_at IS NOT NULL) AS covered';
/** src/core/repair/timeline.ts:37 (storedRowsByPage). */
const MASTER_STORED_BY_PAGES = `SELECT t.page_id, t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail
    FROM timeline_entries t WHERE t.page_id = ANY($1::bigint[]) AND t.event_page_id IS NULL`;
/** src/core/repair/timeline.ts:106 (segmentedTimelinePages, the count). */
const MASTER_SEGMENTED_COUNT = `SELECT count(DISTINCT p.id)::int AS pages, count(*)::int AS rows
    FROM timeline_entries t JOIN pages p ON p.id=t.page_id
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.body_storage='segmented' AND t.event_page_id IS NULL`;
/** src/core/repair/timeline.ts:110 (segmentedTimelinePages, the sample); `LIMIT ${SEGMENTED_SAMPLE}` with SEGMENTED_SAMPLE = 10. */
const MASTER_SEGMENTED_SAMPLE = `SELECT p.source_id, p.slug FROM pages p
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.body_storage='segmented'
      AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id=p.id AND t.event_page_id IS NULL)
    ORDER BY p.id LIMIT 10`;
const MASTER_SAMPLE_LIMIT = 10;
/** src/core/repair/timeline.ts:130 (timelineRepair.preview, the comment-markup count). */
const MASTER_MARKUP_COUNT = `SELECT count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id
      WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND t.event_page_id IS NULL
        AND (t.summary LIKE '%<!--%' OR t.summary LIKE '%-->%' OR t.source LIKE '%<!--%' OR t.source LIKE '%-->%')`;
/** src/core/timeline-extract.ts:553 (pruneTimelineOrphans), with and without the source filter; master numbered `$3` for the source and `$2` for the limit. */
const MASTER_ORPHANS = (withSource: boolean) => `SELECT p.id, p.slug, p.source_id, p.compiled_truth, p.timeline, p.body_storage, p.knowledge_revision::text AS revision FROM pages p
        WHERE p.id > $1 AND p.deleted_at IS NULL${withSource ? ' AND p.source_id = $3' : ''}
          AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id AND t.event_page_id IS NULL)
        ORDER BY p.id LIMIT $2`;
/** The source-state read master's callers sent (admission.ts:153, connector-sync.ts:304). */
const MASTER_SOURCE_STATE = 'SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1';
/** src/core/loops/loops-store.ts:127 (upsertOpenLoop), with `${MUTE_RECHECK}` and `${MUTED}` interpolated as master did. */
const MASTER_UPSERT_LOOP = `INSERT INTO open_loops (
       source_id, dedup_key, loop_type, counterparty_slug, counterparty_email,
       summary, evidence, thread_id, page_slug, due_at, detector, confidence,
       fact_id, last_activity_at, opened_at, counterparty_source_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10::timestamptz, $11, $12,
       $13, COALESCE($14::timestamptz, now()), COALESCE($15::timestamptz, now()), $16
     )
     ON CONFLICT (source_id, dedup_key) DO UPDATE SET
       opened_at = CASE WHEN open_loops.status = 'open'
                        THEN LEAST(open_loops.opened_at, EXCLUDED.opened_at)
                        ELSE EXCLUDED.opened_at END,
       status = 'open',
       loop_type = EXCLUDED.loop_type,
       counterparty_slug = COALESCE(EXCLUDED.counterparty_slug, open_loops.counterparty_slug),
       counterparty_source_id = CASE WHEN EXCLUDED.counterparty_slug IS NULL
                                     THEN open_loops.counterparty_source_id
                                     ELSE EXCLUDED.counterparty_source_id END,
       counterparty_email = COALESCE(EXCLUDED.counterparty_email, open_loops.counterparty_email),
       summary = EXCLUDED.summary,
       evidence = EXCLUDED.evidence,
       page_slug = COALESCE(EXCLUDED.page_slug, open_loops.page_slug),
       due_at = COALESCE(EXCLUDED.due_at, open_loops.due_at),
       confidence = EXCLUDED.confidence,
       fact_id = COALESCE(EXCLUDED.fact_id, open_loops.fact_id),
       last_activity_at = GREATEST(open_loops.last_activity_at, EXCLUDED.last_activity_at),
       closed_at = NULL,
       closed_by = NULL,
       updated_at = now()
     WHERE (open_loops.status = 'open'
            OR EXCLUDED.last_activity_at > open_loops.last_activity_at
            OR open_loops.closed_by = '${MUTE_RECHECK}')
       AND (open_loops.closed_by IS DISTINCT FROM '${MUTED}'
            OR open_loops.counterparty_email IS DISTINCT FROM EXCLUDED.counterparty_email)
     RETURNING id, (xmax = 0) AS created`;
/** src/core/loops/loops-store.ts:263 (listOpenLoops); `LIMIT ${limit}` with the clamped limit spliced in, and no `$7`. */
function masterListLoopsSql(limit: number): string {
  return `SELECT * FROM open_loops
     WHERE ($1::text IS NULL OR source_id = ANY(string_to_array($1, ',')))
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR loop_type = $3)
       AND ($4::text IS NULL
            OR (counterparty_slug = $4 AND ($6::text IS NULL OR COALESCE(counterparty_source_id, source_id) = $6))
            OR counterparty_email = $4)
       AND ($5::bigint IS NULL OR id = $5::bigint)
     ORDER BY last_activity_at DESC, id DESC
     LIMIT ${limit}`;
}
/** src/core/verbs/entity-card.ts:731 (assembleCard); `LIMIT ${OPEN_THREADS_CAP}` spliced in. Master's order has no tie-break. */
function masterEntityLoopsSql(limit: number): string {
  return `SELECT id, loop_type, summary, due_at, last_activity_at, fact_id
       FROM open_loops
       WHERE status = 'open' AND counterparty_slug = $1
         AND COALESCE(counterparty_source_id, source_id) = $2
       ORDER BY last_activity_at DESC
       LIMIT ${limit}`;
}

type ListOpts = NonNullable<Parameters<BrainEngine['listOpenLoops']>[0]>;
/** The binds master's listOpenLoops sent, in `$1`..`$6` order. */
function masterListBinds(opts: ListOpts): unknown[] {
  return [
    opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds.join(',') : null,
    opts.status ?? null, opts.loopType ?? null, opts.counterparty ?? null,
    opts.loopId === undefined ? null : opts.loopId, opts.counterpartySourceId ?? null,
  ];
}

// ---------------------------------------------------------------- helpers

/** Rows with times as ISO text and ids counted from the smallest id, so two brains compare. */
function observe(rows: ReadonlyArray<Record<string, unknown>>, idKeys: readonly string[] = ['id']): unknown[] {
  const base = new Map<string, number>();
  for (const k of idKeys) base.set(k, Math.min(...rows.map(r => Number(r[k])).filter(Number.isFinite), Number.POSITIVE_INFINITY));
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Date) out[k] = v.toISOString();
      else if (idKeys.includes(k)) out[k] = Number(v) - (base.get(k) ?? 0);
      else if (k === 'fact_id') out[k] = v === null ? null : Number(v);
      else out[k] = v;
    }
    return out;
  });
}

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-05T10:00:00.000Z';
const T3 = '2026-03-09T10:00:00.000Z';

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'default', dedupKey: 'thread:a', loopType: 'unanswered_inbound', counterpartySlug: 'people/alice-example',
    summary: 'first', evidence: [{ message_id: 'm1', quote: 'hi' }], threadId: 't-a', detector: 'deterministic_thread',
    lastActivityAt: T1, openedAt: T1, ...over,
  };
}

async function newSource(engine: BrainEngine, id: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`, [id]);
}

/** Seeds the loops both loop cases read: two sources, a counterparty in each, a closed loop, a tie on activity, a loop with no counterparty source. */
async function seedLoops(engine: BrainEngine): Promise<void> {
  await newSource(engine, 'work');
  await engine.upsertOpenLoop(loop({ dedupKey: 'k1', counterpartySourceId: 'default', lastActivityAt: T2 }));
  await engine.upsertOpenLoop(loop({ dedupKey: 'k2', counterpartySourceId: 'work', lastActivityAt: T2, summary: 'in work' }));
  await engine.upsertOpenLoop(loop({ dedupKey: 'k3', sourceId: 'work', counterpartyEmail: 'people/alice-example', counterpartySlug: null, loopType: 'decision_pending', lastActivityAt: T1 }));
  await engine.upsertOpenLoop(loop({ dedupKey: 'k4', sourceId: 'work', lastActivityAt: T3, loopType: 'commitment_owed_by_me' }));
  await engine.upsertOpenLoop(loop({ dedupKey: 'k5', counterpartySlug: 'people/bob-example', lastActivityAt: T3 }));
  await engine.upsertOpenLoop(loop({ dedupKey: 'k6', lastActivityAt: T2, dueAt: '2026-04-01T00:00:00.000Z', factId: 7 }));
  const closed = await engine.listOpenLoops({ limit: 1000 });
  const k5 = closed.find(r => r.dedup_key === 'k5')!;
  await engine.closeOpenLoop(null, Number(k5.id), 'done', 'manual');
}

const LIST_CASES: Array<{ name: string; opts: ListOpts }> = [
  { name: 'no filter', opts: {} },
  { name: 'one source', opts: { sourceIds: ['work'] } },
  { name: 'two sources', opts: { sourceIds: ['default', 'work'] } },
  { name: 'empty source list reads every source', opts: { sourceIds: [] } },
  { name: 'status open', opts: { status: 'open' } },
  { name: 'status done', opts: { status: 'done' } },
  { name: 'loop type', opts: { loopType: 'decision_pending' } },
  { name: 'counterparty slug', opts: { counterparty: 'people/alice-example' } },
  { name: 'counterparty slug in its own source', opts: { counterparty: 'people/alice-example', counterpartySourceId: 'work' } },
  { name: 'counterparty email equal to the slug', opts: { counterparty: 'people/alice-example', counterpartySourceId: 'nowhere' } },
  { name: 'loop id', opts: { loopId: -1 } },
  { name: 'limit below one clamps to one', opts: { limit: 0 } },
  { name: 'limit 2', opts: { limit: 2 } },
  { name: 'fraction limit rounds', opts: { limit: 2.5 } },
  { name: 'limit above 1000 clamps', opts: { limit: 5000 } },
];

// ---------------------------------------------------------------- Postgres statement text, byte for byte

describe('the Postgres members send master\'s statement text (no database)', () => {
  function recording() {
    const fake = makeFakeSql();
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = fake.sql;
    return { engine, sent: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
  }

  test('hasExtractedEvents, readMaxTimelineEntryId and hasNotifierCoverage send the call site\'s text and binds', async () => {
    const { engine, sent } = recording();
    await engine.hasExtractedEvents('src-a', 7);
    await engine.readMaxTimelineEntryId();
    await engine.hasNotifierCoverage();
    expect(sent()).toEqual([
      { text: MASTER_HAS_EXTRACTED, params: ['src-a', 7] },
      { text: MASTER_MAX_ENTRY, params: [] },
      { text: MASTER_NOTIFIER_COVERED, params: [] },
    ]);
  });

  test('the open-loop members send master\'s text: the upsert and its guard exactly, the list with its limit bound, the card read with the tie-break and a spliced limit', async () => {
    const { engine, sent } = recording();
    await engine.upsertOpenLoop(loop({ counterpartySlug: 'people/alice-example', counterpartySourceId: 'work', pageSlug: 'emails/a', factId: 7, dueAt: T3, confidence: 0.5 }));
    await engine.listOpenLoops({ sourceIds: ['a', 'b'], status: 'open', limit: 5000 });
    await engine.readEntityOpenLoops('people/alice-example', 'work', 10);
    const [upsert, followUp, list, card] = sent();
    // The fake answers no rows, so the upsert's guard-held path sends the follow-up id read, as master did.
    expect(upsert!.text).toBe(MASTER_UPSERT_LOOP);
    expect(upsert!.params).toEqual(['default', 'thread:a', 'unanswered_inbound', 'people/alice-example', null, 'first', JSON.stringify([{ message_id: 'm1', quote: 'hi' }]), 't-a', 'emails/a', T3, 'deterministic_thread', 0.5, 7, T1, T1, 'work']);
    expect(followUp).toEqual({ text: 'SELECT id FROM open_loops WHERE source_id = $1 AND dedup_key = $2', params: ['default', 'thread:a'] });
    // Differences from master, by design: the limit binds as $7 instead of being spliced in.
    expect(list!.text).toBe(masterListLoopsSql(1000).replace('LIMIT 1000', 'LIMIT $7'));
    expect(list!.params).toEqual([...masterListBinds({ sourceIds: ['a', 'b'], status: 'open' }), 1000]);
    // and the card read adds `id DESC` after the activity order; its limit is the spliced literal as before.
    expect(card!.text).toBe(masterEntityLoopsSql(10).replace('ORDER BY last_activity_at DESC\n', 'ORDER BY last_activity_at DESC, id DESC\n'));
    expect(card!.params).toEqual(['people/alice-example', 'work']);
  });

  test('the admission read sends master\'s text byte for byte, privacy probe included, and the source-state read the callers\' text', async () => {
    expect(MEMBER_ADMISSION_SQL).toBe(MASTER_ADMISSION_SQL);
    expect(MASTER_ADMISSION_SQL).toContain(GUEST_SOURCES_HIDDEN_SQL);
    const { engine, sent } = recording();
    await engine.readAdmissionSource('src-a');
    await engine.readSourceState('src-a');
    await engine.readSourceState('src-a', { lock: 'share' });
    expect(sent()).toEqual([
      { text: MASTER_ADMISSION_SQL, params: ['src-a'] },
      { text: MASTER_SOURCE_STATE, params: ['src-a'] },
      { text: `${MASTER_SOURCE_STATE} FOR SHARE`, params: ['src-a'] },
    ]);
  });

  test('the repair/timeline reads send the call site\'s text and binds', async () => {
    const { engine, sent } = recording();
    await engine.storedTimelineRowsByPageIds([3, 4]);
    await engine.countSegmentedTimelinePages(['a', 'b'], MASTER_SAMPLE_LIMIT);
    await engine.countTimelineCommentMarkupRows(['a', 'b']);
    // The fake answers no rows, so the count read ends the segmented pass before the sample statement.
    expect(sent()).toEqual([
      { text: MASTER_STORED_BY_PAGES, params: [[3, 4]] },
      { text: MASTER_SEGMENTED_COUNT, params: [['a', 'b']] },
      { text: MASTER_MARKUP_COUNT, params: [['a', 'b']] },
    ]);
  });

  test('the segmented sample sends master\'s text with the limit spelled as the literal master spliced in', async () => {
    const fake = makeFakeSql(stmt => (stmt.text.includes('count(DISTINCT p.id)') ? [{ pages: 1, rows: 1 }] : []));
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = fake.sql;
    await engine.countSegmentedTimelinePages(['a', 'b'], MASTER_SAMPLE_LIMIT);
    const sent = fake.statements().map(s => ({ text: s.text, params: s.params }));
    expect(sent).toEqual([
      { text: MASTER_SEGMENTED_COUNT, params: [['a', 'b']] },
      { text: MASTER_SEGMENTED_SAMPLE, params: [['a', 'b']] },
    ]);
  });
});

// ---------------------------------------------------------------- row parity, per backend

for (const kind of testBackends()) {
  describe(`moved reads before and after (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 2);
        engine = pg.engine;
        close = pg.close;
      } else {
        const e = new PGLiteEngine();
        await e.connect({ engine: 'pglite' } as never);
        await e.initSchema();
        engine = e;
        close = () => e.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => { await resetArm({ backend: kind, engine } as unknown as ParityArm); });

    const before = {
      hasExtracted: async (sourceId: string, pageId: number) => (await engine.executeRaw(MASTER_HAS_EXTRACTED, [sourceId, pageId])).length > 0,
      maxEntry: async () => Number((await engine.executeRaw<{ max_entry: number | string }>(MASTER_MAX_ENTRY))[0]!.max_entry),
      notifierCovered: async () => {
        const [row] = await engine.executeRaw<{ covered: unknown }>(MASTER_NOTIFIER_COVERED);
        const v = row?.covered; // status.ts:70 truthy()
        return v === true || v === 't' || v === 1;
      },
    };

    async function chronicleRow(sourceId: string, pageId: number, slug: string, state: string, hashes: string[]) {
      await engine.executeRaw(
        `INSERT INTO chronicle_page_state (source_id, page_id, content_hash, extractor_version, slug, state, trigger, event_hashes)
         VALUES ($1, $2, 'h', 1, $3, $4, 'auto', $5::text[])`, [sourceId, pageId, slug, state, hashes]);
    }

    test('hasExtractedEvents: an extracted generation with events is true; empty, pending, skipped, failed and another source are false', async () => {
      await newSource(engine, 'work');
      const ids: Record<string, number> = {};
      for (const slug of ['n/extracted', 'n/empty', 'n/pending', 'n/skipped', 'n/failed', 'n/none']) {
        ids[slug] = (await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '' })).id;
      }
      const w = (await engine.putPage('n/in-work', { type: 'note', title: 'w', compiled_truth: 'w', timeline: '' }, { sourceId: 'work' })).id;
      await chronicleRow('default', ids['n/extracted']!, 'n/extracted', 'extracted', ['h1', 'h2']);
      await chronicleRow('default', ids['n/empty']!, 'n/empty', 'extracted', []);
      await chronicleRow('default', ids['n/pending']!, 'n/pending', 'pending', ['h1']);
      await chronicleRow('default', ids['n/skipped']!, 'n/skipped', 'skipped', ['h1']);
      await chronicleRow('default', ids['n/failed']!, 'n/failed', 'failed', ['h1']);
      await chronicleRow('work', w, 'n/in-work', 'extracted', ['h1']);
      const probes: Array<[string, number]> = [...Object.values(ids).map(id => ['default', id] as [string, number]), ['work', w], ['default', w], ['work', ids['n/extracted']!], ['default', 999_999]];
      const answers = [];
      for (const [s, p] of probes) {
        const [b, a] = [await before.hasExtracted(s, p), await engine.hasExtractedEvents(s, p)];
        expect(a).toBe(b);
        answers.push(a);
      }
      expect(answers.filter(Boolean).length).toBe(2); // extracted/default and in-work/work: the case reaches both answers
    });

    test('readMaxTimelineEntryId: 0 on an empty table, the largest id after inserts, the new largest after the largest is deleted', async () => {
      expect(await engine.readMaxTimelineEntryId()).toBe(await before.maxEntry());
      expect(await engine.readMaxTimelineEntryId()).toBe(0);
      await engine.putPage('p/a', { type: 'note', title: 'a', compiled_truth: 'a', timeline: '' });
      await engine.addTimelineEntry('p/a', { date: '2026-01-01', summary: 'one' });
      await engine.addTimelineEntry('p/a', { date: '2026-01-02', summary: 'two' });
      const max = await before.maxEntry();
      expect(max).toBeGreaterThan(0);
      expect(await engine.readMaxTimelineEntryId()).toBe(max);
      await engine.executeRaw('DELETE FROM timeline_entries WHERE id = $1', [max]);
      expect(await engine.readMaxTimelineEntryId()).toBe(await before.maxEntry());
      expect(await engine.readMaxTimelineEntryId()).toBeLessThan(max);
    });

    test('hasNotifierCoverage: false with no row or only unobserved rows, true once any row is observed', async () => {
      expect(await engine.hasNotifierCoverage()).toBe(await before.notifierCovered());
      expect(await engine.hasNotifierCoverage()).toBe(false);
      await newSource(engine, 'work');
      await engine.executeRaw(`INSERT INTO sync_notifier_sources (source_id) VALUES ('default')`);
      expect(await engine.hasNotifierCoverage()).toBe(await before.notifierCovered());
      expect(await engine.hasNotifierCoverage()).toBe(false);
      await engine.executeRaw(`INSERT INTO sync_notifier_sources (source_id, observed_at) VALUES ('work', now())`);
      expect(await engine.hasNotifierCoverage()).toBe(await before.notifierCovered());
      expect(await engine.hasNotifierCoverage()).toBe(true);
    });

    /** Pages with own rows, event rows, a second source, a soft-deleted page and a segmented page, for the repair reads. */
    async function seedTimeline() {
      await newSource(engine, 'work');
      const meta = (title: string) => pageMeta(title);
      const ids = {
        plain: (await engine.putPage('t/plain', { type: 'note', title: 'plain', compiled_truth: 'plain', timeline: '' })).id,
        seg1: (await engine.createSegmentedPageShell('t/seg-one', meta('Seg one'), { sourceId: 'default' })).id,
        seg2: (await engine.createSegmentedPageShell('t/seg-two', meta('Seg two'), { sourceId: 'work' })).id,
        segGone: (await engine.createSegmentedPageShell('t/seg-gone', meta('Seg gone'), { sourceId: 'default' })).id,
        segEvents: (await engine.createSegmentedPageShell('t/seg-events-only', meta('Seg events'), { sourceId: 'default' })).id,
        segNoRows: (await engine.createSegmentedPageShell('t/seg-no-rows', meta('Seg none'), { sourceId: 'default' })).id,
      };
      const add = (slug: string, summary: string, extra: Record<string, unknown> = {}, sourceId = 'default') =>
        engine.addTimelineEntry(slug, { date: '2026-02-01', source: 'cal', summary, detail: 'd', ...extra }, { sourceId });
      await add('t/plain', 'plain row');
      await add('t/seg-one', 'seg one a');
      await add('t/seg-one', 'seg one b <!-- hidden -->');
      await add('t/seg-two', 'seg two a', { source: 'x --> y' }, 'work');
      await add('t/seg-gone', 'seg gone row');
      await add('t/seg-events-only', 'event-only page row');
      // The page's only row is an event row (event_page_id set): not a page's own row, so it counts for nothing.
      await engine.executeRaw(`UPDATE timeline_entries SET event_page_id = $1 WHERE page_id = $2`, [ids.plain, ids.segEvents]);
      await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [ids.segGone]);
      return ids;
    }

    test('storedTimelineRowsByPageIds: the own rows of the named pages, event rows and other pages left out', async () => {
      const ids = await seedTimeline();
      for (const pages of [[ids.plain], [ids.seg1, ids.plain, 999_999], [ids.seg2, ids.segGone, ids.segEvents, ids.segNoRows], [ids.plain, ids.seg1, ids.seg2, ids.segGone, ids.segEvents, ids.segNoRows]]) {
        const old = await engine.executeRaw<Record<string, unknown>>(MASTER_STORED_BY_PAGES, [pages]);
        const now = await engine.storedTimelineRowsByPageIds(pages);
        const key = (r: Record<string, unknown>) => `${r.page_id}:${r.id}`;
        const asc = (rows: ReadonlyArray<Record<string, unknown>>) => [...rows].sort((a, b) => key(a) < key(b) ? -1 : 1);
        expect(observe(asc(now as unknown as Array<Record<string, unknown>>), ['page_id', 'id'])).toEqual(observe(asc(old), ['page_id', 'id']));
      }
      expect((await engine.storedTimelineRowsByPageIds([ids.plain, ids.seg1])).length).toBe(3);
      expect(await engine.storedTimelineRowsByPageIds([])).toEqual([]);
    });

    test('countSegmentedTimelinePages: live segmented pages with own rows, soft-deleted, event-only and row-less pages left out', async () => {
      await seedTimeline();
      const old = async (sources: string[]) => {
        const [counts] = await engine.executeRaw<{ pages: number; rows: number }>(MASTER_SEGMENTED_COUNT, [sources]);
        if (!counts?.pages) return { pages: 0, rows: 0, sample: [] };
        const named = await engine.executeRaw<{ source_id: string; slug: string }>(MASTER_SEGMENTED_SAMPLE, [sources]);
        return { pages: Number(counts.pages), rows: Number(counts.rows), sample: named.map(r => `${r.source_id}:${r.slug}`) };
      };
      const answers = [];
      for (const sources of [['default'], ['work'], ['default', 'work'], ['nowhere'], []]) {
        const now = await engine.countSegmentedTimelinePages(sources, MASTER_SAMPLE_LIMIT);
        const mapped = { pages: now.pages, rows: now.rows, sample: now.sample.map(r => `${r.source_id}:${r.slug}`) };
        expect(mapped).toEqual(await old(sources));
        answers.push(mapped);
      }
      expect(answers[2]).toEqual({ pages: 2, rows: 3, sample: ['default:t/seg-one', 'work:t/seg-two'] });
      expect(answers[3]).toEqual({ pages: 0, rows: 0, sample: [] });
    });

    test('countSegmentedTimelinePages names at most the limit, the lowest page ids first', async () => {
      const slugs = Array.from({ length: 12 }, (_, i) => `s/p${String(i).padStart(2, '0')}`);
      for (const slug of slugs) {
        await engine.createSegmentedPageShell(slug, pageMeta(slug), { sourceId: 'default' });
        await engine.addTimelineEntry(slug, { date: '2026-02-01', summary: slug });
      }
      const old = await engine.executeRaw<{ source_id: string; slug: string }>(MASTER_SEGMENTED_SAMPLE, [['default']]);
      const now = await engine.countSegmentedTimelinePages(['default'], MASTER_SAMPLE_LIMIT);
      expect(now.pages).toBe(12);
      expect(now.sample).toEqual(old);
      expect(now.sample.length).toBe(10);
      expect((await engine.countSegmentedTimelinePages(['default'], 3)).sample.map(r => r.slug)).toEqual(slugs.slice(0, 3));
    });

    test('countTimelineCommentMarkupRows: summary or source carrying comment markers on live pages, own rows only', async () => {
      const ids = await seedTimeline();
      await engine.addTimelineEntry('t/plain', { date: '2026-02-02', source: 'a <!-- b', summary: 'src marker' });
      await engine.addTimelineEntry('t/plain', { date: '2026-02-03', source: 'ok', summary: 'end --> marker' });
      await engine.executeRaw(`UPDATE timeline_entries SET summary = 'event <!-- row' WHERE page_id = $1`, [ids.segEvents]);
      for (const sources of [['default'], ['work'], ['default', 'work'], ['nowhere'], []]) {
        const [row] = await engine.executeRaw<{ n: number }>(MASTER_MARKUP_COUNT, [sources]);
        expect(await engine.countTimelineCommentMarkupRows(sources)).toBe(Number(row!.n));
      }
      expect(await engine.countTimelineCommentMarkupRows(['default'])).toBe(3); // seg-one's summary, plain's source and plain's summary; the soft-deleted and event rows left out
      expect(await engine.countTimelineCommentMarkupRows(['work'])).toBe(1);
    });

    test('readAdmissionSource answers what the admission statement answered: unknown, plain, pathed, archived and guest sources', async () => {
      await engine.executeRaw(`INSERT INTO sources (id, name, config, local_path) VALUES ('pathed', 'pathed', '{"kind":"repo","role":"writer"}'::jsonb, '/work/p')`);
      await engine.executeRaw(`INSERT INTO sources (id, name, config, archived) VALUES ('old', 'old', '{}'::jsonb, true)`);
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('guests', 'guests', '{"kind":"guest"}'::jsonb)`);
      await engine.executeRaw(`INSERT INTO guest_sources (source_id, writers) VALUES ('guests', ARRAY['member:m1']::text[])`);
      const seen: unknown[] = [];
      for (const id of ['default', 'pathed', 'old', 'guests', 'nowhere']) {
        const [old] = await engine.executeRaw<Record<string, unknown>>(MASTER_ADMISSION_SQL, [id]);
        const now = await engine.readAdmissionSource(id);
        expect(now, id).toEqual((old ?? null) as never);
        seen.push(now && { archived: now.archived, writers: now.guest_writers });
      }
      expect(seen).toEqual([{ archived: false, writers: null }, { archived: false, writers: null }, { archived: true, writers: null }, { archived: false, writers: ['member:m1'] }, null]);
    });

    test('readSourceState answers what the callers\' statement answered: unknown, plain, pathed, archived', async () => {
      await engine.executeRaw(`INSERT INTO sources (id, name, config, local_path) VALUES ('pathed', 'pathed', '{"kind":"repo"}'::jsonb, '/work/p')`);
      await engine.executeRaw(`INSERT INTO sources (id, name, config, archived) VALUES ('old', 'old', '{"a":1}'::jsonb, true)`);
      for (const id of ['default', 'pathed', 'old', 'nowhere']) {
        const [old] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; config: unknown }>(MASTER_SOURCE_STATE, [id]);
        const config = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
        const now = await engine.readSourceState(id);
        expect(now, id).toEqual((old ? { ...old, config: config(old.config) } : null) as never);
        expect(await engine.readSourceState(id, { lock: 'share' }), id).toEqual(now as never);
      }
    });

    test('listTimelineOrphanPages answers what timeline-extract.ts asked: live pages after the id with own rows, by id, within the limit and source', async () => {
      const ids = await seedTimeline();
      const cases: Array<{ afterId: number; limit: number; sourceId?: string }> = [
        { afterId: 0, limit: 10 }, { afterId: 0, limit: 2 }, { afterId: ids.seg1, limit: 10 }, { afterId: 0, limit: 10, sourceId: 'work' },
        { afterId: 0, limit: 10, sourceId: 'default' }, { afterId: 0, limit: 10, sourceId: 'nowhere' },
      ];
      const answers: number[] = [];
      for (const opts of cases) {
        const params: unknown[] = [opts.afterId, opts.limit];
        if (opts.sourceId) params.push(opts.sourceId);
        const old = await engine.executeRaw<Record<string, unknown>>(MASTER_ORPHANS(Boolean(opts.sourceId)), params);
        const now = await engine.listTimelineOrphanPages(opts);
        const shape = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map(r => ({ ...r, id: Number(r.id) }));
        expect(shape(now as never)).toEqual(shape(old));
        answers.push(now.length);
      }
      // plain, seg-one, seg-two and the soft-deleted page's row: live pages only (the event-only page's row is an event row).
      expect(answers).toEqual([3, 2, 1, 1, 2, 0]);
    });

    test('listOpenLoops answers what loops-store.ts asked, for every filter and limit', async () => {
      await seedLoops(engine);
      const idOf = ((await engine.listOpenLoops({ limit: 1000 })).find(r => r.dedup_key === 'k3')!).id;
      let nonEmpty = 0;
      for (const { name, opts } of LIST_CASES) {
        const o = opts.loopId === -1 ? { ...opts, loopId: Number(idOf) } : opts;
        const limit = Math.min(Math.max(o.limit ?? 200, 1), 1000);
        const old = await engine.executeRaw<Record<string, unknown>>(masterListLoopsSql(limit), masterListBinds(o));
        const now = await engine.listOpenLoops(o);
        expect(observe(now), name).toEqual(observe(old));
        if (now.length > 0) nonEmpty++;
      }
      expect(nonEmpty).toBeGreaterThanOrEqual(LIST_CASES.length - 2);
    });

    test('listOpenLoops clamps a limit above 1000 to 1000 rows, as the spliced literal did', async () => {
      await engine.executeRaw(
        `INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, detector, last_activity_at)
         SELECT 'default', 'bulk:' || g, 'unanswered_inbound', 'bulk ' || g, 'manual', '2026-03-01T10:00:00Z'::timestamptz + g * interval '1 second'
         FROM generate_series(1, 1005) AS g`);
      const old = await engine.executeRaw<Record<string, unknown>>(masterListLoopsSql(1000), masterListBinds({ limit: 5000 }));
      const now = await engine.listOpenLoops({ limit: 5000 });
      expect(old.length).toBe(1000);
      expect(now.length).toBe(1000);
      expect(now.map(r => Number(r.id))).toEqual(old.map(r => Number(r.id)));
      // Newest activity first: the 1000 newest of the 1005, so the five oldest are the ones left out.
      expect(now.map(r => r.summary)).not.toContain('bulk 1');
      expect(now[0]!.summary).toBe('bulk 1005');
    });

    test('readEntityOpenLoops answers what entity-card.ts asked: its source only, a loop with no counterparty source on its own source, newest first', async () => {
      await seedLoops(engine);
      // A tie on activity: master left the order of tied rows to the plan, the member orders them by id descending.
      await engine.upsertOpenLoop(loop({ dedupKey: 'k7', lastActivityAt: T2, counterpartySourceId: null, summary: 'tied, own source' }));
      const seen: number[] = [];
      for (const [slug, source, limit] of [['people/alice-example', 'default', 10], ['people/alice-example', 'work', 10], ['people/alice-example', 'default', 1], ['people/bob-example', 'default', 10], ['people/nobody', 'default', 10]] as const) {
        const everything = await engine.executeRaw<Record<string, unknown>>(masterEntityLoopsSql(1000), [slug, source]);
        const now = await engine.readEntityOpenLoops(slug, source, limit);
        const byId = (rows: ReadonlyArray<Record<string, unknown>>) => [...rows].sort((a, b) => Number(a.id) - Number(b.id));
        expect(now.length).toBe(Math.min(limit, everything.length));
        if (limit >= everything.length) {
          // Nothing is cut by the limit: the same rows as master's statement returns.
          expect(observe(byId(now as never))).toEqual(observe(byId(everything)));
        } else {
          // The limit cuts inside a tie on activity, which master left to the plan: the member takes the highest id first.
          const top = Math.max(...everything.map(r => Number(r.id)));
          expect(Number(now[0]!.id)).toBe(top);
          expect(everything.map(r => Number(r.id))).toContain(Number(now[0]!.id));
        }
        for (let i = 1; i < now.length; i++) {
          const [a, b] = [now[i - 1]!, now[i]!];
          const [ta, tb] = [new Date(a.last_activity_at).getTime(), new Date(b.last_activity_at).getTime()];
          expect(ta > tb || (ta === tb && Number(a.id) > Number(b.id))).toBe(true);
        }
        seen.push(now.length);
      }
      expect(seen).toEqual([3, 2, 1, 0, 0]);
    });
  });
}

// ---------------------------------------------------------------- the Rust arm (opt-in): the two loop reads Rust serves

describe.skipIf(!rustArmRequested())('the Rust members before and after: master\'s loop reads on PGLite against Rust', () => {
  let rust: BrainEngine;
  let dir: string;
  let pglite: PGLiteEngine;

  beforeAll(async () => {
    const opened = await openRustBrain();
    rust = opened.engine as unknown as BrainEngine;
    dir = opened.dir;
    pglite = new PGLiteEngine();
    await pglite.connect({ engine: 'pglite' } as never);
    await pglite.initSchema();
    // The Rust brain takes the loops through its own member; the PGLite brain through the SQL one. Both hold the same loops.
    await seedLoopsOn(rust, 'rust');
    await seedLoopsOn(pglite, 'pglite');
  }, 120_000);
  afterAll(async () => {
    await rust.disconnect();
    removeBrainDir(dir);
    await pglite.disconnect();
  });

  /** Source rows through the arm's own path (Rust has no executeRaw). */
  async function seedLoopsOn(e: BrainEngine, backend: 'rust' | 'pglite'): Promise<void> {
    await createSource(e, backend, 'work');
    for (const l of [
      loop({ dedupKey: 'k1', counterpartySourceId: 'default', lastActivityAt: T2 }),
      loop({ dedupKey: 'k2', counterpartySourceId: 'work', lastActivityAt: T2, summary: 'in work' }),
      loop({ dedupKey: 'k3', sourceId: 'work', counterpartyEmail: 'people/alice-example', counterpartySlug: undefined, loopType: 'decision_pending', lastActivityAt: T1 }),
      loop({ dedupKey: 'k4', sourceId: 'work', lastActivityAt: T3, loopType: 'commitment_owed_by_me' }),
      loop({ dedupKey: 'k6', lastActivityAt: T2, dueAt: '2026-04-01T00:00:00.000Z', factId: 7 }),
    ]) await e.upsertOpenLoop(l);
  }

  test('listOpenLoops on Rust returns the rows master\'s statement returns on PGLite, for every filter and limit', async () => {
    let nonEmpty = 0;
    for (const { name, opts } of LIST_CASES) {
      const o = opts.loopId === -1 ? { ...opts, loopId: Number((await pglite.listOpenLoops({ sourceIds: ['work'], loopType: 'decision_pending' }))[0]!.id) } : opts;
      const limit = Math.min(Math.max(o.limit ?? 200, 1), 1000);
      const old = await pglite.executeRaw<Record<string, unknown>>(masterListLoopsSql(limit), masterListBinds(o));
      const now = await rust.listOpenLoops(o);
      const strip = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map(({ id, created_at, updated_at, ...r }) => r);
      if (opts.loopId === -1) continue; // the ids of two brains differ; the id filter is covered by the PGLite and Postgres arms above
      expect(observe(strip(now) as never, []), name).toEqual(observe(strip(old) as never, []));
      if (now.length > 0) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThanOrEqual(LIST_CASES.length - 4);
  });

  test('readEntityOpenLoops on Rust returns the rows master\'s statement returns on PGLite: its source only, newest first', async () => {
    for (const [slug, source, limit] of [['people/alice-example', 'default', 10], ['people/alice-example', 'work', 10], ['people/alice-example', 'default', 1], ['people/nobody', 'default', 10]] as const) {
      const everything = await pglite.executeRaw<Record<string, unknown>>(masterEntityLoopsSql(1000), [slug, source]);
      const now = await rust.readEntityOpenLoops(slug, source, limit);
      const byId = (rows: ReadonlyArray<Record<string, unknown>>) => [...rows].sort((a, b) => Number(a.id) - Number(b.id));
      expect(now.length).toBe(Math.min(limit, everything.length));
      if (limit >= everything.length) {
        // Both brains took the same loops in the same order, so their ids match: the same rows master's statement returns.
        expect(observe(byId(now as never), [])).toEqual(observe(byId(everything), []));
      } else {
        // A limit that cuts inside a tie on activity: master left the order to the plan, Rust takes the highest id first.
        expect(Number(now[0]!.id)).toBe(Math.max(...everything.map(r => Number(r.id))));
      }
    }
  });
});
