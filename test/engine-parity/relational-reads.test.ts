/**
 * BrainEngine parity — the relational recall arm's page reads (engine-sql/relational-reads.ts): which resolved seed
 * pages the caller's read policy admits, the title and bounded body prefix of each page the walk reached, and the
 * title seed that names a typed page.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readAdmittedPageRefs returns the same (source_id, slug) set on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): only live, unquarantined pages
 *    of an unarchived source that pass the policy's source scope, private-page filter and trust floor.
 *    readPageSynopses returns the same rows under the search visibility clause too: a served text projection and no
 *    pinned question; the synopsis is the first 65536 code points of the body. readSeedTitleSlugs returns at most two
 *    slugs of live, unretired pages of one source whose type is listed and whose title matches case-insensitively.
 *  - Regression: an engine that admits a seed the policy hides lets a "who works at" query walk the links of a
 *    private, deleted, quarantined, archived, out-of-scope or below-floor page and name what it links to (a leak).
 *    The Rust engine has no SQL, so the statement has to exist as a typed member.
 *  - Why existing coverage misses it: the statement ran through `executeRaw` inside search/relational-recall.ts,
 *    which the parity cases cannot call (D18).
 *  - Seam: none. Typed members only (no executeRaw: D18). Rows are compared sorted, since the SQL sets no order.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput, PageReadPolicy } from '../../src/core/types.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { buildRelationalArm } from '../../src/core/search/relational-recall.ts';

const { parityTest } = parityArms(testBackends());

const NOTE: PageInput = { type: 'company', title: 'Acme example', compiled_truth: 'A company.', timeline: '' };

/** Run `fn` in a transaction whose write trust settings declare `tier`. */
function declared<T>(engine: BrainEngine, tier: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
    return fn(tx);
  });
}

const key = (r: { source_id: string; slug: string }) => `${r.source_id}:${r.slug}`;

