/**
 * BrainEngine parity — the read members whose SQL applies a trust floor (`minTrust`) or flag suppression
 * (`suppressFlagged`) from the caller's read policy.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getContentFlagsByPageIds, getUnverifiedExtractionPageIds, getEffectiveDates, getSalienceScores,
 *    aliasCanonicalRefs, the keyword members (searchKeyword, searchKeywordChunks, countKeywordPages, searchKeywordPages,
 *    searchTitles), the link and graph reads (getBacklinkCounts, getAdjacencyBoosts, supersedingPageSlugs,
 *    relationalFanout, relationalChainHop, listLivePageSummaries, listPagesTitledIn), resolveFrozenHits, countWorldFacts, listFactsForRelevance, countUncomparableFacts and the fact list reads
 *    (listSupersessions, listFactsByEntity, listFactsSince, listFactsKeyset, listFactsBySession) drop a row below the floor
 *    (`trustFloorSql`) and, with suppression on, an agent-written-or-lower row with an instruction-family flag receipt
 *    (`activationSuppressedSql`), the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: hybrid search, whoknows and the entity card pass these options; an engine that ignores them ranks or
 *    counts rows the caller's policy hides, and one that refuses them stops those commands. Hot memory
 *    (facts/meta-hook.ts) reads listFactsBySession and listFactsSince with the caller's eligibility on every MCP call:
 *    an engine that refuses it stops the call, and one that ignores it puts a fact the policy hides in hot memory.
 *  - Why existing coverage misses it: the cases of these members pass no trust option, so an engine that drops the
 *    option or refuses it passes them.
 *  - Seam: none. Pages and facts are written in a transaction whose write trust settings declare the tier; receipts
 *    go through the typed write-gate members. Ids differ between arms, so rows are compared by slug or fact text.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageReadPolicy, SearchOpts } from '../../src/core/types.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk } from './chunk-fixtures.ts';
import { parseFindPattern } from '../../src/core/page-find.ts';

const { parityTest } = parityArms(testBackends());

/** Run `fn` in a transaction whose write trust settings declare `tier`; `null` writes with no declared tier. */
function declared<T>(engine: BrainEngine, tier: string | null, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  if (tier === null) return fn(engine);
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
    return fn(tx);
  });
}

