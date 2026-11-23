/**
 * BrainEngine parity: link temporal state (engine-sql/link-temporal.ts), the
 * keyword index rebuild (engine-sql/search-vector.ts) and the retrieval
 * coverage counts (engine-sql/retrieval-coverage.ts), through the seven sites
 * that ran them as `engine.executeRaw`: link-relationships, link-temporal-apply,
 * link-relationship-notes, doctor edge_validity, mentions/referrers,
 * search/retrieval-coverage and reindex-search-vector. The pending, rebuild
 * and readiness reads have their own file, retrieval-coverage.test.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each site returns the same answer on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts): the relationship state a temporal link
 *    write leaves, the dated transitions a derived-link publication records
 *    (with each replacement option: a caller snapshot, the line-grammar
 *    generation, wanted pages, a prepared temporal body), manual transitions,
 *    relationship notes, the doctor's edge counts, referrer record metadata,
 *    the embedding-held count and the reindex result.
 *  - Regression: an engine whose temporal state drifts tells a different
 *    "now / ended" story on entity cards, a different doctor verdict, or a
 *    different referrer `since`; before this lane every site refused on Rust.
 *  - Why existing coverage misses it: test/link-temporal-*.test.ts run on
 *    PGLite only and never compare arms.
 *  - Seam: none. Typed members and the site functions only. Page ids are
 *    serial and engine-dependent, so every case maps ids back to slugs, and
 *    timestamps are replaced by their shape.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { LinkBatchInput } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import type { EdgeTemporalOpts } from '../../src/core/link-validity.ts';
import { DerivedLinkSettingsChangedError } from '../../src/core/derived-links.ts';
import { relationshipKeysForPages, refreshRelationships, staleRelationshipKeys, type RelationshipKey } from '../../src/core/link-relationships.ts';
import { applyTemporalEvidence, relationshipKeysForOrigin, removeManualTransitions, temporalBodyOf, writeManualTransitions } from '../../src/core/link-temporal-apply.ts';
import { loadRelationshipNotes, relationshipNoteKey } from '../../src/core/link-relationship-notes.ts';
import { edgeValidityStats } from '../../src/commands/doctor/checks/edge-validity.ts';
import { readPageStatusByRef, readRecordMetadata } from '../../src/core/mentions/referrers.ts';
import { countEmbeddingHeld, type CoverageRelevance } from '../../src/core/search/retrieval-coverage.ts';
import { runReindexSearchVector } from '../../src/commands/reindex-search-vector.ts';
import { LINK_EXTRACTION_GENERATION_KEY } from '../../src/core/line-grammar.ts';
import { resetFtsLanguageCache } from '../../src/core/fts-language.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { primeRelationSemantics } from '../../src/core/link-semantics-pack.ts';
import { setPackRelationSemantics } from '../../src/core/link-validity.ts';
import { EXAMPLE_PACK, useExamplePack } from '../helpers/amends-ranking-scenarios.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';

const { parityTest } = parityArms(testBackends());

const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const WIDGET = 'companies/widget-co';

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

const ALICE_BODY = [
  'Alice is CTO of [Acme](../companies/acme-example).',
  '',
  '## Timeline',
  '',
  '- **2019-02-01** | linkedin — Joined [Acme](../companies/acme-example) as CTO',
  '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)',
  '- **2025-03-02** | note — works at [Widget](../companies/widget-co)',
].join('\n');

async function seedCompanies(engine: BrainEngine): Promise<void> {
  await engine.putPage(ACME, page('Acme', { type: 'company' }));
  await engine.putPage(WIDGET, page('Widget', { type: 'company' }));
}

function worksAt(to: string, context: string): LinkBatchInput {
  return { from_slug: ALICE, to_slug: to, link_type: 'works_at', context, link_source: 'markdown', from_source_id: 'default', to_source_id: 'default' };
}

/** Alice's page, then her two works_at links published as derived links with the page's own temporal evidence. */
async function publishAlice(engine: BrainEngine, opts: Parameters<BrainEngine['replaceDerivedLinks']>[2] = {}, snapshotOption = false) {
  await seedCompanies(engine);
  await engine.putPage(ALICE, page('Alice', { type: 'person', compiled_truth: ALICE_BODY }));
  const snapshot = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
  const origin = { slug: ALICE, sourceId: 'default', expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation,
    ...(snapshotOption ? { snapshot } : {}) };
  const result = await engine.replaceDerivedLinks(origin, [worksAt(ACME, 'CTO of Acme'), worksAt(WIDGET, 'works at Widget')], opts);
  return { result, pageId: Number(snapshot.page.id), snapshot };
}

/** Page ids → slugs, so a key reads the same on every arm. */
async function slugsById(engine: BrainEngine, slugs: readonly string[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const slug of slugs) {
    const p = await engine.getPage(slug);
    if (p) out.set(Number(p.id), slug);
  }
  return out;
}

async function keyView(engine: BrainEngine, keys: readonly RelationshipKey[]) {
  const ids = await slugsById(engine, [ALICE, ACME, WIDGET]);
  return sorted(keys.map(k => `${ids.get(Number(k.from_page_id))}>${ids.get(Number(k.to_page_id))}:${k.link_type}`));
}

/** The relationship note rows with timestamps replaced by their shape. */
async function noteRows(engine: BrainEngine, excludePrivate = false) {
  const rows = await engine.listRelationshipNoteRows([{ slug: ALICE, source_id: 'default' }], { excludePrivate });
  return sorted(rows.map(r => {
    const out: Record<string, unknown> = {};
    // recorded_at / retired_at are the write's own clock: keep only whether each is set.
    for (const [k, v] of Object.entries(r)) out[k] = k === 'temporal_recorded_at' || k === 'temporal_retired_at' ? v != null : v instanceof Date ? v.toISOString().slice(0, 10) : v;
    return out;
  }), r => `${r.to_slug}\u0000${r.link_type}`);
}

async function notes(engine: BrainEngine, excludePrivate = false) {
  const map = await loadRelationshipNotes(engine, [{ slug: ALICE, source_id: 'default', summary: 'Alice summary.' }], { excludePrivate });
  return map.get(relationshipNoteKey('default', ALICE)) ?? null;
}

