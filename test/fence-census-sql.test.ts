/**
 * The statements of src/core/engine-sql/fence-census.ts keep the exact text the fence census, the budget ledger and the
 * sync hold reader ran through executeRaw before the move.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each statement equals (whitespace aside) the text its reader ran before the move, with the parameters in the
 *    same order; the two page reads equal the old composed page column list; no member lists a name the engine lacks and
 *    none is listed twice.
 *  - Regression: a drifted statement changes which pages and holds the census judges, on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines on seeded rows, not the text against the old builder.
 *  - Seam: a recording raw reader (no engine).
 */
import { describe, expect, test } from 'bun:test';
import {
  FENCE_CENSUS_MEMBERS, clearFenceCandidateParts, countSegmentedFencePages, listFenceCensusPagesById, listFenceCensusPagesUpdated,
  listFenceCensusSources, listLiveFencePageIds, readBudgetLedgerDay, readFencePassHorizon,
  readFenceScanRecord, readFenceTrendRecords, upsertFenceCandidatePart, writeFenceScanRecord,
} from '../src/core/engine-sql/fence-census.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';

const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

function recorder(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const raw = (async (sql: string, params?: unknown[]) => { calls.push({ sql: squash(sql), params }); return rows; }) as never;
  return { raw, calls };
}

// The page column list census.ts composed before the move.
const FENCED = (column: string) => `(strpos(${column},'gbrain:facts:')>0 OR strpos(${column},'gbrain:takes:')>0)`;
const PAGE_COLUMNS = `id, slug, type, frontmatter, source_path, content_hash, updated_at::text AS updated_at,
  (deleted_at IS NULL AND page_kind='markdown') AS live,
  CASE WHEN deleted_at IS NULL AND page_kind='markdown' AND (${FENCED('compiled_truth')} OR ${FENCED('timeline')}) THEN compiled_truth END AS compiled_truth,
  CASE WHEN deleted_at IS NULL AND page_kind='markdown' AND (${FENCED('compiled_truth')} OR ${FENCED('timeline')}) THEN timeline END AS timeline`;

