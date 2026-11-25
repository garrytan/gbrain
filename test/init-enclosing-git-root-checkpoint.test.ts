import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { setupSharedBrainContent } from '../src/core/shared-skills/setup.ts';
import { withEnv } from './helpers/with-env.ts';

const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp(): string { const d = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-enclosing-git-'))); directories.push(d); return d; }

describe('content root inside another Git worktree', () => {
  test('is refused before a checkpoint names it, so --content-root can still be chosen', async () => {
    const parent = temp(), elsewhere = temp();
    spawnSync('git', ['init', '-q', parent]);
    const config = new Map<string, string>();
    const brainId = randomUUID(), incarnation = randomUUID();
    const source = { id: 'default', incarnation, local_path: null };
    const engine = {
      getConfig: async (key: string) => config.get(key) ?? null,
      setConfig: async (key: string, value: string) => { config.set(key, value); },
      executeRaw: async (sql: string) => {
        if (sql.includes('FROM persistence_brain')) return [{ brain_id: brainId, enabled: false, skill_bundles_enabled: false }];
        if (sql.includes('FROM sources')) return [source];
        if (sql.includes('EXISTS(SELECT 1 FROM pages')) return [{ present: false }];
        return [];
      },
    } as unknown as BrainEngine;
    const ctx: OperationContext = { engine, sourceId: 'default', config: { engine: 'pglite' }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    await withEnv({ GBRAIN_HOME: join(parent, 'home'), DATABASE_URL: undefined }, async () => {
      const first = await setupSharedBrainContent(ctx, { fresh: true }).then(() => null, (e: any) => e);
      expect(first?.message).toContain('inside another Git worktree');
      const retry = await setupSharedBrainContent(ctx, { fresh: true, root: join(elsewhere, 'content') }).then(() => null, (e: any) => e);
      expect(retry?.message ?? '').not.toContain('canonical root changed');
      expect(retry?.message ?? '').not.toContain('inside another Git worktree');
    });
  });
});
