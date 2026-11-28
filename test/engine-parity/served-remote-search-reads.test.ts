/**
 * BrainEngine parity — the member reads a remote search, query, exact search and recall make (lane L3 S4): the entity
 * anchor and its newest facts, page aliases, long-page sizes, page synopses, live slugs, exact snippet chunks, held-hit
 * rows, notifier status, folder access and the facts embedding column.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a remote caller (the MCP stdio pipe: world facts only) gets the same answer from every engine arm and
 *    from the served arm (the brain owner answers each member over the owner socket), and that answer never carries a
 *    page, hold or fact the caller may not read.
 *  - Regression: the served arm refuses any member that is not in OWNER_IPC_REMOTE_TYPED_READS. Several of these reads
 *    sit behind a catch that degrades silently (alias fan-out, held-hit stamping, folder access), so each case asserts
 *    `refused: []` and the member list rather than trusting a plausible answer.
 *  - Why existing coverage misses it: the members run inside remote ops, so no engine case names them with a remote caller.
 *  - Seam: dispatchToolCall with the stdio caller; recordingEngine reports the members called and the typed refusals.
 */
import { expect } from 'bun:test';
import { parityArms, recordingEngine } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP } from '../../src/core/engine-sql/persistence-journal.ts';
import { OPEN_MARK, PRIVATE_MARK, leaked, remoteCall, seedNova } from './served-remote-read-fixtures.ts';
import { chunk } from './chunk-fixtures.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';

const { parityTest } = parityArms(testBackends());

/** The config that turns on each read a current-state search makes: anchoring, the long-page unit, date headers and freshness. */
const SEARCH_CONFIG: Record<string, string> = {
  'search.entity_anchoring': 'true', 'search.long_page_unit': 'section', 'search.long_page_min_chars': '20',
  'search.evidence_date_header': 'true', 'sync.on_commit': 'true',
};

/** `engine` behind the recording proxy: the members called and the typed refusals. */
function watched(engine: BrainEngine) {
  const calls = new Set<string>();
  const refusals: unknown[] = [];
  return { engine: recordingEngine(engine, calls, refusals), calls, refused: () => refusals.map(e => String((e as { message?: unknown }).message ?? e).slice(0, 120)) };
}

for (const op of ['search', 'query'] as const) {
  parityTest(`a remote current-state ${op} anchors the entity, delivers its long page and shows no page or fact the caller may not read`, {
    methods: ['putPage', 'sealChunks', 'insertFacts', 'addLink', 'setConfig', 'readEntityAnchoredPages', 'readEntityNewestFacts', 'readPageAliasRows',
      'readLongPageSizes', 'readPageDateFieldsByIds', 'readNotifierStatusRows', 'readFolderAccess'],
    timeout: 240_000,
  }, async (engine: BrainEngine) => {
    await seedNova(engine);
    for (const [key, value] of Object.entries(SEARCH_CONFIG)) await engine.setConfig(key, value);
    const w = watched(engine);
    const reply = await remoteCall(w.engine, op, { query: 'what is Nova Example now' });
    const pages = reply.rows.filter(r => typeof r.slug === 'string');
    const view = {
      error: reply.error,
      slugs: pages.map(r => String(r.slug)).sort(),
      delivered: pages.map(r => `${r.slug}:${r.delivered?.reason ?? ''}`).sort(),
      dated: reply.text.includes('[observed 2026-02-14]'),
      facts: ['Nova leads the widgets team', 'Nova moved to Lisbon'].filter(f => reply.text.includes(f)),
      leaked: leaked(reply.text),
      refused: w.refused(),
    };
    expect(view).toEqual({
      error: false, slugs: ['notes/nova-open', 'people/nova-example'], delivered: ['notes/nova-open:long_page', 'people/nova-example:long_page'], dated: true,
      facts: ['Nova leads the widgets team', 'Nova moved to Lisbon'], leaked: [], refused: [],
    });
    for (const member of ['readEntityAnchoredPages', 'readEntityNewestFacts', 'readPageAliasRows', 'readLongPageSizes', 'readPageDateFieldsByIds', 'readNotifierStatusRows', 'readFolderAccess']) {
      expect(w.calls.has(member), member).toBe(true);
    }
    return view;
  });
}

/** A company, its investors (an open page, a private page and a readers-only page) and the typed edges that connect them. */
async function seedInvestors(engine: BrainEngine): Promise<void> {
  const put = async (slug: string, type: string, title: string, body: string, frontmatter: Record<string, unknown> = {}) => {
    await engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter });
    await engine.sealChunks(slug, [chunk(0, body)]);
  };
  await put('companies/widget-co', 'company', 'Widget Co', 'Widget Co makes widgets.');
  await put('people/alice-investor', 'person', 'Alice Investor', `Alice Investor backs widgets. ${OPEN_MARK}`);
  await put('people/bob-private', 'person', 'Bob Private', `Bob Private backs widgets. ${PRIVATE_MARK}`, { visibility: 'private' });
  await put('people/cleo-readers', 'person', 'Cleo Readers', 'Cleo Readers backs widgets. novamarkreaderspage8e17', { readable_by: ['alice-example'] });
  for (const from of ['people/alice-investor', 'people/bob-private', 'people/cleo-readers']) await engine.addLink(from, 'companies/widget-co', '', 'invested_in', 'manual');
}

