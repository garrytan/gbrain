/**
 * Automatic link preparation shares one basename index per engine and source
 * and looks endpoints up in the origin source first.
 *
 * Protects: (1) two sources holding the same slugs, with cross-source links
 * off, on (`link_resolution.cross_source`) and through a federated origin,
 * keep exactly the edges, drop reasons (`cross_source` vs `missing_target`),
 * unresolved counts and wanted rows that the per-page slug read and the
 * slug-only endpoint query produced, for frontmatter, dir-qualified and bare
 * wikilink, markdown, source-qualified and renamed-slug forms; (2) the shared
 * index sees every page written after it was built (insert, rename, delete),
 * whether or not the write went through a page write path, and is reused
 * without a full slug read while the source is unchanged.
 * Fails when: the endpoint lookup is restricted to the origin source (cross
 * source drops turn into missing targets), or the index is served stale.
 * Seams: resolveCandidateSources is wrapped to record each candidate's
 * resolution; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import * as reconciliation from '../src/core/link-reconciliation.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { prepareAutomaticLinks } from '../src/core/persistence/links-preparation.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const resolveCandidateSources = reconciliation.resolveCandidateSources;
const ENV = { GBRAIN_LINK_RESOLUTION_GLOBAL_BASENAME: '1', GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined };

async function page(engine: BrainEngine, sourceId: string, slug: string, body = 'A page.', frontmatter: Record<string, unknown> = {}) {
  await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,frontmatter) VALUES($1,$2,'note',$3,$4,$5::jsonb)`,
    [sourceId, slug, slug.split('/').pop(), body, JSON.stringify(frontmatter)]);
}

/** Prepares and applies one page's automatic links, the way put_page's auto-link does. */
async function derive(engine: BrainEngine, sourceId: string, slug: string) {
  const resolutions: string[] = [];
  const spy = spyOn(reconciliation, 'resolveCandidateSources').mockImplementation((...args) => {
    const result = resolveCandidateSources(...args);
    resolutions.push([args[0].targetSlug, args[0].targetSourceId ?? '', result.ok ? `${result.fromSourceId}>${result.toSourceId}` : result.reason].join(' '));
    return result;
  });
  try {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const prepared = await prepareAutomaticLinks(engine, slug, { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, sourceId);
    const applied = await engine.transaction(async tx => { await tx.lockPageKeys(prepared.pageKeys); return prepared.apply(tx); });
    const edges = await engine.executeRaw<{ edge: string }>(`SELECT f.source_id||':'||f.slug||' > '||t.source_id||':'||t.slug||' '||l.link_type||' '||l.link_source AS edge
      FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
      WHERE (f.source_id=$1 AND f.slug=$2) OR (t.source_id=$1 AND t.slug=$2) ORDER BY 1`, [sourceId, slug]);
    return { edges: edges.map(row => row.edge), resolutions: [...new Set(resolutions)].sort(),
      unresolved: applied.unresolved_count, wanted: 'wanted' in applied ? applied.wanted : [] };
  } finally { spy.mockRestore(); }
}

const ORIGIN = [
  'Shared topic [[topics/shared]], qualified [[beta:topics/shared]] and [[beta:topics/beta-only]].',
  'Beta-only by wikilink [[topics/beta-only]] and by markdown [link](topics/beta-only).',
  'Basename forms: [[alice-example]], [[shared]], [[bob-example]].',
  'Renamed: [[projects/gadget]]. Missing: [[ideas/unwritten]].',
].join('\n');

async function crossSourceFixture(engine: BrainEngine) {
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('alpha','alpha','{}'),('beta','beta','{}')`);
  for (const source of ['alpha', 'beta']) await page(engine, source, 'topics/shared');
  await page(engine, 'alpha', 'people/alice-example');
  await page(engine, 'alpha', 'projects/widget');
  await engine.executeRaw(`INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES('alpha','projects/gadget','projects/widget')`);
  await page(engine, 'beta', 'topics/beta-only');
  await page(engine, 'beta', 'people/bob-example');
  await page(engine, 'alpha', 'notes/origin', ORIGIN, { related: ['topics/shared', 'topics/beta-only', 'beta:topics/beta-only', 'projects/gadget'] });
}

const EDGES = [
  'alpha:notes/origin > alpha:people/alice-example wikilink_basename wikilink-resolved',
  'alpha:notes/origin > alpha:projects/widget mentions markdown',
  'alpha:notes/origin > alpha:projects/widget related_to frontmatter',
  'alpha:notes/origin > alpha:topics/shared mentions markdown',
  'alpha:notes/origin > alpha:topics/shared related_to frontmatter',
  'alpha:notes/origin > alpha:topics/shared wikilink_basename wikilink-resolved',
];
const resolutions = (betaOnly: string, betaOnlyQualified: string, sharedQualified: string) => [
  'alice-example  missing_target', 'bob-example  missing_target', 'ideas/unwritten  missing_target', 'people/alice-example  alpha>alpha',
  'projects/gadget  missing_target', 'projects/widget  alpha>alpha', 'shared  missing_target', `topics/beta-only  ${betaOnly}`,
  `topics/beta-only beta ${betaOnlyQualified}`, 'topics/shared  alpha>alpha', `topics/shared beta ${sharedQualified}`,
];
const wanted = (...rows: string[]) => rows.map(row => ({ slug: row.split(':')[1], source_id: row.split(':')[0] }));
const POLICIES = [
  { name: 'cross-source links off', env: {}, federated: false, expected: { edges: EDGES, unresolved: 2,
    resolutions: resolutions('cross_source', 'cross_source', 'cross_source'),
    wanted: wanted('alpha:topics/beta-only', 'alpha:bob-example', 'alpha:ideas/unwritten', 'alpha:topics/beta-only') } },
  { name: 'link_resolution.cross_source on', env: { GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' }, federated: false, expected: { edges: EDGES, unresolved: 2,
    resolutions: resolutions('alpha>beta', 'alpha>beta', 'alpha>beta'),
    wanted: wanted('alpha:bob-example', 'alpha:ideas/unwritten', 'alpha:topics/beta-only', 'beta:topics/beta-only') } },
  { name: 'federated origin source', env: {}, federated: true, expected: { edges: EDGES, unresolved: 2,
    resolutions: resolutions('cross_source', 'alpha>beta', 'alpha>beta'),
    wanted: wanted('alpha:topics/beta-only', 'alpha:bob-example', 'alpha:ideas/unwritten', 'alpha:topics/beta-only', 'beta:topics/beta-only') } },
];

/** Basename-resolved targets of a page whose body is `body`, and how many full slug reads the preparation issued. */
async function basenameTargets(engine: BrainEngine, slug: string, body: string) {
  await engine.executeRaw(`UPDATE pages SET compiled_truth=$2 WHERE source_id='default' AND slug=$1`, [slug, body]);
  const reads = spyOn(engine, 'executeRaw');
  try {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const prepared = await prepareAutomaticLinks(engine, slug, { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, 'default');
    return { targets: prepared.pageKeys.map(key => key.slug).filter(key => key !== slug).sort(),
      fullReads: reads.mock.calls.filter(([sql]) => String(sql).includes('AS slugs FROM pages')).length };
  } finally { reads.mockRestore(); }
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`${backend}: cross-source link preparation`, () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); await crossSourceFixture(engine); }, 120_000);
    afterAll(async () => { await close(); });

    for (const policy of POLICIES) {
      test(`${policy.name}: edges, drop reasons, unresolved count and wanted rows`, () => withEnv({ ...ENV, ...policy.env }, async () => {
        await engine.executeRaw(`UPDATE sources SET config=$1::jsonb WHERE id='alpha'`, [JSON.stringify(policy.federated ? { federated: true } : {})]);
        expect(await derive(engine, 'alpha', 'notes/origin')).toEqual(policy.expected);
      }), 60_000);
    }
  });

  describe(`${backend}: the shared basename index`, () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      for (const slug of ['notes/first', 'notes/second', 'notes/third', 'topics/known']) await page(engine, 'default', slug);
    }, 120_000);
    afterAll(async () => { await close(); });

    test('a page written by this process after the index was built resolves by basename on the next preparation', () => withEnv(ENV, async () => {
      expect(await basenameTargets(engine, 'notes/first', 'See [[known]] and [[later-target]].')).toEqual({ targets: ['topics/known'], fullReads: 1 });
      expect(await basenameTargets(engine, 'notes/second', 'See [[known]].')).toEqual({ targets: ['topics/known'], fullReads: 0 });
      await importFromContent(engine, 'ideas/later-target', '---\ntitle: Later target\n---\nWritten after the index.\n', { noEmbed: true });
      expect(await basenameTargets(engine, 'notes/third', 'See [[later-target]].')).toEqual({ targets: ['ideas/later-target'], fullReads: 0 });
    }), 60_000);

    test('a write outside the page write paths, a rename and a hard delete are seen too', () => withEnv(ENV, async () => {
      await page(engine, 'default', 'ideas/raw-insert');
      expect(await basenameTargets(engine, 'notes/first', 'See [[raw-insert]].')).toEqual({ targets: ['ideas/raw-insert'], fullReads: 0 });
      await engine.updateSlug('ideas/raw-insert', 'ideas/renamed-insert', { sourceId: 'default' });
      expect(await basenameTargets(engine, 'notes/second', 'See [[raw-insert]] and [[renamed-insert]].'))
        .toEqual({ targets: ['ideas/renamed-insert'], fullReads: 1 });
      await engine.executeRaw(`DELETE FROM pages WHERE source_id='default' AND slug='ideas/renamed-insert'`);
      expect(await basenameTargets(engine, 'notes/third', 'See [[renamed-insert]] and [[known]].')).toEqual({ targets: ['topics/known'], fullReads: 1 });
    }), 60_000);
  });
}
