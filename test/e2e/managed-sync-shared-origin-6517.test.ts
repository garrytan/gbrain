/**
 * #6517 (GBRA-79 wave 16, G3.3 [R7]): the managed sync path end to end with a
 * duplicate-origin twin. Two live pages of the source record one file: the
 * run holds that file `origin_conflict` (#6948; it used to refuse the whole
 * source with `page_identity_changed`). After
 * the loser is soft-deleted (the shared-origin delete keeps the file), the run
 * imports the file into the survivor through both origin guards (discovery
 * census, `assertSyncPageOrigin` at preparation and publication), then edits
 * and deletes the survivor from the checkout. A single tombstone still
 * resurrects when its file returns; two tombstones still refuse; a winner
 * whose liveness changes between the census and the publication never
 * receives the import. Master: the twin's tombstone kept every run refusing
 * (`assertSyncPageOrigin` counted tombstones), the Eng P1 probe.
 *
 * PGLite and, with DATABASE_URL, Postgres. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { readManagedSyncFailures } from '../../src/core/persistence/sync-failures.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { dropOriginIndex } from '../helpers/origin-index.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'synthetic content') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;

for (const backend of testBackends()) describe(`[${backend}] #6517 managed sync with a duplicate-origin twin`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-6517-e2e-${backend}-`));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
  const sync = (opts: Record<string, unknown>) => withEnv(env, () => performManagedSync(engine, opts as Parameters<typeof performManagedSync>[1]));
  const page = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; deleted_at: string | null; compiled_truth: string; source_path: string | null }>(
    'SELECT id,deleted_at,compiled_truth,source_path FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0] ?? null;
  const coordinated = (sourceId: string, sql: string, params: unknown[]) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
  async function softDelete(sourceId: string, slug: string) {
    const context: OperationContext = { engine, config: { engine: backend, embedding_disabled: true } as never, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId };
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
    return withEnv(env, () => op('delete_page').handler(context, { slug, source_id: sourceId, request_id: randomUUID(), expected_revision: snapshot.revision })) as Promise<Record<string, any>>;
  }
  /** A managed git source whose `alpha.md` synced into page `alpha`, plus a live page `alpha-twin` recording the same file. */
  async function twins() {
    const id = `tw-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
    const file = join(root, 'alpha.md');
    writeFileSync(file, note('Alpha, version one.')); commit(root);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await withEnv(env, () => claimWorktree(engine, id, root));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    expect((await sync(opts)).status).toBe('first_sync');
    // #6948: no writer records a held origin on a second page any more, so the twin's origin is set as legacy data left it.
    await engine.transaction(tx => withCoordinatedWrite(tx, [id], async () => {
      await tx.putPage('alpha-twin', { type: 'note', title: 'Twin', compiled_truth: 'A twin recording alpha.', timeline: '', frontmatter: {}, content_hash: 'twin' }, { sourceId: id });
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [id, 'alpha-twin', 'alpha.md']);
    }, TEST_WRITE_ATTRIBUTION));
    return { id, root, file, opts };
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    await dropOriginIndex(engine);
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); });
    await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('two live claimants hold their file (the rest syncs); after the loser is soft-deleted the file imports, edits and deletes through both guards; a single tombstone resurrects', async () => {
    const f = await twins();
    writeFileSync(f.file, note('Alpha, version two.')); commit(f.root, 'version two');
    // #6948: the twin no longer refuses the source; only its file is held origin_conflict (the bodies differ: a person decides).
    const held = await sync(f.opts);
    expect(held.status).toBe('synced');
    const [hold] = (await readGitSourceHolds(engine, { sourceIds: [f.id] }))[0]?.holds ?? [];
    expect(hold).toMatchObject({ path: 'alpha.md', code: 'origin_conflict', meta: { reason: 'content_differs', canonical_slug: 'alpha' } });
    expect((await page(f.id, 'alpha'))!.compiled_truth).toContain('version one');
    // The exit: the twin is hidden, the file stays.
    expect(await softDelete(f.id, 'alpha-twin')).toMatchObject({ state: 'committed', write_through: { skipped: 'shared_origin' } });
    expect(readFileSync(f.file, 'utf8')).toBe(note('Alpha, version two.'));
    // Import through discovery and both assertSyncPageOrigin calls (master: page_identity_changed, the tombstone still counted).
    const imported = await sync(f.opts);
    expect(imported).toMatchObject({ status: 'synced', filesImported: 1 });
    expect(imported.held_count ?? 0).toBe(0); expect(imported.managedWrite).toBeUndefined();
    const survivor = (await page(f.id, 'alpha'))!;
    expect(survivor.compiled_truth).toContain('version two');
    expect((await page(f.id, 'alpha-twin'))!.deleted_at).not.toBeNull();
    // Edit the survivor from the checkout.
    writeFileSync(f.file, note('Alpha, version three.')); commit(f.root, 'version three');
    expect(await sync(f.opts)).toMatchObject({ status: 'synced', filesImported: 1 });
    expect((await page(f.id, 'alpha'))!.compiled_truth).toContain('version three');
    // Delete the survivor from the checkout: a managed_sync_delete with requireOrigin, the tombstone twin not counted.
    rmSync(f.file); commit(f.root, 'remove alpha');
    const deleted = await sync(f.opts);
    expect(deleted.status).toBe('synced'); expect(deleted.managedWrite).toBeUndefined();
    expect((await page(f.id, 'alpha'))!.deleted_at).not.toBeNull();
    expect((await page(f.id, 'alpha'))!.id).toBe(survivor.id);
    // Two tombstones record the file: its return is ambiguous, as before.
    writeFileSync(f.file, note('Alpha returns.')); commit(f.root, 'alpha returns');
    const ambiguous = await sync(f.opts).then(() => null, error => error as Error & { code?: string });
    expect(ambiguous?.code).toBe('page_identity_changed');
    expect((await page(f.id, 'alpha'))!.deleted_at).not.toBeNull();
    // Point the twin tombstone elsewhere: one tombstone left, which the file resurrects (same page id).
    await coordinated(f.id, 'UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug=$2', [f.id, 'alpha-twin']);
    const resurrected = await sync(f.opts);
    expect(resurrected.managedWrite).toBeUndefined();
    const back = (await page(f.id, 'alpha'))!;
    expect(back).toMatchObject({ id: survivor.id, deleted_at: null });
    expect(back.compiled_truth).toContain('Alpha returns');
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
  }, 180_000);

  test('a winner whose liveness changes between the census and the publication never receives the import', async () => {
    const f = await twins();
    expect(await softDelete(f.id, 'alpha-twin')).toMatchObject({ state: 'committed', write_through: { skipped: 'shared_origin' } });
    writeFileSync(f.file, note('Alpha, version two.')); commit(f.root, 'version two');
    // Between the census (winner: alpha) and the publication, the twin comes back and alpha is hidden.
    let swapped = false;
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:preparing' || detail.sourceId !== f.id || swapped) return;
      swapped = true;
      await coordinated(f.id, 'UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [f.id, 'alpha']);
      await coordinated(f.id, 'UPDATE pages SET deleted_at=NULL WHERE source_id=$1 AND slug=$2', [f.id, 'alpha-twin']);
    });
    let result: Awaited<ReturnType<typeof performManagedSync>> | null = null, error: (Error & { code?: string }) | null = null;
    try { result = await sync(f.opts); } catch (e) { error = e as Error & { code?: string }; } finally { installFaultHook(undefined); }
    expect(swapped).toBe(true);
    // Neither page received version two through the stale census: the twin keeps its body, alpha stays hidden and unchanged.
    expect((await page(f.id, 'alpha-twin'))!).toMatchObject({ deleted_at: null, compiled_truth: 'A twin recording alpha.' });
    expect((await page(f.id, 'alpha'))!.compiled_truth).toContain('version one');
    expect((await page(f.id, 'alpha'))!.deleted_at).not.toBeNull();
    expect(error ? error.code : result!.status === 'synced' && (result!.held_count ?? 0) === 0 && !result!.managedWrite ? 'clean import' : 'refused').not.toBe('clean import');
    expect(existsSync(f.file)).toBe(true);
    // Once the twin is the one live claimant, the next run (a new request past the frozen refusal) imports the file into it.
    const next = await sync({ ...f.opts, retryFailed: true });
    expect(next.managedWrite).toBeUndefined();
    expect((await page(f.id, 'alpha-twin'))!.compiled_truth).toContain('version two');
  }, 180_000);
});
