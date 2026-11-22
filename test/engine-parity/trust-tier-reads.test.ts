/**
 * BrainEngine parity — the typed reads of stamped trust tiers that core memory, the trust scan, belief history, page
 * history and the valid-time read made through `executeRaw` (src/core/engine-sql/trust-tier-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listCorePageRows lists the live `always_load` pages by source then slug under the source, exclude,
 *    privacy and eligibility options (quarantine, trust floor, flag suppression) with the withdrawn mark;
 *    listTrustScanRows and countUnscannedTrustRows read the rows of a table at a listed stored tier above a cursor;
 *    listVersionTrustTiers and listVersionReasonWriters read the snapshot tier of a version and the writer that replaced
 *    it; listValidTimeIdentities lists the live pages with a slug in the source scope by source; pickValidTimeEdition
 *    picks the edition in force on a date with its competing ordinals and counts; readBeliefHistoryRows and
 *    listVisibleBeliefLifetimes answer the same on PGLite and Postgres; pageAwaitsRederive says whether a purge hid the
 *    page for re-derivation, and `get_page` with `as_of` answers the same edition end to end; listPageRefsByIds names
 *    each listed page's source, slug and type by id, deleted pages included, for the GST-687 quoting reads. The Rust arm (GBRAIN_TEST_RUST_ARM=1) answers
 *    the page, fact, version and valid-time reads, refuses the belief reads, and stops typed where the pick would need a
 *    change reason or a history gap the store does not keep.
 *  - Regression: core memory, `gbrain doctor`'s trust scan, `get_versions` reasons and `get_page` with `as_of` call these
 *    members; an engine that drops an option shows a page the reader may not see or a row the scan should skip.
 *  - Why existing coverage misses it: the reads were raw SQL inside their callers, so no engine arm ran them as members.
 *  - Seam: none. Rows are written through typed members in transactions whose write trust settings declare the tier.
 *    Ids differ between arms, so rows are compared by slug, fact text or version label.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { VALID_TIME_CURRENT_ORD } from '../../src/core/engine-sql/trust-tier-reads.ts';
import { applyTemporalEvidence, relationshipKeysForOrigin } from '../../src/core/link-temporal-apply.ts';
import { primeRelationSemantics } from '../../src/core/link-semantics-pack.ts';
import { setPackRelationSemantics } from '../../src/core/link-validity.ts';
import { EXAMPLE_PACK, useExamplePack } from '../helpers/amends-ranking-scenarios.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { pageTypesById } from '../../src/core/search/transcript-quote.ts';
import { quoteTimelineRows } from '../../src/core/ops/timeline-quote.ts';

const { parityTest } = parityArms(testBackends());

/** Run `fn` in a transaction whose write trust settings declare `tier` and the owner's promotion to it; `null` writes with no declared tier. */
function declared<T>(engine: BrainEngine, tier: string | null, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  if (tier === null) return fn(engine);
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'], [tier, tier, JSON.stringify({ channel: tier })]);
    return fn(tx);
  });
}

const receipt = (families: string[]) => ({
  content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag' as const, reason_families: families,
  reasons: families.map(f => `${f} found`), detector_error: false, request_id: null,
});

/** The core pages: source, tier, extra frontmatter, a flag receipt, and whether the page is `always_load`. */
const CORE: Array<{ source: string; slug: string; tier: string | null; fm?: Record<string, unknown>; flag?: string[]; core?: false }> = [
  { source: 'default', slug: 'core/curated', tier: 'operator_curated' },
  { source: 'default', slug: 'core/agent', tier: 'agent_written' },
  { source: 'default', slug: 'core/agent-flagged', tier: 'agent_written', flag: ['override'] },
  { source: 'default', slug: 'core/unknown', tier: null },
  { source: 'default', slug: 'core/private', tier: 'operator_curated', fm: { visibility: 'private' } },
  { source: 'default', slug: 'core/quarantined', tier: 'operator_curated', fm: { quarantine: { reason: 'test' } } },
  { source: 'default', slug: 'core/withdrawn', tier: 'tool_observed' },
  { source: 'default', slug: 'notes/plain', tier: 'operator_curated', core: false },
  { source: 'default', slug: 'core/deleted', tier: 'operator_curated' },
  { source: 'other', slug: 'core/elsewhere', tier: 'tool_observed' },
];

async function seedCore(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  for (const p of CORE) {
    await declared(engine, p.tier, tx => tx.putPage(p.slug, {
      type: 'note', title: `T ${p.slug}`, compiled_truth: `body ${p.slug}`, timeline: '',
      frontmatter: { ...(p.core === false ? {} : { always_load: true }), ...(p.fm ?? {}) },
    }, { sourceId: p.source }));
    if (p.flag) await engine.upsertPageWriteGateReceipt(p.source, p.slug, receipt(p.flag));
  }
  await engine.softDeletePage('core/deleted', { sourceId: 'default' });
  await engine.insertFactWithdrawal('default', 'world', 'a claim', 'core/withdrawn', null);
}

