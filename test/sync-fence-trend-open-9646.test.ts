/**
 * #9646: the stamp's fence trend is pre-read outside its 5 s publication. An import still open at the pre-read is recorded by
 * sequence and read by the publication, so it is counted exactly once whenever it commits, and an old import that never commits
 * leaves the publication's read starting past the newest request instead of reopening the whole history.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readFenceTrendPrefix, recordPassFenceTrend } from '../src/core/persistence/sync-prepare.ts';
import { FENCE_TREND_OP } from '../src/core/fence-repair/census-store.ts';
import { upsertFenceTrendRunRecord } from '../src/core/engine-sql/fence-repair-records.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
});

const FENCES = JSON.stringify({ fences_normalized: [{ class: 'kind_map' }] });

async function history(engine: BrainEngine) {
  const sourceId = `source-a-${randomUUID().slice(0, 8)}`, incarnation = randomUUID();
  const [{ id: worktreeId }] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id::text AS id');
  const add = async (path: string, state: 'queued' | 'committed') => (await engine.executeRaw<{ sequence: string }>(`INSERT INTO persistence_requests
    (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,intent,authority,state,outcome,intent_bytes,terminal_reservation)
    VALUES('local_cli','test',$1::uuid,'put_page',$2,$3::uuid,$4,$5::uuid,'digest',$6::text::jsonb,'{}'::jsonb,$7,$8::text::jsonb,0,0) RETURNING sequence::text AS sequence`,
  [randomUUID(), sourceId, incarnation, path.replace(/\.md$/, ''), worktreeId, JSON.stringify({ kind: 'managed_sync_import', passId: 'pass-0', path }), state, state === 'committed' ? FENCES : null]))[0]!.sequence;
  const commit = (sequence: string) => engine.executeRaw(`UPDATE persistence_requests SET state='committed', outcome=$2::text::jsonb WHERE sequence=$1::bigint`, [sequence, FENCES]);
  const trend = async (passId: string) => (await engine.executeRaw<{ count: number }>(`SELECT (completed_keys->0->>'count')::int AS count FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`,
    [FENCE_TREND_OP, `${sourceId}:run:${passId}`]))[0]?.count;
  return { scope: { worktreeId, sourceId, incarnation }, add, commit, trend };
}

function recording(engine: BrainEngine) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const executeRaw = (sql: string, params: unknown[] = []) => { statements.push({ sql, params }); return engine.executeRaw(sql, params); };
  const readManagedSyncPassRow = (...args: Parameters<BrainEngine['readManagedSyncPassRow']>) => engine.readManagedSyncPassRow(...args);
  const listLiveManagedSyncPassRows = (...args: Parameters<BrainEngine['listLiveManagedSyncPassRows']>) => engine.listLiveManagedSyncPassRows(...args);
  return { engine: { executeRaw, upsertFenceTrendRunRecord: (op: string, fingerprint: string, record: unknown) => upsertFenceTrendRunRecord({ executeRaw } as never, op, fingerprint, record), readManagedSyncPassRow, listLiveManagedSyncPassRows } as unknown as BrainEngine, statements };
}

test('#9646: an import open at the pre-read that commits before the stamp is counted once, and a stuck old import keeps the publication past the newest request', async () => {
  for (const engine of engines) {
    const h = await history(engine);
    const stuck = await h.add('notes/stuck.md', 'queued');
    await h.add('notes/a.md', 'committed');
    const late = await h.add('notes/late.md', 'queued');
    const newest = await h.add('notes/c.md', 'committed');
    const prefix = await readFenceTrendPrefix(engine, h.scope);
    await h.commit(late);
    await h.add('notes/d.md', 'committed');
    const publication = recording(engine);
    await recordPassFenceTrend(publication.engine, { ...h.scope, passId: 'pass-1', since: null, prefix });
    // a, c, late and d, each once; the stuck import is still open and never read as committed.
    expect(await h.trend('pass-1')).toBe(4);
    const reads = publication.statements.filter(statement => statement.sql.includes('AS fences'));
    expect(reads).toHaveLength(1);
    expect(BigInt(reads[0]!.params[2] as string)).toBe(BigInt(newest));
    expect(prefix).toMatchObject({ since: null, through: newest, open: [stuck, late], tally: { count: 2 } });
  }
}, 120_000);

test('#9646: the open-import probe reads the open-request index, not the request history', async () => {
  for (const engine of engines) {
    const h = await history(engine);
    for (let i = 0; i < 3; i++) await h.add(`notes/p-${i}.md`, 'committed');
    const pre = recording(engine);
    expect((await readFenceTrendPrefix(pre.engine, h.scope)).open).toBeUndefined();
    const probe = pre.statements.find(statement => statement.sql.includes("state IN ('queued','deferred','running','recovering')"));
    expect(probe).toBeDefined();
    const plan = await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL enable_seqscan = off');
      await tx.executeRaw('SET LOCAL enable_bitmapscan = off');
      return tx.executeRaw<Record<string, string>>(`EXPLAIN ${probe!.sql}`, probe!.params);
    });
    expect(plan.map(row => Object.values(row)[0]).join('\n')).toContain('persistence_requests_open');
  }
}, 120_000);
