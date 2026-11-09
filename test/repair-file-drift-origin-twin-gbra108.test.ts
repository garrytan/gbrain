/**
 * GBRA-108: the sync `file_drift` hold and `gbrain repair file-drift` read drift the same way for an origin twin with no
 * recorded file (what `gbrain repair origin-twins` detach leaves live). Sync imports the file at the twin's slug path into
 * it and holds the import `file_drift` when the two differ; the preview used to read the page as database-only and
 * answer `no_drift` (affected 0), so the suggested repair could not clear the hold and a script using the preview as
 * its drift check passed falsely. The page here is a legacy row: no import record, no ingest provenance, a body line
 * and a frontmatter key only in the database, and an external commit that appends a timeline bullet to the file.
 * Real PGLite with a claimed canonical Git worktree, real files and real commits; no seams.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const SLUG = 'notes/alpha-example';
const PATH = `${SLUG}.md`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const FILE = '---\ntype: concept\ntitle: Alpha Example\n---\n\nAlpha example is a placeholder.\n\n## Timeline\nPlain line one.\nPlain line two.\n';
const BULLET = '- 2026-10-01: an appended bullet';
const logger = { info() {}, warn() {}, error() {} };

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const setupRepo = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, PATH), FILE);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'page');
};
const preview = async (engine: BrainEngine, prefer: 'file' | 'database', expect?: string) =>
  (await repairRunner(engine, { apply: expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
    { explicit: true, sourceFlag: 'default', slugs: [SLUG], prefer, ...(expect ? { expect } : {}) });
const holds = (engine: BrainEngine) => engine.executeRaw<{ code: string; path: string }>(
  "SELECT completed_keys->0->>'code' AS code, completed_keys->0->>'path' AS path FROM op_checkpoints WHERE op='sync-hold'");
const row = async (engine: BrainEngine) => (await engine.executeRaw<{ source_path: string | null; database_only_reason: string | null; compiled_truth: string }>(
  'SELECT source_path, database_only_reason, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', ['default', SLUG]))[0]!;

/** The imported page turned into a legacy origin twin with no recorded file and database-only edits; `extra` runs in the same write. */
async function legacyTwin(engine: BrainEngine, extra?: (tx: BrainEngine) => Promise<unknown>): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
    await tx.executeRaw(`UPDATE pages SET knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL, updated_at=now() - interval '180 days',
      ingested_at=NULL, ingested_via=NULL, source_path=NULL, source_uri=NULL, database_only_reason='origin_twin',
      compiled_truth=compiled_truth || E'\\nA database-only line.', frontmatter=frontmatter || '{"status":"database-only"}'::jsonb
      WHERE source_id='default' AND slug=$1`, [SLUG]);
    await extra?.(tx);
  }, TEST_WRITE_ATTRIBUTION));
}

/** An external commit appends a timeline bullet to the twin's slug-path file; sync runs a full pass over it. */
async function externalEdit(engine: BrainEngine, root: string): Promise<void> {
  appendFileSync(join(root, PATH), `${BULLET}\n`);
  git(root, 'commit', '-qam', 'external edit');
  expect((await performManagedSync(engine, { ...OPTS, full: true })).status).toBe('synced');
}

/** A legacy origin twin whose file then gained a timeline bullet in an external commit, held `file_drift` by sync. */
async function heldLegacyTwin(engine: BrainEngine, root: string): Promise<void> {
  await legacyTwin(engine);
  await externalEdit(engine, root);
  expect(await holds(engine)).toEqual([{ code: 'file_drift', path: PATH }]);
}

test('a held origin twin is listed by the preview with an apply command, and --prefer database clears the hold', () => managedBrain(async ({ engine, root }) => {
  await heldLegacyTwin(engine, root);
  const planned = await preview(engine, 'database');
  expect(planned.residuals).toEqual({});
  expect(planned.affected).toBe(1);
  expect(planned.listing).toEqual([{ item: `default:${SLUG}`, class: 'prefer_database', detail: 'exactly the preferred side; adopts the file at its slug path' }]);
  expect((await preview(engine, 'database', planned.preview_hash!)).outcomes).toEqual({ repaired: 1 });
  await settleManagedGitEffects(engine);
  git(root, 'commit', '-qam', 'commit the repaired file');
  expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'synced' });
  expect(await holds(engine)).toEqual([]);
  expect(readFileSync(join(root, PATH), 'utf8')).toContain('A database-only line.');
  expect(await row(engine)).toMatchObject({ source_path: PATH, database_only_reason: null });
}, { setup: setupRepo }), 120000);

test('a held origin twin resolved --prefer file takes the file and clears the hold', () => managedBrain(async ({ engine, root }) => {
  await heldLegacyTwin(engine, root);
  const planned = await preview(engine, 'file');
  expect(planned.affected).toBe(1);
  expect(planned.listing?.[0]).toMatchObject({ item: `default:${SLUG}`, class: 'prefer_file' });
  expect((await preview(engine, 'file', planned.preview_hash!)).outcomes).toEqual({ repaired: 1 });
  await settleManagedGitEffects(engine);
  expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'synced' });
  expect(await holds(engine)).toEqual([]);
  const after = await row(engine);
  expect(after).toMatchObject({ source_path: PATH, database_only_reason: null });
  expect(after.compiled_truth).toContain(BULLET);
}, { setup: setupRepo }), 120000);

const DATABASE_ONLY = { still_present: false, reason: 'database_only' };

