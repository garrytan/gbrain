/**
 * #6286 (P2.12, R9), Postgres arm: a sealed PGLite page copied by the legacy migrate copier reaches Postgres with its
 * origin, kind, provenance, ingested_at and aliases, and the migration's projection drain seals it there without
 * replacing its chunks, so an identical re-import skips. Synthetic content.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { copyPageToTarget } from '../../src/commands/migrate-engine.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const describePg = hasDatabase() ? describe : describe.skip;
const DB_URL = process.env.DATABASE_URL ?? '';
const body = '---\ntitle: Full Row\naliases: [Example Alias, EA]\n---\n\nA synthetic note about a full row.\n';
const rowOf = async (e: BrainEngine) => (await e.executeRaw<Record<string, unknown>>(
  `SELECT page_kind,source_path,effective_date_source,import_filename,source_kind,source_uri,ingested_via,ingested_at,
     (text_projection_revision IS NOT DISTINCT FROM knowledge_revision) AS sealed FROM pages WHERE slug='notes/full-row' AND source_id='default'`))[0]!;
const chunkIds = async (e: BrainEngine) => (await e.executeRaw<{ id: number }>(
  "SELECT id FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug='notes/full-row') ORDER BY id")).map(r => Number(r.id));

describePg('legacy migrate copier, PGLite to Postgres (#6286)', () => {
  let source: PGLiteEngine;
  let target: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => {
    source = new PGLiteEngine(); await source.connect({}); await source.initSchema();
    target = await isolatedPersistencePostgres(DB_URL);
  }, 120_000);
  afterAll(async () => { await source?.disconnect(); await target?.close(); });

  test('the full row travels, the drain seals the page and keeps its chunks, and a re-import skips', async () => {
    await importFromContent(source, 'notes/full-row', body, { sourcePath: 'notes/full-row.md', noEmbed: true });
    await source.executeRaw(`UPDATE pages SET source_kind='file',source_uri='file:///example/notes/full-row.md',ingested_via='sync',ingested_at='2022-01-02T03:04:05Z'
      WHERE slug='notes/full-row'`);
    const before = await rowOf(source);
    expect(before.sealed).toBe(true);
    await copyPageToTarget(source, target.engine, (await source.getPage('notes/full-row'))!);
    const after = await rowOf(target.engine);
    for (const key of ['page_kind', 'source_path', 'effective_date_source', 'import_filename', 'source_kind', 'source_uri', 'ingested_via']) expect(after[key]).toEqual(before[key]);
    expect(new Date(String(after.ingested_at)).toISOString()).toBe('2022-01-02T03:04:05.000Z');
    const [aliases] = await target.engine.executeRaw<{ n: number | string }>("SELECT count(*) AS n FROM page_aliases WHERE slug='notes/full-row' AND origin='frontmatter'");
    expect(Number(aliases!.n)).toBeGreaterThan(0);
    const [job] = await target.engine.executeRaw<{ reason: string }>("SELECT reason FROM page_projection_jobs WHERE slug='notes/full-row'");
    expect(job?.reason).toBe('engine_migration');
    const copied = await chunkIds(target.engine);
    expect(await drainProjections(target.engine, { reasons: ['engine_migration', 'rebuild_failed'] })).toMatchObject({ rebuilt: 1, failed: [], remaining: 0 });
    expect((await rowOf(target.engine)).sealed).toBe(true);
    expect(await chunkIds(target.engine)).toEqual(copied);
    const again = await importFromContent(target.engine, 'notes/full-row', body, { sourcePath: 'notes/full-row.md', noEmbed: true });
    expect(again.status).toBe('skipped');
    expect(await chunkIds(target.engine)).toEqual(copied);
  }, 120_000);
});
