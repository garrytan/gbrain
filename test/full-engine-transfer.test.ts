import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { inspectCompleteBrain, transferCompleteBrain } from '../src/commands/full-engine-transfer.ts';
import { DatabaseRuntimeManager } from '../desktop/src/main/database-runtime-manager.ts';
import { alignEmbeddingDimension } from '../src/core/embedding-dimension-alignment.ts';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-full-transfer-'));
let source: PGLiteEngine;
let target: PGLiteEngine;

beforeAll(async () => {
  source = new PGLiteEngine();
  target = new PGLiteEngine();
  await source.connect({ engine: 'pglite', database_path: join(root, 'source.pglite') });
  await source.initSchema();
  await target.connect({ engine: 'pglite', database_path: join(root, 'target.pglite') });
  await target.initSchema();
}, 120000);

afterAll(async () => {
  await source.disconnect();
  await target.disconnect();
  rmSync(root, { recursive: true, force: true });
}, 120000);

describe('complete engine transfer', () => {
  test('keeps pages, chunks, tags, source configuration, and application configuration', async () => {
    await alignEmbeddingDimension(source, 1024, { requireEmpty: true });
    await source.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding_image TYPE vector(1024)');
    await source.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding_multimodal TYPE vector(1024)');
    await source.executeRaw('ALTER TABLE takes ALTER COLUMN embedding TYPE vector(1536)');
    await source.putPage('transfer-original', {
      type: 'note', title: '迁移原文', compiled_truth: '保留正文',
      timeline: '', frontmatter: {}, content_hash: 'transfer-hash',
    });
    await source.upsertChunks('transfer-original', [{
      chunk_index: 0, chunk_text: '原始分块', chunk_source: 'compiled_truth',
    }]);
    const vector = `[${Array.from({ length: 1024 }, (_, index) => Math.sin(index + 1).toString()).join(',')}]`;
    await source.executeRaw("UPDATE content_chunks SET embedding = $1::vector WHERE chunk_text = '原始分块'", [vector]);
    await source.executeRaw('CREATE TABLE content_chunks_keep AS SELECT * FROM content_chunks');
    await source.executeRaw("UPDATE content_chunks SET chunk_text = '更新后的分块' WHERE chunk_text = '原始分块'");
    await source.addTag('transfer-original', '保留标签');
    await source.executeRaw("INSERT INTO tags (page_id, tag) SELECT p.id, 'batch-' || n::text FROM pages p CROSS JOIN generate_series(1, 205) AS n WHERE p.slug = 'transfer-original'");
    await source.setConfig('transfer.preference', '保留设置');
    const targetSchema = await target.getConfig('pmbrain.schema.version');
    const targetLedger = await target.executeRaw('SELECT * FROM pmbrain_schema_migrations ORDER BY namespace, version');
    await source.unsetConfig('pmbrain.schema.version');
    await source.setConfig('version', '130');
    await source.executeRaw("INSERT INTO facts (source_id, fact, kind, visibility, source) VALUES ('default', '迁移事实', 'fact', 'private', 'transfer-test')");
    await source.putPage('transfer-related', {
      type: 'person', title: '关联对象', compiled_truth: '关联内容',
      timeline: '', frontmatter: {}, content_hash: 'related-hash',
    });
    await source.addLink('transfer-original', 'transfer-related');
    await source.executeRaw('CREATE TABLE legacy_unknown (id integer)');
    await source.executeRaw('INSERT INTO legacy_unknown (id) VALUES (1)');

    const plan = await inspectCompleteBrain(source, target);
    expect(plan.tables.find(table => table.name === 'content_chunks_keep')).toMatchObject({ action: 'skip', rows: 1 });
    expect(plan.tables.find(table => table.name === 'content_chunks')).toMatchObject({ action: 'convert' });
    expect(plan.tables.find(table => table.name === 'legacy_unknown')).toMatchObject({ action: 'unknown', rows: 1, skippable: true });
    const progress: Array<{ name: string; copied: number; total: number }> = [];
    const receipt = await transferCompleteBrain(source, target, {
      planFingerprint: plan.fingerprint,
      skipUnknownTables: ['legacy_unknown'],
      onTableProgress: (name, copied, total) => progress.push({ name, copied, total }),
    });
    await source.executeRaw('DROP TABLE legacy_unknown');

    expect(receipt.status).toBe('verified');
    expect(receipt.excludedOperationalTables).toContain('pmbrain_schema_migrations');
    expect(await target.getConfig('pmbrain.schema.version')).toBe(targetSchema);
    expect(await target.getConfig('version')).toBe(targetSchema);
    expect(await target.executeRaw('SELECT * FROM pmbrain_schema_migrations ORDER BY namespace, version')).toEqual(targetLedger);
    expect(await source.getConfig('pmbrain.schema.version')).toBeNull();
    expect(progress).toContainEqual({ name: 'content_chunks', copied: 1, total: 1 });
    expect((await target.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
    expect((await target.getChunksWithEmbeddings('transfer-original')).map(chunk => chunk.chunk_text)).toContain('更新后的分块');
    expect(receipt.skippedTables).toContainEqual({ name: 'content_chunks_keep', rows: 1, reason: 'historical_backup' });
    expect(receipt.skippedTables).toContainEqual({ name: 'legacy_unknown', rows: 1, reason: 'unknown_approved' });
    expect((await target.executeRaw<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'content_chunks_keep'")).length).toBe(0);
    expect((await target.executeRaw<{ dims: number }>('SELECT vector_dims(embedding) AS dims FROM content_chunks WHERE embedding IS NOT NULL')).at(0)?.dims).toBe(1024);
    expect(await target.getTags('transfer-original')).toContain('保留标签');
    expect((await target.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM tags')).at(0)?.count).toBe(206);
    expect(await target.getConfig('transfer.preference')).toBe('保留设置');
    expect((await target.executeRaw<{ fact: string }>("SELECT fact FROM facts WHERE source = 'transfer-test'")).map(row => row.fact)).toEqual(['迁移事实']);
    expect((await target.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM page_links")).at(0)?.count).toBe(1);
    expect((await source.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
  }, 120000);

  test('refuses a populated target before changing either database', async () => {
    await expect(transferCompleteBrain(source, target)).rejects.toThrow('目标数据库非空');
    expect((await source.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
  });

  test('refuses an unknown nonempty legacy table instead of losing its rows', async () => {
    await source.executeRaw('CREATE TABLE unexpected_legacy_data (id integer)');
    await source.executeRaw('INSERT INTO unexpected_legacy_data (id) VALUES (1)');
    try {
      const plan = await inspectCompleteBrain(source, target);
      expect(plan.tables.find(table => table.name === 'unexpected_legacy_data')).toMatchObject({ action: 'unknown', rows: 1 });
      await expect(transferCompleteBrain(source, target)).rejects.toThrow('目标数据库缺少非空表 unexpected_legacy_data');
    } finally {
      await source.executeRaw('DROP TABLE unexpected_legacy_data');
    }
  }, 120000);

  test('does not treat a changed backup table as a registered historical backup', async () => {
    await source.executeRaw('ALTER TABLE content_chunks_keep ADD COLUMN legacy_marker text');
    try {
      const plan = await inspectCompleteBrain(source, target);
      expect(plan.tables.find(table => table.name === 'content_chunks_keep')).toMatchObject({ action: 'unknown', rows: 1 });
    } finally {
      await source.executeRaw('ALTER TABLE content_chunks_keep DROP COLUMN legacy_marker');
    }
  }, 120000);

  test('shows a new required target column in the plan before copying data', async () => {
    await target.executeRaw("ALTER TABLE tags ADD COLUMN migration_required text NOT NULL DEFAULT ''");
    await target.executeRaw('ALTER TABLE tags ALTER COLUMN migration_required DROP DEFAULT');
    try {
      const plan = await inspectCompleteBrain(source, target);
      expect(plan.tables.find(table => table.name === 'tags')).toMatchObject({ action: 'unknown', skippable: true });
    } finally {
      await target.executeRaw('ALTER TABLE tags DROP COLUMN migration_required');
    }
  }, 120000);

  describe('duplicate legacy Facts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pmbrain-duplicate-facts-'));
    let legacy: PGLiteEngine;
    let fresh: PGLiteEngine;

    beforeAll(async () => {
      await source.disconnect();
      await target.disconnect();
      legacy = new PGLiteEngine();
      fresh = new PGLiteEngine();
      await legacy.connect({ engine: 'pglite', database_path: join(directory, 'legacy.pglite') });
      await legacy.initSchema();
      await fresh.connect({ engine: 'pglite', database_path: join(directory, 'fresh.pglite') });
      await fresh.initSchema();
    }, 120000);

    afterAll(async () => {
      await fresh?.disconnect();
      await legacy?.disconnect();
      rmSync(directory, { recursive: true, force: true });
      await source.connect({ engine: 'pglite', database_path: join(root, 'source.pglite') });
      await target.connect({ engine: 'pglite', database_path: join(root, 'target.pglite') });
    }, 120000);

    test('preserves both Facts in the new database without changing the old database', async () => {
      await legacy.executeRaw('ALTER TABLE facts DROP CONSTRAINT facts_superseded_by_fkey');
      await legacy.executeRaw('ALTER TABLE facts DROP CONSTRAINT facts_pkey');
      await legacy.executeRaw("INSERT INTO facts (id, source_id, fact, source) VALUES (48, 'default', '旧事实一', 'test'), (48, 'default', '旧事实二', 'test')");
      const plan = await inspectCompleteBrain(legacy, fresh);
      expect(plan.tables.find(table => table.name === 'facts')).toMatchObject({ action: 'convert', rows: 2 });
      const receipt = await transferCompleteBrain(legacy, fresh, { planFingerprint: plan.fingerprint });
      expect(receipt.converted).toContainEqual({ rule: 'facts_duplicate_id', rows: 1 });
      expect(await fresh.executeRaw('SELECT fact FROM facts ORDER BY fact')).toEqual([{ fact: '旧事实一' }, { fact: '旧事实二' }]);
      expect((await fresh.executeRaw<{ count: number }>('SELECT COUNT(DISTINCT id)::int AS count FROM facts'))[0]?.count).toBe(2);
      expect((await legacy.executeRaw<{ count: number }>('SELECT COUNT(DISTINCT id)::int AS count FROM facts'))[0]?.count).toBe(1);
    }, 120000);
  });

  const dockerTest = process.env.PMBRAIN_REAL_DOCKER_TEST === '1' ? test : test.skip;
  dockerTest('copies a real PGLite brain into newly provisioned Docker Postgres', async () => {
    const provisioned = await new DatabaseRuntimeManager().provisionLocalPostgres();
    expect(provisioned.containerName).toMatch(/^pmbrain-postgres-[a-z0-9]{12}$/);
    expect(provisioned.volumeName).toMatch(/^pmbrain-postgres-data-[a-z0-9]{12}$/);
    const postgres = new PostgresEngine();
    try {
      await postgres.connect({ engine: 'postgres', database_url: provisioned.databaseUrl });
      expect(await postgres.executeRaw<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'pgcrypto') ORDER BY extname")).toEqual([]);
      await postgres.initSchema();
      expect((await postgres.executeRaw<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'pgcrypto') ORDER BY extname")).map(row => row.extname)).toEqual(['pg_trgm', 'pgcrypto', 'vector']);
      expect((await postgres.executeRaw<{ type: string }>('SELECT jsonb_typeof($1::text::jsonb) AS type', [JSON.stringify([{ probe: true }])])).at(0)?.type).toBe('array');
      const receipt = await transferCompleteBrain(source, postgres);
      expect(receipt.status).toBe('verified');
      expect((await postgres.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
      expect(receipt.skippedTables).toContainEqual({ name: 'content_chunks_keep', rows: 1, reason: 'historical_backup' });
      expect((await postgres.executeRaw<{ dims: number }>('SELECT vector_dims(embedding) AS dims FROM content_chunks WHERE embedding IS NOT NULL')).at(0)?.dims).toBe(1024);
      const takesType = await postgres.executeRaw<{ formatted: string }>("SELECT format_type(a.atttypid, a.atttypmod) AS formatted FROM pg_attribute a WHERE a.attrelid = 'takes'::regclass AND a.attname = 'embedding'");
      expect(takesType.at(0)?.formatted).toBe('vector(1536)');
      const sourceGeneration = await source.executeRaw<{ generation: string }>("SELECT generation::text AS generation FROM pages WHERE slug = 'transfer-original'");
      const targetGeneration = await postgres.executeRaw<{ generation: string }>("SELECT generation::text AS generation FROM pages WHERE slug = 'transfer-original'");
      expect(targetGeneration).toEqual(sourceGeneration);
      const triggers = await postgres.executeRaw<{ enabled: string }>("SELECT tgenabled AS enabled FROM pg_trigger WHERE tgrelid = 'pages'::regclass AND tgname = 'bump_page_generation_trg'");
      expect(triggers.at(0)?.enabled).toBe('O');
      expect((await postgres.executeRaw<{ fact: string }>("SELECT fact FROM facts WHERE source = 'transfer-test'")).map(row => row.fact)).toEqual(['迁移事实']);
      expect((await postgres.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM links')).at(0)?.count).toBe(1);
      expect((await source.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
    } finally {
      await postgres.disconnect();
      execFileSync('docker', ['rm', '-f', provisioned.containerName]);
      execFileSync('docker', ['volume', 'rm', provisioned.volumeName]);
    }
  }, 300000);
});
