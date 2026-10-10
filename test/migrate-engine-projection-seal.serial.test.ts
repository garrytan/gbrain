/**
 * #6286: a legacy engine migration must hand over a target whose unchanged
 * files a sync recognises as unchanged.
 *
 * The copier queues an `engine_migration` projection rebuild for every page
 * and left it queued, so each page reached the new engine unsealed. The first
 * sync then re-chunked every file-backed page even though its file had not
 * changed, and under --no-embed the new chunks had no vectors. The copy also
 * dropped `source_path`, `page_kind`, the code-chunk metadata and the import
 * columns (effective date, filename, provenance), so a drain rebuilt a code page
 * as markdown, could not keep its vectors, and nothing restored those columns
 * once the sync skipped the unchanged file.
 *
 * Two real PGLite engines, the CLI's own `runMigrateEngine`, and the sync and
 * code import a user runs next. Serial: it points GBRAIN_HOME at a temp dir
 * and writes config.json there.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { drainMigratedProjections, runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { queuePageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { saveConfig } from '../src/core/config.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const SOURCE_ID = 'migrate-seal-notes';
const CODE_PATH = 'src/ledger.ts';
const CODE = [
  '/** Synthetic ledger fixture. */',
  'export function addEntry(total: number, amount: number): number {',
  '  return total + amount;',
  '}',
  '',
  'export class Ledger {',
  '  balance = 0;',
  '  credit(amount: number): void { this.balance = addEntry(this.balance, amount); }',
  '}',
  '',
].join('\n');

interface ChunkRow { slug: string; id: number; chunk_text: string; symbol_name: string | null; has_vector: boolean }

