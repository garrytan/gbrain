import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { testWaitMs } from './wait-for.ts';
import { isolatedSharedSkillsEngine } from './shared-skills-engine.ts';
import { withEnv } from './with-env.ts';

export interface ManagedBrain { engine: BrainEngine; ctx: OperationContext; root: string }

/**
 * An activated managed brain whose default source is a claimed worktree; PGLite unless a database URL is given.
 * `open` supplies the migrated engine instead, e.g. a clone of a per-file Postgres template, so each test skips the migrations.
 */
export async function managedBrain(run: (brain: ManagedBrain) => Promise<void>,
  opts: { databaseUrl?: string; open?: () => Promise<{ engine: BrainEngine; close(): Promise<void> }>; setup?: (brain: { engine: BrainEngine; root: string }) => Promise<void> | void } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-brain-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await (opts.open ?? (() => isolatedSharedSkillsEngine(opts.databaseUrl)))();
      try {
        const root = join(home, 'content'); mkdirSync(root);
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await opts.setup?.({ engine, root });
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default',
          remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await run({ engine, ctx, root });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/**
 * Runs queued effects (and waits for the consumer's) until no Git effect of the source is open, so a fixture that edits
 * the checkout next starts from pages whose files are committed. A put returns once its row commits; its Git publication
 * lands later, and `disposePersistenceConsumer` right after the put can leave the file untracked: a working-tree-only
 * page, which a later full pass deletes once its file is gone (a different case from a page whose file left Git's checkout).
 */
export async function settleManagedGitEffects(engine: BrainEngine, sourceId = 'default'): Promise<void> {
  const deadline = performance.now() + testWaitMs(30_000);
  for (;;) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const open = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='git' AND state<>'committed'", [sourceId]);
    if (!open.length) return;
    if (performance.now() > deadline) throw new Error(`${open.length} Git effect(s) of ${sourceId} still open after the wait`);
    await Bun.sleep(50);
  }
}
