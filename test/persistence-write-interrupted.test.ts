/**
 * Flip lane C (4): a write whose statements the database keeps ending is failed after a bound, not prepared forever.
 *
 * 1. Protects: a statement the database ended while it stayed up (57014, a statement timeout or cancel of this write's
 *    own work) is charged to the request's transient budget (transient_interruptions; since large-pages hardening (b)
 *    it no longer spends preparation_attempts); past persistence.max_transient_retries the request ends
 *    `failed`/`write_interrupted` (the receipt names the interruptions, the retry limit and the SQLSTATE) instead of
 *    being released as `database_contention` and prepared again. A single interruption still re-prepares and commits.
 *    These cases set the retry limit low; test/pathological/lp-b-transient-retry-budget.test.ts pins the default (5)
 *    and the backoff. Contention with other transactions (55P03 lock timeout, 40P01
 *    deadlock) and a dropped connection or restarting database (CONNECTION_CLOSED, 57P01) are never counted, so a
 *    Postgres restart never fails a write.
 *    Both publication arms: a database-only page (released or failed in place) and a worktree-backed page (the
 *    recovery route restores the canonical file before the failure is recorded).
 * 2. Fails when: the transient branch of finishUnpublishedFailure / publishMutation's recovery route releases every
 *    interruption uncounted (master: a large segmented write cancelled by the publication's 5 s statement_timeout on a
 *    loaded host is prepared again, its whole body streamed again, without limit), or when contention or a connection loss is counted.
 * 3. Existing coverage: page-purge-journal-timeout-6511.test.ts bounds the purge's own lookups only;
 *    persistence-preparation-deadline tests bound preparation deadlines, never a publication's interruptions.
 *    A managed sync member that ends `write_interrupted` is a page-class hold, like `preparation_stalled` (SYNC_FAULT_TABLE):
 *    the run moves past it and the rest of the source lands; sync status lists the hold with the read-only
 *    `gbrain sources writer status` as its fix, and `gbrain sources retry-held` re-admits it.
 *    The charge is atomic with the claim's release or failure: a crash right after it (the
 *    `persistence:interruption_charged` seam) leaves no claim for the expired-owner sweep to charge again, so the one
 *    promised re-preparation survives. On the recovery route the charge commits before the request is marked
 *    recovering; a crash between them (the `persistence:recovery_interruption_charged` seam) leaves a running request
 *    that holds its recovery record, which neither expired-owner sweep takes (`recovery IS NULL`), so the owner's
 *    recovery pass finishes it with the one charge. A group's shared read (preparationReads) the database cancelled is no member's own
 *    statement: a bounded member never reads it as its own deadline, and it is charged once, to the first member that
 *    settles with it (the member that would have sent it alone), never to every member. A shared read the database
 *    cancels every time therefore ends bounded: each charged member reaches the limit and ends write_interrupted, and
 *    the last member, alone, takes the single path, where the same read is its own statement and is charged to it. write_interrupted is a write error code (a foreground receipt and a
 *    source lifecycle failure name it, never storage_error), and the sync breaker names the write_interrupted receipts
 *    it tripped on instead of reporting them as preparations that could not finish.
 * 4. Semantic injection: installFaultHook on the publication's before_commit seam (inside the publication transaction),
 *    throwing an error carrying the SQLSTATE, for every publication of the claims the test names. Counts claims, never
 *    time. Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { boundedReads, PreparationDeadlineError } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { preparationAbortReason } from '../src/core/persistence/coordinator.ts';
import { preparationReads } from '../src/core/persistence/group-publish.ts';
import { receiptClass, resumableStop } from '../src/core/persistence/sync-stop-class.ts';
import { classifyRecordedFault } from '../src/core/persistence/terminal-classify.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { importManagedFiles } from '../src/core/persistence/import-mutations.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { assertTopologyCommitted } from '../src/core/persistence/managed-sources.ts';
import { isWriteErrorCode } from '../src/core/persistence/types.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const interruption = (code: string) => Object.assign(new Error(code === '57014' ? 'canceling statement due to statement timeout' : `database interruption ${code}`), { code });
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;
const WRITER_STATUS = 'gbrain sources writer status';

test('write_interrupted is a page-class hold whose escalation names the read-only writer status', () => {
  expect(classifySyncFault({ code: 'write_interrupted' })).toEqual({ class: 'page', safe_actions: ['retry'], needs_human: false });
  expect(classifyRecordedFault({ source_id: 'notes', code: 'write_interrupted', slug: 'a' })).toMatchObject({ category: 'sync_fault', public_category: 'transient',
    class: 'page', safe_actions: ['retry'], needs_human: false, escalate: expect.stringContaining(WRITER_STATUS) });
  const receipt = { request_id: randomUUID(), source_id: 'notes', slug: 'a', operation: 'put_page', state: 'failed', error_code: 'write_interrupted',
    error_message: 'The database ended this write\'s statements 2 time(s).', error_detail: { origin: 'database_interruption', sqlstate: '57014', attempts: 2, limit: 2 },
    recovery: null, blocked_reason: null, compacted: false, publication_started: false, intent: { kind: 'managed_sync_import' } } as unknown as WriteRequest;
  expect(receiptClass(receipt)).toBe('page');
  expect(resumableStop(receipt)).toBe(false);
});

const STABLE_READ = 'SELECT local_path FROM sources WHERE id=$1';
/** Two group members' views of one shared read the database cancelled (57014), as preparationReads hands them out. */
async function sharedReadFailures(): Promise<unknown[]> {
  const engine = { kind: 'postgres', executeRaw: async () => { throw interruption('57014'); }, getConfig: async () => null } as unknown as BrainEngine;
  const shared = preparationReads(engine);
  const members = [startClaimPhase(Date.now(), new AbortController().signal, 10_000), startClaimPhase(Date.now(), new AbortController().signal, 10_000)];
  return Promise.all(members.map(clock => boundedReads(shared, clock).executeRaw(STABLE_READ, ['default']).then(() => null, (error: unknown) => error)));
}

