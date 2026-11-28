/**
 * The reviewed shared-skill activation on a Rust brain checks the reviewed admin state and writes the activation flag
 * with no other write between them (src/core/persistence/skill-activation.ts activateOnRust).
 *
 * 1. Protects: a topology write another async context starts after the reviewed state was read cannot commit before the
 *    activation does, so the state the operator reviewed is the state activation acted on; a process that is only a
 *    client of the brain's owner is refused owner_unavailable and changes nothing.
 * 2. Fails on: the re-check and the flag write running outside one explicit transaction (the source write then
 *    commits while activation waits between them), or a client run that activates or refuses another code.
 * 3. Existing coverage: test/engine-parity/shared-skill-adoption.test.ts runs the reviewed activation and a stale state
 *    sequentially on every arm; nothing contests the gap.
 * 4. Seam: readWriterAdminState inside the transaction waits on a gate the test releases. Runs with the Rust arm
 *    (GBRAIN_TEST_RUST_ARM=1) on a real store.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustArmAddon, openRustBrain, removeBrainDir, rustArmRequested, type RustBrainDir } from './engine-parity/rust-arm.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../src/core/persistence/admin-contract.ts';
import { registerServeLocalWriters } from '../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { rustPublicationFlag } from '../src/core/shared-skills/rust-publication.ts';

describe.skipIf(!rustArmRequested())('the reviewed activation on a Rust brain serializes its state check with its flag write', () => {
  let brain: RustBrainDir;
  let engine: BrainEngine;
  let home: string;
  let rootA: string;
  let rootB: string;
  beforeAll(async () => {
    brain = await openRustBrain();
    engine = brain.engine as unknown as BrainEngine;
    home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-rust-activation-home-')));
    rootA = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-rust-activation-a-')));
    rootB = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-rust-activation-b-')));
  }, 60_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    removeBrainDir(brain.dir);
    for (const dir of [home, rootA, rootB]) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  // Value: protects=a client of the Rust owner never activates; fails_when=the client activates or refuses another code; why_new=no test activated from a client; seam=a second engine on the same brain directory is the owner's client; no_claim=PGLite has no client mode
  test('a second engine on the brain is its owner\'s client and is refused owner_unavailable, with nothing changed', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.attachSourcePath('default', rootA);
      const reviewed = await writerAdminState(engine);
      const client = openRustEngine({ addon: await loadRustArmAddon(), databasePath: brain.dir });
      await client.connect({ engine: 'pglite', database_path: brain.dir } as never);
      try {
        expect(client.ownerRole).toBe('client');
        let refusal: { code?: string } | null = null;
        await activateSharedSkillPersistence(client as unknown as BrainEngine, { confirmQuiesced: true, expectedState: reviewed })
          .catch((error: { code?: string }) => { refusal = error; });
        expect(refusal).toMatchObject({ code: 'owner_unavailable' });
      } finally { await client.disconnect(); }
      expect({ state: await writerAdminState(engine), flag: await rustPublicationFlag(engine) })
        .toEqual({ state: reviewed, flag: { skill_bundles_enabled: false, writer_protocol_floor: 1 } });
    }), 60_000);

  // Value: protects=the operator's writer-admin lock is read inside the activation transaction on Rust; fails_when=a locked brain activates; why_new=the lock was checked only before the transaction; seam=the lock is set before the direct call, which skips the CLI pre-check; no_claim=none
  test('a locked writer administration refuses writer_admin_locked inside the transaction, with nothing changed', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.attachSourcePath('default', rootA);
      await engine.setConfig(WRITER_ADMIN_LOCK_KEY, JSON.stringify({ locked: true, set_at: null, host_id: null, generation: 1 }));
      try {
        const reviewed = await writerAdminState(engine);
        let refusal: { code?: string } | null = null;
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true, expectedState: reviewed }).catch((error: { code?: string }) => { refusal = error; });
        expect({ refusal: (refusal as { code?: string } | null)?.code, flag: await rustPublicationFlag(engine) })
          .toEqual({ refusal: 'writer_admin_locked', flag: { skill_bundles_enabled: false, writer_protocol_floor: 1 } });
      } finally {
        await engine.setConfig(WRITER_ADMIN_LOCK_KEY, JSON.stringify({ locked: false, set_at: null, host_id: null, generation: 2 }));
      }
    }), 60_000);

  // Value: protects=no write lands between the reviewed-state re-check and the activation write on Rust; fails_when=the re-check and the write run outside one explicit transaction; why_new=no test contested that gap; seam=a gate inside the transaction's admin-state read; no_claim=multi-user Rust (optimistic transactions, G1)
  test('a source write started during the re-check waits until activation commits', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.attachSourcePath('default', rootA);
      await registerServeLocalWriters(engine);
      const reviewed = await writerAdminState(engine);
      let reached!: () => void;
      const atCheck = new Promise<void>(resolve => { reached = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const read = engine.readWriterAdminState;
      // Only the read inside activation's transaction (a transaction-bound clone, not the engine itself) waits.
      Object.assign(engine, { async readWriterAdminState(this: BrainEngine, ...args: unknown[]) {
        if (this !== engine) { reached(); await gate; }
        return (read as (...a: unknown[]) => Promise<string>).apply(this, args);
      } });
      try {
        const order: string[] = [];
        const activation = activateSharedSkillPersistence(engine, { confirmQuiesced: true, expectedState: reviewed })
          .then(result => { order.push('activation'); return result; });
        await atCheck;
        let attached = false;
        const write = engine.attachSourcePath('default', rootB).then(() => { attached = true; order.push('source write'); });
        await Bun.sleep(300);
        const attachedDuringCheck = attached;
        release();
        const result = await activation;
        await write;
        const source = await engine.readSourceState('default');
        expect({ attachedDuringCheck, order, activated: result.activated, flag: await rustPublicationFlag(engine), localPath: source?.local_path })
          .toEqual({ attachedDuringCheck: false, order: ['activation', 'source write'], activated: true,
            flag: { skill_bundles_enabled: true, writer_protocol_floor: 2 }, localPath: rootB });
      } finally {
        Object.assign(engine, { readWriterAdminState: read });
        release();
      }
    }), 60_000);
});
