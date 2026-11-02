/**
 * #7324: a managed brain (write-through on) whose library/ cards were committed, then declared storage.db_only in
 * gbrain.yml, untracked and ignored. On a real managed brain (PGLite, and Postgres through the E2E wrapper), this
 * protects:
 * - a managed sync, incremental and full, keeps every live page under a declared db_only dir whose file left Git (an
 *   ignored cache file still on disk, or no file at all): zero deletions, while a committed-then-removed page outside
 *   db_only is still deleted;
 * - restore_page with detach: true of a sync-deleted db_only card restores it database-only on the managed source:
 *   same page id, content and history, source_path cleared, database_only_reason='detached', the ignored cache file
 *   left as it was and no file created for the card that has none; the next syncs keep it live;
 * - a plain restore of a db_only card keeps its recorded file and the next full sync no longer deletes it;
 * - the guards stay: a stale expected_revision refuses, and a tracked page outside db_only still refuses detach
 *   because the restore re-creates its file.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { discoverManagedSync } from '../src/core/persistence/sync-discovery.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const restore_page = operations.find(op => op.name === 'restore_page')!;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const CARDS = ['library/card-cached', 'library/card-gone', 'library/card-plain'];
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  for (const slug of [...CARDS, 'notes/keep', 'notes/control']) {
    mkdirSync(join(root, slug, '..'), { recursive: true });
    writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  }
  commit(root, 'seed');
};

/** Untracks and ignores library/ (its cache files stay on disk, except card-gone's) and git rm's notes/control. */
function untrackLibrary(root: string) {
  writeFileSync(join(root, '.gitignore'), 'library/\n');
  git(root, 'rm', '-r', '-q', '--cached', 'library');
  git(root, 'rm', '-q', 'notes/control.md');
  rmSync(join(root, 'library/card-gone.md'));
  commit(root, 'untrack library');
}
function declareDbOnly(root: string) {
  writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - library/\n');
  commit(root, 'declare library db_only');
}

