/**
 * Engine parity for `gbrain sources writer status` (persistence/administration.ts `writer_status`): the CLI prints the
 * status as `JSON.stringify(result, bigintToStringReplacer, 2)`, so every engine must print the same text once the
 * values that differ by nature (ids each brain mints, clocks, this process) are replaced by placeholders.
 *
 * The status reads its row sets through typed BrainEngine members (engine-sql/writer-status.ts, and on the Rust engine
 * store-members/writer-status.ts); the stalled catch-ups, the parked groups and the source movement are typed too. So:
 *   - the first case composes the status from every read but those three, and the text must be equal on every arm;
 *   - the second case runs the whole status; the text is equal on every arm apart from the movement list, which a Rust
 *     brain leaves empty (it keeps no persistence binding row) and the SQL arms fill; each arm is checked against its own.
 *
 * The fixture claims a checkout with the internal claimWorktree (the automatic claim of a first write), takes the
 * operator lock, and registers sources `a-c` and `ab`, which sort
 * `a-c` first in byte order and `ab` first in the en_US collation the Postgres test server can have.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { bigintToStringReplacer } from '../../src/core/utils.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { readWriterDiagnostics } from '../../src/core/persistence/diagnostics.ts';
import { existingHostIdFor } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { writerOnboardingPreflight } from '../../src/core/persistence/onboarding.ts';
import { inspectPersistenceBrain, readSharedSkillsState } from '../../src/core/persistence/managed-mode.ts';
import { readWriterAdminLockTyped, setWriterAdminLock } from '../../src/core/persistence/admin-lock.ts';
import { listBlockingEffects } from '../../src/core/persistence/blocking-effects.ts';
import { listWriterVersions } from '../../src/core/persistence/writer-versions.ts';
import { activeWorktreeRefreshes } from '../../src/core/persistence/worktree-refresh.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readTopologyRecoveryStops } from '../../src/core/persistence/topology-stop.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
/** Keys whose values are this process, this clock or a brain-minted digest. */
const VOLATILE = new Set(['pid', 'nonce', 'age_ms', 'oldest_age_ms', 'admin_state', 'incarnation', 'source_incarnation', 'started_at',
  'uptime_ms', 'heartbeat_age_ms', 'expected_state', 'version', 'build', 'sampled_at',
  // Set by the engine kind, not read from the brain: one publication lane on PGLite and Rust, and the PGLite page ceiling
  // under an unset worktree recovery budget (persistence/pool-capacity.ts, limits.ts).
  'publication_concurrency', 'worktreeRecoveryBytes']);

