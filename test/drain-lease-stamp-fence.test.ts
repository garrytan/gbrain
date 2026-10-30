/**
 * The pass stamp's own drain-lease fences, on both engines. Besides `assertDrainLease`, two transactions read the lease row
 * by token `FOR KEY SHARE`: a folded stamp's proof (`provenStamp`, sync-pass-fold.ts) and the checkpoint request's
 * (`applyPassCheckpoint`, sync-prepare.ts). A coordinator runs them with the token stamped on the request, so they fence the
 * holder's lease even when they run in another process. The drain lease's model (spec/tla/drain-lease) treats them as
 * fenced transactions of the holder: each token check is a guard mutant in spec/tla/drain-lease/mutants.json, and removing
 * it from the code must fail its test here.
 *
 * Runs on PGLite here and on Postgres through test/e2e/drain-lease-stamp-fence-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};
const lastCommit = async (engine: BrainEngine) => (await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id='default'"))[0]?.last_commit ?? null;
const kindOf = async (engine: BrainEngine, requestId: string) =>
  (await engine.executeRaw<{ kind: string | null; stamp: boolean }>("SELECT intent->>'kind' AS kind, intent ? 'stamp' AS stamp FROM persistence_requests WHERE request_id=$1::uuid", [requestId]))[0];
/** Another drainer took the lease over: the row is live, under a token the pass does not hold. */
const takeOver = (engine: BrainEngine) => engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1', [syncLockId('default')]);

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`drain lease: the pass stamp's fences (${backend})`, () => {
    test('a folded stamp is refused once the lease is taken over before its import publishes', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const before = await lastCommit(engine);
      writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
      let stamped = null as string | null;
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:prepared' || stamped || !detail.requestId || !(await kindOf(engine, detail.requestId))?.stamp) return;
        stamped = detail.requestId;
        await takeOver(engine);
      });
      await performManagedSync(engine, OPTS).catch(() => undefined);
      installFaultHook(undefined);
      expect(stamped).not.toBeNull();
      const [outcome] = await engine.executeRaw<{ stamp: string | null; skipped: string | null }>(
        "SELECT outcome->>'pass_stamp' AS stamp, outcome->>'pass_stamp_skipped' AS skipped FROM persistence_requests WHERE request_id=$1::uuid", [stamped]);
      expect(outcome).toEqual({ stamp: null, skipped: 'lease' });
      expect(await lastCommit(engine)).toBe(before);
    }), 180_000);

    test('a checkpoint request is refused once the lease is taken over before it publishes', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const before = await lastCommit(engine);
      writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
      let checkpoint = null as string | null;
      installFaultHook(async (point, detail) => {
        if (point === 'sync:pass_fold') throw new Error('The test refuses the folded stamp.');
        if (point !== 'consumer:prepared' || checkpoint || !detail.requestId || (await kindOf(engine, detail.requestId))?.kind !== 'managed_sync_checkpoint') return;
        checkpoint = detail.requestId;
        await takeOver(engine);
      });
      await performManagedSync(engine, OPTS).catch(() => undefined);
      installFaultHook(undefined);
      expect(checkpoint).not.toBeNull();
      const [row] = await engine.executeRaw<{ state: string; error: string | null }>(
        "SELECT state, error_detail->>'message' AS error FROM persistence_requests WHERE request_id=$1::uuid", [checkpoint]);
      expect(row!.state).not.toBe('committed');
      expect(await lastCommit(engine)).toBe(before);
    }), 180_000);

    // Postgres only: PGLite is one connection, so nothing can try a takeover while the stamp's transaction is open.
    if (backend === 'postgres') {
      /**
       * A takeover as --break-lock writes it (a DELETE, which conflicts with every row lock a fence can take, FOR KEY SHARE
       * included), from another connection, giving up after 1 s.
       */
      const takeoverDuring = (engine: BrainEngine) => engine.transaction(async tx => {
        await tx.executeRaw("SET LOCAL lock_timeout = '1s'");
        return (await tx.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1 RETURNING id', [syncLockId('default')])).length;
      }).catch((error: { code?: string }) => error.code ?? String(error));

      test('a folded stamp holds the lease row FOR KEY SHARE until its import commits, so a takeover waits', () => brain(async ({ engine, root }) => {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
        const stamped = new Set<string>();
        let during = null as unknown;
        installFaultHook(async (point, detail) => {
          if (point === 'consumer:prepared' && detail.requestId && (await kindOf(engine, detail.requestId))?.stamp) stamped.add(detail.requestId);
          // The publication transaction is open here, after the folded stamp's proof read the lease row.
          if (point === 'publication:before_commit' && during === null && detail.requestId && stamped.has(detail.requestId)) during = await takeoverDuring(engine);
        });
        await performManagedSync(engine, OPTS).catch(() => undefined);
        installFaultHook(undefined);
        const [row] = await engine.executeRaw<{ stamp: string | null }>("SELECT outcome->>'pass_stamp' AS stamp FROM persistence_requests WHERE request_id=$1::uuid", [[...stamped][0]]);
        expect(row?.stamp).toBe('folded');
        expect(during).toBe('55P03');
      }), 180_000);

      test('a checkpoint request holds the lease row FOR KEY SHARE until it commits, so a takeover waits', () => brain(async ({ engine, root }) => {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
        const checkpoints = new Set<string>();
        let during = null as unknown;
        installFaultHook(async (point, detail) => {
          if (point === 'sync:pass_fold') throw new Error('The test refuses the folded stamp.');
          if (point === 'consumer:prepared' && detail.requestId && (await kindOf(engine, detail.requestId))?.kind === 'managed_sync_checkpoint') checkpoints.add(detail.requestId);
          if (point === 'publication:before_commit' && during === null && detail.requestId && checkpoints.has(detail.requestId)) during = await takeoverDuring(engine);
        });
        await performManagedSync(engine, OPTS).catch(() => undefined);
        installFaultHook(undefined);
        const [row] = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE request_id=$1::uuid", [[...checkpoints][0]]);
        expect(row?.state).toBe('committed');
        expect(during).toBe('55P03');
      }), 180_000);
    }
  });
}
