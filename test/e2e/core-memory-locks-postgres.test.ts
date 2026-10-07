/**
 * Always-loaded core writes on Postgres: the core lock order (core-guard.ts:
 * the protocol declaration's `persistence_brain` FOR SHARE first, then the worktree ownership check,
 * then `sources` rows FOR UPDATE in id order, own source plus `default`,
 * then the authority FOR SHARE and the counter locks) never deadlocks with
 * core writes in another source, non-core writes in `default`, a concurrent
 * source topology change, or a worktree claim (brain row, then source row,
 * both FOR UPDATE). Every write commits or is refused by a business rule;
 * none fails with a deadlock (40P01).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase } from './helpers.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { listCorePages } from '../../src/core/core-memory.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
const page = (title: string, body: string, core: boolean) => `---\ntitle: ${title}\ntype: note\n${core ? 'always_load: true\n' : ''}---\n\n${body}\n`;

async function writer(engine: BrainEngine) {
  const reg = await registerLocalWriter(engine, 'cli');
  return async (sourceId: string, slug: string, content: string) => {
    const response = await withVerifiedLocalRegistration(engine, reg, () => dispatchToolCall(engine, 'put_page', { slug, content, request_id: randomUUID(), source_id: sourceId }, {
      remote: false, config: { engine: 'postgres' }, sourceId, logger: { info() {}, warn() {}, error() {} },
    }));
    const text = (response.content[0] as { text: string }).text;
    return { isError: response.isError === true, text };
  };
}

// topologyTransaction takes publication capacity without waiting and throws the retryable
// writer_pool_capacity when the concurrent writes hold every slot; a caller retries it.
async function retryOnPoolCapacity<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string }).code !== 'writer_pool_capacity' || attempt >= 40) throw error;
      await new Promise(r => setTimeout(r, 50 * Math.min(attempt, 10)));
    }
  }
}

describeE2E('core memory ordered source lock (Postgres)', () => {
  test('core writes in two sources, non-core writes in default and a topology change interleave without deadlock', () => managedBrain(async ({ engine, root }) => {
    const alphaPath = join(root, '..', 'alpha'); mkdirSync(alphaPath);
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'alpha', path: alphaPath });
    const put = await writer(engine);
    const writes: Array<Promise<{ isError: boolean; text: string }>> = [];
    for (let i = 0; i < 6; i++) {
      writes.push(put('default', `core/d${i}`, page(`D${i}`, `default core ${i}`, true)));
      writes.push(put('alpha', `core/a${i}`, page(`A${i}`, `alpha core ${i}`, true)));
      writes.push(put('default', `notes/n${i}`, page(`N${i}`, `plain ${i}`, false)));
    }
    const probe = join(root, '..', 'probe'); mkdirSync(probe);
    const topology = (async () => {
      await retryOnPoolCapacity(() => runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'probe', path: probe }));
      return retryOnPoolCapacity(() => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'probe', confirmDestructive: true }));
    })();
    const results = await Promise.all(writes);
    await topology;
    const deadlocks = results.filter(r => /deadlock|40P01/i.test(r.text));
    expect(deadlocks).toEqual([]);
    const failed = results.filter(r => r.isError);
    // Retryable lock-timeout refusals are allowed under contention; every other outcome is a commit.
    for (const f of failed) expect(f.text).toMatch(/lock_timeout|lock timeout|write_pending|owner_unavailable|source_changed/i);
    const core = (await listCorePages(engine)).map(p => `${p.source_id}:${p.slug}`);
    const committedCore = results.filter((r, i) => !r.isError && i % 3 !== 2).length;
    expect(core.length).toBe(committedCore);
  }, { databaseUrl: process.env.DATABASE_URL }), 240_000);

  test('a core write and a worktree-claim-shaped transaction (brain row, then source row, both FOR UPDATE) never deadlock', () => managedBrain(async ({ engine }) => {
    const put = await writer(engine);
    await put('default', 'core/seed', page('Seed', 'seed core', true));
    let claim: Promise<void> | null = null;
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:prepared' || claim) return;
      let brainHeld!: () => void;
      const held = new Promise<void>(r => { brainHeld = r; });
      claim = engine.transaction(async tx => {
        await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
        brainHeld();
        await new Promise(r => setTimeout(r, 300));
        await tx.executeRaw("SELECT id FROM sources WHERE id='default' FOR UPDATE NOWAIT");
      });
      await held;
    });
    try {
      const result = await put('default', 'core/during-claim', page('During', 'core during a claim', true));
      expect(claim).not.toBeNull();
      await claim;
      expect(result.text).not.toMatch(/deadlock|40P01/i);
      expect(result.isError).toBe(false);
    } finally {
      installFaultHook(undefined);
    }
  }, { databaseUrl: process.env.DATABASE_URL }), 120_000);
});
