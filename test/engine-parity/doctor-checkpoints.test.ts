/**
 * BrainEngine parity: the doctor checkpoint reads of engine-sql/doctor-checkpoints.ts, which doctor checks and the
 * readers they share used to run through `engine.executeRaw` over `op_checkpoints` and `ingest_log`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts). The relations a Rust brain has no writer for (every op_checkpoints
 *    operation except doctor last-known, including the credential re-chunk holds) read as the empty brain on every arm; the ingest-log reads, the last-known pair
 *    and the sync-admission setting are seeded through the engine's own writers.
 *  - Regression: an engine whose read drifts (or does not serve it) gives a different doctor status or message per backend.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { SYNC_ADMISSION_KEY, SYNC_ADMISSION_SETTING_PARAMS } from '../../src/core/persistence/sync-admission.ts';
import { CREDENTIAL_RESEAL_PRODUCER } from '../../src/core/page-state/credential-reseal.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const LAST_KNOWN_OP = 'doctor-last-known';

async function absorb(engine: BrainEngine, source_id: string, summary: string, source_type = 'facts:absorb'): Promise<void> {
  await engine.logIngest({ source_id, source_type, source_ref: 'ref', pages_updated: [], summary });
}

describe('doctor checkpoint reads', () => {
  parityTest(
    'the op_checkpoints reads find no row on a brain nothing has written to',
    { methods: ['listFenceCandidateRecords', 'listDerivedOriginParks', 'listPurgeParks', 'readSoakCounterRows',
      'listUnfinishedManagedSyncCursors', 'listManagedSyncPassStops', 'listManagedSyncBacklogHeaders', 'readManagedSyncPassRow',
      'listLiveManagedSyncPassRows', 'listCheckpointBlockedSources', 'listOpenIdentityDowngrades', 'listHeldManagedAtomRows',
      'readDoctorLastKnown', 'listCredentialResealHoldRows'] },
    async (engine) => {
      const empty = {
        fence: await engine.listFenceCandidateRecords('fence-candidate'),
        fenceScoped: await engine.listFenceCandidateRecords('fence-candidate', ['default']),
        derived: await engine.listDerivedOriginParks('derived-origin-park'),
        purge: await engine.listPurgeParks('purge-deleted-park'),
        soak: await engine.readSoakCounterRows('sync-soak-counters', ['2026-11-19', '2026-11-18']),
        cursors: await engine.listUnfinishedManagedSyncCursors(),
        stops: await engine.listManagedSyncPassStops(),
        stopsScoped: await engine.listManagedSyncPassStops(['default']),
        headers: await engine.listManagedSyncBacklogHeaders(),
        passRow: await engine.readManagedSyncPassRow('managed-sync-pass', 'default:1'),
        livePasses: await engine.listLiveManagedSyncPassRows('managed-sync-pass'),
        blocked: await engine.listCheckpointBlockedSources(['default']),
        downgrades: await engine.listOpenIdentityDowngrades('sync-identity-downgrade'),
        held: await engine.listHeldManagedAtomRows(undefined, 'storage'),
        lastKnown: await engine.readDoctorLastKnown(LAST_KNOWN_OP),
        resealHolds: await engine.listCredentialResealHoldRows(CREDENTIAL_RESEAL_PRODUCER),
        resealHoldsScoped: await engine.listCredentialResealHoldRows(CREDENTIAL_RESEAL_PRODUCER, ['default']),
      };
      expect(empty).toEqual({
        fence: [], fenceScoped: [], derived: [], purge: [], soak: [], cursors: [], stops: [], stopsScoped: [], headers: [],
        passRow: null, livePasses: [], blocked: [], downgrades: [], held: [], lastKnown: [], resealHolds: [], resealHoldsScoped: [],
      });
      return empty;
    },
  );

  parityTest(
    'doctor last-known rows read back what was written, and a later write replaces the entry',
    { methods: ['writeDoctorLastKnown', 'readDoctorLastKnown'] },
    async (engine) => {
      await engine.writeDoctorLastKnown(LAST_KNOWN_OP, []);
      const none = await engine.readDoctorLastKnown(LAST_KNOWN_OP);
      await engine.writeDoctorLastKnown(LAST_KNOWN_OP, [
        { entry: 'connectors', value: { checks: [{ name: 'connectors', status: 'ok', message: 'fine' }], measured_at: '2026-11-19T10:00:00.000Z', elapsed_ms: 12, emits: ['connectors'] } },
        { entry: 'queue', value: { measured_at: '2026-11-19T10:00:01.000Z', elapsed_ms: 3, checks: [] } },
      ]);
      await engine.writeDoctorLastKnown('another-op', [{ entry: 'queue', value: { checks: [], measured_at: 'other', elapsed_ms: 0 } }]);
      const sorted = async () => (await engine.readDoctorLastKnown(LAST_KNOWN_OP)).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
      const first = await sorted();
      await engine.writeDoctorLastKnown(LAST_KNOWN_OP, [{ entry: 'queue', value: { measured_at: '2026-11-19T11:00:00.000Z', elapsed_ms: 5, checks: [] } }]);
      const replaced = await sorted();
      expect(none).toEqual([]);
      expect(first.map((row) => row.fingerprint)).toEqual(['connectors', 'queue']);
      expect(replaced.map((row) => (row.entry as { measured_at: string }).measured_at)).toEqual(['2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00.000Z']);
      // The key order of a stored value is the jsonb order (length, then bytes) on every engine.
      return { none, first: JSON.stringify(first), replaced: JSON.stringify(replaced) };
    },
  );

  parityTest(
    'the latest connector receipt is the newest connector row, and null with none',
    { methods: ['logIngest', 'readLatestConnectorReceipt'] },
    async (engine) => {
      const none = await engine.readLatestConnectorReceipt();
      await absorb(engine, 'default', 'synced 3', 'connector');
      await absorb(engine, 'default', 'synced 4 DRIFT: 2 skipped', 'connector');
      await absorb(engine, 'default', 'imported 9', 'markdown');
      const latest = await engine.readLatestConnectorReceipt();
      expect({ none, latest }).toEqual({ none: null, latest: 'synced 4 DRIFT: 2 skipped' });
      return { none, latest };
    },
  );

  parityTest(
    'facts-absorb failure groups count the last 24 hours by source and reason',
    { methods: ['logIngest', 'listFactsAbsorbFailureGroups'] },
    async (engine) => {
      const none = await engine.listFactsAbsorbFailureGroups();
      await absorb(engine, 'work', 'timeout: a');
      await absorb(engine, 'default', 'timeout: b');
      await absorb(engine, 'default', 'timeout: c');
      await absorb(engine, 'default', 'parse_error');
      await absorb(engine, 'default', 'timeout: not an absorb row', 'markdown');
      const groups = await engine.listFactsAbsorbFailureGroups();
      const now = Date.now();
      for (const group of groups) {
        const age = now - new Date(group.newest).getTime();
        expect(age).toBeGreaterThanOrEqual(-60_000);
        expect(age).toBeLessThan(60_000);
      }
      const counts = groups.map((group) => ({ source_id: group.source_id, reason: group.reason, n: Number(group.n) }));
      expect({ none, counts }).toEqual({ none: [], counts: [
        { source_id: 'default', reason: 'timeout', n: 2 },
        { source_id: 'default', reason: 'parse_error', n: 1 },
        { source_id: 'work', reason: 'timeout', n: 1 },
      ] });
      return { none, counts };
    },
  );

  parityTest(
    'the sync-admission setting row carries the config value and no dating row until one is written',
    { methods: ['setConfig', 'readSyncAdmissionSettingRow'] },
    async (engine) => {
      const unset = await engine.readSyncAdmissionSettingRow(...(SYNC_ADMISSION_SETTING_PARAMS as [string, string, string]));
      await engine.setConfig(SYNC_ADMISSION_KEY, 'open');
      const stored = await engine.readSyncAdmissionSettingRow(...(SYNC_ADMISSION_SETTING_PARAMS as [string, string, string]));
      expect({ unset, stored }).toEqual({
        unset: { stored: null, row_value: null, set_at: null },
        stored: { stored: 'open', row_value: null, set_at: null },
      });
      return { unset, stored };
    },
  );
});
