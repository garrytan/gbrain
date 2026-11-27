/**
 * BrainEngine parity — the engine-sql reads list text keys in byte order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the reads below return rows in byte order of their text keys on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), as PGLite and the Rust store sort:
 *    a member's bound credentials, config values, entity alias rows, a page's tags, takes sorted by since_date,
 *    the files listing, the code-symbol reads, the wanted-pages list, the entity identity list, the resolver
 *    candidate reads, the fact health, bulk-day and repair reads, the link, graph and path reads, the page
 *    listings and their keysets, salience and enrich candidates, and the notifier, hold and withdrawal reads.
 *  - Regression: an en_US Postgres sorted these keys by its locale, which skips punctuation (`ab` before `a-z`),
 *    so a LIMIT kept other rows, a keyset page skipped or repeated pages, and lists came back in another order
 *    than on PGLite and Rust brains.
 *  - Why existing coverage misses it: the cases used keys that sort the same in every locale, and CI's Postgres
 *    runs in C.UTF-8. Every case here mixes `a-z`, `a/z` and `ab`; run it against an en_US Postgres to see it fail.
 *  - Seam: none. Cases that need tied times (updated_at, deleted_at, first_due_at) write the rows in one transaction,
 *    whose start time every engine stamps on each row.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, recordFenceRetirement } from './harness.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_SLUGS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';
import type { ChunkInput, PageInput } from '../../src/core/types.ts';
import { chunk } from './chunk-fixtures.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import type { NewFact, TakeBatchInput } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

/** Free-text keys that sort differently by byte and under en_US (punctuation skipped). */
const TEXT = ['ab', 'a-z', 'a/z'];
const BYTES = byteOrder(TEXT);

/** Four keys: `a0` and `ab` sort before `a-z` and `a/z` under en_US but after them by byte, so a cut at three keeps other rows. */
const FOUR = ['ab', 'a0', 'a/z', 'a-z'];
const FOUR_BYTES = byteOrder(FOUR);
/** Two source ids that sort differently by byte and under en_US. */
const SOURCES = ['ab', 'a-z'];
/** Seven keys: the first five by byte differ from the first five under en_US, so a LIMIT 5 keeps other rows. */
const SEVEN = ['ab', 'a0', 'a2', 'a3', 'a/z', 'a-z', 'b'];
const SEVEN_BYTES = byteOrder(SEVEN);

const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `body of ${title}`, timeline: '' });
const putAll = async (engine: BrainEngine, slugs: readonly string[], sourceId?: string) => {
  for (const slug of slugs) await engine.putPage(slug, note(slug), sourceId ? { sourceId } : undefined);
};

