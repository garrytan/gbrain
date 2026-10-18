/**
 * GBRA-130 A-2: one refused or still-pending transcript part never aborts the
 * transcripts ingest, and through it the ChatGPT/Claude connector batch.
 *
 * 1. Protects: a session the coordinator refuses is reported per session with
 *    its typed code while the other sessions land; an accepted write that
 *    outlasts the wait is a pending session (never a failure, never synced);
 *    a rerun waits on that write instead of admitting a duplicate; a pending
 *    write that ends without committing is re-queued; a page deleted and
 *    retention-purged since its write is created again instead of answered
 *    with the old committed receipt, while an owner purge still refuses it
 *    purged_content; the connector watermark never passes a pending or
 *    failed conversation.
 * 2. Regression: the per-part catch treating anything but /too large|invalid
 *    byte sequence/ as a run abort, a random request id per run, or a
 *    committed receipt replayed for a page that no longer exists.
 * 3. Existing coverage stubs the ingest result (connectors-ingest-failure) or
 *    pins the regex seam (transcripts-nul); none drives a real coordinator
 *    refusal or a real accepted write that commits after the wait.
 * 4. No production seam: the bad states are a canonical file edited outside
 *    coordination and a paused owner (worktree draining).
 */
import { describe, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { runTranscriptsIngest, type TranscriptsIngestResult } from '../../src/core/transcripts/ingest.ts';
import { runConnectorSync } from '../../src/core/connectors/sync.ts';
import { saveCredential } from '../../src/core/connectors/credentials.ts';
import { connectorSourceKey } from '../../src/core/connectors/config-keys.ts';
import { CHATGPT_BASE_URL } from '../../src/core/connectors/providers/chatgpt.ts';
import { waitForWrites } from '../../src/core/persistence/service.ts';
import { purgeDeletedPagesCoordinated } from '../../src/core/persistence/purge-deleted.ts';
import { operations } from '../../src/core/operations.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { chatgptHandler, newFixtureState, startFixture, type FixtureConversation, type FixtureState } from '../fixtures/connectors/fixture-server.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const T0 = 1_786_080_000;
const message = (role: string, t: number, text: string) => ({ author: { role }, create_time: t, content: { content_type: 'text', parts: [text] } });
const exportConversation = (id: string, t: number, text: string) => ({ title: `Conversation ${id}`, create_time: t, update_time: t + 15,
  conversation_id: id, current_node: 'n2', mapping: { root: { id: 'root', parent: null, children: ['n1'], message: null },
    n1: { id: 'n1', parent: 'root', children: ['n2'], message: message('user', t + 5, text) },
    n2: { id: 'n2', parent: 'n1', children: [], message: message('assistant', t + 15, `An answer to ${text}.`) } } });

function exportFile(root: string, texts: Record<string, string>): string {
  const path = join(root, '..', 'export.json');
  writeFileSync(path, JSON.stringify(Object.entries(texts).map(([id, text], i) => exportConversation(id, T0 + i * 1000, text))));
  return path;
}

const ingest = (engine: BrainEngine, ctx: OperationContext, path: string, writeWaitMs?: number) =>
  runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', format: 'chatgpt', context: writeWaitMs === undefined ? ctx : { ...ctx, writeWaitMs } });

const sessions = (r: TranscriptsIngestResult) => new Map(r.files.flatMap(f => f.sessions).map(s => [s.sessionId, s]));
const slugOf = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ slug: string; source_path: string }>(
  "SELECT slug, source_path FROM pages WHERE source_id='default' AND frontmatter->'transcript_import'->>'session_id' = $1 AND deleted_at IS NULL ORDER BY slug", [id]))[0]!;
const putPageRequests = async (engine: BrainEngine) => engine.executeRaw<WriteRequest>(
  "SELECT * FROM persistence_requests WHERE source_id='default' AND operation='put_page' ORDER BY sequence");

