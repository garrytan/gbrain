/**
 * GBRA-248 W0a: owner activity on both engines. A worktree whose owner host
 * runs no consumer and has been quiet past 24 h reads stale (owner_unavailable plus diagnostic.owner) in the
 * receipt, which --accept-pending does not cover; a PGLite file held under
 * another host identity is stale at once; the owner is never stale to itself;
 * a live consumer keeps its owner fresh and its clean stop leaves a durable
 * timestamp; a repo-less (database-only) write never names an owner.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { ownerActivity, OWNER_STALE_MS } from '../src/core/persistence/owner-activity.ts';
import { startConsumerHeartbeat } from '../src/core/persistence/consumer-heartbeat.ts';
import { getWriteRequestById, receiptFor, writeHealthFacts } from '../src/core/persistence/journal.ts';
import { isWriteReceipt, publicWriteReceipt } from '../src/core/persistence/types.ts';
import { acceptPendingCovers, writeErrorExitCode } from '../src/core/persistence/write-wait.ts';
import { PENDING_WRITE_EXIT_CODE } from '../src/core/exit-codes.ts';
import { ownerHostStaleCheck } from '../src/commands/doctor/checks/owner-host-stale.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SOURCE = 'owner-activity-test';
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let home: string;
let self: string;
const inHome = <T>(run: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, run);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-owner-activity-'));
  self = await inHome(async () => localHostId());
  const local = new PGLiteEngine();
  await local.connect({}); await local.initSchema(); engines.push(local);
  const pg = process.env.DATABASE_URL;
  if (pg) { const isolated = await isolatedPersistencePostgres(pg); closePostgres = isolated.close; engines.push(isolated.engine); }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [SOURCE]);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

async function worktree(engine: BrainEngine, owner: string, heartbeatHoursAgo: number | null): Promise<string> {
  const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_worktrees(owner_host_id,heartbeat_at)
    VALUES($1::uuid, CASE WHEN $2::double precision IS NULL THEN NULL ELSE now()-($2::double precision*interval '1 hour') END) RETURNING id::text`, [owner, heartbeatHoursAgo]);
  return row!.id;
}
async function request(engine: BrainEngine, worktreeId: string | null, state: 'queued' | 'committed', hoursAgo: number, intent = '{"content":"x"}'): Promise<string> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    const [row] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
        intent_bytes,terminal_reservation,state,intent,worktree_id,created_at,updated_at,completed_at,published_at)
      VALUES('local_cli','owner-activity',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$3,$4,'{}'::jsonb,0,0,$5,$8::jsonb,$6::uuid,
        now()-($7::double precision*interval '1 hour'),now()-($7::double precision*interval '1 hour'),
        CASE WHEN $5='committed' THEN now()-($7::double precision*interval '1 hour') END,CASE WHEN $5='committed' THEN now()-($7::double precision*interval '1 hour') END)
      RETURNING id::text`, [randomUUID(), SOURCE, `notes/${randomUUID()}`, randomUUID(), state, worktreeId, hoursAgo, intent]);
    return row!.id;
  });
}

describe('owner activity', () => {
  test('a quiet foreign owner is stale past 24 h; a PGLite file holder is never the owner; the owner is never stale to itself', async () => inHome(async () => {
    for (const engine of engines) {
      const pglite = engine.kind === 'pglite';
      const gone = await worktree(engine, randomUUID(), 48); await request(engine, gone, 'queued', 48);
      const recent = await worktree(engine, randomUUID(), 1); await request(engine, recent, 'queued', 1);
      const own = await worktree(engine, self, 48); await request(engine, own, 'queued', 48);
      const unknownYoung = await worktree(engine, randomUUID(), null); await request(engine, unknownYoung, 'queued', 1);
      const unknownOld = await worktree(engine, randomUUID(), null); await request(engine, unknownOld, 'queued', 48);
      const published = await worktree(engine, randomUUID(), 48); await request(engine, published, 'committed', 1); await request(engine, published, 'queued', 2);
      const synced = await worktree(engine, randomUUID(), 48);
      await request(engine, synced, 'committed', 1, '{"kind":"managed_sync_import"}'); await request(engine, synced, 'queued', 2);
      const owners = await ownerActivity(engine, [gone, recent, own, unknownYoung, unknownOld, published, synced]);
      expect(owners.get(gone)).toMatchObject({ live: false, stale: true, foreign_file_holder: pglite });
      expect(Date.now() - Date.parse(owners.get(gone)!.last_active!)).toBeGreaterThan(OWNER_STALE_MS);
      expect(owners.get(recent)).toMatchObject({ live: false, stale: pglite });
      expect(owners.get(own)).toMatchObject({ owner_host_id: self, stale: false, foreign_file_holder: false });
      expect(owners.get(unknownYoung)).toMatchObject({ last_active: null, stale: pglite });
      expect(owners.get(unknownOld)).toMatchObject({ last_active: null, stale: true });
      expect(owners.get(published)!.stale).toBe(pglite);
      expect(Date.now() - Date.parse(owners.get(published)!.last_active!)).toBeLessThan(2 * 3_600_000);
      expect(owners.get(synced)!.stale).toBe(pglite);
      expect(Date.now() - Date.parse(owners.get(synced)!.last_active!)).toBeLessThan(2 * 3_600_000);
    }
  }));

  test('the receipt names a stale owner and --accept-pending does not cover it; the owner host receipt and a repo-less write name none', async () => inHome(async () => {
    for (const engine of engines) {
      const owner = randomUUID();
      const gone = await worktree(engine, owner, 48);
      const id = await request(engine, gone, 'queued', 48);
      const dbOnly = await request(engine, null, 'queued', 48);
      const own = await worktree(engine, self, 48);
      const recentId = await request(engine, own, 'queued', 48);
      const rows = [(await getWriteRequestById(engine, id))!, (await getWriteRequestById(engine, dbOnly))!, (await getWriteRequestById(engine, recentId))!];
      const facts = await writeHealthFacts(engine, rows);
      const stale = receiptFor(rows[0]!, facts.get(id));
      expect(stale.diagnostic).toMatchObject({ reason: 'owner_unavailable', next_action: 'inspect_owner' });
      expect(Number.isFinite(Date.parse(stale.diagnostic!.owner!.last_active!))).toBe(true);
      const wire = publicWriteReceipt(stale as never);
      expect(isWriteReceipt(wire)).toBe(true);
      expect(wire.diagnostic?.owner).toBeDefined();
      expect(JSON.stringify(wire)).not.toContain(owner);
      expect(acceptPendingCovers(wire)).toBe(false);
      const pending = (receipt: unknown) => ({ toJSON: () => ({ error: 'write_pending', write_request: receipt }) });
      expect(writeErrorExitCode(pending(wire), true)).toBe(PENDING_WRITE_EXIT_CODE);
      expect(writeErrorExitCode(pending(wire), false)).toBe(PENDING_WRITE_EXIT_CODE);
      const repoLess = publicWriteReceipt(receiptFor(rows[1]!, facts.get(dbOnly)) as never);
      expect(repoLess.diagnostic?.owner).toBeUndefined();
      expect(writeErrorExitCode(pending(repoLess), true)).toBe(0);
      const quiet = publicWriteReceipt(receiptFor(rows[2]!, facts.get(recentId)) as never);
      expect(quiet.diagnostic?.owner).toBeUndefined();
      expect(writeErrorExitCode(pending(quiet), true)).toBe(0);
    }
  }));

  test('Postgres: staleness reads the database clock, so a caller clock days ahead neither stales a recent owner in the receipt nor in doctor', async () => inHome(async () => {
    for (const engine of engines.filter(e => e.kind === 'postgres')) {
      const recent = await worktree(engine, randomUUID(), 1);
      await request(engine, recent, 'queued', 1);
      const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * OWNER_STALE_MS);
      try {
        expect((await ownerActivity(engine, [recent])).get(recent)).toMatchObject({ live: false, stale: false });
        const check = await ownerHostStaleCheck(engine);
        expect((check.details as { stale: { worktree_id: string }[] }).stale.map(row => row.worktree_id)).not.toContain(recent);
      } finally { clock.mockRestore(); }
    }
  }));

  test('Postgres: a live consumer keeps its owner fresh and a clean stop leaves the time it stopped', async () => inHome(async () => {
    for (const engine of engines.filter(e => e.kind === 'postgres')) {
      const owner = randomUUID();
      const tree = await worktree(engine, owner, 48);
      await request(engine, tree, 'queued', 48);
      expect((await ownerActivity(engine, [tree])).get(tree)).toMatchObject({ live: false, stale: true });
      const heartbeat = startConsumerHeartbeat(engine as never, owner, { kind: 'serve', mode: 'full', everyMs: 1_000_000, report: () => ({ restart_required: false, root_barrier_age_ms: null }) });
      await heartbeat.renew();
      expect((await ownerActivity(engine, [tree])).get(tree)).toMatchObject({ live: true, stale: false });
      await heartbeat.stop();
      const after = (await ownerActivity(engine, [tree])).get(tree)!;
      expect(after).toMatchObject({ live: false, stale: false });
      expect(Date.now() - Date.parse(after.last_active!)).toBeLessThan(60_000);
    }
  }));
});
