/**
 * The typed withdrawal discovery reads (src/core/engine-sql/withdrawal-discovery.ts) send Postgres the statement text
 * and binds discoverWithdrawalTargets (src/core/facts/withdrawal-discovery.ts) sent through `executeRaw` before the
 * reads had one member. A drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each kind's recorded text and params equal the old raw statement byte for byte. The keys and claims bind as
 * the same JSON text, the cursors and subjects in the old order. The provenance and fence shortlists stay at their call site in this slice.
 * Fails when a kind reorders a clause, renumbers a placeholder or binds a value differently.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { WithdrawalDiscoveryKey } from '../src/core/engine-sql/withdrawal-discovery.ts';
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

const keys: WithdrawalDiscoveryKey[] = [
  { visibility: 'world', fact_hash: 'h1', subject: '*', norm: 'alice keeps bees', patterns: ['%alice%', '%keeps%', '%bees%'] },
  { visibility: 'private', fact_hash: 'h2', subject: 'people/e-example', norm: null, patterns: [] },
];

test('claim_keys sends the old keying statement', async () => {
  const { engine, last } = recordingEngine();
  const claims = [{ visibility: 'world', fact_hash: 'h1', subject: '*', claim: 'Alice keeps bees' }, { visibility: 'private', fact_hash: 'h2', subject: 'people/e-example', claim: null }];
  await engine.readWithdrawalDiscovery({ kind: 'claim_keys', sourceId: 'src-a', claims });
  expect(last()).toEqual({
    text: `WITH w AS (
      SELECT w.visibility,w.fact_hash,COALESCE(w.subject,'*') AS subject,gbrain_fact_normalize(COALESCE(w.claim,
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint(f.fact)=w.fact_hash LIMIT 1),
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint_v1(f.fact)=w.fact_hash LIMIT 1))) AS norm
      FROM jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text,claim text)
    ) SELECT * FROM w`,
    params: ['src-a', JSON.stringify(claims)],
  });
});

test('claim_matches sends the old fingerprint match statement', async () => {
  const { engine, last } = recordingEngine();
  const incoming = [{ id: 7, slug: 'notes/a', claim: 'Alice keeps bees', visibility: null, ambiguous: false }];
  await engine.readWithdrawalDiscovery({ kind: 'claim_matches', incoming, keys });
  expect(last()).toEqual({
    text: `SELECT DISTINCT i.id,i.ambiguous
      FROM jsonb_to_recordset($1::text::jsonb) i(id integer,slug text,claim text,visibility text,ambiguous boolean)
      JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text)
        ON (i.visibility IS NULL OR i.visibility=w.visibility) AND (w.subject='*' OR w.subject=i.slug)
          AND w.fact_hash IN (gbrain_fact_fingerprint(i.claim),gbrain_fact_fingerprint_v1(i.claim))`,
    params: [JSON.stringify(incoming), JSON.stringify(keys)],
  });
});

test('split_fence_slots sends the old split fence statement', async () => {
  const { engine, last } = recordingEngine();
  await engine.readWithdrawalDiscovery({ kind: 'split_fence_slots', sourceId: 'src-a', subjects: ['notes/a'], after: [5, 'truth', 12], limit: 128 });
  expect(last()).toEqual({
    text: `SELECT m.page_id,p.slug,m.region,
        (s->>'open_start')::bigint::text AS open_start,sum((s->>'end')::bigint-(s->>'start')::bigint)::text AS bytes
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id CROSS JOIN LATERAL jsonb_array_elements(m.facts_slots) s
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb AND s ? 'open_start'
        AND ($2::text[] IS NULL OR p.slug=ANY($2::text[])) AND (m.page_id,m.region,(s->>'open_start')::bigint)>($3::int,$4::text,$5::bigint)
      GROUP BY m.page_id,p.slug,m.region,(s->>'open_start')::bigint ORDER BY m.page_id,m.region,(s->>'open_start')::bigint LIMIT $6`,
    params: ['src-a', ['notes/a'], 5, 'truth', 12, 128],
  });
});

test('target_pages and sample_slugs send the old page reads', async () => {
  const { engine, last } = recordingEngine();
  await engine.readWithdrawalDiscovery({ kind: 'target_pages', sourceId: 'src-a', ids: [3, 1] });
  expect(last()).toEqual({ text: 'SELECT slug,id AS page_id,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', params: ['src-a', [3, 1]] });
  await engine.readWithdrawalDiscovery({ kind: 'sample_slugs', sourceId: 'src-a', ids: [3, 1] });
  expect(last()).toEqual({ text: 'SELECT slug FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug LIMIT 20', params: ['src-a', [3, 1]] });
});