/** Pauses or resumes the canonical owner: a draining worktree admits writes and publishes none. */
async function owner(engine: BrainEngine, state: 'draining' | 'active'): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("UPDATE persistence_worktrees SET state=$1 WHERE id IN (SELECT worktree_id FROM persistence_source_bindings WHERE source_id='default')", [state]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

async function settle(engine: BrainEngine): Promise<WriteRequest[]> {
  const rows = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' ORDER BY sequence");
  return waitForWrites(engine, rows, { engine: engine.kind }, 30_000);
}

/** The bad state: a conversation page whose canonical file carries an edit made outside coordinated publication. */
async function editOutsideCoordination(engine: BrainEngine, root: string, id: string): Promise<() => void> {
  const file = join(root, (await slugOf(engine, id)).source_path);
  const original = readFileSync(file, 'utf8');
  appendFileSync(file, '\nAn edit made outside coordinated publication.\n');
  return () => writeFileSync(file, original);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-2 transcripts ingest (${backend})`, () => {
    test('item: a session the coordinator refuses is reported with its code and the other sessions land', async () => managedBrain(async ({ engine, ctx, root }) => {
      await ingest(engine, ctx, exportFile(root, { 'c-1': 'one', 'c-2': 'two', 'c-3': 'three' }));
      const restore = await editOutsideCoordination(engine, root, 'c-2');
      const before = await snapshotItems(engine, 'default');
      const path = exportFile(root, { 'c-1': 'one edited', 'c-2': 'two edited', 'c-3': 'three edited' });
      const result = await expectUnitNotAborted(() => ingest(engine, ctx, path));
      const c2 = sessions(result).get('c-2')!;
      expectItemFailure({ key: c2.sessionId, code: c2.code }, { key: 'c-2', code: 'source_changed' });
      expect(result).toMatchObject({ sessionsErrored: 1, sessionsImported: 2, cleanScan: false });
      const [one, three] = [await slugOf(engine, 'c-1'), await slugOf(engine, 'c-3')];
      expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { expectProgress: [one.slug, three.slug], progressFields: ['content_hash'] });
      // Recovery: once the canonical file is back to its committed bytes, the same rerun lands the session.
      restore();
      const again = await ingest(engine, ctx, path);
      expect(again).toMatchObject({ sessionsErrored: 0, sessionsImported: 3, cleanScan: true });
    }, { databaseUrl }), 180_000);

    test('pending: an accepted write that outlasts the wait stays pending under one request id and lands later without a duplicate admission', async () => managedBrain(async ({ engine, ctx, root }) => {
      const path = exportFile(root, { 'c-1': 'one', 'c-2': 'two', 'c-3': 'three' });
      await owner(engine, 'draining');
      const first = await expectUnitNotAborted(() => ingest(engine, ctx, path, 50));
      expect(first).toMatchObject({ sessionsPending: 3, sessionsErrored: 0, sessionsImported: 0, cleanScan: false });
      const ids = [...sessions(first).values()].map(s => s.pending);
      expect(ids.every(id => id?.length === 1)).toBe(true);
      const second = await expectUnitNotAborted(() => ingest(engine, ctx, path, 50));
      expect([...sessions(second).values()].map(s => s.pending)).toEqual(ids);
      expect((await putPageRequests(engine)).length).toBe(3);
      await owner(engine, 'active');
      expect((await settle(engine)).map(row => row.state)).toEqual(['committed', 'committed', 'committed']);
      const third = await ingest(engine, ctx, path);
      expect(third).toMatchObject({ sessionsPending: 0, sessionsImported: 3, cleanScan: true, pages: { imported: 0, skipped: 3 } });
      expect((await putPageRequests(engine)).length).toBe(3);
    }, { databaseUrl }), 180_000);

    test('recovery: a pending write that ends without committing is re-queued under a new request and lands', async () => managedBrain(async ({ engine, ctx, root }) => {
      await ingest(engine, ctx, exportFile(root, { 'c-1': 'one' }));
      const path = exportFile(root, { 'c-1': 'one edited' });
      await owner(engine, 'draining');
      const pending = await ingest(engine, ctx, path, 50);
      expect(pending.sessionsPending).toBe(1);
      const restore = await editOutsideCoordination(engine, root, 'c-1');
      await owner(engine, 'active');
      expect((await settle(engine)).map(row => row.state)).toEqual(['committed', 'conflict']);
      restore();
      const retried = await expectUnitNotAborted(() => ingest(engine, ctx, path));
      expect(retried).toMatchObject({ sessionsPending: 0, sessionsErrored: 0, sessionsImported: 1, cleanScan: true });
      expect((await putPageRequests(engine)).map(row => row.state)).toEqual(['committed', 'conflict', 'committed']);
    }, { databaseUrl }), 180_000);

    test('recovery: an identical re-ingest after the page was deleted and retention-purged admits a new creation instead of replaying the old receipt', async () => managedBrain(async ({ engine, ctx, root }) => {
      const path = exportFile(root, { 'c-1': 'one' });
      expect(await ingest(engine, ctx, path)).toMatchObject({ sessionsImported: 1, sessionsErrored: 0 });
      const { slug } = await slugOf(engine, 'c-1');
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      await operations.find(op => op.name === 'delete_page')!.handler(ctx, { slug, expected_revision: snapshot!.revision, request_id: crypto.randomUUID() });
      expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toEqual([slug]);
      expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
      const again = await expectUnitNotAborted(() => ingest(engine, ctx, path));
      expect(again).toMatchObject({ sessionsImported: 1, sessionsErrored: 0, sessionsPending: 0, cleanScan: true });
      expect((await slugOf(engine, 'c-1')).slug).toBe(slug);
      expect((await putPageRequests(engine)).map(row => row.state)).toEqual(['committed', 'committed']);
      const rerun = await ingest(engine, ctx, path);
      expect(rerun).toMatchObject({ sessionsImported: 1, sessionsErrored: 0, pages: { imported: 0, skipped: 1 } });
      expect((await putPageRequests(engine)).length).toBe(2);
    }, { databaseUrl }), 180_000);

    test('item: an identical re-ingest after the owner purged the page is refused purged_content, never replayed or re-created', async () => managedBrain(async ({ engine, ctx, root }) => {
      const path = exportFile(root, { 'c-1': 'one' });
      await ingest(engine, ctx, path);
      const { slug } = await slugOf(engine, 'c-1');
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      await operations.find(op => op.name === 'delete_page')!.handler(ctx, { slug, purge: true, expected_revision: snapshot!.revision, request_id: crypto.randomUUID() });
      await purgeDeletedPagesCoordinated(engine, 0);
      const again = await expectUnitNotAborted(() => ingest(engine, ctx, path));
      const c1 = sessions(again).get('c-1')!;
      expectItemFailure({ key: c1.sessionId, code: c1.code }, { key: 'c-1', code: 'purged_content' });
      expect(again).toMatchObject({ sessionsErrored: 1, sessionsImported: 0 });
      expect((await putPageRequests(engine)).map(row => [row.state, row.error_code])).toEqual([['committed', null], ['failed', 'purged_content']]);
      expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
      const rerun = await ingest(engine, ctx, path);
      expect(sessions(rerun).get('c-1')?.code).toBe('purged_content');
      expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
    }, { databaseUrl }), 180_000);

    for (const injected of runScopedErrors()) {
      test(`run: a run-scoped failure inside a session stops the ingest (${injected.name})`, async () => managedBrain(async ({ engine, ctx, root }) => {
        const path = exportFile(root, { 'c-1': 'one', 'c-2': 'two', 'c-3': 'three' });
        const error = injected.error();
        let calls = 0;
        const failing = new Proxy(engine, { get(target, key) {
          const value = (target as unknown as Record<string | symbol, unknown>)[key];
          if (key === 'readPageSnapshot') return async (...args: unknown[]) => { if (++calls === 2) throw error; return (value as (...a: unknown[]) => unknown).apply(target, args); };
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        } });
        await expect(ingest(failing, ctx, path)).rejects.toBe(error);
      }, { databaseUrl }), 120_000);
    }

    test('breaker: when most sessions are refused the ingest stops item_failures_systemic', async () => managedBrain(async ({ engine, ctx, root }) => {
      const ids = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6'];
      await ingest(engine, ctx, exportFile(root, Object.fromEntries(ids.map(id => [id, id]))));
      for (const id of ids.slice(0, 5)) await editOutsideCoordination(engine, root, id);
      await expect(ingest(engine, ctx, exportFile(root, Object.fromEntries(ids.map(id => [id, `${id} edited`])))))
        .rejects.toMatchObject({ code: 'item_failures_systemic' });
    }, { databaseUrl }), 180_000);
  });

  describe(`A-2 connector sync (${backend})`, () => {
    const NOW_MS = (T0 + 100_000) * 1000;
    const conv = (id: string, updateTime: number, text = `question ${id}`): FixtureConversation => ({ id, title: `Title ${id}`,
      createTime: updateTime - 100, updateTime, turns: [{ role: 'user', text }, { role: 'assistant', text: `answer ${id}` }] });
    const sync = async (engine: BrainEngine, ctx: OperationContext, state: FixtureState, writeWaitMs?: number,
      runIngest: typeof runTranscriptsIngest = (eng, opts) => runTranscriptsIngest(eng, { ...opts, context: writeWaitMs === undefined ? ctx : { ...ctx, writeWaitMs } })) => {
      saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
      const srv = startFixture(chatgptHandler(state));
      try {
        return await runConnectorSync(engine, { provider: 'chatgpt', sourceId: 'default', deps: {
          fetchImpl: (url, init) => fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init), now: () => NOW_MS, sleep: () => Promise.resolve(), runIngest } });
      } finally { srv.stop(); }
    };
    const ledger = async (engine: BrainEngine, which: 'synced' | 'failed') => JSON.parse(await engine.getConfig(connectorSourceKey('chatgpt', 'default', which)) ?? '{}');

    test('item: a conversation whose ingest is refused is counted toward quarantine and the batch siblings sync', async () => managedBrain(async ({ engine, ctx, root }) => {
      const state = newFixtureState([conv('c-1', T0 + 10), conv('c-2', T0 + 20), conv('c-3', T0 + 30)]);
      await sync(engine, ctx, state);
      const restore = await editOutsideCoordination(engine, root, 'c-2');
      state.conversations = [conv('c-1', T0 + 40, 'one edited'), conv('c-2', T0 + 50, 'two edited'), conv('c-3', T0 + 60, 'three edited')];
      const before = await snapshotItems(engine, 'default');
      const results = [];
      for (let run = 0; run < 3; run++) results.push(await expectUnitNotAborted(() => sync(engine, ctx, state)));
      const failed = await ledger(engine, 'failed');
      expectItemFailure({ key: Object.keys(failed)[0], code: failed['c-2']?.code }, { key: 'c-2', code: 'source_changed' });
      expect(results.map(r => r.watermarkAdvancedTo)).toEqual([undefined, undefined, new Date((T0 + 60) * 1000).toISOString()]);
      expect(results[2].quarantined).toEqual(['c-2']);
      const iso = (t: number) => new Date(t * 1000).toISOString();
      expect(await ledger(engine, 'synced')).toEqual({ 'c-1': iso(T0 + 40), 'c-2': iso(T0 + 20), 'c-3': iso(T0 + 60) });
      const [one, three] = [await slugOf(engine, 'c-1'), await slugOf(engine, 'c-3')];
      expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { expectProgress: [one.slug, three.slug], progressFields: ['content_hash'] });
      restore();
      state.conversations[1] = conv('c-2', T0 + 70, 'two edited again');
      const recovered = await sync(engine, ctx, state);
      expect(recovered.unresolved).toBe(0);
      expect(await ledger(engine, 'failed')).toEqual({});
    }, { databaseUrl }), 240_000);

    test('pending: a conversation whose write is still pending holds the watermark, is never marked synced, and lands later without a duplicate admission', async () => managedBrain(async ({ engine, ctx }) => {
      const state = newFixtureState([conv('c-1', T0 + 10), conv('c-2', T0 + 20)]);
      await owner(engine, 'draining');
      const first = await expectUnitNotAborted(() => sync(engine, ctx, state, 50));
      expect(first.status).toBe('partial');
      expect([...first.pending].sort()).toEqual(['c-1', 'c-2']);
      expect(first.watermarkAdvancedTo).toBeUndefined();
      expect(await ledger(engine, 'synced')).toEqual({});
      expect(await ledger(engine, 'failed')).toEqual({});
      const second = await expectUnitNotAborted(() => sync(engine, ctx, state, 50));
      expect(second.watermarkAdvancedTo).toBeUndefined();
      expect((await putPageRequests(engine)).length).toBe(2);
      await owner(engine, 'active');
      await settle(engine);
      const third = await sync(engine, ctx, state);
      expect(third.pending).toEqual([]);
      expect(third.watermarkAdvancedTo).toBe(new Date((T0 + 20) * 1000).toISOString());
      expect(Object.keys(await ledger(engine, 'synced')).sort()).toEqual(['c-1', 'c-2']);
      expect((await putPageRequests(engine)).map(row => row.state)).toEqual(['committed', 'committed']);
    }, { databaseUrl }), 240_000);

    test('recovery: a pending conversation write that ends in conflict is re-queued, never marked synced, and lands on the next run', async () => managedBrain(async ({ engine, ctx, root }) => {
      const state = newFixtureState([conv('c-1', T0 + 10)]);
      await sync(engine, ctx, state);
      state.conversations = [conv('c-1', T0 + 20, 'one edited')];
      await owner(engine, 'draining');
      expect((await sync(engine, ctx, state, 50)).pending).toEqual(['c-1']);
      const restore = await editOutsideCoordination(engine, root, 'c-1');
      await owner(engine, 'active');
      await settle(engine);
      expect((await ledger(engine, 'synced'))['c-1']).toBe(new Date((T0 + 10) * 1000).toISOString());
      restore();
      const retried = await sync(engine, ctx, state);
      expect(retried.watermarkAdvancedTo).toBe(new Date((T0 + 20) * 1000).toISOString());
      expect((await ledger(engine, 'synced'))['c-1']).toBe(new Date((T0 + 20) * 1000).toISOString());
      expect((await putPageRequests(engine)).map(row => row.state)).toEqual(['committed', 'conflict', 'committed']);
    }, { databaseUrl }), 240_000);

    for (const injected of runScopedErrors()) {
      test(`run: a run-scoped failure inside the connector ingest stops the sync and records no failure (${injected.name})`, async () => managedBrain(async ({ engine, ctx }) => {
        const state = newFixtureState([conv('c-1', T0 + 10), conv('c-2', T0 + 20)]);
        const error = injected.error();
        await expect(sync(engine, ctx, state, undefined, async () => { throw error; })).rejects.toBe(error);
        expect(await ledger(engine, 'failed')).toEqual({});
        expect(await ledger(engine, 'synced')).toEqual({});
        expect(await engine.getConfig(connectorSourceKey('chatgpt', 'default', 'watermark_iso'))).toBeNull();
      }, { databaseUrl }), 120_000);
    }
  });
}
