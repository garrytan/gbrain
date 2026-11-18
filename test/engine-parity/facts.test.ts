/**
 * BrainEngine parity — facts family (the `remember` / `forget` memory verbs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every hot-memory fact method (insert, supersede/expire, the
 *    list-by-entity/since/session reads, keyset paging, fence batch insert,
 *    candidate search, consolidation, trajectory, health) returns the same
 *    observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; a Rust arm later through test/engine-parity/harness.ts).
 *  - Regression: an engine that drifts on which facts a `recall` sees (active
 *    vs expired vs validity-lapsed), on the order or paging of a list, or on
 *    what `forget` / supersede leaves behind: the memory a personal brain
 *    answers from.
 *  - Why existing coverage misses it: the per-engine fact tests each run one
 *    engine, and test/e2e/engine-parity*.test.ts skips without Postgres and
 *    has no facts scenario; nothing compares two engines on one fact history.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, FactRow } from '../../src/core/engine.ts';
import { basisEmbedding, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const at = (s: string) => new Date(s);

/** Fact ids are not comparable across arms (sequences are not reset): name them by fact text. */
function namer(rows: Array<{ id: number; fact: string }>) {
  const names = new Map<number, string>();
  for (const r of rows) names.set(r.id, r.fact);
  return (id: number | null | undefined) => (id == null ? null : (names.get(id) ?? '<unknown-id>'));
}

function view(row: FactRow, name: (id: number | null) => string | null) {
  return {
    fact: row.fact,
    entity: row.entity_slug,
    kind: row.kind,
    visibility: row.visibility,
    notability: row.notability,
    context: row.context,
    valid_from: iso(row.valid_from),
    valid_until: iso(row.valid_until),
    expired: row.expired_at instanceof Date,
    superseded_by: name(row.superseded_by),
    consolidated: row.consolidated_at instanceof Date,
    source: row.source,
    session: row.source_session,
    confidence: row.confidence,
    attributed_to: row.attributed_to ?? null,
  };
}

const texts = (rows: FactRow[]) => rows.map((r) => r.fact);

/** Insert facts one by one (so created_at and ids follow the array order). */
async function remember(
  engine: BrainEngine,
  entity: string | null,
  facts: Array<Partial<Parameters<BrainEngine['insertFact']>[0]> & { fact: string }>,
) {
  const ids = new Map<string, number>();
  for (const f of facts) {
    const r = await engine.insertFact({ entity_slug: entity, source: 'mcp:remember', ...f }, { source_id: SRC });
    expect(r.status).toBe('inserted');
    ids.set(f.fact, r.id);
  }
  return ids;
}


/**
 * The private-provenance fixture: one page per rule of `privateProvenanceFilterUnderPolicy('facts')`
 * (src/core/search/private-visibility.ts), and one fence row per page, each named after its page, so a read under
 * `excludePrivate` names which rules hid which rows. Rows `entity:*` judge the entity page and the holding page.
 */
const PRIVACY_ENTITY = 'people/subject-example';
const PRIVACY_PAGES: Array<[string, string, Record<string, unknown>]> = [
  ['notes/open', 'note', {}],
  ['notes/private', 'note', { visibility: 'private' }],
  ['notes/readers', 'note', { readable_by: ['alice-example'] }],
  ['notes/access-alias', 'note', { access: '\u00a0Restricted\u3000' }],
  ['notes/access-plain', 'note', { access: 'team' }],
  ['notes/alias-with-visibility', 'note', { confidentiality: 'secret', visibility: 'world' }],
  ['notes/pinned', 'note', { pinned_question: true, visibility: 'world' }],
  ['atoms/no-visibility', 'atom', {}],
  ['atoms/origin-private', 'atom', { visibility: 'world', source_slug: 'notes/private' }],
  ['atoms/origin-readers', 'atom', { visibility: 'world', source_slug: 'notes/readers' }],
  ['atoms/origin-open', 'atom', { visibility: 'world', source_slug: 'notes/open' }],
  ['concepts/private-input', 'concept', { visibility: 'world', synthesized_by: 'dream' }],
  ['concepts/readers-input', 'concept', { visibility: 'world', synthesized_by: 'dream' }],
  ['concepts/open-input', 'concept', { visibility: 'world', synthesized_by: 'dream' }],
  ['concepts/plain', 'concept', {}],
  ['notes/lineage-md', 'note', { derived_from: 'notes/private.md' }],
  ['notes/lineage-readers', 'note', { derived_from: ['notes/open', 'notes/readers'] }],
  ['notes/lineage-open', 'note', { derived_from: ['notes/open.md', 'notes/none'] }],
  ['events/chronicle-missing', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'meetings/none' } }],
  ['events/chronicle-private', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'notes/private' } }],
  ['events/chronicle-open', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'notes/open' } }],
  ['events/plain', 'event', { event: { depth: 'meetings/none' } }],
  ['people/private-entity', 'person', { visibility: 'private' }],
  ['people/readers-entity', 'person', { readable_by: ['alice-example'] }],
  ['team/memory/unattributed', 'note', { visibility: 'private' }],
];

async function privacyFixture(engine: BrainEngine) {
  for (const [slug, type, frontmatter] of PRIVACY_PAGES) {
    await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter });
  }
  await engine.addLink('concepts/private-input', 'atoms/no-visibility', '', 'synthesized_from', 'concept-provenance');
  await engine.addLink('concepts/readers-input', 'notes/readers', '', 'synthesized_from', 'concept-provenance');
  await engine.addLink('concepts/open-input', 'notes/open', '', 'synthesized_from', 'concept-provenance');
  await engine.addLink('concepts/open-input', 'notes/private', '', 'mentions', 'manual');
  const pageRows = [...PRIVACY_PAGES.map(([slug]) => slug), 'notes/no-page'].map((slug, i) => ({
    fact: `page:${slug}`, entity_slug: PRIVACY_ENTITY, source_markdown_slug: slug, row_num: i + 1,
  }));
  const entityRows = [
    { fact: 'entity:private', entity_slug: 'people/private-entity', source_markdown_slug: 'notes/open', row_num: 101 },
    { fact: 'entity:readers', entity_slug: 'people/readers-entity', source_markdown_slug: 'notes/open', row_num: 102 },
    { fact: 'entity:open', entity_slug: 'notes/open', source_markdown_slug: 'notes/open', row_num: 103 },
    { fact: 'entity:held-private', entity_slug: 'people/no-page', source_markdown_slug: 'team/memory/unattributed', row_num: 104 },
    { fact: 'entity:unheld', entity_slug: null, source_markdown_slug: 'team/memory/unattributed', row_num: 105 },
  ];
  const rows = [...pageRows, ...entityRows].map((r) => ({
    ...r, kind: 'fact' as const, visibility: 'world' as const, source: 'fence', source_session: 'sess-privacy',
    valid_from: at('2026-03-01T00:00:00Z'), claim_metric: 'arr', claim_value: r.row_num,
    dimension: `dim-${r.row_num}`, value: r.fact,
  }));
  await engine.insertFacts(rows as never, { source_id: SRC });
}

