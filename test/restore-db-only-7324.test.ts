/**
 * #7324: a declared db_only tombstone in a managed checkout restores without
 * recreating its ignored origin. Real Git, operation dispatch and full sync;
 * no provider calls or mocked publication. Both storage engines share the suite.
 * The regression fails when detach is rejected merely because write-through is on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const restore = operations.find(op => op.name === 'restore_page')!;
const home = realpathSync(mkdtempSync(join(tmpdir(), 'restore-db-only-')));
const env = { GBRAIN_HOME: home };
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string) {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
}

for (const backend of testBackends()) describe(`#7324 db_only restore (${backend})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; close = pg.close;
    } else {
      engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    }
    await engine.setConfig('sync.write_through', 'true');
  }, 120_000);
  afterAll(async () => withEnv(env, async () => {
    await disposePersistenceConsumer(engine); await engine.disconnect(); await close?.();
  }), 120_000);

  async function fixture(cache: boolean, declare = true) {
    const sourceId = `restore-${randomUUID().slice(0, 8)}`;
    const root = join(home, sourceId); mkdirSync(join(root, 'library'), { recursive: true });
    git(root, 'init', '-q');
    const slug = 'library/card';
    const path = join(root, `${slug}.md`);
    const bytes = '---\ntype: note\ntitle: Library card\ntags: [retained]\nprivate: true\n---\nOriginal prose.\n\n## Timeline\n\n- 2026-01-02: Original history.\n';
    writeFileSync(path, bytes); commit(root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect(await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true })).toMatchObject({ filesImported: 1 });
    const original = await engine.readPageSnapshot(slug, { sourceId });
    git(root, 'rm', '--cached', `${slug}.md`);
    writeFileSync(join(root, '.gitignore'), '/library/\n'); commit(root);
    if (!cache) rmSync(path);
    // Delete through real sync before the declaration, matching historical tombstones.
    await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true });
    const tombstone = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    expect(tombstone?.page.deleted_at).toBeTruthy();
    if (declare) writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - library/\n');
    return { sourceId, root, slug, path, bytes, original: original!, tombstone: tombstone! };
  }
  async function restorePage(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
    const params = { slug: f.slug, source_id: f.sourceId, expected_revision: f.tombstone.revision, request_id: randomUUID(), ...extra };
    const ctx = { engine, config: { engine: backend }, logger: { info() {}, warn() {}, error() {} }, remote: false, sourceId: f.sourceId, dryRun: false } as OperationContext;
    return { result: await restore.handler(ctx, params) as Record<string, any>, replay: () => restore.handler(ctx, params) };
  }

  for (const cache of [false, true]) test(`detach preserves identity/content/history and full-sync survival, ignored cache=${cache}`, async () => withEnv(env, async () => {
    const f = await fixture(cache);
    if (cache) writeFileSync(f.path, 'An unrelated ignored cache must not be overwritten.\n');
    const beforeFile = cache ? readFileSync(f.path, 'utf8') : null;
    const { result, replay } = await restorePage(f, { detach: true });
    expect(result.status).toBe('restored');
    expect(result.write_through).not.toMatchObject({ written: true });
    const restored = await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId });
    expect(restored?.page).toMatchObject({ id: f.original.page.id, source_path: null, compiled_truth: f.original.page.compiled_truth,
      timeline: f.original.page.timeline, frontmatter: f.original.page.frontmatter });
    expect(restored?.tags).toEqual(f.original.tags);
    expect(await engine.executeRaw('SELECT database_only_reason FROM pages WHERE id=$1', [f.original.page.id])).toEqual([{ database_only_reason: 'detached' }]);
    expect(await replay()).toEqual(result);
    for (let i = 0; i < 2; i++) {
      await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, full: true });
      expect((await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId }))?.page.id).toBe(f.original.page.id);
    }
    expect(existsSync(f.path)).toBe(cache);
    if (cache) expect(readFileSync(f.path, 'utf8')).toBe(beforeFile!);
    expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE source_id=$1 AND kind='git'", [f.sourceId])).toHaveLength(0);
  }), 120_000);

  test('plain restore of an absent declared origin refuses instead of recreating the file', async () => withEnv(env, async () => {
    const f = await fixture(false);
    await expect(restorePage(f)).rejects.toMatchObject({ code: 'source_changed', detail: 'canonical_file_absent' });
    expect(existsSync(f.path)).toBe(false);
  }), 120_000);

  test('declared live pages survive committed untracking in incremental and full sync', async () => withEnv(env, async () => {
    const f = await fixture(true);
    git(f.root, 'add', '-f', `${f.slug}.md`); commit(f.root);
    expect((await restorePage(f)).result.status).toBe('restored');
    await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true });
    git(f.root, 'rm', '--cached', `${f.slug}.md`); commit(f.root);
    rmSync(f.path);
    for (const full of [false, true, true]) {
      const result = await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, full });
      expect(result.deleted).toBe(0);
      expect((await engine.getPage(f.slug, { sourceId: f.sourceId }))?.id).toBe(f.original.page.id);
    }
  }), 120_000);

  test('a tracked origin still refuses detach and ordinary file-backed restore still works', async () => withEnv(env, async () => {
    const f = await fixture(true);
    git(f.root, 'add', '-f', `${f.slug}.md`); commit(f.root);
    await expect(restorePage(f, { detach: true })).rejects.toMatchObject({ code: 'invalid_params' });
    const { result } = await restorePage(f);
    expect(result.status).toBe('restored');
    expect((await engine.getPage(f.slug, { sourceId: f.sourceId }))?.source_path).toBe(`${f.slug}.md`);
  }), 120_000);

  test('publication rechecks a queued detach when its origin returns to Git', async () => withEnv(env, async () => {
    const f = await fixture(true);
    const binding = (await getWorktreeBinding(engine, f.sourceId))!;
    const row = { source_id: f.sourceId, worktree_id: binding.worktree_id, slug: f.slug, operation: 'restore_page', intent: { detach: true } };
    expect(await prepareFileTarget(engine, row, f.tombstone, f.bytes)).toBeUndefined();
    git(f.root, 'add', '-f', `${f.slug}.md`); commit(f.root);
    await expect(prepareFileTarget(engine, row, f.tombstone, f.bytes)).rejects.toMatchObject({ code: 'invalid_params' });
    expect((await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId, includeDeleted: true }))?.page.deleted_at).toBeTruthy();
    expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
  }), 120_000);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
