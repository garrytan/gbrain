/**
 * PR A item 5: the deleted side of `gbrain repair file-drift --held --side deleted --state <state> [--provenance <p>] --prefer file|database`.
 *   - a live page whose file a commit removed, held by sync as `file_gone` (provenance `deleted_by_commit`), previews
 *     --prefer database as `recreate_file` ("recreate the file"), and its --apply --expect <hash> writes the file back from
 *     the page: the file parses back to the page and the page stays live with the same content; the apply leaves the
 *     hold to sync (an uncommitted recreated file keeps it), and committing the file then syncing clears it;
 *   - every other deleted-side Decision previews its own verb (fileDriftActionVerb, sync-holds.ts): tombstone_edited
 *     database "keep the deletion and remove the file" / file "restore and import"; purged_differs database "remove the
 *     file" / file "import as a new page"; file_gone file "soft-delete the page"; a never-committed file kept
 *     database-only (`detach_page`, "keep the page database-only (no file)"); a deletion HEAD still holds lists
 *     `deletion_uncommitted` and resolves nothing;
 *   - a preview writes nothing: the checkout, the pages and the holds are byte-for-byte as they were.
 * Real PGLite (and Postgres when DATABASE_URL is set), real managed syncs and real Git: every hold here is written by a
 * sync that held the deletion, none by hand.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

type Hold = { path: string; code: string; observed_at: string; meta: Record<string, unknown> };
async function holds(engine: BrainEngine): Promise<Record<string, Hold>> {
  const rows = await engine.executeRaw<{ record: Hold }>("SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold'");
  return Object.fromEntries(rows.map(({ record }) => [record.path, record]));
}
/** What a preview must leave alone: every file of the checkout, HEAD and the index, every page row and every hold. */
async function state(engine: BrainEngine, root: string) {
  const files = Object.fromEntries(readdirSync(join(root, 'notes')).sort().map(name => [name, readFileSync(join(root, 'notes', name), 'utf8')]));
  const pages = await engine.executeRaw(`SELECT slug, knowledge_revision::text AS revision, deleted_at::text AS deleted_at, compiled_truth, source_path, database_only_reason
    FROM pages WHERE source_id='default' AND slug LIKE 'notes/%' ORDER BY slug`);
  return { files, head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), pages, holds: await holds(engine) };
}

