/**
 * Large-pages hardening (c): a publication cancelled at the publication ceiling counts against the transient retry budget.
 *
 * 1. Protects: `boundPublication` cancels a publication that runs past `persistence.publication_ceiling_ms` and its
 *    grace. That cancellation (whatever error the cancelled publish then rejects with: a discarded connection, an
 *    AbortError, a 57014) is a transient interruption (transient-retry.ts): it is counted in `transient_interruptions`
 *    against `persistence.max_transient_retries` and schedules the next claim with the backoff, so a write whose
 *    publication overruns the ceiling every time ends `failed`/`write_interrupted` (cause `publication_ceiling`) after
 *    the cap instead of being prepared and published again without limit. A single overrun re-prepares and commits. Both
 *    publication arms: a database-only page (finishUnpublishedFailure) and a worktree-backed page (the recovery route,
 *    which restores the canonical file first; on Postgres the retried publish there surfaces as a bare AbortError). A
 *    member a group's overrun charged publishes alone from then on, and a sync lane group cancelled while its predecessor
 *    still publishes charges each member on release (laneFallback).
 * 2. Fails when: the cancelled publication is released as `database_contention` uncounted (v0.60.299.0: the error is a
 *    discarded connection, which is never counted), so the claim count grows past the cap; or when the recovery route
 *    fails it `storage_error` at once.
 * 3. Existing coverage: test/persistence-publication-deadline.test.ts pins that the ceiling marks, cancels and reports a
 *    publication and that a cancelled one commits nothing; it never bounds how often a write is published again.
 * 4. Semantic injection: `_setPublicationTimingForTest` sets a 300 ms ceiling and 50 ms grace; installFaultHook parks the
 *    publication at `publication:before_commit` (inside its transaction) past the cancellation and then rejects it as the
 *    discarded connection does (`PublicationDeadlineError`, CONNECTION_CLOSED). PGLite cannot cancel a running
 *    transaction (its signal is checked only before BEGIN), so the parked body's own rejection stands in for the
 *    discard there; on Postgres the signal also discards the connection. The charged hook brings each backoff forward.
 *    The 300 ms ceiling applies only to publications the test parks: once it parks the last one it means to, the
 *    publications after it run under the configured ceiling, so a retry slower than 350 ms on a loaded host (a worktree
 *    publication writes and renames the page file inside its transaction) is not cancelled a second time. The ceiling runs
 *    from the start of a publication, so on a loaded host it can cancel one before it reaches the park; that publication's
 *    charge names it. So the bookkeeping (the next claim's ceiling, which members published together) happens at the
 *    charge, which every cancelled publication reaches. Done only at the park, the head of a group the ceiling cancelled
 *    early took its next claim under the 300 ms ceiling, was taken for the group again and was cancelled and charged a
 *    second time (transient_interruptions 2 under load). The loaded-host cases stall a publication past the ceiling before
 *    the park (Postgres only: PGLite cannot cancel a running transaction).
 *    A guard stops the overruns far above the cap, so an unbounded loop ends committed. PGLite always; Postgres with DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { importManagedFiles } from '../../src/core/persistence/import-mutations.ts';
import * as publicationDeadline from '../../src/core/persistence/publication-deadline.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { execFileSync } from 'node:child_process';
import { pathologicalArms } from './harness.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;
const CEILING_MS = 300, GRACE_MS = 50;
const INJECTED = { ceilingMs: CEILING_MS, graceMs: GRACE_MS };
/** Parked past the ceiling and its grace, when the owner has cancelled the publication. */
const PARK_MS = CEILING_MS + GRACE_MS + 200;
const GUARD = 14;
const discarded = () => Object.assign(new Error('publication_deadline: the publish transaction passed the ceiling and its connection was discarded (CONNECTION_CLOSED)'),
  { name: 'PublicationDeadlineError', code: 'CONNECTION_CLOSED' });
