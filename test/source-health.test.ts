/**
 * Tests for src/core/source-health.ts (v0.40 D12 + D9 + D17).
 *
 * Validates:
 *   - computeAllSourceMetrics: batched GROUP BY shape, vacuous truth for zero pages
 *   - resolvePriorityLabel: high/normal/low, unknown → normal + warn-once
 *   - isSourceStale: never-synced + lag-exceeded + fresh + missing local_path
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  computeAllSourceMetrics,
  resolvePriorityLabel,
  resolvePriority,
  isSourceStale,
  _resetPriorityWarningsForTest,
} from '../src/core/source-health.ts';
import { loadAllSources } from '../src/core/sources-load.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Surgical reset: preserves config table (schema version).
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM sources WHERE id != 'default'`);
  _resetPriorityWarningsForTest();
});

describe('resolvePriorityLabel', () => {
  test('recognized values', () => {
    expect(resolvePriorityLabel('s', { priority: 'high' })).toBe('high');
    expect(resolvePriorityLabel('s', { priority: 'normal' })).toBe('normal');
    expect(resolvePriorityLabel('s', { priority: 'low' })).toBe('low');
  });
  test('missing → normal silently', () => {
    expect(resolvePriorityLabel('s', {})).toBe('normal');
    expect(resolvePriorityLabel('s', null)).toBe('normal');
  });
  test('unknown values → normal with warn', () => {
    // Reroute stderr to capture
    const orig = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as never;
    try {
      expect(resolvePriorityLabel('zion-brain', { priority: 'urgent' })).toBe('normal');
      expect(captured).toContain('zion-brain');
      expect(captured).toContain('priority');
      expect(captured).toContain('normal');
    } finally {
      process.stderr.write = orig;
    }
  });
  test('warns once per source per process', () => {
    const orig = process.stderr.write.bind(process.stderr);
    let count = 0;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (s.includes('invalid config.priority')) count++;
      return true;
    }) as never;
    try {
      resolvePriorityLabel('s1', { priority: 'urgent' });
      resolvePriorityLabel('s1', { priority: 'urgent' }); // same source
      resolvePriorityLabel('s1', { priority: 42 });       // different bad value, same source
      expect(count).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe('resolvePriority (numeric)', () => {
  test('maps labels to MinionQueue priority integers', () => {
    expect(resolvePriority('s', { priority: 'high' })).toBe(-10);
    expect(resolvePriority('s', { priority: 'normal' })).toBe(0);
    expect(resolvePriority('s', { priority: 'low' })).toBe(5);
    expect(resolvePriority('s', {})).toBe(0);
  });
});

describe('isSourceStale', () => {
  test('never-synced (last_sync_at null) → true', () => {
    const src = { id: 's', name: 's', local_path: '/path', last_commit: null, last_sync_at: null, config: {}, created_at: new Date() };
    expect(isSourceStale(src, 60_000)).toBe(true);
  });
  test('no local_path → false (nothing to sync)', () => {
    const src = { id: 's', name: 's', local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() };
    expect(isSourceStale(src, 60_000)).toBe(false);
  });
  test('synced within interval → false', () => {
    const src = { id: 's', name: 's', local_path: '/path', last_commit: null, last_sync_at: new Date(Date.now() - 1000), config: {}, created_at: new Date() };
    expect(isSourceStale(src, 60_000)).toBe(false);
  });
  test('synced beyond interval → true', () => {
    const src = { id: 's', name: 's', local_path: '/path', last_commit: null, last_sync_at: new Date(Date.now() - 120_000), config: {}, created_at: new Date() };
    expect(isSourceStale(src, 60_000)).toBe(true);
  });
});

describe('computeAllSourceMetrics', () => {
  test('empty input returns empty', async () => {
    const result = await computeAllSourceMetrics(engine, []);
    expect(result).toEqual([]);
  });

  test('zero-page source → embed_coverage_pct=100 (vacuous truth)', async () => {
    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    const dflt = result.find((m) => m.source_id === 'default')!;
    expect(dflt.total_pages).toBe(0);
    expect(dflt.total_chunks).toBe(0);
    expect(dflt.embed_coverage_pct).toBe(100);
  });

  test('aggregates pages + chunks + embedding coverage per source', async () => {
    // Two pages with chunks, half embedded
    await engine.putPage('a', { type: 'note', title: 'a', compiled_truth: 'a' });
    await engine.putPage('b', { type: 'note', title: 'b', compiled_truth: 'b' });
    await engine.upsertChunks('a', [
      { chunk_index: 0, chunk_text: 'one', chunk_source: 'compiled_truth', token_count: 1, embedding: new Float32Array(1536) },
      { chunk_index: 1, chunk_text: 'two', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
    ]);
    await engine.upsertChunks('b', [
      { chunk_index: 0, chunk_text: 'three', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
    ]);

    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    const dflt = result.find((m) => m.source_id === 'default')!;
    expect(dflt.total_pages).toBe(2);
    expect(dflt.total_chunks).toBe(3);
    expect(dflt.embedded_chunks).toBe(1);
    // 1/3 = 33.3%
    expect(dflt.embed_coverage_pct).toBeCloseTo(33.3, 1);
  });

  test('lag_seconds is null when last_sync_at is null', async () => {
    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    const dflt = result.find((m) => m.source_id === 'default')!;
    expect(dflt.lag_seconds).toBeNull();
  });

  test('multi-source isolation: each source gets its own counts', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{"federated":true}') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('a', { type: 'note', title: 'a', compiled_truth: 'a' });
    await engine.putPage('b', { type: 'note', title: 'b', compiled_truth: 'b' }, { sourceId: 'other' });

    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    expect(result.find((m) => m.source_id === 'default')!.total_pages).toBe(1);
    expect(result.find((m) => m.source_id === 'other')!.total_pages).toBe(1);
  });

  test('v0.41.31: embed-backfill active/queued counts per source (CLI BACKFILL column)', async () => {
    // 2 queued + 1 active embed-backfill for default; a non-backfill 'sync'
    // job must NOT inflate the backfill counts (only the generic queue_depth).
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data) VALUES
         ('embed-backfill', 'waiting', '{"sourceId":"default"}'::jsonb),
         ('embed-backfill', 'waiting', '{"sourceId":"default"}'::jsonb),
         ('embed-backfill', 'active',  '{"sourceId":"default"}'::jsonb),
         ('sync',           'waiting', '{"sourceId":"default"}'::jsonb)`,
    );
    const sources = await loadAllSources(engine);
    const dflt = (await computeAllSourceMetrics(engine, sources)).find((m) => m.source_id === 'default')!;
    expect(dflt.backfill_active).toBe(1);
    expect(dflt.backfill_queued).toBe(2);
    // generic queue_depth includes the sync job too (4 total waiting/active).
    expect(dflt.queue_depth).toBe(4);
  });

  test('webhook_configured reflects config.webhook_secret presence', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('webhooky', 'webhooky', '{"federated":true,"webhook_secret":"x","github_repo":"a/b"}'::jsonb)`,
    );
    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    const w = result.find((m) => m.source_id === 'webhooky')!;
    expect(w.webhook_configured).toBe(true);
    const d = result.find((m) => m.source_id === 'default')!;
    expect(d.webhook_configured).toBe(false);
  });
});
