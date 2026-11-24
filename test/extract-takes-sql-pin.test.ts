/**
 * The typed reads and the delete of `gbrain extract takes` (engine-sql/takes-reads.ts, engine-sql/trust-fence.ts
 * `listGuardedTakeRows`, engine-sql/belief.ts `listCoveredSources`) send Postgres the statements cycle/extract-takes.ts,
 * generations/adapters/take-rows.ts, trust/fence-guard.ts and belief/coverage-report.ts sent through `executeRaw` before
 * they became typed members: the same text and the same bound values.
 *
 * Protects: the takes re-extract keeps its exact Postgres statements, including both forms of the fence-leaving read
 * and both forms (with and without the open-contest clause) of the batch guard.
 * Fails when a member's text or parameter order drifts from the statement its caller wrote by hand.
 * No database: the engine runs on the recording fake.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { OPEN_CONTEST_SQL, WRITER_RANK_SQL } from '../src/core/engine-sql/trust-fence.ts';
import { trustRankSql } from '../src/core/trust/tier.ts';
import { TAKE_PREIMAGE_SQL } from '../src/core/engine-sql/takes-reads.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

/** The (text, params) of every query statement `fn` sends. */
async function sent(fn: (engine: PostgresEngine) => Promise<unknown>): Promise<Array<{ text: string; params: unknown[] }>> {
  const fake = makeFakeSql(() => undefined);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  await fn(engine);
  return fake.trace.flatMap(s => (s.kind === 'query' ? [{ text: s.text, params: s.params }] : []));
}

async function same(old: (e: PostgresEngine) => Promise<unknown>, typed: (e: PostgresEngine) => Promise<unknown>) {
  const before = await sent(old);
  expect(before).toHaveLength(1);
  expect(await sent(typed)).toEqual(before);
}

