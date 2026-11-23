/**
 * GST-2768 PR 3: the archive's any-size embedding holds cost one point query per embedded page, not two. Planning a
 * small page (archive or not) reads its frontmatter marker and its budget row in one statement; only the first plan
 * of an archive page whose hold has no row yet adds the insert that records it. PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { holdPageEmbedding, planPageEmbedding } from '../src/core/page-embedding-budget.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const stale = [{ chunk_index: 0, chunk_text: 'a short stale chunk' }];

function counting(): { proxy: BrainEngine; count: () => number } {
  let n = 0;
  const proxy = new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => { n++; return target.executeRaw(sql, params); };
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as unknown as BrainEngine;
  return { proxy, count: () => n };
}

async function page(slug: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'A small synthetic note about acme-example.', frontmatter });
  const stored = await engine.getPage(slug);
  return { id: stored!.id, compiled_truth: 'A small synthetic note about acme-example.', timeline: '' };
}

describe('statements per embedded page in planPageEmbedding', () => {
  test('a small page with no archive marker: one statement, unmetered', async () => {
    const p = await page('notes/plain');
    const { proxy, count } = counting();
    expect(await planPageEmbedding(proxy, p, stale)).toEqual({ kind: 'unmetered' });
    expect(count()).toBe(1);
  });

  test('a small archive page held in frontmatter: one read plus the insert that records the hold, then one statement', async () => {
    const p = await page('conversations/codex/2026-10-01/x', { transcript_archive: { embedding_hold: 'archive_backfill' } });
    const first = counting();
    expect(await planPageEmbedding(first.proxy, p, stale)).toEqual({ kind: 'held', reason: 'archive_backfill' });
    expect(first.count()).toBe(2);
    const second = counting();
    expect(await planPageEmbedding(second.proxy, p, stale)).toEqual({ kind: 'held', reason: 'archive_backfill' });
    expect(second.count()).toBe(1);
  });

  test('a small page with an any-size hold row: one statement, held; approval opens it', async () => {
    const p = await page('notes/held');
    await holdPageEmbedding(engine, p.id, 'archive_open_day');
    const { proxy, count } = counting();
    expect(await planPageEmbedding(proxy, p, stale)).toEqual({ kind: 'held', reason: 'archive_open_day' });
    expect(count()).toBe(1);
    expect(await planPageEmbedding(engine, p, stale, { approvedCapUsd: 1 })).toEqual({ kind: 'unmetered' });
    expect(await planPageEmbedding(engine, p, stale)).toEqual({ kind: 'unmetered' });
  });
});
