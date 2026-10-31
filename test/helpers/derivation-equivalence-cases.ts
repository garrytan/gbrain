/**
 * Shared cases for the incremental-derivation equivalence tests (Wave B PR 4 lane 4a, spec 8.1/8.2): a segmented page
 * goes through a seeded sequence of appends, mid-page edits, a title change, a gazetteer change and fence row edits,
 * and after every step each incremental pipeline (links, mentions, timeline, fences) must give what its full pass gives
 * over the same generation, with page_segment_derivations rows for exactly the live occurrences and an append deriving
 * only the runs it changed (plus, for links, the run whose window reaches into them).
 *
 * test/large-pages/derivation-equivalence.test.ts runs them on PGLite; test/e2e/derivation-equivalence-postgres.test.ts
 * on PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { extractPageLinks, makeResolver, type ExtractPageLinksOptions } from '../../src/core/link-extraction.ts';
import { loadActivePackForLocalEngine } from '../../src/core/schema-pack/best-effort.ts';
import { extractSegmentedPageLinks, openSegmentedLinkSession, segmentedRoleText } from '../../src/core/page-body/segment-links.ts';
import { segmentDeriveWork, SEGMENT_PIPELINE_VERSIONS, type UnpaidDerivationKind } from '../../src/core/page-body/segment-derive.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { maintenanceTransaction } from '../../src/core/persistence/attribution.ts';
import { rewriteLiveSegmentedFences } from '../../src/core/page-body/segment-rewrite.ts';
import { pageMentions } from '../../src/core/mentions/pass.ts';
import { readMentionPolicy } from '../../src/core/mentions/policy.ts';
import { buildGazetteer, findMentionedEntities, type Mention } from '../../src/core/by-mention.ts';
import { bodyBlocks } from '../../src/core/page-body/segment-blocks.ts';
import { incrementalFactsFenceView, segmentedFactsFenceView } from '../../src/core/page-body/segment-facts.ts';
import { incrementalPriorView, segmentedCanonicalCollector, segmentedPriorView, storedCanonicalTimeline, type PriorView } from '../../src/core/persistence/canonical-projections.ts';
import { eachStoredTimelineRow, TimelineKeySet } from '../../src/core/timeline-extract.ts';
import { timelineKey } from '../../src/core/timeline-marker.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { conversationBody } from './conversation-page.ts';
import { openAppendBrain, type AppendBrain } from './append-brain.ts';

export const EQUIVALENCE_SLUG = 'notes/derivation-equivalence';
const SOURCE = 'default';

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Prose without day headings, so a section opened above it stays open across segments. */
const prose = (bytes: number, seed: number) => conversationBody(bytes, { seed }).replace(/^## Day \d+$/gm, 'Next day.');

const FACTS = '<!--- gbrain:facts:begin -->\n'
  + '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|---|---|---|---|---|---|---|---|---|\n'
  + '| 1 | ships quarterly | fact | 0.9 | world | low | 2026-01-01 | | user | |\n'
  + '| 2 | prefers email | preference | 0.8 | world | low | 2026-02-01 | | user | |\n'
  + '<!--- gbrain:facts:end -->\n';

const TAKES = `${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n`
  + `| 1 | Acme ships quarterly | fact | world | 1.0 | 2026-01 | notes |\n| 2 | Pricing will hold | bet | brain | 0.6 | 2026-02 | notes |\n${TAKES_FENCE_END}\n`;

/**
 * About 2.6 MB: an intro link, a ## Related section longer than a segment (its machine-section heading suppresses the
 * role prior segments later), sections with links, bare slug paths, entity names and unique edit markers, the facts and
 * takes fences, a page-role phrase near the end, then a timeline of dated bullets.
 */
export function equivalencePage(): string {
  const parts = ['---\ntype: person\ntitle: Equivalence Example\n---\n\nIntro: met [[companies/c1-example]] early.\n\n## Related\n\n', prose(600_000, 11),
    '\n\n- [[companies/c2-example]]\n\n'];
  for (let i = 0; i < 6; i++) {
    parts.push(`## Section ${i}\n\n${prose(240_000, 20 + i)}\n\n`);
    parts.push(`Marker ${i}: met [[people/alice-example]] and [[people/p${i}-example]] about launch ${i}; see people/bob-example for notes. `
      + `Alice Example reviewed it with Bob Example.\n\n`);
    if (i === 2) parts.push(`## Facts\n\n${FACTS}\n`);
    if (i === 4) parts.push(`${TAKES}\n`);
  }
  parts.push('Equivalence Example is a senior advisor to founders.\n\n<!-- timeline -->\n\n');
  parts.push(Array.from({ length: 30 }, (_, i) => `- **2026-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, '0')}** | Met [[people/alice-example]] about item ${i}\n`
    + (i % 5 === 0 ? `  detail line for item ${i}\n` : '')).join(''));
  parts.push(`\n${prose(200_000, 9)}\n`);
  return parts.join('');
}

export interface EquivalencePage { id: number; slug: string; source_id: string; type: 'person'; frontmatter: Record<string, unknown>; title: string }

export async function storedPage(engine: BrainEngine, slug = EQUIVALENCE_SLUG): Promise<EquivalencePage> {
  const [row] = await engine.executeRaw<{ id: number; type: string; title: string; frontmatter: Record<string, unknown> | string; body_storage: string }>(
    'SELECT id, type, title, frontmatter, body_storage FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
  expect(row!.body_storage).toBe('segmented');
  const frontmatter = typeof row!.frontmatter === 'string' ? JSON.parse(row!.frontmatter) : row!.frontmatter;
  return { id: Number(row!.id), slug, source_id: SOURCE, type: row!.type as 'person', frontmatter, title: row!.title };
}

/** The write path's link options (prepareAutomaticLinks) and a target typer from the source's page types. */
async function linkOptions(engine: BrainEngine) {
  const pack = (await loadActivePackForLocalEngine(engine, { sourceId: SOURCE }))?.manifest ?? null;
  const types = new Map((await engine.executeRaw<{ slug: string; type: string }>('SELECT slug, type FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [SOURCE]))
    .map(row => [row.slug, row.type]));
  const opts: ExtractPageLinksOptions = { pack, globalBasename: false, lineGrammar: { enabled: true, allowUndeclaredTypes: false } };
  return { opts, targetType: (slug: string) => types.get(slug) };
}

export async function incrementalLinks(engine: BrainEngine, page: EquivalencePage) {
  const resolver = makeResolver(engine, { mode: 'live', sourceId: SOURCE });
  const { opts, targetType } = await linkOptions(engine);
  const session = await openSegmentedLinkSession(engine, page, resolver, opts);
  expect(session).not.toBeNull();
  await session!.targets(opts);
  return session!.finish({ ...opts, temporal: true, targetType } as never);
}

/** extractPageLinks over the joined body (`${compiled_truth}\n${timeline}`), as an inline page of the same text is extracted. */
export async function inlineLinks(engine: BrainEngine, page: EquivalencePage, body: { truth: string; timeline: string }) {
  const resolver = makeResolver(engine, { mode: 'live', sourceId: SOURCE });
  const { opts, targetType } = await linkOptions(engine);
  return extractPageLinks(page.slug, `${body.truth}\n${body.timeline}`, page.frontmatter, page.type, resolver, { ...opts, targetType });
}

export async function fullLinks(engine: BrainEngine, page: EquivalencePage) {
  const resolver = makeResolver(engine, { mode: 'live', sourceId: SOURCE });
  const { opts, targetType } = await linkOptions(engine);
  return extractSegmentedPageLinks(engine, page, resolver, { ...opts, temporal: true, targetType, roleText: await segmentedRoleText(engine, page) });
}

const MENTION_KINDS = { fromSlug: EQUIVALENCE_SLUG, fromSourceId: SOURCE, allowCrossSource: false };

async function gazetteerOf(engine: BrainEngine) {
  return buildGazetteer(engine, { policy: await readMentionPolicy(engine), strict: true });
}

export async function incrementalMentions(engine: BrainEngine, page: EquivalencePage): Promise<Mention[]> {
  return pageMentions(engine, { id: page.id, slug: page.slug, source_id: SOURCE, title: page.title, body_storage: 'segmented' }, await gazetteerOf(engine), MENTION_KINDS);
}

/** The PR 2 full pass of pageMentions: the title, then every block with the '\n\n' separator. */
export async function fullMentions(engine: BrainEngine, page: EquivalencePage): Promise<Mention[]> {
  const gazetteer = await gazetteerOf(engine);
  const found = new Map<string, Mention>();
  const add = (mentions: Mention[], at: number) => {
    for (const m of mentions) if (!found.has(`${m.source_id}\0${m.slug}`)) found.set(`${m.source_id}\0${m.slug}`, { ...m, offset: m.offset + at });
  };
  add(findMentionedEntities(page.title, gazetteer, MENTION_KINDS), 0);
  for await (const block of bodyBlocks(engine, page, { separator: '\n\n' })) add(findMentionedEntities(block.text, gazetteer, MENTION_KINDS), page.title.length + 2 + block.at);
  return [...found.values()];
}

export async function incrementalTimeline(engine: BrainEngine, page: EquivalencePage) {
  const snapshot = (await engine.readPageSnapshot(page.slug, { sourceId: SOURCE }))!;
  return [...(await storedCanonicalTimeline(engine, snapshot.page, page.slug))];
}

/** The PR 2 full pass of the canonical timeline: every block through segmentedCanonicalCollector, less the stored rows. */
export async function fullTimeline(engine: BrainEngine, page: EquivalencePage) {
  const recorded = new TimelineKeySet();
  await eachStoredTimelineRow(engine, page.id, row => recorded.add(timelineKey({ date: row.date_text, source: row.source, summary: row.summary })));
  const collector = segmentedCanonicalCollector(page.slug, recorded);
  for await (const block of bodyBlocks(engine, page)) collector.add(block.text);
  return [...collector.result()];
}

/** The keys a prior view is asked about: the page's stored timeline rows, two entries an append writes and one no page holds. */
async function priorKeys(engine: BrainEngine, page: EquivalencePage): Promise<string[]> {
  const keys: string[] = [];
  await eachStoredTimelineRow(engine, page.id, row => { keys.push(timelineKey({ date: row.date_text, source: row.source, summary: row.summary })); });
  return [...keys, timelineKey({ date: '2026-10-01', source: 'markdown', summary: 'appended event 0' }),
    timelineKey({ date: '2026-10-03', source: 'markdown', summary: 'appended event 2' }), timelineKey({ date: '2030-01-01', source: 'markdown', summary: 'nowhere' })];
}

const viewShape = (view: PriorView, keys: readonly string[]) => ({
  rows: keys.map((key, i) => [view.rows.entry(i, key), view.rows.marked(i, key), view.rows.superseded(i, key)]),
  takeRows: [...view.takeRows].sort((a, b) => a - b), takesWarn: view.takesWarn });

export async function priorViews(engine: BrainEngine, page: EquivalencePage) {
  const keys = await priorKeys(engine, page);
  const incremental = await incrementalPriorView(engine, page, page.slug, keys);
  expect(incremental).not.toBeNull();
  return { incremental: viewShape(incremental!, keys), full: viewShape(await segmentedPriorView(engine, page, page.slug, keys), keys) };
}

/** Every incremental pipeline once (each stores its rows). */
export async function deriveAll(engine: BrainEngine, page: EquivalencePage): Promise<void> {
  await incrementalLinks(engine, page);
  await incrementalMentions(engine, page);
  await incrementalTimeline(engine, page);
  await priorViews(engine, page);
  await incrementalFactsFenceView(engine, page);
}

export const KINDS: readonly UnpaidDerivationKind[] = ['links', 'mentions', 'timeline', 'fences'];

/** The live occurrences of the page, and its derivation rows per kind. */
export async function derivationRowsMatch(engine: BrainEngine, page: EquivalencePage, kinds: readonly UnpaidDerivationKind[]): Promise<void> {
  const live = (await engine.executeRaw<{ occurrence_id: string }>(
    'SELECT occurrence_id::text AS occurrence_id FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND staging_id IS NULL ORDER BY occurrence_id', [page.id]))
    .map(row => Number(row.occurrence_id)).sort((a, b) => a - b);
  for (const kind of kinds) {
    const rows = await engine.readSegmentDerivations(page.id, { kind });
    expect({ kind, occurrences: rows.map(row => row.occurrenceId).sort((a, b) => a - b) }).toEqual({ kind, occurrences: live });
    expect(rows.every(row => row.version === SEGMENT_PIPELINE_VERSIONS[kind] && row.state === 'done')).toBe(true);
  }
}

export async function liveOccurrences(engine: BrainEngine, pageId: number): Promise<Set<number>> {
  return new Set((await engine.executeRaw<{ occurrence_id: string }>(
    'SELECT occurrence_id::text AS occurrence_id FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND staging_id IS NULL', [pageId]))
    .map(row => Number(row.occurrence_id)));
}

export function resetDeriveWork(): void {
  for (const work of Object.values(segmentDeriveWork)) Object.assign(work, { derived: 0, occurrences: 0, reused: 0, skipped: 0, reread: 0 });
}

const revision = async (brain: AppendBrain) => (await brain.engine.executeRaw<{ r: string }>(
  'SELECT knowledge_revision::text AS r FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, EQUIVALENCE_SLUG]))[0]!.r;

type Step = { name: string; run: (brain: AppendBrain, page: EquivalencePage) => Promise<void>; append?: boolean };

/** The seeded step sequence: at least 20 steps, appends most often, every other kind of change at least once. */
export function equivalenceSteps(seed = 7): Step[] {
  const next = rng(seed);
  const append = (n: number): Step => ({ name: `append ${n}`, append: true, run: async brain => {
    const text = `Appended ${n}: met [[people/p${n % 6}-example]] and Alice Example; see people/bob-example.\n\n- **2026-10-${String(1 + (n % 28)).padStart(2, '0')}** | appended event ${n}\n\n${prose(6_000 + Math.floor(next() * 20_000), 100 + n)}`;
    const res = await brain.call('append_page', { slug: EQUIVALENCE_SLUG, text, region: 'truth', request_id: randomUUID() });
    expect(res).toMatchObject({ isError: false });
  } });
  const edit = (n: number): Step => ({ name: `edit marker ${n % 6}`, run: async brain => {
    const body = (await brain.body(EQUIVALENCE_SLUG)).truth;
    const old = new RegExp(`Marker ${n % 6}(?: \\(edit \\d+\\))?: `).exec(body)![0];
    const res = await brain.call('edit_page', { slug: EQUIVALENCE_SLUG, expected_revision: await revision(brain), edits: [{ old_text: old, new_text: `Marker ${n % 6} (edit ${n}): see [[companies/c${n % 6}-example]] and ` }] });
    expect(res).toMatchObject({ isError: false });
  } });
  const steps: Step[] = [];
  for (let n = 0; n < 22; n++) {
    if (n === 5) steps.push({ name: 'title change', run: async (brain, page) => {
      await brain.engine.executeRaw('UPDATE pages SET title=$2 WHERE id=$1', [page.id, `Equivalence Example ${n}`]);
    } });
    if (n === 9) steps.push({ name: 'gazetteer change', run: async brain => {
      await brain.engine.putPage('people/carol-example', { type: 'person', title: 'Carol Example', compiled_truth: 'Carol Example fixture.', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
    } });
    // A fence row changes the way forget and purge change one: the segment holding the fence is rewritten (spec 6.4).
    if (n === 13) steps.push({ name: 'fence row edit', run: async (brain, page) => {
      const done = await maintenanceTransaction(brain.engine, tx => rewriteLiveSegmentedFences(tx, page.id, async fence => fence.replace('| 2 | prefers email |', '| 2 | prefers phone |')));
      expect(done).not.toBeNull();
    } });
    steps.push(next() < 0.7 ? append(n) : edit(n));
  }
  return steps;
}

/** Seeds the page and the entities its links and mentions name. */
export async function seedEquivalenceBrain(brain: AppendBrain): Promise<void> {
  const put = (slug: string, type: string, title: string) => brain.engine.putPage(slug, { type, title, compiled_truth: `${title} fixture.`, timeline: '', frontmatter: {} }, { sourceId: SOURCE });
  await put('people/alice-example', 'person', 'Alice Example');
  await put('people/bob-example', 'person', 'Bob Example');
  for (let i = 0; i < 6; i++) {
    await put(`people/p${i}-example`, 'person', `Person ${i}`);
    await put(`companies/c${i}-example`, 'company', `Company ${i}`);
  }
  await brain.seed(EQUIVALENCE_SLUG, equivalencePage());
}

export function registerDerivationEquivalenceCases(kind: 'pglite' | 'postgres'): void {
  describe(`incremental derivations equal a full recompute (${kind})`, () => {
    let brain: AppendBrain;
    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      await seedEquivalenceBrain(brain);
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('after every step of a seeded sequence, each pipeline equals its full pass, rows track live occurrences, and an append derives only its runs', async () => {
      const check = async (label: string) => {
        const current = await storedPage(brain.engine);
        const links = { incremental: await incrementalLinks(brain.engine, current), full: await fullLinks(brain.engine, current) };
        expect({ label, links: links.incremental.candidates }).toEqual({ label, links: links.full.candidates });
        const inline = await inlineLinks(brain.engine, current, await brain.body(EQUIVALENCE_SLUG));
        expect({ label, inline: links.incremental.candidates }).toEqual({ label, inline: inline.candidates });
        expect({ label, temporal: links.incremental.temporalBody }).toEqual({ label, temporal: links.full.temporalBody! });
        expect({ label, attendance: links.incremental.attendanceComplete }).toEqual({ label, attendance: links.full.attendanceComplete });
        expect({ label, mentions: await incrementalMentions(brain.engine, current) }).toEqual({ label, mentions: await fullMentions(brain.engine, current) });
        expect({ label, timeline: await incrementalTimeline(brain.engine, current) }).toEqual({ label, timeline: await fullTimeline(brain.engine, current) });
        const views = await priorViews(brain.engine, current);
        expect({ label, prior: views.incremental }).toEqual({ label, prior: views.full });
        expect({ label, fences: await incrementalFactsFenceView(brain.engine, current) }).toEqual({ label, fences: await segmentedFactsFenceView(brain.engine, current) });
        await derivationRowsMatch(brain.engine, current, KINDS);
      };
      const page = await storedPage(brain.engine);
      await check('seed');
      expect((await fullLinks(brain.engine, page)).candidates.length).toBeGreaterThan(10);
      expect((await fullMentions(brain.engine, page)).length).toBeGreaterThanOrEqual(2);
      expect((await segmentedFactsFenceView(brain.engine, page)).body.facts.length).toBe(2);
      expect(views0(await priorViews(brain.engine, page))).toBe(true);
      resetDeriveWork();
      await deriveAll(brain.engine, page);
      for (const kind of KINDS) expect({ kind, derived: segmentDeriveWork[kind].derived }).toEqual({ kind, derived: 0 });
      const steps = equivalenceSteps();
      expect(steps.length).toBeGreaterThanOrEqual(20);
      const work: string[] = [];
      for (const step of steps) {
        const before = await liveOccurrences(brain.engine, page.id);
        resetDeriveWork();
        await step.run(brain, page);
        const after = await liveOccurrences(brain.engine, page.id);
        await deriveAll(brain.engine, await storedPage(brain.engine));
        if (step.append) {
          // Everything the append and the derivations after it derived: the new or rewritten tail occurrences, and for
          // links also the timeline's first run, whose window reads the truth's last blocks.
          const fresh = [...after].filter(id => !before.has(id)).length;
          work.push(`${step.name}: ${KINDS.map(kind => `${kind} ${segmentDeriveWork[kind].occurrences}/${after.size}`).join(', ')} (fresh ${fresh})`);
          for (const kind of KINDS) {
            const bound = fresh + (kind === 'links' ? 1 : 0);
            expect({ step: step.name, kind, derived: segmentDeriveWork[kind].occurrences <= bound }).toEqual({ step: step.name, kind, derived: true });
            expect({ step: step.name, kind, reused: segmentDeriveWork[kind].reused > 0 }).toEqual({ step: step.name, kind, reused: true });
          }
        }
        await check(step.name);
      }
      console.log(`derivation work per append (occurrences derived / live):\n${work.join('\n')}`);
    }, 1_800_000);

    test('a forget that rewrites the segment holding the fence deletes that run\'s derivation rows and only nearby link rows', async () => {
      const page = await storedPage(brain.engine);
      await runExtractFacts(brain.engine, { slugs: [EQUIVALENCE_SLUG] });
      const [fact] = await brain.engine.executeRaw<{ id: number }>(
        "SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact ILIKE '%ships quarterly%' AND expired_at IS NULL", [SOURCE, EQUIVALENCE_SLUG]);
      expect(fact).toBeDefined();
      await deriveAll(brain.engine, page);
      const seqs = new Map((await brain.engine.executeRaw<{ occurrence_id: string; seq: number }>(
        'SELECT occurrence_id::text AS occurrence_id, seq FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND staging_id IS NULL', [page.id]))
        .map(row => [Number(row.occurrence_id), Number(row.seq)]));
      const rowsBefore = await brain.engine.readSegmentDerivations(page.id);
      const before = await liveOccurrences(brain.engine, page.id);
      expect((await forgetFactInFence(brain.engine, Number(fact!.id), { sourceId: SOURCE })).ok).toBe(true);
      const after = await liveOccurrences(brain.engine, page.id);
      const rewritten = [...before].filter(id => !after.has(id));
      expect(rewritten.length).toBe(1);
      const rowsAfter = await brain.engine.readSegmentDerivations(page.id);
      // The rewritten occurrence holds no row of any kind; every other occurrence keeps its rows, except links rows of
      // the runs next to it (a candidate excerpt reaches 120 units past its block).
      expect(rowsAfter.filter(row => rewritten.includes(row.occurrenceId))).toEqual([]);
      const key = (row: { kind: string; occurrenceId: number }) => `${row.kind}:${row.occurrenceId}`;
      const kept = new Set(rowsAfter.map(key));
      const dropped = rowsBefore.filter(row => !rewritten.includes(row.occurrenceId) && !kept.has(key(row)));
      const at = seqs.get(rewritten[0]!)!;
      expect(dropped.every(row => row.kind === 'links' && Math.abs(seqs.get(row.occurrenceId)! - at) === 1)).toBe(true);
      expect(rowsAfter.filter(row => row.kind !== 'links').length).toBe(rowsBefore.filter(row => row.kind !== 'links').length - KINDS.length + 1);
      const current = await storedPage(brain.engine);
      await deriveAll(brain.engine, current);
      expect(await incrementalFactsFenceView(brain.engine, current)).toEqual(await segmentedFactsFenceView(brain.engine, current));
      expect((await incrementalLinks(brain.engine, current)).candidates).toEqual((await fullLinks(brain.engine, current)).candidates);
      await derivationRowsMatch(brain.engine, current, KINDS);
    }, 600_000);

  });
}

const views0 = (views: { incremental: unknown; full: unknown }) => JSON.stringify(views.incremental) === JSON.stringify(views.full);
