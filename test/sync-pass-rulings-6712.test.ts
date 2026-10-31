/**
 * #6712 PR 4b lane A: the parent's classifier rulings after the seeded shadow validation (Garry's Q3 = A invariant: a
 * settled path is matched, held, or in a class whose action says who finishes it).
 *
 * Protects:
 * - b1: a legacy marker settles a page-less path only when it records a deletion. A committed file with no page, no hold
 *   and no committed deletion of its slug imports (on the bootstrap pass too), so a file refused before it ever had a page
 *   (#6865, #6875 gate 2) is not reported synced; a page deleted before PR 4 (a committed delete_page of its slug) stays
 *   `legacy_same`, and the bootstrap pass writes its marker with the deleting request as proof.
 * - b2: a path with a hold row never settles in another class: a re-screen-due hold (frontmatter_slug_conflict,
 *   legacy_slug_conflict) is `held` with `rescreenDue` and the pass re-runs it; a hold over a level that must not be
 *   imported over (database ahead) stands as a settled `held`.
 * - b4: the action is per path: a settled `dirty` path is `none`, an unsettled one `repair`; the receipt counts each
 *   class by it (`by_action`).
 * - b5: under `--full` or an open episode, a legacy-marked path imports (v3.1 §2.7).
 * - b6: the convergence receipt counts #6885 legacy twin pairs (`legacy_twin_pairs`) with legacy-twins' read-only scan.
 * - legacy cursor handover (design v3.2 §3.5): the first pass retires an unfinished cursor, inherits its opt-outs (a
 *   flagless pass reports them in `inherited_options`) and, from a `--full` cursor, a full episode; no cursor row remains.
 * - shadow finding (a): a write queued with sync.write_through=false (no worktree) is open work, so the changed file it
 *   would race is `in_flight`; in working mode a committed `git rm` of a synced file reads absent (`delete`).
 *
 * Each test fails on capy/6712-pr4b (8cda2764b): there a baseline-equal legacy marker settles every page-less file, a
 * re-screen-due hold falls through to `matched` or `legacy_same`, results carry no `classAction`, the receipt has no
 * `by_action` or `legacy_twin_pairs`, and `--full` keeps legacy-marked paths `legacy_same`.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { classifySyncPath, type SyncPathState } from '../src/core/persistence/sync-classify.ts';
import { MANAGED_SYNC_PASS_OP, readShadowLevel, shadowConvergence, SYNC_ORIGIN_DELETED_OP } from '../src/core/persistence/sync-pass.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { preparePageAdmission, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedCursorKey } from '../src/core/persistence/sync-cursor-key.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

const base: SyncPathState = { mode: 'committed', tree: 'A', level: 'A', present: true, dirty: 'clean', diskOid: 'A',
  page: { live: true, revision: 'R1', originMatches: true }, record: { blobOids: ['A'], revision: 'R1', parserSame: true },
  attested: null, levelSha256: 'sha-A', published: false, hold: null, marker: null, baseline: 'A', spelling: false, episodeUnsatisfied: false, keepDb: false, openWork: false };
const at = (patch: Partial<SyncPathState>): SyncPathState => ({ ...base, ...patch });
const pageless = { page: null, record: null } as const;

/** Raw rows as an older gbrain left them: managed persistence off around the write. */
async function raw<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
async function deletePage(engine: BrainEngine, ctx: OperationContext, slug: string): Promise<string> {
  const requestId = randomUUID();
  const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, request_id: requestId, expected_revision: current!.revision } });
  await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
    { timeoutMs: 20_000, label: `the delete_page of ${slug} commits` });
  return (await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]!.id;
}
const classOf = async (engine: BrainEngine, path: string, full = false) => {
  const level = await readShadowLevel(engine, { sourceId: 'default', full });
  return level!.paths.find(entry => entry.path === path)?.result;
};
const liveSlugs = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);

