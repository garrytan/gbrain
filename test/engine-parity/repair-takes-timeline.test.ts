/**
 * BrainEngine parity: the take and timeline repair kinds of batch 5 of the repair-on-Rust plan.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview lists at least one item, the preview is equal on PGLite, Postgres
 *    (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). take-supersession: a page whose fence is already right
 *    but whose stored pointers were cleared is reprojected the same way on every arm; a broken chain is relinked through
 *    put_page the same way on every arm (the page write's fence projection runs on typed members). timeline, timeline-comments, timeline-order and connector-fences list the same
 *    pages on every arm, and their apply rewrites the page on the SQL arms while the Rust engine refuses the page write
 *    by name ("repair <kind> page write"). conversation-labels lists the same label-line facts and retires them the same
 *    way on every arm (the retirement's fact writes are typed: engine-sql/fact-text-repair.ts). agent-session-facts
 *    previews on the SQL arms; on the Rust engine it refuses at listAgentSessionTakeCandidates, a facts member lane 4
 *    has not served yet.
 *  - Regression: these previews read pages, versions, timeline rows, take pointers, receipts and fact evidence through
 *    executeRaw, so a Rust brain failed on a generic executeRaw refusal that named no step.
 *  - Why existing coverage misses it: the per-kind tests (test/repair-take-supersession.test.ts,
 *    test/repair-conversation-labels.test.ts and the timeline repair tests) seed with raw SQL on PGLite and Postgres only.
 *  - Seam: pages, takes and facts are seeded through the typed putPage, addTakesBatch and insertFacts. Generated values
 *    (hashes, revisions) are compared by shape.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { renderTakesFence, type ParsedTake } from '../../src/core/takes-fence.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { EPOCH_SEGMENT_MARKER, LABEL_LINE_SQL } from '../../src/core/repair/conversation-labels.ts';
import { NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE, stampExtractorVersion } from '../../src/core/facts/audit-sources.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

/** A result with every SHA-256 digest (a preview hash binds the brain id, drawn at random per brain) and every UUID (a page revision) reduced to a marker. */
function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  const text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } });
  return JSON.parse(text.replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>'));
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-b5-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

type RunOpts = Record<string, unknown>;
const runKind = async (engine: BrainEngine, kind: RepairKind, apply: boolean, opts: RunOpts = {}, source?: string) =>
  (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine, source), { explicit: true, ...opts });

/** The refusal text of an error: its message and detail, where the capability and the step it names are. */
const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

/** A preview that must list something, then the apply of what it printed; on the Rust engine a refusal must name `stop`. */
async function previewThenApply(engine: BrainEngine, backend: string, kind: RepairKind, stop: string, opts: RunOpts = {}) {
  return withHome(async () => {
    const previewed = await runKind(engine, kind, false, opts);
    expect(previewed.affected).toBeGreaterThan(0);
    try {
      const applied = await runKind(engine, kind, true, { ...opts, expect: previewed.preview_hash });
      return { preview: shape(previewed), applied: shape(applied) };
    } catch (err) {
      if (backend === 'rust') expect(refusalText(err)).toContain(stop);
      throw err;
    }
  });
}

// ---- take-supersession ----

const take = (rowNum: number, claim: string, active: boolean, source?: string): ParsedTake =>
  ({ rowNum, claim, kind: 'bet', holder: 'world', weight: 0.6, active, ...(source !== undefined ? { source } : {}) });

/** 1 -> 2 -> 3 written by the old supersedeRow: struck rows cite nothing, each new row cites itself. */
const CHAIN = [
  take(1, 'Widget co ships in Q3', false, 'call notes'),
  take(2, 'Widget co ships in Q4', false, 'superseded by #2'),
  take(3, 'Widget co ships in Q1', true, 'superseded by #3'),
  take(4, 'Acme example hires a CFO', true, 'board memo'),
];
/** The same chain with its pointers already on the old rows. */
const LINKED = [
  take(1, 'Widget co ships in Q3', false, 'call notes; superseded by #2'),
  take(2, 'Widget co ships in Q4', false, 'superseded by #3'),
  take(3, 'Widget co ships in Q1', true),
  take(4, 'Acme example hires a CFO', true, 'board memo'),
];