describe('credential, config, alias, tag, take and file reads sort text keys by byte', () => {
  parityTest('a member\'s bound credentials list by byte token name and client id', {
    methods: ['insertAccessToken', 'insertOauthClient', 'readAccessCredentials'],
  }, async (engine) => {
    for (const [i, name] of TEXT.entries()) {
      await engine.insertAccessToken({ name, token_hash: `h${i}`, scopes: null, permissions: {}, source_grant: null, source_id: null, federated_read: null,
        allowed_operations: null, takes_holders: null, member_id: 'alice-example' });
    }
    for (const id of TEXT) await engine.insertOauthClient({ client_id: `c-${id}`, client_name: `app ${id}`, member_id: 'alice-example' });
    const out = (await engine.readAccessCredentials({ memberId: 'alice-example' })).map((c) => `${c.kind}:${c.name}`);
    expect(out).toEqual([...BYTES.map((n) => `token:${n}`), ...BYTES.map((n) => `client:app ${n}`)]);
    return out;
  });

  parityTest('getConfigValues lists the keys by byte', { methods: ['setConfig', 'getConfigValues'] }, async (engine) => {
    for (const key of TEXT) await engine.setConfig(`k.${key}`, `v-${key}`);
    const out = (await engine.getConfigValues(TEXT.map((k) => `k.${k}`))).map((r) => r.key);
    expect(out).toEqual(BYTES.map((k) => `k.${k}`));
    return out;
  });

  parityTest('readEntityAliasRows lists the alias rows by byte alias_norm', {
    methods: ['putPage', 'replaceDerivedAliases', 'readEntityAliasRows'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', note('Alice Example'));
    await engine.replaceDerivedAliases('people/alice-example', 'default',
      TEXT.map((alias_norm) => ({ alias_norm, origin: 'declared' as const, case_sensitive: false, alias_text: alias_norm })));
    const out = (await engine.readEntityAliasRows('default', ['people/alice-example'])).map((r) => r.alias_norm);
    expect(out).toEqual(BYTES);
    return out;
  });

  parityTest('getTags lists a page\'s tags by byte', { methods: ['putPage', 'addTag', 'getTags'] }, async (engine) => {
    await engine.putPage('notes/tagged', note('tagged'));
    for (const tag of TEXT) await engine.addTag('notes/tagged', tag);
    const out = await engine.getTags('notes/tagged');
    expect(out).toEqual(BYTES);
    return out;
  });

  parityTest('listTakes sorted by since_date orders the text dates by byte, newest and oldest first', {
    methods: ['putPage', 'addTakesBatch', 'listTakes'],
  }, async (engine) => {
    const p = await engine.putPage('notes/standup', note('standup'));
    const take = (row_num: number, since_date: string): TakeBatchInput => ({ page_id: p.id, row_num, claim: `t-${since_date}`, kind: 'take', holder: 'alice', since_date });
    await engine.addTakesBatch(TEXT.map((d, i) => take(i + 1, d)));
    const claims = (rows: Array<{ claim: string }>) => rows.map((r) => r.claim);
    const out = {
      newest: claims(await engine.listTakes({ sortBy: 'since_date' })),
      oldest: claims(await engine.listTakes({ sortBy: 'since_date', oldestFirst: true })),
    };
    expect(out).toEqual({ newest: [...BYTES].reverse().map((d) => `t-${d}`), oldest: BYTES.map((d) => `t-${d}`) });
    return out;
  });

  parityTest('listFiles lists the files of one page by byte filename and all pages by byte slug and filename', {
    methods: ['putPage', 'upsertFile', 'listFiles'],
  }, async (engine) => {
    await putAll(engine, MIXED_SLUGS);
    for (const slug of MIXED_SLUGS) {
      for (const name of TEXT) {
        await engine.upsertFile({ page_slug: slug, filename: `${name}.png`, storage_path: `${slug}/${name}.png`, content_hash: `h-${slug}-${name}` });
      }
    }
    const out = {
      one: (await engine.listFiles({ pageSlug: 'ab', limit: 100 })).map((f) => f.filename),
      all: (await engine.listFiles({ limit: 100 })).map((f) => `${f.page_slug}:${f.filename}`),
      cut: (await engine.listFiles({ limit: 4 })).map((f) => `${f.page_slug}:${f.filename}`),
    };
    const files = BYTES.map((n) => `${n}.png`);
    const all = BYTE_SLUGS.flatMap((s) => files.map((f) => `${s}:${f}`));
    expect(out).toEqual({ one: files, all, cut: all.slice(0, 4) });
    return out;
  });
});

describe('code, wanted-page and identity reads sort text keys by byte', () => {
  const codePage = (slug: string): PageInput => ({ type: 'code', page_kind: 'code', title: slug, compiled_truth: `${slug} source`, timeline: '', frontmatter: { file: `${slug}.ts` } });
  const sym = (i: number, type: string): ChunkInput => chunk(i, `function run() { /* ${type} */ }`, {
    language: 'typescript', symbol_name: 'run', symbol_type: type, symbol_name_qualified: 'mod.run', start_line: 10 * (i + 1), end_line: 10 * (i + 1) + 5,
  } as Partial<ChunkInput>);
  const sealedCode = async (engine: BrainEngine, slug: string, chunks: ChunkInput[], sourceId?: string) => {
    const opts = sourceId ? { sourceId } : undefined;
    await engine.putPage(slug, codePage(slug), opts);
    await engine.sealChunks(slug, chunks, opts);
  };

  parityTest('code definitions, references and symbol types list by byte slug, source id and symbol type', {
    methods: ['putPage', 'sealChunks', 'findCodeDefinitions', 'findCodeRefChunks', 'listSymbolTypesForName'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const slug of FOUR.map((k) => `src/${k}`)) await sealedCode(engine, slug, [sym(0, 'function')]);
    // One slug in two sources: the source id breaks the tie.
    for (const source of SOURCES) await sealedCode(engine, 'src/twin', [sym(0, 'function')], source);
    // One page with several symbol types.
    await sealedCode(engine, 'src/types', TEXT.map((type, i) => sym(i, type)));
    const label = (r: { source_id: string; slug: string }) => `${r.source_id}:${r.slug}`;
    const out = {
      defs: (await engine.findCodeDefinitions('run', { allSources: true })).filter((r) => r.symbol_type === 'function').map(label),
      top: (await engine.findCodeDefinitions('run', { allSources: true, limit: 3 })).map(label),
      refs: (await engine.findCodeRefChunks('run', { allSources: true, limit: 3 })).map(label),
      types: await engine.listSymbolTypesForName('run', { allSources: true }),
    };
    const slugs = byteOrder([...FOUR.map((k) => `src/${k}`), 'src/twin', 'src/types']);
    const defs = slugs.flatMap((slug) => slug === 'src/twin' ? ['a-z', 'ab'].map((s) => `${s}:${slug}`) : slug === 'src/types' ? [] : [`default:${slug}`]);
    expect(out.defs).toEqual(defs);
    expect(out.top).toEqual(slugs.slice(0, 3).map((slug) => `default:${slug}`));
    expect(out.refs).toEqual(slugs.slice(0, 3).map((slug) => `default:${slug}`));
    expect(out.types).toEqual(byteOrder(['function', ...TEXT]));
    return out;
  });

  const originPage = async (engine: BrainEngine, slug: string, targets: Array<{ source: string; ref: string; kind: 'slug' | 'name' }>) => {
    await engine.putPage(slug, note(slug));
    const origin = await engine.getPage(slug, { sourceId: 'default' });
    const rows = targets.map((t) => ({ producer: 'body' as const, ref_kind: t.kind, target_source_id: t.source, target_ref: t.ref, link_type: '', context: '' }));
    await engine.replaceWantedLinkRows({ pageId: Number(origin!.id), sourceId: 'default' }, { rows, producers: ['body'], readAt: '2026-01-02T03:04:05.678Z' });
  };

  parityTest('listWantedPages lists targets, sample origins and name matches by byte, and pages by that order', {
    methods: ['putPage', 'getPage', 'replaceWantedLinkRows', 'listWantedPages'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    // Equal reference counts put the target source and ref in the order: four refs in one source, one ref in each of two.
    const targets = FOUR.map((ref) => ({ source: 'default', ref: `people/${ref}`, kind: 'slug' as const }));
    await originPage(engine, 'notes/a', [...targets, ...SOURCES.map((source) => ({ source, ref: 'people/shared', kind: 'slug' as const }))]);
    // One target wanted by four origins: the sample is the first three by byte slug.
    for (const key of FOUR) await originPage(engine, `from/${key}`, [{ source: 'default', ref: 'people/popular', kind: 'slug' }]);
    // A name wanted by one origin and matched by four pages: the match list keeps three by byte slug.
    await originPage(engine, 'notes/names', [{ source: 'default', ref: 'carol', kind: 'name' }]);
    for (const key of FOUR) await engine.putPage(`${key}/carol`, note(key));
    const all = await engine.listWantedPages({ sourceId: 'default', limit: 50, offset: 0 });
    const flat = all.rows.map((r) => `${r.target_source_id}:${r.target}`);
    const paged = [] as string[];
    for (let offset = 0; offset < all.total; offset += 3) {
      paged.push(...(await engine.listWantedPages({ sourceId: 'default', limit: 3, offset })).rows.map((r) => `${r.target_source_id}:${r.target}`));
    }
    const popular = all.rows.find((r) => r.target === 'people/popular')!;
    const carol = all.rows.find((r) => r.target === 'carol')!;
    const out = { flat, paged, sample: popular.sample_origins.map((o) => o.slug), matches: carol.existing_matches.map((m) => m.slug) };
    expect(out.sample).toEqual(FOUR_BYTES.map((k) => `from/${k}`).slice(0, 3));
    expect(out.matches).toEqual(FOUR_BYTES.map((k) => `${k}/carol`).slice(0, 3));
    // `people/popular` has the most references; the single-reference targets follow by byte source id and ref.
    const single = [...SOURCES.map((source) => ({ source, ref: 'people/shared' })), ...FOUR.map((ref) => ({ source: 'default', ref: `people/${ref}` })), { source: 'default', ref: 'carol' }]
      .map((t) => ({ ...t, key: `${t.source}:${t.ref}` }));
    const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
    expect(flat).toEqual(['default:people/popular', ...single.sort((x, y) => bytes(x.source, y.source) || bytes(x.ref, y.ref)).map((t) => t.key)]);
    expect(paged).toEqual(flat);
    return out;
  });

  parityTest('listEntityIdentityRows lists members by byte entity id, source id and slug', {
    methods: ['putPage', 'linkEntityIdentityRow', 'listEntityIdentityRows'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    const person = (title: string): PageInput => ({ type: 'person' as never, title, compiled_truth: `${title} body`, timeline: '' });
    const link = (entityId: string, sourceId: string, slug: string) =>
      engine.linkEntityIdentityRow({ entityId, slug, sourceId, confidence: 1, establishedBy: 'manual', canonical: null });
    // One group per key (default source), one group with three slugs in one source, one with one slug in two sources.
    for (const key of TEXT) { await engine.putPage(`people/${key}`, person(key)); await link(`g-${key}`, 'default', `people/${key}`); }
    for (const key of TEXT) { await engine.putPage(`slugs/${key}`, person(key), { sourceId: 'ab' }); await link('h-slugs', 'ab', `slugs/${key}`); }
    for (const source of SOURCES) { await engine.putPage('people/twin', person('twin'), { sourceId: source }); await link('h-twin', source, 'people/twin'); }
    const out = (await engine.listEntityIdentityRows({})).map((r) => `${r.entity_id}:${r.source_id}:${r.slug}`);
    expect(out).toEqual([
      ...byteOrder(TEXT.map((k) => `g-${k}`)).map((e) => `${e}:default:people/${e.slice(2)}`),
      ...BYTES.map((k) => `h-slugs:ab:slugs/${k}`), 'h-twin:a-z:people/twin', 'h-twin:ab:people/twin',
    ]);
    return out;
  });
});

describe('entity resolver reads sort candidate slugs by byte', () => {
  parityTest('sibling, similarity, prefix and named-slug candidates tie-break and cut by byte slug', {
    methods: ['putPage', 'readIdentitySiblingCandidates', 'readTrigramCandidates', 'readPrefixCandidates', 'readNamedEntitySlugs'],
  }, async (engine) => {
    // Equal titles tie on similarity and on connection count (none), so the slug order alone decides every cut.
    for (const key of SEVEN) await engine.putPage(`people/${key}`, { type: 'person' as never, title: 'Zed', compiled_truth: 'Zed body', timeline: '' });
    const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug);
    const out = {
      siblings: slugs(await engine.readIdentitySiblingCandidates('default', { types: ['person'], subject: 'zed', limit: 3 })),
      fuzzy: slugs(await engine.readTrigramCandidates('default', { arm: 'fuzzy', titleLc: 'zed', slugFragment: 'people/' })),
      sameName: slugs(await engine.readTrigramCandidates('default', { arm: 'same_name', titleLc: 'zed', slugFragment: 'people/', privacy: 'none' })),
      near: slugs(await engine.readTrigramCandidates('default', { arm: 'near', titleLc: 'zed', slugFragment: 'people/', privacy: 'none' })),
      prefixAny: slugs(await engine.readPrefixCandidates('default', { patterns: ['people/%'] })),
      prefixOne: slugs(await engine.readPrefixCandidates('default', { pattern: 'people/%' })),
      named: await engine.readNamedEntitySlugs('default', SEVEN.map((k) => `people/${k}`), 'none'),
    };
    const bytes = SEVEN_BYTES.map((k) => `people/${k}`);
    expect(out).toEqual({
      siblings: bytes.slice(0, 3), fuzzy: bytes.slice(0, 5), sameName: bytes.slice(0, 5), near: bytes, prefixAny: bytes, prefixOne: bytes.slice(0, 5), named: bytes.slice(0, 5),
    });
    return out;
  });
});

describe('fact reads sort source ids, slugs and subjects by byte', () => {
  const LANE = 'hook:agent-session';
  const EXTRACTOR = 'cli:extract-conversation-facts';
  const remember = async (engine: BrainEngine, text: string, extra: Record<string, unknown>, sourceId: string): Promise<number> => {
    const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: LANE, embedding: null, ...extra } as NewFact, { source_id: sourceId });
    return Number(out.id);
  };
  let row = 0;
  const fenced = async (engine: BrainEngine, text: string, extra: Record<string, unknown>, sourceId: string): Promise<number> => {
    const res = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'private', source: 'fence', row_num: ++row, ...extra }] as never, { source_id: sourceId });
    return Number(res.ids[0]);
  };

  parityTest('session and captured facts list by byte source id, and extractor facts by byte source id and slug', {
    methods: ['insertFact', 'insertFacts', 'expireFact', 'putPage', 'listSessionFactsForClassification', 'listCapturedFactsForClassification', 'listExtractorFactsForClassification'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    // Written in en_US order (`ab` first), so the ids do not help.
    for (const source of SOURCES) await remember(engine, `session fact in ${source}`, {}, source);
    for (const source of SOURCES) {
      for (const slug of TEXT.map((k) => `chats/${k}`)) {
        await engine.putPage(slug, note(slug), { sourceId: source });
        const id = await fenced(engine, `extracted ${source} ${slug}`, { source: `${EXTRACTOR}:v1`, source_markdown_slug: slug, row_num: null }, source);
        expect(await engine.expireFact(id)).toBe(true);
      }
    }
    const lanes = [LANE, 'hook:agent-session-raw'];
    const out = {
      session: (await engine.listSessionFactsForClassification(SOURCES, lanes, null)).map((r) => r.source_id),
      captured: (await engine.listCapturedFactsForClassification(SOURCES, lanes, null)).map((r) => r.source_id),
      extractor: (await engine.listExtractorFactsForClassification(SOURCES, null)).map((r) => `${r.source_id}:${r.slug}`),
    };
    expect(out.session).toEqual(['a-z', 'ab']);
    expect(out.captured).toEqual(['a-z', 'ab']);
    expect(out.extractor).toEqual(['a-z', 'ab'].flatMap((s) => BYTES.map((k) => `${s}:chats/${k}`)));
    return out;
  });

  parityTest('findBulkFactDays lists bulk days by byte source id with the top five source tags by byte on a tie', {
    methods: ['insertFact', 'findBulkFactDays'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    const day = new Date('2026-03-10T09:00:00Z');
    for (const source of SOURCES) for (const tag of SEVEN) await remember(engine, `${tag} fact`, { source: tag, entity_slug: `e/${tag}`, valid_from: day }, source);
    const days = await engine.findBulkFactDays(undefined, { min_facts: 7, min_share: 0.5, min_entities: 1 });
    const out = days.map((d) => ({ source: d.source_id, top: (typeof d.top_sources === 'string' ? JSON.parse(d.top_sources) : d.top_sources ?? []).map((t: { source: string }) => t.source) }));
    expect(out).toEqual(['a-z', 'ab'].map((source) => ({ source, top: SEVEN_BYTES.slice(0, 5) })));
    return out;
  });

  parityTest('getFactsHealth keeps the five top entities of equal count by byte slug', { methods: ['insertFact', 'getFactsHealth'] }, async (engine) => {
    for (const key of SEVEN) await remember(engine, `about ${key}`, { entity_slug: `people/${key}`, visibility: 'world' }, 'default');
    const health = await engine.getFactsHealth('default');
    const out = health.top_entities.map((e) => e.entity_slug);
    expect(out).toEqual(SEVEN_BYTES.slice(0, 5).map((k) => `people/${k}`));
    return out;
  });

  parityTest('countUncomparableFacts lists sources of equal count by byte id', { methods: ['insertFact', 'countUncomparableFacts'] }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const source of SOURCES) await remember(engine, `bare in ${source}`, { entity_slug: 'people/u' }, source);
    const rows = await engine.countUncomparableFacts({ scope: { sourceIds: SOURCES, worldOnly: false, excludePrivate: false }, dims: 1536, model: 'm1', declared: true });
    const out = rows.map((r) => r.source_id);
    expect(out).toEqual(['a-z', 'ab']);
    return out;
  });

  parityTest('listFactsReconcileBacklog lists the due fenced pages by byte source id and slug', {
    methods: ['putPage', 'listFactsReconcileBacklog'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const source of SOURCES) {
      for (const key of TEXT) await engine.putPage(`notes/${key}`, note(`${FACTS_FENCE_BEGIN}\n${FACTS_FENCE_END}`), { sourceId: source });
    }
    const out = (await engine.listFactsReconcileBacklog()).rows.map((r) => `${r.source_id}:${r.slug}`);
    expect(out).toEqual(['a-z', 'ab'].flatMap((s) => BYTES.map((k) => `${s}:notes/${k}`)));
    return out;
  });

  parityTest('listFactWithdrawalKeys lists the keys of one claim by byte subject, and cuts by that order', {
    methods: ['insertFactWithdrawal', 'listFactWithdrawalKeys'],
  }, async (engine) => {
    for (const subject of TEXT) await engine.insertFactWithdrawal('default', 'private', 'Same claim', subject, null);
    const all = (await engine.listFactWithdrawalKeys('default', 100)).map((k) => k.subject);
    const cut = (await engine.listFactWithdrawalKeys('default', 2)).map((k) => k.subject);
    expect({ all, cut }).toEqual({ all: BYTES, cut: BYTES.slice(0, 2) });
    return { all, cut };
  });
});