test('an origin twin whose slug-path file another live page records stays database-only, and sync holds nothing for it', () => managedBrain(async ({ engine, root }) => {
  await legacyTwin(engine, tx => tx.executeRaw("UPDATE pages SET source_path=$1 WHERE source_id='default' AND slug='notes/keeper-example'", [PATH]));
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject(DATABASE_ONLY);
  git(root, 'rm', '-q', 'notes/keeper-example.md');
  await externalEdit(engine, root);
  expect(await holds(engine)).toEqual([]);
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject(DATABASE_ONLY);
}, { setup: ({ root }) => { setupRepo({ root }); writeFileSync(join(root, 'notes', 'keeper-example.md'), FILE); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'keeper'); } }), 120000);

test('an origin twin in a read-only mirror source is not listed for a repair no apply could make', () => managedBrain(async ({ engine, root }) => {
  await legacyTwin(engine, tx => tx.executeRaw("UPDATE sources SET config=config || '{\"mirror_read_only\":\"true\"}'::jsonb WHERE id='default'"));
  await externalEdit(engine, root);
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject(DATABASE_ONLY);
  const planned = await preview(engine, 'database');
  expect(planned.affected).toBe(0);
  expect(planned.listing).toEqual([{ item: `default:${SLUG}`, class: 'no_drift', detail: 'database_only' }]);
}, { setup: setupRepo }), 120000);

test('a held origin twin under a declared db_only path is listed as unknown with its reason, never no_drift', () => managedBrain(async ({ engine, root }) => {
  await legacyTwin(engine);
  await externalEdit(engine, root);
  expect(await holds(engine)).toEqual([{ code: 'file_drift', path: PATH }]);
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject({ still_present: null, reason: 'db_only_slug_path' });
  const planned = await preview(engine, 'database');
  expect(planned.residuals).toEqual({ unknown_db_only_slug_path: 1 });
  expect(planned.listing).toEqual([{ item: `default:${SLUG}`, class: 'unknown', detail: 'db_only_slug_path' }]);
}, { setup: ({ root }) => { setupRepo({ root }); writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - notes/\n'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'db_only'); } }), 120000);

test('an origin twin whose slug-path file is missing stays database-only', () => managedBrain(async ({ engine, root }) => {
  await legacyTwin(engine);
  git(root, 'rm', '-q', PATH);
  git(root, 'commit', '-qm', 'remove the file');
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject(DATABASE_ONLY);
}, { setup: setupRepo }), 120000);

test('an origin twin whose slug path no file can import as stays database-only', () => managedBrain(async ({ engine }) => {
  await legacyTwin(engine, tx => tx.executeRaw("UPDATE pages SET slug='notes/Alpha-Example' WHERE source_id='default' AND slug=$1", [SLUG]));
  expect(await liveFileDrift(engine, 'default', 'notes/Alpha-Example')).toMatchObject(DATABASE_ONLY);
}, { setup: setupRepo }), 120000);

test('an origin twin whose slug-path file sync.exclude screens out stays database-only, and sync holds nothing for it', () => managedBrain(async ({ engine, root }) => {
  await legacyTwin(engine);
  await engine.setConfig('sync.exclude', 'notes/');
  await externalEdit(engine, root);
  expect(await holds(engine)).toEqual([]);
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject(DATABASE_ONLY);
}, { setup: setupRepo }), 120000);

test('an origin twin whose slug-path file another live page names only by file URI is unknown, never no_drift, while sync holds it', () => managedBrain(async ({ engine, root }) => {
  const uri = pathToFileURL(join(realpathSync(root), PATH)).href;
  await legacyTwin(engine, tx => tx.executeRaw("UPDATE pages SET source_path=NULL, source_uri=$1 WHERE source_id='default' AND slug='notes/keeper-example'", [uri]));
  git(root, 'rm', '-q', 'notes/keeper-example.md');
  await externalEdit(engine, root);
  expect(await holds(engine)).toEqual([{ code: 'file_drift', path: PATH }]);
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject({ still_present: null, reason: 'shared_origin' });
  const planned = await preview(engine, 'database');
  expect(planned.affected).toBe(0);
  expect(planned.listing).toEqual([{ item: `default:${SLUG}`, class: 'unknown', detail: 'shared_origin' }]);
}, { setup: ({ root }) => { setupRepo({ root }); writeFileSync(join(root, 'notes', 'keeper-example.md'), FILE); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'keeper'); } }), 120000);

/** Two files that both import as the twin's slug, neither spelled exactly `<slug>.md`. */
function ambiguousSlugPath(root: string): void {
  git(root, 'mv', PATH, 'notes/Alpha-Example.md');
  writeFileSync(join(root, 'notes', 'ALPHA-EXAMPLE.md'), FILE);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'two spellings');
}

test('an origin twin whose slug path several files import as reads as prepareFileTarget does, not slug_path_ambiguous', () => managedBrain(async ({ engine, root }) => {
  await legacyTwin(engine);
  ambiguousSlugPath(root);
  await performManagedSync(engine, { ...OPTS, full: true });
  expect((await holds(engine)).filter(hold => hold.code === 'file_drift')).toEqual([]);
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject(DATABASE_ONLY);
}, { setup: setupRepo }), 120000);

test('an origin twin under a declared db_only path reads db_only_slug_path even when several files import as its slug', () => managedBrain(async ({ engine, root }) => {
  await legacyTwin(engine);
  ambiguousSlugPath(root);
  expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject({ still_present: null, reason: 'db_only_slug_path' });
}, { setup: ({ root }) => { setupRepo({ root }); writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - notes/\n'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'db_only'); } }), 120000);
