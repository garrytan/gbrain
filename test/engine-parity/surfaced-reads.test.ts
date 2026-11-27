/**
 * BrainEngine parity: the callers whose read once ran through executeRaw behind a catch that turned any error into a
 * quiet default (the lane 15 rows of the refusal-swallow triage). On a Rust brain each caller now answers through a
 * typed member, so it reports what the brain holds instead of the default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each caller below answers the same on PGLite, Postgres and Rust for the same writes.
 *  - Regression: on Rust the caller's executeRaw was refused and the catch answered the default: every member read as
 *    labelled-only, `schema sync` saw no untyped page under a prefix, the empty-corpus lint was skipped, and the
 *    query-cache invalidation reported 0 without asking.
 *  - Why existing coverage misses it: the caller tests run on PGLite (and Postgres), where executeRaw answers.
 *  - Seam: the real callers on each arm's engine; the schema pack is a file under a temporary GBRAIN_HOME.
 */
import { describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { labelledOnlyFor } from '../../src/core/access/labelled-only.ts';
import { extractableEmptyCorpus } from '../../src/core/schema-pack/lint-rules.ts';
import { invalidateQueryCache } from '../../src/core/schema-pack/query-cache-invalidator.ts';
import { runSyncCore } from '../../src/core/schema-pack/sync.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests } from '../../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../../src/core/schema-pack/registry.ts';
import { withEnv } from '../helpers/with-env.ts';
import { assertUnscopedReadReachesPages } from '../../src/core/sources-not-readable.ts';
import { __resetAccessReadLogForTests, droppedAccessReads, flushAccessReadLog, pruneAccessReadLog, recordAccessRead } from '../../src/core/access/read-log.ts';
import { readAccessLog, whoRead } from '../../src/commands/access-read-log.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, type = '') => ({ type: type as never, title, compiled_truth: `body ${title}`, timeline: '' });

/** A page at `slug` that records `path` as its file. */
async function pageAt(engine: BrainEngine, slug: string, path: string, type = ''): Promise<void> {
  await engine.putPage(slug, note(slug, type));
  await engine.refreshPageOrigin(slug, { sourceId: 'default', sourcePath: path });
}

describe('callers that once read a quiet default on a Rust brain', () => {
  parityTest('labelledOnlyFor names a labelled-only member, and never the owner, an unlabelled member or an unknown one', {
    methods: ['insertAccessMember', 'setAccessMemberLabelledOnly', 'setConfig', 'hasLabelledOnlyMemberAmong'],
  }, async (engine) => {
    const member = (id: string) => ({ id, displayName: id, email: null, kind: 'person' as const, groups: [], bindTokenId: null });
    for (const id of ['owner-example', 'alice-example', 'bob-example']) await engine.insertAccessMember(member(id));
    for (const id of ['owner-example', 'alice-example']) await engine.setAccessMemberLabelledOnly(id, true);
    const ask = (ids: string[]) => labelledOnlyFor(engine, [ids.map(id => `member:${id}`)]);
    const before = { alice: await ask(['alice-example']), owner: await ask(['owner-example']) };
    // The owner key is read with its spaces trimmed, as the SQL's btrim does.
    await engine.setConfig('access.owner_member', '  owner-example ');
    const out = {
      before,
      alice: await ask(['alice-example']),
      bob: await ask(['bob-example']),
      owner: await ask(['owner-example']),
      unknown: await ask(['nobody-example']),
      either: await ask(['bob-example', 'alice-example']),
      group: await labelledOnlyFor(engine, [['group:team-a']]),
      direct: await engine.hasLabelledOnlyMemberAmong(['bob-example', 'alice-example']),
    };
    expect(out).toEqual({ before: { alice: true, owner: true }, alice: true, bob: false, owner: false, unknown: false, either: true, group: false, direct: true });
    return out;
  });

  parityTest('the extractable_empty_corpus lint counts the pages under each path prefix, a LIKE wildcard included', {
    methods: ['putPage', 'refreshPageOrigin', 'countLivePagesAtPathPrefix', 'softDeletePage'],
  }, async (engine) => {
    await pageAt(engine, 'people/alice-example', 'people/alice-example.md');
    await pageAt(engine, 'gone/x', 'gone/x.md');
    await engine.softDeletePage('gone/x');
    const manifest = { name: 'tiny', page_types: [
      { name: 'person', extractable: true, path_prefixes: ['people/'] },
      { name: 'gone', extractable: true, path_prefixes: ['gone/'] },
      { name: 'wild', extractable: true, path_prefixes: ['peo_le/'] },
      { name: 'none', extractable: true, path_prefixes: ['none/', 'nada/'] },
      { name: 'skipped', extractable: false, path_prefixes: ['skipped/'] },
    ] };
    const issues = await extractableEmptyCorpus(manifest as never, { engine });
    const flagged = issues.map(i => i.type);
    expect(flagged).toEqual(['gone', 'none']);
    expect(await engine.countLivePagesAtPathPrefix('peo_le/')).toBe(1);
    return issues;
  });

  parityTest('schema sync counts and samples the untyped pages under each pack prefix, in one source or all', {
    methods: ['putPage', 'refreshPageOrigin', 'probeUntypedPathPrefix'],
  }, async (engine) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-surfaced-sync-'));
    try {
      const dir = join(home, 'tiny');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'pack.yaml');
      writeFileSync(path, 'api_version: gbrain-schema-pack-v1\nname: tiny\nversion: 1.0.0\ndescription: ""\ngbrain_min_version: 0.38.0\nextends: null\nborrow_from: []\n'
        + 'page_types:\n  - name: person\n    primitive: entity\n    path_prefixes:\n      - people/\n    aliases: []\n    extractable: false\n    expert_routing: false\n'
        + '  - name: place\n    primitive: entity\n    path_prefixes:\n      - places/\n    aliases: []\n    extractable: false\n    expert_routing: false\n'
        + 'link_types: []\nfrontmatter_links: []\ntakes_kinds:\n  - fact\n  - take\nenrichable_types: []\nfiling_rules: []\n', 'utf-8');
      _resetPackCacheForTests();
      __setPackLocatorForTests(name => (name === 'tiny' ? path : null));
      for (const slug of ['people/bob-example', 'people/ab', 'people/a-z']) await pageAt(engine, slug, `${slug}.md`);
      await pageAt(engine, 'people/typed-example', 'people/typed-example.md', 'person');
      const ctx = { engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false } as unknown as OperationContext;
      const out = await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => ({
        all: await runSyncCore(ctx, { apply: false }),
        scoped: await runSyncCore(ctx, { apply: false, sourceId: 'default' }),
        elsewhere: await runSyncCore(ctx, { apply: false, sourceId: 'no-such-source' }),
      }));
      const view = (r: Awaited<ReturnType<typeof runSyncCore>>) => r.per_prefix.map(p => ({ type: p.type, n: p.would_apply, sample: p.sample_slugs, dead: p.dead_prefix }));
      const result = { all: view(out.all), scoped: view(out.scoped), elsewhere: view(out.elsewhere) };
      const people = { type: 'person', n: 3, sample: ['people/a-z', 'people/ab', 'people/bob-example'], dead: false };
      const places = { type: 'place', n: 0, sample: [], dead: true };
      expect(await engine.probeUntypedPathPrefix('people/', 'default')).toEqual({ count: 3, sample: people.sample });
      expect(result).toEqual({ all: [people, places], scoped: [people, places], elsewhere: [{ ...people, n: 0, sample: [], dead: true }, places] });
      return result;
    } finally {
      _resetPackLocatorForTests();
      _resetPackCacheForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  parityTest('the schema-pack query-cache invalidation asks the brain, for one source or every source', {
    methods: ['invalidateQueryCacheRows'],
  }, async (engine) => {
    const out = { source: await invalidateQueryCache(engine, 'default'), all: await invalidateQueryCache(engine), direct: await engine.invalidateQueryCacheRows('default') };
    expect(out).toEqual({ source: { rows_invalidated: 0 }, all: { rows_invalidated: 0 }, direct: 0 });
    return out;
  });

  parityTest('an empty unscoped remote read is refused only when its sources hold nothing it can read and another source holds a page', {
    methods: ['putPage', 'insertFacts', 'readSourcesNotReadable'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ctx = { engine, remote: true, sourceId: 'default', auth: { hasSourceGrant: false }, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as OperationContext;
    const verdict = async (op: string) => assertUnscopedReadReachesPages(op, {}, ctx).then(() => 'answered', (e: { code?: string }) => e.code ?? String(e));
    const steps: Record<string, string> = {};
    steps.nothingAnywhere = await verdict('search');
    await engine.putPage('notes/elsewhere', note('elsewhere'), { sourceId: 'other' });
    steps.pageElsewhere = await verdict('search');
    await engine.putPage('notes/held', { ...note('held'), frontmatter: { quarantine: true } } as never);
    steps.quarantinedHere = await verdict('search');
    await engine.putPage('notes/private', { ...note('private'), frontmatter: { visibility: 'private' } } as never);
    steps.privateHere = await verdict('list_pages');
    await engine.insertFacts([{ fact: 'a world fact', kind: 'fact', visibility: 'world', notability: 'medium', source: 'test', entity_slug: 'people/alice-example' }] as never, { source_id: 'default' });
    steps.worldFactSearch = await verdict('search');
    steps.worldFactRecall = await verdict('recall');
    steps.namedSource = await assertUnscopedReadReachesPages('search', { source_id: 'default' }, ctx).then(() => 'answered', (e: { code?: string }) => e.code ?? String(e));
    steps.direct = String(await engine.readSourcesNotReadable(['default'], { facts: false, excludePrivate: true }));
    await engine.putPage('notes/open', note('open'));
    steps.readableHere = await verdict('search');
    expect(steps).toEqual({
      nothingAnywhere: 'answered', pageElsewhere: 'sources_not_readable', quarantinedHere: 'sources_not_readable', privateHere: 'sources_not_readable',
      worldFactSearch: 'sources_not_readable', worldFactRecall: 'answered', namedSource: 'answered', direct: 'true', readableHere: 'answered',
    });
    return steps;
  });

  // The read log's insert once ran raw SQL in a catch that dropped the batch: on Rust no read was ever logged.
  parityTest('the access read log keeps every logged read, and access log and who-read list them', {
    methods: ['putPage', 'softDeletePage', 'insertAccessReadLogRows', 'pruneAccessReadLog', 'readAccessReadLog', 'listAccessReadPageRefs', 'readAccessReadsOfPages', 'tallyAccessReadsOfPages'],
  }, async (engine, backend) => {
    __resetAccessReadLogForTests();
    try {
      await createSource(engine, backend, 'wiki');
      const id = async (slug: string, sourceId = 'default') => (await engine.putPage(slug, note(slug), { sourceId })).id;
      const [a, b, c] = [await id('notes/a'), await id('notes/a', 'wiki'), await id('notes/b')];
      await engine.softDeletePage('notes/b');
      const read = (member: string | null, audience: string[] | null, pageIds: number[], operation = 'search') =>
        recordAccessRead(engine, { member, audience, operation, transport: 'http', result_code: 'ok', page_ids: pageIds });
      read('alice-example', null, [a, c]);
      read(null, ['member:alice-example', 'member:bob-example'], [b], 'query');
      read('bob-example', null, [a]);
      read(null, null, [987654], 'get_page');
      await flushAccessReadLog();
      const ids = new Map([[`#987654`, 'missing']]);
      const view = (e: { member: string | null; audience: string[] | null; operation: string; pages: string[] }) =>
        `${e.member ?? (e.audience?.join('+') ?? '-')} ${e.operation} ${e.pages.map(p => ids.get(p) ?? p).join(',')}`;
      const all = (await readAccessLog(engine, {})).map(view);
      const alice = (await readAccessLog(engine, { member: 'alice-example' })).map(view);
      const limited = (await readAccessLog(engine, { limit: '1' })).length;
      const who = await whoRead(engine, 'notes/a', {});
      const whoWiki = await whoRead(engine, 'notes/a', { source: 'wiki' });
      const out = {
        dropped: droppedAccessReads(), all: [...all].sort(), alice: [...alice].sort(), limited,
        whoPages: who.pages, whoReaders: who.readers.map(r => `${r.who}:${r.reads}`).sort(), whoReads: who.reads.length,
        wikiReaders: whoWiki.readers.map(r => r.who), deleted: (await whoRead(engine, 'notes/b', {})).readers.map(r => r.who),
      };
      await pruneAccessReadLog(engine, 365, 1);
      const left = (await readAccessLog(engine, {})).length;
      expect({ ...out, left }).toEqual({
        dropped: 0,
        all: ['- get_page missing', 'alice-example search default:notes/a,default:notes/b', 'bob-example search default:notes/a', 'member:alice-example+member:bob-example query wiki:notes/a'],
        alice: ['alice-example search default:notes/a,default:notes/b', 'member:alice-example+member:bob-example query wiki:notes/a'],
        limited: 1,
        whoPages: ['default:notes/a', 'wiki:notes/a'], whoReaders: ['alice-example:1', 'bob-example:1', 'member:alice-example+member:bob-example:1'], whoReads: 3,
        wikiReaders: ['member:alice-example+member:bob-example'], deleted: ['alice-example'], left: 1,
      });
      // The writer flushes through the engine's own key (engineKey), so the harness sees the insert here; an empty batch writes nothing.
      await engine.insertAccessReadLogRows([]);
      await engine.pruneAccessReadLog(0, 0);
      return { ...out, left };
    } finally {
      __resetAccessReadLogForTests();
    }
  });
});
