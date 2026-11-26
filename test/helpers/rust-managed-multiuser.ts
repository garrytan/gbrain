/**
 * A claimed, activated Git checkout on a real multi-user Rust brain (lane LM slice 3): the shared setup of the managed
 * multi-user caller, fairness and fencing tests. Needs the Rust addon (GBRAIN_TEST_RUST_ARM=1). The process holds no
 * registration of its own seeding: the first managed lock or consumer registers it (managed-registration.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustSource, openRustBrain, removeBrainDir, type RustBrainDir } from '../engine-parity/rust-arm.ts';
import { liftManagedHold } from '../engine-parity/rust-managed.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEnv } from './with-env.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { hostIdFor } from '../../src/core/persistence/identity.ts';
import type { WorktreeBinding } from '../../src/core/persistence/ownership.ts';

export interface ManagedMultiuserBrain {
  brain: RustBrainDir;
  engine: BrainEngine;
  home: string;
  root: string;
  /** Runs `run` with the scratch GBRAIN_HOME and the multi-user switch set, as the brain was opened. */
  env<T>(run: () => Promise<T>): Promise<T>;
  reviewed(operation: string): Promise<{ admin_intent: string; expected_state: string }>;
  binding(): Promise<WorktreeBinding>;
  close(): Promise<void>;
}

export async function openManagedMultiuserBrain(opts: { activate?: boolean; source?: string } = {}): Promise<ManagedMultiuserBrain> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-mu-')));
  const source = opts.source ?? 'work';
  const env = <T>(run: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_MULTIUSER: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, run);
  const brain = await env(async () => {
    const opened = await openRustBrain('env');
    liftManagedHold(opened.engine);
    return opened;
  });
  const engine = brain.engine as unknown as BrainEngine;
  const root = join(home, 'checkout');
  const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
  await env(async () => {
    mkdirSync(join(root, 'notes'), { recursive: true });
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
    writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
    await createRustSource(brain.engine, source, {}, root);
    await runPersistenceAdministration(engine, 'writer_claim', { source_id: source, path: root, ...await reviewed('writer_claim') });
    if (opts.activate) await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
  });
  return {
    brain, engine, home, root, env, reviewed,
    binding: () => env(async () => (await engine.getWorktreeBinding(source, hostIdFor(engine)))!),
    close: async () => {
      await env(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
      removeBrainDir(brain.dir);
      rmSync(home, { recursive: true, force: true });
    },
  };
}