describe('engine parity: typed trust tier reads', () => {
  parityTest(
    'listCorePageRows lists the live always_load pages by source and slug under the source, exclude, privacy and eligibility options',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'upsertPageWriteGateReceipt', 'softDeletePage', 'insertFactWithdrawal', 'listCorePageRows'] },
    async (engine, backend) => {
      await seedCore(engine, backend);
      const read = async (spec: Parameters<BrainEngine['listCorePageRows']>[0]) => (await engine.listCorePageRows(spec)).map(r => {
        const { id, ...rest } = r;
        expect(typeof id).toBe('number');
        return rest;
      });
      const slugs = (rows: Array<{ source_id: string; slug: string }>) => rows.map(r => `${r.source_id}:${r.slug}`);
      const all = await read({ limit: 50 });
      const scoped = await read({ sourceIds: ['other'], limit: 50 });
      const excluded = await read({ sourceIds: ['default'], exclude: { sourceId: 'default', slug: 'core/agent' }, limit: 50 });
      const floor = await read({ excludePrivate: true, limit: 50 });
      const caller = await read({ excludePrivate: true, forCaller: true, limit: 50 });
      const agent = await read({ eligibility: { floor: 'agent_written' }, limit: 50 });
      const curated = await read({ eligibility: { floor: 'operator_curated' }, limit: 50 });
      const suppressed = await read({ eligibility: { suppressFlagged: true }, limit: 50 });
      const plainEligible = await read({ eligibility: {}, limit: 50 });
      const narrow = await read({ limit: 2 });
      expect(slugs(all)).toEqual(['default:core/agent', 'default:core/agent-flagged', 'default:core/curated', 'default:core/private',
        'default:core/quarantined', 'default:core/unknown', 'default:core/withdrawn', 'other:core/elsewhere']);
      expect(all.find(r => r.slug === 'core/withdrawn')?.withdrawn).toBe(true);
      expect(all.filter(r => r.withdrawn).length).toBe(1);
      expect(all[0]).toMatchObject({ title: 'T core/agent', compiled_truth: 'body core/agent', segmented: false, body_bytes: null });
      expect(all[0]?.frontmatter).toMatchObject({ always_load: true });
      expect('trust_tier' in all[0]!).toBe(false);
      expect(slugs(scoped)).toEqual(['other:core/elsewhere']);
      expect(slugs(excluded)).not.toContain('default:core/agent');
      expect(slugs(floor)).not.toContain('default:core/private');
      expect(slugs(caller)).not.toContain('default:core/private');
      expect(slugs(agent)).toEqual(['default:core/agent', 'default:core/agent-flagged', 'default:core/curated', 'default:core/private',
        'default:core/withdrawn', 'other:core/elsewhere']);
      expect(slugs(curated)).toEqual(['default:core/curated', 'default:core/private']);
      expect(agent.find(r => r.slug === 'core/curated')).toMatchObject({ trust_tier: 'operator_curated', write_origin: { channel: 'operator_curated' }, suppressed: false });
      expect(suppressed.find(r => r.slug === 'core/agent-flagged')?.suppressed).toBe(true);
      expect(suppressed.filter(r => r.suppressed).map(r => r.slug)).toEqual(['core/agent-flagged']);
      expect(plainEligible.every(r => r.suppressed === false)).toBe(true);
      expect(plainEligible.find(r => r.slug === 'core/unknown')).toMatchObject({ trust_tier: 'unknown', write_origin: null });
      expect(slugs(narrow)).toEqual(['default:core/agent', 'default:core/agent-flagged']);
      return { all, scoped, excluded, floor, caller, agent, curated, suppressed, plainEligible, narrow };
    },
  );

  parityTest(
    'listCorePageRows under excludePrivate drops the pages of an owner-only source: every page while one exists with no schema version, only that source\'s and its concept lineage under the function form',
    { methods: ['putPage', 'addLink', 'listCorePageRows'] },
    async (engine, backend) => {
      const core = (slug: string, type: 'note' | 'concept', sourceId: string) =>
        engine.putPage(slug, { type, title: `T ${slug}`, compiled_truth: `body ${slug}`, timeline: '', frontmatter: { always_load: true } }, { sourceId });
      const reads = async () => {
        const slugs = async (spec: Parameters<BrainEngine['listCorePageRows']>[0]) =>
          (await engine.listCorePageRows(spec)).map(r => `${r.source_id}:${r.slug}`);
        return {
          floor: await slugs({ excludePrivate: true, limit: 50 }),
          caller: await slugs({ excludePrivate: true, forCaller: true, limit: 50 }),
          unfiltered: await slugs({ limit: 50 }),
        };
      };
      await createSource(engine, backend, 'work');
      await core('core/open', 'note', 'default');
      await core('core/from-chat', 'concept', 'default');
      await core('core/work', 'note', 'work');
      // Before any owner-only source exists every page is listed: the case is not vacuous.
      const before = await reads();
      const all = ['default:core/from-chat', 'default:core/open', 'work:core/work'];
      expect(before).toEqual({ floor: all, caller: all, unfiltered: all });

      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await createSource(engine, backend, 'vault', { owner_only: true });
      await core('core/chat', 'note', 'chat');
      await core('core/vault', 'note', 'vault');
      await engine.addLink('core/from-chat', 'core/chat', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'chat' });

      // No schema version in context: while an owner-only source exists the non-owner policy hides every page.
      const closed = await reads();
      expect(closed).toEqual({
        floor: [], caller: [],
        unfiltered: ['chat:core/chat', ...all.slice(0, 2), 'vault:core/vault', 'work:core/work'],
      });

      // Schema version 320 or later: only the owner-only sources' pages, and the concept synthesized from one, are hidden.
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const fn = await withEngineScope(engine, reads);
      const open = ['default:core/open', 'work:core/work'];
      expect(fn).toEqual({ floor: open, caller: open, unfiltered: closed.unfiltered });
      return { before, closed, fn };
    },
  );

  parityTest(
    'listTrustScanRows and countUnscannedTrustRows read the pages and facts at a listed stored tier above a cursor, by id',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'softDeletePage', 'insertFacts', 'getPage', 'listTrustScanRows', 'countUnscannedTrustRows'] },
    async (engine) => {
      const pageIds = new Map<number, string>();
      for (const [slug, tier] of [['scan/a', 'agent_written'], ['scan/b', 'operator_curated'], ['scan/c', null], ['scan/d', 'external_untrusted'], ['scan/e', 'agent_written']] as const) {
        await declared(engine, tier, tx => tx.putPage(slug, { type: 'note', title: `T ${slug}`, compiled_truth: `ct ${slug}`, timeline: `tl ${slug}`, frontmatter: { k: slug } }));
        pageIds.set((await engine.getPage(slug, { sourceId: 'default' }))!.id, slug);
      }
      await engine.softDeletePage('scan/e', { sourceId: 'default' });
      // The fence page of the facts is curated, so the pages scan does not read it.
      await declared(engine, 'operator_curated', tx => tx.putPage('scan/fence', { type: 'note', title: 'Fence', compiled_truth: 'fence', timeline: '' }));
      const factIds = new Map<number, string>();
      const FACTS = [['f one', 'agent_written'], ['f two', 'operator_curated'], ['f three', 'external_untrusted'], ['f four', null]] as const;
      for (const [i, [fact, tier]] of FACTS.entries()) {
        const { ids: [id = 0] } = await declared(engine, tier, tx => tx.insertFacts([{
          fact, entity_slug: 'people/a-example', kind: 'fact', visibility: 'world', source: 'cli', context: `ctx ${fact}`,
          valid_from: new Date(Date.UTC(2026, 0, 1)), row_num: i + 1, source_markdown_slug: 'scan/fence',
        }] as never, { source_id: 'default' }));
        factIds.set(Number(id), fact);
      }
      const tiers = ['agent_written', 'external_untrusted', 'unknown'];
      const label = (table: 'pages' | 'facts', id: number) => (table === 'pages' ? pageIds : factIds).get(id) ?? `?${id}`;
      const scan = async (table: 'pages' | 'facts', afterId: number, limit: number) => (await engine.listTrustScanRows({ table, afterId, limit, tiers }))
        .map(({ id, ...rest }) => ({ row: label(table, id), ...rest }));
      const idOf = (m: Map<number, string>, name: string) => [...m].find(([, v]) => v === name)![0];
      const pages = await scan('pages', 0, 50);
      const pagesAfter = await scan('pages', idOf(pageIds, 'scan/a'), 50);
      const pagesNarrow = await scan('pages', 0, 1);
      const facts = await scan('facts', 0, 50);
      const factsAfter = await scan('facts', idOf(factIds, 'f one'), 1);
      const none = await engine.listTrustScanRows({ table: 'pages', afterId: 0, limit: 50, tiers: [] });
      const count = (table: 'pages' | 'facts', afterId: number, until: number | null) => engine.countUnscannedTrustRows({ table, afterId, until, tiers });
      const counts = {
        pages: await count('pages', 0, null),
        pagesAfter: await count('pages', idOf(pageIds, 'scan/a'), null),
        pagesUntil: await count('pages', 0, idOf(pageIds, 'scan/c')),
        facts: await count('facts', 0, null),
        factsUntil: await count('facts', idOf(factIds, 'f one'), idOf(factIds, 'f three')),
      };
      expect(pages.map(r => r.row)).toEqual(['scan/a', 'scan/c', 'scan/d']);
      expect(pages[0] as unknown).toEqual({ row: 'scan/a', source_id: 'default', trust_tier: 'agent_written', write_origin: { channel: 'agent_written' },
        title: 'T scan/a', compiled_truth: 'ct scan/a', timeline: 'tl scan/a', frontmatter: expect.objectContaining({ k: 'scan/a' }) });
      expect(pages[1]).toMatchObject({ row: 'scan/c', trust_tier: 'unknown', write_origin: null });
      expect(pagesAfter.map(r => r.row)).toEqual(['scan/c', 'scan/d']);
      expect(pagesNarrow.map(r => r.row)).toEqual(['scan/a']);
      expect(facts.map(r => r.row)).toEqual(['f one', 'f three', 'f four']);
      expect(facts[0] as unknown).toEqual({ row: 'f one', source_id: 'default', trust_tier: 'agent_written', write_origin: { channel: 'agent_written' },
        fact: 'f one', context: 'ctx f one', value: null, source: 'cli' });
      expect(factsAfter.map(r => r.row)).toEqual(['f three']);
      expect(none).toEqual([]);
      expect(counts).toEqual({ pages: 3, pagesAfter: 2, pagesUntil: 2, facts: 3, factsUntil: 1 });
      // Normalise the pages' frontmatter to the seeded key, as the stores add their own keys.
      const norm = (rows: Array<Record<string, unknown>>) => rows.map(r => ('frontmatter' in r ? { ...r, frontmatter: (r.frontmatter as Record<string, unknown>).k } : r));
      return { pages: norm(pages), pagesAfter: norm(pagesAfter), pagesNarrow: norm(pagesNarrow), facts, factsAfter, none, counts };
    },
  );

  parityTest(
    'listTrustScanRows and countUnscannedTrustRows read the takes and timeline entries at a listed stored tier',
    { methods: ['putPage', 'listTrustScanRows', 'countUnscannedTrustRows'] },
    async (engine) => {
      await engine.putPage('scan/holder', { type: 'note', title: 'Holder', compiled_truth: 'h', timeline: '' });
      const tiers = ['agent_written', 'unknown'];
      const takes = await engine.listTrustScanRows({ table: 'takes', afterId: 0, limit: 10, tiers });
      const timeline = await engine.listTrustScanRows({ table: 'timeline_entries', afterId: 0, limit: 10, tiers });
      const counts = [await engine.countUnscannedTrustRows({ table: 'takes', afterId: 0, until: null, tiers }),
        await engine.countUnscannedTrustRows({ table: 'timeline_entries', afterId: 0, until: 5, tiers })];
      expect({ takes, timeline, counts }).toEqual({ takes: [], timeline: [], counts: [0, 0] });
      return { takes, timeline, counts };
    },
  );

  parityTest(
    'listVersionTrustTiers and listVersionReasonWriters read the snapshot tier and the type and tier of the write that replaced each version',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'createVersion', 'readPageTrustRows', 'listVersionTrustTiers', 'listVersionReasonWriters'] },
    async (engine) => {
      const labels = new Map<number, string>();
      // The tier each snapshot should carry: the page's stored tier when it was taken.
      const stored = new Map<string, string>();
      const tierOf = async (slug: string) => (await engine.readPageTrustRows({ keys: [{ source_id: 'default', slug }] }))[0]!.trust_tier;
      const write = (slug: string, tier: string | null, type: string) => declared(engine, tier, tx => tx.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} ${type}`, timeline: '' }));
      const version = async (slug: string, name: string) => {
        stored.set(name, await tierOf(slug));
        labels.set((await engine.createVersion(slug, { sourceId: 'default' })).id, name);
      };
      await write('hist/a', 'agent_written', 'note');
      await version('hist/a', 'a1');
      await write('hist/b', 'operator_curated', 'person');
      await version('hist/b', 'b1');
      await write('hist/a', 'tool_observed', 'concept');
      await version('hist/a', 'a2');
      await write('hist/a', 'operator_curated', 'project');
      await write('hist/b', null, 'company');
      const ids = [...labels.keys()];
      const named = <T extends { id: number }>(rows: T[]) => rows.map(({ id, ...rest }) => ({ v: labels.get(id) ?? `?${id}`, ...rest }));
      const tiers = named(await engine.listVersionTrustTiers([...ids, 987_654]));
      const writers = named(await engine.listVersionReasonWriters([...ids, 987_654]));
      const empty = [await engine.listVersionTrustTiers([]), await engine.listVersionReasonWriters([])];
      const live = { a: await tierOf('hist/a'), b: await tierOf('hist/b') };
      expect(tiers).toEqual(['a1', 'b1', 'a2'].map(v => ({ v, trust_tier: stored.get(v)! })));
      expect(stored.get('a1')).toBe('agent_written');
      expect(stored.get('b1')).toBe('operator_curated');
      expect(writers).toEqual([
        { v: 'a1', type: 'concept', tier: stored.get('a2')! },
        { v: 'b1', type: 'company', tier: live.b },
        { v: 'a2', type: 'project', tier: live.a },
      ]);
      expect(empty).toEqual([[], []]);
      return { tiers, writers, empty, live };
    },
  );

  parityTest(
    'readBeliefHistoryRows and listVisibleBeliefLifetimes answer an empty ledger and an unknown lifetime, and Rust refuses both for its missing ledger',
    { methods: ['readBeliefHistoryRows', 'listVisibleBeliefLifetimes'] },
    async (engine, backend) => {
      const base = { sourceId: 'default', slug: null, subjectKey: null, afterId: 0, limit: 10, recordedAfter: null, recordedUntil: null, subjectKeys: null, beforeId: null };
      if (backend === 'rust') {
        // The store keeps no belief ledger, so no input, an empty lifetime list included, may answer an empty list.
        const refusals = [await engine.readBeliefHistoryRows({ ...base, descending: false }).then(() => null, (e: unknown) => e),
          await engine.listVisibleBeliefLifetimes([]).then(() => null, (e: unknown) => e),
          await engine.listVisibleBeliefLifetimes(['00000000-0000-4000-8000-000000000001']).then(() => null, (e: unknown) => e)];
        expect(refusals.map(e => (e instanceof Error ? /the belief ledger, which the store does not keep/.test(e.message) : e)))
          .toEqual([true, true, true]);
        throw refusals[0];
      }
      const asc = await engine.readBeliefHistoryRows({ ...base, descending: false });
      const desc = await engine.readBeliefHistoryRows({ ...base, slug: 'x', subjectKeys: ['k'], beforeId: 5, recordedAfter: '2026-01-01T00:00:00Z', descending: true });
      const lifetimes = await engine.listVisibleBeliefLifetimes(['00000000-0000-4000-8000-000000000001']);
      expect({ asc, desc, lifetimes }).toEqual({ asc: [], desc: [], lifetimes: [] });
      return { asc, desc, lifetimes };
    },
  );

  parityTest(
    'pickValidTimeEdition picks the edition in force on a date over the page and its retained versions',
    { methods: ['putPage', 'createVersion', 'getPage', 'pickValidTimeEdition'] },
    async (engine) => {
      const labels = new Map<string, string>();
      const write = (validFrom: string) => engine.putPage('vt/page', { type: 'note', title: 'VT', compiled_truth: `body ${validFrom}`, timeline: '', frontmatter: { valid_from: validFrom } });
      await write('2026-01-01');
      labels.set(String((await engine.createVersion('vt/page', { sourceId: 'default' })).id), 'v1');
      await write('2026-06-01');
      const pageId = (await engine.getPage('vt/page', { sourceId: 'default' }))!.id;
      const ord = (v: unknown) => (v == null ? null : Number(v) === VALID_TIME_CURRENT_ORD ? 'current' : labels.get(String(v)) ?? `?${v}`);
      const norm = (r: Record<string, unknown> | null) => r && ({
        version: ord(r.version_id), ord: ord(r.ord), valid_from: r.valid_from, valid_until: r.valid_until, visible: r.visible, chosen: r.chosen,
        tier: r.tier, successor_tier: r.successor_tier, segmented: r.segmented, successor_pruned: r.successor_pruned,
        replaced: r.replaced_at instanceof Date || typeof r.replaced_at === 'string', since: r.recorded_since != null,
        competing: Array.isArray(r.competing) ? r.competing.map(ord) : r.competing,
        undated: Number(r.undated), large: Number(r.large_versions), segmentedVersions: Number(r.segmented_versions), filed: r.any_filed, gap: r.gap_at instanceof Date,
      });
      const spec = { pageId, excludePrivate: false, pinOrd: null, inlineMaxBytes: 1_000_000 };
      const march = norm(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-03-01' }));
      const july = norm(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-07-01', excludePrivate: true }));
      const before = norm(await engine.pickValidTimeEdition({ ...spec, asOf: '2025-01-01' }));
      const pinned = norm(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-07-01', pinOrd: VALID_TIME_CURRENT_ORD }));
      const gone = await engine.pickValidTimeEdition({ ...spec, pageId: 987_654, asOf: '2026-03-01' });
      expect(march).toMatchObject({ version: 'v1', ord: 'v1', valid_from: '2026-01-01', chosen: true });
      expect(july).toMatchObject({ version: null, ord: 'current', valid_from: '2026-06-01', chosen: true });
      expect(before).toMatchObject({ ord: 'v1', chosen: false });
      expect(pinned).toMatchObject({ ord: 'current' });
      expect(gone).toBeNull();
      return { march, july, before, pinned, gone };
    },
  );

  parityTest(
    'listValidTimeIdentities lists the live pages with a slug in the scope by source, with the checkout and world mark',
    { methods: ['putPage', 'softDeletePage', 'listValidTimeIdentities'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
      await createSource(engine, backend, 'alpha');
      await createSource(engine, backend, 'gamma');
      const note = (frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title: 'VT', compiled_truth: 'body', timeline: '', frontmatter });
      await engine.putPage('vt/ident', { ...note(), source_path: 'vt/ident.md' } as never, { sourceId: 'beta' });
      await engine.putPage('vt/ident', note(), { sourceId: 'alpha' });
      await engine.putPage('vt/ident', note({ visibility: 'private' }), { sourceId: 'gamma' });
      await engine.putPage('vt/ident', note(), { sourceId: 'default' });
      await engine.softDeletePage('vt/ident', { sourceId: 'default' });
      const list = async (spec: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; slug?: string }) =>
        (await engine.listValidTimeIdentities({ slug: spec.slug ?? 'vt/ident', sourceId: spec.sourceId ?? null, sourceIds: spec.sourceIds ?? null, excludePrivate: spec.excludePrivate ?? false }))
          .map(r => ({ ...r, id: typeof r.id === 'number' && r.id > 0 }));
      const all = await list({});
      const one = await list({ sourceId: 'beta' });
      const granted = await list({ sourceIds: ['gamma', 'alpha'] });
      const hidden = await list({ excludePrivate: true });
      const missing = await list({ slug: 'vt/none' });
      expect(all.map(r => [r.source_id, r.world])).toEqual([['alpha', true], ['beta', true], ['gamma', false]]);
      expect(one).toEqual([{ id: true, source_id: 'beta', slug: 'vt/ident', source_path: 'vt/ident.md', local_path: '/srv/brain/beta', world: true }]);
      expect(granted.map(r => r.source_id)).toEqual(['alpha', 'gamma']);
      expect(hidden.map(r => r.source_id)).toEqual(['alpha', 'beta']);
      expect(missing).toEqual([]);
      return { all, one, granted, hidden, missing };
    },
  );

  parityTest(
    'listValidTimeIdentities and pickValidTimeEdition apply the page policy to an owner-only source: every page while one exists with no schema version, only that source\'s and its concept lineage under the function form',
    { methods: ['putPage', 'addLink', 'getPage', 'listValidTimeIdentities', 'pickValidTimeEdition'] },
    async (engine, backend) => {
      const put = (slug: string, type: 'note' | 'concept', sourceId: string) =>
        engine.putPage(slug, { type, title: slug, compiled_truth: `body ${slug}`, timeline: '', frontmatter: { valid_from: '2026-01-01' } }, { sourceId });
      const reads = async (pickSources: string[]) => {
        const identities = async (slug: string, excludePrivate: boolean) =>
          (await engine.listValidTimeIdentities({ slug, sourceId: null, sourceIds: null, excludePrivate })).map(r => `${r.source_id}:${r.world ? 'world' : 'hidden'}`);
        const visible = async (slug: string, sourceId: string) => {
          const page = (await engine.getPage(slug, { sourceId }))!;
          const row = await engine.pickValidTimeEdition({ pageId: page.id, asOf: '2026-07-01', excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 });
          return `${sourceId}:${slug}:${row?.visible}`;
        };
        return {
          shared: await identities('vt/shared', true),
          sharedUnfiltered: await identities('vt/shared', false),
          synth: await identities('vt/synth', true),
          picks: [...await Promise.all(pickSources.map(src => visible('vt/shared', src))), await visible('vt/synth', 'default')],
        };
      };
      await createSource(engine, backend, 'work');
      await put('vt/shared', 'note', 'default');
      await put('vt/shared', 'note', 'work');
      await put('vt/synth', 'concept', 'default');
      // Before any owner-only source exists every page is listed and visible: the case is not vacuous.
      const before = await reads(['default', 'work']);
      expect(before).toEqual({
        shared: ['default:world', 'work:world'], sharedUnfiltered: ['default:world', 'work:world'], synth: ['default:world'],
        picks: ['default:vt/shared:true', 'work:vt/shared:true', 'default:vt/synth:true'],
      });

      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await createSource(engine, backend, 'vault', { owner_only: true });
      await put('vt/shared', 'note', 'chat');
      await put('vt/shared', 'note', 'vault');
      await put('vt/synth', 'note', 'chat');
      await engine.addLink('vt/synth', 'vt/synth', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'chat' });
      const sources = ['default', 'work', 'chat', 'vault'];

      const closed = await reads(sources);
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const fn = await withEngineScope(engine, () => reads(sources));
      // No schema version in context: while an owner-only source exists the non-owner policy hides every page, and the
      // `world` mark of an unfiltered listing is false for every page.
      expect(closed).toEqual({
        shared: [], sharedUnfiltered: ['chat:hidden', 'default:hidden', 'vault:hidden', 'work:hidden'], synth: [],
        picks: ['default:vt/shared:false', 'work:vt/shared:false', 'chat:vt/shared:false', 'vault:vt/shared:false', 'default:vt/synth:false'],
      });
      // Schema version 320 or later: only the owner-only sources' pages, and the concept synthesized from one, are hidden.
      expect(fn).toEqual({
        shared: ['default:world', 'work:world'], sharedUnfiltered: ['chat:hidden', 'default:world', 'vault:hidden', 'work:world'], synth: [],
        picks: ['default:vt/shared:true', 'work:vt/shared:true', 'chat:vt/shared:false', 'vault:vt/shared:false', 'default:vt/synth:false'],
      });
      return { before, closed, fn };
    },
  );

  /** Ordinals as labels: the current page, or the version label the case gave it. */
  const ordLabel = (labels: Map<string, string>) => (v: unknown) => (v == null ? null : Number(v) === VALID_TIME_CURRENT_ORD ? 'current' : labels.get(String(v)) ?? `?${v}`);

  /** The pick with ordinals as labels and the timestamps as their presence. */
  const pickView = (labels: Map<string, string>) => (r: Record<string, unknown> | null) => {
    const ord = ordLabel(labels);
    return r && ({
      version: ord(r.version_id), ord: ord(r.ord), valid_from: r.valid_from, valid_until: r.valid_until, visible: r.visible, chosen: r.chosen,
      reason: r.reason, introduced: r.introduced_because, tier: r.tier, successor_tier: r.successor_tier, segmented: r.segmented,
      successor_pruned: r.successor_pruned, replaced: r.replaced_at instanceof Date, since: r.recorded_since instanceof Date,
      competing: Array.isArray(r.competing) ? r.competing.map(ord) : r.competing, undated: Number(r.undated), large: Number(r.large_versions),
      segmentedVersions: Number(r.segmented_versions), filed: r.any_filed, gap: r.gap_at instanceof Date, created: r.created_at instanceof Date,
    });
  };

  parityTest(
    'pickValidTimeEdition reports the competing editions, undated and large versions, and a private edition',
    { methods: ['putPage', 'createVersion', 'getPage', 'pickValidTimeEdition'] },
    async (engine) => {
      const labels = new Map<string, string>();
      const write = (body: string, frontmatter: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        engine.putPage('vt/many', { type: 'note', title: 'VT', compiled_truth: body, timeline: '', frontmatter, ...extra } as never);
      const snap = async (label: string) => labels.set(String((await engine.createVersion('vt/many', { sourceId: 'default' })).id), label);
      await write('a', { valid_from: '2026-01-01', valid_until: '2026-12-31T00:00:00Z' });
      await snap('v1');
      await write('long body b', { valid_from: '2026-02-30' });
      await snap('v2');
      await write('c', { valid_from: '2025-06-01T00:00:00.000+00:00', visibility: 'private' });
      await snap('v3');
      await write('c', { valid_from: '2026-03-01' }, { source_path: 'vt/many.md' });
      const pageId = (await engine.getPage('vt/many', { sourceId: 'default' }))!.id;
      const view = pickView(labels);
      const spec = { pageId, excludePrivate: false, pinOrd: null, inlineMaxBytes: 5 };
      const feb = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-02-01' }));
      const april = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-04-01', excludePrivate: true }));
      const july = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2025-07-01' }));
      const early = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2024-01-01' }));
      const [pin] = [...labels].find(([, l]) => l === 'v1')!;
      const pinned = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-04-01', pinOrd: Number(pin) }));
      expect(feb).toMatchObject({ ord: 'v1', chosen: true, valid_until: '2026-12-31', competing: ['v3'], undated: 1, large: 1, filed: true, visible: true });
      expect(april).toMatchObject({ ord: 'current', chosen: true, competing: ['v3'], since: true, successor_tier: null });
      expect(july).toMatchObject({ ord: 'v3', valid_from: '2025-06-01', visible: false, competing: ['current'] });
      expect(early).toMatchObject({ ord: 'v3', chosen: false });
      expect(pinned).toMatchObject({ ord: 'v1', chosen: true });
      return { feb, april, july, early, pinned };
    },
  );

  parityTest(
    'pickValidTimeEdition reads the reason a version was replaced for and the reason the next edition was introduced for',
    { methods: ['putPage', 'createVersion', 'getPage', 'pickValidTimeEdition'] },
    async (engine) => {
      const write = (validFrom: string) => engine.putPage('vt/reason', { type: 'note', title: 'VT', compiled_truth: `body ${validFrom}`, timeline: '', frontmatter: { valid_from: validFrom } });
      await write('2026-01-01');
      const v1 = await engine.createVersion('vt/reason', { sourceId: 'default', reason: 'imported from the notes export' });
      await write('2026-06-01');
      const pageId = (await engine.getPage('vt/reason', { sourceId: 'default' }))!.id;
      const view = pickView(new Map([[String(v1.id), 'v1']]));
      const july = view(await engine.pickValidTimeEdition({ pageId, asOf: '2026-07-01', excludePrivate: false, pinOrd: null, inlineMaxBytes: 1_000_000 }));
      const march = view(await engine.pickValidTimeEdition({ pageId, asOf: '2026-03-01', excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 }));
      expect(july).toMatchObject({ ord: 'current', introduced: 'imported from the notes export' });
      expect(march).toMatchObject({ ord: 'v1', reason: 'imported from the notes export' });
      return { july, march };
    },
  );

  parityTest(
    'a large page keeps its newest five large versions, and the pick reads the marks the prune leaves',
    { methods: ['putPage', 'createVersion', 'getVersions', 'getPage', 'pickValidTimeEdition'] },
    async (engine) => {
      const labels = new Map<string, string>();
      const write = (body: string, validFrom: string) =>
        engine.putPage('vt/pruned', { type: 'note', title: 'VT', compiled_truth: body, timeline: '', frontmatter: { valid_from: validFrom } });
      const snap = async (label: string, reason?: string) =>
        labels.set(String((await engine.createVersion('vt/pruned', { sourceId: 'default', reason })).id), label);
      await write('Small.', '2026-01-01');
      await snap('small', 'grew');
      await write('x'.repeat(1024 * 1024 + 1), '2026-06-01');
      for (let i = 1; i <= 6; i++) await snap(`large${i}`);
      const kept = (await engine.getVersions('vt/pruned', { sourceId: 'default', includeBody: false })).map((v) => labels.get(String(v.id)));
      expect(kept).toEqual(['large6', 'large5', 'large4', 'large3', 'large2', 'small']);
      const pageId = (await engine.getPage('vt/pruned', { sourceId: 'default' }))!.id;
      const view = pickView(labels);
      const spec = { pageId, pinOrd: null, inlineMaxBytes: 1024 * 1024 };
      const trusted = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-03-01', excludePrivate: false }));
      const remote = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-03-01', excludePrivate: true }));
      const july = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-07-01', excludePrivate: false }));
      // large2 follows a pruned edition: the small version's reason does not introduce it.
      const [large2] = [...labels].find(([, l]) => l === 'large2')!;
      const pinned = view(await engine.pickValidTimeEdition({ ...spec, asOf: '2026-07-01', excludePrivate: false, pinOrd: Number(large2) }));
      expect(trusted).toMatchObject({ ord: 'small', successor_pruned: true, reason: 'grew', large: 5, gap: true });
      expect(remote).toMatchObject({ ord: 'small', successor_pruned: true, reason: null, gap: true });
      expect(july).toMatchObject({ ord: 'current', introduced: null, gap: true });
      expect(pinned).toMatchObject({ ord: 'large2', successor_pruned: false, introduced: null });
      return { kept, trusted, remote, july, pinned };
    },
  );

  parityTest(
    'the pick withholds the reason a private successor gave, even from a caller whose grant opens that successor',
    { methods: ['putPage', 'createVersion', 'getPage', 'pickValidTimeEdition'] },
    async (engine) => {
      const write = (body: string, frontmatter: Record<string, unknown>) =>
        engine.putPage('vt/grant', { type: 'note', title: 'VT', compiled_truth: body, timeline: '', frontmatter });
      await write('One.', { valid_from: '2026-01-01' });
      await engine.createVersion('vt/grant', { sourceId: 'default', reason: 'r1' });
      await write('Two.', { valid_from: '2026-02-01', visibility: 'private' });
      await engine.createVersion('vt/grant', { sourceId: 'default', reason: 'r2' });
      await write('Three.', { valid_from: '2026-03-01' });
      const pageId = (await engine.getPage('vt/grant', { sourceId: 'default' }))!.id;
      const reason = (access: Parameters<typeof withCallerAccess>[0] | null) => {
        const run = async () => {
          const r = await engine.pickValidTimeEdition({ pageId, asOf: '2026-01-15', excludePrivate: access !== null, pinOrd: null, inlineMaxBytes: 1_000_000 });
          return (r as Record<string, unknown> | null)?.reason ?? null;
        };
        return access ? withCallerAccess(access, run) : run();
      };
      const result = {
        trusted: await reason(null),
        member: await reason({ identity: ['member:alice-example'], hidePrivate: true }),
        granted: await reason({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true }),
      };
      expect(result).toEqual({ trusted: 'r1', member: null, granted: null });
      return result;
    },
  );

  parityTest(
    'pickValidTimeEdition reads the gap a version history records',
    { methods: ['putPage', 'createVersion', 'getPage', 'pickValidTimeEdition'] },
    async (engine) => {
      await engine.putPage('vt/gap', { type: 'note', title: 'VT', compiled_truth: 'body', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
      await engine.createVersion('vt/gap', { sourceId: 'default', historyGap: true });
      const pageId = (await engine.getPage('vt/gap', { sourceId: 'default' }))!.id;
      const row = await engine.pickValidTimeEdition({ pageId, asOf: '2026-07-01', excludePrivate: false, pinOrd: null, inlineMaxBytes: 1_000_000 });
      expect(row?.gap_at).toBeInstanceOf(Date);
      return { gap: row?.gap_at instanceof Date };
    },
  );
  parityTest(
    'listAmendmentsNotApplied lists the amending pages dated after the edition and on or before the date, or undated',
    { methods: ['setConfig', 'putPage', 'getPage', 'addLinksBatch', 'listAmendmentsNotApplied'] },
    async (engine, backend) => {
      const restorePack = useExamplePack();
      try {
      await engine.setConfig('schema_pack', EXAMPLE_PACK);
      await primeRelationSemantics(engine);
      await createSource(engine, backend, 'beta');
      await engine.putPage('vt/amended', { type: 'contract', title: 'Amended', compiled_truth: 'The agreement.', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
      // A frontmatter amends link with its since date, published the way put_page publishes it.
      const amend = async (slug: string, since: string | null, opts: { private?: boolean } = {}) => {
        const page = await engine.putPage(slug, { type: 'contract', title: slug, compiled_truth: 'An amendment.', timeline: '',
          frontmatter: { ...(opts.private ? { visibility: 'private' } : {}), amends: [{ name: 'Amended', ...(since ? { since } : {}) }] } });
        const rows: LinkBatchInput[] = [{ from_slug: slug, to_slug: 'vt/amended', link_type: 'amends', context: 'frontmatter.amends: Amended',
          link_source: 'frontmatter', origin_slug: slug, origin_field: 'amends', from_source_id: 'default', to_source_id: 'default', origin_source_id: 'default' }];
        await engine.addLinksBatch(rows);
        await applyTemporalEvidence(engine, page, rows, await relationshipKeysForOrigin(engine, Number(page.id)));
      };
      await amend('vt/amend-b', '2026-03-01');
      await amend('vt/amend-a', '2026-05-01');
      await amend('vt/amend-early', '2025-06-01');
      await amend('vt/amend-late', '2026-09-01');
      await amend('vt/amend-undated', null);
      await amend('vt/amend-private', '2026-04-01', { private: true });
      const pageId = (await engine.getPage('vt/amended', { sourceId: 'default' }))!.id;
      const spec = { pageId, editionFrom: '2026-01-01', asOf: '2026-07-01', excludePrivate: false, sourceIds: null, limit: 20 };
      const all = await engine.listAmendmentsNotApplied(spec);
      const world = await engine.listAmendmentsNotApplied({ ...spec, excludePrivate: true });
      const scoped = await engine.listAmendmentsNotApplied({ ...spec, sourceIds: ['beta'] });
      const capped = await engine.listAmendmentsNotApplied({ ...spec, limit: 2 });
      const later = await engine.listAmendmentsNotApplied({ ...spec, editionFrom: '2026-04-01' });
      expect(all.map(r => [r.slug, r.since])).toEqual([['vt/amend-a', '2026-05-01'], ['vt/amend-b', '2026-03-01'], ['vt/amend-private', '2026-04-01'], ['vt/amend-undated', null]]);
      expect(world.map(r => r.slug)).toEqual(['vt/amend-a', 'vt/amend-b', 'vt/amend-undated']);
      expect(scoped).toEqual([]);
      expect(capped.map(r => r.slug)).toEqual(['vt/amend-a', 'vt/amend-b']);
      expect(later.map(r => r.slug)).toEqual(['vt/amend-a', 'vt/amend-undated']);
      return { all, world, scoped, capped, later };
      } finally { setPackRelationSemantics(new Map()); restorePack(); }
    },
  );
  parityTest(
    'readPageVersionEdition reads one retained version of the page as an edition, and null for another page or an unknown id',
    { methods: ['putPage', 'createVersion', 'getPage', 'readPageVersionEdition'] },
    async (engine) => {
      await engine.putPage('vt/edition', { type: 'note', title: 'Edition One', compiled_truth: 'first body', timeline: '- 2026-01-02: signed',
        frontmatter: { valid_from: '2026-01-01', tags: ['b-tag', 'a-tag'] } });
      const v1 = await engine.createVersion('vt/edition', { sourceId: 'default' });
      await engine.putPage('vt/edition', { type: 'note', title: 'Edition Two', compiled_truth: 'second body', timeline: '', frontmatter: { valid_from: '2026-06-01' } });
      await engine.putPage('vt/other', { type: 'note', title: 'Other', compiled_truth: 'x', timeline: '', frontmatter: {} });
      const pageId = (await engine.getPage('vt/edition', { sourceId: 'default' }))!.id;
      const otherId = (await engine.getPage('vt/other', { sourceId: 'default' }))!.id;
      const versionId = Number(v1.id);
      const got = await engine.readPageVersionEdition({ pageId, versionId });
      const wrongPage = await engine.readPageVersionEdition({ pageId: otherId, versionId });
      const unknown = await engine.readPageVersionEdition({ pageId, versionId: versionId + 1000 });
      expect(got?.id).toBe(versionId);
      expect(got?.compiled_truth).toBe('first body');
      expect(got?.frontmatter.valid_from).toBe('2026-01-01');
      expect(typeof got?.revision).toBe('string');
      expect(wrongPage).toBeNull();
      expect(unknown).toBeNull();
      // Ids and revisions differ per engine; the rest of the edition is compared.
      const { id: _id, revision: _revision, ...edition } = got!;
      return { edition, wrongPage, unknown };
    },
  );
  parityTest(
    'readCursorEdition says whether the page is still at a revision and names its newest version at it, and null for a gone page',
    { methods: ['putPage', 'createVersion', 'getPage', 'readPageVersionEdition', 'readCursorEdition', 'softDeletePage'] },
    async (engine) => {
      await engine.putPage('vt/cursor', { type: 'note', title: 'Cursor', compiled_truth: 'first body', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
      const pageId = (await engine.getPage('vt/cursor', { sourceId: 'default' }))!.id;
      const v1 = Number((await engine.createVersion('vt/cursor', { sourceId: 'default' })).id);
      const v2 = Number((await engine.createVersion('vt/cursor', { sourceId: 'default' })).id);
      const first = (await engine.readPageVersionEdition({ pageId, versionId: v1 }))!.revision!;
      const atFirst = await engine.readCursorEdition({ pageId, revision: first });
      await engine.putPage('vt/cursor', { type: 'note', title: 'Cursor', compiled_truth: 'second body', timeline: '', frontmatter: { valid_from: '2026-06-01' } });
      const moved = await engine.readCursorEdition({ pageId, revision: first });
      const unknown = await engine.readCursorEdition({ pageId, revision: '00000000-0000-0000-0000-000000000000' });
      await engine.softDeletePage('vt/cursor', { sourceId: 'default' });
      const deleted = await engine.readCursorEdition({ pageId, revision: first });
      const gone = await engine.readCursorEdition({ pageId: pageId + 1000, revision: first });
      expect(atFirst).toEqual({ current: true, version_id: v2 });
      expect(moved).toEqual({ current: false, version_id: v2 });
      expect(unknown).toEqual({ current: false, version_id: null });
      expect(deleted?.version_id).toBe(v2);
      expect(gone).toBeNull();
      // Version ids differ per engine; name them.
      const named = (r: { current: boolean; version_id: number | null } | null) => r && { current: r.current, version: r.version_id === v2 ? 'v2' : r.version_id };
      return { atFirst: named(atFirst), moved: named(moved), unknown: named(unknown), deleted: named(deleted), gone };
    },
  );

  // A purge marks a page in needs_rederive through raw SQL, which the Rust engine refuses, so only the SQL arms can
  // mark one; the store keeps no such queue and answers false. Unmarked and missing pages answer false on every arm.
  parityTest('pageAwaitsRederive is true only for a page a needs_rederive row names', {
    methods: ['putPage', 'pageAwaitsRederive'],
  }, async (engine, backend) => {
    const live = await engine.putPage('rederive/live', { type: 'note', title: 'Live', compiled_truth: 'live body' });
    const marked = await engine.putPage('rederive/marked', { type: 'note', title: 'Marked', compiled_truth: 'marked body' });
    if (backend !== 'rust') {
      await engine.executeRaw(`INSERT INTO needs_rederive (derived_table, derived_id, reason) VALUES ('pages', $1, 'purge')`, [String(marked.id)]);
      expect(await engine.pageAwaitsRederive(Number(marked.id))).toBe(true);
    } else {
      expect(await engine.pageAwaitsRederive(Number(marked.id))).toBe(false);
    }
    return { live: await engine.pageAwaitsRederive(Number(live.id)), missing: await engine.pageAwaitsRederive(Number(live.id) + 100000) };
  });

  // get_page with as_of end to end: identity, pick, edition load, amendments, snapshot and the re-derivation check.
  // Ids and recorded times differ between arms, so the version id is folded to whether one was chosen.
  parityTest('get_page as_of answers the edition in force on each date', {
    methods: ['putPage', 'createVersion', 'listValidTimeIdentities', 'pickValidTimeEdition', 'readPageVersionEdition', 'beginSnapshotRead', 'pageAwaitsRederive'],
  }, async (engine) => {
    await engine.putPage('vt/e2e', { type: 'note', title: 'E', compiled_truth: 'old body', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
    await engine.createVersion('vt/e2e', { sourceId: 'default' });
    await engine.putPage('vt/e2e', { type: 'note', title: 'E', compiled_truth: 'new body', timeline: '', frontmatter: { valid_from: '2026-06-01' } });
    const op = operations.find((o) => o.name === 'get_page')!;
    const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const read = async (as_of: string) => {
      const r = await op.handler(ctx, { slug: 'vt/e2e', as_of }) as Record<string, unknown>;
      const { chosen_version_id, recorded_since, ...vt } = r.valid_time as Record<string, unknown>;
      expect(typeof recorded_since).toBe('string');
      return { body: r.compiled_truth, title: r.title, chose_version: chosen_version_id != null, vt };
    };
    return { before: await read('2026-03-01'), after: await read('2026-07-01') };
  });

  parityTest(
    'updateSlug keeps the trust tier of the moved page and the facts it re-keys, whatever tier the mover declares (#9735)',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'updateSlug', 'readPageTrustRows', 'listFactsByEntity'] },
    async (engine) => {
      await declared(engine, 'agent_written', async (tx) => {
        await tx.putPage('people/mover-example', { type: 'person', title: 'Mover Example', compiled_truth: 'A founder.', timeline: '' });
        await tx.insertFacts([
          { fact: 'founded acme-example', entity_slug: 'people/mover-example', source_markdown_slug: 'people/mover-example', row_num: 1,
            kind: 'fact', visibility: 'world', source: 'fence' },
        ] as never, { source_id: 'default' });
      });
      const tiers = async (slug: string) => ({
        page: (await engine.readPageTrustRows({ keys: [{ source_id: 'default', slug }] })).map(r => r.trust_tier),
        facts: (await engine.listFactsByEntity('default', slug, { limit: 10 })).map(f => f.trust_tier),
      });
      const seeded = await tiers('people/mover-example');
      expect(seeded).toEqual({ page: ['agent_written'], facts: ['agent_written'] });
      // An owner-tier mover does not raise the page or its facts, and a mover with no declared tier does not lower them.
      expect(await declared(engine, 'operator_curated', tx => tx.updateSlug('people/mover-example', 'people/moved-example'))).toBe(1);
      const raisedMover = await tiers('people/moved-example');
      expect(await declared(engine, null, tx => tx.updateSlug('people/moved-example', 'people/moved-again-example'))).toBe(1);
      const plainMover = await tiers('people/moved-again-example');
      expect(raisedMover).toEqual(seeded);
      expect(plainMover).toEqual(seeded);
      return { seeded, raisedMover, plainMover };
    },
  );
  // GST-687 quoting: get_timeline, the chronicle reads and get_chunks look up each row's page type (and get_chunks its
  // page's slug and source) by page id. Ids differ between arms, so answers are keyed by slug.
  parityTest('listPageRefsByIds, pageTypesById and quoteTimelineRows read each page by id: deleted pages and other sources included, unknown ids absent', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'listPageRefsByIds'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('quote/chat', { type: 'chat' as never, title: 'Chat', compiled_truth: 'chat body', timeline: '' });
    await engine.putPage('quote/note', { type: 'note', title: 'Note', compiled_truth: 'note body', timeline: '' });
    await engine.putPage('quote/gone', { type: 'transcript' as never, title: 'Gone', compiled_truth: 'gone body', timeline: '' });
    await engine.putPage('quote/elsewhere', { type: 'person', title: 'Elsewhere', compiled_truth: 'other body', timeline: '' }, { sourceId: 'other' });
    const idOf = async (slug: string, sourceId = 'default') => Number((await engine.getPage(slug, { sourceId }))!.id);
    const ids = { chat: await idOf('quote/chat'), note: await idOf('quote/note'), gone: await idOf('quote/gone'), elsewhere: await idOf('quote/elsewhere', 'other') };
    await engine.softDeletePage('quote/gone', { sourceId: 'default' });
    const missing = Math.max(...Object.values(ids)) + 100_000;
    const types = await pageTypesById(engine, [ids.chat, ids.note, ids.gone, ids.elsewhere, ids.chat, missing]);
    const byName = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, types.get(id) ?? null]));
    expect(byName).toEqual({ chat: 'chat', note: 'note', gone: 'transcript', elsewhere: 'person' });
    expect({ size: types.size, missing: types.has(missing), empty: (await pageTypesById(engine, [])).size }).toEqual({ size: 4, missing: false, empty: 0 });
    const refs = (await engine.listPageRefsByIds([ids.elsewhere, ids.gone, ids.note, ids.chat, ids.note, missing])).map(({ id, ...ref }) => ref);
    expect(refs).toEqual([
      { source_id: 'default', slug: 'quote/chat', type: 'chat' },
      { source_id: 'default', slug: 'quote/note', type: 'note' },
      { source_id: 'default', slug: 'quote/gone', type: 'transcript' },
      { source_id: 'other', slug: 'quote/elsewhere', type: 'person' },
    ]);
    expect(await engine.listPageRefsByIds([])).toEqual([]);
    const rows = [
      { page_id: ids.chat, summary: 'said a thing', trust_tier: 'operator_curated' },
      { page_id: ids.note, summary: 'wrote a thing', trust_tier: 'operator_curated' },
    ];
    const quoted = await quoteTimelineRows({ engine, remote: true }, 'quote/chat', rows);
    expect(quoted.map(r => ('quoted' in r ? r.quoted : null))).toEqual(['transcript', null]);
    return { byName, refs, quoted: quoted.map(r => ({ quoted: 'quoted' in r ? r.quoted : null, summary: r.summary })) };
  });
});