describe('engine parity: relational recall page reads', () => {
  parityTest('readAdmittedPageRefs admits only the seeds the read policy lets the caller read', {
    methods: ['putPage', 'softDeletePage', 'transaction', 'applyTransactionSettings', 'readAdmittedPageRefs'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'old');
    await engine.putPage('companies/open', NOTE);
    await engine.putPage('companies/private', { ...NOTE, frontmatter: { visibility: 'private' } });
    await engine.putPage('companies/alice', { ...NOTE, frontmatter: { readable_by: ['member:alice-example'] } });
    await engine.putPage('companies/held', { ...NOTE, frontmatter: { quarantine: { reason: 'test' } } });
    await engine.putPage('companies/gone', NOTE);
    await engine.softDeletePage('companies/gone');
    await declared(engine, 'external_untrusted', tx => tx.putPage('companies/outside', NOTE));
    await engine.putPage('companies/open', NOTE, { sourceId: 'other' });
    await engine.putPage('companies/archived', NOTE, { sourceId: 'old' });
    await archiveSource(engine, backend, 'old');
    const refs = [
      ...['open', 'private', 'alice', 'held', 'gone', 'outside', 'missing', 'open'].map(s => ({ source_id: 'default', slug: `companies/${s}` })),
      { source_id: 'other', slug: 'companies/open' },
      { source_id: 'old', slug: 'companies/archived' },
    ];
    const read = async (policy: PageReadPolicy) => sorted((await engine.readAdmittedPageRefs(refs, policy)).map(key)).filter((k, i, all) => all.indexOf(k) === i);
    const answers = {
      scoped: await read({ sourceId: 'default' }),
      federated: await read({ sourceIds: ['other'] }),
      hidden: await read({ excludePrivate: true }),
      member: await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => read({ excludePrivate: true })),
      floor: await read({ minTrust: 'unknown' }),
      holders: await read({ takesHoldersAllowList: [], requireSafeChunks: true }),
      none: await engine.readAdmittedPageRefs([], { sourceId: 'default' }),
    };
    const live = ['default:companies/alice', 'default:companies/open', 'default:companies/outside', 'default:companies/private', 'other:companies/open'];
    expect(answers).toEqual({
      scoped: ['default:companies/alice', 'default:companies/open', 'default:companies/outside', 'default:companies/private'],
      federated: ['other:companies/open'],
      hidden: ['default:companies/open', 'default:companies/outside', 'other:companies/open'],
      member: ['default:companies/alice', 'default:companies/open', 'default:companies/outside', 'other:companies/open'],
      floor: ['default:companies/alice', 'default:companies/open', 'default:companies/private', 'other:companies/open'],
      holders: live,
      none: [],
    });
    return answers;
  });

  parityTest('readPageSynopses hydrates only the reached pages the search visibility clause and read policy let the caller read', {
    methods: ['putPage', 'softDeletePage', 'transaction', 'applyTransactionSettings', 'sealChunks', 'getPage', 'readPageSynopses'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'old');
    // A page reads as searchable only once its chunks are sealed (a served text projection).
    const served = async (slug: string, input = NOTE, sourceId?: string) => {
      await engine.putPage(slug, input, sourceId ? { sourceId } : undefined);
      await installChunks(engine, slug, [chunk(0, slug)], sourceId ? { sourceId } : undefined);
    };
    const LONG = `${'é'.repeat(65530)}abcdefghij`;
    await served('companies/open');
    await served('companies/private', { ...NOTE, frontmatter: { visibility: 'private' } });
    await served('companies/alice', { ...NOTE, frontmatter: { readable_by: ['member:alice-example'] } });
    await served('companies/held', { ...NOTE, frontmatter: { quarantine: { reason: 'test' } } });
    await served('companies/pinned', { ...NOTE, frontmatter: { pinned_question: true } });
    await served('companies/long', { ...NOTE, compiled_truth: LONG });
    await served('companies/gone');
    await engine.softDeletePage('companies/gone');
    await engine.putPage('companies/unindexed', NOTE);
    await served('companies/stale');
    await engine.putPage('companies/stale', { ...NOTE, compiled_truth: 'Edited after the seal.' });
    await declared(engine, 'external_untrusted', async tx => { await tx.putPage('companies/outside', NOTE); });
    await installChunks(engine, 'companies/outside', [chunk(0, 'outside')]);
    await served('companies/open', NOTE, 'other');
    await served('companies/archived', NOTE, 'old');
    await archiveSource(engine, backend, 'old');
    const slugs = ['open', 'private', 'alice', 'held', 'pinned', 'long', 'gone', 'unindexed', 'stale', 'outside', 'missing'];
    const refs = [
      ...slugs.map(s => ({ source_id: 'default', slug: `companies/${s}` })),
      { source_id: 'other', slug: 'companies/open' },
      { source_id: 'old', slug: 'companies/archived' },
    ];
    const ids = new Map<string, number>();
    for (const r of refs) {
      const page = await engine.getPage(r.slug, { sourceId: r.source_id });
      if (page) ids.set(key(r), Number(page.id));
    }
    // page_id is each arm's own serial: compare it to the arm's getPage id.
    const read = async (policy?: PageReadPolicy) => sorted((await engine.readPageSynopses(refs, policy)).map(r => [
      key(r), r.title, r.type, Number(r.page_id) === ids.get(key(r)),
      r.synopsis == null ? null : `${[...r.synopsis].length}:${r.synopsis.slice(-12)}`,
    ].join('|')));
    const answers = {
      none: await read(),
      scoped: await read({ sourceId: 'default' }),
      federated: await read({ sourceIds: ['other'] }),
      hidden: await read({ excludePrivate: true }),
      member: await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => read({ excludePrivate: true })),
      floor: await read({ minTrust: 'unknown' }),
      empty: await engine.readPageSynopses([], { sourceId: 'default' }),
    };
    const row = (k: string, synopsis = '10:A company.') => `${k}|Acme example|company|true|${synopsis}`;
    const open = row('default:companies/open');
    const alice = row('default:companies/alice');
    const priv = row('default:companies/private');
    const outside = row('default:companies/outside');
    const long = row('default:companies/long', '65536:ééééééabcdef');
    const other = row('other:companies/open');
    expect(answers.none).toEqual(sorted([open, alice, priv, outside, long, other]));
    expect(answers.scoped).toEqual(sorted([open, alice, priv, outside, long]));
    expect(answers.federated).toEqual([other]);
    expect(answers.hidden).toEqual(sorted([open, outside, long, other]));
    expect(answers.member).toEqual(sorted([open, alice, outside, long, other]));
    expect(answers.floor).toEqual(sorted([open, alice, priv, long, other]));
    expect(answers.empty).toEqual([]);
    return answers;
  });

  parityTest('readSeedTitleSlugs names at most two live, unretired pages of the listed types whose title matches', {
    methods: ['putPage', 'softDeletePage', 'readSeedTitleSlugs'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const page = (title: string, type: PageInput['type'] = 'company', frontmatter: Record<string, unknown> = {}): PageInput => ({ ...NOTE, title, type, frontmatter });
    await engine.putPage('companies/acme', page('Acme Example'));
    await engine.putPage('people/acme', page('acme example', 'person'));
    await engine.putPage('companies/widget-a', page('Widget Co'));
    await engine.putPage('companies/widget-b', page('WIDGET CO'));
    await engine.putPage('companies/widget-c', page('Widget Co', 'concept'));
    await engine.putPage('companies/gone', page('Gone Co'));
    await engine.softDeletePage('companies/gone');
    await engine.putPage('companies/merged', page('Merged Co', 'company', { merged_into: 'companies/acme' }));
    await engine.putPage('companies/alias', page('Alias Co', 'company', { status: 'Alias of acme' }));
    await engine.putPage('companies/aliased', page('Aliased Co', 'company', { status: 'aliased' }));
    await engine.putPage('companies/noncanon', page('Noncanon Co', 'company', { canonical: 'No' }));
    await engine.putPage('companies/super', page('Super Co', 'company', { superseded_by: '  ' }));
    await engine.putPage('companies/elsewhere', page('Elsewhere Co'), { sourceId: 'other' });
    const read = async (title: string, types = ['company'], sourceId = 'default') => sorted(await engine.readSeedTitleSlugs(sourceId, types, title));
    const answers = {
      acme: await read('ACME example'),
      acmeBoth: await read('acme EXAMPLE', ['company', 'person']),
      widget: await read('widget co', ['company', 'concept']),
      gone: await read('Gone Co'),
      merged: await read('Merged Co'),
      alias: await read('Alias Co'),
      aliased: await read('Aliased Co'),
      noncanon: await read('Noncanon Co'),
      blankSuperseded: await read('Super Co'),
      elsewhere: await read('Elsewhere Co'),
      elsewhereOther: await read('Elsewhere Co', ['company'], 'other'),
      untrimmed: await read(' Acme Example'),
      noTypes: await read('Acme Example', []),
    };
    expect(answers.acme).toEqual(['companies/acme']);
    expect(answers.acmeBoth).toEqual(['companies/acme', 'people/acme']);
    expect(answers.widget).toHaveLength(2);
    expect(answers.gone).toEqual([]);
    expect(answers.merged).toEqual([]);
    expect(answers.alias).toEqual([]);
    expect(answers.aliased).toEqual(['companies/aliased']);
    expect(answers.noncanon).toEqual([]);
    expect(answers.blankSuperseded).toEqual(['companies/super']);
    expect(answers.elsewhere).toEqual([]);
    expect(answers.elsewhereOther).toEqual(['companies/elsewhere']);
    expect(answers.untrimmed).toEqual([]);
    expect(answers.noTypes).toEqual([]);
    // Which two of three matching pages answer is unordered; compare only the count across arms.
    return { ...answers, widget: answers.widget.length };
  });

  parityTest('the relational arm walks only the seeds the read policy admits: a private seed in one source leaks nothing', {
    methods: ['putPage', 'addLink', 'readAdmittedPageRefs', 'readPageSynopses'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'team');
    await createSource(engine, backend, 'attic');
    // One phrase resolves a seed in each source: a world page in `team`, a private page in `attic`.
    await engine.putPage('companies/widget-co', { ...NOTE, title: 'Widget Co' }, { sourceId: 'team' });
    await engine.putPage('companies/widget-co', { ...NOTE, title: 'Widget Co', frontmatter: { visibility: 'private' } }, { sourceId: 'attic' });
    // Each investor is a world page whose only connection to the company is the typed edge.
    for (const [slug, sourceId] of [['people/alice-example', 'team'], ['people/bob-example', 'attic']] as const) {
      await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: 'An investor.', timeline: '' }, { sourceId });
      await installChunks(engine, slug, [chunk(0, 'An investor.')], { sourceId });
      await engine.addLink(slug, 'companies/widget-co', '', 'invested_in', 'manual', undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
    }
    // `seeds` counts the seeds the arm admitted, so the case fails when the admit lets the private seed through,
    // even though the fanout's own read filter would still drop what it links to.
    const arm = async (opts: NonNullable<Parameters<typeof buildRelationalArm>[2]>) => {
      let seeds = -1;
      const rows = await buildRelationalArm(engine, 'who invested in widget-co', { ...opts, onMeta: m => { seeds = m.seeds_resolved; } });
      return { seeds, rows: sorted(rows.map(r => `${r.slug}<-${r.relational_seed}`)) };
    };
    const answers = {
      trusted: await arm({ sourceIds: ['team', 'attic'] }),
      hidden: await arm({ sourceIds: ['team', 'attic'], excludePrivate: true }),
    };
    expect(answers).toEqual({
      trusted: { seeds: 2, rows: ['people/alice-example<-companies/widget-co', 'people/bob-example<-companies/widget-co'] },
      hidden: { seeds: 1, rows: ['people/alice-example<-companies/widget-co'] },
    });
    return answers;
  });
});