describe('engine parity: facts', () => {
  parityTest(
    'insertFact stores defaults and every supplied field; listFactsByEntity reads it back',
    { methods: ['insertFact', 'listFactsByEntity'] },
    async (engine) => {
      const plain = await engine.insertFact({ fact: 'Alice prefers async standups', entity_slug: 'people/alice-example', source: 'mcp:remember', valid_from: at('2026-01-15T00:00:00Z') }, { source_id: SRC });
      expect(plain.status).toBe('inserted');
      const full = await engine.insertFact(
        {
          fact: 'Alice owns the Q3 roadmap',
          entity_slug: 'people/alice-example',
          kind: 'commitment',
          visibility: 'world',
          notability: 'high',
          context: 'said in the Monday sync',
          valid_from: at('2026-02-01T00:00:00Z'),
          source: 'cli:think',
          source_session: 'sess-1',
          confidence: 0.75,
          attributed_to: 'user',
        },
        { source_id: SRC },
      );
      const rows = await engine.listFactsByEntity(SRC, 'people/alice-example');
      const name = namer([
        { id: plain.id, fact: 'Alice prefers async standups' },
        { id: full.id, fact: 'Alice owns the Q3 roadmap' },
      ]);
      const byText = Object.fromEntries(rows.map((r) => [r.fact, view(r, name)]));
      // defaults
      expect(byText['Alice prefers async standups']).toMatchObject({
        kind: 'fact', visibility: 'private', notability: 'medium', context: null, valid_until: null,
        expired: false, superseded_by: null, consolidated: false, session: null, confidence: 1, attributed_to: null,
      });
      // supplied
      expect(byText['Alice owns the Q3 roadmap']).toMatchObject({
        kind: 'commitment', visibility: 'world', notability: 'high', context: 'said in the Monday sync',
        valid_from: '2026-02-01T00:00:00.000Z', source: 'cli:think', session: 'sess-1', confidence: 0.75, attributed_to: 'user',
      });
      // another entity and another source see nothing
      expect(await engine.listFactsByEntity(SRC, 'people/bob-example')).toEqual([]);
      return { byText, order: texts(rows) };
    },
  );

  parityTest(
    'listFactsByEntity orders newest valid_from first and pages with limit/offset',
    { methods: ['insertFact', 'listFactsByEntity'] },
    async (engine) => {
      await remember(engine, 'companies/acme-example', [
        { fact: 'f-jan', valid_from: at('2026-01-01T00:00:00Z') },
        { fact: 'f-mar', valid_from: at('2026-03-01T00:00:00Z') },
        { fact: 'f-feb', valid_from: at('2026-02-01T00:00:00Z') },
        { fact: 'f-apr', valid_from: at('2026-04-01T00:00:00Z') },
      ]);
      const all = texts(await engine.listFactsByEntity(SRC, 'companies/acme-example'));
      expect(all).toEqual(['f-apr', 'f-mar', 'f-feb', 'f-jan']);
      const page1 = texts(await engine.listFactsByEntity(SRC, 'companies/acme-example', { limit: 2 }));
      const page2 = texts(await engine.listFactsByEntity(SRC, 'companies/acme-example', { limit: 2, offset: 2 }));
      const past = texts(await engine.listFactsByEntity(SRC, 'companies/acme-example', { limit: 2, offset: 4 }));
      expect(page1).toEqual(['f-apr', 'f-mar']);
      expect(page2).toEqual(['f-feb', 'f-jan']);
      expect(past).toEqual([]);
      return { all, page1, page2, past };
    },
  );

  parityTest(
    'listFactsByEntity filters by kind, visibility, session, grep (wildcards literal) and consolidation',
    { methods: ['insertFact', 'listFactsByEntity', 'consolidateFact', 'addTakesBatch', 'putPage', 'listTakes'] },
    async (engine) => {
      const ent = 'people/carol-example';
      const ids = await remember(engine, ent, [
        { fact: 'Carol likes tea', kind: 'preference', visibility: 'private', source_session: 's-a', valid_from: at('2026-01-01T00:00:00Z') },
        { fact: 'Carol shipped v2', kind: 'event', visibility: 'world', source_session: 's-b', valid_from: at('2026-01-02T00:00:00Z') },
        { fact: 'Carol is 100% remote', kind: 'fact', visibility: 'world', source_session: 's-a', valid_from: at('2026-01-03T00:00:00Z') },
        { fact: 'Carol is 1000 miles away', kind: 'fact', visibility: 'private', valid_from: at('2026-01-04T00:00:00Z') },
        { fact: 'Carol under_score name', kind: 'belief', visibility: 'private', valid_from: at('2026-01-05T00:00:00Z') },
      ]);
      const q = async (opts?: Parameters<BrainEngine['listFactsByEntity']>[2]) => texts(await engine.listFactsByEntity(SRC, ent, opts));
      const kindPref = await q({ kinds: ['preference'] });
      const kindTwo = await q({ kinds: ['event', 'belief'] });
      const world = await q({ visibility: ['world'] });
      const priv = await q({ visibility: ['private'] });
      const session = await q({ sessionId: 's-a' });
      const grepCase = await q({ grep: 'SHIPPED' });
      const grepPercent = await q({ grep: '100%' });
      const grepUnderscore = await q({ grep: 'under_score' });
      const grepBlank = await q({ grep: '   ' });
      expect(kindPref).toEqual(['Carol likes tea']);
      expect(kindTwo).toEqual(['Carol under_score name', 'Carol shipped v2']);
      expect(world).toEqual(['Carol is 100% remote', 'Carol shipped v2']);
      expect(priv).toEqual(['Carol under_score name', 'Carol is 1000 miles away', 'Carol likes tea']);
      expect(session).toEqual(['Carol is 100% remote', 'Carol likes tea']);
      expect(grepCase).toEqual(['Carol shipped v2']);
      expect(grepPercent).toEqual(['Carol is 100% remote']);
      expect(grepUnderscore).toEqual(['Carol under_score name']);
      expect(grepBlank).toHaveLength(5);

      // consolidation: promote one fact into a take, then hide consolidated rows
      const page = await engine.putPage('people/carol-example', { type: 'person', title: 'Carol Example', compiled_truth: 'Carol.', timeline: '' });
      await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Carol prefers tea', kind: 'fact', holder: 'people/carol-example' }]);
      const [take] = await engine.listTakes({ page_id: page.id });
      await engine.consolidateFact(ids.get('Carol likes tea')!, take.id);
      const unconsolidated = await q({ unconsolidatedOnly: true });
      const everything = await engine.listFactsByEntity(SRC, ent);
      const tea = everything.find((r) => r.fact === 'Carol likes tea')!;
      expect(unconsolidated).not.toContain('Carol likes tea');
      expect(unconsolidated).toHaveLength(4);
      expect(tea.consolidated_at).toBeInstanceOf(Date);
      expect(tea.consolidated_into).toBe(take.id);
      return { kindPref, kindTwo, world, priv, session, grepCase, grepPercent, grepUnderscore, grepBlank: grepBlank.length, unconsolidated };
    },
  );

  parityTest(
    'expireFact (forget) hides a fact from active reads, keeps history, and is idempotent',
    { methods: ['insertFact', 'expireFact', 'listFactsByEntity', 'getFactsHealth'] },
    async (engine) => {
      const ent = 'people/dana-example';
      const ids = await remember(engine, ent, [
        { fact: 'Dana lives in Austin', valid_from: at('2026-01-01T00:00:00Z') },
        { fact: 'Dana works at Acme', valid_from: at('2026-01-02T00:00:00Z') },
        { fact: 'Dana likes jazz', valid_from: at('2026-01-03T00:00:00Z') },
      ]);
      const name = namer([...ids].map(([fact, id]) => ({ id, fact })));
      const first = await engine.expireFact(ids.get('Dana lives in Austin')!, { at: at('2026-06-01T00:00:00Z') });
      const second = await engine.expireFact(ids.get('Dana lives in Austin')!);
      const missing = await engine.expireFact(999999999);
      expect([first, second, missing]).toEqual([true, false, false]);

      const active = texts(await engine.listFactsByEntity(SRC, ent));
      const history = (await engine.listFactsByEntity(SRC, ent, { activeOnly: false })).map((r) => view(r, name));
      expect(active).toEqual(['Dana likes jazz', 'Dana works at Acme']);
      expect(history.map((h) => h.fact)).toEqual(['Dana likes jazz', 'Dana works at Acme', 'Dana lives in Austin']);
      expect(history.find((h) => h.fact === 'Dana lives in Austin')).toMatchObject({ expired: true, superseded_by: null, valid_until: null });

      const health = await engine.getFactsHealth(SRC);
      expect(health).toMatchObject({ source_id: SRC, total_active: 2, total_expired: 1 });
      return { active, history, expireResults: [first, second, missing] };
    },
  );

  parityTest(
    'expireFact with supersededBy/successorFrom records the successor and ends validity',
    { methods: ['insertFact', 'expireFact', 'listFactsByEntity', 'listSupersessions'] },
    async (engine) => {
      const ent = 'people/eli-example';
      const ids = await remember(engine, ent, [
        { fact: 'Eli is a PM', valid_from: at('2026-01-01T00:00:00Z') },
        { fact: 'Eli is a director', valid_from: at('2026-04-01T00:00:00Z') },
      ]);
      const name = namer([...ids].map(([fact, id]) => ({ id, fact })));
      const ok = await engine.expireFact(ids.get('Eli is a PM')!, {
        supersededBy: ids.get('Eli is a director')!,
        at: at('2026-04-02T00:00:00Z'),
        successorFrom: at('2026-04-01T00:00:00Z'),
      });
      expect(ok).toBe(true);
      const history = (await engine.listFactsByEntity(SRC, ent, { activeOnly: false })).map((r) => view(r, name));
      const old = history.find((h) => h.fact === 'Eli is a PM')!;
      expect(old).toMatchObject({ expired: true, superseded_by: 'Eli is a director', valid_until: '2026-04-01T00:00:00.000Z' });
      const sup = (await engine.listSupersessions(SRC)).map((r) => view(r, name));
      expect(sup.map((s) => s.fact)).toEqual(['Eli is a PM']);
      return { history, sup };
    },
  );

  parityTest(
    'insertFact with supersedeId inserts the successor and closes the old fact atomically',
    { methods: ['insertFact', 'listFactsByEntity', 'listSupersessions'] },
    async (engine) => {
      const ent = 'people/fay-example';
      const old = await engine.insertFact(
        { fact: 'Fay lives in Boston', entity_slug: ent, source: 'mcp:remember', valid_from: at('2026-01-01T00:00:00Z') },
        { source_id: SRC },
      );
      const next = await engine.insertFact(
        { fact: 'Fay lives in Denver', entity_slug: ent, source: 'mcp:remember', valid_from: at('2026-05-01T00:00:00Z') },
        { source_id: SRC, supersedeId: old.id },
      );
      expect(next.status).toBe('superseded');
      expect(next.id).not.toBe(old.id);
      const name = namer([{ id: old.id, fact: 'Fay lives in Boston' }, { id: next.id, fact: 'Fay lives in Denver' }]);
      const active = texts(await engine.listFactsByEntity(SRC, ent));
      const history = (await engine.listFactsByEntity(SRC, ent, { activeOnly: false })).map((r) => view(r, name));
      expect(active).toEqual(['Fay lives in Denver']);
      expect(history.find((h) => h.fact === 'Fay lives in Boston')).toMatchObject({
        expired: true, superseded_by: 'Fay lives in Denver', valid_until: '2026-05-01T00:00:00.000Z',
      });
      const sup = (await engine.listSupersessions(SRC)).map((r) => ({ fact: r.fact, by: name(r.superseded_by) }));
      expect(sup).toEqual([{ fact: 'Fay lives in Boston', by: 'Fay lives in Denver' }]);
      // superseding an already-superseded fact does not rewrite it
      const again = await engine.insertFact(
        { fact: 'Fay lives in Miami', entity_slug: ent, source: 'mcp:remember', valid_from: at('2026-06-01T00:00:00Z') },
        { source_id: SRC, supersedeId: old.id },
      );
      expect(again.status).toBe('superseded');
      const afterAgain = (await engine.listSupersessions(SRC)).map((r) => ({ fact: r.fact, by: r.superseded_by === old.id ? 'old' : name(r.superseded_by) ?? 'miami' }));
      return { active, history, sup, afterAgain: sorted(afterAgain, (r) => r.fact) };
    },
  );

  parityTest(
    'listSupersessions filters by since, visibility and limit, newest supersession first',
    { methods: ['insertFact', 'expireFact', 'listSupersessions'] },
    async (engine) => {
      const ent = 'people/gus-example';
      const ids = await remember(engine, ent, [
        { fact: 'g-old-1', visibility: 'private', valid_from: at('2026-01-01T00:00:00Z') },
        { fact: 'g-old-2', visibility: 'world', valid_from: at('2026-01-02T00:00:00Z') },
        { fact: 'g-old-3', visibility: 'world', valid_from: at('2026-01-03T00:00:00Z') },
        { fact: 'g-new', visibility: 'world', valid_from: at('2026-02-01T00:00:00Z') },
      ]);
      await engine.expireFact(ids.get('g-old-1')!, { supersededBy: ids.get('g-new')!, at: at('2026-03-01T00:00:00Z') });
      await engine.expireFact(ids.get('g-old-2')!, { supersededBy: ids.get('g-new')!, at: at('2026-04-01T00:00:00Z') });
      await engine.expireFact(ids.get('g-old-3')!, { supersededBy: ids.get('g-new')!, at: at('2026-05-01T00:00:00Z') });
      const all = texts(await engine.listSupersessions(SRC));
      const since = texts(await engine.listSupersessions(SRC, { since: at('2026-04-01T00:00:00Z') }));
      const worldOnly = texts(await engine.listSupersessions(SRC, { visibility: ['world'] }));
      const limited = texts(await engine.listSupersessions(SRC, { limit: 1 }));
      expect(all).toEqual(['g-old-3', 'g-old-2', 'g-old-1']);
      expect(since).toEqual(['g-old-3', 'g-old-2']);
      expect(worldOnly).toEqual(['g-old-3', 'g-old-2']);
      expect(limited).toEqual(['g-old-3']);
      return { all, since, worldOnly, limited };
    },
  );

  parityTest(
    'activeOnly reads drop validity-lapsed rows; activeOnly:false keeps them',
    { methods: ['insertFact', 'listFactsByEntity', 'listFactsSince', 'listFactsBySession', 'countUnconsolidatedFacts'] },
    async (engine) => {
      const ent = 'people/hal-example';
      await remember(engine, ent, [
        { fact: 'h-open', valid_from: at('2026-01-01T00:00:00Z'), source_session: 'hs' },
        { fact: 'h-lapsed', valid_from: at('2026-01-02T00:00:00Z'), valid_until: at('2026-02-01T00:00:00Z'), source_session: 'hs' },
        { fact: 'h-future', valid_from: at('2026-01-03T00:00:00Z'), valid_until: at('2999-01-01T00:00:00Z'), source_session: 'hs' },
      ]);
      const since = at('2000-01-01T00:00:00Z');
      const byEntity = texts(await engine.listFactsByEntity(SRC, ent));
      const byEntityAll = texts(await engine.listFactsByEntity(SRC, ent, { activeOnly: false }));
      const bySince = texts(await engine.listFactsSince(SRC, since));
      const bySinceAll = texts(await engine.listFactsSince(SRC, since, { activeOnly: false }));
      const bySession = texts(await engine.listFactsBySession(SRC, 'hs'));
      const bySessionAll = texts(await engine.listFactsBySession(SRC, 'hs', { activeOnly: false }));
      const pending = await engine.countUnconsolidatedFacts(SRC);
      expect(byEntity).toEqual(['h-future', 'h-open']);
      expect(byEntityAll).toHaveLength(3);
      expect(bySince.sort()).toEqual(['h-future', 'h-open']);
      expect(bySinceAll).toHaveLength(3);
      expect(bySession.sort()).toEqual(['h-future', 'h-open']);
      expect(bySessionAll).toHaveLength(3);
      expect(pending).toBe(2);
      return { byEntity, byEntityAll, bySince: sorted(bySince), bySinceAll: sorted(bySinceAll), bySession: sorted(bySession), bySessionAll: sorted(bySessionAll), pending };
    },
  );

  parityTest(
    'listFactsSince windows on creation time, or on event time with eventTime',
    { methods: ['insertFact', 'listFactsSince'] },
    async (engine) => {
      const ent = 'people/ivy-example';
      // inserted in this order; created_at is "now" for all, valid_from is the event time
      await remember(engine, ent, [
        { fact: 'i-old-event', valid_from: at('2025-06-01T00:00:00Z') },
        { fact: 'i-mid-event', valid_from: at('2026-01-15T00:00:00Z') },
        { fact: 'i-new-event', valid_from: at('2026-03-15T00:00:00Z') },
      ]);
      const longAgo = at('2000-01-01T00:00:00Z');
      const future = at('2999-01-01T00:00:00Z');
      const created = texts(await engine.listFactsSince(SRC, longAgo));
      const createdFuture = texts(await engine.listFactsSince(SRC, future));
      const eventAll = texts(await engine.listFactsSince(SRC, longAgo, { eventTime: true }));
      const eventSince = texts(await engine.listFactsSince(SRC, at('2026-01-01T00:00:00Z'), { eventTime: true }));
      const eventPaged = texts(await engine.listFactsSince(SRC, longAgo, { eventTime: true, limit: 1, offset: 1 }));
      expect(created).toEqual(['i-new-event', 'i-mid-event', 'i-old-event']); // newest created first = reverse insert order
      expect(createdFuture).toEqual([]);
      expect(eventAll).toEqual(['i-new-event', 'i-mid-event', 'i-old-event']);
      expect(eventSince).toEqual(['i-new-event', 'i-mid-event']);
      expect(eventPaged).toEqual(['i-mid-event']);
      return { created, createdFuture, eventAll, eventSince, eventPaged };
    },
  );

  parityTest(
    'listFactsSince narrows by entity, session, kind, visibility, grep and audit rows before the limit',
    { methods: ['insertFact', 'listFactsSince'] },
    async (engine) => {
      await remember(engine, 'people/jo-example', [
        { fact: 'jo likes rust', kind: 'preference', visibility: 'world', source_session: 'js1' },
        { fact: 'jo shipped beta', kind: 'event', visibility: 'private', source_session: 'js2' },
      ]);
      await remember(engine, 'people/kim-example', [
        { fact: 'kim likes rust too', kind: 'preference', visibility: 'world', source_session: 'js1' },
        { fact: 'EXTRACTION_COMPLETE', source: 'cli:extract-conversation-facts:terminal:v2', source_session: 'js1' },
      ]);
      const since = at('2000-01-01T00:00:00Z');
      const q = async (opts?: Parameters<BrainEngine['listFactsSince']>[2]) => sorted(texts(await engine.listFactsSince(SRC, since, opts)));
      const all = await q();
      const entity = await q({ entitySlug: 'people/jo-example' });
      const session = await q({ sessionId: 'js1' });
      const entityAndSession = await q({ entitySlug: 'people/kim-example', sessionId: 'js1' });
      const kinds = await q({ kinds: ['event'] });
      const world = await q({ visibility: ['world'] });
      const grep = await q({ grep: 'RUST' });
      const noAudit = await q({ excludeAuditRows: true });
      const fingerprinted = await engine.listFactsSince(SRC, since, { fingerprint: true, entitySlug: 'people/jo-example' });
      expect(all).toHaveLength(4);
      expect(entity).toEqual(['jo likes rust', 'jo shipped beta']);
      expect(session).toEqual(['EXTRACTION_COMPLETE', 'jo likes rust', 'kim likes rust too']);
      expect(entityAndSession).toEqual(['EXTRACTION_COMPLETE', 'kim likes rust too']);
      expect(kinds).toEqual(['jo shipped beta']);
      expect(world).toEqual(['jo likes rust', 'kim likes rust too']);
      expect(grep).toEqual(['jo likes rust', 'kim likes rust too']);
      expect(noAudit).toEqual(['jo likes rust', 'jo shipped beta', 'kim likes rust too']);
      expect(fingerprinted.every((r) => typeof r.fact_fingerprint === 'string' && r.fact_fingerprint.length > 0)).toBe(true);
      // the same fact text fingerprints identically on every engine
      return { all, entity, session, entityAndSession, kinds, world, grep, noAudit, fingerprints: sorted(fingerprinted.map((r) => `${r.fact}=${r.fact_fingerprint}`)) };
    },
  );

  parityTest(
    'listFactsBySession returns a session newest first and honors filters and paging',
    { methods: ['insertFact', 'listFactsBySession'] },
    async (engine) => {
      await remember(engine, 'people/lee-example', [
        { fact: 's1-a', source_session: 'sess-x', kind: 'event' },
        { fact: 's1-b', source_session: 'sess-x', kind: 'preference', visibility: 'world' },
        { fact: 's1-c', source_session: 'sess-x', kind: 'event', visibility: 'world' },
        { fact: 's2-a', source_session: 'sess-y' },
      ]);
      await remember(engine, null, [
        { fact: 's1-d-no-entity', source_session: 'sess-x' },
        { fact: 'audit', source_session: 'sess-x', source: 'cli:extract-conversation-facts:non-extractable:v2' },
      ]);
      const q = async (sid: string, opts?: Parameters<BrainEngine['listFactsBySession']>[2]) => texts(await engine.listFactsBySession(SRC, sid, opts));
      const all = await q('sess-x');
      const kinds = await q('sess-x', { kinds: ['event'] });
      const world = await q('sess-x', { visibility: ['world'] });
      const noAudit = await q('sess-x', { excludeAuditRows: true });
      const page = await q('sess-x', { limit: 2, offset: 1 });
      const grep = await q('sess-x', { grep: 's1-' });
      const none = await q('sess-nope');
      expect(all).toEqual(['audit', 's1-d-no-entity', 's1-c', 's1-b', 's1-a']);
      expect(kinds).toEqual(['s1-c', 's1-a']);
      expect(world).toEqual(['s1-c', 's1-b']);
      expect(noAudit).toEqual(['s1-d-no-entity', 's1-c', 's1-b', 's1-a']);
      expect(page).toEqual(['s1-d-no-entity', 's1-c']);
      expect(grep).toEqual(['s1-d-no-entity', 's1-c', 's1-b', 's1-a']);
      expect(none).toEqual([]);
      return { all, kinds, world, noAudit, page, grep, none, other: await q('sess-y') };
    },
  );

  parityTest(
    'listFactsKeyset pages oldest-first by (created_at, id) with no gaps or repeats, across two rows that share a timestamp',
    { methods: ['insertFact', 'expireFact', 'listFactsKeyset', 'transaction'] },
    async (engine) => {
      const ent = 'people/max-example';
      // created_at is the database clock (millisecond steps on PGLite), so back-to-back inserts can
      // share a timestamp. Space the inserts until the clock moves, and make k3 and k4 tie on purpose:
      // one transaction stamps both with the same now(), which is what the id half of the cursor is for.
      const ids = new Map<string, number>();
      const add = async (e: BrainEngine, fact: string) => {
        for (const [k, v] of await remember(e, ent, [{ fact }])) ids.set(k, v);
      };
      const nextTick = async () => {
        const stamped = Date.now();
        while (Date.now() <= stamped) await new Promise((resolve) => setTimeout(resolve, 1));
      };
      for (const fact of ['k1', 'k2']) { await add(engine, fact); await nextTick(); }
      await engine.transaction(async (tx) => { await add(tx, 'k3'); await add(tx, 'k4'); });
      await nextTick();
      await add(engine, 'k5');
      const everything = await engine.listFactsKeyset(SRC, null);
      expect(texts(everything)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']);
      const stamps = everything.map((r) => r.created_at_iso);
      expect([stamps[2] === stamps[3], new Set(stamps).size]).toEqual([true, 4]);
      expect(everything.every((r) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(r.created_at_iso ?? ''))).toBe(true);

      // page through with limit 2, advancing the keyset by the last delivered row
      const pages: string[][] = [];
      let cursor: { createdAt: string; id: number | null } | null = null;
      for (let i = 0; i < 5; i++) {
        const rows: FactRow[] = await engine.listFactsKeyset(SRC, cursor, { limit: 2 });
        if (rows.length === 0) break;
        pages.push(texts(rows));
        const last = rows[rows.length - 1];
        cursor = { createdAt: last.created_at_iso!, id: last.id };
      }
      expect(pages).toEqual([['k1', 'k2'], ['k3', 'k4'], ['k5']]);

      // id:null means strictly after the timestamp: k3 and k4, which share it, are both excluded;
      // a cursor with k3's id keeps k4, the later row inside the same timestamp
      const k3 = everything[2];
      const afterTs = texts(await engine.listFactsKeyset(SRC, { createdAt: k3.created_at_iso!, id: null }));
      const afterId = texts(await engine.listFactsKeyset(SRC, { createdAt: k3.created_at_iso!, id: k3.id }));
      const beforeAll = texts(await engine.listFactsKeyset(SRC, { createdAt: '2000-01-01T00:00:00.000000Z', id: 0 }));
      const afterAll = texts(await engine.listFactsKeyset(SRC, { createdAt: '2999-01-01T00:00:00.000000Z', id: null }));
      expect(afterTs).toEqual(['k5']);
      expect(afterId).toEqual(['k4', 'k5']);
      expect(beforeAll).toHaveLength(5);
      expect(afterAll).toEqual([]);

      // expired rows disappear from the default read and come back with activeOnly:false
      await engine.expireFact(ids.get('k2')!);
      const active = texts(await engine.listFactsKeyset(SRC, null));
      const withExpired = texts(await engine.listFactsKeyset(SRC, null, { activeOnly: false }));
      expect(active).toEqual(['k1', 'k3', 'k4', 'k5']);
      expect(withExpired).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']);
      return { pages, afterTs, afterId, beforeAll: beforeAll.length, afterAll, active, withExpired };
    },
  );

  parityTest(
    'listFactsKeyset applies visibility, entity, session, grep and audit narrowing before the limit',
    { methods: ['insertFact', 'listFactsKeyset'] },
    async (engine) => {
      await remember(engine, 'people/nia-example', [
        { fact: 'n-private rust', visibility: 'private', source_session: 'ns1' },
        { fact: 'n-world rust', visibility: 'world', source_session: 'ns2' },
      ]);
      await remember(engine, 'people/oz-example', [
        { fact: 'o-world go', visibility: 'world', source_session: 'ns1' },
        { fact: 'EXTRACTION_COMPLETE', visibility: 'world', source: 'cli:extract-conversation-facts:terminal:v2', source_session: 'ns1' },
      ]);
      const q = async (opts?: Parameters<BrainEngine['listFactsKeyset']>[2]) => texts(await engine.listFactsKeyset(SRC, null, opts));
      const world = await q({ visibility: ['world'] });
      const worldLimited = await q({ visibility: ['world'], limit: 1 });
      const entity = await q({ entitySlug: 'people/oz-example' });
      const session = await q({ sessionId: 'ns1' });
      const grep = await q({ grep: 'RUST' });
      const noAudit = await q({ excludeAuditRows: true });
      const fp = await engine.listFactsKeyset(SRC, null, { fingerprint: true });
      expect(world).toEqual(['n-world rust', 'o-world go', 'EXTRACTION_COMPLETE']);
      expect(worldLimited).toEqual(['n-world rust']);
      expect(entity).toEqual(['o-world go', 'EXTRACTION_COMPLETE']);
      expect(session).toEqual(['n-private rust', 'o-world go', 'EXTRACTION_COMPLETE']);
      expect(grep).toEqual(['n-private rust', 'n-world rust']);
      expect(noAudit).toEqual(['n-private rust', 'n-world rust', 'o-world go']);
      expect(fp.every((r) => !!r.fact_fingerprint)).toBe(true);
      return { world, worldLimited, entity, session, grep, noAudit, fingerprints: fp.map((r) => `${r.fact}=${r.fact_fingerprint}`) };
    },
  );

  parityTest(
    'insertFacts stores fence rows in order, resolves superseded-by row refs, and skips duplicate row numbers',
    { methods: ['insertFacts', 'listFactsByEntity', 'listSupersessions', 'deleteFactsForPage'] },
    async (engine) => {
      const slug = 'people/pat-example';
      const rows = [
        { row_num: 1, source_markdown_slug: slug, fact: 'Pat joined Acme', entity_slug: slug, source: 'fence', valid_from: at('2026-01-01T00:00:00Z'), expired_at: at('2026-06-01T00:00:00Z'), superseded_by_row: 2 },
        { row_num: 2, source_markdown_slug: slug, fact: 'Pat leads Acme platform', entity_slug: slug, source: 'fence', valid_from: at('2026-06-01T00:00:00Z'), kind: 'event' as const },
        { row_num: 3, source_markdown_slug: slug, fact: 'Pat dangling ref', entity_slug: slug, source: 'fence', valid_from: at('2026-07-01T00:00:00Z'), superseded_by_row: 99 },
        { row_num: 4, source_markdown_slug: slug, fact: 'Pat self ref', entity_slug: slug, source: 'fence', valid_from: at('2026-08-01T00:00:00Z'), superseded_by_row: 4 },
      ];
      const first = await engine.insertFacts(rows, { source_id: SRC });
      expect(first.inserted).toBe(4);
      expect(first.ids).toHaveLength(4);
      expect(first.deleted).toBe(0);
      const name = namer(first.ids.map((id, i) => ({ id, fact: rows[i].fact })));

      // same (slug,row_num) again is skipped, not duplicated
      const again = await engine.insertFacts([{ ...rows[1], fact: 'Pat leads Acme platform (dup)' }, { row_num: 5, source_markdown_slug: slug, fact: 'Pat new row', entity_slug: slug, source: 'fence', valid_from: at('2026-09-01T00:00:00Z') }], { source_id: SRC });
      expect(again.inserted).toBe(1);

      const history = (await engine.listFactsByEntity(SRC, slug, { activeOnly: false })).map((r) => view(r, name));
      const sup = (await engine.listSupersessions(SRC)).map((r) => ({ fact: r.fact, by: name(r.superseded_by) }));
      expect(sup).toEqual([{ fact: 'Pat joined Acme', by: 'Pat leads Acme platform' }]);
      expect(first.warnings.length).toBe(2); // dangling + self reference
      expect(await engine.insertFacts([], { source_id: SRC })).toEqual({ inserted: 0, ids: [], warnings: [], deleted: 0 });

      const wiped = await engine.deleteFactsForPage(slug, SRC);
      const none = await engine.deleteFactsForPage(slug, SRC);
      expect(wiped.deleted).toBe(5);
      expect(none.deleted).toBe(0);
      expect(await engine.listFactsByEntity(SRC, slug, { activeOnly: false })).toEqual([]);
      return {
        history: sorted(history, (h) => h.fact), sup, warningCount: first.warnings.length, againInserted: again.inserted,
        wiped: wiped.deleted, none: none.deleted,
      };
    },
  );

  parityTest(
    'insertFacts deleteForPageFirst replaces a page atomically; deleteFactsForPage spares excluded source prefixes and other pages',
    { methods: ['insertFacts', 'deleteFactsForPage', 'listFactsByEntity', 'insertFact'] },
    async (engine) => {
      const slug = 'notes/standup';
      const other = 'notes/retro';
      const mk = (page: string, n: number, fact: string, source: string) => ({
        row_num: n, source_markdown_slug: page, fact, entity_slug: 'people/quinn-example', source,
        valid_from: at(`2026-01-0${n}T00:00:00Z`),
      });
      await engine.insertFacts([mk(slug, 1, 'a-fence', 'fence'), mk(slug, 2, 'a-cli', 'cli:conversation'), mk(slug, 3, 'a-mcp', 'mcp:put_page')], { source_id: SRC });
      await engine.insertFacts([mk(other, 1, 'b-fence', 'fence')], { source_id: SRC });
      const ent = 'people/quinn-example';
      const left = async () => sorted(texts(await engine.listFactsByEntity(SRC, ent, { activeOnly: false })));

      // exclude `cli:` rows from the wipe
      const partial = await engine.deleteFactsForPage(slug, SRC, { excludeSourcePrefixes: ['cli:'] });
      expect(partial.deleted).toBe(2);
      const afterPartial = await left();
      expect(afterPartial).toEqual(['a-cli', 'b-fence']);

      // atomic reconcile keeping `cli:` rows: nothing deleted, row 2 collides with the survivor and is skipped
      const keepCli = await engine.insertFacts(
        [mk(slug, 1, 'a-fence-v2', 'fence'), mk(slug, 2, 'a-cli-v2', 'cli:conversation')],
        { source_id: SRC },
        { deleteForPageFirst: { slug, excludeSourcePrefixes: ['cli:'] } },
      );
      expect([keepCli.deleted, keepCli.inserted]).toEqual([0, 1]);
      const afterKeepCli = await left();

      // full atomic reconcile: wipe the page's rows and insert the new ones in one call
      const replaced = await engine.insertFacts(
        [mk(slug, 1, 'a-fence-v3', 'fence'), mk(slug, 2, 'a-cli-v3', 'cli:conversation')],
        { source_id: SRC },
        { deleteForPageFirst: { slug } },
      );
      expect([replaced.deleted, replaced.inserted]).toEqual([2, 2]);
      const afterReplace = await left();
      expect(afterReplace).toEqual(['a-cli-v3', 'a-fence-v3', 'b-fence']);

      // a fact with no fence coordinate is never touched by a page wipe
      await engine.insertFact({ fact: 'legacy-no-slug', entity_slug: ent, source: 'mcp:remember' }, { source_id: SRC });
      const wipeAll = await engine.deleteFactsForPage(slug, SRC);
      const afterWipe = await left();
      expect(afterWipe).toEqual(['b-fence', 'legacy-no-slug']);
      return { partialDeleted: partial.deleted, afterPartial, keepCli: [keepCli.deleted, keepCli.inserted], afterKeepCli, replaced: [replaced.deleted, replaced.inserted], afterReplace, wipeAll: wipeAll.deleted, afterWipe };
    },
  );

  parityTest(
    'countUnconsolidatedFacts counts active entity-bound facts and ignores audit rows',
    { methods: ['insertFact', 'expireFact', 'consolidateFact', 'countUnconsolidatedFacts', 'addTakesBatch', 'putPage', 'listTakes'] },
    async (engine) => {
      const ent = 'people/rae-example';
      const ids = await remember(engine, ent, [{ fact: 'r1' }, { fact: 'r2' }, { fact: 'r3' }, { fact: 'r4', valid_until: at('2026-01-01T00:00:00Z'), valid_from: at('2025-01-01T00:00:00Z') }]);
      await remember(engine, null, [{ fact: 'no-entity' }]);
      await remember(engine, ent, [{ fact: 'audit', source: 'cli:extract-conversation-facts:terminal:v2' }]);
      const initial = await engine.countUnconsolidatedFacts(SRC);
      expect(initial).toBe(3); // r4 lapsed, no-entity excluded, audit excluded

      await engine.expireFact(ids.get('r1')!);
      const afterExpire = await engine.countUnconsolidatedFacts(SRC);
      const page = await engine.putPage('people/rae-example', { type: 'person', title: 'Rae Example', compiled_truth: 'Rae.', timeline: '' });
      await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Rae claim', kind: 'fact', holder: 'people/rae-example' }]);
      const [take] = await engine.listTakes({ page_id: page.id });
      await engine.consolidateFact(ids.get('r2')!, take.id);
      const afterConsolidate = await engine.countUnconsolidatedFacts(SRC);
      expect([initial, afterExpire, afterConsolidate]).toEqual([3, 2, 1]);
      const other = await engine.countUnconsolidatedFacts('some-other-source');
      expect(other).toBe(0);
      return { initial, afterExpire, afterConsolidate, other };
    },
  );

  parityTest(
    'findCandidateDuplicates (recency arm) returns active same-entity facts newest first, capped by k',
    { methods: ['insertFact', 'expireFact', 'findCandidateDuplicates'] },
    async (engine) => {
      const ent = 'people/sam-example';
      const ids = await remember(engine, ent, [
        { fact: 'c1 likes coffee', attributed_to: 'user' },
        { fact: 'c2 likes tea', attributed_to: 'assistant' },
        { fact: 'c3 likes water' },
        { fact: 'c4 likes juice', valid_until: at('2026-01-01T00:00:00Z'), valid_from: at('2025-01-01T00:00:00Z') },
        { fact: 'c5 forgotten' },
        { fact: 'c6 audit', source: 'cli:extract-conversation-facts:terminal:v2' },
      ]);
      await remember(engine, 'people/other-example', [{ fact: 'other entity' }]);
      await engine.expireFact(ids.get('c5 forgotten')!);
      const q = async (opts?: Parameters<BrainEngine['findCandidateDuplicates']>[3]) => texts(await engine.findCandidateDuplicates(SRC, ent, 'sam drinks coffee', opts));
      const def = await q();
      const k2 = await q({ k: 2 });
      const speakerUser = await q({ attributedTo: 'user' });
      const speakerAssistant = await q({ attributedTo: 'assistant' });
      const missingEntity = texts(await engine.findCandidateDuplicates(SRC, 'people/nobody', 'x'));
      // audit rows are not filtered by the recency arm (only the embedding/keyword arms drop them)
      expect(def).toContain('c3 likes water');
      expect(def).not.toContain('c5 forgotten');
      expect(def).not.toContain('c4 likes juice');
      expect(k2).toEqual(def.slice(0, 2));
      expect(speakerUser).not.toContain('c2 likes tea');
      expect(speakerAssistant).not.toContain('c1 likes coffee');
      expect(missingEntity).toEqual([]);
      return { def, k2, speakerUser, speakerAssistant, missingEntity };
    },
  );

  parityTest(
    'findCandidateDuplicates (embedding arm) ranks by cosine and only compares same-model current vectors',
    { methods: ['insertFact', 'findCandidateDuplicates'] },
    async (engine) => {
      const ent = 'people/tess-example';
      await remember(engine, ent, [
        { fact: 'e-axis0', embedding: basisEmbedding(0), embedding_model: 'm1' },
        { fact: 'e-axis1', embedding: basisEmbedding(1), embedding_model: 'm1' },
        { fact: 'e-axis2-other-model', embedding: basisEmbedding(2), embedding_model: 'm2' },
        { fact: 'e-no-embedding' },
        { fact: 'e-audit', embedding: basisEmbedding(0), embedding_model: 'm1', source: 'cli:extract-conversation-facts:terminal:v2' },
      ]);
      const near0 = new Float32Array(1536);
      near0[0] = 1;
      near0[1] = 0.2;
      const hits = texts(await engine.findCandidateDuplicates(SRC, ent, 'whatever', { embedding: near0, embeddingModel: 'm1' }));
      const hitsK1 = texts(await engine.findCandidateDuplicates(SRC, ent, 'whatever', { embedding: near0, embeddingModel: 'm1', k: 1 }));
      const otherModel = texts(await engine.findCandidateDuplicates(SRC, ent, 'whatever', { embedding: basisEmbedding(2), embeddingModel: 'm2' }));
      const noModel = texts(await engine.findCandidateDuplicates(SRC, ent, 'whatever', { embedding: near0 }));
      expect(hits).toEqual(['e-axis0', 'e-axis1']);
      expect(hitsK1).toEqual(['e-axis0']);
      expect(otherModel).toEqual(['e-axis2-other-model']);
      expect(noModel).toEqual([]);
      return { hits, hitsK1, otherModel, noModel };
    },
  );

  parityTest(
    'findCandidateDuplicates (keyword arm) ranks the entity bucket by shared terms',
    { methods: ['insertFact', 'findCandidateDuplicates'] },
    async (engine) => {
      const ent = 'people/uma-example';
      await remember(engine, ent, [
        { fact: 'Uma pays 50 dollars for the rust workshop' },
        { fact: 'Uma likes hiking on weekends' },
        { fact: 'Uma bought a rust book' },
      ]);
      const q = async (text: string, opts: Parameters<BrainEngine['findCandidateDuplicates']>[3] = {}) =>
        texts(await engine.findCandidateDuplicates(SRC, ent, text, { arm: 'keyword', ...opts }));
      const rust = await q('rust workshop');
      const rustOne = await q('rust workshop', { k: 1 });
      const hiking = await q('hiking');
      const noMatch = await q('zzzzqqqq');
      const stopwordsOnly = await q('the');
      expect(rust[0]).toBe('Uma pays 50 dollars for the rust workshop');
      expect(sorted(rust)).toEqual(['Uma bought a rust book', 'Uma pays 50 dollars for the rust workshop']);
      expect(rustOne).toEqual(['Uma pays 50 dollars for the rust workshop']);
      expect(hiking).toEqual(['Uma likes hiking on weekends']);
      expect(noMatch).toEqual([]);
      expect(stopwordsOnly).toEqual([]);
      return { rust, rustOne, hiking, noMatch, stopwordsOnly };
    },
  );

  parityTest(
    'findTrajectory returns the typed-claim history chronologically, world-only unless local',
    { methods: ['insertFact', 'insertFacts', 'expireFact', 'findTrajectory'] },
    async (engine) => {
      const ent = 'companies/vela-example';
      const ids = await remember(engine, ent, [
        { fact: 'MRR 10k', claim_metric: 'mrr', claim_value: 10000, claim_unit: 'usd', claim_period: 'month', valid_from: at('2026-01-01T00:00:00Z'), visibility: 'world', source_session: 'tr-1' },
        { fact: 'MRR 20k', claim_metric: 'mrr', claim_value: 20000, claim_unit: 'usd', claim_period: 'month', valid_from: at('2026-02-01T00:00:00Z'), visibility: 'private' },
        { fact: 'MRR 15k', claim_metric: 'mrr', claim_value: 15000, claim_unit: 'usd', claim_period: 'month', valid_from: at('2026-03-01T00:00:00Z'), visibility: 'world' },
        { fact: 'Headcount 12', claim_metric: 'headcount', claim_value: 12, claim_unit: 'people', valid_from: at('2026-02-15T00:00:00Z'), visibility: 'world' },
        { fact: 'untyped note', valid_from: at('2026-02-21T00:00:00Z'), visibility: 'world' },
        { fact: 'MRR forgotten', claim_metric: 'mrr', claim_value: 1, valid_from: at('2026-04-01T00:00:00Z'), visibility: 'world' },
      ]);
      await engine.expireFact(ids.get('MRR forgotten')!);
      // insertFact has no event_type; the fence batch insert does
      await engine.insertFacts(
        [{ row_num: 1, source_markdown_slug: ent, fact: 'Met the founder', entity_slug: ent, source: 'fence', event_type: 'meeting', valid_from: at('2026-02-20T00:00:00Z'), visibility: 'world' }],
        { source_id: SRC },
      );
      const pts = (rows: Awaited<ReturnType<BrainEngine['findTrajectory']>>) =>
        rows.map((p) => ({ text: p.text, metric: p.metric, value: p.value, unit: p.unit, period: p.period, event: p.event_type, from: iso(p.valid_from), until: iso(p.valid_until), session: p.source_session }));
      const local = await engine.findTrajectory({ entitySlug: ent, remote: false });
      const remoteDefault = await engine.findTrajectory({ entitySlug: ent });
      const mrr = await engine.findTrajectory({ entitySlug: ent, remote: false, metric: 'mrr' });
      const metrics = await engine.findTrajectory({ entitySlug: ent, remote: false, kind: 'metric' });
      const events = await engine.findTrajectory({ entitySlug: ent, remote: false, kind: 'event' });
      const window = await engine.findTrajectory({ entitySlug: ent, remote: false, since: '2026-02-01', until: '2026-02-28' });
      const capped = await engine.findTrajectory({ entitySlug: ent, remote: false, limit: 2 });
      const otherSource = await engine.findTrajectory({ entitySlug: ent, remote: false, sourceId: 'nope' });
      const arraySource = await engine.findTrajectory({ entitySlug: ent, remote: false, sourceIds: [SRC] });
      expect(local.map((p) => p.text)).toEqual(['MRR 10k', 'MRR 20k', 'Headcount 12', 'Met the founder', 'untyped note', 'MRR 15k']);
      expect(remoteDefault.map((p) => p.text)).toEqual(['MRR 10k', 'Headcount 12', 'Met the founder', 'untyped note', 'MRR 15k']);
      expect(mrr.map((p) => p.value)).toEqual([10000, 20000, 15000]);
      expect(metrics.map((p) => p.text)).toEqual(['MRR 10k', 'MRR 20k', 'Headcount 12', 'MRR 15k']);
      expect(events.map((p) => p.text)).toEqual(['Met the founder']);
      expect(window.map((p) => p.text)).toEqual(['MRR 20k', 'Headcount 12', 'Met the founder', 'untyped note']);
      expect(capped.map((p) => p.text)).toEqual(['untyped note', 'MRR 15k']);
      expect(otherSource).toEqual([]);
      expect(arraySource).toHaveLength(6);
      expect(local.every((p) => p.embedding === null)).toBe(true);
      return {
        local: pts(local), remoteDefault: remoteDefault.map((p) => p.text), mrr: pts(mrr), metrics: metrics.map((p) => p.text),
        events: pts(events), window: window.map((p) => p.text), capped: capped.map((p) => p.text), otherSource, arraySource: arraySource.length,
      };
    },
  );

  parityTest(
    'getFactsHealth partitions active/expired/consolidated and ranks top entities',
    { methods: ['insertFact', 'expireFact', 'consolidateFact', 'getFactsHealth', 'addTakesBatch', 'putPage', 'listTakes'] },
    async (engine) => {
      const ids = await remember(engine, 'people/wes-example', [{ fact: 'w1' }, { fact: 'w2' }, { fact: 'w3' }]);
      await remember(engine, 'people/xia-example', [{ fact: 'x1' }, { fact: 'x2' }]);
      await remember(engine, 'people/yan-example', [{ fact: 'y1' }]);
      await remember(engine, 'people/zed-example', [{ fact: 'z-lapsed', valid_from: at('2025-01-01T00:00:00Z'), valid_until: at('2025-02-01T00:00:00Z') }]);
      await remember(engine, null, [{ fact: 'free-floating' }]);
      await engine.expireFact(ids.get('w3')!);
      const page = await engine.putPage('people/wes-example', { type: 'person', title: 'Wes Example', compiled_truth: 'Wes.', timeline: '' });
      await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Wes claim', kind: 'fact', holder: 'people/wes-example' }]);
      const [take] = await engine.listTakes({ page_id: page.id });
      await engine.consolidateFact(ids.get('w1')!, take.id);
      const health = await engine.getFactsHealth(SRC);
      expect(health.total_active + health.total_expired).toBe(8);
      const empty = await engine.getFactsHealth('empty-source');
      expect(empty).toMatchObject({ total_active: 0, total_expired: 0, top_entities: [] });
      return {
        source_id: health.source_id, total_active: health.total_active, total_today: health.total_today, total_week: health.total_week,
        total_expired: health.total_expired, total_consolidated: health.total_consolidated, top_entities: health.top_entities,
      };
    },
  );
  parityTest(
    'findCandidateDuplicates (keyword arm) orders by ts_rank_cd then newest, stems and drops audit, inactive, speaker and member rows',
    { methods: ['insertFact', 'insertFacts', 'expireFact', 'findCandidateDuplicates'] },
    async (engine) => {
      const ent = 'people/vic-example';
      const ids = await remember(engine, ent, [
        { fact: 'Vic trains for the Berlin marathon every spring' },
        { fact: 'Vic ran the marathon' },
        { fact: 'Vic likes Berlin' },
        { fact: 'Vic marathon marathon marathon' },
        { fact: 'Vic visited a Zürich café' },
        { fact: 'Vic marathon audit checkpoint', source: 'cli:extract-conversation-facts:terminal:v2' },
        { fact: 'Vic marathon expired' },
        { fact: 'Vic marathon lapsed', valid_from: at('2025-01-01T00:00:00Z'), valid_until: at('2025-02-01T00:00:00Z') },
        { fact: 'Vic marathon said by the assistant', attributed_to: 'assistant' },
        { fact: 'Vic marathon said by the user', attributed_to: 'user' },
        { fact: 'Cooking notes with no shared words' },
      ]);
      await engine.expireFact(ids.get('Vic marathon expired')!);
      const onPage = (page: string, n: number, fact: string) => ({
        row_num: n, source_markdown_slug: page, fact, entity_slug: ent, source: 'fence', valid_from: at('2026-03-01T00:00:00Z'),
      });
      await engine.insertFacts([onPage('memory/members/vic-example', 1, 'Vic marathon member note')], { source_id: SRC });
      await engine.insertFacts([onPage('memory/scope', 1, 'Vic marathon scope note')], { source_id: SRC });
      await engine.insertFacts([onPage('notes/vic', 1, 'Vic marathon on a notes page'), onPage('notes/vic', 2, 'Vic Berlin on a notes page')], { source_id: SRC });
      await remember(engine, 'people/other-example', [{ fact: 'Vic marathon on another entity' }]);
      const q = async (text: string, opts: Parameters<BrainEngine['findCandidateDuplicates']>[3] = {}) =>
        texts(await engine.findCandidateDuplicates(SRC, ent, text, { arm: 'keyword', k: 20, ...opts }));
      const full = await q('Vic Berlin marathon training');
      const k3 = await q('Vic Berlin marathon training', { k: 3 });
      const defaultK = texts(await engine.findCandidateDuplicates(SRC, ent, 'Vic Berlin marathon training', { arm: 'keyword' }));
      const byUser = await q('marathon', { attributedTo: 'user' });
      const byAssistant = await q('marathon', { attributedTo: 'assistant' });
      const noMembers = await q('marathon', { excludeMemberPages: true });
      const onlyPage = await q('marathon Berlin', { onlyPage: 'notes/vic' });
      const stemmed = await q('marathons trained');
      const punctuation = await q('BERLIN!!! — marathon?');
      const accented = await q('Zürich café');
      const unaccented = await q('zurich cafe');
      const noModel = await q('marathon', { embedding: basisEmbedding(0) });
      const otherEntity = texts(await engine.findCandidateDuplicates(SRC, 'people/nobody', 'marathon', { arm: 'keyword' }));
      expect(full).not.toContain('Vic marathon audit checkpoint');
      expect(full).not.toContain('Vic marathon expired');
      expect(full).not.toContain('Vic marathon lapsed');
      expect(full).not.toContain('Cooking notes with no shared words');
      expect(full).not.toContain('Vic marathon on another entity');
      expect(k3).toEqual(full.slice(0, 3));
      expect(defaultK).toEqual(full.slice(0, 5));
      expect(byUser).not.toContain('Vic marathon said by the assistant');
      expect(byAssistant).not.toContain('Vic marathon said by the user');
      expect(noMembers).not.toContain('Vic marathon member note');
      expect(noMembers).not.toContain('Vic marathon scope note');
      expect(sorted(onlyPage)).toEqual(['Vic Berlin on a notes page', 'Vic marathon on a notes page']);
      expect(stemmed).toContain('Vic trains for the Berlin marathon every spring');
      expect(accented).toEqual(['Vic visited a Zürich café']);
      expect(noModel).toEqual([]);
      expect(otherEntity).toEqual([]);
      return { full, k3, defaultK, byUser, byAssistant, noMembers, onlyPage, stemmed, punctuation, accented, unaccented, noModel, otherEntity };
    },
  );

  /** A 1536-wide vector: `head` in the first slots, zero elsewhere. */
  const vec = (...head: number[]) => {
    const v = new Float32Array(1536);
    head.forEach((x, i) => { v[i] = x; });
    return v;
  };
  const vectorView = (r: FactRow) => ({
    fact: r.fact,
    head: r.embedding ? Array.from(r.embedding.slice(0, 6)) : null,
    dims: r.embedding ? r.embedding.length : null,
    model: r.embedding_model ?? null,
    hash: r.embedded_text_hash ?? null,
    embedded: r.embedded_at instanceof Date,
  });
  const messageOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)));

  parityTest(
    'insertFact and insertFacts store a vector rounded to halfvec, with the model and text hash only when a model is named',
    { methods: ['insertFact', 'insertFacts', 'listFactsByEntity'] },
    async (engine) => {
      const ent = 'people/wren-example';
      await remember(engine, ent, [
        { fact: 'w-model', embedding: vec(0.1, 1 / 3, 0.7, 1e-5, 3e-8, -65519), embedding_model: 'm1' },
        { fact: 'w-no-model', embedding: vec(0.5, 0.25) },
        { fact: 'w-empty-model', embedding: vec(0.2), embedding_model: '' },
        { fact: 'w-model-no-vector', embedding_model: 'm1' },
        { fact: 'w-plain' },
      ]);
      await engine.insertFacts([
        { row_num: 1, source_markdown_slug: ent, fact: 'w-fence-model', entity_slug: ent, source: 'fence', embedding: vec(0.6, 0.8), embedding_model: 'm1' },
        { row_num: 2, source_markdown_slug: ent, fact: 'w-fence-no-model', entity_slug: ent, source: 'fence', embedding: vec(0.3) },
      ], { source_id: SRC });
      const rows = sorted((await engine.listFactsByEntity(SRC, ent, { limit: 50 })).map(vectorView), (r) => r.fact);
      const byFact = new Map(rows.map((r) => [r.fact, r]));
      expect(byFact.get('w-model')).toEqual({
        fact: 'w-model', head: [0.0999755859375, 0.333251953125, 0.7001953125, 0.000010013580322265625, 5.960464477539063e-8, -65504],
        dims: 1536, model: 'm1', hash: '91a02c860e5d683d07d5f56055e9fa8d', embedded: true,
      });
      expect(byFact.get('w-no-model')).toMatchObject({ model: null, hash: null, embedded: true, dims: 1536 });
      expect(byFact.get('w-empty-model')).toMatchObject({ model: '', hash: null, embedded: true });
      expect(byFact.get('w-model-no-vector')).toMatchObject({ head: null, model: null, hash: null, embedded: false });
      expect(byFact.get('w-plain')).toMatchObject({ head: null, model: null, hash: null, embedded: false });
      expect(byFact.get('w-fence-model')).toMatchObject({ model: 'm1', embedded: true });
      expect(byFact.get('w-fence-no-model')).toMatchObject({ model: null, hash: null, embedded: true });
      return rows;
    },
  );

  parityTest(
    'insertFact refuses a vector of the wrong width, a NaN, an empty vector and a value past the halfvec range',
    { methods: ['insertFact', 'insertFacts', 'listFactsByEntity'] },
    async (engine) => {
      const ent = 'people/xan-example';
      // Each input must be refused and leave no row. The refusal text names the type the engine cast the
      // literal to (Postgres casts to the column's halfvec, PGLite to vector: engine-sql/facts.ts), so it
      // is not compared.
      const refusedLeavingNoRow = async (attempt: Promise<unknown>) => {
        const refused = await attempt.then(() => false, () => true);
        const saved = (await engine.listFactsByEntity(SRC, ent)).length;
        return { refused, saved };
      };
      const one = (embedding: Float32Array) =>
        refusedLeavingNoRow(engine.insertFact({ fact: 'x-bad', entity_slug: ent, source: 'mcp:remember', embedding, embedding_model: 'm1' }, { source_id: SRC }));
      const narrow = await one(new Float32Array([0.1, 0.2, 0.3]));
      const nan = await one(vec(0.1, Number.NaN));
      const empty = await one(new Float32Array(0));
      const huge = await one(vec(70000));
      const big = await one(vec(1e6));
      const edge = await one(vec(65520));
      const batch = await refusedLeavingNoRow(engine.insertFacts(
        [{ row_num: 1, source_markdown_slug: ent, fact: 'x-fence', entity_slug: ent, source: 'fence', embedding: new Float32Array([1, 2]), embedding_model: 'm1' }],
        { source_id: SRC },
      ));
      const outcomes = { narrow, nan, empty, huge, big, edge, batch };
      for (const o of Object.values(outcomes)) expect(o).toEqual({ refused: true, saved: 0 });
      return outcomes;
    },
  );

  parityTest(
    'findCandidateDuplicates (embedding arm) orders by halfvec cosine distance and skips rows with no model, another model, another width or an audit source',
    { methods: ['insertFact', 'findCandidateDuplicates'] },
    async (engine) => {
      const ent = 'people/yara-example';
      await remember(engine, ent, [
        { fact: 'y-far', embedding: vec(0.1, 1 / 3, 0.7), embedding_model: 'm1' },
        { fact: 'y-near', embedding: vec(0.3, 0.25, 0.05), embedding_model: 'm1' },
        { fact: 'y-mid', embedding: vec(0.2, 0.5, 0.1), embedding_model: 'm1' },
        { fact: 'y-opposite', embedding: vec(-0.3, -0.2, -0.1), embedding_model: 'm1' },
        { fact: 'y-no-model', embedding: vec(0.3, 0.2, 0.1) },
        { fact: 'y-other-model', embedding: vec(0.3, 0.2, 0.1), embedding_model: 'm2' },
        { fact: 'y-audit', embedding: vec(0.3, 0.2, 0.1), embedding_model: 'm1', source: 'cli:extract-conversation-facts:terminal:v2' },
        { fact: 'y-said-by-assistant', embedding: vec(0.3, 0.2, 0.11), embedding_model: 'm1', attributed_to: 'assistant' },
        { fact: 'y-plain' },
      ]);
      const q = vec(0.3, 0.2, 0.1);
      const dup = (opts: Parameters<BrainEngine['findCandidateDuplicates']>[3]) =>
        engine.findCandidateDuplicates(SRC, ent, 'whatever', opts).then(texts);
      const all = await dup({ embedding: q, embeddingModel: 'm1', k: 20 });
      const top2 = await dup({ embedding: q, embeddingModel: 'm1', k: 2 });
      const byUser = await dup({ embedding: q, embeddingModel: 'm1', k: 20, attributedTo: 'user' });
      const otherModel = await dup({ embedding: q, embeddingModel: 'm2' });
      const narrow = await dup({ embedding: new Float32Array([0.3, 0.2, 0.1]), embeddingModel: 'm1' });
      const emptyModel = await dup({ embedding: q, embeddingModel: '' });
      const tooBig = await messageOf(dup({ embedding: vec(70000), embeddingModel: 'm1' }));
      expect(all).toEqual(['y-said-by-assistant', 'y-near', 'y-mid', 'y-far', 'y-opposite']);
      expect(top2).toEqual(['y-said-by-assistant', 'y-near']);
      expect(byUser).toEqual(['y-near', 'y-mid', 'y-far', 'y-opposite']);
      expect(otherModel).toEqual(['y-other-model']);
      expect(narrow).toEqual([]);
      expect(emptyModel).toEqual([]);
      expect(tooBig).not.toBe('ok');
      return { all, top2, byUser, otherModel, narrow, emptyModel, tooBig };
    },
  );

  parityTest(
    'findCandidateDuplicates (keyword arm) with an embedding keeps only rows whose vector is comparable, in keyword order',
    { methods: ['insertFact', 'findCandidateDuplicates'] },
    async (engine) => {
      const ent = 'people/zed-example';
      await remember(engine, ent, [
        { fact: 'Zed runs the harbor ferry', embedding: vec(1), embedding_model: 'm1' },
        { fact: 'Zed fixed the harbor ferry engine', embedding: vec(0, 1), embedding_model: 'm1' },
        { fact: 'Zed harbor ferry with another model', embedding: vec(1), embedding_model: 'm2' },
        { fact: 'Zed harbor ferry with no vector' },
        { fact: 'Zed harbor ferry with no model', embedding: vec(1) },
      ]);
      const kw = (opts: Parameters<BrainEngine['findCandidateDuplicates']>[3]) =>
        engine.findCandidateDuplicates(SRC, ent, 'harbor ferry', { arm: 'keyword', ...opts }).then(texts);
      const plain = await kw({});
      const m1 = await kw({ embedding: vec(0.5), embeddingModel: 'm1' });
      const m2 = await kw({ embedding: vec(0.5), embeddingModel: 'm2' });
      const narrow = await kw({ embedding: new Float32Array([1, 2]), embeddingModel: 'm1' });
      expect(plain).toHaveLength(5);
      expect(sorted(m1)).toEqual(['Zed fixed the harbor ferry engine', 'Zed runs the harbor ferry']);
      expect(m2).toEqual(['Zed harbor ferry with another model']);
      expect(narrow).toEqual([]);
      return { plain, m1, m2, narrow };
    },
  );

  parityTest(
    'findTrajectory returns a point\'s vector only when it comes from the brain\'s embedding model and the text is current',
    { methods: ['setConfig', 'insertFact', 'findTrajectory'] },
    async (engine) => {
      const ent = 'companies/willow-example';
      await engine.setConfig('embedding_model', 'm-traj');
      await remember(engine, ent, [
        { fact: 'ARR 1m', claim_metric: 'arr', claim_value: 1e6, valid_from: at('2026-01-01T00:00:00Z'), embedding: vec(0.1, 0.7), embedding_model: 'm-traj' },
        { fact: 'ARR 2m', claim_metric: 'arr', claim_value: 2e6, valid_from: at('2026-02-01T00:00:00Z'), embedding: vec(0.4), embedding_model: 'other' },
        { fact: 'ARR 3m', claim_metric: 'arr', claim_value: 3e6, valid_from: at('2026-03-01T00:00:00Z'), embedding: vec(0.4) },
        { fact: 'ARR 4m', claim_metric: 'arr', claim_value: 4e6, valid_from: at('2026-04-01T00:00:00Z') },
      ]);
      const points = (await engine.findTrajectory({ entitySlug: ent, remote: false })).map((p) => ({
        text: p.text, head: p.embedding ? Array.from(p.embedding.slice(0, 3)) : null, dims: p.embedding ? p.embedding.length : null,
      }));
      expect(points).toEqual([
        { text: 'ARR 1m', head: [0.0999755859375, 0.7001953125, 0], dims: 1536 },
        { text: 'ARR 2m', head: null, dims: null },
        { text: 'ARR 3m', head: null, dims: null },
        { text: 'ARR 4m', head: null, dims: null },
      ]);
      return points;
    },
  );

  parityTest(
    'excludePrivate hides facts whose provenance, entity or holding page the private-provenance policy hides',
    { methods: ['putPage', 'addLink', 'insertFacts', 'listFactsByEntity', 'listFactsSince', 'listFactsBySession'] },
    async (engine) => {
      await privacyFixture(engine);
      const since = at('2020-01-01T00:00:00Z');
      const all = sorted(texts(await engine.listFactsSince(SRC, since, { limit: 500 })));
      const kept = sorted(texts(await engine.listFactsSince(SRC, since, { limit: 500, excludePrivate: true })));
      const byEntity = sorted(texts(await engine.listFactsByEntity(SRC, PRIVACY_ENTITY, { limit: 500, excludePrivate: true })));
      const bySession = sorted(texts(await engine.listFactsBySession(SRC, 'sess-privacy', { limit: 500, excludePrivate: true })));
      const off = sorted(texts(await engine.listFactsByEntity(SRC, PRIVACY_ENTITY, { limit: 500, excludePrivate: false })));
      expect(all).toHaveLength(31);
      expect(kept).toEqual(sorted([
        'page:notes/open', 'page:notes/access-plain', 'page:notes/alias-with-visibility', 'page:atoms/origin-open',
        'page:concepts/open-input', 'page:concepts/plain', 'page:notes/lineage-open', 'page:events/chronicle-open',
        'page:events/plain', 'page:notes/no-page', 'entity:open',
      ]));
      expect(byEntity).toEqual(kept.filter((t) => t.startsWith('page:')));
      expect(bySession).toEqual(kept);
      return { all, kept, byEntity, bySession, off };
    },
  );

  parityTest(
    'listSupersessions and findTrajectory apply the private-provenance policy under excludePrivate',
    { methods: ['putPage', 'addLink', 'insertFacts', 'listSupersessions', 'findTrajectory'] },
    async (engine) => {
      await privacyFixture(engine);
      await engine.insertFacts([
        { fact: 'old:private', entity_slug: PRIVACY_ENTITY, source_markdown_slug: 'notes/private', row_num: 201, superseded_by_row: 202, kind: 'fact', source: 'fence' },
        { fact: 'new:private', entity_slug: PRIVACY_ENTITY, source_markdown_slug: 'notes/private', row_num: 202, kind: 'fact', source: 'fence' },
        { fact: 'old:open', entity_slug: PRIVACY_ENTITY, source_markdown_slug: 'notes/open', row_num: 203, superseded_by_row: 204, kind: 'fact', source: 'fence' },
        { fact: 'new:open', entity_slug: PRIVACY_ENTITY, source_markdown_slug: 'notes/open', row_num: 204, kind: 'fact', source: 'fence' },
      ] as never, { source_id: SRC });
      const supersessions = sorted(texts(await engine.listSupersessions(SRC)));
      const supersessionsKept = sorted(texts(await engine.listSupersessions(SRC, { excludePrivate: true })));
      const points = async (excludePrivate: boolean) =>
        sorted((await engine.findTrajectory({ entitySlug: PRIVACY_ENTITY, remote: false, excludePrivate })).map((p) => p.text));
      const trajectory = await points(false);
      const trajectoryKept = await points(true);
      expect(supersessionsKept).toEqual(['old:open']);
      expect(trajectoryKept.length).toBeLessThan(trajectory.length);
      expect(trajectoryKept).toContain('page:notes/open');
      expect(trajectoryKept).not.toContain('page:notes/private');
      return { supersessions, supersessionsKept, trajectory, trajectoryKept };
    },
  );

  parityTest(
    'excludePrivate follows the rename history to a private origin after a later rename drops the alias (#8920)',
    { methods: ['putPage', 'updateSlug', 'insertFacts', 'listFactsSince'] },
    async (engine) => {
      await putRenamePages(engine, [
        ['notes/origin', 'note', { visibility: 'private' }],
        ['notes/stand-in', 'note', {}],
        ['atoms/moved-origin', 'atom', { visibility: 'world', source_slug: 'notes/origin' }],
        ['atoms/open-origin', 'atom', { visibility: 'world', source_slug: 'notes/stand-in' }],
      ]);
      expect(await engine.updateSlug('notes/origin', 'notes/moved')).toBe(1);
      // A world page renamed onto the old slug drops the alias notes/origin -> notes/moved; only the
      // rename history still says the atom's origin moved to the private page.
      expect(await engine.updateSlug('notes/stand-in', 'notes/origin')).toBe(1);
      return renameFacts(engine, ['atoms/moved-origin', 'atoms/open-origin'], ['page:atoms/open-origin']);
    },
  );

  parityTest(
    'excludePrivate follows a slug alias from a renamed page to its restricted page',
    { methods: ['putPage', 'updateSlug', 'insertFacts', 'listFactsSince'] },
    async (engine) => {
      await putRenamePages(engine, [
        ['notes/b-old', 'note', { readable_by: ['alice-example'] }],
        ['notes/c-old', 'note', {}],
        ['atoms/aliased-origin', 'atom', { visibility: 'world', source_slug: 'notes/b-old' }],
        ['notes/aliased-lineage', 'note', { derived_from: 'notes/b-old' }],
        ['events/aliased-chronicle', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'notes/b-old' } }],
        ['atoms/open-alias', 'atom', { visibility: 'world', source_slug: 'notes/c-old' }],
      ]);
      expect(await engine.updateSlug('notes/b-old', 'notes/b-new')).toBe(1);
      expect(await engine.updateSlug('notes/c-old', 'notes/c-new')).toBe(1);
      // A new open page at the old slug: the alias, not the page now there, names the restricted page.
      await putRenamePages(engine, [['notes/b-old', 'note', {}]]);
      return renameFacts(
        engine,
        ['atoms/aliased-origin', 'notes/aliased-lineage', 'events/aliased-chronicle', 'atoms/open-alias', 'notes/b-old'],
        ['page:atoms/open-alias', 'page:notes/b-old'],
      );
    },
  );

  parityTest(
    'deletePages drops the aliases and rename history of a purged page, so excludePrivate stops following them',
    { methods: ['putPage', 'updateSlug', 'setPageAliases', 'resolveAliases', 'deletePages', 'insertFacts', 'listFactsSince'] },
    (engine) => purgedAliasCase(engine, () => engine.deletePages(['notes/p'], { sourceId: SRC })),
  );

  parityTest(
    'purgeDeletedPages drops the aliases and rename history of a purged page, so excludePrivate stops following them',
    { methods: ['putPage', 'updateSlug', 'setPageAliases', 'resolveAliases', 'softDeletePage', 'purgeDeletedPages', 'insertFacts', 'listFactsSince'] },
    (engine) => purgedAliasCase(engine, async () => {
      await engine.softDeletePage('notes/p');
      // purgeDeletedPages(0) takes tombstones strictly older than the statement clock; let the clock move past it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return (await engine.purgeDeletedPages(0)).slugs;
    }),
  );
});

