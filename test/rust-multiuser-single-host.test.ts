/**
 * A single host on a multi-user Rust brain (lane L5, frozen interface I-5): a protected call with NO fence is not
 * refused for lacking one. One-shot CLI commands, cycle locks taken outside a consumer, the parity harness and a served
 * caller never register a host lease; with GBRAIN_RUST_MULTIUSER on they used to be refused `lease_lost` /
 * `fence_missing`. The store now takes an implicit lease for an unfenced claim (rust/crates/gbrain-store/src/fence.rs).
 *
 * The mode is turned on inside each test (`withEnv`), because test/helpers/operator-env-preload.ts strips every
 * GBRAIN_* variable that is not on its keep list. No host is registered: `fenceFor(engine)` is null in every case.
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { fenceFor } from '../src/core/persistence/host-fence.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = process.env.GBRAIN_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; build the addon`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let addon: RustAddon | undefined;
const dirs: string[] = [];
const engines: RustEngine[] = [];

async function open(): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const path = mkdtempSync(join(tmpdir(), 'gbrain-rust-single-host-'));
  dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: path });
  expect(fenceFor(engine)).toBeNull();
  return engine;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const REQUEST = 'b0000000-0000-4000-8000-0000000000b1';
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';

/** The calls of the parity case "one request is admitted, read, claimed, locked and completed" (persistence.test.ts). */
async function lifecycle(engine: RustEngine) {
  const source = await engine.readLedgerSource('default');
  expect(source?.incarnation).toMatch(UUID);
  return engine.transaction(async (tx) => {
    await tx.lockPersistenceCounters(KEYS);
    const inserted = await tx.insertWriteRequest({
      principalKind: 'local_cli', principalId: 'parity-writer', requestId: REQUEST, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/parity-example', worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/parity-example' }, authority: { scopes: ['write'] }, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
    const byRequest = await tx.readWriteRequest('local_cli', 'parity-writer', REQUEST);
    const claimed = await tx.stampWriteClaim(inserted.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const lockedRow = await tx.lockWriteRequest(inserted.id);
    const done = await tx.completeWriteRow({
      id: inserted.id, state: 'committed', outcome: { status: 'parity' }, errorCode: null, errorMessage: null, consumerVersion: 'parity',
      consumerHostId: null, errorDetail: null, resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500,
      terminalReservation: 4096, probePurges: true,
    });
    return { inserted, byRequest, claimed, lockedRow, done };
  });
}

describe('a single host on a multi-user brain: protected calls with no fence', () => {
  withAddon('a request is admitted, read, claimed, locked and completed with no host registered', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const result = await lifecycle(engine);
      expect(result.byRequest?.id).toBe(result.inserted.id);
      expect(result.claimed?.state).toBe('running');
      expect(result.lockedRow?.state).toBe('running');
      expect(result.done?.state).toBe('committed');
    });
  });

  withAddon('a job is added, claimed, renewed and completed with no host registered', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const queue = new MinionQueue(engine);
      const job = await queue.add('work', {});
      const claimed = await queue.claim('w:1', 30_000, 'default', ['work']);
      expect(claimed?.id).toBe(job.id);
      expect(await queue.renewLock(job.id, 'w:1', 30_000)).toBe(true);
      expect((await queue.completeJob(job.id, 'w:1'))?.status).toBe('completed');
    });
  });

  withAddon('a cycle lock is acquired, refreshed and released with no host registered', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const handle = await tryAcquireDbLock(engine, 'gbrain-sync:default', 30);
      expect(handle).not.toBeNull();
      expect(await handle!.refresh()).toBe(true);
      await handle!.release();
      expect(await engine.readCycleLocks({ by: 'id', lockId: 'gbrain-sync:default' })).toHaveLength(0);
    });
  });
});
