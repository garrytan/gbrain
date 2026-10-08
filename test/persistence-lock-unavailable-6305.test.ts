/**
 * #6305: a process that cannot open a worktree's native coordination lock (an
 * unwritable lock directory, a sandbox that denies the lock file) used to fail
 * the write it had claimed, terminally, as storage_error. It now publishes
 * nothing and leaves the request queued for an owner process that can take the
 * lock, the way a busy lock does; the pending receipt says why, the error keeps
 * the OS error behind it, and the process stops claiming that root for a while
 * instead of preparing the same write again on every poll.
 * Runs on PGLite, and on an isolated Postgres database when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite, claimNextWrite, getWriteRequestById, receiptFor } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { NativeLockUnavailableError } from '../src/core/persistence/native-lock.ts';
import { ownerExceptionFailure } from '../src/core/persistence/publication-failure.ts';
import { PHYSICAL_ROOT_MARKER } from '../src/core/persistence/physical-root-record.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type FixtureSource, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-lock-unavailable-'));
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
const hostId = randomUUID();
const brains: Array<{ engine: BrainEngine; config: HarnessConfig; source: FixtureSource }> = [];
let closePostgres: (() => Promise<void>) | undefined;

async function brain(engine: BrainEngine): Promise<void> {
  const root = join(home, engine.kind);
  const config: HarnessConfig = { kind: engine.kind, root, dataDir: join(root, 'data'), hostId,
    seed: 6305, schedules: 0, operations: 0, sourceIds: ['lock-unavailable'], principalIds: [randomUUID()] };
  await initializeFixtures(engine, config);
  const [source] = await fixtures(engine, config);
  brains.push({ engine, config, source: source! });
}

beforeAll(async () => withEnv(env, async () => {
  selectFixtureHost(hostId);
  const local = new PGLiteEngine();
  await local.connect({}); await local.initSchema();
  await brain(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    closePostgres = isolated.close;
    await brain(isolated.engine);
  }
}), 120_000);

afterAll(async () => {
  for (const { engine } of brains) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

/** Ways a process can fail to open the worktree's lock file; each returns the step that makes it openable again. */
const UNOPENABLE = [
  // Windows reports its own system error code for a directory, which the errno table does not name.
  { name: 'a directory stands where the lock file is', slug: 'left-directory', supported: true,
    osError: process.platform === 'win32' ? expect.stringMatching(/^os_error_[1-9]\d*$/) : 'EISDIR',
    block(path: string) {
      const held = existsSync(path) ? `${path}.held` : null;
      if (held) renameSync(path, held);
      mkdirSync(path);
      return () => { rmSync(path, { recursive: true }); if (held) renameSync(held, path); };
    } },
  // Root ignores directory modes, and Windows has none.
  { name: 'the lock directory is not writable', slug: 'left-unwritable', osError: 'EACCES', supported: process.platform !== 'win32' && process.getuid?.() !== 0,
    block(path: string) { rmSync(path, { force: true }); chmodSync(dirname(path), 0o500); return () => chmodSync(dirname(path), 0o700); } },
] as const;

