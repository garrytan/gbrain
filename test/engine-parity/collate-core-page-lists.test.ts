/**
 * BrainEngine parity — core reads that list pages, links and facts by slug or source id return them in byte order on
 * every engine and locale, and a slug keyset pages through them without a skip or a repeat.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    these list in byte order of the key, as PGLite and the Rust store sort: the attendance-repair scan window and the
 *    `--after-slug` keyset that walks it (previewAttendanceRepair), the pending core-edit notices by (source, slug)
 *    (pendingCoreNotices), the company-brain evidence picks (readCompanyBrainEvidence), the chat census sources
 *    (chatChannelCensus), the pages that carry a size state (readPageSizeStates), the file-link ownership page list
 *    (fileLinkOwnership), `gbrain files list` (file_list), the page-type pairs `gbrain onboard --check` walks
 *    (checkTypeProliferation), the shelf cards (findCards, listCards, readShelfCards), the fact pool pairs (poolEntityPairs,
 *    poolUnbackedKeys), the forecast journal's predictions (readForecastJournal), and the stale-mention scan (scanStaleMentions).
 *  - Regression: an en_US Postgres sorted and compared source ids and slugs by its locale, which skips `-` and `/`
 *    (`ab, a-z, a/z` instead of `a-z, a/z, ab`), so these reads listed rows, picked a first row, or named a worst source
 *    in another order than a PGLite brain; a keyset compared in one collation after an ORDER BY in another would skip or
 *    repeat a page.
 *  - Why existing coverage misses it: the tests for these reads use keys that sort the same in every locale, and CI's
 *    Postgres runs in C.UTF-8. Every case here uses keys that differ by byte and by en_US; run it against an en_US
 *    Postgres to see it fail.
 *  - Seam: none for the production functions. Notices, file rows and per-source pack config come from harness-only SQL
 *    (their tables have no engine writer); everything else is seeded through engine writes.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { previewAttendanceRepair } from '../../src/core/attendance-repair.ts';
import { pendingCoreNotices } from '../../src/core/core-memory.ts';
import { readCompanyBrainEvidence } from '../../src/core/company-brain/evidence.ts';
import { chatChannelCensus } from '../../src/core/grants/shared-exposure.ts';
import { readPageSizeStates } from '../../src/core/page-embedding-budget.ts';
import { fileLinkOwnership } from '../../src/core/link-reconciliation.ts';
import { findCards, listCards, readShelfCards } from '../../src/core/storage-manifest/find.ts';
import { poolEntityPairs, poolUnbackedKeys } from '../../src/core/search/fact-relevance.ts';
import { scanStaleMentions } from '../../src/core/by-mention.ts';
import { readForecastJournal } from '../../src/core/forecast-journal.ts';
import { checkTypeProliferation } from '../../src/core/onboard/checks.ts';
import { loadActivePack } from '../../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../../src/core/schema-pack/registry.ts';
import { emptyHome, withEnv } from '../helpers/with-env.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_SLUGS, byteOrder, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, digits and `-` only): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const MIXED_SOURCES = ['ab', 'a0', 'a-z'];
const BYTE_SOURCES = byteOrder(MIXED_SOURCES);

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra }) as never;

function ctxFor(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

describe('attendance repair scan window', () => {
  async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'att-example');
    for (const slug of MIXED_SLUGS) await engine.putPage(slug, note(slug), { sourceId: 'att-example' });
  }
  const preview = (engine: BrainEngine, limit: number, afterSlug?: string) =>
    previewAttendanceRepair(engine, { remote: false, sourceId: 'att-example', limit, ...(afterSlug === undefined ? {} : { afterSlug }) } as never);

  parityTest('previewAttendanceRepair lists its scan window by slug byte', { methods: ['putPage', 'readClockMillisText', 'listLiveSourceIncarnations', 'readAttendanceWindow'] }, async (engine, backend) => {
    await seed(engine, backend);
    const slugs = (await preview(engine, 10)).window.map(p => p.slug);
    expect(slugs).toEqual([...BYTE_SLUGS]);
    return slugs;
  });

  parityTest('the attendance-repair after-slug keyset pages through the pages without a skip or a repeat', { methods: ['putPage', 'readClockMillisText', 'listLiveSourceIncarnations', 'readAttendanceWindow'] }, async (engine, backend) => {
    await seed(engine, backend);
    const walked: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < BYTE_SLUGS.length + 1; i++) {
      const page = await preview(engine, 1, after);
      walked.push(...page.window.map(p => p.slug));
      if (page.complete) break;
      after = page.nextAfterSlug;
    }
    expect(walked).toEqual([...BYTE_SLUGS]);
    return walked;
  });
});

describe('core and company-brain lists', () => {
  parityTest('pendingCoreNotices lists one notice per (source, slug) by byte', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    for (const id of MIXED_SOURCES) await createSource(engine, backend, id);
    for (const id of MIXED_SOURCES) {
      for (const slug of MIXED_SLUGS) {
        for (const actor of ['one', 'two']) {
          await engine.executeRaw('INSERT INTO core_edit_notices (source_id, slug, revision, actor) VALUES ($1, $2, $3, $4)', [id, slug, 'r1', actor]);
        }
      }
    }
    const notices = (await pendingCoreNotices(engine)).map(n => [n.source_id, n.slug]);
    const expected = BYTE_SOURCES.flatMap(id => BYTE_SLUGS.map(slug => [id, slug]));
    expect(notices).toEqual(expected);
    return notices;
  });

  parityTest('readCompanyBrainEvidence picks the first page, owner and decision by byte', { methods: ['putPage', 'addLinksBatch', 'readCompanyBrainEvidenceRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'brain-example');
    const put = (slug: string, type: string) => engine.putPage(slug, { type, title: `Title ${slug}`, compiled_truth: `${slug} body`, timeline: '' } as never, { sourceId: 'brain-example' });
    const link = (from: string, to: string, link_type: string) => ({ from_slug: from, to_slug: to, link_type, context: '', link_source: 'markdown',
      from_source_id: 'brain-example', to_source_id: 'brain-example' });
    for (const slug of MIXED_SLUGS) await put(slug, 'decision');
    await put('m-hub', 'decision');
    await put('z-target', 'decision');
    // supersedes: the byte-first sender is a-z; a sender with several targets takes its byte-first target.
    await engine.addLinksBatch([
      ...MIXED_SLUGS.map(slug => link(slug, 'z-target', 'supersedes')),
      ...MIXED_SLUGS.map(slug => link('m-hub', slug, 'owned_by')),
    ]);
    const evidence = await readCompanyBrainEvidence(engine, 'brain-example');
    expect(evidence.page?.citation).toBe(`brain-example::${BYTE_SLUGS[0]}`);
    expect(evidence.supersession).toMatchObject({ status: 'verified', citations: [`brain-example::${BYTE_SLUGS[0]}`, 'brain-example::z-target'] });
    expect(evidence.ownership).toMatchObject({ status: 'verified', citations: ['brain-example::m-hub', `brain-example::${BYTE_SLUGS[0]}`] });
    return evidence;
  });
});

describe('census, size states and file lists', () => {
  parityTest('chatChannelCensus names the chat sources by byte', { methods: ['putPage', 'readChatCensusRows'] }, async (engine, backend) => {
    for (const id of MIXED_SOURCES) {
      await createSource(engine, backend, id);
      await engine.putPage('chat/day-one', note('Day one', { type: 'dm' }), { sourceId: id });
    }
    const census = await chatChannelCensus(engine, MIXED_SOURCES);
    expect(census.chat_sources).toEqual(BYTE_SOURCES);
    return census.chat_sources;
  });

  parityTest('readPageSizeStates lists the pages that carry a size state by slug byte', { methods: ['putPage', 'readPageSizeRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'size-example');
    for (const slug of MIXED_SLUGS) await engine.putPage(slug, note(slug, { frontmatter: { embed_skip: true } }), { sourceId: 'size-example' });
    const states = (await readPageSizeStates(engine, 'size-example', null)).map(s => s.slug);
    expect(states).toEqual([...BYTE_SLUGS]);
    return states;
  });

  parityTest('fileLinkOwnership lists the scoped pages by slug byte', { methods: ['putPage', 'listLinkPageMetadataForSlugs', 'listAttendedOriginSlugs'] }, async (engine, backend) => {
    await createSource(engine, backend, 'link-example');
    for (const slug of MIXED_SLUGS) await engine.putPage(slug, note(slug), { sourceId: 'link-example' });
    const { metadata } = await fileLinkOwnership(engine, 'link-example', { slugs: MIXED_SLUGS });
    const slugs = [...metadata.values()].map(row => row.slug);
    expect(slugs).toEqual([...BYTE_SLUGS]);
    return slugs;
  });

  parityTest('file_list lists files by page slug, then by filename, in byte order', { methods: ['upsertCliFileRow', 'listReadableFileRows'] }, async (engine) => {
    const op = operations.find(o => o.name === 'file_list')!;
    // The rows `gbrain files upload` writes (its typed upsert), for pages the brain does not hold.
    const file = (page_slug: string, filename: string, storage_path: string) =>
      engine.upsertCliFileRow({ page_slug, filename, storage_path, mime_type: null, size_bytes: 1, content_hash: 'h' }, {});
    for (const slug of MIXED_SLUGS) await file(slug, 'one', `p/${slug}/one`);
    for (const filename of MIXED_SLUGS) await file('shared', filename, `shared/${filename}`);
    const all = await op.handler(ctxFor(engine), {}) as Array<{ page_slug: string; filename: string }>;
    const bySlug = all.filter(r => r.page_slug !== 'shared').map(r => r.page_slug);
    expect(bySlug).toEqual([...BYTE_SLUGS]);
    const one = await op.handler(ctxFor(engine), { slug: 'shared' }) as Array<{ filename: string }>;
    expect(one.map(r => r.filename)).toEqual([...BYTE_SLUGS]);
    return { bySlug, one: one.map(r => r.filename) };
  });
});

describe('storage shelf and fact pool lists', () => {
  const STORED = 'stored-object';
  async function seedShelf(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'storage');
    for (const slug of MIXED_SLUGS) {
      await engine.putPage(slug, { type: STORED, title: slug, compiled_truth: `${slug} body`, timeline: '' } as never, { sourceId: 'storage' });
    }
  }

  parityTest('listCards pages the shelf by slug byte with an offset, without a skip or a repeat', { methods: ['putPage', 'listCardRows'] }, async (engine, backend) => {
    await seedShelf(engine, backend);
    const walked: string[] = [];
    for (let offset = 0; offset < MIXED_SLUGS.length; offset++) {
      walked.push(...(await listCards(engine, { limit: 1, offset, filters: {} })).cards.map(c => c.id));
    }
    expect(walked).toEqual([...BYTE_SLUGS]);
    return walked;
  });

  parityTest('findCards breaks a tie between equal cards by slug byte', { methods: ['putPage', 'findCardRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'storage');
    for (const slug of MIXED_SLUGS) {
      await engine.putPage(slug, { type: STORED, title: 'Zebra crate', compiled_truth: 'Same body.', timeline: '' } as never, { sourceId: 'storage' });
    }
    const ids = (await findCards(engine, 'zebra crate', { limit: 10, filters: {} })).hits.map(h => h.id);
    expect(ids).toEqual([...BYTE_SLUGS]);
    return ids;
  });

  // The whole ranking on every arm: an exact id, an exact alias, an exact title, word matches over the body and the
  // aliases, and the similarity of the rest, with the card columns and the store filter of each hit.
  parityTest('findCards ranks by id, alias, title, words and similarity, with each card and its storage fields', { methods: ['putPage', 'setPageAliases', 'findCardRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'storage');
    const card = (slug: string, title: string, body: string, storage: Record<string, unknown>) =>
      engine.putPage(slug, { type: STORED, title, compiled_truth: body, timeline: '', frontmatter: { storage } } as never, { sourceId: 'storage' });
    await card('red-kettle', 'Copper kettle', 'A copper kettle from the attic.', { status: 'stored', kind: 'object', locations: [{ store: 'b2' }, { store: 'attic' }, { store: 'b2' }], on_source_machine: 'true' });
    await card('blue-kettle', 'Blue kettle', 'Enamel kettle, chipped.', { status: 'archived', locations: [{ store: 'attic' }, {}], on_source_machine: false });
    await card('tea-set', 'Tea set', 'Six cups and a copper tray.', { status: 'stored', original_path: '/home/me/tea', locations: 'none' });
    await card('red-mug', 'Red mug', 'No match here.', {});
    await engine.setPageAliases('tea-set', 'storage', ['copper kettle tray']);
    const view = async (q: string, filters = {}) => {
      const found = await findCards(engine, q, { limit: 10, filters });
      return { terms: found.terms, not_found: found.not_found,
        hits: found.hits.map(({ updated_at: _u, ...h }) => h), closest: found.closest.map(({ updated_at: _u, ...c }) => c) };
    };
    const out = {
      id: await view('red-kettle'), title: await view('Blue kettle'), words: await view('copper kettle'),
      storeFilter: await view('kettle', { store: 'attic' }), statusFilter: await view('kettle', { status: 'stored' }),
      machine: await view('kettle', { onSourceMachine: true }), closest: await view('kettel'),
    };
    expect(out.id.hits[0]).toMatchObject({ id: 'red-kettle', match: 'id' });
    return out;
  });

  parityTest('readShelfCards lists the shelf by slug byte', { methods: ['putPage', 'readShelfPageRows'] }, async (engine, backend) => {
    await seedShelf(engine, backend);
    const ids = (await readShelfCards(engine)).map(c => c.id);
    expect(ids).toEqual([...BYTE_SLUGS]);
    return ids;
  });

  const scope = { sourceIds: MIXED_SOURCES, worldOnly: false, excludePrivate: false };
  async function seedFacts(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    for (const id of MIXED_SOURCES) {
      await createSource(engine, backend, id);
      for (const slug of MIXED_SLUGS) {
        await engine.insertFact({ fact: `${slug} fact in ${id}`, kind: 'fact', entity_slug: slug, visibility: 'world', source: 'test' } as never, { source_id: id });
      }
    }
  }

  parityTest('poolEntityPairs lists the fact pool pairs by (source, entity slug) byte order', { methods: ['insertFact', 'listPoolEntityPairs'] }, async (engine, backend) => {
    await seedFacts(engine, backend);
    const pairs = (await poolEntityPairs(engine, scope, {})).map(r => [r.source_id, r.entity_slug]);
    expect(pairs).toEqual(BYTE_SOURCES.flatMap(id => BYTE_SLUGS.map(slug => [id, slug])));
    return pairs;
  });

  parityTest('poolUnbackedKeys keeps the byte-first unbacked pairs under its limit', { methods: ['insertFact', 'listPoolUnbackedKeys'] }, async (engine, backend) => {
    await seedFacts(engine, backend);
    const pairs = (await poolUnbackedKeys(engine, scope, MIXED_SLUGS, 4)).map(r => [r.source_id, r.entity_slug]);
    expect(pairs).toEqual(BYTE_SOURCES.flatMap(id => BYTE_SLUGS.map(slug => [id, slug])).slice(0, 4));
    return pairs;
  });
});

describe('forecast journal', () => {
  parityTest('readForecastJournal lists predictions by (source, slug) byte order', { methods: ['putPage', 'getPage', 'addTakesBatch', 'readForecastPredictions', 'listTakeHorizons', 'readPredictionLedgerEvents', 'readBeliefCoverageEvents', 'readLatestTakeGrades'] }, async (engine, backend) => {
    for (const id of MIXED_SOURCES) {
      await createSource(engine, backend, id);
      for (const slug of MIXED_SLUGS) {
        await engine.putPage(slug, note(slug), { sourceId: id });
        const page = await engine.getPage(slug, { sourceId: id });
        await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: `${slug} will ship in ${id}`, kind: 'bet', holder: 'alice-example' }]);
      }
    }
    const { entries } = await readForecastJournal(engine, { sourceIds: MIXED_SOURCES });
    const keys = entries.map(e => [e.source_id, e.page_slug]);
    expect(keys).toEqual(BYTE_SOURCES.flatMap(id => BYTE_SLUGS.map(slug => [id, slug])));
    return keys;
  });
});

describe('stale-mention scan', () => {
  parityTest('scanStaleMentions scans the byte-first pages under its limit and lists their links by byte', { methods: ['putPage', 'addLinksBatch', 'readStaleMentionScan'] }, async (engine) => {
    for (const slug of [...MIXED_SLUGS, 'm-hub', 'target']) await engine.putPage(slug, note(slug));
    const mention = (from: string, to: string) => ({ from_slug: from, to_slug: to, link_type: 'mentions', context: '', link_source: 'mentions',
      from_source_id: 'default', to_source_id: 'default' });
    // None of the bodies names its target, so every stored link is stale.
    await engine.addLinksBatch([...MIXED_SLUGS.map(slug => mention(slug, 'target')), ...MIXED_SLUGS.map(slug => mention('m-hub', slug))]);
    const all = (await scanStaleMentions(engine)).examples.map(e => [e.from, e.to]);
    // The scan keeps five examples: the three byte-first pages, then the byte-first two links of m-hub.
    expect(all).toEqual([...BYTE_SLUGS.map(slug => [slug, 'target']), ['m-hub', BYTE_SLUGS[0]], ['m-hub', BYTE_SLUGS[1]]]);
    const three = (await scanStaleMentions(engine, { limit: 3 })).examples.map(e => [e.from, e.to]);
    expect(three).toEqual(BYTE_SLUGS.map(slug => [slug, 'target']));
    return { all, three };
  });
});

describe('onboard page-type walk', () => {
  parityTest('type_proliferation walks the (source, type) pairs by byte: a tie names the byte-first pool, and the walk reaches every source',
    { methods: ['putPage', 'setConfig'] }, async (engine, backend) => {
      // `a-z` is on one pack; `a0` and `ab` share another. Each pack is `warn` with six undeclared types over it, so the worst
      // pool on a tie is the first one read: bytes read `a-z` first, an en_US order reads `a0` first.
      const env = { GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined };
      const packs = { 'a-z': 'gbrain-base-v2', a0: 'gbrain-everything', ab: 'gbrain-everything' } as const;
      const typeName = (prefix: string, i: number) => `${prefix}-${String(i).padStart(2, '0')}`;
      const add = (id: string, type: string, n: number) =>
        engine.putPage(`${type}-${n}`, { type, title: `${type}-${n}`, compiled_truth: `${id} body ${type}`, timeline: '' } as never, { sourceId: id });
      return withEnv(env, async () => {
        _resetPackCacheForTests();
        const declared = async (name: string) => (await loadActivePack({ cfg: null, remote: false, dbConfig: name })).manifest.page_types.length;
        for (const [id, name] of Object.entries(packs)) {
          await createSource(engine, backend, id);
          await engine.setConfig(`schema_pack.source.${id}`, name);
        }
        for (let i = 0; i < await declared('gbrain-base-v2') + 6; i++) await add('a-z', typeName('custom-type', i), i);
        for (let i = 0; i < await declared('gbrain-everything') + 6; i++) await add('a0', typeName('custom-type', i), i);
        await add('ab', typeName('custom-type', 0), 0);
        const tie = (await checkTypeProliferation(engine)).check;
        expect(tie.status).toBe('warn');
        expect(tie.message).toContain('(source a-z, pack gbrain-base-v2;');
        // Three more labels in `ab` make the shared pack the worst, but only a walk that reaches `ab` sees them.
        for (let i = 0; i < 3; i++) await add('ab', typeName('extra-type', i), i);
        const worse = (await checkTypeProliferation(engine)).check;
        expect(worse.message).toContain('(sources a0, ab, pack gbrain-everything;');
        return [tie.message, worse.message];
      });
    });
});
