/**
 * BrainEngine parity: the retrieval reflex's page reads and the proactive brief's entity-page read. The reflex
 * resolver and the brief read pages as raw SQL inside fail-soft catches; on a Rust brain each read was refused, the
 * catch took its fallback, and the agent got no pointer and no counterparty while every arm still answered.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the members readReflexLiveKeys, readReflexPages and readBriefEntityPages answer what PGLite answers, and the
 *    callers (resolveEntitiesToPointers, resolvePullCounterparty) resolve the same pointers and counterparty.
 *  - Regression: a reflex arm or brief read that runs executeRaw inside a catch resolves nothing on Rust: no alias,
 *    surname, CJK or weak-title pointer, and no counterparty.
 *  - Why existing coverage misses it: the census fixture has no CJK, surname or weak-title page, and the reflex tests
 *    build PGLite or Postgres engines only.
 *  - Seam: none. Pages and aliases are written with putPage and setPageAliases; the callers run as production code.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, sorted, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveEntitiesToPointers, type ResolvePointersOpts } from '../../src/core/context/retrieval-reflex.ts';
import { extractCandidates, extractCandidatesFromWindow } from '../../src/core/context/entity-salience.ts';
import { resolvePullCounterparty } from '../../src/core/context/proactive-brief.ts';
import { normalizeAlias } from '../../src/core/search/alias-normalize.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}) => ({
  type: type as 'note', title, compiled_truth: `${title} works on widgets. More text follows.`, timeline: '', frontmatter,
});

/** Entity pages for every reflex arm, a private page, a gone page and a same-title page in a second source. */
async function putReflexPages(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'second');
  await engine.putPage('people/alice-example', page('person', 'Alice Example'));
  await engine.putPage('projects/brain-index', page('project', 'Brain Index'));
  await engine.putPage('people/quinn-zorvexample', page('person', 'Quinn Zorvexample'));
  await engine.putPage('companies/zorvexample-labs', page('company', 'Labs Zorvexample'));
  await engine.putPage('people/ailisi-example', page('person', '爱丽丝'));
  await engine.putPage('companies/acme-example', page('company', 'Acme Example'));
  await engine.putPage('people/hidden-example', page('person', 'Hidden Example', { visibility: 'private' }));
  await engine.putPage('people/gone-example', page('person', 'Gone Example'));
  await engine.softDeletePage('people/gone-example');
  await engine.putPage('people/alice-example', page('person', 'Alice Example'), { sourceId: 'second' });
  await engine.putPage('people/bram-example', page('person', 'Bram Example'), { sourceId: 'second' });
  await engine.setPageAliases('people/alice-example', SRC, [normalizeAlias('Ally')]);
}

/**
 * The pointers a window resolves to, as (source, slug, arm). `message` reads the text as one message: only that
 * extractor marks lowercase multi-word n-grams, which the weak-title arm needs.
 */
async function pointers(engine: BrainEngine, window: string, opts: ResolvePointersOpts = {}, message = false): Promise<string[]> {
  const candidates = message ? extractCandidates(window) : extractCandidatesFromWindow([{ role: 'user', text: window }]);
  const block = await resolveEntitiesToPointers(engine, SRC, candidates, { maxPointers: 10, suppression: 'slug-only', ...opts });
  return (block?.pointers ?? []).map(p => `${p.source_id}:${p.slug}:${p.arm}`);
}

const keys = (rows: ReadonlyArray<{ source_id: string; slug: string }>) => sorted(rows.map(r => `${r.source_id}:${r.slug}`));