describe('#6712 PR 4b classifier rulings (pure)', () => {
  test('b1: a baseline-equal legacy marker without a recorded deletion settles nothing; the page-less file imports (owner)', () => {
    expect(classifySyncPath(at({ ...pageless, marker: { kind: 'legacy', blobOids: ['A'] } }))).toMatchObject({ cls: 'import', settled: false, action: 'import', classAction: 'owner' });
    expect(classifySyncPath(at({ ...pageless, marker: { kind: 'legacy', blobOids: ['A'], deletion: 'req-1' } }))).toMatchObject({ cls: 'legacy_same', settled: true, classAction: 'none' });
    expect(classifySyncPath(at({ ...pageless }))).toMatchObject({ cls: 'import', settled: false });
  });

  test('b2: a re-screen-due hold is held and re-run, never settled in a later row; a hold over a database-ahead level stands', () => {
    for (const hold of [{ atLevel: true, rescreenDue: true, retried: false }, { atLevel: true, rescreenDue: false, retried: true }, { atLevel: false, rescreenDue: false, retried: false }]) {
      expect(classifySyncPath(at({ hold }))).toMatchObject({ cls: 'held', settled: false, action: 'import', rescreenDue: true, classAction: 'owner' });
      expect(classifySyncPath(at({ ...pageless, hold }))).toMatchObject({ cls: 'held', settled: false, action: 'import', rescreenDue: true, classAction: 'owner' });
    }
    const dbAhead = at({ hold: { atLevel: true, rescreenDue: true, retried: false }, page: { live: true, revision: 'R2', originMatches: true } });
    expect(classifySyncPath(dbAhead)).toMatchObject({ cls: 'held', settled: true, action: 'none', classAction: 'repair' });
    const drift = at({ hold: { atLevel: true, rescreenDue: true, retried: false }, tree: 'B', level: 'B', page: { live: true, revision: 'R2', originMatches: true } });
    expect(classifySyncPath(drift)).toMatchObject({ cls: 'drift', settled: false, action: 'hold', side: 'both' });
  });

  test('b4: the action is per path: a settled dirty path is none, an unsettled one repair', () => {
    expect(classifySyncPath(at({ dirty: 'modified', diskOid: 'C' }))).toMatchObject({ cls: 'dirty', settled: true, classAction: 'none' });
    expect(classifySyncPath(at({ tree: 'B', level: 'B', dirty: 'staged', diskOid: 'C', published: true }))).toMatchObject({ cls: 'dirty', settled: true, classAction: 'none' });
    expect(classifySyncPath(at({ tree: 'B', level: 'B', dirty: 'modified', diskOid: 'C' }))).toMatchObject({ cls: 'dirty', settled: false, classAction: 'repair' });
    expect(classifySyncPath(at({ tree: 'B', level: 'B', openWork: true }))).toMatchObject({ cls: 'import', inFlight: true, classAction: 'owner' });
  });

  test('b5: under --full or an open episode a legacy-marked path imports', () => {
    expect(classifySyncPath(at({ ...pageless, marker: { kind: 'legacy', blobOids: ['A'], deletion: 'req-1' }, fullObligation: true }))).toMatchObject({ cls: 'import', settled: false, classAction: 'owner' });
  });
});

