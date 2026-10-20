/**
 * #6712 PR 4b lane B (design v3.2 §2.3 rows 6, 9, 13, 17, 19; §2.5; §2.6; §2.7; §3.1; §5; §6; §7; §9): what a live pass does
 * besides admitting one-sided imports and deletes, on a real PGLite managed brain.
 *
 * Protects:
 * - rows 6/9: a deletion that disagrees with the database is a `file_drift` hold with side `deleted` and its state
 *   (`file_gone`, `tombstone_edited`, `purged_differs` with the purged slug), and the rest of the source stamps; row 19's hold
 *   carries `side`;
 * - §3.1 / probe 35: a settle-mismatch streak of three passes becomes a `settle_mismatch` hold (needs_human, doctor fix)
 *   and the rest of the source stamps;
 * - row 13 / probe 38: arm 1 adopts by revision alone, so the record carries the revision before compaction can drop arm 1;
 * - §2.7 / property (k): the legacy sweep records equal legacy pages, and an edit to a swept page imports with no Decision;
 * - §2.6 / probe 34: a mass delete writes one withheld record, imports and the stamp proceed, status reads
 *   `deletes_withheld` from the live `convergence` block, and only the env valve applies the deletes;
 * - §2.5 / probes 43, 44: a marker survives a worktree-only removal in both mode orders and retires once the origin left
 *   both the commit and the disk, so a new file at the path imports;
 * - §6 / probe 50: a scoped `--full` closes its own episode by inclusion without moving `last_commit` and the printed
 *   plain sync finishes; a narrower episode closes at the configured selection without stamping `chunker_version`; a
 *   narrower takeover leaves an episode open; a configured pass closes a widened (hidden-files) episode and releases them;
 * - §7 / probe 32: a group's reservation commits with its admission and survives a kill; a lost pass row defers paid work;
 * - §5: a remote caller admits only one-sided work and ends `reconcile_host_required` with counts and the owner-host fix.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readSyncStatus, SYNC_STATUS_REASONS } from '../src/core/persistence/sync-status.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { MANAGED_SYNC_PASS_OP, SYNC_DELETES_WITHHELD_OP } from '../src/core/persistence/sync-pass-row.ts';
import { assertPassAdmission } from '../src/core/persistence/sync-pass-batch.ts';
import { passCostDecision, readReservedUsd, registerPassCost, unregisterPassCost } from '../src/core/persistence/sync-pass-episode.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { managedSyncResumeArgs } from '../src/core/sync-reconcile.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setupNotes = (names: string[]) => ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of names) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`, `The committed body of notes/${name}.`));
  commit(root, 'notes');
};

async function waitCommitted(engine: BrainEngine, requestId: string) {
  await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
    { timeoutMs: 20_000, label: `request ${requestId} commits` });
}
async function dbEdit(engine: BrainEngine, ctx: OperationContext, slug: string, body: string) {
  const requestId = randomUUID();
  const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: current!.revision, content: note(slug, body) } });
  await waitCommitted(engine, requestId);
}
async function deletePage(engine: BrainEngine, ctx: OperationContext, slug: string, purge = false) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  const outcome = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, request_id: randomUUID(), expected_revision: snapshot!.revision, ...(purge ? { purge: true } : {}) }, waitMs: 30_000 });
  expect(outcome.state).toBe('committed');
}
async function holds(engine: BrainEngine) {
  const rows = await engine.executeRaw<{ fingerprint: string; record: { code: string; slug: string | null; meta: Record<string, unknown> } }>(
    "SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint");
  return Object.fromEntries(rows.map(row => [row.fingerprint.split(':').slice(2).join(':'), row.record]));
}
const passRow = async (engine: BrainEngine) => (await engine.executeRaw<{ value: any }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1', [MANAGED_SYNC_PASS_OP]))[0]?.value ?? null;
async function patchObligations(engine: BrainEngine, path: string[], value: unknown) {
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array(jsonb_set(completed_keys->0, $2::text[], $3::text::jsonb, true)) WHERE op=$1`,
    [MANAGED_SYNC_PASS_OP, ['obligations', ...path], JSON.stringify(value)]);
}
const source = async (engine: BrainEngine) => (await engine.executeRaw<{ last_commit: string | null; chunker_version: string | null; incarnation: string }>(
  "SELECT last_commit, chunker_version, incarnation::text AS incarnation FROM sources WHERE id='default'"))[0]!;
const liveSlugs = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
async function classOf(engine: BrainEngine, path: string, workingTree?: boolean) {
  const level = (await readShadowLevel(engine, { sourceId: 'default', ...(workingTree === undefined ? {} : { workingTree }) }))!;
  return level.paths.find(entry => entry.path === path)?.result ?? null;
}
async function record(engine: BrainEngine, slug: string) {
  const [row] = await engine.executeRaw<{ record: Record<string, unknown> | null }>(`SELECT c.completed_keys->0 AS record FROM pages p
    LEFT JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint='default:'||(SELECT incarnation::text FROM sources WHERE id='default')||':'||p.id::text WHERE p.source_id='default' AND p.slug=$2`, [SYNC_IMPORT_PROVENANCE_OP, slug]);
  return row?.record ?? null;
}
/** Rows as an older gbrain left them: managed persistence off around the write. */
async function raw<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

