/**
 * #6884: a page purge's journal sweep (#6511) read and lowered the whole write
 * journal once per purged page, so a batch of N purges cost N full sweeps and
 * a nightly purge phase held the source's FIFO queue for hours.
 *
 * Protects (fail-first against master):
 * - [B1] one sweep per batch: the first queued purge sweeps once for its own
 *   claims and those of the purges queued behind it (`journal_sweep.batch`),
 *   and each of those scans only the tail past that sweep's ceiling
 *   (`journal_sweep.watermark`), so the batch's total `scanned` stays near
 *   one journal instead of N. Master: no `batch`/`watermark`, and every
 *   receipt's `scanned` is the whole journal.
 * - [B1] redaction stays complete for every member: its carriers below the
 *   watermark (from the batch sweep), a carrier admitted and cancelled after
 *   the batch sweep (the member's tail), and a row pending at the batch sweep
 *   that settles with a carrying outcome before the member publishes.
 * - [B2] a member whose claims changed since the batch sweep does not reuse it:
 *   it sweeps from the start, so a carrier of its new claim below the old
 *   ceiling is still redacted.
 * - [B3] `sweepRequestsForGroups` attributes each hit to the groups whose
 *   needles it carries, caps each group on its own, and `after` reads only
 *   the rows past it.
 *
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { JOURNAL_SWEEP_CHUNK_ROWS, sweepRequestsForGroups } from '../src/core/persistence/intent-redaction.ts';
import { assertConservation } from '../scripts/persistence/harness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const page = (title: string, claim: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->\n`;
const op = (name: string) => operations.find(o => o.name === name)!;
const FILLER = 2 * JOURNAL_SWEEP_CHUNK_ROWS + 500;
type Row = { state: string; intent: unknown; outcome: unknown; compacted: boolean };

for (const backend of backends) describe(`[${backend}] #6884 page purge batch sweep`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-6884-${backend}-`));
  let n = 0;
  const context = (): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });
  const call = (name: string, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, () => op(name).handler(context(), params)) as Promise<Record<string, any>>;
  const row = async (requestId: string): Promise<Row> => (await engine.executeRaw<Row>('SELECT state,intent,outcome,compacted FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]!;
  const revision = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision;
  const purge = async (slug: string, requestId: string) => call('delete_page', { slug, purge: true, request_id: requestId, expected_revision: await revision(slug) });
  /** A page with one extracted fact (the purge's claim) and a committed write of another page carrying it. */
  async function seed(prefix: string): Promise<{ slug: string; claim: string; carrierRequest: string }> {
    const i = ++n, slug = `${prefix}/leaked-${i}`, claim = `Batch secret ${i} lives in vault-${randomUUID().slice(0, 8)}`;
    await importFromContent(engine, slug, page(`Leaked ${i}`, claim), { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: [slug] });
    const carrierRequest = randomUUID();
    const written = await call('put_page', { slug: `${prefix}/mentions-${i}`, content: `---\ntitle: Mentions ${i}\ntype: note\n---\nSomeone wrote: ${claim}.\n`, request_id: carrierRequest });
    expect(written.state).toBe('committed');
    return { slug, claim, carrierRequest };
  }
  /** Terminal journal rows that carry nothing: the bulk a full sweep has to read. */
  const fill = () => engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,state,
      intent_bytes,terminal_reservation,completed_at)
    SELECT 'local_cli','seed-6884',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'filler/row-'||g,'d',
      jsonb_build_object('content','filler body '||g),'{}'::jsonb,'committed',0,0,now() FROM generate_series(1,$1::int) g`, [FILLER]);
  const unfill = () => engine.executeRaw("DELETE FROM persistence_requests WHERE principal_id='seed-6884'");
  /** One hook per (seam, request): fires for the named request only. */
  function arm(hooks: Array<{ point: FaultPoint; requestId: string; fn: () => Promise<void> | void; once?: boolean }>) {
    const fired = new Set<number>();
    installFaultHook(async (point, detail) => {
      for (const [i, hook] of hooks.entries()) {
        if (hook.point !== point || hook.requestId !== detail.requestId || (hook.once && fired.has(i))) continue;
        fired.add(i);
        await hook.fn();
      }
    });
  }
  async function untilQueued(requestIds: string[]): Promise<void> {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(25)) {
      const rows = await engine.executeRaw<{ n: string }>("SELECT count(*)::text AS n FROM persistence_requests WHERE request_id=ANY($1::uuid[]) AND state='queued'", [requestIds]);
      if (Number(rows[0]!.n) === requestIds.length) return;
    }
    throw new Error('the batch members were not queued in time');
  }
  /** A request of another owner's worktree: never claimable here, but a pending row of this source while the batch sweeps. */
  async function foreignPending(principal: { principal_kind: string; principal_id: string }): Promise<string> {
    const [worktree] = await engine.executeRaw<{ id: string }>("INSERT INTO persistence_worktrees(owner_host_id,state) VALUES (gen_random_uuid(),'active') RETURNING id::text AS id");
    const id = randomUUID();
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,intent,authority,state,intent_bytes,terminal_reservation)
      VALUES ($1,$2,$3::uuid,'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'pending/other',$4::uuid,'d','{}'::jsonb,'{}'::jsonb,'queued',0,0)`,
    [principal.principal_kind, principal.principal_id, id, worktree!.id]);
    await engine.executeRaw("UPDATE persistence_counters SET lifetime_ids=lifetime_ids+1,outstanding_count=outstanding_count+1 WHERE key IN ('brain',$1)", [`principal:${principal.principal_kind}:${principal.principal_id}`]);
    return id;
  }
  async function settle(principal: { principal_kind: string; principal_id: string }, requestId: string, outcome: unknown): Promise<void> {
    await engine.executeRaw("UPDATE persistence_requests SET state='committed',outcome=$2::text::jsonb,completed_at=now() WHERE request_id=$1::uuid", [requestId, JSON.stringify(outcome)]);
    await engine.executeRaw("UPDATE persistence_counters SET outstanding_count=outstanding_count-1 WHERE key IN ('brain',$1)", [`principal:${principal.principal_kind}:${principal.principal_id}`]);
  }
  const principalOf = async (requestId: string) => (await engine.executeRaw<{ principal_kind: string; principal_id: string }>(
    'SELECT principal_kind,principal_id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]!;

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine); await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => { installFaultHook(undefined); await disposePersistenceConsumer(engine); await unfill(); });

  test('[B1] a batch of queued purges sweeps the journal once; each later member scans only the tail and still redacts every carrier', async () => {
    const seeds = [await seed('batch'), await seed('batch'), await seed('batch'), await seed('batch')];
    const principal = await principalOf(seeds[0]!.carrierRequest);
    const pendingId = await foreignPending(principal);
    await fill();
    const ids = seeds.map(() => randomUUID()), tailId = randomUUID();
    let members: Array<Promise<Record<string, any>>> = [];
    arm([
      // The leader waits at its claim until the other purges are queued behind it.
      { point: 'consumer:preparing', requestId: ids[0]!, once: true, fn: async () => {
        members = seeds.slice(1).map((s, i) => purge(s.slug, ids[i + 1]!));
        await untilQueued(ids.slice(1));
      } },
      // After the batch sweep read its ceiling: a carrier of member 1's claim admitted and cancelled (terminal, past the ceiling).
      { point: 'purge:sweep_chunk', requestId: ids[0]!, once: true, fn: async () => {
        const admitted = await call('put_page', { slug: `batch/late-${n}`, content: `---\ntitle: Late\ntype: note\n---\nLate: ${seeds[1]!.claim}.\n`, request_id: tailId, wait_ms: 0 })
          .catch(error => error as OperationError);
        expect((admitted as OperationError).code).toBe('write_pending');
        expect((await cancelWriteRequest(engine, { kind: principal.principal_kind as never, id: principal.principal_id }, tailId))?.state).toBe('cancelled');
      } },
      // A row pending at the batch sweep (below the watermark) settles carrying member 2's claim before member 2 publishes.
      { point: 'consumer:prepared', requestId: ids[2]!, once: true, fn: () => settle(principal, pendingId, { echoed: `Outcome carries ${seeds[2]!.claim}` }) },
    ]);
    const leader = await purge(seeds[0]!.slug, ids[0]!);
    const receipts = [leader, ...await Promise.all(members)];
    for (const receipt of receipts) expect(receipt).toMatchObject({ status: 'purged', state: 'committed', journal_sweep: { batch: 4, complete: true } });
    expect(leader.journal_sweep.watermark).toBeNull();
    expect(leader.journal_sweep.scanned).toBeGreaterThan(FILLER);
    for (const member of receipts.slice(1)) {
      expect(member.journal_sweep.watermark).toBe(leader.journal_sweep.ceiling);
      expect(member.journal_sweep.scanned).toBeLessThan(50);
    }
    const total = receipts.reduce((sum, receipt) => sum + Number(receipt.journal_sweep.scanned), 0);
    expect(total).toBeLessThan(leader.journal_sweep.scanned + 200);
    for (const s of seeds) expect(await row(s.carrierRequest)).toMatchObject({ intent: null, compacted: true });
    expect(await row(tailId)).toMatchObject({ state: 'cancelled', intent: null, compacted: true });
    expect(await row(pendingId)).toMatchObject({ state: 'committed', compacted: true, outcome: { echoed: '[purged]' } });
    await unfill();
    await assertConservation(engine);
  }, 120_000);

  test('[B2] a member whose claims changed since the batch sweep sweeps from the start and redacts a carrier of its new claim below the old ceiling', async () => {
    const seeds = [await seed('changed'), await seed('changed')];
    const changed = `Rotated secret now lives in vault-${randomUUID().slice(0, 8)}`;
    const lateCarrier = randomUUID();
    expect((await call('put_page', { slug: `changed/rotated-${n}`, content: `---\ntitle: Rotated\ntype: note\n---\nNoted: ${changed}.\n`, request_id: lateCarrier })).state).toBe('committed');
    await fill();
    const ids = [randomUUID(), randomUUID()];
    let member: Promise<Record<string, any>> | undefined;
    arm([
      { point: 'consumer:preparing', requestId: ids[0]!, once: true, fn: async () => { member = purge(seeds[1]!.slug, ids[1]!); await untilQueued([ids[1]!]); } },
      // After the batch sweep: member 1's fact now states another claim, which the batch never searched for.
      { point: 'consumer:prepared', requestId: ids[0]!, once: true, fn: async () => {
        await engine.executeRaw('UPDATE facts SET fact=$3 WHERE source_id=$1 AND source_markdown_slug=$2', ['default', seeds[1]!.slug, changed]);
      } },
    ]);
    const leader = await purge(seeds[0]!.slug, ids[0]!);
    const second = await member!;
    expect(leader).toMatchObject({ status: 'purged', journal_sweep: { batch: 2, watermark: null } });
    expect(second).toMatchObject({ status: 'purged', state: 'committed', journal_sweep: { watermark: null, complete: true } });
    expect(second.journal_sweep.scanned).toBeGreaterThan(FILLER);
    expect(await row(lateCarrier)).toMatchObject({ intent: null, compacted: true });
  }, 120_000);

  test('[B3] the group sweep attributes hits per group, caps each group on its own, and reads only past its watermark', async () => {
    const incarnation = "(SELECT incarnation FROM sources WHERE id='default')";
    const insert = (text: string) => engine.executeRaw<{ id: string; sequence: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,
        source_incarnation,slug,digest,intent,authority,state,intent_bytes,terminal_reservation,completed_at)
      VALUES ('local_cli','seed-6884',gen_random_uuid(),'put_page','default',${incarnation},'groups/row','d',$1::text::jsonb,'{}'::jsonb,'committed',0,0,now())
      RETURNING id::text AS id,sequence::text AS sequence`, [JSON.stringify({ content: text })]).then(rows => rows[0]!);
    const alpha = `Alpha secret ${randomUUID()}`, beta = `Beta secret ${randomUUID()}`;
    const a1 = await insert(`one ${alpha}`), both = await insert(`${alpha} and ${beta}`), b1 = await insert(`one ${beta}`), a2 = await insert(`two ${alpha}`);
    const sweeps = await sweepRequestsForGroups(engine, 'default', [{ key: 'a', claims: [alpha] }, { key: 'b', claims: [beta] }, { key: 'none', claims: [] }]);
    expect(sweeps.get('a')!.targets.map(t => t.id)).toEqual([a1.id, both.id, a2.id]);
    expect(sweeps.get('b')!.targets.map(t => t.id)).toEqual([both.id, b1.id]);
    expect(sweeps.get('none')!.targets).toEqual([]);
    expect(sweeps.get('a')!.complete && sweeps.get('b')!.complete).toBe(true);
    // Group a reaches the cap on its second hit and stops; group b keeps collecting to the end.
    const capped = await sweepRequestsForGroups(engine, 'default', [{ key: 'a', claims: [alpha] }, { key: 'b', claims: [`one ${beta}`] }], { matchCap: 2, chunkRows: 1 });
    expect(capped.get('a')).toMatchObject({ complete: false, targets: [{ id: a1.id }, { id: both.id }] });
    expect(capped.get('b')).toMatchObject({ complete: true, targets: [{ id: b1.id }] });
    expect(capped.get('b')!.scanned).toBeGreaterThan(capped.get('a')!.scanned);
    const tail = await sweepRequestsForGroups(engine, 'default', [{ key: 'a', claims: [alpha] }], { after: b1.sequence });
    expect(tail.get('a')).toMatchObject({ watermark: b1.sequence, scanned: 1, targets: [{ id: a2.id }], complete: true });
  }, 60_000);
});