describe('engine parity: retrieval reflex reads', () => {
  parityTest('readReflexLiveKeys and readReflexPages read the live pages of the sources under the privacy mode', {
    methods: ['putPage', 'softDeletePage', 'setPageAliases', 'readReflexLiveKeys', 'readReflexPages'],
  }, async (engine, backend) => {
    await putReflexPages(engine, backend);
    const both = ['default', 'second'];
    const slugs = ['people/alice-example', 'people/hidden-example', 'people/gone-example', 'people/bram-example'];
    const names = {
      kind: 'names' as const, titlesLc: ['brain index'], exactSlugs: ['alice-example'],
      slugSuffixes: ['%/alice-example', '%/acme\\_example'],
    };
    const namesRows = await engine.readReflexPages({ sourceIds: [SRC], privacy: 'floor' }, names);
    const answer = {
      liveAll: keys(await engine.readReflexLiveKeys({ sourceIds: both, privacy: 'none' }, slugs)),
      liveFloor: keys(await engine.readReflexLiveKeys({ sourceIds: both, privacy: 'floor' }, slugs)),
      liveNoSource: await engine.readReflexLiveKeys({ sourceIds: [], privacy: 'none' }, slugs),
      // `names` reads in page-id order: alice (written first), then brain-index.
      names: namesRows.map(r => r.slug),
      namesRow: { ...namesRows[0], compiled_truth: namesRows[0]?.compiled_truth?.slice(0, 13) },
      surname: (await engine.readReflexPages({ sourceIds: [SRC], privacy: 'floor' },
        { ...names, titlesLc: [], exactSlugs: [], slugSuffixes: [], surnamePatterns: ['% zorvexample'] })).map(r => r.slug),
      slugsNone: keys(await engine.readReflexPages({ sourceIds: both, privacy: 'none' }, { kind: 'slugs', slugs })),
      slugsFloor: keys(await engine.readReflexPages({ sourceIds: both, privacy: 'floor' }, { kind: 'slugs', slugs })),
      cjk: keys(await engine.readReflexPages({ sourceIds: both, privacy: 'floor' }, { kind: 'cjkExact', norms: ['爱丽丝'] })),
      titles: keys(await engine.readReflexPages({ sourceIds: both, privacy: 'none' },
        { kind: 'titles', titlesLc: ['alice example', 'hidden example', 'gone example'] })),
    };
    expect(answer).toEqual({
      liveAll: ['default:people/alice-example', 'default:people/hidden-example', 'second:people/alice-example', 'second:people/bram-example'],
      liveFloor: ['default:people/alice-example', 'second:people/alice-example', 'second:people/bram-example'],
      liveNoSource: [],
      names: ['people/alice-example', 'projects/brain-index'],
      namesRow: { slug: 'people/alice-example', source_id: SRC, title: 'Alice Example', type: 'person', frontmatter: {}, compiled_truth: 'Alice Example' },
      surname: ['people/quinn-zorvexample'],
      slugsNone: ['default:people/alice-example', 'default:people/hidden-example', 'second:people/alice-example', 'second:people/bram-example'],
      slugsFloor: ['default:people/alice-example', 'second:people/alice-example', 'second:people/bram-example'],
      cjk: ['default:people/ailisi-example'],
      titles: ['default:people/alice-example', 'default:people/hidden-example', 'second:people/alice-example'],
    });
    return answer;
  });

  parityTest('readBriefEntityPages reads the live pages of one source under the privacy mode', {
    methods: ['putPage', 'softDeletePage', 'setPageAliases', 'readBriefEntityPages'],
  }, async (engine, backend) => {
    await putReflexPages(engine, backend);
    const slugs = ['people/alice-example', 'people/hidden-example', 'people/gone-example', 'people/bram-example'];
    const read = async (privacy: 'none' | 'floor' | 'caller', sourceId = SRC) =>
      sorted((await engine.readBriefEntityPages(sourceId, slugs, { privacy })).map(r => `${r.slug}|${r.title}|${r.type}`));
    const answer = {
      none: await read('none'),
      floor: await read('floor'),
      second: await read('floor', 'second'),
    };
    expect(answer).toEqual({
      none: ['people/alice-example|Alice Example|person', 'people/hidden-example|Hidden Example|person'],
      floor: ['people/alice-example|Alice Example|person'],
      second: ['people/alice-example|Alice Example|person', 'people/bram-example|Bram Example|person'],
    });
    return answer;
  });

  parityTest('the reflex resolves alias, title, surname, CJK and weak-title pointers', {
    methods: ['putPage', 'setPageAliases', 'resolveAliases', 'readReflexLiveKeys', 'readReflexPages'],
  }, async (engine, backend) => {
    await putReflexPages(engine, backend);
    const answer = {
      alias: sorted(await pointers(engine, 'user: ask Ally about Brain Index')),
      surname: await pointers(engine, 'user: did Zorvexample reply'),
      cjk: await pointers(engine, 'user: 爱丽丝 said hi'),
      weakTitle: await pointers(engine, 'ask about acme example today', {}, true),
    };
    expect(answer).toEqual({
      alias: ['default:people/alice-example:alias', 'default:projects/brain-index:title'],
      surname: ['default:people/quinn-zorvexample:title-surname'],
      cjk: ['default:people/ailisi-example:cjk-title'],
      weakTitle: ['default:companies/acme-example:weak-title'],
    });
    return answer;
  });

  parityTest('the reflex hides private pages unless widened, and reads only the given sources', {
    methods: ['putPage', 'readReflexPages'],
  }, async (engine, backend) => {
    await putReflexPages(engine, backend);
    const window = 'user: met Hidden Example and Bram Example';
    const answer = {
      local: await pointers(engine, window),
      worldCaller: await withCallerAccess({ identity: [], applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] },
        () => pointers(engine, window, { forCaller: true })),
      widened: await pointers(engine, window, { excludePrivate: false }),
      bothSources: sorted(await pointers(engine, window, { sourceIds: ['default', 'second'] })),
    };
    expect(answer).toEqual({
      local: [],
      worldCaller: [],
      widened: ['default:people/hidden-example:title'],
      bothSources: ['second:people/bram-example:title'],
    });
    return answer;
  });

  parityTest('the brief pull resolves its counterparty by name and by slug', {
    methods: ['putPage', 'readReflexPages', 'readBriefEntityPages'],
  }, async (engine, backend) => {
    await putReflexPages(engine, backend);
    const opts = { excludePrivate: true };
    const answer = {
      byName: await resolvePullCounterparty(engine, SRC, 'Alice Example', opts),
      bySlug: await resolvePullCounterparty(engine, SRC, 'people/alice-example', opts),
      privateBySlug: await resolvePullCounterparty(engine, SRC, 'people/hidden-example', opts),
    };
    expect(answer).toEqual({
      byName: { slug: 'people/alice-example', source_id: SRC, display: 'Alice Example', confidence: 0.8 },
      bySlug: { slug: 'people/alice-example', source_id: SRC, display: 'Alice Example', confidence: 1 },
      privateBySlug: null,
    });
    return answer;
  });
});
