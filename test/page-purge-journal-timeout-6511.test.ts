/**
 * #6511 (GBRA-79 wave 16, G3.1): a page purge's historical-request lookup
 * used to run as an O(journal) substring scan inside the 5 s publication
 * transaction, and its statement timeout (57014) was classified as
 * transient contention with no attempt cap, so the request oscillated
 * queued <-> running forever and FIFO held every later write to its source.
 *
 * Protects (fail-first against master):
 * - [R1 a] a statement timeout inside any of the purge's remaining in-transaction
 *   lookups (slug lookup, tail re-check, pending re-check, locking read) ends the
 *   request `failed`/`purge_lookup_timeout` on the FIRST claim, with the failed
 *   receipt retained, nothing removed or tombstoned, a following write to the
 *   source committing, a same-id retry returning the terminal failure and a new
 *   request_id admitted. Master: `write_pending`, the row left `queued` with
 *   `database_contention` after several claims, no `journal_sweep` on any receipt.
 * - [R1 b] a journal sweep that outruns the preparation budget is a charged
 *   `preparation_deadline` release, then `preparation_stalled` at the attempt
 *   limit; the sweep loop checks the claim clock itself between chunks (PGLite
 *   has no server-side bound) and on Postgres the bounded read's 57014 is the
 *   same deadline.
 * - [R1 c] both recovery arms: a database-only page and a worktree-backed page,
 *   with the canonical bytes byte-identical after the terminal failure.
 * - [R2] the preparation sweep records a sequence ceiling and the rows pending
 *   at scan; the publication re-checks the tail and those rows, so a carrying
 *   request admitted-then-cancelled after the scan, or settled after it, is
 *   still redacted; a request still queued at publication is left in place;
 *   `journal_sweep.complete` is false when a cap is hit, never swallowed.
 * - [R3] the keyset sweep: continuation past empty chunks, matches beyond the
 *   second chunk, compacted outcomes, error_detail and raw error_message
 *   matches, JSON-escaped needles, another source untouched, bigint sequences
 *   carried as text, the match cap.
 * - [R6] the failure names `repair request-indexes` only when the slug index is
 *   missing or invalid.
 *
 * Why existing coverage misses it: test/page-purge.test.ts pins what a purge
 * removes, never a lookup failure or the journal census boundary.
 * Semantic injection: `installFaultHook` on the purge's named seams, never an
 * SQL substring. Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook, type FaultDetail, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { boundedReads, PreparationDeadlineError } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { JOURNAL_SWEEP_CHUNK_ROWS, JOURNAL_SWEEP_MATCH_CAP, sweepRequestsCarrying } from '../src/core/persistence/intent-redaction.ts';
import { PERSISTENCE_REQUEST_SLUG_INTENT_INDEX } from '../src/core/persistence/schema.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { buildIndexOnline } from '../src/core/schema-migrations/helpers.ts';
import { assertConservation } from '../scripts/persistence/harness.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const CLAIM = 'Deploy key lives in vault-a';
const page = (title: string, claim = CLAIM) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->\n`;
const op = (name: string) => operations.find(o => o.name === name)!;
const timeout57014 = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
type Row = { state: string; error_code: string | null; error_message: string | null; blocked_reason: string | null; preparation_attempts: number; has_recovery: boolean; intent: unknown; outcome: unknown; compacted: boolean };

for (const backend of backends) describe(`[${backend}] #6511 page purge journal lookups`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-6511-${backend}-`));
  let n = 0;
  const context = (): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });
  const call = (name: string, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, () => op(name).handler(context(), params)) as Promise<Record<string, any>>;
  const row = async (requestId: string): Promise<Row> => (await engine.executeRaw<Row>(`SELECT state,error_code,error_message,blocked_reason,preparation_attempts,
    recovery IS NOT NULL AS has_recovery,intent,outcome,compacted FROM persistence_requests WHERE request_id=$1::uuid`, [requestId]))[0]!;
  const count = async (sql: string, params: unknown[] = []) => Number((await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
  const revision = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision;
  /** A page with one extracted fact (the purge's needle) and a committed write of another page carrying the claim. */
  async function seed(prefix: string): Promise<{ slug: string; carrier: string; carrierRequest: string }> {
    const slug = `${prefix}/leaked-${++n}`, carrier = `${prefix}/mentions-${n}`;
    await importFromContent(engine, slug, page(`Leaked ${n}`), { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: [slug] });
    expect(await count('facts WHERE source_id=$1 AND source_markdown_slug=$2', ['default', slug])).toBe(1);
    const carrierRequest = randomUUID();
    const written = await call('put_page', { slug: carrier, content: `---\ntitle: Mentions ${n}\ntype: note\n---\nSomeone wrote: ${CLAIM}.\n`, request_id: carrierRequest });
    expect(written.state).toBe('committed');
    return { slug, carrier, carrierRequest };
  }
  async function purge(slug: string, requestId = randomUUID()) {
    return call('delete_page', { slug, purge: true, request_id: requestId, expected_revision: await revision(slug) });
  }
  async function failure(fn: () => Promise<unknown>): Promise<OperationError> {
    try { await fn(); } catch (error) { expect(error).toBeInstanceOf(OperationError); return error as OperationError; }
    throw new Error('expected a refusal');
  }
  /** Installs a hook on the named seam for the named request; counts the request's preparation claims. */
  function arm(points: Partial<Record<FaultPoint, (detail: FaultDetail) => Promise<void> | void>>, requestId: string) {
    const claims: string[] = [];
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'consumer:preparing') claims.push(point);
      await points[point]?.(detail);
    });
    return { claims };
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
  afterEach(async () => { installFaultHook(undefined); await disposePersistenceConsumer(engine); });

  const points: Array<'slug_lookup' | 'tail_recheck' | 'pending_recheck' | 'redaction_read'> = ['slug_lookup', 'tail_recheck', 'pending_recheck', 'redaction_read'];
  for (const point of points) test(`[R1 a] a statement timeout at the ${point} ends the purge failed/purge_lookup_timeout on the first claim; the source keeps moving`, async () => {
    const { slug, carrier, carrierRequest } = await seed('db');
    const before = { page: await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }), carrierIntent: (await row(carrierRequest)).intent,
      facts: await count('facts WHERE source_id=$1', ['default']), pagePurges: await count('page_purges'), factPurges: await count('fact_purges') };
    const requestId = randomUUID();
    const { claims } = arm({ [`purge:${point}`]: () => { throw timeout57014(); } }, requestId);
    const error = await failure(() => purge(slug, requestId));
    expect(error.code).toBe('purge_lookup_timeout');
    expect(error.message).toContain('could not finish');
    expect(error.message).toContain('Do not assume the requested content was erased');
    expect(error.writeRequest?.state).toBe('failed');
    expect(claims).toHaveLength(1);
    const failed = await row(requestId);
    expect(failed).toMatchObject({ state: 'failed', error_code: 'purge_lookup_timeout', preparation_attempts: 0, has_recovery: false });
    expect(failed.error_message).toContain('could not finish');
    // Nothing of the page, its facts, its tombstones or the journal changed.
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toEqual(before.page);
    expect(await count('facts WHERE source_id=$1', ['default'])).toBe(before.facts);
    expect(await count('page_purges')).toBe(before.pagePurges);
    expect(await count('fact_purges')).toBe(before.factPurges);
    expect((await row(carrierRequest)).intent).toEqual(before.carrierIntent);
    // The same request id replays the terminal failure; the queue behind it moves; a new request id is admitted.
    const replay = await failure(() => purge(slug, requestId));
    expect(replay.writeRequest).toEqual(error.writeRequest);
    const next = await call('put_page', { slug: `db/after-${n}`, content: `---\ntitle: After ${n}\ntype: note\n---\nMoves again.\n`, request_id: randomUUID() });
    expect(next.state).toBe('committed');
    installFaultHook(undefined);
    const purged = await purge(slug);
    expect(purged).toMatchObject({ status: 'purged', state: 'committed', journal_sweep: { complete: true, tail: 0, pending_rechecked: 0 } });
    expect(Number(purged.journal_sweep.scanned)).toBeGreaterThanOrEqual(1);
    expect(typeof purged.journal_sweep.ceiling).toBe('string');
    expect((await row(carrierRequest))).toMatchObject({ intent: null, compacted: true });
    expect(await engine.readPageSnapshot(carrier, { sourceId: 'default' })).not.toBeNull();
    await assertConservation(engine);
  }, 60_000);

  test('[R6] the failure names the index repair only while the slug index is missing or INVALID', async () => {
    const { slug } = await seed('hint');
    await engine.executeRaw(`DROP INDEX IF EXISTS ${PERSISTENCE_REQUEST_SLUG_INTENT_INDEX.name}`);
    try {
      const missingId = randomUUID();
      arm({ 'purge:slug_lookup': () => { throw timeout57014(); } }, missingId);
      const missing = await failure(() => purge(slug, missingId));
      expect(missing.code).toBe('purge_lookup_timeout');
      expect(missing.message).toContain('repair request-indexes');
      expect(missing.message).toContain(`${PERSISTENCE_REQUEST_SLUG_INTENT_INDEX.name} is missing`);
      // The journal keeps code and message only: the hint must be in the durable receipt, not only on the thrown error's fix.
      expect((await row(missingId)).error_message).toContain('repair request-indexes');
    } finally {
      await disposePersistenceConsumer(engine);
      expect(await buildIndexOnline(engine, 0, PERSISTENCE_REQUEST_SLUG_INTENT_INDEX)).toBe('created');
    }
    const validId = randomUUID();
    arm({ 'purge:slug_lookup': () => { throw timeout57014(); } }, validId);
    const valid = await failure(() => purge(slug, validId));
    expect(valid.code).toBe('purge_lookup_timeout');
    expect(valid.message).not.toContain('repair request-indexes');
    expect(valid.message).toContain('new request_id');
    expect((await row(validId)).error_message).not.toContain('repair request-indexes');
  }, 60_000);

  test('[R1 b] a sweep that outruns the preparation budget is a charged preparation_deadline release, then preparation_stalled at the limit; the source keeps moving', async () => {
    const { slug } = await seed('budget');
    await engine.setConfig('persistence.maintenance_preparation_ms', '1000');
    resetWriteSwitches();
    try {
      const requestId = randomUUID();
      const seen: Row[] = [];
      const { claims } = arm({
        'consumer:preparing': async () => { seen.push(await row(requestId)); },
        'purge:sweep_chunk': () => Bun.sleep(1_600),
      }, requestId);
      const error = await failure(() => purge(slug, requestId));
      expect(error.code).toBe('preparation_stalled');
      expect(error.message).toContain('submit the write again with a new request_id');
      expect(claims).toHaveLength(2);
      // The second claim saw the first attempt's charged release.
      expect(seen[1]).toMatchObject({ state: 'running', preparation_attempts: 1 });
      expect(await row(requestId)).toMatchObject({ state: 'failed', error_code: 'preparation_stalled', preparation_attempts: 2, has_recovery: false });
      expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).not.toBeNull();
      installFaultHook(undefined);
      await disposePersistenceConsumer(engine);
      const next = await call('put_page', { slug: `budget/after-${n}`, content: `---\ntitle: After ${n}\ntype: note\n---\nMoves again.\n`, request_id: randomUUID() });
      expect(next.state).toBe('committed');
      await assertConservation(engine);
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw("DELETE FROM config WHERE key='persistence.maintenance_preparation_ms'");
      resetWriteSwitches();
    }
  }, 60_000);

  test('[R1 b] the sweep loop ends at the claim clock between chunks, without a server-side bound', async () => {
    await seed('clock');
    let statements = 0;
    const counting = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return (sql: string, params?: unknown[]) => { if (sql.includes('WITH chunk AS MATERIALIZED')) statements++; return target.executeRaw(sql, params); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const start = Date.now();
    const clock = startClaimPhase(start, undefined, 10_000);
    let ticks = 0;
    // The first check passes; every later one reads a clock past the deadline.
    const now = () => ++ticks === 1 ? start : start + 20_000;
    const error = await sweepRequestsCarrying(counting, 'default', [CLAIM], { clock, chunkRows: 1, now }).then(() => null, (e: unknown) => e as { code?: string; message: string });
    expect(error?.code).toBe('preparation_deadline');
    expect(error?.message).toContain('reached its preparation budget between chunks');
    expect(statements).toBe(1);
  }, 60_000);

  if (backend === 'postgres') test('[R1 b] on Postgres a bounded chunk read the server ends is the same deadline', async () => {
    await seed('bounded');
    // Another session holds the journal, so the chunk read is sent inside its budget and waits until the server ends
    // it at the bound. (A budget that has already run out is refused before the read is sent: the next test.)
    const error = await engine.transaction(async tx => {
      await tx.executeRaw('LOCK TABLE persistence_requests IN ACCESS EXCLUSIVE MODE');
      const bounded = boundedReads(engine, startClaimPhase(Date.now(), undefined, 300));
      return sweepRequestsCarrying(bounded, 'default', [CLAIM], { now: () => 0 }).then(() => null, (e: unknown) => e);
    });
    expect(error).toBeInstanceOf(PreparationDeadlineError);
    expect((error as PreparationDeadlineError).code).toBe('preparation_deadline');
    expect((error as PreparationDeadlineError).sqlstate).toBe('57014');
  }, 60_000);

  if (backend === 'postgres') test('[R1 b] on Postgres a chunk read issued after the deadline is the deadline, however fast the read would be', async () => {
    await seed('late');
    const bounded = boundedReads(engine, startClaimPhase(Date.now() - 5_000, undefined, 1_000));
    const error = await sweepRequestsCarrying(bounded, 'default', [CLAIM], { now: () => 0 }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(PreparationDeadlineError);
    expect((error as PreparationDeadlineError).code).toBe('preparation_deadline');
    expect((error as PreparationDeadlineError).sqlstate).toBeNull();
  }, 60_000);

  test('[R2] a carrying request admitted and cancelled after the preparation scan is redacted by the tail re-check; one still queued is left in place', async () => {
    const { slug } = await seed('race');
    const [principal] = await engine.executeRaw<{ principal_kind: string; principal_id: string }>("SELECT principal_kind,principal_id FROM persistence_requests WHERE slug=$1", [slug.replace('leaked', 'mentions')]);
    const requestId = randomUUID();
    const cancelledId = randomUUID(), queuedId = randomUUID();
    let queuedWrite: Promise<Record<string, any>> | null = null;
    arm({ 'consumer:prepared': async () => {
      // Both admitted after the scan completed, so neither is in the sweep's id list; both carry the claim in their intent.
      // wait_ms: 0 reports the admitted write as pending (a thrown write_pending) and leaves it queued behind this purge.
      const admitted = await call('put_page', { slug: `race/cancelled-${n}`, content: `---\ntitle: C\ntype: note\n---\nLate: ${CLAIM}.\n`, request_id: cancelledId, wait_ms: 0 }).catch(error => error as OperationError);
      expect((admitted as OperationError).code).toBe('write_pending');
      expect((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [cancelledId]))[0]!.state).toBe('queued');
      const cancelled = await cancelWriteRequest(engine, { kind: principal.principal_kind as never, id: principal.principal_id }, cancelledId);
      expect(cancelled?.state).toBe('cancelled');
      queuedWrite = call('put_page', { slug: `race/queued-${n}`, content: `---\ntitle: Q\ntype: note\n---\nLater: ${CLAIM}.\n`, request_id: queuedId });
      let queuedRows: { state: string }[] = [];
      for (const deadline = Date.now() + 10_000; queuedRows.length === 0 && Date.now() < deadline; await Bun.sleep(25)) {
        queuedRows = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [queuedId]);
      }
      expect(queuedRows[0]?.state).toBe('queued');
    } }, requestId);
    const purged = await purge(slug, requestId);
    expect(purged).toMatchObject({ status: 'purged', state: 'committed' });
    expect(purged.journal_sweep.tail).toBeGreaterThanOrEqual(2);
    expect(purged.journal_sweep.complete).toBe(true);
    const cancelled = await row(cancelledId);
    expect(cancelled).toMatchObject({ state: 'cancelled', intent: null, compacted: true, error_message: null });
    expect(JSON.stringify(cancelled.outcome ?? {}).toLowerCase()).not.toContain(CLAIM.toLowerCase());
    installFaultHook(undefined);
    const later = await queuedWrite!;
    expect(later.state).toBe('committed');
    expect(JSON.stringify((await row(queuedId)).intent)).toContain(CLAIM);
    await assertConservation(engine);
  }, 60_000);

  test('[R2] a request pending at the scan that settles with a carrying outcome is redacted by the pending re-check', async () => {
    const { slug } = await seed('pending');
    const [principal] = await engine.executeRaw<{ principal_kind: string; principal_id: string }>("SELECT principal_kind,principal_id FROM persistence_requests WHERE slug=$1", [slug.replace('leaked', 'mentions')]);
    // A request of another owner's worktree: never claimable here, never blocking, but a pending row of this source at scan time.
    const [worktree] = await engine.executeRaw<{ id: string }>("INSERT INTO persistence_worktrees(owner_host_id,state) VALUES (gen_random_uuid(),'active') RETURNING id::text AS id");
    const pendingId = randomUUID();
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,intent,authority,state,intent_bytes,terminal_reservation)
      VALUES ($1,$2,$3::uuid,'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'pending/other',$4::uuid,'d','{}'::jsonb,'{}'::jsonb,'queued',0,0)`,
    [principal.principal_kind, principal.principal_id, pendingId, worktree.id]);
    await engine.executeRaw("UPDATE persistence_counters SET lifetime_ids=lifetime_ids+1,outstanding_count=outstanding_count+1 WHERE key IN ('brain',$1)", [`principal:${principal.principal_kind}:${principal.principal_id}`]);
    const requestId = randomUUID();
    arm({ 'consumer:prepared': async () => {
      await engine.executeRaw(`UPDATE persistence_requests SET state='committed',outcome=$2::text::jsonb,completed_at=now() WHERE request_id=$1::uuid`, [pendingId, JSON.stringify({ echoed: `Outcome carries ${CLAIM}` })]);
      await engine.executeRaw("UPDATE persistence_counters SET outstanding_count=outstanding_count-1 WHERE key IN ('brain',$1)", [`principal:${principal.principal_kind}:${principal.principal_id}`]);
    } }, requestId);
    const purged = await purge(slug, requestId);
    expect(purged).toMatchObject({ status: 'purged', state: 'committed', journal_sweep: { pending_rechecked: 1, complete: true } });
    const settled = await row(pendingId);
    expect(settled).toMatchObject({ state: 'committed', compacted: true, outcome: { echoed: '[purged]' } });
    await assertConservation(engine);
  }, 60_000);

  test('[R2] the receipt reports complete:false when the tail past the ceiling exceeds its bound', async () => {
    const { slug } = await seed('tail');
    const requestId = randomUUID();
    arm({ 'consumer:prepared': async () => {
      await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,state,intent_bytes,terminal_reservation,completed_at)
        SELECT 'local_cli','seed-tail',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'tail/row-'||g,'d','{}'::jsonb,'{}'::jsonb,'committed',0,0,now()
        FROM generate_series(1,$1::int) g`, [JOURNAL_SWEEP_CHUNK_ROWS + 1]);
    } }, requestId);
    const purged = await purge(slug, requestId);
    expect(purged).toMatchObject({ status: 'purged', state: 'committed', journal_sweep: { tail: JOURNAL_SWEEP_CHUNK_ROWS, complete: false } });
    await engine.executeRaw("DELETE FROM persistence_requests WHERE principal_id='seed-tail'");
  }, 60_000);

  test('[R3] the keyset sweep walks every chunk, matches every text column in raw and JSON-escaped form, and leaves other sources alone', async () => {
    const incarnation = "(SELECT incarnation FROM sources WHERE id='default')";
    const seedRow = (slug: string, columns: { intent?: unknown; outcome?: unknown; error_detail?: unknown; error_message?: string; compacted?: boolean; source?: string }) =>
      engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,state,
          intent_bytes,terminal_reservation,outcome,error_detail,error_message,compacted,completed_at)
        VALUES ('local_cli','seed-keyset',gen_random_uuid(),'put_page',$1,${incarnation},$2,'d',$3::text::jsonb,'{}'::jsonb,'committed',0,0,$4::text::jsonb,$5::text::jsonb,$6,$7,now()) RETURNING id::text AS id`,
      [columns.source ?? 'default', slug, columns.intent === undefined ? null : JSON.stringify(columns.intent), columns.outcome === undefined ? null : JSON.stringify(columns.outcome),
        columns.error_detail === undefined ? null : JSON.stringify(columns.error_detail), columns.error_message ?? null, columns.compacted ?? false]).then(rows => (rows[0] as { id: string }).id);
    const quoted = 'He said "vault\\a" twice';
    const expected: string[] = [];
    try {
    // Two full chunks that match nothing, then the carrying rows past row 4,000 (an empty-match chunk precedes them).
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,state,intent_bytes,terminal_reservation,completed_at)
      SELECT 'local_cli','seed-keyset',gen_random_uuid(),'put_page','default',${incarnation},'keyset/row-'||g,'d','{"content":"nothing here"}'::jsonb,'{}'::jsonb,'committed',0,0,now()
      FROM generate_series(1,$1::int) g`, [2 * JOURNAL_SWEEP_CHUNK_ROWS]);
    expected.push(await seedRow('keyset/intent', { intent: { content: `says ${CLAIM.toUpperCase()} loudly` } }));
    expected.push(await seedRow('keyset/outcome-compacted', { outcome: { echoed: CLAIM }, compacted: true }));
    expected.push(await seedRow('keyset/error-detail', { error_detail: { reason: `because ${CLAIM}` } }));
    expected.push(await seedRow('keyset/error-message', { error_message: `refused: ${quoted}` }));
    expected.push(await seedRow('keyset/quoted-json', { intent: { content: quoted } }));
    const foreign = await seedRow('keyset/foreign', { intent: { content: CLAIM }, source: 'gstack' });
    const unrelated = await seedRow('keyset/unrelated', { intent: { content: 'nothing' }, outcome: { echoed: 'nothing' } });
    const sweep = await sweepRequestsCarrying(engine, 'default', [CLAIM, quoted]);
    expect(sweep.targets.map(t => t.id).sort()).toEqual([...expected].sort());
    expect(sweep.targets.map(t => t.id)).not.toContain(foreign);
    expect(sweep.targets.map(t => t.id)).not.toContain(unrelated);
    expect(sweep.complete).toBe(true);
    expect(sweep.pendingAtScan).toEqual([]);
    expect(sweep.scanned).toBe(await count("persistence_requests WHERE source_id='default'"));
    expect(typeof sweep.ceiling).toBe('string');
    expect(sweep.ceiling).toBe((await engine.executeRaw<{ s: string }>("SELECT max(sequence)::text AS s FROM persistence_requests WHERE source_id='default'"))[0]!.s);
    // A quoted claim: the raw form appears only in the text column (error_message), the JSON-escaped form only inside a JSON column.
    const both = await sweepRequestsCarrying(engine, 'default', ['"vault\\a"']);
    expect(both.targets.map(t => t.id).sort()).toEqual([expected[3]!, expected[4]!].sort());
    // The escaped form alone is not searched raw: a needle that only matches when escaped finds only the JSON row.
    const escapedOnly = await sweepRequestsCarrying(engine, 'default', ['said "vault']);
    expect(escapedOnly.targets.map(t => t.id).sort()).toEqual([expected[3]!, expected[4]!].sort());
    expect((await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM persistence_requests WHERE strpos(lower(intent::text),'said "vault')>0`))[0]!.n).toBe('0');
    // The match cap: more carrying rows than the cap leave complete:false with exactly the cap collected.
    const capped = await sweepRequestsCarrying(engine, 'default', [CLAIM], { matchCap: 2 });
    expect(capped.targets).toHaveLength(2);
    expect(capped.complete).toBe(false);
    } finally { await engine.executeRaw("DELETE FROM persistence_requests WHERE principal_id='seed-keyset'"); }
  }, 120_000);

  test('[R3] the real match cap leaves complete:false and exactly the cap collected', async () => {
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,state,intent_bytes,terminal_reservation,completed_at)
      SELECT 'local_cli','seed-cap',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'cap/row-'||g,'d',$2::text::jsonb,'{}'::jsonb,'committed',0,0,now()
      FROM generate_series(1,$1::int) g`, [JOURNAL_SWEEP_MATCH_CAP + 1, JSON.stringify({ content: CLAIM })]);
    try {
      const sweep = await sweepRequestsCarrying(engine, 'default', [CLAIM]);
      expect(sweep.targets).toHaveLength(JOURNAL_SWEEP_MATCH_CAP);
      expect(sweep.complete).toBe(false);
    } finally { await engine.executeRaw("DELETE FROM persistence_requests WHERE principal_id='seed-cap'"); }
  }, 120_000);

  describe('worktree-backed page', () => {
    let brainDir: string;
    const sourceId = `wt-${randomUUID().slice(0, 8)}`;
    const wt = (): OperationContext => ({ ...context(), sourceId });
    const callWt = (name: string, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, () => op(name).handler(wt(), params)) as Promise<Record<string, any>>;
    beforeAll(async () => {
      brainDir = mkdtempSync(join(home, 'brain-'));
      await disposePersistenceConsumer(engine);
      // A source this host owns explicitly (the automatic first-write claim is PGLite's single-host convenience).
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, brainDir]);
      await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, sourceId, brainDir));
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      _resetWriteThroughCacheForTest();
    });
    afterAll(async () => { await disposePersistenceConsumer(engine); _resetWriteThroughCacheForTest(); });
    for (const present of [true, false]) test(`[R1 c] the worktree arm (file ${present ? 'present' : 'already removed'}): the terminal failure recovers the canonical state byte-identically and keeps the failed receipt`, async () => {
      const slug = `wt/leaked-${++n}`;
      // A coordinated write on the managed source: the page, its canonical file and (after extraction) its fact.
      const written = await callWt('put_page', { slug, source_id: sourceId, content: page(`Worktree ${n}`), request_id: randomUUID() });
      expect(written).toMatchObject({ state: 'committed', write_through: { written: true } });
      await disposePersistenceConsumer(engine);
      await runExtractFacts(engine, { slugs: [slug], sourceId });
      expect(await count('facts WHERE source_id=$1 AND source_markdown_slug=$2', [sourceId, slug])).toBe(1);
      const path = join(brainDir, `${slug}.md`);
      expect(existsSync(path)).toBe(true);
      const bytes = readFileSync(path);
      if (!present) rmSync(path);
      const before = { page: await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }), facts: await count('facts WHERE source_id=$1', [sourceId]), pagePurges: await count('page_purges') };
      const requestId = randomUUID();
      let removedDuringPublication: boolean | null = null;
      const { claims } = arm({ 'purge:slug_lookup': () => { removedDuringPublication = !existsSync(path); throw timeout57014(); } }, requestId);
      const purgeWt = async (id = randomUUID()) => callWt('delete_page', { slug, purge: true, request_id: id, source_id: sourceId,
        expected_revision: (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!.revision });
      const error = await failure(() => purgeWt(requestId));
      expect(error.code).toBe('purge_lookup_timeout');
      expect(error.writeRequest?.state).toBe('failed');
      expect(claims).toHaveLength(1);
      if (present) {
        // The file was removed by the publication and restored by the recovery route; its bytes are the prior bytes.
        expect(removedDuringPublication as boolean | null).toBe(true);
        expect(readFileSync(path).equals(bytes)).toBe(true);
      } else expect(existsSync(path)).toBe(false);
      const failed = await row(requestId);
      expect(failed).toMatchObject({ state: 'failed', error_code: 'purge_lookup_timeout', has_recovery: false });
      expect(await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true })).toEqual(before.page);
      expect(await count('facts WHERE source_id=$1', [sourceId])).toBe(before.facts);
      expect(await count('page_purges')).toBe(before.pagePurges);
      expect(await count('persistence_requests WHERE recovery IS NOT NULL')).toBe(0);
      installFaultHook(undefined);
      await disposePersistenceConsumer(engine);
      const next = await callWt('put_page', { slug: `wt/after-${n}`, source_id: sourceId, content: `---\ntitle: After ${n}\ntype: note\n---\nMoves again.\n`, request_id: randomUUID() });
      expect(next).toMatchObject({ state: 'committed', write_through: { written: true } });
      const purged = await purgeWt();
      expect(purged).toMatchObject({ status: 'purged', state: 'committed', write_through: { written: true } });
      expect(existsSync(path)).toBe(false);
      await assertConservation(engine);
    }, 60_000);
  });
});
