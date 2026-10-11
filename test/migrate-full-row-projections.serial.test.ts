/**
 * #6286 (P2.12, R9): the legacy migrate copier forwarded six page fields, so the new active brain lost each page's
 * origin (`source_path`), kind, provenance, `ingested_at`, frontmatter aliases and code-chunk metadata at the config
 * flip, and every copied page stayed queued for a projection rebuild: the first sync replaced its chunks (re-embedding
 * them, or losing the vectors under `--no-embed`). The copier now forwards the full row, and `runMigrateEngine` drains
 * the target's projections before it flips the config; a page whose rebuild fails blocks the flip. Synthetic content.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPageToTarget, runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { drainProjections } from '../src/core/page-state/projections.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { loadConfigFileOnly, saveConfig } from '../src/core/config.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const body = (title: string) => `---\ntitle: ${title}\naliases: [Example Alias, EA]\n---\n\nA synthetic note about ${title}.\n`;
afterEach(() => _resetCliExitVerdictForTests());

async function fresh(path?: string) { const e = new PGLiteEngine(); await e.connect(path ? { database_path: path } : {}); await e.initSchema(); return e; }
const rowOf = async (e: PGLiteEngine, slug: string) => (await e.executeRaw<Record<string, unknown>>(
  `SELECT page_kind,source_path,effective_date_source,import_filename,source_kind,source_uri,ingested_via,ingested_at::text AS ingested_at,
     (text_projection_revision IS NOT DISTINCT FROM knowledge_revision) AS sealed FROM pages WHERE slug=$1 AND source_id='default'`, [slug]))[0];
const aliasesOf = async (e: PGLiteEngine, slug: string) => (await e.executeRaw<{ alias_norm: string }>(
  "SELECT alias_norm FROM page_aliases WHERE slug=$1 AND source_id='default' AND origin='frontmatter' ORDER BY alias_norm", [slug])).map(r => r.alias_norm);

describe('copyPageToTarget forwards the full row (#6286)', () => {
  test('origin, kind, provenance, ingested_at, aliases and chunk metadata survive; after the drain an identical re-import skips and keeps chunk ids', async () => {
    const source = await fresh(), target = await fresh();
    try {
      await importFromContent(source, 'notes/full-row', body('Full Row'), { sourcePath: 'notes/full-row.md', noEmbed: true });
      await source.executeRaw(`UPDATE pages SET source_kind='file',source_uri='file:///example/notes/full-row.md',ingested_via='sync',ingested_at='2022-01-02T03:04:05Z'
        WHERE slug='notes/full-row'`);
      await source.executeRaw("UPDATE content_chunks SET language='markdown',symbol_name='Example',start_line=1,end_line=4 WHERE page_id=(SELECT id FROM pages WHERE slug='notes/full-row')");
      const before = await rowOf(source, 'notes/full-row');
      expect(before!.source_path).toBe('notes/full-row.md');
      await copyPageToTarget(source, target, (await source.getPage('notes/full-row'))!);
      const after = await rowOf(target, 'notes/full-row');
      for (const key of ['page_kind', 'source_path', 'effective_date_source', 'import_filename', 'source_kind', 'source_uri', 'ingested_via']) expect(after![key]).toEqual(before![key]);
      expect(new Date(String(after!.ingested_at)).toISOString()).toBe('2022-01-02T03:04:05.000Z');
      expect(await aliasesOf(target, 'notes/full-row')).toEqual(await aliasesOf(source, 'notes/full-row'));
      expect((await aliasesOf(target, 'notes/full-row')).length).toBeGreaterThan(0);
      const [chunk] = await target.executeRaw<{ language: string | null; symbol_name: string | null; start_line: number | null }>(
        "SELECT language,symbol_name,start_line FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug='notes/full-row') ORDER BY chunk_index LIMIT 1");
      expect(chunk).toMatchObject({ language: 'markdown', symbol_name: 'Example', start_line: 1 });
      expect(after!.sealed).toBe(false);
      const drained = await drainProjections(target);
      expect(drained).toMatchObject({ failed: [], remaining: 0 });
      expect((await rowOf(target, 'notes/full-row'))!.sealed).toBe(true);
      const ids = async () => (await target.executeRaw<{ id: number }>("SELECT id FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug='notes/full-row') ORDER BY id")).map(r => r.id);
      const idsBefore = await ids();
      const again = await importFromContent(target, 'notes/full-row', body('Full Row'), { sourcePath: 'notes/full-row.md', noEmbed: true });
      expect(again.status).toBe('skipped');
      expect(await ids()).toEqual(idsBefore);
    } finally { await source.disconnect(); await target.disconnect(); }
  }, 120_000);
});

describe('runMigrateEngine drains the target before the flip (#6286)', () => {
  test('a clean legacy migration leaves the target sealed with nothing queued, and flips the config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-6286-home-'));
    const targetPath = join(mkdtempSync(join(tmpdir(), 'gbrain-6286-target-')), 'brain.pglite');
    const source = await fresh();
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });
        for (const n of ['a', 'b', 'c']) await importFromContent(source, `notes/${n}`, body(n.toUpperCase()), { sourcePath: `notes/${n}.md`, noEmbed: true });
        await runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath]);
        expect(loadConfigFileOnly()).toMatchObject({ engine: 'pglite', database_path: targetPath });
      });
      const target = await fresh(targetPath);
      try {
        const [queue] = await target.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM page_projection_jobs');
        expect(Number(queue!.n)).toBe(0);
        for (const n of ['a', 'b', 'c']) expect(await rowOf(target, `notes/${n}`)).toMatchObject({ sealed: true, source_path: `notes/${n}.md` });
      } finally { await target.disconnect(); }
    } finally { await source.disconnect(); rmSync(home, { recursive: true, force: true }); }
  }, 180_000);
});
