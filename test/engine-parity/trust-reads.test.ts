/**
 * BrainEngine parity — the read members whose SQL applies a trust floor (`minTrust`) or flag suppression
 * (`suppressFlagged`) from the caller's read policy.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getContentFlagsByPageIds, getUnverifiedExtractionPageIds, getEffectiveDates, getSalienceScores,
 *    aliasCanonicalRefs, the keyword members (searchKeyword, searchKeywordChunks, countKeywordPages, searchKeywordPages,
 *    searchTitles), the link and graph reads (getBacklinkCounts, getAdjacencyBoosts, supersedingPageSlugs,
 *    relationalFanout, relationalChainHop, listLivePageSummaries, listPagesTitledIn), resolveFrozenHits, countWorldFacts, listFactsForRelevance and countUncomparableFacts drop a row below the floor
 *    (`trustFloorSql`) and, with suppression on, an agent-written-or-lower row with an instruction-family flag receipt
 *    (`activationSuppressedSql`), the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: hybrid search, whoknows and the entity card pass these options; an engine that ignores them ranks or
 *    counts rows the caller's policy hides, and one that refuses them stops those commands.
 *  - Why existing coverage misses it: the cases of these members pass no trust option, so an engine that drops the
 *    option or refuses it passes them.
 *  - Seam: none. Pages and facts are written in a transaction whose write trust settings declare the tier; receipts
 *    go through the typed write-gate members. Ids differ between arms, so rows are compared by slug or fact text.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageReadPolicy, SearchOpts } from '../../src/core/types.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

/** Run `fn` in a transaction whose write trust settings declare `tier`; `null` writes with no declared tier. */
function declared<T>(engine: BrainEngine, tier: string | null, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  if (tier === null) return fn(engine);
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
    return fn(tx);
  });
}

const receipt = (families: string[]) => ({
  content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag' as const, reason_families: families,
  reasons: families.map(f => `${f} found`), detector_error: false, request_id: null,
});

/**
 * The pages: a tier each, with `null` for no declared tier (stamped `unknown`), and the flag families of a receipt on
 * the page. `override` and `credential` are instruction families; `other` is not.
 */
const PAGES: Array<{ slug: string; tier: string | null; flag?: string[] }> = [
  { slug: 'notes/curated', tier: 'operator_curated' },
  { slug: 'notes/observed', tier: 'tool_observed' },
  { slug: 'notes/agent', tier: 'agent_written' },
  { slug: 'notes/agent-flagged', tier: 'agent_written', flag: ['override'] },
  { slug: 'notes/agent-other-flag', tier: 'agent_written', flag: ['other'] },
  { slug: 'notes/unknown-flagged', tier: null, flag: ['credential'] },
  { slug: 'notes/outside', tier: 'external_untrusted' },
];

/** The policies every member is read under. */
const POLICIES: Record<string, PageReadPolicy> = {
  scoped: { sourceId: 'default' },
  emptyFloor: { minTrust: '' as never },
  curated: { minTrust: 'operator_curated' },
  agent: { minTrust: 'agent_written' },
  unknown: { minTrust: 'unknown' },
  any: { minTrust: 'external_untrusted' },
  confirmedOnly: { minTrust: 'user_confirmed' },
  suppressed: { suppressFlagged: true },
  agentSuppressed: { minTrust: 'agent_written', suppressFlagged: true },
};

/** Every page, written at its tier with a searchable chunk and the markers the page reads look for. */
async function seedPages(engine: BrainEngine): Promise<Map<number, string>> {
  const bySlug = new Map<number, string>();
  for (const p of PAGES) {
    const text = `glimmerwort ${p.slug.slice(6)} notes`;
    await declared(engine, p.tier, async (tx) => {
      await tx.putPage(p.slug, {
        type: 'note', title: `Glimmerwort ${p.slug.slice(6)}`, compiled_truth: text, timeline: '',
        frontmatter: { content_flag: { reason: 'stale', detail: p.slug }, status: 'unverified', provenance: 'auto-extracted', date: '2026-03-01' },
      });
      await tx.sealChunks(p.slug, [chunk(0, text)]);
    });
    if (p.flag) await engine.upsertPageWriteGateReceipt('default', p.slug, receipt(p.flag));
    const page = await engine.getPage(p.slug, { sourceId: 'default' });
    if (!page) throw new Error(`fixture page ${p.slug} is missing`);
    bySlug.set(page.id, p.slug);
  }
  return bySlug;
}