describe('engine parity: link temporal state', () => {
  parityTest(
    'link-relationships: a temporal addLink and removeLink refresh the relationship state; a reference link writes none',
    { methods: ['putPage', 'addLink', 'removeLink', 'listRelationshipNoteRows', 'readLinkRelationshipEvidence', 'writeLinkRelationshipState',
      'linkRelationshipKeysForPages', 'staleLinkRelationshipKeys'] },
    async (engine) => {
      await seedCompanies(engine);
      await engine.putPage(ALICE, page('Alice', { type: 'person' }));
      await engine.addLink(ALICE, ACME, 'works at Acme', 'works_at', 'manual');
      await engine.addLink(ALICE, WIDGET, 'mentions Widget', 'mentions', 'manual');
      const afterAdd = await noteRows(engine);
      const ids = [...(await slugsById(engine, [ALICE])).keys()];
      const keys = await relationshipKeysForPages(engine, ids);
      const stale = await staleRelationshipKeys(engine, 10);
      // A second refresh of the same keys changes nothing.
      const unchanged = await refreshRelationships(engine, keys);
      await engine.removeLink(ALICE, ACME, 'works_at');
      const afterRemove = await noteRows(engine);
      const keysAfter = await relationshipKeysForPages(engine, ids);
      expect(afterAdd.map(r => `${r.to_slug}:${r.link_type}`)).toEqual([`${ACME}:works_at`]);
      expect(unchanged).toBe(0);
      expect(afterRemove).toEqual([]);
      return { afterAdd, keys: await keyView(engine, keys), stale: stale.length, unchanged, afterRemove, keysAfter: await keyView(engine, keysAfter) };
    },
  );

  parityTest(
    'link-temporal-apply: replaceDerivedLinks records the origin\'s dated transitions and tense, and the note tells now and ended',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'linkRelationshipKeysForOrigin', 'listRelationshipNoteRows'] },
    async (engine) => {
      const { result, pageId } = await publishAlice(engine);
      const rows = await noteRows(engine);
      const note = await notes(engine);
      const keys = await keyView(engine, await relationshipKeysForOrigin(engine, pageId));
      expect(rows.map(r => `${r.to_slug}:${r.last_end}`)).toEqual([`${ACME}:2025-03-01`, `${WIDGET}:null`]);
      expect(note).toContain('now: works_at widget-co (since 2025-03-01)');
      // Publishing the same evidence again inserts nothing and changes no state.
      const snapshot = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
      const again = await engine.replaceDerivedLinks({ slug: ALICE, sourceId: 'default', expectedRevision: snapshot.revision,
        sourceIncarnation: snapshot.sourceIncarnation }, [worksAt(ACME, 'CTO of Acme'), worksAt(WIDGET, 'works at Widget')]);
      return { result, rows, note, keys, again, rowsAgain: await noteRows(engine) };
    },
  );

  parityTest(
    'link-temporal-apply: applyTemporalEvidence over plain links records the dated transitions, and a repeat changes no state',
    { methods: ['putPage', 'addLinksBatch', 'linkRelationshipKeysForOrigin', 'applyLinkTemporalRows', 'readLinkRelationshipEvidence',
      'writeLinkRelationshipState', 'listRelationshipNoteRows'] },
    async (engine) => {
      await seedCompanies(engine);
      const alice = await engine.putPage(ALICE, page('Alice', { type: 'person', compiled_truth: ALICE_BODY }));
      const rows = [worksAt(ACME, 'CTO of Acme'), worksAt(WIDGET, 'works at Widget')];
      await engine.addLinksBatch(rows);
      const keysBefore = await relationshipKeysForOrigin(engine, Number(alice.id));
      const first = await applyTemporalEvidence(engine, alice, rows, keysBefore);
      const second = await applyTemporalEvidence(engine, alice, rows, await relationshipKeysForOrigin(engine, Number(alice.id)));
      const body = await applyTemporalEvidence(engine, alice, rows, [], { inlineRanges: true, body: temporalBodyOf(alice) });
      expect(first.refreshed).toBeGreaterThan(0);
      expect(second.refreshed).toBe(0);
      return { first, second, body, rows: await noteRows(engine), note: await notes(engine) };
    },
  );

  // link_transitions.origin_page_id references pages(id): a transition whose origin page does not exist is refused
  // by the foreign key and nothing is written; a soft-deleted origin page still exists, so its transition is kept.
  parityTest(
    'link-temporal-apply: a transition is refused when its origin page does not exist, and kept when the origin is only soft-deleted',
    { methods: ['putPage', 'softDeletePage', 'applyLinkTemporalRows', 'linkRelationshipKeysForOrigin'] },
    async (engine) => {
      await seedCompanies(engine);
      const alice = await engine.putPage(ALICE, page('Alice', { type: 'person' }));
      const note = await engine.putPage('notes/origin-example', page('Origin'));
      await engine.softDeletePage('notes/origin-example');
      const missing = Number(alice.id) + Number(note.id) + 100000;
      const transition = { from_slug: ALICE, to_slug: ACME, link_type: 'works_at', kind: 'start' as const, occurred_on: '2020-01-01',
        date_precision: 'day', producer: 'explicit', line_hash: 'line-a' };
      const apply = (pageId: number) => engine.applyLinkTemporalRows({ pageId, sourceId: 'default', tenseRows: [], transitions: [transition], explicitTargets: [] })
        .then(r => ({ inserted: r.inserted.length }), (e: Error) => /link_transitions_origin_page_id_fkey/.test(e.message) ? 'origin_page_fk' : e.message);
      const refused = await apply(missing);
      const kept = await apply(Number(note.id));
      return {
        refused, kept,
        missingKeys: await keyView(engine, await engine.linkRelationshipKeysForOrigin(missing)),
        keptKeys: await keyView(engine, await engine.linkRelationshipKeysForOrigin(Number(note.id))),
      };
    },
  );

  parityTest(
    'link-temporal-apply: manual dated transitions write and remove the relationship\'s state',
    { methods: ['putPage', 'addLink', 'writeManualLinkTransitions', 'removeManualLinkTransitions', 'listRelationshipNoteRows'] },
    async (engine) => {
      await seedCompanies(engine);
      await engine.putPage(ALICE, page('Alice', { type: 'person' }));
      await engine.addLink(ALICE, ACME, 'advises Acme', 'advises', 'manual');
      const rel = { from: ALICE, to: ACME, linkType: 'advises', sourceId: 'default' };
      const written = await writeManualTransitions(engine, rel, { validFrom: '2020-01-01', validUntil: '2022-06-30' });
      const repeated = await writeManualTransitions(engine, rel, { validFrom: '2020-01-01' });
      const missing = await writeManualTransitions(engine, { ...rel, to: 'companies/no-such-page' }, { validFrom: '2020-01-01' });
      const dated = await noteRows(engine);
      const note = await notes(engine);
      await removeManualTransitions(engine, { from: ALICE, to: ACME, linkType: 'advises', sourceId: 'default', databaseOnly: true });
      const undated = await noteRows(engine);
      expect(written).toBe(2);
      expect(repeated).toBe(0);
      expect(missing).toBe(0);
      expect(dated[0]?.last_end).toBe('2022-06-30');
      return { written, repeated, missing, dated, note, undated };
    },
  );

  parityTest(
    'derived links: a caller snapshot, a matching line-grammar generation with inline ranges, and a prepared temporal body publish the same state',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'setConfig', 'listRelationshipNoteRows'] },
    async (engine) => {
      const generation = '2026-01-01T00:00:00.000Z';
      await engine.setConfig(LINK_EXTRACTION_GENERATION_KEY, generation);
      const lineGrammar = { enabled: true, allowUndeclaredTypes: false, effectiveRanges: true, generation };
      const temporalBody = temporalBodyOf({ compiled_truth: ALICE_BODY, timeline: '' });
      const { result } = await publishAlice(engine, { lineGrammar, temporalBody }, true);
      return { result, rows: await noteRows(engine), note: await notes(engine) };
    },
  );

  parityTest(
    'derived links: a line-grammar generation that moved since preparation refuses the publication and writes nothing',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'setConfig', 'getLinks', 'listRelationshipNoteRows'] },
    async (engine) => {
      await engine.setConfig(LINK_EXTRACTION_GENERATION_KEY, '2026-02-02T00:00:00.000Z');
      const lineGrammar = { enabled: true, allowUndeclaredTypes: false, effectiveRanges: false, generation: '2026-01-01T00:00:00.000Z' };
      let refused: string | null = null;
      try {
        await publishAlice(engine, { lineGrammar });
      } catch (e) {
        refused = e instanceof DerivedLinkSettingsChangedError ? e.code : String(e);
      }
      expect(refused).toBe(new DerivedLinkSettingsChangedError().code);
      return { refused, links: (await engine.getLinks(ALICE)).length, rows: await noteRows(engine) };
    },
  );

  parityTest(
    'derived links: the wanted pages of the origin are replaced with the publication',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'listWantedPages'] },
    async (engine) => {
      const wanted = {
        producers: ['body' as const],
        readAt: '2026-01-02T03:04:05.678Z',
        rows: [
          { producer: 'body' as const, ref_kind: 'slug' as const, target_source_id: 'default', target_ref: 'companies/future-co', link_type: 'works_at', context: 'joins Future\u0000Co' },
          { producer: 'body' as const, ref_kind: 'name' as const, target_source_id: 'default', target_ref: 'Gamma Example', link_type: '', context: 'met Gamma' },
          { producer: 'body' as const, ref_kind: 'slug' as const, target_source_id: 'no-such-source', target_ref: 'people/elsewhere', link_type: '', context: 'skipped' },
          { producer: 'frontmatter' as const, ref_kind: 'slug' as const, target_source_id: 'default', target_ref: 'people/not-owned', link_type: '', context: 'not this producer' },
        ],
      };
      const { result } = await publishAlice(engine, { wanted });
      const listed = await engine.listWantedPages({ limit: 50, offset: 0 });
      const view = listed.rows.map(r => ({ ...r, first_seen: typeof r.first_seen, last_checked: typeof r.last_checked }));
      expect(listed.total).toBe(2);
      return { result, total: listed.total, rows: sorted(view, r => JSON.stringify(r)) };
    },
  );

  parityTest(
    'link-relationship-notes: world-scope notes hide nothing when every origin is public, and an unknown subject has no note',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'listRelationshipNoteRows'] },
    async (engine) => {
      await publishAlice(engine);
      const all = await notes(engine, false);
      const world = await notes(engine, true);
      const none = await loadRelationshipNotes(engine, [{ slug: 'people/nobody', source_id: 'default' }], { excludePrivate: false });
      expect(world).toBe(all);
      return { all, world, worldRows: await noteRows(engine, true), none: [...none.entries()] };
    },
  );

  parityTest(
    'doctor edge_validity: counts by status, stale assertions and lagging keys',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'edgeValidityCounts', 'staleLinkRelationshipKeys', 'getConfig'] },
    async (engine) => {
      const empty = await edgeValidityStats(engine);
      await publishAlice(engine);
      const stats = await edgeValidityStats(engine);
      const scoped = await edgeValidityStats(engine, ['no-such-source']);
      expect(stats?.relationships).toEqual({ ended: 1, live: 1 });
      return { empty, stats, scoped };
    },
  );

  parityTest(
    'mentions/referrers: page status by ref and record metadata of referring pages',
    { methods: ['putPage', 'addLink', 'listPageStatusByRef', 'listRecordMetadataRows'] },
    async (engine) => {
      await engine.putPage('decisions/first', page('First', { frontmatter: { status: 'superseded' } }));
      await engine.putPage('decisions/second', page('Second', { frontmatter: { status: '  accepted  ' } }));
      await engine.putPage('decisions/third', page('Third', { frontmatter: { status: 42 } }));
      await engine.addLink('decisions/second', 'decisions/first', 'replaces first', 'supersedes', 'manual');
      await engine.addLink('decisions/third', 'decisions/second', 'amends second', 'amends', 'manual');
      const refs = ['decisions/first', 'decisions/second', 'decisions/third', 'decisions/none'].map(slug => ({ source_id: 'default', slug }));
      const status = [...(await readPageStatusByRef(engine, refs, { excludePrivate: false })).entries()].sort();
      const ids = await slugsById(engine, ['decisions/first', 'decisions/second', 'decisions/third']);
      const meta = await readRecordMetadata(engine, [...ids.keys()], { referrerSources: ['default'], excludePrivate: true });
      const metaView = sorted([...meta.entries()].map(([id, m]) => ({ slug: ids.get(id), ...m })), m => String(m.slug));
      const elsewhere = await readRecordMetadata(engine, [...ids.keys()], { referrerSources: ['other'], excludePrivate: false });
      expect(status).toEqual([['default:decisions/first', 'superseded'], ['default:decisions/second', 'accepted']]);
      return { status, meta: metaView, elsewhere: sorted([...elsewhere.values()].map(m => JSON.stringify(m))) };
    },
  );

  parityTest(
    'mentions/referrers: referrer group rows map pack aliases, cap each group and honor the caller scope',
    { methods: ['putPage', 'addLink', 'readReferrerGroupRows'] },
    async (engine) => {
      const on = (date: string, extra: Partial<PageInput> = {}): Partial<PageInput> =>
        ({ ...extra, effective_date: new Date(`${date}T00:00:00Z`), effective_date_source: 'date' });
      await engine.putPage('companies/acme-example', page('Acme', { type: 'company' }));
      await engine.putPage('meetings/standup', page('Standup', on('2026-02-01', { type: 'call' })));
      await engine.putPage('meetings/review', page('Review', on('2026-04-01', { type: 'meeting' })));
      await engine.putPage('notes/loose', page('Loose', on('2026-01-15', { type: '' as PageInput['type'] })));
      for (const n of [1, 2, 3]) await engine.putPage(`notes/n0${n}`, page(`N${n}`, on(`2026-01-0${n}`)));
      await engine.putPage('notes/secret', page('Secret', on('2026-05-01', { frontmatter: { visibility: 'private' } })));
      await engine.putPage('notes/held', page('Held', on('2026-05-02', { frontmatter: { quarantine: { reason: 'test' } } })));
      for (const from of ['meetings/standup', 'meetings/review', 'notes/loose', 'notes/n01', 'notes/n02', 'notes/n03', 'notes/secret', 'notes/held']) {
        await engine.addLink(from, 'companies/acme-example', 'mentions acme', 'mentions', 'manual');
      }
      const read = async (scope: { excludePrivate: boolean; includeQuarantined?: boolean; perGroup: number }) =>
        (await engine.readReferrerGroupRows({ sources: ['default'], slugs: ['companies/acme-example'] }, {
          referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], ...scope,
        })).map(({ id, ...r }) => ({ ...r, idType: typeof id }));
      const local = await read({ excludePrivate: false, perGroup: 2 });
      const remote = await read({ excludePrivate: true, perGroup: 10 });
      const quarantined = await read({ excludePrivate: false, includeQuarantined: true, perGroup: 1 });
      expect(local.map(r => `${r.canonical_type}:${r.slug}:${r.gtotal}`)).toEqual(
        ['meeting:meetings/review:2', 'meeting:meetings/standup:2', 'note:notes/secret:4', 'note:notes/n03:4', 'untyped:notes/loose:1']);
      expect(local[1]).toMatchObject({ type: 'call', canonical_type: 'meeting', d: '2026-02-01T00:00:00.000000Z', idType: 'number' });
      expect(remote.filter(r => r.canonical_type === 'note').map(r => r.slug)).toEqual(['notes/n03', 'notes/n02', 'notes/n01']);
      expect(quarantined.find(r => r.canonical_type === 'note')).toMatchObject({ slug: 'notes/held', gtotal: 5 });
      return { local, remote, quarantined };
    },
  );

  parityTest(
    'mentions/referrers: referrer page details bound the body, name the date source and keep soft-deleted pages',
    { methods: ['putPage', 'softDeletePage', 'readReferrerPageDetails'] },
    async (engine) => {
      await engine.putPage('notes/long', page('Long', { compiled_truth: 'é'.repeat(4100), frontmatter: { quarantine: { reason: 'test' } } }));
      await engine.putPage('notes/dated', page('Dated', { effective_date: new Date('2026-02-01T00:00:00Z'), effective_date_source: 'event_date' }));
      await engine.putPage('notes/undated', page('Undated'));
      await engine.putPage('notes/gone', page('Gone', { effective_date: new Date('2026-03-01T00:00:00Z'), effective_date_source: 'date' }));
      const ids = await slugsById(engine, ['notes/long', 'notes/dated', 'notes/undated', 'notes/gone']);
      await engine.softDeletePage('notes/gone');
      const rows = await engine.readReferrerPageDetails([...ids.keys(), 999999]);
      const view = sorted(rows.map(({ id, body, ...r }) => ({ slug: ids.get(id), chars: [...(body ?? '')].length, head: body?.slice(0, 12), ...r })),
        r => String(r.slug));
      expect(view.map(r => `${r.slug}:${r.date_source}:${r.chars}`)).toEqual(
        ['notes/dated:event_date:10', 'notes/gone:date:9', 'notes/long:updated_at:4000', 'notes/undated:updated_at:12']);
      expect(await engine.readReferrerPageDetails([])).toEqual([]);
      return view;
    },
  );

  parityTest(
    'mentions/referrers: batched referrer counts per target index exclude only that index\'s own pages and count record types',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'readReferrerTargetCounts'] },
    async (engine) => {
      await engine.putPage('companies/acme-example', page('Acme', { type: 'company' }));
      await engine.putPage('companies/acme-alt', page('Acme alt', { type: 'company' }));
      await engine.putPage('people/alice-example', page('Alice', { type: 'person' }));
      await engine.putPage('meetings/standup', page('Standup', { type: 'call' }));
      await engine.putPage('meetings/review', page('Review', { type: 'meeting' }));
      await engine.putPage('notes/n1', page('N1'));
      await engine.putPage('notes/secret', page('Secret', { frontmatter: { visibility: 'private' } }));
      await engine.putPage('notes/held', page('Held', { frontmatter: { quarantine: { reason: 'test' } } }));
      await engine.putPage('notes/gone', page('Gone'));
      const links: Array<[string, string]> = [
        ['meetings/standup', 'companies/acme-example'], ['meetings/review', 'companies/acme-example'],
        ['notes/n1', 'companies/acme-example'], ['notes/n1', 'companies/acme-alt'], ['notes/secret', 'companies/acme-example'],
        ['notes/held', 'companies/acme-example'], ['notes/gone', 'companies/acme-example'], ['people/alice-example', 'companies/acme-example'],
        ['companies/acme-alt', 'companies/acme-example'], ['companies/acme-example', 'people/alice-example'], ['meetings/review', 'people/alice-example'],
      ];
      for (const [from, to] of links) await engine.addLink(from, to, 'mentions', 'mentions', 'manual');
      await engine.softDeletePage('notes/gone');
      const target = { sources: ['default', 'default', 'default', 'default'],
        slugs: ['companies/acme-example', 'companies/acme-alt', 'people/alice-example', 'people/nobody-example'], indexes: [0, 0, 1, 2] };
      const read = async (scope: { excludePrivate: boolean; includeQuarantined?: boolean; recordTypes: string[] }) =>
        sorted((await engine.readReferrerTargetCounts(target, { referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], ...scope }))
          .map(r => `${r.i}:${r.canonical_type ?? '*'}:${r.n}:${typeof r.i}${typeof r.n}`));
      const local = await read({ excludePrivate: false, recordTypes: ['meeting', 'person'] });
      const remote = await read({ excludePrivate: true, recordTypes: ['meeting', 'person'] });
      const quarantined = await read({ excludePrivate: false, includeQuarantined: true, recordTypes: [] });
      expect(local).toEqual(['0:*:5:numbernumber', '0:meeting:2:numbernumber', '0:person:1:numbernumber', '1:*:2:numbernumber', '1:meeting:1:numbernumber']);
      expect(remote).toEqual(['0:*:4:numbernumber', '0:meeting:2:numbernumber', '0:person:1:numbernumber', '1:*:2:numbernumber', '1:meeting:1:numbernumber']);
      expect(quarantined).toEqual(['0:*:6:numbernumber', '1:*:2:numbernumber']);
      return { local, remote, quarantined };
    },
  );

  parityTest(
    'mentions/referrers and relationship notes under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'readPageSnapshot', 'replaceDerivedLinks', 'listPageStatusByRef', 'listRecordMetadataRows',
      'listRelationshipNoteRows'] },
    async (engine) => {
      await engine.putPage(ACME, page('Acme', { type: 'company', frontmatter: { readable_by: ['alice-example'] } }));
      await engine.putPage(WIDGET, page('Widget', { type: 'company', frontmatter: { visibility: 'private' } }));
      await engine.putPage(ALICE, page('Alice', { type: 'person', compiled_truth: ALICE_BODY }));
      const snapshot = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
      await engine.replaceDerivedLinks({ slug: ALICE, sourceId: 'default', expectedRevision: snapshot.revision,
        sourceIncarnation: snapshot.sourceIncarnation }, [worksAt(ACME, 'CTO of Acme'), worksAt(WIDGET, 'works at Widget')]);
      const decisions: Array<[string, Record<string, unknown>]> = [
        ['decisions/open', { status: 'accepted' }], ['decisions/readers', { status: 'superseded', readable_by: ['alice-example'] }],
        ['decisions/team', { status: 'accepted', readable_by: 'group:team-a' }], ['decisions/private', { status: 'accepted', visibility: 'private' }],
        ['decisions/bob', { status: 'accepted', readable_by: ['bob-example'] }],
      ];
      for (const [slug, frontmatter] of decisions) await engine.putPage(slug, page(slug, { frontmatter }));
      for (const [slug] of decisions.slice(1)) await engine.addLink(slug, 'decisions/open', `${slug} amends`, 'amends', 'manual');
      await engine.addLink('decisions/open', 'decisions/readers', 'replaces readers', 'supersedes', 'manual');
      const refs = decisions.map(([slug]) => ({ source_id: 'default', slug }));
      const ids = await slugsById(engine, decisions.map(([slug]) => slug));
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () => ({
        status: [...(await readPageStatusByRef(engine, refs, { excludePrivate: true })).entries()].sort(),
        meta: sorted([...(await readRecordMetadata(engine, [...ids.keys()], { referrerSources: ['default'], excludePrivate: true })).entries()]
          .map(([id, m]) => JSON.stringify({ slug: ids.get(id), ...m }))),
        notes: (await noteRows(engine, true)).map(r => `${r.to_slug}:${r.link_type}:${r.last_end}`),
      }));
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:carol-example'], hidePrivate: true });
      const statusSlugs = (rows: Array<[string, string]>) => rows.map(([key]) => key);
      expect(statusSlugs(stranger.status)).toEqual(['default:decisions/open']);
      expect(statusSlugs(member.status)).toEqual(['default:decisions/open', 'default:decisions/readers', 'default:decisions/team']);
      expect(statusSlugs(granted.status)).toEqual(['default:decisions/open', 'default:decisions/private', 'default:decisions/readers']);
      expect(stranger.notes).toEqual([]);
      expect(member.notes).toEqual([`${ACME}:works_at:2025-03-01`]);
      expect(granted.notes).toEqual([`${ACME}:works_at:2025-03-01`, `${WIDGET}:works_at:null`]);
      expect(member.meta).toContain(JSON.stringify({ slug: 'decisions/open', page_status: 'accepted', supersedes: [{ slug: 'decisions/readers' }] }));
      expect(stranger.meta).toContain(JSON.stringify({ slug: 'decisions/open', page_status: 'accepted' }));
      return { member, granted, stranger };
    },
  );

  parityTest(
    'relationship notes, evidence origins, page status and record metadata under excludePrivate hide an owner-only source, and under the closed form every page while one exists',
    { methods: ['putPage', 'addLink', 'linkRelationshipKeysForPages', 'readLinkRelationshipEvidence', 'listRelationshipNoteRows',
      'listPageStatusByRef', 'listRecordMetadataRows'] },
    async (engine, backend) => {
      await seedCompanies(engine);
      await engine.putPage(ALICE, page('Alice', { type: 'person' }));
      for (const slug of ['decisions/open', 'decisions/old']) await engine.putPage(slug, page(slug, { frontmatter: { status: 'accepted' } }));
      await engine.putPage('concepts/synthesis', page('Synthesis', { type: 'concept', frontmatter: { status: 'accepted' } }));
      await engine.addLink(ALICE, ACME, 'works at Acme', 'works_at', 'manual');
      await engine.addLink('decisions/open', 'decisions/old', 'replaces old', 'supersedes', 'manual');
      // An owner-only source: a company Alice works at, a person who works at Acme, a decision, and the concept's lineage input.
      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await engine.putPage('companies/chat-co', page('Chat Co', { type: 'company' }), { sourceId: 'chat' });
      await engine.putPage('people/chat-bob', page('Chat Bob', { type: 'person' }), { sourceId: 'chat' });
      await engine.putPage('decisions/chat', page('Chat decision', { frontmatter: { status: 'accepted' } }), { sourceId: 'chat' });
      await engine.addLink(ALICE, 'companies/chat-co', 'works at Chat Co', 'works_at', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'chat' });
      await engine.addLink('people/chat-bob', ACME, 'works at Acme', 'works_at', 'manual', undefined, undefined, { fromSourceId: 'chat', toSourceId: 'default' });
      await engine.addLink('decisions/open', 'decisions/chat', 'replaces chat', 'supersedes', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'chat' });
      await engine.addLink('concepts/synthesis', 'decisions/chat', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: 'default', toSourceId: 'chat' });
      const slugs = [ALICE, ACME, WIDGET, 'people/chat-bob', 'companies/chat-co', 'decisions/open', 'decisions/old', 'decisions/chat', 'concepts/synthesis'];
      const ids = new Map<number, string>();
      for (const slug of slugs) ids.set(Number((await engine.getPage(slug, { sourceId: slug.includes('chat') && !slug.startsWith('concepts') && slug !== 'decisions/open' ? 'chat' : 'default' }))!.id), slug);
      const refs = [['default', 'decisions/open'], ['default', 'decisions/old'], ['default', 'concepts/synthesis'], ['chat', 'decisions/chat']]
        .map(([source_id, slug]) => ({ source_id, slug }));
      const keys = await relationshipKeysForPages(engine, [...ids.keys()]);
      const read = async () => {
        const evidence = await engine.readLinkRelationshipEvidence(keys);
        return {
          notes: (await noteRows(engine, true)).map(r => `${r.to_slug}:${r.link_type}`),
          assertions: sorted(evidence.assertions.map(a => `${ids.get(Number(a.from_page_id))}>${ids.get(Number(a.to_page_id))}:${a.link_type}:${ids.get(Number(a.origin_id))}:${a.origin_public}`)),
          status: [...(await readPageStatusByRef(engine, refs, { excludePrivate: true })).entries()].sort(),
          meta: sorted([...(await readRecordMetadata(engine, [...ids.keys()], { referrerSources: ['default', 'chat'], excludePrivate: true })).entries()]
            .map(([id, m]) => JSON.stringify({ slug: ids.get(id), ...m }))),
        };
      };
      const unfiltered = {
        notes: (await noteRows(engine)).map(r => `${r.to_slug}:${r.link_type}`),
        status: (await readPageStatusByRef(engine, refs, { excludePrivate: false })).size,
      };
      const closed = await read();
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const fn = await withEngineScope(engine, read);
      expect(unfiltered).toEqual({ notes: ['companies/acme-example:works_at', 'companies/chat-co:works_at'], status: 4 });
      expect(closed.notes).toEqual([]);
      expect(closed.status).toEqual([]);
      expect(closed.assertions.every(a => a.endsWith(':false'))).toBe(true);
      expect(fn.notes).toEqual([`${ACME}:works_at`]);
      expect(fn.status).toEqual([['default:decisions/old', 'accepted'], ['default:decisions/open', 'accepted']]);
      expect(fn.assertions).toContain(`${ALICE}>${ACME}:works_at:${ALICE}:true`);
      expect(fn.assertions).toContain(`people/chat-bob>${ACME}:works_at:people/chat-bob:false`);
      expect(fn.meta).toContain(JSON.stringify({ slug: 'decisions/open', page_status: 'accepted', supersedes: [{ slug: 'decisions/old' }] }));
      return { unfiltered, closed, fn };
    },
  );

  parityTest(
    'listAmendmentsNotApplied under excludePrivate skips amending pages of an owner-only source, and under the closed form every amending page while one exists',
    { methods: ['setConfig', 'putPage', 'getPage', 'addLinksBatch', 'listAmendmentsNotApplied'] },
    async (engine, backend) => {
      const restorePack = useExamplePack();
      try {
        await engine.setConfig('schema_pack', EXAMPLE_PACK);
        await primeRelationSemantics(engine);
        await engine.putPage('vt/amended', { type: 'contract', title: 'Amended', compiled_truth: 'The agreement.', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
        const amend = async (slug: string, since: string, sourceId = 'default') => {
          const written = await engine.putPage(slug, { type: 'contract', title: slug, compiled_truth: 'An amendment.', timeline: '',
            frontmatter: { amends: [{ name: 'Amended', since }] } }, { sourceId });
          const rows: LinkBatchInput[] = [{ from_slug: slug, to_slug: 'vt/amended', link_type: 'amends', context: 'frontmatter.amends: Amended',
            link_source: 'frontmatter', origin_slug: slug, origin_field: 'amends', from_source_id: sourceId, to_source_id: 'default', origin_source_id: sourceId }];
          await engine.addLinksBatch(rows);
          await applyTemporalEvidence(engine, written, rows, await relationshipKeysForOrigin(engine, Number(written.id)));
        };
        await amend('vt/amend-open', '2026-03-01');
        const spec = async () => ({ pageId: (await engine.getPage('vt/amended', { sourceId: 'default' }))!.id,
          editionFrom: '2026-01-01', asOf: '2026-07-01', sourceIds: null, limit: 20 });
        const read = async (excludePrivate: boolean) =>
          (await engine.listAmendmentsNotApplied({ ...(await spec()), excludePrivate })).map(r => `${r.source_id}:${r.slug}:${r.since}`);
        const before = await read(true);
        // An owner-only source whose contract amends the default-source page.
        await createSource(engine, backend, 'chat', { kind: 'imessage' });
        await amend('vt/amend-chat', '2026-04-01', 'chat');
        const unfiltered = await read(false);
        const closed = await read(true);
        noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
        const fn = await withEngineScope(engine, () => read(true));
        expect(before).toEqual(['default:vt/amend-open:2026-03-01']);
        expect(unfiltered).toEqual(['chat:vt/amend-chat:null', 'default:vt/amend-open:2026-03-01']);
        expect(closed).toEqual([]);
        expect(fn).toEqual(['default:vt/amend-open:2026-03-01']);
        return { before, unfiltered, closed, fn };
      } finally { setPackRelationSemantics(new Map()); restorePack(); }
    },
  );

  const RELEVANCE: CoverageRelevance = { all: true, types: [], patterns: [], pageIds: [], exactTopPageId: null, imageArm: false };

  parityTest(
    'search/retrieval-coverage: no page is held from embedding, with and without an exact top hit',
    { methods: ['putPage', 'getPage', 'countEmbeddingHeldPages'] },
    async (engine) => {
      await engine.putPage(ALICE, page('Alice', { type: 'person' }));
      const alice = await engine.getPage(ALICE);
      const all = await countEmbeddingHeld(engine, {}, RELEVANCE);
      const top = await countEmbeddingHeld(engine, { excludePrivate: true }, { ...RELEVANCE, exactTopPageId: alice!.id });
      return { all, top };
    },
  );

  parityTest(
    'reindex-search-vector: a dry run and a consented run under english report the same counts',
    { methods: ['putPage', 'softDeletePage', 'countSearchVectorRows', 'replaceSearchVectorTriggerFunction', 'backfillSearchVectors',
      'ensureFactsKeywordIndex', 'getConfig', 'setConfig', 'unsetConfig'] },
    async (engine) => {
      return withEnv({ GBRAIN_FTS_LANGUAGE: undefined }, async () => {
        resetFtsLanguageCache();
        try {
          await engine.putPage(ALICE, page('Alice', { type: 'person' }));
          await engine.putPage(ACME, page('Acme', { type: 'company' }));
          await engine.putPage('notes/gone', page('Gone'));
          await engine.softDeletePage('notes/gone');
          const strip = ({ durationMs, ...rest }: Awaited<ReturnType<typeof runReindexSearchVector>>) => ({ ...rest, durationMs: typeof durationMs });
          const dry = strip(await runReindexSearchVector(engine, { dryRun: true, json: true }));
          const run = strip(await runReindexSearchVector(engine, { yes: true, json: true, args: ['--yes'] }));
          const marker = await engine.getConfig('search.fts_reindex_in_progress');
          expect(run.status).toBe('ok');
          return { dry, run, marker };
        } finally {
          resetFtsLanguageCache();
        }
      });
    },
  );

  parityTest(
    'relationalFanout with a temporal option walks only the edges whose relationship matches the status, day or window',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'relationalFanout'] },
    async (engine) => {
      await publishAlice(engine);
      const walk = async (seed: string, temporal?: EdgeTemporalOpts, excludePrivate = false) =>
        (await engine.relationalFanout([seed], { direction: 'in', ...(temporal ? { temporal } : {}), ...(excludePrivate ? { excludePrivate } : {}) }))
          .map(r => `${r.slug}:${r.via_link_types.join(',')}`);
      const out: Record<string, unknown> = {};
      const cases: Array<[string, EdgeTemporalOpts | undefined]> = [
        ['none', undefined],
        ['live', { status: 'live' }],
        ['ended', { status: 'ended' }],
        ['all', { status: 'all' }],
        ['disabled', { status: 'live', disabled: true }],
        ['asOf2020', { status: 'live', asOf: '2020-06-01' }],
        ['endedAsOf2020', { status: 'ended', asOf: '2020-06-01' }],
        ['endedAsOf2018', { status: 'ended', asOf: '2018-06-01' }],
        ['during2022', { during: { from: '2022-01-01', until: '2023-01-01' } }],
        ['during2026', { status: 'all', during: { from: '2026-01-01', until: '2027-01-01' } }],
      ];
      for (const seed of [ACME, WIDGET]) {
        for (const [name, temporal] of cases) {
          for (const excludePrivate of [false, true]) out[`${seed}:${name}:${excludePrivate}`] = await walk(seed, temporal, excludePrivate);
        }
      }
      expect(out[`${ACME}:none:false`]).toEqual([`${ALICE}:works_at`]);
      expect(out[`${ACME}:live:false`]).toEqual([]);
      expect(out[`${ACME}:ended:false`]).toEqual([`${ALICE}:works_at`]);
      expect(out[`${ACME}:asOf2020:false`]).toEqual([`${ALICE}:works_at`]);
      expect(out[`${ACME}:endedAsOf2018:false`]).toEqual([]);
      expect(out[`${ACME}:during2022:false`]).toEqual([`${ALICE}:works_at`]);
      expect(out[`${ACME}:during2026:false`]).toEqual([]);
      expect(out[`${WIDGET}:live:false`]).toEqual([`${ALICE}:works_at`]);
      expect(out[`${WIDGET}:ended:false`]).toEqual([]);
      expect(out[`${WIDGET}:during2022:false`]).toEqual([]);
      return out;
    },
  );

  parityTest(
    'relationalChainHop with a temporal option steps along and counts only the edges whose relationship matches the status, day or window',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'relationalChainHop'] },
    async (engine) => {
      await publishAlice(engine);
      const ids = await slugsById(engine, [ALICE, ACME, WIDGET]);
      const idOf = (slug: string) => [...ids].find(([, s]) => s === slug)![0];
      const hop = async (from: string, toward: 'object' | 'subject', temporal?: EdgeTemporalOpts, excludePrivate = false) =>
        (await engine.relationalChainHop([idOf(from)], {
          linkTypes: ['works_at'], toward, subjectTypes: ['person'], objectTypes: ['company'], degreeLinkTypes: ['works_at'], neighborCap: 10,
          ...(temporal ? { temporal } : {}), ...(excludePrivate ? { excludePrivate } : {}),
        })).map(e => `${ids.get(e.from_page_id)}>${e.to_slug}:${e.orientation}:degree=${e.from_degree}`);
      const out: Record<string, unknown> = {};
      const cases: Array<[string, EdgeTemporalOpts | undefined]> = [
        ['none', undefined],
        ['live', { status: 'live' }],
        ['ended', { status: 'ended' }],
        ['all', { status: 'all' }],
        ['disabled', { status: 'live', disabled: true }],
        ['asOf2020', { status: 'live', asOf: '2020-06-01' }],
        ['endedAsOf2018', { status: 'ended', asOf: '2018-06-01' }],
        ['during2022', { during: { from: '2022-01-01', until: '2023-01-01' } }],
        ['during2026', { status: 'all', during: { from: '2026-01-01', until: '2027-01-01' } }],
      ];
      for (const [from, toward] of [[ALICE, 'object'], [ACME, 'subject'], [WIDGET, 'subject']] as const) {
        for (const [name, temporal] of cases) {
          for (const excludePrivate of [false, true]) out[`${from}:${name}:${excludePrivate}`] = await hop(from, toward, temporal, excludePrivate);
        }
      }
      expect(out[`${ALICE}:none:false`]).toEqual([`${ALICE}>${ACME}:stored:degree=2`, `${ALICE}>${WIDGET}:stored:degree=2`]);
      expect(out[`${ALICE}:live:false`]).toEqual([`${ALICE}>${WIDGET}:stored:degree=1`]);
      expect(out[`${ALICE}:ended:false`]).toEqual([`${ALICE}>${ACME}:stored:degree=1`]);
      expect(out[`${ALICE}:asOf2020:false`]).toEqual([`${ALICE}>${ACME}:stored:degree=1`]);
      expect(out[`${ALICE}:during2026:true`]).toEqual([`${ALICE}>${WIDGET}:stored:degree=1`]);
      expect(out[`${ACME}:live:false`]).toEqual([]);
      expect(out[`${ACME}:ended:false`]).toEqual([`${ACME}>${ALICE}:stored:degree=1`]);
      expect(out[`${ACME}:endedAsOf2018:false`]).toEqual([]);
      expect(out[`${WIDGET}:live:true`]).toEqual([`${WIDGET}>${ALICE}:stored:degree=1`]);
      expect(out[`${WIDGET}:during2022:false`]).toEqual([]);
      // A date that is not a calendar day is the SQL engines' TypeError on every engine.
      let bad: unknown = null;
      try { await hop(ALICE, 'object', { status: 'live', asOf: '2020-13-45' }); } catch (e) { bad = e instanceof TypeError ? 'TypeError' : String(e); }
      expect(bad).toBe('TypeError');
      return out;
    },
  );

  // The bench attendance stage's read shape (GBrain-Evals N12): get_links and get_backlinks with only a slug, which read
  // with the default live relationship filter, a keyset page and a count of the hidden rows; then the same operations
  // with status and as_of over Alice's dated works_at links. The pages are written through engine members: the bench
  // writes them with put_page, whose automatic link preparation (src/core/persistence/links-preparation.ts) still reads
  // through executeRaw and stops on raw_sql on Rust before any link is read.
  parityTest(
    'get_links and get_backlinks with only a slug, status all and as_of answer the same on every engine',
    { methods: ['putPage', 'addLink', 'getLinks', 'getBacklinks', 'replaceDerivedLinks', 'readPageSnapshot'] },
    async (engine) => {
      const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
        logger: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as OperationContext;
      const op = async (name: string, p: Record<string, unknown>) => operations.find(o => o.name === name)!.handler(ctx, p);
      type Row = { from_slug?: string; to_slug?: string; link_type?: string; status?: string };
      const view = (rows: unknown) => sorted((rows as Row[]).map(l => `${l.from_slug}>${l.to_slug}:${l.link_type}:${l.status ?? '-'}`));
      await engine.putPage('people/bob-example', page('Bob Example', { type: 'person' }));
      await engine.putPage('meetings/2026-04-03', page('Weekly sync', { type: 'meeting' }));
      await engine.addLink('people/bob-example', 'meetings/2026-04-03', 'attended the weekly sync', 'attended', 'manual');
      await publishAlice(engine);
      const out = {
        meetingOut: view(await op('get_links', { slug: 'meetings/2026-04-03' })),
        meetingIn: view(await op('get_backlinks', { slug: 'meetings/2026-04-03' })),
        bobIn: view(await op('get_backlinks', { slug: 'people/bob-example' })),
        aliceLive: view(await op('get_links', { slug: ALICE })),
        aliceAll: view(await op('get_links', { slug: ALICE, status: 'all' })),
        alice2020: view(await op('get_links', { slug: ALICE, as_of: '2020-06-01' })),
        acmeIn: view(await op('get_backlinks', { slug: ACME, status: 'all' })),
      };
      // The bench reads the attendee's edge as a backlink of the meeting.
      expect(out.meetingIn).toEqual(['people/bob-example>meetings/2026-04-03:attended:-']);
      expect(out.aliceLive).toEqual([`${ALICE}>${WIDGET}:works_at:-`]);
      expect(out.aliceAll).toEqual([`${ALICE}>${ACME}:works_at:ended`, `${ALICE}>${WIDGET}:works_at:live`]);
      expect(out.alice2020).toEqual([`${ALICE}>${ACME}:works_at:live`]);
      return out;
    },
  );
});
