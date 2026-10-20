/**
 * GBRA-130 A-28 (#6712 PR 4b): `sync unblock --apply` ran the content-repair lane for its repair-class holds with no catch,
 * so one unexpected throw from a repair kind aborted the whole unblock: no outcome was returned and the re-screens of the
 * other holds (`requestGitHoldRetry`) never ran. The lane's per-kind catch (GBRA-130 A-46, master #6964,
 * test/pathological/a46-content-lane-kinds.test.ts) now stops the throwing kind with reason `error`; this probe covers
 * what that suite does not: the unblock outcome built on top of it.
 *
 * Protects (red before: unblock --apply rejects with the kind's error and schedules nothing): with the fences kind
 * stubbed to throw `OperationError('storage_error')`, the fence hold is reported `skipped` with reason `error` and
 * `gbrain sync unblock --source <id> --apply --json` as its next step, and the other hold (a `preparation_stalled`
 * retry) is still scheduled for its re-screen. Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationError } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { unblockSync } from '../src/core/persistence/sync-status.ts';
import { readGitHoldRetryPaths, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { REPAIR_REGISTRY } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
/** A facts fence with rows and no header: an `invalid_fence` hold the fences kind repairs. */
const noHeader = `---\ntitle: Model\n---\nA synthetic page.\n\n${FB}\n| 1 | Example ships quarterly | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |\n${FBE}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/a.md'), '---\ntitle: A\n---\nAlpha.\n');
  commit(root, 'seed');
};
const throwingRegistry = REPAIR_REGISTRY.map(spec => spec.kind !== 'fences' ? spec
  : { ...spec, handler: { ...spec.handler, plan: async () => { throw new OperationError('storage_error', 'The fences kind failed unexpectedly.', 'Run gbrain repair content to see it.'); } } });

for (const backend of testBackends()) describe(`[${backend}] GBRA-130 A-28: a repair kind that throws during sync unblock --apply`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  test('the fence hold is skipped error with the unblock apply as next, and the other hold is still scheduled', () => managedBrain(async ({ engine, root }) => {
    await withEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined }, async () => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      mkdirSync(join(root, 'people'), { recursive: true });
      writeFileSync(join(root, 'people/model.md'), noHeader); commit(root, 'a malformed fence');
      const synced = await performManagedSync(engine, OPTS);
      expect(synced.held?.map(hold => [hold.path, hold.code])).toEqual([['people/model.md', 'invalid_fence']]);
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
      // A second hold whose safe action is a plain re-screen.
      await writeGitHold(engine, { source_id: 'default', incarnation, path: 'notes/stalled.md', source_path: 'notes/stalled.md', slug: 'notes/stalled', page_id: null,
        code: 'preparation_stalled', message: 'notes/stalled.md: its import could not finish preparing, so it is held and the rest of the source synced.', upstream_version: null,
        observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: 1 } });
      const outcome = await unblockSync(engine, 'default', { apply: true, noLlm: true, registry: throwingRegistry });
      const fence = outcome.applied.find(entry => entry.path === 'people/model.md');
      expect(fence).toMatchObject({ action: 'repair', repair: { kind: 'fences', outcome: 'skipped', reason: 'error', next: { argv: ['gbrain', 'sync', 'unblock', '--source', 'default', '--apply', '--json'] } } });
      expect(outcome.applied.find(entry => entry.path === 'notes/stalled.md')).toMatchObject({ action: 'retry' });
      expect(await readGitHoldRetryPaths(engine, 'default', incarnation)).toEqual(['notes/stalled.md']);
    });
  }, { databaseUrl, setup }), 180_000);
});
