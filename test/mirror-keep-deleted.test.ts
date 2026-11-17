/**
 * Keep it deleted on a read-only mirror: gbrain repair file-drift --held --side deleted --state tombstone_edited --prefer database
 * records the decision on the hold (meta.keep_deleted) instead of removing a file gbrain never writes. The hold stays,
 * reads as carried (mirror_keep_deleted) and needs nobody; it is carried across a re-check of the same bytes, voided by a
 * new upstream edit or a restore, and rebound to the deletion marker when the tombstone is purged. A pass whose only work is
 * re-checking such a hold is not saved work. The mirror's checkout is never written.
 * PGLite always; Postgres when DATABASE_URL is set (managedBrain). Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { gitHoldItem, readGitSourceHolds, type GitHoldRecord } from '../src/core/persistence/sync-holds.ts';
import { readPassRow, SYNC_ORIGIN_DELETED_OP } from '../src/core/persistence/sync-pass-row.ts';
import { passBanked } from '../src/core/persistence/sync-pass-status.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { resolveRepairScope, type RepairPlanOptions } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'notes/page-x';
const PATH = SLUG + '.md';
const doc = (body: string) => '---\ntype: concept\ntitle: Page X\n---\n\n' + body + '\n';
const commitFile = (root: string, body: string, message: string) => { writeFileSync(join(root, PATH), doc(body)); git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const setup = ({ root }: { root: string }) => { git(root, 'init', '-q'); mkdirSync(join(root, 'notes'), { recursive: true }); commitFile(root, 'The first upstream body.', 'pages'); };
const mirror = (engine: BrainEngine) => engine.executeRaw("UPDATE sources SET config = config || '{\"mirror_read_only\": true}'::jsonb WHERE id='default'");
const incarnation = async (engine: BrainEngine) => (await engine.executeRaw<{ i: string }>("SELECT incarnation::text AS i FROM sources WHERE id='default'"))[0]!.i;
const holdOf = async (engine: BrainEngine): Promise<GitHoldRecord | undefined> => (await engine.executeRaw<{ r: GitHoldRecord }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'path'=$1", [PATH]))[0]?.r;
const oldRecoveryVersion = (engine: BrainEngine) => engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,recovery_version}',$2::text::jsonb) "
  + "WHERE op='sync-hold' AND completed_keys->0->>'path'=$1", [PATH, JSON.stringify(RECOVERY_VERSION - 1)]);
const snapshot = (engine: BrainEngine) => engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
/** The checkout as Git and the disk see it. */
const checkout = (root: string) => ({ head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain', '--untracked-files=all'),
  file: readFileSync(join(root, PATH), 'utf8') });

async function repair(engine: BrainEngine, opts: Partial<RepairPlanOptions>): Promise<any> {
  return withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
    (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', held: true, side: 'deleted', state: 'tombstone_edited', ...opts } as never));
}

/** A page deleted in the database of a mirror whose upstream then edited its file: the tombstone_edited hold. */
async function tombstoneEdited(engine: BrainEngine, ctx: OperationContext, root: string): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await mirror(engine);
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: SLUG, request_id: randomUUID(), expected_revision: (await snapshot(engine))!.revision } });
  expect((await snapshot(engine))!.page.deleted_at).toBeTruthy();
  commitFile(root, 'The upstream edited this file after the page was deleted.', 'upstream edit');
  await performManagedSync(engine, OPTS);
  expect((await holdOf(engine))?.meta).toMatchObject({ side: 'deleted', state: 'tombstone_edited' });
}