// Optional, so the file still loads (and fails on its assertions, not its import) against a build without the seam.
const setTiming = (timing: { ceilingMs: number; graceMs: number } | undefined) =>
  (publicationDeadline as { _setPublicationTimingForTest?: (t: typeof timing) => void })._setPublicationTimingForTest?.(timing);

type Row = { state: string; error_code: string | null; error_message: string | null; error_detail: Record<string, unknown> | null;
  preparation_attempts: number; transient_interruptions?: number; recovery: unknown };

for (const { backend, databaseUrl } of pathologicalArms()) describe(`[${backend}] lp-c: a publication cancelled at the ceiling is a counted transient interruption`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-lp-c-${backend}-`));
  let n = 0;
  const context = (sourceId: string): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId });
  const call = (params: Record<string, unknown>, sourceId = 'default') => withEnv({ GBRAIN_HOME: home },
    () => op('put_page').handler(context(sourceId), { wait_ms: 30_000, ...params })) as Promise<Record<string, any>>;
  const row = async (requestId: string): Promise<Row> => (await engine.executeRaw<{ j: Row | string }>(
    'SELECT to_jsonb(r) AS j FROM persistence_requests r WHERE request_id=$1::uuid', [requestId])).map(r => typeof r.j === 'string' ? JSON.parse(r.j) as Row : r.j)[0]!;

  /**
   * Every publication of claims `overruns(k)` parks past the ceiling and then fails as a discarded connection; one the
   * ceiling cancels before the park is counted at its charge (`publications` counts both). `stall(k)` is a loaded host:
   * claim k's publication takes PARK_MS before its commit instead of parking, so the injected ceiling cancels it there.
   */
  function overrun(requestId: string, overruns: (claim: number) => boolean, stall: (claim: number) => boolean = () => false) {
    const seen = { claims: 0, publications: 0, transient: [] as number[], preparation: [] as number[], charges: [] as string[] };
    let parked = false;
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'consumer:preparing') {
        seen.claims++;
        parked = false;
        const current = await row(requestId);
        seen.transient.push(current.transient_interruptions ?? 0);
        seen.preparation.push(current.preparation_attempts);
        return;
      }
      if (point === 'persistence:interruption_charged' || point === 'persistence:recovery_interruption_charged') {
        seen.charges.push(`claim ${seen.claims} ${point} ${JSON.stringify(detail.interruption ?? null)}`);
        if (!parked) seen.publications++;
        // The next claim reads its ceiling before it prepares: only a publication this hook will park keeps the injected one.
        setTiming(overruns(seen.claims + 1) ? INJECTED : undefined);
        // Only a released row: one still held (the recovery route charges before it requeues) keeps its backoff, which the
        // owner's reclaim of a row it released itself must honour.
        await engine.executeRaw("UPDATE persistence_requests SET next_attempt_at=now() WHERE request_id=$1::uuid AND state='queued'", [requestId]).catch(() => undefined);
        return;
      }
      if (point !== 'publication:before_commit' || seen.claims > GUARD) return;
      if (stall(seen.claims)) { await new Promise(resolve => setTimeout(resolve, PARK_MS)); return; }
      if (!overruns(seen.claims)) return;
      seen.publications++;
      parked = true;
      await new Promise(resolve => setTimeout(resolve, PARK_MS));
      throw discarded();
    });
    return seen;
  }

  /** A claim count other than the expected one prints every charge (its cause and error) and the row, so a load-only failure names its cause. */
  async function expectClaims(seen: { claims: number; transient: number[]; preparation: number[]; charges: string[] }, expected: number, requestId: string) {
    if (seen.claims !== expected) console.error('lp-c unexpected claims', JSON.stringify({ expected, ...seen, row: await row(requestId).then(({ state, error_code, error_detail, preparation_attempts, transient_interruptions }) =>
      ({ state, error_code, error_detail, preparation_attempts, transient_interruptions }), error => String(error)) }));
    expect(seen.claims).toBe(expected);
  }
  /** The grouped tests' charge log: each member's charges with their cause and error, printed when a member is charged other than once. */
  function recordCharge(charges: Map<string, string[]>, point: string, detail: { requestId?: string; interruption?: unknown }) {
    if (point.endsWith('interruption_charged') && detail.requestId) charges.set(detail.requestId, [...charges.get(detail.requestId) ?? [], `${point} ${JSON.stringify(detail.interruption ?? null)}`]);
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(databaseUrl!); engine = pg.engine; closePostgres = pg.close; }
    setTiming(INJECTED);
  }, 120_000);
  afterAll(async () => {
    setTiming(undefined);
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine); await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine);
    setTiming(INJECTED);
    await engine.executeRaw("DELETE FROM config WHERE key IN ('persistence.max_transient_retries')");
    resetWriteSwitches();
  });

  test('a publication that overruns the ceiling every time ends write_interrupted after exactly max_transient_retries (5) retries', async () => {
    const slug = `db/overrun-${++n}`, requestId = randomUUID();
    const seen = overrun(requestId, () => true);
    const outcome = await call({ slug, content: page(`Overrun ${n}`), request_id: requestId }).catch(error => error as { code?: string });
    installFaultHook(undefined);
    await expectClaims(seen, 6, requestId);
    // One publication per claim: on Postgres a cancelled group of one is never published again under the same claim.
    expect(seen.publications).toBe(6);
    expect((outcome as { code?: string }).code).toBe('write_interrupted');
    expect(seen.transient).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seen.preparation).toEqual([0, 0, 0, 0, 0, 0]);
    const failed = await row(requestId);
    expect(failed).toMatchObject({ state: 'failed', error_code: 'write_interrupted', transient_interruptions: 6, preparation_attempts: 0 });
    expect(failed.error_detail).toMatchObject({ origin: 'database_interruption', cause: 'publication_ceiling', attempts: 6, limit: 5 });
    expect(failed.error_message).toContain('persistence.publication_ceiling_ms');
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
  }, 180_000);

  test('a single overrun is counted once, re-prepares and commits', async () => {
    const slug = `db/overrun-once-${++n}`, requestId = randomUUID();
    const seen = overrun(requestId, claim => claim === 1);
    expect(await call({ slug, content: page(`Once ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    await expectClaims(seen, 2, requestId);
    expect(seen.transient).toEqual([0, 1]);
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).not.toBeNull();
  }, 180_000);

  (backend === 'postgres' ? test : test.skip)('on a loaded host, a publication the ceiling cancels before the park still counts as one of the max_transient_retries (5) retries', async () => {
    const slug = `db/overrun-loaded-every-${++n}`, requestId = randomUUID();
    const seen = overrun(requestId, () => true, claim => claim === 1);
    const outcome = await call({ slug, content: page(`Loaded every ${n}`), request_id: requestId }).catch(error => error as { code?: string });
    installFaultHook(undefined);
    await expectClaims(seen, 6, requestId);
    expect(seen.publications).toBe(6);
    expect((outcome as { code?: string }).code).toBe('write_interrupted');
    expect(seen.transient).toEqual([0, 1, 2, 3, 4, 5]);
    expect(await row(requestId)).toMatchObject({ state: 'failed', error_code: 'write_interrupted', transient_interruptions: 6 });
  }, 180_000);

  (backend === 'postgres' ? test : test.skip)('on a loaded host, where every publication outlasts the test ceiling, a single overrun is counted once and the retry commits under the configured ceiling', async () => {
    const slug = `db/overrun-loaded-once-${++n}`, requestId = randomUUID();
    const seen = overrun(requestId, claim => claim === 1, () => true);
    expect(await call({ slug, content: page(`Loaded once ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    await expectClaims(seen, 2, requestId);
    expect(seen.publications).toBe(1);
    expect(seen.transient).toEqual([0, 1]);
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).not.toBeNull();
  }, 180_000);

  describe('worktree-backed page (the recovery route)', () => {
    let brainDir: string;
    const sourceId = `lpc-${randomUUID().slice(0, 8)}`;
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

    test('an overrun on every publication ends write_interrupted after the cap with the canonical file restored', async () => {
      await engine.setConfig('persistence.max_transient_retries', '2');
      resetWriteSwitches();
      const slug = `wt/overrun-${++n}`;
      expect(await call({ slug, content: page(`Prior ${n}`), request_id: randomUUID() }, sourceId)).toMatchObject({ state: 'committed', write_through: { written: true } });
      const path = join(brainDir, `${slug}.md`);
      const bytes = readFileSync(path);
      const before = await engine.readPageSnapshot(slug, { sourceId });
      const requestId = randomUUID();
      const seen = overrun(requestId, () => true);
      const outcome = await call({ slug, content: page(`Next ${n}`), request_id: requestId, expected_revision: before!.revision }, sourceId).catch(error => error as { code?: string });
      installFaultHook(undefined);
      await expectClaims(seen, 3, requestId);
      expect((outcome as { code?: string }).code).toBe('write_interrupted');
      expect(seen.transient).toEqual([0, 1, 2]);
      expect(await row(requestId)).toMatchObject({ state: 'failed', error_code: 'write_interrupted', transient_interruptions: 3, recovery: null,
        error_detail: expect.objectContaining({ cause: 'publication_ceiling', attempts: 3, limit: 2 }) });
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(await engine.readPageSnapshot(slug, { sourceId })).toEqual(before);
    }, 180_000);

    test('a grouped import whose group publication overruns every time charges each member once per publication and ends write_interrupted after the cap', async () => {
      await engine.setConfig('persistence.max_transient_retries', '2');
      resetWriteSwitches();
      const dir = `grp-${++n}`;
      mkdirSync(join(brainDir, dir), { recursive: true });
      const files = ['a', 'b'].map(name => {
        const sourcePath = `${dir}/${name}.md`;
        writeFileSync(join(brainDir, sourcePath), page(`Group ${name} ${n}`));
        return { filePath: join(brainDir, sourcePath), sourcePath };
      });
      // Every publication in this source parks past the ceiling, then fails as a discarded connection; each is one interruption.
      const publications: string[] = [], claims = new Map<string, number>();
      installFaultHook(async (point, detail) => {
        if (detail.sourceId !== sourceId) return;
        if (point === 'consumer:preparing') { claims.set(detail.requestId!, (claims.get(detail.requestId!) ?? 0) + 1); return; }
        if (point === 'publication:before_commit' && publications.length < GUARD) {
          publications.push(detail.requestId!);
          await new Promise(resolve => setTimeout(resolve, PARK_MS));
          throw discarded();
        }
      });
      const results = await withEnv({ GBRAIN_HOME: home }, () => importManagedFiles(engine, files, { sourceId, noEmbed: true }));
      installFaultHook(undefined);
      expect(results.map(result => result.status === 'rejected' ? (result.reason as { code?: string }).code : result.status)).toEqual(['write_interrupted', 'write_interrupted']);
      const rows = await engine.executeRaw<{ request_id: string; state: string; error_code: string | null; transient_interruptions: number; detail: Record<string, unknown> | string }>(
        "SELECT request_id::text AS request_id,state,error_code,transient_interruptions,error_detail AS detail FROM persistence_requests WHERE source_id=$1 AND intent->>'import_batch' IS NOT NULL ORDER BY sequence", [sourceId]);
      expect(rows.length).toBe(2);
      for (const member of rows) {
        expect(member).toMatchObject({ state: 'failed', error_code: 'write_interrupted', transient_interruptions: 3 });
        expect(typeof member.detail === 'string' ? JSON.parse(member.detail) : member.detail).toMatchObject({ cause: 'publication_ceiling', attempts: 3, limit: 2 });
        // One claim per interruption: a cancelled group publication is never published again under the same claim.
        expect(claims.get(member.request_id)).toBe(3);
      }
      // Every publication was charged: each member took part in at most its three charged interruptions.
      expect(publications.length).toBeLessThanOrEqual(6);
      for (const { sourcePath } of files) expect(await engine.readPageSnapshot(sourcePath.replace(/\.md$/, ''), { sourceId })).toBeNull();
    }, 180_000);

    /**
     * A grouped import whose group publication overruns only as a whole: a publication overruns only while another member
     * prepared in the same pass is still unpublished (a group of two); the members prepare together and then reach
     * before_commit one after the other inside the one transaction. The group publication is over at its first charge,
     * wherever the ceiling ended it (at the park, or before it on a loaded host, when that charge names the group): each
     * member's own publication after it runs under the configured ceiling. `chargePauseMs` pauses after each recovery
     * charge; `stallMs` (a loaded host) stalls every member's file publication inside its transaction.
     */
    function overrunWholeGroup(opts: { chargePauseMs?: number; stallMs?: number } = {}) {
      const unpublished = new Set<string>(), claims = new Map<string, number>(), grouped: string[][] = [], charges = new Map<string, string[]>();
      installFaultHook(async (point, detail) => {
        if (detail.sourceId !== sourceId) return;
        recordCharge(charges, point, detail);
        if (point === 'consumer:preparing') { unpublished.add(detail.requestId!); claims.set(detail.requestId!, (claims.get(detail.requestId!) ?? 0) + 1); return; }
        if (point.endsWith('interruption_charged')) {
          if (unpublished.size > 1 && grouped.length < GUARD) grouped.push([...unpublished]);
          unpublished.clear();
          setTiming(undefined);
          if (opts.chargePauseMs && point === 'persistence:recovery_interruption_charged') await new Promise(resolve => setTimeout(resolve, opts.chargePauseMs));
          return;
        }
        if (point === 'publication:after_publication' && opts.stallMs) { await new Promise(resolve => setTimeout(resolve, opts.stallMs)); return; }
        if (point !== 'publication:before_commit') return;
        const together = unpublished.size;
        unpublished.delete(detail.requestId!);
        if (together < 2 || grouped.length >= GUARD) return;
        grouped.push([...unpublished, detail.requestId!]);
        unpublished.clear();
        await new Promise(resolve => setTimeout(resolve, PARK_MS));
        throw discarded();
      });
      return { claims, grouped, charges };
    }

    /** Two pages of one grouped import under `dir`: their import results, the members' rows, and each member's commit. */
    async function importWholeGroup(dir: string, overrun: ReturnType<typeof overrunWholeGroup>, title: string) {
      mkdirSync(join(brainDir, dir), { recursive: true });
      const files = ['a', 'b'].map(name => {
        const sourcePath = `${dir}/${name}.md`;
        writeFileSync(join(brainDir, sourcePath), page(`${title} ${name} ${n}`));
        return { filePath: join(brainDir, sourcePath), sourcePath };
      });
      const results = await withEnv({ GBRAIN_HOME: home }, () => importManagedFiles(engine, files, { sourceId, noEmbed: true }));
      installFaultHook(undefined);
      expect(results.map(result => result.status === 'rejected' ? (result.reason as { code?: string }).code : result.status)).toEqual(['fulfilled', 'fulfilled']);
      // One group publication, cancelled at the ceiling; after it each member is claimed and published on its own.
      expect(overrun.grouped.length).toBe(1);
      const rows = await engine.executeRaw<{ request_id: string; state: string; transient_interruptions: number }>(
        "SELECT request_id::text AS request_id,state,transient_interruptions FROM persistence_requests WHERE source_id=$1 AND intent->>'import_batch' IS NOT NULL AND slug LIKE $2 ORDER BY sequence",
        [sourceId, `${dir}/%`]);
      expect(rows.length).toBe(2);
      for (const member of rows) {
        if (member.transient_interruptions !== 1 || overrun.claims.get(member.request_id) !== 2) console.error('lp-c unexpected member charges', JSON.stringify({ member, claims: overrun.claims.get(member.request_id), charges: overrun.charges.get(member.request_id) ?? [], grouped: overrun.grouped }));
        expect(member).toMatchObject({ state: 'committed', transient_interruptions: 1 });
        expect(overrun.claims.get(member.request_id)).toBe(2);
      }
      for (const { sourcePath } of files) expect(await engine.readPageSnapshot(sourcePath.replace(/\.md$/, ''), { sourceId })).not.toBeNull();
    }

    test('a grouped import whose group publication overruns only as a whole publishes each member alone after one charged interruption, and both commit', async () => {
      await engine.setConfig('persistence.max_transient_retries', '2');
      resetWriteSwitches();
      await importWholeGroup(`grp-whole-${++n}`, overrunWholeGroup(), 'Whole');
    }, 180_000);

    (backend === 'postgres' ? test : test.skip)('on a loaded host, where the ceiling cancels the group publication before the park, each member is still charged once and both commit', async () => {
      await engine.setConfig('persistence.max_transient_retries', '2');
      resetWriteSwitches();
      await importWholeGroup(`grp-loaded-${++n}`, overrunWholeGroup({ stallMs: PARK_MS }), 'Loaded');
    }, 180_000);

    test('a member a group interruption charged is claimed and prepared again even when its backoff elapses before the pass ends', async () => {
      await engine.setConfig('persistence.max_transient_retries', '2');
      resetWriteSwitches();
      // As above, and each member's charge is followed by a pause longer than the first backoff (1 s), as on a loaded host:
      // the first member's backoff has elapsed before the pass is done with the group, so only the charge itself keeps the
      // pass from taking that claim back and publishing its old preparation under it.
      await importWholeGroup(`grp-slow-${++n}`, overrunWholeGroup({ chargePauseMs: 1_200 }), 'Slow');
    }, 180_000);

    test('a single overrun is retried, never a terminal storage_error (on Postgres the retried publish surfaces as a bare AbortError), and commits', async () => {
      const slug = `wt/overrun-once-${++n}`;
      expect(await call({ slug, content: page(`Prior ${n}`), request_id: randomUUID() }, sourceId)).toMatchObject({ state: 'committed' });
      const before = await engine.readPageSnapshot(slug, { sourceId });
      const requestId = randomUUID();
      const seen = overrun(requestId, claim => claim === 1);
      expect(await call({ slug, content: page(`Next ${n}`), request_id: requestId, expected_revision: before!.revision }, sourceId)).toMatchObject({ state: 'committed' });
      await expectClaims(seen, 2, requestId);
      expect(seen.transient).toEqual([0, 1]);
      expect(readFileSync(join(brainDir, `${slug}.md`), 'utf8')).toContain(`Next ${n}`);
    }, 180_000);
  });

  /**
   * #5984 lanes (Postgres only): a lane group the ceiling cancels while its predecessor group still publishes releases
   * its claims (laneFallback) instead of taking the single path, and charges each member there. Eight pages in bulk
   * groups on two lanes: the first group parks at `lane:applied` until the second's release is seen; the second overruns once at
   * `lane:applied` (inside its transaction, before its turn) and rejects as the discarded connection does. Its ceiling runs
   * from the start of its publication, so a stall or a late first BEGIN can cancel it before it reaches `lane:applied`: its
   * release charge then names it, and it is not overrun again. Without the charge on release, a lane group the ceiling
   * cancels every time would be released and claimed again without bound.
   */
  (backend === 'postgres' ? describe : describe.skip)('lane group (laneFallback)', () => {
    let lanes: BrainEngine;
    let closeLanes: (() => Promise<void>) | undefined;
    const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    beforeAll(async () => { const pg = await isolatedPersistencePostgres(databaseUrl!, 'instance', 12); lanes = pg.engine; closeLanes = pg.close; }, 120_000);
    afterAll(async () => { await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(lanes)); await closeLanes?.(); }, 60_000);

    test('a lane group cancelled at the ceiling while its predecessor still publishes charges each member on release, and every page commits', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
      const id = `lpc-lanes-${randomUUID().slice(0, 8)}`, root = join(home, id);
      mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
      for (let i = 0; i < 8; i++) writeFileSync(join(root, 'notes', `n${i}.md`), page(`Lane note ${i}`));
      git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
      await lanes.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await lanes.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
      await claimWorktree(lanes, id, root);
      await lanes.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      /** The request's group and the source's first two groups in admission order. */
      const groupOf = async (requestId: string) => {
        const [row] = await lanes.executeRaw<{ grp: string | null }>("SELECT intent->>'group' AS grp FROM persistence_requests WHERE request_id=$1::uuid", [requestId]);
        const order = (await lanes.executeRaw<{ grp: string }>(`SELECT intent->>'group' AS grp FROM persistence_requests WHERE source_id=$1 AND intent ? 'group'
          GROUP BY 1 ORDER BY min(sequence) LIMIT 2`, [id])).map(r => r.grp);
        return { grp: row?.grp ?? null, first: order[0], second: order[1] };
      };
      let releaseFirst!: () => void;
      const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
      setTimeout(() => releaseFirst(), 10_000);
      const overrun = new Set<string>(), charges: Array<{ grp: string | null; blocked: string | null }> = [];
      let second: string | null = null;
      installFaultHook(async (point, detail) => {
        if (detail.sourceId !== id) return;
        if (point === 'persistence:interruption_charged') {
          const [charged] = await lanes.executeRaw<{ grp: string | null; blocked: string | null }>(
            "SELECT intent->>'group' AS grp,blocked_reason AS blocked FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
          charges.push(charged!);
          if (second === null && charged!.grp && charged!.blocked === 'group_member_waiting' && charged!.grp !== (await groupOf(detail.requestId!)).first) {
            overrun.add(charged!.grp); second = charged!.grp;
          }
          if (charged!.grp === second) releaseFirst();
          return;
        }
        // The second group is admitted before any page prepares, so the first group's parked transaction never holds up its
        // admission (the drain admits the next group only as the run moves on).
        if (point === 'consumer:preparing') {
          for (let i = 0; i < 150 && (await groupOf(detail.requestId!)).second === undefined; i++) await new Promise(resolve => setTimeout(resolve, 100));
          return;
        }
        if (point !== 'lane:applied') return;
        const group = await groupOf(detail.requestId!);
        if (!group?.grp) return;
        if (group.grp === group.first) { await firstReleased; return; }
        if (group.grp !== group.second || overrun.has(group.grp)) return;
        overrun.add(group.grp); second = group.grp;
        await new Promise(resolve => setTimeout(resolve, PARK_MS));
        throw discarded();
      });
      try {
        await performSync(lanes, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 2 });
        await waitFor(async () => {
          const [imports] = await lanes.executeRaw<{ pending: number; committed: number }>(`SELECT count(*) FILTER (WHERE state<>'committed')::int AS pending,
            count(DISTINCT slug) FILTER (WHERE state='committed')::int AS committed FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'`, [id]);
          return imports!.pending === 0 && imports!.committed === 8;
        }, { timeoutMs: 120_000, label: 'all eight lane pages commit' });
      } finally { installFaultHook(undefined); }
      expect(overrun.size).toBe(1);
      const members = await lanes.executeRaw<{ slug: string; transient_interruptions: number }>(
        "SELECT slug,transient_interruptions FROM persistence_requests WHERE source_id=$1 AND intent->>'group'=$2 ORDER BY sequence", [id, second]);
      expect(members.length).toBeGreaterThan(1);
      // Each member of the cancelled group was charged once, by the lane release (its claim went back as group_member_waiting).
      expect(members.map(member => member.transient_interruptions)).toEqual(members.map(() => 1));
      expect(charges.filter(charge => charge.grp === second)).toEqual(members.map(() => ({ grp: second, blocked: 'group_member_waiting' })));
      for (let i = 0; i < 8; i++) expect(await lanes.readPageSnapshot(`notes/n${i}`, { sourceId: id })).not.toBeNull();
    }), 300_000);
  });
});
