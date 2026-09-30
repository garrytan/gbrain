import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './shared-skills-engine.ts';
import { withEnv } from './with-env.ts';

export interface ManagedBrain { engine: BrainEngine; ctx: OperationContext; root: string }

/** An activated managed brain whose default source is a claimed worktree; PGLite unless a database URL is given. */
export async function managedBrain(run: (brain: ManagedBrain) => Promise<void>,
  opts: { databaseUrl?: string; setup?: (brain: { engine: BrainEngine; root: string }) => Promise<void> | void } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-brain-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(opts.databaseUrl);
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
