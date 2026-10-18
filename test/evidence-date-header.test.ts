/**
 * C1 — dated evidence blocks (`search.evidence_date_header`): the fixed
 * one-line header grammar, the observation-date rule (never an event date or
 * a row timestamp), budget accounting for the header, span offsets, the
 * default-off byte identity, recall fact validity windows, and the
 * configurable remote budget clamp the eval relies on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import type { SearchResult } from '../src/core/types.ts';
import { countEvidenceTokens, DEFAULT_AUTO_PACKING, deliverEvidence, type EvidencePlan } from '../src/core/search/evidence-delivery.ts';
import {
  EVIDENCE_DATE_HEADER_KEY, factDateHeader, pageDateHeader, pageObservationDate,
} from '../src/core/search/evidence-date.ts';
import { formatBrainDay } from '../src/core/effective-date.ts';

const HEADER_LINE = /^\[observed (\d{4}-\d{2}-\d{2}|unknown)\]\n/;

describe('header grammar and dates', () => {
  test('page and fact headers are fixed one-line strings; unknown dates read "unknown"', () => {
    expect(pageDateHeader('2026-03-05')).toBe('[observed 2026-03-05]');
    expect(pageDateHeader(null)).toBe('[observed unknown]');
    expect(factDateHeader({ valid_from: new Date('2026-03-01T00:00:00Z'), valid_until: null })).toBe('[observed unknown; valid 2026-03-01 to unknown]');
    expect(factDateHeader({ valid_from: null, valid_until: '2026-04-01T00:00:00.000Z' })).toBe('[observed unknown; valid unknown to 2026-04-01]');
    for (const h of [pageDateHeader(null), factDateHeader({})]) expect(h).not.toContain('\n');
    // A valid_from that only records the write time is not a known start of validity.
    expect(factDateHeader({ valid_from: '2026-10-05T12:00:00.000Z', valid_until: null, created_at: '2026-10-05T12:00:00.400Z' })).toBe('[observed unknown; valid unknown to unknown]');
    expect(factDateHeader({ valid_from: '2026-03-01T00:00:00.000Z', valid_until: null, created_at: '2026-10-05T12:00:00.000Z' }, null, '2026-02-10')).toBe('[observed 2026-02-10; valid 2026-03-01 to unknown]');
  });

  test('formatBrainDay: midnight UTC renders as written, other instants in brain.timezone', () => {
    expect(formatBrainDay(new Date('2026-03-05T00:00:00Z'), 'America/Los_Angeles')).toBe('2026-03-05');
    expect(formatBrainDay(new Date('2026-03-05T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-03-04');
    expect(formatBrainDay(new Date('2026-03-05T03:00:00Z'), null)).toBe('2026-03-05');
    expect(formatBrainDay(new Date('2026-03-05T03:00:00Z'), 'Not/AZone')).toBe('2026-03-05');
    expect(formatBrainDay(null)).toBeNull();
    expect(formatBrainDay('garbage')).toBeNull();
  });

  test('observation date: filename, date, published, created keys; never event_date or row times', () => {
    const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
    expect(day(pageObservationDate({ slug: 'notes/x', frontmatter: { date: '2026-03-05' } }))).toBe('2026-03-05');
    expect(day(pageObservationDate({ slug: 'notes/x', frontmatter: { event_date: '2024-01-01', date: '2026-03-05' } }))).toBe('2026-03-05');
    expect(pageObservationDate({ slug: 'notes/x', frontmatter: { event_date: '2024-01-01' } })).toBeNull();
    expect(day(pageObservationDate({ slug: 'chat/2026-02-10-session', frontmatter: {} }))).toBe('2026-02-10');
    expect(day(pageObservationDate({ slug: 'notes/x', frontmatter: { created: '2025-12-31' } }))).toBe('2025-12-31');
    expect(pageObservationDate({ slug: 'notes/undated', frontmatter: {} })).toBeNull();
  });
});

describe('deliverEvidence with the header on', () => {
  const body = Array.from({ length: 30 }, (_, i) => `**${i % 2 ? 'assistant' : 'user'}:** turn ${i} about the renewal and the roadmap.`).join('\n\n');
  const chunks = [body.slice(0, body.length / 2).trim(), body.slice(body.length / 2).trim()];
  function stub(frontmatter: Record<string, unknown>) {
    return {
      async getConfig(key: string) { return key === 'brain.timezone' ? 'UTC' : null; },
      async executeRaw() { return [{ id: 1, slug: 'chat/s', frontmatter, import_filename: null }]; },
      async getChunkWindows() {
        return [{ page_id: 1, slug: 'chat/s', source_id: 'default', type: 'note', revision: 'r1', sealed: true, max_chunk_index: 1, row_limited: false,
          compiled_truth: body, timeline: '', chunks: chunks.map((t, i) => ({ id: 1000 + i, chunk_index: i, chunk_text: t, chunk_source: 'compiled_truth' })) }];
      },
    } as never;
  }
  const hit: SearchResult = { slug: 'chat/s', page_id: 1, title: 'S', type: 'note', chunk_text: chunks[1], chunk_source: 'compiled_truth', chunk_id: 1001, chunk_index: 1, score: 1, stale: false, source_id: 'default' };
  const plan = (budget: number, dateHeader: boolean): EvidencePlan => ({ requestedUnit: 'page', unit: 'page', window: 1, budgetTokens: budget, explicitUnit: true,
    budgetExplicit: false, packing: DEFAULT_AUTO_PACKING, ...(dateHeader ? { dateHeader: true as const } : {}) });

  test('every block starts with its header; tokens and spans account for it', async () => {
    const off = await deliverEvidence(stub({ date: '2026-03-05' }), [hit], plan(32000, false), {});
    const on = await deliverEvidence(stub({ date: '2026-03-05' }), [hit], plan(32000, true), {});
    const header = '[observed 2026-03-05]\n';
    expect(on.results[0].chunk_text).toBe(header + off.results[0].chunk_text);
    expect(on.results[0].delivered.tokens).toBe(off.results[0].delivered.tokens + countEvidenceTokens(header));
    expect(on.delivery.tokens_delivered).toBe(countEvidenceTokens(on.results[0].chunk_text));
    expect(on.delivery.date_header).toBe(true);
    expect(off.delivery.date_header).toBeUndefined();
    const spanOn = on.results[0].delivered.match_spans[0];
    const spanOff = off.results[0].delivered.match_spans[0];
    expect(on.results[0].chunk_text.slice(spanOn.start, spanOn.end)).toBe(off.results[0].chunk_text.slice(spanOff.start, spanOff.end));
  });

  test('the budget is honoured with the header counted', async () => {
    for (const budget of [12, 40, 120, 400]) {
      const on = await deliverEvidence(stub({}), [hit], plan(budget, true), {});
      expect(on.results[0].chunk_text).toMatch(HEADER_LINE);
      expect(on.results[0].chunk_text.startsWith('[observed unknown]\n')).toBe(true);
      expect(on.delivery.budget_used).toBeLessThanOrEqual(budget);
    }
  });

  test('under the explicit-budget cap the header is paid first and kept whole, and the budget holds', async () => {
    const note: SearchResult = { ...hit, slug: 'notes/s', type: 'note', chunk_text: 'A plain note chunk about the walrus pricing plan. '.repeat(12) };
    const capped = (budget: number): EvidencePlan => ({ requestedUnit: 'auto', unit: 'auto', window: 1, budgetTokens: budget, explicitUnit: true,
      budgetExplicit: true, packing: DEFAULT_AUTO_PACKING, dateHeader: true });
    for (const budget of [40, 120, 4000]) {
      const on = await deliverEvidence(stub({}), [note], capped(budget), {});
      const row = on.results[0];
      expect(on.delivery.auto_packing).toBe(DEFAULT_AUTO_PACKING);
      expect(on.delivery.date_header).toBe(true);
      expect(row.chunk_text.startsWith('[observed unknown]\n')).toBe(true);
      expect(row.delivered.match_spans.every(s => s.start >= '[observed unknown]\n'.length)).toBe(true);
      expect(on.delivery.budget_used).toBeLessThanOrEqual(budget);
    }
  });

  test('a failed date read renders unknown and says so', async () => {
    const engine = Object.assign(stub({}) as object, { async executeRaw() { throw new Error('boom'); } }) as never;
    const on = await deliverEvidence(engine, [hit], plan(32000, true), {});
    expect(on.results[0].chunk_text.startsWith('[observed unknown]\n')).toBe(true);
    expect(on.delivery.fallbacks).toContain('date_header_unavailable');
  });
});

describe('ops on PGLite', () => {
  let engine: PGLiteEngine;
  let lastMeta: Record<string, any> | null = null;
  const op = (name: string) => operations.find(o => o.name === name)!;
  const ctxOf = (overrides: Partial<OperationContext> = {}): OperationContext => ({
    engine: engine as never, config: {} as never, logger: console as never, dryRun: false, remote: false, sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') lastMeta = value as Record<string, any>; },
    ...overrides,
  }) as OperationContext;
  const SESSION = Array.from({ length: 12 }, (_, i) => `**user:** question ${i} about the walrus launch\n\n**assistant:** reply ${i} on walrus timelines`).join('\n\n');
  const NOTE = '## Walrus\n\nThe walrus pricing note describes the plan.';

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const pages: Array<[string, string, Record<string, unknown>]> = [
      ['chat/2026-02-10-walrus', SESSION, {}],
      ['notes/walrus-dated', NOTE, { date: '2026-03-05', event_date: '2020-01-01' }],
      ['notes/walrus-undated', NOTE.replace('pricing', 'support'), {}],
    ];
    for (const [slug, body, frontmatter] of pages) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter });
      await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: '' }));
    }
    await engine.setConfig('search.mcp_keyword_only', 'true');
    await engine.insertFact({ fact: 'Walrus launch is in March', kind: 'fact', entity_slug: 'notes/walrus-dated', source: 'test', visibility: 'world',
      valid_from: new Date('2026-03-01T00:00:00Z') }, { source_id: 'default' });
  }, 240_000);

  afterAll(async () => { await engine.disconnect(); }, 240_000);

  test('default off: no header, no meta key, recall facts unchanged', async () => {
    const rows = await op('search').handler(ctxOf(), { query: 'walrus', return_unit: 'page' }) as SearchResult[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => HEADER_LINE.test(r.chunk_text))).toBe(false);
    expect(lastMeta!.delivery.date_header).toBeUndefined();
    const recall = await op('recall').handler(ctxOf(), { entity: 'notes/walrus-dated' }) as Record<string, any>;
    expect(recall.facts[0].date_header).toBeUndefined();
  });

  test('on: query/search blocks carry observed dates; recall facts carry their validity window', async () => {
    await engine.setConfig(EVIDENCE_DATE_HEADER_KEY, 'true');
    try {
      const rows = await op('query').handler(ctxOf(), { query: 'walrus', return_unit: 'page', expand: false }) as SearchResult[];
      const by = (slug: string) => rows.find(r => r.slug === slug)!;
      expect(by('chat/2026-02-10-walrus').chunk_text.split('\n')[0]).toBe('[observed 2026-02-10]');
      expect(by('notes/walrus-dated').chunk_text.split('\n')[0]).toBe('[observed 2026-03-05]');
      expect(by('notes/walrus-undated').chunk_text.split('\n')[0]).toBe('[observed unknown]');
      expect(lastMeta!.delivery.date_header).toBe(true);
      expect(lastMeta!.delivery.budget_used).toBeLessThanOrEqual(lastMeta!.delivery.budget_tokens);
      const auto = await op('search').handler(ctxOf(), { query: 'walrus' }) as SearchResult[];
      expect(auto.every(r => HEADER_LINE.test(r.chunk_text))).toBe(true);
      const recall = await op('recall').handler(ctxOf(), { entity: 'notes/walrus-dated' }) as Record<string, any>;
      expect(recall.facts[0].date_header).toBe('[observed unknown; valid 2026-03-01 to unknown]');
    } finally {
      await engine.unsetConfig(EVIDENCE_DATE_HEADER_KEY);
    }
  });

  test('on: a fact from a dated source page is observed on that date; a fact written without a date does not show the write time as valid-from', async () => {
    await engine.setConfig(EVIDENCE_DATE_HEADER_KEY, 'true');
    try {
      const fromChat = await engine.insertFact({ fact: 'Walrus moved its launch to April', kind: 'fact', entity_slug: 'notes/walrus-undated', source: 'test', visibility: 'world',
        valid_from: new Date('2026-02-10T00:00:00Z') }, { source_id: 'default' });
      await engine.executeRaw('UPDATE facts SET source_markdown_slug = $2 WHERE id = $1', [fromChat.id, 'chat/2026-02-10-walrus']);
      const undated = await op('recall').handler(ctxOf(), { entity: 'notes/walrus-undated' }) as Record<string, any>;
      expect(undated.facts.find((f: any) => f.fact.includes('April')).date_header).toBe('[observed 2026-02-10; valid 2026-02-10 to unknown]');
      const written = await engine.insertFact({ fact: 'Walrus hired a new lead', kind: 'fact', entity_slug: 'notes/walrus-undated', source: 'test', visibility: 'world' }, { source_id: 'default' });
      const again = await op('recall').handler(ctxOf(), { entity: 'notes/walrus-undated' }) as Record<string, any>;
      expect(again.facts.find((f: any) => f.id === written.id).date_header).toBe('[observed unknown; valid unknown to unknown]');
    } finally {
      await engine.unsetConfig(EVIDENCE_DATE_HEADER_KEY);
    }
  });

  test('remember with valid_from stores it, and the header shows it as the start of validity', async () => {
    await engine.setConfig(EVIDENCE_DATE_HEADER_KEY, 'true');
    try {
      await op('remember').handler(ctxOf(), { fact: 'Walrus opened a Porto office', provenance: 'chat on 2026-03-01', entity: 'notes/walrus-undated', valid_from: '2026-03-01' });
      const recall = await op('recall').handler(ctxOf(), { entity: 'notes/walrus-undated' }) as Record<string, any>;
      const row = recall.facts.find((f: any) => f.fact.includes('Porto'));
      expect(row.valid_from.slice(0, 10)).toBe('2026-03-01');
      expect(row.date_header).toBe('[observed unknown; valid 2026-03-01 to unknown]');
    } finally {
      await engine.unsetConfig(EVIDENCE_DATE_HEADER_KEY);
    }
  });

  test('remember rejects a valid_from that is not an ISO 8601 date', async () => {
    await expect(op('remember').handler(ctxOf(), { fact: 'Walrus is in Lisbon', provenance: 'test', valid_from: 'last spring' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('remote clamp: 32k by default and reported; a trusted eval brain raises it with search.return_budget_max_remote', async () => {
    await op('search').handler(ctxOf({ remote: true }), { query: 'walrus', return_unit: 'page', token_budget: 90000 });
    expect(lastMeta!.delivery.budget_clamped).toEqual({ requested: 90000, max: 32000 });
    expect(lastMeta!.delivery.fallbacks).toContain('budget_clamped');
    await engine.setConfig('search.return_budget_max_remote', '200000');
    try {
      await op('search').handler(ctxOf({ remote: true }), { query: 'walrus', return_unit: 'page', token_budget: 90000 });
      expect(lastMeta!.delivery.budget_tokens).toBe(90000);
      expect(lastMeta!.delivery.budget_clamped).toBeUndefined();
      expect(lastMeta!.delivery.fallbacks).not.toContain('budget_clamped');
    } finally {
      await engine.unsetConfig('search.return_budget_max_remote');
    }
  });
});
