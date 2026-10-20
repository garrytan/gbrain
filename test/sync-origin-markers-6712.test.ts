/**
 * #6712 PR 4b lane M (design v3.2 §2.5, probes 44, 45, 22): the deletion marker every page-row deletion of a managed
 * Git source writes, on a real managed brain (PGLite plus a Git checkout).
 *
 * Authoring gate: (1) protects the classifier's view of a purged origin: an unchanged file stays `deleted_same` and a
 * changed one `deleted_edited`, never `import` (resurrection); (2) a purge or a mirrored purge replay that writes no
 * marker, one written where it cannot matter (the origin left `last_commit` and the disk) or under a live page that
 * still owns the origin, fails here; (3) the helper's unit test cannot see the purge transaction or the replay;
 * (4) no seam: purges run through the coordinator and the replay through `replayPurges`, as production calls them.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { replayPurges, type PurgeMirrorLine } from '../src/core/belief/purge-mirror.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  mkdirSync(join(root, 'notes'), { recursive: true });
  for (const name of NAMES) writeFileSync(join(root, 'notes', name + '.md'), note(name, 'Synthetic ' + name + ' one.'));
  commit(root, 'notes');
};
const SYNC = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

async function markers(engine: BrainEngine): Promise<Map<string, { kind: string; blob_oids: string[]; slug: string; page_id: number; source_id: string; incarnation: string }>> {
  const rows = await engine.executeRaw<{ fingerprint: string; value: any }>("SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op='sync-origin-deleted'");
  return new Map(rows.map(row => [row.fingerprint.split(':').slice(2).join(':'), row.value]));
}
async function recordOids(engine: BrainEngine, origin: string): Promise<string[]> {
  const [row] = await engine.executeRaw<{ record: { blob_oid?: string; disk_blob_oid?: string } }>(
    "SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'origin'=$2", [SYNC_IMPORT_PROVENANCE_OP, origin]);
  return [...new Set([row?.record.blob_oid, row?.record.disk_blob_oid].filter((oid): oid is string => !!oid))];
}
async function mutate(ctx: OperationContext, engine: BrainEngine, slug: string, extra: Record<string, unknown> = {}) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return submitPageMutation(ctx, { operation: 'delete_page', params: { slug, request_id: randomUUID(), expected_revision: snapshot!.revision, ...extra }, waitMs: 30_000 });
}
const purge = (ctx: OperationContext, engine: BrainEngine, slug: string) => mutate(ctx, engine, slug, { purge: true });
const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: number; deleted_at: unknown; content_hash: string }>(
  "SELECT id, deleted_at, content_hash FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0] ?? null;
async function classOf(engine: BrainEngine, path: string) {
  const level = (await readShadowLevel(engine, { sourceId: 'default' }))!;
  return level.paths.find(entry => entry.path === path)?.result ?? null;
}

describe('#6712 PR 4b deletion markers (pglite)', () => {
  test('probe 44: a purge leaves a marker while the origin is in last_commit or on disk, and none once the file left both', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.setConfig('sync.write_through', 'false');

    // In last_commit only: a database delete, then the file removed from the worktree alone, then the purge.
    const betaOids = await recordOids(engine, 'notes/beta.md');
    expect(betaOids.length).toBeGreaterThan(0);
    expect((await mutate(ctx, engine, 'notes/beta')).state).toBe('committed');
    rmSync(join(root, 'notes', 'beta.md'));
    expect((await purge(ctx, engine, 'notes/beta')).state).toBe('committed');
    expect(await pageRow(engine, 'notes/beta')).toBeNull();
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    expect((await markers(engine)).get('notes/beta.md')).toMatchObject({ kind: 'deleted', blob_oids: betaOids, slug: 'notes/beta', source_id: 'default', incarnation: source!.incarnation });

    // On disk only: the commit no longer has it, the file is still there.
    git(root, 'rm', '-q', '--cached', 'notes/gamma.md');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'untrack gamma');
    await performManagedSync(engine, SYNC);
    const [after] = await engine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='default'");
    expect(after!.last_commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'ls-tree', after!.last_commit, '--', 'notes/gamma.md')).toBe('');
    expect((await purge(ctx, engine, 'notes/gamma')).state).toBe('committed');
    expect((await markers(engine)).get('notes/gamma.md')).toMatchObject({ kind: 'deleted', slug: 'notes/gamma' });

    // Left both: git rm, commit, the sync deletes the page, then the purge writes nothing.
    await engine.setConfig('sync.write_through', 'true');
    git(root, 'rm', '-q', 'notes/alpha.md');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'remove alpha');
    await performManagedSync(engine, SYNC);
    expect((await pageRow(engine, 'notes/alpha'))?.deleted_at).toBeTruthy();
    expect((await purge(ctx, engine, 'notes/alpha')).state).toBe('committed');
    expect(await pageRow(engine, 'notes/alpha')).toBeNull();
    expect((await markers(engine)).has('notes/alpha.md')).toBe(false);
    // ...so a new file at that path is a new page.
    writeFileSync(join(root, 'notes', 'alpha.md'), note('alpha', 'A new alpha.'));
    commit(root, 'new alpha');
    expect((await classOf(engine, 'notes/alpha.md'))?.cls).toBe('import');
  }, { setup }), 240_000);

  test('probe 44 (shared origin): a purged tombstone whose origin a live page still records writes no marker; without the twin it does', () => managedBrain(async ({ engine, ctx }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.setConfig('sync.write_through', 'false');
    // Without a twin: the marker is written (the origin is in last_commit and on disk).
    expect((await mutate(ctx, engine, 'notes/eta')).state).toBe('committed');
    expect((await purge(ctx, engine, 'notes/eta')).state).toBe('committed');
    expect((await markers(engine)).has('notes/eta.md')).toBe(true);
    // A live twin records delta's file; delta is soft-deleted (shared_origin) and purged: the twin owns the origin.
    // #6948: no writer records a held origin on a second page any more, so the twin's origin is set as legacy data left it.
    await dropOriginIndex(engine);
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.putPage('notes/delta-twin', { type: 'note', title: 'Twin', compiled_truth: 'A twin recording delta.', timeline: '', frontmatter: {}, content_hash: 'twin-delta' }, { sourceId: 'default' });
      await tx.executeRaw("UPDATE pages SET source_path='notes/delta.md' WHERE source_id='default' AND slug='notes/delta-twin'");
    }, TEST_WRITE_ATTRIBUTION));
    expect((await mutate(ctx, engine, 'notes/delta')).state).toBe('committed');
    expect((await purge(ctx, engine, 'notes/delta')).state).toBe('committed');
    expect(await pageRow(engine, 'notes/delta')).toBeNull();
    expect((await markers(engine)).has('notes/delta.md')).toBe(false);
  }, { setup }), 240_000);

  test('probe 45: a mirrored purge replay writes a marker, and the classifier reads deleted_same / deleted_edited for that path, never import', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    const page = (await pageRow(engine, 'notes/epsilon'))!;
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    const request = randomUUID();
    const lines: PurgeMirrorLine[] = [
      { kind: 'intent', request, request_id: request, source_id: 'default', source_incarnation: source!.incarnation, scope: 'page', recorded_at: new Date().toISOString(),
        purge_epoch: 0, slug: 'notes/epsilon', content_hashes: [page.content_hash], facts: [], takes: [], lifetimes: [] },
      { kind: 'committed', request, recorded_at: new Date().toISOString() },
    ];
    const replay = await replayPurges(engine, { lines, archivedAt: new Date(Date.now() - 60_000).toISOString(), apply: true });
    expect(replay.replays.map(r => r.request)).toEqual([request]);
    expect(await pageRow(engine, 'notes/epsilon')).toBeNull();
    expect((await markers(engine)).get('notes/epsilon.md')).toMatchObject({ kind: 'deleted', slug: 'notes/epsilon', blob_oids: await recordOids(engine, 'notes/epsilon.md') });
    expect(await classOf(engine, 'notes/epsilon.md')).toMatchObject({ cls: 'deleted_same', settled: true });
    writeFileSync(join(root, 'notes', 'epsilon.md'), note('epsilon', 'Synthetic epsilon two.'));
    commit(root, 'edit epsilon');
    expect(await classOf(engine, 'notes/epsilon.md')).toMatchObject({ cls: 'deleted_edited', state: 'purged_differs' });
  }, { setup }), 240_000);

  test('probe 22: a manual purge, then the same bytes back in a later commit, classifies deleted_same, never import', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.setConfig('sync.write_through', 'false');
    expect((await purge(ctx, engine, 'notes/zeta')).state).toBe('committed');
    expect((await markers(engine)).has('notes/zeta.md')).toBe(true);
    git(root, 'rm', '-q', 'notes/zeta.md');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'remove zeta');
    writeFileSync(join(root, 'notes', 'zeta.md'), note('zeta', 'Synthetic zeta one.'));
    commit(root, 'zeta back');
    expect(await classOf(engine, 'notes/zeta.md')).toMatchObject({ cls: 'deleted_same', settled: true });
  }, { setup }), 240_000);
});
