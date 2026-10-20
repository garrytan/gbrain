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
 * #6712 PR 4b: a non-company source keeps no cursor and its live pass publishes no cursor checkpoint, so the races, the
 * moved-checkpoint blocks, the slice records and the repair applies of a cursor run went with it. What stays here is
 * the classification of the refused receipts an older run left (page vs bookkeeping, supersession). A brain an older
 * binary left with a blocked cursor and its checkpoint failure converging on a plain sync is covered by
 * sync-pass-failure-retry-6712.test.ts; the orphan repair by repair-managed-sync-orphans.test.ts, and its checkpoint_moved
 * classification by persistence-sync-failures.serial.test.ts.
 * Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { stampByCheckpoint } from './helpers/pass-fold.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { classifyManagedSyncOrphans } from '../src/core/persistence/managed-sync-orphans.ts';
import { classifyTerminal, supersessionSql } from '../src/core/persistence/terminal-classify.ts';
import { readTerminalFailures, readTerminalFailureSummary } from '../src/core/persistence/terminal-failures.ts';
import { writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
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
  /** Stops the run after its page writes and before its checkpoint publishes. */
  async function beforeCheckpoint(engine: BrainEngine, f: Fixture, variant: 'entries' | 'zero') {
    const abort = new AbortController();
    // A folded stamp has no window between the last import and the checkpoint (#6926): this run stamps by its request.
    const partial = await outcome(stampByCheckpoint(() => performManagedSync(engine, { ...f.opts, signal: abort.signal, onProgress: p => { if (variant === 'zero' || p.bankedFiles === 1) abort.abort(); } })));
    expect(partial.status).toBe('partial');
  }
  const superseded = async (engine: BrainEngine, id: string) => (await engine.executeRaw(
    `SELECT 1 FROM persistence_requests r WHERE r.id=$1::uuid AND EXISTS(SELECT 1 FROM persistence_requests c WHERE ${supersessionSql('r', 'c')})`, [id])).length > 0;

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
