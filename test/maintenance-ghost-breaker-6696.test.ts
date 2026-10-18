/**
 * #6696 (A12): known-failing maintenance writes stop burning quota.
 *   - A page whose canonical file is gone (a ghost) refuses `source_changed` /
 *     `canonical_file_missing` before admission: two maintenance cycles add no
 *     request (before #6696, one conflict receipt each). A caller write still
 *     gets its receipt, and the receipt's detail names the cause.
 *   - The refusal breaker: after K (persistence.maintenance.refusal_breaker_threshold,
 *     default 3) identical terminal refusals of the same write under fresh
 *     request ids, the next one is refused before admission; a planner version
 *     bump (a different intent) is admitted again. Doctor
 *     `maintenance_write_drift` lists the suppressed slug with its exit.
 * PGLite; synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { maintenancePreflight, publishMaintenancePage, submitDatabaseMaintenanceIntent } from '../src/core/persistence/prepared-maintenance.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { REFUSAL_BREAKER_THRESHOLD_KEY } from '../src/core/persistence/refusal-breaker.ts';
import { maintenanceWriteDriftCheck } from '../src/commands/doctor/checks/maintenance-drift.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };

describe('#6696 A12 ghost refusal and refusal breaker', () => {
  let engine: BrainEngine;
  const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-6696-a12-db-'));
  beforeAll(async () => { const pglite = new PGLiteEngine(); await pglite.connect({ database_path: dataDir }); await pglite.initSchema(); engine = pglite; }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dataDir, { recursive: true, force: true }); });

  async function fixture(run: (input: { root: string; sourceId: string; ctx: OperationContext }) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6696-a12-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `a12-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run({ root, sourceId, ctx: { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.unsetConfig(REFUSAL_BREAKER_THRESHOLD_KEY);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const put = (ctx: OperationContext, slug: string, content: string, expected_revision?: string) =>
    submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(), ...(expected_revision ? { expected_revision } : {}) } });
  const requests = async (sourceId: string, slug: string) => Number((await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.n);

  test('two maintenance cycles on a ghost add no receipt; a caller write records canonical_file_missing', () => fixture(async ({ root, sourceId, ctx }) => {
    const slug = 'notes/ghost-example';
    await put(ctx, slug, '---\ntype: note\ntitle: Ghost\n---\nThe original text.\n');
    unlinkSync(join(root, 'notes', 'ghost-example.md'));
    expect(await liveFileDrift(engine, sourceId, slug)).toMatchObject({ still_present: null, reason: 'canonical_file_missing' });
    const authority = (await maintenancePreflight(engine, sourceId, root))!;
    const before = await requests(sourceId, slug);
    for (const cycle of [1, 2]) {
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      const refused = await publishMaintenancePage(engine, authority, slug, `---\ntype: note\ntitle: Ghost\n---\nCycle ${cycle} text.\n`, { expectedRevision: snapshot.revision })
        .then(() => null, (error: { code?: string; detail?: string; fix?: { argv?: string[] } }) => error);
      expect(refused).toMatchObject({ code: 'source_changed', detail: 'canonical_file_missing', fix: { argv: ['gbrain', 'sources', 'reconcile', sourceId, slug, '--brain', 'host', '--preview', '--json'] } });
    }
    expect(await requests(sourceId, slug)).toBe(before);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    await put(ctx, slug, '---\ntype: note\ntitle: Ghost\n---\nA caller edit.\n', snapshot.revision).then(() => { throw new Error('committed'); }, (error: { code?: string }) => expect(error.code).toBe('source_changed'));
    const [receipt] = await engine.executeRaw<{ origin: string | null }>("SELECT error_detail->>'origin' AS origin FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='conflict' ORDER BY sequence DESC LIMIT 1", [sourceId, slug]);
    expect(receipt?.origin).toBe('canonical_file_missing');
  }), 240_000);

  test('the same refused write is held back after K refusals and admitted again after a planner bump; doctor lists it', () => fixture(async ({ root, sourceId, ctx }) => {
    const slug = 'notes/breaker-example';
    await put(ctx, slug, '---\ntype: note\ntitle: Breaker\n---\nText.\n');
    const authority = (await maintenancePreflight(engine, sourceId, root))!;
    const revision = (await engine.readPageSnapshot(slug, { sourceId }))!.revision;
    // A malformed adoption plan (one fact assigned twice) is refused at preparation every time.
    const intent = (planner: number) => ({ kind: 'managed_maintenance_adopt_fact_fence', expected_revision: revision, source_incarnation: authority.writer.sourceIncarnation,
      content: 'x', facts: [{ id: 1, row_num: 1, hash: 'h' }, { id: 1, row_num: 2, hash: 'h' }], planner });
    const submit = (planner: number) => submitDatabaseMaintenanceIntent(engine, authority, slug, intent(planner), randomUUID())
      .then(receipt => ({ admitted: true, receipt }), (error: { code?: string; detail?: string }) => ({ admitted: !error.detail || error.detail !== 'refusal_breaker', error }));
    for (let i = 0; i < 3; i++) expect((await submit(2)).admitted).toBe(true);
    const failed = await requests(sourceId, slug);
    const held = await submit(2);
    expect(held).toMatchObject({ admitted: false, error: { code: 'invalid_params', detail: 'refusal_breaker' } });
    expect(await requests(sourceId, slug)).toBe(failed);
    const doctor = await maintenanceWriteDriftCheck(engine, [sourceId]);
    expect(doctor).toMatchObject({ status: 'warn', details: { suppressed: [{ slug, error_code: 'invalid_params', refusals: 3 }] } });
    // A planner bump is a different write: admitted at once.
    expect((await submit(3)).admitted).toBe(true);
    expect(await requests(sourceId, slug)).toBe(failed + 1);
    // Threshold 0 turns the breaker off.
    await engine.setConfig(REFUSAL_BREAKER_THRESHOLD_KEY, '0');
    expect((await submit(2)).admitted).toBe(true);
  }), 240_000);
});