describe('the takes re-extract sends the hand-written Postgres statements', () => {
  test('readLivePageIdBySlug (getPageIdForSlug)', () => same(
    e => e.executeRaw(`SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL LIMIT 1`, ['notes/a', 'default']),
    e => e.readLivePageIdBySlug('notes/a', 'default')));

  test('readPageTierRef (reconcileTier)', () => same(
    e => e.executeRaw('SELECT source_id, slug, trust_tier FROM pages WHERE id = $1', [7]),
    e => e.readPageTierRef(7)));

  test('readPageTierRows (upsertProjectedTakes)', () => same(
    e => e.executeRaw('SELECT id,source_id,slug,trust_tier FROM pages WHERE id=ANY($1::int[])', [[3, 4]]),
    e => e.readPageTierRows([3, 4])));

  test('pageHasFrontmatterKey (the FS quarantine check)', () => same(
    e => e.executeRaw('SELECT 1 FROM pages WHERE id=$1 AND frontmatter ? $2', [7, 'quarantine']),
    e => e.pageHasFrontmatterKey(7, 'quarantine')));

  test('listTakeIdsLeavingFence, removed (unheldTakes)', () => same(
    e => e.executeRaw(`SELECT id FROM takes WHERE page_id = $1 AND ${'NOT (row_num = ANY($2::integer[]))'}`, [7, [1, 3]]),
    e => e.listTakeIdsLeavingFence(7, { change: 'removed', rowNums: [1, 3] })));

  test('listTakeIdsLeavingFence, replaced (unheldTakes)', () => {
    const rows = [{ row_num: 1, claim: 'one' }, { row_num: 2, claim: 'two' }];
    return same(
      e => e.executeRaw(`SELECT id FROM takes WHERE page_id = $1 AND ${`NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS f(row_num int, claim text) WHERE f.row_num = takes.row_num AND f.claim = takes.claim)`}`,
      [7, JSON.stringify(rows)]),
      e => e.listTakeIdsLeavingFence(7, { change: 'replaced', rows }));
  });

  test('listTakePreimages (takePreimages)', () => {
    const incoming = [{ row_num: 2, claim: 'two', kind: 'take', holder: 'h' }];
    return same(
      e => e.executeRaw(`SELECT ${TAKE_PREIMAGE_SQL} AS preimage, k.id = ANY($2::bigint[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.id = ANY($2::bigint[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`, [7, [11, 12], JSON.stringify(incoming)]),
      e => e.listTakePreimages(7, [11, 12], incoming));
  });

  test('TAKE_PREIMAGE_SQL keeps every take column but its vector and write attribution', () => {
    expect(TAKE_PREIMAGE_SQL).toBe(`jsonb_build_object('id', k.id, 'page_id', k.page_id, 'row_num', k.row_num, 'claim', k.claim, 'kind', k.kind, 'holder', k.holder,
  'weight', k.weight, 'since_date', k.since_date, 'until_date', k.until_date, 'source', k.source, 'superseded_by', k.superseded_by, 'active', k.active,
  'resolved_at', k.resolved_at, 'resolved_outcome', k.resolved_outcome, 'resolved_value', k.resolved_value, 'resolved_unit', k.resolved_unit,
  'resolved_source', k.resolved_source, 'resolved_by', k.resolved_by, 'resolved_quality', k.resolved_quality)`);
  });

  test('deleteTakesByIds (the prune delete); an empty list sends nothing', async () => {
    await same(
      e => e.executeRaw('DELETE FROM takes WHERE id = ANY($1::bigint[])', [[11, 12]]),
      e => e.deleteTakesByIds([11, 12]));
    expect(await sent(e => e.deleteTakesByIds([]))).toEqual([]);
  });

  test('findTakeId (the take-id read of upsertProjectedTakes)', () => same(
    e => e.executeRaw('SELECT id FROM takes WHERE page_id=$1 AND row_num=$2', [7, 2]),
    e => e.findTakeId(7, 2)));

  // Main join (da99c637a7): main's member sorted `ORDER BY 1`; the cli-members line's copy of this read
  // (engine-sql/doctor-acc.ts listBeliefCoveredSources at de72811022) sorted `ORDER BY s.id COLLATE "C"`. The join kept
  // main's member and re-applied this line's byte order, so the hand-written statement carries it too.
  test('listCoveredSources (coveredSources)', () => same(
    e => e.executeRaw(`SELECT s.id FROM sources s WHERE EXISTS (SELECT 1 FROM belief_events e
    WHERE e.source_id = s.id AND e.subject_kind = 'coverage' AND e.subject_key = $1 AND e.source_incarnation = s.incarnation) ORDER BY s.id COLLATE "C"`, ['["coverage"]']),
    e => e.listCoveredSources('["coverage"]')));

  for (const pending of [false, true]) {
    test(`listGuardedTakeRows (guardTakeRows), ${pending ? 'with' : 'without'} the open-contest clause; an empty batch sends nothing`, async () => {
      const incoming = [{ page_id: 3, row_num: 1, claim: 'one', kind: 'take', holder: 'h', active: true }];
      const gone = [{ page_id: 4, row_num: 2 }];
      await same(
        e => e.executeRaw(`SELECT x.id, x.page_id, x.row_num, x.trust_tier,
      CASE WHEN n.row_num IS NULL THEN 'removed' WHEN (x.claim, x.kind, x.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder) THEN 'replaced'
        ELSE 'deactivated' END AS change
    FROM takes x
    LEFT JOIN jsonb_to_recordset($1::text::jsonb) AS n(page_id integer, row_num integer, claim text, kind text, holder text, active boolean)
      ON n.page_id = x.page_id AND n.row_num = x.row_num
    LEFT JOIN jsonb_to_recordset($2::text::jsonb) AS g(page_id integer, row_num integer) ON g.page_id = x.page_id AND g.row_num = x.row_num
    WHERE x.page_id = ANY($3::integer[]) AND (${trustRankSql('x.trust_tier')} > ${WRITER_RANK_SQL}${pending ? ` OR ${OPEN_CONTEST_SQL('takes')}` : ''})
      AND (g.row_num IS NOT NULL OR (n.row_num IS NOT NULL
        AND ((x.claim, x.kind, x.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder) OR (x.active AND NOT n.active))))
    ORDER BY x.page_id, x.row_num FOR UPDATE OF x`,
        [JSON.stringify(incoming), JSON.stringify(gone), [...new Set([...incoming, ...gone].map(r => r.page_id))]]),
        e => e.listGuardedTakeRows({ incoming, gone, pending }));
      expect(await sent(e => e.listGuardedTakeRows({ incoming: [], gone: [], pending }))).toEqual([]);
    });
  }
});