describe('fence census SQL text', () => {
  test('sources: the census source list', async () => {
    const { raw, calls } = recorder();
    await listFenceCensusSources(raw, ['a']);
    await listFenceCensusSources(raw, null);
    expect(calls).toEqual([
      { sql: squash(`SELECT id, incarnation::text AS incarnation, local_path FROM sources
    WHERE archived IS NOT TRUE AND incarnation IS NOT NULL AND ($1::text[] IS NULL OR id=ANY($1::text[])) ORDER BY id COLLATE "C"`), params: [['a']] },
      { sql: calls[0]!.sql, params: [null] },
    ]);
  });

  test('pass horizon: the writer-aware statement and its fallback', async () => {
    const { raw, calls } = recorder([{ at: 'x' }]);
    expect(await readFencePassHorizon(raw, 1500.9)).toBe('x');
    expect(calls).toEqual([{ sql: squash(`SELECT (LEAST(now(), COALESCE((SELECT min(xact_start) FROM pg_stat_activity
        WHERE datname=current_database() AND backend_xid IS NOT NULL AND pid<>pg_backend_pid()), now())) - ($1::int * interval '1 millisecond'))::text AS at`), params: [1500] }]);
    const failing: unknown[] = [];
    const rawFail = (async (sql: string, params?: unknown[]) => {
      failing.push({ sql: squash(sql), params });
      if (failing.length === 1) throw new Error('no pg_stat_activity');
      return [{ at: 'y' }];
    }) as never;
    expect(await readFencePassHorizon(rawFail, -5)).toBe('y');
    expect(failing[1]).toEqual({ sql: squash(`SELECT (now() - ($1::int * interval '1 millisecond'))::text AS at`), params: [0] });
  });

  test('page scans: the old composed page column list, by id and by update time', async () => {
    const { raw, calls } = recorder();
    await listFenceCensusPagesById(raw, 's', 4, 50);
    await listFenceCensusPagesUpdated(raw, 's', '2026-01-01', { at: '2026-01-02', id: 7 }, 50);
    await listFenceCensusPagesUpdated(raw, 's', '2026-01-01', null, 50);
    expect(calls).toEqual([
      { sql: squash(`SELECT ${PAGE_COLUMNS} FROM pages WHERE source_id=$1 AND id>$2 ORDER BY id LIMIT $3`), params: ['s', 4, 50] },
      { sql: squash(`SELECT ${PAGE_COLUMNS} FROM pages WHERE source_id=$1 AND updated_at>=$2::timestamptz
      AND ($3::timestamptz IS NULL OR (updated_at, id) > ($3::timestamptz, $4::int)) ORDER BY pages.updated_at, pages.id LIMIT $5`), params: ['s', '2026-01-01', '2026-01-02', 7, 50] },
      { sql: calls[1]!.sql, params: ['s', '2026-01-01', null, 0, 50] },
    ]);
  });

  test('live ids: no statement for no ids, else the live-page filter', async () => {
    const { raw, calls } = recorder([{ id: '3' }]);
    expect(await listLiveFencePageIds(raw, [])).toEqual([]);
    expect(calls).toEqual([]);
    expect(await listLiveFencePageIds(raw, [3, 4])).toEqual([3]);
    expect(calls).toEqual([{ sql: 'SELECT id FROM pages WHERE id=ANY($1::int[]) AND deleted_at IS NULL', params: [[3, 4]] }]);
  });

  test('scan record and candidate parts: the census-store statements', async () => {
    const { raw, calls } = recorder([{ record: { a: 1 } }]);
    expect(await readFenceScanRecord(raw, 'fence-scan', 'fp')).toEqual({ a: 1 } as never);
    await writeFenceScanRecord(raw, 'fence-scan', 'fp', { a: 1 } as never);
    await upsertFenceCandidatePart(raw, 'fence-candidate', 'fp', { sourceId: 's', incarnation: 'i', key: 'k.md' }, 'page', { f: 1 } as never);
    await clearFenceCandidateParts(raw, 'fence-candidate', [], 'page');
    await clearFenceCandidateParts(raw, 'fence-candidate', ['fp'], 'page');
    expect(calls).toEqual([
      { sql: 'SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', params: ['fence-scan', 'fp'] },
      { sql: squash(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,now())
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`), params: ['fence-scan', 'fp', '[{"a":1}]'] },
      { sql: squash(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'incarnation',$4::text,'key',$5::text,$6::text,$7::text::jsonb)),now())
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array((op_checkpoints.completed_keys->0)||jsonb_build_object($6::text,$7::text::jsonb)),updated_at=now()`),
      params: ['fence-candidate', 'fp', 's', 'i', 'k.md', 'page', '{"f":1}'] },
      { sql: squash(`DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[]) AND (completed_keys->0->$3::text) IS NULL`), params: ['fence-candidate', ['fp'], 'file'] },
      { sql: squash(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)-$3::text),updated_at=now()
    WHERE op=$1 AND fingerprint=ANY($2::text[]) AND (completed_keys->0->$3::text) IS NOT NULL`), params: ['fence-candidate', ['fp'], 'page'] },
    ]);
  });

  test('trend records and segmented pages', async () => {
    const { raw, calls } = recorder([{ record: { day: 'd' }, n: 2 }]);
    expect(await readFenceTrendRecords(raw, 'fence-trend', ['a'], '2026-01-01')).toEqual([{ day: 'd' }] as never);
    expect(await countSegmentedFencePages(raw, ['a'], ['b'])).toBe(2);
    expect(calls).toEqual([
      { sql: squash(`SELECT completed_keys->0 AS record FROM op_checkpoints
    WHERE op=$1 AND completed_keys->0->>'source_id'=ANY($2::text[]) AND completed_keys->0->>'day'>=$3`), params: ['fence-trend', ['a'], '2026-01-01'] },
      { sql: squash(`SELECT COUNT(*)::int AS n FROM pages
    WHERE deleted_at IS NULL AND page_kind = 'markdown' AND body_storage = 'segmented' AND source_id = ANY($1::text[])
      AND (source_path IS NULL OR NOT (source_id = ANY($2::text[])))`), params: [['a'], ['b']] },
    ]);
  });


  test('budget ledger day: the statement dailyLedger.readDay ran', async () => {
    const { raw, calls } = recorder([{ reserved: '1', committed: '2', cap: null }]);
    expect(await readBudgetLedgerDay(raw, 'llm_repair', 'fences', '2026-01-01')).toEqual({ reserved: '1', committed: '2', cap: null });
    expect(calls).toEqual([{ sql: 'SELECT reserved_usd::text AS reserved, committed_usd::text AS committed, cap_usd::text AS cap FROM budget_ledger WHERE scope = $1 AND resolver_id = $2 AND local_date = $3::date',
      params: ['llm_repair', 'fences', '2026-01-01'] }]);
    expect(await readBudgetLedgerDay(recorder([]).raw, 'a', 'b', 'c')).toBeNull();
  });

  test('members: none repeated, every one an engine member the Rust adapter knows', () => {
    expect(new Set(FENCE_CENSUS_MEMBERS).size).toBe(FENCE_CENSUS_MEMBERS.length);
    for (const name of FENCE_CENSUS_MEMBERS) expect(Object.keys(RUST_ENGINE_MEMBERS)).toContain(name);
  });
});
