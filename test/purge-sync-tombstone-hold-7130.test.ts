/**
 * #7130: a managed sync deletion is not a person's decision, so its tombstone never becomes an automatic hard delete.
 *
 * Protects: the `managed_sync_delete` apply records the tombstone it made (op `sync-delete-tombstone`, `deleted_at` equal to
 * the page row's) and the checkpoint sweep keeps the record while that tombstone exists; the automatic purges (the cycle
 * purge phase and the `purge` job) keep an expired sync tombstone that no live page of its source duplicates, report it
 * `held` (blocked `sync_delete_unreviewed`, phase warn), and fall back to the uncompacted committed receipt when the
 * record is missing (a tombstone made before records existed); a sync tombstone with a live twin and a person's delete are
 * still purged; the consented `foresights pages purge-deleted` names the count in its preview and consent and purges them; the
 * cycle cutoff follows `purge.retention_hours`.
 *
 * PGLite always; Postgres with DATABASE_URL (test/postgres-unit-arms.txt).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runCycle } from '../src/core/cycle.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { purgeConsentRequest, purgeDeletedPagesCoordinated, selectPurgeCandidates } from '../src/core/persistence/purge-deleted.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { SYNC_DELETE_TOMBSTONE_OP } from '../src/core/persistence/sync-delete-tombstones.ts';
import { makePurgeHandler } from '../src/core/minions/handlers/purge.ts';
import { deleteSafetyConfigRefusal, readPurgeRetentionHours } from '../src/core/sync-reconcile.ts';
import { runPages } from '../src/commands/pages.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const GONE = 'notes/gone', TWIN = 'notes/twin', COPY = 'notes/twin-copy', USER = 'notes/user';
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, `${GONE}.md`), note('Gone', 'An agent-written page that exists nowhere else.'));
  writeFileSync(join(root, `${TWIN}.md`), note('Twin', 'The same words in two files.'));
  writeFileSync(join(root, `${COPY}.md`), note('Twin', 'The same words in two files.'));
  writeFileSync(join(root, `${USER}.md`), note('User', 'A page a person deletes.'));
  commit(root, 'notes');
};
const CONSENT_ENV = { GBRAIN_CONSENT: undefined };

const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: number | string; deleted_at: string | null; deleted_text: string | null }>(
  'SELECT id, deleted_at, deleted_at::text AS deleted_text FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug]))[0];
const record = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ r: Record<string, unknown>; same: boolean }>(
  `SELECT c.completed_keys->0 AS r, p.deleted_at = (c.completed_keys->0->>'deleted_at')::timestamptz AS same FROM op_checkpoints c JOIN pages p ON p.id::text = c.fingerprint
    WHERE c.op=$1 AND p.source_id='default' AND p.slug=$2`, [SYNC_DELETE_TOMBSTONE_OP, slug]))[0];

/** git rm GONE and TWIN, sync (the pass soft-deletes both), then a person deletes USER through delete_page. */
async function deleteBoth(engine: BrainEngine, ctx: OperationContext, root: string): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  git(root, 'rm', '-q', `${GONE}.md`, `${TWIN}.md`); commit(root, 'remove two notes');
  await performManagedSync(engine, OPTS);
  for (const slug of [GONE, TWIN]) expect((await page(engine, slug))?.deleted_at).not.toBeNull();
  const user = await engine.readPageSnapshot(USER, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: USER, expected_revision: user!.revision, request_id: randomUUID() } });
  expect((await page(engine, USER))?.deleted_at).not.toBeNull();
}
/** Ages every tombstone (and its record, which names its deleted_at) by `hours`, as time would. A fixture write, outside coordination. */
async function age(engine: BrainEngine, hours: number): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw(`UPDATE pages SET deleted_at = deleted_at - ($1 || ' hours')::interval WHERE source_id='default' AND deleted_at IS NOT NULL`, [String(hours)]);
  await engine.executeRaw(`UPDATE op_checkpoints c SET completed_keys = jsonb_set(c.completed_keys, '{0,deleted_at}', to_jsonb(p.deleted_at)) FROM pages p
    WHERE c.op=$1 AND p.id::text = c.fingerprint`, [SYNC_DELETE_TOMBSTONE_OP]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}
const purgePhase = async (engine: BrainEngine, root: string) =>
  (await withEnv(CONSENT_ENV, () => runCycle(engine, { brainDir: root, phases: ['purge'], sourceId: 'default' }))).phases.find(p => p.phase === 'purge')!;
