/**
 * GBRA-130 A-4: a managed synthesis output whose postprocess publish was deferred (#5854/#6757) is carried in
 * `dream.synthesize.postprocess_pending`; when its request later ends without committing (a user edit before the
 * coordinator publishes ends it `revision_conflict`), or its retained intent no longer matches, the output is a
 * per-output conflict that is reported once and dropped, and every other output still finishes in the same pass.
 *
 * Authoring gate:
 * 1. Protects: a terminal postprocess request never fails the synthesize phase on every pass (which withholds the
 *    global-maintenance stamp); one output's error never stops the outputs after it; run-scoped errors still stop.
 * 2. Regression: rethrowing the terminal receipt (`writeResponse(prior)`), throwing `recovery_required` for a
 *    mismatched intent, or letting one output's error leave the loop before `recordPostprocessPass`.
 * 3. test/managed-synthesis-postprocess.test.ts covers a page moved after the child commit (#6360), not a request
 *    that was carried and then ended terminal, and never two outputs in one pass with one failing.
 * 4. No production seam: the bad states are journal rows edited directly; other errors are injected by spying the
 *    journal read the loop already makes.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PhaseResult } from '../../src/core/cycle.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../../src/core/cycle/synthesize.ts';
import { POSTPROCESS_CONFLICTS_KEY } from '../../src/core/cycle/synthesize-postprocess.ts';
import { POSTPROCESS_PENDING_KEY } from '../../src/core/cycle/synthesize-postprocess-deferral.ts';
import * as journal from '../../src/core/persistence/journal.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';
import { acquireWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { childCommittedOrdinaryCycle, managedSynthesisFixture, type SynthesisFixture } from '../helpers/managed-synthesis-fixture.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { editRequest } from '../helpers/persistence-request-fixture.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

type Ordinary = Parameters<typeof runPhaseSynthesize>[1];
interface OutputRequest { id: string; request_id: string; slug: string }

const outputRequests = (engine: BrainEngine, sourceId: string) => engine.executeRaw<OutputRequest>(
  "SELECT id::text, request_id::text, slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_page' ORDER BY slug", [sourceId]);
const pendingEntry = async (engine: BrainEngine, sourceId: string) =>
  (JSON.parse(await engine.getConfig(POSTPROCESS_PENDING_KEY) ?? '{}') as Record<string, { pending: Array<{ slug: string }> } | undefined>)[sourceId];
const outputSlugs = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session%' ORDER BY slug", [sourceId])).map(r => r.slug);
const summaries = (snapshot: Map<string, unknown>) => [...snapshot.keys()].filter(slug => slug.startsWith('dream-cycle-summaries/'));

/** Runs one pass while the source's worktree is held, so every postprocess publish waits 300 ms and is carried. */
async function underHeldWorktree(engine: BrainEngine, sourceId: string, run: () => Promise<PhaseResult>): Promise<PhaseResult> {
  const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
  __setMaintenanceWriteWaitForTests(300);
  try { return await run(); }
  finally { __setMaintenanceWriteWaitForTests(null); await disposePersistenceConsumer(engine); await lock.release(); }
}

/** Two child outputs committed; their postprocess publishes are deferred and carried. */
async function carriedOutputs(f: SynthesisFixture): Promise<{ ordinary: Ordinary; requests: OutputRequest[] }> {
  const { engine, sourceId } = f;
  const { ordinary } = await childCommittedOrdinaryCycle(f);
  const deferred = await underHeldWorktree(engine, sourceId, () => runPhaseSynthesize(engine, ordinary));
  expect(deferred.status, deferred.summary).toBe('warn');
  expect(deferred.details.publish_pending).toBe(2);
  const requests = await outputRequests(engine, sourceId);
  expect(requests.length).toBe(2);
  expect((await pendingEntry(engine, sourceId))?.pending.map(p => p.slug).sort()).toEqual(requests.map(r => r.slug));
  return { ordinary, requests };
}

/** The coordinator ended the output's postprocess request without committing it, as a user edit before publication does. */
const endInConflict = (engine: BrainEngine, request: OutputRequest) => editRequest(engine, request.id,
  "state='conflict',error_code='revision_conflict',error_message='The target changed since it was read.',execution_token=NULL,claim_expires_at=NULL,completed_at=now()");

