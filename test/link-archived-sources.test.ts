/**
 * Link candidates exclude archived sources even while their pages are not deleted.
 * A smaller archived source must not win cross-source resolution, and an explicit
 * reference into it is missing_target. Live own/default preferences and the flag-off
 * policy remain intact. Existing cross-source suites only seed live sources.
 * Removing the archive filter selects the wrong endpoint or admits an explicit
 * archived target. These tests use production preparation/reconciliation and sweep
 * entry points with in-memory storage; no new production test seam is needed.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadLinkPageMetadata, lookupRefsForSlugs, reconcileSourceLinks } from '../src/core/link-reconciliation.ts';
import { LINK_ENDPOINTS_SQL, prepareAutomaticLinks } from '../src/core/persistence/links-preparation.ts';
import { loadActivePackForLocalEngine } from '../src/core/schema-pack/best-effort.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const sourceId = 'origin';
const slug = 'notes/origin';
const ON = { GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' };
const BODY = [
  'Unqualified [[topics/shared]] and explicit [[aaa-old:topics/shared]].',
  'Live qualified [[zzz-live:topics/qualified]]. Archived only [[topics/archived-only]].',
  'Own [[topics/local]] and configured default [[topics/preferred]].',
].join('\n');
const LIVE_EDGES = ['mmm-default:topics/preferred', 'origin:topics/local', 'zzz-live:topics/qualified', 'zzz-live:topics/shared'];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES
    ('aaa-old','aaa-old'),('zzz-live','zzz-live'),('origin','origin'),('mmm-default','mmm-default')`);
  await engine.setConfig('sources.default', 'mmm-default');
  for (const [source, target] of [
    ['aaa-old', 'topics/shared'], ['zzz-live', 'topics/shared'], ['zzz-live', 'topics/qualified'],
    ['aaa-old', 'topics/archived-only'], ['aaa-old', 'topics/local'], ['origin', 'topics/local'],
    ['aaa-old', 'topics/preferred'], ['mmm-default', 'topics/preferred'], ['zzz-live', 'topics/preferred'],
  ]) await engine.putPage(target, { type: 'note', title: target, compiled_truth: 'Target.' }, { sourceId: source });
  await engine.putPage(slug, { type: 'note', title: 'Origin', compiled_truth: BODY }, { sourceId });
  // Model the archive recovery window: source archived, pages still undeleted.
  await engine.executeRaw(`UPDATE sources SET archived=true, archived_at=now(),
    archive_expires_at=now() + interval '72 hours' WHERE id='aaa-old'`);
});

async function edges() {
  const rows = await engine.executeRaw<{ target: string }>(`SELECT t.source_id||':'||t.slug AS target
    FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.source_id=$1 AND f.slug=$2 ORDER BY target`, [sourceId, slug]);
  return rows.map(row => row.target);
}

async function prepare() {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const prepared = await prepareAutomaticLinks(engine, slug,
    { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, sourceId);
  return engine.transaction(async tx => { await tx.lockPageKeys(prepared.pageKeys); return prepared.apply(tx); });
}

test('whole-source and bounded endpoint loaders omit archived pages, including explicit source reads', async () => {
  expect(await engine.executeRaw(`SELECT slug FROM pages WHERE source_id='aaa-old' AND deleted_at IS NULL`)).toHaveLength(4);
  const pages = await loadLinkPageMetadata(engine);
  expect(pages.some(page => page.source_id === 'aaa-old')).toBe(false);
  expect(await loadLinkPageMetadata(engine, 'aaa-old')).toEqual([]);
  const refs = await lookupRefsForSlugs(engine, ['topics/shared', 'topics/archived-only']);
  expect([...refs.allSlugs]).toEqual(['topics/shared']);
  expect(refs.slugToSources.get('topics/shared')).toEqual(['zzz-live']);
  expect(refs.metadata.map(page => `${page.source_id}:${page.slug}`)).toEqual(['zzz-live:topics/shared']);
  const own = await engine.executeRaw<{ source_id: string }>(LINK_ENDPOINTS_SQL,
    ['aaa-old', ['topics/shared', 'topics/archived-only'], []]);
  expect(own.map(page => page.source_id)).toEqual(['zzz-live']);
});

test('put preparation chooses the live duplicate and keeps own/default preferences', () => withEnv(ON, async () => {
  expect(await prepare()).toMatchObject({ errors: 0, created: 4 });
  expect(await edges()).toEqual(LIVE_EDGES);
}));

test('source reconciliation reports explicit archived targets as missing without falling back', () => withEnv(ON, async () => {
  const pack = (await loadActivePackForLocalEngine(engine, { sourceId }))!.manifest;
  const result = await reconcileSourceLinks(engine, sourceId, { pack });
  expect(result.ok).toBe(true);
  expect(result.failures).toEqual([]);
  expect(await edges()).toEqual(LIVE_EDGES);
  expect(result.unresolved.filter(ref => ref.originSlug === slug).map(ref => [ref.target, ref.reason]).sort())
    .toEqual([['topics/archived-only', 'missing_target'], ['topics/shared', 'missing_target']]);
}));

test('maintenance sweep pass 2 chooses live targets from its bounded lookup', () => withEnv(ON, async () => {
  const report = await runMaintenanceSweep(engine, { sourceId, budgetMs: 30_000, corpus: false,
    capabilities: { embeddings: { available: false }, extraction: { available: false }, search: 'keyword-only', mode: 'keyless' } });
  expect(report.linksExtracted).toBe(4);
  expect(await edges()).toEqual(LIVE_EDGES);
}));

test('restoring the source makes its pages eligible again without changing their rows', () => withEnv(ON, async () => {
  await engine.executeRaw(`UPDATE sources SET archived=false WHERE id='aaa-old'`);
  expect(await prepare()).toMatchObject({ errors: 0 });
  expect(await edges()).toEqual(['aaa-old:topics/archived-only', 'aaa-old:topics/shared',
    'mmm-default:topics/preferred', 'origin:topics/local', 'zzz-live:topics/qualified']);
}));

test('cross-source resolution off still writes only the origin source target', () => withEnv(
  { GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '0' }, async () => {
    expect(await prepare()).toMatchObject({ errors: 0 });
    expect(await edges()).toEqual(['origin:topics/local']);
  }));
