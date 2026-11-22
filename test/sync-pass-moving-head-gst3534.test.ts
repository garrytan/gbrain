/**
 * GST-3534: a managed pass while other writers keep committing.
 *
 * Before: a writer committing during every round left each of the pass's four rounds a new commit to import, so the pass ended
 * `not_converged` every time, however little was left, even though it had absorbed an older commit completely.
 *
 * Protects:
 * - A pass whose last round finds HEAD moved past the newest round that drained reads that round's commit again; when every path
 *   of that read settles, it stamps that commit (`synced`, `last_commit` there) and records `stamped_behind` with the HEAD it saw,
 *   for an import-only writer and for one that edits the same note and deletes another every round. The next sync imports the rest
 *   and clears the marker. Rounds after the first patch the previous round's `I⋈P` (checked against a whole read by
 *   GBRAIN_SYNC_LEVEL_REUSE_VERIFY).
 * - No stamp behind HEAD when the drained round passed over a write (its file changed after admission) that the next commit then
 *   removed, while a write of the source is in flight on the last round (writer_pending), or when a round read the working tree (a
 *   HEAD detached mid-pass).
 * - The marker lives only in the checkpoint: a stop before the stamp's empty batch leaves `last_commit` and the marker unchanged.
 *   While it is set the next tick reads in full, never idle (a HEAD rewound to the stamped commit is read again, then idle), and
 *   under `sync.admission=classify_only` it is `admission_paused`, never up to date. Status reads it as `pass_unfinished` and the
 *   backlog as owing a pass.
 * - A pass that stops resumable (a slice's writer_yield) keeps its `I⋈P` for the next pass, whose first round patches it.
 * Real PGLite (and Postgres when DATABASE_URL is set), real managed syncs and real Git.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook, type FaultDetail, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { SYNC_ADMISSION_KEY } from '../src/core/persistence/sync-admission.ts';
import { passHealth, readPassRow } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { __resetTreeReuseForTests } from '../src/core/persistence/sync-tree-reuse.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SEEDED = 120;
type Round = { round: number; head: string; patched: boolean };
type Convergence = { kind: string; outcome: string; stop_reason: string | null; levels: { heads: number } | null; stamped_behind: { commit: string; head_seen: string } | null };

afterEach(() => { installFaultHook(undefined); __resetTreeReuseForTests(); });

for (const backend of testBackends()) describe(`[${backend}] GST-3534: a pass while HEAD keeps moving`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const open = databaseUrl ? () => isolatedPersistencePostgres(databaseUrl) : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (let i = 0; i < SEEDED; i++) writeFileSync(join(root, `notes/n${i}.md`), note(`n${i}`, `The body of n${i}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };
  const brain = (run: Parameters<typeof managedBrain>[0]) => withEnv({ GBRAIN_SYNC_LEVEL_REUSE_VERIFY: '1' }, () => managedBrain(run, { databaseUrl, ...(open ? { open } : {}), setup }));
  const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
  const write = (root: string, name: string) => { writeFileSync(join(root, `notes/${name}.md`), note(name, `The body of ${name}.`)); commit(root, `write ${name}`); };
  /** Round r's writer for the liveness case: the same note edited, and another note deleted, in one commit. */
  const churn = (root: string, r: number) => { writeFileSync(join(root, 'notes/n0.md'), note('n0', `Edit ${r}.`)); rmSync(join(root, `notes/n${r}.md`)); commit(root, `churn ${r}`); };
  /** A round's commit and whether its `I⋈P` read patched the previous one, from its `sync:level_read` detail. */
  const roundOf = (detail: FaultDetail): Round => ({ round: detail.round!, head: (detail.level!.shadow as { head: string }).head, patched: detail.level!.confirm?.taken === true });
  const slugs = async (engine: BrainEngine, like = 'notes/w%') => (await engine.executeRaw<{ slug: string }>(
    "SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL AND slug LIKE $1 ORDER BY slug", [like])).map(row => row.slug);
  const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ compiled_truth: string }>(
    "SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0]?.compiled_truth.trim() ?? null;
  const lastCommit = async (engine: BrainEngine) => (await engine.executeRaw<{ c: string }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c;
  const convergence = async (engine: BrainEngine) => (await readSyncStatus(engine, 'default')).convergence as Convergence;
  /**
   * One pass whose rounds 2-4 each start with `writer(r)` committing, then `also[r]`; `hook` sees every fault point. Returns the
   * pass, the rounds' level reads, the confirm reads and the HEAD after the writes.
   */
  const movingPass = async (engine: BrainEngine, root: string, writer: (r: number) => void, also: Record<number, () => unknown> = {},
    hook?: (point: FaultPoint, detail: FaultDetail, round: number) => void | Promise<void>) => {
    const seen: Round[] = [], confirms: boolean[] = [];
    let round = 0;
    installFaultHook(async (point, detail) => {
      if (point === 'sync:round_start') { round = detail.round!; if (round > 1) { writer(round); await also[round]?.(); } }
      if (point === 'sync:level_read' && detail.level) seen.push(roundOf(detail));
      if (point === 'sync:confirm_behind') confirms.push(detail.settled === true);
      await hook?.(point, detail, round);
    });
    try { return { pass: await performManagedSync(engine, OPTS), seen, confirms, head: git(root, 'rev-parse', 'HEAD') }; } finally { installFaultHook(undefined); }
  };
  const writes = (root: string) => { let n = 0; return () => write(root, `w${++n}`); };

  test('a writer committing during every round: the last round stamps the newest drained commit behind HEAD, and the next sync imports the rest', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    write(root, 'w0');
    const { pass, seen, confirms, head } = await movingPass(engine, root, writes(root));
    // Rounds 1-3 read and drained; round 4 found HEAD moved, read round 3's commit again and stamped it instead of reading HEAD.
    expect(seen.map(r => r.round)).toEqual([1, 2, 3]);
    expect(seen.map(r => r.patched)).toEqual([seen[0]!.patched, true, true]);
    expect(confirms).toEqual([true]);
    expect({ status: pass.status, reason: pass.reason ?? null, round: pass.pass?.round, toCommit: pass.toCommit }).toEqual({ status: 'synced', reason: null, round: 4, toCommit: seen[2]!.head });
    expect(await lastCommit(engine)).toBe(seen[2]!.head);
    expect(await slugs(engine)).toEqual(['notes/w0', 'notes/w1', 'notes/w2']);
    const status = await readSyncStatus(engine, 'default');
    expect({ state: status.state, reason: status.reason, outcome: (status.convergence as Convergence).outcome, stamped_behind: (status.convergence as Convergence).stamped_behind })
      .toEqual({ state: 'resumable', reason: 'pass_unfinished', outcome: 'synced', stamped_behind: { commit: seen[2]!.head, head_seen: head } });
    // The backlog owes a pass while the marker stands.
    expect(passHealth((await readPassRow(engine, 'default', (await getWorktreeBinding(engine, 'default'))!.source_incarnation))!, { stalledMs: Number.POSITIVE_INFINITY }).nothing_pending).toBe(false);
    const next = await performManagedSync(engine, OPTS);
    expect({ status: next.status, toCommit: next.toCommit }).toEqual({ status: 'synced', toCommit: head });
    expect(await slugs(engine)).toEqual(['notes/w0', 'notes/w1', 'notes/w2', 'notes/w3']);
    expect((await convergence(engine)).stamped_behind).toBeNull();
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
  }), 300_000);

  test('a writer editing the same note and deleting another every round: the pass still stamps the newest drained commit', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    churn(root, 1);
    const { pass, seen, confirms, head } = await movingPass(engine, root, r => churn(root, r));
    expect(confirms).toEqual([true]);
    expect({ status: pass.status, toCommit: pass.toCommit }).toEqual({ status: 'synced', toCommit: seen[2]!.head });
    expect((await convergence(engine)).stamped_behind).toEqual({ commit: seen[2]!.head, head_seen: head });
    // The stamped commit's state: round 3's edit, and the notes rounds 1-3 deleted are gone; round 4's deletion is the next pass's.
    expect(await body(engine, 'notes/n0')).toBe('Edit 3.');
    expect(await slugs(engine, 'notes/n_')).toEqual(['notes/n0', 'notes/n4', 'notes/n5', 'notes/n6', 'notes/n7', 'notes/n8', 'notes/n9']);
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await body(engine, 'notes/n0')).toBe('Edit 4.');
    expect(await slugs(engine, 'notes/n_')).toEqual(['notes/n0', 'notes/n5', 'notes/n6', 'notes/n7', 'notes/n8', 'notes/n9']);
    expect((await convergence(engine)).stamped_behind).toBeNull();
  }), 300_000);

  test('round 3 passed over a write (its file changed after admission) that round 4\'s commit removed: no stamp behind HEAD', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    write(root, 'w0');
    let edited = false;
    const { pass, seen, confirms } = await movingPass(engine, root, writes(root), { 4: () => { git(root, 'rm', '-q', 'notes/w2.md'); git(root, 'commit', '-qm', 'remove w2'); } }, (point, detail, round) => {
      if (point === 'sync:after_freeze' && round === 3 && detail.path === 'notes/w2.md' && !edited) { edited = true; writeFileSync(join(root, 'notes/w2.md'), note('w2', 'Edited after admission.')); }
    });
    expect(edited).toBe(true);
    // The confirm read found w2 unimported at round 3's commit, so the round read HEAD as before.
    expect(confirms).toEqual([false]);
    expect(seen.map(r => r.round)).toEqual([1, 2, 3, 4]);
    expect(pass.toCommit).not.toBe(seen[2]!.head);
    expect((await convergence(engine)).stamped_behind).toBeNull();
    await performManagedSync(engine, OPTS);
    expect(await lastCommit(engine)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(await slugs(engine)).toEqual(['notes/w0', 'notes/w1', 'notes/w3']);
  }), 300_000);

  test('a write in flight on the last round: writer_pending, no stamp behind HEAD', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    write(root, 'w0');
    const binding = (await getWorktreeBinding(engine, 'default'))!;
    const asProtocol2 = (sql: string, params: unknown[] = []) => engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
      await tx.executeRaw(sql, params);
    });
    const { pass, confirms } = await movingPass(engine, root, writes(root), { 4: () => asProtocol2(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,
      source_id,source_incarnation,slug,worktree_id,digest,intent,authority,intent_bytes,terminal_reservation,state) VALUES ('local_cli','fixture',gen_random_uuid(),'put_page',
      'default',$1::uuid,'notes/w3',$2::uuid,'d','{"kind":"put_page","sourcePath":"notes/w3.md"}'::jsonb,'{}'::jsonb,0,0,'queued')`, [binding.source_incarnation, binding.worktree_id]) });
    await asProtocol2("DELETE FROM persistence_requests WHERE principal_id='fixture'");
    expect(confirms).toEqual([]);
    expect({ status: pass.status, reason: pass.reason ?? null }).toEqual({ status: 'partial', reason: 'writer_pending' });
    expect((await convergence(engine)).stamped_behind).toBeNull();
  }), 300_000);

  test('a HEAD detached mid-pass reads the working tree: no stamp behind HEAD', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    write(root, 'w0');
    // Round 3 reads the working tree (HEAD detached, n5 edited) and imports the edit; round 4's commit is that edit, so a working
    // read of round 3's commit would match it and stamp uncommitted bytes as round 3's commit.
    const { confirms } = await movingPass(engine, root, r => (r === 4 ? git(root, 'commit', '-qam', 'commit the edit') : write(root, `w${r - 1}`)),
      { 3: () => { git(root, 'checkout', '-q', '--detach'); writeFileSync(join(root, 'notes/n5.md'), note('n5', 'An uncommitted edit.')); } });
    expect(confirms).not.toContain(true);
    expect((await convergence(engine)).stamped_behind).toBeNull();
  }), 300_000);

  test('a stop before the stamp\'s empty batch leaves last_commit and the marker unchanged; a rewind then reads the level again', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    churn(root, 1);
    const before = await lastCommit(engine);
    await expect(movingPass(engine, root, r => churn(root, r), {}, point => { if (point === 'sync:stamp_behind') throw new Error('stopped before the stamp batch'); }))
      .rejects.toThrow('stopped before the stamp batch');
    expect({ lastCommit: await lastCommit(engine), stamped_behind: (await convergence(engine)).stamped_behind }).toEqual({ lastCommit: before, stamped_behind: null });
    const stamped = git(root, 'rev-list', '--skip=1', '-n', '1', 'HEAD');
    git(root, 'reset', '-q', '--hard', stamped);
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect((await convergence(engine)).kind).not.toBe('idle');
    expect(await lastCommit(engine)).toBe(stamped);
    expect(await body(engine, 'notes/n0')).toBe('Edit 3.');
  }), 300_000);

  test('with the marker set, classify_only and a HEAD rewound to the stamped commit is admission_paused, never up to date', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    write(root, 'w0');
    const { pass, seen } = await movingPass(engine, root, writes(root));
    expect(pass.toCommit).toBe(seen[2]!.head);
    git(root, 'reset', '-q', '--hard', seen[2]!.head);
    await engine.setConfig(SYNC_ADMISSION_KEY, 'classify_only');
    const paused = await performManagedSync(engine, OPTS);
    expect({ status: paused.status, reason: paused.reason }).toEqual({ status: 'partial', reason: 'admission_paused' });
    expect((await convergence(engine)).stamped_behind?.commit).toBe(seen[2]!.head);
    await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect((await convergence(engine)).stamped_behind).toBeNull();
  }), 300_000);

  test('after a stamp behind HEAD, a HEAD rewound to the stamped commit is read in full, then the next tick is idle', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    write(root, 'w0');
    const { pass, seen } = await movingPass(engine, root, writes(root));
    expect({ status: pass.status, toCommit: pass.toCommit }).toEqual({ status: 'synced', toCommit: seen[2]!.head });
    git(root, 'reset', '-q', '--hard', seen[2]!.head);
    expect(readFileSync(join(root, 'notes/w2.md'), 'utf8')).toContain('w2');
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect((await convergence(engine)).kind).toBe('full');
    await performManagedSync(engine, OPTS);
    expect((await convergence(engine)).kind).toBe('idle');
  }), 300_000);

  test('a pass that stops resumable keeps its I⋈P: the next pass\'s first round patches it', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    for (const name of ['w0', 'w1', 'w2']) writeFileSync(join(root, `notes/${name}.md`), note(name, `The body of ${name}.`));
    commit(root, 'three notes');
    const sliced = await performManagedSync(engine, OPTS, { maxPages: 1, maxMs: 120_000 });
    expect({ status: sliced.status, reason: sliced.reason }).toEqual({ status: 'partial', reason: 'writer_yield' });
    const seen: Round[] = [];
    installFaultHook((point, detail) => { if (point === 'sync:level_read' && detail.level) seen.push(roundOf(detail)); });
    const next = await performManagedSync(engine, OPTS);
    expect(next.status).toBe('synced');
    expect(seen[0]).toMatchObject({ round: 1, patched: true });
    expect(await slugs(engine)).toEqual(['notes/w0', 'notes/w1', 'notes/w2']);
  }), 300_000);
});
