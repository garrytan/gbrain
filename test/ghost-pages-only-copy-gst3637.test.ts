/**
 * GST-3637 (data loss): \`gbrain repair ghost-pages\` approves only a ghost whose file a commit deleted, since only then does
 * Git still hold what the file held. Before: a page whose file no commit ever held (a database-only stub, which holds the
 * only copy of its content) and a page whose file was lost from the working tree only (HEAD still holds it) were approved
 * for soft-delete like any other ghost, and purged 72 h later. Now:
 *   - the preview lists each apart (\`ghost_never_committed\`, \`ghost_worktree_only\`) with its restore route and approves
 *     only the committed deletion;
 *   - the soft-delete itself refuses each, so an approval saved before this check still keeps the page;
 *   - \`gbrain repair file-drift --prefer file\` (the other reader of the same check) skips the never-committed page;
 *   - a deletion Git cannot place is kept too (\`ghost_history_unknown\`).
 * Real PGLite (and Postgres when DATABASE_URL is set), a real managed sync and real Git.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ghostPageNow } from '../src/core/ghost-pages.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { readSyncImportProvenance } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { ghostBacking, retireGhost } from '../src/core/repair/ghost-pages.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string) => '---\ntype: concept\ntitle: ' + title + '\n---\n\nThe committed body of ' + title + '.\n';
const STUB = 'dates/2024-01-03';

for (const backend of testBackends()) describe('[' + backend + '] GST-3637: ghost-pages removes only a page whose file a commit deleted', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const name of ['committed', 'worktree', 'kept']) writeFileSync(join(root, 'notes/' + name + '.md'), note('notes/' + name));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test('the preview lists never-committed and worktree-only ghosts apart, the apply removes only the committed deletion', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
    // A database-only page no file ever backed: its canonical path dates/2024-01-03.md never existed in Git.
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      "INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ('default', $1, 'concept', '2024-01-03', 'A date page written in the database only.')", [STUB]), TEST_WRITE_ATTRIBUTION));
    git(root, 'rm', '-q', 'notes/committed.md'); git(root, 'commit', '-qm', 'remove notes/committed', '--date=' + new Date(Date.now() + 2000).toISOString());
    unlinkSync(join(root, 'notes/worktree.md'));

    const run = async (opts: { apply?: boolean; expect?: string } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
      .run('ghost-pages', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', expect: opts.expect });
    const preview = await run();
    expect(preview.affected).toBe(1);
    expect(preview.residuals).toMatchObject({ ghosts: 1, never_committed: 1, worktree_only: 1 });
    const classes = Object.fromEntries(preview.listing!.map(entry => [entry.item, entry.class]));
    expect(classes).toEqual({ 'default:notes/committed': 'canonical_file_missing', ['default:' + STUB]: 'ghost_never_committed', 'default:notes/worktree': 'ghost_worktree_only' });
    const detail = (item: string) => preview.listing!.find(entry => entry.item === item)!.detail;
    expect(detail('default:' + STUB)).toContain('holds the only copy');
    expect(detail('default:' + STUB)).toContain('gbrain repair file-drift --source default --slug ' + STUB + ' --prefer database');
    expect(detail('default:notes/worktree')).toContain("git -C '" + root + "' checkout HEAD -- 'notes/worktree.md'");
    expect(preview.warnings!.some(line => line.includes('ghost_never_committed'))).toBe(true);
    expect(preview.warnings!.some(line => line.includes('ghost_worktree_only'))).toBe(true);

    const applied = await run({ apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 1, failed: [], outcomes: { soft_deleted: 1 } });
    const live = async (slug: string) => (await engine.executeRaw<{ live: boolean }>("SELECT deleted_at IS NULL AS live FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.live;
    expect(await live('notes/committed')).toBe(false);
    for (const slug of [STUB, 'notes/worktree', 'notes/kept']) expect(await live(slug)).toBe(true);

    // An approval saved before this check (or a page that changed state since) is refused by the soft-delete itself.
    for (const [slug, code] of [[STUB, 'ghost_never_committed'], ['notes/worktree', 'ghost_worktree_only']] as const) {
      const now = await ghostPageNow(engine, 'default', slug);
      expect(now.ghost).not.toBeNull();
      expect(await retireGhost(ctx, now.ghost!, now.owner!, async () => randomUUID())).toMatchObject({ applied: false, outcome: 'refused', reason: code });
      expect(await live(slug)).toBe(true);
    }

    // file-drift --prefer file reads the same check: the never-committed page is skipped with its code, not soft-deleted.
    const drift = await (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', prefer: 'file', slugs: [STUB] });
    expect(drift.listing!.find(entry => entry.item === 'default:' + STUB)?.class).toBe('ghost_never_committed');

    // A deletion Git cannot place keeps the page as well.
    const stub = (await ghostPageNow(engine, 'default', STUB))!;
    expect(await ghostBacking(engine, stub.ghost!, stub.owner!, { kind: 'unknown' })).toBe('ghost_history_unknown');
  }, { databaseUrl, setup }), 120_000);

  test('a page last imported from an uncommitted edit is kept when the deleting commit never held that edit', () => managedBrain(async ({ engine, root }) => {
    const sync = (workingTree = false) => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, workingTree });
    expect((await sync()).status).toBe('first_sync');
    // Both notes are edited in the working tree and synced from there; only notes/kept's edit is committed before its file is removed.
    for (const name of ['committed', 'kept']) writeFileSync(join(root, 'notes/' + name + '.md'), note('notes/' + name) + '\nAn edit made after the last commit.\n');
    await sync(true);
    git(root, 'add', 'notes/kept.md'); git(root, 'commit', '-qm', 'commit the kept edit');
    git(root, 'rm', '-qf', 'notes/committed.md', 'notes/kept.md'); git(root, 'commit', '-qm', 'remove both', '--date=' + new Date(Date.now() + 2000).toISOString());

    const lost = (await ghostPageNow(engine, 'default', 'notes/committed'))!;
    const record = await readSyncImportProvenance(engine, 'default', lost.owner!.source_incarnation, lost.ghost!.page_id);
    expect(record).toMatchObject({ working: true, revision: lost.ghost!.revision });

    const preview = await (await repairRunner(engine, { apply: false, logger })).run('ghost-pages', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
    const classes = Object.fromEntries(preview.listing!.map(entry => [entry.item, entry.class]));
    expect(classes['default:notes/committed']).toBe('ghost_never_committed');
    expect(classes['default:notes/kept']).toBe('canonical_file_missing');
    expect(preview.affected).toBe(1);
    expect(await ghostBacking(engine, lost.ghost!, lost.owner!)).toBe('ghost_never_committed');
  }, { databaseUrl, setup }), 120_000);

  test('a ghost whose deletion Git cannot place is listed apart and the soft-delete refuses it', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
    git(root, 'rm', '-q', 'notes/committed.md'); git(root, 'commit', '-qm', 'remove notes/committed', '--date=' + new Date(Date.now() + 2000).toISOString());
    // The folder stops being a Git checkout, so no commit can be named as the one that deleted the file.
    rmSync(join(root, '.git'), { recursive: true, force: true });

    const preview = await (await repairRunner(engine, { apply: false, logger })).run('ghost-pages', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
    expect(preview.affected).toBe(0);
    expect(preview.residuals).toMatchObject({ history_unknown: 1 });
    const entry = preview.listing!.find(row => row.item === 'default:notes/committed')!;
    expect(entry.class).toBe('ghost_history_unknown');
    expect(entry.detail).toContain('gbrain delete notes/committed');

    const now = await ghostPageNow(engine, 'default', 'notes/committed');
    expect(now.ghost).not.toBeNull();
    expect(await retireGhost(ctx, now.ghost!, now.owner!, async () => randomUUID())).toMatchObject({ applied: false, outcome: 'refused', reason: 'ghost_history_unknown' });
    expect((await engine.executeRaw<{ live: boolean }>("SELECT deleted_at IS NULL AS live FROM pages WHERE source_id='default' AND slug='notes/committed'"))[0]!.live).toBe(true);
  }, { databaseUrl, setup }), 120_000);
});
