/**
 * BrainEngine parity — the read-command statements the ops layer ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: scanExactBatch, nextLivePageAfter, listExactIdentityCandidates, rankEntities, listExtractionPendingPages,
 *    listUnattributedFacts, listWantedPages, readRankCoverage, readExactSnippetChunks and listExactRescanChunks return the same observable result on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes what search_exact, whois, rank_entities,
 *    extraction_pending and wanted report; the Rust engine has no SQL, so each read has to exist as a typed method it
 *    can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - The phone cases pin the phone arm (every stored value shape) and the whole whois op by phone, country code
 *    setting and remote privacy included, so a store that drops or widens the phone arm shows up on its own arm.
 *  - Seam: none; wanted rows are seeded through the typed `replaceWantedLinkRows` on every arm. Generated values
 *    (page ids, timestamps) are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { chunk, installChunks, seedPage } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import type { ExactScanOpts } from '../../src/core/search/exact-scan.ts';
import type { RankEntitiesStatementOpts } from '../../src/core/engine-sql/graph-rank.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { EXTRACTION_PROVENANCE_KEY, EXTRACTION_STATUS_KEY, PROVENANCE_AUTO_EXTRACTED, STATUS_UNVERIFIED } from '../../src/core/extraction-review.ts';

const { parityTest } = parityArms(testBackends());

const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

function scan(extra: Partial<ExactScanOpts> = {}): ExactScanOpts {
  return { phrase: 'needle', excludeSlugPrefixes: [], excludePrivate: false, remote: false, limit: 10, deadlineMs: Date.now() + 60_000, sourceId: 'default', ...extra };
}

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: body, frontmatter });

/** Fixture: the body-producer wanted rows of `originSlug`, written through the typed member on every arm. */
async function seedWantedLinks(engine: BrainEngine, originSlug: string, targets: Array<{ target: string; refKind: 'slug' | 'name'; linkType?: string }>) {
  const origin = await engine.getPage(originSlug, { sourceId: 'default' });
  const rows = targets.map(t => ({ producer: 'body' as const, ref_kind: t.refKind, target_source_id: 'default', target_ref: t.target, link_type: t.linkType ?? '', context: '' }));
  await engine.replaceWantedLinkRows({ pageId: Number(origin!.id), sourceId: 'default' }, { rows, producers: ['body'], readAt: '2026-01-02T03:04:05.678Z' });
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

  parityTest('scanExactBatch applies the scope filters, the [[:space:]] class, the database case rules and the snippet window', { methods: ['scanExactBatch'] }, async (engine, backend) => {
    await createSource(engine, backend, 'old');
    const sealed = (slug: string, texts: string[], extra: { type?: string; frontmatter?: Record<string, unknown>; sourceId?: string } = {}) =>
      seedPage(engine, { slug, input: note(slug, texts.join(' '), extra.frontmatter ?? {}, extra.type ?? 'note'), chunks: texts.map((t, i) => chunk(i, t)) },
        extra.sourceId ? { sourceId: extra.sourceId } : undefined);
    // No U+0085 input: whether it is [[:space:]] depends on the Postgres locale (ICU yes, libc C.UTF-8 / en_US.utf8 no).
    await sealed('notes/runs', ['the \t\n  needle in a whitespace run']);
    await sealed('notes/nbsp', ['the\u00a0needle behind a no-break space']);
    await sealed('notes/many', ['needle one', 'two', 'needle three', 'NEEDLE four', 'needle five']);
    await sealed('notes/long', [`${'a'.repeat(200)} needle ${'b'.repeat(40)} needle ${'c'.repeat(200)}`]);
    await sealed('notes/kelvin', ['\u212aelvin sign, then KELVIN']);
    await sealed('notes/kelvin-sign', ['only the \u212aelvin sign']);
    await sealed('notes/dotted', ['\u0130stanbul and istanbul']);
    await sealed('notes/dotted-only', ['only \u0130stanbul']);
    await sealed('notes/dotless-only', ['only istanbul']);
    await sealed('notes/skip-me', ['the needle']);
    await sealed('notes/quarantined', ['the needle'], { frontmatter: { quarantine: 'held' } });
    await sealed('notes/pinned', ['the needle'], { frontmatter: { pinned_question: 'why' } });
    await sealed('people/needle-example', ['the needle'], { type: 'person' });
    await sealed('notes/archived', ['the needle'], { sourceId: 'old' });
    await archiveSource(engine, backend, 'old');
    await seedPage(engine, { slug: 'notes/unchunked', input: note('Unchunked', 'a needle with no chunks'), chunks: [] });
    const run = async (extra: Partial<ExactScanOpts>) => {
      const rows = await engine.scanExactBatch(scan(extra), 0, 100, 30_000);
      return rows!.map(({ page_id: _id, ...row }) => row);
    };
    return {
      phrase: await run({ phrase: 'the needle' }),
      single: await run({ phrase: 'needle', excludeSlugPrefixes: ['notes/skip', ''] }),
      prefix: await run({ phrase: 'needle', slugPrefix: 'people/' }),
      types: await run({ phrase: 'needle', types: ['person'] }),
      federated: await run({ phrase: 'needle', sourceId: undefined, sourceIds: ['default', 'old'] }),
      kelvin: await run({ phrase: 'kelvin' }),
      kelvinSign: await run({ phrase: '\u212aelvin' }),
      kelvinCased: await run({ phrase: 'KELVIN', caseSensitive: true }),
      dotted: await run({ phrase: 'istanbul' }),
      dottedUpper: await run({ phrase: '\u0130STANBUL' }),
    };
  });

  parityTest('scanExactBatch for a remote caller reads only safe-fenced chunks', { methods: ['scanExactBatch'] }, async (engine) => {
    await seedPage(engine, { slug: 'notes/a', input: note('A', 'the needle'), chunks: [chunk(0, 'the needle')] });
    // The store does not mark the safe-chunk fence: on the Rust arm this call is its typed refusal.
    const rows = await engine.scanExactBatch(scan({ remote: true }), 0, 100, 30_000);
    return rows!.map(({ page_id: _id, ...row }) => row);
  });

  parityTest('scanExactBatch with excludePrivate leaves out private pages', { methods: ['scanExactBatch'] }, async (engine) => {
    await seedPage(engine, { slug: 'notes/open', input: note('Open', 'the needle'), chunks: [chunk(0, 'the needle')] });
    await seedPage(engine, { slug: 'notes/closed', input: note('Closed', 'the needle', { visibility: 'private' }), chunks: [chunk(0, 'the needle')] });
    // The store keeps no private visibility: on the Rust arm this call is its typed refusal.
    const rows = await engine.scanExactBatch(scan({ excludePrivate: true }), 0, 100, 30_000);
    expect(rows!.map(r => r.slug)).toEqual(['notes/open']);
    return rows!.map(({ page_id: _id, ...row }) => row);
  });

  parityTest('scanExactBatch for a remote caller with excludePrivate applies the caller\'s page policy and the safe-chunk fence', { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'scanExactBatch'] }, async (engine) => {
    const pages: Array<[string, Record<string, unknown>]> = [
      ['notes/open', {}], ['notes/private', { visibility: 'private' }], ['notes/readers', { readable_by: ['alice-example'] }],
      ['notes/lineage', { derived_from: 'notes/private.md' }], ['notes/fence-short', {}],
    ];
    for (const [slug, frontmatter] of pages) {
      const text = `the needle in ${slug}`;
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text, timeline: '', frontmatter });
      await installChunks(engine, slug, [chunk(0, text)]);
    }
    await engine.setChunkerVersion('notes/fence-short', 3);
    const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () =>
      (await engine.scanExactBatch(scan({ remote: true, excludePrivate: true }), 0, 100, 30_000))!.map(({ page_id: _id, ...row }) => row));
    const plain = await read({ hidePrivate: true });
    const member = await read({ identity: ['member:alice-example'], hidePrivate: true });
    const granted = await read({ privateReadableSources: ['default'], hidePrivate: true });
    const unrestricted = await read({ restricted: false, hidePrivate: true });
    const matched = (rows: typeof plain) => rows.filter(r => r.matching_chunks).map(r => r.slug);
    expect(matched(plain)).toEqual(['notes/open']);
    // A hidden page leaves no row at all, so no count or gap shows it; the page below the fence is unsealed.
    expect(plain.map(r => `${r.slug}:${r.gap}`)).toEqual(['notes/open:null', 'notes/fence-short:unsealed']);
    expect(JSON.stringify(plain)).not.toContain('notes/private');
    expect(matched(member)).toEqual(['notes/open', 'notes/readers']);
    expect(matched(granted)).toEqual(['notes/open', 'notes/private', 'notes/lineage']);
    expect(unrestricted).toEqual(plain);
    return { plain, member, granted, unrestricted };
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

  parityTest('listExactIdentityCandidates reads email arrays, folds title case, skips archived and (remote) quarantined pages', { methods: ['listExactIdentityCandidates'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'old');
    await engine.putPage('people/carol-example', note('\u00c9cole Carol', 'p', { email: ['carol@example.com', 'c@example.com'], aliases: ['Caz'] }, 'person'));
    await engine.putPage('people/dan-example', note('Dan', 'p', { emails: 'dan@example.com', email: 7 }, 'person'));
    await engine.putPage('people/held-example', note('Held', 'p', { email: 'held@example.com', quarantine: 'yes' }, 'person'));
    await engine.putPage('companies/carol-example', note('Carol Co', 'c', {}, 'company'), { sourceId: 'other' });
    await engine.putPage('people/carol-example', note('Carol Other', 'p', {}, 'person'), { sourceId: 'other' });
    await engine.putPage('people/carol-example', note('Carol Old', 'p', {}, 'person'), { sourceId: 'old' });
    await archiveSource(engine, backend, 'old');
    const read = (probes: Partial<Parameters<BrainEngine['listExactIdentityCandidates']>[0]['probes']>, extra: Partial<Parameters<BrainEngine['listExactIdentityCandidates']>[0]> = {}) =>
      engine.listExactIdentityCandidates({
        probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: [], ...probes },
        sourceIds: ['default', 'other', 'old'], types: { types: ['person'], per_source: [{ source_id: 'other', types: ['company'] }] }, limit: 10, ...extra,
      });
    return {
      arrayEmail: await read({ emails: ['c@example.com'] }),
      stringEmails: await read({ emails: ['dan@example.com'] }),
      numberEmail: await read({ emails: ['7'] }),
      foldedTitle: await read({ titleRaw: '\u00e9COLE CAROL' }),
      basename: await read({ basenames: ['carol-example'] }),
      limited: await read({ basenames: ['carol-example'] }, { limit: 1 }),
      local: await read({ emails: ['held@example.com'] }),
      remote: await read({ emails: ['held@example.com'] }, { remote: { excludePrivate: false } }),
      aliasOnly: await read({ aliasKeys: ['caz'] }),
    };
  });

  parityTest('listExactIdentityCandidates finds a person by a page alias row inside the named sources, live pages only', { methods: ['listExactIdentityCandidates', 'setPageAliases', 'replaceDerivedAliases', 'softDeletePage'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/alice-example', note('Alice Example', 'a person', {}, 'person'));
    await engine.putPage('people/gone-example', note('Gone Example', 'a person', {}, 'person'));
    await engine.putPage('notes/alice-note', note('Alice Note', 'a note'));
    await engine.putPage('people/other-alice', note('Other Alice', 'a person', {}, 'person'), { sourceId: 'other' });
    await engine.setPageAliases('people/alice-example', 'default', ['alice', 'ae']);
    await engine.replaceDerivedAliases('people/gone-example', 'default', [{ alias_norm: 'alice', origin: 'declared', case_sensitive: false, alias_text: 'Alice' }]);
    await engine.setPageAliases('notes/alice-note', 'default', ['alice']);
    await engine.setPageAliases('people/other-alice', 'other', ['alice']);
    await engine.setPageAliases('people/nobody-example', 'default', ['alice']);
    await engine.softDeletePage('people/gone-example');
    const read = (aliasKeys: string[], sourceIds = ['default']) => engine.listExactIdentityCandidates({
      probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys, emails: [] },
      sourceIds, types: { types: ['person'], per_source: [] }, limit: 10,
    });
    const byAlias = await read(['alice']);
    expect(byAlias.map(r => r.slug)).toEqual(['people/alice-example']);
    return {
      byAlias,
      bothSources: await read(['alice'], ['default', 'other']),
      secondKey: await read(['nope', 'ae']),
      missing: await read(['nope']),
      // Postgres refuses a NUL byte in any text parameter; the store refuses it the same way.
      nul: await read(['al\u0000ice']).then(() => 'read', (e: Error) => e.message.slice(e.message.indexOf('invalid byte sequence'))),
      nulTitle: await engine.listExactIdentityCandidates({
        probes: { titleKeys: [], titleRaw: 'Al\u0000ice', basenames: [], aliasKeys: [], emails: [] },
        sourceIds: ['default'], types: { types: ['person'], per_source: [] }, limit: 10,
      }).then(() => 'read', (e: Error) => e.message.slice(e.message.indexOf('invalid byte sequence'))),
    };
  });

  parityTest('listExactIdentityCandidates for a remote caller with excludePrivate leaves out private and reader-named pages before the limit', { methods: ['listExactIdentityCandidates'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    // The hidden pages sort first (source, then slug), so a filter after the limit would return nothing.
    await engine.putPage('people/erin-example', note('Erin', 'p', { visibility: 'private' }, 'person'));
    await engine.putPage('people/erin-example', note('Erin', 'p', { readable_by: ['alice-example'] }, 'person'), { sourceId: 'other' });
    await engine.putPage('team/erin-example', note('Erin', 'p', {}, 'person'), { sourceId: 'other' });
    const read = (remote: { excludePrivate: boolean } | undefined, limit = 10) => engine.listExactIdentityCandidates({
      probes: { titleKeys: [], titleRaw: '', basenames: ['erin-example'], aliasKeys: [], emails: [] },
      sourceIds: ['default', 'other'], types: { types: ['person'], per_source: [] }, ...(remote ? { remote } : {}), limit,
    }).then(rows => rows.map(r => `${r.source_id}:${r.slug}`));
    const local = await read(undefined);
    const hidden = await read({ excludePrivate: true });
    const limited = await read({ excludePrivate: true }, 1);
    const member = await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => read({ excludePrivate: true }));
    const granted = await withCallerAccess({ identity: ['member:bob-example'], privateReadableSources: ['default'], hidePrivate: true }, () => read({ excludePrivate: true }));
    expect(local).toEqual(['default:people/erin-example', 'other:people/erin-example', 'other:team/erin-example']);
    expect(hidden).toEqual(['other:team/erin-example']);
    expect(limited).toEqual(['other:team/erin-example']);
    expect(member).toEqual(['other:people/erin-example', 'other:team/erin-example']);
    expect(granted).toEqual(['default:people/erin-example', 'other:team/erin-example']);
    return { local, hidden, limited, member, granted };
  });

  parityTest('listExactIdentityCandidates finds a page by its phone digits in every value shape, and emailsOnly drops the phone and title arms', { methods: ['listExactIdentityCandidates'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'old');
    await engine.putPage('people/alice-example', note('Alice Example', 'p', { phone: '+1 (415) 555-0100', email: 'alice@example.com' }, 'person'));
    await engine.putPage('people/bob-example', note('Bob Example', 'p', { phones: ['415.555.0199', 4155550142] }, 'person'));
    await engine.putPage('people/carol-example', note('Carol Example', 'p', { phone: 4155550123 }, 'person'));
    await engine.putPage('people/dan-example', note('Dan Example', 'p', { phones: [['415 555 0177'], { work: '415 555 0188' }, null, true] }, 'person'));
    await engine.putPage('people/erin-example', note('Erin Example', 'p', { phone: null, phones: [] }, 'person'));
    await engine.putPage('people/held-example', note('Held Example', 'p', { phone: '415-555-0166', quarantine: 'yes' }, 'person'));
    await engine.putPage('notes/alice-phone', note('Alice Phone', 'a note', { phone: '+1 (415) 555-0100' }));
    await engine.putPage('companies/alice-example', note('Alice Co', 'c', { phone: '(415) 555-0100' }, 'company'), { sourceId: 'other' });
    await engine.putPage('people/alice-example', note('Alice Old', 'p', { phone: '415 555 0100' }, 'person'), { sourceId: 'old' });
    await archiveSource(engine, backend, 'old');
    const read = (probes: Partial<Parameters<BrainEngine['listExactIdentityCandidates']>[0]['probes']>, extra: Partial<Parameters<BrainEngine['listExactIdentityCandidates']>[0]> = {}) =>
      engine.listExactIdentityCandidates({
        probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: [], ...probes },
        sourceIds: ['default', 'other', 'old'], types: { types: ['person'], per_source: [{ source_id: 'other', types: ['company'] }] }, limit: 10, ...extra,
      });
    const slugs = (rows: Awaited<ReturnType<typeof read>>) => rows.map(r => `${r.source_id}:${r.slug}`);
    const scalar = await read({ phones: ['14155550100', '4155550100'] });
    expect(slugs(scalar)).toEqual(['default:people/alice-example', 'other:companies/alice-example']);
    expect(slugs(await read({ phones: ['4155550142'] }))).toEqual(['default:people/bob-example']);
    expect(slugs(await read({ phones: ['5550100', '0100'] }))).toEqual([]);
    return {
      scalar,
      listString: await read({ phones: ['4155550199'] }),
      listNumber: await read({ phones: ['4155550142'] }),
      scalarNumber: await read({ phones: ['4155550123'] }),
      nestedList: await read({ phones: ['4155550177'] }),
      nestedObject: await read({ phones: ['4155550188'] }),
      partial: await read({ phones: ['5550100', '0100'] }),
      empty: await read({ phones: [''] }),
      limited: await read({ phones: ['4155550100'] }, { limit: 1 }),
      local: await read({ phones: ['4155550166'] }),
      remote: await read({ phones: ['4155550166'] }, { remote: { excludePrivate: false } }),
      withTitle: await read({ phones: ['4155550199'], titleKeys: ['alice example'], titleRaw: 'Alice Example' }),
      emailsOnly: await read({ phones: ['4155550199'], titleKeys: ['alice example'], titleRaw: 'Alice Example', emails: ['alice@example.com'] }, { emailsOnly: true }),
      emailsOnlyPhone: await read({ phones: ['4155550199'] }, { emailsOnly: true }),
    };
  });

  parityTest('whois by a phone number matches the canonical number, honours the country code setting and hides private pages from a remote caller', { methods: ['listExactIdentityCandidates', 'getConfig', 'setConfig'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/alice-example', note('Alice Example', 'p', { phone: '(555) 555-0100' }, 'person'));
    await engine.putPage('people/bob-example', note('Bob Example', 'p', { phones: ['+1 555-555-0101', '555.555.0102'] }, 'person'));
    await engine.putPage('people/carol-example', note('Carol Example', 'p', { phones: ['+44 20 7946 0958'] }, 'person'), { sourceId: 'other' });
    await engine.putPage('people/dana-example', note('Dana Example', 'p', { phone: '555-555-0103', visibility: 'private' }, 'person'));
    await engine.putPage('people/erin-example', note('Erin Example', 'p', { phone: '555-555-0104' }, 'person'));
    await engine.putPage('people/frank-example', note('Frank Example', 'p', { phone: '+1 (555) 555-0104' }, 'person'), { sourceId: 'other' });
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const local = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false } as unknown as OperationContext;
    const remote = { ...local, remote: true, transport: 'stdio', sourceId: 'default', auth: { allowedSources: ['default'] } } as unknown as OperationContext;
    type Whois = { query_kind: string; matches: Array<{ slug: string; source_id: string; match: string }>; ambiguous: boolean };
    // Every call spans all sources: a named source_id first runs assertExplicitSourceLive, whose typed read is lane
    // rust-engine/source-scope-reads' work (da0b428b7d), not this case's.
    const whois = async (ctx: OperationContext, query: string) => {
      const r = await operationsByName.whois!.handler(ctx, { query, types: ['person'], source_id: '__all__' }) as Whois;
      return { kind: r.query_kind, ambiguous: r.ambiguous, hits: r.matches.map(m => `${m.source_id}:${m.slug}:${m.match}`) };
    };
    const formats = await Promise.all(['+1 555 555 0100', '555-555-0100', '15555550100', '001 555 555 0100'].map(q => whois(local, q)));
    for (const f of formats) expect(f).toEqual({ kind: 'phone', ambiguous: false, hits: ['default:people/alice-example:phone'] });
    const answers = {
      formats,
      listValue: await whois(local, '555 555 0102'),
      ownCountry: await whois(local, '+44 20 7946 0958'),
      ambiguous: await whois(local, '555-555-0104'),
      partial: await Promise.all(['555-0100', '0100', '555-555-0109'].map(q => whois(local, q))),
      privateLocal: await whois(local, '555-555-0103'),
      privateRemote: await whois(remote, '555-555-0103'),
      ungrantedRemote: await whois(remote, '+44 20 7946 0958'),
    };
    expect(answers.ambiguous.hits).toEqual(['default:people/erin-example:phone', 'other:people/frank-example:phone']);
    expect(answers.privateRemote.hits).toEqual([]);
    await engine.setConfig('identity.phone_country_code', '44');
    const uk = { national: await whois(local, '020 7946 0958'), usNational: await whois(local, '555-555-0100') };
    expect(uk.national.hits).toEqual(['other:people/carol-example:phone']);
    return { ...answers, uk };
  });

  parityTest('rankEntities folds retired pages along their redirect chains and counts distinct edges', { methods: ['rankEntities'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const person = (slug: string, fm: Record<string, unknown> = {}, sourceId?: string) =>
      engine.putPage(slug, note(slug, slug, fm, 'person'), sourceId ? { sourceId } : undefined);
    await person('people/new-example');
    await person('people/old-example', { superseded_by: '[[people/new-example|New]]' });
    await person('people/older-example', { merged_into: ' /people/old-example.MD ' });
    await person('people/alias-example', { status: 'Alias of someone' });
    await person('people/not-canonical', { canonical: 'No', superseded_by: '   ' });
    await person('people/cycle-a', { superseded_by: 'people/cycle-b' });
    await person('people/cycle-b', { superseded_by: 'people/cycle-a' });
    await person('people/held-example', { quarantine: 'x' });
    for (const fan of ['people/fan-1', 'people/fan-2', 'people/fan-3']) await person(fan);
    await person('people/far-example', {}, 'other');
    await engine.addLink('people/fan-1', 'people/old-example', '', 'knows');
    await engine.addLink('people/fan-1', 'people/new-example', '', 'knows');
    await engine.addLink('people/fan-1', 'people/new-example', '', 'works_with');
    await engine.addLink('people/fan-2', 'people/older-example', '', 'knows');
    await engine.addLink('people/fan-3', 'people/new-example', '', 'amends');
    await engine.addLink('people/fan-3', 'people/cycle-a', '', 'knows');
    await engine.addLink('people/fan-3', 'people/alias-example', '', 'knows', 'mentions');
    await engine.addLink('people/held-example', 'people/new-example', '', 'knows');
    await engine.addLink('people/old-example', 'people/new-example', '', 'knows');
    await engine.addLink('people/new-example', 'people/fan-2', '', 'knows');
    await engine.addLink('people/far-example', 'people/new-example', '', 'knows', undefined, undefined, undefined, { fromSourceId: 'other' });
    const rank = (extra: Partial<RankEntitiesStatementOpts> = {}) => engine.rankEntities({
      direction: 'in', types: { types: ['person'], per_source: [] }, sourceIds: ['default'], includeMentions: true, limit: 20, foldedCap: 5, ...extra,
    }, 30_000);
    return {
      inbound: await rank(),
      outbound: await rank({ direction: 'out' }),
      both: await rank({ direction: 'both', limit: 3 }),
      capped: await rank({ foldedCap: 1 }),
      noFolded: await rank({ foldedCap: 0 }),
      noMentions: await rank({ includeMentions: false }),
      knowsOnly: await rank({ linkType: 'knows' }),
      remote: await rank({ remote: { excludePrivate: false } }),
      brainWide: await rank({ sourceIds: undefined }),
      noSources: await rank({ sourceIds: [] }),
    };
  });

  parityTest('rankEntities for a remote caller with excludePrivate leaves out private pages', { methods: ['rankEntities'] }, async (engine) => {
    await engine.putPage('people/hub-example', note('Hub', 'hub', {}, 'person'));
    await engine.putPage('people/secret-example', note('Secret', 's', { visibility: 'private' }, 'person'));
    await engine.addLink('people/secret-example', 'people/hub-example', '', 'knows');
    // The store keeps no private visibility: on the Rust arm this call is its typed refusal.
    return engine.rankEntities({
      direction: 'in', types: { types: ['person'], per_source: [] }, sourceIds: ['default'], includeMentions: true, limit: 10, foldedCap: 5,
      remote: { excludePrivate: true },
    }, 30_000);
  });

  parityTest('rankEntities and listExactIdentityCandidates apply the remote caller\'s page policy: readers, grants and counts', { methods: ['putPage', 'addLink', 'rankEntities', 'listExactIdentityCandidates'] }, async (engine) => {
    const person = (slug: string, fm: Record<string, unknown> = {}) => engine.putPage(slug, note(slug, slug, fm, 'person'));
    await person('people/hub-example');
    await person('people/fan-example');
    await person('people/secret-example', { visibility: 'private' });
    await person('people/team-example', { readable_by: ['alice-example'] });
    await person('people/hidden-target', { visibility: 'private' });
    for (const from of ['people/fan-example', 'people/secret-example', 'people/team-example']) await engine.addLink(from, 'people/hub-example', '', 'knows');
    await engine.addLink('people/fan-example', 'people/hidden-target', '', 'knows');
    await engine.addLink('people/team-example', 'people/fan-example', '', 'knows');
    const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () => ({
      rank: (await engine.rankEntities({
        direction: 'both', types: { types: ['person'], per_source: [] }, sourceIds: ['default'], includeMentions: true, limit: 10, foldedCap: 5,
        remote: { excludePrivate: true },
      }, 30_000)).map(r => `${r.slug}:${r.inbound}/${r.outbound}/${r.neighbors}`),
      whois: (await engine.listExactIdentityCandidates({
        probes: { titleKeys: [], titleRaw: '', basenames: ['hub-example', 'secret-example', 'team-example', 'hidden-target'], aliasKeys: [], emails: [] },
        sourceIds: ['default'], types: { types: ['person'], per_source: [] }, remote: { excludePrivate: true }, limit: 10,
      })).map(r => r.slug),
    }));
    const plain = await read({ hidePrivate: true });
    const stranger = await read({ identity: ['member:bob-example'], hidePrivate: true });
    const member = await read({ identity: ['member:alice-example'], hidePrivate: true });
    const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
    // A plain caller sees neither the private nor the reader-named pages, and no edge of theirs moves a count.
    expect(plain.rank).toEqual(['people/fan-example:0/1/1', 'people/hub-example:1/0/1']);
    expect(plain.whois).toEqual(['people/hub-example']);
    expect(stranger).toEqual(plain);
    // A named reader sees the page that names it, and its edges count.
    expect(member.rank).toEqual(['people/fan-example:1/1/2', 'people/hub-example:2/0/2', 'people/team-example:0/2/2']);
    expect(member.whois).toEqual(['people/hub-example', 'people/team-example']);
    // A private-readable grant on the source shows the private pages too.
    expect(granted.whois).toEqual(['people/hidden-target', 'people/hub-example', 'people/secret-example', 'people/team-example']);
    return { plain, stranger, member, granted };
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

  parityTest('listExtractionPendingPages skips held, pinned and archived pages and reads the source field as text', { methods: ['listExtractionPendingPages'] }, async (engine, backend) => {
    await createSource(engine, backend, 'old');
    const pending = { [EXTRACTION_PROVENANCE_KEY]: PROVENANCE_AUTO_EXTRACTED, [EXTRACTION_STATUS_KEY]: STATUS_UNVERIFIED };
    const sealedPage = (slug: string, fm: Record<string, unknown>, opts?: { sourceId?: string }) =>
      seedPage(engine, { slug, input: note(slug, 'body', fm, 'person'), chunks: [chunk(0, 'body')] }, opts);
    await sealedPage('people/no-source', pending);
    await sealedPage('people/number-source', { ...pending, source: 5 });
    await sealedPage('people/object-source', { ...pending, source: { b: 1, a: [true, null] } });
    await sealedPage('people/held', { ...pending, quarantine: 'x' });
    await sealedPage('people/pinned', { ...pending, pinned_question: 'q' });
    await sealedPage('people/archived', { ...pending, source: 'x' }, { sourceId: 'old' });
    await archiveSource(engine, backend, 'old');
    const rows = await engine.listExtractionPendingPages({ limit: 10, offset: 0 });
    for (const r of rows) expect(String(r.created_at)).toMatch(TS);
    return sorted(rows.map(({ created_at: _at, ...r }) => r), r => r.slug);
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

  parityTest('listUnattributedFacts drops expired facts, facts of a deleted page and, with excludePrivateProvenance, facts of a private page', {
    methods: ['putPage', 'softDeletePage', 'insertFact', 'insertFacts', 'expireFact', 'listUnattributedFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/open-origin', note('Open', 'an open origin'));
    await engine.putPage('notes/private-origin', note('Private', 'a private origin', { visibility: 'private' }));
    await engine.putPage('notes/gone-origin', note('Gone', 'a deleted origin'));
    await engine.insertFacts([
      { fact: 'from the open page', entity_slug: null, source_markdown_slug: 'notes/open-origin', row_num: 1, kind: 'preference', visibility: 'world', source: 'fence' },
      { fact: 'from the private page', entity_slug: null, source_markdown_slug: 'notes/private-origin', row_num: 1, kind: 'fact', visibility: 'world', source: 'fence' },
      { fact: 'from the deleted page', entity_slug: null, source_markdown_slug: 'notes/gone-origin', row_num: 1, kind: 'fact', visibility: 'world', source: 'fence' },
    ] as never, { source_id: 'default' });
    await engine.softDeletePage('notes/gone-origin');
    const loose = (fact: string, extra: Record<string, unknown> = {}, source_id = 'default') =>
      engine.insertFact({ fact, entity_slug: null, visibility: 'world', source: 'mcp:remember', embedding: null, ...extra } as never, { source_id });
    const expired = await loose('an expired fact');
    expect(await engine.expireFact(expired.id)).toBe(true);
    await loose('a fact past its valid_until', { valid_until: new Date('2020-01-01T00:00:00Z') });
    await loose('a fact from the cli', { source: 'cli' });
    await loose('a fact in another source', {}, 'other');
    const read = async (opts: { sourceIds: string[]; excludePrivateProvenance: boolean }) => {
      const rows = await engine.listUnattributedFacts({ worldOnly: false, limit: 10, offset: 0, ...opts });
      // The id is a number on PGLite and Rust and a bigint on Postgres, and a Postgres sequence keeps counting across
      // brain resets. So the case checks each id is a whole number as text and compares it relative to the smallest id
      // in the result (ids 6/6/1 and 10/10/5 both become 5/5/0).
      const ids = rows.map(({ id }) => String(id));
      for (const id of ids) expect(id).toMatch(/^\d+$/);
      const base = ids.reduce((min, id) => (BigInt(id) < min ? BigInt(id) : min), ids.length ? BigInt(ids[0]) : 0n);
      return rows.map(({ id, created_at, ...r }) => {
        // PGLite returns created_at as timestamptz::text (`2026-01-02 03:04:05.678+00`).
        expect(created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00$/);
        return { ...r, id: Number(BigInt(String(id)) - base) };
      });
    };
    const all = await read({ sourceIds: ['default'], excludePrivateProvenance: false });
    const open = await read({ sourceIds: ['default'], excludePrivateProvenance: true });
    const federated = await read({ sourceIds: ['default', 'other'], excludePrivateProvenance: true });
    expect(all.map(r => r.fact)).toEqual(['a fact from the cli', 'from the private page', 'from the open page']);
    expect(open.map(r => r.fact)).toEqual(['a fact from the cli', 'from the open page']);
    expect(federated.map(r => r.fact)).toEqual(['a fact in another source', 'a fact from the cli', 'from the open page']);
    return { all, open, federated };
  });

  parityTest('listWantedPages counts missing link targets in scope, most referenced first', { methods: ['listWantedPages', 'replaceWantedLinkRows'] }, async (engine) => {
    await engine.putPage('notes/a', note('A', 'links to missing pages'));
    await engine.putPage('notes/b', note('B', 'links too'));
    await engine.putPage('people/carol-example', note('Carol', 'exists', {}, 'person'));
    await seedWantedLinks(engine, 'notes/a', [{ target: 'people/missing-example', refKind: 'slug', linkType: 'mentions' }, { target: 'carol-example', refKind: 'name' }]);
    await seedWantedLinks(engine, 'notes/b', [{ target: 'people/missing-example', refKind: 'slug' }]);
    const { total, rows } = await engine.listWantedPages({ sourceId: 'default', limit: 10, offset: 0 });
    for (const r of rows) for (const at of [r.first_seen, r.last_checked]) expect(at === 'pending' || TS.test(at)).toBe(true);
    const view = rows.map(({ first_seen: _f, last_checked: _l, ...r }) => r);
    expect(total).toBe(2);
    expect(view[0]).toMatchObject({ target: 'people/missing-example', referenced_by: 2 });
    const paged = await engine.listWantedPages({ sourceId: 'default', limit: 1, offset: 1 });
    return { total, view, pagedTotal: paged.total, paged: paged.rows.map(r => r.target) };
  });

  parityTest('listWantedPages with excludePrivate drops wanted rows whose origin page is private', { methods: ['listWantedPages', 'replaceWantedLinkRows'] }, async (engine) => {
    await engine.putPage('notes/open', note('Open', 'public origin'));
    await engine.putPage('notes/closed', note('Closed', 'private origin', { visibility: 'private' }));
    await seedWantedLinks(engine, 'notes/open', [{ target: 'people/open-missing', refKind: 'slug' }]);
    await seedWantedLinks(engine, 'notes/closed', [{ target: 'people/closed-missing', refKind: 'slug' }]);
    const all = await engine.listWantedPages({ sourceId: 'default', limit: 10, offset: 0 });
    expect(all.rows.map(r => r.target).sort()).toEqual(['people/closed-missing', 'people/open-missing']);
    const open = await engine.listWantedPages({ sourceId: 'default', excludePrivate: true, limit: 10, offset: 0 });
    expect(open.rows.map(r => r.target)).toEqual(['people/open-missing']);
    return { total: open.total, targets: open.rows.map(r => r.target) };
  });

  parityTest('readRankCoverage counts only the pages the remote caller may read', { methods: ['putPage', 'markPagesExtractedBatch', 'readRankCoverage'] }, async (engine, backend) => {
    await createSource(engine, backend, 'old');
    await engine.putPage('people/open-example', note('Open', 'open', {}, 'person'));
    await engine.putPage('people/secret-example', note('Secret', 'secret', { visibility: 'private' }, 'person'));
    await engine.putPage('people/team-example', note('Team', 'team', { readable_by: ['alice-example'] }, 'person'));
    await engine.putPage('people/old-example', note('Old', 'old', {}, 'person'), { sourceId: 'old' });
    await archiveSource(engine, backend, 'old');
    const coverage = (opts: { excludePrivate: boolean; mentionTypes?: string[]; sourceId?: string }) =>
      engine.readRankCoverage({ sourceId: 'default', versionTs: '2020-01-01T00:00:00Z', ...opts }, 30_000);
    // Every page is unstamped: the readable open page owes link extraction.
    const unstamped = await coverage({ excludePrivate: true });
    expect(unstamped.link_behind).toBe(true);
    await engine.markPagesExtractedBatch([{ slug: 'people/open-example', source_id: 'default' }], '2999-01-01T00:00:00Z');
    // Only reader-named and private pages are still stale: they never move a plain caller's coverage.
    const read = (access: Parameters<typeof withCallerAccess>[0], opts: { excludePrivate: boolean; mentionTypes?: string[] }) =>
      withCallerAccess(access, () => coverage(opts));
    const plain = await read({ hidePrivate: true }, { excludePrivate: true });
    const member = await read({ identity: ['member:alice-example'], hidePrivate: true }, { excludePrivate: true });
    const trusted = await coverage({ excludePrivate: false });
    expect(plain).toEqual({ link_behind: false, mention_due: false });
    expect(member.link_behind).toBe(true);
    expect(trusted.link_behind).toBe(true);
    // No mention state is kept for any page: with mention types every readable page owes a pass.
    const mentions = await read({ hidePrivate: true }, { excludePrivate: true, mentionTypes: ['person'] });
    expect(mentions.mention_due).toBe(true);
    // An archived source has no readable page.
    const archived = await coverage({ excludePrivate: false, sourceId: 'old', mentionTypes: ['person'] });
    expect(archived).toEqual({ link_behind: false, mention_due: false });
    return { unstamped, plain, member, trusted, mentions, archived };
  });

  parityTest('readExactSnippetChunks and listExactRescanChunks read visible chunks and hide the caller\'s private pages', { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'readExactSnippetChunks', 'listExactRescanChunks'] }, async (engine) => {
    const ids: Record<string, number> = {};
    const pages: Array<[string, Record<string, unknown>]> = [
      ['notes/open', {}], ['notes/secret', { visibility: 'private' }], ['notes/team', { readable_by: ['alice-example'] }], ['notes/fence-short', {}],
    ];
    for (const [slug, frontmatter] of pages) {
      const text = `the needle in ${slug}`;
      ids[slug] = Number((await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text, timeline: '', frontmatter })).id);
      await installChunks(engine, slug, [chunk(0, text), chunk(1, `second chunk of ${slug}`)]);
    }
    await engine.setChunkerVersion('notes/fence-short', 3);
    const keys = [
      { pageId: ids['notes/secret']!, chunkIndex: 0, snippet: 'needle' },
      { pageId: ids['notes/open']!, chunkIndex: 0, snippet: 'absent' },
      { pageId: ids['notes/open']!, chunkIndex: 1, snippet: 'second' },
      { pageId: ids['notes/team']!, chunkIndex: 0, snippet: 'needle' },
      { pageId: ids['notes/fence-short']!, chunkIndex: 0, snippet: 'needle' },
      { pageId: 999_999, chunkIndex: 0, snippet: 'needle' },
    ];
    const rescanIds = [ids['notes/fence-short']!, ids['notes/team']!, ids['notes/secret']!, ids['notes/open']!, ids['notes/open']!];
    const slugOf = (id: number) => Object.keys(ids).find(slug => ids[slug] === id);
    const read = (access: Parameters<typeof withCallerAccess>[0], excludePrivate: boolean) => withCallerAccess(access, async () => ({
      snippets: (await engine.readExactSnippetChunks(keys, { excludePrivate })).map(r => `${r.i}:${r.chunk_text}`),
      rescan: (await engine.listExactRescanChunks(rescanIds, { excludePrivate })).map(r => `${slugOf(r.page_id)}#${r.chunk_index}:${r.chunk_source}`),
    }));
    const plain = await read({ hidePrivate: true }, true);
    const member = await read({ identity: ['member:alice-example'], hidePrivate: true }, true);
    const trusted = await read({}, false);
    // A hidden page leaves no row; the snippet read does not check the safe fence, the rescan does.
    expect(plain.snippets).toEqual(['3:second chunk of notes/open', '5:the needle in notes/fence-short']);
    expect(plain.rescan).toEqual(['notes/open#0:compiled_truth', 'notes/open#1:compiled_truth']);
    expect(JSON.stringify(plain)).not.toContain('secret');
    expect(member.snippets).toEqual(['3:second chunk of notes/open', '4:the needle in notes/team', '5:the needle in notes/fence-short']);
    expect(trusted.snippets).toHaveLength(4);
    expect(trusted.rescan).toHaveLength(6);
    expect(await engine.readExactSnippetChunks([], { excludePrivate: true })).toEqual([]);
    expect(await engine.listExactRescanChunks([], { excludePrivate: true })).toEqual([]);
    return { plain, member, trusted };
  });
});
