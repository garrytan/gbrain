/**
 * The members behind `embedStalePages`, `stampIfPageProvenanceComplete` (embed-stale.ts) and `installCodeChunkEdges`
 * (code-chunks.ts) send Postgres the statement text and binds those callers sent through `executeRaw` before they had
 * members. A drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: `clearCodeEdgesLeavingChunks` sends the recorded statements byte for byte; `readPageProvenanceComplete` sends the recorded
 * statement with only its placeholder numbering changed (sqlFragment numbers in text order); both bind what the callers
 * bound (the texts below were recorded from the raw callers before the move);
 * `listVectorlessChunkIndexes` sends the statement of the segment-embed lane's member of that name
 * (origin/rust-engine/segment-embed), keyed on the page id, with the registry-active column quoted in. Fails when a member
 * reorders a clause or binds a value differently. No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql, type Responder } from './helpers/fake-postgres-sql.ts';

function recordingEngine(responder?: Responder) {
  const fake = makeFakeSql(responder);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const all = () => fake.statements().map(s => ({ text: s.text, params: s.params }));
  return { engine, all, last: () => all().at(-1)! };
}

/** The statement with each `$n` replaced by the value it binds: equal for two texts that differ only in numbering. */
function bound(statement: { text: string; params: unknown[] }): string {
  return statement.text.replace(/\$(\d+)/g, (_, n: string) => `<${JSON.stringify(statement.params[Number(n) - 1])}>`);
}

const OLD = {
  complete: "SELECT count(*) > 0\n              AND bool_and(COALESCE(cc.\"embedding\" IS NOT NULL\n              AND EXISTS (SELECT 1 FROM (SELECT $1::text AS m) target WHERE cc.model IS NOT DISTINCT FROM target.m OR (cc.model = substr(target.m, strpos(target.m, ':') + 1) AND TRUE))\n              AND cc.embedded_text_hash = md5(cc.chunk_text)\n              AND vector_dims(cc.\"embedding\") = $4::int, false)) AS complete\n         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id\n        WHERE p.slug = $2 AND p.source_id = $3 AND ((p.text_projection_revision = p.knowledge_revision) IS TRUE\n       AND (cc.body_generation IS NULL OR cc.body_generation <= p.body_generation))\n          AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)",
  vectorless: "SELECT cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id\n      WHERE cc.page_id = $1 AND cc.\"embedding\" IS NULL AND ((cc.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (cc.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = cc.page_id AND lm.occurrence_id = cc.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))",
  clearChunk: 'DELETE FROM code_edges_chunk WHERE from_chunk_id = ANY($1::int[])',
  clearSymbol: 'DELETE FROM code_edges_symbol WHERE from_chunk_id = ANY($1::int[])',
  clearBackfill: 'UPDATE content_chunks SET edges_backfilled_at=NULL WHERE id = ANY($1::int[])',
};

test('the provenance read sends the recorded statement and binds, and answers true only for a true complete', async () => {
  const { engine, last } = recordingEngine(() => [{ complete: true }]);
  expect(await engine.readPageProvenanceComplete('notes/a', 'default', 'openai:m', 1536, 'embedding')).toBe(true);
  // Composed with sqlFragment, which numbers placeholders in text order (model, width, slug, source): compared with each
  // placeholder replaced by the value it binds, so only the numbering may differ from the recorded text.
  expect(bound(last())).toBe(bound({ text: OLD.complete, params: ['openai:m', 'notes/a', 'default', 1536] }));
  const none = recordingEngine(() => []);
  expect(await none.engine.readPageProvenanceComplete('notes/a', 'default', 'm', null, 'embedding')).toBe(false);
  expect(bound(none.last())).toBe(bound({ text: OLD.complete, params: ['m', 'notes/a', 'default', null] }));
  const unknown = recordingEngine(() => [{ complete: null }]);
  expect(await unknown.engine.readPageProvenanceComplete('notes/a', 'default', 'm', 1, 'embedding')).toBe(false);
});

test('the vectorless read keys on the page id and returns numbers', async () => {
  const { engine, last } = recordingEngine(() => [{ chunk_index: '0' }, { chunk_index: 2 }]);
  expect(await engine.listVectorlessChunkIndexes(9, 'embedding')).toEqual([0, 2]);
  expect(last()).toEqual({ text: OLD.vectorless, params: [9] });
});

test('clearing the edges that leave chunks sends the three recorded statements, in order, and nothing for no chunk', async () => {
  const { engine, all } = recordingEngine();
  await engine.clearCodeEdgesLeavingChunks([]);
  expect(all()).toEqual([]);
  await engine.clearCodeEdgesLeavingChunks([3, 4]);
  expect(all()).toEqual([
    { text: OLD.clearChunk, params: [[3, 4]] },
    { text: OLD.clearSymbol, params: [[3, 4]] },
    { text: OLD.clearBackfill, params: [[3, 4]] },
  ]);
});
