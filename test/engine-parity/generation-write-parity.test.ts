/**
 * BrainEngine parity — the trust writes of a derived page generation answer PGLite's output on Postgres and on a Rust
 * brain: a single-page derivation publish (the dream summary of cycle/synthesize.ts), a derived retirement, an atom
 * generation publish with its completion stamp and the retirement of an atom the extraction no longer produced, and the
 * derived-tier lowering (lowerTrustTier) of facts, takes and timeline rows.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each case gives the same answer on PGLite, Postgres and the Rust engine: the derivation's tier, origin
 *    and inputs (trust/taint.ts deriveTrust, a vanished or hidden input reads `unknown`), the stored tier and origin of
 *    each derived page, its recorded input edges and what is derived from a row through them
 *    (facts/derivation-inputs.ts), the explicit lowering of a page whose content did not change (lowerDerivedPage), the
 *    derived share doctor reads, the retirement stamp (`retired_by`, `retired_at`) on soft-deleted pages only with
 *    their tier and origin kept, the atom completion stamp (`source_hash`), and which facts, takes and timeline rows
 *    lowerTrustTier lowers and the tier and origin each keeps (a row at or below the tier is never raised).
 *  - Regression: these flows sent raw SQL (taint.ts, derived-retirement-hold.ts and the atom adapter's
 *    completeItems), so a Rust brain stopped on `raw_sql` at the first derived write: no dream summary, no retirement
 *    and no atom generation published there. The Rust lowerTrustTier served pages only and refused a fact, take or
 *    timeline row with `engine_capability_missing`, so a derived fact or take was never lowered there.
 *  - Why existing coverage misses it: generation-output-parity.test.ts publishes a single page with no derivation and
 *    reads atom inputs, but publishes no derivation, retires nothing and publishes no atom; the derivation publish case
 *    here lowers pages only.
 *  - Seam: none. Typed members and the real generation paths only (no executeRaw: D18). Page ids differ between
 *    engines, so every answer names a page by its slug. Postgres runs when DATABASE_URL is set (testBackends); the
 *    Rust arm runs through test/engine-parity/harness.ts.
 */
import { describe, expect } from 'bun:test';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { maintenanceTransaction } from '../../src/core/persistence/attribution.ts';
import { retireDerivedPages, stampDerivedRetirement } from '../../src/core/persistence/derived-retirement-hold.ts';
import { summaryDerivation } from '../../src/core/cycle/dream-taint.ts';
import { DREAM_SUMMARY_KIND, publishSinglePage } from '../../src/core/generations/adapters/single-page.ts';
import { ATOM_KIND, atomGenerationAdapter, atomOwnerKey, readAtomInput } from '../../src/core/generations/adapters/atoms.ts';
import { markdownItem } from '../../src/core/generations/adapters/page.ts';
import { publishGeneration } from '../../src/core/generations/publish.ts';
import { derivedRowsFrom } from '../../src/core/facts/derivation-inputs.ts';
import { deriveTrust, derivedWriteTrust, lowerDerivedPage, readDerivedTaintShare } from '../../src/core/trust/taint.ts';
import type { TaintInput, TrustTier, WriteTrust } from '../../src/core/trust/tier.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';

const { parityTest } = parityArms(testBackends());

const trustAt = (tier: TrustTier): WriteTrust => ({ tier, origin: { channel: 'test:fixture' } });

/** Writes a page at `tier` through an attributed maintenance transaction. */
async function putAt(engine: BrainEngine, slug: string, tier: TrustTier, body: string, type = 'note') {
  await maintenanceTransaction(engine, tx => tx.putPage(slug, { type: type as never, title: slug, compiled_truth: body, timeline: '' }), trustAt(tier));
}

/** Page ids by slug, so answers name a page by its slug: every engine numbers its pages its own way. */
async function labeler(engine: BrainEngine, slugs: readonly string[]) {
  const rows = await engine.readPageTrustRows({ keys: slugs.map(slug => ({ source_id: 'default', slug })), includeDeleted: true });
  const bySlug = new Map(rows.map(row => [row.slug, Number(row.id)]));
  const byId = new Map(rows.map(row => [String(row.id), row.slug]));
  const label = (table: string, id: string | number) => `${table}:${table === 'pages' ? byId.get(String(id)) ?? `#${id}` : id}`;
  const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null), (key, v) =>
    key === 'taint_inputs' && Array.isArray(v) ? v.map((i: { table: string; id: string | number; tier: string }) => `${label(i.table, i.id)} ${i.tier}`) : v);
  const inputs = (list: readonly TaintInput[]) => list.map(i => `${label(i.table, i.id)} ${i.tier}`);
  return { id: (slug: string) => bySlug.get(slug)!, label, scrub, inputs };
}