describe('link and graph reads sort page slugs and provenance tags by byte', () => {
  const SOURCE_TAGS = ['ab', 'a-z', 'a0'];

  parityTest('listLinkSources lists provenance tags of equal count by byte', { methods: ['putPage', 'addLink', 'listLinkSources'] }, async (engine) => {
    await putAll(engine, ['ls/root', 'ls/leaf']);
    for (const tag of SOURCE_TAGS) await engine.addLink('ls/root', 'ls/leaf', `via ${tag}`, `t-${tag}`, tag);
    const out = (await engine.listLinkSources()).map((r) => r.link_source);
    expect(out).toEqual(byteOrder(SOURCE_TAGS));
    return out;
  });

  parityTest('findOrphanPages lists orphans by byte slug', { methods: ['putPage', 'findOrphanPages'] }, async (engine) => {
    await putAll(engine, TEXT.map((k) => `orph/${k}`));
    const out = (await engine.findOrphanPages()).map((p) => p.slug);
    expect(out).toEqual(BYTES.map((k) => `orph/${k}`));
    return out;
  });

  parityTest('traverseGraph and traversePathsDetailed walk neighbours by byte slug and cut a layer by that order', {
    methods: ['putPage', 'addLink', 'traverseGraph', 'traversePathsDetailed'],
  }, async (engine) => {
    await putAll(engine, ['g/root', ...FOUR.map((k) => `g/${k}`)]);
    for (const k of FOUR) await engine.addLink('g/root', `g/${k}`, `to ${k}`, 'mentions', 'manual');
    const full = (await engine.traverseGraph('g/root', 2)).map((n) => `${n.depth}:${n.slug}[${n.links.length}]`);
    const cut = (await engine.traverseGraph('g/root', 2, { frontierCap: 3 })).map((n) => `${n.depth}:${n.slug}`);
    const both = (await engine.traversePathsDetailed('g/root', { depth: 2, direction: 'both' })).paths.map((p) => `${p.from_slug}>${p.to_slug}`);
    const inward = (await engine.traversePathsDetailed(`g/${FOUR[0]}`, { depth: 2, direction: 'in' })).paths.map((p) => `${p.from_slug}>${p.to_slug}`);
    const kids = FOUR_BYTES.map((k) => `g/${k}`);
    expect(full).toEqual(['0:g/root[4]', ...kids.map((s) => `1:${s}[0]`)]);
    expect(cut).toEqual(['0:g/root', ...kids.slice(0, 3).map((s) => `1:${s}`)]);
    expect(both).toEqual(kids.map((s) => `g/root>${s}`));
    expect(inward).toEqual([`g/root>g/${FOUR[0]}`]);
    return { full, cut, both, inward };
  });
});

