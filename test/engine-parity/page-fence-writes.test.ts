/**
 * BrainEngine parity: a put_page that updates a page with a `## Facts` and a `## Takes` fence, and the typed members its
 * fence projection, fence guard and a tier-only row change run, and the unwithdrawn-facts classifier's page body read.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a put_page that creates a page with a facts fence and a takes fence, then a put_page that edits one fact
 *    row's cells, drops another, adds a third, changes one take's claim and resolves another, leaves the same fact and
 *    take rows on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). Each typed member the
 *    projection runs answers and writes the same rows on every arm when called directly. A Takes fence row resolved on a
 *    date written the ways Postgres reads `text::timestamptz` stores the same instant on every arm, and the dates
 *    Postgres refuses fail the save on every arm. A date written with a zone name (`America/New_York`) or a date-dependent
 *    zone abbreviation (`MSK`, `SGT`) stores the instant the zone had on that date on every arm, a skipped or repeated
 *    local time included.
 *  - Regression: the projection read and wrote the page's fact and take rows through executeRaw, so on the Rust engine
 *    any put_page that updated a page with a facts or takes fence stopped on the raw SQL refusal.
 *  - Why existing coverage misses it: the parity files seed fenced pages through engine.putPage, which runs no fence
 *    projection, and the repair kinds that write a fenced page were pinned as stops on the Rust engine.
 *  - Seam: pages are written through the put_page operation (submitPageMutation) on the default source; facts and takes
 *    are seeded through typed members (insertFacts, addTakesBatch). Generated ids and times are compared by shape.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { fenceOwnerKey, TAKE_FENCE_KIND } from '../../src/core/generations/fence.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'people/alice-example';
const logger = { info() {}, warn() {}, error() {} };

const factsFence = (rows: Array<[number, string, string, string]>) => ['## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  ...rows.map(([n, claim, notability, context]) => `| ${n} | ${claim} | fact | 1.0 | private | ${notability} | 2020-01-01 |  | chat | ${context} |`),
  '<!--- gbrain:facts:end -->', ''].join('\n');

const takesFence = (rows: string[]) => ['## Takes', '', '<!--- gbrain:takes:begin -->',
  '| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |',
  '|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|', ...rows, '<!--- gbrain:takes:end -->', ''].join('\n');

const page = (facts: string, takes: string) => `---\ntype: person\ntitle: Alice Example\n---\n# Alice Example\n\nA synthetic person.\n\n${facts}\n${takes}`;

async function put(engine: BrainEngine, content: string) {
  const ctx = { engine, sourceId: 'default', remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as unknown as OperationContext;
  const prior = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  return submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, content, request_id: randomUUID(),
    ...(prior ? { expected_revision: prior.revision } : {}) } });
}

/** The page's fact rows (every state) and takes, without ids and times. */
async function rows(engine: BrainEngine) {
  const ids = await engine.listFactIdsBySourcePrefix('default', SLUG, '');
  const facts = (await engine.readFactPreimages('default', ids)).map(f => ({ row_num: f.row_num, fact: f.fact, visibility: f.visibility,
    expired: f.expired_at !== null, source: f.source ?? null }))
    .sort((a, b) => `${a.row_num ?? 99}:${a.fact}`.localeCompare(`${b.row_num ?? 99}:${b.fact}`));
  const pageId = Number((await engine.getPage(SLUG, { sourceId: 'default' }))!.id);
  const takes = (await engine.listTakes({ page_id: pageId } as never)).map(t => {
    const r = t as unknown as Record<string, unknown>;
    return { row_num: r.row_num, claim: r.claim, holder: r.holder, active: r.active, resolved: r.resolved_at != null, quality: r.resolved_quality ?? null,
      outcome: r.resolved_outcome ?? null };
  }).sort((a, b) => Number(a.row_num) - Number(b.row_num));
  return { facts, cells: await engine.listPageFenceFactCells('default', SLUG).then(c => c.sort((a, b) => a.row_num - b.row_num)), takes };
}