/** Run `fn` in a transaction whose write trust settings declare `tier`, the owner's promotion to it and the write origin `origin`. */
function declaredOrigin<T>(engine: BrainEngine, tier: string, origin: Record<string, unknown>, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'], [tier, tier, JSON.stringify(origin)]);
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
  parityTest(
    'listSupersessions under a read eligibility drops a superseded fact below the floor, a flagged agent-written one and one from a quarantined page',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'upsertWriteGateReceipt', 'listSupersessions'] },
    async (engine) => {
      await engine.putPage('people/a-example', { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
      await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'held', timeline: '' });
      const facts: Array<{ fact: string; tier: string | null; flag?: string[] }> = [
        { fact: 'curated fact', tier: 'operator_curated' },
        { fact: 'observed fact', tier: 'tool_observed' },
        { fact: 'agent fact', tier: 'agent_written' },
        { fact: 'agent flagged fact', tier: 'agent_written', flag: ['exfiltration'] },
        { fact: 'agent other-flag fact', tier: 'agent_written', flag: ['other'] },
        { fact: 'unknown flagged fact', tier: null, flag: ['override'] },
        { fact: 'outside fact', tier: 'external_untrusted' },
      ];
      const supersede = async (id: number, i: number) => {
        await engine.insertFact({
          fact: `successor ${i}`, entity_slug: 'people/a-example', visibility: 'world', source: 'mcp:remember', embedding: null,
          valid_from: new Date(Date.UTC(2026, 5, 1 + i)),
        } as never, { source_id: 'default', supersedeId: id });
      };
      for (const [i, f] of facts.entries()) {
        const { id } = await declared(engine, f.tier, tx => tx.insertFact({
          fact: f.fact, entity_slug: 'people/a-example', visibility: 'world', source: 'mcp:remember', embedding: null,
          valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
        } as never, { source_id: 'default' }));
        if (f.flag) await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(id), source_id: 'default', ...receipt(f.flag) });
        await supersede(id, i);
      }
      // A curated fact whose provenance page is quarantined: only a read with an eligibility policy hides it.
      const { ids: [held = 0] } = await declared(engine, 'operator_curated', tx => tx.insertFacts([{
        fact: 'held page fact', entity_slug: 'people/a-example', source_markdown_slug: 'notes/held', row_num: 1, kind: 'fact',
        visibility: 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 4, 20)),
      }] as never, { source_id: 'default' }));
      await supersede(held, 20);
      await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'held', timeline: '', frontmatter: { quarantine: { reason: 'test' } } });
      const texts = async (opts?: Parameters<BrainEngine['listSupersessions']>[1]) =>
        sorted((await engine.listSupersessions('default', opts)).map(r => r.fact));
      const out: Record<string, unknown> = { none: await texts() };
      for (const [name, policy] of Object.entries(POLICIES)) {
        const floor = policy.minTrust || undefined;
        out[name] = await texts({ eligibility: { ...(floor ? { floor } : {}), ...(policy.suppressFlagged ? { suppressFlagged: true } : {}) } });
      }
      expect(out.none).toContain('held page fact');
      expect(out.scoped).not.toContain('held page fact');
      expect(out.agentSuppressed).toEqual(['agent fact', 'agent other-flag fact', 'curated fact', 'observed fact']);
      expect(out.confirmedOnly).toEqual([]);
      return out;
    },
  );
  parityTest(
    'the fact list reads under a read eligibility drop a fact below the floor, a flagged agent-written one and one from a quarantined page',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'upsertWriteGateReceipt',
      'listFactsByEntity', 'listFactsSince', 'listFactsKeyset', 'listFactsBySession'] },
    async (engine) => {
      await engine.putPage('people/a-example', { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
      await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'held', timeline: '' });
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
          source_session: 'session-a', valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
        } as never, { source_id: 'default' }));
        if (f.flag) await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(id), source_id: 'default', ...receipt(f.flag) });
      }
      // A curated fact whose provenance page is quarantined: only a read with an eligibility policy hides it.
      await declared(engine, 'operator_curated', tx => tx.insertFacts([{
        fact: 'held page fact', entity_slug: 'people/a-example', source_markdown_slug: 'notes/held', row_num: 1, kind: 'fact',
        visibility: 'world', source: 'fence', source_session: 'session-a', valid_from: new Date(Date.UTC(2026, 4, 20)),
      }] as never, { source_id: 'default' }));
      await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'held', timeline: '', frontmatter: { quarantine: { reason: 'test' } } });
      const read = async (eligibility?: NonNullable<Parameters<BrainEngine['listFactsByEntity']>[2]>['eligibility']) => {
        const opts = eligibility === undefined ? {} : { eligibility };
        const facts = (rows: Array<{ fact: string }>) => sorted(rows.map(r => r.fact));
        return {
          entity: facts(await engine.listFactsByEntity('default', 'people/a-example', opts)),
          since: facts(await engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), opts)),
          keyset: facts(await engine.listFactsKeyset('default', null, opts)),
          session: facts(await engine.listFactsBySession('default', 'session-a', opts)),
        };
      };
      const out: Record<string, Awaited<ReturnType<typeof read>>> = { none: await read(), plain: await read({}) };
      for (const [name, policy] of Object.entries(POLICIES)) {
        const floor = policy.minTrust || undefined;
        out[name] = await read({ ...(floor ? { floor } : {}), ...(policy.suppressFlagged ? { suppressFlagged: true } : {}) });
      }
      expect(out.none.entity).toContain('held page fact');
      for (const list of Object.values(out.plain)) expect(list).not.toContain('held page fact');
      for (const list of Object.values(out.agentSuppressed)) {
        expect(list).toEqual(['agent fact', 'agent other-flag fact', 'curated fact', 'observed fact']);
      }
      for (const list of Object.values(out.confirmedOnly)) expect(list).toEqual([]);
      return out;
    },
  );
  parityTest(
    'the four fact list reads under a read eligibility drop a fact below the floor, a flagged agent-written one and one from a quarantined page',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'upsertWriteGateReceipt',
      'listFactsByEntity', 'listFactsSince', 'listFactsKeyset', 'listFactsBySession'] },
    async (engine) => {
      await engine.putPage('people/a-example', { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
      await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'held', timeline: '' });
      const session = 'session-eligibility';
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
          source_session: session, valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
        } as never, { source_id: 'default' }));
        if (f.flag) await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(id), source_id: 'default', ...receipt(f.flag) });
      }
      // A curated fact whose provenance page is quarantined: only a read with an eligibility policy hides it.
      await declared(engine, 'operator_curated', tx => tx.insertFacts([{
        fact: 'held page fact', entity_slug: 'people/a-example', source_markdown_slug: 'notes/held', row_num: 1, kind: 'fact',
        visibility: 'world', source: 'fence', source_session: session, valid_from: new Date(Date.UTC(2026, 4, 20)),
      }] as never, { source_id: 'default' }));
      await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'held', timeline: '', frontmatter: { quarantine: { reason: 'test' } } });
      type Eligibility = NonNullable<Parameters<BrainEngine['listFactsSince']>[2]>['eligibility'];
      // The hot-memory call shape (facts/meta-hook.ts): active rows, world visibility, fingerprints.
      const shape = (eligibility: Eligibility) => ({ activeOnly: true, limit: 30, visibility: ['world' as const], fingerprint: true, ...(eligibility ? { eligibility } : {}) });
      const reads: Record<string, (e: Eligibility) => Promise<Array<{ fact: string }>>> = {
        byEntity: (e) => engine.listFactsByEntity('default', 'people/a-example', shape(e)),
        since: (e) => engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), shape(e)),
        keyset: (e) => engine.listFactsKeyset('default', null, shape(e)),
        bySession: (e) => engine.listFactsBySession('default', session, shape(e)),
      };
      const out: Record<string, Record<string, string[]>> = {};
      for (const [read, run] of Object.entries(reads)) {
        const texts = async (e: Eligibility) => sorted((await run(e)).map(r => r.fact));
        const byPolicy: Record<string, string[]> = { none: await texts(undefined) };
        for (const [name, policy] of Object.entries(POLICIES)) {
          const floor = policy.minTrust || undefined;
          byPolicy[name] = await texts({ ...(floor ? { floor } : {}), ...(policy.suppressFlagged ? { suppressFlagged: true } : {}) } as Eligibility);
        }
        expect(byPolicy.none).toContain('held page fact');
        expect(byPolicy.scoped).not.toContain('held page fact');
        expect(byPolicy.agentSuppressed).toEqual(['agent fact', 'agent other-flag fact', 'curated fact', 'observed fact']);
        expect(byPolicy.confirmedOnly).toEqual([]);
        out[read] = byPolicy;
      }
      for (const read of ['since', 'keyset', 'bySession']) expect(out[read]).toEqual(out.byEntity!);
      return out;
    },
  );
  parityTest(
    'the four fact list reads under each eligibility drop their facts, and the delta read policy with no floor still hides a quarantined page fact',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'upsertWriteGateReceipt', 'listFactsByEntity', 'listFactsSince', 'listFactsKeyset', 'listFactsBySession'] },
    async (engine) => {
      await engine.putPage('people/a-example', { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
      await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'held', timeline: '' });
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
          source_session: 's1', valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
        } as never, { source_id: 'default' }));
        if (f.flag) await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(id), source_id: 'default', ...receipt(f.flag) });
      }
      // A curated fact whose provenance page is quarantined: only a read with an eligibility policy hides it.
      await declared(engine, 'operator_curated', tx => tx.insertFacts([{
        fact: 'held page fact', entity_slug: 'people/a-example', source_markdown_slug: 'notes/held', row_num: 1, kind: 'fact',
        visibility: 'world', source: 'fence', source_session: 's1', valid_from: new Date(Date.UTC(2026, 4, 20)),
      }] as never, { source_id: 'default' }));
      await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'held', timeline: '', frontmatter: { quarantine: { reason: 'test' } } });
      const texts = (rows: Array<{ fact: string }>) => sorted(rows.map(r => r.fact));
      const reads = async (eligibility?: NonNullable<Parameters<BrainEngine['listFactsKeyset']>[2]>['eligibility']) => {
        const opts = eligibility ? { eligibility } : {};
        return {
          byEntity: texts(await engine.listFactsByEntity('default', 'people/a-example', opts)),
          since: texts(await engine.listFactsSince('default', new Date(Date.UTC(2020, 0, 1)), opts)),
          keyset: texts(await engine.listFactsKeyset('default', null, opts)),
          bySession: texts(await engine.listFactsBySession('default', 's1', opts)),
        };
      };
      const out: Record<string, Awaited<ReturnType<typeof reads>>> = { none: await reads() };
      for (const [name, policy] of Object.entries(POLICIES)) {
        const floor = policy.minTrust || undefined;
        out[name] = await reads({ ...(floor ? { floor } : {}), ...(policy.suppressFlagged ? { suppressFlagged: true } : {}) });
      }
      // The delta read passes a policy with no floor and no suppression: it still hides the quarantined page's fact.
      out.noFloor = await reads({ floor: undefined });
      for (const read of ['byEntity', 'since', 'keyset', 'bySession'] as const) {
        expect(out.none[read]).toContain('held page fact');
        expect(out.scoped[read]).not.toContain('held page fact');
        expect(out.noFloor[read]).not.toContain('held page fact');
        expect(out.agentSuppressed[read]).toEqual(['agent fact', 'agent other-flag fact', 'curated fact', 'observed fact']);
        expect(out.confirmedOnly[read]).toEqual([]);
      }
      return out;
    },
  );
  parityTest(
    'listSingleFactMetadata reads the stored trust tier, fence position and claim slot of the named facts of one source',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'listSingleFactMetadata'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'open', timeline: '' });
      const names = new Map<number, string>();
      const one = async (name: string, tier: string | null, extra: Record<string, unknown> = {}, source = 'default') => {
        const { id } = await declared(engine, tier, tx => tx.insertFact({
          fact: name, entity_slug: 'people/a-example', visibility: 'world', source: 'mcp:remember', embedding: null, ...extra,
        } as never, { source_id: source }));
        names.set(id, name);
        return id;
      };
      const curated = await one('curated', 'operator_curated', { claim_metric: 'arr', claim_value: 3, claim_unit: 'usd', claim_period: 'q3' });
      const agent = await one('agent', 'agent_written');
      const unknown = await one('unknown', null);
      const outside = await one('outside', 'external_untrusted');
      const elsewhere = await one('elsewhere', 'operator_curated', {}, 'other');
      const { ids: [fenced = 0] } = await declared(engine, 'tool_observed', tx => tx.insertFacts([{
        fact: 'fenced', entity_slug: 'people/a-example', source_markdown_slug: 'notes/open', row_num: 2, kind: 'fact',
        visibility: 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 4, 1)),
      }] as never, { source_id: 'default' }));
      names.set(fenced, 'fenced');
      const read = async (sourceId: string, ids: number[]) =>
        sorted((await engine.listSingleFactMetadata({ sourceId, ids, remoteFloor: false })).map(({ id, ...row }) => ({ ...row, id: names.get(Number(id)) ?? `?${id}` })), r => r.id);
      const all = await read('default', [curated, agent, unknown, outside, elsewhere, fenced, curated, 0, -1, fenced + 100_000]);
      const other = await read('other', [curated, elsewhere]);
      const empty = await read('default', []);
      expect(all.map(r => r.id)).toEqual(['agent', 'curated', 'fenced', 'outside', 'unknown']);
      expect(all.find(r => r.id === 'curated')).toMatchObject({ trust_tier: 'operator_curated', row_num: null, source_markdown_slug: null, claim_metric: 'arr', claim_unit: 'usd', claim_period: 'q3' });
      expect(all.find(r => r.id === 'fenced')).toMatchObject({ trust_tier: 'tool_observed', row_num: 2, source_markdown_slug: 'notes/open' });
      expect(all.find(r => r.id === 'unknown')?.trust_tier).toBe('unknown');
      expect(other.map(r => r.id)).toEqual(['elsewhere']);
      expect(empty).toEqual([]);
      return { all, other, empty };
    },
  );

  parityTest(
    'listUnpreviewedTrustFacts lists the user-confirmed trust-release fence facts with no field preview, joined to their newest released hold',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'expireFact', 'upsertWriteGateHold', 'decideWriteGateHold', 'listUnpreviewedTrustFacts'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('notes/conf', { type: 'note', title: 'Conf', compiled_truth: 'conf', timeline: '' });
      const facts = new Map<number, string>();
      const holds = new Map<number, string>();
      const fact = async (name: string, rowNum: number, tier: string, origin: Record<string, unknown>, slug = 'notes/conf') => {
        const { ids: [id = 0] } = await declaredOrigin(engine, tier, origin, tx => tx.insertFacts([{
          fact: name, entity_slug: 'people/a-example', source_markdown_slug: slug, row_num: rowNum, kind: 'fact',
          visibility: 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 4, rowNum)),
        }] as never, { source_id: 'default' }));
        facts.set(id, name);
        return id;
      };
      const hold = async (name: string, rowNum: unknown, requestId: string | null, status: 'released' | 'dropped' | 'held' = 'released', source = 'default', slug = 'notes/conf') => {
        const id = await engine.upsertWriteGateHold({
          kind: 'fact', source_id: source, slug, fingerprint: `fp-${name}`, detector_version: 1, tier: 'agent_written',
          reason_families: ['override'], reasons: ['override found'], detector_error: false,
          payload: { row_num: rowNum, fact: name }, write_origin: null, request_id: requestId,
        } as never);
        if (status !== 'held') await engine.decideWriteGateHold(id, status, 'owner');
        holds.set(id, name);
        return id;
      };
      const release = (request?: string, extra: Record<string, unknown> = {}) =>
        ({ channel: 'trust_release', ...(request === undefined ? {} : { request_id: request }), ...extra });
      await fact('plain', 1, 'user_confirmed', release('r1'));
      await hold('plain', 1, 'r1');
      await fact('previewed', 2, 'user_confirmed', release('r2', { fields_previewed: true }));
      await hold('previewed', 2, 'r2');
      await fact('text row', 3, 'user_confirmed', release('r3'));
      await hold('text row', '3', 'r3');
      await fact('only held', 4, 'user_confirmed', release('r4'));
      await hold('only held', 4, 'r4', 'held');
      await hold('only dropped', 4, 'r4', 'dropped');
      await fact('no request', 5, 'user_confirmed', release());
      await hold('no request', 5, null);
      await fact('other request', 6, 'user_confirmed', release('r6'));
      await hold('other request', 6, 'r-other');
      await fact('two holds', 7, 'user_confirmed', release('r7'));
      await hold('two holds old', 7, 'r7');
      await hold('two holds new', 7, 'r7');
      await fact('agent tier', 8, 'agent_written', release('r8'));
      await hold('agent tier', 8, 'r8');
      const expired = await fact('expired', 9, 'user_confirmed', release('r9'));
      await hold('expired', 9, 'r9');
      await engine.expireFact(expired);
      await fact('null preview', 10, 'user_confirmed', release('r10', { fields_previewed: null }));
      await hold('null preview', 10, 'r10');
      await fact('other channel', 11, 'user_confirmed', { channel: 'cli', request_id: 'r11' });
      await hold('other channel', 11, 'r11');
      await fact('other source hold', 12, 'user_confirmed', release('r12'));
      await hold('other source hold', 12, 'r12', 'released', 'other');
      await fact('fraction row', 13, 'user_confirmed', release('r13'));
      await hold('fraction row', 13.0, 'r13');
      await fact('wrong row', 14, 'user_confirmed', release('r14'));
      await hold('wrong row', 15, 'r14');
      const read = async (limit: number) => (await engine.listUnpreviewedTrustFacts(limit)).map(r => ({
        fact: facts.get(Number(r.id)) ?? `?${r.id}`, source_id: r.source_id, slug: r.slug, row_num: Number(r.row_num),
        hold: holds.get(Number(r.hold_id)) ?? `?${r.hold_id}`, total: Number(r.total),
      }));
      const wide = await read(50);
      const narrow = await read(2);
      const none = await read(0);
      expect(wide.map(r => r.fact)).toEqual(['plain', 'text row', 'no request', 'two holds', 'null preview', 'fraction row']);
      expect(wide.find(r => r.fact === 'two holds')?.hold).toBe('two holds new');
      expect(wide.every(r => r.total === 6)).toBe(true);
      expect(narrow.map(r => r.fact)).toEqual(['plain', 'text row']);
      expect(none).toEqual([]);
      return { wide, narrow, none };
    },
  );

  parityTest(
    'findPages under untrusted drops a page below the trust floor and a flagged agent-written page under suppression',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'sealChunks', 'upsertPageWriteGateReceipt', 'getPage', 'readPageTrustRows', 'findPages'] },
    async (engine) => {
      await seedPages(engine);
      expect(await tiers(engine)).toEqual(EXPECTED_TIERS);
      const out: Record<string, { total: number; rows: string[] }> = {};
      for (const [name, policy] of Object.entries(POLICIES)) {
        const untrusted = { excludePrivate: true, minTrust: policy.minTrust, suppressFlagged: policy.suppressFlagged };
        const found = await engine.findPages({ pattern: parseFindPattern('notes/'), limit: 50, untrusted, excludeSlugPrefixes: [] });
        out[name] = { total: found.total, rows: found.rows.map(r => `${r.source_id}:${r.slug}`) };
      }
      expect(out.agentSuppressed.rows)
        .toEqual(['default:notes/agent', 'default:notes/agent-other-flag', 'default:notes/curated', 'default:notes/observed']);
      expect(out.confirmedOnly.rows).toEqual([]);
      return out;
    },
  );
});
