/**
 * #5012 item 8: the store SQL behind mute/unmute, `loops drop sender`, the
 * one-shot withheld-sender backfill and the opt-in Updates reciprocity set,
 * on every test backend (PGLite always; Postgres when DATABASE_URL is set,
 * run by test/e2e/loops-noise-5012-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  addSuppression,
  closeMutedLoops,
  listSenderInboundLoops,
  loadSuppressions,
  muteRecheckThreads,
  removeSuppression,
  requeueMutedLoops,
  settleMuteRecheck,
  upsertOpenLoop,
  type OpenLoopUpsert,
} from '../src/core/loops/loops-store.ts';
import { seedLoopRechecks } from '../src/core/google/loop-catchup.ts';
import { ownerWroteToFor, __clearReciprocityCacheForTests } from '../src/core/google/loops-reciprocity.ts';
import type { GoogleSourceState } from '../src/core/google/types.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: Array<{ backend: string; engine: BrainEngine; close: () => Promise<void> }> = [];
const ALERTS = 'alerts@bank-example.test';
const CAROL = 'carol@example.com';
const OLD = '2026-08-01T00:00:00Z';
const NEWER = '2026-08-20T00:00:00Z';

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_url: '' });
      await engine.initSchema();
      engines.push({ backend, engine, close: () => engine.disconnect() });
    } else {
      engines.push({ backend, ...(await isolatedPersistencePostgres(process.env.DATABASE_URL!)) });
    }
  }
}, 120_000);

afterAll(async () => {
  for (const e of engines) await e.close();
});

async function source(engine: BrainEngine, id: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"kind":"google"}'::jsonb) ON CONFLICT (id) DO NOTHING`, [id]);
}

function loop(sourceId: string, threadId: string | null, over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId,
    dedupKey: `thread:${threadId ?? 'none'}:${over.counterpartyEmail ?? ALERTS}:unanswered_inbound`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: ALERTS,
    summary: 'Reply owed: "Balance alert"',
    evidence: [{ message_id: 'm1', quote: 'Your balance is low.' }],
    threadId,
    detector: 'deterministic_thread',
    lastActivityAt: OLD,
    ...over,
  };
}

async function row(engine: BrainEngine, id: number): Promise<{ status: string; closed_by: string | null }> {
  const rows = await engine.executeRaw<{ status: string; closed_by: string | null }>(`SELECT status, closed_by FROM open_loops WHERE id = $1`, [id]);
  return rows[0];
}

describe('#5012 loop noise store SQL on every backend', () => {
  test('mute closes, a sweep never reopens a muted loop, unmute re-queues, a re-check settles', async () => {
    for (const { backend, engine } of engines) {
      const src = 'g-mute';
      await source(engine, src);
      const a = await upsertOpenLoop(engine, loop(src, '18c2f4a9b3d21f01'));
      const noThread = await upsertOpenLoop(engine, loop(src, null));
      const other = await upsertOpenLoop(engine, loop(src, '18c2f4a9b3d21f02', { counterpartyEmail: CAROL }));

      await addSuppression(engine, src, 'sender', ALERTS);
      expect(await closeMutedLoops(engine, src, 'sender', ALERTS, false), backend).toEqual([a.id, noThread.id].sort((x, y) => x - y));
      expect((await row(engine, a.id)).status, backend).toBe('open');
      expect(await closeMutedLoops(engine, src, 'sender', ALERTS, true), backend).toEqual([a.id, noThread.id].sort((x, y) => x - y));
      expect(await row(engine, a.id), backend).toEqual({ status: 'dropped', closed_by: 'muted' });
      expect((await row(engine, other.id)).status, backend).toBe('open');

      const again = await upsertOpenLoop(engine, loop(src, '18c2f4a9b3d21f01', { lastActivityAt: NEWER }));
      expect(again.applied, backend).toBe(false);
      expect(await row(engine, a.id), backend).toEqual({ status: 'dropped', closed_by: 'muted' });

      expect(await removeSuppression(engine, src, 'sender', ALERTS), backend).toBe(1);
      expect(await requeueMutedLoops(engine, src, 'sender', ALERTS, false), backend).toEqual({ requeued: [a.id], unverifiable: [noThread.id] });
      expect(await requeueMutedLoops(engine, src, 'sender', ALERTS, true), backend).toEqual({ requeued: [a.id], unverifiable: [noThread.id] });
      expect(await row(engine, a.id), backend).toEqual({ status: 'dropped', closed_by: 'mute_recheck' });
      expect(await row(engine, noThread.id), backend).toEqual({ status: 'dropped', closed_by: 'unmuted' });
      expect(await muteRecheckThreads(engine, src), backend).toEqual([{ thread_id: '18c2f4a9b3d21f01', page_slug: null }]);
      expect([...((await loadSuppressions(engine, src)).recheckThreads ?? [])], backend).toEqual(['18c2f4a9b3d21f01']);

      const reopened = await upsertOpenLoop(engine, loop(src, '18c2f4a9b3d21f01'));
      expect(reopened.applied, backend).toBe(true);
      expect(await row(engine, a.id), backend).toEqual({ status: 'open', closed_by: null });

      await addSuppression(engine, src, 'sender', ALERTS);
      await closeMutedLoops(engine, src, 'sender', ALERTS, true);
      await removeSuppression(engine, src, 'sender', ALERTS);
      await requeueMutedLoops(engine, src, 'sender', ALERTS, true);
      expect(await settleMuteRecheck(engine, src, '18c2f4a9b3d21f01'), backend).toBe(1);
      expect(await row(engine, a.id), backend).toEqual({ status: 'dropped', closed_by: 'unmuted' });
      expect(await muteRecheckThreads(engine, src), backend).toEqual([]);
    }
  });

  test('unmute leaves a loop another suppression still covers', async () => {
    for (const { backend, engine } of engines) {
      const src = 'g-cover';
      await source(engine, src);
      const a = await upsertOpenLoop(engine, loop(src, '18c2f4a9b3d21f03'));
      await addSuppression(engine, src, 'sender', ALERTS);
      await addSuppression(engine, src, 'thread', '18c2f4a9b3d21f03');
      await closeMutedLoops(engine, src, 'sender', ALERTS, true);
      await removeSuppression(engine, src, 'sender', ALERTS);
      expect(await requeueMutedLoops(engine, src, 'sender', ALERTS, true), backend).toEqual({ requeued: [], unverifiable: [] });
      expect(await row(engine, a.id), backend).toEqual({ status: 'dropped', closed_by: 'muted' });
    }
  });

  test('drop sender lists only that sender, and the backfill picks each sender\'s newest thread', async () => {
    for (const { backend, engine } of engines) {
      const src = 'g-drop';
      await source(engine, src);
      const a = await upsertOpenLoop(engine, loop(src, '18c2f4a9b3d21f04'));
      const b = await upsertOpenLoop(engine, loop(src, '18c2f4a9b3d21f05', { lastActivityAt: NEWER }));
      await upsertOpenLoop(engine, loop(src, '18c2f4a9b3d21f06', { counterpartyEmail: CAROL }));
      expect(await listSenderInboundLoops(engine, 'Alerts@Bank-Example.test', [src]), backend)
        .toEqual([{ id: a.id, source_id: src }, { id: b.id, source_id: src }]);
      const state = {} as GoogleSourceState;
      expect(await seedLoopRechecks(engine, src, state, () => {}, Date.parse(NEWER)), backend).toBe(2);
      expect(Object.keys(state.loop_grace_holds ?? {}).sort(), backend).toEqual(['18c2f4a9b3d21f05', '18c2f4a9b3d21f06']);
    }
  });

  test('the Updates reciprocity set reads email page frontmatter', async () => {
    for (const { backend, engine } of engines) {
      const src = 'g-recip';
      await source(engine, src);
      await engine.putPage('email/2026/08/plan', { type: 'email', title: 'Plan', compiled_truth: 'x', timeline: '',
        frontmatter: { senders: ['me@example.com'], participants: ['me@example.com', 'Bob@Example.com'] } }, { sourceId: src });
      await engine.putPage('email/2026/08/news', { type: 'email', title: 'News', compiled_truth: 'x', timeline: '',
        frontmatter: { senders: ['news@example.com'], participants: ['news@example.com', 'me@example.com'] } }, { sourceId: src });
      await engine.setConfig('loops.updates_require_reciprocity', 'true');
      __clearReciprocityCacheForTests(engine);
      expect([...(await ownerWroteToFor(engine, src, new Set(['me@example.com'])))!], backend).toEqual(['bob@example.com']);
      await engine.setConfig('loops.updates_require_reciprocity', 'false');
      __clearReciprocityCacheForTests(engine);
      expect(await ownerWroteToFor(engine, src, new Set(['me@example.com'])), backend).toBeNull();
    }
  });
});
