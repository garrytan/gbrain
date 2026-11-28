/**
 * BrainEngine parity: the entity-name and relational reads a remote query, search, recall, traverse_graph or
 * memory_recall reaches, called over MCP stdio (dispatchToolCall with remote: true).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded, multi-user or served) a remote
 *    caller's question that names an entity resolves it and answers the same pages, through these typed members:
 *    readPageTitle (a title match), readPageTitlesById (an entity-anchored current-state query), readPrefixCandidates /
 *    readPrefixDirs / readPrefixTitleMatches (a bare name that prefixes several slugs), readSiblingGroupRows (two live
 *    pages of one name), readSeedTitleSlugs (a relational question that names a meeting by its title), resolveChainAnchorRows
 *    (traverse_graph), readSourcesNotReadable (a recall over the floor), and, for a non-owner member's grant,
 *    readSharedSourceRows (the shared set the grant reads, a member the served client refuses: the owner IPC denies it) and
 *    readScopeSourceConfigs (memory_recall).
 *    The seed holds a private page and a readers-only page with their own markers in the prefix family, the meeting
 *    titles and the people; no answer to the remote caller carries a marker.
 *  - Regression: a served client of a brain server refused one of these members with a typed refusal while the remote
 *    operation that reaches it was served, so the question stopped; a member that answered a hidden page's title or slug
 *    would show the marker here.
 *  - Why existing coverage misses it: the member parity files call each member directly, never through the remote
 *    operation, and the served set had no case that asks a remote question.
 *  - Seam: none. Pages are seeded with putPage, sealChunks, setPageAliases and addLink; the operations run as production code.
 */
import { expect } from 'bun:test';
import { parityArms, type EngineMethod } from './harness.ts';
import { rustServedRequested } from './rust-arm.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MEMBER_AUTH, remote, remoteView, seedEntityBrain, watchRefusals } from '../helpers/served-remote-brain.ts';

const { parityTest } = parityArms(testBackends());

const SEEDING: EngineMethod[] = ['putPage', 'sealChunks', 'setPageAliases', 'addLink', 'setConfig'];

parityTest('a remote question that names an entity by a bare name, a title or two pages of one name answers the open pages only', {
  // On a served route the fuzzy candidates read is refused (findFuzzyEntityCandidates, a remote deny pinned in
  // test/rust-stop-pins/l3-served-denies.tsv), so the relational seed step that follows it (readSeedTitleSlugs) runs in process only.
  methods: [...SEEDING, 'readPageTitle', 'readPrefixCandidates', 'readPrefixDirs', 'readPrefixTitleMatches', 'readSiblingGroupRows',
    ...(rustServedRequested() ? [] : ['readSeedTitleSlugs'] as const)],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedEntityBrain(engine);
  const answer = {
    barePrefix: await remoteView(engine, 'query', { query: 'who works at Acme' }),
    prefixFamily: await remoteView(engine, 'query', { query: 'who works at Globex' }),
    twoPagesOfOneName: await remoteView(engine, 'query', { query: 'who works at Zed X' }),
    meetingTitle: await remoteView(engine, 'query', { query: 'who attended Acme sync' }),
    recallPrefixFamily: await remoteView(engine, 'recall', { entity: 'Globex' }),
  };
  for (const view of Object.values(answer)) {
    expect(view.isError).toBe(false);
    expect(view.leaked).toEqual([]);
  }
  return answer;
});

parityTest('a remote current-state query anchors on the named entity and traverse_graph resolves its anchor, with no hidden page', {
  methods: [...SEEDING, 'readPageTitlesById', 'resolveChainAnchorRows'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedEntityBrain(engine);
  const answer = {
    currentState: await remoteView(engine, 'query', { query: 'what is the current status of Acme' }),
    chain: await remoteView(engine, 'traverse_graph', { slug: 'companies/acme', hops: [{ link_type: 'works_at', toward: 'subject' }] }),
  };
  for (const view of Object.values(answer)) {
    expect(view.isError).toBe(false);
    expect(view.leaked).toEqual([]);
  }
  expect(answer.chain.slugs).toEqual(['people/jane-doe']);
  return answer;
});

parityTest('a remote recall over the floor asks which sources are not readable, and answers without a hidden page', {
  methods: [...SEEDING, 'readSourcesNotReadable'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedEntityBrain(engine);
  const answer = {
    recallEntity: await remoteView(engine, 'recall', { entity: 'people/jane-doe' }),
    search: await remoteView(engine, 'search', { query: 'Acme' }),
  };
  for (const view of Object.values(answer)) {
    expect(view.isError).toBe(false);
    expect(view.leaked).toEqual([]);
  }
  return answer;
});

parityTest('a non-owner member\'s grant reads the shared set and its sources\' configs, and answers the open pages only', {
  methods: [...SEEDING, 'readSharedSourceRows', 'readScopeSourceConfigs'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedEntityBrain(engine);
  const watched = watchRefusals(engine);
  const recall = await remote(watched.engine, 'recall', { query: 'who works at Acme' }, MEMBER_AUTH);
  const answer = {
    recall: await remoteView(engine, 'recall', { query: 'who works at Acme' }, MEMBER_AUTH),
    memoryRecall: await remoteView(engine, 'memory_recall', { query: 'Acme' }, MEMBER_AUTH),
    page: await remoteView(engine, 'get_page', { slug: 'companies/acme' }, MEMBER_AUTH),
    hidden: await remote(engine, 'get_page', { slug: 'people/jane-zqprivmark' }, MEMBER_AUTH).then(r => ({ isError: r.isError, showsBody: r.text.includes('private note') })),
  };
  expect(recall.isError).toBe(false);
  // The grant's shared-set read crosses with the call (the dispatch preamble is not remote-marked), so no member the ops call refuses.
  expect([...watched.refused]).toEqual([]);
  for (const view of [answer.recall, answer.memoryRecall, answer.page]) {
    expect(view.isError).toBe(false);
    expect(view.leaked).toEqual([]);
  }
  expect(answer.page.slugs).toEqual(['companies/acme']);
  expect(answer.hidden).toEqual({ isError: true, showsBody: false });
  return answer;
});