describe('#6712 PR 4b classifier rulings (pglite)', () => {
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
    commit(root, 'notes');
  };

  test('b1/b5: a page-less file with no deletion imports on the bootstrap pass; a page deleted before PR 4 stays legacy_same (marker with proof) but imports under --full', () => managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // An older gbrain's state: notes/b never got a page (refused once); notes/c was deleted by delete_page and its
    // tombstone purged before PR 4 (no deleted marker). No pass row and no markers yet.
    const deletion = await deletePage(engine, ctx, 'notes/c');
    await raw(engine, () => engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug IN ('notes/b','notes/c')"));
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op IN ($1,$2)', [MANAGED_SYNC_PASS_OP, SYNC_ORIGIN_DELETED_OP]);

    expect(await classOf(engine, 'notes/b.md')).toMatchObject({ cls: 'import', settled: false, action: 'import' });
    expect(await classOf(engine, 'notes/c.md')).toMatchObject({ cls: 'legacy_same', settled: true });
    expect(await classOf(engine, 'notes/c.md', true)).toMatchObject({ cls: 'import', settled: false, action: 'import' });

    const result = await performManagedSync(engine, OPTS);
    expect(result.status).not.toBe('blocked_by_failures');
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b']);
    const markers = await engine.executeRaw<{ fingerprint: string; value: { kind: string; deletion: string | null } }>(
      'SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op=$1', [SYNC_ORIGIN_DELETED_OP]);
    expect(markers.map(row => ({ path: row.fingerprint.split(':').pop(), kind: row.value.kind, deletion: row.value.deletion }))).toEqual([{ path: 'notes/c.md', kind: 'legacy', deletion }]);
    expect(await classOf(engine, 'notes/c.md')).toMatchObject({ cls: 'legacy_same', settled: true });
  }, { setup }), 180_000);

  test('b1: the legacy markers stay owed after a first pass that wrote none; a prior pass row alone does not skip them', () => managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const deletion = await deletePage(engine, ctx, 'notes/c');
    await raw(engine, () => engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug IN ('notes/b','notes/c')"));
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [SYNC_ORIGIN_DELETED_OP]);
    // The row an incarnation's first pass leaves when it fails before its first round wrote the markers: no converged
    // state and no marker stamp, beside the baseline it pinned.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array(jsonb_set(jsonb_set(
        (completed_keys->0) #- '{obligations,converged}' #- '{obligations,legacy_markers_at}',
        '{obligations,baseline_commit}', to_jsonb((SELECT last_commit FROM sources WHERE id='default'))),
        '{telemetry,outcome}', '"failed"'::jsonb)) WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);

    expect((await performManagedSync(engine, OPTS)).status).not.toBe('blocked_by_failures');
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b']);
    const markers = await engine.executeRaw<{ fingerprint: string; value: { kind: string; deletion: string | null } }>(
      'SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op=$1', [SYNC_ORIGIN_DELETED_OP]);
    expect(markers.map(row => ({ path: row.fingerprint.split(':').pop(), kind: row.value.kind, deletion: row.value.deletion }))).toEqual([{ path: 'notes/c.md', kind: 'legacy', deletion }]);
    const [row] = await engine.executeRaw<{ at: string | null }>("SELECT completed_keys->0->'obligations'->>'legacy_markers_at' AS at FROM op_checkpoints WHERE op=$1", [MANAGED_SYNC_PASS_OP]);
    expect(row?.at).toBeString();
  }, { setup }), 180_000);

  test('b4/b6: the receipt counts dirty paths by their own action and the source\'s legacy twin pairs', () => managedBrain(async ({ engine, root }) => {
    writeFileSync(join(root, 'notes/Foo Bar.md'), note('Foo Bar', 'A synthetic observation about Foo Bar.')); commit(root, 'twin file');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // #6885: an older gbrain left a legacy page with no recorded origin at the unfolded slug, beside sync's twin.
    await raw(engine, () => engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
      SELECT source_id, 'notes/foo bar', type, title, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE source_id='default' AND slug='notes/foo-bar'`));
    // notes/a: a committed change whose working copy is back at the synced bytes (dirty, absorbed: settled, none);
    // notes/b: a committed change under a different uncommitted one (dirty, not absorbed: repair).
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.'));
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'A committed change of notes/b.'));
    commit(root, 'changes');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'The committed body of notes/a.'));
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'An uncommitted edit of notes/b.'));

    const receipt = await shadowConvergence(engine, { sourceId: 'default' });
    expect(receipt!.classes.dirty).toEqual({ count: 2, action: 'repair', by_action: { none: 1, repair: 1 } });
    expect(Object.fromEntries((receipt!.samples.dirty ?? []).map(sample => [sample.path, sample.action]))).toEqual({ 'notes/a.md': 'none', 'notes/b.md': 'repair' });
    expect(receipt!.legacy_twin_pairs).toBe(1);
  }, { setup }), 180_000);

  test('finding (a): a put_page queued with write-through off makes the changed file in_flight', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
    await disposePersistenceConsumer(engine);
    const current = await engine.readPageSnapshot('notes/a', { sourceId: 'default' });
    const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug: 'notes/a', request_id: randomUUID(), expected_revision: current!.revision,
      content: note('notes/a', 'A queued agent edit.') } });
    const row = await admitWrite(engine, prepared.admission!);
    expect({ state: row.state, worktree: row.worktree_id ?? null }).toEqual({ state: 'queued', worktree: null });
    expect(await classOf(engine, 'notes/a.md')).toMatchObject({ cls: 'import', settled: false, inFlight: true });
  }, { setup }), 180_000);

  test('finding (a): in working mode a committed git rm of a synced file is a delete, not an import of unreadable bytes', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'rm', '-q', 'notes/b.md'); commit(root, 'remove b');
    const level = await readShadowLevel(engine, { sourceId: 'default', workingTree: true });
    expect(level!.paths.find(entry => entry.path === 'notes/b.md')?.result).toMatchObject({ cls: 'delete', action: 'delete' });
  }, { setup }), 180_000);

  for (const full of [false, true]) test(`handover: the first pass retires an unfinished legacy cursor and inherits its options${full ? ' (a --full cursor seeds a full episode)' : ''}`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const incarnation = (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'"))[0]!.incarnation;
    // What a pre-PR 4b `gbrain sync --no-embed --no-extract${full ? ' --full' : ''}` left behind when it stopped part way.
    await engine.executeRaw(`INSERT INTO op_checkpoints(op, fingerprint, completed_keys, updated_at) VALUES ('managed-sync', $1, jsonb_build_array($2::jsonb), now())
      ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
      [managedCursorKey(incarnation, undefined), JSON.stringify({ sourceId: 'default', incarnation, runId: randomUUID(), index: 1, total: 3, done: false,
        processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: false }, syncOptions: full ? { full: true } : {} })]);
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
    // An episode admits a current page without a reparse (sync-classify.ts `inPlace`); b and c carry a stale contextual
    // mode, which only an open episode re-imports, so a seeded episode shows as their re-import.
    await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode=NULL WHERE source_id='default' AND slug IN ('notes/b','notes/c')");
    const result = await performManagedSync(engine, { sourceId: 'default', noPull: true });
    expect(result.status).toBe('synced');
    expect([...result.inherited_options ?? []].sort()).toEqual(['noEmbed', 'noExtract']);
    expect({ modified: result.modified, candidates: result.pass?.candidates, waived: result.waived?.imports }).toEqual({ modified: 1, candidates: full ? 3 : 1, waived: full ? 2 : 0 });
    expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op IN ('managed-sync','managed-sync-manifest')")).toEqual([]);
  }, { setup }), 180_000);
});