for (const op of ['search', 'query'] as const) {
  parityTest(`a remote relational ${op} answers with the investors the caller may read and no page it may not`, {
    methods: ['putPage', 'sealChunks', 'addLink', 'readPageSynopses', 'readAdmittedPageRefs'],
    timeout: 240_000,
  }, async (engine: BrainEngine) => {
    await seedInvestors(engine);
    const w = watched(engine);
    const reply = await remoteCall(w.engine, op, { query: 'who invested in widget-co' });
    const pages = reply.rows.filter(r => typeof r.slug === 'string');
    const view = { error: reply.error, slugs: pages.map(r => String(r.slug)).sort(), leaked: leaked(reply.text), refused: w.refused() };
    expect(view).toEqual({ error: false, slugs: ['companies/widget-co', 'people/alice-investor'], leaked: [], refused: [] });
    return view;
  });
}

parityTest('a remote search that names an organization under another directory resolves the one live page there', {
  methods: ['putPage', 'sealChunks', 'addLink', 'readLiveSlugs'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedInvestors(engine);
  await engine.putPage('orgs/acme-example', { type: 'company' as never, title: 'Acme Example', compiled_truth: 'Acme Example makes anvils.', timeline: '', frontmatter: {} });
  await engine.sealChunks('orgs/acme-example', [chunk(0, 'Acme Example makes anvils.')]);
  await engine.addLink('people/alice-investor', 'orgs/acme-example', '', 'invested_in', 'manual');
  await engine.putPage('orgs/hush-example', { type: 'company' as never, title: 'Hush Example', compiled_truth: `Hush Example is private. ${PRIVATE_MARK}`, timeline: '', frontmatter: { visibility: 'private' } });
  await engine.sealChunks('orgs/hush-example', [chunk(0, `Hush Example is private. ${PRIVATE_MARK}`)]);
  await engine.addLink('people/alice-investor', 'orgs/hush-example', '', 'invested_in', 'manual');
  const w = watched(engine);
  const ask = async (query: string) => {
    const reply = await remoteCall(w.engine, 'search', { query });
    return { error: reply.error, slugs: reply.rows.filter(r => typeof r.slug === 'string').map(r => String(r.slug)).sort(), leaked: leaked(reply.text) };
  };
  const view = { open: await ask('who invested in companies/acme-example'), hidden: await ask('who invested in companies/hush-example'), refused: w.refused() };
  expect(view).toEqual({
    open: { error: false, slugs: ['orgs/acme-example', 'people/alice-investor'], leaked: [] },
    hidden: { error: false, slugs: ['orgs/acme-example'], leaked: [] },
    refused: [],
  });
  expect(view.hidden.slugs).not.toContain('orgs/hush-example');
  return view;
});

parityTest('a remote exact search finds the phrase on the pages the caller may read and in no other', {
  methods: ['putPage', 'sealChunks', 'readExactSnippetChunks'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedNova(engine);
  const w = watched(engine);
  const reply = await remoteCall(w.engine, 'search_exact', { phrase: 'widgets' });
  const view = { error: reply.error, slugs: (reply.body.matches ?? []).map((m: { slug: string }) => m.slug).sort(), leaked: leaked(reply.text), refused: w.refused() };
  expect(view).toEqual({ error: false, slugs: ['notes/nova-open', 'people/nova-example'], leaked: [], refused: [] });
  expect(w.calls.has('readExactSnippetChunks')).toBe(true);
  return view;
});

parityTest('a remote search marks a hit whose newer file is held and shows no hold of a page the caller may not read', {
  methods: ['putPage', 'sealChunks', 'readSourceMembership', 'writeOpCheckpointRecord', 'readHeldCoverageRows', 'readHeldHitRows'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedNova(engine);
  const { incarnation } = (await engine.readSourceMembership('default'))!;
  await engine.writeOpCheckpointRecord(GIT_HOLD_SUMMARY_OP, `default:${incarnation}`, [{ count: 2, stale: 2 }]);
  for (const [slug, path] of [['notes/nova-open', 'open.md'], ['notes/nova-private', 'private.md']] as const) {
    const page = (await engine.getPage(slug))!;
    await engine.writeOpCheckpointRecord(GIT_HOLD_OP, `default:${incarnation}:${path}`,
      [{ version: 1, source_id: 'default', incarnation, path, page_id: Number(page.id), held_at: '2026-06-01T00:00:00Z', code: 'invalid_frontmatter' }]);
  }
  const w = watched(engine);
  const reply = await remoteCall(w.engine, 'search', { query: 'Lisbon widgets' });
  const view = {
    error: reply.error,
    stale: Object.fromEntries(reply.rows.filter(r => typeof r.slug === 'string').map(r => [String(r.slug), r.stale?.held_since ?? null]).sort()),
    notice: reply.text.includes('notice held_files'),
    leaked: leaked(reply.text),
    refused: w.refused(),
  };
  expect(view).toEqual({ error: false, stale: { 'notes/nova-open': '2026-06-01T00:00:00Z', 'people/nova-example': null }, notice: true, leaked: [], refused: [] });
  return view;
});

parityTest('a remote recall with a query embedding reads the facts embedding column and shows no fact the caller may not read', {
  methods: ['putPage', 'sealChunks', 'insertFacts', 'readFactsEmbeddingColumn'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedNova(engine);
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async (opts: { values: string[] }) => ({ embeddings: opts.values.map(() => Array.from({ length: 1536 }, () => 0.01)) })) as never);
  try {
    const w = watched(engine);
    const reply = await remoteCall(w.engine, 'recall', { question: 'Nova leads the widgets team and moved to Lisbon' });
    const view = { error: reply.error, facts: ['Nova leads the widgets team', 'Nova moved to Lisbon'].filter(f => reply.text.includes(f)), leaked: leaked(reply.text), refused: w.refused() };
    expect(view).toEqual({ error: false, facts: ['Nova leads the widgets team', 'Nova moved to Lisbon'], leaked: [], refused: [] });
    expect(w.calls.has('readFactsEmbeddingColumn')).toBe(true);
    return view;
  } finally {
    __setEmbedTransportForTests(null);
    resetGateway();
  }
});
