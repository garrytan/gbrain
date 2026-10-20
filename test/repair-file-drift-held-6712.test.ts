/**
 * #6712 PR 4b (design v3.2 §4, probe dx-native-1): `gbrain repair file-drift --held --side <side> [--state <state>]`
 * resolves the source's held `file_drift` pages of one Decision.
 *   - `--side deleted` without `--state` is refused (`file_drift_state_required`): in each deleted state --prefer file and
 *     --prefer database do opposite things;
 *   - a `--held` selection whose holds are several Decisions is refused (`file_drift_mixed_selection`) with the narrower
 *     commands;
 *   - each state's preview prints its action verb, and an apply per state does what the deleted-side table says:
 *     tombstone_edited: database keeps the deletion and removes the file (a coordinated publication), file restores the page
 *     and imports the file's bytes; purged_differs: database removes the file, file imports it as a new page and leaves the
 *     deletion marker for sync to retire; file_gone: database recreates the file, file soft-deletes the page.
 * Real PGLite (and Postgres when DATABASE_URL is set) with a claimed canonical Git worktree and real files; no seams.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { gitBlobOid } from '../src/core/persistence/digest.ts';
import { SYNC_ORIGIN_DELETED_OP } from '../src/core/persistence/sync-pass-row.ts';
import { gitHoldItem, readGitHold, writeGitHold, type FileDriftDeletedState, type FileDriftSide } from '../src/core/persistence/sync-holds.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;

for (const backend of testBackends()) describe(`#6712 PR 4b: repair file-drift --held --side/--state (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({}); await pglite.initSchema(); engine = pglite;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
  });

  interface Fixture { root: string; sourceId: string; ctx: OperationContext; incarnation: string }
  async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6712-held-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `held6712-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        await run({ root, sourceId, ctx, incarnation: source!.incarnation });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const put = (ctx: OperationContext, slug: string, body: string) =>
    submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: page(slug, body), request_id: randomUUID() } });
  const snapshot = (sourceId: string, slug: string) => engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  const remove = async (ctx: OperationContext, sourceId: string, slug: string, purge = false) => submitPageMutation(ctx, { operation: 'delete_page',
    params: { slug, request_id: randomUUID(), expected_revision: (await snapshot(sourceId, slug))!.revision, ...(purge ? { purge: true } : {}) } });
  const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', message); };
  /** The `file_drift` hold sync writes for a Decision (design v3.2 §4): its side, and for a deleted side its state. */
  const hold = (f: Fixture, input: { path: string; slug: string | null; pageId: number | null; side: FileDriftSide; state?: FileDriftDeletedState; revision?: string }) =>
    engine.transaction(tx => writeGitHold(tx, { source_id: f.sourceId, incarnation: f.incarnation, path: input.path, source_path: input.path, slug: input.slug,
      page_id: input.pageId, code: 'file_drift', message: `${input.path} is held: file drift (${input.side}${input.state ? ` ${input.state}` : ''})`, upstream_version: null,
      observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
      meta: { recovery_version: RECOVERY_VERSION, side: input.side, ...(input.state ? { state: input.state } : {}), ...(input.revision ? { page_revision: input.revision } : {}) } }));
  const run = async (sourceId: string, opts: { side?: string; state?: string; prefer: 'file' | 'database'; only?: string[]; expect?: string }) =>
    (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, sourceId),
      { explicit: true, sourceFlag: sourceId, held: true, prefer: opts.prefer, ...(opts.side ? { side: opts.side } : {}), ...(opts.state ? { state: opts.state } : {}),
        ...(opts.only ? { only: opts.only } : {}), ...(opts.expect ? { expect: opts.expect } : {}) });
  const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as OperationError; } throw new Error('expected a refusal'); };

  /** A soft-deleted page whose file then changed: the tombstone_edited Decision. */
  async function tombstoneEdited(f: Fixture, slug: string): Promise<{ path: string; pageId: number; revision: string }> {
    await put(f.ctx, slug, 'Before the delete.');
    commitAll(f.root, 'page');
    await remove(f.ctx, f.sourceId, slug);
    const path = `${slug}.md`;
    expect(existsSync(join(f.root, path))).toBe(false);
    writeFileSync(join(f.root, path), page(slug, 'Edited after the delete.'));
    const tombstone = (await snapshot(f.sourceId, slug))!;
    expect(tombstone.page.deleted_at).toBeTruthy();
    await hold(f, { path, slug, pageId: Number(tombstone.page.id), side: 'deleted', state: 'tombstone_edited', revision: tombstone.revision });
    return { path, pageId: Number(tombstone.page.id), revision: tombstone.revision };
  }
  /** A purged page whose file came back with other bytes: the purged_differs Decision, with the marker sync writes at purge. */
  async function purgedDiffers(f: Fixture, slug: string): Promise<{ path: string }> {
    await put(f.ctx, slug, 'What the brain held.');
    const path = `${slug}.md`;
    const held = readFileSync(join(f.root, path));
    await remove(f.ctx, f.sourceId, slug, true);
    expect(await snapshot(f.sourceId, slug)).toBeNull();
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array($3::text::jsonb))`,
      [SYNC_ORIGIN_DELETED_OP, `${f.sourceId}:${f.incarnation}:${path}`, JSON.stringify({ source_id: f.sourceId, incarnation: f.incarnation, kind: 'deleted',
        blob_oids: [gitBlobOid(held, 'sha1')], sha256: null, revision: null, page_id: null, at: new Date().toISOString() })]);
    writeFileSync(join(f.root, path), page(slug, 'A different file at the purged origin.'));
    await hold(f, { path, slug, pageId: null, side: 'deleted', state: 'purged_differs' });
    return { path };
  }
  /** A live page whose committed file is gone and whose page then changed: the file_gone Decision. */
  async function fileGone(f: Fixture, slug: string): Promise<{ path: string }> {
    await put(f.ctx, slug, 'The page.');
    commitAll(f.root, 'page');
    const path = `${slug}.md`;
    git(f.root, 'rm', '-q', '--', path); git(f.root, 'commit', '-q', '-m', 'remove');
    const live = (await snapshot(f.sourceId, slug))!;
    await hold(f, { path, slug, pageId: Number(live.page.id), side: 'deleted', state: 'file_gone', revision: live.revision });
    return { path };
  }
  const marker = async (f: Fixture, path: string) => (await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [SYNC_ORIGIN_DELETED_OP, `${f.sourceId}:${f.incarnation}:${path}`])).length > 0;

  test('--side deleted without --state is refused before anything is read, naming each state with its verb', () => fixture(async f => {
    const refused = await refusal(run(f.sourceId, { side: 'deleted', prefer: 'database' }));
    expect(refused.code).toBe('file_drift_state_required');
    for (const state of ['tombstone_edited', 'purged_differs', 'file_gone']) expect(refused.suggestion).toContain(`--held --side deleted --state ${state}`);
    expect(refused.suggestion).toContain('keep the deletion and remove the file');
    expect(refused.fix?.argv).toEqual(['gbrain', 'sources', 'status', f.sourceId, '--json']);
    expect((await refusal(run(f.sourceId, { state: 'file_gone', prefer: 'file' }))).code).toBe('invalid_params');
    expect((await refusal(run(f.sourceId, { side: 'both', state: 'file_gone', prefer: 'file' }))).code).toBe('invalid_params');
  }), 240_000);

  test('a held selection that mixes sides or states is refused with the narrower commands; one deleted state alone still needs --state', () => fixture(async f => {
    await put(f.ctx, 'notes/both', 'Live page.');
    await hold(f, { path: 'notes/both.md', slug: 'notes/both', pageId: Number((await snapshot(f.sourceId, 'notes/both'))!.page.id), side: 'both' });
    await tombstoneEdited(f, 'notes/tomb');
    await purgedDiffers(f, 'notes/purged');
    const mixed = await refusal(run(f.sourceId, { prefer: 'file' }));
    expect(mixed.code).toBe('file_drift_mixed_selection');
    expect(mixed.message).toContain('3 different Decisions');
    expect(mixed.suggestion).toContain(`gbrain repair file-drift --source ${f.sourceId} --held --side both --prefer file`);
    expect(mixed.suggestion).toContain('--held --side deleted --state tombstone_edited --prefer file');
    expect(mixed.suggestion).toContain('--held --side deleted --state purged_differs --prefer file');
    const states = await refusal(run(f.sourceId, { prefer: 'file', only: ['notes/tomb.md', 'notes/purged.md'] }));
    expect(states.code).toBe('file_drift_mixed_selection');
    const one = await refusal(run(f.sourceId, { prefer: 'file', only: ['notes/tomb.md'] }));
    expect(one.code).toBe('file_drift_state_required');
    expect(one.suggestion).toContain("--held --side deleted --state tombstone_edited --only notes/tomb.md --prefer file");
    expect(existsSync(join(f.root, 'notes/tomb.md'))).toBe(true);
  }), 240_000);

  test('tombstone_edited: --prefer database keeps the deletion and removes the file by a coordinated publication', () => fixture(async f => {
    const { path, revision } = await tombstoneEdited(f, 'notes/tomb');
    const preview = await run(f.sourceId, { side: 'deleted', state: 'tombstone_edited', prefer: 'database' });
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/tomb', action: 'remove_file', state: 'tombstone_edited', verb: 'keep the deletion and remove the file' })]);
    expect(preview.listing).toEqual(expect.arrayContaining([expect.objectContaining({ detail: `keep the deletion and remove the file: ${path}` })]));
    expect(preview.warnings).toEqual([expect.stringContaining("leaves each removed file's deletion uncommitted")]);
    expect(existsSync(join(f.root, path))).toBe(true);
    const applied = await run(f.sourceId, { side: 'deleted', state: 'tombstone_edited', prefer: 'database', expect: preview.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    expect(existsSync(join(f.root, path))).toBe(false);
    const after = (await snapshot(f.sourceId, 'notes/tomb'))!;
    expect(after.page.deleted_at).toBeTruthy();
    expect(after.revision).toBe(revision);
    expect(await readGitHold(engine, f.sourceId, f.incarnation, path)).toBeNull();
    const receipts = await engine.executeRaw<{ state: string; effects: number }>(`SELECT r.state, (SELECT count(*)::int FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git') AS effects
      FROM persistence_requests r WHERE r.source_id=$1 AND r.intent->>'kind'='managed_maintenance_file_drift_remove'`, [f.sourceId]);
    expect(receipts).toEqual([{ state: 'committed', effects: 1 }]);
  }), 240_000);

  test('tombstone_edited: --prefer file restores the page and imports the file\'s bytes', () => fixture(async f => {
    const { path } = await tombstoneEdited(f, 'notes/tomb');
    const preview = await run(f.sourceId, { side: 'deleted', state: 'tombstone_edited', prefer: 'file' });
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/tomb', action: 'import_file', verb: 'restore and import' })]);
    expect((await snapshot(f.sourceId, 'notes/tomb'))!.page.deleted_at).toBeTruthy();
    const applied = await run(f.sourceId, { side: 'deleted', state: 'tombstone_edited', prefer: 'file', expect: preview.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    const after = (await snapshot(f.sourceId, 'notes/tomb'))!;
    expect(after.page.deleted_at).toBeFalsy();
    expect(after.page.compiled_truth).toContain('Edited after the delete.');
    expect(readFileSync(join(f.root, path), 'utf8')).toContain('Edited after the delete.');
    expect(await readGitHold(engine, f.sourceId, f.incarnation, path)).toBeNull();
  }), 240_000);

  test('tombstone_edited: a file edited after the preview is changed_since_preview and is not removed', () => fixture(async f => {
    const { path } = await tombstoneEdited(f, 'notes/tomb');
    const preview = await run(f.sourceId, { side: 'deleted', state: 'tombstone_edited', prefer: 'database' });
    writeFileSync(join(f.root, path), page('notes/tomb', 'Edited again after the preview.'));
    const applied = await run(f.sourceId, { side: 'deleted', state: 'tombstone_edited', prefer: 'database', expect: preview.preview_hash! });
    expect(applied.outcomes).toEqual({ changed_since_preview: 1 });
    expect(readFileSync(join(f.root, path), 'utf8')).toContain('Edited again after the preview.');
    expect(await readGitHold(engine, f.sourceId, f.incarnation, path)).not.toBeNull();
  }), 240_000);

  test('purged_differs: --prefer database removes the file and leaves the deletion marker for sync to retire', () => fixture(async f => {
    const { path } = await purgedDiffers(f, 'notes/purged');
    const preview = await run(f.sourceId, { side: 'deleted', state: 'purged_differs', prefer: 'database' });
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/purged', action: 'remove_file', verb: 'remove the file' })]);
    const applied = await run(f.sourceId, { side: 'deleted', state: 'purged_differs', prefer: 'database', expect: preview.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    expect(existsSync(join(f.root, path))).toBe(false);
    expect(await snapshot(f.sourceId, 'notes/purged')).toBeNull();
    expect(await marker(f, path)).toBe(true);
    expect(await readGitHold(engine, f.sourceId, f.incarnation, path)).toBeNull();
  }), 240_000);

  test('purged_differs: --prefer file imports the file as a new page and leaves the marker for the pass to retire', () => fixture(async f => {
    const { path } = await purgedDiffers(f, 'notes/purged');
    const preview = await run(f.sourceId, { side: 'deleted', state: 'purged_differs', prefer: 'file' });
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/purged', action: 'import_file', verb: 'import as a new page' })]);
    const applied = await run(f.sourceId, { side: 'deleted', state: 'purged_differs', prefer: 'file', expect: preview.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    const after = (await snapshot(f.sourceId, 'notes/purged'))!;
    expect(after.page.deleted_at).toBeFalsy();
    expect(after.page.source_path).toBe(path);
    expect(after.page.compiled_truth).toContain('A different file at the purged origin.');
    expect(await marker(f, path)).toBe(true);
    expect(await readGitHold(engine, f.sourceId, f.incarnation, path)).toBeNull();
  }), 240_000);

  test('file_gone: --prefer database recreates the file, --prefer file soft-deletes the page', () => fixture(async f => {
    const { path } = await fileGone(f, 'notes/gone');
    const recreate = await run(f.sourceId, { side: 'deleted', state: 'file_gone', prefer: 'database' });
    expect(recreate.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/gone', action: 'recreate_file', verb: 'recreate the file' })]);
    const soft = await run(f.sourceId, { side: 'deleted', state: 'file_gone', prefer: 'file' });
    expect(soft.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/gone', action: 'soft_delete', verb: 'soft-delete the page' })]);
    const applied = await run(f.sourceId, { side: 'deleted', state: 'file_gone', prefer: 'database', expect: recreate.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    expect(readFileSync(join(f.root, path), 'utf8')).toContain('The page.');

    const second = await fileGone(f, 'notes/drop');
    const drop = await run(f.sourceId, { side: 'deleted', state: 'file_gone', prefer: 'file', only: [second.path] });
    const dropped = await run(f.sourceId, { side: 'deleted', state: 'file_gone', prefer: 'file', only: [second.path], expect: drop.preview_hash! });
    expect(dropped.outcomes).toEqual({ repaired: 1 });
    expect((await snapshot(f.sourceId, 'notes/drop'))!.page.deleted_at).toBeTruthy();
  }), 240_000);
});

test('a deleted-side file_drift hold lists its side and state, and its Decision names each option with its verb', () => {
  const base = { source_id: 'alpha', incarnation: 'i', path: 'notes/a.md', source_path: 'notes/a.md', slug: 'notes/a', page_id: 7, code: 'file_drift' as const,
    message: 'held', upstream_version: null, observed_at: 't', held_at: 't', updated_at: 't', run_id: null, mode: 'managed' as const, version: 1 as const };
  const tomb = gitHoldItem({ ...base, meta: { recovery_version: RECOVERY_VERSION, side: 'deleted', state: 'tombstone_edited', page_revision: 'r1' } });
  expect(tomb).toMatchObject({ side: 'deleted', state: 'tombstone_edited' });
  expect(tomb.fix.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'alpha', '--held', '--side', 'deleted', '--state', 'tombstone_edited', '--only', 'notes/a.md', '--prefer', 'database']);
  expect(tomb.fix.why).toContain('keep the deletion and remove the file');
  expect(tomb.fix.why).toContain('restore and import');
  const purged = gitHoldItem({ ...base, page_id: null, meta: { recovery_version: RECOVERY_VERSION, side: 'deleted', state: 'purged_differs' } });
  expect(purged.fix.why).toContain('remove the file');
  expect(purged.fix.why).toContain('import as a new page');
  const gone = gitHoldItem({ ...base, meta: { recovery_version: RECOVERY_VERSION, side: 'deleted', state: 'file_gone' } });
  expect(gone.fix.why).toContain('recreate the file');
  expect(gone.fix.why).toContain('soft-delete the page');
  const legacy = gitHoldItem({ ...base, meta: { recovery_version: RECOVERY_VERSION, sides: 'both' } });
  expect(legacy).toMatchObject({ side: 'both' });
  expect(legacy).not.toHaveProperty('state');
  expect(gitHoldItem({ ...base, meta: { recovery_version: RECOVERY_VERSION, sides: 'database' } })).not.toHaveProperty('side');
});
