/**
 * #7168: rank_entities — counting, folding, filters, validation and the
 * remote visibility contract, on PGLite.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { ALIAS_DERIVATION_VERSION, MENTION_EXTRACTOR_VERSION } from '../src/core/mentions/pass.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetPrivateVisibilityCacheForTests();
  await engine.executeRaw("INSERT INTO sources(id, name) VALUES ('source-a', 'source-a'), ('source-b', 'source-b') ON CONFLICT DO NOTHING");
});

const op = operations.find(o => o.name === 'rank_entities')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    dryRun: false,
    remote: false,
    sourceId: 'source-a',
    ...overrides,
  } as OperationContext;
}
const local = () => ctxOf();
const remote = () => ctxOf({ remote: true, transport: 'stdio', auth: { allowedSources: ['source-a'] } as any });

interface Row { slug: string; source_id: string; inbound: number; outbound: number; neighbors: number; folded?: Array<{ slug: string; reason: string }>; folded_total?: number }
async function rank(ctx: OperationContext, params: Record<string, unknown> = {}): Promise<{ entities: Row[]; coverage: { state: string }; note?: string; types_status: string }> {
  return await op.handler(ctx, { types: ['person', 'company'], ...params }) as any;
}
const brief = (rows: Row[]) => rows.map(r => ({ slug: r.slug, source_id: r.source_id, inbound: r.inbound, outbound: r.outbound, neighbors: r.neighbors, folded: r.folded ?? [] }));

async function page(slug: string, type: string, sourceId = 'source-a', frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, { type, title: slug.split('/').pop()!, compiled_truth: 'Synthetic page.', frontmatter } as any, { sourceId });
}
async function link(from: string, to: string, opts: { type?: string; source?: string; origin?: string; fromSource?: string; toSource?: string } = {}) {
  await engine.addLink(from, to, '', opts.type ?? 'references', opts.source ?? 'manual', opts.origin, undefined,
    { fromSourceId: opts.fromSource ?? 'source-a', toSourceId: opts.toSource ?? 'source-a', ...(opts.origin ? { originSourceId: opts.fromSource ?? 'source-a' } : {}) });
}

/** The base graph in source-a. */
async function seedBase() {
  for (const p of ['people/alice-example', 'people/bob-example', 'people/carol-example']) await page(p, 'person');
  await page('companies/acme-example', 'company');
  for (const n of ['notes/n1', 'notes/n2', 'notes/n3', 'notes/n4']) await page(n, 'note');
  await page('people/al-stub', 'person', 'source-a', { superseded_by: '[[people/alice-example|Alice]]' });
  for (const n of ['notes/n1', 'notes/n2', 'notes/n3']) await link(n, 'people/alice-example');
  await link('notes/n1', 'people/alice-example', { source: 'markdown' });
  for (const n of ['notes/n1', 'notes/n2']) { await link(n, 'people/bob-example'); await link(n, 'people/carol-example'); }
  await link('notes/n4', 'people/al-stub');
  await link('notes/n1', 'people/al-stub');
  await link('people/alice-example', 'companies/acme-example', { type: 'works_at' });
  await link('people/alice-example', 'companies/acme-example', { type: 'mentions', source: 'mentions' });
  await link('people/bob-example', 'companies/acme-example', { type: 'mentions', source: 'mentions' });
  await link('people/alice-example', 'people/alice-example');
}