/** A page whose body holds `takes` as its fence, and its takes rows (stored `superseded_by` cleared) through addTakesBatch. */
async function seedTakesPage(engine: BrainEngine, slug: string, takes: ParsedTake[]): Promise<number> {
  const body = `# Chain\n\nProse.\n\n## Takes\n\n${renderTakesFence(takes)}\n`;
  const saved = await engine.putPage(slug, { type: 'note', title: 'Chain', compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.addTakesBatch(takes.map(t => ({ page_id: saved.id, row_num: t.rowNum, claim: t.claim, kind: t.kind, holder: t.holder,
    weight: t.weight, source: t.source, active: t.active, superseded_by: null })));
  return saved.id;
}

// ---- timeline family ----

const putNote = (engine: BrainEngine, slug: string, compiled_truth: string, timeline: string, sourceId = 'default') =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth, timeline, frontmatter: {} }, { sourceId });

const event = (summary: string, date = '2024-03-01') => ({ date, source: 'manual', summary, detail: '' });

// ---- conversation-labels and agent-session-facts ----

const SEGMENT = 'cli:extract-conversation-facts';
const epoch = (slug: string) => `from ${slug} ${EPOCH_SEGMENT_MARKER}T00:00:00Z..1970-01-01T00:00:00Z`;

/** Facts of page `slug` with the provenance the extractor writes, through the typed insertFacts. */
async function insertPageFacts(engine: BrainEngine, slug: string, rows: Array<{ fact: string; context?: string | null; source?: string; session?: string }>) {
  return (await engine.insertFacts(rows.map((row, i) => ({ fact: row.fact, kind: 'fact' as const, entity_slug: null, visibility: 'private' as const,
    notability: 'medium' as const, confidence: 1, source: row.source ?? SEGMENT, source_session: row.session ?? `${SEGMENT}:${slug}`, context: row.context ?? null,
    row_num: i, source_markdown_slug: slug })), { source_id: 'default' })).ids;
}

/** Pre-fix label extractions: a prose page and a dated transcript with epoch-segment rows, and a page the fixed extractor scanned. */
async function seedLabelPages(engine: BrainEngine) {
  await engine.putPage('meetings/prose-notes', { type: 'meeting', title: 'Planning notes', compiled_truth:
    '**Date:** 2026-09-28\n**Attendees:** Alice Example, Bob Example\n\n## Notes\nWe went through hiring and the launch dates.' });
  await engine.putPage('meetings/dated-sync', { type: 'meeting', title: 'Dated sync', frontmatter: { date: '2026-09-28' }, compiled_truth:
    '**Date:** 2026-09-28\n**Attendees:** Alice Example, Bob Example\n\n**Alice Example:** Can you send the quarterly plan?\n**Bob Example:** Yes, on Thursday.' });
  await engine.putPage('meetings/fixed-notes', { type: 'meeting', title: 'Fixed notes', compiled_truth: '**Date:** 2026-09-28\n**Attendees:** Alice Example\n\nNotes only.' });
  await insertPageFacts(engine, 'meetings/prose-notes', [{ fact: 'Date said the review is on Monday', context: epoch('meetings/prose-notes') },
    { fact: 'The launch moved to Q4', context: 'from the planning notes' }]);
  await insertPageFacts(engine, 'meetings/dated-sync', [{ fact: 'Date said the plan is due Thursday', context: epoch('meetings/dated-sync') },
    { fact: 'EXTRACTION_COMPLETE', source: TERMINAL_AUDIT_SOURCE, session: `${TERMINAL_AUDIT_SOURCE}:meetings/dated-sync:page-old` }]);
  await insertPageFacts(engine, 'meetings/fixed-notes', [{ fact: 'Date said notes only', context: epoch('meetings/fixed-notes') },
    { fact: 'EXTRACTION_NOT_APPLICABLE', source: NON_EXTRACTABLE_AUDIT_SOURCE, session: `${NON_EXTRACTABLE_AUDIT_SOURCE}:meetings/fixed-notes:v1`,
      context: stampExtractorVersion('scanned, not extractable: prose') }]);
}

