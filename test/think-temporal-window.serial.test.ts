import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runGather } from '../src/core/think/gather.ts';
import {
  filterPagesToWindow,
  parseTemporalWindow,
  resolvePageDateMs,
  TemporalWindowError,
} from '../src/core/think/temporal-window.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { ChunkInput, SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

async function seed(slug: string, body: string, effective?: string, type = 'note') {
  await engine.putPage(slug, {
    title: slug,
    type,
    compiled_truth: body,
    ...(effective ? { effective_date: new Date(effective), effective_date_source: 'date' as const } : {}),
  });
  const chunks: ChunkInput[] = [{
    chunk_index: 0,
    chunk_text: body,
    chunk_source: 'compiled_truth',
    token_count: 10,
  }];
  await engine.upsertChunks(slug, chunks);
}

beforeAll(async () => {
  __setEmbedTransportForTests(() => { throw new Error('keyword-only test'); });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seed('brain/ops/2026-07-18', 'operations update release green', '2026-07-18T09:00:00Z');
  await seed('brain/ops/2026-06-01', 'operations update old rollback', '2026-06-01T09:00:00Z', 'meeting');
  await seed('brain/ops/2026-07-17', 'xyzzy vocabulary absent from query', '2026-07-17T12:00:00Z', 'idea');
  await seed('brain/ops/undated', 'operations update timeless guidance');
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  await engine.disconnect();
});

describe('temporal-window parsing', () => {
  test('date bounds are inclusive UTC days', () => {
    const window = parseTemporalWindow('2026-07-17', '2026-07-18')!;
    expect(new Date(window.startMs!).toISOString()).toBe('2026-07-17T00:00:00.000Z');
    expect(new Date(window.endMs!).toISOString()).toBe('2026-07-18T23:59:59.999Z');
  });

  test('month bounds expand to the whole month', () => {
    const window = parseTemporalWindow('2026-02', '2026-02')!;
    expect(new Date(window.endMs!).toISOString()).toBe('2026-02-28T23:59:59.999Z');
  });

  test('open and absent bounds remain distinct', () => {
    expect(parseTemporalWindow('2026-07-17')!.endMs).toBeNull();
    expect(parseTemporalWindow(undefined, '2026-07-18')!.startMs).toBeNull();
    expect(parseTemporalWindow()).toBeNull();
  });

  test('invalid and inverted ranges fail clearly', () => {
    expect(() => parseTemporalWindow('2026-02-30')).toThrow(TemporalWindowError);
    expect(() => parseTemporalWindow('2026-07-18', '2026-07-17')).toThrow(/since.*after.*until/);
  });
});

describe('effective-date policy', () => {
  const result = (slug: string, effective_date: string | null): SearchResult => ({
    slug, effective_date, page_id: 1, title: slug, type: 'note', chunk_text: '',
    chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0, score: 1, stale: false,
  });

  test('effective date wins, then slug date; truly undated evidence is counted and kept', () => {
    const window = parseTemporalWindow('2026-07-17', '2026-07-18')!;
    const filtered = filterPagesToWindow([
      result('in', '2026-07-18'),
      result('brain/ops/2026-06-01', null),
      result('undated', null),
    ], window);
    expect(filtered.kept.map(page => page.slug)).toEqual(['in', 'undated']);
    expect(filtered.droppedOutOfWindow).toBe(1);
    expect(filtered.undatedKept).toBe(1);
    expect(resolvePageDateMs({ slug: 'brain/ops/2026-07-17' })).not.toBeNull();
  });
});

describe('engine and gather enforcement', () => {
  const window = parseTemporalWindow('2026-07-17', '2026-07-18')!;

  test('bounded listPages is inclusive and excludes NULL effective dates', async () => {
    const pages = await engine.listPages({
      effective_after: new Date(window.startMs!).toISOString(),
      effective_before: new Date(window.endMs!).toISOString(),
      slugPrefix: 'brain/ops/',
    });
    expect(pages.map(page => page.slug).sort()).toEqual([
      'brain/ops/2026-07-17',
      'brain/ops/2026-07-18',
    ]);
  });

  test('bounded gather excludes old relevance and supplies a nonmatching in-window page', async () => {
    const gathered = await runGather(engine, { question: 'operations update', window });
    const slugs = gathered.pages.map(page => page.slug);
    expect(slugs).toContain('brain/ops/2026-07-18');
    expect(slugs).toContain('brain/ops/2026-07-17');
    expect(slugs).not.toContain('brain/ops/2026-06-01');
    expect(gathered.diagnostics.window?.dropped).toBeGreaterThan(0);
  });

  test('no bounds preserves ordinary relevance behavior', async () => {
    const gathered = await runGather(engine, { question: 'operations update' });
    expect(gathered.pages.map(page => page.slug)).toContain('brain/ops/2026-06-01');
    expect(gathered.diagnostics.window).toBeUndefined();
  });
});
