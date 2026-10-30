/**
 * GBRA-156: the per-search vector statements (the ANN candidate statement,
 * the SQL cosine re-score) bind the query vector as text and cast it in SQL
 * (\`$1::text::vector\`). The vendored driver shares a described statement's
 * parameter types across runs and connections only for built-in types
 * (vendor/README.md, \`shared_types\`), so a \`$1::vector\` parameter (an
 * extension type) paid a describe round trip on every run under a
 * transaction-mode pooler (\`prepare=false\`): two of the serial steps of a
 * warm search at 66 ms RTT.
 *
 * Contract: on one connection with prepare=false, the second run of each
 * statement is executed without a describe, with the same results; the
 * cosine values equal the JavaScript cosine of the stored vectors. The plan
 * (HNSW index kept) is pinned by test/e2e/vector-plan-real-column-postgres.test.ts.
 * Regression that fails it on the base branch: every run describes first.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { cosineByChunkIdsStatement } from '../../src/core/engine-sql/chunks.ts';
import { cosineSimilarity } from '../../src/core/search/cosine-rescore.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { readSqlTrace } from '../helpers/statement-counter.ts';
import { seedPage } from '../helpers/keyword-paging-fixture.ts';
import { withEnv } from '../helpers/with-env.ts';

const run = process.env.DATABASE_URL ? describe : describe.skip;
let databaseUrl = '';
let dims = 0;
let close: () => Promise<void> = async () => {};
const dir = mkdtempSync(join(tmpdir(), 'gbrain-vector-describe-'));
const vector = (seed: number) => new Float32Array(dims).map((_, i) => Math.sin(i * 0.37 + seed));
const stored = new Map<number, Float32Array>();

run('vector statements skip the describe round trip', () => {
  beforeAll(async () => {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    close = isolated.close;
    databaseUrl = isolated.databaseUrl;
    const [column] = await isolated.engine.executeRaw<{ type: string }>(
      "SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'");
    dims = Number(/\((\d+)\)/.exec(column!.type)![1]);
    for (let i = 0; i < 6; i++) await seedPage(isolated.engine, 'notes/vector-describe-' + i, 'Vector describe fixture note ' + i + ' about the acme-example rollout.');
    const chunks = await isolated.engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks ORDER BY id');
    for (const [i, chunk] of chunks.entries()) {
      const v = vector(i + 1);
      stored.set(Number(chunk.id), v);
      await isolated.engine.executeRaw('UPDATE content_chunks SET embedding = $1::vector, embedded_text_hash = md5(chunk_text) WHERE id = $2', ['[' + Array.from(v).join(',') + ']', chunk.id]);
    }
    await isolated.engine.disconnect();
  }, 300_000);

  afterAll(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the second run of the ANN statement and of the cosine re-score is executed without a describe, with the same results', async () => {
    const trace = join(dir, 'trace.jsonl');
    const query = vector(0.5);
    const ids = [...stored.keys()];
    const results: Array<{ hits: unknown[]; cosines: Array<{ id: number; cosine: number }> }> = [];
    await withEnv({ GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'vector-describe' }, async () => {
      const engine = new PostgresEngine();
      await engine.connect({ database_url: databaseUrl + '?prepare=false', poolSize: 1 });
      try {
        for (let i = 0; i < 2; i++) {
          const hits = (await engine.searchVector(query, { limit: 5 })).map(h => [h.slug, h.chunk_id, h.score]);
          const { text, params } = cosineByChunkIdsStatement(ids, 'embedding', query);
          const cosines = (await engine.executeRaw<{ id: number; cosine: number }>(text, params)).map(r => ({ id: Number(r.id), cosine: Number(r.cosine) })).sort((a, b) => a.id - b.id);
          results.push({ hits, cosines });
        }
      } finally {
        await engine.disconnect();
      }
    });
    await Bun.sleep(1200);
    const records = readSqlTrace(trace).filter(r => r.kind === 'describe' || r.kind === 'execute');
    const kinds = (match: (sql: string) => boolean) => records.filter(r => match(r.sql)).map(r => r.kind);
    const annTexts = [...new Set(records.filter(r => r.sql.includes('<=> $1::')).map(r => r.sql))];
    const cosine = kinds(sql => sql.includes('vector_norm('));

    expect(results[0]!.hits.length).toBeGreaterThan(0);
    expect(results[1]).toEqual(results[0]!);
    expect(results[0]!.cosines.map(r => r.id)).toEqual(ids);
    for (const row of results[0]!.cosines) expect(row.cosine).toBeCloseTo(cosineSimilarity(query, stored.get(row.id)!), 5);
    expect(annTexts.length).toBeGreaterThan(0);
    for (const text of annTexts) expect(kinds(sql => sql === text)).toEqual(['describe', 'execute', 'execute']);
    expect(cosine).toEqual(['describe', 'execute', 'execute']);
  }, 120_000);
});