describe('rank_entities counting', () => {
  test('ranks by inbound edges with deterministic ties, folding a redirect stub without double counting', async () => {
    await seedBase();
    const { entities } = await rank(local());
    expect(brief(entities)).toEqual([
      { slug: 'people/alice-example', source_id: 'source-a', inbound: 4, outbound: 1, neighbors: 5, folded: [{ slug: 'people/al-stub', reason: 'superseded_by' }] },
      { slug: 'companies/acme-example', source_id: 'source-a', inbound: 1, outbound: 0, neighbors: 1, folded: [] },
      { slug: 'people/bob-example', source_id: 'source-a', inbound: 2, outbound: 0, neighbors: 2, folded: [] },
      { slug: 'people/carol-example', source_id: 'source-a', inbound: 2, outbound: 0, neighbors: 2, folded: [] },
    ].sort((a, b) => b.inbound - a.inbound || (a.slug < b.slug ? -1 : 1)));
    expect(entities.some(r => r.slug === 'people/al-stub')).toBe(false);
    expect(entities[0]!.folded_total).toBe(1);
  });

  test('direction out and both pick the ranking key', async () => {
    await seedBase();
    const out = await rank(local(), { direction: 'out' });
    expect(brief(out.entities).map(r => [r.slug, r.outbound])).toEqual([['people/alice-example', 1]]);
    const both = await rank(local(), { direction: 'both' });
    expect(both.entities.map(r => [r.slug, r.inbound + r.outbound])).toEqual([
      ['people/alice-example', 5], ['people/bob-example', 2], ['people/carol-example', 2], ['companies/acme-example', 1],
    ]);
  });

  test('type filter, link_type filter and include_mentions', async () => {
    await seedBase();
    expect((await rank(local(), { types: ['company'] })).entities.map(r => r.slug)).toEqual(['companies/acme-example']);
    expect((await rank(local(), { link_type: 'works_at' })).entities.map(r => [r.slug, r.inbound])).toEqual([['companies/acme-example', 1]]);
    const withMentions = await rank(local(), { include_mentions: true, types: ['company'] });
    expect(brief(withMentions.entities)).toEqual([{ slug: 'companies/acme-example', source_id: 'source-a', inbound: 3, outbound: 0, neighbors: 2, folded: [] }]);
  });

  test('default types come from the schema pack entity types', async () => {
    await seedBase();
    const res = await op.handler(local(), {}) as any;
    expect(res.types_status).toBe('resolved');
    expect(res.entities.some((r: Row) => r.slug.startsWith('notes/'))).toBe(false);
    expect(res.entities[0].slug).toBe('people/alice-example');
  });

  test('self-links and links to or from deleted pages do not count', async () => {
    await seedBase();
    const before = brief((await rank(local(), { direction: 'both' })).entities);
    await page('notes/n5', 'note');
    await link('notes/n5', 'people/bob-example');
    await page('companies/gone-example', 'company');
    await link('people/alice-example', 'companies/gone-example');
    await link('people/carol-example', 'people/carol-example');
    await engine.softDeletePage('notes/n5', { sourceId: 'source-a' });
    await engine.softDeletePage('companies/gone-example', { sourceId: 'source-a' });
    expect(brief((await rank(local(), { direction: 'both' })).entities)).toEqual(before);
  });

  test('an edge that folds into a self-link is dropped', async () => {
    await seedBase();
    await link('people/al-stub', 'people/alice-example');
    const alice = (await rank(local(), { direction: 'both' })).entities.find(r => r.slug === 'people/alice-example')!;
    expect([alice.inbound, alice.outbound]).toEqual([4, 1]);
  });

  test('the same slug in two sources stays two rows; a stub folds only within its own source', async () => {
    await seedBase();
    await page('people/alice-example', 'person', 'source-b');
    await page('notes/b1', 'note', 'source-b');
    await page('people/al-stub', 'person', 'source-b', { superseded_by: 'people/alice-example' });
    await link('notes/b1', 'people/al-stub', { fromSource: 'source-b', toSource: 'source-b' });
    const { entities } = await rank(local(), { source_id: '__all__' });
    const alices = entities.filter(r => r.slug === 'people/alice-example');
    expect(alices.map(r => [r.source_id, r.inbound, r.folded?.map(f => f.slug)])).toEqual([
      ['source-a', 4, ['people/al-stub']], ['source-b', 1, ['people/al-stub']],
    ]);
    expect((await rank(local(), { source_id: 'source-b' })).entities.map(r => [r.slug, r.source_id])).toEqual([['people/alice-example', 'source-b']]);
  });

  test('limit caps rows after folding', async () => {
    await seedBase();
    expect((await rank(local(), { limit: 1 })).entities.map(r => r.slug)).toEqual(['people/alice-example']);
  });

  test('coverage says when link extraction is behind', async () => {
    await seedBase();
    const res = await rank(local());
    expect(res.coverage.state).toBe('behind');
    expect(res.note).toContain('counts cover only pages whose links are extracted');
  });

  test('an engine that refuses the coverage read refuses the ranking; a plain read error stays a degraded answer', async () => {
    await seedBase();
    // The coverage reads are the local typed lag count (readExtractionLagCounts) and the remote
    // typed coverage read (readRankCoverage); the ranking itself runs through other typed members,
    // so it is not refused here.
    const COVERAGE_READS = new Set<PropertyKey>(['readRankCoverage', 'readExtractionLagCounts']);
    const refusing = (err: Error) => new Proxy(engine, {
      get: (target, key) => COVERAGE_READS.has(key) ? async () => { throw err; } : Reflect.get(target, key, target),
    });
    const refusal = capabilityMissing('graph', 'readRankCoverage');
    for (const ctx of [ctxOf({ engine: refusing(refusal) as any }), ctxOf({ engine: refusing(refusal) as any, remote: true, transport: 'stdio', auth: { allowedSources: ['source-a'] } as any })]) {
      const err = await rank(ctx).then(() => null, (e: unknown) => e as { code?: string });
      expect(err?.code).toBe('engine_capability_missing');
    }
    const res = await rank(ctxOf({ engine: refusing(new Error('connection reset')) as any }));
    expect(res.coverage).toEqual({ state: 'unread', reason: 'read_failed' } as any);
  });
});

