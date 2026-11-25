/**
 * BrainEngine parity — the trust writes of a derived page generation answer PGLite's output on Postgres and on a Rust
 * brain: a single-page derivation publish (the dream summary of cycle/synthesize.ts), a derived retirement, and an atom
 * generation publish with its completion stamp and the retirement of an atom the extraction no longer produced.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each case gives the same answer on PGLite, Postgres and the Rust engine: the derivation's tier, origin
 *    and inputs (trust/taint.ts deriveTrust, a vanished or hidden input reads `unknown`), the stored tier and origin of
 *    each derived page, its recorded input edges and what is derived from a row through them
 *    (facts/derivation-inputs.ts), the explicit lowering of a page whose content did not change (lowerDerivedPage), the
 *    derived share doctor reads, the retirement stamp (`retired_by`, `retired_at`) on soft-deleted pages only with
 *    their tier and origin kept, and the atom completion stamp (`source_hash`).
 *  - Regression: these flows sent raw SQL (taint.ts, derived-retirement-hold.ts and the atom adapter's
 *    completeItems), so a Rust brain stopped on `raw_sql` at the first derived write: no dream summary, no retirement
 *    and no atom generation published there.
 *  - Rust arm on this branch: the retirement case matches PGLite. The derivation publish and the atoms publish record
 *    derivation edges (facts/derivation-inputs.ts), which still send raw SQL here, so those two cases stop on the
 *    typed `raw_sql` refusal (rust-tally.tsv). The derivation edges are typed on rust-engine/derivation-hide.
 *  - Why existing coverage misses it: generation-output-parity.test.ts publishes a single page with no derivation and
 *    reads atom inputs, but publishes no derivation, retires nothing and publishes no atom.
 *  - Seam: none. Typed members and the real generation paths only (no executeRaw: D18). Page ids differ between
 *    engines, so every answer names a page by its slug. Postgres runs when DATABASE_URL is set (testBackends); the
 *    Rust arm runs through test/engine-parity/harness.ts.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
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
  parityTest('lowerTrustTier refuses a tier that names no trust tier on every engine, whether or not a row would be lowered', {
    methods: ['putPage', 'getPage', 'readPageTrustRows', 'transaction', 'lowerTrustTier'],
  }, async (engine) => {
    // Before the refusal, the SQL engines ranked the bad name 0: they wrote it to every ranked row (and the tier CHECK
    // refused) or resolved [] when no row matched, while the Rust store refused every call.
    await putAt(engine, 'notes/ranked', 'operator_curated', 'a ranked page');
    const id = Number((await engine.getPage('notes/ranked'))!.id);
    const lower = (ids: number[]) => engine.lowerTrustTier('pages', ids, 'bogus' as TrustTier, null)
      .then((rows) => ({ rows }), (e: unknown) => ({ error: (e as Error).message }));
    const answers = { ranked: await lower([id]), missing: await lower([987_654_321]), none: await lower([]),
      kept: (await engine.readPageTrustRows({ keys: [{ source_id: 'default', slug: 'notes/ranked' }], includeDeleted: true }))[0]?.trust_tier ?? null };
    const refused = { error: 'lowerTrustTier: unknown trust tier "bogus"' };
    expect(answers).toEqual({ ranked: refused, missing: refused, none: { rows: [] }, kept: 'operator_curated' });
    return answers;
  });
});