describe('engine parity: repair take and timeline kinds (batch 5)', () => {
  parityTest('take-supersession reprojects cleared pointers the same way on every arm', {
    methods: ['putPage', 'addTakesBatch', 'listTakeSupersessionCandidates', 'listTakePointers', 'listTakeSupersedeReceipts', 'setTakeSupersededBy'],
    timeout: 60_000,
  }, async (engine, backend) => {
    const pageId = await seedTakesPage(engine, 'notes/linked', LINKED);
    expect(await engine.listTakeSupersedeReceipts('default', pageId, 'notes/linked')).toEqual([]);
    const out = await previewThenApply(engine, backend, 'take-supersession', 'repair take-supersession');
    const pointers = (await engine.listTakePointers(pageId)).sort((a, b) => a.row_num - b.row_num);
    expect(pointers).toEqual([{ row_num: 1, superseded_by: 2 }, { row_num: 2, superseded_by: 3 }, { row_num: 3, superseded_by: null }, { row_num: 4, superseded_by: null }]);
    const again = await withHome(() => runKind(engine, 'take-supersession', false));
    return { out, pointers, again: again.affected };
  });

  parityTest('take-supersession relinks a broken chain the same way on every arm', {
    methods: ['putPage', 'addTakesBatch', 'listTakeSupersessionCandidates', 'listTakePointers', 'listTakeSupersedeReceipts'], timeout: 60_000,
  }, async (engine, backend) => {
    await seedTakesPage(engine, 'notes/chain', CHAIN);
    return previewThenApply(engine, backend, 'take-supersession', 'no stop: the relink is served on every arm');
  });

  parityTest('setTakeSupersededBy sets and clears one take\'s pointer and nothing else', {
    methods: ['putPage', 'addTakesBatch', 'setTakeSupersededBy', 'listTakePointers', 'listTakes'],
  }, async (engine) => {
    const pageId = await seedTakesPage(engine, 'notes/pointer', LINKED);
    const before = await engine.listTakes({ page_id: pageId } as never);
    await engine.setTakeSupersededBy(pageId, 1, 2);
    await engine.setTakeSupersededBy(pageId, 9, 2);
    const set = (await engine.listTakePointers(pageId)).sort((a, b) => a.row_num - b.row_num);
    await engine.setTakeSupersededBy(pageId, 1, null);
    const cleared = (await engine.listTakePointers(pageId)).sort((a, b) => a.row_num - b.row_num);
    const after = await engine.listTakes({ page_id: pageId } as never);
    const strip = (rows: unknown[]) => rows.map(r => { const { id, page_id, superseded_by, ...rest } = r as Record<string, unknown>; void id; void page_id; void superseded_by; return rest; });
    expect(strip(after)).toEqual(strip(before));
    return { set, cleared };
  });
  parityTest('timeline previews a database-only row and writes it into the page the same way on every arm', {
    methods: ['putPage', 'addTimelineEntry', 'listTimelineHistoryPages'], timeout: 60_000,
  }, async (engine, backend) => {
    await putNote(engine, 'notes/history', 'A synthetic page.', '');
    await engine.addTimelineEntry('notes/history', event('Database-only event'), { sourceId: 'default' });
    return previewThenApply(engine, backend, 'timeline', 'repair timeline page write');
  });

  parityTest('timeline-comments cleans comment-markup rows the same way on every arm', {
    methods: ['putPage', 'addTimelineEntry', 'listTimelineMarkupRows', 'listMaterializedMarkerPages', 'rewriteTimelineRow', 'removeTimelineRows',
      'listStoredTimelineRowsOrdered'], timeout: 60_000,
  }, async (engine, backend) => {
    const page = await putNote(engine, 'notes/markup', 'A synthetic page.', '');
    await engine.addTimelineEntry('notes/markup', event('<!-- AUTO:slack END -->'), { sourceId: 'default' });
    await engine.addTimelineEntry('notes/markup', event('Kept event <!-- note -->', '2024-03-02'), { sourceId: 'default' });
    const out = await previewThenApply(engine, backend, 'timeline-comments', 'repair timeline-comments');
    const stored = (await engine.listStoredTimelineRowsOrdered(page.id)).map(r => ({ date: r.date, source: r.source, summary: r.summary, detail: r.detail }));
    expect(stored).toEqual([{ date: '2024-03-02', source: 'manual', summary: 'Kept event', detail: '' }]);
    const again = await withHome(() => runKind(engine, 'timeline-comments', false));
    return { out, stored, again: again.affected };
  });

  parityTest('timeline-comments drops a commented materialized bullet the same way on every arm', {
    methods: ['putPage', 'listTimelineMarkupRows', 'listMaterializedMarkerPages'], timeout: 60_000,
  }, async (engine, backend) => {
    await putNote(engine, 'notes/bullets', 'A synthetic page.',
      '## Timeline\n\n<!-- gbrain:materialized v1 0123456789ab -->\n- **2024-03-01** | slack — <!-- AUTO:slack END -->\n- **2024-03-02** | manual — Kept');
    return previewThenApply(engine, backend, 'timeline-comments', 'repair timeline-comments page write');
  });

  parityTest('timeline-order previews and reorders an out-of-order timeline the same way on every arm', {
    methods: ['putPage', 'listDateBulletPages'], timeout: 60_000,
  }, async (engine, backend) => {
    await putNote(engine, 'notes/order', 'A synthetic page.',
      '## Timeline\n\n- **2021-01-01** | import — Second\n- **2022-01-01** | import — Third\n- **2020-01-01** | import — First');
    return previewThenApply(engine, backend, 'timeline-order', 'repair timeline-order page write');
  });

  parityTest('connector-fences previews and moves a fence below the timeline sentinel the same way on every arm', {
    methods: ['putPage', 'insertSource', 'listConnectorFencePages'], timeout: 60_000,
  }, async (engine, backend) => {
    await engine.insertSource({ id: 'gc-example', name: 'gc-example', local_path: null, config: { kind: 'google' } });
    await putNote(engine, 'notes/fenced', 'A synthetic page.', `- **2024-03-01** | manual — An event\n\n${FACTS_FENCE_BEGIN}\n${FACTS_FENCE_END}`, 'gc-example');
    return previewThenApply(engine, backend, 'connector-fences', 'repair connector-fences page write');
  });

  parityTest('conversation-labels previews label facts and retires them the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'listLabelFactCandidates', 'listSegmentedLabelPages', 'hasActiveAuditMarker', 'listActiveFactIdsOfPage',
      'listUnexpiredFactIds', 'lockFactRows', 'expireFactWithNote', 'expirePageFactsBySource', 'readMaxFactRowNum'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await seedLabelPages(engine);
    const out = await previewThenApply(engine, backend, 'conversation-labels', 'repair conversation-labels', { includeAmbiguous: true });
    const active = {} as Record<string, number>;
    for (const slug of ['meetings/prose-notes', 'meetings/dated-sync', 'meetings/fixed-notes']) active[slug] = (await engine.listActiveFactIdsOfPage('default', slug)).length;
    return { out, active };
  });

  parityTest('agent-session-facts previews captured facts the same way on the SQL arms, and the Rust engine refuses the take read by name', {
    methods: ['putPage', 'insertFacts', 'listSessionFactsForClassification', 'listAgentSessionTakeCandidates'], requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example' }, { sourceId: 'default' });
    await engine.insertFacts([{ fact: 'Alice Example prefers terse updates', kind: 'fact', entity_slug: 'people/alice-example', visibility: 'private',
      source: 'hook:writeback', source_session: 'session-a1', row_num: 0, source_markdown_slug: 'people/alice-example' }], { source_id: 'default' });
    return withHome(async () => {
      try {
        return shape(await runKind(engine, 'agent-session-facts', false));
      } catch (err) {
        if (backend === 'rust') expect(refusalText(err)).toContain('listAgentSessionTakeCandidates');
        throw err;
      }
    });
  });

  parityTest('the timeline and label repair reads return the same rows on every arm', {
    methods: ['putPage', 'addTimelineEntry', 'insertSource', 'insertFacts', 'listTimelineHistoryPages', 'listTimelineVersionWitnesses',
      'readTimelineVersionBody', 'listTimelineMarkupRows', 'listMaterializedMarkerPages', 'rewriteTimelineRow', 'listDateBulletPages',
      'listConnectorFencePages', 'listStoredTimelineRowsOrdered', 'listLabelFactCandidates', 'listSegmentedLabelPages', 'hasActiveAuditMarker'],
    timeout: 60_000,
  }, async (engine) => {
    const noIds = (rows: object[]) => rows.map(r => { const { id, page_id, ...rest } = r as Record<string, unknown>; void id; void page_id; return rest; });
    const history = await putNote(engine, 'notes/history', 'A synthetic page.', '');
    await engine.addTimelineEntry('notes/history', event('Database-only event'), { sourceId: 'default' });
    const markup = await putNote(engine, 'notes/markup', 'A synthetic page.', '');
    await engine.addTimelineEntry('notes/markup', event('Kept event <!-- note -->'), { sourceId: 'default' });
    await putNote(engine, 'notes/bullets', 'A synthetic page.', '## Timeline\n\n<!-- gbrain:materialized v1 0123456789ab -->\n- **2024-03-01** | manual — Kept');
    await putNote(engine, 'notes/order', 'A synthetic page.', '## Timeline\n\n- **2021-01-01** | import — Second\n- **2020-01-01** | import — First');
    await engine.insertSource({ id: 'gc-example', name: 'gc-example', local_path: null, config: { kind: 'google' } });
    await putNote(engine, 'notes/fenced', 'A synthetic page.', `- **2024-03-01** | manual — An event\n\n${FACTS_FENCE_BEGIN}\n${FACTS_FENCE_END}`, 'gc-example');
    await putNote(engine, 'notes/versioned', 'First body.', '- **2024-03-01** | manual — One');
    await putNote(engine, 'notes/versioned', 'Second body.', '- **2024-03-02** | manual — Two');
    const timeline = {
      history: noIds(await engine.listTimelineHistoryPages(['default'], { afterId: 0, limit: 10 })),
      byId: noIds(await engine.listTimelineHistoryPages(['default'], { ids: [history.id] })),
      markup: noIds(await engine.listTimelineMarkupRows({ sourceIds: ['default'], afterId: 0 })),
      markupOfPage: noIds(await engine.listTimelineMarkupRows({ pageId: markup.id })),
      markers: noIds(await engine.listMaterializedMarkerPages(['default'], 0)),
      bullets: noIds(await engine.listDateBulletPages(['default'], 0, ['notes/order'], 10)),
      fences: noIds(await engine.listConnectorFencePages(['default', 'gc-example'], ['google'], false)),
      segmentedFences: noIds(await engine.listConnectorFencePages(['default', 'gc-example'], ['google'], true)),
    };
    const witnesses = await engine.listTimelineVersionWitnesses('default', 'notes/versioned');
    const bodies = [];
    for (const w of witnesses) bodies.push(await engine.readTimelineVersionBody(w.page_id, w.id));
    const missing = await engine.readTimelineVersionBody(markup.id, 999_999);
    const [row] = await engine.listTimelineMarkupRows({ pageId: markup.id });
    await engine.rewriteTimelineRow(markup.id, { id: row!.id, source: row!.source, summary: 'Kept event', detail: row!.detail });
    const rewritten = (await engine.listStoredTimelineRowsOrdered(markup.id)).map(r => ({ date: r.date, source: r.source, summary: r.summary, detail: r.detail }));

    await seedLabelPages(engine);
    const labelArgs = { segmentSource: SEGMENT, labelLine: LABEL_LINE_SQL, terminalSource: TERMINAL_AUDIT_SOURCE, nonExtractableSource: NON_EXTRACTABLE_AUDIT_SOURCE };
    const { labelLine, ...censusArgs } = labelArgs;
    void labelLine;
    const labels = {
      candidates: noIds(await engine.listLabelFactCandidates(['default'], null, labelArgs)),
      onePage: noIds(await engine.listLabelFactCandidates(['default'], 'meetings/prose-notes', labelArgs)),
      otherSource: await engine.listLabelFactCandidates(['gc-example'], null, labelArgs),
      segmented: await engine.listSegmentedLabelPages(['default'], censusArgs),
      terminal: await engine.hasActiveAuditMarker('default', 'meetings/dated-sync', [TERMINAL_AUDIT_SOURCE]),
      nonExtractable: await engine.hasActiveAuditMarker('default', 'meetings/fixed-notes', [TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]),
      none: await engine.hasActiveAuditMarker('default', 'meetings/prose-notes', [TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]),
    };
    expect(timeline.history.length).toBeGreaterThan(0);
    expect(labels.candidates.length).toBeGreaterThan(0);
    return { timeline, witnesses: noIds(witnesses), bodies, missing, rewritten, labels };
  });
});