describe('rank_entities remote visibility', () => {
  test('private pages, private-origin links, quarantined pages and foreign-source pages change no remote counts, rows or folded entries', async () => {
    await seedBase();
    const baseline = brief((await rank(remote(), { direction: 'both' })).entities);
    expect(baseline).toEqual(brief((await rank(local(), { direction: 'both' })).entities));
    const cases: Array<[string, () => Promise<void>]> = [
      ['private page', async () => {
        await page('notes/secret', 'note', 'source-a', { visibility: 'private' });
        await link('notes/secret', 'people/bob-example');
        await page('people/private-person', 'person', 'source-a', { visibility: 'private' });
        await link('notes/n3', 'people/private-person');
      }],
      ['private-origin link', async () => {
        await page('notes/private-origin', 'note', 'source-a', { visibility: 'private' });
        await link('notes/n3', 'people/carol-example', { source: 'frontmatter', origin: 'notes/private-origin' });
      }],
      ['quarantined page', async () => {
        await page('notes/quarantined', 'note', 'source-a', { quarantine: 'synthetic' });
        await link('notes/quarantined', 'people/bob-example');
        await page('people/quarantined-person', 'person', 'source-a', { quarantine: 'synthetic' });
        await link('notes/n4', 'people/quarantined-person');
      }],
      ['foreign-source page', async () => {
        await page('notes/foreign', 'note', 'source-b');
        await link('notes/foreign', 'people/bob-example', { fromSource: 'source-b', toSource: 'source-a' });
        await page('people/foreign-person', 'person', 'source-b');
        await link('notes/foreign', 'people/foreign-person', { fromSource: 'source-b', toSource: 'source-b' });
      }],
      ['private redirect stub', async () => {
        await page('people/private-stub', 'person', 'source-a', { visibility: 'private', merged_into: 'people/bob-example' });
        await link('notes/n4', 'people/private-stub');
      }],
    ];
    for (const [label, seed] of cases) {
      const localBefore = brief((await rank(ctxOf({ sourceId: '__all__' }), { direction: 'both', source_id: '__all__' })).entities);
      await seed();
      const localAfter = brief((await rank(ctxOf({ sourceId: '__all__' }), { direction: 'both', source_id: '__all__' })).entities);
      expect({ label, changedLocally: JSON.stringify(localAfter) !== JSON.stringify(localBefore) }).toEqual({ label, changedLocally: true });
      expect({ label, rows: brief((await rank(remote(), { direction: 'both' })).entities) }).toEqual({ label, rows: baseline });
    }
  });

  test('a stub whose target is hidden stays unfolded remotely and never names the target', async () => {
    await seedBase();
    await page('people/hidden-target', 'person', 'source-a', { visibility: 'private' });
    await page('people/visible-stub', 'person', 'source-a', { superseded_by: 'people/hidden-target' });
    await link('notes/n1', 'people/visible-stub');
    const localRows = (await rank(local())).entities;
    expect(localRows.find(r => r.slug === 'people/hidden-target')?.folded).toEqual([{ slug: 'people/visible-stub', reason: 'superseded_by' }]);
    const remoteResult = await rank(remote());
    expect(JSON.stringify(remoteResult)).not.toContain('hidden-target');
    expect(remoteResult.entities.find(r => r.slug === 'people/visible-stub')).toMatchObject({ inbound: 1 });
  });

  test('remote coverage reports a state without page counts', async () => {
    await seedBase();
    const res = await rank(remote()) as any;
    expect(res.coverage).toEqual({ state: 'behind' });
    expect(Object.keys((await rank(local()) as any).coverage)).toContain('actionable');
  });

  test('pages the caller cannot read change local coverage and leave remote coverage current', async () => {
    await seedBase();
    const settle = async () => {
      await engine.executeRaw("UPDATE pages SET links_extracted_at = now() + interval '1 day'");
      await engine.executeRaw(`INSERT INTO page_mention_state (page_id, source_id, mention_revision, mention_version, alias_revision, alias_version)
        SELECT id, source_id, knowledge_revision, $1, knowledge_revision, $2 FROM pages ON CONFLICT (page_id) DO NOTHING`, [MENTION_EXTRACTOR_VERSION, ALIAS_DERIVATION_VERSION]);
    };
    await settle();
    const all = { source_id: '__all__' };
    const coverageOf = async (ctx: OperationContext, params: Record<string, unknown>) => (await rank(ctx, params) as any).coverage;
    for (const include_mentions of [false, true]) {
      expect((await coverageOf(ctxOf({ sourceId: '__all__' }), { ...all, include_mentions })).state).toBe('current');
      expect(await coverageOf(remote(), { include_mentions })).toEqual({ state: 'current' });
    }
    const cases: Array<[string, boolean, () => Promise<void>]> = [
      ['private page', true, () => page('notes/secret', 'note', 'source-a', { visibility: 'private' })],
      ['quarantined page', false, () => page('notes/quarantined', 'note', 'source-a', { quarantine: 'synthetic' })],
      ['foreign-source page', true, () => page('notes/foreign', 'note', 'source-b')],
    ];
    for (const [label, linkStale, seed] of cases) {
      await settle();
      await seed();
      const localState = async (include_mentions: boolean) => (await coverageOf(ctxOf({ sourceId: '__all__' }), { ...all, include_mentions })).state;
      expect({ label, links: await localState(false), mentions: await localState(true) })
        .toEqual({ label, links: linkStale ? 'behind' : 'current', mentions: 'behind' });
      for (const include_mentions of [false, true]) {
        expect({ label, include_mentions, coverage: await coverageOf(remote(), { include_mentions }) }).toEqual({ label, include_mentions, coverage: { state: 'current' } });
      }
    }
    await page('notes/readable', 'note');
    expect(await coverageOf(remote(), {})).toEqual({ state: 'behind' });
  });

  test('a source outside the grant answers not_found', async () => {
    await seedBase();
    await expect(rank(remote(), { source_id: 'source-b' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('rank_entities parameter validation', () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['direction', { direction: 'sideways' }],
    ['types', { types: 'person' }],
    ['types', { types: [] }],
    ['types', { types: ["person'; DROP TABLE links; --"] }],
    ['link_type', { link_type: "x' OR '1'='1" }],
    ['link_type', { link_type: 'amends' }],
    ['include_mentions', { include_mentions: 'yes' }],
    ['limit', { limit: 0 }],
    ['limit', { limit: 101 }],
    ['limit', { limit: 2.5 }],
    ['limit', { limit: '10' }],
    ['source_id', { source_id: '' }],
  ];
  for (const [param, params] of invalid) {
    test(`rejects ${param}=${JSON.stringify(params[param])} with a corrected example`, async () => {
      await seedBase();
      const err = await op.handler(local(), { types: ['person'], ...params }).then(() => null, e => e);
      expect(err).toBeInstanceOf(OperationError);
      expect(err.code).toBe('invalid_params');
      expect(err.suggestion).toContain('Example:');
    });
  }

  test('the links table survives an injection-shaped type', async () => {
    await seedBase();
    await op.handler(local(), { types: ["person'; DROP TABLE links; --"] }).catch(() => {});
    const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM links');
    expect(Number(row!.n)).toBeGreaterThan(0);
  });
});

describe('rank_entities possible duplicates', () => {
  async function seedDuplicate(stubFrontmatter: Record<string, unknown> = {}) {
    await engine.putPage('people/alice-zebraexample', { type: 'person', title: 'Alice Zebraexample', compiled_truth: 'Synthetic page.' } as any, { sourceId: 'source-a' });
    await engine.putPage('people/mayor-zebraexample', { type: 'person', title: 'Mayor Zebraexample', compiled_truth: 'Synthetic page.', frontmatter: stubFrontmatter } as any, { sourceId: 'source-a' });
    await page('notes/d1', 'note');
    await page('notes/d2', 'note');
    await link('notes/d1', 'people/alice-zebraexample');
    await link('notes/d2', 'people/alice-zebraexample');
    await link('notes/d1', 'people/mayor-zebraexample');
  }

  test('a title-prefixed duplicate is listed, never folded', async () => {
    await seedDuplicate();
    const res = await rank(local(), { types: ['person'] }) as any;
    expect(res.entities.map((r: Row) => [r.slug, r.inbound])).toEqual([['people/alice-zebraexample', 2], ['people/mayor-zebraexample', 1]]);
    expect(res.entities[0].possible_duplicates).toEqual([{ slug: 'people/mayor-zebraexample', title: 'Mayor Zebraexample', reason: 'title_prefix' }]);
    expect(res.duplicates_checked).toBe(2);
  });

  test('a private duplicate is not named to a remote caller', async () => {
    await seedDuplicate({ visibility: 'private' });
    expect((await rank(local(), { types: ['person'] }) as any).entities[0].possible_duplicates).toHaveLength(1);
    const res = await rank(remote(), { types: ['person'] }) as any;
    expect(JSON.stringify(res)).not.toContain('mayor-zebraexample');
  });
});
