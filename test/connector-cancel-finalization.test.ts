import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { LockStolenError, syncLockId } from '../src/core/db-lock.ts';
import { withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { emptyConnectorState, readManagedConnectorState, writeManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { withEnv } from './helpers/with-env.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { createConnectorFixture, options, json, googleConfig, contact, sourceCheckpoint, withGoogleAccount, completeBaselineSweep } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

// Cancellation must return the connector's partial result without advancing its
// cursor or freshness, and resume from that cursor. The Gmail delta test accepts
// AbortError, so it cannot catch the wrapper discarding the partial result.
// Uses the existing HTTP fixture boundary; no new production test seam.
test('caller cancellation preserves a partial Google result and resumable checkpoint; expired or stolen leases still refuse', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const calls: string[] = [];
    const fetcher = withGoogleAccount(async (url: string) => {
      calls.push(url);
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      if (url.includes('/people/me/connections')) return json({ connections: [contact('retained', 'Retained Contact')], nextSyncToken: 'resume-me' });
      throw new Error('Unexpected fixture route');
    });
    await completeBaselineSweep(engine, f.id, () => runGoogleSync(engine, f.id, cfg, options, fetcher));
    const checkpoint = await sourceCheckpoint(engine, f.id);
    const freshness = () => engine.executeRaw('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
    const before = await freshness();
    const controller = new AbortController();
    const cancelled = await runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, withGoogleAccount(async (url: string) => {
      if (!url.includes('/people/me/connections')) return fetcher(url);
      controller.abort();
      controller.signal.throwIfAborted();
      throw new Error('Unreachable');
    }));
    expect(cancelled.status).toBe('partial');
    expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
    expect(await freshness()).toEqual(before);
    expect((await engine.getPage('people/retained-contact', { sourceId: f.id }))?.compiled_truth).toContain('Retained Contact');
    calls.length = 0;
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).status).toBe('up_to_date');
    expect(calls.some(url => url.includes('syncToken=resume-me'))).toBe(true);
    const resumedCheckpoint = await sourceCheckpoint(engine, f.id);
    for (const loss of ['expired', 'stolen']) {
      const interrupted = new AbortController();
      await expect(runGoogleSync(engine, f.id, cfg, { ...options, signal: interrupted.signal }, withGoogleAccount(async (url: string) => {
        if (!url.includes('/people/me/connections')) return fetcher(url);
        if (loss === 'expired') {
          await engine.executeRaw("UPDATE gbrain_cycle_locks SET ttl_expires_at=now()-interval '1 second' WHERE id=$1", [syncLockId(f.id)]);
        } else {
          await engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=$2::uuid WHERE id=$1', [syncLockId(f.id), randomUUID()]);
        }
        interrupted.abort();
        interrupted.signal.throwIfAborted();
        throw new Error('Unreachable');
      }))).rejects.toBeInstanceOf(LockStolenError);
      expect(await sourceCheckpoint(engine, f.id)).toEqual(resumedCheckpoint);
    }
  }
}), 120_000);

test('cancelled hold publication keeps the failed receipt in the retry ledger', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const fetcher = withGoogleAccount(async (url: string) => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      if (url.includes('/people/me/connections')) return json({ connections: [contact('held', 'Held Contact')], nextSyncToken: 'held-cursor' });
      throw new Error('Unexpected fixture route');
    });
    await completeBaselineSweep(engine, f.id, () => runGoogleSync(engine, f.id, cfg, options, fetcher));
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [f.id]);
    const [receipt] = await engine.executeRaw<{ request_id: string; created_at: string }>(
      "SELECT request_id,created_at FROM persistence_requests WHERE source_id=$1 AND slug='people/held-contact' AND intent->>'kind'='connector_v2_import'", [f.id]);
    // Model a terminal, recovery-free failed receipt carried into this run.
    await engine.executeRaw("UPDATE persistence_requests SET state='failed',recovery=NULL WHERE request_id=$1::uuid", [receipt.request_id]);
    const entry = { itemRef: 'people/held-contact', requestId: receipt.request_id, baseRequestId: receipt.request_id,
      admittedAt: new Date(receipt.created_at).toISOString() };
    const prior = await readManagedConnectorState(engine, f.id, incarnation);
    await writeManagedConnectorState(engine, f.id, incarnation, { ...prior, pending: [entry] });
    let checkpoint = await sourceCheckpoint(engine, f.id);
    const controller = new AbortController();
    await withConnectorSync(engine, f.id, 'google', cfg, { ...options, full: true, signal: controller.signal }, async session => {
      if (!session) throw new Error('Expected managed connector');
      // An intermediate save does not prove a full sweep reached this carried
      // failure. Cancellation must not discard it as deleted upstream.
      await session.saveState({ cursor: 'intermediate-held-cursor' });
      checkpoint = await sourceCheckpoint(engine, f.id);
      // ConnectorHoldSession registers held slugs before publishing its checkpoint.
      session.holdSlugs([entry.itemRef]);
      controller.abort();
      expect(await session.publishHolds({}, { version: 1, items: { synthetic: { state: 'held', slug: entry.itemRef } } })).toBe(false);
      return { status: 'partial' };
    });
    expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
    const state = await readManagedConnectorState(engine, f.id, incarnation);
    expect(state.pending).toEqual([entry]);
    expect(state.last_run?.pending).toBe(1);
    expect(state.last_run?.checkpoint_admissions).toBe(1);
    expect(state.last_run?.dropped_upstream).toBe(0);
  }
}), 120_000);

