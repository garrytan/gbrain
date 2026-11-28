/**
 * BrainEngine parity — the member reads a remote context pack, write attribution, recall and
 * household mark make (lane L3 S4): inbound edges, the fact cache watermark, a page's reference
 * date, revision attribution, entity identity ids and the hidden-from-caller check.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a remote caller gets the same answer from every engine arm and from the served arm (the brain owner
 *    answers each member over the owner socket), and that answer never carries a page, fact or mark the caller may not read.
 *  - Regression: the served arm refuses any member that is not in OWNER_IPC_REMOTE_TYPED_READS. The hidden-from-caller check changes a page_not_found into a
 *    capability refusal, so each case asserts `refused: []`, the answer and the member list.
 *  - Why existing coverage misses it: the members run inside remote ops, so no engine case names them with a remote caller.
 *  - Seam: dispatchToolCall with a remote caller; recordingEngine reports the members called and the typed refusals.
 */
import { expect } from 'bun:test';
import { createSource, parityArms, recordingEngine } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { chunk } from './chunk-fixtures.ts';
import { linkEntityIdentity } from '../../src/core/entity-identity.ts';
import { PRIVATE_FACT_MARK, PRIVATE_MARK, STDIO, leaked, remoteCall, seedNova } from './served-remote-read-fixtures.ts';

const { parityTest } = parityArms(testBackends());

/** `engine` behind the recording proxy: the members called and the typed refusals. */
function watched(engine: BrainEngine) {
  const calls = new Set<string>();
  const refusals: unknown[] = [];
  return { engine: recordingEngine(engine, calls, refusals), calls, refused: () => refusals.map(e => String((e as { message?: unknown }).message ?? e).slice(0, 120)) };
}