describe('#6712 PR 4b lane B: holds with side and state (rows 6, 9, 19)', () => {
  test('a gone file the database moved is held file_gone; a tombstone the file edited is held tombstone_edited; a purged page whose file differs is held purged_differs with its slug; the rest stamps', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await dbEdit(engine, ctx, 'notes/a', 'A database-only edit of notes/a.');
    await dbEdit(engine, ctx, 'notes/e', 'A database-only edit of notes/e.');
    await deletePage(engine, ctx, 'notes/b');
    await deletePage(engine, ctx, 'notes/c');
    await deletePage(engine, ctx, 'notes/c', true);
    rmSync(join(root, 'notes/a.md'));
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'An edit of notes/b after its page was deleted.'));
    writeFileSync(join(root, 'notes/c.md'), note('notes/c', 'An edit of notes/c after its page was purged.'));
    writeFileSync(join(root, 'notes/e.md'), note('notes/e', 'A file edit of notes/e.'));
    writeFileSync(join(root, 'notes/d.md'), note('notes/d', 'A one-sided edit of notes/d.'));
    commit(root, 'edits');
    const head = git(root, 'rev-parse', 'HEAD');

    const result = await performManagedSync(engine, OPTS);
    expect({ status: result.status, reason: result.reason ?? null }).toEqual({ status: 'synced', reason: null });
    expect((await source(engine)).last_commit).toBe(head);
    const held = await holds(engine);
    expect(held['notes/a.md']).toMatchObject({ code: 'file_drift', slug: 'notes/a', meta: { side: 'deleted', state: 'file_gone', deleted: true } });
    expect(held['notes/b.md']).toMatchObject({ code: 'file_drift', slug: 'notes/b', meta: { side: 'deleted', state: 'tombstone_edited' } });
    expect(held['notes/c.md']).toMatchObject({ code: 'file_drift', slug: 'notes/c', meta: { side: 'deleted', state: 'purged_differs' } });
    expect(held['notes/e.md']).toMatchObject({ code: 'file_drift', meta: { side: 'both' } });
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/d', 'notes/e']);
    expect((await engine.getPage('notes/d', { sourceId: 'default' }))?.compiled_truth).toContain('A one-sided edit of notes/d.');
    // Held at their level: the next tick has nothing to do.
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
  }, { setup: setupNotes(['a', 'b', 'c', 'd', 'e']) }), 180_000);
});

describe('#6712 PR 4b lane B: settle mismatch (§3.1, probe 35)', () => {
  test('a mismatch streak of three passes at one level becomes a settle_mismatch hold at L, and the rest of the source stamps', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.'));
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'A committed change of notes/b.'));
    commit(root, 'changes');
    const level = git(root, 'rev-parse', 'HEAD:notes/a.md');
    // Three earlier passes settled notes/a at this level and the next round never read it settled.
    await patchObligations(engine, ['mismatch'], { 'notes/a.md': { level, streak: 3 } });

    const result = await performManagedSync(engine, OPTS);
    expect(result.status).toBe('synced');
    expect((await source(engine)).last_commit).toBe(git(root, 'rev-parse', 'HEAD'));
    const held = (await holds(engine))['notes/a.md'];
    expect(held).toMatchObject({ code: 'settle_mismatch', meta: { blob_oid: level, mismatch_streak: 3 } });
    expect((await engine.getPage('notes/b', { sourceId: 'default' }))?.compiled_truth).toContain('A committed change of notes/b.');
    expect((await engine.getPage('notes/a', { sourceId: 'default' }))?.compiled_truth).toContain('The committed body of notes/a.');
    const status = await readSyncStatus(engine, 'default', { detail: false });
    const hold = status.holds.find(entry => entry.path === 'notes/a.md')!;
    expect(hold).toMatchObject({ code: 'settle_mismatch', needs_human: true });
    expect(hold.fix.argv).toEqual(['gbrain', 'doctor', '--json']);
    expect(hold.fix.then?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
    expect(hold.fix.then?.then?.argv).toEqual(['gbrain', 'sources', 'retry-held', 'default']);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
  }, { setup: setupNotes(['a', 'b']) }), 180_000);
});