for (const arm of pathologicalArms()) {
  describe(`A-4 synthesize postprocess (${arm.backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      if (arm.backend === 'pglite') {
        const dir = mkdtempSync(join(tmpdir(), 'gbrain-a4-'));
        const pglite = new PGLiteEngine();
        await pglite.connect({ database_path: dir });
        await pglite.initSchema();
        engine = pglite;
        close = async () => { await pglite.disconnect(); rmSync(dir, { recursive: true, force: true }); };
      } else {
        const pg = await isolatedPersistencePostgres(arm.databaseUrl!);
        engine = pg.engine;
        close = pg.close;
      }
    }, 120_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close(); resetGateway(); });
    const fixture = (run: (f: SynthesisFixture) => Promise<void>, outputs = 2) => managedSynthesisFixture([engine], run, outputs);

    test('A-4 item: a carried output whose postprocess request ended revision_conflict is reported and dropped while the other carried output lands', async () => {
      await fixture(async f => {
        const { sourceId, calls } = f;
        const { ordinary, requests: [bad, healthy] } = await carriedOutputs(f);
        await endInConflict(engine, bad!);
        const spent = calls();
        const before = await snapshotItems(engine, sourceId);
        const result = await expectUnitNotAborted(() => runPhaseSynthesize(engine, ordinary));
        expect(result.status, result.summary).toBe('warn');
        expect(result.summary).toContain(bad!.slug);
        const conflicts = (result.details.postprocess_conflicts ?? []) as Array<{ slug: string; code: string; fix: { argv: string[] } }>;
        expect(conflicts.length).toBe(1);
        expectItemFailure({ key: conflicts[0]!.slug, code: conflicts[0]!.code, fix: conflicts[0]!.fix.argv.join(' ') },
          { key: bad!.slug, code: 'revision_conflict', fix: new RegExp(`^gbrain write-request -- ${bad!.request_id}$`) });
        const after = await snapshotItems(engine, sourceId);
        expectOthersUnchanged(before, after, { changed: summaries(after), expectProgress: [healthy!.slug] });
        expect(result.details.written_slugs).toEqual([healthy!.slug]);
        expect(await pendingEntry(engine, sourceId)).toBeUndefined();
        expect(calls()).toBe(spent);
        const again = await runPhaseSynthesize(engine, ordinary);
        expect(again.status, again.summary).toBe('ok');
        expect(again.details.postprocess_conflicts).toBeUndefined();
      });
    }, 180_000);

    test('A-4 item: a carried output whose retained postprocess intent no longer matches is reported recovery_required and dropped', async () => {
      await fixture(async f => {
        const { sourceId } = f;
        const { ordinary, requests: [bad, healthy] } = await carriedOutputs(f);
        await editRequest(engine, bad!.id, "intent=jsonb_set(intent,'{expected_revision}',to_jsonb('mismatched-revision'::text))");
        const before = await snapshotItems(engine, sourceId);
        const result = await expectUnitNotAborted(() => underHeldWorktree(engine, sourceId, () => runPhaseSynthesize(engine, ordinary)));
        expect(result.status, result.summary).toBe('warn');
        const conflicts = (result.details.postprocess_conflicts ?? []) as Array<{ slug: string; code: string; fix: { argv: string[] } }>;
        expectItemFailure(conflicts[0] && { key: conflicts[0].slug, code: conflicts[0].code, fix: conflicts[0].fix.argv.join(' ') },
          { key: bad!.slug, code: 'recovery_required', fix: new RegExp(`^gbrain write-request -- ${bad!.request_id}$`) });
        expect(result.details.publish_pending).toBe(1);
        expect((await pendingEntry(engine, sourceId))?.pending.map(p => p.slug)).toEqual([healthy!.slug]);
        const after = await snapshotItems(engine, sourceId);
        expectOthersUnchanged(before, after, { changed: summaries(after) });
      });
    }, 180_000);

    test('A-4 run: a run-scoped error while reading a carried output stops the pass and records nothing', async () => {
      await fixture(async f => {
        const { sourceId } = f;
        const { ordinary, requests } = await carriedOutputs(f);
        await endInConflict(engine, requests[0]!);
        const pendingBefore = await engine.getConfig(POSTPROCESS_PENDING_KEY);
        const conflictsBefore = await engine.getConfig(POSTPROCESS_CONFLICTS_KEY);
        const before = await snapshotItems(engine, sourceId);
        const read = journal.getWriteRequest;
        for (const { name, error } of runScopedErrors()) {
          let injected = 0;
          const spy = spyOn(journal, 'getWriteRequest').mockImplementation(async (...args) => {
            if (!injected++) throw error();
            return read(...args);
          });
          let outcome: { status?: string; thrown?: string };
          try {
            const result = await runPhaseSynthesize(engine, ordinary);
            outcome = { status: result.status };
          } catch (e) { outcome = { thrown: e instanceof Error ? e.name : String(e) }; }
          finally { spy.mockRestore(); await disposePersistenceConsumer(engine); }
          expect({ name, injected: injected > 0, stopped: outcome.thrown !== undefined || outcome.status === 'fail' }).toEqual({ name, injected: true, stopped: true });
          expect({ name, pending: await engine.getConfig(POSTPROCESS_PENDING_KEY) }).toEqual({ name, pending: pendingBefore });
          expect({ name, conflicts: await engine.getConfig(POSTPROCESS_CONFLICTS_KEY) }).toEqual({ name, conflicts: conflictsBefore });
          expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
        }
      });
    }, 240_000);

    test('A-4 breaker: when every output fails the pass stops item_failures_systemic and carries or reports nothing', async () => {
      await fixture(async f => {
        const { sourceId } = f;
        const { ordinary } = await childCommittedOrdinaryCycle(f);
        const before = await snapshotItems(engine, sourceId);
        const conflictsBefore = await engine.getConfig(POSTPROCESS_CONFLICTS_KEY);
        const spy = spyOn(journal, 'getWriteRequest').mockImplementation(async () => { throw new TypeError('synthetic postprocess read failure'); });
        let result: PhaseResult;
        try { result = await runPhaseSynthesize(engine, ordinary); } finally { spy.mockRestore(); await disposePersistenceConsumer(engine); }
        expect(result.status).toBe('fail');
        expect(result.details.error_code).toBe('item_failures_systemic');
        expect(await pendingEntry(engine, sourceId)).toBeUndefined();
        expect(await engine.getConfig(POSTPROCESS_CONFLICTS_KEY)).toBe(conflictsBefore);
        expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
      }, 5);
    }, 240_000);

    test('A-4 recovery: an output whose postprocess failed transiently does not stop the next output, and the next pass retries it and it lands', async () => {
      await fixture(async f => {
        const { sourceId, calls } = f;
        const { ordinary } = await childCommittedOrdinaryCycle(f);
        const [first, second] = await outputSlugs(engine, sourceId);
        const spent = calls();
        const before = await snapshotItems(engine, sourceId);
        const read = journal.getWriteRequest;
        let hits = 0;
        const spy = spyOn(journal, 'getWriteRequest').mockImplementation(async (...args) => {
          if (!hits++) throw new TypeError('synthetic postprocess read failure');
          return read(...args);
        });
        let failed: PhaseResult;
        try { failed = await runPhaseSynthesize(engine, ordinary); } finally { spy.mockRestore(); await disposePersistenceConsumer(engine); }
        expect(failed.status).toBe('fail');
        expect(failed.error?.message).toContain('synthetic postprocess read failure');
        const mid = await snapshotItems(engine, sourceId);
        expect(mid.get(first!)).toEqual(before.get(first!));
        expectOthersUnchanged(before, mid, { changed: summaries(mid), expectProgress: [second!] });
        const next = await runPhaseSynthesize(engine, ordinary);
        expect(next.status, next.summary).toBe('ok');
        expect(next.details.written_slugs).toEqual([first]);
        const after = await snapshotItems(engine, sourceId);
        expectOthersUnchanged(mid, after, { changed: summaries(after), expectProgress: [first!] });
        expect(calls()).toBe(spent);
      });
    }, 240_000);
  });
}