/** Each page's stored tier, so a seal that restamped a page fails the case instead of hiding in the counts. */
async function tiers(engine: BrainEngine): Promise<Record<string, string>> {
  const rows = await engine.readPageTrustRows({ keys: PAGES.map(p => ({ source_id: 'default', slug: p.slug })) });
  return Object.fromEntries(sorted(rows.map(r => [r.slug, r.trust_tier] as const), ([slug]) => slug));
}

const EXPECTED_TIERS = {
  'notes/agent': 'agent_written', 'notes/agent-flagged': 'agent_written', 'notes/agent-other-flag': 'agent_written',
  'notes/curated': 'operator_curated', 'notes/observed': 'tool_observed', 'notes/outside': 'external_untrusted',
  'notes/unknown-flagged': 'unknown',
};

describe('engine parity: trust floor and flag suppression on reads', () => {
  parityTest(
    'the page enrichment reads drop a page below the trust floor and a flagged agent-written page under suppression',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'sealChunks', 'upsertPageWriteGateReceipt', 'getPage', 'readPageTrustRows',
      'getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds', 'getEffectiveDates', 'getSalienceScores'] },
    async (engine) => {
      const bySlug = await seedPages(engine);
      expect(await tiers(engine)).toEqual(EXPECTED_TIERS);
      const ids = [...bySlug.keys()];
      const refs = PAGES.map(p => ({ slug: p.slug, source_id: 'default' }));
      const out: Record<string, unknown> = {};
      for (const [name, policy] of Object.entries(POLICIES)) {
        const flags = sorted([...(await engine.getContentFlagsByPageIds(ids, policy)).keys()].map(id => bySlug.get(id)!));
        const unverified = sorted([...(await engine.getUnverifiedExtractionPageIds(ids, policy)).keys()].map(id => bySlug.get(id)!));
        const dates = sorted([...(await engine.getEffectiveDates(refs, policy)).keys()]);
        const salience = sorted([...(await engine.getSalienceScores(refs, policy)).keys()]);
        expect(unverified).toEqual(flags);
        out[name] = { flags, dates, salience };
      }
      expect((out.agentSuppressed as { flags: string[] }).flags)
        .toEqual(['notes/agent', 'notes/agent-other-flag', 'notes/curated', 'notes/observed']);
      expect((out.confirmedOnly as { flags: string[] }).flags).toEqual([]);
      return out;
    },
  );

  parityTest(
    'the link and graph reads drop a page below the trust floor and a flagged agent-written page under suppression',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'sealChunks', 'upsertPageWriteGateReceipt', 'getPage', 'readPageTrustRows',
      'addLink', 'getBacklinkCounts', 'getAdjacencyBoosts', 'supersedingPageSlugs', 'relationalFanout', 'relationalChainHop',
      'listLivePageSummaries', 'listPagesTitledIn'] },
    async (engine) => {
      const bySlug = await seedPages(engine);
      expect(await tiers(engine)).toEqual(EXPECTED_TIERS);
      const hub = await declared(engine, 'operator_curated', tx =>
        tx.putPage('notes/hub', { type: 'note', title: 'Hub page', compiled_truth: 'hub', timeline: '' }));
      bySlug.set(hub.id, 'notes/hub');
      for (const p of PAGES) {
        await engine.addLink(p.slug, 'notes/hub', '', 'invested_in', 'manual');
        await engine.addLink('notes/hub', p.slug, '', 'supersedes', 'manual');
      }
      const ids = [...bySlug.keys()];
      const slugKeys = (m: Map<number, unknown>) => sorted([...m.keys()].map(id => bySlug.get(id)!));
      const titles = PAGES.map(p => `glimmerwort ${p.slug.slice(6)}`).join(' ') + ' hub page';
      const out: Record<string, unknown> = {};
      for (const [name, policy] of Object.entries(POLICIES)) {
        const backlinks = Object.fromEntries(sorted([...(await engine.getBacklinkCounts(ids, policy)).entries()]
          .map(([id, n]) => [bySlug.get(id)!, n] as const), ([slug]) => slug));
        const adjacency = Object.fromEntries(sorted([...(await engine.getAdjacencyBoosts(ids, policy)).entries()]
          .map(([id, row]) => [bySlug.get(id)!, row.hits] as const), ([slug]) => slug));
        const superseded = slugKeys(await engine.supersedingPageSlugs(ids, policy));
        const fanout = sorted((await engine.relationalFanout(['notes/hub'], { ...policy, direction: 'in', linkTypes: ['invested_in'] }))
          .map(r => r.slug));
        const chain = sorted((await engine.relationalChainHop([hub.id], {
          ...policy, linkTypes: ['invested_in'], toward: 'subject', subjectTypes: ['note'], objectTypes: ['note'],
          degreeLinkTypes: ['invested_in'], neighborCap: 100,
        })).map(e => e.to_slug));
        const live = sorted((await engine.listLivePageSummaries(policy)).map(r => r.slug));
        const titled = sorted((await engine.listPagesTitledIn(titles, policy)).map(r => r.slug));
        out[name] = { backlinks, adjacency, superseded, fanout, chain, live, titled };
      }
      const kept = ['notes/agent', 'notes/agent-other-flag', 'notes/curated', 'notes/observed'];
      const suppressed = out.agentSuppressed as { fanout: string[]; superseded: string[]; live: string[] };
      expect(suppressed.fanout).toEqual(kept);
      expect(suppressed.superseded).toEqual(kept);
      expect(suppressed.live).toEqual(sorted([...kept, 'notes/hub']));
      expect((out.confirmedOnly as { live: string[] }).live).toEqual([]);
      return out;
    },
  );

  parityTest(
    'resolveFrozenHits drops a hit on a page below the trust floor and on a flagged agent-written page under suppression',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'sealChunks', 'upsertPageWriteGateReceipt', 'getPage', 'readPageTrustRows',
      'resolveFrozenHits'] },
    async (engine) => {
      await seedPages(engine);
      expect(await tiers(engine)).toEqual(EXPECTED_TIERS);
      const hits = PAGES.map((p, ord) => ({ source_id: 'default', slug: p.slug, chunk_id: 0, ord }));
      const out: Record<string, string[]> = {};
      for (const [name, policy] of Object.entries(POLICIES)) {
        out[name] = sorted((await engine.resolveFrozenHits(hits, policy)).map(r => `${r.slug}:${r.chunk_text}`));
      }
      expect(sorted(out.agentSuppressed.map(r => r.split(':')[0])))
        .toEqual(['notes/agent', 'notes/agent-other-flag', 'notes/curated', 'notes/observed']);
      expect(out.confirmedOnly).toEqual([]);
      return out;
    },
  );

  parityTest(
    'aliasCanonicalRefs drops a canonical page below the trust floor and a flagged agent-written one under suppression',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'updateSlug', 'upsertPageWriteGateReceipt', 'aliasCanonicalRefs'] },
    async (engine) => {
      const renamed: Array<{ slug: string; tier: string | null; flag?: string[] }> = [
        { slug: 'concepts/curated', tier: 'operator_curated' },
        { slug: 'concepts/agent', tier: 'agent_written' },
        { slug: 'concepts/agent-flagged', tier: 'agent_written', flag: ['standing_instruction'] },
        { slug: 'concepts/outside', tier: 'external_untrusted' },
      ];
      for (const p of renamed) {
        await declared(engine, p.tier, async (tx) => {
          await tx.putPage(`${p.slug}-old`, { type: 'concept', title: p.slug, compiled_truth: p.slug, timeline: '' });
          await tx.updateSlug(`${p.slug}-old`, p.slug);
        });
        if (p.flag) await engine.upsertPageWriteGateReceipt('default', p.slug, receipt(p.flag));
      }
      const refs = renamed.map(p => ({ slug: p.slug, source_id: 'default' }));
      const out: Record<string, string[]> = {};
      for (const [name, policy] of Object.entries(POLICIES)) {
        out[name] = sorted((await engine.aliasCanonicalRefs(refs, policy)).map(r => r.canonical_slug));
      }
      expect(out.scoped).toEqual(['concepts/agent', 'concepts/agent-flagged', 'concepts/curated', 'concepts/outside']);
      expect(out.agentSuppressed).toEqual(['concepts/agent', 'concepts/curated']);
      return out;
    },
  );

  parityTest(
    'the keyword members drop a page below the trust floor and a flagged agent-written page under suppression',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'sealChunks', 'upsertPageWriteGateReceipt', 'getPage', 'readPageTrustRows',
      'searchKeyword', 'searchKeywordChunks', 'countKeywordPages', 'searchKeywordPages', 'searchTitles'] },
    async (engine) => {
      await seedPages(engine);
      expect(await tiers(engine)).toEqual(EXPECTED_TIERS);
      const out: Record<string, unknown> = {};
      for (const [name, policy] of Object.entries(POLICIES)) {
        const opts = { ...policy, limit: 20 } as SearchOpts;
        const slugs = (rows: Array<{ slug: string }>) => sorted([...new Set(rows.map(r => r.slug))]);
        const keyword = slugs(await engine.searchKeyword('glimmerwort', opts));
        out[name] = {
          keyword,
          chunks: slugs(await engine.searchKeywordChunks('glimmerwort', opts)),
          count: await engine.countKeywordPages('glimmerwort', policy as SearchOpts),
          pages: slugs(await engine.searchKeywordPages('glimmerwort', policy as SearchOpts, { limit: 20 })),
          titles: slugs(await engine.searchTitles('glimmerwort', opts)),
        };
      }
      expect((out.agentSuppressed as { keyword: string[] }).keyword)
        .toEqual(['notes/agent', 'notes/agent-other-flag', 'notes/curated', 'notes/observed']);
      expect((out.confirmedOnly as { count: number }).count).toBe(0);
      return out;
    },
  );

  parityTest(
    'countWorldFacts, listFactsForRelevance and countUncomparableFacts drop a fact below the floor and a flagged agent-written fact under suppression',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'upsertWriteGateReceipt',
      'countWorldFacts', 'listFactsForRelevance', 'countUncomparableFacts', 'findActiveSingleFact'] },
    async (engine) => {
      await engine.putPage('people/a-example', { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
      const facts: Array<{ fact: string; tier: string | null; flag?: string[] }> = [
        { fact: 'curated fact', tier: 'operator_curated' },
        { fact: 'observed fact', tier: 'tool_observed' },
        { fact: 'agent fact', tier: 'agent_written' },
        { fact: 'agent flagged fact', tier: 'agent_written', flag: ['exfiltration'] },
        { fact: 'agent other-flag fact', tier: 'agent_written', flag: ['other'] },
        { fact: 'unknown flagged fact', tier: null, flag: ['override'] },
        { fact: 'outside fact', tier: 'external_untrusted' },
      ];
      for (const [i, f] of facts.entries()) {
        const { id } = await declared(engine, f.tier, tx => tx.insertFact({
          fact: f.fact, entity_slug: 'people/a-example', visibility: 'world', source: 'mcp:remember', embedding: null,
          valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
        } as never, { source_id: 'default' }));
        if (f.flag) await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(id), source_id: 'default', ...receipt(f.flag) });
      }
      const out: Record<string, unknown> = {};
      for (const [name, policy] of Object.entries(POLICIES)) {
        const floor = policy.minTrust || undefined;
        const eligibility = { ...(floor ? { floor } : {}), ...(policy.suppressFlagged ? { suppressFlagged: true } : {}) };
        const scope = { sourceId: 'default', worldOnly: false, excludePrivate: false, minTrust: policy.minTrust, suppressFlagged: policy.suppressFlagged };
        const relevant = await engine.listFactsForRelevance({
          arm: 'entity', scope, vector: null, entity: { sourceId: 'default', slug: 'people/a-example' }, limit: 50,
        } as never);
        out[name] = {
          world: await engine.countWorldFacts({ sourceId: 'default', entitySlugs: ['people/a-example'], worldOnly: false, excludePrivate: false, eligibility } as never),
          relevant: sorted(relevant.map(r => r.fact)),
          uncomparable: await engine.countUncomparableFacts({ scope, dims: 1536, model: 'm1', declared: true } as never),
        };
      }
      // The single-fact duplicate check returns the stored row: its stamped tier and write origin, not a default.
      const stamped = await engine.findActiveSingleFact({ sourceId: 'default', entitySlug: 'people/a-example', visibility: 'world',
        fact: 'observed fact', attributedTo: null, pageSlug: null, remoteFloor: false });
      out.singleFact = { trust_tier: stamped?.trust_tier, write_origin: stamped?.write_origin };
      expect(out.singleFact).toEqual({ trust_tier: 'tool_observed', write_origin: { channel: 'tool_observed' } });
      expect((out.agentSuppressed as { relevant: string[] }).relevant)
        .toEqual(['agent fact', 'agent other-flag fact', 'curated fact', 'observed fact']);
      expect((out.confirmedOnly as { world: number }).world).toBe(0);
      return out;
    },
  );
});
