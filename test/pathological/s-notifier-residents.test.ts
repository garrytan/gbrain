/**
 * GBRA-133 PR 2a.1 / 2a.4: residents. Every resident (serve, serve --http, gbrain jobs work, the autopilot daemon)
 * starts the notifier the same way; one of them owns the host's notifier through the lease (Postgres), and a resident
 * start never waits on git or a catch-up.
 *
 * Protects:
 *  - two residents on one host: exactly one owns; a clean stop releases the lease (expires it now), so the standby
 *    takes over at its first claim afterwards with a new fencing token;
 *  - an owner that dies without releasing (a kill) is taken over at the standby's first claim after the lease expired,
 *    with a new fencing token, and the dead owner's token no longer passes the check made before each start;
 *  - a resident start returns before its first pass (a HEAD read that never answers does not delay it), reads keep
 *    working and report the source as not monitored until the resident has observed it.
 * Recorded claims and DB state only, no wall-clock thresholds. The lease cases run on Postgres (PGLite has no lease:
 * the brain's lock holder owns the notifier); the startup case runs on both.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { startCommitNotifier, type NotifierStore } from '../../src/core/commit-notifier.ts';
import { claimLease, holdsLease, readLease } from '../../src/core/notifier/store.ts';
import { __resetResidentNotifierForTests, residentNotifier, residentNotifierOptions, sqlNotifierStore, startResidentNotifier } from '../../src/core/notifier/resident.ts';
import { readSourceFreshness } from '../../src/core/notifier/status.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { pathologicalArms } from './harness.ts';

const HOST = '00000000-0000-4000-8000-0000000000aa';

async function brain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>) {
  const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
  try { await engine.executeRaw('DELETE FROM sync_notifier_leases WHERE host_id = $1', [HOST]); await run(engine); }
  finally { await engine.executeRaw('DELETE FROM sync_notifier_leases WHERE host_id = $1', [HOST]).catch(() => undefined); await close(); }
}

interface Claim { won: boolean; expiredBefore: boolean }
/** The real SQL store, recording each claim with whether the lease had expired (or was free) when it was attempted. */
function recordingStore(engine: BrainEngine, claims: Claim[], opts: { dropRelease?: boolean } = {}): NotifierStore {
  const store = sqlNotifierStore(engine);
  return {
    ...store,
    claimLease: async (l) => {
      const before = await readLease(engine, l.hostId);
      const r = await store.claimLease(l);
      claims.push({ won: r !== null && r.owner === true, expiredBefore: before === null || !before.live || before.owner_id === l.ownerId });
      return r;
    },
    ...(opts.dropRelease ? { releaseLease: async () => {} } : {}),
  };
}

