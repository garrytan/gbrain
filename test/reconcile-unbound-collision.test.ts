/**
 * `gbrain sources reconcile` for a database-only page that collides with a
 * canonical file at its slug-derived path (fix wave 3, Lane D; the #5254
 * unbound_source collision after a source is bound). Preview shows both sides
 * and changes neither; apply writes the chosen resolution through the owner
 * and records the file as the page's origin. PGLite always; Postgres when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-unbound-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (testBackends().includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

const databaseSide = '---\ntype: note\ntitle: Example\ndb_only_field: kept\n---\nWritten while the source had no canonical owner.\n';
const fileSide = '---\ntype: note\ntitle: Example\nfile_field: kept\n---\nWritten into the checkout on another host.\n';

async function collision(engine: BrainEngine, opts: { file?: string; gitSubdir?: boolean; marked?: boolean } = {}) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `unbound-${randomUUID().slice(0, 12)}`;
  // In a Git subfolder source, slugs (and source paths) are Git-root-relative.
  const repo = join(home, id), root = opts.gitSubdir ? join(repo, 'sub') : repo, slug = opts.gitSubdir ? 'sub/notes/example' : 'notes/example';
  mkdirSync(join(root, 'notes'), { recursive: true });
  if (opts.gitSubdir) execFileSync('git', ['init', '-q', repo]);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  // A database-only page: no recorded source path or file origin, as an unbound-source write leaves it.
  await importFromContent(engine, slug, databaseSide, { sourceId: id, noEmbed: true });
  // The durable #5254 marker the unbound publication stamps; reconcile matches only marked pages.
  if (opts.marked !== false) await engine.executeRaw("UPDATE pages SET database_only_reason='unbound_source' WHERE source_id=$1 AND slug=$2", [id, slug]);
  const [page] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>('SELECT source_path,source_uri FROM pages WHERE source_id=$1 AND slug=$2', [id, slug]);
  expect(page).toEqual({ source_path: null, source_uri: null });
  // After binding, a canonical file appears at the page's slug-derived path.
  const file = join(root, 'notes/example.md');
  writeFileSync(file, opts.file ?? fileSide);
  await claimWorktree(engine, id, root);
  const registration = await registerLocalWriter(engine, 'cli');
  return { id, slug, file, registration };
}

test('preview accepts a database-only page colliding with a canonical file, changes nothing, and apply resolves it', async () => {
  await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    for (const engine of engines) {
      const f = await collision(engine);
      const before = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
      await withVerifiedLocalRegistration(engine, f.registration, async () => {
        const preview = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
        expect(preview.relative_path).toBe('notes/example.md');
        expect(preview.status).toBe('needs_resolution');
        expect(preview.conflict_paths).toContain('/compiled_truth');
        expect(Buffer.from(preview.preview.preimages.file_base64, 'base64').toString()).toBe(fileSide);
        expect(preview.preview.preimages.database.page.compiled_truth).toContain('no canonical owner');
        expect(readFileSync(f.file, 'utf8')).toBe(fileSide);
        expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!.revision).toBe(before.revision);

        const resolved = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug, from: preview.preview,
          decisions: (preview.conflict_paths as string[]).map(path => ({ path, action: 'take_database' })) });
        expect(resolved.status).toBe('ready');
        const receipt = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: resolved.preview, request_id: randomUUID() });
        expect(receipt.state).toBe('committed');
        const current = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
        expect(current.page.compiled_truth).toContain('no canonical owner');
        expect(current.page.frontmatter).toMatchObject({ db_only_field: 'kept', file_field: 'kept' });
        expect(parseMarkdown(readFileSync(f.file, 'utf8'), f.slug).compiled_truth).toContain('no canonical owner');
        const [page] = await engine.executeRaw<{ source_path: string | null; database_only_reason: string | null }>(
          'SELECT source_path,database_only_reason FROM pages WHERE source_id=$1 AND slug=$2', [f.id, f.slug]);
        // The page now has a canonical origin, so the unbound_source doctor count no longer reports it.
        expect(page).toEqual({ source_path: 'notes/example.md', database_only_reason: null });
      });
    }
  });
}, 180_000);

test('a page without the durable unbound_source marker is never matched to a slug-derived file', async () => {
  await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    for (const engine of engines) {
      const f = await collision(engine, { marked: false });
      await withVerifiedLocalRegistration(engine, f.registration, async () => {
        await expect(runReconcilePreview(engine, { source_id: f.id, slug: f.slug })).rejects.toMatchObject({ code: 'source_changed' });
      });
      expect(readFileSync(f.file, 'utf8')).toBe(fileSide);
    }
  });
}, 180_000);

test('an identical file still becomes the page origin, and a Git subfolder source records the Git-root-relative path', async () => {
  await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    for (const engine of engines) {
      for (const opts of [{ file: databaseSide }, { gitSubdir: true, file: databaseSide }]) {
        const f = await collision(engine, opts);
        await withVerifiedLocalRegistration(engine, f.registration, async () => {
          const preview = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
          expect(preview.status).toBe('ready');
          const receipt = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: preview.preview, request_id: randomUUID() });
          expect(receipt.state).toBe('committed');
          const [page] = await engine.executeRaw<{ source_path: string | null }>('SELECT source_path FROM pages WHERE source_id=$1 AND slug=$2', [f.id, f.slug]);
          expect(page!.source_path).toBe(opts.gitSubdir ? 'sub/notes/example.md' : 'notes/example.md');
          expect(parseMarkdown(readFileSync(f.file, 'utf8'), f.slug).compiled_truth).toContain('no canonical owner');
        });
      }
    }
  });
}, 180_000);

test('a Git subfolder page never matches a source-relative file whose scanned slug is another page', async () => {
  await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const id = `unbound-${randomUUID().slice(0, 12)}`, repo = join(home, id), root = join(repo, 'docs');
      mkdirSync(join(root, 'architecture'), { recursive: true });
      execFileSync('git', ['init', '-q', repo]);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{"slug_root_mode":"git-root"}\')', [id, root]);
      // In Git-root mode this file's slug is docs/architecture/topologies, not architecture/topologies.
      await importFromContent(engine, 'architecture/topologies', databaseSide, { sourceId: id, noEmbed: true });
      await engine.executeRaw("UPDATE pages SET database_only_reason='unbound_source' WHERE source_id=$1 AND slug=$2", [id, 'architecture/topologies']);
      writeFileSync(join(root, 'architecture/topologies.md'), fileSide);
      await claimWorktree(engine, id, root);
      const registration = await registerLocalWriter(engine, 'cli');
      await withVerifiedLocalRegistration(engine, registration, async () => {
        await expect(runReconcilePreview(engine, { source_id: id, slug: 'architecture/topologies' })).rejects.toMatchObject({ code: 'source_changed' });
      });
      expect(readFileSync(join(root, 'architecture/topologies.md'), 'utf8')).toBe(fileSide);
    }
  });
}, 180_000);
