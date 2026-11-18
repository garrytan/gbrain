/**
 * The link temporal typed members called directly on a real PGLite brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member the seven link temporal sites call returns its
 *    declared shape on an empty brain and after one temporal link: keys for a
 *    page, stale keys, an origin's keys, the evidence read and state write,
 *    the origin rows apply, manual transition write and removal, the doctor's
 *    edge counts, page status by ref, record metadata rows and the three
 *    retrieval coverage counts.
 *  - Regression: a member that drops a field or returns the wrong container
 *    breaks its site (entity cards, doctor edge_validity, referrers, search
 *    coverage) with no parity arm to compare against on a PGLite-only run.
 *  - Why existing coverage misses it: test/engine-parity/link-temporal.test.ts
 *    reaches these members through the site functions, so a shape change the
 *    site tolerates goes unseen; this file pins each member's own result.
 *  - Seam: none. A fresh PGLite engine and the typed members only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { RelationshipKey } from '../src/core/link-relationships.ts';
import type { CoverageRelevance } from '../src/core/search/retrieval-coverage.ts';

const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const RELEVANCE: CoverageRelevance = { all: true, types: [], patterns: [], pageIds: [], exactTopPageId: null, imageArm: false };

let engine: PGLiteEngine;
let aliceId = 0;
let acmeId = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage(ALICE, { type: 'person', title: 'Alice', compiled_truth: 'Alice.', frontmatter: { status: 'active' } });
  await engine.putPage(ACME, { type: 'company', title: 'Acme', compiled_truth: 'Acme.' });
  const rows = await engine.executeRaw<{ id: number; slug: string }>(`SELECT id, slug FROM pages WHERE slug = ANY($1::text[])`, [[ALICE, ACME]]);
  aliceId = Number(rows.find(r => r.slug === ALICE)!.id);
  acmeId = Number(rows.find(r => r.slug === ACME)!.id);
});
afterAll(async () => { await engine.disconnect(); });

describe('link temporal typed members (PGLite)', () => {
  test('manual transitions write, key and remove one relationship', async () => {
    const rel = { from: ALICE, to: ACME, linkType: 'works_at', sourceId: 'default' };
    const written = await engine.writeManualLinkTransitions(rel, [{ kind: 'start', occurred_on: '2020-01-01' }]);
    expect(written.inserted).toBe(1);
    expect(written.key).toEqual({ from_page_id: aliceId, to_page_id: acmeId, link_type: 'works_at' });
    const missing = await engine.writeManualLinkTransitions({ ...rel, to: 'companies/no-such-page' }, [{ kind: 'start', occurred_on: '2020-01-01' }]);
    expect(missing).toEqual({ inserted: 0, key: null });

    const key = written.key as RelationshipKey;
    const evidence = await engine.readLinkRelationshipEvidence([key]);
    expect(evidence.assertions).toEqual([]);
    expect(evidence.existing).toEqual([]);
    expect(evidence.transitions.map(t => [t.link_type, t.kind, t.occurred_on, t.producer, t.origin_id])).toEqual([['works_at', 'start', '2020-01-01', 'manual', null]]);
    expect(await engine.staleLinkRelationshipKeys(10)).toEqual([key]);
    expect(await engine.writeLinkRelationshipState({ upserts: [], removals: [], changed: 0 })).toBe(0);

    const removed = await engine.removeManualLinkTransitions({ ...rel, databaseOnly: true });
    expect(removed).toEqual([key]);
  });

  test('key readers name the live works_at relationship by page and by origin', async () => {
    await engine.addLink(ALICE, ACME, 'Joined Acme', 'works_at', 'manual');
    expect(await engine.linkRelationshipKeysForPages([aliceId])).toEqual([{ from_page_id: aliceId, to_page_id: acmeId, link_type: 'works_at' }]);
    const key = { from_page_id: aliceId, to_page_id: acmeId, link_type: 'works_at' };
    expect(await engine.linkRelationshipKeysForOrigin(aliceId)).toEqual([key]);
    expect(await engine.linkRelationshipKeysForOrigin(acmeId)).toEqual([]);
  });

  test('applyLinkTemporalRows with no rows inserts nothing and keeps the live key', async () => {
    const applied = await engine.applyLinkTemporalRows({ pageId: aliceId, sourceId: 'default', tenseRows: [], transitions: [], explicitTargets: [] });
    // The origin still owns the live works_at link added above, so its key stays after the apply.
    expect(applied).toEqual({ inserted: [], liveTargets: [], keysAfter: [{ from_page_id: aliceId, to_page_id: acmeId, link_type: 'works_at' }] });
  });

  test('edgeValidityCounts: one live edge in the brain, none in an unknown source', async () => {
    const proposals = { proposed: 0, undated: 0, applied: 0 };
    expect(await engine.edgeValidityCounts({ staleLimit: 5 })).toEqual({ byStatus: [{ status: 'live', n: 1 }], stale: [], proposals });
    expect(await engine.edgeValidityCounts({ sourceIds: ['no-such-source'], staleLimit: 5 })).toEqual({ byStatus: [], stale: [], proposals });
  });

  test('page status and record metadata rows read by ref and by id', async () => {
    const status = await engine.listPageStatusByRef([{ source_id: 'default', slug: ALICE }, { source_id: 'default', slug: ACME }], { excludePrivate: false });
    expect(status.map(r => [r.source_id, r.slug, r.status])).toEqual([['default', ALICE, 'active']]);
    const meta = await engine.listRecordMetadataRows([aliceId], { referrerSources: ['default'], excludePrivate: false });
    expect(Array.isArray(meta.status)).toBe(true);
    expect(meta.links).toEqual([]);
  });

  test('retrieval coverage counts read the default scope: none held, both pending, no rebuild', async () => {
    expect(await engine.countEmbeddingHeldPages({}, RELEVANCE)).toEqual({ total: 0, could_affect: 0, capped: false });
    // Neither page has chunks yet, so both wait for projection.
    expect(await engine.countPendingProjectionPages({}, RELEVANCE)).toEqual({ total: 2, could_affect: 2, capped: false, could_affect_images: 0 });
    expect(await engine.projectionRebuildProgress({})).toBeNull();
  });
});
