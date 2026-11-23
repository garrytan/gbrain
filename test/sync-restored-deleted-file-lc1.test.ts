/**
 * LC-1 (audit decision E1): a file restored after `gbrain delete` comes back only through the file-drift step that asks the
 * user first, never silently, and never stays out of the brain for good.
 *   - `gbrain delete` removes the page's file (write-through); a person restores the same bytes (`git checkout -- <path>`);
 *     the next managed sync holds the file `file_drift` on the deleted side (`tombstone_edited`, `restored: true`) instead
 *     of settling it as "Already up to date", and the page stays deleted until `gbrain repair file-drift --held --side
 *     deleted --state tombstone_edited --prefer file` (preview, then --apply --expect) restores it;
 *   - the same after the retention purge (`gbrain pages purge-deleted`), restored before or after it: the file is held
 *     `purged_differs` and imports as a new page only on the user's yes, so purged content never comes back without
 *     consent, and the hold is what `sources status` and doctor list;
 *   - a deletion that stands is unchanged: the delete's own removal not committed yet, a delete that left the file
 *     (`sync.write_through=false`), and an owner purge (its content tombstone refuses the bytes for good) settle
 *     `deleted_same` with no hold.
 * Real PGLite (and Postgres when DATABASE_URL is set), real managed syncs and real Git.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { compactReceipt } from '../src/core/persistence/journal.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { gitHoldFix } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readFileRemovingDeletes } from '../src/core/persistence/sync-pass.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of ['ivy', 'jon', 'kai']) writeFileSync(join(root, `notes/${name}-example.md`), note(`notes/${name}-example`, `The committed body of notes/${name}-example.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};

async function remove(engine: BrainEngine, ctx: OperationContext, slug: string, purge: boolean) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  const outcome = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, request_id: randomUUID(), expected_revision: snapshot!.revision, ...(purge ? { purge: true } : {}) }, waitMs: 30_000 });
  expect(outcome.state).toBe('committed');
  await settleManagedGitEffects(engine);
}
async function holds(engine: BrainEngine) {
  const rows = await engine.executeRaw<{ record: { path: string; code: string; meta: Record<string, unknown> } }>("SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold'");
  return Object.fromEntries(rows.map(({ record }) => [record.path, [record.code, record.meta.side ?? null, record.meta.state ?? null, record.meta.restored ?? null]]));
}
async function pageState(engine: BrainEngine, slug: string): Promise<'live' | 'deleted' | 'none'> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return !snapshot ? 'none' : snapshot.page.deleted_at ? 'deleted' : 'live';
}

for (const backend of testBackends()) describe(`[${backend}] LC-1: a file restored after a delete asks first`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const fileDrift = async (engine: BrainEngine, state: string, expectHash?: string) =>
    (await repairRunner(engine, { apply: expectHash !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', held: true, side: 'deleted', state, prefer: 'file', ...(expectHash ? { expect: expectHash } : {}) });
  type Planned = { slug: string; action?: string; verb?: string };

  for (const purge of ['none', 'before restore', 'after restore'] as const) {
    const purged = purge !== 'none', state = purged ? 'purged_differs' : 'tombstone_edited';
    test(`soft delete${purged ? `, retention purge ${purge}` : ''}, the same file restored: sync holds it ${state} and the page comes back only through repair file-drift --prefer file`, () => managedBrain(async ({ engine, ctx, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await remove(engine, ctx, 'notes/ivy-example', false);
      expect(existsSync(join(root, 'notes/ivy-example.md'))).toBe(false);
      if (purge === 'before restore') expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toEqual(['notes/ivy-example']);
      git(root, 'checkout', '--', 'notes/ivy-example.md');
      expect(git(root, 'status', '--porcelain')).toBe('');
      if (purge === 'after restore') {
        // The audit's order: the restore is synced while the page is only soft-deleted, then the retention purge runs.
        await performManagedSync(engine, OPTS);
        expect(await holds(engine)).toEqual({ 'notes/ivy-example.md': ['file_drift', 'deleted', 'tombstone_edited', true] });
        expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toEqual(['notes/ivy-example']);
        expect(existsSync(join(root, 'notes/ivy-example.md'))).toBe(true);
      }

      await performManagedSync(engine, OPTS);
      expect(await holds(engine)).toEqual({ 'notes/ivy-example.md': ['file_drift', 'deleted', state, true] });
      expect(await pageState(engine, 'notes/ivy-example')).toBe(purged ? 'none' : 'deleted');
      // The hold names the restore, and its fix asks first (the restored-file wording, not the edited-file one).
      const [record] = await engine.executeRaw<{ record: Parameters<typeof gitHoldFix>[0] & { message: string } }>("SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold'");
      expect(record!.record.message).toContain('is back with the bytes');
      expect(record!.record.message).toContain('without your yes');
      expect(gitHoldFix(record!.record).why).toContain('(a restore)');
      // A second sync neither imports it nor drops the hold.
      await performManagedSync(engine, OPTS);
      expect(await holds(engine)).toEqual({ 'notes/ivy-example.md': ['file_drift', 'deleted', state, true] });
      expect(await pageState(engine, 'notes/ivy-example')).toBe(purged ? 'none' : 'deleted');

      const preview = await fileDrift(engine, state);
      expect(preview.mode).toBe('dry_run');
      expect((preview.details?.pages ?? []) as Planned[]).toEqual([expect.objectContaining({ slug: 'notes/ivy-example', action: 'import_file',
        verb: purged ? 'import as a new page' : 'restore and import' })]);
      expect(await pageState(engine, 'notes/ivy-example')).toBe(purged ? 'none' : 'deleted');
      await fileDrift(engine, state, preview.preview_hash!);
      expect(await pageState(engine, 'notes/ivy-example')).toBe('live');
      expect((await engine.getPage('notes/ivy-example', { sourceId: 'default' }))?.compiled_truth).toContain('The committed body of notes/ivy-example.');
      await performManagedSync(engine, OPTS);
      expect(await holds(engine)).toEqual({});
      expect(await pageState(engine, 'notes/jon-example')).toBe('live');
    }, { databaseUrl, setup }), 240_000);
  }

  test('a later delete that left the file is not a restore: the removal evidence is the newest delete\'s, not one a consented repair already undid', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/ivy-example';
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, slug, false);
    git(root, 'checkout', '--', `${slug}.md`);
    await performManagedSync(engine, OPTS);
    const preview = await fileDrift(engine, 'tombstone_edited');
    await fileDrift(engine, 'tombstone_edited', preview.preview_hash!);
    expect(await pageState(engine, slug)).toBe('live');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({});
    await engine.setConfig('sync.write_through', 'false');
    await remove(engine, ctx, slug, false);
    expect(existsSync(join(root, `${slug}.md`))).toBe(true);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({});
    expect(await pageState(engine, slug)).toBe('deleted');
  }, { databaseUrl, setup }), 240_000);

  test('an owner purge stays settled after its receipt is compacted (the purge is read from the receipt outcome, not the compactable intent)', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/kai-example';
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, slug, true);
    git(root, 'checkout', 'HEAD', '--', `${slug}.md`);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({});
    const receipts = await engine.executeRaw<{ id: string; principal_kind: string; principal_id: string }>(
      "SELECT id::text AS id, principal_kind, principal_id FROM persistence_requests WHERE slug=$1 AND operation='delete_page' AND state='committed'", [slug]);
    expect(receipts.length).toBe(1);
    for (const receipt of receipts) expect(await compactReceipt(engine, receipt as never)).not.toHaveProperty('skipped');
    const [compacted] = await engine.executeRaw<{ intent: unknown; status: string | null }>("SELECT intent, outcome->>'status' AS status FROM persistence_requests WHERE id=$1::uuid", [receipts[0]!.id]);
    expect(compacted).toEqual({ intent: null, status: 'purged' });
    await performManagedSync(engine, { ...OPTS, full: true });
    expect(await holds(engine)).toEqual({});
    expect(await pageState(engine, slug)).toBe('none');
  }, { databaseUrl, setup }), 240_000);

  test('a restore after the deletion already settled is still seen: the idle check re-reads a path whose removal was not committed', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/ivy-example';
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, slug, false);
    await performManagedSync(engine, OPTS);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect(await holds(engine)).toEqual({});
    git(root, 'checkout', '--', `${slug}.md`);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({ [`${slug}.md`]: ['file_drift', 'deleted', 'tombstone_edited', true] });
    expect(await pageState(engine, slug)).toBe('deleted');
  }, { databaseUrl, setup }), 240_000);

  test('a restore that keeps the size and modification time of the file it replaced is still seen: the idle check compares change time and inode too', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/ivy-example', file = join(root, `${slug}.md`);
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, slug, false);
    // Other bytes of the same length while the removal is not committed: the stamp records this file's stat.
    const original = execFileSync('git', ['-C', root, 'show', `HEAD:${slug}.md`]);
    writeFileSync(file, Buffer.from(original.toString('utf8').replace('committed body', 'COMMITTED BODY')));
    const kept = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000); utimesSync(file, kept, kept);
    await performManagedSync(engine, OPTS);
    const before = await holds(engine);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    // The original bytes come back with the replaced file's modification time kept: size and mtime match the stamp.
    writeFileSync(join(root, 'restore.tmp'), original); utimesSync(join(root, 'restore.tmp'), kept, kept); renameSync(join(root, 'restore.tmp'), file);
    expect(statSync(file).mtimeMs).toBe(kept.getTime());
    await performManagedSync(engine, OPTS);
    expect(before).toEqual({});
    expect(await holds(engine)).toEqual({ [`${slug}.md`]: ['file_drift', 'deleted', 'tombstone_edited', true] });
    expect(await pageState(engine, slug)).toBe('deleted');
  }, { databaseUrl, setup }), 240_000);

  test('a repeated delete (a no-op on a page already deleted) keeps the first delete\'s removal: the restore is still held', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/ivy-example';
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, slug, false);
    await performManagedSync(engine, OPTS);
    await remove(engine, ctx, slug, false);
    git(root, 'checkout', '--', `${slug}.md`);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({ [`${slug}.md`]: ['file_drift', 'deleted', 'tombstone_edited', true] });
    expect(await pageState(engine, slug)).toBe('deleted');
  }, { databaseUrl, setup }), 240_000);

  test('a staged removal undone only in the index is still seen: the idle check does not trust a staged path\'s disk stat', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/ivy-example';
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, slug, false);
    // Stage the removal, then put the same bytes back on disk without touching the index.
    git(root, 'rm', '-q', '--cached', '--ignore-unmatch', '--', `${slug}.md`);
    writeFileSync(join(root, `${slug}.md`), execFileSync('git', ['-C', root, 'show', `HEAD:${slug}.md`]));
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({});
    git(root, 'restore', '--staged', '--', `${slug}.md`);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({ [`${slug}.md`]: ['file_drift', 'deleted', 'tombstone_edited', true] });
    expect(await pageState(engine, slug)).toBe('deleted');
  }, { databaseUrl, setup }), 240_000);

  test('a stamp from before this fix (no removal_pending, an older selection fingerprint) re-reads the level, so a restore made after the upgrade is held', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/ivy-example';
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, slug, false);
    await performManagedSync(engine, OPTS);
    const converged = "completed_keys->0->'obligations'->'converged'";
    const [stamp] = await engine.executeRaw<{ pending: unknown }>(`SELECT ${converged}->'removal_pending' AS pending FROM op_checkpoints WHERE op='managed-sync-pass'`);
    expect(stamp!.pending).toEqual([expect.objectContaining({ path: `${slug}.md`, stat: 'absent' })]);
    // The shape an older gbrain stamped: no removal_pending, and the selection fingerprint of a classifier without this hold.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys #- '{0,obligations,converged,removal_pending}',
      '{0,obligations,converged,selection_fp}', '"pre-lc1"'::jsonb) WHERE op='managed-sync-pass'`);
    git(root, 'checkout', '--', `${slug}.md`);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({ [`${slug}.md`]: ['file_drift', 'deleted', 'tombstone_edited', true] });
    expect(await pageState(engine, slug)).toBe('deleted');
  }, { databaseUrl, setup }), 240_000);

  test('removal evidence is the page\'s own newest committed delete: other pages, other sources, uncommitted, undone, kept-file and owner-purge receipts are not', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const receipt = (slug: string, operation: string, o: { pageId?: number | null; state?: string; outcome?: unknown; intent?: unknown }) => engine.transaction(async tx => {
      // The brain's writer floor is protocol 2: each fixture row is written in a transaction that declares it.
      await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
      await tx.executeRaw(
      `INSERT INTO persistence_requests(principal_kind, principal_id, request_id, operation, source_id, source_incarnation, slug, page_id, digest, authority, intent_bytes,
         terminal_reservation, state, intent, outcome)
       VALUES ('local_cli', 'lc1', $1::uuid, $2, $3, (SELECT incarnation FROM sources WHERE id=$3), $4, $5, $6, '{}'::jsonb, 0, 0, $7, $8::text::jsonb, $9::text::jsonb)`,
      [randomUUID(), operation, 'default', slug, o.pageId === undefined ? 7 : o.pageId, randomUUID(), o.state ?? 'committed',
        o.intent === undefined ? JSON.stringify({ slug }) : o.intent === null ? null : JSON.stringify(o.intent), o.outcome === undefined ? null : JSON.stringify(o.outcome)]);
    });
    const removed = { status: 'soft_deleted', write_through: { written: true } }, kept = { status: 'soft_deleted', write_through: { written: false } };
    const cases: Array<[string, Array<[string, Parameters<typeof receipt>[2]]>, boolean]> = [
      ['a committed delete that removed the file', [['delete_page', { outcome: removed }]], true],
      ['a delete with no page id recorded', [['delete_page', { pageId: null, outcome: removed }]], true],
      ['another page\'s delete (an unrelated incarnation of the slug)', [['delete_page', { pageId: 8, outcome: removed }]], false],
      ['a delete that did not commit', [['delete_page', { state: 'failed', outcome: removed }]], false],
      ['a delete a restore_page undid', [['delete_page', { outcome: removed }], ['restore_page', {}]], false],
      ['a delete a consented put_page undid', [['delete_page', { outcome: removed }], ['put_page', {}]], false],
      ['a no-op repeat of the delete does not hide its removal', [['delete_page', { outcome: removed }], ['delete_page', { outcome: { ...kept, noop: true } }]], true],
      ['a put_page of another page does not undo it', [['delete_page', { outcome: removed }], ['put_page', { pageId: 8 }]], true],
      ['a put_page deduplicated onto another live page revives nothing and does not undo it', [['delete_page', { outcome: removed }], ['put_page', { outcome: { status: 'duplicate', slug: 'notes/other', duplicate_revision: 3 } }]], true],
      ['a no-op put_page revives nothing and does not undo it', [['delete_page', { outcome: removed }], ['put_page', { outcome: { status: 'skipped', noop: true } }]], true],
      ['a later delete that kept the file', [['delete_page', { outcome: removed }], ['put_page', {}], ['delete_page', { outcome: kept }]], false],
      ['a retention purge after the removal', [['delete_page', { outcome: removed }], ['delete_page', { outcome: { status: 'purged', retention: true } }]], true],
      ['a retention purge read from the intent only', [['delete_page', { outcome: removed }], ['delete_page', { intent: { purge: true, retention: true }, outcome: { status: 'purged' } }]], true],
      ['an owner purge', [['delete_page', { outcome: { status: 'purged', write_through: { written: true } } }]], false],
      ['an owner purge whose receipt was compacted', [['delete_page', { intent: null, outcome: { status: 'purged', write_through: { written: true } } }]], false],
    ];
    for (const [i, [name, rows, expected]] of cases.entries()) {
      const slug = `notes/lineage-${i}`;
      for (const [operation, o] of rows) await receipt(slug, operation, o);
      const found = await readFileRemovingDeletes(engine, 'default', [{ path: `${slug}.md`, slug, pageId: 7 }]);
      expect([name, found.has(`${slug}.md`)]).toEqual([name, expected]);
    }
    // The read is per source: another source's sync never sees this source's receipts.
    expect((await readFileRemovingDeletes(engine, 'other', [{ path: 'notes/lineage-0.md', slug: 'notes/lineage-0', pageId: 7 }])).size).toBe(0);
  }, { databaseUrl, setup }), 240_000);

  test('a deletion that stands settles with no hold: the delete\'s own removal not committed yet, a delete that left the file, and an owner purge', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, 'notes/ivy-example', false);
    expect(git(root, 'status', '--porcelain')).toBe('D notes/ivy-example.md');
    await remove(engine, ctx, 'notes/kai-example', true);
    git(root, 'checkout', 'HEAD', '--', 'notes/kai-example.md');
    await engine.setConfig('sync.write_through', 'false');
    await remove(engine, ctx, 'notes/jon-example', true);
    expect(existsSync(join(root, 'notes/jon-example.md'))).toBe(true);
    expect(git(root, 'status', '--porcelain')).toBe('D notes/ivy-example.md');

    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({});
    expect(await pageState(engine, 'notes/ivy-example')).toBe('deleted');
    expect(await pageState(engine, 'notes/jon-example')).toBe('none');
    expect(await pageState(engine, 'notes/kai-example')).toBe('none');
  }, { databaseUrl, setup }), 240_000);
});