describe('page listings sort and page by byte slug and source id', () => {
  const ALL = SEVEN.map((k) => `s/${k}`);
  const ALL_BYTES = byteOrder(ALL);

  parityTest('listPages sorted by slug keeps the byte order through a slugAfter keyset and a limit cut', { methods: ['putPage', 'listPages'] }, async (engine) => {
    await putAll(engine, ALL);
    const cut = (await engine.listPages({ sort: 'slug', limit: 3 })).map((p) => p.slug);
    const walked: string[] = [];
    const pages: string[][] = [];
    for (let after: string | undefined; ;) {
      const page = (await engine.listPages({ sort: 'slug', limit: 2, ...(after === undefined ? {} : { slugAfter: after }) })).map((p) => p.slug);
      if (page.length === 0) break;
      pages.push(page);
      walked.push(...page);
      after = page[page.length - 1];
    }
    expect({ cut, walked }).toEqual({ cut: ALL_BYTES.slice(0, 3), walked: ALL_BYTES });
    return { cut, pages };
  });

  // One transaction stamps every page with its start time (`now()` on the SQL engines, the store's transaction clock on
  // Rust), so the seven pages tie on updated_at and the slug decides. The keyset resumes from `updated_at_iso`, the
  // column's microseconds, as a paging caller does.
  parityTest('listPages sorted by updated time breaks a timestamp tie by byte slug (descending for updated_desc), and its keyset resumes in that order', {
    methods: ['transaction', 'putPage', 'listPages'],
  }, async (engine) => {
    await engine.transaction(async (tx) => putAll(tx, ALL));
    const stamps = new Set((await engine.listPages({ sort: 'updated_asc', limit: 10 })).map((p) => p.updated_at_iso));
    expect(stamps.size).toBe(1);
    const [stamp] = [...stamps] as [string];
    const asc = (await engine.listPages({ sort: 'updated_asc', limit: 3 })).map((p) => p.slug);
    const desc = (await engine.listPages({ sort: 'updated_desc', limit: 3 })).map((p) => p.slug);
    const walked: string[] = [];
    for (let slug: string | undefined; ;) {
      const page = (await engine.listPages({ sort: 'updated_asc', limit: 2, ...(slug === undefined ? {} : { updatedAfterKeyset: { updatedAt: stamp, slug } }) })).map((p) => p.slug);
      if (page.length === 0) break;
      walked.push(...page);
      slug = page[page.length - 1];
    }
    expect({ asc, desc, walked }).toEqual({ asc: ALL_BYTES.slice(0, 3), desc: [...ALL_BYTES].reverse().slice(0, 3), walked: ALL_BYTES });
    return { asc, desc, walked };
  });

  parityTest('listAllPageRefs and listLinkPageMetadata list by byte source id then slug', {
    methods: ['putPage', 'listAllPageRefs', 'listLinkPageMetadata'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const source of SOURCES) await putAll(engine, TEXT.map((k) => `r/${k}`), source);
    const want = ['a-z', 'ab'].flatMap((s) => BYTES.map((k) => `${s}:r/${k}`));
    const refs = (await engine.listAllPageRefs()).map((r) => `${r.source_id}:${r.slug}`);
    const meta = (await engine.listLinkPageMetadata()).map((r) => `${r.source_id}:${r.slug}`);
    expect({ refs, meta }).toEqual({ refs: want, meta: want });
    return { refs, meta };
  });

  parityTest('purgeDeletedPages previews the pages of one deletion time by byte slug', {
    methods: ['putPage', 'transaction', 'softDeletePage', 'purgeDeletedPages'],
  }, async (engine) => {
    await putAll(engine, TEXT.map((k) => `d/${k}`));
    // One transaction stamps every tombstone with its start time (now()), so the deletion times tie.
    await engine.transaction(async (tx) => { for (const k of TEXT) await tx.softDeletePage(`d/${k}`); });
    // A 0-hour window takes every tombstone deleted before this statement.
    const out = (await engine.purgeDeletedPages(0, { dryRun: true })).pages!.map((p) => p.slug);
    expect(out).toEqual(BYTES.map((k) => `d/${k}`));
    return out;
  });

  parityTest('listPrefixSampledPages picks the byte-first slug of a prefix and lists the prefixes by byte', {
    methods: ['putPage', 'listPrefixSampledPages'],
  }, async (engine) => {
    const prefixes = ['dom/ab', 'dom/a-z', 'dom/a0'];
    for (const prefix of prefixes) await putAll(engine, TEXT.map((k) => `${prefix}/${k}`));
    const rows = await engine.listPrefixSampledPages({ prefixes });
    const out = rows.map((r) => `${r.prefix}:${r.slug}`);
    expect(out).toEqual(byteOrder(prefixes).map((prefix) => `${prefix}:${prefix}/${BYTES[0]}`));
    return out;
  });

  parityTest('countStaleFrontmatterKeyPages counts per source in byte source id order', { methods: ['putPage', 'countStaleFrontmatterKeyPages'] }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const source of SOURCES) await engine.putPage('notes/stale', { ...note('stale'), frontmatter: { tags: ['x'] } }, { sourceId: source });
    const out = (await engine.countStaleFrontmatterKeyPages({ sourceIds: SOURCES })).map((r) => r.source_id);
    expect(out).toEqual(['a-z', 'ab']);
    return out;
  });

  parityTest('listEmbeddingStateRows cuts chunkless pages by byte source id and slug', { methods: ['putPage', 'listEmbeddingStateRows'] }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const source of SOURCES) await putAll(engine, TEXT.map((k) => `e/${k}`), source);
    const states = ['embedded', 'pending', 'keyword_only', 'quarantined', 'empty', 'deleted_page_chunks', 'chunkless_healable'] as const;
    const rows = await engine.listEmbeddingStateRows({ states, limit: 4, purgeWindowHours: 72 });
    const out = rows.map((r) => `${r.source_id}:${r.slug}`);
    expect(out).toEqual(['a-z', 'ab'].flatMap((s) => BYTES.map((k) => `${s}:e/${k}`)).slice(0, 4));
    return out;
  });
});

