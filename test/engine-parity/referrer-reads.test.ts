/**
 * BrainEngine parity: the referrer page and the record reads of mentions/referrers.ts, through the production paths
 * (get_backlinks `group: "page"`, readReferrerPage, readTargetReferences).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) a referrer page lists the same referring pages newest first by
 *    `(date DESC, source_id, slug)`, filters by canonical or stored type, continues after a cursor without a skip or
 *    a repeat (a date tie breaks on source and slug), hides a private referrer from an untrusted caller, and counts
 *    the same total; the record read returns the same per-target record rows, caps, cursors and titles.
 *  - Regression: get_backlinks with group "page" and the entity card's records stopped on the Rust engine's raw-SQL
 *    refusal, so a Rust brain had no paged backlinks and no record rows.
 *  - Why existing coverage misses it: test/engine-parity/mention-coverage.test.ts reads one unpaged group page and
 *    asserts the coverage only; test/engine-parity/link-temporal.test.ts calls the card members, not these reads.
 *  - Seam: none. Real engines and the production functions only. Every referrer has an effective date, so dates do
 *    not depend on when an arm wrote the page, except in the same-millisecond case: there two undated referrers get
 *    exact microsecond `updated_at` times through the harness fixture `stampUpdatedAt` (the SQL arms; the Rust arm
 *    keeps its write times, written in the same order).
 *  - Same-millisecond regression: the Postgres cursor bound its date as `$7::timestamptz`, which postgres.js turns into
 *    a JavaScript Date (milliseconds only), so the next page skipped an undated referrer updated earlier in the same
 *    millisecond as the cursor row.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { readReferrerPage, readTargetReferences, type ReferrerScope } from '../../src/core/mentions/referrers.ts';
import { createSource, parityArms, stampUpdatedAt } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ACME = 'companies/acme-example';
const WIDGET = 'companies/widget-co';

function page(title: string, date: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', effective_date: new Date(`${date}T00:00:00Z`),
    effective_date_source: 'date', ...extra };
}

/**
 * Acme with six live referrers in `default` (two share a date), one private, one soft-deleted; one referrer in
 * `other`; Widget with two meetings and a note.
 */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  await engine.putPage(ACME, page('Acme Example', '2020-01-01', { type: 'company' }));
  await engine.putPage(WIDGET, page('Widget', '2020-01-01', { type: 'company' }));
  await engine.putPage('meetings/kickoff', page('Kickoff', '2026-03-01', { type: 'meeting' }));
  await engine.putPage('meetings/review', page('Review', '2026-05-01', { type: 'meeting', frontmatter: { status: 'done' } }));
  await engine.putPage('notes/a-tie', page('A tie', '2026-04-01'));
  await engine.putPage('notes/b-tie', page('B tie', '2026-04-01'));
  await engine.putPage('notes/loose', page('Loose', '2026-02-01', { type: '' as PageInput['type'] }));
  await engine.putPage('notes/secret', page('Secret', '2026-06-01', { frontmatter: { visibility: 'private' } }));
  await engine.putPage('notes/gone', page('Gone', '2026-07-01'));
  await engine.putPage('notes/elsewhere', page('Elsewhere', '2026-08-01'), { sourceId: 'other' });
  await engine.putPage('meetings/w1', page('W1', '2026-01-01', { type: 'meeting' }));
  await engine.putPage('meetings/w2', page('W2', '2026-01-02', { type: 'meeting' }));
  await engine.putPage('notes/w-note', page('W note', '2026-01-03'));
  const from = (slugs: string[], to: string, sourceId = 'default') => engine.addLinksBatch(slugs.map(f => ({ from_slug: f, to_slug: to,
    link_type: 'mentions', context: '', link_source: 'manual', from_source_id: sourceId, to_source_id: 'default' })));
  await from(['meetings/kickoff', 'meetings/review', 'notes/a-tie', 'notes/b-tie', 'notes/loose', 'notes/secret', 'notes/gone'], ACME);
  await from(['notes/elsewhere'], ACME, 'other');
  await from(['meetings/w1', 'meetings/w2', 'notes/w-note'], WIDGET);
  await engine.softDeletePage('notes/gone', { sourceId: 'default' });
}