describe('#6305 a process that cannot open the worktree lock', () => {
  for (const way of UNOPENABLE) test.skipIf(!way.supported)(`publication leaves the write queued for an owner that can take the lock (${way.name})`, async () => withEnv(env, async () => {
    for (const { engine, config, source } of brains) {
      const slug = way.slug;
      await admitWrite(engine, admission(config, source, slug, 'kept'));
      const row = (await claimNextWrite(engine, hostId))!;
      const seen: NativeLockUnavailableError[] = [];
      const unblock = way.block(source.binding.coordination_path!);
      let left;
      try { left = await publishMutation(engine, row, prepared(row, [source]), hostId, { lockUnavailable: (_, error) => { seen.push(error); } }); }
      finally { unblock(); }
      expect(left).toMatchObject({ state: 'queued', blocked_reason: 'writer_lock_unavailable', execution_token: null,
        publication_started: false, recovery: null, error_code: null });
      expect(await engine.getPage(slug, { sourceId: source.id })).toBeNull();
      // The pending receipt says an owner has to take the lock: inspect it, not a busy lock to retry under a new request_id.
      expect(receiptFor(left).diagnostic).toMatchObject({ reason: 'writer_lock_unavailable', assessment: 'blocked', next_action: 'inspect_owner' });
      // The OS error stays with the error, in its message and in any owner-side failure detail.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ osError: way.osError });
      expect(seen[0]!.message).toContain(`(${seen[0]!.osError})`);
      expect(ownerExceptionFailure(seen[0]).detail).toMatchObject({ error_class: 'NativeLockUnavailableError', errno: seen[0]!.osError });
      // An owner process that can take the lock publishes the same request.
      const owner = (await claimNextWrite(engine, hostId))!;
      expect(owner.id).toBe(row.id);
      expect(await publishMutation(engine, owner, prepared(owner, [source]), hostId)).toMatchObject({ state: 'committed' });
      expect((await engine.getPage(slug, { sourceId: source.id }))?.compiled_truth).toBe('kept');
    }
  }));

  test('any other refusal while taking the lock is not mistaken for an unopenable lock', async () => withEnv(env, async () => {
    for (const { engine, config, source } of brains) {
      await admitWrite(engine, admission(config, source, 'refused-root', 'refused'));
      const row = (await claimNextWrite(engine, hostId))!;
      const seen: unknown[] = [];
      // A checkout without its ownership marker fails closed with recovery_required (physical-root.ts).
      const marker = join(source.binding.local_path!, PHYSICAL_ROOT_MARKER);
      renameSync(marker, `${marker}.held`);
      let done;
      try { done = await publishMutation(engine, row, prepared(row, [source]), hostId, { lockUnavailable: (_, error) => { seen.push(error); } }); }
      finally { renameSync(`${marker}.held`, marker); }
      expect(done).toMatchObject({ state: 'failed', error_code: 'recovery_required', blocked_reason: null });
      expect(seen).toHaveLength(0);
    }
  }));

  test('a consumer that cannot take the lock prepares the write once, reports why, and leaves the root to an owner that can', async () => withEnv(env, async () => {
    for (const { engine, config, source } of brains) {
      const admitted = await admitWrite(engine, admission(config, source, 'left-by-consumer', 'handed over'));
      let preparations = 0;
      const errors: unknown[] = [];
      const sandboxed = new PersistenceConsumer(engine, { engine: engine.kind }, async (_engine, row) => { preparations++; return prepared(row, [source]); },
        { hostId, pollMs: 25, onError: error => { errors.push(error); } });
      const unblock = UNOPENABLE[0].block(source.binding.coordination_path!);
      try {
        sandboxed.start();
        await waitFor(async () => (await getWriteRequestById(engine, admitted.id))?.blocked_reason === 'writer_lock_unavailable',
          { timeoutMs: 10_000, intervalMs: 25, label: `${engine.kind}: the claimed write is released for another owner` });
        // About twenty polls: the root stays left to another owner instead of being claimed and prepared again.
        await Bun.sleep(500);
        expect(preparations).toBe(1);
        expect(await getWriteRequestById(engine, admitted.id)).toMatchObject({ state: 'queued', blocked_reason: 'writer_lock_unavailable' });
        expect(errors.filter(error => error instanceof NativeLockUnavailableError)).toContainEqual(expect.objectContaining({ osError: UNOPENABLE[0].osError }));
      } finally {
        await sandboxed.stop();
        unblock();
      }
      const owner = new PersistenceConsumer(engine, { engine: engine.kind }, async (_engine, row) => prepared(row, [source]), { hostId, pollMs: 25 });
      try {
        owner.start();
        await waitFor(async () => (await getWriteRequestById(engine, admitted.id))?.state === 'committed',
          { timeoutMs: 10_000, intervalMs: 25, label: `${engine.kind}: an owner that can take the lock publishes the write` });
      } finally { await owner.stop(); }
    }
  }), 45_000);
});
