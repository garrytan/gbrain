/**
 * C1 (cost wave): remote `search`/`query` callers get lean rows by default.
 *
 * Protects: the lean field set (identity, text, the duplicate-page guard,
 * safety and provenance markers, truncation), every escape hatch (`fields:
 * "full"`, the transport's `resultRows`, trusted local callers), the
 * `_meta.retrieval.rows` report, and the two follow-up calls a lean row must
 * still feed: `assemble_evidence` ({source_id, slug, chunk_id}) and `fetch`
 * (`id`).
 * Fails when: a kept field is dropped, a diagnostic leaks back into lean rows,
 * an escape hatch stops restoring full rows, or a lean row can no longer be
 * widened or fetched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { leanRow, resultRowsFor } from '../src/core/search/lean-rows.ts';
import { stampEvidence } from '../src/core/search/evidence.ts';
import { seedOffPath } from './helpers/evidence-delivery-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const REMOTE: DispatchOpts = { remote: true, transport: 'http', sourceId: 'default' };
const LEAN_ALWAYS = ['id', 'slug', 'title', 'type', 'chunk_text', 'score', 'source_id', 'chunk_id', 'evidence', 'create_safety'];
const DIAGNOSTICS = ['page_id', 'chunk_index', 'chunk_source', 'keyword_hit', 'stale'];

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedOffPath(engine);
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

async function call(name: string, params: Record<string, unknown>, opts: DispatchOpts = REMOTE) {
  const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, name, params, opts));
  expect(res.isError, res.content[0]?.text).not.toBe(true);
  return { rows: JSON.parse(res.content[0].text) as Array<Record<string, unknown>>, meta: res._meta?.retrieval as Record<string, unknown> | undefined };
}

describe('lean rows for remote callers', () => {
  for (const name of ['search', 'query'] as const) {
    test(`${name}: a remote caller gets lean rows and _meta.retrieval.rows = "lean"`, async () => {
      const { rows, meta } = await call(name, { query: 'ocelot pricing', ...(name === 'query' ? { expand: false } : {}), return_unit: 'chunk' });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        for (const key of LEAN_ALWAYS) expect(row, key).toHaveProperty(key);
        for (const key of DIAGNOSTICS) expect(row, key).not.toHaveProperty(key);
        expect(row).toHaveProperty('effective_date');
        // Cat 40 Hard F4: a dated row says what kind of date it is.
        if (row.effective_date !== null) expect(typeof row.effective_date_source).toBe('string');
      }
      expect(meta?.rows).toBe('lean');
    });

    test(`${name}: fields "full" restores every field the local caller sees`, async () => {
      const params = { query: 'ocelot pricing', ...(name === 'query' ? { expand: false } : {}), return_unit: 'chunk' };
      const full = await call(name, { ...params, fields: 'full' });
      const local = await call(name, params, { remote: false, sourceId: 'default' });
      expect(full.meta?.rows).toBe('full');
      expect(full.rows.map(r => Object.keys(r).sort())).toEqual(local.rows.map(r => Object.keys(r).sort()));
      for (const key of ['page_id', 'chunk_index', 'chunk_source']) expect(full.rows[0], key).toHaveProperty(key);
    });
  }

  test('trusted local callers keep full rows and get no rows marker', async () => {
    const { rows, meta } = await call('search', { query: 'ocelot', return_unit: 'chunk' }, { remote: false, sourceId: 'default' });
    expect(rows[0]).toHaveProperty('page_id');
    expect(meta?.rows).toBeUndefined();
  });

  test('a transport that chose full rows (thin client, mcp.result_rows: full) gets them; fields "lean" still wins', async () => {
    const full = await call('search', { query: 'ocelot', return_unit: 'chunk' }, { ...REMOTE, resultRows: 'full' });
    expect(full.rows[0]).toHaveProperty('page_id');
    expect(full.meta?.rows).toBe('full');
    const lean = await call('search', { query: 'ocelot', return_unit: 'chunk', fields: 'lean' }, { ...REMOTE, resultRows: 'full' });
    expect(lean.rows[0]).not.toHaveProperty('page_id');
  });

  test('resultRowsFor: explicit fields > local caller > transport choice > lean', () => {
    expect(resultRowsFor({ remote: true }, undefined)).toBe('lean');
    expect(resultRowsFor({ remote: true, resultRows: 'full' }, undefined)).toBe('full');
    expect(resultRowsFor({ remote: false }, undefined)).toBe('full');
    expect(resultRowsFor({ remote: false }, 'lean')).toBe('lean');
    expect(resultRowsFor({ remote: true }, 'full')).toBe('full');
    expect(resultRowsFor({ remote: true, resultRows: 'full' }, 'lean')).toBe('lean');
  });
});

describe('lean rows still feed the follow-up calls', () => {
  test('a lean search row passed to assemble_evidence resolves', async () => {
    const { rows } = await call('search', { query: 'ocelot pricing', return_unit: 'chunk' });
    const hits = rows.slice(0, 2).map(r => ({ source_id: r.source_id, slug: r.slug, chunk_id: r.chunk_id }));
    const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'assemble_evidence', { hits, return_unit: 'chunk' }, REMOTE));
    const out = JSON.parse(res.content[0].text) as { results: unknown[]; unresolved: unknown[] };
    expect(out.unresolved).toEqual([]);
    expect(out.results.length).toBe(hits.length);
  });

  test("a lean search row's id resolves through fetch", async () => {
    const { rows } = await call('search', { query: 'ocelot pricing', return_unit: 'chunk' });
    const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'fetch', { id: rows[0].id }, REMOTE));
    expect(res.isError).not.toBe(true);
    const page = JSON.parse(res.content[0].text) as { id: string; text: string };
    expect(page.id).toBe(rows[0].id as string);
    expect(page.text.length).toBeGreaterThan(0);
  });
});

describe('delivered.truncated survives in lean rows whenever delivery truncated (DX-13)', () => {
  const truncatedConversation = (rows: Array<Record<string, unknown>>) => {
    const row = rows.find(r => r.slug === 'chat/session-a');
    expect(row).toBeDefined();
    return row!.delivered;
  };

  test('omitted return_unit (auto)', async () => {
    const { rows } = await call('search', { query: 'ocelot renewal', snippet_chars: 200 });
    expect(truncatedConversation(rows)).toEqual({ truncated: true });
    for (const r of rows.filter(r => r.slug !== 'chat/session-a')) expect(r).not.toHaveProperty('delivered');
  });

  test('configured return_unit', async () => {
    await engine.setConfig('search.return_unit', 'page');
    try {
      const { rows } = await call('search', { query: 'ocelot renewal', snippet_chars: 200 });
      expect(truncatedConversation(rows)).toEqual({ truncated: true });
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.return_unit'`);
    }
  });

  test('explicit return_unit', async () => {
    const { rows } = await call('search', { query: 'ocelot renewal', return_unit: 'page', snippet_chars: 200 });
    expect(truncatedConversation(rows)).toEqual({ truncated: true });
  });

  test('an untruncated delivery carries no delivered object', async () => {
    const { rows } = await call('search', { query: 'ocelot renewal', return_unit: 'page' });
    expect(rows.find(r => r.slug === 'chat/session-a')).not.toHaveProperty('delivered');
  });
});

describe('leanRow field contract', () => {
  const full = {
    id: 'gbrain-page:v1:x', slug: 's', page_id: 7, title: 't', type: 'note', chunk_text: 'body', chunk_source: 'compiled_truth',
    chunk_id: 3, chunk_index: 0, score: 0.5, stale: false, source_id: 'default', effective_date: null, effective_date_source: null,
    keyword_hit: true, cosine: 0.4, base_score: 0.3, rerank_score: 0.2, alias_hit: true, exact_lookup: true, graph_adjacency_hits: 2,
    evidence: 'keyword_exact', create_safety: 'probable',
    injection_suspected: true, injection_p: 0.9, unverified: true, content_flag: { reason: 'junk', detail: 'x' }, status: 'superseded',
    superseded: true, superseded_by: 'canon', modality: 'text', message_id: 'm1', thread_id: 'th1', source_subject: 'subj',
    delivered: { unit: 'page', chunk_ids: [3], match_spans: [], tokens: 9, truncated: false },
  };

  test('keeps identity, text, the duplicate guard and every present safety/provenance marker; drops diagnostics', () => {
    expect(leanRow(full)).toEqual({
      id: 'gbrain-page:v1:x', slug: 's', title: 't', type: 'note', chunk_text: 'body', chunk_id: 3, score: 0.5, source_id: 'default',
      effective_date: null, evidence: 'keyword_exact', create_safety: 'probable',
      injection_suspected: true, injection_p: 0.9, unverified: true, content_flag: { reason: 'junk', detail: 'x' }, status: 'superseded',
      superseded: true, superseded_by: 'canon', message_id: 'm1', thread_id: 'th1', source_subject: 'subj',
    });
  });

  test('stale only when true, modality only when not text, delivered only as {truncated: true}', () => {
    const marked = leanRow({ ...full, stale: true, modality: 'image', delivered: { ...full.delivered, truncated: true } });
    expect(marked.stale).toBe(true);
    expect(marked.modality).toBe('image');
    expect(marked.delivered).toEqual({ truncated: true });
  });

  test('effective_date_source and provenance: generated survive; ordinary rows carry neither, nor matched_alias', () => {
    const dated = leanRow({ ...full, effective_date: '2026-03-01', effective_date_source: 'event_date', provenance: 'generated' });
    expect(dated.effective_date_source).toBe('event_date');
    expect(dated.provenance).toBe('generated');
    const ordinary = leanRow(full);
    for (const key of ['effective_date_source', 'provenance', 'matched_alias']) expect(ordinary).not.toHaveProperty(key);
    expect(leanRow({ ...full, provenance: 'auto-extracted' })).not.toHaveProperty('provenance');
  });

  test('absent sparse fields stay absent', () => {
    expect(Object.keys(leanRow({ slug: 's', title: 't', type: 'note', chunk_text: 'x', score: 1, chunk_id: 1, page_id: 1 })).sort())
      .toEqual(['chunk_id', 'chunk_text', 'score', 'slug', 'title', 'type']);
  });
});

describe('the duplicate-page guard survives projection (E-7)', () => {
  // The duplicate-prevention cases of test/search/evidence.ts, run through the
  // remote projection: an agent reading a lean row must get the same
  // don't-duplicate signal the full row carried.
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ['the incident: a 0.64 keyword-hit body chunk', { base_score: 0.64, score: 0.64, keyword_hit: true }, 'keyword_exact', 'probable'],
    ['the same 0.64 without a keyword hit', { base_score: 0.64, score: 0.64 }, 'weak_semantic', 'unknown'],
    ['the same page via alias', { base_score: 0.64, alias_hit: true }, 'alias_hit', 'exists'],
    ['a relaxed keyword hit', { keyword_hit: true, keyword_relaxed: true, base_score: 0.9 }, 'weak_semantic', 'unknown'],
  ];
  for (const [label, signals, evidence, safety] of cases) {
    test(label, () => {
      const row = { slug: 's', title: 't', chunk_text: '', type: 'note', source_id: 'default', chunk_index: 0, chunk_id: 1, page_id: 1, score: 0.5, ...signals } as never;
      stampEvidence([row]);
      const lean = leanRow(row);
      expect(lean.evidence).toBe(evidence);
      expect(lean.create_safety).toBe(safety);
      for (const raw of Object.keys(signals)) if (raw !== 'score') expect(lean).not.toHaveProperty(raw);
    });
  }
});

describe('schema', () => {
  const param = (op: string, key: string) => operations.find(o => o.name === op)!.params[key];

  test('search and query declare fields: lean | full', () => {
    for (const op of ['search', 'query']) expect(param(op, 'fields')).toMatchObject({ type: 'string', enum: ['lean', 'full'] });
  });

  test('query.detail still means low/medium/high', () => {
    const d = param('query', 'detail').description ?? '';
    for (const level of ['low', 'medium', 'high']) expect(d).toContain(level);
    expect(param('query', 'detail').enum ?? ['low', 'medium', 'high']).toEqual(['low', 'medium', 'high']);
  });

  test('strict reject mode accepts fields (declared) and rejects an undeclared row-shape key', async () => {
    await engine.setConfig('mcp.strict_params', 'reject');
    try {
      const ok = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', { query: 'ocelot', fields: 'full' }, REMOTE));
      expect(ok.isError).not.toBe(true);
      const bad = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', { query: 'ocelot', detail_rows: 'full' }, REMOTE));
      expect(bad.isError).toBe(true);
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'mcp.strict_params'`);
      const { resetStrictParamsModeCache } = await import('../src/mcp/validate-params.ts');
      resetStrictParamsModeCache();
    }
  });
});
