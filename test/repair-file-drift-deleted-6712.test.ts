/**
 * #6712 wave: `gbrain repair file-drift` resolves a live page whose canonical file is gone from the last commit.
 *
 * Before the wave, reconcile refused a missing canonical file ("repair does not restore files"), so the route every
 * missing-file receipt and held deletion named led nowhere. Now, preview-first and bound to the page revision and the
 * observed absence:
 *   - `--prefer database` recreates the canonical file from the page through the coordinated reconcile publication;
 *   - `--prefer file` soft-deletes exactly that page through the ghost-page retirement intent;
 *   - a file that reappears, or a page revision that moves, between preview and apply is `changed_since_preview` and
 *     nothing is written;
 *   - a file deleted only in the worktree (still committed at HEAD) is not file-drift's to resolve: the preview and
 *     the reconcile refusal route it to committing the deletion or `gbrain repair ghost-pages`, while a file gone from
 *     HEAD routes to `gbrain repair file-drift`.
 * Real PGLite (and Postgres when DATABASE_URL is set) with a claimed canonical Git worktree; no seams.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { gitHoldFix } from '../src/core/persistence/sync-holds.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;

for (const backend of testBackends()) describe(`#6712 wave: deleted-file repair modes (${backend})`, () => {
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

  interface Fixture { root: string; sourceId: string; ctx: OperationContext }
  async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6712-deleted-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `del6712-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        await run({ root, sourceId, ctx });
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
  /** Commits every page file, then removes `slugs`' files: committed (`git rm` + commit) or only in the worktree. */
  function removeFiles(root: string, slugs: string[], how: 'committed' | 'worktree'): void {
    git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', 'pages');
    for (const slug of slugs) {
      if (how === 'committed') git(root, 'rm', '-q', '--', `${slug}.md`); else unlinkSync(join(root, `${slug}.md`));
    }
    if (how === 'committed') git(root, 'commit', '-q', '-m', 'remove files');
  }
  const run = async (sourceId: string, opts: { slugs: string[]; prefer: 'file' | 'database'; expect?: string }) =>
    (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, sourceId),
      { explicit: true, sourceFlag: sourceId, slugs: opts.slugs, prefer: opts.prefer, ...(opts.expect ? { expect: opts.expect } : {}) });
  const snapshot = async (sourceId: string, slug: string) => (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
  const bumpRevision = (sourceId: string, slug: string) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId],
    () => tx.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id=$1 AND slug=$2', [sourceId, slug]), TEST_WRITE_ATTRIBUTION));

  test('--prefer database recreates a canonical file whose deletion is committed; the page is unchanged', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, 'notes/keep', 'The database copy wins.');
    const file = join(root, 'notes/keep.md');
    removeFiles(root, ['notes/keep'], 'committed');
    expect((await liveFileDrift(engine, sourceId, 'notes/keep')).reason).toBe('canonical_file_missing');
    const before = await snapshot(sourceId, 'notes/keep');

    const preview = await run(sourceId, { slugs: ['notes/keep'], prefer: 'database' });
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/keep', action: 'recreate_file' })]);
    expect(preview.warnings).toEqual([expect.stringContaining('Git durability is off')]);
    expect(existsSync(file)).toBe(false);

    const applied = await run(sourceId, { slugs: ['notes/keep'], prefer: 'database', expect: preview.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    expect(readFileSync(file, 'utf8')).toContain('The database copy wins.');
    expect(await liveFileDrift(engine, sourceId, 'notes/keep')).toMatchObject({ still_present: false, reason: 'agrees' });
    const after = await snapshot(sourceId, 'notes/keep');
    expect(after.page.deleted_at).toBeFalsy();
    expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
  }), 240_000);

  test('--prefer file soft-deletes exactly the page whose committed file is gone', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, 'notes/drop', 'The deletion wins.');
    await put(ctx, 'notes/other', 'Untouched.');
    removeFiles(root, ['notes/drop'], 'committed');

    const preview = await run(sourceId, { slugs: ['notes/drop'], prefer: 'file' });
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/drop', action: 'soft_delete' })]);
    expect((await snapshot(sourceId, 'notes/drop')).page.deleted_at).toBeFalsy();

    const applied = await run(sourceId, { slugs: ['notes/drop'], prefer: 'file', expect: preview.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    expect((await snapshot(sourceId, 'notes/drop')).page.deleted_at).toBeTruthy();
    expect((await snapshot(sourceId, 'notes/other')).page.deleted_at).toBeFalsy();
    expect(existsSync(join(root, 'notes/drop.md'))).toBe(false);
  }), 240_000);

  test('both modes are bound to the observed absence and the page revision: a reappearing file or a moved page writes nothing', () => fixture(async ({ root, sourceId, ctx }) => {
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) await put(ctx, slug, `Body of ${slug}.`);
    removeFiles(root, ['notes/a', 'notes/b', 'notes/c'], 'committed');
    const recreate = await run(sourceId, { slugs: ['notes/a'], prefer: 'database' });
    const dropMoved = await run(sourceId, { slugs: ['notes/b'], prefer: 'file' });
    const dropBack = await run(sourceId, { slugs: ['notes/c'], prefer: 'file' });
    expect([recreate.affected, dropMoved.affected, dropBack.affected]).toEqual([1, 1, 1]);

    const local = page('notes/a', 'Written back by hand.');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes/a.md'), local);
    await bumpRevision(sourceId, 'notes/b');
    writeFileSync(join(root, 'notes/c.md'), page('notes/c', 'Restored by hand.'));

    expect((await run(sourceId, { slugs: ['notes/a'], prefer: 'database', expect: recreate.preview_hash! })).outcomes).toEqual({ changed_since_preview: 1 });
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toBe(local);
    expect((await run(sourceId, { slugs: ['notes/b'], prefer: 'file', expect: dropMoved.preview_hash! })).outcomes).toEqual({ changed_since_preview: 1 });
    expect((await snapshot(sourceId, 'notes/b')).page.deleted_at).toBeFalsy();
    expect((await run(sourceId, { slugs: ['notes/c'], prefer: 'file', expect: dropBack.preview_hash! })).outcomes).toEqual({ changed_since_preview: 1 });
    expect((await snapshot(sourceId, 'notes/c')).page.deleted_at).toBeFalsy();
  }), 240_000);

  test('routing: deleted only in the worktree goes to committing the deletion or repair ghost-pages; gone from HEAD goes to repair file-drift', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, 'notes/route', 'Routed.');
    removeFiles(root, ['notes/route'], 'worktree');

    const preview = await run(sourceId, { slugs: ['notes/route'], prefer: 'database' });
    expect(preview.affected).toBe(0);
    expect(preview.residuals).toMatchObject({ deletion_uncommitted: 1 });
    const listed = (preview.listing ?? []).find(entry => entry.item === `${sourceId}:notes/route`)!;
    expect(listed.class).toBe('deletion_uncommitted');
    expect(listed.detail).toContain('commit the deletion');
    expect(listed.detail).toContain(`gbrain repair ghost-pages --source ${sourceId}`);
    expect(existsSync(join(root, 'notes/route.md'))).toBe(false);

    const refusal = async () => withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'),
      () => runReconcilePreview(engine, { source_id: sourceId, slug: 'notes/route' })).then(() => { throw new Error('preview of a missing file succeeded'); },
      (error: unknown) => { if (error instanceof OperationError) return error; throw error; });
    const uncommitted = await refusal();
    expect(uncommitted.code).toBe('source_changed');
    expect(uncommitted.suggestion).toContain('commit the deletion');
    expect(uncommitted.suggestion).toContain(`gbrain repair ghost-pages --source ${sourceId}`);
    expect(uncommitted.suggestion).not.toContain('repair file-drift');

    git(root, 'rm', '-q', '--cached', '--', 'notes/route.md'); git(root, 'commit', '-q', '-m', 'commit the deletion');
    const committed = await refusal();
    expect(committed.code).toBe('source_changed');
    expect(committed.suggestion).toContain(`gbrain repair file-drift --source ${sourceId} --slug notes/route --prefer database`);
    expect(committed.suggestion).toContain('--prefer file');
  }), 240_000);

  test('--prefer file soft deletes honor the mass-delete valve: over half of the file-backed pages refuses unless GBRAIN_ALLOW_MASS_RECONCILE=1', () => fixture(async ({ root, sourceId, ctx }) => {
    const slugs = Array.from({ length: 22 }, (_, i) => `notes/m-${String(i).padStart(2, '0')}`);
    for (const slug of slugs) await put(ctx, slug, `Body of ${slug}.`);
    const gone = slugs.slice(0, 12);
    removeFiles(root, gone, 'committed');
    const preview = await run(sourceId, { slugs: gone, prefer: 'file' });
    expect(preview.affected).toBe(12);
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: undefined }, async () => {
      await expect(run(sourceId, { slugs: gone, prefer: 'file', expect: preview.preview_hash! })).rejects.toMatchObject({ code: 'ghost_mass_delete_refused' });
    });
    for (const slug of gone) expect((await snapshot(sourceId, slug)).page.deleted_at).toBeFalsy();
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => {
      expect((await run(sourceId, { slugs: gone, prefer: 'file', expect: preview.preview_hash! })).outcomes).toEqual({ repaired: 12 });
    });
    for (const slug of gone) expect((await snapshot(sourceId, slug)).page.deleted_at).toBeTruthy();
    expect((await snapshot(sourceId, slugs[12]!)).page.deleted_at).toBeFalsy();
  }), 240_000);
});

test('a held deletion whose page moved routes to repair file-drift, not to a reconcile preview that refuses a missing file', () => {
  const fix = gitHoldFix({ source_id: 'notes-src', path: 'notes/gone.md', code: 'concurrent_write', slug: 'notes/gone',
    meta: { recovery_version: 1, deleted: true, page_revision: '00000000-0000-4000-8000-000000000001' } } as never);
  expect(fix.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'notes-src', '--slug', 'notes/gone', '--prefer', 'database']);
  expect(fix.why).toContain('--prefer file');
  const live = gitHoldFix({ source_id: 'notes-src', path: 'notes/edited.md', code: 'concurrent_write', slug: 'notes/edited',
    meta: { recovery_version: 1 } } as never);
  expect(live.argv).toEqual(['gbrain', 'sources', 'reconcile', 'notes-src', 'notes/edited', '--preview']);
});
