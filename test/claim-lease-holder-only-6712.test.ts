/**
 * #6712 PR 2 (Garry, 2026-10-16, via GBRA-40): while a source's drain lease is live, only the lease holder publishes that
 * source's managed-sync requests. A non-resident consumer skips them; with no live lease, or for the holder itself or a
 * resident consumer, the claim is unchanged.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { admitWrite, claimNextWrite, releaseUnpublishedClaim, type WriteAdmission } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimOwner, setClaimOwnerForTest } from '../src/core/persistence/claim-phase.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
const sourceId = 'lease-holder-only-example';
const hostId = randomUUID();
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema();
  engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await registerLocalWriter(engine, 'cli');
    expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
  }
}, 120_000);
afterAll(async () => {
  setClaimOwnerForTest(undefined);
  await engines[0]?.disconnect(); await closePostgres?.();
});

async function admission(engine: BrainEngine, slug: string): Promise<WriteAdmission> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const context: OperationContext = { engine, sourceId, remote: false, dryRun: false,
    config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(context, 'put_page', sourceId, source.incarnation, slug);
  const content = '---\ntitle: Lease holder example\ntype: note\n---\nA synthetic note.\n';
  return { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: source.incarnation,
    slug, pageId: null, requestId: randomUUID(), callerIntent: { slug, content }, intent: { slug, content }, authority };
}

/** A queued row standing in for a drainer's page request: only its intent kind marks it managed sync. */
async function syncRow(engine: BrainEngine): Promise<string> {
  const row = await admitWrite(engine, await admission(engine, `notes/synced-${randomUUID().slice(0, 8)}`));
  await engine.executeRaw(`UPDATE persistence_requests SET intent=jsonb_set(intent,'{kind}','"managed_sync_page"') WHERE id=$1::uuid`, [row.id]);
  return row.id;
}
const lease = (engine: BrainEngine, pid: number, ttl: string) => engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at,last_refreshed_at)
  VALUES($1,$2,$3,now(),now()+$4::interval,now()) ON CONFLICT(id) DO UPDATE SET holder_pid=EXCLUDED.holder_pid,ttl_expires_at=EXCLUDED.ttl_expires_at`, [syncLockId(sourceId), pid, hostname(), ttl]);
const as = (kind: string) => setClaimOwnerForTest({ ...claimOwner(), kind });
async function claimed(engine: BrainEngine): Promise<WriteRequest | null> {
  const row = await claimNextWrite(engine, hostId);
  if (row) await releaseUnpublishedClaim(engine, row, 'consumer_stopping');
  return row;
}

test('a short-lived consumer never claims a sync row while another live process holds the source\'s drain lease; the holder, resident consumers and a dead holder\'s rows still drain', async () => {
  for (const engine of engines) {
    const id = await syncRow(engine);
    // A live process of this host holds the lease; a killed one's lease (TTL not lapsed) does not count.
    const holder = Bun.spawn(['sleep', '120'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const otherPid = holder.pid;
    const dead = Bun.spawn(['true']); await dead.exited;
    try {
      as('put');
      expect((await claimed(engine))?.id).toBe(id);
      await lease(engine, otherPid, '2 minutes');
      expect(await claimed(engine)).toBeNull();
      as('cli');
      expect(await claimed(engine)).toBeNull();
      for (const kind of ['sync', 'serve', 'jobs']) { as(kind); expect((await claimed(engine))?.id).toBe(id); }
      as('put');
      await lease(engine, process.pid, '2 minutes');
      expect((await claimed(engine))?.id).toBe(id);
      await lease(engine, otherPid, '-1 second');
      expect((await claimed(engine))?.id).toBe(id);
      await lease(engine, dead.pid, '2 minutes');
      expect((await claimed(engine))?.id).toBe(id);
      // A foreground write of the same source is claimed beside a live lease.
      await lease(engine, otherPid, '2 minutes');
      await engine.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid', [id]);
      const own = await admitWrite(engine, await admission(engine, 'notes/foreground'));
      expect((await claimed(engine))?.id).toBe(own.id);
    } finally {
      holder.kill('SIGKILL'); await holder.exited;
      setClaimOwnerForTest(undefined);
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(sourceId)]);
      await engine.executeRaw('DELETE FROM persistence_requests WHERE source_id=$1', [sourceId]);
    }
  }
}, 120_000);