describe('#6712 PR 4b lane B: adoption and the legacy sweep (row 13, §2.7)', () => {
  test('probe 38: a record without a revision adopts it by arm 1 on fileSame, so the record carries the revision before compaction', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const before = await record(engine, 'notes/a');
    // A record written before PR 0 recorded revisions (arm 1 still attests the page's revision).
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0) - 'revision') WHERE op=$1 AND completed_keys->0->>'origin'='notes/a.md'`, [SYNC_IMPORT_PROVENANCE_OP]);
    expect(await classOf(engine, 'notes/a.md')).toMatchObject({ cls: 'adopt', settled: true });
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'A committed change of notes/b.'));
    commit(root, 'change b');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    const after = await record(engine, 'notes/a');
    const revision = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!.revision;
    expect(after).toMatchObject({ revision, blob_oid: before!.blob_oid, parser: before!.parser });
    expect(await classOf(engine, 'notes/a.md')).toMatchObject({ cls: 'matched' });
  }, { setup: setupNotes(['a', 'b']) }), 180_000);

  test('property (k): the first full round sweeps equal legacy pages into records, and a later edit of a swept page imports with no Decision', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // Pages an older gbrain imported: the same rows with no import record and no sync request behind the revision.
    await raw(engine, async () => {
      const cols = 'source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path';
      const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT ${cols} FROM pages WHERE source_id='default'`);
      await engine.executeRaw("DELETE FROM pages WHERE source_id='default'");
      for (const row of rows) await engine.executeRaw(`INSERT INTO pages(${cols}) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [row.source_id, row.slug, row.type, row.title, row.compiled_truth, row.timeline, JSON.stringify(row.frontmatter), row.content_hash, row.source_path]);
    });
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op IN ($1,$2)', [SYNC_IMPORT_PROVENANCE_OP, MANAGED_SYNC_PASS_OP]);
    expect(await classOf(engine, 'notes/a.md')).toMatchObject({ cls: 'legacy_unverified', settled: true });
    expect((await performManagedSync(engine, OPTS)).status).not.toBe('blocked_by_failures');
    const row = await passRow(engine);
    expect(row.telemetry.counts).toMatchObject({ legacy_swept: 3, legacy_recorded: 3 });
    expect(row.obligations.legacy_sweep?.first_full_at).toBeString();
    expect(row.telemetry.summary.legacy_unverified).toBe(0);
    expect(await classOf(engine, 'notes/a.md')).toMatchObject({ cls: 'matched' });

    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'An edit of a swept legacy page.'));
    commit(root, 'edit');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await holds(engine)).toEqual({});
    expect((await engine.getPage('notes/a', { sourceId: 'default' }))?.compiled_truth).toContain('An edit of a swept legacy page.');
    // The bootstrap gate (design §2.7): Decisions per 10k pages after the sweep.
    const status = await readSyncStatus(engine, 'default', { detail: false });
    const conv = status.convergence as { decisions: Record<string, number>; legacy_unverified: number };
    expect(conv.decisions).toEqual({ both: 0, unknown: 0, deleted: 0 });
    expect(conv.legacy_unverified).toBe(0);
  }, { setup: setupNotes(['a', 'b', 'c']) }), 180_000);
});

describe('#6712 PR 4b lane B: the mass-delete valve and live status (§2.6, §9, probe 34)', () => {
  const names = Array.from({ length: 24 }, (_, i) => `n${String(i).padStart(2, '0')}`);
  test('a trip writes one withheld record, imports and the stamp proceed, status reads deletes_withheld live, and only the env valve applies the deletes', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const gone = names.slice(0, 14);
    for (const name of gone) rmSync(join(root, `notes/${name}.md`));
    writeFileSync(join(root, 'notes/n20.md'), note('notes/n20', 'A one-sided edit beside the mass delete.'));
    commit(root, 'mass delete');
    const head = git(root, 'rev-parse', 'HEAD');

    const result = await performManagedSync(engine, OPTS);
    expect(result.status).toBe('synced');
    expect((await source(engine)).last_commit).toBe(head);
    expect((await liveSlugs(engine)).length).toBe(24);
    expect((await engine.getPage('notes/n20', { sourceId: 'default' }))?.compiled_truth).toContain('A one-sided edit beside the mass delete.');
    expect(await holds(engine)).toEqual({});
    const withheld = await engine.executeRaw<{ value: { count: number; set_hash: string; samples: string[] } }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1', [SYNC_DELETES_WITHHELD_OP]);
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.value.count).toBe(14);
    const dry = (await (await import('../src/core/persistence/sync-pass.ts')).shadowConvergence(engine, { sourceId: 'default' }))!;
    expect(dry.deletes).toMatchObject({ verdict: 'withheld', count: 14, set_hash: withheld[0]!.value.set_hash });

    const status = await readSyncStatus(engine, 'default', { detail: false });
    expect({ state: status.state, reason: status.reason }).toEqual({ state: 'blocked', reason: 'deletes_withheld' });
    expect(status.convergence).toMatchObject({ dry_run: false, deletes_withheld: { count: 14, set_hash: withheld[0]!.value.set_hash }, classes: { deletes_withheld: { count: 14, action: 'repair' } } });
    expect(status.next?.argv).toEqual(['gbrain', 'sync', '--source', 'default', '--dry-run', '--json']);
    expect(status.resume_argv).toEqual(managedSyncResumeArgs({ sourceId: 'default' }));
    for (const reason of ['pass_unfinished', 'not_converged', 'settle_mismatch', 'deletes_withheld', 'selection_scoped', 'admission_paused']) expect(SYNC_STATUS_REASONS).toContain(reason as never);

    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => { expect((await performManagedSync(engine, OPTS)).status).toBe('synced'); });
    expect((await liveSlugs(engine)).length).toBe(10);
    expect(await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE op=$1', [SYNC_DELETES_WITHHELD_OP])).toHaveLength(0);
    expect((await readSyncStatus(engine, 'default', { detail: false })).reason).toBe('nothing_pending');
  }, { setup: setupNotes(names) }), 240_000);
});

describe('#6712 PR 4b lane B: marker retirement in full rounds (§2.5, probes 43, 44)', () => {
  for (const order of ['working-then-committed', 'committed-then-working'] as const) {
    test(`probe 43 (${order}): a worktree-only removal and a restore from the unchanged commit keep the marker; the file stays deleted_same`, () => managedBrain(async ({ engine, ctx, root }) => {
      await engine.setConfig('sync.write_through', 'false');
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await deletePage(engine, ctx, 'notes/a');
      await deletePage(engine, ctx, 'notes/a', true);
      const first = order === 'working-then-committed';
      rmSync(join(root, 'notes/a.md'));
      expect((await performManagedSync(engine, { ...OPTS, workingTree: first })).status).not.toBe('blocked_by_failures');
      git(root, 'checkout', '--', 'notes/a.md');
      expect((await performManagedSync(engine, { ...OPTS, workingTree: !first })).status).not.toBe('blocked_by_failures');
      expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='sync-origin-deleted'")).toHaveLength(1);
      expect(await classOf(engine, 'notes/a.md', false)).toMatchObject({ cls: 'deleted_same', settled: true });
      expect(await classOf(engine, 'notes/a.md', true)).toMatchObject({ cls: 'deleted_same', settled: true });
      expect(await liveSlugs(engine)).toEqual(['notes/b']);
    }, { setup: setupNotes(['a', 'b']) }), 180_000);
  }

  test('probe 44 tail: git rm, delete, purge, commit: the next full round retires the marker, and a new file at that path imports', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'rm', '-q', 'notes/a.md');
    await deletePage(engine, ctx, 'notes/a');
    await deletePage(engine, ctx, 'notes/a', true);
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='sync-origin-deleted'")).toHaveLength(1);
    commit(root, 'remove a');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='sync-origin-deleted'")).toHaveLength(0);
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A new file at a purged path.'));
    commit(root, 'new a');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b']);
    expect((await engine.getPage('notes/a', { sourceId: 'default' }))?.compiled_truth).toContain('A new file at a purged path.');
  }, { setup: setupNotes(['a', 'b']) }), 180_000);
});

describe('#6712 PR 4b lane B: episodes (§6, probe 50)', () => {
  const selection = (patch: Record<string, unknown> = {}) => ({ exclude: [], includeHidden: [], strategy: 'markdown', srcSubpath: null, mode: 'committed', ...patch });
  const episode = (patch: Record<string, unknown>) => ({ opened_at: new Date().toISOString(), full_id: randomUUID(), selection: selection(patch),
    inherited: { noEmbed: false, noExtract: false, noSchemaPack: false, from: 'legacy_cursor' } });

  test('a scoped --full closes its own episode by inclusion without moving last_commit; the printed plain sync then finishes', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const before = (await source(engine)).last_commit;
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.'));
    commit(root, 'change a');
    const scoped = await performManagedSync(engine, { ...OPTS, full: true, exclude: ['notes/c.md'] });
    expect({ status: scoped.status, reason: scoped.reason }).toEqual({ status: 'synced', reason: 'selection_scoped' });
    expect((await source(engine)).last_commit).toBe(before);
    expect((await passRow(engine)).obligations.episode).toBeUndefined();
    const status = await readSyncStatus(engine, 'default', { detail: false });
    expect({ state: status.state, reason: status.reason }).toEqual({ state: 'synced', reason: 'selection_scoped' });
    expect(status.resume_argv).toEqual(managedSyncResumeArgs({ sourceId: 'default' }));
    const resumed = await performManagedSync(engine, OPTS);
    expect(resumed.status).toBe('synced');
    expect((await source(engine)).last_commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect((await readSyncStatus(engine, 'default', { detail: false })).reason).toBe('nothing_pending');
  }, { setup: setupNotes(['a', 'b', 'c']) }), 180_000);

  test('a narrower (legacy-cursor) episode closes at the configured selection without stamping chunker_version', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.executeRaw("UPDATE sources SET chunker_version='older' WHERE id='default'");
    await patchObligations(engine, ['episode'], episode({ exclude: ['notes/c.md'] }));
    const result = await performManagedSync(engine, OPTS);
    expect(result.status).toBe('synced');
    expect((await passRow(engine)).obligations.episode).toBeUndefined();
    expect((await source(engine)).chunker_version).toBe('older');
  }, { setup: setupNotes(['a', 'b', 'c']) }), 180_000);

  test('a narrower takeover leaves an open configured episode open; a configured pass closes a widened (hidden-files) episode and releases those paths', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const open = episode({});
    await patchObligations(engine, ['episode'], open);
    expect((await performManagedSync(engine, { ...OPTS, exclude: ['notes/c.md'] })).status).toBe('synced');
    expect((await passRow(engine)).obligations.episode?.full_id).toBe(open.full_id);
    expect(((await readSyncStatus(engine, 'default', { detail: false })).convergence as { episode: { full_id: string; selection_fp: string } }).episode)
      .toMatchObject({ full_id: open.full_id, selection_fp: digest(open.selection) });

    mkdirSync(join(root, '.hidden'), { recursive: true });
    writeFileSync(join(root, '.hidden/h.md'), note('hidden/h', 'A hidden note.'));
    commit(root, 'hidden');
    await engine.executeRaw("UPDATE sources SET chunker_version='older' WHERE id='default'");
    await patchObligations(engine, ['episode'], episode({ includeHidden: ['.hidden/**'] }));
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    const row = await passRow(engine);
    expect(row.obligations.episode).toBeUndefined();
    expect(row.telemetry.counts.episodeReleased).toBe(1);
    expect((await source(engine)).chunker_version).not.toBe('older');
  }, { setup: setupNotes(['a', 'b', 'c']) }), 180_000);
});

describe('#6712 PR 4b lane B: cost reservations (§7, probe 32)', () => {
  test('a group reservation commits with its admission and survives a kill; a replay adds nothing; a lost pass row defers paid work', () => managedBrain(async ({ engine }) => {
    await withEnv({ OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined }, async () => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const { incarnation } = await source(engine);
      const passId = randomUUID();
      registerPassCost(passId, { sourceId: 'default', incarnation, scope: passId, pricePerMTok: 0.02 });
      const intents = [{ passId, kind: 'managed_sync_import', path: 'notes/a.md', level: 'oid-a', content: 'x'.repeat(350_000), processingOptions: { noEmbed: false } }];
      // Killed after the admission transaction committed: the reservation stands.
      await engine.transaction(tx => assertPassAdmission(tx, intents));
      await expect(engine.transaction(async tx => { await assertPassAdmission(tx, intents); throw new Error('killed before settle'); })).rejects.toThrow('killed before settle');
      unregisterPassCost(passId);
      const reserved = await readReservedUsd(engine, 'default', incarnation, passId);
      expect(reserved.rows).toBe(1);
      expect(reserved.usd).toBeGreaterThan(0);

      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [MANAGED_SYNC_PASS_OP]);
      expect((await passCostDecision(engine, { sourceId: 'default', incarnation, scope: randomUUID(), priorRow: false, prior: undefined, approved: false })).defer).toBe('cost_unknown');
      const result = await performManagedSync(engine, { ...OPTS, noEmbed: false });
      expect(result.status).not.toBe('blocked_by_failures');
      const row = await passRow(engine);
      expect(row.obligations.cost).toMatchObject({ approved_usd: null });
      expect(row.telemetry.counts.costDeferred).toBe(1);
      expect(result.inherited_options ?? []).not.toContain('noEmbed');
      // The owner approves again (--yes): the envelope is known and paid work no longer defers.
      await performManagedSync(engine, { ...OPTS, noEmbed: true, costApproved: true });
      expect((await passRow(engine)).obligations.cost.approved_usd).toBeNumber();
    });
  }, { setup: setupNotes(['a', 'b']) }), 180_000);
});

describe('#6712 PR 4b lane B: remote callers (§5)', () => {
  async function remoteCtx(engine: BrainEngine): Promise<OperationContext> {
    const clientId = `sync-client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations) VALUES($1,'example-client','test-only','admin','default',ARRAY['submit_job'])`, [clientId]);
    return { engine, remote: true, sourceId: 'default', auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: 'default', allowedOperations: ['submit_job'] } } as unknown as OperationContext;
  }
  test('partial success: one-sided imports commit, drift stays unsettled with no hold, and the result is reconcile_host_required with the owner-host fix', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const before = (await source(engine)).last_commit;
    await dbEdit(engine, ctx, 'notes/a', 'A database-only edit of notes/a.');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A file edit of notes/a.'));
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'A one-sided edit of notes/b.'));
    commit(root, 'edits');
    const accepted = await prepareRemoteJob(await remoteCtx(engine), 'sync', { noPull: true });
    const result = await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, { ...accepted.data, noEmbed: true, noExtract: true }));
    expect({ status: result.status, reason: result.reason }).toEqual({ status: 'blocked_by_failures', reason: 'reconcile_host_required' });
    expect(result.reconcile).toMatchObject({ committed: 1, unsettled: { drift: 1 }, fix: { argv: ['gbrain', 'sync', '--source', 'default'], actor: 'user' } });
    expect(await holds(engine)).toEqual({});
    expect((await engine.getPage('notes/b', { sourceId: 'default' }))?.compiled_truth).toContain('A one-sided edit of notes/b.');
    expect((await engine.getPage('notes/a', { sourceId: 'default' }))?.compiled_truth).toContain('A database-only edit of notes/a.');
    expect((await source(engine)).last_commit).toBe(before);
  }, { setup: setupNotes(['a', 'b']) }), 180_000);

  test('no competing writer: a remote pass with nothing to settle still names the owner host, not another writer', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [MANAGED_SYNC_PASS_OP]);
    const accepted = await prepareRemoteJob(await remoteCtx(engine), 'sync', { noPull: true });
    const result = await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, { ...accepted.data, noEmbed: true, noExtract: true }));
    expect(result.reason).toBe('reconcile_host_required');
    expect(result.reconcile).toMatchObject({ committed: 0, unsettled: {} });
    expect(`${result.reconcile!.fix.why} ${result.reconcile!.fix.user_message}`).not.toMatch(/another (writer|sync)|competing/i);
  }, { setup: setupNotes(['a', 'b']) }), 180_000);
});
