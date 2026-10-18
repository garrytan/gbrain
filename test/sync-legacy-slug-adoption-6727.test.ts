/**
 * #6727: an older gbrain imported a file under its raw path as the slug and recorded no origin (`source_path` NULL). The
 * current fold gives the same file another slug; with no page there, managed sync used to insert a second live page for
 * the same file. Now the one legacy page that folds to the file's slug is taken over (same id, slug and links) and records
 * the file; several such pages, or one whose slug the importer would lowercase, hold the file `legacy_slug_conflict`.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { gitHoldFix, readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-6727-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation about ${title}.\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => {
  for (const engine of engines) { try { await fn(engine); } finally { await disposePersistenceConsumer(engine); await engine.unsetConfig('sync.holds'); } }
});

/**
 * A managed source whose files an older gbrain imported under raw-path slugs: the files are imported, then each page's
 * slug is set back to its file's path without the extension, lowercased as the importer always wrote it (`rawCase` keeps
 * the path's case, a slug no importer writes), its origin and import record are dropped, and the source's checkpoint is
 * cleared so the next sync walks the whole tree, as a catch-up after an upgrade does. `extra` adds legacy rows no file
 * backs (a copy of the first file's page under another legacy slug).
 */
async function legacySource(engine: BrainEngine, files: Record<string, string>, extra: string[] = [], rawCase = false) {
  const id = `legacy-${randomUUID().slice(0, 8)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  expect((await sync()).status).toBe('first_sync');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw(`UPDATE pages SET slug=${rawCase ? '' : 'lower'}(regexp_replace(source_path, '\\.md$', '')), source_path=NULL WHERE source_id=$1 AND source_path NOT LIKE 'plain/%'`, [id]);
  for (const slug of extra) {
    await engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
      SELECT source_id, $2, type, title, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE source_id=$1 AND source_path IS NULL ORDER BY id LIMIT 1`, [id, slug]);
  }
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [SYNC_IMPORT_PROVENANCE_OP]);
  await engine.executeRaw('UPDATE sources SET last_commit=NULL WHERE id=$1', [id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const pages = async () => (await engine.executeRaw<{ id: number; slug: string; source_path: string | null }>(
    'SELECT id, slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [id])).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const ids = new Map((await pages()).map(page => [page.slug, Number(page.id)]));
  return { id, root, ids, pages, sync,
    held: async () => ((await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? []).map(hold => ({ path: hold.path, code: hold.code, slug: hold.slug, slugs: hold.meta.legacy_slugs })) };
}

// Each legacy slug is the file's path without its extension, lowercased; the current fold gives each a different slug.
const SHAPES: Record<string, string> = {
  'notes/Foo Bar.md': 'notes/foo bar',
  'notes/cards/🤖 foo - bar.md': 'notes/cards/🤖 foo - bar',
  'notes/cards/life/café-notes.md': 'notes/cards/life/café-notes',
  'summaries/group-.md': 'summaries/group-',
  'courses/x/example 2  question.md': 'courses/x/example 2  question',
  'notes/pdf/《Some Title》course-draft（1-1）.md': 'notes/pdf/《some title》course-draft（1-1）',
};

test('#6727 a file whose legacy page predates the slug fold is imported into that page, never beside it', () => each(async engine => {
  for (const [path, slug] of Object.entries(SHAPES)) expect({ path, folds: slugifyPath(slug) !== slug }).toEqual({ path, folds: true });
  const s = await legacySource(engine, { ...Object.fromEntries(Object.keys(SHAPES).map(path => [path, note(path)])), 'plain/plain.md': note('plain') });
  const before = await s.pages();
  expect(before.map(page => page.slug)).toEqual([...Object.values(SHAPES), 'plain/plain'].sort());
  expect(['first_sync', 'synced']).toContain((await s.sync()).status);
  expect(await s.held()).toEqual([]);
  // One page per file: each legacy page kept its id and slug and now records its file.
  const pages = await s.pages();
  expect(pages.map(page => [page.slug, page.source_path, Number(page.id)])).toEqual(before.map(page => [page.slug,
    Object.entries(SHAPES).find(([, slug]) => slug === page.slug)?.[0] ?? 'plain/plain.md', s.ids.get(page.slug)!]));
  // The origin is recorded now, so the next sync changes nothing and still forks nothing.
  expect((await s.sync()).status).toBe('up_to_date');
  expect((await s.pages()).length).toBe(pages.length);
}), 180_000);

test('#6727 a legacy page whose file moved on is held file_drift on that page; no second page is created', () => each(async engine => {
  const s = await legacySource(engine, { 'notes/Foo Bar.md': note('Foo Bar') });
  writeFileSync(join(s.root, 'notes/Foo Bar.md'), note('Foo Bar, edited'));
  git(s.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qam', 'edit');
  await s.sync();
  expect(await s.held()).toEqual([{ path: 'notes/Foo Bar.md', code: 'file_drift', slug: 'notes/foo bar', slugs: undefined }]);
  expect((await s.pages()).map(page => [page.slug, Number(page.id)])).toEqual([['notes/foo bar', s.ids.get('notes/foo bar')!]]);
}), 180_000);

test('#6727 several legacy pages that fold to one file hold it until a person keeps one', () => each(async engine => {
  const s = await legacySource(engine, { 'notes/Foo Bar.md': note('Foo Bar'), 'notes/other.md': note('other') }, ['notes/foo  bar']);
  await s.sync();
  expect(await s.held()).toEqual([{ path: 'notes/Foo Bar.md', code: 'legacy_slug_conflict', slug: 'notes/foo-bar', slugs: ['notes/foo  bar', 'notes/foo bar'] }]);
  expect((await s.pages()).map(page => page.slug)).toEqual(['notes/foo  bar', 'notes/foo bar', 'notes/other']);
  // The person keeps notes/foo bar: the other legacy row is soft-deleted (#6212 admits its legacy slug), and the next sync takes the kept page over.
  const ctx = { engine, config: { engine: engine.kind }, sourceId: s.id, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  const doomed = await engine.readPageSnapshot('notes/foo  bar', { sourceId: s.id });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/foo  bar', request_id: randomUUID(), expected_revision: doomed!.revision } });
  await s.sync();
  expect(await s.held()).toEqual([]);
  expect((await s.pages()).map(page => [page.slug, page.source_path, Number(page.id)]))
    .toEqual([['notes/foo bar', 'notes/Foo Bar.md', s.ids.get('notes/foo bar')!], ['notes/other', 'notes/other.md', s.ids.get('notes/other')!]]);
}), 180_000);

test('#6727 one legacy page under a slug the importer cannot write (capitals) holds the file rather than forking it', () => each(async engine => {
  const s = await legacySource(engine, { 'notes/Foo Bar.md': note('Foo Bar') }, [], true);
  await s.sync();
  expect(await s.held()).toEqual([{ path: 'notes/Foo Bar.md', code: 'legacy_slug_conflict', slug: 'notes/foo-bar', slugs: ['notes/Foo Bar'] }]);
  expect((await s.pages()).map(page => [page.slug, page.source_path, Number(page.id)])).toEqual([['notes/Foo Bar', null, s.ids.get('notes/Foo Bar')!]]);
  // No command addresses a slug with capitals (writes lowercase it), so the named exit is the file's: renamed to a name
  // that folds elsewhere, it imports as a new page beside the legacy one and its hold clears.
  git(s.root, 'mv', 'notes/Foo Bar.md', 'notes/foo-bar-imported.md');
  git(s.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'rename');
  await s.sync();
  expect(await s.held()).toEqual([]);
  expect((await s.pages()).map(page => [page.slug, page.source_path])).toEqual([['notes/Foo Bar', null], ['notes/foo-bar-imported', 'notes/foo-bar-imported.md']]);
}), 180_000);

test('#6727 a database-only page (never imported from a file) is not taken over by a file whose slug it folds to', () => each(async engine => {
  const s = await legacySource(engine, { 'notes/Foo Bar.md': note('Foo Bar') });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("UPDATE pages SET database_only_reason='unbound_source' WHERE source_id=$1", [s.id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await s.sync();
  expect(await s.held()).toEqual([]);
  expect((await s.pages()).map(page => [page.slug, page.source_path])).toEqual([['notes/foo bar', null], ['notes/foo-bar', 'notes/Foo Bar.md']]);
}), 180_000);

test('#6729 x #6727 a legacy page whose explicit frontmatter id differs from the file\'s is not taken over; the file is held', () => each(async engine => {
  const s = await legacySource(engine, { 'notes/Foo Bar.md': '---\ntitle: Foo Bar\nid: doc-a\n---\nA synthetic observation.\n' });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter || '{"id":"doc-b"}'::jsonb WHERE source_id=$1`, [s.id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await s.sync();
  const holds = (await readGitSourceHolds(engine, { sourceIds: [s.id] }))[0]?.holds ?? [];
  expect(holds.map(hold => ({ path: hold.path, code: hold.code, reason: hold.meta.reason, slugs: hold.meta.legacy_slugs })))
    .toEqual([{ path: 'notes/Foo Bar.md', code: 'legacy_slug_conflict', reason: 'explicit_id_conflict', slugs: ['notes/foo bar'] }]);
  expect((await s.pages()).map(page => [page.slug, page.source_path, Number(page.id)])).toEqual([['notes/foo bar', null, s.ids.get('notes/foo bar')!]]);
  // The hold's exit works: its docs anchor exists, it names both ways out, and the next sync re-screens it.
  const fix = gitHoldFix(holds[0]!);
  expect(fix.docs).toBe('docs/guides/write-refusals.md#legacy_slug_conflict-explicit_id_conflict');
  expect(readFileSync(join(import.meta.dir, '..', 'docs/guides/write-refusals.md'), 'utf8')).toContain('<a id="legacy_slug_conflict-explicit_id_conflict"></a>');
  expect(fix.user_message).toContain("give the file the page's id");
  expect(fix.user_message).toContain(`gbrain delete --source ${s.id} -- 'notes/foo bar'`);
  expect(fix.then?.argv).toEqual(['gbrain', 'sync', '--source', s.id, '--no-pull']);
  writeFileSync(join(s.root, 'notes/Foo Bar.md'), '---\ntitle: Foo Bar\nid: doc-b\n---\nA synthetic observation.\n');
  git(s.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qam', 'same id');
  await s.sync();
  expect(await s.held()).toEqual([]);
  expect((await s.pages()).map(page => [page.slug, page.source_path, Number(page.id)])).toEqual([['notes/foo bar', 'notes/Foo Bar.md', s.ids.get('notes/foo bar')!]]);
}), 180_000);

test('#6727 with sync.holds=fail the ambiguous file stops the run instead of creating a page', () => each(async engine => {
  const s = await legacySource(engine, { 'notes/Foo Bar.md': note('Foo Bar') }, ['notes/foo  bar']);
  await engine.setConfig('sync.holds', 'fail');
  const error = await s.sync().then(() => null, (caught: { code?: string; message?: string }) => caught);
  expect(error?.code).toBe('page_identity_changed');
  expect(error?.message).toContain('Legacy pages sync cannot import into match the imported file.');
  expect((await s.pages()).map(page => page.slug)).toEqual(['notes/foo  bar', 'notes/foo bar']);
}), 180_000);