test('a shared read the database cancelled is no member\'s own deadline: each member sees a transient database failure', async () => {
  const failures = await sharedReadFailures();
  expect(failures).toHaveLength(2);
  for (const failure of failures) {
    expect(failure).not.toBeInstanceOf(PreparationDeadlineError);
    expect(preparationAbortReason(failure)).toBeNull();
    expect((failure as { code?: string }).code).toBe('57014');
  }
});

test('write_interrupted is a write error code: a failed source lifecycle names it instead of storage_error', () => {
  expect(isWriteErrorCode('write_interrupted')).toBe(true);
  let thrown: unknown;
  try { assertTopologyCommitted({ state: 'failed', write_error: 'write_interrupted', request_id: randomUUID() }); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code: 'write_interrupted', writeError: 'write_interrupted', writeRequest: { state: 'failed' } });
});

type Row = { state: string; error_code: string | null; error_message: string | null; error_detail: Record<string, unknown> | null; preparation_attempts: number;
  transient_interruptions: number; has_recovery: boolean };

for (const backend of testBackends()) describe(`[${backend}] transient publication failures are bounded`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-write-interrupted-${backend}-`));
  let n = 0;
  const context = (sourceId = 'default'): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId });
  const call = (params: Record<string, unknown>, sourceId = 'default') => withEnv({ GBRAIN_HOME: home },
    () => op('put_page').handler(context(sourceId), { wait_ms: 20_000, ...params })) as Promise<Record<string, any>>;
  const row = async (requestId: string): Promise<Row> => (await engine.executeRaw<Row>(`SELECT state,error_code,error_message,error_detail,preparation_attempts,transient_interruptions,
    recovery IS NOT NULL AS has_recovery FROM persistence_requests WHERE request_id=$1::uuid`, [requestId]))[0]!;

  /**
   * Every publication of the request's claims numbered in `failing` (1-based, counted at `consumer:preparing`) throws
   * `error()` at its before_commit seam, inside the publication transaction. Returns the claim count and the request's
   * transient_interruptions as each claim began (read while the request runs).
   */
  function interrupt(requestId: string, failing: (claim: number) => boolean, error: () => Error) {
    const claims = { n: 0, attempts: [] as number[] };
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'consumer:preparing') {
        claims.n++;
        claims.attempts.push((await row(requestId)).transient_interruptions);
        return;
      }
      if (point === 'publication:before_commit' && failing(claims.n)) throw error();
    });
    return claims;
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine); await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("DELETE FROM config WHERE key IN ('persistence.max_preparation_attempts','persistence.max_transient_retries')");
    resetWriteSwitches();
  });

  /** A low retry limit keeps these cases to a few claims; the default and the backoff are lp-b's. */
  const retries = async (limit: number) => { await engine.setConfig('persistence.max_transient_retries', String(limit)); resetWriteSwitches(); };

  test('a write cancelled at every publication ends write_interrupted after exactly max_transient_retries retries', async () => {
    await retries(1);
    const slug = `db/interrupted-${++n}`, requestId = randomUUID();
    const claims = interrupt(requestId, () => true, () => interruption('57014'));
    const outcome = await call({ slug, content: page(`Interrupted ${n}`), request_id: requestId }).catch(error => error as { code?: string });
    installFaultHook(undefined);
    expect(claims.n).toBe(2);
    expect((outcome as { code?: string }).code).toBe('write_interrupted');
    const failed = await row(requestId);
    expect(failed).toMatchObject({ state: 'failed', error_code: 'write_interrupted', preparation_attempts: 0, transient_interruptions: 2, has_recovery: false });
    expect(failed.error_message).toContain('2 time(s)');
    expect(failed.error_message).toContain('57014');
    expect(failed.error_detail).toMatchObject({ origin: 'database_interruption', attempts: 2, limit: 1, sqlstate: '57014' });
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
    // The receipt names the code and its diagnostic, like every other write error.
    const receipt = await withEnv({ GBRAIN_HOME: home }, () => op('get_write_request').handler(context(), { request_id: requestId })) as Record<string, unknown>;
    expect(receipt).toMatchObject({ state: 'failed', write_error: 'write_interrupted' });
    expect(String(receipt.write_error_message)).toContain('57014');
    // The source keeps moving: the next write commits.
    expect(await call({ slug: `db/after-${n}`, content: page(`After ${n}`), request_id: randomUUID() })).toMatchObject({ state: 'committed' });
  }, 120_000);

  test('a single interruption re-prepares once, is counted and commits', async () => {
    const slug = `db/once-${++n}`, requestId = randomUUID();
    const claims = interrupt(requestId, claim => claim === 1, () => interruption('57014'));
    expect(await call({ slug, content: page(`Once ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(claims.n).toBe(2);
    expect(claims.attempts).toEqual([0, 1]);
    expect(await row(requestId)).toMatchObject({ state: 'committed' });
  }, 120_000);

  for (const code of ['CONNECTION_CLOSED', '57P01', '55P03', '40P01']) test(`a dropped connection or contention (${code}) is never counted: past the limit the write still commits`, async () => {
    const slug = `db/connection-${++n}`, requestId = randomUUID();
    const claims = interrupt(requestId, claim => claim <= 3, () => interruption(code));
    expect(await call({ slug, content: page(`Connection ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(claims.n).toBe(4);
    expect(claims.attempts).toEqual([0, 0, 0, 0]);
    expect(await row(requestId)).toMatchObject({ state: 'committed' });
  }, 120_000);

  test('a managed sync entry that ends write_interrupted is held: the rest of the source lands, and retry-held re-admits it', async () => withEnv({ GBRAIN_HOME: home,
    GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    const id = `wi-${randomUUID().slice(0, 8)}`, root = join(home, id);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(root); git('init', '-q');
    for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.md`), page(`Sync ${name}`));
    git('add', '.'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await retries(1);
    // Every publication of a request for page `a` of this source has its statement cancelled. The request's page is read
    // as it is claimed (outside any transaction: PGLite has one connection, which the publication holds).
    const pageA = new Set<string>();
    installFaultHook(async (point, detail) => {
      if (detail.sourceId !== id || !detail.requestId) return;
      if (point === 'consumer:preparing') {
        const [request] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id=$1::uuid', [detail.requestId]);
        if (request?.slug === 'a') pageA.add(detail.requestId);
      }
      if (point === 'publication:before_commit' && pageA.has(detail.requestId)) throw interruption('57014');
    });
    const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
    const first = await sync();
    expect(first.status).not.toBe('blocked_by_failures');
    expect(await engine.readPageSnapshot('b', { sourceId: id })).not.toBeNull();
    expect(await engine.readPageSnapshot('a', { sourceId: id })).toBeNull();
    // One request for `a`, never re-frozen in place: its two preparations, then the hold.
    const requests = async () => engine.executeRaw<{ state: string; error_code: string | null; preparation_attempts: number; transient_interruptions: number }>(
      "SELECT state,error_code,preparation_attempts,transient_interruptions FROM persistence_requests WHERE source_id=$1 AND slug='a' ORDER BY sequence", [id]);
    expect(await requests()).toEqual([{ state: 'failed', error_code: 'write_interrupted', preparation_attempts: 0, transient_interruptions: 2 }]);
    const writerStatus = ['gbrain', 'sources', 'writer', 'status', '--source', id, '--json'];
    const held = await readSyncStatus(engine, id);
    expect(held.last_error).toBeNull();
    expect(held.needs_human).toBe(false);
    expect(held.holds).toEqual([expect.objectContaining({ path: 'a.md', code: 'write_interrupted', class: 'page', needs_human: false,
      fix: expect.objectContaining({ argv: writerStatus }) })]);
    // A second run with the cause still there makes no worse: it ends without blocking and `a` stays held.
    expect((await sync()).status).not.toBe('blocked_by_failures');
    expect((await readSyncStatus(engine, id)).holds).toEqual([expect.objectContaining({ path: 'a.md', code: 'write_interrupted' })]);
    // The cause gone, retry-held re-admits the entry and the same sync imports it.
    installFaultHook(undefined);
    await retryHeld(engine, id);
    expect((await sync()).status).not.toBe('blocked_by_failures');
    expect(await engine.readPageSnapshot('a', { sourceId: id })).not.toBeNull();
    expect((await readSyncStatus(engine, id)).holds).toEqual([]);
  }), 300_000);

  test('a crash right after an interruption is charged costs exactly one attempt: the claim it leaves is not charged again', async () => {
    const slug = `db/crash-${++n}`, requestId = randomUUID();
    const claims = { n: 0, attempts: [] as number[] };
    let crashed = false;
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'consumer:preparing') {
        claims.n++;
        claims.attempts.push((await row(requestId)).transient_interruptions);
        if (claims.n === 1) throw interruption('57014');
      }
      // The owner dies here: nothing after the seam runs, and the claim it held lapses.
      if (point === 'persistence:interruption_charged' && !crashed) { crashed = true; throw new Error('owner died (probe)'); }
    });
    const pending = call({ slug, content: page(`Crash ${n}`), request_id: requestId }).catch(error => error as { code?: string });
    while (!crashed) await new Promise(resolve => setTimeout(resolve, 20));
    await engine.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE request_id=$1::uuid AND state='running'", [requestId]);
    expect(await pending).toMatchObject({ state: 'committed' });
    expect(claims.n).toBe(2);
    expect(claims.attempts).toEqual([0, 1]);
  }, 120_000);

  test('a group\'s shared read the database cancelled is charged once: the same failure settling a member again is released uncounted', async () => {
    const [shared] = await sharedReadFailures();
    const slug = `db/shared-${++n}`, requestId = randomUUID();
    const claims = { n: 0, attempts: [] as number[] };
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId || point !== 'consumer:preparing') return;
      claims.n++;
      claims.attempts.push((await row(requestId)).transient_interruptions);
      if (claims.n <= 3) throw shared;
    });
    expect(await call({ slug, content: page(`Shared ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(claims.n).toBe(4);
    expect(claims.attempts).toEqual([0, 1, 1, 1]);
  }, 120_000);

  describe('worktree-backed page', () => {
    let brainDir: string;
    const sourceId = `wt-${randomUUID().slice(0, 8)}`;
    beforeAll(async () => {
      brainDir = mkdtempSync(join(home, 'brain-'));
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, brainDir]);
      await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, sourceId, brainDir));
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      _resetWriteThroughCacheForTest();
    });
    afterAll(async () => { await disposePersistenceConsumer(engine); _resetWriteThroughCacheForTest(); });

    test('the limit follows max_transient_retries, and the recovery route restores the canonical file before the failure', async () => {
      const slug = `wt/interrupted-${++n}`;
      expect(await call({ slug, content: page(`Prior ${n}`), request_id: randomUUID() }, sourceId)).toMatchObject({ state: 'committed', write_through: { written: true } });
      const path = join(brainDir, `${slug}.md`);
      const bytes = readFileSync(path);
      const before = await engine.readPageSnapshot(slug, { sourceId });
      await retries(2);
      const requestId = randomUUID();
      const claims = interrupt(requestId, () => true, () => interruption('57014'));
      const outcome = await call({ slug, content: page(`Next ${n}`), request_id: requestId, expected_revision: before!.revision }, sourceId).catch(error => error as { code?: string });
      installFaultHook(undefined);
      expect(claims.n).toBe(3);
      expect((outcome as { code?: string }).code).toBe('write_interrupted');
      expect(await row(requestId)).toMatchObject({ state: 'failed', error_code: 'write_interrupted', preparation_attempts: 0, transient_interruptions: 3, has_recovery: false,
        error_detail: expect.objectContaining({ attempts: 3, limit: 2, sqlstate: '57014' }) });
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(await engine.readPageSnapshot(slug, { sourceId })).toEqual(before);
      expect(Number((await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM persistence_requests WHERE recovery IS NOT NULL'))[0]!.n)).toBe(0);
    }, 120_000);

    test('a crash between the recovery route\'s charge and its recovering mark costs exactly one attempt: the sweep does not charge it again', async () => {
      const slug = `wt/crash-${++n}`;
      expect(await call({ slug, content: page(`Prior ${n}`), request_id: randomUUID() }, sourceId)).toMatchObject({ state: 'committed', write_through: { written: true } });
      const path = join(brainDir, `${slug}.md`);
      const before = await engine.readPageSnapshot(slug, { sourceId });
      const requestId = randomUUID();
      const claims = { n: 0, attempts: [] as number[] };
      let crashed: Row | null = null;
      installFaultHook(async (point, detail) => {
        if (detail.requestId !== requestId) return;
        if (point === 'consumer:preparing') {
          claims.n++;
          claims.attempts.push((await row(requestId)).transient_interruptions);
        }
        if (point === 'publication:before_commit' && claims.n === 1) throw interruption('57014');
        // The owner dies here: the charge has committed, the request is not marked recovering, and its claim lapses.
        if (point === 'persistence:recovery_interruption_charged' && !crashed) { crashed = await row(requestId); throw new Error('owner died (probe)'); }
      });
      const pending = call({ slug, content: page(`Next ${n}`), request_id: requestId, expected_revision: before!.revision }, sourceId).catch(error => error as { code?: string });
      while (!crashed) await new Promise(resolve => setTimeout(resolve, 20));
      expect(crashed).toMatchObject({ state: 'running', preparation_attempts: 0, transient_interruptions: 1, has_recovery: true });
      await engine.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE request_id=$1::uuid AND state='running'", [requestId]);
      expect(await pending).toMatchObject({ state: 'committed' });
      expect(claims.n).toBe(2);
      expect(claims.attempts).toEqual([0, 1]);
      // The receipt is returned at commit; the owner clears the recovery record right after it.
      for (let i = 0; i < 100 && (await row(requestId)).has_recovery; i++) await new Promise(resolve => setTimeout(resolve, 50));
      expect(await row(requestId)).toMatchObject({ state: 'committed', preparation_attempts: 0, has_recovery: false });
      expect(readFileSync(path, 'utf8')).toContain(`Next ${n}`);
    }, 120_000);

    /**
     * Every read of the members' shared skill-pack check is cancelled: a group's shared read at its seam, and the same read a
     * lone member sends on the single path, where no shared read exists. `holdMs` holds each cancelled shared read, so every
     * member waiting joins it: one member is charged and the others are released uncounted, and the last of them is claimed
     * again alone, uncharged, which takes the single path.
     */
    const sharedReadCancelledEveryTime = (holdMs: number) => withEnv({ GBRAIN_HOME: home,
      OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      await registerLocalWriter(engine, 'cli');
      await retries(1);
      const dir = `shared-${++n}`;
      mkdirSync(join(brainDir, dir), { recursive: true });
      const files = ['a', 'b', 'c'].map(name => {
        writeFileSync(join(brainDir, dir, `${name}.md`), page(`Shared ${n} ${name}`));
        return { filePath: join(brainDir, dir, `${name}.md`), sourcePath: `${dir}/${name}.md` };
      });
      // A guard far above the bound stops the cancels, so an unbounded loop ends committed instead of hanging the test.
      const GUARD = 40;
      let cancelled = 0;
      let preparing = false;
      installFaultHook(async point => {
        if (point === 'consumer:preparing') preparing = true;
        if (point !== 'group:shared_read' || cancelled >= GUARD) return;
        cancelled++;
        if (holdMs) await new Promise(resolve => setTimeout(resolve, holdMs));
        throw interruption('57014');
      });
      // The single path reads through the engine itself (a transaction's view is another object and is left alone); a shared
      // read never gets here, because its seam above threw first. The import's own screening, before any preparation, reads it too.
      const direct = engine.executeRaw;
      engine.executeRaw = function (this: BrainEngine, sql: string, ...rest: unknown[]) {
        if (preparing && this === engine && /shared_skill_packs/.test(sql) && cancelled < GUARD) { cancelled++; return Promise.reject(interruption('57014')); }
        return (direct as (...args: unknown[]) => Promise<unknown>).call(this, sql, ...rest);
      } as BrainEngine['executeRaw'];
      const settled = await importManagedFiles(engine, files, { sourceId, noEmbed: true })
        .finally(() => { installFaultHook(undefined); engine.executeRaw = direct; });
      const rows = await engine.executeRaw<{ slug: string; state: string; error_code: string | null; transient_interruptions: number }>(
        `SELECT slug,state,error_code,transient_interruptions FROM persistence_requests WHERE source_id=$1 AND slug LIKE $2 ORDER BY slug`, [sourceId, `${dir}/%`]);
      // Each cancelled read is charged to exactly one member (the first that settles with it), so the reads stop once every
      // member has used its max_transient_retries (1) and been interrupted once more: 3 members x 2.
      expect(cancelled).toBe(3 * 2);
      expect(rows).toEqual(['a', 'b', 'c'].map(name => ({ slug: `${dir}/${name}`, state: 'failed', error_code: 'write_interrupted', transient_interruptions: 2 })));
      expect(settled.map(result => result.status === 'rejected' ? (result.reason as { code?: string }).code : 'ok')).toEqual(['write_interrupted', 'write_interrupted', 'write_interrupted']);
    });

    test('a group\'s shared read the database cancels every time ends bounded: each cancelled read is charged to one member, and every member ends write_interrupted',
      () => sharedReadCancelledEveryTime(0), 120_000);

    test('a member a cancelled shared read released uncounted, claimed again alone, is cancelled and charged on the single path too (forced probe)',
      () => sharedReadCancelledEveryTime(150), 120_000);
  });
});
