/**
 * BrainEngine parity — the read-command statements the ops layer ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: scanExactBatch, nextLivePageAfter, listExactIdentityCandidates, rankEntities, listExtractionPendingPages,
 *    listUnattributedFacts and listWantedPages return the same observable result on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes what search_exact, whois, rank_entities,
 *    extraction_pending and wanted report; the Rust engine has no SQL, so each read has to exist as a typed method it
 *    can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none in the cases except `seedWantedLink`, harness-style SQL behind the backend switch (no typed member
 *    writes wanted_links alone; the Rust arm refuses listWantedPages, so it seeds nothing). Generated values (page ids,
 *    timestamps) are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, sorted, type ParityBackend } from './harness.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ExactScanOpts } from '../../src/core/search/exact-scan.ts';
import { EXTRACTION_PROVENANCE_KEY, EXTRACTION_STATUS_KEY, PROVENANCE_AUTO_EXTRACTED, STATUS_UNVERIFIED } from '../../src/core/extraction-review.ts';

const { parityTest } = parityArms(testBackends());

const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

function scan(extra: Partial<ExactScanOpts> = {}): ExactScanOpts {
  return { phrase: 'needle', excludeSlugPrefixes: [], excludePrivate: false, remote: false, limit: 10, deadlineMs: Date.now() + 60_000, sourceId: 'default', ...extra };
}

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: body, frontmatter });

/** Fixture: one wanted_links row from `originSlug` to a missing target. SQL arms only; see the header. */
async function seedWantedLink(engine: BrainEngine, backend: ParityBackend, originSlug: string, target: string, refKind: 'slug' | 'name', linkType = '') {
  switch (backend) {
    case 'rust':
      return;
    case 'pglite':
    case 'postgres': {
      const origin = await engine.getPage(originSlug);
      await engine.executeRaw(
        `INSERT INTO wanted_links (origin_page_id, source_id, producer, ref_kind, target_source_id, target_ref, link_type, context, checked_at)
         VALUES ($1, 'default', 'body', $2, 'default', $3, $4, '', now())`,
        [origin!.id, refKind, target, linkType],
      );
      return;
    }
  }
}

