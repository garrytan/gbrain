/**
 * BrainEngine parity: the pinned-question reads (src/core/engine-sql/question-reads.ts) at their call sites in
 * src/core/questions/ and src/core/search/entity-anchor.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the evidence facts of a refresh, the newest pages under a pin's slug prefix, the new-facts check of the
 *    freshness watermark, a pin's unknown-source refusal and a receipt's page_materialized read the same on PGLite,
 *    Postgres and Rust. The reads that return pages.generation or read a pin record stop on Rust with a typed refusal
 *    naming the missing piece (test/questions-rust-stops.test.ts pins the message); on the SQL engines a pin with a
 *    slug prefix refreshes end to end and its receipt is the same.
 *  - Regression: every one of these reads ran through executeRaw, so a Rust brain refused them with raw_sql.
 *  - Why existing coverage misses it: test/pinned-questions-*.test.ts run on PGLite only.
 *  - Seam: real engines; pages and facts through typed writes; the model call is a fixed fake answer.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { prefixAnchoredPages } from '../../src/core/search/entity-anchor.ts';
import { pinQuestion, refreshQuestion } from '../../src/core/questions/service.ts';
import { buildReceipt } from '../../src/core/questions/receipt.ts';
import type { PinRow } from '../../src/core/questions/store.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string, opts: { type?: string; frontmatter?: Record<string, unknown> } = {}) =>
  ({ type: (opts.type ?? 'note') as 'note', title, compiled_truth: `body of ${title}`, timeline: '', frontmatter: opts.frontmatter ?? {} });

const ctxFor = (engine: BrainEngine) =>
  ({ engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false } as unknown as OperationContext);

const fact = (row_num: number, text: string, extra: Record<string, unknown> = {}) =>
  ({ fact: text, kind: 'fact', visibility: 'world', notability: 'medium', source: 'test', entity_slug: 'people/alice-example', row_num,
    source_markdown_slug: 'people/alice-example', ...extra });

/** A synthetic pin row, as store.ts reads one; only the fields a receipt reads matter. */
function pinRow(slug: string): PinRow {
  return {
    id: 1, source_id: 'default', slug, question: 'Who leads acme-example?', scope_slug_prefix: 'projects/', scope_entity: null,
    state: 'inactive', inactive_reason: 'awaiting_consent', publish_mode: 'publish', model: null, origin: 'cli', answer: [], answer_revision: 0,
    answer_model: null, revision: 1, last_refresh_at: null, last_attempt_at: null, last_error: null, watermark_generation: null,
    watermark_fact_id: null, watermark_at: null, lease_token: null, lease_owner: null, lease_expires_at: null, spend_usd: 0,
    refresh_attempts: 0, created_by: 'cli', created_at: new Date(0), updated_at: new Date(0),
  } as unknown as PinRow;
}

