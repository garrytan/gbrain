/**
 * The chunk reseal members (src/core/engine-sql/projection-rebuild.ts) send Postgres the statement text and binds
 * planProjectionKeep, installPageProjection and resealSafeChunks (src/core/page-state/projections.ts) sent through
 * `executeRaw` before they had members. A drift here changes a query plan or a result on Postgres alone, which PGLite
 * parity cannot see.
 *
 * Protects: each member's text and binds equal the old raw statements (the texts below were recorded from the raw callers
 * before the move; the same texts the rust-rebuild-path lane pinned). The keep read and the vector clear are composed with
 * sqlFragment, which numbers placeholders in text order: they are compared with each placeholder replaced by the value it
 * binds, so only the numbering may differ; the clear and the pending count match byte for byte. Fails when a member
 * reorders a clause, binds a value differently or in a different place. No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql, type Responder } from './helpers/fake-postgres-sql.ts';

function recordingEngine(responder?: Responder) {
  const fake = makeFakeSql(responder);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const last = () => {
    const s = fake.statements().at(-1)!;
    return { text: s.text, params: s.params };
  };
  return { engine, fake, last };
}

/** The statement with each `$n` replaced by the value it binds: equal for two texts that differ only in numbering. */
function bound(statement: { text: string; params: unknown[] }): string {
  return statement.text.replace(/\$(\d+)/g, (_, n: string) => `<${JSON.stringify(statement.params[Number(n) - 1])}>`);
}

/** The raw statements, recorded before the move. */
const OLD = {
  keep: "SELECT id,embedding_input_hash,(\"embedding\" IS NOT NULL AND embedded_text_hash IS NOT DISTINCT FROM md5(chunk_text)) AND EXISTS (SELECT 1 FROM (SELECT $2::text AS m) target WHERE model IS NOT DISTINCT FROM target.m OR (model = substr(target.m, strpos(target.m, ':') + 1) AND vector_dims(\"embedding\") = 1536)) AS movable FROM content_chunks WHERE page_id=$1",
  clear: "UPDATE content_chunks SET \"embedding\"=NULL,\n        embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,\n        embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE page_id=$1 AND\n        (NOT EXISTS (SELECT 1 FROM (SELECT $2::text AS m) target WHERE model IS NOT DISTINCT FROM target.m OR (model = substr(target.m, strpos(target.m, ':') + 1) AND vector_dims(\"embedding\") = 1536)) OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY($3::int[])))",
  pending: "SELECT COUNT(*)::int AS chunks,\n    COALESCE(SUM(length(chunk_text)),0)::int AS chars FROM content_chunks\n    WHERE page_id=$1 AND \"embedding\" IS NULL AND modality='text'",
};

const COLUMN = { name: 'embedding', dimensions: 1536 };

test('the keep plan read sends the recorded statement', async () => {
  const { engine, last } = recordingEngine();
  expect(await engine.readChunkKeepState(9, 'openai:text-embedding-3-large', COLUMN)).toEqual([]);
  expect(bound(last())).toBe(bound({ text: OLD.keep, params: [9, 'openai:text-embedding-3-large'] }));
  await engine.readChunkKeepState(9, null, COLUMN);
  expect(bound(last())).toBe(bound({ text: OLD.keep, params: [9, null] }));
});

test('the vector clear sends the recorded statement and binds', async () => {
  const { engine, last } = recordingEngine();
  await engine.clearUnkeptChunkVectors(9, null, COLUMN, [3, 4]);
  expect(last()).toEqual({ text: OLD.clear, params: [9, null, [3, 4]] });
});

test('the pending count sends the recorded statement and returns numbers', async () => {
  const { engine, last } = recordingEngine(() => [{ chunks: '2', chars: '7' }]);
  expect(await engine.countPendingTextChunks(9, COLUMN)).toEqual({ chunks: 2, chars: 7 });
  expect(last()).toEqual({ text: OLD.pending, params: [9] });
});