/** Previews and applies keep-the-deletion on the mirror; the checkout is byte-identical before and after. */
async function keepDeleted(engine: BrainEngine, root: string): Promise<void> {
  const before = checkout(root);
  const preview = await repair(engine, { prefer: 'database' });
  expect(preview.details.pages).toEqual([expect.objectContaining({ slug: SLUG, action: 'keep_deleted', state: 'tombstone_edited', path: PATH })]);
  expect(JSON.stringify(preview.details.pages)).not.toContain('remove_file');
  const applied = await repair(engine, { prefer: 'database', expect: preview.preview_hash });
  expect(applied.applied).toBe(1);
  expect(checkout(root)).toEqual(before);
  const tombstone = (await snapshot(engine))!;
  expect(tombstone.page.deleted_at).toBeTruthy();
  expect(tombstone.page.compiled_truth).not.toContain('upstream edited');
  const hold = (await holdOf(engine))!;
  expect(hold.meta.keep_deleted).toMatchObject({ page_id: Number(tombstone.page.id), revision: tombstone.revision });
  expect(typeof hold.meta.keep_deleted!.request_id).toBe('string');
  expect(Number.isNaN(Date.parse(hold.meta.keep_deleted!.decided_at))).toBe(false);
}

describe.each(testBackends())('keep it deleted on a read-only mirror (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('the apply keeps the hold, marks it decided and carried (mirror_keep_deleted), and writes nothing into the mirror', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    await keepDeleted(engine, root);
    const status: any = await readSyncStatus(engine, 'default');
    expect(status.carried).toEqual([expect.objectContaining({ class: 'mirror_keep_deleted', count: 1, sample: [PATH] })]);
    expect(status.needs_human).toBe(false);
    expect(status.holds).toEqual([expect.objectContaining({ path: PATH, needs_human: false })]);
    const item = gitHoldItem((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]!.holds.find(hold => hold.path === PATH)!);
    expect(item.keep_deleted).toBeTruthy();
    expect(item.fix.why).toContain('mirror_keep_deleted');
    expect((await repair(engine, { prefer: 'database' })).details.pages).toEqual([]);
    // A source that is writable again behaves as before: the decision no longer counts and --prefer database removes the file.
    await engine.executeRaw("UPDATE sources SET config = config - 'mirror_read_only' WHERE id='default'");
    const writable: any = await readSyncStatus(engine, 'default');
    expect(writable.carried ?? []).toEqual([]);
    expect(writable.holds).toEqual([expect.objectContaining({ path: PATH, needs_human: true })]);
    expect((await repair(engine, { prefer: 'database' })).details.pages).toEqual([expect.objectContaining({ action: 'remove_file' })]);
  }, { databaseUrl, setup }), 600_000);

  test('6: a re-check of the same bytes after a recovery-version bump carries the decision, and status shows it carried', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    await keepDeleted(engine, root);
    const decided = (await holdOf(engine))!.meta.keep_deleted;
    await oldRecoveryVersion(engine);
    const before = checkout(root);
    const synced: any = await performManagedSync(engine, OPTS);
    expect(checkout(root)).toEqual(before);
    const hold = (await holdOf(engine))!;
    expect(hold.meta.recovery_version).toBe(RECOVERY_VERSION);
    expect(hold.meta.keep_deleted).toEqual(decided);
    expect(synced.carried).toEqual([expect.objectContaining({ class: 'mirror_keep_deleted', count: 1 })]);
    const status: any = await readSyncStatus(engine, 'default');
    expect(status.carried).toEqual([expect.objectContaining({ class: 'mirror_keep_deleted', count: 1 })]);
    expect(status.needs_human).toBe(false);
  }, { databaseUrl, setup }), 600_000);

  test('6b: in working-tree mode a re-check of the same bytes carries the decision too', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.include_working_tree', 'true');
    await tombstoneEdited(engine, ctx, root);
    expect((await holdOf(engine))!.meta).toMatchObject({ working: true });
    expect((await holdOf(engine))!.meta.blob_oid).toBeUndefined();
    await keepDeleted(engine, root);
    const decided = (await holdOf(engine))!.meta.keep_deleted;
    await oldRecoveryVersion(engine);
    await performManagedSync(engine, OPTS);
    const hold = (await holdOf(engine))!;
    expect(hold.meta.recovery_version).toBe(RECOVERY_VERSION);
    expect(hold.meta.keep_deleted).toEqual(decided);
    expect((await readSyncStatus(engine, 'default') as any).needs_human).toBe(false);
  }, { databaseUrl, setup }), 600_000);

  test('7a: a new upstream edit voids the decision: the hold asks again', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    await keepDeleted(engine, root);
    commitFile(root, 'The upstream edited the file once more.', 'second upstream edit');
    await performManagedSync(engine, OPTS);
    const hold = (await holdOf(engine))!;
    expect(hold.meta).toMatchObject({ side: 'deleted', state: 'tombstone_edited' });
    expect(hold.meta.keep_deleted).toBeUndefined();
    const status: any = await readSyncStatus(engine, 'default');
    expect(status.carried ?? []).toEqual([]);
    expect(status.holds).toEqual([expect.objectContaining({ path: PATH, needs_human: true })]);
    const asked = gitHoldItem((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]!.holds.find(held => held.path === PATH)!);
    expect(asked.fix.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'default', '--held', '--side', 'deleted', '--state', 'tombstone_edited', '--only', PATH, '--prefer', 'database']);
    expect(asked.fix.why).toContain('records it on the hold (mirror_keep_deleted; no file is removed');
    expect((await repair(engine, { prefer: 'database' })).details.pages).toEqual([expect.objectContaining({ action: 'keep_deleted' })]);
  }, { databaseUrl, setup }), 600_000);

  test('7b: gbrain restore voids the decision', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    await keepDeleted(engine, root);
    await submitPageMutation(ctx, { operation: 'restore_page', params: { slug: SLUG, request_id: randomUUID(), expected_revision: (await snapshot(engine))!.revision } });
    expect((await snapshot(engine))!.page.deleted_at).toBeFalsy();
    await performManagedSync(engine, OPTS);
    expect((await holdOf(engine))?.meta.keep_deleted).toBeUndefined();
    const status: any = await readSyncStatus(engine, 'default');
    expect((status.carried ?? []).filter((carried: { class: string }) => carried.class === 'mirror_keep_deleted')).toEqual([]);
  }, { databaseUrl, setup }), 600_000);

  test('8: a purged tombstone carries the decision to purged_differs, bound to the deletion marker', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    await keepDeleted(engine, root);
    const decided = (await holdOf(engine))!.meta.keep_deleted!;
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: SLUG, request_id: randomUUID(), expected_revision: (await snapshot(engine))!.revision, purge: true } });
    expect(await snapshot(engine)).toBeNull();
    await performManagedSync(engine, OPTS);
    const [marker] = await engine.executeRaw<{ value: unknown }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
      [SYNC_ORIGIN_DELETED_OP, 'default:' + await incarnation(engine) + ':' + PATH]);
    expect(marker?.value).toBeTruthy();
    const hold = (await holdOf(engine))!;
    expect(hold.meta).toMatchObject({ side: 'deleted', state: 'purged_differs' });
    expect(hold.meta.keep_deleted).toMatchObject({ request_id: decided.request_id, decided_at: decided.decided_at, marker_digest: digest(marker!.value) });
    const status: any = await readSyncStatus(engine, 'default');
    expect(status.carried).toEqual([expect.objectContaining({ class: 'mirror_keep_deleted', count: 1 })]);
    expect(status.needs_human).toBe(false);
  }, { databaseUrl, setup }), 600_000);

  test('10a: the apply refuses with changed_since_preview when the source stops being a read-only mirror after the preview', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    const preview = await repair(engine, { prefer: 'database' });
    await engine.executeRaw("UPDATE sources SET config = config - 'mirror_read_only' WHERE id='default'");
    const before = checkout(root);
    const applied = await repair(engine, { prefer: 'database', expect: preview.preview_hash });
    expect(applied.applied).toBe(0);
    expect(JSON.stringify(applied)).toContain('changed_since_preview');
    expect((await holdOf(engine))!.meta.keep_deleted).toBeUndefined();
    expect(checkout(root)).toEqual(before);
  }, { databaseUrl, setup }), 600_000);

  test('10b: the apply refuses with changed_since_preview when the hold was re-checked after the preview', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    const preview = await repair(engine, { prefer: 'database' });
    await oldRecoveryVersion(engine);
    await performManagedSync(engine, OPTS);
    const before = checkout(root);
    const applied = await repair(engine, { prefer: 'database', expect: preview.preview_hash });
    expect(applied.applied).toBe(0);
    expect(JSON.stringify(applied)).toContain('changed_since_preview');
    expect((await holdOf(engine))!.meta.keep_deleted).toBeUndefined();
    expect(checkout(root)).toEqual(before);
  }, { databaseUrl, setup }), 600_000);

  test('10c: a CLI writer whose grant does not cover the page can neither preview nor apply keep-the-deletion', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    await repair(engine, { prefer: 'file' });
    const [{ ceiling }] = await engine.executeRaw<{ ceiling: unknown }>("SELECT grant_ceiling AS ceiling FROM persistence_local_writers WHERE lane='cli' AND revoked_at IS NULL");
    const narrow = () => engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling = grant_ceiling || '{\"slugPrefixes\": [\"elsewhere\"]}'::jsonb WHERE lane='cli'");
    await narrow();
    const refused = await repair(engine, { prefer: 'database' });
    expect(refused.details.pages).toEqual([]);
    expect(JSON.stringify(refused)).toContain('permission_denied');
    await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling = $1::text::jsonb WHERE lane='cli'", [JSON.stringify(ceiling)]);
    const preview = await repair(engine, { prefer: 'database' });
    expect(preview.details.pages).toEqual([expect.objectContaining({ action: 'keep_deleted' })]);
    await narrow();
    const applied = await repair(engine, { prefer: 'database', expect: preview.preview_hash }).catch((error: unknown) => error);
    expect(JSON.stringify(applied, Object.getOwnPropertyNames(applied ?? {}))).toContain('permission_denied');
    expect((await holdOf(engine))!.meta.keep_deleted).toBeUndefined();
  }, { databaseUrl, setup }), 600_000);

  test('9: a pass whose only work is re-checking a kept deletion is not saved work, so it still builds the abandoned streak', () => managedBrain(async ({ engine, ctx, root }) => {
    await tombstoneEdited(engine, ctx, root);
    const inc = await incarnation(engine);
    const recheck = async () => {
      await oldRecoveryVersion(engine);
      await performManagedSync(engine, OPTS);
      const telemetry = (await readPassRow(engine, 'default', inc))!.value.telemetry;
      expect((await holdOf(engine))!.run_id).toBe(telemetry.pass_id);
      return passBanked(engine, 'default', inc, telemetry);
    };
    // Control: the same re-check of an undecided hold settles an older gbrain's hold, which is saved work.
    expect(await recheck()).toBe(true);
    await keepDeleted(engine, root);
    expect(await recheck()).toBe(false);
  }, { databaseUrl, setup }), 600_000);
});

describe('11: a repo-less brain', () => {
  test('the keep-the-deletion preview finds no held pages and does not refuse', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-keep-deleted-repoless-'));
    try {
      const env = { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' };
      const cli = (...args: string[]) => execFileSync('bun', ['run', join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      cli('init', '--pglite', '--no-embedding');
      const out = JSON.parse(cli('repair', 'file-drift', '--source', 'default', '--held', '--side', 'deleted', '--state', 'tombstone_edited', '--prefer', 'database', '--json'));
      const [result] = out.results;
      expect(result).toMatchObject({ kind: 'file-drift', affected: 0, failed: [], complete: true, listing: [] });
      expect(result.details.pages).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