/** The status with every volatile value replaced, printed as the CLI prints it. */
function printed(status: unknown, home: string): string {
  const ids = new Map<string, string>();
  const scrub = (value: unknown, key: string): unknown => {
    if (VOLATILE.has(key) && value !== null && value !== undefined) return `<${key}>`;
    if (value instanceof Date) return '<time>';
    if (typeof value === 'string') {
      if (TIME.test(value)) return '<time>';
      return value.split(home).join('$HOME').replace(UUID, id => { if (!ids.has(id)) ids.set(id, `<id-${ids.size + 1}>`); return ids.get(id)!; });
    }
    if (Array.isArray(value)) return value.map(v => scrub(v, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
    return value;
  };
  const plain = JSON.parse(JSON.stringify(status, bigintToStringReplacer)) as Record<string, unknown>;
  // PGLite's host report says why it keeps no heartbeat rows (consumer-diagnostics.ts); the other engines have none to explain.
  if (plain.host && typeof plain.host === 'object') delete (plain.host as Record<string, unknown>).scope;
  const text = JSON.stringify(scrub(plain, ''), null, 2);
  return text;
}

/** Runs `run` with a scratch GBRAIN_HOME, sources `a-c`, `ab` and a claimed checkout `work`, and the operator lock held. */
async function withClaimedCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (home: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-writer-status-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      await Bun.write(join(root, 'example.md'), 'generic example');
      for (const id of ['ab', 'a-c']) await createSource(engine, backend, id, { kind: 'notes' });
      await createSource(engine, backend, 'work', {}, root);
      try {
        await claimWorktree(engine, 'work', root);
        await setWriterAdminLock(engine, true);
        return await run(home);
      } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('writer status', () => {
  parityTest('prints the same status on every engine from its typed reads', {
    methods: ['readWriterDiagnosticRows', 'readWriterStatusRows', 'listOnboardingSources', 'listBlockingEffectRows',
      'listActiveWorktreeRefreshRows', 'readCycleLocks', 'listTopologyRecoveries'],
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (home) => {
    const hostId = existingHostIdFor(engine);
    const { bindings, topology_requests } = await engine.readWriterStatusRows(hostId, null);
    const adminLock = await readWriterAdminLockTyped(engine);
    const mode = await inspectPersistenceBrain(engine);
    const status = { ...await readWriterDiagnostics(engine), mode: !mode.row ? 'unknown' : mode.row.enabled ? 'managed' : 'classic',
      host_id: hostId, bindings,
      admin_lock: { locked: adminLock.locked, set_at: adminLock.set_at, host_id: adminLock.host_id },
      blocking_effects: await listBlockingEffects(engine, { limit: 20 }),
      writer_versions: await listWriterVersions(engine),
      onboarding: await writerOnboardingPreflight(engine, undefined),
      shared_skills: await readSharedSkillsState(engine),
      worktree_refreshes: await activeWorktreeRefreshes(engine, undefined),
      topology_requests,
      topology_recoveries: await readTopologyRecoveryStops(engine, hostId) };
    expect(status.topology_recoveries).toEqual({ recovering: [], more: false, stop: null });
    expect(bindings.map(b => [b.source_id, b.local_path === null ? null : 'set', b.git_durability_state])).toEqual([['work', 'set', 'unknown']]);
    expect(adminLock.locked).toBe(true);
    const ids = status.onboarding.sources.map(s => s.source_id);
    expect(ids.indexOf('a-c')).toBeLessThan(ids.indexOf('ab'));
    return printed(status, home);
  }));

  parityTest('answers each writer status read the same way when called directly', {
    methods: ['readWriterDiagnosticRows', 'listOnboardingSources', 'listBlockingEffectRows', 'listActiveWorktreeRefreshRows'],
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async () => {
    const diagnostics = await engine.readWriterDiagnosticRows(null, []);
    const badCutoff = await engine.readWriterDiagnosticRows('not a time', []).then(() => false, () => true);
    const onboarding = await engine.listOnboardingSources('a-c');
    const answers = {
      diagnostics_sets: Object.keys(diagnostics).sort(),
      bad_cutoff_refused: badCutoff,
      onboarding: onboarding.map(row => [row.id, row.local_path]),
      blocking: await engine.listBlockingEffectRows(null, 5, false),
      refreshes: await engine.listActiveWorktreeRefreshRows(null),
    };
    expect(answers).toEqual({ diagnostics_sets: ['blockers', 'counters', 'effects', 'failures', 'queue', 'worktrees'],
      bad_cutoff_refused: true, onboarding: [['a-c', null]], blocking: [], refreshes: [] });
    return answers;
  }));

  parityTest('prints the same whole status on every engine that reads it', {
    methods: ['readWriterDiagnosticRows', 'readWriterStatusRows'],
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (home) => {
    const status = await runPersistenceAdministration(engine, 'writer_status', {}) as Record<string, unknown>;
    expect(Object.keys(status)).toEqual(expect.arrayContaining(['stalled_catchups', 'parked_groups', 'movement', 'bindings', 'onboarding']));
    // The catch-up and parked-group reads are typed members the store serves. The movement read lists the sources a
    // persistence binding names (the claim's binding, which a Rust brain keeps too); its sampled times differ between
    // runs, so the movement is compared by source and state and the rest of the status must be equal.
    const { movement, ...rest } = status;
    const moved = Array.isArray(movement) ? (movement as Array<{ source_id: string; movement_state: string }>).map(m => [m.source_id, m.movement_state]) : null;
    expect({ arm: backend, listed: moved?.length ?? null }).toEqual({ arm: backend, listed: 1 });
    return { movement: moved, rest: printed(rest, home) };
  }));
});