describe('pinned-question reads on every engine', () => {
  parityTest('the evidence facts of a refresh keep live facts about the pages and drop expired, question-sourced and other-entity facts', {
    methods: ['listQuestionEvidenceFacts'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', page('alice'));
    await engine.putPage('questions/who-leads', page('who leads', { type: 'question' }));
    await engine.putPage('notes/pinned-copy', page('pinned copy', { frontmatter: { pinned_question: true } }));
    const day = (d: number) => new Date(Date.UTC(2026, 0, d));
    await engine.insertFacts([
      fact(1, 'alice leads acme-example', { valid_from: day(3) }),
      fact(2, 'alice joined acme-example', { valid_from: day(1) }),
      fact(3, 'alice left widget-co', { valid_from: day(2), valid_until: day(4) }),
      fact(4, 'bob leads widget-co', { entity_slug: 'people/bob-example', valid_from: day(5) }),
    ] as never, { source_id: 'default' });
    await engine.insertFacts([fact(1, 'the answer says alice leads', { valid_from: day(6), source_markdown_slug: 'questions/who-leads' })] as never,
      { source_id: 'default' });
    await engine.insertFacts([fact(1, 'a copy of the answer', { valid_from: day(7), source_markdown_slug: 'notes/pinned-copy' })] as never,
      { source_id: 'default' });
    const rows = await engine.listQuestionEvidenceFacts('default', ['people/alice-example', 'people/nobody']);
    expect(rows.map(r => r.fact)).toEqual(['alice leads acme-example', 'alice joined acme-example']);
    return rows.map(r => ({ fact: r.fact, entity_slug: r.entity_slug, valid_from: r.valid_from, hash: r.hash }));
  });

  parityTest('an undated evidence fact reads back with no date and ranks by when it was saved, ahead of older dated facts', {
    methods: ['listQuestionEvidenceFacts'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', page('alice'));
    const day = (d: number) => new Date(Date.UTC(2026, 0, d));
    await engine.insertFacts([
      fact(1, 'alice joined acme-example', { valid_from: day(1) }),
      fact(2, 'alice likes tea'),
      fact(3, 'alice leads acme-example', { valid_from: day(3) }),
    ] as never, { source_id: 'default' });
    const rows = (await engine.listQuestionEvidenceFacts('default', ['people/alice-example']))
      .map(r => ({ fact: r.fact, valid_from: r.valid_from }));
    expect(rows).toEqual([
      { fact: 'alice likes tea', valid_from: null },
      { fact: 'alice leads acme-example', valid_from: day(3) },
      { fact: 'alice joined acme-example', valid_from: day(1) },
    ]);
    return rows;
  });

  parityTest('a slug prefix anchors the newest live pages under it, without question, synthesis or pinned-question pages', {
    methods: ['readPrefixAnchoredPages'],
  }, async (engine) => {
    for (const slug of ['projects/a', 'projects/b', 'projects/c', 'projectsx/d', 'proj_a/e', 'projxa/f']) await engine.putPage(slug, page(slug));
    await engine.putPage('projects/q', page('q', { type: 'question' }));
    await engine.putPage('projects/s', page('s', { type: 'synthesis' }));
    await engine.putPage('projects/pin', page('pin', { frontmatter: { pinned_question: true } }));
    await engine.softDeletePage('projects/b');
    const under = (await prefixAnchoredPages(engine, 'default', 'projects/')).map(p => p.slug);
    const escaped = (await prefixAnchoredPages(engine, 'default', 'proj_a/')).map(p => p.slug);
    expect(under).toEqual(['projects/c', 'projects/a']);
    expect(escaped).toEqual(['proj_a/e']);
    return { under, escaped };
  });

  parityTest('the freshness watermark sees an unexpired fact above it, scoped to the entity when the pin names one', {
    methods: ['hasNewQuestionFacts'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', page('alice'));
    await engine.insertFacts([fact(1, 'one'), fact(2, 'two', { entity_slug: 'people/bob-example' })] as never, { source_id: 'default' });
    const ids = (await engine.listQuestionEvidenceFacts('default', ['people/alice-example'])).map(r => r.id);
    const first = ids[0]!;
    const seen = {
      anyAboveZero: await engine.hasNewQuestionFacts('default', 0, null),
      aliceAboveZero: await engine.hasNewQuestionFacts('default', 0, 'people/alice-example'),
      aliceAboveHers: await engine.hasNewQuestionFacts('default', first, 'people/alice-example'),
      bobAboveAlice: await engine.hasNewQuestionFacts('default', first, 'people/bob-example'),
      otherSource: await engine.hasNewQuestionFacts('nowhere', 0, null),
    };
    expect(seen).toEqual({ anyAboveZero: true, aliceAboveZero: true, aliceAboveHers: false, bobAboveAlice: true, otherSource: false });
    return seen;
  });

  parityTest('pinning a question in an unknown source is not_found before any pin write', {
    methods: ['readSourceRow'],
  }, async (engine) => {
    const outcome = await pinQuestion(ctxFor(engine), { question: 'Who leads acme-example?', scope: { source: 'nope', slug_prefix: 'projects/' }, defer: true })
      .then(() => 'pinned', (e: { code?: string }) => e.code ?? String(e));
    expect(outcome).toBe('not_found');
    return outcome;
  });

  parityTest('a receipt says whether the question page exists', {
    methods: ['readLivePageIdBySlug'],
  }, async (engine) => {
    await engine.putPage('questions/who-leads-acme-example', page('who leads', { type: 'question' }));
    const view = { readableSources: null, includeAnswer: true, remote: false };
    const present = await buildReceipt(engine, pinRow('questions/who-leads-acme-example'), view);
    const absent = await buildReceipt(engine, pinRow('questions/never-written'), view);
    expect([present.page_materialized, absent.page_materialized]).toEqual([true, false]);
    return { present, absent };
  });

  // These reads return or compare pages.generation, which the Rust store does not keep yet: it refuses them by name
  // (rust-engine/question-stops.ts). The SQL engines read the same rows.
  parityTest('the timeline and takes of the evidence pages, and the new-pages check of the watermark', {
    methods: ['listQuestionEvidenceTimeline', 'listQuestionEvidenceTakes', 'hasNewQuestionPages'],
  }, async (engine) => {
    const a = await engine.putPage('projects/acme-example', page('acme-example'));
    await engine.putPage('projects/acme-example-q', page('q', { type: 'question' }));
    await engine.addTimelineEntry('projects/acme-example', { date: '2026-01-02', summary: 'founded', detail: 'in a garage' });
    await engine.addTimelineEntry('projects/acme-example', { date: '2026-03-04', summary: 'raised', detail: '' });
    await engine.addTakesBatch([
      { page_id: a.id, row_num: 1, claim: 'acme-example will win.', kind: 'take', holder: 'people/b-example', weight: 0.7 },
      { page_id: a.id, row_num: 2, claim: 'acme-example will stall.', kind: 'hunch', holder: 'people/c-example', weight: 1 },
    ] as never);
    // knowledge_revision is a random uuid per engine: only its presence is compared.
    const timeline = (await engine.listQuestionEvidenceTimeline([a.id])).map(({ id: _i, page_id: _p, revision, ...t }) => ({ ...t, revision: typeof revision }));
    const takes = (await engine.listQuestionEvidenceTakes([a.id])).map(({ id: _i, page_id: _p, revision, ...k }) => ({ ...k, revision: typeof revision }));
    const clock = await engine.readQuestionEvidenceClock('default');
    const fresh = {
      below: await engine.hasNewQuestionPages('default', clock.generation - 1, null),
      atTop: await engine.hasNewQuestionPages('default', clock.generation, null),
      otherPrefix: await engine.hasNewQuestionPages('default', 0, 'notes/'),
      underPrefix: await engine.hasNewQuestionPages('default', 0, 'projects/'),
    };
    expect(timeline.map(t => t.summary)).toEqual(['raised', 'founded']);
    expect(takes.map(k => k.claim)).toEqual(['acme-example will stall.', 'acme-example will win.']);
    return { timeline, takes, fresh };
  });

  // The pin records and pages.generation are not in the Rust store yet: the pin's first write refuses there by name
  // before anything is written (rust-engine/question-stops.ts). The SQL engines pin, refresh and publish end to end.
  parityTest('a pin with a slug prefix refreshes end to end and publishes a cited answer', {
    methods: ['readPrefixAnchoredPages', 'listQuestionCandidatePages', 'listPublishedQuestionAnswers', 'readQuestionEvidenceClock',
      'readQuestionPageRow', 'listQuestionEvidenceJoin', 'lockQuestionEvidenceRows'],
    requires: 'raw_sql',
  }, async (engine) => {
    await engine.putPage('projects/acme-example', page('acme-example leadership'));
    await engine.putPage('projects/widget-co', page('widget-co roadmap'));
    const ctx = ctxFor(engine);
    const chat = async (req: { user: string }) => {
      const ref = /(E\d+): \[page projects\/acme-example\]/.exec(req.user)?.[1] ?? 'E1';
      return { text: JSON.stringify({ sentences: [{ text: 'Alice leads acme-example.', cite: [ref] }], gaps: [] }), model: 'test-model',
        usage: { input_tokens: 10, output_tokens: 5 }, truncated: false };
    };
    const pinned = await pinQuestion(ctx, { question: 'Who leads acme-example?', scope: { slug_prefix: 'projects/' }, defer: true });
    const refreshed = await refreshQuestion(ctx, { id: pinned.receipt.id, full: true }, { chat: chat as never });
    expect(refreshed.refresh?.status).toBe('published');
    const { last_refresh_at: _a, last_attempt_at: _b, evidence_watermark, ...receipt } = refreshed;
    return { receipt, watermark: evidence_watermark ? { ...evidence_watermark, at: typeof evidence_watermark.at } : null };
  });
});