async function chunkRows(engine: BrainEngine): Promise<ChunkRow[]> {
  const rows = await engine.executeRaw<ChunkRow>(`SELECT p.slug, cc.id, cc.chunk_text, cc.symbol_name,
      (cc.embedding IS NOT NULL) AS has_vector
    FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
    WHERE p.source_id=$1 ORDER BY p.slug, cc.chunk_index`, [SOURCE_ID]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** The page columns a sync no longer rewrites once it skips an unchanged file. */
async function pageRows(engine: BrainEngine) {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT slug, source_path, page_kind, effective_date::text, effective_date_source, import_filename,
            source_kind, source_uri, ingested_via, ingested_at::text, created_at::text,
            text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed
       FROM pages WHERE source_id=$1 ORDER BY slug`, [SOURCE_ID]);
}

/** Frontmatter alias rows, which only a full import or the copy writes. */
async function aliasRows(engine: BrainEngine) {
  return engine.executeRaw<{ slug: string; alias_norm: string }>(
    `SELECT slug, alias_norm FROM page_aliases WHERE source_id=$1 AND origin='frontmatter' ORDER BY slug, alias_norm`, [SOURCE_ID]);
}

/** Give every chunk of the source a vector under the brain's own model label. */
async function embedAll(engine: BrainEngine): Promise<void> {
  const dims = parseInt((await engine.getConfig('embedding_dimensions')) ?? '1536', 10);
  const vector = `[${Array.from({ length: dims }, (_, i) => (i === 0 ? 0.5 : 0)).join(',')}]`;
  const pages = await engine.executeRaw<{ id: number; slug: string }>('SELECT id, slug FROM pages WHERE source_id=$1', [SOURCE_ID]);
  for (const page of pages) {
    const prepared = await readProjectionSnapshot(engine, page.slug, SOURCE_ID);
    expect(prepared).not.toBeNull();
    await engine.executeRaw(`UPDATE content_chunks SET embedding=$2::vector, model=$3, embedded_at=now(),
      embedded_text_hash=md5(chunk_text) WHERE page_id=$1`, [page.id, vector, prepared!.embeddingModel]);
  }
}

describe('runMigrateEngine: legacy copy hands over sealed projections (#6286)', () => {
  const cleanup: string[] = [];
  const savedEnv = ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL'].map(key => [key, process.env[key]] as const);

  afterEach(() => {
    _resetCliExitVerdictForTests();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('a full sync and a code import of unchanged files after the migration rebuild nothing and keep every vector', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-6286-'));
    cleanup.push(root);
    delete process.env.DATABASE_URL;
    delete process.env.GBRAIN_DATABASE_URL;
    process.env.GBRAIN_HOME = join(root, 'home');
    mkdirSync(process.env.GBRAIN_HOME, { recursive: true });
    // The config engine only has to differ from the target for the guard.
    saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'notes'), { recursive: true });
    for (const name of ['alpha', 'beta']) {
      writeFileSync(join(repo, `notes/${name}.md`),
        `---\ntype: note\ntitle: ${name}\naliases: [${name} ledger]\n---\n\nSynthetic ${name} body. ${'Cedar line. '.repeat(30)}\n`);
    }
    for (const cmd of ['git init', 'git config user.email t@example.com', 'git config user.name T', 'git add -A', 'git commit -m seed']) {
      execSync(cmd, { cwd: repo, stdio: 'pipe' });
    }
    const syncOpts = { repoPath: repo, sourceId: SOURCE_ID, noPull: true, noEmbed: true, noExtract: true, full: true };
    const targetPath = join(root, 'target.pglite');
    const originalLog = console.log;

    const source = new PGLiteEngine();
    await source.connect({});
    await source.initSchema();
    let target: PGLiteEngine | null = null;
    try {
      _resetCliExitVerdictForTests();
      console.log = () => {};
      try {
        await runSources(source, ['add', SOURCE_ID, '--no-federated']);
        expect((await performSync(source, syncOpts)).added).toBe(2);
        expect((await importCodeFile(source, CODE_PATH, CODE, { noEmbed: true, sourceId: SOURCE_ID })).status).toBe('imported');
        await embedAll(source);
        // Neither importer writes these two, so one page gets them by hand.
        await source.executeRaw(`UPDATE pages SET source_kind='file-watcher', ingested_via='inbox-folder'
          WHERE source_id=$1 AND slug='notes/alpha'`, [SOURCE_ID]);
        await runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath]);
      } finally {
        console.log = originalLog;
      }
      expect(currentExitCode()).toBe(0);
      const sourcePages = await pageRows(source);
      expect(sourcePages.map(p => p.page_kind).sort()).toEqual(['code', 'markdown', 'markdown']);
      expect(sourcePages.filter(p => p.effective_date !== null && p.import_filename !== null && p.ingested_at !== null)).toHaveLength(2);
      expect(sourcePages.filter(p => p.source_kind !== null && p.ingested_via !== null).map(p => p.slug)).toEqual(['notes/alpha']);
      const sourceAliases = await aliasRows(source);
      expect(sourceAliases.map(a => a.slug)).toEqual(['notes/alpha', 'notes/beta']);

      target = new PGLiteEngine();
      await target.connect({ database_path: targetPath });
      // The copy carries each page's path and kind, and hands it over sealed
      // with nothing left in the rebuild queue.
      const handedOver = sourcePages.map(p => ({ ...p, sealed: true }));
      expect(await pageRows(target)).toEqual(handedOver);
      expect(await target.executeRaw('SELECT slug FROM page_projection_jobs')).toEqual([]);
      expect(await aliasRows(target)).toEqual(sourceAliases);
      const migrated = await chunkRows(target);
      expect(migrated.length).toBeGreaterThanOrEqual(3);
      expect(migrated.some(c => c.symbol_name !== null)).toBe(true);
      expect(migrated.every(c => c.has_vector)).toBe(true);

      // What the user runs next: the full sync and the code import find every
      // file unchanged, so no chunk is replaced and no vector is lost.
      console.log = () => {};
      let synced;
      let codeImport;
      try {
        synced = await performSync(target, syncOpts);
        codeImport = await importCodeFile(target, CODE_PATH, CODE, { noEmbed: true, sourceId: SOURCE_ID });
      } finally {
        console.log = originalLog;
      }
      expect(synced.status).toBe('first_sync');
      expect(synced.failedFiles ?? 0).toBe(0);
      expect(synced.chunksCreated).toBe(0);
      expect(codeImport.status).toBe('skipped');
      expect(await chunkRows(target)).toEqual(migrated);
      expect(await pageRows(target)).toEqual(handedOver);
    } finally {
      console.log = originalLog;
      await target?.disconnect();
      await source.disconnect();
    }
  }, 120_000);

  test('the rebuild replaces a stored chunk that is not a verified projection, and reports the pages it cannot or does not rebuild', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    try {
      // What the copy leaves behind for a page whose stored chunk was never a
      // verified projection of its body: old text, a vector under another model.
      await engine.putPage('notes/stale', { type: 'note', title: 'Stale', compiled_truth: 'Canonical harbor sentence.' });
      const vector = new Float32Array(parseInt((await engine.getConfig('embedding_dimensions')) ?? '1536', 10));
      vector[0] = 1;
      await engine.upsertChunks('notes/stale', [{ chunk_index: 0, chunk_source: 'compiled_truth',
        chunk_text: 'Outdated lantern sentence.', embedding: vector, model: 'synthetic:other-model' }]);
      await queuePageProjection(engine, 'default', 'notes/stale', 'engine_migration');
      // A code page with no recorded path cannot be rebuilt at all.
      await engine.putPage('src/orphan-ts', { type: 'code', title: 'orphan', compiled_truth: 'export const x = 1;\n', page_kind: 'code' });
      await queuePageProjection(engine, 'default', 'src/orphan-ts', 'engine_migration');
      // An image page is outside the keyless rebuild and its backlog count.
      await engine.putPage('media/diagram', { type: 'image', title: 'Diagram', compiled_truth: 'Synthetic diagram caption.', page_kind: 'image' });
      await queuePageProjection(engine, 'default', 'media/diagram', 'engine_migration');
      console.log = () => {};
      console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
      const result = await drainMigratedProjections(engine);
      expect(result?.rebuilt).toBe(1);
      expect(await engine.executeRaw(`SELECT cc.chunk_text, (cc.embedding IS NOT NULL) AS has_vector
        FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug='notes/stale'`))
        .toEqual([{ chunk_text: 'Canonical harbor sentence.', has_vector: false }]);
      expect((await engine.searchKeyword('harbor')).map(r => r.slug)).toEqual(['notes/stale']);
      expect(result?.failed.map(f => f.slug)).toEqual(['src/orphan-ts']);
      expect(warnings.join('\n')).toContain('default::src/orphan-ts: Code projection requires a recorded source path');
      expect(warnings.join('\n')).toContain('1 page(s) still queued for a rebuild: run `gbrain projections drain` before the first `gbrain sync`');
      expect(warnings.join('\n')).toContain('1 page(s) the keyless rebuild does not cover (image pages, pages of an archived source) stay queued');
      expect(await engine.executeRaw('SELECT slug FROM page_projection_jobs ORDER BY slug')).toEqual([{ slug: 'media/diagram' }, { slug: 'src/orphan-ts' }]);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      await engine.disconnect();
    }
  }, 60_000);

  test('a rebuild that cannot run warns with the next step and leaves the migration to finish', async () => {
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const unreachable = { executeRaw: async () => { throw new Error('connection lost'); } } as unknown as BrainEngine;
    try {
      console.log = () => {};
      console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
      expect(await drainMigratedProjections(unreachable)).toBeNull();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the rebuild stopped (connection lost)');
    expect(warnings[0]).toContain('run `gbrain projections drain` before the first `gbrain sync`');
  });
});