test('cancellation after seeing a carried item but before retry admission preserves automatic retry', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const content = '---\ntitle: Retry Example\ntype: note\n---\nSynthetic retry content.\n';
    const importItem = (signal?: AbortSignal) => withConnectorSync(engine, f.id, 'google', cfg, { ...options, signal }, async session => {
      if (!session) throw new Error('Expected managed connector');
      return session.importMarkdown('notes/retry-example.md', content);
    });
    // Produce a real failed receipt with no page or replacement publication.
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION connector_cancel_page_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Synthetic connector page storage failure' USING ERRCODE='58030';
    END $$`);
    await engine.executeRaw('CREATE TRIGGER connector_cancel_page_fault BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION connector_cancel_page_fault()');
    try {
      await expect(importItem()).rejects.toMatchObject({ code: 'storage_error' });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('DROP TRIGGER connector_cancel_page_fault ON pages');
      await engine.executeRaw('DROP FUNCTION connector_cancel_page_fault()');
    }
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [f.id]);
    const [receipt] = await engine.executeRaw<{ request_id: string; created_at: string; state: string }>(
      "SELECT request_id,created_at,state FROM persistence_requests WHERE source_id=$1 AND slug='notes/retry-example'", [f.id]);
    expect(receipt.state).toBe('failed');
    const entry = { itemRef: 'notes/retry-example', requestId: receipt.request_id, baseRequestId: receipt.request_id,
      admittedAt: new Date(receipt.created_at).toISOString() };
    const prior = await readManagedConnectorState(engine, f.id, incarnation);
    await writeManagedConnectorState(engine, f.id, incarnation, { ...prior, pending: [entry] });
    const controller = new AbortController();
    await expect(withConnectorSync(engine, f.id, 'google', cfg, { ...options, signal: controller.signal }, async session => {
      if (!session) throw new Error('Expected managed connector');
      // The retry transaction starts after submit marks this item seen. Abort
      // at this existing engine boundary, before its lease validation admits it.
      const transaction = engine.transaction.bind(engine);
      const admission = spyOn(engine, 'transaction').mockImplementation(async work => {
        controller.abort();
        return transaction(work);
      });
      try {
        return await session.importMarkdown('notes/retry-example.md', content);
      } finally {
        expect(admission).toHaveBeenCalledTimes(1);
        admission.mockRestore();
      }
    })).rejects.toMatchObject({ code: 'storage_error' });
    expect((await readManagedConnectorState(engine, f.id, incarnation)).pending).toEqual([entry]);
    expect(await engine.executeRaw('SELECT request_id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(1);
    const afterRetry = new AbortController();
    const resumed = await withConnectorSync(engine, f.id, 'google', cfg, { ...options, signal: afterRetry.signal }, async session => {
      if (!session) throw new Error('Expected managed connector');
      const result = await session.importMarkdown('notes/retry-example.md', content);
      afterRetry.abort();
      return result;
    });
    expect(resumed.status).toBe('imported');
    const replacements = await engine.executeRaw<{ state: string }>(
      "SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, receipt.request_id]);
    expect(replacements).toEqual([{ state: 'committed' }]);
    expect((await readManagedConnectorState(engine, f.id, incarnation)).pending).toEqual([]);
  }
}), 120_000);

// A committed intermediate checkpoint is not proof a cancelled sweep finished.
// This pins recovery/failure bookkeeping, which the public cancellation case
// above cannot exercise because it cancels before saving a new checkpoint.
test('cancellation after a committed checkpoint keeps recovery and prior failure state', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [f.id]);
    const failure = { code: 'connector_error', message: 'Synthetic previous failure', slug: null, request_id: null, at: '2026-01-01T00:00:00Z', consecutive: 3 };
    await writeManagedConnectorState(engine, f.id, incarnation, { ...emptyConnectorState(), upgrade_recovery: 'rewalking_once', last_failure: failure });
    const controller = new AbortController();
    const result = await withConnectorSync(engine, f.id, 'google', cfg, { ...options, full: true, signal: controller.signal }, async session => {
      if (!session) throw new Error('Expected managed connector');
      await session.saveState({ cursor: 'intermediate' });
      controller.abort();
      return { status: 'partial' };
    });
    expect(result.status).toBe('partial');
    const state = await readManagedConnectorState(engine, f.id, incarnation);
    expect(state.upgrade_recovery).toBe('rewalking_once');
    expect(state.last_failure).toEqual(failure);
    expect(state.last_run?.checkpoint_admissions).toBe(1);
    expect(state.last_run?.dropped_upstream).toBe(0);
  }
}), 120_000);
