import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const database = process.env.PMBRAIN_METADATA_TEST_DATABASE_URL;
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let root: string;
let engine: BrainEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-metadata-test-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root;
  process.env.GBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  writeFileSync(join(root, '.pmbrain/config.json'), JSON.stringify({ engine: database ? 'postgres' : 'pglite' }));
  resetGateway();
  configureGateway({ embedding_model: 'ollama:metadata-test', embedding_dimensions: 3, env: {} });
  if (database) assertSafeE2eDatabaseUrl(database);
  engine = database ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(database ? { database_url: database } : {});
  await engine.initSchema();
  await engine.executeRaw(`CREATE TABLE metadata_write_audit (kind text)`);
  await engine.executeRaw(`CREATE FUNCTION record_metadata_write() RETURNS trigger AS $$
    BEGIN INSERT INTO metadata_write_audit VALUES (TG_ARGV[0]); RETURN NEW; END;
    $$ LANGUAGE plpgsql`);
  await engine.executeRaw(`CREATE TRIGGER metadata_hash_audit AFTER UPDATE OF embedded_text_hash ON content_chunks
    FOR EACH ROW EXECUTE FUNCTION record_metadata_write('hash')`);
  await engine.executeRaw(`CREATE TRIGGER metadata_signature_audit AFTER UPDATE OF embedding_signature ON pages
    FOR EACH ROW EXECUTE FUNCTION record_metadata_write('signature')`);
}, 60000);

afterAll(async () => {
  await engine?.disconnect();
  resetGateway();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  if (root) rmSync(root, { recursive: true, force: true });
}, 60000);

async function writes() {
  return (await engine.executeRaw<{ kind: string }>('SELECT kind FROM metadata_write_audit ORDER BY kind')).map(row => row.kind);
}

describe('分块派生元数据仅在值变化时写入', () => {
  test('无向量分批写入不重复更新空哈希与空签名，原文和搜索仍可用', async () => {
    await engine.putPage('metadata/no-vector', { title: '元数据写入测试', type: 'note', compiled_truth: '知识同步测试正文。' });
    await engine.executeRaw('TRUNCATE metadata_write_audit');
    for (let index = 0; index < 3; index++) {
      await engine.upsertChunks('metadata/no-vector', [{ chunk_index: index, chunk_text: `知识同步测试正文 ${index}`, chunk_source: 'compiled_truth' }], { replaceExisting: false });
    }
    expect(await writes()).toEqual([]);
    expect(await engine.getChunks('metadata/no-vector')).toHaveLength(3);
    expect((await engine.searchKeyword('知识同步', { limit: 10 })).some(row => row.slug === 'metadata/no-vector')).toBe(true);
  });

  test('向量生成、保留与正文变更仍更新真实哈希和签名', async () => {
    const slug = 'metadata/lifecycle';
    await engine.putPage(slug, { title: '生命周期', type: 'note', compiled_truth: '原正文' });
    await engine.executeRaw('TRUNCATE metadata_write_audit');
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: '原正文', chunk_source: 'compiled_truth', embedding: new Float32Array([0.1, 0.2, 0.3]), model: 'ollama:metadata-test' }]);
    expect(await writes()).toEqual(['hash', 'signature']);
    const state = () => engine.executeRaw<{ valid_hash: boolean; signature: string | null; has_vector: boolean }>(`SELECT
      cc.embedded_text_hash IS NOT DISTINCT FROM CASE WHEN cc.embedding IS NULL THEN NULL ELSE md5(cc.chunk_text) END AS valid_hash,
      p.embedding_signature AS signature, cc.embedding IS NOT NULL AS has_vector
      FROM pages p JOIN content_chunks cc ON cc.page_id = p.id WHERE p.slug = $1 AND p.source_id = 'default'`, [slug]);
    expect(await state()).toEqual([{ valid_hash: true, signature: 'ollama:metadata-test:3', has_vector: true }]);
    await engine.executeRaw('TRUNCATE metadata_write_audit');
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: '原正文', chunk_source: 'compiled_truth' }]);
    expect(await writes()).toEqual([]);
    expect(await state()).toEqual([{ valid_hash: true, signature: 'ollama:metadata-test:3', has_vector: true }]);
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: '更新后的正文', chunk_source: 'compiled_truth' }]);
    expect(await writes()).toEqual(['hash', 'signature']);
    expect(await state()).toEqual([{ valid_hash: true, signature: null, has_vector: false }]);
  });

  test('派生哈希已过期时仍会校正，同名页面的其他 Source 不受影响', async () => {
    const slug = 'metadata/scoped';
    await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('metadata-other','隔离测试源')");
    await engine.putPage(slug, { title: '主源', type: 'note', compiled_truth: '主源正文' });
    await engine.putPage(slug, { title: '其他源', type: 'note', compiled_truth: '其他源正文' }, { sourceId: 'metadata-other' });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: '主源正文', chunk_source: 'compiled_truth' }]);
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: '其他源正文', chunk_source: 'compiled_truth', embedding: new Float32Array([0.3, 0.2, 0.1]), model: 'ollama:metadata-test' }], { sourceId: 'metadata-other' });
    await engine.executeRaw(`UPDATE content_chunks SET embedded_text_hash = 'stale'
      WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'metadata-other')`, [slug]);
    await engine.executeRaw('TRUNCATE metadata_write_audit');
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: '其他源正文', chunk_source: 'compiled_truth' }], { sourceId: 'metadata-other' });
    expect(await writes()).toEqual(['hash']);
    const rows = await engine.executeRaw<{ source_id: string; valid_hash: boolean; signature: string | null }>(`SELECT p.source_id,
      cc.embedded_text_hash IS NOT DISTINCT FROM CASE WHEN cc.embedding IS NULL THEN NULL ELSE md5(cc.chunk_text) END AS valid_hash,
      p.embedding_signature AS signature FROM pages p JOIN content_chunks cc ON cc.page_id = p.id WHERE p.slug = $1 ORDER BY p.source_id`, [slug]);
    expect(rows).toEqual([
      { source_id: 'default', valid_hash: true, signature: null },
      { source_id: 'metadata-other', valid_hash: true, signature: 'ollama:metadata-test:3' },
    ]);
  });
});
