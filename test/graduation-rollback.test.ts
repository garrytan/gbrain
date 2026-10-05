/**
 * Engine graduation rollback custody.
 *
 * Protects: rollback before cutover abandons the target (fence kept) and
 * leaves the source writable; after cutover it fences first, compares the
 * target with the graduation receipt and the retained source's security
 * state by identity and content, refuses finally on withdrawals and
 * revocations, needs `--yes --expect <hash>` for other user-data loss, never
 * writes back to the source, and returns the target to authority on every
 * refusal; durable substeps reconcile after a crash (back to authority before
 * approval, forward to rolled_back after it); with the retained copy gone
 * (discarded or deleted by hand) it refuses instead of opening an empty brain.
 * Regressions that fail it: a timestamp-based security check (revocations
 * delete rows), a refusal that strands the target fenced, a crash after
 * approval that restores authority, a rollback that runs without its copy.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  planGraduation, readGraduationManifest, reconcileGraduation, rollbackGraduation, runGraduation, type GraduationOptions,
} from '../src/core/persistence/engine-graduation.ts';
import { assertGraduationConnectAllowed, readIntentMarker, readTombstone } from '../src/core/persistence/graduation-custody.ts';
import { graduationFenceStatus, readGraduationRow } from '../src/core/persistence/graduation-schema.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { crashAt, makeHarness, openPglite, probeRows, SOURCE_TOKEN_ID, TARGET_URL, type Harness } from './helpers/graduation-harness.ts';

function codeOf(error: unknown): string | undefined { return (error as { code?: string })?.code; }
async function refusal(promise: Promise<unknown>): Promise<{ code?: string; fix?: { argv?: string[]; plan_hash?: string; consent?: string[] }; message: string }> {
  try { await promise; } catch (error) { return { code: codeOf(error), fix: (error as { fix?: never }).fix, message: (error as Error).message }; }
  throw new Error('expected a refusal');
}

const POSTGRES_URL = process.env.DATABASE_URL;
const targets: Array<[string, string | undefined]> = [['pglite target', undefined]];
if (POSTGRES_URL) { assertSafeE2eDatabaseUrl(POSTGRES_URL); targets.push(['postgres target', POSTGRES_URL]); }

for (const [label, postgresUrl] of targets) {
  describe(`graduation rollback (${label})`, () => {
    let h: Harness;
    beforeAll(async () => { h = await makeHarness({ postgresUrl }); });
    afterAll(async () => { await h.close(); });

    async function fresh(): Promise<void> { await h.close(); h = await makeHarness({ postgresUrl }); }
    function runOpts(expect: string, extra: Partial<GraduationOptions> = {}): GraduationOptions {
      return { config: { engine: 'pglite', database_path: h.dataDir } as GraduationOptions['config'], to: 'postgres', url: TARGET_URL, env: {}, drainTimeoutMs: 60_000,
        force: false, yes: true, expectPlanHash: expect, deps: h.deps, handoffTimeoutMs: 1_000, ...extra };
    }
    async function graduate(extra: Partial<GraduationOptions> = {}): Promise<void> {
      const hash = (await planGraduation(runOpts(''))).planHash;
      await runGraduation(runOpts(hash, extra));
    }
    const rollbackOpts = (extra: Record<string, unknown> = {}) => ({ env: {}, deps: h.deps, handoffTimeoutMs: 1_000, ...extra });
    const manifest = () => readGraduationManifest(join(h.gbrainDir, 'graduation-manifest.json'))!;
    const config = () => JSON.parse(readFileSync(join(h.gbrainDir, 'config.json'), 'utf8'));

    async function assertTargetAuthoritative(): Promise<void> {
      expect((await readGraduationRow(h.target))?.state).toBe('authoritative');
      expect((await graduationFenceStatus(h.target)).fenced).toBe(0);
      await h.target.executeRaw(`INSERT INTO grad_probe VALUES (700 + (SELECT count(*) FROM grad_probe)::int, 'normal-client-write')`);
      expect(lstatSync(h.dataDir).isFile()).toBe(true);
    }
    async function assertRolledBack(): Promise<void> {
      expect(manifest().state).toBe('rolled_back');
      expect(lstatSync(h.dataDir).isDirectory()).toBe(true);
      expect(readTombstone(h.dataDir)).toBeNull();
      expect(readIntentMarker(h.dataDir)).toBeNull();
      expect(config()).toMatchObject({ engine: 'pglite', database_path: h.dataDir });
      expect(config().database_url).toBeUndefined();
      const mounts = JSON.parse(readFileSync(h.mountsPath, 'utf8'));
      expect(mounts.mounts[0]).toMatchObject({ engine: 'pglite', database_path: h.dataDir });
      expect(mounts.mounts[0].database_url).toBeUndefined();
      expect((await readGraduationRow(h.target))?.state).toBe('rolled_back');
      expect((await graduationFenceStatus(h.target)).unfenced).toEqual([]);
      expect(codeOf(await assertGraduationConnectAllowed(h.target, {}).catch(e => e))).toBe('graduation_in_progress');
      const source = await openPglite(h.dataDir);
      try {
        expect((await readGraduationRow(source))?.state).toBe('rolled_back');
        await source.executeRaw(`INSERT INTO grad_probe VALUES (900, 'source-writable-again')`);
      } finally { await source.disconnect(); }
    }

    test('before cutover: the target is abandoned and stays fenced; the source is released writable', async () => {
      await h.inHome(async () => {
        await expect(graduate({ pauseAt: 'verified', pauseHook: crashAt('verified') })).rejects.toThrow();
        const result = await rollbackGraduation(rollbackOpts());
        expect(result.state).toBe('abandoned');
        expect(manifest().state).toBe('abandoned');
        expect(readIntentMarker(h.dataDir)).toBeNull();
        expect((await readGraduationRow(h.target))?.state).toBe('abandoned');
        expect((await graduationFenceStatus(h.target)).unfenced).toEqual([]);
        await expect(h.target.executeRaw(`INSERT INTO grad_probe VALUES (50, 'x')`)).rejects.toThrow(/graduation_in_progress/);
        const source = await openPglite(h.dataDir);
        try {
          expect((await readGraduationRow(source))?.state).toBe('rolled_back');
          await source.executeRaw(`INSERT INTO grad_probe VALUES (51, 'writable')`);
        } finally { await source.disconnect(); }
      });
    }, 120_000);

    test('after graduation with no target writes: the datastore, routing and mounts are restored', async () => {
      await fresh();
      await h.inHome(async () => {
        await graduate();
        await h.target.executeRaw(`UPDATE access_tokens SET last_used_at = now() WHERE id = $1::uuid`, [SOURCE_TOKEN_ID]);
        const result = await rollbackGraduation(rollbackOpts());
        expect(result.state).toBe('rolled_back');
        await assertRolledBack();
      });
    }, 120_000);

    test('a retained copy deleted by hand: rollback refuses, the target stays authoritative and routing stays on Postgres', async () => {
      await fresh();
      await h.inHome(async () => {
        await graduate();
        rmSync(`${h.dataDir}.graduated-${manifest().runId}`, { recursive: true, force: true });
        const refused = await refusal(rollbackGraduation(rollbackOpts()));
        expect(refused.code).toBe('not_found');
        expect(refused.message).toContain('nothing to roll back to');
        expect(manifest().state).toBe('graduated');
        expect(config().engine).toBe('postgres');
        await assertTargetAuthoritative();
      });
    }, 120_000);

    test('a retained copy removed between the fence and the kernel lock: the target returns to authority', async () => {
      await fresh();
      await h.inHome(async () => {
        await graduate();
        const copy = `${h.dataDir}.graduated-${manifest().runId}`;
        const removeAtFence = async (step: string) => { if (step === 'rollback_fenced') rmSync(copy, { recursive: true, force: true }); };
        const refused = await refusal(rollbackGraduation(rollbackOpts({ pauseAt: 'rollback_fenced', pauseHook: removeAtFence })));
        expect(refused.code).toBe('not_found');
        expect(manifest().state).toBe('graduated');
        expect(config().engine).toBe('postgres');
        await assertTargetAuthoritative();
      });
    }, 120_000);

    test('a target page-style edit is listed and rolls back only with the expect hash; it is never written back', async () => {
      await fresh();
      await h.inHome(async () => {
        await graduate();
        await h.target.executeRaw(`INSERT INTO grad_probe VALUES (10, 'written-on-target')`);
        const refused = await refusal(rollbackGraduation(rollbackOpts()));
        expect(refused.code).toBe('graduation_rollback_writes_lost');
        expect(refused.message).toContain('grad_probe');
        expect(refused.fix?.consent).toEqual(['destructive']);
        const hash = refused.fix!.plan_hash!;
        expect(refused.fix?.argv).toEqual(['gbrain', 'migrate', '--rollback-to-source', '--yes', '--expect', hash]);
        expect(manifest().state).toBe('graduated');
        await assertTargetAuthoritative();
        const wrong = await refusal(rollbackGraduation(rollbackOpts({ yes: true, expectPlanHash: '0000000000000000' })));
        expect(wrong.code).toBe('graduation_rollback_writes_lost');
        const relisted = wrong.fix!.plan_hash!;
        await rollbackGraduation(rollbackOpts({ yes: true, expectPlanHash: relisted }));
        await assertRolledBack();
        const source = await openPglite(h.dataDir);
        try { expect((await probeRows(source)).map(r => r.v)).not.toContain('written-on-target'); } finally { await source.disconnect(); }
      });
    }, 120_000);

    test('a fact withdrawal on the target refuses finally, with and without --yes', async () => {
      await fresh();
      await h.inHome(async () => {
        await graduate();
        await h.target.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', 'hash-w1')`);
        for (const extra of [{}, { yes: true, expectPlanHash: 'anything' }]) {
          const refused = await refusal(rollbackGraduation(rollbackOpts(extra)));
          expect(refused.code).toBe('graduation_rollback_writes_lost');
          expect(refused.fix?.argv).toBeUndefined();
          expect(refused.message).toContain('fact_withdrawals');
          await assertTargetAuthoritative();
        }
      });
    }, 120_000);

    test('a token revocation on the target (the row is deleted) refuses finally', async () => {
      await fresh();
      await h.inHome(async () => {
        await graduate();
        await h.target.executeRaw(`DELETE FROM access_tokens WHERE id = $1::uuid`, [SOURCE_TOKEN_ID]);
        const refused = await refusal(rollbackGraduation(rollbackOpts({ yes: true, expectPlanHash: 'x' })));
        expect(refused.code).toBe('graduation_rollback_writes_lost');
        expect(refused.fix?.argv).toBeUndefined();
        expect(refused.message).toContain('access_tokens missing (1)');
        await assertTargetAuthoritative();
      });
    }, 120_000);

    test('a crash after fencing returns the target to authority; a crash after approval rolls forward', async () => {
      await fresh();
      await h.inHome(async () => {
        await graduate();
        await expect(rollbackGraduation(rollbackOpts({ pauseAt: 'rollback_fenced', pauseHook: crashAt('rollback_fenced') }))).rejects.toThrow();
        expect((await readGraduationRow(h.target))?.state).toBe('rollback_fenced');
        await expect(h.target.executeRaw(`INSERT INTO grad_probe VALUES (60, 'x')`)).rejects.toThrow(/graduation_in_progress/);
        const reconciled = await reconcileGraduation(rollbackOpts());
        expect(reconciled.actions).toContain('returned target to authority');
        expect(manifest().state).toBe('graduated');
        await assertTargetAuthoritative();
      });
      for (const seam of ['rollback_approved', 'source_restoring', 'tombstone_removed', 'renamed_back', 'config_restored']) {
        await fresh();
        await h.inHome(async () => {
          await graduate();
          await expect(rollbackGraduation(rollbackOpts({ pauseAt: seam, pauseHook: crashAt(seam) }))).rejects.toThrow();
          expect(['rollback_approved', 'source_restoring']).toContain(manifest().state);
          const reconciled = await reconcileGraduation(rollbackOpts());
          expect(reconciled.actions).toContain('finished rollback');
          await assertRolledBack();
          expect(existsSync(`${h.dataDir}.graduated-${manifest().runId}`)).toBe(false);
        });
      }
    }, 120_000);
  });
}