describe('entity, graph, salience and enrich reads sort by byte', () => {
  parityTest('listPagesTitledIn lists matches by byte source id then slug', { methods: ['putPage', 'listPagesTitledIn'] }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const source of SOURCES) for (const k of TEXT) await engine.putPage(`t/${k}`, { ...note('Quartz Falcon'), title: 'Quartz Falcon' }, { sourceId: source });
    const out = (await engine.listPagesTitledIn('news about quartz falcon', {})).map((p) => `${p.source_id}:${p.slug}`);
    expect(out).toEqual(['a-z', 'ab'].flatMap((s) => BYTES.map((k) => `${s}:t/${k}`)));
    return out;
  });

  parityTest('listJunkEntityHubs names the byte-first source as the canonical twin when none is default', {
    methods: ['putPage', 'addLink', 'listJunkEntityHubs'],
  }, async (engine, backend) => {
    for (const source of [...SOURCES, 'zz']) await createSource(engine, backend, source);
    for (const source of [...SOURCES, 'zz']) await engine.putPage('x/hub', note('hub'), { sourceId: source });
    for (const k of ['one', 'two']) await engine.putPage(`x/${k}`, note(k), { sourceId: 'zz' });
    for (const k of ['one', 'two']) await engine.addLink('x/hub', `x/${k}`, 'to', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'zz', toSourceId: 'zz' });
    const rows = await engine.listJunkEntityHubs({ edgeThreshold: 1, maxChunks: 5, limit: 10 });
    const out = rows.filter((r) => r.slug === 'x/hub').map((r) => `${r.source_id}->${r.canonical_twin_source}`);
    expect(out).toEqual(['zz->a-z']);
    return out;
  });

  parityTest('listRecordMetadataRows lists the pages a record amends by byte slug', { methods: ['putPage', 'getPage', 'addLink', 'listRecordMetadataRows'] }, async (engine) => {
    await putAll(engine, ['m/root', ...TEXT.map((k) => `m/${k}`)]);
    for (const k of TEXT) await engine.addLink('m/root', `m/${k}`, 'amends it', 'amends', 'manual');
    const root = (await engine.getPage('m/root'))!;
    const { links } = await engine.listRecordMetadataRows([root.id], { referrerSources: ['default'], excludePrivate: false });
    const out = links.map((l) => l.slug);
    expect(out).toEqual(BYTES.map((k) => `m/${k}`));
    return out;
  });

  parityTest('listEnrichCandidates cuts equal-ranked pages by byte source id and slug for the inbound-links and salience orders', {
    methods: ['putPage', 'listEnrichCandidates'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const source of SOURCES) for (const k of TEXT) await engine.putPage(`people/${k}`, { type: 'person', title: k, compiled_truth: 'Stub.', timeline: '' }, { sourceId: source });
    const want = ['a-z', 'ab'].flatMap((s) => BYTES.map((k) => `${s}:people/${k}`)).slice(0, 4);
    const base = { types: ['person' as const], thinThreshold: 100, limit: 4 };
    const inbound = (await engine.listEnrichCandidates({ ...base, order: 'inbound-links' })).map((r) => `${r.source_id}:${r.slug}`);
    const salience = (await engine.listEnrichCandidates({ ...base, order: 'salience' })).map((r) => `${r.source_id}:${r.slug}`);
    expect({ inbound, salience }).toEqual({ inbound: want, salience: want });
    return { inbound, salience };
  });

  // The Rust store cannot stamp one updated_at on many pages, so the tie that makes the slug decide stops it here.
  parityTest('getRecentSalience and the updated enrich order cut a tie of updated time by byte source id and slug', {
    methods: ['putPage', 'transaction', 'getRecentSalience', 'listEnrichCandidates'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    // One transaction stamps every page with its start time (now()), so the updated times tie; no page is touched.
    await engine.transaction(async (tx) => {
      for (const source of SOURCES) for (const k of TEXT) await tx.putPage(`people/${k}`, { type: 'person', title: k, compiled_truth: 'Stub.', timeline: '' }, { sourceId: source });
    });
    const want = ['a-z', 'ab'].flatMap((s) => BYTES.map((k) => `${s}:people/${k}`)).slice(0, 4);
    const salience = (await engine.getRecentSalience({ days: 7, limit: 4 })).map((r) => `${r.source_id}:${r.slug}`);
    const updated = (await engine.listEnrichCandidates({ types: ['person'], thinThreshold: 100, order: 'updated', limit: 4 })).map((r) => `${r.source_id}:${r.slug}`);
    expect({ salience, updated }).toEqual({ salience: want, updated: want });
    return { salience, updated };
  });

  parityTest('listOriginClaims lists the holders of several origins by byte slug', { methods: ['putPage', 'listOriginClaims'] }, async (engine) => {
    for (const k of TEXT) await engine.putPage(`o/${k}`, { ...note(k), source_path: `shared/${k}.md` });
    const spellings = TEXT.map((k) => `shared/${k}.md`);
    const out = (await engine.listOriginClaims('default', spellings, { lockKeys: spellings })).map((r) => r.slug);
    expect(out).toEqual(BYTES.map((k) => `o/${k}`));
    return out;
  });
});

