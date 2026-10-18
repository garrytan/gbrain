/**
 * #6834: a managed-sync checkpoint refused because `sources.last_commit` moved under its cursor.
 *
 * The checkpoint request names the bookkeeping slug `__managed_sync_checkpoint__`; its publication is a compare-and-swap
 * on `last_commit` (sync-prepare.ts `applyManagedSyncCheckpoint`). When another run of the source checkpointed first (an
 * older gbrain kept one cursor per writer and option set, so two cursors of one source raced to the same target), the
 * refusal was `revision_conflict` "The source checkpoint changed during this sync." against a page that does not exist,
 * every plain sync resumed the same cursor into the same refusal, and no repair listed it.
 *
 * Protects:
 *   - the source already stands at the run's target: the next plain sync finishes the run (a checkpoint marked overtaken),
 *     both for a fresh race and for a brain that already carries the refused receipt and failure row;
 *   - the source moved anywhere else: the plain sync stays blocked, but the receipt, doctor (sync_failures and
 *     sync_freshness) and the terminal-failure action name no page; `gbrain repair managed-sync-orphans` lists the cursor
 *     as `checkpoint_moved`, keeps it when the rule no longer holds at apply time, retires it otherwise, and the next
 *     plain sync discovers from the recorded commit;
 *   - ordinary page revision conflicts keep their diagnosis and action.
 * Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { drainManagedSync } from '../src/core/persistence/sync-drain.ts';
import { _setCursorBoundForTest } from '../src/core/persistence/sync-discovery.ts';
import { SYNC_SLICE_OP } from '../src/core/persistence/sync-slices.ts';
import { __setManagedCursorKeyForTests } from '../src/core/persistence/sync-cursor-key.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { classifyManagedSyncOrphans } from '../src/core/persistence/managed-sync-orphans.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { classifyTerminal, supersessionSql } from '../src/core/persistence/terminal-classify.ts';
import { readTerminalFailures, readTerminalFailureSummary } from '../src/core/persistence/terminal-failures.ts';
import { writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { managedSyncOrphansRepair } from '../src/core/repair/managed-sync-orphans.ts';
import { runRepair } from '../src/core/repair/core.ts';
import { repairSpec } from '../src/core/repair/registry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const MOVED = 'The source checkpoint changed during this sync.';
const home = mkdtempSync(join(tmpdir(), 'gbrain-checkpoint-moved-6834-'));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo: string, message: string) => { git(repo, 'add', '-A'); git(repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD'); };
const note = (title: string, body = 'A synthetic observation') => `---\ntitle: ${title}\n---\n${body} about ${title}.\n`;
type Outcome = Record<string, any>;
const outcome = (run: Promise<unknown>): Promise<Outcome> => run.then(value => value as Outcome, error => ({ thrown: error as { code?: string; message?: string } }));

describe('#6834 a managed-sync checkpoint whose source checkpoint moved', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
    await closePostgres?.(); rmSync(home, { recursive: true, force: true });
  });
  const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined,
    OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined }, async () => { for (const engine of engines) await fn(engine); });

  /** A subdirectory source (`brain/`) synced once, then one more commit: `entries` edits a page, `zero` edits only a file outside the source. */
  async function fixture(engine: BrainEngine, variant: 'entries' | 'zero') {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const id = `moved-${randomUUID().slice(0, 12)}`, repo = join(home, id), root = join(repo, 'brain');
    mkdirSync(root, { recursive: true }); git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), 'Repository text outside the source.\n');
    for (const name of ['alpha', 'beta']) { const file = join(root, 'notes', `${name}.md`); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, note(name)); }
    const seed = commit(repo, 'seed');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    expect((await outcome(performManagedSync(engine, opts))).status).toBe('first_sync');
    writeFileSync(join(repo, 'SIDE.md'), 'A side commit outside the source.\n');
    const side = commit(repo, 'side');
    if (variant === 'entries') writeFileSync(join(root, 'notes', 'alpha.md'), note('alpha', 'A revised observation'));
    else writeFileSync(join(repo, 'README.md'), 'Repository text outside the source, revised.\n');
    const target = commit(repo, 'next');
    return { id, repo, root, seed, side, target, opts };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** Runs `fn` as an older gbrain whose cursor key for the source is `key`. */
  async function legacy<T>(key: string, fn: () => Promise<T>): Promise<T> {
    __setManagedCursorKeyForTests(() => key);
    try { return await fn(); } finally { __setManagedCursorKeyForTests(null); }
  }
  /** Stops the run after its page writes and before its checkpoint publishes. */
  async function beforeCheckpoint(engine: BrainEngine, f: Fixture, variant: 'entries' | 'zero') {
    const abort = new AbortController();
    const partial = await outcome(performManagedSync(engine, { ...f.opts, signal: abort.signal, onProgress: p => { if (variant === 'zero' || p.bankedFiles === 1) abort.abort(); } }));
    expect(partial.status).toBe('partial');
  }
  /** The checkpoint column only the owner publishes; another writer moving it is simulated with managed persistence off. */
  async function moveCheckpoint(engine: BrainEngine, f: Fixture, commitId: string) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try { await engine.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.id, commitId]); }
    finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  }
  const lastCommit = async (engine: BrainEngine, f: Fixture) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0]!.last_commit;
  const checkpoints = async (engine: BrainEngine, f: Fixture) => engine.executeRaw<{ id: string; request_id: string; slug: string; operation: string; state: string; error_code: string | null; error_message: string | null; error_detail: object | null }>(
    `SELECT id::text AS id, request_id::text AS request_id, slug, operation, state, error_code, error_message, error_detail FROM persistence_requests
      WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint' ORDER BY sequence`, [f.id]);
  const unfinished = (engine: BrainEngine, f: Fixture) => (engine.executeRaw<{ n: number | string }>(
    "SELECT count(*) AS n FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND COALESCE(completed_keys->0->>'done','false')<>'true'", [f.id]).then(rows => Number(rows[0]!.n)));
  const superseded = async (engine: BrainEngine, id: string) => (await engine.executeRaw(
    `SELECT 1 FROM persistence_requests r WHERE r.id=$1::uuid AND EXISTS(SELECT 1 FROM persistence_requests c WHERE ${supersessionSql('r', 'c')})`, [id])).length > 0;
  const ctx = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false } as unknown as OperationContext);
  const repair = (engine: BrainEngine, f: Fixture, expectHash?: string) => runRepair(ctx(engine), managedSyncOrphansRepair, { brain_id: 'host', source_ids: [f.id] },
    { apply: !!expectHash, explicit: true, ...(expectHash ? { expect: expectHash } : {}), spec: repairSpec('managed-sync-orphans') });

  for (const variant of ['entries', 'zero'] as const) {
    test(`two older-key cursors race to one target (${variant}): the losing checkpoint finishes instead of blocking`, () => each(async engine => {
      const f = await fixture(engine, variant);
      const loser = `older-loser-${f.id}`, winner = `older-winner-${f.id}`;
      await legacy(loser, () => beforeCheckpoint(engine, f, variant));
      // The winner never saw the loser's cursor (an older gbrain keyed it apart): it is parked while the winner runs.
      await engine.executeRaw("UPDATE op_checkpoints SET op='managed-sync-parked' WHERE op='managed-sync' AND fingerprint=$1", [loser]);
      expect((await legacy(winner, () => outcome(performManagedSync(engine, f.opts)))).status).toBe('synced');
      await engine.executeRaw("UPDATE op_checkpoints SET op='managed-sync' WHERE op='managed-sync-parked' AND fingerprint=$1", [loser]);
      expect(await lastCommit(engine, f)).toBe(f.target);
      // The loser resumes: its checkpoint is refused (last_commit moved), and the same run revives it as overtaken.
      const resumed = await legacy(loser, () => outcome(performManagedSync(engine, f.opts)));
      expect(resumed.status).toBe('synced');
      const rows = await checkpoints(engine, f);
      expect(rows.filter(row => row.state !== 'committed').map(row => [row.state, row.error_code, row.error_message])).toEqual([['conflict', 'revision_conflict', MOVED]]);
      expect(rows.at(-1)!.state).toBe('committed');
      expect(await lastCommit(engine, f)).toBe(f.target);
      expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
      // The refused receipt is history: a later committed checkpoint of the source supersedes it.
      expect(await superseded(engine, rows.find(row => row.state === 'conflict')!.id)).toBe(true);
      expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('up_to_date');
      expect(await unfinished(engine, f)).toBe(0);
    }), 180_000);
  }

  test('a brain that already carries the refused checkpoint and its failure row, with the source now at the target, finishes on a plain sync', () => each(async engine => {
    const f = await fixture(engine, 'entries');
    await beforeCheckpoint(engine, f, 'entries');
    // An older release recorded the refusal: the checkpoint moved elsewhere first, so its run blocked and wrote the failure row.
    await moveCheckpoint(engine, f, f.side);
    const blocked = await outcome(performManagedSync(engine, f.opts));
    expect(blocked).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'revision_conflict', count: 1 }] });
    expect((await readManagedSyncFailures(engine, [f.id])).map(row => [row.code, row.phase])).toEqual([['revision_conflict', 'checkpoint']]);
    // Another run then checkpointed this run's target.
    await moveCheckpoint(engine, f, f.target);
    expect((await classifyManagedSyncOrphans(engine, [f.id])).orphans).toEqual([]);
    const finished = await outcome(performManagedSync(engine, f.opts));
    expect(finished.status).toBe('synced');
    expect(await lastCommit(engine, f)).toBe(f.target);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect(await unfinished(engine, f)).toBe(0);
    expect((await readSyncStatus(engine, f.id)).last_error).toBeNull();
  }), 180_000);

  test('a checkpoint moved elsewhere names no page, is listed as checkpoint_moved, and retiring it lets a plain sync converge', () => each(async engine => {
    const f = await fixture(engine, 'entries');
    await beforeCheckpoint(engine, f, 'entries');
    await moveCheckpoint(engine, f, f.side);
    for (let attempt = 0; attempt < 2; attempt++) {
      const blocked = await outcome(performManagedSync(engine, f.opts));
      expect(blocked).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'revision_conflict', count: 1 }] });
      expect(blocked.managedWrite).toMatchObject({ slug: '__managed_sync_checkpoint__', reason: 'sync_checkpoint_moved' });
      expect(blocked.managedWrite.suggestion).toContain('gbrain repair managed-sync-orphans --source <source>');
      expect(blocked.managedWrite.suggestion).not.toContain('Read the current page');
    }
    // The terminal-failure action reads sync status, never gbrain get on the bookkeeping slug.
    const refused = (await checkpoints(engine, f)).filter(row => row.state === 'conflict');
    expect(refused.length).toBeGreaterThan(0);
    for (const row of refused) {
      const verdict = classifyTerminal({ ...row, source_id: f.id, recovery: null, blocked_reason: null, compacted: false, intent_kind: 'managed_sync_checkpoint' })!;
      expect(verdict.action.argv).toEqual(['gbrain', 'sync', 'status', '--source', f.id, '--json']);
      expect(verdict.class).toBe('systemic');
    }
    const classified = await classifyManagedSyncOrphans(engine, [f.id]);
    expect(classified.orphans.map(orphan => [orphan.kind, orphan.reason])).toEqual([['unfinished_cursor', 'checkpoint_moved']]);
    expect(classified.retained).toEqual([]);
    // Doctor names the repair as its fix: sync_failures, and sync_freshness once the source is stale.
    const failures = (await checkSyncFailures(engine, { remote: false, sourceIds: [f.id] }))!;
    expect(failures.message).toContain('checkpoint_moved');
    expect((failures.fix as { argv: string[] }).argv).toEqual(['gbrain', 'repair', 'managed-sync-orphans', '--source', f.id]);
    const freshness = await checkSyncFreshness(engine, { localOnly: true, nowMs: Date.now() + 5 * 24 * 3600_000 });
    expect(freshness.status).toBe('fail');
    expect((freshness.fix as { argv: string[] }).argv).toEqual(['gbrain', 'repair', 'managed-sync-orphans', '--source', f.id]);
    expect(freshness.message).toContain(`gbrain repair managed-sync-orphans --source ${f.id}`);

    // Preview-first: the apply retires exactly the previewed cursor while its rule still holds.
    const preview = await repair(engine, f);
    expect(preview.affected).toBe(1);
    expect(await unfinished(engine, f)).toBe(1);
    const applied = await repair(engine, f, preview.preview_hash);
    expect(applied.applied).toBe(1);
    expect(await unfinished(engine, f)).toBe(0);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect(await lastCommit(engine, f)).toBe(f.side);
    // The next plain sync discovers from the commit the source records and checkpoints HEAD.
    const converged = await outcome(performManagedSync(engine, f.opts));
    expect(converged.status).toBe('synced');
    expect(await lastCommit(engine, f)).toBe(f.target);
    expect((await engine.getPage('notes/alpha', { sourceId: f.id }))?.compiled_truth).toContain('A revised observation');
    for (const row of refused) expect(await superseded(engine, row.id)).toBe(true);
    expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('up_to_date');
  }), 180_000);

  test('the apply keeps a previewed cursor whose source has since reached its target, and the plain sync finishes it', () => each(async engine => {
    const f = await fixture(engine, 'zero');
    await beforeCheckpoint(engine, f, 'zero');
    await moveCheckpoint(engine, f, f.side);
    expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('blocked_by_failures');
    const preview = await repair(engine, f);
    expect(preview.affected).toBe(1);
    await moveCheckpoint(engine, f, f.target);
    const applied = await repair(engine, f, preview.preview_hash);
    expect(applied.applied).toBe(0);
    expect(await unfinished(engine, f)).toBe(1);
    expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('synced');
    expect(await unfinished(engine, f)).toBe(0);
  }), 180_000);

  test.each([['the run\'s own target'], ['a newer commit']] as const)('a path slice short of its target whose checkpoint moved to %s is listed, no sync rediscovers it, and retiring it clears its slice record', moved => each(async engine => {
    _setCursorBoundForTest();
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const id = `sliced-${randomUUID().slice(0, 12)}`, root = join(home, id);
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const name of names) writeFileSync(join(root, 'notes', `${name}.md`), note(name));
    const target = commit(root, 'seven at once');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const f = { id, repo: root, root, seed: target, side: target, target, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
    const slices = async () => Number((await engine.executeRaw<{ n: string }>("SELECT COUNT(*)::text AS n FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2", [SYNC_SLICE_OP, `${id}:%`]))[0]!.n);
    try {
      _setCursorBoundForTest({ entries: 3, bytes: 1024 ** 2 });
      expect((await drainManagedSync(engine, f.opts, false)).staged?.slice).toMatchObject({ phase: 'import', after: 'notes/c.md' });
      expect(await slices()).toBe(1);
      // The second slice commits its pages and stops before its checkpoint.
      const abort = new AbortController();
      expect((await outcome(performManagedSync(engine, { ...f.opts, signal: abort.signal, onProgress: p => { if (p.total && p.bankedFiles === p.total) abort.abort(); } }))).status).toBe('partial');
      writeFileSync(join(root, 'notes', 'x.md'), note('x'));
      const newer = commit(root, 'one more');
      await moveCheckpoint(engine, f, moved === 'a newer commit' ? newer : target);
      expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('blocked_by_failures');
      expect((await classifyManagedSyncOrphans(engine, [id])).orphans.map(orphan => orphan.reason)).toEqual(['checkpoint_moved']);
      // #6712 PR 3 (L7): neither a plain sync nor its --retry-failed alias rediscovers it. Rediscovering would resume the slice
      // record and finish at the slice's target, moving last_commit back from a newer commit; the repair clears the record.
      _setCursorBoundForTest();
      for (const retryFailed of [false, true]) {
        expect((await outcome(performManagedSync(engine, { ...f.opts, retryFailed }))).status).toBe('blocked_by_failures');
        expect(await lastCommit(engine, f)).toBe(moved === 'a newer commit' ? newer : target);
        expect(await slices()).toBe(1);
      }
      const preview = await repair(engine, f);
      expect((await repair(engine, f, preview.preview_hash)).applied).toBe(1);
      expect(await slices()).toBe(0);
      _setCursorBoundForTest();
      const next = await outcome(performManagedSync(engine, f.opts));
      expect(next.status).not.toBe('blocked_by_failures');
      expect(next.deleted ?? 0).toBe(0);
      // The source never moves back to the slice's target, and nothing the newer commit has is deleted.
      expect(await lastCommit(engine, f)).toBe(newer);
    } finally { _setCursorBoundForTest(); }
  }), 180_000);

  test('an apply keeps a cursor whose run replaced the previewed one under the same key', () => each(async engine => {
    const f = await fixture(engine, 'entries');
    await beforeCheckpoint(engine, f, 'entries');
    await moveCheckpoint(engine, f, f.side);
    expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('blocked_by_failures');
    const preview = await repair(engine, f);
    const previewed = (await classifyManagedSyncOrphans(engine, [f.id])).orphans[0]!;
    // A run replaced under the same key (here: its manifest is lost, so the next sync re-discovers at HEAD; #6712 PR 3 took
    // that rediscovery away from --retry-failed); the replacement stops before its checkpoint, which moves too.
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [previewed.run_id]);
    writeFileSync(join(f.root, 'notes', 'beta.md'), note('beta', 'A revised observation'));
    const head = commit(f.repo, 'beta');
    const abort = new AbortController();
    expect((await outcome(performManagedSync(engine, { ...f.opts, signal: abort.signal, onProgress: p => { if (p.total && p.bankedFiles === p.total) abort.abort(); } }))).status).toBe('partial');
    await moveCheckpoint(engine, f, f.seed);
    expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('blocked_by_failures');
    const current = (await classifyManagedSyncOrphans(engine, [f.id])).orphans[0]!;
    expect(current.run_id).not.toBe(previewed.run_id);
    expect((await repair(engine, f, preview.preview_hash)).applied).toBe(0);
    expect(await unfinished(engine, f)).toBe(1);
    // A fresh preview binds to the replacement run and retires it.
    const again = await repair(engine, f);
    expect((await repair(engine, f, again.preview_hash)).applied).toBe(1);
    expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('synced');
    expect(await lastCommit(engine, f)).toBe(head);
  }), 180_000);

  test('ordinary page revision conflicts keep their diagnosis and action', () => each(async engine => {
    const page = writeFailureDiagnostic('revision_conflict', 'The page changed during sync preparation.');
    expect(page).toMatchObject({ reason: 'revision_conflict', suggestion: 'Read the current page and review the intended change before submitting a corrected write.' });
    expect(writeFailureDiagnostic('revision_conflict', MOVED).reason).toBe('sync_checkpoint_moved');
    expect(writeFailureDiagnostic('revision_conflict', 'Some extracted facts have not committed.').reason).toBe('facts_batch_incomplete');
    const base = { source_id: 'example-source', operation: 'submit_job', state: 'conflict', error_code: 'revision_conflict', recovery: null, blocked_reason: null, compacted: false, request_id: randomUUID() };
    expect(classifyTerminal({ ...base, slug: 'notes/alpha' })).toMatchObject({ category: 'caller_conflict', class: 'page',
      action: { argv: ['gbrain', 'get', '--source', 'example-source', '--', 'notes/alpha'] } });
    // A user page may carry a bookkeeping-like slug; only the bookkeeping request's own kind (or, compacted, its operation) is reclassified.
    for (const page of [{ operation: 'put_page', intent_kind: null }, { operation: 'submit_job', intent_kind: 'managed_sync_import' }]) {
      expect(classifyTerminal({ ...base, ...page, slug: '__managed_sync_checkpoint__' })).toMatchObject({ class: 'page',
        action: { argv: ['gbrain', 'get', '--source', 'example-source', '--', '__managed_sync_checkpoint__'] } });
    }
    const later = async (r: { operation: string }, c: { operation: string; kind: string | null }) => (await engine.executeRaw<{ hit: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM (VALUES ($4::uuid,'example-source','__managed_sync_checkpoint__',1::bigint,'d1',$1::text,'conflict'))
          r(id,source_id,slug,sequence,digest,operation,state),
        (VALUES ('example-source','__managed_sync_checkpoint__',2::bigint,'d2',$2::text,$3::text::jsonb,'committed')) c(source_id,slug,sequence,digest,operation,intent,state)
        WHERE ${supersessionSql('r', 'c')}) AS hit`,
      [r.operation, c.operation, c.kind ? JSON.stringify({ kind: c.kind }) : null, randomUUID()]))[0]!.hit;
    expect(await later({ operation: 'submit_job' }, { operation: 'submit_job', kind: 'managed_sync_checkpoint' })).toBe(true);
    expect(await later({ operation: 'submit_job' }, { operation: 'submit_job', kind: null })).toBe(true);
    expect(await later({ operation: 'remember' }, { operation: 'submit_job', kind: 'managed_sync_checkpoint' })).toBe(false);
    expect(await later({ operation: 'submit_job' }, { operation: 'submit_job', kind: 'managed_sync_import' })).toBe(false);
    expect(classifyTerminal({ ...base, slug: '__managed_facts_complete__', operation: 'extract_facts' })).toMatchObject({ class: 'systemic', safe_actions: ['none'],
      action: { argv: ['gbrain', 'write-request', base.request_id, '--json'] } });
    // An unfinished run whose checkpoint has not published is the run's to finish, never an orphan.
    const f = await fixture(engine, 'entries');
    await beforeCheckpoint(engine, f, 'entries');
    expect((await classifyManagedSyncOrphans(engine, [f.id])).orphans).toEqual([]);
    expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('synced');
  }), 180_000);

  test('a failed import of a page slugged __managed_sync_checkpoint__ stays a page failure after a later checkpoint commits', () => each(async engine => {
    const f = await fixture(engine, 'entries');
    const receipt = async (kind: string) => {
      const requestId = randomUUID();
      await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
          state,error_code,error_message,intent,completed_at,updated_at,admitter_version)
        VALUES('local_cli','fixture',$1::uuid,'submit_job',$2,(SELECT incarnation FROM sources WHERE id=$2),'__managed_sync_checkpoint__',$3,'{}'::jsonb,0,0,
          'conflict','revision_conflict',$4,$5::text::jsonb,now()-interval '1 hour',now()-interval '1 hour',$6)`,
        [requestId, f.id, randomUUID(), kind === 'managed_sync_checkpoint' ? MOVED : 'The page changed during sync preparation.', JSON.stringify({ kind }), '0.60.262.0']);
      return (await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]!;
    };
    const page = await receipt('managed_sync_import');
    const checkpoint = await receipt('managed_sync_checkpoint');
    expect((await outcome(performManagedSync(engine, f.opts))).status).toBe('synced');
    expect(await superseded(engine, checkpoint.id)).toBe(true);
    expect(await superseded(engine, page.id)).toBe(false);
    const listing = await readTerminalFailures(engine, { sourceId: f.id });
    expect(listing.status).toBe('ok');
    const rows = 'rows' in listing ? listing.rows ?? [] : [];
    expect(rows.filter(row => row.slug === '__managed_sync_checkpoint__')).toEqual([expect.objectContaining({ class: 'page', category: 'caller_conflict',
      fix: expect.objectContaining({ argv: ['gbrain', 'get', '--source', f.id, '--', '__managed_sync_checkpoint__'] }) })]);
    const summary = await readTerminalFailureSummary(engine, { sourceIds: [f.id] });
    expect(summary.status === 'ok' ? summary.sources.find(s => s.source_id === f.id)?.unresolved.rows : null).toBe(1);
  }), 180_000);
});