function ctxFor(engine: BrainEngine, notices: Notice[]): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} }, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as OperationContext;
}

function scope(slug: string, excludePrivate: boolean): ReferrerScope {
  return { slug, sourceId: 'default', referrerSources: ['default', 'other'], excludePrivate, pack: null,
    keepVisibility: excludePrivate ? ['world'] : ['private', 'world'] };
}

type Row = { slug: string; source_id: string; title: string; type: string | null; canonical_type: string; date: string | null; date_source: string;
  page_status?: string };
const view = (rows: Row[]) => rows.map(r => [r.source_id, r.slug, r.title, r.type, r.canonical_type, r.date, r.date_source, r.page_status ?? null]);

describe('engine parity: referrer page and record reads', () => {
  parityTest(
    'get_backlinks with group page pages newest first, breaks a date tie on source and slug, and continues after the cursor',
    { methods: ['putPage', 'softDeletePage', 'addLinksBatch', 'listReferrerTargetSources', 'countReferrerRows', 'readReferrerRows'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const op = operations.find(o => o.name === 'get_backlinks')!;
      const notices: Notice[] = [];
      const pages: Array<{ rows: Row[]; total: number; truncated: boolean }> = [];
      let cursor: string | undefined;
      do {
        const r = await op.handler(ctxFor(engine, notices), { slug: ACME, group: 'page', limit: 2, ...(cursor ? { cursor } : {}) }) as
          { rows: Row[]; total: number; truncated: boolean; cursor: string | null };
        pages.push({ rows: r.rows, total: r.total, truncated: r.truncated });
        cursor = r.cursor ?? undefined;
      } while (cursor && pages.length < 5);
      const untyped = await op.handler(ctxFor(engine, notices), { slug: ACME, group: 'page', type: 'untyped' }) as { rows: Row[]; total: number };
      const missing = await op.handler(ctxFor(engine, notices), { slug: 'companies/nobody-example', group: 'page' }) as { rows: Row[]; total: number };
      const out = { pages: pages.map(p => ({ rows: view(p.rows), total: p.total, truncated: p.truncated })),
        untyped: { rows: view(untyped.rows), total: untyped.total }, missing: { rows: missing.rows, total: missing.total } };
      expect(out.pages.map(p => p.rows.map(r => r[1]))).toEqual([
        ['notes/secret', 'meetings/review'], ['notes/a-tie', 'notes/b-tie'], ['meetings/kickoff', 'notes/loose']]);
      expect(out.pages.map(p => [p.total, p.truncated])).toEqual([[6, true], [6, true], [6, false]]);
      expect(out.pages[0]!.rows[1]).toEqual(['default', 'meetings/review', 'Review', 'meeting', 'meeting', '2026-05-01T00:00:00.000000Z', 'date', 'done']);
      expect(out.untyped).toEqual({ rows: [['default', 'notes/loose', 'Loose', null, 'untyped', '2026-02-01T00:00:00.000000Z', 'date', null]], total: 1 });
      expect(out.missing).toEqual({ rows: [], total: 0 });
      return out;
    },
  );

  parityTest(
    'a referrer page filters by type, reads other sources in scope, and hides a private referrer from an untrusted caller',
    { methods: ['putPage', 'softDeletePage', 'addLinksBatch', 'countReferrerRows', 'readReferrerRows'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const local = await readReferrerPage(engine, scope(ACME, false), { limit: 10 });
      const remote = await readReferrerPage(engine, scope(ACME, true), { limit: 10 });
      const meetings = await readReferrerPage(engine, scope(ACME, false), { type: 'meeting', limit: 1 });
      const next = await readReferrerPage(engine, scope(ACME, false), { type: 'meeting', limit: 1,
        cursor: [meetings.rows[0]!.date, meetings.rows[0]!.source_id, meetings.rows[0]!.slug] });
      const records = await readReferrerPage(engine, scope(ACME, false), { type: 'meeting', limit: 5, recordMetadata: true });
      const out = { local: { rows: view(local.rows), total: local.total }, remote: { rows: view(remote.rows), total: remote.total },
        meetings: { rows: view(meetings.rows), total: meetings.total, truncated: meetings.truncated }, next: { rows: view(next.rows), cursor: next.cursor },
        records: view(records.rows) };
      expect(out.local.rows.map(r => `${r[0]}:${r[1]}`)).toEqual(['other:notes/elsewhere', 'default:notes/secret', 'default:meetings/review',
        'default:notes/a-tie', 'default:notes/b-tie', 'default:meetings/kickoff', 'default:notes/loose']);
      expect(out.remote.rows.map(r => r[1])).not.toContain('notes/secret');
      expect([out.local.total, out.remote.total]).toEqual([7, 6]);
      expect(out.meetings).toMatchObject({ total: 2, truncated: true });
      expect(out.next.rows.map(r => r[1])).toEqual(['meetings/kickoff']);
      expect(out.records.map(r => [r[1], r[7]])).toEqual([['meetings/review', 'done'], ['meetings/kickoff', null]]);
      return out;
    },
  );

  parityTest(
    'the batched record read returns each target\'s newest records with titles and caps them per page and per call',
    { methods: ['putPage', 'softDeletePage', 'addLinksBatch', 'readReferrerTargetCounts', 'readReferrerRecordCandidates', 'readReferrerRecordPages'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const base = { referrerSources: ['default', 'other'], excludePrivate: false, pack: null, keepVisibility: ['private', 'world'] as ('private' | 'world')[] };
      const targets = [{ slug: ACME, sourceId: 'default' }, { slug: WIDGET, sourceId: 'default' }, { slug: 'companies/nobody-example', sourceId: 'default' },
        { slug: ACME, sourceId: 'default' }];
      const shape = (r: Awaited<ReturnType<typeof readTargetReferences>>) => r.map(t => ({ count: t.referenced_by_count,
        records: (t.records ?? []).map(g => ({ type: g.canonical_type, total: g.total, capped: g.capped ?? null, cursor: g.cursor,
          rows: g.rows.map(x => [x.slug, x.title, x.date, x.date_source, x.page_status ?? null]) })) }));
      const wide = shape(await readTargetReferences(engine, base, targets, { recordTypes: ['meeting', 'note'] }));
      const tight = shape(await readTargetReferences(engine, base, targets, { recordTypes: ['meeting'], perTarget: 1, perCall: 1 }));
      const countsOnly = shape(await readTargetReferences(engine, base, targets, { recordTypes: [] }));
      expect(wide.map(t => t.count)).toEqual([7, 3, 0, 7]);
      expect(wide[0]!.records.map(g => [g.type, g.total, g.rows.map(x => x[0])])).toEqual([
        ['note', 4, ['notes/elsewhere', 'notes/secret', 'notes/a-tie', 'notes/b-tie']], ['meeting', 2, ['meetings/review']]]);
      expect(wide[0]!.records[1]!.rows[0]).toEqual(['meetings/review', 'Review', '2026-05-01T00:00:00.000000Z', 'date', 'done']);
      expect(tight.map(t => t.records.map(g => [g.type, g.total, g.capped, g.rows.length]))).toEqual([
        [['meeting', 2, 'per_page', 1]], [['meeting', 2, 'per_call', 0]], [], [['meeting', 2, 'per_page', 1]]]);
      expect(countsOnly.map(t => t.count)).toEqual([7, 3, 0, 7]);
      return { wide, tight, countsOnly };
    },
  );
  parityTest(
    'a referrer page continues after a cursor without skipping an undated referrer updated in the same millisecond',
    { methods: ['putPage', 'addLinksBatch', 'listReferrerTargetSources', 'countReferrerRows', 'readReferrerRows'] },
    async (engine: BrainEngine, backend) => {
      await engine.putPage(ACME, page('Acme Example', '2020-01-01', { type: 'company' }));
      // Older first: the Rust arm keeps each write's time, so a-undated is the newer page there too.
      const undated = { effective_date: null, effective_date_source: null };
      await engine.putPage('notes/b-undated', page('B undated', '2026-03-01', undated));
      await engine.putPage('notes/a-undated', page('A undated', '2026-03-01', undated));
      await engine.addLinksBatch(['notes/b-undated', 'notes/a-undated'].map(f => ({ from_slug: f, to_slug: ACME, link_type: 'mentions',
        context: '', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })));
      await stampUpdatedAt(engine, backend, 'default', 'notes/b-undated', '2026-03-01T12:00:00.000200Z');
      await stampUpdatedAt(engine, backend, 'default', 'notes/a-undated', '2026-03-01T12:00:00.000700Z');
      const op = operations.find(o => o.name === 'get_backlinks')!;
      const notices: Notice[] = [];
      const pages: Row[][] = [];
      const shape: Array<[number, boolean]> = [];
      let cursor: string | undefined;
      do {
        const r = await op.handler(ctxFor(engine, notices), { slug: ACME, group: 'page', limit: 1, ...(cursor ? { cursor } : {}) }) as
          { rows: Row[]; total: number; truncated: boolean; cursor: string | null };
        pages.push(r.rows);
        shape.push([r.total, r.truncated]);
        cursor = r.cursor ?? undefined;
      } while (cursor && pages.length < 4);
      if (backend !== 'rust') {
        expect(pages.flat().map(r => [r.slug, r.date, r.date_source])).toEqual([
          ['notes/a-undated', '2026-03-01T12:00:00.000700Z', 'updated_at'], ['notes/b-undated', '2026-03-01T12:00:00.000200Z', 'updated_at']]);
      }
      const out = { pages: pages.map(rows => rows.map(r => [r.slug, r.date_source])), shape };
      expect(out).toEqual({ pages: [[['notes/a-undated', 'updated_at']], [['notes/b-undated', 'updated_at']]], shape: [[2, true], [2, false]] });
      return out;
    },
  );
  parityTest(
    'with no source in scope, get_backlinks reads every source, accepts a type a referrer has, and filters array mode by type',
    { methods: ['putPage', 'softDeletePage', 'addLinksBatch', 'listSourceIds', 'readReferrerTypes', 'listReferrerTargetSources', 'countReferrerRows', 'readReferrerRows'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const op = operations.find(o => o.name === 'get_backlinks')!;
      const notices: Notice[] = [];
      const ctx = { ...ctxFor(engine, notices), sourceId: undefined } as unknown as OperationContext;
      const slugs = (rows: Array<{ slug?: string; from_slug?: string }>) => rows.map(r => r.slug ?? r.from_slug);
      // `note` is no pack type, so the referrers' observed types (readReferrerTypes) accept it.
      const notes = await op.handler(ctx, { slug: ACME, group: 'page', type: 'note' }) as { rows: Row[]; total: number };
      const meetings = await op.handler(ctx, { slug: ACME, type: 'meeting' }) as Array<{ from_slug: string }>;
      const bogus = await op.handler(ctx, { slug: ACME, group: 'page', type: 'nonsense-type' }).then(() => 'accepted', (e: Error) => e.message);
      const out = { notes: { slugs: slugs(notes.rows), sources: notes.rows.map(r => r.source_id), total: notes.total },
        meetings: slugs(meetings).sort(), bogus, notices: notices.map(n => n.code) };
      expect(out.notes).toEqual({ slugs: ['notes/elsewhere', 'notes/secret', 'notes/a-tie', 'notes/b-tie'],
        sources: ['other', 'default', 'default', 'default'], total: 4 });
      expect(out.meetings).toEqual(['meetings/kickoff', 'meetings/review']);
      expect(out.bogus).toContain('nonsense-type');
      return out;
    },
  );
});