parityTest('a remote context pack lists the newer mentions of an entity the caller may read and none it may not', {
  methods: ['putPage', 'sealChunks', 'insertFacts', 'addLink', 'setConfig', 'readEntityInboundEdges', 'readFactCacheWatermark', 'readPageReferenceDate'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedNova(engine);
  await engine.setConfig('mentions.newer_on_cards', 'true');
  const w = watched(engine);
  const reply = await remoteCall(w.engine, 'context_pack', { entities: 'Nova Example' });
  const card = (reply.body.cards as Array<Record<string, any>> | undefined)?.[0];
  const view = {
    error: reply.error,
    card: card?.slug ?? null,
    edges: (card?.edges as Array<{ slug: string }> | undefined)?.map(e => e.slug).sort() ?? [],
    backlinks: card?.backlink_count ?? null,
    newer: (card?.newer_mentions?.rows as Array<{ slug: string }> | undefined)?.map(r => r.slug) ?? [],
    leaked: leaked(reply.text), refused: w.refused(),
  };
  expect(view).toEqual({ error: false, card: 'people/nova-example', edges: ['notes/nova-open'], backlinks: 1, newer: ['notes/nova-open'], leaked: [], refused: [] });
  for (const member of ['readEntityInboundEdges', 'readFactCacheWatermark', 'readPageReferenceDate']) expect(w.calls.has(member), member).toBe(true);
  return view;
});

parityTest('a remote write attribution answers for a page the caller may read and finds no private page', {
  methods: ['putPage', 'sealChunks', 'readPageRevisionAttribution'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedNova(engine);
  const w = watched(engine);
  const open = await remoteCall(w.engine, 'get_write_attribution', { slug: 'notes/nova-open' });
  const hidden = await remoteCall(w.engine, 'get_write_attribution', { slug: 'notes/nova-private' });
  const view = {
    openError: open.error, openTarget: open.body.target?.slug ?? null, openRevision: typeof open.body.live_revision?.knowledge_revision === 'string',
    hiddenError: hidden.error, hiddenCode: String(hidden.text).includes('page_not_found'),
    leaked: leaked(open.text + hidden.text), refused: w.refused(),
  };
  expect(view).toEqual({ openError: false, openTarget: 'notes/nova-open', openRevision: true, hiddenError: true, hiddenCode: true, leaked: [], refused: [] });
  expect(w.calls.has('readPageRevisionAttribution')).toBe(true);
  return view;
});

/** Two sources that each hold a page and facts for the slug `people/sam-example` (two people), and one person (`people/theo-example`) an identity group links across both. */
async function seedNamesakes(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'team');
  for (const source of ['default', 'team']) {
    for (const [slug, title] of [['people/sam-example', 'Sam Example'], ['people/theo-example', 'Theo Example']] as const) {
      await engine.putPage(slug, { type: 'person', title, compiled_truth: `${title} of ${source}.`, timeline: '' }, { sourceId: source });
    }
    await engine.insertFacts([
      { fact: `fact about the ${source} Sam`, kind: 'fact', visibility: 'world', source: 'fence', entity_slug: 'people/sam-example' },
      { fact: `theo fact from ${source}`, kind: 'fact', visibility: 'world', source: 'fence', entity_slug: 'people/theo-example' },
    ] as never, { source_id: source });
  }
  await engine.insertFacts([{ fact: `Sam private fact ${PRIVATE_FACT_MARK}`, kind: 'fact', visibility: 'private', source: 'fence', entity_slug: 'people/sam-example' }] as never, { source_id: 'team' });
  for (const sourceId of ['default', 'team']) await linkEntityIdentity(engine, { entityId: 'theo', slug: 'people/theo-example', sourceId });
}

const FEDERATED = { ...STDIO, transport: 'http', auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default', 'team'] } } as const;

parityTest('a remote recall of an entity two sources both hold names the namesakes, and merges the ones an identity group links', {
  methods: ['putPage', 'insertFacts', 'linkEntityIdentityRow', 'readEntityIdentityIdsForPages'],
  timeout: 240_000,
}, async (engine: BrainEngine, backend) => {
  await seedNamesakes(engine, backend);
  const w = watched(engine);
  const sam = await remoteCall(w.engine, 'recall', { entity: 'Sam Example' }, FEDERATED);
  const theo = await remoteCall(w.engine, 'recall', { entity: 'Theo Example' }, FEDERATED);
  const view = {
    samError: sam.error, samFacts: (sam.body.facts as unknown[] ?? []).length,
    candidates: (sam.body.ambiguous_entity?.candidates as Array<{ source_id: string; entity_slug: string }> | undefined)?.map(c => `${c.source_id}:${c.entity_slug}`) ?? [],
    theoError: theo.error, theoAmbiguous: theo.body.ambiguous_entity !== undefined,
    theoFacts: (theo.body.facts as Array<{ fact: string; source_id: string }> ?? []).map(f => `${f.source_id}:${/theo fact from (\w+)/.exec(f.fact)?.[1] ?? '?'}`).sort(),
    leaked: leaked(sam.text + theo.text), refused: w.refused(),
  };
  expect(view).toEqual({
    samError: false, samFacts: 0, candidates: ['default:people/sam-example', 'team:people/sam-example'],
    theoError: false, theoAmbiguous: false, theoFacts: ['default:default', 'team:team'], leaked: [], refused: [],
  });
  expect(w.calls.has('readEntityIdentityIdsForPages')).toBe(true);
  return view;
});

parityTest('a remote household mark on a page the caller cannot read answers as a missing record, and on an open page as a record that is not a household record', {
  methods: ['putPage', 'sealChunks', 'readPageSnapshot', 'readPageHiddenFromCaller'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedNova(engine);
  const w = watched(engine);
  const code = (text: string) => /"code":\s*"(\w+)"/.exec(text)?.[1] ?? null;
  const hidden = await remoteCall(w.engine, 'household_mark', { slug: 'notes/nova-private', event: 'done' });
  const readers = await remoteCall(w.engine, 'household_mark', { slug: 'notes/nova-readers', event: 'done' });
  const open = await remoteCall(w.engine, 'household_mark', { slug: 'notes/nova-open', event: 'done' });
  const view = {
    hidden: code(hidden.text), readers: code(readers.text), open: code(open.text),
    leaked: leaked(hidden.text + readers.text + open.text), refused: w.refused(),
  };
  expect(view).toEqual({ hidden: 'page_not_found', readers: 'page_not_found', open: 'invalid_params', leaked: [], refused: [] });
  expect(w.calls.has('readPageHiddenFromCaller')).toBe(true);
  return view;
});
