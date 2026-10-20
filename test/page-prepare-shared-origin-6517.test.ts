/**
 * #6517 (GBRA-79 wave 16, G3.3 [R8][R9][R10][UC4]): two live pages of a
 * managed source record the same origin file (a duplicate-origin twin). Master
 * left no supported exit: `delete_page` of either refused `source_changed`
 * (the shared file's bytes render the other twin), reconcile refused the
 * survivor ("Several pages claim the recorded canonical file") and every sync
 * refused `page_identity_changed`.
 *
 * Now a soft delete of a page whose file another live page records keeps the
 * file and publishes database-only: receipt `write_through.skipped ===
 * 'shared_origin'` with the "hidden, not erased" text, file bytes unchanged,
 * the survivor's reconcile state readable again and the next managed sync
 * importing the file into the survivor (both choices of loser; `source_path`
 * in plain and `./`-prefixed spellings, and a `file:` URI). The survivor is
 * revalidated under publication: moved or removed during preparation, the
 * delete refuses and the file is never removed as a fallback. A purge of a
 * shared-origin page refuses and names the soft delete; a page whose origin is
 * not shared still refuses on drift. [R9]: the receipt names the surviving
 * slug to the trusted local owner and to a remote writer whose grant and
 * visibility cover it, never otherwise (no slug, no path in the receipt JSON).
 *
 * PGLite and, with DATABASE_URL, Postgres. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { shadowConvergence } from '../src/core/persistence/sync-pass.ts';
import { readReconcileState } from '../src/core/persistence/reconcile-state.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'synthetic content') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;
type Twin = 'path' | 'dot-path' | 'uri';

for (const backend of testBackends()) describe(`[${backend}] #6517 delete of a shared-origin page`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-6517-${backend}-`));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
  const context = (sourceId: string): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId });
  const call = (sourceId: string, name: string, params: Record<string, unknown>) => withEnv(env, () => op(name).handler(context(sourceId), params)) as Promise<Record<string, any>>;
  const page = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; deleted_at: string | null; compiled_truth: string; knowledge_revision: string; source_path: string | null }>(
    'SELECT id,deleted_at,compiled_truth,knowledge_revision,source_path FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0] ?? null;
  const revision = async (sourceId: string, slug: string) => (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!.revision;
  const count = async (sql: string, params: unknown[] = []) => Number((await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
  async function failure(fn: () => Promise<unknown>): Promise<OperationError> {
    try { await fn(); } catch (error) { expect(error).toBeInstanceOf(OperationError); return error as OperationError; }
    throw new Error('expected a refusal');
  }
  /** A managed git source with one synced file `<name>.md` (page `<name>`) and a second live page recording the same file. */
  async function twins(twin: Twin, names: { file: string; twin: string } = { file: 'alpha', twin: 'alpha-twin' }, body = note('Alpha', `Observation of ${names.file}, version one.`)) {
    const id = `tw-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
    const file = join(root, `${names.file}.md`), bytes = body;
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, bytes); commit(root);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await withEnv(env, () => claimWorktree(engine, id, root));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    expect((await withEnv(env, () => performManagedSync(engine, opts))).status).toBe('first_sync');
    expect((await page(id, names.file))?.source_path).toBe(`${names.file}.md`);
    const sourcePath = twin === 'uri' ? null : twin === 'dot-path' ? `./${names.file}.md` : `${names.file}.md`;
    // #6948: no writer records a held origin on a second page any more, so the twin's origin is set as legacy data left it.
    await engine.transaction(tx => withCoordinatedWrite(tx, [id], async () => {
      await tx.putPage(names.twin, { type: 'note', title: 'Twin', compiled_truth: `A twin recording ${names.file}.`,
        timeline: '', frontmatter: {}, content_hash: `twin-${names.file}`, source_uri: twin === 'uri' ? pathToFileURL(file).href : null }, { sourceId: id });
      if (sourcePath) await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [id, names.twin, sourcePath]);
    }, TEST_WRITE_ATTRIBUTION));
    return { id, root, file, bytes, opts, names };
  }
  const coordinated = (sourceId: string, sql: string, params: unknown[]) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
  const del = (sourceId: string, slug: string, extra: Record<string, unknown> = {}) => async () =>
    call(sourceId, 'delete_page', { slug, source_id: sourceId, request_id: randomUUID(), expected_revision: await revision(sourceId, slug), ...extra });

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    // Shared origins exist only on brains written before #6948, whose pages_live_origin_key index is pending.
    await dropOriginIndex(engine);
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); });
    await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  for (const twin of ['path', 'dot-path', 'uri'] as Twin[]) test(`[UC4][R10] deleting the twin (${twin} origin) keeps the file, publishes shared_origin, and the survivor reconciles and syncs again`, async () => {
    const f = await twins(twin);
    const survivorBefore = (await page(f.id, 'alpha'))!;
    const result = await (await del(f.id, 'alpha-twin'))();
    expect(result).toMatchObject({ state: 'committed', status: 'soft_deleted', write_through: { written: false, skipped: 'shared_origin' } });
    expect(result.write_through.warning).toContain('Another page of this source records the same file: alpha.');
    expect(result.write_through.warning).toContain('hidden');
    expect(result.write_through.warning).toContain('does not erase');
    expect(readFileSync(f.file)).toEqual(Buffer.from(f.bytes));
    expect((await page(f.id, 'alpha-twin'))!.deleted_at).not.toBeNull();
    expect(await page(f.id, 'alpha')).toEqual(survivorBefore);
    // The survivor's reconcile state reads again (master: 'Several pages claim the recorded canonical file.').
    const registration = await registerLocalWriter(engine, 'cli');
    const state = await withEnv(env, () => withVerifiedLocalRegistration(engine, registration, () => readReconcileState(engine, f.id, 'alpha')));
    expect(state.snapshot.page.slug).toBe('alpha');
    expect(state.raw).toEqual(Buffer.from(f.bytes));
    // A `./` spelling is a reconcile-only legacy origin form: sync discovery refuses it as a sync origin (unchanged), so the sync leg covers the two sync-valid forms.
    if (twin === 'dot-path') return;
    // The next managed sync imports the file (edited meanwhile) into the survivor through both origin guards.
    writeFileSync(f.file, note('Alpha', 'Observation of alpha, version two.')); commit(f.root, 'version two');
    const synced = await withEnv(env, () => performManagedSync(engine, f.opts));
    expect(synced).toMatchObject({ status: 'synced', filesImported: 1 });
    expect(synced.held_count ?? 0).toBe(0); expect(synced.managedWrite).toBeUndefined();
    expect((await page(f.id, 'alpha'))!.compiled_truth).toContain('version two');
    expect((await page(f.id, 'alpha-twin'))!.deleted_at).not.toBeNull();
  }, 120_000);

  test('[R8] deleting the page the file was synced into keeps the file for the twin; a full sync leaves the twin legacy_unverified and repair file-drift --prefer file imports the file', async () => {
    const f = await twins('path');
    const result = await (await del(f.id, 'alpha'))();
    expect(result).toMatchObject({ state: 'committed', status: 'soft_deleted', write_through: { written: false, skipped: 'shared_origin' } });
    expect(result.write_through.warning).toContain('alpha-twin');
    // #6712 PR 1: the receipt names the repair that imports the file into the survivor, never a --full sync (which holds it).
    const repair = ['gbrain', 'repair', 'file-drift', '--source', f.id, '--slug', 'alpha-twin', '--prefer', 'file'];
    expect(result.write_through.warning).toContain(repair.join(' '));
    expect(result.write_through.warning).not.toContain('--full');
    expect(readFileSync(f.file)).toEqual(Buffer.from(f.bytes));
    // The kept file still holds the deleted page's text and is unchanged in git, so an incremental sync has nothing to import.
    expect((await withEnv(env, () => performManagedSync(engine, f.opts))).status).toBe('up_to_date');
    expect((await page(f.id, 'alpha-twin'))!.compiled_truth).toBe('A twin recording alpha.');
    // #6712 PR 4b (design v3.2 §2.3 row 17, §2.7): the twin has no import record, no proof and a file unchanged since the
    // baseline, so a full pass settles it legacy_unverified, counted and never overwritten; it surfaces as a Decision only if
    // the file then changes. The receipt's repair above stays the way to import the file into the survivor.
    const full = await withEnv(env, () => performManagedSync(engine, { ...f.opts, full: true }));
    expect(full).toMatchObject({ status: 'synced', filesImported: 0, pass: { kind: 'full', outcome: 'synced' } });
    expect(full.managedWrite).toBeUndefined();
    expect(full.held ?? []).toEqual([]);
    expect((await withEnv(env, () => shadowConvergence(engine, { sourceId: f.id })))?.counts).toEqual({ legacy_unverified: 1 });
    // Nothing the run returns tells the survivor to run --full.
    expect(JSON.stringify(full)).not.toContain('--full');
    expect((await page(f.id, 'alpha-twin'))!.compiled_truth).toBe('A twin recording alpha.');
    const logger = { info() {}, warn() {}, error() {} };
    await withEnv(env, async () => {
      const scope = await resolveRepairScope(engine, f.id);
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('file-drift', scope, { explicit: true, sourceFlag: f.id, slugs: ['alpha-twin'], prefer: 'file' });
      expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
      const applied = await (await repairRunner(engine, { apply: true, logger })).run('file-drift', scope,
        { explicit: true, sourceFlag: f.id, slugs: ['alpha-twin'], prefer: 'file', expect: preview.preview_hash });
      expect(applied.outcomes).toEqual({ repaired: 1 });
    });
    const synced = await withEnv(env, () => performManagedSync(engine, f.opts));
    expect(synced.held_count ?? 0).toBe(0);
    const survivor = (await page(f.id, 'alpha-twin'))!;
    expect(survivor.deleted_at).toBeNull();
    expect(survivor.compiled_truth).toContain('Observation of alpha, version one.');
    expect((await page(f.id, 'alpha'))!.deleted_at).not.toBeNull();
    expect(readFileSync(f.file, 'utf8')).toContain('Observation of alpha, version one.');
  }, 120_000);

  test('[R8] a purge of a shared-origin page refuses and names the soft delete; nothing is tombstoned', async () => {
    const f = await twins('path');
    const before = { purges: await count('page_purges'), twin: await page(f.id, 'alpha-twin'), alpha: await page(f.id, 'alpha') };
    const error = await failure(await del(f.id, 'alpha-twin', { purge: true }));
    expect(error.code).toBe('source_changed');
    expect(error.message).toContain('shared with another live page');
    expect(error.message).toContain('Soft-delete it instead');
    expect(error.message).toContain('nothing is erased');
    expect(error.writeRequest?.state).toBe('conflict');
    expect(await count('page_purges')).toBe(before.purges);
    expect(await page(f.id, 'alpha-twin')).toEqual(before.twin);
    expect(await page(f.id, 'alpha')).toEqual(before.alpha);
    expect(readFileSync(f.file)).toEqual(Buffer.from(f.bytes));
  }, 120_000);

  test('[R8] a page whose origin is not shared still refuses on drift: the fix does not widen the window', async () => {
    const f = await twins('path');
    expect((await (await del(f.id, 'alpha-twin'))()).write_through.skipped).toBe('shared_origin');
    writeFileSync(f.file, note('Alpha', 'An uncoordinated local edit.'));
    const error = await failure(await del(f.id, 'alpha'));
    expect(error.code).toBe('source_changed');
    expect(error.message).toContain('uncoordinated local edit');
    expect((await page(f.id, 'alpha'))!.deleted_at).toBeNull();
    expect(readFileSync(f.file, 'utf8')).toBe(note('Alpha', 'An uncoordinated local edit.'));
  }, 120_000);

  test('[R8] the survivor is revalidated under publication: removed, moved or no longer a claimant during preparation refuses, and the file is never removed', async () => {
    const f = await twins('path');
    const moved = join(f.root, 'alpha-moved.md');
    const cases: Array<{ name: string; disturb: () => Promise<void>; restore: () => Promise<void>; what: string }> = [
      { name: 'file moved', disturb: async () => renameSync(f.file, moved), restore: async () => renameSync(moved, f.file), what: 'moved or removed' },
      { name: 'survivor deleted', disturb: async () => { await coordinated(f.id, 'UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [f.id, 'alpha']); },
        restore: async () => { await coordinated(f.id, 'UPDATE pages SET deleted_at=NULL WHERE source_id=$1 AND slug=$2', [f.id, 'alpha']); }, what: 'pages recording the shared file changed' },
      { name: 'survivor re-pointed', disturb: async () => { await coordinated(f.id, 'UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [f.id, 'alpha', 'elsewhere.md']); },
        restore: async () => { await coordinated(f.id, 'UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [f.id, 'alpha', 'alpha.md']); }, what: 'pages recording the shared file changed' },
    ];
    for (const c of cases) {
      const requestId = randomUUID();
      installFaultHook(async (point, detail) => { if (point === 'consumer:prepared' && detail.requestId === requestId) await c.disturb(); });
      try {
        const error = await failure(async () => call(f.id, 'delete_page', { slug: 'alpha-twin', source_id: f.id, request_id: requestId, expected_revision: await revision(f.id, 'alpha-twin') }));
        expect(error.code).toBe('source_changed');
        expect(error.message).toContain('shared canonical file changed');
        expect(error.message).toContain(c.what);
        expect(error.writeRequest?.state).toBe('conflict');
      } finally { installFaultHook(undefined); await c.restore(); }
      expect((await page(f.id, 'alpha-twin'))!.deleted_at).toBeNull();
      expect(existsSync(f.file)).toBe(true);
      expect(readFileSync(f.file)).toEqual(Buffer.from(f.bytes));
    }
    // With nothing disturbed, the same delete commits.
    expect((await (await del(f.id, 'alpha-twin'))()).write_through.skipped).toBe('shared_origin');
  }, 180_000);

  test('[R9] a remote writer learns the surviving slug only when its grant and visibility cover it', async () => {
    const cases = [
      { label: 'out of prefix', names: { file: 'private-area/keeper-7731', twin: 'notes/twin-a' }, visible: false },
      { label: 'in prefix', names: { file: 'notes/keeper-8842', twin: 'notes/twin-b' }, visible: true },
      { label: 'in prefix but private', names: { file: 'notes/keeper-9953', twin: 'notes/twin-c' }, visible: false, privateSurvivor: true },
    ];
    for (const c of cases) {
      const f = await twins('path', c.names, c.privateSurvivor ? `---\ntitle: Keeper\nvisibility: private\n---\nPrivate observation.\n` : undefined);
      if (c.privateSurvivor) expect((await engine.executeRaw<{ v: string }>("SELECT frontmatter->>'visibility' AS v FROM pages WHERE source_id=$1 AND slug=$2", [f.id, c.names.file]))[0]!.v).toBe('private');
      const registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes/'] });
      const auth = { token: 'fixture', clientId: `fixture-${c.names.twin.replace('/', '-')}`, scopes: ['read', 'write'], sourceId: f.id, boundSlugPrefixes: ['notes/'] };
      const expected = await revision(f.id, c.names.twin);
      const result = await withEnv(env, () => withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'delete_page',
        { slug: c.names.twin, source_id: f.id, request_id: randomUUID(), expected_revision: expected },
        { remote: true, config: { engine: backend }, sourceId: f.id, auth, logger: { info() {}, warn() {}, error() {} }, writeWaitMs: 30_000 }))) as { content: Array<{ text: string }> };
      const text = result.content.map(part => part.text).join('\n');
      expect(text).toContain('"skipped":"shared_origin"');
      expect(text).toContain('hidden');
      if (c.visible) expect(text).toContain(`records the same file: ${c.names.file}.`);
      else {
        expect(text).toContain('Another page of this source records the same file.');
        expect(text).not.toContain(c.names.file.split('/').pop()!);
        expect(text).not.toContain(f.root);
      }
      expect((await page(f.id, c.names.twin))!.deleted_at).not.toBeNull();
      expect(existsSync(f.file)).toBe(true);
    }
  }, 180_000);
});
