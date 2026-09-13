import { beforeAll, beforeEach, afterAll, test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindex } from '../src/commands/reindex.ts';
import { reindexStoredMarkdownChunks } from '../src/core/reindex-markdown.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); });

async function seed(sourceId = 'default') {
  if (sourceId !== 'default') {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ($1,$1)", [sourceId]);
  }
  const body = '  Original body\n\n## Timeline\nThis heading belongs to the body.\n\n' +
    '<!--- gbrain:takes:begin -->\n```ts\nconst hidden = "PRIVATE_REINDEX_CANARY";\n```\n<!--- gbrain:takes:end -->\n' +
    '<!--- gbrain:takes:begin -->\nPRIVATE_REPEATED_CANARY\n<!--- gbrain:takes:end -->\n' +
    '```ts\nexport const visible = "PUBLIC_REINDEX_CANARY";\n```\n  ';
  await engine.putPage('legacy/page', {
    type: 'note', title: 'Canonical title', compiled_truth: body, timeline: 'Original timeline',
    frontmatter: { title: 'Conflicting legacy title', type: 'person', flag: 'true', count: 3 },
    content_hash: 'historical-extraction-provenance', source_path: 'legacy/original.md',
  }, { sourceId });
  await engine.addTag('legacy/page', 'curated-tag', { sourceId });
  await engine.upsertChunks('legacy/page', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'PRIVATE_OLD_VECTOR_CONTEXT' }], { sourceId });
  await engine.executeRaw("UPDATE pages SET chunker_version=1, updated_at='2000-01-01', effective_date='1999-01-01' WHERE source_id=$1", [sourceId]);
}

async function pageSnapshot(sourceId = 'default') {
  return (await engine.executeRaw<{ snapshot: unknown }>(
    "SELECT to_jsonb(p) - 'chunker_version' AS snapshot FROM pages p WHERE source_id=$1 AND slug='legacy/page'",
    [sourceId],
  ))[0].snapshot;
}

test('chunk-only reindex preserves every stored page field and tags while replacing unsafe chunks', async () => {
  await seed();
  const before = await pageSnapshot();
  const result = await runReindex(engine, ['--markdown', '--no-embed']);
  expect(result.reindexed).toBe(1);
  expect(await pageSnapshot()).toEqual(before);
  expect(await engine.getTags('legacy/page', { sourceId: 'default' })).toEqual(['curated-tag']);
  const rows = await engine.executeRaw<{ chunk_text: string; embedding: unknown }>('SELECT chunk_text,embedding FROM content_chunks');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.map(r => r.chunk_text).join('\n')).toContain('PUBLIC_REINDEX_CANARY');
  expect(rows.map(r => r.chunk_text).join('\n')).not.toContain('PRIVATE_');
  expect(rows.every(r => r.embedding == null)).toBe(true);
  const [page] = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages');
  expect(page.chunker_version).toBe(MARKDOWN_CHUNKER_VERSION);
});

test('same-slug pages in other sources retain their old chunks and seal', async () => {
  await seed(); await seed('another-source');
  const before = await pageSnapshot('another-source');
  await reindexStoredMarkdownChunks(engine, 'legacy/page', 'default');
  expect(await pageSnapshot('another-source')).toEqual(before);
  const [other] = await engine.executeRaw<{ chunker_version: number; chunk_text: string }>(
    "SELECT p.chunker_version,c.chunk_text FROM pages p JOIN content_chunks c ON c.page_id=p.id WHERE p.source_id='another-source'", []);
  expect(other.chunker_version).toBe(1);
  expect(other.chunk_text).toBe('PRIVATE_OLD_VECTOR_CONTEXT');
});

test('a failed chunk insert rolls back deletion and never seals old fragments', async () => {
  await seed();
  await engine.executeRaw(`CREATE FUNCTION fail_reindex_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic insert failure'; END $$`, []);
  await engine.executeRaw('CREATE TRIGGER fail_reindex_insert BEFORE INSERT ON content_chunks FOR EACH ROW EXECUTE FUNCTION fail_reindex_insert()', []);
  try {
    await expect(reindexStoredMarkdownChunks(engine, 'legacy/page', 'default')).rejects.toThrow('synthetic insert failure');
    const [row] = await engine.executeRaw<{ chunker_version: number; chunk_text: string }>(
      'SELECT p.chunker_version,c.chunk_text FROM pages p JOIN content_chunks c ON c.page_id=p.id', []);
    expect(row.chunker_version).toBe(1);
    expect(row.chunk_text).toBe('PRIVATE_OLD_VECTOR_CONTEXT');
  } finally {
    await engine.executeRaw('DROP TRIGGER fail_reindex_insert ON content_chunks', []);
    await engine.executeRaw('DROP FUNCTION fail_reindex_insert()', []);
  }
});

test('concurrent body changes fail before replacing or sealing chunks', async () => {
  await seed();
  const realTransaction = engine.transaction.bind(engine);
  engine.transaction = (async (work: Parameters<typeof engine.transaction>[0]) => {
    await engine.executeRaw("UPDATE pages SET compiled_truth='Concurrent content' WHERE source_id='default'", []);
    return realTransaction(work);
  }) as typeof engine.transaction;
  try {
    await expect(reindexStoredMarkdownChunks(engine, 'legacy/page', 'default')).rejects.toThrow('Page changed');
  } finally { engine.transaction = realTransaction; }
  const [row] = await engine.executeRaw<{ compiled_truth: string; chunker_version: number }>('SELECT compiled_truth,chunker_version FROM pages', []);
  expect(row.compiled_truth).toBe('Concurrent content');
  expect(row.chunker_version).toBe(1);
});
