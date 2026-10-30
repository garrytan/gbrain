/**
 * GBRA-133 (data loss): a page written in the database after its file last held it is never soft-deleted because that
 * file is gone, even when a commit deleted the file.
 *   - `gbrain repair file-drift --held --side deleted --state file_gone --provenance deleted_by_commit --prefer file` lists
 *     such a page apart (`database_ahead_of_file`) and soft-deletes only pages whose revision is file-backed (the
 *     revision sync last imported from the file);
 *   - `gbrain repair ghost-pages` lists it apart the same way and never approves it;
 *   - the soft-delete itself refuses it (`refused`, `database_ahead_of_file`), so an approval saved before this check, or
 *     a page written between the preview and the apply, still keeps its content.
 * Before: the file's deleting commit was taken as the page's deletion, so the soft-delete dropped content no commit held.
 * Real PGLite (and Postgres when DATABASE_URL is set), a real managed sync and real Git; the later database write is
 * modelled as a new revision with new text and no write request (what a database-only write leaves).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { ghostPageNow } from '../src/core/ghost-pages.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { retireGhost } from '../src/core/repair/ghost-pages.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const deletedAt = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ deleted_at: unknown }>("SELECT deleted_at FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.deleted_at;

/** Holds `slug`'s gone file as sync holds a committed deletion it cannot prove (file_drift, deleted, file_gone). */
async function holdGone(engine: BrainEngine, slug: string) {
  const page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: source!.incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
    page_id: Number(page.page.id), code: 'file_drift', message: `${slug}.md is held: file drift (deleted file_gone)`, upstream_version: null,
    observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, side: 'deleted', state: 'file_gone', page_revision: page.revision } }));
}

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: a page written after its file is never soft-deleted for the file's deletion`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`, `The committed body of notes/${name}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test('file-drift and ghost-pages list it apart, and the soft-delete refuses it', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // notes/b moves on in the database after its import; then a commit deletes both files.
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`UPDATE pages SET compiled_truth = compiled_truth || ' Written later, in the database only.',
      knowledge_revision = $1::uuid, revision_write_request_id = NULL WHERE source_id='default' AND slug='notes/b'`, [randomUUID()]), TEST_WRITE_ATTRIBUTION));
    // notes/c and notes/d are older imports: no import record and no write request. notes/c is written after the deleting commit, notes/d is not.
    const coordinated = (sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
    await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
      AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug IN ('notes/c', 'notes/d'))`);
    await coordinated("UPDATE pages SET revision_write_request_id = NULL WHERE source_id='default' AND slug IN ('notes/c', 'notes/d')");
    git(root, 'rm', '-q', 'notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/d.md'); git(root, 'commit', '-qm', 'cull a, b, c and d');
    await coordinated(`UPDATE pages SET compiled_truth = compiled_truth || ' Written after the cull.', knowledge_revision = $1::uuid, updated_at = now() + interval '1 hour'
      WHERE source_id='default' AND slug='notes/c'`, [randomUUID()]);
    for (const slug of ['notes/a', 'notes/b', 'notes/c', 'notes/d']) await holdGone(engine, slug);

    const drift = async (expect?: string) => (await repairRunner(engine, { apply: expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', prefer: 'file', held: true, side: 'deleted', state: 'file_gone', provenance: 'deleted_by_commit', ...(expect ? { expect } : {}) });
    const preview = await drift();
    expect((preview.details!.pages as Array<{ slug: string; action?: string }>).map(page => [page.slug, page.action])).toEqual([['notes/a', 'soft_delete'], ['notes/d', 'soft_delete']]);
    for (const slug of ['notes/b', 'notes/c']) {
      const apart = preview.listing!.find(entry => entry.item === `default:${slug}`)!;
      expect(apart.class).toBe('database_ahead_of_file');
      expect(apart.detail).toContain('holds the only copy');
    }
    expect((await drift(preview.preview_hash!)).outcomes).toEqual({ repaired: 2 });
    expect([await deletedAt(engine, 'notes/a'), await deletedAt(engine, 'notes/d')]).not.toContain(null);
    expect([await deletedAt(engine, 'notes/b'), await deletedAt(engine, 'notes/c')]).toEqual([null, null]);

    const ghosts = await (await repairRunner(engine, { apply: false, logger })).run('ghost-pages', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
    expect(ghosts.affected).toBe(0);
    expect(ghosts.residuals).toMatchObject({ ghosts: 0, database_ahead: 2 });
    expect(ghosts.listing!.map(entry => [entry.item, entry.class])).toEqual([['default:notes/b', 'database_ahead_of_file'], ['default:notes/c', 'database_ahead_of_file']]);

    // The soft-delete itself refuses it, whatever approved it.
    const now = await ghostPageNow(engine, 'default', 'notes/b');
    expect(now.ghost).not.toBeNull();
    const refused = await retireGhost(ctx, now.ghost!, now.owner!, async () => randomUUID());
    expect(refused).toMatchObject({ applied: false, outcome: 'refused', reason: 'database_ahead_of_file' });
    expect(await deletedAt(engine, 'notes/b')).toBeNull();
  }, { databaseUrl, setup }), 300_000);
});
