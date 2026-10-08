/**
 * Phase 4.1-4.4 on Postgres: a single put_page published as a group of one,
 * the pre-admission cache and their kill switches. Each case runs on a fresh
 * activated managed brain (test/helpers/managed-brain.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasDatabase } from './helpers.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { persistenceHome, revokeLocalWriter } from '../../src/core/persistence/identity.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { tryAcquireNativeLock, type NativeLockHandle } from '../../src/core/persistence/native-lock.ts';

const d = hasDatabase() ? describe : describe.skip;
const url = () => process.env.DATABASE_URL!;
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const put = (ctx: OperationContext, slug: string, body: string, extra: Record<string, unknown> = {}, waitMs = 20_000) =>
  submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: page(slug, body), ...extra }, waitMs }) as Promise<Record<string, any>>;
const failure = (run: Promise<unknown>) => run.then(() => null, (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }));

/** Counts statements this engine sends whose text contains `fragment`. */
function countStatements(engine: BrainEngine, fragment: string): { count: () => number; restore: () => void } {
  const proto = Object.getPrototypeOf(engine) as { executeRaw: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const original = proto.executeRaw;
  let n = 0;
  proto.executeRaw = function (this: unknown, sql: string, ...rest: unknown[]) {
    if (typeof sql === 'string' && sql.replace(/\s+/g, ' ').includes(fragment)) n++;
    return original.call(this, sql, ...rest);
  };
  return { count: () => n, restore: () => { proto.executeRaw = original; } };
}
const GROUP_COMPLETION = "UPDATE persistence_requests r SET state='committed'";
const SOURCE_READ = "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1";

afterEach(() => { installFaultHook(undefined); resetWriteSwitches(); });

d('single page writes on Postgres (Phase 4.1-4.4)', () => {
  test('a put_page file write publishes as a group of one; GBRAIN_SINGLE_WRITE_GROUP=0 and persistence.single_write_group=false restore publishMutation', async () => {
    await managedBrain(async ({ engine, ctx, root }) => {
      const groups = countStatements(engine, GROUP_COMPLETION);
      try {
        expect((await put(ctx, 'notes/fast', 'Fast path.')).state).toBe('committed');
        expect(groups.count()).toBe(1);
        expect(readFileSync(join(root, 'notes/fast.md'), 'utf8')).toContain('Fast path.');
        await withEnv({ GBRAIN_SINGLE_WRITE_GROUP: '0' }, async () => {
          resetWriteSwitches();
          expect((await put(ctx, 'notes/env-off', 'Env off.')).state).toBe('committed');
        });
        expect(groups.count()).toBe(1);
        await engine.setConfig('persistence.single_write_group', 'false');
        resetWriteSwitches();
        expect((await put(ctx, 'notes/config-off', 'Config off.')).state).toBe('committed');
        expect(groups.count()).toBe(1);
        await engine.setConfig('persistence.single_write_group', 'true');
        resetWriteSwitches();
        expect((await put(ctx, 'notes/config-on', 'Config on.')).state).toBe('committed');
        expect(groups.count()).toBe(2);
      } finally { groups.restore(); }
    }, { databaseUrl: url() });
  }, 120_000);

  test('the pre-admission cache answers repeated source reads; GBRAIN_PREADMIT_CACHE=0 and persistence.preadmit_cache=false read every time', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      const reads = countStatements(engine, SOURCE_READ);
      try {
        await put(ctx, 'notes/c-1', 'First.');
        const afterFirst = reads.count();
        await put(ctx, 'notes/c-2', 'Second.');
        expect(reads.count()).toBe(afterFirst);
        await withEnv({ GBRAIN_PREADMIT_CACHE: '0' }, async () => {
          resetWriteSwitches();
          await put(ctx, 'notes/c-3', 'Third.');
        });
        expect(reads.count()).toBeGreaterThan(afterFirst);
        const beforeConfig = reads.count();
        await engine.setConfig('persistence.preadmit_cache', 'false');
        resetWriteSwitches();
        await put(ctx, 'notes/c-4', 'Fourth.');
        expect(reads.count()).toBeGreaterThan(beforeConfig);
      } finally { reads.restore(); }
    }, { databaseUrl: url() });
  }, 120_000);

  for (const caseName of ['revoked writer', 'archived source', 'moved binding', 'refreshing worktree'] as const) {
    test(`a ${caseName} after the cache was filled refuses the next write with the same error as without the cache`, async () => {
      const outcome = async (cache: '0' | '1') => withEnv({ GBRAIN_PREADMIT_CACHE: cache }, async () => {
        resetWriteSwitches();
        let refused: { code?: string; message?: string } | null = null;
        await managedBrain(async ({ engine, ctx }) => {
          const first = await put(ctx, 'notes/warm', 'Warm the cache.');
          expect(first.state).toBe('committed');
          if (caseName === 'revoked writer') {
            const [row] = await engine.executeRaw<{ principal_id: string }>("SELECT principal_id FROM persistence_requests WHERE slug='notes/warm'");
            await revokeLocalWriter(engine, row!.principal_id);
          }
          const administered = (sql: string) => engine.transaction(async tx => {
            await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true),set_config('gbrain.persistence_protocol','2',true)");
            await tx.executeRaw(sql);
          });
          if (caseName === 'archived source') await administered("UPDATE sources SET archived=true WHERE id='default'");
          if (caseName === 'moved binding') await administered("UPDATE persistence_source_bindings SET topology_generation=topology_generation+1 WHERE source_id='default'");
          let refreshLock: NativeLockHandle | null = null;
          if (caseName === 'refreshing worktree') {
            const binding = (await getWorktreeBinding(engine, 'default'))!;
            // A live refresh holds its lock, so the consumer's recovery scan leaves its fenced row alone (as for a real refresh).
            refreshLock = await tryAcquireNativeLock(join(persistenceHome(), 'locks', `refresh-${binding.worktree_id}.lock`));
            expect(refreshLock).not.toBeNull();
            await engine.executeRaw(`INSERT INTO persistence_worktree_refreshes (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
              VALUES ($1::uuid,ARRAY['default'],gen_random_uuid(),$2,$3,'fenced','a','b','origin/main')`, [binding.worktree_id, binding.owner_epoch, binding.topology_generation]);
          }
          try { refused = await failure(put(ctx, 'notes/next', 'Next write.')); }
          finally { await refreshLock?.release(); }
          const [admitted] = await engine.executeRaw<{ n: number; generation: string | null }>(
            "SELECT count(*)::int AS n,max(topology_generation)::text AS generation FROM persistence_requests WHERE slug='notes/next'");
          // A moved binding is not a refusal: the write is admitted under the current binding, as without the cache.
          if (caseName === 'moved binding') {
            const [binding] = await engine.executeRaw<{ generation: string }>("SELECT topology_generation::text AS generation FROM persistence_source_bindings WHERE source_id='default'");
            expect(admitted).toEqual({ n: 1, generation: binding!.generation });
          } else expect(admitted!.n).toBe(0);
        }, { databaseUrl: url() });
        const seen = refused as { code?: string; message?: string } | null;
        return seen && { ...seen, message: seen.message?.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'uuid') };
      });
      const uncached = await outcome('0');
      const cached = await outcome('1');
      if (caseName !== 'moved binding') expect(uncached).not.toBeNull();
      if (caseName === 'refreshing worktree') expect(uncached?.code).toBe('worktree_refreshing');
      expect(cached).toEqual(uncached);
    }, 180_000);
  }

  test('the same request_id replays its committed receipt with the switch on and off', async () => {
    await managedBrain(async ({ ctx }) => {
      for (const [first, second] of [['1', '0'], ['0', '1']] as const) {
        const params = { slug: `notes/replay-${first}`, request_id: randomUUID(), content: page('Replay', `Replayed ${first}.`) };
        const original = await withEnv({ GBRAIN_SINGLE_WRITE_GROUP: first }, async () => { resetWriteSwitches();
          return submitPageMutation(ctx, { operation: 'put_page', params: { ...params }, waitMs: 20_000 }); });
        const replayed = await withEnv({ GBRAIN_SINGLE_WRITE_GROUP: second }, async () => { resetWriteSwitches();
          return submitPageMutation(ctx, { operation: 'put_page', params: { ...params }, waitMs: 20_000 }); });
        expect(original.state).toBe('committed');
        expect(replayed).toEqual(original);
        const conflict = await failure(submitPageMutation(ctx, { operation: 'put_page', params: { ...params, content: page('Replay', 'Different.') }, waitMs: 20_000 }));
        expect(conflict?.code).toBe('idempotency_conflict');
      }
    }, { databaseUrl: url() });
  }, 120_000);

  test('a failure after the file rename and before commit restores the file through the recovery path, then the write publishes alone', async () => {
    await managedBrain(async ({ ctx, root }) => {
      const path = join(root, 'notes/crash.md');
      mkdirSync(join(root, 'notes'), { recursive: true });
      expect((await put(ctx, 'notes/crash', 'Original body.')).state).toBe('committed');
      const original = readFileSync(path, 'utf8');
      const seen: Array<{ point: string; bytes: string | null }> = [];
      let thrown = false;
      installFaultHook(point => {
        if (!point.startsWith('publication:')) return;
        seen.push({ point, bytes: existsSync(path) ? readFileSync(path, 'utf8') : null });
        if (point === 'publication:after_publication' && !thrown) { thrown = true; throw new Error('injected failure after the file rename'); }
      });
      const snapshot = await ctx.engine.readPageSnapshot('notes/crash', { sourceId: 'default' });
      const done = await put(ctx, 'notes/crash', 'Replacement body.', { expected_revision: snapshot!.revision });
      expect(done.state).toBe('committed');
      // The group published the new bytes, then failed; the fallback's first seam sees the restored original.
      const failedAt = seen.findIndex(s => s.point === 'publication:after_publication');
      expect(seen[failedAt]!.bytes).toContain('Replacement body.');
      expect(seen.slice(failedAt + 1).find(s => s.point === 'publication:prepared')!.bytes).toBe(original);
      expect(readFileSync(path, 'utf8')).toContain('Replacement body.');
      const [row] = await ctx.engine.executeRaw<{ recovery: unknown; n: number }>("SELECT recovery,(SELECT count(*)::int FROM persistence_requests WHERE recovery IS NOT NULL) AS n FROM persistence_requests WHERE slug='notes/crash' ORDER BY sequence DESC LIMIT 1");
      expect(row).toMatchObject({ recovery: null, n: 0 });
    }, { databaseUrl: url() });
  }, 120_000);

  test('a recovery record on the worktree blocks the own-admission direct claim', async () => {
    await managedBrain(async ({ engine, ctx, root }) => {
      expect((await put(ctx, 'notes/head', 'Head.')).state).toBe('committed');
      await disposePersistenceConsumer(engine);
      // A recovering request whose canonical file matches neither its prior nor its published bytes stays blocked.
      const path = join(root, 'notes/blocked.md');
      writeFileSync(path, 'edited outside gbrain\n');
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
        await tx.executeRaw(`UPDATE persistence_requests SET state='recovering',execution_token=gen_random_uuid(),blocked_reason='unexpected_file_bytes',
          recovery=$1::text::jsonb WHERE slug='notes/head'`, [JSON.stringify({ version: 1, path, root, before: null, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), mode: null,
          ownerEpoch: '1', attempt: randomUUID(), staging: {} })]);
      });
      const pending = await put(ctx, 'notes/after', 'After.', {}, 2000).catch((error: { writeRequest?: { state: string } }) => error.writeRequest);
      expect(pending?.state).toBe('queued');
      // Never claimed: a claim the publisher's own recheck released would leave blocked_reason 'recovery_required'.
      const [row] = await engine.executeRaw<{ state: string; blocked_reason: string | null }>("SELECT state,blocked_reason FROM persistence_requests WHERE slug='notes/after'");
      expect(row).toEqual({ state: 'queued', blocked_reason: null });
      expect(existsSync(join(root, 'notes/after.md'))).toBe(false);
    }, { databaseUrl: url() });
  }, 120_000);
});
