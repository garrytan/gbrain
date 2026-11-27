/**
 * The typed withdrawal discovery reads (src/core/engine-sql/withdrawal-discovery.ts) send Postgres the statement text
 * and binds discoverWithdrawalTargets (src/core/facts/withdrawal-discovery.ts) sent through `executeRaw` before the
 * reads had one member. A drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each kind's recorded text and params equal the old raw statement byte for byte. The old text is rebuilt
 * from the old templates and their builders (onOwnedMemoryPageSql('f'), the LIKE ALL shortlist and the slot text), so
 * the constant copy of the owned-memory-page clause fails here when the builder changes. The keys and claims bind as
 * the same JSON text, the cursors and subjects in the old order (segment rows bind the occurrence cursor last, as $6).
 * Fails when a kind reorders a clause, renumbers a placeholder or binds a value differently.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { onOwnedMemoryPageSql } from '../src/core/access/member-facts.ts';
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
const shortlist = (text: string) => `lower(${text}) LIKE ALL(k.patterns)`;
const slotText = `convert_from(substring(t.body from (s->>'start')::int + 1 for (s->>'end')::int - (s->>'start')::int),'UTF8')`;

test('claim_keys and provenance_pages send the old keying and provenance statements', async () => {
  const { engine, last } = recordingEngine();
  const claims = [{ visibility: 'world', fact_hash: 'h1', subject: '*', claim: 'Alice keeps bees' }, { visibility: 'private', fact_hash: 'h2', subject: 'people/e-example', claim: null }];
  await engine.readWithdrawalDiscovery({ kind: 'claim_keys', sourceId: 'src-a', claims });
  expect(last()).toEqual({
    text: `WITH w AS (
      SELECT w.visibility,w.fact_hash,COALESCE(w.subject,'*') AS subject,gbrain_fact_normalize(COALESCE(w.claim,
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint(f.fact)=w.fact_hash LIMIT 1),
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint_v2(f.fact)=w.fact_hash LIMIT 1),
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint_v1(f.fact)=w.fact_hash LIMIT 1))) AS norm
      FROM jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text,claim text)
    ) SELECT * FROM w`,
    params: ['src-a', JSON.stringify(claims)],
  });
  await engine.readWithdrawalDiscovery({ kind: 'provenance_pages', sourceId: 'src-a', keys });
  expect(last()).toEqual({
    text: `SELECT DISTINCT p.id
    FROM jsonb_to_recordset($2::text::jsonb) k(visibility text,fact_hash text,subject text,norm text)
    JOIN facts f ON f.source_id=$1 AND f.visibility=k.visibility
      AND gbrain_fact_fingerprint(f.fact)=COALESCE(encode(sha256(convert_to(k.norm,'UTF8')),'hex'),k.fact_hash)
      AND (k.subject='*' OR f.entity_slug=k.subject OR (${onOwnedMemoryPageSql('f')} AND f.source_markdown_slug=k.subject))
    JOIN pages p ON p.source_id=f.source_id AND p.slug=COALESCE(f.source_markdown_slug,f.entity_slug)`,
    params: ['src-a', JSON.stringify(keys)],
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
          AND w.fact_hash IN (gbrain_fact_fingerprint(i.claim),gbrain_fact_fingerprint_v2(i.claim),gbrain_fact_fingerprint_v1(i.claim))`,
    params: [JSON.stringify(incoming), JSON.stringify(keys)],
  });
});

test('inline_fence_pages and segment_fence_rows send the old shortlist statements with their cursors in the old order', async () => {
  const { engine, last } = recordingEngine();
  await engine.readWithdrawalDiscovery({ kind: 'inline_fence_pages', sourceId: 'src-a', keys, after: 5, limit: 128, subjects: ['notes/a'] });
  expect(last()).toEqual({
    text: `SELECT p.id,p.slug,p.compiled_truth,p.timeline FROM pages p
      WHERE p.source_id=$1 AND p.id>$3 AND ($5::text[] IS NULL OR p.slug=ANY($5::text[]))
        AND (strpos(p.compiled_truth,'gbrain:facts:')>0 OR strpos(p.timeline,'gbrain:facts:')>0)
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) k(subject text,patterns text[])
          WHERE (k.subject='*' OR k.subject=p.slug) AND ((${shortlist('p.compiled_truth')}) OR (${shortlist('p.timeline')})))
      ORDER BY p.id LIMIT $4`,
    params: ['src-a', JSON.stringify(keys), 5, 128, ['notes/a']],
  });
  await engine.readWithdrawalDiscovery({ kind: 'segment_fence_rows', sourceId: 'src-a', keys, after: [5, 9], limit: 128, subjects: null });
  expect(last()).toEqual({
    text: `SELECT p.id,m.occurrence_id::text AS occurrence_id,p.slug,
        ARRAY(SELECT ${slotText} FROM jsonb_array_elements(m.facts_slots) s WHERE NOT s ? 'open_start') AS fences
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb
        AND (m.page_id,m.occurrence_id)>($3::int,$6::bigint) AND ($5::text[] IS NULL OR p.slug=ANY($5::text[]))
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) k(subject text,patterns text[]), jsonb_array_elements(m.facts_slots) s
          WHERE (k.subject='*' OR k.subject=p.slug) AND NOT s ? 'open_start' AND ${shortlist(slotText)})
      ORDER BY m.page_id,m.occurrence_id LIMIT $4`,
    params: ['src-a', JSON.stringify(keys), 5, 128, null, 9],
  });
});

// Main join (da99c637a7): the cli-members line's caller (withdrawal-discovery.ts:85-86 at de72811022) compared and
// sorted the region with `m.region COLLATE "C"`; the join re-applied that byte order to main's member, so the pin
// carries it too.
test('split_fence_slots sends the old split fence statement', async () => {
  const { engine, last } = recordingEngine();
  await engine.readWithdrawalDiscovery({ kind: 'split_fence_slots', sourceId: 'src-a', subjects: ['notes/a'], after: [5, 'truth', 12], limit: 128 });
  expect(last()).toEqual({
    text: `SELECT m.page_id,p.slug,m.region,
        (s->>'open_start')::bigint::text AS open_start,sum((s->>'end')::bigint-(s->>'start')::bigint)::text AS bytes
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id CROSS JOIN LATERAL jsonb_array_elements(m.facts_slots) s
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb AND s ? 'open_start'
        AND ($2::text[] IS NULL OR p.slug=ANY($2::text[])) AND (m.page_id,m.region COLLATE "C",(s->>'open_start')::bigint)>($3::int,$4::text,$5::bigint)
      GROUP BY m.page_id,p.slug,m.region,(s->>'open_start')::bigint ORDER BY m.page_id,m.region COLLATE "C",(s->>'open_start')::bigint LIMIT $6`,
    params: ['src-a', ['notes/a'], 5, 'truth', 12, 128],
  });
});

// Main join (da99c637a7): the cli-members line's sample_slugs caller (withdrawal-discovery.ts:26 at de72811022) sorted
// `ORDER BY slug COLLATE "C" LIMIT 20`; the join re-applied that byte order to main's member. target_pages is unchanged.
test('target_pages and sample_slugs send the old page reads', async () => {
  const { engine, last } = recordingEngine();
  await engine.readWithdrawalDiscovery({ kind: 'target_pages', sourceId: 'src-a', ids: [3, 1] });
  expect(last()).toEqual({ text: 'SELECT slug,id AS page_id,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', params: ['src-a', [3, 1]] });
  await engine.readWithdrawalDiscovery({ kind: 'sample_slugs', sourceId: 'src-a', ids: [3, 1] });
  expect(last()).toEqual({ text: 'SELECT slug FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug COLLATE "C" LIMIT 20', params: ['src-a', [3, 1]] });
});
