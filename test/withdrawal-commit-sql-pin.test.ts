/**
 * The forget commit and fact_withdrawn refusal members (src/core/engine-sql/trust-withdrawals.ts) send Postgres the
 * statement text and binds recordFactWithdrawal (src/core/facts/withdrawal.ts), forget-prepare.ts and
 * factWithdrawnRefusal (src/core/facts/single-prepare.ts) sent through `executeRaw` before they had members. A drift
 * here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each member's recorded text and params equal the old raw statement byte for byte: the withdrawal lock with
 * and without the remote floor, the review queue insert, the three page revision statements, the forget reason
 * append, and the refusal's backing and withdrawal reads with and without excludePrivate.
 * Fails when a member reorders a clause, renumbers a placeholder or binds a value as text.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { factWithdrawalSubjectSql, withdrawalReachedFactSql } from '../src/core/access/member-facts.ts';
import { remoteProvenanceFloorSql } from '../src/core/search/private-visibility.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function recordingEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const last = () => {
    const s = fake.statements().at(-1)!;
    return { text: s.text, params: s.params };
  };
  return { engine, last };
}

// The old withdrawal.ts text, rebuilt from its parts.
const admit = (excludePrivate: boolean) =>
  `AND ($3::boolean=false OR visibility='world' OR (visibility='private' AND source_markdown_slug=$4::text))${excludePrivate ? ` AND ${remoteProvenanceFloorSql('facts')}` : ''}`;
const lockText = (excludePrivate: boolean) => `SELECT visibility,fact,${factWithdrawalSubjectSql('facts')} AS subject FROM facts WHERE id=$1 AND source_id=$2
        ${admit(excludePrivate)} FOR UPDATE`;

test('lockFactForWithdrawal sends the old claim lock, with and without the remote floor', async () => {
  const { engine, last } = recordingEngine();
  await engine.lockFactForWithdrawal({ id: 7, sourceId: 'src-a', worldOnly: true, memberPage: 'memory/members/alice-example', remoteFloor: false });
  expect(last()).toEqual({ text: lockText(false), params: [7, 'src-a', true, 'memory/members/alice-example'] });
  await engine.lockFactForWithdrawal({ id: 7, sourceId: 'src-a', worldOnly: false, memberPage: null, remoteFloor: true });
  expect(last()).toEqual({ text: lockText(true), params: [7, 'src-a', false, null] });
});

test('the commit writes send the old queue, page revision and forget reason statements', async () => {
  const { engine, last } = recordingEngine();
  await engine.queueWithdrawalReview('src-a', '7');
  expect(last()).toEqual({ text: `INSERT INTO decide_review_queue(kind,source_id,a_ref) VALUES ('withdraw',$1,$2) ON CONFLICT DO NOTHING`, params: ['src-a', '7'] });
  await engine.listSegmentedPagesBySlug('src-a', ['people/a', 'people/b']);
  expect(last()).toEqual({ text: `SELECT id,slug FROM pages
        WHERE source_id=$1 AND slug=ANY($2::text[]) AND body_storage='segmented'`, params: ['src-a', ['people/a', 'people/b']] });
  await engine.bumpWithdrawnPageRevisions('src-a', ['people/a']);
  expect(last()).toEqual({ text: `UPDATE pages SET knowledge_revision=gen_random_uuid(),text_projection_revision=NULL,embedding_signature=NULL
          WHERE source_id=$1 AND slug=ANY($2::text[]) AND body_storage<>'segmented' RETURNING id,slug,knowledge_revision`, params: ['src-a', ['people/a']] });
  await engine.readPageRevisions([3, 4]);
  expect(last()).toEqual({ text: 'SELECT id,slug,knowledge_revision FROM pages WHERE id=ANY($1::int[])', params: [[3, 4]] });
  await engine.appendFactForgetReason(7, 'src-a', 'forgotten: wrong');
  expect(last()).toEqual({ text: `UPDATE facts SET context=concat_ws(' | ',NULLIF(context,''),$3::text)
        WHERE id=$1 AND source_id=$2`, params: [7, 'src-a', 'forgotten: wrong'] });
});

// The old single-prepare.ts text, rebuilt from its parts.
const seen = (param: number) => `(${remoteProvenanceFloorSql('f')} OR COALESCE(f.source_markdown_slug = $${param}::text, false))`;

test('the fact_withdrawn refusal reads send the old backing and withdrawal statements', async () => {
  const { engine, last } = recordingEngine();
  const spec = { sourceId: 'src-a', visibility: 'world', fact: 'Acme raised a seed', entitySlug: 'companies/acme-example', ownedPage: null, excludePrivate: true };
  await engine.readFactWithdrawnBacking(spec);
  expect(last()).toEqual({ text: `SELECT
        COALESCE(bool_or(${seen(5)}), false) AS visible,
        COALESCE(bool_or(NOT ${seen(5)}), false) AS hidden
      FROM facts f JOIN fact_withdrawals w ON w.source_id=f.source_id AND w.visibility=f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v2(f.fact),gbrain_fact_fingerprint_v1(f.fact))
        AND ${withdrawalReachedFactSql('w', 'f')}
      WHERE f.source_id=$1 AND f.visibility=$2 AND f.expired_at IS NOT NULL
        AND gbrain_fact_fingerprint(f.fact)=gbrain_fact_fingerprint($3) AND (w.subject='*' OR w.subject=$4::text OR w.subject=$5::text)`,
  params: ['src-a', 'world', 'Acme raised a seed', 'companies/acme-example', null] });
  const rowText = `SELECT w.subject,w.visibility,w.withdrawn_at::text AS withdrawn_at
    FROM fact_withdrawals w LEFT JOIN facts f ON f.source_id=w.source_id AND f.visibility=w.visibility AND f.expired_at IS NOT NULL
      AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v2(f.fact),gbrain_fact_fingerprint_v1(f.fact)) AND ${withdrawalReachedFactSql('w', 'f')}
    WHERE w.source_id=$1 AND w.visibility=$2 AND w.fact_hash IN (gbrain_fact_fingerprint($3),gbrain_fact_fingerprint_v2($3),gbrain_fact_fingerprint_v1($3))
      AND (w.subject='*' OR w.subject=$4::text OR w.subject=$6::text)
    GROUP BY w.subject,w.visibility,w.withdrawn_at
    HAVING $5::boolean=false OR COALESCE(bool_or(${seen(6)}), false) OR NOT COALESCE(bool_or(f.id IS NOT NULL), false)
    ORDER BY (w.subject<>'*') DESC, w.withdrawn_at DESC LIMIT 1`;
  await engine.readFactWithdrawnRow(spec);
  expect(last()).toEqual({ text: rowText, params: ['src-a', 'world', 'Acme raised a seed', 'companies/acme-example', true, null] });
  await engine.readFactWithdrawnRow({ ...spec, entitySlug: null, ownedPage: 'memory/members/alice-example', excludePrivate: false });
  expect(last()).toEqual({ text: rowText, params: ['src-a', 'world', 'Acme raised a seed', null, false, 'memory/members/alice-example'] });
});
