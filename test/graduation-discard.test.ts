/**
 * `gbrain migrate --discard-source` custody (src/core/persistence/graduation-discard.ts)
 * over the graduation harness: a real disk-backed PGLite source graduated to a
 * real target engine through the production manifest, marker, tombstone,
 * move-aside and kernel lock.
 *
 * Protects: the plan is read-only and lists exactly the retained copy, the
 * tombstone and the intent marker; the delete needs `--yes` and that plan's
 * hash, removes those three and nothing else, records sourceDiscardedAt, keeps
 * the target authoritative and routing on Postgres, and a later rollback
 * refuses instead of opening an empty brain. It refuses, deleting nothing, for
 * an unfinished or rolled-back run, a pending rollback (in the manifest or
 * fenced on the target), an unreachable target, a held kernel lock and a
 * foreign file at the old path. A copy left half-deleted is never at the path a
 * rollback restores from, and a re-run finishes it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  graduationStatus, planGraduation, readGraduationManifest, rollbackGraduation, runGraduation, type GraduationOptions,
} from '../src/core/persistence/engine-graduation.ts';
import { discardSource, planDiscardSource, type DiscardOptions } from '../src/core/persistence/graduation-discard.ts';
import { discardingPath, graduatedPath } from '../src/core/persistence/graduation-custody.ts';
import { readGraduationRow, setTargetState, withGraduationRun } from '../src/core/persistence/graduation-schema.ts';
import { acquireKernelLockOnly, pgliteLockDirFor, releaseLock } from '../src/core/pglite-lock.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { crashAt, makeHarness, TARGET_URL, type Harness } from './helpers/graduation-harness.ts';

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; fix?: { argv?: string[]; plan_hash?: string }; message: string }> {
  try { await promise; } catch (error) {
    return { code: (error as { code?: string }).code, fix: (error as { fix?: never }).fix, message: (error as Error).message };
  }
  throw new Error('expected a refusal');
}

const POSTGRES_URL = process.env.DATABASE_URL;
const targets: Array<[string, string | undefined]> = [['pglite target', undefined]];
if (POSTGRES_URL) { assertSafeE2eDatabaseUrl(POSTGRES_URL); targets.push(['postgres target', POSTGRES_URL]); }

for (const [label, postgresUrl] of targets) describe(`graduation --discard-source (${label})`, () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness({ postgresUrl }); });
  afterAll(async () => { await h.close(); });

  async function fresh(): Promise<void> { await h.close(); h = await makeHarness({ postgresUrl }); }
  const manifestPath = () => join(h.gbrainDir, 'graduation-manifest.json');
  const manifest = () => readGraduationManifest(manifestPath())!;
  const config = () => JSON.parse(readFileSync(join(h.gbrainDir, 'config.json'), 'utf8'));
  const opts = (extra: Partial<DiscardOptions> = {}): DiscardOptions => ({ manifestPath: manifestPath(), deps: h.deps, lockTimeoutMs: 1_000, ...extra });
  const rollbackOpts = (extra: Record<string, unknown> = {}) => ({ env: {}, deps: h.deps, handoffTimeoutMs: 1_000, ...extra });

  async function graduate(extra: Partial<GraduationOptions> = {}): Promise<void> {
    const run: GraduationOptions = { config: { engine: 'pglite', database_path: h.dataDir } as GraduationOptions['config'], to: 'postgres', url: TARGET_URL,
      env: {}, drainTimeoutMs: 60_000, force: false, yes: true, expectPlanHash: '', deps: h.deps, handoffTimeoutMs: 1_000, ...extra };
    await runGraduation({ ...run, expectPlanHash: (await planGraduation({ ...run, expectPlanHash: '' })).planHash });
  }

  /** Every file next to the data dir (names and sizes), the manifest and the routing: what a read-only step must not change. */
  function snapshot(): string {
    const dataDir = manifest().source.dataDir;
    const entries = readdirSync(dirname(dataDir)).filter(n => n.startsWith(basename(dataDir))).sort()
      .map(n => { const st = lstatSync(join(dirname(dataDir), n)); return `${n}:${st.isDirectory() ? 'dir' : st.size}`; });
    return JSON.stringify({ entries, manifest: readFileSync(manifestPath(), 'utf8'), config: config() });
  }

  test('the plan lists the copy, tombstone and marker without changing a byte; the delete needs --yes and that hash', async () => {
    await h.inHome(async () => {
      await graduate();
      const m = manifest();
      const before = snapshot();
      const plan = await planDiscardSource(opts());
      expect(plan.paths.map(p => [p.kind, p.path])).toEqual([
        ['retained_copy', graduatedPath(m.source.dataDir, m.runId)], ['tombstone', m.source.dataDir], ['intent_marker', `${m.source.dataDir}.gbrain-graduation.json`],
      ]);
      expect(plan.paths[0]!.bytes).toBeGreaterThan(0);
      expect(snapshot()).toBe(before);
      const unapproved = await refusal(discardSource(opts()));
      expect(unapproved.code).toBe('confirmation_required');
      expect(unapproved.fix?.argv).toEqual(['gbrain', 'migrate', '--discard-source', '--yes', '--expect', plan.planHash]);
      const wrong = await refusal(discardSource(opts({ yes: true, expectPlanHash: '0000000000000000' })));
      expect(wrong.code).toBe('preview_changed');
      expect(wrong.fix?.plan_hash).toBe(plan.planHash);
      expect(snapshot()).toBe(before);
      expect((await planDiscardSource(opts())).planHash).toBe(plan.planHash);
    });
  }, 120_000);

  test('the approved delete removes exactly those three, keeps Postgres authoritative, and a rollback then refuses', async () => {
    await h.inHome(async () => {
      const m = manifest();
      const plan = await planDiscardSource(opts());
      const result = await discardSource(opts({ yes: true, expectPlanHash: plan.planHash }));
      expect(result.deleted.map(p => p.path)).toEqual(plan.paths.map(p => p.path));
      for (const p of plan.paths) expect(existsSync(p.path)).toBe(false);
      expect(existsSync(discardingPath(m.source.dataDir, m.runId))).toBe(false);
      expect(manifest()).toMatchObject({ state: 'graduated', sourceDiscardedAt: result.sourceDiscardedAt });
      expect(config()).toMatchObject({ engine: 'postgres' });
      expect((await readGraduationRow(h.target))?.state).toBe('authoritative');
      await h.target.executeRaw(`INSERT INTO grad_probe VALUES (700, 'written-after-discard')`);
      expect((await graduationStatus({ manifestPath: manifestPath(), deps: h.deps })).sourceDiscardedAt).toBe(result.sourceDiscardedAt);

      const rollback = await refusal(rollbackGraduation(rollbackOpts()));
      expect(rollback.code).toBe('not_found');
      expect(rollback.message).toContain('was discarded');
      expect(existsSync(m.source.dataDir)).toBe(false);
      expect(config()).toMatchObject({ engine: 'postgres' });
      expect((await readGraduationRow(h.target))?.state).toBe('authoritative');

      const again = await planDiscardSource(opts());
      expect(again.paths).toEqual([]);
      expect((await discardSource(opts({ yes: true, expectPlanHash: again.planHash }))).deleted).toEqual([]);
    });
  }, 120_000);

  test('an unfinished or rolled-back run refuses and deletes nothing', async () => {
    await fresh();
    await h.inHome(async () => {
      await expect(graduate({ pauseAt: 'verified', pauseHook: crashAt('verified') })).rejects.toThrow();
      const unfinished = await refusal(planDiscardSource(opts()));
      expect(unfinished.code).toBe('graduation_interrupted');
      expect(unfinished.message).toContain('verified');
      expect((await refusal(discardSource(opts({ yes: true, expectPlanHash: 'anything' })))).code).toBe('graduation_interrupted');
      expect(lstatSync(h.dataDir).isDirectory()).toBe(true);
    });
    await fresh();
    await h.inHome(async () => {
      await graduate();
      await rollbackGraduation(rollbackOpts());
      expect(manifest().state).toBe('rolled_back');
      const rolledBack = await refusal(discardSource(opts({ yes: true, expectPlanHash: 'anything' })));
      expect(rolledBack.code).toBe('not_found');
      expect(rolledBack.message).toContain('rolled back');
      expect(lstatSync(h.dataDir).isDirectory()).toBe(true);
    });
  }, 240_000);

  test('a pending rollback refuses: recorded in the manifest, or fenced on the target before the manifest says so', async () => {
    await fresh();
    await h.inHome(async () => {
      await graduate();
      const copy = graduatedPath(manifest().source.dataDir, manifest().runId);
      await expect(rollbackGraduation(rollbackOpts({ pauseAt: 'rollback_fenced', pauseHook: crashAt('rollback_fenced') }))).rejects.toThrow();
      expect(manifest().state).toBe('rollback_fenced');
      const pending = await refusal(discardSource(opts({ yes: true, expectPlanHash: 'anything' })));
      expect(pending.code).toBe('graduation_interrupted');
      expect(pending.message).toContain('rollback_fenced');
      expect(existsSync(copy)).toBe(true);
    });
    await fresh();
    await h.inHome(async () => {
      await graduate();
      const { runId } = manifest();
      await withGraduationRun(h.target, runId, tx => setTargetState(tx, runId, 'rollback_fenced'));
      const fenced = await refusal(planDiscardSource(opts()));
      expect(fenced.code).toBe('graduation_in_progress');
      expect(existsSync(graduatedPath(manifest().source.dataDir, runId))).toBe(true);
      await withGraduationRun(h.target, runId, tx => setTargetState(tx, runId, 'authoritative'));
      expect((await planDiscardSource(opts())).paths).toHaveLength(3);
    });
  }, 240_000);

  test('an unreachable target, a held kernel lock and a foreign directory at the old path refuse and delete nothing', async () => {
    await fresh();
    await h.inHome(async () => {
      await graduate();
      const m = manifest();
      const before = snapshot();
      const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      const unreachable = await refusal(planDiscardSource(opts({ deps: { connectTargets: async () => { throw refused; } } })));
      expect(unreachable.code).toBe('database_error');
      expect(unreachable.message).toContain('ECONNREFUSED');
      expect(unreachable.message).not.toContain('secret-pw');

      const plan = await planDiscardSource(opts());
      const lock = await acquireKernelLockOnly(m.source.dataDir, { lockDir: pgliteLockDirFor(m.source.dataDir), timeoutMs: 1_000 });
      try {
        const busy = await refusal(discardSource(opts({ yes: true, expectPlanHash: plan.planHash, lockTimeoutMs: 200 })));
        expect(busy.code).toBe('lock_busy');
      } finally { await releaseLock(lock); }
      expect(snapshot()).toBe(before);

      rmSync(m.source.dataDir);
      mkdirSync(m.source.dataDir);
      const foreign = await refusal(planDiscardSource(opts()));
      expect(foreign.code).toBe('local_conflict');
      expect(existsSync(graduatedPath(m.source.dataDir, m.runId))).toBe(true);
      expect(lstatSync(m.source.dataDir).isDirectory()).toBe(true);
    });
  }, 120_000);

  test('a discard stopped mid-delete never leaves a restorable half copy, and a re-run finishes it', async () => {
    await fresh();
    await h.inHome(async () => {
      await graduate();
      const m = manifest();
      const copy = graduatedPath(m.source.dataDir, m.runId);
      // What a SIGKILL partway through rmSync leaves: the renamed copy, partly removed (the manifest field may not have survived).
      renameSync(copy, discardingPath(m.source.dataDir, m.runId));
      rmSync(join(discardingPath(m.source.dataDir, m.runId), 'base'), { recursive: true, force: true });
      const rollback = await refusal(rollbackGraduation(rollbackOpts()));
      expect(rollback.code).toBe('not_found');
      expect((await readGraduationRow(h.target))?.state).toBe('authoritative');
      const plan = await planDiscardSource(opts());
      expect(plan.paths.map(p => p.kind)).toEqual(['retained_copy', 'tombstone', 'intent_marker']);
      expect(plan.paths[0]!.path).toBe(discardingPath(m.source.dataDir, m.runId));
      await discardSource(opts({ yes: true, expectPlanHash: plan.planHash }));
      for (const p of plan.paths) expect(existsSync(p.path)).toBe(false);
      expect(existsSync(copy)).toBe(false);
    });
  }, 120_000);
});