function resident(engine: BrainEngine, kind: 'serve' | 'jobs-worker', store: NotifierStore, lines: string[]) {
  return startCommitNotifier(residentNotifierOptions(engine, { resident: kind, log: l => lines.push(l), hostId: HOST, heartbeatMs: 200, pollMs: 200,
    store, listSources: async () => [], readFlag: async () => false }));
}
async function until(what: string, fn: () => boolean | Promise<boolean>, lines: string[], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; log: ${JSON.stringify(lines)}`); await Bun.sleep(25); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`notifier residents (${backend})`, () => {
    if (backend === 'postgres') {
      test('one owner per host; a clean stop hands over at the standby\'s first claim afterwards', async () => {
        await brain(databaseUrl, async engine => {
          const lines: string[] = []; const aClaims: Claim[] = []; const bClaims: Claim[] = [];
          const a = resident(engine, 'serve', recordingStore(engine, aClaims), lines);
          await until('the first owner', () => a.owner, lines);
          const b = resident(engine, 'jobs-worker', recordingStore(engine, bClaims), lines);
          await until('the standby to claim twice', () => bClaims.length >= 2, lines);
          expect(a.owner).toBe(true); expect(b.owner).toBe(false);
          expect(bClaims.every(c => !c.won)).toBe(true);
          const firstFence = (await readLease(engine, HOST))!.fence;
          const standbyClaims = bClaims.length;
          await a.stop();
          expect((await readLease(engine, HOST))?.live).toBe(false);
          await until('the standby to take over', () => b.owner, lines);
          expect(bClaims.slice(standbyClaims)[0]).toEqual({ won: true, expiredBefore: true });
          expect((await readLease(engine, HOST))!.resident_kind).toBe('jobs-worker');
          expect((await readLease(engine, HOST))!.fence).toBe(firstFence + 1);
          await b.stop();
        });
      }, 60_000);

      test('an owner killed without releasing is taken over at the first claim after its lease expired; its fence no longer passes', async () => {
        await brain(databaseUrl, async engine => {
          const lines: string[] = []; const aClaims: Claim[] = []; const bClaims: Claim[] = [];
          const a = resident(engine, 'serve', recordingStore(engine, aClaims, { dropRelease: true }), lines);
          await until('the first owner', () => a.owner, lines);
          const deadFence = (await readLease(engine, HOST))!.fence;
          const deadOwner = (await engine.executeRaw<{ owner_id: string }>('SELECT owner_id FROM sync_notifier_leases WHERE host_id=$1', [HOST]))[0]!.owner_id;
          const b = resident(engine, 'jobs-worker', recordingStore(engine, bClaims), lines);
          await until('the standby to claim', () => bClaims.length >= 1, lines);
          await a.stop();
          expect(await readLease(engine, HOST)).not.toBeNull();
          await until('the standby to take over', () => b.owner, lines);
          const firstAfterExpiry = bClaims.findIndex(c => c.expiredBefore);
          expect(firstAfterExpiry).toBeGreaterThanOrEqual(0);
          expect(bClaims[firstAfterExpiry]!.won).toBe(true);
          expect(bClaims.slice(0, firstAfterExpiry).every(c => !c.won)).toBe(true);
          const lease = (await readLease(engine, HOST))!;
          expect(lease.fence).toBe(deadFence + 1);
          expect(await holdsLease(engine, HOST, deadOwner, deadFence)).toBe(false);
          const stale = await claimLease(engine, { hostId: HOST, ownerId: deadOwner, kind: 'serve', pid: 1, leaseMs: 60_000 });
          expect(stale.owner).toBe(false);
          await b.stop();
        });
      }, 60_000);
    }

    test('a resident start returns before its first pass; reads keep working and say not_monitored until it observes', async () => {
      await brain(databaseUrl, async engine => {
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('acme-example','acme-example','/nonexistent/acme-example','{}') ON CONFLICT (id) DO NOTHING");
        await engine.executeRaw('INSERT INTO sync_notifier_sources (source_id, syncer_host_id) VALUES ($1, $2) ON CONFLICT (source_id) DO UPDATE SET syncer_host_id = EXCLUDED.syncer_host_id', ['acme-example', HOST]);
        await engine.setConfig('sync.on_commit', 'true');
        __resetResidentNotifierForTests();
        let revParses = 0;
        const lines: string[] = [];
        const started = startResidentNotifier(engine, { resident: 'autopilot', log: l => lines.push(l), hostId: HOST, readFlag: async () => true,
          listSources: async () => [{ sourceId: 'acme-example', root: '/nonexistent/acme-example', gitDir: null, lastCommit: null, kind: 'classic' as const }],
          revParse: () => { revParses++; return new Promise<string>(() => {}); } });
        try {
          expect(started).not.toBeNull();
          expect(residentNotifier()?.resident).toBe('autopilot');
          const fresh = await readSourceFreshness(engine, { sourceId: 'acme-example' });
          expect(fresh).toEqual([expect.objectContaining({ source_id: 'acme-example', state: 'not_monitored' })]);
          await until('the background first pass to ask for HEAD', () => revParses > 0, lines);
          expect((await readSourceFreshness(engine, { sourceId: 'acme-example' }))[0]!.state).toBe('not_monitored');
        } finally { await started?.stop(); __resetResidentNotifierForTests(); await engine.executeRaw("DELETE FROM sources WHERE id='acme-example'"); await engine.setConfig('sync.on_commit', 'false'); }
      });
    }, 60_000);
  });
}