const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: number; live: boolean; source_path: string | null; database_only_reason: string | null; compiled_truth: string }>(
  "SELECT id, deleted_at IS NULL AS live, source_path, database_only_reason, compiled_truth FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
const versions = async (engine: BrainEngine, slug: string) => Number((await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id='default' AND p.slug=$1", [slug]))[0]!.n);
const syncDeletes = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id='default' AND state='committed' AND intent->>'kind'='managed_sync_delete'"))[0]!.n);

async function restore(ctx: OperationContext, slug: string, extra: Record<string, unknown> = {}) {
  const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return restore_page.handler(ctx, { slug, source_id: 'default', expected_revision: snapshot!.revision, request_id: randomUUID(), ...extra }) as Promise<Record<string, any>>;
}
async function refusal(promise: Promise<unknown>): Promise<OperationError> {
  try { await promise; } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

for (const backend of testBackends()) describe(`[${backend}] #7324: declared db_only pages on a managed write-through source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a managed sync, incremental and full, keeps live db_only pages whose file left Git; a removed page outside db_only is deleted', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    declareDbOnly(root);
    untrackLibrary(root);
    const ids = await Promise.all(CARDS.map(async slug => (await pageRow(engine, slug)).id));
    // The frozen manifest a dry run and a company brain read selects the same: only notes/control is deleted.
    for (const full of [false, true]) {
      const discovered = await discoverManagedSync(engine, { ...OPTS, full });
      expect(discovered.entries.filter(entry => entry.action === 'delete').map(entry => entry.sourcePath)).toEqual(['notes/control.md']);
    }
    await performManagedSync(engine, OPTS);
    expect((await pageRow(engine, 'notes/control')).live).toBe(false);
    const deletes = await syncDeletes(engine);
    await performManagedSync(engine, { ...OPTS, full: true });
    for (const [i, slug] of CARDS.entries()) expect(await pageRow(engine, slug)).toMatchObject({ id: ids[i], live: true, source_path: `${slug}.md` });
    expect((await pageRow(engine, 'notes/keep')).live).toBe(true);
    expect(await syncDeletes(engine)).toBe(deletes);
    expect(readFileSync(join(root, 'library/card-cached.md'), 'utf8')).toBe(note('library/card-cached', 'The committed body of library/card-cached.'));
  }, { databaseUrl, setup }), 240_000);

  test('detach restores a sync-deleted db_only card database-only with its identity; the next syncs keep it; guards stay', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const liveRevision = (await engine.readPageSnapshot('library/card-cached', { sourceId: 'default' }))!.revision;
    // The reported state: the cards were committed, untracked and ignored, and a full managed sync soft-deleted them.
    untrackLibrary(root);
    await performManagedSync(engine, { ...OPTS, full: true });
    for (const slug of CARDS) expect((await pageRow(engine, slug)).live).toBe(false);
    expect(await syncDeletes(engine)).toBe(CARDS.length + 1);
    declareDbOnly(root);
    const cached = readFileSync(join(root, 'library/card-cached.md'), 'utf8');
    const before = Object.fromEntries(await Promise.all(CARDS.map(async slug => [slug, { row: await pageRow(engine, slug), versions: await versions(engine, slug) }] as const)));

    const stale = await refusal(restore(ctx, 'library/card-cached', { detach: true, expected_revision: liveRevision }));
    expect(stale.code).toBe('revision_conflict');
    expect((await pageRow(engine, 'library/card-cached')).live).toBe(false);

    for (const slug of ['library/card-cached', 'library/card-gone']) {
      expect((await restore(ctx, slug, { detach: true })).status).toBe('restored');
      expect(await pageRow(engine, slug)).toEqual({ ...before[slug]!.row, live: true, source_path: null, database_only_reason: 'detached' });
      expect(await versions(engine, slug)).toBeGreaterThanOrEqual(before[slug]!.versions);
    }
    expect(readFileSync(join(root, 'library/card-cached.md'), 'utf8')).toBe(cached);
    expect(existsSync(join(root, 'library/card-gone.md'))).toBe(false);

    // A plain restore keeps the recorded file; the full sync below must not delete it again.
    expect((await restore(ctx, 'library/card-plain')).status).toBe('restored');
    expect(await pageRow(engine, 'library/card-plain')).toMatchObject({ id: before['library/card-plain']!.row.id, live: true, source_path: 'library/card-plain.md' });

    const deletes = await syncDeletes(engine);
    await performManagedSync(engine, OPTS);
    await performManagedSync(engine, { ...OPTS, full: true });
    expect(await syncDeletes(engine)).toBe(deletes);
    for (const slug of ['library/card-cached', 'library/card-gone']) {
      expect(await pageRow(engine, slug)).toMatchObject({ id: before[slug]!.row.id, live: true, source_path: null, database_only_reason: 'detached' });
    }
    expect(await pageRow(engine, 'library/card-plain')).toMatchObject({ live: true, source_path: 'library/card-plain.md' });
    expect(existsSync(join(root, 'library/card-gone.md'))).toBe(false);

    // A tracked page outside db_only: the restore re-creates its file, so detach is refused exactly as before.
    const keep = await engine.readPageSnapshot('notes/keep', { sourceId: 'default' });
    const requestId = randomUUID();
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/keep', expected_revision: keep!.revision, request_id: requestId } });
    await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
      { timeoutMs: 20_000, label: 'delete_page notes/keep commits' });
    await settleManagedGitEffects(engine);
    const refused = await refusal(restore(ctx, 'notes/keep', { detach: true }));
    expect(refused.code).toBe('invalid_params');
    expect(refused.suggestion).toContain('gets its file re-created by this restore');
    expect((await pageRow(engine, 'notes/keep')).live).toBe(false);
    expect((await restore(ctx, 'notes/keep')).status).toBe('restored');
    expect(await pageRow(engine, 'notes/keep')).toMatchObject({ live: true, source_path: 'notes/keep.md', database_only_reason: null });
    expect(existsSync(join(root, 'notes/keep.md'))).toBe(true);
  }, { databaseUrl, setup }), 240_000);
});
