import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import {
  addSuppression, closeOpenLoop, listOpenLoops, muteRecheckThreads, upsertOpenLoop,
  type LoopType,
} from '../src/core/loops/loops-store.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const engines: Array<{ backend: string; engine: BrainEngine; close: () => Promise<void> }> = [];
const EMAIL = 'robot@example.com';
const TYPES: LoopType[] = ['unanswered_inbound', 'unanswered_outbound', 'commitment_owed_by_me', 'commitment_owed_to_me', 'decision_pending'];

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
afterAll(async () => { for (const entry of engines) await entry.close(); });

async function seed(engine: BrainEngine, sourceId: string, email = EMAIL) {
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"kind":"google"}'::jsonb) ON CONFLICT DO NOTHING`, [sourceId]);
  const ids: number[] = [];
  for (const loopType of TYPES) {
    ids.push((await upsertOpenLoop(engine, {
      sourceId, dedupKey: `${email}:${loopType}`, loopType, counterpartyEmail: email,
      threadId: `thread-${loopType}`, summary: 'Synthetic obligation', evidence: [],
      detector: loopType.startsWith('unanswered_') ? 'deterministic_thread' : 'llm_extract',
      lastActivityAt: '2026-08-01T00:00:00Z',
    })).id);
  }
  return ids;
}

async function mute(engine: BrainEngine, sourceId: string, dryRun = false) {
  return handleToolCall(engine, 'loops_mute', { kind: 'sender', value: EMAIL.toUpperCase(), source_id: sourceId,
    ...(dryRun ? { dry_run: true } : {}) }) as Promise<{ closed: number[]; would_close: number[]; count: number }>;
}

describe('sender mute covers extracted obligations (#7287)', () => {
  test('overlapping thread suppressions retain extracted closures and threadless/manual loops are never queued', async () => {
    for (const { backend, engine } of engines) {
      const src = 'mute-overlap';
      const ids = await seed(engine, src);
      const manual = (await upsertOpenLoop(engine, { sourceId: src, dedupKey: 'manual',
        loopType: 'decision_pending', counterpartyEmail: EMAIL, threadId: 'manual-thread',
        summary: 'Manual obligation', evidence: [], detector: 'manual' })).id;
      const threadless = (await upsertOpenLoop(engine, { sourceId: src, dedupKey: 'threadless',
        loopType: 'unanswered_inbound', counterpartyEmail: EMAIL,
        summary: 'Threadless obligation', evidence: [], detector: 'deterministic_thread' })).id;
      await mute(engine, src);
      await addSuppression(engine, src, 'thread', 'thread-commitment_owed_to_me');
      const result = await handleToolCall(engine, 'loops_unmute', { kind: 'sender', value: EMAIL, source_id: src }) as { unverifiable: number[] };
      expect(result.unverifiable, backend).toEqual([ids[2], ids[4], manual, threadless]);
      const rows = await listOpenLoops(engine, { sourceIds: [src] });
      expect(rows.find(r => r.id === ids[3])?.closed_by, backend).toBe('muted');
      expect(rows.filter(r => [manual, threadless].includes(r.id)).every(r => r.status === 'dropped' && r.closed_by === 'unmuted'), backend).toBe(true);
      expect((await muteRecheckThreads(engine, src)).map(r => r.thread_id).sort(), backend)
        .toEqual(['thread-unanswered_inbound', 'thread-unanswered_outbound']);
    }
  });

  test('preview and apply close all five types, preserving manual closes, other senders and sources', async () => {
    for (const { backend, engine } of engines) {
      const src = 'mute-all';
      const ids = await seed(engine, src);
      const otherIds = await seed(engine, src, 'other@example.com');
      await seed(engine, 'mute-sibling');
      await closeOpenLoop(engine, src, ids[2], 'done', 'manual');
      const expected = ids.filter(id => id !== ids[2]);
      expect((await mute(engine, src, true)).would_close, backend).toEqual(expected);
      expect((await listOpenLoops(engine, { sourceIds: [src], status: 'open' })).length, backend).toBe(9);
      expect((await mute(engine, src)).closed, backend).toEqual(expected);
      expect((await mute(engine, src)).closed, backend).toEqual([]);
      const rows = await listOpenLoops(engine, { sourceIds: [src] });
      expect(rows.filter(r => expected.includes(r.id)).every(r => r.status === 'dropped' && r.closed_by === 'muted'), backend).toBe(true);
      expect(rows.find(r => r.id === ids[2])?.closed_by, backend).toBe('manual');
      expect(rows.filter(r => otherIds.includes(r.id)).every(r => r.status === 'open'), backend).toBe(true);
      expect((await listOpenLoops(engine, { sourceIds: ['mute-sibling'], status: 'open' })).length, backend).toBe(5);
      const visible = await handleToolCall(engine, 'open_loops', { source_id: src, status: 'open', group_by: 'none' }) as { loops: Array<{ id: number }> };
      expect(visible.loops.some(r => expected.includes(r.id)), backend).toBe(false);
    }
  });

  test('unmute only queues deterministic loops; extracted obligations stay closed until fresh evidence', async () => {
    for (const { backend, engine } of engines) {
      const src = 'mute-unmute';
      const ids = await seed(engine, src);
      await mute(engine, src);
      const params = { kind: 'sender', value: EMAIL, source_id: src };
      const preview = await handleToolCall(engine, 'loops_unmute', { ...params, dry_run: true }) as { would_requeue: number[]; unverifiable: number[] };
      expect(preview.would_requeue, backend).toEqual(ids.slice(0, 2));
      expect(preview.unverifiable, backend).toEqual(ids.slice(2));
      const result = await handleToolCall(engine, 'loops_unmute', params) as { requeued: number[]; unverifiable: number[] };
      expect(result.requeued, backend).toEqual(ids.slice(0, 2));
      expect(result.unverifiable, backend).toEqual(ids.slice(2));
      expect((await muteRecheckThreads(engine, src)).map(r => r.thread_id).sort(), backend)
        .toEqual(['thread-unanswered_inbound', 'thread-unanswered_outbound']);
      const old = await upsertOpenLoop(engine, { sourceId: src, dedupKey: `${EMAIL}:commitment_owed_to_me`,
        loopType: 'commitment_owed_to_me', counterpartyEmail: EMAIL, summary: 'Same evidence', evidence: [],
        threadId: 'thread-commitment_owed_to_me', detector: 'llm_extract', lastActivityAt: '2026-08-01T00:00:00Z' });
      expect(old.applied, backend).toBe(false);
      const fresh = await upsertOpenLoop(engine, { sourceId: src, dedupKey: `${EMAIL}:commitment_owed_to_me`,
        loopType: 'commitment_owed_to_me', counterpartyEmail: EMAIL, summary: 'New evidence', evidence: [],
        threadId: 'thread-commitment_owed_to_me', detector: 'llm_extract', lastActivityAt: '2026-08-02T00:00:00Z' });
      expect(fresh.applied, backend).toBe(true);
    }
  });
});