// A purge drops the page aliases of a purged slug, the slug aliases that resolve to it and the rename rows that end at it
// (scrubPurgedSlugStores, src/core/persistence/purge-slug-stores.ts). A private page then created at the purged slug is
// no longer the origin of an atom that named the page's old slug; the same rows of a page not purged stay.
async function purgedAliasCase(engine: BrainEngine, purge: () => Promise<string[]>) {
  await putRenamePages(engine, [
    ['notes/old-p', 'note', { visibility: 'private' }],
    ['notes/old-q', 'note', { visibility: 'private' }],
    ['atoms/purged-origin', 'atom', { visibility: 'world', source_slug: 'notes/old-p' }],
    ['atoms/kept-origin', 'atom', { visibility: 'world', source_slug: 'notes/old-q' }],
  ]);
  expect(await engine.updateSlug('notes/old-p', 'notes/p')).toBe(1);
  expect(await engine.updateSlug('notes/old-q', 'notes/q')).toBe(1);
  await engine.setPageAliases('notes/p', SRC, ['purged alias']);
  await engine.setPageAliases('notes/q', SRC, ['kept alias']);
  const purged = await purge();
  expect(purged).toEqual(['notes/p']);
  await putRenamePages(engine, [['notes/p', 'note', { visibility: 'private' }]]);
  const flat = (m: Map<string, Array<{ slug: string; source_id: string }>>) =>
    Object.fromEntries([...m.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, sorted(v.map((r) => `${r.source_id}:${r.slug}`))]));
  const aliases = flat(await engine.resolveAliases(['purged alias', 'kept alias'], { sourceId: SRC }));
  expect(aliases).toEqual({ 'kept alias': ['default:notes/q'] });
  const facts = await renameFacts(engine, ['atoms/purged-origin', 'atoms/kept-origin'], ['page:atoms/purged-origin']);
  return { purged, aliases, ...facts };
}

async function putRenamePages(engine: BrainEngine, pages: Array<[string, string, Record<string, unknown>]>) {
  for (const [slug, type, frontmatter] of pages) {
    await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter });
  }
}

/** One fence row per holding page, then the rows `excludePrivate` keeps, which must be `expectKept`. */
async function renameFacts(engine: BrainEngine, holders: string[], expectKept: string[]) {
  await engine.insertFacts(holders.map((slug, i) => ({
    fact: `page:${slug}`, entity_slug: PRIVACY_ENTITY, source_markdown_slug: slug, row_num: i + 1, kind: 'fact',
    visibility: 'world', source: 'fence', valid_from: at('2026-03-01T00:00:00Z'),
  })) as never, { source_id: SRC });
  const since = at('2020-01-01T00:00:00Z');
  const all = sorted(texts(await engine.listFactsSince(SRC, since, { limit: 500 })));
  const kept = sorted(texts(await engine.listFactsSince(SRC, since, { limit: 500, excludePrivate: true })));
  expect(all).toEqual(sorted(holders.map((slug) => `page:${slug}`)));
  expect(kept).toEqual(sorted(expectKept));
  return { all, kept };
}