describe('hold, notifier and withdrawal reads sort by byte', () => {
  parityTest('listSourceWantedMarkers keeps its order for markers of one due time', {
    methods: ['transaction', 'upsertWantedMarker', 'listSourceWantedMarkers'],
  }, async (engine) => {
    // One transaction stamps every marker with its start time (now()), so the due times tie.
    await engine.transaction(async (tx) => {
      for (const intent of ['full', 'pull', 'freshness'] as const) {
        await tx.upsertWantedMarker({ sourceId: 'default', intent, wantedHead: intent === 'freshness' ? 'abc' : null, requestedBy: 'webhook' });
      }
    });
    const out = (await engine.listSourceWantedMarkers('default')).map((m) => m.intent);
    expect(out).toEqual(['freshness', 'full', 'pull']);
    return out;
  });

  parityTest('readGitHoldRecords and readHeldPageRows list hold rows by byte source id then fingerprint', {
    methods: ['putPage', 'getPage', 'readSourceState', 'writeGitHoldRow', 'readGitHoldRecords', 'readHeldPageRows'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    const pageIds: string[] = [];
    for (const source of SOURCES) {
      await engine.putPage('h/page', note('held'), { sourceId: source });
      const page = (await engine.getPage('h/page', { sourceId: source }))!;
      pageIds.push(String(page.id));
      const { incarnation } = (await engine.readSourceState(source))!;
      // The hold's fingerprint is source:incarnation:path, so within one source the path orders the rows.
      for (const fp of TEXT) {
        const record = { source_id: source, incarnation, page_id: String(page.id), run_id: 'run-1', tag: `${source}|${fp}` };
        await engine.writeGitHoldRow(source, incarnation, fp, record);
      }
    }
    const records = (await engine.readGitHoldRecords<{ tag: string }>({ sourceIds: SOURCES })).map((r) => r.record.tag);
    const held = (await engine.readHeldPageRows<{ tag: string }>(pageIds)).map((r) => r.record.tag);
    const want = byteOrder(SOURCES.flatMap((s) => TEXT.map((k) => `${s}|${k}`)));
    expect({ records, held }).toEqual({ records: want, held: want });
    return { records, held };
  });

  parityTest('listUnwithdrawnFacts lists retired facts by byte source id then page slug', {
    methods: ['putPage', 'insertFact', 'expireFact', 'transaction', 'readLiveGenerationRow', 'activateGenerationRows', 'listUnwithdrawnFacts'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const source of SOURCES) {
      for (const k of TEXT) {
        const slug = `u/${k}`;
        await engine.putPage(slug, note(slug), { sourceId: source });
        const fact = `retired in ${source} ${k}`;
        const out = await engine.insertFact({ fact, entity_slug: null, visibility: 'private', source: 'fence', embedding: null } as NewFact, { source_id: source });
        expect(await engine.expireFact(Number(out.id))).toBe(true);
        await recordFenceRetirement(engine, source, slug, Number(out.id), { fact, visibility: 'private' });
      }
    }
    const rows = await engine.listUnwithdrawnFacts(SOURCES, null, 'fact_fence');
    const out = rows.map((r) => `${r.source_id}:${r.slug}`);
    expect(out).toEqual(['a-z', 'ab'].flatMap((s) => BYTES.map((k) => `${s}:u/${k}`)));
    return out;
  });
});
