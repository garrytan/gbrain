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
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

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
});