describe('engine parity: read-command statements', () => {
  parityTest('scanExactBatch returns each scoped page in id order with its matches or why its text is unreadable', { methods: ['scanExactBatch'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await seedPage(engine, { slug: 'notes/a', input: note('A', 'the needle is here'), chunks: [chunk(0, 'the needle is here'), chunk(1, 'and a Needle again')] });
    await seedPage(engine, { slug: 'notes/b', input: note('B', 'nothing to see'), chunks: [chunk(0, 'nothing to see')] });
    await engine.putPage('notes/pending', note('Pending', 'a needle not yet sealed'));
    await seedPage(engine, { slug: 'notes/elsewhere', input: note('Elsewhere', 'the needle'), chunks: [chunk(0, 'the needle')] }, { sourceId: 'other' });
    const view = (rows: Awaited<ReturnType<BrainEngine['scanExactBatch']>>) =>
      rows?.map(({ page_id: _id, ...row }) => row) ?? null;
    const all = await engine.scanExactBatch(scan(), 0, 100, 30_000);
    expect(all!.map(r => r.slug)).toEqual(['notes/a', 'notes/b', 'notes/pending']);
    const ids = all!.map(r => Number(r.page_id));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    const firstOnly = await engine.scanExactBatch(scan(), 0, 1, 30_000);
    const afterFirst = await engine.scanExactBatch(scan(), ids[0]!, 100, 30_000);
    const caseSensitive = await engine.scanExactBatch(scan({ caseSensitive: true }), 0, 100, 30_000);
    const noWord = await engine.scanExactBatch(scan({ phrase: '   ' }), 0, 100, 30_000);
    expect(noWord).toBeNull();
    return { all: view(all), firstOnly: view(firstOnly), afterFirst: view(afterFirst), caseSensitive: view(caseSensitive), noWord };
  });

  parityTest('nextLivePageAfter steps to the next live page in id order across sources, skipping deleted pages', { methods: ['nextLivePageAfter'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const a = await engine.putPage('notes/a', note('A', 'a'));
    await engine.putPage('notes/gone', note('Gone', 'gone'));
    const c = await engine.putPage('notes/c', note('C', 'c'), { sourceId: 'other' });
    await engine.softDeletePage('notes/gone');
    const next = await engine.nextLivePageAfter(Number(a.id));
    expect(next && Number(next.id)).toBe(Number(c.id));
    const last = await engine.nextLivePageAfter(Number(c.id));
    expect(last).toBeNull();
    return { next: next && { slug: next.slug, source_id: next.source_id }, last };
  });

  parityTest('listExactIdentityCandidates finds a person by title, slug basename and email inside the named sources and types', { methods: ['listExactIdentityCandidates'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/alice-example', note('Alice Example', 'a person', { email: 'alice@example.com' }, 'person'));
    await engine.putPage('people/bob-example', note('Bob Example', 'a person', { emails: ['bob@example.com'] }, 'person'));
    await engine.putPage('notes/alice-example', note('Alice Example', 'a note about her'));
    await engine.putPage('people/alice-example', note('Alice Example', 'other source'), { sourceId: 'other' });
    const read = (probes: Partial<Parameters<BrainEngine['listExactIdentityCandidates']>[0]['probes']>) => engine.listExactIdentityCandidates({
      probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: [], ...probes },
      sourceIds: ['default'], types: { types: ['person'], per_source: [] }, limit: 10,
    }).then(rows => sorted(rows, r => `${r.source_id}:${r.slug}`));
    const byTitle = await read({ titleKeys: ['alice example'], titleRaw: 'Alice Example' });
    const byBasename = await read({ basenames: ['alice-example'] });
    const byEmail = await read({ emails: ['bob@example.com'] });
    expect(byTitle.map(r => r.slug)).toEqual(['people/alice-example']);
    expect(byEmail.map(r => r.slug)).toEqual(['people/bob-example']);
    return { byTitle, byBasename, byEmail };
  });

  parityTest('rankEntities ranks entity pages by inbound links in scope', { methods: ['rankEntities'] }, async (engine) => {
    await engine.putPage('people/hub-example', note('Hub', 'hub', {}, 'person'));
    await engine.putPage('people/a-example', note('A', 'a', {}, 'person'));
    await engine.putPage('companies/acme-example', note('Acme', 'acme', {}, 'company'));
    await engine.addLink('people/a-example', 'people/hub-example', 'knows', 'knows');
    await engine.addLink('companies/acme-example', 'people/hub-example', 'employs', 'works_at');
    await engine.addLink('people/hub-example', 'companies/acme-example', 'works at', 'works_at');
    const rows = await engine.rankEntities({
      direction: 'in', types: { types: ['person', 'company'], per_source: [] }, sourceIds: ['default'],
      includeMentions: true, limit: 10, foldedCap: 5,
    }, 30_000);
    expect(rows[0]!.slug).toBe('people/hub-example');
    return rows;
  });

  parityTest('listExtractionPendingPages lists unverified auto-extracted pages in scope, newest first', { methods: ['listExtractionPendingPages'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const pending = { [EXTRACTION_PROVENANCE_KEY]: PROVENANCE_AUTO_EXTRACTED, [EXTRACTION_STATUS_KEY]: STATUS_UNVERIFIED, source: 'meetings/2026-04-03' };
    // The read serves sealed pages only (buildVisibilityClause), so each page is sealed; one stays unsealed.
    const sealedPage = (slug: string, fm: Record<string, unknown>, opts?: { sourceId?: string }) =>
      seedPage(engine, { slug, input: note(slug, 'body', fm, 'person'), chunks: [chunk(0, 'body')] }, opts);
    await sealedPage('people/older-example', pending);
    await sealedPage('people/newer-example', pending);
    await sealedPage('people/verified-example', { ...pending, [EXTRACTION_STATUS_KEY]: 'verified' });
    await engine.putPage('people/unsealed-example', note('Unsealed', 'u', pending, 'person'));
    await sealedPage('people/other-example', pending, { sourceId: 'other' });
    const view = (rows: Awaited<ReturnType<BrainEngine['listExtractionPendingPages']>>) => {
      for (const r of rows) expect(String(r.created_at)).toMatch(TS);
      return rows.map(({ created_at: _at, ...r }) => r);
    };
    const scoped = await engine.listExtractionPendingPages({ sourceId: 'default', limit: 10, offset: 0 });
    expect(scoped.map(r => r.slug)).toEqual(['people/newer-example', 'people/older-example']);
    const federated = await engine.listExtractionPendingPages({ sourceIds: ['default', 'other'], limit: 10, offset: 0 });
    const paged = await engine.listExtractionPendingPages({ sourceId: 'default', limit: 1, offset: 1 });
    return { scoped: view(scoped), federated: sorted(view(federated), r => `${r.source_id}:${r.slug}`), paged: view(paged) };
  });

  parityTest('listUnattributedFacts lists active facts with no entity, newest id first; worldOnly keeps world facts', { methods: ['listUnattributedFacts'] }, async (engine) => {
    for (const [fact, visibility] of [['first loose fact', 'world'], ['second loose fact', 'private'], ['third loose fact', 'world']] as const) {
      await engine.insertFact({ fact, entity_slug: null, visibility, source: 'mcp:remember', embedding: null }, { source_id: 'default' });
    }
    await engine.insertFact({ fact: 'an attributed fact', entity_slug: 'people/alice-example', visibility: 'world', source: 'mcp:remember', embedding: null }, { source_id: 'default' });
    const read = (worldOnly: boolean, limit = 10, offset = 0) => engine.listUnattributedFacts({ sourceIds: ['default'], worldOnly, excludePrivateProvenance: false, limit, offset })
      .then(rows => rows.map(({ id: _id, created_at, ...r }) => { expect(String(created_at)).toMatch(TS); return r; }));
    const all = await read(false);
    expect(all.map(r => r.fact)).toEqual(['third loose fact', 'second loose fact', 'first loose fact']);
    return { all, world: await read(true), paged: await read(false, 1, 1) };
  });

  parityTest('listWantedPages counts missing link targets in scope, most referenced first', { methods: ['listWantedPages'] }, async (engine, backend) => {
    await engine.putPage('notes/a', note('A', 'links to missing pages'));
    await engine.putPage('notes/b', note('B', 'links too'));
    await engine.putPage('people/carol-example', note('Carol', 'exists', {}, 'person'));
    await seedWantedLink(engine, backend, 'notes/a', 'people/missing-example', 'slug', 'mentions');
    await seedWantedLink(engine, backend, 'notes/b', 'people/missing-example', 'slug');
    await seedWantedLink(engine, backend, 'notes/a', 'carol-example', 'name');
    const { total, rows } = await engine.listWantedPages({ sourceId: 'default', limit: 10, offset: 0 });
    for (const r of rows) for (const at of [r.first_seen, r.last_checked]) expect(at === 'pending' || TS.test(at)).toBe(true);
    const view = rows.map(({ first_seen: _f, last_checked: _l, ...r }) => r);
    expect(total).toBe(2);
    expect(view[0]).toMatchObject({ target: 'people/missing-example', referenced_by: 2 });
    const paged = await engine.listWantedPages({ sourceId: 'default', limit: 1, offset: 1 });
    return { total, view, pagedTotal: paged.total, paged: paged.rows.map(r => r.target) };
  });
});