describe('engine parity: put_page with a facts and a takes fence', () => {
  parityTest('a put_page that edits, drops and adds fence rows leaves the same facts and takes on every arm', {
    methods: ['listFactIdsBySourcePrefix', 'readFactPreimages', 'listTakes', 'listPageFenceFactCells', 'refreshFenceFactFields', 'listOccupiedFenceRowNums',
      'listFactsAboveWriter', 'clearChangedTakeResolutions', 'writeFenceTakeResolutions'],
    timeout: 90_000,
  }, async (engine) => {
    await put(engine, page(factsFence([[1, 'Alice founded acme-example', 'medium', 'from the board memo'], [2, 'Alice runs marathons', 'low', '']]),
      takesFence(['| 1 | Acme example ships in Q3 | bet | world | 0.6 | 2026-01 | call notes |  |  |  |  |  |  |', '| 2 | Widget co hires a CFO | bet | world | 0.5 | 2026-01 | memo |  |  |  |  |  |  |'])));
    const created = await rows(engine);
    await put(engine, page(factsFence([[1, 'Alice founded acme-example', 'high', 'from the signed board memo'], [3, 'Alice speaks Portuguese', 'medium', '']]),
      takesFence(['| 1 | Acme example ships in Q4 | bet | world | 0.6 | 2026-01 | call notes |  |  |  |  |  |  |',
        '| 2 | Widget co hires a CFO | bet | world | 0.5 | 2026-01 | memo | 2026-03-01 | correct | the filing |  |  | alice-example |'])));
    const edited = await rows(engine);
    expect(edited.cells.map(c => c.row_num)).toEqual([1, 3]);
    expect(edited.takes.map(t => [t.row_num, t.claim, t.resolved, t.quality])).toEqual([[1, 'Acme example ships in Q4', false, null], [2, 'Widget co hires a CFO', true, 'correct']]);
    return { created, edited };
  });

  /** A Takes fence row resolved on `resolved`; the stored resolved_at as ISO text, or the save's error code and message. */
  async function resolvedAtOf(engine: BrainEngine, resolved: string) {
    await put(engine, page(factsFence([[1, 'Alice founded acme-example', 'medium', '']]),
      takesFence(['| 1 | Widget co hires a CFO | bet | world | 0.5 | 2026-01 | memo |  |  |  |  |  |  |'])));
    try {
      await put(engine, page(factsFence([[1, 'Alice founded acme-example', 'medium', '']]),
        takesFence([`| 1 | Widget co hires a CFO | bet | world | 0.5 | 2026-01 | memo | ${resolved} | correct |  |  |  |  |`])));
    } catch (error) {
      const request = (error as { writeRequest?: { blocked_reason?: unknown; write_error?: unknown } }).writeRequest;
      // A refused publication step parks the request as blocked, or ends it failed with the refusal as its write error.
      const blocked = request?.blocked_reason ?? request?.write_error;
      return { error: (error as { code?: string }).code ?? 'thrown', message: (error as Error).message, ...(blocked ? { blocked } : {}) };
    }
    const pageId = Number((await engine.getPage(SLUG, { sourceId: 'default' }))!.id);
    const take = (await engine.listTakes({ page_id: pageId } as never))[0] as unknown as Record<string, unknown>;
    return { resolved_at: take.resolved_at == null ? null : new Date(take.resolved_at as string).toISOString() };
  }

  parityTest('a Takes fence resolved on a date written the ways Postgres reads it stores the same instant on every arm', {
    methods: ['listTakes', 'writeFenceTakeResolutions'],
    timeout: 120_000,
  }, async (engine) => {
    const out: Record<string, unknown> = {};
    for (const resolved of ['March 1, 2026', '2026/03/01', '03/01/2026', '3/1/26', '1 March 2026', 'Sunday, March 1, 2026', '01-Mar-2026',
      '2026-Mar-01', '2026.03.01', '20260301', 'Mar 1 2026 10:30', '2026-03-01 10:00:00+02', '2026-03-01T10:00Z', '2026-03-01 10:00 UTC',
      '2026-03-01 10:00:00.25 pm', '2026-03-01 24:00', '2026-03-01 10:00 PST', '2026-03-01 10:00 CEST', 'March 1 2026 10:00 BST', '2026-02-30', '2026/13/01', '2026-03-01 25:00', '2026-03-01 10:00 +16:00', '2026-03', 'soon']) {
      out[resolved] = await resolvedAtOf(engine, resolved);
    }
    return out;
  });

  parityTest('a Takes fence resolved on a date with a zone name or a date-dependent zone abbreviation stores the same instant on every arm', {
    methods: ['listTakes', 'writeFenceTakeResolutions'],
    timeout: 120_000,
  }, async (engine) => {
    const out: Record<string, unknown> = {};
    // MSK meant +04 from 2011 to 2014; SGT is no abbreviation of Asia/Singapore's tzdata, so it reads the zone's
    // offset on the date (+07:30 in 1980). 02:30 on Mar 8 2026 is skipped in New York; 01:30 on Nov 1 2026 repeats.
    for (const resolved of ['2026-03-01 10:00 MSK', '2012-03-01 10:00 msk', '1985-07-01 12:00 MSK', '1980-03-01 10:00 SGT',
      '2026-03-01 10:00 America/New_York', '2026-03-08 02:30 America/New_York', '2026-11-01 01:30 america/new_york',
      '2026-07-01 10:00 Europe/Moscow', '2026-03-01 10:00 EST5EDT', '2026-03-01 10:00 Etc/GMT+3', 'Japan 2026-03-01 10:00']) {
      out[resolved] = await resolvedAtOf(engine, resolved);
    }
    expect(out['2026-03-01 10:00 MSK']).toEqual({ resolved_at: '2026-03-01T07:00:00.000Z' });
    return out;
  });

  parityTest('the fence projection fact members answer and write the same rows on every arm', {
    methods: ['insertFacts', 'listPageFenceFactCells', 'hasPositionedPageFacts', 'listOccupiedFenceRowNums', 'readLiveFenceFactAt', 'listFactsAboveWriter',
      'listTrustedPrivateCopies', 'detachFenceFactRows', 'moveGuardedFenceRows', 'refreshFenceFactFields', 'expireFenceFacts', 'readPageInlineBody'],
  }, async (engine) => {
    const created = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: 'A synthetic person.', timeline: '' }, { sourceId: 'default' });
    const row = (fact: string, n: number | null, source = 'fence', visibility = 'private') =>
      ({ fact, kind: 'fact', entity_slug: SLUG, visibility, source, context: null, row_num: n, source_markdown_slug: SLUG });
    const res = await engine.insertFacts([row('One', 1), row('Two', 2), row('Three', 3, 'cli:extract-conversation-facts:v2'), row('Four', 4, 'fence', 'world')] as never,
      { source_id: 'default' });
    const [one, two, three, four] = res.ids.map(Number);
    const name = (id: unknown) => ({ [one!]: 'one', [two!]: 'two', [three!]: 'three', [four!]: 'four' } as Record<number, string>)[Number(id)] ?? `?${String(id)}`;
    const cells = async () => (await engine.listPageFenceFactCells('default', SLUG)).sort((a, b) => a.row_num - b.row_num);
    const before = await cells();
    const positioned = [await engine.hasPositionedPageFacts('default', SLUG), await engine.hasPositionedPageFacts('default', 'people/nobody')];
    const occupied = (await engine.listOccupiedFenceRowNums('default', SLUG)).sort((a, b) => a - b);
    const at = [await engine.readLiveFenceFactAt('default', SLUG, 2), await engine.readLiveFenceFactAt('default', SLUG, 9)].map(r => r && { id: name(r.id), trust_tier: r.trust_tier });
    const above = await engine.listFactsAboveWriter('default', SLUG);
    const copies = await engine.listTrustedPrivateCopies('default', SLUG, [{ row_num: 7, fact: 'One', entity: SLUG }]);
    await engine.detachFenceFactRows([two!]);
    const detached = await cells();
    await engine.moveGuardedFenceRows([{ id: two!, row_num: 8, visibility: 'world' }]);
    const moved = await cells();
    await engine.refreshFenceFactFields('default', SLUG, JSON.stringify([{ row_num: 1, kind: 'preference', notability: 'high', context: 'refreshed', valid_from: null,
      valid_until: null, expired_at: null, source: 'fence', confidence: 0.5, claim_metric: null, claim_value: null, claim_unit: null, claim_period: null, attributed_to: null }]));
    const refreshed = (await engine.readFactPreimages('default', [one!])).map(f => ({ kind: (f as unknown as { kind: string }).kind, row_num: f.row_num }));
    // The incoming fence states row 1 as it is and claims row 3, so rows 3 (claimed), 4 and 8 expire; row 1 stays.
    await engine.expireFenceFacts('default', SLUG, JSON.stringify([{ row_num: 1, fact: 'One', visibility: 'private' }, { row_num: 3, fact: 'Other', visibility: 'private' }]),
      [one!, two!, three!, four!]);
    const expired = (await engine.readFactPreimages('default', [one!, two!, three!, four!])).map(f => ({ id: name(f.id), row_num: f.row_num, expired: f.expired_at !== null }));
    const body = await engine.readPageInlineBody(Number(created.id));
    return { before, positioned, occupied, at, above, copies, detached, moved, refreshed, expired,
      body: body && { compiled_truth: body.compiled_truth, timeline: body.timeline, body_storage: body.body_storage }, none: await engine.readPageInlineBody(999_999) };
  });

  parityTest('the fence projection take, hold and alias members answer and write the same rows on every arm', {
    methods: ['addTakesBatch', 'listQuotedTakeRows', 'listPageTakeRowNums', 'writeFenceTakeResolutions', 'clearChangedTakeResolutions', 'hasFenceAbsentHold',
      'readLiveSlugAliases', 'updateSlug'],
  }, async (engine) => {
    const created = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: 'A synthetic person.', timeline: '' }, { sourceId: 'default' });
    const pageId = Number(created.id);
    await engine.addTakesBatch([1, 2, 3].map(n => ({ page_id: pageId, row_num: n, claim: `Claim ${n}`, kind: 'bet', holder: 'world', weight: 0.5, active: true, superseded_by: null })) as never);
    const quoted = await engine.listQuotedTakeRows(pageId, [1, 3, 9]);
    const rowNums = (await engine.listPageTakeRowNums(pageId)).sort((a, b) => a - b);
    const resolutions = (rows: Array<Record<string, unknown>>) => JSON.stringify(rows.map(r => ({ resolved_at: null, resolved_quality: null, resolved_outcome: null,
      resolved_source: null, resolved_value: null, resolved_unit: null, resolved_by: null, ...r })));
    await engine.writeFenceTakeResolutions(pageId, resolutions([{ row_num: 1, resolved_at: '2026-03-01', resolved_quality: 'correct', resolved_outcome: true },
      { row_num: 2, resolved_at: '2026-03-02T10:00:00.000Z', resolved_quality: 'partial', resolved_value: 0.25, resolved_unit: 'pct' }]));
    const state = async () => (await engine.listTakes({ page_id: pageId } as never)).map(t => {
      const r = t as unknown as Record<string, unknown>;
      return { row_num: r.row_num, claim: r.claim, resolved: r.resolved_at != null, quality: r.resolved_quality ?? null, outcome: r.resolved_outcome ?? null };
    }).sort((a, b) => Number(a.row_num) - Number(b.row_num));
    const resolved = await state();
    const refused = await engine.writeFenceTakeResolutions(pageId, resolutions([{ row_num: 3, resolved_quality: 'correct', resolved_outcome: false }]))
      .then(() => 'written', (e: Error) => /takes_resolution_consistency/.test(e.message) ? 'takes_resolution_consistency' : `other: ${e.message}`);
    // Row 1 keeps its claim (kept), row 2's claim changed (cleared).
    await engine.clearChangedTakeResolutions(pageId, JSON.stringify([{ row_num: 1, claim: 'Claim 1' }, { row_num: 2, claim: 'Claim 2, edited' }]));
    const cleared = await state();
    const hold = [await engine.hasFenceAbsentHold('default', TAKE_FENCE_KIND, fenceOwnerKey(SLUG)), await engine.hasFenceAbsentHold('default', TAKE_FENCE_KIND, fenceOwnerKey('people/nobody'))];
    await engine.putPage('notes/old-name', { type: 'note', title: 'Old', compiled_truth: 'Renamed note.', timeline: '' }, { sourceId: 'default' });
    await engine.updateSlug('notes/old-name', 'notes/new-name', { sourceId: 'default' });
    const aliases = await engine.readLiveSlugAliases('default', ['notes/old-name', 'notes/new-name', 'notes/none']);
    return { quoted, rowNums, resolved, refused, cleared, hold, aliases };
  });

  parityTest('a tier-only row change reads, sets and finds the page of a fact, a take and a page the same way on every arm', {
    methods: ['insertFacts', 'addTakesBatch', 'readRowTrustTier', 'setRowTrustTier', 'readTierProjectionPage'],
  }, async (engine) => {
    const created = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: 'A synthetic person.', timeline: '' }, { sourceId: 'default' });
    const pageId = Number(created.id);
    const [factId] = (await engine.insertFacts([{ fact: 'One', kind: 'fact', entity_slug: SLUG, visibility: 'private', source: 'fence', context: null, row_num: 1,
      source_markdown_slug: SLUG }] as never, { source_id: 'default' })).ids.map(Number);
    await engine.addTakesBatch([{ page_id: pageId, row_num: 1, claim: 'Claim 1', kind: 'bet', holder: 'world', weight: 0.5, active: true, superseded_by: null }] as never);
    const takeId = Number((await engine.listTakes({ page_id: pageId } as never))[0]!.id);
    const targets = [['facts', factId!], ['takes', takeId], ['pages', pageId]] as const;
    const decision = JSON.stringify({ tier: 'external_untrusted', note: 'lowered by test' });
    const out: Record<string, unknown> = {};
    for (const [table, id] of targets) {
      const before = await engine.readRowTrustTier(table, id);
      const set = (await engine.setRowTrustTier(table, id, 'external_untrusted', decision)).length;
      const after = await engine.readRowTrustTier(table, id);
      const projection = await engine.readTierProjectionPage(table, id);
      out[table] = { before, set, after, projection, missing: [await engine.readRowTrustTier(table, 999_999), (await engine.setRowTrustTier(table, 999_999, 'external_untrusted', decision)).length,
        await engine.readTierProjectionPage(table, 999_999)] };
    }
    return out;
  });
});