/** Each page's stored tier and origin, deleted pages included. */
async function trustOf(engine: BrainEngine, slugs: readonly string[], scrub: (v: unknown) => unknown) {
  const rows = await engine.readPageTrustRows({ keys: slugs.map(slug => ({ source_id: 'default', slug })), includeDeleted: true });
  return Object.fromEntries(slugs.map(slug => {
    const row = rows.find(r => r.slug === slug);
    return [slug, row ? { tier: row.trust_tier, origin: scrub(row.write_origin) } : null];
  }));
}

describe('engine parity: derived generation trust writes', () => {
  parityTest('a single-page derivation publish stamps the derived tier, records its input edges and lowers a page whose content did not change', {
    methods: ['putPage', 'getPage', 'readPageTrustRows', 'readRowTrustRows', 'transaction', 'lowerTrustTier', 'countDerivedFactTaint', 'countDerivedRowTaint'],
  }, async (engine) => {
    await putAt(engine, 'notes/alpha', 'operator_curated', 'alpha body');
    await putAt(engine, 'notes/beta', 'tool_observed', 'beta body');
    await putAt(engine, 'dream/summary', 'operator_curated', 'an older summary');
    await putAt(engine, 'notes/derived', 'operator_curated', 'derived from the summary');
    const derivation = await summaryDerivation(engine, 'default', ['notes/alpha', 'notes/beta']);
    const before = await engine.readPageSnapshot('dream/summary', { sourceId: 'default' });
    const published = await publishSinglePage(engine, { kind: DREAM_SUMMARY_KIND, sourceId: 'default', slug: 'dream/summary', expectedRevision: before?.revision ?? null,
      page: { type: 'note', title: 'Dream summary', compiled_truth: 'alpha and beta', frontmatter: { dream: 'summary' } }, derivation });
    const slugs = ['notes/alpha', 'notes/beta', 'dream/summary', 'notes/derived'];
    const l = await labeler(engine, slugs);
    const afterPublish = await trustOf(engine, slugs, l.scrub);
    // An explicit lowering of a page whose content does not change: the trigger rule keeps the tier, the deriver lowers.
    const revision = (await engine.readPageSnapshot('dream/summary', { sourceId: 'default' }))?.revision;
    await lowerDerivedPage(engine, { trust: derivedWriteTrust({ channel: 'derive:test', inputs: [], lowerTo: ['external_untrusted'] }), inputs: [] }, 'default', 'dream/summary');
    // A second derivation whose input is the summary page (by id): two hops from notes/alpha.
    const second = await deriveTrust(engine, [{ table: 'pages', id: l.id('dream/summary') }], { channel: 'derive:test' });
    await lowerDerivedPage(engine, second, 'default', 'notes/derived');
    // Inputs that are not pages, an input page that vanished and one the caller may not read read `unknown`.
    const mixed = await deriveTrust(engine, [{ table: 'facts', id: 9_001 }, { table: 'takes', id: 9_002 }, { table: 'timeline_entries', id: 9_003 },
      { table: 'pages', id: l.id('notes/alpha') }, { table: 'pages', sourceId: 'default', slug: 'notes/missing' },
      { table: 'pages', sourceId: 'default', slug: 'notes/beta', hidden: true }], { channel: 'derive:test' });
    const derived = (from: string) => derivedRowsFrom(engine, [{ table: 'pages', id: l.id(from) }])
      .then(r => ({ rows: r.rows.map(row => `${l.label(row.table, row.id)} ${row.depth}`), truncated: r.truncated }));
    const answers = {
      outcome: published.outcome.state,
      derivation: { tier: derivation.trust.tier, origin: l.scrub(derivation.trust.origin), inputs: l.inputs(derivation.inputs) },
      afterPublish,
      lowered: await trustOf(engine, ['dream/summary', 'notes/derived'], l.scrub),
      revisionKept: (await engine.readPageSnapshot('dream/summary', { sourceId: 'default' }))?.revision === revision,
      second: { tier: second.trust.tier, inputs: l.inputs(second.inputs) },
      mixed: { tier: mixed.trust.tier, inputs: l.inputs(mixed.inputs) },
      fromAlpha: await derived('notes/alpha'),
      fromAlphaOneHop: await derivedRowsFrom(engine, [{ table: 'pages', id: l.id('notes/alpha') }], { maxDepth: 1 }).then(r => r.truncated),
      fromDerived: await derived('notes/derived'),
      share: await readDerivedTaintShare(engine),
    };
    expect(answers.outcome).toBe('published');
    expect(answers.lowered['dream/summary']?.tier).toBe('external_untrusted');
    expect(answers.fromAlpha.rows).toEqual(['pages:dream/summary 1', 'pages:notes/derived 2']);
    return answers;
  });

  parityTest('a derived retirement stamps the soft-deleted pages it retired and keeps their tier and origin', {
    methods: ['putPage', 'getPage', 'createVersion', 'softDeletePages', 'readPageTrustRows', 'getVersions', 'transaction', 'stampPageFrontmatter'],
  }, async (engine) => {
    await putAt(engine, 'synth/old-a', 'agent_written', 'old a');
    await putAt(engine, 'synth/old-b', 'tool_observed', 'old b');
    await putAt(engine, 'synth/live', 'agent_written', 'still live');
    const slugs = ['synth/old-a', 'synth/old-b', 'synth/live'];
    const l = await labeler(engine, slugs);
    const before = await trustOf(engine, slugs, l.scrub);
    const revisions = async () => Promise.all(slugs.map(async slug => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))?.revision));
    const was = await revisions();
    await retireDerivedPages(engine, 'default', ['synth/old-a', 'synth/old-b'], 'synthesis-cleanup');
    // A stamp on a live page changes nothing: the stamp names soft-deleted pages only.
    await maintenanceTransaction(engine, tx => stampDerivedRetirement(tx, 'default', ['synth/live'], 'synthesis-cleanup'));
    const now = await revisions();
    const pages = await Promise.all(slugs.map(async slug => {
      const page = await engine.getPage(slug, { sourceId: 'default', includeDeleted: true });
      const fm = page?.frontmatter ?? {};
      return [slug, { deleted: page?.deleted_at != null, retired_by: fm.retired_by ?? null, retired_at: typeof fm.retired_at === 'string' && !Number.isNaN(Date.parse(fm.retired_at)),
        versions: (await engine.getVersions(slug, { sourceId: 'default' })).length }];
    }));
    const answers = {
      before, after: await trustOf(engine, slugs, l.scrub), pages: Object.fromEntries(pages),
      revisionMoved: slugs.map((slug, i) => `${slug} ${was[i] !== now[i]}`),
    };
    expect(answers.after).toEqual(answers.before);
    expect(answers.pages['synth/old-a']).toEqual({ deleted: true, retired_by: 'synthesis-cleanup', retired_at: true, versions: 1 });
    expect(answers.pages['synth/live'].retired_by).toBe(null);
    return answers;
  });

  parityTest('an atom generation publish stamps its atoms at the origin taint, records their edges, stamps source_hash and retires an atom it no longer produced', {
    methods: ['putPage', 'getPage', 'readPageTrustRows', 'readAtomOriginInput', 'readGenerationPageRows', 'transaction', 'softDeletePages', 'createVersion',
      'lowerTrustTier', 'stampPageFrontmatter'],
  }, async (engine) => {
    const origin = 'notes/origin';
    await putAt(engine, origin, 'tool_observed', 'the origin page');
    const key = { kind: ATOM_KIND, sourceId: 'default', ownerKey: atomOwnerKey({ kind: 'page', slug: origin }) };
    const atom = (slug: string) => markdownItem(slug, serializeMarkdown({ source_slug: origin, extracted_by: 'extract_atoms' }, `${slug} body`, '', { type: 'atom', title: slug, tags: [] }));
    const publish = async (slugs: string[]) => {
      const input = await readAtomInput(engine, key);
      const outcome = await publishGeneration(engine, atomGenerationAdapter, { key, items: slugs.map(atom), input: input!, context: { postCommit: [] } });
      return { state: outcome.state, retired: 'retired' in outcome ? [...outcome.retired].sort() : null, pin: input!.pin.slice(0, 16) };
    };
    const first = await publish(['atoms/one', 'atoms/two']);
    const slugs = [origin, 'atoms/one', 'atoms/two'];
    const l = await labeler(engine, slugs);
    const stamp = async () => Object.fromEntries(await Promise.all(['atoms/one', 'atoms/two'].map(async slug => {
      const page = await engine.getPage(slug, { sourceId: 'default', includeDeleted: true });
      return [slug, { deleted: page?.deleted_at != null, source_hash: page?.frontmatter?.source_hash === first.pin, retired_by: page?.frontmatter?.retired_by ?? null }];
    })));
    const afterFirst = { trust: await trustOf(engine, slugs, l.scrub), stamp: await stamp(),
      edges: (await derivedRowsFrom(engine, [{ table: 'pages', id: l.id(origin) }])).rows.map(row => `${l.label(row.table, row.id)} ${row.depth}`) };
    const second = await publish(['atoms/one']);
    const answers = {
      first: { state: first.state, retired: first.retired }, afterFirst,
      second: { state: second.state, retired: second.retired, samePin: second.pin === first.pin },
      afterSecond: { trust: await trustOf(engine, slugs, l.scrub), stamp: await stamp() },
    };
    expect(answers.first.state).toBe('published');
    expect(answers.afterFirst.edges).toEqual(['pages:atoms/one 1', 'pages:atoms/two 1']);
    expect(answers.afterSecond.stamp['atoms/two']).toEqual({ deleted: true, source_hash: true, retired_by: 'extract-atoms' });
    return answers;
  });

  parityTest('lowerTrustTier lowers facts, takes and timeline rows ranked above the tier, keeps the rest and never raises', {
    methods: ['putPage', 'transaction', 'insertFact', 'addTakesBatch', 'listTakes', 'addTimelineEntry', 'getTimeline', 'readRowTrustRows',
      'lowerTrustTier'],
  }, async (engine) => {
    const page = await engine.putPage('people/lower-example', { type: 'person', title: 'L', compiled_truth: 'L', timeline: '' });
    const fact = (text: string) => (tx: BrainEngine) =>
      tx.insertFact({ fact: text, entity_slug: 'people/lower-example', visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
    const take = (row_num: number, claim: string) => ({ page_id: page.id, row_num, claim, kind: 'take' as const, holder: 'h', weight: 0.5 });
    const seeds: Array<[TrustTier | null, string]> = [['operator_curated', 'curated'], ['external_untrusted', 'external'], [null, 'bare']];
    const factIds = new Map<number, string>();
    for (const [i, [tier, name]] of seeds.entries()) {
      const write = async (tx: BrainEngine) => {
        factIds.set((await fact(name)(tx)).id, name);
        await tx.addTakesBatch([take(i + 1, name)]);
        await tx.addTimelineEntry('people/lower-example', { date: `2026-08-0${i + 1}`, summary: name });
      };
      if (tier) await maintenanceTransaction(engine, write, trustAt(tier));
      else await write(engine);
    }
    const takeIds = new Map((await engine.listTakes({ page_id: page.id })).map(t => [Number(t.id), t.claim]));
    const entryIds = new Map((await engine.getTimeline('people/lower-example')).map(e => [Number(e.id), e.summary]));
    const tables = { facts: factIds, takes: takeIds, timeline_entries: entryIds } as const;
    const origin = { channel: 'derive:test' };
    const answers: Record<string, unknown> = {};
    for (const [table, names] of Object.entries(tables) as Array<[keyof typeof tables, Map<number, string>]>) {
      const ids = [...names.keys()];
      const lowered = await engine.lowerTrustTier(table, [...ids, Math.max(...ids) + 1000], 'agent_written', origin);
      const again = await engine.lowerTrustTier(table, ids, 'agent_written', origin);
      const rows = await engine.readRowTrustRows({ table, ids });
      answers[table] = {
        lowered: lowered.map(id => names.get(Number(id))),
        again: again.length,
        trust: Object.fromEntries(sorted(rows.map(r => [names.get(Number(r.id)), { tier: r.trust_tier, origin: r.write_origin }] as const), ([n]) => String(n))),
      };
    }
    answers.none = await engine.lowerTrustTier('facts', [], 'agent_written', origin);
    expect(answers.facts).toEqual({
      lowered: ['curated'], again: 0,
      trust: { bare: { tier: 'unknown', origin: null }, curated: { tier: 'agent_written', origin }, external: { tier: 'external_untrusted', origin: { channel: 'test:fixture' } } },
    });
    expect(answers.takes).toEqual(answers.facts);
    expect(answers.timeline_entries).toEqual(answers.facts);
    return answers;
  });
});