async function cli(engine: BrainEngine, args: string[]): Promise<string> {
  const out: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try { await withEnv(CONSENT_ENV, () => runPages(engine, args)); }
  finally { log.mockRestore(); err.mockRestore(); }
  return out.join('\n');
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#7130 ${backend}: the automatic purge keeps managed sync tombstones`, () => {
    test('the record matches the tombstone and survives the checkpoint sweep while it exists', () => managedBrain(async ({ engine, ctx, root }) => {
      await deleteBoth(engine, ctx, root);
      const gone = await record(engine, GONE);
      expect(gone?.same).toBe(true);
      expect(gone?.r).toMatchObject({ source_id: 'default', slug: GONE, page_id: Number((await page(engine, GONE))!.id), source_path: `${GONE}.md` });
      expect(typeof gone?.r.pass_id === 'string' || typeof gone?.r.run_id === 'string').toBe(true);
      expect(await record(engine, USER)).toBeUndefined();
      await engine.executeRaw(`UPDATE op_checkpoints SET updated_at = now() - interval '30 days' WHERE op=$1`, [SYNC_DELETE_TOMBSTONE_OP]);
      await purgeStaleCheckpoints(engine, 7);
      expect((await record(engine, GONE))?.same).toBe(true);
    }, { setup, databaseUrl }), 300_000);

    test('cycle: a unique sync tombstone is held and reported, a twin and a person\'s delete are purged; the consented manual purge removes the held one', () => managedBrain(async ({ engine, ctx, root }) => {
      await deleteBoth(engine, ctx, root);
      await age(engine, 100);
      const phase = await purgePhase(engine, root);
      expect(phase.status).toBe('warn');
      expect(phase.summary).toContain('1 deleted by a managed sync held for review');
      expect(phase.details.purged_pages_blocked).toEqual([expect.objectContaining({ slug: GONE, code: 'sync_delete_unreviewed' })]);
      expect([...phase.details.purged_page_slugs as string[]].sort()).toEqual([TWIN, USER]);
      expect(await page(engine, GONE)).toBeDefined();
      expect(await page(engine, TWIN)).toBeUndefined();
      expect(await page(engine, USER)).toBeUndefined();
      // The purge job runs without consent too.
      expect(await makePurgeHandler(engine)({ data: { scope: 'pages' } } as never)).toMatchObject({ pagesPurged: 0, pagesBlocked: [expect.objectContaining({ slug: GONE, code: 'sync_delete_unreviewed' })] });

      const preview = JSON.parse(await cli(engine, ['purge-deleted', '--dry-run', '--json']));
      expect(preview).toMatchObject({ dry_run: true, count: 1, slugs: [GONE], sync_unreviewed: 1 });
      const consent = purgeConsentRequest(preview.count, 72, true, [], false, 0, preview.sync_unreviewed);
      expect(consent.user_message).toContain('1 of them were deleted by a managed sync');
      expect(consent.risk).toContain('only come back from a backup');
      await cli(engine, ['purge-deleted', '--json', '--yes']);
      expect(await page(engine, GONE)).toBeUndefined();
      await purgeStaleCheckpoints(engine, 0);
      expect((await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE op=$1', [SYNC_DELETE_TOMBSTONE_OP])).length).toBe(0);
    }, { setup, databaseUrl }), 300_000);

    test('a sync tombstone with no record is held by its uncompacted receipt', () => managedBrain(async ({ engine, ctx, root }) => {
      await deleteBoth(engine, ctx, root);
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [SYNC_DELETE_TOMBSTONE_OP]);
      await age(engine, 100);
      const result = await withEnv(CONSENT_ENV, () => purgeDeletedPagesCoordinated(engine, 72, { automatic: true }));
      expect(result).toMatchObject({ held: 1, failed: 0 });
      expect(result.blocked).toEqual([expect.objectContaining({ slug: GONE, code: 'sync_delete_unreviewed' })]);
      expect(await page(engine, GONE)).toBeDefined();
    }, { setup, databaseUrl }), 300_000);

    test('a brain deactivated after managed syncs still holds them (unmanaged purge)', () => managedBrain(async ({ engine, ctx, root }) => {
      await deleteBoth(engine, ctx, root);
      await age(engine, 100);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      expect(await selectPurgeCandidates(engine, 72)).toMatchObject({ managed: false, count: 3, sync_unreviewed: 1 });
      const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(result).toMatchObject({ held: 1, count: 2 });
      expect(await page(engine, GONE)).toBeDefined();
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }, { setup, databaseUrl }), 300_000);

    test('purge.retention_hours sets the cycle cutoff', () => managedBrain(async ({ engine, ctx, root }) => {
      await deleteBoth(engine, ctx, root);
      await age(engine, 100);
      await engine.setConfig('purge.retention_hours', '200');
      expect((await purgePhase(engine, root)).details.purged_pages_count).toBe(0);
      expect(await page(engine, USER)).toBeDefined();
      await engine.setConfig('purge.retention_hours', '96');
      expect([...(await purgePhase(engine, root)).details.purged_page_slugs as string[]].sort()).toEqual([TWIN, USER]);
    }, { setup, databaseUrl }), 300_000);

    // Contract for every soft delete that promises a 72-hour restore (an automatic repair's 'restore_72h' undo, such as
    // an origin-twin merge's losing twin, which has a live twin and so is not held as an unreviewed sync tombstone): no
    // retention setting lets the automatic purge take it inside 72 hours. A stored value below 72 is ignored (the default
    // applies) and `foresights config set` refuses it.
    test('no purge.retention_hours value purges a soft-deleted page inside 72 hours', () => managedBrain(async ({ engine, ctx, root }) => {
      await deleteBoth(engine, ctx, root);
      await age(engine, 71);
      for (const value of ['24', '48', '71', '0']) {
        expect(deleteSafetyConfigRefusal('purge.retention_hours', value)).toContain('at least 72');
        await engine.setConfig('purge.retention_hours', value);
        expect(await readPurgeRetentionHours(engine)).toBe(72);
        expect((await purgePhase(engine, root)).details.purged_pages_count).toBe(0);
      }
      expect(await page(engine, USER)).toBeDefined();
      expect(await page(engine, TWIN)).toBeDefined();
    }, { setup, databaseUrl }), 300_000);
  });
}