/** A page an older import wrote: no import record, no write request, last written an hour ago (before any deleting commit). */
async function olderImport(engine: BrainEngine, slug: string): Promise<void> {
  const coordinated = (sql: string, params: unknown[]) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
  await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
    AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug=$1)`, [slug]);
  await coordinated(`UPDATE pages SET knowledge_revision=$1::uuid, revision_write_request_id=NULL, updated_at=now() - interval '1 hour'
    WHERE source_id='default' AND slug=$2`, [randomUUID(), slug]);
}

for (const backend of testBackends()) describe(`[${backend}] PR A item 5: repair file-drift --held --side deleted`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const name of NAMES) writeFileSync(join(root, `notes/${name}-example.md`), note(`notes/${name}-example`, `The committed body of notes/${name}-example.`));
    commit(root, 'notes');
  };
  const run = async (engine: BrainEngine, opts: { state: string; prefer: 'file' | 'database'; provenance?: string; only?: string[]; expect?: string }) =>
    (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', held: true, side: 'deleted', state: opts.state, prefer: opts.prefer,
        ...(opts.provenance ? { provenance: opts.provenance } : {}), ...(opts.only ? { only: opts.only } : {}), ...(opts.expect ? { expect: opts.expect } : {}) });
  type Page = { slug: string; action?: string; verb?: string; state?: string; path?: string; provenance?: { kind: string; subject?: string } };
  const pages = (result: Awaited<ReturnType<typeof run>>) => (result.details?.pages ?? []) as Page[];
  const listed = (result: Awaited<ReturnType<typeof run>>) => (result.listing ?? []).map(entry => [entry.item, entry.class]);

  test('file_gone deleted_by_commit: --prefer database previews recreate_file, its apply writes the file back from the page, and commit + sync clears the hold', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await olderImport(engine, 'notes/alpha-example');
    git(root, 'rm', '-q', 'notes/alpha-example.md'); git(root, 'commit', '-qm', 'cull alpha');
    await performManagedSync(engine, OPTS);
    const path = 'notes/alpha-example.md';
    expect((await holds(engine))[path]).toMatchObject({ code: 'file_drift', meta: { side: 'deleted', state: 'file_gone' } });
    expect((await holds(engine))[path]!.meta.reason).toBeUndefined();
    const before = await state(engine, root);
    const page = (await engine.readPageSnapshot('notes/alpha-example', { sourceId: 'default' }))!;

    const preview = await run(engine, { state: 'file_gone', prefer: 'database', provenance: 'deleted_by_commit' });
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
    expect(pages(preview)).toEqual([expect.objectContaining({ slug: 'notes/alpha-example', action: 'recreate_file', verb: 'recreate the file',
      provenance: expect.objectContaining({ kind: 'deleted_by_commit', subject: 'cull alpha' }) })]);
    expect(listed(preview)).toEqual([['default:notes/alpha-example', 'prefer_database']]);
    expect(preview.listing![0]!.detail).toContain(`recreates its missing file ${path} from the page`);
    expect(preview.listing![0]!.detail).toContain(`deleted by commit ${git(root, 'rev-parse', 'HEAD').slice(0, 12)}`);
    expect(preview.apply_command).toContain('--provenance deleted_by_commit --prefer database --apply --expect');
    expect(await state(engine, root)).toEqual(before);
    expect(existsSync(join(root, path))).toBe(false);

    const applied = await run(engine, { state: 'file_gone', prefer: 'database', provenance: 'deleted_by_commit', expect: preview.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    const parsed = parseMarkdown(readFileSync(join(root, path), 'utf8'), path);
    const after = (await engine.readPageSnapshot('notes/alpha-example', { sourceId: 'default' }))!;
    expect(after.page.deleted_at).toBeFalsy();
    expect(after.page.compiled_truth).toBe(page.page.compiled_truth);
    expect(after.page.title).toBe(page.page.title);
    expect(parsed.compiled_truth).toBe(page.page.compiled_truth.trim());
    expect(parsed.title).toBe(page.page.title);
    expect(parsed.type).toBe(page.page.type);
    // The apply recreates the file uncommitted (Git durability is off here, as the preview warns) and leaves the hold to the
    // sync that re-screens it: an uncommitted file keeps the hold and the page; committing it and syncing clears the hold.
    expect(preview.warnings).toEqual([expect.stringContaining('unless the recreated files are committed')]);
    expect(preview.details!.undone_by_next_sync_unless_committed).toEqual({ recreated: 1, removed: 0 });
    expect(git(root, 'status', '--porcelain')).toBe(`?? ${path}`);
    expect((await holds(engine))[path]).toMatchObject({ code: 'file_drift', meta: { state: 'file_gone' } });
    await performManagedSync(engine, OPTS);
    expect((await holds(engine))[path]).toMatchObject({ code: 'file_drift', meta: { state: 'file_gone' } });
    expect((await engine.readPageSnapshot('notes/alpha-example', { sourceId: 'default' }))!.page.deleted_at).toBeFalsy();
    git(root, 'add', '--', path); git(root, 'commit', '-qm', 'gbrain: repair file drift in default');
    await performManagedSync(engine, OPTS);
    expect((await holds(engine))[path]).toBeUndefined();
    const synced = (await engine.readPageSnapshot('notes/alpha-example', { sourceId: 'default' }))!;
    expect(synced.page.deleted_at).toBeFalsy();
    expect(synced.page.compiled_truth).toBe(page.page.compiled_truth);
    expect(parseMarkdown(readFileSync(join(root, path), 'utf8'), path).compiled_truth).toBe(page.page.compiled_truth.trim());
  }, { databaseUrl, setup }), 300_000);

  test('every other deleted-side Decision previews its own verb, and no preview writes anything', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const snapshot = (slug: string) => engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
    const remove = async (c: OperationContext, slug: string, purge: boolean) => submitPageMutation(c, { operation: 'delete_page',
      params: { slug, request_id: randomUUID(), expected_revision: (await snapshot(slug))!.revision, ...(purge ? { purge: true } : {}) } });
    // file_gone: a commit removed notes/alpha's file; notes/delta's too, then a commit restored it and the worktree lost it again (HEAD holds it).
    for (const slug of ['notes/alpha-example', 'notes/delta-example']) await olderImport(engine, slug);
    git(root, 'rm', '-q', 'notes/alpha-example.md', 'notes/delta-example.md'); git(root, 'commit', '-qm', 'cull alpha and delta');
    // tombstone_edited: notes/beta deleted in the brain, then its file edited and committed; purged_differs: notes/gamma purged, then a different file committed.
    await remove(ctx, 'notes/beta-example', false);
    await remove(ctx, 'notes/gamma-example', true);
    await settleManagedGitEffects(engine);
    writeFileSync(join(root, 'notes/beta-example.md'), note('notes/beta-example', 'Edited after the delete.'));
    writeFileSync(join(root, 'notes/gamma-example.md'), note('notes/gamma-example', 'A different file at the purged origin.'));
    commit(root, 'edit beta, re-add gamma');
    await performManagedSync(engine, OPTS);
    git(root, 'checkout', '-q', 'HEAD~2', '--', 'notes/delta-example.md'); commit(root, 'restore delta');
    rmSync(join(root, 'notes/delta-example.md'));
    // never_committed: a working-tree page no commit ever held, then removed from the disk.
    await engine.setConfig('sync.include_working_tree', 'true');
    writeFileSync(join(root, 'notes/zeta-example.md'), note('notes/zeta-example', 'An untracked note only the brain holds.'));
    await performManagedSync(engine, OPTS);
    await engine.setConfig('sync.include_working_tree', 'false');
    rmSync(join(root, 'notes/zeta-example.md'));
    await performManagedSync(engine, OPTS);

    const held = await holds(engine);
    expect(Object.fromEntries(Object.entries(held).map(([path, hold]) => [path, [hold.code, hold.meta.side, hold.meta.state, hold.meta.reason ?? null]]))).toEqual({
      'notes/alpha-example.md': ['file_drift', 'deleted', 'file_gone', null],
      'notes/beta-example.md': ['file_drift', 'deleted', 'tombstone_edited', null],
      'notes/delta-example.md': ['file_drift', 'deleted', 'file_gone', null],
      'notes/gamma-example.md': ['file_drift', 'deleted', 'purged_differs', null],
      'notes/zeta-example.md': ['file_drift', 'deleted', 'file_gone', 'never_committed'],
    });
    const before = await state(engine, root);
    const preview = async (opts: Parameters<typeof run>[1]) => {
      const result = await run(engine, opts);
      expect(result.mode).toBe('dry_run');
      expect(await state(engine, root)).toEqual(before);
      return result;
    };

    const tombDb = await preview({ state: 'tombstone_edited', prefer: 'database' });
    expect(pages(tombDb)).toEqual([expect.objectContaining({ slug: 'notes/beta-example', action: 'remove_file', state: 'tombstone_edited', verb: 'keep the deletion and remove the file' })]);
    expect(listed(tombDb)).toEqual([['default:notes/beta-example', 'prefer_database']]);
    const tombFile = await preview({ state: 'tombstone_edited', prefer: 'file' });
    expect(pages(tombFile)).toEqual([expect.objectContaining({ slug: 'notes/beta-example', action: 'import_file', state: 'tombstone_edited', verb: 'restore and import' })]);
    expect(listed(tombFile)).toEqual([['default:notes/beta-example', 'prefer_file']]);

    const purgedDb = await preview({ state: 'purged_differs', prefer: 'database' });
    expect(pages(purgedDb)).toEqual([expect.objectContaining({ slug: 'notes/gamma-example', action: 'remove_file', state: 'purged_differs', verb: 'remove the file' })]);
    expect(listed(purgedDb)).toEqual([['default:notes/gamma-example', 'prefer_database']]);
    const purgedFile = await preview({ state: 'purged_differs', prefer: 'file' });
    expect(pages(purgedFile)).toEqual([expect.objectContaining({ slug: 'notes/gamma-example', action: 'import_file', state: 'purged_differs', verb: 'import as a new page' })]);
    expect(listed(purgedFile)).toEqual([['default:notes/gamma-example', 'prefer_file']]);

    const goneFile = await preview({ state: 'file_gone', prefer: 'file', provenance: 'deleted_by_commit' });
    expect(pages(goneFile)).toEqual([expect.objectContaining({ slug: 'notes/alpha-example', action: 'soft_delete', verb: 'soft-delete the page',
      provenance: expect.objectContaining({ kind: 'deleted_by_commit' }) })]);
    expect(listed(goneFile)).toEqual([['default:notes/alpha-example', 'prefer_file']]);
    expect(goneFile.residuals).toMatchObject({ other_provenance: 2 });

    const never = await preview({ state: 'file_gone', prefer: 'database', provenance: 'never_committed' });
    expect(pages(never)).toEqual([expect.objectContaining({ slug: 'notes/zeta-example', action: 'detach_page', verb: 'keep the page database-only (no file)',
      provenance: { kind: 'never_committed' } })]);
    expect(listed(never)).toEqual([['default:notes/zeta-example', 'prefer_database']]);

    for (const prefer of ['database', 'file'] as const) {
      const uncommitted = await preview({ state: 'file_gone', prefer, provenance: 'deletion_uncommitted' });
      expect(uncommitted.affected).toBe(0);
      expect(pages(uncommitted)).toEqual([]);
      expect(listed(uncommitted)).toEqual([['default:notes/delta-example', 'deletion_uncommitted']]);
      expect(uncommitted.residuals).toMatchObject({ deletion_uncommitted: 1, other_provenance: 2 });
      expect(uncommitted.listing![0]!.detail).toContain('deletion uncommitted: HEAD still holds the file');
    }
  }, { databaseUrl, setup }), 300_000);
});
