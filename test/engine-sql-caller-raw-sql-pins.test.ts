/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at 7470c703ed.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on
 *    a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';
import { KEEP_HIDDEN_AT, MARK_REDERIVE_SQL } from '../src/core/engine-sql/facts-purge.ts';

interface Pin {
  /** The caller site the statement came from, at 7470c703ed. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them. */
  texts: string[];
}

const PINS: Pin[] = [
  {
    from: 'src/core/access/caller.ts:376 appliedAccessSummary',
    case: { method: 'listAppliedPolicyRevisions', variant: 'default', run: e => e.listAppliedPolicyRevisions() },
    texts: [`SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id`],
  },
  {
    // Copied from the caller at 6a3b40f112 (the Rust engine keeps these edges from store format 6).
    from: 'src/core/facts/derivation-inputs.ts:39 recordDerivationInputs',
    case: { method: 'recordDerivationInputs', variant: 'default', run: e => e.recordDerivationInputs({ table: 'pages', id: '9' }, 'src-a', [{ table: 'pages', id: '1' }]) },
    texts: [`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
    SELECT $1,$2,e.input_table,e.input_id,$3 FROM jsonb_to_recordset($4::text::jsonb) AS e(input_table text,input_id text)
    ON CONFLICT DO NOTHING`],
  },
  {
    // Copied from the caller at 1e610ffee3 (KEEP_HIDDEN_AT spliced in); one UPDATE and one mark INSERT per table, in first-seen order.
    from: 'src/core/facts/derivation-inputs.ts:90 hideDerivedRows',
    case: { method: 'hideDerivedRows', variant: 'default', run: e => e.transaction((tx: any) => tx.hideDerivedRows(
      [{ table: 'facts', id: '2' }, { table: 'takes', id: '3' }, { table: 'pages', id: '9' }], { sourceId: 'src-a', requestId: null, reason: 'purged input' })) },
    texts: [`UPDATE facts SET expired_at=COALESCE(expired_at,now()) WHERE id=ANY($1::bigint[]) AND source_id=$2 RETURNING id`, `INSERT INTO needs_rederive(derived_table,derived_id,source_id,request_id,reason,marked_at)
      SELECT $1,d.id,$3,$4::uuid,$5,COALESCE((SELECT p.deleted_at FROM pages p WHERE d.id=ANY($6::text[]) AND p.id::text=d.id),now()) FROM unnest($2::text[]) AS d(id)
      ON CONFLICT (derived_table,derived_id) DO UPDATE SET reason=EXCLUDED.reason,request_id=EXCLUDED.request_id,
        marked_at=CASE WHEN EXCLUDED.derived_id=ANY($6::text[]) THEN EXCLUDED.marked_at ELSE CASE WHEN needs_rederive.derived_table='pages' AND EXISTS (SELECT 1 FROM pages hp
  WHERE hp.id::text=needs_rederive.derived_id AND hp.deleted_at=needs_rederive.marked_at) THEN needs_rederive.marked_at ELSE now() END END`, `UPDATE takes k SET active=false FROM pages p WHERE k.id=ANY($1::bigint[]) AND p.id=k.page_id AND p.source_id=$2 RETURNING k.id`, `INSERT INTO needs_rederive(derived_table,derived_id,source_id,request_id,reason,marked_at)
      SELECT $1,d.id,$3,$4::uuid,$5,COALESCE((SELECT p.deleted_at FROM pages p WHERE d.id=ANY($6::text[]) AND p.id::text=d.id),now()) FROM unnest($2::text[]) AS d(id)
      ON CONFLICT (derived_table,derived_id) DO UPDATE SET reason=EXCLUDED.reason,request_id=EXCLUDED.request_id,
        marked_at=CASE WHEN EXCLUDED.derived_id=ANY($6::text[]) THEN EXCLUDED.marked_at ELSE CASE WHEN needs_rederive.derived_table='pages' AND EXISTS (SELECT 1 FROM pages hp
  WHERE hp.id::text=needs_rederive.derived_id AND hp.deleted_at=needs_rederive.marked_at) THEN needs_rederive.marked_at ELSE now() END END`, `WITH gone AS (SELECT id FROM pages WHERE id=ANY($1::integer[]) AND source_id=$2 AND deleted_at IS NOT NULL),
        hid AS (UPDATE pages SET deleted_at=now() WHERE id=ANY($1::integer[]) AND source_id=$2 AND deleted_at IS NULL RETURNING id)
        SELECT id, true AS now FROM hid UNION ALL SELECT id, false AS now FROM gone`, `INSERT INTO needs_rederive(derived_table,derived_id,source_id,request_id,reason,marked_at)
      SELECT $1,d.id,$3,$4::uuid,$5,COALESCE((SELECT p.deleted_at FROM pages p WHERE d.id=ANY($6::text[]) AND p.id::text=d.id),now()) FROM unnest($2::text[]) AS d(id)
      ON CONFLICT (derived_table,derived_id) DO UPDATE SET reason=EXCLUDED.reason,request_id=EXCLUDED.request_id,
        marked_at=CASE WHEN EXCLUDED.derived_id=ANY($6::text[]) THEN EXCLUDED.marked_at ELSE CASE WHEN needs_rederive.derived_table='pages' AND EXISTS (SELECT 1 FROM pages hp
  WHERE hp.id::text=needs_rederive.derived_id AND hp.deleted_at=needs_rederive.marked_at) THEN needs_rederive.marked_at ELSE now() END END`],
  },
  {
    // Copied from the caller at 1e610ffee3.
    from: 'src/core/facts/derivation-inputs.ts:79 releaseHiddenMoment',
    case: { method: 'releaseHiddenMoment', variant: 'default', run: e => e.releaseHiddenMoment(9) },
    texts: [`UPDATE needs_rederive n SET marked_at=clock_timestamp() FROM pages p
    WHERE n.derived_table='pages' AND n.derived_id=p.id::text AND p.id=$1 AND n.marked_at=p.deleted_at`],
  },
];

describe('caller raw SQL moved into typed members keeps its Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.case.method}/${pin.case.variant} (${pin.from})`, async () => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase(pin.case));
      expect(capture.error).toBeUndefined();
      const sent = capture.trace.filter(s => s.kind === 'query').map(s => s.text);
      expect(sent).toEqual(pin.texts);
    });
  }
});

test('the rederive mark hideDerivedRows writes ends with KEEP_HIDDEN_AT, so the two never drift apart', () => {
  expect(MARK_REDERIVE_SQL.endsWith(`ELSE ${KEEP_HIDDEN_AT} END`)).toBe(true);
});
